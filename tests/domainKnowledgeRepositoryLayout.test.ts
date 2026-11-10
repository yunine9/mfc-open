import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { assertModuleKnowledgePath, repositoryKnowledgeDirectory, repositoryKnowledgePath } from "../src/domainKnowledgeLayout.ts";
import { listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { completedDomainTask as done, domainArchiveFixture, publicationFor, submitDomainCandidates as submit } from "./fixtures/domainKnowledgeArchive.ts";

test("仓内路径只去已知包装和准确仓名前缀，不折叠真实目录", () => {
  const names = ["FMProductFrontendService"];
  assert.equal(repositoryKnowledgeDirectory("无线/产品管理"), "无线-产品管理");
  assert.equal(repositoryKnowledgePath("docs/knowledge/module-uuid", ".", "docs/knowledge/module-uuid/FMProductFrontendService/docs/module-map.md", names, true), "docs/module-map.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "docs/module-map.md", names), "docs/module-map.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "OtherService/docs/module-map.md", names), "OtherService/docs/module-map.md");
  assert.equal(repositoryKnowledgePath("domain", "domain", "domain/domain/a.md", [], true), "domain/domain/a.md");
  assert.equal(repositoryKnowledgePath("A", "B", "A/B/a.md", [], true), "B/B/a.md");
  assert.equal(repositoryKnowledgePath("archive", "new", "archive/docs/module-map.md", [], true), "new/docs/module-map.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "README.md"), "README.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "AGENTS.md"), "docs/README.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "docs/AGENTS.md"), "docs/index.md");
  assertModuleKnowledgePath({ knowledge_layout: "directory-v1" }, { docs_path: "docs/订单" }, "docs/订单/module-map.md");
  assert.throws(() => assertModuleKnowledgePath({ knowledge_layout: "directory-v1" }, { docs_path: "docs/订单" }, "docs/订单/../secret.md"), /相对路径/);
  assert.throws(() => assertModuleKnowledgePath({ knowledge_layout: "directory-v1" }, { docs_path: "docs/订单" }, "docs/订单/AGENTS.md"), /不生成 AGENTS/);
});

test("模块候选使用可读代码仓目录，显式选择的真实子目录不被当作包装剥离", async () => {
  const f = await domainArchiveFixture("repository-layout-new-"); f.module("orders", "订单管理", "团队知识/订单");
  const service = f.manager(async input => { input.save({ id: "entry", title: "入口", target_id: "repo-1", path: `${input.job.repositories[0].docs_path}/README.md`, layer: "repository", content: "# 订单模块", sources: "源码" }); return "完成"; });
  try {
    let job = await done(service, service.create({ module_id: "orders", issue_no: "REQ-repository", baseline_branch: "main" }, "user").id);
    assert.equal(job.knowledge_target.docs_path, "团队知识/订单"); assert.equal(job.repositories[0].docs_path, "docs/订单管理");
    const path = "docs/订单管理/FMProductFrontendService/docs/custom.md";
    job = service.configureArchive(job.id, { base_revision: 0, use_directory_layout: true, targets: [job.repositories[0]], documents: [{ id: "entry", path }] });
    assert.equal(job.documents[0].path, path); await submit(service, job.id);
    const publication = publicationFor(service.get(job.id), "repo-1"); assert.equal(f.content(f.code, publication.branch, path), "# 订单模块");
    assert.ok(f.content(f.code, publication.branch, "AGENTS.md").includes(path)); assert.equal(listKnowledgeDocuments(f.dataDir).length, 0);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("旧包装路径迁到可读目录后可往返调整，保留原候选编号、相对链接和失败批次", async () => {
  const f = await domainArchiveFixture("repository-layout-old-"); f.module("orders", "订单管理", "团队知识/订单"); let executions = 0;
  let service = f.manager(async input => { executions++; for (const id of ["map", "rules"]) input.save({ id, title: id, target_id: "repo-1", path: `${input.job.repositories[0].docs_path}/${id}.md`, layer: "repository", content: id === "map" ? "# 功能索引\n[规则](rules.md)" : "# 规则\n[索引](map.md)", sources: "源码" }); return "完成"; });
  try {
    let job = await done(service, service.create({ module_id: "orders", issue_no: "REQ-old-repository", baseline_branch: "main" }, "user").id); await service.shutdown();
    const file = join(f.dataDir, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    stored.knowledge_layout = "module-v1"; stored.repositories[0].docs_path = "docs/knowledge/orders"; stored.repositories[0].name = "FMProductFrontendService";
    stored.documents.forEach(document => { document.path = `docs/knowledge/orders/FMProductFrontendService/docs/${document.id}.md`; });
    const batch = { id: "old-failed", state: "failed" as const, created_at: new Date().toISOString(), operator: "user", knowledge_layout: "module-v1" as const,
      issue_no: "REQ-old-repository", documents: structuredClone(stored.documents), targets: structuredClone(stored.repositories), publications: [] };
    stored.archive_batches = [batch]; writeFileSync(file, JSON.stringify(stored));
    service = f.manager(async () => { throw new Error("目录整理不能重新研究"); });
    job = service.configureArchive(job.id, { base_revision: 0, use_directory_layout: true, targets: [{ ...stored.repositories[0], docs_path: "docs/订单管理" }] });
    assert.deepEqual(job.documents.map(document => document.path), ["docs/订单管理/map.md", "docs/订单管理/rules.md"]);
    assert.deepEqual(job.documents.map(document => document.id), stored.documents.map(document => document.id)); assert.deepEqual(job.archive_batches!.find(item => item.id === batch.id), batch);
    assert.deepEqual(job.source_repositories, stored.source_repositories); assert.deepEqual(job.turns, stored.turns); assert.equal(executions, 1);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_directory_layout: true, targets: [{ ...job.repositories[0], docs_path: "docs/存档/订单" }] });
    assert.equal(job.documents[0].path, "docs/存档/订单/map.md"); assert.match(job.documents[0].content, /\[规则\]\(rules\.md\)/);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_directory_layout: true, targets: [{ ...job.repositories[0], docs_path: "docs/订单管理" }] });
    assert.equal(job.documents[0].path, "docs/订单管理/map.md"); const revisions = job.documents.map(document => document.revision);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_directory_layout: true, targets: [job.repositories[0]] });
    assert.deepEqual(job.documents.map(document => document.revision), revisions); await submit(service, job.id);
    const publication = publicationFor(service.get(job.id), "repo-1"); for (const document of job.documents) assert.equal(f.content(f.code, publication.branch, document.path), document.content.trim());
    assert.equal(executions, 1);
  } finally { await service.shutdown(); await f.cleanup(); }
});
