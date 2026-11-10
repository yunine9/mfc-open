/**
 * 表头列筛选的共用壳(先住 EnvironmentRegistry,2026-09-13 DTS 列表
 * 筛选表头化时抽出两页共用):漏斗钮 + 弹层,激活的漏斗给 accent 小
 * 底块——哪列在筛,一眼可辨。弹层 portal 到 body,内容必须自带
 * .tw-root 归一(同 EnvironmentPicker 的教训)。children 拿 close(),
 * 选项类选完即关,文本输入类忽略。
 */
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Filter } from "lucide-react";
import { cn } from "cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

/** 表头排序标记(先住 EnvironmentRegistry,交付统计四张表加入后提为
 *  共用):未排序给双箭头提示可点,激活后给方向单箭头。 */
export function SortMark({ active, dir }: { active: boolean; dir?: 1 | -1 }) {
  if (!active) {
    return <ChevronsUpDown aria-hidden className="size-3 text-muted-foreground" />;
  }
  return dir === 1
    ? <ArrowUp aria-hidden className="size-3" />
    : <ArrowDown aria-hidden className="size-3" />;
}

export function HeaderFilter({ label, active, onClear, clearLabel, contentClassName, children }: {
  label: string;
  active: boolean;
  /** 本列的清除动作:给了才在弹层底部出清除入口。 */
  onClear?: () => void;
  /** 清除入口的措辞(缺省「清除此列筛选」;过滤入口不在列头上时自定义)。 */
  clearLabel?: string;
  /** 弹层宽度覆盖(缺省 w-40):多选清单类内容可放宽。 */
  contentClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      render={
        <button type="button" aria-label={`筛选 ${label}`}
          title={active ? `筛选 ${label}(生效中,点开可清除)` : `筛选 ${label}`}
          aria-pressed={active}
          className={active
            ? "rounded-sm bg-accent px-0.5 text-ink"
            : "text-muted-foreground hover:text-foreground"}>
          <Filter aria-hidden className="size-3.5" />
        </button>
      } />
    <PopoverContent align="start" className={cn("tw-root p-1", contentClassName ?? "w-40")}>
      {children(() => setOpen(false))}
      {active && onClear && <div className="border-t border-line pt-1 mt-1">
        <button type="button"
          className="w-full rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            onClear();
            setOpen(false);
          }}>{clearLabel ?? "清除此列筛选"}</button>
      </div>}
    </PopoverContent>
  </Popover>;
}

/**
 * 列头筛选的单选枚举:搜索框 + 选项清单(选中打勾,选完即关;
 * 壳在 HeaderFilter)。选项由调用方给全量,搜索只做前端过滤;
 * value="" 视为未筛(清除走壳的 onClear)。交付统计两个页签
 * (ADR-0065)与 DTS 列表的关键字漏斗同一套壳。
 */
export function HeaderEnumFilter({ label, value, options, onPick }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const hit = keyword
    ? options.filter((option) => option.label.toLowerCase().includes(keyword))
    : options;
  return <HeaderFilter label={label} active={value !== ""} onClear={() => onPick("")}>
    {(close) => <div className="flex flex-col">
      <Input autoFocus className="h-8 w-full rounded-md px-2 text-sm"
        placeholder={`搜索${label}…`} aria-label={`搜索${label}筛选`}
        value={query} onChange={(event) => setQuery(event.target.value)} />
      <div role="listbox" aria-label={`按${label}筛选`}
        className="mt-1 flex max-h-64 flex-col overflow-y-auto">
        {hit.map((option) => <button type="button" key={option.value}
          role="option" aria-selected={option.value === value}
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { onPick(option.value); close(); }}>
          <span className="min-w-0 truncate" title={option.label}>{option.label}</span>
          {option.value === value && <Check aria-hidden className="size-3.5 shrink-0 text-ink" />}
        </button>)}
        {!hit.length && <p className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的选项</p>}
      </div>
    </div>}
  </HeaderFilter>;
}
