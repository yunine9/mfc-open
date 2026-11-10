import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Check, ChevronDown, ChevronUp, Code2, Copy, FileText, LoaderCircle, MessageSquare, Plus, Search, Send, Square, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getSession } from "./api";
import { answerParts } from "./knowledgeAnswerPresentation";
import { KnowledgeAnswerMarkdown } from "./KnowledgeAnswerMarkdown";
import { deleteKnowledgeAnswer, KnowledgeAnswerRequestError, cancelKnowledgeAnswer, getKnowledgeAnswer, getKnowledgeAnswerCatalog, getKnowledgeAnswers, knowledgeAnswerRunning, newerKnowledgeAnswer, questionContext, sendKnowledgeAnswerFeedback, startKnowledgeAnswer, type KnowledgeAnswerCatalog, type KnowledgeAnswerContext, type KnowledgeAnswerEvidence, type KnowledgeAnswerInput, type KnowledgeAnswerRecord, type KnowledgeAnswerSummary } from "./knowledgeAnswersApi";
import "./KnowledgeAnswers.css";

const sourceLabels = { knowledge: "知识文档", code: "仓库代码", everycode: "Every Code", wireless: "无线豆包", material: "原始资料" };
const stages = { queued: "等待开始", researching: "检索文档", answering: "整理回答", checking: "检查引用", done: "回答完成" };
const statusLabel = (record: KnowledgeAnswerSummary) => record.status === "failed" ? "回答失败" : record.status === "cancelled" ? "已停止" : stages[record.stage];
const messageOf = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。";
const draftKey = (account: string) => `mae-flow:knowledge-answer:draft:${account}`;
const elapsed = (created: string, now: number) => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

interface QuestionDraft { question: string; context: KnowledgeAnswerContext }
interface Props {
  answerId?: string;
  moduleKey?: string;
  documentId?: string;
  onSelect: (id: string) => void;
}

function readDraft(account: string): QuestionDraft | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(draftKey(account)) || "null");
    if (!value || typeof value !== "object") return;
    const draft = value as QuestionDraft;
    if (typeof draft.question !== "string" || !draft.context || typeof draft.context !== "object") return;
    return { question: draft.question, context: {
      ...(Array.isArray(draft.context.module_ids) ? { module_ids: draft.context.module_ids.filter(id => typeof id === "string") } : {}),
      ...(typeof draft.context.document_id === "string" ? { document_id: draft.context.document_id } : {}),
      ...(typeof draft.context.product_version === "string" ? { product_version: draft.context.product_version } : {}),
    } };
  } catch { /* 浏览器禁用存储时，仍可在本页提问。 */ }
}

function EvidencePane({ answerId, evidence, quote, onClose }: { answerId: string; evidence: KnowledgeAnswerEvidence; quote?: string; onClose: () => void }) {
  const pane = useRef<HTMLElement>(null);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [evidence.id]);
  useEffect(() => { pane.current?.focus(); pane.current?.scrollTo(0, 0); }, [evidence.id, quote]);
  return <aside ref={pane} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }} className="ka-evidence" aria-label="本次引用原文">
    <header><div><small>{sourceLabels[evidence.kind]}</small><h3>{evidence.title}</h3></div><Button variant="ghost" size="icon-sm" aria-label="关闭引用原文" onClick={onClose}><X size={16} /></Button></header>
    <details className="ka-evidence-details"><summary>来源信息与版本</summary><dl className="ka-evidence-meta">
      {evidence.repository && <div><dt>仓库</dt><dd>{evidence.repository}</dd></div>}
      {evidence.path && <div><dt>文件</dt><dd>{evidence.path}</dd></div>}
      <div><dt>版本</dt><dd>{evidence.revision || "来源未提供版本"}</dd></div>
      {evidence.scope && <div><dt>适用范围</dt><dd>{evidence.scope}</dd></div>}
      {(evidence.location || evidence.start_line) && <div><dt>位置</dt><dd>{evidence.location || `第 ${evidence.start_line}${evidence.end_line ? `–${evidence.end_line}` : ""} 行`}</dd></div>}
      <div><dt>查阅时间</dt><dd>{new Date(evidence.retrieved_at).toLocaleString("zh-CN")}</dd></div>
    </dl></details>
    <p className="ka-evidence-note">这里保存的是本次回答实际查阅的内容。</p>
    {evidence.truncated && <p className="ka-notice">来源返回内容不完整，以下仅为实际查阅部分。</p>}
    {evidence.image ? <section aria-label="本次查阅图片" className="space-y-3">
      <img src={`/knowledge-answers/${encodeURIComponent(answerId)}/evidence/${encodeURIComponent(evidence.id)}/image`}
        alt={evidence.title} className="h-auto max-w-full rounded-lg border border-line" onError={() => setImageFailed(true)} />
      {imageFailed && <p role="alert" className="ka-notice">本次查阅的图片暂时无法显示，请稍后重试。</p>}
      <h4>图片核对说明</h4><pre className="ka-evidence-content" tabIndex={0}>{evidence.content}</pre>
    </section> : quote !== undefined ? <><section className="ka-quoted-source" aria-label="本段引用原句"><h4>本段引用</h4><pre className="ka-evidence-content" tabIndex={0}>{quote}</pre></section><details className="ka-full-source"><summary>查看本次查阅的完整内容</summary><pre className="ka-evidence-content" tabIndex={0}>{evidence.content}</pre></details></> : <pre className="ka-evidence-content" tabIndex={0}>{evidence.content}</pre>}
  </aside>;
}

function EvidenceList({ title, items, selectedId, onSelect }: { title: string; items: KnowledgeAnswerEvidence[]; selectedId: string; onSelect: (id: string) => void }) {
  if (!items.length) return null;
  return <section className="ka-citations" aria-label={title}><h3><BookOpen size={16} />{title}<span>{items.length}</span></h3>{items.map((item, index) => <button key={item.id} type="button" aria-pressed={item.id === selectedId} onClick={() => onSelect(item.id)}><span>{index + 1}</span><div><strong>{item.title}</strong><small>{sourceLabels[item.kind]}{item.path ? ` · ${item.path}` : ""}{item.revision ? ` · ${item.revision.slice(0, 12)}` : " · 版本未提供"}</small></div><ArrowUpRight size={14} /></button>)}</section>;
}

export function KnowledgeAnswers({ answerId = "", moduleKey, documentId, onSelect }: Props) {
  const [history, setHistory] = useState<KnowledgeAnswerSummary[]>([]), [historyError, setHistoryError] = useState("");
  const [catalog, setCatalog] = useState<KnowledgeAnswerCatalog>(), [catalogError, setCatalogError] = useState("");
  const [record, setRecord] = useState<KnowledgeAnswerRecord>(), [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<QuestionDraft>({ question: "", context: questionContext(moduleKey, documentId) });
  const [account, setAccount] = useState(""), [draftReady, setDraftReady] = useState(false);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState(""), [refresh, setRefresh] = useState(0);
  const [selectedEvidence, setSelectedEvidence] = useState(""), [showContext, setShowContext] = useState(!!moduleKey || !!documentId);
  const [feedbackChoice, setFeedbackChoice] = useState<boolean>(), [feedbackComment, setFeedbackComment] = useState("");
  const [now, setNow] = useState(Date.now);
  const [historyQuery, setHistoryQuery] = useState("");
  const [selectedQuote, setSelectedQuote] = useState<string>();
  const [copyState, setCopyState] = useState("");
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeAnswerSummary>();
  const [deleteError, setDeleteError] = useState("");
  const deletedIds = useRef(new Set<string>());
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  function openEvidence(id: string, quote?: string) {
    evidenceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedQuote(quote); setSelectedEvidence(id);
  }
  function closeEvidence() {
    setSelectedEvidence(""); setSelectedQuote(undefined);
    evidenceTrigger.current?.focus();
  }
  const selectedId = useRef(answerId); selectedId.current = answerId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!record || !knowledgeAnswerRunning(record)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [record?.id, record?.status]);

  useEffect(() => {
    let live = true;
    void getSession().then(session => {
      if (!live) return;
      if (session?.username) {
        const saved = readDraft(session.username), context = questionContext(moduleKey, documentId);
        setAccount(session.username);
        if (saved) {
          setDraft({ ...saved, context: { ...saved.context, ...context } });
        }
      }
      setDraftReady(true);
    }).catch(() => { if (live) setDraftReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!draftReady || !account) return;
    try { sessionStorage.setItem(draftKey(account), JSON.stringify(draft)); } catch { /* 存储不可用不影响提交。 */ }
  }, [draft, account, draftReady]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryError(""); setCatalogError("");
    void getKnowledgeAnswers(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setHistory(current => {
        // 列表可能晚于单条更新返回；保留本页已取得的新记录和最终状态。
        const merged = new Map(current.map(item => [item.id, item]));
        for (const item of result.answers) if (!deletedIds.current.has(item.id)) merged.set(item.id, newerKnowledgeAnswer(merged.get(item.id), item));
        return [...merged.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
    }).catch(error => { if (!controller.signal.aborted) setHistoryError(messageOf(error)); });
    void getKnowledgeAnswerCatalog(controller.signal).then(setCatalog).catch(error => { if (!controller.signal.aborted) setCatalogError(messageOf(error)); });
    return () => controller.abort();
  }, [refresh]);

  function receive(next: KnowledgeAnswerRecord) {
    if (!mounted.current || deletedIds.current.has(next.id)) return;
    setHistory(current => {
      const previous = current.find(item => item.id === next.id);
      return [newerKnowledgeAnswer(previous, next), ...current.filter(item => item.id !== next.id)].sort((a, b) => b.created_at.localeCompare(a.created_at));
    });
    if (selectedId.current === next.id) setRecord(current => newerKnowledgeAnswer(current, next));
  }
  useEffect(() => {
    main.current?.scrollTo(0, 0); setQuestionExpanded(false); setCopyState(""); setSelectedQuote(undefined);
    setRecord(undefined); setLoadError(""); setActionError(""); setSelectedEvidence(""); setFeedbackChoice(undefined); setFeedbackComment("");
    if (!answerId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    async function poll() {
      try {
        const next = await getKnowledgeAnswer(answerId, controller.signal);
        if (controller.signal.aborted || deletedIds.current.has(answerId)) return;
        failures = 0; receive(next); setLoadError("");
        if (knowledgeAnswerRunning(next)) timer = setTimeout(() => { void poll(); }, 1500);
      } catch (error) {
        if (controller.signal.aborted || deletedIds.current.has(answerId)) return;
        const retry = !(error instanceof KnowledgeAnswerRequestError) || error.status === 429 || error.status >= 500;
        setLoadError(retry ? `连接暂时中断，正在自动重连。${messageOf(error)}` : messageOf(error));
        if (retry) timer = setTimeout(() => { void poll(); }, Math.min(1500 * 2 ** failures++, 15000));
      }
    }
    void poll();
    // 离开页面只停止浏览器轮询，服务端继续回答。
    return () => { controller.abort(); clearTimeout(timer); };
  }, [answerId, refresh]);

  async function submit(input: KnowledgeAnswerInput, clearDraft = false) {
    if (busy || !input.question.trim()) return;
    setBusy(true); setActionError("");
    try {
      const next = await startKnowledgeAnswer({ question: input.question.trim(), context: input.context ? {
        module_ids: input.context.module_ids, document_id: input.context.document_id, product_version: input.context.product_version,
      } : undefined });
      if (!mounted.current) return;
      receive(next);
      if (clearDraft) setDraft(current => ({ ...current, question: "", context: current.context }));
      onSelect(next.id);
    } catch (error) { if (mounted.current) setActionError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function stop() {
    if (!record || busy) return;
    setBusy(true); setActionError("");
    try { receive(await cancelKnowledgeAnswer(record.id)); }
    catch (error) { if (mounted.current) setActionError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function askDelete(item: KnowledgeAnswerSummary) { setDeleteError(""); setDeleteTarget(item); }
  async function remove() {
    if (!deleteTarget || busy) return;
    const id = deleteTarget.id;
    setBusy(true); setDeleteError("");
    try {
      await deleteKnowledgeAnswer(id);
      if (!mounted.current) return;
      deletedIds.current.add(id);
      setHistory(current => current.filter(item => item.id !== id));
      setDeleteTarget(undefined);
      if (selectedId.current === id) { setRecord(undefined); onSelect(""); }
    } catch (error) { if (mounted.current) setDeleteError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function feedback() {
    if (!record || feedbackChoice === undefined || busy) return;
    setBusy(true); setActionError("");
    try { receive(await sendKnowledgeAnswerFeedback(record.id, feedbackChoice, feedbackComment.trim())); if (mounted.current) { setFeedbackChoice(undefined); setFeedbackComment(""); } }
    catch (error) { if (mounted.current) setActionError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function changeContext(value: Partial<KnowledgeAnswerContext>) { setDraft(current => ({ ...current, context: { ...current.context, ...value } })); }
  const evidence = record?.evidence.find(item => item.id === selectedEvidence);
  const cited = record?.status === "done" && record.answer ? record.answer.evidence_ids.map(id => record.evidence.find(item => item.id === id)).filter((item): item is KnowledgeAnswerEvidence => !!item) : [];
  const moduleNames = record?.context?.module_ids?.map(id => catalog?.modules.find(item => item.id === id)?.name || id) || [];
  const contextDocument = catalog?.documents?.find(item => item.id === draft.context.document_id);

  async function copyAnswer() {
    if (!record?.answer) return;
    const body = answerParts(record.answer.markdown).filter(part => part.kind === "body").map(part => part.text.trim()).join("\n\n");
    const unknowns = record.answer.unknowns.length ? `\n\n还需要确认\n${record.answer.unknowns.join("\n")}` : "";
    const sources = cited.length ? `\n\n回答依据\n${cited.map((item, index) => `${index + 1}. ${item.title}${item.revision ? ` · ${item.revision}` : ""}`).join("\n")}` : "";
    try { await navigator.clipboard.writeText(body + unknowns + sources); setCopyState("已复制"); }
    catch { setCopyState("复制失败，请选中正文复制"); }
  }
  const visibleHistory = history.filter(item => item.question.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase()));

  return <section className={`tw-root ka-workspace${evidence ? " has-evidence" : ""}`} aria-label="知识问答工作区">
    <aside className="ka-history" aria-label="最近问答">
      <header><span className="ka-brand-icon"><MessageSquare size={20} /></span><h1>知识问答</h1></header>
      <Button className="ka-new-question" onClick={() => onSelect("")}><Plus size={16} />新问题</Button>
      <label className="ka-history-search"><Search size={14} /><input aria-label="搜索历史问题" placeholder="搜索历史问题" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></label>
      <div className="ka-history-label">最近问答<span>{history.length}</span></div>
      {historyError && <div role="alert" className="ka-error">{historyError}<Button variant="ghost" size="sm" onClick={() => setRefresh(value => value + 1)}>重试加载</Button></div>}
      <nav>{visibleHistory.map(item => <div className="ka-history-row" key={item.id}><button type="button" className="ka-history-item" aria-current={answerId === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}><span>{item.question}</span><small><i className={`ka-status-dot is-${item.status}`} />{statusLabel(item)} · {new Date(item.created_at).toLocaleDateString("zh-CN")}</small></button><Button variant="ghost" size="icon-sm" className="ka-delete" aria-label={`删除问题：${item.question}`} title="删除问题" disabled={busy} onClick={() => askDelete(item)}><Trash2 size={14} /></Button></div>)}</nav>
      {history.length > 0 && !visibleHistory.length && <p className="ka-history-empty">没有找到相关问题</p>}
      {!history.length && !historyError && <div className="ka-history-empty"><MessageSquare size={24} /><span>你的问答会保存在这里</span></div>}
    </aside>
    <main className="ka-main" ref={main}>
      {!answerId ? <div className="ka-compose">
        <div className="ka-compose-title"><span className="ka-eyebrow"><BookOpen size={15} />团队知识 · 随问随查</span><h2>从一个问题，找到有依据的答案。</h2><p>查询知识库中已发布的文档，根据相关章节原文回答业务规则和组件用法。</p></div>
        <form className="ka-question-form" onSubmit={event => { event.preventDefault(); void submit(draft, true); }}>
          <label className="ka-input-label" htmlFor="knowledge-answer-question">描述你的问题</label>
          <Textarea id="knowledge-answer-question" aria-label="知识问答问题" placeholder="描述你想了解的问题，也可以补充场景和遇到的困难…" value={draft.question} onChange={event => setDraft(current => ({ ...current, question: event.target.value }))} disabled={!draftReady || busy} maxLength={12000} />
          <Button type="button" variant="ghost" size="sm" className="ka-context-toggle" aria-expanded={showContext} onClick={() => setShowContext(value => !value)}>{showContext ? <ChevronUp size={14} /> : <ChevronDown size={14} />}补充范围与参考文档{(draft.context.module_ids?.length || draft.context.document_id || draft.context.product_version) ? "（已补充）" : "（可选）"}</Button>
          {showContext && <div className="ka-context">
            <label>相关模块<select aria-label="问答相关模块" value={draft.context.module_ids?.[0] || ""} onChange={event => changeContext({ module_ids: event.target.value ? [event.target.value] : [] })}><option value="">所有模块</option>{catalog?.modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="ka-context-document">参考文档<select aria-label="问答参考文档" value={draft.context.document_id || ""} onChange={event => changeContext({ document_id: event.target.value || undefined })}><option value="">不指定</option>{catalog?.documents?.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}{draft.context.document_id && !contextDocument && <option value={draft.context.document_id}>{draft.context.document_id}</option>}</select><small>选择后只在这份文档中查找依据。</small></label>
            <label>适用版本<input aria-label="问答适用版本" value={draft.context.product_version || ""} onChange={event => changeContext({ product_version: event.target.value || undefined })} placeholder="可填写产品或组件版本" /></label>
          </div>}
          {catalogError && <p className="ka-notice">范围选项加载失败，仍可直接提问。<button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></p>}
          {actionError && <p role="alert" className="ka-error">{actionError}</p>}
          <div className="ka-submit"><small>{draft.context.module_ids?.length ? "结合所选模块查阅相关知识" : "仅查询知识库已发布文档"}</small><Button type="submit" disabled={!draftReady || busy || !draft.question.trim()}>{busy ? <LoaderCircle className="ka-spinner" size={16} /> : <Send size={16} />}{busy ? "正在发起" : "提问"}</Button></div>
        </form>
        {!draft.question && <div className="ka-examples" aria-label="提问示例">{[
          { icon: BookOpen, title: "理解业务规则", text: "这条业务规则有哪些适用条件和例外？" },
          { icon: Code2, title: "使用组件", text: "这个组件怎么接入？有哪些配置和使用限制？" },
          { icon: FileText, title: "了解操作步骤", text: "文档中规定的操作步骤是什么？有哪些注意事项？" },
        ].map(example => <button type="button" key={example.title} disabled={!draftReady || busy} onClick={() => { setDraft(current => ({ ...current, question: example.text })); document.getElementById("knowledge-answer-question")?.focus(); }}><example.icon size={18} /><strong>{example.title}</strong><span>{example.text}</span><ArrowUpRight size={14} /></button>)}</div>}
        {catalog?.sources.length ? <details className="ka-sources"><summary>可查阅的来源</summary>{catalog.sources.map(source => <div key={source.kind}><strong>{source.label}</strong><span>{source.detail || (source.available ? "已配置" : "暂未配置")}</span></div>)}</details> : null}
      </div> : <div className="ka-answer-view">
        {loadError && <p role="alert" className="ka-error">{loadError}<Button variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)}>重试加载</Button></p>}
        {!record && !loadError && <p role="status" className="ka-loading"><LoaderCircle className="ka-spinner" size={17} />正在加载问答…</p>}
        {record && <>
          <header className="ka-question"><small><MessageSquare size={14} />你的问题{moduleNames.length ? ` · ${moduleNames.join("、")}` : ""}<Button variant="ghost" size="sm" className="ka-delete-question" disabled={busy} onClick={() => askDelete(record)}><Trash2 size={14} />删除问题</Button></small><h2 className={record.question.length > 120 && !questionExpanded ? "is-collapsed" : undefined}>{record.question}</h2>{record.question.length > 120 && <button type="button" className="ka-question-expand" aria-expanded={questionExpanded} onClick={() => setQuestionExpanded(value => !value)}>{questionExpanded ? "收起问题" : "展开完整问题"}</button>}</header>
          {knowledgeAnswerRunning(record) && <section className="ka-progress" aria-label="回答进度" aria-live="polite"><div><LoaderCircle className="ka-spinner" size={18} /><strong>{statusLabel(record)}</strong><small aria-label="本次已等待时长">已等待 {elapsed(record.created_at, now)}</small><Button variant="outline" size="sm" onClick={() => { void stop(); }} disabled={busy}><Square size={13} />停止</Button></div><p>{record.activity.at(-1)?.message || "问答已提交，正在准备查阅资料。"}</p><small>离开页面不会停止回答，可以稍后回来查看。</small></section>}

          {record.status !== "done" && <EvidenceList title="本次已查阅资料" items={record.evidence} selectedId={selectedEvidence} onSelect={openEvidence} />}
          {record.status === "done" && record.answer && <>
            <div className="ka-answer-toolbar"><span><BookOpen size={16} />回答<span className="ka-answer-source-count">{cited.length} 份依据</span></span><Button variant="ghost" size="sm" onClick={() => { void copyAnswer(); }}>{copyState === "已复制" ? <Check size={14} /> : <Copy size={14} />}复制回答</Button></div>
            {copyState && <p role="status" className="ka-copy-status">{copyState}</p>}
            <article className="ka-answer" aria-label="知识回答"><KnowledgeAnswerMarkdown text={record.answer.markdown} evidenceIds={record.answer.evidence_ids} onOpenKnowledgeLink={(href, quote) => {
              const id = href.startsWith("#evidence-") ? href.slice("#evidence-".length) : undefined;
              if (id && record.evidence.some(item => item.id === id)) openEvidence(id, quote);
            }} /></article>
            {record.answer.unknowns.length > 0 && <section className="ka-unknowns" aria-label="待确认内容"><h3>还需要确认</h3><ul>{record.answer.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
            <EvidenceList title="回答依据" items={cited} selectedId={selectedEvidence} onSelect={openEvidence} />
            <section className="ka-feedback" aria-label="回答反馈"><div><span>{record.feedback ? "已收到你的反馈" : "这次回答有帮助吗？"}</span><Button variant={feedbackChoice === true ? "secondary" : "ghost"} size="sm" aria-pressed={feedbackChoice === true} onClick={() => setFeedbackChoice(true)}><ThumbsUp size={15} />有帮助</Button><Button variant={feedbackChoice === false ? "secondary" : "ghost"} size="sm" aria-pressed={feedbackChoice === false} onClick={() => setFeedbackChoice(false)}><ThumbsDown size={15} />有问题</Button></div>{feedbackChoice !== undefined && <div className="ka-feedback-form"><Textarea aria-label="回答反馈说明" value={feedbackComment} onChange={event => setFeedbackComment(event.target.value)} placeholder={feedbackChoice ? "可以补充哪些部分有帮助（可选）" : "哪里不准确，或缺少哪些依据？（可选）"} maxLength={2000} /><Button size="sm" onClick={() => { void feedback(); }} disabled={busy}>提交反馈</Button></div>}</section>
          </>}
          {(record.status === "failed" || record.status === "cancelled") && <section className="ka-terminal" aria-label="问答未完成"><h3>{record.status === "failed" ? "这次回答未完成" : "回答已停止"}</h3><p>{record.error || (record.status === "failed" ? "服务暂时无法完成回答，请稍后重试。" : "已保留本次问题和查阅过程。")}</p><Button variant="outline" onClick={() => { void submit({ question: record.question, context: record.context }); }} disabled={busy}>重新提问</Button></section>}
          {record.activity.length > 0 && <details className="ka-activity"><summary>查阅过程 · {record.activity.length} 条</summary><ol>{record.activity.map((item, index) => <li key={`${item.at}:${index}`}><span>{stages[item.stage]}</span><p>{item.message}</p></li>)}</ol></details>}
          {record.warnings.length > 0 && <section className="ka-notice" aria-label="来源说明">{record.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</section>}
          {actionError && <p role="alert" className="ka-error">{actionError}</p>}
        </>}
      </div>}
    </main>
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !busy) setDeleteTarget(undefined); }}>
      <DialogContent className="tw-root max-h-[80vh] max-w-lg overflow-auto"><DialogHeader><DialogTitle>删除这条问题？</DialogTitle></DialogHeader>
        <p className="break-words text-sm text-muted-foreground">{deleteTarget?.question}</p>
        <p className="text-sm">将删除这条问题、回答和本次查阅快照，知识库文档和上传原件仍保留。{deleteTarget && knowledgeAnswerRunning(deleteTarget) ? "正在进行的问答也会停止。" : ""}</p>
        {deleteError && <p role="alert" className="ka-error">{deleteError}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(undefined)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => { void remove(); }}>{busy ? "正在删除…" : "确认删除"}</Button></div>
      </DialogContent>
    </Dialog>
    {record && evidence && <EvidencePane answerId={record.id} evidence={evidence} quote={selectedQuote} onClose={closeEvidence} />}
  </section>;
}
