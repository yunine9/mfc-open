import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CloudSession } from "../src/sessionDriver.ts";
import { runGenericDomainKnowledge as runDomainKnowledge } from "./helpers/extractionSkillFixture.ts";
import { DomainKnowledgeExtraction, type DomainDocumentContent, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { syncModuleKnowledge } from "../src/knowledgeRepositorySync.ts";
import { listFormalKnowledgeDocuments, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

async function finished(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 600; i++) {
    const job = service.get(id);
    if (!["queued", "running"].includes(job.status)) {
      assert.equal(job.status, "done", job.error);
      await new Promise(resolve => setTimeout(resolve, 0));
      return service.get(id);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("领域研究未在 6 秒内结束");
}

function document(job: DomainKnowledgeJob, id: string) {
  const found = job.documents.find(document => document.id === id);
  assert.ok(found, `文档 ${id} 应当保留供审查`);
  return found;
}

test("#466 真实 knowledge_draft 可新增和删除未选文档，删除直接提交 MR，重复删除与恢复不破坏正式基线及归档证据", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-document-crud-")), repo = join(root, "repo");
  const common = { target_id: "repo-1", layer: "repository" as const, sources: "repo-1:src/transfer.ts:1-1" };
  const focus: DomainDocumentContent = { ...common, id: "focus", title: "选中的文档", path: "docs/business/重点.md", content: "# 重点规则\n\n保留该业务的规则。" };
  const unselected: DomainDocumentContent = { ...common, id: "unselected", title: "未选中的文档", path: "docs/business/未选.md", content: "# 待整理规则\n\n本任务已有的其他文档。" };
  const created: DomainDocumentContent = { ...common, id: "created", title: "新增业务入口", path: "docs/business/新建未选文档.md", content: "# 新入口\n\n新增文档可以保存在当前任务目标仓的业务目录。" };
  for (const entry of [focus, unselected]) { mkdirSync(dirname(join(repo, entry.path)), { recursive: true }); writeFileSync(join(repo, entry.path), entry.content); }
  mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/transfer.ts"), "export function transfer() { return 'completed'; }\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  let phase: "extract" | "crud" | "delete-for-publish" = "extract", readonlyChecks = 0, archiveCalls = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call = async (name: string, args: unknown, error = false) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name); assert.ok(tool, name);
        const response = await tool.execute("fixture", args, new AbortController().signal);
        assert.equal(!!response.isError, error, JSON.stringify(response));
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      if (context.step) {
        readonlyChecks++;
        for (const id of [focus.id, unselected.id, created.id]) await call("knowledge_draft", { action: "read", id });
        const deletion = await call("knowledge_draft", { action: "read", id: unselected.id });
        assert.equal(deletion.deleted, true);
        await call("knowledge_draft", { action: "delete", id: focus.id }, true);
        await call("knowledge_draft", { action: "delete", id: unselected.id }, true);
        await call("knowledge_draft", { action: "save", document: { ...created, id: "readonly-new", path: "只读不应新增.md" } }, true);
        await call("knowledge_work_result", { summary: "只读步骤已核对删除草稿", document_ids: [focus.id, unselected.id, created.id], ...(context.reviewing ? { review: { pass: true, feedback: "已核对新增正文、删除标记与其他文稿保留情况" } } : {}) });
      } else if (phase === "extract") {
        await call("component_source", { action: "read", component_id: "repo-1", path: "src/transfer.ts" });
        for (const entry of [focus, unselected]) await call("knowledge_draft", { action: "save", document: entry });
        await call("knowledge_work_result", { summary: "业务文稿已保存", document_ids: [focus.id, unselected.id] });
      } else if (phase === "crud") {
        assert.deepEqual(context.selected_document_ids, [focus.id], "用户当前选择不限制同任务的文稿增删改");
        await call("knowledge_draft", { action: "save", document: created });
        const added = await call("knowledge_draft", { action: "read", id: created.id });
        assert.equal(added.path, created.path); assert.equal(added.content, created.content); assert.notEqual(added.deleted, true);
        const existing = await call("knowledge_draft", { action: "read", id: unselected.id });
        await call("knowledge_draft", { action: "save", document: { ...existing, content: "未选文档的修改建议" } });
        await call("knowledge_draft", { action: "read", id: unselected.id });
        await call("knowledge_draft", { action: "delete", id: unselected.id });
        const first = await call("knowledge_draft", { action: "read", id: unselected.id });
        assert.equal(first.deleted, true); assert.equal(first.revision, 2);
        await call("knowledge_draft", { action: "delete", id: unselected.id });
        const repeated = await call("knowledge_draft", { action: "read", id: unselected.id });
        assert.deepEqual(repeated, first, "重复删除不改变文稿或追加版本");
        assert.match(await call("knowledge_draft", { action: "delete", id: "missing" }, true), /不存在/);
        await call("knowledge_work", { action: "schedule", steps: [{ id: "readonly-crud", title: "独立回读删除标记", instructions: "只读核对草稿", depends_on: [], readonly: true, expected_document_ids: [focus.id, unselected.id, created.id], review: { instructions: "独立核对新增文稿和删除标记" } }] });
        await call("knowledge_work", { action: "run", id: "readonly-crud" });
        await call("knowledge_work_result", { summary: "新增和删除草稿已保存，等待创建 MR", document_ids: [focus.id, created.id] });
      } else {
        await call("knowledge_draft", { action: "read", id: unselected.id });
        await call("knowledge_draft", { action: "delete", id: unselected.id });
        await call("knowledge_work", { action: "schedule", steps: [{ id: "verify-deletion", title: "核对再次删除", instructions: "只读核对删除候选", readonly: true, depends_on: [], expected_document_ids: [focus.id, unselected.id, created.id], review: { instructions: "独立核对删除与保留范围" } }] });
        await call("knowledge_work", { action: "run", id: "verify-deletion" });
        await call("knowledge_work_result", { summary: "删除草稿再次准备完成", document_ids: [focus.id, created.id] });
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("已保存结果不应补充会话"); },
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root,
    model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision }) }), {
    publish: async (job, target, _previous, _operator, save) => {
      archiveCalls++;
      const publication: DomainPublication = { target_id: target.id, branch: "codex/knowledge-466-before-delete", revision, state: "opened", url: "https://example.test/mr/466-crud",
        documents: job.documents.filter(document => document.selected && document.target_id === target.id).map(document => ({ id: document.id,
          path: document.path, content: document.content, revision: document.revision, deleted: document.deleted, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
      save(publication); return publication;
    },
  });
  try {
    saveKnowledgeRepoConfig(root, repo, { branch: "main" });
    createBusinessModule(root, { id: "transfer", name: "传输正式知识", description: "Git 正式版本", owner: "expert", repositories: [repo], knowledge_path: "docs/business" }, "expert");
    assert.equal((await syncModuleKnowledge(root, "transfer", "expert")).state, "ready");
    const originalFormal = listFormalKnowledgeDocuments(root).find(document => document.source?.path === unselected.path)!;
    assert.ok(originalFormal);
    const formalId = originalFormal.id;
    let job = await finished(service, service.create({ issue_no: "466-crud", title: "完整文档维护", scope: "当前任务的文档增删改", knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" },
      repositories: [{ name: "业务仓", repository: "https://example.test/business.git", branch: "main", docs_path: "docs/business" }] }, "expert").id);
    await assert.rejects(service.publish(job.id, "expert"), /直接创建 MR/);
    assert.equal(document(job, unselected.id).knowledge_document_id, undefined, "候选不会伪造正式知识身份");
    await service.createArchive(job.id, { issue_no: "466-crud", expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    job = service.get(job.id);
    const fixed = structuredClone(job.archive_batches!.find(batch => batch.publications.some(publication => publication.state === "opened"))!);
    assert.ok(fixed); assert.equal(fixed.publications[0].documents.find(document => document.id === unselected.id)!.content, unselected.content);
    phase = "crud";
    service.run(job.id, { mode: "revise", document_ids: [focus.id], message: "新增一篇业务入口，并删除当前任务另一篇未选文档" }, "expert");
    job = await finished(service, job.id);
    assert.equal(readonlyChecks, 2);
    assert.equal(document(job, unselected.id).deleted, true); assert.equal(document(job, unselected.id).revision, 2);
    assert.equal(document(job, unselected.id).history.length, 1); assert.equal(document(job, unselected.id).history[0].path, unselected.path);
    assert.equal(document(job, unselected.id).history[0].content, unselected.content);
    assert.equal(job.turns.at(-1)!.proposals.some(proposal => proposal.document.id === unselected.id && proposal.status === "pending"), false);
    assert.equal(document(job, created.id).path, created.path); assert.equal(document(job, created.id).selected, true);
    assert.deepEqual(readKnowledgeDocument(root, formalId), originalFormal, "候选删除不改变正式知识");
    assert.equal(listFormalKnowledgeDocuments(root).length, 2);
    assert.deepEqual(job.archive_batches!.find(batch => batch.id === fixed.id), fixed, "增删改不改变原 MR 的精确证据");
    assert.equal(git("show", `${revision}:${unselected.path}`), unselected.content); assert.equal(archiveCalls, 1);
    job = service.restore(job.id, unselected.id, 1, 2, "expert");
    assert.notEqual(document(job, unselected.id).deleted, true); assert.equal(document(job, unselected.id).revision, 3);
    assert.equal(document(job, unselected.id).id, unselected.id); assert.equal(document(job, unselected.id).content, unselected.content);
    phase = "delete-for-publish";
    service.run(job.id, { mode: "revise", document_ids: [focus.id], message: "删除已检视的另一篇文稿" }, "expert");
    job = await finished(service, job.id);
    assert.equal(document(job, unselected.id).revision, 4);
    await service.createArchive(job.id, { issue_no: "466-crud", expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    job = service.get(job.id);
    assert.equal(archiveCalls, 2);
    assert.deepEqual(readKnowledgeDocument(root, formalId), originalFormal, "MR 未合入时正式知识不变");
    assert.equal(git("status", "--porcelain"), "", "MR 回执与候选删除不会直接更改正式 Git 分支");
    job = service.restore(job.id, unselected.id, 3, 4, "expert");
    assert.notEqual(document(job, unselected.id).deleted, true); assert.equal(document(job, unselected.id).revision, 5);
    const restarted = new DomainKnowledgeExtraction(root, async () => { throw new Error("完成态候选不应重跑"); });
    assert.equal(document(restarted.get(job.id), unselected.id).id, unselected.id);
    assert.equal(document(restarted.get(job.id), unselected.id).history.length, 4);
    await restarted.shutdown();
    service.run(job.id, { mode: "revise", document_ids: [focus.id], message: "最终保留删除决定" }, "expert");
    job = await finished(service, job.id);
    assert.equal(document(job, unselected.id).revision, 6);
    await service.createArchive(job.id, { issue_no: "466-crud", expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    assert.equal(archiveCalls, 3);
    assert.equal(service.get(job.id).publications[0].branch, fixed.publications[0].branch, "合入前的修订复用原 MR 分支");
    rmSync(join(repo, unselected.path)); writeFileSync(join(repo, created.path), created.content);
    git("add", "."); git("commit", "-qm", "merge selected document changes");
    assert.equal((await syncModuleKnowledge(root, "transfer", "expert")).state, "ready");
    assert.throws(() => readKnowledgeDocument(root, formalId), /不存在|删除/);
    assert.equal(listFormalKnowledgeDocuments(root).length, 2, "合入并同步后保留重点和新增入口，删除旧规则");
    assert.equal(listFormalKnowledgeDocuments(root).find(document => document.source?.path === created.path)?.content, created.content);
    assert.equal(git("show", `${revision}:${unselected.path}`), unselected.content, "历史 Git 版本仍可追溯");
    assert.equal(git("status", "--porcelain"), "");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
