/** Read-side projection of the Kernel-owned feedback loop. Owner closure is
 * reconciled separately; a scheduling defer never masquerades as PASS. */
import { FeedbackStore, type FeedbackRecord, type FeedbackSource } from "./feedbackStore.ts";

export function projectKernelFeedback(state: Record<string, any>, store: FeedbackStore, existing: FeedbackRecord[]): void {
  const batches = Array.isArray(state.delivery_loop?.batches) ? state.delivery_loop.batches : [];
  const current = new Map(existing.map((item) => [item.id, item]));
  const statuses: Record<string, FeedbackRecord["status"]> = {
    queued: "open",
    repairing: "repairing",
    addressed: "addressed",
    awaiting_verification: "awaiting_verification",
    closed: "closed",
    needs_human: "needs_human",
    deferred: "deferred",
    superseded: "superseded",
    superseded_by_merge: "superseded_by_merge",
  };
  const sources = new Set<FeedbackSource>([
    "workspace", "build_fix", "pipeline", "mr_discussion",
    "conflict", "scope", "push_confirmation",
  ]);
  for (const batch of batches) {
    const status = statuses[String(batch?.status ?? "")];
    if (!status || !Array.isArray(batch?.items)) continue;
    const results = new Map((Array.isArray(batch.results)
      ? batch.results : []).map((item: any) => [String(item?.id ?? ""), item]));
    for (const item of batch.items) {
      const id = String(item?.id ?? "");
      let existing = current.get(id);
      const source = String(item?.source ?? "") as FeedbackSource;
      const sourceNeedsHumanAuthority = source === "workspace"
        || source === "mr_discussion"
        || source === "push_confirmation";
      const deferred = state.delivery_loop?.deferred_feedback?.[id];
      const published = state.delivery_loop?.published?.sha;
      // 与内核 historical_pipeline_item 使用同一份已签名发布事实。
      // 混合批次仍有人工意见时整批可继续 repairing，旧 CI 条目已退出调度。
      // 不用当前 HEAD 或批次 base_sha 猜测未知版本告警已经过时。
      const sourceSha = String(item?.observed_sha || item?.source_id || "").split(":")[0];
      const historicalPipeline = source === "pipeline" && !!published
        && /^[a-f0-9]{40,64}$/i.test(sourceSha) && sourceSha !== published;
      const result: any = results.get(id);
      let projected = deferred ? "deferred" as const : status;
      // 整批在等人工决定时，已解释的其他条目仍待核验；不能跟着变成人工问题。
      if (!deferred && status === "needs_human" && result
          && result.status !== "needs_human") projected = "awaiting_verification";
      if (status === "superseded_by_merge" && !sourceNeedsHumanAuthority) {
        projected = "superseded_by_merge";
      } else if (historicalPipeline && status !== "closed" && !deferred) {
        projected = "superseded";
      } else if (sourceNeedsHumanAuthority && !deferred) {
        // 整批结束不能替人验收；仅有发布/合入也不能声称 Agent 已回复。
        if (status === "closed") projected = "awaiting_verification";
        else if (status === "superseded" || status === "superseded_by_merge") {
          projected = existing?.status ?? "open";
        }
      }
      // 结束调度不等于验证通过；原告警、逐条回执和内核验证结果均保留。
      const resolution = projected === "superseded"
        ? `已被新版本 ${String(published || batch.superseded_by_push || "").slice(0, 12)} 替代，原失败记录保留，不代表验证通过`
        : projected === "superseded_by_merge"
          ? "MR 已合入，本条停止自动处理；原失败记录保留，不代表验证通过"
        : String(deferred?.reason ?? result?.summary ?? "")
        || (projected === "closed" ? "权威核验已通过"
          : projected === "awaiting_verification" ? "Agent 已处理，等待来源方核验"
          : `状态更新为 ${projected}`);
      if (!existing && id && sources.has(source)) {
        const restored: FeedbackRecord = {
          id,
          batch_id: String(batch?.batch_id ?? ""),
          source,
          source_id: String(item?.source_id ?? ""),
          source_revision: Number(item?.source_revision ?? 0),
          observed_sha: String(item?.observed_sha || (source === "pipeline" && /^[a-f0-9]{40,64}$/i.test(sourceSha) ? sourceSha : batch?.base_sha) || ""),
          summary: String(item?.summary ?? "反馈内容缺失"),
          ...(item?.material ? { material: String(item.material) } : {}),
          ...(item?.file ? { file: String(item.file) } : {}),
          ...(item?.line !== undefined ? { line: Number(item.line) } : {}),
          verification: String(item?.verification ?? "unknown"),
          status: projected,
          resolution,
          updated_at: String(batch?.opened_at ?? new Date().toISOString()),
        };
        store.upsert([restored]);
        current.set(id, restored);
        existing = restored;
      }
      if (!existing || existing.status === "closed") continue;
      // 内核的 closed 表示“本批代码已通过机器核验”，不能越权代替
      // 批注作者、MR 检视人或 push 卡责任人作最终裁决。这三类先停在
      // 待核验；只有各自来源的权威事件才会调用 resolveFeedbackRecords
      // 真正关闭。机器来源仍由内核 PASS 直接闭环。
      if (existing.status === projected && existing.resolution === resolution) continue;
      store.resolve(id, projected, resolution);
      current.set(id, { ...existing, status: projected, resolution });
    }
  }
}
