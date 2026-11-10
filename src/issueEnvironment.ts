/**
 * 环境凭据保险箱:需求/问题两个会话域共享的加密存储。
 *
 * 只做一件事:把 SSH 凭据放进宿主专用加密文件,公开的任务状态/API/
 * 事件只看引用。消费方是问题流 v2(src/issueFlow/,playbook 的
 * fetch-logs/build-deploy 二进制由宿主工具以环境变量喂密码);该域还会
 * 按 ADR-0003 明确解密到当前问题的 AI 上下文。旧 DTS triage 流的
 * 适配器接口已随该流程一并下线。
 */

import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";

/** root = 独立 root 密码组(ADR-0020/#150:台账快照在条目显式设置 root
 * 密码时一并入会话;单账号 legacy 形状,与 page 组同构;继承后台密码的
 * 会话不落这一组,行为与手填时代完全一致)。 */
export type IssueEnvironmentPurpose = "logs" | "deploy" | "both" | "page"
  | "root";

export interface IssueEnvironmentAccountInput {
  username: string;
  password: string;
}

export interface IssueEnvironmentInput {
  name: string;
  purpose: IssueEnvironmentPurpose;
  host: string;
  port?: number;
  /** 一个环境共享主机信息，但可能需要用不同系统账号完成查日志、换库
   * 和管理动作。新客户端统一提交 accounts。下面两个字段只用于接住
   * 94410d9 版本已经发出的单账号请求。 */
  accounts?: IssueEnvironmentAccountInput[];
  username?: string;
  password?: string;
}

export interface IssueEnvironmentAccountRef {
  username: string;
  credential_state: "stored";
}

/** 可安全进入 task.json/API/模型提示的环境信息。 */
export interface IssueEnvironmentRef {
  id: string;
  name: string;
  purpose: IssueEnvironmentPurpose;
  protocol: "ssh";
  host: string;
  port: number;
  accounts: IssueEnvironmentAccountRef[];
  /** 兼容读取 94410d9 写下的旧 task.json。 */
  username?: string;
  credential_state?: "stored";
}

export interface IssueEnvironmentCredential {
  username: string;
  password: string;
}

interface StoredIssueEnvironment extends Omit<IssueEnvironmentRef, "accounts"> {
  accounts: IssueEnvironmentCredential[];
}

interface Envelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

const MAX_ENVIRONMENTS = 3;
const MAX_ACCOUNTS_PER_ENVIRONMENT = 8;
const STANDARD_ENVIRONMENT_USERS = ["operator", "serviceaccount", "administrator"] as const;
const KEY_BYTES = 32;

function requiredText(
  value: unknown,
  label: string,
  max: number,
): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  if (/\0|[\r\n]/.test(text)) throw new Error(`${label}不能含控制字符`);
  return text;
}

function normalize(
  inputs: IssueEnvironmentInput[],
): StoredIssueEnvironment[] {
  if (inputs.length > MAX_ENVIRONMENTS) {
    throw new Error("每个问题单最多配置后台、页面与 root 三组环境凭据");
  }
  const rows: StoredIssueEnvironment[] = inputs.map((input, index) => {
    const purpose = input.purpose;
    // page = 网管页面凭据组,legacy 只读:2026-09-10 页面凭据整体
    // 废弃(登记页已摘,新路径不再写入),联合类型保留只为旧会话
    // vault 载入兼容。它没有 SSH 消费方。
    if (!(["logs", "deploy", "both", "page", "root"] as const).includes(purpose)) {
      throw new Error(`第 ${index + 1} 组环境用途不合法`);
    }
    // "both"(单一共用环境)只有问题流 v2 会提交:playbook 的
    // fetch-logs/build-deploy 本来就共用同一套地址与密码。旧 DTS
    // 双入口已下线,这条限制随之放开;单环境一密码是更朴素的事实。
    const port = input.port === undefined || input.port === null
      ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`第 ${index + 1} 组环境端口必须是 1-65535`);
    }
    const host = requiredText(input.host, `第 ${index + 1} 组环境地址`, 255);
    if (/\s/.test(host) || host.startsWith("-")) {
      throw new Error(`第 ${index + 1} 组环境地址格式不合法`);
    }
    const legacyAccount = input.username !== undefined
        || input.password !== undefined
      ? [{ username: input.username ?? "", password: input.password ?? "" }]
      : [];
    const accountInputs = input.accounts?.length
      ? input.accounts : legacyAccount;
    if (!accountInputs.length) {
      throw new Error(`第 ${index + 1} 组环境至少需要一个登录账号`);
    }
    if (accountInputs.length > MAX_ACCOUNTS_PER_ENVIRONMENT) {
      throw new Error(
        `第 ${index + 1} 组环境最多配置 ${MAX_ACCOUNTS_PER_ENVIRONMENT} 个账号`);
    }
    const accounts = accountInputs.map((account, accountIndex) => ({
      username: requiredText(account.username,
        `第 ${index + 1} 组环境第 ${accountIndex + 1} 个用户名`, 128),
      password: requiredText(account.password,
        `第 ${index + 1} 组环境第 ${accountIndex + 1} 个密码`, 4096),
    }));
    if (new Set(accounts.map((account) => account.username)).size
        !== accounts.length) {
      throw new Error(`第 ${index + 1} 组环境的用户名不能重复`);
    }
    if (input.accounts?.length) {
      const usernames = [...accounts.map((account) => account.username)].sort();
      const expected = [...STANDARD_ENVIRONMENT_USERS].sort();
      if (JSON.stringify(usernames) !== JSON.stringify(expected)) {
        throw new Error(
          `第 ${index + 1} 组环境必须配置 operator、serviceaccount、administrator 三个账号`);
      }
    }
    return {
      id: randomUUID(),
      name: requiredText(input.name, `第 ${index + 1} 组环境名称`, 80),
      purpose,
      protocol: "ssh",
      host,
      port,
      accounts,
    };
  });
  if (new Set(rows.map((row) => row.purpose)).size !== rows.length) {
    throw new Error("日志环境和换库环境都只能各配置一个");
  }
  return rows;
}

function publicRef(item: StoredIssueEnvironment): IssueEnvironmentRef {
  return {
    id: item.id,
    name: item.name,
    purpose: item.purpose,
    protocol: "ssh",
    host: item.host,
    port: item.port,
    accounts: item.accounts.map((account) => ({
      username: account.username,
      credential_state: "stored",
    })),
  };
}

/**
 * 这不是外部密钥管理系统的替代品；它解决的是更现实的第一道边界：
 * 密码不能明文混进 task.json、事件或公开 API。问题流会按 ADR-0003
 * 在消费时把网管口令解密到当前问题的 AI 上下文；那是显式消费契约，
 * 不改变这里“落盘只存密文、列表/状态/事件只给引用”的边界。key 与
 * 密文均为宿主 0600，未来接 Vault/KMS 时只需替换本类。
 */
export class IssueEnvironmentVault {
  private readonly root: string;
  private readonly keyPath: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, ".issue-environments");
    this.keyPath = join(this.root, "key.bin");
  }

  store(
    taskId: string,
    inputs: IssueEnvironmentInput[],
  ): IssueEnvironmentRef[] {
    this.validTaskId(taskId);
    const rows = normalize(inputs);
    if (!rows.length) {
      this.remove(taskId);
      return [];
    }
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(rows), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    this.atomicWrite(this.taskPath(taskId), JSON.stringify(envelope));
    return rows.map(publicRef);
  }

  credential(
    taskId: string,
    environmentId: string,
    username?: string,
  ): IssueEnvironmentCredential | undefined {
    const row = this.read(taskId).find((item) => item.id === environmentId);
    const account = username
      ? row?.accounts.find((item) => item.username === username)
      : row?.accounts[0];
    return account ? { ...account } : undefined;
  }

  credentials(
    taskId: string,
    environmentId: string,
  ): IssueEnvironmentCredential[] {
    const row = this.read(taskId).find((item) => item.id === environmentId);
    return row?.accounts.map((account) => ({ ...account })) ?? [];
  }

  remove(taskId: string): void {
    this.validTaskId(taskId);
    rmSync(this.taskPath(taskId), { force: true });
  }

  /** 在册任务/会话 id 清单(问题流重启的孤儿凭据对账用):root 下全部
   *  <id>.json 去掉扩展名;key.bin 不是 .json,atomicWrite 崩溃残留的
   *  *.tmp 也天然不在列。root 读不动(尚未创建等)按空清单。 */
  ids(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  }

  private read(taskId: string): StoredIssueEnvironment[] {
    this.validTaskId(taskId);
    const path = this.taskPath(taskId);
    if (!existsSync(path)) return [];
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("问题单环境凭据文件不能是符号链接");
    }
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Envelope;
    if (envelope.version !== 1) throw new Error("不支持的问题单环境凭据版本");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Array<StoredIssueEnvironment & {
      username?: string;
      password?: string;
    }>;
    // 94410d9 只允许每个环境一个 username/password。读取时原地提升为
    // accounts，不要求运维迁移保险箱，也不把旧任务卡死。
    return parsed.map((item) => ({
      ...item,
      accounts: Array.isArray(item.accounts) && item.accounts.length
        ? item.accounts
        : item.username && item.password
          ? [{ username: item.username, password: item.password }]
          : [],
    }));
  }

  private key(): Buffer {
    this.ensureRoot();
    if (!existsSync(this.keyPath)) {
      let descriptor: number | undefined;
      try {
        // 密钥不能走“临时文件 + rename 覆盖”：同一 dataDir 若意外有
        // 两个进程同时首启，后 rename 的进程会把先写入的 key 换掉，
        // 已经用旧 key 加密的任务凭据从此不可恢复。O_EXCL 让第一位
        // 创建者胜出，其余进程只读取既有 key。
        descriptor = openSync(
          this.keyPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
            | constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(descriptor, randomBytes(KEY_BYTES));
        closeSync(descriptor);
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (lstatSync(this.keyPath).isSymbolicLink()) {
      throw new Error("问题单环境密钥文件不能是符号链接");
    }
    chmodSync(this.keyPath, 0o600);
    const key = readFileSync(this.keyPath);
    if (key.length !== KEY_BYTES) throw new Error("问题单环境密钥长度不正确");
    return key;
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) {
      throw new Error("问题单环境凭据目录不能是符号链接");
    }
    chmodSync(this.root, 0o700);
  }

  private atomicWrite(path: string, content: string | Buffer): void {
    this.ensureRoot();
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, content);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private taskPath(taskId: string): string {
    return join(this.root, `${taskId}.json`);
  }

  private validTaskId(taskId: string): void {
    // 问题流 v2 的会话(issue-N)与需求任务(task-N)共用这个保险箱
    // 的存储区:文件名前缀互不碰撞,加密与清理纪律完全一致。
    if (!/^(?:task|issue)-\d+$/.test(taskId)) throw new Error("任务编号格式不合法");
  }
}
