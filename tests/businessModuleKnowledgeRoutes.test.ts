import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createBusinessModule, readBusinessModule } from "../src/businessModuleLibrary.ts";
import { clearKnowledgeRepoConfig, readKnowledgeRepoConfig, saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-module-knowledge-api-"));
  createBusinessModule(dir, { id: "orders", name: "交易业务", description: "交易业务", owner: "owner", repositories: ["https://git.example/code.git"] }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const syncs: string[] = [];
  Object.assign(service, { startModuleKnowledgeSync: (moduleId: string) => { syncs.push(moduleId); } });
  const server = createTaskServer(service);
  t.after(async () => {
    await service.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = "GET", body?: object) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { dir, syncs, request };
}

test("模块API只写长期目录并派生全局仓位置，普通改名保留目录，旧客户端不能绕过全局配置", async t => {
  const { dir, syncs, request } = await setup(t);
  const global = { repository: "https://git.example/knowledge.git", branch: "release/2026" };
  saveKnowledgeRepoConfig(dir, global.repository, { branch: global.branch });
  const path = "/business-modules/orders", docs_path = "domains/交易业务";
  const saved = await request(path, "PUT", { knowledge_path: docs_path });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as any;
  assert.equal(savedBody.knowledge_path, docs_path);
  assert.deepEqual(savedBody.knowledge_location, { ...global, docs_path });
  assert.deepEqual(syncs, ["orders"]);
  const renamed = await request(path, "PUT", { name: "交易中心" });
  assert.equal(renamed.status, 200);
  assert.equal(readBusinessModule(dir, "orders").knowledge_path, docs_path);
  assert.deepEqual(syncs, ["orders"], "普通编辑不会重复触发配置同步");
  const view = await (await request(`${path}/knowledge-location`)).json() as any;
  assert.equal(view.configured, true); assert.equal(view.knowledge_path, docs_path);
  assert.deepEqual(view.location, { ...global, docs_path }); assert.equal("suggestion" in view, false);
  const change = await request(`${path}/knowledge-location`, "POST", { knowledge_path: "domains/交易中心", expected_revision: view.module_revision });
  assert.equal(change.status, 202); assert.deepEqual(syncs, ["orders", "orders"]);
  const stale = await request(`${path}/knowledge-location`, "POST", { knowledge_path: "wrong", expected_revision: view.module_revision });
  assert.equal(stale.status, 400);
  assert.equal(readBusinessModule(dir, "orders").knowledge_path, "domains/交易中心");
  for (const wrong of [{ ...global, repository: "https://other.example/knowledge.git", docs_path }, { ...global, branch: "other-branch", docs_path }]) {
    assert.equal((await request(path, "PUT", { knowledge_location: wrong })).status, 400);
    assert.equal((await request(`${path}/knowledge-location`, "POST", { location: wrong, knowledge_path: "bypass" })).status, 400);
    assert.equal((await request("/business-modules", "POST", { id: "bad", name: "坏模块", description: "坏模块", owner: "owner", repositories: ["https://git.example/code.git"], knowledge_location: wrong })).status, 400);
  }
  assert.deepEqual(readKnowledgeRepoConfig(dir), { url: global.repository, branch: global.branch });
  assert.equal((await request(path, "PUT", { knowledge_path: "../other" })).status, 400);
  assert.deepEqual(syncs, ["orders", "orders"]);
  const raw = JSON.parse(readFileSync(join(dir, "business-modules/orders/module.json"), "utf8"));
  assert.equal(raw.knowledge_path, "domains/交易中心"); assert.equal(raw.knowledge_location, undefined);
  const created = await request("/business-modules", "POST", { id: "refunds", name: "退款业务", description: "退款业务", owner: "owner", repositories: ["https://git.example/code.git"] });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as any;
  assert.equal(createdBody.knowledge_path, "Function_Knowledge/Access Function/退款业务");
  assert.deepEqual(createdBody.knowledge_location, { ...global, docs_path: createdBody.knowledge_path });
  assert.deepEqual(syncs, ["orders", "orders", "refunds"]);
});

test("全局仓未配置仍可保存模块路径，读视图明确未配置且不启动同步", async t => {
  const { dir, syncs, request } = await setup(t), path = "/business-modules/orders/knowledge-location";
  const first = await (await request(path)).json() as any;
  assert.equal(first.configured, false); assert.equal(first.location, undefined);
  assert.equal(first.knowledge_path, "Function_Knowledge/Access Function/交易业务");
  const saved = await request(path, "POST", { knowledge_path: "custom/交易", expected_revision: first.module_revision });
  assert.equal(saved.status, 202);
  assert.equal((await saved.json() as any).configured, false);
  assert.equal(readBusinessModule(dir, "orders").knowledge_path, "custom/交易");
  assert.deepEqual(syncs, []);
  const denied = await request("/business-modules/orders/knowledge-sync", "POST", {});
  assert.equal(denied.status, 400); assert.match((await denied.json() as any).error, /管理员配置平台领域知识仓库/);
  saveKnowledgeRepoConfig(dir, "https://git.example/knowledge.git");
  assert.deepEqual((await (await request(path)).json() as any).location, { repository: "https://git.example/knowledge.git", branch: "master", docs_path: "custom/交易" });
  clearKnowledgeRepoConfig(dir);
  assert.equal((await (await request(path)).json() as any).configured, false);
  assert.equal(readBusinessModule(dir, "orders").knowledge_path, "custom/交易");
});

test("目录筛选保存和恢复立即生效，旧版本不能覆盖新选择，暂时缺席的目录仍可恢复", async t => {
  const { dir, syncs, request } = await setup(t), path = "/business-modules/orders/knowledge-scope";
  const firstResponse = await request(path);
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");
  const first = await firstResponse.json() as any;
  assert.deepEqual(first.repositories, [{ repository: "https://git.example/code.git", directories: ["docs"], files: [], excluded_paths: [] }]);
  assert.equal((await request(path, "PUT", null as any)).status, 400);
  const savedResponse = await request(path, "PUT", { expected_revision: first.module_revision,
    repositories: [{ repository: "https://git.example/code.git", excluded_paths: ["docs/other", "docs/README.md"] }] });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as any;
  assert.deepEqual(saved.repositories[0].excluded_paths, ["docs/README.md", "docs/other"]);
  assert.deepEqual(saved.repositories[0].directories, ["docs"], "实际目录与已排除目录分别返回，界面可标出暂时缺席的目录并恢复");
  assert.deepEqual(readBusinessModule(dir, "orders").repository_knowledge_exclusions,
    [{ repository: "https://git.example/code.git", paths: ["docs/README.md", "docs/other"] }]);
  assert.equal((await request(path, "PUT", { expected_revision: first.module_revision, repositories: [] })).status, 409);
  assert.equal((await request(path, "PUT", { expected_revision: saved.module_revision,
    repositories: [{ repository: "https://git.example/code.git", excluded_paths: ["../escape"] }] })).status, 400);
  const restored = await request(path, "PUT", { expected_revision: saved.module_revision, repositories: [] });
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json() as any).repositories[0].excluded_paths, []);
  assert.deepEqual(readBusinessModule(dir, "orders").repository_knowledge_exclusions, []);
  assert.deepEqual(syncs, [], "筛选只调整阅读范围，不触发拉仓或重新萃取");
});
