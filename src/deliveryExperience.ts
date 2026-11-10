import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskSummary } from "./taskService.ts";
import { MemoryStore, MEMORY_DIMENSIONS, type MemoryInput } from "./taskMemory.ts";
import { summaryGit, type DeliverySummaryInput, type DeliverySummarySessionOptions } from "./deliverySummaryAgent.ts";
import { runDeliveryExperienceAgent } from "./deliveryExperienceAgent.ts";
import { memoryFeedbackEvidence } from "./memoryFeedback.ts";

type Owner = { cwd?: string; summary: TaskSummary };
type Options = DeliverySummarySessionOptions & { store: MemoryStore; repo: string; module?: string;
  evidence: () => Array<{ id: string; [key: string]: unknown }>;
  notify?: (count: number, firstId: string) => Promise<void> };
type Runner = (input: DeliverySummaryInput, signal: AbortSignal, options: DeliverySummarySessionOptions) => Promise<string>;
const read = (path: string): any => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

export function parseDeliveryExperiences(text: string, evidence: Set<string>, module?: string): Array<Pick<MemoryInput, "dimension" | "trigger" | "scope" | "module" | "paths" | "problem" | "conclusion"> & { evidence_ids: string[] }> {
  // A single explicit JSON block is unambiguous even when the model adds a preface.
  // Multiple blocks remain invalid; all evidence and field validation stays below.
  const blocks = [...text.matchAll(/^```(?:json)?\s*\n([\s\S]*?)^```\s*$/gm)];
  const parsed = JSON.parse(blocks.length === 1 ? blocks[0][1] : text.trim());
  if (!Array.isArray(parsed?.drafts)) throw new Error("经验草稿输出格式错误");
  return parsed.drafts.map((d: any) => {
    if (!d || !MEMORY_DIMENSIONS.includes(d.dimension) || !["one_off", "local", "general", "platform"].includes(d.scope)
      || typeof d.trigger !== "string" || !d.trigger.trim() || d.trigger.length > 80
      || typeof d.problem !== "string" || !d.problem.trim() || d.problem.length > 400
      || typeof d.conclusion !== "string" || !d.conclusion.trim() || d.conclusion.length > 1000
      || !Array.isArray(d.paths) || d.paths.some((p: unknown) => typeof p !== "string" || p.length > 500)
      || !Array.isArray(d.evidence_ids) || !d.evidence_ids.length || d.evidence_ids.some((id: string) => !evidence.has(id))
      || (d.module && d.module !== module)) throw new Error("经验草稿缺少有效结论、范围或真实依据");
    return { dimension: d.dimension, trigger: d.trigger.trim(), scope: d.scope, module: d.module || undefined,
      paths: d.paths, problem: d.problem, conclusion: d.conclusion, evidence_ids: [...new Set<string>(d.evidence_ids)] };
  });
}

/** 完成后的旁路；首次版本与结果持久化，重复完成/重启不重复调用模型或重复入库。 */
export class DeliveryExperiences<T extends Owner> {
  private jobs = new Map<string, { work: Promise<void>; abort: AbortController }>();
  private stopped = false;
  get activeCount(): number { return this.jobs.size; }
  constructor(private options: (task: T) => Options, private runner: Runner = runDeliveryExperienceAgent) {}
  capture(task: T): void {
    const d = task.summary.delivery;
    if (!d?.git_push?.sha || !d.mr_url) return;
    try {
      const root = join(task.summary.workspace, "delivery-experience");
      mkdirSync(root, { recursive: true });
      // 兼容已有首次交付摘要，绝不以最后一次推送冒充首次交付。
      const previous = read(join(task.summary.workspace, "delivery-summary/state.json"));
      writeFileSync(join(root, "first.json"), JSON.stringify({ head: previous?.first_head ?? previous?.head ?? d.git_push.sha, mr: d.mr_url }), { flag: "wx", mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") console.warn(`首次交付经验快照未保存：${String(error)}`); }
  }
  start(task: T): void {
    const d = task.summary.delivery;
    if (this.stopped || this.jobs.has(task.summary.id) || !task.cwd || task.summary.status !== "completed" || d?.mr_state !== "已合入" || task.summary.ui_fixture) return;
    const root = join(task.summary.workspace, "delivery-experience");
    const path = join(root, "state.json");
    const first = read(join(root, "first.json")) ?? read(join(task.summary.workspace, "delivery-summary/state.json"));
    // 无首次快照的历史任务不猜版本，也不批量追溯消耗模型。
    if (!first?.head) return;
    const prior = read(path);
    if (prior && prior.status !== "running" && !(prior.status === "completed" && prior.ids?.length && !prior.notified)) return;
    const snapshot = structuredClone(task.summary);
    const abort = new AbortController();
    const save = (value: object) => { if (!existsSync(root)) return; writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${path}.tmp`, path); };
    try { mkdirSync(root, { recursive: true }); if (prior?.status !== "completed") save({ status: "running", started_at: new Date().toISOString() }); }
    catch { return; }
    const work = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const options = this.options(task);
      if (prior?.status === "completed") {
        try { await options.notify?.(prior.ids.length, prior.ids[0]); save({ ...prior, notified:true }); }
        catch (error) { options.log?.(`经验通知待重试：${String(error)}`); }
        return;
      }
      const timer = setTimeout(() => abort.abort(new Error("经验整理超过10分钟")), 600_000); timer.unref();
      try {
        const base = first.first_head ?? first.head;
        // squash 的目标提交会混入目标分支变化；优先使用合入时已核对的源分支最终版本。
        let head = snapshot.delivery!.git_push?.sha;
        const merged = snapshot.delivery!.merged_sha;
        if (merged && /^[a-f0-9]{40,64}$/i.test(merged)) {
          try { await summaryGit(task.cwd!, ["merge-base", "--is-ancestor", base, merged]); head = merged; }
          catch { // squash 无源提交祖先关系；使用完成时已核对包含于合入的本地版本。
            head = (await summaryGit(task.cwd!, ["rev-parse", "HEAD"])).trim();
          }
        }
        if (!head || !/^[a-f0-9]{40,64}$/i.test(base) || !/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("缺少交付版本，无法对比");
        await summaryGit(task.cwd!, ["cat-file", "-e", `${base}^{commit}`]);
        await summaryGit(task.cwd!, ["cat-file", "-e", `${head}^{commit}`]);
        const feedback = memoryFeedbackEvidence(snapshot.workspace, options.store);
        const evidence: ReturnType<Options["evidence"]> = [...options.evidence(), ...feedback.records];
        const ids = new Set(["diff", ...evidence.map(e => e.id)]);
        writeFileSync(join(root,"evidence.json"),JSON.stringify(evidence),{mode:0o600});
        const context = JSON.stringify({ requirement: snapshot.continuation?.state === "active" ? snapshot.continuation.text : snapshot.requirement, module: options.module,
          memory_usage_available: feedback.available,
          base, head, merged_sha: snapshot.delivery!.merged_sha, evidence_count: evidence.length, evidence: evidence.slice(0,100).map(e => ({id:e.id,summary:String(e.note ?? e.summary ?? "").slice(0,300)})),
          verification: { prepush: snapshot.delivery!.prepush, checks: snapshot.delivery!.checks },
          existing_experiences: options.store.list().filter(r => r.task === snapshot.id || (r.review?.status === "accepted" && (r.scope === "platform" || r.repo === options.repo || (options.module && r.module === options.module)))).slice(-50).map(r => ({ id:r.id, trigger:r.trigger, conclusion:r.conclusion })),
        });
        writeFileSync(join(root, "input.json"), context, { mode: 0o600 });
        const outputPath = join(root, "output.json");
        let drafts = read(outputPath);
        if (!drafts) {
          drafts = parseDeliveryExperiences(await this.runner({ taskId:snapshot.id, repo:task.cwd!, root, base, head,
            mrUrl:snapshot.delivery!.mr_url ?? "", capturedAt:new Date().toISOString(), context }, abort.signal, options), ids, options.module);
          abort.signal.throwIfAborted();
          if (!existsSync(root)) return;
          writeFileSync(outputPath, JSON.stringify(drafts), { mode:0o600 });
        }
        if (!existsSync(root) || task.summary.status !== "completed") return;
        const saved: string[] = [];
        for (const [index, draft] of drafts.entries()) {
          const evidenceKey = `delivery:${snapshot.id}:${snapshot.delivery_generation ? `${snapshot.delivery_generation}:` : ""}${index}`;
          const existing = options.store.list({ task:snapshot.id }).find(r => r.evidence === evidenceKey);
          const { evidence_ids, ...fields } = draft;
          const record = existing ?? options.store.record({ ...fields, source:"delivery_review", judged_by:"agent", repo:options.repo,
            task:snapshot.id, evidence:evidenceKey, author:"交付复盘 Agent", phase:"completed",
            quote:(`首次交付 ${base}\n最终交付 ${head}\nMR ${snapshot.delivery!.mr_url}\n依据 ${evidence_ids.join("、")}\n` + evidence.filter(e => evidence_ids.includes(e.id)).map(e => String(e.note ?? e.summary ?? "")).join("\n").slice(0, 350)).slice(0, 450) });
          saved.push(record.id);
        }
        writeFileSync(join(snapshot.workspace, "交付经验复盘.md"), `# 交付经验复盘\n\n首次交付：${base}\n最终交付源版本：${head}\nMR：${snapshot.delivery!.mr_url}\n\n` + (saved.length ? saved.map((id, i) => `- [${drafts[i].trigger}（待审查）](/?kbPage=experience&memory_id=${id})`).join("\n") : "本次未提炼出有充分依据的新增可复用经验。") + "\n", {mode:0o600});
        const completed = { status:"completed", finished_at:new Date().toISOString(), base, head, ids:saved, notified:!saved.length };
        save(completed);
        try { options.onPublished?.(); } catch (e) { options.log?.(`经验草稿已保存，投影刷新失败：${String(e)}`); }
        if (saved.length) {
          try { await options.notify?.(saved.length, saved[0]!); save({...completed,notified:true}); }
          catch (e) { options.log?.(`经验通知待重试：${String(e)}`); }
        }
      } catch (error) { save({ status:"failed", error:String(error), finished_at:new Date().toISOString() }); options.log?.(`任务 ${snapshot.id} 经验整理失败，不影响交付：${String(error)}`); }
      finally { clearTimeout(timer); }
    }).catch(error => { try { save({status:"failed",error:String(error)}); } catch {} }).finally(() => this.jobs.delete(snapshot.id));
    this.jobs.set(snapshot.id, {work, abort});
  }
  async flush(): Promise<void> { await Promise.all([...this.jobs.values()].map(j => j.work)); }
  async stopTask(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.abort.abort(new Error("任务开始下一次交付"));
    await job.work;
  }
  async shutdown(): Promise<void> { this.stopped = true; for (const j of this.jobs.values()) j.abort.abort(); await this.flush(); }
}
