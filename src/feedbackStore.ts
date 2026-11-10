/** Append-only Cloud index over the source-specific review ledgers. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type FeedbackSource =
  | "workspace"
  | "build_fix"
  | "pipeline"
  | "mr_discussion"
  | "conflict"
  | "scope"
  | "push_confirmation";

export type FeedbackStatus =
  | "open"
  | "repairing"
  | "addressed"
  | "awaiting_verification"
  | "closed"
  | "superseded"
  | "superseded_by_merge"
  | "needs_human"
  | "deferred";

export interface FeedbackRecord {
  id: string;
  batch_id: string;
  source: FeedbackSource;
  source_id: string;
  source_revision: number;
  observed_sha: string;
  summary: string;
  material?: string;
  file?: string;
  line?: number;
  /** 意见出自谁(CodeHub 检视人的显示名)。只进 Cloud 索引、不进内核批次
   * ——内核只裁"改没改好",谁提的意见是给人看的排版事实。 */
  author?: string;
  verification: string;
  status: FeedbackStatus;
  resolution?: string;
  updated_at: string;
}

type Operation =
  | { op: "upsert"; record: FeedbackRecord }
  | { op: "resolve"; id: string; status: FeedbackStatus;
      resolution: string; at: string };

export class FeedbackStoreCorruptionError extends Error {}

const SOURCES = new Set<FeedbackSource>([
  "workspace", "build_fix", "pipeline", "mr_discussion", "conflict",
  "scope", "push_confirmation",
]);
const STATUSES = new Set<FeedbackStatus>([
  "open", "repairing", "addressed", "awaiting_verification", "closed",
  "needs_human", "deferred",
  "superseded", "superseded_by_merge",
]);

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value;
}

function instant(value: unknown, name: string): string {
  const result = requiredText(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} 不是合法时间`);
  return result;
}

function validRecord(value: unknown): value is FeedbackRecord {
  if (!value || typeof value !== "object") throw new Error("record 必须是对象");
  const record = value as Record<string, unknown>;
  for (const key of ["id", "batch_id", "source_id", "observed_sha", "summary",
    "verification"] as const) requiredText(record[key], `record.${key}`);
  if (!SOURCES.has(record.source as FeedbackSource)) {
    throw new Error("record.source 不受支持");
  }
  if (!STATUSES.has(record.status as FeedbackStatus)) {
    throw new Error("record.status 不受支持");
  }
  if (!Number.isSafeInteger(record.source_revision)
      || Number(record.source_revision) < 0) {
    throw new Error("record.source_revision 必须是非负安全整数");
  }
  instant(record.updated_at, "record.updated_at");
  for (const key of ["material", "file", "resolution", "author"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new Error(`record.${key} 必须是字符串`);
    }
  }
  if (record.line !== undefined
      && (!Number.isSafeInteger(record.line) || Number(record.line) < 0)) {
    throw new Error("record.line 必须是非负安全整数");
  }
  return true;
}

export class FeedbackStore {
  constructor(readonly path: string) {}

  list(): FeedbackRecord[] {
    if (!existsSync(this.path)) return [];
    const records = new Map<string, FeedbackRecord>();
    const text = readFileSync(this.path, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let operation: Operation;
      try {
        operation = JSON.parse(line) as Operation;
      } catch (error) {
        // 只宽容真正被进程截断的最后一行 JSON。完整 JSON 即使没有末尾
        // 换行，也必须继续做语义校验；不能把伪造操作当 torn tail 跳过。
        const truncatedTail = index === lines.length - 1 && !text.endsWith("\n");
        if (truncatedTail) break;
        throw new FeedbackStoreCorruptionError(
          `持续检视索引第 ${index + 1} 行损坏，已停止读写，不能静默隐藏反馈：${String(error)}`,
        );
      }
      try {
        if (operation.op === "upsert" && validRecord(operation.record)) {
          records.set(operation.record.id, operation.record);
        } else if (operation.op === "resolve") {
          requiredText(operation.id, "resolve.id");
          if (!STATUSES.has(operation.status)) throw new Error("resolve.status 不受支持");
          requiredText(operation.resolution, "resolve.resolution");
          instant(operation.at, "resolve.at");
          const previous = records.get(operation.id);
          if (!previous) throw new Error(`resolve 引用了未知反馈 ${operation.id}`);
          records.set(operation.id, {
            ...previous,
            status: operation.status,
            resolution: operation.resolution,
            updated_at: operation.at,
          });
        } else {
          throw new Error("未知操作或缺少反馈标识");
        }
      } catch (error) {
        throw new FeedbackStoreCorruptionError(
          `持续检视索引第 ${index + 1} 行损坏，已停止读写，不能静默隐藏反馈：${String(error)}`,
        );
      }
    }
    return [...records.values()].sort((a, b) =>
      a.updated_at.localeCompare(b.updated_at));
  }

  upsert(records: FeedbackRecord[]): void {
    records.forEach((record) => validRecord(record));
    const current = new Map(this.list().map((record) => [record.id, record]));
    for (const record of records) {
      const previous = current.get(record.id);
      if (previous && previous.batch_id === record.batch_id) continue;
      this.append({ op: "upsert", record });
    }
  }

  resolve(
    id: string,
    status: FeedbackStatus,
    resolution: string,
  ): void {
    requiredText(id, "resolve.id");
    if (!STATUSES.has(status)) throw new Error("resolve.status 不受支持");
    requiredText(resolution, "resolve.resolution");
    if (!this.list().some((record) => record.id === id)) {
      throw new Error(`resolve 引用了未知反馈 ${id}`);
    }
    this.append({
      op: "resolve", id, status, resolution,
      at: new Date().toISOString(),
    });
  }

  private append(operation: Operation): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.repairTruncatedTail();
    writeFileSync(this.path, JSON.stringify(operation) + "\n", {
      encoding: "utf-8", mode: 0o600, flag: "a",
    });
  }

  /** A crash may leave only the final JSON line torn.  Trim that suffix before
   * appending; any corrupt complete/middle line remains a fail-closed error. */
  private repairTruncatedTail(): void {
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, "utf-8");
    if (!text || text.endsWith("\n")) {
      // list() performs the strict middle-line validation.
      this.list();
      return;
    }
    const lastBreak = text.lastIndexOf("\n");
    const tail = text.slice(lastBreak + 1);
    try {
      JSON.parse(tail);
      // A complete final record missing only its newline is preserved.
      writeFileSync(this.path, "\n", { encoding: "utf-8", flag: "a" });
    } catch {
      truncateSync(this.path, lastBreak < 0 ? 0
        : Buffer.byteLength(text.slice(0, lastBreak + 1), "utf-8"));
    }
    this.list();
  }
}
