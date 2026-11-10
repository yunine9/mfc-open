import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FeedbackStore } from "./feedbackStore.ts";
import { feedbackIdentity } from "./feedbackLoop.ts";

/** 检视意见(适配层契约形状,宿主只读这些字段)。 */
export interface DiscussionItem {
  id: string;
  /** CodeHub discussion revision when available; content hash fallback below. */
  revision?: number;
  updated_at?: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body?: string;
}

export type DiscussionFetch =
  | { kind: "available"; items: DiscussionItem[] }
  | { kind: "unavailable"; reason: string };

export function discussionRevision(item: DiscussionItem): number {
  if (Number.isSafeInteger(item.revision) && Number(item.revision) >= 0) {
    return Number(item.revision);
  }
  // Some CodeHub deployments expose updated_at but no numeric revision.  Bind
  // the full visible payload so editing the same discussion cannot be mistaken
  // for an idempotent replay on the same HEAD.
  const digest = createHash("sha256").update(JSON.stringify({
    updated_at: item.updated_at ?? "",
    body: item.body ?? "",
    file: item.file ?? "",
    line: item.line ?? null,
    author: item.author ?? "",
  })).digest("hex").slice(0, 12);
  return Number.parseInt(digest, 16);
}

export function discussionKey(item: DiscussionItem): string {
  return `${item.id}:r${discussionRevision(item)}`;
}


/** 拉取失败不能冒充空列表；超时涵盖响应正文，避免整个 MR 监听卡住。 */
export async function fetchMrDiscussions(input: {
  platformUrl?: string; repo: string;
  delivery?: { mr_id?: number | string; mr_url?: string };
  headers?: Record<string, string>; timeoutMs?: number;
}): Promise<DiscussionFetch> {
  try {
    const mr = input.delivery?.mr_id ?? input.delivery?.mr_url?.match(/merge_requests\/(\d+)/)?.[1];
    if (!input.platformUrl || !mr) throw new Error("平台地址或 MR 标识缺失");
    const params = new URLSearchParams({ repo: input.repo, mr: String(mr) });
    const response = await fetch(`${input.platformUrl}/mr/discussions?${params}`, {
      // 内网 CLI 预算为 30 秒（--limit 100 拉全量检视意见后加倍，
      // ab5b1da），宿主须留出适配器返回结果的时间，不能先于命令预算中断。
      headers: input.headers, signal: AbortSignal.timeout(input.timeoutMs ?? 40_000),
    });
    if (!response.ok) {
      // 适配层 502 正文含 CLI stderr；带上摘要才能归因限流/超时/5xx。
      const text = await response.text().catch(() => "");
      let detail = text.trim();
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (parsed?.error) detail = String(parsed.error).trim();
      } catch { /* 非 JSON 就按原文摘要。 */ }
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 600)}` : ""}`);
    }
    const body = await response.json() as { discussions?: unknown[] };
    if (!Array.isArray(body.discussions)) throw new Error("平台未返回讨论列表");
    const items = body.discussions.map((value: any) => {
      if (!value || !["string", "number"].includes(typeof value.id) || !String(value.id).trim()) {
        throw new Error("平台讨论条目缺少有效 id");
      }
      return { ...value, id: String(value.id) } as DiscussionItem;
    });
    return { kind: "available", items };
  } catch (error) {
    return { kind: "unavailable", reason: String(error).slice(0, 300) };
  }
}

/** 观察不派单：在原有反馈索引展示外部意见，不改动已在处理的批次/回执。
 * observed 批次与内核正式批次分开，后续派单仍必须由 openFeedbackBatch 登记。
 */
export function observeMrDiscussions(workspace: string, sha: string | undefined, items: DiscussionItem[]): void {
  const dir = join(workspace, "reviews");
  mkdirSync(dir, { recursive: true });
  // 另存观察快照，避免覆盖在途 Agent 正在消费的 discussions.json。
  writeFileSync(join(dir, "observed-discussions.json"), JSON.stringify(items, null, 2));
  if (!sha) return; // 没有版本事实不能造一个 observed_sha。
  const store = new FeedbackStore(join(workspace, "feedback", "index.jsonl"));
  const current = store.list();
  for (const item of items) {
    const revision = discussionRevision(item);
    if (current.some(r => r.source === "mr_discussion" && r.source_id === item.id && r.source_revision === revision)) continue;
    const identity = { source: "mr_discussion" as const, source_id: item.id, source_revision: revision, observed_sha: sha };
    const id = feedbackIdentity(identity);
    store.upsert([{ ...identity, id, batch_id: `observed:${id}`, summary: item.body || "MR 检视意见",
      file: item.file, line: item.line, author: item.author,
      material: join(dir, "observed-discussions.json"), verification: "reviewer",
      status: "open", updated_at: new Date().toISOString() }]);
  }
}
