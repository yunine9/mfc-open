/**
 * DTS 单号→模块绑定与强匹配带出(ADR-0056):
 * - 绑定存储:写读往返/持久化/解绑幂等/last-write-wins 留痕/校验打回
 * - 路由:GET 全量、PUT 单条(绑定与解绑),DTS 发起必带模块(闸 400)
 * - 强匹配带出:特性名 trim 后与模块名完全相等且唯一才随列表带 module_id
 * - 模块识别工具退役:bind_module/lookup_modules 不再注册,锁语义退场
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { loadState, type IssueSessionState } from "../src/issueFlow/state.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import {
  createBusinessModule,
  updateBusinessModule,
} from "../src/businessModuleLibrary.ts";
import { saveProductVersion } from "../src/configurationCenter.ts";
import {
  createIssueTools,
  type IssueToolContext,
} from "../src/issueFlow/tools.ts";
import { FIXED_TICKET_STAGES } from "../src/issueFlow/stageRegistry.ts";
import {
  DtsModuleBindingError,
  readDtsModuleBindings,
  setDtsModuleBinding,
} from "../src/dtsModuleBindings.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(模块绑定的仓),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  return join(root, "origin.git");
}

async function makeModelService(dataDir: string, script: Scene[]): Promise<{
  model: ScriptedModelServer;
  service: IssueFlowService;
}> {
  const model = new ScriptedModelServer(script);
  // modelsJson() 需要 baseUrl:start 之后再构造服务。
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  return { model, service };
}

/** 走一遍真路由(无 HTTP 服务器):GET 版。 */
function issueGet(
  parts: string[],
  service: IssueFlowService,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url: `/${parts.join("/")}` } as any,
      {
        writeHead: (code: number) => { status = code; },
        end: (payload?: string) => {
          try {
            resolve({ status, body: JSON.parse(payload ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" }, ...extra },
    ).catch(reject);
  });
}

/** PUT 版(带 JSON 体)。 */
function issuePut(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "PUT";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" }, ...extra },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

/** POST 版(带 JSON 体)。 */
function issuePost(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" }, ...extra },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("绑定存储:写读往返、持久化、解绑幂等、last-write-wins 留痕", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  createBusinessModule(dataDir, {
    id: "msg-gate", name: "消息网关", description: "消息路由与限流",
    owner: "dev", repositories: [origin],
  }, "tester");

  assert.deepEqual(readDtsModuleBindings(dataDir), {}, "缺席=空映射");

  setDtsModuleBinding(dataDir, "DTS20260901001", "pay-core", "alice");
  const first = readDtsModuleBindings(dataDir);
  assert.equal(first["DTS20260901001"]?.module_id, "pay-core");
  assert.equal(first["DTS20260901001"]?.updated_by, "alice");
  assert.ok(first["DTS20260901001"]?.updated_at);

  // 重新从盘上读(模拟另一个进程/重启):绑定仍在。
  assert.equal(
    readDtsModuleBindings(dataDir)["DTS20260901001"]?.module_id, "pay-core");

  // last-write-wins:bob 改绑覆盖 alice,留痕更新。
  setDtsModuleBinding(dataDir, "DTS20260901001", "msg-gate", "bob");
  const rebound = readDtsModuleBindings(dataDir)["DTS20260901001"];
  assert.equal(rebound?.module_id, "msg-gate");
  assert.equal(rebound?.updated_by, "bob");

  // 解绑幂等:清一次删除,再清一次不报错。
  setDtsModuleBinding(dataDir, "DTS20260901001", null, "bob");
  assert.equal(readDtsModuleBindings(dataDir)["DTS20260901001"], undefined);
  setDtsModuleBinding(dataDir, "DTS20260901001", null, "bob");

  // 单号格式打回(与问题流服务端同一把尺)。
  assert.throws(() => setDtsModuleBinding(dataDir, "坏 单号", "pay-core", "a"),
    DtsModuleBindingError);
  // 缺操作人打回。
  assert.throws(() => setDtsModuleBinding(dataDir, "DTS1", "pay-core", " "),
    DtsModuleBindingError);
  // 模块不存在打回。
  assert.throws(
    () => setDtsModuleBinding(dataDir, "DTS1", "ghost", "a"),
    /不存在或元数据不可读/);
  assert.ok(!existsSync(join(dataDir, "dts-module-bindings.json.tmp")),
    "原子写不留半截临时文件");
});

test("绑定校验:已归档模块打回,不能绑到单号上", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-arch-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "old-mod", name: "退役模块", description: "已归档",
    owner: "dev", repositories: [origin],
  }, "tester");
  updateBusinessModule(dataDir, "old-mod", { status: "archived" },
    "tester");
  assert.throws(
    () => setDtsModuleBinding(dataDir, "DTS1", "old-mod", "a"),
    /已归档/);
  assert.deepEqual(readDtsModuleBindings(dataDir), {},
    "打回不留半截绑定");
});

test("绑定路由:PUT 绑定/解绑、GET 全量;域校验打回 409", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-api-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const put = await issuePut(
      ["issues", "dts-bindings", "DTS20260901002"],
      { module_id: "pay-core" }, service);
    assert.equal(put.status, 200);
    assert.equal(put.body.module_id, "pay-core");

    const list = await issueGet(["issues", "dts-bindings"], service);
    assert.equal(list.status, 200);
    assert.equal(list.body.bindings["DTS20260901002"]?.module_id, "pay-core");

    const clear = await issuePut(
      ["issues", "dts-bindings", "DTS20260901002"], { module_id: "" }, service);
    assert.equal(clear.status, 200);
    assert.equal(clear.body.cleared, true);
    assert.equal(
      (await issueGet(["issues", "dts-bindings"], service))
        .body.bindings["DTS20260901002"], undefined);

    const badTicket = await issuePut(
      ["issues", "dts-bindings", encodeURIComponent("坏 单号")],
      { module_id: "pay-core" }, service);
    assert.equal(badTicket.status, 409);
    assert.match(badTicket.body.error, /格式不合法/);

    const ghost = await issuePut(
      ["issues", "dts-bindings", "DTS20260901003"],
      { module_id: "ghost" }, service);
    assert.equal(ghost.status, 409);
    assert.match(ghost.body.error, /不存在/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("DTS 发起带模块:模块与仓开场即定局,预绑锁语义退役(ADR-0056)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-lock-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  // 分支闸(ADR-0038)需要的版本映射:详情假网关给版本号,配置中心
  // 给包含它的映射行。
  saveProductVersion(dataDir, { version: "V100R025C10", branch: "master" });
  const fakeDts = {
    listByOwner: async () => [],
    detail: async (ticket: string) => ({
      ticket, version: "V100R025C10SPC010B009",
    }),
  };
  // 最小剧本:开场后一句收口,回合自然落地。
  const script: Scene[] = [
    { text: "收到,模块已在发起时定局,直接开始研究。" },
  ];
  const { model, service } = await makeModelService(dataDir, script);
  try {
    const created = await issuePost(["issues"], {
      account: "dev",
      title: "支付对账偶发不平",
      source: "dts",
      ticket: "DTS20260901010",
      module_id: "pay-core",
    }, service, { dts: fakeDts });
    assert.equal(created.status, 201);

    await until(() => {
      const issue = service.get(created.body.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "带模块会话首轮收口");

    const state = loadState(join(dataDir, "issues", created.body.id));
    assert.equal(state?.module_id, "pay-core", "模块落盘");
    assert.equal(state?.module, "支付核心", "模块名由模块库派生");
    assert.deepEqual(state?.repo_urls, [origin], "仓来自模块绑定");
    assert.ok(!("module_locked" in (state ?? {})), "锁标志已退役");

    // 锁定语义不再出现在模型请求里(bind_module 已随识别路退役)。
    const requestText = JSON.stringify(model.requests);
    assert.doesNotMatch(requestText, /bind_module/);
    assert.doesNotMatch(requestText, /预绑并锁定/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("DTS 发起缺模块:闸 400 打回,指路列表列选择(ADR-0056)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-module-gate-"));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const rejected = await issuePost(["issues"], {
      account: "dev",
      title: "t",
      source: "dts",
      ticket: "DTS20260901011",
    }, service);
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.body.error), /未匹配到业务模块/);
    assert.match(String(rejected.body.error), /所属模块/);
  } finally {
    void service.shutdown().catch(() => undefined);
  }
});

test("列表强匹配带出:特性名 trim 后与模块名完全相等且唯一才带 module_id", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-module-match-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  createBusinessModule(dataDir, {
    id: "msg-gate", name: "消息网关", description: "消息路由与限流",
    owner: "dev", repositories: [origin],
  }, "tester");
  // 重名模块:命中歧义,按未匹配处理。
  createBusinessModule(dataDir, {
    id: "dup-a", name: "重复模块", description: "d", owner: "dev",
    repositories: [origin],
  }, "tester");
  // 知识目录按模块名派生,重名模块须显式给独立目录(目录重叠会被拦)。
  createBusinessModule(dataDir, {
    id: "dup-b", name: "重复模块", description: "d", owner: "dev",
    repositories: [origin], knowledge_path: "Function_Knowledge/Access Function/重复模块-b",
  }, "tester");
  const brief = (ticket: string, featureName?: string) => ({
    ticket, title: ticket,
    ...(featureName !== undefined ? { featureName } : {}),
  });
  const fakeDts = {
    listByOwner: async () => [
      brief("DTS-A", " 支付核心 "), // 前后空格 trim 后相等 → 命中
      brief("DTS-B", "不存在的模块"), // 零命中
      brief("DTS-C", "重复模块"),   // 多命中歧义
      brief("DTS-D"),               // 单据无特性名
    ],
    detail: async (ticket: string) => ({ ticket }),
  };
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const listed = await issueGet(["issues", "dts"], service, { dts: fakeDts });
    assert.equal(listed.status, 200);
    const byTicket = new Map<string, string | undefined>(
      (listed.body.tickets as Array<{ ticket: string; module_id?: string }>)
        .map((row) => [row.ticket, row.module_id]));
    assert.equal(byTicket.get("DTS-A"), "pay-core", "trim 相等即命中");
    assert.equal(byTicket.get("DTS-B"), undefined, "零命中不带字段");
    assert.equal(byTicket.get("DTS-C"), undefined, "重名歧义按未匹配");
    assert.equal(byTicket.get("DTS-D"), undefined, "无特性名不带字段");
  } finally {
    void service.shutdown().catch(() => undefined);
  }
});

test("模块识别工具退役:bind_module/lookup_modules 不再注册(ADR-0056)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-tools-retired-"));
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-x", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: "DTS20260901013",
    scenario: "ticket" as const, round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending" as const),
    status: "idle" as const, stage: "prep_repo" as const,
    stage_note: "", stage_at: now,
  };
  const ctx: IssueToolContext = {
    state, workspace: "/tmp/ws", dataRoot: dataDir,
    persist: () => undefined,
    pullRepo: async () => ({ dir: "repo/origin", cloned: true,
      head: "a".repeat(12) }),
  };
  const names = (createIssueTools(ctx) as Array<{ name: string }>)
    .map((tool) => tool.name);
  assert.ok(!names.includes("bind_module"), "bind_module 已退役");
  assert.ok(!names.includes("lookup_modules"), "lookup_modules 已退役");
});