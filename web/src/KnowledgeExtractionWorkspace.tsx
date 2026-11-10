import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useKnowledgeStudio } from "./KnowledgeStudioContext";
import { KnowledgeBackButton } from "./KnowledgeBackButton";

export function KnowledgeExtractionStages({ value, onChange, label, codeOnly = false }: { value: string; onChange: (value: string) => void; label: string; codeOnly?: boolean }) {
  const studio = useKnowledgeStudio();
  function choose(next: string) {
    const kind = codeOnly ? "component" : "domain", params = new URLSearchParams(location.search), id = params.get("kbKind") === kind ? params.get("kbTask") : null;
    if (studio && id && next === "review" && studio.view === "workbench") studio.openResult(kind, id);
    else if (studio && id && next === "progress" && studio.view === "knowledge") studio.openExecution(kind, id);
    onChange(next);
  }
  return <nav className="knowledge-extraction-stages mb-4 flex gap-2" aria-label={label}>{[["inputs", "资料"], ["progress", "萃取过程"], ["review", "文稿审查"], ["publish", "Git 归档"]].map(([key, title]) => <Button key={key} size="sm" aria-pressed={value === key} variant={value === key ? "secondary" : "ghost"} onClick={() => choose(key)}>{title}</Button>)}</nav>;
}

export function KnowledgeExtractionWorkspace({ title, sidebar, children, onNew, onClose, backLabel = "知识文档", actions, hideHeader = false, codeOnly = false }: {
  hideHeader?: boolean; codeOnly?: boolean; title: string; sidebar?: ReactNode; children: ReactNode; onNew?: () => void; onClose?: () => void; backLabel?: string; actions?: ReactNode;
}) {
  const studio = useKnowledgeStudio();
  return <section className="tw-root knowledge-extraction-workspace" aria-label={`${title}工作区`}>
    {!hideHeader && <header className="knowledge-extraction-header">
      {onClose && <KnowledgeBackButton onClick={onClose} destination={backLabel} />}
      <div className="mr-auto"><h2 className="text-lg font-semibold">{title}</h2></div>
      {actions}{onNew && <Button onClick={() => { if (studio) studio.openExecution(codeOnly ? "component" : "domain"); onNew(); }}>＋ 新建萃取任务</Button>}
    </header>}
    <div className={`knowledge-extraction-body${sidebar ? " has-sidebar" : ""}`}>
      {sidebar && <aside className="knowledge-extraction-jobs" aria-label="萃取任务列表">{sidebar}</aside>}
      <div className="knowledge-extraction-content">{children}</div>
    </div>
  </section>;
}
