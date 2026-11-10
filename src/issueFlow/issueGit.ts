import { excludeCodecheckArtifacts, CODECHECK_PATHSPECS, assertNoCodecheckCommits } from "../codecheckArtifacts.ts";
import { applyGitCommitIdentity } from "../gitCommitIdentity.ts";
/**
 * 问题流的 Git 边界:克隆加固 + 宿主唯一一次传输。
 *
 * 机制与 TaskService 的同名能力同源(凭据沙箱、safeGit 只读视图、
 * 临时 bare 传输仓、ls-remote 复核),但按问题域的需要重写为独立
 * 模块——问题流与需求流是两条交付通道,互不 import;将来若要合并,
 * 以这里的契约为准抽公共层。安全语义不减配:
 * - Agent 侧 pushurl 一律指向 /dev/null(容器/宿主都推不动);
 * - 凭据只在一次 clone/push 的受控窗口进入 0700 临时目录;
 * - 宿主 push 从临时 bare 仓发起,不读工作区 .git/config。
 */

import { execFile } from "node:child_process";
import { GIT_TRANSFER_TIMEOUT_MS } from "../gitTransferBudget.ts";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createSafeGitView } from "../safeGit.ts";
import { publishGitAiNotes } from "../gitAiNotes.ts";
import type { IssueBaselineSyncRecord } from "./state.ts";

export interface GitCredential {
  username: string;
  password: string;
  email?: string;
}

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunOutcome> {
  return new Promise((resolveRun) => {
    execFile("git", args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf-8",
      timeout: options.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolveRun({
        code: error ? (typeof code === "number" ? code : -1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

/** 可执行 helper 不放系统 /tmp(生产宿主常挂 noexec);问题流自己的
 * 运行目录在数据目录 .runtime/issue-git 下,0700。 */
function runtimeDir(dataDir: string): string {
  const root = join(resolve(dataDir), ".runtime", "issue-git");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return mkdtempSync(join(root, "operation-"));
}

export interface GitSandbox {
  dir: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** 一次 Git 动作一个私有 HOME/配置边界。同 TaskService 版语义。
 *
 * repoDir:仓库目录,按仓放行 safe.directory。问题流工作区宿主 root /
 * 容器 1001 混属主是常态,git 2.35+ 对属主非当前用户的仓库一律拒操作
 * (dubious ownership);沙箱又刻意隔断一切配置来源,系统/全局配置救
 * 不了,只能逐仓放行精确路径——与 safeGit/containerRuntime 的精确
 * 白名单同口径,绝不能用 *(见 container 运行时的复盘注释)。 */
export function prepareSandbox(
  dataDir: string,
  credential: GitCredential | undefined,
  repoDir?: string,
): GitSandbox {
  const dir = runtimeDir(dataDir);
  let helper: string | undefined;
  if (credential) {
    const file = join(dir, "credential");
    writeFileSync(file,
      `username=${credential.username}\npassword=${credential.password}\n`,
      { mode: 0o600 });
    helper = join(dir, "helper.sh");
    writeFileSync(helper, [
      "#!/bin/sh",
      'if [ "$1" = "get" ]; then',
      '  cat "$(dirname "$0")/credential"',
      "fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(helper, 0o700);
  }
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(xdg, { mode: 0o700 });
  const globalConfig = join(dir, "global.gitconfig");
  const systemConfig = join(dir, "system.gitconfig");
  writeFileSync(globalConfig, "", { mode: 0o600 });
  writeFileSync(systemConfig, "", { mode: 0o600 });
  const askpass = join(dir, "reject-askpass.sh");
  writeFileSync(askpass, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  chmodSync(askpass, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:CONFIG(?:_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS))?|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|EXEC_PATH|TEMPLATE_DIR|SSH|SSH_COMMAND|PROXY_COMMAND)$/.test(key)
        || /^GIT_CONFIG$/i.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "Never",
  });
  const args = [
    ...(repoDir ? ["-c", `safe.directory=${resolve(repoDir)}`] : []),
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.ext.allow=never",
    "-c", "credential.helper=",
    ...(helper ? ["-c", `credential.helper=${helper}`] : []),
  ];
  return {
    dir, args, env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function validateRepoUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("代码仓地址为空");
  if (/^(?:https?|file):\/\//i.test(value)) return value;
  const windowsDrive = /^[a-z]:[\\/]/i.test(value);
  if (windowsDrive || !/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return resolve(value); // 本地路径(测试/演示裸仓)
  }
  throw new Error("问题流只接受 HTTPS 或本地代码仓地址(不支持 ssh/git 协议)");
}

/** 认证类失败的机器标记(协议,不是文案):错误文本以此打头,前端
 * 「去个人设置配令牌」的跳转按钮认这个标记(web 侧镜像常量),人话
 * 怎么改都不破坏跳转。旧锚是文案里嵌「Git 令牌」字样——改字=跳转
 * 静默消失,正是本票要拆的文本匹配债务。 */
export const GIT_AUTH_ERROR_TAG = "[git-auth]";

/** 认证类失败 → "去哪配令牌"的引导;非认证失败返回 undefined 由调用方
 * 保留 git 原文,不吞事实。返回文本以 GIT_AUTH_ERROR_TAG 打头(前端
 * 跳转锚),人话部分随意改。
 *
 * 问题流 failed 是终态(不能续聊),引导说"重新发起"而不是"发消息重试"。 */
function authFailureHint(
  verb: string,
  credential: GitCredential | undefined,
  stderr: string,
): string | undefined {
  const fatal = stderr.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("fatal:")) ?? "";
  const tail = fatal ? `(${fatal})` : "";
  if (!credential
      && /could not read Username|terminal prompts disabled|read askpass/i.test(stderr)) {
    return `${GIT_AUTH_ERROR_TAG}${verb}需要 Git 凭据,当前账号还没有配置 Git 令牌:`
      + "请到「个人设置 → Git 令牌」填写代码平台的 HTTPS 密码或访问令牌"
      + "(Git 用户名 = 登录账号名),保存后重新发起问题分析。" + tail;
  }
  if (/Authentication failed|HTTP 403|status[ :=]403/i.test(stderr)) {
    return `${GIT_AUTH_ERROR_TAG}代码仓拒绝了 Git 凭据:请到「个人设置 → Git 令牌」核对令牌内容`
      + `(当前按登录账号「${credential?.username ?? "(未配置)"}」认证,Git 用户名 = 登录账号名),`
      + "保存后重新发起问题分析。" + tail;
  }
  return undefined;
}

/** 克隆失败 → 人话:认证类给引导,其余保留 git 原文。 */
export function cloneFailureMessage(
  credential: GitCredential | undefined,
  stderr: string,
): string {
  return authFailureHint("克隆代码仓", credential, stderr)
    ?? `克隆代码仓失败: ${stderr.trim().slice(0, 500)}`;
}

/** 克隆到 targetDir,并加固:origin URL 去 userinfo、pushurl 指向
 * /dev/null(Agent 可读可提交,但推不动;宿主推送走显式 URL)。 */
export async function cloneRepository(options: {
  dataDir: string;
  targetDir: string;
  repoUrl: string;
  baseline?: string;
  shallow?: boolean;
  credential?: GitCredential;
}): Promise<void> {
  const url = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential,
    options.targetDir);
  try {
    const outcome = await runGit([
      // --no-local:本地路径仓默认 hardlink 共享 .git/objects,问题仓
      // 会与源仓共 inode(同 taskService 正式 clone 的教训)。
      ...sandbox.args, "clone", "--quiet", "--no-local",
      ...(options.shallow ? ["--depth", "1"] : []),
      ...(options.baseline ? ["--branch", options.baseline] : []),
      "--", url, options.targetDir,
    ], { env: sandbox.env, timeoutMs: GIT_TRANSFER_TIMEOUT_MS });
    if (outcome.code !== 0) {
      throw new Error(cloneFailureMessage(options.credential, outcome.stderr));
    }
    await hardenCloneAsync(options.targetDir);
    await applyGitCommitIdentity(options.targetDir, options.credential);
  } finally {
    sandbox.cleanup();
  }
}

export async function hardenCloneAsync(repoDir: string): Promise<void> {
  excludeCodecheckArtifacts(repoDir);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const configArgs = (...args: string[]) =>
    ["config", "--file", join(repoDir, ".git", "config"), ...args];
  await runGit(configArgs("--unset-all", "credential.helper"),
    { env, timeoutMs: 10_000 }).catch(() => undefined);
  const origin = await runGit(configArgs("--get", "remote.origin.url"),
    { env, timeoutMs: 10_000 });
  if (origin.code === 0) {
    const raw = origin.stdout.trim();
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      const cleaned = parsed.toString();
      if (cleaned !== raw) {
        await runGit(configArgs("--replace-all", "remote.origin.url", cleaned),
          { env, timeoutMs: 10_000 });
      }
    } catch { /* 本地路径没有 userinfo 可清 */ }
  }
  await runGit(configArgs("--replace-all", "remote.origin.pushurl",
    "/dev/null/mae-flow-host-owned"), { env, timeoutMs: 10_000 });
}

export async function currentBranch(repoDir: string): Promise<string> {
  const view = createSafeGitView(repoDir);
  try {
    const outcome = await runGit(["--no-pager", "branch", "--show-current"], {
      cwd: repoDir,
      env: view.environment(),
      timeoutMs: 10_000,
    });
    return outcome.code === 0 ? outcome.stdout.trim() : "";
  } finally {
    view.cleanup();
  }
}

/** 当前 HEAD 短 SHA(拉仓事实回报用;失败回空串由调用方如实呈现)。 */export async function currentHead(repoDir: string): Promise<string> {
  const view = createSafeGitView(repoDir);
  try {
    const outcome = await runGit(
      ["--no-pager", "rev-parse", "--short=12", "HEAD"],
      { cwd: repoDir, env: view.environment(), timeoutMs: 10_000 });
    return outcome.code === 0 ? outcome.stdout.trim() : "";
  } finally {
    view.cleanup();
  }
}

/** 工作区未提交改动(含未跟踪文件),porcelain 逐行;干净返回空数组。
 * push 前的熔断依据:push 只推已提交历史,脏工作区推出去=旧 HEAD,
 * MR 没有 diff(2026-08-28 真实环境事故:AI 改了文件没 commit,
 * push_branch 推了 clone 时的原始提交)。status 本身失败按"没有证据"
 * 处理放行——属主修复后这是罕见路径,不值得为它堵死推送。 */
export async function dirtyWorktree(repoDir: string): Promise<string[]> {
  const view = createSafeGitView(repoDir);
  try {
    const outcome = await runGit(["status", "--porcelain", "--", ".", ...CODECHECK_PATHSPECS], {
      cwd: repoDir,
      env: view.environment(),
      timeoutMs: 10_000,
    });
    if (outcome.code !== 0) return [];
    return outcome.stdout.split("\n").map((line) => line.trim())
      .filter(Boolean);
  } finally {
    view.cleanup();
  }
}

/** 宿主侧确定性建分支(固定流程阶段2/转正时用)。分支名由调用方拼好
 * (ADR-0063:基线_工号_单号_时间戳,会话级常量);这里只负责"分支已
 * 在且已检出"这个
 * 终态:已检出=幂等通过;分支存在未检出=切过去;不存在=从起点建。
 * 绝不 reset 已有分支——已有提交意味着有轮次在现场,覆盖是事故。
 * 隐式续跑陷阱(2026-08-28 事故,遗留警报随其退役,ADR-0063):本地
 * 分支不存在而 origin/<branch> 存在(老命名时代的同单重跑)时,
 * `git checkout <branch>` 会 DWIM
 * 成"从远端分支顶上建本地分支"——静默续跑被停掉的半成品。所以
 * 建分支必须先验本地引用,不存在就走显式 -b(起点明确,无 DWIM)。 */
export async function ensureBranch(options: {
  dataDir: string;
  repoDir: string;
  branch: string;
  /** 建分支起点;缺省当前 HEAD。 */
  startPoint?: string;
}): Promise<void> {
  if (!existsSync(join(options.repoDir, ".git"))) {
    throw new Error(`代码克隆不存在: ${options.repoDir}`);
  }
  const format = await runGit(
    ["check-ref-format", "--branch", options.branch],
    { env: process.env, timeoutMs: 10_000 });
  if (format.code !== 0) throw new Error(`分支名不合法: ${options.branch}`);
  const sandbox = prepareSandbox(options.dataDir, undefined, options.repoDir);
  try {
    const current = await runGit(
      [...sandbox.args, "branch", "--show-current"],
      { cwd: options.repoDir, env: sandbox.env, timeoutMs: 10_000 });
    if (current.code === 0 && current.stdout.trim() === options.branch) return;
    // 本地分支在不在(显式验引用,不能让 checkout 的 DWIM 替我们决定):
    // 在 → 只切换;不在 → 显式 -b 从起点建,绝不落在 origin/<branch> 上。
    const local = await runGit(
      [...sandbox.args, "show-ref", "--verify", "--quiet",
        `refs/heads/${options.branch}`],
      { cwd: options.repoDir, env: sandbox.env, timeoutMs: 10_000 });
    if (local.code === 0) {
      const checkout = await runGit([
        ...sandbox.args, "checkout", "--quiet", options.branch,
      ], { cwd: options.repoDir, env: sandbox.env, timeoutMs: 60_000 });
      if (checkout.code === 0) return;
      // 已存在但切换失败(如脏工作区冲突):原文带回去让人看。
      throw new Error(
        `切换分支失败(${options.branch}): ${checkout.stderr.trim().slice(0, 400)}`);
    }
    // 分支不存在:从起点(缺省 HEAD)建。已存在但切换失败(如脏工作
    // 区冲突)会走到这里再失败一次,原文带回去让人看。
    const create = await runGit([
      ...sandbox.args, "checkout", "--quiet", "-b", options.branch,
      ...(options.startPoint ? [options.startPoint] : []),
    ], { cwd: options.repoDir, env: sandbox.env, timeoutMs: 60_000 });
    if (create.code !== 0) {
      throw new Error(
        `建分支失败(${options.branch}): ${create.stderr.trim().slice(0, 400)}`);
    }
  } finally {
    sandbox.cleanup();
  }
}

export interface PushReceipt {
  branch: string;
  sha: string;
  url: string;
  /** 本次推送按强制覆盖执行(租赁式核对过远端旧 tip)。 */
  forced?: boolean;
}

/** force 收据门的机械拒绝(ADR-0074):force 覆盖前,远端 tip 必须是
 * 平台历史推送收据中的一笔;查不到远端状态同样拒绝(宁误拦不误放——
 * force 是唯一能盖掉用户手改的路径,没有远端拒收兜底)。错误只带
 * 事实,人话回执由工具层组装(ADR-0016);人工核对后由调用方以显式
 * 放行参数(forceOverrideExternal)重试,租赁核对在放行后保留。 */
export class ForceReceiptGateError extends Error {
  constructor(
    /** external=远端 tip 不在收据内;unreachable=远端状态查不到。 */
    readonly reason: "external" | "unreachable",
    /** 拒绝时探到的远端 tip(unreachable 时为空串)。 */
    readonly remoteTip: string,
    message: string,
  ) {
    super(message);
    this.name = "ForceReceiptGateError";
  }
}

/** 宿主唯一一次传输:从工作区经 safeGit 只读视图读对象,在临时 bare
 * 仓里 push 到显式远端,再 ls-remote 复核 SHA。分支名单由调用方
 * (单号门禁)先行校验,这里只管传输与复核的可靠性。
 *
 * force(同单重跑强制覆盖,2026-09-11 增补):不用裸 --force,而是先
 * ls-remote 探远端同名分支 tip,再 --force-with-lease=ref:tip 推——
 * 探测到推送之间远端又动了(他人/另一会话推送),租赁核对失败拒推,
 * 不会盲盖。远端还没有同名分支时无从覆盖,按普通推送走。
 * force 收据门(ADR-0074 票4):租赁防不了会话之外就已发生的手推——
 * 探到的 tip 本身可能就是用户改好的代码。所以同一探针再加一道机械
 * 校验:tip 必须在调用方传入的推送收据投影(ledgerPushes,同仓同分支)
 * 内,不在即抛 ForceReceiptGateError(人工核对后以 forceOverrideExternal
 * 显式放行,放行只跳过收据门,租赁核对保留,双保险不回退)。 */
export async function pushFromIssueWorkspace(options: {
  dataDir: string;
  repoDir: string;
  repoUrl: string;
  branch: string;
  credential?: GitCredential;
  force?: boolean;
  /** force 收据门的凭据(ADR-0074):本会话在本仓本分支的推送收据投影
   * (ledgerPushes,ADR-0064 去重)。force=true 时远端 tip 必须是其中
   * 一笔;缺席/为空 = 无收据,远端有同名分支即拒绝。 */
  forceReceiptShas?: string[];
  /** 显式放行(人工核对后):跳过收据门完成覆盖;租赁核对保留。 */
  forceOverrideExternal?: boolean;
  log?: (message: string) => void;
}): Promise<PushReceipt> {
  if (!existsSync(join(options.repoDir, ".git"))) {
    throw new Error(`代码克隆不存在: ${options.repoDir}`);
  }
  await assertNoCodecheckCommits(options.repoDir);
  const remoteUrl = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential,
    options.repoDir);
  let view: ReturnType<typeof createSafeGitView> | undefined;
  const ref = `refs/heads/${options.branch}`;
  try {
    const format = await runGit(
      [...sandbox.args, "check-ref-format", "--branch", options.branch],
      { env: sandbox.env, timeoutMs: 10_000 });
    if (format.code !== 0) throw new Error(`分支名不合法: ${options.branch}`);
    view = createSafeGitView(options.repoDir);
    const head = await runGit([...sandbox.args, "rev-parse", "--verify", "HEAD"], {
      cwd: options.repoDir,
      env: view.environment(sandbox.env),
      timeoutMs: 30_000,
    });
    const sha = head.stdout.trim();
    if (head.code !== 0 || !sha) {
      throw new Error(`读取待推送 HEAD 失败: ${head.stderr.trim().slice(0, 400)}`);
    }
    const staging = join(sandbox.dir, "transport.git");
    const initialized = await runGit(
      [...sandbox.args, "init", "--quiet", "--bare", staging],
      { env: sandbox.env, timeoutMs: 30_000 });
    if (initialized.code !== 0) {
      throw new Error(`创建传输仓失败: ${initialized.stderr.trim().slice(0, 400)}`);
    }
    const objectEnv = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: view.objectDirectory,
    };
    const objectCheck = await runGit([
      ...sandbox.args, `--git-dir=${staging}`, "cat-file", "-e", `${sha}^{commit}`,
    ], { env: { ...sandbox.env, ...objectEnv }, timeoutMs: 30_000 });
    if (objectCheck.code !== 0) throw new Error("待推送 HEAD 不是可读取的提交对象");
    const probeRemoteTip = async (): Promise<
      { state: "absent" } | { state: "tip"; tip: string }
      | { state: "unreachable"; detail: string }
    > => {
      const probed = await runGit([
        ...sandbox.args, `--git-dir=${staging}`,
        "ls-remote", "--heads", remoteUrl, ref,
      ], { env: sandbox.env, timeoutMs: 60_000 });
      if (probed.code !== 0) {
        return { state: "unreachable",
          detail: (probed.stderr || probed.stdout).trim()
            .split(/\r?\n/)[0] ?? "" };
      }
      const tip = probed.stdout.trim().split(/\s+/)[0] ?? "";
      return /^[0-9a-f]{40}$/i.test(tip)
        ? { state: "tip", tip }
        : { state: "absent" };
    };
    let forceLease: string[] = [];
    if (options.force === true) {
      const probed = await probeRemoteTip();
      if (probed.state === "tip") {
        // 租赁核对照旧锚定探到的 tip(防探测到推送之间远端又动)。
        forceLease = [`--force-with-lease=${ref}:${probed.tip}`];
        // 收据门(ADR-0074):tip 必须有平台推送收据背书——lease 防不了
        // 会话之外就已发生的手推。放行参数只跳过这道门,租赁保留。
        if (options.forceOverrideExternal !== true
            && !options.forceReceiptShas?.some((sha) =>
              probed.tip.startsWith(sha.toLowerCase()))) {
          throw new ForceReceiptGateError("external", probed.tip,
            `远端分支 ${options.branch} 当前提交 ${probed.tip.slice(0, 12)} `
              + "不在本会话推送收据内,拒绝强制覆盖");
        }
      } else if (probed.state === "unreachable"
          && options.forceOverrideExternal !== true) {
        // 查不到远端状态就无从核对收据,也没有租赁锚点;force 是唯一
        // 没有远端拒收兜底的路径,宁误拦不误放(同 #240 删除门禁口径)。
        throw new ForceReceiptGateError("unreachable", "",
          `远端状态查不到(${probed.detail.slice(0, 200)}),`
            + "无法核对强制覆盖的收据门");
      }
      // 远端还没有同名分支:无从覆盖,按普通推送走(不带租赁参数)。
    }
    const pushed = await runGit([
      ...sandbox.args, `--git-dir=${staging}`, "push", "--no-verify",
      "--porcelain", ...forceLease, remoteUrl, `${sha}:${ref}`,
    ], { env: { ...sandbox.env, ...objectEnv }, timeoutMs: GIT_TRANSFER_TIMEOUT_MS });
    if (pushed.code !== 0) {
      // porcelain 的拒收摘要(! [rejected] (non-fast-forward))走 stdout,
      // 人话 hint 走 stderr——检测要两路合看,展示仍 stderr 优先。
      const stderrText = pushed.stderr.trim();
      const stdoutText = pushed.stdout.trim();
      const raw = stderrText || stdoutText;
      // 非快进(ADR-0063 后的罕见异动:新命名让正常流程不再撞远端
      // 同名分支,force 是兜底能力):光透 git 原文等于让 AI 猜——
      // 点名原因与处置(覆盖前现查远端同名分支当前位置,对不上即拒推,
      // 不盲盖;强制尝试被拒则提示核对远端,不教盲目重试)。
      const rejected = /non-fast-forward|fetch first|stale info|already exists|\[rejected\]|behind its remote counterpart/i
        .test(`${stderrText}\n${stdoutText}`);
      const staleBranch = !rejected ? "" : options.force === true
        ? " 强制覆盖被拒:远端分支状态与推送时不一致,或受平台分支保护"
          + "限制——先与用户核对远端分支状态再决定,不要盲目重试。"
        : " 远端同名分支已存在且非快进(新命名下正常流程不会撞名,"
          + "这通常是平台侧罕见异动,远端可能有用户手改推回的外部提交)"
          + "——调 sync_branch 把远端最新提交并入工作区后再重推,"
          + "不要盲目重试。";
      throw new Error(authFailureHint("推送代码", options.credential, raw)
        ?? `宿主推送失败: ${raw.slice(0, 500)}${staleBranch}`);
    }
    const verified = await runGit([
      ...sandbox.args, `--git-dir=${staging}`,
      "ls-remote", "--heads", remoteUrl, ref,
    ], { env: sandbox.env, timeoutMs: 60_000 });
    const remoteSha = verified.stdout.trim().split(/\s+/)[0];
    if (verified.code !== 0 || remoteSha !== sha) {
      throw new Error(`远端 SHA 复核失败: 本地 ${sha.slice(0, 12)},`
        + `远端 ${remoteSha ? remoteSha.slice(0, 12) : "缺失"}`);
    }
    await publishGitAiNotes({ cwd: options.repoDir, sha, remote: remoteUrl, staging,
      args: sandbox.args, env: { ...sandbox.env, ...objectEnv }, log: options.log });
    return {
      branch: options.branch, sha, url: remoteUrl,
      ...(options.force === true ? { forced: true } : {}),
    };
  } finally {
    view?.cleanup();
    sandbox.cleanup();
  }
}

export type BaselineSyncOutcome =
  | { kind: "current" }
  | { kind: "synced"; record: IssueBaselineSyncRecord }
  | { kind: "conflict"; files: string[] }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

/** 推送前基线同步(ADR-0071):把基线分支的新提交并进当前修复分支。
 *
 * fetch/merge 与其他宿主 git 写同一套边界:refs/objects/index 看真实
 * 仓,config 来自空代理 gitdir,凭据只进一次性沙箱。merge 允许
 * fast-forward(分支尚无自有提交时只移分支头,不产生提交);不用
 * rebase——修复分支上的提交是合规账,不重写历史。合并提交身份与
 * 克隆同源(宿主凭据,缺 email 按本机占位)经 -c 进命令,代理 gitdir
 * 不读仓 config,克隆时写入的身份在这里看不见。
 *
 * 结果分五路由调用方分叉:current=基线无新提交;synced=干净合并完成;
 * conflict=冲突现场已落盘(代理 gitdir 生成的 MERGE_HEAD 等复制回真实
 * gitdir,Agent 的普通 git commit 才能收掉这场合并),推送必须拒绝;
 * unavailable=取不到基线,fail-open 照推留痕,传输故障不卡交付;
 * failed=merge 失败且无冲突文件,现场已 abort 还原。 */
export async function syncBaselineBeforePush(options: {
  dataDir: string;
  repoDir: string;
  repoUrl: string;
  baseline: string;
  ticket: string;
  credential?: GitCredential;
}): Promise<BaselineSyncOutcome> {
  const baseline = options.baseline.trim();
  if (!existsSync(join(options.repoDir, ".git"))) {
    return { kind: "failed", reason: `代码克隆不存在: ${options.repoDir}` };
  }
  const format = await runGit(
    ["check-ref-format", "--branch", baseline],
    { env: process.env, timeoutMs: 10_000 });
  if (format.code !== 0) {
    return { kind: "failed", reason: `基线分支名不合法: ${baseline}` };
  }
  const remoteUrl = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential,
    options.repoDir);
  let view: ReturnType<typeof createSafeGitView> | undefined;
  const name = options.credential?.username ?? "mae-flow-cloud";
  const email = options.credential?.email
    ?? `${name.replace(/[^a-zA-Z0-9_.+-]/g, "-")}@localhost`;
  try {
    view = createSafeGitView(options.repoDir);
    const baseRef = `refs/remotes/origin/${baseline}`;
    const git = (...args: string[]) => runGit(
      [...sandbox.args, "-c", `user.name=${name}`, "-c", `user.email=${email}`,
        ...args], {
        cwd: options.repoDir,
        env: view!.environment(sandbox.env),
        timeoutMs: args[0] === "fetch" || args[0] === "merge"
          ? GIT_TRANSFER_TIMEOUT_MS : 30_000,
      });
    const fetched = await git("fetch", "--quiet", "--no-tags",
      "--no-recurse-submodules", remoteUrl,
      `+refs/heads/${baseline}:${baseRef}`);
    if (fetched.code !== 0) {
      const detail = (fetched.stderr || fetched.stdout).trim()
        .split(/\r?\n/)[0] ?? "";
      return {
        kind: "unavailable",
        reason: `fetch ${baseline} 失败: ${detail.slice(0, 300)}`,
      };
    }
    const tip = (await git("rev-parse", "--verify", `${baseRef}^{commit}`))
      .stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(tip)) {
      return {
        kind: "unavailable",
        reason: `远端基线 ${baseline} 取回后读不到分支头`,
      };
    }
    const ancestor = await git("merge-base", "--is-ancestor", baseRef, "HEAD");
    if (ancestor.code === 0) return { kind: "current" };
    if (ancestor.code !== 1) {
      // 非 0/1 的退出码是环境怪状(仓损坏之类),不是"有新提交"。
      return {
        kind: "unavailable",
        reason: `无法比对基线新旧: `
          + `${(ancestor.stderr || ancestor.stdout).trim().slice(0, 200)}`,
      };
    }
    const from = (await git("merge-base", "HEAD", baseRef)).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(from)) {
      return {
        kind: "unavailable",
        reason: "算不出基线与修复分支的合并基(历史不相交?)",
      };
    }
    const counted = await git("rev-list", "--count", `HEAD..${baseRef}`);
    const commits = Number.parseInt(counted.stdout.trim(), 10);
    const message = `[${options.ticket}][fix] 同步基线 ${baseline} 至 ${tip.slice(0, 12)}`;
    const merged = await git("merge", "-m", message, baseRef);
    if (merged.code === 0) {
      return {
        kind: "synced",
        record: {
          repo: options.repoUrl, baseline, from, to: tip,
          commits: Number.isFinite(commits) ? commits : 0,
          at: new Date().toISOString(),
        },
      };
    }
    const conflicted = String((await git(
      "diff", "--no-ext-diff", "--no-textconv",
      "--name-only", "--diff-filter=U")).stdout || "")
      .trim().split("\n").filter(Boolean);
    if (!conflicted.length) {
      // merge 失败却没有冲突文件 = 环境怪状(脏文件之类),别把 Agent
      // 派进一个说不清的现场,abort 后如实上报。
      await git("merge", "--abort");
      return {
        kind: "failed",
        reason: `merge 失败但没有冲突文件: `
          + `${(merged.stderr || merged.stdout).trim().slice(0, 300)}`,
      };
    }
    // 冲突现场落盘:merge 的状态文件生成在代理 gitdir,复制回真实
    // gitdir 后 Agent 在容器里 git add/commit 就能收掉这场合并。若
    // gitdir 内出现软链等异动,fail-closed 还原现场,绝不跟随写文件。
    try {
      for (const stateFile of [
        "MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", "ORIG_HEAD",
      ]) {
        const source = join(view.proxyGitDir, stateFile);
        if (!existsSync(source)) continue;
        const info = lstatSync(source);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`代理 Git 状态 ${stateFile} 不是普通文件`);
        }
        const destination = join(view.repositoryGitDir, stateFile);
        if (existsSync(destination)) {
          const existing = lstatSync(destination);
          if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new Error(`任务 Git 状态 ${stateFile} 不是普通文件`);
          }
        }
        writeFileSync(destination, readFileSync(source), { mode: 0o600 });
      }
    } catch (error) {
      await git("merge", "--abort");
      return { kind: "failed", reason: `冲突现场落盘失败: ${String(error)}` };
    }
    return { kind: "conflict", files: conflicted };
  } finally {
    view?.cleanup();
    sandbox.cleanup();
  }
}

/** 修复分支外部提交吸收(ADR-0074)的结果:调用方按结果分叉。
 * - current:远端没有要吸收的东西(分支缺席/头没动/本地已含);
 * - synced:远端头是最后一笔推送收据的严格后代,已 fetch+merge 进
 *   工作区,commits=被吸收的外部提交(逐笔,喂外部头观测投影);
 * - conflict:干净合并撞冲突,现场已 merge --abort 还原(不留半合并
 *   工作区),files=冲突文件;
 * - dirty:工作区有已跟踪未提交改动,不做机械合并(交 Agent 处理后
 *   自行同步);
 * - blocked:三类非严格后代形态(rewritten=历史被改写/unbacked=无收据
 *   而远端有提交/rolled_back=远端被回滚)——一律拒绝喊人,绝不自动
 *   处理、绝不 force;
 * - unavailable:探针/取回失败(网络抖动等),fail-open 不拦调用方
 *   流程(推送链路的门在远端拒收);
 * - failed:merge 失败且无冲突文件,现场已 abort 还原。 */
export type ExternalAbsorbOutcome =
  | { kind: "current" }
  | { kind: "synced"; remoteTip: string; commits: string[] }
  | { kind: "conflict"; files: string[] }
  | { kind: "dirty"; files: string[] }
  | { kind: "blocked";
      form: "rewritten" | "unbacked" | "rolled_back";
      remoteTip: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

/** 判定并吸收修复分支远端的外部提交(ADR-0074,推送链路与回合开始
 * 探针共用的窄函数):判据只用推送收据加祖先关系,不看作者是谁。
 *
 * 远端头 = 收据 → 无事(短码直比,零 fetch——常态回合只有探针开销);
 * 收据的严格后代 → fetch 后 merge 进工作区
 * (一律 merge 不 rebase:平台未推送提交 SHA 不变,AI 归因 notes 不断
 * 链);收据的祖先(被回滚)或与收据不相交(历史被改写)→ fail-closed;
 * 无收据而远端有提交 → 本地头不含它即 fail-closed(本地头含它 = 导入
 * MR 等形态的首次推送,远端头本是本地起点,照常放行)。fetch/merge 与
 * 其他宿主 git 写同一套边界(代理 gitdir + 一次性凭据沙箱);合并身份
 * 与基线同步同款(-c 注入宿主用户名/邮箱),提交信息同格式(类型 fix)。
 * 冲突只试干净合并,撞上即 abort 还原现场——解冲突要判断,交调用方
 * 的对话现场。 */
export async function absorbExternalCommits(options: {
  dataDir: string;
  repoDir: string;
  repoUrl: string;
  branch: string;
  ticket: string;
  /** 本会话最后一笔推送收据(按仓、分支取自收据投影;缺席=该分支
   * 平台从未推过)。 */
  receiptSha?: string;
  credential?: GitCredential;
}): Promise<ExternalAbsorbOutcome> {
  if (!existsSync(join(options.repoDir, ".git"))) {
    return { kind: "failed", reason: `代码克隆不存在: ${options.repoDir}` };
  }
  const remoteUrl = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential,
    options.repoDir);
  let view: ReturnType<typeof createSafeGitView> | undefined;
  const receipt = options.receiptSha?.trim().toLowerCase();
  const name = options.credential?.username ?? "mae-flow-cloud";
  const email = options.credential?.email
    ?? `${name.replace(/[^a-zA-Z0-9_.+-]/g, "-")}@localhost`;
  try {
    view = createSafeGitView(options.repoDir);
    const baseRef = `refs/remotes/origin/${options.branch}`;
    const git = (...args: string[]) => runGit(
      [...sandbox.args, "-c", `user.name=${name}`, "-c", `user.email=${email}`,
        ...args], {
        cwd: options.repoDir,
        env: view!.environment(sandbox.env),
        timeoutMs: args[0] === "fetch" || args[0] === "merge"
          ? GIT_TRANSFER_TIMEOUT_MS : 30_000,
      });
    // 单引用探针:远端同名分支头。探针失败 fail-open(网络抖动不该
    // 停工,同 ADR-0071 的取回基线失败口径)。
    const probed = await runGit([
      ...sandbox.args, "ls-remote", "--heads", remoteUrl,
      `refs/heads/${options.branch}`,
    ], { env: sandbox.env, timeoutMs: 60_000 });
    if (probed.code !== 0) {
      const detail = (probed.stderr || probed.stdout).trim()
        .split(/\r?\n/)[0] ?? "";
      return { kind: "unavailable", reason: `探针失败: ${detail.slice(0, 300)}` };
    }
    const tip = probed.stdout.trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/i.test(tip)) return { kind: "current" };
    const tip12 = tip.slice(0, 12);
    // 远端头就是最后一笔收据 → 无事。纯短码比对,不用取回对象——常态
    // 回合(用户没在回合之间推代码)到这里就收工,零 fetch/merge(ADR-0074
    // 探针经济:探针本身是常态下唯一的开销)。
    if (receipt && tip12 === receipt.slice(0, 12)) return { kind: "current" };
    // 远端对象进不了本地判不了祖先关系,先 fetch(只动远端跟踪引用,
    // 不碰工作区)。
    const fetched = await git("fetch", "--quiet", "--no-tags",
      "--no-recurse-submodules", remoteUrl, `+refs/heads/${options.branch}:${baseRef}`);
    if (fetched.code !== 0) {
      const detail = (fetched.stderr || fetched.stdout).trim()
        .split(/\r?\n/)[0] ?? "";
      return { kind: "unavailable", reason: `fetch ${options.branch} 失败: `
        + `${detail.slice(0, 300)}` };
    }
    const isAncestor = async (older: string, newer: string): Promise<
      boolean | "unknown"
    > => {
      const outcome = await git("merge-base", "--is-ancestor", older, newer);
      if (outcome.code === 0) return true;
      if (outcome.code === 1) return false;
      return "unknown";
    };
    const head = (await git("rev-parse", "--verify", "HEAD")).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) {
      return { kind: "failed", reason: "读取工作区 HEAD 失败" };
    }
    if (!receipt) {
      // 该分支平台从未推过:远端头是本地起点(导入 MR 等形态)照常
      // 放行;本地头不含它 = 平台不知道的外部提交,fail-closed。
      const contained = await isAncestor(tip, head);
      if (contained === true) return { kind: "current" };
      if (contained === false) return { kind: "blocked", form: "unbacked", remoteTip: tip12 };
      return { kind: "unavailable", reason: "无法比对远端头与本地历史" };
    }
    const descended = await isAncestor(receipt, tip);
    if (descended === true) {
      // 严格后代:本地已含(Agent 自己并过)就无事,否则吸收。
      const contained = await isAncestor(tip, head);
      if (contained === true) return { kind: "current" };
      if (contained === "unknown") {
        return { kind: "unavailable", reason: "无法比对远端头与本地历史" };
      }
      // 机械合并要求干净的树(同 ADR-0071 脏工作区口径);推送链路
      // 的脏熔断在先,这里是回合开始探针等复用方的自家守门。
      const dirty = (await dirtyWorktree(options.repoDir))
        .filter((line) => !line.startsWith("??"));
      if (dirty.length) return { kind: "dirty", files: dirty };
      const listed = await git("rev-list", `${receipt}..${tip}`);
      const commits = listed.code === 0
        ? listed.stdout.trim().split("\n").filter(
            (line) => /^[0-9a-f]{40}$/i.test(line))
        : [];
      const message = `[${options.ticket}][fix] 并入远端外部提交 ${tip12}`;
      const merged = await git("merge", "-m", message, baseRef);
      if (merged.code === 0) {
        return { kind: "synced", remoteTip: tip12, commits };
      }
      const conflicted = String((await git(
        "diff", "--no-ext-diff", "--no-textconv",
        "--name-only", "--diff-filter=U")).stdout || "")
        .trim().split("\n").filter(Boolean);
      // 只试干净合并:冲突与否都还原现场,不留半合并工作区。
      await git("merge", "--abort");
      if (!conflicted.length) {
        return { kind: "failed", reason: `merge 失败但没有冲突文件: `
          + `${(merged.stderr || merged.stdout).trim().slice(0, 300)}` };
      }
      return { kind: "conflict", files: conflicted };
    }
    if (descended === false) {
      const rolledBack = await isAncestor(tip, receipt);
      if (rolledBack === true) {
        return { kind: "blocked", form: "rolled_back", remoteTip: tip12 };
      }
      if (rolledBack === false) {
        return { kind: "blocked", form: "rewritten", remoteTip: tip12 };
      }
    }
    return { kind: "unavailable", reason: "无法比对远端头与推送收据" };
  } finally {
    view?.cleanup();
    sandbox.cleanup();
  }
}

/** 远端探针的可区分形态(#240 删除门禁):reachable=false = 网络/凭据
 * 问题,远端状态不可判定;reachable=true 且 tip 缺席 = 远端确认没有
 * 同名分支。删除门禁不容忍"查不到"(宁误拦不误放),必须分得清
 * 这两种事实。 */
export interface RemoteBranchState {
  /** ls-remote 成功 = 远端可达;此刻 tip 字段有意义(缺席=分支不存在)。 */
  reachable: boolean;
  /** 同名分支的 tip;分支不存在时缺席(仅在 reachable 时可读)。 */
  tip?: string;
}

/** 宿主现查远端同名分支(凭据沙箱 ls-remote):三种事实各自可判——
 * 分支存在返回 { reachable: true, tip },确认不存在返回
 * { reachable: true },ls-remote 失败(网络/权限)返回
 * { reachable: false }。调用方按门禁口径分叉,不许把"查不到"当
 * "不存在"放行。 */
export async function remoteBranchState(options: {
  dataDir: string;
  repoUrl: string;
  branch: string;
  credential?: GitCredential;
}): Promise<RemoteBranchState> {
  const remoteUrl = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential);
  try {
    const probed = await runGit([
      ...sandbox.args, "ls-remote", "--heads", remoteUrl,
      `refs/heads/${options.branch}`,
    ], { env: sandbox.env, timeoutMs: 60_000 });
    if (probed.code !== 0) return { reachable: false };
    const tip = probed.stdout.trim().split(/\s+/)[0];
    return /^[0-9a-f]{40}$/i.test(tip)
      ? { reachable: true, tip }
      : { reachable: true };
  } finally {
    sandbox.cleanup();
  }
}
