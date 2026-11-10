import { useCallback, useEffect, useRef, useState } from "react";
import { RequirementDiff } from "./RequirementDiff";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "cn";

export const OVERALL_STORY_ARTIFACT = "task-materials/overall-story.md";
interface Source { id: string; task_id?: string; name: string; missing?: string }
export interface OverallStoryStatus {
  eligible: boolean; current?: string; stale: boolean; label: string;
  sources: Source[]; pending_reviews: number; can_confirm: boolean;
  revisions: Array<{ id: string; at: string; by: string; additions: number; deletions: number }>;
  confirmed?: { revision: string; by: string; at: string };
  job?: { id: string; started_at: string; kind?: "architecture" }; error?: string;
  error_kind?: "story" | "architecture";
}
async function requestStory(taskId: string, action = "", body?: object): Promise<OverallStoryStatus> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/overall-story${action}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败（${response.status}）`);
  return result;
}

/** 状态局部轮询；只在文档版本变化时刷新阅读器，不让正文随 Agent 日志闪烁。 */
export function OverallStoryTools({ taskId, canOperate, canceled, onUpdated, onOpenTask, fileName = "story.md" }: {
  fileName?: string; taskId: string; canOperate: boolean; canceled: boolean;
  onUpdated(): void; onOpenTask?(id: string): void;
}) {
  const [status, setStatus] = useState<OverallStoryStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState("");
  const [diff, setDiff] = useState<string>();
  const previous = useRef<string | undefined>(undefined);
  const update = useRef(onUpdated); update.current = onUpdated;
  const accept = useCallback((next: OverallStoryStatus) => {
    if (next.current !== previous.current) {
      previous.current = next.current;
      if (next.current) update.current();
    }
    setStatus(next);
  }, []);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    previous.current = undefined; setStatus(undefined); setError("");
    const refresh = async () => {
      try { const next = await requestStory(taskId); if (alive) { accept(next); setError(""); } }
      catch (e) { if (alive) setError(String(e instanceof Error ? e.message : e)); }
      if (alive) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [taskId, accept]);
  useEffect(() => {
    setDiff(undefined);
    if (!revision) return;
    let alive = true;
    void fetch(`/tasks/${encodeURIComponent(taskId)}/overall-story/revisions/${encodeURIComponent(revision)}`)
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error); return body; })
      .then((body) => { if (alive) setDiff(String(body.diff)); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [taskId, revision]);
  async function act(action: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { accept(await requestStory(taskId, action, action === "/confirm" ? { revision: status?.current } : {})); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  if (status && !status.eligible) return null;
  // 皮(#233 收官):原 overall-story.css 换装为工具类,该段已删除。
  const btn = "min-h-8 cursor-pointer whitespace-nowrap rounded-[7px] border border-line-strong bg-surface px-2.5 py-1.5 text-xs text-text transition-colors hover:border-primary hover:text-primary disabled:cursor-default disabled:opacity-50";
  return <section className="mx-[18px] flex-none border-b border-line bg-surface" aria-label={`${fileName} 维护`}>
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="text-xs text-muted-foreground">{status?.label.replace(/整体 Story|全局 Story/g, fileName) ?? "读取文档状态…"}</span>
      <div className="flex shrink-0 items-center gap-2">
        {canOperate && !canceled && status?.current && (status.job
          ? <button type="button" className={btn} disabled={busy} onClick={() => void act("/stop")}>停止整理</button>
          : <button type="button" className={cn(btn, status.stale && "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")}
              disabled={busy || !status} onClick={() => void act("")}>
              {busy ? "请求中…" : `更新 ${fileName}`}</button>)}
        <button type="button" className={cn(btn, "border-transparent bg-transparent text-muted-foreground hover:border-transparent")} aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}>来源与版本 {expanded ? "⌃" : "⌄"}</button>
      </div>
    </div>
    {(error || (status?.error_kind !== "architecture" && status?.error))
      && <p className="mx-4 mb-3 text-[13px] text-danger" role="alert">{error || status?.error}</p>}
    {expanded && status && <div className="border-t border-line px-4 py-3.5 text-[13px]">
      <p className="mb-3 leading-loose text-muted-foreground">维护全局设计、模块依赖和验收依据，子任务 Story 提供实现细化与变更反馈。子任务变化只提醒待同步，由责任人主动更新。可在正文划选批注，提交后由 Agent 修改当前文档，再由意见作者复检。</p>
      <ul className="mb-4 grid list-none grid-cols-2 gap-x-6 gap-y-1.5 p-0">{status.sources.map((s) => <li key={s.id} className="flex items-baseline justify-between gap-3 border-b border-line py-1.5">
        {s.task_id && onOpenTask ? <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-primary hover:underline" onClick={() => onOpenTask(s.task_id!)}>{s.name} ↗</button> : <strong>{s.name}</strong>}
        <span className={cn("text-xs", s.missing ? "text-attention" : "text-muted-foreground")}>{s.missing ?? "Story 可读取"}</span>
      </li>)}</ul>
      <div className="mb-3 flex items-center gap-4">
        <label className="flex items-center gap-2.5 text-xs">更新对比 <Select value={revision}
          items={[{ value: "", label: "选择版本" },
            ...[...status.revisions].reverse().map((r, i) => ({
              value: r.id,
              label: `第 ${status.revisions.length - i} 版 · ${new Date(r.at).toLocaleString()} · +${r.additions} −${r.deletions}`,
            }))]}
          onValueChange={(value) => setRevision(value ?? "")}>
          <SelectTrigger className="max-w-105" aria-label="更新对比版本"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="">选择版本</SelectItem>
              {[...status.revisions].reverse().map((r, i) => <SelectItem key={r.id} value={r.id}>
                第 {status.revisions.length - i} 版 · ${new Date(r.at).toLocaleString()} · +${r.additions} −${r.deletions}
              </SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select></label>
        {canOperate && status.current && status.confirmed?.revision !== status.current && <button type="button" className={btn}
          disabled={busy || !status.can_confirm}
          title={!status.can_confirm ? "来源已同步、检视意见全部闭环后可以确认" : "确认当前版本的整体文档"}
          onClick={() => void act("/confirm")}>确认这版 {fileName}</button>}
        {status.confirmed?.revision === status.current && <span>已由 {status.confirmed?.by} 确认</span>}
      </div>
      {status.pending_reviews > 0 && <p>{status.pending_reviews} 条文档意见尚未闭环，请在「批注与检视」中处理。</p>}
      {revision && <div className="max-h-[300px] overflow-auto rounded-lg border border-line">{diff === undefined ? "读取版本差异…" : <RequirementDiff text={diff} />}</div>}
    </div>}
  </section>;
}
