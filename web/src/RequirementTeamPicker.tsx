import { PersonName } from "./People";
import { useEffect, useMemo, useState } from "react";
import {
  listCollaborationAssignees,
  putTaskCollaborators,
  type CollaborationAssignee,
} from "./api";
import { userLabel } from "./UserPicker";
import { ChevronDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** 触发器按钮皮(与 EnvironmentPicker 触发器同款控件配方)。 */
const teamTriggerClass =
  "flex h-9 w-full items-center justify-between gap-2 rounded-md border "
  + "border-input bg-transparent px-3 py-2 text-left text-sm shadow-xs "
  + "outline-none focus-visible:border-ring focus-visible:ring-[3px] "
  + "focus-visible:ring-ring/50";

export function RequirementTeamPicker({
  taskId,
  owner,
  collaborators = [],
  onSaved,
}: {
  taskId: string;
  owner?: string;
  collaborators?: string[];
  onSaved?: () => void;
}) {
  const initial = useMemo(() => [...new Set(collaborators)],
    [taskId, collaborators.join("\0")]);
  const [people, setPeople] = useState<CollaborationAssignee[]>([]);
  const [selected, setSelected] = useState<string[]>(initial);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    setSelected(initial);
    setLoading(true);
    setError("");
    void listCollaborationAssignees().then((candidates) => {
      if (!alive) return;
      const available = candidates.filter((candidate) =>
        candidate.username !== owner);
      const known = new Set(available.map((candidate) => candidate.username));
      // 账号后来被停用/删除时仍要让主责任人看见并移除，不能因为候选
      // 接口不再返回它，就把整个协作成员表永久锁死。
      for (const username of initial) {
        if (!known.has(username) && username !== owner) {
          available.push({
            username, ready: false, missing: ["账号已不可用"],
          });
        }
      }
      setPeople(available);
      setLoading(false);
    }).catch((cause) => {
      if (!alive) return;
      setError(cause instanceof Error ? cause.message : "讨论参与人读取失败");
      setLoading(false);
    });
    return () => { alive = false; };
  }, [taskId, owner, initial]);

  const peopleByName = new Map(people.map((person) => [person.username, person]));
  const allReady = selected.every((username) =>
    peopleByName.get(username)?.ready === true);
  const shownPeople = people.filter((person) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${person.display_name ?? ""}\n${person.username}`
      .toLocaleLowerCase().includes(needle);
  });

  function toggle(username: string) {
    setSaved(false);
    setError("");
    setSelected((current) => current.includes(username)
      ? current.filter((account) => account !== username)
      : [...current, username]);
  }

  async function save() {
    if (loading || saving || !allReady) return;
    setSaving(true);
    setError("");
    try {
      await putTaskCollaborators(taskId, selected);
      setSaved(true);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "讨论参与人保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <section className="requirement-team-picker" aria-label="主任务讨论参与人">
    <header>
      <div><span>讨论参与人</span><strong>谁一起把需求聊清楚</strong></div>
      <small>一位主责任人拍板，多位参与人一起讨论</small>
    </header>
    <div className="requirement-team-owner">
      <i aria-hidden>主</i>
      <span><strong><PersonName account={owner} fallback="本地主责任人" /></strong>
        <small>主责任人 · 最终确认、拆单和任务控制</small></span>
    </div>
    {/* 成员多选(票 #212 shadcn 化):Popover + Command——搜索、勾选、
        键盘导航交给 cmdk;匹配口径(姓名/工号 includes)保持原样,
        shouldFilter=false 由 shownPeople 自己过滤。多选不收起弹层。 */}
    {loading && <p className="px-3 py-2 text-sm text-muted-foreground">正在读取可邀请成员…</p>}
    {!loading && people.length === 0
      && <p className="px-3 py-2 text-sm text-muted-foreground">当前没有其他可邀请的开发者。</p>}
    {!loading && people.length > 0 && <Popover>
      <PopoverTrigger render={<button type="button" className={teamTriggerClass}
        aria-label={selected.length
          ? `已选 ${selected.length} 位讨论参与人`
          : "选择讨论参与人"}>
        <span className={selected.length
          ? "truncate text-foreground"
          : "truncate text-muted-foreground"}>
          {selected.length ? `已选 ${selected.length} 位参与人` : "选择讨论参与人"}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>} />
      {/* 弹层 portal 到 body:必须自带 .tw-root 归一。 */}
      <PopoverContent align="start" className="tw-root w-(--anchor-width) gap-0 p-0">
        <Command shouldFilter={false} className="rounded-lg!">
          <CommandInput value={query} onValueChange={setQuery}
            placeholder="输入姓名或工号" aria-label="搜索成员" />
          <CommandList aria-label="可邀请成员">
            {shownPeople.map((person) => {
              const checked = selected.includes(person.username);
              return <CommandItem key={person.username} value={person.username}
                data-checked={checked || undefined}
                // 未就绪成员不可被新勾入,但已勾着的仍可取消(可移除)。
                disabled={saving || (!person.ready && !checked)}
                onSelect={() => toggle(person.username)}
                className="items-start py-2">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <strong className="text-sm font-medium text-foreground">{userLabel(person)}</strong>
                  <small className={person.ready
                    ? "text-xs text-muted-foreground"
                    : "text-xs text-destructive"}>
                    {person.ready ? "设置已就绪，可参与讨论"
                      : `暂不可邀请 · 缺 ${person.missing.join("、")}`}</small>
                </span>
              </CommandItem>;
            })}
            {!loading && people.length > 0
              && <CommandEmpty className="py-4 text-xs text-muted-foreground">
                没有匹配「{query.trim()}」的成员</CommandEmpty>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>}
    {error && <p className="requirement-team-error" role="alert">{error}</p>}
    <footer>
      <p>参与人可送批注、补充材料并和 AI 讨论，但不能代替主责任人拍板。</p>
      <button type="button" disabled={loading || saving || !allReady}
        onClick={() => void save()}>
        {saving ? "正在保存…" : saved ? "参与人已保存" : "保存并邀请参与"}
      </button>
    </footer>
  </section>;
}
