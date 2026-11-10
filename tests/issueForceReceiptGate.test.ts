/**
 * 问题流 × force 收据门(ADR-0074 票4)的契约测试:
 * - force=true 覆盖前,远端 tip 必须在本会话推送收据(ledgerPushes 投影,
 *   同仓同分支口径)里;不在即机械拒绝——远端有平台不知道的外部提交,
 *   回执说明原因与放行途径(人工核对后带 override_external=true 重推),
 *   并指向非破坏性路径 sync_branch;
 * - 显式放行参数可完成覆盖,租赁核对保留(门与租赁用同一次探针,门过
 *   后租赁照常锚定探到的 tip);
 * - 远端 tip 在收据集合内(平台自己重试场景)照常覆盖,无需放行;
 * - 推送准备窗口(beforePush)内远端被手推:收据门在推送前最后一刻
 *   的探针上拦下;
 * - 查不到远端状态:宁误拦不误放,机械拒绝,不放行不推送;
 * - 已建 MR 会话维持机械禁 force,显式放行参数也放不了行。
 *
 * 范式与 issueExternalCommitAbsorb.test.ts 同款:直调工具上下文 + 本地
 * 裸仓,只走公开 API 断言回执文本与仓库真实状态(远端 HEAD、账面事件)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
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

function git(args: string[], options: { dir?: string } = {}): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    env: GIT_ENV,
    ...(options.dir ? { cwd: options.dir } : {}),
  }).trim();
}

/** 造一个带初始提交的裸仓远端(推送目标),并在 repo/origin 备好修复
 * 分支克隆(已切分支,无自有提交)。 */
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
 * ——收据是收据门判定的凭据,必须走平台管道产生),返回提交号。 */
async function platformFirstPush(
  root: string, origin: string, clone: string, state: IssueSessionState,
): Promise<string> {
  const sha = commitIn(clone, "fix.txt", "fixed\n",
    `[${TICKET}][fix] 修复登录超时`);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH });
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
  hooks?: {
    credential?: { username: string; password: string; email?: string };
    beforePush?: (repo: { dir: string; url: string }) => Promise<string>;
  },
): {
  execute: (id: string, params: any) => Promise<unknown>;
} {
  const ctx: IssueToolContext = {
    state,
    workspace,
    dataRoot: workspace,
    persist: () => undefined,
    gitCredential: hooks?.credential ? () => hooks.credential! : undefined,
    ...(hooks?.beforePush ? { beforePush: hooks.beforePush } : {}),
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

// ---- 拒绝:远端 tip 是平台没推过的提交 ----

test("force 被收据门拒绝:远端 tip 是用户手推(不在收据内),机械拒绝并说明放行途径", async () => {
  const root = mfcTemp("mfc-issue-forcegate-reject-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  commitIn(clone, "local.txt", "平台的后续修改\n", `[${TICKET}][fix] 继续修改`);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH, force: true });
  assert.equal(outcome.error, true, "覆盖来源不明的远端 tip 应被机械拒绝");
  assert.match(outcome.text, /外部提交/, "回执要说明原因");
  assert.match(outcome.text, /override_external/, "回执要说明放行途径");
  assert.match(outcome.text, /sync_branch/, "回执要指向非破坏性路径");
  assert.equal(remoteBranchSha(origin), userTip, "远端不被改动");
  assert.equal(state.pushes?.length, 1, "不得推送");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("收据门")), "拒绝要留痕(转移账)");
});

// ---- 放行:人工核对后显式参数完成覆盖 ----

test("人工核对后显式放行:override_external=true 完成覆盖,远端被覆盖", async () => {
  const root = mfcTemp("mfc-issue-forcegate-release-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localHead = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  const push = pushTool(state, root);
  const outcome = await pushText(push, {
    branch: BRANCH, force: true, override_external: true,
  });
  assert.equal(outcome.error, false, outcome.text);
  assert.equal(remoteBranchSha(origin), localHead, "放行后覆盖成功");
  assert.notEqual(remoteBranchSha(origin), userTip, "外部提交被人工放行覆盖");
  assert.match(outcome.text, /强制覆盖/);
  assert.equal(state.pushes?.at(-1)?.sha, localHead, "推送账落覆盖后的提交");
});

// ---- 收据集合内:平台自己重试照常 ----

test("远端 tip 在收据集合内:平台自己重试照常覆盖,无需放行参数", async () => {
  const root = mfcTemp("mfc-issue-forcegate-receipt-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  const receiptSha = await platformFirstPush(root, origin, clone, state);
  // 平台本地历史被改写(amend 出姊妹提交)后重试:远端 tip 是自己推过的。
  writeFileSync(join(clone, "fix.txt"), "改写后的修复\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q", "--amend", "-m",
    `[${TICKET}][fix] 修复登录超时(改写)`]);
  const amended = git(["-C", clone, "rev-parse", "HEAD"]);
  assert.notEqual(amended, receiptSha, "夹具就绪:本地与远端历史分叉");
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH, force: true });
  assert.equal(outcome.error, false, outcome.text);
  assert.equal(remoteBranchSha(origin), amended, "自己推过的 tip 照常覆盖");
});

// ---- 推送准备窗口内远端被手推:最后一刻的探针拦下 ----

test("推送准备窗口内远端被手推:收据门在推送前的探针上拦下", async () => {
  const root = mfcTemp("mfc-issue-forcegate-window-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  commitIn(clone, "local.txt", "平台的后续修改\n", `[${TICKET}][fix] 继续修改`);
  const push = pushTool(state, root, {
    beforePush: async () => {
      // 推送链路的准备动作(技能上传等)期间,用户把手改推回远端。
      userPush(root, origin, "user.txt", "窗口期手改\n");
      return "";
    },
  });
  const outcome = await pushText(push, { branch: BRANCH, force: true });
  assert.equal(outcome.error, true, "窗口内出现的外部提交应被拦下");
  assert.match(outcome.text, /外部提交/);
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("收据门")), "拒绝要留痕(转移账)");
  assert.equal(state.pushes?.length, 1, "不得推送");
});

// ---- 查不到远端状态:宁误拦不误放 ----

test("查不到远端状态:force 机械拒绝,不放行不推送", async () => {
  const root = mfcTemp("mfc-issue-forcegate-unreachable-");
  // 远端不是 git 仓:ls-remote 查不到状态。
  const bogus = join(root, "notagit.git");
  mkdirSync(bogus, { recursive: true });
  writeFileSync(join(bogus, "stray.txt"), "not a repo\n");
  // 克隆目录按登记映射(repo/<仓名>)备好真实 git 仓,过脏工作区检查。
  const clone = join(root, "repo", "notagit");
  git(["init", "-q", "-b", BRANCH, clone]);
  writeFileSync(join(clone, "fix.txt"), "fixed\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q", "-m", `[${TICKET}][fix] 修复`]);
  const state = issueState(bogus);
  const push = pushTool(state, root);
  const outcome = await pushText(push, { branch: BRANCH, force: true });
  assert.equal(outcome.error, true, "查不到远端状态应机械拒绝");
  assert.match(outcome.text, /查不到/);
  assert.match(outcome.text, /override_external/, "回执要说明放行途径");
  assert.equal(state.pushes, undefined, "不放行不推送");
});

// ---- 已建 MR 会话:机械禁 force 不被放行参数松动 ----

test("已有 MR 会话维持机械禁 force:override_external 也放不了行", async () => {
  const root = mfcTemp("mfc-issue-forcegate-mrban-");
  const { origin } = seedIssueRepo(root);
  const state = issueState(origin, {
    imported_mr: {
      url: `${origin}/-/merge_requests/1`, iid: "1", title: "登录超时",
      repo: origin, source_branch: BRANCH, target_branch: "master",
      sha: "a".repeat(40), state: "opened",
    },
  });
  const push = pushTool(state, root);
  const outcome = await pushText(push, {
    branch: BRANCH, force: true, override_external: true,
  });
  assert.equal(outcome.error, true, "已建 MR 会话禁止强制覆盖");
  assert.match(outcome.text, /不允许强制覆盖/);
  assert.equal(state.pushes, undefined, "不得推送");
});
