import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { TaskService } from "../src/taskService.ts";
import {
  modelTokenUsageSample,
  recordTokenUsage,
  restoreTokenUsageState,
  tokenUsageSnapshot,
} from "../src/tokenUsage.ts";

async function until(probe: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Token usage 只接受提供方真实值并兼容 Pi/网关字段", () => {
  assert.deepEqual(modelTokenUsageSample({
    usage: { input: 120, output: 35 },
  }, "main", "2026-08-23T08:00:00.000Z"), {
    input_tokens: 120,
    output_tokens: 35,
    at: "2026-08-23T08:00:00.000Z",
    session_id: "main",
  });
  const compatible = modelTokenUsageSample({
    usage: { input_tokens: 9, output_tokens: 3 },
  }, "child");
  assert.equal(compatible?.input_tokens, 9);
  assert.equal(compatible?.output_tokens, 3);
  assert.equal(compatible?.session_id, "child");
  assert.equal(modelTokenUsageSample({ content: "四个字" }, "main"), undefined,
    "没有 usage 时不得按字符数伪造 Token");
  assert.equal(modelTokenUsageSample({ usage: { input: 0, output: 0 } }, "main"),
    undefined);
});

test("累计值永久保留，速率只统计最近 60 秒", () => {
  let state = recordTokenUsage(undefined, {
    input_tokens: 100, output_tokens: 10,
    at: "2026-08-23T07:58:50.000Z", session_id: "main",
  });
  state = recordTokenUsage(state, {
    input_tokens: 50, output_tokens: 20,
    at: "2026-08-23T07:59:30.000Z", session_id: "child-1",
  });
  const snapshot = tokenUsageSnapshot(
    restoreTokenUsageState(JSON.parse(JSON.stringify(state))),
    Date.parse("2026-08-23T08:00:00.000Z"),
  );
  assert.deepEqual(snapshot, {
    input_tokens: 150,
    output_tokens: 30,
    total_tokens: 180,
    input_tokens_per_minute: 50,
    output_tokens_per_minute: 20,
    rate_window_seconds: 60,
    updated_at: "2026-08-23T07:59:30.000Z",
    source: "provider",
  });
});

test("Pi 主会话 message_end 会把真实 usage 交给统一旁路", async () => {
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), "mfc-token-session-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const samples: Array<{ input_tokens: number; output_tokens: number }> = [];
  const session = await CloudSession.create({
    taskId: "T-token", workspace: root, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: new EventLog(join(root, "events.jsonl")),
    transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    onTokenUsage: (usage) => samples.push(usage),
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished");
    assert.deepEqual(samples.map(({ input_tokens, output_tokens }) =>
      ({ input_tokens, output_tokens })), [{ input_tokens: 1, output_tokens: 1 }]);
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("任务级 Token 累计可实时投影并跨服务重启保留", async () => {
  const model = new ScriptedModelServer([{ text: "任务完成。" }]);
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-token-task-"));
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("统计本任务 Token").id;
  try {
    await until(() => service.get(id)?.status === "completed", "任务完成");
    const live = service.get(id)?.token_usage;
    assert.ok(live && live.input_tokens >= 1 && live.output_tokens >= 1);
    const saved = JSON.parse(readFileSync(join(dataDir, id, "task.json"), "utf-8"));
    assert.equal(saved.token_usage_state.input_tokens, live.input_tokens);
    assert.equal(saved.token_usage_state.output_tokens, live.output_tokens);

    await service.shutdown();
    const recovered = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    assert.equal(recovered.recover().restored, 1);
    assert.equal(recovered.get(id)?.token_usage?.input_tokens, live.input_tokens);
    assert.equal(recovered.get(id)?.token_usage?.output_tokens, live.output_tokens);
    await recovered.shutdown();
  } finally {
    await model.stop();
  }
});
