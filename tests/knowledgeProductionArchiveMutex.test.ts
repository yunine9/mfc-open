// MR 创建、重试与候选修订互斥；迟到回执不能覆盖已关停记录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", issue_description: "订单知识", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timeout");
}
function extract(input: DomainExecution) {
  input.update({ revisions: { "repo-1": "a".repeat(40) } });
  input.save({ id: "orders", title: "orders", target_id: "domain", path: "domains/orders.md", layer: "domain", content: "订单规则 v1", sources: "源码" }, { revision: "b".repeat(40), content: null });
  return "完成";
}
const docs = (job: DomainKnowledgeJob) => job.documents.map(d => ({ id: d.id, path: d.path, content: d.content, revision: d.revision, knowledge_document_id: d.knowledge_document_id }));

test("生产线验收6/14：已有 MR 后启动修订时保留旧回执，研究运行中不提交未完成候选", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-research-save-"));
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    entered = true; await gate; input.update({ stage: "修订证据已核对" });
    input.save({ ...input.read()[0], content: "尚未确认的新研究稿" }); return "修订完成";
  }, { publish: async (job, target) => ({ target_id: target.id, state: "opened", branch: "codex/research-old-formal", url: "https://example.test/mr/old-formal", documents: docs(job) }) });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    const preview = service.previewArchive(job.id); assert.equal(preview.targets[0].files[0].content, "订单规则 v1");
    await service.createArchive(job.id, { issue_no: "REQ-OLD-FORMAL", expected_revisions: preview.expected_revisions }, "exporter");
    service.run(job.id, { mode: "revise", document_ids: ["orders"], message: "补充新证据" }, "alice"); await until(() => entered);
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ-INCOMPLETE", expected_revisions: preview.expected_revisions }, "exporter"), /等待本轮完成/);
    release(); await until(() => service.get(job.id).status === "done");
    const disk = JSON.parse(readFileSync(join(dir, "domain-extraction", job.id, "job.json"), "utf8")) as DomainKnowledgeJob;
    assert.equal(disk.archive_batches!.find(batch => !!batch.issue_no)!.publications[0].url, "https://example.test/mr/old-formal");
    assert.equal(disk.turns.at(-1)!.proposals[0].document.content, "尚未确认的新研究稿");
    assert.equal(disk.documents[0].content, "订单规则 v1"); assert.equal(service.previewArchive(job.id).status_label, "待创建 MR");
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/14：人工归档每仓600秒硬预算，忽略abort的迟到回执不改变failed事实", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-target-budget-"));
  let resolveReply!: (publication: DomainPublication) => void, saveLate!: (publication: DomainPublication) => void, signal: AbortSignal | undefined;
  const reply = new Promise<DomainPublication>(resolve => { resolveReply = resolve; });
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (_job, _target, _previous, _operator, save, abort) => { saveLate = save; signal = abort; return reply; } });
  let active: Promise<unknown> | undefined;
  try {
    const job = service.create(config, "alice"); await flush();
    let returned = false;
    active = service.createArchive(job.id, { issue_no: "REQ-BUDGET", expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice").then(value => { returned = true; return value; });
    await flush(); t.mock.timers.tick(599_999); await flush(); assert.equal(returned, false);
    t.mock.timers.tick(1); await flush(); await active; assert.equal(returned, true); assert.equal(signal?.aborted, true);
    assert.equal(service.previewArchive(job.id).status_label, "MR 创建失败"); assert.match(service.previewArchive(job.id).targets[0].error ?? "", /600 秒/);
    const path = join(dir, "domain-extraction", job.id, "job.json"), before = readFileSync(path, "utf8");
    const progressPath = join(dir, "domain-extraction", job.id, "archive-progress.json"), progressBefore = readFileSync(progressPath, "utf8");
    const late: DomainPublication = { target_id: "domain", state: "opened", branch: "codex/late", url: "https://example.test/mr/late", documents: docs(service.get(job.id)) };
    saveLate(late); resolveReply(late); await flush(); assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(readFileSync(progressPath, "utf8"), progressBefore);
  } finally { resolveReply?.({ target_id: "domain", branch: "", state: "failed", documents: [] }); await flush(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); t.mock.timers.reset(); }
});

for (const contender of ["修订", "创建归档", "重试归档"] as const) test(`生产线验收6：人工归档持锁时并发${contender}被拒绝，被拒绝操作不能释放原操作锁`, { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-mutex-"));
  let release!: () => void, entered = false, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (job, target) => {
    calls++; entered = true; await gate;
    return { target_id: target.id, state: "opened", branch: "codex/manual-lock", url: "https://example.test/mr/lock", documents: docs(job) };
  } });
  let active: Promise<unknown> | undefined;
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    const preview = service.previewArchive(job.id), request = { issue_no: "REQ-MANUAL", expected_revisions: preview.expected_revisions };
    active = service.createArchive(job.id, request, "alice"); await until(() => entered);
    const batch = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!;
    const invoke = () => contender === "修订" ? Promise.resolve().then(() => service.run(job.id, { mode: "revise", document_ids: ["orders"], message: "并发修订" }, "bob")) : contender === "创建归档" ? service.createArchive(job.id, request, "bob") : service.retryArchive(job.id, "bob", { batch_id: batch.id });
    await assert.rejects(invoke(), /正在|请等待/);
    await assert.rejects(service.createArchive(job.id, request, "charlie"), /正在|请等待/);
    assert.equal(calls, 1); release(); await active;
    assert.equal(service.previewArchive(job.id).status_label, "MR 待合入");
    await service.retryArchive(job.id, "alice", { batch_id: batch.id }); assert.equal(calls, 1);
  } finally { release(); await active?.catch(() => undefined); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

async function flush() { for (let n = 0; n < 4; n++) await setImmediate(); }
for (const outcome of ["返回", "抛错"] as const) test(`生产线验收2/6/14：人工归档忽略abort，关停60秒释放后迟到${outcome}及回执不能覆写磁盘`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-late-"));
  let resolveReply!: (publication: DomainPublication) => void, rejectReply!: (error: Error) => void, saveLate!: (publication: DomainPublication) => void;
  const reply = new Promise<DomainPublication>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (_job, target, _previous, _operator, save) => {
    save({ target_id: target.id, branch: "codex/interrupted-before-receipt", state: "pending", documents: [], mr_attempted: true });
    saveLate = save; return reply;
  }, shutdown: async () => {} });
  let active: Promise<unknown> | undefined, closed = false;
  try {
    const job = service.create(config, "alice"); await flush(); assert.equal(service.get(job.id).status, "done");
    active = service.createArchive(job.id, { issue_no: "REQ-MANUAL", expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice").catch(error => error);
    await flush(); assert.equal(typeof saveLate, "function");
    const closing = service.shutdown().then(() => { closed = true; });
    t.mock.timers.tick(59_999); await flush(); assert.equal(closed, false);
    t.mock.timers.tick(1); await flush(); await closing; assert.equal(closed, true);
    const batch = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!;
    assert.equal(batch.state, "failed"); assert.match(batch.error ?? "", /停止超时/);
    assert.equal(batch.publications[0].state, "failed"); assert.equal(batch.publications[0].branch, "codex/interrupted-before-receipt");
    assert.equal(service.get(job.id).production?.archive.publications[0].status_label, "MR 创建失败");
    assert.equal(service.previewArchive(job.id).targets[0].status_label, "MR 创建失败");
    assert.deepEqual(service.previewArchive(job.id).targets[0].actions.map(action => action.id), ["retry-archive"]);
    const path = join(dir, "domain-extraction", job.id, "job.json"), before = readFileSync(path, "utf8");
    const progressPath = join(dir, "domain-extraction", job.id, "archive-progress.json"), progressBefore = readFileSync(progressPath, "utf8");
    const late: DomainPublication = { target_id: "domain", state: "opened", branch: "codex/late", url: "https://example.test/mr/late", documents: docs(service.get(job.id)) };
    assert.throws(() => saveLate(late), /迟到结果未保存/);
    if (outcome === "返回") resolveReply(late); else rejectReply(new Error("迟到网络错误"));
    const error = await active; await flush(); assert.ok(error instanceof Error); assert.match(error.message, /迟到结果未保存/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(readFileSync(progressPath, "utf8"), progressBefore);
  } finally { resolveReply?.({ target_id: "domain", branch: "", state: "failed", documents: [] }); await flush();
    if (!closed) { const closing = service.shutdown(); t.mock.timers.tick(60_000); await flush(); await closing; }
    rmSync(dir, { recursive: true, force: true }); t.mock.timers.reset(); }
});
