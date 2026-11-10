import { useEffect, useState } from "react";
import { FileText, Sparkles, MessageSquareQuote } from "lucide-react";
import { reviewTaskMemory, memoryHistory, getMemoryInsights, getBusinessModules, productVersionRequest, type MemoryRecord } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";

/** 边界与结论一起持久化、检索，避免推荐时遗漏限定条件。 */
const boundaryMarker = /\n\s*适用例外[：:]/;
export function MemoryReviewEditor({ record, taskId, onChanged, onDismiss, onDirty, stacked = false }: {
  stacked?: boolean;
  record: MemoryRecord; taskId: string; onChanged: () => Promise<void>; onDismiss: () => void; onDirty: (dirty: boolean) => void;
}) {
  const parts = record.conclusion.split(boundaryMarker);
  const [dimension, setDimension] = useState(record.dimension);
  const [trigger, setTrigger] = useState(record.trigger);
  const [conclusion, setConclusion] = useState(parts[0]);
  const [exceptions, setExceptions] = useState(parts.slice(1).join("\n适用例外：").trim());
  const [scope, setScope] = useState(record.scope);
  const [module, setModule] = useState(record.module ?? "");
  const [repo, setRepo] = useState(record.repo);
  const [versions, setVersions] = useState(record.product_versions ?? []);
  const [modules, setModules] = useState<Array<{id: string; name: string}>>([]);
  const [versionOptions, setVersionOptions] = useState<string[]>([]);
  const [historyRows, setHistoryRows] = useState<MemoryRecord[]>();
  const [targets, setTargets] = useState<Array<{id: string; trigger: string}>>([]);
  const [mergeTarget, setMergeTarget] = useState("");
  const [note, setNote] = useState(record.maintenance_note ?? "");
  useEffect(() => {
    void Promise.all([getBusinessModules(), productVersionRequest(), getMemoryInsights()]).then(([m, v, i]) => {
      setModules(m.modules); setVersionOptions(v.versions.map(row => row.version));
      setTargets(i.memories.filter(row => row.id !== record.id && row.review?.status === "accepted" && !row.archived && !row.withdrawn && !row.superseded_by && !row.merged_into));
    }).catch(reason => setError(String(reason)));
  }, [record.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accepted = record.review?.status === "accepted";
  const active = !record.withdrawn && !record.superseded_by;
  const editable = record.can_review && active;
  useEffect(() => {
    onDirty(dimension !== record.dimension || trigger !== record.trigger || conclusion !== parts[0] || exceptions !== parts.slice(1).join("\n适用例外：").trim() || scope !== record.scope || module !== (record.module ?? "") || repo !== record.repo || JSON.stringify(versions) !== JSON.stringify(record.product_versions ?? []) || note !== (record.maintenance_note ?? ""));
  }, [dimension, trigger, conclusion, exceptions, scope, module, repo, versions, note, record, onDirty]);
  async function decide(decision: "pending" | "accepted" | "rejected", merged_into?: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await reviewTaskMemory(taskId, record, { decision, dimension, trigger, scope, module, repo, product_versions: versions, note, merged_into,
        conclusion: conclusion.trim() + (exceptions.trim() ? `\n\n适用例外：${exceptions.trim()}` : "") });
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className={`grid min-w-0 ${stacked ? "grid-cols-1" : "grid-cols-2"} items-stretch gap-4 text-[16px]`}>
    <section className="min-w-0 rounded-xl border border-border bg-surface">
      <h3 className="flex items-center gap-2 border-b border-border p-4 font-semibold"><FileText className="size-5 text-primary" />事实与依据</h3>
      <div className="grid gap-4 p-4">
        <div className="text-sm text-muted-foreground">{record.source_repo ?? record.repo} · {record.task || "成员主动记录"}<p className="mt-1 break-all">来源标识：{record.evidence === "manual" ? "手工新增" : record.evidence}</p></div>
        {record.merged_into && <a className="rounded-md border p-3 text-primary underline" href={`/?kbPage=experience&memory_id=${record.merged_into}`}>本条已合并停用，查看保留的目标经验</a>}
        {(record.problem || record.quote) && <div className="rounded-lg border border-border p-4">
          <h4 className="mb-3 flex items-center gap-2 font-medium"><MessageSquareQuote className="size-4" />{record.source === "delivery_review" ? "首次问题与最终修正" : "原始反馈"}</h4>
          {record.problem && <p className="whitespace-pre-wrap break-words">{record.problem}</p>}
          {record.quote && <blockquote className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/50 p-3 text-sm">{record.quote}</blockquote>}
        </div>}
        <div className="rounded-lg border border-border p-4"><h4 className="mb-3 font-medium">{record.source === "delivery_review" ? "Agent 提炼的原始候选" : "当时记录的处理结论"}</h4>
          <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{record.basis?.conclusion ?? record.review?.original?.conclusion ?? record.conclusion}</p>
          <p className="mt-3 text-sm text-muted-foreground">请核对依据与适用条件，证据不足可以先保存草稿。</p>
        </div>
        {record.review?.original && <details className="text-sm"><summary className="cursor-pointer">查看人工编辑前的候选</summary><p className="mt-2 whitespace-pre-wrap break-words">{record.review.original.conclusion}</p></details>}
        <details className="rounded-lg border p-3" onToggle={event => { if (event.currentTarget.open) void memoryHistory(record.id).then(setHistoryRows).catch(reason => setError(String(reason))); }}>
          <summary className="cursor-pointer font-medium">修改历史与使用反馈</summary>
          {historyRows?.slice().reverse().map((row, index) => <article key={index} className="mt-3 border-t pt-3 text-sm">
            <p>版本 {row.revision ?? 1} · {row.edited_by ?? row.review?.by ?? row.author ?? "Agent"} · {new Date(row.edited_at ?? row.review?.at ?? row.at).toLocaleString()}</p>
            <p>{row.review?.status === "accepted" ? "已采纳" : row.review?.status === "rejected" ? "已停用" : "待确认"} · {row.trigger}</p>
            <p className="mt-1 text-muted-foreground">范围：{row.module ? `模块 ${row.module}` : row.scope === "platform" ? "平台通用" : row.repo} · 版本：{row.product_versions?.join("、") || "未限定"}</p>
            <p className="mt-2 whitespace-pre-wrap">{row.conclusion}</p>
            {row.maintenance_note && <p className="mt-2">维护说明：{row.maintenance_note}</p>}
            {row.merged_into && <a className="text-primary underline" href={`/?kbPage=experience&memory_id=${row.merged_into}`}>查看合并目标</a>}
            {editable && <Button variant="outline" size="sm" className="mt-2" onClick={() => {
              const old = row.conclusion.split(boundaryMarker); setTrigger(row.trigger); setConclusion(old[0]); setExceptions(old.slice(1).join("\n适用例外：").trim());
              setDimension(row.dimension); setScope(row.scope); setModule(row.module ?? ""); setRepo(row.repo); setVersions(row.product_versions ?? []); setNote(`恢复版本 ${row.revision ?? 1}`);
            }}>载入此版本到编辑区</Button>}
          </article>)}
        </details>
      </div>
    </section>
    <section className="min-w-0 rounded-xl border border-border bg-surface">
      <h3 className="flex items-center gap-2 border-b border-border p-4 font-semibold"><Sparkles className="size-5 text-primary" />{editable ? "经验内容 · 团队共同维护" : accepted ? "已采纳经验" : "经验记录"}</h3>
      <div className="grid gap-4 p-4">
        {record.source === "delivery_review" && <div className="grid gap-2 font-medium">经验维度<Select value={dimension ?? ""} disabled={!editable || busy} onValueChange={value => setDimension(value as MemoryRecord["dimension"])}><SelectTrigger aria-label="经验维度"><SelectValue /></SelectTrigger><SelectContent>
          {["业务规则与边界", "组件与接口用法", "设计与实现约束", "编码规范", "测试与验证", "分析与工作方法"].map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
        </SelectContent></Select></div>}
        <label className="grid gap-2 font-medium">什么情况下使用<Input className="h-10 text-[16px] md:text-[16px]" value={trigger} disabled={!editable || busy} maxLength={80} onChange={event => setTrigger(event.target.value)} /></label>
        <label className="grid gap-2 font-medium">经验结论<Textarea className="text-[16px] font-normal md:text-[16px]" rows={4} value={conclusion} disabled={!editable || busy}
          placeholder="提炼可迁移的判断方法、做法与依据，不只复述本次修复。" onChange={event => setConclusion(event.target.value)} /></label>
        <label className="grid gap-2 font-medium">适用例外<Textarea className="text-[16px] font-normal md:text-[16px]" rows={3} value={exceptions} disabled={!editable || busy}
          placeholder="什么前提下成立？哪些情况不能照搬？还缺什么证据？" onChange={event => setExceptions(event.target.value)} /></label>
        <label className="grid gap-2 font-medium">复用范围<select className="rounded-md border border-border bg-surface p-2 font-normal" value={module ? "module" : scope} disabled={!editable || busy}
          onChange={event => { if (event.target.value === "module") { setModule(modules[0]?.id ?? ""); setScope("general"); } else { setModule(""); setScope(event.target.value as MemoryRecord["scope"]); } }}>
          <option value="module" disabled={!modules.length}>业务模块</option><option value="local">本仓相关位置</option><option value="general">本仓通用</option>
          <option value="platform">跨仓通用</option><option value="one_off">仅检索参考，不主动推荐</option>
        </select><span className="text-sm font-normal text-muted-foreground">跨仓通用需确认结论不依赖当前仓库的特殊条件。</span></label>
        {module && <label className="grid gap-2">业务模块<select className="rounded-md border bg-surface p-2" value={module} disabled={!editable || busy} onChange={e => setModule(e.target.value)}>
          {modules.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select></label>}
        {!module && scope !== "platform" && <label className="grid gap-2">适用代码仓<Input value={repo} disabled={!editable || busy} onChange={e => setRepo(e.target.value)} placeholder="代码仓名称或地址" /></label>}
        <fieldset className="grid gap-2"><legend className="mb-2 font-medium">适用产品版本</legend>
          <p className="text-sm text-muted-foreground">不选表示未限定版本，Agent 使用时仍需核对适用条件。</p>
          <div className="flex flex-wrap gap-3">{[...new Set([...versionOptions, ...versions])].map(v => <label key={v} className="flex items-center gap-2"><input type="checkbox" checked={versions.includes(v)} disabled={!editable || busy}
            onChange={e => setVersions(e.target.checked ? [...versions, v] : versions.filter(x => x !== v))} />{v}</label>)}</div>
        </fieldset>
        <label className="grid gap-2">维护说明 / 使用反馈<Textarea value={note} disabled={!editable || busy} onChange={e => setNote(e.target.value)} placeholder="记录不适用的情况、冲突、修订原因及处理结果；保存后留痕。" /></label>
        {editable && <details className="rounded-lg border p-3"><summary className="cursor-pointer">合并重复经验</summary>
          <p className="my-2 text-sm text-muted-foreground">先在目标经验补齐需要保留的内容，再停用本条并关联目标。两条原文与历史都会保留。</p>
          <select aria-label="合并目标" className="w-full rounded border bg-surface p-2" value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}><option value="">选择已采纳的目标经验</option>{targets.map(t => <option key={t.id} value={t.id}>{t.trigger}</option>)}</select>
          <Button className="mt-3" variant="outline" disabled={busy || !mergeTarget} onClick={() => void decide("rejected", mergeTarget)}>关联目标并停用本条</Button>
        </details>}
      </div>
    </section>
    <footer className={`sticky z-10 ${stacked ? "bottom-0" : "bottom-16 col-span-2"} flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm`}>
      <div className="text-sm text-muted-foreground"><p>团队成员均可维护，每次修改留痕；采纳后供 Agent 按范围检索。</p>
        {record.review?.by && <p>最近处理：{record.review.by} · {record.review.at ? new Date(record.review.at).toLocaleString() : ""}</p>}
        {!record.can_review && <p>当前记录只读。</p>}</div>
      <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={onDismiss}>{editable ? "暂不处理" : "返回列表"}</Button>
        {editable && <><Button variant="outline" disabled={busy} onClick={() => void decide("rejected")}>停用，保留历史</Button>
          {!accepted && <Button variant="outline" disabled={busy || !trigger.trim() || !conclusion.trim()} onClick={() => void decide("pending")}>保存草稿</Button>}
          <Button disabled={busy || !trigger.trim() || !conclusion.trim()} onClick={() => void decide("accepted")}>{accepted && !record.archived ? "保存修改" : "采纳供 Agent 复用"}</Button></>}

      </div>
      {error && <p role="alert" className="w-full text-destructive">{error}</p>}
    </footer>
  </div>;
}
