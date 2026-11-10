/**
 * 问题流流水线红灯修复的公共件:
 * - repairBudget: 修复轮预算(与需求侧同一管理页旋钮 repair_rounds,
 *   同一缺省 20;0=关掉自动修复,红灯留痕请人工)。
 *
 * 只放与 TaskService 无关的纯机械;分诊/派单不出这条线——问题流的
 * 修复会话就是会话自己(容器在场),平台回合即派单。产物全文镜像的
 * 公共实现在 src/pipelineMirror.ts,直接从那里 import。
 */
import { hasActionablePipelineSummary, PIPELINE_DIMENSION_TEXT, type PipelineArtifactText,
  type PipelineEvidenceAssessment } from "../pipelineEvidence.ts";

/** 仓内适配器最多返回 8,000 字符。也兼容直接返回大段日志的自定义适配器，
 * 将同一份有界摘要用于取证、重启恢复和修复消息。 */
export function repairStatusSummary(log: string | undefined): string | undefined {
  if (!log || log.length <= 16_000) return log;
  const head = log.slice(0, 2_000);
  const tail = log.slice(-4_000);
  const evidence: string[] = [];
  let remaining = 8_000;
  let previous = "";
  for (const [line] of log.slice(head.length, -tail.length).matchAll(/[^\r\n]{1,1600}/g)) {
    const excerpt = previous ? `${previous}\n${line}` : line;
    if (hasActionablePipelineSummary(excerpt)) {
      const picked = excerpt.slice(0, Math.min(2_000, remaining));
      evidence.push(picked);
      remaining -= picked.length + 1;
      if (remaining <= 0) break;
      previous = "";
    } else {
      previous = line.slice(-240);
    }
  }
  return [head, "...（过长日志已摘录）...", ...evidence, tail].join("\n");
}

/** 采证结果随失败事实发送，修复与举卡仍由会话 Agent 判断。 */
export function pipelineEvidenceLines(
  assessment: PipelineEvidenceAssessment,
  artifacts: PipelineArtifactText[],
): string[] {
  const lines = ["**失败证据评估**"];
  for (const dimension of assessment.availableDimensions) {
    lines.push(`${PIPELINE_DIMENSION_TEXT[dimension]}：${assessment.sources[dimension]?.join("、")}`);
  }
  for (const dimension of assessment.missingDimensions) {
    lines.push(`缺失 ${PIPELINE_DIMENSION_TEXT[dimension]}：${assessment.reasons[dimension]?.join("；")}`);
  }
  // 直接保留平台的指标字段和值，不把 DT 数字解释成失败用例数量。
  if (assessment.sources.UT?.some(source => source.includes("指标型质量门缺陷"))) {
    const detail = artifacts.find(item => item.name === "codecheck_detail.json");
    const indicators: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object" || indicators.length >= 20) return;
      if (!Array.isArray(value) && Object.keys(value).some(key => /^indicator_?name$/i.test(key))) {
        indicators.push(JSON.stringify(value).slice(0, 2000));
        return;
      }
      for (const nested of Object.values(value)) visit(nested);
    };
    try { visit(JSON.parse(detail?.text ?? "")); } catch { /* 原文仍在镜像文件中。 */ }
    lines.push(...indicators.map(row => `指标缺陷原文(codecheck_detail.json)：${row}`));
  }
  return lines;
}

/** 修复轮预算:管理页旋钮现读,缺席用需求侧同款缺省 20。 */
export function repairBudget(
  settings?: { runtime?(): { repair_rounds?: number } },
): number {
  const value = settings?.runtime?.().repair_rounds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value) : 20;
}
