/**
 * 已结束任务过了保留期，只回收代码克隆和明确的临时运行目录。
 * 需求原文、修订、图片、Story、交付摘要及其他任务材料默认保留。
 * 仓内过程文档先保存到任务的 archived-documents，保存失败就不删代码。
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** 克隆被删之前,把内核阶段真相抄一份留档。
 *
 * 红线说"阶段真相只在工作区 .mae-flow.json"——那说的是**在跑的时候**谁
 * 说了算。回收之后原件已经不存在了,这份副本不构成第二个状态机,只是
 * 让两周后还答得上"这单最后停在哪一步"。名字里带 reclaimed,不许被当成
 * 活状态读。 */
export const KERNEL_STATE_SNAPSHOT = "kernel-state.reclaimed.json";

/** 文档副本保留原单号目录和文件名，现有文档读取与下载入口可以继续使用。 */
export const ARCHIVED_DOCUMENTS_DIR = "archived-documents";
const TEMPORARY_RUNTIME_DIRS = ["pi-agent", "requirement-review-agent"];

/** 失败任务仍可恢复，保留代码和会话；只有完成或明确取消才自动回收。 */
export const RECLAIMABLE_STATUS: readonly string[] = [
  "completed", "canceled",
];

export interface ReclaimCandidate {
  id: string;
  status: string;
  workspace: string;
  completed_at?: string;
  updated_at?: string;
  created_at?: string;
  workspace_reclaimed_at?: string;
}

export interface ReclaimVerdict {
  reclaim: boolean;
  /** 说人话的理由,直接进日志——回收是不可逆动作,得说清凭什么。 */
  reason: string;
}

const DAY_MS = 24 * 60 * 60_000;

function instant(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 判不判得回收(纯函数,好测)。
 *
 * @param busy 这单此刻还有活的会话/容器句柄。哪怕状态写着终态也不碰——
 *   状态是收口那一刻写的,清理进程和收尾流程可能正擦肩而过。
 */
export function judgeReclaim(
  task: ReclaimCandidate,
  options: { now: number; retentionDays: number; busy?: boolean },
): ReclaimVerdict {
  const { now, retentionDays } = options;
  if (!(retentionDays > 0)) {
    return { reclaim: false, reason: "保留期配置为 0,永不回收" };
  }
  if (task.workspace_reclaimed_at) {
    return { reclaim: false, reason: "已经回收过" };
  }
  if (!RECLAIMABLE_STATUS.includes(task.status)) {
    return {
      reclaim: false,
      reason: `状态 ${task.status} 不可自动回收(可能恢复、还等着人或流水线)`,
    };
  }
  if (options.busy) {
    return { reclaim: false, reason: "还有活的会话或容器句柄,不碰" };
  }
  // 时间锚:优先收口时刻,退到最后一次事实变更。两个都读不出来时**不回收**
  // ——判不了年纪就不许下手,宁可留着占地方,也不许猜着删。
  const settled = [task.completed_at, task.updated_at]
    .map(instant).find((ms) => !Number.isNaN(ms));
  if (settled === undefined) {
    return { reclaim: false, reason: "没有可信的收口时间,判不了年纪" };
  }
  const ageDays = (now - settled) / DAY_MS;
  if (ageDays < retentionDays) {
    return {
      reclaim: false,
      reason: `收口 ${ageDays.toFixed(1)} 天,未到保留期 ${retentionDays} 天`,
    };
  }
  return {
    reclaim: true,
    reason: `收口 ${ageDays.toFixed(1)} 天,超过保留期 ${retentionDays} 天`,
  };
}

function sizeOf(path: string): number {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of readdirSync(path)) total += sizeOf(join(path, name));
    return total;
  } catch {
    return 0;       // 量不出来不影响删,日志少个数字而已
  }
}

export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let at = 0;
  while (value >= 1024 && at < units.length - 1) { value /= 1024; at += 1; }
  return `${value >= 10 || at === 0 ? Math.round(value) : value.toFixed(1)}${units[at]}`;
}

export interface ReclaimResult {
  removed: string[];
  freed: number;
  /** 删之前把内核阶段真相抄下来了没有(抄不到不算失败:老单可能就没有)。 */
  snapshotted: boolean;
  /** 被边界拦下时的原因;有值 = 一个字节都没删。 */
  refused?: string;
}

/**
 * 删除前的边界闸:现场必须真的在本服务的 dataDir 底下。
 *
 * 这不是理论洁癖,是实测踩出来的(2026-08-22)。`summary.workspace` 是
 * 任务创建时写进 task.json 的**绝对路径**,而 `recover()` 是按
 * `dataDir/task-N` 扫目录认任务的——两者在正常情况下相等,但只要现场
 * 目录被**拷走或搬走**(备份、复制一份出来排障、换挂载点),恢复出来的
 * 任务就会带着老路径,而删除动作会照着老路径下手。
 *
 * 我自己就这么干了一次:把 .pilot 现场拷到临时目录跑回收验证,结果删的是
 * **原件**。读侧按老路径读只是读不到,删侧按老路径删是真没了。
 *
 * 所以这里 fail-closed:越界一律拒绝,不"尽力而为"。realpath 比对而不是
 * 字符串前缀比对——软链接能让字符串看着在里面、实际指到外面。
 */
export function withinDataDir(workspace: string, dataDir: string): boolean {
  try {
    const root = realpathSync(dataDir);
    const target = realpathSync(workspace);
    return target !== root && target.startsWith(root + sep);
  } catch {
    // 解不出真实路径(不存在/权限)就当越界:删除动作宁可不做。
    return false;
  }
}

/** 只回收明确的运行目录，不再删除“不在保留名单”的任意文件。 */
export function reclaimWorkspace(
  workspace: string,
  options: { cwd?: string; dataDir: string },
): ReclaimResult {
  const removed: string[] = [];
  let freed = 0;
  let snapshotted = false;

  // 边界先过。越界不是"少删一点",是**一个字节都不许删**。
  if (!withinDataDir(workspace, options.dataDir)) {
    return {
      removed, freed, snapshotted,
      refused: `现场 ${workspace} 不在本服务的数据目录 ${options.dataDir} 内,拒绝删除`,
    };
  }

  // 先抄内核阶段真相,再删克隆——顺序反了就永远抄不到了。
  const statePath = options.cwd ? join(options.cwd, ".mae-flow.json") : "";
  if (statePath && existsSync(statePath)) {
    try {
      writeFileSync(
        join(workspace, KERNEL_STATE_SNAPSHOT),
        readFileSync(statePath, "utf-8"));
      snapshotted = true;
    } catch {
      // 抄不下来就算了:少一份留档,不值得为它中止回收。
    }
  }

  const codeRoots = new Set<string>();
  try {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(workspace, entry.name);
      if ((entry.name === "repositories" || existsSync(join(path, ".git"))) && withinDataDir(path, workspace)) codeRoots.add(resolve(path));
    }
    if (options.cwd && withinDataDir(options.cwd, workspace)
      && (existsSync(join(options.cwd, ".git")) || resolve(options.cwd) === resolve(workspace, "repositories"))) codeRoots.add(resolve(options.cwd));

    // 主代码仓的文稿保留在副本根；多仓来源的文稿分别保存，避免同名文档覆盖。
    const sources = new Set(codeRoots);
    const repositories = join(workspace, "repositories");
    if (codeRoots.has(resolve(repositories))) {
      for (const entry of readdirSync(repositories, { withFileTypes: true })) {
        const path = join(repositories, entry.name);
        if (entry.isDirectory() && withinDataDir(path, workspace)) sources.add(path);
      }
    }
    const primary = options.cwd && sources.has(resolve(options.cwd)) ? resolve(options.cwd)
      : [...sources].find(path => existsSync(join(path, ".mae-flow-work")));
    const archive = join(workspace, ARCHIVED_DOCUMENTS_DIR);
    const assertNoLinks = (path: string) => {
      const walk = (path: string) => {
        const info = lstatSync(path);
        if (info.isSymbolicLink()) throw new Error(`文档路径包含符号链接：${path}`);
        if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
      };
      if (existsSync(path)) walk(path);
    };
    if (existsSync(archive)) assertNoLinks(archive);
    for (const source of sources) {
      const target = source === primary ? archive : join(archive, "source-materials", relative(workspace, source));
      for (const name of [".mae-flow-work", ".mae-flow-requirement.md"]) {
        const from = join(source, name);
        if (!existsSync(from)) continue;
        assertNoLinks(from);
        mkdirSync(target, { recursive: true });
        cpSync(from, join(target, name), { recursive: true, preserveTimestamps: true });
      }
    }
  } catch (error) {
    return { removed, freed, snapshotted, refused: `文档保存失败，保留代码现场：${String(error)}` };
  }

  const targets = new Set([...codeRoots, ...TEMPORARY_RUNTIME_DIRS.map(name => join(workspace, name))]);
  for (const target of targets) {
    if (!existsSync(target)) continue;
    const size = sizeOf(target);
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(relative(workspace, target));
      freed += size;
    } catch {
      // 单个条目删不动(权限/占用)不中断,下一个接着来。
    }
  }
  return { removed, freed, snapshotted };
}
