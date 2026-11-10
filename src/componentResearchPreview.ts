import type { ComponentPipelineState } from "./componentResearchPipeline.ts";

export interface ComponentWorkDocument {
  id: string;
  title: string;
  content: string;
  status_label: string;
}

/** 盘点和规划已保存到研究状态；阅读时展开，不把过程结果混入正式指南。 */
export function componentWorkDocuments(pipeline?: ComponentPipelineState, summaryOnly = false): ComponentWorkDocument[] {
  return (pipeline?.tasks ?? []).flatMap(task => {
    const result = task.result;
    if (!["inventory", "plan"].includes(task.phase) || !result?.findings.trim()) return [];
    const metadata = { id: task.id, title: task.phase === "inventory" ? "功能组件分析" : `${task.title} · 场景规划`,
      status_label: { done: "已通过独立评审", running: "研究中", failed: "等待重试", pending: "等待继续研究" }[task.status] };
    if (summaryOnly) return [{ ...metadata, content: "" }];
    const entries = task.phase === "inventory"
      ? result.components?.map(component => `### ${component.title}\n\n${component.scope}`)
      : result.paradigms?.map(paradigm => `### ${paradigm.title}\n\n${paradigm.need}`);
    return [{
      ...metadata,
      content: [`# ${task.phase === "inventory" ? "功能组件分析" : task.title}`, result.findings,
        ...(entries?.length ? [task.phase === "inventory" ? "## 功能组件" : "## 使用场景", ...entries] : [])].join("\n\n"),
    }];
  });
}
