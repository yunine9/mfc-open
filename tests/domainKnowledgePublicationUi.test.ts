import { test } from "node:test";
import assert from "node:assert/strict";
import type { DomainDocument, DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { confirmDomainPublication, domainDocumentHasChanges, domainPublicationInput, domainReviewDocument } from "../web/src/domainKnowledgePublication.ts";

function fixture(overrides: Partial<DomainKnowledgeJob> = {}): DomainKnowledgeJob {
  return { id: "test", title: "规则", scope: "规则", operator: "expert", created_at: "2026-10-23T00:00:00Z", status: "done", stage: "本轮完成",
    knowledge_layout: "directory-v1", repositories: [], turns: [], evidence: [], material_ids: [], revisions: {}, documents: [], publications: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs/orders" }, ...overrides };
}
function document(id: string, overrides: Partial<DomainDocument> = {}): DomainDocument {
  return { id, title: id, target_id: "domain", path: `docs/orders/${id}.md`, layer: "domain", content: `原稿 ${id}`, sources: "已核对的业务规则",
    revision: 1, selected: true, base_content: null, base_revision: "a".repeat(40), history: [], ...overrides };
}
function publication(documents: DomainDocument[], overrides: Partial<DomainPublication> = {}): DomainPublication {
  return { target_id: "domain", state: "opened", mr_state: "opened", branch: "knowledge/orders", url: "https://example.test/knowledge/merge_requests/1",
    documents: documents.map(item => ({ id: item.id, path: item.archive_path ?? item.path, content: item.content, revision: item.revision, deleted: item.deleted })), ...overrides };
}
function project(job: DomainKnowledgeJob): DomainKnowledgeJob {
  Object.assign(job, fixture(job));
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  return job;
}

test("36 篇文稿只提交勾选且相对当前 MR 已变化的文稿，随请求固定每篇当前版本", () => {
  const original = Array.from({ length: 36 }, (_, index) => document(`doc-${index}`));
  const job = fixture({ publications: [publication(original)], documents: original.map((item, index) => ({ ...item,
    revision: index < 5 ? 2 : 1, content: index < 5 ? `修改结果 ${item.id}` : item.content, selected: index !== 4 })) });
  assert.deepEqual(domainPublicationInput(project(job)), { document_ids: ["doc-0", "doc-1", "doc-2", "doc-3"], expected_revisions: { "doc-0": 2, "doc-1": 2, "doc-2": 2, "doc-3": 2 } });
  assert.equal(domainDocumentHasChanges(project(job), job.documents[5]), false);
  job.publications = [publication(job.documents)];
  assert.deepEqual(domainPublicationInput(project(job)), { document_ids: [], expected_revisions: {} });
});

test("旧模块文稿可直接提交，目录整理仍由后端处理，前端不把旧入库标记当作 MR 已提交", async () => {
  const job = fixture({ module_id: "orders", knowledge_layout: undefined, documents: [
    document("entry", { path: "AGENTS.md", published_document_revision: 1, knowledge_document_id: "kd-entry" }),
    document("unselected", { path: "docs/README.md", revision: 2, selected: false }),
    document("deleted", { path: "docs/deleted.md", revision: 2, deleted: true, base_content: "此前已归档正文" }),
  ] });
  job.publications = [publication([job.documents[2]])];
  project(job);
  assert.equal(job.production?.documents[0].status_label, "任务文稿");
  assert.ok(job.production?.research_actions.some(action => action.id === "archive"));
  assert.match(job.production?.platform_message ?? "", /MR 合入并同步后/);
  assert.equal(job.production?.documents[2].status_label, "MR 已提交");
  assert.deepEqual(domainPublicationInput(job), { document_ids: ["entry"], expected_revisions: { entry: 1 } });
  const requests: Array<{ action: string; input: unknown }> = [];
  await confirmDomainPublication(job, async (action, input) => { requests.push({ action, input }); return job; });
  assert.deepEqual(requests, [{ action: "publish", input: { document_ids: ["entry"], expected_revisions: { entry: 1 } } }]);
});

test("已提交相同版本的文稿不重复选择，旧布局标记和模块归属不改变 MR 文稿事实", () => {
  const job = fixture({ module_id: "orders", documents: [document("entry", { path: "docs/orders/README.md", published_document_revision: 1, knowledge_document_id: "kd-entry" })] });
  job.publications = [publication(job.documents)];
  assert.deepEqual(domainPublicationInput(project(job)).document_ids, []);
  assert.equal(job.production?.documents[0].status_label, "MR 已提交");
  assert.doesNotMatch(job.production?.platform_message ?? "", /自动整理/);
  job.knowledge_layout = "module-v1";
  assert.deepEqual(domainPublicationInput(project(job)).document_ids, []);
  delete job.knowledge_layout; job.component_research_id = "component";
  assert.deepEqual(domainPublicationInput(project(job)).document_ids, []);
  delete job.component_research_id; delete job.module_id;
  assert.deepEqual(domainPublicationInput(project(job)).document_ids, []);
});

test("生产线验收8：当前 MR 缺少文稿事实时，不从旧入库版本或历史已合入 MR 猜测提交与合入", () => {
  const current = document("doc", { revision: 3, knowledge_document_id: "kd-1" });
  const job = fixture({ publications: [publication([], { mr_state: undefined })], publication_history: [publication([current], { mr_state: "merged", branch: "knowledge/previous" })], documents: [current] });
  assert.equal(project(job).production?.documents[0].published_revision, undefined);
  assert.equal(domainDocumentHasChanges(project(job), job.documents[0]), true);
  job.documents[0].published_document_revision = 3;
  assert.equal(domainDocumentHasChanges(project(job), job.documents[0]), true, "旧平台入库版本不能代替当前 MR 文稿快照");
  assert.notEqual(job.production?.documents[0].status_label, "已合入");
  job.publications = [publication(job.documents)];
  assert.equal(domainDocumentHasChanges(project(job), job.documents[0]), false);
  assert.equal(job.production?.documents[0].status_label, "MR 已提交", "已提交仍不等于远端确认合入");
});

function proposalJob(): DomainKnowledgeJob {
  const documents = ["a", "b"].map(id => document(id, { revision: 2, published_document_revision: 2, knowledge_document_id: `kd-${id}` }));
  return fixture({ id: "job", documents, publications: [publication(documents)],
    turns: [{ id: "turn", mode: "revise", document_ids: ["a", "b"], message: "按检视意见修改", operator: "expert", created_at: "2026-10-23T00:00:00Z", status: "done",
      proposals: documents.map(item => ({ status: "pending", base_revision: 2, document: { id: item.id, title: item.title, path: item.path, target_id: item.target_id, layer: item.layer, sources: item.sources, content: `修改结果 ${item.id}` } })) }] });
}

test("当前正文已提交 MR 后仍能选择并预览新检视候选，更新不会被旧快照遮掉", () => {
  const job = proposalJob(), current = job.documents[0];
  assert.deepEqual(job.publications[0].documents.map(item => ({ id: item.id, revision: item.revision, content: item.content, path: item.path })),
    job.documents.map(item => ({ id: item.id, revision: item.revision, content: item.content, path: item.path })));
  assert.equal(job.publications[0].mr_state, "opened");
  assert.deepEqual(domainPublicationInput(project(job)), { document_ids: ["a", "b"], expected_revisions: { a: 2, b: 2 } });
  assert.equal(domainReviewDocument(job, current).content, "修改结果 a");
  assert.equal(current.content, "原稿 a");
});

test("已提交 MR 的文稿有新修改时预览最新完成候选，失败和冲突仍显示原稿", () => {
  const job = proposalJob(), document = job.documents[0];
  assert.equal(domainDocumentHasChanges(project(job), document), true);
  assert.equal(domainReviewDocument(project(job), document).content, "修改结果 a");
  assert.equal(document.content, "原稿 a", "预览不能原地改写基线");
  job.turns[0].status = "failed";
  assert.equal(domainReviewDocument(project(job), document).content, "原稿 a");
  job.turns[0].status = "done";
  document.revision = 3;
  assert.equal(domainReviewDocument(project(job), document).content, "原稿 a");
});

test("整批预检先于任何确认写入，后面的文稿冲突时不能提前接受前一篇", async () => {
  const job = proposalJob(); job.turns[0].proposals[1].base_revision = 1;
  const writes: string[] = [];
  await assert.rejects(confirmDomainPublication(project(job), async action => { writes.push(action); return job; }), /b.md 的正文已变化/);
  assert.equal(writes.length, 0);
  job.turns[0].proposals[1].base_revision = 2; job.turns[0].status = "running";
  await assert.rejects(confirmDomainPublication(project(job), async action => { writes.push(action); return job; }), /修改尚未完成/);
  assert.equal(writes.length, 0);
});

test("兼容确认接口按返回的新版本提交多份修改，未选文稿保留", async () => {
  const job = proposalJob();
  job.documents.push(document("unselected", { content: "未选文稿保持原文", selected: false, revision: 3 }));
  const writes: Array<{ action: string; input: any }> = [];
  let server = structuredClone(job);
  const result = await confirmDomainPublication(project(job), async (action, input: any) => {
    writes.push({ action, input });
    if (action === "proposal") {
      const doc = server.documents.find(item => item.id === input.document_id)!;
      const proposal = server.turns[0].proposals.find(item => item.document.id === doc.id)!;
      Object.assign(doc, proposal.document, { revision: doc.revision + 1 }); proposal.status = "accepted";
    } else {
      // publish 是兼容辅助方法的请求名称；响应按 MR 快照记录提交，不代表正式知识已合入。
      server.publications = [publication(server.documents.filter(item => input.document_ids.includes(item.id)))];
    }
    return project(structuredClone(server));
  });
  assert.deepEqual(writes.map(write => write.action), ["proposal", "proposal", "publish"]);
  assert.deepEqual(writes.at(-1)?.input, { document_ids: ["a", "b"], expected_revisions: { a: 3, b: 3 } });
  assert.equal(result.documents[0].content, "修改结果 a");
  assert.equal(result.documents[2].revision, 3);
  assert.equal(result.documents[2].content, "未选文稿保持原文");
  assert.deepEqual(result.publications[0].documents.map(item => item.id), ["a", "b"]);
  assert.equal(result.publications[0].mr_state, "opened");
  assert.equal(job.documents[0].content, "原稿 a");
});

test("确认途中失败保留已确认草稿，不继续发出提交请求", async () => {
  const job = proposalJob(), writes: string[] = [];
  await assert.rejects(confirmDomainPublication(project(job), async (action, input: any) => {
    writes.push(action);
    if (input.document_id === "b") throw new Error("文稿已被其他人修改");
    const next = structuredClone(job);
    next.documents[0].revision = 3;
    next.turns[0].proposals[0].status = "accepted";
    return project(next);
  }), /文稿已被其他人修改/);
  assert.deepEqual(writes, ["proposal", "proposal"]);
});
