import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { KnowledgeAnswers } from "../src/knowledgeAnswers.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { KnowledgeAnswerRecord } from "../src/knowledgeAnswerTypes.ts";

test("正式问答与插件共用服务：登录、归属、真实引用、持久去重", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-qa-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "fixture-admin-password");
  auth.createUser("alice", "fixture-alice-password", "developer"); auth.createUser("bob", "fixture-bob-password", "developer");
  const document = saveKnowledgeDocument(dir, { title: "示例规则", content: "# 规则\n当前测试规则" }, "alice");
  let executions = 0;
  const answers = new KnowledgeAnswers(dir, async input => {
    executions++; input.progress("researching", "读取测试原文");
    const evidence = input.addEvidence({ kind: "code", title: "实际源码", content: "return retryCount < 3;", repository: "https://example.test/retry.git", path: "retry.ts", revision: "a".repeat(40), start_line: 4, end_line: 4 });
    input.progress("checking", "核对回答");
    return { markdown: `最多尝试三次。[源码](#evidence-${evidence.id})`, evidence_ids: [evidence.id], unknowns: ["实际部署提交尚未提供。"] };
  });
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const token = "fixture-knowledge-plugin-token";
  const server = createTaskServer(service, { auth, knowledgeAnswers: answers, lubanKnowledgeToken: token });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, body?: unknown, cookie = "", pluginToken?: string) => fetch(base + path, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie, ...(pluginToken ? { "x-mfc-luban-plugin-token": pluginToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await request("/knowledge-answers")).status, 401);
    assert.equal((await request("/knowledge-answers/catalog")).status, 401);
    assert.equal((await request("/knowledge-answers", { question: "匿名" })).status, 401); assert.equal(executions, 0);
    const login = async (name: string) => (await request("/auth/login", { username: name, password: `fixture-${name}-password` })).headers.get("set-cookie")!.split(";")[0];
    const alice = await login("alice"), bob = await login("bob");
    const catalog = await (await request("/knowledge-answers/catalog", undefined, alice)).json() as { documents: Array<{ id: string }>; sources: unknown[] };
    assert.ok(catalog.documents.some(value => value.id === document.id)); assert.equal(catalog.sources.length, 1);
    for (const context of [{ material_ids: ["material-old"] }, { repository_ids: ["repo-old"] }]) {
      assert.equal((await request("/knowledge-answers", { question: "查询文档", context }, alice)).status, 400);
      assert.equal((await request("/integrations/luban/knowledge", { action: "start", sender: "alice", message_id: "removed-source", question: "查询文档", context }, "", token)).status, 400);
    }
    assert.equal(executions, 0);
    const response = await request("/knowledge-answers", { question: "最多尝试几次？", owner: "bob" }, alice);
    assert.equal(response.status, 202); assert.equal(response.headers.get("cache-control"), "no-store");
    const record = await response.json() as KnowledgeAnswerRecord; assert.equal(record.owner, "alice");
    for (let n = 0; n < 100 && answers.get(record.id, "alice").status !== "done"; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request(`/knowledge-answers/${record.id}`, undefined, bob)).status, 404);
    assert.equal((await request(`/knowledge-answers/${record.id}/cancel`, {}, bob)).status, 404);
    assert.equal((await request(`/knowledge-answers/${record.id}/feedback`, { useful: true }, bob)).status, 404);
    const own = await (await request(`/knowledge-answers/${record.id}`, undefined, alice)).json() as KnowledgeAnswerRecord;
    assert.equal(own.status, "done"); assert.equal(own.evidence[0].content, "return retryCount < 3;");
    assert.deepEqual((await (await request("/knowledge-answers", undefined, bob)).json() as { answers: unknown[] }).answers, []);
    const pluginPath = "/integrations/luban/knowledge", payload = { action: "start", sender: "alice", message_id: "same-message", question: "插件提问" };
    assert.equal((await request(pluginPath, payload)).status, 401);
    assert.equal((await request(pluginPath, payload, "", "wrong-token")).status, 401);
    assert.equal((await request(pluginPath, { ...payload, sender: "missing" }, "", token)).status, 403);
    const first = await request(pluginPath, payload, "", token); assert.equal(first.status, 202);
    const plugin = await first.json() as { id: string };
    const replay = await (await request(pluginPath, payload, "", token)).json() as { id: string; replayed: boolean }; assert.equal(replay.id, plugin.id); assert.equal(replay.replayed, true);
    assert.equal((await request(pluginPath, { ...payload, question: "不同问题" }, "", token)).status, 409);
    assert.equal((await request(pluginPath, { action: "get", sender: "bob", id: plugin.id }, "", token)).status, 404);
    const snapshot = await (await request(pluginPath, { action: "evidence", sender: "alice", id: record.id, evidence_id: own.evidence[0].id }, "", token)).json() as { content: string };
    assert.equal(snapshot.content, own.evidence[0].content);
    const pluginResult = await request(pluginPath, { action: "get", sender: "alice", id: record.id }, "", token);
    assert.equal(pluginResult.status, 200);
    const reply = await pluginResult.json() as { text: string; answer: { unknowns: string[] } };
    assert.ok(reply.text.startsWith(own.answer!.markdown));
    assert.ok(reply.text.includes("还需要确认：\n- 实际部署提交尚未提供。"));
    assert.deepEqual(reply.answer.unknowns, own.answer!.unknowns);
    assert.equal(executions, 2);
    const summaries = await (await request("/knowledge-answers", undefined, alice)).json() as { answers: Array<Record<string, unknown>> };
    assert.ok(summaries.answers.every(item => !("answer" in item) && !("evidence" in item)));
    const remove = (cookie = "") => fetch(`${base}/knowledge-answers/${record.id}`, { method: "DELETE", headers: { cookie } });
    assert.equal((await remove()).status, 401);
    assert.equal((await remove(bob)).status, 404);
    assert.equal((await remove(alice)).status, 200);
    assert.equal((await request(`/knowledge-answers/${record.id}`, undefined, alice)).status, 404);
    assert.ok(answers.get(plugin.id, "alice"), "删除单条问答不影响其他问题");
  } finally {
    await answers.shutdown(); await service.shutdown();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("宿主关闭期间不能新建问答执行器", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-qa-close-"));
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try { await service.shutdown(); assert.throws(() => service.getKnowledgeAnswers(), (error: any) => error.status === 503); }
  finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
