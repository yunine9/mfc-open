import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import type { KnowledgeReviewNote } from "../src/knowledgeReviewNoteTypes.ts";
import type { KnowledgeTaskCenterData } from "../src/knowledgeTaskCenterTypes.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

test("知识任务与审阅接口要求登录，匿名读取和提交不能触发研究", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-route-auth-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-fixture-password");
  auth.createUser("reviewer", "reviewer-fixture-password", "developer");
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  let executions = 0;
  const domain = new DomainKnowledgeExtraction(dataDir, async input => {
    executions++;
    if (input.turn.mode === "extract") input.save({ id: "rules", title: "规则", target_id: "domain", path: "docs/rules.md", layer: "domain", content: "# 规则\n业务规则", sources: "测试资料" }, { content: null, revision: "a".repeat(40) });
    return "研究完成";
  });
  service.getDomainKnowledgeExtraction = () => domain;
  const server = createTaskServer(service, { auth });
  const request = (path: string, cookie = "", body?: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const job = domain.create({ title: "鉴权测试", scope: "规则", issue_no: "AUTH-test", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "docs" } }, "reviewer");
    for (let index = 0; index < 100 && domain.get(job.id).status !== "done"; index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(domain.get(job.id).status, "done", domain.get(job.id).error);
    const path = `/knowledge-review/domain/${job.id}`;
    const noteInput = { document_id: "rules", scope: "document", note: "补充边界规则" };
    for (const anonymousPath of ["/knowledge-tasks", path, "/knowledge-review/component/cr-missing", "/skills/example/package", "/skills/example/submissions/example"]) {
      assert.equal((await request(anonymousPath)).status, 401, `匿名读取 ${anonymousPath} 必须拒绝`);
    }
    for (const base of [`/domain-extraction/${job.id}`, "/component-research/cr-missing"]) {
      for (const suffix of ["reader", "evidence", "evidence/0", "history/rules", "work-document/plan"]) {
        assert.equal((await request(`${base}/${suffix}`)).status, 401, "拆分后的只读详情沿用任务权限");
      }
    }
    for (const anonymousPath of [path, "/knowledge-review/component/cr-missing", "/knowledge-review/published/kd-missing", "/knowledge-review/skill/example"]) {
      assert.equal((await request(anonymousPath, "", noteInput)).status, 401);
      assert.equal((await request(`${anonymousPath}/apply`, "", { note_ids: ["unknown"] })).status, 401);
      assert.equal((await request(`${anonymousPath}/resolve`, "", { note_ids: ["unknown"] })).status, 401);
    }
    for (const action of ["preview", "publish", "start"]) assert.equal((await request(`/domain-extraction/${job.id}/source-cleanup/${action}`, "", {})).status, 401, "匿名清理或开始研究必须拒绝");
    assert.equal(executions, 1, "匿名请求不能触发新的研究回合");
    const login = await request("/auth/login", "", { username: "reviewer", password: "reviewer-fixture-password" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const tasksResponse = await request("/knowledge-tasks", cookie);
    assert.equal(tasksResponse.status, 200);
    const tasks = await tasksResponse.json() as KnowledgeTaskCenterData;
    assert.ok(tasks.tasks.some(task => task.kind === "domain" && task.id === job.id));
    const emptyResponse = await request(path, cookie);
    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), { notes: [], submissions: {} }, "匿名 POST 未写入批注(submissions 为检视载荷新伴生字段)");
    const savedResponse = await request(path, cookie, noteInput);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as { notes: KnowledgeReviewNote[] };
    assert.equal(saved.notes[0].operator, "reviewer");
    assert.equal(Object.hasOwn(saved.notes[0], "revision"), false, "意见不记版本，靠引用原文与前后文定位");
    assert.equal((await request(`${path}/apply`, "", { note_ids: [saved.notes[0].id] })).status, 401, "真实意见 ID 也不能绕过登录");
    const pending = await (await request(path, cookie)).json() as { notes: KnowledgeReviewNote[] };
    assert.equal(pending.notes[0].status, "open");
    assert.equal(executions, 1);
    const draft = domain.get(job.id).documents[0];
    domain.edit(job.id, { document: { ...draft, content: "# 规则\n人工先调整其他内容" }, base_revision: draft.revision }, "reviewer");
    const appliedResponse = await request(`${path}/apply`, cookie, { note_ids: [saved.notes[0].id] });
    assert.equal(appliedResponse.status, 202);
    const applied = await appliedResponse.json() as { notes: KnowledgeReviewNote[] };
    assert.equal(applied.notes[0].status, "submitted");
    assert.equal(applied.notes[0].submitted_by, "reviewer");
    const document = saveKnowledgeDocument(dataDir, { title: "正式规则", content: "# 规则\n现有正文" }, "reviewer");
    const publishedPath = `/knowledge-review/published/${document.id}`;
    const publishedResponse = await request(publishedPath, cookie, { document_id: document.id, scope: "line", line: 2, note: "核对异常情况" });
    assert.equal(publishedResponse.status, 200);
    const published = await publishedResponse.json() as { notes: KnowledgeReviewNote[] };
    assert.equal(Object.hasOwn(published.notes[0], "revision"), false, "意见不记版本，靠引用原文与前后文定位");
    assert.equal((await request(`${publishedPath}/resolve`, "", { note_ids: [published.notes[0].id] })).status, 401);
    saveKnowledgeDocument(dataDir, { content: "# 规则\n已核对异常情况" }, "reviewer", document.id);
    const resolvedResponse = await request(`${publishedPath}/resolve`, cookie, { note_ids: [published.notes[0].id] });
    assert.equal(resolvedResponse.status, 200);
    const resolved = await resolvedResponse.json() as { notes: KnowledgeReviewNote[] };
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(resolved.notes[0].resolved_by, "reviewer");
    assert.deepEqual(await (await request(publishedPath, cookie)).json(), resolved);
  } finally {
    await domain.shutdown(); await service.shutdown();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
