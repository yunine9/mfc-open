import type { KnowledgeArchivePreview } from "../../src/knowledgeProductionTypes";

export interface ArchiveIssueInput { issue_no: string; issue_description: string }

/** 点击归档即授权使用已有单号和正式版本创建 MR；缺少必要信息才补填。 */
export function archiveRequest(preview: KnowledgeArchivePreview) {
  const retry = preview.actions.find(action => action.id === "retry-archive");
  if (retry) return { action: "retry" as const, input: { batch_id: retry.batch_id, target_id: retry.target_id } };
  if (!preview.actions.some(action => action.id === "create-archive") || !preview.issue_no?.trim()) return undefined;
  return { action: "create" as const, input: { issue_no: preview.issue_no.trim(),
    issue_description: preview.issue_description?.trim() || undefined, expected_revisions: preview.expected_revisions } };
}
