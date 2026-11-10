/**
 * 归档冻结快照(ADR-0042,工单 #325):会话到达任一终态(交付归档/
 * 取消/失败)的那一刻,把全部事实账投影计算一次,冻结成会话目录下的
 * metrics.json——只读、与该会话天然关联、此后不再变。
 *
 * 三条纪律(ADR-0042 的落地边界):
 * - **零新记账**:计数永远是投影。这里的全部输入都是现有账——
 *   issue.json 台账与转移账、检视账 reviews.jsonl、分析报告版本账
 *   reviews/、MR 评论的发现账 feedback/index.jsonl、平台闸作答的
 *   事件账 events.jsonl、Agent 问题卡的 waiting.json。事实仍以各账
 *   为准,快照是可重算的冻结视图,不是第二真相源。
 * - **降级总则**:任何一段投影失败(账损坏/缺失)只把该段标
 *   「不可得」并说明原因,其余照写;写盘失败由调用方兜住,绝不阻塞
 *   归档/取消/失败收口本身。
 * - **只生成一次**:metrics.json 已存在即跳过,重复的终态触发
 *   (如 failed 之后又取消)不重写。
 *
 * 「提交归属」「逐推送 diff」两层(工单 #326)在归档那一刻从会话
 * 工作区(repo/ 子树)现算:前者 fetch 远端、在目标分支历史里定位
 * 合入提交,按「合入提交的第一父..合入头」拿 MR 完整提交清单、与
 * 推送账逐提交比对标注「平台(Agent)/平台外」(MR 提交合入后全部
 * 可达自目标分支,直接拿目标分支画界会恒空),后者只读本地对象
 * 统计推送区间的文件数与增删行(平台推送的提交天然都在本地)。
 * 单仓取不到(现场已回收/分支被删/远端不可达/对象不可得)只降级
 * 那一仓的段,推送工具与推送账零改动。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { durableWriteFileSync } from "../durableWrite.ts";
import { FeedbackStore } from "../feedbackStore.ts";
import { createSafeGitView, type SafeGitView } from "../safeGit.ts";
import {
  countVerifyFailures,
  externalHeadObservations,
  isRedLightCanceledByMerge,
  isRedLightDiscardedOnHeadMove,
  isRedLightRepaired,
  ledgerPushes,
  ROLLBACK_NOTE,
  sentReviewOperations,
} from "./ledgerFacts.ts";
import { listAnalysisVersions } from "./analysisVersions.ts";
import { prepareSandbox, type GitCredential, type GitSandbox } from "./issueGit.ts";
import { reviewStore } from "./reviews.ts";
import {
  isTerminal,
  issueRepoWorkspaces,
  type IssueMrRecord,
  type IssueCancelReason,
  type IssueSessionState,
} from "./state.ts";

/** 快照文件名(会话目录根,与 issue.json 同层)。 */
export const ISSUE_METRICS_FILE = "metrics.json";

/** 快照结构的版本号:口径换版时 +1,读侧按它决定是否重算。 */
export const ISSUE_METRICS_SCHEMA_VERSION = 1;

/** 降级标记:该段取不到,unavailable 说明原因(人话)。 */
export interface IssueMetricsUnavailable {
  unavailable: string;
}

export interface IssueMetricsPushRepoStats {
  repo: string;
  /** 该仓的推送次数(转移账逐笔计)。 */
  push_count: number;
  /** 该仓历次推送的提交号(转移账记的是前 12 位,照录)。 */
  commits: string[];
  branches: string[];
}

export interface IssueMetricsSnapshot {
  schema_version: number;
  generated_at: string;
  session_id: string;
  terminal_status: "archived" | "canceled" | "failed";
  /** 终止原因(#541):canceled 终态伴生冻结,稳定英文值(词表见
   *  state.ts 的 IssueCancelReason);缺席=无原因取消(历史路径)。 */
  cancel_reason?: IssueCancelReason;
  /** 终止补充说明(#541):仅 other 原因带,选填人话,留存备分析。 */
  cancel_reason_text?: string;
  ticket?: string;
  conclusion_kind?: string;
  created_at: string;
  /** 结论时刻:结论账的 at;取消/失败没有结论,用台账的 updated_at。 */
  concluded_at: string;
  /** 发起→结论时刻的端到端时长(毫秒)。 */
  end_to_end_ms: number | IssueMetricsUnavailable;
  repo_count: number;
  repo_urls: string[];
  pushes: {
    /** 推送总次数(转移账「分支已推送」逐笔计)。 */
    total: number;
    by_repo: IssueMetricsPushRepoStats[];
    /** 每仓最新一笔推送收据(state.pushes 只留最新,原样投影)。 */
    latest: Array<{ repo: string; branch: string; sha: string; at: string }>;
  };
  reviews: {
    /** 平台检视意见条数(经本平台提交的批注,CONTEXT 词条口径)。
     *  与批次数同一份检视账,账读不了时一起降级。 */
    platform_review_comments: number | IssueMetricsUnavailable;
    /** 检视批次数(一次提交动作=一批;判定与一次率现算共享
     *  onceRates.sentReviewBatches,口径不分家)。 */
    review_batches: number | IssueMetricsUnavailable;
    /** MR 评论条数(代码托管平台侧的检视讨论,反馈账 mr_discussion 记录)。 */
    mr_comments: number | IssueMetricsUnavailable;
  };
  /** 分析报告版本数(初版=1,随修改型检视与验证打回增长;版本账现算,
   *  账读不了时降级)。 */
  report_version_count: number | IssueMetricsUnavailable;
  /** 验证未通过次数:判定与一次率现算共享 onceRates.countVerifyFailures,
   *  口径不分家。 */
  verify_fail_count: number;
  pipeline: {
    /** 红灯各轮处置结局,三分互斥(转移账文案计)。 */
    red_light_rounds: {
      /** 按失败处理进入修复分诊的红灯(「流水线失败」条目)。 */
      repaired: number;
      /** 随 MR 合入取消、不作失败处理的红灯。 */
      canceled_by_merge: number;
      /** 结果随分支头变化丢弃、不作失败处理的红灯。 */
      discarded_on_head_move: number;
    };
    /** 外部头观测(分支头被平台外推送取代的每一次发现记录):count=
     *  次数,records=每次发现的提交号短码(账面 12 位)与时刻。 */
    external_head_observations: {
      count: number;
      records: Array<{ sha: string; at: string }>;
    };
  };
  rollbacks: {
    count: number;
    /** 每轮回退的原因(转移账「第 N 轮」条目,截前 200 字)。 */
    reasons: string[];
  };
  /** 各阶段耗时(毫秒),按转移账阶段标记分段累计;回退重进的阶段累加。 */
  stage_durations_ms: Record<string, number> | IssueMetricsUnavailable;
  answers: {
    /** 平台闸(固定流程的人工硬闸)的作答事实,事件账 human_decision。 */
    platform_gates: {
      answered: number;
      by_kind: Record<string, number>;
      decisions: Record<string, number>;
    } | IssueMetricsUnavailable;
    /** Agent 问题卡(AskUserQuestion)的举卡与作答,waiting.json。 */
    agent_cards: {
      raised: number;
      answered: number;
      superseded: number;
      decisions: Record<string, number>;
    } | IssueMetricsUnavailable;
  };
  mrs: {
    total: number;
    /** 已合入(merged_at 在账)。 */
    merged: number;
    /** 未合入但已关闭(closed_at 在账)。 */
    closed: number;
    records: Array<{
      repo: string;
      branch: string;
      target?: string;
      url?: string;
      iid?: string;
      at: string;
      merged_at?: string;
      merged_sha?: string;
      closed_at?: string;
    }>;
  };
  /** 提交归属比对(工单 #326):归档时 fetch 每个 MR 的完整提交清单
   *  (区间=合入提交的第一父..合入头;见 IssueMetricsAttributionRepoOk
   *  的 list_basis),与推送账逐提交比对标注「平台(Agent)/平台外」;
   *  被强推顶掉的平台提交不在清单属正常(未被合入),推送事实层
   *  (pushes 段)仍全量保留。单仓取不到就地降级,绝不阻塞归档。 */
  commit_attribution: IssueMetricsAttributionLayer | IssueMetricsUnavailable;
  /** 逐推送 diff 统计(工单 #326):推送账相邻两笔的区间
   *  (上一笔..本笔,首笔从分支起点起算)统计文件数/增删行/
   *  仅源码增删行;只读工作区本地对象,单仓取不到就地降级。 */
  per_push_diffs: IssueMetricsPushDiffLayer | IssueMetricsUnavailable;
}

/** 现场取数口径:fetch MR 分支用的 Git 凭据(与推送工具同源的账号
 *  令牌)。缺省匿名尝试——本地路径远端可直接取,取不到就地降级。 */
export interface IssueMetricsSnapshotOptions {
  fetchCredential?: GitCredential;
}

/** MR 清单里的一个提交:归属按推送账逐提交比对(比对提交号前缀,
 *  账面记前 12 位)。被改写历史重造的提交对不上原推送号,按平台外
 *  计——它确实不是平台推送的那个提交。 */
export interface IssueMetricsAttributionCommit {
  /** 完整 40 位提交号。 */
  sha: string;
  /** platform=平台(Agent)推送在账;external=平台外提交。 */
  origin: "platform" | "external";
  author: string;
  author_email: string;
  subject: string;
}

/** 单仓的提交归属比对结果。 */
export interface IssueMetricsAttributionRepoOk {
  repo: string;
  branch: string;
  /** 清单区间怎么定的:merge_commit=在目标分支历史里定位到合入提交
   *  (父提交含合入头的那个合并提交),区间=合入提交第一父..合入头
   *  (完备,含平台外提交);merge_base=没定位到合入提交(squash 合入
   *  没有合并提交、快照滞后于合入),区间=与目标分支的分叉点..合入头
   *  (合入前快照在此口径下仍完整);merged_sha_local=fetch 不可得、
   *  退回账面合入头在本地现算(平台外提交的对象不在本地,清单可能
   *  不全,如实标注)。 */
  list_basis: "merge_commit" | "merge_base" | "merged_sha_local";
  /** 清单区间(合入提交第一父或分叉点)..合入头,从旧到新。 */
  commits: IssueMetricsAttributionCommit[];
  platform_count: number;
  external_count: number;
}

/** 单仓段:降级时 unavailable 说明原因,repo/branch 仍在(定位哪个仓)。 */
export type IssueMetricsAttributionRepo =
  | IssueMetricsAttributionRepoOk
  | (IssueMetricsUnavailable & { repo: string; branch: string });

export interface IssueMetricsAttributionLayer {
  by_repo: IssueMetricsAttributionRepo[];
}

/** 一笔平台推送的区间统计(两层口径:全部文件 与 仅源码)。 */
export interface IssueMetricsPushDiff {
  /** 本笔推送的提交号(推送账原样,前 12 位)。 */
  sha: string;
  /** 区间起点提交号(前 12 位)。 */
  base: string;
  /** 起点口径:branch_start=分支起点(与目标分支的分叉点,首笔从这里
   *  起算);previous_push=上一笔平台推送。 */
  base_kind: "branch_start" | "previous_push";
  /** 变更文件数(含文档与二进制)。 */
  files: number;
  insertions: number;
  deletions: number;
  /** 仅源码文件的增/删行(扩展名白名单 SOURCE_CODE_EXTENSIONS 判定)。 */
  source_insertions: number;
  source_deletions: number;
}

export type IssueMetricsPushDiffEntry =
  | IssueMetricsPushDiff
  | IssueMetricsUnavailable;

/** 单仓(分支)的逐推送区间链;降级时同上带 repo/branch。 */
export interface IssueMetricsPushDiffRepoOk {
  repo: string;
  branch: string;
  pushes: IssueMetricsPushDiffEntry[];
}

export type IssueMetricsPushDiffRepo =
  | IssueMetricsPushDiffRepoOk
  | (IssueMetricsUnavailable & { repo: string; branch: string });

export interface IssueMetricsPushDiffLayer {
  by_repo: IssueMetricsPushDiffRepo[];
}

export interface IssueMetricsWriteResult {
  /** 本次生成并落盘。 */
  written: boolean;
  /** 已存在,按「只生成一次」跳过。 */
  skipped: boolean;
  /** 标了「不可得」的段(路径列表,日志用)。 */
  degraded: string[];
}

// ---- 转移账文案的匹配键:统一住在 ledgerFacts(单一来源),写账文案
// 要改连那里一起改;这里只消费判定函数与解析结果。 ----

const REASON_MAX = 200;
const DECISION_MAX = 80;

/** 一段一段算:单段炸只降级那一段,其余照写。 */
function section<T>(compute: () => T): T | IssueMetricsUnavailable {
  try {
    return compute();
  } catch (error) {
    return {
      unavailable: `不可得:${
        error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function countTransitions(
  state: IssueSessionState,
  matches: (note: string) => boolean,
): number {
  return (state.transitions ?? []).filter(
    (transition) => matches(transition.note),
  ).length;
}

/** 平台闸作答的分布:事件账里带 gate 快照的 human_decision。 */
function platformGateAnswers(root: string): {
  answered: number;
  by_kind: Record<string, number>;
  decisions: Record<string, number>;
} {
  const path = join(root, "events.jsonl");
  if (!existsSync(path)) {
    return { answered: 0, by_kind: {}, decisions: {} };
  }
  const byKind: Record<string, number> = {};
  const decisions: Record<string, number> = {};
  let answered = 0;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: { kind?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 坏行跳过:事件账是投影源,不因半行残尾炸整段
    }
    if (event.kind !== "human_decision") continue;
    const payload = event.payload ?? {};
    const gate = payload.gate as { kind?: string } | undefined;
    if (!gate?.kind) continue; // 非闸决定(Agent 卡/接管)不进闸口径
    answered += 1;
    byKind[gate.kind] = (byKind[gate.kind] ?? 0) + 1;
    const decision = String(payload.decision ?? "").trim()
      .split("\n")[0].slice(0, DECISION_MAX);
    if (decision) {
      decisions[decision] = (decisions[decision] ?? 0) + 1;
    }
  }
  return { answered, by_kind: byKind, decisions };
}

/** Agent 问题卡的举卡与作答:waiting.json 的全部记录。 */
function agentCardAnswers(root: string): {
  raised: number;
  answered: number;
  superseded: number;
  decisions: Record<string, number>;
} {
  const path = join(root, "waiting.json");
  if (!existsSync(path)) {
    return { raised: 0, answered: 0, superseded: 0, decisions: {} };
  }
  const store = JSON.parse(readFileSync(path, "utf-8")) as {
    records?: Record<string, {
      status?: string;
      decision?: string;
    }>;
  };
  const decisions: Record<string, number> = {};
  let answered = 0;
  let superseded = 0;
  const records = Object.values(store.records ?? {});
  for (const record of records) {
    if (record.status === "resolved") {
      answered += 1;
      const decision = String(record.decision ?? "").trim()
        .split("\n")[0].slice(0, DECISION_MAX);
      if (decision) {
        decisions[decision] = (decisions[decision] ?? 0) + 1;
      }
    } else if (record.status === "superseded") {
      superseded += 1;
    }
  }
  return { raised: records.length, answered, superseded, decisions };
}

/** 各阶段耗时:转移账的阶段标记分段累计,末段收到结论时刻。
 *  没有任何阶段标记、或首尾时刻拼不出区间时如实降级。 */
function stageDurations(
  state: IssueSessionState,
  concludedAt: string,
): Record<string, number> {
  const marks: Array<{ stage: string; atMs: number }> = [];
  for (const transition of state.transitions ?? []) {
    if (!transition.stage) continue;
    const atMs = Date.parse(transition.at);
    if (!Number.isFinite(atMs)) continue;
    marks.push({ stage: transition.stage, atMs });
  }
  const endMs = Date.parse(concludedAt);
  if (!marks.length || !Number.isFinite(endMs)) {
    throw new Error("转移账里没有可用的阶段标记或结论时刻");
  }
  const durations: Record<string, number> = {};
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]!;
    const boundary = index + 1 < marks.length
      ? marks[index + 1]!.atMs
      : endMs;
    const segment = Math.max(0, boundary - mark.atMs);
    durations[mark.stage] = (durations[mark.stage] ?? 0) + segment;
  }
  return durations;
}

// ---- 代码现场取数(工单 #326:提交归属比对 + 逐推送 diff 统计) ----

/** 源码扩展名白名单(「仅源码增/删行」的判定口径):首版内置常见
 *  源码后缀,文档与二进制不掺水;2026-09-22 扩入配置类后缀(json/
 *  yaml/yml/xml/properties,Java 系仓库的配置改动是真工作量)——
 *  lockfile 等生成物随之灌水,知情接受,未做路径排除。口径要调整
 *  只改这一处,别在调用点散落判断。 */
export const SOURCE_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "c", "cc", "cpp",
  "cxx", "h", "hh", "hpp", "go", "rs", "cs", "kt", "swift", "rb", "php",
  "vue", "svelte", "css", "scss", "less", "html", "sql", "sh", "bash",
  "zsh", "ps1", "bat",
  "json", "xml", "yaml", "yml", "properties",
]);

/** 文件路径是否算源码(按扩展名白名单):无后缀、整名点文件
 *  (如 .gitignore)与白名单外的后缀都不算。首次生成归属层
 *  (codeOrigin.ts)同源消费,口径单一来源。 */
export function isSourcePath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  return SOURCE_CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** git 输出里的路径:带特殊字符时会被 C 风格引号包住,取掉首尾引号
 *  即可用(内部转义序列罕见,按原样容忍)。 */
function unquoteGitPath(path: string): string {
  return path.startsWith('"') && path.endsWith('"') && path.length >= 2
    ? path.slice(1, -1)
    : path;
}

/** 快照期单次 Git 命令超时:归档是收口路径,远端僵死不许拖垮收口——
 *  超时或失败都按「不可得」降级(现场还在时重算可补)。 */
const SNAPSHOT_GIT_TIMEOUT_MS = 20_000;

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** 会话根是 <数据目录>/issues/<id>:fetch 凭据沙箱挂数据目录下
 *  (与推送工具同一处 .runtime/issue-git)。 */
function dataDirOfSessionRoot(root: string): string {
  return resolve(root, "..", "..");
}

/** 会话工作区某仓的一次安全 Git 会话:受信视图(createSafeGitView 的
 *  代理 gitdir)建一次贯穿多次命令;需要 fetch 时叠凭据沙箱
 *  (prepareSandbox,与推送工具同一套加固)。 */
class WorktreeGitSession {
  private constructor(
    private readonly cwd: string,
    private readonly view: SafeGitView,
    private readonly sandbox?: GitSandbox,
  ) {}

  /** 打开;目录不是 Git 克隆返回 undefined(现场缺仓的人话理由由
   *  调用方给)。视图异常(坏仓)原样抛,由调用方降级。 */
  static open(repoDir: string, fetch?: {
    dataDir: string;
    credential?: GitCredential;
  }): WorktreeGitSession | undefined {
    if (!existsSync(join(repoDir, ".git"))) return undefined;
    return new WorktreeGitSession(
      repoDir,
      createSafeGitView(repoDir),
      fetch ? prepareSandbox(fetch.dataDir, fetch.credential, repoDir) : undefined,
    );
  }

  run(args: string[], timeoutMs = SNAPSHOT_GIT_TIMEOUT_MS): GitOutcome {
    const result = spawnSync("git", [
      ...(this.sandbox?.args ?? []),
      ...args,
    ], {
      cwd: this.cwd,
      env: this.view.environment(this.sandbox?.env),
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr
        || (result.error ? String(result.error.message) : ""),
    };
  }

  /** fetch 之后的 FETCH_HEAD 全文(记在受信代理 gitdir 里)。 */
  fetchHeadText(): string {
    try {
      return readFileSync(join(this.view.proxyGitDir, "FETCH_HEAD"), "utf-8");
    } catch {
      return "";
    }
  }

  close(): void {
    this.sandbox?.cleanup();
    this.view.cleanup();
  }
}

/** 错误输出首行(截短):降级理由要人话但不刷屏。 */
function firstErrorLine(text: string): string {
  return (text.trim().split(/\r?\n/)[0] ?? "").slice(0, 200);
}

/** 解析一个提交引用为完整 40 位提交号;取不到返回 undefined。 */
function resolveCommit(
  session: WorktreeGitSession,
  ref: string,
): string | undefined {
  const outcome = session.run(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = outcome.stdout.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

/** fetch 远端单分支(显式地址+分支名,不吃仓配置;对象落进工作区仓
 *  的真实对象库,分支头记在 FETCH_HEAD 首行)。失败返回人话理由。 */
function fetchBranchTip(
  session: WorktreeGitSession,
  url: string,
  branch: string,
): { sha?: string; error?: string } {
  const outcome = session.run(["fetch", "--quiet", "--no-tags", url, branch]);
  if (outcome.code !== 0) {
    const detail = firstErrorLine(outcome.stderr || outcome.stdout);
    const missing = /couldn'?t find remote ref|could not find remote branch/i
      .test(detail);
    return {
      error: missing
        ? `远端没有分支 ${branch}(可能已被删除)`
        : `fetch ${branch} 失败:${detail || "远端不可达"}`,
    };
  }
  const sha = (session.fetchHeadText().split(/\r?\n/)[0] ?? "")
    .trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/i.test(sha)
    ? { sha: sha.toLowerCase() }
    : { error: `fetch ${branch} 后读不到分支头` };
}

/** 转移账逐笔推送(仓、分支、提交号、时刻),解析在 ledgerFacts。 */

function unavailableRepo(
  repo: string,
  branch: string,
  reason: string,
): IssueMetricsUnavailable & { repo: string; branch: string } {
  return {
    repo, branch,
    unavailable: reason.startsWith("不可得") ? reason : `不可得:${reason}`,
  };
}

/** 提交归属比对:对每个有 MR 的仓,fetch 远端取 MR 完整提交清单,
 *  与推送账逐提交比对。单仓失败只降级那一仓。 */
function commitAttributionLayer(
  root: string,
  state: IssueSessionState,
  options?: IssueMetricsSnapshotOptions,
): IssueMetricsAttributionLayer {
  // 平台推送全清单:转移账「分支已推送」逐笔(每仓的全部提交号,
  // 账面记前 12 位)。state.pushes 只留每仓最新一笔,数不全,不用。
  const platformPrefixes = new Map<string, Set<string>>();
  for (const push of ledgerPushes(state.transitions ?? [])) {
    const set = platformPrefixes.get(push.repo) ?? new Set<string>();
    set.add(push.sha.toLowerCase());
    platformPrefixes.set(push.repo, set);
  }
  const byRepo: IssueMetricsAttributionRepo[] = [];
  for (const mr of state.mrs ?? []) {
    const workspace = issueRepoWorkspaces(state, root)
      .find((entry) => entry.url === mr.repo)?.dir;
    const session = workspace
      ? WorktreeGitSession.open(workspace, {
        dataDir: dataDirOfSessionRoot(root),
        credential: options?.fetchCredential,
      })
      : undefined;
    if (!session) {
      byRepo.push(unavailableRepo(mr.repo, mr.branch,
        "工作区没有该仓的克隆(repo/ 子树),现场可能已回收"));
      continue;
    }
    try {
      byRepo.push(attributeOneMr(session, mr,
        platformPrefixes.get(mr.repo)));
    } catch (error) {
      byRepo.push(unavailableRepo(mr.repo, mr.branch,
        error instanceof Error ? error.message : String(error)));
    } finally {
      session.close();
    }
  }
  return { by_repo: byRepo };
}

/** 目标分支历史扫描上限:合入提交只在这段里找(归档紧随合入,合入
 *  提交就在目标分支顶端附近;翻遍全史不值当)。 */
const MERGE_SCAN_LIMIT = 2000;

/** 在目标分支历史里定位把 MR 合入进来的那个合并提交:父提交(第一父
 *  以外)含合入头即它。找不到返回 undefined——squash 合入(目标分支
 *  上只有内容相同的一笔新提交,没有合并提交)与快照滞后于合入都属
 *  正常,由调用方退分叉点口径。 */
function findMergeCommit(
  session: WorktreeGitSession,
  targetTip: string,
  head: string,
): string | undefined {
  const outcome = session.run([
    "rev-list", "--parents", "-n", String(MERGE_SCAN_LIMIT), targetTip,
  ]);
  if (outcome.code !== 0) return undefined;
  for (const line of outcome.stdout.split(/\r?\n/)) {
    const [commit, ...parents] = line.trim().split(/\s+/);
    if (commit && parents.slice(1).includes(head)) return commit;
  }
  return undefined;
}

function attributeOneMr(
  session: WorktreeGitSession,
  mr: IssueMrRecord,
  platformPrefixes: Set<string> | undefined,
): IssueMetricsAttributionRepoOk {
  // 1) MR 头:先 fetch 远端分支(平台外提交的对象只有远端有);
  //    fetch 不可得时退回账面合入头(merged_sha,合入时平台观测到的
  //    源分支头)在本地现算——合入头是平台推送的场景仍可完整归属,
  //    但平台外提交的对象不在本地,清单可能不全,list_basis 如实标注。
  let head: string | undefined;
  let headLocal = false;
  const fetched = fetchBranchTip(session, mr.repo, mr.branch);
  if (fetched.sha) {
    // 合入头可取时以合入头为界(分支头可能在合入后又前进)。
    head = (mr.merged_sha ? resolveCommit(session, mr.merged_sha) : undefined)
      ?? fetched.sha;
  } else {
    const localHead = mr.merged_sha
      ? resolveCommit(session, mr.merged_sha) : undefined;
    if (localHead) {
      head = localHead;
      headLocal = true;
    }
  }
  if (!head) throw new Error(fetched.error ?? "取不到 MR 头提交");

  // 2) 目标分支界:fetch 最新目标分支;失败退回克隆时留下的本地远端
  //    跟踪引用(分叉点通常一致,足够画界)。
  const target = mr.target ?? "master";
  const targetSha = fetchBranchTip(session, mr.repo, target).sha
    ?? resolveCommit(session, `refs/remotes/origin/${target}`)
    ?? resolveCommit(session, `refs/heads/${target}`);
  if (!targetSha) {
    throw new Error(`目标分支 ${target} 取不到(远端与本地引用都没有)`);
  }

  // 3) 清单区间:MR 提交在非 squash 合入后全部可达自目标分支,直接拿
  //    目标分支画界会恒空、platform/external 恒 0。先在目标分支历史里
  //    定位合入提交,区间改「合入提交的第一父..合入头」;找不到合入
  //    提交(squash 合入没有合并提交、快照滞后于合入)退「与目标分支
  //    的分叉点(merge-base)..合入头」——合入前快照在这个口径下仍是
  //    完整清单。list_basis 如实标注三种口径。
  const mergeCommit = findMergeCommit(session, targetSha, head);
  const mergeCommitBase = mergeCommit
    ? resolveCommit(session, `${mergeCommit}^1`) : undefined;
  let baseSha = mergeCommitBase;
  if (!baseSha) {
    const merged = session.run(["merge-base", targetSha, head]);
    const cut = merged.code === 0
      ? merged.stdout.trim().toLowerCase() : "";
    baseSha = /^[0-9a-f]{40}$/.test(cut) ? cut : undefined;
  }
  if (!baseSha) {
    throw new Error(`算不出清单区间(与目标分支 ${target} 没有共同祖先)`);
  }
  const listBasis: IssueMetricsAttributionRepoOk["list_basis"] = headLocal
    ? "merged_sha_local"
    : mergeCommitBase ? "merge_commit" : "merge_base";

  // 4) 清单(区间..头,从旧到新)与逐提交标注:提交号对上推送账
  //    =平台(Agent);对不上=平台外。被强推顶掉的平台提交不在清单
  //    属正常(未被合入),推送事实层(pushes 段)仍全量保留。
  const listed = session.run([
    "log", "--reverse", "--no-color",
    "--format=%H%x1f%an%x1f%ae%x1f%s%x1e",
    `${baseSha}..${head}`,
  ]);
  if (listed.code !== 0) {
    throw new Error(`读取提交清单失败:${
      firstErrorLine(listed.stderr || listed.stdout)}`);
  }
  const prefixes = [...(platformPrefixes ?? [])];
  const commits: IssueMetricsAttributionCommit[] = [];
  for (const record of listed.stdout.split("\x1e")) {
    const [sha, author, email, subject] = record.trim().split("\x1f");
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha.trim())) continue;
    const full = sha.trim().toLowerCase();
    commits.push({
      sha: full,
      origin: prefixes.some((prefix) => full.startsWith(prefix))
        ? "platform"
        : "external",
      author: author ?? "",
      author_email: email ?? "",
      subject: subject ?? "",
    });
  }
  return {
    repo: mr.repo,
    branch: mr.branch,
    list_basis: listBasis,
    commits,
    platform_count: commits.filter((commit) => commit.origin === "platform").length,
    external_count: commits.filter((commit) => commit.origin === "external").length,
  };
}

/** 逐推送 diff 统计:同仓同分支的推送按账面顺序串成区间链
 *  (上一笔..本笔;首笔从分支起点起算)。只读工作区本地对象
 *  (平台推送的提交天然都在本地),不需要 fetch。单仓失败只降级。 */
function perPushDiffLayer(
  root: string,
  state: IssueSessionState,
): IssueMetricsPushDiffLayer {
  const groups = new Map<string, {
    repo: string; branch: string; shas: string[];
  }>();
  for (const push of ledgerPushes(state.transitions ?? [])) {
    const key = `${push.repo}\u0000${push.branch}`;
    const group = groups.get(key)
      ?? { repo: push.repo, branch: push.branch, shas: [] };
    group.shas.push(push.sha);
    groups.set(key, group);
  }
  const byRepo: IssueMetricsPushDiffRepo[] = [];
  for (const group of groups.values()) {
    const workspace = issueRepoWorkspaces(state, root)
      .find((entry) => entry.url === group.repo)?.dir;
    const session = workspace ? WorktreeGitSession.open(workspace) : undefined;
    if (!session) {
      byRepo.push(unavailableRepo(group.repo, group.branch,
        "工作区没有该仓的克隆(repo/ 子树),现场可能已回收"));
      continue;
    }
    try {
      byRepo.push(diffOnePushChain(session, state, group));
    } catch (error) {
      byRepo.push(unavailableRepo(group.repo, group.branch,
        error instanceof Error ? error.message : String(error)));
    } finally {
      session.close();
    }
  }
  return { by_repo: byRepo };
}

function diffOnePushChain(
  session: WorktreeGitSession,
  state: IssueSessionState,
  group: { repo: string; branch: string; shas: string[] },
): IssueMetricsPushDiffRepoOk {
  // 首笔的分支起点界:该仓该分支 MR 申报的目标分支(申报缺省=会话
  // 基线,存量无目标记账退 master)的
  // 本地远端跟踪引用;没有 MR 的仓退回克隆的缺省远端分支(origin/HEAD)。
  const mr = (state.mrs ?? []).find((record) =>
    record.repo === group.repo && record.branch === group.branch);
  const target = mr?.target ?? "master";
  const baseRefSha = resolveCommit(session, `refs/remotes/origin/${target}`)
    ?? resolveCommit(session, "refs/remotes/origin/HEAD");

  const pushes: IssueMetricsPushDiffEntry[] = [];
  let previous: string | undefined;
  for (const sha of group.shas) {
    const head = resolveCommit(session, sha);
    if (!head) {
      pushes.push({ unavailable: `不可得:推送提交 ${sha} 的对象在工作区取不到` });
      previous = sha;
      continue;
    }
    if (!previous) {
      // 首笔:从分支起点(与目标分支的分叉点)起算。
      if (!baseRefSha) {
        pushes.push({ unavailable: `不可得:分支起点取不到`
          + `(目标分支 ${target} 与缺省远端分支的本地引用都没有)` });
        previous = sha;
        continue;
      }
      const merged = session.run(["merge-base", baseRefSha, head]);
      const cut = merged.code === 0
        ? merged.stdout.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{40}$/.test(cut)) {
        pushes.push({ unavailable: `不可得:算不出分支起点`
          + `(与目标分支 ${target} 没有共同祖先)` });
        previous = sha;
        continue;
      }
      pushes.push(pushDiffStat(session, cut, head, sha, "branch_start"));
    } else {
      const base = resolveCommit(session, previous);
      if (!base) {
        pushes.push({ unavailable: `不可得:上一笔推送 ${previous} 的对象在工作区取不到` });
        previous = sha;
        continue;
      }
      pushes.push(pushDiffStat(session, base, head, sha, "previous_push"));
    }
    previous = sha;
  }
  return { repo: group.repo, branch: group.branch, pushes };
}

/** 一笔推送的区间统计:直接 diff 区间两端的树。二进制文件没有行数
 *  (git 记 "-"),只计文件数、不进增删行;「仅源码」按扩展名白名单
 *  过滤路径后另行累计。 */
function pushDiffStat(
  session: WorktreeGitSession,
  base: string,
  head: string,
  ledgerSha: string,
  baseKind: IssueMetricsPushDiff["base_kind"],
): IssueMetricsPushDiffEntry {
  const outcome = session.run(["diff", "--numstat", base, head]);
  if (outcome.code !== 0) {
    return {
      unavailable: `不可得:diff ${base.slice(0, 12)}..${head.slice(0, 12)} 失败:${
        firstErrorLine(outcome.stderr || outcome.stdout)}`,
    };
  }
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  let sourceInsertions = 0;
  let sourceDeletions = 0;
  for (const line of outcome.stdout.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    files += 1;
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const deleted = match[2] === "-" ? 0 : Number(match[2]);
    insertions += added;
    deletions += deleted;
    if (isSourcePath(unquoteGitPath(match[3]!))) {
      sourceInsertions += added;
      sourceDeletions += deleted;
    }
  }
  return {
    sha: ledgerSha,
    base: base.slice(0, 12),
    base_kind: baseKind,
    files,
    insertions,
    deletions,
    source_insertions: sourceInsertions,
    source_deletions: sourceDeletions,
  };
}

/** 从现有账现算整份快照(纯读,不落盘;单段失败单段降级)。
 *  提交归属/逐推送 diff 两层要读会话工作区(代码现场),options
 *  带 fetch MR 分支用的凭据(缺省匿名尝试)。 */
export function buildIssueMetricsSnapshot(
  root: string,
  state: IssueSessionState,
  options?: IssueMetricsSnapshotOptions,
): IssueMetricsSnapshot {
  const repoUrls = state.repo_urls?.length
    ? state.repo_urls
    : state.repo_url ? [state.repo_url] : [];
  const transitions = state.transitions ?? [];

  // 推送次数与提交号清单:转移账逐笔计(解析在 ledgerFacts)。
  // state.pushes 只留每仓最新一笔(重推覆盖旧账),数不出次数——它是
  // 「最新收据」,不是推送历史。
  const pushByRepo = new Map<string, {
    repo: string; push_count: number;
    commits: string[]; branches: Set<string>;
  }>();
  for (const { repo, branch, sha } of ledgerPushes(state.transitions ?? [])) {
    const entry = pushByRepo.get(repo) ?? {
      repo, push_count: 0, commits: [], branches: new Set<string>(),
    };
    entry.push_count += 1;
    entry.commits.push(sha);
    entry.branches.add(branch);
    pushByRepo.set(repo, entry);
  }

  // 检视三口径分列(CONTEXT「平台检视意见」「MR 评论」词条口径):
  // 批次与意见条数同一份检视账(sentReviewOperations,与一次率现算
  // 共享),账读不了两列一起降级,不留半截状态;MR 评论按反馈账
  // mr_discussion 记录计。
  const reviewCounts = section(() => {
    const batches = sentReviewOperations(reviewStore(root).history());
    return {
      platform_review_comments:
        batches.reduce((sum, batch) => sum + batch.ids.length, 0),
      review_batches: batches.length,
    };
  });
  const reviewCount = (
    key: "platform_review_comments" | "review_batches",
  ): number | IssueMetricsUnavailable =>
    "unavailable" in reviewCounts ? reviewCounts : reviewCounts[key];
  const mrRecords = state.mrs ?? [];

  const concludedAt = state.conclusion?.at ?? state.updated_at;
  const snapshot: IssueMetricsSnapshot = {
    schema_version: ISSUE_METRICS_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    session_id: state.id,
    // 词表收窄:落盘口(writeIssueMetricsSnapshot)只放行终态,非终态
    // 现场到不了盘上(防线在写口,这里只对齐类型)。
    terminal_status: state.status as IssueMetricsSnapshot["terminal_status"],
    // 终止原因(#541):canceled 终态伴生,在场即随终态冻结;缺席键=
    // 无原因取消(历史路径),统计侧按缺席兼容。
    ...(state.cancel_reason
      ? { cancel_reason: state.cancel_reason } : {}),
    ...(state.cancel_reason_text
      ? { cancel_reason_text: state.cancel_reason_text } : {}),
    ...(state.ticket ? { ticket: state.ticket } : {}),
    ...(state.conclusion?.kind
      ? { conclusion_kind: state.conclusion.kind } : {}),
    created_at: state.created_at,
    concluded_at: concludedAt,
    end_to_end_ms: section(() => {
      const createdMs = Date.parse(state.created_at);
      const endMs = Date.parse(concludedAt);
      if (!Number.isFinite(createdMs) || !Number.isFinite(endMs)) {
        throw new Error("发起或结论时刻无法解析");
      }
      return Math.max(0, endMs - createdMs);
    }),
    repo_count: repoUrls.length,
    repo_urls: repoUrls,
    pushes: {
      total: [...pushByRepo.values()].reduce(
        (sum, entry) => sum + entry.push_count, 0),
      by_repo: [...pushByRepo.values()].map((entry) => ({
        repo: entry.repo,
        push_count: entry.push_count,
        commits: entry.commits,
        branches: [...entry.branches],
      })),
      latest: (state.pushes ?? []).map((push) => ({
        repo: push.repo, branch: push.branch, sha: push.sha, at: push.at,
      })),
    },
    reviews: {
      platform_review_comments: reviewCount("platform_review_comments"),
      review_batches: reviewCount("review_batches"),
      mr_comments: section(() =>
        new FeedbackStore(join(root, "feedback", "index.jsonl"))
          .list().filter((record) => record.source === "mr_discussion")
          .length),
    },
    report_version_count: section(() => listAnalysisVersions(root).length),
    verify_fail_count: countVerifyFailures(transitions),
    pipeline: {
      red_light_rounds: {
        repaired: countTransitions(state, isRedLightRepaired),
        canceled_by_merge: countTransitions(
          state, isRedLightCanceledByMerge),
        discarded_on_head_move: countTransitions(
          state, isRedLightDiscardedOnHeadMove),
      },
      external_head_observations: (() => {
        const records = externalHeadObservations(transitions);
        return { count: records.length, records };
      })(),
    },
    rollbacks: (() => {
      const reasons: string[] = [];
      for (const transition of transitions) {
        const match = ROLLBACK_NOTE.exec(transition.note);
        if (match?.[1]) reasons.push(match[1].slice(0, REASON_MAX).trim());
      }
      return { count: reasons.length, reasons };
    })(),
    stage_durations_ms: section(() => stageDurations(state, concludedAt)),
    answers: {
      platform_gates: section(() => platformGateAnswers(root)),
      agent_cards: section(() => agentCardAnswers(root)),
    },
    mrs: {
      total: mrRecords.length,
      merged: mrRecords.filter((mr) => Boolean(mr.merged_at)).length,
      closed: mrRecords.filter(
        (mr) => !mr.merged_at && Boolean(mr.closed_at)).length,
      records: mrRecords.map((mr) => ({
        repo: mr.repo,
        branch: mr.branch,
        ...(mr.target ? { target: mr.target } : {}),
        ...(mr.url ? { url: mr.url } : {}),
        ...(mr.iid !== undefined ? { iid: mr.iid } : {}),
        at: mr.at,
        ...(mr.merged_at ? { merged_at: mr.merged_at } : {}),
        ...(mr.merged_sha ? { merged_sha: mr.merged_sha } : {}),
        ...(mr.closed_at ? { closed_at: mr.closed_at } : {}),
      })),
    },
    commit_attribution: section(() =>
      commitAttributionLayer(root, state, options)),
    per_push_diffs: section(() => perPushDiffLayer(root, state)),
  };
  return snapshot;
}

/** 收集标了「不可得」的段(路径列表,日志与测试用)。 */
export function unavailableSections(
  snapshot: IssueMetricsSnapshot,
): string[] {
  const degraded: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      if (typeof (value as IssueMetricsUnavailable).unavailable === "string") {
        degraded.push(path);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(snapshot, "");
  return degraded;
}

/** 只生成一次地落快照:已存在即跳过;生成时单段降级、整体尽力写。 */
export function writeIssueMetricsSnapshot(
  root: string,
  state: IssueSessionState,
  options?: IssueMetricsSnapshotOptions,
): IssueMetricsWriteResult {
  const path = join(root, ISSUE_METRICS_FILE);
  if (existsSync(path)) {
    return { written: false, skipped: true, degraded: [] };
  }
  if (!isTerminal(state.status)) {
    // 非终态不冻结(防线:调用点都在终态写入之后,这里再挡一道)。
    return { written: false, skipped: true, degraded: [] };
  }
  const snapshot = buildIssueMetricsSnapshot(root, state, options);
  const degraded = unavailableSections(snapshot);
  mkdirSync(root, { recursive: true });
  durableWriteFileSync(path, JSON.stringify(snapshot, null, 1));
  return { written: true, skipped: false, degraded };
}
