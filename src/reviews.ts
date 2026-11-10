/**
 * Committer 检视台账：追加式 JSONL，服务重启后仍能恢复。
 *
 * 责任人主动邀请，Committer 看完后收口；任务结束则关闭未完成邀请，
 * 保留审计记录，不把邀请关闭冒充检视完成。
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface ReviewRequest {
  id: string;
  task_id: string;
  task_title: string;
  requester: string;
  committer: string;
  status: "pending" | "completed" | "canceled";
  created_at: string;
  completed_at?: string;
  canceled_at?: string;
  delivered: boolean;
  attempts: number;
  last_error?: string;
}

export class ReviewStore {
  private records = new Map<string, ReviewRequest>();

  constructor(readonly path: string, private readonly taskEnded?: (id: string) => boolean) {
    this.load();
  }

  list(): ReviewRequest[] {
    // 同时补齐旧版本遗留及任务落盘后进程中断的邀请，读到的待办必须有效。
    for (const record of this.records.values()) {
      if (record.status === "pending" && this.taskEnded?.(record.task_id)) {
        this.cancelTask(record.task_id);
      }
    }
    return [...this.records.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  forCommitter(committer: string): ReviewRequest[] {
    return this.list().filter((item) => item.committer === committer);
  }

  forTask(taskId: string): ReviewRequest[] {
    return this.list().filter((item) => item.task_id === taskId);
  }

  cancelTask(taskId: string): void {
    for (const record of this.records.values()) {
      if (record.task_id !== taskId || record.status !== "pending") continue;
      this.save({ ...record, status: "canceled", canceled_at: new Date().toISOString() });
    }
  }

  /** 彻底删除历史任务时同步清掉它的检视台账。JSONL 是追加日志，不能
   * 只改内存 Map；必须把该任务所有历史版本一并从文件中滤掉。 */
  purgeTask(taskId: string): number {
    const removed = [...this.records.values()]
      .filter((item) => item.task_id === taskId).length;
    if (!existsSync(this.path)) {
      for (const [id, item] of this.records) {
        if (item.task_id === taskId) this.records.delete(id);
      }
      return removed;
    }

    const kept = readFileSync(this.path, "utf-8").split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return (JSON.parse(line) as { task_id?: string }).task_id !== taskId;
        } catch {
          // 与 load 的容错口径一致：坏行不属于任何已识别任务，保留它，
          // 不能借删除一单顺手损坏别的审计现场。
          return true;
        }
      });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      writeFileSync(temporary, kept.length ? `${kept.join("\n")}\n` : "", {
        encoding: "utf-8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    for (const [id, item] of this.records) {
      if (item.task_id === taskId) this.records.delete(id);
    }
    return removed;
  }

  create(input: {
    taskId: string;
    taskTitle: string;
    requester: string;
    committer: string;
  }): ReviewRequest {
    const existing = this.list().find((item) =>
      item.task_id === input.taskId && item.committer === input.committer
      && item.status === "pending");
    if (existing) return existing;
    const record: ReviewRequest = {
      id: `review-${randomUUID()}`,
      task_id: input.taskId,
      task_title: input.taskTitle,
      requester: input.requester,
      committer: input.committer,
      status: "pending",
      created_at: new Date().toISOString(),
      delivered: false,
      attempts: 0,
    };
    this.save(record);
    return record;
  }

  delivery(
    id: string,
    result: { delivered: boolean; attempts: number; last_error?: string },
  ): ReviewRequest {
    const current = this.required(id);
    const next: ReviewRequest = {
      ...current,
      delivered: result.delivered,
      attempts: result.attempts,
      last_error: result.last_error || undefined,
    };
    this.save(next);
    return next;
  }

  complete(id: string, committer: string): ReviewRequest {
    const current = this.required(id);
    if (current.committer !== committer) {
      throw new Error("只能完成邀请给自己的检视");
    }
    if (current.status !== "pending") return current;
    const next: ReviewRequest = {
      ...current,
      status: "completed",
      completed_at: new Date().toISOString(),
    };
    this.save(next);
    return next;
  }

  private required(id: string): ReviewRequest {
    const record = this.records.get(id);
    if (!record) throw new Error(`检视邀请 ${id} 不存在`);
    return record;
  }

  private save(record: ReviewRequest): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(this.path, 0o600);
    this.records.set(record.id, record);
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    // 断写尾巴读口自愈(票 #160):pending 邀请账不能再被崩溃半行吞掉。
    for (const record of readAppendOnlyJsonl<ReviewRequest>(this.path,
      { middleCorrupt: "skip" })) {
      if (record.id && record.task_id && record.committer) {
        this.records.set(record.id, record);
      }
    }
  }
}

export function assertReviewCanComplete(notes: ReadonlyArray<{ status: string }>): void {
  const drafts = notes.filter((item) => item.status === "draft");
  const open = notes.filter((item) => item.status === "sent");
  if (drafts.length || open.length) {
    throw new Error([
      drafts.length ? `还有 ${drafts.length} 条草稿尚未提交或删除` : "",
      open.length ? `还有 ${open.length} 条已提交意见尚未确认闭环` : "",
    ].filter(Boolean).join("；"));
  }
}
