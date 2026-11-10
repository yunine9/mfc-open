import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryAccessible } from "../src/taskMemory.ts";
import { collectSearchableKnowledge } from "../src/knowledgeSearch.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

const manual = { source: "user_note", judged_by: "human", scope: "platform", repo: "_platform", task: "", paths: [], evidence: "manual", author: "alice", trigger: "异步回调访问对象时", conclusion: "使用弱引用，在访问前检查生命周期。" } as const;
function draft(store: MemoryStore) { return store.record({ ...manual, paths: [] }); }

test("手工草稿、成员编辑、停用、恢复与历史；迟到模型和并发编辑不覆盖人工内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-governance-"));
  try {
    const store = new MemoryStore(dir), first = draft(store);
    assert.equal(memoryAccessible(first, "any"), false);
    const saved = store.review(first.id, "bob", { decision: "pending", revision: 1, conclusion: "先验证回调生命周期，再决定引用策略。" });
    assert.throws(() => store.finalizeDraft(first.id, { state: "model", conclusion: "迟到输出" }), /已处置/);
    assert.throws(() => store.review(first.id, "alice", { decision: "accepted", revision: 1 }), /已更新/);
    const accepted = store.review(first.id, "alice", { decision: "accepted", revision: saved.revision! });
    const edited = store.review(first.id, "bob", { decision: "accepted", revision: accepted.revision!, conclusion: "区分共享所有权与观察引用，不机械替换。", note: "已处理：强引用在共享所有权场景适用" });
    assert.equal(memoryAccessible(edited, "other"), true);
    const stopped = store.review(first.id, "alice", { decision: "rejected", revision: edited.revision! });
    assert.equal(memoryAccessible(stopped, "other"), false);
    store.archive(first.id, "人工测试归档");
    const restored = store.review(first.id, "bob", { decision: "accepted", revision: stopped.revision!, conclusion: saved.conclusion });
    const reloaded = new MemoryStore(dir);
    assert.equal(memoryAccessible(reloaded.find(first.id)!, "other"), true);
    assert.equal(restored.conclusion, saved.conclusion);
    assert.equal(reloaded.history(first.id).length, 6);
    assert.equal(reloaded.history(first.id)[3].maintenance_note, edited.maintenance_note);
    assert.equal(reloaded.find(first.id)?.basis?.conclusion, first.conclusion);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("跨仓模块经验与产品版本按当前配置生效；合并只停用来源，保留证据和目标", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-scope-"));
  try {
    createBusinessModule(dir, { id: "alarm", name: "告警", description: "告警", owner: "alice", repositories: ["https://code.example/a.git", "https://code.example/b.git"] }, "alice");
    const store = new MemoryStore(dir), first = draft(store), target = draft(store);
    const a = store.review(first.id, "alice", { decision: "accepted", revision: 1, module: "alarm", product_versions: ["2.7B"] });
    const b = store.review(target.id, "bob", { decision: "accepted", revision: 1, conclusion: "保留更完整的回调生命周期策略及例外。" });
    const context = { repo: "b", repositories: ["https://code.example/b.git"], moduleIds: [], productVersion: "2.7B" };
    assert.ok(collectSearchableKnowledge(dir, context).assets.some(row => row.id === a.id));
    assert.ok(!collectSearchableKnowledge(dir, { ...context, productVersion: "2.6B" }).assets.some(row => row.id === a.id));
    assert.ok(!collectSearchableKnowledge(dir, { ...context, repo: "z", repositories: [] }).assets.some(row => row.id === a.id));
    assert.match(store.read(a.id)!, /product_versions: \["2.7B"\]/);
    assert.throws(() => store.review(a.id, "bob", { decision: "rejected", revision: a.revision!, merged_into: a.id }), /另一条/);
    store.review(a.id, "bob", { decision: "rejected", revision: a.revision!, merged_into: b.id, note: "重复内容已在目标保留" });
    assert.ok(!collectSearchableKnowledge(dir, context).assets.some(row => row.id === a.id));
    assert.ok(collectSearchableKnowledge(dir, context).assets.some(row => row.id === b.id));
    assert.equal(store.find(a.id)?.merged_into, b.id);
    assert.equal(store.find(a.id)?.conclusion, a.conclusion);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("登录成员可独立创建、维护、读历史；匿名写入被拒绝，不需要来源任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-api-"));
  const auth = new LocalAuth(join(dir, "auth.json")); auth.bootstrapAdmin("admin", "admin-password"); auth.createUser("bob", "bob-password", "developer");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/memory-insights`, { method: "POST", body: "{}" })).status, 401);
    const login = await fetch(`${url}/auth/login`, { method: "POST", body: JSON.stringify({ username: "bob", password: "bob-password" }) });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const created = await fetch(`${url}/memory-insights`, { method: "POST", headers, body: JSON.stringify(manual) });
    assert.equal(created.status, 201); const row: any = await created.json(); assert.equal(row.author, "bob"); assert.equal(row.task, "");
    const saved = await fetch(`${url}/memory-insights/${row.id}/review`, { method: "POST", headers, body: JSON.stringify({ decision: "accepted", revision: 1 }) });
    assert.equal(saved.status, 200);
    const history: any = await (await fetch(`${url}/memory-insights/${row.id}/history`, { headers })).json();
    assert.equal(history.length, 2); assert.equal(history[1].edited_by, "bob");
    assert.equal((await fetch(`${url}/memory-insights/${row.id}/history`)).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
