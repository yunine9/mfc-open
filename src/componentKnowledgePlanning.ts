import { readFileSync } from "node:fs";
import type { KnowledgeSearch } from "./knowledgeSearch.ts";

/** 编码前组件分析的方法正文随任务进入专门的子会话。 */
export const COMPONENT_ANALYST = "component-plan-agent";
export const COMPONENT_ANALYST_MISSION = readFileSync(new URL("../skills/component-plan/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
export const COMPONENT_PLANNING_GUIDANCE = [
  "在实施环节（内核 build 步骤）中，读清本次 implementation 工作项和相关代码后、开始编码前，调用 Task(subagent_type=component-plan-agent, description=分析本次实现可复用的组件, prompt=完整任务上下文)，等待分析报告再编码。这是现有实施环节内的工作方法，不新增流程阶段或人工审批。",
  "任务卡同时提供本次业务目标、已确认要求和约束、全部实施工作项、相关代码与依赖文件路径、现有 implementation 的准确路径，以及初步方案和待确认问题。区分已确认事实和初步设想，让子 Agent 自己发现可能复用的能力，也能提出不同实现办法。不要预先限定为几个接口或仅传组件名单。",
  "子 Agent 收到能力目录后可继续翻页、搜索并读取正式用法，自行补读代码。收到报告后，将各工作项的组件或封装职责、业务代码职责、使用条件及落实方式、正式来源和待核实问题整合进现有 implementation，再开始编码；保留原有任务，不另建组件计划文档。",
  "编码时按报告中的正式来源查阅所选用法的公共接入配置、完整示例和约束；子 Agent 的最终报告不等于全部原文已进入主会话。已有分析且任务和关键条件未变时复用结果；出现会改变选型的新要求或事实时，只补查受影响的部分。分析失败或资料缺失时保留真实缺口，依据代码继续可确定的工作，不能写成已经确认适用。",
].join("\n");

export type ComponentAnalysisContext = ReturnType<KnowledgeSearch["componentContext"]>;

export function componentAnalysisPrompt(task: string, directory?: ComponentAnalysisContext, error?: string): string {
  // 目录条目已有分页预算；失效资料的诊断也需限长，避免警告把启动上下文撑满。
  const warnings = directory?.warnings.slice(0, 3).map(warning => warning.length <= 300
    ? warning : warning.slice(0, 299).replace(/[\uD800-\uDBFF]$/, "") + "…（已省略）") ?? [];
  if (directory && directory.warnings.length > warnings.length) {
    warnings.push(`另有 ${directory.warnings.length - warnings.length} 条资料警告未展示，当前目录可能不完整。`);
  }
  const catalog = directory
    ? "【当前可查阅的组件能力目录】\n" + JSON.stringify({ ...directory, warnings })
      + "\n这是正式知识派生的候选目录，不代表本次需求需要其中任何组件。"
      + (directory.next_offset === null ? "当前目录已列完。" : `当前只展示一页；用 knowledge(action=component_context, offset=${directory.next_offset}) 继续浏览。`)
    : `【组件能力目录】${error ? "启动目录读取未完成。" : "启动目录未提供。"}用 knowledge(action=component_context) 获取；查阅不可用时如实说明知识缺口。`;
  return [COMPONENT_ANALYST_MISSION, "【本次实施任务】\n" + task, catalog].join("\n\n");
}

/** 子会话继承统一知识工具，不继承推进阶段、推送等宿主工具。 */
export function childKnowledgeTools(tools: unknown[] = []): unknown[] {
  return tools.filter(tool => !!tool && typeof tool === "object"
    && "name" in tool && tool.name === "knowledge");
}
