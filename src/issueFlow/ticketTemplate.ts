/**
 * 提单模板(ADR-0048):无单会话确认是问题时自动产出的提单文稿,给
 * 测试复制进 DTS 提单系统提单;新单号再从 DTS 列表发起有单会话,
 * 研究成果以这段文本穿过 DTS 到达下一个会话。内容三段:单据标题与
 * 登记元信息(描述本身已按提单版式预填,模块/环境等表单单独采集项
 * 在此补栏)、分析报告全文、末尾「参考:问题根因/修改方案」两节——
 * 标题即声明、正文附防采信说明(未经修复验证,接单的 AI 与评审不得
 * 直接采信),说明随单据进入 DTS,正是给拉单阶段的 AI 读的。
 *
 * 模板在 conclude=issue 归档时写盘一次(fail-open,写失败不挡归档,
 * 读侧 404 如实),是过程记录,永不回收。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSessionState } from "./state.ts";

export const TICKET_TEMPLATE_FILE = "issue-ticket-template.md";

const ANALYSIS_REPORT_FILE = "issue-analysis.md";

/** 从分析报告里抠一节正文:认 `## 问题根因` 独立行,也认
 *  `## 问题根因:xxx` 单行带文的变体(冒号后即正文首段);到下一个
 *  `## ` 或文末止。报告四节(问题现象/问题根因/修改方案/置信度)
 *  顺序不保证,逐头扫描。 */
function extractReportSection(report: string, heading: string): string {
  const lines = report.split("\n");
  const start = lines.findIndex((line) =>
    line.trim() === `## ${heading}` || line.trim().startsWith(`## ${heading}:`));
  if (start === -1) return "(分析报告未含该节)";
  const head = lines[start]!.trim().slice(`## ${heading}:`.length - 1).replace(/^[:\uff1a]\s*/, "");
  const body: string[] = head ? [head] : [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("## ")) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text || "(该节为空)";
}

export function composeTicketTemplate(input: {
  title: string;
  description?: string;
  module?: string;
  reporter?: string;
  account?: string;
  environmentName?: string;
  report: string;
}): string {
  const meta = [
    input.module ? `业务模块:${input.module}` : undefined,
    input.environmentName ? `网管环境:${input.environmentName}` : undefined,
    input.reporter ? `登记人:${input.reporter}` : undefined,
    input.account ? `责任人:${input.account}` : undefined,
  ].filter(Boolean).join("\n");
  const referenceNote = "说明:以上「参考」两节来自登记阶段的一次研究,未经修复验证,"
    + "实际根因与方案以有单会话的重新分析为准——接单的 AI 与评审不应直接采信本节内容。";
  return [
    `单据标题:${input.title}`,
    "",
    "基本信息:",
    "",
    meta,
    "",
    input.description?.trim() || "(登记描述缺席)",
    "",
    "━━━━ 分析过程(平台内已完成一轮研究,全文如下)━━━━",
    "",
    input.report.trim() || "(分析报告缺席)",
    "",
    "━━━━━━ 以下为初步研究结论,仅供参考 ━━━━━━",
    "",
    "参考:问题根因",
    extractReportSection(input.report, "问题根因"),
    "",
    "参考:修改方案",
    extractReportSection(input.report, "修改方案"),
    "",
    referenceNote,
    "",
  ].join("\n");
}

/** conclude=issue 归档路径调用:读当场报告、拼模板、写进会话根。
 *  报告缺席按占位符处理(结论在场比模板完整更要紧);写失败向上抛,
 *  由调用方 fail-open。 */
export function writeTicketTemplate(root: string, state: IssueSessionState): void {
  const reportFile = join(root, ANALYSIS_REPORT_FILE);
  const report = existsSync(reportFile)
    ? readFileSync(reportFile, "utf8")
    : "";
  const template = composeTicketTemplate({
    title: state.title,
    description: state.description,
    module: state.module?.trim() || undefined,
    reporter: state.reporter,
    account: state.account,
    environmentName: state.environment?.name,
    report,
  });
  writeFileSync(join(root, TICKET_TEMPLATE_FILE), template, "utf8");
}
