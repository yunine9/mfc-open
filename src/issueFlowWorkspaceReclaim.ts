/**
 * 问题会话工作区回收(ADR-0073 白名单反转):保留名单钉死,名单之外
 * 终态当场清——不分目录文件,不看大小。
 *
 * 判定方向从"猜什么该删"反转成"枚举什么在用":宿主往会话根写的条目
 * 在代码里枚举得出(全在保留名单);枚举不出的只能是会话里 Agent 自建
 * 的,正是该删的。宿主新增工作区根条目必须同步进保留名单,否则当场清
 * 会把它删掉——靠评审把关,不靠时间窗口兜底。
 *
 * `repo/` 代码现场不在本模块管辖:它走 IssueFlowService 的专属路径
 * (首次生成归属等待 + issue_repo_reclaim 开关 + repo_reclaimed_at
 * 标记,ADR-0044),本模块的清理跳过它,井水不犯河水。
 *
 * 图片中转(issue-image-staging)永不入清扫:回显接口按内容哈希读
 * 中转原件,删了老会话截图就 404——它是软件在用的数据。附件中转
 * (issue-attachment-staging)在提交登记时已复制进工作区,按年龄 GC
 * (sweepIssueAttachmentStaging)。
 *
 * 解耦纪律:本模块不 import IssueFlowService/TaskService——判据纯函数
 * 化,容器探活与旋钮值由调用方注入。
 */

import {
  existsSync,
  readdirSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { humanBytes, withinDataDir } from "./workspaceReclaim.ts";

/**
 * 保留名单(工作区根一级,终态后永不回收)。准入门是"软件在用,枚举
 * 得出",不是"拿不准就留"——复盘材料、台账、宿主辅助会话记录都在这;
 * 加条目就是在说"本服务的哪些功能还要读它",拿不准就别加。
 */
export const ISSUE_WORKSPACE_KEEP_FILES: readonly string[] = [
  "issue.json",           // 状态台账
  "events.jsonl",         // 事件账
  "transcript.jsonl",     // 会话记录
  "knowledge-events.jsonl", // 知识事件账
  "waiting.json",         // 等人卡
  "issue-analysis.md",    // 分析报告(正本)
  "reviews.jsonl",        // 检视意见账(reviews.ts REVIEWS_FILE)
  "code-origin.json",     // 首次生成归属的伴生统计(ADR-0044)
  "manual-edits.jsonl",   // 人工编辑账(ADR-0028 遗留口径:历史会话在盘,永不回收)
];

export const ISSUE_WORKSPACE_KEEP_DIRS: readonly string[] = [
  "attachments",    // 登记附件(分析材料)
  "ticket-images",  // 拉单截图(报告证据)
  "issue-images",   // 会话传图(报告证据)
  "local-logs",     // 现场日志
  "pipeline",       // 流水线取证(红灯修复的依据)
  "feedback",       // 意见账
  "reviews",        // 检视意见快照 + 分析报告版本快照(reviews.ts REVIEWS_DIR)
  "codecheck",      // 宿主的代码检查辅助会话记录
  "warmup",         // 预热会话记录
];

const ATTACHMENT_STAGING_DIR = "issue-attachment-staging";

const DAY_MS = 24 * 60 * 60_000;

export type IssueReclaimSkipCode =
  | "retention_off"      // 保留期 0 = 整体禁运
  | "not_terminal"       // 除归档和取消外，均保留现场供继续处理或恢复
  | "container_running"; // 容器探活为真(belt-and-suspenders)

export interface IssueReclaimVerdict {
  reclaim: boolean;
  /** 说人话的理由,直接进日志——回收不可逆,得说清凭什么。 */
  reason: string;
  /** 机器可读的跳过原因(调用方统计"容器在跑跳过"这类数字用)。 */
  skip?: IssueReclaimSkipCode;
}

/** 判据的输入面:只取 issue.json 里裁决要用的字段(纯函数,好测)。 */
export interface IssueReclaimCandidate {
  status: string;
}

/**
 * 判不判得回收(纯函数,好测)。当场制(ADR-0073)不看年龄:终态即到点,
 * 判据只剩三道闸——旋钮开、终态、容器不在跑。failed 是可恢复态,出口
 * 是手动转取消或异常重跑(ADR-0055),永不自动回收。
 */
export function judgeIssueReclaim(
  issue: IssueReclaimCandidate,
  options: {
    retentionEnabled: boolean;
    containerRunning?: boolean;
  },
): IssueReclaimVerdict {
  if (!options.retentionEnabled) {
    return { reclaim: false, reason: "保留期配置为 0,永不回收", skip: "retention_off" };
  }
  if (!["archived", "canceled"].includes(issue.status)) {
    return {
      reclaim: false,
      reason: `状态 ${issue.status} 不可自动回收(仍可继续处理或恢复)`,
      skip: "not_terminal",
    };
  }
  if (options.containerRunning) {
    return {
      reclaim: false,
      reason: "容器探活为真,保险丝起作用了,不碰",
      skip: "container_running",
    };
  }
  return { reclaim: true, reason: "终态会话,保留名单外当场清(ADR-0073)" };
}

/** 量条目体积:lstat 不跟软链——链接指向哪儿都不可信,量原件会虚高。 */
function sizeOf(path: string): number {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of readdirSync(path)) total += sizeOf(join(path, name));
    return total;
  } catch {
    return 0;       // 量不出来不影响删,日志少个数字而已
  }
}

export interface ReclaimedEntry {
  name: string;
  bytes: number;
}

export interface IssueReclaimResult {
  removed: ReclaimedEntry[];
  freed: number;
  /** 被边界拦下时的原因;有值 = 一个字节都没删。 */
  refused?: string;
}

/**
 * 真删单个会话现场里保留名单之外的条目(含文件与目录,软链只解链不跟链)。
 * `repo/` 跳过——代码现场由服务专属路径管(归属等待/开关/标记),这里
 * 不越权。
 *
 * 删除前自证边界(2026-08-22 的血泪:issues/ 下若被人换了软链接,
 * readdir 看着在 dataDir 里,realpath 一解在外面——删的是原件)。
 * 越界 fail-closed:一个字节都不许删。单条目删失败不中断,继续下一条。
 */
export function reclaimIssueWorkspace(
  root: string,
  options: { dataDir: string },
): IssueReclaimResult {
  const removed: ReclaimedEntry[] = [];
  let freed = 0;
  if (!withinDataDir(root, options.dataDir)) {
    return {
      removed, freed,
      refused: `会话现场 ${root} 不在本服务的数据目录 `
        + `${options.dataDir} 内,拒绝删除`,
    };
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, freed };
  }
  const keep = new Set<string>([
    ...ISSUE_WORKSPACE_KEEP_FILES,
    ...ISSUE_WORKSPACE_KEEP_DIRS,
    "repo",
  ]);
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    const target = join(root, entry.name);
    try {
      const size = entry.isDirectory()
        ? sizeOf(target)
        : lstatSync(target).size;
      rmSync(target, { recursive: true, force: true });
      removed.push({ name: entry.name, bytes: size });
      freed += size;
    } catch {
      // 单个条目量不动/删不动(竞态消失/权限/占用)不中断,下一个接着来。
    }
  }
  return { removed, freed };
}

export interface IssueStagingSweepResult {
  removed: number;
  freed: number;
}

/**
 * 附件中转目录的孤儿 GC(ADR-0073):提交登记时文件已复制进会话工作区,
 * AI 读的是工作区副本——中转原件满保留期即删,没提交的是无人引用的
 * 孤儿(单文件上限 500MB,不 GC 就是永久堆积)。图片中转
 * (issue-image-staging)不在本函数范围:回显接口读中转原件,删了老
 * 会话截图就 404——豁免以本函数只扫附件目录的方式钉死。
 *
 * 纯旁路 fail-open:目录缺席/单文件失败只计数,不抛。
 */
export function sweepIssueAttachmentStaging(
  dataDir: string,
  options: { retentionDays: number; now?: number },
): IssueStagingSweepResult {
  const result = { removed: 0, freed: 0 };
  if (!(options.retentionDays > 0)) return result;
  const dir = join(dataDir, ATTACHMENT_STAGING_DIR);
  if (!existsSync(dir)) return result;
  const cutoff = (options.now ?? Date.now()) - options.retentionDays * DAY_MS;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      rmSync(file, { force: true });
      result.removed += 1;
      result.freed += info.size;
    } catch {
      // 单文件失败不中断:旁路清扫,下一轮再来。
    }
  }
  return result;
}

