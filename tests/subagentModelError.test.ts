/**
 * 子 Agent 死于模型层错误时,宿主必须如实返回失败,而不是把最后一句旁白当结果。
 *
 * 实锤:cross-glm53-20260906c task-2 写设计阶段,Story 子 Agent 两次在 300s
 * 沉默后被 undici 掐线(errorMessage="terminated"),宿主报 lifecycle=returned、
 * final_text="现在勘察真实代码…",主 Agent 当成"中途话术"再派一次,再死一次。
 *
 * 裁判用真 pi 会话 + 剧本假模型:子 Agent 的那次请求由网关吐一个不可重试的
 * 错误(pi 对 insufficient_quota 不重试,测试不用等退避)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene, type ScriptedModelOptions } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

const DISPATCH: Scene = {
  text: "交给子 Agent 写 Story 卡。",
  tool: {
    name: "Task",
    input: { subagent_type: "story-agent", description: "写 Story 卡", prompt: "CHILD-PROMPT" },
  },
};

async function run(
  script: Scene[],
  beforeScene?: (model: ScriptedModelServer, requestNumber: number) => void | Promise<void>,
  configure?: (session: CloudSession) => void | (() => Promise<void>),
) {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-child-error-"));
  const options: ScriptedModelOptions = { linear: true };
  const model = new ScriptedModelServer(script, "scripted-v1", options);
  options.beforeScene = ({ requestNumber }) => beforeScene?.(model, requestNumber);
  await model.start();
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  writeFileSync(join(workspace, "review-input.md"), "设计要求：重复请求不重复记账。\n");
  const eventLog = new EventLog(join(workspace, "events.jsonl"));
  const logs: string[] = [];
  const session = await CloudSession.create({
    taskId: "T-child-error",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog,
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace, cwd: workspace }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    log: (line) => logs.push(line),
  });
  try {
    const settle = configure?.(session);
    const outcome = await session.start("开始");
    if (typeof settle === "function") await settle();
    return { outcome, events: eventLog.replay(), requests: model.requests, logs, model,
      forbiddenWritten: existsSync(join(workspace, "forbidden.txt")),
      parentNote: existsSync(join(workspace, "parent-note.txt")) ? readFileSync(join(workspace, "parent-note.txt"), "utf8") : undefined };
  } finally {
    session.dispose();
    await model.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("子 Agent 的模型请求失败:按 failed 返回并带错误原文,主 Agent 看到的是失败不是旁白", async () => {
  // 顺演剧本:第 1 请求主 Agent 派发;第 2 请求(子 Agent)由网关吐错;第 3 请求主 Agent 收口。
  const result = await run(
    [DISPATCH, { text: "(子 Agent 这幕不会被演到)" }, { text: "子 Agent 失败,如实上报。" }],
    (model, requestNumber) => {
      if (requestNumber === 1) model.failWith("insufficient_quota: 账户额度已用尽", 1);
    },
  );
  assert.equal(result.outcome.status, "turn_finished", result.outcome.detail ?? "");
  const finished = result.events.find((event) => event.kind === "agent_finished");
  assert.ok(finished, "应有 agent_finished 事件");
  assert.equal(finished.payload.lifecycle, "failed",
    "模型层错误必须按 failed 返回,不能冒充 returned");
  assert.match(String(finished.payload.final_text), /insufficient_quota/,
    "失败原因原文必须带给主 Agent");
  // Task 的收口只走内核 posttooluse(pi 的回声被丢弃),事件流里没有它;
  // 主 Agent 的下一轮请求里,工具结果是失败原文——这才是它决定重派或停下的依据。
  assert.match(JSON.stringify(result.requests.at(-1)), /insufficient_quota/);
  assert.ok(result.logs.some((line) => /模型层错误/.test(line)),
    "错误原文必须进日志,以后再出沉默返回有据可查");
});

test("只读检视子 Agent 不提供写入或执行工具，主 Agent 仍可处理检视结果", async () => {
  const result = await run([
    { tool: { name: "Task", input: { subagent_type: "general-purpose", description: "设计一致性检视",
      prompt: "只读 review-input.md 并报告设计偏离。", read_only: true, timeout_seconds: 10 } } },
    { tool: { name: "write", input: { path: "forbidden.txt", content: "子 Agent 不应写入" } } },
    { tool: { name: "read", input: { path: "review-input.md" } } },
    { text: "D1：重复请求缺少幂等判断，需主 Agent 核实修复。" },
    { tool: { name: "write", input: { path: "parent-note.txt", content: "主 Agent 已收到 D1，继续处理。" } } },
    { text: "已接收设计检视意见。" },
  ]);
  assert.equal(result.outcome.status, "turn_finished");
  const names = (result.requests[1].tools as Array<{ name: string }>).map(tool => tool.name.toLowerCase());
  assert.ok(names.includes("read"));
  for (const name of ["write", "edit", "bash", "task", "askuserquestion"]) assert.ok(!names.includes(name), name);
  assert.equal(result.forbiddenWritten, false);
  assert.match(result.parentNote ?? "", /已收到 D1/);
  assert.match(JSON.stringify(result.requests.at(-1)), /D1/);
  assert.equal(result.events.find(e => e.kind === "agent_finished")?.payload.lifecycle, "returned");
});

test("单次检视超时中止子会话并把未完成原因交回，主 Agent 能继续且不接收迟到成功", async () => {
  const result = await run([
    { tool: { name: "Task", input: { subagent_type: "general-purpose", description: "设计一致性检视",
      prompt: "检查本次设计。", read_only: true, timeout_seconds: 1 } } },
    { text: "迟到的报告不应成为成功结果。" },
    { tool: { name: "write", input: { path: "parent-note.txt", content: "检视未完成，保留缺口并继续。" } } },
    { text: "已保留检视缺口。" },
  ], async (_model, requestNumber) => {
    if (requestNumber === 2) await new Promise(resolve => setTimeout(resolve, 1500));
  });
  assert.equal(result.outcome.status, "turn_finished");
  const finished = result.events.filter(e => e.kind === "agent_finished");
  assert.equal(finished.length, 1);
  assert.notEqual(finished[0].payload.lifecycle, "returned");
  assert.match(String(finished[0].payload.final_text), /超过 1 秒.*未完成/);
  assert.match(result.parentNote ?? "", /保留缺口并继续/);
  assert.equal(result.events.filter(e => e.kind === "agent_spawned").length, 1);
});

test("检视创建尚未完成也受单次期限约束，迟到会话只释放不启动", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let prompted = 0, disposed = 0;
  const result = await run([
    { tool: { name: "Task", input: { subagent_type: "general-purpose", description: "设计一致性检视",
      prompt: "检查本次设计。", read_only: true, timeout_seconds: 1 } } },
    { text: "创建超时，记录未完成并继续。" },
  ], undefined, session => {
    (session as any).openSession = async () => {
      await pending;
      return { prompt: async () => { prompted++; }, dispose: () => { disposed++; }, abort: async () => {} };
    };
    return async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); };
  });
  assert.equal(result.outcome.status, "turn_finished");
  assert.equal(prompted, 0);
  assert.equal(disposed, 1);
  assert.match(String(result.events.find(e => e.kind === "agent_finished")?.payload.final_text), /超过 1 秒/);
});

test("新增执行期限只用于只读任务，不把写入型子 Agent 变成超时后仍可能写入的后台任务", async () => {
  const result = await run([
    { tool: { name: "Task", input: { subagent_type: "general-purpose", description: "写代码",
      prompt: "修改生产代码。", timeout_seconds: 1 } } },
    { text: "没有启动写入型子任务，沿原任务继续。" },
  ]);
  assert.equal(result.outcome.status, "turn_finished");
  assert.equal(result.events.filter(e => e.kind === "agent_spawned").length, 0);
  assert.match(JSON.stringify(result.requests.at(-1)), /只适用于只读子 Agent/);
});

test("子 Agent 正常返回:lifecycle 仍是 returned,最终报告原样交回", async () => {
  const result = await run(
    [DISPATCH, { text: "CHILD-REPORT 三张 Story 卡已落盘。" }, { text: "收到子 Agent 报告,完成。" }],
  );
  assert.equal(result.outcome.status, "turn_finished", result.outcome.detail ?? "");
  const finished = result.events.find((event) => event.kind === "agent_finished");
  assert.ok(finished);
  assert.equal(finished.payload.lifecycle, "returned");
  assert.equal(finished.payload.final_text, "CHILD-REPORT 三张 Story 卡已落盘。");
  assert.match(JSON.stringify(result.requests.at(-1)), /CHILD-REPORT/,
    "主 Agent 下一轮应拿到子 Agent 的报告原文");
});

test("主会话工具执行后再遇模型错误，也不能伪装成正常 end_turn", async () => {
  const result = await run([
    { tool: { name: "bash", input: { command: "echo tool-completed" } } },
    { text: "不应执行" },
  ], (model, requestNumber) => {
    if (requestNumber === 1) model.failWith("insufficient_quota: 账户额度已用尽", 1);
  });
  assert.equal(result.outcome.status, "session_ended");
  assert.match(result.outcome.detail ?? "", /insufficient_quota/);
  assert.ok(result.events.some((e) => e.kind === "tool_finished"));
  assert.ok(!result.events.some((e) => e.kind === "turn_finished"));
});

test("子 Agent 接到长材料也主动整理，主会话只派发一次并正常收到结果", async () => {
  const result = await run([
    { ...DISPATCH, tool: { ...DISPATCH.tool!, input: { ...DISPATCH.tool!.input,
      prompt: "整理资料，不要修改 B。" + "很长的历史材料".repeat(25_000) } } },
    ...Array.from({ length: 30 }, () => ({ text: "CHILD-REPORT 已整理，B 未修改。" })),
  ], (model, requestNumber) => {
    if (requestNumber <= 1) return;
    if (JSON.stringify(model.requests.at(-1)?.system).includes("你在整理 Coding Agent"))
      model.script[requestNumber - 1] = { text: "目标：整理资料；禁止修改 B；子 Agent 已派发，不要重复派发。" };
  });
  assert.equal(result.outcome.status, "turn_finished", result.outcome.detail);
  const child = result.events.find((e) => e.kind === "agent_spawned");
  assert.ok(child);
  assert.equal(result.events.filter((e) => e.kind === "agent_spawned").length, 1);
  assert.equal(result.events.find((e) => e.kind === "agent_finished")?.payload.lifecycle, "returned");
  assert.ok(result.logs.some((line) => line.includes(String(child.payload.child_session_id)) && line.includes("容量预判")));
});
