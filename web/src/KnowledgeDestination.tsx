import { useEffect, useState } from "react";
import { Check, ChevronDown, Search, Building2, Code2 } from "lucide-react";
import { getBusinessModules, type BusinessModule } from "./api";
import { useTechnologyStacks } from "./useTechnologyStacks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function KnowledgeDestination({ value, onChange, businessOnly = false }: { value: string; onChange: (value: string) => void; businessOnly?: boolean }) {
  const catalog = useTechnologyStacks();
  useEffect(() => { if (value.startsWith("engineering:") && value !== "engineering:agnostic" && (catalog.deletedIds.includes(value.slice(12)) || (catalog.loaded && !catalog.error && !catalog.stacks.some(item => item.id === value.slice(12))))) onChange(""); }, [value, catalog.deletedIds, catalog.loaded, catalog.error, catalog.stacks, onChange]);
  const [modules, setModules] = useState<BusinessModule[]>([]), [error, setError] = useState("");
  const [open,setOpen]=useState(false), [query,setQuery]=useState(""), [category,setCategory]=useState(value.startsWith("engineering:")&&!businessOnly?"engineering":"business");
  useEffect(() => { let live = true; void getBusinessModules().then(r => { if (live) setModules(r.modules.filter(m => m.status === "active")); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  const items = [...modules.map(m => ({ value: `business:${m.id}`, label: m.name, category:"business", enabled: true })), ...(!businessOnly ? [{ value: "engineering:agnostic", label: "通用", category: "engineering", enabled: true }, ...catalog.stacks.map(l => ({ value: `engineering:${l.id}`, label: l.name, category:"engineering", enabled: l.enabled }))] : [])];
  const selected=items.find(i=>i.value===value), visible=items.filter(i=>i.enabled&&i.category===category&&(!query||i.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return <div><Popover open={open} onOpenChange={v=>{setOpen(v);if(v){setQuery("");setCategory(value.startsWith("engineering:")&&!businessOnly?"engineering":"business");}}}><PopoverTrigger render={<Button variant="outline" role="combobox" aria-label="知识归属" className="w-full justify-between font-normal"/>}><span className="truncate">{selected?(businessOnly?selected.label:`${selected.category==="business"?"业务":"工程"} · ${selected.label}`):businessOnly?"选择业务模块":"选择业务模块或技术栈"}</span><ChevronDown size={15}/></PopoverTrigger><PopoverContent align="start" className="tw-root w-[340px] p-3" aria-label="选择知识归属"><div className="flex gap-2 rounded-md bg-muted p-1" role="group" aria-label="知识类别"><Button size="sm" variant={category==="business"?"secondary":"ghost"} className="flex-1" aria-pressed={category==="business"} onClick={()=>setCategory("business")}><Building2 size={14}/>业务模块</Button>{!businessOnly&&<Button size="sm" variant={category==="engineering"?"secondary":"ghost"} className="flex-1" aria-pressed={category==="engineering"} onClick={()=>setCategory("engineering")}><Code2 size={14}/>工程知识</Button>}</div><label className="relative mt-1"><Search className="absolute left-2 top-2.5 text-muted-foreground" size={14}/><Input autoFocus aria-label="搜索模块或技术栈" placeholder="搜索模块或技术栈" className="pl-7" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="max-h-60 overflow-y-auto grid gap-1" role="listbox" aria-label="可选知识归属">{visible.map(i=><Button key={i.value} variant="ghost" role="option" aria-selected={i.value===value} className="justify-between font-normal" onClick={()=>{onChange(i.value);setOpen(false);}}>{i.label}{i.value===value&&<Check size={15}/>}</Button>)}{!visible.length&&<p className="py-5 text-center text-sm text-muted-foreground">{query?"没有匹配项":category==="engineering"?(catalog.loading?"正在读取技术栈…":catalog.error||"暂无启用的技术栈，请在配置中心 → 技术栈添加。") :"暂无业务模块，请在配置中心添加。"}</p>}</div></PopoverContent></Popover>{error && <p role="alert" className="text-danger text-sm mt-2">{error}</p>}</div>;
}
export function destinationMetadata(value: string) {
  const [kind, ...parts] = value.split(":"), id = parts.join(":");
  if (!id || !["business", "engineering"].includes(kind)) throw new Error("请选择知识归属");
  return { nature: kind as "business" | "engineering", business_module_ids: kind === "business" ? [id] : [], technologies: kind === "engineering" ? [id] : [], repositories: [] };
}
