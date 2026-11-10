/** 经验沉淀的唯一审查入口：候选留档、人工采纳与使用足迹集中展示。 */
import { useEffect, useMemo, useState } from "react";
import { getMemoryInsights, readMemoryInsight, createMemoryDraft, type MemoryInsights, type MemoryRecord } from "./api";
import { memoryPreparation, memorySearchPresentation, memoryReviewFocus, memoryCounts } from "./memoryPresentation";
import { MemoryReviewEditor } from "./MemoryReviewEditor";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { confirmDialog } from "./ConfirmDialog";

const scopes = { local: "本仓相关位置", general: "本仓通用", platform: "跨仓通用", one_off: "仅检索参考" };
export function MemoryBoard({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [insights, setInsights] = useState<MemoryInsights>();
  const [error, setError] = useState("");
  const [focusError, setFocusError] = useState("");
  const [tab, setTab] = useState("pending");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sourceTask, setSourceTask] = useState(() => new URLSearchParams(location.search).get("source_task") ?? "");
  const [selected, setSelected] = useState<{ record: MemoryRecord; content: string }>();
  const [dirty, setDirty] = useState(false);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(0);
  async function load() { setInsights(await getMemoryInsights()); setError(""); }
  useEffect(() => {
    let alive = true;
    const refresh = () => getMemoryInsights().then(value => { if (alive) { setInsights(value); setError(""); } })
      .catch(reason => { if (alive) setError(String(reason)); });
    void refresh(); const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const id = memoryReviewFocus(location.search);
    if (!id) return;
    let alive = true;
    setOpening(true);
    void readMemoryInsight(id).then(value => {
      if (!alive) return;
      if (!value) throw new Error("这条经验已不可用，请在列表中查看其他记录");
      setSelected(value);
      setTab(value.record.archived || value.record.withdrawn || value.record.superseded_by ? "all"
        : value.record.review?.status === "accepted" ? "accepted"
        : value.record.review?.status === "rejected" ? "rejected" : value.record.can_review ? "pending" : "all");
    }).catch(reason => { if (alive) setFocusError(String(reason)); })
      .finally(() => { if (alive) setOpening(false); });
    return () => { alive = false; };
  }, []);
  function clearFocus() {
    const url = new URL(location.href); url.searchParams.delete("memory_id");
    history.replaceState(history.state, "", url);
    setSelected(undefined); setDirty(false); setFocusError("");
  }
  const rows = useMemo(() => (insights?.memories ?? []).filter(row => (tab === "all" || tab === "rejected" || (!row.withdrawn && !row.superseded_by && !row.archived))
    && (scopeFilter === "all" || (scopeFilter === "module" ? !!row.module : scopeFilter === "platform" ? !row.module && row.scope === "platform" : !row.module && row.scope !== "platform"))
    && (!sourceTask || row.task === sourceTask)
    && (tab === "all" || (tab === "rejected" ? row.archived || row.withdrawn || row.superseded_by || row.review?.status === "rejected" : (row.review?.status ?? "pending") === tab))
    && (tab !== "pending" || row.can_review)
    && (!query.trim() || `${row.trigger} ${row.conclusion} ${row.repo}`.includes(query.trim()))), [insights, sourceTask, tab, query, scopeFilter]);
  const { pending } = memoryCounts(insights?.memories ?? []);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1));
  async function dismiss() { if (dirty && !await confirmDialog({ title: "尚未保存的编辑将被放弃，继续吗？", danger: true })) return; clearFocus(); }
  async function open(id: string) {
    if (opening) return;
    setOpening(true); setError("");
    try { const value = await readMemoryInsight(id); if (!value) throw new Error("记录已不可用，请刷新"); setSelected(value); setDirty(false); setFocusError("");
      const url = new URL(location.href); url.searchParams.set("memory_id", id); history.replaceState(history.state, "", url); }
    catch (reason) { setError(String(reason)); } finally { setOpening(false); }
  }
  return <section className="grid gap-4 rounded-xl border border-border bg-surface p-5" aria-label="经验沉淀">
    <header className="flex items-start justify-between gap-4">
      <div><h2 className="text-xl font-semibold">经验沉淀</h2>
        <p className="mt-1 text-sm text-muted-foreground">MR 合入完成后，结合检视意见和后续代码修改整理草稿；主动记录也保存在这里。修改并采纳后供 Agent 复用。</p></div>
      {selected ? <Button variant="outline" onClick={dismiss}>返回经验列表</Button>
        : <div className="flex gap-2"><Button variant="outline" onClick={() => void load().catch(reason => setError(String(reason)))}>刷新</Button><Button onClick={() => setCreating(!creating)}>新增经验</Button></div>}
    </header>
    {creating && <form className="grid gap-3 rounded-lg border bg-muted/20 p-4" onSubmit={event => {
      event.preventDefault(); if (saving) return; setSaving(true);
      void createMemoryDraft(newTitle, newBody).then(async row => { setCreating(false); setNewTitle(""); setNewBody(""); setTab("pending"); await load(); await open(row.id); })
        .catch(reason => setError(String(reason))).finally(() => setSaving(false));
    }}><h3 className="font-semibold">新增经验草稿</h3><Input aria-label="经验标题" placeholder="什么情况下使用（最多80字）" maxLength={80} value={newTitle} onChange={e => setNewTitle(e.target.value)} />
      <Textarea aria-label="经验内容" rows={4} placeholder="记录做法、依据与适用例外，保存后可继续完善范围并采纳。" value={newBody} onChange={e => setNewBody(e.target.value)} />
      <div className="flex gap-2"><Button type="submit" disabled={saving || !newTitle.trim() || !newBody.trim()}>保存并审查</Button><Button type="button" variant="outline" onClick={() => setCreating(false)}>取消</Button></div></form>}
    {(error || focusError) && <p role="alert" className="text-sm text-destructive">{focusError || error}</p>}
      <div className="flex items-center gap-2" aria-label="经验状态">
        {[["pending", `待确认 ${pending}`], ["accepted", "已采纳"], ["rejected", "已停用"], ["all", "全部记录"]].map(([value, label]) =>
          <Button key={value} variant={tab === value ? "default" : "outline"} size="sm" onClick={async () => { if (dirty && !await confirmDialog({ title: "放弃尚未保存的修改？", danger: true })) return; clearFocus(); setTab(value); setPage(0); }}>{label}</Button>)}
      </div>
      <div className="flex items-center gap-3"><Input className="max-w-lg" aria-label="搜索经验" placeholder="搜索经验、代码仓" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        <select aria-label="筛选复用范围" className="rounded-md border bg-surface p-2 text-sm" value={scopeFilter} onChange={e => { setScopeFilter(e.target.value); setPage(0); }}><option value="all">全部范围</option><option value="platform">平台通用</option><option value="module">业务模块</option><option value="repo">代码仓</option></select>
        {sourceTask && <Button variant="outline" size="sm" onClick={() => { setSourceTask(""); setPage(0); const url = new URL(location.href); url.searchParams.delete("source_task"); history.replaceState(history.state, "", url); }}>{sourceTask} · 清除来源筛选</Button>}
        <span className="ml-auto text-sm text-muted-foreground">{memorySearchPresentation(insights?.sidecar).label}</span></div>
    {selected ? <>
      <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>{selected.record.trigger} · {memoryPreparation(selected.record).label}</span>
        {selected.record.task && <Button variant="outline" size="sm" onClick={() => { if (onOpenTask) onOpenTask(selected.record.task); else location.assign(`/work/${encodeURIComponent(selected.record.task)}`); }}>查看来源任务 {selected.record.task}</Button>}</div>
      <div className="grid grid-cols-[minmax(260px,26%)_minmax(0,1fr)] items-start gap-4">
      <aside className="grid max-h-[min(650px,65vh)] gap-2 overflow-auto rounded-xl border border-border bg-muted/30 p-3" aria-label="经验候选列表">
        <h3 className="p-2 font-semibold">{tab === "pending" ? `待确认 · ${pending}` : "经验列表"}</h3>
        {rows.map(row => <Button key={row.id} variant={row.id === selected.record.id ? "secondary" : "ghost"}
          className="h-auto min-h-16 justify-start whitespace-normal p-3 text-left" disabled={opening}
          onClick={async () => { if (row.id !== selected.record.id && (!dirty || await confirmDialog({ title: "切换候选将放弃尚未保存的编辑，继续吗？", danger: true }))) void open(row.id); }}>
          <span><span className="line-clamp-2">{row.trigger}</span><span className="mt-1 block text-sm font-normal text-muted-foreground">{row.task} · {row.repo}</span></span>
        </Button>)}
      </aside>
      <MemoryReviewEditor stacked key={`${selected.record.id}:${selected.record.revision ?? 1}`} taskId={selected.record.task} record={selected.record}
        onDirty={setDirty} onDismiss={dismiss} onChanged={async () => { setDirty(false); await load(); const updated = await readMemoryInsight(selected.record.id); if (updated) { setSelected(updated); setTab(updated.record.review?.status ?? "pending"); } }} />
      </div>
      <details className="text-sm"><summary className="cursor-pointer">完整留档与来源标识</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3">{selected.content}</pre></details>
    </> : <>
      <div className="grid gap-2">{rows.slice(currentPage * 10, (currentPage + 1) * 10).map(row => <article key={row.id} className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0"><h3 className="text-base font-medium">{row.trigger}</h3><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{row.conclusion}</p>
          <p className="mt-2 text-sm text-muted-foreground">{row.task || "手工新增"} · {row.module ? `模块：${row.module}` : scopes[row.scope]}{row.scope !== "platform" && !row.module ? ` · ${row.repo}` : ""} · {row.archived ? "已归档" : row.withdrawn || row.superseded_by ? "已撤回" : memoryPreparation(row).label}</p>
          {row.review?.status === "accepted" && <p className="mt-1 text-sm text-muted-foreground">已提供 {row.pushes} 次 · 检索/展开 {row.hits} 次；这些数字不代表质量提升</p>}</div>
        <Button variant="outline" className="shrink-0" disabled={opening} onClick={() => void open(row.id)}>{row.can_review && !row.archived && !row.withdrawn && !row.superseded_by && row.review?.status !== "accepted" ? "查看并审查" : "查看经验"}</Button>
      </article>)}</div>
      {!rows.length && <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{!insights ? "正在加载…" : "当前没有符合条件的记录"}</p>}
      {rows.length > 10 && <div className="flex items-center justify-end gap-3 text-sm"><Button variant="outline" size="sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button>
        {currentPage + 1} / {Math.ceil(rows.length / 10)}<Button variant="outline" size="sm" disabled={(currentPage + 1) * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    </>}
  </section>;
}
