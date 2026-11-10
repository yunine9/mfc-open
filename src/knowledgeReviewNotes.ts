import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DomainKnowledgeExtraction } from "./domainKnowledgeExtraction.ts";
import type { ComponentResearch } from "./componentResearch.ts";
import { readHostSkillPackage, scanForSecrets } from "./hostSkillLibrary.ts";
import { readKnowledgeDocument } from "./knowledgeDocuments.ts";
import { knowledgeDocumentCatalog } from "./knowledgeDocumentCatalog.ts";
import { durableWriteFileSync } from "./durableWrite.ts";
import { domainReviewBatchMessage } from "./domainKnowledgeReviewNotes.ts";
import type { DomainTurn } from "./domainKnowledgeTypes.ts";

import type { KnowledgeReviewKind, KnowledgeReviewNote, KnowledgeReviewNoteInput, KnowledgeReviewNotesResult } from "./knowledgeReviewNoteTypes.ts";
export type { KnowledgeReviewKind, KnowledgeReviewNote, KnowledgeReviewNoteInput } from "./knowledgeReviewNoteTypes.ts";

export interface KnowledgeReviewSources {
  dataDir: string;
  domain: Pick<DomainKnowledgeExtraction, "get" | "run">;
  component: Pick<ComponentResearch, "get" | "review">;
}

function file(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string) {
  const validId = typeof jobId === "string" && (kind === "published"
    ? /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/.test(jobId) && !jobId.split(/[/:]/).some(part => !part || part === "." || part === "..")
    : kind === "skill" ? /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(jobId) && !jobId.includes("..") : /^[a-zA-Z0-9-]{1,100}$/.test(jobId));
  if (!["domain", "component", "published", "skill"].includes(kind) || !validId) throw new Error("知识任务编号无效");
  const name = kind === "published" && !/^kd-[a-f0-9-]{36}$/.test(jobId) ? `asset-${createHash("sha256").update(jobId).digest("hex")}` : jobId;
  return join(sources.dataDir, "knowledge-review", kind, `${name}.json`);
}
function documents(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string) {
  // 先校验路径和类型，再查原研究任务，已删除任务不能继续写入批注。
  file(sources, kind, jobId);
  if (kind === "published") {
    if (/^kd-[a-f0-9-]{36}$/.test(jobId)) return [readKnowledgeDocument(sources.dataDir, jobId)];
    const document = knowledgeDocumentCatalog(sources.dataDir).documents.find(document => document.id === jobId);
    if (!document) throw new Error("批注对应的文档已不存在，请刷新后重新选择");
    return [document];
  }
  if (kind === "skill") return readHostSkillPackage(sources.dataDir, jobId).files.filter(file => /\.md$/i.test(file.path) && file.content !== undefined)
    .map(file => ({ id: file.path, title: file.path, content: file.content! }));
  if (kind === "domain") return sources.domain.get(jobId).documents;
  const record = sources.component.get(jobId);
  if (record.deleted_at) throw new Error("组件研究已删除");
  return record.document?.sections ?? [];
}
function read(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string): KnowledgeReviewNote[] {
  const path = file(sources, kind, jobId);
  if (!existsSync(path)) return [];
  const notes = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(notes)) throw new Error("批注记录无法读取，请检查存储文件");
  if (kind === "domain") {
    // 回合已保存而批注尚未补齐提交信息时，以回合中的精确意见编号恢复关联。
    const turns = sources.domain.get(jobId).turns;
    const submitted = new Map(turns.flatMap(turn => (turn.review_note_ids ?? []).map(id => [id, turn] as const)));
    let changed = false;
    for (const note of notes as KnowledgeReviewNote[]) {
      if (note.turn_id || note.status === "resolved") continue;
      const turn = submitted.get(note.id); if (!turn) continue;
      Object.assign(note, { status: "submitted", turn_id: turn.id,
        submitted_at: note.submitted_at ?? turn.created_at, submitted_by: note.submitted_by ?? turn.operator });
      changed = true;
    }
    if (changed) save(sources, kind, jobId, notes);
  }
  if (kind === "component") {
    const component = sources.component.get(jobId);
    let changed = false;
    for (const note of notes as KnowledgeReviewNote[]) {
      if (note.status !== "submitted" || !note.turn_id) continue;
      const componentTurn = component?.review_turns?.find(turn => turn.id === note.turn_id);
      const turn = componentTurn;
      if (!turn) continue;
      const discarded = componentTurn?.section_id === note.document_id && componentTurn.proposal?.section.id === note.document_id && componentTurn.proposal.status === "discarded";
      if (["failed", "cancelled"].includes(turn.status) || discarded) {
        note.status = "open";
        changed = true;
      }
    }
    if (changed) save(sources, kind, jobId, notes);
  }
  return notes;
}
function save(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, notes: KnowledgeReviewNote[]) {
  const path = file(sources, kind, jobId);
  mkdirSync(dirname(path), { recursive: true });
  durableWriteFileSync(path, JSON.stringify(notes), { mode: 0o600 });
}
function string(value: unknown, label: string, limit: number, required = false): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()) || value.includes("\0")) throw new Error(`${label}格式无效，最多 ${limit} 字`);
  return value.trim() || undefined;
}
function currentDocument(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: Pick<KnowledgeReviewNoteInput, "document_id"> & { scope?: KnowledgeReviewNoteInput["scope"] }) {
  const items = documents(sources, kind, jobId);
  if (input.scope === "study" && (kind === "domain" || kind === "component")) return { id: "", title: "全部文稿" };
  const doc = items.find(doc => doc.id === input.document_id);
  if (!doc) throw new Error("批注对应的文稿已不存在，请刷新后重新选择");
  return doc;
}

function inspectionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error("检视轮次编号无效，请重新进入检视");
  return value.toLowerCase();
}
function retryableDomainTurn(turn: DomainTurn | undefined): boolean {
  return !!turn && (["failed", "cancelled"].includes(turn.status)
    || turn.status === "done" && turn.proposals.some(proposal => proposal.status === "discarded"));
}
function domainRetryRules(turns: DomainTurn[], notes: KnowledgeReviewNote[]) {
  const turnsById = new Map(turns.map(turn => [turn.id, turn])), notesById = new Map(notes.map(note => [note.id, note]));
  const roots = new Map<string, string>();
  const origin = (note: KnowledgeReviewNote): string => {
    if (roots.has(note.id)) return roots.get(note.id)!;
    const visited = new Set<string>(); let current = note;
    while (current.retry_of && notesById.has(current.retry_of)) {
      if (visited.has(current.id)) throw new Error("意见重试记录存在循环，请检查原批注记录");
      visited.add(current.id); current = notesById.get(current.retry_of)!;
    }
    const root = current.retry_of ?? current.id;
    roots.set(note.id, root); return root;
  };
  const blockedOrigins = new Set(notes.filter(note => {
    const turn = note.turn_id ? turnsById.get(note.turn_id) : undefined;
    return note.status === "resolved" || turn && (["queued", "running", "paused"].includes(turn.status)
      || turn.status === "done" && !retryableDomainTurn(turn));
  }).map(origin));
  const canRetry = (note: KnowledgeReviewNote) => note.status !== "resolved" && !blockedOrigins.has(origin(note))
    && (note.turn_id ? retryableDomainTurn(turnsById.get(note.turn_id)) : note.status === "open" && !note.submitted_at);
  return { canRetry, origin };
}

function response(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, notes: KnowledgeReviewNote[]): KnowledgeReviewNotesResult {
  const domainTurns = kind === "domain" ? sources.domain.get(jobId).turns : undefined;
  const turns = domainTurns ?? (kind === "component" ? sources.component.get(jobId).review_turns ?? [] : []);
  const retry = domainTurns ? domainRetryRules(domainTurns, notes) : undefined;
  const submissions: KnowledgeReviewNotesResult["submissions"] = {};
  for (const turn of turns) if (notes.some(note => note.turn_id === turn.id)) {
    submissions[turn.id] = { working: turn.status === "queued" || turn.status === "running", status_label: ({
      queued: "意见已发送，等待 Agent 开始修改", running: "Agent 正在修改文稿", paused: "修改已暂停，等待你确认",
      done: "修改完成，请审阅文稿", failed: "修改失败，意见已保留，可重试", cancelled: "修改已停止，意见已保留",
    } as Record<string, string>)[turn.status] ?? "请查看任务详情", error: turn.error,
      ...(retry ? { retryable: notes.filter(note => note.turn_id === turn.id && note.status !== "resolved").some(note => retry.canRetry(note))
        && notes.filter(note => note.turn_id === turn.id && note.status !== "resolved").every(note => retry.canRetry(note)) } : {}) };
  }
  return { notes, submissions };
}

export function listKnowledgeReviewNotes(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string): KnowledgeReviewNotesResult {
  documents(sources, kind, jobId);
  return response(sources, kind, jobId, read(sources, kind, jobId));
}

export function saveKnowledgeReviewNote(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: KnowledgeReviewNoteInput, operator: string): KnowledgeReviewNotesResult {
  const doc = currentDocument(sources, kind, jobId, input);
  if (!["line", "document", "study"].includes(input.scope)) throw new Error("请选择行批注、文稿意见或研究方向意见");
  if ((kind === "published" || kind === "skill") && input.scope === "study") throw new Error("请选择行批注或整篇文档意见");
  if (input.scope === "line" && (!Number.isSafeInteger(input.line) || input.line! < 1)) throw new Error("行批注需要有效的正文行号");
  if (input.line_end !== undefined && (!Number.isSafeInteger(input.line_end) || input.line_end < (input.line ?? 1))) throw new Error("批注结束行无效");
  const note: KnowledgeReviewNote = {
    id: randomUUID(), kind, job_id: jobId, document_id: doc.id, document_title: doc.title,
    scope: input.scope, ...(input.scope === "line" ? { line: input.line, line_end: input.line_end ?? input.line } : {}),
    anchor: string(input.anchor, "批注位置", 1000), quote: string(input.quote, "引用正文", 4000),
    context_before: string(input.context_before, "前文", 2000), context_after: string(input.context_after, "后文", 2000),
    note: string(input.note, "批注意见", 10_000, true)!, operator, created_at: new Date().toISOString(), status: "open",
    ...(kind === "domain" && input.inspection_id !== undefined ? { inspection_id: inspectionId(input.inspection_id) } : {}),
  };
  scanForSecrets("知识文稿批注", Buffer.from(JSON.stringify(note)));
  const notes = read(sources, kind, jobId);
  notes.push(note); save(sources, kind, jobId, notes);
  return response(sources, kind, jobId, notes);
}

function reviewMessage(notes: KnowledgeReviewNote[]): string {
  return ["请根据以下人工审阅意见提出文稿修订建议。沿用意见编号逐条记录结论。先核对最新正文、涉及的来源与上下文；行号是批注时的位置，结合引用原文和前后文定位，已经解决的意见不必重复修改。保留未受影响的内容，必要时同步相关文稿。",
    ...notes.map((note, index) => [
      `\n${index + 1}. ${note.document_title}（${note.document_id}）`,
      `意见编号：${note.id}`,
      `范围：${note.scope === "line" ? `第 ${note.line}${note.line_end !== note.line ? `–${note.line_end}` : ""} 行` : note.scope === "study" ? "本次任务的全部文稿" : "整篇文稿"}`,
      note.anchor ? `位置：${note.anchor}` : "", note.quote ? `引用正文：\n${note.quote}` : "",
      note.context_before ? `前文：\n${note.context_before}` : "", note.context_after ? `后文：\n${note.context_after}` : "",
      `意见：${note.note}`,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

export function applyKnowledgeReviewNotes(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: { note_ids: string[]; inspection_id?: string; retry?: boolean }, operator: string): KnowledgeReviewNotesResult {
  const availableDocuments = documents(sources, kind, jobId), availableIds = new Set(availableDocuments.map(document => document.id));
  if (kind === "published" || kind === "skill") throw new Error("请先更新文档，修改完成后将意见标为已处理");
  if (!Array.isArray(input.note_ids) || !input.note_ids.length || input.note_ids.some(id => typeof id !== "string")) throw new Error("请选择未处理的审阅意见");
  if (kind === "domain" && input.retry !== undefined && typeof input.retry !== "boolean") throw new Error("请选择有效的意见提交方式");
  const batchId = kind === "domain" ? inspectionId(input.inspection_id) : undefined;
  const retrying = kind === "domain" && input.retry === true;
  const notes = read(sources, kind, jobId), ids = [...new Set(input.note_ids)];
  let selected = ids.map(id => {
    const note = notes.find(note => note.id === id);
    if (!note) throw new Error("所选批注已不存在，请刷新");
    if (!retrying && (note.status !== "open" || kind === "domain" && (note.turn_id || note.submitted_at))) throw new Error("所选意见已经提交修订或标为已处理，请刷新查看；历史失败意见请使用重试");
    if (!retrying && kind === "domain" && notes.some(other => other.retry_of === note.id)) throw new Error("所选历史意见已生成重试批次，请使用新批次，不要重复提交原意见");
    if (note.scope !== "study" && !availableIds.has(note.document_id)) throw new Error("批注对应的文稿已不存在，请刷新后重新选择");
    return note;
  });
  if (kind === "domain") {
    if (new Set(selected.map(note => note.inspection_id)).size !== 1 || batchId && selected.some(note => note.inspection_id !== batchId)) throw new Error("所选意见不属于同一检视轮次，请按轮次分别提交");
    if (retrying) {
      if (new Set(selected.map(note => note.turn_id)).size !== 1) throw new Error("请只重试同一批次的意见，不要混合历史批次与未提交意见");
      const rules = domainRetryRules(sources.domain.get(jobId).turns, notes);
      if (selected.some(note => !rules.canRetry(note))) throw new Error("所选意见不能重试：仅支持失败、已停止或已丢弃的批次，且同一意见不能已有正在处理或已成功的修订");
      if (new Set(selected.map(rules.origin)).size !== selected.length) throw new Error("同一原始意见只能选择一次，请使用最近一次失败记录");
      const inspection = randomUUID(), createdAt = new Date().toISOString();
      selected = selected.map(note => {
        const { submitted_at: _at, submitted_by: _by, turn_id: _turn, resolved_at: _resolvedAt, resolved_by: _resolvedBy, ...copy } = note;
        return { ...copy, id: randomUUID(), retry_of: note.id, inspection_id: inspection, operator, created_at: createdAt, status: "open" as const };
      });
    }
  }
  const documentIds = [...new Set(selected.map(note => note.document_id))];
  const wholeStudy = selected.some(note => note.scope === "study");
  if (kind === "component" && !wholeStudy && documentIds.length !== 1) throw new Error("组件研究每轮修订一个章节，请按章节分别提交意见");
  const message = kind === "domain" ? domainReviewBatchMessage(selected) : reviewMessage(selected);
  if (message.length > 20_000) throw new Error("本批意见与引用超过 20000 字，请减少本次选中的意见");
  let turnId: string | undefined;
  if (kind === "domain") {
    // run 会同步读取本批原意见；新副本先保存，启动拒绝时恢复原记录，不留下半次重试。
    const original = retrying ? readFileSync(file(sources, kind, jobId), "utf8") : undefined;
    if (retrying) save(sources, kind, jobId, [...notes, ...selected]);
    try {
      const job = sources.domain.run(jobId, { mode: "revise", document_ids: wholeStudy
        ? availableDocuments.map(doc => doc.id) : documentIds, message, review_note_ids: selected.map(note => note.id) }, operator);
      turnId = job.turns.at(-1)?.id;
    } catch (error) {
      if (original !== undefined) durableWriteFileSync(file(sources, kind, jobId), original, { mode: 0o600 });
      throw error;
    }
    if (retrying) notes.push(...selected);
  } else {
    const job = sources.component.review(jobId, { mode: "rework", section_id: wholeStudy ? "" : documentIds[0], message }, operator);
    turnId = job.review_turns?.at(-1)?.id;
  }
  const submittedAt = new Date().toISOString();
  for (const note of selected) Object.assign(note, { status: "submitted", submitted_at: submittedAt, submitted_by: operator, turn_id: turnId });
  save(sources, kind, jobId, notes);
  return { ...response(sources, kind, jobId, notes), turn_id: turnId };
}

export function resolveKnowledgeReviewNotes(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: { note_ids: string[] }, operator: string): KnowledgeReviewNotesResult {
  documents(sources, kind, jobId);
  if (!Array.isArray(input.note_ids) || !input.note_ids.length || input.note_ids.some(id => typeof id !== "string")) throw new Error("请选择需要标为已处理的意见");
  const notes = read(sources, kind, jobId);
  const selected = [...new Set(input.note_ids)].map(id => {
    const note = notes.find(note => note.id === id);
    if (!note) throw new Error("所选批注已不存在，请刷新");
    return note;
  });
  const resolvedAt = new Date().toISOString();
  for (const note of selected) if (note.status !== "resolved") Object.assign(note, { status: "resolved", resolved_at: resolvedAt, resolved_by: operator });
  save(sources, kind, jobId, notes);
  return response(sources, kind, jobId, notes);
}
