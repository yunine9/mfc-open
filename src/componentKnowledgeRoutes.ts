import { componentKnowledgeArtifacts } from "./componentKnowledgeArtifacts.ts";
import { componentDeletionView, deleteComponentDocuments, retryKnowledgeDeletions } from "./componentKnowledgeDeletion.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "./taskService.ts";
import { componentGovernance } from "./componentKnowledgeGovernance.ts";
import { saveComponentPolicy, addComponentFeedback } from "./componentKnowledgePolicy.ts";

export async function componentKnowledgeRoute(request: IncomingMessage, response: ServerResponse, parts: string[], service: TaskService,
  operator: string, readBody: (r: IncomingMessage, limit?: number) => Promise<any>, json: (r: ServerResponse, status: number, value: any) => unknown) {
  try {
    const dir = service.options.dataDir;
    if (request.method === "GET" && parts.length === 2 && parts[1] === "documents") return json(response, 200, componentDeletionView(dir));
    if (request.method === "GET" && parts.length === 1) {
      const challenges = service.getComponentResearch().list().filter(r => r.challenge && !r.deleted_at).map(r => ({
        id: r.id, challenge: r.challenge, status: r.status, stage: r.stage, draft: r.draft, error: r.error, created_at: r.created_at,
      }));
      return json(response, 200, { ...componentGovernance(dir), challenges });
    }
    if (request.method === "GET" && parts.length === 3 && parts[2] === "artifacts") return json(response, 200, componentKnowledgeArtifacts(dir, parts[1]));
    if (request.method !== "POST") return json(response, 404, { error: "未知组件知识操作" });
    const input = await readBody(request, 16384);
    if (parts.length === 2 && parts[1] === "delete") return json(response, 200, await deleteComponentDocuments(dir, input.documents, operator, service.getKnowledgeSearch()));
    if (parts.length === 2 && parts[1] === "retry-deletions") return json(response, 200, await retryKnowledgeDeletions(dir, service.getKnowledgeSearch()));
    if (parts[1] === "sample") return json(response, 200, await service.sampleComponentKnowledge(String(input.task_id ?? "")));
    const item = componentGovernance(dir).items.find(r => r.id === parts[1]);
    if (!item) throw new Error("组件条目已不存在或源知识已停用，请刷新");
    if (input.source_digest !== item.source_digest) throw new Error("源知识已更新，请刷新后操作");
    if (parts[2] === "policy" && item.kind !== "rule") throw new Error("知识是否可用由源文档控制，此处仅设置代码检查");
    if (parts[2] === "policy") return json(response, 200, saveComponentPolicy(dir, item.id, item.source_digest, input, operator));
    if (parts[2] === "feedback") return json(response, 200, addComponentFeedback(dir, { ...input, item_id: item.id }, operator));
    if (parts[2] === "challenge") return json(response, 202, service.getComponentResearch().startChallenge({
      item_id: item.id, source_digest: item.source_digest, language: item.paradigm.language,
      repository_ids: item.paradigm.evidence.map(e => e.repository_id),
      claim: JSON.stringify({ need: item.paradigm.need, component: item.paradigm.component, api: item.paradigm.api,
        applicability: item.paradigm.applicability, replaces: item.paradigm.replaces, rule: "rule" in item ? item.rule : undefined }),
    }, operator));
    return json(response, 404, { error: "未知组件知识操作" });
  } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
}
