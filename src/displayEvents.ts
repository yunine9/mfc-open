import { open } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { SemanticEvent } from "./semanticEvents.ts";

/** 页面只保留会用到的字段，工具原始输出仍留在事件正本和执行过程里。 */
export function displayEvent(event: SemanticEvent): SemanticEvent {
  const source = event.payload ?? {};
  let payload = source;
  if (event.kind === "tool_output") payload = {};
  if (event.kind === "agent_spawned" || event.kind === "agent_finished") {
    const { prompt: _prompt, final_text: _result, ...rest } = source;
    payload = rest;
  }
  if (event.kind === "tool_requested" || event.kind === "tool_finished") {
    const input = (source.input ?? {}) as Record<string, unknown>;
    const assistant = event.sessionId === "developer-assistant";
    // 开发助手还要展示工具输入与结果，保留原值交给它现有的截断逻辑。
    // 主会话活动只用结果判断是否遇到内核报错，不缓存数十 MB 编译输出。
    payload = { call_id: source.call_id, name: source.name, is_error: source.is_error,
      input: assistant ? source.input : {
        path: input.path, file_path: input.file_path, command: input.command, questions: input.questions,
      },
      result: assistant ? source.result
        : /mae-flow|门禁/.test(String(source.result ?? "")) ? "mae-flow" : "",
    };
  }
  return { eventId: event.eventId, taskId: event.taskId, sessionId: event.sessionId,
    ts: event.ts, kind: event.kind, payload };
}

interface FileStamp { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Entry {
  stamp: FileStamp;
  offset: number;
  rows: SemanticEvent[];
  tail?: SemanticEvent;
  tailBytes?: number;
  bytes: number;
}

/** 展示用的只读增量索引。首次分块异步读，之后只读新增字节；同文件并发
 * 共用一次读取。绝不调用恢复回放或修复尾行，避免页面截断正在写的日志。 */
export class DisplayEventReader {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<SemanticEvent[]>>();
  constructor(private options: {
    maxFiles?: number; maxBytes?: number;
    log?: (message: string) => void;
    observeRead?: (bytes: number) => void;
  } = {}) {}

  read(path: string): Promise<SemanticEvent[]> {
    const existing = this.pending.get(path);
    if (existing) return existing;
    const reading = this.load(path).finally(() => {
      this.pending.delete(path);
      this.trim();
    });
    this.pending.set(path, reading);
    return reading;
  }

  private trim() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes + (entry.tailBytes ?? 0), 0);
    for (const [path, entry] of this.entries) {
      if (this.entries.size <= (this.options.maxFiles ?? 16)
          && bytes <= (this.options.maxBytes ?? 32 * 1024 * 1024)) break;
      if (this.pending.has(path)) continue;
      this.entries.delete(path); bytes -= entry.bytes + (entry.tailBytes ?? 0);
    }
  }

  private async load(path: string): Promise<SemanticEvent[]> {
    const started = performance.now();
    let readBytes = 0, parsed = 0, skipped = 0;
    const file = await open(path, "r").catch(error => {
      this.entries.delete(path);
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!file) return [];
    try {
      const stamp = await file.stat();
      let entry = this.entries.get(path);
      const previous = entry?.stamp;
      // 追加日志不修改已完成的前缀；替换、截短和原地等长改写均重新读取。
      if (!entry || !previous || previous.dev !== stamp.dev || previous.ino !== stamp.ino
          || stamp.size < previous.size
          || stamp.size === previous.size && (stamp.mtimeMs !== previous.mtimeMs || stamp.ctimeMs !== previous.ctimeMs)) {
        entry = { stamp, offset: 0, rows: [], bytes: 0 };
      } else if (previous.size === stamp.size) {
        this.entries.delete(path); this.entries.set(path, entry);
        return entry.tail ? [...entry.rows, entry.tail] : entry.rows;
      }
      this.entries.delete(path); this.entries.set(path, entry);
      entry.tail = undefined;
      entry.tailBytes = 0;
      const parts: Buffer[] = [];
      let partBytes = 0, position = entry.offset;
      const parse = (line: Buffer): SemanticEvent | undefined => {
        if (!line.length) return undefined;
        try {
          const value = JSON.parse(line.toString("utf8"));
          if (!value || typeof value !== "object" || typeof value.kind !== "string"
              || !value.payload || typeof value.payload !== "object") return undefined;
          parsed++;
          return displayEvent(value);
        } catch { skipped++; return undefined; }
      };
      while (position < stamp.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stamp.size - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        readBytes += bytesRead; this.options.observeRead?.(bytesRead);
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0, newline: number;
        while ((newline = chunk.indexOf(10, start)) >= 0) {
          const part = chunk.subarray(start, newline);
          const row = parse(parts.length ? Buffer.concat([...parts, part], partBytes + part.length) : part);
          if (row) {
            entry.rows.push(row);
            entry.bytes += JSON.stringify(row).length * 2 + 128;
          }
          parts.length = 0; partBytes = 0;
          entry.offset = position + newline + 1;
          start = newline + 1;
        }
        if (start < chunk.length) {
          const part = Buffer.from(chunk.subarray(start)); parts.push(part); partBytes += part.length;
        }
        position += bytesRead;
        // 密集历史解析也给 HTTP、计时器和正在运行的会话让出主线程。
        await setImmediate();
      }
      // 缺换行的完整旧行可展示，但不推进完成偏移；半行下次重读，绝不修盘。
      if (parts.length) {
        entry.tail = parse(Buffer.concat(parts, partBytes));
        if (entry.tail) entry.tailBytes = JSON.stringify(entry.tail).length * 2 + 128;
      }
      entry.stamp = stamp;
      if (performance.now() - started >= 250 || skipped) this.options.log?.(`[display-events] ${JSON.stringify({
        elapsed_ms: Math.round(performance.now() - started), read_bytes: readBytes,
        parsed, skipped, cached_events: entry.rows.length,
      })}`);
      return entry.tail ? [...entry.rows, entry.tail] : entry.rows;
    } catch (error) {
      this.entries.delete(path);
      throw error;
    } finally { await file.close(); }
  }
}

/** 最后一次提交批注后，主会话最先说的八段话；保持原有时间及截断语义。 */
export function annotationReply(events: readonly SemanticEvent[], sentTimes: readonly (string | undefined)[]) {
  const times = sentTimes.map(at => Date.parse(at ?? "")).filter(Number.isFinite);
  if (!times.length) return undefined;
  const lastSent = Math.max(...times);
  const texts: string[] = [];
  let truncated = false;
  for (const event of events) {
    const raw = String(event.ts ?? "").trim();
    const instant = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? raw.replace(" ", "T") + "Z" : raw);
    if (event.kind !== "assistant_message" || String(event.sessionId ?? "main") !== "main"
        || !(instant > lastSent)) continue;
    const text = String(event.payload?.text ?? "").trim();
    if (!text) continue;
    if (texts.length === 8) { truncated = true; break; }
    if (text.length > 1500) truncated = true;
    texts.push(text.length > 1500 ? text.slice(0, 1500) + "…" : text);
  }
  return texts.length ? { texts, truncated } : undefined;
}
