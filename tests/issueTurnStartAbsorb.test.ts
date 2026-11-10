/**
 * 问题流 × 回合开始的外部提交吸收(ADR-0074 票 3)的契约测试:
 * - 探针经济:该仓没有推送收据(首轮/从未推送)不探——远端就算有外部
 *   提交也不动工作区、零 git 传输;远端头 = 最后一笔收据时零 fetch/merge
 *   (远端跟踪引用不动是"没 fetch"的黑盒证据);
 * - 远端前进(收据的严格后代):开工前机械合并进工作区,通知词带吸收
 *   事实与"外部提交是用户手改、不许回滚"纪律,吸收留痕转移账并喂外部
 *   头观测投影,宿主合并后修属主;
 * - 撞冲突:现场已还原(不留半合并工作区),回合照常开工(入口正常
 *   返回、不抛错),通知词点名冲突文件、带不回滚纪律并指路 sync_branch;
 * - 非严格后代形态(历史被改写):照常开工但通知词声明吸收已暂停喊人,
 *   绝不自动处理,留痕转移账;
 * - 脏工作区:不做机械合并,通知词指路"先收尾再 sync_branch";
 * - 探针失败 fail-open:远端不可达不拦回合,留日志照常开工;
 * - 与 push_branch/sync_branch 共用在途互斥:忙时跳过吸收不阻塞,
 *   互斥是在途口径(解锁后恢复吸收)。
 *
 * 范式与 issueSyncBranch.test.ts 同款:直调宿主入口 + 本地裸仓,只走
 * 公开 API 断言通知词与仓库真实状态(本地/远端 HEAD、远端跟踪引用、
 * 账面事件),不探内部函数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { loadState, saveState } from "../src/issueFlow/state.ts";
import {
  absorbExternalAtTurnStart,
  createBranchTransferMutex,
  type TurnStartAbsorbContext,
} from "../src/issueFlow/turnStartAbsorb.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { externalHeadObservations } from "../src/issueFlow/ledgerFacts.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 轮询到条件成立或超时(issueFlowService.test.ts 同款范式,本地精简)。 */
async function until<T>(
  poll: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = poll();
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(`等待超时: ${what}`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

const TICKET = "DTS2026110600059";
/** 会话修复分支(ADR-0063):夹具用定死的假时间戳代表"会话已定名"。 */
const BRANCH = `master_dev_${TICKET}_20261106090000`;

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
 * (已切分支)。返回 init 提交号(做远端跟踪引用的诱饵值用)。 */
function seedIssueRepo(root: string): { origin: string; clone: string; init: string } {
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
  const init = git(["-C", seed, "rev-parse", "HEAD"]);
  return { origin, clone, init };
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

/** 模拟责任人:把手改提交到修复分支并推回远端,返回远端修复分支新头。
 * branchMissing=true 时远端还没有该分支(平台首推前的抢跑形态),
 * 从默认分支本地建同名分支再推。 */
function userPush(
  root: string, origin: string, file: string, content: string,
  options: { branchMissing?: boolean } = {},
): string {
  const work = join(root, `userwork-${file.replace(/\W+/g, "-")}`);
  git(["clone", "-q", ...(options.branchMissing
    ? [] : ["--branch", BRANCH]), origin, work]);
  if (options.branchMissing) git(["-C", work, "checkout", "-q", "-b", BRANCH]);
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

interface ToolHooks {
  credential?: { username: string; password: string; email?: string };
}

/** 直调工具上下文(只用来走 push_branch 造推送收据)。 */
function makeTools(state: IssueSessionState, workspace: string,
  hooks: ToolHooks = {},
): { tool(name: string): { execute: (id: string, params: any) => Promise<unknown> } } {
  const ctx: IssueToolContext = {
    state,
    workspace,
    dataRoot: workspace,
    persist: () => undefined,
    gitCredential: hooks.credential ? () => hooks.credential : undefined,
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

/** 宿主入口依赖:直调夹具(通知词与仓库真实状态都从这里断言)。 */
interface DepsHooks {
  repairOwnership?: (dir: string) => void;
  branchTransfer?: ReturnType<typeof createBranchTransferMutex>;
}

function makeDeps(
  state: IssueSessionState, workspace: string, hooks: DepsHooks = {},
): TurnStartAbsorbContext {
  const logs: string[] = [];
  const deps: TurnStartAbsorbContext = {
    state,
    workspace,
    dataRoot: workspace,
    persist: () => undefined,
    ...(hooks.repairOwnership ? { repairOwnership: hooks.repairOwnership } : {}),
    branchTransfer: hooks.branchTransfer ?? createBranchTransferMutex(),
    log: (message) => logs.push(message),
  };
  (deps as TurnStartAbsorbContext & { logs(): string[] }).logs = () => logs;
  return deps;
}

function runAbsorb(deps: TurnStartAbsorbContext): Promise<string> {
  return absorbExternalAtTurnStart(deps);
}

/** 把克隆的远端跟踪引用掰到诱饵值(init)。入口若做了 fetch,引用会被
 * 掰回真实远端头——"诱饵还在"就是零 fetch 的黑盒证据。 */
function plantTrackingRefDecoy(clone: string, decoy: string): void {
  git(["-C", clone, "update-ref",
    `refs/remotes/origin/${BRANCH}`, decoy]);
}

function trackingRef(clone: string): string {
  return git(["-C", clone, "rev-parse", `refs/remotes/origin/${BRANCH}`]);
}

// ---- 探针经济:无收据不探(首轮/从未推送的仓) ----

test("无收据不探:远端有外部提交也不动工作区,零通知零账", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-noreceipt-");
  const { origin, clone, init } = seedIssueRepo(root);
  const state = issueState(origin);
  // 用户抢在平台首推前推了提交(无收据形态),本地克隆头还在 init。
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n",
    { branchMissing: true });
  plantTrackingRefDecoy(clone, init);
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.equal(notice, "", "无收据不探:不该有任何通知词");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), init,
    "工作区不动");
  assert.equal(trackingRef(clone), init, "零 fetch:远端跟踪引用不动(诱饵还在)");
  assert.equal(remoteBranchSha(origin), userTip, "远端不动");
  assert.equal(state.transitions?.length ?? 0, 0, "零账面事件");
});

// ---- 探针经济:远端没动零 fetch/merge ----

test("远端没动(头=收据):零 fetch/merge 照常开工,零通知零账", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-current-");
  const { origin, clone, init } = seedIssueRepo(root);
  const state = issueState(origin);
  const receiptSha = await platformFirstPush(root, origin, clone, state);
  const transitionsBefore = state.transitions?.length ?? 0;
  // 跟踪引用掰到诱饵值:若入口 fetch 了,引用会被掰回收据头——诱饵
  // 还在 = 零 fetch 的黑盒证据(AC:远端没动零 fetch/merge)。
  plantTrackingRefDecoy(clone, init);
  const headBefore = git(["-C", clone, "rev-parse", "HEAD"]);
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.equal(notice, "", "远端没动:不该有任何通知词");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), headBefore, "工作区不动");
  assert.equal(trackingRef(clone), init, "零 fetch:诱饵还在");
  assert.equal(state.transitions?.length ?? 0, transitionsBefore,
    "零新增账面事件");
  assert.equal(receiptSha.length, 40, "夹具自检:收据在场");
});

// ---- 远端前进:开工前合并,通知词带吸收事实 ----

test("远端前进:开工前合并进工作区,AI 醒来见最新代码,账留痕并修属主", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-synced-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  const receiptSha = await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  let ownershipRepaired: string | undefined;
  const deps = makeDeps(state, root, {
    repairOwnership: (dir) => { ownershipRepaired = dir; },
  });
  const notice = await runAbsorb(deps);
  assert.match(notice, /并入 1 条外部提交/, "通知词要带吸收事实");
  assert.match(notice, /不许回滚/, "通知词要带外部提交纪律");
  assert.match(notice, new RegExp(userTip.slice(0, 12)), "通知词点名外部头");
  // AI 醒来见最新代码:工作区头是合并提交,双亲 = 平台本地提交 + 用户外部提交。
  const parents = git(["-C", clone, "rev-list", "--parents", "-n", "1", "HEAD"])
    .split(" ");
  assert.equal(parents.length, 3, `应为合并提交(双亲),实际:${parents}`);
  assert.deepEqual(parents.slice(1).sort(), [localSha, userTip].sort());
  assert.match(git(["-C", clone, "log", "-1", "--format=%s"]),
    new RegExp(`^\\[${TICKET}\\]\\[fix\\] 并入远端外部提交 [0-9a-f]{12}$`));
  // 远端原地不动(吸收只进工作区,不推送)。
  assert.equal(remoteBranchSha(origin), userTip);
  // 吸收事实留痕转移账:范围小结 + 逐笔外部提交,喂外部头观测投影。
  const absorbNotes = state.transitions?.filter((entry) =>
    entry.note.includes("外部提交合并")) ?? [];
  assert.ok(absorbNotes.some((entry) =>
    entry.note.includes(receiptSha.slice(0, 12))
      && entry.note.includes(userTip.slice(0, 12))),
    "吸收范围(收据 → 外部头)要留痕");
  const observed = externalHeadObservations(state.transitions ?? [])
    .map((record) => record.sha);
  assert.ok(observed.includes(userTip.slice(0, 12)),
    `外部头观测投影应含被吸收提交,实际:${observed}`);
  // 宿主合并以宿主身份写文件,交回容器前修属主。
  assert.equal(ownershipRepaired, clone);
  // 再跑一次:远端头已被本地包含,回到无事形态(幂等)。
  const second = await runAbsorb(makeDeps(state, root));
  assert.equal(second, "", "吸收完成后再次开工应无事");
});

// ---- 冲突:现场还原,回合照常开工,通知词指路 sync_branch ----

test("开工前撞冲突:现场还原、回合照常开工,通知词点名冲突文件与不回滚纪律", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-conflict-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "fix.txt", "用户也改了 fix.txt\n");
  const localSha = commitIn(clone, "fix.txt", "平台也改了 fix.txt\n",
    `[${TICKET}][fix] 平台侧改动`);
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  // 回合照常开工:入口正常返回通知词,不抛错。
  assert.notEqual(notice, "", "冲突要有通知词");
  assert.match(notice, /冲突/);
  assert.match(notice, /fix\.txt/, "通知词点名冲突文件");
  assert.match(notice, /不许回滚/, "通知词带外部提交纪律");
  assert.match(notice, /sync_branch/, "通知词指路 sync_branch 收尾");
  // 现场已还原:无半截合并状态,工作区停在平台本地提交,无冲突标记。
  assert.ok(!existsSync(join(clone, ".git", "MERGE_HEAD")),
    "冲突现场应还原(不留 MERGE_HEAD)");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localSha,
    "冲突时工作区头不动");
  const worktreeFile = execFileSync("cat", [join(clone, "fix.txt")],
    { encoding: "utf-8" });
  assert.ok(!worktreeFile.includes("<<<<<<<"), "工作区不应有冲突标记");
  assert.equal(remoteBranchSha(origin), userTip, "远端不被改动");
  // 冲突事实留痕转移账(回放"平台为何停手")。
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("冲突") && entry.note.includes("还原")),
    "冲突要留痕(转移账)");
  // Agent 收尾:自己完成合并(保留双方改动)后,再开工即无事。
  try {
    git(["-C", clone, "merge", "origin/" + BRANCH]);
    assert.fail("合并应撞冲突");
  } catch { /* 预期的冲突退出 */ }
  writeFileSync(join(clone, "fix.txt"), "双方都保留\n");
  git(["-C", clone, "add", "-A"]);
  git(["-C", clone, "commit", "-q"]);
  const second = await runAbsorb(makeDeps(state, root));
  assert.equal(second, "", "冲突解决后再次开工应无事");
});

// ---- 连续吸收冲突:通知词升级提示人工确认(#589,基线同步同款形态) ----

test("连续 3 次开工吸收撞冲突:通知词出现升级文案,计数落状态", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-escalate-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 计数在首笔推送之后预置:推送成功即清零,先种后推会被首推冲掉。
  state.absorb_conflicts = 2;
  userPush(root, origin, "fix.txt", "用户也改了 fix.txt\n");
  commitIn(clone, "fix.txt", "平台也改了 fix.txt\n",
    `[${TICKET}][fix] 平台侧改动`);
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.match(notice, /冲突/);
  assert.match(notice, /外部提交持续变动/,
    "连续 3 次后通知词追加升级文案");
  assert.match(notice, /连续 3 次/);
  assert.match(notice, /人工确认/, "升级提示建议人工确认合并时机");
  assert.equal(state.absorb_conflicts, 3, "连续冲突计数记 3");
});

// ---- 非严格后代:照常开工,通知词声明吸收暂停喊人 ----

test("远端历史被改写:照常开工但通知词声明暂停吸收喊人,留痕不动现场", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-rewritten-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  const receiptSha = await platformFirstPush(root, origin, clone, state);
  commitIn(clone, "local.txt", "平台的后续修改\n", `[${TICKET}][fix] 继续修改`);
  const localHead = git(["-C", clone, "rev-parse", "HEAD"]);
  // 用户改写历史:孤儿根提交强推覆盖远端修复分支。
  const work = join(root, "userwork-rewrite");
  git(["clone", "-q", "--branch", BRANCH, origin, work]);
  git(["-C", work, "checkout", "-q", "--orphan", "rewritten"]);
  git(["-C", work, "commit", "-q", "--allow-empty", "-m", "外部改写历史"]);
  git(["-C", work, "push", "-q", "--force", "origin", "rewritten:" + BRANCH]);
  const rewrittenTip = remoteBranchSha(origin);
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.notEqual(notice, "", "改写形态要有通知词");
  assert.match(notice, /疑似被改写/);
  assert.match(notice, /暂停/, "通知词声明吸收已暂停");
  assert.match(notice, /转告用户/, "通知词指路人工核对");
  assert.match(notice, /绝不自动处理|不许回滚/, "通知词带纪律");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localHead,
    "照常开工:工作区不被改动");
  assert.equal(remoteBranchSha(origin), rewrittenTip, "远端不被改动");
  assert.ok(state.transitions?.some((entry) =>
    entry.note.includes("暂停") && entry.note.includes(receiptSha.slice(0, 12))),
    "暂停吸收要留痕(转移账带收据短码)");
});

// ---- 脏工作区:不做机械合并,交 Agent 收尾后自行同步 ----

test("脏工作区:跳过机械合并照常开工,通知词指路先收尾再 sync_branch", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-dirty-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  // 上一回合留下的未提交改动(已跟踪文件)。
  writeFileSync(join(clone, "fix.txt"), "fixed\n但还没提交\n");
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.notEqual(notice, "", "脏工作区要有通知词");
  assert.match(notice, /未提交/, "通知词点出脏工作区事实");
  assert.match(notice, /sync_branch/, "指路先收尾再同步");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localSha,
    "不做机械合并:工作区头不动");
  assert.ok(!existsSync(join(clone, ".git", "MERGE_HEAD")), "无半合并现场");
  assert.equal(remoteBranchSha(origin), userTip, "远端不动");
  assert.equal(state.transitions?.filter((entry) =>
    entry.note.includes("外部提交合并")).length ?? 0, 0, "没有吸收就零吸收账");
});

// ---- merge 失败且无冲突文件:现场还原,回合照常开工 ----

test("合并失败但无冲突文件:现场还原照常开工,通知词给事实不堵路", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-failed-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  // 用户新增了远端文件 user.txt;本地恰好留了一个同名未跟踪过程产物。
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  writeFileSync(join(clone, "user.txt"), "AI 的未跟踪过程产物\n");
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.notEqual(notice, "", "失败形态要有通知词");
  assert.match(notice, /失败/);
  assert.match(notice, /还原/, "通知词声明现场已还原");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localSha,
    "工作区头不动");
  assert.ok(!existsSync(join(clone, ".git", "MERGE_HEAD")), "无半合并现场");
  assert.equal(remoteBranchSha(origin), userTip, "远端不动");
  assert.equal(state.transitions?.filter((entry) =>
    entry.note.includes("外部提交合并")).length ?? 0, 0, "没有吸收就零吸收账");
  // Agent 删掉碍事的过程产物后再开工,吸收照常完成(不堵路)。
  execFileSync("rm", [join(clone, "user.txt")]);
  const second = await runAbsorb(makeDeps(state, root));
  assert.match(second, /并入 1 条外部提交/, "障碍清除后吸收照常完成");
});

// ---- fail-open:探针失败不拦回合 ----

test("探针失败(远端不可达):fail-open 留日志,照常开工不拦回合", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-failopen-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  // 远端下线:裸仓改名模拟网络/凭据类不可达。
  renameSync(origin, `${origin}.down`);
  const deps = makeDeps(state, root);
  const notice = await runAbsorb(deps);
  assert.equal(notice, "", "fail-open:不给 Agent 递通知词(远端状态不可判定)");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localSha,
    "照常开工:工作区不动");
  const logs = (deps as TurnStartAbsorbContext & { logs(): string[] }).logs();
  assert.ok(logs.some((line) => /跳过/.test(line)),
    "探针失败要留日志(运维可见),实际:" + JSON.stringify(logs));
});

// ---- 在途互斥:忙时跳过吸收不阻塞,解锁后恢复 ----

test("分支传输在途:跳过吸收不阻塞回合;解锁后恢复吸收", async () => {
  const root = mfcTemp("mfc-issue-turnabsorb-busy-");
  const { origin, clone } = seedIssueRepo(root);
  const state = issueState(origin);
  await platformFirstPush(root, origin, clone, state);
  const userTip = userPush(root, origin, "user.txt", "用户的手改\n");
  const localSha = commitIn(clone, "local.txt", "平台的后续修改\n",
    `[${TICKET}][fix] 继续修改`);
  const mutex = createBranchTransferMutex();
  mutex.acquire();
  const deps = makeDeps(state, root, { branchTransfer: mutex });
  const notice = await runAbsorb(deps);
  assert.equal(notice, "", "忙时跳过吸收:不阻塞也不递通知词");
  assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localSha,
    "忙时不合并");
  // 互斥是在途口径:解锁后同一把锁恢复吸收(不是一次性熔断)。
  mutex.release();
  const after = await runAbsorb(makeDeps(state, root,
    { branchTransfer: mutex }));
  assert.match(after, /并入 1 条外部提交/, "解锁后恢复吸收");
  const parents = git(["-C", clone, "rev-list", "--parents", "-n", "1", "HEAD"])
    .split(" ");
  assert.equal(parents.length, 3, "恢复吸收:合并提交双亲齐全");
  assert.deepEqual(parents.slice(1).sort(), [localSha, userTip].sort());
});

// ---- 服务接线(端到端):续作回合开工前探针吸收,首轮不开探针 ----
// 直调入口之上的一层:钉住 resumeTurnBody 的接线时机本身——续作回合
// 开工前合并完成、通知词随回合话递给模型;登记首轮(开场词回合体)
// 不接探针,远端动了也不动工作区。

test("服务接线:续作回合开工前合并外部提交,AI 醒来见最新代码与通知词", async () => {
  const dataDir = mfcTemp("mfc-issue-turnabsorb-service-");
  const id = "issue-1";
  const wsRoot = join(dataDir, "issues", id);
  mkdirSync(wsRoot, { recursive: true });
  const { origin, clone } = seedIssueRepo(wsRoot);
  const state = issueState(origin, {
    id, title: "登录超时", created_at: "2026-11-06T00:00:00Z",
    updated_at: "2026-11-06T00:00:00Z",
  });
  // 收据必须走平台管道:直调工具上下文推第一笔(与真会话同一投影)。
  await platformFirstPush(wsRoot, origin, clone, state);
  const userTip = userPush(wsRoot, origin, "user.txt", "用户的手改\n");
  // 续跑形态落盘(status=running,恢复泵重新入队走续作回合体)。
  state.status = "running";
  saveState(wsRoot, state);
  const script: Scene[] = [{ text: "收到,继续推进。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") {
        throw new Error(issue.error ?? "failed");
      }
      return issue.status === "idle" ? issue : undefined;
    }, "续作回合收口");
    // AI 醒来见最新代码:本地无未推提交时快进到外部头(与基线同步的
    // merge 口径同形,允许 fast-forward)。
    const head = git(["-C", clone, "rev-parse", "HEAD"]);
    assert.equal(head, userTip, `开工前应并到外部头,实际:${head.slice(0, 12)}`);
    // 通知词随回合话递给模型(吸收事实 + 不回滚纪律)。
    const prompt = JSON.stringify(model.requests.at(-1));
    assert.ok(prompt.includes("并入 1 条外部提交"),
      "吸收通知词要进模型上下文");
    assert.ok(prompt.includes("不许回滚"), "通知词要带外部提交纪律");
    // 吸收账落盘(范围小结喂外部头观测投影)。
    const reloaded = loadState(wsRoot);
    assert.ok(reloaded?.transitions?.some((entry) =>
      entry.note.includes("外部提交合并")), "吸收要留痕(issue.json)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("服务接线:登记首轮不开探针——远端动了也不动工作区", async () => {
  const dataDir = mfcTemp("mfc-issue-turnabsorb-firstturn-");
  const id = "issue-1";
  const wsRoot = join(dataDir, "issues", id);
  mkdirSync(wsRoot, { recursive: true });
  const { origin, clone, init } = seedIssueRepo(wsRoot);
  const state = issueState(origin, {
    id, title: "登录超时", created_at: "2026-11-06T00:00:00Z",
    updated_at: "2026-11-06T00:00:00Z",
  });
  await platformFirstPush(wsRoot, origin, clone, state);
  const userTip = userPush(wsRoot, origin, "user.txt", "用户的手改\n");
  const localSha = git(["-C", clone, "rev-parse", "HEAD"]);
  // 排队形态落盘(status=queued,泵按登记首轮开跑——开场词回合体,
  // 不接探针;真实首轮连推送收据都没有,这里取更强前提钉接线时机)。
  state.status = "queued";
  saveState(wsRoot, state);
  const script: Scene[] = [{ text: "收到,开始处理。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") {
        throw new Error(issue.error ?? "failed");
      }
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口");
    assert.equal(git(["-C", clone, "rev-parse", "HEAD"]), localSha,
      "首轮不开探针:工作区不动(吸收只发生在续作回合)");
    const prompt = JSON.stringify(model.requests.at(-1));
    assert.doesNotMatch(prompt, /并入 \d+ 条外部提交/,
      "首轮开场词不携带吸收通知词");
    assert.equal(remoteBranchSha(origin), userTip, "远端不动");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
