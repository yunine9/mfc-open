import { DeliveryReportMenu } from "./DeliveryReportMenu";
import { LatestRead } from "./latestRead";
import type { AnnotationSubmissionView } from "./api";
import { RequirementBusinessModule } from "./RequirementBusinessModule";
import { ReviewBody } from "./ReviewBody";
import { TaskEarlyStart } from "./TaskEarlyStart";
import { feedbackCategory, feedbackStatusLabel, feedbackSummary } from "./feedbackPresentation";
import { pendingReviewAnnotation } from "../../src/reviewDecisionContract";
import { PersonName } from "./People";
import { RefreshMrButton } from "./RefreshMrButton";
import { StoryArchitecture } from "./StoryArchitecture";
import { StoryViewNotice } from "./StoryViewNotice";
import { STORY_VIEWS, storyViewCoverage } from "../../src/storyViewCoverage";
import { moduleStoryLine } from "./moduleStoryLocation";
import { ResizableReviewPane } from "./ResizableReviewPane";
import { OverallStoryTools, OVERALL_STORY_ARTIFACT } from "./OverallStoryTools";
/**
 * 任务工作台:决策发生在哪里,证据就在哪里。
 *
 * 用户实测的摩擦:审批卡问"本地 Spec 确认",spec.md 却只在内核
 * 现场面板(另一套 UI 的 iframe)里能看——读材料要跳出决策上下文。
 * 左侧完整阅读原文、文档、代码与活动；右侧统一承接反馈与决定。
 * 批注原位写、原位看回执；同一记录也出现在协作区，回复入口固定在底部。
 *
 * 内核面板不再暴露给业务用户：它是内核为“人坐在终端旁”生成的
 * 单文件 HTML，工作台自己承接材料、决策与过程观察，避免形成两套入口。
 */

import { useEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { isInvitedReviewParticipant, isReviewTaskEnded } from "../../src/reviewParticipation";
import { Markdown } from "./markdown";
import { isPushConfirmation, queuedDecisionAnnotationIds } from "./decisionSelection";
import { GitDiff } from "./GitDiff";
import { RequirementDiff } from "./RequirementDiff";
import { QuickWishButton } from "./WishQuickCreate";
import { ConversationStream, type StreamFilter } from "./ConversationStream";
import { Composer, takeoverActiveOf } from "./Composer";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/Alert";
import { Empty, EmptyDescription } from "@/components/Empty";
import { TaskWaitingFacts } from "./TaskWaitingFacts";
import { AnnotationExcerpt } from "./AnnotationExcerpt";
import { Annotatable } from "./Annotatable";
import { annotationLocationRow, graphAnnotationLocationKey, resolvedAnnotationRange } from "./annotateTargets";
import { AnnotationPanel, type ReviewFilter } from "./AnnotationPanel";
import { requirementGraphVisible } from "./taskHierarchy";
import { RequirementGraph } from "./RequirementGraph";
import { PrepushBadge } from "./PrepushStatus";
import { StagePlanDialog } from "./StagePlanDialog";
import { TaskDemoFrame } from "./TaskDemoFrame";
import { TaskDemoGuide } from "./TaskDemoGuide";
import { getTaskDemoGuideContent, taskDemoPhaseTitle } from "./taskDemoGuideContent";
import { TASK_DEMO_ANALYSIS_PHASE, TASK_DEMO_BUILD_PHASE, TASK_DEMO_REVIEW_PHASE } from "./taskDemoTypes";
import type { TaskDemoControls } from "./taskDemoTypes";
import { resolveTaskDemoAsset } from "./taskDemoSandbox";
import { OverlayDialog, WarmupBadge, WarmupPanel } from "./WarmupPanel";
import { TaskStatusBadge } from "./StatusBadge";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import { KnowledgeFootprint } from "./KnowledgeFootprint";
import { TaskJourney } from "./TaskJourney";
import { TaskContinueDelivery } from "./TaskContinueDelivery";
import { TaskInspector, type TaskInspectorKind } from "./TaskInspector";
import { taskHealthFacts } from "./taskHealth";
import { relativeTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import {
  EMPTY_REPOSITORY_ASSIGNEE_SELECTION,
  RepositoryAssigneePicker,
  type RepositoryAssigneeSelection,
} from "./RepositoryAssigneePicker";
import { UserPicker } from "./UserPicker";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowUpRightIcon, BarChart3Icon, XIcon } from "lucide-react";
import {
  completeReview,
  controlTask,
  getConversation,
  deleteHistoryTask,
  listAnnotations,
  addAnnotation,
  listArtifactChangeDirectory,
  listArtifacts,
  listCommitters,
  listPeople,
  listTaskReviews,
  putRepositoryAssignees,
  readArtifact,
  readArtifactFileDiff,
  readPushReviewDiff,
  readDiffReview,
  type PushReviewPresentation,
  readRequirementRevision,
  repairStopped,
  requestCommitterReview,
  statusText,
  TASK_REQUIREMENT_ARTIFACT,
  REQUIREMENT_GRAPH_ARTIFACT,
  type AnchorCheck,
  type AnnotationClosure,
  type Annotation,
  type ArtifactMeta,
  type AuthUser,
  type ConversationItem,
  type DeveloperAssistantView,
  type FeedbackRecord,
  type FeedbackSource,
  type ReviewRequest,
  type TaskSummary,
} from "./api";
import {
  isChainReviewWaiting,
  isClarificationWaiting,
  isOwnerOnlyWaiting,
  RetryButton,
  TaskProgress,
  WaitBadge,
  WaitingCard,
} from "./TaskCard";

type WorkspaceView = "focus" | "materials" | "execution" | "knowledge";

/** 右栏宽度:人拖过就记住(浏览器本地),没拖过走样式表的默认档。 */
const SIDE_WIDTH_KEY = "mae-flow:ws-side-w";
const SIDE_WIDTH_MIN = 360;
const DEMO_DELIVERY_REPORT = "task-materials/交付报告.md";
type MaterialView = "source" | "doc" | "chain" | "diff";

const WORKSPACE_VIEW_SHORTCUTS: Partial<Record<string, WorkspaceView>> = {
  Digit1: "focus",
  Digit2: "materials",
  Digit3: "execution",
};
/** 三个视图的中文名:⌥1/2/3 的提示与无障碍标签共用。"当前"是左栏,
 *  "产物/活动"是右侧工作区的两种内容。 */
const WORKSPACE_VIEW_LABELS: Array<[WorkspaceView, string]> = [
  ["focus", "当前"],
  ["materials", "材料"],
  ["execution", "工作过程"],
];
function viewShortcutHint(view: WorkspaceView): string {
  const index = WORKSPACE_VIEW_LABELS.findIndex(([candidate]) => candidate === view);
  return `⌥${index + 1}`;
}

/** 圈注和“把意见送给 Agent”是两种权限；只有停止的任务禁止再记。 */
export function canCreateWorkspaceAnnotation(
  status: TaskSummary["status"],
): boolean {
  return status !== "canceled";
}

/** 批注定位必须能回到虚拟的需求原文，而不是把它误当产出文档。 */
export function materialViewForAnnotation(
  artifact: string,
  artifacts: readonly ArtifactMeta[] = [],
): MaterialView {
  if (artifact === TASK_REQUIREMENT_ARTIFACT) return "source";
  if (artifact === REQUIREMENT_GRAPH_ARTIFACT) return "chain";
  if (artifact === "__workspace_diff__") return "diff";
  return artifacts.find((item) => item.name === artifact)?.kind === "diff"
    ? "diff" : "doc";
}

/** 这是显式的人工作业，不等同于普通 verifying。partial 时 Agent 可以
 * 先修已有证据，但缺失维度仍需要人并行补原文。 */
export function pipelineEvidenceNeedsHuman(task: TaskSummary): boolean {
  const state = task.delivery?.evidence_gap?.state;
  return (state === "waiting_human" || state === "partial")
    && Boolean(task.delivery?.evidence_gap?.missing_dimensions.length);
}

/** 首次进入工作台时，系统点名要求处理的补证材料必须胜过“最近修改”
 * 排序；用户已经主动切到别的有效材料后则不抢回焦点。 */
export function preferredWorkspaceArtifact(
  items: readonly ArtifactMeta[],
  current: string,
  recommendedView: "source" | "doc" | "chain" | "diff" | undefined,
  evidenceGapActive: boolean,
): string {
  if (current && items.some((item) => item.name === current)) return current;
  if (evidenceGapActive) {
    const gap = items.find((item) => item.purpose === "pipeline_evidence_gap");
    if (gap) return gap.name;
  }
  if (recommendedView === "doc") {
    const brief = items.find((item) =>
      item.purpose === "delivery_unit_brief");
    if (brief) return brief.name;
  }
  const preferredKind = recommendedView === "diff" ? "diff" : "doc";
  return items.find((item) => item.kind === preferredKind)?.name
    ?? items[0]?.name ?? "";
}

/** 决定只能携带当前操作者自己尚未送达的草稿；别人的草稿只是其记录。 */
export function decisionAnnotationIds(
  items: readonly Annotation[],
  viewerUsername: string,
): string[] {
  return items.filter((item) => item.status === "draft"
    && item.author === viewerUsername && (item.route ?? "agent") === "agent").map((item) => item.id);
}

/** 当前材料搜索只认正文行，不搜索页签、按钮等界面文案。 */
export function matchingMaterialRowIndexes(
  rows: ReadonlyArray<{ textContent: string | null }>,
  query: string,
): number[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return [];
  const matches: number[] = [];
  rows.forEach((row, index) => {
    if ((row.textContent ?? "").toLocaleLowerCase("zh-CN").includes(needle)) {
      matches.push(index);
    }
  });
  return matches;
}

export interface WorkspaceNextActionCopy {
  title: string;
  detail: string;
}

/** 右栏标题和真正渲染的行动卡共用这一套阶段解释，避免卡片明明要求去
 * 合入，标题却还说“当前无待办”。 */
export function workspaceNextActionCopy(
  task: TaskSummary,
  waiting: boolean,
): WorkspaceNextActionCopy {
  if (waiting) return { title: "当前需要处理", detail: "完成后流程继续" };
  if (task.status === "failed") {
    return { title: "任务已失败", detail: "看原因，决定重跑或接手" };
  }
  if (task.status === "verifying") {
    if (task.delivery?.final_mr) return { title: "正在核对最终 MR", detail: task.detail || "可刷新 MR 状态查看最新结果" };
    return { title: "交付验证中", detail: "流水线与自动修复由系统跟进" };
  }
  if (task.status === "await_merge") {
    if (task.delivery?.final_mr) return task.delivery.final_mr.state === "closed"
      ? { title: "最终 MR 已关闭", detail: "可在任务详情中更换最终 MR" }
      : { title: "等待最终 MR 合入", detail: "在 CodeHub 完成检视与合入" };
    return task.delivery?.mr_state === "已关闭"
      ? { title: "MR 已关闭，需要处理", detail: "查看合入状态并决定后续处理" }
      : { title: "等待检视与合入", detail: "前往 CodeHub 完成最后一步" };
  }
  if (task.status === "coordinating") {
    return { title: "子任务进行中", detail: "剩余子任务完成或取消后，主任务自动收口" };
  }
  return { title: "当前无待办", detail: "无需处理" };
}

/** 问题定位一键采集:任务出事(failed/交付停摆)时把全部可定位事实
 * 现采成一个 markdown 下载。服务端在出事瞬间也会自动留档一份到任务
 * 目录 diagnostics/,这里是给人手动再拿最新现场的口。 */
function DiagnosticsLink({ taskId }: { taskId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function downloadDiagnostics() {
    setState("loading");
    try {
      const response = await fetch(
        `/tasks/${encodeURIComponent(taskId)}/diagnostics`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const matched = disposition.match(/filename="?([^";]+)"?/i);
      const filename = matched?.[1] ?? `${taskId}-diagnostics.md`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <span className="diagnostics-action">
      <Button type="button" variant="outline" size="sm"
        className="w-fit gap-1.5 border-dashed bg-transparent text-muted-foreground"
        disabled={state === "loading"} onClick={downloadDiagnostics}
        title="把任务状态、内核现场、Git/容器事实、会话事件与服务日志汇成一个文件">
        {state === "loading" ? "正在生成诊断包…" : "导出诊断包"}
      </Button>
      {state === "done" && <small role="status">已开始下载</small>}
      {state === "error" && <small role="alert">生成失败，请重试</small>}
    </span>
  );
}

/** await_merge 的右栏行:默认一行状态,点开只展开一句说明 + MR 链接
 * (MFC-039 用户拍板:去掉与右栏标题重复的大卡)。MR 被关闭是需要人
 * 处理的例外,直接展示不折叠。#227 换装:ws-merge-line 皮退役改工具类。 */
function MergeWaitLine({ task, canOperate }: {
  task: TaskSummary;
  canOperate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const finalMr = task.delivery?.final_mr;
  const mrUrl = finalMr?.url ?? task.delivery?.mr_url;
  const mrLink = mrUrl
    ? <a href={mrUrl} target="_blank" rel="noreferrer"
        className="text-ink underline underline-offset-2 hover:text-ink-hover">
        {finalMr ? "打开最终 MR" : "打开合入请求"} ↗
      </a>
    : <em className="not-italic text-faint">平台尚未返回 MR 链接，请稍后刷新。</em>;
  if (finalMr) return <div className="grid gap-1.5 text-sm">
    <strong>{finalMr.state === "closed" ? "最终 MR 已关闭，任务尚未完成" : finalMr.state === "merged" ? "最终 MR 已合入" : "等待最终 MR 合入"}</strong>
    {task.delivery?.stalled && <p className="m-0 text-sm text-danger" role="status">{task.delivery.stalled} · 可刷新 MR 状态。</p>}
    {mrLink}
  </div>;
  if (task.delivery?.mr_state === "已关闭") {
    return (
      <div role="alert"
        className="grid gap-1 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm">
        <strong className="text-danger">MR 已关闭，任务还没有结束</strong>
        <p className="m-0 text-[13px] text-muted-foreground">{task.delivery?.waiting_on
          || "重新打开 MR 后系统自动恢复监听；不再继续可用右上角“取消”。"}
          {mrLink}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-1 text-sm">
      <Button type="button" variant="link"
        className="h-auto w-fit gap-2 px-0 text-left text-text-strong"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-merge" />
        等待合入
        <svg viewBox="0 0 16 16" aria-hidden
          className={cn("size-3.5 text-faint transition-transform", open && "rotate-180")}>
          <path d="m5 6.5 3 3 3-3" /></svg>
      </Button>
      {open && (
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">{task.delivery?.waiting_on
          || "流水线与门禁已通过，请前往 MR 完成检视与合入。"}{mrLink}
          {canOperate && <small className="block">
            不再继续这项任务时，可用右上角“取消”明确停止监听。
          </small>}
        </p>
      )}
    </div>
  );
}

export type PushReviewDiffLoadState =
  | { kind: "idle" | "checking" | "ready" }
  | { kind: "error"; message: string; expired: boolean };

export function normalizePushReviewDiffResult(result: {
  content?: string;
  branch?: string;
  unavailable?: string;
  status?: number;
}): {
  content: string;
  branch: string;
  state: PushReviewDiffLoadState;
} {
  const message = result.unavailable?.trim();
  if (message) {
    return {
      content: "",
      branch: "",
      state: { kind: "error", message, expired: result.status === 404 },
    };
  }
  return {
    content: result.content ?? "",
    branch: result.branch ?? "",
    state: { kind: "ready" },
  };
}

export function defaultWorkspaceView(_task: TaskSummary): WorkspaceView {
  // 状态变化只改「当前」画布里的内容，不再把人自动甩到另一套导航。
  return "focus";
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FEEDBACK_SOURCE_LABEL: Record<FeedbackSource, string> = {
  workspace: "工作台批注",
  mr_discussion: "MR 检视",
  build_fix: "Build-Fix",
  pipeline: "流水线",
  conflict: "合并冲突",
  scope: "负责范围",
  push_confirmation: "推送前复检",
};

/** 意见状态徽标词表(#227 换装:原 .feedback-state.{status} 色板收编为
 * Badge variant;needs_human/awaiting 压在人或检视人手里=warning)。 */
const FEEDBACK_BADGE: Record<FeedbackRecord["status"], ComponentProps<typeof Badge>["variant"]> = {
  open: "warning",
  repairing: "info",
  addressed: "success",
  awaiting_verification: "info",
  closed: "neutral",
  needs_human: "warning",
  deferred: "neutral",
  /* origin/main 新增的两个结束态(feedbackPresentation 同族按 closed 处理) */
  superseded: "neutral",
  superseded_by_merge: "neutral",
};

/** 一份来源的意见列表,竖排、正文原样换行、Agent 的回复单独成块——
 * 和批注卡片同一套版式,放进「检视意见」里不违和。
 * #227 换装:feedback-* 皮肤类退役,改 shadcn Badge/Button + 工具类。 */
export function FeedbackList({ kicker, title, hint, items, mrUrl }: {
  kicker: string;
  title: string;
  hint?: string;
  items: FeedbackRecord[];
  /** CodeHub 意见给一个回到 MR 的入口;讨论级链接平台不给,只到 MR。 */
  mrUrl?: string;
}) {
  return <section className="grid gap-2 rounded-xl border border-line bg-surface p-3" aria-label={title}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-0.5">
        <span className="font-mono text-xs font-bold tracking-wide text-ink">{kicker}</span>
        <strong className="text-[15px] text-text-strong">{title}</strong>
        {hint && <p className="m-0 max-w-[72ch] text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <i className="rounded-full bg-surface-3 px-2 py-0.5 not-italic text-muted-foreground">{items.length} 条</i>
        <em className="rounded-full bg-surface-3 px-2 py-0.5 not-italic text-muted-foreground">{feedbackSummary(items)}</em>
        {mrUrl && <a href={mrUrl} target="_blank" rel="noreferrer"
          className="text-ink underline underline-offset-2 hover:text-ink-hover">打开 MR</a>}
      </div>
    </header>
    <ol className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((item) => <li key={item.id} className="grid gap-1.5 rounded-lg bg-surface-2 p-2.5 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {item.file
            ? <code className="font-mono text-xs text-muted-foreground">{item.file}{item.line !== undefined ? `:${item.line}` : ""}</code>
            : <code className="font-mono text-xs text-faint">未指向具体文件</code>}
          <Badge variant={FEEDBACK_BADGE[item.status]}>{feedbackStatusLabel(item)}</Badge>
        </div>
        <ReviewBody text={item.summary} />
        {item.resolution && <div className="grid gap-1 border-l-2 border-l-line-strong pl-2.5">
          <strong className="text-xs text-text-strong">{item.source === "mr_discussion" ? "Agent 回复" : "处理结果"}</strong>
          <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">{item.resolution}</p>
        </div>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <small className="text-xs text-muted-foreground">
            {FEEDBACK_SOURCE_LABEL[item.source]}
            {item.author && ` · 检视人 ${item.author}`}
            {` · ${relativeTime(item.updated_at) || item.updated_at}`}
          </small>

        </div>

      </li>)}
    </ol>
  </section>;
}

/** 缺陷单等没有「检视意见」弹层的页面用的按来源分节列表(FeedbackPanel)
 *  已随 2026-09-17 退役:唯一使用方问题会话把 MR 检视批注收编成页签、
 *  持续检视面板随流水线显示面撤除恒空,整块退场;FeedbackList 留给
 *  任务侧检视画布的机器门禁告警节。 */

/** 进度只有一个来源:任务 API 的 progress(服务端按内核 flow/phases.json
 * 一份词表给出,没有内核脉冲时也由服务端按状态占位)。前端不再自带任何
 * 阶段名——原来这里有三套(协调中五段、持续检视五段、无内核七段),和内核
 * 看板各说各话,老任务停在哪套显示哪套,点阶段名去内核方案词表里按名字
 * 找也必然落空(2026-09-02 用户实锤)。服务端也没给时只画一个"尚未进入
 * 阶段"的空轨道,绝不自造名字。 */
/** 抽屉快捷键的显示文案:Mac 键帽是 ⌥,其他平台叫 Alt。 */
const REVIEW_SHORTCUT = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌥R" : "Alt+R";

/** 焦点在能打字的地方时不抢快捷键:Mac 上 ⌥R 本来就会打出 ®。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function workspaceProgress(task: TaskSummary): NonNullable<TaskSummary["progress"]> {
  if (task.progress) {
    // 内核进度记录的是自动流程最后停在哪；举卡后人真正面对的当前步骤
    // 已经变成“检视/确认”。工作台大标题继续写“等待权威流水线”会与
    // 旁边的下一步自相矛盾。这里只改只读标题，不动阶段与证据账。
    return task.status === "waiting_for_human"
      ? { ...task.progress,
          step: task.focus?.headline ?? task.waiting?.step ?? "等待你的决定" }
      : task.progress;
  }
  return {
    phases: [],
    current_index: -1,
    current_phase: "尚未进入阶段",
    step: task.focus?.headline ?? statusText(task),
  };
}

export function TaskWorkspace({
  task,
  viewerUsername,
  viewerDisplayName,
  canOverride,
  canOperate,
  canCollaborate,
  canRequestReview,
  reviewAssignment,
  onChanged,
  onClose,
  onOpenTask,
  onExecutionPlanFeedback,
  onOpenFeedbackWall,
  canPresent = false,
  demo,
  demoRevision = 0,
}: {
  task: TaskSummary;
  viewerUsername: string;
  viewerDisplayName?: string;
  /** 兼容旧调用参数；批注闭环权限以服务端当前责任人结论为准。 */
  canOverride: boolean;
  canOperate: boolean;
  /** 主任务责任人或已被逐仓分工邀请的协作者。最终决定仍看 canOperate。 */
  canCollaborate: boolean;
  canRequestReview: boolean;
  reviewAssignment?: ReviewRequest;
  onChanged: () => void;
  onClose: () => void;
  onOpenFeedbackWall?: () => void;
  onOpenTask?: (taskId: string) => void;
  onExecutionPlanFeedback?: (draft: { title: string; detail: string }) => void;
  canPresent?: boolean;
  demo?: TaskDemoControls;
  demoRevision?: number;
}) {
  // 旧任务、纯会话和非内核提问没有 approval_subject 元数据；此时需求
  // 原文是唯一保证存在的证据，不能默认打开一个空的产出文档面板。
  const recommendedMaterialView = task.waiting?.recommended_view
    ?? (task.parent_task_id ? "doc"
      : task.requirement_graph?.stage === "confirmed" ? "chain" : "source");
  // 审批导航与只读浏览分开：没有待办也可从任务历史计算增量范围。
  const approvalReview = (isPushConfirmation(task.waiting)
      || task.waiting?.step === "cloud_push_confirm")
    ? task.delivery?.push_review : undefined;
  const [browsingReview, setBrowsingReview] = useState<{ taskId: string; review?: PushReviewPresentation }>();
  const pushReview = (browsingReview?.taskId === task.id ? browsingReview.review : undefined) ?? approvalReview;
  const [items, setItems] = useState<ArtifactMeta[]>();
  const overallStoryPublished = !task.parent_task_id && !!items?.some(item => item.name === OVERALL_STORY_ARTIFACT && item.story_published);
  const [unavailable, setUnavailable] = useState("");
  const [active, setActive] = useState("");
  const activeRef = useRef(active);
  activeRef.current = active;
  const [materialView, setMaterialView] =
    useState<MaterialView>(recommendedMaterialView);
  const materialViewRef = useRef(materialView);
  materialViewRef.current = materialView;
  const [architectureLine, setArchitectureLine] = useState<number>();
  const [moduleLocation, setModuleLocation] = useState<{ taskId: string; id: string; name: string; request: number }>();
  const [moduleLocationRetry, setModuleLocationRetry] = useState<string>();
  const [content, setContent] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const loadedMaterialKey = useRef("");
  const [selectedDiffPath, setSelectedDiffPath] = useState("");
  const [diffFileLoading, setDiffFileLoading] = useState(false);
  const materialReader = useRef(new LatestRead<Awaited<ReturnType<typeof readPushReviewDiff>>>());
  const artifactReader = useRef(new LatestRead<Awaited<ReturnType<typeof listArtifacts>>>());
  const comparisonReader = useRef(new LatestRead<Awaited<ReturnType<typeof readDiffReview>>>());
  useEffect(() => () => {
    materialReader.current.cancel(); artifactReader.current.cancel(); comparisonReader.current.cancel();
  }, [task.id]);
  const [diffFileError, setDiffFileError] = useState("");
  const [notes, setNotes] = useState<Annotation[]>([]);
  const locationRequest = useRef(0);
  const [materialReload, setMaterialReload] = useState(0);
  const [loadedMaterialReload, setLoadedMaterialReload] = useState(-1);
  const [materialReadError, setMaterialReadError] = useState("");
  const [pendingLocation, setPendingLocation] = useState<{
    request: number; item: Annotation; view: MaterialView;
    artifact?: string; line?: number;
  }>();
  useEffect(() => () => { locationRequest.current++; }, [task.id]);
  const [checks, setChecks] = useState<AnchorCheck[]>([]);
  // 闭环结论由服务端算好(feedbackPolicy 唯一判定处),这里只搬运。
  const [closures, setClosures] = useState<AnnotationClosure[]>([]);
  const [annotationSubmission, setAnnotationSubmission] = useState<AnnotationSubmissionView>();
  const [reply, setReply] =
    useState<{ texts: string[]; truncated: boolean } | undefined>();
  const [notesPulse, setNotesPulse] = useState(0);
  const [livePulse, setLivePulse] = useState(0);
  const [committers, setCommitters] = useState<AuthUser[]>([]);
  const [reviewPeople, setReviewPeople] = useState<Array<{
    username: string; display_name?: string;
  }>>([]);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewResult, setReviewResult] = useState("");
  const [taskReviews, setTaskReviews] = useState<ReviewRequest[]>([]);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState("");
  const [locationExcerpt, setLocationExcerpt] = useState<Annotation>();
  const [locationNotice, setLocationNotice] = useState("");
  const [controlBusy, setControlBusy] =
    useState<"pause" | "resume" | "cancel" | "delete" | "">("");
  const [controlError, setControlError] = useState("");
  const [cancelArmed, setCancelArmed] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [repositoryAssignees, setRepositoryAssignees] =
    useState<RepositoryAssigneeSelection>(EMPTY_REPOSITORY_ASSIGNEE_SELECTION);
  const [repositoryAssigneeSave, setRepositoryAssigneeSave] =
    useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pushDiffState, setPushDiffState] = useState<PushReviewDiffLoadState>(
    pushReview ? { kind: "checking" } : { kind: "idle" },
  );
  const [diffScope, setDiffScope] = useState<"changes" | "full">(
    pushReview?.has_focused_changes ? "changes" : "full");
  // 全部改动始终按文件加载；待确认卡不应退回下载整仓 Diff。
  const scopedDiff = Boolean(pushReview && diffScope === "changes");
  const [diffReviewRequest, setDiffReviewRequest] = useState(0);
  /** 点进度条阶段名弹该阶段执行方案;空串=不显示。 */
  const [planPhase, setPlanPhase] = useState("");
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoDiagram, setDemoDiagram] = useState<"decomposition" | "architecture">("architecture");
  const [demoMessages, setDemoMessages] = useState<Record<string, string>>({});
  const demoPhaseOpened = useRef("");
  const demoHasDecomposition = Boolean(demo && requirementGraphVisible(task));
  const demoAnalysis = demoHasDecomposition && demo?.phase === TASK_DEMO_ANALYSIS_PHASE;
  const demoShowsDecomposition = demoHasDecomposition && demoDiagram === "decomposition";
  const demoPhaseTitle = (phase: string) => demoHasDecomposition && phase === TASK_DEMO_ANALYSIS_PHASE
    ? "需求拆分" : taskDemoPhaseTitle(phase);
  const demoContent = demo ? getTaskDemoGuideContent(demo.phase) : undefined;
  const demoCompleted = demo?.phase === "已合入";
  const demoReviewReport = demo?.phase === TASK_DEMO_REVIEW_PHASE
    ? items?.find(item => item.kind === "doc" && item.name === DEMO_DELIVERY_REPORT) : undefined;
  const demoReportOpen = Boolean(demoReviewReport && materialView === "doc" && active === demoReviewReport.name);
  const deliveryAnalysisQuery = new URLSearchParams({ deliveryAnalysis: "1", deliveryTask: demo?.sourceTaskId ?? task.id });
  if (demo?.preview) {
    deliveryAnalysisQuery.set("taskDemoPreview", "1");
    deliveryAnalysisQuery.set("taskDemoCopy", task.id);
  }
  const displayTheme = document.documentElement.dataset.theme;
  if (displayTheme === "light" || displayTheme === "dark") deliveryAnalysisQuery.set("theme", displayTheme);
  const deliveryAnalysisHref = `/?${deliveryAnalysisQuery}`;
  const demoMessageId = demo ? demoMessages[demo.phase] ?? demo.suggestedMessageId : undefined;
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
    defaultWorkspaceView(task),
  );
  const [materialsFullscreen, setMaterialsFullscreen] = useState(false);
  const [materialSearchOpen, setMaterialSearchOpen] = useState(false);
  const [materialSearchQuery, setMaterialSearchQuery] = useState("");
  const [materialSearchCount, setMaterialSearchCount] = useState(0);
  const [materialSearchIndex, setMaterialSearchIndex] = useState(-1);
  const [documentsDownloading, setDocumentsDownloading] = useState(false);
  const [documentsDownloadError, setDocumentsDownloadError] = useState("");
  const [taskInspector, setTaskInspector] = useState<TaskInspectorKind>();
  const [warmupOpen, setWarmupOpen] = useState(false);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [reviewRevealRequest, setReviewRevealRequest] = useState(0);
  const [reviewFocus, setReviewFocus] = useState<{
    ids: string[]; request: number;
  }>();
  const [reviewInviteOpen, setReviewInviteOpen] = useState(false);
  /** 需求原文页签上"这一轮改了什么"的对比;null = 看全文。 */
  const [revisionDiff, setRevisionDiff] = useState<{
    id: string; text: string; unavailable?: string;
  } | null>(null);
  const artifactTask = useRef("");
  const openedEvidenceGap = useRef("");
  const openedDeliverySummary = useRef("");
  const [decisionFooterTarget, setDecisionFooterTarget] = useState<HTMLDivElement | null>(null);
  // 右栏会话流:服务端投影(事件账/决定账/批注账/反馈索引拼成的回合)。
  // 每 4 秒一拍,决定/插话/批注落账后立刻补取一次,不等下一拍。
  const [conversation, setConversation] = useState<{
    items: ConversationItem[]; problems: string[]; loaded: boolean; unavailable?: string;
  }>({ items: [], problems: [], loaded: false });
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");
  const [streamThread, setStreamThread] = useState<string>();
  const [assistantView, setAssistantView] = useState<DeveloperAssistantView>();
  const [recoveryRequest, setRecoveryRequest] = useState(0);
  const [sideWidth, setSideWidth] = useState<number | undefined>(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_WIDTH_KEY));
      return saved >= SIDE_WIDTH_MIN ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  function startSideResize(event: React.PointerEvent<HTMLDivElement>) {
    const body = bodyRef.current;
    if (!body || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // 捕获失败(比如合成事件没有真实 pointerId)也照常拖:只是指针滑出拖柄时会掉
    try { handle.setPointerCapture(event.pointerId); } catch { /* 退化为无捕获拖动 */ }
    const bounds = body.getBoundingClientRect();
    const maxWidth = Math.max(SIDE_WIDTH_MIN, Math.floor(bounds.width * 0.6));
    const move = (pointer: PointerEvent) => {
      setSideWidth(Math.round(Math.min(maxWidth,
        Math.max(SIDE_WIDTH_MIN, bounds.right - pointer.clientX))));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      setSideWidth((current) => {
        try {
          if (current) localStorage.setItem(SIDE_WIDTH_KEY, String(current));
        } catch { /* 私密模式也能用 */ }
        return current;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
  const conversationRequest = useRef(0);
  const loadConversation = (taskId: string) => {
    const sequence = ++conversationRequest.current;
    return getConversation(taskId).then((result) => {
      if (sequence !== conversationRequest.current) return;
      if (result.view) {
        setConversation({ items: result.view.items, problems: result.view.problems, loaded: true });
      } else {
        setConversation((current) => ({ ...current, loaded: true, unavailable: result.unavailable }));
      }
    }).catch(() => {
      if (sequence === conversationRequest.current) {
        setConversation((current) => ({ ...current, loaded: true, unavailable: "会话流暂时读不到,稍后自动重试。" }));
      }
    });
  };
  useEffect(() => {
    setConversation({ items: [], problems: [], loaded: false });
    setStreamFilter("all");
    setStreamThread(undefined);
    setAssistantView(undefined);
    const stop = startVisiblePolling(() => void loadConversation(task.id), 4000, document);
    return () => { stop(); conversationRequest.current += 1; };
  }, [task.id]);
  useEffect(() => {
    if (!livePulse && !notesPulse) return;
    void loadConversation(task.id);
  }, [livePulse, notesPulse, task.status, task.waiting?.waiting_id]);
  // 深链:#thread=<批注 id> 打开时直接落到那条意见的往来(通知里带的链接)。
  useEffect(() => {
    const match = /(?:^#|&)thread=([^&]+)/.exec(window.location.hash);
    if (match) {
      setStreamThread(decodeURIComponent(match[1]));
    }
  }, [task.id]);
  function showThread(id?: string) {
    setStreamThread(id);
    const base = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", id ? `${base}#thread=${encodeURIComponent(id)}` : base);
  }
  const workspaceRoot = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const materialSearchInput = useRef<HTMLInputElement>(null);
  const materialSearchRows = useRef<HTMLElement[]>([]);
  const viewScroll = useRef<Partial<Record<WorkspaceView, number>>>({});
  const reviewFocusRequest = useRef(0);
  // 逐次串行落盘，避免用户连续输入单号时较慢的旧请求反过来覆盖新值。
  // 切走工作台不会取消这条队列，最后一次输入仍会写回服务端。
  const repositoryAssigneeSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const repositoryAssigneeSaveTask = useRef(task.id);
  const repositoryAssigneeSaveRevision = useRef(0);

  function changeRepositoryAssignees(next: RepositoryAssigneeSelection) {
    const clean = next.error ? next : { ...next, error: undefined };
    setRepositoryAssignees(clean);
    if (next.loading) return;
    const taskId = task.id;
    const revision = ++repositoryAssigneeSaveRevision.current;
    setRepositoryAssigneeSave("saving");
    repositoryAssigneeSaveQueue.current = repositoryAssigneeSaveQueue.current
      .catch(() => undefined)
      .then(async () => {
        await putRepositoryAssignees(taskId, clean.assignments, clean.tickets);
        if (repositoryAssigneeSaveTask.current === taskId
          && repositoryAssigneeSaveRevision.current === revision) {
          setRepositoryAssigneeSave("saved");
        }
      })
      .catch((cause) => {
        if (repositoryAssigneeSaveTask.current !== taskId
          || repositoryAssigneeSaveRevision.current !== revision) return;
        const message = cause instanceof Error ? cause.message : "分工草稿保存失败";
        setRepositoryAssigneeSave("error");
        setRepositoryAssignees((current) => ({ ...current, error: message }));
      });
  }

  // 工作区内切换材料、检视和运行记录；右栏只承接决定与回复。
  function openMaterial(view: MaterialView, diagram: "decomposition" | "architecture" = "architecture") {
    if (view === "chain") setDemoDiagram(diagram);
    if (view !== "doc") {
      setModuleLocation(undefined); setModuleLocationRetry(undefined);
      setLocationNotice("");
    }
    if (workspaceView === "execution" || workspaceView === "knowledge") selectWorkspaceView("materials");
    setMaterialView(view);
  }
  function openDemoDecomposition() {
    if (!demoHasDecomposition || !demo) return;
    openMaterial("chain", "decomposition");
    demo.onSelectPhase(TASK_DEMO_ANALYSIS_PHASE);
  }
  useEffect(() => {
    if (!demo) return;
    setStreamFilter("all"); setStreamThread(undefined);
    setDemoMessages(current => { const next = { ...current }; delete next[demo.phase]; return next; });
  }, [demo?.phase, demo?.focusKey]);
  useEffect(() => {
    if (!demo || !items) return;
    const selectionKey = `${demo.phase}:${demo.focusKey ?? 0}:${demoReviewReport?.name ?? ""}`;
    if (demoPhaseOpened.current === selectionKey) return;
    demoPhaseOpened.current = selectionKey;
    setStreamFilter("all"); setStreamThread(undefined);
    const document = demoReviewReport ?? items.find(item => item.kind === "doc"
      && demoContent?.artifactPatterns.some(pattern => pattern.test(item.name)));
    const code = demo.phase === TASK_DEMO_BUILD_PHASE ? items.find(item => item.kind === "diff") : undefined;
    setWorkspaceView(demoCompleted && !document ? "knowledge" : "materials");
    setDemoDiagram(demoAnalysis ? "decomposition" : "architecture");
    setMaterialView(demoAnalysis ? "chain" : code ? "diff" : document ? "doc" : "source");
    const selected = code ?? document;
    if (selected) { activeRef.current = selected.name; setActive(selected.name); }
  }, [demo?.phase, demo?.focusKey, items, demoContent, demoAnalysis, demoCompleted, demoReviewReport]);
  useEffect(() => {
    if (!demo) return;
    setNotesPulse(value => value + 1);
    setLivePulse(value => value + 1);
    void loadConversation(task.id);
  }, [demoRevision]);
  // 架构图和“阅读 Story”必须回到同一份设计来源：主任务用整体 Story，
  // 子任务用自己的模块 story.md。子任务没有 requirement graph 页签，不能
  // 再借 requirementGraphVisible 决定是否显示架构入口。
  const architectureStory = task.parent_task_id
    ? items?.find((item) => item.kind === "doc" && /(^|\/)story\.md$/.test(item.name))
    : items?.find((item) => item.kind === "doc" && item.purpose === "overall_story");
  const architectureStoryName = architectureStory?.name;
  const hasArchitectureStory = Boolean(architectureStoryName);
  function openModuleStory(id: string) {
    const view = id === "view:logical-class" ? { label: "类图" } : id.startsWith("view:") ? STORY_VIEWS.find((item) => item.id === id.slice(5)) : undefined;
    const module = view ? { name: view.label, scope: undefined } : task.requirement_graph?.repositories.find((item) => item.id === id);
    const request = ++locationRequest.current;
    setPendingLocation(undefined); setModuleLocation(undefined); setModuleLocationRetry(undefined);
    openMaterial("doc"); if (architectureStoryName) setActive(architectureStoryName);
    setContent(""); setLoading(true); setMaterialReload(request);
    setLocationNotice(module ? "正在定位设计说明…" : "模块分工已更新，已打开完整 Story，请核对最新方案。");
    if (module) setModuleLocation({ taskId: task.id, id, name: module.scope?.name ?? module.name, request });
  }
  function materialTabOn(view: MaterialView): boolean {
    return (workspaceView === "focus" || workspaceView === "materials") && materialView === view;
  }

  function selectWorkspaceView(next: WorkspaceView) {
    if (next === workspaceView) return;
    const currentScroll = workspaceRoot.current?.querySelector<HTMLElement>(
      ".ws-primary-scroll");
    if (currentScroll) viewScroll.current[workspaceView] = currentScroll.scrollTop;
    setWorkspaceView(next);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const nextScroll = workspaceRoot.current?.querySelector<HTMLElement>(
        ".ws-primary-scroll");
      if (nextScroll) nextScroll.scrollTop = viewScroll.current[next] ?? 0;
    }));
  }

  useEffect(() => {
    artifactTask.current = "";
    openedEvidenceGap.current = "";
    setItems(undefined);
    setModuleLocation(undefined); setModuleLocationRetry(undefined); setLocationNotice("");
    setActive("");
    setContent("");
    setSelectedDiffPath("");
    loadedMaterialKey.current = "";
    setDiffFileLoading(false);
    setDiffFileError("");
    setMaterialView(task.waiting?.recommended_view
      ?? (task.parent_task_id ? "doc"
        : task.requirement_graph?.stage === "confirmed" ? "chain" : "source"));
    setWorkspaceView(defaultWorkspaceView(task));
    setMaterialsFullscreen(false);
    setMaterialSearchOpen(false);
    setMaterialSearchQuery("");
    setMaterialSearchCount(0);
    setMaterialSearchIndex(-1);
    setDocumentsDownloading(false);
    setDocumentsDownloadError("");
    setReviewPanelOpen(false);
    setTaskInspector(undefined);
    setWarmupOpen(false);
    setReviewFocus(undefined);
    repositoryAssigneeSaveTask.current = task.id;
    setRepositoryAssigneeSave("idle");
    setRepositoryAssignees(EMPTY_REPOSITORY_ASSIGNEE_SELECTION);
    setRevisionDiff(null);
    setPushDiffState(pushReview ? { kind: "checking" } : { kind: "idle" });
    setDiffScope(pushReview?.has_focused_changes ? "changes" : "full");
    setDiffReviewRequest(0);
  }, [task.id]);

  useEffect(() => {
    if (materialView !== "diff") return;
    let alive = true;
    void comparisonReader.current.read(task.id, signal => readDiffReview(task.id, signal)).then(review => {
      if (!alive) return;
      setBrowsingReview(previous => previous?.taskId === task.id
        && JSON.stringify(previous.review) === JSON.stringify(review) ? previous : { taskId: task.id, review });
    }).catch(() => { /* 元数据暂不可用时保留阅读，不改变任务状态。 */ });
    return () => { alive = false; };
  }, [task.id, materialView, livePulse, materialReload, approvalReview]);

  useEffect(() => {
    if (!pushReview) {
      setPushDiffState({ kind: "idle" });
      setDiffScope("full");
      return;
    }
    setPushDiffState({ kind: "checking" });
    setContent("");
    setDiffScope(pushReview.has_focused_changes ? "changes" : "full");
  }, [task.id, task.waiting?.waiting_id]);

  useEffect(() => {
    if (demo) return;
    const waitingId = task.waiting?.waiting_id;
    if (!waitingId || task.status === "paused") return;

    // 新决定回到「当前」；需要核对哪份材料由决定卡和证据入口精确打开。
    setWorkspaceView("focus");
    const recommended = task.waiting?.recommended_view;
    if (!recommended) return;
    setMaterialView(recommended);
    if (recommended === "diff") {
      const first = items?.find((item) => item.kind === "diff");
      if (first) setActive(first.name);
    } else if (recommended === "doc") {
      const first = items?.find((item) => item.kind === "doc");
      if (first) setActive(first.name);
    }
  }, [task.status, task.waiting?.waiting_id, task.waiting?.recommended_view]);

  useEffect(() => {
    if (demo) return;
    setWorkspaceView("focus");
  }, [task.status, task.waiting?.waiting_id,
    task.delivery?.evidence_gap?.state,
    task.delivery?.evidence_gap?.sha]);

  useEffect(() => {
    let alive = true;
    void listPeople().then((people) => {
      if (alive) setReviewPeople(people);
    }).catch(() => {
      // 姓名只是显示增强；读取失败退回账号，不能挡住检视主流程。
      if (alive) setReviewPeople([]);
    });
    return () => { alive = false; };
  }, [task.id]);

  useEffect(() => {
    if (!canRequestReview) return;
    let alive = true;
    void listCommitters().then((users) => {
      if (!alive) return;
      setCommitters(users);
      setReviewers([]);
    }).catch((reason) => {
      if (alive) setReviewResult(reason instanceof Error
        ? reason.message : "Committer 名单读取失败");
    });
    return () => { alive = false; };
  }, [canRequestReview, task.id]);

  useEffect(() => {
    if (!canRequestReview) return;
    let alive = true;
    void listTaskReviews(task.id).then((reviews) => {
      if (alive) setTaskReviews(reviews);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [canRequestReview, task.id]);

  async function inviteReview() {
    if (!reviewers.length || reviewBusy) return;
    setReviewBusy(true); setReviewResult("");
    try {
      const selected = [...new Set(reviewers)];
      const outcomes = await Promise.allSettled(selected.map(account => requestCommitterReview(task.id, account)));
      const received: ReviewRequest[] = [];
      const failed: string[] = [];
      const messages = outcomes.map((outcome, index) => {
        const account = selected[index];
        const name = committers.find(user => user.username === account)?.display_name ?? account;
        if (outcome.status === "fulfilled") {
          received.push(outcome.value);
          if (outcome.value.delivered) return `${name}：已通知`;
          failed.push(account);
          return `${name}：未送达（${outcome.value.last_error || "通知服务暂无回执"}）`;
        }
        failed.push(account);
        return `${name}：${outcome.reason instanceof Error ? outcome.reason.message : "邀请发送失败"}`;
      });
      setTaskReviews(current => [...received, ...current.filter(item => !received.some(result => result.id === item.id))]);
      setReviewers(failed);
      setReviewResult(messages.join("；") + (failed.length ? "。已保留未成功的人选，可重新发送。" : ""));
    } finally { setReviewBusy(false); }
  }

  async function finishReview() {
    if (!reviewAssignment || completeBusy) return;
    setCompleteBusy(true); setCompleteError("");
    try {
      await completeReview(reviewAssignment.id);
      await onChanged();
    } catch (reason) {
      setCompleteError(reason instanceof Error ? reason.message : "完成检视失败");
    } finally { setCompleteBusy(false); }
  }

  // 它在跑的时候材料是活的:界面上写着"材料会随进展刷新",那就得真刷。
  // 原来只在 task.id/status 变化时取一次,于是整段编码期页面一动不动,
  // 批注的"这处已被改动"也永远停在旧结论上。
  // 只在 running 时轮询,5 秒一次;拿到一样的内容就不 setState,免得
  // 正在写批注时被重渲染打断。
  useEffect(() => {
    if (task.status !== "running" && task.status !== "pausing") return;
    return startVisiblePolling(
      () => setLivePulse((tick) => tick + 1),
      5000,
      document,
      { runOnStart: false },
    );
  }, [task.status]);

  // 任务头实测高度写进 --ws-head-h(task-workspace.css 用它做 .ws-head 的
  // min-height 底线)。头高不是常量:标题换行、窄屏都会撑高,写死迟早出缝。
  // 原来还喂固定定位的检视抽屉,抽屉 2026-09-05 改成材料区内画布后只剩
  // 这一个消费者。ResizeObserver 缺席就退回默认值——旁路不该让人卡住。
  useEffect(() => {
    const head = headRef.current;
    const root = workspaceRoot.current;
    if (!head || !root) return;
    const publish = () => root.style.setProperty(
      "--ws-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
    publish();
    // 窄屏那档任务头是 66px 不是 70px(min-height 被媒体查询改小),差 4px
    // 就是抽屉和头之间一道背景缝。ResizeObserver 管标题换行这种"窗口没动
    // 头却变高"的情况,window.resize 兜住它不触发回调的场合(页面不渲染时
    // 观察器回调随帧一起停,实测过)——两条都只是重算一个数,重复无害。
    window.addEventListener("resize", publish);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined : new ResizeObserver(publish);
    observer?.observe(head);
    return () => {
      window.removeEventListener("resize", publish);
      observer?.disconnect();
    };
  }, []);


  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (warmupOpen) { setWarmupOpen(false); return; }
      if (taskInspector) {
        if (!document.querySelector(".warmup-overlay")) setTaskInspector(undefined);
        return;
      }
      if (materialSearchOpen) {
        setMaterialSearchOpen(false);
        setMaterialSearchQuery("");
      } else if (reviewInviteOpen) setReviewInviteOpen(false);
      else if (reviewPanelOpen) setReviewPanelOpen(false);
      else if (materialsFullscreen) setMaterialsFullscreen(false);
      else onClose();
    };
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", escape);
      document.body.style.overflow = previous;
    };
  }, [taskInspector, warmupOpen, materialSearchOpen, materialsFullscreen, reviewInviteOpen,
    reviewPanelOpen, onClose]);

  // ⌥/Alt+R 在任何布局下切换批注 Inspector:按 code 不按
  // key——Mac 上 ⌥R 的 key 是 "®";焦点在输入框里不抢,输入法合成中不抢。
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || event.code !== "KeyR" || event.isComposing) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setReviewPanelOpen((open) => !open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);

  // 熟练用户可以不离开键盘切换三块稳定画布；输入区与输入法合成期间
  // 永远不抢键。快捷键只改变呈现，不触碰任何任务状态。
  useEffect(() => {
    const switchView = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || event.isComposing || isEditableTarget(event.target)) return;
      const next = WORKSPACE_VIEW_SHORTCUTS[event.code];
      if (!next) return;
      event.preventDefault();
      selectWorkspaceView(next);
    };
    window.addEventListener("keydown", switchView);
    return () => window.removeEventListener("keydown", switchView);
  }, [workspaceView]);

  // 搜索范围就是当前渲染出来的这一份材料。普通文档取带 data-l 的最深
  // 正文行；两种差异视图取各自的真实内容行，删除行没有新行号也能搜到。
  useEffect(() => {
    for (const row of materialSearchRows.current) {
      row.classList.remove("material-search-hit", "material-search-current");
    }
    materialSearchRows.current = [];
    setMaterialSearchCount(0);
    setMaterialSearchIndex(-1);
    if (!materialSearchOpen || !materialSearchQuery.trim()
        || workspaceView === "execution" || materialView === "chain"
        || loading) return;
    const timer = window.setTimeout(() => {
      const root = workspaceRoot.current?.querySelector<HTMLElement>(".ws-doc");
      if (!root) return;
      const diffRows = root.querySelectorAll<HTMLElement>(
        ".diff-review-row, .requirement-diff-row");
      const rows = diffRows.length
        ? [...diffRows]
        : [...root.querySelectorAll<HTMLElement>("[data-l]")]
          .filter((row) => !row.querySelector("[data-l]"));
      const matches = matchingMaterialRowIndexes(rows, materialSearchQuery)
        .map((index) => rows[index]);
      materialSearchRows.current = matches;
      for (const row of matches) row.classList.add("material-search-hit");
      setMaterialSearchCount(matches.length);
      if (!matches.length) return;
      matches[0].classList.add("material-search-current");
      setMaterialSearchIndex(0);
      matches[0].scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active, content, loading, materialSearchOpen, materialSearchQuery,
    materialView, revisionDiff, task.requirement, workspaceView]);

  function moveMaterialSearch(step: -1 | 1) {
    const rows = materialSearchRows.current;
    if (!rows.length) return;
    rows[materialSearchIndex]?.classList.remove("material-search-current");
    const next = materialSearchIndex < 0
      ? 0 : (materialSearchIndex + step + rows.length) % rows.length;
    rows[next].classList.add("material-search-current");
    rows[next].scrollIntoView({ block: "center", behavior: "smooth" });
    setMaterialSearchIndex(next);
  }

  function toggleMaterialSearch() {
    if (materialSearchOpen) {
      setMaterialSearchOpen(false);
      setMaterialSearchQuery("");
      return;
    }
    setMaterialSearchOpen(true);
    window.requestAnimationFrame(() => materialSearchInput.current?.focus());
  }

  // 产物列表按最近修改倒序(服务端排好),默认打开第一份——
  // "哪一步该看哪个文件"是内核语义,前端不复刻,只用修改时间定位。
  useEffect(() => {
    let alive = true;
    const showArtifacts = (result: Awaited<ReturnType<typeof listArtifacts>>, documentsOnly = false) => {
      if (!alive) return;
      setUnavailable(result.unavailable ?? "");
      setItems(previous => documentsOnly
        ? [...(result.items ?? []), ...(previous ?? []).filter(item => item.kind === "diff")]
        : result.items);
      // 代码检视仍等真实变更清单；后台刷文档也不能覆盖用户已选的文件。
      if (documentsOnly && (materialViewRef.current === "diff" || artifactTask.current === task.id)) return;
      // 列表可能随任务轮询/状态切换重新读取。默认项只用于首次进入；
      // 用户已经切到代码改动时绝不能被后台刷新拽回最近文档。
      const evidenceKey = pipelineEvidenceNeedsHuman(task)
        ? `${task.id}:${task.delivery?.evidence_gap?.sha ?? ""}` : "";
      const newlyActionable = Boolean(evidenceKey
        && openedEvidenceGap.current !== evidenceKey);
      let current = artifactTask.current === task.id && !newlyActionable
        ? activeRef.current : "";
      // 等待清单期间可能已切到代码页签，迟到响应应打开代码，不能把文档当 Diff。
      if (materialViewRef.current === "diff"
          && result.items?.find(item => item.name === current)?.kind !== "diff") current = "";
      const summaryLink = new URLSearchParams(window.location.search).get("deliverySummary") === "1"
        && openedDeliverySummary.current !== task.id
        && result.items?.some(item => item.name === "task-materials/交付报告.md");
      const next = summaryLink ? "task-materials/交付报告.md" : preferredWorkspaceArtifact(
        result.items ?? [], current, materialViewRef.current === "diff" ? "diff" : recommendedMaterialView,
        pipelineEvidenceNeedsHuman(task));
      artifactTask.current = task.id;
      openedEvidenceGap.current = evidenceKey;
      activeRef.current = next;
      setActive(next);
      if (summaryLink) { openedDeliverySummary.current = task.id; openMaterial("doc"); }
      if (next !== current && ["pipeline_evidence_gap", "delivery_unit_brief",
        "delivery_plan"].includes(result.items?.find((item) => item.name === next)
          ?.purpose ?? "")) {
        setMaterialView("doc");
      }
    };
    void artifactReader.current.read(task.id, signal => listArtifacts(task.id, signal,
      result => showArtifacts(result, true))).then(result => showArtifacts(result))
      .catch(reason => { if (alive && reason?.name !== "AbortError") setUnavailable(String(reason)); });
    return () => { alive = false; };
  }, [task.id, livePulse, task.updated_at, task.delivery?.evidence_gap?.state,
    task.delivery?.evidence_gap?.sha, recommendedMaterialView]);

  const activeArtifactForRead = items?.find((item) => item.name === active);
  const activeChangeFiles = activeArtifactForRead?.change_files;
  const activeUntrackedDirectories =
    activeArtifactForRead?.untracked_directories ?? [];
  const activeUntrackedDirectoryKey = activeUntrackedDirectories
    .map((directory) => directory.path).join("\0");
  const selectedFromUntrackedDirectory = activeUntrackedDirectories.some(
    (directory) => selectedDiffPath.startsWith(`${directory.path}/`));
  const requestedDiffPath = activeChangeFiles?.some((file) =>
    file.path === selectedDiffPath) || selectedFromUntrackedDirectory
    ? selectedDiffPath
    : activeChangeFiles?.[0]?.path ?? "";

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setMaterialReadError("");
    const pushDiffActive = Boolean(scopedDiff
      && items?.find((item) => item.name === active)?.kind === "diff");
    const lazyWorkspaceDiff = !pushDiffActive
      && activeArtifactForRead?.kind === "diff"
      && Boolean(requestedDiffPath);
    // 同一份材料后台更新时保留正文、选区和滚动位置；切文件才显示加载态。
    // 原来每 5 秒把差异正文换成“正在读取”，连未变化的文件也会闪一下。
    const readKey = JSON.stringify([task.id, active, pushDiffActive
      ? [diffScope, pushReview?.base_sha, pushReview?.head_sha, task.waiting?.waiting_id]
      : lazyWorkspaceDiff ? requestedDiffPath : activeUntrackedDirectoryKey]);
    const opening = loadedMaterialKey.current !== readKey;
    // 差异内部换文件只替换正文，保留文件树、分栏宽度及检视选择。
    setLoading((was) => was || (opening && (!lazyWorkspaceDiff || !content)));
    setDiffFileLoading(lazyWorkspaceDiff && opening);
    setDiffFileError("");
    if (pushDiffActive && opening) setPushDiffState({ kind: "checking" });
    const directoryOnlyWorkspaceDiff = !pushDiffActive
      && activeArtifactForRead?.kind === "diff"
      && !requestedDiffPath
      && activeUntrackedDirectories.length > 0;
    const reading = materialReader.current.read(readKey, signal => pushDiffActive
      ? readPushReviewDiff(task.id, diffScope, signal)
      : lazyWorkspaceDiff
        ? readArtifactFileDiff(task.id, requestedDiffPath, signal)
        : directoryOnlyWorkspaceDiff
          ? Promise.resolve({
              content: "未跟踪目录已折叠；展开目录后再按需读取文件。",
              branch: undefined,
              unavailable: undefined,
            })
        : readArtifact(task.id, active, signal));
    void reading.then((result) => {
      if (!alive) return;
      loadedMaterialKey.current = readKey;
      setLoadedMaterialReload(materialReload);
      if (pushDiffActive) {
        const normalized = normalizePushReviewDiffResult(result);
        setPushDiffState(normalized.state);
        setMaterialReadError(normalized.state.kind === "error" ? normalized.state.message : "");
        setContent((current) => current === normalized.content
          ? current : normalized.content);
        setBranch(normalized.branch);
        setLoading(false);
        setDiffFileLoading(false);
        return;
      }
      setMaterialReadError(result.unavailable ?? "");
      const next = result.content ?? result.unavailable ?? "";
      // 内容没变就别 setState:轮询期间无谓重渲染会把正在写的批注打断。
      setContent((current) => current === next ? current : next);
      setBranch(result.branch ?? "");
      setDiffFileError(lazyWorkspaceDiff ? result.unavailable ?? "" : "");
      setLoading(false);
      setDiffFileLoading(false);
    }).catch((reason) => {
      if (!alive) return;
      setLoadedMaterialReload(materialReload);
      const message = reason instanceof Error ? reason.message : String(reason);
      setMaterialReadError(message);
      if (pushDiffActive) {
        setPushDiffState({ kind: "error", message, expired: false });
        setContent("");
        setBranch("");
      } else {
        setContent(message);
        setBranch("");
        if (lazyWorkspaceDiff) setDiffFileError(message);
      }
      setLoading(false);
      setDiffFileLoading(false);
    });
    return () => { alive = false; };
  }, [task.id, active, livePulse, materialReload, diffScope, scopedDiff, pushReview?.base_sha, pushReview?.head_sha,
    task.waiting?.waiting_id,
    activeArtifactForRead?.kind, requestedDiffPath,
    activeUntrackedDirectoryKey]);

  // 主任务协调/完成后仍可能有整体 Story 文档会话，检视回执需要独立刷新。
  useEffect(() => {
    if (task.requirement_graph?.stage !== "confirmed" || task.status === "canceled") return;
    return startVisiblePolling(() => setNotesPulse((tick) => tick + 1), 5000, document);
  }, [task.id, task.status, task.requirement_graph?.stage]);

  // 批注随任务加载,也随"圈了一条/送出一批/任务状态变了"重取——
  // 进展(那处动没动)和闭环结论都是服务端现算的,前端不自己推断。
  // 结论的输入还有当前卡和复检标记:两张人工卡背靠背换、status 不变时,
  // 只盯 status 会让结论停在上一张卡上(收敛后才有的时序,原来前端按
  // props 现推没这个问题),所以卡版本与复检标记也要触发重取。
  useEffect(() => {
    let alive = true;
    void listAnnotations(task.id).then((result) => {
      if (!alive) return;
      setNotes(result.items);
      setChecks(result.checks);
      setClosures(result.closures);
      setAnnotationSubmission(result.submission);
      setReply(result.reply);
    });
    return () => { alive = false; };
  }, [task.id, task.status, task.waiting?.state_version,
    task.requirement,
    task.requirement_revision?.id, task.requirement_revision?.state,
    task.delivery?.loop?.workspace_review_recheck_required,
    notesPulse, livePulse]);

  const requirementAnalysisConfirmation = task.status === "waiting_for_human"
    && task.waiting?.step === "cloud_requirement_analysis_confirm";
  // 决定卡只展示会阻塞团队流转的事实：已送达意见，以及责任人自己的
  // 未送达草稿。需求确认是多人共同检视，已经留下的任何草稿都必须先
  // 处理，不能被主责任人的确认按钮越过。
  const unresolvedNotes = notes.filter((item) =>
    item.status === "sent" || (item.status === "draft"
      && (requirementAnalysisConfirmation
        || !task.luban_account || item.author === task.luban_account)));
  // sent 仍是“未闭环”，要继续展示并阻止误放行；但它已经主动送给
  // Agent，不能再冒充本次决定要附带的草稿。两组 ID 混用会让决定接口
  // 按 draft 校验时拒绝整次提交，连人刚写的补充说明也一起被挡住。
  const draftIds = decisionAnnotationIds(notes, viewerUsername);
  const queuedIds = queuedDecisionAnnotationIds(notes);
  const pendingReviewIds = [...new Set([...queuedIds, ...notes.filter(item => pendingReviewAnnotation(item)
    && !(overallStoryPublished && item.artifact === OVERALL_STORY_ARTIFACT)).map(item => item.id)])];

  /** 切换材料、刷新正文与锚点，再由渲染完成后的 effect 定位。 */
  async function locate(item: Annotation) {
    setLocationExcerpt(item);
    setModuleLocation(undefined); setModuleLocationRetry(undefined);
    const request = ++locationRequest.current;
    setPendingLocation(undefined);
    setWorkspaceView("materials");
    const graph = item.artifact === REQUIREMENT_GRAPH_ARTIFACT;
    const source = item.artifact === TASK_REQUIREMENT_ARTIFACT;
    const targetArtifact = item.artifact === "__workspace_diff__"
      ? items?.find((artifact) => artifact.kind === "diff")?.name : item.artifact;
    if (!source && !graph && targetArtifact && targetArtifact !== active) setActive(targetArtifact);
    const targetView = materialViewForAnnotation(item.artifact, items);
    setMaterialView(targetView);
    if (graph && demoHasDecomposition) openDemoDecomposition();
    if (targetView === "diff" && item.file) setSelectedDiffPath(item.file);
    setLocationNotice("正在核对批注的当前位置…");
    let fresh;
    try {
      await onChanged();
      fresh = await listAnnotations(task.id);
    } catch {
      if (request === locationRequest.current) setLocationNotice("暂时无法核对当前位置，先展示批注时原文。");
      return;
    }
    if (request !== locationRequest.current) return;
    setNotes(fresh.items); setChecks(fresh.checks); setClosures(fresh.closures); setAnnotationSubmission(fresh.submission);
    if (!source && !graph) {
      setLoading(true);
      setMaterialReload(request);
    }
    if (graph) {
      setPendingLocation({ request, item, view: targetView, artifact: targetArtifact });
      return;
    }
    const check = fresh.checks.find((candidate) => candidate.id === item.id);
    const range = resolvedAnnotationRange(item, check);
    if (check?.state === "gone") {
      setLocationNotice(
        `“${item.anchor.slice(0, 46)}${item.anchor.length > 46 ? "…" : ""}”`
        + " 已变化，下面保留批注时原文和意见。",
      );
      return;
    } else if (check?.state === "ambiguous") {
      setLocationNotice("原文有多处匹配，先展示批注时的片段，不跳转到不确定的位置。");
      return;
    } else if (!range) {
      setLocationNotice("暂时无法确认当前位置，先展示批注时原文。");
      return;
    } else {
      setLocationNotice(""); setLocationExcerpt(undefined);
    }
    setPendingLocation({ request, item, view: targetView,
      artifact: targetArtifact, line: range.line });
  }

  useEffect(() => {
    const pending = pendingLocation;
    if (!pending || pending.request !== locationRequest.current) return;
    if (materialView !== pending.view) { setPendingLocation(undefined); return; }
    const reader = workspaceRoot.current?.querySelector<HTMLElement>(".ws-doc");
    if (!reader || reader.dataset.artifact !== pending.artifact) return;
    if (pending.view !== "source" && pending.view !== "chain"
      && (loading || diffFileLoading || loadedMaterialReload !== pending.request)) return;
    if (pending.view !== "source" && pending.view !== "chain" && materialReadError) {
      setPendingLocation(undefined);
      setLocationExcerpt(pending.item);
      setLocationNotice("当前材料暂不可读，先展示批注时原文。");
      return;
    }
    const node = pending.view === "chain"
      ? [...reader.querySelectorAll<HTMLElement>("[data-review-anchor]")]
        .find((row) => row.dataset.reviewAnchor === graphAnnotationLocationKey(pending.item.anchor))
      : annotationLocationRow([...reader.querySelectorAll<HTMLElement>("[data-l]")],
        pending.line!, pending.view === "diff" ? pending.item.file : undefined);
    setPendingLocation(undefined);
    if (!node) {
      setLocationExcerpt(pending.item);
      setLocationNotice(`已打开 ${pending.item.file}，当前版本没有可定位的对应位置；请结合原文和 Agent 回应核对。`);
      return;
    }
    // 图可能被用户折叠，先展开再滚动；不改变右侧意见面板。
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== reader) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    setLocationNotice("");
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("annot-flash");
    window.setTimeout(() => node.classList.remove("annot-flash"), 1700);
  }, [pendingLocation, materialView, active, content, loading, diffFileLoading,
    loadedMaterialReload, materialReadError, task.requirement, task.requirement_graph]);
  // 定位等待有上限；超时后不再执行迟到的滚动，用户可主动重试。
  useEffect(() => {
    if (!moduleLocation) return;
    const timer = window.setTimeout(() => {
      setModuleLocation(undefined); setModuleLocationRetry(moduleLocation.id);
      setLoading(false); setContent("");
      setLocationNotice("Story 加载超时，请重试定位；你可以继续查看分工。");
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [moduleLocation]);
  useEffect(() => {
    if (!moduleLocation) return;
    if (moduleLocation.taskId !== task.id || materialView !== "doc" || active !== architectureStoryName) {
      setModuleLocation(undefined); return;
    }
    if (loading || loadedMaterialReload !== moduleLocation.request) return;
    setModuleLocation(undefined);
    const reader = workspaceRoot.current?.querySelector<HTMLElement>(".ws-doc");
    const line = materialReadError ? undefined : moduleLocation.id === "view:logical-class"
      ? storyViewCoverage(content).find((view) => view.id === "logical")?.classDiagram?.line
      : moduleLocation.id.startsWith("view:")
      ? storyViewCoverage(content).find((view) => view.id === moduleLocation.id.slice(5))?.line
      : moduleStoryLine(content, moduleLocation);
    const row = line && reader ? annotationLocationRow([...reader.querySelectorAll<HTMLElement>("[data-l]")], line) : undefined;
    reader?.querySelectorAll(".annot-flash").forEach((node) => node.classList.remove("annot-flash"));
    if (!row) {
      setModuleLocationRetry(moduleLocation.id);
      setLocationNotice(materialReadError ? "Story 读取失败，请重试。" : `已打开最新 Story，未找到「${moduleLocation.name}」的唯一对应段落，请在正文中核对。`);
      reader?.scrollTo({ top: 0 });
      return;
    }
    setModuleLocationRetry(undefined);
    setLocationNotice("");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("annot-flash");
    window.setTimeout(() => row.classList.remove("annot-flash"), 2500);
  }, [moduleLocation, task.id, materialView, active, architectureStoryName,
    loading, loadedMaterialReload, content, materialReadError]);
  const activeMeta = items?.find((item) => item.name === active);
  const materialPriority = (item: ArtifactMeta): number =>
    item.purpose === "delivery_unit_brief" ? 0
      : item.purpose === "delivery_plan" ? 1 : 2;
  const documents = (items?.filter((item) => item.kind === "doc") ?? [])
    .sort((left, right) => materialPriority(left) - materialPriority(right));
  const primaryDocument = task.parent_task_id
    ? documents.find((item) => item.purpose === "delivery_unit_brief")
      ?? documents[0]
    : documents[0];
  const changes = items?.filter((item) => item.kind === "diff") ?? [];
  const evidenceGapArtifact = documents.find((item) =>
    item.purpose === "pipeline_evidence_gap");
  const evidenceGapActionable = pipelineEvidenceNeedsHuman(task);

  async function downloadDocuments() {
    if (!documents.length || documentsDownloading) return;
    setDocumentsDownloading(true);
    setDocumentsDownloadError("");
    try {
      const response = await fetch(
        `/tasks/${encodeURIComponent(task.id)}/artifacts/archive`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(String(body.error ?? `打包下载失败(${response.status})`));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `${task.id}-产出文档-`
        + `${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (reason) {
      setDocumentsDownloadError(
        String(reason instanceof Error ? reason.message : reason));
    } finally {
      setDocumentsDownloading(false);
    }
  }

  // 服务端只生成一份聚合 diff，因此 changes.length 几乎永远是 1，
  // 它表示“产物份数”而不是用户关心的“变更文件数”。旧服务尚未提供
  // file_count 时保留原回退，避免滚动升级期间把入口误判为空。
  const changeCountKnown = changes.every((item) =>
    typeof item.file_count === "number");
  const changeFileCount = changeCountKnown
    ? changes.reduce((sum, item) => sum + (item.file_count ?? 0), 0)
    : changes.length;
  const untrackedDirectoryCount = changes.reduce((sum, item) =>
    sum + (item.untracked_directories?.length ?? 0), 0);
  // 全局 Story 的设计图入口沿用主任务的分析可见性。
  const hasRequirementGraph = requirementGraphVisible(task);
  const materialHeading = materialView === "source"
    ? { kicker: "REQUEST SOURCE", title: "当前需求" }
    : materialView === "chain"
    ? { kicker: "ARCHITECTURE", title: demoShowsDecomposition ? "需求拆分" : "架构图" }
    : materialView === "diff"
      ? pushReview
        ? { kicker: "PUSH REVIEW", title: diffScope === "changes"
            ? pushReview.title : "完整交付内容" }
        : { kicker: "WORKTREE CHANGES", title: "代码改动" }
      : activeMeta?.purpose === "delivery_unit_brief"
        ? { kicker: "CURRENT DELIVERY UNIT", title: "当前单元任务书" }
        : activeMeta?.purpose === "delivery_plan"
          ? { kicker: "REVIEWED DELIVERY PLAN", title: "整体拆分方案" }
          : { kicker: "WORK DOCUMENTS", title: "产出文档" };
  const waiting = task.status === "waiting_for_human" && task.waiting;
  const workspaceReviewReady = task.status === "waiting_for_human"
    && task.waiting?.step === "cloud_push_confirm"
    && task.delivery?.loop?.review_source === "workspace"
    && task.delivery.loop.workspace_review_recheck_required === true;
  const workspaceReviewAnnotationIds = workspaceReviewReady
    ? task.delivery?.loop?.workspace_review_annotation_ids ?? []
    : [];
  // 检视意见里除了工作台批注,还列 CodeHub 检视意见与机器检视结果。
  // 工作台来源的反馈已经以批注卡片的身份在场(带作者裁决权),不重复列。
  const machineFeedback = (task.feedback ?? [])
    .filter((item) => item.source !== "mr_discussion" && item.source !== "workspace");
  const importedMrIds = new Set(notes.flatMap(item => item.external_review ? [item.external_review.discussion_id] : []));
  const mrFeedback = (task.feedback ?? []).filter(item => item.source === "mr_discussion" && !importedMrIds.has(item.source_id));
  const pipelineHumanFeedback = machineFeedback.filter(item =>
    ["pipeline", "build_fix"].includes(item.source) && item.status === "needs_human");
  const codeReviewCount = notes.length + mrFeedback.length;
  const reviewRecordCount = notes.length
    + machineFeedback.length + mrFeedback.length;
  // 抽屉顶部筛选条:三节共用一套档位。批注按作者/裁决就绪归档,反馈按
  // 状态归档(needs_human 压在人这;closed 已闭环;其余在 Agent 或门禁手里)。
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  // 服务端已经把移动过的原文重锚到当前行。材料标记必须使用这个当前
  // 行号；原文已删除则不在别的内容上制造一个同号假标记。
  const locatableNotes = notes.flatMap((item) => {
    if (item.status === "dropped") return [];
    const check = checks.find((candidate) => candidate.id === item.id);
    const range = resolvedAnnotationRange(item, check);
    return range ? [{ ...item, line: range.line, line_end: range.lineEnd }] : [];
  });
  const openAnnotationReview = (ids: string[]) => {
    if (!ids.length) return;
    reviewFocusRequest.current += 1;
    setReviewFilter("all");
    setReviewFocus({ ids, request: reviewFocusRequest.current });
    setReviewPanelOpen(true);
  };
  // 归档也照服务端结论:页面不再按 status/sent_via 自己分档。
  const closureOf = (id: string) => closures.find((one) => one.id === id);
  const noteCategory = (item: Annotation): Exclude<ReviewFilter, "all"> =>
    closureOf(item.id)?.bucket ?? "agent";
  const reviewCounts = { all: reviewRecordCount, mine: 0, agent: 0, closed: 0 };
  for (const item of notes) reviewCounts[noteCategory(item)] += 1;
  for (const item of [...machineFeedback, ...mrFeedback]) {
    reviewCounts[feedbackCategory(item)] += 1;
  }
  const filteredMachine = reviewFilter === "all" ? machineFeedback
    : machineFeedback.filter((item) => feedbackCategory(item) === reviewFilter);
  const filteredMr = reviewFilter === "all" ? mrFeedback
    : mrFeedback.filter(item => feedbackCategory(item) === reviewFilter);
  function openPipelineFeedback() {
    setReviewFilter("mine"); setReviewPanelOpen(true);
    setReviewRevealRequest(request => request + 1);
  }
  useEffect(() => {
    if (reviewPanelOpen) {
      const feedback = workspaceRoot.current?.querySelector<HTMLElement>("#ws-review-canvas");

      feedback?.focus({ preventScroll: true });
    }
  }, [reviewPanelOpen, materialsFullscreen, reviewFocus?.request, reviewRevealRequest]);

  const nextAction = workspaceNextActionCopy(task, Boolean(waiting));
  const canContributeReview = canOperate
    || isInvitedReviewParticipant(task, viewerUsername) || !!reviewAssignment;
  const canCreateAnnotation = canCreateWorkspaceAnnotation(task.status);
  // 多仓分析过程中的普通澄清也处于 analysis；分工只应在最终 Chain 方案
  // 检视卡出现。判据和卡片标题共用 isChainReviewWaiting,别两处各抄一份。
  const chainReview = !!waiting && isChainReviewWaiting(task);
  // 受邀参与讨论的人在分析期能答卡(2026-09-04 用户拍板:邀请了就得能
  // 回答);拍板类卡只认责任人。服务端 decide 是同一口径的硬闸。
  // 澄清卡问的是意见作者:被追问的人即使不是责任人也能答(服务端同口径)。
  const clarificationRespondent = !!waiting && isClarificationWaiting(task)
    && notes.some((item) => item.author === viewerUsername
      && (task.waiting?.question?.annotation_ids ?? []).includes(item.id));
  const decides = isOwnerOnlyWaiting(task)
    ? viewerUsername === (task.luban_account ?? "本地用户")
    : canOperate || canCollaborate || clarificationRespondent;
  const controllable = canOperate && task.delivery?.final_mr?.state !== "merged" && [
    "queued", "running", "pausing", "paused", "waiting_for_human", "verifying",
    "await_merge",
  ].includes(task.status);
  const deletable = canOperate && ["completed", "failed", "canceled"]
    .includes(task.status);
  const health = taskHealthFacts(task, viewerUsername);
  const visibleProgress = workspaceProgress(task);
  const pauseFeedback = task.status === "pausing"
    ? {
        state: "pending",
        title: "正在安全暂停",
        detail: task.detail
          || "系统正在停止当前会话；完成后会自动变为“已暂停”。",
      }
    : controlBusy === "pause"
        ? {
            state: "pending",
            title: "暂停请求已提交",
            detail: "正在请求停止当前会话。",
          }
        : undefined;

  async function runControl(action: "pause" | "resume" | "cancel") {
    if (controlBusy) return;
    setControlBusy(action);
    setControlError("");
    try {
      const result = await controlTask(task.id, action);
      if (result.error) setControlError(result.error);
      else {
        setCancelArmed(false);
        await onChanged();
      }
    } catch (reason) {
      setControlError(reason instanceof Error
        ? reason.message : `${action === "pause" ? "暂停" : action === "resume"
          ? "恢复" : "取消"}请求失败，请重试`);
    } finally {
      setControlBusy("");
    }
  }

  async function deleteTask() {
    if (controlBusy) return;
    setControlBusy("delete");
    setControlError("");
    try {
      const result = await deleteHistoryTask(task.id);
      if (result.error) setControlError(result.error);
      else {
        await onChanged();
        onClose();
      }
    } catch (reason) {
      setControlError(reason instanceof Error
        ? reason.message : "删除任务失败，请重试");
    } finally {
      setControlBusy("");
    }
  }

  const streamPeople = [
    ...(viewerDisplayName ? [{ username: viewerUsername, display_name: viewerDisplayName }] : []),
    ...reviewPeople.filter((person) => person.username !== viewerUsername),
  ];
  // 非决定态的收口块:失败原因与重跑、验证中卡在哪、等合入、子任务清单。
  // 它们是流的"最后一条",不是第二个面板。
  const streamTailVisible = ["failed", "canceled"].includes(task.status)
    || (!waiting && ["await_merge", "verifying", "coordinating"].includes(task.status))
    || Boolean(task.parent_task_id);
  const streamTail = streamTailVisible ? (
    <>
      {task.status === "failed" && (
        <>
          {task.detail && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>任务执行失败</AlertTitle>
              <AlertDescription>{task.detail}</AlertDescription>
            </Alert>
          )}
          {canOperate && !waiting && (
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => { setWorkspaceView("materials"); setMaterialView("diff"); }}>查看代码与未提交文件</Button>
                <Button size="sm" variant="outline" onClick={() => setRecoveryRequest(value => value + 1)}>补充处理要求</Button>
              </div>
              <p className="m-0 text-xs text-muted-foreground">可先核对文件，再说明哪些保留、哪些不交付，让 Agent 从当前现场处理；只有原因已解除时才按原流程重试。</p>
              <RetryButton taskId={task.id} onDone={onChanged} label="按原流程重试" allowFromStart />
              <DiagnosticsLink taskId={task.id} />
            </div>
          )}
        </>
      )}
      {task.status === "canceled" && (
        <div className="grid gap-1 text-[13px] text-muted-foreground">
          <strong className="text-sm font-medium text-text">任务已取消</strong>
          <span>执行已停止；此前产生的文档、代码和过程记录仍可查看。</span>
          {canOperate && <RetryButton taskId={task.id} onDone={onChanged} allowFromStart />}
        </div>
      )}
      {!waiting && (task.status === "await_merge" || task.status === "verifying" && task.delivery?.final_mr) && (
        <MergeWaitLine task={task} canOperate={canOperate} />
      )}
      {!waiting && task.status === "verifying" && !task.delivery?.final_mr && (
        <div aria-label="交付验证" className="grid gap-2 rounded-xl border border-line bg-surface p-4">
          <strong className="text-[15px] text-text-strong">{pipelineHumanFeedback.length ? "流水线待人工处理" : "交付验证进行中"}</strong>
          <div aria-label="验证反馈来源统计" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>代码检视 {codeReviewCount} 条</span><span>流水线与交付反馈 {machineFeedback.length} 条</span></div>
          {pipelineHumanFeedback.length ? <section aria-label="流水线人工处理" className="grid gap-3">
            <p className="m-0 text-sm text-text">以下 {pipelineHumanFeedback.length} 项需要你判断，流水线反馈与代码检视分别记录。</p>
            {pipelineHumanFeedback.map(item => <article key={item.id} className="grid min-w-0 gap-2 rounded-lg border border-attention/40 bg-attention/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{FEEDBACK_SOURCE_LABEL[item.source]}反馈</strong><Badge variant="warning">{feedbackStatusLabel(item)}</Badge></div>
              <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.summary}</p>
              {item.resolution && <div className="grid gap-1 border-l-2 border-l-attention/50 pl-2.5"><strong className="text-xs text-text-strong">Agent 的原因说明与处理建议</strong><p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.resolution}</p></div>}
            </article>)}
            <p className="m-0 text-xs text-muted-foreground">{canOperate ? "核对原因与建议，并通过补充处理要求告诉 Agent 采用哪种方案。" : <>请联系任务责任人 <PersonName account={task.luban_account} fallback="或协作者" /> 确认处理方案。</>}</p>
            <Button size="sm" variant="outline" className="w-fit" onClick={openPipelineFeedback}>查看流水线反馈</Button>
          </section> : task.delivery?.waiting_on ? (
            <p className="min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] break-words text-sm text-text">{task.delivery.waiting_on}</p>
          ) : (
            <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{task.detail || "流水线运行与自动修复由系统跟进；需要人时会在这里出卡。"}</p>
          )}
          {canOperate && repairStopped(task) && (
            <div className="grid gap-2">
              <Button size="sm" variant="outline" className="w-fit" onClick={() => setRecoveryRequest(value => value + 1)}>补充处理要求</Button>
              <RetryButton taskId={task.id} onDone={onChanged}
              label={task.delivery?.stalled && !task.delivery?.loop
                  && !task.delivery?.evidence_gap
                ? "重新尝试交付" : "按原流程重试"} />
            </div>
          )}
          {task.delivery?.stalled && <DiagnosticsLink taskId={task.id} />}
        </div>
      )}
      {!waiting && task.status === "coordinating" && (
        <div className="grid gap-2">
          <strong className="text-sm text-text-strong">{task.focus?.needs_attention ? "有子任务需要处理" : "子任务正在推进"}</strong>
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{task.detail ?? "剩余子任务完成或取消后，主任务会自动收口。"}</p>
          <div className="grid gap-1.5">{task.requirement_graph?.repositories.map((repository) => (
            <button type="button" key={repository.id}
              disabled={!repository.task_id || !onOpenTask}
              onClick={() => repository.task_id && onOpenTask?.(repository.task_id)}
              className="flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:cursor-default disabled:opacity-60 disabled:hover:border-line">
              <span className="grid min-w-0 gap-px">
                <strong className="truncate text-[13px] font-medium text-text-strong">{repository.name}</strong>
                <small className="truncate text-xs text-muted-foreground"><PersonName account={repository.assignee} fallback="未指定负责人" /></small>
              </span>
              <TaskStatusBadge status={repository.task_status ?? "queued"}>
                {statusText({ status: repository.task_status ?? "queued" })}
              </TaskStatusBadge>
            </button>
          ))}</div>
        </div>
      )}
    </>
  ) : undefined;

  const renderAnnotations = (selectedNotes: Annotation[], inline = false) => (
        <AnnotationPanel
          taskId={task.id}
          viewerUsername={viewerUsername}
          items={selectedNotes}
          checks={checks}
          closures={closures}
          reply={inline ? undefined : reply}
          canOperate={viewerUsername === (task.luban_account ?? "本地用户")}
          submission={annotationSubmission}
          taskStatus={task.status}
          overallStoryPublished={overallStoryPublished}
          reviewReady={workspaceReviewReady}
          reviewAnnotationIds={workspaceReviewAnnotationIds}
          filter={inline ? "all" : reviewFilter}
          focus={inline ? undefined : reviewFocus}
          people={[
            ...(viewerDisplayName ? [{
              username: viewerUsername, display_name: viewerDisplayName,
            }] : []),
            ...reviewPeople.filter((person) => person.username !== viewerUsername),
          ]}
          onLocate={locate}
          onShowThread={showThread}
          onChanged={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
        />
  );

  const reviewWorkspaceContent = (
    <div className="workspace-review-notes">
      <div aria-label="反馈来源统计" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>代码检视 {codeReviewCount} 条</span><span>流水线与交付反馈 {machineFeedback.length} 条</span>
      </div>
      {/* (#210)手搓 role=tablist 换 base-ui Tabs 原语(键盘箭头归原语);
          #227 换装:.review-filter 皮肤类退役,筛选档位改胶囊工具类
          (选中=墨底、等我确认有积压=attention 描边),语义与词表原样。 */}
      {reviewRecordCount > 0 && <Tabs value={reviewFilter} className="contents"
          onValueChange={(value) => setReviewFilter(value as ReviewFilter)}>
        <TabsList variant="line" aria-label="按处理归属筛选"
            className="h-auto w-full justify-start gap-1.5 bg-transparent p-0">
          {([
            ["all", "全部"],
            ["mine", "等我确认"],
            ["agent", "待处理／核验"],
            ["closed", "已完成"],
          ] as const).map(([key, label]) => (
            <TabsTrigger key={key} value={key}
              className={cn("h-auto flex-none gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium after:hidden",
                reviewFilter === key
                  ? "border-ink bg-accent-soft text-ink hover:text-ink"
                  : "border-line text-muted-foreground",
                key === "mine" && reviewCounts.mine > 0
                  && "border-attention/60 text-attention")}>
              {label}<i className="inline-grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 font-mono text-[11px] not-italic tabular-nums">{reviewCounts[key]}</i>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>}
      {reviewAssignment?.status === "pending" && !isReviewTaskEnded(task.status) && (
        <section aria-labelledby="review-assignment-title"
          className="grid gap-2.5 rounded-xl border border-ink/30 bg-surface p-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
          <div aria-hidden className="grid size-9 place-items-center rounded-full bg-surface-3 text-sm font-bold text-ink">审</div>
          <div className="grid min-w-0 gap-1">
            <span className="font-mono text-xs font-bold tracking-wide text-ink">COMMITTER REVIEW</span>
            <strong id="review-assignment-title" className="text-sm text-text-strong">
              {reviewPeople.find((person) =>
                person.username === reviewAssignment.requester)
                ?.display_name ?? reviewAssignment.requester} 邀请你检视
            </strong>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">看完材料并留下必要批注后即可完成；这不会代替任务责任人提交决定。</p>
            {completeError && <small className="text-xs text-danger">
              {completeError}
            </small>}
          </div>
          <Button type="button" size="sm" disabled={completeBusy}
            onClick={() => void finishReview()}>
            {completeBusy ? "正在完成…" : "完成检视"}
          </Button>
        </section>
      )}
      <section className="workspace-review-opinions" aria-label="检视意见">
        {renderAnnotations(notes)}
        {!notes.length && (
          <div className="px-1 py-1 text-[13px] text-muted-foreground">
            在原文、产出文档或代码上圈选，即可原位写下反馈。
          </div>
        )}
        {filteredMr.length > 0 && <FeedbackList kicker="CODEHUB REVIEW" title="CodeHub 代码检视"
          hint="来自检视人的代码意见；处理状态由对应检视记录决定，与流水线验证分别记录。"
          items={filteredMr} mrUrl={task.delivery?.mr_url} />}
        {filteredMachine.length > 0 && <FeedbackList
          kicker="AUTOMATED GATES"
          title="流水线与交付反馈"
          hint="流水线失败、自动修复、合并冲突和推送前复检分别保留原因及处理结果。需要人工判断的条目请先核对建议并补充处理要求，是否通过仍以实际核验为准。"
          items={filteredMachine} />}
      </section>
    </div>
  );

  return (
    <main
      className={`workspace-overlay task-workspace-v2 workspace-studio${demo ? " task-demo-mode" : ""}${materialsFullscreen
        ? " materials-fullscreen" : ""}`}
      ref={workspaceRoot}
      aria-label={`任务工作台：${task.title ?? task.requirement}`}
      style={sideWidth ? { ["--ws-side-w" as string]: `${sideWidth}px` } as CSSProperties : undefined}
    >
      {demoOpen && canPresent && !demo && <TaskDemoFrame taskId={task.id} onClose={() => setDemoOpen(false)} />}
      {demo && <div className="task-demo-bar">
        <div><strong>{demo.preview ? "演示预览 · 示例数据" : "演示副本"}</strong><span>以需求 owner 身份体验 · 操作仅保留在本次演示</span></div>
        <div><span title={demo.sourceLabel}>原任务 {demo.sourceTaskId} · {demo.sourceStatus}</span>
          <Button variant="ghost" size="sm" onClick={() => { demoPhaseOpened.current = ""; demo.onReset(); }}>重置演示</Button>
          <Button variant="outline" size="sm" onClick={demo.onExit}>退出演示</Button></div>
      </div>}
      <header className="ws-head" ref={headRef}>
        <Button type="button" variant="outline" size="sm"
          className="ws-back-button gap-1 bg-surface-2 hover:border-ink hover:bg-surface-2 hover:text-ink"
          aria-label={demo?.backLabel ?? "返回列表"} onClick={onClose} autoFocus>
          <svg viewBox="0 0 20 20" aria-hidden className="size-3.5"><path d="m12.5 5-5 5 5 5" /></svg>
          <span>{demo?.backLabel ?? "返回列表"}</span>
        </Button>
        <div className="ws-identity">
          {task.ticket && <Badge variant="outline" className="font-mono tracking-wide">{task.ticket}</Badge>}
          <strong id="task-workspace-title" title={task.title ?? task.requirement}
            className="min-w-0 truncate text-[15px] leading-tight font-semibold tracking-tight text-text-strong">
            {task.title ?? task.requirement}
          </strong>
          <div className="ws-identity-line">
            <code title={demo ? "演示阶段与原任务实际进度分开" : "平台内部编号"}>{demo ? `正在讲解：${demoPhaseTitle(demo.phase)}` : task.id}</code>
            {!task.parent_task_id && <RequirementBusinessModule task={task} onChanged={onChanged} />}
            {/* 身份行徽标:#216 收编为 Badge;≤640px 沿用原 .pill 窄屏
                行为(收成一颗放大的点,文字隐藏)。 */}
            <TaskStatusBadge status={task.status}
              className="text-sm max-[640px]:gap-0 max-[640px]:px-1"
              dotClassName="max-[640px]:size-2"
              textClassName="max-[640px]:hidden">
              {statusText(task)}
            </TaskStatusBadge>
            <Button type="button" variant="outline" size="sm"
              className="gap-1"
              aria-haspopup="dialog"
              onClick={() => setTaskInspector("details")}>任务详情 <span aria-hidden>↗</span></Button>
            <WaitBadge task={task} personal={canOperate} className="max-[900px]:hidden" />
            {canOperate && !task.requirement_graph && !["completed", "canceled"].includes(task.status)
              && <RefreshMrButton key={task.id} taskId={task.id} onChanged={onChanged} />}
            <PrepushBadge task={task} canOperate={canOperate && !task.delivery?.final_mr}
              onChanged={onChanged} />
          </div>
          {task.parent_task_id && <Button type="button" variant="outline" size="sm"
            className="h-[26px] w-fit gap-1.5 rounded-full border-line px-2 text-xs text-muted-foreground hover:bg-background hover:text-text-strong"
            onClick={() => onOpenTask?.(task.parent_task_id!)}>
            <span>返回主任务</span>
            <strong className="max-w-[200px] truncate font-medium">{task.parent_task?.title ?? "跨仓大任务"}</strong>
          </Button>}
        </div>
        <div className={`ws-progress${task.progress ? "" : " is-fallback"}`
          + `${health?.needs_attention ? " attention" : ""}`
          + `${task.status === "completed" ? " is-done" : task.status === "failed" ? " is-failed" : ""}`}>
          {/* 阶段名可点:当前阶段弹内核编译的活方案,其他阶段弹标准
              方案底版(用户拍板:方案入口收进进度条,执行页签让位给
              SSE 现场)。需求受理/DTS 等云端词表任务的阶段名与内核
              六阶段完全不同,弹出来必然落底版兜底属误导(审计 P0-3)
              ——这些任务不提供弹层。 */}
          {/* 刻度旁只放阶段名:步骤说明已经是主画布的标题,这里再写一遍
              会把 44px 的视图条撑成一行长文。 */}
          <TaskProgress progress={demo ? { ...visibleProgress,
            phases: visibleProgress.phases.map(demoPhaseTitle), current_phase: demoPhaseTitle(visibleProgress.current_phase) } : visibleProgress} showDetailedStep={false} status={task.status}
            preparation={!demo && <WarmupBadge task={task} onOpen={() => setWarmupOpen(true)} />}
            onPhaseClick={demo ? (phase) => { demoPhaseOpened.current = ""; demo.onSelectPhase(visibleProgress.phases.find(item => demoPhaseTitle(item) === phase) ?? phase); }
              : task.execution_plan || task.workflow_profile ? setPlanPhase : undefined}
            context={demo ? <span><i>正在讲解</i>{demoPhaseTitle(demo.phase)} · 点击阶段切换</span> : health && <>
            <span title={health.next}><i>下一步</i>{health.next}</span>
            <span><i>责任</i>{health.actor}</span>
            <span title={health.last_progress_at}><i>更新</i>
              {relativeTime(health.last_progress_at) || "暂无记录"}</span>
          </>} />
          {!demo && planPhase && <StagePlanDialog
            phase={planPhase}
            currentPhase={visibleProgress.current_phase}
            plan={task.execution_plan}
            planWarning={task.workflow_profile_warning}
            profile={task.workflow_profile}
            onSuggest={onExecutionPlanFeedback}
            onClose={() => setPlanPhase("")} />}
        </div>
        {(controllable || deletable || canRequestReview || onOpenFeedbackWall || canPresent || demoCompleted) && (
          <div className="ws-head-controls" aria-label="任务控制">
            {demoCompleted && <a className="task-demo-delivery-analysis" href={deliveryAnalysisHref}
              target="_blank" rel="noopener noreferrer" title="查看本次交付分析，复盘返工并改进流程与知识（新窗口）">
              <BarChart3Icon aria-hidden /><span>交付分析</span><ArrowUpRightIcon aria-hidden />
            </a>}
            {canPresent && !demo && <Button type="button" variant="outline" size="sm"
              onClick={() => setDemoOpen(true)}>演示模式</Button>}
            {/* #227 换装:头部控制钮换 shadcn Button(恢复/暂停=outline、
                取消=ghost、删除=destructive、邀请=outline sm),确认态
                是一枚危险软底胶囊;原 .ws-head-controls 按钮皮不再依赖。 */}
            {canRequestReview && !task.delivery?.final_mr && !isReviewTaskEnded(task.status) && <Button type="button" variant="outline" size="sm"
              aria-haspopup="dialog" aria-expanded={reviewInviteOpen}
              title="选择 Committer 参与代码检视"
              onClick={() => setReviewInviteOpen(true)}>邀请他人检视</Button>}
            {onOpenFeedbackWall && <QuickWishButton inline onOpenWall={onOpenFeedbackWall} />}
            {controllable && !task.delivery?.final_mr && (task.status === "await_merge" ? null : task.status === "paused" ? (
              <Button type="button" disabled={!!controlBusy}
                title="沿用当前工作区和流程进度继续执行"
                onClick={() => void runControl("resume")}>
                {controlBusy === "resume" ? "恢复中…" : "恢复"}
              </Button>
            ) : task.status === "pausing" ? (
              <Button type="button" variant="outline" disabled title="正在停止当前会话，随后暂停">
                正在暂停
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={!!controlBusy}
                title={task.status === "verifying"
                  ? "停止平台跟踪；外部流水线仍会继续" : "立即停止当前会话并暂停"}
                onClick={() => void runControl("pause")}>
                {controlBusy === "pause" ? "暂停中…" : "暂停"}
              </Button>
            ))}
            {controllable && (!cancelArmed ? (
              <Button type="button" variant="ghost" disabled={!!controlBusy}
                title="取消后不可恢复，已有文件和记录仍会保留"
                onClick={() => setCancelArmed(true)}>取消</Button>
            ) : (
              <div className="inline-flex h-8 items-center gap-1 rounded-lg border border-danger/40 bg-danger-soft pr-1 pl-2.5">
                <span className="mr-1 text-xs font-medium whitespace-nowrap text-danger">取消后不可恢复</span>
                <Button type="button" variant="destructive" size="xs" disabled={!!controlBusy}
                  onClick={() => void runControl("cancel")}>
                  {controlBusy === "cancel" ? "取消中…" : "确认"}
                </Button>
                <Button type="button" variant="ghost" size="xs" disabled={!!controlBusy}
                  onClick={() => setCancelArmed(false)}>返回</Button>
              </div>
            ))}
            {deletable && (!deleteArmed ? (
              <Button type="button" variant="destructive" disabled={!!controlBusy}
                title="永久删除工作区、事件、批注与历史记录"
                onClick={() => setDeleteArmed(true)}>删除任务</Button>
            ) : (
              <div className="inline-flex h-8 items-center gap-1 rounded-lg border border-danger/40 bg-danger-soft pr-1 pl-2.5">
                <span className="mr-1 text-xs font-medium whitespace-nowrap text-danger">工作区和记录将永久删除</span>
                <Button type="button" variant="destructive" size="xs" disabled={!!controlBusy}
                  onClick={() => void deleteTask()}>
                  {controlBusy === "delete" ? "删除中…" : "确认删除"}
                </Button>
                <Button type="button" variant="ghost" size="xs" disabled={!!controlBusy}
                  onClick={() => setDeleteArmed(false)}>返回</Button>
              </div>
            ))}
          </div>
        )}
      </header>
      {demo && <TaskDemoGuide phase={demo.phase} decomposition={demoAnalysis} />}
      <TaskContinueDelivery key={task.id} task={task}
        canOperate={canOperate && (!canOverride || !!demo) && viewerUsername === (task.luban_account ?? "本地用户")} onChanged={onChanged} />

      {taskInspector && <TaskInspector task={task} canOperate={canOperate} onChanged={onChanged} kind={taskInspector} onClose={() => setTaskInspector(undefined)}
        onInspect={setTaskInspector} onOpenProcess={() => { setTaskInspector(undefined); selectWorkspaceView("execution"); }} />}
      {warmupOpen && <OverlayDialog ariaLabel="开工前编译详情" title="开工前编译与准备状态" onClose={() => setWarmupOpen(false)}>
        <WarmupPanel task={task} />
      </OverlayDialog>}

      {task.feedback_error && (
        <section role="alert" className="flex-none border-b border-line bg-surface-2 px-(--ws-gutter) py-2.5">
          <h3 className="m-0 text-sm font-semibold">持续检视明细暂不可用</h3>
          <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{task.feedback_error}</p>
        </section>
      )}
      {/* 主区两栏(参照 Devin / Codex / Jules 的会话页):左边是"对话与决定"
          ——状态、决定卡、给 Agent 的输入框;右边是"工作区"——需求、文档、
          代码、活动的页签阅读器,批注检查器停靠在它右缘。上两版的左导航、
          三视图页签、"决定前建议核对"预览都是中间层,用户实锤"都是些啥,
          平铺在这""力度不够",这次去掉。 */}
      <div className="ws-body" ref={bodyRef}>
        <section className="ws-evidence" aria-label="工作区">
          <div className="ws-pane-head" aria-label="任务工作台视图">
            <div>
              <strong>{materialHeading.title}</strong>
            </div>
            <div className="ws-material-toolbar">
              {/* (#210)手搓 role=tablist 换 base-ui Tabs 原语(键盘箭头、
                  roving tabindex 归原语)。选中值由 materialView/
                  workspaceView 派生(与原 aria-selected 判据一致);切换
                  回调逐键对应原 onClick(开材料/设活动文档/切视图);
                  .ws-source-switch 皮肤类原样挂在 TabsList 上。纯页签条
                  转换:面板仍是下方按 materialView/workspaceView 的条件
                  渲染块(挂载/卸载语义原样)。 */}
              <Tabs className="contents"
                  value={workspaceView === "knowledge" ? "knowledge"
                    : workspaceView === "execution" ? "execution"
                    : materialView === "chain" && demoShowsDecomposition ? "demo-decomposition" : materialView}
                  onValueChange={(value) => {
                    if (value === "doc") { openMaterial("doc"); if (primaryDocument) setActive(primaryDocument.name); }
                    else if (value === "source") openMaterial("source");
                    else if (value === "demo-decomposition") openDemoDecomposition();
                    else if (value === "chain") openMaterial("chain");
                    else if (value === "diff") { openMaterial("diff"); if (changes[0]) setActive(changes[0].name); }
                    else if (value === "knowledge") selectWorkspaceView("knowledge");
                    else if (value === "execution") selectWorkspaceView("execution");
                  }}>
                <TabsList variant="line" aria-label="工作区内容"
                    className="ws-source-switch h-auto justify-start">
                  {task.parent_task_id ? <>
                    {/* 子任务的文档树里任务书只是默认选中的第一份(还有整体拆分方案、
                        spec/decisions/grill……),页签名得说整体,不能拿其中一项当名字
                        (2026-09-06 实战用户实锤"这里不应该叫当前任务书")。 */}
                    <TabsTrigger value="doc" className={`h-auto flex-none${materialTabOn("doc") ? " on" : ""}`}>
                      <span>文档</span><i>{documents.length}</i>
                    </TabsTrigger>
                    <TabsTrigger value="source" className={`h-auto flex-none${materialTabOn("source") ? " on" : ""}`}>
                      <span>原始需求</span>
                    </TabsTrigger>
                  </> : <>
                    <TabsTrigger value="source" className={`h-auto flex-none${materialTabOn("source") ? " on" : ""}`}>
                      <span>当前需求</span>
                    </TabsTrigger>
                    <TabsTrigger value="doc" className={`h-auto flex-none${materialTabOn("doc") ? " on" : ""}`}>
                      <span>产出文档</span><i>{documents.length}</i>
                    </TabsTrigger>
                  </>}
                  {demoHasDecomposition && <TabsTrigger value="demo-decomposition"
                    className={`h-auto flex-none task-demo-artifact${materialTabOn("chain") && demoShowsDecomposition ? " on" : ""}`}>
                    <span>需求拆分</span>
                  </TabsTrigger>}
                  {(hasRequirementGraph || hasArchitectureStory) && <TabsTrigger value="chain"
                    className={`h-auto flex-none${materialTabOn("chain") && !demoShowsDecomposition ? " on" : ""}${demo?.phase === "写设计" ? " task-demo-artifact" : ""}`}>
                    <span>架构图</span>
                  </TabsTrigger>}
                  <TabsTrigger value="diff"
                    className={`h-auto flex-none${materialTabOn("diff") ? " on" : ""}${demo?.phase === TASK_DEMO_BUILD_PHASE ? " task-demo-artifact" : ""}`}
                    title={untrackedDirectoryCount
                      ? `${changeFileCount} 个文件，另有 ${untrackedDirectoryCount} 个未跟踪目录`
                      : `${changeFileCount} 个文件`}
                    disabled={!changeFileCount && !untrackedDirectoryCount}>
                    <span>代码改动</span>{Boolean(changeFileCount || untrackedDirectoryCount) && <i>{changeFileCount}{untrackedDirectoryCount
                      ? ` + ${untrackedDirectoryCount}目录` : ""}</i>}
                  </TabsTrigger>
                  <TabsTrigger value="knowledge"
                    className={`h-auto flex-none${workspaceView === "knowledge" ? " on" : ""}${demoCompleted ? " task-demo-artifact" : ""}`}>
                    <span>用到的知识</span>{Boolean(task.knowledge_usage?.resources.length) && <i>{task.knowledge_usage!.resources.length}</i>}
                  </TabsTrigger>
                  <TabsTrigger value="execution"
                    className={`ws-activity-tab h-auto flex-none${
                      workspaceView === "execution" ? " on" : ""}`}
                    title={`查看 Agent 的进展、决定与验证结果（${viewShortcutHint("execution")}）`}>
                    <span>工作过程</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="ws-material-tools" role="group" aria-label="阅读与检视工具">
                {materialTabOn("doc") && <DeliveryReportMenu key={task.id} task={task} canOperate={canOperate} onChanged={onChanged}
                  available={artifactTask.current === task.id && !!items?.some(item => item.name === "task-materials/交付报告.md")}
                  onOpen={() => { openMaterial("doc"); setActive("task-materials/交付报告.md"); }} />}
                {materialView === "diff" && <a className="materials-fullscreen-toggle" href={deliveryAnalysisHref} target="_blank" rel="noopener noreferrer">交付分析 ↗</a>}
                <button type="button"
                  className={`ws-review-launch${reviewPanelOpen ? " on" : ""}`}
                  aria-label="检视意见" aria-expanded={reviewPanelOpen} aria-controls="ws-review-canvas"
                  title={`查看意见、Agent 回应并复检（${REVIEW_SHORTCUT}）`}
                  onClick={() => {
                    setReviewPanelOpen((open) => !open);
                    setReviewRevealRequest((request) => request + 1);
                  }}>
                  <svg viewBox="0 0 20 20" aria-hidden><path d="M4 3.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-5 3v-3H3v-9a1 1 0 0 1 1-1Z" /><path d="M6.5 7h7M6.5 10h4" /></svg>
                  <span className="ws-review-label">检视意见</span>
                  {Boolean(reviewCounts.mine || reviewRecordCount) && <em>{reviewCounts.mine || reviewRecordCount}</em>}
                </button>
                {workspaceView !== "execution" && <button type="button" className="materials-fullscreen-toggle"
                  aria-pressed={materialsFullscreen}
                  title={materialsFullscreen ? "返回检视与决定同屏" : "让当前交付材料占满工作台"}
                  onClick={() => setMaterialsFullscreen((current) => !current)}>
                  <svg viewBox="0 0 20 20" aria-hidden>{materialsFullscreen
                    ? <path d="M7 3v4H3M13 3v4h4M7 17v-4H3M13 17v-4h4" />
                    : <path d="M7 3H3v4M13 3h4v4M3 13v4h4M17 13v4h-4" />}</svg>
                  <span>{materialsFullscreen ? "退出全屏" : "全屏查看"}</span>
                </button>}
                {materialView !== "chain" && workspaceView !== "execution" && workspaceView !== "knowledge" && <button type="button"
                  className={`material-search-toggle${materialSearchOpen ? " on" : ""}`}
                  aria-expanded={materialSearchOpen}
                  title="只搜索当前打开的这份内容"
                  onClick={toggleMaterialSearch}>
                  <svg viewBox="0 0 20 20" aria-hidden><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></svg><span>搜索</span>
                </button>}
              </div>
            </div>
          </div>
          <div className="ws-material-stage">
          <ResizableReviewPane open={reviewPanelOpen}>
            <header className="ws-view-intro">
              <div><h2>检视意见</h2><p>对照材料查看意见和回应，点击位置即可定位。</p></div>
              <button type="button" aria-label="收起检视意见" onClick={() => setReviewPanelOpen(false)}>×</button>
            </header>
            {reviewWorkspaceContent}
          </ResizableReviewPane>
          <div className="ws-material-content">
          {workspaceView === "knowledge" ? (
            <div className="ws-primary-scroll ws-knowledge-view">
              <KnowledgeFootprint usage={task.knowledge_usage} utMethod={task.ut_generation_method}
                taskId={task.id} taskStatus={task.status}
                canSyncSkills={viewerUsername === (task.luban_account ?? "本地用户")} onChanged={onChanged} />
            </div>
          ) : workspaceView === "execution" ? (
            <div className="ws-primary-scroll ws-execution-view">
              <TaskJourney task={task} onLogs={() => setTaskInspector("logs")}
                onTiming={() => setTaskInspector("timing")}
                />
            </div>
          ) : <>
          {materialSearchOpen && materialView !== "chain" && (
            <div className="flex min-h-11 flex-none items-center gap-2 border-b border-line bg-surface-2 px-5 py-1.5" role="search">
              <span aria-hidden className="text-[17px] leading-none text-muted-foreground">⌕</span>
              <Input ref={materialSearchInput}
                className="min-w-45"
                value={materialSearchQuery}
                aria-label="搜索当前内容"
                placeholder={materialView === "diff"
                  ? "搜索当前代码变更"
                  : materialView === "source"
                    ? "搜索当前需求"
                    : `搜索 ${activeMeta?.label ?? "当前文档"}`}
                onChange={(event) => setMaterialSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    moveMaterialSearch(event.shiftKey ? -1 : 1);
                  }
                }} />
              <span aria-live="polite"
                className={cn("w-16 shrink-0 text-center text-xs tabular-nums",
                  materialSearchQuery.trim() && !materialSearchCount ? "text-danger" : "text-muted-foreground")}>
                {!materialSearchQuery.trim() ? "输入关键词"
                  : materialSearchCount
                    ? `${materialSearchIndex + 1} / ${materialSearchCount}`
                    : "没有找到"}
              </span>
              <Button type="button" variant="outline" size="icon-sm" title="上一处（Shift + Enter）"
                aria-label="上一个搜索结果" disabled={!materialSearchCount}
                onClick={() => moveMaterialSearch(-1)}>↑</Button>
              <Button type="button" variant="outline" size="icon-sm" title="下一处（Enter）"
                aria-label="下一个搜索结果" disabled={!materialSearchCount}
                onClick={() => moveMaterialSearch(1)}>↓</Button>
              <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground"
                aria-label="关闭搜索" onClick={toggleMaterialSearch}>×</Button>
            </div>
          )}
          {evidenceGapActionable && evidenceGapArtifact && (
            <section role="status"
              className="flex flex-none flex-wrap items-center justify-between gap-4 border-b border-line bg-attention-soft px-5 py-3">
              <div className="grid gap-0.5">
                <span className="text-xs font-medium text-attention">流水线需要补充原文</span>
                <strong className="text-sm text-text-strong">打开《流水线证据缺口》，圈选说明并粘贴平台报错</strong>
                <p className="m-0 text-[13px] text-muted-foreground">保存批注后会自动记入待处理反馈，点击“贴回报错”即可让 Agent 继续。</p>
              </div>
              <Button type="button" size="sm"
                variant={active === evidenceGapArtifact.name
                    && materialView === "doc" ? "secondary" : "default"}
                onClick={() => {
                  setMaterialView("doc");
                  setActive(evidenceGapArtifact.name);
                }}>
                {active === evidenceGapArtifact.name && materialView === "doc"
                  ? "正在查看" : "打开材料"}
              </Button>
            </section>
          )}
          {materialView === "doc" && active === OVERALL_STORY_ARTIFACT && !task.parent_task_id
            && overallStoryPublished && (
            <OverallStoryTools key={task.id} taskId={task.id} canOperate={canOperate} fileName={architectureStory?.label}
              canceled={task.status === "canceled"} onOpenTask={onOpenTask}
              onUpdated={() => { setLivePulse((tick) => tick + 1); setNotesPulse((tick) => tick + 1); }} />
          )}
          <div className={`ws-material-reader${materialView === "doc" && documents.length > 0 ? " with-documents" : ""}`}>
          {materialView === "doc" && documents.length > 0 && (
            <div className="ws-tabs ws-document-tabs">
              {documents.map((item) => (
                <button key={item.name} className={"ws-tab" + (item.name === active ? " on" : "")
                  + (demo && demoContent?.artifactPatterns.some(pattern => pattern.test(item.name)) ? " task-demo-artifact" : "")}
                  onClick={() => setActive(item.name)}>
                  <span>{item.label}</span><i>{item.purpose === "delivery_unit_brief"
                    ? "主任务书" : item.purpose === "delivery_plan"
                      ? "参考" : sizeText(item.bytes)}</i>
                </button>
              ))}
              <Button type="button" variant="outline" size="sm" className="my-auto ml-auto"
                disabled={documentsDownloading}
                title={`下载全部 ${documents.length} 份产出文档(完整原文件)`}
                onClick={() => void downloadDocuments()}>
                <span aria-hidden>⇩</span>
                {documentsDownloading ? "打包中…" : "打包下载"}
              </Button>
            </div>
          )}
          {documentsDownloadError && <div className="utility-note" role="alert">
            打包下载失败：{documentsDownloadError}
          </div>}
          <div className={`ws-doc${materialView === "diff" ? " is-diff" : materialView === "chain" ? " is-chain" : ""}${demoReportOpen ? " task-demo-report-highlight" : ""}`}
            data-artifact={materialView === "source" ? TASK_REQUIREMENT_ARTIFACT
              : materialView === "chain" ? REQUIREMENT_GRAPH_ARTIFACT : active}
            data-loading={materialView !== "source" && loading ? "true" : "false"}>
            {locationNotice && (
              <div className="annotation-location-notice" role="status">
                <div><strong>{moduleLocation || moduleLocationRetry ? "设计定位" : "批注定位"}</strong><span>{locationNotice}</span></div>
                {moduleLocationRetry && <button className="module-location-retry" type="button" onClick={() => openModuleStory(moduleLocationRetry)}>重试定位</button>}
                <button type="button" aria-label="关闭定位提示"
                  onClick={() => setLocationNotice("")}>×</button>
              </div>
            )}
            {locationNotice && locationExcerpt && !moduleLocation && !moduleLocationRetry && <AnnotationExcerpt item={locationExcerpt} onOpen={() => { setLocationNotice(""); setLocationExcerpt(undefined); }} />}
            {materialView === "source" ? (
              <>
              {!!task.requirement_document?.sources?.length && <section aria-label="需求原始文件" className="mb-4 rounded-lg border border-line bg-surface-2 p-3 text-sm">
                <strong>{task.requirement_document.sources.length} 份原始文件</strong>
                <p className="mt-1 text-xs text-muted-foreground">全部资料共同构成下方当前需求；批注修改保留在当前需求中，原文件可下载核对。</p>
                <ul className="mt-2 grid gap-1.5">
                  {task.requirement_document.sources.map(source => <li key={source.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-all">{source.name}{source.document_count && source.document_count > 1 ? ` · ${source.document_count} 份文档` : ""}</span>
                    <a className="shrink-0 text-primary underline" download={source.name}
                      href={`/tasks/${encodeURIComponent(task.id)}/requirement-sources?path=${encodeURIComponent(source.path)}`}
                      aria-label={`下载原文件 ${source.name}`}>下载原文件</a>
                  </li>)}
                </ul>
                {!!task.requirement_document.warnings?.length && <details className="mt-2 text-amber-700">
                  <summary>解析提醒（{task.requirement_document.warnings.length}）</summary>
                  <ul>{task.requirement_document.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                </details>}
              </section>}
              <Annotatable
                taskId={task.id}
                artifact={TASK_REQUIREMENT_ARTIFACT}
                fallbackFile="需求原文"
                kind="doc"
                items={locatableNotes}
                enabled={canContributeReview && canCreateAnnotation}
                onAdded={() => setNotesPulse((tick) => tick + 1)}
                onOpenAnnotations={openAnnotationReview}
                renderInlineReview={(ids) => renderAnnotations(notes.filter((note) => ids.includes(note.id)), true)}
              >
                <article className="requirement-source">
                  <div className="mb-5 border-b border-line pb-2.5 text-xs text-muted-foreground">
                    <span className="font-medium text-text">{task.requirement_document?.bundle_name
                      ?? task.requirement_document?.name
                      ?? "用户提交的完整内容"}
                      {task.requirement_document?.context_mode === "file"
                        && <em className="ml-1.5 rounded-full bg-surface-3 px-1.5 py-px not-italic text-muted-foreground">Agent 分段读取</em>}</span>
                    <small className="block">{task.requirement.split(/\r?\n/).length} 行 · {task.requirement.length} 字符</small>
                  </div>
                  {/* 上一轮修改被拒收或失败时,原来只有 API 里有原因,页面上人
                      只看到"文档没变"——这里把原因摆在正文上方。 */}
                  {task.requirement_revision?.state === "failed" && (
                    <div role="alert"
                      className="mb-3 grid gap-1 rounded-lg border border-danger/40 border-l-[3px] border-l-danger bg-danger-soft p-3 text-[13px] leading-relaxed">
                      <strong className="text-danger">上一轮修改没有生效</strong>
                      <span className="break-words text-text">{task.requirement_revision.error ?? "Agent 没有给出原因"}</span>
                      <small className="text-muted-foreground">意见仍在待提交，修正后可以重新提交</small>
                    </div>
                  )}
                  {/* Agent 每改一轮都留了改前全文和 diff。复检的人原来只能靠
                      锚点猜"改了什么",要真核对得把整篇重读——这里直接给对比。 */}
                  {(task.requirement_revisions?.length ?? 0) > 0 && (() => {
                    const revisions = task.requirement_revisions!;
                    const latest = revisions[revisions.length - 1];
                    const showing = revisionDiff?.id === latest.id;
                    return (
                      <div role="status"
                        className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
                        <span className="inline-flex flex-wrap items-center gap-1.5 text-text">
                          Agent 已修改 {revisions.length} 轮 · 最近一轮
                          <b className="font-mono font-bold text-success">+{latest.additions}</b>
                          <b className="font-mono font-bold text-danger">-{latest.deletions}</b>
                          <small className="text-muted-foreground">{relativeTime(latest.at)}</small>
                        </span>
                        <Button type="button" size="xs"
                          variant={showing ? "secondary" : "outline"}
                          onClick={() => {
                            if (showing) { setRevisionDiff(null); return; }
                            setRevisionDiff({ id: latest.id, text: "" });
                            void readRequirementRevision(task.id, latest.id)
                              .then((result) => setRevisionDiff({
                                id: latest.id,
                                text: result.diff ?? "",
                                unavailable: result.unavailable,
                              }));
                          }}>
                          {showing ? "回到全文" : "看这一轮改了什么"}
                        </Button>
                      </div>
                    );
                  })()}
                  {revisionDiff ? (
                    revisionDiff.unavailable
                      ? <p className="requirement-revision-missing">{revisionDiff.unavailable}</p>
                      : revisionDiff.text
                        ? <RequirementDiff text={revisionDiff.text} />
                        : <p className="requirement-revision-missing">正在读取对比…</p>
                  ) : (
                    <Markdown showLineNumbers text={task.requirement} resolveImage={(path) =>
                      task.requirement_document?.assets?.some(
                        (asset) => asset.path === path)
                        ? resolveTaskDemoAsset(task.id, path) ?? `/tasks/${encodeURIComponent(task.id)}/requirement-asset?path=${encodeURIComponent(path)}`
                        : undefined} />
                  )}
                </article>
              </Annotatable>
              </>
            ) : materialView === "chain" ? (
              demoShowsDecomposition ? (
                <section className="task-demo-decomposition" aria-label="需求拆分关系">
                  <RequirementGraph task={task} onOpenTask={onOpenTask} annotations={notes}
                    annotationEnabled={canContributeReview && canCreateAnnotation}
                    onAnnotationAdded={() => setNotesPulse(tick => tick + 1)} />
                </section>
              ) :
              // flush:chain 态贴边豁免——去 padding、交出滚动,ws-doc 唯一滚动层(#253)。
              <StoryArchitecture key={task.id} taskId={task.id} canUpdate={canOperate} flush requestedLine={architectureLine}
                onAnnotate={canContributeReview && canCreateAnnotation && architectureStoryName ? async (note) => {
                  const result = await addAnnotation(task.id, {
                    artifact: architectureStoryName, file: architectureStory?.label ?? architectureStoryName,
                    line: 0, anchor: "架构设计整体意见（针对全文，不定位到某一行）", kind: "doc", route: "agent",
                    note: `对架构设计的整体批注：${note}\n\n请根据意见修改 Story，并同步更新架构图与模块职责说明。`,
                  });
                  if (result.error) throw new Error(result.error);
                  setNotesPulse(tick => tick + 1);
                  if (result.annotation) openAnnotationReview([result.annotation.id]);
                } : undefined}
                onOpenView={(id) => openModuleStory(`view:${id}`)} onOpenStory={() => {
                openMaterial("doc"); if (architectureStoryName) setActive(architectureStoryName);
              }} />
            ) : <>
              {materialView === "diff" && pushReview && (
                <div aria-label="代码检视范围"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-5 py-3">
                  {pushReview.has_focused_changes ? <>
                    <Button type="button" variant="outline"
                      className={cn("h-8 min-w-0 gap-1.5 rounded-full px-3 text-left",
                        diffScope === "changes"
                          ? "border-ink bg-ink text-ink-fg hover:bg-ink hover:text-ink-fg"
                          : "border-line-strong bg-surface text-text hover:border-text-strong hover:bg-surface")}
                      onClick={() => {
                        if (diffScope === "changes") return;
                        setContent("");
                        setPushDiffState({ kind: "checking" });
                        setDiffScope("changes");
                      }}>
                      <strong className="text-[13px] font-medium">这次改的</strong>
                      <span className={cn("text-xs", diffScope === "changes" ? "opacity-75" : "text-muted-foreground")}>{pushReview.title}</span>
                    </Button>
                    <Button type="button" variant="outline"
                      className={cn("h-8 min-w-0 gap-1.5 rounded-full px-3 text-left",
                        diffScope === "full"
                          ? "border-ink bg-ink text-ink-fg hover:bg-ink hover:text-ink-fg"
                          : "border-line-strong bg-surface text-text hover:border-text-strong hover:bg-surface")}
                      onClick={() => {
                        if (diffScope === "full") return;
                        setContent("");
                        setPushDiffState({ kind: "checking" });
                        setDiffScope("full");
                      }}>
                      <strong className="text-[13px] font-medium">全部改动</strong>
                      <span className={cn("text-xs", diffScope === "full" ? "opacity-75" : "text-muted-foreground")}>从任务起点到当前代码</span>
                    </Button>
                  </> : (
                    // 只有一个范围时不是"可切换":按钮外观点了没反应,
                    // 用户会当成坏了(MFC-035)。老实渲染成状态标签。
                    <div role="note"
                      className="inline-flex h-8 min-w-0 cursor-default items-center gap-1.5 rounded-full border border-ink bg-ink px-3 text-ink-fg">
                      <strong className="text-[13px] font-medium">全部改动</strong>
                      <span className="text-xs opacity-75">从任务起点到当前代码;本轮没有可单看的增量修改</span>
                    </div>
                  )}
                  <p className="m-0 min-w-[240px] flex-1 text-[13px] text-muted-foreground">{diffScope === "changes"
                    ? "这里只看这次处理产生的变化；浏览代码不会发起推送或要求再次确认。"
                    : approvalReview ? "这里查看完整交付改动；需要调整文件时，直接在右侧回复中说明。" : "这里查看任务的全部改动，包括尚未提交的工作区修改。"}</p>
                </div>
              )}
              {unavailable && <div className="utility-note">{unavailable}</div>}
              {!unavailable && !items && <div className="utility-note">正在读取现场…</div>}
              {items?.length === 0 && (
                <div className="utility-note">这一单还没有可检视的产物。</div>
              )}
              {materialView === "diff" && pushReview
                && pushDiffState.kind === "error" && (
                <div className="utility-note" role="alert">
                  <strong>{!approvalReview ? "代码差异暂不可用，请刷新重试" : pushDiffState.expired
                    ? "这版代码已失效，暂不能确认推送"
                    : "代码检视暂不可用，暂不能确认推送"}</strong>
                  <span>{pushDiffState.message}</span>
                  <Button type="button" variant="outline" size="xs" className="mt-1.5 w-fit" onClick={() => {
                    setContent("");
                    setPushDiffState({ kind: "checking" });
                    setLivePulse((tick) => tick + 1);
                    onChanged();
                  }}>刷新任务并重新读取</Button>
                </div>
              )}
              {loading && <div className="utility-note">正在打开 {activeMeta?.label}…</div>}
              {((!loading && content) || (materialView === "diff" && !scopedDiff && !!activeMeta?.change_files?.length)) && (
              <Annotatable
                taskId={task.id}
                artifact={active}
                fallbackFile={activeMeta?.label ?? active}
                kind={activeMeta?.kind === "diff" ? "code" : "doc"}
                items={locatableNotes}
                enabled={canContributeReview && canCreateAnnotation}
                onAdded={() => setNotesPulse((tick) => tick + 1)}
                onOpenAnnotations={openAnnotationReview}
                renderInlineReview={(ids) => renderAnnotations(notes.filter((note) => ids.includes(note.id)), true)}
              >
                {materialView === "diff"
                  ? <GitDiff text={content} branch={branch} embeddedBrowser
                      annotationLocation={pendingLocation?.view === "diff"
                        ? { file: pendingLocation.item.file, request: pendingLocation.request } : undefined}
                      manifest={!scopedDiff ? activeMeta?.change_files : undefined}
                      untrackedDirectories={!scopedDiff
                        ? activeMeta?.untracked_directories : undefined}
                      onRetry={() => setLivePulse(tick => tick + 1)}
                      onDirectoryLoad={!scopedDiff
                        ? (path, offset) => listArtifactChangeDirectory(
                            task.id, path, offset)
                        : undefined}
                      onFileSelect={!scopedDiff ? setSelectedDiffPath : undefined}
                      activeFileLoading={loading || diffFileLoading}
                      activeFileError={diffFileError}
                      hideKey={task.id}
                      scopeLabel={pushReview
                        ? diffScope === "changes"
                          ? `本次修改 · ${(pushReview.base_sha ?? "").slice(0, 7)}`
                            + ` → ${(pushReview.head_sha ?? "").slice(0, 7)}`
                          : `完整交付 · ${(pushReview.baseline_sha
                              ?? pushReview.base_sha ?? "").slice(0, 7)}`
                            + ` → ${(pushReview.head_sha ?? "").slice(0, 7)}`
                        : undefined}
                      focusRequest={diffReviewRequest} />
                  : <Markdown showLineNumbers text={content} onOpenArchitecture={active === OVERALL_STORY_ARTIFACT || /(^|\/)story\.md$/.test(active)
                    ? (line) => { setArchitectureLine(line); openMaterial("chain"); } : undefined} />}
              </Annotatable>
              )}
            </>}
          </div>
          </div>
          </>}
          </div>
          </div>
        </section>
        <section className="ws-side" aria-label="与 Agent 协作">
          {demo && <div className="task-demo-message-caption">
            <select aria-label="选择本阶段展示回复" value={demoMessageId ?? ""}
              onChange={event => { setStreamFilter("all"); setStreamThread(undefined);
                setDemoMessages(current => ({ ...current, [demo.phase]: event.target.value })); }}>
              <option value="">选择本阶段的关键回复</option>
              {conversation.items.filter((item): item is Extract<ConversationItem, { kind: "turn" }> => item.kind === "turn").map(item =>
                <option key={item.id} value={item.id}>{item.texts.at(-1)?.text.replace(/[#*\n]/g, " ").slice(0, 65) || "Agent 回复"}</option>)}
            </select>
          </div>}
          {/* 栏宽可拖(双击复位),记在浏览器里:默认 36vw 封顶 640px 仍嫌窄的话
              人自己拉(用户 2026-09-05:"占据的面积太小了")。 */}
          <div className="ws-side-resizer" role="separator" aria-orientation="vertical"
            aria-label="拖动调整协作栏宽度" title="拖动调整宽度，双击恢复默认"
            onPointerDown={startSideResize}
            onDoubleClick={() => {
              setSideWidth(undefined);
              try { localStorage.removeItem(SIDE_WIDTH_KEY); } catch { /* 私密模式 */ }
            }} />
          <div className="ws-side-notices">
      {(pauseFeedback || controlError) && (
        <div className="task-control-feedback" aria-live="polite">
          {/* #227 换装:控制反馈行改工具类皮(.task-control-feedback 容器
              仍是任务头下的一条,壳样式由 task-workspace.css 承担)。 */}
          {pauseFeedback && (
            <div role="status" className="flex items-start gap-2 text-[13px] text-attention">
              <i aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-attention" />
              <span><strong className="font-semibold">{pauseFeedback.title}</strong>
                <small className="block text-muted-foreground">{pauseFeedback.detail}</small></span>
            </div>
          )}
          {controlError && <div role="alert" className="mt-1.5 grid gap-0.5 text-[13px] text-danger">
            <strong className="font-semibold">操作没有完成</strong>
            <span className="text-muted-foreground">{controlError}</span>
          </div>}
        </div>
      )}

            {(task.execution_plan_alerts ?? []).length > 0 && (
              <section role="alert"
                className="mt-5 grid gap-1 rounded-lg border border-danger/40 border-l-[3px] border-l-danger bg-danger-soft p-3 text-sm text-danger">
                <strong className="font-semibold">执行方案与当前现场不一致</strong>
                {task.execution_plan_alerts!.map((line, index) => (
                  <p key={index} className="m-0 text-[13px] text-text">{line.replace(/^⚠\s*/, "")}</p>
                ))}
              </section>
            )}

            {task.baseline_build?.status === "failed" && <Alert variant="destructive" role="status" className="mb-3">
              <AlertTitle>开工前编译失败</AlertTitle>
              <AlertDescription>开工前编译未通过，查看环境或上游问题。</AlertDescription>
              <AlertAction><Button type="button" variant="outline" size="xs" onClick={() => setWarmupOpen(true)}>查看编译失败原因</Button></AlertAction>
            </Alert>}
            {task.delivery?.skipped && <Alert variant="destructive" role="alert" className="mb-3">
              <AlertTitle>交付已阻止</AlertTitle>
              <AlertDescription>{task.delivery.skipped}</AlertDescription>
            </Alert>}
            {task.notify?.settled && !task.notify.delivered && task.notify.attempts > 0 && (
              <Alert variant="destructive" role="status" className="mb-3">
                <AlertTitle>小鲁班通知未送达</AlertTitle>
                <AlertDescription>已尝试 {task.notify.attempts} 次{task.notify.last_error?.match(/HTTP\s+\d{3}/)?.[0]
                  ? `（${task.notify.last_error.match(/HTTP\s+\d{3}/)![0]}）` : ""}；待办仍然有效，请在本页处理。</AlertDescription>
              </Alert>
            )}
            <TaskEarlyStart task={task} onChanged={onChanged} onOpenTask={onOpenTask} />
            {task.status === "queued" && Boolean(task.blocked_by?.length) && (
              <div className="mt-5 grid gap-1.5 rounded-lg border border-line bg-surface p-3 text-sm">
                <strong className="font-semibold text-text-strong">等待前置任务完成后自动开始</strong>
                <div className="flex flex-wrap gap-1.5">{task.blocked_by!.map((id) => (
                  <Button type="button" key={id} variant="outline" size="xs" disabled={!onOpenTask}
                    onClick={() => onOpenTask?.(id)}>{id}</Button>
                ))}</div>
              </div>
            )}
          </div>
          {/* 右栏 = 一条会话流 + 一个输入框(2026-09-05 用户拍板):卡上的选项就是
              动作,输入框只写附言/自定义/插话;工具步骤留在「工作过程」,流里只有
              回合。批注挂在提交按钮正上方(WaitingCard 内部)的原则不变——选项
              标签是内核的,前端改写会让记账对不上(2026-08-09 实战事故)。 */}
          <ConversationStream
            highlightId={demoMessageId}
            highlightCardId={demo ? demo.suggestedCardId ?? (waiting ? `card-${waiting.waiting_id}` : undefined) : undefined}
            highlightFocusKey={demo?.focusKey}
            task={task}
            items={conversation.items}
            problems={conversation.problems}
            loaded={conversation.loaded}
            unavailable={conversation.unavailable}
            viewerUsername={viewerUsername}
            people={streamPeople}
            filter={streamFilter}
            onFilterChange={setStreamFilter}
            thread={streamThread}
            onThreadChange={showThread}
            annotations={notes}
            decides={Boolean(waiting) && decides}
            awaitingYou={reviewCounts.mine}
            fallbackHeadline={nextAction.title}
            fallbackDetail={nextAction.detail}
            currentCard={waiting ? (decides ? (
                <WaitingCard
                  task={task}
                  presentation="studio"
                  footerTarget={chainReview ? undefined : decisionFooterTarget}
                  participant={!canOperate}
                  onDecided={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
                  annotationIds={requirementAnalysisConfirmation ? undefined : draftIds}
                  unresolvedAnnotationCount={unresolvedNotes.length}
                  queuedAnnotationIds={queuedIds}
                  pendingReviewAnnotationIds={pendingReviewIds}
                  repositoryAssigneeSelection={chainReview && canOperate
                    && task.requirement_graph?.projection_state === "ready"
                    && task.requirement_graph.repositories.length > 0
                    ? repositoryAssignees : undefined}
                  pushReview={pushReview}
                  onLocateDelivery={isPushConfirmation(task.waiting)
                    ? (scope) => {
                        setWorkspaceView("materials");
                        setMaterialView("diff");
                        setContent("");
                        setPushDiffState({ kind: "checking" });
                        const nextScope = scope
                          ?? (pushReview?.has_focused_changes ? "changes" : "full");
                        if (nextScope === diffScope) {
                          setLivePulse((tick) => tick + 1);
                        } else {
                          setDiffScope(nextScope);
                        }
                        setDiffReviewRequest((request) => request + 1);
                        const first = items?.find((item) => item.kind === "diff");
                        if (first) setActive(first.name);
                      }
                    : undefined}
                  activeDeliveryScope={isPushConfirmation(task.waiting)
                    ? diffScope : undefined}
                  attachment={requirementAnalysisConfirmation ? undefined :
                    <>
                      {/* 分工和依赖随确认卡直接展示，不要求用户另找架构图。 */}
                      {chainReview && <StoryViewNotice taskId={task.id} onOpen={() => openMaterial("chain")} />}
                      {chainReview && canOperate
                        && task.requirement_graph?.projection_state === "ready"
                        && task.requirement_graph.repositories.length > 0 && (
                        <RepositoryAssigneePicker
                          taskId={task.id}
                          repositories={task.requirement_graph!.repositories}
                          dependencies={task.requirement_graph!.dependencies}
                          onOpenStory={() => { openMaterial("doc"); setActive(OVERALL_STORY_ARTIFACT); }}
                          onOpenModule={openModuleStory}
                          defaultAssignee={task.luban_account}
                          defaultTicket={task.ticket}
                          selection={repositoryAssignees}
                          onSelectionChange={changeRepositoryAssignees}
                          saveState={repositoryAssigneeSave}
                        />
                      )}
                      {draftIds.length > 0 && <div role="note"
                        className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
                        本次决定将附带你的 {draftIds.length} 条未发送反馈；已发送意见不重复附带。
                      </div>}
                    </>
                  }
                />
              ) : (
                <TaskWaitingFacts task={task} />
              )) : undefined}
            tail={streamTail}
            assistantTools={assistantView?.tools}
            takeover={assistantView ? takeoverActiveOf(assistantView) : false}
            statusText={waiting && !decides ? "等待负责人决定" : statusText(task)}
            actor={health?.actor?.startsWith("你 · ")
              ? "由你负责" : health?.actor ?? `责任 · ${task.luban_account ?? "系统"}`}
            onLocateAnnotation={(id) => {
              const item = notes.find((note) => note.id === id);
              if (!item) return;
              locate(item);
              openAnnotationReview([id]);
            }}
            onOpenReview={(ids) => {
              if (ids.length) { openAnnotationReview(ids); return; }
              setReviewFilter("mine");
              setReviewPanelOpen(true);
            }}
            onOpenSteps={() => selectWorkspaceView("execution")}
          />
          {task.delivery?.final_mr || (chainReview && decides) ? null : canCollaborate || decides ? (
            <Composer task={task}
              recoveryRequest={recoveryRequest}
              isOwner={viewerUsername === (task.luban_account ?? "本地用户")}
              crossRepository={Boolean(task.parent_task_id)}
              steerOnly={task.requirement_graph?.stage === "analysis"}
              decisionDock={Boolean(waiting) && decides}
              dockContext={draftIds.length > 0 && !requirementAnalysisConfirmation
                ? `这里写的说明和你的 ${draftIds.length} 条排队批注会随选项一起送给 Agent`
                : isClarificationWaiting(task)
                  ? "答复只把缺的信息给 Agent，它接着处理；这不是最终验收"
                  : "这里写的说明会随选项一起送给 Agent"}
              dockRef={setDecisionFooterTarget}
              onChanged={() => {
                setLivePulse((value) => value + 1);
                onChanged();
              }}
              onAssistant={setAssistantView} />
          ) : (
            <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs text-muted-foreground">
              你可以查看全部记录与材料；提交决定和插话由责任人 <PersonName account={task.luban_account} fallback="或协作者" /> 处理。
            </div>
          )}
        </section>
      </div>
      {reviewInviteOpen && canRequestReview && !task.delivery?.final_mr && !isReviewTaskEnded(task.status) && <Dialog open
        onOpenChange={(next) => { if (!next) setReviewInviteOpen(false); }}>
        <DialogContent className="tw-root sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>邀请 Committer 检视</DialogTitle>
            <DialogDescription>可多选 Committer，一次发送邀请；邀请不会代替任务责任人的最终决定。</DialogDescription>
          </DialogHeader>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭邀请检视"
            className="absolute top-2 right-2" />}>
            <XIcon />
          </DialogClose>
          <div className="workspace-invite-content">
            {committers.length > 0 ? (
              <div className="flex flex-col gap-3">
                <UserPicker multiple ariaLabel="选择 Committer" value={reviewers}
                  emptyLabel="请选择 Committer"
                  options={committers} disabled={reviewBusy} onChange={setReviewers} />
                <Button type="button" size="sm" disabled={!reviewers.length || reviewBusy}
                  onClick={() => void inviteReview()}>
                  {reviewBusy ? "发送中…" : reviewers.length ? `发送邀请（${reviewers.length} 人）` : "发送邀请"}
                </Button>
              </div>
            ) : <Empty className="p-2.5">
              <EmptyDescription>管理员尚未配置 Committer 名单</EmptyDescription>
            </Empty>}
            {reviewResult && <small className="committer-result" role="status">
              {reviewResult}
            </small>}
            {taskReviews.length > 0 && (
              <div className="workspace-review-invite-history">
                {taskReviews.slice(0, 3).map((review) => (
                  <span key={review.id}>
                    <i className={review.status} aria-hidden />
                    <strong>{committers.find((user) =>
                      user.username === review.committer)?.display_name
                      ?? review.committer}</strong>
                    <small>{review.status === "canceled" ? "任务已结束，邀请已关闭"
                      : review.status === "completed" ? "已完成检视"
                      : review.delivered ? "等待检视" : "通知未送达"}</small>
                  </span>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>}
    </main>
  );
}
