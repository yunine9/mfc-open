/**
 * 会话过程文档数据面(「分析报告」页签,ADR-0025 起只留报告本身)。
 *
 * 形态对齐需求侧 artifacts.ts(多文档多页签),边界纪律同款:
 * - **白名单即边界**。能读的只有本模块自己扫出来的文件:name 先在
 *   集合里核对,再按集合里的名字读,绝不拿用户输入拼路径(路径穿越
 *   不是 404 的一种,是攻击)。
 * - **fail-open**。目录不可读、文件半路消失,都只让那一项缺席,返回
 *   空清单或 undefined——材料生成失败不拖垮会话页。
 * - 只扫会话根目录顶层的 .md:repo/ 是代码仓、skills/ 是平台物化的
 *   技能、local-logs/ 是日志,都不是过程文档;Agent 的落笔点就是
 *   会话根(与 issue-analysis.md 同层)。其他 .md 不再单页呈现,
 *   随打包下载出口保留(复盘的原始材料面)。
 */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createZipArchive } from "../zipArchive.ts";

/** 分析报告:prompt 契约与 submit_analysis 门票的既定落点,过程文档
 * 里的固定首页。文件名是行为契约的一部分(技能/闸门/转正都认它),
 * 改名等于改协议——"分析报告"只是页签显示名。 */
export const ANALYSIS_DOC_NAME = "issue-analysis.md";

const DOC_MAX_BYTES = 512 * 1024;
const DOC_TRUNCATED_NOTE =
  "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见会话工作区文件)";

export interface IssueDocMeta {
  /** 稳定标识(会话根内的文件名),也是读取接口的取值。 */
  name: string;
  /** 给人看的短名:分析报告翻译,其余原样。 */
  label: string;
  bytes: number;
  modified_at: string;
}

/** 会话根目录顶层 .md 清单。分析报告固定首位,其余最近修改在前
 * (那是客观信号,不是判断)。fail-open:目录不可读给空清单。 */
export function listSessionDocuments(root: string): IssueDocMeta[] {
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const docs: IssueDocMeta[] = [];
  for (const name of names) {
    try {
      const info = statSync(join(root, name));
      if (!info.isFile()) continue;
      docs.push({
        name,
        label: name === ANALYSIS_DOC_NAME ? "分析报告" : name,
        bytes: info.size,
        modified_at: info.mtime.toISOString(),
      });
    } catch {
      // 文件在扫描途中消失:跳过这一项,别的照列。
    }
  }
  return docs.sort((left, right) => {
    if (left.name === ANALYSIS_DOC_NAME) return -1;
    if (right.name === ANALYSIS_DOC_NAME) return 1;
    return right.modified_at.localeCompare(left.modified_at);
  });
}

export interface IssueDocContent {
  meta: IssueDocMeta;
  content: string;
  /** 触顶截断时为 true:页面要如实告诉用户"这不是全文"。 */
  truncated: boolean;
}

/** 打包下载在内存里生成 ZIP，给会话现场留一个明确上限，避免 Agent
 * 意外落下超大 .md 时一次下载把 serve 的堆占满。页面阅读的 512 KB
 * 截断不影响这里：只要总量不过线，包内始终是完整原文件。 */
const DOC_ARCHIVE_MAX_FILES = 1000;
const DOC_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export class IssueDocumentsArchiveTooLargeError extends Error {}

export interface IssueDocumentsArchive {
  data: Buffer;
  files: number;
  sourceBytes: number;
}

/** 将清单里的全部 Markdown 打成 ZIP。仍以 listSessionDocuments 的白
 * 名单为唯一边界；扫描后消失的文件跳过，全部消失则返回 undefined。 */
export function bundleSessionDocuments(
  root: string,
): IssueDocumentsArchive | undefined {
  const docs = listSessionDocuments(root);
  if (!docs.length) return undefined;
  if (docs.length > DOC_ARCHIVE_MAX_FILES) {
    throw new IssueDocumentsArchiveTooLargeError(
      `过程文档超过 ${DOC_ARCHIVE_MAX_FILES} 份,请先整理后再打包`);
  }

  const boundary = resolve(root);
  const entries: Array<{ name: string; content: Buffer; modifiedAt: Date }> = [];
  let sourceBytes = 0;
  for (const doc of docs) {
    const path = join(root, doc.name);
    if (!resolve(path).startsWith(boundary + sep)) continue;
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      const content = readFileSync(path);
      sourceBytes += content.length;
      if (sourceBytes > DOC_ARCHIVE_MAX_BYTES) {
        throw new IssueDocumentsArchiveTooLargeError(
          "过程文档合计超过 64 MiB,请先整理后再打包");
      }
      entries.push({ name: doc.name, content, modifiedAt: info.mtime });
    } catch (reason) {
      if (reason instanceof IssueDocumentsArchiveTooLargeError) throw reason;
      // 文件在扫描后消失或暂时不可读：与清单/单篇读取同口径，跳过。
    }
  }
  if (!entries.length) return undefined;
  return {
    data: createZipArchive(entries),
    files: entries.length,
    sourceBytes,
  };
}

/** 读一份过程文档。name 必须出现在清单里(零路径拼接),读取前再核对
 * 解析路径仍在会话现场之下(双保险)。缺失返回 undefined,调用方给人
 * 话空态,不抛错。 */
export function readSessionDocument(
  root: string,
  name: string,
): IssueDocContent | undefined {
  const wanted = String(name ?? "").trim();
  if (!wanted || wanted !== basename(wanted)) return undefined;
  const meta = listSessionDocuments(root).find((doc) => doc.name === wanted);
  if (!meta) return undefined;
  const path = join(root, wanted);
  const boundary = resolve(root);
  if (!resolve(path).startsWith(boundary + sep)) return undefined;
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    if (info.size <= DOC_MAX_BYTES) {
      return { meta, content: readFileSync(path, "utf-8"), truncated: false };
    }
    // 超长读前段:过程文档是"读文章",与日志排障读尾不同;按字节切会
    // 把 UTF-8 多字节字符切一半,末尾替换符直接抹掉——宁可少一个字。
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(DOC_MAX_BYTES);
      const read = readSync(handle, buffer, 0, DOC_MAX_BYTES, 0);
      const content = buffer.subarray(0, read).toString("utf-8")
        .replace(/\uFFFD+$/, "");
      return { meta, content: content + DOC_TRUNCATED_NOTE, truncated: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

// ---- 问答卡的问句形状(事件账本 → 问句清单) ----

export interface IssueDialogueQuestion {
  question: string;
  options: string[];
}

/** 问答卡的入参 → 问题清单(形状读不出来当没有;选项兼容字符串与
 * {code,label} 两种现场——码是投影层的事,人看文案)。平台闸的问句
 * 快照同走此路,一个形状。协作流投影(conversation.ts)复用本函数。 */
export function cardQuestions(input: unknown): IssueDialogueQuestion[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((item) => {
    const record = (item ?? {}) as { question?: unknown; options?: unknown };
    const options = Array.isArray(record.options)
      ? record.options
        .map((option) => typeof option === "string"
          ? option
          : String((option as { label?: unknown })?.label ?? ""))
        .filter(Boolean)
      : [];
    return { question: String(record.question ?? ""), options };
  });
}
