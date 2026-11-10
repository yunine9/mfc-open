import { PersonName } from "./People";
import { formatLocalDateTime, relativeTime } from "./time";
import { Button } from "@/components/ui/button";

/** Overview navigation only: task details and actions live in the workspace.
 * 问题行(ADR-0040)传 href:整行是 `<a target="_blank">` 新页签打开问题
 * 工作台;任务行照旧按钮 + onOpen 页内打开。两种形态共用 task-overview-open
 * 版式(该类自带按钮复位,锚点直接可用),文本装饰由调用侧收口。 */
export function TaskOverviewRow({ id, ticket, title, status, statusLabel, owner,
  updatedAt, timeLabel = "最近更新", detail, child = false, focused = false, issue = false, onOpen, href,
  attention = false, childCount = 0, parentId, parentLabel, parentTitle, onOpenParent,
}: {
  id: string; ticket?: string; title: string; status: string; statusLabel: string;
  owner?: string; updatedAt: string; timeLabel?: string; detail?: string; child?: boolean;
  focused?: boolean; issue?: boolean; onOpen?: () => void; href?: string;
  attention?: boolean;
  childCount?: number; parentId?: string; parentLabel?: string; parentTitle?: string; onOpenParent?: () => void;
}) {
  const tone = status === "failed" ? "danger"
    : attention || ["waiting_for_human", "waiting_user", "idle", "paused"].includes(status) ? "attention"
    : ["completed", "archived"].includes(status) ? "done"
    : status === "await_merge" ? "merge"
    : ["running", "verifying", "coordinating", "pausing"].includes(status) ? "active" : "quiet";
  const openLabel = `打开${issue ? "问题" : "任务"}工作台：${title}`;
  const openClass = "task-overview-open no-underline";
  // 行内容两形态同体:href 在场是锚点(新页签),否则维持按钮(页内)。
  const OpenTag = href ? "a" : "button";
  const openProps = href
    ? { href, target: "_blank", rel: "noreferrer", "aria-label": openLabel }
    : { type: "button" as const, onClick: onOpen, "aria-label": openLabel };
  return <article data-status-tone={tone} id={`${issue ? "issue" : "task"}-${id}`}
    className={`task-overview-row status-${status}${child ? " is-child" : ""}${focused ? " focused" : ""}`}>
    <OpenTag className={openClass} {...openProps}>
      {issue
        ? <span className="task-overview-id" title={`${ticket ?? ""} ${id}`}>{ticket || id}</span>
        : <span className="task-overview-id" title={ticket ? `Task ID：${id}；AR：${ticket}` : `Task ID：${id}`}>
          <code>{id}</code>
          {ticket && <small>{ticket}</small>}
        </span>}
      <strong className="task-overview-title" title={title}>{child && <small>子任务 · </small>}{issue && <small>问题 · </small>}{title}</strong>
      <span className={`task-overview-status ${status}`} title={detail || statusLabel}><i aria-hidden />{statusLabel}</span>
      <span className="task-overview-owner" title={`负责人：${owner ?? "未分配"}`}><PersonName account={owner} /></span>
      <time className="task-overview-time" dateTime={updatedAt} title={`${timeLabel}：${formatLocalDateTime(updatedAt)}`}>{relativeTime(updatedAt) || "刚刚"}</time>
      <span className="task-overview-arrow" aria-hidden>›</span>
    </OpenTag>
    <span className="task-overview-relation">
      {parentId ? <Button type="button" variant="link" size="xs"
        disabled={!onOpenParent} onClick={onOpenParent}
        className="h-auto min-w-0 max-w-full overflow-hidden px-0 text-left text-ink"
        aria-label={`返回主任务：${parentTitle || parentId}`}
        title={`主任务：${parentTitle || parentId}（${parentLabel || parentId}）${!onOpenParent ? "；当前无可打开的主任务" : ""}`}>
        <span aria-hidden>↳ </span><span className="truncate">{parentLabel || parentId}</span>
      </Button> : childCount > 0 ? <span title={`主任务，共 ${childCount} 个子任务；进入工作台查看全部`}>
        主任务 · {childCount}<span className="task-overview-children-word"> 子任务</span>
      </span> : null}
      {parentId && childCount > 0 && <small title={`${childCount} 个下级任务`}> · {childCount} 子</small>}
    </span>
  </article>;
}
