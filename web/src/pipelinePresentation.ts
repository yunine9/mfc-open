/** 流水线原始状态串 → 人话。带括号注记的,注记本身就是给人看的原因。 */
export function pipelineLabel(raw: string): string {
  const annotated = raw.match(/^(running|failed|success)\((.+)\)$/);
  if (annotated) return annotated[2];
  if (raw === "not_found") return "尚未发现流水线";
  if (raw === "running") return "运行中";
  if (raw === "success") return "已通过";
  if (raw === "failed") return "未通过";
  return raw;
}

