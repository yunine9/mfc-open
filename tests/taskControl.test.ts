import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { auxiliarySessionEpoch, trackAuxiliarySession } from "../src/auxiliarySessions.ts";

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test("任务控制:排队任务可暂停、恢复并取消，取消不可被陈旧队列项启动", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-queued-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("排队控制演练");
  assert.equal(service.get(created.id)?.status, "queued");
  assert.equal((await service.pause(created.id, "alice")).status, "paused");
  assert.equal(service.resume(created.id, "alice").status, "queued");
  assert.equal((await service.cancel(created.id, "alice")).status, "canceled");
  assert.equal(service.get(created.id)?.control?.actor, "alice");
});

test("任务控制:人工节点暂停后恢复到原决定卡", async () => {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      questions: [{ question: "继续吗?", options: ["继续", "停止"],
        recommended: "继续" }],
    } } },
    { text: "完成。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-waiting-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create("等待节点控制演练");
    await until(() => service.get(created.id)?.status === "waiting_for_human",
      "进入人工节点");
    const waitingId = service.get(created.id)?.waiting?.waiting_id;
    const paused = await service.pause(created.id, "alice");
    assert.equal(paused.status, "paused");
    assert.equal(paused.waiting?.waiting_id, waitingId, "暂停不丢决定卡");
    const resumed = service.resume(created.id, "alice");
    assert.equal(resumed.status, "waiting_for_human");
    assert.equal(resumed.waiting?.waiting_id, waitingId);
    assert.equal((await service.cancel(created.id, "alice")).status, "canceled");
  } finally {
    await model.stop();
  }
});

test("任务控制:验证中暂停只停止状态跟踪，恢复后继续跟踪原提交", async (t) => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-verifying-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("暂停流水线跟踪");
  const task = (service as any).tasks.get(created.id);
  task.summary.status = "verifying";
  task.summary.delivery = { sha: "a".repeat(40), pipeline: "running" };
  const poll = t.mock.method(service as any, "pollPipeline", async () => undefined);
  try {
    const paused = await service.pause(created.id, "alice");
    assert.equal(paused.status, "paused");
    assert.equal(paused.control?.paused_from, "verifying");
    assert.match(paused.detail ?? "", /外部流水线不会被中止/);
    assert.equal(poll.mock.callCount(), 0);
    const resumed = service.resume(created.id, "alice");
    assert.equal(resumed.status, "verifying");
    assert.equal(resumed.delivery?.sha, "a".repeat(40));
    assert.equal(poll.mock.callCount(), 1);
  } finally {
    await service.shutdown();
  }
});

test("选择题选项都不合适时，自定义答复作为主答案继续而非强迫选错", async () => {
  const question = "如何处理平台生成的本地文件?";
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      questions: [{ question, options: ["提交到业务仓", "暂停等用户处理"],
        recommended: "提交到业务仓" }],
    } } },
    { text: "已按用户给出的第三种方式继续。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-custom-answer-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create("不完整选项自由回复演练");
    await until(() => service.get(created.id)?.status === "waiting_for_human",
      "进入不完整选项卡");
    const waiting = service.get(created.id)!.waiting!;
    await service.decide(created.id, {
      state_version: waiting.state_version,
      selected_options: {},
      free_responses: {
        [question]: "都不提交；写入 .git/info/exclude 后继续",
      },
    });
    await until(() => service.get(created.id)?.status === "completed",
      "自由主答案回注后继续");
  } finally {
    await model.stop();
  }
});

test("任务控制:没有回合结束事件也立即中止并暂停，恢复后可续跑，取消不被旧回调覆盖", async (t) => {
  let releaseModel!: () => void;
  const heldModel = new Promise<void>((resolve) => { releaseModel = resolve; });
  const model = new ScriptedModelServer([
    { text: "完成。" },
  ], "scripted-v1", {
    beforeScene: ({ requestNumber }) => requestNumber === 1 ? heldModel : undefined,
  });
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-running-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 1,
  });
  try {
    const resumable = service.create("执行中暂停演练");
    await until(() => model.requests.length > 0, "模型开始执行");
    const task = (service as any).tasks.get(resumable.id);
    const abort = t.mock.method(task.driver, "abort");
    assert.equal(model.served.length, 0, "模型仍未返回，不能依赖回合结束事件");
    const requested = await service.pause(resumable.id, "alice");
    assert.equal(requested.status, "pausing");
    assert.equal(abort.mock.callCount(), 1, "暂停必须主动中止正在运行的会话");
    await until(() => service.get(resumable.id)?.status === "paused", "立即暂停", 2_000);
    assert.equal(model.served.length, 0, "未释放模型响应也应完成暂停");
    releaseModel();
    service.resume(resumable.id, "alice");
    await until(() => service.get(resumable.id)?.status === "completed", "恢复后收口");

    const cancelModel = new ScriptedModelServer([
      { tool: { name: "bash", input: { command: "sleep 0.5" } } },
      { text: "本不应覆盖取消。" },
    ]);
    await cancelModel.start();
    const cancelService = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-control-cancel-")),
      provider: "maeflow", model: "scripted-v1",
      modelsJson: cancelModel.modelsJson(), maxConcurrent: 1,
    });
    try {
      const canceled = cancelService.create("执行中取消演练");
      await until(() => cancelModel.requests.length > 0, "取消任务开始执行");
      assert.equal((await cancelService.cancel(canceled.id, "alice")).status,
        "canceled");
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(cancelService.get(canceled.id)?.status, "canceled",
        "旧的模型回调不得把取消覆盖成完成或失败");
    } finally {
      await cancelModel.stop();
    }
  } finally {
    releaseModel();
    await service.shutdown();
    await model.stop();
  }
});

for (const prepush of [false, true]) {
  test(`${prepush ? "推送前构建" : "普通运行任务"}暂停先返回处理中，慢容器清理不阻塞控制请求`, async () => {
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-control-prepush-pause-")),
      provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    });
    const created = service.create("慢构建暂停反馈");
    const task = (service as any).tasks.get(created.id);
    task.summary.status = "running";
    if (prepush) task.summary.delivery = { prepush: { active_attempt: { id: "attempt-1" } } };
    const oldEpoch = task.controlEpoch;
    const host = (service as any).taskHostRuntime(task, oldEpoch);
    let finishTurn!: (outcome: { status: "turn_finished" }) => void;
    const lateTurn = (service as any).settleTurn(task,
      new Promise((resolve) => { finishTurn = resolve; }), oldEpoch);
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stops = 0, aborts = 0, auxiliaryAborts = 0;
    task.container = { stop: async () => { stops += 1; await stopGate; } };
    task.driver = { abort: async () => { aborts += 1; }, dispose: () => undefined };
    trackAuxiliarySession(task, { abort: async () => { auxiliaryAborts += 1; } } as any,
      auxiliarySessionEpoch(task));
    const prepushAbort = task.prepushAbort = new AbortController();

    try {
      const requested = await service.pause(created.id, "alice");
      assert.equal(requested.status, "pausing",
        "容器清理仍在等待时，控制请求应立即确认正在暂停");
      assert.equal(service.get(created.id)?.status, "pausing");
      assert.equal(stops, 1, "返回控制请求前已开始回收容器");
      assert.equal(aborts, 1);
      assert.equal(auxiliaryAborts, 1, "独立辅助会话也必须停止");
      assert.equal(prepushAbort.signal.aborted, true);
      assert.equal((service as any).queue.includes(created.id), false);
      assert.throws(() => host.assertActive(), /任务正在暂停/);
      assert.equal((service as any).current(task, oldEpoch), false,
        "暂停请求一到，旧会话就必须失去执行权");

      releaseStop();
      await until(() => service.get(created.id)?.status === "paused", "后台安全暂停收口");
      assert.throws(() => host.assertActive(), /任务已暂停/);
      finishTurn({ status: "turn_finished" });
      await lateTurn;
      assert.equal(service.get(created.id)?.status, "paused", "迟到的回合结束不得改写暂停结果");
      service.resume(created.id, "alice");
      assert.throws(() => host.assertActive(), /任务执行权已变化/,
        "恢复后的新会话不应重新授权旧会话");
    } finally {
      releaseStop();
      finishTurn({ status: "turn_finished" });
      await lateTurn;
      await service.shutdown();
    }
  });
}
