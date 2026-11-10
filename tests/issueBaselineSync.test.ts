/**
 * 问题流 × 推送前基线同步(ADR-0071)的契约测试:
 * - push_branch 前宿主自动取基线分支最新提交,有新提交即合并进修复
 *   分支再推(干净合并直接过,回执与账留痕);
 * - 合并撞冲突:本次推送拒绝,冲突现场(MERGE_HEAD 等)落盘回真实
 *   gitdir,回执列冲突文件交回 Agent;解决 commit 后重推即成功,
 *   连续冲突计数随之清零;
 * - 连续 3 次同步撞冲突,回执升级提示人工确认时机(不硬停);
 * - 取不到基线(基线分支远端缺失等)fail-open 照推留痕;
 * - 已跟踪文件有未提交改动,推送熔断拒推(2026-08-28 空 MR 事故面)。
 *
 * 范式与 issuePushBranch.test.ts 同款:直调工具上下文 + 本地裸仓,
 * 只走公开 API 断言(推送阶段固定在「提交MR·跑绿」)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssuePushRecord, IssueSessionState } from "../src/issueFlow/state.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
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

/** 造一个带初始提交的裸仓远端(推送目标),并在 repo/origin 备好修复
 * 分支克隆(已切分支,留一笔合规提交)。 */
function seedIssueRepo(root: string): { origin: string; clone: string } {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "base.txt"), "base\n");
  execFileSync("git", ["-C", seed, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  const clone = join(root, "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", BRANCH], { env: GIT_ENV });
  return { origin, clone };
}

/** 修复分支上落一笔真实改动。 */
function commitFix(clone: string): string {
  writeFileSync(join(clone, "fix.txt"), "fixed\n");
  execFileSync("git", ["-C", clone, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q",
    "-m", `[${TICKET}][fix] 修复登录超时`], { env: GIT_ENV });
  return execFileSync("git", ["-C", clone, "rev-parse", "HEAD"],
    { encoding: "utf-8", env: GIT_ENV }).trim();
}

/** 远端基线前移(他人推进 master):换一个工作克隆改 master 并推回。 */
function advanceOriginMaster(
  root: string, origin: string, file: string, content: string,
): string {
  const work = join(root, `baselinework-${file.replace(/\W+/g, "-")}`);
  execFileSync("git", ["clone", "-q", "--branch", "master", origin, work],
    { env: GIT_ENV });
  writeFileSync(join(work, file), content);
  execFileSync("git", ["-C", work, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "基线前移"],
    { env: GIT_ENV });
  execFileSync("git", ["-C", work, "push", "-q", "origin", "master"],
    { env: GIT_ENV });
  return execFileSync("git", ["-C", work, "rev-parse", "HEAD"],
    { encoding: "utf-8", env: GIT_ENV }).trim();
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

function pushTool(state: IssueSessionState, workspace: string): {
  execute: (id: string, params: any) => Promise<unknown>;
} {
  const ctx: IssueToolContext = {
    state,
    workspace,
    dataRoot: workspace,
    persist: () => undefined,
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

function remoteBranchSha(origin: string, branch: string): string {
  return execFileSync("git",
    ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
    { encoding: "utf-8", env: GIT_ENV }).trim();
}

function remoteCommitSubject(origin: string, branch: string): string {
  return execFileSync("git",
    ["--git-dir", origin, "log", "-1", "--format=%s", branch],
    { encoding: "utf-8", env: GIT_ENV }).trim();
}

test("基线无新提交:push_branch 照常推送,不产生同步账", async () => {
  const root = mfcTemp("mfc-issue-baselinesync-current-");
  const { origin, clone } = seedIssueRepo(root);
  commitFix(clone);
  const state = issueState(origin);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.equal(state.pushes?.length, 1);
  assert.equal(remoteBranchSha(origin, BRANCH), state.pushes![0].sha);
  assert.equal(state.baseline_syncs, undefined, "基线无新提交不记同步账");
  assert.equal(state.baseline_sync_conflicts, undefined, "无冲突不记计数");
});

test("基线前移无冲突:自动合并进修复分支再推,回执与账留痕", async () => {
  const root = mfcTemp("mfc-issue-baselinesync-merge-");
  const { origin, clone } = seedIssueRepo(root);
  commitFix(clone);
  const newMaster = advanceOriginMaster(root, origin, "master.txt", "新基线\n");
  const state = issueState(origin);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.match(outcome.text, /已并入基线 master 的 1 条新提交/);
  // 远端修复分支头是合并提交:双亲、合规信息。
  const parents = execFileSync("git",
    ["--git-dir", origin, "rev-list", "--parents", "-n", "1", BRANCH],
    { encoding: "utf-8", env: GIT_ENV }).trim().split(" ");
  assert.equal(parents.length, 3, `应为合并提交(双亲),实际:${parents}`);
  assert.match(remoteCommitSubject(origin, BRANCH),
    new RegExp(`^\\[${TICKET}\\]\\[fix\\] 同步基线 master 至 [0-9a-f]{12}$`));
  // 同步账与转移账留痕。
  assert.equal(state.baseline_syncs?.length, 1);
  const record = state.baseline_syncs![0];
  assert.equal(record.baseline, "master");
  assert.equal(record.to, newMaster);
  assert.equal(record.commits, 1);
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("推送前基线同步")), "同步要留痕(转移账)");
});

test("基线前移撞冲突:推送拒绝、冲突现场落盘、解决后重推成功并清零计数", async () => {
  const root = mfcTemp("mfc-issue-baselinesync-conflict-");
  const { origin, clone } = seedIssueRepo(root);
  commitFix(clone); // fix.txt
  advanceOriginMaster(root, origin, "fix.txt", "基线也改了 fix.txt\n");
  const state = issueState(origin);
  const push = pushTool(state, root);
  const first = await pushText(push, { branch: BRANCH });
  assert.equal(first.error, true, "冲突推送应被拒绝");
  assert.match(first.text, /同步基线|冲突/);
  assert.match(first.text, /fix\.txt/, "回执应列冲突文件");
  // 先快照再断言:assert.equal 的断言签名会把 state.pushes 收窄成
  // undefined,污染后面重推成功的成员访问。
  const pushesAfterFirst: IssuePushRecord[] | undefined = state.pushes;
  assert.ok(pushesAfterFirst === undefined, "冲突时不得推送");
  assert.equal(state.baseline_sync_conflicts, 1, "连续冲突计数记 1");
  assert.ok(existsSync(join(clone, ".git", "MERGE_HEAD")),
    "冲突现场应落盘回真实 gitdir(Agent 可 git commit 收口)");
  // Agent 解决冲突:改文件、add、commit(不带 -m,落 MERGE_MSG)。
  writeFileSync(join(clone, "fix.txt"), "双方都保留\n");
  execFileSync("git", ["-C", clone, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q"], { env: GIT_ENV });
  // 重推:基线已在祖先里,不再合并,直接推送成功。
  const second = await pushText(push, { branch: BRANCH });
  assert.equal(second.error, false, second.text);
  assert.equal(state.pushes?.length, 1);
  assert.equal(remoteBranchSha(origin, BRANCH), state.pushes![0].sha);
  assert.equal(state.baseline_sync_conflicts, 0, "推送成功即清零计数");
  assert.equal(state.baseline_syncs, undefined,
    "重推时基线无新提交,不产生同步账");
});

test("连续 3 次同步撞冲突:回执升级提示人工确认时机,不硬停", async () => {
  const root = mfcTemp("mfc-issue-baselinesync-escalate-");
  const { origin, clone } = seedIssueRepo(root);
  commitFix(clone);
  advanceOriginMaster(root, origin, "fix.txt", "基线也改了 fix.txt\n");
  const state = issueState(origin,
    { baseline_sync_conflicts: 2 } as Partial<IssueSessionState>);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true);
  assert.match(outcome.text, /基线持续变动/);
  assert.match(outcome.text, /连续 3 次/);
  assert.equal(state.baseline_sync_conflicts, 3);
});

test("取不到基线:fail-open 照推留痕,不卡交付", async () => {
  const root = mfcTemp("mfc-issue-baselinesync-unavailable-");
  const { origin, clone } = seedIssueRepo(root);
  commitFix(clone);
  const state = issueState(origin, { baseline: "ghost" });
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, false, outcome.text);
  assert.equal(state.pushes?.length, 1, "取不到基线照常推送");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("推送前基线同步跳过")), "fail-open 要留痕(转移账)");
});

test("已跟踪文件有未提交改动:推送熔断拒推(空 MR 事故面)", async () => {
  const root = mfcTemp("mfc-issue-baselinesync-dirty-");
  const { origin, clone } = seedIssueRepo(root);
  commitFix(clone);
  writeFileSync(join(clone, "base.txt"), "改了没提交\n");
  const state = issueState(origin);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
  assert.equal(outcome.error, true, "脏工作区应拒推");
  assert.match(outcome.text, /未提交改动/);
  assert.equal(state.pushes, undefined, "不得推送");
  assert.equal(state.baseline_syncs, undefined, "熔断在同步之前");
});
