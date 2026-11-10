import { useResearchResource } from "./useResearchResource";
import { componentGuideMarkdown, componentUsageMarkdown, compareComponentSections } from "../../src/componentKnowledgeMarkdown";
import { ComponentDocumentReader } from "./ComponentDocumentReader";
import { KnowledgeOutline } from "./KnowledgeOutline";
import { KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { KnowledgeReviewNotes } from "./KnowledgeReviewNotes";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FileText, Download, MoreHorizontal, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { diffLines } from "diff";
import { Markdown } from "./markdown";
import { componentRequest, componentResearchSources, type ComponentResearchRecord, type ComponentResearchSection } from "./componentResearchApi";

function draftSectionMarkdown(section: ComponentResearchSection) {
  return [`# ${section.title}`, section.content,
    ...([['interfaces', '关键接口'], ['integration', '接入配置'], ['example', '完整示例'], ['unit_tests', '单元测试示例']] as const)
      .flatMap(([field, heading]) => section[field].trim() ? [`### ${heading}`, section[field]] : []),
  ].filter(Boolean).join("\n\n");
}
function sectionMarkdown(section: ComponentResearchSection, generating = false) {
  const title = `# ${section.title}`;
  if (section.paradigm?.kind !== "paradigm" || section.paradigm.status !== "recommended") return draftSectionMarkdown(section);
  try { return `${title}\n\n${componentUsageMarkdown(section)}`; }
  catch (error) { return draftSectionMarkdown(section) + (generating ? "" : `\n\n> 文稿格式需要修订：${error instanceof Error ? error.message : String(error)}`); }
}
export function latestComponentProposal(record: ComponentResearchRecord, sectionId: string) {
  return [...(record.review_turns ?? [])].reverse().find(turn => turn.section_id === sectionId && turn.proposal?.status === "pending");
}
export function ComponentResearchReview({ record, onChanged, unified = false, onBlockedChange, workDocumentId, onWorkDocumentSelect, readerHeight = "calc(100dvh - 300px)" }: {
  unified?: boolean; onBlockedChange?: (blocked: boolean) => void;
  workDocumentId?: string; onWorkDocumentSelect?: (id: string) => void;
  readerHeight?: string; record: ComponentResearchRecord; onChanged: (record: ComponentResearchRecord) => void;
}) {
  const researchDocument = record.document ?? { overview: "", sections: [] };
  const sections = [...researchDocument.sections].sort(compareComponentSections);
  const workDocuments = record.work_documents ?? [];
  const documentTitle = researchDocument.overview.match(/^#\s+(.+)$/m)?.[1] ?? record.topic;
  const reader = useRef<HTMLDivElement>(null);
  const searchableContent = useRef<HTMLDivElement>(null);
  const [notesToolbar, setNotesToolbar] = useState<HTMLSpanElement | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [showDiscussion, setShowDiscussion] = useState(false), [treeBeforeDiscussion, setTreeBeforeDiscussion] = useState(true);
  // 正文优先：开对话时让出左侧目录给正文，关掉对话再恢复原样，正文宽度基本不因对话缩水。
  function toggleDiscussion() {
    if (showDiscussion) { setShowDiscussion(false); setTreeVisible(treeBeforeDiscussion); return; }
    setTreeBeforeDiscussion(treeVisible); setTreeVisible(false); setShowDiscussion(true);
  }
  const [treeVisible, setTreeVisible] = useState(true);
  const [selected, setSelected] = useState(sections[0]?.id ?? "");
  const [selectedWork, setSelectedWork] = useState("");
  const [message, setMessage] = useState("");
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeFocus>();
  const [view, setView] = useState<"component" | "document">("component");
  const [editor, setEditor] = useState<ComponentResearchSection>();
  const [detailTab, setDetailTab] = useState<"content" | "changes" | "history">("content");
  const [artifacts, setArtifacts] = useState<{ mapping: string; rules: unknown[]; files: Record<string, string> }>();
  const [metadataText, setMetadataText] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [supplementing, setSupplementing] = useState(false), [supplementMessage, setSupplementMessage] = useState("");
  const active = record.production?.working ?? ["queued", "running"].includes(record.status);
  const draftPreview = active || ["failed", "cancelled"].includes(record.status);
  const workDocument = view === "component" ? workDocuments.find(item => item.id === (workDocumentId ?? selectedWork)) ?? (!sections.length ? workDocuments[0] : undefined) : undefined;
  const readonly = record.production?.review.readonly || !!workDocument;
  const section = sections.find(item => item.id === selected) ?? sections[0];
  const proposal = section && latestComponentProposal(record, section.id);
  const previewSections = sections.map(item => {
    const candidate = latestComponentProposal(record, item.id);
    return !readonly && record.production?.review.sections.find(section => section.id === item.id)?.proposal_message && candidate?.proposal
      ? { ...candidate.proposal.section, id: item.id, revision: item.revision, selected: item.selected } : item;
  });
  const previewSection = previewSections.find(item => item.id === section?.id);
  const guideSections = previewSections.filter(item => item.selected && (draftPreview
    ? [item.content, item.interfaces, item.integration, item.example, item.unit_tests].some(text => text.trim())
    : item.paradigm?.kind === "paradigm" && item.paradigm.status === "recommended"));
  let guide = "", guideError = "";
  try { if (view === "document" || !unified && !reviewing) guide = draftPreview ? [`# ${record.topic}`, researchDocument.overview,
    ...guideSections.map(item => `<a id="component-${item.id}"></a>\n\n${sectionMarkdown(item, true).replace(/^# /, "## ")}`),
  ].filter(Boolean).join("\n\n") : componentGuideMarkdown(record.topic, researchDocument.overview, guideSections); }
  catch (error) { guideError = error instanceof Error ? error.message : String(error); }
  const showingProposal = !!section && previewSection !== section;
  const historyBody = useResearchResource<NonNullable<ComponentResearchRecord["section_history"]>>(record.deferred_details && detailTab === "history" && section
    ? `/component-research/${record.id}/history/${section.id}` : undefined, section?.revision);
  const versions = record.deferred_details ? historyBody.value : (record.section_history ?? []).filter(h => h.section.id === section?.id);
  const workBody = useResearchResource<{ content: string }>(record.deferred_details && workDocument
    ? `/component-research/${record.id}/work-document/${workDocument.id}` : undefined, undefined, true);
  const workContent = workBody.value?.content ?? workDocument?.content ?? "";
  const turns = (record.review_turns ?? []).filter(turn => turn.mode !== "supplement" && turn.section_id === section?.id);
  const supplements = (record.review_turns ?? []).filter(turn => turn.mode === "supplement");
  const scope = componentResearchSources(record).map(source => source.name).join("、");
  const searchKey = view === "document" ? `${record.id}:document:${guide}` : workDocument ? `${record.id}:work:${workDocument.id}:${workContent}` : `${record.id}:component:${section?.id}:${section?.revision}:${proposal?.id}:${proposal?.status}:${proposal?.proposal?.status}`;
  const sectionPreview = previewSection && <div ref={searchableContent}><KnowledgeMarkdown text={sectionMarkdown(previewSection, draftPreview)} focus={knowledgeFocus} /></div>;
  useEffect(() => { onBlockedChange?.(busy || active || !!editor || !!workDocument); return () => onBlockedChange?.(false); }, [busy, active, editor, workDocument, onBlockedChange]);
  useEffect(() => { setArtifacts(undefined); }, [record.id, sections.map(s => `${s.id}:${s.revision}:${s.selected}`).join("|")]);
  useEffect(() => { setSelected(""); setSelectedWork(""); setReviewing(false); setMessage(""); setError(""); setView("component"); setEditor(undefined); }, [record.id]);
  useEffect(() => { if (workDocumentId) { setView("component"); setKnowledgeFocus(undefined); } }, [workDocumentId]);
  function selectWork(id: string) {
    setSelectedWork(id); onWorkDocumentSelect?.(id); setView("component"); setKnowledgeFocus(undefined); setShowDiscussion(false); setError("");
  }
  function navigateKnowledge(id: string, line?: number) {
    if (editor && (editor.id !== id || line !== undefined)) { setError("请先保存或取消当前编辑，再跳转章节。"); return; }
    setSelectedWork(""); onWorkDocumentSelect?.(""); setSelected(id); setMessage(""); setError(""); setDetailTab("content");
    setKnowledgeFocus(old => ({ line, ...(view === "document" && line === undefined ? { anchor: `component-${id}` } : {}), token: (old?.token ?? 0) + 1 }));
  }
  const outlineItems = previewSections.map(item => ({ id: item.id, title: item.title, content: "", selected: item.selected,
    status: record.production?.review.sections.find(section => section.id === item.id)?.status_label }));
  function withWorkDocuments(outline: ReactNode) {
    if (!workDocuments.length) return outline;
    return <div className="flex min-h-0 flex-col overflow-hidden">
      <section aria-label="过程文稿目录" className="max-h-[40%] shrink-0 overflow-auto border-b border-r border-line bg-muted/30 p-3">
        <h3 className="mb-2 text-sm font-medium">过程文稿</h3>
        {workDocuments.map(item => <Button key={item.id} variant="ghost" className="h-auto min-h-9 w-full justify-start whitespace-normal px-2 py-2 text-left" aria-current={view === "component" && workDocument?.id === item.id ? "page" : undefined} onClick={() => selectWork(item.id)}>
          <span className="min-w-0"><strong className="block break-words font-medium">{item.title}</strong><small className="text-muted-foreground">{item.status_label}</small></span>
        </Button>)}
      </section>{outline}
    </div>;
  }
  async function request(action: string, body: unknown) {
    setBusy(true); setError("");
    try { onChanged(await componentRequest<ComponentResearchRecord>(`/component-research/${record.id}/${action}`, body)); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function send(mode: "discuss" | "rework" | "update") {
    if (section && await request("review", { section_id: section.id, mode, message })) setMessage("");
  }
  if (!unified && !reviewing) return <section aria-label="组件萃取文档">
    <ComponentDocumentReader height={readerHeight} selected={workDocument?.id || selected || "overview"} onSelect={id => workDocuments.some(item => item.id === id) ? selectWork(id) : navigateKnowledge(id)}
      files={[{ id: "overview", path: [documentTitle, "使用指南.md"], content: guideError ? `文稿格式需要修订：${guideError}` : guide }, ...sections.map(s => ({ id: s.id, path: [documentTitle, "逐项审查", `${s.title}.md`], content: sectionMarkdown(s, draftPreview), searchText: s.title, metadata: s.paradigm ? JSON.stringify(s.paradigm, null, 2) : undefined })),
        ...workDocuments.map(item => ({ id: item.id, path: [documentTitle, "过程文稿", `${item.title}.md`], content: item.id === workDocument?.id ? workContent : item.content }))]}
      actions={<><Button variant="ghost" onClick={() => setReviewing(true)}>审阅与修订</Button><a className="px-2 text-sm text-primary" href={`/component-research/${record.id}/document`} download>下载 Markdown</a></>} />
  </section>;
  return <section aria-label="组件审核工作区" className="research-review" style={unified ? { flex: "1 1 0", height: readerHeight, minHeight: 0, margin: 0, border: 0, borderRadius: 0 } : undefined}>
    <div className="research-review-toolbar" style={unified ? { padding: "7px 16px", gap: 8, flexWrap: "nowrap" } : undefined}>
      {!workDocument && <KnowledgeReviewNotes refreshToken={record} kind="component" jobId={record.id} documentId="" scope="study" commentOnly={readonly} working={active} />}
      {!unified && <Button variant="ghost" onClick={() => setReviewing(false)}>返回文档</Button>}
      <Button variant="ghost" size="sm" aria-expanded={treeVisible} onClick={() => setTreeVisible(value => !value)}>{treeVisible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}{treeVisible ? "收起目录" : "展开目录"}</Button>
      <strong className="mr-auto flex min-w-0 items-center gap-2 text-sm" title={record.production?.review.selection_message}><FileText size={16} className="shrink-0" /><span className="truncate">{view === "document" ? "完整文档" : workDocument?.title || section?.title || documentTitle}</span></strong>
      {(view === "document" || !!workDocument || !!section && detailTab === "content" && editor?.id !== section.id) && <KnowledgeContentSearch contentRef={searchableContent} contentKey={searchKey} contentSelector=".md" />}
      <div className="research-review-views shrink-0" role="group" aria-label="审查视图"><Button size="sm" aria-pressed={view === "component"} variant={view === "component" ? "secondary" : "ghost"} onClick={() => { setView("component"); setKnowledgeFocus(undefined); }}>{unified ? "逐项审查" : "逐项审核"}</Button>
        <Button size="sm" aria-pressed={view === "document"} variant={view === "document" ? "secondary" : "ghost"} onClick={() => { setView("document"); setKnowledgeFocus(undefined); }}>完整文档</Button></div>
      {unified && view === "component" && !workDocument && <Button size="sm" variant="ghost" aria-expanded={showDiscussion} onClick={toggleDiscussion}>研究对话{showDiscussion ? " · 收起" : ""}</Button>}
      {unified && <span ref={setNotesToolbar} className="flex items-center" />}
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="文稿更多操作" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root">
        {sections.some(s => s.paradigm) && <DropdownMenuItem disabled={active} onClick={async () => { try { setArtifacts(await componentRequest(`/component-research/${record.id}/artifacts`)); } catch (e) { setError((e as Error).message); } }}>查看派生产物</DropdownMenuItem>}
        <DropdownMenuItem render={<a href={`/component-research/${record.id}/document`} download />}><Download size={16} />下载 Markdown</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </div>
    <Dialog open={!!artifacts} onOpenChange={open => { if (!open) setArtifacts(undefined); }}><DialogContent className="tw-root max-h-[88dvh] overflow-auto sm:max-w-4xl">
      <DialogHeader><DialogTitle>派生预览 · 规则未启用</DialogTitle></DialogHeader>
      {artifacts && <section aria-label="组件派生产物"><Button variant="outline" size="sm" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(artifacts, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "component-artifacts.json"; a.click(); URL.revokeObjectURL(url); }}>下载结构化产物</Button><Markdown text={artifacts.mapping} /><p>{Object.keys(artifacts.files).length} 个文件 · {artifacts.rules.length} 条规则候选</p><details><summary>文件与程序提取结果</summary><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(artifacts, null, 2)}</pre></details></section>}
    </DialogContent></Dialog>
    <Dialog open={supplementing} onOpenChange={setSupplementing}><DialogContent className="tw-root max-h-[88dvh] overflow-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>补充遗漏能力</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">说明文稿漏了哪些能力、接口或场景。Agent 在本次研究的来源仓（{scope}）中核对源码和实际调用，按功能能力补充组件用法；新增项经独立评审后并入目录并默认勾选，照常逐项审查后发布。</p>
      <div className="max-h-[260px] space-y-3 overflow-auto" aria-live="polite">
        {[...supplements].reverse().map(turn => { const label = record.production?.review.turns.find(item => item.id === turn.id)?.status_label;
          const added = turn.status === "done" ? sections.filter(item => turn.added_section_ids?.includes(item.id)) : [];
          return <article key={turn.id} className="space-y-1 border-b border-line pb-3 text-sm">
            <p className="text-xs text-muted-foreground">{turn.operator} · {new Date(turn.created_at).toLocaleString()} · {label}</p>
            <p className="whitespace-pre-wrap break-words">{turn.message}</p>
            {turn.error && <p className="text-danger">{turn.error}</p>}
            {!!added.length && <p>已补充：{added.map(item => <button key={item.id} className="knowledge-inline-link mr-2" onClick={() => { setSupplementing(false); setView("component"); navigateKnowledge(item.id); }}>{item.title}</button>)}</p>}
          </article>; })}
      </div>
      {!readonly && <><Textarea aria-label="遗漏的能力说明" rows={4} maxLength={20000} placeholder="例如：漏了连接池的超时回收；异步调用的取消接口也没写。" value={supplementMessage} onChange={e => setSupplementMessage(e.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSupplementing(false)}>关闭</Button>
          <Button disabled={busy || active || !supplementMessage.trim()} onClick={async () => { if (await request("review", { section_id: "", mode: "supplement", message: supplementMessage })) setSupplementMessage(""); }}>开始补充</Button></div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {active && <p className="text-sm text-muted-foreground">研究进行中，本轮结束后才能发起补充。</p>}</>}
    </DialogContent></Dialog>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {view === "document" ? <div className="research-review-panes" style={!treeVisible ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
      {treeVisible && withWorkDocuments(<KnowledgeOutline title={record.topic} items={outlineItems.filter(item => guideSections.some(section => section.id === item.id))} currentId={section?.id} onNavigate={navigateKnowledge} label="文档组件目录" itemLabel={unified ? "能力" : undefined} itemUnit={unified ? "项" : undefined} />)}
      <div ref={reader} tabIndex={0} aria-label="完整文档阅读区" className="research-reader research-full-document studio-paper"><p className="mb-4 text-sm text-muted-foreground">{active ? "研究仍在进行，已生成的内容会持续更新，当前仅供阅读。" : "完整文档按当前选择展示，可在逐项审查中调整。"}</p>
        <div ref={searchableContent}>{guideError ? <p role="alert" className="text-danger">文稿格式需要修订：{guideError}</p> : draftPreview && !guideSections.length ? <p className="text-sm text-muted-foreground">当前还没有生成组件用法，可先在左侧阅读过程文稿。</p> : <KnowledgeMarkdown text={guide} focus={knowledgeFocus} />}</div>
      </div>
    </div>
      : <div className="research-review-panes" style={!treeVisible ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
        {treeVisible && withWorkDocuments(<KnowledgeOutline title={record.topic} items={outlineItems} currentId={workDocument ? undefined : section?.id} onNavigate={navigateKnowledge} onSelection={readonly ? undefined : (id, selected) => void request("selection", { ids: [id], selected })} disabled={busy || active || !!editor} label="组件能力目录" itemLabel={unified ? "能力" : undefined} itemUnit={unified ? "项" : undefined} actions={!readonly && <>
          <button disabled={busy || active || readonly || !!editor || !sections.length} className="text-primary disabled:opacity-40 hover:underline" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: true })}>全选</button>
          <button disabled={busy || active || readonly || !!editor || !sections.length} className="text-primary disabled:opacity-40 hover:underline" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: false })}>全不选</button>
          <button disabled={busy || !!editor} className="text-primary disabled:opacity-40 hover:underline" onClick={() => { setSupplementing(true); setError(""); }}>补充遗漏能力{supplements.some(turn => ["queued", "running"].includes(turn.status)) ? " · 进行中" : ""}</button>
        </>} />)}
        <div className="research-reader" style={unified ? { display: "grid", gridTemplateColumns: showDiscussion ? "minmax(0, 1fr) 320px" : "minmax(0, 1fr)", padding: 0, overflow: "hidden" } : undefined}>
          {workDocument ? <div ref={reader} tabIndex={0} aria-label="组件过程文稿" className="research-document-content studio-paper" style={{ padding: "16px 28px 28px", overflow: "auto", minWidth: 0, minHeight: 0 }}>
            <p className="mb-3 text-sm text-muted-foreground">{workDocument.status_label} · 过程文稿仅供阅读，正式用法会陆续加入能力目录。</p>
            <div ref={searchableContent}>{record.deferred_details && !workBody.value ? <p role="status">{workBody.error ?? "正在读取文稿…"}</p> : <KnowledgeMarkdown text={workContent} />}</div>
          </div> : section ? <>
            <div ref={reader} tabIndex={0} aria-label="组件详细文档" className="research-document-content studio-paper" style={unified ? { padding: "16px 28px 28px", overflow: "auto", minWidth: 0, minHeight: 0 } : undefined}>
              <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="章节内容视图">
                <span className="mr-auto text-sm text-muted-foreground">{record.production?.review.sections.find(item => item.id === section.id)?.proposal_message ?? record.production?.review.sections.find(item => item.id === section.id)?.status_label}{!readonly && !showingProposal && record.production?.review.sections.find(item => item.id === section.id)?.proposal_problem && <span className="text-warning"> · {record.production.review.sections.find(item => item.id === section.id)?.proposal_problem}</span>}</span>
                {([["content", "正文"], ["changes", "修订差异"], ["history", "历史版本"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={detailTab === value ? "secondary" : "ghost"} onClick={() => setDetailTab(value)}>{label}</Button>)}
                {!readonly && <Button size="sm" variant="outline" disabled={busy || active || !!proposal} title={proposal ? "请先在修订差异中放弃当前修改，再人工编辑" : undefined} onClick={() => { setEditor(structuredClone(section)); setMetadataText(section.paradigm ? JSON.stringify(section.paradigm, null, 2) : ""); setDetailTab("content"); }}>人工编辑</Button>}
              </div>
              {detailTab === "content" && (editor?.id === section.id ? <div className="grid gap-3">
                {([['title', '标题'], ['content', '适用场景、使用步骤与使用约束'], ['interfaces', '关键接口'], ['integration', '接入配置'], ['example', '完整示例'], ['unit_tests', '单元测试示例'], ['sources', '来源']] as const).map(([key, label]) => <label key={key} className="grid gap-1">{label}<Textarea aria-label={`编辑${label}`} value={editor[key]} rows={key === "title" ? 1 : 6} disabled={key === "sources" && !!editor.paradigm} onChange={e => setEditor({ ...editor, [key]: e.target.value })} /></label>)}
                {editor.paradigm && <label className="grid gap-1">范式结构化字段（与正文同版本保存）<Textarea aria-label="编辑范式字段" rows={16} value={metadataText} onChange={e => setMetadataText(e.target.value)} /></label>}
                <div className="flex gap-2"><Button disabled={busy} onClick={async () => { try { const updated = editor.paradigm ? { ...editor, paradigm: JSON.parse(metadataText) } : editor; if (await request("edit-section", { section: updated, base_revision: editor.revision })) { setEditor(undefined); setArtifacts(undefined); } } catch { setError("范式字段必须是有效 JSON"); } }}>保存人工版本</Button><Button variant="outline" onClick={() => setEditor(undefined)}>取消编辑</Button></div>
              </div> : <KnowledgeReviewNotes refreshToken={record} kind="component" jobId={record.id} documentId={section.id} commentOnly={readonly} toolbarTarget={notesToolbar} working={active}>{sectionPreview}</KnowledgeReviewNotes>)}
              {detailTab === "changes" && (proposal?.proposal ? <div>
                <p className="mb-3 text-sm">建议基于修订 {proposal.proposal.base_revision}，当前修订 {section.revision}。{proposal.proposal.base_revision !== section.revision && "正文已变化，请重新生成建议或手工合并。"}</p>
                <pre className="whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(sectionMarkdown(section), sectionMarkdown(proposal.proposal.section)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre>
                {!readonly && <div className="mt-3 flex items-center gap-2">{unified ? <span className="mr-auto text-sm text-muted-foreground">确认并发布时会一并应用本轮修改。</span> : <Button disabled={busy || proposal.proposal.base_revision !== section.revision || proposal.status !== "done"} onClick={() => void request("proposal", { turn_id: proposal.id, decision: "accept" })}>采纳此建议</Button>}<Button variant="outline" disabled={busy} onClick={() => void request("proposal", { turn_id: proposal.id, decision: "discard" })}>放弃建议</Button></div>}
              </div> : <p className="text-muted-foreground">没有待采纳建议。可在右侧提交修订意见。</p>)}
              {detailTab === "history" && <div className="space-y-3">{!versions ? <p role="status">{historyBody.error ?? "正在读取历史版本…"}</p> : versions.length ? [...versions].reverse().map(h => <details key={h.section.revision} className="rounded border border-line p-3"><summary>修订 {h.section.revision} · {h.operator} · {new Date(h.at).toLocaleString()}</summary><Markdown text={sectionMarkdown(h.section)} />{!readonly && <Button disabled={busy} onClick={() => void request("restore-section", { section_id: section.id, revision: h.section.revision, base_revision: section.revision })}>恢复为新版本</Button>}</details>) : <p className="text-muted-foreground">尚无历史版本。</p>}</div>}

              {!!section.related_ids.length && <div className="mt-4 border-t border-line pt-3"><strong className="text-sm">关联组件</strong><div className="mt-2 flex flex-wrap gap-2">{section.related_ids.map(id => <Button key={id} variant="outline" size="sm" onClick={() => navigateKnowledge(id)}>{sections.find(s => s.id === id)?.title ?? id}</Button>)}</div></div>}
            </div>
            {(!unified || showDiscussion) && <section aria-label="组件专家对话" className="research-discussion" style={unified ? { margin: 0, overflow: "auto", minHeight: 0 } : undefined}>
              <h3 className="font-semibold">与 AI 讨论 · {section.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">可追问依据、指出遗漏或要求补充示例。修改完成后直接检视文稿，确认并发布后生效。</p>
              <div className="my-4 max-h-[360px] space-y-4 overflow-auto" aria-live="polite">
                {turns.map(turn => <article key={turn.id} className="space-y-2 border-b border-line pb-3">
                  <p className="text-xs text-muted-foreground">{turn.operator} · {turn.mode === "rework" ? "要求本项返工" : "讨论"} · {new Date(turn.created_at).toLocaleString()}{turn.skill && ` · Skill ${turn.skill.digest.slice(0, 8)}`}</p>
                  <p className="whitespace-pre-wrap break-words">{turn.message}</p>
                  {turn.proposal && <p className="text-sm text-primary">{record.production?.review.turns.find(item => item.id === turn.id)?.proposal_status_label}{turn.proposal.status === "pending" && <Button variant="link" onClick={() => setDetailTab("changes")}>比较差异</Button>}</p>}
                  {turn.reply ? <div className="rounded-md bg-surface p-3"><Markdown text={turn.reply} /></div> : <p className={turn.error ? "text-danger" : "text-muted-foreground"}>{turn.error ?? record.production?.review.turns.find(item => item.id === turn.id)?.status_label}</p>}
                </article>)}
                {!turns.length && <p className="text-sm text-muted-foreground">此组件尚无讨论记录。</p>}
              </div>
              {!readonly && <><Textarea aria-label="组件讨论或返工意见" rows={4} placeholder="例如：请拆清同步与异步用法，补充错误处理示例，并核对头文件实际对应的库。" value={message} onChange={e => setMessage(e.target.value)} maxLength={20000} />
                <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void send("rework")}>生成修订建议</Button><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("update")}>核对来源更新</Button></div>
                {record.production?.review.active_message && <p className="mt-2 text-sm text-muted-foreground">{record.production.review.active_message}</p>}
              </>}
            </section>}
          </> : <div className="rounded-lg border border-line p-5"><Markdown text={researchDocument.overview || "正在阅读来源仓，分析文件操作、数据库操作等功能能力与实际用法。"} /></div>}
        </div>
      </div>}
  </section>;
}
