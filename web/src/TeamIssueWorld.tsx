/**
 * 团队问题页·当前现场面板(2026-09-11 排版对齐:两域共用 App 的
 * TeamWorldTabs 页签骨架,本组件=概览+现场,成果档案拆到下方
 * TeamIssueArchive 由页签挂载;原型五稿确认形态折入)。
 *
 * 概览/队列复用需求侧 team-delivery-overview / task-section /
 * task-filters 的既有 class 体系(两域同一套版式,视觉零新债);卡片
 * 复用 TeamIssueCard(TaskOverviewRow 行形态)。概览数据走 teamOps 的
 * issueDeliveryBreakdown(与需求侧 teamDeliveryBreakdown 同构口径),
 * 阶段格出注册表全集、0 计数置灰(与需求侧同规则)。
 *
 * 特性总账表(2026-09-18 原型四稿拍板折入):首行=全部特性总账,默认
 * 只显首行,展开逐特性一行横向对比;口径走 issueFeatureRows(按业务
 * 模块聚合,与概览总数同一口径,module 空白归「未分类」)。特性行点击
 * 进概览格筛选(f:<module> 前缀),与阶段/状态格同一套单选格语义。
 *
 * 队列筛选三件套与需求侧同款(搜索/现场范围/责任人),语义按问题域
 * 映射(f637a70 确认口径):需要处理=等你答复+异常;停滞中=推进中且
 * 超过 STALE_AFTER_MS 无进展;推进中=排队+AI 处理中;等你答复不含
 * 待验证(环境验证单列)。概览格筛选(阶段/状态)与之叠加生效。
 */
import { cn } from "cn";
import { useMemo, useRef, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  type IssueStatus,
  type IssueSummary,
} from "./api";
import { TeamIssueCard } from "./issues/TeamIssueCard";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/Empty";
import { Database } from "lucide-react";
import { STALE_AFTER_MS, ISSUE_DELIVERY_STAGE_BUCKETS, isIssueVerifying, issueDeliveryBreakdown, issueFeatureKey, issueFeatureRows, issueStageBucketMatch, type IssueDeliveryBreakdown, type IssueFeatureRow } from "./teamOps";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

/** 问题现场范围(需求侧 TeamScope 的问题域映射,选项语义见文件头)。
 *  verify 档(2026-09-19):环境验证卡在场的会话——等的是验证不是
 *  答复(通过无需作答,MR 全部合入即视为通过,ADR-0034),从「等你
 *  答复」里拆出来单列。 */
type IssueScope = "all" | "action" | "stale" | "wip" | "waiting" | "verify";

const SCOPE_STALE_AFTER_MS = STALE_AFTER_MS;

function inScope(issue: IssueSummary, scope: IssueScope, now: number): boolean {
  if (scope === "action") {
    return ["waiting_user", "idle", "failed"].includes(issue.status);
  }
  if (scope === "stale") {
    return ["queued", "running"].includes(issue.status)
      && now - new Date(issue.updated_at).getTime() >= SCOPE_STALE_AFTER_MS;
  }
  if (scope === "wip") return ["queued", "running"].includes(issue.status);
  if (scope === "verify") {
    return isIssueVerifying(issue);
  }
  if (scope === "waiting") {
    return ["waiting_user", "idle"].includes(issue.status)
      && !isIssueVerifying(issue);
  }
  return true;
}

/** 档案结论词表(镜像 IssueBoard 的 issueConclusionText 词汇,档案格
 * 只按 conclusion.kind 分桶——词表收敛后只有三档,ADR-0037)。已取消
 * 不设格(2026-10-13):档案只收已归档会话,已取消整页不展示。 */
const CONCLUSION_TILES = [
  { kind: "", label: "全部闭环", tone: "neutral" },
  { kind: "delivered", label: "已交付", tone: "success" },
  { kind: "issue", label: "问题成立", tone: "attention" },
  { kind: "non_issue", label: "非问题", tone: "neutral" },
] as const;

/** 概览格按钮配方(原 .delivery-breakdown-cells button 家族)。 */
const CELL_BASE = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-surface px-[11px] py-1.5 text-left text-text transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:cursor-default disabled:opacity-55";
const CELL_SELECTED = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-primary/60 bg-primary/10 px-[11px] py-1.5 text-left text-primary transition-colors";
/** 指标瓦片语调(原 .history-metric.{tone})。 */
const METRIC_TONE = {
  neutral: "text-muted-foreground",
  active: "text-active",
  attention: "text-attention",
  success: "text-success",
  danger: "text-danger",
} as const;

/** 一次率显示口径(瓦片与总账表列共用):null/缺席=分母 0,显示 —。 */
/** 特性总账表(2026-09-18 原型四稿拍板折入):首行=全部特性总账,
 * 默认只显首行,展开逐特性一行横向对比(推进中降序,issueFeatureRows
 * 已排好)。首行任意处或箭头按钮切换展开;特性行点击=概览格筛选
 * (f:<module>,与阶段/状态格同一套单选格语义,联动下方现场)。
 * (2026-09-20 修订,ADR-0045):一次定位/一次验证/一次解决等交付质量
 * 比率撤到交付分析「DTS」页签,这里只留过程计数——指挥页管推进,
 * 复盘页管质量。 */
function FeatureLedger({ rows, stats, cell, onSelectCell }: {
  rows: IssueFeatureRow[];
  stats: IssueDeliveryBreakdown;
  cell: string;
  onSelectCell: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return <section aria-label="特性总账" className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="border-b border-line bg-surface-2/70 text-left text-[12.5px] text-muted-foreground">
          <th scope="col" className="px-3 py-1.5 font-semibold">特性</th>
          <th scope="col" className="px-3 py-1.5 text-right font-semibold">推进中</th>
          <th scope="col" className="px-3 py-1.5 text-right font-semibold">待答复</th>
          <th scope="col" className="px-3 py-1.5 text-right font-semibold">需介入</th>
          <th scope="col" className="px-3 py-1.5 text-right font-semibold">已闭环</th>
          <th scope="col" className="px-3 py-1.5 text-right font-semibold">合计</th>
        </tr>
      </thead>
      <tbody>
        <tr className={cn("border-b border-line/60 transition-colors",
          rows.length > 0 && "cursor-pointer hover:bg-primary/5")}
          onClick={() => rows.length > 0 && setOpen((value) => !value)}>
          <td className="px-3 py-2">
            <span className="flex items-center gap-1.5 font-semibold text-text-strong">
              <button type="button" aria-expanded={open}
                aria-label={open ? "收起特性明细" : `展开全部 ${rows.length} 个特性`}
                disabled={rows.length === 0}
                className="grid size-5 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-default disabled:opacity-40"
                onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>
                <svg viewBox="0 0 16 16" aria-hidden
                  className={cn("size-3.5 transition-transform", open && "rotate-180")}>
                  <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              全部特性
              <span className="text-[12px] font-normal text-muted-foreground">{rows.length} 个特性</span>
            </span>
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums">{stats.advancing}</td>
          <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", stats.waiting > 0 && "text-attention")}>{stats.waiting}</td>
          <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", stats.failed > 0 && "text-danger")}>{stats.failed}</td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-success">{stats.closed}</td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums">{stats.total}</td>
        </tr>
        {open && rows.map((row) => {
          const selected = cell === `f:${row.module}`;
          return <tr key={row.module}
            className={cn("cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-primary/5",
              selected && "bg-primary/10")}
            aria-pressed={selected}
            onClick={() => onSelectCell(`f:${row.module}`)}>
            <td className={cn("max-w-[320px] truncate py-2 pl-10 pr-3",
              selected ? "font-semibold text-primary" : "text-text-strong")}>{row.module}</td>
            <td className="px-3 py-2 text-right font-semibold tabular-nums">{row.advancing}</td>
            <td className={cn("px-3 py-2 text-right tabular-nums", row.waiting > 0 && "font-semibold text-attention")}>{row.waiting}</td>
            <td className={cn("px-3 py-2 text-right tabular-nums", row.failed > 0 && "font-semibold text-danger")}>{row.failed}</td>
            <td className="px-3 py-2 text-right tabular-nums text-success">{row.closed}</td>
            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{row.total}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </section>;
}

export function TeamIssueWorld({ issues }: {
  issues: IssueSummary[];
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<IssueScope>("all");
  const [owner, setOwner] = useState("");
  /** 概览格筛选:"p:<阶段>" | "s:<状态>" | "f:<特性>"(空=不筛),与
   * 需求侧阶段/状态格同机制;f: 来自特性总账表的特性行点击(单选格
   * 语义,与阶段/状态互斥,联动下方现场)。 */
  const [cell, setCell] = useState("");
  const queueRef = useRef<HTMLElement>(null);
  const now = Date.now();

  const stats = useMemo(() => issueDeliveryBreakdown(issues), [issues]);
  const featureRows = useMemo(() => issueFeatureRows(issues), [issues]);
  // 现场队列只收处理中的会话:已闭环/已取消都不进现场(已取消在团队
  // 页整页不展示,2026-10-13;与需求侧 isCurrentTeamTask 的现场口径
  // 同构)——概览格计数(active)与队列行数因此严格一致,点格见几行
  // 就是几行。
  const active = useMemo(() => issues.filter((issue) =>
    issue.status !== "canceled" && issue.status !== "archived"), [issues]);
  const owners = useMemo(() =>
    [...new Set(active.map((issue) => issue.account))], [active]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => active.filter((issue) => {
    if (cell) {
      if (cell.startsWith("s:")) {
        const status = cell.slice(2);
        if (!(status === "waiting_user"
          ? issue.status === "waiting_user" || issue.status === "idle"
          : issue.status === status)) return false;
      } else if (cell.startsWith("f:")) {
        if (issueFeatureKey(issue) !== cell.slice(2)) return false;
      } else {
        // 阶段格键是团队页合并/拆分口径(准备中=两阶段、待验证=卡在场),
        // 与概览计数同一谓词,点格见几行就是几行。
        const bucket = ISSUE_DELIVERY_STAGE_BUCKETS.find(
          (entry) => entry.key === cell.slice(2));
        if (!bucket || !issueStageBucketMatch(bucket, issue)) return false;
      }
    }
    if (scope !== "all" && !inScope(issue, scope, now)) return false;
    if (owner && issue.account !== owner) return false;
    if (needle) {
      const haystack = `${issue.title} ${issue.ticket ?? ""} ${issue.account}`
        .toLocaleLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
    // now 刻意不进依赖:筛选语义跟渲染帧走,与需求侧同款(每次渲染重算)。
  }), [active, cell, scope, owner, needle]);
  const anyFilter = Boolean(cell || query || scope !== "all" || owner);

  /** 点概览格:选中/取消 + 联动滚动到队列(与需求侧 selectPhase 同款)。 */
  function selectCell(next: string) {
    setCell((current) => current === next ? "" : next);
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  const statusCell = (key: string, count: number) => (
    <button type="button" key={key}
      className={cell === `s:${key}` ? CELL_SELECTED : CELL_BASE}
      disabled={count === 0} aria-pressed={cell === `s:${key}`}
      aria-controls="team-issue-queue" onClick={() => selectCell(`s:${key}`)}>
      <span>{ISSUE_STATUS_TEXT[key as IssueStatus]}</span>
      <strong>{count}</strong>
    </button>
  );
  // 阶段格标签:团队页合并/拆分口径(准备中/待验证单列),就地取
  // BUCKETS 的标签——格键不是注册表阶段词,不走 issueStageText。
  const stageCell = (key: string, count: number) => {
    const bucket = ISSUE_DELIVERY_STAGE_BUCKETS.find(
      (entry) => entry.key === key);
    return (
      <button type="button" key={key}
        className={cell === `p:${key}` ? CELL_SELECTED : CELL_BASE}
        disabled={count === 0} aria-pressed={cell === `p:${key}`}
        aria-controls="team-issue-queue" onClick={() => selectCell(`p:${key}`)}>
        <span>{bucket?.label ?? key}</span>
        <strong>{count}</strong>
      </button>
    );
  };

  return <>
    <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="问题处理概览">
      <header className="flex items-center justify-between gap-8 px-5 py-[18px]">
        <div className="grid min-w-0 gap-[3px]">
          <h2 className="m-0 text-lg text-text-strong">问题处理概览</h2>
          <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">首行是全部特性的总账，展开逐特性对比；点击特性行或阶段/状态格可筛选下方现场。</p>
        </div>
        <div className="flex flex-none items-center gap-[18px]"
          aria-label={`问题总数 ${stats.total} 项，推进中 ${stats.advancing} 项，待答复 ${stats.waiting} 项，需介入 ${stats.failed} 项，已闭环 ${stats.closed} 项`}>
          <span className="grid min-w-[62px] justify-items-end gap-0.5" title="不含已取消会话"><strong>{stats.total}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">问题总数</small></span>
          <i aria-hidden className="h-[30px] w-px bg-line" />
          <span className="grid min-w-[62px] justify-items-end gap-0.5" title="排队启动中 + AI 处理中"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-active">{stats.advancing}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">推进中</small></span>
          <i aria-hidden className="h-[30px] w-px bg-line" />
          <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className={cn("text-[25px] leading-none tracking-[-0.035em] tabular-nums text-active", stats.waiting && "text-attention")}>{stats.waiting}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">待答复</small></span>
          <i aria-hidden className="h-[30px] w-px bg-line" />
          <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className={cn("text-[25px] leading-none tracking-[-0.035em] tabular-nums text-text-strong", stats.failed && "text-danger")}>{stats.failed}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">需介入</small></span>
          <i aria-hidden className="h-[30px] w-px bg-line" />
          <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-success">{stats.closed}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">已闭环</small></span>
          <i aria-hidden className="h-[30px] w-px bg-line" />
        </div>
      </header>
      <div className="grid gap-3 border-t border-line bg-surface-2/70 px-5 pt-[15px] pb-[18px]">
        <FeatureLedger rows={featureRows} stats={stats} cell={cell}
          onSelectCell={selectCell} />
        <section aria-labelledby="issue-delivery-stage-title" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
          <div className="grid gap-0.5"><strong id="issue-delivery-stage-title" className="text-[13.5px] text-text-strong">阶段</strong>
            <small className="text-[13px] text-muted-foreground">当前所处流程</small></div>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
            {stats.stages.map((entry) => stageCell(entry.key, entry.count))}
          </div>
        </section>
        <section aria-labelledby="issue-delivery-status-title" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
          <div className="grid gap-0.5"><strong id="issue-delivery-status-title" className="text-[13.5px] text-text-strong">任务状态</strong>
            <small className="text-[13px] text-muted-foreground">当前运行情况</small></div>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
            {stats.statuses.map((entry) => statusCell(entry.key, entry.count))}
          </div>
        </section>
      </div>
    </section>

    <section className="mt-1" id="team-issue-queue" ref={queueRef}
      aria-labelledby="team-issue-queue-title">
      <div className="mb-3 flex items-baseline justify-between gap-4"><div>
        <h2 id="team-issue-queue-title" className="text-lg font-bold text-text-strong">当前现场</h2></div>
        <span className="text-[13px] font-medium tabular-nums text-muted-foreground">
          {anyFilter ? "已筛选 · " : ""}{visible.length} / {active.length} 项
        </span>
      </div>
      <div className="my-[13px] mb-[11px] flex items-center gap-[7px] rounded-[11px] border border-line bg-surface/90 p-2" aria-label="筛选问题现场">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 px-[9px]"><svg viewBox="0 0 18 18" aria-hidden className="size-[15px] fill-none stroke-faint stroke-[1.5]"><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索问题、单号或负责人" className="min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0" /></label>
        <Select value={scope}
          items={[{ value: "all", label: "全部现场" }, { value: "action", label: "需要处理" }, { value: "stale", label: "停滞中" }, { value: "wip", label: "推进中" }, { value: "waiting", label: "等你答复" }, { value: "verify", label: "待验证" }]}
          onValueChange={(value) => setScope((value ?? "all") as IssueScope)}>
          <SelectTrigger className="min-w-28" aria-label="现场范围"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">全部现场</SelectItem>
              <SelectItem value="action">需要处理</SelectItem>
              <SelectItem value="stale">停滞中</SelectItem>
              <SelectItem value="wip">推进中</SelectItem>
              <SelectItem value="waiting">等你答复</SelectItem>
              <SelectItem value="verify">待验证</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={owner}
          items={[{ value: "", label: "全部责任人" },
            ...owners.map((name) => ({ value: name, label: name }))]}
          onValueChange={(value) => setOwner(value ?? "")}>
          <SelectTrigger className="min-w-28" aria-label="责任人"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="">全部责任人</SelectItem>
              {owners.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        {anyFilter && <button type="button"
          className="h-[34px] cursor-pointer rounded-[7px] border-0 bg-primary/10 px-[11px] text-[13px] font-bold text-primary"
          onClick={() => { setQuery(""); setScope("all"); setOwner(""); setCell(""); }}>
          清除筛选</button>}
      </div>
      {visible.length === 0 && <Empty className="py-11" role="status">
        <EmptyTitle>{anyFilter ? "没有匹配的问题会话" : "还没有处理中的问题会话"}</EmptyTitle>
        <EmptyDescription>{anyFilter ? "换关键词或清除筛选再看，会话没有丢。" : "登记问题或从 DTS 拉单后，现场会出现在这里。"}</EmptyDescription>
      </Empty>}
      <div className="grid gap-2">{visible.map((issue) => (
        <TeamIssueCard key={issue.id} issue={issue} />
      ))}</div>
    </section>
  </>;
}

/** 成果档案·问题闭环(2026-09-11 排版对齐:骨架镜像需求侧 HistoryBoard
 * ——history-board + history-intro + history-metrics + 空态同款
 * board-empty;行仍用 TeamIssueCard,需求侧档案是逐任务表格行、问题侧
 * 是会话卡,内容差异,版式同构)。交付质量比率(一次定位/一次验证等,
 * ADR-0045 撤出本域)经 onOpenDeliveryAnalytics 页内直切交付分析
 * 「DTS」页签——团队页签没有独立 URL,不做 href 深链。 */
export function TeamIssueArchive({ issues, onOpenDeliveryAnalytics }: {
  issues: IssueSummary[];
  /** 交付统计跳转(App 层注入:切 deliveryAnalysis 视图并落「DTS」
   * 页签);缺席不渲染入口。 */
  onOpenDeliveryAnalytics?: () => void;
}) {
  // 成果档案·问题闭环:conclusion 维度归档统计,只收已归档会话
  // (已取消整页不展示,2026-10-13)。
  const closed = useMemo(() => issues.filter((issue) =>
    issue.status === "archived"), [issues]);
  const conclusionCount = (kind: string) => kind === ""
    ? closed.length
    : closed.filter((issue) => issue.conclusion?.kind === kind).length;

  return <section className="grid gap-4" aria-label="成果档案·问题闭环">
    <div className="flex items-center justify-between gap-6 rounded-xl border border-line
      bg-surface px-6 py-[22px] shadow-xs">
      <div>
        <h2 className="text-lg font-bold text-text-strong">成果档案·问题闭环</h2>
        <p className="mt-[7px] text-sm text-muted-foreground">这里保存已闭环的问题会话；处理中的回到「当前现场」查看。</p>
      </div>
      {onOpenDeliveryAnalytics && <button type="button" onClick={onOpenDeliveryAnalytics}
        className="flex-none text-[13px] font-normal text-primary underline-offset-2 hover:underline"
        title="一次定位率/一次验证率/一次解决率等交付质量比率在交付分析「DTS」页签">交付统计 →</button>}
    </div>
    {closed.length === 0
      ? <Empty className="min-h-[360px] border" role="status">
          <EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia>
          <EmptyTitle>还没有闭环的问题会话</EmptyTitle>
          <EmptyDescription>非问题结论、修复交付的会话，收口后都会归档到这里。</EmptyDescription>
        </Empty>
      : <>
        <div className="mb-4 grid grid-cols-2 gap-2.5 min-[1081px]:grid-cols-4" aria-label="问题闭环结论统计">
          {CONCLUSION_TILES.map((tile) => (
            <div key={tile.kind || "all"}
              className={`flex min-h-[94px] flex-col justify-between rounded-lg border border-line bg-surface px-[15px] py-3.5 shadow-xs ${METRIC_TONE[tile.tone]}`}>
              <span className="flex items-center gap-[7px] text-[13px] font-semibold">
                <i aria-hidden className="size-2 rounded-full bg-current" />{tile.label}</span>
              <strong className="text-[27px] leading-none tabular-nums text-text-strong">{conclusionCount(tile.kind)}</strong>
            </div>
          ))}
        </div>
        <div className="grid gap-2">{closed.map((issue) => (
          <TeamIssueCard key={issue.id} issue={issue} />
        ))}</div>
      </>}
  </section>;
}
