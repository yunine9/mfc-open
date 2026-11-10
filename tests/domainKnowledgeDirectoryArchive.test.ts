import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";

const title = "订单管理";
const repository = { name: "orders", repository: "https://example.test/orders.git", branch: "main", docs_path: "." };
const domain = { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "docs/订单管理" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = service.get(id);
    if (job.status === "done") return job;
    if (job.status === "failed") throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("研究未完成");
}
function receipt(job: DomainKnowledgeJob, targetId: string): DomainPublication {
  return { target_id: targetId, state: "opened", url: `https://example.test/mr/${targetId}`, branch: "main_user_REQ489",
    documents: job.documents.filter(document => document.target_id === targetId).map(document => ({ id: document.id, path: document.path,
      content: document.content, revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
}
async function fixture(root: string, archived: DomainKnowledgeJob[]) {
  const service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "overview", title: "业务说明", layer: "domain", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/README.md`, content: "# 业务说明\n[流程](flows/order.md)", sources: "业务资料" });
    input.save({ id: "flow", title: "流程", layer: "domain", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/flows/order.md`, content: "# 订单流程", sources: "资料和代码" });
    input.save({ id: "map", title: "仓内索引", layer: "repository", target_id: "repo-1", path: `${input.job.repositories[0].docs_path}/index.md`, content: "# 仓内索引", sources: "仓内源码" });
    return "研究完成";
  }, { publish: async (job, target) => { archived.push(structuredClone(job)); return receipt(job, target.id); } });
  const job = await done(service, service.create({ title, scope: "订单业务", repositories: [repository], knowledge_target: domain, issue_no: "REQ489" }, "user").id);
  return { service, job: service.get(job.id) };
}

test("Issue489：目录设置保存后候选直接创建 MR，正式库保持不变，重启保留目录与批次", async () => {
  const root = mkdtempSync(join(tmpdir(), "directory-archive-")), archived: DomainKnowledgeJob[] = [];
  let { service, job } = await fixture(root, archived);
  try {
    assert.equal(job.knowledge_layout, "directory-v1");
    assert.equal(job.repositories[0].docs_path, `docs/${title}`);
    const original = structuredClone(job);
    const settings = { base_revision: job.archive_revision, use_directory_layout: true,
      targets: [{ ...job.knowledge_target, docs_path: "domains" }, { ...job.repositories[0], docs_path: "docs/knowledge" }] };
    const candidate = service.previewArchiveTargets(job.id, settings);
    assert.deepEqual(service.get(job.id), original, "路径预览不保存目录、稿件或历史");
    job = service.configureArchive(job.id, settings);
    assert.deepEqual(job.documents.map(document => document.path), candidate.documents.map(document => document.path));
    assert.equal(job.knowledge_target.docs_path, "domains", "用户明确选择的最终目录不按默认规则改写");
    assert.equal(job.repositories[0].docs_path, "docs/knowledge");
    assert.equal(job.production!.archive.visible, true);
    assert.deepEqual(listKnowledgeDocuments(root), [], "设置目录不提前写正式知识");
    assert.deepEqual(job.turns, original.turns);
    await service.shutdown();
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不能重做研究"); }, {
      publish: async (snapshot, target) => { archived.push(structuredClone(snapshot)); return receipt(snapshot, target.id); },
    });
    assert.equal(service.warnings().length, 0, "新布局与批次记录必须能重启读取");
    const preview = service.previewArchive(job.id);
    assert.ok(preview.actions.some(action => action.id === "create-archive"));
    assert.deepEqual(preview.targets.flatMap(target => target.files.map(file => file.path)).sort(), ["domains/README.md", "domains/flows/order.md", "docs/knowledge/index.md"].sort());
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ489", expected_revisions: {} }, "user"), /文稿已有新版本/);
    assert.deepEqual(listKnowledgeDocuments(root), []);
    await service.createArchive(job.id, { issue_no: "REQ489", expected_revisions: preview.expected_revisions }, "user");
    job = service.get(job.id);
    assert.equal(archived.length, 2);
    assert.ok(job.documents.every(document => !document.knowledge_document_id), "MR 创建也不伪造正式知识身份");
    assert.equal(job.documents[0].content, original.documents[0].content);
    assert.equal(archived[0].documents[0].path, "domains/README.md");
    assert.equal(archived[0].documents[0].layer, "domain");
    await service.shutdown();
    service = new DomainKnowledgeExtraction(root, async () => "不应调用");
    assert.equal(service.get(job.id).archive_batches!.at(-1)!.state, "done");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("Issue489：目录设置保留人工候选，创建 MR 才提交，代码路径不能越出 docs", async () => {
  const root = mkdtempSync(join(tmpdir(), "directory-unconfirmed-")), archived: DomainKnowledgeJob[] = [];
  const { service, job: initial } = await fixture(root, archived);
  try {
    let job = service.edit(initial.id, { document: { ...initial.documents[0], content: "# 尚未确认的新规则" }, base_revision: initial.documents[0].revision }, "user");
    const before = service.previewArchive(job.id).expected_revisions;
    assert.throws(() => service.configureArchive(job.id, { base_revision: job.archive_revision, use_directory_layout: true,
      targets: [{ ...job.repositories[0], docs_path: "domain-docs" }] }), /docs 下的业务目录/);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_directory_layout: true,
      targets: [{ ...job.knowledge_target, docs_path: "docs/新目录" }] });
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ489", expected_revisions: before }, "user"), /文稿已有新版本/);
    assert.deepEqual(listKnowledgeDocuments(root), []);
    assert.equal(service.get(job.id).documents[0].content, "# 尚未确认的新规则");
    assert.equal(archived.length, 0);
    await service.createArchive(job.id, { issue_no: "REQ489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    assert.equal(archived[0].documents[0].content, "# 尚未确认的新规则");
    assert.deepEqual(listKnowledgeDocuments(root), []);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
