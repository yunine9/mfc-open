import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import type { DomainWorkDocument } from "./domainKnowledgeTypes.ts";
import { FileProjectionCache } from "./fileProjectionCache.ts";

export class IncompleteDomainResearch extends Error {}
export type SkillWorkDocument = DomainWorkDocument;
export interface SkillWorkReview { pass: boolean; feedback: string }
export interface SkillWorkResult { summary: string; document_ids: string[]; work_document_ids?: string[]; data?: unknown; status?: "complete" | "paused"; review?: SkillWorkReview }
export interface SkillDocumentPlan {
  document_ids: string[]; work_document_id: string;
  exclusions?: Array<{ document_id: string; reason: string }>;
}
const validDocumentId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id);
function validWorkDocument(value: any): value is SkillWorkDocument {
  return value && typeof value.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value.id)
    && typeof value.title === "string" && !!value.title.trim() && value.title.length <= 160
    && typeof value.content === "string" && !!value.content.trim() && Buffer.byteLength(value.content) <= 2 * 1024 * 1024;
}
export function readSkillWorkDocuments(file: string): SkillWorkDocument[] {
  if (!existsSync(file)) return [];
  const state = JSON.parse(readFileSync(file, "utf8"));
  const documents = state.documents ?? [];
  if (!Array.isArray(documents) || !documents.every(validWorkDocument)) throw new Error("过程文稿记录形状无效");
  return documents;
}
const workDocumentSummaries = new FileProjectionCache<SkillWorkDocument[]>();
export function readSkillWorkDocumentSummaries(file: string): SkillWorkDocument[] {
  if (!existsSync(file)) return [];
  return workDocumentSummaries.read(file, () => readSkillWorkDocuments(file).map(({ id, title }) => ({ id, title, content: "" })))
    .map(document => ({ ...document }));
}
export interface SkillWorkStep {
  id: string; title: string; instructions: string; depends_on: string[]; readonly: boolean;
  expected_document_ids?: string[]; review?: { instructions: string };
  /** 修订时实际写入的文稿，可超出最初关注清单；独立评审始终覆盖这个集合。 */
  written_document_ids?: string[];
  status: "pending" | "running" | "done" | "failed" | "discarded";
  result?: SkillWorkResult; error?: string; attempts: number;
  candidate?: SkillWorkResult; candidate_fingerprint?: string; reviewed_fingerprint?: string;
  /** 独立评审工具已接受的结果，先于会话最后一段回复持久化。 */
  review_submission?: { result: SkillWorkResult; fingerprint: string };
  review_attempts?: number; budget_start?: number; review_budget_start?: number;
}
export interface SkillWorkCallbacks {
  /** 候选已持久化后做确定性检查；运行条件不足时抛出并保留候选，不消耗评审次数。 */
  validate?(step: SkillWorkStep, result: SkillWorkResult): Promise<SkillWorkReview | undefined>;
  review(step: SkillWorkStep, result: SkillWorkResult): Promise<SkillWorkReview>;
  fingerprint(ids: string[]): string;
}
const REVIEW_ATTEMPTS = 3;
export const skillWorkDocumentIds = (step: SkillWorkStep, result?: SkillWorkResult) => [...new Set([...(step.expected_document_ids ?? []), ...(step.written_document_ids ?? []), ...(result?.document_ids ?? [])])].sort();
const documentIds = skillWorkDocumentIds;
function normalizeReadonlyReview(step: Pick<SkillWorkStep, "instructions" | "readonly" | "expected_document_ids" | "review">) {
  // 未指定待评知识文稿的只读核查直接返回结论，不再启动一层文稿评审；结果中的 review 仍保留。
  if (step.readonly === true && !step.expected_document_ids?.length && step.review) {
    step.instructions += `\n\n补充核查要求：\n${step.review.instructions}`;
    delete step.review;
  }
}
/** 只保存 Skill 自己安排的工作；不解释模块、阶段或文档类型。 */
export class DomainSkillWork {
  readonly state: { version: 1; skill: string; steps: SkillWorkStep[]; documents?: SkillWorkDocument[]; plan?: SkillDocumentPlan; result?: SkillWorkResult; previous_results?: SkillWorkResult[]; continued?: number; modified_document_ids?: string[] };
  private executions = new Map<string, { signal: AbortSignal; writing: boolean; reviewing?: string; callbacks?: SkillWorkCallbacks }>();
  constructor(private file: string, skill: string, continued = 0) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, skill, steps: [] };
    if (this.state.version !== 1) throw new Error("不支持的 Skill 执行记录版本");
    for (const step of this.state.steps) {
      normalizeReadonlyReview(step);
      if (step.status === "running") { step.status = "failed"; step.error = step.error ? `${step.error}\n执行中断，可按原编号接续` : "执行中断，可按原编号接续"; }
      // 只有用户明确接续才补充有限预算，进程重启保留已经使用的次数。
      if (continued > (this.state.continued ?? 0)) {
        step.budget_start = step.attempts; step.review_budget_start = step.review_attempts ?? 0;
      }
    }
    if (this.state.result && (this.state.skill !== skill || continued > (this.state.continued ?? 0))) {
      (this.state.previous_results ??= []).push(this.state.result); delete this.state.result;
    }
    this.state.continued = Math.max(continued, this.state.continued ?? 0); this.state.skill = skill; this.persist();
  }
  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file);
  }
  saveDocument(document: SkillWorkDocument) {
    if (!validWorkDocument(document)) throw new Error("过程文稿需要有效编号、标题和完整正文，单篇最多 2 MiB");
    scanForSecrets("过程文稿", Buffer.from(JSON.stringify(document)));
    const documents = this.state.documents ?? [];
    if (!documents.some(item => item.id === document.id) && documents.length >= 5000) throw new Error("过程文稿数量已达到上限");
    this.state.documents = [...documents.filter(item => item.id !== document.id), structuredClone(document)];
    this.persist();
  }
  setPlan(plan: SkillDocumentPlan) {
    if (!plan || !Array.isArray(plan.document_ids) || plan.document_ids.length > 5000
        || plan.document_ids.some(id => !validDocumentId(id)) || new Set(plan.document_ids).size !== plan.document_ids.length) throw new Error("完整计划需要有效且不重复的文稿编号，最多 5000 项");
    if (typeof plan.work_document_id !== "string" || !this.state.documents?.some(document => document.id === plan.work_document_id)) throw new Error("请先保存完整规划正文，再引用对应过程文稿编号");
    const exclusions = plan.exclusions === undefined ? [] : plan.exclusions;
    if (!Array.isArray(exclusions) || exclusions.length > 5000 || exclusions.some(item => !item || !validDocumentId(item.document_id)
        || typeof item.reason !== "string" || !item.reason.trim()) || new Set(exclusions.map(item => item.document_id)).size !== exclusions.length) throw new Error("排除项需要有效且不重复的文稿编号，并逐项说明具体原因，最多 5000 项");
    const active = new Set(plan.document_ids), explained = new Map(exclusions.map(item => [item.document_id, item.reason.trim()]));
    if (exclusions.some(item => active.has(item.document_id))) throw new Error("同一文稿不能同时列为必交文稿和排除项");
    const removed = (this.state.plan?.document_ids ?? []).filter(id => !active.has(id) && !explained.has(id));
    if (removed.length) throw new Error(`移除已规划文稿必须逐项说明排除原因：${removed.join("、")}`);
    // 保留历史排除说明；明确重新加入必交清单时，才解除该项排除。
    const retained = new Map((this.state.plan?.exclusions ?? []).filter(item => !active.has(item.document_id)).map(item => [item.document_id, item.reason]));
    for (const [id, reason] of explained) retained.set(id, reason);
    if (active.size + retained.size > 5000) throw new Error("完整计划的必交文稿与排除项合计最多 5000 项");
    const next: SkillDocumentPlan = { document_ids: [...plan.document_ids], work_document_id: plan.work_document_id,
      ...(retained.size ? { exclusions: [...retained].map(([document_id, reason]) => ({ document_id, reason })) } : {}) };
    scanForSecrets("完整文稿计划", Buffer.from(JSON.stringify(next)));
    this.state.plan = next; delete this.state.result; this.persist();
  }
  schedule(steps: Array<Pick<SkillWorkStep, "id" | "title" | "instructions" | "depends_on" | "readonly" | "expected_document_ids" | "review">>) {
    if (!steps.length || steps.length > 100 || this.state.steps.length + steps.length > 5000) throw new Error("请分批保存工作步骤，单批最多 100 项，总计最多 5000 项");
    scanForSecrets("Skill 工作步骤", Buffer.from(JSON.stringify(steps)));
    const next = structuredClone(this.state.steps);
    for (const input of steps) {
      const step = structuredClone(input);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(step.id) || !step.title.trim() || !step.instructions.trim() || typeof step.readonly !== "boolean") throw new Error("步骤需要有效编号、标题、执行说明和读写权限");
      if (step.expected_document_ids !== undefined && (!Array.isArray(step.expected_document_ids) || !step.expected_document_ids.length
          || step.expected_document_ids.length > 5000 || new Set(step.expected_document_ids).size !== step.expected_document_ids.length
          || step.expected_document_ids.some(id => !validDocumentId(id)))) throw new Error("预定文稿需要有效且不重复的文稿编号");
      if (step.review !== undefined && (typeof step.review?.instructions !== "string" || !step.review.instructions.trim())) throw new Error("独立评审需要具体的评审说明");
      normalizeReadonlyReview(step);
      const old = next.find(s => s.id === step.id);
      if (old) {
        if (["title", "instructions", "depends_on", "readonly", "expected_document_ids", "review"].some(k => JSON.stringify(old[k as keyof SkillWorkStep]) !== JSON.stringify(step[k as keyof typeof step]))) throw new Error("已有步骤不能改写，请使用新编号保存修订工作");
      } else next.push({ ...step, status: "pending", attempts: 0 });
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error("工作步骤存在循环依赖");
      const step = next.find(s => s.id === id); if (!step) throw new Error("依赖步骤不存在");
      visiting.add(id); step.depends_on.forEach(visit); visiting.delete(id); visited.add(id);
    };
    next.forEach(s => visit(s.id)); this.state.steps = next; delete this.state.result; this.persist();
  }
  discard(id: string, reason: string) {
    const step = this.state.steps.find(s => s.id === id);
    if (!step || step.status === "running" || !reason.trim()) throw new Error("请选择未在执行的步骤并说明不再执行的原因");
    step.status = "discarded"; step.error = reason; this.persist();
  }
  assertDocumentWrite(stepId: string | undefined, documentId: string) {
    if (!stepId) return;
    if (!this.executions.get(stepId)?.writing) throw new Error("当前步骤不是文稿写作会话");
    const other = this.state.steps.find(step => step.id !== stepId && !step.readonly && this.executions.has(step.id)
      && skillWorkDocumentIds(step).includes(documentId));
    if (other) throw new Error(`文稿 ${documentId} 正在步骤 ${other.id} 中处理，不能覆盖并发修改。先完成不冲突的文稿，将关联修改及具体位置写入 summary/data，交主会话在该批次结束后串行处理；再次修改前回读当前正文。`);
  }
  recordDocumentWrite(stepId: string | undefined, documentId: string) {
    this.assertDocumentWrite(stepId, documentId);
    this.state.modified_document_ids = [...new Set([...(this.state.modified_document_ids ?? []), documentId])];
    const step = this.state.steps.find(step => step.id === stepId);
    if (step) step.written_document_ids = [...new Set([...(step.written_document_ids ?? []), documentId])];
    delete this.state.result; this.persist();
  }
  recordCandidate(id: string, result: SkillWorkResult, fingerprint?: string) {
    const step = this.state.steps.find(s => s.id === id), execution = this.executions.get(id);
    if (!step || step.status !== "running" || !execution?.writing) throw new Error("当前步骤不在保存研究结果");
    execution.signal.throwIfAborted();
    if (!result.summary?.trim() || !Array.isArray(result.document_ids) || result.document_ids.some(id => typeof id !== "string" || !id.trim())
        || result.status === "paused") throw new Error("步骤需要具体结论和文稿编号，待确认问题请交回主会话");
    if (step.expected_document_ids?.some(id => !result.document_ids.includes(id))) throw new Error("尚未提交全部预定文稿，请继续研究并保存缺少的文稿");
    if (step.review && !documentIds(step, result).length) throw new Error("独立评审需要至少一份待评审文稿");
    scanForSecrets("Skill 步骤结果", Buffer.from(JSON.stringify(result)));
    step.candidate = structuredClone({ ...result, document_ids: [...new Set([...result.document_ids, ...(step.written_document_ids ?? [])])] });
    if (step.review) delete step.candidate.review; // 写作者不能替独立评审保存通过结论。
    step.candidate_fingerprint = fingerprint ?? execution.callbacks?.fingerprint(documentIds(step, result));
    delete step.result; delete step.reviewed_fingerprint; delete step.review_submission; delete this.state.result;
    this.persist(); return structuredClone(step.candidate);
  }
  recordReview(id: string, result: SkillWorkResult, fingerprint: string) {
    const step = this.state.steps.find(item => item.id === id), execution = this.executions.get(id);
    if (!step?.review || step.status !== "running" || !step.candidate || !execution?.reviewing || execution.writing) throw new Error("当前步骤不在提交独立评审");
    execution.signal.throwIfAborted();
    if (!result.summary?.trim() || result.status === "paused" || typeof result.review?.pass !== "boolean" || !result.review.feedback?.trim()) throw new Error("独立评审必须明确是否通过，并说明依据或具体修改意见");
    const ids = documentIds(step, step.candidate);
    if (!Array.isArray(result.document_ids) || ids.some(id => !result.document_ids.includes(id))) throw new Error("独立评审结果需要包含全部预定及实际改动文稿");
    if (execution.reviewing !== fingerprint || execution.callbacks?.fingerprint(ids) !== fingerprint) throw new Error("评审期间文稿已变化，请重新读取并评审当前正文");
    scanForSecrets("Skill 独立评审", Buffer.from(JSON.stringify(result)));
    step.review_submission = structuredClone({ result, fingerprint });
    delete this.state.result; this.persist();
    return structuredClone(result);
  }
  async run(id: string, execute: (step: SkillWorkStep) => Promise<SkillWorkResult>, signal: AbortSignal, callbacks?: SkillWorkCallbacks) {
    const step = this.state.steps.find(s => s.id === id);
    if (!step || ["running", "discarded"].includes(step.status)) throw new Error("步骤不存在、已放弃或正在执行");
    signal.throwIfAborted();
    if (step.review && !callbacks) throw new Error("此步骤需要独立评审与文稿版本核对");
    const validatesDocuments = !step.readonly || !!step.review;
    const revisesDocuments = !!step.review || validatesDocuments && !!callbacks?.validate;
    if (step.status === "done") {
      const currentFingerprint = step.review && step.result ? callbacks!.fingerprint(documentIds(step, step.result)) : undefined;
      const reusable = !step.review || step.result?.review?.pass && step.reviewed_fingerprint === currentFingerprint;
      let validation: SkillWorkReview | undefined;
      try { validation = reusable && validatesDocuments ? await callbacks?.validate?.(structuredClone(step), structuredClone(step.result!)) : undefined; }
      catch (error) {
        // 已通过版本暂时无法复核时保留评审凭据；环境恢复后可直接复用，不重新消耗预算。
        delete this.state.result;
        step.error = error instanceof Error ? error.message : String(error); this.persist(); throw error;
      }
      signal.throwIfAborted();
      if (reusable && (!validation || validation.pass)) {
        if (step.error) { delete step.error; this.persist(); }
        return step.result!;
      }
      // 已通过的正文后来正常修改，为新版本提供有限评审预算；失败或重启不走这条路径。
      if (step.result?.review?.pass && step.reviewed_fingerprint !== currentFingerprint) {
        step.budget_start = step.attempts; step.review_budget_start = step.review_attempts ?? 0;
      }
      step.candidate ??= structuredClone(step.result!);
      if (step.candidate) delete step.candidate.review;
      if (validation && !validation.pass) step.candidate!.review = validation;
      delete step.result; delete step.reviewed_fingerprint; delete step.review_submission; delete this.state.result;
      step.status = "pending"; step.error = validation?.feedback ?? "文稿已变化，需要重新读取并评审当前正文"; this.persist();
    }
    if (step.depends_on.some(id => this.state.steps.find(s => s.id === id)?.status !== "done")) throw new Error("依赖步骤尚未完成");
    const execution: { signal: AbortSignal; writing: boolean; reviewing?: string; callbacks?: SkillWorkCallbacks } = { signal, writing: false, callbacks };
    this.executions.set(id, execution);
    step.status = "running"; delete this.state.result; this.persist();
    try {
      for (;;) {
        signal.throwIfAborted();
        const submitted = step.review_submission && step.review && step.candidate && step.review_submission.fingerprint === callbacks!.fingerprint(documentIds(step, step.candidate)) ? step.review_submission : undefined;
        if (step.review_submission && !submitted) {
          delete step.review_submission;
          if (step.candidate) delete step.candidate.review;
          this.persist();
        }
        if (submitted) {
          step.candidate!.review = structuredClone(submitted.result.review!);
          if (!submitted.result.review!.pass) step.error = submitted.result.review!.feedback;
        }
        // 第三次评审已成功提交后发生中断，恢复时仍须接纳该结果，不能再消耗一次预算。
        if (step.review && !submitted?.result.review?.pass && (step.review_attempts ?? 0) - (step.review_budget_start ?? 0) >= REVIEW_ATTEMPTS) throw new Error(`独立评审已尝试 ${REVIEW_ATTEMPTS} 次，本项尚未通过；${step.error ?? "请检查文稿和评审记录后接续"}`);
        if (!step.candidate || revisesDocuments && step.candidate.review?.pass === false) {
          if (revisesDocuments && step.attempts - (step.budget_start ?? 0) >= REVIEW_ATTEMPTS) throw new Error(`研究与修订已尝试 ${REVIEW_ATTEMPTS} 次，本项尚未完成；${step.error ?? "请检查已保存的草稿后接续"}`);
          step.attempts++; execution.writing = true;
          const attempt = structuredClone(step); // 把上次候选及退回意见交给修订会话。
          delete step.candidate; delete step.candidate_fingerprint; this.persist();
          try {
            const result = await execute(attempt); signal.throwIfAborted();
            // 工具已提交的结果优先，避免结束回复失败后重复生成已保存的文稿。
            if (!step.candidate) this.recordCandidate(id, result);
          } catch (error) {
            signal.throwIfAborted();
            if (!step.candidate) {
              step.error = error instanceof Error ? error.message : String(error); this.persist();
              if (!step.review) throw error;
              continue;
            }
          } finally { execution.writing = false; }
        }
        const candidate = step.candidate!;
        const validation = validatesDocuments ? await callbacks?.validate?.(structuredClone(step), structuredClone(candidate)) : undefined;
        signal.throwIfAborted();
        if (validation && !validation.pass) {
          candidate.review = validation; delete step.review_submission; step.error = validation.feedback; this.persist(); continue;
        }
        if (!step.review) {
          step.result = structuredClone(candidate); step.status = "done"; delete step.error; this.persist(); return step.result;
        }
        const ids = documentIds(step, candidate), fingerprint = callbacks!.fingerprint(ids);
        step.candidate_fingerprint = fingerprint;
        const savedReview = step.review_submission?.fingerprint === fingerprint ? step.review_submission.result.review : undefined;
        if (!savedReview) {
          delete step.review_submission;
          if ((step.review_attempts ?? 0) - (step.review_budget_start ?? 0) >= REVIEW_ATTEMPTS) throw new Error(`独立评审已尝试 ${REVIEW_ATTEMPTS} 次，本项尚未通过；${step.error ?? "请检查文稿和评审记录后接续"}`);
          step.review_attempts = (step.review_attempts ?? 0) + 1; this.persist();
        }
        try {
          if (!savedReview) {
            execution.reviewing = fingerprint;
            try {
              const review = await callbacks!.review(structuredClone(step), structuredClone(candidate)); signal.throwIfAborted();
              // 工具提交优先于最后回复；旧调用方仍可通过返回值提交评审。
              if (!step.review_submission) this.recordReview(id, { summary: review?.feedback, document_ids: ids, review }, fingerprint);
            } catch (error) {
              signal.throwIfAborted();
              if (!step.review_submission) throw error;
            } finally { delete execution.reviewing; }
          }
          if (callbacks!.fingerprint(ids) !== fingerprint) throw new Error("评审期间文稿已变化，请重新读取并评审当前正文");
          const review = step.review_submission!.result.review!;
          candidate.review = structuredClone(review);
          if (!review.pass) { step.error = review.feedback; this.persist(); continue; }
          step.result = structuredClone(candidate); step.reviewed_fingerprint = fingerprint;
          step.status = "done"; delete step.error; this.persist(); return step.result;
        } catch (error) {
          signal.throwIfAborted();
          step.error = error instanceof Error ? error.message : String(error); this.persist();
          // 请求失败或正文变化时复用候选，只重新评审，不重复写作。
        }
      }
    } catch (error) { step.status = "failed"; step.error = error instanceof Error ? error.message : String(error); this.persist(); throw error; }
    finally { this.executions.delete(id); }
  }
  finish(result: SkillWorkResult, fingerprint?: (ids: string[]) => string, excludedDocumentIds: ReadonlySet<string> = new Set()) {
    if (result.status !== "paused" && this.state.steps.some(s => !["done", "discarded"].includes(s.status))) throw new Error("还有未完成的步骤，请继续处理、说明放弃原因或保存暂停结果");
    if (result.status !== "paused") {
      const reviewed = new Set<string>(), remaining = new Set<string>();
      for (const step of this.state.steps.filter(s => s.status === "done" && s.review)) {
        const ids = documentIds(step, step.result);
        if (ids.some(id => excludedDocumentIds.has(id))) {
          // 整组旧指纹不能证明其中一部分正文的当前版本；保留历史，余下文稿由有效评审覆盖。
          ids.filter(id => !excludedDocumentIds.has(id)).forEach(id => remaining.add(id));
          continue;
        }
        if (!fingerprint) throw new Error("完成前需要核对独立评审对应的文稿版本");
        if (!step.result?.review?.pass || step.reviewed_fingerprint !== fingerprint(ids)) throw new Error(`文稿已变化或尚未通过独立评审，请重新执行步骤 ${step.id}`);
        ids.forEach(id => reviewed.add(id));
      }
      const missing = [...remaining].filter(id => !reviewed.has(id));
      if (missing.length) throw new Error(`旧步骤包含已排除文稿，其余 ${missing.length} 篇仍有效文稿缺少当前版本的独立评审：${missing.slice(0, 30).join("、")}；请为这些文稿安排新的只读评审步骤，无需重写或改动旧步骤`);
    }
    // 没有另存文稿的简单方法也能让人阅读全文，不把等待说明仅留在错误栏。
    if (result.status === "paused" && !result.work_document_ids?.length) {
      const id = `input-${randomUUID()}`;
      this.saveDocument({ id, title: "待确认说明", content: result.summary });
      result = { ...result, work_document_ids: [id] };
    }
    this.state.result = result; this.persist();
    return result;
  }
}
