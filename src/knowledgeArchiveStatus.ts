import type { DomainKnowledgeJob } from "./domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "./knowledgeProductionState.ts";
export { currentKnowledgeArchiveBatches } from "./knowledgeProductionState.ts";

export function knowledgeArchiveState(job: DomainKnowledgeJob): "failed" | "running" | "opened" | "done" {
  return projectKnowledgeProduction({ kind: "domain", record: job }).archive.state;
}
