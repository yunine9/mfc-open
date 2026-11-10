import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { TaskService } from "./taskService.ts";
import { readKnowledgeMaterial, saveKnowledgeMaterial } from "./knowledgeMaterials.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";

export async function domainKnowledgeRoute(request: IncomingMessage, response: ServerResponse, parts: string[], service: TaskService,
  operator: string, readBody: (request: IncomingMessage, limit?: number) => Promise<any>, json: (response: ServerResponse, status: number, value: any) => unknown) {
  try {
    const materialRoot = join(service.options.dataDir, "knowledge-materials");
    if (parts[0] === "knowledge-materials") {
      if (request.method === "POST" && !parts[1]) {
        const body = await readBody(request, 29 * 1024 * 1024), controller = new AbortController();
        const abort = () => controller.abort(); response.once("close", abort);
        try { const { sections, ...material } = await saveKnowledgeMaterial(materialRoot, body, controller.signal); return json(response, 201, { ...material, sections: sections.length }); }
        finally { response.removeListener("close", abort); }
      }
      if (request.method === "GET" && parts[1]) return json(response, 200, readKnowledgeMaterial(materialRoot, parts[1]));
    } else {
      const manager = service.getDomainKnowledgeExtraction();
      if (request.method === "GET" && parts[1]) {
        if (parts[2] === "resources" && parts[3] && !parts[4]) {
          const path = new URL(request.url!, "http://localhost").searchParams.get("path");
          const resource = path ? manager.inspectionResource(parts[1], decodeURIComponent(parts[3]), path) : undefined;
          if (!resource) return json(response, 404, { error: "本次检视的文档资源不存在" });
          response.writeHead(200, { "Content-Type": resource.content_type, "Content-Length": resource.content.length,
            "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" });
          return response.end(resource.content);
        }
        if (parts[2] === "reader" && !parts[3]) return json(response, 200, manager.reader(parts[1]));
        if (parts[2] === "evidence" && !parts[4]) return json(response, 200, parts[3] === undefined
          ? manager.evidencePage(parts[1], new URL(request.url!, "http://localhost").searchParams.get("before") ?? undefined)
          : manager.evidenceEntry(parts[1], parts[3]));
        if (parts[2] === "history" && parts[3] && !parts[4]) return json(response, 200, manager.documentHistory(parts[1], parts[3]));
        if (parts[2] === "work-document" && parts[3] && parts[4] && !parts[5]) return json(response, 200, manager.workDocument(parts[1], parts[3], parts[4]));
      }
      if (request.method === "GET" && parts[1] && parts[2] === "archive" && parts[3] === "preview") return json(response, 200, manager.previewArchive(parts[1]));
      if (request.method === "GET" && !parts[2]) return json(response, 200, parts[1] ? manager.get(parts[1]) : { records: manager.list(), knowledge_target: readKnowledgeRepoConfig(service.options.dataDir) ?? null });
      if (request.method === "POST") {
        const body = await readBody(request, 3 * 1024 * 1024);
        if (!parts[1]) return json(response, 202, manager.create(body, operator));
        const id = parts[1];
        if (parts[2] === "inspection" && parts[3] === "finish") return json(response, 200, manager.finishInspection(id));
        if (parts[2] === "archive" && parts[3] === "refresh") return json(response, 200, await manager.refreshPublications(id, operator));
        if (parts[2] === "source-cleanup") return json(response, 200, await manager.sourceCleanupAction(id, parts[3], body, operator));
        if (parts[2] === "issue") return json(response, 200, manager.setIssueNumber(id, body.issue_no, body.issue_description));
        if (parts[2] === "archive-targets") return json(response, 200, parts[3] === "preview" ? manager.previewArchiveTargets(id, body) : manager.configureArchive(id, body));
        if (parts[2] === "run") return json(response, 202, manager.run(id, body, operator));
        if (parts[2] === "resume") return json(response, 202, manager.resume(id, operator, body.use_latest_skill === true,
          body.request_id === undefined && body.message === undefined ? undefined : { request_id: body.request_id, message: body.message }));
        if (parts[2] === "stop") return json(response, 200, manager.stop(id));
        if (parts[2] === "delete") return json(response, 200, manager.remove(id, operator));
        if (parts[2] === "reextract") return json(response, 202, manager.reextract(id, operator));
        if (parts[2] === "edit") return json(response, 200, manager.edit(id, body, operator));
        if (parts[2] === "proposal") return json(response, 200, manager.decide(id, body.turn_id, body.document_id, body.decision, operator));
        if (parts[2] === "restore") return json(response, 200, manager.restore(id, body.document_id, body.revision, body.base_revision, operator));
        if (parts[2] === "selection") return json(response, 200, manager.select(id, body.ids, body.selected));
        if (parts[2] === "archive" && parts[3] === "create") return json(response, 200, await manager.createArchive(id, body, operator));
        if (parts[2] === "archive" && parts[3] === "retry") return json(response, 200, await manager.retryArchive(id, operator, body));
        if (parts[2] === "publish") {
          const published = await manager.publish(id, operator, body);
          service.prepareKnowledgeIndex();
          return json(response, 200, published);
        }
      }
    }
    return json(response, 404, { error: "未知知识萃取操作" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识萃取操作失败";
    return json(response, message === "领域萃取任务不存在或已删除" ? 404 : 400, { error: message });
  }
}
