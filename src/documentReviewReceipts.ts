import type { Annotation } from "./annotations.ts";
import { parseWorkspaceReviewReceipts } from "./feedbackPolicy.ts";
import { TaskControlError } from "./errors.ts";

/** 文档会话共用逐条回执校验；只核对身份和格式，改动范围交给人检视。 */
export function parseDocumentReviewReceipts(raw: string, annotations: Annotation[]) {
  let rows: unknown;
  try { rows = JSON.parse(raw.trim()); }
  catch { throw new TaskControlError("Agent 的逐条回执不是合法 JSON，本轮未发布"); }
  const byId = new Map(annotations.map((item) => [item.id, item]));
  const withRevision = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== "object") return row;
    const item = row as Record<string, unknown>;
    const target = byId.get(String(item.annotation_id ?? ""));
    return item.revision === undefined && target
      ? { ...item, revision: target.rework ?? 0 } : item;
  });
  const parsed = parseWorkspaceReviewReceipts(withRevision, annotations);
  const facts = [
    parsed.missing_ids.length ? `缺少 ${parsed.missing_ids.join("、")}` : "",
    parsed.unexpected_ids.length ? `多出 ${parsed.unexpected_ids.join("、")}` : "",
    ...parsed.errors,
  ].filter(Boolean);
  if (facts.length) throw new TaskControlError(`Agent 的逐条回执不完整：${facts.join("；")}。意见仍可重提`);
  return parsed.receipts;
}
