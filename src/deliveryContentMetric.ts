import { restrictedAnalysisPathSegment } from "./analysisText.ts";
import { analyticsCodePath, analyticsGit, deliveryDiffPaths } from "./deliveryAnalyticsGit.ts";
import { historicalRepairIntervals, intervalOrigins, type RepairInterval } from "./deliveryAttribution.ts";
import { inferCommitOrigin } from "./deliveryOriginInference.ts";
import { emptyOrigins, type DeliveryCodeMetric } from "./deliveryAnalyticsTypes.ts";
import type { LocalCodeSnapshot } from "./finalMrLocalSnapshot.ts";

/** 只匹配新增行；补丁里的负号行不进入最终代码的分母。重复内容按出现次数匹配。 */
function additions(patch: string) {
  const lines: Array<{ text: string; line: number }> = [];
  let at = 0, inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) { at = Number(hunk[1]); inHunk = true; }
    else if (inHunk && text.startsWith("+")) lines.push({ text: text.slice(1), line: at++ });
    else if (inHunk && text.startsWith(" ")) at++;
  }
  return lines;
}
export async function contentMetric(input: {
  cwd: string; id: string; base: string; head: string; initial: { head: string; base: string };
  snapshot?: LocalCodeSnapshot; intervals: RepairInterval[]; reference: "local_snapshot" | "platform_push" | "initial_mr";
}): Promise<DeliveryCodeMetric> {
  const { cwd, base, head, initial, snapshot } = input;
  const started = Date.now();
  const run = (args: string[]) => {
    if (Date.now() - started > 60_000) throw new Error("内容比较超过一分钟预算");
    return analyticsGit(cwd, args);
  };
  const patch = (base: string, head: string, path: string, old?: string) => run(["--literal-pathspecs", "diff", "--unified=0", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", ...(old ? [`${base}:${old}`, `${head}:${path}`, "--"] : [base, head, "--", path])]);
  const visible = (path: string) => analyticsCodePath(path) && !path.split(/[\\/]/).some(p => restrictedAnalysisPathSegment.test(p));
  const local: Record<string, string> = snapshot?.patches ?? Object.create(null);
  if (!snapshot) {
    const paths = (await deliveryDiffPaths(run, initial.base, initial.head)).filter(e => visible(e.path));
    if (paths.length > 300) throw new Error("本地比较版本超过文件预算");
    for (const entry of paths) local[entry.path] = await patch(initial.base, initial.head, entry.path);
  }
  const pipeline = await intervalOrigins(cwd, head, [...input.intervals, ...historicalRepairIntervals(cwd, input.id)]);
  const metric: DeliveryCodeMetric = { version: 1, base, head, published_head: head, first: initial.head,
    initial_implementation: { basis: "content_comparison", end: initial.head },
    content_comparison: { reference: input.reference, base: initial.base, head: initial.head, captured_at: snapshot?.captured_at, snapshot_hash: snapshot?.hash },
    collected_at: new Date().toISOString(), retained: emptyOrigins(), rework: emptyOrigins(), deleted: 0, excluded_files: 0, commits: [] };
  let total = 0;
  const finalPaths = await deliveryDiffPaths(run, base, head);
  if (finalPaths.length > 300) throw new Error("内容比较超过文件预算");
  const seen = new Set<string>();
  for (const entry of finalPaths) {
    if (!visible(entry.path)) { metric.excluded_files++; continue; }
    seen.add(entry.path);
    const counts = new Map<string, number>();
    for (const line of additions(local[entry.path] ?? "")) counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
    const changed = additions(await patch(base, head, entry.path, entry.old));
    total += changed.length;
    if (total > 100_000) throw new Error("内容比较超过行数预算");
    // blame 只用于明确的流水线证据，不用于猜测首次实现。
    const origins = new Map<number, string>();
    if (changed.length) {
      const blame = await run(["--literal-pathspecs", "blame", "--line-porcelain", head, "--", entry.path]);
      for (const match of blame.matchAll(/^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/gm)) origins.set(Number(match[2]), match[1]);
    }
    const messages = new Map<string, boolean>();
    for (const line of changed) {
      const count = counts.get(line.text) ?? 0;
      if (count) { metric.retained.first++; counts.set(line.text, count - 1); continue; }
      const sha = origins.get(line.line);
      let ci = !!sha && pipeline.origins[sha] === "pipeline";
      if (sha && !ci) {
        if (!messages.has(sha)) {
          const guess = inferCommitOrigin(await run(["show", "-s", "--format=%B", sha]));
          messages.set(sha, guess?.origin === "pipeline" && !!guess.explicitRepair);
        }
        ci = messages.get(sha)!;
      }
      metric.retained[ci ? "pipeline" : "review"]++;
    }
    metric.deleted += entry.removed + [...counts.values()].reduce((a, b) => a + b, 0);
  }
  for (const [path, text] of Object.entries(local)) if (!seen.has(path)) metric.deleted += additions(text).length;
  return metric;
}
