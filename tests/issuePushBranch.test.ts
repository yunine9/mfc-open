/**
 * 问题流 × 分支推送(push_branch,直推)的契约测试:
 * - 推送前过目闸已整体退役(2026-09-17,ADR-0009 增补):全部介入
 *   档位(含三档「优先对齐」)push_branch 都直推——不举卡、不等确认,
 *   推送台账落账、远端真实到位;
 * - push_branch 在途互斥(issue-14 收口)保留:同毫秒并发双调,
 *   一个推送成功、一个收「一次只推一个仓」,不崩溃;
 * - 强制覆盖(同单重跑)与普通推送同权直推:force=true 覆盖远端
 *   遗留分支(租赁式核对在 issueGit 层),转移账留痕;
 * - 存量迁移:盘上挂着退役推送卡的会话,服务启动即剥卡重新入队,
 *   AI 重试 push_branch 直推成功。
 *
 * 范式与 issueInterventionTiers.test.ts / issueFlowService.test.ts 同款:
 * ScriptedModelServer 剧本 + 本地裸仓,只走公开 API 断言。推送用例走
 * 固定流程种子(「提交 MR·跑绿」阶段的续推:交付工具收敛后 push_branch
 * 只在该阶段开放,收口态不牵催办)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS2026082001317";
/** 会话修复分支(ADR-0063):基线_工号_单号_时间戳;夹具用定死的假
 * 时间戳代表"会话已定名",推送机制测试不关心时间戳本身。 */
const BRANCH = `master_dev_${TICKET}_20261015090000`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(推送目标),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function baseOptions(dataDir: string, model: ScriptedModelServer): IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  };
}

/** 推送回归现场:盘上种子一个固定流程会话(「提交 MR·跑绿」阶段的
 * 续推:交付工具收敛后 push_branch 只在该阶段开放,收口态不牵催办)。
 * 可选注入转移账(如 force 收据门要的推送收据)。
 * 必须在构造服务**之前**调用。 */
function seedFixedIssue(
  dataDir: string, repoUrl: string,
  notes?: Array<{ note: string }>,
): { id: string } {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev", created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts",
    ticket: TICKET,
    repo_url: repoUrl, repo_urls: [repoUrl],
    baseline: "master", fix_branch: BRANCH,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "running",
    stage: "mr_green", stage_note: "等待跑绿", stage_at: now,
    ...(notes ? { transitions: notes.map((entry) => ({
      at: now, source: "platform", ...entry,
    })) } : {}),
  }));
  return { id: "issue-1" };
}

/** 落一笔真实改动(修复分支由宿主在 pull_repo 时切好)。 */
const COMMIT = `cd repo/origin && `
  + "printf 'fixed\\n' > fix.txt && git add -A && "
  + "git -c user.name=test -c user.email=t@e commit -q "
  + `-m '[${TICKET}][fix] 修复登录超时'`;

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

/** push_branch 的工具回执(事件账里的是错误还是成功、说了什么)。 */
function pushReceipts(dataDir: string, id: string): Array<{
  is_error?: boolean;
  result?: string;
}> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.kind === "tool_finished"
      && event.payload?.name === "push_branch")
    .map((event) => event.payload);
}

test("全档直推(含三档优先对齐):push_branch 不举卡直接推送成功", async () => {
  for (const [label, tier] of [
    ["一档全自动", "1"], ["二档缺省", undefined], ["三档优先对齐", "3"],
  ] as const) {
    const dataDir = mfcTemp(`mfc-issue-pushdirect-${label}-`);
    const origin = bareOrigin(dataDir);
    const script: Scene[] = [
      { tool: { name: "pull_repo", input: { url: origin } } },
      { tool: { name: "bash", input: { command: COMMIT } } },
      { tool: { name: "push_branch", input: { branch: BRANCH } } },
      { text: "已推送。" },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const created = seedFixedIssue(dataDir, origin);
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      ...(tier ? { interventionTier: () => tier } : {}),
    });
    try {
      const idle = await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.status === "idle" ? issue : undefined;
      }, `直推回合收口(${label})`);
      assert.equal(idle.gate ?? undefined, undefined, `${label}:不该举卡`);
      assert.equal(idle.pushes?.length, 1, `${label}:应直接推送成功`);
      const receipt = pushReceipts(dataDir, created.id)[0];
      assert.equal(receipt.is_error, false, `${label}:push_branch 应成功`);
      const remote = spawnSync("git",
        ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
        { encoding: "utf-8" });
      assert.equal(remote.status, 0, remote.stderr);
      assert.equal(remote.stdout.trim(), idle.pushes![0].sha,
        `${label}:远端真实到位`);
      assert.equal(
        (readStateFile(dataDir, created.id) as unknown as Record<string, unknown>).push_token,
        undefined, `${label}:过目令牌已随退役迁移剥离`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

// ---- issue-14 收口(2026-09-10):在途互斥,并发不崩溃 ----
// 生产事故形态:AI 同毫秒并发调同一消息里的两个 push_branch。过目闸
// 退役后在途互斥是推送唯一的节奏收口:并发第二个直接打回。

/** 双仓直调现场:两个裸仓远端 + 各自克隆(修复分支上各一笔提交)。 */
function seedTwinRepos(dataDir: string): { alpha: string; beta: string } {
  const make = (name: string): string => {
    const seed = join(dataDir, `seed-${name}`);
    execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
    execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
      "-m", "init"], { env: GIT_ENV });
    const origin = join(dataDir, `${name}.git`);
    execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
    const clone = join(dataDir, "repo", name);
    execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
    execFileSync("git", ["-C", clone, "checkout", "-q", "-b", BRANCH],
      { env: GIT_ENV });
    execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
      "-m", `[${TICKET}][fix] ${name}`], { env: GIT_ENV });
    return origin;
  };
  return { alpha: make("alpha"), beta: make("beta") };
}

/** 直调工具上下文 + push_branch(直推,无任何确认回调)。 */
function directPushTools(state: IssueSessionState, dataDir: string): {
  push: { execute: (id: string, params: any) => Promise<unknown> };
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
  const push = tools.find((tool) => tool.name === "push_branch");
  assert.ok(push, "应注册 push_branch");
  return { push: push! };
}

function raceState(alpha: string, beta: string, now: string): IssueSessionState {
  return {
    id: "issue-race", account: "dev", created_at: now, updated_at: now,
    title: "推送竞态", description: "", source: "dts", ticket: TICKET,
    repo_url: alpha, repo_urls: [alpha, beta],
    baseline: "master", fix_branch: BRANCH,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
  };
}

test("issue-14 收口:同毫秒双 push_branch——恰一个推送成功一个在途打回,不崩溃", async () => {
  const dataDir = mfcTemp("mfc-issue-pushrace-");
  const { alpha, beta } = seedTwinRepos(dataDir);
  const state = raceState(alpha, beta, new Date().toISOString());
  const { push } = directPushTools(state, dataDir);
  // 并发双调(生产同毫秒形态):在途互斥串行化——恰一个推送成功,
  // 一个收「一次只推一个仓」;谁都不许崩溃。
  const settled = await Promise.allSettled([
    push.execute("a", { branch: BRANCH, repo: alpha }),
    push.execute("b", { branch: BRANCH, repo: beta }),
  ]);
  const fulfilled = settled.filter((item) => item.status === "fulfilled");
  const reasons = settled.map((item) => item.status === "rejected"
    ? String((item.reason as Error)?.message ?? item.reason) : "");
  assert.equal(fulfilled.length, 1, `恰一个推送成功,实际:${reasons}`);
  assert.equal(reasons.filter((reason) => /一次只推一个仓/.test(reason)).length, 1,
    `恰一个收在途打回:${reasons}`);
  for (const reason of reasons) {
    assert.ok(!/Cannot read properties/.test(reason),
      `并发不得崩溃(实际:${reason})`);
  }
  assert.equal(state.gate ?? undefined, undefined, "直推不举卡");
});

// ---- 强制覆盖(ADR-0063 后的兜底能力):force 与普通推送同权直推 ----

/** 异动现场:远端已有与会话分支同名的分支(与本地历史分叉,普通推送
 * 必被 non-fast-forward 拒)。新命名下正常流程不会撞名,force 保留防
 * 平台侧罕见异动。 */
function seedLeftoverBranch(
  root: string,
  origin: string,
): { dir: string; tip: string } {
  const dir = join(root, "leftover");
  execFileSync("git", ["clone", "-q", origin, dir], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty",
    "-m", `[${TICKET}][fix] 上次运行遗留提交`], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "push", "-q", "origin", BRANCH],
    { env: GIT_ENV });
  const tip = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"],
    { encoding: "utf-8", env: GIT_ENV }).trim();
  return { dir, tip };
}

function remoteBranchSha(origin: string): string {
  return execFileSync("git",
    ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
    { encoding: "utf-8", env: GIT_ENV }).trim();
}

test("强制覆盖直推(三档):force=true 直接覆盖远端同名分支,不举卡", async () => {
  const dataDir = mfcTemp("mfc-issue-pushforce-");
  const origin = bareOrigin(dataDir);
  const leftover = seedLeftoverBranch(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH, force: true } } },
    { text: "已强制覆盖推送。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // force 收据门(ADR-0074):远端 tip 在本会话推送收据内才可覆盖。
  // 种子收据代表"平台先前推过这个 tip"(收据集合内的重试场景)。
  const created = seedFixedIssue(dataDir, origin, [
    { note: `分支已推送 ${origin} ${BRANCH} @ ${leftover.tip.slice(0, 12)}` },
  ]);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "直推覆盖回合收口");
    assert.equal(idle.gate ?? undefined, undefined, "不举卡(直推)");
    assert.equal(idle.pushes?.length, 1);
    assert.notEqual(remoteBranchSha(origin), leftover.tip, "遗留分支被覆盖");
    assert.equal(remoteBranchSha(origin), idle.pushes![0].sha);
    const receipt = pushReceipts(dataDir, created.id)[0];
    assert.equal(receipt.is_error, false);
    assert.match(String(receipt.result), /强制覆盖/);
    assert.ok(readStateFile(dataDir, created.id).transitions?.some((entry) =>
      entry.note.includes("强制覆盖远端同名分支")), "覆盖要留痕(转移账)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 存量迁移(2026-09-17 退役):盘上的推送卡剥卡重入队,直推收口 ----

test("存量迁移:挂着推送过目卡的会话,服务启动即剥卡自动续跑,重试推送直接成功", async () => {
  const dataDir = mfcTemp("mfc-issue-pushmigrate-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "推送完成。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 盘上种子:等人状态 + 退役推送卡 + 死令牌/过目镜像(升级前的形态)。
  const created = seedFixedIssue(dataDir, origin);
  const statePath = join(dataDir, "issues", created.id, "issue.json");
  const seeded = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, any>;
  seeded.status = "waiting_user";
  seeded.gate = {
    id: "gate-legacy", kind: "push_confirm", state_version: 7,
    created_at: new Date().toISOString(),
    context: "变更摘要(相对 master)",
    question: { questions: [{
      question: "推送前过目:以下变更将推送到远端,请过目后确认",
      options: [
        { code: "push", label: "确认推送", suggested: true },
        { code: "hold", label: "暂不推送" },
      ],
      recommended: "push",
    }] },
  };
  seeded.push_token = {
    at: new Date().toISOString(), decision: "确认推送",
  };
  seeded.push_review_head = "a".repeat(40);
  writeFileSync(statePath, JSON.stringify(seeded));
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const pushed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return (issue.pushes?.length ?? 0) > 0 ? issue : undefined;
    }, "迁移后续跑推送成功");
    assert.equal(pushed.gate ?? undefined, undefined, "退役的卡不再等人");
    assert.equal(pushed.pushes![0].branch, BRANCH);
    const migrated = readStateFile(dataDir, created.id);
    assert.equal((migrated as unknown as Record<string, unknown>).push_token, undefined,
      "死令牌随迁移剥离");
    assert.ok(migrated.transitions?.some((entry) =>
      /推送确认卡已退役/.test(entry.note ?? "")), "迁移要留痕(转移账)");
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
      { encoding: "utf-8" });
    assert.equal(remote.stdout.trim(), pushed.pushes![0].sha, "远端真实到位");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
