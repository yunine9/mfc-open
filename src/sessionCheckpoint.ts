import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SemanticEvent } from "./semanticEvents.ts";

export interface SessionCheckpoint {
  manager: SessionManager;
  restored: boolean;
  messageCount: number;
  reason?: string;
}

/** Pi 原生树保存工具结果和压缩边界；事件账仍负责业务事实，两者不互相冒充。 */
export function openSessionCheckpoint(input: {
  taskId: string; sessionId: string; transcriptPath: string; agentDir: string;
  cwd: string; resume: boolean; log?: (message: string) => void;
}): SessionCheckpoint {
  const identity = { task: input.taskId, session: input.sessionId,
    transcript: resolve(input.transcriptPath), cwd: realpathSync(input.cwd) };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  // agentDir 已受宿主秘密目录边界保护，不能把包含完整上下文的文件放进代码仓。
  const root = join(input.agentDir, "sessions", key);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const index = join(root, "current.json");
  let reason: string | undefined;
  if (input.resume && existsSync(index)) {
    try {
      const saved = JSON.parse(readFileSync(index, "utf8"));
      if (JSON.stringify(saved.identity) !== JSON.stringify(identity)
        || typeof saved.file !== "string" || basename(saved.file) !== saved.file) {
        throw new Error("会话身份不匹配");
      }
      const file = join(root, saved.file);
      if (!existsSync(file)) throw new Error("会话文件缺失");
      if (realpathSync(file) !== join(realpathSync(root), saved.file)) throw new Error("会话路径越界");
      repairSessionTail(file, input.log);
      const manager = SessionManager.open(file, root, input.cwd);
      if (realpathSync(manager.getHeader()!.cwd) !== identity.cwd) throw new Error("会话工作目录不匹配");
      chmodSync(file, 0o600);
      return { manager, restored: true, messageCount: manager.buildSessionContext().messages.length };
    } catch (error) {
      // 损坏文件保留供排障，降级必须明说；不能把新会话标成成功恢复。
      reason = `Pi 会话未能恢复：${String(error)}`;
      input.log?.(reason);
    }
  } else if (input.resume) {
    reason = "没有已保存的 Pi 会话，将依据已有文件、决定和流程事实恢复";
    input.log?.(reason);
  }
  let manager = SessionManager.create(input.cwd, root);
  const file = manager.getSessionFile()!;
  // SDK 默认等首条 assistant 才建文件。先写合法头再打开，使最早的用户消息也立即落盘。
  writeFileSync(file, JSON.stringify(manager.getHeader()) + "\n", { mode: 0o600, flag: "wx" });
  manager = SessionManager.open(file, root, input.cwd);
  const temporary = `${index}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ identity, file: basename(file) }) + "\n", { mode: 0o600 });
  renameSync(temporary, index);
  return { manager, restored: false, messageCount: 0, reason };
}

function repairSessionTail(file: string, log?: (message: string) => void): void {
  const raw = readFileSync(file);
  const lines = raw.toString("utf8").split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { offset += Buffer.byteLength(line) + 1; continue; }
    try { JSON.parse(line); }
    catch {
      if (i !== lines.length - 1) throw new Error("会话中间记录损坏，保留原文件");
      const evidence = `${file}.interrupted-${Date.now()}`;
      writeFileSync(evidence, raw.subarray(offset), { mode: 0o600, flag: "wx" });
      truncateSync(file, offset);
      log?.("已保留并清理 Pi 会话的中断尾行");
      return;
    }
    offset += Buffer.byteLength(line) + 1;
  }
  if (raw.length && raw[raw.length - 1] !== 10) {
    // 完整 JSON 但缺换行也不能与下一条拼接。
    writeFileSync(file, Buffer.concat([raw, Buffer.from("\n")]));
  }
}

/** 仅补没有返回值的调用；有真实回执就带回原结果，未知则明确要求核实，绝不执行工具。 */
export function restorePendingToolResults(manager: SessionManager, events: SemanticEvent[], sessionId: string): void {
  const pending = new Map<string, { name: string }>();
  for (const message of manager.buildSessionContext().messages as any[]) {
    if (message.role === "assistant") for (const block of message.content ?? []) {
      if (block.type === "toolCall") pending.set(block.id, { name: block.name });
    }
    if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  const receipts = new Map<string, { result: unknown; is_error: unknown }>();
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const id = String(event.payload.call_id);
    if (event.kind === "tool_finished") receipts.set(id,
      { result: event.payload.result, is_error: event.payload.is_error });
    // Task 的报告先记 agent_finished，再等待 Hook，最后才返回 Pi。
    // 中断在这两步之间时，报告已经存在，不能误报成“没有结果”再派一次。
    if (event.kind === "agent_finished" && pending.get(id)?.name === "Task") receipts.set(id,
      { result: event.payload.final_text, is_error: event.payload.lifecycle !== "returned" });
  }
  for (const [id, call] of pending) {
    const receipt = receipts.get(id);
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: call.name,
      content: [{ type: "text", text: receipt ? String(receipt.result ?? "")
        : "执行服务中断，此调用没有可靠完成结果。先检查文件、执行日志或远端收据；不得推断未执行并盲目重复推送、创建 MR 或运行命令。" }],
      isError: receipt ? Boolean(receipt.is_error) : true, timestamp: Date.now(),
      details: { recovery: receipt ? "durable-receipt" : "unknown" },
    });
  }
}
