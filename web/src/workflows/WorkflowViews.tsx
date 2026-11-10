import type {
  WorkflowAssetCatalogItem,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowExecutionProfile,
  WorkflowStandardBase,
  WorkflowStagePlan,
} from "../api";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/Empty";
import {
  assetKey,
  operationLabels,
  registryLabels,
  sourceLabel,
  stageAssetRefs,
} from "./model";

export function FinalPlanView({
  stages,
  diagnostics = [],
  preview = false,
}: {
  stages: WorkflowStagePlan[];
  diagnostics?: WorkflowDiagnostic[];
  /** 没拿到服务端编译产物时必须亮明身份:这是本地即时预览,资产解析
   * 与降级裁决发生在下单时——预览冒充编译产物撞"呈现必须与实际一致"
   * 红线(2026-08-30 审计 P0-5)。 */
  preview?: boolean;
}) {
  return <section className="wf-overview" aria-labelledby="wf-final-title">
    <header><div><span>{preview ? "最终方案（本地预览）" : "最终方案"}</span>
      <h3 id="wf-final-title">{preview
        ? "编排预览——非编译产物" : "Agent 实际执行的单一方案"}</h3></div>
      <em>{stages.reduce((sum, stage) => sum + stage.items.length, 0)} 个执行项</em>
    </header>
    {preview && <p className="wf-preview-banner">
      这是当前编排的即时预览。真正作用于 Agent 的方案在下单时由服务端
      按任务范围解析资产并编译定格；无法安全应用的单项届时会明确降级。
    </p>}
    {diagnostics.length > 0 && <div className="wf-diagnostics">
      {diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}
        className={diagnostic.severity}>
        <strong>{diagnostic.severity === "error" ? "未能应用" : "已回退"}</strong>
        <span>{diagnostic.message}</span>
        {diagnostic.fallback && <small>{diagnostic.fallback}</small>}
      </p>)}
    </div>}
    <div className="wf-final-stages">
      {stages.map((stage, index) => <article key={stage.id}>
        <header><i>{index + 1}</i><span><strong>{stage.title}</strong><small>{stage.phase}</small></span>
          <em>{stage.items.length} 项</em></header>
        <ol>{stage.items.map((item) => <li key={item.id}>
          <span><strong>{item.title}</strong><small>{sourceLabel(item)}</small></span>
          {item.locked && <b>锁定</b>}
        </li>)}</ol>
      </article>)}
    </div>
  </section>;
}

export function WorkflowDiffView({
  definition,
  base,
}: {
  definition: WorkflowDefinition;
  base: WorkflowStandardBase;
}) {
  return <section className="wf-overview" aria-labelledby="wf-diff-title">
    <header><div><span>变更清单</span><h3 id="wf-diff-title">相对平台标准方案的精确修改</h3></div>
      <em>{definition.edits.length} 项变更</em>
    </header>
    {!definition.edits.length ? <Empty className="py-9">
      <EmptyTitle>当前与平台标准方案完全一致</EmptyTitle>
      <EmptyDescription>保存后仍可作为一个明确版本复用。</EmptyDescription>
    </Empty> : <ol className="wf-diff-list">
      {definition.edits.map((edit) => {
        const stage = base.stages.find((candidate) => candidate.id === edit.stage_id);
        const targetId = "target_id" in edit ? edit.target_id : undefined;
        const target = targetId
          ? stage?.items.find((item) => item.id === targetId)
          : undefined;
        const added = "item" in edit ? edit.item : undefined;
        return <li key={edit.edit_id}>
          <b className={`op-${edit.op}`}>{operationLabels[edit.op]}</b>
          <span><strong>{stage?.title ?? edit.stage_id}</strong>
            <small>{describeEdit(edit.op, target?.title, added?.title)}</small></span>
          <code>{edit.edit_id}</code>
        </li>;
      })}
    </ol>}
  </section>;
}

export function DependencyView({
  stages,
  catalog,
  manifest = [],
  preview = false,
}: {
  stages: WorkflowStagePlan[];
  catalog: WorkflowAssetCatalogItem[];
  manifest?: WorkflowExecutionProfile["asset_manifest"];
  /** 无任务定格 manifest 时,状态列是"当前货架"而非"任务固定"事实。 */
  preview?: boolean;
}) {
  const dependencies = new Map<string, {
    ref: ReturnType<typeof stageAssetRefs>[number];
    stages: string[];
  }>();
  for (const stage of stages) {
    for (const ref of stageAssetRefs(stage)) {
      const key = assetKey(ref);
      const item = dependencies.get(key);
      if (item && !item.stages.includes(stage.title)) item.stages.push(stage.title);
      if (!item) dependencies.set(key, { ref, stages: [stage.title] });
    }
  }
  return <section className="wf-overview" aria-labelledby="wf-dependency-title">
    <header><div><span>依赖</span><h3 id="wf-dependency-title">版本、来源与可用状态</h3></div>
      <em>{dependencies.size} 个固定依赖</em>
    </header>
    {preview && dependencies.size > 0 && <p className="wf-preview-banner">
      下表状态是当前货架的实时可用性。下单时会按任务的仓库/技术栈/业务域
      重新解析并固定到任务里，届时的结果以任务详情为准。
    </p>}
    {!dependencies.size ? <Empty className="py-9">
      <EmptyTitle>没有额外资产依赖</EmptyTitle>
      <EmptyDescription>当前方案只使用平台标准执行项。</EmptyDescription>
    </Empty> : <div className="wf-dependency-table" role="table">
      <div className="head" role="row"><b>资产</b><b>精确版本</b><b>使用阶段</b><b>状态</b></div>
      {[...dependencies.entries()].map(([key, dependency]) => {
        const asset = catalog.find((candidate) => assetKey(candidate.ref) === key);
        const state = manifest.find((item) => assetKey(item) === key);
        const available = state ? state.state === "available"
          : asset?.availability !== "unavailable";
        return <div key={key} role="row">
          <span><strong>{asset?.title ?? dependency.ref.id}</strong>
            <small>{registryLabels[dependency.ref.registry]}</small></span>
          <span><b>{dependency.ref.version}</b>
            <small title={dependency.ref.digest}>{dependency.ref.digest.slice(0, 10)}</small></span>
          <span>{dependency.stages.join("、")}</span>
          <span><em className={available ? "available" : "unavailable"}>
            {available ? "可用" : "不可用"}</em>
            {(state?.diagnostic || asset?.warning) &&
              <small>{state?.diagnostic ?? asset?.warning}</small>}</span>
        </div>;
      })}
    </div>}
  </section>;
}

function describeEdit(op: keyof typeof operationLabels, target?: string, item?: string): string {
  if (op === "add") return `新增“${item ?? "执行项"}”`;
  if (op === "remove") return `移除“${target ?? "执行项"}”`;
  if (op === "replace") return `将“${target ?? "执行项"}”替换为“${item ?? "新执行项"}”`;
  if (op === "move") return `调整“${target ?? "执行项"}”的顺序`;
  return `配置“${target ?? "执行项"}”的使用时机或明确指令`;
}
