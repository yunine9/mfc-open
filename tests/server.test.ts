/**
 * 任务 API 端到端:真 pi 会话(进程内)+ 剧本假模型,经 HTTP 走完
 * 创建 → 等待人工 → 决定冲突(409)→ 决定生效 → 完成,并核对
 * SSE 事件流与现场文件。整链证据判定由 probe 的内核裁判负责,
 * 这里钉的是 API 语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

const SCRIPT: Scene[] = [
  { text: "先编译",
    tool: { name: "bash", input: { command: "echo BUILD SUCCESS" } } },
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "Diff 通过吗?",
                                   options: ["通过", "打回"],
                                   recommended: "通过" }] } } },
  { text: "COMPILE_RESULT: PASS 收口" },
];

async function until<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sseKinds(url: string, ms: number): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const kinds = new Set<string>();
    const request = get(url, (response) => {
      response.setEncoding("utf-8");
      response.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          kinds.add(String(JSON.parse(line.slice(6)).kind));
        }
      });
      response.on("end", () => resolve(kinds));
    });
    request.on("error", reject);
    setTimeout(() => {
      request.destroy();
      resolve(kinds);
    }, ms);
  });
}

test("任务 API 整链:等待人工/409 冲突/决定生效/SSE 镜像", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-api-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({ requirement: "交付 API-1:编译并检视" }),
    }).then((r) => readJson(r));
    assert.equal(created.status, "waiting_for_human");
    assert.equal(created.waiting.step, "cloud_requirement_analysis_confirm");
    const entryQuestion = created.waiting.question.questions[0].question;
    const entered = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        waiting_id: created.waiting.waiting_id,
        state_version: created.waiting.state_version,
        selected_options: {
          [entryQuestion]: "需求已确认，进入需求分析",
        },
      }),
    });
    assert.equal(entered.status, 200);

    const waiting = await until(async () => {
      const task = await fetch(`${base}/tasks/${created.id}`)
        .then((r) => readJson(r));
      return task.status === "waiting_for_human" ? task : undefined;
    }, "任务进入等待人工");
    assert.equal(
      waiting.waiting.question.questions[0].question, "Diff 通过吗?");

    // 后到决定(错误版本)必须 409,不覆盖先到。
    const conflict = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ state_version: 99, decision: "打回" }),
    });
    assert.equal(conflict.status, 409);

    const decided = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        waiting_id: waiting.waiting.waiting_id,
        state_version: waiting.waiting.state_version,
        decision: "通过",
        notes: "API 测试决定",
      }),
    });
    assert.equal(decided.status, 200);

    // 网络重试带稳定 waiting_id 且内容完全相同:幂等成功,不再把一次
    // 已经生效的点击翻译成“已由先到决定完成”。
    const replay = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        waiting_id: waiting.waiting.waiting_id,
        state_version: waiting.waiting.state_version,
        decision: "通过", notes: "API 测试决定",
      }),
    });
    assert.equal(replay.status, 200);

    const different = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        waiting_id: waiting.waiting.waiting_id,
        state_version: waiting.waiting.state_version,
        decision: "打回",
      }),
    });
    assert.equal(different.status, 409);
    const differentBody = await readJson(different);
    assert.doesNotMatch(differentBody.error,
      /任务状态已变化:\s*任务状态已变化/,
      "冲突提示不能把同一句前缀叠两遍");

    const done = await until(async () => {
      const task = await fetch(`${base}/tasks/${created.id}`)
        .then((r) => readJson(r));
      return task.status === "completed" ? task : undefined;
    }, "任务完成");
    assert.ok(existsSync(join(done.workspace, "transcript.jsonl")));

    const kinds = await sseKinds(`${base}/tasks/${created.id}/events`, 2000);
    for (const expected of
         ["user_message", "tool_finished", "human_decision", "turn_finished"]) {
      assert.ok(kinds.has(expected), `SSE 缺少 ${expected}`);
    }

    const listed = await fetch(`${base}/tasks`).then((r) => readJson(r));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "completed");
  } finally {
    server.close();
    await model.stop();
  }
});

/** SSE 原始行收集器:跨 TCP 分片重组,流结束(end)才 resolve。 */
function sseLines(url: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = "";
    const request = get(url, (response) => {
      response.setEncoding("utf-8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop()!;
        for (const part of parts) {
          if (part.startsWith("data: ")) lines.push(part.slice(6));
        }
      });
      response.on("end", () => resolve(lines));
    });
    request.on("error", reject);
  });
}

test("SSE 增量推送:只收新增、不重不丢、半行凑齐换行才出手", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-sse-"));
  // 剧本停在 AskUserQuestion:任务挂起期间事件日志归测试手动追加。
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion",
              input: { questions: [{ question: "继续吗?",
                                     options: ["继续", "停止"],
                                     recommended: "继续" }] } } },
    { text: "收口。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = service.create("演练:SSE 增量");
    const waiting = await until(async () => {
      const task = service.get(created.id)!;
      return task.status === "waiting_for_human" ? task : undefined;
    }, "任务挂起");
    const stream = sseLines(`${base}/tasks/${created.id}/events`);

    // 完整行 + 被写入方切成两半的行(含多字节汉字):半行阶段不许推,
    // 凑齐换行后必须原样完整到达。
    const path = service.eventLogPath(created.id);
    const whole = JSON.stringify({
      eventId: 9001, taskId: created.id, sessionId: "main",
      ts: "t", kind: "assistant_message", payload: { text: "整行事件" },
    });
    const split = JSON.stringify({
      eventId: 9002, taskId: created.id, sessionId: "main",
      ts: "t", kind: "assistant_message", payload: { text: "半行的汉字事件" },
    });
    appendFileSync(path, whole + "\n");
    const half = Buffer.from(split + "\n", "utf-8");
    appendFileSync(path, half.subarray(0, half.length - 9)); // 切在汉字中间
    await new Promise((r) => setTimeout(r, 700)); // 跨至少一拍轮询
    appendFileSync(path, half.subarray(half.length - 9));

    await service.decide(created.id, {
      state_version: waiting.waiting!.state_version, decision: "继续",
    });
    await until(async () =>
      service.get(created.id)!.status === "completed" ? true : undefined,
    "任务完成");
    const lines = await stream;

    // 每条都是完整可解析 JSON;手动追加的两条恰好各到一次;整体无重复。
    const ids = lines.map((line) => JSON.parse(line).eventId);
    assert.equal(ids.filter((id) => id === 9001).length, 1);
    assert.equal(ids.filter((id) => id === 9002).length, 1);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(
      parsed.find((row) => row.eventId === 9002).payload.text,
      "半行的汉字事件");
    assert.equal(new Set(lines).size, lines.length, "SSE 推送了重复行");
  } finally {
    server.close();
    await model.stop();
  }
});

test("现场面板路由:没有面板时说人话,有面板时原样呈现", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-panel-"));
  const model = new ScriptedModelServer([{ text: "开工即收工" }]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = service.create("演练:面板路由");
    await new Promise((r) => setTimeout(r, 500));
    const missing = await fetch(`${base}/tasks/${created.id}/panel`);
    assert.equal(missing.status, 404);
    assert.match((await readJson(missing)).error, /还没有现场面板/);

    // 内核会在任务工作区生成单文件面板;这里替它放一份。
    const workDir = join(created.workspace, ".mae-flow-work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "panel.html"), [
      "<h1>现场面板</h1>",
      '<span class="phase-node past">启动</span>',
      '<span class="phase-node current">澄清需求</span>',
      '<span class="phase-node future">定规格</span>',
    ].join(""));
    // 阶段顺序不再从 panel.html 抠,而是读内核 flow/phases.json 同一份词表;
    // 脉冲里的阶段名由内核按同一份文件算出。
    writeFileSync(join(workDir, "panel-pulse.js"),
      'window.__panelPulse={"phase":"澄清需求",'
      + '"step_title":"需求澄清(逐题拍板)","revision":8};');
    const page = await fetch(`${base}/tasks/${created.id}/panel`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /现场面板/);
    const progress = service.get(created.id)!.progress!;
    assert.deepEqual(progress.phases,
      ["启动", "澄清需求", "定规格", "写设计", "写代码", "检视与验证", "已合入"]);
    assert.equal(progress.current_index, 1);
    assert.equal(progress.step, "需求澄清(逐题拍板)");
    // build 里程碑是内核 append-only 旁路，只补充“正在做哪块”，不改
    // 阶段轨道；即使 pulse 本身没变化，sidecar 新事件也应刷新投影。
    writeFileSync(join(created.workspace, ".mae-flow.json.build-milestones"),
      JSON.stringify({ events: [{
        event: "started", task_id: "2", task_title: "接入库存接口",
        reason: "等待上游字段", at: "2026-08-20 10:00:00",
      }] }));
    writeFileSync(join(workDir, "panel-pulse.js"),
      'window.__panelPulse={"phase":"写代码","step":"build",'
      + '"step_title":"编码实现","revision":9};');
    const buildProgress = service.get(created.id)!.progress!;
    assert.deepEqual(buildProgress.milestone, {
      task_id: "2", title: "接入库存接口", event: "started",
      reason: "等待上游字段",
    });
    // 路由白名单:面板目录里的其他文件不放行。
    const sneak = await fetch(`${base}/tasks/${created.id}/secrets.txt`);
    assert.equal(sneak.status, 404);
  } finally {
    server.close();
    await model.stop();
  }
});
