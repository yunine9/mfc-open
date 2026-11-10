import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueRetainedSession } from "../src/hostSessionContinuity.ts";
import { TaskService } from "../src/taskService.ts";
import { TaskHostLedger, createTaskHostTools } from "../src/taskHostTools.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-continuity-"));
  const service: any = new TaskService({ dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const summary = service.create("原需求，不需要每次重新阅读", { account: "owner" });
  const task = service.tasks.get(summary.id);
  task.summary.status = "running"; task.summary.waiting = undefined; task.cwd = summary.workspace;
  service.queue = [];
  let disposed = 0, stopped = 0;
  const messages: string[] = [];
  const driver: any = { isIdle: true, dispose: () => { disposed++; }, abort: async () => {},
    takeUndeliveredSteers: () => [], noteUserMessage: () => {}, continueWith: async (text: string) => { messages.push(text); return { status: "turn_finished" }; } };
  task.driver = driver;
  const container = { stop: async () => { stopped++; } };
  task.container = container;
  const runtime = service.taskHostRuntime.bind(service);
  service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args),
    cloneReference: async () => "/reference", syncBranch: async () => "已合并目标分支",
    verify: async () => ({ status: "passed" }),
    allowPush: async () => true, preparePush: async () => {}, confirmPush: async () => true,
    finishReviewAfterPush: async () => false, recordPublishedPush: () => {}, watchPush: () => {},
    push: async () => { assert.equal(task.driver, undefined); assert.equal(task.container, undefined);
      return { sha: "new-head", remote: "origin", ref: "refs/heads/work" }; },
  });
  const enqueue = (action: string, id = action) => new TaskHostLedger(task.summary).update({
    id, input: { action, reason: "按用户要求继续", repo: "repo" } as any,
    state: "queued", at: new Date().toISOString(), branch: "work", target_branch: "main", sha: "new-head",
  });
  const resume = async () => {
    service.settle = async (_: any, turn: Promise<unknown>) => { await turn; };
    task.summary.status = "running";
    await continueRetainedSession(task, task.controlEpoch, {
      launch: () => service.launch(task, task.controlEpoch), persist: () => service.persist(task),
      settle: turn => service.settle(task, turn, task.controlEpoch),
    });
  };
  t.after(async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, task, driver, container, enqueue, resume, messages,
    disposed: () => disposed, stopped: () => stopped };
}

for (const action of ["pull_repo", "sync_branch", "push", "retry_verification"]) {
  test(`${action} 返回后复用同一会话，只有工作树操作停容器`, async t => {
    const f = fixture(t), epoch = f.task.controlEpoch;
    const bound = f.service.taskHostRuntime(f.task, epoch);
    f.enqueue(action);
    assert.equal(await f.service.finishHostAction(f.task), true);
    assert.equal(f.task.summary.status, "queued");
    assert.equal(f.task.retainedSession.driver, f.driver);
    assert.equal(f.disposed(), 0); assert.equal(f.task.controlEpoch, epoch);
    assert.equal(f.stopped(), action === "pull_repo" ? 0 : 1);
    assert.doesNotThrow(() => bound.assertActive(), "下一轮的已绑定工具仍有执行权");
    await f.resume();
    assert.equal(f.task.driver, f.driver);
    assert.equal(f.task.retainedSession, undefined);
    assert.match(f.messages[0], /宿主操作.*succeeded/);
    assert.doesNotMatch(f.messages[0], /原需求|原 Pi 会话上下文已恢复|执行 current/);
  });
}

test("推送后交付由宿主接管时不再唤醒 Agent", async t => {
  const f = fixture(t), runtime = f.service.taskHostRuntime;
  let handoffs = 0;
  f.service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args),
    watchPush: () => { handoffs++; return true; },
  });
  f.enqueue("push");
  assert.equal(await f.service.finishHostAction(f.task), true);
  assert.equal(handoffs, 1);
  assert.equal(new TaskHostLedger(f.task.summary).read().operations.at(-1)?.state, "succeeded");
  assert.equal(f.service.queue.includes(f.task.summary.id), false);
  assert.equal(f.messages.length, 0);
});

test("目标登记不销毁会话或容器；明确重启才销毁", async t => {
  const f = fixture(t), epoch = f.task.controlEpoch;
  const host = f.service.taskHostRuntime(f.task);
  await host.release("set_target");
  host.resume("已登记目标", "改为新目标");
  await f.resume();
  assert.match(f.messages[0], /改为新目标/);
  assert.equal(f.task.container, f.container); assert.equal(f.stopped(), 0);
  f.enqueue("restart_session");
  await f.service.finishHostAction(f.task);
  assert.equal(f.disposed(), 1); assert.equal(f.stopped(), 1);
  assert.equal(f.task.retainedSession, undefined);
  assert.ok(f.task.controlEpoch > epoch);
});

test("旧会话的恢复路径操作完成兼容返回后保留容器和模型上下文", async t => {
  const f = fixture(t);
  const host = f.service.taskHostRuntime(f.task);
  await host.release("restore_delivery_paths");
  host.resume("文件选择机制已取消，无需恢复路径");
  await f.resume();
  assert.equal(f.task.container, f.container);
  assert.equal(f.task.driver, f.driver);
  assert.equal(f.stopped(), 0);
  assert.equal(f.disposed(), 0);
});

test("宿主操作失败仍把失败原文带回同一会话", async t => {
  const f = fixture(t), runtime = f.service.taskHostRuntime;
  f.service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args), cloneReference: async () => { throw new Error("远端 502"); } });
  f.enqueue("pull_repo"); await f.service.finishHostAction(f.task); await f.resume();
  assert.equal(f.disposed(), 0); assert.match(f.messages[0], /failed.*\n远端 502/);
});

test("操作期间插话先保存，完成后一次交回；并发调用不重复执行", async t => {
  const f = fixture(t), runtime = f.service.taskHostRuntime;
  let release!: () => void, began!: () => void, calls = 0;
  const started = new Promise<void>(r => { began = r; });
  const blocked = new Promise<void>(r => { release = r; });
  f.service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args), cloneReference: async () => { calls++; began(); await blocked; return "/reference"; } });
  f.enqueue("pull_repo"); const pending = f.service.finishHostAction(f.task); await started;
  const duplicate = f.service.finishHostAction(f.task);
  await f.service.interrupt(f.task.summary.id, "请保留协议兼容", "owner");
  assert.equal(f.messages.length, 0); release(); await Promise.all([pending, duplicate]);
  await f.resume(); assert.equal(calls, 1);
  assert.equal(f.messages[0].match(/请保留协议兼容/g)?.length, 1);
});

for (const action of ["pause", "cancel"]) test(`操作期间${action}不唤醒旧会话`, async t => {
  const f = fixture(t), runtime = f.service.taskHostRuntime;
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(r => { began = r; });
  const blocked = new Promise<void>(r => { release = r; });
  f.service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args), cloneReference: async () => { began(); await blocked; return "/reference"; } });
  f.enqueue("pull_repo"); const pending = f.service.finishHostAction(f.task); await started;
  await f.service[action](f.task.summary.id, "owner"); release(); await pending;
  assert.equal(f.task.summary.status, action === "pause" ? "paused" : "canceled");
  assert.equal(f.task.retainedSession, undefined); assert.equal(f.disposed(), 1);
  assert.equal(f.messages.length, 0);
});

test("推送卡等待和确认复用原会话", async t => {
  const f = fixture(t), runtime = f.service.taskHostRuntime;
  let confirmed = false;
  f.service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args), confirmPush: async () => {
    if (!confirmed) { f.task.summary.status = "waiting_for_human"; return false; } return true;
  } });
  f.enqueue("push"); await f.service.finishHostAction(f.task);
  assert.equal(f.task.retainedSession.driver, f.driver); assert.equal(f.disposed(), 0);
  confirmed = true; f.task.summary.status = "running";
  await f.service.finishHostAction(f.task); await f.resume();
  assert.equal(f.task.driver, f.driver); assert.equal(f.disposed(), 0);
});

test("未结束的模型/工具调用不能交出工作区", async t => {
  const f = fixture(t); f.driver.isIdle = false;
  await assert.rejects(f.service.taskHostRuntime(f.task).release("push"), /未完成的调用/);
  assert.equal(f.task.driver, f.driver); assert.equal(f.stopped(), 0);
});

test("停止在途验证已撤销旧执行权时，不复用旧工具绑定", async t => {
  const f = fixture(t), epoch = f.task.controlEpoch;
  f.task.prepushActive = Promise.resolve();
  f.service.stopPrePush = async () => { f.task.prepushActive = undefined; };
  f.enqueue("stop_verification");
  await f.service.finishHostAction(f.task);
  assert.equal(f.task.summary.status, "queued");
  assert.equal(f.task.retainedSession, undefined);
  assert.equal(f.disposed(), 1);
  assert.ok(f.task.controlEpoch > epoch);
});

test("宿主操作尚未完成时，即使已排队且有空槽也不启动会话", async t => {
  const f = fixture(t);
  const host = f.service.taskHostRuntime(f.task);
  await host.release("pull_repo");
  host.resume("关联仓结果待落盘");
  f.task.hostActionActive = Promise.resolve(true);
  f.service.options.maxConcurrent = 1;
  await f.service.pump();
  assert.equal(f.task.summary.status, "queued");
  assert.equal(f.messages.length, 0);
  assert.equal(f.task.driver, undefined);
  f.task.hostActionActive = undefined;
  f.service.options.maxConcurrent = 0;
});

test("真实 Pi 连续宿主操作：工具历史保留，只创建一次会话", async t => {
  const f = fixture(t);
  f.task.container = undefined; f.task.driver = undefined;
  const model = new ScriptedModelServer([
    { tool: { name: "read", input: { path: "evidence.txt" } } },
    { tool: { name: "task_control", input: { action: "pull_repo", reason: "读取接口", repo: "repo" } } },
    { text: "关联仓操作已排队" },
    { tool: { name: "task_context", input: { view: "overview" } } },
    { tool: { name: "task_control", input: { action: "pull_repo", reason: "补充参考", repo: "repo" } } },
    { text: "第二次关联仓操作已排队" },
    { text: "已沿用此前证据完成" },
  ], "scripted-v1", { linear: true });
  await model.start(); t.after(() => model.stop());
  const agentDir = join(f.root, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  writeFileSync(join(f.task.cwd, "evidence.txt"), "UNIQUE-EVIDENCE-395");
  const events = new EventLog(join(f.root, "events.jsonl"));
  const driver = await CloudSession.create({ taskId: f.task.summary.id, workspace: f.task.cwd, agentDir,
    provider: "maeflow", model: "scripted-v1", eventLog: events,
    transcript: new TranscriptStore(join(f.root, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace: f.task.cwd, cwd: f.task.cwd }), humanGate: f.task.humanGate,
    extraTools: createTaskHostTools(f.service.taskHostRuntime(f.task)),
  });
  f.task.driver = driver;
  f.task.summary.repo_url = "repo";
  const runtime = f.service.taskHostRuntime;
  let reads = 0;
  f.service.taskHostRuntime = (...args: any[]) => ({ ...runtime(...args), cloneReference: async () => {
    if (++reads === 1) await f.service.interrupt(f.task.summary.id, "新增要求：保留协议兼容", "owner");
    return "/reference";
  } });
  f.service.options.maxConcurrent = 1;
  f.service.runningCount = 1;
  f.service.launch = async () => { throw new Error("普通宿主操作不应重建会话"); };
  f.service.tryDeliver = async () => { f.task.summary.status = "verifying"; };
  await f.service.settle(f.task, driver.start("读取证据文件，并拉取关联仓。"), f.task.controlEpoch);
  f.service.runningCount--;
  await f.service.pump();
  const until = Date.now() + 8000;
  while (f.task.summary.status !== "verifying" && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.task.summary.status, "verifying", f.task.summary.detail);
  assert.equal(new TaskHostLedger(f.task.summary).read().operations.filter(op => op.state === "succeeded").length, 2);
  assert.equal(f.task.retainedSession, undefined, "正式等待验证时释放空闲会话");
  const recorded = events.replay();
  assert.equal(recorded.filter(e => e.kind === "session_started").length, 1);
  assert.equal(new Set(recorded.map(e => e.eventId)).size, recorded.length);
  assert.equal(recorded.filter(e => e.kind === "tool_requested" && e.payload.name === "Read").length, 1);
  assert.ok(recorded.some(e => e.kind === "tool_finished" && e.payload.name === "task_context" && !e.payload.is_error));
  assert.match(JSON.stringify(model.requests.at(-1)), /UNIQUE-EVIDENCE-395/);
  assert.match(JSON.stringify(model.requests.at(-1)), /新增要求：保留协议兼容/);
  assert.doesNotMatch(JSON.stringify(model.requests.at(-1)), /原 Pi 会话上下文已恢复/);
});
