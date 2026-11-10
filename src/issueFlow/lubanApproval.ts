/**
 * 问题会话等待卡 → 小鲁班手机审批的适配层。
 *
 * 手机审批网关只认 LubanApprovalService(list/decide)一个口,过去
 * 只有 TaskService 实现它——问题会话的等待卡通知里带着审批码,手机
 * 回复却总吃"审批码已过期":网关在需求任务里查不到这张卡。本适配层
 * 把问题流的等待卡(平台闸卡与 Agent 问题卡,与 answer() 同一优先
 * 级:闸优先)投影成同一形状,decide 再翻译回 IssueFlowService.answer
 * 的作答协议:
 * - 平台闸:选项 label 反查闸上码表得 code,自由文本作 decision
 *   (证据回灌闸的文本主通道由 answer() 归码 supply);
 * - Agent 卡:选项 label 反查投影码得 opt-题-序(自由文本原样透传,
 *   decodeAgentDecision 兜底)。
 * 审批真相仍只在问题会话一处(issue.json 的闸 / waiting.json 的 Agent
 * 卡),这里不存第二份状态;list 现查现投影,decide 重新取卡再作答,
 * 状态版本对不上由 answer() 打回、网关回"审批码已过期"。
 */

import {
  ApprovalRejection,
  type LubanApprovalService,
} from "../lubanApproval.ts";
import type { TaskSummary } from "../taskService.ts";
import type { WaitingRecord } from "../humanGate.ts";
import { IssueControlError } from "./errors.ts";
import type { IssueFlowService } from "./service.ts";
import type { IssueGate, IssueSummary } from "./state.ts";

/** 手机审批评论的固定前缀(网关 submit 硬加的审计词)。问题会话的
 * 留痕位(notes)自己会记"来自手机审批"的语义吗?不会——前缀剥掉,
 * 只留用户的原话;来源是手机这件事由决定走的是哪条协议口自证。 */
const APPROVAL_COMMENT_PREFIX = "小鲁班手机审批：";

/** 投影给展示层的选项:label 给人看,codes 供 decide 反查。 */
interface CardQuestion {
  question: string;
  labels: string[];
  codes: string[];
}

/** 问题会话状态 → 需求任务状态词(仅 decide 返回值用;网关不读它,
 * 但接口形状要求 TaskSummary)。 */
const STATUS_ALIASES: Record<string, TaskSummary["status"]> = {
  queued: "queued",
  running: "running",
  waiting_user: "waiting_for_human",
  idle: "running",
  archived: "completed",
  canceled: "canceled",
  failed: "failed",
};

function stripApprovalComment(comment: string | undefined): string | undefined {
  const trimmed = comment?.trim();
  if (!trimmed || trimmed === "小鲁班手机审批") return undefined;
  const stripped = trimmed.startsWith(APPROVAL_COMMENT_PREFIX)
    ? trimmed.slice(APPROVAL_COMMENT_PREFIX.length).trim()
    : trimmed;
  return stripped || undefined;
}

/** get() 投影后的 Agent 卡选项可能是 {code,label}(现行协议)或旧
 * 现场的纯字符串(withAgentOptionCodes 对无题卡原样返回)。统一成
 * label/codes 两行,缺码的按「题号-序号」机械补码——与 service 的
 * agentOptionCode 同一把尺。 */
function cardQuestions(source: {
  gate?: IssueGate;
  waiting?: WaitingRecord;
}): CardQuestion[] {
  if (source.gate) {
    return source.gate.question.questions.map((item) => ({
      question: item.question,
      labels: item.options.map((option) => option.label),
      codes: item.options.map((option) => option.code),
    }));
  }
  const raw = (source.waiting?.question as {
    questions?: Array<{
      question?: unknown;
      options?: unknown;
    }>;
  })?.questions ?? [];
  // 索引纪律:labels/codes 与卡上题序逐位对齐,不过滤不重排——
  // decide 的作答键是卡上的题号,错位就是把用户的选择安到别的题上。
  // 空题面按序号补个称呼(它只是网关回传答案的键,页面上看不到)。
  return raw.map((item, questionIndex) => {
    const options = Array.isArray(item.options) ? item.options : [];
    const labels: string[] = [];
    const codes: string[] = [];
    options.forEach((option, optionIndex) => {
      const fallbackCode = `opt-${questionIndex}-${optionIndex}`;
      if (typeof option === "string") {
        labels.push(option);
        codes.push(fallbackCode);
        return;
      }
      const record = option as { code?: unknown; label?: unknown };
      labels.push(String(record.label ?? ""));
      codes.push(String(record.code ?? fallbackCode));
    });
    return {
      question: String(item.question ?? "").trim()
        || `问题 ${questionIndex + 1}`,
      labels,
      codes,
    };
  });
}

export class IssueFlowLubanApproval implements LubanApprovalService {
  constructor(private readonly issues: IssueFlowService) {}

  list(): TaskSummary[] {
    return this.issues.list()
      .filter((issue) => issue.status === "waiting_user")
      .flatMap((issue) => {
        try {
          const card = this.card(issue.id);
          return card ? [card] : [];
        } catch {
          // list 快照与盘上竞速:卡刚被答掉/会话刚转移就跳过,
          // 下一轮现查自然跟上。
          return [];
        }
      });
  }

  async decide(id: string, input: {
    state_version: number;
    selected_options?: Record<string, string>;
    free_responses?: Record<string, string>;
    comment?: string;
  }): Promise<TaskSummary> {
    const full = this.issues.get(id);
    const questions = cardQuestions(full);
    if (!questions.length) {
      throw new IssueControlError(
        `当前状态 ${full.status} 没有等待中的问题卡`);
    }
    const notes = stripApprovalComment(input.comment);
    // 手机端的选择/自由文本都按「题面文本 → 题号」归位;题面对不上
    // 说明卡已换(重跑/回退),按状态漂移打回让用户重新拉待办。
    const chosen = new Map<number, { label?: string; text?: string }>();
    const locate = (questionText: string): number => {
      const index = questions.findIndex((item) => item.question === questionText);
      if (index < 0) {
        throw new IssueControlError(
          "问题卡状态已变化,请重新发送:mae-flow 待审批");
      }
      return index;
    };
    for (const [questionText, label] of Object.entries(input.selected_options ?? {})) {
      chosen.set(locate(questionText), { label });
    }
    for (const [questionText, text] of Object.entries(input.free_responses ?? {})) {
      chosen.set(locate(questionText), { text });
    }
    if (!chosen.size) {
      throw new IssueControlError("作答没有带上任何选择或说明");
    }

    try {
      if (full.gate) {
        this.answerGate(id, full, questions, chosen, notes);
      } else {
        this.answerAgentCard(id, full, questions, chosen, notes);
      }
    } catch (error) {
      // 状态漂移类原样上抛(网关按 stale 词表回"审批码已过期");
      // 其余域打回包成 ApprovalRejection,人话直出手机端。
      if (error instanceof IssueControlError
          && !/状态已变化|没有等待中的问题卡/.test(error.message)) {
        throw new ApprovalRejection(error.message);
      }
      throw error;
    }
    const after = this.issues.get(id);
    return this.card(after.id) ?? {
      id: after.id,
      title: after.title,
      requirement: after.description || after.title,
      ticket: after.ticket,
      status: STATUS_ALIASES[after.status] ?? "running",
      origin: "issue",
      luban_account: after.account,
      workspace: "",
      created_at: after.created_at,
    };
  }

  /** 平台闸:恒为单题。label 反查码表得 code;自由文本作 decision
   * (证据回灌闸的主通道,answer() 会归码 supply)。「填写补充说明」
   * 类选项必须带说明——与页面卡片的表单纪律一致,空补充不放行。 */
  private answerGate(
    id: string,
    full: IssueSummary,
    questions: CardQuestion[],
    chosen: Map<number, { label?: string; text?: string }>,
    notes: string | undefined,
  ): void {
    const gate = full.gate!;
    const answer = chosen.get(0);
    if (!answer) {
      throw new IssueControlError(
        `问题卡状态已变化,请重新发送:mae-flow 待审批`);
    }
    let code: string | undefined;
    let decision: string | undefined;
    if (answer.label !== undefined) {
      const index = questions[0]?.labels.indexOf(answer.label) ?? -1;
      code = index >= 0 ? gate.question.questions[0]?.options[index]?.code : undefined;
      // 认不得的选项当自由作答交出去:gateVerdict 的 unrecognized
      // 会原样打回,现场账能看到交上来的到底是什么。
      decision = index >= 0 ? undefined : answer.label;
      const label = index >= 0 ? questions[0].labels[index] : "";
      if (code && /填写/.test(label) && !notes && !decision) {
        throw new IssueControlError(
          `「${label}」需要附上说明:请回复"序号:你的说明",或使用"自由回复:"`);
      }
    } else {
      decision = answer.text;
    }
    this.issues.answer(id, {
      state_version: cardStateVersion(full),
      ...(code ? { code } : {}),
      ...(decision ? { decision } : {}),
      ...(notes ? { notes } : {}),
    });
  }

  /** Agent 问题卡:label 反查投影码(opt-题-序),自由文本原样透传
   * (decodeAgentDecision 认不出的码当原文,不静默吃掉选择)。 */
  private answerAgentCard(
    id: string,
    full: IssueSummary,
    questions: CardQuestion[],
    chosen: Map<number, { label?: string; text?: string }>,
    notes: string | undefined,
  ): void {
    const answers: Record<string, string> = {};
    for (const [index, answer] of chosen) {
      if (answer.label !== undefined) {
        const optionIndex = questions[index]?.labels.indexOf(answer.label) ?? -1;
        answers[String(index)] = optionIndex >= 0
          ? questions[index].codes[optionIndex]
          : answer.label;
      } else {
        answers[String(index)] = answer.text ?? "";
      }
    }
    this.issues.answer(id, {
      state_version: cardStateVersion(full),
      answers,
      ...(notes ? { notes } : {}),
    });
  }

  /** 等待卡 → 网关展示形状。waiting_id/state_version 必须与
   * notifyWaitingCard 发出去的完全一致——审批码就是从这四个字段
   * (账号/会话/卡 id/版本)派生的,差一个字用户就回不进来。 */
  private card(id: string): TaskSummary | undefined {
    const full = this.issues.get(id);
    if (full.status !== "waiting_user") return undefined;
    const gate = full.gate;
    const waiting = full.waiting;
    if (!gate && !waiting) return undefined;
    const questions = cardQuestions({ gate, waiting });
    const created = gate ? full.updated_at : waiting!.created_at;
    return {
      id: full.id,
      title: full.title,
      requirement: full.description || full.title,
      ticket: full.ticket,
      status: "waiting_for_human",
      origin: "issue",
      luban_account: full.account,
      workspace: "",
      created_at: full.created_at,
      waiting: {
        waiting_id: gate ? gate.id : waiting!.waiting_id,
        task_id: full.id,
        step: full.stage_note || full.stage,
        call_id: gate ? gate.id : waiting!.call_id,
        question: {
          questions: questions.map((item) => ({
            question: item.question,
            options: item.labels,
          })),
        },
        context: gate ? gate.context : waiting!.context,
        state_version: gate ? gate.state_version : waiting!.state_version,
        status: "waiting",
        decision: "",
        notes: "",
        created_at: created,
        resolved_at: "",
      },
    };
  }
}

/** 闸与 Agent 卡的作答幂等基准都在卡上(闸自己的 state_version /
 * waiting.json 记录的 state_version),从投影里取,不再现算。 */
function cardStateVersion(full: IssueSummary & { waiting?: WaitingRecord }): number {
  return full.gate ? full.gate.state_version : full.waiting!.state_version;
}
