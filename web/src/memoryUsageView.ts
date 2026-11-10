import type { MemoryUsageRow } from "./api";

/**
 * 知识使用记录只留真正取到内容的行。
 *
 * 每轮检索没命中、记忆检索不可用、正文读取被拒绝这类记录只是运行噪声：
 * 它们既不代表 Agent 用了知识，也不代表平台出了问题需要人处理，堆在面板里
 * 会盖住真正命中的记录。组件计划与代码检查行保留——它们本身报告结果，
 * 不是一次空的检索。
 */
export function visibleMemoryUsage(rows: MemoryUsageRow[]): MemoryUsageRow[] {
  return rows.filter((row) => {
    if (row.moment === "component_plan" || row.moment === "component_check") return true;
    // 第一次改某目录时推送的目录摘要：有内容，不靠逐条 id 表达。
    if (row.digest) return true;
    if (row.status && row.status !== "ready") return false;
    return row.ids.length > 0;
  });
}
