import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession, type CloudSessionOptions } from "../src/sessionDriver.ts";
import { COMMIT_CONTENT_GUIDANCE } from "../src/ownerDecisionContext.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { HumanGate } from "../src/humanGate.ts";
import { GateService } from "../src/gateService.ts";
import { forceRm } from "./mfcRm.ts";

const isSummary = (request: any) => JSON.stringify(request.system).includes("你在整理 Coding Agent");

async function fixture(t: TestContext, sessionId: string, instructions = [COMMIT_CONTENT_GUIDANCE]) {
  const root = mkdtempSync(join(tmpdir(), "mfc-commit-guidance-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const model = new ScriptedModelServer(Array.from({ length: 100 }, () => ({ text: "继续当前任务。" })), "scripted-v1", {
    linear: true,
    beforeScene: ({ request, index }) => {
      if (isSummary(request)) model.script[index] = { text: "旧日志已读，继续当前任务。" };
    },
  });
  await model.start();
  const models = model.modelsJson() as any;
  models.providers.maeflow.models[0] = { id: "scripted-v1", contextWindow: 32_000, maxTokens: 2048 };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
  const logs: string[] = [], sessions: CloudSession[] = [];
  const options: CloudSessionOptions = {
    taskId: "task-commit", workspace: root, agentDir, provider: "maeflow", model: "scripted-v1", sessionId,
    eventLog: new EventLog(join(root, "events.jsonl")),
    transcript: new TranscriptStore(join(root, "transcript.jsonl"), sessionId),
    gate: new GateService(), humanGate: new HumanGate(join(root, "waiting.json")),
    additionalSystemInstructions: instructions, allowHumanQuestions: false, log: text => logs.push(text),
  };
  t.after(async () => { sessions.forEach(session => session.dispose()); await model.stop(); forceRm(root); });
  return { model, logs, create: async (overrides: Partial<CloudSessionOptions> = {}) => {
    const session = await CloudSession.create({ ...options, ...overrides }); sessions.push(session); return session;
  } };
}

for (const sessionId of ["main", "prepush-1"]) test(`${sessionId} 压缩和重启后仍在系统指令中收到提交方法，不依赖历史摘要`, async t => {
  const f = await fixture(t, sessionId);
  const session = await f.create();
  assert.equal((await session.start("旧研究材料 OLD-RESEARCH " + "冗长日志内容\n".repeat(9000))).status, "turn_finished");
  assert.ok(f.model.requests.some(isSummary), "实际触发会话压缩");
  session.dispose();
  const restored = await f.create({ resumeSession: true });
  assert.equal((await restored.start("继续提交本次修复")).status, "turn_finished");
  const requests = f.model.requests.filter(request => !isSummary(request));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.ok(JSON.stringify(request.system).includes(COMMIT_CONTENT_GUIDANCE));
    assert.doesNotMatch(JSON.stringify(request.messages), /OLD-RESEARCH/);
  }
});

test("子会话继承固定提交方法，调用方未配置时不影响问题单等其他会话", async t => {
  const f = await fixture(t, "main");
  f.model.script[0] = { tool: { name: "Task", input: {
    subagent_type: "implementer", description: "检查本次修改", prompt: "CHILD-COMMIT 检查修改" } } };
  const session = await f.create();
  assert.equal((await session.start("请检查本次修改")).status, "turn_finished");
  const child = f.model.requests.find(request => JSON.stringify(request.messages).includes("CHILD-COMMIT")
    && !JSON.stringify(request.messages).includes("tool_result"));
  assert.ok(child, "子会话实际请求模型");
  assert.ok(JSON.stringify(child.system).includes(COMMIT_CONTENT_GUIDANCE));
  const issue = await f.create({ taskId: "issue", sessionId: "issue", knowledgeScope: "issue", additionalSystemInstructions: [] });
  await issue.start("分析问题");
  assert.ok(!JSON.stringify(f.model.requests.at(-1)!.system).includes(COMMIT_CONTENT_GUIDANCE));
});
