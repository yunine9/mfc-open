import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { saveKnowledgeReviewNote } from "../src/knowledgeReviewNotes.ts";
import { saveKnowledgeDocument, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
const content = { id: "orders", title: "订单", target_id: "domain", path: "domains/orders.md", layer: "domain" as const, content: "第一版", sources: "代码来源" };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("本地研究验证超时"); }

test("生产线验收14（F23）：领域运行中 edit、restore 均拒绝，意见可保存且版本不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-edit-guard-"));
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") { input.save(content, { revision: "a".repeat(40), content: null }); return "完成"; }
    if (!input.signal.aborted) await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true })); return "结束";
  });
  try {
    const job = manager.create(config, "alice"); await until(() => manager.get(job.id).status === "done");
    manager.edit(job.id, { document: { ...content, content: "第二版" }, base_revision: 1 }, "alice");
    manager.run(job.id, { mode: "revise", document_ids: [content.id], message: "核对" }, "alice");
    const before = manager.get(job.id).documents[0];
    for (const change of [
      () => manager.edit(job.id, { document: { ...content, content: "覆盖" }, base_revision: before.revision }, "bob"),
      () => manager.restore(job.id, content.id, 1, before.revision, "bob"),
    ]) assert.throws(change, /研究进行中：请先停止，或等本轮结束后再改/);
    const notes = saveKnowledgeReviewNote({ dataDir: dir, domain: manager, component: {} as any }, "domain", job.id,
      { document_id: content.id, scope: "document", note: "请补充依据" }, "bob");
    assert.equal(notes.notes[0].status, "open");
    assert.deepEqual(manager.get(job.id).documents[0], before);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["domain", "component"] as const) test(`生产线验收14（F23）：${kind} 研究运行时正式文档 HTTP 编辑与恢复也拒绝`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-formal-edit-guard-"));
  const formal = saveKnowledgeDocument(dir, { title: "正式文稿", content: "正式版本" }, "alice");
  const formalPath = join(dir, "knowledge-documents", `${formal.id}.json`), before = readFileSync(formalPath, "utf8");
  const id = `${kind === "domain" ? "dkx" : "cr"}-${randomUUID()}`;
  const repository = { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains" };
  const record = kind === "domain" ? {
    id, title: "订单", scope: "订单", operator: "alice", created_at: new Date().toISOString(), repositories: [], knowledge_target: repository,
    material_ids: [], status: "running", stage: "研究中", revisions: {}, evidence: [], publications: [],
    documents: [{ ...content, content: formal.content, revision: 1, selected: true, history: [], base_content: null, base_revision: "a".repeat(40), knowledge_document_id: formal.id }],
    turns: [{ id: "original", mode: "extract", document_ids: [], message: "订单", operator: "alice", created_at: new Date().toISOString(), status: "running", proposals: [] }],
  } : {
    id, component: { id: "orders", name: "订单", repository: repository.repository, branch: "main", path: "", languages: ["java"], enabled: true, description: "" },
    language: "java", topic: "订单", operator: "alice", key: "test", status: "running", stage: "研究中", created_at: new Date().toISOString(), evidence: [], update_document_id: formal.id,
  };
  const directory = join(dir, kind === "domain" ? "domain-extraction" : "component-research", id); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, kind === "domain" ? "job.json" : "record.json"), JSON.stringify(record));
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const manager = kind === "domain" ? service.getDomainKnowledgeExtraction() : service.getComponentResearch();
  // 只替换研究执行边界；HTTP、真实管理器、磁盘记录和版本校验都照常运行。
  (manager as any).execute = async (input: { signal: AbortSignal }) => {
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true })); return "结束";
  };
  const server = createTaskServer(service); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/knowledge-documents/${formal.id}`;
  try {
    for (const [path, body] of [["", { content: "覆盖", expected_revision: formal.revision }], ["/restore", { revision: formal.revision, expected_revision: formal.revision }]] as const) {
      const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 400); assert.match((await response.json() as any).error, /研究进行中：请先停止，或等本轮结束后再改/);
    }
    assert.equal(readFileSync(formalPath, "utf8"), before);
    assert.equal(readKnowledgeDocument(dir, formal.id).revision, formal.revision);
  } finally { await service.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3：领域活动状态缺少活动轮次或嵌套容器损坏时，隔离且不改原字节", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-nested-corrupt-"));
  const base: DomainKnowledgeJob = { id: "", title: "好任务", scope: "订单", operator: "alice", created_at: new Date().toISOString(), repositories: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "", branch: "main", path: "", docs_path: "domains" }, material_ids: [],
    status: "done", stage: "等待审查", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
  const orphan = { ...content, target_id: "missing", revision: 1, selected: true, history: [], base_content: null, base_revision: "" };
  const mutations: Record<string, unknown>[] = [{ status: "queued" }, { status: "running" }, { source_repositories: {} },
    { turns: [{ id: "t", status: "done", mode: "extract", document_ids: [], proposals: [], message: 42, operator: "a", created_at: "now" }] },
    { turns: [{ id: "t", status: "done", mode: "extract", document_ids: [], proposals: [], message: "x", operator: "a", created_at: "now", research: { capabilities: {} } }] },
    { publications: [{ target_id: "domain", branch: "x", state: "opened", documents: [{}] }] },
    { documents: [orphan] },
    { archive_batches: [{ id: "batch", operator: "alice", created_at: "now", state: "pending", documents: [orphan], targets: [base.knowledge_target], publications: [] }] }];
  const paths = mutations.map(patch => { const id = `dkx-${randomUUID()}`, directory = join(dir, "domain-extraction", id); mkdirSync(directory, { recursive: true });
    const path = join(directory, "job.json"), raw = JSON.stringify({ ...base, ...patch, id }); writeFileSync(path, raw); return { path, raw, id }; });
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("坏记录不能执行"); });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.list(), []); assert.equal(manager.warnings().length, paths.length);
    for (const item of paths) { assert.equal(readFileSync(item.path, "utf8"), item.raw); assert.ok(manager.warnings().some(warning => warning.includes(item.id))); }
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
