import { componentKnowledgeMarkdown } from "../../src/componentKnowledgeMarkdown";
import { useEffect, useState } from "react";
import { MoreHorizontal, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { componentRuleMatches } from "./knowledgeModules";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ComponentKnowledgeArtifacts } from "./ComponentKnowledgeArtifacts";
import { ComponentKnowledgeDelete } from "./ComponentKnowledgeDelete";
import { ComponentResearch } from "./ComponentResearch";
import { componentRequest } from "./componentResearchApi";
import { documentRequest, type KnowledgeDocument } from "./knowledgeDocumentsApi";
import { listTasks, type TaskSummary } from "./api";
import { Markdown } from "./markdown";
import { ComponentDocumentReader } from "./ComponentDocumentReader";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { ComponentPolicyLevel, ComponentFeedback, ComponentGovernanceSnapshot, ComponentGovernanceItem } from "../../src/componentKnowledgeTypes";

type Item = ComponentGovernanceItem;
const feedbackLabels = { useful: "这处建议适用", false_positive: "这处提示有误", counterexample: "存在不适用的场景", quality_ok: "已核对内容正确", quality_error: "知识内容有误" };
const field = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";
const belongs = (a: Item, b: Item) => a.paradigm.document_id === b.paradigm.document_id && a.paradigm.start_line === b.paradigm.start_line;
const stateLabel = (item: Item) => item.policy.level === "warning" ? "提示" : item.policy.level === "off" ? "关闭" : "只记录";
const levelDot = { warning: "bg-primary", shadow: "bg-line-strong", off: "bg-muted-foreground/40" } as const;

/** variant="rules" 时只渲染某个组件的规则表（嵌在知识库"工程语言 → 基础组件"的规则页签），
 *  级别设置、纠错、程序化产物与核对例外仍走本工作台同一套对话框。 */
export function ComponentKnowledgeWorkspace({ open, focusId, onClose: _onClose, onAdopt, variant = "workspace", component, onChanged }: {
  open: boolean; focusId?: string; onClose: () => void; onAdopt: (id: string) => void;
  variant?: "workspace" | "rules"; component?: { id: string; documentIds: string[] }; onChanged?: () => void;
}) {
  const [data, setData] = useState<ComponentGovernanceSnapshot>(), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [policySnapshot, setPolicySnapshot] = useState({ revision: -1, digest: "" });
  const [feedbackDigest, setFeedbackDigest] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [deleting, setDeleting] = useState(false), [sources, setSources] = useState(false);
  const [research, setResearch] = useState(focusId || ""), [adopted, setAdopted] = useState("");
  const [document, setDocument] = useState<KnowledgeDocument>(), [documentError, setDocumentError] = useState("");
  const [settings, setSettings] = useState(false), [editId, setEditId] = useState(""), [feedbackId, setFeedbackId] = useState("");
  const [busy, setBusy] = useState(false), [dialogError, setDialogError] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]), [task, setTask] = useState("");
  const [level, setLevel] = useState<ComponentPolicyLevel>("shadow"), [owner, setOwner] = useState(""), [scope, setScope] = useState(""), [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<ComponentFeedback["kind"]>("quality_error"), [note, setNote] = useState(""), [sampleId, setSampleId] = useState("");
  const [samplesId, setSamplesId] = useState("");
  const componentRules = component ? (data?.items ?? []).filter(i => componentRuleMatches(i, component.documentIds, component.id)) : [];
  const samplesRule = componentRules.find(i => i.id === samplesId);
  const knowledge = (data?.items ?? []).filter(i => i.kind === "mapping");
  const item = knowledge.find(i => i.id === selected);
  const rules = item ? (data?.items ?? []).filter(i => i.kind === "rule" && belongs(i, item)) : [];
  const edit = data?.items.find(i => i.id === editId), feedbackItem = data?.items.find(i => i.id === feedbackId);
  async function refresh() { const next = await componentRequest<ComponentGovernanceSnapshot>("/component-knowledge"); setData(next); return next; }
  useEffect(() => { if (focusId) setResearch(focusId); }, [focusId]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => componentRequest<ComponentGovernanceSnapshot>("/component-knowledge").then(next => { if (live) { setData(next); setError(""); } }).catch(e => { if (live) setError(e.message); });
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { live = false; clearInterval(timer); };
  }, [open]);
  useEffect(() => {
    setSelected(previous => {
      const target = adopted && knowledge.find(i => i.paradigm.document_id === adopted);
      return target ? target.id : knowledge.some(i => i.id === previous) ? previous : knowledge[0]?.id ?? "";
    });
  }, [data, adopted]);
  useEffect(() => {
    let live = true; setDocument(undefined); setDocumentError("");
    if (item && variant === "workspace") void documentRequest<KnowledgeDocument>(`/${encodeURIComponent(item.paradigm.document_id)}`).then(doc => { if (live) setDocument(doc); }).catch(e => { if (live) setDocumentError(e.message); });
    return () => { live = false; };
  }, [item?.paradigm.document_id, item?.source_digest]);
  useEffect(() => {
    if (!settings) return;
    let live = true;
    void listTasks().then(rows => { if (live) setTasks(rows.filter(t => t.repo_url || t.repositories?.length)); }).catch(e => { if (live) setDialogError(e.message); });
    return () => { live = false; };
  }, [settings]);
  function openPolicy(row: Item) {
    setPolicySnapshot({ revision: data!.revision, digest: row.source_digest });
    setEditId(row.id); setLevel(row.policy.level); setOwner(row.policy.owner); setScope(row.policy.scope.join("\n")); setReason(""); setDialogError("");
  }
  function correct(row: Item, sample = "") {
    setFeedbackDigest(row.source_digest);
    setFeedbackId(row.id); setSampleId(sample); setFeedback(sample ? "false_positive" : "quality_error"); setNote(""); setDialogError("");
  }
  async function action(fn: () => Promise<unknown>, message: string, done?: () => void) {
    setBusy(true); setDialogError(""); setNotice("");
    try { await fn(); await refresh(); setNotice(message); done?.(); onChanged?.(); }
    catch (e) { setDialogError((e as Error).message); }
    finally { setBusy(false); }
  }
  function closeResearch() {
    setResearch(""); const url = new URL(location.href); url.searchParams.delete("componentResearch"); url.searchParams.delete("researchDocument"); history.replaceState(history.state, "", url);
    void refresh().catch(e => setError(e.message));
  }
  function ruleDetail(rule: Item) {
    return <div className="mt-4 space-y-4">
            <p className="text-sm leading-relaxed">匹配到这类写法时，提示核对是否适合使用 {rule.paradigm.api.join("、")}。当前检查不判断调用顺序、参数或生命周期是否正确。</p>
            <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => openPolicy(rule)}>设置检查</Button><Button size="sm" variant="ghost" onClick={() => setArtifacts(rule.id)}>查看程序化产物</Button><Button size="sm" variant="ghost" onClick={() => correct(rule)}>报告检查问题</Button><Button size="sm" variant="ghost" disabled={busy || data?.challenges.some(c => c.challenge.item_id === rule.id && ["queued", "running"].includes(c.status))} onClick={() => void action(() => componentRequest(`/component-knowledge/${rule.id}/challenge`, { source_digest: rule.source_digest }), "已开始核对不适用的场景")}>核对例外</Button></div>
            {rule.samples.map(s => <div key={s.id} className="rounded-lg bg-surface-2 p-3"><p className="break-all text-sm">{s.path}:{s.line}</p>{[...rule.feedback].reverse().find(f => f.observation_id === s.id && ["useful", "false_positive"].includes(f.kind))?.kind === "false_positive" && <p className="mt-2 text-sm text-primary">已记录为合法例外</p>}<pre className="my-3 overflow-x-auto whitespace-pre-wrap break-words text-sm">{s.context}</pre><Button size="sm" variant="outline" onClick={() => correct(rule, s.id)}>这处提示有误</Button></div>)}
            {!rule.samples.length && <p className="text-sm text-muted-foreground">尚无检查结果</p>}
            {data?.challenges.filter(c => c.challenge.item_id === rule.id).map(c => <details key={c.id}><summary className="cursor-pointer">{c.stage}{c.challenge.source_digest !== rule.source_digest ? "（旧版本）" : ""}</summary>{c.error && <p className="text-danger">{c.error}</p>}{c.draft && <Markdown text={c.draft} />}{["queued", "running"].includes(c.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => componentRequest(`/component-research/${c.id}/stop`, {}), "核对已停止")}>停止核对</Button>}</details>)}
            {!!rule.feedback.length && <details><summary className="cursor-pointer">检查纠错记录</summary>{rule.feedback.map(f => <p key={f.id} className="mt-2 text-sm">{feedbackLabels[f.kind]}：{f.reason}</p>)}</details>}
    </div>;
  }
  const rawContent = item && document?.content?.split(/\r?\n/).slice(item.paradigm.start_line - 1, item.paradigm.end_line).join("\n").replace(/^<a id="component-[^"\n]+"><\/a>\s*/gm, "").trim().replace(/^#{1,2} [^\n]+\n/, "");
  const content = componentKnowledgeMarkdown(rawContent ?? "");
  const rulesTable = <section className="grid gap-3" aria-label="组件规则">
    <p className="text-sm text-muted-foreground">规则按写法匹配，命中时只提示、不拦截提交。新规则默认只记录；改为提示需填写负责人与理由。</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {notice && <p role="status" className="text-primary">{notice}</p>}
    {!data && !error ? <p role="status" className="text-muted-foreground">正在读取规则…</p> : data && !componentRules.length ? <p className="rounded-lg border border-line p-4 text-muted-foreground">这个组件的知识尚无可执行的规则。</p> : data && <>
      <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[640px] text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2 font-medium">规则</th><th className="px-3 py-2 font-medium">级别</th><th className="px-3 py-2 text-right font-medium" title={data.retention}>命中</th><th className="px-3 py-2 text-right font-medium" title="已人工判断的命中里标为误报的比例">误报占比</th><th className="px-3 py-2"><span className="sr-only">样本</span></th></tr></thead>
        <tbody>{componentRules.map(rule => <tr key={rule.id} className="border-t border-line align-top">
          <td className="px-4 py-3"><div className="font-medium leading-snug">{rule.paradigm.title}</div><div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">匹配 {rule.original}</div>
            {(rule.needs_review || rule.policy.stale) && <div className="mt-1.5 flex flex-wrap gap-1.5">{rule.needs_review && <Badge variant="warning">需要复核</Badge>}{rule.policy.stale && <Badge variant="neutral">源已变化</Badge>}</div>}</td>
          <td className="px-3 py-3"><Button size="sm" variant="outline" aria-label={`设置级别：${rule.paradigm.title}`} onClick={() => openPolicy(rule)}><span className={`size-2 rounded-full ${levelDot[rule.policy.level]}`} />{stateLabel(rule)}</Button>{rule.policy.level !== "shadow" && rule.policy.owner && <div className="mt-1 text-xs text-muted-foreground">负责人 {rule.policy.owner}</div>}</td>
          <td className="px-3 py-3 text-right tabular-nums">{rule.stats.observed}</td>
          <td className="px-3 py-3 text-right tabular-nums">{rule.stats.exemption_rate === null ? <span className="text-muted-foreground">—</span> : `${Math.round(rule.stats.exemption_rate * 100)}%`}<div className="text-xs text-muted-foreground">已判断 {rule.stats.reviewed}</div></td>
          <td className="px-3 py-3 text-right"><Button size="sm" variant="ghost" onClick={() => { setSamplesId(rule.id); setDialogError(""); }}>命中样本 {rule.samples.length}</Button></td>
        </tr>)}</tbody>
      </table></div>
      <p className="text-xs text-muted-foreground">命中为当前规则版本的累计去重命中，暂不按 30 天切分。{data.retention}</p>
    </>}
    <Dialog open={!!samplesRule && open} onOpenChange={value => { if (!value && !busy) setSamplesId(""); }}><DialogContent className="tw-root sm:max-w-[760px] max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>命中样本 · {samplesRule?.paradigm.title}</DialogTitle></DialogHeader>
      {dialogError && !edit && !feedbackItem && <p role="alert" className="text-danger">{dialogError}</p>}
      {samplesRule && ruleDetail(samplesRule)}
    </DialogContent></Dialog>
  </section>;
  return <section className="tw-root space-y-3" aria-label={variant === "rules" ? "组件规则" : "组件知识工作台"}>
    {variant === "rules" ? rulesTable : <>
    <header className="flex items-center justify-between gap-4">
      <h2 className="text-xl font-semibold">组件知识</h2>
      <div className="flex items-center gap-2"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" aria-label="管理组件知识" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root"><DropdownMenuItem onClick={() => setResearch("history")}>查看萃取记录</DropdownMenuItem><DropdownMenuItem onClick={() => setDeleting(true)}>删除知识</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button onClick={() => setResearch("new")}><Sparkles size={16} />萃取知识</Button></div>
    </header>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {notice && <p role="status" className="text-primary">{notice}</p>}
    {!!data?.warnings.length && <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-attention">有 {data.warnings.length} 项知识未能完整读取</summary>{data.warnings.map((w, i) => <p key={i} className="mt-2 break-words">{w}</p>)}</details>}
    <ComponentDocumentReader treeLabel="组件列表" selected={selected} onSelect={id => { setAdopted(""); setSelected(id); }}
      files={knowledge.map(row => ({ id: row.id, path: [row.paradigm.component, `${row.paradigm.title}.md`], searchText: `${row.paradigm.need} ${row.paradigm.api.join(" ")}`, content: row.id === selected && document ? (content || "本条知识暂无正文。") : undefined }))}
      message={documentError ? <div role="alert" className="text-danger">正文读取失败：{documentError}<Button variant="link" onClick={() => item && onAdopt(item.paradigm.document_id)}>打开源文档</Button></div> : undefined}
      actions={item && <>
        {item.needs_review && <span className="text-attention">待核对</span>}
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" aria-label="文档操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root">
          <DropdownMenuItem onClick={() => { setSettings(true); setDialogError(""); }}>代码检查</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setArtifacts(item.id)}>查看程序化产物</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setSources(true)}>来源与纠错记录</DropdownMenuItem>
          <DropdownMenuItem onClick={() => correct(item)}>纠错</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </>} />
    </>}
    <Dialog open={sources && open} onOpenChange={setSources}><DialogContent className="tw-root sm:max-w-[760px] max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>来源与纠错记录</DialogTitle></DialogHeader>
      {item && <><section><h3 className="mb-2 font-semibold">适用条件</h3><p className="leading-relaxed">{item.paradigm.applicability}</p></section><div className="space-y-4">{item.paradigm.evidence.map((e, i) => <p key={i} className="break-all">{e.repository_id} / {e.path}:{e.start}–{e.end}<br /><span className="text-muted-foreground">版本 {e.revision}</span></p>)}{item.paradigm.usage_evidence.map((e, i) => <p className="break-words" key={i}>{e}</p>)}<Button variant="outline" onClick={() => onAdopt(item.paradigm.document_id)}>打开源文档</Button></div>
      {!!item.feedback.length && <section className="border-t border-line pt-4"><h3 className="font-semibold">纠错记录</h3>{item.feedback.map(f => <p key={f.id} className="mt-3 leading-relaxed"><strong>{feedbackLabels[f.kind]}</strong> · {f.operator}<br />{f.reason}</p>)}</section>}</>}
    </DialogContent></Dialog>

    <ComponentKnowledgeArtifacts id={open ? artifacts : ""} onClose={() => setArtifacts("")} />
    <ComponentKnowledgeDelete open={open && deleting} onClose={() => setDeleting(false)} onChanged={() => { setAdopted(""); setArtifacts(""); void refresh().catch(e => setError(e.message)); }} />
    <Dialog open={!!research && open} onOpenChange={value => { if (!value) closeResearch(); }}><DialogContent className="tw-root w-[98vw] max-w-none sm:max-w-none h-[96dvh] overflow-auto block"><DialogHeader className="sr-only"><DialogTitle>萃取知识</DialogTitle></DialogHeader><ComponentResearch open={!!research && open} focusId={research} compact onClose={closeResearch} onAdopt={id => { setAdopted(id); closeResearch(); }} /></DialogContent></Dialog>

    <Dialog open={settings && open} onOpenChange={value => { if (!busy) { setSettings(value); setDialogError(""); } }}><DialogContent className="tw-root sm:max-w-[760px] max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>代码检查 · {item?.paradigm.component}</DialogTitle></DialogHeader>
      {dialogError && !edit && !feedbackItem && <p role="alert" className="text-danger">{dialogError}</p>}
      {item && <>
        <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-semibold">代码检查</h3><span className="rounded bg-surface-2 px-3 py-1 text-sm">不拦截提交</span></div>
          {!rules.length && <p className="rounded-lg border border-line p-4 text-muted-foreground">这条知识尚无可执行的代码检查。</p>}
          {rules.map(rule => <details key={rule.id} className="rounded-lg border border-line p-4"><summary className="cursor-pointer"><span className="font-medium">检查 {rule.original}</span><span className="ml-3 text-sm text-muted-foreground">{stateLabel(rule)}</span></summary>{ruleDetail(rule)}</details>)}
          {!!rules.length && <details className="pt-2"><summary className="cursor-pointer text-sm">在已有代码中试查</summary><div className="mt-3 flex gap-3"><select className={`${field} min-w-0 flex-1`} aria-label="消费方代码" value={task} onChange={e => setTask(e.target.value)}><option value="">选择需求任务</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}</select><Button disabled={!task || busy} variant="outline" onClick={() => void action(async () => { const r = await componentRequest<{ status: string; warnings: string[] }>("/component-knowledge/sample", { task_id: task }); if (r.status === "incomplete") throw new Error(r.warnings.join("；") || "检查未完成"); if (r.status === "not_applicable") throw new Error("该任务没有适用的组件检查"); }, "代码检查已完成")}>开始检查</Button></div></details>}
        </section>
      </>}
    </DialogContent></Dialog>

    <Dialog open={!!edit && open} onOpenChange={value => { if (!value && !busy) setEditId(""); }}><DialogContent className="tw-root sm:max-w-[500px]"><DialogHeader><DialogTitle>{edit ? `检查 ${edit.original}` : "检查设置"}</DialogTitle></DialogHeader>
      {dialogError && <p role="alert" className="text-danger">{dialogError}</p>}
      <div className="grid gap-4"><label className="grid gap-2">使用状态<select className={field} aria-label="使用状态" value={level} onChange={e => setLevel(e.target.value as ComponentPolicyLevel)}><option value="shadow">只记录</option><option value="warning">提示</option><option value="off">关闭</option></select></label>
        {level === "warning" && edit?.policy.level !== "warning" && <p className="text-sm text-muted-foreground">改为提示后，Agent 写代码命中这条规则时会收到提示（不拦截提交）。请填写负责人与理由。</p>}
        <label className="grid gap-2">负责人<Input aria-label="组件负责人" value={owner} onChange={e => setOwner(e.target.value)} placeholder="开启时必填" /></label>
        {edit?.kind === "rule" && <label className="grid gap-2">检查路径<Textarea aria-label="适用路径" value={scope} onChange={e => setScope(e.target.value)} placeholder="如 src/**，留空为全部" rows={2} /></label>}
        <label className="grid gap-2">变更原因<Textarea aria-label="策略变更理由" value={reason} onChange={e => setReason(e.target.value)} rows={2} /></label>
        <div className="flex justify-end gap-2"><Button disabled={busy} variant="ghost" onClick={() => setEditId("")}>取消</Button><Button disabled={busy || !reason.trim() || (level === "warning" && !owner.trim())} onClick={() => edit && void action(() => componentRequest(`/component-knowledge/${edit.id}/policy`, { revision: policySnapshot.revision, source_digest: policySnapshot.digest, level, owner, reason, scope: scope.split("\n").map(s => s.trim()).filter(Boolean) }), "使用设置已保存", () => setEditId(""))}>保存</Button></div>
      </div>
    </DialogContent></Dialog>

    <Dialog open={!!feedbackItem && open} onOpenChange={value => { if (!value && !busy) setFeedbackId(""); }}><DialogContent className="tw-root sm:max-w-[540px]"><DialogHeader><DialogTitle>{sampleId ? "纠正这处提示" : "纠正知识"}</DialogTitle></DialogHeader>
      {dialogError && <p role="alert" className="text-danger">{dialogError}</p>}
      <select aria-label="反馈类型" className={field} value={feedback} onChange={e => setFeedback(e.target.value as ComponentFeedback["kind"])}>{Object.entries(feedbackLabels).filter(([key]) => sampleId || !["useful", "false_positive"].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <Textarea aria-label="反馈依据" placeholder="哪里不对？请附上代码位置或正确用法。" rows={5} value={note} onChange={e => setNote(e.target.value)} />
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setFeedbackId("")}>取消</Button><Button disabled={busy || !note.trim()} onClick={() => feedbackItem && void action(() => componentRequest(`/component-knowledge/${feedbackItem.id}/feedback`, { source_digest: feedbackDigest, kind: feedback, reason: note, observation_id: sampleId || undefined }), "纠错已记录，使用设置未改变", () => setFeedbackId(""))}>提交纠错</Button></div>
    </DialogContent></Dialog>
  </section>;
}
