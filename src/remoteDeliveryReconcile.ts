import { withRemoteReadTimeout } from "./remoteReadTimeout.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { createSafeGitView } from "./safeGit.ts";
import type { TaskSummary } from "./taskService.ts";
import type { GateView } from "./mergeWatch.ts";
import { projectPushReceipt } from "./pipelineHandoff.ts";
import { scopePipelineArtifacts } from "./pipelineArtifactScope.ts";
import { classifyDeliveryFailure } from "./deliveryFailure.ts";
import type { StallClass } from "./stallPolicy.ts";

export interface RemoteMr { id: string | number; url: string; source_branch: string; target_branch: string }
export interface RemoteReconcileResult { message: string; candidates?: RemoteMr[]; proceed: boolean }
export interface RemoteReconcileHost {
  summary: TaskSummary; cwd?: string; repo: string; platformUrl?: string; headers: Record<string, string>;
  readTimeoutMs?: number;
  current(): boolean; persist(): void;
  observe(branch: string): Promise<{ head: string; sha?: string; url: string }>;
  gates(mr?: RemoteMr, signal?: AbortSignal): Promise<GateView | undefined>;
  published(receipt: NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>): void;
  settle(state: "merged" | "closed", sha?: string): Promise<void>;
  retirePushQuestion(merged?: boolean): void; watch(): void;
}

/** 远端事实先于交付动作。内核阶段和 published 文本均不能代替远端核验。
 * 该函数不推送、不创建 MR，也不以本地 HEAD 猜测远端版本。 */
const inFlight = new WeakMap<TaskSummary, Promise<RemoteReconcileResult>>();
export async function reconcileRemoteDelivery(host: RemoteReconcileHost, selected?: string): Promise<RemoteReconcileResult> {
  while (inFlight.has(host.summary)) { await withRemoteReadTimeout(() => inFlight.get(host.summary)!, host.readTimeoutMs); if (!host.current()) return { message: "任务已发生变化", proceed: false }; }
  const work = reconcile(host, selected); inFlight.set(host.summary, work);
  try { return await work; } finally { if (inFlight.get(host.summary) === work) inFlight.delete(host.summary); }
}

/** 查询失败沿用既有恢复预算。先分类原始错误，避免展示前缀破坏契约判据。 */
export async function remoteDeliveryAllowsProceed(host: RemoteReconcileHost, recovery: {
  retry(message: string): void;
  stall(message: string, kind: StallClass): void;
}): Promise<boolean> {
  if (!host.current()) return false;
  try {
    const result = await reconcileRemoteDelivery(host);
    if (result.candidates?.length) recovery.stall(result.message + "，请点击刷新 MR 状态选择", "contract");
    return result.proceed;
  } catch (error) {
    if (host.current()) {
      const cause = String(error).replace(/^(Error:\s*)+/, "");
      const verdict = classifyDeliveryFailure(cause);
      if (verdict.disposition === "retry") recovery.retry(`远端交付核验未完成：${cause}；系统正在自动重试`);
      else recovery.stall(`无法确认已有 MR：${cause}；已停止续推`, verdict.stall_class);
    }
    return false;
  }
}

export function needsRemoteRecovery(summary: TaskSummary, cwd?: string, mission?: string): boolean {
  if (["paused", "pausing", "completed", "canceled"].includes(summary.status) || mission) return false;
  if (["cloud_push_confirm", "host_push_confirm"].includes(summary.waiting?.step ?? "")) return true;
  try { return !summary.delivery?.mr_url && !summary.delivery?.mr_id
    && JSON.parse(readFileSync(join(cwd ?? "", ".mae-flow.json"), "utf8")).current === "delivery_watch"; }
  catch { return false; }
}
async function reconcile(host: RemoteReconcileHost, selected?: string): Promise<RemoteReconcileResult> {
  const { summary } = host;
  const done = (message: string, proceed = true): RemoteReconcileResult => ({ message, proceed });
  if (["completed", "canceled"].includes(summary.status)) return done("任务已结束", false);
  let config: Record<string, string> = {};
  try { config = JSON.parse(readFileSync(join(host.cwd ?? "", ".mae-flow.json"), "utf8")).config ?? {}; } catch { /* 尚未初始化 */ }
  const source = summary.delivery?.source_branch || config["分支名"];
  const target = summary.delivery?.target_branch || config["基线分支"];
  const hasMr = () => !!summary.delivery?.mr_url?.trim() || !!String(summary.delivery?.mr_id ?? "").trim();
  if (!hasMr() && source && target && host.platformUrl) {
    const query = new URLSearchParams({ repo: host.repo, source_branch: source, target_branch: target });
    {
      const body = await withRemoteReadTimeout(async signal => {
        const response = await fetch(`${host.platformUrl}/mr/discover?${query}`, { headers: host.headers, signal });
        if (response.status === 404) throw new Error("平台未配置 mr_discover，无法确认已有 MR；请更新适配器配置后重试");
        if (!response.ok) throw new Error(`MR 查找失败（HTTP ${response.status}）`);
        return await response.json() as { mrs?: RemoteMr[] };
      }, host.readTimeoutMs);
      if (!host.current()) return done("任务已发生变化，本次查询未应用", false);
      if (!Array.isArray(body.mrs)) throw new Error("MR 查找响应不完整");
      const matching = body.mrs.filter(mr => mr.source_branch === source && mr.target_branch === target
        && /^(https?):\/\//.test(mr.url) && mr.id !== undefined);
      if (matching.length !== body.mrs.length) throw new Error("MR 查找返回了不匹配的分支或标识");
      // 分支名可被串行兄弟任务复用。先核对候选，不能先写入再查生命周期。
      const candidates: RemoteMr[] = [];
      const published = summary.delivery?.git_push?.sha;
      for (const mr of matching) {
        const view = await withRemoteReadTimeout(signal => host.gates(mr, signal), host.readTimeoutMs);
        if (!host.current()) return done("任务已发生变化，本次查询未应用", false);
        if (!view) throw new Error("候选 MR 状态核验失败");
        if (view.mrState === "opened") candidates.push(mr);
        else if (published && view.sourceSha === published && source && host.cwd) {
          const observed = await withRemoteReadTimeout(() => host.observe(source), host.readTimeoutMs);
          if (!host.current()) return done("任务已发生变化，本次查询未应用", false);
          if (observed.head === published) candidates.push(mr);
        }
      }
      const chosen = selected ? candidates.find(mr => String(mr.id) === selected) : candidates.length === 1 ? candidates[0] : undefined;
      if (selected && !chosen) throw new Error("所选 MR 已不匹配当前任务，请重新查询");
      if (!chosen && candidates.length > 1) return { message: "找到多个同分支 MR，请选择本任务对应的 MR", candidates, proceed: false };
      if (chosen) {
        summary.delivery = { ...summary.delivery, mr_id: chosen.id, mr_url: chosen.url, source_branch: source, target_branch: target };
        host.persist();
      }
    }
  }
  if (hasMr()) {
    const view = await withRemoteReadTimeout(signal => host.gates(undefined, signal), host.readTimeoutMs);
    if (!host.current()) return done("任务已发生变化，本次查询未应用", false);
    if (!view) throw new Error("MR 状态核验失败，请检查平台连接及凭据后重试");
    if (view.mrState !== "opened") {
      await host.settle(view.mrState, view.sourceSha);
      if (view.mrState === "merged" && summary.status !== "completed")
        return done(summary.detail ?? "合入事实尚未确认属于当前交付，未完成任务", false);
      if (view.mrState === "merged") host.retirePushQuestion(true);
      host.watch();
      return done(view.mrState === "merged" ? "MR 已合入，已接续任务收口" : "MR 已关闭，任务尚未完成", false);
    }
    host.watch();
  }
  // MR 打开只证明生命周期，不能证明当前 HEAD 已发布。旧收据丢失、
  // 外部追加推送或刚找回 MR 时，仍需对账；否则旧确认卡会一直催人推送。
  // 只有 MR 信息的台账也能查询生命周期，不要求它凭空补出本地 Git 现场。
  if (!source || !host.cwd || !host.repo) return done(hasMr()
    ? "MR 尚未合入；缺少仓库或本地现场，尚未核验推送版本"
    : "尚未确认任务分支或仓库，无法核验远端推送");
  const observed = await withRemoteReadTimeout(() => host.observe(source), host.readTimeoutMs);
  if (!host.current()) return done("任务已发生变化，本次查询未应用", false);
  if (observed.sha && observed.sha === observed.head) {
    const receipt = { sha: observed.sha, ref: `refs/heads/${source}`, remote: "origin", url: observed.url };
    projectPushReceipt(summary, receipt); host.persist();
    scopePipelineArtifacts(join(summary.workspace, "pipeline"), receipt.sha); host.published(receipt);
    host.retirePushQuestion(); host.persist();
    return done(hasMr() ? "当前提交已在远端，MR 尚未合入" : "当前提交已在远端，尚未找到对应 MR");
  }
  return done(observed.sha ? "远端与本地提交不同，未将远端版本当作本地已发布" : "远端尚无此任务分支");
}

/** 使用推送同款宿主隔离环境，只读远端；不读取工作区 remote/helper/hooks。 */
export async function observePublishedBranch(input: {
  cwd: string; repo: string; branch: string;
  sandbox: { dir: string; args: string[]; env: NodeJS.ProcessEnv };
  run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ status: number | null; stdout?: string; stderr?: string }>;
}) {
  const { sandbox, branch } = input;
  if (/^[a-z][a-z\d+.-]*:/i.test(input.repo) && !/^(?:https?|file):\/\//i.test(input.repo)
      && !/^[a-z]:[\\/]/i.test(input.repo)) throw new Error("远端核验仅支持 HTTPS 或本地仓地址");
  const url = /^(?:https?|file):\/\//i.test(input.repo) ? input.repo : resolve(input.repo);
  const view = createSafeGitView(input.cwd);
  try {
    const run = (args: string[]) => input.run([...sandbox.args, ...args], { cwd: sandbox.dir, env: sandbox.env, timeoutMs: 15_000 });
    if ((await run(["check-ref-format", "--branch", branch])).status !== 0) throw new Error("任务分支名不合法");
    const headResult = await input.run([...sandbox.args, "rev-parse", "--verify", "HEAD"], { cwd: input.cwd, env: view.environment(sandbox.env), timeoutMs: 10_000 });
    const head = headResult.stdout?.trim() ?? "";
    if (headResult.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("无法核验本地 HEAD");
    const result = await run(["ls-remote", "--heads", url, `refs/heads/${branch}`]);
    if (result.status !== 0) throw new Error("远端分支查询失败或超时，请检查凭据与连接");
    const rows = (result.stdout ?? "").trim().split("\n").filter(Boolean);
    const matching = rows.map(row => row.split(/\s+/)).filter(row => row[1] === `refs/heads/${branch}`);
    if (rows.length && (matching.length !== 1 || !/^[a-f0-9]{40,64}$/i.test(matching[0][0]))) throw new Error("远端分支响应不完整");
    const recheck = await input.run([...sandbox.args, "rev-parse", "HEAD"], { cwd: input.cwd, env: view.environment(sandbox.env), timeoutMs: 10_000 });
    if (recheck.status !== 0 || recheck.stdout?.trim() !== head) throw new Error("查询期间 HEAD 已变化，请重新查询");
    let publicUrl = url;
    try { const parsed = new URL(url); parsed.username = ""; parsed.password = ""; publicUrl = parsed.toString(); } catch { /* 本地路径 */ }
    return { head, sha: matching[0]?.[0], url: publicUrl };
  } finally { view.cleanup(); }
}

/** 合入事实必须覆盖当前本地提交；允许外部追加提交，不要求 SHA 相等。
 * 缺少对象时从配置的仓库取证，绝不 checkout、合并或改写用户分支。 */
export async function mergedIncludesLocalHead(input: {
  cwd: string; repo: string; sha?: string;
  sandbox: { dir: string; args: string[]; env: NodeJS.ProcessEnv };
  run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ status: number | null; stdout?: string; stderr?: string }>;
}): Promise<boolean> {
  if (!input.sha || !/^[a-f0-9]{40,64}$/i.test(input.sha)) return false;
  const view = createSafeGitView(input.cwd);
  try {
    const run = (args: string[]) => input.run([...input.sandbox.args, ...args], {
      cwd: input.cwd, env: view.environment(input.sandbox.env), timeoutMs: 15_000,
    });
    if ((await run(["cat-file", "-e", `${input.sha}^{commit}`])).status !== 0) {
      if (!input.repo || (/^[a-z][a-z\d+.-]*:/i.test(input.repo)
        && !/^(?:https?|file):\/\//i.test(input.repo) && !/^[a-z]:[\\/]/i.test(input.repo))) return false;
      const url = /^(?:https?|file):\/\//i.test(input.repo) ? input.repo : resolve(input.repo);
      if ((await run(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", url, input.sha])).status !== 0) return false;
    }
    return (await run(["merge-base", "--is-ancestor", "HEAD", input.sha])).status === 0;
  } finally { view.cleanup(); }
}
