import { useTechnologyStacks } from "./useTechnologyStacks";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Building2, SlidersHorizontal, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Code2, FolderOpen, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cachedKnowledgeModules, compareKnowledgeModules, knowledgeFileName, knowledgeModuleNames, loadKnowledgeModules, type KnowledgeModuleCategory } from "./knowledgeModules";
import { invalidateKnowledgeReads, knowledgeReadGeneration, subscribeKnowledgeReads } from "./knowledgeReadCache";

export interface KnowledgeModuleHomeProps {
  onOpenModule: (key: string) => void;
  onOpenDocument?: (id: string, moduleKey: string) => void;
}

export function KnowledgeModuleHome({ onOpenModule, onOpenDocument }: KnowledgeModuleHomeProps) {
  const { stacks } = useTechnologyStacks();
  const [filterOpen,setFilterOpen] = useState(false);
  const [loaded, setData] = useState(cachedKnowledgeModules), [error, setError] = useState("");
  const data = useMemo(() => knowledgeModuleNames(loaded, stacks), [loaded, stacks]);
  const generation = useSyncExternalStore(subscribeKnowledgeReads, knowledgeReadGeneration, knowledgeReadGeneration);
  const [category, setCategory] = useState<"all" | KnowledgeModuleCategory>("all"), [query, setQuery] = useState("");
  useEffect(() => {
    let live = true; setError("");
    void loadKnowledgeModules().then(value => { if (live) setData(value); }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [generation]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = (data?.modules ?? []).filter(m => (category === "all" || m.category === category)
    && (!needle || `${m.name} ${m.description}`.toLocaleLowerCase().includes(needle) || m.documents.some(d => `${d.title} ${knowledgeFileName(d)}`.toLocaleLowerCase().includes(needle))))
    .sort(compareKnowledgeModules);
  return <section className="tw-root km-home" aria-label="知识目录">
    <header className="km-home-heading">
      <div className="km-home-title">
        <h2>{{all:"知识目录",business:"业务知识",engineering:"工程知识",unassigned:"待整理"}[category]}</h2>
        {data && <span className="km-home-count">{visible.length} {category === "business" ? "个模块" : category === "engineering" ? "个工程目录" : "个目录"}</span>}
      </div>
      <div className="km-home-filterbar">
        <label className="km-home-search"><Search size={18} /><Input type="search" aria-label="搜索目录或文稿" placeholder="搜索目录、知识名称或文件名" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger render={<Button variant="outline" className="km-category-trigger" />}><SlidersHorizontal size={18}/><span>知识分类</span><strong>{{all:"全部",business:"业务",engineering:"工程",unassigned:"待整理"}[category]}</strong><ChevronDown size={15}/></PopoverTrigger>
          <PopoverContent align="end" sideOffset={10} className="tw-root km-category-panel" aria-label="按知识分类筛选"><div className="km-category-disc" role="group" aria-label="知识分类">{([["business","业务",Building2],["engineering","工程",Code2],["all","全部",null]] as const).map(([value,label,Icon])=><button type="button" key={value} data-category={value} aria-pressed={category===value} onClick={()=>{setCategory(value);}}>{Icon&&<Icon size={21}/>}<span>{label}</span></button>)}<div className="km-category-indicator" style={{transform:`rotate(${category==="business"?-90:category==="engineering"?90:0}deg)`}}/></div><p className="text-center text-xs text-muted-foreground">业务按模块，工程按技术栈或通用方法</p><Button size="sm" variant="ghost" className="text-primary" onClick={()=>setFilterOpen(false)}>收起</Button></PopoverContent>
        </Popover>
      </div>
    </header>
    {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm"><span>知识目录读取失败：{error}</span><Button variant="outline" onClick={invalidateKnowledgeReads}>重试</Button></div>}
    {!data && !error && <p role="status" className="py-12 text-center text-muted-foreground">正在读取知识目录…</p>}
    {data?.warnings.map(warning => <p key={warning} role="status" className="text-sm text-attention">{warning}</p>)}
    {([['business', '业务模块'], ['engineering', '工程知识'], ['unassigned', '待整理']] as const).map(([group, label]) => {
      const modules = visible.filter(m => m.category === group);
      if (!modules.length) return null;
      const Icon = group === "business" ? BookOpen : group === "engineering" ? Code2 : FolderOpen;
      return <section key={group} className="km-home-group" aria-label={label}>
        <h3 className="km-home-group-heading"><Icon size={18} />{label}<span>{modules.length}</span></h3>
        <div className="km-module-grid">{modules.map(module => {
          const hits = needle ? module.documents.map(d => ({ id: d.id, name: knowledgeFileName(d) })).filter(d => d.name.toLocaleLowerCase().includes(needle)).slice(0, 3) : [];
          return <Card key={module.key} className="km-module-card" data-category={group}>
            <Button variant="ghost" className="km-module-open" onClick={() => onOpenModule(module.key)} aria-label={`打开${module.name}知识目录`}>
              <div className="km-module-content">
                <div className="km-module-title">
                  <span className="km-module-icon" aria-hidden="true"><Icon size={21} /></span>
                  <h3 title={module.name}>{module.name}</h3>
                  <ChevronRight size={18} className="km-module-arrow" aria-hidden="true" />
                </div>
                <p className="km-module-description">{module.description || (module.category === "business" ? "远端正式文档与关联仓知识" : "基础组件知识与 Skill")}</p>
              </div>
            </Button>
            {hits.length > 0 && onOpenDocument && <div className="grid gap-1 border-t border-line px-4 py-2">{hits.map(doc => <Button key={doc.id} variant="ghost" size="sm" className="justify-start" onClick={() => onOpenDocument(doc.id, module.key)}><ArrowUpRight size={14} /><span className="truncate">{doc.name}</span></Button>)}</div>}
          </Card>;
        })}</div>
      </section>;
    })}
    {data && !visible.length && <div className="grid justify-items-center gap-3 py-16 text-muted-foreground"><FolderOpen size={30} /><p>{needle ? "没有匹配的目录或文稿" : "当前分类还没有知识目录"}</p>{needle && <Button variant="outline" onClick={() => setQuery("")}>清空搜索</Button>}</div>}
  </section>;
}
