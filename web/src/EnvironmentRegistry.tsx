/**
 * 环境管理(ADR-0020;票 #149 前端半边):全局网管环境台账的页签。
 *
 * Tailwind/shadcn 第一页,#146 触碰即迁约束的第一个适用对象:样式全走
 * 工具类 + components/ui 的 shadcn 组件皮,根元素挂 .tw-root 做 scoped
 * 归一(tailwind.css fixes 层),不往 legacy css 层加任何东西、不 import
 * 任何 css 文件(组件要能被 node 契约测试直接读源码断言)。
 *
 * 密码纪律(ADR-0020):表单永不回显密码——编辑时后台密码只显示"已配置"
 * 占位,留空 = 不变;root 密码留空 = 继承后台密码,已单独配置的条目可一键
 * 清除回落继承。台账全员可读写,写操作 updated_by 由服务端记。
 */
import { useEffect, useMemo, useState } from "react";
import {
  deleteEnvironment,
  listEnvironments,
  probeEnvironment,
  type EnvironmentForm,
  type EnvironmentView,
} from "./api";
import {
  Activity,
  Check,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { PersonName, usePersonName } from "./People";
import { confirmDialog } from "./ConfirmDialog";
import { HeaderFilter, SortMark } from "./HeaderFilter";
import { formatLocalDateTime, relativeTime } from "./time";
import {
  ENVIRONMENT_FORM_TEXT,
  EnvironmentEditorDialog,
  PROBE_REASON_TEXT,
} from "./EnvironmentEditorDialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** 探活三态文案(本票只有未验证一态,#151 探活点亮其余)。 */
const PROBE_TEXT: Record<EnvironmentView["probe"]["state"], string> = {
  unverified: "未验证",
  ok: "正常",
  failed: "异常",
};

/** 探活失败原因二分(#151)的文案与色语义码表随共用弹框模块走
 * (EnvironmentEditorDialog),页面只消费展示。 */

/** 状态列徽标的色语义(#151):正常绿系、异常红系、未验证中性灰——
 * 全走 tailwind.css @theme 桥映射出的令牌工具类(--color-success/--color-danger
 * 系),不硬编码色值。 */
function probeToneClass(state: EnvironmentView["probe"]["state"]): string {
  if (state === "ok") return "border-success/40 bg-success-soft text-success";
  if (state === "failed") return "border-danger/40 bg-danger-soft text-danger";
  return "text-muted-foreground";
}

/** 状态列单元格(#151):三态徽标分层小字——pill 说结论,下面一行小字说
 * 何时探的;失败原因(不可达/认证失败)与「异常」pill 语义重复,不再整行
 * 堆叠,收进单元格悬浮提示(2026-09-13 走查:三行堆叠曾被读成重复文案,
 * danger-soft pill 在行左侧孤悬像丢了的指示点——归位即消除)。 */
function ProbeStateCell({ probe }: { probe: EnvironmentView["probe"] }) {
  return <div className="flex flex-col items-start gap-1"
    title={probe.state === "failed" && probe.reason
      ? `连接异常:${PROBE_REASON_TEXT[probe.reason] ?? probe.reason}`
      : undefined}>
    <Badge variant="outline" className={probeToneClass(probe.state)}>
      {PROBE_TEXT[probe.state] ?? "未验证"}
    </Badge>
    {probe.at && <span className="text-xs text-muted-foreground"
      title={`探活于 ${formatLocalDateTime(probe.at)}`}>
      {relativeTime(probe.at)}探活
    </span>}
  </div>;
}

/** 可排序列(操作列非数据)。 */
type SortKey = "ip" | "form" | "port" | "tags" | "state"
  | "updated_by" | "updated_at";

/** 状态排序档:升序=异常最前、正常最后——最需要处理的排最上。 */
const STATE_RANK: Record<EnvironmentView["probe"]["state"], number> = {
  failed: 0,
  unverified: 1,
  ok: 2,
};

/** IP 比较:双方都是 IPv4 时按数值逐段比(字典序会让 192.0.2.9 排到
 * 192.0.2.10 之后),IPv6/其他形态退回字典序。 */
function compareIp(a: string, b: string): number {
  const octets = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
    ? ip.split(".").map(Number)
    : null;
  const av = octets(a);
  const bv = octets(b);
  if (av && bv) {
    for (let i = 0; i < 4; i += 1) {
      if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return 0;
  }
  return a.localeCompare(b);
}

/** 列头筛选的单选选项清单:选中行打勾。(壳在 HeaderFilter,两页共用) */
function FilterOptions({ value, options, onPick }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onPick: (value: string) => void;
}) {
  return <div role="listbox" aria-label="筛选选项" className="flex flex-col">
    {options.map((option) => <button type="button" key={option.value || "__all"}
      role="option" aria-selected={option.value === value}
      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(option.value)}>
      {option.label}
      {option.value === value && <Check aria-hidden className="size-3.5 text-ink" />}
    </button>)}
  </div>;
}

export function EnvironmentRegistry() {
  const [environments, setEnvironments] = useState<EnvironmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 标签筛选:点行内标签徽标或下拉都汇入这一个状态(空串 = 不筛)。 */
  const [activeTag, setActiveTag] = useState("");
  /** 弹层状态:undefined = 关;existing 缺席 = 新增,有值 = 编辑该条。 */
  const [editor, setEditor] = useState<{ existing?: EnvironmentView }>();
  /** 行内探活进行中的条目 id(空串 = 空闲;一次探一条)。 */
  const [probingId, setProbingId] = useState("");
  /** 列排序:点表头 升→降→取消 三态循环;null = 保持登记顺序。 */
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  /** 列头筛选,全部空串 = 不筛。筛选住在各列头的漏斗里,不再占工具栏。 */
  const [ipFilter, setIpFilter] = useState("");
  const [formFilter, setFormFilter] = useState<EnvironmentForm | "">("");
  const [stateFilter, setStateFilter] = useState<EnvironmentView["probe"]["state"] | "">("");
  /** 更新人筛选用账号值,选项标签用显示名(与表格列一致,不见账号黑话)。 */
  const [updaterFilter, setUpdaterFilter] = useState("");
  const nameOf = usePersonName();

  /** 探活返回更新后的视图:就地合并进列表,状态列即时刷新(不整页轮询,
   * 后台已有约 10 分钟一轮的定时探活)。 */
  function applyProbeUpdate(updated: EnvironmentView) {
    setEnvironments((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)));
  }

  /** 行内探活(#151):对已存条目用台账后台密码探一次并持久化三态。 */
  async function probeRow(entry: EnvironmentView) {
    if (probingId) return;
    setProbingId(entry.id);
    try {
      applyProbeUpdate(await probeEnvironment(entry.id));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境探活失败");
    } finally {
      setProbingId("");
    }
  }

  async function refreshEnvironments() {
    try {
      setEnvironments(await listEnvironments());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境列表加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refreshEnvironments(); }, []);

  const allTags = useMemo(() =>
    [...new Set(environments.flatMap((entry) => entry.tags))].sort(),
    [environments]);
  const allUpdaters = useMemo(() =>
    [...new Set(environments.map((entry) => entry.updated_by))].sort(),
    [environments]);

  function toggleSort(key: SortKey) {
    setSort((cur) => cur?.key === key
      ? (cur.dir === 1 ? { key, dir: -1 } : null)
      : { key, dir: 1 });
  }

  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [ipFilter, activeTag, formFilter, stateFilter, updaterFilter, sort]);
  const visible = useMemo(() => {
    const needle = ipFilter.trim().toLowerCase();
    const filtered = environments.filter((entry) => {
      if (activeTag && !entry.tags.includes(activeTag)) return false;
      if (formFilter && entry.form !== formFilter) return false;
      if (stateFilter && entry.probe.state !== stateFilter) return false;
      if (needle && !entry.ip.toLowerCase().includes(needle)) return false;
      if (updaterFilter && entry.updated_by !== updaterFilter) return false;
      return true;
    });
    if (!sort) return filtered;
    const { key, dir } = sort;
    const cmp = (a: EnvironmentView, b: EnvironmentView): number => {
      if (key === "ip") return compareIp(a.ip, b.ip);
      if (key === "port") return a.port - b.port;
      if (key === "state") {
        return STATE_RANK[a.probe.state] - STATE_RANK[b.probe.state];
      }
      if (key === "tags") {
        const joined = (e: EnvironmentView) => [...e.tags].sort().join(" ");
        return joined(a).localeCompare(joined(b));
      }
      if (key === "updated_at") return a.updated_at.localeCompare(b.updated_at);
      if (key === "form") {
        return (ENVIRONMENT_FORM_TEXT[a.form] ?? a.form)
          .localeCompare(ENVIRONMENT_FORM_TEXT[b.form] ?? b.form);
      }
      return a.updated_by.localeCompare(b.updated_by);
    };
    return [...filtered].sort((a, b) => dir * cmp(a, b));
  }, [environments, activeTag, formFilter, stateFilter, ipFilter, updaterFilter, sort]);

  /** 表头排序钮的 aria-sort 值(未排序列不给属性)。 */
  function ariaSortOf(key: SortKey) {
    if (sort?.key !== key) return undefined;
    return sort.dir === 1 ? "ascending" : "descending";
  }
  const filtersActive = Boolean(activeTag || formFilter || stateFilter
    || ipFilter.trim() || updaterFilter);

  function clearFilters() {
    setActiveTag("");
    setFormFilter("");
    setStateFilter("");
    setIpFilter("");
    setUpdaterFilter("");
  }

  /** 删除走全站既有 confirmDialog 二次确认(spec #52),不用裸 window.confirm;
   * 台账删除不影响已选入会话的快照(ADR-0020),确认卡里说破。 */
  async function removeEnvironment(entry: EnvironmentView) {
    if (!await confirmDialog({
      title: `删除环境 ${entry.ip}`,
      message: <>这台环境将从环境管理里移除;正在进行的问题不受影响
        (密码在开始处理时已单独留存)。</>,
      confirmLabel: "删除",
      danger: true,
    })) return;
    try {
      await deleteEnvironment(entry.id);
      await refreshEnvironments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境删除失败");
    }
  }

  const pages = Math.max(1, Math.ceil(visible.length / 10));
  const currentPage = Math.min(page, pages);
  return <section
    className="tw-root flex flex-col gap-4 text-base text-foreground"
    aria-label="环境管理台账"
  >
    <div className="flex flex-wrap items-center gap-2">
      <div className="grow" />
      {filtersActive && <Button variant="ghost" size="sm"
        onClick={clearFilters}>清除筛选</Button>}
      <Button variant="outline" size="sm"
        onClick={() => void refreshEnvironments()}>刷新</Button>
      <Button size="sm" onClick={() => setEditor({})}>新增环境</Button>
    </div>

    {error && <div role="alert"
      className="rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger">
      {error}
    </div>}

    {loading ? <p className="text-sm text-muted-foreground">环境台账加载中…</p>
      : environments.length === 0
        ? <div
            data-testid="environment-registry-empty"
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
          <p className="text-base font-medium">还没有环境</p>
          <p className="max-w-md text-sm text-muted-foreground">
            点「新增环境」录入第一台网管环境(主 IP、形态、端口、后台密码),
            之后登记问题、处理问题需要环境时直接选,不用重复手填。
          </p>
          <Button size="sm" onClick={() => setEditor({})}>新增环境</Button>
        </div>
        : visible.length === 0
          ? <div
              data-testid="environment-registry-filtered-empty"
              className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">没有符合当前筛选条件的环境。</p>
            <Button variant="outline" size="sm" onClick={clearFilters}>清除筛选</Button>
          </div>
          : <div className="overflow-hidden rounded-xl border border-line bg-card shadow-xs">
          <Table aria-label="环境台账列表">
            <TableHeader>
              <TableRow className="border-line hover:bg-transparent">
                <TableHead aria-sort={ariaSortOf("ip")}
                  className="h-11 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <button type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("ip")}>
                      主 IP<SortMark active={sort?.key === "ip"} dir={sort?.dir} />
                    </button>
                    <HeaderFilter label="主 IP" active={!!ipFilter.trim()} onClear={() => setIpFilter("")}>
                      {() => <Input autoFocus
                        className="h-8 w-full rounded-md px-2 text-sm"
                        placeholder="包含 IP 片段…" aria-label="按 IP 过滤"
                        value={ipFilter}
                        onChange={(event) => setIpFilter(event.target.value)} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("form")}
                  className="h-11 w-24 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <button type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("form")}>
                      形态<SortMark active={sort?.key === "form"} dir={sort?.dir} />
                    </button>
                    <HeaderFilter label="形态" active={!!formFilter} onClear={() => setFormFilter("")}>
                      {(close) => <FilterOptions value={formFilter}
                        onPick={(v) => { setFormFilter(v as EnvironmentForm | ""); close(); }}
                        options={[{ value: "", label: "全部形态" },
                          { value: "virtualized", label: "虚拟化" },
                          { value: "k8s", label: "容器化" }]} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("port")}
                  className="h-11 w-20 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("port")}>
                    端口<SortMark active={sort?.key === "port"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("tags")}
                  className="h-11 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <button type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("tags")}>
                      标签<SortMark active={sort?.key === "tags"} dir={sort?.dir} />
                    </button>
                    <HeaderFilter label="标签" active={!!activeTag} onClear={() => setActiveTag("")}>
                      {(close) => <FilterOptions value={activeTag}
                        onPick={(v) => { setActiveTag(v); close(); }}
                        options={[{ value: "", label: "全部标签" },
                          ...allTags.map((tag) => ({ value: tag, label: tag }))]} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("state")}
                  className="h-11 w-32 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <button type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("state")}>
                      状态<SortMark active={sort?.key === "state"} dir={sort?.dir} />
                    </button>
                    <HeaderFilter label="状态" active={!!stateFilter} onClear={() => setStateFilter("")}>
                      {(close) => <FilterOptions value={stateFilter}
                        onPick={(v) => {
                          setStateFilter(v as EnvironmentView["probe"]["state"] | "");
                          close();
                        }}
                        options={[{ value: "", label: "全部状态" },
                          { value: "ok", label: "正常" },
                          { value: "failed", label: "异常" },
                          { value: "unverified", label: "未验证" }]} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("updated_by")}
                  className="h-11 w-32 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <button type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("updated_by")}>
                      更新人<SortMark active={sort?.key === "updated_by"} dir={sort?.dir} />
                    </button>
                    <HeaderFilter label="更新人" active={!!updaterFilter}
                      onClear={() => setUpdaterFilter("")}>
                      {(close) => <FilterOptions value={updaterFilter}
                        onPick={(v) => { setUpdaterFilter(v); close(); }}
                        options={[{ value: "", label: "全部更新人" },
                          ...allUpdaters.map((account) => ({
                            value: account, label: nameOf(account),
                          }))]} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                <TableHead aria-sort={ariaSortOf("updated_at")}
                  className="h-11 w-44 bg-muted/50 px-4 text-xs font-semibold text-muted-foreground">
                  <button type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("updated_at")}>
                    更新时间<SortMark active={sort?.key === "updated_at"} dir={sort?.dir} />
                  </button>
                </TableHead>
                <TableHead className="h-11 w-48 bg-muted/50 px-4 text-right text-xs font-semibold text-muted-foreground">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.slice((currentPage - 1) * 10, currentPage * 10).map((entry) => <TableRow key={entry.id}
                data-environment-id={entry.id}
                className="border-line hover:bg-muted/30">
                <TableCell className="px-4 py-3 font-medium">{entry.ip}</TableCell>
                <TableCell className="px-4 py-3">{ENVIRONMENT_FORM_TEXT[entry.form] ?? entry.form}</TableCell>
                <TableCell className="px-4 py-3 tabular-nums text-muted-foreground">{entry.port}</TableCell>
                <TableCell className="px-4 py-3">
                  {entry.tags.length
                    ? <div className="flex flex-wrap gap-1">
                      {entry.tags.map((tag) => <Badge
                        key={tag}
                        variant={tag === activeTag ? "default" : "secondary"}
                        render={
                          <button type="button" className="cursor-pointer"
                            title={`筛选标签 ${tag}`}
                            aria-pressed={tag === activeTag}
                            onClick={() => setActiveTag(tag === activeTag ? "" : tag)}>
                            {tag}
                          </button>
                        } />)}
                    </div>
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="px-4 py-3">
                  <ProbeStateCell probe={entry.probe} />
                </TableCell>
                <TableCell className="px-4 py-3"><PersonName account={entry.updated_by} /></TableCell>
                <TableCell className="px-4 py-3 tabular-nums text-muted-foreground">{formatLocalDateTime(entry.updated_at)}</TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm"
                      disabled={probingId === entry.id}
                      onClick={() => void probeRow(entry)}>
                      {probingId === entry.id
                        ? <Loader2 data-icon="inline-start" aria-hidden className="animate-spin" />
                        : <Activity data-icon="inline-start" aria-hidden />}
                      {probingId === entry.id ? "探活中…" : "探活"}
                    </Button>
                    <Button variant="ghost" size="icon-sm" title={`编辑 ${entry.ip}`}
                      aria-label={`编辑 ${entry.ip}`}
                      onClick={() => setEditor({ existing: entry })}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title={`删除 ${entry.ip}`}
                      aria-label={`删除 ${entry.ip}`}
                      className="text-destructive hover:text-destructive"
                      onClick={() => void removeEnvironment(entry)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>)}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t border-line p-4 text-sm">
            <span>共 {visible.length} 项 · 每页 10 项</span>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</Button>
              <span>{currentPage} / {pages}</span>
              <Button variant="outline" size="sm" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button>
            </div>
          </div>
        </div>}

    {editor && <EnvironmentEditorDialog
      key={editor.existing?.id ?? "create"}
      existing={editor.existing}
      environments={environments}
      onClose={() => setEditor(undefined)}
      onSaved={() => {
        setEditor(undefined);
        void refreshEnvironments();
      }}
      onProbed={applyProbeUpdate}
      onSwitchTo={(entry) => setEditor({ existing: entry })}
    />}
  </section>;
}
