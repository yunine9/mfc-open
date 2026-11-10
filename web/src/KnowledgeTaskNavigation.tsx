import { CheckCircle2, ChevronRight, FileText, History } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { value: string; onChange: (value: "progress" | "review") => void; view?: import("../../src/knowledgeProductionTypes").KnowledgeProductionView; disabled?: boolean };

/** 同一任务内切换过程和文稿。放进任务标题行，不再单独占一行——正文阅读面积优先（2026-10-08 用户）。 */
export function KnowledgeTaskTabs({ value, onChange, documentCount, view, disabled = false }: Props & { documentCount: number }) {
  return <nav aria-label="研究过程与文稿" className="knowledge-task-view-tabs">
    <Button size="sm" variant={value === "progress" ? "secondary" : "ghost"} aria-pressed={value === "progress"} disabled={disabled} onClick={() => onChange("progress")}><History size={16} />研究过程</Button>
    <Button size="sm" variant={value === "review" ? "secondary" : "ghost"} aria-pressed={value === "review"} disabled={disabled || !documentCount} onClick={() => onChange("review")}><FileText size={16} />文稿<span className="knowledge-task-document-count">{documentCount}</span></Button>
  </nav>;
}

/** 研究结束后在过程视图提示去审查，不打断正在阅读的文稿。 */
export function KnowledgeTaskReady({ value, onChange, view, disabled = false }: Props) {
  if (value !== "progress" || !view?.navigation.ready_message) return null;
  return <div className="knowledge-task-ready" role="status">
    <CheckCircle2 size={18} /><span>{view.navigation.ready_message}</span>
    <Button size="sm" disabled={disabled} onClick={() => onChange("review")}>{view.navigation.ready_action_label}<ChevronRight size={15} /></Button>
  </div>;
}
