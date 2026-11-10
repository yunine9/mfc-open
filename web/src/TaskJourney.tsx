import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/Alert";
import { Empty, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/Empty";
import { listTimeline, type TaskSummary, type TimelineEntry } from "./api";
import { formatLocalDateTime, formatLocalDate, formatLocalClock } from "./time";
import { Markdown } from "./markdown";
import { startVisiblePolling } from "./visiblePolling";
import { journeyCurrent, recentJourney } from "./journeyModel";
import { PrepushLiveLog, prepushActive } from "./PrepushLiveLog";
import { ComponentKnowledgeCheck } from "./ComponentKnowledgeCheck";
import { cn } from "cn";

const labels: Record<TimelineEntry["kind"], string> = {
  session: "执行", phase: "阶段", ask: "请求确认", decision: "人的决定",
  agent: "Agent 回应", quality: "验证结果", memory: "记录经验",
};

/** Keep complete Markdown intact; collapse by rendered height instead of cutting syntax. */
export function JourneyDetail({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollHeight > 240);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  // 皮(#233 收官):journey-detail 外壳换工具类;内层 Markdown 排版微调
  // 仍留在 tailwind.css 生成 DOM 段(.journey-detail .md-*),那是渲染器输出。
  return <div className="journey-detail relative mt-2">
    <div className={cn("relative", overflows && !expanded && "max-h-60 overflow-hidden after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-10 after:content-[''] after:bg-gradient-to-t after:from-transparent after:to-surface")}
      id={contentId} onFocusCapture={() => setExpanded(true)}>
      <div ref={body}><Markdown text={text} /></div></div>
    {overflows && <button type="button" className="mt-2 cursor-pointer border-0 bg-none p-0 text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded((value) => !value)}>{expanded ? "收起内容 ↑" : "展开完整内容 ↓"}</button>}
  </div>;
}

export function TaskJourney({ task, onLogs, onTiming }: {
  task: TaskSummary; onLogs: () => void; onTiming: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>();
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(12);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    let pending = false;
    setEntries(undefined); setError(""); setLimit(12);
    const stop = startVisiblePolling(() => {
      if (pending) return;
      pending = true;
      void listTimeline(task.id).then((result) => {
        if (!alive) return;
        if (result.unavailable) setError(result.unavailable);
        else { setEntries(result.entries ?? []); setError(""); }
      }).catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "进展暂时无法读取");
      }).finally(() => { pending = false; });
    }, 8000, document);
    return () => { alive = false; stop(); };
  }, [task.id, reload]);
  const current = journeyCurrent(task);
  // Agent 的话、举卡与人的决定已经在右栏会话流里;这一页只留"它具体干了什么":
  // 阶段推进、验证结论、记忆落账,以及执行日志入口(2026-09-05 用户拍板的分工:
  // 流回答"谁对谁说了什么",工作过程回答"它具体干了什么")。
  const ordered = recentJourney(entries ?? [])
    .filter((entry) => !["ask", "decision"].includes(entry.kind)
      && !(entry.kind === "agent" && ["Agent 的进展说明", "开发助手的进展说明"].includes(entry.title)));
  const days: Array<{ date: string; entries: Array<{ entry: TimelineEntry; key: string }> }> = [];
  const keys = new Map<string, number>();
  for (const entry of ordered.slice(0, limit)) {
    const date = formatLocalDate(entry.ts) || "时间未记录";
    if (days.at(-1)?.date !== date) days.push({ date, entries: [] });
    const identity = JSON.stringify([entry.ts, entry.kind, entry.title, entry.detail]);
    const occurrence = keys.get(identity) ?? 0;
    keys.set(identity, occurrence + 1);
    days.at(-1)!.entries.push({ entry, key: `${identity}:${occurrence}` });
  }
  const btn = "cursor-pointer rounded-[7px] border border-line bg-surface px-[11px] py-[7px] text-xs text-primary transition-colors hover:border-primary hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary";
  return <section className="mx-auto max-w-[920px] text-text" aria-label="Agent 工作过程">
    <header className="mb-7 flex items-start justify-between gap-6 max-[1440px]:flex-wrap max-[1440px]:gap-3.5">
      <div><h2>Agent 的工作过程</h2><p>阶段推进、验证结论与经验记录；Agent 的话、卡片和你的决定在右栏会话流。</p></div>
      <div className="flex shrink-0 gap-2"><button type="button" className={btn} onClick={onTiming}>耗时分析</button>
        <button type="button" className={btn} onClick={onLogs}>查看执行日志 ↗</button></div>
    </header>
    <div className={cn("mb-7 flex items-center gap-[9px] border-b border-t border-line py-[13px] text-xs text-primary",
      current.tone === "danger" && "text-danger", current.tone === "attention" && "text-attention")}>
      <i className="size-1.5 rounded-full bg-current" aria-hidden /><strong className="font-medium">{current.title}</strong>
      <span className="ml-auto text-muted-foreground">{task.progress?.current_phase}</span></div>
    {(task.execution_plan_alerts ?? []).length > 0 && <Alert variant="warning" className="mb-2">
      {(task.execution_plan_alerts ?? []).map((line, index) => <p className="m-0" key={index}>{line}</p>)}
    </Alert>}
    <ComponentKnowledgeCheck report={task.delivery?.component_knowledge} />
    {task.delivery?.prepush && <PrepushLiveLog taskId={task.id}
      active={prepushActive(task.delivery.prepush.state, task.delivery.prepush_runtime)}
      title={`Build-Fix · 编译与测试${task.delivery.prepush.round ? ` · 当前第 ${task.delivery.prepush.round} 轮` : ""}`}
      onLogs={onLogs} />}
    <div className="mb-[22px] flex items-center gap-3"><h3 className="m-0 text-sm">过程记录</h3><span className="text-[11px] text-faint">自动刷新 · 最近的在前</span></div>
    {error && <div className="py-5 text-[13px] leading-[1.7] text-muted-foreground" role="status"><strong className="font-medium text-text">暂时无法更新进展</strong><p className="m-0">{error}</p>
      {entries && <p className="m-0">下方保留上次读取的记录。</p>}<button type="button" className={btn} onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    {!entries && !error && <p className="py-5 text-[13px] leading-[1.7] text-muted-foreground" role="status">正在读取进展…</p>}
    {entries?.length === 0 && ordered.length === 0 && <Empty className="py-5"><EmptyTitle>还没有形成阶段记录</EmptyTitle>
      <EmptyDescription>当前状态见上方；需要查看启动或工具调用细节时，可以打开执行日志。</EmptyDescription>
      <EmptyContent><button type="button" onClick={onLogs}>查看执行日志</button></EmptyContent></Empty>}
    <div>{days.map((day) => <section className="mt-[26px]" key={day.date} aria-label={day.date}>
      <header className="mb-5 flex items-center gap-4 text-xs tabular-nums text-muted-foreground"><span>{day.date}</span><i className="h-px flex-1 bg-line opacity-60" aria-hidden /></header>
      <ol className="m-0 list-none p-0">{day.entries.map(({ entry, key }) => {
        return <li key={key} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3.5 pb-6 before:absolute before:bottom-0 before:left-[13px] before:top-[29px] before:w-px before:bg-line last:before:hidden">
          <span className={cn("grid size-7 place-items-center rounded-[9px] border border-line bg-surface text-[17px] text-muted-foreground",
            entry.tone === "danger" && "border-danger/30 text-danger",
            entry.tone === "success" && "text-success",
            entry.tone === "attention" && "text-attention")} aria-hidden>•</span>
          <article className="min-w-0 pt-1">
            <header className="flex items-center gap-3 text-xs leading-5">
              <strong className="font-medium text-muted-foreground">{labels[entry.kind]}</strong>
              <time className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-muted-foreground" dateTime={entry.ts} title={formatLocalDateTime(entry.ts, { seconds: true, year: true })}>{formatLocalClock(entry.ts)}</time>
            </header>
            <h4 className="mb-1.5 mt-1.5 text-[15px] font-semibold leading-[1.6] [overflow-wrap:anywhere]">{entry.title}</h4>
            {entry.detail && <JourneyDetail text={entry.detail} />}
          </article>
        </li>;
      })}</ol>
    </section>)}</div>
    {ordered.length > limit && <button type="button" className="cursor-pointer border-0 bg-none p-0 text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" onClick={() => setLimit((value) => value + 20)}>查看更早的进展（还有 {ordered.length - limit} 条）</button>}
  </section>;
}
