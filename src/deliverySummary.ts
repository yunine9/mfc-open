import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Notifier } from "./notifier.ts";
import type { TaskSummary } from "./taskService.ts";
import { collectReportEvidence } from "./deliveryReportEvidence.ts";
import { frozenTaskBaseline } from "./artifacts.ts";
import { runDeliverySummaryAgent, summaryGit, type DeliverySummaryInput, type DeliverySummarySessionOptions, type DeliverySummaryResult } from "./deliverySummaryAgent.ts";

export const DELIVERY_SUMMARY_FILE = "交付报告.md";
export const DELIVERY_SUMMARY_ARTIFACT = `task-materials/${DELIVERY_SUMMARY_FILE}`;
type Owner = { cwd?: string; summary: TaskSummary };
type SummaryOptions = DeliverySummarySessionOptions & { notifier?: Pick<Notifier, "notifyOutcome">; taskLink?: string };
type Runner = (input: DeliverySummaryInput, signal: AbortSignal, options: DeliverySummarySessionOptions) => Promise<DeliverySummaryResult>;
interface ReportState { status: "running" | "completed" | "partial" | "failed"; key: string; head: string; first_head: string;
  base?: string; published_head?: string; captured_at: string; finished_at?: string; error?: string; recoveries: number }
function readState(path: string): ReportState | undefined { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }

export interface DeliveryReportView { status: "running" | "completed" | "partial" | "failed"; available: boolean; message: string; head: string }
export function deliveryReportView(workspace: string): DeliveryReportView | undefined {
  const state = readState(join(workspace, "delivery-summary/state.json"));
  if (!state) return;
  const available = existsSync(join(workspace, DELIVERY_SUMMARY_FILE));
  const message = state.status === "running" ? "交付报告正在生成，包含测试结果与改动点 4+1"
    : state.status === "failed" ? "交付报告生成失败，可重试"
    : state.status === "partial" ? "交付报告已更新（部分图未生成）" : "交付报告已更新 · 测试结果与改动点 4+1";
  return { status: state.status, available, head: state.head,
    message: message + ` · 版本 ${state.head.slice(0, 8)}` + (available && (state.status === "running" || state.status === "failed") ? "；仍可查看上份报告，请核对其中的版本" : "") };
}

/** 只用有意义的结果变化更新报告，轮询时间、修复进度和通知不重复调用模型。 */
export function deliveryReportRevision(summary: TaskSummary) {
  const d = summary.delivery, head = d?.git_push?.sha;
  const pipeline = d?.sha === head ? d?.pipeline : undefined;
  const outcome = pipeline === "success" ? "success" : pipeline?.startsWith("failed") ? "failed" : "pending";
  const prepush = d?.prepush;
  const verification = { pipeline: outcome, pipeline_sha: d?.sha,
    checks: outcome !== "pending" ? d?.checks : undefined,
    prepush: prepush && !["preparing", "repairing"].includes(prepush.state) ? prepush : undefined };
  const phase = summary.status === "completed" ? "交付完成" : outcome === "pending" ? "验证尚未结束" : "本次验证结果已返回";
  const key = createHash("sha256").update(JSON.stringify({ head, mr: d?.mr_url, target: d?.target_branch,
    verification, phase, merged_sha: d?.merged_sha, continuation: summary.continuation?.id })).digest("hex");
  return { key, head, phase, verification };
}

/** 报告在后台更新；失败保留上份材料，绝不改变交付结果或唤醒编码会话。 */
export class DeliverySummaries<T extends Owner> {
  private jobs = new Map<string, { key: string; abort: AbortController; work: Promise<void> }>();
  private pending = new Map<string, T>();
  private stopped = false;
  constructor(private options: (task: T) => SummaryOptions, private runner: Runner = runDeliverySummaryAgent) {}
  isRunning(id: string): boolean { return this.jobs.has(id); }

  start(task: T, recovering = false, force = false): void {
    const { summary } = task;
    if (summary.status === "canceled") {
      this.pending.delete(summary.id);
      this.jobs.get(summary.id)?.abort.abort(new Error("任务已取消，停止生成报告"));
      return;
    }
    if (this.stopped || !task.cwd || summary.ui_fixture || summary.workspace_reclaimed_at
      || (summary.continuation && summary.continuation.state !== "active")
      || !summary.delivery?.git_push?.sha || !summary.delivery.mr_url || !summary.delivery.target_branch) return;
    const revision = deliveryReportRevision(summary);
    const root = join(summary.workspace, "delivery-summary"), statePath = join(root, "state.json");
    const active = this.jobs.get(summary.id);
    if (active) { if (active.key !== revision.key) this.pending.set(summary.id, task); return; }
    const prior = readState(statePath);
    // 已完成的历史任务不批量补跑；仅恢复已启动的报告。
    if (recovering && !prior && summary.status === "completed") return;
    if (!force && prior?.key === revision.key && !(recovering && prior.status === "running" && prior.recoveries < 1)) return;
    const snapshot = structuredClone(summary), repo = task.cwd;
    const head = revision.head!, abort = new AbortController();
    const state: ReportState = { status: "running", key: revision.key, head, first_head: prior?.first_head ?? prior?.head ?? head,
      base: prior?.base, published_head: prior?.published_head, captured_at: new Date().toISOString(),
      recoveries: !force && prior?.key === revision.key ? (prior.recoveries ?? 0) + 1 : 0 };
    const save = () => { writeFileSync(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${statePath}.tmp`, statePath); };
    try { mkdirSync(root, { recursive: true }); save(); }
    catch (error) { console.warn(`交付报告启动失败：${String(error)}`); return; }
    const work = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let options: SummaryOptions | undefined;
      const timer = setTimeout(() => abort.abort(new Error("交付报告超过 10 分钟，已停止")), 600_000); timer.unref();
      try {
        options = this.options(task);
        abort.signal.throwIfAborted();
        if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("交付报告缺少确定的提交版本");
        // 活动 MR 使用当前共同祖先；合入后使用已保存起点，补生成时使用任务建分支记录。
        const base = snapshot.status === "completed" || snapshot.delivery!.merged_sha
          ? state.base ?? await frozenTaskBaseline(repo)
          : (await summaryGit(repo, ["merge-base", `refs/remotes/origin/${snapshot.delivery!.target_branch}`, head])).trim();
        if (!base || !/^[a-f0-9]{40,64}$/i.test(base)) throw new Error("缺少本次 MR 的原始基线，无法生成真实改动报告");
        await summaryGit(repo, ["cat-file", "-e", `${base}^{commit}`]);
        state.base = base; save();
        const evidence = await collectReportEvidence(repo, snapshot);
        const context = JSON.stringify({ requirement: snapshot.continuation?.state === "active" ? snapshot.continuation.text : snapshot.requirement,
          mr: snapshot.delivery!.mr_url, head, base, captured_at: state.captured_at, phase: revision.phase,
          merged_sha: snapshot.delivery!.merged_sha, test_records: revision.verification,
          baseline: { record: snapshot.baseline_build, note: "基线验证不是本次改动的验证结果" },
          evidence_count: evidence.records.length, evidence_limitations: evidence.limitations });
        writeFileSync(join(root, "input.json"), context, { mode: 0o600 });
        writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence), { mode: 0o600 });
        const report = await this.runner({ taskId: snapshot.id, repo, root, head, base,
          mrUrl: snapshot.delivery!.mr_url!, capturedAt: state.captured_at, context }, abort.signal, options);
        abort.signal.throwIfAborted();
        if (!existsSync(root) || task.summary.status === "canceled") return;
        // 迟到报告不能覆盖新版本；同一任务只串行处理最后一次变化。
        if (deliveryReportRevision(task.summary).key !== revision.key || this.pending.has(snapshot.id)) return;
        const content = `# 交付报告\n\n> ${revision.phase}。报告仅对应下列版本和生成时已取得的证据；后续变化会自动更新。\n> MR：${snapshot.delivery!.mr_url}\n> 版本：\`${head}\` · ${state.captured_at}\n\n${report.body.trim()}\n`;
        writeFileSync(join(root, "report.tmp"), content, { mode: 0o600 });
        renameSync(join(root, "report.tmp"), join(snapshot.workspace, DELIVERY_SUMMARY_FILE));
        state.status = report.status; state.published_head = head; state.finished_at = new Date().toISOString(); save();
        try { options.onPublished?.(); } catch (error) { options.log?.(`交付报告已发布，页面刷新失败：${String(error)}`); }
        const account = snapshot.luban_account;
        if (account && options.notifier && options.taskLink) {
          try { await options.notifier.notifyOutcome({ taskId: snapshot.id, account,
            status: `交付报告已更新${report.status === "partial" ? "（部分图未生成）" : ""} ${head.slice(0, 8)} · ${revision.phase}`,
            summary: `测试报告与改动点 4+1 已生成${report.status === "partial" ? "，部分图未生成，原位置已保留说明" : ""}，请联系对应 Committer 审视；未验证项和证据边界已列明。`,
            link: `${options.taskLink}?deliverySummary=1` }); }
          catch (error) { options.log?.(`交付报告通知失败（文档已发布）：${String(error)}`); }
        }
      } catch (error) {
        if (existsSync(root)) {
          // 关停保持 running，重启只补跑一次；其他失败等待新版本或新验证结果。
          if (!abort.signal.aborted || !this.stopped) state.status = "failed";
          state.error = String(error); state.finished_at = new Date().toISOString(); save();
        }
        options?.log?.(`任务 ${snapshot.id} 交付报告未更新：${String(error)}`);
        try { options?.onPublished?.(); } catch { /* 页面刷新失败不改变报告结果。 */ }
      } finally { clearTimeout(timer); }
    }).catch(error => console.warn(`交付报告保存失败：${String(error)}`)).finally(() => {
      this.jobs.delete(snapshot.id);
      const next = this.pending.get(snapshot.id); this.pending.delete(snapshot.id);
      if (next) this.start(next);
      else if (!abort.signal.aborted && deliveryReportRevision(task.summary).key !== revision.key) this.start(task);
    });
    this.jobs.set(summary.id, { key: revision.key, abort, work });
  }

  async flush(): Promise<void> { while (this.jobs.size) await Promise.all([...this.jobs.values()].map(job => job.work)); }
  async stopTask(id: string): Promise<void> {
    this.pending.delete(id);
    const job = this.jobs.get(id);
    if (job) { job.abort.abort(new Error("任务开始下一次交付")); await job.work; }
  }
  async shutdown(): Promise<void> {
    this.stopped = true; this.pending.clear();
    for (const job of this.jobs.values()) job.abort.abort(new Error("服务停止"));
    await this.flush();
  }
}
