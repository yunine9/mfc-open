import { isCodecheckPath } from "../codecheckArtifacts.ts";
/**
 * 问题会话工作区材料(交付材料页签的数据面)。
 *
 * 工作区变更的口径与需求侧 artifacts.ts 对齐:**基线 → 当前工作区**
 * (含已提交)——交付流程要求 commit 后推送,只 diff HEAD 的话问题
 * 修改一提交变更就集体隐身;基线 = 登记基线分支 → origin/HEAD 依次
 * 试 merge-base(建分支的起点),无基线参照的裸本地仓退回 HEAD 口径。
 *
 * 边界纪律(与 readAnalysisFile 同款,双保险):
 * - 一切相对路径先 join 再 resolve,解析结果必须仍落在会话工作区内,
 *   越界一律拒绝——path 来自浏览器查询串,不可信。
 * - 本模块对工作区只读(人工修改写口已随 ADR-0028 退役):.git 与
 *   会话元数据(issue.json/events.jsonl/…)是宿主账本,永不可写。
 * - git 只读视图走 safeGit(仓库 clone 时 repo_url 来自用户输入,git
 *   配置里可能埋 external diff/credential helper,不能裸跑 git)。
 * - 全部旁路 fail-open:材料生成失败返回空态,不拖垮会话。
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve, sep, basename, dirname } from "node:path";
import { createSafeGitView } from "../safeGit.ts";
import { createZipArchive } from "../zipArchive.ts";
import { issueRepoWorkspaces, type IssueSessionState } from "./state.ts";

export interface WorkspaceChange {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

const READ_CAP_BYTES = 512 * 1024;
const TAIL_BYTES = 512 * 1024;

/** 相对路径 → 工作区内绝对路径;越界/绝对路径/含 .. 一律 undefined。 */
function insideRoot(root: string, rel: string): string | undefined {
  if (!rel || resolve(rel) === rel) return undefined;
  const abs = resolve(join(root, rel));
  const boundary = resolve(root);
  if (abs !== boundary && !abs.startsWith(boundary + sep)) return undefined;
  return abs;
}

/** 读文件前 max 字节(超长截断)。 */
function readHead(path: string, max: number): string {
  const buffer = Buffer.alloc(max);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, max, 0);
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** 读文件末尾 max 字节(日志排障最关心"最后发生了什么")。 */
function readTail(path: string, max: number): string {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(max);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, max, Math.max(0, size - max));
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function gitIn(repoDir: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const run = spawnSync("git", args, {
    cwd: repoDir,
    env,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return run.status === 0 ? String(run.stdout ?? "") : "";
}

/** 材料专用的只读 git:优先 safeGit 视图(仓库配置零信任);Windows
 * 无符号链接权限时 safeGit 起不来,降级普通 git(禁 pager)。降级的
 * 残余风险(repo 本地配置可挂 diff driver)与"AI 会话本就能在该工作区
 * 跑任意 bash"同权,材料页签没有放大它——任务侧内核闸不受影响。 */
function gitRead(repoDir: string, args: string[]): string {
  let view: ReturnType<typeof createSafeGitView> | undefined;
  try {
    view = createSafeGitView(repoDir);
    return gitIn(repoDir, view.environment(), args);
  } catch {
    return gitIn(repoDir, {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
    }, ["--no-pager", ...args]);
  } finally {
    view?.cleanup();
  }
}

// ---- 工作区变更(基线口径,对齐需求侧 artifacts.ts 的 collectDiff) ----

/** 变更来源分组(标签与语义同需求侧交付检视)。只 diff HEAD 的话,
 * 问题修改一提交(交付流程:改完 commit 再推送)变更就集体隐身——
 * 已提交的也要能看,这是"修改完成后检视"的主视图。 */
type ChangeOrigin = "committed" | "committed_working" | "staged"
  | "staged_working" | "unstaged";

const ORIGIN_HEADING: Record<ChangeOrigin, string> = {
  committed: "已提交(committed)",
  committed_working: "已提交后又修改(committed-working)",
  staged: "已暂存(staged)",
  staged_working: "已暂存后又修改(staged-working)",
  unstaged: "未暂存(unstaged)",
};

/** 未跟踪文件展开全文 diff 的上限(口径同需求侧):超限只列 ?? 路径
 * 不展开内容——列表完整,细节有帽。 */
const UNTRACKED_CAP = 50;

/** 修复分支的基线(建分支的起点):登记基线分支 → origin/HEAD 依次试
 * merge-base。问题域没有需求侧 .mae-flow.json 的 step_heads 记录,用
 * 分叉点反推最稳:基线分支上别人的新提交天然不进本会话的变更视图,
 * 而本会话提交过的(问题修改阶段的 commit)从分叉点起照常可见。取
 * 不到(无远端引用的裸本地仓)返回 undefined,调用方退回 HEAD 口径
 * ——旧行为(只看未提交)是它的保守退化,不因环境缺失报错。 */
function repoBaseline(
  repoDir: string,
  baselineBranch?: string,
): string | undefined {
  const refs: string[] = [];
  const named = baselineBranch?.trim();
  if (named) refs.push(`origin/${named}`, named);
  refs.push("origin/HEAD");
  for (const ref of refs) {
    const base = gitRead(repoDir, ["merge-base", "HEAD", ref]).trim();
    if (base) return base;
  }
  return undefined;
}

/** 聚合 diff → 文件块(按 diff --git 头切,取 b/ 侧路径)。 */
function diffChunks(text: string): Array<{ path: string; text: string }> {
  return text.split(/(?=^diff --git )/m).map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return header && !isCodecheckPath(header[2]) ? [{ path: header[2], text: chunk }] : [];
    });
}

/** porcelain 行 → 路径(重命名取箭头右侧的新名字;引号是 git 对特殊
 * 字符的转义包装,剥掉)。 */
function porcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  if (!raw) return "";
  const arrow = raw.split(" -> ");
  return (arrow[1] ?? arrow[0]).replace(/^"|"$/g, "");
}

/** porcelain 全文 → 路径 → XY 状态(未跟踪行不进表,它们单独走)。 */
function statusEntries(status: string): Map<string, { x: string; y: string }> {
  const entries = new Map<string, { x: string; y: string }>();
  for (const line of status.split("\n")) {
    if (line.length < 4 || line.startsWith("??")) continue;
    const path = porcelainPath(line);
    if (path) entries.set(path, { x: line[0], y: line[1] });
  }
  return entries;
}

function originOf(
  path: string,
  committed: Set<string>,
  statuses: Map<string, { x: string; y: string }>,
): ChangeOrigin {
  const status = statuses.get(path);
  const indexChanged = !!status && status.x !== " ";
  const worktreeChanged = !!status && status.y !== " ";
  if (committed.has(path) && (indexChanged || worktreeChanged)) {
    return "committed_working";
  }
  if (indexChanged && worktreeChanged) return "staged_working";
  if (indexChanged) return "staged";
  if (worktreeChanged) return "unstaged";
  return "committed";
}

/** 单仓"本会话变更"全集:基线 → 当前工作区(含已提交与未提交),
 * 未跟踪新文件补全文 diff;分组标题沿用需求侧交付检视的口径。changed
 * 是路径全集,变更清单与 diff 视图同出一把尺。 */
function collectRepoDiff(
  repoDir: string,
  baselineBranch?: string,
): { text: string; changed: string[] } {
  if (!existsSync(join(repoDir, ".git"))) return { text: "", changed: [] };
  // 完整上下文(--unified=999999,同需求侧):前端 GitDiff 才能默认
  // 折叠未改动区后按需展开全文。
  const fullContext = "--unified=999999";
  const status = gitRead(repoDir,
    ["status", "--porcelain", "--untracked-files=all"]);
  const untracked = status.split("\n")
    .filter((line) => line.startsWith("??"))
    .map(porcelainPath)
    .filter(path => path && !isCodecheckPath(path));
  const tracked = new Set<string>();
  const sections: string[] = [];
  const baseline = repoBaseline(repoDir, baselineBranch);
  if (baseline) {
    const aggregate = gitRead(repoDir, ["diff", fullContext, baseline]);
    const committed = new Set(gitRead(repoDir,
      ["diff", "--name-only", baseline, "HEAD"])
      .split("\n").map((line) => line.trim()).filter(Boolean));
    const statuses = statusEntries(status);
    const grouped = new Map<ChangeOrigin, string[]>();
    for (const chunk of diffChunks(aggregate)) {
      tracked.add(chunk.path);
      const origin = originOf(chunk.path, committed, statuses);
      grouped.set(origin, [...(grouped.get(origin) ?? []), chunk.text]);
    }
    for (const origin of ["committed", "committed_working", "staged",
      "staged_working", "unstaged"] as ChangeOrigin[]) {
      const chunks = grouped.get(origin);
      if (chunks?.length) {
        sections.push(`## ${ORIGIN_HEADING[origin]}\n\n${chunks.join("\n\n")}`);
      }
    }
  } else {
    // 没有基线参照(裸本地仓无远端引用):退回 HEAD 口径只看未提交
    // ——保守退化,与旧行为一致,不因环境缺失砸页面。
    const staged = gitRead(repoDir, ["diff", "--cached", fullContext]).trim();
    const unstaged = gitRead(repoDir, ["diff", fullContext]).trim();
    for (const [heading, text] of [
      [ORIGIN_HEADING.staged, staged],
      [ORIGIN_HEADING.unstaged, unstaged],
    ] as Array<[string, string]>) {
      const filtered = diffChunks(text).map(chunk => chunk.text).join("\n\n");
      if (!filtered) continue;
      sections.push(`## ${heading}\n\n${filtered}`);
      for (const chunk of diffChunks(text)) tracked.add(chunk.path);
    }
  }
  if (untracked.length) {
    const snapshots = untracked.map((rel, index) => {
      if (index >= UNTRACKED_CAP) return `?? ${rel}`;
      const abs = insideRoot(repoDir, rel);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return `?? ${rel}`;
      try {
        const body = readFileSync(abs, "utf-8")
          .split("\n").map((line) => `+${line}`).join("\n");
        return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`
          + `--- /dev/null\n+++ b/${rel}\n${body}`;
      } catch {
        // 二进制等读不了的文件如实列名,不拖垮整份聚合 diff。
        return `?? ${rel}`;
      }
    });
    sections.push(`## 未跟踪(untracked)\n\n${snapshots.join("\n\n")}`);
  }
  return {
    text: sections.join("\n\n"),
    changed: [...new Set([...tracked, ...untracked])],
  };
}

/** 工作区变更清单:与 diff 视图同一把尺(基线→工作区,含已提交)+
 * 未跟踪;±行数取同一参照的 numstat,未跟踪无行数。status 展示用:
 * porcelain XY,已提交且未再动的标 committed。 */
export function listWorkspaceChanges(
  repoDir: string,
  baselineBranch?: string,
): WorkspaceChange[] {
  if (!existsSync(join(repoDir, ".git"))) return [];
  try {
    const ref = repoBaseline(repoDir, baselineBranch) ?? "HEAD";
    const statByName = new Map<string, { additions?: number; deletions?: number }>();
    for (const line of gitRead(repoDir, ["diff", "--numstat", ref])
      .split("\n")) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split("\t");
      // 重命名行形如 "a\tb\told => new",取尾段主干对齐 name-status 输出。
      const name = (rest.join("\t").split(" => ").at(-1) ?? "").trim();
      if (!name) continue;
      statByName.set(name, {
        ...(add === "-" ? {} : { additions: Number(add) }),
        ...(del === "-" ? {} : { deletions: Number(del) }),
      });
    }
    const status = gitRead(repoDir, ["status", "--porcelain", "-uall"]);
    const statuses = statusEntries(status);
    const untracked = new Set(status.split("\n")
      .filter((line) => line.startsWith("??"))
      .map(porcelainPath)
      .filter(Boolean));
    const seen = new Set<string>();
    const rows: WorkspaceChange[] = [];
    const push = (path: string) => {
      if (!path || isCodecheckPath(path) || seen.has(path)) return;
      seen.add(path);
      const entry = statuses.get(path);
      const stat = statByName.get(path);
      rows.push({
        path,
        status: untracked.has(path) ? "??"
          : entry ? (entry.x !== " " ? entry.x : entry.y)
          : "committed",
        ...(stat?.additions !== undefined ? { additions: stat.additions } : {}),
        ...(stat?.deletions !== undefined ? { deletions: stat.deletions } : {}),
      });
    };
    for (const line of gitRead(repoDir, ["diff", "--name-only", ref])
      .split("\n")) {
      push(line.trim());
    }
    for (const path of [...statuses.keys(), ...untracked]) push(path);
    return rows;
  } catch {
    // git 视图起不来(坏配置/竞态):给空清单,fail-open 不拖垮页面。
    return [];
  }
}

/** 单仓聚合 diff(基线口径,超长截断如实标注)。 */
export function workspaceDiffAll(
  repoDir: string,
  baselineBranch?: string,
): string {
  const text = collectRepoDiff(repoDir, baselineBranch).text;
  if (Buffer.byteLength(text, "utf-8") <= READ_CAP_BYTES) return text;
  return text.slice(0, READ_CAP_BYTES)
    + "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见代码仓工作区)";
}

/** 单文件 diff(基线口径;未跟踪新文件给全文 + 前缀)。 */
export function workspaceFileDiff(
  repoDir: string,
  rel: string,
  baselineBranch?: string,
): string {
  if (isCodecheckPath(rel)) return "";
  const abs = insideRoot(repoDir, rel);
  if (!abs || rel.split(/[\\/]/).includes(".git")) {
    throw new Error("路径越界");
  }
  const ref = repoBaseline(repoDir, baselineBranch) ?? "HEAD";
  const diff = gitRead(repoDir, ["diff", ref, "--", rel]);
  if (diff.trim()) return diff.slice(0, READ_CAP_BYTES);
  if (existsSync(abs)) {
    // 参照里没有的(未跟踪新文件):diff 为空,给带 + 前缀的全文冒充新文件 diff。
    const body = readFileSync(abs, "utf-8")
      .split("\n").map((line) => `+${line}`).join("\n");
    return `--- /dev/null\n+++ b/${rel}\n${body.slice(0, READ_CAP_BYTES)}`;
  }
  return "(文件已删除,仅剩删除记录)";
}

/** 读工作区文件(编辑器回填)。 */
export function readWorkspaceFile(
  repoDir: string,
  rel: string,
): { content: string; truncated: boolean } {
  const abs = insideRoot(repoDir, rel);
  if (!abs) throw new Error("路径越界或文件不在代码仓内");
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error("文件不存在");
  }
  if (resolve(abs).startsWith(resolve(join(repoDir, ".git")))) {
    throw new Error(".git 内部不可读写");
  }
  if (statSync(abs).size > READ_CAP_BYTES) {
    return { content: readHead(abs, READ_CAP_BYTES), truncated: true };
  }
  return { content: readFileSync(abs, "utf-8"), truncated: false };
}

// ---- 拉取日志(#47 数据面存留部分;ADR-0026 后人读面收敛为整包
// 下载,读/解压已随页签退役)----
//
// fetch-logs 抓的是"完整目录结构"(tools.ts 的工具描述就这么许诺的),
// 旧清单却是不递归的 readdirSync 平铺:子目录点了就"日志不存在"。
// 数据面把清单补齐成递归扁平条目,页面按它判定「拉取过没拉取过」。

/** 日志条目(local-logs 相对路径,/ 分隔)。type=dir 的条目 size 恒 0,
 * 前端组树用;archive 按扩展名认(.zip/.tar/.tar.gz/.tgz/.tar.bz2)。 */
export interface LogEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  archive: boolean;
}

export interface LogListing {
  entries: LogEntry[];
  /** 条数封顶被触发:清单不完整,如实标注,不静默截断。 */
  truncated: boolean;
}

/** 清单条数封顶(整个 local-logs,不分层):日志树再疯也不拖死页面。 */
const LOG_LIST_CAP = 2000;
/** 递归深度封顶:防符号链接外的环(理论上不可能)与病态深目录。 */
const LOG_WALK_DEPTH_CAP = 20;

/** 压缩包判定(按扩展名;fetch-logs 产物就这五种)。 */
export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2"]
    .some((ext) => lower.endsWith(ext));
}

/** local-logs/ 递归清单(新→旧;扁平条目,前端按 path 组树)。
 * 符号链接一律跳过不跟随(chownTree 同款纪律:链接指向哪儿都不可信),
 * 单条目 stat 失败(竞态消失/权限)跳过不砸整页,整目录读不动同理。 */
export function listLogs(root: string): LogListing {
  const dir = join(root, "local-logs");
  if (!existsSync(dir)) return { entries: [], truncated: false };
  const entries: LogEntry[] = [];
  let truncated = false;
  const push = (entry: LogEntry): boolean => {
    if (entries.length >= LOG_LIST_CAP) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  };
  const visit = (relDir: string, depth: number): void => {
    if (truncated || depth > LOG_WALK_DEPTH_CAP) {
      if (depth > LOG_WALK_DEPTH_CAP) truncated = true;
      return;
    }
    let names: string[];
    try {
      names = readdirSync(join(dir, relDir));
    } catch {
      return;
    }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      let info;
      try {
        info = lstatSync(join(dir, rel));
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!push({ path: rel, type: "dir", size: 0,
          mtime: info.mtime.toISOString(), archive: false })) return;
        visit(rel, depth + 1);
      } else if (info.isFile()) {
        if (!push({ path: rel, type: "file", size: info.size,
          mtime: info.mtime.toISOString(), archive: isArchiveName(name) })) {
          return;
        }
      }
    }
  };
  try {
    visit("", 1);
  } catch {
    // 顶层都不行(目录被删等):给空清单,材料域 fail-open 不砸页面。
    return { entries: [], truncated };
  }
  entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { entries, truncated };
}

/** 打包下载在内存里生成 ZIP,给个明确上限,避免一次下载把 serve 的堆
 * 占满(与过程文档打包同款纪律)。 */
const LOG_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

export class IssueLogsArchiveTooLargeError extends Error {}

/** 整包 local-logs 打成 ZIP(ADR-0026:日志的人读面收敛为下载)。
 * 边界 = listLogs 的白名单(路径全部来自 readdir、符号链接不进清单、
 * 条数/深度封顶),不收任何外部输入;扫描后消失的文件跳过,一个文件
 * 都没有返回 undefined(调用方出 404)。目录不在/为空同样 undefined。 */
export function bundleSessionLogs(
  root: string,
): { data: Buffer; files: number } | undefined {
  const listing = listLogs(root);
  if (!listing.entries.length) return undefined;
  const dir = join(root, "local-logs");
  const entries: Array<{ name: string; content: Buffer; modifiedAt: Date }> = [];
  let totalBytes = 0;
  for (const entry of listing.entries) {
    if (entry.type !== "file") continue;
    let info;
    let content: Buffer;
    try {
      const abs = join(dir, entry.path);
      info = statSync(abs);
      if (!info.isFile()) continue;
      content = readFileSync(abs);
    } catch {
      // 扫描后消失或暂时不可读:与清单同口径,跳过这一项。
      continue;
    }
    totalBytes += content.length;
    if (totalBytes > LOG_ARCHIVE_MAX_BYTES) {
      throw new IssueLogsArchiveTooLargeError(
        "拉取日志合计超过 256 MiB 上限,无法整包打包");
    }
    entries.push({ name: entry.path, content, modifiedAt: info.mtime });
  }
  if (!entries.length) return undefined;
  return { data: createZipArchive(entries), files: entries.length };
}

/** 原始事件流尾随(现场页签):只读尾窗,解析不动的行跳过。 */
export function recentEvents(
  root: string,
  limit = 200,
): Array<Record<string, unknown>> {
  const path = join(root, "events.jsonl");
  if (!existsSync(path)) return [];
  let text = statSync(path).size <= TAIL_BYTES
    ? readFileSync(path, "utf-8")
    : readTail(path, TAIL_BYTES);
  if (text.length >= TAIL_BYTES) {
    // 尾窗第一行多半是残行,弃掉。
    text = text.slice(text.indexOf("\n") + 1);
  }
  text = text.trim();
  if (!text) return [];
  return text.split("\n")
    .map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { return undefined; }
    })
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .slice(-limit);
}

// ---- 会话级材料(/issues/:id/materials 路由直连的数据面;收窄票 #7
// 把 service 上的 require+路由+委托三行透传挪到这里,服务不再转手) ----

/** 多仓材料聚合的公共底座:repo/ 下每个已克隆仓 → (仓名, 目录)。 */
function materialRepos(
  state: IssueSessionState,
  root: string,
): Array<{ name: string; dir: string }> {
  return issueRepoWorkspaces(state, root)
    .filter((repo) => existsSync(join(repo.dir, ".git")))
    .map((repo) => ({
      name: repo.dir.split(/[\\/]/).at(-1) ?? "repo",
      dir: repo.dir,
    }));
}

/** 路径路由:rel 首段是仓名(repo/<仓名>/ 的平铺约定);对不上时
 * 兜底首仓(老路径/手工输入),保证读写不因前缀缺席而砸。 */
function routeMaterialPath(
  state: IssueSessionState,
  root: string,
  rel: string,
): { repo: { name: string; dir: string }; rel: string } | undefined {
  const repos = materialRepos(state, root);
  if (!repos.length) return undefined;
  const head = rel.split(/[\\/]/)[0];
  const match = repos.find((repo) => repo.name === head);
  if (match) return { repo: match, rel: rel.slice(head.length + 1) };
  return { repo: repos[0], rel };
}

/** 材料清单:变更按仓聚合,路径带 <仓名>/ 前缀(与 routeMaterialPath
 * 对得上)。口径 = 基线→工作区(含已提交),登记基线分支一路下传。 */
export function listMaterials(state: IssueSessionState, root: string) {
  const changes = materialRepos(state, root).flatMap((repo) =>
    listWorkspaceChanges(repo.dir, state.baseline)
      .map((change) => ({ ...change, path: `${repo.name}/${change.path}` })));
  return {
    ticket: state.ticket,
    pushes: state.pushes ?? [],
    mrs: state.mrs ?? [],
    changes,
    logs: listLogs(root),
  };
}

/** 单文件 diff(会话级,基线口径)。 */
export function sessionWorkspaceFileDiff(
  state: IssueSessionState,
  root: string,
  rel: string,
): string {
  const routed = routeMaterialPath(state, root, rel);
  if (!routed) throw new Error("会话还没有已克隆的代码仓");
  return workspaceFileDiff(routed.repo.dir, routed.rel, state.baseline);
}

/** 聚合 diff(会话级):按仓分段,段间加"仓库"分隔行,前端 diff 视图
 * 按元信息行呈现。口径 = 基线→工作区(含已提交),登记基线一路下传。 */
export function sessionWorkspaceDiffAll(
  state: IssueSessionState,
  root: string,
): string {
  const parts = materialRepos(state, root)
    .map((repo) => ({
      name: repo.name,
      diff: workspaceDiffAll(repo.dir, state.baseline),
    }))
    .filter((part) => part.diff.trim());
  if (!parts.length) return "";
  return parts.map((part) =>
    `===== 仓库 ${part.name} =====\n${part.diff}`).join("\n\n");
}

/** 单仓 diff(会话级,#32):?repo= 服务端切片,逐仓审阅不再靠前端
 * 解析聚合里的「===== 仓库 =====」标记。仓名按 materialRepos 的取名
 * 匹配(与变更清单的 <仓名>/ 前缀同源);对不上不兜底——兜底到首仓
 * 会让"看 A 仓"静默变成"看 B 仓",宁可让调用方拿到明确的错。 */
export function sessionWorkspaceRepoDiff(
  state: IssueSessionState,
  root: string,
  repo: string,
): string {
  const match = materialRepos(state, root).find((item) => item.name === repo);
  if (!match) throw new Error(`仓 ${repo} 不在本会话的关联仓里`);
  return workspaceDiffAll(match.dir, state.baseline);
}
