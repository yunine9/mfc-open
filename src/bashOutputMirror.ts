/**
 * 容器 Bash 的完整输出镜像。
 *
 * Pi 自带的 OutputAccumulator 会在输出超过 50KB/2000 行时，把全文写到
 * 宿主 `/tmp/pi-bash-*.log`。任务容器和 Gate 都到不了那个路径，所以
 * 那条提示对 Agent 实际不可用。这里在 BashOperations 边界把每条命令的
 * 原始输出同步镜像到任务工作区，并只向 Pi 转发一个有界的“开头 + 末尾”
 * 预览。这样 Pi 不会再生成宿主临时文件，模型仍能看到错误末尾，全文则可
 * 用 Read 经同一工作区门禁打开。
 *
 * 这层只写日志，不执行命令；真正的命令仍完全由注入的容器 operations
 * 执行。日志不记录命令和环境变量，避免额外复制凭据。
 */

import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

const LOG_ROOT = [".mae-flow-work", "bash-logs"] as const;
const HEAD_MAX_BYTES = 8 * 1024;
const HEAD_MAX_LINES = 200;
const TAIL_MAX_BYTES = 32 * 1024;
const TAIL_MAX_LINES = 800;
const LIVE_MAX_CHARS = 4 * 1024;
const LIVE_FLUSH_MS = 1_000;

export interface WorkspaceBashOutputChunk {
  command: string;
  text: string;
  relativePath: string;
}

export interface WorkspaceBashLogOptions {
  workspace: string;
  taskId: string;
  sessionId: string;
  /** 仅供确定性单测；生产使用 UTC 当前时间。 */
  now?: () => Date;
  /** 仅供确定性单测；生产使用随机 nonce，避免并发命令争用文件。 */
  nonce?: () => string;
  log?: (message: string) => void;
  /** 长命令尚未结束时的可观测性旁路。回调失败只关闭实时旁路，绝不
   * 中断命令；完整原始输出仍以字节流持续写入 relativePath。 */
  onOutput?: (chunk: WorkspaceBashOutputChunk) => void;
  /** 仅供确定性单测；生产默认每秒最多追加一个事件。 */
  liveFlushMs?: number;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

function safeSegment(value: string): string {
  const raw = value.trim() || "session";
  const readable = raw.replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

/**
 * 逐级建目录且拒绝软链。业务命令能写工作区，若允许它把日志根替换成
 * 指向仓外的软链，宿主镜像输出就会变成越界写；因此这里必须先拒绝，
 * 不能依赖最终文件名“看起来在 .mae-flow-work 下”。
 */
function ensureDirectory(path: string, workspace: string, mode: number): string {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Bash 完整输出目录不是受控目录: ${path}`);
    }
  } else {
    mkdirSync(path, { mode });
  }
  const real = realpathSync(path);
  if (!inside(workspace, real)) {
    throw new Error(`Bash 完整输出目录越出任务工作区: ${path}`);
  }
  return real;
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function newlineCount(data: Buffer): number {
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return count;
}

/** 预算边界落在 UTF-8 continuation byte 上时，退回到完整字符之前。 */
function utf8SafeEnd(data: Buffer, proposed: number): number {
  if (proposed >= data.length) return data.length;
  let end = proposed;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

function prefixWithinBudget(
  data: Buffer,
  bytesLeft: number,
  linesLeft: number,
): number {
  if (bytesLeft <= 0 || linesLeft <= 0 || data.length === 0) return 0;
  let end = Math.min(data.length, bytesLeft);
  let newlines = 0;
  for (let index = 0; index < end; index += 1) {
    if (data[index] !== 0x0a) continue;
    newlines += 1;
    if (newlines >= linesLeft) {
      end = index + 1;
      break;
    }
  }
  return utf8SafeEnd(data, end);
}

class RollingTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  append(data: Buffer): void {
    if (!data.length) return;
    this.chunks.push(Buffer.from(data));
    this.bytes += data.length;
    while (this.bytes > TAIL_MAX_BYTES && this.chunks.length) {
      const excess = this.bytes - TAIL_MAX_BYTES;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  content(): Buffer {
    let result = Buffer.concat(this.chunks, this.bytes);
    // 滚动字节窗可能从 UTF-8 continuation byte 开始，丢掉残缺前缀。
    let start = 0;
    while (start < result.length && (result[start] & 0xc0) === 0x80) start += 1;
    if (start) result = result.subarray(start);

    let newlines = 0;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index] !== 0x0a) continue;
      newlines += 1;
      if (newlines > TAIL_MAX_LINES) return result.subarray(index + 1);
    }
    return result;
  }
}

interface OutputLog {
  fd: number;
  relativePath: string;
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error("Bash 完整输出日志发生短写");
    offset += written;
  }
}

function openOutputLog(options: WorkspaceBashLogOptions): OutputLog {
  const workspace = realpathSync(resolve(options.workspace));
  const work = ensureDirectory(join(workspace, LOG_ROOT[0]), workspace, 0o700);
  const logs = ensureDirectory(join(work, LOG_ROOT[1]), workspace, 0o700);
  const task = ensureDirectory(join(logs, safeSegment(options.taskId)),
    workspace, 0o700);
  const session = ensureDirectory(join(task, safeSegment(options.sessionId)),
    workspace, 0o700);
  const nonce = (options.nonce?.() ?? randomBytes(6).toString("hex"))
    .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  if (!nonce) throw new Error("Bash 完整输出日志 nonce 不能为空");
  const absolutePath = join(session,
    `${utcStamp(options.now?.() ?? new Date())}-${nonce}.log`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(absolutePath, flags, 0o600);
  const relativePath = relative(workspace, absolutePath).split(sep).join("/");
  return { fd, relativePath };
}

function hint(relativePath: string): Buffer {
  return Buffer.from(
    `\n\n[完整命令输出：${relativePath}（可用 Read 打开）]\n`,
    "utf-8",
  );
}

function hintText(relativePath: string): string {
  return hint(relativePath).toString("utf-8").trim();
}

/** Pi 会原样重抛非 abort/timeout 的 operations 异常并丢掉 accumulator。
 * 把可达路径带在异常本身上，基础设施失败也不会只剩一行无现场错误。 */
class WorkspaceBashOperationError extends Error {
  constructor(original: unknown, relativePath: string) {
    super(`${String(original)}\n\n${hintText(relativePath)}`, { cause: original });
    this.name = "WorkspaceBashOperationError";
  }
}

/** Pi 会在非零/Abort 后把状态追加到输出末尾。重新把路径移到最末，避免
 * “有日志但最后一眼仍找不到”的细节退化。 */
function moveHintToEnd(message: string): string {
  const pattern = /\n*\[完整命令输出：[^\n]+（可用 Read 打开）\]\n*/g;
  let latest = "";
  const body = message.replace(pattern, (matched) => {
    latest = matched.trim();
    return "\n";
  }).trimEnd();
  return latest ? `${body}\n\n${latest}` : message;
}

/**
 * 为容器 Bash 增加工作区全文镜像与有界预览。
 *
 * - 成功、非零退出、timeout、Abort 都在底层 settle 后关闭日志并把相对
 *   路径作为最后一段输出；
 * - 底层异常原样重抛，保留 Pi 对 `aborted`/`timeout:*` 的既有判定；
 * - 日志创建失败发生在命令执行前，直接 fail-closed，不回退宿主 Bash。
 */
export function withWorkspaceBashLogs(
  operations: BashOperations,
  options: WorkspaceBashLogOptions,
): BashOperations {
  return {
    exec: async (command, cwd, execution) => {
      const outputLog = openOutputLog(options);
      const tail = new RollingTail();
      let headBytes = 0;
      let headLines = 0;
      let overflow = false;
      let writeFailure: unknown;
      let previewFailure: unknown;
      const liveDecoder = new StringDecoder("utf-8");
      const liveFlushMs = Math.max(1, options.liveFlushMs ?? LIVE_FLUSH_MS);
      let liveText = "";
      let liveTimer: ReturnType<typeof setTimeout> | undefined;
      let lastLiveFlush = 0;
      let liveDisabled = !options.onOutput;

      const flushLive = (): void => {
        if (liveTimer) {
          clearTimeout(liveTimer);
          liveTimer = undefined;
        }
        if (liveDisabled || !liveText) return;
        const text = liveText;
        liveText = "";
        lastLiveFlush = Date.now();
        try {
          options.onOutput?.({
            command,
            text,
            relativePath: outputLog.relativePath,
          });
        } catch (error) {
          // SSE/事件账只是观测旁路。它坏了不能把一次正常编译判失败。
          liveDisabled = true;
          options.log?.(
            `Bash 实时输出旁路不可用 (${outputLog.relativePath}): ${String(error)}`,
          );
        }
      };
      const queueLiveText = (text: string): void => {
        if (liveDisabled || !text) return;
        liveText += text;
        if (liveText.length > LIVE_MAX_CHARS) {
          liveText = `[较早的实时输出已折叠]\n${liveText.slice(-LIVE_MAX_CHARS)}`;
        }
        const elapsed = Date.now() - lastLiveFlush;
        if (lastLiveFlush === 0 || elapsed >= liveFlushMs) {
          flushLive();
          return;
        }
        if (!liveTimer) {
          liveTimer = setTimeout(flushLive, liveFlushMs - elapsed);
          liveTimer.unref?.();
        }
      };

      const forward = (data: Buffer): void => {
        if (!data.length || previewFailure) return;
        try {
          execution.onData(data);
        } catch (error) {
          // 回调来自 Pi；绝不能让它从 docker stdout 事件处理器里同步冒泡
          // 造成进程级 uncaughtException。命令收口后再按基础设施错误报告。
          previewFailure = error;
        }
      };
      const onData = (data: Buffer): void => {
        if (!writeFailure) {
          try {
            writeAll(outputLog.fd, data);
          } catch (error) {
            writeFailure = error;
          }
        }
        queueLiveText(liveDecoder.write(data));
        if (overflow) {
          tail.append(data);
          return;
        }
        const length = prefixWithinBudget(
          data,
          HEAD_MAX_BYTES - headBytes,
          HEAD_MAX_LINES - headLines,
        );
        if (length) {
          const preview = data.subarray(0, length);
          headBytes += preview.length;
          headLines += newlineCount(preview);
          forward(preview);
        }
        if (length < data.length) {
          overflow = true;
          tail.append(data.subarray(length));
          forward(Buffer.from(
            `\n[输出较长，中段已省略；全文持续写入 ${outputLog.relativePath}]\n`,
            "utf-8",
          ));
        }
      };

      let result: { exitCode: number | null } | undefined;
      let operationFailure: unknown;
      try {
        result = await operations.exec(command, cwd, {
          ...execution,
          onData,
        });
      } catch (error) {
        operationFailure = error;
      }

      queueLiveText(liveDecoder.end());
      flushLive();

      try {
        closeSync(outputLog.fd);
      } catch (error) {
        writeFailure ??= error;
      }
      if (overflow) {
        forward(Buffer.from("\n[命令输出末尾]\n", "utf-8"));
        forward(tail.content());
      }
      // 必须最后发送：Pi 的失败/Abort 路径会在 operations reject 后立即
      // finish accumulator，放到 finally 之外就可能丢掉唯一可达的路径。
      forward(hint(outputLog.relativePath));

      if (writeFailure || previewFailure) {
        const failure = writeFailure ?? previewFailure;
        options.log?.(
          `Bash 完整输出日志不可用 (${outputLog.relativePath}): ${String(failure)}`,
        );
        if (!operationFailure) {
          throw new Error(
            `命令已结束，但完整输出日志未可靠保存: ${outputLog.relativePath}`,
            { cause: failure },
          );
        }
      }
      if (operationFailure) {
        if (operationFailure instanceof Error
            && (operationFailure.message === "aborted"
              || operationFailure.message.startsWith("timeout:"))) {
          throw operationFailure;
        }
        throw new WorkspaceBashOperationError(
          operationFailure,
          outputLog.relativePath,
        );
      }
      return result ?? { exitCode: null };
    },
  };
}

/**
 * CloudSession 的唯一 Bash 工具装配入口。除了 operations 镜像，还修正
 * Pi 在失败路径追加状态后的提示顺序；成功与失败最终看到的最后一段都
 * 是同一个工作区相对路径。
 */
export function createWorkspaceBashToolDefinition(
  cwd: string,
  operations: BashOperations,
  options: WorkspaceBashLogOptions,
) {
  const definition = createBashToolDefinition(cwd, {
    operations: withWorkspaceBashLogs(operations, options),
  });
  const execute = definition.execute.bind(definition) as (...args: any[]) => any;
  return {
    ...definition,
    description:
      "Execute a bash command in the task container. Returns a bounded head/tail "
      + "preview and always saves the complete output under .mae-flow-work/bash-logs.",
    execute: async (...args: any[]) => {
      try {
        const result = await execute(...args);
        // Pi 1.x 的非零退出通过 isError 返回；保留结构化退出码，并让日志路径仍在最后。
        return { ...result, content: result.content.map((block: any) =>
          block.type === "text" ? { ...block, text: moveHintToEnd(block.text) } : block) };
      } catch (error) {
        if (error instanceof Error) error.message = moveHintToEnd(error.message);
        throw error;
      }
    },
  };
}
