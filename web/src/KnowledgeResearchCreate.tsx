import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { BookOpen, Boxes, Puzzle } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { knowledgeLocationSettingsUrl } from "./KnowledgeModuleLocation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getBusinessModules, type BusinessModule } from "./api";
import { componentRequest, createComponentResearch, type ComponentRepository } from "./componentResearchApi";
import { KnowledgeMaterialUpload, type MaterialSummary } from "./KnowledgeMaterialUpload";
import { useTechnologyStacks } from "./useTechnologyStacks";
import { KnowledgeDestination, destinationMetadata } from "./KnowledgeDestination";
import { ExtractionSkillEditor } from "./ExtractionSkillEditor";
import { loadKnowledgeModules, knowledgeFileName, type KnowledgeModule } from "./knowledgeModules";

export interface KnowledgeResearchDraft {
  mode: "domain" | "component" | "skill-extraction";
  destination: string; language: string; goal: string; branch: string;
  issue: string; issueDescription: string; repo: string; path: string; materials: MaterialSummary[];
  prepareCleanup?: boolean;
}

export function KnowledgeResearchCreate({ moduleKey = "", initialKind, draft, onDraftChange, onBack, onCreated, onOpenDocument }: { moduleKey?: string; initialKind?: string; draft?: KnowledgeResearchDraft; onDraftChange: Dispatch<SetStateAction<KnowledgeResearchDraft | undefined>>; onBack: () => void; onCreated: (kind: "domain" | "component" | "skill-extraction", id: string) => void; onOpenDocument?: (id: string, moduleKey: string) => void }) {
  const catalog = useTechnologyStacks();
  const languageOptions = catalog.stacks.filter(stack => stack.enabled);
  const initial: KnowledgeResearchDraft = { mode: initialKind === "skill-extraction" ? initialKind : moduleKey.startsWith("engineering:") || initialKind === "component" ? "component" : "domain", destination: moduleKey, language: moduleKey.startsWith("engineering:") ? moduleKey.slice(12) : "", goal: "", branch: "master", issue: "", issueDescription: "", repo: "", path: "", materials: [] };
  // 草稿由知识库保存，查看方法或已有知识不会丢输入；创建成功后由调用方清理。
  const { mode, destination, language, goal, branch, issue, issueDescription, repo, path, materials, prepareCleanup } = draft ?? initial;
  const change = (patch: Partial<KnowledgeResearchDraft>) => onDraftChange(current => ({ ...(current ?? initial), ...patch }));
  const setMode = (mode: KnowledgeResearchDraft["mode"]) => change({ mode });
  const setDestination = (destination: string) => change({ destination }), setLanguage = (language: string) => change({ language });
  const setGoal = (goal: string) => change({ goal }), setBranch = (branch: string) => change({ branch }), setIssue = (issue: string) => change({ issue }), setIssueDescription = (issueDescription: string) => change({ issueDescription });
  const setRepo = (repo: string) => change({ repo }), setPath = (path: string) => change({ path }), setMaterials = (materials: MaterialSummary[]) => change({ materials });
  useEffect(() => { if (catalog.deletedIds.includes(language)) change({ language: "" }); }, [catalog.deletedIds, language]);
  const [modules, setModules] = useState<BusinessModule[]>([]), [components, setComponents] = useState<ComponentRepository[]>([]);
  const [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [library, setLibrary] = useState<KnowledgeModule[]>([]);
  // 已有正式知识提供阅读入口；用户可选择新研究，或从正式内容开始独立检视。
  useEffect(() => { let live = true; void loadKnowledgeModules().then(data => { if (live) setLibrary(data.modules); }).catch(() => {}); return () => { live = false; }; }, []);
  useEffect(() => { let live = true; void Promise.all([getBusinessModules(), componentRequest<{ components: ComponentRepository[] }>("/component-repositories")]).then(([m,c]) => { if (live) { setModules(m.modules); setComponents(c.components); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  const module = modules.find(m => `business:${m.id}` === destination), existing = library.find(m => m.key === destination)?.documents.filter(d => d.active && d.form !== "skill") ?? [], sourceRepositories = components.filter(c => c.enabled && c.languages.includes(language));
  const materialsBlocked = mode === "domain" && materials.some(material => material.state !== "ready");
  async function create() {
    if (busy || uploading || materialsBlocked) return;
    setBusy(true); setError("");
    try {
      const result = mode === "domain" ? await componentRequest<{ id: string }>("/domain-extraction", { module_id: module?.id, baseline_branch: branch, issue_no: issue, issue_description: issueDescription, instructions: goal || undefined, material_ids: materials.map(m => m.id), ...(prepareCleanup ? { prepare_cleanup: true } : {}) })
        : mode === "component" ? await createComponentResearch({ language })
        : await componentRequest<{ id: string }>("/knowledge/skill-extract", { repo, intent: goal, path_hint: path || undefined, ...destinationMetadata(destination) });
      onCreated(mode, result.id);
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const canCreate = mode === "domain" ? !!module && !!module.knowledge_location && !!issue.trim() && !!issueDescription.trim() && (!module.repositories.length || !!branch.trim()) : mode === "component" ? languageOptions.some(stack => stack.id === language) && !!sourceRepositories.length : !!destination && !!repo.trim() && !!goal.trim();
  return <section className="knowledge-create" aria-label="研究知识"><header className="knowledge-create-header"><div className="knowledge-page-title"><KnowledgeBackButton onClick={onBack} /><h2>研究知识</h2></div>{mode === "domain" && <ExtractionSkillEditor kind={mode} />}{mode === "component" && <div className="flex gap-2"><ExtractionSkillEditor kind="component-analysis" label="模块分析方法" /><ExtractionSkillEditor kind="component" label="用法萃取方法" /></div>}</header>
    <div className="knowledge-create-modes" role="group" aria-label="研究方式">{([["domain","业务知识",BookOpen],["component","组件用法",Boxes],["skill-extraction","制作 Skill",Puzzle]] as const).map(([id,label,Icon]) => <button key={id} type="button" aria-pressed={mode===id} onClick={() => {setMode(id);setError("");}}><Icon size={16} />{label}</button>)}</div>
    {error && <p role="alert" className="text-danger mb-4">{error}</p>}
    <form onSubmit={e => { e.preventDefault(); if (canCreate && !busy && !uploading && !materialsBlocked) void create(); }}><div className="knowledge-create-grid"><div className="knowledge-create-fields">
      {mode === "domain" && <><label>业务模块<KnowledgeDestination businessOnly value={destination.startsWith("business:") ? destination : ""} onChange={setDestination} /></label>{module && <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"><strong className="font-medium">领域知识目录</strong>{module.knowledge_location ? <p className="mt-1 break-all text-muted-foreground">{module.knowledge_location.docs_path}/ · {module.knowledge_location.branch}</p> : <p className="mt-1 text-muted-foreground">平台领域知识仓尚未配置，请联系管理员。</p>}<a href={knowledgeLocationSettingsUrl(module.id)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-primary underline">配置中心 · {"查看目录配置"} ↗</a><Button type="button" variant="ghost" size="sm" className="ml-2" onClick={() => void getBusinessModules().then(value => setModules(value.modules)).catch(reason => setError(reason.message))}>刷新配置</Button></div>}<div className="field-pair"><label>统一基准分支<Input value={branch} onChange={e => setBranch(e.target.value)} /></label><label>关联单号<Input required value={issue} onChange={e => setIssue(e.target.value)} placeholder="需求或问题单号" /></label></div><label>单号描述<Input required maxLength={2000} aria-label="单号描述" value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述，请勿额外添加单号或前后缀" /><small className="knowledge-create-hint">将原样用作 MR 标题。</small></label><label><span>研究要求 <small className="knowledge-create-hint">选填</small></span><Textarea value={goal} rows={4} onChange={e => setGoal(e.target.value)} placeholder="希望澄清哪些业务规则或仓内约定？" /></label><KnowledgeMaterialUpload materials={materials} onChange={setMaterials} onBusy={setUploading} disabled={busy} /></>}
      {mode === "component" && <>{catalog.error && <p role="alert" className="text-danger">{catalog.error}</p>}{!catalog.loading && !languageOptions.length && <p>暂无启用的技术栈，请在<a href="/configuration?tab=technologies" target="_blank" rel="noreferrer" className="text-primary underline">配置中心 → 技术栈</a>添加。</p>}<label>技术栈<Select value={language} onValueChange={v => setLanguage(v ?? "")} items={languageOptions.map(l => ({value:l.id,label:l.name}))}><SelectTrigger aria-label="技术栈"><SelectValue placeholder="选择技术栈" /></SelectTrigger><SelectContent>{languageOptions.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent></Select></label><p className="knowledge-create-hint">先分析该技术栈的功能能力，再分别研究文件操作、数据库操作、P2P 等组件用法。一个来源仓可以包含多个组件，同一个组件也可以涉及多个来源仓。</p></>}
      {mode === "skill-extraction" && <><label>制作要求<Textarea required rows={4} value={goal} onChange={e => setGoal(e.target.value)} placeholder="这个 Skill 用来完成什么，适用于哪些场景？" /></label><label>参考仓库<Input required value={repo} onChange={e => setRepo(e.target.value)} placeholder="代码仓地址" /></label><label>参考路径 <small className="knowledge-create-hint">选填</small><Input value={path} onChange={e => setPath(e.target.value)} placeholder="留空则研究整个参考仓" /></label><label>知识归属<KnowledgeDestination value={destination} onChange={setDestination} /></label></>}
    </div><aside className="knowledge-create-aside"><h3>{mode === "domain" ? "关联业务仓" : mode === "component" ? "参考来源仓" : "制作结果"}</h3>{mode === "component" && !!sourceRepositories.length && <p className="knowledge-create-hint">以下 {sourceRepositories.length} 个仓库提供源码依据，组件按功能能力分析，不按仓库划分。</p>}<ul aria-label={mode === "component" ? "参考来源仓列表" : undefined}>{mode === "domain" ? module?.repositories.map(r => <li key={r}><strong>{r.split("/").at(-1)?.replace(/\.git$/, "")}</strong><small>{r}</small><small>{branch}</small></li>) : mode === "component" ? sourceRepositories.map(c => <li key={c.id}><strong>{c.name}</strong><small>{c.repository} · {c.branch} · {c.path || "根目录"}</small></li>) : <li><strong>完整 Skill 包</strong><small>起草后进入文稿审查，确认归属和内容后发布。</small></li>}</ul>{mode === "domain" && !module && <p className="knowledge-create-hint">选择模块后显示关联仓库。</p>}{mode === "domain" && module && existing.length > 0 && <div className="mt-6"><h3>已有正式知识 · {existing.length} 篇</h3><ul>{existing.map(d => <li key={d.id}><button type="button" className="knowledge-inline-link border-0 bg-transparent p-0 font-semibold" onClick={() => onOpenDocument?.(d.id, destination)}>{d.title}</button><small>{knowledgeFileName(d)}</small></li>)}</ul><p className="knowledge-create-hint mt-3">补充或修订已有内容，请打开正式知识并点击「开始检视」。本次新研究的产物仅保存在任务中，MR 合入后才更新正式知识。</p></div>}{mode === "component" && !sourceRepositories.length && <p className="knowledge-create-hint">{language ? "该技术栈还没有启用的来源仓，请先在配置中心 → 基础组件仓登记。" : "选择技术栈后显示参考来源仓。"}</p>}</aside></div>
    {mode === "domain" && <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" aria-label="萃取前清理旧知识" className="mt-1" checked={!!prepareCleanup} disabled={busy} onChange={event => change({ prepareCleanup: event.target.checked })} /><span><strong>萃取前清理旧知识</strong><span className="mt-1 block text-muted-foreground">先预览、选择待删文件并创建清理 MR；你处理完 MR 后再开始萃取。未勾选时直接研究。</span></span></label>}
    <footer className="knowledge-create-footer"><p className="knowledge-create-hint">{mode === "domain" && prepareCleanup ? "先保存萃取信息，进入旧知识清理。" : "创建后进入知识任务中心，可随时查看进度与研究记录。"}</p><Button type="submit" disabled={busy || uploading || materialsBlocked || !canCreate}>{busy ? "正在创建…" : mode === "domain" && prepareCleanup ? "进入旧知识清理" : "开始研究"}</Button></footer></form>
  </section>;
}
