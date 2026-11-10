import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { listFormalKnowledgeDocuments, readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { completedDomainTask as done, domainArchiveFixture, publicationFor, submitDomainCandidates as submit } from "./fixtures/domainKnowledgeArchive.ts";

const moduleId = "module-12345678-1234-1234-1234-123456789abc", moduleName = "无线产品管理";

test("未填写模块路径时默认目录贯穿新任务、预览、真实 Git MR 与合入后正式快照，空格不丢失且不重复拼接", async () => {
  const f = await domainArchiveFixture("readable-default-path-");
  const name = "Access Core 业务", id = "module-default-path", expected = `Function_Knowledge/Access Function/${name}`;
  const module = createBusinessModule(f.dataDir, { id, name, description: "默认领域知识目录", owner: "user", repositories: [f.code] }, "user");
  const service = f.manager(async input => { input.save({ id: "readme", title: "领域入口", target_id: "domain", layer: "domain", path: `${input.job.knowledge_target.docs_path}/README.md`, content: "# 默认目录中的正式规则", sources: "资料" }); return "完成"; });
  try {
    assert.equal(module.knowledge_path, expected);
    const job = await done(service, service.create({ module_id: id, issue_no: "REQ-DEFAULT-PATH", baseline_branch: "main" }, "user").id);
    assert.equal(job.knowledge_target.repository, f.knowledge); assert.equal(job.knowledge_target.branch, "main"); assert.equal(job.knowledge_target.docs_path, expected);
    const preview = service.previewArchive(job.id);
    assert.deepEqual(preview.targets.find(target => target.id === "domain")!.files.map(file => file.path), [`${expected}/README.md`]);
    await submit(service, job.id); const publication = publicationFor(service.get(job.id));
    assert.equal(f.content(f.knowledge, publication.branch, `${expected}/README.md`), "# 默认目录中的正式规则");
    assert.equal(f.exists(f.knowledge, publication.branch, `${expected}/${name}/README.md`), false);
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 0);
    f.merge(publication, f.knowledge); await f.sync(id);
    const formal = listFormalKnowledgeDocuments(f.dataDir).find(document => document.source?.path === `${expected}/README.md`)!;
    assert.ok(formal); assert.equal(formal.source!.repository, f.knowledge); assert.equal(formal.source!.branch, "main"); assert.equal(formal.content, "# 默认目录中的正式规则");
    assert.deepEqual(formal.module_ids, [id]);
  } finally { await service.shutdown(); await f.cleanup(); }
});
async function legacy(f: Awaited<ReturnType<typeof domainArchiveFixture>>, pending = false) {
  f.module(moduleId, moduleName, `团队知识/${moduleName}`);
  const initial = f.manager(async input => { for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id === "domain" ? "domain" : "map", title: target.id === "domain" ? moduleId : "模块索引", target_id: target.id,
    path: `${target.docs_path}/${target.id === "domain" ? "README" : "module-map"}.md`, layer: target.id === "domain" ? "domain" : "repository", content: target.id === "domain" ? "# 已完成领域研究" : "# 已完成仓内研究", sources: "已核对资料和源码" }); return "完成"; });
  const job = await done(initial, initial.create({ module_id: moduleId, issue_no: "REQ-readable", baseline_branch: "main" }, "user").id); await initial.shutdown();
  const file = join(f.dataDir, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
  stored.knowledge_layout = "module-v1"; stored.knowledge_target.docs_path = `domains/${moduleId}`; stored.repositories[0].docs_path = `docs/knowledge/${moduleId}`; stored.repositories[0].name = "FMProductFrontendService";
  for (const document of stored.documents) {
    document.path = document.target_id === "domain" ? `domains/${moduleId}/README.md` : `docs/knowledge/${moduleId}/FMProductFrontendService/docs/module-map.md`;
    const target = document.target_id === "domain" ? stored.knowledge_target : stored.repositories[0];
    const old = saveKnowledgeDocument(f.dataDir, { title: document.title, content: document.content, scope: "module", module_ids: [moduleId],
      archive_target: { repository: target.repository, branch: target.branch, path: document.path }, research_source: { job_id: job.id, document_id: document.id, repository: target.repository, branch: target.branch, path: document.path } }, "user");
    document.knowledge_document_id = old.id; document.published_revision = old.revision; document.published_document_revision = document.revision;
  }
  if (pending) stored.turns[0].proposals.push({ status: "pending", base_revision: 1, document: { ...stored.documents[0], content: "# 检视修订后的规则" } });
  stored.archive_batches = [{ id: "old-frozen", state: "failed", knowledge_layout: "module-v1", created_at: new Date().toISOString(), operator: "user", issue_no: "REQ-readable-old",
    targets: structuredClone([stored.knowledge_target, ...stored.repositories]), documents: structuredClone(stored.documents), publications: [] }];
  writeFileSync(file, JSON.stringify(stored));
  const work = join(f.dataDir, "domain-extraction", job.id, "skill-runs", job.turns[0].id, "work.json"); mkdirSync(join(work, ".."), { recursive: true });
  const workBytes = JSON.stringify({ version: 1, steps: [], documents: [{ id: "plan", title: "原规划", content: "原研究和规划已完成" }] }); writeFileSync(work, workBytes);
  const skill = join(f.dataDir, "domain-extraction", job.id, "skill.json"), skillBytes = JSON.stringify({ name: "old-method", digest: "pinned", files: { "SKILL.md": "原研究方法" } }); writeFileSync(skill, skillBytes);
  return { stored, work, workBytes, skill, skillBytes };
}

test("长期目录配置一次后新任务持续使用精确可读路径，不追加模块编号或重复包装", async () => {
  const f = await domainArchiveFixture("readable-config-"); f.module(moduleId, moduleName, `团队知识/${moduleName}`);
  const service = f.manager(async input => { input.save({ id: "entry", title: "领域入口", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/README.md`, layer: "domain", content: "# 领域入口", sources: "业务资料" }); return "完成"; });
  try {
    const first = await done(service, service.create({ module_id: moduleId, issue_no: "REQ-readable", baseline_branch: "main" }, "user").id);
    const second = await done(service, service.create({ module_id: moduleId, issue_no: "REQ-readable", baseline_branch: "main" }, "user").id);
    assert.notEqual(first.id, second.id); assert.equal(first.knowledge_target.docs_path, `团队知识/${moduleName}`); assert.equal(second.knowledge_target.docs_path, first.knowledge_target.docs_path);
    assert.equal(first.repositories[0].docs_path, `docs/${moduleName}`); assert.ok(!JSON.stringify([first.knowledge_target.docs_path, first.repositories[0].docs_path]).includes(moduleId));
    assert.throws(() => service.configureArchive(first.id, { base_revision: 0, use_directory_layout: true, targets: [{ ...first.knowledge_target, docs_path: "其他目录" }] }), /长期配置/);
    saveKnowledgeRepoConfig(f.dataDir, f.knowledge, { branch: "main", docs_path: `domains/${moduleId}` });
    const global = await done(service, service.create({ title: "全局知识", scope: "资料", repositories: [], issue_no: "REQ-global" }, "user").id);
    assert.equal(global.knowledge_target.docs_path, "docs/全局知识"); assert.equal(global.knowledge_layout, "directory-v1");
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("旧完成任务改可读路径后直接创建候选 MR，原平台记录及旧失败批次仍完整保留", async () => {
  const f = await domainArchiveFixture("readable-old-"); const original = await legacy(f);
  const service = f.manager(async () => { throw new Error("已完成研究不能重跑"); });
  try {
    const before = service.get(original.stored.id), oldRecords = before.documents.map(document => readKnowledgeDocument(f.dataDir, document.knowledge_document_id!));
    const configured = service.configureArchive(before.id, { base_revision: 0, use_directory_layout: true,
      targets: [{ ...before.knowledge_target, docs_path: `团队知识/${moduleName}` }, { ...before.repositories[0], docs_path: `docs/${moduleName}` }] });
    assert.equal(configured.knowledge_layout, "directory-v1"); assert.deepEqual(configured.documents.map(document => document.path), [`团队知识/${moduleName}/README.md`, `docs/${moduleName}/module-map.md`]);
    assert.equal(configured.documents[0].title, moduleName); assert.deepEqual(configured.documents.map(document => document.knowledge_document_id), before.documents.map(document => document.knowledge_document_id));
    assert.deepEqual(configured.turns, before.turns); assert.deepEqual(configured.archive_batches!.find(batch => batch.id === "old-frozen"), original.stored.archive_batches![0]);
    assert.equal(readFileSync(original.work, "utf8"), original.workBytes); assert.equal(readFileSync(original.skill, "utf8"), original.skillBytes);
    const preview = service.previewArchive(before.id); await assert.rejects(service.createArchive(before.id, { issue_no: "REQ-readable", expected_revisions: {} }, "user"), /文稿已有新版本/);
    assert.deepEqual(service.previewArchive(before.id), preview); assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 0);
    await submit(service, before.id); const job = service.get(before.id); assert.equal(job.status, "done");
    for (const target of [job.knowledge_target, ...job.repositories]) f.merge(publicationFor(job, target.id), target.repository);
    assert.equal((await f.sync(moduleId)).state, "ready");
    assert.ok(listFormalKnowledgeDocuments(f.dataDir).some(document => document.source?.path === `团队知识/${moduleName}/README.md`));
    oldRecords.forEach(old => assert.deepEqual(readKnowledgeDocument(f.dataDir, old.id), old));
    await service.retryArchive(job.id, "user", { batch_id: "old-frozen" }); const retried = service.get(job.id).archive_batches!.find(batch => batch.id === "old-frozen")!;
    assert.equal(retried.state, "done"); assert.deepEqual(retried.documents, original.stored.documents); assert.equal(retried.knowledge_layout, "module-v1");
    assert.ok(retried.publications.every(publication => publication.documents.every(document => document.path.includes(moduleId))));
  } finally { await service.shutdown(); await f.cleanup(); }
});

for (const pending of [false, true]) test(`候选 MR 直接包含${pending ? "已完成检视建议" : "人工修改"}，不再要求先发布本地副本`, async () => {
  const f = await domainArchiveFixture("readable-candidate-"); const original = await legacy(f, pending);
  const service = f.manager(async () => { throw new Error("提交候选不能重新研究"); });
  try {
    let job = service.get(original.stored.id);
    if (!pending) job = service.edit(job.id, { document: { ...job.documents[0], content: "# 人工修改后的规则" }, base_revision: 1 }, "user");
    job = service.configureArchive(job.id, { base_revision: 0, use_directory_layout: true, targets: [{ ...job.knowledge_target, docs_path: `团队知识/${moduleName}` }, { ...job.repositories[0], docs_path: `docs/${moduleName}` }] });
    const baseline = readKnowledgeDocument(f.dataDir, job.documents[0].knowledge_document_id!);
    const preview = service.previewArchive(job.id), expected = pending ? "# 检视修订后的规则" : "# 人工修改后的规则";
    assert.equal(preview.targets.find(target => target.id === "domain")!.files[0].content, expected);
    if (pending) assert.equal(service.get(job.id).turns[0].proposals[0].status, "pending", "预览不能直接改写任务");
    await assert.rejects(service.publish(job.id, "user"), /直接创建 MR/); await submit(service, job.id);
    const current = service.get(job.id), publication = publicationFor(current);
    assert.equal(f.content(f.knowledge, publication.branch, current.documents[0].path), expected); assert.deepEqual(readKnowledgeDocument(f.dataDir, baseline.id), baseline);
    if (pending) assert.equal(current.turns[0].proposals[0].status, "accepted"); assert.equal(readFileSync(original.skill, "utf8"), original.skillBytes);
  } finally { await service.shutdown(); await f.cleanup(); }
});
