/**
 * 密封信封存储的最小可复用机制(抽自 src/issueEnvironment.ts 会话级
 * vault 的既有写法;#149 环境管理台账要同一套纪律但独立密钥):
 *
 *   - 一棵专属目录(0700、符号链接防护)放一把独立 32 字节密钥
 *     (key.bin:O_EXCL 首建者胜出、0600、符号链接防护——密钥绝不能走
 *     "临时文件 + rename 覆盖",同一 dataDir 若意外两进程同时首启,后
 *     rename 的进程会把先写入的 key 换掉,已加密数据从此不可恢复);
 *   - 每个数据文件一封 AES-256-GCM 信封(version/iv/tag/ciphertext),
 *     明文永不落盘;写入走临时文件 + rename 的原子写(0600、NOFOLLOW,
 *     失败清理临时件)。
 *
 * 密钥材料按目录互相独立:不同 root 各持各的 key.bin,互不换用——
 * 会话级 vault(.issue-environments)与环境台账(.environment-registry)
 * 就是这样分开的。这不是外部密钥管理系统的替代品,是"机密不明文混进
 * 普通 json"的第一道边界;未来接 Vault/KMS 时只需替换本类。
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";

const KEY_BYTES = 32;

export interface SealedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SealedFile {
  private readonly keyPath: string;

  constructor(private readonly root: string) {
    this.keyPath = join(root, "key.bin");
  }

  /** 把 value 密封进 root 下的 name(整个文件就是一封信封)。 */
  write(name: string, value: unknown): void {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const envelope: SealedEnvelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    this.atomicWrite(this.resolve(name), JSON.stringify(envelope));
  }

  /** 解密读回;文件缺席返回 undefined(空表还是报错由调用方定)。 */
  read<T>(name: string): T | undefined {
    const path = this.resolve(name);
    if (!existsSync(path)) return undefined;
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${name} 不能是符号链接`);
    }
    const envelope = JSON.parse(readFileSync(path, "utf8")) as SealedEnvelope;
    if (envelope.version !== 1) throw new Error(`不支持的 ${name} 信封版本`);
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
    return JSON.parse(plaintext) as T;
  }

  /** 数据文件名都是模块内常量,这里只挡目录穿越与怪字符。 */
  private resolve(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
      throw new Error(`密封文件名不合法: ${name}`);
    }
    return join(this.root, name);
  }

  private key(): Buffer {
    this.ensureRoot();
    if (!existsSync(this.keyPath)) {
      let descriptor: number | undefined;
      try {
        // O_EXCL 让第一位创建者胜出,其余进程只读取既有 key(理由见
        // 文件头:密钥走 rename 覆盖会互相换 key,已加密数据不可恢复)。
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
      throw new Error("密封密钥文件不能是符号链接");
    }
    chmodSync(this.keyPath, 0o600);
    const key = readFileSync(this.keyPath);
    if (key.length !== KEY_BYTES) throw new Error("密封密钥长度不正确");
    return key;
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) {
      throw new Error("密封存储目录不能是符号链接");
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
}
