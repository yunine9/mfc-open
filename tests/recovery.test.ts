/**
 * 任务级恢复(§11):进程可死,任务不能死。
 *
 * Pi 原生会话保存上下文，流程恢复仍依据盘上事实:task.json(概要)、
 * waiting.json(待办)、events.jsonl(事件连续性)、transcript.jsonl
 * (工具行按 call_id join)。剧本:服务 A 把任务带到等待人工,
 * "崩溃"(丢弃服务 A);服务 B 在同一数据目录上 recover(),
 * 决定走重建会话续跑到完成。断言恢复语义,不是断言模型行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { PRE_PUSH_STATE_SCHEMA } from "../src/prePushVerification.ts";

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const LIFE_A: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "方案确认吗?",
                                   options: ["确认", "打回"],
                                   recommended: "确认" }] } } },
  { text: "不该走到这里:决定应由重建会话消费" },
];

const LIFE_B: Scene[] = [
  { text: "已收到用户答复,继续并完成任务。" },
];

test("服务在后台暂停期间重启，恢复为已暂停且不自动执行", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-pausing-"));
  const workspace = join(dataDir, "task-1");
  mkdirSync(workspace, { recursive: true });
  const control = {
    last_action: "pause", actor: "alice", paused_from: "running",
    at: new Date().toISOString(),
  } as const;
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    summary: {
      id: "task-1", requirement: "暂停过程中重启", workspace,
      status: "pausing", control, created_at: control.at,
    } satisfies TaskSummary,
  }));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  try {
    const result = service.recover();
    assert.equal(result.restored, 1);
    assert.equal(result.requeued, 0, "重启不能撤销用户的暂停决定");
    assert.equal(service.get("task-1")?.status, "paused");
    assert.deepEqual(service.get("task-1")?.control, control);
    const saved = JSON.parse(readFileSync(join(workspace, "task.json"), "utf-8"));
    assert.equal(saved.summary.status, "paused", "恢复结果应落盘");
    assert.equal(service.resume("task-1", "alice").status, "queued");
  } finally {
    await service.shutdown();
  }
});

test("恢复缺失 cwd 的在途任务：从唯一 Git 现场重绑并立刻持久化", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-cwd-"));
  const workspace = join(dataDir, "task-36");
  const cwd = join(workspace, "SWMExtFrontendService");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_review",
    config: { "基线分支": "master" },
    step_heads: { branch_create: git("rev-parse", "HEAD") },
  }));
  const gate = new HumanGate(join(workspace, "waiting.json"));
  const waiting = gate.createWaiting({
    taskId: "task-36", step: "最终代码增量检视", callId: "review-1",
    questionInput: { questions: [{
      question: "本轮修改是否通过？", options: ["通过", "调整"],
    }] },
  });
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    summary: {
      id: "task-36", requirement: "恢复工作区变更", workspace,
      repo_url: "https://example.test/team/SWMExtFrontendService.git",
      status: "waiting_for_human", waiting,
      created_at: "2026-09-04T00:00:00.000Z",
    } satisfies TaskSummary,
    cwd: null,
  }, null, 2));

  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {},
  });
  assert.equal(service.recover().restored, 1);
  assert.equal(service.artifactRoot("task-36"), realpathSync(cwd));
  const saved = JSON.parse(readFileSync(join(workspace, "task.json"), "utf-8"));
  assert.equal(saved.cwd, realpathSync(cwd),
    "修复后的 cwd 必须落盘，不能下次重启再丢");
});

test("恢复老任务时校正 repairing，且无 owner 的 prepush 不冒充运行中", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-repair-phase-"));
  const workspace = join(dataDir, "task-1");
  const taskPath = join(workspace, "task.json");
  const summary: TaskSummary = {
    id: "task-1",
    requirement: "恢复修复后的 prepush",
    workspace,
    status: "verifying",
    created_at: "2026-08-27T00:00:00.000Z",
    delivery: {
      loop: { round: 3, kind: "ci", state: "repairing" },
      prepush: {
        schema: PRE_PUSH_STATE_SCHEMA,
        state: "preparing",
        round: 4,
        message: "正在准备编译",
        sha: "abc123",
        workspace_fingerprint: "old-task",
        updated_at: "2026-08-27T01:00:00.000Z",
        checks: {
          compile: { state: "pending" },
          unit_test: { state: "pending" },
        },
      },
    },
  };
  mkdirSync(workspace, { recursive: true });
  writeFileSync(taskPath, JSON.stringify({ summary }, null, 2));

  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {},
  });
  assert.equal(service.recover().restored, 1);
  const restored = service.get("task-1")!;
  assert.equal(restored.delivery?.loop?.state, "verifying");
  assert.match(restored.focus?.headline ?? "", /中断.*没有.*执行会话/);
  assert.equal(restored.delivery?.prepush_runtime?.state, "interrupted");
  assert.match(restored.detail ?? "", /修复会话已完成/);
});

test("恢复已在等人的存量任务时，用 waiting 权威账修正旧 detail", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-waiting-detail-"));
  const workspace = join(dataDir, "task-1");
  const waiting = new HumanGate(join(workspace, "waiting.json")).createWaiting({
    taskId: "task-1",
    step: "grill",
    callId: "question-after-restart",
    questionInput: { questions: [{
      question: "请确认接口兼容范围",
      options: ["仅兼容当前版本", "同时兼容旧版本"],
    }] },
  });
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    summary: {
      id: "task-1",
      requirement: "恢复既有等待卡",
      workspace,
      status: "waiting_for_human",
      detail: "服务重启,等待续跑",
      waiting,
      created_at: "2026-09-04T00:00:00.000Z",
    } satisfies TaskSummary,
  }, null, 2));

  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {},
  });
  const recovered = service.recover();
  assert.equal(recovered.requeued, 0, "等人的任务不能因此重新烧模型");
  assert.equal(service.get("task-1")?.detail,
    "等待你回答：请确认接口兼容范围");
});

test("恢复续跑与普通提问都会刷新 detail，不残留服务重启文案", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-detail-"));
  const workspace = join(dataDir, "task-1");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    summary: {
      id: "task-1",
      requirement: "恢复后继续澄清需求",
      workspace,
      status: "running",
      detail: "重启前遗留的旧阶段文案",
      created_at: "2026-09-04T00:00:00.000Z",
    } satisfies TaskSummary,
  }, null, 2));

  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "恢复后采用哪个兼容方案？",
      options: ["保持旧协议", "升级新协议"],
      recommended: "保持旧协议",
    }] } } },
  ], "scripted-v1", {
    beforeScene: async ({ requestNumber }) => {
      if (requestNumber === 1) await responseGate;
    },
  });
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const recovered = service.recover();
  assert.equal(recovered.requeued, 1);

  const running = await until(() => {
    const task = service.get("task-1");
    return task?.status === "running" ? task : undefined;
  }, "恢复任务重新开始执行");
  assert.equal(running.detail, "Agent 已恢复并继续处理");

  releaseResponse!();
  const waiting = await until(() => {
    const task = service.get("task-1");
    return task?.status === "waiting_for_human" ? task : undefined;
  }, "恢复任务提出新问题");
  assert.equal(waiting.detail, "等待你回答：恢复后采用哪个兼容方案？");

  await service.shutdown();
  await model.stop();
});

test("恢复:等待人工的任务跨进程存活,决定走重建会话续跑", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-"));
  // ---- 前世:走到等待人工,然后"崩溃"----
  const modelA = new ScriptedModelServer(LIFE_A);
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(),
  });
  const created = serviceA.create("演练:恢复语义");
  const waiting = await until(
    () => {
      const task = serviceA.get(created.id);
      return task?.status === "waiting_for_human" ? task.waiting : undefined;
    }, "任务进入等待人工");
  await modelA.stop(); // 崩溃:旧模型、旧会话全部消失,只剩盘上事实

  // ---- 今生:同一数据目录上恢复 ----
  const modelB = new ScriptedModelServer(LIFE_B);
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(),
  });
  const recovered = serviceB.recover();
  assert.equal(recovered.restored, 1);
  assert.equal(recovered.requeued, 0); // 等人的任务原地等,不烧模型

  const restored = serviceB.get(created.id);
  assert.equal(restored?.status, "waiting_for_human");
  assert.equal(restored?.waiting?.waiting_id, waiting!.waiting_id);

  // 决定到来:无活会话可回注 → 入队重建会话续跑
  await serviceB.decide(created.id, {
    state_version: waiting!.state_version,
    decision: "确认",
    notes: "恢复测试",
  });
  const done: TaskSummary = await until(
    () => {
      const task = serviceB.get(created.id);
      return task?.status === "completed" ? task : undefined;
    }, "重建会话续跑到完成");
  assert.equal(done.status, "completed");

  // 盘上事实闭环:决定补登记的 tool_result 与前世的 tool_use 同 id join,
  // 事件 id 跨进程严格递增,重建会话以 resume:true 留痕。
  const workspace = join(dataDir, created.id);
  const rows = readFileSync(join(workspace, "transcript.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const blocks = rows.flatMap((row) =>
    Array.isArray(row.message?.content) ? row.message.content : []);
  const ask = blocks.find((block: any) =>
    block.type === "tool_use" && block.name === "AskUserQuestion");
  const result = blocks.find((block: any) =>
    block.type === "tool_result" && block.tool_use_id === ask?.id);
  assert.ok(ask, "前世的 tool_use 行还在");
  assert.ok(result, "决定的 tool_result 与前世 tool_use 按 call_id join");
  const events = readFileSync(join(workspace, "events.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const ids = events.map((event) => Number(event.eventId));
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]),
    "事件 id 跨进程严格递增");
  assert.ok(events.some((event) =>
    event.kind === "session_started" && event.payload?.resume === true),
    "重建会话以 resume:true 留痕");
  assert.ok(events.some((event) => event.kind === "session_started"
    && event.payload?.context_restored === true), "真正恢复主任务的 Pi 上下文");
  const restoredRequest = JSON.stringify(modelB.requests[0]);
  assert.match(restoredRequest, /方案确认吗/);
  assert.match(restoredRequest, /恢复测试/, "最新人工答复和补充说明进入原会话");
  assert.ok(events.some((event) => event.kind === "human_decision"),
    "人工决定进事件日志");
  await modelB.stop();
});

test("恢复重放同一提问 ID:已回答的卡直接回放,不再次等人", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-repeat-card-"));
  // 两个进程都跑同一剧本,因此重建会话会再次产生 scripted-1。
  // 这正是演示模型暴露出来、真实网关重试也可能撞到的幂等边界。
  const script: Scene[] = [
    { text: "先读取现场", tool: { name: "bash", input: { command: "echo ok" } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "方案确认吗?", options: ["确认", "打回"],
        recommended: "确认" },
    ] } } },
    { text: "决定已消费,正常收口。" },
  ];
  const modelA = new ScriptedModelServer(script);
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(),
  });
  const created = serviceA.create("演练:重复卡不得复活");
  const waiting = await until(() => {
    const task = serviceA.get(created.id);
    return task?.status === "waiting_for_human" ? task.waiting : undefined;
  }, "前一进程进入等待");
  await modelA.stop();

  const modelB = new ScriptedModelServer(script);
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(),
  });
  serviceB.recover();
  await serviceB.decide(created.id, {
    state_version: waiting!.state_version,
    decision: "确认",
  });
  const done = await until(() => {
    const task = serviceB.get(created.id);
    if (task?.status === "waiting_for_human") {
      throw new Error("已回答的同一张卡被重复展示");
    }
    return task?.status === "completed" ? task : undefined;
  }, "重放原决定后收口");
  assert.equal(done.waiting, undefined);
  await modelB.stop();
});

test("恢复重放同一提问 ID:已失效的旧卡返回工具错误,不再次挂起", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-superseded-card-"));
  const workspace = join(dataDir, "task-1");
  const gate = new HumanGate(join(workspace, "waiting.json"));
  const stale = gate.createWaiting({
    taskId: "task-1",
    step: "delivery_review",
    callId: "scripted-0",
    questionInput: { questions: [{
      question: "旧代码可以继续吗?", options: ["继续", "修改"],
      recommended: "继续",
    }] },
  });
  gate.supersede(stale.waiting_id, {
    stateVersion: stale.state_version,
    notes: "用户已接管并修改代码",
  });
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "旧代码可以继续吗?", options: ["继续", "修改"],
      recommended: "继续",
    }] } } },
    { text: "旧卡已失效，已重新读取现场并继续。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const created = service.create("演练:旧卡失效后不能复活");
  assert.equal(created.id, "task-1");
  const done = await until(() => {
    const task = service.get(created.id);
    if (task?.status === "waiting_for_human") {
      throw new Error("已失效的同一张卡被重复展示");
    }
    return task?.status === "completed" ? task : undefined;
  }, "失效卡作为工具错误返回后收口");
  assert.equal(done.waiting, undefined);
  const events = readFileSync(join(workspace, "events.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.kind === "tool_finished"
    && event.payload?.call_id === "scripted-0"
    && event.payload?.is_error === true),
  "失效卡必须作为可见工具错误回给 Agent，而不是静默吞掉");
  await service.shutdown();
  await model.stop();
});

test("恢复自愈:概要还在等人但 waiting 已 resolved,自动续跑", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-resolved-card-"));
  const modelA = new ScriptedModelServer(LIFE_A);
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(),
  });
  const created = serviceA.create("演练:旧版矛盾状态自动修复");
  const waiting = await until(() => {
    const task = serviceA.get(created.id);
    return task?.status === "waiting_for_human" ? task.waiting : undefined;
  }, "任务进入等待");
  await modelA.stop();

  // 模拟真实崩溃窗口:waiting.json 已有答案，task.json 仍保留 resolve
  // 之前的 waiting 副本。旧测试把 resolved 对象也塞进 task.json，反而
  // 绕开了线上真正会卡死的状态分叉。
  const workspace = join(dataDir, created.id);
  const annotation = serviceA.addAnnotation(created.id, {
    author: "developer", artifact: "Story", file: "story.md", line: 3,
    anchor: "关键流程", note: "恢复后也要把这条标成已送达", kind: "doc",
  });
  const annotationText = serviceA.previewAnnotations(created.id, [annotation.id]);
  new HumanGate(join(workspace, "waiting.json")).resolve(
    waiting!.waiting_id,
    {
      stateVersion: waiting!.state_version,
      decision: "确认",
      notes: annotationText,
      requestDigest: "resolved-before-task-projection",
      continuation: { annotation_ids: [annotation.id] },
    },
  );
  const taskPath = join(workspace, "task.json");
  const saved = JSON.parse(readFileSync(taskPath, "utf-8"));
  saved.summary.status = "waiting_for_human";
  saved.summary.waiting = waiting;
  writeFileSync(taskPath, JSON.stringify(saved, null, 1));

  const modelB = new ScriptedModelServer(LIFE_B);
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(),
  });
  const recovered = serviceB.recover();
  assert.equal(recovered.requeued, 1, "矛盾状态必须自动入队,不能继续催人");
  const done = await until(() =>
    serviceB.get(created.id)?.status === "completed"
      ? serviceB.get(created.id) : undefined, "自愈后收口");
  assert.equal(done?.waiting, undefined);
  assert.equal(serviceB.listAnnotations(created.id).items[0].status, "sent",
    "决定已落袋后恢复时也必须补齐批注送达投影");
  await modelB.stop();
});

/**
 * 用户实测撞到的丢话事故:批注随决定提交后,重建会话里的模型回来说
 * "你上次点了需要调整代码,但具体意见没有落盘",然后原地再问一遍。
 *
 * 查下来是真的:injectDecision 只把答复写进事件日志/transcript(我们的
 * 账)并经 posttooluse 交给内核,而内核那条通道只认结构化选项;
 * `messages` 看的是 UserPromptSubmit 捕获的普通用户消息,工具答复的
 * 正文不在里面。重建会话又没有挂起的工具调用可 resolve——于是选项到了、
 * 理由丢了。用户的话必须由我们自己送到模型眼前。
 */
test("恢复:决定的正文(批注/备注)必须随重建会话送到模型", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-notes-"));
  const modelA = new ScriptedModelServer(LIFE_A);
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(),
  });
  const created = serviceA.create("演练:决定正文不许丢");
  const waiting = await until(
    () => {
      const task = serviceA.get(created.id);
      return task?.status === "waiting_for_human" ? task.waiting : undefined;
    }, "任务进入等待人工");
  await modelA.stop();

  const modelB = new ScriptedModelServer(LIFE_B);
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(),
  });
  serviceB.recover();

  // 圈一条批注,随决定一起提交——正是用户实测的那条路径
  const note = serviceB.addAnnotation(created.id, {
    author: "developer", artifact: "未提交改动",
    file: "WebhookChannelHandler.java", line: 28,
    anchor: "\"webhook 已发送\"", note: "这里用英文,不要中文", kind: "code",
  });
  await serviceB.decide(created.id, {
    state_version: waiting!.state_version,
    decision: "打回",
    annotation_ids: [note.id],
  });
  await until(
    () => serviceB.get(created.id)?.status === "completed" || undefined,
    "重建会话续跑到完成");

  const seen = modelB.requests
    .flatMap((request) => (request as any).messages ?? [])
    .map((message: any) => JSON.stringify(message.content ?? ""))
    .join("\n");
  assert.match(seen, /这里用英文/, "批注正文必须出现在重建会话的上下文里");
  assert.match(seen, /以原文为准定位/, "那四条护栏也得跟着一起到");
  await modelB.stop();
});

/**
 * 插话有没有同样的洞?有,窗口小得多但性质一样:steer 把消息压在 pi 的
 * **进程内存**队列里,进程一死队列就没了。事件日志是唯一跨进程活下来的
 * 账,重建会话必须从它把没送到的话捞回来。
 *
 * 判据:最后一次 turn_finished 之后出现的插话,没有任何回合消化过它。
 * 回合跑到一半被杀时会把已送进上下文的那条也算成"没送到"——宁可重复
 * 也不能吞掉,重复顶多让模型多确认一句。
 */
test("恢复:重启前没送到的插话,重建会话要捞回来", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-steer-"));
  const modelA = new ScriptedModelServer([
    { text: "先看看", tool: { name: "bash", input: { command: "sleep 5" } } },
    { text: "不该走到这里" },
  ]);
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(),
  });
  const created = serviceA.create("演练:插话不许丢");
  await until(
    () => modelA.requests.length >= 1 ? true : undefined, "模型开跑");
  await serviceA.interrupt(created.id, "掩码要保留后四位");
  await modelA.stop();       // 崩溃:回合没跑完,内存队列随进程消失

  const modelB = new ScriptedModelServer(LIFE_B);
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(),
  });
  serviceB.recover();
  await until(
    () => serviceB.get(created.id)?.status === "completed" || undefined,
    "重建会话续跑到完成");

  const seen = modelB.requests
    .flatMap((request) => (request as any).messages ?? [])
    .map((message: any) => JSON.stringify(message.content ?? ""))
    .join("\n");
  assert.match(seen, /掩码要保留后四位/, "没送到的插话必须随重建会话补上");
  await modelB.stop();
});

test("queued 恢复复用 Git 现场，cwd 根目录占位不会导致重新 clone", async () => {
  for (const rootPlaceholder of [false, true]) {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-resume-existing-"));
    const workspace = join(dataDir, "task-16");
    const cwd = join(workspace, "FMEMateService");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "--quiet", cwd]);
    writeFileSync(join(cwd, "pending.txt"), "未提交的修改");
    writeFileSync(join(workspace, "task.json"), JSON.stringify({
      summary: { id: "task-16", requirement: "恢复", workspace, status: "failed",
        repo_url: "https://example.test/FMEMateService.git", created_at: new Date().toISOString() },
      cwd: rootPlaceholder ? workspace : cwd,
    }));
    const service = new TaskService({ dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {}, maxConcurrent: 0 });
    service.recover();
    const api = service as any;
    const task = api.tasks.get("task-16");
    assert.equal(realpathSync(task.cwd), realpathSync(cwd));
    task.summary.status = "paused";
    task.summary.control = { paused_from: "queued" };
    const returned = await service.returnDeveloperAssistant("task-16", "owner");
    assert.equal(returned.status, "queued");
    assert.equal(task.resume, false, "复现接管交回后 queued 的会话标志");
    if (rootPlaceholder) task.cwd = workspace; // 同进程失败也必须能重新发现。
    api.options.host = { kernelRoot: "unused" };
    let clones = 0, boundaries = 0;
    api.cloneRepo = async () => { clones++; throw new Error("不应重复 clone"); };
    api.hardenAgentGitBoundary = () => { if (++boundaries === 2) throw new Error("测试在复用仓库后停止，不启动模型或容器"); };
    await api.launch(task, task.controlEpoch);
    assert.equal(clones, 0);
    assert.equal(boundaries, 2);
    assert.equal(realpathSync(task.cwd), realpathSync(cwd));
    assert.equal(readFileSync(join(cwd, "pending.txt"), "utf8"), "未提交的修改");
  }
});
