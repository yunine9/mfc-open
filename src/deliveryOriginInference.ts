import type { CodeOrigin } from "./deliveryAnalyticsTypes.ts";

/** 提交说明可作为分类线索。普通后续调整和检视修改共用一个分类。 */
export function inferCommitOrigin(message: string): { origin: CodeOrigin; evidence: string[]; explicitRepair: boolean } | undefined {
  const text = message.slice(0, 16000);
  const repair = /修复|修正|整改|解决|消除|补齐|补充|移除|删除|调整|补单测|\b(?:fix(?:es|ed)?|resolve[ds]?|address(?:ed)?|remove[ds]?|correct(?:ed)?)\b/i.test(text);
  const review = /(?:按|根据|响应|处理|落实).{0,16}(?:检视|评审|审查|review)|(?:检视|评审|审查)(?:意见|反馈|问题)|\b(?:review\s+(?:comments?|feedback|findings?)|PR\s+feedback)\b/i.test(text);
  const pipeline = repair && /CodeCheck|CodeCC|CloudBuild|GTEST_SKIP|流水线|质量门禁|静态检查|编译(?:失败|错误|报错)|(?:DT|UT|测试|单测)?覆盖率|\b(?:CI\s+(?:failure|errors?|checks?)|build\s+(?:failure|errors?)|test\s+coverage|lint(?:er)?|compilation\s+errors?)\b/i.test(text);
  const origin: CodeOrigin = pipeline ? "pipeline" : "review";
  const reason = pipeline ? "提交说明提到修复流水线或质量检查问题"
    : review ? "提交说明提到处理检视反馈"
    : "提交说明未明确提到流水线修复，按后续调整统计";
  return { origin, explicitRepair: pipeline || review, evidence: [`推断：${reason}`] };
}
