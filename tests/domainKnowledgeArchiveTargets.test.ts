import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";

const source = { repository: "https://example.test/source.git", name: "业务仓", branch: "main" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.get(id); if (job.status === "done") return job; if (job.status === "failed") throw new Error(job.error); await new Promise(r => setTimeout(r, 5)); }
  throw new Error("萃取未完成");
}
test("生产线验收5/14：候选直接创建 MR，Skill 默认值、归档路径重映射与源码研究范围保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-targets-"));
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id, title: target.name, target_id: target.id, path: target.docs_path === "." ? "docs/rules.md" : `${target.docs_path}/rules.md`, layer: target.id === "domain" ? "domain" : "repository", content: "# 规则\n人工内容", sources: "源码" });
    else {
      assert.equal(input.job.source_repositories?.[0].repository, source.repository);
      assert.equal(input.job.source_repositories?.[0].branch, "release/current");
      for (const doc of input.read()) input.save({ ...doc, content: "修订建议" });
    }
    return "done";
  }, {
    publish: async (job, target) => ({ target_id: target.id, state: "opened", url: "https://example.test/mr/1", branch: "codex/knowledge-test", documents: job.documents.filter(d => d.target_id === target.id).map(d => ({ id: d.id, path: d.path, revision: d.revision, content: d.content })) }),
  });
  try {
    const module = createBusinessModule(root, { id: "trade", name: "交易", description: "交易业务", owner: "user", repositories: [source.repository] }, "user");
    const defaults = service.create({ module_id: module.id, issue_no: "REQ-default" }, "user");
    assert.equal(defaults.repositories[0].branch, "master"); assert.equal(defaults.knowledge_target.branch, "master");
    await done(service, defaults.id);
    const initial = service.create({ module_id: module.id, baseline_branch: "release/current", issue_no: "REQ-1", instructions: "只萃取退款模块，不读取 old.md", title: "不能覆盖模块名", repositories: [{ ...source, repository: "https://example.test/unmaintained.git" }] }, "user");
    assert.equal(initial.title, module.name);
    assert.equal(initial.instructions, "只萃取退款模块，不读取 old.md");
    assert.equal(initial.repositories[0].repository, source.repository);
    assert.equal(initial.repositories[0].branch, "release/current");
    assert.match(initial.scope, /交易业务/);
    let job = await done(service, initial.id);
    assert.equal(job.archive_configured, false); assert.equal(job.knowledge_target.repository, "");
    assert.equal(job.knowledge_layout, "directory-v1");
    assert.deepEqual(job.documents.map(d => d.path), ["docs/交易/rules.md", "docs/交易/rules.md"]);
    assert.ok(service.get(job.id).documents.every(d => !d.knowledge_document_id), "任务候选尚未成为正式知识");
    const unconfigured = service.previewArchive(job.id);
    assert.ok(unconfigured.targets.length > 1);
    assert.deepEqual(unconfigured.targets.map(target => target.actions.map(action => action.id)), unconfigured.targets.map(target => target.configured ? [] : ["configure"]), "多仓时设置入口只放在未配置的仓旁边");
    assert.ok(!unconfigured.actions.some(action => action.id === "configure"), "多仓时底部不再重复设置入口");
    assert.throws(() => service.configureArchive(job.id, { targets: [{ ...job.knowledge_target, docs_path: "../bad" }], base_revision: 0 }), /仓库地址|路径/);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [{ ...job.knowledge_target, repository: "https://example.test/knowledge.git" }, ...job.repositories] });
    service.run(job.id, { mode: "revise", document_ids: job.documents.map(d => d.id), message: "补充" }, "user");
    job = await done(service, job.id);
    const sources = structuredClone(job.source_repositories);
    const targets = [{ ...job.knowledge_target, docs_path: "new/domain" }, { ...job.repositories[0], repository: "https://example.test/archive.git", branch: "docs", docs_path: "docs/new/repo" }];
    const before = service.get(job.id);
    assert.throws(() => service.configureArchive(job.id, { targets, base_revision: 0 }), /已被修改/);
    assert.throws(() => service.configureArchive(job.id, { targets: [targets[0], targets[0]], base_revision: 1 }), /重复/);
    assert.deepEqual(service.get(job.id), before, "failed configuration is atomic");
    job = service.configureArchive(job.id, { targets, base_revision: 1 });
    assert.deepEqual(job.source_repositories, sources);
    assert.equal(job.documents[0].base_revision, "");
    assert.deepEqual(job.documents.map(d => d.path), ["new/domain/rules.md", "docs/new/repo/rules.md"]);
    assert.deepEqual(job.turns.at(-1)!.proposals.map(p => p.document.path), job.documents.map(d => d.path));
    assert.deepEqual(job.turns.at(-1)!.proposals.map(p => p.base_revision), job.documents.map(d => d.revision), "目录调整后修订建议仍绑定对应文稿版本");
    assert.ok(job.documents.every(d => d.content.includes("人工内容")));
    for (const proposal of job.turns.at(-1)!.proposals) service.decide(job.id, job.turns.at(-1)!.id, proposal.document.id, "accept", "user");
    await service.createArchive(job.id, { issue_no: "REQ-1", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    job = service.get(job.id);
    assert.equal(job.archive_batches!.find(batch => !!batch.issue_no)!.state, "done");
    assert.equal(job.publications[1].documents[0].path, "docs/new/repo/rules.md");
    const changed = service.configureArchive(job.id, { targets: [{ ...targets[0], docs_path: "other" }], base_revision: 2 });
    assert.equal(changed.knowledge_target.docs_path, "other");
    assert.equal(changed.archive_batches!.find(batch => !!batch.issue_no)!.targets[0].docs_path, "new/domain", "已创建人工MR目标保持原样");
    service.run(job.id, { mode: "update", document_ids: job.documents.map(d => d.id), message: "核对新版本" }, "user");
    await done(service, job.id);
    const restored = new DomainKnowledgeExtraction(root, async () => "unused");
    assert.deepEqual(restored.get(job.id).source_repositories, sources); await restored.shutdown();
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("逐文件路径保持在最终目录，重复文件名自动避让，重启保留修订与路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-file-paths-"));
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      const target = input.job.knowledge_target;
      for (const name of ["entry", "rules", "extra"]) input.save({ id: name, title: name, path: `${target.docs_path}/${name}.md`, target_id: "domain", layer: "domain", content: "原稿", sources: "源码" });
      assert.throws(() => input.save({ id: "escape", title: "非法扩展", path: ".git/AGENTS.md", target_id: "domain", layer: "domain", content: "规则", sources: "源码" }), /相对路径/);
      assert.throws(() => input.save({ id: "agents", title: "导航", path: `${target.docs_path}/AGENTS.md`, target_id: "domain", layer: "domain", content: "导航", sources: "源码" }), /AGENTS.md/);
    } else for (const doc of input.read().filter(d => input.turn.document_ids.includes(d.id))) input.save({ ...doc, content: "更新建议" });
    return "done";
  });
  try {
    let job = await done(service, service.create({ issue_no: "REQ-files", title: "领域", scope: "完整研究", repositories: [source] }, "user").id);
    const directory = job.knowledge_target.docs_path, targets = [{ ...job.knowledge_target, repository: "https://example.test/knowledge.git" }];
    const before = service.get(job.id);
    for (const path of ["../AGENTS.md", ".git/rules.md", "/AGENTS.md", "code.ts"]) assert.throws(() => service.configureArchive(job.id, { targets, base_revision: 0, documents: [{ id: "entry", path }] }), /相对路径/);
    const collision = service.previewArchiveTargets(job.id, { targets, base_revision: 0, documents: [{ id: "entry", path: `${directory}/same.md` }, { id: "rules", path: `${directory}/same.md` }] });
    assert.equal(new Set(collision.documents.map(document => document.path)).size, 3, "黑盒归档对文件名碰撞自动避让");
    assert.deepEqual(service.get(job.id), before, "只预览不会保存自动避让结果");
    job = service.configureArchive(job.id, { targets, base_revision: 0, documents: [{ id: "entry", path: `${directory}/README.md` }, { id: "rules", path: `${directory}/rules/rules.md` }, { id: "extra", path: `${directory}/guides/extra.md` }] });
    assert.deepEqual(job.documents.map(d => d.path), [`${directory}/README.md`, `${directory}/rules/rules.md`, `${directory}/guides/extra.md`]);
    service.run(job.id, { mode: "revise", document_ids: ["entry"], message: "更新规范" }, "user");
    job = await done(service, job.id);
    assert.equal(job.turns.at(-1)!.proposals[0].document.path, `${directory}/README.md`);
    job = service.configureArchive(job.id, { targets, base_revision: 1, documents: [{ id: "entry", path: `${directory}/guides/README.md` }] });
    assert.equal(job.turns.at(-1)!.proposals[0].document.path, `${directory}/guides/README.md`);
    const restarted = new DomainKnowledgeExtraction(root, async () => "unused");
    assert.equal(restarted.get(job.id).documents[0].archive_path, `${directory}/guides/README.md`); await restarted.shutdown();
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
