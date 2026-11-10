import type { WorkflowDefinition, WorkflowStagePlan } from "../api";
import { editsForStage } from "./model";

export function StageRail({
  stages,
  definition,
  selectedStageId,
  onSelect,
}: {
  stages: WorkflowStagePlan[];
  definition: WorkflowDefinition;
  selectedStageId: string;
  onSelect: (stageId: string) => void;
}) {
  return <nav className="wf-stage-rail" aria-label="工作流阶段">
    <header><span>阶段</span><small>{stages.length} 个固定阶段</small></header>
    <ol>
      {stages.map((stage, index) => {
        const changed = editsForStage(definition, stage.id).length;
        const active = stage.id === selectedStageId;
        return <li key={stage.id}>
          <button type="button" aria-current={active ? "step" : undefined}
            className={active ? "active" : ""}
            onClick={() => onSelect(stage.id)}>
            <i>{index + 1}</i>
            <span><strong>{stage.title}</strong><small>{stage.phase}</small></span>
            {changed > 0 && <em title={`${changed} 项定制`}>{changed}</em>}
          </button>
        </li>;
      })}
    </ol>
    <footer>阶段顺序与退出条件由平台兜底，不可删除。</footer>
  </nav>;
}
