import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { listProductVersions, saveProductVersion, deleteProductVersion, resolveProductBranch } from "../src/configurationCenter.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { MODULE_ID, seedModule } from "./issueFlowFixed.helpers.ts";

const settings = { provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };
test("全局版本映射持久化、重复和无效分支拒绝；损坏文件不被覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-config-"));
  try {
    assert.deepEqual(listProductVersions(dir), []);
    const row = saveProductVersion(dir, { version: "2.7B", branch: "release/2.7" });
    assert.equal(resolveProductBranch(dir, "2.7B", "wrong"), "release/2.7");
    assert.equal(resolveProductBranch(dir, undefined, "legacy"), "legacy");
    assert.throws(() => saveProductVersion(dir, { version: "2.7b", branch: "main" }), /已配置/);
    for (const branch of ["--help", "HEAD", "bad branch", "a..b", "@{-1}"]) {
      assert.throws(() => saveProductVersion(dir, { version: "bad", branch }), /有效/);
    }
    assert.throws(() => saveProductVersion(dir, { id: "missing", version: "x", branch: "main" }), /不存在/);
    saveProductVersion(dir, { ...row, branch: "release/2.7-new" });
    assert.equal(listProductVersions(dir)[0].branch, "release/2.7-new");
    deleteProductVersion(dir, row.id);
    assert.throws(() => resolveProductBranch(dir, "2.7B"), /配置中心/);
    writeFileSync(join(dir, "product-versions.json"), "broken");
    assert.throws(() => saveProductVersion(dir, { version: "x", branch: "main" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("需求和问题使用同一映射，配置变更仅影响新任务，重启保留快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-config-snapshot-"));
  const row = saveProductVersion(dir, { version: "2.7B", branch: "release/2.7" });
  const tasks = new TaskService({ dataDir: dir, ...settings });
  const issueOptions = { dataDir: dir, ...settings, dts: new MockDtsGateway(), deferRecovery: true, maxConcurrentTurns: 0 };
  const issues = new IssueFlowService(issueOptions);
  try {
    const requirement = tasks.create("配置中心映射验证", { productVersion: "2.7B", baseline: "stale" });
    const issue = issues.create({ account: "dev", title: "版本映射", ticket: "DTS20260001", productVersion: "2.7B", baseline: "stale" });
    assert.equal(requirement.baseline, "release/2.7");
    assert.equal(issues.get(issue.id).baseline, "release/2.7");
    saveProductVersion(dir, { ...row, branch: "release/2.7-next" });
    assert.equal(requirement.baseline, "release/2.7");
    assert.equal(issues.get(issue.id).baseline, "release/2.7");
    const next = tasks.create("新需求", { productVersion: "2.7B" });
    assert.equal(next.baseline, "release/2.7-next");
    deleteProductVersion(dir, row.id);
    const restored = new IssueFlowService(issueOptions);
    restored.start();
    assert.equal(restored.get(issue.id).baseline, "release/2.7");
    await restored.shutdown();
    assert.throws(() => tasks.create("版本已删除", { productVersion: "2.7B" }), /配置中心/);
    assert.equal(tasks.create("旧入口", { baseline: "legacy" }).baseline, "legacy");
  } finally { await issues.shutdown(); }
});

test("版本 API：匿名拒绝，普通成员可增改删，服务端控制 ID 并保留其他行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-config-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("dev", "dev-password", "developer");
  const dts = new MockDtsGateway();
  const originalDetail = dts.detail.bind(dts);
  dts.detail = async ticket => ({ ...await originalDetail(ticket), version: "2.6B" });
  const issues = new IssueFlowService({ dataDir: dir, ...settings, dts, deferRecovery: true, maxConcurrentTurns: 0 });
  const server = createTaskServer(new TaskService({ dataDir: dir, ...settings }), { auth, issueFlow: issues, dts });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/product-versions`)).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "dev", password: "dev-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const call = (method: string, path = "", body?: unknown) => fetch(`${base}/product-versions${path}`, { method, headers: { cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const created = await call("POST", "", { id: "spoof", version: "2.7B", branch: "release/2.7" });
    assert.equal(created.status, 201);
    const row = await created.json() as { id: string };
    assert.notEqual(row.id, "spoof");
    assert.equal((await call("POST", "", { version: "2.6B", branch: "release/2.6" })).status, 201);
    assert.equal((await call("PUT", `/${row.id}`, { version: "2.7B", branch: "release/2.7-next" })).status, 200);
    assert.equal((await call("DELETE", `/${row.id}`)).status, 200);
    assert.equal(listProductVersions(dir)[0].version, "2.6B");
    assert.equal((await call("PUT", "/missing", { version: "x", branch: "main" })).status, 400);
    const issueCall = (body: unknown) => fetch(`${base}/issues`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
    // 手工登记必填责任人(3fac67b,ADR-0031):缺责任人先吃 409 指派闸,
    // 到不了版本校验;夹具带上登记页恒有的 assignee 再验失效版本 400。
    const invalid = await issueCall({ title: "失效版本", ticket: "DTS20260099", product_version: "不存在", assignee: "dev" });
    assert.equal(invalid.status, 400, "失效配置应提示用户刷新，不作为服务故障 500");
    // DTS 发起必带模块(ADR-0056,65532d4f):列上带出或人工改选,服务端不补猜。
    seedModule(dir, join(dir, "seed-repo.git"));
    const auto = await issueCall({ title: "DTS 自动关联", source: "dts", ticket: (await dts.listByOwner("dev"))[0].ticket, module_id: MODULE_ID });
    assert.equal(auto.status, 201);
    const autoState = await auto.json() as { baseline: string; product_version: string };
    assert.equal(autoState.baseline, "release/2.6");
    assert.equal(autoState.product_version, "2.6B");

  } finally { await issues.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
