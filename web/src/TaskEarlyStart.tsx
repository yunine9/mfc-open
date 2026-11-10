import { useEffect, useRef, useState } from "react";
import { previewTaskEarlyStart, startTaskEarly, type EarlyStartPreview, type TaskSummary } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

function TaskNames({ items }: { items: EarlyStartPreview["parallel"] }) {
  return <ul className="space-y-1.5 text-sm">{items.map(item => <li key={item.id} className="flex min-w-0 gap-2">
    <span className="shrink-0 text-muted-foreground">{item.id}</span>
    <span className="min-w-0 break-words">{item.title}{item.ticket && <span className="ml-2 text-muted-foreground">{item.ticket}</span>}</span>
  </li>)}</ul>;
}

/** 只呈现宿主计算的影响；不在浏览器推导依赖、并发关系或单号权限。 */
export function TaskEarlyStart({ task, onChanged, onOpenTask }: {
  task: TaskSummary; onChanged(): void; onOpenTask?: (id: string) => void;
}) {
  const [view, setView] = useState<EarlyStartPreview>();
  const [open, setOpen] = useState(false);
  const [released, setReleased] = useState<string[]>([]);
  const [ticket, setTicket] = useState(task.ticket ?? "");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const waiting = task.status === "queued" && !!task.blocked_by?.length;
  const signature = `${task.id}:${task.status}:${task.ticket}:${task.blocked_by?.join(",")}`;
  const last = task.dependency_adjustments?.at(-1);

  async function load(input?: { release_ids: string[]; ticket: string }, initialize = false) {
    const request = ++sequence.current; setLoading(true);
    try {
      const next = await previewTaskEarlyStart(task.id, input);
      if (request !== sequence.current) return;
      setView(next);
      if (initialize) { setReleased(next.release_ids); setTicket(next.ticket); }
    } catch (cause) {
      if (request === sequence.current) setError(cause instanceof Error ? cause.message : "影响范围读取失败，请重试");
    } finally { if (request === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    setOpen(false); setView(undefined); setError("");
    if (waiting) void load(undefined, true);
    return () => { sequence.current++; };
  }, [signature]);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const timer = setTimeout(() => { void load({ release_ids: released, ticket }); }, 200);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [open, ticket, released.join(",")]);

  const previewCurrent = view && view.ticket === ticket.trim()
    && JSON.stringify([...released].sort()) === JSON.stringify(view.release_ids);
  async function apply() {
    if (!view || !previewCurrent || loading || busy) return;
    setBusy(true); setError("");
    try {
      await startTaskEarly(task.id, { release_ids: released, ticket: view.ticket, revision: view.revision });
      setOpen(false); onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "调整没有完成，请重试");
      await load(undefined, true);
    } finally { setBusy(false); }
  }
  if (!waiting && !last) return null;
  return <div className="tw-root">
    {waiting && <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{view && !view.prerequisites.length ? "等待执行名额" : "等待前置任务"}</span>
        {view?.can_operate && <Button size="sm" variant="outline" disabled={!view.available || loading}
          onClick={() => { setError(""); setOpen(true); }} title={view.unavailable_reason}>提前开始</Button>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {(view?.prerequisites.map(item => item.id) ?? task.blocked_by ?? []).map(id => <button type="button" className="hover:underline"
          key={id} onClick={() => onOpenTask?.(id)} disabled={!onOpenTask}>{id}</button>)}
        {view && !view.can_operate && <span>由主任务责任人 {view.owner} 调整</span>}
      </div>
      {view?.can_operate && !view.available && view.unavailable_reason &&
        <p className="mt-1 text-xs text-muted-foreground" role="status">{view.unavailable_reason}</p>}
      {!open && error && <div className="mt-2 text-sm text-destructive" role="alert">{error}
        <button type="button" className="ml-2 underline" onClick={() => { setError(""); void load(undefined, true); }}>重试</button></div>}
    </div>}
    {last && <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">{last.by} 已调整执行顺序</summary>
      <div className="mt-2 space-y-1"><p>不再等待：{last.no_longer_waiting.join("、") || last.released.join("、")}</p>
        <p>AR：{last.ticket} · {new Date(last.at).toLocaleString()}</p></div>
    </details>}
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="tw-root sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>提前开始</DialogTitle>
          <DialogDescription>{task.id} · {task.title || "当前任务"}</DialogDescription>
        </DialogHeader>
        {view && <div className="space-y-4" aria-busy={loading}>
          {view.prerequisites.length > 1 && <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">选择不再等待的前置任务</legend>
            {view.prerequisites.map(item => <label key={item.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 accent-primary" disabled={busy} checked={released.includes(item.id)} onChange={event => {
                setError(""); setReleased(event.target.checked ? [...released, item.id] : released.filter(id => id !== item.id));
              }} /><span>{item.id} · {item.title}</span>
            </label>)}
          </fieldset>}
          <section className="rounded-lg bg-muted/50 p-3">
            <h3 className="mb-2 text-sm font-medium">将不再等待</h3>
            {view.no_longer_waiting.length ? <TaskNames items={view.no_longer_waiting} /> : <p className="text-sm text-muted-foreground">尚未选择，或仍通过其他前置任务间接等待。</p>}
          </section>
          {view.remaining.length > 0 && <section><h3 className="mb-2 text-sm font-medium">仍需等待</h3><TaskNames items={view.remaining} /></section>}
          {view.downstream.length > 0 && <section className="space-y-2 text-sm">
            <h3 className="font-medium">后续任务也可能提前</h3>
            {view.downstream.map(item => <div key={item.task.id}>
              <p>{item.task.id} · {item.task.title}</p>
              <p className="text-muted-foreground">也将不再等待 {item.no_longer_waiting.map(other => other.id).join("、")}</p>
            </div>)}
          </section>}
          {view.parallel.length > 0 && <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">可能并行的任务（{view.parallel.length}）</summary>
            <div className="mt-2"><TaskNames items={view.parallel} /></div>
          </details>}
          <div>
            <label htmlFor={`early-ticket-${task.id}`} className="mb-1.5 block text-sm font-medium">此任务的 AR 单号</label>
            <Input id={`early-ticket-${task.id}`} value={ticket} disabled={busy} autoComplete="off"
              onChange={event => { setError(""); setTicket(event.target.value); }} />
            <p className="mt-1.5 text-xs text-muted-foreground">同仓并行需使用不同单号；不同仓或串行可以相同。</p>
          </div>
          {view.errors.length > 0 && <div className="rounded-md bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            {view.errors.map(message => <p key={message}>{message}</p>)}
          </div>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!view.available && <p role="alert" className="text-sm text-destructive">{view.unavailable_reason}</p>}
          <p className="text-sm text-muted-foreground">{view.result}。请自行确认代码和接口是否可以独立开发。</p>
        </div>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button disabled={busy || loading || !previewCurrent || !view?.available || !view.can_operate || !!view.errors.length}
            onClick={() => void apply()}>{busy ? "正在调整…" : loading ? "正在核对影响…" : view?.remaining.length ? "确认解除所选等待" : "确认提前开始"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
