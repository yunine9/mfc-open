import { useTechnologyStacks } from "./useTechnologyStacks";
import { ResizableKnowledgePanes } from "./ResizableKnowledgePanes";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BookOpen, ChevronDown, ChevronRight, ClipboardCheck, FileText, Folder, GitBranch, Lightbulb, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import { documentRequest, knowledgeDocumentResourceUrl, readKnowledgeDocument, type KnowledgeDocument } from "./knowledgeDocumentsApi";
import { KnowledgeVersions } from "./KnowledgeVersions";
import { ComponentKnowledgeWorkspace } from "./ComponentKnowledgeWorkspace";
import { ComponentKnowledgeDelete } from "./ComponentKnowledgeDelete";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ComponentGovernanceSnapshot } from "../../src/componentKnowledgeTypes";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { KnowledgeReviewNotes } from "./KnowledgeReviewNotes";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { blankKnowledgeMetadata, KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { cachedKnowledgeModules, knowledgeFilePath, knowledgeModuleNames, loadComponentGovernance, loadKnowledgeModules, rulesForComponent, type ModuleDocument } from "./knowledgeModules";
import { invalidateKnowledgeReads, knowledgeReadGeneration, subscribeKnowledgeReads } from "./knowledgeReadCache";
import { KnowledgeModuleLocation } from "./KnowledgeModuleLocation";
import { KnowledgeModuleScope } from "./KnowledgeModuleScope";
import { resolveKnowledgeReference } from "./knowledgeStructure";
import { startKnowledgeDocumentRead } from "./knowledgeDocumentRetry";
import { SkillPackageEditor } from "./SkillPackageEditor";

export interface KnowledgeModuleReaderProps {
  moduleKey: string;
  selectedDocumentId?: string;
  onBack: () => void;
  onResearch: (jobId: string, documentId?: string) => void;
  onAsk?: (moduleKey: string, documentId?: string) => void;
}
interface SkillFile { path: string; content?: string; bytes?: number }
interface SkillPackage { content: string; digest: string; package_digest: string; files: SkillFile[] }
interface TreeFile { key: string; path: string[]; document: ModuleDocument; skillPath?: string }

function FileTree({ files, selected, onSelect }: { files: TreeFile[]; selected: string; onSelect: (file: TreeFile) => void }) {
  const folders = [...new Set(files.filter(f => f.path.length > 1).map(f => f.path[0]))].sort();
  return <div className="grid gap-0.5">{folders.map(folder => <TreeFolder key={folder} name={folder} files={files.filter(f => f.path[0] === folder).map(f => ({ ...f, path: f.path.slice(1) }))} selected={selected} onSelect={onSelect} />)}
    {files.filter(f => f.path.length === 1).map(file => <Button key={file.key} variant="ghost" aria-current={file.key === selected ? "page" : undefined} className={`km-tree-row h-auto min-h-8 justify-start gap-2 whitespace-normal px-2 py-1.5 text-left ${file.key === selected ? "bg-primary/10 text-primary" : ""}`} title={file.skillPath || knowledgeFilePath(file.document)} onClick={() => onSelect(file)}>
      {!file.skillPath && ["example", "experience"].includes(file.document.form || "") ? <Lightbulb size={15} /> : <FileText size={15} />}<span className="flex-1 text-sm font-normal">{file.path[0]}</span>{!file.skillPath && ["example", "experience"].includes(file.document.form || "") && <small className="text-xs text-muted-foreground">经验</small>}
    </Button>)}
  </div>;
}
function TreeFolder({ name, files, selected, onSelect }: { name: string; files: TreeFile[]; selected: string; onSelect: (file: TreeFile) => void }) {
  while (files.length && files.every(f=>f.path.length>1) && new Set(files.map(f=>f.path[0])).size===1) { name += `/${files[0].path[0]}`; files=files.map(f=>({...f,path:f.path.slice(1)})); }
  const contains = files.some(f => f.key === selected), [open, setOpen] = useState(contains);
  useEffect(() => { setOpen(contains); }, [selected, contains]);
  return <div><Button variant="ghost" className="km-tree-row h-auto min-h-8 justify-start gap-1.5 whitespace-normal px-2 text-left" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Folder size={15} className="text-muted-foreground" /><span className="text-sm font-normal">{name}</span></Button>{open && <div className="ml-3 border-l border-line pl-2"><FileTree files={files} selected={selected} onSelect={onSelect} /></div>}</div>;
}
function readablePath(doc: ModuleDocument): string[] {
  // 仅收起显示路径里的常见技术前缀；来源与真实路径仍完整保留。
  const path = knowledgeFilePath(doc).split("/").filter(Boolean);
  while (path.length > 1 && ["docs", "knowledge", ".knowledge", "domains"].includes(path[0])) path.shift();
  return path.length ? path : [doc.title];
}

export function KnowledgeModuleReader({ moduleKey, selectedDocumentId, onBack, onResearch, onAsk }: KnowledgeModuleReaderProps) {
  const { stacks } = useTechnologyStacks();
  const [updating, setUpdating] = useState(false), [updateMessage, setUpdateMessage] = useState(""), [updateBusy, setUpdateBusy] = useState(false), [updateError, setUpdateError] = useState("");
  const [skillEditor, setSkillEditor] = useState<{ directory: string; mode: "edit" | "replace"; path: string }>();
  const [skillSaved, setSkillSaved] = useState("");
  const [inspectionMode, setInspectionMode] = useState(false);
  const [inspectionIssue, setInspectionIssue] = useState(""), [inspectionDescription, setInspectionDescription] = useState("");
  const [loaded, setData] = useState(cachedKnowledgeModules), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const data = useMemo(() => knowledgeModuleNames(loaded, stacks), [loaded, stacks]);
  const generation = useSyncExternalStore(subscribeKnowledgeReads, knowledgeReadGeneration, knowledgeReadGeneration);
  function refreshKnowledge() { invalidateKnowledgeReads(); setReload(n => n + 1); }
  const [selected, setSelected] = useState(selectedDocumentId || ""), [skillPath, setSkillPath] = useState("SKILL.md");
  const [detail, setDetail] = useState<KnowledgeDocument>(), [skillFiles, setSkillFiles] = useState<SkillFile[]>(), [detailError, setDetailError] = useState("");
  const [query, setQuery] = useState(""), [showTree, setShowTree] = useState(true), [expandedRepository, setExpandedRepository] = useState("");
  const [expandedSkills, setExpandedSkills] = useState(new Set<string>()), [focus, setFocus] = useState<KnowledgeFocus>();
  const [packages, setPackages] = useState<Record<string, SkillPackage>>({}), [packageErrors, setPackageErrors] = useState<Record<string, string>>({});
  const packageRequests = useRef(new Map<string, Promise<SkillPackage>>());
  const selectedModule = useRef<string | undefined>(undefined);
  const selectedRequest = useRef<string | undefined>(undefined);
  const displayedDocument = useRef<string | undefined>(undefined);
  const article = useRef<HTMLDivElement>(null);
  const searchableContent = useRef<HTMLDivElement>(null);
  const [notesToolbar, setNotesToolbar] = useState<HTMLSpanElement | null>(null);
  const [governance, setGovernance] = useState<ComponentGovernanceSnapshot>(), [governanceError, setGovernanceError] = useState(""), [governanceReload, setGovernanceReload] = useState(0);
  const [componentTab, setComponentTab] = useState<"usage" | "rules">("usage");
  const [deleting, setDeleting] = useState(false), [deleteDocumentId, setDeleteDocumentId] = useState<string>();
  const requestedModule = data?.modules.find(m => m.key === moduleKey);
  const module = requestedModule ?? (selectedDocumentId ? data?.modules.find(m => m.documents.some(d => d.id === selectedDocumentId)) : undefined);
  const current = module?.documents.find(d => d.id === selected);
  const gitKnowledge = current?.id.startsWith("kg-") === true;
  const canInspect = module?.category === "business";
  const inspectionDocuments = canInspect ? module.documents.filter(document => document.active && document.id.startsWith("kg-")
    && document.source && document.form !== "skill" && !/(?:^|\/)AGENTS\.md$/i.test(knowledgeFilePath(document))) : [];
  const inspectionDocument = inspectionDocuments.find(document => document.id === current?.id) ?? inspectionDocuments[0];
  function openUpdate() { setInspectionMode(false); setUpdating(true); setUpdateError(""); }
  function readPackage(doc: ModuleDocument) {
    const key = `${generation}:${doc.skillDirectory}:${doc.revision}`;
    let request = packageRequests.current.get(key);
    if (!request) {
      request = componentRequest<SkillPackage>(`/skills/${encodeURIComponent(doc.skillDirectory!)}/package`).then(value => {
        if (generation === knowledgeReadGeneration()) {
          setPackages(old => ({ ...old, [doc.id]: value }));
          setPackageErrors(old => ({ ...old, [doc.id]: "" }));
        }
        return value;
      }).catch(error => { packageRequests.current.delete(key); setPackageErrors(old => ({ ...old, [doc.id]: (error as Error).message })); throw error; });
      packageRequests.current.set(key, request);
      if (packageRequests.current.size > 24) packageRequests.current.delete(packageRequests.current.keys().next().value!);
    }
    return request;
  }
  useEffect(() => { let live = true; setError(""); void loadKnowledgeModules().then(value => { if (live) setData(value); }).catch(e => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [moduleKey, generation]);
  useEffect(() => {
    if (!module) return;
    const changedModule = selectedModule.current !== moduleKey;
    const requested = changedModule || selectedRequest.current !== selectedDocumentId ? selectedDocumentId : undefined;
    const id = requested && module.documents.some(d => d.id === requested) ? requested : module.documents.some(d => d.id === selected) ? selected : module.documents.find(d => d.form !== "skill" && !/(?:^|\/)AGENTS\.md$/i.test(knowledgeFilePath(d)) && !module.repositories.some(r => r.documents.some(item => item.id === d.id)))?.id || module.documents[0]?.id || "";
    selectedModule.current = moduleKey;
    selectedRequest.current = selectedDocumentId;
    if (!changedModule && selected === id) return;
    setSelected(id); setSkillPath("SKILL.md");
    setExpandedRepository(module.repositories.find(r => r.documents.some(d => d.id === id))?.id || "");
    setExpandedSkills(new Set(module.documents.find(d => d.id === id)?.form === "skill" ? [id] : []));
  }, [moduleKey, data, selectedDocumentId]);
  useEffect(() => {
    const switched = displayedDocument.current !== current?.id;
    displayedDocument.current = current?.id;
    // 同一文稿后台更新时保留正文及滚动；只有用户换文稿才清空并回到顶部。
    if (switched) { setDetail(undefined); setSkillFiles(undefined); article.current?.scrollTo({ top: 0 }); }
    setDetailError("");
    if (!current) return;
    const doc = current;
    return startKnowledgeDocumentRead<{ detail: KnowledgeDocument; files?: SkillFile[] }>({
      visibility: document,
      read: async () => {
        if (doc.skillDirectory) {
          const result = await readPackage(doc);
          return { detail: { ...doc, content: result.content, revision: result.digest }, files: result.files };
        }
        return { detail: await readKnowledgeDocument(doc.id, doc.revision, false, doc.source?.revision) };
      },
      receive: result => { setDetail(result.detail); setSkillFiles(result.files); setDetailError(""); },
      failed: error => setDetailError((error as Error).message),
    });
  }, [current?.id, current?.revision, current?.source?.revision, current?.source?.path, reload]);
  const engineering = module?.category === "engineering";
  useEffect(() => {
    // 规则数与规则页签是旁路：读取失败只在组件处提示，不挡正文阅读。
    let live = true; setGovernanceError("");
    if (engineering) void loadComponentGovernance().then(value => { if (live) setGovernance(value); }).catch(e => { if (live) { setGovernance(undefined); setGovernanceError((e as Error).message); } });
    return () => { live = false; };
  }, [engineering, reload, governanceReload]);
  const currentComponent = engineering && current && current.form !== "skill"
    ? { id: current.id, name: current.title, documents: [current] } : undefined;
  const componentRules = governance && currentComponent ? rulesForComponent(governance, currentComponent) : [];
  useEffect(() => { setComponentTab("usage"); }, [currentComponent?.id]);
  const needle = query.trim().toLocaleLowerCase(), visible = useMemo(() => (module?.documents ?? []).filter(d => !needle || `${d.title} ${knowledgeFilePath(d)}`.toLocaleLowerCase().includes(needle)), [module, needle]);
  const visibleIds = new Set(visible.map(d => d.id)), currentKey = current?.form === "skill" ? `${selected}:${skillPath}` : selected;
  function choose(doc: ModuleDocument, path = "SKILL.md") {
    setSelected(doc.id); setSkillPath(path); setFocus(undefined);
    setExpandedRepository(module?.repositories.find(r => r.documents.some(d => d.id === doc.id))?.id || "");
    if (doc.form === "skill") setExpandedSkills(old => new Set([...old, doc.id]));
    article.current?.scrollTo({ top: 0 });
  }
  const chooseFile = (file: TreeFile) => choose(file.document, file.skillPath);
  function files(documents: ModuleDocument[]): TreeFile[] { return documents.filter(d => visibleIds.has(d.id)).map(d => ({ key: d.id, document: d, path: readablePath(d) })); }
  function skillList() {
    return <section aria-label="Skill"><h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">Skill<span>{module?.documents.filter(d => d.form === "skill").length || 0}</span></h3>
      {visible.filter(d => d.form === "skill").map(doc => {
        const open = expandedSkills.has(doc.id), packageFiles = packages[doc.id]?.files?.length ? packages[doc.id].files : [{ path: "SKILL.md" }];
        return <div key={doc.id} className="mb-1"><div className={`flex min-w-0 items-center rounded-lg ${selected === doc.id ? "bg-primary/10" : ""}`}>
          <Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"} ${doc.title} Skill 包`} aria-expanded={open} onClick={() => { setExpandedSkills(old => { const next = new Set(old); open ? next.delete(doc.id) : next.add(doc.id); return next; }); if (!open && doc.skillDirectory) void readPackage(doc).catch(() => {}); }}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</Button>
          <Button variant="ghost" className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-2 whitespace-normal px-1 py-2 text-left" aria-current={selected === doc.id ? "page" : undefined} onClick={() => choose(doc)}><Puzzle size={17} className="text-primary" /><span className="min-w-0 flex-1 break-words text-sm">{doc.title}</span><Badge variant="secondary" className="shrink-0 text-xs">Skill</Badge></Button>
        </div>{open && <div className="ml-4 border-l border-line pl-2"><FileTree files={packageFiles.map(f => ({ key: `${doc.id}:${f.path}`, path: f.path.split("/"), skillPath: f.path, document: doc }))} selected={currentKey} onSelect={chooseFile} />{packageErrors[doc.id] && <p className="px-2 py-1 text-xs text-danger">包目录读取失败，可收起后重试。</p>}</div>}</div>;
      })}
      {!visible.some(d => d.form === "skill") && <p className="px-2 py-2 text-xs text-muted-foreground">暂无 Skill</p>}
    </section>;
  }
  function componentList() {
    const documents = visible.filter(doc => doc.form !== "skill").sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    return <section aria-label="基础组件"><h3 className="mb-2 text-xs font-medium text-muted-foreground">基础组件</h3>
      {documents.map(doc => <Button key={doc.id} variant="ghost" aria-current={selected === doc.id ? "page" : undefined} className={`km-tree-row h-auto min-h-9 justify-start gap-2 whitespace-normal px-2 py-2 text-left ${selected === doc.id ? "bg-primary/10 text-primary" : ""}`} onClick={() => choose(doc)}>
        <Puzzle size={16} className="shrink-0" /><span className="min-w-0 flex-1 break-words text-sm">{doc.title}</span>
        {governance && <small className="shrink-0 text-xs text-muted-foreground">{rulesForComponent(governance, { id: doc.id, name: doc.title, documents: [doc] }).length} 规则</small>}
      </Button>)}
      {!documents.length && <p className="px-2 py-2 text-xs text-muted-foreground">{needle ? "没有匹配的组件" : "暂无组件知识"}</p>}
      {governanceError && <p className="px-2 py-1 text-xs text-muted-foreground">规则读取失败，组件文档仍可阅读。</p>}
    </section>;
  }
  function repositoryList() {
    return <section aria-label="仓内知识"><h3 className="mb-2 text-xs font-medium text-muted-foreground">仓内知识</h3>
      {module?.repositories.filter(r => !needle || r.documents.some(d => visibleIds.has(d.id))).map(repository => {
        const open = !!needle || expandedRepository === repository.id;
        return <div key={repository.id} className="mb-1"><Button variant="ghost" className="km-tree-row h-auto min-h-9 justify-start gap-2 whitespace-normal px-2 text-left" aria-expanded={open} onClick={() => setExpandedRepository(open ? "" : repository.id)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<GitBranch size={15} className="text-muted-foreground" /><span className="flex-1 text-sm">{repository.name}</span><small className="text-xs text-muted-foreground">{repository.documents.length}</small></Button>{open && <div className="ml-3 border-l border-line pl-2">{repository.documents.length ? <FileTree files={files(repository.documents)} selected={currentKey} onSelect={chooseFile} /> : <p className="px-2 py-2 text-xs text-muted-foreground">暂无知识</p>}</div>}</div>;
      })}
      {!module?.repositories.length && <p className="px-2 py-2 text-xs text-muted-foreground">暂无关联项</p>}
    </section>;
  }
  const rootDocuments = visible.filter(d => d.form !== "skill" && !module?.repositories.some(r => r.documents.some(item => item.id === d.id)));
  const file = skillPath === "SKILL.md" ? detail?.content : skillFiles?.find(f => f.path === skillPath)?.content;
  const body = current?.form === "skill" ? file : detail?.content;
  const packageAnnotations = current?.form === "skill" && !!current.skillDirectory;
  const shownBody = useMemo(() => body === undefined ? undefined : blankKnowledgeMetadata(body), [body]);
  const usage = !currentComponent || componentTab === "usage";
  const markdownBody = useMemo(() => current && body !== undefined && <KnowledgeMarkdown hideMetadata text={body} focus={focus} resolveImage={gitKnowledge ? href => knowledgeDocumentResourceUrl(detail ?? current, href) : undefined} onReference={href => {
    if (current.form === "skill") { const [path, anchor] = href.split("#"), parts = skillPath.split("/").slice(0, -1); for (const segment of path.split("/")) { if (segment === "..") parts.pop(); else if (segment && segment !== ".") parts.push(segment); } const target = parts.join("/"); if (skillFiles?.some(file => file.path === target)) { setSkillPath(target); setFocus({ anchor, token: Date.now() }); return true; } }
    if (current.source) {
      const candidates = (module?.documents ?? []).filter(doc => doc.source?.repository === current.source!.repository && doc.source.branch === current.source!.branch).map(doc => ({ ...doc, path: knowledgeFilePath(doc), target_id: current.source!.repository }));
      const source = candidates.find(doc => doc.id === current.id);
      const target = source && resolveKnowledgeReference(candidates, source, href);
      if (target) { choose(target.item); setFocus({ anchor: target.anchor, token: Date.now() }); return true; }
    }
    return false;
  }} />, [current, body, focus, gitKnowledge, skillPath, skillFiles, module, detail?.revision, detail?.source?.revision]);
  return <section className="tw-root km-reader rounded-lg border border-line bg-surface" aria-label={`${module?.name || "模块"}知识阅读器`}>
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-4 py-3">
      <div className="knowledge-page-title"><KnowledgeBackButton onClick={onBack} /><h2 className="truncate text-base font-semibold">{module?.name || "知识目录"}</h2></div>
      <div className="flex shrink-0 items-center gap-2">{onAsk && <Button variant="outline" size="sm" onClick={() => onAsk(moduleKey, current?.form === "skill" ? undefined : current?.id)}><MessageSquare size={15} />提问</Button>}<Button variant="ghost" size="sm" aria-expanded={showTree} onClick={() => setShowTree(v => !v)}>{showTree ? <PanelLeftClose /> : <PanelLeftOpen />}{showTree ? "收起目录" : "展开目录"}</Button>
        {canInspect && <Button size="sm" variant="outline" disabled={!inspectionDocument} onClick={() => { setInspectionMode(true); setUpdating(true); setUpdateError(""); }} title="检视本模块的正式正文，自动排除 AGENTS.md"><ClipboardCheck size={15} />{inspectionDocument ? "开始检视" : "暂无可检视正文"}</Button>}
        {current?.skillDirectory && <><Button variant="outline" size="sm" onClick={() => { setSkillSaved(""); setSkillEditor({ directory: current.skillDirectory!, mode: "edit", path: skillPath }); }}>编辑</Button><Button variant="outline" size="sm" onClick={() => { setSkillSaved(""); setSkillEditor({ directory: current.skillDirectory!, mode: "replace", path: skillPath }); }}>替换</Button></>}
        {!current?.skillDirectory && (!canInspect || !gitKnowledge) && current?.research_source && <Button variant="outline" size="sm" onClick={openUpdate}><RefreshCw />更新知识</Button>}
        <KnowledgeContentSearch contentRef={searchableContent} contentKey={`${currentKey}:${detail?.revision || ""}`} disabled={body === undefined || !usage} /><span ref={setNotesToolbar} className="flex items-center" />
        {engineering && <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="管理组件知识" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root"><DropdownMenuItem onClick={() => { setDeleteDocumentId(current?.form !== "skill" ? current?.id : undefined); setDeleting(true); }}><Trash2 size={16} />删除组件知识</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
        {module?.category === "business" && <KnowledgeModuleScope key={module.id} moduleId={module.id} moduleName={module.name} />}
      </div>
    </header>
    {skillSaved && <p role="status" className="border-b border-line px-4 py-2 text-sm text-muted-foreground">{skillSaved}</p>}
    {module?.category === "business" && <KnowledgeModuleLocation key={module.id} moduleId={module.id} onSynced={refreshKnowledge} />}
    {error && <div role="alert" className="flex items-center gap-3 p-4 text-sm text-danger">{error}<Button variant="outline" onClick={refreshKnowledge}>重试</Button></div>}
    <ResizableKnowledgePanes className="km-reader-panes" treeHidden={!showTree}>
      {showTree && <aside className="km-tree grid content-start gap-5 border-r border-line bg-muted/30 p-3" aria-label="模块知识目录"><Input aria-label={engineering ? "搜索组件或 Skill" : "搜索模块内文件"} placeholder={engineering ? "查找组件或 Skill…" : "查找文件…"} value={query} onChange={e => setQuery(e.target.value)} />
        {module?.category === "engineering" ? <>{componentList()}{skillList()}</> : <><section aria-label={module?.category === "business" ? "领域模块知识" : "文档"}><h3 className="mb-2 text-xs font-medium text-muted-foreground">{module?.category === "business" ? "领域模块知识" : "文档"}</h3>{rootDocuments.length ? <FileTree files={files(rootDocuments)} selected={currentKey} onSelect={chooseFile} /> : <p className="px-2 py-2 text-xs text-muted-foreground">暂无文档</p>}</section>{module?.category === "business" && repositoryList()}{skillList()}</>}
      </aside>}
      <div ref={article} className="km-document px-6 pt-3 pb-6" aria-label="知识正文" tabIndex={0}>
        {!data && !error ? <p role="status" className="py-12 text-center text-muted-foreground">正在读取知识目录…</p> : !module ? <p className="py-12 text-center text-muted-foreground">该目录不存在，或当前没有可读取的归属信息。</p> : !current ? <div className="grid justify-items-center gap-3 py-16 text-muted-foreground"><BookOpen size={28} /><p>这个目录还没有知识</p></div> : <div className="km-document-body">
          {currentComponent && <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-2">
            <Tabs value={componentTab} onValueChange={value => setComponentTab(value as typeof componentTab)}><TabsList variant="line" aria-label={`${currentComponent.name}知识`}>
              <TabsTrigger value="usage" className="px-3 after:absolute after:inset-x-2 after:-bottom-3 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 data-active:after:opacity-100">用法</TabsTrigger>
              <TabsTrigger value="rules" className="px-3 after:absolute after:inset-x-2 after:-bottom-3 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 data-active:after:opacity-100">规则{governance && <span className="tabular-nums text-muted-foreground">{componentRules.length}</span>}</TabsTrigger>
            </TabsList></Tabs>
            <span className="text-xs text-muted-foreground">基础组件 · {currentComponent.name}</span>
          </div>}
          {!usage ? (governanceError ? <div role="alert" className="grid justify-items-start gap-3 text-sm text-danger"><p>组件规则读取失败：{governanceError}</p><Button variant="outline" onClick={() => setGovernanceReload(n => n + 1)}>重试</Button></div>
            : <ComponentKnowledgeWorkspace open variant="rules" component={{ id: currentComponent!.id, documentIds: currentComponent!.documents.map(d => d.id) }} onClose={() => setComponentTab("usage")} onAdopt={id => { const doc = module?.documents.find(d => d.id === id); if (doc) { choose(doc); setComponentTab("usage"); } }} onChanged={() => setGovernanceReload(n => n + 1)} />) : <>
          {(() => {
            // 未归档的文档"路径"就是标题，组件知识的适用说明又是"语言 / 主题"：两行都在重复正文标题，挤占阅读面积（2026-10-08 用户）。
            const path = current.form === "skill" ? `${current.skillDirectory || current.title}/${skillPath}` : knowledgeFilePath(current);
            const facts = [path !== current.title ? path : "", current.when_to_use && !current.title.includes(current.when_to_use.split(" / ").at(-1) ?? "") ? current.when_to_use : ""].filter(Boolean);
            const title = !shownBody?.trimStart().startsWith(`# ${current.title}\n`);
            if (!facts.length && current.active && !title) return null;
            return <header className="mb-3 border-b border-line pb-2">{(facts.length || !current.active) && <div className="flex items-center gap-2 text-xs text-muted-foreground">{current.form === "skill" ? <Puzzle size={14} /> : <FileText size={14} />}<span className="break-all">{facts.join(" · ")}</span>{!current.active && <Badge variant="secondary">{current.technology_assignment_required ? "待补技术栈关联" : "已停用"}</Badge>}</div>}{title && <h2 className="mt-1 text-xl font-semibold leading-snug">{current.title}</h2>}</header>;
          })()}
          <div ref={searchableContent}>{detailError ? <div role="alert" className="grid justify-items-start gap-3 text-sm text-danger"><p>正文读取失败：{detailError}</p><Button variant="outline" onClick={refreshKnowledge}>重试读取</Button></div> : !detail ? <p role="status" className="text-muted-foreground">正在读取正文…</p> : body === undefined ? <p className="text-sm text-muted-foreground">此文件暂不支持在线预览。</p> : current.form === "skill" && !/\.md$/i.test(skillPath) ? <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-sm">{body}</pre> : gitKnowledge ? markdownBody : <KnowledgeReviewNotes key={`${current.id}:${current.form === "skill" ? skillPath : "document"}`} kind={packageAnnotations ? "skill" : "published"} jobId={packageAnnotations ? current.skillDirectory! : detail.id} documentId={packageAnnotations ? skillPath : detail.id} toolbarTarget={notesToolbar} onEdit={detail.research_source ? (message) => { setUpdateMessage(message); openUpdate(); } : undefined}>{markdownBody}</KnowledgeReviewNotes>}</div>
          {current.form === "skill" && detail && !skillFiles && <p className="mt-6 text-xs text-muted-foreground">已读取 SKILL.md；当前接口未提供包内附件清单。</p>}
          {detail && !current.external && !gitKnowledge && <KnowledgeVersions key={`${detail.id}:${detail.revision}`} document={detail} onRestored={refreshKnowledge} />}
          {detail && <details className="mt-8 border-t border-line pt-3 text-sm"><summary className="text-muted-foreground">版本与来源</summary><div className="mt-3 grid gap-2 text-sm text-muted-foreground"><p className="break-all">版本：{detail.revision || "未记录"}</p>{current.maintainedAt && <p>最近维护：{new Date(current.maintainedAt).toLocaleString("zh-CN")}</p>}{detail.source && <p className="break-all">{detail.source.repository} · {detail.source.branch} · {detail.source.path}</p>}{detail.research_source && <Button variant="link" className="justify-start px-0" onClick={() => onResearch(detail.research_source!.job_id, detail.id)}>查看研究与归档记录</Button>}{detail.history?.map((entry, index) => <p key={`${entry.at}:${index}`}>{new Date(entry.at).toLocaleString("zh-CN")} · {entry.operator} · {entry.action}</p>)}</div></details>}
          </>}
        </div>}
      </div>
    </ResizableKnowledgePanes>
    {skillEditor && <SkillPackageEditor key={`${skillEditor.directory}:${skillEditor.mode}`} directory={skillEditor.directory} mode={skillEditor.mode} initialPath={skillEditor.path}
      onClose={() => setSkillEditor(undefined)} onSaved={() => { setSkillSaved(`Skill ${skillEditor.directory} 已更新，旧版已保留。`); if (skillEditor.mode === "replace") setSkillPath("SKILL.md"); setSkillEditor(undefined); refreshKnowledge(); }} />}
    <Dialog open={updating} onOpenChange={next => { if (!updateBusy) setUpdating(next); }}><DialogContent className="tw-root max-w-xl"><DialogHeader><DialogTitle>{inspectionMode ? "开始检视正式知识" : "基于正式版本更新"}</DialogTitle></DialogHeader>
      <p className="text-sm leading-relaxed text-muted-foreground">{inspectionMode ? "创建独立检视任务，冻结本模块当前筛选范围内的正式正文并进入全屏，自动排除 AGENTS.md。可连续提出行、整篇和整体意见，结束检视后才由 Agent 修改；MR 合入前知识库保持原内容。" : `${detail?.title} · 当前版本 ${detail?.revision.slice(0, 10)}。创建更新任务后修改文稿，再提交 MR。`}</p>
      {inspectionMode ? <><label className="grid gap-2 text-sm">关联单号（必填）<Input aria-label="检视关联单号" maxLength={120} value={inspectionIssue} onChange={event => setInspectionIssue(event.target.value)} placeholder="本次修订 MR 关联的需求或问题单号" /></label><label className="grid gap-2 text-sm">单号描述（必填）<Input aria-label="检视单号描述" maxLength={2000} value={inspectionDescription} onChange={event => setInspectionDescription(event.target.value)} placeholder="将原样用于 MR 标题" /></label></> : detail?.research_source?.job_id.startsWith("dkx-") ? <Textarea aria-label="本次更新要求" rows={3} value={updateMessage} onChange={e => setUpdateMessage(e.target.value)} placeholder="需要关注哪些变化？留空则核对来源并生成增量建议。" /> : <p className="text-sm text-muted-foreground">创建后按能力核对来源、修改文稿，再提交 MR。</p>}
      {updateError && <p role="alert" className="text-danger text-sm">{updateError}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={updateBusy} onClick={() => setUpdating(false)}>取消</Button><Button disabled={updateBusy || (inspectionMode ? !inspectionDocument || !inspectionIssue.trim() || !inspectionDescription.trim() : !detail)} onClick={async () => {
        if (inspectionMode ? !inspectionDocument : !detail) return; setUpdateBusy(true); setUpdateError("");
        try {
          if (inspectionMode && inspectionDocument) {
            const result = await documentRequest<{ id: string; inspection_source?: { document_id: string } }>(`/${encodeURIComponent(inspectionDocument.id)}/inspection`, { expected_revision: inspectionDocument.revision, module_id: module?.id, issue_no: inspectionIssue.trim(), issue_description: inspectionDescription.trim() });
            setUpdating(false); onResearch(result.id, result.inspection_source?.document_id ?? inspectionDocument.id);
          } else if (detail?.research_source) {
            const source = detail.research_source.job_id;
            const result = source.startsWith("dkx-") ? await documentRequest<{ id: string }>(`/${detail.id}/update-research`, { expected_revision: detail.revision, message: updateMessage || undefined }) : await componentRequest<{ id: string }>(`/component-research/${source}/begin-update`, {});
            setUpdating(false); onResearch(result.id, detail.id);
          }
        } catch (e) { setUpdateError((e as Error).message); } finally { setUpdateBusy(false); }
      }}>{updateBusy ? "正在创建…" : inspectionMode ? "创建任务并开始检视" : "创建更新任务"}</Button></div>
    </DialogContent></Dialog>
    <ComponentKnowledgeDelete open={deleting} initialDocumentId={deleteDocumentId} onClose={() => setDeleting(false)} onChanged={() => { refreshKnowledge(); setGovernanceReload(n => n + 1); }} />
  </section>;
}
