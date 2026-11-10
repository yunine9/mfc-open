import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryAccessible, type MemoryInput } from "../src/taskMemory.ts";
import { TaskService } from "../src/taskService.ts";
import { buildMemoryDraftPrompt, parseMemoryDraft } from "../src/memoryDraft.ts";

const base: MemoryInput = { source: "annotation", judged_by: "human", scope: "local", repo: "orders",
  task: "task-old", paths: [], evidence: "annotation:a", trigger: "调用订单服务超时时", problem: "重试重复下单",
  quote: "这里不能直接重试", conclusion: "修正本次订单重试" };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory-adoption-"));
  const store = new MemoryStore(dataDir);
  return { dataDir, store };
}

test("所有来源和历史人确认都只是候选，伪造 review 不能授予复用资格", () => {
  const { store, dataDir } = setup();
  try {
    for (const source of ["annotation", "agent_note", "user_note", "prepush_fix"] as const) {
      const row = store.record({ ...base, source, review: { status: "accepted" } } as any);
      assert.equal(row.review?.status, "pending");
      assert.equal(memoryAccessible(row, "orders"), false);
      assert.match(store.read(row.id)!, /review_status: pending/);
    }
    const old = store.record(base);
    delete old.review; delete old.basis;
    appendFileSync(join(store.root, "index.jsonl"), JSON.stringify(old) + "\n");
    assert.equal(memoryAccessible(store.find(old.id)!, "orders"), false);
    assert.ok(store.read(old.id), "旧记录仍可审查");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("模型抽象保留原依据；人工修订跨仓范围后迁移正本，撤销后重启也不能复用", () => {
  const { store, dataDir } = setup();
  try {
    const original = store.record(base);
    const draft = store.finalizeDraft(original.id, { state: "model", trigger: "有副作用的接口超时时", scope: "platform",
      conclusion: "先查询操作结果再决定重试。\n\n适用例外：已保证幂等的请求遵循接口约定。" });
    assert.equal(draft.basis?.conclusion, base.conclusion);
    assert.equal(memoryAccessible(draft, "other"), false);
    const adopted = store.review(draft.id, "owner", { decision: "accepted", revision: draft.revision!,
      conclusion: "核对幂等保障或查询结果，再决定重试。\n\n适用例外：纯读取请求。" });
    assert.ok(adopted.file.startsWith("_platform/"));
    assert.ok(!existsSync(join(store.root, original.file)));
    assert.match(store.read(adopted.id)!, /纯读取请求/);
    assert.equal(adopted.review?.original?.conclusion, draft.conclusion);
    assert.equal(memoryAccessible(new MemoryStore(dataDir).find(adopted.id)!, "other"), true);
    assert.throws(() => store.finalizeDraft(adopted.id, { state: "model", conclusion: "迟到模型覆盖" }), /已处置/);
    assert.throws(() => store.review(adopted.id, "owner", { decision: "rejected", revision: 1 }), /已更新/);
    store.review(adopted.id, "owner", { decision: "rejected", revision: adopted.revision!, trigger: "", conclusion: "" });
    assert.equal(memoryAccessible(new MemoryStore(dataDir).find(adopted.id)!, "other"), false);
    assert.match(store.read(adopted.id)!, /核对幂等保障/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("下一任务实际上下文只收到采纳后的结论及例外；缓存、旧索引和重新检索不复活撤销记录", async () => {
  const { store, dataDir } = setup();
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const api = service as any;
  try {
    const owner = service.create("处理订单超时").id;
    const task = api.tasks.get(owner);
    task.summary.luban_account = "alice";
    const originalStatus = task.summary.status;
    const row = store.record({ ...base, task: owner });
    const teammate = service.reviewTaskMemory(owner, row.id, "bob", { decision: "pending", revision: 1 });
    assert.equal(teammate.review?.by, "bob");
    const next = service.create("处理支付超时").id;
    const consumer = api.tasks.get(next);
    consumer.summary.repo_url = "git@example.com:team/payments.git";
    assert.throws(() => service.reviewTaskMemory(next, row.id, "本地用户", { decision: "accepted", revision: 1 }), /不属于/);
    let searches = 0;
    api.memorySidecar = { available: true, search: async () => { searches++; return [{ id: row.id, snippet: "旧的错误建议", score: 1 }]; },
      ingest: async () => true, stop() {} };
    const tools = api.memoryTools(consumer);
    const expand = tools.find((tool: any) => tool.name === "knowledge");
    assert.deepEqual(await api.memorySearch(consumer, { query: "超时" }), []);
    assert.match((await expand.execute("before", { action: "read", id: row.id })).content[0].text, /取不到/);
    const accepted = service.reviewTaskMemory(owner, row.id, "alice", { decision: "accepted", revision: teammate.revision!,
      scope: "platform", trigger: "有副作用的接口超时时", conclusion: "先核对幂等保障。\n\n适用例外：纯读取请求。" });
    assert.equal(task.summary.status, originalStatus, "采纳不推进或暂停任务");
    const hook = api.taskMemoryContext(consumer);
    const messages = [{ role: "user", content: "处理超时重试" }];
    const output = await hook(messages);
    assert.match(output.at(-1).content, /先核对幂等保障/);
    assert.match(output.at(-1).content, /纯读取请求/);
    assert.doesNotMatch(output.at(-1).content, /旧的错误建议/);
    const before = searches;
    service.reviewTaskMemory(owner, row.id, "alice", { decision: "rejected", revision: accepted.revision! });
    assert.deepEqual(await hook(output), messages, "已注入的临时上下文也被清除");
    assert.equal(searches, before, "验证的是缓存命中路径");
    assert.deepEqual(await api.memorySearch(consumer, { query: "重试" }), []);
    assert.match((await expand.execute("after", { action: "read", id: row.id })).content[0].text, /取不到/);
    assert.ok(service.readMemoryInsight(row.id), "不采纳不是删除证据");
  } finally { await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("模型提炼提示词要求可迁移因果及反例，不把闭环当通用质量证明", () => {
  const { store, dataDir } = setup();
  try {
    const prompt = buildMemoryDraftPrompt(store.record(base));
    assert.match(prompt.system, /换一个仓库/);
    assert.match(prompt.system, /因果关系、判断方法/);
    assert.match(prompt.system, /不强行总结/);
    assert.match(prompt.system, /适用例外/);
    assert.match(prompt.user, /重试重复下单/);
    assert.deepEqual(parseMemoryDraft('{"trigger":"调用有副作用的接口时","scope":"platform","conclusion":"先核对幂等保障。\\n\\n适用例外：纯读取请求。"}'), {
      trigger: "调用有副作用的接口时", scope: "platform", conclusion: "先核对幂等保障。\n\n适用例外：纯读取请求。",
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("HTTP 审查权限与展示一致：团队成员均可维护已完成任务的经验", async () => {
  const { LocalAuth } = await import("../src/auth.ts");
  const { createTaskServer } = await import("../src/server.ts");
  const { store, dataDir } = setup();
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "test-admin-pass");
  auth.createUser("alice", "test-alice-pass", "developer");
  auth.createUser("bob", "test-bob-pass", "developer");
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const id = service.create("订单重试").id;
  const internal = (service as any).tasks.get(id);
  internal.summary.luban_account = "alice";
  internal.summary.status = "completed";
  const row = store.record({ ...base, task: id });
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    for (const actor of ["bob", "alice", "admin"]) {
      const response = await fetch(`${url}/auth/login`, { method: "POST", body: JSON.stringify({ username: actor, password: `test-${actor}-pass` }) });
      assert.equal(response.status, 200);
      const headers = { cookie: response.headers.get("set-cookie")!.split(";")[0] };
      const found = await (await fetch(`${url}/memory-insights/${row.id}`, { headers })).json() as any;
      assert.equal(found.record.can_review, true);
      const result = await fetch(`${url}/tasks/${id}/memories/${row.id}/review`, { method: "POST", headers,
        body: JSON.stringify({ decision: actor === "admin" ? "rejected" : "accepted", revision: found.record.revision ?? 1 }) });
      assert.equal(result.status, 200, await result.text());
      assert.equal(internal.summary.status, "completed");
    }
    assert.equal(store.find(row.id)?.review?.by, "admin");
    assert.equal(store.find(row.id)?.review?.status, "rejected");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.shutdown(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("本仓通用经验不因来源文件失锚而消失，本仓相关位置仍按路径匹配", async () => {
  const { store, dataDir } = setup();
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const id = service.create("同仓另一个模块").id;
    const task = (service as any).tasks.get(id);
    task.summary.repo_url = "git@example.com:team/orders.git";
    task.cwd = dataDir;
    const general = store.record({ ...base, scope: "general", paths: ["removed/old.ts"] });
    const local = store.record({ ...base, paths: ["removed/old.ts"] });
    for (const row of [general, local]) store.review(row.id, "owner", { decision: "accepted", revision: 1 });
    assert.deepEqual((service as any).memoryCandidates(task).map((row: any) => row.id), [general.id]);
  } finally { await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});
