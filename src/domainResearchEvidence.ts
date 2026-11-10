import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function isBusinessKnowledgeEvidence(event: Record<string, unknown>): boolean {
  return (event.tool === "business_knowledge" && event.status === "available")
    || (event.tool === "knowledge_material" && event.status === "returned");
}

export function knowledgeEvidenceTool(records: () => Array<Record<string, unknown>>, observe?: (event: Record<string, unknown>) => unknown) {
  return defineTool({ name: "knowledge_evidence", label: "回查业务资料证据",
    description: "回查本任务主、子 Agent 已取得的业务资料。list 按 query 关键词检索已有查询及返回内容，返回去重后的摘要（start 从 1 开始，count 默认 20，最多 50），包含空结果和失败状态；摘要不是已读正文。read 按 evidence_id 回查检索原文，start/count 按字符分页，默认 8000，最多 16000；上传资料给出原始编号和章节/图片位置，再用 knowledge_material 阅读。省略 action 时，有 evidence_id 则 read，否则 list。记录保留原查询时间，资料更新时仍应重新检索。",
    parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("read")])), query: Type.Optional(Type.String()),
      evidence_id: Type.Optional(Type.String()), start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }),
    async execute(_id: string, params: { action?: "list" | "read"; query?: string; evidence_id?: string; start?: number; count?: number }) {
      if ((params.action ?? (params.evidence_id ? "read" : "list")) === "list") {
        const seen = new Set<string>(), query = params.query?.trim().toLowerCase();
        const matches = records().slice().reverse().filter(event => {
          if (!isBusinessKnowledgeEvidence(event) && !(event.tool === "business_knowledge" && ["empty", "failed"].includes(String(event.status)))) return false;
          const key = String(event.evidence_id ?? JSON.stringify([event.tool, event.action, event.query, event.status, event.error_code]));
          if (seen.has(key)) return false;
          seen.add(key);
          return !query || JSON.stringify(event).toLowerCase().includes(query);
        });
        const start = params.start ?? 1, count = Math.min(params.count ?? 20, 50);
        const entries = matches.slice(start - 1, start - 1 + count).map(event => ({
          evidence_id: event.evidence_id, tool: event.tool, action: event.action, status: event.status, at: event.at, worker_id: event.worker_id,
          query: event.query ? JSON.stringify(event.query).slice(0, 1000) : undefined, material_id: event.material_id, name: event.name, version: event.version,
          preview: JSON.stringify(event.result ?? event.locations ?? event.error ?? "").slice(0, 500),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify({ entries, total: matches.length,
          next_start: start + count <= matches.length ? start + count : undefined }) }], details: {} };
      }
      const event = params.evidence_id ? records().find(e => e.evidence_id === params.evidence_id && isBusinessKnowledgeEvidence(e)) : undefined;
      if (!event) return { content: [{ type: "text" as const, text: "该证据不在本次研究已读取的业务资料中" }], details: {}, isError: true };
      const { result, ...location } = event;
      const text = result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result);
      const start = params.start ?? 1, count = params.count ?? 8000;
      const content = text.slice(start - 1, start - 1 + count);
      if (event.tool === "business_knowledge" && content) observe?.({ tool: "knowledge_evidence", action: "read", evidence_id: event.evidence_id,
        status: "returned", start, end: start + content.length - 1, at: new Date().toISOString() });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...location, ...(text ? { content, total_characters: text.length,
        next_start: start + count <= text.length ? start + count : undefined } : {}) }) }], details: {} };
    },
  });
}

/** 为实际返回的业务资料分配引用编号；相同资料重复读取沿用编号。 */
export function businessKnowledgeEvidenceId(event: Record<string, unknown>): string | undefined {
  if (!isBusinessKnowledgeEvidence(event)) return undefined;
  const source = event.tool === "business_knowledge"
    ? [event.tool, event.action, event.query, event.result]
    : [event.tool, event.material_id, event.digest, event.locations, event.image_path];
  return `knowledge-evidence-${createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 24)}`;
}
