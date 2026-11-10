/**
 * 环境预热编译面板(用户点名:预热进展必须清楚可见,"开始就爆红是
 * 好事")。跑的时候实时滚命令流;收口后折叠成一行结果。失败亮牌时
 * 必须说清责任:基线红=环境或上游的锅,与本单增量无关。
 */

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Empty, EmptyDescription } from "@/components/Empty";
import { cn } from "cn";
import { PrepushLiveLog } from "./PrepushLiveLog";
import { tailWarmupEvents, type TaskSummary } from "./api";

/** 预热徽标状态→Badge variant(#216;原 .warmup-badge is-* 色板收编)。 */
const WARMUP_VARIANT = {
  running: "info",
  passed: "success",
  failed: "destructive",
  infrastructure_failure: "warning",
  unknown: "neutral",
  reclaimed: "neutral",
} as const;

/** 可拖拽、可缩放的浮层(用户点名"能支持拖拽放大不"):标题栏拖动
 * 移动,右下角原生 resize 拉大;portal 到 body 逃出祖先层叠上下文
 * (实锤:留在头部 DOM 里 z-index 再高也被 sticky 进度条盖)。 */
export function OverlayDialog({
  ariaLabel,
  title,
  onClose,
  children,
}: {
  ariaLabel: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragFrom = useRef<{
    px: number; py: number; ox: number; oy: number;
  } | null>(null);
  // "点背景关闭"必须按下与松开都落在背景上。实锤:拖右下角 resize 时
  // 按下在弹窗、松手滑到背景,浏览器把合成 click 派发到共同祖先(背景
  // 层),整个浮层被误关——用户拖大窗口,窗口没了。
  const pressedBackdrop = useRef(false);
  return createPortal(
    <div className="warmup-overlay" role="dialog" aria-modal="true"
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        const pressed = pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (pressed && event.target === event.currentTarget) onClose();
      }}>
      <div className="warmup-dialog"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
        <header className="warmup-dialog-drag"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            dragFrom.current = {
              px: event.clientX, py: event.clientY,
              ox: offset.x, oy: offset.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const from = dragFrom.current;
            if (!from) return;
            setOffset({
              x: from.ox + event.clientX - from.px,
              y: from.oy + event.clientY - from.py,
            });
          }}
          onPointerUp={() => { dragFrom.current = null; }}>
          <strong>{title}</strong>
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Readiness is visible beside progress; details use the workspace's shared dialog. */
export function WarmupBadge({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const receipt = task.baseline_build;
  const state = task.workspace_reclaimed_at ? "reclaimed" : receipt?.status ?? "unknown";
  const labels = { running: "准备中", passed: "已就绪", failed: "失败", infrastructure_failure: "准备中断", unknown: "暂无记录", reclaimed: "现场已回收" };
  const descriptions = {
    running: "正在编译原有代码并准备构建缓存，点击查看实时过程。",
    passed: "开工前编译已通过，构建缓存已就绪；本次修改的验证结果另见推送前验证。",
    failed: "开工前编译失败，点击查看环境或上游问题。",
    infrastructure_failure: "基础设施问题导致准备未完成，点击查看原因。",
    unknown: "尚未收到开工前编译记录，暂时无法确认是否就绪。",
    reclaimed: "任务现场已回收，之前的编译记录仅供查看。",
  };
  /* #216 收编为 Badge(render 成 button 保留点击开浮层);原 is-* 色板
   * 映射:running=info(呼吸点)、passed=success、failed=destructive、
   * infrastructure_failure=warning、unknown/reclaimed=neutral。#220 悬停
   * 描述由原生 title 换 Tooltip 原语(文案原样进浮层)。 */
  return <Tooltip>
    <TooltipTrigger render={
      <Badge variant={WARMUP_VARIANT[state]} render={
          <button type="button" aria-haspopup="dialog" onClick={onOpen} />
        }
        className="cursor-pointer outline-none hover:border-current">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current",
          state === "running" && "animate-pulse motion-reduce:animate-none")} />
        <span>开工前编译</span><b className="font-semibold">{labels[state]}</b><span aria-hidden>↗</span>
      </Badge>
    } />
    <TooltipContent className="max-w-72 text-left whitespace-normal">{descriptions[state]}</TooltipContent>
  </Tooltip>;
}

/** 面板壳的状态皮(#232 换装:原 .warmup-panel is-* 色板直译):
 * 圆点随状态变色,运行态呼吸;失败整卡描红线、摘要字同色。 */
const WARMUP_DOT = {
  running: "bg-(--accent) animate-pulse motion-reduce:animate-none",
  passed: "bg-success",
  failed: "bg-danger",
  infrastructure_failure: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
  reclaimed: "bg-muted-foreground",
} as const;

export function WarmupPanel({ task }: { task: TaskSummary }) {
  const receipt = task.baseline_build;
  if (!receipt) return <Empty role="status" className="py-6"><EmptyDescription>尚未收到开工前编译记录，暂时无法确认是否就绪。收到检查结果后，顶部状态会自动更新。</EmptyDescription></Empty>;
  const running = receipt.status === "running";
  const failed = receipt.status === "failed";
  return (
    /* #232 换装:面板壳原 .warmup-panel is-* 皮退役,直译工具类;
       浮窗机构(warmup-overlay/warmup-dialog,拖拽缩放)一行不动。 */
    <section
      className={cn("flex flex-col gap-[7px] rounded-[10px] border bg-surface px-3.5 py-2.5 text-[13px]",
        failed && "border-destructive")}
      aria-label="环境预热编译">
      <header className="flex items-center gap-2 text-muted-foreground">
        <i aria-hidden className={cn("size-2 flex-none rounded-full",
          WARMUP_DOT[receipt.status] ?? WARMUP_DOT.unknown)} />
        <strong className="text-[13.5px] text-text-strong">开工前编译</strong>
        <span className={failed ? "text-danger" : undefined}>
          {receipt.status === "running"
            ? `正在编译基线 ${receipt.sha.slice(0, 12)},为增量编译焐热缓存`
            : receipt.status === "passed"
              ? `开工前编译通过(${receipt.sha.slice(0, 12)}),构建缓存已就绪`
              : receipt.status === "failed"
                ? "开工前编译失败——环境或上游问题,与本单增量无关"
                : "预热未完成(基础设施问题),不代表开工前编译失败"}
        </span>
      </header>
      {task.workspace_reclaimed_at && <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">任务现场已回收，以下是回收前的检查记录，不代表当前现场仍可使用。</p>}
      {receipt.detail && receipt.status !== "passed" && !running && (
        <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{receipt.detail}</p>
      )}
      {receipt.build_command && receipt.status === "passed" && (
        <p className="m-0 text-sm text-muted-foreground">
          验证过的构建入口:<code className="text-text-strong [overflow-wrap:anywhere]">{receipt.build_command}</code>
        </p>
      )}
      {running && (
        <PrepushLiveLog taskId={task.id} active
          source={tailWarmupEvents}
          title="预热过程"
          emptyText="等待预热专员的第一条命令……" />
      )}
    </section>
  );
}
