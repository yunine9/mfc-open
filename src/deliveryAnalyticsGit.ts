import { inferCommitOrigin } from "./deliveryOriginInference.ts";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";
import { emptyOrigins, type CodeOrigin, type DeliveryCodeMetric } from "./deliveryAnalyticsTypes.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
function numstat(raw: string): Array<{ added: number; removed: number; path: string; old?: string }> {
  const fields = raw.split("\0"), entries: ReturnType<typeof numstat> = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    const old = match[3] ? undefined : fields[++i];
    const path = match[3] || fields[++i];
    if (match[1] !== "-" && match[2] !== "-") entries.push({ added: Number(match[1]), removed: Number(match[2]), path, old });
  }
  return entries;
}
/** Delivery text includes source, configuration and extensionless scripts.
 * Git numstat filters binary files; exclude Markdown and obvious runtime/build noise. */
export function analyticsCodePath(path: string): boolean {
  return !/(^|\/)(?:node_modules|vendor|dist|build|target|generated|\.mae-flow|\.git)(\/|$)/i.test(path)
    && !/(^|\/)\.mae-flow(?:[.-][^/]*)?$/i.test(path)
    && !/\.(?:md|markdown|mdx)$/i.test(path)
    && !/(?:\.min\.[cm]?js|\.g\.(?:cs|dart)|\.generated\.[^.]+|\.pb\.(?:cc|h|go)|_pb2\.py)$/i.test(path);
}

export async function analyticsGit(cwd: string, args: string[]): Promise<string> {
  const result = await runSafeWorktreeGitAsync(cwd, args, { timeoutMs: 15_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Git 历史不完整或读取超时，未计入统计");
  return String(result.stdout ?? "");
}

export function deliveryDiffPaths(run: (args: string[]) => Promise<string>, base: string, head: string) {
  return run(["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--find-renames", "-z", base, head, "--"]).then(numstat);
}

/** 行数取最终差异，既不需要首版历史，也不把同一行的反复修改重复累计。 */
export async function finalMrSize(cwd: string, base: string, head: string) {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error("缺少最终 MR 的完整版本");
  const run = (args: string[]) => analyticsGit(cwd, args);
  await run(["merge-base", "--is-ancestor", base, head]);
  const paths = await deliveryDiffPaths(run, base, head);
  let lines = 0, deleted = 0;
  for (const entry of paths) if (analyticsCodePath(entry.path)) {
    lines += entry.added;
    deleted += entry.removed;
  }
  return { lines, deleted };
}

/** Literal paths, NUL-separated names and immutable full object IDs throughout. */
export async function calculateDeliveryCode(input: {
  cwd: string; base: string; head: string; first?: string; task_base?: string;
  origins?: Record<string, CodeOrigin>;
  infer_unattributed?: boolean;
  repair_commits?: string[];
  initial_mr_head?: string;
  final_only?: boolean;
}): Promise<DeliveryCodeMetric> {
  const { cwd, base, head } = input;
  if (![base, head, ...(input.first ? [input.first] : []), ...(input.task_base ? [input.task_base] : [])].every(sha => SHA.test(sha))) throw new Error("缺少完整的统计版本");
  const started = Date.now();
  const run = (args: string[]) => {
    if (Date.now() - started > 60_000) throw new Error("统计超过一分钟预算，未计入统计");
    return analyticsGit(cwd, args);
  };
  await run(["merge-base", "--is-ancestor", base, head]);
  if (input.task_base) await run(["merge-base", "--is-ancestor", input.task_base, head]);
  const hashes = (await run(["rev-list", "--first-parent", "--reverse", "--no-merges", `${base}..${head}`,
    ...(input.task_base ? [`^${input.task_base}`] : [])])).trim().split("\n").filter(Boolean);
  if (hashes.length > 500) throw new Error("提交超过单任务统计预算，未计入统计");
  const first = input.first ?? hashes[0];
  if (!first) throw new Error("没有可统计的非合并提交");
  // Rewritten first commit must not silently become the new 'first'.
  await run(["merge-base", "--is-ancestor", first, head]);
  // The classification below follows first parents. A developer can merge the
  // original branch as a side branch, where ancestry alone cannot classify it.
  let afterPublication: Set<string> | undefined;
  if (input.initial_mr_head) {
    const chain = (await run(["rev-list", "--first-parent", "--max-count=501", head])).trim().split("\n");
    const at = chain.indexOf(input.initial_mr_head);
    if (at < 0) throw new Error("初版提交不在可追溯的主提交链上，无法区分三类代码来源");
    afterPublication = new Set(chain.slice(0, at));
  }
  const messages = new Map<string, string[]>();
  for (const sha of hashes) messages.set(sha, (await run(["show", "-s", "--format=%cI%n%B", sha])).trim().split("\n"));
  const repairCommits = new Set(input.repair_commits);
  let boundary = hashes.findIndex(sha => repairCommits.has(sha));
  // The target may already have absorbed earlier repair commits. They still
  // establish that the remaining source commits are after the initial phase.
  if (boundary < 0 && hashes.length) {
    for (const sha of repairCommits) {
      if (!SHA.test(sha)) continue;
      try { await run(["merge-base", "--is-ancestor", sha, hashes[0]]); boundary = 0; break; }
      catch { /* unrelated or unavailable historical record */ }
    }
  }
  let basis: NonNullable<DeliveryCodeMetric["initial_implementation"]>["basis"] = "repair_record";
  if (boundary < 0) {
    basis = "commit_message";
    boundary = hashes.findIndex(sha => inferCommitOrigin(messages.get(sha)!.slice(1).join("\n"))?.explicitRepair);
  }
  if (boundary < 0) { boundary = hashes.length; basis = "no_repair_found"; }
  if (afterPublication) {
    const firstLater = hashes.findIndex(sha => afterPublication.has(sha));
    if (firstLater >= 0 && firstLater < boundary) { boundary = firstLater; basis = input.final_only ? "platform_push" : "mr_publication"; }
    if (input.final_only && !afterPublication.size && basis === "no_repair_found") basis = "platform_push";
  }
  if (input.final_only && (basis === "no_repair_found" || (basis === "commit_message" && hashes.length === 1)))
    throw new Error("最终 MR 缺少可核实的实现与修复分界，无法计算三类占比");
  const initial = new Set(input.infer_unattributed ? hashes.slice(0, boundary) : [first]);
  const origins = { ...input.origins };
  const origin = (sha: string): CodeOrigin => initial.has(sha) ? "first"
    : origins[sha] === "first" ? "review" : origins[sha] ?? (input.infer_unattributed ? "review" : "other");
  const metric: DeliveryCodeMetric = { version: 1, head, base, first,
    ...(input.infer_unattributed ? { initial_implementation: { end: hashes[boundary - 1], basis } } : {}),
    collected_at: new Date().toISOString(), retained: emptyOrigins(), rework: emptyOrigins(),
    deleted: 0, excluded_files: 0, commits: [] };
  for (const sha of hashes) {
    const [at, ...message] = messages.get(sha)!;
    const guess = input.infer_unattributed && !initial.has(sha) ? inferCommitOrigin(message.join("\n")) : undefined;
    const inferred = guess && origin(sha) !== "pipeline" && (guess.origin === "pipeline" || !origins[sha] || origin(sha) === "other") ? guess : undefined;
    if (inferred) origins[sha] = inferred.origin;
    const nums = numstat(await run(["diff", "--numstat", "-z", "--find-renames", `${sha}^`, sha, "--"]));
    let additions = 0, deletions = 0;
    for (const entry of nums) {
      if (analyticsCodePath(entry.path)) { additions += entry.added; deletions += entry.removed; }
    }
    const category = origin(sha);
    const originEvidence = afterPublication?.has(sha) && inferred?.origin === "review" && !inferred.explicitRepair
      ? [input.final_only ? "平台推送后的修改。提交记录未显示明确的流水线修复依据。" : "初版 MR 发布后的修改。提交记录未显示明确的流水线修复依据。"] : inferred?.evidence;
    metric.commits.push({ sha, at, subject: message[0] ?? "", origin: category, additions, deletions, ...(originEvidence ? { origin_evidence: originEvidence } : {}) });
    if (category !== "first") metric.rework[category] += additions + deletions;
  }
  const paths = await deliveryDiffPaths(run, base, head);
  if (paths.length > 1000) throw new Error("文件超过单任务统计预算，未计入统计");
  for (const entry of paths) {
    const { path, old } = entry;
    if (!analyticsCodePath(path)) { metric.excluded_files++; continue; }
    const patch = await run(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0",
      ...(old ? [`${base}:${old}`, `${head}:${path}`, "--"] : [base, head, "--", path])]);
    const ranges = [...patch.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
    metric.deleted += ranges.reduce((sum, range) => sum + Number(range[1] ?? 1), 0);
    const added = new Set<number>();
    for (const range of ranges) {
      const count = Number(range[3] ?? 1), start = Number(range[2]);
      if (added.size + count > 200_000) throw new Error("代码规模超过统计预算，未计入统计");
      for (let line = start; line < start + count; line++) added.add(line);
    }
    if (!added.size) continue;
    const blame = await run(["--literal-pathspecs", "blame", "--line-porcelain", head, "--", path]);
    let counted = 0;
    for (const match of blame.matchAll(/^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/gm)) {
      if (!added.has(Number(match[2]))) continue;
      if ((afterPublication || input.final_only) && !messages.has(match[1])) {
        throw new Error("部分最终代码来自主提交链之外或合并提交，无法核实三类来源");
      }
      metric.retained[origin(match[1])]++;
      counted++;
    }
    if (counted !== added.size) throw new Error("代码行溯源不完整，未计入统计");
  }
  return metric;
}
