import { useEffect, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal, Plus, Trash2, Upload, Sparkles } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { KnowledgeModuleHome } from "./KnowledgeModuleHome";
import { KnowledgeModuleReader } from "./KnowledgeModuleReader";
import { openKnowledgeAnswer } from "./KnowledgeAnswerPage";
import { ComponentKnowledgeDelete } from "./ComponentKnowledgeDelete";
import { KnowledgeTaskCenter, KnowledgeTaskCapsule, KnowledgeExperienceCapsule } from "./KnowledgeTaskCenter";
import { KnowledgeResearchCreate, type KnowledgeResearchDraft } from "./KnowledgeResearchCreate";
import { KnowledgeSkillImport } from "./KnowledgeSkillImport";
import { KnowledgeSkillTask } from "./KnowledgeSkillTask";
import { DomainKnowledgeExtraction } from "./DomainKnowledgeExtraction";
import type { KnowledgeCleanupDraft } from "./KnowledgeSourceCleanup";
import { ComponentResearch } from "./ComponentResearch";
import { PlatformSkillPane, type PlatformSkillKind } from "./PlatformSkill";
import { KnowledgeStudioContext, type ExtractionKind } from "./KnowledgeStudioContext";
import { MemoryBoard } from "./MemoryBoard";
import { getMemoryInsights } from "./api";
import { memoryCounts } from "./memoryPresentation";
import type { KnowledgeProductionAction } from "../../src/knowledgeProductionTypes";
import type { KnowledgeTaskCenterData } from "../../src/knowledgeTaskCenterTypes";
import { invalidateKnowledgeReads } from "./knowledgeReadCache";
import { observeKnowledgeRevision } from "./knowledgeRevision";

type Page = "home" | "module" | "tasks" | "research" | "import" | "task" | "experience";
type Kind = ExtractionKind | "skill-extraction" | "skill-submission";
function readRoute() {
  const q = new URLSearchParams(location.search), page = q.get("kbPage");
  const valid = ["home", "module", "tasks", "research", "import", "task", "experience"].includes(page ?? "");
  const kind = q.get("kbKind") as Kind | null;
  return { page: (valid ? page : "home") as Page,
    module: q.get("kbModule") ?? "", document: q.get("knowledgeDocument") ?? "",
    kind: kind ?? "domain", id: q.get("kbTask") ?? "", review: q.get("kbReview") === "1" };
}
export function KnowledgeLibrary({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const [route, setRoute] = useState(readRoute);
  const [deletingComponents, setDeletingComponents] = useState(false), [catalogVersion, setCatalogVersion] = useState(0);
  const [researchDraft, setResearchDraft] = useState<KnowledgeResearchDraft>();
  const [cleanupDrafts, setCleanupDrafts] = useState<Record<string, KnowledgeCleanupDraft>>({});
  const [summary, setSummary] = useState<KnowledgeTaskCenterData["summary"] | null>(null);
  const previousPage = useRef(route.page);
  useEffect(() => {
    if (["task", "import", "experience"].includes(previousPage.current) && ["home", "module", "research"].includes(route.page)) invalidateKnowledgeReads();
    previousPage.current = route.page;
  }, [route.page]);
  // 离开知识库后可能修改配置或切换账号，下一次进入重新读取。
  useEffect(() => () => invalidateKnowledgeReads(), []);
  useEffect(() => { const sync = () => setRoute(readRoute()); addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, []);
  // 目录只读取任务数量；等待上一轮结束再调度，后台标签不重复扫描。
  const onTasksPage = route.page === "tasks";
  const onTaskPage = route.page === "task";
  useEffect(() => {
    if (onTasksPage || onTaskPage) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        if (document.visibilityState === "hidden") return;
        const r = await fetch("/knowledge-tasks?summary=1", { signal: controller.signal });
        if (!r.ok) return;
        const data: Pick<KnowledgeTaskCenterData, "summary"> = await r.json();
        if (live && data.summary) setSummary(current => current?.running === data.summary.running
          && current.attention === data.summary.attention && current.total === data.summary.total ? current : data.summary);
      } catch { /* 任务中心提供重试及错误信息。 */ }
      finally { if (live) timer = setTimeout(refresh, 30_000); }
    };
    void refresh(); return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [onTasksPage, onTaskPage]);
  // 经验变化慢，不轮询：进出页面时各读一次，从经验页审完回来就是新数。读失败卡片只显示入口说明（旁路 fail-open）。
  const [experience, setExperience] = useState<{ pending: number; accepted: number } | null>(null);
  useEffect(() => {
    if (onTaskPage || onTasksPage) return;
    let live = true;
    getMemoryInsights().then(value => { if (live) setExperience(memoryCounts(value.memories)); }).catch(() => { if (live) setExperience(null); });
    return () => { live = false; };
  }, [route.page === "experience", onTaskPage, onTasksPage]);
  function navigate(page: Page, values: Record<string, string> = {}) {
    const url = new URL(location.href);
    for (const key of ["kbPage", "kbModule", "kbKind", "kbTask", "kbAsk", "kbReview", "kbStage", "kbInspection", "knowledgeDocument", "domainExtraction", "componentResearch", "knowledgeView", "knowledgePage", "platformSkill", "source_task", "memory_id"]) url.searchParams.delete(key);
    url.searchParams.set("kbPage", page);
    for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
    history.pushState({ ...history.state, knowledgeResearchReturn: undefined }, "", url); setRoute(readRoute());
  }
  function openTask(kind: Kind, id: string, review = false, action?: KnowledgeProductionAction) {
    if (id === "new" || !id) { navigate("research", { kbKind: kind }); return; }
    if (id === "history") { navigate("tasks"); return; }
    if (action?.href) {
      history.pushState(history.state, "", new URL(action.href, location.href)); setRoute(readRoute()); return;
    }
    navigate("task", { kbKind: kind, kbTask: id, kbReview: review ? "1" : "",
      kbStage: action?.view === "archive" ? "publish" : "",
      knowledgeDocument: action?.document_id ?? "" });
  }
  // 全屏态的样式让容器里每个子元素各占满一行宽：只容得下一个工作区。经验页、平台 Skill 页是
  // "返回按钮 + 内容"两段，进全屏会把内容挤成几十像素（2026-10-08 真服务实测），所以留在页内。
  const platformSkill = route.page === "module" && route.module === "platform" && ["platform-skill-domain", "platform-skill-component", "platform-skill-component-analysis"].includes(route.document);
  const readingKnowledge = route.page === "home" || route.page === "module" && !platformSkill;
  useEffect(() => readingKnowledge ? observeKnowledgeRevision() : undefined, [readingKnowledge]);
  const returnSearch = platformSkill && typeof history.state?.knowledgeResearchReturn === "string" && new URLSearchParams(history.state.knowledgeResearchReturn).get("kbPage") === "research" ? history.state.knowledgeResearchReturn as string : undefined;
  function returnToResearch() {
    const url = new URL(location.href); url.search = returnSearch!;
    history.pushState({ ...history.state, knowledgeResearchReturn: undefined }, "", url); setRoute(readRoute());
  }
  const focused = route.page === "task" || (route.page === "module" && !platformSkill);
  return <KnowledgeStudioContext.Provider value={{ view: route.review ? "knowledge" : "workbench", openExecution: (kind, id) => returnSearch && !id ? returnToResearch() : openTask(kind, id ?? "new"), openResult: (kind, id) => openTask(kind, id, true) }}>
    <section className={`knowledge-hub ${focused ? "is-focused" : ""}`} aria-label="知识库">
      <header className="knowledge-hub-header">
        <div className="knowledge-page-title"><button type="button" className="knowledge-hub-brand" onClick={() => navigate("home")}><strong>知识库</strong></button></div>
        <div className="knowledge-hub-actions">
          <KnowledgeExperienceCapsule counts={experience} active={route.page === "experience"} onClick={() => navigate("experience")} />
          <KnowledgeTaskCapsule summary={onTaskPage ? null : summary} active={route.page === "tasks"} onClick={() => navigate("tasks")} />
          <DropdownMenu><DropdownMenuTrigger render={<Button className="knowledge-hub-add" />}><Plus size={18} />新增<ChevronDown size={14} /></DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={10} className="knowledge-hub-add-menu">
            <DropdownMenuItem className="knowledge-hub-add-option" onClick={() => navigate("research", { kbModule: route.module })}><span className="knowledge-hub-add-icon"><Sparkles size={19} /></span><span><strong>研究知识</strong><small>萃取领域、基础组件，或制作 Skill</small></span></DropdownMenuItem>
            <DropdownMenuItem className="knowledge-hub-add-option" onClick={() => navigate("import", { kbModule: route.module })}><span className="knowledge-hub-add-icon"><Upload size={19} /></span><span><strong>导入 Skill</strong><small>导入完整技能包，归入模块或语言</small></span></DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="管理知识" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root"><DropdownMenuItem onClick={() => setDeletingComponents(true)}><Trash2 size={16} />删除组件知识</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      {route.page === "home" && <KnowledgeModuleHome key={catalogVersion} onOpenModule={key => navigate("module", { kbModule: key })} onOpenDocument={(id, key) => navigate("module", { kbModule: key ?? "unassigned", knowledgeDocument: id })} />}
      {route.page === "module" && (platformSkill
        ? <div className="knowledge-hub-task"><KnowledgeBackButton destination={returnSearch ? "研究知识" : "知识库"} onClick={() => returnSearch ? returnToResearch() : navigate("home")} /><PlatformSkillPane key={route.document} kind={route.document.slice(15) as PlatformSkillKind} /></div>
        : <KnowledgeModuleReader moduleKey={route.module} selectedDocumentId={route.document} onBack={() => navigate("home")} onAsk={(moduleKey, documentId) => openKnowledgeAnswer("", moduleKey, documentId)} onResearch={(id, documentId) => documentId ? openTask(id.startsWith("dkx-") ? "domain" : "component", id, true) : navigate("tasks")} />)}
      {route.page === "tasks" && <KnowledgeTaskCenter onBack={() => navigate("home")} onOpen={(kind, id, action) => openTask(kind, id, action.view !== "progress", action)} onSummaryChange={setSummary} />}
      {route.page === "research" && <KnowledgeResearchCreate moduleKey={route.module} initialKind={route.kind} draft={researchDraft} onDraftChange={setResearchDraft} onBack={() => navigate("home")} onCreated={(kind, id) => { setResearchDraft(undefined); openTask(kind, id); }} onOpenDocument={(id, key) => navigate("module", { kbModule: key, knowledgeDocument: id })} />}
      {route.page === "import" && <KnowledgeSkillImport moduleKey={route.module} onBack={() => navigate("home")} onCreated={id => openTask("skill-submission", id, true)} />}
      {route.page === "experience" && <div className="knowledge-hub-task"><KnowledgeBackButton onClick={() => navigate("home")} /><MemoryBoard onOpenTask={onOpenTask} /></div>}
      {route.page === "task" && <div className="knowledge-hub-task">
        {route.kind === "domain" && <DomainKnowledgeExtraction focused onBack={() => navigate("tasks")} onViewKnowledge={id => navigate("module", { kbModule: "unassigned", knowledgeDocument: id })} key={route.id} focusId={route.id} surface={route.review ? "knowledge" : "workbench"} cleanupDraft={cleanupDrafts[route.id]} onCleanupDraftChange={draft => setCleanupDrafts(current => ({ ...current, [route.id]: draft }))} />}
        {route.kind === "component" && <ComponentResearch key={route.id} open focused focusId={route.id} surface={route.review ? "knowledge" : "workbench"} onClose={() => navigate("tasks")} backLabel="任务中心" onAdopt={id => navigate("module", { kbModule: "unassigned", knowledgeDocument: id })} />}
        {(route.kind === "skill-extraction" || route.kind === "skill-submission") && <KnowledgeSkillTask kind={route.kind} id={route.id} onBack={() => navigate("tasks")} onSubmitted={id => openTask("skill-submission", id, true)} />}
      </div>}
      <ComponentKnowledgeDelete open={deletingComponents} onClose={() => setDeletingComponents(false)} onChanged={() => { invalidateKnowledgeReads(); setCatalogVersion(n => n + 1); }} />
    </section>
  </KnowledgeStudioContext.Provider>;
}
