/**
 * remove_repo(删除仓的 Agent 执行能力与机械门禁,#240)契约测试。
 *
 * 直调范式(issuePushConfirm 的 directPushTools 同款):构造活状态 +
 * createIssueTools 挑出 remove_repo 直接 execute;远端事实用本地裸仓
 * 真件(真推分支、真 ls-remote),不做 stub。
 *
 * 门禁口径(2026-09-11 拍板):单一事实检查——远端同名修复分支在
 * =不可删;网络不可判定=保守拒(宁误拦不误放);模块绑定仓一律拒。
 * 路径逃逸不单列用例:删除目录只取 issueRepoWorkspaces 的映射值
 * (URL 必须在会话清单里,映射值锚死 <工作区>/repo/<仓名>,仓名取
 * 地址末段去 .git 且不含路径分隔符),工具不收任何路径输入;实现里
 * 另有"解析路径严格落在会话工作区内"的双保险断言,逃逸形态在公共
 * 调用面上构造不出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { fixedStages, stageAllowsTool } from "../src/issueFlow/stageRegistry.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS2026091300240";
/** 会话修复分支(ADR-0063):基线_工号_单号_时间戳;夹具用定死的假
 * 时间戳代表"会话已定名",门禁测试不关心时间戳本身。 */
const BRANCH = `master_dev_${TICKET}_20260913120000`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端;文件名(alpha.git)即工作区仓名来源。 */
function bareOriginAt(root: string, fileName: string): string {
  mkdirSync(root, { recursive: true });
  const seed = join(root, "seed", fileName.replace(/\.git$/i, ""));
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, fileName);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

/** 在会话工作区落地克隆(repo/<仓名>/ 平铺,与 pull_repo 同布局)。 */
function cloneWorkspaceRepo(dataDir: string, name: string, origin: string): string {
  const dir = join(dataDir, "repo", name);
  execFileSync("git", ["clone", "-q", origin, dir], { env: GIT_ENV });
  return dir;
}

/** 上次运行遗留形态:把本单同名修复分支真推上远端(删除门禁的拦截对象)。 */
function pushFixBranch(cloneDir: string, origin: string): void {
  execFileSync("git", ["-C", cloneDir, "checkout", "-q", "-b", BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", cloneDir, "commit", "-q", "--allow-empty",
    "-m", "上次运行的修复提交"], { env: GIT_ENV });
  execFileSync("git", ["-C", cloneDir, "push", "-q", origin,
    `HEAD:refs/heads/${BRANCH}`], { env: GIT_ENV });
}

/** 活状态:固定流程 analyze 阶段(remove_repo 注册表全程放行)。
 * 基线与修复分支定名在场(会话已拉过仓的常态形态)。 */
function freshState(dataDir: string, repoUrls: string[]): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-rm", account: "dev", created_at: now, updated_at: now,
    title: "移除仓门禁", description: "", source: "dts", ticket: TICKET,
    repo_url: repoUrls[0], repo_urls: repoUrls,
    baseline: "master", fix_branch: BRANCH,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "idle", stage: "analyze", stage_note: "", stage_at: now,
  };
}

/** 直调现场:createIssueTools 挑出 remove_repo(persist 走空钩子,
 * 状态变更直接在活状态上断言)。 */
function directRemoveTool(state: IssueSessionState, dataDir: string): {
  execute: (id: string, params: any) => Promise<unknown>;
} {
  const ctx: IssueToolContext = {
    state,
    workspace: dataDir,
    dataRoot: dataDir,
    persist: () => undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(40),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const remove = tools.find((tool) => tool.name === "remove_repo");
  assert.ok(remove, "应注册 remove_repo");
  return remove!;
}

test("阶段注册表把 remove_repo 补进每个阶段(与 pull_repo 同一名单,全程可调)", () => {
  for (const scenario of ["ticket", "no_ticket"] as const) {
    for (const stage of fixedStages(scenario)) {
      assert.equal(stageAllowsTool(scenario, stage, "remove_repo"), true,
        `${scenario}/${stage} 应放行 remove_repo(用户指派移除不占阶段)`);
    }
  }
});

test("模块绑定仓拒删:模块带出的仓机械拒绝,未绑定仓不受牵连", async () => {
  const dataDir = mfcTemp("mfc-issue-rm-module-");
  const origins = join(dataDir, "origins");
  const alpha = bareOriginAt(origins, "alpha.git");
  const extra = bareOriginAt(origins, "extra.git");
  const beta = bareOriginAt(origins, "beta.git");
  const alphaDir = cloneWorkspaceRepo(dataDir, "alpha", alpha);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [alpha, extra],
  }, "tester");
  const state = freshState(dataDir, [alpha, extra, beta]);
  state.module_id = "pay-core";
  state.module = "支付核心";
  const remove = directRemoveTool(state, dataDir);
  await assert.rejects(
    () => remove.execute("a", { repo: alpha }),
    (error: Error) => {
      assert.match(error.message, /模块绑定仓不可移除/);
      assert.match(error.message, /支付核心/);
      return true;
    });
  assert.equal(existsSync(alphaDir), true, "被拒的删除不碰工作区");
  assert.deepEqual(state.repo_urls, [alpha, extra, beta], "清单不动");
  assert.equal(state.transitions?.length ?? 0, 0, "被拒不留转移账");
  // 用户另加的仓(beta,不在模块绑定里)不牵连:门禁逐仓判定,可走完。
  await remove.execute("b", { repo: beta });
  assert.deepEqual(state.repo_urls, [alpha, extra]);
  assert.match((state.transitions ?? []).at(-1)!.note, /已移除/);
});

test("远端同名修复分支在=拒:提示先删远端分支,工作区与清单不动", async () => {
  const dataDir = mfcTemp("mfc-issue-rm-branch-");
  const alpha = bareOriginAt(join(dataDir, "origins"), "alpha.git");
  const alphaDir = cloneWorkspaceRepo(dataDir, "alpha", alpha);
  pushFixBranch(alphaDir, alpha);
  const state = freshState(dataDir, [alpha]);
  const remove = directRemoveTool(state, dataDir);
  await assert.rejects(
    () => remove.execute("a", { repo: alpha }),
    (error: Error) => {
      assert.match(error.message, /远端同名修复分支/);
      assert.match(error.message, new RegExp(BRANCH), "拒绝要点名分支名");
      assert.match(error.message, /先在代码平台删除远端分支/);
      return true;
    });
  assert.equal(existsSync(alphaDir), true, "被拒的删除不碰工作区");
  assert.deepEqual(state.repo_urls, [alpha]);
  assert.equal(state.transitions?.length ?? 0, 0, "被拒不留转移账");
});

test("远端分支不在=放行:目录真删、清单摘除、首位接替、转移账与回执留剩余概览", async () => {
  const dataDir = mfcTemp("mfc-issue-rm-ok-");
  const origins = join(dataDir, "origins");
  const alpha = bareOriginAt(origins, "alpha.git");
  const beta = bareOriginAt(origins, "beta.git");
  const alphaDir = cloneWorkspaceRepo(dataDir, "alpha", alpha);

  // 首位仓被删:兼容首位字段接替新首位。
  const first = freshState(dataDir, [alpha, beta]);
  const firstRemove = directRemoveTool(first, dataDir);
  const receipt = await firstRemove.execute("a", { repo: alpha }) as {
    content: Array<{ text: string }>;
  };
  assert.equal(existsSync(alphaDir), false, "工作区目录真没了");
  assert.equal(existsSync(join(dataDir, "repo")), false,
    "repo/ 平铺根空了顺手收走");
  assert.deepEqual(first.repo_urls, [beta], "清单摘除");
  assert.equal(first.repo_url, beta, "首位字段接替新首位");
  const note = (first.transitions ?? []).at(-1)!;
  assert.equal(note.source, "platform");
  assert.match(note.note, /已移除/);
  assert.match(note.note, /用户指派/, "转移账带'用户指派移除'语义");
  assert.match(note.note, /alpha/, "转移账带仓名");
  const text = receipt.content[0].text;
  assert.match(text, /已移除代码仓/);
  assert.match(text, /beta/, "回执带剩余仓清单概览");

  // 非首位仓被删:首位字段不动。
  const mid = freshState(dataDir, [alpha, beta]);
  const midRemove = directRemoveTool(mid, dataDir);
  cloneWorkspaceRepo(dataDir, "beta", beta);
  await midRemove.execute("b", { repo: beta });
  assert.deepEqual(mid.repo_urls, [alpha]);
  assert.equal(mid.repo_url, alpha, "非首位删除不动首位字段");

  // 清单删空:兼容首位字段一并退场(beta 目录已不在,存在容错)。
  const last = freshState(dataDir, [beta]);
  const lastRemove = directRemoveTool(last, dataDir);
  await lastRemove.execute("c", { repo: beta });
  assert.equal(last.repo_urls, undefined, "清单空则删字段");
  assert.equal(last.repo_url, undefined, "首位字段一并退场");
  assert.match((last.transitions ?? []).at(-1)!.note, /清单已空/);
});

test("远端不可判定=保守拒:ls-remote 连不上不得当作'分支不存在'放行", async () => {
  const dataDir = mfcTemp("mfc-issue-rm-net-");
  // 立即拒连的本机地址(discard 端口无监听,连接拒绝即返回,不靠长超时)。
  const unreachable = "https://127.0.0.1:9/x.git";
  const state = freshState(dataDir, [unreachable]);
  const remove = directRemoveTool(state, dataDir);
  await assert.rejects(
    () => remove.execute("a", { repo: unreachable }),
    (error: Error) => {
      assert.match(error.message, /远端状态查不到/);
      assert.match(error.message, /稍后重试/);
      return true;
    });
  assert.deepEqual(state.repo_urls, [unreachable], "保守拒不动清单");
  assert.equal(state.transitions?.length ?? 0, 0, "被拒不留转移账");
});

test("URL 不在会话清单=拒;repo 缺参也打回(删除必须显式指仓)", async () => {
  const dataDir = mfcTemp("mfc-issue-rm-unknown-");
  const alpha = bareOriginAt(join(dataDir, "origins"), "alpha.git");
  const state = freshState(dataDir, [alpha]);
  const remove = directRemoveTool(state, dataDir);
  await assert.rejects(
    () => remove.execute("a", { repo: "https://git.example.com/other.git" }),
    /会话没有登记这个代码仓/);
  await assert.rejects(
    () => remove.execute("b", {}),
    /repo 不能为空/);
  assert.deepEqual(state.repo_urls, [alpha], "未登记地址的删除不动清单");
});
