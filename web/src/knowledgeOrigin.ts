import type { TaskKnowledgeResource } from "./api";

/** 来源与知识的形态分开；旧记录没有依据时不猜来源。 */
export function knowledgeOrigin(resource: Pick<TaskKnowledgeResource, "scope" | "repository" | "id">): string {
  if (resource.scope === "team" || resource.scope === "module") return "平台";
  if (resource.scope === "repository" || resource.repository || resource.id.startsWith("observed:")) return "代码仓";
  return "来源未记录";
}
