/**
 * 全局知识仓(#286,ADR-0033):配置中心管理员指定的领域知识代码仓,
 * 问题会话开工前置克隆为只读参考件。spec:GitHub issue #286。
 *
 * 设计主轴:知识仓 URL **不进**关联仓台账(repo_urls)——不在册这一
 * 个事实让交付链全部闸(create_mr/push_branch 的 locateRepo、diff 视图
 * 的 materialRepos、修复分支切换)天然拒绝它,零特判;state 上单独记
 * knowledge_repo 装载账,提示词按这笔账决定注入与否。
 *
 * 分块:① 配置存取(本文件上半,直调);② 预拉与只读边界(直驱
 * ensureKnowledgeRepo,本地 bare 假上游);③ 提示词接线(纯函数断言);
 * ④ 前端契约(源码文本钉,先例 issueUiContracts)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  KnowledgeRepoConfigError,
  clearKnowledgeRepoConfig,
  readKnowledgeRepoConfig,
  saveKnowledgeRepoConfig,
} from "../src/knowledgeRepoConfig.ts";
import { mfcTemp } from "./mfcTmp.ts";

// ---- ① 配置存取:单仓单值,与拉仓同一把 URL 尺 ----

test("知识仓配置:未配置返回 undefined,不谎报", () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-absent-");
  assert.equal(readKnowledgeRepoConfig(dataDir), undefined);
  assert.equal(existsSync(join(dataDir, "knowledge-repo.json")), false,
    "读缺席配置不该落文件");
});

test("知识仓配置:保存后读回,HTTPS 与本地路径都收", () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-roundtrip-");
  const saved = saveKnowledgeRepoConfig(dataDir,
    "https://codehub.example.com/team/domain-knowledge.git");
  assert.equal(saved.url,
    "https://codehub.example.com/team/domain-knowledge.git");
  assert.equal(readKnowledgeRepoConfig(dataDir)?.url, saved.url);

  const local = saveKnowledgeRepoConfig(dataDir, join(dataDir, "bare.git"));
  assert.equal(readKnowledgeRepoConfig(dataDir)?.url, local.url,
    "本地路径按拉仓同一把尺 resolve 后存");
});

test("知识仓配置:无效地址打回且不留脏文件", () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-invalid-");
  assert.throws(() => saveKnowledgeRepoConfig(dataDir, "  "),
    KnowledgeRepoConfigError);
  assert.throws(() => saveKnowledgeRepoConfig(dataDir,
    "git@codehub.example.com:team/domain-knowledge.git"),
    KnowledgeRepoConfigError, "ssh 形态与拉仓同尺拒绝");
  assert.equal(readKnowledgeRepoConfig(dataDir), undefined,
    "打回的保存不许留下半截配置");
});

test("知识仓配置:保存覆盖旧值(单仓单值,不是列表)", () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-overwrite-");
  saveKnowledgeRepoConfig(dataDir, "https://example.com/first.git");
  saveKnowledgeRepoConfig(dataDir, "https://example.com/second.git");
  assert.equal(readKnowledgeRepoConfig(dataDir)?.url,
    "https://example.com/second.git");
});

test("知识仓配置:清除回到缺席", () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-clear-");
  saveKnowledgeRepoConfig(dataDir, "https://example.com/k.git");
  clearKnowledgeRepoConfig(dataDir);
  assert.equal(readKnowledgeRepoConfig(dataDir), undefined);
});

test("知识仓配置:损坏配置文件给人话错误,不当静默缺席", () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-corrupt-");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "knowledge-repo.json"), "{oops");
  assert.throws(() => readKnowledgeRepoConfig(dataDir),
    KnowledgeRepoConfigError);
});

// ---- ② 预拉与只读边界(直驱 ensureKnowledgeRepo,本地 bare 假上游) ----

import { IssueFlowService } from "../src/issueFlow/service.ts";
import {
  FIXED_TICKET_STAGES,
  issueRepoWorkspaces,
  saveState,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import { listMaterials } from "../src/issueFlow/materials.ts";
import { HumanGate } from "../src/humanGate.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let seedSeq = 0;

/** 造一个带初始提交的裸仓远端(克隆源);仓名由目录名指定以便撞名用例
 * (origin 放进自增子目录,同仓名可造多个互不覆盖,末段派生仓名不变)。 */
function bareOrigin(root: string, name: string): string {
  const seq = ++seedSeq;
  const seed = join(root, `${name}-seed-${seq}`);
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"],
    { env: GIT_ENV });
  const originDir = join(root, `origin-${seq}`);
  mkdirSync(originDir, { recursive: true });
  const origin = join(originDir, `${name}.git`);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin],
    { env: GIT_ENV });
  return origin;
}

interface LiveHandle {
  id: string;
  root: string;
  state: IssueSessionState;
  humanGate: HumanGate;
}

/** 直驱 LiveIssue(先例:issuePullRepoOwnership 的 handcraftLive):不走
 * 回合/容器/模型,知识仓装载只依赖宿主 git 与配置文件。 */
function handcraftLive(
  service: IssueFlowService,
  root: string,
  repoUrls: string[],
): LiveHandle {
  const state: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "知识仓装载回归", description: "", source: "dts",
    ticket: "DTS-2026-1025",
    ...(repoUrls.length ? { repo_url: repoUrls[0], repo_urls: repoUrls } : {}),
    // 修复分支以基线为前缀(ADR-0063):有单会话拉仓的硬前提。
    baseline: "master",
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
    status: "idle", stage: "prep_repo", stage_note: "",
    stage_at: new Date().toISOString(),
  };
  saveState(root, state);
  const live: LiveHandle = {
    id: "issue-1", root, state,
    humanGate: new HumanGate(join(root, "waiting.json")),
  };
  (service as unknown as { live: Map<string, LiveHandle> })
    .live.set(live.id, live);
  return live;
}

type EnsureKnowledgeRepo = (live: LiveHandle) => Promise<void>;

function ensureKnowledgeRepo(service: IssueFlowService): EnsureKnowledgeRepo {
  return (service as unknown as { ensureKnowledgeRepo: EnsureKnowledgeRepo })
    .ensureKnowledgeRepo.bind(service);
}

function gitConfig(repoDir: string, key: string): string {
  return spawnSync("git", ["-C", repoDir, "config", "--get", key],
    { encoding: "utf-8" }).stdout.trim();
}

function gitBranch(repoDir: string): string {
  return spawnSync("git", ["-c", "safe.directory=*", "-C", repoDir,
    "branch", "--show-current"], { encoding: "utf-8" }).stdout.trim();
}

test("预拉:开工前置克隆到位,记账 ready,不切修复分支,推送加固照做", async () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-prepull-");
  const origin = bareOrigin(dataDir, "domain-knowledge");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    saveKnowledgeRepoConfig(dataDir, origin);
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"), []);
    await ensureKnowledgeRepo(service)(live);
    const repoDir = join(live.root, "repo", "domain-knowledge");
    assert.equal(existsSync(join(repoDir, ".git")), true, "知识仓克隆到位");
    assert.deepEqual(
      { ...live.state.knowledge_repo, at: undefined },
      { url: origin, name: "domain-knowledge", status: "ready", at: undefined },
      "装载账记 url/name/status;仓名派生自地址末段");
    assert.equal(gitBranch(repoDir), "master",
      "知识仓保持自己的默认分支——不切修复分支");
    assert.match(gitConfig(repoDir, "remote.origin.pushurl"), /dev\/null/,
      "推送加固照做:AI 推不动知识仓");
    assert.ok(live.state.transitions?.some((entry) =>
      entry.note.includes("知识仓已装载")), "转移账留痕(现场可查)");
    // 登记仓台账不含知识仓——全部只读闸的根基。
    assert.equal(live.state.repo_urls, undefined,
      "知识仓 URL 不进关联仓台账");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("预拉:未配置不动作,配置损坏等同未配置(fail-open)", async () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-unconfigured-");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"), []);
    await ensureKnowledgeRepo(service)(live);
    assert.equal(live.state.knowledge_repo, undefined,
      "未配置:不记账不克隆");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "knowledge-repo.json"), "{oops");
    await ensureKnowledgeRepo(service)(live);
    assert.equal(live.state.knowledge_repo, undefined,
      "配置损坏按未配置走,不炸会话");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("预拉:克隆失败记 skipped 留痕,不抛错(定位照走)", async () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-failopen-");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    saveKnowledgeRepoConfig(dataDir,
      "https://127.0.0.1:1/no-such-knowledge-repo.git");
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"), []);
    await ensureKnowledgeRepo(service)(live);
    assert.equal(live.state.knowledge_repo?.status, "skipped");
    assert.ok(live.state.knowledge_repo?.note,
      "skipped 必须带原因(现场复盘要知道为什么没知识)");
    assert.ok(live.state.transitions?.some((entry) =>
      entry.note.includes("知识仓未装载")));
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("预拉:会话内定局不追溯——ready 后改配置再调不重拉", async () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-settled-");
  const first = bareOrigin(dataDir, "knowledge-first");
  const second = bareOrigin(dataDir, "knowledge-second");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    saveKnowledgeRepoConfig(dataDir, first);
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"), []);
    await ensureKnowledgeRepo(service)(live);
    assert.equal(live.state.knowledge_repo?.url, first);
    saveKnowledgeRepoConfig(dataDir, second);
    await ensureKnowledgeRepo(service)(live);
    assert.equal(live.state.knowledge_repo?.url, first,
      "开工时点快照,会话中途改配置不影响进行中的会话");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("预拉:仓名与关联仓撞名 → skipped,关联仓目录不被覆盖", async () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-clash-");
  const knowledge = bareOrigin(dataDir, "biz");
  const business = bareOrigin(dataDir, "biz");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    // 关联仓与知识仓派生仓名同为 biz:先手工放一个关联仓目录占位。
    saveKnowledgeRepoConfig(dataDir, knowledge);
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      [business]);
    const businessDir = join(live.root, "repo", "biz");
    mkdirSync(businessDir, { recursive: true });
    writeFileSync(join(businessDir, "mark.txt"), "business\n");
    await ensureKnowledgeRepo(service)(live);
    assert.equal(live.state.knowledge_repo?.status, "skipped");
    assert.match(live.state.knowledge_repo?.note ?? "", /撞名/);
    assert.equal(readFileSync(join(businessDir, "mark.txt"), "utf-8"),
      "business\n", "关联仓目录原样,知识仓不覆盖");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("只读边界:知识仓不在关联仓台账——交付、diff 的口径全部看不到它", async () => {
  const dataDir = mfcTemp("mfc-knowledge-repo-boundary-");
  const knowledge = bareOrigin(dataDir, "domain-knowledge");
  const business = bareOrigin(dataDir, "biz-repo");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    saveKnowledgeRepoConfig(dataDir, knowledge);
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      [business]);
    await ensureKnowledgeRepo(service)(live);
    // 业务仓走真拉仓(有单场景宿主切修复分支),并在工作区造一处变更,
    // 让材料口径有真 diff 可言——排除的不是"没拉到"而是"口径不含"。
    const pullRepoFor = (service as unknown as {
      pullRepoFor: (live: LiveHandle, url: string) => Promise<unknown>;
    }).pullRepoFor.bind(service);
    await pullRepoFor(live, business);
    writeFileSync(join(live.root, "repo", "biz-repo", "README.md"),
      "changed\n");
    assert.equal(existsSync(join(live.root, "repo", "domain-knowledge",
      ".git")), true, "前提:知识仓确实已克隆在场");
    const workspaces = issueRepoWorkspaces(live.state, live.root);
    assert.equal(workspaces.length, 1, "关联仓口径只有登记仓");
    assert.equal(workspaces[0].dir.split(/[\\/]/).at(-1), "biz-repo");
    const materials = listMaterials(live.state, live.root);
    const names = JSON.stringify(materials);
    assert.doesNotMatch(names, /domain-knowledge/,
      "工作区材料(聚合 diff 的仓口径)不见知识仓");
    assert.match(names, /biz-repo/);
    // locateRepo/create_mr 与 push_branch 全部从 issueRepoWorkspaces 取
    // 口径(契约钉见下),知识仓不在册=AI 对它调交付工具会被
    // "会话没有登记这个代码仓"打回——交付链切割不靠特判靠台账事实。
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("契约钉:交付与 diff 口径必须同源于 issueRepoWorkspaces", () => {
  // 防将来有人把知识仓塞进 repo_urls 或给工具另立仓口径——四道闸的
  // "天然性"全押在台账事实上,口径一旦分叉,只读切割就静默失效。
  const tools = readFileSync(resolve("src/issueFlow/tools.ts"), "utf-8");
  assert.match(tools,
    /const locateRepo = \(requested[\s\S]{0,120}issueRepoWorkspaces\(state/,
    "create_mr/push_branch 的仓定位必须走关联仓台账");
  const materialsSource = readFileSync(
    resolve("src/issueFlow/materials.ts"), "utf-8");
  assert.match(materialsSource,
    /function materialRepos\([\s\S]{0,200}issueRepoWorkspaces\(state/,
    "工作区材料口径必须走关联仓台账");
  const stateSource = readFileSync(
    resolve("src/issueFlow/state.ts"), "utf-8");
  assert.match(stateSource, /knowledge_repo\?:/,
    "知识仓装载账住在会话状态上,与关联仓台账分账");
  const serviceSource = readFileSync(
    resolve("src/issueFlow/service.ts"), "utf-8");
  assert.match(serviceSource,
    /await this\.ensureKnowledgeRepo\(live\);\s*\n\s*\/\/ 2026-08-28 拍板/,
    "开工前置时序钉:pump 登记首轮 body 里、开场词组装之前调用——"
      + "「平台拉完才交给 Agent」是 ADR-0033 的拍板语义,调用点被删即红");
});

// ---- ③ 提示词接线:开场指针行、交接提醒、失败不注入 ----

import {
  issueFixedOpeningPrompt,
  fixedAdvanceNotice,
} from "../src/issueFlow/prompt.ts";

function stateWithKnowledge(
  base: Partial<IssueSessionState>,
  knowledge: IssueSessionState["knowledge_repo"],
): IssueSessionState {
  return {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "提示词接线", description: "", source: "manual",
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
    status: "idle", stage: "prep_repo", stage_note: "",
    stage_at: new Date().toISOString(),
    ...base,
    ...(knowledge ? { knowledge_repo: knowledge } : {}),
  } as IssueSessionState;
}

test("开场词:装载成功才注入知识仓指针行,带只读参考声明", () => {
  const ready = issueFixedOpeningPrompt(stateWithKnowledge({}, {
    url: "https://example.com/k.git", name: "domain-knowledge",
    status: "ready", at: new Date().toISOString(),
  }));
  assert.match(ready, /- 知识仓: repo\/domain-knowledge\//);
  assert.match(ready, /只读参考/);
  const skipped = issueFixedOpeningPrompt(stateWithKnowledge({}, {
    url: "https://example.com/k.git", name: "domain-knowledge",
    status: "skipped", note: "克隆失败", at: new Date().toISOString(),
  }));
  assert.doesNotMatch(skipped, /知识仓/,
    "装载失败的会话不给 AI 指一个不存在的路径");
});

test("交接提醒:进分析与修复各提醒一次,检索优先级钉模块名,其他阶段不提醒", () => {
  const knowledge = {
    url: "https://example.com/k.git", name: "domain-knowledge",
    status: "ready" as const, at: new Date().toISOString(),
  };
  const analyze = fixedAdvanceNotice(
    stateWithKnowledge({ stage: "analyze" }, knowledge), "推进");
  assert.match(analyze, /domain-knowledge/);
  assert.match(analyze, /业务模块名/, "拍板:优先按业务模块名检索");
  const fix = fixedAdvanceNotice(
    stateWithKnowledge({ stage: "fix" }, knowledge), "推进");
  assert.match(fix, /domain-knowledge/, "修复阶段再提醒一次");
  const prep = fixedAdvanceNotice(
    stateWithKnowledge({ stage: "prep_repo" }, knowledge), "推进");
  assert.doesNotMatch(prep, /domain-knowledge/,
    "拉仓阶段不重复提醒(开场指针行已带)");
  const skippedAnalyze = fixedAdvanceNotice(
    stateWithKnowledge({ stage: "analyze" }, {
      ...knowledge, status: "skipped" as const, note: "x",
    }), "推进");
  assert.doesNotMatch(skippedAnalyze, /domain-knowledge/,
    "skipped 会话交接同样不提醒");
});

// ---- ④ 前端与接线契约(源码文本钉,先例 issueUiContracts) ----

test("契约钉:配置中心知识仓页签仅管理员、路由仅管理员、App 接线", () => {
  const center = readFileSync(
    resolve("web/src/ConfigurationCenter.tsx"), "utf-8");
  assert.match(center, /admin && tab === "knowledge"/,
    "页签显隐由 admin 决定(拍板:仅管理员显示)");
  assert.match(center, /\.\.\.\(admin \? \[\["knowledge", "知识仓"\]/,
    "知识仓页签必须挂在 admin 条件后面");
  assert.match(center, /function KnowledgeRepoPane\(/,
    "知识仓页签面板在配置中心内实现");
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  assert.match(app,
    /<ConfigurationCenter admin=\{session\.role === "admin"\}/,
    "App 必须把角色传进配置中心");
  const server = readFileSync(resolve("src/server.ts"), "utf-8");
  assert.match(server, /parts\[0\] === "knowledge-repo"/);
  assert.match(server,
    /knowledge-repo"[\s\S]{0,200}仅管理员可维护/,
    "路由有 admin 403 兜闸(直连 API 打不进)");
  const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
  assert.match(api, /knowledgeRepoRequest/);
});

test("契约钉:知识仓提示词文案住资产,锚点与取用处同commit", () => {
  const notices = readFileSync(
    resolve("assets/issue-prompts/notices.md"), "utf-8");
  assert.match(notices, /## advance\.knowledge_remind/,
    "交接提醒文案在 notices 资产(ADR-0016:平台对 AI 说的话住资产)");
  assert.match(notices, /advance\.knowledge_remind[\s\S]{0,400}\{\{name\}\}/,
    "仓名走 {{name}} 插值,由代码按会话事实拼");
  const prompt = readFileSync(resolve("src/issueFlow/prompt.ts"), "utf-8");
  assert.match(prompt, /advance\.knowledge_remind/,
    "取用处锚点与资产锚点同名");
});

// ---- 路由权限(真服务直调,先例 auth.test.ts 的 createTaskServer 形态) ----

import { createServer } from "node:http";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";
import { LocalAuth } from "../src/auth.ts";
import type { AddressInfo } from "node:net";

test("路由:知识仓配置仅管理员——developer 403,admin 读写清三态", async () => {
  const dir = mfcTemp("mfc-knowledge-repo-route-");
  const authFile = join(dir, "auth.json");
  const auth = new LocalAuth(authFile);
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("dev", "dev-password-1", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  const knowledgeUrl = "https://codehub.example.com/team/domain-knowledge.git";
  try {
    const devCookie = await login("dev", "dev-password-1");
    const denied = await fetch(`${base}/knowledge-repo`, {
      method: "PUT", headers: { cookie: devCookie,
        "content-type": "application/json" },
      body: JSON.stringify({ url: knowledgeUrl }),
    });
    assert.equal(denied.status, 403, "developer 写:403");
    assert.equal((await fetch(`${base}/knowledge-repo`,
      { headers: { cookie: devCookie } })).status, 403,
      "developer 读:同样 403(页签仅管理员,API 兜同闸)");

    const adminCookie = await login("admin", "admin-password-1");
    assert.equal((await fetch(`${base}/knowledge-repo`,
      { headers: { cookie: adminCookie } })).status, 200, "admin 读:200");
    const saved = await fetch(`${base}/knowledge-repo`, {
      method: "PUT", headers: { cookie: adminCookie,
        "content-type": "application/json" },
      body: JSON.stringify({ url: knowledgeUrl }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { config: { url: string } };
    assert.deepEqual(savedBody.config, { url: knowledgeUrl });
    const removed = await fetch(`${base}/knowledge-repo`, {
      method: "DELETE", headers: { cookie: adminCookie },
    });
    assert.deepEqual(await removed.json() as { ok: true }, { ok: true });
    const cleared = await (await fetch(`${base}/knowledge-repo`,
      { headers: { cookie: adminCookie } })).json() as { config: unknown };
    assert.equal(cleared.config, null, "清除后读回 null(缺席语义)");
  } finally {
    server.close();
    await service.shutdown().catch(() => undefined);
  }
});
