import { readArtifact } from "./artifacts.ts";
import { readCurrentStory } from "./overallStoryStore.ts";

/** 新分析写全局 Story；旧现场仍可读取 CHAIN。只返回既有安全阅读器认可的文档。 */
export function readRequirementPlan(cwd: string | undefined, ticket: string) {
  if (!cwd) return undefined;
  for (const name of [`${ticket}/story.md`, `${ticket}/CHAIN-${ticket}.md`]) {
    const artifact = readArtifact(cwd, name);
    if (artifact) return { ...artifact, source_document: name.endsWith("/story.md")
      ? "story.md" as const : "chain" as const };
  }
  return undefined;
}

/** 确认后的设计以已发布 Story 为准；分析工作副本不反向改写任务编排。 */
export function currentRequirementPlan(task: {
  workspace: string; ticket?: string; id: string;
  requirement_graph?: { stage: string; source_document?: string };
}, cwd: string | undefined) {
  if (task.requirement_graph?.stage === "confirmed"
      && task.requirement_graph.source_document === "story.md") {
    const content = readCurrentStory(task.workspace);
    if (content) return { content, source_document: "story.md" as const };
  }
  return readRequirementPlan(cwd, task.ticket ?? task.id);
}
