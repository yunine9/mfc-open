import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { KnowledgeAnswerError, type KnowledgeAnswers } from "./knowledgeAnswers.ts";
import type { KnowledgeAnswerRecord } from "./knowledgeAnswerTypes.ts";
import { knowledgeAnswerSourceCatalog } from "./knowledgeAnswerSources.ts";
import type { KnowledgeSearch } from "./knowledgeSearch.ts";
import { join } from "node:path";
import { readKnowledgeMaterialImage } from "./knowledgeMaterials.ts";

type Json = (response: ServerResponse, status: number, value: unknown) => unknown;
type ReadBody = (request: IncomingMessage, limit?: number) => Promise<any>;

export async function knowledgeAnswerRoute(request: IncomingMessage, response: ServerResponse, parts: string[], answers: KnowledgeAnswers,
  dataDir: string, owner: string, readBody: ReadBody, json: Json, search?: KnowledgeSearch) {
  response.setHeader("cache-control", "no-store");
  try {
    if (request.method === "GET" && parts.length === 2 && parts[1] === "catalog") return json(response, 200, knowledgeAnswerSourceCatalog(dataDir, search));
    if (request.method === "GET" && parts.length === 1) return json(response, 200, { answers: answers.list(owner) });
    if (request.method === "POST" && parts.length === 1) return json(response, 202, answers.create(await readBody(request, 64 * 1024), owner).record);
    const id = decodeURIComponent(parts[1] ?? "");
    if (request.method === "GET" && parts.length === 5 && parts[2] === "evidence" && parts[4] === "image") {
      const record = answers.get(id, owner);
      const evidence = record.evidence.find(item => item.id === parts[3]);
      if (evidence?.kind !== "material" || !evidence.source_id || !evidence.image
          || !record.context?.material_ids?.includes(evidence.source_id))
        return json(response, 404, { error: "本次问答没有读取这张图片" });
      const { asset, content } = readKnowledgeMaterialImage(join(dataDir, "knowledge-materials"), evidence.source_id, evidence.image.path);
      if (asset.id !== evidence.image.digest || asset.mimeType !== evidence.image.mime_type)
        return json(response, 409, { error: "图片与本次查阅时的内容不一致" });
      response.writeHead(200, { "content-type": asset.mimeType, "content-length": content.length,
        "x-content-type-options": "nosniff", "content-disposition": "inline", "cache-control": "private, no-store" });
      return response.end(content);
    }
    if (request.method === "GET" && parts.length === 2) return json(response, 200, answers.get(id, owner));
    if (request.method === "DELETE" && parts.length === 2) {
      answers.remove(id, owner);
      return json(response, 200, { deleted: true });
    }
    if (request.method === "POST" && parts.length === 3 && parts[2] === "cancel") return json(response, 200, answers.cancel(id, owner));
    if (request.method === "POST" && parts.length === 3 && parts[2] === "feedback") return json(response, 200, answers.feedback(id, owner, await readBody(request, 8192)));
    return json(response, 404, { error: "未知知识问答接口" });
  } catch (error) {
    return json(response, error instanceof KnowledgeAnswerError ? error.status : 400, { error: error instanceof Error ? error.message : "知识问答操作失败" });
  }
}

function authenticated(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}

function integrationReply(record: KnowledgeAnswerRecord) {
  const answer = record.status === "done" ? record.answer : undefined;
  const text = answer ? answer.markdown + (answer.unknowns.length
    ? `\n\n还需要确认：\n${answer.unknowns.map(item => `- ${item.replace(/\s+/g, " ").trim()}`).join("\n")}` : "")
    : record.error ?? record.activity.at(-1)?.message ?? "正在查询";
  return { id: record.id, status: record.status, stage: record.stage,
    text,
    ...(answer ? { answer } : {}),
    sources: record.evidence.map(({ content, ...source }) => source), warnings: record.warnings,
    url: `/?kbPage=ask&kbAsk=${encodeURIComponent(record.id)}` };
}

/** 独立的问答入口，插件重试不会重复启动模型；审批插件继续沿用原接口。 */
export async function lubanKnowledgeRoute(request: IncomingMessage, response: ServerResponse, answers: () => KnowledgeAnswers,
  options: { token?: string; accountEnabled: (account: string) => boolean }, readBody: ReadBody, json: Json) {
  response.setHeader("cache-control", "no-store");
  if (!options.token) return json(response, 404, { error: "未配置小鲁班问答接口令牌" });
  if (request.method !== "POST") { response.setHeader("allow", "POST"); return json(response, 405, { error: "只接受 POST" }); }
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const token = first(request.headers["x-mfc-luban-plugin-token"]) ?? first(request.headers.authorization)?.replace(/^Bearer\s+/i, "");
  if (!authenticated(token, options.token)) return json(response, 401, { error: "插件身份校验失败" });
  try {
    const body = await readBody(request, 64 * 1024);
    if (typeof body.sender !== "string" || !/^[A-Za-z0-9._-]{2,48}$/.test(body.sender) || !options.accountEnabled(body.sender)) return json(response, 403, { error: "提问账号不存在或不可用" });
    const service = answers();
    if (body.action === "get") return json(response, 200, integrationReply(service.get(String(body.id ?? ""), body.sender)));
    if (body.action === "evidence") {
      const record = service.get(String(body.id ?? ""), body.sender);
      const evidence = record.evidence.find(source => source.id === body.evidence_id);
      if (!evidence) return json(response, 404, { error: "本次问答中没有该来源" });
      return json(response, 200, evidence);
    }
    if (body.action === "cancel") return json(response, 200, integrationReply(service.cancel(String(body.id ?? ""), body.sender)));
    if (body.action !== "start") return json(response, 400, { error: "action 请选择 start、get、evidence 或 cancel" });
    if (typeof body.message_id !== "string" || !body.message_id.trim() || body.message_id.length > 200 || /[\x00-\x1f]/.test(body.message_id)) return json(response, 400, { error: "请提供有效的消息编号" });
    const result = service.create({ question: body.question, context: body.context }, body.sender, { kind: "luban", message_id: body.message_id });
    return json(response, 202, { ...integrationReply(result.record), replayed: result.replayed });
  } catch (error) {
    return json(response, error instanceof KnowledgeAnswerError ? error.status : 400, { error: error instanceof Error ? error.message : "插件问答操作失败" });
  }
}
