import { taskProgressTimestamp } from "../../src/taskProgressTime";
import { pipelineLabel } from "./pipelinePresentation";
import { confirmsRequirementGraph as confirmsChainOption } from "../../src/requirementDecisionContract";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./components/Alert";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/Empty";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { PersonName } from "./People";
import { ExecutionEventBuffer } from "./executionEventBuffer";
import { DeliveryFileList } from "./DeliveryFileList";
/**
 * 单任务处置台：摘要适合扫读，展开后集中承载审批、交付事实、
 * 外部动作与事件现场。服务端镜像是唯一事实来源。
 *
 * #227 去 legacy:卡片壳/utility-panel/task-child-links/cost/timeline 等
 * 家族换 shadcn 默认皮 + 工具类;TaskProgress 相位轨与 EventTail 粘底
 * 日志(与问题侧 EventsPane 共族)结构原样保留。
 */

import { memo, useMemo, useEffect, useState, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "cn";
import { taskOverviewRelationship } from "./taskHierarchy";
import { TaskOverviewRow } from "./TaskOverviewRow";
import { Markdown } from "./markdown";
import { clearDecisionChoice, isDecisionTextDrag, isAdjustmentAnswer, isPushConfirmation, toggleDecisionChoice, unifiedDecisionReply } from "./decisionSelection";
import { confirmDialog } from "./ConfirmDialog";
import {
  decide,
  listActions,
  rerunTaskFromStart,
  listTimeline,
  retryTask,
  repairStopped,
  statusText,
  tailExecutionEvents,
  type ExternalAction,
  type SemanticEvent,
  type SseConnectionState,
  type TaskSummary,
  type TimelineEntry,
  type PushReviewPresentation,
} from "./api";
import { formatWait, URGENT_MINUTES, waitedMs } from "./taskTime";
import { responsibleOf } from "./teamOps";
import { useStickyBottom } from "./stickyBottom";
import {
  eventFilterCounts,
  executionEventKey,
  eventWindow,
  filterEvents,
  isErrorEvent,
  type EventDetailSelection,
  type EventFilter,
} from "./eventView";
import type { RepositorySkillSelection } from "./RepositorySkillPicker";
import type { RepositoryAssigneeSelection } from "./RepositoryAssigneePicker";
import { chainStages } from "./RequirementGraph";
import { PrepushStatus } from "./PrepushStatus";
import { TaskStatusBadge, TASK_STATUS_RAIL } from "./StatusBadge";
import { TokenUsage } from "./TokenUsage";
import {
  formatLocalClock,
  formatLocalDateTime,
  instantMs,
} from "./time";

export function TaskCard({
  task,
  onChanged,
  focused = false,
  canOperate = true,
  decisionMode = "form",
  canDecide = canOperate,
  onOpenArtifacts,
  onOpenRelatedTask,
  showChildLinks = true,
  compact = false,
  relatedTasks = [],
}: {
  task: TaskSummary;
  onChanged: () => void;
  focused?: boolean;
  canOperate?: boolean;
  decisionMode?: "form" | "signal";
  /** 能答卡但不能管任务:受邀参与讨论的人(协作者/逐仓责任人)。缺省
   * 与 canOperate 同值。 */
  canDecide?: boolean;
  onOpenArtifacts?: () => void;
  onOpenRelatedTask?: (taskId: string) => void;
  showChildLinks?: boolean;
  compact?: boolean;
  relatedTasks?: TaskSummary[];
}) {
  const showDecisionForm = !compact && decisionMode === "form";
  const [expanded, setExpanded] = useState(
    (showDecisionForm && task.status === "waiting_for_human") || focused,
  );

  useEffect(() => {
    if ((showDecisionForm && task.status === "waiting_for_human") || focused) {
      setExpanded(true);
    }
  }, [task.status, focused, showDecisionForm]);

  const mrUrl = task.delivery?.final_mr?.url ?? task.delivery?.mr_url;
  const waitingQuestions = task.waiting?.question?.questions?.length ?? 0;
  const chainReview = showDecisionForm
    && task.status === "waiting_for_human"
    && ((task.requirement_graph?.repositories.length ?? 0) > 1
      // 单仓分析单在拆出多单元前也走同一套 Chain 检视语义。
      || task.requirement_analysis_requested === true);
  // 受邀参与讨论的人能答澄清题;"进不进分析""拆不拆"这两张改任务形状的
  // 拍板卡只认责任人(服务端 decide 同口径拒绝),对他们只读并说明找谁。
  const ownerOnly = isOwnerOnlyWaiting(task);
  const decides = canOperate || (canDecide && !ownerOnly);
  const childRepositories = task.requirement_graph?.stage === "confirmed"
    ? task.requirement_graph.repositories.filter((repository) => repository.task_id && repository.task_id !== task.id)
    : [];
  const notifyHttpError = task.notify?.last_error
    ?.match(/HTTP\s+\d{3}/)?.[0];
  const buildFixActive = ["running", "recovering"].includes(
    task.delivery?.prepush_runtime?.state ?? "",
  );

  const { parent: parentTask, childCount } = taskOverviewRelationship(task, relatedTasks);
  if (compact && onOpenArtifacts) return <TaskOverviewRow
    id={task.id} ticket={task.ticket} title={task.title ?? task.requirement}
    status={task.status} statusLabel={task.status === "waiting_for_human" ? "待决定"
      : task.status === "verifying" ? (repairStopped(task) ? "需介入" : "验证中")
      : task.status === "await_merge" ? "待合入"
      : task.status === "coordinating" ? "子任务推进" : statusText(task)}
    owner={responsibleOf(task)} updatedAt={taskProgressTimestamp(task)} timeLabel="最近进展"
    detail={task.focus?.next_action ?? task.detail} child={!!task.parent_task_id}
    attention={repairStopped(task)} focused={focused} onOpen={onOpenArtifacts} childCount={childCount}
    parentId={task.parent_task_id} parentLabel={parentTask?.ticket ?? task.parent_task_id}
    parentTitle={parentTask?.title ?? parentTask?.requirement}
    onOpenParent={parentTask && onOpenRelatedTask ? () => onOpenRelatedTask(parentTask.id) : undefined} />;

  return (
    <article
      id={`task-${task.id}`}
      className={cn(
        "relative overflow-hidden rounded-xl border border-line bg-surface text-sm shadow-(--shadow-xs) transition-colors hover:border-line-strong",
        expanded && "border-line-strong",
        focused && "border-text-strong",
        task.parent_task_id && "ml-7",
      )}
    >
      <button
        type="button"
        className="relative flex w-full cursor-pointer items-start gap-4 p-4 pl-5 text-left"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", TASK_STATUS_RAIL[task.status])} />
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex flex-wrap items-center gap-2.5 text-xs">
            {task.parent_task_id
              ? <span className="font-medium text-muted-foreground">子任务</span>
              : childRepositories.length > 0
                ? <span className="font-medium text-muted-foreground">主任务</span> : null}
            {task.ticket && <span className="font-mono font-medium tracking-wide text-text-strong">{task.ticket}</span>}
            <span className="font-mono text-xs text-faint" title="平台内部编号">{task.id}</span>
            <TaskStatusBadge status={task.status}>
              {decisionMode === "signal" && task.status === "waiting_for_human"
                ? "待拍板"
                : statusText(task)}
            </TaskStatusBadge>
            <WaitBadge task={task} personal={showDecisionForm} />
            <span className="ml-auto tabular-nums text-faint">{formatLocalDateTime(task.created_at)}</span>
          </span>
          <strong className={cn("block leading-relaxed font-semibold tracking-tight text-text-strong [overflow-wrap:anywhere]",
            !expanded && "line-clamp-1")}>{task.title ?? task.requirement}</strong>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            <span>责任人 · <PersonName account={responsibleOf(task)} /></span>
          </span>
          {task.focus && (
            <span className="mt-2 grid grid-cols-[7px_minmax(0,1fr)] items-start gap-x-2 text-xs">
              <i aria-hidden className={cn("mt-1 justify-self-center size-1.5 rounded-full",
                task.focus.kind === "human_action" ? "bg-attention ring-3 ring-attention-soft"
                  : task.focus.kind === "blocked" ? "bg-danger ring-3 ring-danger-soft"
                  : task.focus.kind === "external" ? "bg-merge"
                  : task.focus.kind === "done" ? "bg-success"
                  : task.focus.kind === "inactive" ? "bg-faint" : "bg-active")} />
              <strong className={cn("font-bold",
                task.focus.kind === "human_action" ? "text-attention"
                  : task.focus.kind === "blocked" ? "text-danger" : "text-text-strong")}>
                {task.focus.headline}
              </strong>
              <span className="col-start-2 truncate text-muted-foreground">下一步 · {task.focus.next_action}</span>
            </span>
          )}
          {/* 收起态也要说清"为什么停/在等什么":原来失败原因和等待
              项都藏在展开区,列表上只剩一颗红/灰 pill,任务看着像在
              正常推进。一行摘要,点开看全文。 */}
          {!expanded && task.status === "failed" && task.detail && (
            <span className="mt-2 block rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger [overflow-wrap:anywhere]">
              {task.detail}
            </span>
          )}
          {!expanded && task.status === "verifying"
            && !buildFixActive
            && (repairStopped(task) || task.delivery?.waiting_on) && (
            <span className="mt-2 block rounded-md bg-attention-soft px-2.5 py-1.5 text-xs text-attention [overflow-wrap:anywhere]">
              {repairStopped(task)
                ? `自动修复已停，需要你介入：${task.delivery?.stalled
                  ?? task.delivery?.loop?.diagnosis ?? task.detail ?? ""}`
                : `正在等：${task.delivery!.waiting_on}`}
            </span>
          )}
          {task.requirement_graph?.stage === "analysis"
            && ((task.repositories?.length ?? 0) > 1
              || task.requirement_analysis_requested === true) && (
            <span className="mt-2 grid justify-start gap-1.5">
              <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-xs text-muted-foreground">
                <b className="text-ink">{task.requirement_graph.projection_state === "ready"
                  ? `${task.requirement_graph.repositories.length} 个模块任务`
                  : `${task.repositories?.length
                    ?? task.requirement_graph.repositories.length} 个候选仓`}</b>
                <i aria-hidden className="text-faint">·</i>
                <span>{task.requirement_graph.projection_state === "invalid"
                  ? "模块拆分与依赖图需要修正"
                  : task.requirement_graph.projection_state !== "ready"
                    ? "正在分析实际改动模块"
                    : task.status === "waiting_for_human"
                      ? task.requirement_graph.dependencies.length > 0
                        ? `${task.requirement_graph.dependencies.length} 条硬依赖待检视`
                        : "模块可并行，方案待检视"
                      : "正在核对模块职责与依赖"}</span>
              </span>
              {task.requirement_graph.projection_state === "ready" && (
                <span className="flex flex-wrap gap-1.5" aria-label="实际改动模块">
                  {task.requirement_graph.repositories.map((repository) => (
                    <span key={repository.id} title={repository.url}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">
                      <i aria-hidden className="size-[5px] shrink-0 rounded-full bg-ink" />
                      <span className="truncate">{repository.scope?.name ?? repository.name}
                        <small className="text-faint"> · {repository.name}</small></span>
                      {repository.assignee && <b className="font-bold text-ink">· <PersonName account={repository.assignee} /></b>}
                      {repository.task_status && <TaskStatusBadge status={repository.task_status}>
                        {statusText({ status: repository.task_status })}
                      </TaskStatusBadge>}
                    </span>
                  ))}
                </span>
              )}
            </span>
          )}
          {(task.blocked_by?.length ?? 0) > 0 && task.status === "queued" && (
            <span className="mt-2 inline-flex w-fit items-center rounded-md bg-attention-soft px-2 py-1 text-xs text-attention">
              等待前置任务完成后自动开始
            </span>
          )}
          {/* 收起时只藏阶段词签与 Token 遥测,相位轨(圆点)必须留着——
              去词签不去进度条(decisionContextLayout 契约,#227 起由这组
              条件工具类直接钉住,不再走 .task-card:not(.expanded) 规则)。 */}
          <span className={cn("block", !expanded && "[&_.task-phase>span]:hidden [&_.token-usage]:hidden")}>
            {task.progress && (
              <TaskProgress
                progress={task.progress}
                showDetailedStep={decisionMode === "form"}
                status={task.status}
              />
            )}
            <PrepushStatus prepush={task.delivery?.prepush}
              runtime={task.delivery?.prepush_runtime} />
            <TokenUsage usage={task.token_usage} />
          </span>
        </span>
        <span aria-hidden className={cn("mt-1 shrink-0 text-faint transition-transform", expanded && "rotate-90")}>
          <svg viewBox="0 0 20 20" className="size-5">
            <path d="m7.5 5 5 5-5 5" />
          </svg>
        </span>
      </button>

      {task.parent_task_id && onOpenRelatedTask && (
        <button type="button"
          className="mx-4 -mt-1 mb-2.5 flex w-[calc(100%-2rem)] cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-line-strong hover:text-text-strong"
          onClick={() => onOpenRelatedTask(task.parent_task_id!)}>
          <span className="font-bold">隶属于主任务</span>
          <strong className="min-w-0 truncate font-medium text-text-strong">{task.parent_task?.title ?? "跨仓大任务"}</strong>
          <code className="ml-auto font-mono text-xs text-ink">{task.parent_task?.ticket ?? task.parent_task_id}</code>
        </button>
      )}

      {showChildLinks && childRepositories.length > 0 && (
        <div aria-label="主任务下的子任务"
          className="mx-4 mb-2.5 grid gap-2 rounded-lg border-l-2 border-l-ink/50 bg-ink/[0.03] px-3 py-2.5 sm:grid-cols-[minmax(0,58px)_minmax(0,1fr)]">
          <span className="self-start text-xs font-extrabold text-muted-foreground">
            子任务
            {/* 交付单元拆分:主卡直接给"走到哪"——N/M 已合入 + 当前块。
                completed=已合入(子任务只有 MR 合入才 completed)。 */}
            <small className="mt-0.5 block text-xs font-semibold text-muted-foreground">
              {childRepositories.filter((repository) =>
                repository.task_status === "completed").length}
              /{childRepositories.length} 已合入
              {(() => {
                const active = childRepositories.find((repository) =>
                  repository.task_status
                  && !["completed", "canceled"].includes(repository.task_status));
                return active
                  ? ` · 当前:${active.scope?.name ?? active.name}` : "";
              })()}
            </small>
          </span>
          <div className="grid min-w-0 gap-1.5">{childRepositories.map((repository, index) => (
            <button type="button" key={repository.id}
              disabled={!onOpenRelatedTask}
              onClick={() => repository.task_id
                && onOpenRelatedTask?.(repository.task_id)}
              className="grid min-w-0 cursor-pointer grid-cols-[21px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-left text-text transition-colors hover:border-ink hover:bg-surface-2 disabled:cursor-default disabled:opacity-60 disabled:hover:border-line">
              <i aria-hidden className="grid size-[21px] place-items-center rounded-full bg-surface-3 font-mono text-xs font-extrabold text-ink">{index + 1}</i>
              <span className="grid min-w-0 gap-px">
                <strong className="truncate text-xs font-semibold text-text-strong">{repository.scope
                  ? `${repository.name} · ${repository.scope.name}`
                  : repository.name}</strong>
                <small className="truncate text-xs text-muted-foreground"><PersonName account={repository.assignee} fallback="未指定负责人" /></small>
              </span>
              <TaskStatusBadge status={repository.task_status ?? "queued"}>
                {statusText({ status: repository.task_status ?? "queued" })}
              </TaskStatusBadge>
            </button>
          ))}</div>
        </div>
      )}

      {decisionMode === "signal" && task.status === "waiting_for_human" && (
        <div className="mx-4 mb-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <i aria-hidden className="size-2 shrink-0 rounded-full bg-attention" />
          <strong className="text-sm">等待负责人拍板</strong>
          <span className="text-xs text-muted-foreground">
            <PersonName account={task.luban_account} fallback="未分配负责人" />
            {waitingQuestions > 0 ? ` · ${waitingQuestions} 个决策项` : ""}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pb-3 text-xs">
        {onOpenArtifacts && !chainReview && (
          <Button type="button" variant="link" size="sm"
            className="h-auto gap-1 self-center px-0 text-muted-foreground underline-offset-2 hover:text-text-strong"
            onClick={onOpenArtifacts}>
            <span>{chainReview ? "检视方案与依赖图" : "进入任务工作台"}</span>
            <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
              <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
            </svg>
          </Button>
        )}
        {mrUrl && (
          <a href={mrUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-text-strong hover:underline">
            <span>{task.delivery?.final_mr ? "最终 MR" : "合入请求"} · {task.delivery?.mr_state}</span>
            <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
              <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
            </svg>
          </a>
        )}
        {task.delivery?.pipeline && !buildFixActive && (
          // 原始状态串形如 "running(轮询预算耗尽,请人工查看流水线)"——
          // 括号里的注记才是给人看的;外壳状态词翻成人话,原文进 title。
          <span title={task.delivery.pipeline} className="text-faint [overflow-wrap:anywhere]">
            流水线 · {pipelineLabel(task.delivery.pipeline)}</span>
        )}
        {/* 百字诊断不塞 meta chip(最重要的原因不该用最弱的视觉级):
            这里只留结论,全文在展开区的 alert 里。 */}
        {task.delivery?.skipped && (
          <span title={task.delivery.skipped} className="text-faint [overflow-wrap:anywhere]">
            交付已阻止
          </span>
        )}
      </div>

      {expanded && (
        <div className="grid gap-3 border-t border-line p-3">
          {task.status === "failed" && task.detail && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>任务执行失败</AlertTitle>
              <AlertDescription>{task.detail}</AlertDescription>
              {canOperate && onOpenArtifacts && <Button size="sm" variant="outline" className="mt-2" onClick={onOpenArtifacts}>查看代码并补充处理要求</Button>}
            </Alert>
          )}
          {task.delivery?.skipped && task.detail !== task.delivery.skipped && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>交付已阻止</AlertTitle>
              <AlertDescription>{task.delivery.skipped}</AlertDescription>
            </Alert>
          )}
          {task.notify?.settled === true && !task.notify.delivered
            && task.notify.attempts > 0 && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>小鲁班通知未送达</AlertTitle>
              <AlertDescription>
                已完成 {task.notify.attempts} 次发送仍未送达
                {notifyHttpError ? `（${notifyHttpError}）` : ""}。
                待办仍然有效，请在本页处理。
              </AlertDescription>
            </Alert>
          )}
          {task.baseline_build?.status === "failed" && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>开工前编译失败(环境预热)</AlertTitle>
              <AlertDescription>
                环境或上游问题,与本单增量无关;详情在工作台执行现场。
                {task.baseline_build.detail
                  ? ` ${task.baseline_build.detail.slice(0, 160)}` : ""}
              </AlertDescription>
            </Alert>
          )}
          {repairStopped(task) && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>
                {task.delivery?.stalled ? "自动验证已停，需要你介入"
                  : "自动修复已停，需要你介入"}
              </AlertTitle>
              <AlertDescription>
                {task.delivery?.stalled ?? task.delivery?.loop?.diagnosis
                  ?? task.detail ?? "请查看流水线日志确认原因。"}
                {/* 下一步来自服务端焦点(按停摆类别给):原来这里写死
                    "确认外部平台恢复后点重新尝试交付",对 SHA 对不上、
                    外来提交这类完整性停摆等于劝人跳过核实直接重试。 */}
                {task.focus?.next_action
                  ? ` ${task.focus.next_action}。`
                  : " 办完之后点「重跑续推」，机器接着干。"}
                {/* 诊断是会话的收口发言,可能在聊别的事(实锤:最后一轮在补
                    文档章节)。流水线到底红在哪必须单独亮,不靠诊断捎带。 */}
                {task.delivery?.loop?.failure && (
                  <span className="mt-1.5 block font-mono text-xs whitespace-pre-wrap break-all">
                    流水线失败原文:{task.delivery.loop.failure}
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}
          {/* 还在等的时候也要说清在等什么。这行原来根本不渲染:页面只有
              "验证中"三个字,底下藏着的"某一项流水线结果一直没给"谁都
              看不到,任务看着像马上要成了。 */}
          {!repairStopped(task) && !buildFixActive && task.status === "verifying"
            && task.delivery?.waiting_on && (
            <div className="mb-1 flex flex-col gap-1 rounded-lg border border-line border-l-[3px] border-l-ink bg-surface-2 px-3 py-2">
              <strong className="text-[13px] text-text-strong">正在等</strong>
              <span className="break-words text-xs text-muted-foreground">{task.delivery.waiting_on}</span>
            </div>
          )}
          {canOperate && (task.status === "failed"
            || task.status === "canceled"
            || repairStopped(task)) && (
            <RetryButton
              taskId={task.id}
              onDone={onChanged}
              label={task.delivery?.stalled && !task.delivery?.loop
                  && !task.delivery?.evidence_gap
                ? "重新尝试交付" : undefined}
              allowFromStart={["failed", "canceled"]
                .includes(task.status)}
            />
          )}
          {chainReview && decides && (
            <div className="grid gap-1.5 rounded-lg border border-line bg-surface-2 p-3 text-sm">
              <span className="font-mono text-xs font-bold tracking-wide text-ink">跨仓方案</span>
              <strong className="text-[15px] text-text-strong">跨仓方案已经生成，先看依赖再确认</strong>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">仓库职责、硬依赖和交付顺序都在任务工作台中；确认后才会拆成各仓交付任务。</p>
              <Button type="button" size="sm" className="w-fit" onClick={onOpenArtifacts}>检视方案与依赖图</Button>
            </div>
          )}
          {showDecisionForm && decides && !chainReview
            && task.status === "waiting_for_human" && task.waiting && (
            isPushConfirmation(task.waiting) ? (
              /* 列表保留入口，工作台展示完整代码与意见。 */
              <div className="grid gap-1.5 rounded-lg border border-line bg-surface-2 p-3 text-sm">
                <span className="font-mono text-xs font-bold tracking-wide text-ink">交付检视</span>
                <strong className="text-[15px] text-text-strong">请检视当前待推送代码</strong>
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">请到任务工作台查看代码差异和检视意见，确认后将直接推送。</p>
                {onOpenArtifacts && (
                  <Button type="button" size="sm" className="w-fit" onClick={onOpenArtifacts}>
                    去检视代码
                  </Button>
                )}
              </div>
            ) : (
              <WaitingCard task={task} onDecided={onChanged}
                participant={!canOperate} />
            )
          )}
          {showDecisionForm && !decides && task.status === "waiting_for_human" && (
            <div className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
              {canDecide
                ? `这一步由责任人 ${task.luban_account ?? "其他成员"} 拍板；你可以在工作台批注插话。`
                : `该事项由 ${task.luban_account ?? "其他成员"} 核对；你可以查看进展，但不能代为提交决定。`}
            </div>
          )}
          <div className="grid min-w-0 gap-2">
            {/* 现场回收后代码差异那类面板会空着,不说清楚人会以为坏了。
                说明里必须点名"什么还在"——只写"已回收"像是历史没了。 */}
            {task.workspace_reclaimed_at && (
              <div className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
                任务现场已于 {formatLocalDateTime(task.workspace_reclaimed_at)} 回收
                （超过保留期，释放代码克隆等可再生的大件）。
                需求与交付文档仍可阅读和下载，过程记录、交付账本、流水线证据与批注都还在；代码差异不再可看。
              </div>
            )}
            <ExecutionPanel task={task} />
            <TaskTimeline taskId={task.id} />
            {/* 外部动作台账(ActionLedger)不再上页面:一屏四块信息密度
                过载,而它是排障口不是日常口。组件与 GET /tasks/:id/actions
                都还在,要查幂等键/绑定 SHA 时直接调接口。 */}
          </div>
        </div>
      )}
    </article>
  );
}

/** 等待时长:久等升红。父层每 1.5 秒刷新任务列表,这里跟着重算,
 * 不用自己挂计时器。#227 换装为 shadcn Badge(urgent=destructive)。 */
export function WaitBadge({ task, personal, className }: {
  task: TaskSummary;
  personal: boolean;
  className?: string;
}) {
  const waited = waitedMs(task);
  if (waited < 0) return null;
  const urgent = waited >= URGENT_MINUTES * 60_000;
  return (
    <Badge variant={urgent ? "destructive" : "neutral"} className={cn("gap-1.5", className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {personal ? "等你" : "已等待"} {formatWait(waited)}
    </Badge>
  );
}

export function TaskProgress({
  progress,
  showDetailedStep,
  context,
  preparation,
  onPhaseClick,
  status,
}: {
  progress: NonNullable<TaskSummary["progress"]>;
  showDetailedStep: boolean;
  context?: ReactNode;
  preparation?: ReactNode;
  status?: TaskSummary["status"];
  /** 工作台传入:点阶段名弹该阶段执行方案。列表页不传,保持纯展示。 */
  onPhaseClick?: (phase: string) => void;
}) {
  // 阶段名与顺序原样来自任务 API(内核 flow/phases.json 一份词表),这里
  // 不追加、不改名。原来终态会自己补一个"完成"、把"交付"显示成"验证与
  // 交付"——都是前端私造的第二套词表,和内核方案词表对不上就点不动。
  // 终态(completed)由服务端把当前段指到末段,前端只画。
  const completed = status === "completed";
  const phases = progress.phases;
  const currentIndex = completed ? phases.length - 1 : progress.current_index;
  const currentLabel = completed
    ? (phases.at(-1) ?? progress.current_phase) : showDetailedStep
    ? progress.step ?? progress.current_phase : progress.current_phase;
  const displayedCurrentLabel = currentLabel;
  const milestone = progress.milestone;
  const milestoneEvent = milestone
    ? ({
        started: "开始",
        completed: "完成",
        blocked: "受阻",
        start: "开始",
        complete: "完成",
        block: "受阻",
      } as Record<string, string>)[milestone.event]
    : undefined;
  const showMilestone = Boolean(
    milestone?.task_id && milestone.title && milestoneEvent,
  );
  return <span className="task-progress" aria-label={`当前阶段：${displayedCurrentLabel}`}>
    <span className="task-progress-caption">
      <span>当前进度</span>
      {preparation && <span className="task-progress-preparation">{preparation}</span>}
      {context && <span className="task-progress-caption-context">{context}</span>}
      <strong>{displayedCurrentLabel}</strong>
      <em className="task-progress-count">{currentIndex + 1}/{phases.length}</em>
    </span>
    {showMilestone && milestone && (
      <span className={`task-milestone ${milestone.event}`}>
        <i aria-hidden />
        <span className="task-milestone-summary">
          任务 {milestone.task_id} · {milestone.title} · {milestoneEvent}
        </span>
        {milestone.reason && (
          <span className="task-milestone-reason">· {milestone.reason}</span>
        )}
      </span>
    )}
    <span className="task-phase-track">
      {phases.map((phase, index) => {
        const state = index < currentIndex
          ? "past" : index === currentIndex ? "current" : "future";
        return <span className={`task-phase ${state}`} key={phase}
          {...(onPhaseClick ? {
            role: "button" as const,
            tabIndex: 0,
            title: `${phase} · 查看该阶段执行方案`,
            style: { cursor: "pointer" },
            onClick: () => onPhaseClick(phase),
            onKeyDown: (event: ReactKeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onPhaseClick(phase);
              }
            },
          } : { title: phase })}>
          <i aria-hidden />
          <span>{phase}</span>
        </span>;
      })}
    </span>
  </span>;
}

/** 这张卡是不是 Chain 的"拆分方案确认"。有模块时确认并生成任务；
 * 全部候选仓均无需修改时只确认分析结论。 */
export function isChainReviewWaiting(task: TaskSummary): boolean {
  const graph = task.requirement_graph;
  return graph?.stage === "analysis"
    && (task.waiting?.question?.questions?.some((question) =>
      question.options?.some(confirmsChainOption)) ?? false);
}

/** 检视卡上"把意见送回 Agent 继续改"的那一项:choice_effects 标了
 * handles_feedback 的选项;没标就取不关闭检视的选项里最像"需要调整"的。
 * WaitingCard 的返工文案和批注面板的"提交并返工"共用这一个判据,别各抄
 * 一份。没有 choice_effects 的卡(普通澄清、Chain 方案)不算。 */
export function reworkChoiceOf(
  task: TaskSummary,
): { question: string; option: string } | undefined {
  const effects = task.waiting?.choice_effects ?? [];
  if (!effects.length) return undefined;
  const feedbackAnswers = new Set(effects
    .filter((effect) => effect.handles_feedback).flatMap((effect) => effect.answers));
  const closingAnswers = new Set(effects
    .filter((effect) => effect.closes_feedback).flatMap((effect) => effect.answers));
  const allAnswers = new Set(effects.flatMap((effect) => effect.answers));
  for (const item of task.waiting?.question?.questions ?? []) {
    const options = item.options ?? [];
    if (!options.some((option) => allAnswers.has(option))) continue;
    const exact = options.find((option) => feedbackAnswers.has(option));
    if (exact) return { question: item.question, option: exact };
    const nonClosing = options.filter((option) => !closingAnswers.has(option));
    const option = nonClosing.find(isAdjustmentAnswer);
    if (option) return { question: item.question, option };
  }
  return undefined;
}

/** 拍板类卡只认责任人:进不进分析、拆不拆。受邀参与讨论的人能答澄清题,
 * 这两张改任务形状的卡对他们只读;服务端 decide 是同一口径的硬闸。 */
export function isOwnerOnlyWaiting(task: TaskSummary): boolean {
  const step = task.waiting?.step;
  return step === "cloud_requirement_analysis_confirm"
    || step === "cloud_split_proposal"
    || step === "cloud_mr_description"
    || step === "cloud_push_confirm";
}

/** 澄清卡:Agent 处理检视意见时缺信息,单独问人。它不是"要不要通过",
 * 标题、按钮、提示都要跟最终验收分开说。 */
export function isClarificationWaiting(task: TaskSummary): boolean {
  return task.waiting?.question?.purpose === "clarification";
}

function waitingStepTitle(task: TaskSummary): string | undefined {
  const step = task.waiting?.step ?? "";
  if (step === "cloud_mr_description") return "填写 AR 描述，用于 MR 标题";
  if (step === "cloud_requirement_analysis_confirm") {
    return "确认需求";
  }
  if (isClarificationWaiting(task)) return "需要补充信息";
  // 原来落到兜底的"需要你的决策":上面一栏刚写完"当前需要处理",两个
  // 标题摞一起没一个说是在确认什么(用户实测截图"很丑")。
  if (isChainReviewWaiting(task)) return task.requirement_graph?.repositories.length === 1 ? "确认开发方案" : "确认拆分方案";
  if (step === "host_push_confirm") return "确认本次推送";
  if (step === "cloud_push_confirm") return "最终检视：确认这版代码可直接推送";
  if (isPushConfirmation(task.waiting)) return "代码检视";
  return undefined;
}

function DecisionFooterMount({ target, children }: { target?: HTMLElement | null; children: ReactNode }) {
  return target ? createPortal(children, target) : children;
}

export function WaitingCard({
  task,
  onDecided,
  annotationIds,
  unresolvedAnnotationCount,
  queuedAnnotationIds = [],
  pendingReviewAnnotationIds = [],
  attachment,
  repositorySkillSelection,
  repositoryAssigneeSelection,
  pushReview,
  onLocateDelivery,
  activeDeliveryScope,
  participant = false,
  presentation = "default",
  footerTarget,
}: {
  task: TaskSummary;
  presentation?: "default" | "studio";
  footerTarget?: HTMLElement | null;
  onDecided: () => void;
  /** 本次仍待发送的 draft 批注；sent 已经送达，不能重复附带。 */
  annotationIds?: string[];
  /** 尚未闭环的 draft + sent 数量，用于检视引导和关闭分支门禁提示。 */
  unresolvedAnnotationCount?: number;
  queuedAnnotationIds?: string[];
  pendingReviewAnnotationIds?: string[];
  /** 批注块。挂在提交按钮正上方而不是卡片外面:选项标签是内核的
   * (它按标签给这次选择记账,前端改写会让记下的选择对不上用户点的),
   * 所以"这次会带上哪几处"只能摆在人按下提交的那一眼里。 */
  attachment?: ReactNode;
  /** 仅 Chain 的“确认并生成任务”消费；未扫描/需要修改都不发送。 */
  repositorySkillSelection?: RepositorySkillSelection;
  /** Chain 的逐仓分工；确认拆单前必须全部指向已就绪成员。 */
  repositoryAssigneeSelection?: RepositoryAssigneeSelection;
  /** 当前待推送代码为什么需要再检视，以及两种阅读范围。 */
  pushReview?: PushReviewPresentation;
  /** 跳到工作台的代码差异；不传则不显示跳转按钮。 */
  onLocateDelivery?: (scope?: "changes" | "full") => void;
  /** 当前已经摆在左侧的检视范围。相同范围必须显示成状态,不能继续
   * 假装是一个点了会有动作的按钮。 */
  activeDeliveryScope?: "changes" | "full";
  /** 受邀参与讨论的人在答卡:能答题、能选"需要修改",但"确认并生成任务"
   * 这一项锁住——拆单由责任人拍板(服务端同口径拒绝,这里别让人白点)。 */
  participant?: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [replyText, setReplyText] = useState("");
  const optionPress = useRef<{ x: number; y: number } | undefined>(undefined);
  const replyInput = useRef<HTMLTextAreaElement>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [conflict, setConflict] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    // WaitingCard 在右栏原位复用。换 waiting_id 就是换了一桩事务，
    // 上一张卡的选择、自由答复和错误提示都不能偷偷带到下一张。
    setPicked({});
    setCustom({});
    setCustomOpen({});
    setNotes("");
    setReplyText("");
    setNotesOpen(false);
    setContextOpen(false);
    setConflict("");
  }, [task.waiting?.waiting_id]);
  const questions = task.waiting?.question?.questions ?? [];
  const requirementAnalysisConfirmation = task.waiting?.step
    === "cloud_requirement_analysis_confirm";
  const clarification = isClarificationWaiting(task);
  const mrDescription = task.waiting?.step === "cloud_mr_description";
  const clarificationTargets = task.waiting?.question?.annotation_ids?.length ?? 0;
  const chainReview = isChainReviewWaiting(task);
  const unifiedReply = (presentation === "studio" || mrDescription) && questions.length === 1
    && !requirementAnalysisConfirmation;
  const choiceEffects = task.waiting?.step === "host_push_confirm" ? [] : task.waiting?.choice_effects ?? [];
  const closingAnswers = new Set(choiceEffects
    .filter((effect) => effect.closes_feedback)
    .flatMap((effect) => effect.answers));
  const allChoiceAnswers = new Set(choiceEffects.flatMap((effect) => effect.answers));
  const reworkChoice = reworkChoiceOf(task);
  const feedbackOption = reworkChoice?.option;
  // 第一条入队时预选返工；保留用户已有选择及自定义草稿，刷新不反复改选。
  const queuedKey = queuedAnnotationIds.join("\0");
  useEffect(() => {
    if (!queuedKey || !reworkChoice || replyText.trim() || Object.values(custom).some(value => value.trim())) return;
    setPicked(current => Object.values(current).some(Boolean) ? current
      : { ...current, [reworkChoice.question]: reworkChoice.option });
  }, [queuedKey, task.waiting?.waiting_id]);
  const feedbackLabel = feedbackOption?.replace(/[（(].*$/, "") ?? "需要调整";
  const attachmentCount = unresolvedAnnotationCount
    ?? annotationIds?.length ?? 0;
  const pushConfirmation = isPushConfirmation(task.waiting);
  const answerOf = (question: string) => picked[question] ?? "";
  const optional = (question: string) =>
    /可忽略|若上题|如无|可跳过|可不填/.test(question);
  const confirmsChainChoice = Object.values(picked).some((answer) =>
    confirmsChainOption(answer));
  const chainProjectionReady = task.requirement_graph?.projection_state === "ready";
  const reworksChainChoice = chainReview && Object.values(picked).some((answer) =>
    answer.includes("需要修改"));
  const reviewChoiceConflict = attachmentCount > 0
    && questions.some((item) => {
    const options = item.options ?? [];
    if (!options.some((option) => allChoiceAnswers.has(option))) return false;
    const answer = answerOf(item.question);
    return Boolean(answer) && closingAnswers.has(answer);
  });
  const selectedAnswers = Object.values(picked).filter(Boolean);
  const selectedReviewAnswer = questions
    .filter((item) => (item.options ?? []).some((option) =>
      allChoiceAnswers.has(option)))
    .map((item) => answerOf(item.question))
    .find(Boolean);
  const selectedEffect = choiceEffects.find((effect) =>
    effect.answers.includes(selectedReviewAnswer ?? ""));
  // 历史任务或内核别名可能只把“需要调整代码”登记进 choice_effects，
  // 而当前卡展示成“需要调整代码（按清单返工）”。服务端允许这种别名，
  // 前端也必须从 diff 卡的明确返工文案兜底识别，不能仍承诺“推送”。
  const selectedHandlesFeedback = Boolean(selectedEffect?.handles_feedback)
    || ((pushConfirmation || task.waiting?.step === "host_push_confirm")
      && selectedAnswers.some(isAdjustmentAnswer));
  const hasCustomPrimaryAnswer = (unifiedReply && !picked[questions[0]?.question] && !!replyText.trim()) || questions.some((item) =>
    (item.options?.length ?? 0) > 0
    && !picked[item.question]
    && !!customOpen[item.question]
    && !!custom[item.question]?.trim());
  const isReviewDecision = pushConfirmation
    || choiceEffects.some((effect) => effect.closes_feedback);
  const ready = (requirementAnalysisConfirmation || questions.every((item) => {
    const options = item.options ?? [];
    const answered = unifiedReply ? Boolean(picked[item.question] || replyText.trim()) : options.length
      ? picked[item.question]
        || (customOpen[item.question] && custom[item.question]?.trim())
      : customOpen[item.question] && custom[item.question]?.trim();
    return optional(item.question) || Boolean(answered);
  }))
    && !repositorySkillSelection?.scanning
    && (!repositorySkillSelection?.scanned
      || !!repositorySkillSelection.catalogToken)
    && (!confirmsChainChoice || chainProjectionReady)
    && (!confirmsChainChoice || !repositoryAssigneeSelection
      || repositoryAssigneeSelection.ready)
    && (!requirementAnalysisConfirmation
      || (attachmentCount === 0
        && task.requirement_revision?.state !== "running"))
    && !reviewChoiceConflict
    && !submitting;

  function pickOption(question: string, option: string) {
    setPicked((current) => toggleDecisionChoice(current, question, option));
    // 给定选项与自定义答复是同一题的两个分支。切回给定选项时收起
    // 自定义编辑框；草稿仍保留，之后再切回来不会丢字。
    setCustomOpen((current) => {
      if (!current[question]) return current;
      const next = { ...current };
      delete next[question];
      return next;
    });
  }

  function toggleCustom(question: string) {
    const willOpen = !customOpen[question];
    setCustomOpen((current) => {
      const next = { ...current };
      if (current[question]) delete next[question];
      else next[question] = true;
      return next;
    });
    // 自定义答复是主答案，不和给定分支同时生效。补充原因仍走卡片
    // 底部的“补充说明”，避免人看到两个答案却不知道系统听哪个。
    if (willOpen) {
      setPicked((current) => clearDecisionChoice(current, question));
    }
  }

  async function submit() {
    if (!ready || submitting) return;
    const selectedOptions: Record<string, string> = {};
    const freeResponses: Record<string, string> = {};
    for (const item of questions) {
      const options = item.options ?? [];
      const selected = picked[item.question]
        || (requirementAnalysisConfirmation ? options[0] : "");
      if (options.length && selected) {
        selectedOptions[item.question] = selected;
      }
      const explanation = unifiedReply
        ? unifiedDecisionReply(selected, replyText).freeResponse
        : customOpen[item.question] ? custom[item.question]?.trim() : "";
      if (explanation) freeResponses[item.question] = explanation;
    }
    const confirmsChain = Object.values(selectedOptions).some((answer) =>
      confirmsChainOption(answer));
    const repositorySkills = confirmsChain
      && repositorySkillSelection?.scanned
      && repositorySkillSelection.catalogToken
      ? {
          catalogToken: repositorySkillSelection.catalogToken,
          // 空数组有业务含义：明确清空父任务的预选，不能转成 undefined。
          selectedIds: repositorySkillSelection.selectedIds,
        }
      : undefined;
    setSubmitting(true);
    setConflict("");
    try {
      const result = await decide(
        task.id,
        task.waiting!.state_version,
        selectedOptions,
        freeResponses,
        unifiedReply ? unifiedDecisionReply(picked[questions[0].question], replyText).notes : notes,
        annotationIds,
        repositorySkills,
        confirmsChain ? repositoryAssigneeSelection?.assignments : undefined,
        confirmsChain ? repositoryAssigneeSelection?.tickets : undefined,
        task.waiting!.waiting_id,
      );
      if (result.conflict) setConflict(result.conflict);
      onDecided();
    } catch (reason) {
      setConflict(reason instanceof Error ? reason.message : "决定提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = submitting ? "正在提交…"
    : mrDescription ? "保存描述并继续创建 MR"
    : task.waiting?.step === "host_push_confirm"
      ? selectedAnswers.includes("先调整") ? "交给 Agent 先调整" : selectedAnswers.includes("确认推送") ? "确认推送" : "提交决定"
    : clarification ? "发送答复"
    : requirementAnalysisConfirmation ? "需求已确认，进入需求分析"
    // 按钮说清楚按下去会发生什么：按模块建任务、确认无需改动，或退回。
    : chainReview && confirmsChainChoice
      ? !chainProjectionReady
        ? "模块拆分与依赖图尚未就绪"
        : task.requirement_graph?.repositories.length === 1 ? "确认并在本任务继续开发"
        : (task.requirement_graph?.repositories.length ?? 0) > 0
          ? `确认并创建 ${task.requirement_graph!.repositories.length} 个模块任务`
          : "确认分析结论并结束"
    : reworksChainChoice ? "退回修改方案"
    : repositorySkillSelection?.scanning ? "等待能力读取"
      : hasCustomPrimaryAnswer ? "提交自定义处理方式"
        : selectedHandlesFeedback
          ? selectedAnswers.includes("先调整") ? "交给 Agent 先调整" : "发送并继续修改"
          : pushConfirmation ? "确认推送" : "提交决定";

  return (
    <section className={`decision-card${chainReview ? " is-module-confirmation" : ""}`} aria-labelledby={`decision-${task.id}`}>
      <header className="decision-head">
        <div>
          {presentation !== "studio" && <span className="decision-kicker">
            {mrDescription ? "创建 MR 前需要补充" : clarification ? "Agent 在追问" : "需要你决定"}
          </span>}
          {/* 标题按卡类型说话,原始步骤 id(cloud_push_confirm 之类)
              不再印给人看——认不出的类型就只保留通用标题,卡的正文
              自会说明这是什么决定。 */}
          <h3 id={`decision-${task.id}`}>
            {waitingStepTitle(task) ?? "需要你的决策"}
            {chainReview && (task.requirement_graph?.repositories.length ?? 0) > 0
              ? ` · 建议${task.requirement_graph!.repositories.length === 1 ? "不拆分" : "拆分"}`
              : null}
          </h3>
        </div>
        {/* 几乎恒为 1 题:徽标只在真有多题时才有信息量。 */}
        {questions.length > 1 && (
          <span className="decision-count">{questions.length} 个问题</span>
        )}
      </header>
      {clarification && (
        /* 澄清卡与最终验收分开说:答复只是把缺的信息给 Agent,它接着处理;
           意见是否修好仍由提出人在最终卡上逐条确认。 */
        <p className="decision-clarification-note">
          Agent 处理{clarificationTargets > 0 ? ` ${clarificationTargets} 条` : ""}检视意见时缺少信息，
          答复后它会继续处理并重新登记回执。这不是最终验收，意见是否修好仍由提出人确认。
        </p>
      )}

      {chainReview && repositoryAssigneeSelection && attachment && (
        <fieldset className="decision-attachment" disabled={submitting}>{attachment}</fieldset>
      )}
      {chainReview && task.requirement_graph && !repositoryAssigneeSelection && (
        /* 方案本体(单元职责、负责面、依赖顺序)在左侧仓间依赖图里,是结构
           化的;卡上只放三个数和一句"去哪看"。原来这里是 300px 的一段散文
           背景,把左边已经画出来的东西再讲一遍。 */
        <div className="chain-decision-facts" role="note">
          {chainProjectionReady ? <>
            <span>{task.requirement_graph.repositories.length === 1
              ? <><b>建议不拆分</b>，由本任务继续开发</>
              : task.requirement_graph.repositories.length > 1
                ? <><b>建议拆分</b>为 {task.requirement_graph.repositories.length} 个模块任务</>
                : <><b>建议无需修改</b>，确认分析结论</>}</span>
            <span><b>{task.requirement_graph.repository_assessments
              ?.filter((item) => item.outcome === "no_change").length ?? 0}</b>个仓无需修改</span>
            <span>{task.requirement_graph.dependencies.length > 0
              ? <><b>{chainStages(task.requirement_graph).length}</b>个执行阶段</>
              : <><b>可并行</b>无硬依赖</>}</span>
            <small>模块职责与依赖关系见 story.md 和「架构图」；这里确认各模块的负责人和单号。</small>
          </> : <>
            <span><b>未就绪</b>不能创建任务</span>
            <small>{task.requirement_graph.projection_error
              ? `模块拆分与依赖图不完整：${task.requirement_graph.projection_error}`
              : "Agent 尚未生成真实的模块拆分与依赖图。下单时选择的仓库只是排查范围，不会直接生成任务。"}</small>
          </>}
          {reworksChainChoice && (
            <small className="chain-rework-hint">
              需要调整方案时，请在 story.md 中逐行批注，或在答复中写清修改意见。意见会随决定交给 Agent。
            </small>
          )}
        </div>
      )}

      {!chainReview && task.waiting?.context && (() => {
        /* 提交前完整清单直接展示，其他长背景仍可按需展开。
           preface = 举卡前 Agent 刚展示的完整清单:卡上写"上述配置
           是否正确"时,"上述"必须就在卡里(MFC-028 盲签)。 */
        const preface = task.waiting.preface
          ? rewritePanelPath(task.waiting.preface, task.id) : undefined;
        const contextText = (preface ? `${preface}\n\n---\n\n` : "")
          + rewritePanelPath(task.waiting.context, task.id);
        const contextLines = contextText.split("\n").length;
        const collapsible = !pushConfirmation && contextLines > 16;
        const block = (
          <div className={`waiting-context${pushConfirmation ? " delivery-file-list" : ""}`}>
            <div className="context-label">{pushConfirmation ? "交付说明与完整清单" : "决策背景"}</div>
            <div className={`waiting-context-body${
              collapsible && !contextOpen ? " clamped" : ""}`}>
              <Markdown text={contextText} />
            </div>
            {collapsible && (
              <Button type="button" variant="outline" size="xs"
                className="mt-1.5 w-fit self-start text-ink hover:bg-accent-soft"
                onClick={() => setContextOpen((value) => !value)}>
                {contextOpen ? "收起背景" : `展开全部背景（共 ${contextLines} 行）`}
              </Button>
            )}
          </div>
        );
        // 拆分确认卡的背景是 Agent 对方案的复述,方案本身已在左侧成图;
        // 默认收起,想看原话再展开。其它卡照旧摊开(推送确认那类"上述
        // 配置是否正确"的卡,上述必须就在眼前——MFC-028 盲签)。
        return pushConfirmation && task.waiting.question?.delivery_files
          ? <details className="waiting-context-details" onToggle={event => setContextOpen(event.currentTarget.open)}>
              <summary>交付背景与清单原文</summary>{contextOpen && block}</details>
          : chainReview
          ? <details className="waiting-context-details">
              <summary>Agent 对方案的说明</summary>{block}
            </details>
          : block;
      })()}

      {pushConfirmation && task.waiting?.question?.delivery_files && <DeliveryFileList
        key={task.waiting.waiting_id} files={task.waiting.question.delivery_files} manifest={task.waiting.question.push_file_list} />}

      {!requirementAnalysisConfirmation && <div className="question-list">
        {!chainReview && questions.some((item) => (item.options?.length ?? 0) > 0) && (
          <p className="option-hint" role="status" aria-live="polite">
            {submitting ? "正在提交答复…" : selectedAnswers.length > 0
              ? <><strong>已选择，尚未提交。</strong>可补充说明，再点击下方提交按钮。</>
              : "选中选项不会立即发送；请在下方提交答复。"}
          </p>
        )}
        {questions.map((item, index) => {
          const options = item.options ?? [];
          const compact = options.length <= 4
            && options.every((option) => option.length <= 14);
          const customActive = !!customOpen[item.question];
          const skippable = optional(item.question);
          const reviewQuestion = options.some((option) =>
            allChoiceAnswers.has(option));
          return (
            <fieldset className="question" key={item.question}>
              <legend>
                {questions.length > 1 && <span className="question-number">
                  {String(index + 1).padStart(2, "0")}
                </span>}
                <span className="question-text">
                  {item.question || "是否同意当前方案？"}
                </span>
                {skippable && <span className="q-optional">可跳过</span>}
              </legend>
              <div className={`options ${compact ? "compact" : "cards"}`}>
                {options.map((option) => {
                  const chosen = picked[item.question] === option;
                  const locked = participant && confirmsChainOption(option);
                  const split = option.match(/^([^（(]+)[（(](.+)[）)]\s*$/);
                  const effect = choiceEffects.find((candidate) =>
                    candidate.answers.includes(option));
                  const inferredAdjustment = !effect && reviewQuestion
                    && !closingAnswers.has(option) && /需要.*(?:调整|修改)|返工|补充/.test(option);
                  const consequence = effect?.closes_feedback
                    ? "将关闭本轮检视并进入下一步"
                    : effect?.handles_feedback && effect.allows_source_edit
                      ? "将进入返工，处理意见后重新检视"
                      : effect?.handles_feedback || inferredAdjustment
                        ? "将留在本轮，处理意见后重新检视"
                        : "";
                  const [originalTitle, rawHint] = split
                    ? [split[1].trim(), split[2].trim()]
                    : [option, consequence];
                  const title = chainReview && option === "需要修改"
                    ? "不同意当前方案，要求调整"
                    : chainReview && confirmsChainOption(option)
                      ? task.requirement_graph?.repositories.length === 1
                        ? "同意不拆分，继续开发"
                        : (task.requirement_graph?.repositories.length ?? 0) > 1
                          ? "同意拆分，生成任务"
                          : "同意无需修改，结束分析"
                      : originalTitle;
                  const hint = locked
                    ? `由责任人 ${task.luban_account ?? ""} 确认；你可以选其他项或批注插话`
                    : rawHint;
                  return (
                    <button
                      type="button"
                      key={option}
                      className={`option${chosen ? " picked" : ""}${locked ? " locked" : ""}`}
                      role="radio"
                      aria-checked={chosen}
                      title={locked ? "由责任人确认"
                        : chosen ? "再次点击取消选择" : undefined}
                      disabled={locked}
                      onPointerDown={(event) => { optionPress.current = { x: event.clientX, y: event.clientY }; }}
                      onPointerCancel={() => { optionPress.current = undefined; }}
                      onClick={(event) => {
                        if (locked) return;
                        // 选项原文可拖选复制(用户拍板:能选中就行,不要按钮)。
                        // 拖选松手时浏览器照样派 click,不拦一下就把选项选上了。
                        const selection = window.getSelection();
                        const dragged = isDecisionTextDrag(optionPress.current,
                          { x: event.clientX, y: event.clientY }, event.detail > 0
                            && !!selection && !selection.isCollapsed
                            && !!selection.anchorNode && event.currentTarget.contains(selection.anchorNode));
                        optionPress.current = undefined;
                        if (dragged) {
                          return;
                        }
                        pickOption(item.question, option);
                      }}
                    >
                      {/* 选项点:RadioGroupItem 的同款皮(选中=primary 实底
                          + 反白内点)。外层卡片本身就是 role=radio 的交互
                          面(拖选复制护栏在上面),点只是它的指示器,所以
                          用同款视觉的纯指示元素,不再嵌一颗可聚焦的钮。 */}
                      <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                        chosen ? "border-primary bg-primary" : "border-line-strong bg-background")}>
                        {chosen && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                      </span>
                      <span className="option-body">
                        <span className="option-title">{title}</span>
                        {hint && <span className="option-hint">{hint}</span>}
                      </span>
                    </button>
                  );
                })}
                {!unifiedReply && <button
                  type="button"
                  className={`option custom-entry${customActive ? " picked" : ""}`}
                  role={options.length ? "radio" : undefined}
                  aria-checked={options.length ? customActive : undefined}
                  title={customActive ? "再次点击取消自定义答复" : undefined}
                  onClick={() => toggleCustom(item.question)}
                >
                    <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                      customActive ? "border-primary bg-primary" : "border-line-strong bg-background")}>
                      {customActive && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                    </span>
                    <span className="option-body">
                      <span className="option-title">{options.length
                        ? "自定义答复"
                        : "填写答复"}</span>
                      <span className="option-hint">{options.length
                        ? "以上选项都不合适时，直接写下正确处理方式"
                        : "填写本题的具体答案"}</span>
                    </span>
                </button>}
              </div>
              {customOpen[item.question] && (
                <div className="custom-answer">
                  <Textarea
                    className={`min-h-24 resize-y${customActive ? " border-foreground" : ""}`}
                    placeholder={options.length
                      ? "写下选项之外的正确处理方式…"
                      : "写下你的答复…"}
                    value={custom[item.question] ?? ""}
                    autoFocus
                    onChange={(change) => setCustom({
                      ...custom,
                      [item.question]: change.target.value,
                    })}
                  />
                  <span>{options.length
                    ? "这段文字将作为主答案直接交给 Agent；系统不会替你选择错误分支。"
                    : "这段文字将作为开放题答案提交。"}</span>
                </div>
              )}
            </fieldset>
          );
        })}
      </div>}

      {attachment && !(chainReview && repositoryAssigneeSelection) && (
        <fieldset className="decision-attachment" disabled={submitting}>
          {attachment}
        </fieldset>
      )}

      {attachmentCount > 0 && isReviewDecision && (
        <div className={`review-decision-guidance${
          reviewChoiceConflict ? " conflict" : ""
        }`} role={reviewChoiceConflict ? "alert" : "status"}>
          <strong>当前有 {attachmentCount} 条检视意见未闭环</strong>
          <span>{!feedbackOption
            ? "当前卡片缺少调整选项，请用“自定义答复”明确要求继续调整。"
            : reviewChoiceConflict
            ? `建议选择“${feedbackLabel}”。当前选项会关闭本轮检视，不会处理这些意见。`
            : selectedReviewAnswer === feedbackOption
              ? `已选择“${feedbackLabel}”，提交后会继续处理这些意见。`
              : `建议选择“${feedbackLabel}”，提交后会继续处理这些意见。`}</span>
        </div>
      )}

      {requirementAnalysisConfirmation
        && task.requirement_revision?.state === "running" && (
        <div className="review-decision-guidance" role="status">
          <strong>Agent 正在修改需求文档</strong>
          <span>正在落实已提交的检视意见。修改完成并逐条复检后，才能确认进入需求分析。</span>
        </div>
      )}

      {requirementAnalysisConfirmation
        && task.requirement_revision?.state !== "running"
        && attachmentCount > 0 && (
        <div className="review-decision-guidance conflict" role="alert">
          <strong>还有 {attachmentCount} 条需求检视意见未闭环</strong>
          <span>请由意见提出人核对 Agent 修改结果并逐条确认，全部闭环后即可通过。</span>
        </div>
      )}

      <DecisionFooterMount target={footerTarget}>
      <footer className="decision-footer">
        {unifiedReply && <div className="decision-unified-reply">
          <span>{mrDescription ? "AR 单上的准确描述" : chainReview ? (picked[questions[0].question] ? "补充说明（可选）" : "其他处理意见")
            : picked[questions[0].question] ? "补充所选决定的说明" : "自定义答复"} <small>{mrDescription ? "将原样用作 MR 标题" : chainReview
              ? (picked[questions[0].question] ? "随所选决定提交" : "也可直接选择上方选项")
              : picked[questions[0].question] ? "再次点击已选项可取消，改填自定义答复" : "也可以选择上方选项"}</small></span>
          <Textarea ref={replyInput} className="min-h-0 resize-y" value={replyText} aria-label="决定回复"
            rows={chainReview ? 3 : undefined}
            placeholder={mrDescription ? "从 AR 单复制准确描述，请勿额外添加单号或前后缀" : pushConfirmation && !picked[questions[0].question]
              ? "直接说明调整意见，例如：移除 build.log，把缺少的测试文件补上"
              : picked[questions[0].question] ? "补充选择原因或处理要求…" : "选项都不合适时，在这里填写答复…"}
            onChange={(event) => setReplyText(event.target.value)} />
        </div>}
        {!requirementAnalysisConfirmation && !unifiedReply && <div className="decision-notes">
          {!notesOpen ? (
            <Button type="button" variant="link" size="sm"
              className="h-auto justify-start px-0 text-left text-muted-foreground hover:text-text-strong"
              onClick={() => setNotesOpen(true)}>
              {isReviewDecision ? "+ 补充检视说明" : "+ 添加整卡备注"}
            </Button>
          ) : (
            <label>
              <span>{isReviewDecision
                ? "检视说明（可选，不改变上方分支）"
                : "决策备注（可选）"}</span>
              <Input
                type="text"
                placeholder={isReviewDecision
                  ? "补充修改原因或处理要求；流程走向以上方选项为准"
                  : "随本次决定一起记录"}
                value={notes}
                autoFocus
                onChange={(change) => setNotes(change.target.value)}
              />
            </label>
          )}
        </div>}
        {/* 报错紧贴提交按钮上方(role=alert 读屏即播):原来渲在整卡
            最底沿,长卡时落在视口外,人以为点了没反应。 */}
        {footerTarget && (reviewChoiceConflict || (requirementAnalysisConfirmation && attachmentCount > 0)) && (
          <p className="decision-dock-notice" role="status">还有 {attachmentCount} 条检视意见未闭环，请先处理后再确认通过。</p>
        )}
        {pendingReviewAnnotationIds.length > 0 && <div className="decision-dock-notice flex items-center gap-2" role="status">
          <span>{selectedHandlesFeedback
            ? `将把剩余 ${pendingReviewAnnotationIds.length} 条检视意见随本次决定一并送给 Agent`
            : `还有 ${pendingReviewAnnotationIds.length} 条意见：请先删除无效意见，或自行答复无需改动的意见；其余会在选择“仍需调整”后一起送给 Agent`}</span>
        </div>}
        {conflict && <Alert variant="destructive" role="alert" className="mb-3">{conflict}</Alert>}
        <div className="flex justify-end">
          <Button type="button" disabled={!ready} onClick={() => submit()}>{submitLabel}</Button>
        </div>
      </footer>
      </DecisionFooterMount>
      {pushReview && <details className="decision-evidence">
        <summary>改动摘要与推送范围</summary>
      {pushReview && (
        <section className="push-review-overview" aria-label="本次代码检视摘要">
          <div className="push-review-copy">
            <span>待推送代码</span>
            <strong>{pushReview.title}</strong>
            <p>{pushReview.description}</p>
          </div>
          <div className="push-review-facts" aria-label="修改统计">
            <span><b>{pushReview.file_count}</b>
              {pushReview.has_focused_changes ? " 个本次修改文件" : " 个交付文件"}
            </span>
            {/* 统计不可得时说原因,不许摆 +0/−0:文件数有值、行数假零的
                混合结果比没有更误导(MFC-040 实证)。 */}
            {pushReview.stats_unavailable_reason ? (
              <span className="stats-unavailable" role="alert">
                统计不可用:{pushReview.stats_unavailable_reason}
              </span>
            ) : <>
              <span className="added">+{pushReview.additions}</span>
              <span className="deleted">-{pushReview.deletions}</span>
            </>}
            {pushReview.verification && <span className="verified">
              {pushReview.verification}
            </span>}
          </div>
          {(pushReview.agent_note || pushReview.commits.length > 0) && (
            <details className="push-review-evidence">
              <summary>
                <strong>Agent 交付说明</strong>
                <span>{pushReview.commits.length
                  ? `${pushReview.commits.length} 个提交` : "实现与验证摘要"}</span>
              </summary>
              {pushReview.agent_note && (
                <div className="push-review-agent-note">
                  <Markdown text={pushReview.agent_note} />
                </div>
              )}
              {pushReview.commits.length > 0 && (
                <div className="push-review-commits">
                  {pushReview.commits.slice(0, 3).map((commit) => (
                    <span key={commit.sha}>
                      <code>{commit.sha}</code>{commit.subject}
                    </span>
                  ))}
                </div>
              )}
            </details>
          )}
          {onLocateDelivery && (
            <div className="push-review-actions">
              {pushReview.has_focused_changes && (
                activeDeliveryScope === "changes"
                  ? <span className="current" role="status">正在看这次改的</span>
                  : <Button type="button" size="sm"
                      onClick={() => onLocateDelivery("changes")}>
                      看这次改的
                    </Button>
              )}
              {activeDeliveryScope === "full"
                ? <span className="current" role="status">正在看全部改动</span>
                : <Button type="button" variant="outline" size="sm"
                    onClick={() => onLocateDelivery("full")}>
                    看全部改动
                  </Button>}
            </div>
          )}
        </section>
      )}

      </details>}
    </section>
  );
}

function rewritePanelPath(context: string, taskId: string): string {
  return context.replace(
    /`?\/[^\s`]*\.mae-flow-work\/panel\.html`?/g,
    // markdown 渲染层给所有链接 target=_blank,文字必须与行为一致:
    // 写"在本页打开"而实际开新标签页,是自相矛盾(2026-08-30 审计)。
    `[新标签页打开现场面板](/tasks/${taskId}/panel)`,
  );
}


export function RetryButton({
  taskId,
  onDone,
  allowFromStart = false,
  label = "重跑续推",
}: {
  taskId: string;
  onDone: () => void;
  allowFromStart?: boolean;
  label?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"retry" | "rerun" | "">("");
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Button type="button" size="sm" disabled={Boolean(busy)} onClick={async () => {
        setBusy("retry");
        try {
          const result = await retryTask(taskId);
          setError(result.error ?? "");
          if (!result.error) onDone();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy("");
        }
      }}>
        <svg viewBox="0 0 20 20" aria-hidden>
          <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
        </svg>
        {busy === "retry" ? "正在尝试…" : label}
      </Button>
      {allowFromStart && (
        <Button variant="destructive" size="sm" type="button" disabled={Boolean(busy)}
          onClick={async () => {
            if (!await confirmDialog({
              title: "清空并从头重跑",
              message: `将清空 ${taskId} 的旧工作区、流程、事件和交付记录，`
                + "并用同一任务编号从第一步重跑。此操作不可撤销。",
              confirmLabel: "清空并重跑",
              danger: true,
            })) return;
            setBusy("rerun");
            try {
              const result = await rerunTaskFromStart(taskId);
              setError(result.error ?? "");
              if (!result.error) onDone();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy("");
            }
          }}>
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M4 5h12M7 5V3h6v2m-7 3 .7 8h6.6L14 8M8.5 9.5v4m3-4v4" />
          </svg>
          {busy === "rerun" ? "正在清空重跑…" : "清空并从头重跑"}
        </Button>
      )}
      {error && <Alert variant="destructive" className="basis-full">{error}</Alert>}
    </div>
  );
}

export function ActionLedger({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<ExternalAction[]>();
  const [unavailable, setUnavailable] = useState("");

  async function load() {
    const result = await listActions(taskId);
    if (result.unavailable) setUnavailable(result.unavailable);
    else setRows(result.actions ?? []);
  }

  return (
    <details className="group/panel rounded-lg border border-line bg-surface" onToggle={(toggle) => {
      if ((toggle.target as HTMLDetailsElement).open) void load();
    }}>
      <summary className="flex w-full cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="grid gap-0.5">
          <strong className="text-sm font-medium text-text">外部动作台账</strong>
          <small className="text-xs text-muted-foreground">MR、流水线与幂等记录</small>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-faint transition-transform group-open/panel:rotate-180" />
      </summary>
      {unavailable && <div className="utility-note">{unavailable}</div>}
      {rows && rows.length === 0 && (
        <div className="utility-note">还没有外部动作。</div>
      )}
      {rows && rows.length > 0 && (
        <div className="grid gap-1.5 p-2">
          {rows.map((row) => (
            <div className="rounded-lg bg-surface-2 p-2.5" key={row.idemKey}>
              <div className="flex justify-between gap-2">
                <strong className="text-[13.5px]">{row.kind}</strong>
                <span className={cn("text-xs font-bold", row.finishedAt ? "text-success" : "text-active")}>
                  {row.finishedAt ? "已完成" : "进行中"}
                </span>
              </div>
              <code className="mt-1 block break-all text-xs text-muted-foreground">{row.idemKey}</code>
              {row.sha && <small className="mt-1 block text-xs text-muted-foreground">SHA · {row.sha.slice(0, 8)}</small>}
              <pre className="mt-1 max-h-40 overflow-auto text-xs text-muted-foreground">{JSON.stringify(row.result ?? "(未回填)", null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/** 交付时间线:这单经历了什么(人话)。展开才查——原始事件流留给
 * EventTail,这里只呈现服务端归纳好的条目,前端不二次解读。 */
export function TaskTimeline({
  taskId,
  defaultOpen = false,
}: {
  taskId: string;
  defaultOpen?: boolean;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(defaultOpen);

  async function load() {
    setLoading(true);
    const result = await listTimeline(taskId);
    setUnavailable(result.unavailable ?? "");
    setEntries(result.entries);
    setLoading(false);
  }

  useEffect(() => {
    setExpanded(defaultOpen);
    setEntries(undefined);
    setUnavailable("");
    if (defaultOpen) void load();
  }, [taskId, defaultOpen]);

  return (
    <section className={cn("rounded-lg border bg-surface transition-colors",
      expanded ? "border-line-strong" : "border-line")}>
      <button type="button"
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left"
        aria-expanded={expanded}
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) void load();
        }}>
        <span className="grid gap-0.5">
          <strong className="text-sm font-medium text-text">耗时与卡点</strong>
          <small className="text-xs text-muted-foreground">时间去哪了 · 卡在谁身上</small>
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-faint transition-transform",
          expanded && "rotate-180")} />
      </button>
      {expanded && <>
        {loading && <div className="utility-note">正在读取现场…</div>}
        {unavailable && <div className="utility-note">{unavailable}</div>}
        {entries && entries.length === 0 && (
          <div className="utility-note">现场还没有可归纳的记录。</div>
        )}
        {entries && entries.length > 0 && <CostBreakdown entries={entries} />}
      </>}
    </section>
  );
}

/** 耗时与卡点:同一份现场,回答"时间去哪了、卡在谁身上"。
 * 倒放流水账没有信息量(用户实测原话),这里只留结论与关键节点。 */
function timelineInstant(value: string): number {
  const timestamp = instantMs(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function CostBreakdown({ entries }: { entries: TimelineEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const first = timelineInstant(entries[0].ts);
  const last = Math.max(timelineInstant(entries[entries.length - 1].ts), first);
  // 审批卡 → 下一条决定 = 一段人工等待;没等到决定的就是此刻还在等。
  const waits: Array<{ ask: TimelineEntry; ms: number; answer?: string }> = [];
  entries.forEach((entry, index) => {
    if (entry.kind !== "ask") return;
    const answered = entries.slice(index + 1).find((it) => it.kind === "decision");
    const until = answered ? timelineInstant(answered.ts) : Date.now();
    waits.push({
      ask: entry,
      ms: Math.max(0, until - timelineInstant(entry.ts)),
      answer: answered?.title.replace(/^你的决定[:：]/, ""),
    });
  });
  const waitedTotal = waits.reduce((sum, item) => sum + item.ms, 0);
  const total = Math.max(last - first, waitedTotal);
  const machine = Math.max(0, total - waitedTotal);
  const share = total > 0 ? Math.round((waitedTotal / total) * 100) : 0;
  const rebuilds = entries.filter((it) => it.title.includes("重建会话")).length;
  const problems = entries.filter((it) => it.tone === "danger");
  const longest = [...waits].sort((a, b) => b.ms - a.ms).slice(0, 2);
  const pending = [...waits].reverse().find((item) => !item.answer);
  const latest = entries.at(-1)!;

/** 时间线色点词表(原 .timeline-item.{tone} 色板 1:1 收编)。 */
const TIMELINE_DOT: Record<string, string> = {
  attention: "bg-attention",
  success: "bg-success",
  danger: "bg-danger",
};

  return (
    <div className="flex flex-col gap-3 p-3">
      <section className={cn("grid min-h-24 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border p-3.5",
        pending ? "border-attention/40 bg-attention-soft" : "border-line border-l-[3px] border-l-success bg-surface-2")}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={cn("text-xs font-bold", pending ? "text-attention" : "text-muted-foreground")}>
            {pending ? "当前卡点" : "当前状态"}</span>
          <strong className="line-clamp-2 text-sm leading-snug font-bold text-text-strong">{pending
            ? pending.ask.title.replace(/^请你决定[:：]/, "")
            : "当前没有人工卡点"}</strong>
          <p className="m-0 text-xs leading-snug text-muted-foreground">{pending
            ? "流程正在等待负责人完成决策"
            : `最近进展 · ${latest.title}`}</p>
        </div>
        <div className="flex min-w-16 flex-col items-end gap-px">
          <strong className={cn("text-[21px] font-bold tabular-nums", pending ? "text-attention" : "text-text-strong")}>
            {pending ? formatWait(pending.ms) : `${share}%`}</strong>
          <span className="whitespace-nowrap text-xs text-muted-foreground">{pending ? "已等待" : "时间用于等决策"}</span>
        </div>
      </section>

      <section className="px-0.5 pt-0.5">
        <header className="mb-2 flex items-center justify-between gap-2">
          <strong className="text-xs text-text-strong">时间构成</strong>
          <span className="text-xs text-muted-foreground">总历时 {formatWait(total)}</span>
        </header>
        <div className="flex h-[7px] overflow-hidden rounded bg-surface-3" aria-label={`人工等待 ${share}%，机器执行 ${100 - share}%`}>
          <span className="block min-w-[2px] bg-attention" style={{ width: `${share}%` }} />
          <span className="block min-w-[2px] bg-ink" style={{ width: `${100 - share}%` }} />
        </div>
        <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><i className="size-1.5 rounded-full bg-attention not-italic" />人工等待 <strong className="font-semibold tabular-nums">{formatWait(waitedTotal)}</strong></span>
          <span className="flex items-center gap-1"><i className="size-1.5 rounded-full bg-ink not-italic" />机器执行 <strong className="font-semibold tabular-nums">{formatWait(machine)}</strong></span>
        </div>
      </section>

      <div className="grid grid-cols-2 divide-x divide-line overflow-hidden rounded-lg border border-line">
        <div className="flex items-center justify-between gap-2 px-3 py-2"><span className="text-xs text-muted-foreground">决策次数</span><strong className="text-[15px] tabular-nums text-text-strong">{waits.length}</strong></div>
        <div className="flex items-center justify-between gap-2 px-3 py-2"><span className="text-xs text-muted-foreground">会话重建</span><strong className="text-[15px] tabular-nums text-text-strong">{rebuilds}</strong></div>
      </div>

      {problems.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <strong className="text-xs text-text-strong">异常记录</strong>
          {problems.map((item, index) => (
            <div key={index} className="flex flex-col rounded-lg bg-danger-soft px-2.5 py-2 text-xs text-danger">
              <strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {longest.length > 0 && (
        <section className="pt-px">
          <header className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-xs text-text-strong">历史等待</strong>
            <span className="text-xs text-muted-foreground">耗时最长的 {longest.length} 次</span>
          </header>
          <ol className="m-0 flex list-none flex-col p-0">
            {longest.map((item, index) => (
              <li key={index} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 border-t border-line px-0.5 py-2">
                <span className={cn("font-mono text-xs", item.answer ? "text-faint" : "text-attention")}>{String(index + 1).padStart(2, "0")}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="line-clamp-2 text-xs font-semibold leading-tight text-text-strong">{item.ask.title.replace(/^请你决定[:：]/, "")}</strong>
                  <span className="truncate text-xs text-muted-foreground">{item.answer ? item.answer : "仍在等待负责人决定"}</span>
                </span>
                <span className="self-start whitespace-nowrap pt-px text-xs font-bold tabular-nums text-attention">{formatWait(item.ms)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="flex items-center justify-between gap-2 pt-px">
        <span className="text-xs text-muted-foreground">{entries.length} 个关键节点</span>
        <Button type="button" variant="ghost" size="xs" className="text-ink" onClick={() => setShowAll((open) => !open)}>
          {showAll ? "收起明细" : "查看完整时间线"}
        </Button>
      </div>
      {showAll && (
        <ol className="m-0 flex list-none flex-col border-t border-line px-1 pb-0 pt-1">
          {entries.map((entry, index) => (
            <li key={index} className="relative grid grid-cols-[14px_42px_minmax(0,1fr)] items-start gap-2 py-1 before:absolute before:bottom-[-4px] before:left-[6px] before:top-[17px] before:w-px before:bg-line last:before:hidden">
              <span aria-hidden className={cn("z-1 mt-1.5 size-[7px] rounded-full ring-3 ring-surface", TIMELINE_DOT[entry.tone] ?? "bg-muted-foreground")} />
              <time className="pt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground" dateTime={entry.ts}
                title={formatLocalDateTime(entry.ts, { seconds: true, year: true })}>
                {formatLocalClock(entry.ts)}
              </time>
              <span className="flex min-w-0 flex-col gap-0.5">
                <strong className={cn("text-[13px] leading-normal font-semibold [overflow-wrap:anywhere]",
                  entry.tone === "danger" && "text-danger",
                  entry.tone === "attention" && "text-attention")}>{entry.title}</strong>
                {entry.detail && <span className="text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">{entry.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 「已暂停跟随」的角标。停下来看东西时,人需要知道两件事:
 * 它没停(还在收),以及积压了多少。 */
function FollowPaused({ behind, onResume }: {
  behind: number; onResume: () => void;
}) {
  return (
    <button type="button" className="follow-resume" onClick={onResume}>
      {behind > 0 ? `↓ ${behind} 条新的` : "↓ 回到最新"}
    </button>
  );
}

function EventTail({ taskId, active }: { taskId: string; active: boolean }) {
  const PAGE_SIZE = 120;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [connection, setConnection] = useState<SseConnectionState>("connecting");
  // 默认只看对话(2026-09-08 用户拍板:展开卡片要的是聊天,不是工具
  // 调用噪音);原始事件流用筛选器一键可达,备查不丢。
  const [filter, setFilter] = useState<EventFilter>("messages");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<EventDetailSelection>();
  const filtered = useMemo(() => filterEvents(events, filter), [events, filter]);
  const visible = useMemo(() => eventWindow(filtered, visibleLimit), [filtered, visibleLimit]);
  const counts = useMemo(() => eventFilterCounts(events), [events]);
  const follow = useStickyBottom<HTMLDivElement>(filtered.length);

  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    setFilter("messages");
    setVisibleLimit(PAGE_SIZE);
    setDetail(undefined);
  }, [taskId]);

  useEffect(() => setVisibleLimit(PAGE_SIZE), [filter]);

  useEffect(() => {
    if (!active) return;
    const buffer = new ExecutionEventBuffer();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      setEvents(buffer.flush());
    };
    const stop = tailExecutionEvents(taskId, event => {
      if (buffer.add(event) && timer === undefined) timer = setTimeout(flush, 100);
    }, state => {
      if (state === "ended") {
        clearTimeout(timer);
        flush();
      }
      setConnection(state);
    });
    return () => { stop(); clearTimeout(timer); };

  }, [active, taskId]);

  return (
    <div className="event-panel-body">
      <div className={`event-live-state ${connection}`}>
        <i aria-hidden />
        <span>{!active ? "实时连接已暂停"
          : connection === "ended" ? "执行记录已读取"
            : connection === "live" ? "实时接收中"
            : connection === "reconnecting" ? "连接中断，正在自动重连"
              : "正在连接任务现场"} · {events.length} 条
          {follow.paused ? " · 已暂停跟随" : ""}</span>
      </div>
      <div className="event-filters" role="group" aria-label="筛选原始事件">
        {([
          ["all", "全部"],
          ["messages", "消息"],
          ["tools", "工具"],
          ["errors", "异常"],
        ] as Array<[EventFilter, string]>).map(([value, label]) => (
          <button type="button" key={value}
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}>
            {label}<span>{counts[value]}</span>
          </button>
        ))}
      </div>
      {follow.paused && (
        <div className="event-follow">
          <span>已暂停跟随,你正在往回看——新事件仍在接收。</span>
          <FollowPaused behind={follow.behind} onResume={follow.toBottom} />
        </div>
      )}
      <div className={`event-workspace${detail ? " has-detail" : ""}`}>
        <div ref={follow.ref} className="event-stream"
             onScroll={follow.onScroll}
             /* aria-live 去掉了:一个每秒刷新的流对读屏软件是灾难,
                而且"暂停跟随"之后再朗读最新内容,与人的意图正好相反。 */>
          {visible.hidden > 0 && (
            <button type="button" className="event-load-earlier"
              onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}>
              查看更早的 {Math.min(PAGE_SIZE, visible.hidden)} 条
              <small>仍有 {visible.hidden} 条未挂载</small>
            </button>
          )}
          {events.length === 0 && (
            <Empty className="min-h-[116px]" role="status">
              <span aria-hidden className="mb-2 size-2 rounded-full bg-success ring-[5px] ring-success-soft" />
              <EmptyTitle>{connection === "ended" ? "暂无执行记录" : "正在连接任务现场"}</EmptyTitle>
              <EmptyDescription>主 Agent 与 Build-Fix 的执行动作统一显示在这里。</EmptyDescription>
            </Empty>
          )}
          {events.length > 0 && filtered.length === 0 && (
            <Empty className="min-h-24" role="status">
              <EmptyTitle>这个筛选下没有事件</EmptyTitle>
              <EmptyDescription>原始事件没有丢失，可以切回“全部”继续查看。</EmptyDescription>
            </Empty>
          )}
          {visible.items.map((event) => (
            <EventRecord event={event} key={executionEventKey(event)}
              selectedDetail={detail?.key}
              onInspect={setDetail} />
          ))}
        </div>
        {detail && (
          <aside className="event-detail" aria-label="事件完整内容">
            <header>
              <div>
                <span>#{detail.eventId} · {detail.eventLabel}</span>
                <strong>{detail.fieldLabel}</strong>
                <time dateTime={detail.timestamp}>
                  {formatLocalDateTime(detail.timestamp, { seconds: true })}
                </time>
              </div>
              <button type="button" onClick={() => setDetail(undefined)}
                aria-label="关闭事件详情" title="关闭详情">×</button>
            </header>
            <pre className={detail.structured ? "structured" : ""}>
              {detail.content}
            </pre>
          </aside>
        )}
      </div>
    </div>
  );
}

/** 执行现场=实时执行日志,一种读法(2026-08-26 用户拍板:心流
 * 摘要定位不清晰,干掉;筛选器 + 贴底跟随已足够扫读与取证)。
 * 2026-09-08 二次拍板:默认筛选从"全部"改为"消息"——展开卡片要看的
 * 是聊天,不是工具调用噪音;原始流切筛选器即达,备查不丢。
 * 展开才建立实时连接。 */
export function ExecutionPanel({
  task,
  defaultOpen = false,
}: {
  task: TaskSummary;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);

  useEffect(() => {
    setExpanded(defaultOpen);
  }, [task.id, defaultOpen]);

  return (
    <section className={cn("rounded-lg border bg-surface transition-colors",
      expanded ? "border-line-strong" : "border-line")}>
      <button type="button"
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span className="grid gap-0.5">
          <strong className="text-sm font-medium text-text">执行现场</strong>
          <small className="text-xs text-muted-foreground">{task.focus?.headline ?? "只看对话，可切全部/工具/异常"}</small>
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-faint transition-transform",
          expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="min-w-0 p-2 pt-0">
          <EventTail taskId={task.id} active={expanded} />
        </div>
      )}
    </section>
  );
}

const EVENT_KIND_LABEL: Record<string, string> = {
  session_started: "会话开始",
  user_message: "用户指令",
  assistant_message: "Agent 回复",
  tool_requested: "调用工具",
  tool_finished: "工具结果",
  turn_finished: "本轮结束",
  task_status_changed: "状态变化",
};

const EVENT_FIELD_LABEL: Record<string, string> = {
  text: "内容",
  name: "工具",
  input: "输入",
  result: "结果",
  reason: "原因",
  answers: "答复",
  is_error: "执行异常",
  resume: "恢复会话",
  call_id: "调用编号",
};

function eventTone(event: SemanticEvent): string {
  if (isErrorEvent(event)) return "danger";
  if (event.kind === "tool_finished" || event.kind === "turn_finished") {
    return "success";
  }
  if (event.kind === "assistant_message") return "agent";
  if (event.kind === "user_message") return "user";
  return "neutral";
}

function EventValue({ value, onInspect }: {
  value: unknown;
  onInspect: (content: string, structured: boolean) => void;
}) {
  if (typeof value === "string") {
    if (value.length > 480) {
      return <button type="button" className="event-value-preview"
        onClick={() => onInspect(value, false)}>
        <span>
          <span>{value.slice(0, 180).trim()}…</span>
          <small>{value.length} 字</small>
        </span>
        <strong>右侧查看 <i aria-hidden>→</i></strong>
      </button>;
    }
    return <span className="event-value-text">{value || "（空）"}</span>;
  }
  if (typeof value === "boolean") {
    return <code className="event-value-atom">{value ? "是" : "否"}</code>;
  }
  if (value === null || value === undefined || typeof value === "number") {
    return <code className="event-value-atom">{String(value)}</code>;
  }
  return <button type="button" className="event-value-preview structured"
    onClick={() => onInspect(JSON.stringify(value, null, 2), true)}>
    <span>
      <span>结构化内容</span>
      <small>{Array.isArray(value) ? `${value.length} 项` : `${Object.keys(value).length} 个字段`}</small>
    </span>
    <strong>右侧查看 <i aria-hidden>→</i></strong>
  </button>;
}

const EventRecord = memo(function EventRecord({ event, selectedDetail, onInspect }: {
  event: SemanticEvent;
  selectedDetail?: string;
  onInspect: (selection: EventDetailSelection) => void;
}) {
  const fields = Object.entries(event.payload);
  return (
    <article className={`event-record ${eventTone(event)}${selectedDetail
      ?.startsWith(`${executionEventKey(event)}:`) ? " selected" : ""}`}>
      <header>
        <span className="event-record-dot" aria-hidden />
        <strong>{EVENT_KIND_LABEL[event.kind] ?? event.kind}</strong>
        {event.execution?.source === "build_fix" && <span className="event-session-label"
          title={event.execution.attempt}>Build-Fix · 第 {event.execution.round} 轮</span>}
        {event.sessionId === "developer-assistant" && (
          <span className="event-session-label">开发助手</span>
        )}
        {event.sessionId?.startsWith("requirement-review:") && (
          <span className="event-session-label">需求预检</span>
        )}
        <code>#{event.eventId}</code>
        <time dateTime={event.ts}
          title={formatLocalDateTime(event.ts, { seconds: true, year: true })}>
          {formatLocalDateTime(event.ts, { seconds: true })}
        </time>
      </header>
      {fields.length === 0 ? (
        <Empty className="p-2.5"><EmptyDescription>本事件没有附加内容</EmptyDescription></Empty>
      ) : (
        <dl>
          {fields.map(([field, value]) => {
            const key = `${executionEventKey(event)}:${field}`;
            return (
              <div key={field}>
                <dt>{EVENT_FIELD_LABEL[field] ?? field}</dt>
                <dd><EventValue value={value} onInspect={(content, structured) =>
                  onInspect({
                    key,
                    eventId: event.eventId,
                    eventLabel: EVENT_KIND_LABEL[event.kind] ?? event.kind,
                    fieldLabel: EVENT_FIELD_LABEL[field] ?? field,
                    content,
                    structured,
                    timestamp: event.ts,
                  })} /></dd>
              </div>
            );
          })}
        </dl>
      )}
    </article>
  );
});
