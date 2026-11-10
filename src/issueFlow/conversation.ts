/**
 * 问题域协作流投影(ADR-0018):events.jsonl 账本 → 任务侧
 * ConversationItem 同形状的条目数组,供「与 Agent 协作」对话框消费。
 *
 * 卡的账源是两条旁路,不走事件:Agent 卡(AskUserQuestion)来自
 * waiting.json 记录(options.agentCards,真 waiting_id/真状态——事件里
 * 的同名词 tool_requested 会因重放/子会话拒绝重复出现且 waiting_id
 * 恒空,拿它当卡源,等待中的卡会在流内多出误标"已决定"的影子);
 * 平台闸卡从会话状态投影(options.waitingCard)。决定条目(human_decision
 * 事件)带真 waiting_id,与卡条目按它连接。
 *
 * 本投影是协作流回放(回合/卡/裁决/插话/检视/回执六类);原复盘问答
 * 投影已随 #260 页签收敛退役,现场记录的人读面由本投影独承。
 *
 * 纪律同全部投影:旁路、fail-open、只追加——坏事件跳过,缺账本给空,
 * 绝不抛错拖垮页面;触顶保留最新并如实标注。
 */

import { existsSync, readFileSync } from "node:fs";
import type { WaitingRecord } from "../humanGate.ts";
import { cardQuestions } from "./documents.ts";
import { registeredStageTools } from "./stageRegistry.ts";

/** 一条事件账本行(只取投影消费的字段,写入方见 service.appendSessionEvent
 * 与 driver 的事件落账;形状对齐 semanticEvents.SemanticEvent)。 */
export interface IssueConversationEvent {
  eventId?: number;
  ts?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

/** 账本读取(旁路纪律:半行/坏行跳过、缺文件给空,绝不抛错)。服务与
 * 测试共用这一个读法,events_seen 才有唯一口径。 */
export function readConversationEvents(path: string): IssueConversationEvent[] {
  if (!existsSync(path)) return [];
  const rows: IssueConversationEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as IssueConversationEvent);
    } catch {
      // 半行(写入方还在写)跳过:投影是旁路,不是第二本账。
    }
  }
  return rows;
}

export interface IssueConversationQuestion {
  question: string;
  options: string[];
}

/** Agent 卡(AskUserQuestion)的账源形状:waiting.json 记录里投影消费
 * 的字段(HumanGate.all 的窄化投影)。卡的 waiting_id/状态/举起时刻
 * 都以记录为准——事件里的 tool_requested 只配对转录用(重放/子会话
 * 拒绝都会落同名词事件),不当卡源。 */
export type IssueConversationAgentCard = Pick<
  WaitingRecord,
  "waiting_id" | "step" | "created_at" | "question" | "status"
>;

/** 任务侧 ConversationItem(src/conversation.ts)的问题域子集+扩展:
 * 同名成员(session/turn/card/decision/steer)逐字段兼容——前端会话流
 * 组件按同一条渲染路径走;receipts 是问题域扩展(平台工具回执的流内
 * 留痕,任务侧同名的检视闭环成员在问题域无对应物)。 */
export type IssueConversationItem =
  | { kind: "session"; id: string; ts: string;
      phase: "started" | "ended"; resume?: boolean; detail?: string }
  | { kind: "turn"; id: string; ts: string; end_ts: string;
      texts: Array<{ ts: string; text: string; truncated: boolean;
        role: "narration" | "handoff" }>;
      steps: IssueConversationSteps; open: boolean }
  | { kind: "card"; id: string; ts: string; waiting_id: string; step: string;
      purpose: "confirmation" | "clarification";
      annotation_ids: string[];
      questions: IssueConversationQuestion[];
      status: "waiting" | "resolved" | "superseded" }
  | { kind: "decision"; id: string; ts: string; waiting_id: string; by?: string;
      decision: string; notes: string;
      purpose: "confirmation" | "clarification";
      annotation_ids: string[];
      questions?: IssueConversationQuestion[] }
  | { kind: "steer"; id: string; ts: string; text: string; delivered: boolean }
  | { kind: "review"; id: string; ts: string; count: number; text: string; receipt?: string; delivery_mode?: "incremental" }
  | { kind: "receipts"; id: string; ts: string;
      items: Array<{ name: string; outcome: "success" | "error"; summary: string }> };

/** 回合步骤计数(形状对齐任务侧 ConversationSteps)。 */
/** 回合步骤计数(逐字段对齐任务侧 ConversationSteps)。 */
export interface IssueConversationSteps {
  calls: number;
  errors: number;
  reads: number;
  edits: number;
  bash: number;
  agents: number;
  /** 最能说明"这回合干了什么"的几步(改了哪些文件、跑了什么命令)。 */
  sample: Array<{ kind: "edit" | "bash" | "agent"; subject: string }>;
}

export interface IssueConversationView {
  items: IssueConversationItem[];
  /** 账本里读到的全部事件行数(含被投影跳过的)——前端"已读水位"。 */
  events_seen: number;
  truncated: boolean;
}

export interface IssueConversationOptions {
  /** 活会话尚未消费的消息，不把 steer 入队冒充已读取。 */
  pendingSteers?: string[];
  /** 当前在场未作答的平台闸(从会话状态来,不在账本里):投影为流末尾
   * 的 waiting 卡。闸在场即等待,不需要运行位。 */
  waitingCard?: {
    waiting_id?: string;
    step?: string;
    question?: string;
    options?: string[];
  };
  /** Agent 卡(AskUserQuestion)的 waiting.json 记录(HumanGate.all 的
   * 窄化投影):卡条目的唯一账源。等待中的那条由前端卡座按 waiting_id
   * 去重(钉在流末尾),历史已决/已作废的照常只读回放。 */
  agentCards?: IssueConversationAgentCard[];
  /** 条目数上限(触顶保留最新)。 */
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 800;
const STEP_SAMPLE_LIMIT = 8;
const RECEIPTS_SUMMARY_LIMIT = 120;

/** 回执只留平台工具的:阶段注册表登记过的工具全集(拉仓/推分支/建
 * MR/申报…)。bash、读文件这类过程性调用已计入回合 steps,不再单列
 * 刷屏;AskUserQuestion 是卡不是回执。 */
const PLATFORM_TOOLS = new Set(registeredStageTools());

/** 工具名 → 回合步骤归类(名字启发式,与任务侧 steps 同一口径的近似)。 */
function classifyTool(name: string): {
  reads: boolean; edits: boolean; agents: boolean;
  sample?: { kind: "edit" | "bash" | "agent"; subject: string };
} {
  const lower = name.toLowerCase();
  if (lower === "bash") {
    return { reads: false, edits: false, agents: false,
      sample: undefined }; // bash 的 subject 在 input.command,由调用方补
  }
  const reads = /^(read|inspect|view|grep|lookup|get_issue_meta|dts_get_ticket)/.test(lower);
  const edits = /(edit|write|str_replace)/.test(lower);
  const agents = /(agent|spawn)/.test(lower);
  return {
    reads, edits, agents,
    ...(edits ? { sample: { kind: "edit" as const, subject: name } } : {}),
    ...(agents ? { sample: { kind: "agent" as const, subject: name } } : {}),
  };
}

/** 一行结果文本 → 回执摘要(首行,截断)。 */
function receiptSummary(result: unknown): string {
  const firstLine = String(result ?? "").split("\n")[0]?.trim() ?? "";
  return firstLine.length > RECEIPTS_SUMMARY_LIMIT
    ? firstLine.slice(0, RECEIPTS_SUMMARY_LIMIT) + "…"
    : firstLine;
}

/** 事件账本 → 协作流条目。纯函数:不读盘、不改状态,事件行由调用方
 * 给(service 从账本读,测试直接构造)。 */
export function issueConversation(
  events: IssueConversationEvent[],
  options: IssueConversationOptions = {},
): IssueConversationView {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const items: IssueConversationItem[] = [];

  /** 当前悬置回合(assistant 发言与工具步骤的聚合容器)。 */
  let turn: Extract<IssueConversationItem, { kind: "turn" }> | undefined;
  const closeTurn = () => {
    if (!turn) return;
    turn.open = false;
    turn.end_ts = turn.texts.at(-1)?.ts ?? turn.ts;
    // 收口语:收口前的最后一句 agent 发言是交接语,其余是过程话。
    if (turn.texts.length > 0) {
      turn.texts[turn.texts.length - 1].role = "handoff";
    }
    turn = undefined;
  };
  const openTurn = (id: string, ts: string) => {
    turn = { kind: "turn", id, ts, end_ts: ts, texts: [],
      steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0,
        agents: 0, sample: [] },
      open: true };
    items.push(turn);
    return turn;
  };

  for (const event of events) {
    const kind = String(event?.kind ?? "");
    const payload = (event?.payload ?? {}) as Record<string, unknown>;
    const ts = String(event?.ts ?? "");
    const id = String(event?.eventId ?? ts);

    switch (kind) {
      case "session_started":
        closeTurn();
        items.push({ kind: "session", id, ts, phase: "started",
          ...(payload.resume === true ? { resume: true } : {}) });
        break;
      case "session_ended":
        closeTurn();
        items.push({ kind: "session", id, ts, phase: "ended",
          ...(payload.detail ? { detail: String(payload.detail) } : {}) });
        break;
      case "assistant_message": {
        if (!turn) openTurn(id, ts);
        turn!.texts.push({ ts, text: String(payload.text ?? ""),
          truncated: false, role: "narration" });
        break;
      }
      case "tool_requested": {
        // AskUserQuestion 不从事件出卡:事件的 waiting_id 恒空、状态只有
        // "发生过",拿它当卡源,等待中的卡会在流内多出一份误标"已决定"
        // 的影子,重建会话的重放与子会话拒绝还会让同一张卡成倍繁殖
        // (用户实测:当前卡上方叠着几张一模一样的"已决定"卡)。卡的
        // 账源是 options.agentCards(waiting.json 记录),见流末投影。
        const name = String(payload.name ?? "");
        if (name === "AskUserQuestion") break;
        if (!turn) openTurn(id, ts);
        const bucket = turn!.steps;
        bucket.calls += 1;
        const lower = name.toLowerCase();
        const input = (payload.input ?? {}) as {
          command?: unknown; path?: unknown; file?: unknown;
        };
        if (lower === "bash") {
          bucket.bash += 1;
          if (bucket.sample.length < STEP_SAMPLE_LIMIT) {
            bucket.sample.push({ kind: "bash",
              subject: String(input.command ?? "").slice(0, 60) });
          }
        } else {
          const classified = classifyTool(name);
          if (classified.reads) bucket.reads += 1;
          if (classified.edits) {
            bucket.edits += 1;
            if (bucket.sample.length < STEP_SAMPLE_LIMIT) {
              bucket.sample.push({ kind: "edit",
                subject: String(input.path ?? input.file ?? name).slice(0, 60) });
            }
          }
          if (classified.agents) bucket.agents += 1;
        }
        break;
      }
      case "tool_finished": {
        // 错误计数在此补(调用本身在 tool_requested 已计);平台工具回执
        // 另出 receipts 条目留痕,相邻回执聚成一组,不刷屏。
        const name = String(payload.name ?? "");
        const error = payload.is_error === true;
        if (turn && error) turn.steps.errors += 1;
        if (PLATFORM_TOOLS.has(name)) {
          const entry = { name,
            outcome: error ? "error" as const : "success" as const,
            summary: receiptSummary(payload.result) };
          const last = items.at(-1);
          if (last?.kind === "receipts") last.items.push(entry);
          else items.push({ kind: "receipts", id, ts, items: [entry] });
        }
        break;
      }
      case "user_message":
        closeTurn();
        items.push({ kind: "steer", id, ts,
          text: String(payload.display ?? payload.text ?? ""),
          delivered: !(options.pendingSteers ?? []).includes(String(payload.text ?? "")) });
        break;
      case "human_decision":
        closeTurn();
        items.push({ kind: "decision", id, ts,
          waiting_id: String(payload.waiting_id ?? ""),
          decision: String(payload.decision ?? ""),
          notes: String(payload.notes ?? ""),
          annotation_ids: [],
          // 平台闸作答带问句快照(闸答完即从 issue.json 消失,问句只能
          // 随事件走)——快照在场即平台确认,缺席是 Agent 卡的澄清答复。
          ...((payload.gate as { questions?: unknown } | undefined)?.questions
            ? { purpose: "confirmation" as const,
              questions: cardQuestions(payload.gate) }
            : { purpose: "clarification" as const }) });
        break;
      case "review_submitted":
        items.push({ kind: "review", id, ts,
          count: Number(payload.count ?? 0),
          ...(payload.mode === "incremental" ? { delivery_mode: "incremental" as const, receipt: String(payload.receipt ?? "") } : {}),
          text: String(payload.text ?? "") });
        break;
      case "turn_finished":
        closeTurn();
        break;
      default:
        break; // agent_spawned/session 之外的过程事件不进协作流
    }
  }

  // Agent 卡:waiting.json 记录投影(真 waiting_id/真状态),human_decision
  // 事件出的决定条目按 waiting_id 与它对上(卡上选项高亮靠这条连接)。
  // 排序按举起时刻入列,与回合/决定的先后由账本时间轴统一裁决。
  for (const record of options.agentCards ?? []) {
    const purpose = (record.question as { purpose?: unknown }).purpose
      === "clarification" ? "clarification" as const : "confirmation" as const;
    items.push({
      kind: "card", id: `card-${record.waiting_id}`, ts: record.created_at,
      waiting_id: record.waiting_id, step: record.step,
      purpose, annotation_ids: [],
      questions: cardQuestions(record.question),
      status: record.status,
    });
  }

  // 在场未作答的平台闸:不在账本里(答了才落账),从会话状态投影为
  // waiting 卡,钉在流末尾——协作流的"现在进行时"。闸在场即等待,
  // 不看运行位。
  if (options.waitingCard) {
    items.push({ kind: "card", id: options.waitingCard.waiting_id || "live",
      ts: new Date().toISOString(),
      waiting_id: options.waitingCard.waiting_id || "live",
      step: options.waitingCard.step ?? "",
      purpose: "confirmation", annotation_ids: [],
      questions: options.waitingCard.question
        ? [{ question: options.waitingCard.question,
          options: options.waitingCard.options ?? [] }]
        : [],
      status: "waiting" });
  }

  // 同一毫秒的并列按类序:卡在它前面那段话之后,裁决在卡之后(任务侧
  // 同款 rank;账本本身按落盘序即时间序,sort 是稳定的)。
  const rank: Record<IssueConversationItem["kind"], number> = {
    session: 0, turn: 1, steer: 2, card: 4, decision: 5,
    review: 6, receipts: 6,
  };
  const instant = (ts: string) => {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  items.sort((left, right) =>
    (instant(left.ts) - instant(right.ts))
    || (rank[left.kind] - rank[right.kind]));

  const truncated = items.length > maxItems;
  return {
    items: truncated ? items.slice(-maxItems) : items,
    events_seen: events.length,
    truncated,
  };
}
