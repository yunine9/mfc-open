/**
 * 人工等待期间保留任务容器的语义契约。
 *
 * 等待是活会话的一部分，不能为了资源优化擅自把 HOME、/tmp 和容器身份
 * 换掉。真等待和自动交卷都必须保留原实例；只有异常缺失时的防御性重建
 * 才创建新容器，且仍不允许回退宿主执行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService, type TaskContainerFactoryInput } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";

function newService(containerFactory: any, log?: (message: string) => void) {
  return new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-idle-")),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    log,
    isolation: { image: "fixture/builder:test", containerFactory },
  });
}

/** 造一个"已在跑、容器已起"的任务,不经过真会话。 */
async function runningTask(service: any, requirement = "等人保留容器") {
  const created = service.create(requirement);
  const task = service.tasks.get(created.id);
  task.containerWorkspace = created.workspace;
  task.container = await service.startCodingContainer(task);
  return { created, task };
}

function waitingRecord(taskId: string, questions: unknown[]) {
  return {
    waiting_id: `${taskId}-w1`,
    task_id: taskId,
    step: "coding",
    call_id: "call-1",
    question: { questions },
    state_version: 1,
    status: "waiting" as const,
    decision: "",
    notes: "",
    created_at: new Date().toISOString(),
    resolved_at: "",
  };
}

test("真·等人时会话与原容器都保持不动", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { created, task } = await runningTask(service);
  // 会话是活的:pi 停在 AskUserQuestion 的 execute 里等决定。
  const driver = {
    marker: "live-session",
    abort: async () => undefined,
    dispose: () => undefined,
  };
  task.driver = driver;
  const original = task.container;

  await service.settleTurn(task, Promise.resolve({
    status: "waiting_for_human",
    // 没有 questions ⇒ autoAnswerFor 返回 undefined ⇒ 走真等人分支。
    waiting: waitingRecord(created.id, []),
  }));

  assert.equal(service.get(created.id)?.status, "waiting_for_human");
  assert.equal(containers.records[0]?.stopped, false, "等人期间不得回收容器");
  assert.equal(task.container, original, "审批前后必须还是同一个容器实例");
  assert.equal(task.driver, driver, "等待人工不能拆掉会话");
  await service.shutdown();
});

test("主 Coding 容器只读挂载稳定的 pipeline 材料目录", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { created } = await runningTask(service);
  const pipeline = join(created.workspace, "pipeline");

  assert.equal(existsSync(pipeline), true,
    "容器启动前必须创建 bind 源，后续流水线材料才能原地出现");
  assert.ok(containers.records[0]?.volumes.includes(
    `${pipeline}:${pipeline}:ro`),
  "主任务只获得 pipeline 子目录，且必须只读");
  assert.equal(containers.records[0]?.volumes.some((volume) =>
    volume === `${created.workspace}:${created.workspace}`
      || volume === `${created.workspace}:${created.workspace}:rw`), false,
  "不得把含 task.json、pi-agent 等控制数据的整个任务目录额外挂入");
  await service.shutdown();
});

test("主 Coding 容器读写挂载任务 reviews，Agent 可用 Bash 落逐条回执", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const created = service.create("检视回执目录挂载");
  const task = service.tasks.get(created.id);
  const repository = join(created.workspace, "repository");
  mkdirSync(repository);
  task.cwd = repository;
  task.containerWorkspace = repository;

  const container = await service.startCodingContainer(task);
  const reviews = join(created.workspace, "reviews");
  assert.equal(existsSync(reviews), true,
    "容器启动前必须由宿主创建 reviews bind 源");
  assert.ok(containers.records[0]?.volumes.includes(
    `${reviews}:${reviews}:rw`),
  "只挂任务自己的 reviews 子目录，允许 Bash 写 local-receipts.json");
  const replies = join(created.workspace, "review_replies.md");
  assert.ok(containers.records[0]?.volumes.includes(`${replies}:${replies}:rw`),
    "MR 回复也是仓外材料，只额外挂这一份文件");
  const prepush = join(created.workspace, "prepush");
  assert.ok(containers.records[0]?.volumes.includes(`${prepush}:${prepush}:ro`),
    "Build-Fix 记录只读，与提示词指向相同目录");
  assert.equal(containers.records[0]?.volumes.some((volume) =>
    volume === `${created.workspace}:${created.workspace}:rw`), false,
  "不得为写回执把整个任务控制目录交给容器");
  await container.stop();
  await service.shutdown();
});

test("机器反馈只把当前批次回执文件挂进容器，不暴露宿主反馈索引", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const created = service.create("机器反馈回执文件挂载");
  const task = service.tasks.get(created.id);
  const repository = join(created.workspace, "repository");
  mkdirSync(repository);
  task.cwd = repository;
  task.containerWorkspace = repository;
  const batchId = "fb-task-1-build-fix";
  writeFileSync(join(repository, ".mae-flow.json"), JSON.stringify({
    delivery_loop: {
      active_batch_id: batchId,
      batches: [{
        batch_id: batchId,
        items: [{ id: "build-fix:1", source: "build_fix" }],
      }],
    },
  }));

  const result = service.feedbackResultPath(task, batchId);
  const container = await service.startCodingContainer(task);
  assert.equal(existsSync(result), true, "容器启动前必须预创建精确回执文件");
  assert.equal(statSync(join(created.workspace, "feedback")).mode & 0o777, 0o711,
    "feedback 只开放路径穿越，不能给 Agent 目录写权限");
  assert.ok(containers.records[0]?.volumes.includes(`${result}:${result}:rw`),
    "只把当前批次 result 文件以 RW 方式挂给 Agent");
  const feedback = join(created.workspace, "feedback");
  assert.equal(containers.records[0]?.volumes.some((volume) =>
    volume === `${feedback}:${feedback}:rw`), false,
  "不能把含 index.jsonl 的 feedback 整目录交给 Agent");
  await container.stop();
  await service.shutdown();
});

test("开发助手容器不继承主任务的 pipeline 材料挂载", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const created = service.create("开发助手材料隔离");
  const task = service.tasks.get(created.id);
  task.containerWorkspace = created.workspace;
  const container = await service.startCodingContainer(task, {
    gitReadOnly: true,
    pipelineArtifacts: false,
  });

  assert.equal(containers.records[0]?.volumes.some((volume) =>
    volume.split(":")[1] === join(created.workspace, "pipeline")), false,
  "旁路开发助手没有读取流水线失败材料的职责");
  assert.equal(containers.records[0]?.volumes.some((volume) =>
    volume.split(":")[1] === join(created.workspace, "reviews")), false,
  "旁路开发助手也不能读取或改写主任务检视账");
  await container.stop();
  await service.shutdown();
});

test("自动交卷不释放容器:马上就要接着跑,别做停了再开的无用功", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { created, task } = await runningTask(service);
  // 有 questions + 下单预选答案 ⇒ autoAnswerFor 命中。
  service.autoAnswerFor = () => ({ why: "下单预选", answers: {}, notes: "" });
  service.autoDecide = async () => undefined;

  await service.settleTurn(task, Promise.resolve({
    status: "waiting_for_human",
    waiting: waitingRecord(created.id, [{ question: "选哪个", options: ["A"] }]),
  }));

  assert.equal(containers.records[0]?.stopped, false,
    "自动交卷路径不该释放容器");
  assert.equal(task.container !== undefined, true);
  await service.shutdown();
});

test("活会话异常缺失容器时防御性重建,挂载与限额保持一致", async () => {
  const seen: TaskContainerFactoryInput[] = [];
  const containers = new FakeTaskContainerHarness();
  const service: any = newService((input: TaskContainerFactoryInput) => {
    seen.push(input);
    return containers.factory(input);
  });
  const { task } = await runningTask(service);

  await task.container.stop();
  task.container = undefined;

  const reopened = await service.activeTaskContainer(task);
  assert.equal(task.container, reopened);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    { name: seen[1].name, workspace: seen[1].workspace, limits: seen[1].limits,
      volumes: seen[1].volumes, labels: seen[1].options.labels },
    { name: seen[0].name, workspace: seen[0].workspace, limits: seen[0].limits,
      volumes: seen[0].volumes, labels: seen[0].options.labels },
    "防御性重建不能悄悄换掉隔离参数");
  await service.shutdown();
});

test("一个回合里并发的多条 Bash 只开一个容器", async () => {
  let creations = 0;
  const containers = new FakeTaskContainerHarness();
  const service: any = newService((input: TaskContainerFactoryInput) => {
    creations += 1;
    return containers.factory(input);
  });
  const { task } = await runningTask(service);
  await task.container.stop();
  task.container = undefined;
  creations = 0;

  const all = await Promise.all([
    service.activeTaskContainer(task),
    service.activeTaskContainer(task),
    service.activeTaskContainer(task),
  ]);
  assert.equal(creations, 1, "并发重开只能创建一个容器");
  assert.equal(new Set(all).size, 1);
  await service.shutdown();
});

test("重开落定时任务已被暂停/取消,新容器就地回收不挂到任务上", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { task } = await runningTask(service);
  await task.container.stop();
  task.container = undefined;

  const pending = service.activeTaskContainer(task);
  task.controlEpoch += 1;          // 用户此刻按下暂停
  await assert.rejects(pending, /已暂停或取消/);
  assert.equal(task.container, undefined, "暂停后不许把容器挂回任务");
  assert.equal(containers.records.at(-1)?.stopped, true, "落单的容器必须自毁");
  await service.shutdown();
});

test("重开失败必须抛给这条 Bash,绝不落回宿主执行", async () => {
  let first = true;
  const service: any = newService(() => {
    if (first) {
      first = false;
      return { start: async () => undefined, exec: async () => ({ exitCode: 0 }),
        stop: async () => undefined };
    }
    return {
      start: async () => { throw new Error("镜像拉不到"); },
      exec: async () => ({ exitCode: 0 }),
      stop: async () => undefined,
    };
  });
  const { task } = await runningTask(service);
  await task.container.stop();
  task.container = undefined;

  await assert.rejects(service.activeTaskContainer(task), /镜像拉不到/);
  assert.equal(task.container, undefined);
  // 失败不能把重入锁焊死:环境恢复后下一条命令还得能再试。
  assert.equal(task.containerReopen, undefined);
  await service.shutdown();
});
