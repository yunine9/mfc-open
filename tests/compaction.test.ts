/** CloudSession 兼容与错误边界；真实容量场景见 sessionCompaction.test.ts。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { looksLikeBusyCollision, looksLikeContextOverflow } from "../src/sessionDriver.ts";
import { TaskService } from "../src/taskService.ts";

async function until(
  probe: () => boolean, what: string, timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("旧事件阈值不再强制压缩，小会话正常结束", async () => {
  // 历史配置保留解析兼容，但事件条数不再触发额外的摘要调用。
  const script: Scene[] = [
    { text: "干了一堆活",
      tool: { name: "bash", input: { command: "echo 干活" } } },
    { text: "收工。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-compact-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    compactEveryEvents: 1,          // 兼容旧调用，不再决定压缩
    log: (message) => logs.push(message),
  });
  try {
    const created = service.create("演练:压缩不打断流程");
    await until(() =>
      service.get(created.id)!.status === "completed", "任务收口");
    assert.ok(
      !logs.some((line) => line.includes("主动压缩")),
      `小会话不应因事件数压缩,日志: ${logs.join(" | ")}`);
  } finally {
    await model.stop();
  }
});

test("忙会话判据仅识别 Pi 拒收 prompt，不吞工具或服务忙错误", () => {
  assert.equal(looksLikeBusyCollision("Error: Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."), true);
  for (const detail of ["database is busy", "503 server busy", "Agent is already processing a broken file", "context_length_exceeded"]) {
    assert.equal(looksLikeBusyCollision(detail), false, detail);
  }
});

test("超限判据:认内网/各家网关的原文,别的错误一概不认", () => {
  // 判据宁可漏判也不许误判:把普通错误当超限去压缩,等于拿真错误
  // 当噪声吞掉。内网网关的原文是这条链上唯一见过的真样本,钉死。
  assert.ok(looksLikeContextOverflow(
    "CREATE INFERENCE REQ FAILED: Exception('input too long, exceed max "
    + "input length, max input length is 169984, current input length is "
    + "171308')"), "内网网关原文必须认");
  assert.ok(looksLikeContextOverflow("prompt is too long: 210000 tokens"));
  assert.ok(looksLikeContextOverflow(
    "This model's maximum context length is 128000 tokens"));
  assert.ok(looksLikeContextOverflow("context_length_exceeded"));
  for (const other of [
    "429 Too Many Requests: quota exhausted",
    "connect ECONNREFUSED 127.0.0.1:8080",
    "401 invalid api key",
    "500 internal server error",
  ]) {
    assert.ok(!looksLikeContextOverflow(other), `误判了: ${other}`);
  }
});

test("上下文撑爆:只补救一次，压不动如实失败", async () => {
  // 窗口配置高于网关时仍保留有限补救；极小历史没有可压缩内容，不能空转。
  const model = new ScriptedModelServer([{ text: "一步完成。" }]);
  await model.start();
  model.failWith(
    "CREATE INFERENCE REQ FAILED: Exception('input too long, exceed max "
    + "input length, max input length is 169984, current input length is "
    + "171308')", 5);            // 给足配额,看它会不会无限重试
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-overflow-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (message) => logs.push(message),
  });
  try {
    const created = service.create("演练:上下文撑爆");
    await until(() =>
      service.get(created.id)!.status === "failed", "压不动即如实失败");
    assert.ok(logs.some((line) => line.includes("上下文超限")),
      `没走自愈路径,日志: ${logs.join(" | ")}`);
    const detail = service.get(created.id)!.detail ?? "";
    assert.match(detail, /input too long/, "网关原文要留给人");
    assert.match(detail, /单轮输入过大/, "压不动的原因要说成人话");
    // 补救只许一次:一次原始请求 + 一次重发,远少于 5 次配额。
    assert.ok(model.requests.length <= 3,
      `补救次数失控,发了 ${model.requests.length} 次请求`);
  } finally {
    await model.stop();
  }
});

test("阈值未到不压;压缩失败也不影响收口(fail-open)", async () => {
  const quiet = new ScriptedModelServer([{ text: "一步完成。" }]);
  await quiet.start();
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-compact2-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: quiet.modelsJson(),
    compactEveryEvents: 999,        // 永远到不了
    log: (message) => logs.push(message),
  });
  try {
    const created = service.create("演练:不压也要正常收口");
    await until(() =>
      service.get(created.id)!.status === "completed", "任务收口");
    assert.ok(!logs.some((line) => line.includes("主动压缩")),
      "阈值未到不该压");
  } finally {
    await quiet.stop();
  }
});
