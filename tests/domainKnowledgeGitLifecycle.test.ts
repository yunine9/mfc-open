import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";
import { listKnowledgeDocuments, readKnowledgeDocument, type KnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { writeGitKnowledgeSnapshot, writeModuleKnowledgeSync } from "../src/knowledgeRepositorySnapshots.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { applyKnowledgeReviewNotes, saveKnowledgeReviewNote } from "../src/knowledgeReviewNotes.ts";
import { knowledgeDocumentRoute } from "../src/knowledgeDocumentRoutes.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";
import type { TaskService } from "../src/taskService.ts";
import { gitKnowledgeResourceKey, gitKnowledgeRoot } from "../src/knowledgeRepositorySnapshots.ts";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("任务未在测试预算内完成");
}
const location = { repository: "https://example.test/domain.git", branch: "main", docs_path: "business/orders" };
function official(dir: string, text = "# 订单规则\n\n取消前检查是否支付。", revision = "a".repeat(40)) {
  const id = `kg-${createHash("sha256").update("orders").digest("hex")}`;
  const document: KnowledgeDocument = { id, title: "订单规则", content: text, scope: "module", module_ids: ["orders"], repositories: [],
    technologies: [], product_versions: [], when_to_use: "", active: true, revision: createHash("sha256").update(text).digest("hex"),
    source: { ...location, path: `${location.docs_path}/rules.md`, revision }, history: [{ at: new Date().toISOString(), operator: "git", action: "sync" }] };
  writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: new Date().toISOString(), documents: [document], resources: {},
    repositories: [{ repository: location.repository, branch: location.branch, revision }] });
  return document;
}
function module(dir: string) {
  saveKnowledgeRepoConfig(dir, location.repository, { branch: location.branch });
  return createBusinessModule(dir, { id: "orders", name: "订单", description: "订单领域", owner: "alice", repositories: ["https://example.test/orders.git"], knowledge_path: location.docs_path }, "alice");
}

test("正式知识检视创建独立任务并冻结模块全文，不依赖原萃取任务；结束检视前不运行模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-inspection-git-")); module(dir);
  const source = official(dir); let calls = 0;
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    calls++;
    assert.equal(input.turn.mode, "revise");
    assert.equal(input.job.documents[0].base_revision, "a".repeat(40));
    input.save({ ...input.job.documents[0], content: "# 订单规则\n\n已经支付不能直接取消。" });
    return "已按意见修订并完成独立评审";
  });
  try {
    const first = manager.beginInspection(source.id, { issue_no: "REQ-10", expected_revision: source.revision }, "alice");
    assert.equal(first.task_kind, "inspection"); assert.equal(first.stage, "检视中");
    assert.equal(first.turns.length, 0); assert.equal(calls, 0);
    assert.equal(first.documents[0].base_content, source.content);
    assert.equal(first.knowledge_target.docs_path, location.docs_path);
    assert.equal(first.production?.status_label, "检视中");
    const latest = official(dir, "# 仓库后来更新的正文", "b".repeat(40));
    assert.equal(manager.get(first.id).documents[0].content, source.content, "同步正式新版本不能覆盖任务基线");
    assert.equal(readKnowledgeDocument(dir, source.id).content, latest.content);
    const notes = { dataDir: dir, domain: manager, component: {} as never };
    const saved = saveKnowledgeReviewNote(notes, "domain", first.id, { document_id: source.id, scope: "line", line: 3,
      quote: "取消前检查是否支付。", note: "明确已支付时的取消限制" }, "alice");
    assert.equal(calls, 0);
    applyKnowledgeReviewNotes(notes, "domain", first.id, { note_ids: saved.notes.map(note => note.id) }, "alice");
    await until(() => manager.get(first.id).status === "done");
    assert.equal(calls, 1); assert.equal(manager.get(first.id).turns[0].proposals.length, 1);
    assert.equal(readKnowledgeDocument(dir, source.id).content, latest.content, "修改候选不能提前更新正式库");
    const second = manager.beginInspection(source.id, { issue_no: "REQ-11" }, "alice");
    assert.notEqual(second.id, first.id); assert.equal(second.documents[0].content, latest.content);
    manager.finishInspection(second.id);
    assert.equal(calls, 1); assert.equal(manager.get(second.id).production?.status_label, "检视完成，无需修改");
    await manager.shutdown();
    const restored = new DomainKnowledgeExtraction(dir, async () => { throw new Error("不能重跑"); });
    assert.equal(restored.get(first.id).documents[0].base_content, source.content);
    assert.equal(restored.get(first.id).turns.length, 1); await restored.shutdown();
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("候选直接提交 MR，修改原任务复用原 MR，不写正式库；合入后拒绝旧任务覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-candidate-mr-")); module(dir);
  const calls: Array<{ job: DomainKnowledgeJob; previous?: DomainPublication }> = [];
  let remoteState: "opened" | "merged" = "opened";
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    input.save({ id: "rules", title: "规则", target_id: "domain", layer: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`,
      content: "# 首次候选", sources: "业务资料" });
    return "研究与独立评审完成";
  }, { refreshPublication: async (_target, publication) => ({ ...publication, mr_state: remoteState }),
    publish: async (job, target, previous) => {
      calls.push({ job: structuredClone(job), previous: previous && structuredClone(previous) });
      return { target_id: target.id, branch: previous?.branch ?? "codex/knowledge-req-12", state: "opened", url: previous?.url ?? "https://example.test/mr/12",
        documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
    } });
  try {
    const job = manager.create({ module_id: "orders", issue_no: "REQ-12" }, "alice");
    await until(() => manager.get(job.id).status === "done");
    assert.equal(manager.get(job.id).knowledge_target.docs_path, location.docs_path);
    assert.equal(manager.get(job.id).production?.archive.visible, true);
    let preview = manager.previewArchive(job.id);
    assert.deepEqual(preview.expected_revisions, { rules: "1" });
    await manager.createArchive(job.id, { issue_no: "REQ-12", expected_revisions: preview.expected_revisions }, "alice");
    assert.equal(calls.length, 1); assert.equal(listKnowledgeDocuments(dir).length, 0);
    await assert.rejects(manager.publish(job.id, "alice"), /直接创建 MR/);
    const doc = manager.get(job.id).documents[0];
    manager.edit(job.id, { document: { ...doc, content: "# 继续修改的候选" }, base_revision: doc.revision }, "alice");
    preview = manager.previewArchive(job.id);
    await manager.createArchive(job.id, { issue_no: "REQ-12", expected_revisions: preview.expected_revisions }, "alice");
    assert.equal(calls.length, 2); assert.equal(calls[1].previous?.url, "https://example.test/mr/12");
    assert.equal(calls[1].previous?.branch, "codex/knowledge-req-12");
    assert.equal(manager.get(job.id).production?.status_label, "MR 待合入");
    await manager.createArchive(job.id, { issue_no: "REQ-12", expected_revisions: preview.expected_revisions }, "alice");
    assert.equal(calls.length, 2, "重复请求不能重建 MR");
    remoteState = "merged"; await manager.refreshPublicationStatus();
    assert.equal(manager.get(job.id).production?.review.readonly, true);
    assert.equal(manager.get(job.id).publications[0].documents[0].content, "# 继续修改的候选", "查询同一 MR 的历史回执不能覆盖最新提交正文");
    assert.throws(() => manager.edit(job.id, { document: { ...doc, content: "覆盖" }, base_revision: 2 }, "alice"), /已合入/);
    assert.equal(listKnowledgeDocuments(dir).length, 0);
    const newer = { ...location, docs_path: "business/orders-v2" };
    updateBusinessModule(dir, "orders", { knowledge_path: newer.docs_path }, "alice");
    assert.equal(manager.get(job.id).knowledge_target.docs_path, location.docs_path, "既有任务使用创建时配置快照");
    const next = manager.create({ module_id: "orders", issue_no: "REQ-12" }, "alice");
    assert.notEqual(next.id, job.id); assert.equal(next.knowledge_target.docs_path, newer.docs_path);
    await until(() => manager.get(next.id).status === "done");
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("正式检视纳入模块允许的所有目录，公共仓排除文稿不能靠仓地址重新纳入或发起检视", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-inspection-repository-")); module(dir);
  const domain = official(dir), code = { repository: "https://example.test/orders.git", branch: "release", revision: "c".repeat(40) };
  createBusinessModule(dir, { id: "inventory", name: "库存", description: "库存领域", owner: "bob", repositories: [code.repository] }, "bob");
  updateBusinessModule(dir, "orders", { repository_knowledge_exclusions: [{ repository: code.repository, paths: ["docs/库存", "docs/订单/private"] }] }, "alice");
  const codeDocument = (path: string): KnowledgeDocument => ({ ...domain, id: `kg-${createHash("sha256").update(path).digest("hex")}`,
    title: path, scope: "repository", module_ids: [], repositories: [code.repository], source: { ...code, path } });
  const selected = codeDocument("docs/shared/selected.md"), related = codeDocument("docs/订单/config.md"), additional = codeDocument("docs/common/integration.md");
  const unrelated = codeDocument("docs/库存/rules.md"), excluded = codeDocument("docs/订单/private/secret.md"), agents = codeDocument("AGENTS.md");
  const nestedAgents = codeDocument("docs/订单/agents.MD");
  const documents = [domain, selected, related, additional, unrelated, excluded, agents, nestedAgents];
  const now = new Date().toISOString(), repositories = [{ repository: location.repository, branch: location.branch, revision: "a".repeat(40) }, code];
  writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: now, documents, resources: {}, repositories });
  writeModuleKnowledgeSync(dir, { module_id: "orders", location, state: "ready", synced_at: now, attempted_at: now, document_count: documents.length, repositories });
  let calls = 0;
  const manager = new DomainKnowledgeExtraction(dir, async () => { calls++; return "不应运行"; });
  try {
    for (const document of [unrelated, excluded]) {
      assert.deepEqual(readKnowledgeDocument(dir, document.id).module_ids, ["inventory"], "公共仓文稿仍可由未排除它的模块阅读");
      assert.throws(() => manager.beginInspection(document.id, { module_id: "orders", issue_no: "REQ-EXCLUDED" }, "alice"), /知识范围/);
    }
    for (const navigation of [agents, nestedAgents]) {
      const inspection = manager.beginInspection(navigation.id, { module_id: "orders", issue_no: "REQ-AGENTS", expected_revision: navigation.revision }, "alice");
      assert.deepEqual(new Set(inspection.documents.map(document => document.id)), new Set([domain.id, selected.id, related.id, additional.id]));
      assert.ok(inspection.documents.some(document => document.id === inspection.inspection_source?.document_id), "检视入口定位正文，不能定位已排除的导航");
      assert.throws(() => manager.beginInspection(navigation.id, { module_id: "orders", issue_no: "REQ-STALE", expected_revision: "旧版本" }, "alice"), /知识已有新版本/);
    }
    const job = manager.beginInspection(selected.id, { module_id: "orders", issue_no: "REQ-REPO" }, "alice");
    assert.deepEqual(new Set(job.documents.map(document => document.id)), new Set([domain.id, selected.id, related.id, additional.id]));
    assert.equal(job.source_repositories?.length, 1); assert.equal(job.source_repositories?.[0].repository, code.repository);
    assert.equal(job.source_repositories?.[0].branch, "release"); assert.equal(job.revisions["repo-1"], code.revision);
    assert.equal(job.documents.find(document => document.id === selected.id)?.target_id, "repo-1");
    assert.equal(job.documents.find(document => document.id === selected.id)?.path, selected.source!.path);
    assert.equal(job.documents.find(document => document.id === selected.id)?.base_path, selected.source!.path);
    assert.equal(calls, 0);
    const notes = { dataDir: dir, domain: manager, component: {} as never };
    saveKnowledgeReviewNote(notes, "domain", job.id, { document_id: selected.id, scope: "document", note: "检查选中仓的调用条件" }, "alice");
    assert.throws(() => manager.finishInspection(job.id), /仍有未提交/);
    assert.equal(manager.get(job.id).status, "idle");
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("模块只有导航或已停用正文时不创建空检视任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-inspection-no-body-")); module(dir);
  const domain = official(dir), agents = { ...domain, id: `kg-${createHash("sha256").update("navigation").digest("hex")}`, source: { ...domain.source!, path: `${location.docs_path}/AGENTS.md` } };
  writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: new Date().toISOString(), resources: {},
    documents: [agents, { ...domain, active: false }],
    repositories: [{ repository: location.repository, branch: location.branch, revision: domain.source!.revision }] });
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("不能运行研究"); });
  try {
    assert.throws(() => manager.beginInspection(agents.id, { module_id: "orders", issue_no: "REQ-EMPTY" }, "alice"), /尚无可检视正文/);
    assert.equal(manager.list().length, 0);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("排除单篇文稿只影响新检视，已有检视保留文稿与归档路径，取消排除无需同步即可恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-inspection-scope-change-")); module(dir);
  const domain = official(dir), code = { repository: "https://example.test/orders.git", branch: "release", revision: "c".repeat(40) };
  const selected: KnowledgeDocument = { ...domain, id: `kg-${createHash("sha256").update("legacy-review").digest("hex")}`,
    scope: "repository", module_ids: [], repositories: [code.repository], source: { ...code, path: "docs/legacy/rules.md" } };
  writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: new Date().toISOString(), documents: [domain, selected], resources: {},
    repositories: [{ repository: location.repository, branch: location.branch, revision: "a".repeat(40) }, code] });
  let calls = 0;
  const manager = new DomainKnowledgeExtraction(dir, async () => { calls++; return "不应运行"; });
  try {
    const original = manager.beginInspection(selected.id, { module_id: "orders", issue_no: "REQ-SCOPE" }, "alice");
    updateBusinessModule(dir, "orders", { repository_knowledge_exclusions: [{ repository: code.repository, paths: ["docs/legacy/rules.md"] }] }, "alice");
    const filtered = manager.beginInspection(domain.id, { module_id: "orders", issue_no: "REQ-SCOPE-FILTERED" }, "alice");
    assert.deepEqual(filtered.documents.map(document => document.id), [domain.id]);
    assert.deepEqual(manager.get(original.id).documents, original.documents);
    assert.deepEqual(manager.get(original.id).repositories, original.repositories);
    updateBusinessModule(dir, "orders", { repository_knowledge_exclusions: [] }, "alice");
    const restored = manager.beginInspection(selected.id, { module_id: "orders", issue_no: "REQ-SCOPE-RESTORED" }, "alice");
    assert.deepEqual(new Set(restored.documents.map(document => document.id)), new Set([domain.id, selected.id]));
    assert.equal(restored.documents.find(document => document.id === selected.id)?.path, selected.source!.path);
    assert.equal(calls, 0);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("六仓任务部分合入仍显示失败仓，原批次可补齐 MR，已合入目标不再续推", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-partial-mr-merge-"));
  const repos = Array.from({ length: 5 }, (_, index) => `https://example.test/code-${index + 1}.git`);
  saveKnowledgeRepoConfig(dir, location.repository, { branch: location.branch });
  createBusinessModule(dir, { id: "orders", name: "订单", description: "多仓订单", owner: "alice", repositories: repos, knowledge_path: location.docs_path }, "alice");
  const calls = new Map<string, number>(); let failures = 2, allMerged = false;
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: `${target.id}-rules`, target_id: target.id,
      layer: target.id === "domain" ? "domain" : "repository", title: `${target.id}规则`, path: `${target.docs_path}/rules.md`, content: `# ${target.id}`, sources: "固定版本资料" });
    return "六仓候选完成";
  }, { publish: async (job, target, previous) => {
    calls.set(target.id, (calls.get(target.id) ?? 0) + 1);
    if (target.id === "repo-5" && failures-- > 0) throw new Error("第五代码仓暂时不可用");
    return { target_id: target.id, state: "opened", branch: previous?.branch || `codex/${target.id}`, url: `https://example.test/mr/${target.id}`,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) };
  }, refreshPublication: async (target, publication) => ({ ...publication, mr_state: allMerged || target.id === "domain" ? "merged" : "opened" }) });
  try {
    const job = manager.create({ module_id: "orders", issue_no: "REQ-SIX" }, "alice");
    await until(() => manager.get(job.id).status === "done");
    const preview = manager.previewArchive(job.id), input = { issue_no: "REQ-SIX", expected_revisions: preview.expected_revisions };
    await manager.createArchive(job.id, input, "alice");
    await manager.refreshPublications(job.id, "alice");
    let current = manager.get(job.id), state = current.production!;
    assert.equal(state.status_label, "部分 MR 已合入，剩余 MR 创建失败"); assert.equal(state.group, "attention");
    assert.equal(state.review.readonly, true); assert.equal(state.archive.state, "failed");
    assert.equal(state.next_action.label, "重试失败仓 MR"); assert.equal(state.archive.actions[0].label, "重试失败仓 MR");
    assert.equal(state.documents.find(document => document.id === "domain-rules")?.status_label, "已合入");
    assert.equal(state.documents.find(document => document.id === "repo-5-rules")?.status_label, "MR 创建失败");
    assert.throws(() => manager.edit(job.id, { document: current.documents[0], base_revision: 1 }, "alice"), /已合入/);
    assert.throws(() => manager.configureArchive(job.id, { base_revision: 0, targets: [current.knowledge_target, ...current.repositories] }), /重试原批次/);
    await manager.createArchive(job.id, input, "alice");
    current = manager.get(job.id);
    assert.equal(current.production?.archive.state, "failed");
    assert.equal(calls.get("domain"), 1, "幂等创建请求跳过已合入目标");
    await manager.retryArchive(job.id, "alice", { batch_id: current.archive_batches![0].id });
    current = manager.get(job.id); state = current.production!;
    assert.equal(current.archive_batches?.length, 1); assert.equal(calls.get("repo-5"), 3);
    assert.equal(calls.get("domain"), 1); assert.equal(calls.get("repo-1"), 1);
    assert.equal(state.status_label, "部分 MR 已合入"); assert.equal(state.group, "attention");
    assert.equal(state.archive.publications.filter(publication => publication.status_label === "MR 待合入").length, 5);
    allMerged = true; await manager.refreshPublications(job.id, "alice");
    state = manager.get(job.id).production!;
    assert.equal(state.status_label, "MR 已合入"); assert.equal(state.group, "completed");
    assert.equal(state.next_action.label, "查看正式知识"); assert.deepEqual(state.archive.actions, []);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("MR 状态查询与研究保存并行时只合并远端状态，关停后迟到查询不能写盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-mr-refresh-concurrency-")); module(dir);
  let releaseResearch!: () => void, releaseQuery!: () => void, querying = false;
  const research = new Promise<void>(resolve => { releaseResearch = resolve; });
  let query = new Promise<void>(resolve => { releaseQuery = resolve; });
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    const doc = { id: "rules", title: "规则", target_id: "domain", layer: "domain" as const, path: `${location.docs_path}/rules.md`, content: "# 初稿", sources: "业务资料" };
    if (input.turn.mode === "revise") { await research; input.save({ ...doc, content: "# 并行期间完成的修订" }); return "最新修订结果"; }
    input.save(doc); return "研究完成";
  }, { publish: async (job, target) => ({ target_id: target.id, branch: "codex/req-concurrent", state: "opened", url: "https://example.test/mr/99",
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision })) }),
    refreshPublication: async (_target, publication) => { querying = true; await query; return { ...publication, mr_state: "opened" }; } });
  try {
    const job = manager.create({ module_id: "orders", issue_no: "REQ-99" }, "alice");
    await until(() => manager.get(job.id).status === "done");
    await manager.createArchive(job.id, { issue_no: "REQ-99", expected_revisions: manager.previewArchive(job.id).expected_revisions }, "alice");
    manager.run(job.id, { mode: "revise", document_ids: ["rules"], message: "继续修订" }, "alice");
    await until(() => manager.get(job.id).status === "running");
    const refresh = manager.refreshPublications(job.id, "alice"); await until(() => querying);
    assert.doesNotThrow(() => manager.select(job.id, ["rules"], true), "后台查询 MR 状态不能占用文稿修改与提交入口");
    releaseResearch(); await until(() => manager.get(job.id).status === "done");
    releaseQuery(); await refresh;
    const current = manager.get(job.id);
    assert.equal(current.status, "done"); assert.equal(current.turns.at(-1)?.reply, "最新修订结果");
    assert.equal(current.turns.at(-1)?.proposals[0].document.content, "# 并行期间完成的修订");
    const preview = manager.previewArchive(job.id);
    assert.deepEqual(preview.expected_revisions, { rules: "2" });
    assert.equal(preview.targets[0].files[0].content, "# 并行期间完成的修订");
    querying = false; query = new Promise<void>(resolve => { releaseQuery = resolve; });
    const late = manager.refreshPublications(job.id, "alice"); await until(() => querying);
    await manager.shutdown(); releaseQuery();
    await assert.rejects(late, /服务已停止/);
    assert.equal(manager.get(job.id).turns.at(-1)?.reply, "最新修订结果");
  } finally { releaseResearch(); releaseQuery(); await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("正式 Git 文档拒绝直接编辑和恢复，资源响应隔离脚本且不允许越界读取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-git-resource-route-")); module(dir);
  const document = official(dir), content = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>bad()</script></svg>");
  const digest = createHash("sha256").update(content).digest("hex"), root = join(gitKnowledgeRoot(dir), "resources");
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, `${digest}.b64`), content.toString("base64"));
  writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: new Date().toISOString(), documents: [document],
    repositories: [{ repository: location.repository, branch: location.branch, revision: "a".repeat(40) }],
    resources: { [gitKnowledgeResourceKey(location.repository, location.branch, `${location.docs_path}/images/state.svg`, document.source!.revision)]: { digest, content_type: "image/svg+xml" } } });
  const service = { options: { dataDir: dir } } as TaskService;
  const request = async (method: string, action: string[], path?: string) => {
    let status = 0, value: unknown, headers: Record<string, unknown> = {};
    const response = { writeHead: (code: number, input: Record<string, unknown>) => { status = code; headers = input; }, end: (input: unknown) => { value = input; } } as unknown as ServerResponse;
    await knowledgeDocumentRoute({ method, url: `/knowledge-documents/${document.id}/${action.join("/")}${path ? `?path=${encodeURIComponent(path)}` : ""}` } as IncomingMessage,
      response, ["knowledge-documents", document.id, ...action], service, "alice", async () => ({ content: "不允许绕开 MR" }), (_response, code, body) => { status = code; value = body; });
    return { status, value, headers };
  };
  try {
    const file = await request("GET", ["resources"], "images/state.svg");
    assert.equal(file.status, 200); assert.deepEqual(file.value, content);
    assert.equal(file.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(file.headers["Content-Security-Policy"], "default-src 'none'; sandbox");
    assert.equal((await request("GET", ["resources"], "../../../../private.txt")).status, 404);
    for (const action of [[], ["restore"]]) {
      const result = await request("POST", action);
      assert.equal(result.status, 400); assert.match(JSON.stringify(result.value), /开始检视/);
    }
    assert.equal(readKnowledgeDocument(dir, document.id).content, document.content);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("检视任务资源接口固定原图，正式库更新和服务重启后仍读取同一图片", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-inspection-images-")); module(dir);
  const document = official(dir, "# 订单规则\n\n![流程](images/state.png)");
  const content = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const digest = createHash("sha256").update(content).digest("hex"), root = join(gitKnowledgeRoot(dir), "resources");
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, `${digest}.b64`), content.toString("base64"));
  writeGitKnowledgeSnapshot(dir, { module_id: "orders", location, synced_at: new Date().toISOString(), documents: [document],
    repositories: [{ repository: location.repository, branch: location.branch, revision: document.source!.revision }],
    resources: { [gitKnowledgeResourceKey(location.repository, location.branch, `${location.docs_path}/images/state.png`, document.source!.revision)]: { digest, content_type: "image/png" } } });
  let manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("开始检视不运行模型"); });
  try {
    const task = manager.beginInspection(document.id, { issue_no: "REQ-IMAGE", expected_revision: document.revision }, "alice");
    official(dir, "# 后续版本已移除原图", "b".repeat(40));
    await manager.shutdown(); manager = new DomainKnowledgeExtraction(dir, async () => "不应执行");
    const request = async (href: string) => {
      let status = 0, value: unknown, headers: Record<string, unknown> = {};
      const response = { writeHead: (code: number, input: Record<string, unknown>) => { status = code; headers = input; }, end: (input: unknown) => { value = input; } } as unknown as ServerResponse;
      const service = { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => manager } as unknown as TaskService;
      await domainKnowledgeRoute({ method: "GET", url: `/domain-extraction/${task.id}/resources/${document.id}?path=${encodeURIComponent(href)}` } as IncomingMessage,
        response, ["domain-extraction", task.id, "resources", document.id], service, "alice", async () => ({}), (_response, code, body) => { status = code; value = body; });
      return { status, value, headers };
    };
    const result = await request("images/state.png");
    assert.equal(result.status, 200); assert.deepEqual(result.value, content);
    assert.equal(result.headers["Content-Type"], "image/png");
    assert.equal(result.headers["Content-Security-Policy"], "default-src 'none'; sandbox");
    assert.equal((await request("../../../etc/passwd")).status, 404);
    assert.equal(manager.get(task.id).turns.length, 0);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("真实 Git 同一任务修改后更新原分支和 MR，远端已合入后停止续推", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-git-mr-real-")), source = join(dir, "source"), remote = join(dir, "remote.git");
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("-C", source, "init", "-b", "main");
  git("-C", source, "config", "user.name", "fixture"); git("-C", source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "README.md"), "source"); git("-C", source, "add", "."); git("-C", source, "commit", "-m", "fixture");
  git("clone", "--bare", source, remote);
  let creates = 0, queries = 0, state = "opened";
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/mr/gates")) {
      queries++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ mr_state: state, gates: [] })); return;
    }
    if (request.url === "/mr") {
      for await (const _ of request) { /* 读完请求以确认创建次数。 */ }
      creates++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: 1, url: "https://example.test/mr/1" })); return;
    }
    response.writeHead(404); response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const target = { id: "domain", name: "领域知识仓", repository: remote, branch: "main", docs_path: "business/orders", path: "" };
  const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, task_kind: "extraction", title: "订单", scope: "规则", issue_no: "REQ-13", operator: "alice",
    created_at: new Date().toISOString(), knowledge_layout: "directory-v1", knowledge_target: target, repositories: [], material_ids: [], status: "done", stage: "文稿已就绪",
    revisions: {}, evidence: [], publications: [], turns: [], documents: [{ id: "rules", target_id: "domain", layer: "domain", title: "规则", path: "business/orders/rules.md",
      content: "# 首次候选", sources: "业务资料", selected: true, revision: 1, base_content: null, base_revision: "", history: [] }] };
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credential: () => ({ username: "alice", password: "fixture-token", email: "fixture@example.test" }) });
  try {
    const first = await publisher.publish(job, target, undefined, "alice", () => {});
    job.documents[0] = { ...job.documents[0], content: "# 修订候选", revision: 2 };
    job.publications = [first];
    const second = await publisher.publish(job, target, first, "alice", () => {});
    assert.equal(second.branch, first.branch); assert.equal(second.url, first.url); assert.equal(creates, 1); assert.ok(queries > 0);
    assert.equal(git("-C", remote, "show", `${second.branch}:business/orders/rules.md`), "# 修订候选");
    assert.equal(listKnowledgeDocuments(dir).length, 0);
    state = "merged"; job.documents[0].content = "# 合入后不应续推"; job.documents[0].revision++;
    await assert.rejects(publisher.publish(job, target, second, "alice", () => {}), /已合入/);
    assert.equal(git("-C", remote, "show", `${second.branch}:business/orders/rules.md`), "# 修订候选");
  } finally {
    await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
