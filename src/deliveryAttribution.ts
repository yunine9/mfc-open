/** Read-only explanation of commit origins, not a delivery decision. */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyticsGit } from "./deliveryAnalyticsGit.ts";
import type { CodeOrigin } from "./deliveryAnalyticsTypes.ts";

export interface RepairInterval {
  base: string;
  head: string;
  origin: Exclude<CodeOrigin, "first">;
  evidence: string;
  foreign?: string;
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
export function validInterval(value: RepairInterval): boolean {
  return sha(value.base) && sha(value.head) && value.base !== value.head;
}
export function feedbackStamp(cwd: string): string {
  try { const s = lstatSync(join(cwd, ".mae-flow.json")); return `${s.mtimeMs}:${s.size}`; }
  catch { return "absent"; }
}
export function historicalRepairIntervals(cwd: string, taskId: string): RepairInterval[] {
  try {
    const path = join(cwd, ".mae-flow.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return [];
    const batches = JSON.parse(readFileSync(path, "utf8"))?.delivery_loop?.batches;
    if (!Array.isArray(batches)) return [];
    return batches.flatMap(batch => {
      if (batch?.task_id !== taskId || !Array.isArray(batch.items) || !batch.items.length) return [];
      const sources = new Set(batch.items.map((item: { source?: string }) => item?.source));
      const origin = sources.has("pipeline") ? "pipeline" : "review";
      // verified_sha alone is only a later validation result, not a repair end.
      const head = batch.result_digest ? batch.result_head
        : sources.size === 1 && sources.has("pipeline") ? batch.superseded_by_push : undefined;
      const interval: RepairInterval = { base: batch.base_sha, head, origin,
        evidence: `${origin === "pipeline" ? "流水线" : origin === "review" ? "检视" : "其他"}反馈批次 ${batch.batch_id}` };
      return validInterval(interval) ? [interval] : [];
    });
  } catch { return []; }
}

export async function intervalOrigins(cwd: string, head: string, intervals: RepairInterval[]) {
  const categories = new Map<string, Set<CodeOrigin>>(), evidence: Record<string, string[]> = {};
  const started = Date.now();
  const unique = [...new Map(intervals.map(i => [JSON.stringify(i), i])).values()];
  if (unique.length > 500) throw new Error("修复区间超过统计预算");
  for (const interval of unique) {
    if (!validInterval(interval)) continue;
    if (Date.now() - started > 60_000) throw new Error("修复区间取证超过一分钟预算");
    try {
      await analyticsGit(cwd, ["merge-base", "--is-ancestor", interval.base, interval.head]);
      await analyticsGit(cwd, ["merge-base", "--is-ancestor", interval.head, head]);
    } catch { continue; }
    const commits = (await analyticsGit(cwd, ["rev-list", "--first-parent", "--no-merges",
      `${interval.base}..${interval.head}`, ...(sha(interval.foreign) ? [`^${interval.foreign}`] : [])])).trim().split("\n").filter(Boolean);
    for (const commit of commits) {
      const set = categories.get(commit) ?? new Set<CodeOrigin>();
      set.add(interval.origin); categories.set(commit, set);
      (evidence[commit] ??= []).push(`${interval.evidence} · ${interval.base.slice(0, 10)} → ${interval.head.slice(0, 10)}`);
    }
  }
  const origins: Record<string, CodeOrigin> = {};
  for (const [commit, set] of categories) origins[commit] = set.has("pipeline") ? "pipeline" : "review";
  return { origins, evidence };
}
