import { taskProgressTimestamp } from "../../src/taskProgressTime";
import { instantMs } from "./time";

/** 问题会话摘要的"自包含投影":只取适配所需的稳定字符串字段,与
 * api.ts 的 IssueSummary 结构兼容(超出这些字段的传入对象照常通过)。
 * 刻意不 import api.ts——那会把整个浏览器 fetch 客户端拖进根级
 * typecheck 的 Node 类型域,全局 fetch/Response 合并后 json() 推断
 * 翻成 unknown,契约编译全线红(2026-09-01 同步实测)。 */

/** 团队运营只依赖这些稳定字段。保持为自包含结构，根级 typecheck
 * 在测试该纯函数时不必把整个浏览器 API 客户端一并拖进 Node 类型域。 */
export interface TeamTask {
  id: string;
  requirement: string;
  parent_task_id?: string;
  status: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  luban_account?: string;
  progress?: {
    current_phase: string;
    phases: string[];
  };
  focus?: {
    kind: string;
    headline: string;
    next_action: string;
    needs_attention: boolean;
    priority: number;
  };
  delivery?: {
    pipeline?: string;
    loop?: { state: string };
  };
}

export type TeamScope =
  | "all"
  | "action"
  | "stale"
  | "wip"
  | "waiting"
  | "week"
  | "delivered";

const WIP_STATUSES = [
  "queued", "running", "pausing", "verifying", "waiting_for_human",
  "await_merge", "coordinating",
];
const DELIVERED_STATUSES = ["completed"];
const WEEK_MS = 7 * 86_400_000;
const DELIVERY_STATUS_GROUPS = [
  { key: "pending", label: "待开始", statuses: ["queued"] },
  { key: "progressing", label: "推进中", statuses: ["running", "pausing"] },
  {
    key: "action_required", label: "需要处理",
    statuses: ["waiting_for_human", "paused", "failed"],
  },
  { key: "verifying", label: "验证中", statuses: ["verifying"] },
  { key: "await_merge", label: "待合入", statuses: ["await_merge"] },
  { key: "coordinating", label: "子任务推进", statuses: ["coordinating"] },
] as const;

export interface TeamDeliveryBreakdown {
  /** 与交付概览口径一致：只计未取消的主任务。 */
  requirements: number;
  total: number;
  delivered: number;
  delivering: number;
  stages: Array<{ key: string; count: number }>;
  statuses: Array<{ key: string; label: string; count: number }>;
}

/** 团队现场只回答“任务是否还活着”。待合入仍会监听流水线和接收
 * 批注，所以继续留在现场；只有已合入和用户取消离开现场。 */
export function isCurrentTeamTask(task: TeamTask): boolean {
  return ![...DELIVERED_STATUSES, "canceled"].includes(task.status);
}

export function teamDeliveryStatusGroup(status: string): string {
  return DELIVERY_STATUS_GROUPS.find((group) =>
    (group.statuses as readonly string[]).includes(status))?.key ?? "other";
}

/** 团队统计只计算仍有交付意义的任务：已取消留在档案，但不伪装成
 * “交付中”。阶段和状态都必须覆盖同一批交付中任务，各自加总严格
 * 等于 delivering，避免一组算 8 条、另一组只算有 progress 的 6 条。 */
export function teamDeliveryBreakdown(
  tasks: readonly TeamTask[],
): TeamDeliveryBreakdown {
  const delivered = tasks.filter((task) =>
    DELIVERED_STATUSES.includes(task.status));
  const delivering = tasks.filter(isCurrentTeamTask);
  const longestPhases = delivering.reduce<string[]>((longest, task) =>
    (task.progress?.phases.length ?? 0) > longest.length
      ? task.progress!.phases : longest, []);
  const phaseOrder = [...new Set([
    ...longestPhases,
    ...delivering.map((task) => task.progress?.current_phase)
      .filter((phase): phase is string => Boolean(phase)),
  ])];
  const untracked = delivering.filter((task) =>
    !task.progress?.current_phase).length;
  const stages = phaseOrder.map((key) => ({
    key,
    count: delivering.filter((task) =>
      task.progress?.current_phase === key).length,
  }));
  if (untracked) stages.push({ key: "尚未进入阶段", count: untracked });

  const hasOtherStatus = delivering.some((task) =>
    teamDeliveryStatusGroup(task.status) === "other");
  const statuses: TeamDeliveryBreakdown["statuses"] = DELIVERY_STATUS_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    count: delivering.filter((task) =>
      teamDeliveryStatusGroup(task.status) === group.key).length,
  }));
  if (hasOtherStatus) statuses.push({
    key: "other",
    label: "其他",
    count: delivering.filter((task) =>
      teamDeliveryStatusGroup(task.status) === "other").length,
  });
  return {
    requirements: tasks.filter((task) => !task.parent_task_id && task.status !== "canceled").length,
    total: delivered.length + delivering.length,
    delivered: delivered.length,
    delivering: delivering.length,
    stages,
    statuses,
  };
}

function repairStopped(task: TeamTask): boolean {
  const state = task.delivery?.loop?.state;
  return task.status === "verifying" && (
    state === "halted" || state === "exhausted"
    || (task.delivery?.pipeline ?? "").includes("轮询预算耗尽"));
}

export const STALE_AFTER_MS = 2 * 60 * 60_000;

export function responsibleOf(task: TeamTask): string | undefined {
  return task.luban_account;
}

export function isBlocked(task: TeamTask): boolean {
  return task.focus?.kind === "blocked"
    || task.status === "failed" || repairStopped(task);
}

export function needsAction(task: TeamTask): boolean {
  return task.focus?.needs_attention ?? (task.status === "waiting_for_human"
    || task.status === "paused" || isBlocked(task));
}

export function progressAgeMs(task: TeamTask, now = Date.now()): number {
  const at = instantMs(
    taskProgressTimestamp(task),
  );
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

export function isStale(task: TeamTask, now = Date.now()): boolean {
  return ["queued", "running", "pausing", "verifying", "coordinating"]
    .includes(task.status)
    && progressAgeMs(task, now) >= STALE_AFTER_MS;
}

/** 顶部运营指标与明细筛选共用同一把尺，避免“卡上 5 项、点开 4 项”。 */
export function matchesTeamScope(
  task: TeamTask,
  scope: TeamScope,
  now = Date.now(),
): boolean {
  if (scope === "all") return true;
  if (scope === "action") return needsAction(task);
  if (scope === "stale") return isStale(task, now);
  if (scope === "wip") return WIP_STATUSES.includes(task.status);
  if (scope === "waiting") return task.status === "waiting_for_human";
  if (scope === "delivered") return DELIVERED_STATUSES.includes(task.status);
  if (scope === "week") {
    if (!task.completed_at) return false;
    const completed = instantMs(task.completed_at);
    return Number.isFinite(completed)
      && completed >= now - WEEK_MS && completed <= now + 1_000;
  }
  return false;
}

/** 行动项在前,同类里停滞久的在前。 */
export function byTeamAttention(a: TeamTask, b: TeamTask): number {
  const priority = (b.focus?.priority ?? 0) - (a.focus?.priority ?? 0);
  if (priority) return priority;
  const action = Number(needsAction(b)) - Number(needsAction(a));
  if (action) return action;
  return progressAgeMs(b) - progressAgeMs(a);
}

export function cycleTimeMs(task: TeamTask): number | undefined {
  if (!task.completed_at) return undefined;
  const start = instantMs(task.created_at);
  const end = instantMs(task.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

// ---- 问题域交付概览口径(团队页领域切换,与需求侧 teamDeliveryBreakdown 同构) ----

/** 阶段格展示口径(团队页概览,2026-09-20 拍板):拉单+拉仓合并为
 * 「准备中」,「待验证」(环境验证卡在场,ADR-0043:通过无需作答、合入
 * 即通过)从「提交 MR·跑绿」拆出单列。键是概览格键,不是注册表阶段词
 * ——会话进度条与列表卡仍按注册表阶段原样,只有概览格用这个合并/拆分
 * 口径;标签就地声明(格键没有注册表词表,不造第二真相源)。 */
export const ISSUE_DELIVERY_STAGE_BUCKETS = [
  { key: "prep", label: "准备中", stages: ["dts_info", "prep_repo"] },
  { key: "analyze", label: "问题分析", stages: ["analyze"] },
  { key: "fix", label: "问题修复", stages: ["fix"] },
  { key: "mr_green", label: "提交 MR·跑绿", stages: ["mr_green"] },
  { key: "verifying", label: "待验证", verifying: true },
  { key: "conclude", label: "确定结论", stages: ["conclude"] },
] as const;

/** 「待验证」判定(概览格与现场范围共用):环境验证卡在场——卡本身就
 * 是那个状态,不用猜阶段与停机说明。 */
export function isIssueVerifying(issue: {
  status: string;
  gate?: { kind?: string } | null;
}): boolean {
  return issue.status === "waiting_user"
    && issue.gate?.kind === "env_verify";
}

/** 格键 → 会话是否落格:待验证的会话只进「待验证」格,不再重复计入
 * 「提交 MR·跑绿」——阶段格加总恒等于 active。 */
export function issueStageBucketMatch(
  bucket: { stages?: readonly string[]; verifying?: boolean },
  issue: { stage?: string; status: string; gate?: { kind?: string } | null },
): boolean {
  if (isIssueVerifying(issue)) return bucket.verifying === true;
  if (bucket.verifying) return false;
  return (bucket.stages ?? []).includes(issue.stage ?? "");
}

/** 概览状态格全集(展示归一口径:idle 并入 waiting_user——2026-09-08
 * 拍板,卡片/计数/筛选同一归一;archived/canceled 是收口终态,只进
 * 档案不进概览格;挂起已退役,ADR-0048/0057)。标签同样由渲染层取
 * ISSUE_STATUS_TEXT。 */
export const ISSUE_DELIVERY_STATUSES = [
  "queued", "running", "waiting_user", "failed",
] as const;

export interface IssueDeliveryBreakdown {
  /** 问题总数:不含已取消(已取消在团队DTS整页不展示,2026-10-13)。 */
  total: number;
  /** 在途(未收口):总数再剔除已闭环(archived);= 推进中+待答复+
   * 需介入,只作状态格加总不变量的锚,不上瓦片。 */
  active: number;
  /** 推进中:排队+AI 处理中(机器侧),瓦片互斥四份之一。 */
  advancing: number;
  /** 待答复:waiting_user+idle 归一计数(含待验证——合入即通过,
   * 但等待点仍是会话停着等人侧收口);互斥四份之一。 */
  waiting: number;
  /** 异常(需介入);互斥四份之一。 */
  failed: number;
  /** 已闭环(archived);互斥四份之一。四份加和恒等于 total。 */
  closed: number;
  /** 阶段格:团队页合并/拆分口径全集(ISSUE_DELIVERY_STAGE_BUCKETS),
   * 0 计数也出(渲染层置灰禁用,与需求侧"阶段格全量出、0 禁用"同一
   * 规则)——概览始终呈现问题流的完整流程形状。 */
  stages: Array<{ key: string; count: number }>;
  /** 状态格:归一后五状态,0 计数也出(同上)。 */
  statuses: Array<{ key: string; count: number }>;
}

/** 问题域交付概览口径:概览规模数字与阶段/状态格共用同一批会话,与
 * 需求侧 teamDeliveryBreakdown 同构(规模 × 阶段格 × 状态格,供概览格
 * 筛选联动)。瓦片是互斥划分(2026-10-14 拍板):推进中+待答复+
 * 需介入+已闭环 = 问题总数,不再用「处理中」伞口径重复计数。输入是
 * IssueSummary 的稳定字段投影(自包含约束,根级 typecheck 不必拖进
 * 浏览器 fetch 客户端)——「待验证」格读 gate.kind,投影带上闸对象。 */
export function issueDeliveryBreakdown(
  issues: ReadonlyArray<{
    status: string;
    stage?: string;
    gate?: { kind?: string } | null;
  }>,
): IssueDeliveryBreakdown {
  const live = issues.filter((issue) => issue.status !== "canceled");
  const active = live.filter((issue) => issue.status !== "archived");
  const waitingOf = (items: ReadonlyArray<{ status: string }>) =>
    items.filter((issue) =>
      issue.status === "waiting_user" || issue.status === "idle").length;
  return {
    total: live.length,
    active: active.length,
    advancing: active.filter((issue) =>
      issue.status === "queued" || issue.status === "running").length,
    waiting: waitingOf(active),
    failed: active.filter((issue) => issue.status === "failed").length,
    closed: live.filter((issue) => issue.status === "archived").length,
    stages: ISSUE_DELIVERY_STAGE_BUCKETS.map((bucket) => ({
      key: bucket.key,
      count: active.filter((issue) => issueStageBucketMatch(bucket, issue))
        .length,
    })),
    statuses: ISSUE_DELIVERY_STATUSES.map((key) => ({
      key,
      count: key === "waiting_user"
        ? waitingOf(active)
        : active.filter((issue) => issue.status === key).length,
    })),
  };
}

/** 特性(业务模块)归类键:module 空白归「未分类」。DTS 发起即带
 * 模块(特性名强匹配带出或人工改选,ADR-0056),这里只认落盘的
 * module 标签。 */
export function issueFeatureKey(issue: { module?: string }): string {
  return issue.module?.trim() || "未分类";
}

export interface IssueFeatureRow {
  /** 特性名(业务模块标签;空白归「未分类」)。 */
  module: string;
  advancing: number;
  waiting: number;
  failed: number;
  closed: number;
  total: number;
}

/** 特性总账行(概览「特性总账表」,2026-09-18 原型拍板):按业务模块
 * 聚合,指标复用 issueDeliveryBreakdown(与概览瓦片同一互斥口径,
 * 四列加和恒等于合计)。排序:推进中降序 → 总数降序 → 名称,
 * 表格直接渲染不再排。 */
export function issueFeatureRows(
  issues: ReadonlyArray<{ status: string; module?: string }>,
): IssueFeatureRow[] {
  const groups = new Map<string, Array<{ status: string }>>();
  for (const issue of issues) {
    if (issue.status === "canceled") continue;
    const key = issueFeatureKey(issue);
    const bucket = groups.get(key);
    if (bucket) bucket.push(issue);
    else groups.set(key, [issue]);
  }
  return [...groups.entries()].map(([module, items]) => {
    const breakdown = issueDeliveryBreakdown(items);
    return {
      module,
      advancing: breakdown.advancing,
      waiting: breakdown.waiting,
      failed: breakdown.failed,
      closed: breakdown.closed,
      total: breakdown.total,
    };
  }).sort((a, b) => b.advancing - a.advancing || b.total - a.total
    || a.module.localeCompare(b.module, "zh-Hans-CN"));
}

export interface OnceGeneratedFeatureRow {
  module: string;
  /** 交付尝试数:完成交付(含待算/无源码/起算日前)+ 负面原因终止,
   *  与一次解决率环同口径;终止记未解决。 */
  sessions: number;
  /** 一次解决率(定位与验证双一次才算解决;分母=交付尝试)。 */
  solved_rate: number | null;
  /** 会话级达标率(占比 ≥ 达标线的会话占比;仅 ok 行,先行能力字段)。 */
  pass_rate: number | null;
  /** 一次定位率(报告一版过;分母=交付尝试,终止记未定位)。 */
  localization_rate: number | null;
  /** 一次验证率(验证不通过次数=0;分母=交付尝试,终止记未验证)。 */
  verify_rate: number | null;
  /** 行数加权的特性首次生成占比(首轮工作行 ÷ 全部工作行,跨会话
   *  求和后相除;仅 ok 行)。分母 0 → null。 */
  share: number | null;
  total_lines: number;
}

/** 按特性(业务模块标签,空白归「未分类」)聚合:三率(一次解决/
 *  定位/验证)同用交付尝试口径——输入=once-generated 端点的 per_session
 *  全部行(含待算/无源码/起算日前/负面终止),与一次解决率环同分母;
 *  终止行只带特性标签,三率记失败;工作机器事实(ok 行)作分子,键
 *  缺席不作分母豁免。行数/占比仅 ok 行。排序:会话数降序 → 行数降序
 *  → 名称。 */
export function onceGeneratedFeatureRows(
  rows: ReadonlyArray<{
    module: string;
    share?: number;
    pass?: boolean;
    /** 工作机器事实仅 ok 行有(#540 复审可选化:canceled 行缺席);
     *  缺席只影响分子(记失败),分母照进(展示口径,用户拍板)。 */
    localization_pass?: boolean;
    verify_pass?: boolean;
    solved_pass?: boolean;
    lines?: { first: number; rework: number; external: number };
  }>,
): OnceGeneratedFeatureRow[] {
  const groups = new Map<string, {
    sessions: number; solved: number;
    passed: number; ok: number; localization: number; verify: number;
    first: number; total: number;
  }>();
  for (const row of rows) {
    const key = row.module?.trim() || "未分类";
    const bucket = groups.get(key)
      ?? { sessions: 0, solved: 0, passed: 0, ok: 0,
        localization: 0, verify: 0, first: 0, total: 0 };
    bucket.sessions += 1;
    if (row.solved_pass) bucket.solved += 1;
    if (row.localization_pass) bucket.localization += 1;
    if (row.verify_pass) bucket.verify += 1;
    if (row.share !== undefined && row.lines) {
      bucket.ok += 1;
      if (row.pass) bucket.passed += 1;
      bucket.first += row.lines.first;
      bucket.total += row.lines.first + row.lines.rework + row.lines.external;
    }
    groups.set(key, bucket);
  }
  const percent = (value: number, total: number): number | null =>
    total ? Math.round((value / total) * 1000) / 10 : null;
  return [...groups.entries()].map(([module, bucket]) => ({
    module,
    sessions: bucket.sessions,
    solved_rate: percent(bucket.solved, bucket.sessions),
    pass_rate: percent(bucket.passed, bucket.ok),
    localization_rate: percent(bucket.localization, bucket.sessions),
    verify_rate: percent(bucket.verify, bucket.sessions),
    share: percent(bucket.first, bucket.total),
    total_lines: bucket.total,
  })).sort((a, b) => b.sessions - a.sessions || b.total_lines - a.total_lines
    || a.module.localeCompare(b.module, "zh-Hans-CN"));
}

/** 特性树内层的一行:某特性的会话在某仓的工作行合计(ADR-0065;
 *  占比与全局 by_repo 同式,行数加权现算)。三率分子随 ok 行累计,
 *  分母=sessions(仓行只含有交付事实的会话)。 */
export interface FeatureRepoRow {
  repo: string;
  sessions: number;
  /** 一次解决的会话数(定位与验证双一次)。 */
  solved: number;
  /** 一次定位过(报告一版过)的会话数。 */
  localization_passed: number;
  /** 一次验证过(验证零失败)的会话数。 */
  verify_passed: number;
  first: number;
  rework: number;
  external: number;
  total: number;
  share: number | null;
}

/** 特性→仓 工作行树(ADR-0065):输入是 once-generated 端点的 ok 行,
 *  只吃 share/lines 都在场的行(与 onceGeneratedFeatureRows 的行数
 *  口径同一守卫);by_repo 缺席(降级响应/旧端点)时该行只不贡献仓行,
 *  不崩。仓行排序:绑定内的在前、绑定外的沉底(2026-10-21 修订,取代
 *  「绑定外」徽标),各自再按工作行合计降序——原按代码仓页签的排序;
 *  isBound 缺席(模块目录取不到)视为全部绑内,退回纯行数降序。
 *  lines 返回特性层的 首轮/返工/平台外 合计(供合并单列)。 */
export function featureRepoTree(
  rows: ReadonlyArray<{
    module: string;
    share?: number;
    localization_pass?: boolean;
    verify_pass?: boolean;
    solved_pass?: boolean;
    lines?: { first: number; rework: number; external: number };
    by_repo?: ReadonlyArray<{
      repo: string; first: number; rework: number; external: number;
    }>;
  }>,
  isBound?: (feature: string, repo: string) => boolean,
): {
  repos: Map<string, FeatureRepoRow[]>;
  lines: Map<string, { first: number; rework: number; external: number }>;
} {
  const repoBuckets = new Map<string, Map<string, FeatureRepoRow>>();
  const lineTotals = new Map<string, { first: number; rework: number; external: number }>();
  for (const row of rows) {
    if (row.share === undefined || !row.lines) continue; // 非 ok 行不进聚合
    const feature = row.module?.trim() || "未分类";
    const buckets = repoBuckets.get(feature) ?? new Map<string, FeatureRepoRow>();
    for (const entry of row.by_repo ?? []) {
      const bucket = buckets.get(entry.repo) ?? {
        repo: entry.repo, sessions: 0, solved: 0,
        localization_passed: 0, verify_passed: 0,
        first: 0, rework: 0, external: 0, total: 0, share: null,
      };
      bucket.sessions += 1;
      if (row.solved_pass) bucket.solved += 1;
      if (row.localization_pass) bucket.localization_passed += 1;
      if (row.verify_pass) bucket.verify_passed += 1;
      bucket.first += entry.first;
      bucket.rework += entry.rework;
      bucket.external += entry.external;
      bucket.total = bucket.first + bucket.rework + bucket.external;
      bucket.share = bucket.total
        ? Math.round((bucket.first / bucket.total) * 1000) / 10
        : null;
      buckets.set(entry.repo, bucket);
    }
    repoBuckets.set(feature, buckets);
    const totals = lineTotals.get(feature)
      ?? { first: 0, rework: 0, external: 0 };
    totals.first += row.lines.first;
    totals.rework += row.lines.rework;
    totals.external += row.lines.external;
    lineTotals.set(feature, totals);
  }
  const repos = new Map<string, FeatureRepoRow[]>();
  for (const [feature, buckets] of repoBuckets) {
    const unbound = (row: FeatureRepoRow) => !(isBound?.(feature, row.repo) ?? true);
    repos.set(feature, [...buckets.values()].sort((a, b) =>
      Number(unbound(a)) - Number(unbound(b))
      || b.total - a.total
      || a.repo.localeCompare(b.repo, "zh-Hans-CN")));
  }
  return { repos, lines: lineTotals };
}
