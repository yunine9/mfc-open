/**
 * 绿灯切换(#246,ADR-0024):MR 全绿后平台不再代举 env_verify——
 * 监看器收口只发送「全绿」事实(startPlatformTurn 三态),AI 收到后
 * 经 raise_gate 举验证卡;收口≠流程完成,验证卡是 mr_green 出口的
 * 后半截,欠着不举由催办机器打回(shouldNudgeFixed 出口卡未清判据)。
 *
 * 覆盖四幕:
 * 1. 监看器滞后收口(验绿门放行)→ 发送事实开回合 → AI 举卡 → 等待通知;
 * 2. 漏举催办:收口后 AI 收嘴不举卡 → 专用催办词打回 → 举出;
 * 3. 停靠场景:全绿到达时 AI 卡正挂着 → 便签 → 答卡续跑(#244 注入)
 *    → 模型见通知举卡(单卡并存不出现);
 * 4. complete_stage 当场收口:回执自带举卡指引 → AI 同回合举卡。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { LoopPlatform, seedGreenWatch } from "./issueFlowFixed.helpers.ts";
import { mfcTemp } from "./mfcTmp.ts";

const ORIGIN = "https://git.example.com/org/alpha.git";
const SHA = "c".repeat(40);

/** 慢轮询(3s 一拍):给「先停车、后全绿」的时序留足窗口。 */
const slowPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 3, poll_timeout_s: 120,
  }),
};

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

function readEvents(dataDir: string, id: string):
  Array<{ kind: string; payload: Record<string, any> }> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .map((event) => ({ kind: String(event.kind),
      payload: (event.payload ?? {}) as Record<string, any> }));
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

function baseOptions(dataDir: string, model: ScriptedModelServer,
  platform: LoopPlatform, luban: FakeLubanServer): IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}), runtime: () => ({
      poll_interval_s: 1, poll_timeout_s: 120,
    }) },
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token",
      email: "dev@example.com" }),
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  };
}

test("全绿滞后收口:不代举——发送事实开回合,AI 经 raise_gate 举验证卡", async () => {
  const dataDir = mfcTemp("mfc-greencutover-");
  seedGreenWatch(dataDir, ORIGIN, SHA);
  const platform = new LoopPlatform("success");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate",
      input: { kind: "env_verify", supplement: "全绿事实已确认" } } },
    { text: "已举卡等待用户验证。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model, platform,
    luban));
  try {
    // 发送回合先启动:全绿事实进模型上下文。
    await until(() => model.requests.length >= 1 ? true : undefined,
      "全绿发送回合启动");
    assert.match(JSON.stringify(model.requests), /全部 MR 流水线已跑绿/,
      "全绿事实进模型上下文");
    assert.match(JSON.stringify(model.requests), /raise_gate/,
      "发送词带举卡指引");

    // AI 经工具举卡:卡面/等待通知/裁决链路与代举时代同构。
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "AI 举出验证卡并收口等待");
    assert.equal(gated.stage, "mr_green", "收口语义不变");
    assert.equal(readStateFile(dataDir, "issue-1").mr_gate, undefined,
      "验绿门已随收口清账");
    // 卡的来源是工具不是平台代举:raise_gate 回执成功在案。
    const raised = readEvents(dataDir, "issue-1")
      .find((event) => event.kind === "tool_finished"
        && event.payload.name === "raise_gate");
    assert.equal(raised?.payload.is_error, false,
      "验证卡由 AI 经 raise_gate 举出");
    await until(() => luban.messages.length ? luban.messages : undefined,
      "等待卡通知发出");
    assert.match(JSON.stringify(luban.messages), /验证/,
      "通知引导用户到卡上作答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("漏举催办:收口后 AI 收嘴不举卡——专用催办词打回,举出即停", async () => {
  const dataDir = mfcTemp("mfc-greencutover-nudge-");
  seedGreenWatch(dataDir, ORIGIN, SHA);
  const platform = new LoopPlatform("success");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([
    { text: "收到全绿通知。" },
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model, platform,
    luban));
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "催办后 AI 举出验证卡");
    // 催办词进了模型上下文:点名的不是"继续推进"而是"把卡交出去"。
    assert.match(JSON.stringify(model.requests), /还没有交给用户/,
      "欠卡专用催办词送达模型");
    assert.match(JSON.stringify(model.requests), /kind=env_verify/,
      "催办词带举卡指引");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("停靠场景:全绿到达时 AI 卡挂着——便签随答卡续跑送达,举出验证卡", async () => {
  const dataDir = mfcTemp("mfc-greencutover-parked-");
  seedGreenWatch(dataDir, ORIGIN, SHA);
  // 慢轮询:问题卡先停,全绿后到。
  const platform = new LoopPlatform("success");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "请描述你观察到的现象?" },
    ] } } },
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model, platform, luban),
    settings: slowPoll,
  });
  try {
    service.reply("issue-1", "继续推进");
    await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "AI 问题卡先停");
    // 全绿落在等人窗口:发送走便签,不抢答。
    await until(() => {
      const state = readStateFile(dataDir, "issue-1");
      return state.parked_notices?.length ? state : undefined;
    }, "全绿事实落便签");
    // 答卡 → 原地续跑:便签随决定回执注入,模型见事实后举卡。
    const waiting = service.get("issue-1").waiting!;
    service.answer("issue-1", { state_version: waiting.state_version,
      decision: "偶发,重启恢复" });
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "续跑后举出验证卡");
    assert.equal(gated.waiting, undefined, "Agent 卡已答,单卡不并存");
    assert.match(JSON.stringify(model.requests), /全部 MR 流水线已跑绿/,
      "便签里的全绿事实经续跑送达模型");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

