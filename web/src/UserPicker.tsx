/**
 * 人员选择（票 #211 shadcn 化）：姓名用于阅读，工号仍是身份；几十人时直接搜索。
 *
 * 默认保持单选；multiple 模式接收账号数组，勾选后保留弹层以便连续选择。
 * UserOption / userLabel 和既有单选消费点保持兼容。内部从手写组合框换成 shadcn combobox 范式 =
 * Popover + Command（cmdk，同 EnvironmentPicker #212）：开合、外点关闭、
 * Escape 交给 Popover；搜索、键盘上下选择、IME 组合期回车保护、空态交给
 * CommandInput/CommandList/CommandItem/CommandEmpty——手写的 document
 * mousedown、Escape onKeyDown、role=listbox 选项按钮全部删除。
 * 交互口径保持：匹配口径（display_name+username 包含、大小写不敏感）不变，
 * shouldFilter=false 仍由自己过滤；超过 6 项才出搜索框；禁用项 disabled
 * 不可选；详情行（em）与「姓名（工号）」双行渲染原样保留。
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface UserOption {
  username: string;
  display_name?: string;
  disabled?: boolean;
  detail?: string;
}

export function userLabel(user: Pick<UserOption, "username" | "display_name">): string {
  return user.display_name
    ? `${user.display_name}（${user.username}）`
    : user.username;
}

/** 搜索框与触发器共用的控件皮（shadcn input 同款配方，同 EnvironmentPicker）。 */
const userControlClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm "
  + "shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] "
  + "focus-visible:ring-ring/50";

export function UserPicker(props: {
  options: UserOption[];
  ariaLabel: string;
  /** 触发器内的常驻前缀(如「责任人」):不选人也知道这框是什么。 */
  label?: string;
  disabled?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  /** 多人名单需要完整展示时，让已选姓名和账号自动换行。 */
  wrapSelection?: boolean;
} & ({ multiple: true; value: string[]; onChange: (usernames: string[]) => void }
  | { multiple?: false; value: string; onChange: (username: string) => void })) {
  const {
    options,
    ariaLabel,
    label,
    disabled = false,
    placeholder = "搜索姓名或工号",
    emptyLabel = "请选择成员",
    wrapSelection = false,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedValues = props.multiple ? props.value : props.value ? [props.value] : [];
  const selectedLabel = selectedValues.map(username => userLabel(
    options.find(item => item.username === username) ?? { username },
  )).join("、");
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((item) => `${item.display_name ?? ""}\n${item.username}`
      .toLocaleLowerCase().includes(needle));
  }, [options, query]);
  const searchable = options.length > 6;

  return <div className="tw-root min-w-0">
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) setQuery("");
    }}>
      <PopoverTrigger
        render={<button type="button" disabled={disabled}
          className={`${userControlClass} flex justify-between gap-2 text-left ${wrapSelection ? "h-auto min-h-9 items-start" : "items-center"}`}
          aria-label={ariaLabel} aria-expanded={open}>
          {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
          {wrapSelection && selectedValues.length > 0
            ? <span className="flex min-w-0 flex-1 flex-wrap gap-1">
              {selectedValues.map(username => <span key={username}
                className="max-w-full rounded bg-surface-2 px-1.5 py-0.5 text-xs [overflow-wrap:anywhere]">
                {userLabel(options.find(item => item.username === username) ?? { username })}
              </span>)}
            </span>
            : <span className="min-w-0 truncate">{selectedLabel || emptyLabel}</span>}
          <ChevronDown aria-hidden
            className={`size-4 shrink-0 text-muted-foreground transition-transform${wrapSelection ? " mt-0.5" : ""}${open ? " rotate-180" : ""}`} />
        </button>} />
      {/* 弹层 portal 到 body：必须自带 .tw-root 归一（见 EnvironmentPicker 文件头）。 */}
      <PopoverContent align="start"
        className="tw-root w-(--anchor-width) min-w-60 gap-0 p-0">
        <Command shouldFilter={false} className="rounded-lg!">
          {searchable && <CommandInput value={query} onValueChange={setQuery}
            autoFocus placeholder={placeholder} aria-label={`${ariaLabel}搜索`} />}
          <CommandList aria-label={ariaLabel} className="max-h-44">
            {shown.map((item) => <CommandItem key={item.username}
              value={item.username} disabled={item.disabled}
              data-checked={selectedValues.includes(item.username) || undefined}
              onSelect={() => {
                if (props.multiple) {
                  props.onChange(selectedValues.includes(item.username)
                    ? selectedValues.filter(value => value !== item.username)
                    : [...selectedValues, item.username]);
                } else { props.onChange(item.username); setOpen(false); setQuery(""); }
              }}
              className="py-2">
              {props.multiple && <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded border border-input">
                {selectedValues.includes(item.username) && <Check className="size-3" />}
              </span>}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-[12.5px] font-medium text-foreground">
                  {item.display_name ?? item.username}
                </strong>
                {item.display_name
                  && <small className="truncate text-xs text-muted-foreground">{item.username}</small>}
              </span>
              {item.detail && <em className="max-w-[104px] shrink-0 truncate text-xs not-italic text-muted-foreground">
                {item.detail}
              </em>}
            </CommandItem>)}
            <CommandEmpty>没有匹配的成员</CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>;
}
