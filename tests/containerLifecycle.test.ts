import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sweepManagedTaskContainers,
  taskContainerInstance,
} from "../src/containerRuntime.ts";
import { TaskService, type TaskContainerFactoryInput } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";

function input(workspace: string): TaskContainerFactoryInput {
  return {
    image: "fixture/builder:test",
    workspace,
    name: "mfc-fixture-task-1",
    volumes: [],
    limits: { user: "10001:10001" },
    options: {
      labels: {
        "com.mae-flow-cloud.role": "coding",
        "com.mae-flow-cloud.task": "task-1",
      },
    },
  };
}

test("shutdown 停止调度、drain 构建等待者并确认容器删除，但不改业务状态", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lifecycle-"));
  const containers = new FakeTaskContainerHarness();
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    prepush: { enabled: true, buildSlots: 1 },
    isolation: {
      image: "fixture/builder:test",
      containerFactory: containers.factory,
    },
  });
  const first = service.create("关机时保持排队状态");
  const second = service.create("关机时释放构建等待者");
  const firstState = (service as any).tasks.get(first.id);
  const secondState = (service as any).tasks.get(second.id);

  const container = (service as any).createTaskContainer(
    input(first.workspace));
  await container.start();
  firstState.container = container;
  const abort = new AbortController();
  let aborted = false;
  abort.signal.addEventListener("abort", () => { aborted = true; });
  firstState.prepushAbort = abort;

  const release = await (service as any).acquirePrePushBuildSlot(firstState, 0);
  assert.equal(typeof release, "function");
  const waiting = (service as any).acquirePrePushBuildSlot(secondState, 0);
  assert.equal((service as any).prePushBuildQueue.length, 1);

  let releaseOutbox!: () => void;
  const outboxWork = new Promise<void>((resolve) => {
    releaseOutbox = resolve;
  });
  firstState.reviewOutboxFlush = outboxWork.finally(() => {
    firstState.reviewOutboxFlush = undefined;
  });
  let shutdownDone = false;
  const shuttingDown = service.shutdown().then(() => {
    shutdownDone = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownDone, false,
    "shutdown 返回前必须等在途检视回复停止写平台与账本");
  releaseOutbox();
  await shuttingDown;
  assert.equal(await waiting, undefined, "排队的构建等待者必须在关机时被唤醒");
  assert.equal(aborted, true, "在途 prepush 宿主等待必须收到 abort");
  assert.equal(containers.records[0]?.stopped, true,
    "shutdown 返回前必须确认容器 stop 完成");
  assert.equal((service as any).activeContainers.size, 0);
  assert.equal(service.get(first.id)?.status, "queued");
  assert.equal(service.get(second.id)?.status, "queued");
  const persisted = JSON.parse(readFileSync(
    join(first.workspace, "task.json"), "utf-8"));
  assert.equal(persisted.summary.status, "queued",
    "优雅关闭不能把业务状态伪装成暂停/取消/失败");
  await assert.rejects(container.exec("true", first.workspace, {
    onData: () => undefined,
  }), /服务正在关闭，拒绝.*新的命令/);

  await service.shutdown();
  assert.equal(containers.records[0]?.stopCalls, 1, "重复 shutdown 必须幂等");
  release();
});

test("shutdown 清理失败的 AggregateError 保留容器定位信息与底层原因", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lifecycle-fail-"));
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    isolation: {
      image: "fixture/builder:test",
      containerFactory: (created) => ({
        metadata: {
          containerId: "a".repeat(64),
          name: created.name,
          imageReference: created.image,
          imageId: `sha256:${"b".repeat(64)}`,
          imageDigest: `sha256:${"b".repeat(64)}`,
          repoDigests: [],
          immutableImageReference: `sha256:${"b".repeat(64)}`,
          workspace: created.workspace,
          labels: created.options.labels ?? {},
          network: "bridge",
          readOnlyRoot: true,
          pidsLimit: 512,
          environmentKeys: [],
          mounts: [],
        },
        start: async () => undefined,
        exec: async () => ({ exitCode: 0 }),
        stop: async () => { throw new Error("docker rm: permission denied"); },
      }),
    },
  });
  const task = service.create("制造可定位的清理失败");
  const container = (service as any).createTaskContainer(input(task.workspace));
  await container.start();
  (service as any).tasks.get(task.id).container = container;
  await assert.rejects(service.shutdown(), (error: AggregateError) => {
    assert.match(error.message, /phase=remove-container/);
    assert.match(error.message, /role=coding/);
    assert.match(error.message, /name=mfc-fixture-task-1/);
    assert.match(error.message, /id=aaaaaaaaaaaa/);
    assert.match(error.message, /docker rm: permission denied/);
    return true;
  });
});

test("shutdown 与 docker start 竞态时先等启动落定再删除，不产生晚到孤儿", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lifecycle-start-race-"));
  const events: string[] = [];
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    isolation: {
      image: "fixture/builder:test",
      containerFactory: () => ({
        start: async () => {
          events.push("start-begin");
          await startGate;
          events.push("start-done");
        },
        exec: async () => ({ exitCode: 0 }),
        stop: async () => { events.push("stop"); },
      }),
    },
  });
  const workspace = mkdtempSync(join(tmpdir(), "mfc-start-race-work-"));
  const container = (service as any).createTaskContainer(input(workspace));
  const starting = container.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start-begin"]);
  const shuttingDown = service.shutdown();
  releaseStart();
  await assert.rejects(starting, /关闭期间.*已立即回收/);
  await shuttingDown;
  assert.deepEqual(events, ["start-begin", "start-done", "stop", "stop"],
    "关机 stop 必须发生在晚到的 start 完成之后；重复 stop 由真实运行时幂等");
  assert.equal((service as any).activeContainers.size, 0);
});

test("pause 清理期间收到 cancel，旧 pause 不得把 canceled 覆盖回 paused", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-pause-cancel-race-"));
  const service = new TaskService({
    dataDir, provider: "fixture", model: "fixture", modelsJson: {},
    maxConcurrent: 0,
  });
  const summary = service.create("暂停与取消竞态");
  const task = (service as any).tasks.get(summary.id);
  task.summary.status = "running";
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  let disposed = 0;
  task.driver = {
    abort: async () => undefined,
    dispose: () => { disposed += 1; },
  };
  task.container = { stop: async () => stopGate };

  assert.equal((await service.pause(summary.id, "tester")).status, "pausing");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const canceling = service.cancel(summary.id, "tester");
  releaseStop();
  await canceling;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(service.get(summary.id)?.status, "canceled");
  assert.match(service.get(summary.id)?.detail ?? "", /已由 tester 取消/);
  assert.equal(disposed, 1, "并发清理只能由最终拥有 driver 的一方 dispose");
});

test("暂停/取消不吞容器回收失败，并在未释放时禁止重跑", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-control-cleanup-fail-"));
  const service = new TaskService({
    dataDir, provider: "fixture", model: "fixture", modelsJson: {},
    maxConcurrent: 0,
  });
  const summary = service.create("控制动作清理失败");
  const task = (service as any).tasks.get(summary.id);
  task.summary.status = "running";
  let stopCalls = 0;
  task.container = {
    stop: async () => {
      stopCalls += 1;
      if (stopCalls < 3) throw new Error("docker daemon permission denied");
    },
  };
  assert.equal((await service.pause(summary.id, "tester")).status, "pausing");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(service.get(summary.id)?.status, "failed");
  assert.match(service.get(summary.id)?.detail ?? "",
    /暂停失败.*容器回收.*permission denied/);
  assert.throws(() => service.retry(summary.id), /执行资源尚未确认释放/);

  const canceled = await service.cancel(summary.id, "tester");
  assert.equal(canceled.status, "canceled");
  assert.match(canceled.detail ?? "", /未能确认释放.*permission denied/);
  assert.ok(task.container, "取消清理仍失败时必须保留句柄供再次重试");
  const retried = await service.cancel(summary.id, "tester");
  assert.equal(retried.status, "canceled");
  assert.equal(task.container, undefined, "再次取消成功后才清掉容器句柄");
});

