import { readLocalCodeSnapshot } from "./finalMrLocalSnapshot.ts";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGitEnvironment } from "./safeGit.ts";
import { awaitTaskDeliveryAnalytics, hasFinalMrSample, observeDeliveryCode } from "./deliveryAnalytics.ts";
import { prepareFinalMrObjects, retainInitialMrCommit } from "./finalMrGitObjects.ts";
import { HostGitSandbox, runGitProcess } from "./hostGitSandbox.ts";
import { readMrVersionBase, type DeliveryMr } from "./mrImport.ts";
import type { PipelineCredential } from "./pipelineClient.ts";
import { continuationPending } from "./taskContinuation.ts";
import type { InitialDeliveryMr } from "./taskFinalMr.ts";
import type { TaskSummary } from "./taskService.ts";

export interface MrSamplingState {
  initialMrBaseLookup?: string;
  finalMrAnalysis?: { key: string; running: boolean; work: Promise<void> };
}
interface SamplingTask extends MrSamplingState { summary: TaskSummary; cwd?: string }
interface SamplingHost<T> {
  current(task: T): boolean;
  platformUrl(): string | undefined;
  settings(task: T): { credential?: PipelineCredential; dataDir: string; log?: (message: string) => void };
  detail(task: T, url: string): Promise<DeliveryMr>;
  save(task: T): void;
  sampled(task: T): void;
  background(task: T, description: string, work: Promise<unknown>): void;
}

/** 新建 MR 时立即记录首版，旧 MR 的版本查询和最终代码采集共用一条后台队列。 */
export class FinalMrSamples<T extends SamplingTask> {
  private lane: Promise<void> = Promise.resolve();
  constructor(private readonly host: SamplingHost<T>) {}

  schedule(task: T, retry = false): void {
    const final = task.summary.delivery?.final_mr, initial = task.summary.delivery?.initial_mr, cwd = task.cwd;
    const finalOnly = !initial && !task.summary.delivery?.mr_url;
    const useTaskRepo = !!cwd && !task.summary.workspace_reclaimed_at && existsSync(join(cwd, ".git"));
    if (!this.host.current(task) || (!useTaskRepo && !finalOnly && !readLocalCodeSnapshot(task.summary, final?.url ?? "")) || final?.state !== "merged" || (!retry && !final.head) || task.summary.status !== "completed"
        || continuationPending(task.summary)) return;
    const key = JSON.stringify([task.summary.delivery_generation, initial?.url, initial?.head, final.url]);
    if (task.finalMrAnalysis?.key === key && (!retry || task.finalMrAnalysis.running)) return;
    if (hasFinalMrSample(task.summary, retry)) return;
    const snapshot = task.summary;
    const stillLinked = () => this.host.current(task) && task.summary === snapshot
      && snapshot.delivery?.final_mr === final && snapshot.delivery?.initial_mr === initial;
    const work = this.lane.then(async () => {
      if (!stillLinked()) return;
      if (!final.head) {
        // 合入时间已登记；手动刷新只补充与同一合入结果匹配的源代码版本。
        const latest = await this.host.detail(task, final.url);
        if (!stillLinked() || latest.state !== "merged" || !latest.sha || String(final.id) !== latest.iid
            || latest.source_branch !== final.source_branch || latest.target_branch !== final.target_branch
            || (final.merge_commit_sha && latest.merge_commit_sha !== final.merge_commit_sha)
            || (final.merged_at && latest.merged_at && Date.parse(final.merged_at) !== Date.parse(latest.merged_at))) return;
        final.head = latest.sha;
        final.base ??= latest.base_sha;
        this.host.save(task);
      }
      const platformUrl = this.host.platformUrl();
      const { credential, dataDir, log } = this.host.settings(task);
      if (platformUrl) {
        const anchors = [initial, final].filter((mr): mr is InitialDeliveryMr => !!mr?.head && !mr.base);
        const bases = await Promise.allSettled(anchors.map(mr => readMrVersionBase({ platformUrl, url: mr.url, head: mr.head!, credential })));
        if (!stillLinked()) return;
        let changed = false;
        bases.forEach((result, index) => {
          if (result.status === "fulfilled" && result.value) { anchors[index].base = result.value; changed = true; }
        });
        if (changed) this.host.save(task);
      }
      const sample = async (repo: string) => {
        try {
          const prior = initial ?? { head: finalOnly ? snapshot.delivery?.git_push?.sha : undefined };
          await prepareFinalMrObjects(repo, final.repo, [final, prior], new HostGitSandbox(dataDir, log), credential);
        } catch (error) { log?.(`最终 MR 代码对象暂不完整 ${snapshot.id}：${String(error)}`); }
        if (!stillLinked()) return;
        observeDeliveryCode(snapshot, repo, final.head!, true);
        await awaitTaskDeliveryAnalytics(snapshot);
      };
      if (useTaskRepo && cwd) return sample(cwd);
      // 任务未创建工作区时，只在临时仓读取关联 MR 的版本，分析完成即回收。
      const temporary = await mkdtemp(join(tmpdir(), "mfc-final-mr-code-"));
      try {
        const init = await runGitProcess(["init", "--quiet", "--template="], { cwd: temporary, env: safeGitEnvironment(), timeoutMs: 5000 });
        if (init.status !== 0) throw new Error("无法初始化最终 MR 的临时代码仓");
        if (stillLinked()) await sample(temporary);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }).finally(() => {
      if (task.finalMrAnalysis?.work !== work) return;
      task.finalMrAnalysis.running = false;
      if (stillLinked()) this.host.sampled(task);
    });
    this.lane = work.catch(() => {});
    task.finalMrAnalysis = { key, work, running: true };
    this.host.background(task, "最终 MR 代码对比", work);
  }

  captureInitialBase(task: T, createdMr: boolean): void {
    const d = task.summary.delivery, initial = d?.initial_mr;
    if (!initial?.head || initial.base || d?.final_mr) return;
    const key = JSON.stringify([task.summary.delivery_generation, initial.url, initial.head]);
    if (task.initialMrBaseLookup === key) return;
    const platformUrl = this.host.platformUrl();
    if (!platformUrl) return;
    task.initialMrBaseLookup = key;
    if (createdMr && task.cwd) this.host.background(task, "保留初版 MR 提交", retainInitialMrCommit(task.cwd, initial.head));
    const lookup = async () => {
      if (!this.host.current(task) || task.summary.delivery?.initial_mr !== initial
          || task.summary.delivery.final_mr) return;
      const base = createdMr ? await this.host.detail(task, initial.url).then(mr => mr.sha === initial.head ? mr.base_sha : undefined)
        : await readMrVersionBase({ platformUrl, url: initial.url, head: initial.head!,
          credential: this.host.settings(task).credential });
      const current = task.summary.delivery;
      if (!base || !this.host.current(task) || current?.final_mr
          || !current?.initial_mr || task.initialMrBaseLookup !== key
          || current.initial_mr.url !== initial.url || current.initial_mr.head !== initial.head) return;
      current.initial_mr.base = base;
      this.host.save(task);
    };
    const work = createdMr ? lookup() : this.lane.then(lookup);
    if (!createdMr) this.lane = work.catch(() => {});
    this.host.background(task, "读取初版 MR 比较基线", work);
  }
}
