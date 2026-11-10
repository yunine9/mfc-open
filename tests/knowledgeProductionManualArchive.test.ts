import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { DomainKnowledgeStore } from "../src/domainKnowledgeStore.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";
import type { TaskService } from "../src/taskService.ts";
import { listKnowledgeDocuments, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { domainKnowledgeTask } from "../src/knowledgeTaskCenter.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

// HTTP 断言只读取公开预览字段，不依赖管理器内部对象。
interface Preview {
  job_id: string; title: string; status_label: string; message: string; issue_no?: string;
  expected_revisions: Record<string, string>;
  actions: Array<{ id: string; label: string; href?: string; target_id?: string; batch_id?: string }>;
  targets: Array<{ id: string; repository: string; branch: string; configured: boolean; status_label: string; message: string; error?: string; url?: string;
    actions: Preview["actions"]; files: Array<{ path: string; content: string; knowledge_document_id: string; knowledge_revision: string }> }>;
}
interface ManualManager {
  previewArchive(id: string): Preview;
  previewComponentArchive(input: { research_id: string; knowledge_document_id: string; knowledge_revision?: string }, operator: string): Preview;
  createArchive(id: string, input: { issue_no: string; issue_description?: string; expected_revisions: Record<string, string>; target_ids?: string[] }, operator: string): Promise<Preview>;
  retryArchive(id: string, operator: string, input: { batch_id: string; target_id?: string }): Promise<Preview>;
}
const manual = (manager: DomainKnowledgeExtraction) => manager as unknown as ManualManager;
async function within<T>(work: Promise<T>, message: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const config = { title: "订单领域", scope: "核对领域规则", issue_no: "REQ-PREFILL", issue_description: "研究发起时的单号描述", repositories: [],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
function harness(dir: string, options: { noGit?: boolean; multiple?: boolean; failTarget?: string } = {}) {
  const calls: Array<{ target: string; previous?: DomainPublication; job: DomainKnowledgeJob; operator: string }> = [];
  let failed = false;
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    for (const target of [input.job.knowledge_target, ...(options.multiple ? input.job.repositories : [])]) {
      input.save({ id: target.id === "domain" ? "rules" : "source-rules", target_id: target.id, title: `${target.id} 规则`,
        layer: target.id === "domain" ? "domain" : "repository", path: `${target.docs_path}/rules.md`,
        content: `# ${target.id}\n\n任务候选规则，MR 合入后更新正式知识库。`, sources: "固定源码和业务资料" }, { content: null, revision: "a".repeat(40) });
    }
    return "草稿完成";
  }, { closePublication: async () => {}, publish: async (job, target, previous, operator, save) => {
    calls.push({ target: target.id, previous: previous && structuredClone(previous), job: structuredClone(job), operator });
    const documents = job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
      knowledge_document_id: document.knowledge_document_id, knowledge_revision: String(document.revision) }));
    const branch = previous?.branch || `codex/manual-${target.id}-${documents[0].knowledge_revision!.slice(0, 12)}`;
    save({ target_id: target.id, branch, state: "pending", documents: [], attempted_documents: documents, mr_attempted: true });
    if (!failed && target.id === options.failTarget) { failed = true; throw new Error("HTTP 503：测试平台暂时不可用"); }
    return { target_id: target.id, branch, state: "opened", url: previous?.url ?? `https://example.test/mr/${calls.length}`, mr_id: calls.length, documents };
  } });
  const input = options.noGit ? { ...config, knowledge_target: undefined } : options.multiple ? { ...config,
    repositories: [{ repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/source" }] } : config;
  return { manager, calls, async seed() { const job = manager.create(input, "author"); await until(() => manager.get(job.id).status === "done", "研究未在5秒预算内完成"); return job.id; } };
}
async function close(manager: DomainKnowledgeExtraction) { await within(manager.shutdown(), "管理器关停超过5秒预算"); }
const batchPath = (dir: string, id: string) => join(dir, "domain-extraction", id, "job.json");
const progressPath = (dir: string, id: string) => join(dir, "domain-extraction", id, "archive-progress.json");
const readStoredJob = (path: string) => new DomainKnowledgeStore().read(path) as DomainKnowledgeJob;

test("Issue488：已有归档批次但未创建MR时继续原批次与分支，完成后重复点击不再创建", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-missing-mr-"));
  let state = harness(dir);
  try {
    const id = await state.seed();
    await close(state.manager);
    const file = batchPath(dir, id), stored = readStoredJob(file);
    const batch: NonNullable<DomainKnowledgeJob["archive_batches"]>[number] = { id: randomUUID(), created_at: new Date().toISOString(), operator: "reviewer", state: "done",
      knowledge_layout: stored.knowledge_layout, documents: structuredClone(stored.documents), targets: [structuredClone(stored.knowledge_target)], publications: [] };
    stored.archive_batches = [batch];
    batch.issue_no = "REQ-EXISTING"; batch.state = "done";
    batch.publications = [{ target_id: "domain", state: "pending", branch: "codex/pushed-without-mr", documents: [] }];
    new DomainKnowledgeStore().save(file, stored);
    state = harness(dir);
    const before = JSON.stringify(listKnowledgeDocuments(dir)), preview = state.manager.previewArchive(id);
    assert.equal(preview.status_label, "待创建 MR");
    const input = { issue_no: preview.issue_no!, expected_revisions: preview.expected_revisions };
    const result = await state.manager.createArchive(id, input, "reviewer");
    assert.equal(result.status_label, "MR 待合入"); assert.ok(result.targets[0].url);
    assert.equal(state.calls.length, 1); assert.equal(state.calls[0].previous?.branch, "codex/pushed-without-mr");
    assert.equal(state.calls[0].job.issue_no, "REQ-EXISTING");
    assert.deepEqual(state.manager.get(id).archive_batches!.map(item => item.id), [batch.id]);
    await state.manager.createArchive(id, input, "reviewer");
    assert.equal(state.calls.length, 1, "已有有效MR后不重复创建");
    assert.equal(JSON.stringify(listKnowledgeDocuments(dir)), before, "补MR不重写已发布知识");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("领域候选不提前进入正式库，旧发布入口拒绝且不会自动推送或创建 MR", { timeout: 15_000 }, async () => {
  for (const noGit of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-platform-")), state = harness(dir, { noGit });
    try {
      const id = await state.seed();
      await assert.rejects(state.manager.publish(id, "reviewer"), /直接创建 MR/);
      assert.equal(listKnowledgeDocuments(dir).length, 0);
      assert.equal(state.calls.length, 0);
      const stored = readStoredJob(batchPath(dir, id));
      assert.equal(stored.documents.length, 1); assert.equal(stored.archive_batches?.length ?? 0, 0);
      assert.equal(state.manager.get(id).production?.archive.status_label, "待创建 MR");
    } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("MR 预览读取任务最新候选，预填单号且不修改正文或自动创建 MR", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-preview-")), state = harness(dir);
  try {
    const id = await state.seed(), draft = state.manager.get(id).documents[0];
    const next = state.manager.edit(id, { document: { ...draft, content: "# 人工核对新版候选" }, base_revision: draft.revision }, "editor").documents[0];
    const before = state.manager.get(id), beforeCalls = state.calls.length;
    const preview = manual(state.manager).previewArchive(id);
    assert.equal(preview.issue_no, "REQ-PREFILL"); assert.equal(preview.status_label, "待创建 MR");
    assert.equal(preview.targets[0].files[0].content, next.content);
    assert.equal(preview.targets[0].files[0].knowledge_revision, String(next.revision));
    assert.equal(preview.expected_revisions[next.id], String(next.revision));
    assert.deepEqual(state.manager.get(id), before); assert.equal(state.calls.length, beforeCalls);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("知识仓配置成本地路径时，归档预览就说明不能建 MR 并只给归档设置入口，不等人点了创建才报错", { timeout: 10_000 }, async () => {
  // 知识仓配置收本地路径（拉仓可用），建 MR 只收 HTTP/HTTPS；2026-10-08 走查实测预览照常给「创建归档 MR」，点了才报错。
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-local-")), state = harness(dir, { noGit: true });
  try {
    saveKnowledgeRepoConfig(dir, join(dir, "knowledge.git"), { branch: "main", docs_path: "domains" });
    const id = await state.seed();
    const preview = manual(state.manager).previewArchive(id);
    assert.equal(preview.targets[0].configured, false);
    assert.match(preview.targets[0].message, /不能用于创建 MR：仓库地址须为不带凭据的 HTTP\/HTTPS 地址/);
    assert.deepEqual(preview.actions.map(action => action.id), ["configure"]);
    await assert.rejects(manual(state.manager).createArchive(id, { issue_no: "REQ-LOCAL", expected_revisions: preview.expected_revisions }, "reviewer"), /HTTP\/HTTPS/);
    assert.equal(state.calls.length, 0);
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/6/14：手动创建归档要求用户单号及预览版本，拒绝缺单号和过期预览且不启动外部操作", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-guard-")), state = harness(dir);
  try {
    const id = await state.seed();
    assert.equal(typeof manual(state.manager).createArchive, "function", "必须有人工归档创建接口");
    const preview = manual(state.manager).previewArchive(id), before = state.calls.length;
    await assert.rejects(manual(state.manager).createArchive(id, { issue_no: "", expected_revisions: preview.expected_revisions }, "exporter"), /关联单号/);
    const draft = state.manager.get(id).documents[0]; state.manager.edit(id, { document: { ...draft, content: draft.content + "\n候选新版本" }, base_revision: draft.revision }, "editor");
    await assert.rejects(manual(state.manager).createArchive(id, { issue_no: "REQ-MANUAL", expected_revisions: preview.expected_revisions }, "exporter"), /文稿已有新版本/);
    assert.equal(state.calls.length, before, "预检失败不得产生Git/MR事实");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/6/8/14：多目标手动归档保存部分成功，失败target仅人工同分支重试且已成功MR不重复创建", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-target-")), state = harness(dir, { multiple: true, failTarget: "repo-1" });
  try {
    const id = await state.seed();
    const api = manual(state.manager); assert.equal(typeof api.createArchive, "function");
    const preview = api.previewArchive(id);
    const created = await api.createArchive(id, { issue_no: "REQ-EXPORT", expected_revisions: preview.expected_revisions }, "exporter");
    assert.equal(created.status_label, "MR 创建失败"); assert.equal(created.targets.find(target => target.id === "domain")?.status_label, "MR 待合入");
    // 弹窗把顶部说明、仓说明、仓红字都渲染出来：原因只许落在红字一处（曾三处同句叠着显示）。
    const reason = created.targets.find(target => target.id === "repo-1")?.error ?? "";
    assert.ok(reason, "失败仓带原因");
    const texts = [created.message, ...created.targets.flatMap(target => [target.message, target.error ?? ""])];
    assert.equal(texts.filter(text => text.includes(reason)).length, 1, `失败原因只出现一次：${JSON.stringify(texts)}`);
    const stored = readStoredJob(batchPath(dir, id));
    const failed = stored.archive_batches!.find(batch => batch.state === "failed")!;
    assert.equal(failed.issue_no, "REQ-EXPORT"); assert.equal(failed.operator, "exporter");
    const failedBranch = failed.publications.find(publication => publication.target_id === "repo-1")!.branch;
    assert.ok(failedBranch); const before = state.calls.length; await settle(); assert.equal(state.calls.length, before, "失败不得后台重试");
    const retried = await api.retryArchive(id, "retryer", { batch_id: failed.id, target_id: "repo-1" });
    assert.equal(retried.status_label, "MR 待合入"); assert.ok(retried.targets.every(target => target.url));
    assert.equal(state.calls.filter(call => call.target === "domain").length, 1); assert.equal(state.calls.filter(call => call.target === "repo-1").length, 2);
    assert.equal(state.calls.at(-1)!.previous?.branch, failedBranch); assert.equal(state.calls.at(-1)!.job.issue_no, "REQ-EXPORT");
    await api.retryArchive(id, "retryer", { batch_id: failed.id, target_id: "repo-1" });
    assert.equal(state.calls.length, before + 1, "重复重试成功target应复用已保存MR事实");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收1/5/14：MR 提交中断后重启记失败，保留已发生分支和候选版本且不自动续推", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-restart-")), state = harness(dir);
  let restarted: DomainKnowledgeExtraction | undefined;
  try {
    const id = await state.seed(); const api = manual(state.manager);
    assert.equal(typeof api.createArchive, "function"); const preview = api.previewArchive(id);
    await api.createArchive(id, { issue_no: "REQ-RESTART", expected_revisions: preview.expected_revisions }, "exporter"); await close(state.manager);
    const stored = readStoredJob(batchPath(dir, id)), batch = stored.archive_batches!.find(batch => batch.state === "done")!;
    batch.state = "running"; batch.publications[0].state = "pending"; delete batch.publications[0].url; delete batch.publications[0].mr_id;
    stored.publications = structuredClone(batch.publications);
    // 合并最新进度后保存新的主文件版本，旧检查点不能把模拟中断状态覆盖回 done。
    new DomainKnowledgeStore().save(batchPath(dir, id), stored);
    let external = 0; restarted = new DomainKnowledgeExtraction(dir, async () => { throw new Error("不应重复研究"); }, { publish: async () => { external++; throw new Error("不应自动归档"); } });
    await settle(); await settle();
    assert.equal(external, 0); const recovered = restarted.get(id).archive_batches!.find(row => row.id === batch.id)!;
    assert.equal(recovered.state, "failed"); assert.match(recovered.error ?? "", /重启|中断|手动重试/);
    assert.equal(recovered.publications[0].branch, batch.publications[0].branch);
    assert.deepEqual(manual(restarted).previewArchive(id).expected_revisions, preview.expected_revisions);
  } finally { if (restarted) await close(restarted); await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("任务新版候选继续原 MR，保留旧批次快照且不提前更新正式库", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-new-version-")), state = harness(dir);
  try {
    const id = await state.seed(), api = manual(state.manager), initial = api.previewArchive(id);
    const first = await api.createArchive(id, { issue_no: "REQ-FIRST", expected_revisions: initial.expected_revisions }, "exporter");
    const oldUrl = first.targets[0].url, original = state.manager.get(id).documents[0];
    const current = state.manager.edit(id, { document: { ...original, content: original.content + "\n新的候选规则。" }, base_revision: original.revision }, "editor").documents[0];
    const next = api.previewArchive(id); assert.equal(next.status_label, "待创建 MR"); assert.equal(next.expected_revisions[current.id], String(current.revision));
    assert.equal(state.manager.get(id).production?.archive.status_label, next.status_label);
    assert.equal(domainKnowledgeTask(state.manager.get(id)).production?.archive.status_label, next.status_label);
    const second = await api.createArchive(id, { issue_no: "REQ-SECOND", expected_revisions: next.expected_revisions }, "exporter");
    assert.equal(second.status_label, "MR 待合入"); assert.equal(second.targets[0].url, oldUrl);
    assert.notEqual(state.calls[0].job.documents[0].revision, state.calls[1].job.documents[0].revision);
    assert.equal(state.calls[1].previous?.url, oldUrl);
    const stored = readStoredJob(batchPath(dir, id));
    assert.equal(stored.archive_batches!.length, 2);
    assert.equal(stored.archive_batches![0].documents[0].content, original.content);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4/5/14：人工批次首次耐久写EIO不调用MR、不污染读取记录，解除故障后可再次创建", { timeout: 10_000 }, async t => {
  const fs = (await import("node:fs")).default, { syncBuiltinESMExports } = await import("node:module");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-batch-eio-")), state = harness(dir);
  try {
    const id = await state.seed(); const before = state.manager.get(id), raw = readFileSync(batchPath(dir, id), "utf8");
    const preview = state.manager.previewArchive(id), rename = fs.renameSync;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === batchPath(dir, id)) throw Object.assign(new Error("测试批次耐久写 EIO"), { code: "EIO" });
      return rename(...args);
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(state.manager.createArchive(id, { issue_no: "REQ-EIO", expected_revisions: preview.expected_revisions }, "exporter"), /EIO/);
      assert.equal(state.calls.length, 0); assert.deepEqual(state.manager.get(id), before); assert.equal(readFileSync(batchPath(dir, id), "utf8"), raw);
    } finally { interception.mock.restore(); syncBuiltinESMExports(); }
    assert.equal((await state.manager.createArchive(id, { issue_no: "REQ-EIO", expected_revisions: preview.expected_revisions }, "exporter")).status_label, "MR 待合入");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4/5/14：MR成功回执耐久写EIO保留已保存分支，手动重试复用同版同分支而不重写正式库", { timeout: 10_000 }, async t => {
  const fs = (await import("node:fs")).default, { syncBuiltinESMExports } = await import("node:module");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-receipt-eio-")), state = harness(dir);
  try {
    const id = await state.seed(); const preview = state.manager.previewArchive(id), formal = JSON.stringify(listKnowledgeDocuments(dir)), rename = fs.renameSync;
    let failed = false;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (!failed && String(args[1]) === progressPath(dir, id)) {
        const candidate = JSON.parse(readFileSync(String(args[0]), "utf8")) as { batches: Array<{ publications: DomainPublication[] }> };
        if (candidate.batches.some(batch => batch.publications.some(publication => publication.state === "opened"))) {
          failed = true; throw Object.assign(new Error("测试MR回执耐久写 EIO"), { code: "EIO" });
        }
      }
      return rename(...args);
    }); syncBuiltinESMExports();
    try {
      const result = await state.manager.createArchive(id, { issue_no: "REQ-RECEIPT", expected_revisions: preview.expected_revisions }, "exporter");
      assert.equal(failed, true); assert.equal(result.status_label, "MR 创建失败"); assert.match(result.targets[0].error ?? "", /EIO/);
    } finally { interception.mock.restore(); syncBuiltinESMExports(); }
    const batch = state.manager.get(id).archive_batches!.find(batch => batch.state === "failed")!, branch = batch.publications[0].branch;
    assert.ok(branch); assert.equal((await state.manager.retryArchive(id, "exporter", { batch_id: batch.id })).status_label, "MR 待合入");
    assert.equal(state.calls.at(-1)?.previous?.branch, branch); assert.equal(JSON.stringify(listKnowledgeDocuments(dir)), formal);
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/14：领域候选 HTTP 公开 preview/create/retry 与 MR 状态刷新，退役旧路径返回404", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-http-")), state = harness(dir);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const id = await state.seed();
    const service = { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => state.manager, prepareKnowledgeIndex() {} } as unknown as TaskService;
    const readBody = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); };
    server = createServer((request, response) => { void domainKnowledgeRoute(request, response, request.url!.slice(1).split("/"), service, "exporter", readBody,
      (out, status, value) => { out.writeHead(status, { "content-type": "application/json" }); out.end(JSON.stringify(value)); }); });
    server.requestTimeout = 5_000; await within(new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); }), "HTTP启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/domain-extraction/${id}`;
    const previewResponse = await fetch(`${base}/archive/preview`, { signal: AbortSignal.timeout(5_000) }); assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as Preview;
    const created = await fetch(`${base}/archive/create`, { method: "POST", body: JSON.stringify({ issue_no: "REQ-HTTP", expected_revisions: preview.expected_revisions }), signal: AbortSignal.timeout(5_000) });
    assert.equal(created.status, 200); assert.equal((await created.json() as Preview).status_label, "MR 待合入");
    const refreshed = await fetch(`${base}/archive/refresh`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) });
    assert.equal(refreshed.status, 200); assert.equal((await refreshed.json() as DomainKnowledgeJob).production?.status_label, "MR 待合入");
    for (const retired of ["refresh", "remote", "reconcile", "archive-retry"]) {
      const response = await fetch(`${base}/${retired}`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) }); assert.equal(response.status, 404, `${retired} 不留旧兼容入口`);
    }
  } finally {
    if (server) await within(new Promise<void>((done, reject) => { server!.close(error => error ? reject(error) : done()); server!.closeAllConnections(); }), "HTTP关停超过5秒预算");
    await close(state.manager); rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP 修改任务候选保留历史与已提交快照，再次提交更新原分支和 MR", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-http-edit-")), state = harness(dir);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const id = await state.seed(), initial = state.manager.previewArchive(id);
    const archived = await state.manager.createArchive(id, { issue_no: "REQ-FIRST", expected_revisions: initial.expected_revisions }, "exporter");
    const draft = state.manager.get(id).documents[0], firstBatch = structuredClone(state.manager.get(id).archive_batches![0]);
    const service = { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => state.manager, prepareKnowledgeIndex() {} } as unknown as TaskService;
    const readBody = async (request: IncomingMessage) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    };
    server = createServer((request, response) => { void domainKnowledgeRoute(request, response, request.url!.slice(1).split("/"), service, "editor", readBody,
      (out, status, value) => { out.writeHead(status, { "content-type": "application/json" }); out.end(JSON.stringify(value)); }); });
    server.requestTimeout = 5_000;
    await within(new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); }), "HTTP启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/domain-extraction/${id}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    const content = draft.content + "\n人工核对：取消订单后保留原始支付凭证。";
    const editedResponse = await post("/edit", { document: { ...draft, content }, base_revision: draft.revision });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json() as DomainKnowledgeJob).documents[0];
    assert.equal(edited.id, draft.id); assert.equal(edited.revision, draft.revision + 1); assert.equal(edited.content, content);
    assert.equal(state.calls.length, 1, "编辑不会自动提交 MR");
    assert.deepEqual(state.manager.get(id).archive_batches![0], firstBatch, "旧 MR 批次快照保持原样");
    const oldVersionResponse = await fetch(`${base}/history/${draft.id}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(oldVersionResponse.status, 200);
    assert.equal((await oldVersionResponse.json() as typeof draft.history)[0].content, draft.content);
    const stale = await post("/edit", { document: { ...draft, content: "过期页面不能覆盖新正文" }, base_revision: draft.revision });
    assert.equal(stale.status, 400); assert.match((await stale.json() as { error: string }).error, /已有新版本/);
    assert.equal(state.manager.get(id).documents[0].content, content); assert.equal(state.calls.length, 1);
    const previewResponse = await fetch(`${base}/archive/preview`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(previewResponse.status, 200); const preview = await previewResponse.json() as Preview;
    assert.equal(preview.status_label, "待创建 MR"); assert.equal(preview.expected_revisions[draft.id], String(edited.revision));
    const secondResponse = await post("/archive/create", { issue_no: "REQ-SECOND", expected_revisions: preview.expected_revisions });
    assert.equal(secondResponse.status, 200); const second = await secondResponse.json() as Preview;
    assert.equal(second.status_label, "MR 待合入"); assert.equal(second.targets[0].url, archived.targets[0].url);
    assert.equal(state.calls.length, 2); assert.equal(state.calls[1].previous?.url, archived.targets[0].url);
    const batches = state.manager.get(id).archive_batches!;
    assert.deepEqual(batches[0], firstBatch); assert.equal(batches[1].publications[0].branch, firstBatch.publications[0].branch);
    assert.equal(batches[1].issue_no, "REQ-SECOND"); assert.equal(batches[1].publications[0].documents[0].content, content);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
  } finally {
    if (server) await within(new Promise<void>((done, reject) => { server!.close(error => error ? reject(error) : done()); server!.closeAllConnections(); }), "HTTP关停超过5秒预算");
    await close(state.manager); rmSync(dir, { recursive: true, force: true });
  }
});

test("旧组件无结构化能力时保留整篇归档，改名随新正式版本生效", { timeout: 10_000 }, async () => {
  const { componentArchivePath } = await import("../src/componentKnowledgeArchiveFormat.ts");
  const { saveKnowledgeRepoConfig } = await import("../src/knowledgeRepoConfig.ts");
  assert.equal(componentArchivePath("docs/components", { title: "文件操作", technologies: ["cpp"] }), "docs/components/cpp/文件操作.md");
  assert.equal(componentArchivePath("docs/components", { title: " 读写/锁:<句柄> ", technologies: [] }), "docs/components/agnostic/读写-锁-句柄.md", "路径字符换成短横线，不产生子目录");
  assert.equal(componentArchivePath("docs/components", { title: "../..", technologies: ["java"] }), "docs/components/java/组件知识.md", "不能借标题跳出目录");
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-archive-name-"));
  seedTechnologyStacks(dir, ["cpp"]);
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("归档预览不运行模型"); });
  try {
    saveKnowledgeRepoConfig(dir, "https://example.test/knowledge.git", { branch: "main", docs_path: "docs/components" });
    const formal = saveKnowledgeDocument(dir, { title: "文件操作", technologies: ["cpp"],
      content: '---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: []\n---\n\n# 文件操作\n\n打开文件后用 Close 释放句柄。' }, "alice");
    const first = manual(manager).previewComponentArchive({ research_id: "cr-name", knowledge_document_id: formal.id }, "alice");
    const files = first.targets.flatMap(target => target.files);
    assert.deepEqual(files.map(file => file.path), ["docs/components/cpp/文件操作.md"]);
    assert.doesNotMatch(files[0].content, /schema:|component_paradigms/, "只提交给人读的正文");
    const renamed = saveKnowledgeDocument(dir, { ...formal, title: "文件读写" }, "alice", formal.id, { expectedRevision: formal.revision });
    const second = manual(manager).previewComponentArchive({ research_id: "cr-name", knowledge_document_id: formal.id, knowledge_revision: renamed.revision }, "alice");
    assert.deepEqual(second.targets.flatMap(target => target.files).map(file => file.path), ["docs/components/cpp/文件读写.md"]);
    assert.equal(second.job_id, first.job_id, "同一组件始终是同一个归档任务");
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
