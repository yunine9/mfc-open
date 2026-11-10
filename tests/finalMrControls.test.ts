import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readDeveloperAssistant, writeDeveloperAssistant } from "../src/developerAssistant.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

const repo = "https://code.example/org/repo.git";
const mr = (id: number) => `https://code.example/org/repo/-/merge_requests/${id}`;
const source = { url: mr(2), id: "2", repo, source_branch: "local", target_branch: "main", state: "opened" as const };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-final-mr-controls-"));
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {},
    maxConcurrent: 0, isolation: { image: "test" } });
  const { id, workspace } = service.create("实现功能");
  const task = (service as any).tasks.get(id);
  task.cwd = workspace;
  task.summary.status = "paused";
  task.summary.delivery = { mr_url: mr(1), mr_id: 1 };
  t.after(async () => { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { service, task, id, workspace };
}

test("已关联最终 MR 的验证中和遗留暂停任务：开发助手只读，HTTP 拒绝接管且不写入留言", async t => {
  const { service, task, id, workspace } = fixture(t);
  task.summary.status = "verifying";
  assert.equal(service.developerAssistant(id).availability.available, true);
  task.summary.delivery.final_mr = source;
  const server = createTaskServer(service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${address.port}/tasks/${id}/developer-assistant`;
  writeDeveloperAssistant(workspace, { state: "ready", messages: [] });
  const file = join(workspace, "developer-assistant.json");
  const before = readFileSync(file, "utf8");
  for (const status of ["verifying", "paused"]) {
    task.summary.status = status;
    const view = await fetch(url);
    assert.equal(view.status, 200);
    const { availability } = await view.json() as any;
    assert.equal(availability.available, false);
    assert.equal(availability.code, "not_editable");
    assert.match(availability.reason, /已关联最终 MR.*本地修改/);
    for (const path of ["", "/interrupt", "/return"]) {
      const reply = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "接管并继续改代码" }) });
      assert.equal(reply.status, 409);
      assert.equal((await reply.json() as any).error, availability.reason);
    }
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(task.summary.status, status);
  }
});

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { release, wait };
}

for (const action of ["停止动作", "交还容器", "等待助手结束后交还"] as const) {
  test(`${action}期间关联最终 MR，旧请求不能回写接管状态`, async t => {
    const { service, task, id, workspace } = fixture(t);
    const held = deferred(), linkCleaning = deferred();
    const waitingTurn = action === "等待助手结束后交还";
    writeDeveloperAssistant(workspace, { state: action === "停止动作" ? "working" : "ready", messages: [] });
    task.assistantActive = waitingTurn ? held.wait : undefined;
    let stops = 0;
    task.container = { stop() {
      if (++stops === (waitingTurn ? 1 : 2)) linkCleaning.release();
      return held.wait;
    } };
    t.mock.method(service as any, "readFinalMr", async () => ({ ...source, iid: source.id }));
    const cleanup = action === "停止动作"
      ? service.stopDeveloperAssistant(id, "alice") : service.returnDeveloperAssistant(id, "alice");
    const rejected = assert.rejects(cleanup, /已关联最终 MR/);
    const linking = service.linkFinalMr(id, mr(2));
    await linkCleaning.wait;
    const atLink = readDeveloperAssistant(workspace);
    held.release();
    await Promise.all([linking, rejected]);
    assert.deepEqual(readDeveloperAssistant(workspace), atLink);
    assert.equal(task.summary.status, "await_merge");
    assert.equal(task.summary.delivery.final_mr.url, mr(2));
  });
}

test("最终 MR 合入待登记：禁止改绑，同一链接只补查版本，晚到的开放状态不能撤销合入", async t => {
  const { service, task, id } = fixture(t);
  task.summary.status = "verifying";
  const mergedAt = "2026-09-02T10:00:00.000Z";
  task.summary.delivery.final_mr = { ...source, state: "merged", merged_at: mergedAt };
  const detail = t.mock.method(service as any, "readFinalMr", async () => ({ ...source, iid: source.id }));
  await assert.rejects(service.linkFinalMr(id, mr(3)), /最终 MR 已合入/);
  assert.equal(detail.mock.callCount(), 0);
  const refreshed = await service.linkFinalMr(id, mr(2));
  assert.equal(detail.mock.callCount(), 1);
  assert.equal(refreshed.delivery?.final_mr?.state, "merged");
  assert.equal(refreshed.status, "verifying");
  detail.mock.mockImplementation(async () => ({ ...source, iid: source.id, state: "merged",
    source_branch: "renamed", target_branch: "renamed-main", merged_at: "2026-09-02T10:00:01.000Z",
    merge_commit_sha: "a".repeat(40) }));
  const finished = await service.linkFinalMr(id, mr(2));
  assert.equal(finished.status, "completed");
  assert.equal(finished.delivery?.final_mr?.merged_at, mergedAt);
  assert.equal(finished.delivery?.final_mr?.target_branch, "main");
  assert.equal(finished.delivery?.final_mr?.merge_commit_sha, "a".repeat(40));
});

test("更换链接等待详情时原最终 MR 已合入，晚到的更换结果无效", async t => {
  const { service, task, id } = fixture(t);
  task.summary.delivery.final_mr = source;
  const held = deferred();
  t.mock.method(service as any, "readFinalMr", async () => {
    await held.wait;
    return { ...source, url: mr(3), iid: "3" };
  });
  const replace = service.linkFinalMr(id, mr(3));
  task.summary.delivery.final_mr = { ...source, state: "merged" };
  held.release();
  await assert.rejects(replace, /最终 MR 已合入/);
  assert.equal(task.summary.delivery.final_mr.url, mr(2));
});

test("原工作分支只认本轮同仓的宿主推送，拒绝目标分支、格式错误和其他仓的记录", async t => {
  const { service, task, id } = fixture(t);
  task.summary.baseline = "main";
  const push = { ref: "refs/heads/platform/req-1", sha: "a".repeat(40), remote: "origin", url: repo };
  const final = { ...source, target_branch: "release", iid: source.id };
  t.mock.method(service as any, "readFinalMr", async () => final);
  for (const receipt of [
    { ...push, ref: "refs/heads/main" }, { ...push, ref: "refs/heads/release" },
    { ...push, ref: "refs/tags/platform" }, { ...push, ref: "refs/heads/not..valid" },
    { ...push, remote: "fork" }, { ...push, url: "https://code.example/org/other.git" },
    { ...push, sha: "bad" }, undefined,
  ]) {
    task.summary.delivery = { git_push: receipt };
    const linked = await service.linkFinalMr(id, mr(2));
    assert.equal(linked.delivery?.source_branch, undefined, JSON.stringify(receipt));
    assert.equal(linked.delivery?.initial_mr, undefined);
  }
  task.summary.delivery = { git_push: push };
  const linked = await service.linkFinalMr(id, mr(2));
  assert.equal(linked.delivery?.source_branch, "platform/req-1");
});
