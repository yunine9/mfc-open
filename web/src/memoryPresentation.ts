/** 未取得服务端事实时，不把未知状态误判成没有部署。 */
export function memorySearchPresentation(
  sidecar?: "ready" | "unavailable" | "absent", failed = false,
): { label: string; title: string; state: string } {
  if (failed) return { state: "unknown", label: "检索状态读取失败", title: "暂时无法确认检索状态，请刷新重试。" };
  if (sidecar === "ready") return { state: sidecar, label: "语义检索在线", title: "Agent 可按语义查找相关任务记忆。" };
  if (sidecar === "unavailable") return { state: sidecar, label: "语义检索暂不可用", title: "检索已启用但尚未就绪或运行异常；记忆记录仍保留。" };
  if (sidecar === "absent") return { state: sidecar, label: "语义检索未启用", title: "当前服务未配置语义检索；候选仍可记录、审查；采纳后的经验可按 ID 展开，自动推荐需启用语义检索。启用请联系管理员。" };
  return { state: "unknown", label: "正在读取检索状态…", title: "等待服务返回检索状态。" };
}

/** 形成来源与复用资格分开；只有明确采纳事实代表可复用。 */
export function memoryPreparation(row: {
  source: string; draft?: "template" | "model" | "failed"; drafting?: boolean;
  review?: { status: "pending" | "accepted" | "rejected" };
}): { label: string; title: string } {
  if (row.review?.status === "accepted") return { label: "已采纳", title: "已由团队成员确认内容与范围，可用于检索和复用。" };
  if (row.review?.status === "rejected") return { label: "已停用", title: "保留来源记录，不用于检索或自动注入。" };
  if (row.drafting) return { label: "整理中 · 待确认", title: "模型正在整理候选，采纳后才能复用；不影响任务继续。" };
  return { label: "待确认", title: row.draft === "failed" ? "整理失败，原记录保留；可人工修订后采纳。" : "尚无明确采纳记录。查看依据、结论及适用范围后再决定，不默认复用。" };
}

/** 对话回执直达具体候选；地址只用于导航，不改变审查权限。 */
export function memoryReviewFocus(search: string): string | undefined {
  const id = new URLSearchParams(search).get("memory_id");
  return id && /^c-[a-z0-9]+-[a-f0-9]+$/.test(id) ? id : undefined;
}

/** 页头卡片与经验页「待确认」页签共用一个口径：停用、并入、归档的都不算在手。 */
export function memoryCounts(rows: Array<{ can_review?: boolean; withdrawn?: boolean; superseded_by?: string; archived?: boolean; review?: { status: string } }>) {
  const active = rows.filter(row => !row.withdrawn && !row.superseded_by && !row.archived);
  return {
    pending: active.filter(row => row.can_review && (row.review?.status ?? "pending") === "pending").length,
    accepted: active.filter(row => row.review?.status === "accepted").length,
  };
}
