import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { assertModuleKnowledgePath, moduleKnowledgeDirectory, moduleKnowledgePath } from "../src/domainKnowledgeLayout.ts";
import { listKnowledgeDocuments, listFormalKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { completedDomainTask as done, domainArchiveFixture, publicationFor, submitDomainCandidates as submit } from "./fixtures/domainKnowledgeArchive.ts";

test("模块目录映射保持幂等，导航迁入普通文稿且不折叠目录外结构", () => {
  assert.equal(moduleKnowledgeDirectory("docs/knowledge", "orders"), "docs/knowledge/orders");
  assert.equal(moduleKnowledgeDirectory("docs/knowledge/orders/", "orders"), "docs/knowledge/orders");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "AGENTS.md"), "docs/orders/README.md");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "docs/nested/rules.md"), "docs/orders/nested/rules.md");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "guides/nested/rules.md"), "docs/orders/guides/nested/rules.md");
  assert.equal(moduleKnowledgePath("docs/shared", "docs/shared/orders", "docs/shared/orders/custom.md"), "docs/shared/orders/custom.md");
  assert.equal(moduleKnowledgePath("docs/", "docs/orders/", "docs/topic/AGENTS.md"), "docs/orders/topic/index.md");
  assert.throws(() => moduleKnowledgeDirectory("../docs", "orders"), /相对路径/);
  const job = { module_id: "orders", knowledge_layout: "module-v1" as const }, target = { docs_path: "docs/knowledge/orders" };
  assertModuleKnowledgePath(job, target, "docs/knowledge/orders/README.md");
  for (const path of ["AGENTS.md", "docs/knowledge/other/rules.md", "docs/knowledge/orders/../other/rules.md"]) assert.throws(() => assertModuleKnowledgePath(job, target, path), /本模块文稿/);
  assert.throws(() => assertModuleKnowledgePath(job, target, "docs/knowledge/orders/topic/AGENTS.md"), /不生成 AGENTS/);
});

test("共享代码仓只保留一个根 AGENTS，多模块导航并存，正式正文须合入 Git 后同步", async () => {
  const f = await domainArchiveFixture("domain-layout-shared-");
  const service = f.manager(async input => {
    assert.throws(() => input.save({ id: "bad", title: "根入口", target_id: "repo-1", path: "AGENTS.md", layer: "repository", content: "规则", sources: "源码" }), /不生成 AGENTS|文稿须/);
    for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id, title: `${input.job.module_id}说明`, target_id: target.id,
      path: `${target.docs_path}/README.md`, layer: target.id === "domain" ? "domain" : "repository", content: `# ${input.job.module_id}`, sources: "源码" });
    return "完成";
  });
  try {
    const jobs: DomainKnowledgeJob[] = [];
    for (const id of ["orders", "shipping"]) {
      f.module(id);
      const job = await done(service, service.create({ module_id: id, issue_no: `REQ-${id}`, baseline_branch: "main" }, "user").id);
      assert.equal(job.knowledge_layout, "directory-v1"); assert.equal(job.repositories[0].docs_path, `docs/${id}`);
      assert.equal(job.knowledge_target.docs_path, `domains/${id}`);
      await submit(service, job.id); const submitted = service.get(job.id); jobs.push(submitted);
      const beforeMerge = listFormalKnowledgeDocuments(f.dataDir);
      assert.equal(listKnowledgeDocuments(f.dataDir).length, 0);
      assert.equal(beforeMerge.filter(document => document.scope === "module" && document.module_ids.includes(id)).length, 0);
      assert.equal(beforeMerge.some(document => document.scope === "repository" && document.source?.path === `docs/${id}/README.md`), false);
      f.merge(publicationFor(submitted), f.knowledge); f.merge(publicationFor(submitted, "repo-1"), f.code);
      assert.equal((await f.sync(id)).state, "ready");
      const formal = listFormalKnowledgeDocuments(f.dataDir);
      assert.ok(formal.some(document => document.scope === "module" && document.module_ids.includes(id) && document.source?.path === `domains/${id}/README.md`));
      const expectedModules = jobs.map(job => job.module_id!).sort();
      assert.deepEqual(formal.filter(document => document.scope === "repository" && document.source?.path === `docs/${id}/README.md`)
        .map(document => document.module_ids), [expectedModules]);
      for (const document of formal.filter(document => document.scope === "repository")) assert.deepEqual(document.module_ids, expectedModules);
    }
    const root = f.content(f.code, "main", "AGENTS.md");
    assert.ok(root.includes("docs/orders/README.md")); assert.ok(root.includes("docs/shipping/README.md"));
    const agentFiles = f.git("-C", f.code, "ls-tree", "-r", "--name-only", "main").split("\n").filter(path => /(?:^|\/)AGENTS\.md$/i.test(path));
    assert.deepEqual(agentFiles, ["AGENTS.md"]); assert.notEqual(jobs[0].documents[1].path, jobs[1].documents[1].path);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("旧完成任务整理路径保留编号、历史、来源与工作记录，不再研究也不写平台副本", async () => {
  const f = await domainArchiveFixture("domain-layout-legacy-"); f.module("orders"); let executions = 0;
  let service = f.manager(async input => { executions++; for (const id of ["agents", "rules", "extra", "topic"]) input.save({ id, title: id, target_id: "repo-1",
    path: `${input.job.repositories[0].docs_path}/draft-${id}.md`, layer: "repository", content: `# ${id}`, sources: "源码" }); return "完成"; });
  try {
    let job = await done(service, service.create({ title: "旧研究", scope: "业务规则", issue_no: "REQ-legacy", repositories: [{ repository: f.code, branch: "main", docs_path: "docs/knowledge" }],
      knowledge_target: { repository: f.knowledge, branch: "main", docs_path: "domains/orders" } }, "user").id);
    await service.shutdown();
    const file = join(f.dataDir, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    stored.module_id = "orders"; delete stored.knowledge_layout; stored.repositories[0].docs_path = "docs/knowledge";
    const paths = ["AGENTS.md", "docs/knowledge/rules.md", "guides/nested.md", "docs/knowledge/topic/AGENTS.md"];
    const bodies = ['# 入口\n[规则](docs/knowledge/rules.md)\n[源码](src/order.ts#cancel)\n[外部](https://example.test/x)\n[复杂](docs/knowledge/a(b(c)).md)\n`[示例](docs/knowledge/rules.md)`\n~~~md\n[示例](docs/knowledge/rules.md)\n~~~',
      '# 规则\n[入口](../../AGENTS.md)\n[说明][entry]\n[entry]: ../../AGENTS.md "模块说明"', "# 补充\n[入口](../AGENTS.md)", "# 专题\n[规则](../rules.md)"];
    stored.documents.forEach((document, index) => { document.path = paths[index]; document.content = bodies[index]; });
    writeFileSync(file, JSON.stringify(stored));
    const work = join(f.dataDir, "domain-extraction", job.id, "skill-runs", job.turns[0].id, "work.json"); mkdirSync(join(work, ".."), { recursive: true });
    const workBytes = JSON.stringify({ version: 1, steps: [], documents: [{ id: "plan", title: "完整规划", content: "研究已完成" }] }); writeFileSync(work, workBytes);
    service = f.manager(async () => { executions++; throw new Error("目录整理不能重新研究"); });
    job = service.configureArchive(job.id, { base_revision: 0, use_directory_layout: true,
      targets: [{ ...stored.knowledge_target, docs_path: "domains/orders" }, { ...stored.repositories[0], docs_path: "docs/orders" }] });
    assert.equal(job.knowledge_layout, "directory-v1"); assert.equal(job.status, "done"); assert.equal(executions, 1);
    assert.deepEqual(job.documents.map(document => document.id), ["agents", "rules", "extra", "topic"]);
    assert.deepEqual(job.documents.map(document => document.path), ["docs/orders/README.md", "docs/orders/rules.md", "docs/orders/guides/nested.md", "docs/orders/topic/README.md"]);
    assert.deepEqual(job.turns, stored.turns); assert.deepEqual(job.source_repositories, stored.source_repositories); assert.equal(readFileSync(work, "utf8"), workBytes);
    assert.ok(job.documents.every(document => document.history[0].content === bodies[stored.documents.findIndex(old => old.id === document.id)]));
    assert.match(job.documents[0].content, /\[规则\]\(rules\.md\)/); assert.match(job.documents[0].content, /\[源码\]\(\.\.\/\.\.\/src\/order\.ts#cancel\)/);
    assert.ok(job.documents[0].content.includes("[复杂](docs/knowledge/a(b(c)).md)")); assert.ok(job.documents[0].content.includes("`[示例](docs/knowledge/rules.md)`"));
    assert.ok(job.documents[0].content.includes("~~~md\n[示例](docs/knowledge/rules.md)\n~~~")); assert.match(job.documents[1].content, /\[entry\]: README\.md/);
    await submit(service, job.id); const publication = publicationFor(service.get(job.id), "repo-1");
    for (const document of job.documents) assert.equal(f.content(f.code, publication.branch, document.path), document.content.trim());
    assert.equal(listKnowledgeDocuments(f.dataDir).length, 0); await service.shutdown(); service = f.manager(async () => { throw new Error("重启不能重新研究"); });
    assert.equal(service.get(job.id).status, "done"); assert.equal(readFileSync(work, "utf8"), workBytes); assert.equal(executions, 1);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("旧根入口与已有 README 撞名时自动避让，未选文稿和相对链接仍完整保留", async () => {
  const f = await domainArchiveFixture("domain-layout-collision-"); f.module("orders");
  let service = f.manager(async input => { for (const id of ["agents", "readme", "topic", "index"]) input.save({ id, title: id, target_id: "domain", path: `${input.job.knowledge_target.docs_path}/draft-${id}.md`, layer: "domain", content: `# ${id}`, sources: "资料" }); return "完成"; });
  try {
    let job = await done(service, service.create({ module_id: "orders", issue_no: "REQ-collision", baseline_branch: "main" }, "user").id); await service.shutdown();
    const file = join(f.dataDir, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    delete stored.knowledge_layout; stored.knowledge_target.docs_path = "legacy";
    const paths = ["AGENTS.md", "legacy/README.md", "legacy/topic/AGENTS.md", "legacy/topic/index.md"];
    stored.documents.forEach((document, index) => { document.path = paths[index]; document.selected = index % 2 === 0; });
    stored.documents[0].content = "# 原入口\n[说明](legacy/README.md)\n[专题](legacy/topic/AGENTS.md)"; writeFileSync(file, JSON.stringify(stored));
    service = f.manager(async () => { throw new Error("目录避让不能重新研究"); });
    job = service.configureArchive(job.id, { base_revision: 0, use_directory_layout: true, targets: [{ ...stored.knowledge_target, docs_path: "domains/orders" }] });
    assert.equal(new Set(job.documents.map(document => document.path.toLowerCase())).size, 4);
    assert.ok(job.documents.every(document => !/(?:^|\/)AGENTS\.md$/i.test(document.path)));
    assert.deepEqual(job.documents.map(document => document.selected), [true, false, true, false]);
    const readme = job.documents.find(document => document.id === "readme")!, topic = job.documents.find(document => document.id === "topic")!;
    assert.ok(job.documents[0].content.includes(readme.path.slice("domains/orders/".length))); assert.ok(job.documents[0].content.includes(topic.path.slice("domains/orders/".length)));
    const preview = service.previewArchive(job.id); assert.deepEqual(preview.targets.flatMap(target => target.files).map(file => file.id), ["agents", "topic"]);
    service.select(job.id, ["readme", "index"], true); await submit(service, job.id);
    const publication = publicationFor(service.get(job.id)); for (const document of job.documents) assert.ok(f.exists(f.knowledge, publication.branch, document.path));
    assert.equal(service.get(job.id).documents.length, 4); assert.equal(listKnowledgeDocuments(f.dataDir).length, 0);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("Git 检视在创建 MR 前改名仍保留基线，续推删除只作用于指定文件", async () => {
  const f = await domainArchiveFixture("domain-layout-rename-"); f.module("orders");
  const service = f.manager(async input => {
    if (input.turn.mode === "extract") for (const id of ["rules", "readme"]) input.save({ id, title: id, target_id: "domain", path: `${input.job.knowledge_target.docs_path}/${id}.md`, layer: "domain", content: `# ${id}`, sources: "资料" });
    else for (const id of input.turn.document_ids) input.remove!(id);
    return "完成";
  });
  try {
    const first = await done(service, service.create({ module_id: "orders", issue_no: "REQ-rename", baseline_branch: "main" }, "user").id); await submit(service, first.id);
    f.merge(publicationFor(service.get(first.id)), f.knowledge); await f.sync("orders");
    const formal = listFormalKnowledgeDocuments(f.dataDir).find(document => document.source?.path === "domains/orders/rules.md")!;
    let inspection = service.beginInspection(formal.id, { issue_no: "REQ-rename-review", module_id: "orders" }, "user");
    inspection = service.configureArchive(inspection.id, { base_revision: 0, use_directory_layout: true, targets: [inspection.knowledge_target], documents: [{ id: formal.id, path: "domains/orders/renamed.md" }] });
    const renamed = inspection.documents.find(document => document.id === formal.id)!;
    assert.equal(renamed.base_content, formal.content); assert.equal(renamed.base_path, "domains/orders/rules.md");
    service.finishInspection(inspection.id); await submit(service, inspection.id); const before = publicationFor(service.get(inspection.id));
    assert.equal(f.exists(f.knowledge, before.branch, "domains/orders/rules.md"), false); assert.equal(f.content(f.knowledge, before.branch, "domains/orders/renamed.md"), "# rules");
    const removed = inspection.documents.find(document => document.path === "domains/orders/readme.md")!;
    service.run(inspection.id, { mode: "revise", document_ids: [removed.id], message: "删除过时说明" }, "user"); await done(service, inspection.id); await submit(service, inspection.id);
    const after = publicationFor(service.get(inspection.id)); assert.equal(after.url, before.url); assert.equal(after.branch, before.branch);
    assert.equal(f.exists(f.knowledge, after.branch, removed.path), false); assert.equal(f.content(f.knowledge, after.branch, "domains/orders/renamed.md"), "# rules");
    assert.ok(service.get(inspection.id).documents.find(document => document.id === removed.id)!.deleted);
  } finally { await service.shutdown(); await f.cleanup(); }
});

test("Git 检视改名后原文件被外部修改时拒绝覆盖，任务文稿和原 Git 内容均保留", async () => {
  const f = await domainArchiveFixture("domain-layout-conflict-"); f.module("orders");
  const service = f.manager(async input => { input.save({ id: "rules", title: "规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "# 原规则", sources: "资料" }); return "完成"; });
  try {
    const first = await done(service, service.create({ module_id: "orders", issue_no: "REQ-conflict", baseline_branch: "main" }, "user").id); await submit(service, first.id);
    f.merge(publicationFor(service.get(first.id)), f.knowledge); await f.sync("orders");
    const formal = listFormalKnowledgeDocuments(f.dataDir).find(document => document.source?.path === "domains/orders/rules.md")!;
    let inspection = service.beginInspection(formal.id, { issue_no: "REQ-conflict-review", module_id: "orders" }, "user");
    inspection = service.configureArchive(inspection.id, { base_revision: 0, use_directory_layout: true, targets: [inspection.knowledge_target], documents: [{ id: formal.id, path: "domains/orders/new.md" }] }); service.finishInspection(inspection.id);
    f.git("-C", f.source, "fetch", f.knowledge, "main"); f.git("-C", f.source, "checkout", "-B", "external", "FETCH_HEAD");
    writeFileSync(join(f.source, "domains/orders/rules.md"), "# 他人修改"); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-qm", "external"); f.git("-C", f.source, "push", f.knowledge, "HEAD:main");
    const preview = await submit(service, inspection.id); assert.equal(preview.status_label, "MR 创建失败"); assert.match(JSON.stringify(preview), /原文件.*已被修改|已变化/);
    assert.equal(f.content(f.knowledge, "main", "domains/orders/rules.md"), "# 他人修改"); assert.equal(f.exists(f.knowledge, "main", "domains/orders/new.md"), false);
    assert.equal(service.get(inspection.id).documents.find(document => document.id === formal.id)!.content, "# 原规则");
  } finally { await service.shutdown(); await f.cleanup(); }
});
