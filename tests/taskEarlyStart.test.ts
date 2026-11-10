import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { concurrentTicketConflict, dependencyScheduleContext } from "../src/dependencyScheduling.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mfc-early-start-"));
  const options = { dataDir: join(dir, "tasks"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, host: { kernelRoot: join(process.cwd(), "kernel") } };
  const service = new TaskService(options);
  const state = (id: string) => (service as any).tasks.get(id);
  const persist = (id: string) => (service as any).persist(state(id), true);
  const parent = service.create("模块开发", { account: "owner", repos: [join(dir, "repo")], requirementAnalysis: true });
  const add = (label: string, blockedBy: string[] = [], ticket = "REQ1", repository = join(dir, "repo")) => service.create(label, {
    account: "developer", repo: repository, ticket, parentTaskId: parent.id, internalRequirement: true, blockedBy,
  });
  const a = add("A · 基础契约"), b = add("B · 订单同步", [a.id]), c = add("C · 查询模块", [b.id]), d = add("D · 独立报表", [c.id]);
  state(parent.id).summary.requirement_graph.stage = "confirmed";
  state(parent.id).summary.requirement_graph.repositories = [a,b,c,d].map((item, index) => ({
    id: `unit-${index}`, name: item.title, url: item.repo_url, ticket: item.ticket, task_id: item.id,
  }));
  state(parent.id).summary.status = "coordinating";
  state(a.id).summary.status = "await_merge";
  state(a.id).summary.delivery = { sha: "a".repeat(40), git_push: { sha: "a".repeat(40) }, mr_url: "https://example.test/mr/1", pipeline: "success" };
  [parent,a,b,c,d].forEach(item => persist(item.id));
  const preview = (ticket = "REQ2", release_ids?: string[]) => service.previewEarlyStart(d.id, "owner", { ticket, release_ids });
  const apply = (view = preview()) => service.startTaskEarly(d.id, "owner", { revision: view.revision, ticket: view.ticket, release_ids: view.release_ids });
  return { service, options, state, persist, parent, a,b,c,d, add, preview, apply };
}

test("长串行链提前开始：展示全部祖先和 AR 冲突，原任务、MR 和其余顺序保持不变", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const v = f.preview("REQ1");
  assert.deepEqual(v.no_longer_waiting.map(item => item.id), [f.a.id,f.b.id,f.c.id]);
  assert.deepEqual(v.conflicts.map(item => item.id), [f.a.id,f.b.id,f.c.id]);
  assert.throws(() => f.apply(v), /同仓任务/);
  const before = [f.a,f.b,f.c].map(item => structuredClone(f.state(item.id).summary));
  const createdCount = (f.service as any).tasks.size;
  const result = f.apply();
  assert.equal(result.status, "queued"); assert.equal(result.ticket, "REQ2"); assert.deepEqual(result.blocked_by, []);
  assert.equal((f.service as any).tasks.size, createdCount);
  [f.a,f.b,f.c].forEach((item, index) => assert.deepEqual(f.state(item.id).summary, before[index]));
  const graph = f.service.get(f.parent.id)!.requirement_graph!;
  assert.equal(graph.repositories.at(-1)!.ticket, "REQ2");
  assert.deepEqual(graph.dependencies.map(edge => [edge.from, edge.to]), [["unit-1","unit-0"],["unit-2","unit-1"]]);
  assert.equal(f.service.get(f.d.id)!.queue_position, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).blocked_by, [], "HTTP 必须显式清空旧依赖，避免前端增量合并留下旧值");
  assert.match(dependencyScheduleContext(result), /不再等待这些任务合入/);
  assert.match(dependencyScheduleContext(result), /当前 AR 单号：REQ2/);
  assert.equal(result.dependency_adjustments?.[0].by, "owner");
});

test("菱形依赖只解除所选等待，仍由另一条路径等待 A", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  f.state(f.c.id).summary.blocked_by = [f.a.id];
  f.state(f.d.id).summary.blocked_by = [f.b.id,f.c.id];
  const v = f.preview("REQ2", [f.b.id]);
  assert.deepEqual(v.no_longer_waiting.map(item => item.id), [f.b.id]);
  assert.deepEqual(v.remaining.map(item => item.id), [f.c.id]);
  const result = f.apply(v);
  assert.deepEqual(result.blocked_by, [f.c.id]); assert.match(result.detail!, /等待前置任务/);
});

test("不同仓可复用单号，同仓冲突不受父任务或责任人边界限制", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  f.state(f.d.id).summary.repo_url = `${f.a.repo_url}-other`;
  assert.equal(f.preview("REQ1").conflicts.length, 0);
  f.state(f.d.id).summary.repo_url = `${f.a.repo_url}.git/`;
  assert.equal(f.preview("REQ1").conflicts.length, 3, "仓库地址别名不能绕过同仓判断");
  const other = f.add("其他主任务的单元", [], "REQ2");
  f.state(other.id).summary.parent_task_id = undefined;
  f.state(other.id).summary.luban_account = "another-owner";
  assert.deepEqual(f.preview("REQ2").conflicts.map(item => item.id), [other.id]);
  f.state(other.id).summary.status = "completed";
  const projected = f.preview("REQ2");
  assert.equal(projected.conflicts.length, 0, "预览只读取持久化完成投影，不同步启动内核");
  assert.throws(() => f.service.startTaskEarly(f.d.id, "owner", {
    revision: projected.revision,
    ticket: projected.ticket,
    release_ids: projected.release_ids,
  }), /重新查看影响/, "仅写 completed 不能通过确认时的权威核验");
  (f.service as any).taskCompletionAttestation = (task: any) => task.summary.id === other.id ? { complete: true } : undefined;
  assert.equal(f.preview("REQ2").conflicts.length, 0, "核验完成的历史任务不占 AR");
});

test("提前开始预览只读完成投影，真正确认时仍执行权威完成核验", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  f.state(f.a.id).summary.status = "completed";
  f.persist(f.a.id);
  let attestations = 0;
  (f.service as any).dependencyCompleted = () => {
    attestations += 1;
    return true;
  };

  const view = f.service.previewEarlyStart(f.d.id, "owner", { ticket: "REQ2" });
  assert.equal(attestations, 0, "列表预览不能启动 Python 内核验签");

  f.service.startTaskEarly(f.d.id, "owner", {
    revision: view.revision,
    ticket: view.ticket,
    release_ids: view.release_ids,
  });
  assert.ok(attestations > 0, "真正改变执行安排前必须重新做权威核验");
});

test("越权、过期预览、空单号和已开工均不改变任何安排", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const v = f.preview();
  for (const actor of ["developer", "reviewer", "admin"]) {
    assert.equal(f.service.previewEarlyStart(f.d.id, actor).can_operate, false);
    assert.throws(() => f.service.startTaskEarly(f.d.id, actor, { revision:v.revision, ticket:v.ticket, release_ids:v.release_ids }), /主任务责任人/);
  }
  f.add("新增并行任务", [], "REQ3");
  assert.throws(() => f.apply(v), /重新查看影响/);
  assert.throws(() => f.apply(f.preview(" ")), /填写/);
  assert.throws(() => f.apply(f.preview("REQ 2")), /空白/);
  f.state(f.d.id).summary.status = "running";
  assert.equal(f.preview().available, false);
  assert.throws(() => f.apply(), /尚未开工/);
  assert.deepEqual(f.state(f.d.id).summary.blocked_by, [f.c.id]);
  assert.equal(f.state(f.d.id).summary.ticket, "REQ1");
});

test("落盘失败不解锁；重复请求、暂停和重启不丢新 AR 与依赖调整", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const v = f.preview();
  const original = (f.service as any).writeTaskState;
  (f.service as any).writeTaskState = () => { throw new Error("disk full"); };
  assert.throws(() => f.apply(v), /disk full/);
  assert.deepEqual(f.state(f.d.id).summary.blocked_by, [f.c.id]);
  (f.service as any).writeTaskState = original;
  f.apply(v); f.apply(v);
  assert.equal(f.state(f.d.id).summary.dependency_adjustments.length, 1);
  assert.equal((f.service as any).queue.filter((id: string) => id === f.d.id).length, 1);
  await f.service.pause(f.d.id, "developer");
  f.service.resume(f.d.id, "developer");
  const saved = JSON.parse(readFileSync(join(f.d.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.ticket, "REQ2"); assert.deepEqual(saved.summary.blocked_by, []);
  await f.service.shutdown();
  const restored = new TaskService(f.options); t.after(() => restored.shutdown()); restored.recover();
  assert.equal(restored.get(f.d.id)?.ticket, "REQ2"); assert.deepEqual(restored.get(f.d.id)?.blocked_by, []);
  assert.equal(restored.get(f.d.id)?.dependency_adjustments?.length, 1);
});

test("真实调度只启动已解锁 D，A 未合入时 B/C 继续等待", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const started: string[] = []; let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  (f.service as any).queue = [f.b.id,f.c.id,f.d.id];
  (f.service as any).launch = async (task: any) => { started.push(task.summary.id); await held; };
  (f.service as any).options.maxConcurrent = 1;
  f.apply();
  assert.deepEqual(started, [f.d.id]);
  assert.equal(f.service.get(f.d.id)?.status, "running");
  assert.equal(f.service.get(f.b.id)?.status, "queued"); assert.equal(f.service.get(f.c.id)?.status, "queued");
  (f.service as any).options.maxConcurrent = 0; finish();
});

test("HTTP 预览、责任人确认与单号修改走同一持久事务", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const auth = new LocalAuth(join(f.options.dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "test-password");
  auth.createUser("owner", "test-password", "developer");
  const server = createTaskServer(f.service, { auth });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string) => (await fetch(`${base}/auth/login`, {method:"POST", body:JSON.stringify({username,password:"test-password"})})).headers.get("set-cookie")!.split(";")[0];
  const owner = await login("owner"), admin = await login("admin");
  const call = (suffix:string, cookie:string, body:unknown) => fetch(`${base}/tasks/${f.d.id}/early-start${suffix}`, {method:"POST",headers:{cookie},body:JSON.stringify(body)});
  const preview = await call("/preview",owner,{ticket:"REQ2"}); assert.equal(preview.status,200);
  const v = await preview.json() as any;
  const input = {ticket:v.ticket, release_ids:v.release_ids, revision:v.revision};
  assert.equal((await call("",admin,input)).status,403);
  assert.equal((await call("",owner,{...input,revision:"old"})).status,409);
  const applied = await call("",owner,input); assert.equal(applied.status,200);
  assert.equal((await applied.json() as any).ticket,"REQ2");
  assert.equal((await call("",owner,input)).status,200);
  assert.equal(f.service.get(f.d.id)?.dependency_adjustments?.length,1);
});

test("中间节点的解除同时展示后继影响，后继同仓 AR 冲突也必须在确认前发现", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const e = f.add("E · 报表导出", [f.d.id]);
  const v = f.preview();
  assert.deepEqual(v.downstream.map(item => item.task.id), [e.id]);
  assert.deepEqual(v.downstream[0].no_longer_waiting.map(item => item.id).sort(), [f.a.id,f.b.id,f.c.id]);
  assert.deepEqual(v.downstream[0].conflicts.map(item => item.id).sort(), [f.a.id,f.b.id,f.c.id]);
  assert.throws(() => f.apply(v), /后续任务.*也会提前/);
  f.state(e.id).summary.ticket = "REQ3";
  const safe = f.preview(); assert.equal(safe.errors.length, 0);
  assert.match(safe.result, /后续任务也可能/);
  f.apply(safe);
  assert.deepEqual(f.state(e.id).summary.blocked_by, [f.d.id]);
  assert.deepEqual(f.state(f.d.id).summary.dependency_adjustments[0].downstream, [e.id]);
});

test("两个预览竞争同一 AR：先确认者生效，后确认者必须重新查看；已有工作目录不改动", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  f.state(f.d.id).summary.ticket = "REQ4";
  const v = f.preview();
  const c = f.service.previewEarlyStart(f.c.id, "owner", { ticket:"REQ2" });
  assert.equal(c.errors.length, 0);
  f.apply(v);
  assert.throws(() => f.service.startTaskEarly(f.c.id,"owner",{ticket:c.ticket,release_ids:c.release_ids,revision:c.revision}), /重新查看影响/);
  f.state(f.c.id).cwd = f.c.workspace + "/repo";
  assert.equal(f.service.previewEarlyStart(f.c.id,"owner").available,false);
  assert.equal(f.state(f.c.id).summary.ticket,"REQ1");
});


test("恢复出同号候选时不互锁：先就绪者占用 AR，其他任务等其完成", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const x = f.add("先恢复的任务", [], "REQ9"), y = f.add("后恢复的任务", [], "REQ9");
  const host = (f.service as any).dependencyHost(), queue = [x.id,y.id];
  assert.equal(concurrentTicketConflict(host, f.state(x.id), queue), undefined);
  assert.equal(concurrentTicketConflict(host, f.state(y.id), queue)?.summary.id, x.id);
  f.state(x.id).summary.status = "running";
  assert.equal(concurrentTicketConflict(host, f.state(y.id), [y.id])?.summary.id, x.id);
  host.completed = (task: any) => task?.summary.id === x.id;
  assert.equal(concurrentTicketConflict(host, f.state(y.id), [y.id]), undefined);
});


test("解锁前部署重启：未开工子任务仍可提前开始，恢复标记不等于已有执行现场", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  assert.equal(f.preview().available, true);
  await f.service.shutdown();
  const restored = new TaskService(f.options); t.after(() => restored.shutdown());
  restored.recover();
  const task = (restored as any).tasks.get(f.d.id);
  assert.equal(task.resume, true, "恢复入口仍保留正常续跑语义");
  assert.equal(task.cwd, undefined, "未开工子任务没有代码现场");
  const view = restored.previewEarlyStart(f.d.id, "owner", { ticket: "REQ2" });
  assert.equal(view.available, true, view.unavailable_reason);
  const count = (restored as any).tasks.size;
  const changed = restored.startTaskEarly(f.d.id, "owner", {
    revision: view.revision, release_ids: view.release_ids, ticket: view.ticket,
  });
  assert.equal(changed.id, f.d.id);
  assert.equal(changed.ticket, "REQ2");
  assert.deepEqual(changed.blocked_by, []);
  assert.equal((restored as any).tasks.size, count);
  assert.deepEqual(restored.get(f.c.id)?.blocked_by, [f.b.id]);
  const saved = JSON.parse(readFileSync(join(f.d.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.ticket, "REQ2");
  assert.deepEqual(saved.summary.blocked_by, []);
});

test("恢复标记可忽略，但真实现场、活动会话和交付事实仍禁止改号解锁", async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const task = f.state(f.d.id); task.resume = true;
  assert.equal(f.preview().available, true);
  for (const field of ["cwd", "driver", "container", "containerReopen", "prepushActive", "assistantActive"]) {
    task[field] = field === "cwd" ? join(f.d.workspace, "repo") : {};
    assert.equal(f.preview().available, false, field);
    assert.throws(() => f.apply(), /已有执行现场/);
    delete task[field];
  }
  for (const field of ["baseline_build", "delivery"]) {
    task.summary[field] = {};
    assert.equal(f.preview().available, false, field);
    assert.throws(() => f.apply(), /已有执行现场/);
    delete task.summary[field];
  }
  assert.equal(task.summary.ticket, "REQ1");
  assert.deepEqual(task.summary.blocked_by, [f.c.id]);
});
