interface ContinuationTargets {
  baseline?: string;
  delivery?: { source_branch?: string; target_branch?: string; final_mr?: { target_branch?: string; state?: string } };
  continuation?: { state: string; branch?: string; baseline?: string };
}

function originalTarget(task: ContinuationTargets): string | undefined {
  return task.delivery?.target_branch ?? task.baseline;
}

export function continuationTarget(task: ContinuationTargets): string | undefined {
  return task.continuation && task.continuation.state !== "active" ? task.continuation.baseline : originalTarget(task);
}

/** 继续修改从原交付基线重建工作分支，重试沿用上次准备时保存的基线。 */
export function finalMrContinuationBlock(task: ContinuationTargets): string | undefined {
  const final = task.delivery?.final_mr;
  if (!final) return;
  if (final.state !== "merged") return "尚未确认最终 MR 已合入，请先在代码平台核对合入状态。确认合入后才能从原任务继续修改。";
  const original = originalTarget(task);
  const target = final.target_branch;
  const next = continuationTarget(task);
  if (target && target === target.trim() && target === original && target === next) {
    const branch = task.continuation && task.continuation.state !== "active" ? task.continuation.branch : task.delivery?.source_branch;
    if (!branch) return `任务没有记录可继续使用的平台工作分支，请以「${target}」为基线创建新任务。`;
    return;
  }
  const reason = `原交付目标分支为${original?.trim() ? `「${original}」` : "未知"}，最终 MR 的目标分支为${target?.trim() ? `「${target}」` : "未知"}。`;
  const retry = next !== original ? `上次准备继续修改时保存的基线为${next?.trim() ? `「${next}」` : "未知"}。` : "";
  const action = target?.trim() ? `请以「${target}」为基线创建新任务，接着修改已合入的代码。`
    : "请到最终 MR 确认目标分支，并以该分支为基线创建新任务。";
  return reason + retry + "无法从原任务继续修改。" + action;
}
