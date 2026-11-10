/**
 * 小鲁班通知(主 spec §9/§14.4)——内网能力的可替换模拟。
 *
 * 语义三条,真假件共同遵守:
 * 1. WAITING_FOR_HUMAN 事件发送给任务创建时填写的账号,附审批链接;
 * 2. 发送失败不改变流程状态:Web 待办仍在,后台有限退避重试并记录
 *    发送结果,页面能看到"通知没送到"这个事实(标红的依据);
 * 3. 同一张待办不重复生成通知记录,重试只累计次数。
 *
 * 文案可模板化(部署级配置,{占位符} 词汇表见
 * docs/luban-notification-templates.md);但 /mfc 激活提示与手机审批
 * 指令由代码追加,不归模板管——那是"每条消息说清激活前置"的承诺,
 * 交给配置等于允许被人不小心删掉。
 *
 * 真小鲁班就绪时:换 endpoint 地址与鉴权头,本文件其余零改动;
 * FakeLubanServer 只在测试与演示里出场。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { humanApprovalStage } from "./lubanApprovalView.ts";

export interface NotifyRecord {
  /** 幂等键:待办通知=waiting_id;收口通知=taskId:outcome:状态。 */
  waiting_id: string;
  task_id: string;
  account: string;
  step: string;
  summary: string;
  link: string;
  /** 发送正文(说人话,构造时定稿;重试只重发不重写)。 */
  text: string;
  attempts: number;
  delivered: boolean;
  /** true 表示有限重试已经结束；旧版本没有该字段的记录不能据此判失败。 */
  settled?: boolean;
  last_error: string;
}

export interface NotifyQuestion {
  question: string;
  options?: string[];
}

/** 可自定义文案的三类通知(部署级配置;正文模板,占位符套值)。 */
export interface NotificationTemplates {
  /** 待办通知(WAITING_FOR_HUMAN)。 */
  waiting?: string;
  /** 收口通知(完成/交付/失败)。 */
  outcome?: string;
  /** Committer 检视邀请。 */
  review?: string;
  /** 问题登记指派(ADR-0031):测试登记问题指派责任人时的一次性通知。 */
  assigned?: string;
  /** 问题自动接单(ADR-0061):平台替责任人自动发起名下 DTS 单。 */
  auto_claimed?: string;
}

/** 各类别占位符白名单。构造期校验:模板里出现表外名字=配错,
 * 当场点名并拒绝启动(部署配置语义,同适配层"引用了 {x} 但没有值")。
 * 运行期不存在"没有值"——每个占位符在渲染点都有定义好的字符串
 * (subject 缺席回落"任务 {task_id}",link 永远有值),不会渲染一半。 */
const TEMPLATE_VARIABLES: Record<keyof NotificationTemplates, string[]> = {
  waiting: ["task_id", "subject", "step", "stage", "summary", "account", "link"],
  outcome: ["task_id", "status", "summary", "account", "link"],
  review: ["task_id", "summary", "account", "sender_account", "link"],
  assigned: ["reporter", "title", "account", "link"],
  auto_claimed: ["title", "account", "link"],
};

/** 默认模板=引入模板机制前的固定文案,一字不差:不配置就是零变化。 */
const DEFAULT_TEMPLATES: Required<NotificationTemplates> = {
  waiting: "【Mae-Flow】{subject} 等你决定\n阶段：{stage}\n{summary}",
  outcome: "【Mae-Flow】{summary}\n任务 {task_id}",
  review: "【Mae-Flow】任务 {task_id} 邀请你检视：{summary}",
  assigned:
    "【Mae-Flow】{reporter} 登记了问题「{title}」并指派你为责任人\n"
    + "打开链接查看分析进展:{link}",
  auto_claimed:
    "【Mae-Flow】系统自动接单:你名下的问题单「{title}」已自动发起"
    + "问题会话\n打开链接查看分析进展:{link}",
};

/** 合并默认值并校验占位符。写错变量名的模板投出去,用户看到的
 * 是一串 {task_i} 原文——比启动失败更晚被发现也更难排查,所以
 * 宁可起不来,也不带着错模板起服。 */
function resolveTemplates(
  templates: NotificationTemplates | undefined,
): Required<NotificationTemplates> {
  const merged: Required<NotificationTemplates> = {
    ...DEFAULT_TEMPLATES,
    ...templates,
  };
  const kinds = Object.keys(TEMPLATE_VARIABLES) as Array<
    keyof NotificationTemplates
  >;
  for (const kind of kinds) {
    const allowed = TEMPLATE_VARIABLES[kind];
    for (const match of merged[kind].matchAll(/\{(\w+)\}/g)) {
      const name = match[1];
      if (!allowed.includes(name)) {
        throw new Error(
          `通知模板 ${kind} 引用了不可用的占位符 {${name}};`
          + `可用: ${allowed.map((item) => `{${item}}`).join(" ")}`);
      }
    }
  }
  return merged;
}

/** 套值。构造期已过白名单校验,这里的 values 必然覆盖模板里的名字。 */
function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_whole, name: string) => values[name]);
}

const MAX_NOTIFICATION_CONTEXT_CHARS = 2_400;
const LUBAN_PLUGIN_ACTIVATION_NOTICE =
  "手机端操作：先输入“/mfc”激活 Mae-Flow 插件；"
  + "未激活时，直接回复本消息不会进入 Mae-Flow。";

function withPluginActivationNotice(text: string): string {
  return `${text}\n${LUBAN_PLUGIN_ACTIVATION_NOTICE}`;
}

function notificationContext(value: string | undefined): string {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_NOTIFICATION_CONTEXT_CHARS) return normalized;
  return normalized.slice(0, MAX_NOTIFICATION_CONTEXT_CHARS - 18)
    + "\n…内容较长，已截断";
}

function questionDependsOnContext(question: string): boolean {
  return /上述|以上|如下|前述|完整配置|该配置|这些配置/.test(question);
}

function renderQuestionSummary(
  questions: NotifyQuestion[],
  fallback: string | undefined,
): string {
  if (!questions.length) return fallback?.trim() || "需要你确认";
  if (questions.length === 1) {
    const item = questions[0];
    return item.question + (item.options?.length
      ? `\n选项：${item.options.map((option, index) =>
          `${index + 1}. ${option}`).join("；")}`
      : "");
  }
  return [
    `共 ${questions.length} 个问题：`,
    ...questions.flatMap((item, index) => [
      `问题 ${index + 1}：${item.question}`,
      ...(item.options?.length
        ? [`选项：${item.options.map((option, optionIndex) =>
            `${optionIndex + 1}. ${option}`).join("；")}`]
        : []),
    ]),
  ].join("\n");
}

/** 最近一张待办通知携带的审批真相锚。它只用于让“唯一待办 + 裸回复”
 * 少一次查询；真正提交前 Gateway 仍会重新核对账号、waiting 与版本。 */
export interface LubanApprovalNotification {
  account: string;
  taskId: string;
  waitingId: string;
  stateVersion: number;
  code: string;
  notifiedAt: number;
}

/** 把一张待办里的全部问题定稿进通知正文。问题和选项保留结构直到
 * 通知边界再转成文本，避免上游先压成 questions[0] 后永久丢题。 */
function waitingSummary(input: {
  summary?: string;
  context?: string;
  questions?: NotifyQuestion[];
}): string {
  const questions = (input.questions ?? []).flatMap((item): NotifyQuestion[] => {
    const question = String(item?.question ?? "").trim();
    if (!question) return [];
    const options = Array.isArray(item.options)
      ? item.options.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    return [{ question, options }];
  });
  const context = notificationContext(input.context);
  const questionSummary = renderQuestionSummary(questions, input.summary);
  const missingRequiredContext = !context
    && questions.some((item) => questionDependsOnContext(item.question));
  return [
    ...(context ? ["待确认内容：", context] : []),
    ...(missingRequiredContext
      ? ["⚠ 被确认的具体内容没有随审批卡提供，不能只看选项安全决定。"]
      : []),
    questionSummary,
  ].join("\n");
}

export interface NotifierOptions {
  /** 小鲁班发送端点(真件=内网地址,演示=FakeLubanServer)。 */
  endpoint: string;
  /** 真件鉴权头(如 Authorization)。假件不需要;值是密钥,来自
   * 权限 600 的配置文件,不落日志。 */
  headers?: Record<string, string>;
  /** 运行时覆盖(管理页热改):每次发送现读,返回 endpoint/headers 的
   * 覆盖值,没有就回落静态配置。生效边界=下一条消息。 */
  live?: () => { endpoint?: string; headers?: Record<string, string> };
  /** 发件人的通知令牌(小鲁班以令牌对应的人的身份发消息,所以
   * 按发起人取,不是服务级配一个)。**只经请求头下发**——请求体会被外部
   * 动作台账原样记进投影,令牌进体等于把密钥写进数据库。 */
  personalToken?: (account: string) => string | undefined;
  /** 端点是假小鲁班(演示/试跑形态,serve 自己起的):假件收什么都行,
   * 个人令牌在它面前没有意义。这个标记让配置门禁不去索要一个谁也用
   * 不上的令牌——演示模式登进去第一件事就被"先配令牌"挡住,是内网
   * agent 端到端验证实测撞上的假门。 */
  fake?: boolean;
  /** 有限退避重试的间隔(毫秒);长度即最大重试次数。 */
  backoffMs?: number[];
  /** 小鲁班真实入站回复已完成端到端验收时，才在通知里承诺手机入口。 */
  mobileApproval?: boolean;
  /** 为当前 waiting 生成短期审批码。密钥留在实现闭包中，不进通知器。 */
  approvalCode?: (input: {
    account: string;
    taskId: string;
    waitingId: string;
    stateVersion: number;
  }) => string;
  /** 文案模板(可选):三类通知各一条。占位符词汇表与配置方法见
   * docs/luban-notification-templates.md;配错(表外占位符)构造期
   * 拒绝。只管正文,激活提示与手机审批指令永远由代码追加。 */
  templates?: NotificationTemplates;
  log?: (message: string) => void;
}

export class Notifier {
  private records = new Map<string, NotifyRecord>();
  private pendingDeliveries = new Map<string, Promise<void>>();
  private latestApprovals = new Map<string, LubanApprovalNotification>();
  private readonly templates: Required<NotificationTemplates>;

  constructor(readonly options: NotifierOptions) {
    this.templates = resolveTemplates(options.templates);
  }

  list(): NotifyRecord[] {
    return [...this.records.values()];
  }

  /** 手机回调读最近通知的短期绑定。返回副本，调用方不能改通知器状态。 */
  latestApproval(account: string): LubanApprovalNotification | undefined {
    const found = this.latestApprovals.get(account);
    return found ? { ...found } : undefined;
  }

  /** 原位重跑或彻底删除后，旧任务通知不能继续占用幂等键。发送中的
   * Promise 只持有 record 对象，删除 Map 项后即使晚到也不会复活。 */
  purgeTask(taskId: string): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.task_id !== taskId) continue;
      this.records.delete(id);
      // 发送请求不能真正取消，但它不应阻止同 ID 的新任务启动新发送。
      this.pendingDeliveries.delete(id);
      removed += 1;
    }
    for (const [account, binding] of this.latestApprovals) {
      if (binding.taskId === taskId) this.latestApprovals.delete(account);
    }
    return removed;
  }

  /** 配置门禁问的:这个通知器要不要逼人配个人令牌?
   * 假件在场且没被管理页热改成真端点 → 不要(令牌没人消费);
   * 管理页一旦切了真端点,要求立刻恢复——判定跟着**生效端点**走,
   * 不是跟着启动形态走。 */
  needsPersonalToken(): boolean {
    if (!this.options.fake) return true;
    return !!this.options.live?.()?.endpoint?.trim();
  }

  /** 自检只暴露“是否配置/最近是否失败”，不回端点鉴权内容。 */
  health(): { configured: boolean; last_error?: string } {
    const latest = this.list().at(-1);
    return {
      configured: !!this.target().endpoint.trim(),
      last_error: latest?.settled && !latest.delivered && latest.attempts > 0
        ? latest.last_error || "最近一条通知未送达" : undefined,
    };
  }

  /** 发送一张待办。同 waiting_id 幂等——恢复重放不重复通知。 */
  async notifyWaiting(input: {
    waitingId: string;
    stateVersion?: number;
    taskId: string;
    /** 面向人的任务称呼；DTS 可带问题单号，缺席时保持旧文案。 */
    subject?: string;
    account: string;
    step: string;
    /** 旧调用方可直接给摘要；正常待办应传结构化 questions，避免丢题。 */
    summary?: string;
    /** 提问前展示给用户的材料。“上述配置是否正确”所指的具体内容在这里。 */
    context?: string;
    questions?: NotifyQuestion[];
    link: string;
  }): Promise<NotifyRecord> {
    const existing = this.records.get(input.waitingId);
    if (existing) {
      await this.deliverTracked(existing);
      return existing;
    }
    const visibleQuestions = this.options.mobileApproval
      ? input.questions?.slice(0, 1) : input.questions;
    const summary = waitingSummary({
      ...input,
      questions: visibleQuestions,
    });
    const questions = (input.questions ?? []).filter((item) =>
      String(item?.question ?? "").trim());
    const missingRequiredContext = !notificationContext(input.context)
      && (visibleQuestions ?? []).some((item) =>
        questionDependsOnContext(String(item?.question ?? "")));
    const approvalCode = this.options.mobileApproval && !missingRequiredContext
      && this.options.approvalCode && input.stateVersion !== undefined
      ? this.options.approvalCode({
          account: input.account,
          taskId: input.taskId,
          waitingId: input.waitingId,
          stateVersion: input.stateVersion,
        })
      : "";
    const stage = humanApprovalStage(input.step);
    const subject = input.subject?.trim() || `任务 ${input.taskId}`;
    const record: NotifyRecord = {
      waiting_id: input.waitingId,
      task_id: input.taskId,
      account: input.account,
      step: input.step,
      summary,
      link: input.link,
      text:
        withPluginActivationNotice(renderTemplate(this.templates.waiting, {
          task_id: input.taskId,
          subject,
          step: input.step,
          stage,
          summary,
          account: input.account,
          link: input.link,
        })) +
        (this.options.mobileApproval
          ? missingRequiredContext
            ? "\n插件激活后，本通知仍缺少被确认内容，已禁止裸序号审批；"
              + "请打开任务链接核对后处理。"
            : approvalCode
            ? "\n插件激活后，只有这一项待办时，可回复选项序号，例如：1"
              + `\n多项待办或无上下文时：mae-flow 选择 ${approvalCode} <序号>`
              + "\n如需说明：mae-flow 选择 " + approvalCode
              + " <序号> <补充说明>"
              + (questions.length > 1
                ? `\n本卡共 ${questions.length} 个问题，提交后继续显示下一题。`
                : "")
            : "\n插件激活后，发送“mae-flow 待审批”查看当前待办。"
          : ""),
      attempts: 0,
      delivered: false,
      settled: false,
      last_error: "",
    };
    this.records.set(input.waitingId, record);
    if (approvalCode && input.stateVersion !== undefined) {
      this.latestApprovals.set(input.account, {
        account: input.account,
        taskId: input.taskId,
        waitingId: input.waitingId,
        stateVersion: input.stateVersion,
        code: approvalCode,
        notifiedAt: Date.now(),
      });
    }
    // TaskService 会把这个 Promise 旁路调度，因此不阻塞流程；Promise
    // 本身只在有限重试结束后返回，调用方落盘拿到的一定是最终事实。
    await this.deliverTracked(record);
    return record;
  }

  /** 任务收口通知(完成/交付/失败)。同任务同状态幂等——
   * 恢复重放或催办多次收轮,用户只收一条。 */
  async notifyOutcome(input: {
    taskId: string;
    account: string;
    status: string;
    summary: string;
    link: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:outcome:${input.status}`;
    const existing = this.records.get(key);
    if (existing) {
      await this.deliverTracked(existing);
      return existing;
    }
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: input.status,
      summary: input.summary,
      link: input.link,
      text: withPluginActivationNotice(renderTemplate(this.templates.outcome, {
        task_id: input.taskId,
        status: input.status,
        summary: input.summary,
        account: input.account,
        link: input.link,
      })),
      attempts: 0,
      delivered: false,
      settled: false,
      last_error: "",
    };
    this.records.set(key, record);
    await this.deliverTracked(record);
    return record;
  }

  /** 登记指派通知(ADR-0031):测试登记问题并指派责任人时一次性送达。
   * 同问题幂等(恢复重放不重发);发送失败由调用方旁路,不改登记结果。 */
  async notifyAssignment(input: {
    taskId: string;
    /** 责任人:问题登记后的归属与推进人,通知收件人。 */
    account: string;
    /** 登记人(通常是测试):通知里点名是谁递来的问题。 */
    reporter: string;
    title: string;
    link: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:assigned`;
    const existing = this.records.get(key);
    if (existing) {
      await this.deliverTracked(existing);
      return existing;
    }
    const summary =
      `${input.reporter} 登记了问题「${input.title}」并指派你为责任人`;
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: "assigned",
      summary,
      link: input.link,
      text: withPluginActivationNotice(renderTemplate(this.templates.assigned, {
        reporter: input.reporter,
        title: input.title,
        account: input.account,
        link: input.link,
      })),
      attempts: 0,
      delivered: false,
      settled: false,
      last_error: "",
    };
    this.records.set(key, record);
    await this.deliverTracked(record);
    return record;
  }

  /** 自动接单通知(ADR-0061):平台定时扫描替责任人发起名下 DTS 单后
   *  一次性送达。同问题幂等(恢复重放不重发);发送失败由调用方旁路,
   *  不改发起结果。 */
  async notifyAutoClaim(input: {
    taskId: string;
    /** 责任人=收件人:单子在他的名下,发起也以他的身份(自登记)。 */
    account: string;
    title: string;
    link: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:auto-claimed`;
    const existing = this.records.get(key);
    if (existing) {
      await this.deliverTracked(existing);
      return existing;
    }
    const summary = `系统自动接单:「${input.title}」已发起问题会话`;
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: "auto_claimed",
      summary,
      link: input.link,
      text: withPluginActivationNotice(renderTemplate(
        this.templates.auto_claimed, {
          title: input.title,
          account: input.account,
          link: input.link,
        })),
      attempts: 0,
      delivered: false,
      settled: false,
      last_error: "",
    };
    this.records.set(key, record);
    await this.deliverTracked(record);
    return record;
  }

  /** 责任人主动邀请 Committer 检视。与流程自动通知不同：
   * 每次点击都是一次明确动作，因此不跨点击幂等，并等待发送结果回给界面。 */
  async notifyReview(input: {
    taskId: string;
    senderAccount: string;
    account: string;
    summary: string;
    link: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:review:${input.account}:${Date.now()}`;
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: "committer_review",
      summary: input.summary,
      link: input.link,
      text: withPluginActivationNotice(renderTemplate(this.templates.review, {
        task_id: input.taskId,
        summary: input.summary,
        account: input.account,
        sender_account: input.senderAccount,
        link: input.link,
      })),
      attempts: 0,
      delivered: false,
      settled: false,
      last_error: "",
    };
    this.records.set(key, record);
    await this.deliverTracked(record, input.senderAccount);
    return record;
  }

  /** Agent 已按人的意见改完，回请意见提出人复检。revisionKey 绑定
   * “这一批意见 + 这一版代码”，恢复重放不会重复轰炸；新一轮返工仍会
   * 产生新提醒。 */
  async notifyReviewReady(input: {
    taskId: string;
    senderAccount: string;
    account: string;
    summary: string;
    link: string;
    revisionKey: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:review-ready:${input.account}:`
      + input.revisionKey;
    const existing = this.records.get(key);
    if (existing) {
      await this.deliverTracked(existing, input.senderAccount);
      return existing;
    }
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: "review_ready",
      summary: input.summary,
      link: input.link,
      text: withPluginActivationNotice(renderTemplate(this.templates.review, {
        task_id: input.taskId,
        summary: input.summary,
        account: input.account,
        sender_account: input.senderAccount,
        link: input.link,
      })),
      attempts: 0,
      delivered: false,
      settled: false,
      last_error: "",
    };
    this.records.set(key, record);
    await this.deliverTracked(record, input.senderAccount);
    return record;
  }

  /** 当前生效的发送目标:运行时覆盖压过静态配置。 */
  private target(): { endpoint: string; headers: Record<string, string> } {
    const live = this.options.live?.() ?? {};
    return {
      endpoint: live.endpoint ?? this.options.endpoint,
      headers: { ...this.options.headers, ...live.headers },
    };
  }

  /** 测试发送(管理页按钮):单次、不重试、结果如实带回。
   * 它绕开台账(records)——测试消息不是业务事实,不该混进发送记录。 */
  async testDelivery(account: string): Promise<{ ok: boolean; error?: string }> {
    const { endpoint, headers } = this.target();
    try {
      const personal = this.options.personalToken?.(account);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
          ...(personal
            ? { "x-mfc-luban-token": encodeURIComponent(personal) } : {}),
        },
        body: JSON.stringify({
          account,
          text: withPluginActivationNotice(
            "Mae-Flow 通知连通测试:看到这条即配置生效"),
          link: "",
        }),
      });
      return response.ok
        ? { ok: true }
        : { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private async deliver(
    record: NotifyRecord,
    tokenAccount = record.account,
  ): Promise<void> {
    const backoff = this.options.backoffMs ?? [0, 2_000, 10_000];
    for (const delay of backoff) {
      if (delay) await new Promise((tick) => setTimeout(tick, delay));
      record.attempts += 1;
      try {
        const { endpoint, headers } = this.target();
        const personal = this.options.personalToken?.(tokenAccount);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headers,
            // 个人令牌走头不走体(密钥纪律,同交付链的 x-mfc-git-token):
            // 桥拿它填进内网接口要的字段,宿主这边台账里不会留下明文。
            ...(personal
              ? { "x-mfc-luban-token": encodeURIComponent(personal) } : {}),
          },
          body: JSON.stringify({
            account: record.account,
            text: record.text,
            link: record.link,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        record.delivered = true;
        record.settled = true;
        record.last_error = "";
        return;
      } catch (error) {
        record.last_error = String(error);
        this.options.log?.(
          `通知发送失败(第 ${record.attempts} 次): ${record.last_error}`);
      }
    }
    // 重试预算耗尽:留痕即可,流程状态一个字不动(§14.4)。
    record.settled = true;
  }

  /** 同一幂等记录在并发重放时共享一次发送；所有等待者只拿最终事实。 */
  private async deliverTracked(
    record: NotifyRecord,
    tokenAccount = record.account,
  ): Promise<void> {
    if (record.settled) return;
    let pending = this.pendingDeliveries.get(record.waiting_id);
    if (!pending) {
      const started = this.deliver(record, tokenAccount);
      pending = started.finally(() => {
        // purge 后可能已有同 ID 新发送；旧 Promise 晚到不能删掉新值。
        if (this.pendingDeliveries.get(record.waiting_id) === pending) {
          this.pendingDeliveries.delete(record.waiting_id);
        }
      });
      this.pendingDeliveries.set(record.waiting_id, pending);
    }
    await pending;
  }
}

/** 假小鲁班:收什么记什么,GET /messages 可查——演示与测试用。 */
export class FakeLubanServer {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly requestHeaders: Array<
    Record<string, string | string[] | undefined>
  > = [];
  /** 测试注入:>0 时前 N 次请求返回 500,验证退避重试。 */
  failFirst = 0;
  private server?: Server;

  get endpoint(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/notify`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method === "GET") {
        const body = JSON.stringify(this.messages);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(body);
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (this.failFirst > 0) {
          this.failFirst -= 1;
          response.writeHead(500).end();
          return;
        }
        try {
          this.messages.push(
            JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          this.requestHeaders.push({ ...request.headers });
        } catch {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
