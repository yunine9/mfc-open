import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Document { id: string; title: string; revision: string; active: boolean; archive_target?: { repository: string; branch: string; path: string } }
interface Snapshot { documents: Document[]; pending: Array<{ id: string; title: string }>; git_message: string }
async function request(path: string, body?: unknown): Promise<Snapshot> {
  const response = await fetch(`/component-knowledge/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "删除失败");
  return data;
}
export function ComponentKnowledgeDelete({ open, onClose, onChanged, initialDocumentId }: { open: boolean; onClose: () => void; onChanged: () => void; initialDocumentId?: string }) {
  const [data, setData] = useState<Snapshot>(), [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true; setData(undefined); setSelected([]); setConfirm(false); setError(""); setMessage("");
    void request("documents").then(value => { if (live) { setData(value); setSelected(initialDocumentId && value.documents.some(doc => doc.id === initialDocumentId) ? [initialDocumentId] : []); } }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [open, initialDocumentId]);
  async function remove(retry = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await request(retry ? "retry-deletions" : "delete", retry ? {} : { documents: data!.documents.filter(d => selected.includes(d.id)).map(d => ({ id: d.id, revision: d.revision })) });
      setData(next); setSelected([]); setConfirm(false); onChanged();
      setMessage(next.pending.length ? "知识已删除，索引清理待重试。" : retry ? "memsearch 索引已清理。" : "知识及 memsearch 索引已删除。");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}><DialogContent className="tw-root sm:max-w-[680px] max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>删除组件知识</DialogTitle></DialogHeader>
    {error && <p role="alert" className="text-danger">{error}</p>}{message && <p role="status">{message}</p>}
    {!data ? <p>正在读取历史知识…</p> : <>
      {!confirm && <p className="text-sm text-muted-foreground">{data.git_message}</p>}
      {!!data.pending.length && <section className="rounded-lg border border-line p-4"><p>有 {data.pending.length} 份知识已停止使用，memsearch 索引尚待清理。</p><details className="mt-2"><summary>查看名称</summary>{data.pending.map(d => <p key={d.id}>{d.title}</p>)}</details><Button className="mt-3" variant="outline" disabled={busy} onClick={() => void remove(true)}>重试清理索引</Button></section>}
      {confirm ? <><p>删除以下 {selected.length} 份完整知识文档及其 memsearch 索引，文档内所有组件用法和检查规则将停止使用。</p><ul className="max-h-60 overflow-auto list-disc pl-5">{data.documents.filter(d => selected.includes(d.id)).map(d => <li key={d.id}>{d.title}{d.archive_target && <p className="break-all text-xs text-muted-foreground">{d.archive_target.repository} · {d.archive_target.branch} · {d.archive_target.path}</p>}</li>)}</ul><p>{data.git_message}</p><div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>返回选择</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "确认删除知识及索引"}</Button></div></> : <>
        {!data.documents.length ? <p>没有可删除的组件知识。</p> : <><label className="flex items-center gap-2"><input type="checkbox" aria-label="全选组件知识" checked={selected.length === data.documents.length} disabled={busy || data.documents.length > 100} onChange={e => setSelected(e.target.checked ? data.documents.map(d => d.id) : [])} />全选</label><div className="max-h-80 overflow-auto divide-y divide-line rounded-lg border border-line">{data.documents.map(d => <label key={d.id} className="flex items-start gap-3 p-3"><input className="mt-1" type="checkbox" checked={selected.includes(d.id)} disabled={busy} onChange={e => setSelected(current => e.target.checked ? [...current, d.id] : current.filter(id => id !== d.id))} /><span className="break-words">{d.title}{!d.active && "（已停用）"}</span></label>)}</div><div className="flex justify-end"><Button variant="destructive" disabled={busy || !selected.length || selected.length > 100} onClick={() => setConfirm(true)}>删除所选（{selected.length}）</Button></div></>}
      </>}
    </>}
  </DialogContent></Dialog>;
}
