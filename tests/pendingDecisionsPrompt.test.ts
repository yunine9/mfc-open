import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { concurrentWorkPrompt } from "../src/concurrentWorkPrompt.ts";
import { PENDING_DECISIONS_FILE } from "../src/pendingDecisionsPrompt.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { mfcTemp } from "./mfcTmp.ts";

const decisions = ["历史约束折衷", "锁策略", "日志级别"].map((question, index) => ({
  id: `decision-${index}`, question, options: ["维持现状", "采用调整"], recommended: "采用调整", basis: "analysis.md 已有分析及 verification.log", status: "pending",
}));

test("#555：记录、交办和重启后读取原决策并举卡，先前分析与验证结果保持不变", async () => {
  const root = mfcTemp("mfc-555-decisions-"), path = join(root, PENDING_DECISIONS_FILE);
  const agentDir = join(root, "pi-agent"); mkdirSync(agentDir);
  writeFileSync(join(root, "analysis.md"), "已有分析：三项设计仍需责任人决定。\n");
  writeFileSync(join(root, "verification.log"), "先前模块 UT 已通过。\n");
  const script: Scene[] = [
    { tool: { name: "write", input: { path, content: JSON.stringify({ decisions }) } } },
    { text: "已有三项设计问题需要决定，已保留分析和待决记录。" },
    { text: "新增检视意见已处理，原设计问题仍待决定。" },
    { tool: { name: "read", input: { path } } },
    { tool: { name: "AskUserQuestion", input: { context: "原有三项设计选择尚未答复。", questions: decisions.map(({ question, options, recommended }) => ({ question, options, recommended })) } } },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true }); await model.start();
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const gate = new HumanGate(join(root, "waiting.json"));
  const options = { taskId: "T-555", workspace: root, agentDir, provider: "maeflow", model: "scripted-v1", humanFacing: true,
    eventLog: new EventLog(join(root, "events.jsonl")), transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace: root, cwd: root }), humanGate: gate };
  let session = await CloudSession.create(options);
  try {
    assert.equal((await session.start("分析环境验证材料，先保存未决问题再举卡")).status, "turn_finished");
    assert.ok(existsSync(path));
    assert.deepEqual(gate.pending(), [], "宿主不扫描承诺、自动举卡或拦截结束回合");
    const original = readFileSync(path, "utf8");
    assert.equal((await session.continueWith("新交办：只处理新增意见，原有工作保留。\n" + concurrentWorkPrompt())).status, "turn_finished");
    assert.equal(readFileSync(path, "utf8"), original);
    session.dispose(); session = await CloudSession.create(options);
    assert.equal((await session.start("读取原工作记录，继续未完成事项")).status, "waiting_for_human");
    assert.equal((gate.pending()[0].question.questions as any[]).length, 3);
    assert.equal(readFileSync(join(root, "analysis.md"), "utf8"), "已有分析：三项设计仍需责任人决定。\n");
    assert.equal(readFileSync(join(root, "verification.log"), "utf8"), "先前模块 UT 已通过。\n");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).decisions, decisions, "举卡不能伪造已答复");
    for (const request of model.requests) {
      const system = JSON.stringify(request.system);
      assert.ok(system.includes(path));
      assert.match(system, /先前分析、已完成修改、验证结果/);
      assert.match(system, /结束回合前/);
    }
    const last = JSON.stringify(model.requests.at(-1));
    assert.match(last, /decision-0/); assert.match(last, /decision-2/);
  } finally { session.dispose(); await model.stop(); }
});

test("#555：无待决事项时直接完成，不自动创建文件或增加确认", async () => {
  const root = mfcTemp("mfc-555-none-"), agentDir = join(root, "pi-agent"); mkdirSync(agentDir);
  const model = new ScriptedModelServer([{ text: "已完成明确要求。" }]); await model.start();
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const gate = new HumanGate(join(root, "waiting.json"));
  const session = await CloudSession.create({ taskId: "T-555-none", workspace: root, agentDir, provider: "maeflow", model: "scripted-v1", humanFacing: true,
    eventLog: new EventLog(join(root, "events.jsonl")), transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"), gate: new GateService({ workspace: root }), humanGate: gate });
  try {
    assert.equal((await session.start("按已明确要求完成小修改")).status, "turn_finished");
    assert.equal(existsSync(join(root, PENDING_DECISIONS_FILE)), false);
    assert.deepEqual(gate.pending(), []);
  } finally { session.dispose(); await model.stop(); }
});
