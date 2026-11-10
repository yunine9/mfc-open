import { PersonName } from "../People";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Empty, EmptyContent, EmptyDescription, EmptyTitle } from "@/components/Empty";
import { Badge } from "@/components/ui/badge";
import type { WorkflowAssetSummary } from "../api";
import { technologyStackLabel, type TechnologyStack } from "../technologyStacks";
import { useTechnologyStacks } from "../useTechnologyStacks";
import { statusBadgeVariants, statusLabels } from "./model";

export function WorkflowLibrary({
  workflows,
  loading = false,
  error,
  warnings = [],
  selectedId,
  onSelect,
  onCreate,
  onCopy,
  onRemoveDraft,
  onRefresh,
  notice,
}: {
  workflows: WorkflowAssetSummary[];
  loading?: boolean;
  error?: string;
  warnings?: string[];
  selectedId?: string;
  onSelect: (workflow: WorkflowAssetSummary) => void;
  onCreate?: () => void;
  onCopy?: (workflow: WorkflowAssetSummary) => void;
  onRemoveDraft?: (workflow: WorkflowAssetSummary) => void;
  onRefresh?: () => void;
  notice?: string;
}) {
  const { stacks } = useTechnologyStacks();
  const [scope, setScope] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const activeCount = workflows.filter((item) => item.status !== "archived").length;
  const archivedCount = workflows.length - activeCount;
  const visible = useMemo(() => {
    const wanted = query.trim().toLocaleLowerCase("zh-CN");
    return workflows.filter((item) => (scope === "archived"
      ? item.status === "archived" : item.status !== "archived")
      && (!wanted || `${item.name} ${item.description ?? ""} ${item.owner}`
        .toLocaleLowerCase("zh-CN").includes(wanted)));
  }, [query, scope, workflows]);
  return <section className="wf-library" aria-labelledby="wf-library-title">
    <header className="wf-library-head">
      <div><span className="wf-kicker">配置中心 / 团队工作流</span>
        <h2 id="wf-library-title">工作流</h2>
        <p>普通任务直接使用平台标准方案；这里只管理需要精确编排的专业方案。</p>
      </div>
      {onCreate && <button type="button" className="wf-primary wf-create-button" onClick={onCreate}>
        <span aria-hidden>＋</span>新建工作流</button>}
    </header>
    <div className="wf-library-toolbar">
      {/* (#210)手搓 role=tablist 换 base-ui Tabs 原语;计数徽标 <b> 与
          aria-selected 驱动的旧皮肤原样。 */}
      <Tabs value={scope} className="contents"
        onValueChange={(value) => setScope(value as "active" | "archived")}>
        <TabsList aria-label="工作流范围" className="wf-library-scopes h-auto">
          <TabsTrigger value="active" className="h-auto flex-none">当前工作流 <b>{activeCount}</b></TabsTrigger>
          <TabsTrigger value="archived" className="h-auto flex-none">已归档 <b>{archivedCount}</b></TabsTrigger>
        </TabsList>
      </Tabs>
      {/* (#252)InputGroup 是边框与图标槽的唯一来源,Input 撑满轨道——
          外层勿再套自带边框的搜索容器。 */}
      <InputGroup>
        <InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、说明或 Owner" aria-label="搜索工作流" />
        <InputGroupAddon>
          <svg viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor"
            strokeWidth={1.5}><circle cx="8.5" cy="8.5" r="4.5" />
            <path d="m12 12 4 4" /></svg>
        </InputGroupAddon>
      </InputGroup>
      {onRefresh && <button type="button" className="wf-refresh" disabled={loading}
        onClick={onRefresh} title="刷新工作流" aria-label="刷新工作流">
        <svg viewBox="0 0 20 20" aria-hidden><path d="M15.5 7A6 6 0 1 0 16 12M15.5 3.5V7H12" /></svg>
      </button>}
    </div>
    {notice && <div className="wf-state-banner success" role="status">
      <strong>操作完成</strong><span>{notice}</span></div>}
    {error && <div className="wf-state-banner error" role="alert">
      <strong>工作流读取失败</strong><span>{error}</span>
      {onRefresh && <button type="button" onClick={onRefresh}>重试</button>}
    </div>}
    {warnings.map((warning, index) => <div className="wf-state-banner warning"
      key={`${warning}-${index}`}><strong>部分资产暂不可见</strong><span>{warning}</span></div>)}
    {loading && !workflows.length ? <div className="grid grid-cols-3 gap-3.5 max-sm:grid-cols-1 max-sm:gap-2" aria-label="正在读取工作流">
      {/* #218:占位与旧 .wf-library-skeleton 等价——桌面三张 220px 卡,窄屏单列 94px */}
      <Skeleton className="h-[220px] rounded-2xl max-sm:h-[94px] max-sm:rounded-lg" /><Skeleton className="h-[220px] rounded-2xl max-sm:h-[94px] max-sm:rounded-lg" /><Skeleton className="h-[220px] rounded-2xl max-sm:h-[94px] max-sm:rounded-lg" />
    </div> : visible.length ? <div className="wf-library-grid">
      {visible.map((workflow) => <article key={workflow.id}
        className={selectedId === workflow.id ? "selected" : ""}>
        <button className="wf-workflow-main" type="button" onClick={() => onSelect(workflow)}>
          <span className="wf-workflow-mark" aria-hidden>{workflow.name.trim().slice(0, 1) || "流"}</span>
          <span className="wf-workflow-copy">
            <span className="wf-workflow-title"><strong>{workflow.name}</strong>
              <Badge variant={statusBadgeVariants[workflow.status]}>{statusLabels[workflow.status]}</Badge></span>
            <p>{workflow.description || "暂无说明，打开后可查看精确编排。"}</p>
            {/* 列表直接回答"适用于哪"(审计 P2-14),不逼人点详情 */}
            <span className="wf-workflow-scope">{applicabilityText(workflow, stacks)}</span>
            <span className="wf-workflow-owner">{workflow.scope === "team" ? "团队" : "个人"}
              <i>·</i> Owner <PersonName account={workflow.owner} /><i>·</i>{formatTime(workflow.updated_at)}</span>
          </span>
          <span className="wf-workflow-meta">
            <b>{workflow.latest_version ? `v${workflow.latest_version}` : "未发布"}</b>
            <b>草稿 r{workflow.draft_revision}</b>
          </span>
          <svg className="wf-row-chevron" viewBox="0 0 20 20" aria-hidden>
            <path d="m8 5 5 5-5 5" /></svg>
        </button>
        <footer>
          <span>{workflow.selectable_for_tasks ? "可供新任务选择" : statusHint(workflow)}</span>
          <div>{onCopy && <button type="button" onClick={() => onCopy(workflow)}>复制</button>}
            {onRemoveDraft && workflow.status === "draft" && workflow.latest_version === 0
              && <button type="button" className="wf-text-danger"
                onClick={() => onRemoveDraft(workflow)}>删除草稿</button>}</div>
        </footer>
      </article>)}
    </div> : !loading && !error && <Empty className="min-h-[220px]">
      <EmptyTitle>{query ? "没有匹配的工作流" : scope === "archived"
        ? "没有已归档的工作流" : "还没有专业工作流"}</EmptyTitle>
      <EmptyDescription>{query ? "换一个关键词试试。" : scope === "archived"
        ? "删除的草稿和停止使用的方案会保留在这里。"
        : "普通任务继续使用平台标准方案；有明确编排思路时再创建。"}</EmptyDescription>
      {!query && scope === "active" && onCreate
        && <EmptyContent><button type="button" className="wf-primary" onClick={onCreate}>
        创建第一个工作流</button></EmptyContent>}
    </Empty>}
  </section>;
}

function applicabilityText(workflow: WorkflowAssetSummary, stacks: readonly TechnologyStack[]): string {
  if (workflow.technology_assignment_required) return "待补技术栈关联";
  const scope = workflow.applicability;
  if (!scope) return "适用范围：未声明（旧资产，打开详情查看）";
  const parts = [
    scope.repositories.length && `仓库 ${scope.repositories.join("、")}`,
    scope.technologies.length && `技术栈 ${scope.technologies.map(id => technologyStackLabel(id, stacks)).join("、")}`,
    scope.business_module_ids.length
      && `业务域 ${scope.business_module_ids.join("、")}`,
  ].filter(Boolean) as string[];
  return parts.length ? `适用：${parts.join("；")}` : "适用：不限（全部任务可选）";
}

function statusHint(workflow: WorkflowAssetSummary): string {
  if (workflow.status === "archived") return "已归档，仅保留历史任务";
  if (workflow.technology_assignment_required) return "补充技术栈关联后才能发布";
  if (workflow.status === "pending_review") return "审核通过后可供新任务选择";
  if (workflow.status === "draft") return "发布后可供新任务选择";
  return "当前版本不可用于新任务";
}

function formatTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? value : time.toLocaleDateString("zh-CN", {
    month: "short", day: "numeric", year: "numeric",
  });
}
