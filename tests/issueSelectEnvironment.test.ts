/**
 * 对话选环境 select_environment 的契约测试(票 #574,spec #571):
 * - 用户在对话中明确给出环境 IP 时,AI 调它从环境管理(团队台账)按
 *   主 IP 精确匹配;唯一命中即直接挂载——服务端解密快照进会话凭据库,
 *   复用既有挂载路径(vault 落盘、覆盖允许、清 env_needed 卡、清拒绝
 *   台账解锢、平台回合通知重试);
 * - 快照语义:台账后续改密不影响已挂载的会话;
 * - 已配环境的会话可覆盖:给新 IP 即换环境,转移账留痕;
 * - 无命中:回执如实说明并引导走环境管理,不猜测、不手造环境;
 * - 密码与环境密码不出现在工具回执、事件账、模型可见请求(定向断言);
 *   (网管口令经 get_issue_meta 明文进上下文是 ADR-0003 的既定例外,
 *   本测试钉的是 select_environment 这条路不携带密码。)
 * - 工具参数只有 ip:环境形态取台账人填值,AI 不传入形态参数;
 * - 终态会话:工具如实拒绝(与 attachEnvironment 的 C-H3 同口径);
 * - 举卡即收口(票 #573 六卡一规则):本回合已举卡时同样机械拦下。
 *
 * 多命中歧义在本台账结构上不可能发生:主 IP 是台账唯一键(创建与更新
 * 都查重),findByIp 至多命中一条——「列出候选让 AI 问用户」没有可发生
 * 的现场,不在测试面内。
 *
 * 范式与 issuePushBranch / issueCardStop 同款:ScriptedModelServer 剧本
 * + IssueFlowService 公开 API + createIssueTools 直调,只测外部行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { EnvironmentRegistry } from "../src/environmentRegistry.ts";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";

/** 台账里的机密值(断言「不进模型可见文本」的靶子,起名刻意独特)。 */
const BACKEND_SECRET = "selenv-backend-secret";
const ROOT_SECRET = "selenv-root-secret";

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

function baseOptions(dataDir: string, model: ScriptedModelServer)
  : IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    interventionTier: () => "3",
  };
}

/** 盘上种子一个固定流程会话(必须在构造服务之前)。patch 覆写状态/
 * 闸等现场差异。缺省形态:analyze 进行中、idle(等续聊触发回合)。 */
function seedIssue(
  dataDir: string,
  patch: Record<string, unknown> = {},
): { id: string } {
  const now = new Date().toISOString();
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev", created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts", ticket: TICKET,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "idle", stage: "analyze", stage_note: "", stage_at: now,
    ...patch,
  }));
  return { id: "issue-1" };
}

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

/** 某工具的全部回执(事件账里的成败与原文)。 */
function receiptsOf(dataDir: string, id: string, tool: string): Array<{
  is_error?: boolean;
  result?: string;
}> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.kind === "tool_finished"
      && event.payload?.name === tool)
    .map((event) => event.payload);
}

/** 造一张挂起中的平台闸(种子现场用,形状对齐 raiseGate 的产物)。 */
function seededGate(kind: string, extra: Record<string, unknown> = {}) {
  return {
    id: `gate-seed-${kind}`, kind, state_version: 1,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "等待用户作答", options: [] }] },
    ...extra,
  };
}

/** 无单登记要用的最小业务模块(spec #15)。 */
function seedModule(dataDir: string): void {
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [`file://${join(dataDir, "seed")}`],
  }, "tester");
}

// ---- 唯一命中挂载:快照解密进 vault、元信息可查、密码不进模型可见文本 ----

test("唯一命中直接挂载:服务端解密快照进 vault,元信息可查;台账改密不影响本会话;密码不进回执/事件账/模型请求", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-hit-");
  const registry = new EnvironmentRegistry(dataDir);
  const entry = registry.create({
    ip: "192.0.2.8", port: 2222, form: "k8s",
    backendPassword: BACKEND_SECRET, rootPassword: ROOT_SECRET,
    tags: ["v5"],
  }, "keeper");
  const script: Scene[] = [
    { text: "收到,先做初步排查。" },
    { tool: { name: "select_environment", input: { ip: "192.0.2.8" } } },
    { text: "环境已挂上,按技能 fetch-logs 抓日志,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  seedModule(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const created = service.create({
      // 有单场景:登记环境可选(自动接单单同款起点),本用例测的正是
      // 「未配环境的会话」在对话里补配——无单场景登记环境必填,不适用。
      account: "dev", title: "网关偶发超时", ticket: TICKET, source: "dts",
    });
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "首回合收口");
    // 用户在聊天框里给出环境 IP(对话明确给出,不是 AI 自己巡游台账)。
    service.reply(created.id, "网管环境用 192.0.2.8 这台");
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "挂载回合收口");

    // 会话环境挂上:元信息(公开 API)可查,来源 IP 与台账形态在案。
    const issue = service.get(created.id);
    assert.deepEqual(issue.environment?.hosts, ["192.0.2.8"]);
    assert.equal(issue.environment?.port, 2222);
    assert.equal(issue.environment?.env_type, "k8s");
    assert.equal(issue.environment?.environment_source_ip, "192.0.2.8",
      "快照来源(选定时点的台账主 IP)进会话状态");

    // 服务端解密快照进 vault:后台与显式 root 两组凭据都解得出来。
    const vault = new IssueEnvironmentVault(dataDir);
    assert.equal(vault.credential(created.id,
      issue.environment!.credential_ref, "operator")?.password, BACKEND_SECRET);
    assert.equal(vault.credential(created.id,
      issue.environment!.root_credential_ref!, "root")?.password, ROOT_SECRET);

    // 回执只含事实(命中 IP、形态),密码绝不进模型可见文本。
    const receipt = receiptsOf(dataDir, created.id, "select_environment")[0];
    assert.ok(receipt, "select_environment 回执在场");
    assert.equal(receipt.is_error, false, "唯一命中挂载是成功收口");
    assert.match(String(receipt.result), /10\.0\.0\.8/, "回执报告命中 IP");
    assert.match(String(receipt.result), /容器化\(K8s\)/, "回执报告台账形态");
    assert.doesNotMatch(String(receipt.result),
      new RegExp(`${BACKEND_SECRET}|${ROOT_SECRET}`), "回执不带密码");
    assert.doesNotMatch(String(receipt.result), /覆盖|配置卡|拒绝记录/,
      "首次挂载不带覆盖/清卡/解锢事实行");

    // 密码纪律(定向断言):事件账、状态文件、模型可见请求全都不含机密。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const stateFile = readFileSync(
      join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    const requests = JSON.stringify(model.requests);
    for (const [label, text] of [["事件账", events],
      ["状态文件", stateFile], ["模型请求", requests]] as const) {
      assert.ok(!text.includes(BACKEND_SECRET), `${label}不带后台密码`);
      assert.ok(!text.includes(ROOT_SECRET), `${label}不带独立 root 密码`);
    }

    // 快照语义钉死:台账改密后,已挂载会话的解密结果不漂移。
    registry.update(entry.id, { backendPassword: "rotated-after-mount" },
      "keeper");
    assert.equal(vault.credential(created.id,
      issue.environment!.credential_ref, "operator")?.password, BACKEND_SECRET,
      "台账后续改动不影响本会话(选入即快照)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 覆盖:登记选错了,聊天里给正确 IP 即换环境 ----

test("已配环境的会话可覆盖:给新 IP 即换环境,转移账留痕,形态随新台账条目", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-replace-");
  const registry = new EnvironmentRegistry(dataDir);
  registry.create({
    ip: "192.0.2.8", form: "virtualized",
    backendPassword: "replace-backend-secret",
  }, "keeper");
  const script: Scene[] = [
    { text: "收到,先按登记的环境排查。" },
    { tool: { name: "select_environment", input: { ip: "192.0.2.8" } } },
    { text: "已换到正确环境,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  seedModule(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 登记时手填了错误环境(192.0.2.9):用户在聊天里给出正确 IP 即换。
    const created = service.create({
      account: "dev", title: "登记选错环境", moduleId: "pay-core",
      environment: { hosts: ["192.0.2.9"], backendPassword: "old-plain" },
    });
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "首回合收口");
    service.reply(created.id, "登记时选错了,网管环境是 192.0.2.8");
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "覆盖回合收口");

    const issue = service.get(created.id);
    assert.deepEqual(issue.environment?.hosts, ["192.0.2.8"], "环境已换到新 IP");
    assert.equal(issue.environment?.env_type, "virtualized",
      "形态取新台账条目的人填值");
    assert.equal(issue.environment?.environment_source_ip, "192.0.2.8");
    const vault = new IssueEnvironmentVault(dataDir);
    assert.equal(vault.credential(created.id,
      issue.environment!.credential_ref, "operator")?.password,
      "replace-backend-secret", "凭据换到新条目的解密值");
    // 回执报告覆盖事实;转移账留痕(与既有挂载路径同款)。
    const receipt = receiptsOf(dataDir, created.id, "select_environment")[0];
    assert.equal(receipt.is_error, false);
    assert.match(String(receipt.result), /覆盖/, "回执报告覆盖了原环境");
    const onDisk = readStateFile(dataDir, created.id);
    assert.ok((onDisk.transitions ?? []).some((row) =>
      /网管环境已配置.*10\.0\.0\.8/.test(row.note ?? "")),
      "转移账留痕(既有 attachEnvironment 同款记账)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- env_needed 卡挂着时挂载:卡清除、回落、通知重试 ----

test("env_needed 卡挂着时挂载:卡清除、不再定格等人、平台通知 AI 重试刚才的操作", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-gate-");
  const registry = new EnvironmentRegistry(dataDir);
  registry.create({
    ip: "192.0.2.8", form: "k8s", backendPassword: "gate-backend-secret",
  }, "keeper");
  // 检视意见在配置卡等待期间送达(#350 分诊),意见里带了环境 IP——
  // 分诊回合开的窗口里平台工具照常可用,select_environment 挂载解卡。
  const script: Scene[] = [
    { tool: { name: "select_environment", input: { ip: "192.0.2.8" } } },
    { text: "环境已配好,重试刚才的日志抓取,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir, {
    status: "waiting_user",
    gate: seededGate("env_needed", { scope: "logs" }),
  });
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    service.addReview(created.id, {
      line: 1, anchor: "旧结论", note: "网管环境用 192.0.2.8,配好后重试拉日志",
    });
    service.submitReviews(created.id);
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "分诊回合收口");

    // 卡清除、waiting_user 回落(收口不再定格等人),环境挂上。
    const issue = service.get(created.id);
    assert.equal(issue.gate, undefined, "环境配置卡已随挂载解除");
    assert.deepEqual(issue.environment?.hosts, ["192.0.2.8"]);
    const onDisk = readStateFile(dataDir, created.id);
    assert.equal(onDisk.gate, undefined, "闸清在 issue.json");
    assert.equal(onDisk.status, "idle", "没有闸可等,收口回落不再定格等待");
    // 回执报告清卡事实;平台通知(重试刚才的操作)递到模型。
    const receipt = receiptsOf(dataDir, created.id, "select_environment")[0];
    assert.equal(receipt.is_error, false);
    assert.match(String(receipt.result), /配置卡.*解除/, "回执报告清卡");
    assert.match(JSON.stringify(model.requests), /网管环境已配置/,
      "env.configured 通知递到模型(通知 AI 重试刚才的操作)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 拒绝台账解锢:拒绝后改主意,聊天 IP 补配即恢复 ----

test("拒绝台账在场的会话挂载成功即解锢:整册清除,回执报告恢复", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-decline-");
  const registry = new EnvironmentRegistry(dataDir);
  registry.create({
    ip: "192.0.2.8", form: "k8s", backendPassword: "ungate-backend-secret",
  }, "keeper");
  const script: Scene[] = [
    { tool: { name: "select_environment", input: { ip: "192.0.2.8" } } },
    { text: "拒绝已解,继续拉日志,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir, {
    env_declined: { scopes: ["logs"], at: new Date().toISOString() },
  });
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    service.reply(created.id, "改主意了,还是要拉日志,环境用 192.0.2.8");
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "补配回合收口");
    // 解锢:整册清除(同 scope 工具恢复举卡路径的机制前提)。
    const onDisk = readStateFile(dataDir, created.id);
    assert.equal(onDisk.env_declined, undefined, "拒绝台账整册清除");
    assert.deepEqual(service.get(created.id).environment?.hosts, ["192.0.2.8"]);
    const receipt = receiptsOf(dataDir, created.id, "select_environment")[0];
    assert.equal(receipt.is_error, false);
    assert.match(String(receipt.result), /拒绝记录.*清除/,
      "回执报告解锢事实");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 无命中:如实说明并引导,不猜测、不手造 ----

test("无命中:回执如实说明并引导走环境管理,不举卡、不手造环境", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-miss-");
  const script: Scene[] = [
    { tool: { name: "select_environment", input: { ip: "192.0.2.9" } } },
    { text: "已告知用户去环境管理补录,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    service.reply(created.id, "网管环境用 192.0.2.9");
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "回合收口");
    const receipt = receiptsOf(dataDir, created.id, "select_environment")[0];
    assert.equal(receipt.is_error, true, "无命中是如实失败,不是成功收口");
    assert.match(String(receipt.result), /10\.9\.9\.9/, "回执点名用户给的 IP");
    assert.match(String(receipt.result), /环境管理/, "回执引导走环境管理补录");
    const issue = service.get(created.id);
    assert.equal(issue.environment, undefined, "没有手造环境");
    assert.equal(issue.gate, undefined, "没有借机举卡");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 直调矩阵:终态拒绝(C-H3 同口径)、六卡一规则、参数面 ----

/** 直调现场:analyze 进行中,回调直连真实服务的 selectEnvironmentByIp。 */
function directTools(dataDir: string, state: IssueSessionState,
  service: IssueFlowService, raised?: { value: boolean }): {
  find: (name: string) => {
    name: string;
    description: string;
    parameters: { properties: Record<string, unknown> };
    execute: (id: string, params: any) => Promise<unknown>;
  };
} {
  const ctx: IssueToolContext = {
    state,
    workspace: "/tmp/ws-selenv", dataRoot: dataDir,
    persist: () => undefined,
    environmentPassword: () => undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
    // 服务侧同款接线(openDriver 的 ctx 装配同形)。
    selectEnvironmentByIp: (ip) => service.selectEnvironmentByIp(state.id, ip),
    ...(raised
      ? {
        turnCardRaised: () => raised.value,
        markTurnCardRaised: () => { raised.value = true; },
      }
      : {}),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    description: string;
    parameters: { properties: Record<string, unknown> };
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  return { find: (name) => tools.find((tool) => tool.name === name)! };
}

test("终态会话如实拒绝:与 attachEnvironment 的 C-H3 同口径", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-terminal-");
  const registry = new EnvironmentRegistry(dataDir);
  registry.create({
    ip: "192.0.2.8", form: "k8s", backendPassword: "terminal-secret",
  }, "keeper");
  const model = new ScriptedModelServer([], "scripted-v1");
  await model.start();
  seedIssue(dataDir, { status: "archived" });
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const { find } = directTools(dataDir, readStateFile(dataDir, "issue-1"),
      service);
    await assert.rejects(
      () => find("select_environment").execute("c0", { ip: "192.0.2.8" }),
      (error: Error) => {
        assert.match(error.message, /终态/, "点名终态事实");
        assert.match(error.message, /不能补配环境/, "C-H3 同口径文案");
        return true;
      },
      "终态会话拒绝补配环境");
    // 拒绝零副作用:状态文件没有被半截改动出凭据。
    assert.equal(readStateFile(dataDir, "issue-1").environment, undefined);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("参数面与机械拦:工具只收 ip 一个参数(形态无参,取台账人填值);描述写明使用前提;本回合已举卡同样拦下", async () => {
  const dataDir = mfcTemp("mfc-issue-selenv-direct-");
  const registry = new EnvironmentRegistry(dataDir);
  registry.create({
    ip: "192.0.2.8", form: "virtualized", backendPassword: "direct-secret",
  }, "keeper");
  const model = new ScriptedModelServer([], "scripted-v1");
  await model.start();
  seedIssue(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const raised = { value: false };
    const { find } = directTools(dataDir, readStateFile(dataDir, "issue-1"),
      service, raised);
    const tool = find("select_environment");
    // 参数只有 ip:环境形态没有参数位(取台账人填值,AI 不猜)。
    assert.deepEqual(Object.keys(tool.parameters.properties), ["ip"],
      "工具参数只有 ip,没有形态参数");
    // 描述写明使用前提:用户明确给出 IP 才用,不自行巡游台账替用户挑。
    assert.match(tool.description, /用户在对话中明确给出/,
      "描述写明使用前提");
    assert.match(tool.description, /不要.*巡游|不.*替用户挑|没给 IP/,
      "描述禁止自行替用户挑环境");
    // 举卡即收口(六卡一规则):本回合已举卡,机械拦下、纠偏口吻。
    raised.value = true;
    await assert.rejects(
      () => tool.execute("c1", { ip: "192.0.2.8" }),
      (error: Error) => {
        assert.match(error.message, /已举起一张卡/);
        assert.match(error.message, /不是出错/);
        return true;
      },
      "举卡后同回合调用被机械拦下");
    // 空 IP 如实打回。
    raised.value = false;
    await assert.rejects(
      () => tool.execute("c2", { ip: "  " }),
      /ip 不能为空/,
      "空 IP 打回");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("直调兼容:回调缺席(裸构造)如实打回,不装作挂载成功", async () => {
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-bare", account: "dev", created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "", stage_at: now,
  } as unknown as IssueSessionState;
  const ctx: IssueToolContext = {
    state,
    workspace: "/tmp/ws-selenv-bare", dataRoot: "/tmp/data-selenv-bare",
    persist: () => undefined,
    environmentPassword: () => undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const find = (name: string) => tools.find((tool) => tool.name === name)!;
  await assert.rejects(
    () => find("select_environment").execute("c0", { ip: "192.0.2.8" }),
    /宿主未接线/,
    "回调缺席如实打回(裸构造兼容)");
});
