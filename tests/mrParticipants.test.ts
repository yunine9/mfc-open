import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { normalizeMrParticipants } from "../src/mrParticipants.ts";
import { readModuleMrParticipants, resolveModuleMrParticipants } from "../src/moduleMrParticipants.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { createMergeRequest } from "../src/mrClient.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { finishTaskHostOperation, TaskHostLedger } from "../src/taskHostTools.ts";

const people = { reviewers: ["l00000000"], approval_approvers: ["l00601498"] };
const repo = "https://git.example/team/a.git", repo2 = "https://git.example/team/b.git";

test("MR 人员按角色规范化，拒绝未知角色、null、分隔符和非账号值", () => {
  assert.deepEqual(normalizeMrParticipants({ reviewers: [" alice ", "alice", ""] }), { ...people, reviewers: ["alice"], approval_approvers: [] });
  for (const value of [null, [], "alice", { reviewers: null }, { reviewers: [1] }, { reviewers: ["alice,bob"] }, { assignees: [] }, { approval_reviewers: ["bob"] }]) {
    assert.throws(() => normalizeMrParticipants(value));
  }
});

test("模块全部关联仓共用一份人员，其他仓与知识模块不参与推导", t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-mr-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "owner", description: "订单模块", repositories: [repo, repo2], mr_participants: people }, "owner");
  assert.deepEqual(resolveModuleMrParticipants(dir, "orders", repo), people);
  assert.deepEqual(resolveModuleMrParticipants(dir, "orders", repo2), people);
  assert.equal(resolveModuleMrParticipants(dir, "orders", "https://git.example/reference.git"), undefined);
  assert.equal(resolveModuleMrParticipants(dir, undefined, repo), undefined);
  assert.deepEqual(readModuleMrParticipants(dir, "orders"), people);
  assert.equal(readModuleMrParticipants(dir, undefined), undefined);
  updateBusinessModule(dir, "orders", { mr_participants: { reviewers: ["new-reviewer"] } }, "owner");
  assert.deepEqual(resolveModuleMrParticipants(dir, "orders", repo2)?.reviewers, ["new-reviewer"]);
});

test("MR 已创建但人员失败仍保留链接；旧适配器不回结果不能伪报成功", async t => {
  const calls: Array<{ path: string; body: any; token: string | string[] | undefined }> = [];
  let legacy = false;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url!, body, token: req.headers["x-mfc-git-token"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 4, url: "https://code.example/merge_requests/4", ...(!legacy ? { participants: { status: "failed", message: "未配置创建参数" } } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const platformUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = { platformUrl, repo, sourceBranch: "feature", targetBranch: "main", title: "test", participants: people, credential: { username: "owner", password: "private-token" } };
  const receipt = await createMergeRequest(call);
  assert.equal(receipt.id, 4); assert.equal(receipt.participants?.status, "failed");
  assert.deepEqual(receipt.participants?.requested, people);
  assert.deepEqual(calls[0].body.participants, people);
  assert.equal(calls[0].token, "private-token");
  assert.ok(!JSON.stringify(calls[0].body).includes("private-token"));
  legacy = true;
  assert.equal((await createMergeRequest(call)).participants?.status, "failed");
});

test("宿主创建及复用 MR 时人员失败保持静默，继续流程且不自动补设", async t => {
  const calls: string[] = [];
  const failure = { status: "failed" as const, requested: people, message: "无人员配置权限" };
  const platform = createServer((req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 8, url: "https://code.example/merge_requests/8", participants: failure }));
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "mfc-host-mr-silent-"));
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(async () => {
    await service.shutdown(); platform.close(); platform.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  });
  const task = service.create("需求", { account: "owner", deferQueue: true });
  const state = (service as any).tasks.get(task.id);
  state.summary.repo_url = repo;
  state.summary.delivery = { git_push: { sha: "head", ref: "refs/heads/feature" } };
  const messages: string[] = [];
  let watches = 0;
  const host = { ...(service as any).taskHostRuntime(state),
    platformUrl: `http://127.0.0.1:${(platform.address() as { port: number }).port}`,
    release: async () => {}, watch: () => { watches++; }, resume: (message: string) => messages.push(message),
    mrTitle: () => "需求", mrParticipants: () => people,
  };
  const ledger = new TaskHostLedger(state.summary);
  for (const id of ["create", "reuse"]) {
    ledger.update({ id, state: "queued", at: new Date().toISOString(), input: { action: "create_mr", reason: "交付" },
      branch: "feature", target_branch: "main", sha: "head" });
    assert.equal(await finishTaskHostOperation(host), true);
    const operation = ledger.read().operations.at(-1)!;
    assert.equal(operation.state, "succeeded");
    assert.match(operation.result!, /https:\/\/code.example\/merge_requests\/8/);
    assert.doesNotMatch(operation.result!, /无人员配置权限|人员设置|补充人员|重试/);
    assert.deepEqual(state.summary.delivery.mr_participants, failure);
  }
  assert.deepEqual(calls, ["/mr"], "复用 MR 不自动重试人员设置");
  assert.equal(watches, 2);
  assert.equal(messages.length, 2);
  for (const message of messages) assert.doesNotMatch(message, /无人员配置权限|人员设置|补充人员/);
});

test("需求子任务创建 MR 直接传模块账号；旧人员补设入口已移除", async t => {
  const calls: Array<{ path: string; body: any }> = [];
  const platform = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 5, url: "https://code.example/merge_requests/5", participants: { status: "applied" } }));
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  t.after(() => { platform.close(); platform.closeAllConnections(); });
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-mr-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "owner", description: "订单模块", repositories: [repo, repo2], mr_participants: people }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, delivery: { platformUrl } });
  const parent = service.create("需求", { account: "owner", businessModuleId: "orders", deferQueue: true });
  const child = service.create("子任务", { account: "owner", parentTaskId: parent.id, deferQueue: true });
  const state = (service as any).tasks.get(child.id);
  state.summary.repo_url = repo2;
  const receipt = await (service as any).createDeliveryMr(state, { platformUrl, repo: repo2, sourceBranch: "feature", targetBranch: "main", title: "test" });
  assert.deepEqual(calls[0].body.participants, people);
  assert.deepEqual((service as any).taskHostRuntime(state).mrParticipants(), people);
  state.summary.delivery = { mr_url: receipt.url, mr_id: receipt.id, source_branch: "feature", target_branch: "main", mr_participants: receipt.participants };
  updateBusinessModule(dir, "orders", { mr_participants: { reviewers: ["later"] } }, "owner");
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("owner", "test-password"); auth.createUser("member", "test-password", "developer");
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const account of ["member", "owner"]) {
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: account, password: "test-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const response = await fetch(`${base}/tasks/${child.id}/mr-participants`, { method: "POST", headers: { cookie } });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(calls.map(item => item.path), ["/mr"]);
  assert.equal(service.get(child.id)?.delivery?.mr_participants?.status, "applied");
  const repeated = await (service as any).createDeliveryMr(state, { platformUrl, repo: repo2, sourceBranch: "feature", targetBranch: "main", title: "test" });
  assert.deepEqual(calls.at(-1)!.body.participants, { reviewers: ["later"], approval_approvers: [] });
  assert.equal(repeated.participants.status, "applied", "复用同一 MR 保留已经设置成功的事实");
});

test("需求同一分支对创建不同 MR 时仍带当前模块人员，不能借用旧 MR 的成功结果", async t => {
  const calls: any[] = [];
  const platform = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 6, url: "https://code.example/merge_requests/6",
      participants: { status: "failed", message: "新 MR 人员尚未设置" } }));
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  t.after(() => { platform.close(); platform.closeAllConnections(); });
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-new-mr-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const currentPeople = { reviewers: ["later"], approval_approvers: ["new-approver"] };
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "owner", description: "订单模块",
    repositories: [repo], mr_participants: currentPeople }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, delivery: { platformUrl } });
  const task = service.create("需求", { account: "owner", businessModuleId: "orders", deferQueue: true });
  const state = (service as any).tasks.get(task.id);
  state.summary.repo_url = repo;
  state.summary.delivery = { mr_url: "https://code.example/merge_requests/5", mr_id: 5,
    source_branch: "feature", target_branch: "main", mr_state: "closed",
    mr_participants: { status: "applied", requested: people } };
  const receipt = await (service as any).createDeliveryMr(state, {
    platformUrl, repo, sourceBranch: "feature", targetBranch: "main", title: "test",
  });
  assert.deepEqual(calls[0].participants, currentPeople);
  assert.equal(receipt.url, "https://code.example/merge_requests/6");
  assert.deepEqual(receipt.participants, {
    status: "failed", requested: currentPeople, message: "新 MR 人员尚未设置",
  });
});
