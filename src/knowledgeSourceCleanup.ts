import type { KnowledgeMrPublisher } from "./knowledgeMrPublisher.ts";
import type { DomainKnowledgeJob, KnowledgeCleanupPlan, KnowledgeCleanupPublication } from "./domainKnowledgeTypes.ts";
import { knowledgeRelativePath } from "./domainKnowledgeExtraction.ts";

/** 清理只由人触发；预览和每仓结果留在原萃取任务中，不另起研究或跟踪 MR。 */
export class KnowledgeSourceCleanup {
  constructor(private publisher: Pick<KnowledgeMrPublisher, "previewCleanup" | "publishCleanup">) {}
  async action(job: DomainKnowledgeJob, action: string, input: any, operator: string, save: () => void, signal: AbortSignal) {
    const state = job.source_cleanup;
    if (!state || state.started) throw new Error("当前任务不在萃取前清理阶段");
    const values = action === "preview" ? input.paths_by_target : input.selected_paths_by_target;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("请提供各仓的清理路径");
    // 清理旧位置与新归档目录无关；整批检查仓内路径后，再预览或发布人工选择的文件。
    for (const target of state.repositories) {
      const paths = values[target.id] ?? (action === "preview" ? [] : undefined);
      if (!Array.isArray(paths)) throw new Error("请提供各仓的清理路径");
      const planned = action === "publish" ? state.plans.find(plan => plan.target_id === target.id)?.paths ?? [] : [];
      for (const value of [...paths, ...planned]) {
        try {
          if (typeof value !== "string") throw new Error();
          knowledgeRelativePath(value);
        } catch { throw new Error("清理路径须为仓内相对目录或文件，不能使用仓根、绝对路径或上级目录"); }
      }
    }
    if (action === "preview") {
      const plans: KnowledgeCleanupPlan[] = [];
      for (const target of state.repositories) {
        if (state.publications.some(publication => publication.target_id === target.id && (publication.url || publication.revision || publication.mr_attempted))) throw new Error("清理分支已经推送，请先完成原清理 MR");
        const plan = await this.publisher.previewCleanup(target, values[target.id] ?? [], operator, signal);
        plans.push(plan);
      }
      state.plans = plans; state.publications = []; save();
      return;
    }
    if (action !== "publish") throw new Error("未知清理操作");
    if (input.target_id !== undefined && (typeof input.target_id !== "string" || !state.repositories.some(target => target.id === input.target_id))) {
      throw new Error("清理目标不存在");
    }
    // 先校验整批选择再进行外部操作，不能前一个仓推送后才发现后一个仓的输入无效。
    for (const target of state.repositories) {
      const plan = state.plans.find(plan => plan.target_id === target.id), selected = values[target.id];
      if (!plan || !Array.isArray(selected) || selected.some(path => typeof path !== "string" || !plan.entries.some(entry => entry.path === path))) throw new Error("清理预览或文件选择无效，请重新预览");
      const previous = state.publications.find(publication => publication.target_id === target.id);
      if (previous && (previous.revision || previous.mr_attempted || previous.url) && JSON.stringify(previous.removed_paths) !== JSON.stringify([...new Set(selected)].sort())) throw new Error("原清理分支已确定删除范围，请按原范围重试");
      plan.selected_paths = [...new Set(selected)].sort();
    }
    save();
    for (const target of state.repositories.filter(target => input.target_id === undefined || target.id === input.target_id)) {
      signal.throwIfAborted();
      const plan = state.plans.find(plan => plan.target_id === target.id)!;
      const previous = state.publications.find(publication => publication.target_id === target.id);
      if (previous?.url || !plan.selected_paths!.length) continue;
      const persist = (publication: KnowledgeCleanupPublication) => {
        signal.throwIfAborted();
        state.publications = [...state.publications.filter(item => item.target_id !== target.id), structuredClone(publication)]; save();
      };
      try { persist(await this.publisher.publishCleanup(job, target, plan, plan.selected_paths, previous, operator, persist, signal)); }
      catch (error) {
        signal.throwIfAborted();
        const latest = state.publications.find(publication => publication.target_id === target.id);
        const message = error instanceof Error ? error.message : "清理 MR 创建失败";
        persist(latest?.url && latest.state === "opened" ? latest
          : { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: plan.selected_paths!, branch: "", documents: [], ...latest,
            state: "failed", error: message });
      }
    }
  }
}
