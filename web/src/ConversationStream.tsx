import { TaskAttachmentMessage } from "./TaskAttachmentMessage";
import { feedbackStatusLabel, feedbackSummary } from "./feedbackPresentation";
import { DeliveryFileList } from "./DeliveryFileList";
/**
 * 会话流:右栏只回答"谁对谁说了什么、现在轮到谁"。
 *
 * 边界(2026-09-05 用户拍板):流里只有回合——Agent 说的话、举的卡、人的决定、
 * 插话、批注与回执、外部检视意见、会话起止;工具步骤折成回合下的一行
 * 计数,点开去「工作过程」看正本。定位靠 id 双向跳,不靠搜:批注抽屉
 * 里的一条意见 → 这里只看它的往来(线程视图);这里的一条意见 → 左侧
 * 材料原位 / 抽屉那条卡。
 *
 * 所有事实来自 /conversation 投影:这里不推断状态,只排版。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ClampedText } from "./ClampedText";
import { Markdown } from "./markdown";
import { atBottom } from "./follow";
import { displayPersonName } from "./AnnotationPanel";
import { formatLocalClock, formatLocalDate, formatLocalDateTime } from "./time";
import {
  TASK_REQUIREMENT_ARTIFACT,
  type Annotation,
  type ConversationItem,
  type ConversationSteps,
  type DeveloperAssistantToolRun,
  type FeedbackSource,
  type TaskSummary,
} from "./api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyDescription } from "@/components/Empty";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "cn";

export type StreamFilter = "all" | "mine";

/** 本页气泡词典(#232 换装):会话流气泡原白拿 conversation.css 的
 * conv-* 皮,改本页令牌工具类直译——同尺寸同色板,明暗自适应。与
 * 问题侧 #231 的 CONV 词典各自独立不合并:问题域只有六类成员,本侧
 * 多出线程视图/批注引用/回执/外部意见/跨仓通知/助手终端等整组条目,
 * 共享词典会是错位抽象;两侧真正共用的是 ClampedText(照旧走
 * conversation.css 的 conv-text 族)。conv-* CSS 只留三块:conv-text
 * 族(ClampedText 两域共用)、conv-card.current 停靠段(等待卡收进
 * 气泡的机构样式,类名被 conversationStream 契约钉住)、以及 ws-* 壳
 * (两域共用的栏架,不在本票范围)。 */
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
    src: "bg-active-soft text-active",
  } as const,
  earlier: "border-l-2 border-line pl-2.5",
  earlierSummary: "cursor-pointer text-xs text-muted-foreground",
  earlierSummaryFaint: "cursor-pointer text-xs text-faint",
  earlierText: "mt-2 text-sm text-muted-foreground [&_.md>*:first-child]:mt-0 [overflow-wrap:anywhere]",
  act: "block w-full cursor-pointer truncate text-left text-xs text-muted-foreground hover:text-ink",
  actArrow: "mr-1.5 text-faint",
  lead: "m-0 text-sm text-text",
  answer: "m-0 whitespace-pre-wrap text-base text-text [overflow-wrap:anywhere]",
  notes: "m-0 whitespace-pre-wrap text-sm text-muted-foreground",
  questionEcho: "m-0 text-sm text-muted-foreground",
  refs: "flex flex-wrap gap-1.5",
  refChip: "rounded-full border border-line px-2 py-px text-[11px] font-semibold text-muted-foreground",
  cli: "whitespace-pre-wrap rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-xs leading-relaxed text-text [overflow-wrap:anywhere]",
  quote: "grid w-full cursor-pointer gap-0.5 border-l-[3px] border-line-strong px-2.5 py-1 text-left text-sm leading-normal text-muted-foreground hover:border-ink hover:text-text",
  quoteCode: "font-mono text-[11px] font-medium text-faint",
  quoteNote: "[-webkit-box-orient:vertical] [-webkit-line-clamp:3] [display:-webkit-box] overflow-hidden",
  threadLink: "cursor-pointer justify-self-start text-xs text-ink hover:underline",
  receipts: "m-0 grid list-none gap-2 p-0",
  receipt: "grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2",
  receiptIcon: "mt-[3px] grid size-4 place-items-center rounded-full text-[10px] not-italic text-white",
  receiptBody: "grid min-w-0 gap-0.5",
  receiptTitle: "cursor-pointer justify-self-start text-left text-sm leading-normal text-text hover:text-ink",
  receiptNote: "text-xs leading-normal text-muted-foreground",
  receiptCode: "font-mono text-[11px]",
  external: "m-0 grid list-none gap-1.5 p-0",
  externalRow: "flex flex-wrap items-baseline gap-1.5 border-l-[3px] border-line-strong pl-2.5 text-sm text-text",
  externalCode: "font-mono text-[11px] font-medium text-faint",
  externalNote: "flex-basis-full text-xs text-muted-foreground",
  date: "-mb-1 mt-1 flex items-center gap-2.5 text-[11px] text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line",
  more: "cursor-pointer rounded-md border border-dashed border-line-strong bg-transparent px-2.5 py-2 text-xs text-muted-foreground hover:border-text-strong hover:text-text-strong",
  problem: "rounded-md bg-attention-soft px-2.5 py-2 text-left text-xs text-attention",
  empty: "px-3 py-6 text-center text-xs text-muted-foreground",
  digest: "m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-sm leading-[1.55] text-text",
  digestNote: "text-xs text-attention",
  card: "overflow-hidden rounded-lg border",
  cardHead: "border-b border-line px-3.5 pb-2 pt-2.5",
  cardTitle: "mt-0.5 text-base font-semibold leading-snug text-text-strong",
  question: "px-3.5 pb-1 pt-2",
  questionText: "m-0 mb-1.5 text-sm text-text",
  options: "m-0 mb-1.5 grid list-none gap-1.5 p-0",
  option: "rounded-md border border-line px-2.5 py-1.5 text-sm text-muted-foreground",
  optionChosen: "border-ink bg-(--ink-soft) font-semibold text-ink after:ml-1 after:content-['✓']",
  cardFoot: "flex items-center gap-2 border-t border-line px-3.5 pb-2.5 pt-1.5 text-xs text-muted-foreground",
  cardFootAct: "cursor-pointer text-xs text-ink",
  sync: "grid gap-1",
  syncText: "m-0 whitespace-pre-wrap text-sm leading-normal text-text [overflow-wrap:anywhere]",
  syncNote: "text-xs leading-normal text-muted-foreground",
  tools: "rounded-md border border-dashed border-line-strong px-2.5 py-1.5",
  toolsSummary: "cursor-pointer text-xs text-muted-foreground",
  tool: "mt-1.5 grid grid-cols-[8px_auto_auto] items-center gap-1.5 text-xs text-muted-foreground",
  toolPre: "col-span-full m-0 max-h-24 overflow-auto rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[11px] leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]",
  tail: "grid gap-2.5",
} as const;

/** 流内卡的状态皮:等待中的卡描强线,历史卡(已决定/作废)收灰。 */
const convCardClass = (waiting: boolean) =>
  cn(CONV.card, waiting ? "border-line-strong" : "border-line");

/** 卡头词签:等待卡用琥珀,历史卡收灰。 */
const convKickerClass = (muted: boolean) =>
  muted ? "block text-xs font-medium text-faint" : "block text-xs font-medium text-attention";

/** 回执点的结果色(原 .conv-receipts > li.outcome-* 色板直译)。 */
const receiptIconTone = (outcome: string) =>
  outcome === "fixed" ? "bg-success"
    : outcome === "not_fixed" ? "bg-danger"
    : outcome === "needs_clarification" ? "bg-attention" : "bg-faint";

/** 发言人头像底色(#220 从 .conv-avatar CSS 迁为令牌工具类):
 * 默认 Agent=ink,你=text-strong,人=灰,系统=虚线透明,外部=active,
 * 助手=success;文字色/字号随 AvatarFallback 传参覆盖。 */
const CONV_AVATAR_TONE = {
  agent: "bg-(--ink)",
  you: "bg-(--text-strong)",
  person: "bg-(--muted)",
  system: "border border-dashed border-(--line-strong) bg-transparent text-(--faint)",
  external: "bg-(--active)",
  assistant: "bg-(--success)",
} as const;

/** 一屏先渲最近这些条;更早的按需展开(run7 真现场主会话 145 段话)。 */
const INITIAL_LIMIT = 50;


const SOURCE_LABEL: Record<FeedbackSource, string> = {
  workspace: "工作台批注",
  build_fix: "Build-Fix",
  pipeline: "流水线",
  mr_discussion: "CodeHub 检视",
  conflict: "合并冲突",
  scope: "越界改动",
  push_confirmation: "推送确认",
};

const OUTCOME_LABEL: Record<string, string> = {
  fixed: "已处理", not_fixed: "未处理", needs_clarification: "需要补充信息",
};

/** 一条流条目牵涉到哪些批注(线程视图与双向跳转都靠它)。 */
export function itemAnnotationIds(item: ConversationItem): string[] {
  switch (item.kind) {
    case "card":
    case "decision":
      return item.annotation_ids;
    case "annotations_sent":
    case "receipts":
      return item.items.map((entry) => entry.id);
    case "owner_reply":
    case "clarified":
    case "withdrawal_requested":
    case "verified":
    case "reopened":
    case "delivery_reset":
    case "revised":
      return [item.annotation.id];
    default:
      return [];
  }
}

/** "需要我的" = 此刻还等我动手的事,不是"跟我有关的历史"。原来把所有卡、决定、
 * 插话、我提过的意见全算进来,点开和「全部」几乎没区别(用户 2026-09-06 实锤,
 * fixture 里只少了会话开始和一段过程话)。现在只剩三类:还开着的卡;我提的意见
 * 收到了当前版本的回执、而那条意见还没闭环(要我确认修好 / 退回 / 补充说明);
 * 收到的上下游通知。这是阅读筛选,不是权限判断——能不能答卡由决定卡自己说。 */
function concernsViewer(
  item: ConversationItem,
  viewer: string,
  settled: ReadonlySet<string>,
  owner?: string,
): boolean {
  switch (item.kind) {
    case "card":
      return item.status === "waiting";
    case "sync":
      return item.direction === "received";
    case "receipts":
      return item.items.some((entry) => entry.current && (owner ?? entry.author) === viewer
        && !settled.has(entry.id));
    default:
      return false;
  }
}

export function visibleConversationItems(
  items: readonly ConversationItem[],
  options: {
    filter: StreamFilter; thread?: string; viewer: string;
    /** 已闭环(确认通过 / 删除)的意见 id:它们的回执不再需要我。 */
    settled?: ReadonlySet<string>;
    owner?: string;
  },
): ConversationItem[] {
  if (options.thread) {
    const thread = options.thread;
    return items.filter((item) => itemAnnotationIds(item).includes(thread));
  }
  if (options.filter === "mine") {
    const settled = options.settled ?? new Set<string>();
    return items.filter((item) => concernsViewer(item, options.viewer, settled, options.owner));
  }
  return [...items];
}

/** 卡的标题按卡类型说话,与 WaitingCard 的口径一致;认不出的类型用第一问。 */
export function conversationCardTitle(
  item: Extract<ConversationItem, { kind: "card" }>,
): string {
  if (item.purpose === "clarification") return "需要补充信息";
  if (item.step === "cloud_requirement_analysis_confirm") return "确认需求";
  if (item.step === "cloud_push_confirm") return "最终检视：确认这版代码可直接推送";
  if (item.step === "cloud_mr_description") return "填写 AR 描述，用于 MR 标题";
  return item.questions[0]?.question || "需要你的决策";
}

function shortPath(path: string): string {
  if (path === TASK_REQUIREMENT_ARTIFACT) return "需求原文";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

/** "等你 22 小时"——relativeTime 带"前",接在"等你"后面会读成"等你 22 小时前"。 */
function waitedFor(since: string | undefined, now = Date.now()): string {
  const then = since ? new Date(since).getTime() : NaN;
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "刚刚举卡";
  if (minutes < 60) return `等你 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `等你 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `等你 ${Math.floor(hours / 24)} 天`;
}

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]!.toUpperCase() : "?";
}

function stepsLine(steps: ConversationSteps): string {
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

/** 长话按渲染高度折叠——组件本体抽到 ClampedText.tsx,问题侧协作流
 * 同用一份(2026-09-08 对齐拍板),这里只 import。 */

/** 举卡前那段话就是卡的"决策背景",两处同一段字只留卡里那份。投影把话
 * 裁到 1600 字,比较按较短的一方对齐。 */
function sameSpeech(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, " ").trim().replace(/…$/, "");
  const b = right.replace(/\s+/g, " ").trim();
  if (!a || !b) return false;
  const span = Math.min(a.length, b.length, 1500);
  return span >= 24 && a.slice(0, span) === b.slice(0, span);
}

export function ConversationStream({
  task,
  items,
  problems,
  loaded,
  unavailable,
  viewerUsername,
  people,
  filter,
  onFilterChange,
  thread,
  onThreadChange,
  annotations,
  decides,
  awaitingYou,
  fallbackHeadline,
  fallbackDetail,
  currentCard,
  tail,
  assistantTools,
  takeover,
  statusText,
  actor,
  onLocateAnnotation,
  onOpenReview,
  onOpenSteps,
  highlightId,
  highlightCaption,
  highlightCardId,
  highlightFocusKey,
}: {
  task: TaskSummary;
  items: readonly ConversationItem[];
  problems: readonly string[];
  loaded: boolean;
  unavailable?: string;
  viewerUsername: string;
  people: readonly { username: string; display_name?: string }[];
  filter: StreamFilter;
  onFilterChange: (filter: StreamFilter) => void;
  /** 线程视图:只看这条批注的处理记录。 */
  thread?: string;
  onThreadChange: (id?: string) => void;
  annotations: readonly Annotation[];
  /** 当前卡由这位读者答(责任人/协作者/被追问的意见作者)。 */
  decides: boolean;
  /** 等这位读者逐条确认的意见数(服务端 closures 的 mine 档)。 */
  awaitingYou: number;
  fallbackHeadline: string;
  fallbackDetail: string;
  /** 当前决定卡(WaitingCard)或只读说明;渲在流末尾的 Agent 气泡里。 */
  currentCard?: ReactNode;
  /** 非决定态的收口块(失败原因/重跑、验证中、等合入、子任务清单)。 */
  tail?: ReactNode;
  assistantTools?: readonly DeveloperAssistantToolRun[];
  takeover: boolean;
  /** 任务状态的人话(执行中/已暂停…)与责任("由你负责"):并进锚条那一行,
   * 不再单独占一行。 */
  statusText?: string;
  actor?: string;
  onLocateAnnotation: (id: string) => void;
  onOpenReview: (ids: string[]) => void;
  onOpenSteps: () => void;
  /** 只读演示定位，不改变会话内容或真实状态。 */
  highlightId?: string;
  highlightCaption?: string;
  /** 演示中把互动副本放回原确认卡的位置，与当时回复同时定位。 */
  highlightCardId?: string;
  highlightFocusKey?: number;
}) {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [hasNew, setHasNew] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastKey = useRef("");

  useEffect(() => {
    setLimit(INITIAL_LIMIT);
    pinned.current = true;
    setHasNew(false);
  }, [task.id, filter, thread]);

  const settled = useMemo(() => new Set(annotations
    .filter((item) => item.status === "verified" || item.status === "dropped")
    .map((item) => item.id)), [annotations]);
  const visible = useMemo(() => visibleConversationItems(items, {
    filter, thread, viewer: viewerUsername, settled, owner: task.luban_account ?? "本地用户",
  }), [items, filter, thread, viewerUsername, settled, task.luban_account]);
  const decisions = useMemo(() => {
    const map = new Map<string, Extract<ConversationItem, { kind: "decision" }>>();
    for (const item of items) if (item.kind === "decision") map.set(item.waiting_id, item);
    return map;
  }, [items]);
  const waiting = task.status === "waiting_for_human" ? task.waiting : undefined;
  // 普通工作台把当前卡钉在流末尾:它举卡之后人还会提批注、插话,按时间排它会
  // 被埋在这些条目上面,人得往回翻才找得到选项(fixture 实测)。时间线上
  // 它原来的位置不重复渲。线程视图也钉:卡的提交区经 portal 挂在输入框里,
  // 卡不渲输入框就只剩一句"等你在上面点一个选项"——用户 2026-09-05 点了
  // 「看处理记录」后实锤"说给 Agent 栏没了"。
  // 演示例外：互动卡放回被选中的真实卡位置，避免原回复和卡相隔整段历史。
  const inlineDemoCard = !!currentCard && !!highlightCardId
    && visible.some(item => item.kind === "card" && item.id === highlightCardId);
  const pinnedCard = !!waiting && !!currentCard && !inlineDemoCard;
  const chronological = waiting && currentCard
    ? visible.filter((item) => !(item.kind === "card" && item.waiting_id === waiting.waiting_id && item.id !== highlightCardId))
    : visible;
  const highlightedIndex = highlightId ? chronological.findIndex(item => item.id === highlightId) : -1;
  const highlightedCardIndex = highlightCardId ? chronological.findIndex(item => item.id === highlightCardId) : -1;
  const demoFocus = Boolean(highlightId || highlightCardId);
  const hidden = Math.max(0, Math.min(chronological.length - limit,
    highlightedIndex >= 0 ? highlightedIndex : Infinity,
    highlightedCardIndex >= 0 ? highlightedCardIndex : Infinity));
  const shown = hidden ? chronological.slice(hidden) : chronological;

  // 新条目到达:贴底就跟着滚,离开底部就亮"有新消息",不抢人正在读的位置。
  const streamKey = `${shown.at(-1)?.id ?? ""}:${shown.length}:${waiting?.waiting_id ?? ""}`;
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (demoFocus) { pinned.current = false; lastKey.current = streamKey; setHasNew(false); return; }
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
  }, [streamKey, loaded, demoFocus]);

  useLayoutEffect(() => {
    const container = box.current;
    if (!demoFocus || !loaded || !container) return;
    pinned.current = false;
    let active = true;
    let frame = 0;
    const align = () => {
      if (!active) return;
      const target = (highlightId && document.getElementById(`conv-${highlightId}`))
        || (highlightCardId && document.getElementById(`conv-${highlightCardId}`));
      if (target && container.contains(target)) container.scrollTo({ top: container.scrollTop
        + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 14, behavior: "instant" });
    };
    const schedule = () => { align(); window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(align); };
    // Markdown、图片和确认卡异步展开时保持这一轮的位置；用户开始操作后就停止跟随。
    const release = () => { active = false; window.cancelAnimationFrame(frame); };
    const releaseOnKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) release();
    };
    container.addEventListener("wheel", release, { passive: true });
    container.addEventListener("touchstart", release, { passive: true });
    container.addEventListener("pointerdown", release, { passive: true });
    container.addEventListener("keydown", releaseOnKey);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(container);
    for (const child of container.children) observer?.observe(child);
    const mutations = new MutationObserver(schedule);
    mutations.observe(container, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["style", "class", "src"], characterData: true });
    schedule();
    return () => {
      release(); observer?.disconnect(); mutations.disconnect();
      container.removeEventListener("wheel", release);
      container.removeEventListener("touchstart", release);
      container.removeEventListener("pointerdown", release);
      container.removeEventListener("keydown", releaseOnKey);
    };
  }, [task.id, demoFocus, highlightId, highlightCardId, highlightFocusKey, loaded, highlightedIndex, highlightedCardIndex, hidden]);

  function scrollToEnd() {
    const node = box.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    pinned.current = true;
    setHasNew(false);
  }

  const threadAnnotation = thread
    ? annotations.find((item) => item.id === thread) : undefined;
  const nameOf = (username?: string) => !username ? ""
    : username === viewerUsername ? "你" : displayPersonName(username, people);

  /* ---- 待你处理锚条:一句话说清现在轮到谁、点一下就到 ---- */
  const anchor = (() => {
    const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");
    if (waiting && decides) {
      const clarification = waiting.question?.purpose === "clarification";
      return {
        tone: "attention" as const,
        text: clarification ? "Agent 在追问，等你补充信息"
          : "等你决定",
        detail: join(waitedFor(waiting.created_at), actor),
        action: { label: "跳到卡片", onClick: () => {
          const card = highlightCardId && document.getElementById(`conv-${highlightCardId}`);
          if (card && box.current) box.current.scrollTo({ top: box.current.scrollTop
            + card.getBoundingClientRect().top - box.current.getBoundingClientRect().top - 14, behavior: "instant" });
          else scrollToEnd();
        } },
      };
    }
    if (awaitingYou > 0) {
      // #255 去重:不再自带「打开检视意见」。紧随其后的流内意见摘要行
      // 每行已有带批注 id 的定向入口,材料栏还有常驻「检视意见」launcher;
      // 锚条上再放一颗通用入口是三重重复(2026-09-14 审计 P1-2)。
      return {
        tone: "attention" as const,
        text: `${awaitingYou} 条意见待你处理`,
        detail: "查看逐条状态，转交 Agent 或核对答复后闭环",
      };
    }
    if (waiting) {
      return {
        tone: "neutral" as const,
        text: `等待 ${nameOf(task.luban_account) || "责任人"} 决定`,
        detail: "你可以继续在材料上批注，意见会随卡送到 Agent",
      };
    }
    return {
      tone: "neutral" as const,
      text: task.focus?.headline ?? fallbackHeadline,
      detail: join(statusText, actor, task.focus?.next_action ?? fallbackDetail),
    };
  })();

  /* ---- 单条渲染 ---- */
  function annotationChip(entry: { id: string; file: string; line: number; note: string }) {
    return (
      <button type="button" className={CONV.quote} key={entry.id}
        title="回到材料上圈的那一行"
        onClick={() => onLocateAnnotation(entry.id)}>
        <code className={CONV.quoteCode}>{shortPath(entry.file)}:{entry.line}</code>
        <span className={CONV.quoteNote}>{entry.note}</span>
      </button>
    );
  }

  function threadButton(id: string) {
    if (thread === id) return null;
    return (
      <button type="button" className={CONV.threadLink}
        onClick={() => onThreadChange(id)}>看这条的处理记录</button>
    );
  }

  function message(options: {
    key: string; who: "agent" | "you" | "person" | "system" | "external" | "assistant";
    name: string; ts: string; tag?: ReactNode; ids?: string[]; children: ReactNode;
  }) {
    const avatar = options.who === "agent" ? "A"
      : options.who === "assistant" ? "助"
      : options.who === "system" ? "⚙"
      : options.who === "you" ? "你" : initial(options.name);
    return (
      <article className={cn(CONV.msg, (options.key === highlightId || options.key === highlightCardId) && "task-demo-message-highlight",
        options.key === highlightId && options.key !== highlightCardId && "task-demo-reply-highlight")} key={options.key}
        id={`conv-${options.key}`}
        data-annotation-ids={options.ids?.join(" ") || undefined}>
        <Avatar size="sm" aria-hidden className="after:hidden">
          <AvatarFallback className={`rounded-[7px] text-[11px] font-bold text-white ${CONV_AVATAR_TONE[options.who]}`}>{avatar}</AvatarFallback>
        </Avatar>
        <div className={CONV.body}>
          {options.key === highlightId && highlightCaption && <strong className="task-demo-message-tag">{highlightCaption}</strong>}
          <div className={CONV.who}>
            <b className={CONV.whoName}>{options.name}</b>
            {options.tag}
            <time className={CONV.whoTime} dateTime={options.ts} title={formatLocalDateTime(options.ts, { seconds: true, year: true })}>
              {formatLocalClock(options.ts)}
            </time>
          </div>
          {options.children}
        </div>
      </article>
    );
  }

  function render(item: ConversationItem): ReactNode {
    switch (item.kind) {
      case "session":
        return (
          <div className={CONV.date} key={item.id} id={`conv-${item.id}`}>
            {item.phase === "started"
              ? (item.resume ? "会话从断点恢复" : "会话开始")
              : `会话结束${item.reason ? ` · ${item.reason}` : ""}${item.detail ? ` · ${item.detail}` : ""}`}
          </div>
        );
      case "turn": {
        // 交接语摊开(最后一段全文,此前的折叠);过程话默认折成一行;举卡前那段
        // 与当前卡的决策背景重复的不再渲。回合全是过程话时把最后一段当交接语。
        const cardContext = pinnedCard && item.id !== highlightId ? (waiting?.context ?? "") : "";
        const handoffs = item.texts.filter((text) => text.role !== "narration"
          && !(cardContext && sameSpeech(text.text, cardContext)));
        const echoedByCard = item.texts.some((text) => text.role !== "narration"
          && cardContext && sameSpeech(text.text, cardContext));
        const narrations = item.texts.filter((text) => text.role === "narration");
        const spoken = handoffs.length ? handoffs
          : (!echoedByCard && narrations.length ? [narrations[narrations.length - 1]] : []);
        const folded = narrations.filter((text) => !spoken.includes(text));
        const last = spoken.at(-1);
        const earlier = spoken.slice(0, -1);
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
              <button type="button" className={CONV.act} onClick={onOpenSteps}
                title="到「工作过程」看每一步">
                <span aria-hidden className={CONV.actArrow}>▸</span>{stepsLine(item.steps)}
              </button>
            )}
          </>,
        });
      }
      case "card": {
        const isCurrent = !!waiting && waiting.waiting_id === item.waiting_id;
        if (currentCard && ((isCurrent && !pinnedCard) || (inlineDemoCard && item.id === highlightCardId))) {
          return message({
            key: item.id, who: "agent", name: "Agent", ts: item.ts, ids: item.annotation_ids,
            tag: <em className={cn(CONV.tag, CONV.tagTone.att)}>{item.purpose === "clarification" ? "在追问" : "等你决定"}</em>,
            children: <div className="conv-card current">{currentCard}</div>,
          });
        }
        const decision = decisions.get(item.waiting_id);
        const waitingNow = item.status === "waiting";
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts, ids: item.annotation_ids,
          tag: <em className={cn(CONV.tag, waitingNow ? CONV.tagTone.att : CONV.tagTone.neutral)}>
            {waitingNow ? "等待决定" : item.status === "resolved" ? "已决定" : "已作废"}
          </em>,
          children: <div className={convCardClass(waitingNow)}>
            <div className={CONV.cardHead}>
              <span className={convKickerClass(!waitingNow)}>{item.purpose === "clarification" ? "追问" : "请你决定"}</span>
              <h4 className={CONV.cardTitle}>{conversationCardTitle(item)}</h4>
            </div>
            {item.questions.map((question, index) => (
              <div className={CONV.question} key={index}>
                {item.questions.length > 1 && <p className={CONV.questionText}>{question.question}</p>}
                {question.options.length > 0 && (
                  <ul className={CONV.options}>
                    {question.options.map((option) => {
                      const chosen = decision?.answers?.[question.question] === option
                        || (!decision?.answers && decision?.decision.split("\n").includes(option));
                      return <li key={option}
                        className={chosen ? cn(CONV.option, CONV.optionChosen) : CONV.option}>{option}</li>;
                    })}
                  </ul>
                )}
              </div>
            ))}
            {item.annotation_ids.length > 0 && (
              <div className={CONV.cardFoot}>
                针对 {item.annotation_ids.length} 条意见
                <button type="button" className={CONV.cardFootAct}
                  onClick={() => onOpenReview(item.annotation_ids)}>看这些意见</button>
              </div>
            )}
          </div>,
        });
      }
      case "decision": {
        const who = item.by ?? task.luban_account;
        const name = nameOf(who) || "责任人";
        const answers = item.answers ? Object.values(item.answers) : [item.decision];
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person", name, ts: item.ts,
          ids: item.annotation_ids,
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>{item.purpose === "clarification" ? "答复了追问" : "作了决定"}</em>,
          children: <>
            {answers.filter(Boolean).map((answer, index) => (
              <p className={CONV.answer} key={index}>{answer}</p>
            ))}
            {item.notes && <p className={CONV.notes}>{item.notes}</p>}
          </>,
        });
      }
      case "steer":
        return message({
          key: item.id, who: "you", name: "补充给 Agent", ts: item.ts,
          tag: <em className={cn(CONV.tag, item.delivered ? CONV.tagTone.ok : CONV.tagTone.att)}>
            {item.delivered ? "已读取"
              : item.deferred === "decision" ? "随下一次决定送达"
              : item.deferred === "mission" ? "任务启动时送达" : "已接收 · 待读取"}
          </em>,
          children: <>
            <p className={CONV.answer}><TaskAttachmentMessage text={item.text} /></p>
            {!!item.references?.length && (
              <div className={CONV.refs}>{item.references.map((label) => (
                <span className={CONV.refChip} key={label}>@ {label}</span>
              ))}</div>
            )}
          </>,
        });
      case "annotations_sent": {
        const who = item.by ?? item.items[0]?.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "检视人", ts: item.ts, ids: item.items.map((entry) => entry.id),
            children: digest(`提交了 ${item.items.length} 条意见给 Agent`, item.items.map((entry) => entry.id)),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "检视人", ts: item.ts, ids: item.items.map((entry) => entry.id),
          children: <>
            <p className={CONV.lead}>提交了 {item.items.length} 条批注给 Agent</p>
            {item.items.map(annotationChip)}
            {item.items.length === 1 && threadButton(item.items[0].id)}
          </>,
        });
      }
      case "receipts": {
        if (!thread) {
          const current = item.items.filter((entry) => entry.current);
          const stale = item.items.length - current.length;
          const count = (outcome: string) => current.filter((entry) => entry.outcome === outcome).length;
          const parts = [
            count("fixed") ? `${count("fixed")} 条已处理` : "",
            count("not_fixed") ? `${count("not_fixed")} 条没有修改` : "",
            count("needs_clarification") ? `${count("needs_clarification")} 条需要补充说明` : "",
          ].filter(Boolean).join("、");
          return message({
            key: item.id, who: "agent", name: "Agent", ts: item.ts,
            ids: item.items.map((entry) => entry.id),
            children: digest(
              current.length
                ? `回了 ${current.length} 条意见的处理结果：${parts}`
                : `回了 ${item.items.length} 条意见的处理结果`,
              item.items.map((entry) => entry.id),
              stale ? `另 ${stale} 条是旧版本回执，不算数` : undefined),
          });
        }
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          ids: item.items.map((entry) => entry.id),
          children: <>
            <p className={CONV.lead}>{item.items.length} 条意见的处理回执</p>
            <ul className={CONV.receipts}>
              {item.items.map((entry) => (
                <li key={`${entry.id}:${entry.revision}`} className={CONV.receipt}>
                  <i aria-hidden className={cn(CONV.receiptIcon, receiptIconTone(entry.outcome))}>
                    {entry.outcome === "fixed" ? "✓"
                      : entry.outcome === "not_fixed" ? "✕" : "?"}
                  </i>
                  <div className={CONV.receiptBody}>
                    <button type="button" className={CONV.receiptTitle}
                      onClick={() => onLocateAnnotation(entry.id)}>
                      {entry.note}
                    </button>
                    <small className={CONV.receiptNote}>
                      <b className="font-semibold text-text">{OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</b>
                      {entry.summary && <> · {entry.summary}</>}
                      {entry.fixed_sha && <> · <code className={CONV.receiptCode}>{entry.fixed_sha.slice(0, 8)}</code></>}
                    </small>
                    {!entry.current && <em className={cn(CONV.tag, CONV.tagTone.att)}>旧版本回执，不算数</em>}
                    {threadButton(entry.id)}
                  </div>
                </li>
              ))}
            </ul>
          </>,
        });
      }
      case "owner_reply":
        if (!thread) {
          return message({
            key: item.id, who: item.by === viewerUsername ? "you" : "person",
            name: nameOf(item.by) || "责任人", ts: item.ts, ids: [item.annotation.id],
            children: digest("答复了 1 条意见", [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: item.by === viewerUsername ? "you" : "person",
          name: nameOf(item.by) || "责任人", ts: item.ts, ids: [item.annotation.id],
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>答复了意见</em>,
          children: <>
            {annotationChip(item.annotation)}
            <p className={CONV.answer}>{item.text}</p>
            {threadButton(item.annotation.id)}
          </>,
        });
      case "clarified": {
        const who = item.by ?? item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: digest("答复了 Agent 对 1 条意见的追问", [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>答复了追问</em>,
          children: <>
            {annotationChip(item.annotation)}
            {item.question && <p className={CONV.questionEcho}>Agent 问：{item.question}</p>}
            <p className={CONV.answer}>{item.answer}</p>
            {threadButton(item.annotation.id)}
          </>,
        });
      }
      case "withdrawal_requested":
        return message({
          key: item.id, who: item.by === viewerUsername ? "you" : "person",
          name: nameOf(item.by), ts: item.ts, ids: [item.annotation.id],
          children: <><p className={CONV.answer}>申请撤回这条表达，等待责任人逐条处置。</p>{threadButton(item.annotation.id)}</>,
        });
      case "verified": {
        const label = item.resolution ? ({ fixed: "责任人确认已修复", not_adopted: "责任人不采纳",
          deferred: "责任人决定延期", accepted_risk: "责任人接受风险继续" })[item.resolution.outcome] : "确认通过";
        const who = item.by ?? item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: <>{digest(item.resolution ? label : "确认 1 条意见已修好", [item.annotation.id])}{item.resolution?.reason && <p className={CONV.answer}>{item.resolution.reason}</p>}</>,
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className={cn(CONV.tag, CONV.tagTone.ok)}>{label}</em>,
          children: <>{annotationChip(item.annotation)}{item.resolution?.reason && <p className={CONV.answer}>{item.resolution.reason}</p>}{threadButton(item.annotation.id)}</>,
        });
      }
      case "delivery_reset":
        return message({
          key: item.id, who: "external", name: "系统", ts: item.ts, ids: [item.annotation.id],
          tag: <em className={cn(CONV.tag, CONV.tagTone.att)}>处理未完成 · 待重新提交</em>,
          children: <>
            <p className={CONV.answer}>系统已将这条意见恢复为待提交，不计入人工退回次数。</p>
            <p className={CONV.answer}>{item.reason}</p>
            {thread && annotationChip(item.annotation)}
            {threadButton(item.annotation.id)}
          </>,
        });
      case "reopened": {
        const who = item.by ?? item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: digest(`退回 1 条意见，第 ${item.returned} 次要求再改`, [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className={cn(CONV.tag, CONV.tagTone.att)}>退回 · 第 {item.returned} 次</em>,
          children: <>
            {annotationChip(item.annotation)}
            {item.note && <p className={CONV.answer}>{item.note}</p>}
            {threadButton(item.annotation.id)}
          </>,
        });
      }
      case "revised": {
        const who = item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: digest("改写了 1 条意见，等重新提交", [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className={cn(CONV.tag, CONV.tagTone.neutral)}>改了意见，待重新提交</em>,
          children: <>{annotationChip(item.annotation)}{threadButton(item.annotation.id)}</>,
        });
      }
      case "sync":
        // 跨仓通知:收到的按"谁 · 哪个仓"署名,发出的署名"你/某某"并说送到了几个仓
        return message({
          key: item.id, who: "external",
          name: item.direction === "received"
            ? `${nameOf(item.by)}${item.repository ? ` · ${item.repository} 仓` : ""}`
            : nameOf(item.by),
          ts: item.ts,
          tag: <em className={cn(CONV.tag, item.direction === "received" ? CONV.tagTone.att : CONV.tagTone.src)}>
            {item.direction === "received" ? "子任务通知" : "已通知所有子任务"}
          </em>,
          children: <div className={CONV.sync}>
            <p className={CONV.syncText}>{item.text}</p>
            <small className={CONV.syncNote}>{item.direction === "received"
              ? "同一需求的协作通知；Agent 运行或继续时核对影响，无关就继续，有歧义再提问。"
              : item.targets
                ? `已同步主任务和 ${item.targets} 个其他子任务；排队任务启动时读取`
                : "已同步主任务，后续创建的子任务也会收到"}</small>
          </div>,
        });
      case "external": {
        if (!thread) {
          const pipeline = ["pipeline", "build_fix"].includes(item.source);
          const human = pipeline ? item.items.filter(entry => entry.status === "needs_human") : [];
          return message({
            key: item.id, who: "external", name: item.author ?? SOURCE_LABEL[item.source] ?? item.source,
            ts: item.ts,
            tag: <em className={cn(CONV.tag, CONV.tagTone.src)}>{SOURCE_LABEL[item.source] ?? item.source}</em>,
            children: human.length ? <section aria-label="流水线人工处理回执" className="grid min-w-0 gap-3">
              <p className={CONV.lead}>{SOURCE_LABEL[item.source]}有 {human.length} 项需要人工判断</p>
              {human.map(entry => <article key={entry.id} className="grid gap-2 text-sm">
                <p className="m-0 whitespace-pre-wrap break-words">{entry.summary}</p>
                {entry.resolution && <div className="grid gap-1"><strong className="text-xs">Agent 的原因说明与处理建议</strong><p className="m-0 whitespace-pre-wrap break-words">{entry.resolution}</p></div>}
              </article>)}
              <button type="button" className={CONV.act} onClick={() => onOpenReview([])}>查看流水线反馈</button>
            </section> : digest(
              `${item.source === "mr_discussion" ? "提了" : "收到"} ${item.items.length} 条${item.source === "mr_discussion" ? "代码检视意见" : pipeline ? "流水线反馈" : `${SOURCE_LABEL[item.source] ?? "交付"}反馈`}，${feedbackSummary(item.items)}`, []),
          });
        }
        return message({
          key: item.id, who: "external", name: item.author ?? SOURCE_LABEL[item.source] ?? item.source,
          ts: item.ts,
          tag: <em className={cn(CONV.tag, CONV.tagTone.src)}>{SOURCE_LABEL[item.source] ?? item.source}</em>,
          children: <ul className={CONV.external}>
            {item.items.map((entry) => (
              <li className={CONV.externalRow} key={entry.id}>
                {entry.file && <code className={CONV.externalCode}>{shortPath(entry.file)}{entry.line ? `:${entry.line}` : ""}</code>}
                <span>{entry.summary}</span>
                <em className={cn(CONV.tag, entry.status === "closed" ? CONV.tagTone.ok
                  : entry.status === "needs_human" ? CONV.tagTone.att : CONV.tagTone.neutral)}>
                  {feedbackStatusLabel({ source: item.source, status: entry.status })}
                </em>
                {entry.resolution && <small className={CONV.externalNote}>{entry.resolution}</small>}
              </li>
            ))}
          </ul>,
        });
      }
      case "push_file_list":
        return message({
          key: item.id, who: "system", name: "推送前清单", ts: item.ts,
          children: item.manifest.files
            ? <DeliveryFileList files={item.manifest.files} manifest={item.manifest} />
            : <p className={CONV.problem}>{item.manifest.unavailable_reason ?? "本次推送清单暂不可读"}</p>,
        });
      case "assistant":
        return message({
          key: item.id, who: item.role === "user" ? "you" : "assistant",
          name: item.role === "user" ? "你" : "开发助手", ts: item.ts,
          tag: item.role === "user" ? <em className={cn(CONV.tag, CONV.tagTone.neutral)}>接管中</em> : undefined,
          children: <div className={item.role === "user" ? CONV.cli : "conv-text"}>
            {item.role === "user" ? item.text : <Markdown text={item.text} />}
          </div>,
        });
      default:
        return null;
    }
  }

  /** 流里的意见类条目在非线程视图只留一行:详情在左边的「检视意见」抽屉,
   *  两边摊开同样的字是重复(用户 2026-09-06)。线程视图仍逐条完整。 */
  function digest(lead: string, ids: string[], note?: string): ReactNode {
    return (
      <p className={CONV.digest}>
        <span>{lead}</span>
        {note && <small className={CONV.digestNote}>{note}</small>}
        <button type="button" className={CONV.act} onClick={() => onOpenReview(ids)}>打开检视意见</button>
      </p>
    );
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

  const recentTools = takeover ? (assistantTools ?? []).slice(-8) : [];

  return (
    <div className="ws-stream-shell">
      {/* 栏头一行:标题 + 筛选;状态与"轮到谁"并成锚条一行。原来栏头、状态行、
          锚条、筛选四行摞着吃掉 180px,流只剩三百多像素(用户 2026-09-05:"都没
          空间显示文字了")。 */}
      <header className="ws-collaboration-head">
        <strong>与 Agent 协作</strong>
        {/* shadcn 化(#210):页签条交给 base-ui Tabs 原语(键盘左右箭头、
            roving tabindex 归原语);线程视图打开时两签都不算选中,用
            value=null 表达「无选中签」。旧 .ws-stream-filters 皮肤类挂在
            TabsList 上,视觉与切换语义原样。 */}
        <Tabs value={!thread ? filter : null} className="contents"
          onValueChange={(value) => { onThreadChange(undefined); onFilterChange(value as StreamFilter); }}>
          <TabsList variant="line" aria-label="会话流筛选" className="ws-stream-filters h-auto">
            {([["all", "全部"], ["mine", "需要我的"]] as const)
              .map(([key, label]) => (
                <TabsTrigger key={key} value={key}
                  className={`h-auto flex-none after:hidden${!thread && filter === key ? " on" : ""}`}>
                  {label}
                </TabsTrigger>
              ))}
          </TabsList>
        </Tabs>
      </header>
      <div className={`ws-anchor ${anchor.tone}`} role="status">
        <i aria-hidden />
        <span className="ws-anchor-text" title={[anchor.text, anchor.detail].filter(Boolean).join(" · ")}>
          <strong>{anchor.text}</strong>
          {anchor.detail && <small>{anchor.detail}</small>}
        </span>
        {anchor.action && (
          <button type="button" onClick={anchor.action.onClick}>{anchor.action.label}</button>
        )}
      </div>
      {thread && (
        <div className="ws-thread-head" role="note">
          <span>
            只看这条意见的处理记录
            {threadAnnotation && <code>{shortPath(threadAnnotation.file)}:{threadAnnotation.line}</code>}
            {threadAnnotation && <small>{threadAnnotation.note}</small>}
          </span>
          <button type="button" onClick={() => onThreadChange(undefined)} aria-label="关闭线程视图">×</button>
        </div>
      )}
      <div className="ws-stream" role="log" aria-live="polite" aria-relevant="additions"
        ref={box}
        onScroll={(event) => { pinned.current = atBottom(event.currentTarget); if (pinned.current) setHasNew(false); }}>
        {hidden > 0 && (
          <button type="button" className={CONV.more}
            onClick={() => setLimit((value) => value + INITIAL_LIMIT)}>
            显示更早的 {hidden} 条
          </button>
        )}
        {unavailable && <div className={CONV.problem} role="status">{unavailable}</div>}
        {problems.map((problem) => (
          <div className={CONV.problem} role="status" key={problem}>{problem}</div>
        ))}
        {!loaded && !unavailable && <div className={CONV.empty}>正在读取记录…</div>}
        {loaded && !shown.length && !currentCard && (
          <Empty className="py-6" role="status">
            <EmptyDescription>{thread ? "这条意见还没有处理记录。"
              : filter === "mine" ? "现在没有需要你处理的事。"
              : "还没有记录。Agent 开始说话、举卡或你提交批注后，会按时间出现在这里。"}</EmptyDescription>
          </Empty>
        )}
        {rows}
        {pinnedCard && waiting && (
          message({
            key: `card-${waiting.waiting_id}`, who: "agent", name: "Agent",
            ts: waiting.created_at ?? new Date().toISOString(),
            tag: <em className={cn(CONV.tag, CONV.tagTone.att)}>{waiting.question?.purpose === "clarification" ? "在追问" : decides ? "等你决定" : "等待答复"}</em>,
            children: <div className="conv-card current">{currentCard}</div>,
          })
        )}
        {recentTools.length > 0 && (
          <details className={CONV.tools}>
            <summary className={CONV.toolsSummary}>开发助手最近 {recentTools.length} 步</summary>
            {recentTools.map((tool) => (
              <div key={tool.call_id} className={CONV.tool}>
                <i aria-hidden className={cn("size-2 rounded-full",
                  tool.state === "passed" ? "bg-success"
                    : tool.state === "failed" ? "bg-danger" : "bg-faint")} />
                <b className="font-semibold text-text">{tool.name}</b>
                <span>{tool.state === "passed" ? "完成" : tool.state === "failed" ? "失败" : "执行中"}</span>
                {tool.input && <pre className={CONV.toolPre}>{tool.input}</pre>}
              </div>
            ))}
          </details>
        )}
        {tail && !thread && <div className={CONV.tail}>{tail}</div>}
      </div>
      {hasNew && (
        <button type="button" className="ws-stream-new" onClick={scrollToEnd}>有新消息 ↓</button>
      )}
    </div>
  );
}
