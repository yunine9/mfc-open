/**
 * 并发语义(§9):等待人工的任务必须释放并发额度——审批可能挂几个
 * 小时,占着槽位就是把整条流水线堵死。5 个任务、上限 2:若等待占槽,
 * 第 3 个任务永远轮不到;全部到达等待即证明槽位在等待时归还。
 * 答复后全部完成,现场互不串场。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const SCRIPT: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "继续吗?",
                                   options: ["继续", "停"],
                                   recommended: "继续" }] } } },
  { text: "收到,完成。" },
];

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("并发:等待人工释放槽位,5 任务过 2 并发全部走完", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-conc-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 2,
  });
  const ids = Array.from({ length: 5 },
    (_, i) => service.create(`演练任务 ${i + 1}`).id);

  // 若等待占槽,只有前 2 个能到等待,这里必然超时。
  await until(
    () => ids.every(
      (id) => service.get(id)?.status === "waiting_for_human"),
    "5 个任务全部到达等待人工");

  for (const id of ids) {
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      decision: "继续",
    });
  }
  await until(
    () => ids.every((id) => service.get(id)?.status === "completed"),
    "全部任务完成");

  // 现场互不串场:每个任务有自己的事件日志与待办文件。
  for (const id of ids) {
    assert.ok(existsSync(join(dataDir, id, "events.jsonl")), `${id} 事件日志`);
    assert.ok(existsSync(join(dataDir, id, "waiting.json")), `${id} 待办文件`);
  }
  await model.stop();
});
