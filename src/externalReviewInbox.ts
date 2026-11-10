import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AnnotationStore, type Annotation } from "./annotations.ts";
import type { Notifier } from "./notifier.ts";
import { FeedbackStore } from "./feedbackStore.ts";

export interface ExternalReviewSource {
  scope: string;
  discussion_id: string;
  content_key: string;
  mr_url?: string;
}
export interface ExternalReviewItem {
  id: string; body?: string; author?: string; file?: string; line?: number;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 来源去重只负责同步，不参与授权、代码版本校验或批注闭环。删除仍留 add 记录。 */
export function importExternalReviews(store: AnnotationStore, input: {
  scope: string; mrUrl?: string; owner: string; items: ExternalReviewItem[];
}): Annotation[] {
  const known = store.list();
  const added: Annotation[] = [];
  let seq = Math.max(0, ...known.map(item => item.seq ?? 0));
  for (const item of input.items) {
    const body = String(item.body ?? "").trim();
    if (!body || !item.id) continue;
    // 同一讨论的时间戳、SHA 和行号漂移不等于新增意见。
    const contentKey = hash([body, item.author ?? "", item.file ?? ""]);
    const duplicate = known.some(note => note.external_review?.scope === input.scope
      && note.external_review.content_key === contentKey
      && (note.external_review.discussion_id === String(item.id)
        || (note.line === (item.line ?? 0) && note.file === (item.file || "MR 检视报告"))));
    if (duplicate) continue;
    const record = store.add({
      author: item.author || "MR 检视人", artifact: "__external_mr_review__",
      file: item.file || "MR 检视报告", line: item.line ?? 0,
      anchor: `MR 讨论 #${item.id}`, note: body, kind: "code",
      route: "owner_reply", assignee: input.owner, seq: ++seq,
      external_review: { scope: input.scope, discussion_id: String(item.id), content_key: contentKey,
        ...(input.mrUrl ? { mr_url: input.mrUrl } : {}) },
    });
    known.push(record); added.push(record);
  }
  return added;
}

/** 升级时把已有观察材料收进同一批注账；完整观察正文优先于旧反馈摘要。 */
export function importStoredExternalReviews(store: AnnotationStore, workspace: string, mrUrl: string, owner: string): void {
  const file = join(workspace, "reviews", "observed-discussions.json");
  let observed: ExternalReviewItem[] = [];
  try {
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    if (Array.isArray(raw)) observed = raw.filter(item => item && item.id != null && typeof item.body === "string");
  } catch { /* 外部观察文件损坏不能挡住本地批注读写。 */ }
  const present = new Set(observed.map(item => String(item.id)));
  const alreadyImported = new Set(store.list().filter(item => item.external_review?.scope === mrUrl)
    .map(item => item.external_review!.discussion_id));
  let legacy: ExternalReviewItem[] = [];
  try {
    legacy = new FeedbackStore(join(workspace, "feedback", "index.jsonl")).list()
      .filter(item => item.source === "mr_discussion" && !present.has(item.source_id) && !alreadyImported.has(item.source_id)
        && !["closed", "superseded", "superseded_by_merge"].includes(item.status))
      .map(item => ({ id: item.source_id, body: item.summary, author: item.author, file: item.file, line: item.line }));
  } catch { /* 沿用已有反馈索引诊断，批注继续可用。 */ }
  importExternalReviews(store, { scope: mrUrl, mrUrl, owner, items: [...observed, ...legacy] });
}

const notifying = new Set<string>();
/** 每五分钟汇总尚未通知的新批注；成功后才记账，普通轮询和重启不重发。 */
export async function notifyExternalReviews(input: {
  store: AnnotationStore; workspace: string; scope: string; owner: string;
  taskId: string; link: string; notifier?: Notifier; now?: number;
}): Promise<void> {
  if (!input.notifier || !input.owner) return;
  const dir = join(input.workspace, "reviews");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `external-notified-${hash([input.scope, input.owner])}.json`);
  if (notifying.has(path)) return;
  notifying.add(path);
  try {
    const state: { checked_at: number; ids: string[] } = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")) : { checked_at: 0, ids: [] };
    const now = input.now ?? Date.now();
    if (state.checked_at && now - state.checked_at < 300_000) return;
    const save = () => { writeFileSync(`${path}.tmp`, JSON.stringify(state)); renameSync(`${path}.tmp`, path); };
    state.checked_at = now; save();
    const sent = new Set(state.ids);
    const fresh = input.store.list().filter(note => note.external_review?.scope === input.scope
      && !sent.has(note.id) && note.status === "draft" && !note.agent_assigned && !note.owner_reply && !note.resolution);
    if (!fresh.length) return;
    const result = await input.notifier.notifyReviewReady({
      taskId: input.taskId, senderAccount: input.owner, account: input.owner, link: input.link,
      summary: `MR 新增 ${fresh.length} 条待判断意见。可自行闭环、补充要求后批量交办。\n`
        + fresh.slice(0, 5).map(note => `- ${note.note.replace(/\s+/g, " ").slice(0, 100)}`).join("\n"),
      revisionKey: `external:${hash(fresh.map(note => note.id))}`,
    });
    if (result.delivered) { state.ids.push(...fresh.map(note => note.id)); save(); }
  } finally { notifying.delete(path); }
}
