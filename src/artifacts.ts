import { isCodecheckPath } from "./codecheckArtifacts.ts";
import { decodeGitQuotedPath, gitNullPaths, gitStatusPaths } from "./gitPaths.ts";
import { currentStoryFile, OVERALL_STORY_ARTIFACT } from "./overallStoryStore.ts";
/**
 * 检视产物(只读旁路):把内核留在工作区里的检视材料列出来、读出来,
 * 让"决策"和"证据"能同屏——审批卡问"本地 Spec 确认吗",spec.md 就
 * 该在旁边,而不是让人跳到另一套界面里翻。
 *
 * 三条自律:
 * - **只读,不判定**。"哪一步该看哪份材料"是内核的语义(CLAUDE.md
 *   红线:连阶段映射都不许抄第二份),这里不猜;只按"最近修改"排序
 *   ——那是客观信号,不是判断。
 * - **白名单即边界**。能读的只有本模块自己扫出来的那些文件:name 先
 *   在集合里核对,再用集合里存的绝对路径去读,绝不拿用户输入拼路径
 *   (路径穿越不是 404 的一种,是攻击)。
 * - **fail-open**。目录不可读、git 不在、文件半路消失,都只让那一项
 *   缺席,返回空数组或 undefined,绝不抛错——旁路不许把页面拖垮。
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { open as openAsync, realpath as realpathAsync } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { runSafeWorktreeGit, runSafeWorktreeGitAsync } from "./safeGit.ts";
import {
  AGENT_PLATFORM_ROOTS,
  isAgentPlatformPath,
} from "./agentPlatformPaths.ts";
import { createZipArchive } from "./zipArchive.ts";

const WORK_DIR = ".mae-flow-work";
/** 单个产物最多回传这么多字节:一个巨型 diff 不能把页面拖死。 */
const MAX_BYTES = 512 * 1024;
const MAX_UNTRACKED_DIFF_FILES = 50;
const UNTRACKED_DIFF_CONCURRENCY = 4;
/** 只作用于未跟踪文件。Git 在遍历时剪枝，避免依赖安装撑爆交付事实；
 * 已暂存/已提交的文件不受影响。build/dist/target 可能是业务源码，不能猜。
 * 特殊情况下需要交付依赖文件，可先显式 git add 后进入正常清单。 */
const DELIVERY_UNTRACKED_EXCLUDES = [
  "node_modules/", ".venv/", "__pycache__/", ".pytest_cache/",
];
const TRUNCATED_NOTE =
  "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见工作区文件)";
/** Git 工作区差异的固定标识:它是"虚拟产物",不对应磁盘上某个文件。 */
export const DIFF_NAME = "未提交改动";
/** 宿主在平台红灯却拿不到具体报错时生成的人工补证材料。它不在代码
 * 仓里，而在任务级 pipeline/ 目录；仍使用稳定 ID 进入同一套批注链。 */
export const PIPELINE_EVIDENCE_GAP_FILE = "流水线证据缺口.md";
export const PIPELINE_EVIDENCE_GAP_ARTIFACT =
  `pipeline/${PIPELINE_EVIDENCE_GAP_FILE}`;

export interface ArtifactSources {
  /** 任务级流水线材料目录。调用方必须显式传入，不能从代码仓路径猜。 */
  pipelineRoot?: string;
  /** 主任务分析 Story 的稳定阅读入口，发布后沿用同一批注标识。 */
  analysisStory?: string;
  /** 发布后不能在版本库损坏时偷偷退回分析旧稿。 */
  publishedStory?: boolean;
  /** 拆分子任务的只读材料保存在任务根，不属于业务仓过程产物。只读取
   * 平台固定文件名，不能把任务根开放成任意文件浏览器。 */
  taskMaterialRoot?: string;
}

/** Mae-Flow 自己的流程状态不是代码交付内容。Git 本地排除规则是第一道
 * 防线，但它可能缺失、写入失败或来自旧现场；差异采集必须再守一道，
 * 不能把过程状态混进代码审阅。口径与内核 source_paths.py 保持一致。 */
function isFlowControlPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "").replace(/^"|"$/g, "");
  return normalized === ".mae-flow.json"
    || normalized.startsWith(".mae-flow.json.")
    || normalized === ".mae-flow-history.jsonl"
    || normalized === ".mae-flow-need-reload"
    || normalized === ".mae-flow"
    || normalized.startsWith(".mae-flow/")
    || normalized === ".mae-flow-work"
    || normalized.startsWith(".mae-flow-work/")
    || isCodecheckPath(normalized)
    // 平台自己写的现场文件(下单事实/跨仓方案/仓库预设):正常路在
    // .git/info/exclude 里挡着,这里兜"exclude 没登记上的旧克隆"。
    || normalized === ".mae-flow-order.json"
    || normalized === ".mae-flow-chain.md"
    || normalized === ".mae-flow-unit.md"
    || normalized === ".mae-flow-requirement.md"
    || normalized === ".mae-flow-defaults.json";
}

export interface ArtifactMeta {
  /** 稳定标识,也是 URL 里的取值:文档为 `<单号目录>/<文件名>`。 */
  name: string;
  /** 给人看的短名。 */
  label: string;
  kind: "doc" | "diff";
  bytes: number;
  modified_at: string;
  /** 差异产物包含的真实文件数；文档产物不提供。 */
  file_count?: number;
  /**
   * 工作区差异的完整文件清单。它与正文分开返回：再大的单个文件也
   * 不能把后面的文件从目录树里挤掉；正文由页面点文件后按需读取。
   */
  change_files?: ArtifactChangeFile[];
  /**
   * Git 报告的未跟踪目录根。列表接口只返回目录本身，不能用
   * `--untracked-files=all` 把一次编译产生的数万文件塞进页面；用户
   * 展开目录时再通过分页接口读取下一层。
   */
  untracked_directories?: ArtifactChangeDirectory[];
  /** Cloud 生成材料的稳定用途；前端据此导航，不靠中文文件名猜语义。 */
  purpose?: "pipeline_evidence_gap" | "delivery_unit_brief" | "delivery_plan" | "overall_story";
  /** 此文档来自已发布的 Story 修订，而非工作区分析稿。 */
  story_published?: boolean;
}

export type ArtifactChangeStage = "committed" | "committed_working"
  | "staged" | "staged_working" | "unstaged" | "untracked";

export interface ArtifactChangeFile {
  path: string;
  stage: ArtifactChangeStage;
  additions: number;
  deletions: number;
  stats_status?: "unavailable" | "binary";
}

export interface ArtifactChangeDirectory {
  path: string;
  stage: "untracked";
}

export interface ArtifactChangeDirectoryEntry {
  path: string;
  kind: "file" | "directory";
  /** 目录下包含的未跟踪文件总数；文件恒为 1。 */
  file_count: number;
  stage: "untracked";
  stats_status?: "unavailable" | "binary";
  additions?: number;
  deletions?: number;
}

export interface ArtifactChangeDirectoryPage {
  path: string;
  entries: ArtifactChangeDirectoryEntry[];
  total_entries: number;
  total_files: number;
  next_offset?: number;
}

export interface ArtifactFileDiff {
  path: string;
  content: string;
  branch?: string;
  truncated: boolean;
}

export interface ArtifactContent extends ArtifactMeta {
  content: string;
  /** Git 差异所属的当前分支；文档产物没有此字段。 */
  branch?: string;
  /** 触顶截断时为 true:页面要如实告诉用户"这不是全文"。 */
  truncated?: boolean;
}

/** 用户确认交付文件时使用的权威 Git 快照。workspace_paths 是工作区里
 * 当前可见的全部业务变更；committed_paths 才是 push HEAD 真正会带走
 * 的文件。两者分开，前端才能如实区分“看得见”和“会提交”。 */
export interface DeliveryChangeSnapshot {
  baseline?: string;
  head: string;
  workspace_paths: string[];
  committed_paths: string[];
  /** 本任务提交历史中新加入过的 Agent 平台目录文件；即使后来删除，
   * 对象仍会随分支 push，因此宿主必须在传输前拦住。 */
  added_agent_platform_paths: string[];
}

/** 两个已经落成的提交之间，真正会随 push 传输的代码变化。
 * 只服务检视阅读，不参与推送授权，也不形成文件白名单。 */
export interface DeliveryRevisionComparison {
  from: string;
  to: string;
  content: string;
  truncated: boolean;
  paths: string[];
  additions: number;
  deletions: number;
  commits: Array<{ sha: string; subject: string }>;
  branch?: string;
}

interface DocEntry {
  meta: ArtifactMeta;
  /** 集合内部保存的绝对路径:读取只走这里,不由 name 拼。 */
  path: string;
  /** 允许读取的真实根目录；最终读取还会用 realpath 再守一次边界。 */
  root: string;
}

const ARTIFACT_ARCHIVE_MAX_FILES = 1000;
const ARTIFACT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export class ArtifactArchiveTooLargeError extends Error {}

export interface ArtifactDocumentsArchive {
  data: Buffer;
  files: number;
  sourceBytes: number;
}

/** 代码工作区:调用方给了就用;没给就在任务工作区下找带
 * `.mae-flow.json` 的那一层(host 模式的克隆目录)。找不到返回
 * undefined——没有内核现场不是错误,是流程还没走到 init。 */
export function resolveArtifactRoot(
  workspace: string,
  cwd?: string,
): string | undefined {
  if (cwd && existsSync(join(cwd, WORK_DIR))) return cwd;
  if (cwd && existsSync(join(cwd, ".mae-flow.json"))) return cwd;
  try {
    for (const name of readdirSync(workspace)) {
      const candidate = join(workspace, name);
      if (!statSync(candidate).isDirectory()) continue;
      if (existsSync(join(candidate, WORK_DIR))) return candidate;
      if (existsSync(join(candidate, ".mae-flow.json"))) return candidate;
    }
  } catch {
    // 工作区不可读:当作没有现场。
  }
  return undefined;
}

/** 扫单号目录下的 markdown。
 *
 * 怎么认单号目录:内核自己在里面放了 `.ticket-id` 标记,用它最稳
 * (不是我们发明的语义,是读它的标记)。一个都没有时退化成扫所有
 * 直接子目录——宁可多列几份,也好过页面空着。 */
function collectDocs(cwd: string): DocEntry[] {
  const workRoot = join(cwd, WORK_DIR);
  let dirs: string[] = [];
  try {
    dirs = readdirSync(workRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workRoot, entry.name));
  } catch {
    return [];
  }
  const tickets = dirs.filter((dir) => existsSync(join(dir, ".ticket-id")));
  const docs: DocEntry[] = [];
  for (const dir of tickets.length ? tickets : dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) =>
        name.toLowerCase().endsWith(".md"));
    } catch {
      continue;
    }
    for (const fileName of names) {
      const path = join(dir, fileName);
      try {
        const info = statSync(path);
        if (!info.isFile()) continue;
        docs.push({
          path,
          root: workRoot,
          meta: {
            name: `${basename(dir)}/${fileName}`,
            label: fileName,
            kind: "doc",
            bytes: info.size,
            modified_at: info.mtime.toISOString(),
          },
        });
      } catch {
        // 文件在扫描途中消失:跳过这一项,别的照列。
      }
    }
  }
  return docs;
}

/** 任务级 pipeline/ 里有很多给 Agent 的原始日志，不能一股脑塞进业务
 * 工作台。这里只暴露系统明确要求人补证的那一份材料；候选路径固定，
 * 不接收请求参数，也不跟随越出 pipeline/ 的符号链接。 */
function collectPipelineDocs(pipelineRoot?: string): DocEntry[] {
  if (!pipelineRoot) return [];
  const path = join(pipelineRoot, PIPELINE_EVIDENCE_GAP_FILE);
  try {
    const root = realpathSync(pipelineRoot);
    const target = realpathSync(path);
    if (target !== root && !target.startsWith(root + sep)) return [];
    const info = statSync(target);
    if (!info.isFile()) return [];
    return [{
      path: target,
      root,
      meta: {
        name: PIPELINE_EVIDENCE_GAP_ARTIFACT,
        label: PIPELINE_EVIDENCE_GAP_FILE,
        kind: "doc",
        bytes: info.size,
        modified_at: info.mtime.toISOString(),
        purpose: "pipeline_evidence_gap",
      },
    }];
  } catch {
    return [];
  }
}

/** 子任务两份平台材料：自己的任务书是主入口，整体方案只作上下游参考。
 * 文件在 Agent 启动前就已定格，因此即使还在排队，页面也应看得到。 */
function collectTaskMaterialDocs(taskMaterialRoot?: string): DocEntry[] {
  if (!taskMaterialRoot) return [];
  const definitions: Array<{ file: string; name: string; label: string; purpose: ArtifactMeta["purpose"] }> = [
    {
      file: "unit-brief.md",
      name: "task-materials/unit-brief.md",
      label: "当前单元任务书",
      purpose: "delivery_unit_brief" as const,
    },
    {
      file: "chain-plan.md",
      name: "task-materials/chain-plan.md",
      label: "整体拆分方案",
      purpose: "delivery_plan" as const,
    },
  ];
  definitions.push({ file: "交付经验复盘.md", name: "task-materials/交付经验复盘.md", label: "交付经验复盘.md", purpose: undefined });
  definitions.push({ file: "交付报告.md", name: "task-materials/交付报告.md", label: "交付报告.md", purpose: undefined });
  try {
    const overall = currentStoryFile(taskMaterialRoot);
    if (overall) definitions.push({ file: overall, name: OVERALL_STORY_ARTIFACT,
      label: basename(overall), purpose: "overall_story" });
  } catch { /* 独立文档损坏不能让其他任务材料消失，错误由整体 Story 状态接口报告。 */ }
  const docs: DocEntry[] = [];
  for (const definition of definitions) {
    try {
      const root = realpathSync(taskMaterialRoot);
      const target = realpathSync(resolve(root, definition.file));
      if (target !== root && !target.startsWith(root + sep)) continue;
      const info = statSync(target);
      if (!info.isFile()) continue;
      docs.push({
        path: target,
        root,
        meta: {
          name: definition.name,
          label: definition.label,
          kind: "doc",
          bytes: info.size,
          modified_at: info.mtime.toISOString(),
          purpose: definition.purpose,
          ...(definition.purpose === "overall_story" ? { story_published: true } : {}),
        },
      });
    } catch {
      // 老任务没有这些文件、文件写入中或被替换：只让该项缺席。
    }
  }
  return docs;
}

function collectReadableDocs(
  cwd: string | undefined,
  sources: ArtifactSources,
): DocEntry[] {
  const workspace = cwd ? collectDocs(cwd) : [];
  const materials = collectTaskMaterialDocs(sources.taskMaterialRoot);
  if (sources.analysisStory) {
    const draft = workspace.find((doc) => doc.meta.name === sources.analysisStory);
    if (draft) {
      workspace.splice(workspace.indexOf(draft), 1);
      if (!sources.publishedStory && !materials.some((doc) => doc.meta.name === OVERALL_STORY_ARTIFACT)) {
        materials.push({ ...draft, meta: { ...draft.meta, name: OVERALL_STORY_ARTIFACT,
          label: draft.meta.label, purpose: "overall_story" } });
      }
    }
  }
  return [...workspace, ...materials, ...collectPipelineDocs(sources.pipelineRoot)];
}

/** 打包主任务工作台“过程文档”。集合与列表/单篇读取共用同一白名单，
 * 只收真实 Markdown，不把“工作区变更”这个虚拟 diff 混进来。包内读取
 * 完整原文件，不受页面 512 KB 阅读截断影响。 */
export function bundleArtifactDocuments(
  cwd: string | undefined,
  sources: ArtifactSources = {},
): ArtifactDocumentsArchive | undefined {
  const docs = collectReadableDocs(cwd, sources);
  if (!docs.length) return undefined;
  if (docs.length > ARTIFACT_ARCHIVE_MAX_FILES) {
    throw new ArtifactArchiveTooLargeError(
      `过程文档超过 ${ARTIFACT_ARCHIVE_MAX_FILES} 份,请先整理后再打包`);
  }

  const entries: Array<{ name: string; content: Buffer; modifiedAt: Date }> = [];
  let sourceBytes = 0;
  for (const doc of docs) {
    try {
      // 扫描后文件可能被替换成符号链接；与 readArtifact 一样，打包前
      // 再用真实路径核对白名单根，不能让 ZIP 成为越界读取旁路。
      const root = realpathSync(doc.root);
      const target = realpathSync(doc.path);
      if (target !== root && !target.startsWith(root + sep)) continue;
      const info = statSync(target);
      if (!info.isFile()) continue;
      const content = readFileSync(target);
      sourceBytes += content.length;
      if (sourceBytes > ARTIFACT_ARCHIVE_MAX_BYTES) {
        throw new ArtifactArchiveTooLargeError(
          "过程文档合计超过 64 MiB,请先整理后再打包");
      }
      entries.push({ name: doc.meta.name, content, modifiedAt: info.mtime });
    } catch (reason) {
      if (reason instanceof ArtifactArchiveTooLargeError) throw reason;
      // 文件扫描后消失/暂时不可读：旁路 fail-open，别的文档照常下载。
    }
  }
  if (!entries.length) return undefined;
  return {
    data: createZipArchive(entries),
    files: entries.length,
    sourceBytes,
  };
}

/** git 子进程:失败一律返回 undefined(不是 git 仓、git 不在、超时)。 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    const command = args[0] === "diff"
      ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
      : args;
    // Git 默认把中文路径转成八进制转义；那串展示文本既找不到真实文件，
    // 也无法和按需读取请求命中。关闭 quotePath 后仍由参数数组和 `--`
    // 负责安全边界，路径只恢复成人实际看到的 UTF-8 名字。
    const hardened = ["-c", "core.quotepath=false", ...command];
    const run = runSafeWorktreeGit(cwd, hardened, {
      maxBuffer: 16 * 1024 * 1024,
      timeoutMs: 10_000,
    });
    if (run.error || run.status !== 0) return undefined;
    return run.stdout ?? "";
  } catch {
    return undefined;
  }
}

async function gitAsync(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const command = args[0] === "diff"
      ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
      : args;
    const hardened = ["-c", "core.quotepath=false", ...command];
    const run = await runSafeWorktreeGitAsync(cwd, hardened, {
      maxBuffer: 16 * 1024 * 1024,
      timeoutMs: 10_000,
    });
    if (run.error || run.status !== 0) return undefined;
    return run.stdout;
  } catch {
    return undefined;
  }
}

/** 当前工作区分支。detached HEAD 仍给出短提交，避免把真实状态误报成
 * “未知分支”。 */
function currentBranch(cwd: string): string | undefined {
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    ?.trim();
  if (branch) return branch;
  const head = git(cwd, ["rev-parse", "--short", "HEAD"])?.trim();
  return head ? `detached@${head}` : undefined;
}

async function currentBranchAsync(cwd: string): Promise<string | undefined> {
  const branch = (await gitAsync(
    cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();
  if (branch) return branch;
  const head = (await gitAsync(cwd, ["rev-parse", "--short", "HEAD"]))?.trim();
  return head ? `detached@${head}` : undefined;
}

/** 未跟踪文件相对于 /dev/null 的统一 diff。
 * `git diff --no-index` 发现差异时按约定返回 1,这里的 1 是成功结果,
 * 不是执行失败。二进制文件也会由 git 给出如实提示。 */
function untrackedDiff(cwd: string, path: string): string | undefined {
  try {
    const run = runSafeWorktreeGit(cwd, [
      "diff", "--no-ext-diff", "--no-textconv", "--no-index",
      "--", "/dev/null", path,
    ], { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 });
    if (run.error || (run.status !== 0 && run.status !== 1)) return undefined;
    return (run.stdout ?? "").trim();
  } catch {
    return undefined;
  }
}

async function untrackedDiffAsync(
  cwd: string,
  path: string,
): Promise<string | undefined> {
  try {
    const run = await runSafeWorktreeGitAsync(cwd, [
      "diff", "--no-ext-diff", "--no-textconv", "--no-index",
      "--", "/dev/null", path,
    ], { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 });
    if (run.error && run.status !== 1) return undefined;
    if (run.status !== 0 && run.status !== 1) return undefined;
    return run.stdout.trim();
  } catch {
    return undefined;
  }
}

/** porcelain 行 → 改动路径(重命名行取箭头右边的新名字)。 */
function changedPaths(status: string): string[] {
  return status.split("\n")
    .flatMap((line) => {
      const raw = line.slice(3).trim();
      if (!raw) return [];
      const arrow = raw.split(" -> ");
      const path = decodeGitQuotedPath(arrow[1] ?? arrow[0]);
      // 中心服务注入的是未跟踪运行资产：旧现场即使本地 exclude 缺失，
      // 也不能让它们混进检视/交付清单。已暂存或已提交的异常路径仍
      // 保留可见，交给推送硬闸明确报错，不能在 UI 里偷偷藏掉。
      return isFlowControlPath(path)
        || (line.startsWith("??") && isAgentPlatformPath(path)) ? [] : [path];
    });
}

type ChangeOrigin = Exclude<ArtifactChangeStage, "untracked">;

const ORIGIN_HEADING: Record<ChangeOrigin, string> = {
  committed: "已提交(committed)",
  committed_working: "已提交后又修改(committed-working)",
  staged: "已暂存(staged)",
  staged_working: "已暂存后又修改(staged-working)",
  unstaged: "未暂存(unstaged)",
};

/** 展示和交付只比较 MR 净贡献，已合入目标分支的内容不算本任务改动。
 * 没有远端目标引用的旧现场仍用任务起点；历史完整性另读 frozenTaskBaseline。 */
function taskBaseline(cwd: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
    const target = String(state?.config?.["基线分支"] ?? "").trim();
    if (target && git(cwd, ["check-ref-format", "--branch", target]) !== undefined) {
      const bases = git(cwd, ["merge-base", "--all", "HEAD", `refs/remotes/origin/${target}`])?.trim().split(/\s+/);
      if (bases?.length === 1 && bases[0]) return bases[0];
    }
    const recorded = [
      state?.step_heads?.branch_create,
      state?.step_heads?.workflow_select,
    ].find((value) => typeof value === "string" && value.trim());
    if (recorded
        && git(cwd, ["cat-file", "-e", `${recorded}^{commit}`]) !== undefined) {
      return String(recorded);
    }
    const branch = String(state?.config?.["基线分支"] ?? "").trim();
    if (branch) {
      for (const ref of [branch, `origin/${branch}`]) {
        const base = git(cwd, ["merge-base", "HEAD", ref])?.trim();
        if (base) return base;
      }
    }
  } catch {
    // 旧现场或半写 JSON:继续尝试 Git 自己的远端默认分支。
  }
  return git(cwd, ["merge-base", "HEAD", "origin/HEAD"])?.trim()
    || undefined;
}

/** 定格基线的**不自愈**读法:只认内核建分支时记录的 step_heads。
 * taskBaselineAsync 的 merge-base 回退是给 diff 展示兜底的——它永远
 * 返回 HEAD 的祖先,用它做祖先门禁等于门禁永远绿(MFC-036 教训),
 * 所以祖先校验必须走这里;没记录就返回 undefined,让调用方明确跳过。 */
export async function frozenTaskBaseline(
  cwd: string,
): Promise<string | undefined> {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
    const recorded = [
      state?.step_heads?.branch_create,
      state?.step_heads?.workflow_select,
    ].find((value) => typeof value === "string" && value.trim());
    return recorded ? String(recorded).trim() : undefined;
  } catch {
    return undefined;
  }
}

async function taskBaselineAsync(cwd: string): Promise<string | undefined> {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
    const target = String(state?.config?.["基线分支"] ?? "").trim();
    if (target && await gitAsync(cwd, ["check-ref-format", "--branch", target]) !== undefined) {
      const bases = (await gitAsync(cwd, ["merge-base", "--all", "HEAD", `refs/remotes/origin/${target}`]))?.trim().split(/\s+/);
      if (bases?.length === 1 && bases[0]) return bases[0];
    }
    const recorded = [
      state?.step_heads?.branch_create,
      state?.step_heads?.workflow_select,
    ].find((value) => typeof value === "string" && value.trim());
    if (recorded
        && await gitAsync(cwd, ["cat-file", "-e", `${recorded}^{commit}`])
          !== undefined) {
      return String(recorded);
    }
    const branch = String(state?.config?.["基线分支"] ?? "").trim();
    if (branch) {
      for (const ref of [branch, `origin/${branch}`]) {
        const base = (await gitAsync(cwd, ["merge-base", "HEAD", ref]))?.trim();
        if (base) return base;
      }
    }
  } catch {
    // 与同步旁路一致：旧现场继续尝试 Git 的远端默认分支。
  }
  return (await gitAsync(cwd, ["merge-base", "HEAD", "origin/HEAD"]))?.trim()
    || undefined;
}

function uniqueBusinessPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) =>
    path && !isFlowControlPath(path)))].sort((left, right) =>
      left.localeCompare(right));
}

/** 提交清单的服务端事实来源。只调用安全 Git 读侧，不接受调用方传入
 * revision/path 参与命令拼装；基线缺席时无法证明 HEAD 哪些改动属于
 * 本任务，因此 committed_paths 保守返回空数组。 */
export async function deliveryChangeSnapshot(
  cwd: string,
): Promise<DeliveryChangeSnapshot | undefined> {
  const toplevel = (await gitAsync(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  let sameRoot = false;
  try {
    sameRoot = !!toplevel && realpathSync(toplevel) === realpathSync(cwd);
  } catch {
    sameRoot = false;
  }
  if (!sameRoot) return undefined;
  const [headText, status, baseline, untrackedText] = await Promise.all([
    gitAsync(cwd, ["rev-parse", "--verify", "HEAD"]),
    gitAsync(cwd, ["status", "--porcelain", "-z", "--untracked-files=no"]),
    taskBaselineAsync(cwd),
    gitAsync(cwd, ["ls-files", "--others", "--exclude-standard", "-z",
      ...DELIVERY_UNTRACKED_EXCLUDES.map((pattern) => `--exclude=${pattern}`)]),
  ]);
  const head = String(headText ?? "").trim();
  if (!head || status === undefined || untrackedText === undefined) return undefined;
  const [committedText, addedAgentText] = baseline
    ? await Promise.all([
        gitAsync(cwd, ["diff", "--name-only", "-z", baseline, "HEAD", "--"]),
        // 查整个提交区间而非最终树差异：先提交注入 Skill、后续再删除，
        // 相关 blob/commit 仍会被 push，不能被最终“看起来已删”绕过。
        gitAsync(cwd, [
          "log", "--format=", "--name-only", "-z", "--diff-filter=A",
          `${baseline}..HEAD`, "--", ...AGENT_PLATFORM_ROOTS,
        ]),
      ])
    : [undefined, undefined];
  const committed = uniqueBusinessPaths(gitNullPaths(committedText ?? ""));
  const addedAgentPaths = [...new Set(String(addedAgentText ?? "")
    .split("\0").map((path) => path.trim())
    .filter((path) => isAgentPlatformPath(path)))]
    .sort((left, right) => left.localeCompare(right));
  return {
    ...(baseline ? { baseline } : {}),
    head,
    workspace_paths: uniqueBusinessPaths([
      ...committed,
      ...gitStatusPaths(status).map(entry => entry.path),
      ...untrackedText.split("\0").filter((path) => !isAgentPlatformPath(path)),
    ]),
    committed_paths: committed,
    added_agent_platform_paths: addedAgentPaths,
  };
}

function exactCommitId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

/** 给检视页生成“触发这次修改的代码 → 当前待推送代码”。两个 revision
 * 都必须是内部已经解析出的完整提交 id，且 from 必须是 to 的祖先；
 * 页面不能传任意 ref/path 参与 Git 参数。 */
export async function compareDeliveryRevisions(
  cwd: string,
  from: string,
  to: string,
  // 比较范围导航只需变更片段，不读取未修改的全文。
  options: { compact?: boolean } = {},
): Promise<DeliveryRevisionComparison | undefined> {
  if (!exactCommitId(from) || !exactCommitId(to) || from === to) {
    return undefined;
  }
  const toplevel = (await gitAsync(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  let sameRoot = false;
  try {
    sameRoot = !!toplevel && realpathSync(toplevel) === realpathSync(cwd);
  } catch {
    sameRoot = false;
  }
  if (!sameRoot) return undefined;
  const [fromCommit, toCommit, ancestor] = await Promise.all([
    gitAsync(cwd, ["cat-file", "-e", `${from}^{commit}`]),
    gitAsync(cwd, ["cat-file", "-e", `${to}^{commit}`]),
    gitAsync(cwd, ["merge-base", "--is-ancestor", from, to]),
  ]);
  if (fromCommit === undefined || toCommit === undefined
      || ancestor === undefined) return undefined;
  const [raw, log] = await Promise.all([
    gitAsync(cwd, ["diff", options.compact ? "--unified=0" : "--unified=999999", from, to, "--"]),
    gitAsync(cwd, [
      "log", "--max-count=5", "--format=%h%x09%s", `${from}..${to}`, "--",
    ]),
  ]);
  if (raw === undefined) return undefined;
  const businessDiff = deliveryDiff(raw);
  const chunks = diffChunks(businessDiff);
  let additions = 0;
  let deletions = 0;
  for (const line of businessDiff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  // 这是两个 commit 的比较，不是工作区未暂存内容。复用 GitDiff 时必须
  // 带上同一份阶段标题，否则解析器会按默认值把它错标成“未暂存”。
  const reviewText = businessDiff
    ? `## 已提交(committed)\n\n${businessDiff}`
    : "当前比较范围没有代码内容变化。";
  const capped = cap(reviewText);
  const commits = String(log ?? "").split("\n").flatMap((line) => {
    const [sha, ...subject] = line.split("\t");
    return sha && subject.length
      ? [{ sha, subject: subject.join("\t").trim() }]
      : [];
  });
  return {
    from,
    to,
    content: capped.content,
    truncated: capped.truncated,
    paths: uniqueBusinessPaths(chunks.map((chunk) => chunk.path)),
    additions,
    deletions,
    commits,
    branch: await currentBranchAsync(cwd),
  };
}

async function untrackedSnapshots(
  cwd: string,
  paths: string[],
): Promise<string[]> {
  const snapshots = paths.map((path) => `?? ${path}`);
  const detailed = Math.min(paths.length, MAX_UNTRACKED_DIFF_FILES);
  let next = 0;
  const worker = async () => {
    while (next < detailed) {
      const index = next;
      next += 1;
      snapshots[index] = await untrackedDiffAsync(cwd, paths[index])
        || snapshots[index];
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(UNTRACKED_DIFF_CONCURRENCY, detailed) }, worker));
  return snapshots;
}

function diffChunks(text: string): Array<{ path: string; text: string }> {
  return text.split(/(?=^diff --git )/m).map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return header ? [{ path: header[2], text: chunk }] : [];
    });
}

/** 从聚合 diff 中只保留业务文件。不能只过滤 untracked：旧现场若曾把
 * 状态文件暂存或提交，仍不该在代码审阅里重新出现。 */
function deliveryDiff(text: string): string {
  return diffChunks(text)
    .filter((chunk) => !isFlowControlPath(chunk.path))
    .map((chunk) => chunk.text)
    .join("\n\n");
}

function statusEntries(status: string): Map<string, { x: string; y: string }> {
  const entries = new Map<string, { x: string; y: string }>();
  for (const line of status.split("\n")) {
    if (line.length < 4 || line.startsWith("??")) continue;
    const arrow = line.slice(3).trim().split(" -> ");
    const path = decodeGitQuotedPath(arrow[1] ?? arrow[0]);
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

type FileLineStats = Pick<ArtifactChangeFile, "additions" | "deletions" | "stats_status">;
const unavailableStats: FileLineStats = { additions: 0, deletions: 0, stats_status: "unavailable" };

/** --numstat -z 的重命名项是「计数\0旧路径\0新路径」，不能按展示用箭头拆分。 */
function numstatByPath(text: string): Map<string, FileLineStats> {
  const stats = new Map<string, FileLineStats>();
  const fields = text.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]);
    if (!match) continue;
    let path = match[3];
    if (!path) { index++; path = fields[++index]; }
    if (!path || isFlowControlPath(path)) continue;
    stats.set(path, match[1] === "-" || match[2] === "-"
      ? { additions: 0, deletions: 0, stats_status: "binary" }
      : { additions: Number(match[1]), deletions: Number(match[2]) });
  }
  return stats;
}

/** 未跟踪目录仍按页展开；只数本页普通小文件的行，不生成 Diff 或读取构建产物全文。 */
async function untrackedLineStats(cwd: string, paths: string[]): Promise<Map<string, FileLineStats>> {
  const result = new Map<string, FileLineStats>();
  const root = await realpathAsync(cwd);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, paths.length)}, async () => {
    while (next < paths.length) {
      const path = paths[next++];
      result.set(path, unavailableStats);
      let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
      try {
        const target = await realpathAsync(join(root, path));
        if (!target.startsWith(root + sep)) continue;
        handle = await openAsync(join(root, path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES) continue;
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== info.size) continue; // 文件写入中，不能把半份正文当完整统计。
        const content = buffer.subarray(0, length);
        if (content.subarray(0, 8000).includes(0)) {
          result.set(path, {additions:0, deletions:0, stats_status:"binary"}); continue;
        }
        let lines = 0;
        for (const byte of content) if (byte === 10) lines++;
        if (length && content[length - 1] !== 10) lines++;
        result.set(path, {additions:lines, deletions:0});
      } catch { /* 不可读文件保持未知，不影响其他文件或伪造零行。 */ }
      finally { await handle?.close(); }
    }
  }));
  return result;
}

/**
 * 目录树只需要路径、来源与小体积 numstat，绝不能为列 186 个名字先
 * 生成 186 份全文 diff。此前列表接口复用了 `--unified=999999` 的聚合
 * 正文，既慢，又让 512 KB 正文上限和文件总数形成两套口径。
 */
async function collectDiffManifestAsync(
  cwd: string,
): Promise<{
  files: ArtifactChangeFile[];
  untrackedDirectories: ArtifactChangeDirectory[];
} | undefined> {
  const toplevel = (await gitAsync(cwd, ["rev-parse", "--show-toplevel"]))
    ?.trim();
  let sameRoot = false;
  try {
    sameRoot = !!toplevel && realpathSync(toplevel) === realpathSync(cwd);
  } catch {
    sameRoot = false;
  }
  if (!sameRoot) return undefined;
  const [status, baseline] = await Promise.all([
    // `all` 会把 target/build 等目录里的每个编译产物逐条展开。一个
    // 正常 C++ 构建即可制造数万行 JSON 和 DOM；`normal` 保留真实
    // 文件，同时把全新目录表示成一个可按需展开的根节点。
    gitAsync(cwd, ["status", "--porcelain", "--untracked-files=normal"]),
    taskBaselineAsync(cwd),
  ]);
  if (status === undefined) return undefined;
  const [committedText, numstatText] = await Promise.all([
    baseline
      ? gitAsync(cwd, ["diff", "--name-only", "-z", baseline, "HEAD", "--"])
      : Promise.resolve(undefined),
    gitAsync(cwd, ["diff", "--numstat", "-z", baseline ?? "HEAD", "--"]),
  ]);
  const committed = new Set(uniqueBusinessPaths(
    gitNullPaths(committedText ?? "")));
  const statusLines = status.split("\n");
  const statuses = statusEntries(status);
  const untrackedLines = statusLines.filter((line) => line.startsWith("??"));
  const untrackedDirectories = uniqueBusinessPaths(untrackedLines
    .map((line) => decodeGitQuotedPath(line.slice(3).trim()))
    .filter((path) => path.endsWith("/"))
    .map((path) => path.replace(/\/$/, ""))
    .filter((path) => !isFlowControlPath(path)
      && !isAgentPlatformPath(path)))
    .map((path) => ({ path, stage: "untracked" as const }));
  const untracked = new Set(changedPaths(untrackedLines
    .filter((line) => !line.slice(3).trim().endsWith("/"))
    .join("\n")));
  const stats = numstatByPath(numstatText ?? "");
  for (const [path, stat] of await untrackedLineStats(cwd, [...untracked].slice(0, 200))) stats.set(path, stat);
  const paths = uniqueBusinessPaths([
    ...committed,
    ...changedPaths(statusLines.filter((line) => !line.startsWith("??"))
      .join("\n")),
    ...untracked,
  ]);
  const files = paths.map((path) => {
    const stat = stats.get(path) ?? (numstatText !== undefined && !untracked.has(path)
      ? { additions: 0, deletions: 0 } : unavailableStats);
    return {
      path,
      stage: untracked.has(path)
        ? "untracked" as const
        : originOf(path, committed, statuses),
      ...stat,
    };
  });
  return { files, untrackedDirectories };
}

/** 本任务变更快照:任务基线到当前工作区,包含已提交、未提交与未跟踪。
 * 基线不可用时退化为原有的工作区状态,旁路不因旧现场失效。 */
function collectDiff(
  cwd: string,
): { text: string; changed: string[] } | undefined {
  // cwd 必须**就是**仓库顶层才谈变更:git -C 会向上爬认包住它的任何
  // 仓——分析单的 cwd(repositories/ 聚合目录)不是 git 仓,部署形态
  // 里它上层往往就是部署仓自己,于是 .tasks 现场全被当"未提交改动"
  // 端给用户看(内网实锤:一堆莫名其妙的未渲染文本)。不是仓顶层=
  // 本任务没有可谈的工作区变更,如实返回空。
  const toplevel = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  let sameRoot = false;
  try {
    sameRoot = !!toplevel && realpathSync(toplevel) === realpathSync(cwd);
  } catch {
    sameRoot = false;
  }
  if (!sameRoot) return undefined;
  // 展开未跟踪目录到文件级,前端才能把其中的文档/测试/配置正确分类。
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === undefined) return undefined;
  const worktreeChanged = changedPaths(status);
  // 把完整上下文带回前端，再由审阅器默认折叠未改动区。只取 Git 默认
  // 的三行上下文会让“展开全文”永远缺材料，也无法复现内核看板的能力。
  const fullContext = "--unified=999999";
  const untracked = status.split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => decodeGitQuotedPath(line.slice(3).trim()))
    .filter((path) => path && !isFlowControlPath(path)
      && !isAgentPlatformPath(path));
  const baseline = taskBaseline(cwd);
  const sections: string[] = [];
  let trackedPaths: string[] = [];
  if (baseline) {
    const aggregate = (git(cwd, ["diff", fullContext, baseline, "--"]) ?? "").trim();
    const committed = new Set((git(cwd,
      ["diff", "--name-only", "-z", baseline, "HEAD", "--"]) ?? "")
      .split("\0").filter(Boolean));
    const statuses = statusEntries(status);
    const grouped = new Map<ChangeOrigin, string[]>();
    for (const chunk of diffChunks(aggregate)
      .filter((item) => !isFlowControlPath(item.path))) {
      trackedPaths.push(chunk.path);
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
    const staged = deliveryDiff(
      (git(cwd, ["diff", "--cached", fullContext]) ?? "").trim());
    const unstaged = deliveryDiff(
      (git(cwd, ["diff", fullContext]) ?? "").trim());
    if (staged) sections.push(`## ${ORIGIN_HEADING.staged}\n\n${staged}`);
    if (unstaged) sections.push(`## ${ORIGIN_HEADING.unstaged}\n\n${unstaged}`);
    trackedPaths = worktreeChanged.filter((path) => !untracked.includes(path));
  }
  if (untracked.length) {
    // 上限与异步侧同一口径(内网实锤:5014 个未跟踪编译产物 × 每个
    // 一次同步 git diff = 主线程连堵 20 秒,全站 HTTP 全部超时)。
    // 超限的只列 `?? 路径` 不展开内容——列表完整,细节有帽。
    const snapshots = untracked.map((path, index) =>
      (index < MAX_UNTRACKED_DIFF_FILES && untrackedDiff(cwd, path))
        || `?? ${path}`);
    sections.push(`## 未跟踪(untracked)\n\n${snapshots.join("\n\n")}`);
  }
  const changed = Array.from(new Set([...trackedPaths, ...untracked]));
  if (!sections.length) {
    return { text: "本任务暂无代码变更。", changed };
  }
  return { text: sections.join("\n\n"), changed };
}

async function collectDiffAsync(
  cwd: string,
): Promise<{ text: string; changed: string[] } | undefined> {
  const toplevel = (await gitAsync(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  let sameRoot = false;
  try {
    sameRoot = !!toplevel && realpathSync(toplevel) === realpathSync(cwd);
  } catch {
    sameRoot = false;
  }
  if (!sameRoot) return undefined;
  const status = await gitAsync(
    cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === undefined) return undefined;
  const worktreeChanged = changedPaths(status);
  const fullContext = "--unified=999999";
  const untracked = status.split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => decodeGitQuotedPath(line.slice(3).trim()))
    .filter((path) => path && !isFlowControlPath(path)
      && !isAgentPlatformPath(path));
  const baseline = await taskBaselineAsync(cwd);
  const sections: string[] = [];
  let trackedPaths: string[] = [];
  if (baseline) {
    const [aggregateText, committedText] = await Promise.all([
      gitAsync(cwd, ["diff", fullContext, baseline, "--"]),
      gitAsync(cwd, ["diff", "--name-only", "-z", baseline, "HEAD", "--"]),
    ]);
    const aggregate = (aggregateText ?? "").trim();
    const committed = new Set((committedText ?? "")
      .split("\0").filter(Boolean));
    const statuses = statusEntries(status);
    const grouped = new Map<ChangeOrigin, string[]>();
    for (const chunk of diffChunks(aggregate)
      .filter((item) => !isFlowControlPath(item.path))) {
      trackedPaths.push(chunk.path);
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
    const [stagedText, unstagedText] = await Promise.all([
      gitAsync(cwd, ["diff", "--cached", fullContext]),
      gitAsync(cwd, ["diff", fullContext]),
    ]);
    const staged = deliveryDiff((stagedText ?? "").trim());
    const unstaged = deliveryDiff((unstagedText ?? "").trim());
    if (staged) sections.push(`## ${ORIGIN_HEADING.staged}\n\n${staged}`);
    if (unstaged) sections.push(`## ${ORIGIN_HEADING.unstaged}\n\n${unstaged}`);
    trackedPaths = worktreeChanged.filter((path) => !untracked.includes(path));
  }
  if (untracked.length) {
    const snapshots = await untrackedSnapshots(cwd, untracked);
    sections.push(`## 未跟踪(untracked)\n\n${snapshots.join("\n\n")}`);
  }
  const changed = Array.from(new Set([...trackedPaths, ...untracked]));
  return {
    text: sections.length ? sections.join("\n\n") : "本任务暂无代码变更。",
    changed,
  };
}

/** 本任务变更的元信息。时间取"改动文件里最新的那个 mtime":
 * 工作区干净时退回目录时间,免得一个空 diff 长期霸占列表首位。 */
function diffMetaFromSnapshot(
  cwd: string,
  diff: { text: string; changed: string[] } | undefined,
  changeFiles?: ArtifactChangeFile[],
): ArtifactMeta | undefined {
  if (!diff) return undefined;
  let newest = 0;
  for (const path of diff.changed) {
    try {
      newest = Math.max(newest, statSync(join(cwd, path)).mtimeMs);
    } catch {
      // 改动项可能是已删除文件:取不到时间就跳过。
    }
  }
  if (!newest) {
    try {
      newest = statSync(cwd).mtimeMs;
    } catch {
      newest = 0;
    }
  }
  return {
    name: DIFF_NAME,
    label: "本任务变更",
    kind: "diff",
    bytes: Buffer.byteLength(diff.text, "utf-8"),
    modified_at: new Date(newest).toISOString(),
    file_count: diff.changed.length,
    ...(changeFiles ? { change_files: changeFiles } : {}),
  };
}

function diffMetaFromManifest(
  cwd: string,
  manifest: Awaited<ReturnType<typeof collectDiffManifestAsync>>,
): ArtifactMeta | undefined {
  if (!manifest) return undefined;
  const changed = [
    ...manifest.files.map((file) => file.path),
    ...manifest.untrackedDirectories.map((directory) => directory.path),
  ];
  // bytes 在虚拟产物上只用于轻量展示；用清单体积而非生成一份可能数十
  // MiB 的聚合正文。文件内容在点开后单独读取。
  const meta = diffMetaFromSnapshot(cwd, {
    text: changed.length ? changed.join("\n") : "本任务暂无代码变更。",
    changed,
  }, manifest.files);
  if (!meta) return undefined;
  return {
    ...meta,
    file_count: manifest.files.length,
    ...(manifest.untrackedDirectories.length
      ? { untracked_directories: manifest.untrackedDirectories } : {}),
  };
}

function diffMeta(cwd: string): ArtifactMeta | undefined {
  return diffMetaFromSnapshot(cwd, collectDiff(cwd));
}

/** 截断到字节上限。按字节切会把 UTF-8 多字节字符切一半,
 * 末尾的替换符直接抹掉——宁可少一个字,不给用户看乱码。 */
function cap(text: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= MAX_BYTES) {
    return { content: text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf-8")
    .subarray(0, MAX_BYTES)
    .toString("utf-8")
    .replace(/�+$/, "");
  return { content: clipped + TRUNCATED_NOTE, truncated: true };
}

function readCapped(path: string): { content: string; truncated: boolean } | undefined {
  try {
    const info = statSync(path);
    if (info.size <= MAX_BYTES) {
      return { content: readFileSync(path, "utf-8"), truncated: false };
    }
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_BYTES);
      const read = readSync(handle, buffer, 0, MAX_BYTES, 0);
      const content = buffer.subarray(0, read).toString("utf-8")
        .replace(/�+$/, "");
      return { content: content + TRUNCATED_NOTE, truncated: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

/**
 * 列出可检视的产物,最近修改的在前。
 * 任何一路出问题只让那一路缺席,永远返回数组。
 */
export function listArtifacts(
  cwd: string | undefined,
  sources: ArtifactSources = {},
): ArtifactMeta[] {
  const items: ArtifactMeta[] = [];
  try {
    items.push(...collectReadableDocs(cwd, sources).map((doc) => doc.meta));
  } catch {
    // 文档一路塌了,还有 diff 一路。
  }
  try {
    const diff = cwd ? diffMeta(cwd) : undefined;
    if (diff) items.push(diff);
  } catch {
    // git 一路塌了,文档照出。
  }
  // ISO 串的字典序即时间序,倒序 = 最近修改在前。
  return items.sort((left, right) =>
    right.modified_at.localeCompare(left.modified_at));
}

/** HTTP 读侧版本：Git 子进程不阻塞事件循环，编译产生大量未跟踪文件时
 * 页面请求可以变慢，但健康检查、任务列表和其他人的工作台仍可响应。 */
export async function listArtifactsAsync(
  cwd: string | undefined,
  sources: ArtifactSources = {},
  kind?: "doc" | "diff",
): Promise<ArtifactMeta[]> {
  const items: ArtifactMeta[] = [];
  try {
    if (kind !== "diff") items.push(...collectReadableDocs(cwd, sources).map((doc) => doc.meta));
  } catch {
    // 文档一路塌了，Git 一路仍可返回。
  }
  try {
    const diff = cwd && kind !== "doc"
      ? diffMetaFromManifest(cwd, await collectDiffManifestAsync(cwd))
      : undefined;
    if (diff) items.push(diff);
  } catch {
    // 观测旁路 fail-open。
  }
  return items.sort((left, right) =>
    right.modified_at.localeCompare(left.modified_at));
}

/**
 * 读一份产物。name 必须出现在 listArtifacts 的结果里,否则一律
 * undefined——白名单是这里唯一的安全边界。
 */
export function readArtifact(
  cwd: string | undefined,
  name: string,
  sources: ArtifactSources = {},
): ArtifactContent | undefined {
  const wanted = String(name ?? "").trim();
  if (!wanted) return undefined;
  try {
    if (wanted === DIFF_NAME) {
      if (!cwd) return undefined;
      // 快照只算一次:diffMeta 内部会再跑一遍完整 collectDiff,
      // 在大工作区上等于白白双倍阻塞。
      const diff = collectDiff(cwd);
      const meta = diffMetaFromSnapshot(cwd, diff);
      if (!meta || !diff) return undefined;
      const { content, truncated } = cap(diff.text);
      return { ...meta, content, truncated, branch: currentBranch(cwd) };
    }
    const doc = collectReadableDocs(cwd, sources)
      .find((entry) => entry.meta.name === wanted);
    if (!doc) return undefined;
    // 双保险：扫描后文件可能被替换成符号链接；读取前重新 realpath，
    // 且必须仍在它所属的白名单根目录内。
    const root = realpathSync(doc.root);
    const target = realpathSync(doc.path);
    if (target !== root && !target.startsWith(root + sep)) return undefined;
    const read = readCapped(target);
    if (!read) return undefined;
    return { ...doc.meta, content: read.content, truncated: read.truncated };
  } catch {
    return undefined;
  }
}

export async function readArtifactAsync(
  cwd: string | undefined,
  name: string,
  sources: ArtifactSources = {},
): Promise<ArtifactContent | undefined> {
  const wanted = String(name ?? "").trim();
  if (!wanted) return undefined;
  if (wanted !== DIFF_NAME) return readArtifact(cwd, wanted, sources);
  if (!cwd) return undefined;
  try {
    const diff = await collectDiffAsync(cwd);
    const meta = diffMetaFromSnapshot(cwd, diff);
    if (!meta || !diff) return undefined;
    const { content, truncated } = cap(diff.text);
    return {
      ...meta,
      content,
      truncated,
      branch: await currentBranchAsync(cwd),
    };
  } catch {
    return undefined;
  }
}

function safeArtifactRelativePath(cwd: string, input: string): string | undefined {
  const wanted = String(input ?? "").trim().replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!wanted || wanted.includes("\0") || wanted.startsWith("/")
      || wanted.split("/").some((part) => !part || part === "." || part === "..")
      || isFlowControlPath(wanted) || isAgentPlatformPath(wanted)) {
    return undefined;
  }
  const root = resolve(cwd);
  const target = resolve(root, wanted);
  return target.startsWith(root + sep) ? wanted : undefined;
}

/**
 * 只核对一个文件是否仍属于当前变更，而不是为了打开一份正文重新扫描
 * 整个工作区。目录清单可以有数万项，逐文件读取必须保持 O(该路径)。
 */
async function changeFileAtPathAsync(
  cwd: string,
  wanted: string,
): Promise<{ path: string; stage: ArtifactChangeFile["stage"]; baseline?: string } | undefined> {
  const [baseline, status, untrackedText] = await Promise.all([
    taskBaselineAsync(cwd),
    gitAsync(cwd, ["status", "--porcelain", "--untracked-files=all",
      "--", wanted]),
    gitAsync(cwd, ["ls-files", "-z", "--others", "--exclude-standard",
      "--", wanted]),
  ]);
  if (status === undefined || untrackedText === undefined) return undefined;
  const untracked = untrackedText.split("\0").some((path) => path === wanted);
  if (untracked) {
    return { path: wanted, stage: "untracked", baseline };
  }
  const committedText = baseline
    ? await gitAsync(cwd, ["diff", "--name-only", "-z", baseline, "HEAD", "--", wanted])
    : undefined;
  const committed = new Set(uniqueBusinessPaths(
    gitNullPaths(committedText ?? "")));
  const statuses = statusEntries(status);
  if (!committed.has(wanted) && !statuses.has(wanted)) return undefined;

  return {
    path: wanted,
    stage: originOf(wanted, committed, statuses),
    baseline,
  };
}

/**
 * 展开一个未跟踪目录的下一层。Git 仍负责 `.gitignore` 语义；宿主只
 * 聚合直接子项并分页，所以即使目录里有六万多个编译产物，HTTP 响应
 * 和浏览器 DOM 也始终有界。
 */
export async function listArtifactChangeDirectoryAsync(
  cwd: string | undefined,
  path: string,
  offset = 0,
  limit = 200,
): Promise<ArtifactChangeDirectoryPage | undefined> {
  if (!cwd) return undefined;
  const wanted = safeArtifactRelativePath(cwd, path);
  if (!wanted) return undefined;
  try {
    const root = realpathSync(cwd);
    const target = realpathSync(join(cwd, wanted));
    if ((target !== root && !target.startsWith(root + sep))
        || !statSync(target).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const listed = await gitAsync(cwd, [
    "ls-files", "-z", "--others", "--exclude-standard", "--", `${wanted}/`,
  ]);
  if (listed === undefined) return undefined;
  const prefix = `${wanted}/`;
  const nodes = new Map<string, ArtifactChangeDirectoryEntry>();
  let totalFiles = 0;
  for (const file of listed.split("\0")) {
    if (!file.startsWith(prefix) || file === prefix
        || isFlowControlPath(file) || isAgentPlatformPath(file)) continue;
    const relative = file.slice(prefix.length);
    const first = relative.split("/")[0];
    if (!first) continue;
    totalFiles += 1;
    const childPath = `${prefix}${first}`;
    const directory = relative.includes("/");
    const existing = nodes.get(childPath);
    if (existing) {
      if (directory) existing.file_count += 1;
      continue;
    }
    nodes.set(childPath, {
      path: childPath,
      kind: directory ? "directory" : "file",
      file_count: 1,
      stage: "untracked",
    });
  }
  if (!totalFiles) return undefined;
  const entries = [...nodes.values()].sort((left, right) =>
    left.kind === right.kind
      ? left.path.localeCompare(right.path)
      : left.kind === "directory" ? -1 : 1);
  const pageOffset = Math.max(0, Math.floor(offset));
  const pageLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const end = Math.min(entries.length, pageOffset + pageLimit);
  const pageEntries = entries.slice(pageOffset, end);
  const stats = await untrackedLineStats(cwd, pageEntries.filter(entry => entry.kind === "file").map(entry => entry.path));
  return {
    path: wanted,
    entries: pageEntries.map(entry => entry.kind === "file" ? { ...entry, ...stats.get(entry.path) } : entry),
    total_entries: entries.length,
    total_files: totalFiles,
    ...(end < entries.length ? { next_offset: end } : {}),
  };
}

/**
 * 按完整清单中的一个路径读取正文。请求路径必须先命中 Git 现算清单，
 * 随后才作为 `--` 后的参数交给 Git；既避免路径穿越，也避免浏览器传
 * 任意路径读取仓库外文件。每个文件单独享有 512 KB 阅读预算。
 */
export async function readArtifactFileDiffAsync(
  cwd: string | undefined,
  path: string,
): Promise<ArtifactFileDiff | undefined> {
  if (!cwd) return undefined;
  const wanted = safeArtifactRelativePath(cwd, path);
  if (!wanted) return undefined;
  try {
    const file = await changeFileAtPathAsync(cwd, wanted);
    if (!file) return undefined;
    let raw: string | undefined;
    let heading: string;
    if (file.stage === "untracked") {
      raw = await untrackedDiffAsync(cwd, file.path);
      heading = "未跟踪(untracked)";
    } else {
      raw = await gitAsync(cwd, [
        "diff", "--unified=999999", file.baseline ?? "HEAD", "--", file.path,
      ]);
      heading = ORIGIN_HEADING[file.stage];
    }
    if (raw === undefined) return undefined;
    const business = deliveryDiff(raw.trim());
    const text = business
      ? `## ${heading}\n\n${business}`
      : `## ${heading}\n\n?? ${file.path}`;
    const capped = cap(text);
    return {
      path: file.path,
      content: capped.content,
      truncated: capped.truncated,
      branch: await currentBranchAsync(cwd),
    };
  } catch {
    return undefined;
  }
}

/** 子任务 Story 汇总只读文档，不触发 Git diff 采集。 */
export function listArtifactDocuments(cwd: string | undefined, sources: ArtifactSources = {}): ArtifactMeta[] {
  return collectReadableDocs(cwd, sources).map((doc) => doc.meta);
}
