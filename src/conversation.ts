/**
 * 会话流(只读旁路):把"人和 Agent 之间发生过什么、现在轮到谁"从几本
 * 现场账里读成一条流,给工作台右栏用。
 *
 * 边界(2026-09-05 用户拍板):流里只放**回合**——面向人的交接:Agent 说的
 * 话、举的卡、人的决定、插话、批注与回执、外部检视意见、会话起止;
 * 工具步骤(读了哪个文件、跑了什么命令)不进流,只在每个回合下折成一行
 * 计数,正本在「工作过程」。run7 真现场 1829 条事件里主会话只有 145 段
 * 话、22 次决定、6 次回合结束——按这个口径流是看得过来的。
 *
 * 数据源全部只读、各自独立降级(fail-open 红线):哪本账读不动就少哪
 * 一类条目,problems 里如实说;绝不因半行 JSON 毁整栏。它只呈现事实,
 * 不参与任何判定——阶段真相在 .mae-flow.json,意见处境在 feedbackPolicy。
 */

import type { Annotation, AnnotationOperation, AnnotationResolution } from "./annotations.ts";
import type { FeedbackRecord } from "./feedbackStore.ts";
import type { WaitingRecord } from "./humanGate.ts";
import type { PushFileList } from "./deliveryFileList.ts";

export interface ConversationSteps {
  calls: number;
  errors: number;
  reads: number;
  edits: number;
  bash: number;
  agents: number;
  /** 最能说明"这回合干了什么"的几步(改了哪些文件、跑了什么命令)。 */
  sample: Array<{ kind: "edit" | "bash" | "agent"; subject: string }>;
}

export interface AnnotationRef {
  id: string;
  author: string;
  kind: string;
  file: string;
  line: number;
  note: string;
}

export type ConversationItem =
  | { kind: "push_file_list"; id: string; ts: string; manifest: PushFileList }
  | {
      kind: "session"; id: string; ts: string;
      /** started = 会话开始/恢复;ended = 会话结束(带原因)。 */
      phase: "started" | "ended";
      resume?: boolean; reason?: string; detail?: string;
    }
  | {
      kind: "turn"; id: string; ts: string; end_ts: string;
      /** narration = 说完就去调工具的过程话("我先看一下…");handoff = 说完
       * 举卡 / 收口 / 等人的交接语。run7 真现场 145 段里 116 段是过程话——
       * 页面默认只摊开交接语。 */
      texts: Array<{ ts: string; text: string; truncated: boolean; role: "narration" | "handoff" }>;
      steps: ConversationSteps;
      /** 回合还没收尾(任务仍在跑):最后一条是"正在说的"。 */
      open: boolean;
    }
  | {
      kind: "card"; id: string; ts: string; waiting_id: string; step: string;
      purpose: "confirmation" | "clarification";
      annotation_ids: string[];
      questions: Array<{ question: string; options: string[] }>;
      status: "waiting" | "resolved" | "superseded";
    }
  | {
      kind: "decision"; id: string; ts: string; waiting_id: string;
      by?: string; decision: string; answers?: Record<string, string>;
      notes: string; purpose: "confirmation" | "clarification";
      annotation_ids: string[];
    }
  | {
      kind: "steer"; id: string; ts: string; text: string;
      references?: string[]; deferred?: "decision" | "mission";
      delivered: boolean;
    }
  | {
      kind: "annotations_sent"; id: string; ts: string; by?: string;
      via: string; items: AnnotationRef[];
    }
  | {
      kind: "receipts"; id: string; ts: string;
      items: Array<AnnotationRef & {
        outcome: string; summary: string; revision: number;
        /** 回执版本 = 意见当前版本。旧版本回执只是历史,不背书新文字。 */
        current: boolean; fixed_sha?: string;
      }>;
    }
  | {
      kind: "owner_reply"; id: string; ts: string; annotation: AnnotationRef;
      by: string; text: string;
    }
  | {
      kind: "clarified"; id: string; ts: string; annotation: AnnotationRef;
      by?: string; question: string; answer: string;
    }
  | { kind: "verified"; id: string; ts: string; annotation: AnnotationRef; by?: string; resolution?: AnnotationResolution }
  | {
      kind: "reopened"; id: string; ts: string; annotation: AnnotationRef;
      note?: string; returned: number; by?: string;
    }
  | { kind: "withdrawal_requested"; id: string; ts: string; annotation: AnnotationRef; by: string }
  | { kind: "revised"; id: string; ts: string; annotation: AnnotationRef }
  | { kind: "delivery_reset"; id: string; ts: string; annotation: AnnotationRef; reason: string }
  | {
      kind: "external"; id: string; ts: string; source: string; author?: string;
      items: Array<{
        id: string; summary: string; file?: string; line?: number;
        status: string; resolution?: string;
      }>;
    }
  | {
      kind: "assistant"; id: string; ts: string; role: "user" | "assistant";
      text: string;
    }
  | {
      /** 跨仓同步:拆分交付时相邻仓之间的"接口/约定变了"通知。received = 别的
       * 仓同步给本任务;published = 本任务(或主任务视角下的某个子仓)发出的。
       * 用户 2026-09-06 问"上下游通知是不是搞没了"——它原来只藏在流末尾一个
       * 折叠工具的二级折叠里,等于没有;现在按时间进流。 */
      kind: "sync"; id: string; ts: string; direction: "received" | "published";
      by: string; repository?: string; targets: number; text: string;
    };

export interface ConversationView {
  items: ConversationItem[];
  /** 事件账里的总条数,对账用(流里的条目远少于它是设计如此)。 */
  events_seen: number;
  /** 哪本账没读成(fail-open):页面如实提示,不假装"什么都没发生"。 */
  problems: string[];
}

export interface ConversationSources {
  events: Array<Record<string, any>>;
  waiting: WaitingRecord[];
  annotations: Annotation[];
  annotationHistory: AnnotationOperation[];
  feedback: FeedbackRecord[];
  /** 插话的送达事实(listInterrupts 的口径),按发出时刻对上事件。 */
  interrupts?: Array<{
    text: string; at: string; delivered: boolean;
    deferred?: "decision" | "mission"; references?: string[];
  }>;
  /** 开发助手接管期间的往来(它是另一个说话的人,不是主 Agent)。 */
  assistant?: Array<{ id: string; role: "user" | "assistant"; text: string; at: string }>;
  /** 本任务 id:用来判断跨仓同步是自己发的还是收到的。 */
  taskId?: string;
  /** 跨仓同步记录(task.summary.cross_repository_updates 的口径)。 */
  crossRepositoryUpdates?: Array<{
    id: string; source_task_id: string; source_repository?: string; author: string;
    text: string; target_task_ids: string[]; created_at: string;
  }>;
  running?: boolean;
  problems?: string[];
}

const MAIN_SESSION = "main";
const TEXT_LIMIT = 1600;
const NOTE_LIMIT = 240;
const SAMPLE_LIMIT = 3;
/** 同一批回执落账的时间差在这个窗口内就合成一条(receipts 文件一次读
 * 进来多条,responded_at 只差几毫秒)。 */
const BATCH_WINDOW_MS = 3_000;
const BARE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 旧事件账的裸串来自 toISOString 去掉 T/Z,是 UTC;新账直接是 ISO。 */
function normalizeTs(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  const candidate = BARE_TIMESTAMP.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const ms = new Date(candidate).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

function instant(ts: string): number {
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function clip(value: unknown, limit: number): { text: string; truncated: boolean } {
  const text = String(value ?? "").trim();
  return text.length > limit
    ? { text: text.slice(0, limit) + "…", truncated: true }
    : { text, truncated: false };
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : "…/" + parts.slice(-2).join("/");
}

/** 命令抬头去噪的口径与 activity.ts 同款(cd 前缀、内核绝对路径、EXIT 尾巴)。 */
function commandHeadline(command: string): string {
  const stripped = String(command ?? "")
    .replace(/^\s*cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/, "")
    .replace(/\b(?:python3?|py)\s+(?:'[^']*'|"[^"]*"|\S+)mae-flow\.py(['"]?)/g, "mae-flow")
    .replace(/\s*;\s*echo\s+\S*EXIT\S*=\$\?\s*$/i, "");
  return clip(stripped || command, 60).text;
}

function annotationRef(item: Annotation): AnnotationRef {
  return {
    id: item.id, author: item.author, kind: item.kind,
    file: item.file, line: item.line, note: clip(item.note, NOTE_LIMIT).text,
  };
}

function emptySteps(): ConversationSteps {
  return { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] };
}

function purposeOf(question: Record<string, unknown> | undefined): "confirmation" | "clarification" {
  return question?.purpose === "clarification" ? "clarification" : "confirmation";
}

function annotationIdsOf(question: Record<string, unknown> | undefined): string[] {
  const ids = question?.annotation_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

function questionsOf(question: Record<string, unknown> | undefined): Array<{ question: string; options: string[] }> {
  const list = question?.questions;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return {
      question: String(row.question ?? ""),
      options: Array.isArray(row.options) ? row.options.map(String) : [],
    };
  });
}

/** 主会话事件 → 回合 + 插话 + 会话起止。子会话只给回合计一个"派了子任务"。 */
function fromEvents(
  events: Array<Record<string, any>>,
  interrupts: NonNullable<ConversationSources["interrupts"]>,
  running: boolean,
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const deliveredAt = new Map<string, NonNullable<ConversationSources["interrupts"]>[number]>();
  for (const row of interrupts) deliveredAt.set(normalizeTs(row.at), row);

  let turn: Extract<ConversationItem, { kind: "turn" }> | undefined;
  let turnSeq = 0;
  // 一段话的角色要看它后面跟的是什么:跟工具调用 = 过程话;跟举卡/收口/换人
  // 说话 = 交接语。回合收口时还没定角色的按交接语算。
  const settle = (role: "narration" | "handoff") => {
    const last = turn?.texts.at(-1);
    if (last && last.role === "handoff" && role === "narration") last.role = "narration";
  };
  const flush = (endTs: string) => {
    if (!turn) return;
    if (turn.texts.length || turn.steps.calls || turn.steps.agents) {
      turn.end_ts = endTs || turn.end_ts;
      turn.open = false;
      items.push(turn);
    }
    turn = undefined;
  };
  const ensureTurn = (ts: string) => {
    if (!turn) {
      turnSeq += 1;
      turn = {
        kind: "turn", id: `turn-${turnSeq}`, ts, end_ts: ts,
        texts: [], steps: emptySteps(), open: true,
      };
    }
    turn.end_ts = ts;
    return turn;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const ts = normalizeTs(event.ts);
    const kind = String(event.kind ?? "");
    const payload = (event.payload ?? {}) as Record<string, any>;
    const session = String(event.sessionId ?? MAIN_SESSION);
    if (kind === "push_file_list") {
      flush(ts);
      items.push({ kind, id: `push-files-${event.eventId ?? index}`, ts, manifest: payload as PushFileList });
      continue;
    }
    if (session !== MAIN_SESSION) continue;      // 子会话/开发助手另有出口

    if (kind === "session_started") {
      flush(ts);
      items.push({
        kind: "session", id: `session-${index}`, ts, phase: "started",
        resume: payload.resume === true,
      });
      continue;
    }
    if (kind === "session_ended") {
      flush(ts);
      items.push({
        kind: "session", id: `session-${index}`, ts, phase: "ended",
        reason: String(payload.reason ?? ""),
        detail: clip(payload.detail, 300).text || undefined,
      });
      continue;
    }
    if (kind === "user_message") {
      flush(ts);
      if (payload.via === "interrupt") {
        const fact = deliveredAt.get(ts);
        const display = typeof payload.display === "string"
          ? payload.display : String(payload.text ?? "");
        const references = Array.isArray(payload.references)
          ? (payload.references as unknown[]).map(String) : undefined;
        const deferred = payload.deferred === "decision" || payload.deferred === "mission"
          ? payload.deferred as "decision" | "mission" : undefined;
        items.push({
          kind: "steer", id: `steer-${index}`, ts, text: clip(display, TEXT_LIMIT).text,
          ...(references?.length ? { references } : {}),
          ...(deferred ? { deferred } : {}),
          // 没对上送达账(旧账/读不动)按"已读取"算:这是展示,不是门禁。
          delivered: fact ? fact.delivered : true,
        });
      }
      // 使命/决定续跑的 prompt 是宿主拼的,决定那条账已经代表了人说的话。
      continue;
    }
    if (kind === "human_decision") {
      // 决定本身从 waiting.json 出(带谁点的、答了什么);这里只切回合。
      flush(ts);
      continue;
    }
    if (kind === "turn_finished") {
      flush(ts);
      continue;
    }
    if (kind === "assistant_message") {
      const text = clip(payload.text, TEXT_LIMIT);
      if (!text.text) continue;
      ensureTurn(ts).texts.push({ ts, ...text, role: "handoff" });
      continue;
    }
    if (kind === "tool_requested") {
      // 举卡前那段话是交接语(它就是卡的"决策背景");其它工具前的是过程话。
      if (String(payload.name ?? "") !== "AskUserQuestion") settle("narration");
      continue;
    }
    if (kind === "tool_finished") {
      const name = String(payload.name ?? "");
      if (name === "AskUserQuestion") continue;  // 卡那条账已经在流里
      settle("narration");
      const current = ensureTurn(ts);
      const input = (payload.input ?? {}) as Record<string, unknown>;
      current.steps.calls += 1;
      if (payload.is_error === true) current.steps.errors += 1;
      if (name === "Read") current.steps.reads += 1;
      else if (name === "Edit" || name === "Write") {
        current.steps.edits += 1;
        const subject = shortPath(String(input.file_path ?? input.path ?? ""));
        if (subject && current.steps.sample.length < SAMPLE_LIMIT
            && !current.steps.sample.some((entry) => entry.subject === subject)) {
          current.steps.sample.push({ kind: "edit", subject });
        }
      } else if (name === "Bash") {
        current.steps.bash += 1;
        const subject = commandHeadline(String(input.command ?? ""));
        if (subject && current.steps.sample.length < SAMPLE_LIMIT
            && !current.steps.sample.some((entry) => entry.subject === subject)) {
          current.steps.sample.push({ kind: "bash", subject });
        }
      }
      continue;
    }
    if (kind === "agent_spawned") {
      settle("narration");
      const current = ensureTurn(ts);
      current.steps.agents += 1;
      const subject = clip(payload.description ?? payload.agent_type ?? "子任务", 60).text;
      if (current.steps.sample.length < SAMPLE_LIMIT) {
        current.steps.sample.push({ kind: "agent", subject });
      }
      continue;
    }
  }
  if (turn) {
    const last = turn as Extract<ConversationItem, { kind: "turn" }>;
    if (last.texts.length || last.steps.calls || last.steps.agents) {
      last.open = running;
      items.push(last);
    }
  }
  return items;
}

function fromWaiting(records: WaitingRecord[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const record of records) {
    const purpose = purposeOf(record.question);
    const annotationIds = annotationIdsOf(record.question);
    items.push({
      kind: "card", id: `card-${record.waiting_id}`, ts: normalizeTs(record.created_at),
      waiting_id: record.waiting_id, step: record.step, purpose,
      annotation_ids: annotationIds, questions: questionsOf(record.question),
      status: record.status,
    });
    if (record.status === "resolved" && record.resolved_at) {
      items.push({
        kind: "decision", id: `decision-${record.waiting_id}`,
        ts: normalizeTs(record.resolved_at), waiting_id: record.waiting_id,
        ...(record.decided_by ? { by: record.decided_by } : {}),
        decision: record.decision, ...(record.answers ? { answers: record.answers } : {}),
        notes: record.notes ?? "", purpose, annotation_ids: annotationIds,
      });
    }
  }
  return items;
}

/** 批注账按操作回放成流条目。回放时的"当前版本"要按操作顺序算——
 * 回执对不对得上版本,看的是它落账那一刻的 rework,不是今天的。 */
function fromAnnotations(
  annotations: Annotation[],
  history: AnnotationOperation[],
): ConversationItem[] {
  const byId = new Map(annotations.map((item) => [item.id, item]));
  const revision = new Map<string, number>();
  const returned = new Map<string, number>();
  const wasSent = new Set<string>();
  const ownerPending = new Set<string>();
  const ownerClosed = new Set<string>();
  const items: ConversationItem[] = [];
  type Receipt = Extract<ConversationItem, { kind: "receipts" }>;
  let lastReceipt: Receipt | undefined;
  type Sent = Extract<ConversationItem, { kind: "annotations_sent" }>;

  history.forEach((operation, index) => {
    if (operation.op === "add") {
      revision.set(operation.record.id, operation.record.rework ?? 0);
      returned.set(operation.record.id, operation.record.returned ?? 0);
      if (operation.record.needs_owner_closure) ownerPending.add(operation.record.id);
      if (operation.record.resolution) ownerClosed.add(operation.record.id);
      return;
    }
    if (operation.op === "sent") {
      const ts = normalizeTs(operation.at);
      const refs = (operation.ids ?? []).filter((id) => !ownerClosed.has(id))
        .map((id) => byId.get(id)).filter((item): item is Annotation => !!item)
        .map(annotationRef);
      if (!refs.length) return;
      for (const ref of refs) wasSent.add(ref.id);
      const item: Sent = {
        kind: "annotations_sent", id: `sent-${index}`, ts,
        ...(operation.by ? { by: operation.by } : {}),
        via: operation.via, items: refs,
      };
      items.push(item);
      return;
    }
    if (operation.op === "respond") {
      const target = byId.get(operation.id);
      if (!target) return;
      const ts = normalizeTs(operation.response?.responded_at);
      const current = !ownerClosed.has(operation.id)
        && (operation.response?.revision ?? 0) === (revision.get(operation.id) ?? 0);
      const row = {
        ...annotationRef(target),
        outcome: String(operation.response?.outcome ?? ""),
        summary: clip(operation.response?.summary, 600).text,
        revision: operation.response?.revision ?? 0,
        current,
        ...(operation.response?.fixed_sha ? { fixed_sha: operation.response.fixed_sha } : {}),
      };
      if (lastReceipt && Math.abs(instant(ts) - instant(lastReceipt.ts)) <= BATCH_WINDOW_MS
          && !lastReceipt.items.some((entry) => entry.id === row.id)) {
        lastReceipt.items.push(row);
      } else {
        lastReceipt = { kind: "receipts", id: `receipts-${index}`, ts, items: [row] };
        items.push(lastReceipt);
      }
      return;
    }
    if (operation.op === "owner_reply") {
      const target = byId.get(operation.id);
      if (!target) return;
      items.push({
        kind: "owner_reply", id: `owner-${index}`,
        ts: normalizeTs(operation.reply?.replied_at), annotation: annotationRef(target),
        by: String(operation.reply?.author ?? ""), text: clip(operation.reply?.text, TEXT_LIMIT).text,
      });
      return;
    }
    if (operation.op === "clarified") {
      const target = byId.get(operation.id);
      if (!target) return;
      // 追问原文在回放后的 clarifications 里(按答复时刻对上)。
      const asked = (target.clarifications ?? []).find((entry) =>
        entry.answered_at === operation.at && entry.answer === operation.answer);
      items.push({
        kind: "clarified", id: `clarified-${index}`, ts: normalizeTs(operation.at),
        annotation: annotationRef(target), ...(operation.by ? { by: operation.by } : {}),
        question: clip(asked?.question, 600).text, answer: clip(operation.answer, TEXT_LIMIT).text,
      });
      return;
    }
    if (operation.op === "owner_resolution" || operation.op === "withdraw_request") {
      const target = byId.get(operation.id);
      if (!target) return;
      if (operation.op === "owner_resolution") {
        ownerClosed.add(operation.id);
        ownerPending.delete(operation.id);
        items.push({
        kind: "verified", id: `resolution-${index}`, ts: normalizeTs(operation.resolution.at),
        annotation: annotationRef(target), by: operation.resolution.by, resolution: operation.resolution,
        });
      } else {
        ownerPending.add(operation.id);
        items.push({
        kind: "withdrawal_requested", id: `withdrawal-${index}`, ts: normalizeTs(operation.at),
        annotation: annotationRef(target), by: operation.by,
        });
      }
      return;
    }
    if (operation.op === "verify") {
      const target = byId.get(operation.id);
      if (!target) return;
      items.push({
        kind: "verified", id: `verified-${index}`, ts: normalizeTs(operation.at),
        annotation: annotationRef(target), ...(operation.by ? { by: operation.by } : {}),
      });
      return;
    }
    if (operation.op === "delivery_reset") {
      const target = byId.get(operation.id);
      revision.set(operation.id, (revision.get(operation.id) ?? 0) + 1);
      wasSent.delete(operation.id);
      if (target) items.push({ kind: "delivery_reset", id: `delivery-reset-${index}`,
        ts: normalizeTs(operation.at), annotation: annotationRef(target),
        reason: clip(operation.reason, NOTE_LIMIT).text });
      return;
    }
    if (operation.op === "reopen") {
      ownerClosed.delete(operation.id);
      if (operation.owner_controlled) ownerPending.add(operation.id);
      const target = byId.get(operation.id);
      revision.set(operation.id, (revision.get(operation.id) ?? 0) + 1);
      returned.set(operation.id, (returned.get(operation.id) ?? 0) + 1);
      if (!target) return;
      items.push({
        kind: "reopened", id: `reopened-${index}`, ts: normalizeTs(operation.at),
        ...(operation.by ? { by: operation.by } : {}),
        annotation: annotationRef(target),
        ...(operation.note ? { note: clip(operation.note, NOTE_LIMIT).text } : {}),
        returned: returned.get(operation.id) ?? 1,
      });
      return;
    }
    if (operation.op === "edit") {
      const target = byId.get(operation.id);
      // 改的是已送出的意见才算"改字重提"(版本 +1);草稿改字不进流。
      if (!wasSent.has(operation.id) && !ownerPending.has(operation.id)
          && !(operation.owner_controlled && (revision.get(operation.id) ?? 0) > 0)) return;
      if (operation.owner_controlled) ownerPending.add(operation.id);
      ownerClosed.delete(operation.id);
      revision.set(operation.id, (revision.get(operation.id) ?? 0) + 1);
      wasSent.delete(operation.id);
      if (!target) return;
      items.push({
        kind: "revised", id: `revised-${index}`, ts: normalizeTs(operation.at),
        annotation: { ...annotationRef(target), note: clip(operation.note, NOTE_LIMIT).text },
      });
      return;
    }
  });
  return items;
}

/** 外部来源(CodeHub 讨论、流水线、Build-Fix、冲突)按批次合成一条;
 * 工作台来源的反馈已经以批注身份在流里,不重复。 */
function fromFeedback(feedback: FeedbackRecord[]): ConversationItem[] {
  const batches = new Map<string, FeedbackRecord[]>();
  for (const record of feedback) {
    if (record.source === "workspace" || record.source === "push_confirmation") continue;
    const key = `${record.source}:${record.batch_id}`;
    batches.set(key, [...(batches.get(key) ?? []), record]);
  }
  return [...batches.entries()].map(([key, records]) => {
    const ts = records.map((record) => normalizeTs(record.updated_at))
      .filter(Boolean).sort()[0] ?? "";
    const author = records.find((record) => record.author)?.author;
    return {
      kind: "external" as const, id: `external-${key}`, ts,
      source: records[0].source, ...(author ? { author } : {}),
      items: records.map((record) => ({
        id: record.id, summary: clip(record.summary, 600).text,
        ...(record.file ? { file: record.file } : {}),
        ...(typeof record.line === "number" ? { line: record.line } : {}),
        status: record.status,
        ...(record.resolution ? { resolution: clip(record.resolution, 300).text } : {}),
      })),
    };
  });
}

export function buildConversation(sources: ConversationSources): ConversationView {
  const problems = [...(sources.problems ?? [])];
  const items: ConversationItem[] = [
    ...fromEvents(sources.events, sources.interrupts ?? [], sources.running ?? false),
    ...fromWaiting(sources.waiting),
    ...fromAnnotations(sources.annotations, sources.annotationHistory),
    ...fromFeedback(sources.feedback),
    ...(sources.assistant ?? []).map((message) => ({
      kind: "assistant" as const, id: `assistant-${message.id}`,
      ts: normalizeTs(message.at), role: message.role,
      text: clip(message.text, TEXT_LIMIT).text,
    })),
    ...(sources.crossRepositoryUpdates ?? []).map((update) => ({
      kind: "sync" as const, id: `sync-${update.id}`, ts: normalizeTs(update.created_at),
      direction: (update.source_task_id === sources.taskId ? "published" : "received") as
        "published" | "received",
      by: update.author,
      ...(update.source_repository ? { repository: update.source_repository } : {}),
      targets: update.target_task_ids.length,
      text: clip(update.text, TEXT_LIMIT).text,
    })),
  ];
  // 同一毫秒的并列按来源顺序:卡在它前面那段话之后,决定在卡之后。批注
  // 账的各类条目同一档——它们之间的先后就是台账顺序(sort 是稳定的)。
  const rank: Record<ConversationItem["kind"], number> = {
    session: 0, turn: 1, steer: 2, external: 3, card: 4, decision: 5, push_file_list: 5,
    annotations_sent: 6, receipts: 6, owner_reply: 6, clarified: 6,
    withdrawal_requested: 6, verified: 6, reopened: 6, revised: 6, delivery_reset: 6, assistant: 8, sync: 3,
  };
  items.sort((left, right) =>
    (instant(left.ts) - instant(right.ts)) || (rank[left.kind] - rank[right.kind]));
  return { items, events_seen: sources.events.length, problems };
}
