import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "./taskService.ts";
import { readKnowledgeDocument, saveKnowledgeDocument, listKnowledgeDocumentVersions, readKnowledgeDocumentVersion } from "./knowledgeDocuments.ts";
import { readGitKnowledgeResource } from "./knowledgeRepositorySnapshots.ts";
import { knowledgeDocumentCatalog, knowledgeDocumentDirectory, knowledgeDocumentReadRevision, readCatalogKnowledgeDocument } from "./knowledgeDocumentCatalog.ts";

function assertNotResearching(service: TaskService, documentId: string) {
  const domain = service.getDomainKnowledgeExtraction(), component = service.getComponentResearch();
  const activeDomain = domain.list().some(job => ["queued", "running"].includes(job.status)
    && job.documents.some(document => document.knowledge_document_id === documentId));
  const activeComponent = component.list().some(record => ["queued", "running"].includes(record.status)
    && (record.document_id === documentId || record.update_document_id === documentId));
  if (activeDomain || activeComponent) throw new Error("研究进行中：请先停止，或等本轮结束后再改");
}

export async function knowledgeDocumentRoute(request: IncomingMessage, response: ServerResponse, parts: string[], service: TaskService,
  operator: string, readBody: (request: IncomingMessage, limit?: number) => Promise<any>, json: (response: ServerResponse, status: number, value: any) => unknown) {
  const dir = service.options.dataDir, id = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  try {
    if (request.method === "GET" && !id) {
      const view = new URL(request.url!, "http://localhost").searchParams.get("view");
      if (view === "revision" || view === "directory") {
        response.setHeader("Cache-Control", "no-store");
        if (view === "revision") return json(response, 200, { revision: knowledgeDocumentReadRevision(dir) });
        const documents = knowledgeDocumentDirectory(dir);
        return json(response, 200, { documents, revision: knowledgeDocumentReadRevision(dir, documents) });
      }
      const catalog = knowledgeDocumentCatalog(dir);
      const assets = new Map(catalog.assets.map(asset => [asset.id, asset]));
      const documents = catalog.documents.map(({ content, ...doc }) => {
        const asset = assets.get(doc.id);
        return { ...doc, lines: content.split("\n").length, indexing: doc.form === "skill" ? { state: "native" } : !doc.active ? { state: "disabled" }
          : asset ? service.getKnowledgeSearch().documentStatus(asset) : { state: "failed", error: "适用模块已停用，请调整范围。" } };
      });
      return json(response, 200, { documents });
    }
    if (request.method === "GET" && id && parts[2] === "resources") {
      const path = new URL(request.url!, "http://localhost").searchParams.get("path");
      if (!path) throw new Error("请提供文档内的资源相对路径");
      const resource = readGitKnowledgeResource(dir, id, path);
      if (!resource) return json(response, 404, { error: "文档资源不存在或尚未同步" });
      response.writeHead(200, { "Content-Type": resource.content_type, "Content-Length": resource.content.length,
        "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" });
      return response.end(resource.content);
    }
    if (request.method === "POST" && id?.startsWith("kg-") && (parts.length === 2 || parts[2] === "restore")) {
      throw new Error("仓库正式知识请通过开始检视修改，MR 合入后自动同步");
    }
    if (request.method === "GET" && id && parts[2] === "versions") {
      const current = readKnowledgeDocument(dir, id);
      if (id.startsWith("kg-")) {
        if (parts[3] && parts[3] !== current.revision) throw new Error("正式仓库已有新版本，请刷新阅读");
        return json(response, 200, parts[3] ? { document: current, published_at: current.history.at(-1)?.at, operator: current.history.at(-1)?.operator }
          : { versions: [{ revision: current.revision, title: current.title, published_at: current.history.at(-1)?.at, operator: current.history.at(-1)?.operator }] });
      }
      if (parts[3]) {
        const version = readKnowledgeDocumentVersion(dir, id, parts[3]);
        return json(response, 200, { ...version, document: { ...version.document, module_ids: resolveBusinessModuleIds(dir, version.document.module_ids) } });
      }
      return json(response, 200, { versions: listKnowledgeDocumentVersions(dir, id).map(v => ({ revision: v.document.revision,
        title: v.document.title, published_at: v.published_at, operator: v.operator })) });
    }
    if (request.method === "POST" && id && parts[2] === "inspection") {
      const body = await readBody(request, 256 * 1024);
      return json(response, 201, service.getDomainKnowledgeExtraction().beginInspection(id, body, operator));
    }
    if (request.method === "POST" && id && parts[2] === "update-research") {
      const body = await readBody(request, 256 * 1024);
      return json(response, 202, service.getDomainKnowledgeExtraction().beginUpdate(id, body, operator));
    }
    if (request.method === "POST" && id && parts[2] === "restore") {
      assertNotResearching(service, id);
      const body = await readBody(request, 8192);
      if (typeof body.expected_revision !== "string") throw new Error("请提供当前知识版本");
      const old = readKnowledgeDocumentVersion(dir, id, String(body.revision));
      const doc = saveKnowledgeDocument(dir, { ...old.document }, operator, id, { expectedRevision: body.expected_revision, maxContentBytes: 16 * 1024 * 1024 });
      service.prepareKnowledgeIndex(); return json(response, 200, { ...doc, module_ids: resolveBusinessModuleIds(dir, doc.module_ids) });
    }
    if (request.method === "GET" && id && parts.length === 2) {
      const doc = readCatalogKnowledgeDocument(dir, id);
      if (!doc) return json(response, 404, { error: "知识已停用或不存在" });
      return json(response, 200, { ...doc, module_ids: resolveBusinessModuleIds(dir, doc.module_ids) });
    }
    if (request.method === "POST" && id && parts[2] === "retry") {
      const document = readCatalogKnowledgeDocument(dir, id);
      if (!document) return json(response, 404, { error: "知识已停用或不存在" });
      if (!document.active || document.form === "skill") throw new Error("知识已停用或不存在");
      service.prepareKnowledgeIndex();
      return json(response, 202, { ok: true });
    }
    if (request.method === "POST" && id?.startsWith("kd-") && parts.length === 2) {
      assertNotResearching(service, id);
      const body = await readBody(request, 3 * 1024 * 1024);
      const previous = readKnowledgeDocument(dir, id);
      if (typeof body.expected_revision !== "string") throw new Error("请提供编辑时的知识版本，避免覆盖他人修改");
      const input = { ...body, source: body.content !== undefined ? undefined : previous?.source };
      const doc = saveKnowledgeDocument(dir, input, operator, id, { expectedRevision: body.expected_revision });
      service.prepareKnowledgeIndex();
      return json(response, 200, { ...doc, module_ids: resolveBusinessModuleIds(dir, doc.module_ids) });
    }
    return json(response, 404, { error: "未知知识文档操作" });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "知识操作失败" });
  }
}
