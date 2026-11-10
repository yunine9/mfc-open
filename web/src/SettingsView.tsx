/**
 * 服务设置(管理员页):运行参数、模型网关；部署基础设施只做自检。
 *
 * 两条纪律,和服务端 settings.ts 一体:
 * - 密钥只写不读:界面只见掩码(••••末4位),输入框永远从空白开始,
 *   留空=保持现状;所以"改一个键"由服务端按键合并,前端不回填明文。
 * - 生效边界如实告知:并发=下一次调度,修复轮/轮询=下一次红灯/轮询,
 *   模型=下一个新会话——不承诺"立刻"。
 */

import { useEffect, useState } from "react";
import {
  getBuildCacheStatus,
  getSettings,
  getSystemCheck,
  postModelsCheck,
  putExecutionPolicySettings,
  putModelsSettings,
  putRuntimeSettings,
  putVisionSettings,
  reclaimUnusedBuildCaches,
  testVisionCapability,
  type BuildCacheStatus,
  type SettingsView as Settings,
  type SystemCheckResult,
  type VisionProbeResult,
} from "./api";
import { confirmDialog } from "./ConfirmDialog";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Message = { kind: "success" | "error"; text: string } | null;

/** 字段排布:grid + 6px 间距;label/span 的灰字样式由使用处的工具类给。 */
const fieldWrapClass = "grid gap-1.5";

/** 部署自检/连通性结论徽标(#216 收编为 Badge;原 .check-summary 色板):
 * ok=success、warning=warning、error=destructive。 */
const CHECK_VARIANT = { ok: "success", warning: "warning", error: "destructive" } as const;

/** 表单消息钩子:设置页各卡与个人网关卡(PersonalModelsCard)共用。 */
export function useMessage(): [Message, (next: Message) => void] {
  const [message, setMessage] = useState<Message>(null);
  return [message, setMessage];
}

export function Feedback({ message }: { message: Message }) {
  if (!message) return null;
  return <div role="status" className={cn("col-span-full text-[13.5px]",
    message.kind === "success"
      ? "rounded-lg bg-success/10 px-[11px] py-[9px] text-success"
      : "rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger")}>
    {message.text}</div>;
}

/** 自检/连通性测试共用的结论网格:状态色 + 明细 + 建议一句话。
 *  个人网关卡(ADR-0068)的「测试连通」也复用同一套呈现。 */
export function CheckItems({ result }: { result: SystemCheckResult }) {
  return <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 min-[901px]:grid-cols-3">{result.items.map((item) => <article
    className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)] gap-[9px] rounded-[10px] border border-line bg-surface-2 p-3" key={item.key}>
    <span aria-hidden className={cn("grid size-[22px] place-items-center rounded-full text-[13px] font-extrabold",
      item.status === "ok" ? "bg-success/10 text-success"
        : item.status === "error" ? "bg-danger/10 text-danger" : "bg-attention/10 text-attention")}>
      {item.status === "ok" ? "✓" : item.status === "error" ? "!" : "·"}</span>
    <div className="grid min-w-0 gap-[3px]"><strong className="text-[13px] text-text-strong">{item.label}</strong>
      <p className="m-0 text-[13px] leading-[1.45] text-muted-foreground">{item.detail}</p>
      {item.suggestion && <small className="truncate whitespace-nowrap text-[13px] leading-[1.4] text-danger">{item.suggestion}</small>}</div>
  </article>)}</div>;
}

function SystemCheckCard({ onResult }: {
  onResult?: (result: SystemCheckResult | undefined, error?: string) => void;
}) {
  const [result, setResult] = useState<SystemCheckResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setError(""); onResult?.(undefined);
    try {
      const next = await getSystemCheck();
      setResult(next);
      onResult?.(next);
    }
    catch (cause) {
      const message = String((cause as Error).message ?? cause);
      setResult(undefined);
      setError(message);
      onResult?.(undefined, message);
    }
    finally { setBusy(false); }
  }

  useEffect(() => { void run(); }, []);
  const summary = result?.overall === "ok" ? "全部正常"
    : result?.overall === "error" ? "存在不可用项" : "可运行，但有待完善项";
  return <section id="settings-check" className="rounded-[14px] border border-line bg-surface p-[22px] shadow-xs"
    aria-labelledby="system-check-title">
    <div className="flex items-start justify-between gap-[18px]">
      <div><h2 id="system-check-title" className="mt-1.5 mb-1 text-[21px] text-text-strong">部署自检</h2><p className="m-0 text-[13px] text-muted-foreground">只读检查当前服务，不发送消息、不创建任务。</p></div>
      <div className="flex items-center gap-2.5">
        {result && <Badge variant={CHECK_VARIANT[result.overall]}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />{summary}
        </Badge>}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run()}>{busy ? "检查中…" : "重新检查"}</Button>
      </div>
    </div>
    {error && <div className="rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger">{error}</div>}
    {!result && !error && <div className="text-sm text-muted-foreground">正在检查服务…</div>}
    {result && <CheckItems result={result} />}
  </section>;
}

/** 数字项:显示当前覆盖值,空=使用页面给出的服务默认值。 */
function KnobField({ label, note, defaultText, value, onChange }: {
  label: string; note: string; defaultText: string;
  value: string; onChange: (next: string) => void;
}) {
  return <label className={fieldWrapClass}>
    <span className="flex items-center justify-between gap-2.5"><span>{label}</span><em className="rounded-full bg-primary/10 px-[7px] py-0.5 text-[13px] font-bold not-italic text-primary">默认 {defaultText}</em></span>
    <Input inputMode="numeric" value={value} placeholder={`使用默认值：${defaultText}`}
      onChange={(event) => onChange(event.target.value)} />
    <small className="text-[13px] leading-normal text-muted-foreground">留空即使用默认值 · {note}</small>
  </label>;
}

function RuntimeCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const runtime = view.runtime;
  const defaults = view.defaults.runtime;
  const text = (value?: number) => value === undefined ? "" : String(value);
  const [concurrent, setConcurrent] = useState(text(runtime.max_concurrent));
  const [issueTurns, setIssueTurns] = useState(text(runtime.issue_max_turns));
  const [issueWarmup, setIssueWarmup] = useState(
    (runtime.issue_warmup_enabled ?? defaults.issue_warmup_enabled) === 1);
  const [repoReclaim, setRepoReclaim] = useState(text(runtime.issue_repo_reclaim));
  const [productsCooldown, setProductsCooldown] = useState(
    text(runtime.issue_build_products_cooldown_hours));
  const [repair, setRepair] = useState(text(runtime.repair_rounds));
  const [watchdog, setWatchdog] = useState(
    text(runtime.env_verify_watchdog_minutes));
  const [autoClaim, setAutoClaim] = useState(
    text(runtime.issue_auto_claim_interval_s));
  const [interval, setInterval_] = useState(text(runtime.poll_interval_s));
  const [timeout_, setTimeout_] = useState(text(runtime.poll_timeout_s));
  const [retention, setRetention] = useState(
    text(runtime.workspace_retention_days));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();
  const timeoutDefault = defaults.poll_timeout_s >= 60
    && defaults.poll_timeout_s % 60 === 0
    ? `${defaults.poll_timeout_s} 秒（${defaults.poll_timeout_s / 60} 分钟）`
    : `${defaults.poll_timeout_s} 秒`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putRuntimeSettings({
        max_concurrent: concurrent.trim(),
        issue_max_turns: issueTurns.trim(),
        issue_warmup_enabled: issueWarmup ? 1 : 0,
        issue_repo_reclaim: repoReclaim.trim(),
        issue_build_products_cooldown_hours: productsCooldown.trim(),
        repair_rounds: repair.trim(),
        env_verify_watchdog_minutes: watchdog.trim(),
        issue_auto_claim_interval_s: autoClaim.trim(),
        poll_interval_s: interval.trim(),
        poll_timeout_s: timeout_.trim(),
        workspace_retention_days: retention.trim(),
      }));
      setMessage({ kind: "success", text: "已保存；留空项继续使用页面标注的默认值。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div id="settings-runtime" className="grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
    <div className="bg-surface-2 p-7 text-muted-foreground">
      <h2 className="mb-2 text-[17px] font-bold text-text-strong">运行参数</h2>
      <p className="m-0 text-sm leading-[1.7]">这里调整全团队需求任务与问题单的运行节奏。每项都明确显示当前服务默认值；
        数值项留空即可恢复默认，无需了解部署命令。</p>
    </div>
    <form className="grid content-start gap-[15px] p-[26px] sm:grid-cols-2" onSubmit={submit}>
      <KnobField label="并发任务数" defaultText={`${defaults.max_concurrent} 个`}
        note="生效于下一次调度决策"
        value={concurrent} onChange={setConcurrent} />
      <KnobField label="问题单并发数" defaultText={`${defaults.issue_max_turns} 个`}
        note="同时推进的问题会话回合上限，改完即生效"
        value={issueTurns} onChange={setIssueTurns} />
      <div className="col-span-full rounded-lg border border-line bg-surface-2 p-4">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="issue-warmup-enabled" className="font-medium text-text-strong">问题单环境预热
            <span className="ml-2 text-[13px] font-normal text-muted-foreground">默认{defaults.issue_warmup_enabled === 1 ? "开启" : "关闭"}</span>
          </label>
          <div className="flex shrink-0 items-center gap-2 text-sm">
            <span>{issueWarmup ? "已开启" : "已关闭"}</span>
            <Switch id="issue-warmup-enabled" checked={issueWarmup} disabled={busy}
              aria-describedby="issue-warmup-note" onCheckedChange={setIssueWarmup} />
          </div>
        </div>
        <p id="issue-warmup-note" className="mb-0 mt-2 text-[13px] leading-normal text-muted-foreground">关闭时由 Agent 按需编译；开启后，进入分析阶段会在后台执行首次编译。保存后影响后续预热，正在执行的任务继续运行。</p>
      </div>
      <KnobField label="问题单现场回收"
        defaultText={defaults.issue_repo_reclaim === 0 ? "保留现场" : "开启"}
        note="取消/归档的问题单立即回收代码现场（repo），分析报告与过程记录保留；0 表示保留现场不回收"
        value={repoReclaim} onChange={setRepoReclaim} />
      <KnobField label="编译产物保留时间（小时）"
        defaultText={defaults.issue_build_products_cooldown_hours === 0
          ? "关闭" : `${defaults.issue_build_products_cooldown_hours} 小时`}
        note="从最后一次使用结束开始计算；闲置或等待的会话超过该时长后清理编译产物，源码、依赖与报告保留。下一轮清理生效；0 表示关闭"
        value={productsCooldown} onChange={setProductsCooldown} />
      <KnobField label="自动修复轮数上限"
        defaultText={defaults.repair_rounds === null ? "不限轮" : `${defaults.repair_rounds} 轮`}
        note="0 表示关闭自动修复；生效于下一次流水线失败"
        value={repair} onChange={setRepair} />
      <KnobField label="验证卡守闸阈值（分钟）"
        defaultText={`${defaults.env_verify_watchdog_minutes} 分钟`}
        note="MR 全绿收口后超过该时长仍没有环境验证卡,平台主动提醒归属人(防静默漏卡,不举卡);0 表示关闭"
        value={watchdog} onChange={setWatchdog} />
      <KnobField label="自动接单扫描间隔（秒）"
        defaultText={defaults.issue_auto_claim_interval_s === 0
          ? "暂停" : `${defaults.issue_auto_claim_interval_s} 秒（${defaults.issue_auto_claim_interval_s / 60} 分钟）`}
        note="定时扫描已开启自动接单（开关在个人设置）的责任人名下的新问题单并发起（参与版本在配置中心勾选）；0 表示暂停，各人的开关原样保留，恢复间隔即续"
        value={autoClaim} onChange={setAutoClaim} />
      <KnobField label="流水线检查间隔（秒）" defaultText={`${defaults.poll_interval_s} 秒`}
        note="生效于下一轮检查"
        value={interval} onChange={setInterval_} />
      <KnobField label="流水线最长等待（秒）" defaultText={timeoutDefault}
        note="单轮监看的初始预算：到点先自动延期一次（最长约 2 倍）再停止等待并提示人工介入"
        value={timeout_} onChange={setTimeout_} />
      {/* 回收是不可逆动作,note 必须把"删什么、留什么"说全——
          光写"保留期"会让人以为整单历史都没了。 */}
      <KnobField label="现场保留期（天）"
        defaultText={defaults.workspace_retention_days === 0
          ? "永不回收" : `${defaults.workspace_retention_days} 天`}
        note="需求任务：已完成或取消的过期后回收代码和临时目录；失败任务保留供恢复，文档、图片与历史记录保留。问题会话：归档或取消当场清理（只留状态台账、报告、附件、截图、日志等记录），不看本天数，本天数只管附件中转目录孤儿文件的清理。0 关闭全部回收"
        value={retention} onChange={setRetention} />
      <Button type="submit" disabled={busy} className="col-span-full sm:col-span-1">{busy ? "正在保存…" : "保存运行参数"}</Button>
      <Feedback message={message} />
    </form>
  </div>;
}

function ExecutionPolicyCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const [blocks, setBlocks] = useState((view.execution_policy.blocked_repository_resources ?? []).join("\n"));
  const [instructions, setInstructions] = useState(
    view.execution_policy.team_instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putExecutionPolicySettings({
        team_instructions: instructions.trim(),
        blocked_repository_resources: blocks.split("\n").map(value => value.trim()).filter(Boolean),
      }));
      setMessage({
        kind: "success",
        text: "设置已保存。团队约定用于新任务；资源屏蔽在下次会话启动或恢复时生效，已运行的会话需重启。",
      });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div id="settings-policy"
    className="grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
    <div className="bg-surface-2 p-7 text-muted-foreground">
      <h2 className="mb-2 text-[17px] font-bold text-text-strong">团队执行约定</h2>
      <p className="m-0 text-sm leading-[1.7]">把团队长期采用的关注点与协作习惯叠加在平台默认方案上。每个新任务都会固定当时版本，并在“执行方案”里说明来源。</p>
    </div>
    <form className="grid content-start gap-[15px] p-[26px]"
      onSubmit={submit}>
      <label className={cn(fieldWrapClass, "relative")}>
        <span className="text-[13px] font-medium text-muted-foreground">新任务默认补充</span>
        <Textarea rows={7} maxLength={2000} className="min-h-[138px]" value={instructions}
          placeholder="例如：涉及存量接口时先核对兼容性；不确定的外部行为明确说明，不要猜；公共契约变更必须点名影响方。"
          onChange={(event) => setInstructions(event.target.value)} />
        <small className="text-[13px] leading-normal text-muted-foreground">
          只调整关注点、先后顺序和协作方式；不能覆盖阶段、真实证据、人工决定或 Git/交付权限。留空表示不设置团队补充。
        </small>
        <em className="absolute bottom-0 right-0.5 font-mono text-xs font-medium not-italic text-faint">{instructions.length}/2000</em>
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">屏蔽仓库 Skill 与指令文件</span>
        <Textarea rows={4} value={blocks} placeholder={".cac\nAGENTS.md\n.agents/skills/conflicting-skill"}
          onChange={event => setBlocks(event.target.value)} />
        <small className="text-[13px] leading-normal text-muted-foreground">每行一个文件名或相对路径，目录包含全部子项；不支持通配符。统一作用于需求流和问题流，不删除仓库文件。留空表示不屏蔽。</small>
      </label>
      {/* 团队各阶段勾选增强已随 v1 退役(2026-08-29):想定制阶段
          结构请到「团队资产 → 工作流」建团队工作流。 */}
      <Button type="submit" disabled={busy}>
        {busy ? "正在保存…" : "保存设置"}
      </Button>
      <Feedback message={message} />
    </form>
  </div>;
}

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let at = 0;
  while (size >= 1024 && at < units.length - 1) { size /= 1024; at += 1; }
  return `${size >= 10 || at === 0 ? Math.round(size) : size.toFixed(1)} ${units[at]}`;
}

function BuildCacheCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const defaults = view.defaults.runtime;
  const runtime = view.runtime;
  const text = (value?: number) => value === undefined ? "" : String(value);
  const [retention, setRetention] = useState(
    text(runtime.build_cache_retention_days));
  const [maxGb, setMaxGb] = useState(text(runtime.build_cache_max_gb));
  const [status, setStatus] = useState<BuildCacheStatus>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [message, setMessage] = useMessage();

  async function refresh() {
    setLoading(true);
    try { setStatus(await getBuildCacheStatus()); }
    catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(null);
    try {
      const next = await putRuntimeSettings({
        build_cache_retention_days: retention.trim(),
        build_cache_max_gb: maxGb.trim(),
      });
      onSaved(next);
      setMessage({ kind: "success", text: "缓存策略已保存，下一轮每日回收按新策略执行。" });
      await refresh();
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setSaving(false); }
  }

  async function clearUnused() {
    if (!await confirmDialog({
      title: "清理构建缓存",
      message: "将清理当前未被任务或容器占用的全部构建缓存。"
        + "后续任务仍可重新生成，但第一次编译会变慢；运行中的缓存不会被触碰。",
      confirmLabel: "清理",
    })) return;
    setReclaiming(true); setMessage(null);
    try {
      const result = await reclaimUnusedBuildCaches();
      setStatus(result.status);
      setMessage({ kind: result.failed.length ? "error" : "success",
        text: `已清理 ${result.reclaimed} 个仓库缓存，释放 ${bytes(result.freed_bytes)}`
          + (result.skipped_active ? `；${result.skipped_active} 个正在使用，已跳过` : "")
          + (result.failed.length ? `；${result.failed.length} 个清理失败` : "") });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setReclaiming(false); }
  }

  const effectiveRetention = status?.policy.retention_days
    ?? runtime.build_cache_retention_days ?? defaults.build_cache_retention_days;
  const effectiveMax = (status?.policy.max_bytes ??
    ((runtime.build_cache_max_gb ?? defaults.build_cache_max_gb) * 1024 ** 3));
  return <div id="settings-cache"
    className="grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
    <div className="bg-surface-2 p-7 text-muted-foreground">
      <h2 className="mb-2 text-[17px] font-bold text-text-strong">构建缓存</h2>
      <p>同一代码仓的后续任务会复用 Maven、npm、ccache 等缓存。任务删除不立即
        误删共享缓存；长期不用或超过容量上限时自动回收。</p>
      {loading && <span className="mt-3.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-attention/25 bg-attention/10 px-[9px] py-[5px] text-[13px] font-bold text-attention"><i aria-hidden className="size-1.5 rounded-full bg-current" />正在统计缓存…</span>}
      {!loading && status && !status.configured && <span className="mt-3.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-attention/25 bg-attention/10 px-[9px] py-[5px] text-[13px] font-bold text-attention">
        <i aria-hidden className="size-1.5 rounded-full bg-current" />当前部署未启用统一构建缓存</span>}
      {!loading && status?.configured && <div className="mt-[18px] grid gap-1">
        <strong className="text-[25px] leading-[1.1] text-text-strong">{bytes(status.total_bytes)}</strong>
        <span className="text-[13.5px] text-muted-foreground">{status.caches} 个仓库分区 · {status.active} 个正在使用</span>
        <small className="text-[12.5px] leading-[1.5] text-faint">{effectiveRetention > 0 ? `${effectiveRetention} 天未用自动清理` : "不按时间清理"}
          {` · ${effectiveMax > 0 ? `总量上限 ${bytes(effectiveMax)}` : "不设容量上限"}`}</small>
      </div>}
      {status && status.entries.length > 0 && <details className="mt-4 text-[13px] text-muted-foreground">
        <summary className="w-fit cursor-pointer font-bold">查看缓存明细</summary>
        <div className="mt-2 max-h-[220px] overflow-auto border-t border-line/60">{status.entries.map((entry) => <div className="flex items-center justify-between gap-3 border-b border-line/50 py-[9px]" key={entry.key}>
          <span className="grid min-w-0 gap-0.5"><strong className="truncate text-[12.5px] text-text">{entry.repository_hint || entry.key}</strong>
            <small className="text-xs text-faint">最后使用 {new Date(entry.last_used_at).toLocaleString()}</small></span>
          <em className="shrink-0 text-xs font-bold not-italic text-primary">{entry.active ? "使用中" : bytes(entry.size_bytes)}</em>
        </div>)}</div>
      </details>}
    </div>
    <form className="grid content-start gap-[15px] p-[26px] sm:grid-cols-2" onSubmit={save}>
      <KnobField label="未使用保留期（天）"
        defaultText={`${defaults.build_cache_retention_days} 天`}
        note="从最后一次挂载使用起计算；0 表示不按时间自动清理"
        value={retention} onChange={setRetention} />
      <KnobField label="总容量上限（GB）"
        defaultText={`${defaults.build_cache_max_gb} GB`}
        note="超出后优先清最久未用的缓存；0 表示不限制"
        value={maxGb} onChange={setMaxGb} />
      <div className="col-span-full flex flex-wrap gap-2.5">
        <Button type="submit" disabled={saving || reclaiming}>
          {saving ? "正在保存…" : "保存缓存策略"}</Button>
        <Button type="button" variant="outline" disabled={loading || reclaiming || !status?.caches}
          onClick={() => void clearUnused()}>
          {reclaiming ? "正在清理…" : "清理未使用缓存"}</Button>
      </div>
      <small className="col-span-full text-[13px] leading-normal text-muted-foreground">手动清理也会保护运行中、等待继续执行的任务；
        只删除可重新生成的构建缓存，不删除代码、任务记录或交付证据。</small>
      <Feedback message={message} />
    </form>
  </div>;
}

function ModelsCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const models = view.models;
  const defaults = view.defaults.models;
  // 接口格式:已存配置 > 部署默认 > OpenAI Chat(用户拍板 2026-08-26)。
  // 部署用 --models 配了 anthropic 协议时,健康检查曾按 openai 回落
  // 打到 /chat/completions,同一配置假红(MFC-011)。
  const [apiFormat, setApiFormat] = useState(
    models.api ?? defaults.api ?? "openai-completions");
  const [url, setUrl] = useState(models.url ?? defaults.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(models.model ?? defaults.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();
  const [testing, setTesting] = useState(false);
  const [checkResult, setCheckResult] = useState<SystemCheckResult>();
  const [checkError, setCheckError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      onSaved(await putModelsSettings({
        url: url.trim(),
        api_key: apiKey.trim(),
        model: model.trim(),
        api: apiFormat,
      }));
      setApiKey("");
      setMessage({ kind: "success",
        text: "已保存；下一个新任务使用新配置，运行中的任务不受影响。可点「测试连通」验证。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  // 测的是当前表单值(未保存也能测);密钥留空时服务端沿用已存的,
  // 与保存的合并口径一致——界面永远不回填明文。
  async function runCheck() {
    setTesting(true); setCheckError(""); setCheckResult(undefined);
    try {
      setCheckResult(await postModelsCheck({
        url: url.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        api: apiFormat,
      }));
    } catch (cause) {
      setCheckError(String((cause as Error).message ?? cause));
    } finally { setTesting(false); }
  }

  return <div id="settings-models" className="grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
    <div className="bg-surface-2 p-7 text-muted-foreground">
      <h2 className="mb-2 text-[17px] font-bold text-text-strong">模型网关</h2>
      <p className="m-0 text-sm leading-[1.7]">团队需求任务统一使用这一套模型。只需填写网关地址、API Key 和模型名称；
        API Key 保存后不会回显明文。</p>
      <span className={cn("mt-3.5 inline-flex w-fit items-center gap-1.5 rounded-full border px-[9px] py-[5px] text-[13px] font-bold",
        models.configured || defaults.configured
          ? "border-success/25 bg-success/10 text-success"
          : "border-attention/25 bg-attention/10 text-attention")}>
        <i aria-hidden className="size-1.5 rounded-full bg-current" />{models.configured
          ? `已配置${models.key_hint ? ` · Key ${models.key_hint}` : ""}`
          : defaults.configured
            ? `使用服务默认配置${defaults.model ? ` · ${defaults.model}` : ""}`
            : "尚未配置"}
      </span>
    </div>
    <form className="grid content-start gap-[15px] p-[26px]" onSubmit={submit}>
      <label className={cn("col-span-full", fieldWrapClass)}>
        <span className="text-[13px] font-medium text-muted-foreground">模型网关地址</span>
        <Input value={url} type="url" required spellCheck={false}
          placeholder={apiFormat === "anthropic-messages"
            ? "例如：https://model-gateway.internal/api/anthropic"
            : "例如：https://model-gateway.internal/v1"}
          onChange={(event) => setUrl(event.target.value)} />
        <small className="text-[13px] leading-normal text-muted-foreground">
          {apiFormat === "anthropic-messages"
            ? "Anthropic Messages 兼容接口(请求发往 地址/v1/messages)。"
            : "OpenAI Chat 兼容接口(请求发往 地址/chat/completions)。"}
        </small>
      </label>
      <label className={cn("col-span-full", fieldWrapClass)}>
        <span className="text-[13px] font-medium text-muted-foreground">API Key</span>
        <Input value={apiKey} type="password" autoComplete="new-password"
          required={!models.configured}
          placeholder={models.configured
            ? `已保存 ${models.key_hint ?? "密钥"}，留空保持不变`
            : defaults.configured
              ? "覆盖服务默认配置时请输入新的 API Key"
              : "请输入模型网关 API Key"}
          onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">模型名称</span>
        <Input value={model} required spellCheck={false}
          placeholder="例如：glm-5.1"
          onChange={(event) => setModel(event.target.value)} />
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">接口格式</span>
        <Select value={apiFormat}
          items={[{ value: "openai-completions", label: "OpenAI Chat" }, { value: "anthropic-messages", label: "Anthropic" }]}
          onValueChange={(value) => setApiFormat(value ?? "openai-completions")}>
          <SelectTrigger className="w-full" aria-label="接口格式"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="openai-completions">OpenAI Chat</SelectItem>
              <SelectItem value="anthropic-messages">Anthropic</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <small className="text-[13px] leading-normal text-muted-foreground">按网关实际提供的接口协议选择</small>
      </label>
      <div className="col-span-full flex items-center gap-2.5">
        <Button type="submit" disabled={busy || testing}>
          {busy ? "正在保存…" : "保存模型配置"}</Button>
        <Button type="button" variant="outline" disabled={busy || testing} onClick={() => void runCheck()}>
          {testing ? "测试中…" : "测试连通"}</Button>
      </div>
      <small className="text-[13px] leading-normal text-muted-foreground">测试使用当前表单值向网关发送一条极小请求（密钥留空时沿用已保存的）。</small>
      <Feedback message={message} />
      {checkError && <div className="rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger">{checkError}</div>}
      {testing && !checkResult && !checkError
        && <div className="text-sm text-muted-foreground">正在连通网关并等待模型回复…</div>}
      {checkResult && <>
        <Badge variant={CHECK_VARIANT[checkResult.overall]}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
          {checkResult.overall === "ok"
            ? "网络与模型问答均正常" : "存在问题，见下方明细"}
        </Badge>
        <CheckItems result={checkResult} />
      </>}
    </form>
  </div>;
}

function VisionModelsCard({ view, onSaved }: {
  view: Settings; onSaved: (next: Settings) => void;
}) {
  const vision = view.models.vision;
  const defaults = view.defaults.models.vision;
  const savedUrl = vision.url ?? defaults.url ?? "";
  const savedModel = vision.model ?? defaults.model ?? "";
  const savedApi = vision.api ?? defaults.api ?? "openai-completions";
  const [url, setUrl] = useState(savedUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(savedModel);
  const [api, setApi] = useState(savedApi);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useMessage();
  const [probe, setProbe] = useState<VisionProbeResult>();
  const configured = vision.configured || defaults.configured;
  const dirty = url.trim() !== savedUrl || model.trim() !== savedModel
    || api !== savedApi || !!apiKey.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(null); setProbe(undefined);
    try {
      onSaved(await putVisionSettings({
        url: url.trim(),
        api_key: apiKey.trim(),
        model: model.trim(),
        api,
      }));
      setApiKey("");
      setMessage({ kind: "success",
        text: "图片识别配置已保存。请点击“测试识图能力”验证真实调用。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setMessage(null); setProbe(undefined);
    try { setProbe(await testVisionCapability()); }
    catch (error) {
      setProbe({ status: "failed", provider: "", model: "", latency_ms: 0,
        error: String((error as Error).message ?? error) });
    } finally { setTesting(false); }
  }

  return <div id="settings-vision"
    className="grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
    <div className="bg-surface-2 p-7 text-muted-foreground">
      <h2 className="mb-2 text-[17px] font-bold text-text-strong">图片识别</h2>
      <p className="m-0 text-sm leading-[1.7]">主 Agent 需要看截图、图表或照片时，才会调用独立的 InspectImage
        工具。主会话模型不会被替换，图片原文也不会写入任务记录。</p>
      <span className={cn("mt-3.5 inline-flex w-fit items-center gap-1.5 rounded-full border px-[9px] py-[5px] text-[13px] font-bold",
        configured ? "border-success/25 bg-success/10 text-success" : "border-attention/25 bg-attention/10 text-attention")}>
        <i aria-hidden className="size-1.5 rounded-full bg-current" />{vision.configured
          ? `已配置${vision.key_hint ? ` · Key ${vision.key_hint}` : ""}`
          : defaults.configured
            ? `使用服务默认配置${defaults.model ? ` · ${defaults.model}` : ""}`
            : "尚未配置"}
      </span>
    </div>
    <form className="grid content-start gap-[15px] p-[26px]" onSubmit={submit}>
      <label className={cn("col-span-full", fieldWrapClass)}>
        <span className="text-[13px] font-medium text-muted-foreground">图片识别网关地址</span>
        <Input value={url} type="url" required spellCheck={false}
          placeholder="例如：https://qwen-vl.internal/v1"
          onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">接口协议</span>
        <Select value={api}
          items={[{ value: "openai-completions", label: "OpenAI Chat Completions" }, { value: "openai-responses", label: "OpenAI Responses" }, { value: "anthropic-messages", label: "Anthropic Messages" }]}
          onValueChange={(value) => setApi(value ?? "openai-completions")}>
          <SelectTrigger className="w-full" aria-label="接口协议"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
              <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
              <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">模型名称</span>
        <Input value={model} required spellCheck={false}
          placeholder="例如：qwen2.5-vl-72b-instruct"
          onChange={(event) => setModel(event.target.value)} />
      </label>
      <label className={cn("col-span-full", fieldWrapClass)}>
        <span className="text-[13px] font-medium text-muted-foreground">API Key</span>
        <Input value={apiKey} type="password" autoComplete="new-password"
          required={!configured}
          placeholder={vision.configured
            ? `已保存 ${vision.key_hint ?? "密钥"}，留空保持不变`
            : defaults.configured
              ? "覆盖服务默认配置时请输入新的 API Key"
              : "请输入图片识别网关 API Key"}
          onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <div className="col-span-full flex flex-wrap gap-2.5">
        <Button type="submit" disabled={saving || testing}>
          {saving ? "正在保存…" : "保存图片识别配置"}</Button>
        <Button type="button" variant="outline"
          disabled={!configured || dirty || saving || testing}
          onClick={() => void test()}>
          {testing ? "正在识别测试图…" : dirty ? "请先保存再测试" : "测试识图能力"}</Button>
      </div>
      {!configured && <small className="col-span-full -mt-[7px] text-[13px] text-faint">
        保存配置后即可进行真实测试。</small>}
      <Feedback message={message} />
      {probe && <div role="status" className={cn("col-span-full grid gap-1 rounded-[9px] border px-[13px] py-[11px] text-[13.5px]",
        probe.status === "ready" ? "border-success/30 bg-success/10 text-success"
          : probe.status === "failed" ? "border-danger/30 bg-danger/10 text-danger"
            : "border-line bg-surface-2 text-muted-foreground")}>
        <strong>{probe.status === "ready" ? "识图能力已就绪" : "识图测试未通过"}</strong>
        <span className="[overflow-wrap:anywhere] leading-[1.55]">{probe.status === "ready"
          ? `${probe.provider}/${probe.model} · ${probe.latency_ms} ms`
          : probe.error ?? "未知错误"}</span>
        {probe.response && <details className="mt-0.5">
          <summary className="w-fit cursor-pointer font-bold">查看模型观察</summary>
          <small className="mt-[7px] block whitespace-pre-wrap">{probe.response}</small>
        </details>}
      </div>}
    </form>
  </div>;
}

function SettingsOverview({ view, check, checkError }: {
  view: Settings;
  check?: SystemCheckResult;
  checkError?: string;
}) {
  const runtime = view.runtime;
  const defaults = view.defaults.runtime;
  const mainModel = view.models.model ?? view.defaults.models.model;
  const visionModel = view.models.vision.model
    ?? view.defaults.models.vision.model;
  const workspaceDays = runtime.workspace_retention_days
    ?? defaults.workspace_retention_days;
  const cacheDays = runtime.build_cache_retention_days
    ?? defaults.build_cache_retention_days;
  const cacheGb = runtime.build_cache_max_gb ?? defaults.build_cache_max_gb;
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({
    behavior: "smooth", block: "start",
  });
  const checkLabel = checkError ? "检查失败"
    : check?.overall === "ok" ? "全部正常"
    : check?.overall === "error" ? "存在不可用项"
      : check?.overall === "warning" ? "有待完善项" : "正在检查";
  return <section className="rounded-[14px] border border-line bg-surface p-[22px] shadow-xs" aria-labelledby="settings-overview-title">
    <header className="mb-3.5 flex items-end justify-between gap-5 max-[900px]:flex-col max-[900px]:items-start max-[900px]:gap-2">
      <div>
        <h2 id="settings-overview-title" className="mt-1 text-[22px] text-text-strong">服务设置总览</h2></div>
      <p className="m-0 text-[13px] text-muted-foreground">先看真实状态，再进入对应区域修改；密钥不会在总览或表单中回显。</p>
    </header>
    <div className="grid grid-cols-1 gap-2.5 min-[621px]:grid-cols-2 min-[901px]:grid-cols-4">
      <button type="button" onClick={() => go("settings-models")}
        className="grid min-h-[125px] min-w-0 cursor-pointer content-start gap-1.5 rounded-[11px] border border-line bg-surface-2 p-3.5 text-left text-text hover:border-primary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15">
        <span className="font-mono text-xs font-bold text-primary">01</span><strong className="text-[15px] text-text-strong">模型与图片识别</strong>
        <small className="text-xs leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">主模型 {mainModel ?? "未配置"} · 图片识别 {visionModel ?? "未配置"}</small>
        <em className="mt-auto text-xs font-bold not-italic text-primary">进入配置与测试能力</em>
      </button>
      <button type="button" onClick={() => go("settings-check")}
        className="grid min-h-[125px] min-w-0 cursor-pointer content-start gap-1.5 rounded-[11px] border border-line bg-surface-2 p-3.5 text-left text-text hover:border-primary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15">
        <span className="font-mono text-xs font-bold text-primary">02</span><strong className="text-[15px] text-text-strong">真实部署自检</strong>
        <small className="text-xs leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">{checkLabel}{check ? ` · ${check.items.length} 项检查` : ""}</small>
        <em className="mt-auto text-xs font-bold not-italic text-primary">查看真实检查结果</em>
      </button>
      <button type="button" onClick={() => go("settings-policy")}
        className="grid min-h-[125px] min-w-0 cursor-pointer content-start gap-1.5 rounded-[11px] border border-line bg-surface-2 p-3.5 text-left text-text hover:border-primary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15">
        <span className="font-mono text-xs font-bold text-primary">03</span><strong className="text-[15px] text-text-strong">团队统一约定</strong>
        <small className="text-xs leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">{view.execution_policy.team_instructions?.trim()
          ? "已设置团队约定" : "使用平台默认约定"}{` · ${view.execution_policy.blocked_repository_resources?.length ?? 0} 条资源屏蔽规则`}</small>
        <em className="mt-auto text-xs font-bold not-italic text-primary">进入团队约定</em>
      </button>
      <button type="button" onClick={() => go("settings-runtime")}
        className="grid min-h-[125px] min-w-0 cursor-pointer content-start gap-1.5 rounded-[11px] border border-line bg-surface-2 p-3.5 text-left text-text hover:border-primary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15">
        <span className="font-mono text-xs font-bold text-primary">04</span><strong className="text-[15px] text-text-strong">现场与构建缓存</strong>
        <small className="text-xs leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">任务现场 {workspaceDays === 0 ? "永不回收" : `${workspaceDays} 天`}
          {` · 缓存 ${cacheDays === 0 ? "不按时间清理" : `${cacheDays} 天`} / ${cacheGb === 0 ? "不限容量" : `${cacheGb} GB`}`}</small>
        <em className="mt-auto text-xs font-bold not-italic text-primary">进入保留与缓存策略</em>
      </button>
    </div>
  </section>;
}

export function SettingsBoard() {
  const [view, setView] = useState<Settings | null>(null);
  const [check, setCheck] = useState<SystemCheckResult>();
  const [checkError, setCheckError] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings().then(setView).catch((cause) =>
      setError(String((cause as Error).message ?? cause)));
  }, []);

  if (error) return <section className="grid gap-6">
    <div className="rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger">{error}</div></section>;
  if (!view) return <section className="grid gap-6">
    <div className="text-sm text-muted-foreground">正在读取设置…</div></section>;

  // 两张设置卡共享同一份视图:任一保存返回完整 view,整页跟着刷新,
  // 掩码提示(末4位)因此始终是服务端刚确认过的事实。
  return <section className="grid gap-6">
    <SettingsOverview view={view} check={check} checkError={checkError} />
    <SystemCheckCard onResult={(result, nextError = "") => {
      setCheck(result);
      setCheckError(nextError);
    }} />
    <ModelsCard key={`m${view.models.url}:${view.models.model}:${view.models.key_hint}`}
      view={view} onSaved={setView} />
    <VisionModelsCard
      key={`v${view.models.vision.url}:${view.models.vision.model}:${view.models.vision.key_hint}`}
      view={view} onSaved={setView} />
    <ExecutionPolicyCard
      key={`p${JSON.stringify(view.execution_policy)}`}
      view={view} onSaved={setView} />
    <RuntimeCard key={`r${JSON.stringify(view.runtime)}:${JSON.stringify(view.defaults.runtime)}`}
      view={view} onSaved={setView} />
    <BuildCacheCard view={view} onSaved={setView} />
  </section>;
}
