/**
 * 旁路故障不许带走服务(红线:agent 不能因 harness 卡死;旁路一律
 * fail-open)。
 *
 * 这一档是内网"serve 反复挂、一点错误输出都没有"逼出来的。死法本身很
 * 朴素:本仓到处是 `void 某个异步旁路()` 的即发即忘,而 Node 从 15 起
 * **没人接的 Promise rejection 默认终止进程**。于是 PG 抖一下、docker
 * 没了、平台 502、python 起不来,后果都是整台服务连着所有在跑的任务
 * 一起没——现场只留下"进程不见了",连栈都没有。
 *
 * 两条断言分工:
 * - 旁路抛了 → 任务照常走完,日志留一笔(fail-open,不是静默);
 * - 本轮收口自己抛了 → 任务如实 failed 并写明原因。进程级兜底只能
 *   让服务不死,不能让任务在页面上永远转圈——那是"哑",比"死"更难查。
 *
 * 用真的未处理 rejection 来验:测试进程若被这几个 void 打死,用例
 * 直接消失(node --test 会报 subprocess 退出),这比断言更硬。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const CARD: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "方案确认吗?", options: ["确认", "打回"],
    recommended: "确认",
  }] } },
};

async function settle(
  service: TaskService,
  id: string,
  accept: string[],
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (accept.includes(status)) return status;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return service.get(id)!.status;
}

test("投影整个炸了(PG 挂):任务照常收口,只留一笔账", async () => {
  const logs: string[] = [];
  const model = new ScriptedModelServer([{ text: "干完了。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-bypass-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (line) => logs.push(line),
    // 投影是"第二个状态机的镜子",不是真相:它全线拒绝服务也不该
    // 影响任何一个任务的结论(阶段真相只在工作区文件)。
    projection: {
      upsertTask: async () => { throw new Error("PG 连接被拒"); },
      appendEvent: async () => { throw new Error("PG 连接被拒"); },
      recordAction: async () => { throw new Error("PG 连接被拒"); },
    } as any,
  });
  const id = service.create("投影全挂演练").id;
  assert.equal(await settle(service, id, ["completed", "failed"]), "completed",
    "投影挂了不该影响任务结论");
  assert.ok(logs.some((line) => line.includes("旁路「投影")),
    `旁路故障要留痕,实际日志:\n${logs.join("\n")}`);
  await model.stop();
});

test("收口时抛异常:任务如实 failed 写明原因,服务不倒", async () => {
  const logs: string[] = [];
  const model = new ScriptedModelServer([CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-bypass-fail-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (line) => logs.push(line),
  });
  const id = service.create("收口抛异常演练").id;
  await settle(service, id, ["waiting_for_human"]);

  // 模拟"人点了通过之后这一轮炸了"(网关断线/内核起不来都长这样):
  // decide 那头是即发即忘,历史上这一抛就是整台服务的死因。
  const task = (service as any).tasks.get(id);
  task.driver.resumeWithDecision = async () => {
    throw new Error("模型网关连接被重置");
  };
  await service.decide(id, {
    state_version: service.get(id)!.waiting!.state_version,
    decision: "确认",
  });

  assert.equal(await settle(service, id, ["failed", "completed"]), "failed",
    "收口炸了要如实 failed,不能永远停在 running 让人干等");
  assert.match(service.get(id)!.detail ?? "", /模型网关连接被重置/);
  assert.ok(logs.some((line) => line.includes("收口时抛异常")),
    `要留一笔可查的账,实际日志:\n${logs.join("\n")}`);
  await model.stop();
});
