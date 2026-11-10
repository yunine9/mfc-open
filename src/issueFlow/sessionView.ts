/**
 * 问题会话的「耗时与卡点」视图(纯函数,只吃投影数据)。
 *
 * 与需求侧的 src/timeline.ts 同一精神,但问题流的现场不同:没有
 * 内核阶段账本,只有消息账(events.jsonl 的 user/assistant/decision
 * 投影)、状态文件里的转移账(transitions)和当前的问题卡。这里把
 * 三者归纳成"时间去哪了、卡在谁身上"的结论视图。
 *
 * 两条纪律:
 * - **纯函数**。不碰文件系统、不看时钟(渲染时刻由调用方注入),
 *   单测可以直接喂构造数据钉死语义。
 * - **fail-open**。缺字段、坏时间戳、空数组一律降级为空缺席,
 *   绝不抛错——展示旁路不许把页面拖垮。
 */

/** 会话状态投影:只要时间线关心的字段(多余字段无妨)。 */
export interface IssueTimelineStateInput {
  created_at?: string;
  updated_at?: string;
  status?: string;
  stage_note?: string;
  stage_at?: string;
  transitions?: Array<{
    at?: string;
    source?: string;
    stage?: string;
    note?: string;
  }>;
}

/** 消息投影(role/text/ts;time 为 ISO 或可解析串)。 */
export interface IssueTimelineMessageInput {
  role?: string;
  text?: string;
  ts?: string;
}

/** 当前问题卡(created_at 决定未决等待从何时起算)。 */
export interface IssueTimelineWaitingInput {
  created_at?: string;
}

export interface IssueTimelineInput {
  state?: IssueTimelineStateInput | null;
  messages?: IssueTimelineMessageInput[] | null;
  waiting?: IssueTimelineWaitingInput | null;
  /** 渲染时刻:开着的等待以它封口。缺省 Date.now()(仅服务端组装时)。 */
  now?: string | number | Date;
}

// ---- 输出形状(web/src/api.ts 有镜像类型,两处同步改) ----

export interface IssueSessionSpan {
  start: string;
  end: string;
  ms: number;
}

export interface IssueHumanWait {
  start: string;
  end?: string;
  ms: number;
  /** 仍在等(status=waiting_user 且问题卡未决):ms 以 now 截止。 */
  open_ended?: boolean;
  question: string;
}

export type IssueTimelineEventKind = "assistant" | "decision" | "stage";

export interface IssueTimelineEvent {
  ts: string;
  kind: IssueTimelineEventKind;
  /** stage 条目的来源标记(AI 上报 / 平台事实),同转移账。 */
  source?: string;
  title: string;
  detail?: string;
}

export interface IssueSessionTimeline {
  span: IssueSessionSpan;
  human_waits: IssueHumanWait[];
  human_wait_ms: number;
  human_wait_share: number;
  longest_waits: IssueHumanWait[];
  decisions: number;
  blocker: string;
  events: IssueTimelineEvent[];
}

const QUESTION_EXCERPT = 80;

function ms(value: unknown): number {
  if (value === undefined || value === null || value === "") return NaN;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function clip(value: unknown, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** 忽略坏值(NaN)的取大/取小:Math.max 会传染——只要有一个候选是
 * 坏时刻,整个区间就被毒成 NaN。多路时间求边界必须跳过坏值。 */
function maxFinite(...values: number[]): number {
  let best = NaN;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    best = Number.isFinite(best) ? Math.max(best, value) : value;
  }
  return best;
}

function minFinite(...values: number[]): number {
  let best = NaN;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    best = Number.isFinite(best) ? Math.min(best, value) : value;
  }
  return best;
}

/** 开题节选:assistant 消息既是结论文也是提问载体,截出问句供列表用。 */
function excerpt(text: unknown): string {
  return clip(text, QUESTION_EXCERPT);
}

/**
 * 归纳一个会话的时间线。任何一路数据出问题只让那一路缺席,
 * 整体永远返回完整形状(极端情况退化为全零/空表)。
 */
export function buildIssueTimeline(
  input: IssueTimelineInput,
): IssueSessionTimeline {
  try {
    return buildInner(input ?? {});
  } catch {
    // fail-open 红线:归纳逻辑自己出岔子也不能炸掉调用方。
    return {
      span: { start: "", end: "", ms: 0 },
      human_waits: [],
      human_wait_ms: 0,
      human_wait_share: 0,
      longest_waits: [],
      decisions: 0,
      blocker: "",
      events: [],
    };
  }
}

function buildInner(input: IssueTimelineInput): IssueSessionTimeline {
  const state = input.state ?? {};
  const messages = Array.isArray(input.messages) ? input.messages : [];

  // ---- 等待段配对:一段 AI 陈述后到下一次人开口之间,都算在等人 ----
  // 连续多条 assistant 视为同一陈述的延续:起点取首条,问句节选取末条
  // (那是人作答前看到的最后一句话)。
  const waits: Array<{ wait: IssueHumanWait; endMs: number }> = [];
  let pending:
    | { startTs: string; startMs: number; question: string }
    | undefined;
  let decisions = 0;
  let lastMessageMs = NaN;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role ?? "");
    const atMs = ms(message.ts);
    const atIso = Number.isFinite(atMs)
      ? String(message.ts) : "";
    if (Number.isFinite(atMs)) {
      lastMessageMs = Number.isFinite(lastMessageMs)
        ? Math.max(lastMessageMs, atMs) : atMs;
    }
    if (role === "assistant") {
      if (!pending && Number.isFinite(atMs)) {
        pending = {
          startTs: atIso,
          startMs: atMs,
          question: excerpt(message.text),
        };
      } else if (pending) {
        const question = excerpt(message.text);
        if (question) pending.question = question;
      }
      continue;
    }
    if (role === "decision") decisions += 1;
    if ((role === "user" || role === "decision") && pending) {
      if (!Number.isFinite(atMs)) {
        // 尾部回复没有可信时间:配不成对就放弃这一段,不猜时长。
        pending = undefined;
        continue;
      }
      waits.push({
        wait: {
          start: pending.startTs,
          end: atIso,
          ms: Math.max(0, atMs - pending.startMs),
          question: pending.question || "等待人工继续",
        },
        endMs: atMs,
      });
      pending = undefined;
    }
  }

  // 未决的等待:问题卡还开着就是此刻仍然在等,以 now 封口。
  let nowMs = input.now === undefined ? Date.now() : ms(input.now);
  if (!Number.isFinite(nowMs)) nowMs = Date.now();
  const openCardMs = ms(input.waiting?.created_at);
  const isOpenWait =
    String(state.status ?? "") === "waiting_user"
    && (Boolean(pending) || Number.isFinite(openCardMs));
  if (isOpenWait) {
    // 卡片的 created_at 是权威起点;拿不到再退化用最后一条 AI 消息。
    const startMs = Number.isFinite(openCardMs) ? openCardMs : pending!.startMs;
    const startTs = Number.isFinite(openCardMs)
      ? String(input.waiting!.created_at) : pending!.startTs;
    waits.push({
      wait: {
        start: startTs,
        ms: Math.max(0, nowMs - startMs),
        open_ended: true,
        question: pending?.question || "(等待用户答复)",
      },
      endMs: nowMs,
    });
  }

  // ---- 耗时区间:开场到最近一次活动 ----
  const createdMs = ms(state.created_at);
  const updatedMs = ms(state.updated_at);
  const stageAtMs = ms(state.stage_at);
  const spanStartMs = minFinite(createdMs, lastMessageMs);
  let spanEndMs = maxFinite(updatedMs, stageAtMs);
  for (const item of waits) {
    spanEndMs = maxFinite(spanEndMs, item.endMs);
  }
  if (!Number.isFinite(spanEndMs)) spanEndMs = lastMessageMs;
  // 问题卡还开着 = 会话还活着:区间延伸到查询时刻,否则"总耗时"会小于
  // 正在进行的等待(与任务侧 total=max(last-first, waitedTotal) 同理)。
  if (isOpenWait) spanEndMs = maxFinite(spanEndMs, nowMs);
  const spanMs = Number.isFinite(spanStartMs) && Number.isFinite(spanEndMs)
    ? Math.max(0, spanEndMs - spanStartMs) : 0;

  const humanWaitMs = waits.reduce((sum, item) => sum + item.wait.ms, 0);
  const share = spanMs > 0
    ? Math.min(100, Math.round((humanWaitMs / spanMs) * 100))
    : 0;

  const sortedWaits = [...waits.map((item) => item.wait)]
    .sort((left, right) => right.ms - left.ms);

  // ---- 关键事件:结论节选 + 人决策 + 阶段切换(带来源标记)----
  const events: IssueTimelineEvent[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role ?? "");
    const ts = String(message.ts ?? "");
    if (!Number.isFinite(ms(ts))) continue;
    if (role === "assistant") {
      events.push({
        ts, kind: "assistant",
        title: excerpt(message.text) || "(无正文)",
      });
    } else if (role === "decision") {
      events.push({
        ts, kind: "decision",
        title: clip(message.text, QUESTION_EXCERPT) || "(无决定)",
      });
    }
  }
  for (const transition of Array.isArray(state.transitions)
    ? state.transitions : []) {
    if (!transition || typeof transition !== "object") continue;
    if (!transition.stage) continue; // 只画"到了哪个阶段",普通备注不上墙
    events.push({
      ts: String(transition.at ?? ""),
      kind: "stage",
      source: transition.source === "platform" ? "platform" : "agent",
      title: clip(transition.stage, 20),
      detail: clip(transition.note, 80) || undefined,
    });
  }
  // 异常/缺失时间沉到最后,不让一行坏数据打乱整条链。
  events.sort((left, right) => {
    const leftMs = ms(left.ts);
    const rightMs = ms(right.ts);
    if (!Number.isFinite(leftMs) && !Number.isFinite(rightMs)) return 0;
    if (!Number.isFinite(leftMs)) return 1;
    if (!Number.isFinite(rightMs)) return -1;
    return leftMs - rightMs;
  });

  // ---- 当前卡点:还在等的问句优先,其次阶段备注 ----
  const blocker = isOpenWait
    ? (pending?.question || "(等待用户答复)")
    : clip(state.stage_note, QUESTION_EXCERPT);

  return {
    span: {
      start: Number.isFinite(spanStartMs)
        ? firstTimestamp(messages, state.created_at) : "",
      // 开着的会话把查询时刻也作为终点候选,字符串与毫秒数同一口径。
      end: Number.isFinite(spanEndMs)
        ? latestTimestamp(messages, state.updated_at, state.stage_at,
          isOpenWait ? new Date(nowMs).toISOString() : undefined)
        : "",
      ms: spanMs,
    },
    human_waits: waits.map((item) => item.wait),
    human_wait_ms: humanWaitMs,
    human_wait_share: share,
    longest_waits: sortedWaits.slice(0, 2),
    decisions,
    blocker,
    events,
  };
}

/** 首个可信的消息时间(span 起点):坏值跳过,回退 created_at。 */
function firstTimestamp(
  messages: IssueTimelineMessageInput[],
  fallback?: string,
): string {
  for (const message of messages) {
    if (message && typeof message === "object"
        && Number.isFinite(ms(message.ts))) {
      return String(message.ts ?? "");
    }
  }
  return fallback ?? "";
}

/** 最近的活动时刻(span 终点字符串):消息、updated_at、stage_at(及
 * 开放会话的查询时刻)取最大;坏值跳过。 */
function latestTimestamp(
  messages: IssueTimelineMessageInput[],
  updatedAt?: string,
  stageAt?: string,
  extra?: string,
): string {
  let bestMs = NaN;
  let bestTs = "";
  const consider = (value?: string) => {
    const atMs = ms(value);
    if (!Number.isFinite(atMs)) return;
    if (!Number.isFinite(bestMs) || atMs > bestMs) {
      bestMs = atMs;
      bestTs = String(value ?? "");
    }
  };
  consider(updatedAt);
  consider(stageAt);
  consider(extra);
  for (const message of messages) {
    if (message && typeof message === "object") consider(message.ts);
  }
  return bestTs;
}
