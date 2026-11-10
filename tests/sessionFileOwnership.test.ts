/** Pi 的宿主 Write/Edit 与容器属主接缝：回调必须在工具报告成功前完成。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

async function run(script: Scene[], afterFileMutation: (path: string) => void) {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-owned-file-tool-"));
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const events = new EventLog(join(workspace, "events.jsonl"));
  const session = await CloudSession.create({
    taskId: "T-owned-file",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: events,
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace, cwd: workspace, failClosed: true }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    afterFileMutation,
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
    return { workspace, events: events.replay() };
  } finally {
    session.dispose();
    await model.stop();
  }
}

test("Write 与 Edit 成功结果返回前都完成容器属主修复", async () => {
  const repaired: string[] = [];
  const result = await run([
    { tool: { name: "write", input: {
      path: "src/message.txt", content: "before\n",
    } } },
    { tool: { name: "edit", input: {
      path: "src/message.txt",
      edits: [{ oldText: "before", newText: "after" }],
    } } },
    { text: "完成。" },
  ], (path) => { repaired.push(path); });
  assert.equal(readFileSync(join(result.workspace, "src/message.txt"), "utf-8"),
    "after\n");
  assert.deepEqual(repaired, [
    join(result.workspace, "src/message.txt"),
    join(result.workspace, "src/message.txt"),
  ]);
  const writes = result.events.filter((event) =>
    event.kind === "tool_finished"
    && ["Write", "Edit"].includes(String(event.payload.name)));
  assert.equal(writes.length, 2);
  assert.ok(writes.every((event) => !event.payload.is_error));
});

test("属主修复失败会把文件工具标成失败，不拖到下一次编译才暴露", async () => {
  const result = await run([
    { tool: { name: "write", input: {
      path: "src/message.txt", content: "content\n",
    } } },
    { text: "已看到工具失败。" },
  ], () => { throw new Error("fixture chown failed"); });
  const write = result.events.find((event) =>
    event.kind === "tool_finished" && event.payload.name === "Write");
  assert.equal(write?.payload.is_error, true);
  assert.match(String(write?.payload.result), /fixture chown failed/);
});
