/**
 * 团队知识使用效能(只读)。
 *
 * 2026-09-01 拆分:资产管理(上架/审核/沉淀候选)搬去 KnowledgeAssets,
 * 这里只剩"看数"。原因是两件事的心智完全不同——一边要动手裁决,一边
 * 是只读观察,挤在一根竖轴上谁都看不清,而且管理区一展开就把统计顶到
 * 屏外。2026-10 团队资产视图拆散后,它是"交付分析"下的一个页签。
 *
 * #226 去 legacy:knowledge-flywheel/rank/ranking/opportunities 容器配方
 * 工具类化;指标格(四格大数)与资产榜的列结构原样保留,只换皮。
 */

import { useEffect, useMemo, useState } from "react";
import type { ComponentProps } from "react";
import { Database, Check, RotateCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/Empty";
import { Spinner } from "@/components/Spinner";
import { cn } from "cn";
import type {
  KnowledgeInsightResource,
  KnowledgeKind,
  TeamKnowledgeInsights,
} from "./api";
import { getKnowledgeInsights } from "./api";

const KIND_LABEL: Record<KnowledgeKind, string> = {
  rules: "项目规则",
  document: "模块知识",
  skill: "Skill",
};

/** 资产榜种类徽标(原 .knowledge-rank.kind-* 色板 1:1 收编)。 */
const KIND_VARIANT: Record<KnowledgeKind, ComponentProps<typeof Badge>["variant"]> = {
  rules: "merge",
  document: "warning",
  skill: "success",
};

function repositoryName(value?: string): string {
  if (!value) return "未标注仓库";
  const clean = value.replace(/\/+$/, "");
  return clean.split("/").at(-1)?.replace(/\.git$/i, "") || value;
}

function latest(value?: string): string {
  if (!value) return "尚未主动访问";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `最近 ${date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  })}`;
}

const MIN_SAMPLE_TASKS = 3;

function ResourceRow({ resource }: { resource: KnowledgeInsightResource }) {
  const reach = resource.provided_tasks > 0
    ? Math.round(resource.accessed_tasks / resource.provided_tasks * 100) : 0;
  const thin = resource.provided_tasks < MIN_SAMPLE_TASKS;
  return <article
    className="grid min-h-[62px] min-w-0 grid-cols-[66px_minmax(140px,1fr)_118px_132px_86px]
      items-center gap-2.5 rounded-[9px] border border-transparent bg-muted
      p-2.5 transition-colors hover:border-line-strong hover:bg-surface
      max-[1180px]:grid-cols-[66px_minmax(140px,1fr)_118px_132px]">
    <Badge variant={KIND_VARIANT[resource.kind]}
      className="w-fit">{KIND_LABEL[resource.kind]}</Badge>
    <div className="grid min-w-0 gap-0.5">
      <strong title={resource.path} className="truncate text-sm
        text-foreground">{resource.name}
        {thin && <Badge variant="neutral" title={`只在 ${resource.provided_tasks} 个任务里出现过,消费率还说明不了问题`}
          className="ml-1.5 align-middle">样本不足</Badge>}
      </strong>
      <span title={`${resource.repository ?? "团队级"} · ${resource.path}`}
        className="truncate font-mono text-[11px] text-faint">
        {resource.description || resource.path}
      </span>
    </div>
    <div className="grid min-w-0 gap-1" title={`${resource.provided_tasks} 个任务可用，${resource.accessed_tasks} 个主动访问`}>
      <span className="h-[5px] overflow-hidden rounded-full bg-surface-3">
        <i style={{ width: `${reach}%` }} className="block h-full min-w-0.5
          rounded-full bg-linear-to-r from-primary to-merge" />
      </span>
      <small className="text-sm tabular-nums text-muted-foreground">{
        resource.accessed_tasks}/{resource.provided_tasks} 任务访问（{reach}%）</small>
    </div>
    <div className="grid grid-cols-[repeat(3,auto_1fr)] items-baseline
      gap-x-0.75 gap-y-0.5">
      <strong className="text-sm tabular-nums text-foreground">{resource.access_events}</strong><small className="text-sm text-faint">访问</small>
      <strong className="text-sm tabular-nums text-foreground">{resource.completed_tasks}</strong><small className="text-sm text-faint">交付</small>
      <strong className={cn("text-sm tabular-nums text-foreground",
        resource.repair_tasks && "text-attention")}>{resource.repair_tasks}</strong><small className="text-sm text-faint">修复</small>
    </div>
    <time dateTime={resource.last_used_at} className="text-right text-sm
      text-faint max-[1180px]:hidden">{latest(resource.last_used_at)}</time>
  </article>;
}

/** 一个分组一个榜:仓库级资源只在本仓任务里被消费,跨仓比绝对量
 * 比的是流量不是价值(用户 2026-08-26 点名),所以按仓分组、组内按
 * 消费率排,样本不足的沉底标注。 */
function ResourceGroup({ title, note, items }: {
  title: string;
  note?: string;
  items: KnowledgeInsightResource[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 5);
  return <div className="mb-2.5">
    <div className="flex items-baseline gap-2.5 border-b border-line
      px-1 pt-2 pb-1">
      <strong className="text-sm tracking-wide text-foreground">{title}</strong>
      {note && <small className="text-sm text-faint">{note}</small>}
      <span className="ml-auto text-sm tabular-nums text-faint">{items.length} 项</span>
    </div>
    <div className="grid gap-1 pt-1">
      {visible.map((item) => <ResourceRow key={item.key} resource={item} />)}
    </div>
    {items.length > 5 && <Button type="button" variant="outline" size="sm"
      className="mt-1.5 w-full border-dashed text-primary"
      onClick={() => setShowAll((current) => !current)}>
      {showAll ? "收起" : `展开全部 ${items.length} 项`}</Button>}
  </div>;
}

/** 面板小标题(排名栏/建议栏共用):标题+说明在左,计数徽标在右。 */
function PanelHead({ title, note, count }: {
  title: string;
  note: string;
  count: string;
}) {
  return <div className="flex min-h-[38px] items-start justify-between gap-3">
    <div className="grid min-w-0 gap-0.5">
      <strong className="text-sm text-foreground">{title}</strong>
      <small className="text-sm/normal text-muted-foreground">{note}</small>
    </div>
    <Badge variant="neutral" className="flex-none">{count}</Badge>
  </div>;
}

export function KnowledgeInsightsBoard({
  insights,
  loading,
  error,
  onRetry,
  onOpenTask,
}: {
  insights?: TeamKnowledgeInsights;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [kind, setKind] = useState<"all" | "document" | "skill">("all");
  // 分组代替跨仓混排:团队级(跨仓资产)一组在前,其余按仓一组一个榜。
  // 组内排序:消费率(读取/装载)优先,样本不足(<3 单)沉底;绝对量只做
  // 次级键——谁的仓单多谁霸榜的老毛病由此消除。
  const groups = useMemo(() => {
    const filtered = (insights?.resources ?? [])
      .filter((item) => kind === "all" || item.kind === kind);
    const byRepo = new Map<string, KnowledgeInsightResource[]>();
    for (const item of filtered) {
      const key = item.scope === "module"
        ? `module:${item.module_id ?? item.module_name ?? "unknown"}`
        : item.repository ?? "";
      const list = byRepo.get(key) ?? [];
      list.push(item);
      byRepo.set(key, list);
    }
    const rate = (item: KnowledgeInsightResource) => item.provided_tasks > 0
      ? item.accessed_tasks / item.provided_tasks : 0;
    const sortGroup = (list: KnowledgeInsightResource[]) => [...list]
      .sort((left, right) => {
        const leftThin = left.provided_tasks < MIN_SAMPLE_TASKS;
        const rightThin = right.provided_tasks < MIN_SAMPLE_TASKS;
        if (leftThin !== rightThin) return leftThin ? 1 : -1;
        return rate(right) - rate(left)
          || right.accessed_tasks - left.accessed_tasks
          || left.name.localeCompare(right.name);
      });
    return [...byRepo.entries()]
      .map(([repo, list]) => ({
        repo,
        items: sortGroup(list),
        activity: list.reduce((sum, item) => sum + item.accessed_tasks, 0),
      }))
      .sort((left, right) => (left.repo === "" ? -1 : right.repo === "" ? 1
        : left.repo.startsWith("module:") && !right.repo.startsWith("module:") ? -1
        : right.repo.startsWith("module:") && !left.repo.startsWith("module:") ? 1
        : right.activity - left.activity
          || left.repo.localeCompare(right.repo)));
  }, [insights, kind]);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  return <section
    className="mt-5.5 mb-6.5 overflow-hidden rounded-2xl border border-line
      bg-surface shadow-(--shadow-xs)"
    aria-labelledby="knowledge-flywheel-title">
    <header className="flex min-h-[92px] items-center justify-between gap-6
      border-b border-line bg-linear-[115deg,var(--accent-soft),var(--surface)_60%]
      px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="grid size-[42px] flex-none
          place-items-center rounded-xl bg-linear-[145deg,var(--merge),var(--ink)]
          text-[17px] font-extrabold text-(--ink-fg)">效</span>
        <div className="min-w-0"><h2 id="knowledge-flywheel-title" className="mt-1 mb-0.5 text-xl font-semibold tracking-tight text-foreground">团队知识效能</h2><p className="m-0 text-sm/relaxed text-muted-foreground">只观察经过沉淀、能跨任务复用的团队资产；任务需求文档留在各自现场。</p></div>
      </div>
      <div className="flex flex-none items-center gap-2.5">
        {insights && <small className="text-sm text-faint">更新于 {latest(insights.generated_at).replace("最近 ", "")}</small>}
        {error && insights && <small className="text-sm text-danger" title={error}>刷新失败，展示上次结果</small>}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}
          disabled={loading} aria-label="刷新知识效能">
          <RotateCwIcon aria-hidden data-icon="inline-start"
            className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")} />
          {loading ? "统计中" : "刷新"}
        </Button>
      </div>
    </header>

    {error && !insights && <div role="alert" className="m-5 flex min-h-28
      flex-col items-start gap-3 rounded-xl border border-dashed
      border-danger/30 bg-danger-soft p-5">
      <strong className="text-[13.5px] text-foreground">知识效能暂时不可用</strong>
      <span className="text-sm text-muted-foreground">{error}</span>
      <Button variant="destructive" size="sm" onClick={onRetry}>重新读取</Button></div>}
    {loading && !insights && <div aria-label="正在统计知识效能"
      className="flex min-h-[138px] items-center justify-center">
      <Spinner className="size-5" /></div>}
    {insights && insights.summary.tracked_tasks === 0 && <Empty className="mx-5 my-5 min-h-[110px] border" role="status"><EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia><EmptyTitle>知识飞轮正在等待第一批数据</EmptyTitle><EmptyDescription>正式模块知识或 Skill 被新任务装载、读取后，这里会出现使用趋势；任务文档和仓库项目规则不会进入团队统计。</EmptyDescription></Empty>}

    {insights && insights.summary.tracked_tasks > 0 && <>
      {/* 指标格:四格大数是这页的定场视觉,列结构不动,只换皮。 */}
      <div aria-label="知识效能摘要"
        className="grid grid-cols-[repeat(4,minmax(0,1fr))] gap-2 border-b
          border-line bg-muted px-5 py-3.5">
        <div className="grid min-h-[74px] min-w-0 grid-cols-[minmax(0,1fr)_auto]
          items-start gap-x-2 gap-y-1 rounded-[10px] border border-line
          bg-surface px-3 py-2.5">
          <span className="text-sm font-bold text-muted-foreground">已追踪任务</span>
          <strong className="row-span-2 text-[27px] leading-none font-semibold
            tabular-nums text-foreground">{insights.summary.tracked_tasks}</strong>
          <small className="text-sm text-faint">采用新知识口径</small>
        </div>
        <div className="grid min-h-[74px] min-w-0 grid-cols-[minmax(0,1fr)_auto]
          items-start gap-x-2 gap-y-1 rounded-[10px] border border-line
          bg-surface px-3 py-2.5">
          <span className="text-sm font-bold text-muted-foreground">主动访问率</span>
          <strong className="row-span-2 text-[27px] leading-none font-semibold
            tabular-nums text-foreground">{insights.summary.access_rate}<em
            className="ml-px text-[13px] not-italic">%</em></strong>
          <small className="text-sm text-faint">{insights.summary.accessed_tasks} 个任务真正读取</small>
        </div>
        <div className="grid min-h-[74px] min-w-0 grid-cols-[minmax(0,1fr)_auto]
          items-start gap-x-2 gap-y-1 rounded-[10px] border border-line
          bg-surface px-3 py-2.5">
          <span className="text-sm font-bold text-muted-foreground">活跃资产</span>
          <strong className="row-span-2 text-[27px] leading-none font-semibold
            tabular-nums text-foreground">{insights.summary.active_resources}</strong>
          <small className="text-sm text-faint">共识别 {insights.summary.unique_resources} 项</small>
        </div>
        <div className={cn("grid min-h-[74px] min-w-0 grid-cols-[minmax(0,1fr)_auto]",
          "items-start gap-x-2 gap-y-1 rounded-[10px] border bg-surface px-3 py-2.5",
          insights.summary.opportunities
            ? "border-attention/30 bg-attention-soft/40"
            : "border-success/25")}>
          <span className="text-sm font-bold text-muted-foreground">改进机会</span>
          <strong className={cn("row-span-2 text-[27px] leading-none",
            "font-semibold tabular-nums",
            insights.summary.opportunities
              ? "text-attention" : "text-success")}>{insights.summary.opportunities}</strong>
          <small className="text-sm text-faint">{insights.summary.selected_unused} 项选而未用</small>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(300px,0.75fr)]
        gap-4.5 px-5 pt-4.5 pb-5 max-[1180px]:grid-cols-1">
        <div className="min-w-0">
          <PanelHead title="可复用资产使用"
            note="这里只统计正式模块知识与 Skill 的真实消费；仓库项目规则和任务文档仍留在各自现场。"
            count={`${total} 项`} />
          <div className="mt-2.5 mb-2 flex items-center justify-between gap-2.5">
            <div role="group" aria-label="按知识类型筛选"
              className="inline-flex gap-0.5 rounded-lg bg-muted p-[3px]">
              {(["all", "document", "skill"] as const).map((value) =>
                <button type="button" key={value}
                  className={cn("rounded-md px-2.5 py-1 text-sm transition-colors",
                    kind === value
                      ? "bg-surface text-primary shadow-(--shadow-xs)"
                      : "text-muted-foreground hover:text-foreground")}
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}>{value === "all" ? "全部" : KIND_LABEL[value]}</button>)}
            </div>
          </div>
          <div className="grid gap-1">
            {groups.map((group) => <ResourceGroup
              key={group.repo || "__team__"}
              title={group.repo.startsWith("module:")
                ? `业务模块 · ${group.items[0]?.module_name ?? group.repo.slice(7)}`
                : group.repo ? repositoryName(group.repo) : "团队级资产（跨仓）"}
              note={group.repo.startsWith("module:")
                ? "Owner 显式发布的模块知识，按任务真实读取统计"
                : group.repo ? "组内按消费率排,受本仓单量影响,不跨仓比较" : undefined}
              items={group.items} />)}
            {total === 0 && <Empty className="border bg-muted/40"><EmptyDescription>当前筛选下还没有知识使用记录。</EmptyDescription></Empty>}
          </div>
        </div>

        <aside className="min-w-0 border-l border-line pl-4.5
          max-[1180px]:mt-4.5 max-[1180px]:border-l-0 max-[1180px]:p-0
          max-[1180px]:pt-4.5 max-[1180px]:border-t">
          <PanelHead title="下一步怎么改"
            note="建议只辅助知识运营，不会自动改仓库或卡住任务。"
            count={`${insights.recommendations.length} 条`} />
          <div className="mt-2.5 grid gap-1.5">
            {insights.recommendations.map((item) => <article
              className={cn("grid grid-cols-[23px_minmax(0,1fr)] gap-2",
                "rounded-[9px] border bg-muted p-2.5",
                item.tone === "attention" ? "border-attention/25"
                  : item.tone === "positive" ? "border-success/25"
                    : "border-line")}
              key={item.id}>
              <i aria-hidden className={cn("grid size-[22px] place-items-center",
                "rounded-[7px] text-sm font-extrabold not-italic",
                item.tone === "positive" ? "bg-success-soft text-success"
                  : item.tone === "attention" ? "bg-attention-soft text-attention"
                    : "bg-merge-soft text-merge")}>{item.tone === "positive" ? "✓" : item.tone === "attention" ? "!" : "i"}</i>
              <div className="grid min-w-0 gap-1">
                <strong className="text-sm/normal text-foreground">{item.title}</strong>
                <p className="m-0 text-sm/normal text-muted-foreground">{item.evidence}</p>
                <small className="text-sm/normal text-faint">{item.action}</small>
                {!!item.task_ids?.length && <div className="mt-0.5 flex flex-wrap
                  items-center gap-1">
                  <span className="text-sm text-faint">相关任务</span>
                  {item.task_ids.map((taskId) => <Button type="button"
                    variant="outline" size="xs" key={taskId}
                    className="font-mono text-xs"
                    onClick={() => onOpenTask(taskId)}>{taskId}</Button>)}
                </div>}
              </div>
            </article>)}
            {insights.recommendations.length === 0 && <Empty className="min-h-[114px] border text-left md:items-start md:text-left"><EmptyMedia variant="icon" className="text-success"><Check aria-hidden /></EmptyMedia><EmptyTitle>暂时没有足够样本形成建议</EmptyTitle><EmptyDescription>继续积累真实任务，不用为了填满面板制造结论。</EmptyDescription></Empty>}
          </div>
        </aside>
      </div>
      <footer className="border-t border-line bg-muted px-5 py-2.5
        text-sm/relaxed text-faint"><Badge variant="merge"
        className="mr-1.5">口径</Badge>任务需求、附件与产出文档只留在单任务现场，项目规则只属于相关仓库；团队页只统计正式模块知识和 Skill，交付结果仅作相关性参考。</footer>
    </>}
  </section>;
}

/** 交付分析页签用的自加载外壳：进页签才读、每分钟刷新一次（读多份任务足迹，不跟任务心跳绑）。 */
export function KnowledgeInsightsPanel({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const [insights, setInsights] = useState<TeamKnowledgeInsights>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => {
    setLoading(true); setError("");
    void getKnowledgeInsights().then(setInsights)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return <KnowledgeInsightsBoard insights={insights} loading={loading} error={error} onRetry={refresh} onOpenTask={onOpenTask} />;
}
