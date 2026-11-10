/**
 * 问题流 × 修复分支外部提交合并(ADR-0074,推送链路兜底吸收)的契约测试:
 * - push_branch 推送前现查远端修复分支头:是本会话最后一笔推送收据的
 *   严格后代(用户把手改拉到本地推回)即 fetch 后 merge 进工作区再推,
 *   推送成功、远端快进,吸收事实(被吸收提交范围)留痕转移账;
 * - 合并撞冲突:本次推送拒绝,冲突现场还原(不留半合并工作区)、回执
 *   列冲突文件;解决提交后重推成功;
 * - 三类非严格后代形态(远端历史被改写、无收据而远端有提交、远端被
 *   回滚):一律拒绝并留痕,绝不自动处理、绝不 force;
 * - 被吸收提交范围喂进外部头观测投影,归属统计据此记平台外;
 * - 宿主代并提交的身份注入与提交信息格式合规(与基线同步同款,类型
 *   fix);工作区有已跟踪未提交改动不做机械合并。
 *
 * 范式与 issueBaselineSync.test.ts 同款:直调工具上下文 + 本地裸仓,
 * 只走公开 API 断言回执文本与仓库真实状态(远端 HEAD、账面事件)。
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

/** 造一个带初始提交的裸仓远端(推送目标),并在 repo/origin 备好修复
 * 分支克隆(已切分支,留一笔平台自己的合规提交)。 */
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

/** 平台侧第一笔合规提交(经 push_branch 工具推出去,推送收据进转移账
 * ——收据是吸收判定的锚点,必须走平台管道产生),返回提交号。 */
async function platformFirstPush(
  root: string, origin: string, clone: string, state: IssueSessionState,
): Promise<string> {
  const sha = commitIn(clone, "fix.txt", "fixed\n",
    `[${TICKET}][fix] 修复登录超时`);
  const outcome = await pushText(pushTool(state, root), { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  return sha;
}

/** 模拟责任人:把手改提交到修复分支并推回远端(用户工作克隆),返回
 * 远端修复分支新头。 */
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

function pushTool(
  state: IssueSessionState,
  workspace: string,
  credential?: { username: string; password: string; email?: string },
): {
  execute: (id: string, params: any) => Promise<unknown>;
} {
  const ctx: IssueToolContext = {
    state,
    workspace,
    dataRoot: workspace,
    persist: () => undefined,
    gitCredential: credential ? () => credential : undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)?.replace(/\.git$/, "")}`,
      cloned: true, head: "a".repeat(40),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const push = tools.find((tool) => tool.name === "push_branch");
  assert.ok(push, "应注册 push_branch");
  return { execute: push!.execute };
}

/** 工具调用回执文本:成功返回 content,失败抛错取 message。 */
async function pushText(
  push: { execute: (id: string, params: any) => Promise<unknown> },
  params: any,
): Promise<{ error: boolean; text: string }> {
  try {
    const result = await push.execute("t", params) as {
      content?: Array<{ text?: string }>;
    };
    return { error: false, text: result.content?.[0]?.text ?? "" };
  } catch (error) {
    return { error: true, text: String((error as Error)?.message ?? error) };
  }
}

function remoteCommitSubject(origin: string, branch = BRANCH): string {
  return git(["--git-dir", origin, "log", "-1", "--format=%s", branch]);
}

// ---- 收据后代:推送前自动吸收再推 ----

test("远端外部提交(收据后代):push_branch 自动并入再推,远端快进,吸收留痕", async () => {
  const root = mfcTemp("mfc-issue-absorb-merge-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  const receiptSha = await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  // 远端头是合并提交:双亲 = 平台本地提交 + 用户外部提交,信息合规。
  const parents = git(["--git-dir", origin, "rev-list", "--parents",
    "-n", "1", BRANCH]).split(" ");
  assert.equal(parents.length, 3, `应为合并提交(双亲),实际:${parents}`);
  assert.deepEqual(parents.slice(1).sort(), [localSha, userTip].sort(),
    "合并提交双亲应是平台提交与用户提交");
  assert.match(remoteCommitSubject(origin),
    new RegExp(`^\\[${TICKET}\\]\\[fix\\] 并入远端外部提交 [0-9a-f]{12}$`));
  // 推送账落的是合并提交。
  assert.equal(state.pushes?.length, 1);
  assert.equal(state.pushes![0].sha, remoteBranchSha(origin));
  // 吸收事实留痕转移账:范围小结 + 逐笔外部提交。
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
  // 吸收过的用户提交进了外部头观测投影(归属统计据此记平台外)。
  const observed = externalHeadObservations(state.transitions ?? [])
    .map((record) => record.sha);
  assert.ok(observed.includes(userTip.slice(0, 12)),
    `外部头观测投影应含被吸收提交,实际:${observed}`);
});

test("远端外部提交且本地无自有提交:快进吸收,不产生多余合并提交", async () => {
  const root = mfcTemp("mfc-issue-absorb-ff-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  // 本地无自有提交:吸收是纯快进,远端头就是用户的提交,没有合并节点。
  assert.equal(remoteBranchSha(origin), userTip,
    "远端应快进到用户提交本身");
  const parents = git(["--git-dir", origin, "rev-list", "--parents",
    "-n", "1", BRANCH]).split(" ");
  assert.equal(parents.length, 2, "不应产生合并提交");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("外部提交合并")), "吸收仍要留痕(转移账)");
});

// ---- 冲突:推送拒绝、现场还原、解决后重推 ----

test("吸收撞冲突:本次推送拒绝、现场还原、回执列冲突文件;解决提交后重推成功", async () => {
  const root = mfcTemp("mfc-issue-absorb-conflict-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "fix.txt", "用户也改了 fix.txt\n");
  commitIn(clone, "fix.txt", "平台也改了 fix.txt\n",
    `[${TICKET}][fix] 平台侧改动`);
  const push = pushTool(state, root);
  const first = await pushText(push, { branch: BRANCH });
  assert.equal(first.error, true, "冲突推送应被拒绝");
  assert.match(first.text, /冲突/);
  assert.match(first.text, /fix\.txt/, "回执应列冲突文件");
  assert.match(first.text, /不许回滚/, "回执应带外部提交纪律");
  // 现场还原:无半截合并状态,工作区文件不含冲突标记。
  assert.ok(!existsSync(join(clone, ".git", "MERGE_HEAD")),
    "冲突现场应还原(不留 MERGE_HEAD)");
  const worktreeFile = execFileSync("cat", [join(clone, "fix.txt")],
    { encoding: "utf-8" });
  assert.ok(!worktreeFile.includes("<<<<<<<"), "工作区不应有冲突标记");
  assert.equal(remoteBranchSha(origin), userTip, "拒绝时远端不被改动");
  // Agent 解决:本地完成与远端外部提交的合并,保留双方改动后提交。
  try {
    git(["-C", clone, "merge", "origin/" + BRANCH]);
    assert.fail("合并应撞冲突");
  } catch { /* 预期的冲突退出 */ }
  writeFileSync(join(clone, "fix.txt"), "双方都保留\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q"]);
  // 重推:远端头已含在本地历史里,吸收判无事,直接推送成功。
  const second = await pushText(push, { branch: BRANCH });
  assert.equal(second.error, false, second.text);
  assert.equal(remoteBranchSha(origin),
    git(["-C", clone, "rev-parse", "HEAD"]), "重推后远端到位");
});

// ---- 连续吸收冲突:回执升级提示人工确认(#589,基线同步同款形态) ----

test("连续 3 次推送撞吸收冲突:回执升级提示人工确认,与基线同步计数互相独立", async () => {
  const root = mfcTemp("mfc-issue-absorb-escalate-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 计数在首笔推送之后预置:推送成功即清零(与新逻辑同口径),先种
  // 后推会被首推冲掉。
  state.absorb_conflicts = 2;
  state.baseline_sync_conflicts = 5;
  userPush(root, origin, "fix.txt", "用户也改了 fix.txt\n");
  commitIn(clone, "fix.txt", "平台也改了 fix.txt\n",
    `[${TICKET}][fix] 平台侧改动`);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true, "冲突推送应被拒绝");
  assert.match(outcome.text, /外部提交持续变动/,
    "连续 3 次后回执追加升级文案");
  assert.match(outcome.text, /连续 3 次/);
  assert.match(outcome.text, /人工确认/, "升级提示建议人工确认合并时机");
  assert.equal(state.absorb_conflicts, 3, "连续冲突计数记 3");
  assert.equal(state.baseline_sync_conflicts, 5,
    "吸收计数与基线同步计数互相独立");
  // 解决冲突后重推:吸收判无事、推送成功,计数清零(合并落定即清零)。
  try {
    git(["-C", clone, "merge", "origin/" + BRANCH]);
    assert.fail("合并应撞冲突");
  } catch { /* 预期的冲突退出 */ }
  writeFileSync(join(clone, "fix.txt"), "双方都保留\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q"]);
  const settled = await pushText(push, { branch: BRANCH });
  assert.equal(settled.error, false, settled.text);
  assert.equal(state.absorb_conflicts, 0, "推送成功即清零吸收冲突计数");
});

// ---- 三类非严格后代形态:一律拒绝喊人 ----

test("远端历史被改写:拒绝并留痕,不自动处理、不动工作区", async () => {
  const root = mfcTemp("mfc-issue-absorb-rewritten-");
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
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true, "改写历史应拒绝推送");
  assert.match(outcome.text, /推送被拒绝/);
  assert.match(outcome.text, /疑似被改写/);
  assert.equal(remoteBranchSha(origin), rewrittenTip, "远端不被改动");
  assert.equal(state.pushes?.length, 1, "不得推送");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("外部提交检查未通过")), "拒绝要留痕(转移账)");
  assert.ok(!existsSync(join(clone, "user.txt")), "工作区不被合并改动");
});

test("无收据而远端有提交:拒绝并说明原因(不静默吞掉用户提交)", async () => {
  const root = mfcTemp("mfc-issue-absorb-unbacked-");
  const { origin, clone } = seedIssueRepo(root);
  // 用户抢在平台首推前把带提交的修复分支推上远端。
  const work = join(root, "userwork-first");
  git(["clone", "-q", origin, work]);
  git(["-C", work, "checkout", "-q", "-b", BRANCH]);
  const userSha = commitIn(work, "user.txt", "用户抢先提交\n", "用户手改");
  git(["-C", work, "push", "-q", "origin", BRANCH]);
  const state = issueState(origin);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true, "无收据而有远端提交应拒绝");
  assert.match(outcome.text, /从未推送过该分支/);
  assert.equal(remoteBranchSha(origin), userSha, "远端不被改动");
  assert.equal(state.pushes, undefined, "不得推送");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("外部提交检查未通过")), "拒绝要留痕(转移账)");
  assert.ok(!existsSync(join(clone, "user.txt")), "工作区不被合并改动");
});

test("无收据但远端头是本地起点(导入 MR 形态):照常推送不拦", async () => {
  const root = mfcTemp("mfc-issue-absorb-unbacked-ancestor-");
  const { origin, clone } = seedIssueRepo(root);
  // 远端同名分支已存在,但头就是本地分支的起点(如导入 MR 的源分支)。
  git(["-C", clone, "push", "-q", origin, `${BRANCH}:${BRANCH}`]);
  const state = issueState(origin);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.equal(state.pushes?.length, 1, "本地头含远端头时照常推送");
});

test("远端被回滚:拒绝并留痕,不自动恢复等人确认", async () => {
  const root = mfcTemp("mfc-issue-absorb-rollback-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 用户把远端修复分支回滚到上一笔(init)。
  const work = join(root, "userwork-rollback");
  git(["clone", "-q", "--branch", BRANCH, origin, work]);
  git(["-C", work, "reset", "-q", "--hard", "HEAD~1"]);
  git(["-C", work, "push", "-q", "--force", "origin", BRANCH]);
  const rolledTip = remoteBranchSha(origin);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true, "回滚形态应拒绝推送");
  assert.match(outcome.text, /疑似被回滚/);
  assert.equal(remoteBranchSha(origin), rolledTip, "远端不被自动恢复");
  assert.equal(state.pushes?.length, 1, "不得推送");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("外部提交检查未通过")), "拒绝要留痕(转移账)");
});

// ---- 归属账、身份注入、脏工作区 ----

test("宿主代并提交身份注入:合并人以宿主凭据身份落款(与基线同步同款)", async () => {
  const root = mfcTemp("mfc-issue-absorb-identity-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  userPush(root, origin, "user.txt", "用户的手改\n");
  commitIn(clone, "local.txt", "平台的后续修改\n", `[${TICKET}][fix] 后续`);
  const push = pushTool(state, root, {
    username: "dev01", password: "secret", email: "dev01@example.com",
  });
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.equal(git(["--git-dir", origin, "log", "-1", "--format=%cn", BRANCH]),
    "dev01", "合并提交者应是注入的用户名");
  assert.equal(git(["--git-dir", origin, "log", "-1", "--format=%ce", BRANCH]),
    "dev01@example.com", "合并提交者邮箱应是注入的邮箱");
  assert.match(remoteCommitSubject(origin),
    new RegExp(`^\\[${TICKET}\\]\\[fix\\] 并入远端外部提交 [0-9a-f]{12}$`));
});

test("脏工作区(已跟踪未提交改动):不做机械合并,推送熔断拒推并给指引", async () => {
  const root = mfcTemp("mfc-issue-absorb-dirty-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  writeFileSync(join(clone, "base.txt"), "改了没提交\n");
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true, "脏工作区应拒推");
  assert.match(outcome.text, /未提交改动/);
  assert.equal(remoteBranchSha(origin), userTip,
    "脏工作区不得触发机械合并,远端不动");
  assert.equal(state.pushes?.length, 1, "不得推送");
});
