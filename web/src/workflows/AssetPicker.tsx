/**
 * 资产检选器(票 #212 shadcn 化):从「编辑面板旁的手写面板」迁成
 * Dialog + Command——CommandInput 负责搜索,分类筛选保留为筛选行,
 * 结果与空态交给 CommandItem / CommandEmpty,键盘上下与回车选择由
 * cmdk 接管。对外 props(assets/selectedKey/onSelect/onClose/title)
 * 与选择语义不变;组件由消费方条件挂载,故 Dialog 受控 open 挂载即开。
 */
import { useMemo, useState } from "react";
import type { WorkflowAssetCatalogItem } from "../api";
import { technologyStackLabel } from "../technologyStacks";
import { useTechnologyStacks } from "../useTechnologyStacks";
import { assetKey, registryLabels } from "./model";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "cn";

type AssetCategory = "all" | "business" | "engineering" | "skill" | "capability";

const categories: readonly (readonly [AssetCategory, string])[] = [
  ["all", "全部"],
  ["business", "业务知识"],
  ["engineering", "工程知识"],
  ["skill", "Skill"],
  ["capability", "Agent / 工具"],
];

export function AssetPicker({
  assets,
  selectedKey,
  onSelect,
  onClose,
  title = "选择要使用的资产",
}: {
  assets: WorkflowAssetCatalogItem[];
  selectedKey?: string;
  onSelect: (asset: WorkflowAssetCatalogItem) => void;
  onClose?: () => void;
  title?: string;
}) {
  const { stacks } = useTechnologyStacks();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AssetCategory>("all");
  const visible = useMemo(() => assets.filter((asset) => {
    const needle = query.trim().toLocaleLowerCase();
    const matchesQuery = !needle || [asset.title, asset.summary, asset.ref.id,
      asset.when_to_use ?? "", ...asset.technologies,
      ...asset.technologies.map(id => technologyStackLabel(id, stacks))].join(" ")
      .toLocaleLowerCase().includes(needle);
    const matchesCategory = category === "all"
      || (category === "business" && asset.nature === "business")
      || (category === "engineering" && asset.nature === "engineering")
      || (category === "skill" && asset.type === "skill")
      || (category === "capability"
        && ["agent", "tool", "capability"].includes(asset.type));
    return matchesQuery && matchesCategory;
  }), [assets, category, query, stacks]);

  return <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
    {/* portal 弹层自带 .tw-root 归一(同 EnvironmentPicker 的教训)。 */}
    <DialogContent className="tw-root flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      aria-labelledby="wf-asset-picker-title" showCloseButton={false}>
      <DialogHeader className="gap-1 border-b border-line p-4 pr-12">
        <span className="text-xs font-medium text-muted-foreground">资产目录</span>
        <DialogTitle id="wf-asset-picker-title">{title}</DialogTitle>
        <DialogDescription className="sr-only">选择要使用的资产</DialogDescription>
      </DialogHeader>
      {onClose && <DialogClose render={<Button variant="ghost" size="icon-sm"
        className="absolute top-2 right-2" aria-label="关闭资产选择" />}>
        <XIcon aria-hidden />
      </DialogClose>}
      {/* 搜索不过 cmdk 的内置过滤器(shouldFilter=false):匹配口径
          (标题/用途/技术/分类)保持原样,由 visible 自己算。 */}
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery}
          placeholder="按名称、用途或技术搜索" aria-label="搜索资产" />
        <div role="group" aria-label="资产分类"
          className="flex flex-wrap gap-1 px-3 pt-2 pb-1">
          {categories.map(([value, label]) =>
            <button key={value} type="button" aria-pressed={category === value}
              onClick={() => setCategory(value)}
              className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors",
                category === value
                  ? "border-transparent bg-ink text-ink-fg"
                  : "border-line text-muted-foreground hover:bg-accent hover:text-accent-foreground")}>
              {label}
            </button>)}
        </div>
        <CommandList aria-label="资产清单">
          {visible.map((asset) => {
            const unavailable = asset.availability === "unavailable";
            const key = assetKey(asset.ref);
            return <CommandItem key={key} value={key}
              disabled={unavailable}
              data-checked={selectedKey === key || undefined}
              onSelect={() => onSelect(asset)}
              className="items-start gap-2 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm font-medium text-foreground">{asset.title}</strong>
                  <em className={cn("text-xs not-italic",
                    unavailable ? "text-destructive" : "text-muted-foreground")}>
                    {unavailable ? "不可用" : registryLabels[asset.ref.registry]}</em>
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">{asset.summary}</span>
                {asset.when_to_use && <span className="text-xs text-muted-foreground">
                  <b className="mr-1 font-medium text-foreground">使用时机</b>{asset.when_to_use}</span>}
                <span className="flex flex-wrap items-center gap-1">
                  <b className="rounded border border-line px-1 font-mono text-[10px] font-medium text-muted-foreground">
                    {asset.ref.version}</b>
                  <b title={asset.ref.digest}
                    className="rounded border border-line px-1 font-mono text-[10px] font-medium text-muted-foreground">
                    摘要 {asset.ref.digest.slice(0, 8)}</b>
                  {asset.ref.repository && <b title={asset.ref.repository}
                    className="rounded border border-line px-1 text-[10px] font-medium text-muted-foreground">
                    {shortRepository(asset.ref.repository)}</b>}
                  {asset.technologies.slice(0, 2).map((item) => <b key={item}
                    className="rounded border border-line px-1 text-[10px] font-medium text-muted-foreground">
                    {technologyStackLabel(item, stacks)}</b>)}
                </span>
                {asset.warning && <span
                  className="rounded bg-danger-soft px-1.5 py-0.5 text-xs text-danger">{asset.warning}</span>}
              </span>
            </CommandItem>;
          })}
          <CommandEmpty>
            <span className="flex flex-col items-center gap-1">
              <strong className="text-sm font-medium text-foreground">没有匹配的资产</strong>
              <span className="text-xs text-muted-foreground">
                换个关键词或分类；不可用资产不会被静默加入。</span>
            </span>
          </CommandEmpty>
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>;
}

function shortRepository(repository: string): string {
  return repository.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/i, "")
    || repository;
}
