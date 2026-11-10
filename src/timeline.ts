/**
 * 交付时间线(只读旁路):把现场文件读成"这单经历了什么"的人话。
 *
 * 数据源全部只读,且各自独立降级——时间线坏一行不能毁整页
 * (fail-open 红线):文件缺失、半行 JSON、字段缺失一律跳过该条,
 * 绝不抛错。它只呈现事实,不参与任何判定;阶段真相仍在
 * `.mae-flow.json`,证据判定仍在内核。
 *
 * 命令行版是 `harness/run-report.py`(markdown),这里是它的结构化
 * 兄弟:同样的事实,给页面看。
 *
 * 一处刻意的克制:内核的"步骤→阶段"映射不在这里复刻(CLAUDE.md
 * 红线:连阶段映射都不许抄第二份)。history 里有什么步骤就报什么
 * 步骤,人话在标题里,步骤代号原样示人——它本来就是面板上的词汇。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ExecutionEventReader } from "./executionEvents.ts";
import type { ExecutionEvent } from "./executionEvents.ts";
import { setImmediate } from "node:timers/promises";

export type TimelineTone = "info" | "attention" | "success" | "danger";

export interface TimelineEntry {
  /** 带时区的 ISO 时间。页面只按本地时区格式化，不再猜来源。 */
  ts: string;
  kind: "session" | "phase" | "ask" | "decision" | "agent" | "quality" | "memory";
  title: string;
  detail?: string;
  tone: TimelineTone;
}

const BARE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 历史语义事件的裸串来自 `toISOString()` 去掉 T/Z,实际是 UTC;
 * 内核 Python 的裸串来自 `time.strftime()`——写的是**执行进程所在
 * 时区**,所以 bareMeans 必须按写入方逐路判定,不能一刀切:
 * - history:新记录的 at_iso 自带时区;旧 at 按服务器本地时区兼容。
 *   容器可透传 TZ,不能假定一定是 UTC。无时区旧记录若跨时区迁移,
 *   必须按原写入环境恢复,无法仅凭裸串推断。
 * - 质量台账:宿主上的 dispatch 进程写入(hook_quality_execution),
 *   跟随服务器本地时区 → 按 local 补全。
 * 带 Z/偏移量的串直接解析,不再套用读取进程的时区。
 */
function normalizeTimestamp(
  value: unknown,
  bareMeans: "utc" | "local",
): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  const candidate = BARE_TIMESTAMP.test(raw)
    ? `${raw.replace(" ", "T")}${bareMeans === "utc" ? "Z" : ""}`
    : raw;
  const milliseconds = new Date(candidate).getTime();
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : raw;
}

function clip(value: unknown, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** JSONL 逐行解析:坏行跳过,不让半行毁掉整页。 */
function readJsonl(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const rows: Array<Record<string, any>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // 半行(写入方还在写)或损坏行:跳过,继续读后面的。
    }
  }
  return rows;
}

function readJson(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 代码工作区:调用方给了就用;没给就在任务工作区下找带
 * `.mae-flow.json` 的那一层(host 模式的克隆目录)。找不到就
 * 只出事件侧条目——没有内核现场不是错误,是流程还没走到 init。 */
function resolveCwd(workspace: string, cwd?: string): string | undefined {
  if (cwd && existsSync(join(cwd, ".mae-flow.json"))) return cwd;
  if (cwd && existsSync(cwd)) return cwd;
  try {
    for (const name of readdirSync(workspace)) {
      const candidate = join(workspace, name);
      if (!statSync(candidate).isDirectory()) continue;
      if (existsSync(join(candidate, ".mae-flow.json"))) return candidate;
    }
  } catch {
    // 工作区不可读:当作没有内核现场。
  }
  return undefined;
}

/** 语义事件 → 时间线条目。 */
function fromEvents(workspace: string, events = readJsonl(join(workspace, "events.jsonl"))): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  // 子 Agent 按 call_id 配对:派出与返回各是一条,配不上对的另说。
  const spawned = new Map<string, Record<string, any>>();
  const finished = new Set<string>();

  // 先扫一遍收口事件的位置:判断"没返回登记"是真丢了,还是还在跑。
  const closingIds: number[] = [];
  const rebuildIds: number[] = [];
  for (const event of events) {
    if (event.kind === "turn_finished" || event.kind === "session_ended") {
      closingIds.push(Number(event.eventId ?? 0));
    }
    if (event.kind === "session_started") {
      rebuildIds.push(Number(event.eventId ?? 0));
    }
  }
  const hasClosingAfter = (eventId: number) =>
    closingIds.some((id) => id > eventId);
  const rebuiltAfter = (eventId: number) =>
    rebuildIds.some((id) => id > eventId);

  for (const event of events) {
    const ts = normalizeTimestamp(event.ts, "utc");
    const payload = (event.payload ?? {}) as Record<string, any>;
    switch (event.kind) {
      case "session_started":
        entries.push({
          ts,
          kind: "session",
          title: payload.resume ? (payload.context_restored ? "恢复原会话上下文" : "依据现场重建会话") : "开始执行",
          detail: payload.resume
            ? (payload.context_restored
              ? `已恢复 ${Number(payload.restored_messages) || 0} 条上下文消息，继续未完成工作；已完成工具结果可复用。`
              : payload.recovery_reason || "原会话上下文不可用，依据已有文件、决定和流程事实恢复。")
            : undefined,
          tone: "info",
        });
        break;
      case "tool_requested": {
        if (payload.name !== "AskUserQuestion") break;
        const questions = (payload.input?.questions ?? []) as Array<
          Record<string, any>
        >;
        const first = clip(questions[0]?.question, 60) || "需要你确认";
        entries.push({
          ts,
          kind: "ask",
          title: `请你决定:${first}`,
          detail: questions.length > 1
            ? `本卡共 ${questions.length} 个问题`
            : undefined,
          tone: "attention",
        });
        break;
      }
      case "human_decision":
        entries.push({
          ts,
          kind: "decision",
          title: `你的决定:${clip(payload.decision, 60) || "(空)"}`,
          detail: payload.notes ? `备注:${clip(payload.notes, 80)}` : undefined,
          tone: "success",
        });
        break;
      case "agent_spawned": {
        const callId = String(payload.call_id ?? "");
        if (callId) spawned.set(callId, { ...payload, ts, eventId: event.eventId });
        break;
      }
      case "agent_finished": {
        const callId = String(payload.call_id ?? "");
        if (callId) finished.add(callId);
        const type = spawned.get(callId)?.agent_type;
        entries.push({
          ts,
          kind: "agent",
          title: `子 Agent 返回${type ? `:${clip(type, 24)}` : ""}`,
          detail: payload.lifecycle
            ? `生命周期 ${clip(payload.lifecycle, 20)}`
            : undefined,
          tone: "info",
        });
        break;
      }
      case "session_ended":
        if (payload.reason !== "failed") break;
        entries.push({
          ts,
          kind: "session",
          title: "会话中断",
          detail: clip(payload.detail ?? payload.reason, 80),
          tone: "danger",
        });
        break;
      default:
        break;
    }
  }

  // 派出条目补进去:已返回的正常,没返回的看回合是否已收口——
  // 收口后仍无返回登记就是真的丢了(run3 实锤的那类坑)。
  for (const [callId, payload] of spawned) {
    const returned = finished.has(callId);
    const stale = !returned && hasClosingAfter(Number(payload.eventId ?? 0));
    // "没有返回登记"要说清成因,不能只吓人:实测三条全是会话重建
    // (限流/重启)把在途子 Agent 带走——孩子随父会话一起没了,返回
    // 无处落地。这不是 agent 失职,别让人往那个方向猜。
    const takenByRebuild = stale && rebuiltAfter(Number(payload.eventId ?? 0));
    entries.push({
      ts: String(payload.ts ?? ""),
      kind: "agent",
      title: stale
        ? `子 Agent 没有返回登记:${clip(payload.agent_type, 24)}`
        : `派出子 Agent:${clip(payload.agent_type, 24)}`,
      detail: takenByRebuild
        ? "会话重建把在途子 Agent 带走了,返回不会再登记;已完成的工作仍在现场"
        : clip(payload.description, 80) || undefined,
      tone: stale ? "danger" : returned ? "info" : "attention",
    });
  }
  return entries;
}

/** 内核阶段轨迹:history 一步一条,外加当前停在哪。 */
function fromKernel(cwd: string): TimelineEntry[] {
  const state = readJson(join(cwd, ".mae-flow.json"));
  if (!state) return [];
  const entries: TimelineEntry[] = [];
  const history = Array.isArray(state.history) ? state.history : [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const step = clip(item.step, 40) || "?";
    const result = clip(item.result, 20);
    entries.push({
      // at_iso 为写入方记录的绝对时间;旧 at 保留本地时间兼容。
      ts: normalizeTimestamp(item.at_iso || item.at, "local"),
      kind: "phase",
      title: `完成步骤「${step}」`,
      detail: [result && `结果 ${result}`, clip(item.note, 60)]
        .filter(Boolean).join(" · ") || undefined,
      tone: result === "done" || !result ? "info" : "attention",
    });
  }
  return entries;
}

/** 质量台账:编译/UT/代码检查的真实执行与成败。 */
function fromQualityLedger(cwd: string): TimelineEntry[] {
  const ledger = readJson(join(cwd, ".mae-flow.json.quality-executions"));
  const rows = Array.isArray(ledger?.executions) ? ledger!.executions : [];
  const label: Record<string, string> = {
    COMPILE: "编译", UT: "单元测试", CODECHECK: "代码检查",
  };
  const entries: TimelineEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const kind = String(row.kind ?? "");
    const ok = row.succeeded === true;
    entries.push({
      // 台账由宿主 dispatch 进程写(非容器),裸串是服务器本地时区。
      ts: normalizeTimestamp(row.at, "local"),
      kind: "quality",
      title: `${label[kind] ?? kind}执行:${ok ? "成功" : "失败"}`,
      detail: [clip(row.step, 40) && `步骤 ${clip(row.step, 40)}`,
        clip(row.command, 80) || "(台账没记到命令)"]
        .filter(Boolean).join(" · "),
      tone: ok ? "success" : "danger",
    });
  }
  return entries;
}

/** 任务记忆足迹(memory-usage.jsonl):宿主推了什么、Agent 自己查了什么。
 * 与「这单用到的」同一数据源,这里只是把它排进时间轴。 */
function fromMemoryUsage(workspace: string): TimelineEntry[] {
  const rows = readJsonl(join(workspace, "memory-usage.jsonl"));
  const entries: TimelineEntry[] = [];
  for (const row of rows) {
    const ids = Array.isArray(row.ids) ? row.ids.map(String) : [];
    const count = ids.length;
    const moment = String(row.moment ?? "");
    let title = "";
    let detail: string | undefined;
    switch (moment) {
      case "context":
        title = row.status === "unavailable" ? "记忆检索暂不可用，任务继续" : `本轮提供 ${count} 条相关记忆`;
        detail = clip(row.query, 80) || undefined;
        break;
      case "launch":
        title = `开局推送 ${count} 条任务记忆`;
        break;
      case "phase":
        title = `进入「${clip(row.phase, 20)}」推送 ${count} 条记忆`;
        break;
      case "edit":
        title = row.digest
          ? `首改 ${clip(row.dir, 40) || "仓库根"} 目录:推送目录摘要(${count} 条)`
          : `首改 ${clip(row.dir, 40) || "仓库根"} 目录:提醒 ${count} 条记忆`;
        break;
      case "search":
        title = `Agent 检索记忆:命中 ${count} 条`;
        detail = clip(row.query, 80) || undefined;
        break;
      case "expand":
        title = "Agent 展开记忆全文";
        detail = ids.join(", ") || undefined;
        break;
      default:
        continue;
    }
    entries.push({
      ts: normalizeTimestamp(row.ts, "utc"),
      kind: "memory",
      title,
      detail: detail ?? (ids.length ? ids.slice(0, 4).join(", ") : undefined),
      tone: "info",
    });
  }
  return entries;
}

/**
 * 读一个任务现场,产出按时间正序的人话时间线。
 * 任何一路数据源出问题都只让那一路缺席,整体永远返回数组。
 */
export function buildTimeline(
  workspace: string,
  cwd?: string,
  events?: Array<Record<string, any>>,
  buildFixEvents?: ExecutionEvent[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const push = (source: () => TimelineEntry[]) => {
    try {
      entries.push(...source());
    } catch {
      // 单路数据源崩了不影响其他路——只读旁路不许把页面拖垮。
    }
  };
  push(() => fromEvents(workspace, events));
  push(() => (buildFixEvents ?? new ExecutionEventReader(workspace, true).read())
    .filter((event) => ["session_started", "turn_finished"].includes(event.kind))
    .map((event) => ({
      ts: normalizeTimestamp(event.ts, "utc"), kind: "session" as const, tone: "info" as const,
      title: `Build-Fix · 第 ${event.execution.round} 轮${event.kind === "session_started" ? "开始" : "Agent 收口"}`,
      detail: event.kind === "session_started" ? "开始编译、测试与必要修复；工具执行见 Build-Fix 过程与完整执行日志。"
        : "本轮 Agent 已结束执行，编译与测试是否通过以 Build-Fix 验证结果为准。",
    })));
  push(() => fromMemoryUsage(workspace));
  const codeDir = resolveCwd(workspace, cwd);
  if (codeDir) {
    push(() => fromKernel(codeDir));
    push(() => fromQualityLedger(codeDir));
  }
  // 有效时间都已规范成 ISO；异常/缺失时间沉到最后，不假装顺序。
  return entries.sort((left, right) => {
    if (!left.ts) return 1;
    if (!right.ts) return -1;
    const leftAt = new Date(left.ts).getTime();
    const rightAt = new Date(right.ts).getTime();
    if (!Number.isFinite(leftAt)) return 1;
    if (!Number.isFinite(rightAt)) return -1;
    return leftAt - rightAt;
  });
}

/** HTTP 已取得主日志的共享增量结果，构建历史也分块读，只留时间线需要的事件。 */
export async function buildTimelineAsync(workspace: string, cwd: string | undefined,
  events: Array<Record<string, any>>): Promise<TimelineEntry[]> {
  const reader = new ExecutionEventReader(workspace, true);
  const buildFixEvents: ExecutionEvent[] = [];
  try {
    do {
      buildFixEvents.push(...reader.read(256 * 1024)
        .filter(event => ["session_started", "turn_finished"].includes(event.kind)));
      await setImmediate();
    } while (reader.hasMore);
  } catch { /* 构建历史不可读时，其他时间线来源仍可显示。 */ }
  return buildTimeline(workspace, cwd, events, buildFixEvents);
}
