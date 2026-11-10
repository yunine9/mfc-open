import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { writeDeveloperAssistant } from "../src/developerAssistant.ts";
import { TaskHostLedger } from "../src/taskHostTools.ts";
import { TaskService } from "../src/taskService.ts";

const legacyFailure = "Agent 提前结束，内核当前步骤是 build，尚未到 delivery_watch";
const newFailure = "Agent 提前结束，内核当前步骤是 build，尚未进入宿主验证等待点（external_verify 或 delivery_watch）";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mfc-failed-early-pipeline-"));
  const options = { dataDir: join(root, "tasks"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };
  const service: any = new TaskService(options), services = [service];
  const summary = service.create("保留现场，继续完成需求", { account: "owner" });
  const task = service.tasks.get(summary.id);
  const cwd = join(summary.workspace, "repo"); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(join(cwd, "code.txt"), "已提交实现\n"); git("add", "code.txt"); git("commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, "local-note.txt"), "未提交现场也保留\n");
  const statePath = join(cwd, ".mae-flow.json");
  writeFileSync(statePath, JSON.stringify({ current: "build" }));
  task.cwd = cwd; task.summary.status = "failed"; task.summary.detail = legacyFailure;
  task.summary.waiting = undefined;
  task.summary.delivery = { sha, git_push: { sha, remote: "origin", ref: "refs/heads/work_REQ461" } };
  task.mission = "责任人要求保留已确认设计";
  task.pendingMainSteers = ["继续保留这条补充要求"];
  service.queue = [];
  const answer = task.humanGate.createWaiting({ taskId: summary.id, step: "story", callId: "confirmed-design",
    questionInput: { questions: [{ question: "确认设计", options: ["确认", "调整"] }] } });
  task.humanGate.resolve(answer.waiting_id, { stateVersion: answer.state_version, decision: "确认", notes: "沿用已确认设计" });
  const save = () => service.writeTaskState(task, true);
  const recover = (maxConcurrent = 0, launch?: (task: any) => Promise<void>) => {
    const restored: any = new TaskService({ ...options, maxConcurrent }); services.push(restored);
    if (launch) restored.launch = launch;
    let deliveries = 0;
    restored.tryDeliver = async () => { deliveries++; };
    const result = restored.recover();
    return { service: restored, task: restored.tasks.get(summary.id), result, deliveries: () => deliveries };
  };
  t.after(async () => { for (const item of services) await item.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { task, service, sha, cwd, statePath, save, recover, git };
}

test("服务启动自动调度旧失败任务，无需人工点击且不重复启动", async t => {
  const f = fixture(t); f.save();
  const starts: Array<{ id: string; cwd: string; resume: boolean; mission: string }> = [];
  const restored = f.recover(1, async task => {
    starts.push({ id: task.summary.id, cwd: task.cwd, resume: task.resume, mission: task.mission });
  });
  const deadline = Date.now() + 1000;
  while (!starts.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(starts.length, 1, "真实 recover → pump 自动调用 launch");
  assert.equal(starts[0].id, f.task.summary.id);
  assert.equal(starts[0].cwd, f.cwd); assert.equal(starts[0].resume, true);
  assert.match(starts[0].mission, /责任人要求保留已确认设计/);
  assert.match(starts[0].mission, /流水线尚无运行或查询失败不阻止 build done/);
  assert.equal(restored.task.summary.status, "running");
  assert.deepEqual(restored.service.queue, []);
  assert.deepEqual(restored.service.recover(), { restored: 0, requeued: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 1);
  assert.equal(restored.deliveries(), 0);
});

for (const pipeline of [undefined, "running", "not_found", "查询失败，正在重试", "failed:真实早期检查失败"]) {
  test(`部署后自动恢复旧 build 提前结束，保留验证事实（${pipeline ?? "无流水线投影"}）`, t => {
    const f = fixture(t);
    if (pipeline !== undefined) f.task.summary.delivery.pipeline = pipeline;
    f.save();
    const before = readFileSync(f.statePath, "utf8");
    const restored = f.recover(), live = restored.task;
    assert.equal(restored.result.requeued, 1);
    assert.deepEqual(restored.service.queue, [f.task.summary.id]);
    assert.equal(live.summary.status, "queued"); assert.equal(live.cwd, f.cwd);
    assert.equal(live.resume, true); assert.equal(f.git("rev-parse", "HEAD"), f.sha);
    assert.deepEqual(live.summary.delivery, f.task.summary.delivery);
    assert.equal(live.summary.delivery.mr_url, undefined);
    assert.equal(restored.deliveries(), 0, "恢复只继续当前步骤，不绕过后续交付创建 MR");
    assert.equal(readFileSync(f.statePath, "utf8"), before);
    assert.equal(readFileSync(join(f.cwd, "local-note.txt"), "utf8"), "未提交现场也保留\n");
    assert.deepEqual(live.pendingMainSteers, f.task.pendingMainSteers);
    assert.match(live.mission, /责任人要求保留已确认设计/);
    assert.match(live.mission, /流水线尚无运行或查询失败不阻止 build done/);
    assert.deepEqual(live.humanGate.all(), f.task.humanGate.all());
    const saved = JSON.parse(readFileSync(join(live.summary.workspace, "task.json"), "utf8"));
    assert.equal(saved.summary.status, "queued"); assert.equal(saved.mission, live.mission);
  });
}

test("恢复幂等：重复加载和再次重启不重复排队，修复后再次失败不自动复活", t => {
  const f = fixture(t); f.save();
  const first = f.recover();
  const mission = first.task.mission;
  assert.deepEqual(first.service.recover(), { restored: 0, requeued: 0 });
  assert.deepEqual(first.service.queue, [f.task.summary.id]);
  const second = f.recover();
  assert.equal(second.result.requeued, 1); assert.deepEqual(second.service.queue, [f.task.summary.id]);
  assert.equal(second.task.mission, mission, "第二次启动沿用已落盘的恢复目标");
  second.task.summary.status = "failed"; second.task.summary.detail = newFailure;
  second.service.writeTaskState(second.task, true);
  const third = f.recover();
  assert.equal(third.result.requeued, 0); assert.equal(third.task.summary.status, "failed");
  assert.deepEqual(third.service.queue, []);
});

const excluded: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ["普通执行失败", f => { f.task.summary.detail = "模型请求失败"; }],
  ["新版本提前结束", f => { f.task.summary.detail = newFailure; }],
  ["资源停止失败", f => { f.task.summary.detail += "；容器未停止"; }],
  ["已经取消", f => { f.task.summary.status = "canceled"; }],
  ["已经暂停", f => { f.task.summary.status = "paused"; }],
  ["明确暂停指令", f => { f.task.summary.control = { last_action: "pause", actor: "owner", at: new Date().toISOString() }; }],
  ["已经创建 MR", f => { f.task.summary.delivery.mr_url = "https://platform.invalid/mr/1"; }],
  ["仅保存 MR 编号", f => { f.task.summary.delivery.mr_id = 1; }],
  ["没有推送收据", f => { delete f.task.summary.delivery.git_push; }],
  ["已明确停摆", f => { f.task.summary.delivery.stalled = "等待人工处理权限问题"; }],
  ["内核已进入其他步骤", f => { writeFileSync(f.statePath, JSON.stringify({ current: "domain_archive" })); }],
  ["内核现场缺失", f => { rmSync(f.statePath); }],
  ["尚有人工问题", f => { f.task.humanGate.createWaiting({ taskId: f.task.summary.id, step: "build", callId: "unanswered",
    questionInput: { questions: [{ question: "处理范围仍有歧义", options: ["方案一", "方案二"] }] } }); }],
  ["开发助手接管中", f => { writeDeveloperAssistant(f.task.summary.workspace, { state: "working", messages: [] }); }],
  ["宿主操作尚未执行", f => { new TaskHostLedger(f.task.summary).update({ id: "pending", state: "queued",
    input: { action: "create_mr", reason: "明确发布请求" }, at: new Date().toISOString() }); }],
];
for (const [label, change] of excluded) test(`升级恢复不接管其他场景：${label}`, t => {
  const f = fixture(t); change(f); f.save();
  const originalStatus = f.task.summary.status;
  const restored = f.recover();
  assert.equal(restored.result.requeued, 0);
  assert.equal(restored.task.summary.status, originalStatus);
  assert.deepEqual(restored.service.queue, []);
  assert.equal(restored.deliveries(), 0);
});
