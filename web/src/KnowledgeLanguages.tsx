import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import { useEffect } from "react";
import { useTechnologyStacks } from "./useTechnologyStacks";
import { technologyStackLabel } from "./technologyStacks";

export function knowledgeLanguageLabel(id: string): string { return technologyStackLabel(id); }

export function KnowledgeLanguageTags({ languages, empty = "未标注技术栈" }: {
  languages?: readonly string[] | null; empty?: string;
}) {
  const { stacks } = useTechnologyStacks();
  const normalized = Array.isArray(languages) ? languages.filter((id): id is string => typeof id === "string" && !!id) : [];
  if (!normalized.length) return <span className="inline-block text-xs text-faint">{empty}</span>;
  return <span className="flex flex-wrap gap-1">{normalized.map(id => <Badge key={id} variant="brand"
    className="border border-primary/30 font-semibold">{technologyStackLabel(id, stacks)}</Badge>)}</span>;
}

/** 共用配置目录；停用项只保留已有引用，仍允许移除原选择。 */
export function KnowledgeLanguagePicker({ value, onChange, includeAgnostic = true }: {
  value: string[]; onChange: (value: string[]) => void; includeAgnostic?: boolean;
}) {
  const { stacks, loading, loaded, error, reload, deletedIds } = useTechnologyStacks();
  useEffect(() => {
    const keep = (id: string) => !deletedIds.includes(id) && (!loaded || !!error || id === "agnostic" || stacks.some(item => item.id === id));
    if (value.some(id => !keep(id))) onChange(value.filter(keep));
  }, [value, stacks, loaded, error, deletedIds, onChange]);
  const options = stacks.filter(item => item.enabled || value.includes(item.id)).map(item => ({
    id: item.id, label: item.name + (item.enabled ? "" : "（已停用）"),
  }));
  for (const id of value) if (id !== "agnostic" && !options.some(item => item.id === id)) {
    options.push({ id, label: `${id}（未配置）` });
  }
  if (includeAgnostic || value.includes("agnostic")) options.unshift({ id: "agnostic", label: "通用 / 技术栈无关" });
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(item => item !== id)
    : id === "agnostic" ? [id] : [...value.filter(item => item !== "agnostic"), id]);
  return <div className="grid gap-2">
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="适用技术栈，可多选">
      {options.map(option => <button type="button" key={option.id} aria-pressed={value.includes(option.id)}
        disabled={option.id !== "agnostic" && (loading || !!error)}
        className={cn("rounded-full border px-2.5 py-1 text-sm transition-colors disabled:opacity-50",
          value.includes(option.id) ? "border-primary bg-primary/5 font-bold text-primary" : "border-line bg-surface text-muted-foreground hover:border-line-strong")}
        onClick={() => toggle(option.id)}>{option.label}</button>)}
    </div>
    {loading && <p role="status" className="text-sm text-muted-foreground">正在读取技术栈…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error} <button type="button" className="underline" onClick={() => { void reload().catch(() => {}); }}>重试</button></p>}
    {!loading && !error && !stacks.some(item => item.enabled) && <p className="text-sm text-muted-foreground">暂无启用的技术栈，请在<a className="text-primary underline" href="/configuration?tab=technologies" target="_blank" rel="noreferrer">配置中心 → 技术栈</a>添加。</p>}
  </div>;
}

export function KnowledgeLanguageFilter({ value, onChange, counts }: {
  value: string; onChange: (value: string) => void; counts?: Map<string, number>;
}) {
  const { stacks } = useTechnologyStacks();
  const ids = [...new Set([...stacks.map(item => item.id), ...(counts?.keys() ?? []), ...(value !== "all" && value !== "untagged" ? [value] : [])])];
  const options = ids.map(id => ({ value: id, label: `${technologyStackLabel(id, stacks)}${counts?.has(id) ? `（${counts.get(id)}）` : ""}` }));
  return <label className="flex flex-none items-center gap-2">
    <span className="text-sm font-bold text-muted-foreground">技术栈</span>
    <Select value={value} items={[{ value: "all", label: "全部技术栈" }, { value: "untagged", label: "未标注" }, ...options]}
      onValueChange={next => onChange(next ?? "all")}>
      <SelectTrigger aria-label="技术栈筛选"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup><SelectItem value="all">全部技术栈</SelectItem><SelectItem value="untagged">未标注</SelectItem>
        {options.map(option => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}
      </SelectGroup></SelectContent>
    </Select>
  </label>;
}

export function matchesKnowledgeLanguage(languages: string[], filter: string): boolean {
  return filter === "all" || (filter === "untagged" ? !languages.length : languages.includes(filter));
}
