/**
 * 状态徽标(#216 徽标动物园收编):原 .pill 族(TaskCard/TaskWorkspace/
 * HistoryBoard/IssueBoard 四处的 `<span class="pill …"><i/>文案</span>`)
 * 统一为 shadcn Badge。状态→variant 词典只写这一份,状态语义一眼可辨:
 * 进行中=info(蓝)、等你/警示=warning(琥珀)、成功/归档=success(绿)、
 * 危险=destructive(红)、待合并=merge(紫)、闲置/已采纳=brand(主动作
 * 紫,存量 --accent 原色)、排队/暂停/取消=neutral(灰)。
 * 闪点沿用原 statusBlink 的"运行类状态呼吸"语义(animate-pulse,
 * prefers-reduced-motion 由 motion-reduce:animate-none 关掉)。
 */

import type { ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { cn } from "cn";
import type { IssueStatus, TaskStatus } from "./api";

type StatusVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/** 任务流词表(api.ts TaskStatus,原 style.css .pill 色板 1:1 收编)。 */
const TASK_STATUS_VARIANT: Record<TaskStatus, StatusVariant> = {
  queued: "neutral",
  running: "info",
  coordinating: "info",
  pausing: "warning",
  paused: "neutral",
  waiting_for_human: "warning",
  completed: "success",
  verifying: "info",
  await_merge: "merge",
  canceled: "neutral",
  failed: "destructive",
};
/** 任务侧闪点词表(原 .pill.running/coordinating/pausing/verifying i 呼吸)。 */
const TASK_BLINK = new Set<TaskStatus>([
  "running", "coordinating", "pausing", "verifying",
]);

/** 卡片左缘状态细轨色(#227 换装:原 style.css .status-* .task-status-rail
 * 色板 1:1 收编为工具类词典,任务列表卡与问题列表卡共用这一份)。 */
export const TASK_STATUS_RAIL: Record<TaskStatus, string> = {
  queued: "bg-line-strong",
  running: "bg-active",
  coordinating: "bg-active",
  pausing: "bg-attention",
  paused: "bg-line-strong",
  waiting_for_human: "bg-attention",
  completed: "bg-success",
  verifying: "bg-active",
  await_merge: "bg-merge",
  canceled: "bg-transparent",
  failed: "bg-danger",
};

/** 问题流词表(api.ts IssueStatus,原 issue-card-large 配色 1:1 收编)。 */
const ISSUE_STATUS_VARIANT: Record<IssueStatus, StatusVariant> = {
  queued: "info",
  running: "info",
  waiting_user: "warning",
  idle: "brand",
  archived: "success",
  canceled: "neutral",
  failed: "destructive",
};
/** 问题侧闪点词表(原 .issue-card-large waiting_user/running/queued i 呼吸)。 */
const ISSUE_BLINK = new Set<IssueStatus>([
  "waiting_user", "running", "queued",
]);

function StateBadge({
  variant,
  blink,
  className,
  dotClassName,
  textClassName,
  children,
}: {
  variant: StatusVariant;
  blink: boolean;
  className?: string;
  dotClassName?: string;
  textClassName?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant={variant} className={cn("gap-1.5", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          blink && "animate-pulse motion-reduce:animate-none",
          dotClassName,
        )}
      />
      <span className={textClassName}>{children}</span>
    </Badge>
  );
}

export function TaskStatusBadge({
  status,
  className,
  dotClassName,
  textClassName,
  children,
}: {
  status: TaskStatus;
  className?: string;
  dotClassName?: string;
  textClassName?: string;
  children: ReactNode;
}) {
  return (
    <StateBadge variant={TASK_STATUS_VARIANT[status]}
      blink={TASK_BLINK.has(status)}
      className={className} dotClassName={dotClassName}
      textClassName={textClassName}>
      {children}
    </StateBadge>
  );
}

export function IssueStatusBadge({
  status,
  className,
  dotClassName,
  textClassName,
  children,
}: {
  status: IssueStatus;
  className?: string;
  dotClassName?: string;
  textClassName?: string;
  children: ReactNode;
}) {
  return (
    <StateBadge variant={ISSUE_STATUS_VARIANT[status]}
      blink={ISSUE_BLINK.has(status)}
      className={className} dotClassName={dotClassName}
      textClassName={textClassName}>
      {children}
    </StateBadge>
  );
}
