/**
 * 行为摘要(只读旁路):把语义事件流压成人看得过来的三样东西——
 * 「此刻在干嘛」一句话、分段折叠的行为账、值得看一眼的异常信号。
 *
 * 为什么在服务端做:原始 SSE 是给机器重放的,人盯不过来(用户原话
 * "一直在刷,看不过来");前端不做二次解读,只呈现这里算好的条目。
 * 为什么不碰内核:折叠的是宿主侧行为事实(读了哪些文件、跑了什么
 * 命令),不推断任何流程语义——阶段真相仍在 .mae-flow.json。
 *
 * 异常信号只陈述事实("同一命令连续失败 3 次"),不下"模型迷路了"
 * 的结论——误报比不报更坏,这条哲学与批注面板同款。
 *
 * 数据源只读且容错:事件日志坏一行跳一行(与 timeline.ts 同款),
 * 观测旁路绝不因半行 JSON 毁整页,更不许反过来影响事件落盘。
 */

import { existsSync, readFileSync } from "node:fs";

export type SegmentKind =
  | "read" | "edit" | "bash" | "tool" | "talk" | "agent" | "ask" | "steer";

export interface ActivitySegment {
  /** 段首/段尾时间(ISO)。单事件段两者相同。 */
  start: string;
  end: string;
  kind: SegmentKind;
  title: string;
  detail?: string;
  count: number;
  errors: number;
}

export interface ActivityAlert {
  kind: "repeat-failure" | "file-churn" | "reread-loop" | "gate-block" | "stall";
  title: string;
  detail?: string;
  /** 最近一次发生的时间(ISO)。 */
  ts: string;
}

export interface ActivityView {
  /** 此刻在干嘛的一句话;空串=没有可说的(任务已结束/尚无事件)。 */
  now: string;
  /** 当前动作开始的时间(ISO),配合前端显示"已持续多久"。 */
  now_since?: string;
  /** 时间正序;超长时只保留最近 MAX_SEGMENTS 段(truncated 置真)。 */
  segments: ActivitySegment[];
  alerts: ActivityAlert[];
  events_seen: number;
  truncated: boolean;
}

/** 折叠前的最小动作单元。 */
interface Atom {
  ts: string;
  ms: number;
  kind: SegmentKind;
  /** 归并主体:文件路径 / 命令文本 / agent 描述。 */
  subject: string;
  tool?: string;
  isError: boolean;
  /** 门禁打回(结果文本带 mae-flow 印记)单列,异常信号要点名。 */
  gateBlocked: boolean;
  text?: string;
}

const MAX_SEGMENTS = 150;
const WINDOW_MS = 30 * 60_000;
const CHURN_EDITS = 6;
const REREAD_COUNT = 6;
const GATE_BLOCKS = 2;
const FAILURE_STREAK = 3;
const STALL_IDLE_MS = 10 * 60_000;
const STALL_TOOL_MS = 30 * 60_000;
/** 说话类条目(模型说明、人捎的话)的保留长度。摘要要能读,不是标签。 */
const TALK_LIMIT = 400;

function clip(value: unknown, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function instant(ts: string): number {
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function pathOf(input: Record<string, unknown>): string {
  return String(input.file_path ?? input.path ?? "").trim();
}

/** 路径缩短:只留末两级,人认文件靠文件名和直属目录。 */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : "…/" + parts.slice(-2).join("/");
}

/** 命令抬头:抬头只有 60 字,得让这 60 字装的是"它到底跑了什么"。
 *
 * 三样噪声全是实测出来的(2026-08-22 拿 .pilot 真现场 520 条事件对拍):
 * 1. `cd 长路径 && ` / `cd "$(git rev-parse --show-toplevel)"; ` 前缀——
 *    整链试跑里模型上报 `mvn test`、实发 `cd /很长的路径 && mvn test`;
 * 2. `python3 "/Users/…/mae-flow/scripts/mae-flow.py" done` 这种内核调用,
 *    真正有信息的只有末尾那个子命令,前面的绝对路径把抬头全占了——
 *    真现场里连着七八段抬头一模一样,等于什么都没说;
 * 3. `; echo TEST_EXIT=$?` 尾巴。
 * 原文一律保留在 detail 里,这里删的只是显示,不是记录。 */
function commandHeadline(command: string): string {
  const stripped = String(command ?? "")
    .replace(/^\s*cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/, "")
    .replace(
      /\b(?:python3?|py)\s+(?:'[^']*'|"[^"]*"|\S+)mae-flow\.py(['"]?)/g,
      "mae-flow")
    .replace(/\s*;\s*echo\s+\S*EXIT\S*=\$\?\s*$/i, "");
  return clip(stripped || command, 60);
}

/** 一批路径的主导目录:一半以上在同一目录下才有资格说"为主"。 */
function dominantDir(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const cut = path.lastIndexOf("/");
    if (cut <= 0) continue;
    const dir = path.slice(0, cut + 1);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) { best = dir; bestCount = count; }
  }
  return bestCount * 2 > paths.length && paths.length > 2 ? best : "";
}

/** 事件 → 动作单元。返回 null 的事件不进摘要(会话边界等)。 */
function toAtom(event: Record<string, any>): Atom | null {
  const ts = String(event.ts ?? "");
  const ms = instant(ts);
  const payload = (event.payload ?? {}) as Record<string, any>;
  const kind = String(event.kind ?? "");
  if (kind === "tool_finished") {
    const tool = String(payload.name ?? "");
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const result = String(payload.result ?? "");
    const isError = payload.is_error === true;
    const base = {
      ts, ms, tool, isError,
      gateBlocked: isError && /mae-flow|门禁/.test(result),
    };
    if (tool === "Read") {
      return { ...base, kind: "read", subject: pathOf(input) };
    }
    if (tool === "Edit" || tool === "Write") {
      return { ...base, kind: "edit", subject: pathOf(input) };
    }
    if (tool === "Bash") {
      return { ...base, kind: "bash", subject: clip(input.command, 120) };
    }
    // 决定卡已经有 human_decision 那条账(还带着人选了什么),这里再记一条
    // 光秃秃的「调用 AskUserQuestion」就是同一件事记两遍。真现场里这两条
    // 永远连着出现,占两行、说一件事。
    if (tool === "AskUserQuestion") return null;
    return { ...base, kind: "tool", subject: tool };
  }
  if (kind === "assistant_message") {
    return {
      ts, ms, kind: "talk", subject: "", isError: false, gateBlocked: false,
      // 160 字砍掉的正是最该看的东西:模型解释"为什么这么改"通常三五百字,
      // 一刀下去只剩开场白,人当然觉得"很多省略"(用户 2026-08-22 原话)。
      text: clip(payload.text, TALK_LIMIT),
    };
  }
  // 人自己捎的话也是心流的一部分。以前它只在「顺便说一句」那个小框里,
  // 心流账上完全没有——于是"我下达了个指令"之后,时间线上看不出这句话
  // 存在过,更看不出它落在哪两个动作之间。
  if (kind === "user_message" && payload.via === "interrupt") {
    return {
      ts, ms, kind: "steer", subject: "", isError: false, gateBlocked: false,
      text: clip(payload.text, TALK_LIMIT),
    };
  }
  if (kind === "agent_spawned" || kind === "agent_finished") {
    // failed=模型层错误如实返回;interrupted=prompt 抛错或被掐断。两者都是
    // "没交出结果",心流上都该亮红。
    const failed = kind === "agent_finished"
      && ["failed", "interrupted"].includes(String(payload.lifecycle ?? ""));
    return {
      ts, ms, kind: "agent",
      subject: clip(payload.description ?? payload.agent_type ?? "子任务", 80),
      isError: failed, gateBlocked: false,
      text: kind === "agent_spawned" ? "派发" : "返回",
    };
  }
  if (kind === "human_decision") {
    return {
      ts, ms, kind: "ask",
      subject: clip(payload.decision, 80),
      isError: false, gateBlocked: false,
    };
  }
  return null;
}

function segmentTitle(kind: SegmentKind, atoms: Atom[]): {
  title: string; detail?: string;
} {
  const errors = atoms.filter((atom) => atom.isError).length;
  const failText = errors > 0 ? `,失败 ${errors} 次` : "";
  if (kind === "read") {
    const paths = [...new Set(atoms.map((a) => a.subject).filter(Boolean))];
    const dominant = dominantDir(paths);
    return {
      title: `阅读 ${paths.length} 个文件`
        + (dominant ? `(${dominant} 为主)` : "")
        + (atoms.length > paths.length ? `,共 ${atoms.length} 次` : ""),
      detail: paths.slice(0, 6).map(shortPath).join("、")
        + (paths.length > 6 ? ` 等 ${paths.length} 个` : ""),
    };
  }
  if (kind === "edit") {
    const perFile = new Map<string, number>();
    for (const atom of atoms) {
      perFile.set(atom.subject, (perFile.get(atom.subject) ?? 0) + 1);
    }
    const files = [...perFile.entries()];
    const title = files.length === 1
      ? `修改 ${shortPath(files[0][0])}(${files[0][1]} 处)${failText}`
      : `修改 ${files.length} 个文件,共 ${atoms.length} 处${failText}`;
    return {
      title,
      detail: files.length > 1
        ? files.slice(0, 6)
          .map(([file, count]) => `${shortPath(file)}×${count}`).join("、")
        : undefined,
    };
  }
  if (kind === "bash") {
    const commands = [...new Set(atoms.map((a) => a.subject))];
    const headline = commandHeadline(commands[0] ?? "");
    // 原来是光秃秃的"执行 5 条命令"——数量是这条账里最没用的信息,
    // 人想知道的是"它到底跑了什么"。抬头给真命令,数量退到后面。
    const title = atoms.length === 1
      ? `执行 ${headline}`
      : commands.length === 1
        ? `执行 ${headline},重复 ${atoms.length} 次`
        : `执行 ${headline} 等 ${commands.length} 条命令`;
    return {
      title: title + failText,
      detail: commands.slice(0, 4).map((cmd) => clip(cmd, 80)).join(" ⏎ "),
    };
  }
  if (kind === "talk") {
    // 不再合并(见 foldSegments),所以这里就是一条说明的原文。
    return { title: "Agent 说明", detail: atoms[atoms.length - 1].text };
  }
  if (kind === "steer") {
    return { title: "你捎了一句", detail: atoms[atoms.length - 1].text };
  }
  if (kind === "agent") {
    const last = atoms[atoms.length - 1];
    return {
      title: `子任务${last.text === "返回" ? "返回" : "派发"}${failText}`,
      detail: last.subject,
    };
  }
  if (kind === "ask") {
    const last = atoms[atoms.length - 1];
    return { title: "人工决定", detail: last.subject || undefined };
  }
  const tools = [...new Set(atoms.map((a) => a.subject))];
  return { title: `调用 ${tools.join("、")}${failText}` };
}

function foldSegments(atoms: Atom[]): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  let bucket: Atom[] = [];
  const close = () => {
    if (!bucket.length) return;
    const kind = bucket[0].kind;
    const { title, detail } = segmentTitle(kind, bucket);
    segments.push({
      start: bucket[0].ts,
      end: bucket[bucket.length - 1].ts,
      kind, title, detail,
      count: bucket.length,
      errors: bucket.filter((atom) => atom.isError).length,
    });
    bucket = [];
  };
  for (const atom of atoms) {
    // 说话类条目一条一段:合并只留最后一条,等于把中间说的话直接吞掉。
    // 动作类合并是压缩噪声(读 12 个文件不必列 12 行),说明合并是丢内容。
    if (bucket.length
        && (bucket[0].kind !== atom.kind
          || atom.kind === "talk" || atom.kind === "steer")) close();
    bucket.push(atom);
  }
  close();
  return segments;
}

/** 「此刻在干嘛」:悬着的工具调用最准;没有就报最后一个动作。 */
function nowLine(
  events: Array<Record<string, any>>,
  atoms: Atom[],
  now: number,
): { now: string; since?: string; pendingTool?: { tool: string; ms: number } } {
  const finished = new Set<string>();
  let pending: Record<string, any> | undefined;
  for (const event of events) {
    const kind = String(event.kind ?? "");
    const payload = (event.payload ?? {}) as Record<string, any>;
    if (kind === "tool_finished") finished.add(String(payload.call_id ?? ""));
    if (kind === "tool_requested") pending = event;
    if (kind === "session_ended") pending = undefined;
  }
  if (pending) {
    const payload = (pending.payload ?? {}) as Record<string, any>;
    if (!finished.has(String(payload.call_id ?? ""))) {
      const tool = String(payload.name ?? "");
      const input = (payload.input ?? {}) as Record<string, unknown>;
      const since = String(pending.ts ?? "");
      const verb = tool === "Read" ? `正在读 ${shortPath(pathOf(input))}`
        : tool === "Edit" || tool === "Write"
          ? `正在修改 ${shortPath(pathOf(input))}`
          : tool === "Bash" ? `正在执行命令:${clip(input.command, 80)}`
            : `正在调用 ${tool}`;
      return {
        now: verb, since,
        pendingTool: { tool, ms: now - instant(since) },
      };
    }
  }
  const last = atoms[atoms.length - 1];
  if (!last) return { now: "" };
  const label: Record<SegmentKind, string> = {
    read: `刚读完 ${shortPath(last.subject)}`,
    edit: `刚修改了 ${shortPath(last.subject)}`,
    bash: `刚执行完命令:${clip(last.subject, 60)}`,
    tool: `刚调用了 ${last.subject}`,
    talk: "刚输出了一段说明",
    agent: last.text === "返回" ? "子任务刚返回" : "刚派发了子任务",
    ask: "刚收到人工决定",
    steer: "刚收到你捎的话",
  };
  return { now: label[last.kind], since: last.ts };
}

/** 异常信号:全部是事实陈述 + 明确阈值,不下结论。 */
function detectAlerts(
  atoms: Atom[],
  options: { now: number; running: boolean;
    pendingTool?: { tool: string; ms: number } },
): ActivityAlert[] {
  const alerts: ActivityAlert[] = [];
  const { now, running } = options;

  // 1. 同一主体连续失败:命令也好文件也好,连撞三次墙值得人看一眼。
  let streakSubject = "";
  let streak = 0;
  let reported = new Set<string>();
  for (const atom of atoms) {
    if (atom.kind !== "bash" && atom.kind !== "edit") continue;
    if (atom.isError && atom.subject === streakSubject) {
      streak += 1;
    } else if (atom.isError) {
      streakSubject = atom.subject;
      streak = 1;
    } else if (atom.subject === streakSubject) {
      streakSubject = "";
      streak = 0;
    }
    if (streak >= FAILURE_STREAK && !reported.has(streakSubject)) {
      reported.add(streakSubject);
      alerts.push({
        kind: "repeat-failure",
        title: `同一${atom.kind === "bash" ? "命令" : "文件写入"}连续失败 ${streak} 次`,
        detail: clip(streakSubject, 100),
        ts: atom.ts,
      });
    }
  }

  // 2/3/4. 最近 30 分钟窗口内的打转迹象与门禁拦截。
  const windowStart = now - WINDOW_MS;
  const recent = atoms.filter((atom) => atom.ms >= windowStart);
  const editCounts = new Map<string, { count: number; ts: string }>();
  const readCounts = new Map<string, { count: number; ts: string }>();
  let gateBlocks = 0;
  let gateTs = "";
  for (const atom of recent) {
    if (atom.gateBlocked) { gateBlocks += 1; gateTs = atom.ts; }
    const bucket = atom.kind === "edit" ? editCounts
      : atom.kind === "read" ? readCounts : null;
    if (!bucket || !atom.subject) continue;
    const entry = bucket.get(atom.subject) ?? { count: 0, ts: atom.ts };
    entry.count += 1;
    entry.ts = atom.ts;
    bucket.set(atom.subject, entry);
  }
  for (const [file, entry] of editCounts) {
    if (entry.count >= CHURN_EDITS) {
      alerts.push({
        kind: "file-churn",
        title: `30 分钟内对同一文件改了 ${entry.count} 次`,
        detail: shortPath(file), ts: entry.ts,
      });
    }
  }
  for (const [file, entry] of readCounts) {
    if (entry.count >= REREAD_COUNT) {
      alerts.push({
        kind: "reread-loop",
        title: `30 分钟内重读同一文件 ${entry.count} 次`,
        detail: shortPath(file), ts: entry.ts,
      });
    }
  }
  if (gateBlocks >= GATE_BLOCKS) {
    alerts.push({
      kind: "gate-block",
      title: `30 分钟内被门禁拦截 ${gateBlocks} 次`,
      detail: "反复撞闸通常是它在绕规则或没读指引,值得看一眼过程记录。",
      ts: gateTs,
    });
  }

  // 5. 卡壳:只对在跑的任务报;命令长跑与模型无动作分开说
  //    (mvn 编译十几分钟很正常,阈值必须不同)。
  if (running && atoms.length) {
    const idle = now - atoms[atoms.length - 1].ms;
    const pending = options.pendingTool;
    if (pending && pending.ms >= STALL_TOOL_MS) {
      alerts.push({
        kind: "stall",
        title: `一条${pending.tool === "Bash" ? "命令" : "工具调用"}已执行 `
          + `${Math.round(pending.ms / 60_000)} 分钟未返回`,
        ts: new Date(now).toISOString(),
      });
    } else if (!pending && idle >= STALL_IDLE_MS) {
      alerts.push({
        kind: "stall",
        title: `已 ${Math.round(idle / 60_000)} 分钟没有任何执行动作`,
        ts: new Date(now).toISOString(),
      });
    }
  }

  // 最近的在前,人先看最新的问题;同类刷屏也被这层截住。
  return alerts.sort((a, b) => instant(b.ts) - instant(a.ts)).slice(0, 6);
}

export function buildActivity(
  events: Array<Record<string, any>>,
  options?: { now?: number; running?: boolean },
): ActivityView {
  const now = options?.now ?? Date.now();
  const running = options?.running ?? false;
  const atoms = events.map(toAtom).filter((atom): atom is Atom => !!atom);
  const all = foldSegments(atoms);
  const segments = all.slice(-MAX_SEGMENTS);
  const current = nowLine(events, atoms, now);
  return {
    now: running ? current.now : "",
    now_since: running ? current.since : undefined,
    segments,
    alerts: detectAlerts(atoms, {
      now, running, pendingTool: current.pendingTool,
    }),
    events_seen: events.length,
    truncated: all.length > segments.length,
  };
}

/** 容错读事件日志:坏行跳过(观测旁路,fail-open;EventLog.replay
 * 遇坏行整体抛错是对的——那是恢复重放的口径,不是这里的)。 */
export function readActivityEvents(
  path: string,
): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, any>> = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // 半行/坏行:摘要少一条动作,页面不塌。
    }
  }
  return rows;
}
