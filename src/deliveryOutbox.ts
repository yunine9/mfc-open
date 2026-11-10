/**
 * 外部交付动作的 append-only outbox。
 *
 * Agent 产出的回复先入账，代码 push 成功后才允许发送。进程可以死在
 * 任意一条回复前后：已成功的不会从本地账上消失，失败的保持 pending，
 * 重启继续。外部端同时收到稳定 idempotency_key，用来封住“远端成功、
 * 本地来不及记成功”这个最后的重复窗口。
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  truncateSync,
} from "node:fs";

export interface ReviewReplyPayload {
  discussion_id: string;
  /** 评论版本；老 outbox 没有该字段时按 0 兼容。 */
  source_revision?: number;
  body: string;
  repo: string;
  mr?: string | number;
  resolve: boolean;
  /** 回复所依据、且必须已经推到远端的最终提交。 */
  expected_sha: string;
}

export interface DeliveryOutboxItem {
  id: string;
  kind: "review_reply";
  payload: ReviewReplyPayload;
  state: "pending" | "delivered";
  attempts: number;
  created_at: string;
  delivered_at?: string;
  last_error?: string;
}

type Operation =
  | { op: "enqueue"; item: DeliveryOutboxItem }
  | { op: "attempt"; id: string; at: string }
  | { op: "failed"; id: string; at: string; error: string }
  | { op: "delivered"; id: string; at: string };

export interface ParsedReviewReplies {
  replies: Array<{ id: string; body: string }>;
  missing_ids: string[];
  duplicate_ids: string[];
}

/** 模型常把正文写在 [id] 同一行，解析器同时接受单独行与同行正文。
 * knownIds 是本次需要的回复，boundaryIds 可包含已经入队的讨论：旧回复
 * 仍需切段，但不能混进新回复正文；普通 [foo] 仍是正文。 */
export function parseReviewReplies(
  text: string,
  knownIds?: Iterable<string>,
  boundaryIds?: Iterable<string>,
): ParsedReviewReplies {
  const known = knownIds ? new Set(knownIds) : undefined;
  const boundaries = boundaryIds ? new Set(boundaryIds) : known;
  const replies: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string[] } | undefined;
  for (const line of String(text ?? "").split("\n")) {
    const head = line.trim().match(/^\[([^\]\s]+)\]\s*(.*)$/);
    if (head && (!boundaries || boundaries.has(head[1]))) {
      if (current) {
        replies.push({ id: current.id, body: current.body.join("\n").trim() });
      }
      current = { id: head[1], body: head[2] ? [head[2]] : [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    replies.push({ id: current.id, body: current.body.join("\n").trim() });
  }
  const byId = new Map<string, string>();
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const reply of replies) {
    if (known && !known.has(reply.id)) continue;
    if (seen.has(reply.id)) duplicates.add(reply.id);
    seen.add(reply.id);
    if (reply.body) byId.set(reply.id, reply.body);
  }
  for (const id of duplicates) byId.delete(id);
  const normalized = [...byId].map(([id, body]) => ({ id, body }));
  return {
    replies: normalized,
    duplicate_ids: [...duplicates],
    missing_ids: known
      ? [...known].filter((id) => !byId.has(id)) : [],
  };
}

function replyId(payload: ReviewReplyPayload): string {
  const digest = createHash("sha256").update(JSON.stringify({
    discussion_id: payload.discussion_id,
    ...(payload.source_revision !== undefined
      ? { source_revision: payload.source_revision } : {}),
    body: payload.body,
    repo: payload.repo,
    mr: payload.mr,
    resolve: payload.resolve,
    expected_sha: payload.expected_sha,
  })).digest("hex");
  return `review-reply-${digest.slice(0, 24)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
    && !Number.isNaN(Date.parse(value));
}

/** JSON.parse 只有语法保证。outbox 决定外部动作是否已经发生，合法 JSON
 * 里的错字段同样必须 fail-closed，不能靠 TypeScript 断言把它当真。 */
function storedItem(
  value: unknown,
  line: number,
): DeliveryOutboxItem {
  const item = record(value);
  const payload = record(item?.payload);
  const discussionId = typeof payload?.discussion_id === "string"
    ? payload.discussion_id.trim() : "";
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  const repo = typeof payload?.repo === "string" ? payload.repo : "";
  const expectedSha = typeof payload?.expected_sha === "string"
    ? payload.expected_sha.trim() : "";
  const mr = payload?.mr;
  const sourceRevision = payload?.source_revision;
  const validRevision = sourceRevision === undefined
    || (Number.isSafeInteger(sourceRevision) && Number(sourceRevision) >= 0);
  const validMr = mr === undefined || typeof mr === "string"
    || (typeof mr === "number" && Number.isFinite(mr));
  if (!item || item.kind !== "review_reply"
      || typeof item.id !== "string" || !item.id
      || item.state !== "pending" || item.attempts !== 0
      || !timestamp(item.created_at)
      || item.delivered_at !== undefined || item.last_error !== undefined
      || !payload || !discussionId || !body || !repo.trim() || !expectedSha
      || payload.discussion_id !== discussionId || payload.body !== body
      || payload.expected_sha !== expectedSha
      || typeof payload.resolve !== "boolean" || !validMr || !validRevision) {
    throw new Error(`delivery outbox 第 ${line} 行入队项无效`);
  }
  const normalized: ReviewReplyPayload = {
    discussion_id: discussionId,
    ...(sourceRevision !== undefined
      ? { source_revision: Number(sourceRevision) } : {}),
    body,
    repo,
    ...(mr !== undefined ? { mr: mr as string | number } : {}),
    resolve: payload.resolve,
    expected_sha: expectedSha,
  };
  if (item.id !== replyId(normalized)) {
    throw new Error(`delivery outbox 第 ${line} 行入队项 id 与内容不匹配`);
  }
  return {
    id: item.id,
    kind: "review_reply",
    payload: normalized,
    state: "pending",
    attempts: 0,
    created_at: item.created_at,
  };
}

function storedOperation(value: unknown, line: number): Operation {
  const operation = record(value);
  const op = operation?.op;
  if (!operation || !["enqueue", "attempt", "failed", "delivered"]
    .includes(String(op ?? ""))) {
    throw new Error(`delivery outbox 第 ${line} 行操作无效`);
  }
  if (op === "enqueue") {
    return { op, item: storedItem(operation.item, line) };
  }
  if (typeof operation.id !== "string" || !operation.id
      || !timestamp(operation.at)) {
    throw new Error(`delivery outbox 第 ${line} 行 ${String(op)} 操作无效`);
  }
  if (op === "failed") {
    if (typeof operation.error !== "string" || operation.error.length > 1000) {
      throw new Error(`delivery outbox 第 ${line} 行 failed 操作无效`);
    }
    return { op, id: operation.id, at: operation.at, error: operation.error };
  }
  return {
    op: op as "attempt" | "delivered",
    id: operation.id,
    at: operation.at,
  };
}

export class DeliveryOutbox {
  constructor(readonly path: string) {}

  list(): DeliveryOutboxItem[] {
    if (!existsSync(this.path)) return [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf-8");
    } catch (error) {
      // outbox 是“哪些外部动作已成功”的权威事实；读不出来绝不能
      // 假装空账继续重投或删草稿。
      throw new Error(`读取 delivery outbox 失败: ${String(error)}`);
    }
    const items = new Map<string, DeliveryOutboxItem>();
    const lines = text.split("\n");
    const hasTrailingNewline = text.endsWith("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // 进程可能死在 append 的半行：仅允许“文件末尾且没有换行”的
        // 截断尾巴，下一次写入前会安全截掉。中段/完整坏行意味着事实链
        // 不可信，必须 fail-closed，留给人修复原文件。
        if (index === lines.length - 1 && !hasTrailingNewline) continue;
        throw new Error(`delivery outbox 第 ${index + 1} 行损坏: ${String(error)}`);
      }
      const operation = storedOperation(parsed, index + 1);
      if (operation.op === "enqueue") {
        if (!items.has(operation.item.id)) {
          items.set(operation.item.id, structuredClone(operation.item));
        }
        continue;
      }
      const item = items.get(operation.id);
      if (!item) {
        throw new Error(
          `delivery outbox 第 ${index + 1} 行引用未知项: ${operation.id}`);
      }
      if (item.state !== "pending") {
        throw new Error(
          `delivery outbox 第 ${index + 1} 行对已发送项重复 ${operation.op}`);
      }
      if (operation.op === "attempt") {
        item.attempts += 1;
        item.last_error = undefined;
      } else if (operation.op === "failed") {
        item.last_error = operation.error;
      } else if (operation.op === "delivered") {
        item.state = "delivered";
        item.delivered_at = operation.at;
        item.last_error = undefined;
      }
    }
    return [...items.values()];
  }

  enqueueReviewReply(
    payload: ReviewReplyPayload,
    at = new Date().toISOString(),
  ): DeliveryOutboxItem {
    const normalized: ReviewReplyPayload = {
      ...payload,
      discussion_id: String(payload.discussion_id).trim(),
      body: String(payload.body).trim(),
      repo: String(payload.repo ?? ""),
      expected_sha: String(payload.expected_sha ?? "").trim(),
    };
    if (!normalized.discussion_id || !normalized.body
        || !normalized.repo.trim() || !normalized.expected_sha) {
      throw new Error(
        "检视回复缺少 discussion_id、正文、代码仓或 expected_sha");
    }
    const id = replyId(normalized);
    const existing = this.list().find((item) => item.id === id);
    if (existing) return existing;
    const item: DeliveryOutboxItem = {
      id,
      kind: "review_reply",
      payload: normalized,
      state: "pending",
      attempts: 0,
      created_at: at,
    };
    this.append({ op: "enqueue", item });
    return item;
  }

  pendingReviewReplies(expectedSha?: string): DeliveryOutboxItem[] {
    return this.list().filter((item) =>
      item.kind === "review_reply" && item.state === "pending"
      && (!expectedSha || item.payload.expected_sha === expectedSha));
  }

  markAttempt(id: string, at = new Date().toISOString()): void {
    this.requirePending(id);
    this.append({ op: "attempt", id, at });
  }

  markFailed(id: string, error: string, at = new Date().toISOString()): void {
    this.requirePending(id);
    this.append({ op: "failed", id, at, error: String(error).slice(0, 1000) });
  }

  markDelivered(id: string, at = new Date().toISOString()): void {
    this.requirePending(id);
    this.append({ op: "delivered", id, at });
  }

  private requirePending(id: string): void {
    const item = this.list().find((one) => one.id === id);
    if (!item) throw new Error(`outbox 项不存在: ${id}`);
    if (item.state === "delivered") throw new Error(`outbox 项已发送: ${id}`);
  }

  private append(operation: Operation): void {
    // 写侧 fail-closed：调用方只有成功返回后才能删除 Agent 草稿。
    let separator = "";
    if (existsSync(this.path)) {
      let text: string;
      try {
        text = readFileSync(this.path, "utf-8");
      } catch (error) {
        throw new Error(`读取 delivery outbox 失败: ${String(error)}`);
      }
      if (text && !text.endsWith("\n")) {
        const tailAt = text.lastIndexOf("\n") + 1;
        const tail = text.slice(tailAt);
        try {
          JSON.parse(tail);
          separator = "\n"; // 完整 JSON 只缺换行，保留并隔开下一条。
        } catch {
          // 唯一可自动恢复的损坏：崩溃留下的末尾半行。按 UTF-8 字节
          // 截到上一条完整换行，之后再 append，避免半行与新 JSON 粘连。
          truncateSync(this.path,
            Buffer.byteLength(text.slice(0, tailAt), "utf-8"));
        }
      }
    }
    appendFileSync(this.path,
      separator + JSON.stringify(operation) + "\n", "utf-8");
  }
}
