import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments, readKnowledgeDocument, type KnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createHash } from "node:crypto";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { writeGitKnowledgeSnapshot, writeModuleKnowledgeSync } from "../src/knowledgeRepositorySnapshots.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-update", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("等待知识操作超时");
}
function extract(input: DomainExecution) {
  input.update({ revisions: { "repo-1": "a".repeat(40) } });
  for (const id of ["orders", "refunds"]) input.save({ id, title: id, target_id: "domain", path: `domains/${id}.md`, layer: "domain", content: `${id} 原始规则`, sources: "固定源码" }, { revision: "b".repeat(40), content: null });
  return "完成";
}
const receipt = (job: DomainKnowledgeJob, targetId: string, previous?: DomainPublication): DomainPublication => ({
  target_id: targetId, state: "opened", branch: previous?.branch ?? "codex/knowledge-test", url: "https://example.test/mr/1", mr_id: 1,
  documents: job.documents.map(d => ({ id: d.id, path: d.path, content: d.content, revision: d.revision, knowledge_document_id: d.knowledge_document_id, knowledge_revision: d.published_revision })),
});

test("候选 MR 失败与重试保持正文和批次版本，只有明确提交才产生外部操作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-local-publish-")); let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (job, target, previous, _operator, save) => {
    calls++; assert.deepEqual(listKnowledgeDocuments(dir), []);
    const publication = receipt(job, target.id, previous); save({ ...publication, state: "pending", url: undefined });
    if (calls === 1) throw new Error("Git 暂时不可用"); return publication;
  } });
  try {
    const job = service.create(config, "author"); await until(() => service.get(job.id).status === "done");
    service.select(job.id, ["refunds"], false);
    const version = structuredClone(service.get(job.id).documents[0]);
    assert.equal(calls, 0); assert.deepEqual(listKnowledgeDocuments(dir), []);
    await service.createArchive(job.id, { issue_no: "REQ-EXPORT", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    const batch = service.get(job.id).archive_batches![0]; assert.equal(batch.state, "failed");
    assert.deepEqual(service.get(job.id).documents[0], version);
    await assert.rejects(service.publish(job.id, "author"), /直接创建 MR/); assert.equal(calls, 1);
    await service.retryArchive(job.id, "author", { batch_id: batch.id }); assert.equal(calls, 2);
    await service.retryArchive(job.id, "author", { batch_id: batch.id }); assert.equal(calls, 2);
    service.select(job.id, ["orders"], false); service.select(job.id, ["refunds"], true);
    await service.createArchive(job.id, { issue_no: "REQ-REFUND", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    assert.equal(service.get(job.id).archive_batches![0].documents[0].content, version.content);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("正式知识检视固定文稿和源码基线，后来同步与人工编辑均不能被旧建议覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-incremental-"));
  const location = { repository: config.knowledge_target.repository, branch: "main", docs_path: "domains" };
  saveKnowledgeRepoConfig(dir, location.repository, { branch: location.branch });
  createBusinessModule(dir, { id: "orders", name: "订单", description: "订单规则", owner: "author", repositories: [config.repositories[0].repository], knowledge_path: location.docs_path }, "author");
  const official = (content: string, revision: string) => {
    const document: KnowledgeDocument = { id: `kg-${createHash("sha256").update("orders/rules").digest("hex")}`, title: "订单规则", content, active: true, scope: "module",
      module_ids: ["orders"], repositories: [], technologies: [], product_versions: [], when_to_use: "", revision: createHash("sha256").update(content).digest("hex"),
      source: { ...location, path: "domains/orders.md", revision }, history: [{ at: new Date().toISOString(), operator: "git", action: "sync" }] };
    const at = new Date().toISOString(), repositories = [{ repository: location.repository, branch: location.branch, revision }, { repository: config.repositories[0].repository, branch: "main", revision: "a".repeat(40), scope: "repository" as const }];
    writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: at, documents: [document], repositories, resources: {} });
    writeModuleKnowledgeSync(dir, { module_id: "orders", location, attempted_at: at, synced_at: at, document_count: 1, repositories, state: "ready" });
    return document;
  };
  const original = official("orders 原始规则", "b".repeat(40)); let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    calls++; assert.equal(input.turn.mode, "revise"); assert.equal(input.turn.revisions?.["repo-1"], "a".repeat(40));
    input.update({ revisions: { "repo-1": "c".repeat(40) } });
    input.save({ ...input.read()[0], content: "核对来源后的修订建议" }); return "更新完成";
  });
  try {
    const job = service.beginInspection(original.id, { issue_no: "REQ-update", expected_revision: original.revision }, "author");
    assert.equal(calls, 0); assert.equal(job.documents[0].base_revision, "b".repeat(40));
    const synced = official("专家在远端补充的新规则", "d".repeat(40));
    service.run(job.id, { mode: "revise", document_ids: [original.id], message: "核对新代码" }, "researcher");
    await until(() => service.get(job.id).status === "done");
    const current = service.get(job.id);
    assert.equal(current.documents[0].base_content, original.content); assert.equal(current.revisions["repo-1"], "c".repeat(40));
    assert.equal(readKnowledgeDocument(dir, original.id).content, synced.content);
    service.edit(job.id, { document: { ...current.documents[0], content: "人工候选新正文" }, base_revision: 1 }, "expert");
    assert.throws(() => service.decide(job.id, current.turns[0].id, original.id, "accept", "expert"), /新版本/);
    assert.throws(() => service.previewArchive(job.id), /正文已变化/);
    assert.equal(readKnowledgeDocument(dir, original.id).content, synced.content);
    const next = service.beginInspection(original.id, { issue_no: "REQ-latest", expected_revision: synced.revision }, "author");
    assert.notEqual(next.id, job.id); assert.equal(next.documents[0].base_content, synced.content); assert.equal(next.documents[0].base_revision, "d".repeat(40));
    assert.equal(calls, 1);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("同仓同分支多逻辑目标合一个 MR，原任务新候选继续同一分支和链接", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-batch-target-")); let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id, title: target.id,
      target_id: target.id, path: `${target.docs_path}/rules.md`, layer: target.id === "domain" ? "domain" : "repository", content: "原始知识", sources: "代码" });
    else input.save({ ...input.read()[0], content: "更新知识" }); return "完成";
  }, { publish: async (job, target, previous) => {
    calls++; assert.equal(job.documents.length, 2, "同物理仓分支输出全部逻辑目录");
    if (calls > 1) assert.equal(previous?.url, "https://example.test/mr/1");
    return receipt(job, target.id, previous);
  } });
  try {
    const { knowledge_target: _, ...initial } = config; const created = service.create(initial, "author"); await until(() => service.get(created.id).status === "done");
    let job = service.get(created.id); job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories].map(target => ({ ...target, repository: config.knowledge_target.repository, branch: "main" })) });
    const initialContent = job.documents[0].content;
    const preview = service.previewArchive(job.id); assert.equal(preview.targets.length, 1); assert.equal(preview.targets[0].files.length, 2);
    await service.createArchive(job.id, { issue_no: "REQ-FIRST", expected_revisions: preview.expected_revisions }, "author");
    assert.equal(calls, 1); assert.equal(service.get(job.id).publications.length, 1);
    service.run(job.id, { mode: "revise", document_ids: ["domain"], message: "补充规则" }, "author"); await until(() => service.get(job.id).status === "done");
    await service.createArchive(job.id, { issue_no: "REQ-SECOND", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    assert.equal(calls, 2); assert.equal(service.get(job.id).publications[0].url, "https://example.test/mr/1");
    assert.equal(service.get(job.id).archive_batches![0].documents[0].content, initialContent);
    assert.equal(service.get(job.id).archive_batches![1].documents[0].content, "更新知识");
    assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("不同仓同路径分批提交保留独立目标，路径碰撞自动避让，坏持久记录仍在提交前拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-path-identity-")); let calls = 0;
  const publish = async (job: DomainKnowledgeJob, target: DomainKnowledgeJob["knowledge_target"]) => { calls++; return { ...receipt(job, target.id), url: `https://example.test/mr/${calls}` }; };
  let service = new DomainKnowledgeExtraction(dir, async input => {
    for (const target of input.job.repositories) input.save({ id: target.id, title: target.name, target_id: target.id,
      path: `${target.docs_path}/rules.md`, layer: "repository", content: "相同正文也属于不同仓库", sources: target.repository }, { content: null, revision: "a".repeat(40) });
    return "完成";
  }, { publish });
  try {
    const job = service.create({ ...config, repositories: [{ repository: "https://example.test/a.git", branch: "main", docs_path: "docs" }, { repository: "https://example.test/b.git", branch: "main", docs_path: "docs" }] }, "author");
    await until(() => service.get(job.id).status === "done");
    service.select(job.id, ["repo-2"], false);
    await service.createArchive(job.id, { issue_no: "REQ-A", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    service.select(job.id, ["repo-1"], false); service.select(job.id, ["repo-2"], true);
    await service.createArchive(job.id, { issue_no: "REQ-B", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    assert.deepEqual(service.get(job.id).archive_batches!.map(batch => batch.targets[0].repository), ["https://example.test/a.git", "https://example.test/b.git"]);
    const collision = service.create({ ...config, repositories: [{ repository: "https://example.test/c.git", branch: "main", docs_path: "docs" }, { repository: "https://example.test/d.git", branch: "main", docs_path: "docs" }] }, "author");
    await until(() => service.get(collision.id).status === "done");
    const current = service.get(collision.id);
    const settings = { base_revision: 0, targets: current.repositories.map(target => ({ ...target, repository: "https://example.test/shared.git" })) };
    const preview = service.previewArchiveTargets(collision.id, settings);
    assert.equal(new Set(preview.documents.map(document => document.path)).size, 2, "正常配置自动避让同物理仓的路径碰撞");
    await service.shutdown();
    const file = join(dir, "domain-extraction", collision.id, "job.json"), saved = JSON.parse(readFileSync(file, "utf8")) as DomainKnowledgeJob;
    for (const target of saved.repositories) target.repository = "https://example.test/shared.git";
    writeFileSync(file, JSON.stringify(saved)); service = new DomainKnowledgeExtraction(dir, async () => "unused", { publish });
    const before = calls;
    await assert.rejects(service.createArchive(collision.id, { issue_no: "REQ-COLLISION", expected_revisions: service.previewArchive(collision.id).expected_revisions }, "author"), /同一归档仓和分支/);
    assert.equal(calls, before); assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("修改候选不自动续推，显式重试旧失败批次只使用冻结版本，再次提交才采用新稿", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-historical-manual-")); let calls = 0; const contents: string[][] = [];
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (job, target, previous, _operator, save) => {
    calls++; contents.push(job.documents.map(document => document.content));
    const publication = receipt(job, target.id, previous); save({ ...publication, state: "pending", url: undefined });
    if (calls === 1) throw new Error("MR回执失败"); return publication;
  } });
  try {
    const job = service.create(config, "author"); await until(() => service.get(job.id).status === "done"); service.select(job.id, ["refunds"], false);
    await service.createArchive(job.id, { issue_no: "REQ-HISTORY", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    const batch = service.get(job.id).archive_batches![0], document = service.get(job.id).documents[0];
    service.edit(job.id, { document: { ...document, content: "orders 新候选版本" }, base_revision: document.revision }, "author");
    assert.equal(calls, 1); assert.equal(service.previewArchive(job.id).status_label, "待创建 MR");
    await service.retryArchive(job.id, "author", { batch_id: batch.id });
    assert.deepEqual(contents, [["orders 原始规则"], ["orders 原始规则"]]);
    assert.equal(service.get(job.id).documents[0].content, "orders 新候选版本");
    await service.createArchive(job.id, { issue_no: "REQ-LATEST", expected_revisions: service.previewArchive(job.id).expected_revisions }, "author");
    assert.deepEqual(contents.at(-1), ["orders 新候选版本"]); assert.equal(calls, 3);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("仓内候选改到其他仓提交后，源码研究范围仍固定为原业务仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-source-scope-"));
  const original = "https://example.test/business-a.git", archive = "https://example.test/archive-b.git"; let published: DomainKnowledgeJob | undefined;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    const repository = input.job.repositories[0];
    input.save({ id: "repository-rules", title: "仓内规则", target_id: repository.id, path: `${repository.docs_path}/rules.md`, layer: "repository", content: "业务仓 A 的调用规则", sources: original }); return "完成";
  }, { publish: async (job, target) => { published = structuredClone(job); return receipt(job, target.id); } });
  try {
    const created = service.create({ title: "业务规则", scope: "业务仓 A 的实现约定", issue_no: "REQ-scope", repositories: [{ repository: original, branch: "main", docs_path: "docs" }] }, "author");
    await until(() => service.get(created.id).status === "done");
    const initial = service.get(created.id), configured = service.configureArchive(created.id, { base_revision: 0, targets: [{ ...initial.repositories[0], repository: archive, branch: "knowledge", docs_path: "docs/business-a" }] });
    assert.equal(configured.source_repositories?.[0].repository, original);
    await service.createArchive(created.id, { issue_no: "REQ-scope", expected_revisions: service.previewArchive(created.id).expected_revisions }, "author");
    assert.equal(published?.source_repositories?.[0].repository, original); assert.equal(published?.repositories[0].repository, archive);
    assert.equal(published?.repositories[0].branch, "knowledge"); assert.equal(published?.documents[0].path, "docs/business-a/rules.md");
    assert.equal(published?.documents[0].sources, original); assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
