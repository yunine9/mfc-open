import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeAnswerContext, KnowledgeAnswerEvidence, KnowledgeAnswerInput, KnowledgeAnswerRecord, KnowledgeAnswerRunner, KnowledgeAnswerSummary } from "./knowledgeAnswerTypes.ts";
import { knowledgeAnswerCitations } from "./knowledgeAnswerCitations.ts";

const ID = /^qa-[a-f0-9-]{36}$/;
const copy = <T>(value: T): T => structuredClone(value);
const terminal = (record: KnowledgeAnswerRecord) => ["done", "failed", "cancelled"].includes(record.status);
const stages = new Set(["queued", "researching", "answering", "checking", "done"]);
const sourceKinds = new Set(["knowledge", "code", "everycode", "wireless", "material"]);
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
/** 编号只在本次问答内使用；原文摘要和源码提交号另行完整保存。 */
export function knowledgeAnswerEvidenceId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 80) throw new Error("来源编号超出本轮预算");
  return `ev-${index + 1}`;
}
function validAnswer(record: KnowledgeAnswerRecord): boolean {
  const answer = record.answer;
  if (!answer || typeof answer.markdown !== "string" || !answer.markdown.trim() || answer.markdown.length > 24_000 || !Array.isArray(answer.evidence_ids)
    || !Array.isArray(answer.unknowns) || answer.unknowns.length > 32 || answer.unknowns.some(value => typeof value !== "string" || !value.trim() || value.length > 2000)
    || JSON.stringify(answer).length > 24_000 || new Set(answer.evidence_ids).size !== answer.evidence_ids.length
    || (!answer.evidence_ids.length && !answer.unknowns.length)
    || answer.evidence_ids.some(id => typeof id !== "string" || !record.evidence.some(evidence => evidence.id === id))) return false;
  const citations = knowledgeAnswerCitations(answer.markdown);
  return citations.every(id => answer.evidence_ids.includes(id)) && answer.evidence_ids.every(id => citations.includes(id));
}

export class KnowledgeAnswerError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function selection(value: unknown, label: string, max = 20): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== "string" || !id.trim() || id.length > 2048 || /[\x00-\x1f]/.test(id)))
    throw new KnowledgeAnswerError(400, `${label}须为有效编号列表，最多 ${max} 项`);
  return [...new Set(value.map(id => id.trim()))].sort();
}

export function knowledgeAnswerInput(value: unknown, historical = false): KnowledgeAnswerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeAnswerError(400, "请提供问题");
  const input = value as Record<string, unknown>;
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 12_000)
    throw new KnowledgeAnswerError(400, "问题必填，最多 12000 字");
  let context: KnowledgeAnswerContext | undefined;
  if (input.context !== undefined) {
    if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) throw new KnowledgeAnswerError(400, "问题范围须为对象");
    const raw = input.context as Record<string, unknown>;
    context = {};
    if (!historical && (raw.material_ids !== undefined || raw.repository_ids !== undefined))
      throw new KnowledgeAnswerError(400, "知识问答只查询已发布文档，不再接受临时附件或代码仓范围；可选择业务模块或文档");
    for (const [key, label] of [["module_ids", "业务模块"], ["repository_ids", "代码仓"], ["material_ids", "原始资料"]] as const) {
      const ids = selection(raw[key], label, key === "material_ids" ? 10 : 20);
      if (ids?.length) context[key] = ids;
    }
    for (const key of ["document_id", "product_version"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string" || raw[key].length > 512 || /[\x00-\x1f]/.test(raw[key])) throw new KnowledgeAnswerError(400, "参考文档或产品版本无效");
        if (raw[key].trim()) context[key] = raw[key].trim();
      }
    }
    if (!Object.keys(context).length) context = undefined;
  }
  return { question: input.question.trim(), ...(context ? { context } : {}) };
}

/** 问答自身的运行记录，和需求交付、知识发布流程无关。 */
export class KnowledgeAnswers {
  private records = new Map<string, KnowledgeAnswerRecord>();
  private active = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private closed = false;
  private readonly root: string;
  private readonly concurrency: number;
  private readonly timeoutMs: number;

  constructor(private readonly dataDir: string, private readonly run: KnowledgeAnswerRunner, options: { concurrency?: number; timeoutMs?: number } = {}) {
    this.root = join(dataDir, "knowledge-answers");
    this.concurrency = options.concurrency ?? 2;
    this.timeoutMs = options.timeoutMs ?? 480_000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new Error("问答运行预算无效");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(this.root).filter(id => ID.test(id))) {
      const file = join(this.root, id, "record.json");
      if (!existsSync(file)) continue;
      try {
        const record = JSON.parse(readFileSync(file, "utf8")) as KnowledgeAnswerRecord;
        if (record.id !== id || typeof record.owner !== "string" || !record.owner
          || !["queued", "running", "done", "failed", "cancelled"].includes(record.status) || !stages.has(record.stage)
          || !validTime(record.created_at) || !validTime(record.updated_at)
          || !Array.isArray(record.evidence) || record.evidence.length > 80 || record.evidence.some(evidence => !evidence || typeof evidence.id !== "string"
            || typeof evidence.content !== "string" || typeof evidence.title !== "string" || !sourceKinds.has(evidence.kind)
            || !validTime(evidence.retrieved_at) || !/^[a-f0-9]{64}$/.test(evidence.digest)
            || createHash("sha256").update(evidence.content).digest("hex") !== evidence.digest)
          || !Array.isArray(record.activity) || record.activity.some(activity => !activity || !stages.has(activity.stage) || typeof activity.message !== "string" || !validTime(activity.at))
          || !Array.isArray(record.warnings) || record.warnings.some(warning => typeof warning !== "string")) continue;
        knowledgeAnswerInput(record, true);
        if (record.status !== "done") delete record.answer;
        else if (!validAnswer(record)) {
          record.status = "failed"; record.error = "保存的回答或引用不完整，请重新提问"; delete record.answer;
          this.persist(record);
        }
        if (!terminal(record)) {
          record.status = "failed";
          record.error = "服务已重启，本轮问答已停止；已取得的来源保留，可以重新提问";
          delete record.answer;
          this.persist(record);
        }
        this.records.set(id, record);
      } catch { /* 单条损坏记录不影响其他人的问答，原文件保留。 */ }
    }
  }

  list(owner: string): KnowledgeAnswerSummary[] {
    return [...this.records.values()].filter(record => record.owner === owner)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100)
      .map(({ id, question, status, stage, created_at, updated_at }) => ({ id, question, status, stage, created_at, updated_at }));
  }

  get(id: string, owner: string): KnowledgeAnswerRecord {
    const record = copy(this.owned(id, owner));
    if (record.context?.module_ids) record.context.module_ids = resolveBusinessModuleIds(this.dataDir, record.context.module_ids);
    return record;
  }

  create(value: unknown, owner: string, integration?: { kind: "luban"; message_id: string }): { record: KnowledgeAnswerRecord; replayed: boolean } {
    if (this.closed) throw new KnowledgeAnswerError(503, "问答服务正在停止，请稍后重试");
    const input = knowledgeAnswerInput(value);
    if (integration) {
      if (!integration.message_id || integration.message_id.length > 200) throw new KnowledgeAnswerError(400, "请提供有效的消息编号");
      const previous = [...this.records.values()].find(record => record.owner === owner && record.integration?.kind === integration.kind && record.integration.message_id === integration.message_id);
      if (previous) {
        if (JSON.stringify(knowledgeAnswerInput(previous, true)) !== JSON.stringify(input)) throw new KnowledgeAnswerError(409, "同一消息编号已用于另一条问题");
        return { record: copy(previous), replayed: true };
      }
    }
    const pending = [...this.records.values()].filter(record => !terminal(record));
    if (pending.length >= 30 || pending.filter(record => record.owner === owner).length >= 3) throw new KnowledgeAnswerError(429, "已有问答正在处理，请等待完成或停止后再提问");
    const now = new Date().toISOString();
    const record: KnowledgeAnswerRecord = { ...input, id: `qa-${randomUUID()}`, owner, status: "queued", stage: "queued", created_at: now, updated_at: now,
      evidence: [], activity: [{ at: now, stage: "queued", message: "等待开始查询" }], warnings: [], ...(integration ? { integration: copy(integration) } : {}) };
    this.persist(record);
    this.records.set(record.id, record);
    queueMicrotask(() => this.pump());
    return { record: copy(record), replayed: false };
  }

  cancel(id: string, owner: string): KnowledgeAnswerRecord {
    const record = this.owned(id, owner);
    if (!terminal(record)) {
      record.status = "cancelled";
      record.error = "已停止本轮问答";
      delete record.answer;
      this.active.get(id)?.controller.abort(new Error("已停止本轮问答"));
      this.persist(record);
    }
    return copy(record);
  }

  feedback(id: string, owner: string, value: unknown): KnowledgeAnswerRecord {
    const record = this.owned(id, owner), input = value as { useful?: unknown; comment?: unknown } | undefined;
    if (record.status !== "done") throw new KnowledgeAnswerError(409, "问答完成后才能评价");
    if (typeof input?.useful !== "boolean" || (input.comment !== undefined && typeof input.comment !== "string") || String(input.comment ?? "").length > 2000) throw new KnowledgeAnswerError(400, "评价内容无效，说明最多 2000 字");
    record.feedback = { useful: input.useful, comment: String(input.comment ?? "").trim(), at: new Date().toISOString() };
    this.persist(record);
    return copy(record);
  }

  remove(id: string, owner: string): void {
    const record = this.owned(id, owner);
    // 先停止写入，迟到的模型结果不能重新创建已删除的问答。
    if (!terminal(record)) this.cancel(id, owner);
    rmSync(join(this.root, id), { recursive: true, force: true });
    this.records.delete(id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort(new Error("问答服务正在停止"));
    const failures: unknown[] = [];
    for (const record of this.records.values()) if (!terminal(record)) {
      record.status = "failed";
      record.error = "服务正在停止，本轮问答已结束；已取得的来源保留";
      delete record.answer;
      try { this.persist(record); } catch (error) { failures.push(error); }
    }
    await Promise.allSettled([...this.active.values()].map(value => value.work));
    if (failures.length) throw new KnowledgeAnswerError(503, "问答执行已停止，但部分停止记录未能保存，请检查数据目录");
  }

  private owned(id: string, owner: string): KnowledgeAnswerRecord {
    const record = ID.test(id) ? this.records.get(id) : undefined;
    if (!record || record.owner !== owner) throw new KnowledgeAnswerError(404, "问答不存在或无权查看");
    return record;
  }

  private persist(record: KnowledgeAnswerRecord) {
    record.updated_at = new Date().toISOString();
    const dir = join(this.root, record.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `record-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, join(dir, "record.json"));
  }

  private pump() {
    if (this.closed) return;
    for (const record of this.records.values()) {
      if (this.active.size >= this.concurrency) break;
      if (record.status !== "queued") continue;
      const controller = new AbortController();
      // 注册占位后再运行，防止很快结束的问答释放下一轮的执行权。
      const work = Promise.resolve().then(() => this.execute(record, controller));
      this.active.set(record.id, { controller, work });
      void work.finally(() => { this.active.delete(record.id); this.pump(); }).catch(() => undefined);
    }
  }

  private async execute(record: KnowledgeAnswerRecord, controller: AbortController) {
    if (record.status !== "queued" || controller.signal.aborted) return;
    record.status = "running";
    const snapshots = new Map<string, KnowledgeAnswerEvidence>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { const error = new Error("本轮问答超过时间预算，已取得的来源保留，请缩小问题范围后重试"); controller.abort(error); reject(error); }, this.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    const assertActive = () => { controller.signal.throwIfAborted(); if (record.status !== "running") throw new Error("本轮问答已停止"); };
    try {
      const execution = Promise.resolve().then(() => {
        assertActive();
        this.persist(record);
        return this.run({ record, root: join(this.root, record.id), signal: controller.signal,
        progress: (stage, message) => { assertActive(); record.stage = stage; record.activity.push({ at: new Date().toISOString(), stage, message: message.slice(0, 500) }); record.activity = record.activity.slice(-150); this.persist(record); },
        warn: message => { assertActive(); if (!record.warnings.includes(message)) { record.warnings.push(message.slice(0, 1000)); record.warnings = record.warnings.slice(-40); this.persist(record); } },
        addEvidence: evidence => {
          assertActive();
          if (!evidence.content || evidence.content.length > 40_000) throw new Error("来源片段过长，请分页读取");
          const digest = createHash("sha256").update(evidence.content).digest("hex");
          const identity = JSON.stringify([evidence.kind, evidence.title, digest, evidence.source_id, evidence.revision,
            evidence.repository, evidence.path, evidence.scope, evidence.start_line, evidence.end_line, evidence.location, !!evidence.truncated, evidence.url, evidence.image]);
          const previous = snapshots.get(identity); if (previous) return copy(previous);
          if (record.evidence.length >= 80 || record.evidence.reduce((total, row) => total + row.content.length, 0) + evidence.content.length > 240_000) throw new Error("本轮已取得的来源达到预算，请围绕已有依据回答并说明缺口");
          const saved: KnowledgeAnswerEvidence = { ...evidence, id: knowledgeAnswerEvidenceId(record.evidence.length), digest, retrieved_at: new Date().toISOString() };
          record.evidence.push(saved); snapshots.set(identity, saved); this.persist(record); return copy(saved);
        },
        });
      });
      // 先给取消和超时注册接收方，开始写盘或 runner 同步抛错也不会留下未处理的拒绝。
      const answer = await Promise.race([execution, deadline, aborted]);
      assertActive();
      if (!answer.markdown?.trim() || !Array.isArray(answer.evidence_ids) || !Array.isArray(answer.unknowns) || answer.evidence_ids.some(id => !record.evidence.some(row => row.id === id))) throw new Error("回答未通过来源校验，请重试");
      const completed: KnowledgeAnswerRecord = { ...record, answer: copy(answer), status: "done", stage: "done",
        activity: [...record.activity, { at: new Date().toISOString(), stage: "done" as const, message: "回答已生成，引用检查完成" }].slice(-150) };
      if (!validAnswer(completed)) throw new Error("回答引用未完整通过校验，请重试");
      this.persist(completed);
      Object.assign(record, completed);
    } catch (error) {
      controller.abort();
      if (record.status === "running") {
        record.status = "failed"; record.error = error instanceof Error ? error.message.slice(0, 1000) : "问答未完成，请重试"; delete record.answer;
        try { this.persist(record); } catch { record.error = "本轮问答已停止，但记录未能保存，请检查数据目录后重试"; }
      }
    } finally { if (timer) clearTimeout(timer); }
  }
}
