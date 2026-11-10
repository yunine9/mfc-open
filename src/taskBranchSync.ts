import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskControlError } from "./errors.ts";
import { createSafeGitView, runSafeWorktreeGit } from "./safeGit.ts";
import { runGitProcess } from "./hostGitSandbox.ts";
import { GIT_TRANSFER_TIMEOUT_MS } from "./gitTransferBudget.ts";
import { absorbForeignBranchCommits } from "./foreignBranchCommits.ts";
import { stallClassForError } from "./deliveryRecovery.ts";
import type { StallClass } from "./stallPolicy.ts";
import type { PreparedHostGit } from "./hostGitSandbox.ts";
import type { TaskSummary } from "./taskService.ts";
import type { KernelFeedbackBatch } from "./kernelDelivery.ts";

export interface BranchSyncCredential { username: string; password: string; email?: string }
export interface BranchSyncHost {
  summary: TaskSummary;
  cwd?: string;
  enabled: boolean;
  defaultRepository(): string | undefined;
  validateRepository(repository: string): void;
  credential(): BranchSyncCredential | undefined;
  prepareGit(credential: BranchSyncCredential | undefined): PreparedHostGit;
  cleanupGit(sandbox: PreparedHostGit): void;
  current(): boolean;
  persist(): void;
  lastReply(): string | undefined;
  feedbackBaseSha(): string;
  enqueueRepair(message: string, detail: string): void;
  stall(message: string, kind: StallClass): void;
  openFeedback(items: KernelFeedbackBatch["items"]): void;
  notifyStopped(): void;
  deliver(): Promise<unknown>;
  log?(message: string): void;
}
export interface BranchSyncRequest {
  target: string;
  allowMissing?: boolean;
  ready(message: string): void;
}

/** 两种分支同步共用身份和工作区配置，凭据只来自宿主临时目录。 */
function worktreeArguments(cwd: string, sandbox: PreparedHostGit,
  credential: BranchSyncCredential | undefined, account?: string): string[] {
  const name = credential?.username ?? account ?? "mae-flow-cloud";
  const email = credential?.email ?? `${name.replace(/[^a-zA-Z0-9_.+-]/g, "-")}@localhost`;
  return [...sandbox.args, "-c", `safe.directory=${resolve(cwd)}`,
    "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false",
    "-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/** 统一任务分支接续、目标分支合并和冲突准备；任务排队与会话生命周期仍由宿主管理。 */
export class TaskBranchSync {
  constructor(private readonly host: BranchSyncHost) {}
  /** 将本任务的提交接在远端新增提交之后，不重复询问是否接纳他人提交。
   * 探测不可用时继续原推送流程，由实际推送报告失败；历史改写或真实
   * 代码冲突不能强行覆盖，分别停止并说明原因、或交给原任务解决。 */
  async absorb(
    branch: string,
    dispatchRepair = true,
  ): Promise<"ok" | "absorbed" | "blocked"> {
    if (!this.host.enabled || !this.host.cwd) return "ok";
    const cwd = this.host.cwd;
    let remoteUrl: string;
    try {
      const configured = this.host.summary.repo_url ?? this.host.defaultRepository();
      if (!configured) throw new Error("任务没有权威代码仓地址");
      this.host.validateRepository(configured);
      if (/^[a-z][a-z\d+.-]*:/i.test(configured)
          && !/^(?:https?|file):\/\//i.test(configured)
          && !/^[a-z]:[\\/]/i.test(configured)) {
        throw new Error("只允许 HTTPS 或本地仓传输");
      }
      remoteUrl = /^(?:https?|file):\/\//i.test(configured)
        ? configured : resolve(configured);
    } catch (error) {
      this.host.log?.(`任务 ${this.host.summary.id} 外来提交探测跳过`
        + `(fail-open): ${String(error)}`);
      return "ok";
    }
    const credential = this.host.credential();
    let sandbox: PreparedHostGit;
    try {
      sandbox = this.host.prepareGit(credential);
    } catch (error) {
      this.host.log?.(`任务 ${this.host.summary.id} 外来提交探测跳过`
        + `(Git 沙箱创建失败,fail-open): ${String(error)}`);
      return "ok";
    }
    let gitView: ReturnType<typeof createSafeGitView>;
    try {
      gitView = createSafeGitView(cwd);
    } catch (error) {
      this.host.cleanupGit(sandbox);
      this.host.log?.(`任务 ${this.host.summary.id} 外来提交探测跳过`
        + `(安全 Git 视图创建失败,fail-open): ${String(error)}`);
      return "ok";
    }
    // 与冲突修复同一套边界:fetch/rebase 看真实 refs/index/objects,
    // config 却来自空代理 gitdir,Agent 写进 .git/config 的 hook、
    // fsmonitor、insteadOf 都进不了这个带宿主凭据的进程。
    const worktreeArgs = worktreeArguments(cwd, sandbox, credential, this.host.summary.luban_account);
    const worktreeEnv = gitView.environment(sandbox.env);
    try {
      const outcome = await absorbForeignBranchCommits({
        branch,
        remoteUrl,
        lastPushedSha: this.host.summary.delivery?.git_push?.sha
          ?? this.host.summary.delivery?.sha,
        transport: (args) => runGitProcess([...sandbox.args, ...args], {
          timeoutMs: 60_000, env: sandbox.env,
        }),
        // rebase 的中间状态落在 GIT_DIR(这里是代理 gitdir)里,
        // 所以整轮必须复用同一个 view——换一个就 abort 不回来了。
        worktree: (args) => runGitProcess([...worktreeArgs, ...args], {
          cwd,
          env: worktreeEnv,
          timeoutMs: args[0] === "fetch" || args[0] === "rebase"
            ? GIT_TRANSFER_TIMEOUT_MS : 30_000,
        }),
      });
      if (outcome.kind === "none") return "ok";
      if (outcome.kind === "unavailable") {
        this.host.log?.(`任务 ${this.host.summary.id} 外来提交探测跳过`
          + `(fail-open): ${outcome.reason}`);
        return "ok";
      }
      if (outcome.kind === "blocked") {
        if (outcome.conflicts?.length) {
          const message = `远端任务分支存在代码冲突，已还原接续现场。请先调用 task_control(action="sync_branch") 准备真实合并冲突，自行解决并提交，完成同步及编译、UT 后重新请求 push；不要重复直接推送。涉及文件：${outcome.conflicts.join("、")}`;
          this.host.summary.detail = message;
          this.host.persist();
          if (dispatchRepair) this.host.enqueueRepair(message, "远端分支冲突，Agent 同步解决中");
          return "blocked";
        }
        this.host.stall(outcome.reason, "safety");
        return "blocked";
      }
      const previous = this.host.summary.delivery?.foreign_commits;
      this.host.summary.delivery = {
        ...this.host.summary.delivery,
        foreign_commits: {
          base_sha: outcome.base_sha,
          absorbed_at: new Date().toISOString(),
          count: (previous?.count ?? 0) + outcome.count,
          subjects: [...outcome.subjects, ...(previous?.subjects ?? [])]
            .slice(0, 12),
        },
      };
      this.host.summary.detail = `分支上有 ${outcome.count} 条外来提交`
        + "(有人直接推了代码),已把本任务的提交接到它们之后重新验证";
      this.host.persist();
      this.host.log?.(`任务 ${this.host.summary.id} 接续分支上的 `
        + `${outcome.count} 条外来提交:${outcome.previous_head.slice(0, 12)}`
        + ` → ${outcome.head.slice(0, 12)}(基座 ${
          outcome.base_sha.slice(0, 12)})`);
      return "absorbed";
    } finally {
      gitView.cleanup();
      this.host.cleanupGit(sandbox);
    }
  }

  /** 使用既有的可信 fetch/merge；冲突现场交给原会话继续解决。 */
  async syncBeforePush(target: string): Promise<void> {
    if (!this.host.cwd || !target) throw new TaskControlError("缺少代码工作区或目标分支，无法在推送前同步基准分支");
    const unresolved = () => {
      const result = runSafeWorktreeGit(this.host.cwd!, ["diff", "--name-only", "--diff-filter=U"]);
      if (result.status !== 0) throw new TaskControlError("无法检查本地合并冲突，未推送");
      return String(result.stdout ?? "").trim();
    };
    const repair = "请解决冲突并 git add、git commit，调用 task_control(action=\"sync_branch\") 完成同步，执行受影响的验证后再 push；保留双方必要改动。";
    if (unresolved()) throw new TaskControlError(`本地仍有未解决的合并冲突。${repair}`);
    let message: string | undefined;
    await this.repair(this.host.feedbackBaseSha(), undefined, {
      target, ready: value => { message = value; },
    });
    if (!this.host.current()) throw new TaskControlError("任务执行权已变化");
    if (!message) throw new TaskControlError(this.host.summary.detail ?? "目标分支同步失败，未推送");
    if (unresolved()) throw new TaskControlError(`${message}\n${repair}`);
  }

  async repair(
    sha: string,
    max: number | undefined,
    sync?: BranchSyncRequest,
  ): Promise<boolean> {
    if (!this.host.current()) return true;
    const delivery = this.host.summary.delivery ?? (this.host.summary.delivery = {});
    const target = sync?.target ?? delivery.target_branch;
    if (!this.host.cwd || !target) return true;
    const loop: NonNullable<NonNullable<TaskSummary["delivery"]>["loop"]> = sync
      ? { round: 0, max, state: "repairing" } : delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    if (!sync && loop.kind === "conflict" && loop.last_sha === sha) {
      loop.state = "halted";
      const diagnosis = (this.host.lastReply() ?? "").trim();
      if (diagnosis) loop.diagnosis = diagnosis.slice(0, 2000);
      this.host.summary.detail =
        "冲突修复会话没有产生新提交,冲突仍在,请人工处理";
      this.host.persist();
      this.host.notifyStopped();
      return true;
    }
    const cwd = this.host.cwd;
    let remoteUrl: string;
    try {
      const configured = this.host.summary.repo_url ?? this.host.defaultRepository();
      if (!configured) throw new Error("任务没有权威代码仓地址");
      this.host.validateRepository(configured);
      if (/^[a-z][a-z\d+.-]*:/i.test(configured)
          && !/^(?:https?|file):\/\//i.test(configured)) {
        throw new Error("只允许 HTTPS 或本地仓传输");
      }
      remoteUrl = /^(?:https?|file):\/\//i.test(configured)
        ? configured : resolve(configured);
    } catch (error) {
      this.host.summary.detail = `冲突修复准备失败: ${String(error)}`;
      this.host.persist();
      return true;
    }
    const credential = this.host.credential();
    let sandbox: PreparedHostGit;
    try {
      sandbox = this.host.prepareGit(credential);
    } catch (error) {
      this.host.summary.detail = `冲突修复 Git 沙箱创建失败: ${String(error)}`;
      this.host.persist();
      return true;
    }
    let gitView: ReturnType<typeof createSafeGitView>;
    try {
      gitView = createSafeGitView(cwd);
    } catch (error) {
      this.host.cleanupGit(sandbox);
      this.host.summary.detail = `冲突修复安全 Git 视图创建失败: ${String(error)}`;
      this.host.persist();
      return true;
    }
    const worktreeArgs = worktreeArguments(cwd, sandbox, credential, this.host.summary.luban_account);
    // fetch/merge 看真实 refs/index/objects，但 config 来自空代理 gitdir。
    // 因而 Agent 写入的 fsmonitor、filter、merge driver、url.insteadOf 与
    // credential helper 都不可能在带宿主权限/短期令牌的进程里执行。
    const worktreeEnv = gitView.environment(sandbox.env);
    // 异步 + 预算(2026-08-25 卡死事故同病类):fetch 走网络、merge
    // 碰大仓索引,同步执行会把事件循环冻住整段时间。
    const git = (...args: string[]) => runGitProcess(
      [...worktreeArgs, ...args], {
        cwd, env: worktreeEnv,
        timeoutMs: args[0] === "fetch" || args[0] === "merge"
          ? GIT_TRANSFER_TIMEOUT_MS : 30_000,
      });
    try {
      const targetCheck = await git("check-ref-format", "--branch", target);
      if (targetCheck.status !== 0) {
        this.host.summary.detail = `冲突修复准备失败:目标分支名不合法 ${target}`;
        this.host.persist();
        return true;
      }
      if (sync?.allowMissing) {
        const remote = await git("ls-remote", "--exit-code", "--heads", remoteUrl, `refs/heads/${target}`);
        if (remote.status === 2) { sync.ready("任务分支尚未推送，继续同步目标分支"); return true; }
        if (remote.status !== 0) throw new TaskControlError("无法查询远端任务分支，请检查网络和凭据后重试");
      }
      const fetched = await git(
        "fetch", "--no-tags", "--no-recurse-submodules", remoteUrl,
        `+refs/heads/${target}:refs/remotes/origin/${target}`);
      if (fetched.status !== 0) {
        this.host.summary.detail = `冲突修复准备失败(fetch ${target}):`
          + `${String(fetched.stderr || "").slice(0, 300)}`;
        this.host.persist();
        return true; // 环境问题不硬闯,留痕等人(或下一轮监控重试)
      }
      if (!this.host.current()) return true;
      const beforeMerge = String(
        (await git("rev-parse", "HEAD")).stdout || "").trim();
      const merged = await git("merge", "--no-edit", `origin/${target}`);
      if (merged.status === 0) {
        const afterMerge = String(
          (await git("rev-parse", "HEAD")).stdout || "").trim();
        if (sync) { sync.ready(`已同步 origin/${target}；未自动推送。`); return true; }
        if (beforeMerge && afterMerge === beforeMerge) {
          // 新提交已经包含目标分支，但平台的 conflict gate 可能还没刷新。
          // 这不是“修复会话没有提交”：不写 last_sha、不退出监控，让
          // watchMerge 按原轮询节奏继续看门禁/MR。
          this.host.summary.detail = "本地已无冲突，等待平台刷新冲突门禁";
          this.host.persist();
          return false;
        }
        // 干净合并:没有真冲突(门禁可能滞后)。统一交给 tryDeliver 的
        // host-only 推送与远端 SHA 复核，避免另开无收据旁路。
        loop.kind = "conflict";
        loop.last_sha = sha;
        this.host.summary.detail = "与目标分支干净合并,等待宿主推送并触发新流水线";
        this.host.persist();
        setImmediate(() => void this.host.deliver());
        return true;
      }
      const conflicted = String((await git(
        "diff", "--no-ext-diff", "--no-textconv",
        "--name-only", "--diff-filter=U")).stdout || "")
        .trim().split("\n").filter(Boolean);
      if (!conflicted.length) {
        // merge 失败却没有冲突文件 = 环境怪状(本地脏文件之类),
        // 别把 agent 派进一个说不清的现场。
        await git("merge", "--abort");
        this.host.summary.detail = "merge 失败但无冲突文件,请人工:"
          + `${String(merged.stderr || "").slice(0, 300)}`;
        this.host.persist();
        return true;
      }
      // merge 的 config 必须隔离，但冲突会话随后使用真实 `.git`。将 Git
      // 在可信代理 gitdir 中生成的最小 merge 状态复制回真实 gitdir；
      // index/objects/refs 本来就绑定真实仓。若目标被 Agent 换成软链，
      // 先在代理视图里 abort，再 fail-closed，绝不跟随它写宿主文件。
      try {
        for (const name of [
          "MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", "ORIG_HEAD",
        ]) {
          const source = join(gitView.proxyGitDir, name);
          if (!existsSync(source)) continue;
          const sourceInfo = lstatSync(source);
          if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
            throw new Error(`代理 Git 状态 ${name} 不是普通文件`);
          }
          const targetPath = join(gitView.repositoryGitDir, name);
          if (existsSync(targetPath)) {
            const targetInfo = lstatSync(targetPath);
            if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
              throw new Error(`任务 Git 状态 ${name} 不是普通文件`);
            }
          }
          writeFileSync(targetPath, readFileSync(source), { mode: 0o600 });
        }
      } catch (error) {
        await git("merge", "--abort");
        this.host.summary.detail = `冲突现场安全落盘失败: ${String(error)}`;
        this.host.persist();
        return true;
      }
      const repairMessage = [
        `宿主已准备与 origin/${target} 的真实合并冲突：`, ...conflicted,
        "读取冲突双方实现、提交历史和调用方，保留双方必要改动；普通代码冲突自行解决，不要无脑选 ours/theirs。业务意图矛盾且证据不足时才向责任人说明取舍。",
        "逐个修改冲突文件，git add 后 git commit 完成合并；不要 rebase、force push 或丢弃无关修改。",
        "解决后再次调用 task_control sync_branch 完成剩余同步，再执行受影响的编译、UT 和集成验证；失败继续修复，不复用旧 SHA 的成功。最后用 task_control push 更新原 MR，不另建 MR。",
      ].join("\n");
      if (sync) { sync.ready(repairMessage); return true; }
      try {
        this.host.openFeedback(conflicted.map((file) => ({
          id: `conflict:${sha}:${target}:${file}`,
          source: "conflict",
          source_id: `${sha}:${target}:${file}`,
          source_revision: 0,
          kind: "merge_conflict",
          summary: `与 ${target} 合并时 ${file} 发生冲突`,
          verification: "gate",
          file,
        })));
      } catch (error) {
        await git("merge", "--abort");
        this.host.stall(
          `冲突事实已发现，但内核未能打开统一反馈批次：${String(error)}`,
          stallClassForError(error, "contract"));
        return true;
      }
      loop.kind = "conflict";
      loop.round = 0; // 冲突触发同样清零 CI 重试
      loop.last_sha = sha;
      loop.state = "repairing";
      this.host.enqueueRepair(repairMessage,
        `与 ${target} 冲突(${conflicted.length} 个文件),专职会话解决中`);
      return true;
    } finally {
      gitView.cleanup();
      this.host.cleanupGit(sandbox);
    }
  }

}
