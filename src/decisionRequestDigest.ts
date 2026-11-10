import { createHash } from "node:crypto";
import type { DecisionSubmission } from "./taskService.ts";

export function orderedRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, String(item)] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

/** 浏览器重试/双击的稳定身份。它只判断“是不是完全同一份提交”，
 * 不承担业务校验；业务校验仍由 normalizeDecisionSubmission 完成。 */
export function decisionRequestDigest(
  waitingId: string,
  input: DecisionSubmission,
): string {
  const normalized = {
    waiting_id: waitingId,
    state_version: input.state_version,
    selected_options: orderedRecord(input.selected_options),
    free_responses: orderedRecord(input.free_responses),
    comment: input.comment?.trim() || undefined,
    decision: input.decision?.trim() || undefined,
    answers: orderedRecord(input.answers),
    notes: input.notes?.trim() || undefined,
    annotation_ids: input.annotation_ids
      ? [...new Set(input.annotation_ids.map(String))].sort() : undefined,
    repository_skill_catalog_token:
      input.repository_skill_catalog_token || undefined,
    selected_repository_skill_ids: input.selected_repository_skill_ids
      ? [...new Set(input.selected_repository_skill_ids.map(String))].sort()
      : undefined,
    repository_assignees: orderedRecord(input.repository_assignees),
    repository_tickets: orderedRecord(input.repository_tickets),
    delivery_paths: input.delivery_paths
      ? [...new Set(input.delivery_paths.map(String))].sort() : undefined,
    delivery_compile_action: input.delivery_compile_action,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

