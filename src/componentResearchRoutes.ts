import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "./taskService.ts";
import {
  componentRepositories,
  saveComponentRepository,
} from "./componentRepositories.ts";
export async function componentResearchRoute(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  service: TaskService,
  operator: string,
  readBody: (r: IncomingMessage, limit?: number) => Promise<any>,
  json: (r: ServerResponse, status: number, value: any) => unknown,
) {
  try {
    if (parts[0] === "component-repositories") {
      if (request.method === "GET")
        return json(response, 200, {
          components: componentRepositories(service.options.dataDir),
        });
      if (request.method === "POST")
        return json(
          response,
          200,
          saveComponentRepository(
            service.options.dataDir,
            await readBody(request, 16384),
            operator,
          ),
        );
    } else {
      const research = service.getComponentResearch();
      if (request.method === "GET" && parts[1]) {
        if (parts[2] === "reader" && !parts[3]) return json(response, 200, research.reader(parts[1]));
        if (parts[2] === "evidence" && !parts[4]) return json(response, 200, parts[3] === undefined
          ? research.evidencePage(parts[1], new URL(request.url!, "http://localhost").searchParams.get("before") ?? undefined)
          : research.evidenceEntry(parts[1], parts[3]));
        if (parts[2] === "history" && parts[3] && !parts[4]) return json(response, 200, research.sectionHistory(parts[1], parts[3]));
        if (parts[2] === "work-document" && parts[3] && !parts[4]) return json(response, 200, research.workDocument(parts[1], parts[3]));
      }
      if (parts[1] && parts[2] === "archive") {
        const manager = service.getDomainKnowledgeExtraction();
        const current = () => {
          const record = research.get(parts[1]);
          if (record.deleted_at) throw new Error("萃取任务已删除");
          if (!record.document_id && !record.update_document_id) throw new Error("请先发布组件知识，再归档当前正式版本");
          return record;
        };
        if (parts[3] === "targets") {
          const record = current();
          const preview = manager.previewComponentArchive({ research_id: record.id,
            knowledge_document_id: record.document_id ?? record.update_document_id! }, operator);
          if (request.method === "GET" && !parts[4]) return json(response, 200, manager.componentArchive(record.id));
          if (request.method === "POST" && (!parts[4] || parts[4] === "preview") && !parts[5]) {
            const body = await readBody(request, 1024 * 1024);
            return json(response, 200, parts[4] === "preview" ? manager.previewArchiveTargets(preview.job_id, body) : manager.configureArchive(preview.job_id, body));
          }
        }
        if (request.method === "GET" && parts[3] === "preview" && !parts[4]) {
          const record = current();
          return json(response, 200, manager.previewComponentArchive({ research_id: record.id,
            knowledge_document_id: record.document_id ?? record.update_document_id!,
            knowledge_revision: undefined }, operator));
        }
        if (request.method === "POST" && ["create", "retry"].includes(parts[3]) && !parts[4]) {
          const body = await readBody(request, 1024 * 1024);
          // 正式版本在请求体读取期间也可能变化；归档管理器按预览版本再次校验。
          const record = current();
          const preview = manager.previewComponentArchive({ research_id: record.id,
            knowledge_document_id: record.document_id ?? record.update_document_id!, knowledge_revision: undefined }, operator);
          const result = parts[3] === "create"
            ? await manager.createArchive(preview.job_id, body, operator)
            : await manager.retryArchive(preview.job_id, operator, body);
          return json(response, 200, result);
        }
        return json(response, 404, { error: "未知组件归档操作" });
      }
      if (request.method === "GET" && parts[1] && parts[2] === "artifacts") return json(response, 200, research.artifacts(parts[1]));
      if (request.method === "GET" && parts[1] && parts[2] === "document") {
        const content = research.markdown(parts[1]);
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="component-guide.md"', "cache-control": "no-store" });
        return response.end(content);
      }
      if (request.method === "POST" && parts[1] && ["edit-section", "proposal", "restore-section", "begin-update"].includes(parts[2])) {
        const body = await readBody(request, 3 * 1024 * 1024);
        const result = parts[2] === "edit-section" ? research.editSection(parts[1], body, operator)
          : parts[2] === "proposal" ? research.decideProposal(parts[1], body.turn_id, body.decision, operator)
          : parts[2] === "restore-section" ? research.restoreSection(parts[1], body.section_id, body.revision, body.base_revision, operator)
          : research.beginUpdate(parts[1], operator);
        return json(response, 200, result);
      }
      if (request.method === "POST" && parts[1] && parts[2] === "selection") {
        const input = await readBody(request, 1024 * 1024);
        return json(response, 200, research.selectSections(parts[1], input.ids, input.selected));
      }
      if (request.method === "POST" && parts[1] && parts[2] === "review") {
        return json(response, 202, research.review(parts[1], await readBody(request, 128 * 1024), operator));
      }
      if (request.method === "POST" && parts[1] && parts[2] === "publish" && !parts[3]) {
        const published = research.publish(parts[1], await readBody(request, 24 * 1024 * 1024), operator);
        service.prepareKnowledgeIndex();
        return json(response, 200, published);
      }
      if (request.method === "POST" && parts[1] && ["stop", "delete", "retry", "reextract"].includes(parts[2])) {
        const result = parts[2] === "stop" ? research.stop(parts[1]) : parts[2] === "delete" ? research.remove(parts[1], operator)
          : parts[2] === "reextract" ? research.reextract(parts[1], operator) : research.retry(parts[1], operator);
        return json(response, parts[2] === "reextract" ? 202 : 200, result);
      }
      if (request.method === "GET")
        return json(
          response,
          200,
          parts[1] ? research.get(parts[1]) : { records: research.list(true) },
        );
      if (request.method === "POST" && !parts[1])
        return json(
          response,
          202,
          research.start(await readBody(request, 8192), operator),
        );
    }
    return json(response, 404, { error: "未知组件知识操作" });
  } catch (error) {
    return json(response, 400, {
      error: error instanceof Error ? error.message : "组件知识操作失败",
    });
  }
}
