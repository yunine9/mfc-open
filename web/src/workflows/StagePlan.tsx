import type { WorkflowPlanItem, WorkflowStagePlan } from "../api";
import { registryLabels, sourceLabel } from "./model";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/Empty";

export function StagePlan({
  stage,
  selectedItemId,
  onSelectItem,
  onAdd,
}: {
  stage: WorkflowStagePlan;
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
  onAdd: () => void;
}) {
  return <section className="wf-stage-plan" aria-labelledby="wf-stage-plan-title">
    <header>
      <div><span>{stage.phase}</span><h3 id="wf-stage-plan-title">{stage.title}</h3></div>
      <button type="button" className="wf-primary" onClick={onAdd}>＋ 新增</button>
    </header>
    {stage.steps.length > 0 && <p className="wf-stage-contract">
      <strong>阶段契约</strong>{stage.steps.join(" · ")}
    </p>}
    <ol className="wf-plan-items">
      {stage.items.map((item, index) => <PlanItem key={item.id} item={item}
        index={index} active={selectedItemId === item.id}
        onSelect={() => onSelectItem(item.id)} />)}
    </ol>
    {!stage.items.length && <Empty className="border p-5">
      <EmptyTitle>本阶段还没有执行项</EmptyTitle>
      <EmptyDescription>可新增知识、Skill、Agent 或工具。</EmptyDescription>
    </Empty>}
  </section>;
}

function PlanItem({ item, index, active, onSelect }: {
  item: WorkflowPlanItem;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = item.asset_ref;
  return <li>
    <button type="button" className={active ? "active" : ""} onClick={onSelect}>
      <i>{index + 1}</i>
      <span className="wf-plan-copy">
        <span><strong>{item.title}</strong>
          <em className={`wf-source ${item.locked ? "locked" : ""}`}>
            {sourceLabel(item)}</em></span>
        {item.description && <small>{item.description}</small>}
        <span className="wf-plan-meta">
          <b>{item.kind}</b>
          {ref && <b>{registryLabels[ref.registry]} · {ref.version}</b>}
          {item.use && <b>{useModeLabel(item.use.mode)}</b>}
        </span>
      </span>
      <span className="wf-plan-lock" aria-label={item.locked ? "平台锁定" : "可编辑"}>
        {item.locked ? "🔒" : "›"}
      </span>
    </button>
  </li>;
}

function useModeLabel(mode: NonNullable<WorkflowPlanItem["use"]>["mode"]): string {
  if (mode === "available") return "全程可用";
  if (mode === "on_stage_enter") return "进入阶段时";
  if (mode === "before_item") return "指定项之前";
  return "需要时使用";
}
