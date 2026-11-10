/**
 * 重跑续推(run7 实测的运维刚需):
 * - 终态任务 POST /tasks/:id/retry → 重新入队,续跑后再次收口;
 * - 不存在的任务 → 404 原因明说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const SCRIPT: Scene[] = [{ text: "一步完成。" }];

async function until(
  probe: () => boolean, what: string, timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("终态任务可重跑续推;不存在的任务 404", async () => {
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-retry-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  const base = await new Promise<string>((ready) => {
    server.listen(0, "127.0.0.1", () => {
      ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  try {
    const created = service.create("演练:一步完成的任务");
    await until(() =>
      service.get(created.id)!.status === "completed", "首次收口");

    const retried = await fetch(`${base}/tasks/${created.id}/retry`,
      { method: "POST" });
    assert.equal(retried.status, 200);
    const body = await readJson(retried);
    assert.match(String(body.detail), /重跑/);
    await until(() =>
      service.get(created.id)!.status === "completed", "重跑后再次收口");

    const missing = await fetch(`${base}/tasks/task-99/retry`,
      { method: "POST" });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await model.stop();
  }
});
