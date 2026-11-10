/**
 * 任务分支上的**外来提交**:本任务没有推送过、却已经在远端分支上的提交。
 *
 * 它只可能是人为介入——bot 分支的地址不会自己长出提交。用户 2026-09-04
 * 拍板"外来提交一定是人为介入,默认可信":宿主不为它举卡、不拦、不问,
 * 只把本任务尚未推送的提交接到它后面重新验证,新 HEAD 照常走 Build-Fix
 * → 推送确认 → 推送这条既有链路。
 *
 * 老行为是拿同一个已验证 SHA 一遍遍撞远端的 non-fast-forward 拒收:
 * 内网实锤 task-40 同一条失败刷了 110 次,自愈预算烧光也不可能自己好——
 * 因为重放的输入压根没变。
 *
 * 只有两种情况仍然 fail-closed 停下喊人,它们都不是"接续"能解决的:
 * - **历史被改写**:我们推上去的提交在远端已经不可达。旧绿灯不背书新
 *   历史,平台也不该替人猜哪一边才是对的;
 * - **接不上**(rebase 冲突 / 工作区还有未提交改动):宿主不替人解冲突,
 *   也不猜着把没提交的改动一起卷进历史。
 */

/** 与 runGitProcess / runSafeWorktreeGitAsync 结构兼容的最小结果形状。 */
export interface ForeignGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type ForeignGitRunner = (args: string[]) => Promise<ForeignGitResult>;

export type ForeignCommitOutcome =
  /** 远端分支不存在,或它的提交本地已经全有:无事发生。 */
  | { kind: "none" }
  /** 读不到远端/环境不给力。fail-open:不是新门禁,后面真 push 会如实
   * 失败并按既有预算自愈,不能因为探测失败就把任务停下。 */
  | { kind: "unavailable"; reason: string }
  | {
    kind: "absorbed";
    /** 吸收时的远端分支头。此后一切机械重组的**最老锚**就是它。 */
    base_sha: string;
    previous_head: string;
    head: string;
    count: number;
    /** `<短 SHA> <标题>`,只用于对人和对 Agent 披露。 */
    subjects: string[];
  }
  | { kind: "blocked"; reason: string; conflicts?: string[] };

const short = (sha: string) => sha.slice(0, 7);

function ok(result: ForeignGitResult): boolean {
  return result.status === 0 && !result.error;
}

function text(result: ForeignGitResult): string {
  return String(result.stdout ?? "").trim();
}

function brief(result: ForeignGitResult): string {
  return String(result.stderr || result.error?.message || "未知 Git 错误")
    .trim().slice(0, 200);
}

async function hasObject(
  git: ForeignGitRunner, sha: string,
): Promise<boolean> {
  return ok(await git(["cat-file", "-e", `${sha}^{commit}`]));
}

/** `merge-base --is-ancestor` 用退出码说话:0=是,1=否,128=对象不可读。
 * 后两者都当"不是",但只有 0 才敢当"是"——错判成 true 会让改写过的
 * 历史被当成干净接续。 */
async function isAncestor(
  git: ForeignGitRunner, ancestor: string, descendant: string,
): Promise<boolean> {
  return ok(await git(["merge-base", "--is-ancestor", ancestor, descendant]));
}

export async function absorbForeignBranchCommits(input: {
  branch: string;
  remoteUrl: string;
  /** 本任务最近一次推送收据里的 SHA。没有它就无从判断远端那条分支
   * 到底是不是本任务的,也就不敢自动接续。 */
  lastPushedSha?: string;
  /** 不带工作区的传输命令(ls-remote):走宿主凭据沙箱。 */
  transport: ForeignGitRunner;
  /** 工作区命令(fetch/rebase):必须在**同一个** safe git view 里执行,
   * rebase 的中间状态在 GIT_DIR 里,换一个代理 gitdir 就 abort 不回来。 */
  worktree: ForeignGitRunner;
}): Promise<ForeignCommitOutcome> {
  const { branch, remoteUrl, transport, worktree } = input;
  const lastPushed = String(input.lastPushedSha ?? "").trim();
  const ref = `refs/heads/${branch}`;
  if (!ok(await transport(["check-ref-format", "--branch", branch]))) {
    return { kind: "unavailable", reason: `分支名不合法:${branch}` };
  }
  const listed = await transport(["ls-remote", "--heads", remoteUrl, ref]);
  if (!ok(listed)) {
    return { kind: "unavailable", reason: `读取远端分支失败:${brief(listed)}` };
  }
  let remoteSha = (text(listed).split("\n")[0] ?? "").split(/\s+/)[0] ?? "";
  // 远端还没有这条分支:首次推送,没有外来提交可言。
  if (!/^[0-9a-f]{40}$/i.test(remoteSha)) return { kind: "none" };
  // 常态快路:远端头就是我们推的那个(或更老)。不下载、不改动任何东西。
  if (await hasObject(worktree, remoteSha)
      && await isAncestor(worktree, remoteSha, "HEAD")) {
    return { kind: "none" };
  }
  if (!lastPushed) {
    return {
      kind: "blocked",
      reason: `远端分支 ${branch} 上已有本任务没推送过的提交 `
        + `${short(remoteSha)},而本任务还没有任何推送收据,无法确认这条`
        + "分支归本任务所有;已停止推送,请人工确认分支归属。",
    };
  }
  const fetched = await worktree([
    "fetch", "--no-tags", "--no-recurse-submodules", remoteUrl,
    `+${ref}:refs/remotes/origin/${branch}`,
  ]);
  if (!ok(fetched)) {
    return { kind: "unavailable", reason: `拉取远端分支失败:${brief(fetched)}` };
  }
  // ls-remote 与 fetch 之间仍可能有人推送，接续必须使用本次实际拉到的头。
  const fetchedHead = await worktree(["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
  if (!ok(fetchedHead) || !/^[0-9a-f]{40,64}$/i.test(text(fetchedHead))) {
    return { kind: "unavailable", reason: "无法核对本次拉取的远端分支提交" };
  }
  remoteSha = text(fetchedHead);
  if (!await hasObject(worktree, remoteSha)) {
    return { kind: "unavailable", reason: "拉取后仍读不到远端分支提交" };
  }
  // 探测与 fetch 之间我们自己的推送落地了(自愈重试和真 push 撞车):
  // 远端头已经是 HEAD 的祖先,不需要接续。
  if (await isAncestor(worktree, remoteSha, "HEAD")) return { kind: "none" };
  if (!await isAncestor(worktree, lastPushed, remoteSha)) {
    return {
      kind: "blocked",
      reason: `远端分支 ${branch} 已被改写:本任务推送过的 `
        + `${short(lastPushed)} 在远端最新提交 ${short(remoteSha)} 上`
        + "已不可达。旧验证不背书新历史,已停止推送,请人工确认分支现状。",
    };
  }
  const foreign = await worktree([
    "log", "--format=%h %s", `${lastPushed}..${remoteSha}`,
  ]);
  if (!ok(foreign)) {
    return { kind: "unavailable", reason: `读取外来提交失败:${brief(foreign)}` };
  }
  const subjects = text(foreign).split("\n").map((line) => line.trim())
    .filter(Boolean);
  const unstaged = await worktree(["diff", "--quiet"]);
  const staged = await worktree(["diff", "--cached", "--quiet"]);
  if (unstaged.error || staged.error
      || unstaged.status === null || staged.status === null) {
    return { kind: "unavailable", reason: "读取工作区状态失败" };
  }
  if (unstaged.status !== 0 || staged.status !== 0) {
    return {
      kind: "blocked",
      reason: `分支上有 ${subjects.length} 条外来提交(有人直接推了代码),`
        + "同时工作区还有未提交改动;平台不会猜着把它们卷进接续,"
        + "已停止推送,请在代码检视中确认处理。",
    };
  }
  const before = text(await worktree(["rev-parse", "--verify", "HEAD"]));
  if (!before) return { kind: "unavailable", reason: "读取当前 HEAD 失败" };
  // 只重放**本任务尚未推送**的提交(remoteSha..HEAD);远端已有的提交是
  // 新基座,不会被改写——这正是"不动别人历史"的机械保证。
  const rebased = await worktree(["rebase", remoteSha]);
  if (!ok(rebased)) {
    const conflicted = text(await worktree([
      "diff", "--no-ext-diff", "--no-textconv", "--name-only",
      "--diff-filter=U",
    ])).split("\n").filter(Boolean);
    // 先把现场还原再喊人:留一个半 rebase 的工作区,后面每一步都在
    // 说不清的现场上跑。
    await worktree(["rebase", "--abort"]);
    return {
      kind: "blocked",
      ...(conflicted.length ? { conflicts: conflicted } : {}),
      reason: `本任务的提交接不到分支上的外来提交之后(${
        conflicted.length ? `冲突文件:${conflicted.slice(0, 10).join("、")}`
          : brief(rebased)});已还原现场并停止推送,请人工处理冲突。`,
    };
  }
  const after = text(await worktree(["rev-parse", "--verify", "HEAD"]));
  // 接续合同:新 HEAD 必须真的长在远端头之上。不成立就当没做过,如实
  // 停下——绝不带着说不清的历史继续往远端推。
  if (!after || !await isAncestor(worktree, remoteSha, after)) {
    return {
      kind: "blocked",
      reason: "接续外来提交后历史核对失败(新 HEAD 不在远端提交之上);"
        + "已停止推送,请人工确认现场。",
    };
  }
  return {
    kind: "absorbed",
    base_sha: remoteSha,
    previous_head: before,
    head: after,
    count: subjects.length,
    subjects: subjects.slice(0, 10),
  };
}
