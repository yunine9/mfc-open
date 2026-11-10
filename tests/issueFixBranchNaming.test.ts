/**
 * 修复分支命名契约(ADR-0063,#509):有单会话的修复分支从写死的
 * `master_<工号>_<单号>` 改为 `<基线>_<工号>_<单号>_<yyyymmddhhmmss>`。
 *
 * - 时间戳取首次建分支时刻(宿主本地时间),生成即持久化进会话状态
 *   (state.fix_branch):同会话所有仓、推送、MR 全程同名,绝不重算;
 * - 基线缺席直接报错(人话),不回退 master;
 * - 老会话升级兼容:推送账/MR 账挂着旧格式分支名的在途会话沿用旧名;
 * - 同单重跑 = 新时间戳新分支新 MR,遗留警报机制随旧命名退役——拉仓
 *   回执不再有「遗留警报」,旧分支留在平台由人处置。
 *
 * 范式与 issuePushBranch / issueRemoveRepo 同款:服务层 service.create
 * (剧本模型 + 本地裸仓)与直调工具上下文,只走公开 API 断言真实分支名
 * /门禁收拒/回执文案。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import {
  loadState,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const BASELINE = "br_V100R026C10_release";
const TICKET = "DTS-2026-1009";

/** 造一个带初始提交与基线分支的裸仓远端,文件名即工作区仓名来源。 */
function bareOriginAt(root: string, fileName: string): string {
  mkdirSync(root, { recursive: true });
  const seed = join(root, "seed", fileName.replace(/\.git$/i, ""));
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "branch", BASELINE], { env: GIT_ENV });
  const origin = join(root, fileName);
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

function git(dir: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", dir, ...args],
    { encoding: "utf-8", env: GIT_ENV });
  assert.equal(run.status, 0, `git ${args.join(" ")} 失败: ${run.stderr}`);
  return run.stdout.trim();
}

/** 新命名形态(ADR-0063):基线_工号_单号_14 位本地时间戳。 */
function assertNewShape(branch: string, what: string): void {
  assert.match(branch,
    new RegExp(`^${BASELINE}_dev_${TICKET}_\\d{14}$`), what);
}

/** 拉单 → 收口 → 拉仓的最短剧本前缀(pull_repo 只在拉仓阶段开放)。 */
function pullScenes(...urls: string[]): Scene[] {
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    ...urls.map((url): Scene =>
      ({ tool: { name: "pull_repo", input: { url } } })),
  ];
}

/** events.jsonl 里某工具的全部回执(错误与否、说了什么)。 */
function toolReceipts(dataDir: string, id: string, name: string): Array<{
  is_error?: boolean;
  result?: string;
}> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.kind === "tool_finished"
      && event.payload?.name === name)
    .map((event) => event.payload);
}

// ---- 新格式创建检出:基线前缀 + 时间戳,生成即持久化 ----

test("pull_repo 建出新格式修复分支并持久化:基线_工号_单号_时间戳,检出到位", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-create-");
  const origin = bareOriginAt(dataDir, "origin.git");
  const model = new ScriptedModelServer([
    ...pullScenes(origin),
    { text: "已拉取,分支平台已切好。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrl: origin, baseline: BASELINE,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "拉仓回合收口");
    const state = loadState(join(dataDir, "issues", created.id));
    assert.ok(state?.fix_branch, "生成即持久化:state.fix_branch 必须在场");
    assertNewShape(state.fix_branch, "命名=基线_工号_单号_14位时间戳");
    const clone = join(dataDir, "issues", created.id, "repo", "origin");
    assert.equal(git(clone, "branch", "--show-current"), state.fix_branch,
      "宿主把克隆切到了持久化的修复分支上");
    const receipt = String(toolReceipts(dataDir, created.id, "pull_repo")[0]?.result);
    assert.ok(receipt.includes(state.fix_branch), "拉仓回执报出真实分支名");
    assert.ok(!/遗留/.test(receipt), "新命名下拉仓回执没有遗留警报");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 多仓同名:同会话所有仓全程同一个分支名 ----

test("多仓同名:同一会话先后拉两仓,两克隆切同一持久化分支名", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-multirepo-");
  const alpha = bareOriginAt(dataDir, "alpha.git");
  const beta = bareOriginAt(dataDir, "beta.git");
  const model = new ScriptedModelServer([
    ...pullScenes(alpha, beta),
    { text: "两仓已拉齐。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrls: [alpha, beta], baseline: BASELINE,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "双仓拉取回合收口");
    const state = loadState(join(dataDir, "issues", created.id));
    assert.ok(state?.fix_branch, "分支名持久化在场");
    assertNewShape(state.fix_branch, "新格式");
    for (const name of ["alpha", "beta"]) {
      const clone = join(dataDir, "issues", created.id, "repo", name);
      assert.equal(git(clone, "branch", "--show-current"), state.fix_branch,
        `${name} 与首仓同名(会话级常量,不按仓重算)`);
    }
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 老会话升级兼容:推送账挂着旧格式分支名的沿用旧名 ----

const LEGACY_BRANCH = `master_dev_${TICKET}`;

/** 老会话现场(升级前形态):推送账已记旧格式分支名,盘上克隆也停在
 * 该分支(带一笔真实提交),state 没有 fix_branch。 */
function seedLegacySession(dataDir: string, origin: string): void {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev", created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts",
    ticket: TICKET,
    repo_url: origin, repo_urls: [origin],
    baseline: BASELINE,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "running",
    stage: "mr_green", stage_note: "等待跑绿", stage_at: now,
    pushes: [{ repo: origin, branch: LEGACY_BRANCH,
      sha: "a".repeat(40), at: now }],
  }));
  const clone = join(dataDir, "issues", "issue-1", "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", LEGACY_BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
    "-m", `[${TICKET}][fix] 升级前的修复提交`], { env: GIT_ENV });
}

test("老会话沿用旧名:推送账记着旧格式分支时,推送门禁纯读认旧名,不回写 fix_branch", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-legacy-");
  const origin = bareOriginAt(dataDir, "origin.git");
  seedLegacySession(dataDir, origin);
  const model = new ScriptedModelServer([
    { tool: { name: "push_branch", input: {} } },
    { text: "已推送。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "老会话推送回合收口");
    const state = loadState(join(dataDir, "issues", "issue-1"));
    assert.equal(state?.fix_branch, undefined,
      "推送门禁纯读(ADR-0063 读写分离):沿用账里的旧名做比对,不回写落盘;"
      + "旧名要固化进 fix_branch 只发生在拉仓路");
    assert.equal(service.get("issue-1").pushes?.[0]?.branch, LEGACY_BRANCH,
      "推送账继续记旧名");
    const remoteTip = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${LEGACY_BRANCH}`],
      { encoding: "utf-8" });
    assert.equal(remoteTip.status, 0, "旧名分支真实推上远端");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 基线缺席:人话报错,不回退 master ----

test("基线缺席:有单会话没有基线时拉仓报错点名基线,不建分支不落 fix_branch", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-nobaseline-");
  const origin = bareOriginAt(dataDir, "origin.git");
  const model = new ScriptedModelServer([
    ...pullScenes(origin),
    { text: "拉仓失败,已如实报告用户。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    // 绕过路由直调服务(生产路由保证有基线):缺基线只在测试/内部发生。
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrl: origin,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "失败回合收口");
    const receipt = toolReceipts(dataDir, created.id, "pull_repo")[0];
    assert.equal(receipt?.is_error, true, "拉仓整次失败");
    assert.match(String(receipt?.result), /基线/,
      "人话点名缺的是基线分支");
    const state = loadState(join(dataDir, "issues", created.id));
    assert.equal(state?.fix_branch, undefined, "不落分支名");
    assert.equal(existsClone(join(dataDir, "issues", created.id, "repo", "origin")),
      false, "命名先行:克隆都不该发生,不留默认分支克隆");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

function existsClone(dir: string): boolean {
  return spawnSync("git", ["-C", dir, "rev-parse", "--git-dir"],
    { encoding: "utf-8" }).status === 0;
}

// ---- 推送门禁:只认会话持久化的分支名(直调工具缝) ----

/** 直调现场:真实裸仓远端 + 会话工作区克隆(停在给定分支,带一笔提交)。 */
function seedPushFixture(
  dataDir: string,
  branch: string,
): { origin: string; state: IssueSessionState } {
  const origin = bareOriginAt(dataDir, "origin.git");
  const clone = join(dataDir, "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", branch],
    { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
    "-m", `[${TICKET}][fix] 修复提交`], { env: GIT_ENV });
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-push", account: "dev", created_at: now, updated_at: now,
    title: "推送门禁", description: "", source: "dts", ticket: TICKET,
    repo_url: origin, repo_urls: [origin],
    baseline: BASELINE, fix_branch: branch,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
  };
  return { origin, state };
}

function directPushTool(state: IssueSessionState, dataDir: string): {
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
  const push = tools.find((tool) => tool.name === "push_branch");
  assert.ok(push, "应注册 push_branch");
  return push!;
}

test("推送门禁收拒:分支名不是会话修复分支时拒绝,回执点名会话分支", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-gate-");
  const branch = `${BASELINE}_dev_${TICKET}_20261015090000`;
  const { state } = seedPushFixture(dataDir, branch);
  const { execute } = directPushTool(state, dataDir);
  await assert.rejects(
    execute("x", { branch: LEGACY_BRANCH }),
    (error: Error) => {
      assert.match(error.message, /分支名不符合交付规则/);
      assert.ok(error.message.includes(branch),
        "回执要点名会话真实的修复分支");
      assert.match(error.message, /基线_工号_单号_时间戳|平台生成/,
        "拒绝文案说清新命名从哪来");
      return true;
    },
    "旧格式名不再是合法分支名",
  );
});

test("推送门禁收:会话持久化的分支名推送成功,远端真实到位", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-gateok-");
  const branch = `${BASELINE}_dev_${TICKET}_20261015090100`;
  const { origin, state } = seedPushFixture(dataDir, branch);
  const { execute } = directPushTool(state, dataDir);
  await execute("x", {});
  const record = state.pushes?.[0];
  assert.equal(record?.branch, branch, "推送账记会话分支名");
  const remoteTip = spawnSync("git",
    ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
    { encoding: "utf-8" });
  assert.equal(remoteTip.status, 0, "远端真实到位");
  assert.equal(remoteTip.stdout.trim(), record?.sha);
});

test("remove_repo 门禁纯读:解不出已定名(无 fix_branch 且账里没有)跳过远端探测", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-rmread-");
  // 立即拒连地址:门禁若发起探测必以「远端状态查不到」保守拒。
  // 会话从未拉仓(无 fix_branch、推送/MR 账皆空)不可能推过本会话
  // 分支,远端同名探测无意义——放行即证明探测被跳过。
  const unreachable = "https://127.0.0.1:9/never-pulled.git";
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-rmread", account: "dev", created_at: now, updated_at: now,
    title: "移除纯读", description: "", source: "dts", ticket: TICKET,
    repo_url: unreachable, repo_urls: [unreachable],
    baseline: BASELINE,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
  };
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
  const receipt = await remove!.execute("x", { repo: unreachable }) as {
    content: Array<{ text: string }>;
  };
  assert.match(receipt.content[0].text, /已移除代码仓/,
    "纯读门禁不放探测:从未拉仓的会话直接放行移除");
});

// ---- 遗留警报退役:远端挂着旧运行分支,拉仓回执不再报警 ----

test("遗留警报退役:远端有上次运行的旧分支,新会话拉仓回执干净、各用新名", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-noalarm-");
  const origin = bareOriginAt(dataDir, "origin.git");
  // 上次运行(旧世界)留下的同名遗留分支:旧格式名 + 一笔分叉提交。
  const leftover = join(dataDir, "leftover");
  execFileSync("git", ["clone", "-q", origin, leftover], { env: GIT_ENV });
  execFileSync("git", ["-C", leftover, "checkout", "-q", "-b", LEGACY_BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", leftover, "commit", "-q", "--allow-empty",
    "-m", "上次运行的遗留提交"], { env: GIT_ENV });
  execFileSync("git", ["-C", leftover, "push", "-q", origin, LEGACY_BRANCH],
    { env: GIT_ENV });

  const model = new ScriptedModelServer([
    ...pullScenes(origin),
    { text: "已拉取。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时(重跑)", ticket: TICKET,
      source: "dts", repoUrl: origin, baseline: BASELINE,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "重跑拉仓回合收口");
    const receipt = String(toolReceipts(dataDir, created.id, "pull_repo")[0]?.result);
    assert.ok(!/遗留/.test(receipt), "拉仓回执不再有遗留警报");
    const trail = (service.get(created.id).transitions ?? [])
      .map((item) => item.note).join("\n");
    assert.ok(!/远端同名修复分支遗留/.test(trail), "阶段台账不再记遗留事实");
    const state = loadState(join(dataDir, "issues", created.id));
    assert.ok(state?.fix_branch);
    assertNewShape(state.fix_branch, "重跑会话用自己的时间戳新名");
    assert.notEqual(state.fix_branch, LEGACY_BRANCH,
      "新会话不复用旧世界的自然名");
    const clone = join(dataDir, "issues", created.id, "repo", "origin");
    assert.equal(git(clone, "branch", "--show-current"), state.fix_branch);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 无单会话不建分支 ----

test("无单会话不建分支:拉仓只克隆,不切修复分支,不落 fix_branch", async () => {
  const dataDir = mfcTemp("mfc-fixbranch-noticket-");
  const origin = bareOriginAt(dataDir, "origin.git");
  const model = new ScriptedModelServer([
    { tool: { name: "pull_repo", input: { url: origin } } },
    { text: "已拉取。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [origin],
    }, "tester");
    const created = service.create({
      account: "dev", title: "配置排查", repoUrl: origin,
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "无单拉仓回合收口");
    const state = loadState(join(dataDir, "issues", created.id));
    assert.equal(state?.fix_branch, undefined, "无单不落修复分支名");
    const clone = join(dataDir, "issues", created.id, "repo", "origin");
    assert.equal(git(clone, "branch", "--show-current"), "master",
      "停在克隆缺省分支,没有分支被创建");
    const receipt = String(toolReceipts(dataDir, created.id, "pull_repo")[0]?.result);
    assert.ok(!/修复分支/.test(receipt), "回执不报修复分支");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
