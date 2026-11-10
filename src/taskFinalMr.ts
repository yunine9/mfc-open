import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryMr } from "./mrImportTypes.ts";
import type { TaskSummary } from "./taskService.ts";

export interface InitialDeliveryMr { url: string; head?: string; base?: string }
export interface FinalDeliveryMr {
  url: string; id: string | number; repo: string; source_branch: string; target_branch: string;
  state: "opened" | "closed" | "merged"; head?: string; base?: string; merge_commit_sha?: string; merged_at?: string;
}

const validSha = (s: unknown): s is string => typeof s === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(s);
function stored(path: string) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** 老任务只用首次发布时留下的证据，后续推送不能代表初版。 */
export function originalMr(summary: Pick<TaskSummary, "delivery" | "workspace">): InitialDeliveryMr | undefined {
  const d = summary.delivery;
  if (d?.initial_mr) return d.initial_mr;
  if (!d?.mr_url) return undefined;
  const first = stored(join(summary.workspace, "delivery-experience", "first.json"));
  const report = stored(join(summary.workspace, "delivery-summary", "state.json"));
  const head = first?.head ?? report?.first_head;
  // 旧报告的 base 来自任务工作区当时的远端跟踪分支，可能落后于 MR 平台。
  return { url: first?.mr || d.mr_url, head: validSha(head) ? head : undefined };
}

export function captureOriginalMr(summary: Pick<TaskSummary, "delivery" | "workspace">,
  url: string, head: string): InitialDeliveryMr {
  return originalMr(summary) ?? { url, head };
}

export function finalMrRecord(mr: DeliveryMr): FinalDeliveryMr {
  return { url: mr.url, id: mr.iid, repo: mr.repo, source_branch: mr.source_branch,
    target_branch: mr.target_branch, state: mr.state, head: mr.sha, base: mr.base_sha, merge_commit_sha: mr.merge_commit_sha, merged_at: mr.merged_at };
}
