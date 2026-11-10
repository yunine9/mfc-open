import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskService } from "../src/taskService.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { auxiliarySessionEpoch, trackAuxiliarySession, abortAuxiliarySessions } from "../src/auxiliarySessions.ts";
import { mfcTemp } from "./mfcTmp.ts";

for (const role of ["requirement-review", "warmup"] as const) {
  for (const action of ["cancel", "shutdown"] as const) {
    test(`${action} 中止真实 ${role} 会话；迟到的模型结果不能改写任务`, async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const model = new ScriptedModelServer([{ text: "迟到的模型结果" }], "scripted-v1", {
        linear: true, beforeScene: async () => { entered(); await held; },
      });
      await model.start();
      const service: any = new TaskService({
        dataDir: mfcTemp("mfc-aux-stop-"), maxConcurrent: 0,
        provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
      });
      const summary = service.create("原始需求", { account: "owner",
        requirementAnalysis: role === "requirement-review",
        requirementAnalysisConfirmation: role === "requirement-review" });
      const task = service.tasks.get(summary.id);
      const original = CloudSession.prototype.abort;
      let aborts = 0;
      CloudSession.prototype.abort = async function () { aborts++; await original.call(this); };
      let work: Promise<unknown> | undefined;
      try {
        if (role === "requirement-review") {
          const note = service.addAnnotation(summary.id, { author: "owner",
            artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
            anchor: "原始需求", note: "补充验收标准", kind: "doc" });
          work = service.sendAnnotations(summary.id, [note.id], "owner");
        } else {
          task.cwd = summary.workspace;
          task.summary.status = "running";
          task.summary.baseline_build = { status: "running", sha: "a".repeat(40), started_at: new Date().toISOString() };
          service.writeTaskState(task);
          work = service.runCloudWarmupAgent(task, { taskId: summary.id,
            workspace: summary.workspace, sha: "a".repeat(40) }, auxiliarySessionEpoch(task));
        }
        // 取消原文修订应拒绝原请求；立即挂接处理器，避免后台拒绝未消费。
        work = work!.catch((error) => error);
        await started;
        if (action === "cancel") await service.cancel(summary.id, "owner");
        else await service.shutdown();
        assert.ok(aborts > 0, "不能只停止主会话而漏掉独立会话");
        const persisted = readFileSync(join(summary.workspace, "task.json"), "utf-8");
        release();
        await work;
        // 原文修订通过后台队列消费，给 abort 导致的 promise 收尾一轮事件循环。
        await new Promise<void>((resolve) => setImmediate(resolve));
        const after = readFileSync(join(summary.workspace, "task.json"), "utf-8");
        if (action === "shutdown") assert.equal(after, persisted);
        else assert.deepEqual(JSON.parse(after).summary, JSON.parse(persisted).summary);
        assert.equal(model.requests.length, 1, "停止后不得再发起补交报告的模型请求");
        assert.equal(task.summary.requirement, "原始需求");
        if (action === "cancel") assert.equal(task.summary.status, "canceled");
        if (action === "cancel" && role === "warmup") assert.equal(task.summary.baseline_build.status, "infrastructure_failure");
      } finally {
        release();
        await work?.catch(() => undefined);
        CloudSession.prototype.abort = original;
        await service.shutdown();
        await model.stop();
      }
    });
  }
}

test("服务恢复时，遗留预热 running 必须改为中断，不能显示永远编译中", async () => {
  const dataDir = mfcTemp("mfc-warmup-recover-");
  const options = { dataDir, maxConcurrent: 0, provider: "test", model: "test", modelsJson: {} };
  const before: any = new TaskService(options);
  const summary = before.create("恢复预热事实");
  const task = before.tasks.get(summary.id);
  task.summary.baseline_build = { status: "running", sha: "a".repeat(40), started_at: new Date().toISOString() };
  before.writeTaskState(task);
  await before.shutdown();
  const after = new TaskService(options);
  try {
    after.recover();
    assert.equal(after.get(summary.id)?.baseline_build?.status, "infrastructure_failure");
    assert.match(after.get(summary.id)?.baseline_build?.detail ?? "", /尚未确认/);
  } finally { await after.shutdown(); }

  const issueOptions = { ...options, maxConcurrentTurns: 0 };
  const issueBefore: any = new IssueFlowService(issueOptions);
  const issue = issueBefore.create({ account: "owner", title: "恢复问题预热", description: "恢复", ticket: "DTS-RECOVER" });
  const live = issueBefore.live.get(issue.id);
  live.state.warmup = { status: "running", started_at: new Date().toISOString() };
  writeFileSync(join(live.root, "issue.json"), JSON.stringify(live.state));
  await issueBefore.shutdown();
  const issueAfter: any = new IssueFlowService(issueOptions);
  try {
    assert.equal(issueAfter.live.get(issue.id).state.warmup.status, "infrastructure_failure");
  } finally { await issueAfter.shutdown(); }
});

test("取消期间才创建完的辅助会话不能启动；明确恢复后可以注册新会话", async () => {
  const owner = {};
  const before = auxiliarySessionEpoch(owner);
  await abortAuxiliarySessions(owner);
  let disposed = 0;
  const late = { dispose: () => { disposed++; } } as CloudSession;
  assert.throws(() => trackAuxiliarySession(owner, late, before), /任务已停止/);
  assert.equal(disposed, 1);
  let aborted = 0;
  const fresh = { abort: async () => { aborted++; } } as CloudSession;
  trackAuxiliarySession(owner, fresh, auxiliarySessionEpoch(owner));
  await abortAuxiliarySessions(owner);
  assert.equal(aborted, 1);
});

test("已取消/暂停的任务，残留回调不得重开容器", async () => {
  const service: any = new TaskService({ dataDir: mfcTemp("mfc-stopped-container-"),
    maxConcurrent: 0, provider: "test", model: "test", modelsJson: {} });
  const summary = service.create("不允许复活容器");
  const task = service.tasks.get(summary.id);
  let reopened = 0;
  service.startCodingContainer = async () => { reopened++; return {}; };
  for (const status of ["canceled", "paused", "pausing"]) {
    task.summary.status = status;
    await assert.rejects(service.activeTaskContainer(task), /任务已停止/);
  }
  assert.equal(reopened, 0);
  await service.shutdown();
});

for (const role of ["main", "warmup"] as const) {
  for (const action of ["cancel", "shutdown"] as const) {
    test(`问题单 ${action} 中止真实 ${role} 会话，迟到结果不写入或续跑`, async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const model = new ScriptedModelServer([{ text: "迟到的结果" }], "scripted-v1", {
        linear: true, beforeScene: async () => { entered(); await held; },
      });
      await model.start();
      const service: any = new IssueFlowService({
        dataDir: mfcTemp("mfc-issue-aux-stop-"), maxConcurrentTurns: 0,
        provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
      });
      const summary = service.create({ account: "owner", title: "检查停止会话",
        description: "停止后不能继续执行", ticket: "DTS-AUX" });
      const live = service.live.get(summary.id);
      const work = role === "warmup" ? service.runWarmupSession(live, 60_000)
        : service.runTurn(live, async () => {
          const driver = await service.openDriver(live);
          return driver.start("请分析问题");
        }, live.controlEpoch);
      const original = CloudSession.prototype.abort;
      let aborts = 0;
      CloudSession.prototype.abort = async function () { aborts++; await original.call(this); };
      try {
        await started;
        if (action === "cancel") await service.control(summary.id, { action });
        else await service.shutdown();
        assert.ok(aborts > 0, "会话停止动作必须送到实际模型驱动");
        const persisted = readFileSync(join(live.root, "issue.json"), "utf-8");
        release();
        await work;
        assert.equal(readFileSync(join(live.root, "issue.json"), "utf-8"), persisted);
        assert.equal(model.requests.length, 1, "不能继续催办或补交报告");
      } finally {
        release();
        await work.catch(() => undefined);
        CloudSession.prototype.abort = original;
        await service.shutdown();
        await model.stop();
      }
    });
  }
}
