import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";


test("回合收口先 flush Hook，证据登记失败只让当前任务失败", async () => {
  const model = new ScriptedModelServer([{
    text: "执行一次工具。",
    tool: { name: "bash", input: { command: "echo done" } },
  }, { text: "完成。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), "mfc-hook-flush-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  let finished = false;
  const session = await CloudSession.create({
    taskId: "T-flush", workspace: root, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: new EventLog(join(root, "events.jsonl")),
    transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    hostHooks: {
      preTool: async () => undefined,
      postTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
        throw new Error("disk full while recording evidence");
      },
    },
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(finished, true, "收口前必须等登记 Promise 真正结束");
    assert.equal(outcome.status, "session_ended");
    assert.match(outcome.detail ?? "", /证据登记未可靠落盘/);
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("posttooluse 纠偏话送回模型,回合照常收口而不是整单判死", async () => {
  // 防御的故障:内核退 2 让模型补模板章节,原实现把它记进 kernelFailures
  // → "内核授权或证据登记未可靠落盘" → 会话 failed → 宿主 push/MR 全部
  // 不发生(交付链只在会话干净收口后启动)。内网实测一单就是这么死的。
  const model = new ScriptedModelServer([{
    text: "写实施附录。",
    tool: { name: "bash", input: { command: "echo write-doc" } },
  }, {
    text: "按内核提示补章节。",
    tool: { name: "bash", input: { command: "echo fix-doc" } },
  }, { text: "完成。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), "mfc-hook-verdict-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const log = new EventLog(join(root, "events.jsonl"));
  const notice =
    "[mae-flow] IMPLEMENTATION 结构与模板不符,缺少章节: 3 定稿自查。请补齐。";
  let told = false;
  const session = await CloudSession.create({
    taskId: "T-verdict", workspace: root, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: log,
    transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    hostHooks: {
      preTool: async () => undefined,
      postTool: async () => {
        if (told) return undefined;
        told = true;
        return notice;   // 第一次工具收尾:内核退 2 的纠偏话
      },
    },
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished",
      "纠偏话不是失败,回合必须正常收口");
    // 纠偏话进了 steer 通道并留了账(via=kernel):没送达也会被
    // settleTurn 的"未送达插话补发"取回,这条账就是它的凭证。
    const deadline = Date.now() + 3000;
    let relayed;
    for (;;) {
      relayed = log.replay().find((event) =>
        event.kind === "user_message" && event.payload.via === "kernel");
      if (relayed || Date.now() > deadline) break;
      await new Promise((tick) => setTimeout(tick, 50));
    }
    assert.match(String(relayed?.payload.text ?? ""), /缺少章节: 3 定稿自查/,
      "纠偏话原文必须进入送回模型的通道");
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("恢复会先把无返回的子 Agent 登记为 interrupted 再续跑", async () => {
  const model = new ScriptedModelServer([{ text: "按内核断点继续。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), "mfc-child-reconcile-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const log = new EventLog(join(root, "events.jsonl"));
  const transcript = new TranscriptStore(join(root, "transcript.jsonl"), "main");
  const spawned: SemanticEvent = {
    eventId: 1, taskId: "T-reconcile", sessionId: "main",
    ts: new Date().toISOString(), kind: "agent_spawned",
    payload: {
      call_id: "call-old", agent_type: "ut-generator-agent",
      description: "补 UT", prompt: "任务卡", child_session_id: "child-7",
    },
  };
  log.append(spawned);
  transcript.record(spawned);
  const post: SemanticEvent[] = [];
  const session = await CloudSession.create({
    taskId: "T-reconcile", workspace: root, agentDir,
    provider: "maeflow", model: "scripted-v1", eventLog: log, transcript,
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    hostHooks: {
      preTool: async () => undefined,
      postTool: async (event) => { post.push(event); },
    },
  });
  try {
    const outcome = await session.startResume("继续");
    assert.equal(outcome.status, "turn_finished");
    const finished = log.replay().find((event) =>
      event.kind === "agent_finished"
      && event.payload.call_id === "call-old");
    assert.equal(finished?.payload.lifecycle, "interrupted");
    assert.ok(post.some((event) =>
      event.payload.name === "Task"
      && event.payload.call_id === "call-old"
      && event.payload.is_error === true));
  } finally {
    session.dispose();
    await model.stop();
  }
});
