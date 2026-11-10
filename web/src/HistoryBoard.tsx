/** 历史投影优先、本服务交付结果兜底的只读档案。 */

import { useEffect, useState } from "react";
import {
  deleteHistoryTask,
  listHistory,
  rerunTaskFromStart,
  STATUS_TEXT,
  type AuthUser,
  type TaskHistoryEntry,
  type TaskSummary,
} from "./api";
import {
  historyTaskTitle,
  historyTaskHierarchy,
  isDeliveryArchiveStatus,
  workspaceHistoryEntries,
} from "./historyModel";
import { confirmDialog } from "./ConfirmDialog";
import { TaskStatusBadge } from "./StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Database, MoreHorizontal } from "lucide-react";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/Empty";
import { formatLocalDate, instantMs } from "./time";
import { TokenUsage } from "./TokenUsage";
import { taskOverviewRelationship } from "./taskHierarchy";

function timeAgo(iso: string): string {
  const minutes = Math.max(0,
    Math.floor((Date.now() - instantMs(iso)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return formatLocalDate(iso);
}

const TILES = [
  { label: "全部档案", tone: "neutral", match: (_status: string) => true },
  {
    label: "待合入",
    tone: "attention",
    match: (status: string) => status === "await_merge",
  },
  {
    label: "已完成",
    tone: "success",
    match: (status: string) => status === "completed",
  },
  {
    label: "异常 / 已取消",
    tone: "danger",
    match: (status: string) => ["failed", "canceled"].includes(status),
  },
] as const;

interface HistoryBoardProps {
  tasks: TaskSummary[];
  viewer: AuthUser;
  onChanged: () => void | Promise<void>;
  onOpenTask?: (task: TaskSummary) => void;
}

/** 指标瓦片语调(原 .history-metric.{neutral,active,attention,success,danger})。 */
const TONE = {
  neutral: "text-muted-foreground",
  active: "text-active",
  attention: "text-attention",
  success: "text-success",
  danger: "text-danger",
} as const;

export function HistoryBoard({
  tasks,
  viewer,
  onChanged,
  onOpenTask,
}: HistoryBoardProps) {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");

  async function load() {
    setLoading(true);
    setUnavailable("");
    try {
      const result = await listHistory();
      if (result.unavailable) setUnavailable(result.unavailable);
      else setEntries(result.entries ?? []);
    } catch (error) {
      setUnavailable(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const workspaceEntries = workspaceHistoryEntries(tasks);
  const usingWorkspace = Boolean(unavailable);
  const allEntries = usingWorkspace ? workspaceEntries : (entries ?? []);
  const visibleEntries = historyTaskHierarchy(allEntries.filter((entry) =>
    isDeliveryArchiveStatus(entry.status)), tasks);
  const currentTasks = new Map(tasks.map((task) => [task.id, task]));
  const relatedTasks = [...new Map([...tasks, ...allEntries, ...visibleEntries].map(task => [task.id, task])).values()];

  return (
    <section className="grid gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{visibleEntries.length} 项记录</span>
        <Button variant="outline" onClick={() => void load()}>刷新数据</Button>
      </div>

      {loading && (
        <div className="grid gap-3" aria-label="加载中">
          {/* #218:占位形状与旧 .metric-skeleton/.table-skeleton 等价 */}
          <Skeleton className="h-[94px]" />
          <Skeleton className="h-[280px]" />
        </div>
      )}

      {!loading && usingWorkspace && visibleEntries.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3" role="status" title={unavailable}>
          <span aria-hidden className="grid size-[26px] flex-none place-items-center rounded-lg
            bg-surface text-base font-bold text-primary shadow-[inset_0_0_0_1px_var(--line)]">◎</span>
          <span className="grid min-w-0 gap-0.5">
            <strong className="text-[13px] text-text-strong">当前使用本服务保留的交付结果</strong>
            <small className="sr-only">历史投影暂不可用；这里只展示已经形成结果的任务，恢复后会自动切换。</small>
          </span>
        </div>
      )}

      {actionError && <Alert variant="destructive" className="mb-3">{actionError}</Alert>}

      {!loading && visibleEntries.length === 0 && (
        <Empty className="min-h-[360px] border" role="status">
          <EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia>
          <EmptyTitle>{usingWorkspace ? "当前没有成果档案" : "成果档案里还没有记录"}</EmptyTitle>
          <EmptyDescription>
            任务进入待合入、完成、失败或取消后，会在这里留下记录。
          </EmptyDescription>
        </Empty>
      )}

      {!loading && visibleEntries.length > 0 && (
        <>
          <div className="grid grid-cols-4 divide-x divide-line rounded-xl border border-line bg-surface py-4">
            {TILES.map((tile) => (
              <div key={tile.label}
                className={`flex min-h-10 items-center justify-between gap-4 px-6 ${TONE[tile.tone]}`}>
                <span className="flex items-center gap-[7px] text-[13px] font-semibold">
                  <i aria-hidden className="size-2 rounded-full bg-current" />{tile.label}</span>
                <strong className="text-[27px] leading-none tabular-nums">
                  {visibleEntries.filter((entry) => tile.match(entry.status)).length}
                </strong>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
            <div aria-hidden className="grid items-center gap-4 border-b border-line bg-surface-2 px-[15px] py-2.5
              text-[13px] font-bold text-muted-foreground
              [grid-template-columns:minmax(220px,2fr)_110px_minmax(100px,1fr)_100px_100px_160px]">
              <span>任务</span>
              <span>状态</span>
              <span>交付</span>
              <span>事件</span>
              <span>最近更新</span>
              <span>操作</span>
            </div>
            <div>
              {visibleEntries.map((entry) => {
                const currentTask = currentTasks.get(entry.id);
                const relationship = taskOverviewRelationship(entry, relatedTasks);
                const parentTask = entry.parent_task_id ? currentTasks.get(entry.parent_task_id) : undefined;
                const title = historyTaskTitle(entry);
                const mrUrl = entry.delivery?.final_mr?.url ?? entry.delivery?.mr_url;
                const terminal = ["completed", "failed", "canceled"]
                  .includes(entry.status);
                const canRerun = viewer.role !== "admin" && terminal
                  && currentTask?.luban_account === viewer.username;
                const canDelete = terminal && (viewer.role === "admin"
                  || entry.luban_account === viewer.username);
                return (
                  <div key={entry.id} data-task-id={entry.id} data-parent-task-id={entry.parent_task_id} className={`grid min-h-[104px] items-center gap-4 border-b border-line
                    px-5 py-5 transition-colors last:border-b-0 hover:bg-surface-2
                    [grid-template-columns:minmax(220px,2fr)_110px_minmax(100px,1fr)_100px_100px_160px]${entry.parent_task_id ? " ml-7 border-l-2 border-l-primary/30 bg-primary/3" : ""}`}>
                    <div className="flex min-w-0 flex-col gap-1">
                      {entry.parent_task_id ? <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-primary">子任务</span><button type="button" className="truncate text-left hover:text-primary disabled:cursor-default" disabled={!parentTask || !onOpenTask} onClick={() => parentTask && onOpenTask?.(parentTask)} title={`主任务：${relationship.parent ? historyTaskTitle(relationship.parent) : entry.parent_task_id}`} aria-label={`返回主任务：${entry.parent_task_id}`}>↳ {relationship.parent ? historyTaskTitle(relationship.parent) : entry.parent_task_id}</button></div>
                        : relationship.childCount > 0 && <span className="w-fit rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">主任务 · {relationship.childCount} 个子任务</span>}
                      <span className="w-fit rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{entry.id}</span>
                      {currentTask && onOpenTask ? (
                        <button
                          className="group grid min-w-0 cursor-pointer justify-items-start gap-[3px] border-0 bg-none p-0 text-left focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
                          title={`${title} · 打开工作台`}
                          onClick={() => onOpenTask(currentTask)}
                        >
                          <strong className="max-w-full truncate text-base font-semibold text-text-strong group-hover:text-primary">{title}</strong>

                        </button>
                      ) : <strong title={title} className="truncate text-base font-semibold text-text-strong">{title}</strong>}
                      <TokenUsage usage={entry.token_usage} placement="history" />
                    </div>
                    <div>
                      <TaskStatusBadge status={entry.status}>
                        {STATUS_TEXT[entry.status] ?? entry.status}
                      </TaskStatusBadge>
                    </div>
                    <div>
                      {mrUrl ? (
                        <a
                          href={mrUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[13px] font-bold text-primary hover:underline"
                        >
                          {entry.delivery?.final_mr ? "最终 MR" : "MR"} · {entry.delivery?.mr_state ?? "查看"}
                          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 fill-none stroke-current stroke-[1.5]">
                            <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
                          </svg>
                        </a>
                      ) : <span className="text-faint">—</span>}
                    </div>
                    <div className="flex flex-col">
                      {usingWorkspace ? (
                        <span className="text-sm text-muted-foreground">本地记录</span>
                      ) : (
                        <><strong className="text-[15px] text-text-strong">{entry.event_count}</strong><span className="text-[13px] text-muted-foreground">个事件</span></>
                      )}
                    </div>
                    <time dateTime={entry.updated_at} className="text-[13px] text-muted-foreground">{timeAgo(entry.updated_at)}</time>
                    <div className="flex items-center justify-end gap-2">
                      {currentTask && onOpenTask && <Button variant="outline" className="text-primary" onClick={() => onOpenTask(currentTask)}>进入工作台</Button>}
                      {(canRerun || canDelete) && <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`${entry.id} 更多操作`} />}><MoreHorizontal /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                      {canRerun && (
                        <DropdownMenuItem disabled={Boolean(busy)}
                          onClick={async () => {
                            if (!await confirmDialog({
                              title: "清空重跑",
                              message: `将清空 ${entry.id} 的旧现场并从第一步重跑。`
                                + "同一任务编号会被覆盖，此操作不可撤销。",
                              confirmLabel: "清空并重跑",
                              danger: true,
                            })) return;
                            setBusy(entry.id);
                            setActionError("");
                            try {
                              const result = await rerunTaskFromStart(entry.id);
                              if (result.error) setActionError(result.error);
                              else {
                                await onChanged();
                                await load();
                              }
                            } catch (error) {
                              setActionError(error instanceof Error
                                ? error.message : String(error));
                            } finally {
                              setBusy("");
                            }
                          }}>
                          {busy === entry.id ? "处理中…" : "清空重跑"}
                        </DropdownMenuItem>
                      )}
                      {canDelete && (
                        <DropdownMenuItem variant="destructive"
                          disabled={Boolean(busy)} onClick={async () => {
                            if (!await confirmDialog({
                              title: "彻底删除任务",
                              message: `将彻底删除 ${entry.id}「${title}」。`
                                + "工作区、事件、检视与数据库历史都会永久删除，"
                                + "此操作不可撤销。",
                              confirmLabel: "彻底删除",
                              danger: true,
                            })) return;
                            setBusy(entry.id);
                            setActionError("");
                            try {
                              const result = await deleteHistoryTask(entry.id);
                              if (result.error) setActionError(result.error);
                              else {
                                await onChanged();
                                await load();
                              }
                            } catch (error) {
                              setActionError(error instanceof Error
                                ? error.message : String(error));
                            } finally {
                              setBusy("");
                            }
                          }}>
                          {busy === entry.id ? "删除中…" : "彻底删除"}
                        </DropdownMenuItem>
                      )}
                        </DropdownMenuContent>
                      </DropdownMenu>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
