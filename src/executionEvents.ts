import { openSync, closeSync, readSync, fstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { SemanticEvent } from "./semanticEvents.ts";

export type ExecutionEvent = SemanticEvent & {
  execution: { source: "main" | "build_fix"; attempt: string; round?: number };
};

/** 只读汇总独立账本；不把专项会话写进主会话的恢复记录。 */
export class ExecutionEventReader {
  private cursors = new Map<string, { offset: number; carry: Buffer; inode: number }>();
  constructor(private workspace: string, private buildFixOnly = false) {}

  hasMore = false;

  read(byteBudget = Number.POSITIVE_INFINITY): ExecutionEvent[] {
    this.hasMore = false;
    const sources: Array<{ path: string; execution: ExecutionEvent["execution"] }> = [];
    if (!this.buildFixOnly) sources.push({ path: join(this.workspace, "events.jsonl"),
      execution: { source: "main", attempt: "main" } });
    try {
      for (const dir of readdirSync(join(this.workspace, "prepush"), { withFileTypes: true })) {
        const match = /^round-(\d+)-/.exec(dir.name);
        if (dir.isDirectory() && match) sources.push({
          path: join(this.workspace, "prepush", dir.name, "events.jsonl"),
          execution: { source: "build_fix", attempt: dir.name, round: Number(match[1]) },
        });
      }
    } catch { /* 尚未进入构建；主会话照常展示。 */ }
    const result: ExecutionEvent[] = [];
    for (const source of sources) {
      if (byteBudget <= 0) { this.hasMore = true; break; }
      let fd: number | undefined;
      try {
        fd = openSync(source.path, "r");
        const stat = fstatSync(fd);
        let cursor = this.cursors.get(source.path);
        if (!cursor || stat.ino !== cursor.inode || stat.size < cursor.offset) {
          cursor = { offset: 0, carry: Buffer.alloc(0), inode: stat.ino };
          this.cursors.set(source.path, cursor);
        }
        // 固定块增量读，避免一次为整份编译日志分配内存。
        while (cursor.offset < stat.size && byteBudget > 0) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - cursor.offset, byteBudget));
          const count = readSync(fd, chunk, 0, chunk.length, cursor.offset);
          if (!count) break;
          cursor.offset += count;
          byteBudget -= count;
          cursor.carry = Buffer.concat([cursor.carry, chunk.subarray(0, count)]);
          const cut = cursor.carry.lastIndexOf(10);
          if (cut < 0) continue;
          const complete = cursor.carry.subarray(0, cut).toString("utf8");
          cursor.carry = Buffer.from(cursor.carry.subarray(cut + 1));
          for (const line of complete.split("\n")) {
            try {
              const event = JSON.parse(line);
              if (Number.isFinite(event.eventId) && typeof event.ts === "string"
                  && typeof event.kind === "string" && event.payload && typeof event.payload === "object") {
                result.push({ ...event, execution: source.execution });
              }
            } catch { /* 损坏单行不遮住其他事件；未写完的尾行留待下次。 */ }
          }
        }
        if (cursor.offset < stat.size) this.hasMore = true;
      } catch { /* 日志缺席或已回收，不影响其他来源。 */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    const time = (ts: string) => Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts)
      ? ts.replace(" ", "T") + "Z" : ts) || 0;
    return result.sort((a, b) => time(a.ts) - time(b.ts)
      || a.execution.attempt.localeCompare(b.execution.attempt) || a.eventId - b.eventId);
  }
}

export function streamExecutionEvents(response: ServerResponse, workspace: string,
  options: { buildFixOnly?: boolean; follow: boolean; terminal(): boolean }) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache",
    "x-accel-buffering": "no" });
  response.flushHeaders();
  const reader = new ExecutionEventReader(workspace, options.buildFixOnly);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let pending: ExecutionEvent[] = [];
  let next = 0;
  response.on("close", () => {
    closed = true;
    clearTimeout(timer);
    response.removeListener("drain", send);
    pending = [];
  });
  const send = () => {
    if (closed) return;
    if (next >= pending.length) {
      pending = reader.read(256 * 1024);
      next = 0;
    }
    while (next < pending.length) {
      const event = pending[next++];
      if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) {
        response.once("drain", send);
        return;
      }
    }
    pending = [];
    next = 0;
    // Even a finished task must drain its history before emitting end.
    if (!reader.hasMore && (!options.follow || options.terminal())) {
      response.end('event: end\ndata: {}\n\n');
      return;
    }
    if (!reader.hasMore) response.write(": heartbeat\n\n");
    // Yield between historical chunks so other requests and UI interactions run.
    timer = setTimeout(send, reader.hasMore ? 0 : 300);
  };
  send();
}
