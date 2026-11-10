/**
 * 问题流 × sync_branch 工具(ADR-0074 票 2:Agent 可执行的分支同步入口)
 * 的契约测试:
 * - 远端没动:回执"无需同步",零合并零吸收账,工作区与远端都不动;
 * - 远端前进(本会话推送收据的严格后代):机械合并进工作区,回执带
 *   吸收事实,吸收留痕转移账(范围小结 + 逐笔外部提交)并喂进外部头
 *   观测投影;sync_branch 只同步不推送,远端原地不动;
 * - 合并撞冲突:冲突现场已还原(不留半合并工作区),回执列冲突文件
 *   带"外部提交是用户手改、不许回滚"纪律;Agent 自己完成合并提交后
 *   再同步,回执回到"无需同步"(冲突解决收尾回路);
 * - 非严格后代形态(远端历史被改写/远端被回滚):拒绝喊人并留痕,
 *   不动工作区、不动远端,绝不自动处理;
 * - 并发安全:与 push_branch 在途互斥同口径——推送在途时同步打回,
 *   推送完成后恢复可用(共用同一把互斥,不是各自一把)。
 *
 * 范式与 issueExternalCommitAbsorb.test.ts 同款:直调工具上下文 + 本地
 * 裸仓,只走公开 API 断言回执文本与仓库真实状态(本地/远端 HEAD、账面
 * 事件),不探内部函数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { externalHeadObservations } from "../src/issueFlow/ledgerFacts.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS2026082001317";
/** 会话修复分支(ADR-0063):夹具用定死的假时间戳代表"会话已定名"。 */
const BRANCH = `master_dev_${TICKET}_20261015090000`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_EDITOR: "true",
};

function git(args: string[], options: { dir?: string } = {}): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    env: GIT_ENV,
    ...(options.dir ? { cwd: options.dir } : {}),
  }).trim();
}

/** 造一个带初始提交的裸仓远端,并在 repo/origin 备好修复分支克隆
 * (已切分支)。 */
function seedIssueRepo(root: string): { origin: string; clone: string } {
  const seed = join(root, "seed-repo");
  git(["init", "-q", "-b", "master", seed]);
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(["-C", seed, "add", "-A"]);
  git(["-C", seed, "commit", "-q", "-m", "init"]);
  const origin = join(root, "origin.git");
  git(["clone", "-q", "--bare", seed, origin]);
  const clone = join(root, "repo", "origin");
  git(["clone", "-q", origin, clone]);
  git(["-C", clone, "checkout", "-q", "-b", BRANCH]);
  return { origin, clone };
}

/** 修复分支上落一笔真实改动(平台或用户通用),返回提交号。 */
function commitIn(
  clone: string, file: string, content: string, message: string,
): string {
  writeFileSync(join(clone, file), content);
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q", "-m", message]);
  return git(["-C", clone, "rev-parse", "HEAD"]);
}

interface ToolHooks {
  credential?: { username: string; password: string; email?: string };
  beforePush?: (repo: { dir: string; url: string }) => Promise<string>;
}

/** 直调工具上下文:push_branch 与 sync_branch 从同一工厂出(在途互斥
 * 住在工厂闭包里,并发测试必须共用一份)。 */
function makeTools(state: IssueSessionState, workspace: string,
  hooks: ToolHooks = {},
): { tool(name: string): { execute: (id: string, params: any) => Promise<unknown> } } {
  const ctx: IssueToolContext = {
    state,
    workspace,
    dataRoot: workspace,
    persist: () => undefined,
    gitCredential: hooks.credential ? () => hooks.credential : undefined,
    beforePush: hooks.beforePush,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)?.replace(/\.git$/, "")}`,
      cloned: true, head: "a".repeat(40),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  return {
    tool(name: string) {
      const found = tools.find((entry) => entry.name === name);
      assert.ok(found, `应注册 ${name}`);
      return found!;
    },
  };
}

/** 平台侧第一笔合规提交(经 push_branch 推出,推送收据进转移账——
 * 收据是吸收判定的锚点,必须走平台管道产生),返回提交号。 */
async function platformFirstPush(
  root: string, origin: string, clone: string, state: IssueSessionState,
): Promise<string> {
  const sha = commitIn(clone, "fix.txt", "fixed\n",
    `[${TICKET}][fix] 修复登录超时`);
  const harness = makeTools(state, root);
  const outcome = await callText(harness.tool("push_branch")
    .execute("t", { branch: BRANCH }));
  assert.equal(outcome.error, false, outcome.text);
  return sha;
}

/** 模拟责任人:把手改提交到修复分支并推回远端,返回远端修复分支新头。 */
function userPush(
  root: string, origin: string, file: string, content: string,
): string {
  const work = join(root, `userwork-${file.replace(/\W+/g, "-")}`);
  git(["clone", "-q", "--branch", BRANCH, origin, work]);
  const sha = commitIn(work, file, content, "用户手改");
  git(["-C", work, "push", "-q", "origin", BRANCH]);
  return sha;
}

function remoteBranchSha(origin: string, branch = BRANCH): string {
  return git(["--git-dir", origin, "rev-parse", `refs/heads/${branch}`]);
}

function issueState(origin: string, overrides?: Partial<IssueSessionState>):
  IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-1", account: "dev", created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts", ticket: TICKET,
    repo_url: origin, repo_urls: [origin],
    baseline: "master", fix_branch: BRANCH,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    ...overrides,
  };
}

/** 工具调用回执文本:成功返回 content,失败抛错取 message。接受已启动
 * 的调用 Promise(并发互斥测试要先把推送挂起来)。 */
async function callText(
  call: Promise<unknown>,
): Promise<{ error: boolean; text: string }> {
  try {
    const result = await call as { content?: Array<{ text?: string }> };
    return { error: false, text: result.content?.[0]?.text ?? "" };
  } catch (error) {
    return { error: true, text: String((error as Error)?.message ?? error) };
  }
}

function syncCall(harness: ReturnType<typeof makeTools>, params: any = {}) {
  return callText(harness.tool("sync_branch").execute("t", params));
}

// ---- 回执一:已是最新 ----

test("远端没动:回执无需同步,零合并零吸收账,工作区与远端都不动", async () => {
  const root = mfcTemp("mfc-issue-sync-current-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const headBefore = git(["-C", clone, "rev-parse", "HEAD"]);
  const harness = makeTools(state, root);
  const outcome = await syncCall(harness, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.match(outcome.text, /无需同步/);
  // 零合并:工作区 HEAD 原地,远端原地,没有吸收账。
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteBranchSha(origin), headBefore);
  assert.equal(state.transitions?.filter((entry) =>
    entry.note.includes("外部提交合并")).length, 0, "远端没动不该有吸收账");
});

// ---- 回执二:合并完成(带吸收事实) ----

test("远端前进:合并进工作区,回执带吸收事实,账留痕,不推送远端", async () => {
  const root = mfcTemp("mfc-issue-sync-merged-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  const receiptSha = await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  const harness = makeTools(state, root);
  const outcome = await syncCall(harness, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.match(outcome.text, /并入 1 条外部提交/, "回执要带吸收事实");
  assert.match(outcome.text, /不许回滚/, "回执要带外部提交纪律");
  assert.match(outcome.text, /push_branch/, "回执要点明同步不替代推送");
  // 工作区头是合并提交:双亲 = 平台本地提交 + 用户外部提交,信息合规。
  const parents = git(["-C", clone, "rev-list", "--parents", "-n", "1", "HEAD"])
    .split(" ");
  assert.equal(parents.length, 3, `应为合并提交(双亲),实际:${parents}`);
  assert.deepEqual(parents.slice(1).sort(), [localSha, userTip].sort(),
    "合并提交双亲应是平台提交与用户提交");
  assert.match(git(["-C", clone, "log", "-1", "--format=%s"]),
    new RegExp(`^\\[${TICKET}\\]\\[fix\\] 并入远端外部提交 [0-9a-f]{12}$`));
  // sync_branch 只同步不推送:远端仍停在用户提交,推送账停在首笔收据。
  assert.equal(remoteBranchSha(origin), userTip, "同步不得改动远端");
  assert.equal(state.pushes?.length, 1, "同步不得新增推送账");
  assert.equal(state.pushes![0].sha, receiptSha, "推送账仍是首笔推送");
  // 吸收事实留痕转移账:范围小结(收据 → 外部头)+ 逐笔外部提交。
  const absorbNotes = state.transitions?.filter((entry) =>
    entry.note.includes("外部提交合并")) ?? [];
  assert.ok(absorbNotes.length >= 2, "吸收要留痕(转移账)");
  assert.ok(absorbNotes.some((entry) =>
    entry.note.includes(userTip.slice(0, 12))),
    "被吸收的用户提交要逐笔留痕");
  assert.ok(absorbNotes.some((entry) =>
    entry.note.includes(receiptSha.slice(0, 12))
      && entry.note.includes(userTip.slice(0, 12))),
    "吸收范围(收据 → 外部头)要留痕");
  // 被吸收提交进了外部头观测投影(归属统计据此记平台外)。
  const observed = externalHeadObservations(state.transitions ?? [])
    .map((record) => record.sha);
  assert.ok(observed.includes(userTip.slice(0, 12)),
    `外部头观测投影应含被吸收提交,实际:${observed}`);
});

// ---- 回执三:冲突清单(现场还原) ----

test("同步撞冲突:现场还原、回执列冲突文件;解决提交后再同步回到无需同步", async () => {
  const root = mfcTemp("mfc-issue-sync-conflict-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "fix.txt", "用户也改了 fix.txt\n");
  commitIn(clone, "fix.txt", "平台也改了 fix.txt\n",
    `[${TICKET}][fix] 平台侧改动`);
  const harness = makeTools(state, root);
  const first = await syncCall(harness, { branch: BRANCH });
  assert.equal(first.error, true, "冲突同步应失败收口");
  assert.match(first.text, /冲突/);
  assert.match(first.text, /fix\.txt/, "回执应列冲突文件");
  assert.match(first.text, /不许回滚/, "回执应带外部提交纪律");
  assert.match(first.text, /还原/, "回执应声明现场已还原");
  // 现场还原:无半截合并状态,工作区文件不含冲突标记。
  assert.ok(!existsSync(join(clone, ".git", "MERGE_HEAD")),
    "冲突现场应还原(不留 MERGE_HEAD)");
  const worktreeFile = execFileSync("cat", [join(clone, "fix.txt")],
    { encoding: "utf-8" });
  assert.ok(!worktreeFile.includes("<<<<<<<"), "工作区不应有冲突标记");
  assert.equal(remoteBranchSha(origin), userTip, "同步失败时远端不被改动");
  // Agent 收尾:自己完成与远端外部提交的合并,保留双方改动后提交。
  try {
    git(["-C", clone, "merge", "origin/" + BRANCH]);
    assert.fail("合并应撞冲突");
  } catch { /* 预期的冲突退出 */ }
  writeFileSync(join(clone, "fix.txt"), "双方都保留\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q"]);
  // 再同步:远端头已被本地历史包含,回执回到"无需同步"(收尾确认)。
  const second = await syncCall(harness, { branch: BRANCH });
  assert.equal(second.error, false, second.text);
  assert.match(second.text, /无需同步/);
});

// ---- 连续吸收冲突:回执升级提示人工确认(#589,基线同步同款形态) ----

test("连续 3 次同步撞吸收冲突:回执升级提示人工确认;合并落定即清零", async () => {
  const root = mfcTemp("mfc-issue-sync-escalate-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 计数在首笔推送之后预置:推送成功即清零,先种后推会被首推冲掉。
  state.absorb_conflicts = 2;
  userPush(root, origin, "fix.txt", "用户也改了 fix.txt\n");
  commitIn(clone, "fix.txt", "平台也改了 fix.txt\n",
    `[${TICKET}][fix] 平台侧改动`);
  const harness = makeTools(state, root);
  const outcome = await syncCall(harness, { branch: BRANCH });
  assert.equal(outcome.error, true, "冲突同步应失败收口");
  assert.match(outcome.text, /外部提交持续变动/,
    "连续 3 次后回执追加升级文案");
  assert.match(outcome.text, /连续 3 次/);
  assert.match(outcome.text, /人工确认/, "升级提示建议人工确认合并时机");
  assert.equal(state.absorb_conflicts, 3, "连续冲突计数记 3");
  // Agent 收尾解决冲突:远端头已被本地包含,回执回到无需同步,计数清零。
  try {
    git(["-C", clone, "merge", "origin/" + BRANCH]);
    assert.fail("合并应撞冲突");
  } catch { /* 预期的冲突退出 */ }
  writeFileSync(join(clone, "fix.txt"), "双方都保留\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q"]);
  const settled = await syncCall(harness, { branch: BRANCH });
  assert.equal(settled.error, false, settled.text);
  assert.match(settled.text, /无需同步/);
  assert.equal(state.absorb_conflicts, 0, "合并落定即清零计数");
});

// ---- 回执四:异常喊人(非严格后代形态) ----

test("远端历史被改写:拒绝喊人并留痕,不动工作区、不动远端", async () => {
  const root = mfcTemp("mfc-issue-sync-rewritten-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 用户改写历史:孤儿根提交强推覆盖远端修复分支。
  const work = join(root, "userwork-rewrite");
  git(["clone", "-q", "--branch", BRANCH, origin, work]);
  git(["-C", work, "checkout", "-q", "--orphan", "rewritten"]);
  git(["-C", work, "commit", "-q", "--allow-empty", "-m", "外部改写历史"]);
  git(["-C", work, "push", "-q", "--force", "origin", "rewritten:" + BRANCH]);
  const rewrittenTip = remoteBranchSha(origin);
  const harness = makeTools(state, root);
  const outcome = await syncCall(harness, { branch: BRANCH });
  assert.equal(outcome.error, true, "改写历史应拒绝同步");
  assert.match(outcome.text, /同步被拒绝/);
  assert.match(outcome.text, /疑似被改写/);
  assert.match(outcome.text, /转告用户/, "回执应指路人工核对");
  assert.equal(remoteBranchSha(origin), rewrittenTip, "远端不被改动");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("外部提交检查未通过")), "拒绝要留痕(转移账)");
});

test("远端被回滚:拒绝喊人并留痕,不自动恢复等人确认", async () => {
  const root = mfcTemp("mfc-issue-sync-rollback-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 用户把远端修复分支回滚到上一笔(init)。
  const work = join(root, "userwork-rollback");
  git(["clone", "-q", "--branch", BRANCH, origin, work]);
  git(["-C", work, "reset", "-q", "--hard", "HEAD~1"]);
  git(["-C", work, "push", "-q", "--force", "origin", BRANCH]);
  const rolledTip = remoteBranchSha(origin);
  const harness = makeTools(state, root);
  const outcome = await syncCall(harness, { branch: BRANCH });
  assert.equal(outcome.error, true, "回滚形态应拒绝同步");
  assert.match(outcome.text, /同步被拒绝/);
  assert.match(outcome.text, /疑似被回滚/);
  assert.equal(remoteBranchSha(origin), rolledTip, "远端不被自动恢复");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("外部提交检查未通过")), "拒绝要留痕(转移账)");
});

// ---- 并发安全:与 push_branch 在途互斥同口径 ----

test("push_branch 在途:sync_branch 打回(共用一把互斥);推送完成后恢复可用", async () => {
  const root = mfcTemp("mfc-issue-sync-busy-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  commitIn(clone, "local.txt", "平台的后续修改\n", `[${TICKET}][fix] 继续修改`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let markEntered!: () => void;
  const pushReachedUpload = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  // beforePush 挂起推送(传输前的最后一环),把 push_branch 钉在在途。
  const harness = makeTools(state, root, {
    beforePush: async () => {
      markEntered();
      await held;
      return "";
    },
  });
  const pushCall = harness.tool("push_branch").execute("t", { branch: BRANCH });
  await pushReachedUpload;
  const busy = await syncCall(harness, { branch: BRANCH });
  assert.equal(busy.error, true, "推送在途时同步应被打回");
  assert.match(busy.text, /在途|一次只/, "回执应说明互斥节奏");
  release();
  const pushOutcome = await callText(pushCall);
  assert.equal(pushOutcome.error, false, pushOutcome.text);
  assert.equal(state.pushes?.length, 1, "挂起解除后推送照常完成");
  // 推送收尾即解锁:互斥是"在途"口径,不是一次性熔断。
  const after = await syncCall(harness, { branch: BRANCH });
  assert.equal(after.error, false, after.text);
  assert.match(after.text, /无需同步/, "远端头已是本会话推送,同步无事");
});
