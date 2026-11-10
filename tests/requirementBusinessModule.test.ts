import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "requirement-module-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const id of ["alarm", "report"]) createBusinessModule(dir, { id, name: id === "alarm" ? "告警" : "报表", description: "test", owner: "owner", repositories: ["https://code.example/team/demo.git"] }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  return { dir, service };
}

test("需求创建可绑定一个配置中心模块，修改和清空留痕，子任务不能另选", t => {
  const { service } = fixture(t);
  const parent = service.create("需求", { account: "owner", businessModuleId: "alarm", deferQueue: true });
  assert.equal(parent.business_module?.id, "alarm");
  const child = service.create("子任务", { account: "owner", parentTaskId: parent.id, deferQueue: true });
  assert.throws(() => service.setBusinessModule(child.id, "report", "member"), /主任务/);
  assert.throws(() => service.setBusinessModule(parent.id, "invalid", "member"), /配置中心/);
  service.setBusinessModule(parent.id, "report", "member");
  let task = service.get(parent.id)!;
  assert.equal(task.business_module?.name, "报表");
  assert.equal(task.business_module_history?.at(-1)?.by, "member");
  service.setBusinessModule(parent.id, "report", "member");
  assert.equal(service.get(parent.id)!.business_module_history?.length, 2, "同值不重复记账");
  const saved = JSON.parse(readFileSync(join(task.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.business_module.id, "report");
  service.setBusinessModule(parent.id, "", "member");
  task = service.get(parent.id)!;
  assert.equal(task.business_module, undefined);
  assert.equal(task.business_module_history?.length, 3);
});

test("普通非责任人成员可修改所属模块，匿名不能修改", async t => {
  const { dir, service } = fixture(t);
  const task = service.create("需求", { account: "owner", deferQueue: true });
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "test-password"); auth.createUser("member", "test-password", "developer");
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${base}/tasks/${task.id}/business-module`;
  const request = { method: "PUT", body: JSON.stringify({ module_id: "alarm" }) };
  assert.equal((await fetch(url, request)).status, 401);
  const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "member", password: "test-password" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  for (const moduleId of [undefined, "", "   "]) {
    const rejected = await fetch(`${base}/tasks`, { method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "新需求", business_module_id: moduleId }) });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json() as { error: string }).error, /请选择所属业务模块/);
  }
  const created = await fetch(`${base}/tasks`, { method: "POST", headers: { cookie },
    body: JSON.stringify({ requirement: "有归属的新需求", business_module_id: "alarm" }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as TaskSummary).business_module?.id, "alarm");
  const response = await fetch(url, { ...request, headers: { cookie } });
  assert.equal(response.status, 200);
  const result = await response.json() as TaskSummary;
  assert.equal(result.business_module!.id, "alarm");
  assert.equal(result.business_module_history!.at(-1)!.by, "member");
});
