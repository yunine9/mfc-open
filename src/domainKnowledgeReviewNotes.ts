import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { KnowledgeReviewNote } from "./knowledgeReviewNoteTypes.ts";

/** 这里只读当前任务已保存的原意见，本次修订保存的编号决定可读范围。 */
export function readDomainReviewNoteBatch(dataDir: string, jobId: string, noteIds: readonly string[]): KnowledgeReviewNote[] {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(jobId)) throw new Error("知识任务编号无效");
  if (!Array.isArray(noteIds) || !noteIds.length || noteIds.some(id => typeof id !== "string" || !id || id.length > 100)) throw new Error("本批审阅意见编号无效");
  const path = join(dataDir, "knowledge-review", "domain", `${jobId}.json`);
  if (!existsSync(path)) throw new Error("本批审阅意见已不存在，请检查意见记录");
  const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(stored)) throw new Error("批注记录无法读取，请检查存储文件");
  const notes = new Map<string, KnowledgeReviewNote>();
  for (const note of stored) if (note && typeof note === "object" && note.kind === "domain" && note.job_id === jobId && typeof note.id === "string") notes.set(note.id, note);
  return [...new Set(noteIds)].map(id => {
    const note = notes.get(id);
    if (!note || typeof note.note !== "string") throw new Error(`本批审阅意见 ${id} 已不存在，请检查意见记录`);
    return note;
  });
}

export function domainReviewBatchMessage(notes: KnowledgeReviewNote[]): string {
  const counts = (scope: KnowledgeReviewNote["scope"]) => notes.filter(note => note.scope === scope).length;
  return [
    "请根据本批人工审阅意见提出文稿修订建议。沿用意见编号逐条记录结论。先核对最新正文、涉及的来源与上下文；行号是批注时的位置，结合引用原文和前后文定位，已经解决的意见不必重复修改。保留未受影响的内容，必要时同步相关文稿。",
    `本批共 ${notes.length} 条意见：行批注 ${counts("line")} 条，整篇文稿意见 ${counts("document")} 条，本次任务的全部文稿意见 ${counts("study")} 条。`,
    "本轮 review_note_ids 固定了本批意见。请用 knowledge_review_notes 的 list 操作按 next_start 分页读完全部摘要，再用 read 和 id 读取所处理意见的完整原文、引用和前后文；以下只是有限预览，不能代替逐条核对。把每条意见编号及处理结论写入本轮修订台账。",
    ...notes.slice(0, 12).map(note => `意见编号：${note.id}；${note.document_title.slice(0, 180)}；${note.scope === "line" ? `批注时第 ${note.line}${note.line_end !== note.line ? `–${note.line_end}` : ""} 行` : note.scope === "study" ? "全部文稿" : "整篇文稿"}；意见摘要：${note.note.slice(0, 160)}`),
    notes.length > 12 ? `其余 ${notes.length - 12} 条请通过 knowledge_review_notes 分页读取。` : "",
  ].filter(Boolean).join("\n");
}

export function domainKnowledgeReviewNotesTool(dataDir: string, jobId: string, noteIds: readonly string[]) {
  // 复制权限范围，不能因为调用方之后改写数组而扩大本次修订可读的意见。
  const selectedIds = [...new Set(noteIds)];
  return defineTool({
    name: "knowledge_review_notes", label: "读取本批检视意见",
    description: "只读本任务、本轮提交的检视意见。list 按 start/limit 返回摘要（默认20、最多50），有 next_start 必须续读；摘要不包含完整引用与上下文。read 必须填 id，读取该条保存的完整意见、原引用、前后文和批注时行号。行号是历史位置，需结合引用及最新正文定位。未提交或其他回合未选中的意见不可读取。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read")]), id: Type.Optional(Type.String()),
      start: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id: string, args: { action: "list" | "read"; id?: string; start?: number; limit?: number }) {
      try {
        if (args.action === "read" && (!args.id || !selectedIds.includes(args.id))) throw new Error("意见不在本任务本轮提交的批次中");
        if (args.action !== "read" && args.action !== "list") throw new Error("请选择 list 或 read");
        const notes = readDomainReviewNoteBatch(dataDir, jobId, selectedIds);
        if (args.action === "read") return reply({ note: notes.find(note => note.id === args.id), line_reference: "行号对应保存批注时的正文，结合引用、前后文和最新文稿定位。" });
        const start = args.start ?? 0, limit = args.limit ?? 20;
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("请使用有效的 start 和 limit，单页最多 50 条");
        const rows = notes.slice(start, start + limit).map(note => ({
          id: note.id, document_id: note.document_id, document_title: note.document_title.slice(0, 180), scope: note.scope,
          ...(note.scope === "line" ? { line: note.line, line_end: note.line_end } : {}),
          ...(note.anchor ? { anchor: note.anchor.slice(0, 120) } : {}), note_excerpt: note.note.slice(0, 240),
        }));
        return reply({ total: notes.length, notes: rows, ...(start + limit < notes.length ? { next_start: start + limit } : {}) });
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "读取审阅意见失败" }], details: {}, isError: true };
      }
    },
  });
}

function reply(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }
