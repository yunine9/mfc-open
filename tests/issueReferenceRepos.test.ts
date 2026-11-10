/**
 * 参考仓内核(#422,ADR-0054)契约测试。
 *
 * 拉取身份归类(命中登记表→参考仓台账/未命中与停用→平等仓/用户指派
 * 指派升级为平等仓)走 scripted 全链路(linear 顺演,真 bare 仓真克隆);摘除参考仓
 * 走直调范式(issueRemoveRepo 同款)。参考仓只读的结构保证断言到输入
 * 面:参考仓不进 repo_urls,交付工具的定位映射(issueRepoWorkspaces)
 * 因此天然不含它——推不了交不了不靠提示词自觉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { issueRepoWorkspaces, resolvePullRoute } from "../src/issueFlow/state.ts";
import { issueFixedOpeningPrompt } from "../src/issueFlow/prompt.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import {
  fixedState, GIT_ENV, MODULE_ID, NO_TICKET_ENV, until,
} from "./issueFlowFixed.helpers.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 造一个带标记文件的裸仓远端;文件名即工作区仓名来源,标记文件用于
 * 防覆盖断言(同名仓名的两个仓内容可区分)。 */
function bareOriginAt(root: string, fileName: string, marker: string): string {
  mkdirSync(root, { recursive: true });
  const seed = join(root, "seed-" + fileName.replace(/\.git$/i, ""));
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "marker.txt"), marker);
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init " + marker],
    { env: GIT_ENV });
  const origin = join(root, fileName);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

interface RegistryRow {
  id: string;
  name: string;
  repository: string;
  branch: string;
  path: string;
  languages: string[];
  description: string;
  enabled: boolean;
}

/** 问题流消费的登记表(公共组件仓目录)夹具:数据面与组件知识研究线
 * 同一文件,这里直接落 JSON。 */
function writeRegistry(dataDir: string, rows: RegistryRow[]): void {
  writeFileSync(join(dataDir, "component-repositories.json"),
    JSON.stringify(rows));
}

function registryRow(
  id: string, name: string, repository: string, enabled = true,
): RegistryRow {
  return {
    id, name, repository, branch: "master", path: "",
    languages: ["TypeScript"],
    description: "公共组件源码;排查组件渲染问题时拉取研读", enabled,
  };
}

function readState(dataDir: string, id: string): any {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as any;
}

/** 盘上种子一个 analyze 阶段的固定流程会话(直调范式:必须在构造
 * 服务之前落盘;可带参考仓台账)。 */
function seedRefIssue(dataDir: string, options: {
  id?: string;
  repoUrls: string[];
  publicRepos?: Array<{ url: string; name: string; at: string }>;
}): string {
  const id = options.id ?? "issue-1";
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: "仓清单调整", description: "", source: "dts",
    ticket: "DTS2026092300001",
    repo_url: options.repoUrls[0], repo_urls: options.repoUrls,
    ...(options.publicRepos?.length
      ? { public_repos: options.publicRepos } : {}),
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "pending", "pending"],
    status: "idle",
    stage: "analyze", stage_note: "", stage_at: now,
  }));
  return id;
}

function transitionNotes(state: any): string {
  return (state.transitions ?? []).map((row: any) => row.note ?? "").join("\n");
}

/** 回执断言:剧本模型收到的 tool_result 文本全量拼接。 */
function toolResultTexts(model: ScriptedModelServer): string {
  const texts: string[] = [];
  for (const request of model.requests) {
    for (const message of ((request as any).messages ?? []) as any[]) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "tool_result") {
          texts.push(typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content));
        }
      }
    }
  }
  return texts.join("\n");
}

/** 开场词断言:首个请求的 user 消息全文(开场提示词在第一回合)。 */
function firstUserText(model: ScriptedModelServer): string {
  const first = model.requests[0] as any;
  return (((first?.messages ?? []) as any[])
    .filter((message) => message?.role === "user")
    .map((message) => typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((block: any) =>
        block?.text ?? "").join(" "))
    .join("\n"));
}

interface RefScene {
  dataDir: string;
  model: ScriptedModelServer;
  service: IssueFlowService;
  id: string;
}

/** 起一套「无单登记(模块带仓)+ 剧本顺演」的全链路现场。 */
async function refScene(
  dataDir: string,
  boundOrigin: string,
  script: Scene[],
): Promise<RefScene> {
  const model = new ScriptedModelServer(script, "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const created = service.create({
    account: "dev", title: "列表导出超时", moduleId: MODULE_ID,
    environment: NO_TICKET_ENV,
  });
  return { dataDir, model, service, id: created.id };
}

async function settle(scene: RefScene, what: string): Promise<void> {
  await until(() => {
    const issue = scene.service.get(scene.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "idle" ? issue : undefined;
  }, what);
}

test("拉取命中登记表:入参考仓台账不进登记清单,回执与转移账带只读身份", async () => {
  const dataDir = mfcTemp("mfc-issue-ref-identity-");
  const bound = bareOriginAt(join(dataDir, "origins"), "bound.git", "bound");
  const common = bareOriginAt(join(dataDir, "origins"), "common-ui.git",
    "common-ui");
  const unrelated = "https://components.example/unrelated.git";
  writeRegistry(dataDir, [
    registryRow("comp-1", "公共UI库", common),
    registryRow("comp-2", "无关组件", unrelated),
  ]);
  // 模块订阅 comp-1:开场只注入订阅条目,未订阅的 comp-2 不出现。
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [bound],
    reference_component_repos: ["comp-1"],
  }, "tester");
  const scene = await refScene(dataDir, bound, [
    { tool: { name: "pull_repo", input: { url: bound } } },
    { tool: { name: "pull_repo", input: { url: common } } },
    { tool: { name: "complete_stage", input: { note: "仓已看齐" } } },
    { text: "分析中,已研读公共组件源码。" },
  ]);
  const { service, model } = scene;
  try {
    await settle(scene, "参考仓回合收口");
    const state = readState(dataDir, scene.id);
    assert.deepEqual(state.reference_repos, [{
      id: "comp-1", name: "公共UI库", url: common,
      description: "公共组件源码;排查组件渲染问题时拉取研读",
    }], "发起时刻的订阅快照定格进 state");
    assert.deepEqual(state.public_repos?.map((row: any) => row.url),
      [common], "参考仓台账只记登记表命中的地址");
    assert.equal(state.public_repos?.[0]?.name, "common-ui");
    // wire 口径(#425):public_repos 上投影(页面要渲染参考仓卡),
    // reference_repos 目录快照不上 wire(无消费面,不白送)。
    const summary = scene.service.get(scene.id) as any;
    assert.deepEqual(summary.public_repos?.map((row: any) => row.url),
      [common], "public_repos 上 wire");
    assert.equal("reference_repos" in summary, false,
      "目录快照不上 wire");
    assert.equal("knowledge_repo" in summary, false,
      "未装知识仓不造空壳");
    assert.deepEqual(state.repo_urls, [bound], "登记清单不含参考仓");
    // 结构只读的输入面:交付工具的定位映射不含参考仓目录。
    const dirs = issueRepoWorkspaces(state,
      join(dataDir, "issues", scene.id)).map((repo) => repo.dir);
    assert.ok(dirs.every((dir) => !dir.includes("common-ui")),
      "定位映射不含参考仓——推送/交付在结构上够不着");
    assert.match(toolResultTexts(model), /只读参考件:可研读,不可修改、不可交付/);
    assert.match(transitionNotes(state), /参考仓/);
    const repoRoot = join(dataDir, "issues", scene.id, "repo");
    assert.ok(existsSync(join(repoRoot, "bound", ".git")));
    assert.ok(existsSync(join(repoRoot, "common-ui", ".git")),
      "参考仓照常平铺落地,可研读");
    // 开场注入:订阅条目(名称/描述)在场,未订阅条目缺席;契约区分
    // 绑定仓与参考仓的拉取口径。
    const opening = firstUserText(model);
    assert.match(opening, /## 参考组件仓目录/);
    assert.match(opening, /公共UI库/);
    assert.match(opening, /何时需要读取: 公共组件源码/);
    assert.doesNotMatch(opening, /无关组件/);
    assert.match(opening, /参考组件仓目录里的仓按各自「何时需要读取」描述按需拉/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("无订阅会话开场无目录节;有订阅则注入名称地址与描述", () => {
  const base = fixedState({});
  assert.doesNotMatch(issueFixedOpeningPrompt(base), /## 参考组件仓目录/,
    "无订阅不注入目录节,零污染(契约条文仍在,那不是节)");
  const opening = issueFixedOpeningPrompt({
    ...base,
    reference_repos: [{
      id: "c1", name: "公共UI库",
      url: "https://components.example/common-ui.git",
      description: "排查表格渲染问题时读取",
    }],
  });
  assert.match(opening, /## 参考组件仓目录/);
  assert.match(opening, /公共UI库\(https:\/\/components\.example\/common-ui\.git\)/);
  assert.match(opening, /何时需要读取: 排查表格渲染问题时读取/);
  assert.match(opening, /不需要就不拉/);
});

test("重复拉取幂等不重账;未命中与停用条目照旧入登记清单", async () => {
  const dataDir = mfcTemp("mfc-issue-ref-idempotent-");
  const bound = bareOriginAt(join(dataDir, "origins"), "bound.git", "bound");
  const common = bareOriginAt(join(dataDir, "origins"), "common-ui.git",
    "common-ui");
  const other = bareOriginAt(join(dataDir, "origins"), "other.git", "other");
  const off = bareOriginAt(join(dataDir, "origins"), "off.git", "off");
  writeRegistry(dataDir, [
    registryRow("comp-1", "公共UI库", common),
    registryRow("comp-2", "停用组件", off, false),
  ]);
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [bound],
  }, "tester");
  const scene = await refScene(dataDir, bound, [
    { tool: { name: "pull_repo", input: { url: common } } },
    { tool: { name: "pull_repo", input: { url: other } } },
    { tool: { name: "pull_repo", input: { url: off } } },
    { tool: { name: "pull_repo", input: { url: common } } },
    { tool: { name: "complete_stage", input: { note: "仓已看齐" } } },
    { text: "分析中。" },
  ]);
  const { service, model } = scene;
  try {
    await settle(scene, "幂等回合收口");
    const state = readState(dataDir, scene.id);
    assert.deepEqual(state.public_repos?.map((row: any) => row.url), [common],
      "重复拉取参考仓只在台账记一行");
    assert.deepEqual(state.repo_urls?.sort(), [bound, off, other].sort(),
      "未命中与停用条目照旧平等入列");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("用户指派已拉取的参考仓:端点记指派意图不直改清单,落地为平等仓", async () => {
  const dataDir = mfcTemp("mfc-issue-ref-promote-");
  const bound = bareOriginAt(join(dataDir, "origins"), "bound.git", "bound");
  // 页面指派只收 https(ADR-0023 浏览器手输口径),这里用 https 形态
  // 的地址过端点门;端点不克隆,假地址即可。登记表与台账同地址,
  // 验证"指派压过登记表"的意图留痕。
  const common = "https://components.example/common-ui.git";
  const id = seedRefIssue(dataDir, {
    repoUrls: [bound],
    publicRepos: [{ url: common, name: "common-ui",
      at: new Date().toISOString() }],
  });
  const model = new ScriptedModelServer(
    [{ text: "已收到指派,下一回合落地。" }], "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const summary = service.requestRepoChanges(id,
      { add: [common], remove: [] });
    assert.equal(summary.id, id);
    const state = readState(dataDir, id);
    assert.deepEqual(state.repo_assign_pending, [common],
      "指派意图落 pending,等 Agent pull_repo 消费");
    assert.deepEqual(state.assigned_repos, [common],
      "指派史永久留痕(展示层的用户指派徽标口径)");
    assert.deepEqual(state.repo_urls, [bound], "端点不直改登记清单");
    assert.deepEqual(state.public_repos?.map((row: any) => row.url),
      [common], "端点也不直改参考仓台账——升级由 Agent 执行");
    assert.match(transitionNotes(state), /用户调整会话仓清单/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("身份裁决 resolvePullRoute:指派意图 > 登记表命中 > 平等登记", () => {
  const bound = "https://git.example.com/org/bound.git";
  const common = "https://components.example/common-ui.git";
  const other = "https://git.example.com/org/other.git";
  const state = {
    repo_urls: [bound],
    public_repos: [{ url: common, name: "common-ui", at: "now" }],
    repo_assign_pending: [common],
  };
  assert.equal(resolvePullRoute(state, common, true), "assigned",
    "用户指派压过登记表——升级为平等仓");
  assert.equal(resolvePullRoute({
    repo_urls: [bound],
    public_repos: [{ url: common, name: "common-ui", at: "now" }],
  }, common, true), "reference",
  "无指派意图的登记表命中 → 参考仓");
  assert.equal(resolvePullRoute({
    repo_urls: [common],
  }, common, true), "registered",
  "已在登记清单的地址(绑定/指派)保持平等,登记表不追溯");
  assert.equal(resolvePullRoute({ repo_urls: [] }, other, false),
    "registered", "未命中目录照旧平等登记");
  assert.equal(resolvePullRoute({
    repo_urls: [],
  }, common, true, [common]), "registered",
  "模块绑定仓算已知(extraKnown):发起时显式给仓清单的边缘场景下,"
    + "绑定地址不被登记表卷成参考仓");
  assert.equal(resolvePullRoute({
    repo_urls: [bound],
    public_repos: [{ url: common, name: "common-ui", at: "now" }],
    repo_assign_pending: [other],
  }, other, true), "assigned",
  "pending 按地址归一比对,只消费命中的那条");
});

test("登记仓与参考仓同仓名:目录互不覆盖,参考仓落序号名", async () => {
  const dataDir = mfcTemp("mfc-issue-ref-collision-");
  const bound = bareOriginAt(join(dataDir, "origins"), "shared.git",
    "bound-marker");
  const conflict = bareOriginAt(join(dataDir, "other-origins"), "shared.git",
    "conflict-marker");
  writeRegistry(dataDir, [registryRow("comp-1", "同名组件", conflict)]);
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [bound],
  }, "tester");
  const scene = await refScene(dataDir, bound, [
    { tool: { name: "pull_repo", input: { url: bound } } },
    { tool: { name: "pull_repo", input: { url: conflict } } },
    { tool: { name: "complete_stage", input: { note: "仓已看齐" } } },
    { text: "分析中。" },
  ]);
  const { service, model } = scene;
  try {
    await settle(scene, "同仓名回合收口");
    const state = readState(dataDir, scene.id);
    assert.equal(state.public_repos?.[0]?.name, "shared-2",
      "参考仓撞登记仓名时落序号名");
    const repoRoot = join(dataDir, "issues", scene.id, "repo");
    assert.equal(
      readFileSync(join(repoRoot, "shared", "marker.txt"), "utf-8"),
      "bound-marker", "登记仓目录原样");
    assert.equal(
      readFileSync(join(repoRoot, "shared-2", "marker.txt"), "utf-8"),
      "conflict-marker", "参考仓目录独立");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("remove_repo 摘参考仓:台账行删、目录物理删、修复分支门禁不适用", async () => {
  const dataDir = mfcTemp("mfc-issue-ref-remove-");
  const bound = bareOriginAt(join(dataDir, "origins"), "bound.git", "bound");
  const common = bareOriginAt(join(dataDir, "origins"), "common-ui.git",
    "common-ui");
  const state = fixedState({
    repo_url: bound, repo_urls: [bound],
    public_repos: [{ url: common, name: "common-ui",
      at: new Date().toISOString() }],
  });
  const workspace = dataDir;
  const commonDir = join(workspace, "repo", "common-ui");
  mkdirSync(join(commonDir, ".git"), { recursive: true });
  writeFileSync(join(commonDir, "marker.txt"), "common-ui");
  mkdirSync(join(workspace, "repo", "bound", ".git"), { recursive: true });
  const ctx: IssueToolContext = {
    state,
    workspace,
    dataRoot: dataDir,
    persist: () => undefined,
    pullRepo: async () => ({ dir: "repo/x", cloned: true, head: "a".repeat(40) }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const remove = tools.find((tool) => tool.name === "remove_repo");
  assert.ok(remove, "应注册 remove_repo");
  const receipt = await remove!.execute("tool-1",
    { repo: common }) as { content?: Array<{ text?: string }> };
  const receiptText = (receipt.content ?? []).map((block) =>
    block.text ?? "").join("\n");
  assert.match(receiptText, /参考仓/);
  assert.deepEqual(state.public_repos ?? [], [], "台账行已摘除");
  assert.ok(!existsSync(commonDir), "参考仓目录物理删除");
  assert.ok(existsSync(join(workspace, "repo", "bound")), "登记仓不受牵连");
  assert.match(transitionNotes(state), /参考仓/);
});
