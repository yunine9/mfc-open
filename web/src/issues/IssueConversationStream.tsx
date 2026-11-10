/**
 * 右栏协作对话框(#124):问题域「与 Agent 协作」的轻量会话流。
 *
 * ADR-0018:任务侧 ConversationStream 的形状是两域共同目标,但那个组件
 * 与任务域的批注账、线程视图、人员名录、开发助手耦合过深;问题域协作流
 * 只有六类成员(session/turn/card/decision/steer/review/receipts),且
 * 本票全部只读回放,所以在 issues 域落一个轻量适配器:消息气泡复用
 * conv-* 与 ws-stream 全套类(样式与任务侧同一份;长文量高折叠、步骤
 * 查看入口、流内筛选 2026-09-08 起也对齐同款),渲染纪律与任务侧一致
 * ——所有事实来自聚合接口,这里不推断状态,只排版。
 *
 * 数据:GET /issues/:id/conversation(getIssueConversation),会话视图
 * 可见时每 4 秒轮询一次(任务侧同款节奏),换会话重置(序号作废半拍
 * 旧响应);贴底跟随 + 「有新消息」行为照搬任务侧。
 *
 * 卡座与 dock(#125,ADR-0018 决策三「举卡入流」的通用模式,#126 照此
 * 铺其余三类卡):
 * - 卡座挂载点:当前等待卡永远钉在消息流末尾的 Agent 气泡内
 *   (conv-card current,任务侧同款),不随时间线被新条目埋掉;流内
 *   同卡(同 waiting_id)的投影副本按 id 去重防双卡,其余历史卡
 *   (含更早已决定/作废的 waiting 投影)照常只读回放。卡上只留
 *   题面/表单/选项。
 * - dock 目标:输入区在等卡分支预留 ws-reply-dock 容器(dockRef 回调
 *   把节点交给会话视图,会话视图把它作为 footerTarget 发给当前卡),
 *   卡的提交区(附言+提交/拒绝按钮)经 createPortal 挂进来——附言与
 *   决定一并提交,表单状态仍归卡组件(见 IssueDecisionCard)。
 * - 查看模式(canOperate=false):卡以只读事实面(IssueWaitingFacts)
 *   钉在流末尾,不出 dock,输入区只读。
 * - 无卡:输入区恢复普通输入(运行中=插话/idle=续聊),dock 容器不渲染。
 *
 * 输入区按会话状态分派(轻量仿制任务侧 ws-composer 的结构与类名):
 * 运行中=插话(steerIssue,不打断当前步骤)、空闲=续聊(replyIssue);
 * 人工接管中(2026-09-07 走查拍板,takeover=true)=人工驾驶:记录进
 * 现场账(addIssueTakeoverNote,只记账不投喂)或交还给 AI
 * (resumeIssueTakeover,以当前输入作交还说明);等卡/未启动/
 * 终态给原因说明,查看者(canOperate=false)只见只读提示——写口语义
 * 与拆栏前(#126 及更早)的 canOperate 门零变化。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getIssueConversation,
  type IssueConversationItem,
  type IssueConversationSteps,
  type IssueGateKind,
  type IssueStatus,
} from "../api";
import { atBottom } from "../follow";
import { conversationCardTitle } from "../ConversationStream";
import { ClampedText } from "../ClampedText";
import { Markdown } from "../markdown";
import { formatLocalClock, formatLocalDate, formatLocalDateTime } from "../time";
import { startVisiblePolling } from "../visiblePolling";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/Alert";
import { Empty, EmptyDescription } from "@/components/Empty";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

/** 发言人头像底色(#220 从 .conv-avatar CSS 迁为令牌工具类,口径与
 * 任务侧 ConversationStream 的 CONV_AVATAR_TONE 一致;问题域只有三角色)。 */
const CONV_AVATAR_TONE = {
  agent: "bg-(--ink)",
  you: "bg-(--text-strong)",
  person: "bg-(--muted)",
} as const;

/** 本页气泡词典(#231 换装):协作流气泡原白拿任务侧 conversation.css 的
 * conv-* 皮(选择器挂在两域共有的 task-workspace-v2 根上),问题域改
 * 本页令牌工具类直译——同尺寸同色板,明暗自适应;conv-* CSS 为尚未
 * 迁移的任务侧 ConversationStream 保留,问题域不再搭车。 */
const CONV = {
  msg: "grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 [scroll-margin-top:12px]",
  body: "grid min-w-0 content-start gap-1.5",
  who: "flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground",
  whoName: "font-semibold text-text-strong",
  whoTime: "text-faint",
  tag: "inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-xs font-medium not-italic",
  tagTone: {
    neutral: "bg-surface-3 text-muted-foreground",
    ok: "bg-success-soft text-success",
    att: "bg-attention-soft text-attention",
    ink: "bg-(--ink-soft) text-ink",
  } as const,
  text: "text-base text-text [overflow-wrap:anywhere]",
  answer: "m-0 whitespace-pre-wrap text-base text-text [overflow-wrap:anywhere]",
  notes: "m-0 whitespace-pre-wrap text-sm text-muted-foreground",
  lead: "m-0 text-sm text-text",
  earlier: "border-l-2 border-line pl-2.5",
  earlierSummary: "cursor-pointer text-xs text-muted-foreground",
  earlierSummaryFaint: "cursor-pointer text-xs text-faint",
  earlierText: "mt-2 text-sm text-muted-foreground [overflow-wrap:anywhere]",
  act: "block w-full cursor-pointer truncate text-left text-xs text-muted-foreground hover:text-ink",
  actArrow: "mr-1.5 text-faint",
  date: "-mb-1 mt-1 flex items-center gap-2.5 text-xs text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line",
  more: "cursor-pointer rounded-md border border-dashed border-line-strong bg-transparent px-2.5 py-2 text-xs text-muted-foreground hover:border-text-strong hover:text-text-strong",
  problem: "rounded-md bg-attention-soft px-2.5 py-2 text-left text-xs text-attention",
  empty: "px-3 py-6 text-center text-xs text-muted-foreground",
  card: "overflow-hidden rounded-lg border bg-surface",
  cardHead: "border-b border-line px-3.5 pb-2 pt-2.5",
  cardTitle: "mt-0.5 text-base font-semibold leading-snug text-text-strong",
  question: "px-3.5 pb-1 pt-2",
  questionText: "m-0 mb-1.5 text-sm text-text",
  options: "m-0 mb-1.5 grid list-none gap-1.5 p-0",
  option: "rounded-md border border-line px-2.5 py-1.5 text-sm text-muted-foreground",
  optionChosen:
    "border-ink bg-(--ink-soft) font-semibold text-ink after:ml-1 after:content-['✓']",
  answerLine: "m-0 text-base text-text [overflow-wrap:anywhere]",
  receipts: "m-0 grid list-none gap-2 p-0",
  receipt: "grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2",
  receiptIcon: "mt-[3px] grid size-4 place-items-center rounded-full text-[10px] not-italic text-white",
  receiptBody: "grid min-w-0 gap-0.5",
  receiptName: "font-semibold text-text",
  receiptNote: "text-xs text-muted-foreground",
} as const;

/** 流内卡的状态皮:等待中的当前卡描强线,历史卡(已决定/作废)收灰。 */
const convCardClass = (waiting: boolean) =>
  cn(CONV.card, waiting ? "border-line-strong" : "border-line");

/** 卡头词签:等待卡用琥珀,历史卡收灰。 */
const convKickerClass = (muted: boolean) =>
  muted ? "block text-xs font-medium text-faint" : "block text-xs font-medium text-attention";

/** 一屏先渲最近这些条;更早的按需展开(与任务侧同款节奏)。 */
const INITIAL_LIMIT = 50;

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]!.toUpperCase() : "?";
}

/** 回合步骤一行话(口径与任务侧一致):改了什么、跑了什么,共几步。 */
function stepsLine(steps: IssueConversationSteps): string {
  const parts: string[] = [];
  for (const entry of steps.sample) {
    parts.push(entry.kind === "edit" ? `编辑 ${entry.subject}`
      : entry.kind === "bash" ? `运行 ${entry.subject}` : `派子任务 ${entry.subject}`);
  }
  const total = steps.calls + steps.agents;
  if (!parts.length && steps.reads) parts.push(`读取 ${steps.reads} 个文件`);
  const tail = `共 ${total} 步${steps.errors ? ` · ${steps.errors} 步失败` : ""}`;
  return parts.length ? `${parts.join(" · ")} · ${tail}` : tail;
}

/** 长交接语收折——直接用任务侧同款量高组件(ClampedText),折叠观感
 * 与任务侧一致;原按字数的简化版(2026-09-08 对齐拍板)已删。 */

export function IssueConversationStream({
  issueId,
  status,
  waiting,
  waitingId,
  waitingTs,
  waitingKind,
  canOperate,
  busy,
  owner,
  viewerUsername,
  takeover,
  currentCard,
  dockRef,
  onSteer,
  onReply,
  onTakeover,
  onTakeoverNote,
  onResumeTakeover,
  onOpenEvents,
}: {
  issueId: string;
  /** 会话状态:输入区的插话/续聊/禁用分派只看它和 waiting。 */
  status: IssueStatus;
  /** 当前有等归属人的卡:真卡钉在流末尾的 Agent 气泡内(#125 卡座)。 */
  waiting: boolean;
  /** 当前卡的 waiting_id(卡座去重键):流内同卡投影按它摘除,防双卡。 */
  waitingId?: string;
  /** 当前卡的举起时刻(流内投影还没轮询到时给卡座气泡的时钟兜底)。 */
  waitingTs?: string;
  /** 当前卡的种类(平台闸的 gate_kind):卡座状态签与输入区提示按它
   *  分派——环境验证卡等的是验证不是答复(待验证),其余卡照旧。 */
  waitingKind?: IssueGateKind;
  /** 归属操作权(查看模式=false):false 时输入区只读,流完整可见。 */
  canOperate: boolean;
  busy: boolean;
  /** 会话归属人名:裁决/检视的署名与查看模式文案用。 */
  owner: string;
  /** 当前登录用户名(缺席=auth 关闭的演示形态,按归属人渲染)。 */
  viewerUsername?: string;
  /** 人工接管中(2026-09-07 走查拍板):真=AI 已暂停,输入区换人工
   * 驾驶模式(记录/交还);分派优先级在插话/续聊之前。 */
  takeover: boolean;
  /** 当前待处理卡(IssueDecisionCard / 查看模式 IssueWaitingFacts),
   * 会话视图组装;卡座把它钉在流末尾的 Agent 气泡内(#125)。 */
  currentCard?: ReactNode;
  /** 输入区 dock 容器的节点回调(#125):转交会话视图存为 footerTarget,
   * 当前卡的提交区经 portal 挂进 dock。 */
  dockRef?: (node: HTMLDivElement | null) => void;
  /** 运行中插话(SessionView 的 sendSteer → steerIssue)。 */
  onSteer: (text: string) => Promise<boolean>;
  /** 空闲续聊(SessionView 的 sendReply → replyIssue)。 */
  onReply: (text: string) => Promise<boolean>;
  /** 人工接管:打断 AI,现场交由人工(SessionView 包 perform)。 */
  onTakeover: () => Promise<boolean>;
  /** 接管期人工操作记录(不走 perform,失败原样抛回保字)。 */
  onTakeoverNote: (text: string) => Promise<void>;
  /** 交还:AI 带着人工记录继续;入参是可选的交还说明。 */
  onResumeTakeover: (note?: string) => Promise<boolean>;
  /** 「查看过程」入口(任务侧同款 conv-act):把左栏切到「对话现场」
   * 标签看每一步的原始事件(问题域没有「工作过程」视图)。 */
  onOpenEvents: () => void;
}) {
  const [view, setView] = useState<{
    items: IssueConversationItem[]; truncated: boolean;
    loaded: boolean; unavailable?: string;
  }>({ items: [], truncated: false, loaded: false });
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [hasNew, setHasNew] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastKey = useRef("");
  const sequence = useRef(0);

  const load = useCallback((id: string) => {
    const ticket = ++sequence.current;
    getIssueConversation(id).then((next) => {
      if (ticket !== sequence.current) return;
      setView({ items: next.items, truncated: next.truncated, loaded: true });
    }).catch(() => {
      if (ticket !== sequence.current) return;
      // 轮询断连多半偶发(休眠唤醒的死连接、服务重启半拍),下一拍自愈;
      // 给状态不给浏览器原文——「Failed to fetch」是噪声不是信息。
      setView((current) => ({ ...current, loaded: true,
        unavailable: "协作流暂时读不到，稍后自动重试。" }));
    });
  }, []);

  // 换会话重置:半拍旧响应按序号作废,流从空开始;可见才轮询,4 秒一拍。
  useEffect(() => {
    sequence.current += 1;
    setView({ items: [], truncated: false, loaded: false });
    const stop = startVisiblePolling(() => load(issueId), 4000, document);
    return () => { stop(); sequence.current += 1; };
  }, [issueId, load]);

  useEffect(() => {
    setLimit(INITIAL_LIMIT);
    pinned.current = true;
    setHasNew(false);
  }, [issueId]);

  // 卡座(#125):当前等待卡钉在流末尾的 Agent 气泡内;流内同卡(同
  // waiting_id)的投影副本按 id 摘除防双卡——不再整类过滤 waiting 投影,
  // 历史卡(已决定/作废)照常只读回放。等待说明(详情轮询)与协作流
  // (聚合轮询)节奏不同步的半拍,两源按 waiting_id 对齐。
  const projectedCurrent = useMemo(() => (waitingId
    ? view.items.find((item) =>
        item.kind === "card" && item.waiting_id === waitingId)
    : undefined), [view.items, waitingId]);
  const pinnedCard = Boolean(waiting && currentCard);
  const chronological = pinnedCard && waitingId
    ? view.items.filter((item) =>
        !(item.kind === "card" && item.waiting_id === waitingId))
    : view.items;
  const hidden = Math.max(0, chronological.length - limit);
  const limited = hidden ? chronological.slice(hidden) : chronological;
  // 「需要我的」= 此刻还等我动手的事(口径与任务侧 concernsViewer 一致):
  // 问题域里只有还开着的卡。当前卡本来钉在流末尾,不受筛选影响。
  const shown = filter === "mine"
    ? limited.filter((item) => item.kind === "card" && item.status === "waiting")
    : limited;

  // 新条目到达:贴底就跟着滚,离开底部就亮「有新消息」,不抢人正在读的位置。
  const streamKey = `${shown.at(-1)?.id ?? ""}:${shown.length}:${waitingId ?? ""}`;
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (pinned.current || !lastKey.current) {
      node.scrollTop = node.scrollHeight;
      const frame = window.requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
      setHasNew(false);
      lastKey.current = streamKey;
      return () => window.cancelAnimationFrame(frame);
    } else if (lastKey.current !== streamKey) {
      setHasNew(true);
    }
    lastKey.current = streamKey;
  }, [streamKey, view.loaded]);

  function scrollToEnd() {
    const node = box.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    pinned.current = true;
    setHasNew(false);
  }

  const decisions = useMemo(() => {
    const map = new Map<string, Extract<IssueConversationItem, { kind: "decision" }>>();
    for (const item of view.items) {
      if (item.kind === "decision") map.set(item.waiting_id, item);
    }
    return map;
  }, [view.items]);

  const isViewer = Boolean(viewerUsername) && viewerUsername !== owner;
  const nameOf = (username: string | undefined) =>
    !username || username === viewerUsername ? "你" : username;

  /* ---- 单条渲染(历史卡/裁决/插话/检视/回执一律只读回放) ---- */
  function message(options: {
    key: string; who: "agent" | "you" | "person";
    name: string; ts: string; tag?: ReactNode; children: ReactNode;
  }) {
    const avatar = options.who === "agent" ? "A"
      : options.who === "you" ? "你" : initial(options.name);
    return (
      <article className={CONV.msg} key={options.key}
        id={`conv-${options.key}`}>
        <Avatar size="sm" aria-hidden className="after:hidden">
          <AvatarFallback className={cn(
            "rounded-[7px] text-xs font-bold text-white",
            CONV_AVATAR_TONE[options.who])}>{avatar}</AvatarFallback>
        </Avatar>
        <div className={CONV.body}>
          <div className={CONV.who}>
            <b className={CONV.whoName}>{options.name}</b>
            {options.tag}
            <time className={CONV.whoTime} dateTime={options.ts}
              title={formatLocalDateTime(options.ts, { seconds: true, year: true })}>
              {formatLocalClock(options.ts)}
            </time>
          </div>
          {options.children}
        </div>
      </article>
    );
  }

  function render(item: IssueConversationItem): ReactNode {
    switch (item.kind) {
      case "session":
        return (
          <div className={CONV.date} key={item.id} id={`conv-${item.id}`}>
            {item.phase === "started"
              ? (item.resume ? "会话从断点恢复" : "会话开始")
              : `会话结束${item.detail ? ` · ${item.detail}` : ""}`}
          </div>
        );
      case "turn": {
        // 交接语摊开(最后一段走任务侧同款量高折叠,此前的折叠);全是
        // 过程话时把最后一段当交接语;过程话折成一行计数。工具步骤是
        // conv-act 按钮(任务侧同款),点开切到左栏「对话现场」标签看
        // 每一步的原始事件(问题域没有「工作过程」视图)。
        const handoffs = item.texts.filter((text) => text.role === "handoff");
        const narrations = item.texts.filter((text) => text.role === "narration");
        const spoken = handoffs.length ? handoffs
          : (narrations.length ? [narrations[narrations.length - 1]] : []);
        const folded = narrations.filter((text) => !spoken.includes(text));
        const earlier = spoken.slice(0, -1);
        const last = spoken.at(-1);
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: item.open ? <em className={cn(CONV.tag, CONV.tagTone.ink)}>正在进行</em> : undefined,
          children: <>
            {folded.length > 0 && (
              <details className={CONV.earlier}>
                <summary className={CONV.earlierSummaryFaint}>{folded.length} 段过程说明</summary>
                {folded.map((text, index) => (
                  <div className={CONV.earlierText} key={index}>
                    <Markdown text={text.text} />
                  </div>
                ))}
              </details>
            )}
            {earlier.length > 0 && (
              <details className={CONV.earlier}>
                <summary className={CONV.earlierSummary}>此前 {earlier.length} 段</summary>
                {earlier.map((text, index) => (
                  <div className={CONV.earlierText} key={index}>
                    <Markdown text={text.text} />
                  </div>
                ))}
              </details>
            )}
            {last && <ClampedText text={last.text} />}
            {(item.steps.calls > 0 || item.steps.agents > 0) && (
              <button type="button" className={CONV.act} onClick={onOpenEvents}
                title="到「对话现场」看每一步">
                <span aria-hidden className={CONV.actArrow}>▸</span>{stepsLine(item.steps)}
              </button>
            )}
          </>,
        });
      }
      case "card": {
        const decision = decisions.get(item.waiting_id);
        // 答案逐题对齐:decision 是逐题答案按题序的换行拼接(自定义
        // 答复是原文,选了给定选项的是选项原文)。匹配上选项就高亮,
        // 匹配不上=自定义答复,回填到题面上——只按行找选项的话,
        // 自定义回答在卡上就无影无踪(用户实测)。
        const answerLines = decision ? decision.decision.split("\n") : [];
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: <em className={cn(CONV.tag,
            item.status === "waiting" ? CONV.tagTone.att : CONV.tagTone.neutral)}>
            {item.status === "waiting" ? "等待决定"
              : item.status === "superseded" ? "已作废" : "已决定"}
          </em>,
          children: <div className={convCardClass(item.status === "waiting")}>
            <div className={CONV.cardHead}>
              <span className={convKickerClass(item.status !== "waiting")}>
                {item.purpose === "clarification" ? "追问" : "请你决定"}
              </span>
              <h4 className={CONV.cardTitle}>{conversationCardTitle(item)}</h4>
            </div>
            {item.questions.map((question, index) => {
              const line = answerLines[index] ?? "";
              const custom = line !== "" && !question.options.includes(line);
              return (
                <div className={CONV.question} key={index}>
                  {item.questions.length > 1 && <p className={CONV.questionText}>{question.question}</p>}
                  {question.options.length > 0 && (
                    <ul className={CONV.options}>
                      {question.options.map((option) => (
                        <li key={option}
                          className={option === line
                            ? cn(CONV.option, CONV.optionChosen) : CONV.option}>{option}</li>
                      ))}
                    </ul>
                  )}
                  {/* 有给定选项时,不匹配的答案行是自定义答复,带前缀
                      回填;开放题的答案行就是回答本身,直出不加 prefix。 */}
                  {custom && <p className={CONV.answerLine}>
                    {question.options.length > 0 ? `自定义答复:${line}` : line}
                  </p>}
                </div>
              );
            })}
          </div>,
        });
      }
      case "decision": {
        const who = item.by ?? owner;
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: who === viewerUsername ? "你" : (who || "归属人"), ts: item.ts,
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>
            {item.purpose === "clarification" ? "答复了追问" : "作了决定"}
          </em>,
          children: <>
            <p className={CONV.answer}>{item.decision}</p>
            {item.notes && <p className={CONV.notes}>{item.notes}</p>}
          </>,
        });
      }
      case "steer":
        return message({
          key: item.id, who: "you", name: nameOf(owner), ts: item.ts,
          tag: <em className={cn(CONV.tag,
            item.delivered ? CONV.tagTone.ok : CONV.tagTone.att)}>
            {item.delivered ? "已读取" : "已接收 · 待读取"}
          </em>,
          children: <p className={CONV.answer}>{item.text}</p>,
        });
      case "review":
        // 新交办结合当前工作处理；旧事件保留当时的整体回退事实。
        return message({
          key: item.id, who: isViewer ? "person" : "you",
          name: isViewer ? (owner || "归属人") : "你", ts: item.ts,
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>{item.delivery_mode === "incremental" ? "批量交办" : "整体打回"}</em>,
          children: <>
            <p className={CONV.lead}>提交了 {item.count} 条检视意见给 Agent</p>
            {item.receipt && <p className={CONV.notes}>{item.receipt}</p>}
            <p className={CONV.answer}>{item.text}</p>
          </>,
        });
      case "receipts":
        // 平台工具回执(拉仓/推分支/建 MR/申报…)聚成一组留痕,不刷屏。
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>平台回执 · {item.items.length} 项</em>,
          children: <ul className={CONV.receipts}>
            {item.items.map((entry, index) => (
              <li key={index} className={CONV.receipt}>
                <i aria-hidden
                  className={cn(CONV.receiptIcon,
                    entry.outcome === "success" ? "bg-success" : "bg-danger")}>
                  {entry.outcome === "success" ? "✓" : "✕"}
                </i>
                <div className={CONV.receiptBody}>
                  <b className={CONV.receiptName}>{entry.name}</b>
                  {entry.summary && <small className={CONV.receiptNote}>{entry.summary}</small>}
                </div>
              </li>
            ))}
          </ul>,
        });
      default:
        return null;
    }
  }

  const rows: ReactNode[] = [];
  let lastDate = "";
  for (const item of shown) {
    const date = formatLocalDate(item.ts);
    if (date && date !== lastDate) {
      rows.push(<div className={CONV.date} key={`date-${date}-${item.id}`}>{date}</div>);
      lastDate = date;
    }
    rows.push(render(item));
  }

  // 环境验证卡的等待语义不同(ADR-0034:通过无需作答,合入即通过),
  // 状态签换成「待验证」——其余卡照旧「等你决定/等归属人决定」。
  const nowTag = !canOperate
    ? (waitingKind === "env_verify" ? "待责任人验证" : "等归属人决定")
    : (waitingKind === "env_verify" ? "待验证" : "等你决定");

  return <>
    <div className="ws-stream-shell">
      <header className="ws-collaboration-head">
        <strong>与 Agent 协作</strong>
        {/* 流内筛选(任务侧同款 UI):阅读筛选,不是权限判断。
            (#210)手搓 role=tablist 换 base-ui Tabs 原语,键盘箭头归原语;
            旧 .ws-stream-filters 皮肤类挂在 TabsList 上,视觉原样。 */}
        <Tabs value={filter} className="contents"
          onValueChange={(value) => setFilter(value as "all" | "mine")}>
          <TabsList variant="line" aria-label="会话流筛选" className="ws-stream-filters h-auto">
            {([["all", "全部"], ["mine", "需要我的"]] as const)
              .map(([key, label]) => (
                <TabsTrigger key={key} value={key}
                  className={`h-auto flex-none after:hidden${filter === key ? " on" : ""}`}>
                  {label}
                </TabsTrigger>
              ))}
          </TabsList>
        </Tabs>
        {view.truncated && <span>条目过多,只保留最近的;完整现场在左栏「对话现场」</span>}
      </header>
      <div className="ws-stream" role="log" aria-live="polite" aria-relevant="additions"
        ref={box}
        onScroll={(event) => {
          pinned.current = atBottom(event.currentTarget);
          if (pinned.current) setHasNew(false);
        }}>
        {hidden > 0 && (
          <button type="button" className={CONV.more}
            onClick={() => setLimit((value) => value + INITIAL_LIMIT)}>
            显示更早的 {hidden} 条
          </button>
        )}
        {view.unavailable && <div className={CONV.problem} role="status">{view.unavailable}</div>}
        {!view.loaded && !view.unavailable && (
          <div className={CONV.empty}>正在读取协作记录…</div>
        )}
        {view.loaded && !shown.length && !currentCard && (
          <Empty className="py-6" role="status">
            <EmptyDescription>还没有协作记录。Agent 开始干活、举卡,或你插话、续聊之后,会按时间出现在这里。</EmptyDescription>
          </Empty>
        )}
        {rows}
        {/* 卡座(#125):当前等待卡永远钉在流末尾的 Agent 气泡内,举卡
            之后人再插话/裁决/回执它都不挪窝;流内同卡投影已按 waiting_id
            去重。查看模式钉的是只读事实卡,同样不出 dock。 */}
        {pinnedCard && message({
          key: `card-${waitingId ?? "current"}`, who: "agent", name: "Agent",
          ts: projectedCurrent?.ts ?? waitingTs ?? new Date().toISOString(),
          tag: <em className={cn(CONV.tag, CONV.tagTone.att)}>{nowTag}</em>,
          children: <div className={cn(CONV.card, "border-line-strong")}>{currentCard}</div>,
        })}
      </div>
      {hasNew && (
        <button type="button" className="ws-stream-new" onClick={scrollToEnd}>有新消息 ↓</button>
      )}
    </div>
    <IssueCollaborationComposer
      key={issueId}
      status={status}
      waiting={waiting}
      waitingKind={waitingKind}
      canOperate={canOperate}
      busy={busy}
      owner={owner}
      takeover={takeover}
      dock={waiting && canOperate}
      dockRef={dockRef}
      onSteer={onSteer}
      onReply={onReply}
      onTakeover={onTakeover}
      onTakeoverNote={onTakeoverNote}
      onResumeTakeover={onResumeTakeover}
      onSent={() => load(issueId)}
    />
  </>;
}

/** 输入区(轻量仿制任务侧 ws-composer,类名同套):运行中=插话、空闲=
 * 续聊;人工接管中=人工驾驶(记录到现场/交还给 AI 两钮,2026-09-07
 * 走查拍板);等卡时让位给卡座 dock(卡的提交区经 portal 挂进
 * ws-reply-dock,附言与提交按钮就在输入区完成),未启动/终态给
 * 原因,查看者只读。发送走 SessionView 传入的 steerIssue/replyIssue
 * 通道,成功后立刻拉一次流让发言上屏。 */
function IssueCollaborationComposer({
  status,
  waiting,
  waitingKind,
  canOperate,
  busy,
  owner,
  takeover,
  dock,
  dockRef,
  onSteer,
  onReply,
  onTakeover,
  onTakeoverNote,
  onResumeTakeover,
  onSent,
}: {
  status: IssueStatus;
  waiting: boolean;
  /** 当前卡的种类:环境验证卡等的是验证不是答复,blocked 提示随它换。 */
  waitingKind?: IssueGateKind;
  canOperate: boolean;
  busy: boolean;
  owner: string;
  /** 人工接管中:真=人工驾驶模式(分派优先级在插话/续聊之前)。 */
  takeover: boolean;
  /** 卡座 dock 位(#125):归属人答卡时为真——输入区预留 ws-reply-dock
   * 容器,当前卡的提交区经 portal 挂进来;查看者/无卡时为假。 */
  dock: boolean;
  /** dock 容器节点回调(会话视图转交卡座,见本文件头部的模式说明)。 */
  dockRef?: (node: HTMLDivElement | null) => void;
  onSteer: (text: string) => Promise<boolean>;
  onReply: (text: string) => Promise<boolean>;
  /** 人工接管(打断 AI)/交还(AI 带记录继续):经 perform 包装,
   * 成功即有新详情回来,徽标与输入区模式随之翻转。 */
  onTakeover: () => Promise<boolean>;
  /** 人工操作记录:不走 perform(免吞错),失败原样抛到输入区报错。 */
  onTakeoverNote: (text: string) => Promise<void>;
  onResumeTakeover: (note?: string) => Promise<boolean>;
  /** 发送成功后立即刷新协作流(不等下一拍轮询)。 */
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  // 截图粘贴(2026-09-10):插话/续聊/接管记录都支持,引用随消息提升
  // 进工作区,AI 用 inspect_image 识图。
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const imagePaste = useIssueImagePaste(setError);

  type Mode =
    | { kind: "readonly" }
    | { kind: "blocked"; title: string; hint: string }
    | { kind: "takeover" }
    | { kind: "steer" }
    | { kind: "reply" };
  const ended = ["archived", "canceled", "failed"].includes(status);
  const mode: Mode = !canOperate ? { kind: "readonly" }
    : waiting || status === "waiting_user" ? {
        kind: "blocked",
        // 环境验证卡:等的是验证,不是作答(通过无需作答,合入即通过)。
        ...(waitingKind === "env_verify"
          ? {
            title: "待验证",
            hint: "验证卡在上方流末尾:没发现问题无需作答,MR 全部合入后本单自动归档;发现问题在卡上描述并提交。",
          }
          : {
            title: "等你作答",
            hint: "卡在上方流末尾;补充说明与提交按钮就在下方,作答后一并交给 AI。",
          }),
      }
    : status === "queued" ? {
        kind: "blocked", title: "会话还没启动",
        hint: "Agent 启动后就能在这里插话或续聊。",
      }
    : ended ? {
        kind: "blocked", title: "会话已结束",
        hint: "协作记录只读回放;结论与账单见左侧。",
      }
    // 人工驾驶(2026-09-07 走查拍板):接管在场即换模式,优先级压过
    // 插话/续聊;但让位给终局/等卡——收了口的会话不再给驾驶舱。
    : takeover === true ? { kind: "takeover" }
    : status === "running" ? { kind: "steer" }
    : { kind: "reply" };

  if (mode.kind === "readonly") {
    return <section className="ws-composer-readonly" aria-label="回复与提交(只读)">
      查看模式:协作记录完整可见;插话与续聊由归属人 {owner} 处理。
    </section>;
  }

  // 人工驾驶模式(2026-09-07 走查拍板):AI 已暂停,输入区只剩两件事
  // ——把人工操作记进现场账(可连续记多条),或连记录带说明一并交还
  // 给 AI。记录失败不吞错、不丢稿;交还成功后详情轮询带回新状态,
  // 输入区自动回到插话/续聊。
  if (mode.kind === "takeover") {
    async function recordNote() {
      const body = text.trim();
      if (!body || sending || busy) return;
      setSending(true);
      setError("");
      try {
        await onTakeoverNote(body);
        setText("");
        setSent(true);
        onSent();
      } catch (reason) {
        setError(String(reason instanceof Error ? reason.message : reason));
      } finally {
        setSending(false);
      }
    }
    async function handBack() {
      if (sending || busy) return;
      setSending(true);
      setError("");
      try {
        // 当前输入整段作交还说明(空=不带说明);perform 吞错回 false:
        // 失败保字,让用户重试不丢稿。
        const ok = await onResumeTakeover(text.trim() || undefined);
        if (ok) {
          setText("");
          onSent();
        } else {
          setError("交还未成功,请稍后重试");
        }
      } finally {
        setSending(false);
      }
    }
    return <section
      className="ws-composer takeover [border-top-color:color-mix(in_srgb,var(--merge)_40%,var(--line))]"
      aria-label="人工驾驶记录与交还">
      <div className="ws-composer-ctx">
        <span className={`ws-composer-mode ${busy ? "quiet" : "active"}`}>
          人工驾驶中——AI 已暂停
        </span>
        <span className="ws-composer-hint">
          记录到现场的每一条,交还时都会交给 AI
        </span>
      </div>
      <Textarea className="min-h-13 resize-y bg-surface" value={text} rows={3}
        ref={textRef}
        onPaste={(event) => imagePaste.onPaste(event, (markdown) => {
          const { next, caret } = insertMarkdownAtCursor(textRef.current, text, markdown);
          setText(next);
          window.requestAnimationFrame(() => {
            textRef.current?.focus();
            textRef.current?.setSelectionRange(caret, caret);
          });
        })}
        disabled={sending || busy}
        placeholder="记录你的人工操作,交还时 AI 会看到这些记录"
        onChange={(event) => { setText(event.target.value); if (sent) setSent(false); }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void recordNote();
          }
        }} />
      <div className="ws-composer-row">
        <div className="ws-composer-left">
          <span className="steer-hint">
            {sent && !text ? "已记录到现场" : "⌘/Ctrl + Enter 记录"}
          </span>
        </div>
        {/* #231 换装:接管双钮原 .issue-takeover-actions 手搓皮退役——
            「记录到现场」次档描边钮、「交还给 AI 继续」主档实心钮。 */}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm"
            disabled={sending || busy || !text.trim()}
            onClick={() => void recordNote()}>
            {sending ? "处理中…" : "记录到现场"}
          </Button>
          <Button type="button" size="sm"
            disabled={sending || busy}
            title="把当前输入作交还说明,连同接管期记录一并交给 AI"
            onClick={() => void handBack()}>
            交还给 AI 继续
          </Button>
        </div>
      </div>
      {error && <Alert variant="destructive" role="alert" className="mb-3">{error}</Alert>}
    </section>;
  }

  if (mode.kind === "blocked") {
    return <section className="ws-composer" aria-label="回复与提交">
      <div className="ws-composer-ctx">
        <span className="ws-composer-mode">{mode.title}</span>
        <span className="ws-composer-hint">{mode.hint}</span>
      </div>
      {/* 卡座 dock 位(#125):当前等待卡的提交区(附言+提交/拒绝按钮)
          经 portal 挂在这里。只在归属人答卡时预留;无卡(未启动/
          终态)不出容器——输入区保持纯状态说明,不出现空 dock。 */}
      {dock && <div className="ws-reply-dock" ref={dockRef} role="region"
        aria-label="决定的附言与提交" />}
    </section>;
  }

  const steer = mode.kind === "steer";
  async function send() {
    const body = text.trim();
    if (!body || sending || busy) return;
    setSending(true);
    setError("");
    try {
      // perform 通道吞错返回 false:失败保字,让用户重试不丢稿。
      const ok = steer ? await onSteer(body) : await onReply(body);
      if (ok) {
        setText("");
        setSent(true);
        onSent();
      } else {
        setError("发送未成功,请稍后重试");
      }
    } finally {
      setSending(false);
    }
  }

  return <section className="ws-composer" aria-label="回复与提交">
    <div className="ws-composer-ctx">
      <span className={`ws-composer-mode ${busy ? "quiet" : "active"}`}>
        {steer ? "说给 Agent · 插话" : "说给 Agent · 续聊"}
      </span>
      <span className="ws-composer-hint">
        {steer ? "现在就能交办；当前工具结束后读取，结合正在做的工作处理"
          : "会话空闲中,补充信息或调整方向后 AI 会接着推进"}
      </span>
      {/* 人工接管入口(2026-09-07 走查拍板):运行/空闲都可发起——打断
          AI、现场交由人工;接管后输入区换人工驾驶模式(记录/交还)。 */}
      {!busy && <Button type="button" variant="outline" size="sm"
        className="ml-auto rounded-full"
        title="打断 AI,现场交由人工操作;交还时 AI 会带着人工记录继续"
        onClick={() => void onTakeover().catch(() => undefined)}>
        接管现场
      </Button>}
    </div>
    <Textarea className="min-h-13 resize-y bg-surface" value={text} rows={3}
      ref={textRef}
      onPaste={(event) => imagePaste.onPaste(event, (markdown) => {
        const { next, caret } = insertMarkdownAtCursor(textRef.current, text, markdown);
        setText(next);
        window.requestAnimationFrame(() => {
          textRef.current?.focus();
          textRef.current?.setSelectionRange(caret, caret);
        });
      })}
      disabled={sending || busy}
      placeholder={steer
        ? "例如:日志先只拉网管侧,先别动库…"
        : "继续对话:补充信息、调整方向,或让 AI 继续…"}
      onChange={(event) => { setText(event.target.value); if (sent) setSent(false); }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void send();
        }
      }} />
    <div className="ws-composer-row">
      <div className="ws-composer-left">
        <span className="steer-hint">
          {sent && !text ? "已送到,发言出现在上面的流里" : "⌘/Ctrl + Enter 发送"}
        </span>
      </div>
      <button type="button" className="steer-send"
        disabled={sending || busy || !text.trim()}
        onClick={() => void send()}>
        {sending ? "发送中…" : steer ? "发送插话" : "发送"}
      </button>
    </div>
    {error && <Alert variant="destructive" role="alert" className="mb-3">{error}</Alert>}
  </section>;
}
import { insertMarkdownAtCursor, useIssueImagePaste } from "./useIssueImagePaste";
