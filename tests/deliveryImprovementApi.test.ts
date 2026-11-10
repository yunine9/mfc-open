import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { DeliveryImprovements } from "../src/deliveryImprovement.ts";
import { improvementEvidenceTool } from "../src/deliveryImprovementEvidence.ts";

test("交付分析API：登录、责任人/管理员启动权限、策略校验、历史交付范围", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "delivery-improvement-api-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-fixture-password");
  for (const name of ["owner", "viewer"]) auth.createUser(name, `${name}-fixture-password`, "developer");
  const service = new TaskService({ dataDir, provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  const created = service.create("分析任务", { account: "owner", deferQueue: true });
  const task = (service as any).tasks.get(created.id);
  task.summary.status = "await_merge";
  task.summary.delivery = { git_push: { sha: "a".repeat(40), ref: "refs/heads/task", remote: "origin" }, mr_state: "等待合入" };
  const calls: Array<{ generation: string; head: string }> = [];
  const evidence: Array<{ reference: string; originalText: string }> = []; let failNext = false;
  const reports = new DeliveryImprovements<any>(() => ({ dataDir, model: { json: {} } }), async input => {
    calls.push({ generation: input.task.delivery_generation ?? "initial", head: input.task.delivery!.git_push!.sha });
    if (failNext) { failNext = false; throw new Error("模拟报告重试失败"); }
    const result = await improvementEvidenceTool(input.scopes, join(input.root, "evidence")).execute("manifest", { action: "read", scope: "analysis", path: "manifest.json" });
    const read = JSON.parse(result.content[0].text), reference = read.citation.split("/").at(-1);
    assert.match(reference, /^[a-f0-9]{64}$/); evidence.push({ reference, originalText: read.text });
    return `证据报告 ${input.task.delivery_generation ?? "initial"} [原始依据](${read.citation})`;
  });
  (service as any).deliveryImprovements = reports;
  const server = createTaskServer(service, { auth });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, method = "GET", cookie = "", body?: unknown) => fetch(`${base}${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const endpoint = `/tasks/${created.id}/delivery-improvement`;
    for (const [path, method] of [[endpoint, "GET"], [endpoint, "POST"], ["/delivery-analytics/improvement-policy", "PUT"]]) assert.equal((await request(path, method)).status, 401);
    const login = async (username: string) => {
      const res = await request("/auth/login", "POST", "", { username, password: `${username}-fixture-password` }); assert.equal(res.status, 200);
      return res.headers.get("set-cookie")!.split(";")[0];
    };
    const viewer = await login("viewer"), owner = await login("owner"), admin = await login("admin");
    assert.equal((await request(endpoint, "GET", viewer)).status, 200);
    assert.equal((await request(endpoint, "POST", viewer)).status, 403); assert.equal(calls.length, 0);
    assert.equal((await request("/delivery-analytics/improvement-policy", "PUT", owner, { enabled: false, threshold_percent: 50 })).status, 403);
    assert.equal((await request("/delivery-analytics/improvement-policy", "PUT", admin, { enabled: false, threshold_percent: 50 })).status, 200);
    for (const value of [-1, 101, "50", null]) assert.equal((await request("/delivery-analytics/improvement-policy", "PUT", admin, { enabled: true, threshold_percent: value })).status, 400);
    const analytics = await (await request("/delivery-analytics", "GET", viewer)).json() as any;
    assert.equal(analytics.improvement_policy.can_configure, false); assert.equal(analytics.improvement_policy.enabled, false);
    assert.equal((await request(endpoint, "POST", owner)).status, 202); await reports.flush();
    const read = await request(endpoint, "GET", viewer); assert.equal(read.headers.get("cache-control"), "no-store");
    assert.match((await read.json() as any).markdown, /证据报告 initial/);
    const savedEvidence = evidence[0];
    const evidenceEndpoint = `${endpoint}/evidence?delivery_id=initial&ref=${savedEvidence.reference}`;
    assert.equal((await request(evidenceEndpoint)).status, 401);
    const originalEvidence = await request(evidenceEndpoint, "GET", viewer);
    assert.equal(originalEvidence.status, 200); assert.equal(originalEvidence.headers.get("cache-control"), "no-store");
    const storedRead = await originalEvidence.json() as any;
    assert.equal(storedRead.text, savedEvidence.originalText); assert.match(storedRead.citation, /^analysis:\/\/analysis\/manifest\.json#offset=0$/);
    assert.equal(JSON.parse(storedRead.text).task.id, created.id);
    for (const reference of ["f".repeat(64), "../../task.json", "manifest.json"]) assert.equal((await request(`${endpoint}/evidence?delivery_id=initial&ref=${encodeURIComponent(reference)}`, "GET", viewer)).status, 404);
    failNext = true;
    assert.equal((await request(endpoint, "POST", admin)).status, 202); await reports.flush();
    const failedRetry = await (await request(endpoint, "GET", viewer)).json() as any;
    assert.equal(failedRetry.state.status, "failed"); assert.match(failedRetry.markdown, new RegExp(savedEvidence.reference));
    const retainedEvidence = await request(evidenceEndpoint, "GET", viewer); assert.equal(retainedEvidence.status, 200);
    assert.deepEqual(await retainedEvidence.json(), storedRead, "重试失败必须保留原报告绑定的原始证据，不能切到失败run");
    assert.equal((await request("/tasks/task-999999/delivery-improvement", "GET", viewer)).status, 404);
    assert.equal((await request(`${endpoint}?delivery_id=unknown`, "GET", viewer)).status, 400);
    assert.equal((await request(`${endpoint}?delivery_id=unknown`, "POST", owner)).status, 400);
    const archive = join(created.workspace, "delivery-history", "history-archive"); mkdirSync(archive, { recursive: true });
    const original = { ...structuredClone(task.summary), status: "completed", completed_at: "2026-01-01T00:00:00.000Z" };
    writeFileSync(join(archive, "summary.json"), JSON.stringify(original));
    task.summary.delivery_history = [{ id: "initial", archive: "history-archive", started_at: original.created_at, completed_at: original.completed_at, delivery: original.delivery }];
    task.summary.delivery_generation = "next"; task.summary.delivery.git_push.sha = "b".repeat(40);
    assert.equal((await request(`${endpoint}?delivery_id=initial`, "POST", owner)).status, 202); await reports.flush();
    assert.deepEqual(calls.at(-1), { generation: "initial", head: "a".repeat(40) });
    assert.equal((await request(`${endpoint}?delivery_id=next`, "POST", owner)).status, 202); await reports.flush();
    assert.deepEqual(calls.at(-1), { generation: "next", head: "b".repeat(40) });
    assert.equal(task.summary.status, "await_merge", "报告不能改动原任务交付状态");
  } finally {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await service.shutdown(); rmSync(dataDir, { recursive: true, force: true });
  }
});
