import { contentMetric } from "./deliveryContentMetric.ts";
import { awaitLocalCodeSnapshot, readLocalCodeSnapshot, localCodeSnapshotPending } from "./finalMrLocalSnapshot.ts";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskSummary } from "./taskService.ts";
import { feedbackStamp, historicalRepairIntervals, intervalOrigins, validInterval, type RepairInterval } from "./deliveryAttribution.ts";
import { frozenTaskBaseline } from "./artifacts.ts";
import { analyticsGit, calculateDeliveryCode, finalMrSize } from "./deliveryAnalyticsGit.ts";
import { compareFinalMr, compareWithoutInitialMr } from "./finalMrComparison.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import type { RepositoryProfile } from "./repositoryProfiles.ts";
import { emptyOrigins, type CodeOrigin, type DeliveryAnalysisReport, type DeliveryCodeMetric, type MrComparison, type MrComparisonDetail } from "./deliveryAnalyticsTypes.ts";

interface FinalSizeSample { url: string; head: string; base?: string; counts?: { lines: number; deleted: number } }
interface StoredAnalysis { content_version?: 1; final_size?: FinalSizeSample; version: 1; head: string; metric?: DeliveryCodeMetric; error?: string; attribution?: string; intervals?: RepairInterval[]; comparison?: MrComparison; comparison_key?: string }
type Task = Pick<TaskSummary, "id" | "workspace" | "delivery_generation">;
type CollectionTask = Pick<TaskSummary, "id" | "workspace" | "delivery" | "origin" | "delivery_generation">;
function location(task: Task): string {
  const key = createHash("sha256").update(`${task.workspace}\0${task.id}${task.delivery_generation ? `\0${task.delivery_generation}` : ""}`).digest("hex");
  return join(dirname(task.workspace), ".delivery-analysis", `${key}.json`);
}
function read(task: Task): StoredAnalysis | undefined {
  try {
    const path = location(task);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return;
    const saved = JSON.parse(readFileSync(path, "utf8"));
    return saved.version === 1 ? saved : undefined;
  } catch { return; }
}
function save(task: Task, record: StoredAnalysis): void {
  writeAnalysisFile(location(task), record);
}
function writeAnalysisFile(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("统计目录不能是符号链接");
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

type Delivery = NonNullable<TaskSummary["delivery"]>;
function confirmedDirectHead(delivery?: Delivery): string | undefined {
  const foreign = delivery?.foreign_commits?.base_sha;
  return foreign && foreign === delivery?.merged_sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(foreign) ? foreign : undefined;
}
export function deliveryAnalysisHead(delivery?: Delivery): string | undefined {
  return delivery?.final_mr ? delivery.final_mr.head : confirmedDirectHead(delivery) ?? delivery?.git_push?.sha;
}
export function comparisonKey(delivery?: Delivery) {
  const a = delivery?.initial_mr, b = delivery?.final_mr;
  if (!b) return;
  const versions = [a?.url, a?.head, a?.base, b.url, b.head, b.base];
  if (!a && !delivery?.mr_url && delivery?.git_push?.sha) versions.push(delivery.git_push.sha);
  return createHash("sha256").update(JSON.stringify(versions)).digest("hex");
}
export function hasFinalMrSample(task: TaskSummary, requireUsable = false): boolean {
  const key = comparisonKey(task.delivery), saved = read(task);
  if (!key || saved?.comparison_key !== key || !matchesFinalSize(saved.final_size, task.delivery?.final_mr)) return false;
  const url = task.delivery?.final_mr?.url;
  const local = url ? readLocalCodeSnapshot(task, url) : undefined;
  if (url && localCodeSnapshotPending(task, url)) return false;
  if (local && saved.comparison?.method === "patch" && saved.metric?.content_comparison?.snapshot_hash !== local.hash) return false;
  if (saved.metric?.content_comparison?.reference === "local_snapshot" && saved.metric.content_comparison.snapshot_hash !== local?.hash) return false;
  if (!requireUsable) return saved.comparison?.method !== "patch" || saved.content_version === 1;
  if (!saved.final_size?.counts || !saved.comparison || saved.comparison.method === "unavailable") return false;
  try {
    const file = lstatSync(detailLocation(task, key));
    return file.isFile() && file.size > 0 && file.size <= 2_000_000
      && (saved.comparison.method === "final" ? !task.delivery?.git_push?.sha
        : (saved.comparison.method === "patch" && !!saved.metric?.content_comparison) || saved.metric?.head === task.delivery?.final_mr?.head);
  } catch { return false; }
}
function matchesFinalSize(size?: FinalSizeSample, final?: Delivery["final_mr"]): boolean {
  return !!size && !!final?.head && size.url === final.url && size.base === final.base && size.head === final.head;
}
function metricSize(metric: DeliveryCodeMetric) {
  return { lines: Object.values(metric.retained).reduce((sum, n) => sum + n, 0), deleted: metric.deleted };
}
function detailLocation(task: Task, key: string) { return `${location(task)}.${key}.patch.json`; }
export function readFinalMrComparison(task: TaskSummary, generation?: string): MrComparisonDetail | undefined {
  let scope = task;
  if (generation !== undefined && generation !== (task.delivery_generation ?? "initial")) {
    const prior = task.delivery_history?.find(h => h.id === generation);
    if (!prior) return;
    scope = { ...task, delivery_generation: prior.id === "initial" ? undefined : prior.id, delivery: prior.delivery };
  }
  const key = comparisonKey(scope.delivery), saved = read(scope);
  if (!key || saved?.comparison_key !== key || !saved.comparison || saved.comparison.method === "unavailable") return;
  return readComparisonDetail(scope, key);
}
function readComparisonDetail(task: Task, key: string): MrComparisonDetail | undefined {
  try {
    const path = detailLocation(task, key), stat = lstatSync(path);
    if (!lstatSync(dirname(path)).isDirectory() || !stat.isFile() || stat.size > 2_000_000) return;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return; }
}

function hasSavedPushDetail(task: Task, key: string, summary: MrComparison): boolean {
  const detail = readComparisonDetail(task, key);
  if (detail?.reference !== "platform_push" || !["head", "patch"].includes(detail.comparison_basis)
      || !Array.isArray(detail.files) || typeof detail.truncated !== "boolean" || !summary.files) return false;
  const paths = new Set<string>();
  for (const file of detail.files) {
    if (typeof file?.path !== "string" || typeof file.change_patch !== "string"
        || typeof file.initial_patch !== "string" || typeof file.final_patch !== "string") return false;
    paths.add(file.path);
  }
  if (detail.truncated) return summary.files.some(file => file.changed && paths.has(file.path));
  return summary.files.every(file => !file.changed || paths.has(file.path));
}

/** Only a bounded, explicitly identified repair interval receives a reason.
 * Explicit CI evidence takes priority; missing intervals can use labelled inference. */
export function repairOrigin(loop: NonNullable<TaskSummary["delivery"]>["loop"]): CodeOrigin {
  if (loop?.kind === "ci") return "pipeline";
  if (loop?.kind === "review") return "review";
  return "review";
}

// Cache the evidence used, not just the code version. Old snapshots are upgraded
// once and late repair evidence can update an already sampled push.
function attributionKey(summary: CollectionTask, cwd: string): string {
  const loop = summary.delivery?.loop;
  return JSON.stringify([summary.delivery?.final_mr ? 10 : 9, comparisonKey(summary.delivery), loop?.last_sha, repairOrigin(loop), summary.delivery?.foreign_commits?.base_sha, summary.delivery?.merged_sha, feedbackStamp(cwd)]);
}

function currentInterval(summary: CollectionTask, head: string): RepairInterval {
  return { base: summary.delivery?.loop?.last_sha ?? "", head, origin: repairOrigin(summary.delivery?.loop) as RepairInterval["origin"],
    foreign: summary.delivery?.foreign_commits?.base_sha, evidence: `${repairOrigin(summary.delivery?.loop) === "pipeline" ? "流水线" : repairOrigin(summary.delivery?.loop) === "review" ? "检视" : "其他"}修复轮次 ${summary.delivery?.loop?.round ?? ""}` };
}

/** Persist the small attribution fact before starting best-effort Git work.
 * A process restart or failed sampler must not erase previous repair rounds. */
export function recordDeliveryPublication(summary: TaskSummary, cwd: string | undefined, head: string): void {
  if (summary.origin === "issue") return;
  try {
    const saved = read(summary);
    const interval = currentInterval(summary, head);
    if (validInterval(interval)) {
      const intervals = [...(saved?.intervals ?? [])];
      if (!intervals.some(i => JSON.stringify(i) === JSON.stringify(interval))) intervals.push(interval);
      save(summary, { version: 1, head: saved?.head ?? head, ...saved, intervals });
    }
  } catch { /* Analytics must never block a real push. */ }
  observeDeliveryCode(summary, cwd, head, true);
}

const pending = new Map<string, Promise<void>>();
let lane: Promise<void> = Promise.resolve();
/** Best-effort observer, single Git worker across tasks. Never awaited by the
 * delivery state machine; failed analytics never retries or blocks a task. */
export function observeDeliveryCode(summary: TaskSummary, cwd: string | undefined, head: string, retry = false): void {
  if (summary.delivery?.final_mr) head = summary.delivery.final_mr.head ?? "";
  else if (confirmedDirectHead(summary.delivery)) head = summary.delivery?.git_push?.sha ?? "";
  if (!cwd || !/^[a-f0-9]{40,64}$/.test(head) || summary.origin === "issue"
      || (summary.continuation && summary.continuation.state !== "active")) return;
  const snapshot: CollectionTask = { id: summary.id, workspace: summary.workspace,
    origin: summary.origin, delivery_generation: summary.delivery_generation, delivery: structuredClone(summary.delivery) };
  const attribution = attributionKey(snapshot, cwd);
  const key = `${location(summary)}:${head}:${attribution}`;
  const saved = read(summary);
  if (pending.has(key) || saved?.head === head && saved.attribution === attribution && !retry) return;
  const job = lane.then(async () => {
    try {
      if (snapshot.delivery?.final_mr) await collectFinalMr(snapshot, cwd, head, attribution);
      else await collectDeliveryCode(snapshot, cwd, head);
    }
    catch (error) {
      try { save(snapshot, { ...read(snapshot), version: 1, head, attribution, error: error instanceof Error ? error.message : "统计暂不可用" }); } catch { /* read-side only */ }
    }
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  lane = job;
}
export async function awaitDeliveryAnalytics(): Promise<void> { await lane; }
/** 复用代码目录前，让已开始读取上一轮 Git 现场的统计完成。 */
export async function awaitTaskDeliveryAnalytics(task: Task): Promise<void> {
  const prefix = `${location(task)}:`;
  await Promise.all([...pending].filter(([key]) => key.startsWith(prefix)).map(([, work]) => work));
}

async function collectFinalMr(summary: CollectionTask, cwd: string, head: string, attribution: string) {
  const delivery = summary.delivery!, initial = delivery.initial_mr, final = delivery.final_mr!;
  const key = comparisonKey(delivery)!;
  await awaitLocalCodeSnapshot(summary, final.url);
  const local = readLocalCodeSnapshot(summary, final.url);
  const saved = read(summary);
  const sameComparison = saved?.comparison_key === key;
  const savedMetric = sameComparison && saved.metric?.base === final.base && saved.metric?.head === head ? saved.metric : undefined;
  let comparison: MrComparison;
  try {
    const result = !initial && !delivery.mr_url ? await compareWithoutInitialMr(cwd, final, delivery.git_push?.sha)
      : await compareFinalMr(cwd, { initial: initial ?? {}, final });
    const previous = sameComparison ? saved.comparison : undefined;
    if (previous?.reference === "platform_push" && result.summary.method === "final" && hasSavedPushDetail(summary, key, previous)) {
      // 同一对版本的比较已保存。现场缺少早期证据时，保留原有两版差异。
      comparison = previous;
    } else {
      comparison = result.summary;
      writeAnalysisFile(detailLocation(summary, key), result.detail);
    }
  } catch (e) {
    // Immutable evidence survives workspace reclamation. In particular, an
    // older comparison snapshot may still need its first independent line count.
    comparison = sameComparison && saved.comparison && saved.comparison.method !== "unavailable" ? saved.comparison
      : { method: "unavailable", initial_head: initial?.head, final_head: head, reason: e instanceof Error ? e.message : "缺少比较证据" };
  }
  let metric: DeliveryCodeMetric | undefined;
  let error: string | undefined;
  if (comparison.method === "ancestry" || comparison.method === "final") {
    const boundary = comparison.reference === "platform_push" && comparison.method === "ancestry" ? comparison.initial_head : undefined;
    try { metric = await collectDeliveryCode(summary, cwd, head, boundary); }
    catch (e) {
      if (matchesFinalSize(saved?.final_size, final) && !savedMetric?.content_comparison) metric = savedMetric;
      error = e instanceof Error ? e.message : "无法回溯最终代码的来源";
    }
  } else error = comparison.reason ?? "提交历史不同，已按两份 MR 的代码内容比较，无法按提交归因";

  if (!metric) {
    try {
      if (!local && comparison.method === "ancestry") throw new Error(error ?? "缺少本地快照");
      const reference = local ? "local_snapshot" : comparison.reference === "platform_push" ? "platform_push" : "initial_mr";
      const prior = local ? { head: local.head, base: local.base }
        : { head: comparison.initial_head ?? initial?.head, base: initial?.base ?? await frozenTaskBaseline(cwd) };
      if (!prior.head || !prior.base || !final.base || (!local && comparison.method !== "patch" && comparison.method !== "ancestry")) throw new Error(error ?? "缺少本地快照或可核实的初版版本");
      if (local) {
        const result = await compareFinalMr(cwd, { initial: prior, final, patches: local.patches });
        comparison = { ...result.summary, reference: "local_snapshot" };
        writeAnalysisFile(detailLocation(summary, key), { ...result.detail, reference: "local_snapshot" });
      }
      metric = await contentMetric({ cwd, id: summary.id, base: final.base, head, initial: { head: prior.head, base: prior.base }, snapshot: local,
        reference, intervals: [...(saved?.intervals ?? []), currentInterval(summary, head)].filter(validInterval) });
      error = undefined;
    } catch (e) { error = e instanceof Error ? e.message : "缺少内容比较证据"; }
  }

  if (!metric && savedMetric?.content_comparison && (savedMetric.content_comparison.reference !== "local_snapshot" || local?.hash === savedMetric.content_comparison.snapshot_hash)) {
    metric = savedMetric;
    error = undefined;
  }
  let counts = metric ? metricSize(metric) : matchesFinalSize(saved?.final_size, final) ? saved?.final_size?.counts : undefined;
  // A matching old blame snapshot measured final changed lines even if it did
  // not distinguish a merge through a side branch. Reuse its total only.
  if (!counts && savedMetric) counts = metricSize(savedMetric);
  if (!counts && final.base) {
    try { counts = await finalMrSize(cwd, final.base, head); } catch { /* 缺少 Git 对象不猜行数。 */ }
  }
  save(summary, { version: 1, content_version: 1, head, metric, attribution, error, comparison, comparison_key: key, intervals: saved?.intervals,
    final_size: { url: final.url, head, base: final.base, counts } });
}

export async function collectDeliveryCode(summary: CollectionTask, cwd: string, head: string, confirmedPlatformPush?: string): Promise<DeliveryCodeMetric> {
  const attribution = attributionKey(summary, cwd);
  const priorSample = read(summary);
  const final = summary.delivery?.final_mr;
  // Older final-MR snapshots classified side-branch and some local changes
  // without proving their source. Their counts and real repair intervals survive.
  let previous = final && priorSample?.comparison_key && !priorSample.final_size ? undefined : priorSample?.metric;
  if (previous && final) {
    try { await analyticsGit(cwd, ["merge-base", "--is-ancestor", previous.head, head]); }
    catch { previous = undefined; }
  }
  const publishedHead = head;
  const foreign = confirmedDirectHead(summary.delivery);
  // A direct owner push can be the actual merged source. Do not mistake a
  // squash/target merge commit for it; require the recorded branch tip.
  if (!final && foreign && foreign !== head) {
    try { await analyticsGit(cwd, ["merge-base", "--is-ancestor", head, foreign]); }
    catch { throw new Error("最终合入的外部提交缺失或没有延续平台推送，无法核实代码行与来源"); }
    head = foreign;
  }
  const finalOnly = !!final && !summary.delivery?.initial_mr && !summary.delivery?.mr_url;
  const taskBase = finalOnly ? final.base : final ? summary.delivery?.initial_mr?.base : await frozenTaskBaseline(cwd);
  if (!taskBase) throw new Error("缺少任务创建时的 Git 基线，无法识别首次提交");
  const target = final?.target_branch ?? summary.delivery?.target_branch;
  if (!target) throw new Error("缺少 MR 目标分支，无法确定交付范围");
  await analyticsGit(cwd, ["check-ref-format", `refs/remotes/origin/${target}`]);
  // A same-source refresh must retain the pre-merge comparison base, including
  // after fast-forward/squash merge or a target branch update.
  let base = final?.base ?? (previous?.head === head ? previous.base
    : (await analyticsGit(cwd, ["merge-base", "--all", head, `refs/remotes/origin/${target}`])).trim());
  if (!final && base === head) {
    // A target already at the merged commit has lost the pre-merge base.
    // Without an MR base, a merge on the path may include unrelated target work.
    if (foreign && foreign !== publishedHead && (await analyticsGit(cwd, ["rev-list", "--merges", "-1", `${taskBase}..${head}`])).trim())
      throw new Error("目标已合入且提交链含合并，缺少最终 MR 的合入前基线，无法核实最终行数");
    base = taskBase;
  }
  const origins: Record<string, CodeOrigin> = Object.fromEntries((previous?.commits ?? []).map(c => [c.sha, c.origin]));
  const evidence: Record<string, string[]> = Object.fromEntries((previous?.commits ?? []).filter(c => c.origin_evidence).map(c => [c.sha, c.origin_evidence!]));
  const fallback = await intervalOrigins(cwd, head, [...(final ? [] : [currentInterval(summary, head)]),
    ...(head !== publishedHead ? [{ base: publishedHead, head, origin: "review" as const,
      evidence: "平台推送之后的分支直接修改" }] : []),
  ]);
  for (const [sha, origin] of Object.entries(fallback.origins)) {
    if (!origins[sha] || origins[sha] === "other" || evidence[sha]?.some(text => text.startsWith("推断："))) { origins[sha] = origin; evidence[sha] = fallback.evidence[sha]; }
  }
  const published = await intervalOrigins(cwd, head, read(summary)?.intervals ?? []);
  Object.assign(origins, published.origins);
  const historical = await intervalOrigins(cwd, head, historicalRepairIntervals(cwd, summary.id));
  // Completed feedback facts are more specific than the mutable current loop.
  // Explicit pipeline evidence takes priority over review/default attribution.
  Object.assign(origins, historical.origins);
  Object.assign(evidence, published.evidence, historical.evidence);
  for (const source of [fallback, published, historical]) {
    for (const [sha, origin] of Object.entries(source.origins)) if (origin === "pipeline") { origins[sha] = "pipeline"; evidence[sha] = source.evidence[sha]; }
  }
  const publishedBoundary = final ? confirmedPlatformPush ?? summary.delivery?.initial_mr?.head
    : foreign && foreign !== publishedHead ? summary.delivery?.initial_mr?.head ?? publishedHead : undefined;
  const metric = await calculateDeliveryCode({ cwd, base, head, task_base: taskBase, first: previous?.first, origins,
    infer_unattributed: true, final_only: finalOnly, initial_mr_head: publishedBoundary, repair_commits: [...new Set([
      ...Object.keys(fallback.origins), ...Object.keys(published.origins), ...Object.keys(historical.origins),
      ...(previous?.initial_implementation?.basis === "repair_record" ? previous.commits.filter(c => c.origin !== "first").map(c => c.sha) : []),
    ])] });
  metric.published_head = publishedHead;
  for (const commit of metric.commits) {
    if (commit.origin_evidence) { origins[commit.sha] = commit.origin; evidence[commit.sha] = commit.origin_evidence; }
  }
  // Preserve cumulative events even if the target has absorbed an earlier part.
  if (previous) {
    const commits = new Map(previous.commits.map(c => [c.sha, c]));
    for (const commit of metric.commits) commits.set(commit.sha, commit);
    metric.commits = [...commits.values()];
    metric.rework = emptyOrigins();
    for (const commit of metric.commits) if (commit.origin !== "first") metric.rework[commit.origin] += commit.additions + commit.deletions;
  }
  for (const commit of metric.commits) {
    commit.origin_evidence = commit.origin === "first" ? [metric.initial_implementation?.basis === "repair_record"
      ? "首轮实现：首次实际修复区间之前的提交" : metric.initial_implementation?.basis === "mr_publication"
        ? "首轮实现：初版 MR 发布前的实现提交" : metric.initial_implementation?.basis === "platform_push" ? "首轮实现：平台已推送版本中的实现提交" : metric.initial_implementation?.basis === "commit_message"
        ? "推断：首次明确修复提交之前的首轮实现" : "推断：未发现修复记录或明确修复提交，暂计首轮实现"]
      : evidence[commit.sha] ?? commit.origin_evidence ?? [commit.origin === "other"
        ? "缺少覆盖该提交的修复区间证据" : "此前推送快照保留的分类"];
  }
  if (!final) save(summary, { version: 1, head: publishedHead, metric, intervals: read(summary)?.intervals,
    attribution });
  return metric;
}

/** No Git work in an HTTP request; unavailable history stays visibly unavailable. */
export function buildDeliveryAnalysis(tasks: TaskSummary[], modules: Array<{ id: string; name: string }> = [], repositoryProfiles: RepositoryProfile[] = []): DeliveryAnalysisReport {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const moduleNames = new Map(modules.map(module => [module.id, module.name]));
  const parentIds = new Set(tasks.map(t => t.parent_task_id).filter(Boolean));
  const names = new Map(tasks.map(t => [t.id, t.title || t.requirement.split("\n")[0]]));
  return { generated_at: new Date().toISOString(),
    task_tokens: tasks.filter(task => task.origin !== "issue").map(task => ({ id: task.id, parent_id: task.parent_task_id,
      usage: task.token_usage ? { input_tokens: task.token_usage.input_tokens, output_tokens: task.token_usage.output_tokens, total_tokens: task.token_usage.total_tokens } : undefined })),
    rows: tasks
    .filter(task => task.origin !== "issue" && !parentIds.has(task.id))
    .flatMap(task => [...(task.delivery_history ?? []).map(previous => ({ ...task,
      status: "completed" as const, delivery: previous.delivery,
      delivery_generation: previous.id === "initial" ? undefined : previous.id,
      delivery_started_at: previous.started_at, completed_at: previous.completed_at,
    })), task])
    .map(task => {
      let root: TaskSummary | undefined = task;
      const visited = new Set<string>();
      while (root?.parent_task_id && !visited.has(root.id)) {
        visited.add(root.id); root = byId.get(root.parent_task_id);
      }
      const assigned = root && !root.parent_task_id ? root.business_module : undefined;
      const businessModule = assigned ? { id: assigned.id, name: moduleNames.get(assigned.id) ?? assigned.name } : undefined;
      const repository = repositoryIdentity(task.repo_url ?? "");
      const profile = repository ? [...(task.repository_profiles ?? []), ...repositoryProfiles]
        .find(p => repositoryIdentity(p.repository) === repository && p.technologies.length) : undefined;
      const languages = [...new Set(profile?.technologies ?? [])].filter(language => language !== "agnostic");
      const stored = read(task), head = deliveryAnalysisHead(task.delivery);
      const final = task.delivery?.final_mr, key = comparisonKey(task.delivery);
      const comparison = final ? (stored?.comparison_key === key ? stored?.comparison : undefined)
        ?? { method: "unavailable" as const, initial_head: task.delivery?.initial_mr?.head, final_head: final.head,
          reason: task.workspace_reclaimed_at && !readLocalCodeSnapshot(task, final.url) ? "工作区已回收，缺少本地快照或可读取的历史版本证据" : final.state === "merged" && !final.head ? "代码平台尚未返回最终 MR 的源版本，待版本可读后可刷新数据" : !task.delivery?.initial_mr && !task.delivery?.mr_url ? "尚无最终 MR 的代码改动记录" : "尚无这两份 MR 当前版本的比较证据" } : undefined;
      // 已完成记录可能保留待对账文案；统计合入事实不依赖该文案是否清理。
      const merged = task.status === "completed" && (final ? final.state === "merged" : ["merged", "已合入", "已合入（内核终态待对账）"].includes(task.delivery?.mr_state ?? ""));
      // merged_sha identifies the target commit (different after squash/rebase).
      // Statistics describe the confirmed pushed source, which must still match.
      const exactFinalMetric = final && stored?.comparison_key === key && stored?.metric?.head === head && stored?.metric?.base === final.base ? stored?.metric : undefined;
      const finalSizeMatches = matchesFinalSize(stored?.final_size, final);
      const publishedHead = final ? final.head : task.delivery?.git_push?.sha;
      const metric = (!final || finalSizeMatches && exactFinalMetric && (comparison?.method === "ancestry" || comparison?.method === "final" || comparison?.reference === "platform_push" || exactFinalMetric.content_comparison))
        && head && stored?.metric?.head === head && (stored.metric.published_head ?? stored.metric.head) === publishedHead
        && stored.metric.initial_implementation ? structuredClone(stored.metric) : undefined;
      if (metric) {
        for (const counts of [metric.retained, metric.rework]) {
          counts.review += counts.other; counts.other = 0;
        }
        for (const commit of metric.commits) {
          if (commit.origin === "other") {
            commit.origin = "review";
            commit.origin_evidence = ["后续调整按检视修改统计。记录中没有明确的流水线修复依据。"];
          } else if (commit.origin === "review" && commit.origin_evidence) {
            commit.origin_evidence = commit.origin_evidence.map(note => note.replace("归入检视及其他修改", "归入检视修改"));
          }
        }
      }
      const evidenceMetric = metric ?? exactFinalMetric;
      const size = (finalSizeMatches ? stored?.final_size?.counts : undefined) ?? (evidenceMetric ? metricSize(evidenceMetric) : undefined);
      return { ...(size ? { final_code_lines: size.lines, final_deleted_lines: size.deleted } : {}),
        ...(task.delivery?.final_mr || (task.delivery?.foreign_commits?.count ?? 0) > 0 ? { external_collaboration: true as const } : {}),
        id: task.id, delivery_id: task.delivery_generation ?? "initial", started_at: task.delivery_started_at ?? task.created_at, title: task.title || task.requirement.split("\n")[0], parent_id: task.parent_task_id,
        parent_title: task.parent_task_id ? names.get(task.parent_task_id) : undefined,
        repo: cleanRepository(task.repo_url ?? ""), languages, modules: businessModule ? [businessModule.name] : [], business_module: businessModule,
        merged, completed_at: task.status === "completed" ? task.completed_at : undefined,
        at: task.completed_at ?? task.updated_at ?? task.created_at, mr_url: safeMrUrl(final?.url ?? task.delivery?.mr_url), initial_mr_url: safeMrUrl(task.delivery?.initial_mr?.url), mr_comparison: comparison, metric,
        unavailable: metric ? undefined : final ? comparison?.reason ?? (stored?.comparison_key === key ? stored?.error : undefined) ?? "缺少最终 MR 的代码来源统计" : stored?.metric && stored.metric.head === head && !stored.metric.initial_implementation ? "统计口径已更新，需重新采集首轮实现范围" : stored?.head === publishedHead && stored?.error ? stored.error
          : confirmedDirectHead(task.delivery) && head !== publishedHead ? "尚无最终合入的外部提交所对应的代码统计" : head ? "尚无本次推送的统计快照；历史任务不会猜测归因" : "尚未推送代码" };
    }) };
}
function cleanRepository(value: string): string {
  return value.replace(/(https?:\/\/)[^/@]+@/g, "$1");
}
function safeMrUrl(value?: string): string | undefined {
  try { const url = new URL(value ?? ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return; }
}
