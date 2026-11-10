/**
 * 业务知识地图(ADR-0012,2026-09-10 起单源化,ADR-0021):问题分析
 * 消费的领域事实库——团队资产库按绑定模块定格的已发布知识,只读投影
 * 在 .mae-flow-work/business-modules/,条目带 title/summary/when_to_use
 * 检索意图,进 analyze 时注入。
 *
 * 仓内 docs/ 不再由平台扫描注入(ADR-0021:发现权归仓)——AGENTS.md
 * 标准句声明即高置信,未声明的仓 docs/ 置信度中等、以代码为准;分层
 * 规则在技能 repo-docs(2026-09-10 从开场/续聊提示词常驻段挪入),
 * 不在本模块逐仓生成。正文一律由 Agent 按需 Read;只供领域事实,
 * 不定流程、不是证据门槛;不举卡、不分介入档。
 */

import type { IssueSessionState } from "./state.ts";

/** 业务知识地图(analyze 注入段,ADR-0012/0021):只剩资产库一源,
 * 条目=路径+标题+一句何时读。只在 analyze 阶段注入;台账为空返回
 * 空数组(静默缺席)。 */
export function businessKnowledgeLines(
  state: IssueSessionState,
): string[] {
  if (state.stage !== "analyze") return [];
  const assets = state.business_knowledge?.entries ?? [];
  if (!assets.length) return [];
  const lines = [
    "业务知识地图(领域事实——先查这里,与当前问题相关才读正文;"
      + "只供业务事实,不定流程;引用业务事实时把文件路径随文标注进报告):",
    "【团队资产库】(已按绑定模块定格,只读;目录:"
      + " .mae-flow-work/business-modules/INDEX.md)",
  ];
  for (const entry of assets) {
    lines.push(`- ${entry.relative_path} — ${entry.title}`
      + `${entry.when_to_use ? `(何时读:${entry.when_to_use})` : ""}`);
  }
  return lines;
}
