/**
 * 小鲁班插件的纯文本审批入口。
 *
 * 它只是一层移动端输入适配：任务、待办、权限与决定仍以 TaskService
 * 为唯一真相；这里不保存第二份审批状态，也不替内核解释决定。
 * 小鲁班真实回调形状未知时，由部署侧桥转换成本文件的稳定小契约。
 */

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  readFileSync,
  statSync,
} from "node:fs";
import type { TaskSummary } from "./taskService.ts";
import type { LubanApprovalNotification } from "./notifier.ts";
import {
  questionsOf,
  renderLubanDetail,
  renderLubanHelp,
  renderLubanQuestionPrompt,
  renderLubanTaskList,
  type LubanApprovalQuestion,
} from "./lubanApprovalView.ts";

export interface LubanApprovalService {
  list(): TaskSummary[];
  decide(id: string, input: {
    state_version: number;
    selected_options?: Record<string, string>;
    free_responses?: Record<string, string>;
    comment?: string;
  }): Promise<TaskSummary>;
}

/** 决定被域规则打回(不是过期、不是故障):消息人话直出给手机端,
 * 409——与页面作答收到域 409 同语义。过期/状态漂移仍走普通 Error
 * (消息命中 stale 词表),由网关统一回"审批码已过期"。 */
export class ApprovalRejection extends Error {}

/** 多来源审批(需求任务 + 问题会话)的合并视图:决策路由到持有这张
 * 卡的来源。卡 id 两个域天然不撞(需求 T-* / 问题 issue-*),现查
 * 现路由,不缓存归属。 */
export class CompositeLubanApproval implements LubanApprovalService {
  constructor(private readonly sources: LubanApprovalService[]) {}

  list(): TaskSummary[] {
    return this.sources.flatMap((source) => source.list());
  }

  async decide(id: string, input: Parameters<LubanApprovalService["decide"]>[1]): Promise<TaskSummary> {
    const owner = this.sources.find((source) =>
      source.list().some((task) => task.id === id));
    if (!owner) {
      throw new Error(`审批事项 ${id} 不存在或已不在等待`);
    }
    return owner.decide(id, input);
  }
}

export interface LubanPluginEnvelope {
  message_id: string;
  sender: string;
  content: string;
}

export interface LubanPluginReply {
  status: number;
  text: string;
  replayed?: boolean;
}

export interface LubanApprovalGatewayOptions {
  token: string;
  accountEnabled: (account: string) => boolean;
  /** 出站通知留下的真相锚：让唯一待办可直接回复序号，同时不把裸数字
   * 猜到另一张卡。多待办仍要求审批码。 */
  recentNotification?: (
    account: string,
  ) => LubanApprovalNotification | undefined;
  now?: () => number;
  log?: (message: string) => void;
}

interface CachedReply {
  digest: string;
  at: number;
  reply: LubanPluginReply;
}

interface InflightReply {
  digest: string;
  promise: Promise<LubanPluginReply>;
}

interface BoundApproval {
  taskId: string;
  waitingId: string;
  stateVersion: number;
  code: string;
}

interface ConversationCursor {
  at: number;
  entries: BoundApproval[];
  selected?: BoundApproval;
  /** 多题卡只在短期会话里保存未交卷草稿；waiting/stateVersion 仍是
   * 真相锚点，全部题答完后才一次性写入 TaskService。 */
  questionIndex?: number;
  answers?: Record<string, string>;
  answerNotes?: Record<string, string>;
}

const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 1_000;
class CallbackError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 回调 Token 只从 0600 文件读取，避免明文进入进程参数和部署配置 diff。 */
export function loadLubanPluginToken(path: string): string {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("小鲁班插件 Token 路径不是普通文件");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("小鲁班插件 Token 文件权限必须是 0600");
  }
  const token = readFileSync(path, "utf-8").trim();
  if (Buffer.byteLength(token, "utf-8") < 32) {
    throw new Error("小鲁班插件 Token 至少需要 32 字节");
  }
  return token;
}

function normalizeCode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function lubanApprovalCode(input: {
  token: string;
  account?: string;
  taskId: string;
  waitingId: string;
  stateVersion: number;
}): string {
  return createHmac("sha256", input.token).update([
    "approval", input.account, input.taskId,
    input.waitingId, input.stateVersion,
  ].join("\0"), "utf-8").digest("hex").slice(0, 10).toUpperCase();
}

function parseEnvelope(rawBody: string): LubanPluginEnvelope {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new CallbackError(400, "回调 JSON 格式不正确");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CallbackError(400, "回调正文必须是 JSON 对象");
  }
  const input = body as Record<string, unknown>;
  const messageId = String(input.message_id ?? "").trim();
  const sender = String(input.sender ?? "").trim();
  const content = String(input.content ?? "").trim();
  if (!messageId || messageId.length > 128 || /[\0\r\n]/.test(messageId)) {
    throw new CallbackError(400, "message_id 缺失或格式不正确");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sender)) {
    throw new CallbackError(400, "sender 缺失或格式不正确");
  }
  if (!content || content.length > 2_000 || /\0/.test(content)) {
    throw new CallbackError(400, "content 缺失或过长");
  }
  return { message_id: messageId, sender, content };
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual, "utf-8");
  const right = Buffer.from(expected, "utf-8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class LubanApprovalGateway {
  private readonly service: LubanApprovalService;
  private readonly replies = new Map<string, CachedReply>();
  private readonly inflight = new Map<string, InflightReply>();
  /**
   * 只保存“用户刚刚在看哪张卡”的短期导航上下文。审批真相仍完全来自
   * TaskService；每次裸回复提交前都会重新核对 waiting_id/state_version。
   */
  private readonly cursors = new Map<string, ConversationCursor>();

  constructor(
    service: LubanApprovalService | LubanApprovalService[],
    private readonly options: LubanApprovalGatewayOptions,
  ) {
    this.service = Array.isArray(service) ? new CompositeLubanApproval(service) : service;
    if (Buffer.byteLength(options.token, "utf-8") < 32) {
      throw new Error("小鲁班插件 Token 至少需要 32 字节");
    }
  }

  /** 同编号原位重跑后，手机端“刚才在看哪张卡”的短期上下文必须失效，
   * 否则新一轮若恰好复用 waiting/version 形状，旧裸回复可能串单。回调
   * message_id 的防重缓存继续保留——已处理消息仍不应被再次执行。 */
  purgeTask(taskId: string): void {
    for (const [account, cursor] of this.cursors) {
      const entries = cursor.entries.filter((item) => item.taskId !== taskId);
      const selected = cursor.selected?.taskId === taskId
        ? undefined : cursor.selected;
      if (!entries.length && !selected) {
        this.cursors.delete(account);
        continue;
      }
      this.cursors.set(account, {
        ...cursor,
        entries,
        selected,
        ...(selected ? {} : {
          questionIndex: undefined,
          answers: undefined,
          answerNotes: undefined,
        }),
      });
    }
  }

  /** 固定 Token 只证明请求来自受信插件/桥；任务版本仍负责防陈旧决定。 */
  async handle(input: {
    rawBody: string;
    token?: string;
  }): Promise<LubanPluginReply> {
    try {
      this.verify(input);
      const envelope = parseEnvelope(input.rawBody);
      if (!this.options.accountEnabled(envelope.sender)) {
        throw new CallbackError(403, "该工号未启用 Mae-Flow 账号");
      }
      const digest = createHash("sha256")
        .update(input.rawBody, "utf-8").digest("hex");
      this.pruneCache();
      const cached = this.replies.get(envelope.message_id);
      if (cached) {
        if (cached.digest !== digest) {
          throw new CallbackError(409, "message_id 已被其他请求使用");
        }
        const reply = { ...cached.reply, replayed: true };
        this.logReceipt(envelope, reply);
        return reply;
      }
      const running = this.inflight.get(envelope.message_id);
      if (running) {
        if (running.digest !== digest) {
          throw new CallbackError(409, "message_id 已被其他请求使用");
        }
        const reply = { ...(await running.promise), replayed: true };
        this.logReceipt(envelope, reply);
        return reply;
      }
      const promise = this.execute(envelope).then((reply) => {
        this.replies.set(envelope.message_id, {
          digest, at: this.now(), reply,
        });
        return reply;
      }).finally(() => {
        this.inflight.delete(envelope.message_id);
      });
      this.inflight.set(envelope.message_id, { digest, promise });
      const reply = await promise;
      this.logReceipt(envelope, reply);
      return reply;
    } catch (error) {
      if (error instanceof CallbackError) {
        return { status: error.status, text: error.message };
      }
      this.options.log?.(`小鲁班审批回调失败: ${String(error)}`);
      return { status: 500, text: "Mae-Flow 暂时无法处理，请稍后重试" };
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 只记入站确实到达和处理结果，不记录用户正文、Token 或完整消息 ID。 */
  private logReceipt(
    envelope: LubanPluginEnvelope,
    reply: LubanPluginReply,
  ): void {
    const message = createHash("sha256")
      .update(envelope.message_id, "utf-8").digest("hex").slice(0, 10);
    this.options.log?.(
      `小鲁班审批回调已处理: sender=${envelope.sender},message=${message},`
        + `status=${reply.status}${reply.replayed ? ",replayed=true" : ""}`,
    );
  }

  private verify(input: {
    rawBody: string;
    token?: string;
  }): void {
    if (!sameToken(input.token, this.options.token)) {
      throw new CallbackError(401, "回调 Token 无效");
    }
  }

  private pruneCache(): void {
    const oldest = this.now() - CACHE_TTL_MS;
    for (const [id, record] of this.replies) {
      if (record.at < oldest) this.replies.delete(id);
    }
    while (this.replies.size > MAX_CACHE_ENTRIES) {
      const first = this.replies.keys().next().value as string | undefined;
      if (!first) break;
      this.replies.delete(first);
    }
    for (const [account, cursor] of this.cursors) {
      if (cursor.at < oldest) this.cursors.delete(account);
    }
  }

  private pending(account: string): TaskSummary[] {
    return this.service.list().filter((task) =>
      task.luban_account === account
      && task.status === "waiting_for_human"
      && task.waiting?.status === "waiting");
  }

  private approvalCode(task: TaskSummary): string {
    const waiting = task.waiting!;
    return lubanApprovalCode({
      token: this.options.token,
      account: task.luban_account,
      taskId: task.id,
      waitingId: waiting.waiting_id,
      stateVersion: waiting.state_version,
    });
  }

  private find(account: string, code: string): TaskSummary | undefined {
    const wanted = normalizeCode(code);
    return this.pending(account).find((task) =>
      this.approvalCode(task) === wanted);
  }

  private bind(task: TaskSummary): BoundApproval {
    return {
      taskId: task.id,
      waitingId: task.waiting!.waiting_id,
      stateVersion: task.waiting!.state_version,
      code: this.approvalCode(task),
    };
  }

  private sameBinding(left: BoundApproval | undefined, right: BoundApproval): boolean {
    return !!left && left.taskId === right.taskId
      && left.waitingId === right.waitingId
      && left.stateVersion === right.stateVersion
      && left.code === right.code;
  }

  /** 激活一张卡。重复查看同一版本时保留已经逐题收集的草稿；换卡或
   * 状态版本变化时从第一题重新开始。 */
  private activate(account: string, task: TaskSummary): ConversationCursor {
    const binding = this.bind(task);
    const existing = this.cursors.get(account);
    if (existing && this.sameBinding(existing.selected, binding)) {
      existing.at = this.now();
      existing.entries = [binding];
      existing.selected = binding;
      existing.questionIndex ??= 0;
      existing.answers ??= {};
      existing.answerNotes ??= {};
      return existing;
    }
    const cursor: ConversationCursor = {
      at: this.now(), entries: [binding], selected: binding,
      questionIndex: 0, answers: {}, answerNotes: {},
    };
    this.cursors.set(account, cursor);
    return cursor;
  }

  private taskFor(account: string, binding: BoundApproval): TaskSummary | undefined {
    return this.pending(account).find((task) => task.id === binding.taskId
      && task.waiting!.waiting_id === binding.waitingId
      && task.waiting!.state_version === binding.stateVersion
      && this.approvalCode(task) === binding.code);
  }

  private async execute(envelope: LubanPluginEnvelope): Promise<LubanPluginReply> {
    const command = envelope.content
      .replace(/^\/?mae(?:-flow)?(?:\s+|$)/i, "").trim();
    if (!command || /^(?:待审批|审批|我的审批)$/.test(command)) {
      return this.showPending(envelope.sender);
    }
    if (/^(?:帮助|help|\?)$/i.test(command)) {
      return { status: 200, text: renderLubanHelp() };
    }
    let match = command.match(/^详情\s+([A-Za-z0-9_-]+)$/i);
    if (match) return this.detail(envelope.sender, match[1]);
    match = command.match(/^选择\s+([A-Za-z0-9_-]+)\s+(\d+)(?:\s+([\s\S]+))?$/i);
    if (match) {
      return await this.choose(envelope.sender, match[1], Number(match[2]),
        match[3]?.trim());
    }
    match = command.match(/^回复\s+([A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
    if (match) {
      return await this.reply(envelope.sender, match[1], match[2].trim());
    }
    match = command.match(/^通过\s+([A-Za-z0-9_-]+)$/i);
    if (match) return await this.chooseByMeaning(envelope.sender, match[1], true);
    match = command.match(/^退回\s+([A-Za-z0-9_-]+)(?:\s+([\s\S]+))?$/i);
    if (match) {
      if (!match[2]?.trim()) {
        return { status: 400, text: "退回必须写明意见，例如：mae-flow 退回 A7K9 请补充异常场景" };
      }
      return await this.chooseByMeaning(
        envelope.sender, match[1], false, match[2].trim());
    }
    return await this.answerFromCursor(envelope.sender, command);
  }

  private showPending(account: string): LubanPluginReply {
    const pending = this.pending(account);
    if (!pending.length) {
      this.cursors.delete(account);
      return { status: 200, text: "当前没有待审批事项。" };
    }
    if (pending.length === 1) {
      this.activate(account, pending[0]);
      return this.renderDetail(pending[0]);
    }
    const shown = pending.slice(0, 5);
    const entries = shown.map((task) => this.bind(task));
    this.cursors.set(account, { at: this.now(), entries });
    return { status: 200, text: renderLubanTaskList(shown, pending.length) };
  }

  private detail(account: string, code: string): LubanPluginReply {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    this.activate(account, task);
    return this.renderDetail(task);
  }

  private renderDetail(task: TaskSummary): LubanPluginReply {
    const binding = this.bind(task);
    const cursor = task.luban_account
      ? this.cursors.get(task.luban_account) : undefined;
    const currentQuestion = this.sameBinding(cursor?.selected, binding)
      ? cursor?.questionIndex ?? 0 : 0;
    return {
      status: 200,
      text: renderLubanDetail(
        task, this.approvalCode(task), currentQuestion),
    };
  }

  private async choose(
    account: string,
    code: string,
    optionNumber: number,
    notes?: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    const questions = questionsOf(task.waiting!);
    const cursor = this.activate(account, task);
    const index = cursor.questionIndex ?? 0;
    const option = questions[index]?.options[optionNumber - 1];
    if (!option) {
      return { status: 400, text: `当前问题的选项序号无效，请发送：mae-flow 详情 ${this.approvalCode(task)}` };
    }
    return await this.recordAnswer(account, task, option, notes);
  }

  private async reply(
    account: string,
    code: string,
    answer: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    if (!answer) return { status: 400, text: "答复不能为空" };
    this.activate(account, task);
    return await this.answerCurrentQuestion(account, task, answer);
  }

  private async chooseByMeaning(
    account: string,
    code: string,
    positive: boolean,
    notes?: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    const questions = questionsOf(task.waiting!);
    const cursor = this.activate(account, task);
    const question = questions[cursor.questionIndex ?? 0];
    if (!question?.options.length) {
      return { status: 400, text: "当前问题没有可匹配的选项，请直接回复具体答复。" };
    }
    const negativePattern = /打回|退回|修改|拒绝|不通过/;
    const positivePattern = /通过|确认|同意|接受|批准|继续/;
    // “不通过”同时含“通过”；正向快捷命令必须排除所有负向词。
    // 边界选项宁可要求用户按序号选择，也不能自作聪明选反。
    const matches = question.options.filter((option) => positive
      ? positivePattern.test(option) && !negativePattern.test(option)
      : negativePattern.test(option));
    if (matches.length !== 1) {
      return { status: 400, text: "无法安全判断你指的是哪个选项，请发送："
        + `mae-flow 详情 ${this.approvalCode(task)}，再用“mae-flow 选择 审批码 序号”。` };
    }
    return await this.recordAnswer(account, task, matches[0], notes);
  }

  private async answerFromCursor(
    account: string,
    answer: string,
  ): Promise<LubanPluginReply> {
    const cursor = this.cursors.get(account);
    if (!cursor || cursor.at < this.now() - CACHE_TTL_MS) {
      this.cursors.delete(account);
      const notified = this.options.recentNotification?.(account);
      if (notified && notified.notifiedAt >= this.now() - CACHE_TTL_MS) {
        const pending = this.pending(account);
        if (pending.length > 1) {
          return {
            status: 400,
            text: `你当前有 ${pending.length} 项待审批，裸序号无法确认是哪一项。`
              + `请回复：mae-flow 选择 ${notified.code} <序号>`
              + "，或发送：mae-flow 待审批",
          };
        }
        const binding: BoundApproval = {
          taskId: notified.taskId,
          waitingId: notified.waitingId,
          stateVersion: notified.stateVersion,
          code: normalizeCode(notified.code),
        };
        const task = this.taskFor(account, binding);
        if (!task) return this.stale(account);
        this.activate(account, task);
        return await this.answerCurrentQuestion(account, task, answer);
      }
      return {
        status: 400,
        text: "没有找到你正在处理的审批，请先发送：mae-flow 待审批",
      };
    }
    if (!cursor.selected) {
      const number = Number(answer);
      const binding = Number.isInteger(number) ? cursor.entries[number - 1] : undefined;
      if (!binding) {
        return { status: 400, text: "请先回复待办前的任务序号，查看完整详情。" };
      }
      const task = this.taskFor(account, binding);
      if (!task) return this.stale(account);
      this.activate(account, task);
      return this.renderDetail(task);
    }
    const task = this.taskFor(account, cursor.selected);
    if (!task) return this.stale(account);
    const navigation = this.navigateQuestions(account, task, answer);
    if (navigation) return navigation;
    return await this.answerCurrentQuestion(account, task, answer);
  }

  private navigateQuestions(
    account: string,
    task: TaskSummary,
    command: string,
  ): LubanPluginReply | undefined {
    const questions = questionsOf(task.waiting!);
    if (questions.length <= 1) return undefined;
    const cursor = this.activate(account, task);
    if (/^(?:重答上一题|返回上一题)$/.test(command)) {
      const current = cursor.questionIndex ?? 0;
      if (current === 0) {
        return {
          status: 200,
          text: "当前已经是第一题。\n\n"
            + renderLubanQuestionPrompt(questions[0], 0, questions.length),
        };
      }
      const target = current - 1;
      const previous = questions[target];
      delete cursor.answers![previous.question];
      delete cursor.answerNotes![previous.question];
      cursor.questionIndex = target;
      cursor.at = this.now();
      return {
        status: 200,
        text: `已撤销问题 ${target + 1} 的原答案，请重新回答。\n\n`
          + renderLubanQuestionPrompt(previous, target, questions.length),
      };
    }
    if (/^(?:重答全部问题|从头重答)$/.test(command)) {
      cursor.questionIndex = 0;
      cursor.answers = {};
      cursor.answerNotes = {};
      cursor.at = this.now();
      return {
        status: 200,
        text: "已清空本次尚未提交的答案，从第一题重新开始。\n\n"
          + renderLubanQuestionPrompt(questions[0], 0, questions.length),
      };
    }
    return undefined;
  }

  /** 把一条纯文本安全映射到当前问题。数字只解释为当前题的选项序号；
   * 自然语言沿用单题时的保守映射，拿不准就明确提示、绝不猜测提交。 */
  private interpretAnswer(
    question: LubanApprovalQuestion,
    raw: string,
  ): { answer?: string; note?: string; error?: string } {
    const answer = raw.trim();
    if (!answer) return { error: "答复不能为空" };
    const free = answer.match(/^(?:自由回复|自由答复|自定义答复|其他)[：:]\s*([\s\S]+)$/);
    if (free) {
      const content = free[1].trim();
      if (!content) return {
        error: "“自由回复：”后面还没有内容，请写明你的答案或修改要求。",
      };
      // 选项不完备时，显式“自由回复：”是主答案，不伪装成任一流程
      // 分支；普通自然语言仍保守匹配，拿不准只提示、不猜。
      return { answer: content };
    }
    const number = Number(answer);
    if (Number.isInteger(number) && String(number) === answer.trim()) {
      if (!question.options.length) return { answer };
      const option = question.options[number - 1];
      return option
        ? { answer: option }
        : { error: "当前问题的选项序号无效，请按提示中的序号回复。" };
    }
    if (!question.options.length) return { answer };

    const exact = question.options.find((option) => option === answer);
    if (exact) return { answer: exact };
    const numbered = answer.match(/^(\d+)(?:\s*[：:]\s*|\s+)([\s\S]+)$/);
    if (numbered) {
      const option = question.options[Number(numbered[1]) - 1];
      if (!option) {
        return { error: "当前问题的选项序号无效，请按提示中的序号回复。" };
      }
      return { answer: option, note: numbered[2].trim() };
    }
    const negative = question.options.filter((option) =>
      /打回|退回|修改|拒绝|不通过|调整|补充|^(?:不|无需|无须|否)/.test(option));
    const positive = question.options.filter((option) =>
      /通过|确认|同意|接受|批准|继续/.test(option)
      && !/打回|退回|修改|拒绝|不通过/.test(option));
    const negativeIntent = /打回|退回|拒绝|不通过|不行|不对|不要|不用|无需|无须|有问题|请.{0,8}(?:改|补充|调整)|改成|需要修改|需要补充|需要调整/;
    const positiveIntent = /通过|确认|同意|接受|批准|继续|可以|没问题|好的?|\bok\b|\byes\b/i;
    if (negativeIntent.test(answer) && negative.length === 1) {
      return { answer: negative[0], note: answer };
    }
    // “我选兼容并补充…”这类自由回复先按最长选项原文匹配；最长优先
    // 避免“不兼容”同时命中“兼容”时选反，原话仍作为说明完整保留。
    const mentioned = question.options
      .filter((option) => answer.includes(option))
      .sort((left, right) => right.length - left.length);
    if (mentioned.length
        && (mentioned.length === 1 || mentioned[0].length > mentioned[1].length)) {
      return { answer: mentioned[0], note: answer };
    }
    if (positiveIntent.test(answer) && !negativeIntent.test(answer)
        && positive.length === 1) {
      return { answer: positive[0], note: answer };
    }
    // 选项题里的任意自然语言可能是“选择某项的说明”，也可能是明确要
    // 跳出选项。判不清就不记、不交；必须先落到结构化选项。
    return {
      error: "没有把这句话唯一对应到某个选项，因此尚未记录。"
        + "请选择选项序号；如需补充说明，请回复“序号：你的说明”。",
    };
  }

  private async answerCurrentQuestion(
    account: string,
    task: TaskSummary,
    raw: string,
  ): Promise<LubanPluginReply> {
    const questions = questionsOf(task.waiting!);
    const cursor = this.activate(account, task);
    const batch = await this.answerBatch(account, task, raw);
    if (batch) return batch;
    const question = questions[cursor.questionIndex ?? 0];
    if (!question) {
      return { status: 400, text: "当前待办没有可读取的问题，请回到电脑端处理。" };
    }
    const interpreted = this.interpretAnswer(question, raw);
    if (!interpreted.answer) {
      return { status: 400, text: interpreted.error ?? "答复无法识别" };
    }
    return await this.recordAnswer(
      account, task, interpreted.answer, interpreted.note);
  }

  /** 全部剩余问题都是选择题时，支持 `1/2/1` 一次答完。只接受纯数字
   * 加分隔符且题数必须完全匹配；不满足时明确报错，不把它误当自由文本。 */
  private async answerBatch(
    account: string,
    task: TaskSummary,
    raw: string,
  ): Promise<LubanPluginReply | undefined> {
    const text = raw.trim();
    if (!/^\d+(?:\s*[/,，、]\s*\d+)+$/.test(text)) return undefined;
    const cursor = this.activate(account, task);
    const questions = questionsOf(task.waiting!);
    const index = cursor.questionIndex ?? 0;
    const remaining = questions.slice(index);
    const numbers = text.split(/\s*[/,，、]\s*/).map(Number);
    if (remaining.length <= 1) return undefined;
    if (numbers.length !== remaining.length) {
      return {
        status: 400,
        text: `当前还剩 ${remaining.length} 个问题，请依次填写 ${remaining.length} 个选项序号，`
          + `例如：${remaining.map(() => "1").join("/")}`,
      };
    }
    if (remaining.some((question) => !question.options.length)) {
      return {
        status: 400,
        text: "剩余问题中包含开放题，不能批量填写序号；请按当前问题逐题回复。",
      };
    }
    const selected: string[] = [];
    for (let offset = 0; offset < remaining.length; offset += 1) {
      const question = remaining[offset];
      const option = question.options[numbers[offset] - 1];
      if (!option) {
        return {
          status: 400,
          text: `问题 ${index + offset + 1} 的选项序号 ${numbers[offset]} 无效，`
            + "请核对详情后重试。",
        };
      }
      selected.push(option);
    }
    for (let offset = 0; offset < remaining.length; offset += 1) {
      const question = remaining[offset];
      cursor.answers![question.question] = selected[offset];
      delete cursor.answerNotes![question.question];
    }
    cursor.at = this.now();
    return await this.submit(task, undefined, "", { ...cursor.answers });
  }

  /** 多题卡逐题收集、整卡提交。HumanGate 的原子决定语义不变：中间
   * 回复只形成短期草稿，最后一题完成后 answers 才一次性交给服务。 */
  private async recordAnswer(
    account: string,
    task: TaskSummary,
    answer: string,
    note?: string,
  ): Promise<LubanPluginReply> {
    const questions = questionsOf(task.waiting!);
    const cursor = this.activate(account, task);
    const index = cursor.questionIndex ?? 0;
    const question = questions[index];
    if (!question) {
      return { status: 400, text: "当前待办没有可读取的问题，请回到电脑端处理。" };
    }
    cursor.answers![question.question] = answer;
    if (note?.trim()) cursor.answerNotes![question.question] = note.trim();
    else delete cursor.answerNotes![question.question];
    cursor.at = this.now();

    if (questions.length === 1) return await this.submit(task, answer, note);
    if (index + 1 < questions.length) {
      cursor.questionIndex = index + 1;
      const shown = answer.length > 120 ? answer.slice(0, 119) + "…" : answer;
      return {
        status: 200,
        text: `已记录问题 ${index + 1}/${questions.length}：${shown}`
          + (note?.trim()
            ? `\n具体意见已保留：${note.trim().slice(0, 240)}` : "")
          + "\n状态：尚未提交（完成全部问题后统一生效）\n\n"
          + renderLubanQuestionPrompt(
            questions[index + 1], index + 1, questions.length),
      };
    }

    const notes = questions.flatMap((item, questionIndex) => {
      const detail = cursor.answerNotes![item.question];
      return detail
        ? [`问题 ${questionIndex + 1}「${item.question}」：${detail}`]
        : [];
    }).join("\n");
    return await this.submit(task, undefined, notes, { ...cursor.answers });
  }

  private async submit(
    task: TaskSummary,
    decision?: string,
    notes?: string,
    answers?: Record<string, string>,
  ): Promise<LubanPluginReply> {
    try {
      const selectedOptions: Record<string, string> = {};
      const freeResponses: Record<string, string> = {};
      const questions = questionsOf(task.waiting!);
      const submittedAnswers = answers ?? (questions[0] && decision !== undefined
        ? { [questions[0].question]: decision } : {});
      for (const question of questions) {
        const answer = submittedAnswers[question.question];
        if (!answer) continue;
        if (question.options.includes(answer)) {
          selectedOptions[question.question] = answer;
        } else {
          freeResponses[question.question] = answer;
        }
      }
      await this.service.decide(task.id, {
        state_version: task.waiting!.state_version,
        selected_options: selectedOptions,
        free_responses: freeResponses,
        comment: notes ? `小鲁班手机审批：${notes}` : "小鲁班手机审批",
      });
      if (task.luban_account) this.cursors.delete(task.luban_account);
      return {
        status: 200,
        text: "已提交，Agent 已继续。"
          + (answers ? `\n已处理 ${Object.keys(answers).length} 个问题。` : "")
          + (notes ? "\n具体说明已一并保留。" : ""),
      };
    } catch (error) {
      const message = String(error);
      if (error instanceof ApprovalRejection) {
        return { status: 409, text: message.replace(/^\w*Error:\s*/, "") };
      }
      if (/状态已变化|没有待人工决定|不存在|版本不匹配|没有等待中的问题卡/.test(message)) {
        return this.stale(task.luban_account);
      }
      if (/检视意见未闭环|必须选择卡片中的结构化选项|自由说明/.test(message)) {
        return { status: 409, text: message.replace(/^\w*Error:\s*/, "") };
      }
      this.options.log?.(`任务 ${task.id} 手机审批提交失败: ${message}`);
      return { status: 500, text: "审批没有提交成功，请稍后重试或回到电脑端处理。" };
    }
  }

  private stale(account?: string): LubanPluginReply {
    if (account) this.cursors.delete(account);
    return {
      status: 409,
      text: "审批事项已更新或审批码已过期，请重新发送：mae-flow 待审批",
    };
  }
}
