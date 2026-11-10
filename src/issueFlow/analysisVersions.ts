/**
 * 分析报告版本投影(#262,ADR-0025):「初版 / 修订N」页签的数据面。
 *
 * 版本是**平台的记账行为,AI 零感知**——不教版本概念、不改
 * issue-analysis.md 文件名契约、不新增快照:快照在修改型申报触发
 * 整体回退重写或验证打回回退时落账(ADR-0035 起提交检视不再冻结,
 * 纯回复型批次不出版本;写侧是 reviews.ts 的 snapshotAnalysisVersion,
 * 把当时的报告整份复制进 reviews/,文件名 `issue-analysis@<时间戳>.md`),
 * 这里只做读侧推导:
 *
 * - 第 j 份快照 = 第 j 批意见提交时冻结的版本 v_j;live 文件恒为
 *   最新版 v_m(它还在被 AI 续写,是唯一的"活"版本槽)。
 * - 命名: v1 = 「初版」, v_i(i≥2) = 「修订(i-1)」——修订N 即第 N 批
 *   意见处理后的新版。
 * - 去重:内容相同的相邻版本不出两条(快照=live 说明 AI 还没修订完,
 *   修订版尚不存在;两份快照相同说明那次修订零改动)——重复出条只会
 *   让页签上出现内容一模一样的假版本。
 * - 非检视通道(补充意见等)与纯回复型批次不产生新版本:快照只在
 *   修改型申报(ADR-0035)与验证打回回退(ADR-0045)时发生,live
 *   的中间态永远只占"最新版"这一个槽,不会被冻结。
 * - 每版带该批提交的意见 id(sent_at 落在相邻两次快照时刻之间的即
 *   该批):冻结版的锚点标记靠它画,历史会话的旧快照同账自然可读,
 *   不做迁移。
 *
 * 边界纪律与 documents.ts 同款:白名单即边界(读取按版本名对回推导
 * 出的清单,路径从不经用户输入拼接,逃逸形状匹配不到任何版本名)、
 * fail-open(目录不可读/文件半路消失只让该项缺席)。
 */

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { ANALYSIS_DOC_NAME } from "./documents.ts";
import { REVIEWS_DIR, reviewStore } from "./reviews.ts";

/** reviews/ 内分析报告快照的文件名形状(写侧在 reviews.ts 的
 * snapshotAnalysisVersion:`issue-analysis@r<base36 毫秒>.md`)。 */
const SNAPSHOT_PATTERN = /^issue-analysis@[^/\\]+\.md$/;
/** 从快照文件名解析冻结时刻(base36 毫秒);解析不了退回 mtime。 */
const SNAPSHOT_STAMP = /^issue-analysis@r([0-9a-z]+)\.md$/;

/** 版本页签上限:检视几十轮的极端会话也不该把页签条撑成流水账——
 * 超出只保留最早的 200 版与最新版(推导是读侧投影,账仍在盘上)。 */
const VERSION_MAX = 200;

const VERSION_MAX_BYTES = 512 * 1024;
const VERSION_TRUNCATED_NOTE =
  "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见会话工作区文件)";

export interface IssueAnalysisVersionMeta {
  /** 1 起序号:页签顺序即时间序,最新版在末尾。 */
  index: number;
  /** 页签名:初版 / 修订1 / 修订2 …(去重后的时间序)。 */
  name: string;
  bytes: number;
  modified_at: string;
  /** 是否最新版(live)。前端缺省选中它。 */
  latest: boolean;
  /** 该版页签上要画锚点标记的意见 id(= 该批检视提交的意见;
   * 最新版的干净纸面只有草稿标记,故恒为空)。 */
  review_ids: string[];
  /** reviews/ 内的快照文件名;最新版若是 live(内容已走出最后一份
   * 快照)则缺席——它还没有冻结时刻。 */
  snapshot?: string;
}

export interface IssueAnalysisVersionContent {
  meta: IssueAnalysisVersionMeta;
  content: string;
  truncated: boolean;
}

interface SnapshotFile {
  name: string;
  /** 冻结时刻(毫秒):文件名时间戳,解析不了退 mtime。 */
  ts: number;
}

/** reviews/ 里的分析报告快照,冻结时刻升序(页签时间序)。目录不可读
 * 或还没检视过 → 空(会话只有 live 一版)。 */
function snapshotFiles(root: string): SnapshotFile[] {
  const dir = join(root, REVIEWS_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SNAPSHOT_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: SnapshotFile[] = [];
  for (const name of names) {
    try {
      const info = statSync(join(dir, name));
      if (!info.isFile()) continue;
      const stamp = SNAPSHOT_STAMP.exec(name);
      files.push({
        name,
        ts: stamp ? Number.parseInt(stamp[1], 36) : info.mtime.getTime(),
      });
    } catch {
      // 快照在扫描途中消失:跳过这一项,别的照列。
    }
  }
  return files.sort((left, right) =>
    left.ts !== right.ts ? left.ts - right.ts : left.name.localeCompare(right.name));
}

function readBounded(path: string): { content: string; truncated: boolean } | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    if (info.size <= VERSION_MAX_BYTES) {
      return { content: readFileSync(path, "utf-8"), truncated: false };
    }
    // 超长读前段:与过程文档读取同口径,按字节切会把 UTF-8 多字节字符
    // 切一半,末尾替换符直接抹掉——宁可少一个字。
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(VERSION_MAX_BYTES);
      const read = readSync(handle, buffer, 0, VERSION_MAX_BYTES, 0);
      const content = buffer.subarray(0, read).toString("utf-8")
        .replace(/\uFFFD+$/, "");
      return { content: content + VERSION_TRUNCATED_NOTE, truncated: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

/** 已提交的意见按 sent_at 落批:sent_at 落在 [本次快照时刻, 下次快照
 * 时刻) 即第 j 批(ADR-0035 起送出在先、冻结在后,快照名取批次最早
 * 送出时刻——写侧 snapshotAnalysisVersion 保证窗口不错批)。
 * 推导与快照去重共用一份原始时间序,去重折掉的快照批次并入幸存条目。 */
function sentReviewIds(root: string, snapshots: SnapshotFile[]): string[][] {
  const batches: string[][] = snapshots.map(() => []);
  let items;
  try {
    items = reviewStore(root).list().filter((item) =>
      item.status === "sent" && item.sent_at);
  } catch {
    return batches;
  }
  for (const item of items) {
    const at = Date.parse(String(item.sent_at));
    if (!Number.isFinite(at)) continue;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (at >= snapshots[i].ts) {
        batches[i].push(item.id);
        break;
      }
    }
  }
  return batches;
}

/** 版本清单(推导是纯读侧投影,每次现算):去重后的快照版 + live 最新
 * 版。只有 live 一版(没检视过)时返回单项——前端不渲染页签条。 */
export function listAnalysisVersions(root: string): IssueAnalysisVersionMeta[] {
  const snapshots = snapshotFiles(root);
  const batches = sentReviewIds(root, snapshots);
  const livePath = join(root, ANALYSIS_DOC_NAME);

  // 快照按内容去重(相邻同文折并,批次随并),再截到页签上限。
  const entries: Array<{
    snapshot?: string;
    mtime: Date;
    bytes: number;
    content: string;
    reviewIds: string[];
  }> = [];
  for (const [i, file] of snapshots.entries()) {
    const read = readBounded(join(root, REVIEWS_DIR, file.name));
    if (!read) continue;
    let bytes = 0;
    let mtime = new Date(file.ts);
    try {
      const info = statSync(join(root, REVIEWS_DIR, file.name));
      bytes = info.size;
      mtime = info.mtime;
    } catch {
      // 元信息拿不到就用冻结时刻与已读内容顶着,不让整条缺席。
    }
    const last = entries.at(-1);
    if (last && last.content === read.content) {
      last.reviewIds.push(...batches[i]);
      continue;
    }
    entries.push({
      snapshot: file.name,
      mtime,
      bytes,
      content: read.content,
      reviewIds: [...batches[i]],
    });
  }

  // live = 最新版:与最后一份快照同文时去重(修订版还没写出来),
  // 不同文才是新版本槽(它仍被 AI 续写,不冻结);live 缺席(报告
  // 尚未生成/已丢失)时最后一份快照就是最新版。
  const live = readBounded(livePath);
  if (live) {
    const last = entries.at(-1);
    if (!last || last.content !== live.content) {
      let bytes = 0;
      let mtime = new Date();
      try {
        const info = statSync(livePath);
        bytes = info.size;
        mtime = info.mtime;
      } catch {
        // 同上:元信息缺席不挡投影。
      }
      entries.push({
        mtime,
        bytes,
        content: live.content,
        reviewIds: [],
      });
    }
  }
  if (!entries.length) return [];
  if (entries.length > VERSION_MAX) {
    entries.splice(1, entries.length - VERSION_MAX);
  }
  const last = entries.at(-1)!;
  return entries.map((entry, at) => {
    const index = at + 1;
    return {
      index,
      name: index === 1 ? "初版" : `修订${index - 1}`,
      bytes: entry.bytes,
      modified_at: entry.mtime.toISOString(),
      // live 是唯一"活"槽,永远排在末尾:末位即最新版。
      latest: entry === last,
      review_ids: entry.reviewIds,
      ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
    };
  });
}

/** 读一个版本的内容。name 必须精确对回清单里的版本名(零路径拼接:
 * 快照路径全部来自 readdir 的白名单,用户输入只做名字匹配,路径逃逸
 * 形状匹配不到任何版本名);latest 且无快照的读 live 本体。缺失返回
 * undefined,调用方给人话空态。 */
export function readAnalysisVersion(
  root: string,
  name: string,
): IssueAnalysisVersionContent | undefined {
  const wanted = String(name ?? "").trim();
  if (!wanted || wanted !== basename(wanted)) return undefined;
  const meta = listAnalysisVersions(root).find((entry) => entry.name === wanted);
  if (!meta) return undefined;
  const path = meta.snapshot
    ? join(root, REVIEWS_DIR, meta.snapshot)
    : join(root, ANALYSIS_DOC_NAME);
  // 双保险(同 documents.ts):推导出的路径必须仍在本会话现场之下。
  if (!resolve(path).startsWith(resolve(root) + sep)) return undefined;
  const read = readBounded(path);
  if (!read) return undefined;
  return { meta, content: read.content, truncated: read.truncated };
}
