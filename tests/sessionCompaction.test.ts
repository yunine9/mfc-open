import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SessionCompaction, estimateContextSize, reportedContextLimit } from "../src/sessionCompaction.ts";
import { pendingDecisionsPrompt, PENDING_DECISIONS_FILE } from "../src/pendingDecisionsPrompt.ts";
import { concurrentWorkPrompt } from "../src/concurrentWorkPrompt.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { mfcTemp } from "./mfcTmp.ts";

const summaryText = "目标：实现功能。约束：不要修改 B。已完成：读取日志、写入 A；禁止重复执行。下一步：修复 C 后运行 UT，尚未验证。";
const isSummary = (request: any) => JSON.stringify(request.system).includes("你在整理 Coding Agent");

async function fixture(options: {
  window?: number;
  system?: (root: string) => string;
  normal?: (request: any, index: number) => Scene;
  summary?: (request: any, index: number) => Promise<Scene> | Scene;
  tool?: () => Promise<string> | string;
  context?: (messages: any[]) => any[];
} = {}) {
  const root = mfcTemp("mfc-context-budget-");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  let normal = 0, summaries = 0, tools = 0;
  const server = new ScriptedModelServer(Array.from({ length: 100 }, () => ({ text: "完成" })), "scripted-v1", {
    linear: true,
    beforeScene: async ({ request, index }) => {
      if (isSummary(request)) {
        summaries++;
        server.script[index] = await options.summary?.(request, summaries) ?? { text: summaryText };
      } else {
        normal++;
        server.script[index] = options.normal?.(request, normal) ?? { text: "完成" };
      }
    },
  });
  await server.start();
  const models = server.modelsJson() as any;
  models.providers.maeflow.models[0] = { id: "scripted-v1", contextWindow: options.window ?? 16_000, maxTokens: 2048 };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
  const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json") });
  const manager = SessionManager.create(root, join(agentDir, "sessions"));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPromptOverride: () => "执行当前用户需求，禁止修改 B。" + (options.system?.(root) ?? ""), agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime,
    model: runtime.getModel("maeflow", "scripted-v1"), resourceLoader: loader,
    sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), tools: ["readLog"],
    customTools: [defineTool({ name: "readLog", label: "读取日志", description: "读取测试日志",
      parameters: Type.Object({}), execute: async () => {
        tools++;
        return { content: [{ type: "text" as const, text: await options.tool?.() ?? "已经写入 A" }], details: {} };
      } })],
  });
  const logs: string[] = [];
  if (options.context) session.agent.transformContext = async (messages) => options.context!(messages);
  const policy = new SessionCompaction(session, runtime, { anchor: () => "用户禁止修改 B；当前在验证 C。", log: (s) => logs.push(s) });
  policy.install();
  return { session, manager, runtime, policy, server, logs, root,
    counts: () => ({ normal, summaries, tools }),
    close: async () => { session.dispose(); await server.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

function seed(h: Awaited<ReturnType<typeof fixture>>, size = 30_000) {
  h.manager.appendMessage({ role: "user", content: "OLD-MATERIAL " + "旧日志x".repeat(size / 4), timestamp: Date.now() });
  h.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "旧材料已阅读，等待下一步" }],
    api: "anthropic-messages", provider: "maeflow", model: "scripted-v1", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  h.session.agent.state.messages = h.manager.buildSessionContext().messages;
}

test("中文按保守大小预估、图片不按 base64 计数；容量解析只接收明确数值", () => {
  assert.ok(estimateContextSize("上下文".repeat(100)) > 400);
  assert.equal(estimateContextSize({ type: "image", data: "x".repeat(100_000) }), 4096);
  assert.equal(reportedContextLimit("max input length is 169984, current input length is 179544"), 169984);
  assert.equal(reportedContextLimit("maximum context length is 128,000 tokens"), 128000);
  assert.equal(reportedContextLimit("input too long"), undefined);
});

test("生产窗口量级：配置 200k、网关 169984，大材料在发给网关前缩小", async () => {
  const h = await fixture({ window: 200_000 });
  try {
    seed(h, 150_000);
    assert.ok(estimateContextSize(h.session.agent.state.messages) > 169984);
    await h.session.prompt("按最新流水线结果继续，不要重新推送已完成的提交");
    for (const request of h.server.requests) assert.ok(estimateContextSize(request) < 169984);
    assert.equal(h.counts().normal, 1);
    assert.ok(h.logs.some((s) => s.includes("容量预判")));
  } finally { await h.close(); }
});

test("真实 usage（含缓存输入）会校准下一次请求的估算", async () => {
  const h = await fixture();
  try {
    // 字符量很少但服务端实际已占 12k，下一轮必须尊重 usage 而不是 chars/4。
    h.server.options.usage = { input_tokens: 4000, output_tokens: 10, cache_read_input_tokens: 8000 };
    await h.session.prompt("第一轮，保留用户约束，不要修改 B。".repeat(30));
    assert.equal(h.counts().summaries, 0);
    h.server.options.usage = undefined;
    await h.session.prompt("第二轮继续修复 C");
    assert.ok(h.counts().summaries >= 1);
  } finally { await h.close(); }
});

test("知识注入也计入预算，临时知识不会被写入历史或压缩摘要", async () => {
  const memory = { role: "custom", customType: "mae-memory-context", display: false,
    content: [{ type: "text", text: "TEMP-KNOWLEDGE " + "知识".repeat(1200) }], timestamp: Date.now() };
  const h = await fixture({ context: (messages) => [...messages, memory] });
  try {
    seed(h, 6600);
    await h.session.prompt("按当前知识处理 C");
    assert.ok(h.counts().summaries > 0, "加入临时知识后越过触发水位");
    assert.match(JSON.stringify(h.server.requests.at(-1)), /TEMP-KNOWLEDGE/);
    assert.doesNotMatch(JSON.stringify(h.manager.getBranch()), /TEMP-KNOWLEDGE/);
  } finally { await h.close(); }
});

test("新材料发出前主动压缩；每段摘要有预算，当前用户约束仍在最终请求", async () => {
  const h = await fixture();
  try {
    seed(h);
    await h.session.prompt("CURRENT-INSTRUCTION 只改 C，不要修改 B。");
    assert.ok(h.counts().summaries > 1, "大历史分段，不把完整超限历史原样再发送");
    const normal = h.server.requests.filter((r) => !isSummary(r));
    assert.equal(normal.length, 1, "没有先故意撞网关");
    assert.match(JSON.stringify(normal[0]), /CURRENT-INSTRUCTION/);
    assert.doesNotMatch(JSON.stringify(normal[0]), /OLD-MATERIAL/);
    for (const request of h.server.requests) assert.ok(estimateContextSize(request) < 16_000);
    assert.ok(h.logs.some((s) => s.includes("容量预判")));
    assert.equal(h.manager.getBranch().filter((e) => e.type === "compaction").length, 1);
    const reopened = SessionManager.open(h.manager.getSessionFile()!);
    assert.doesNotMatch(JSON.stringify(reopened.buildSessionContext().messages), /OLD-MATERIAL/);
    assert.match(JSON.stringify(reopened.getBranch()), /OLD-MATERIAL/, "原文没有被删除");
  } finally { await h.close(); }
});

test("一轮内工具返回巨量日志也提前整理，工具不重放且调用结果不会孤立", async () => {
  const h = await fixture({ normal: (_r, index) => index === 1
    ? { tool: { name: "readLog", input: {} } } : { text: "继续验证" },
    tool: () => "LOG-BEGIN " + "错误原因C 日志\n".repeat(4000) + " LOG-END" });
  try {
    await h.session.prompt("写入 A 后检查 C，禁止修改 B");
    assert.equal(h.counts().tools, 1, JSON.stringify({ counts: h.counts(), logs: h.logs, messages: h.session.agent.state.messages }).slice(0, 4000));
    assert.equal(h.counts().normal, 2);
    assert.ok(h.counts().summaries > 0);
    const final = h.server.requests.filter((r) => !isSummary(r)).at(-1)!;
    assert.ok(estimateContextSize(final) < 16_000);
    assert.match(JSON.stringify(final), /禁止重复执行/);
    assert.ok(h.server.requests.filter(isSummary).some((r) => JSON.stringify(r).includes("LOG-END")), "长日志尾部没有被丢弃");
  } finally { await h.close(); }
});

test("网关容量比配置小：校正并持久化容量，不再追加原用户消息", async () => {
  const h = await fixture({ window: 200_000 });
  try {
    seed(h, 10_000);
    h.server.failWith("input too long, max input length is 16000, current input length is 17954");
    await h.session.prompt("UNIQUE-USER-REQUEST 继续修复");
    const users = h.manager.getBranch().filter((e) => e.type === "message" && e.message.role === "user"
      && JSON.stringify(e.message).includes("UNIQUE-USER-REQUEST"));
    assert.equal(users.length, 1);
    const failure = h.manager.getBranch().find(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "error");
    assert.ok(failure, "保留原始失败记录");
    assert.ok(h.manager.getBranch().some(e => e.type === "context_edit" && e.targetId === failure.id && e.replacement === null));
    const reopened = SessionManager.open(h.manager.getSessionFile()!);
    assert.equal(reopened.buildSessionContext().messages.some(m => m.role === "assistant" && m.stopReason === "error"), false,
      "重启后失败回复也不能重新进入模型上下文");
    assert.ok(h.logs.some((s) => s.includes("校正上下文容量为 16000")));
    assert.ok(h.manager.getBranch().some((e) => e.type === "custom" && e.customType === "mae-context-capacity"));
    assert.equal(h.session.agent.state.messages.at(-1)?.role, "assistant");
    assert.equal((h.session.agent.state.messages.at(-1) as any).stopReason, "stop");
  } finally { await h.close(); }
});

test("新积累的第二次超限仍可恢复，每轮都只发送一份用户消息", async () => {
  const h = await fixture({ window: 200_000 });
  try {
    for (let round = 1; round <= 2; round++) {
      seed(h, round === 1 ? 10_000 : 3000);
      h.server.failWith("input too long, max input length is 16000, current input length is 17954");
      await h.session.prompt(`UNIQUE-ROUND-${round} 只处理尚未完成的任务`);
      assert.equal((h.session.agent.state.messages.at(-1) as any).stopReason, "stop");
      assert.equal(h.manager.getBranch().filter((entry) => entry.type === "message"
        && entry.message.role === "user" && JSON.stringify(entry.message).includes(`UNIQUE-ROUND-${round}`)).length, 1);
    }
    assert.equal(h.logs.filter((s) => s.includes("上下文超限，整理后")).length, 2);
  } finally { await h.close(); }
});

test("重启后沿用网关容量，不能恢复成模型配置里的大窗口", async () => {
  const h = await fixture({ window: 200_000 });
  let resumed: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    seed(h, 10_000);
    h.server.failWith("input too long, max input length is 16000, current input length is 17954");
    await h.session.prompt("第一轮恢复");
    const manager = SessionManager.open(h.manager.getSessionFile()!);
    const created = await createAgentSession({ cwd: h.root, agentDir: join(h.root, "agent"),
      modelRuntime: h.runtime, model: h.runtime.getModel("maeflow", "scripted-v1"),
      sessionManager: manager, settingsManager: SettingsManager.inMemory(), tools: [] });
    resumed = created.session;
    const logs: string[] = [];
    new SessionCompaction(resumed, h.runtime, { anchor: () => "重启续跑", log: (s) => logs.push(s) }).install();
    await resumed.prompt("新材料：" + "当前问题C".repeat(2000));
    assert.ok(logs.some((line) => line.includes("容量预判") && line.includes("/ 16000 tokens")));
  } finally { resumed?.dispose(); await h.close(); }
});

test("小会话不压缩；摘要失败只尝试一次，保留历史继续原请求", async () => {
  const h = await fixture({ summary: () => ({ text: "" }) });
  try {
    await h.session.prompt("小任务");
    assert.equal(h.counts().summaries, 0);
    seed(h);
    await h.session.prompt("继续");
    assert.equal(h.counts().summaries, 1);
    assert.equal(h.manager.getBranch().filter((e) => e.type === "compaction").length, 0);
    assert.match(JSON.stringify(h.session.agent.state.messages), /OLD-MATERIAL/);
  } finally { await h.close(); }
});

test("取消压缩不会写入半截摘要，也不会发后续执行请求", async () => {
  let started!: () => void;
  const entered = new Promise<void>((r) => { started = r; });
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const h = await fixture({ summary: async () => { started(); await hold; return { text: summaryText }; } });
  try {
    seed(h);
    const run = h.session.prompt("继续修复");
    await entered;
    await h.session.abort();
    release();
    await run;
    assert.equal(h.manager.getBranch().filter((e) => e.type === "compaction").length, 0);
    assert.equal(h.counts().normal, 0);
  } finally { release(); await h.close(); }
});

test("工具未结束期间不压缩、不取消工具", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const hold = new Promise<void>((r) => { release = r; });
  const h = await fixture({ normal: (_r, i) => i === 1 ? { tool: { name: "readLog", input: {} } } : { text: "结束" },
    tool: async () => { entered(); await hold; return "UT通过"; } });
  try {
    const run = h.session.prompt("执行一次 UT");
    await started;
    assert.equal(h.counts().summaries, 0);
    release(); await run;
    assert.equal(h.counts().tools, 1, JSON.stringify({ counts: h.counts(), logs: h.logs, messages: h.session.agent.state.messages }).slice(0, 4000));
    assert.match(JSON.stringify(h.server.requests.at(-1)), /UT通过/);
  } finally { release(); await h.close(); }
});


test("#555：多轮压缩后固定恢复指令仍在模型请求中，原决策文件可重复读取", async () => {
  let path = "";
  const decisions = { decisions: [{ id: "lock-strategy", question: "是否调整锁策略", status: "pending", basis: "analysis.md；原 UT 已通过" }] };
  const h = await fixture({ system: root => pendingDecisionsPrompt(root),
    normal: (_request, index) => index % 2 === 1 ? { tool: { name: "readLog", input: {} } } : { text: "已有分析和验证保留；原决策尚待答复。" },
    tool: () => readFileSync(path, "utf8") });
  try {
    path = join(h.root, PENDING_DECISIONS_FILE); mkdirSync(join(h.root, ".mae-flow-work"), { recursive: true });
    writeFileSync(path, JSON.stringify(decisions));
    for (let round = 0; round < 2; round++) {
      seed(h);
      await h.session.prompt("新交办完成后接续原工作。\n" + concurrentWorkPrompt());
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), decisions);
      const request = h.server.requests.filter(r => !isSummary(r)).at(-1)!;
      assert.ok(JSON.stringify(request.system).includes(path));
      assert.match(JSON.stringify(request), /lock-strategy/);
    }
    assert.equal(h.counts().tools, 2, "压缩不重放已经执行的工具");
    assert.equal(h.manager.getBranch().filter(e => e.type === "compaction").length, 2);
    for (const request of h.server.requests.filter(isSummary)) {
      assert.match(JSON.stringify(request.system), /未决决策与承诺/);
      assert.match(JSON.stringify(request.system), /新交办不等于旧工作已取消/);
    }
  } finally { await h.close(); }
});
