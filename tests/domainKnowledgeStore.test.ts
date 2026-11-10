import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { DomainKnowledgeStore } from "../src/domainKnowledgeStore.ts";

const config = { issue_no: "REQ-store", title: "订单", scope: "订单规则", repositories: [{ name: "交易仓", repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/business" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/orders" } };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("任务未完成"); }

test("研究新增证据不再重写包含大文稿的任务主文件，重启仍按原顺序读取证据", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-evidence-store-"));
  let before = "", after = "";
  const service = new DomainKnowledgeExtraction(dir, async input => {
    input.save({ id: "states", title: "订单规则", target_id: "domain", path: "domains/orders/states.md", layer: "domain", content: "订单规则\n".repeat(20000), sources: "repo-1 / state.ts" });
    const path = join(input.root, "job.json");
    before = readFileSync(path, "utf8");
    input.evidence({ type: "research", text: "第一条证据" });
    input.evidence({ type: "research", text: "第二条证据" });
    after = readFileSync(path, "utf8");
    return "完成";
  });
  try {
    const job = service.create(config, "expert");
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    assert.ok(before.length > 100000);
    assert.equal(after === before, true, "单条研究记录不能触发大文稿的全量保存");
    await service.shutdown();
    const restored = new DomainKnowledgeExtraction(dir, async () => "unused");
    try {
      assert.deepEqual(restored.get(job.id).evidence.map(row => row.text), ["第一条证据", "第二条证据"]);
      assert.equal(restored.evidencePage(job.id).total, 2);
      assert.deepEqual(restored.evidencePage(job.id).entries.map(row => row.index), [1, 0]);
      assert.equal(restored.evidenceEntry(job.id, "1").text, "第二条证据");
      assert.equal(restored.get(job.id).documents[0].content, "订单规则\n".repeat(20000));
    } finally { await restored.shutdown(); }
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

function storedJob(evidence: DomainKnowledgeJob["evidence"] = []): DomainKnowledgeJob {
  return { id: "dkx-store", title: "订单", scope: "规则", operator: "expert", created_at: "2026-10-27T00:00:00Z", repositories: [], knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains/orders" }, material_ids: [], status: "done", stage: "完成", revisions: {}, documents: [], turns: [], publications: [], evidence };
}
function evidenceFile(path: string) { const stored = JSON.parse(readFileSync(path, "utf8")); return join(path, "..", stored._evidence_store.file); }

test("旧内联记录读取无副作用，首次保存保留原文件，主文件不再含研究正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-evidence-migrate-")), path = join(dir, "job.json");
  const original = { ...storedJob([{ tool: "source", content: "研究正文".repeat(100000), nested: { paths: ["a.ts", "b.ts"] } }]), future_field: { retained: true } };
  const originalBytes = JSON.stringify(original, null, 2);
  try {
    writeFileSync(path, originalBytes);
    const store = new DomainKnowledgeStore();
    const job = store.read(path) as DomainKnowledgeJob;
    assert.deepEqual(job, original);
    assert.deepEqual(readdirSync(dir), ["job.json"], "读取旧任务不触发迁移或重新研究");
    store.save(path, job);
    const backups = readdirSync(dir).filter(name => name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), originalBytes);
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(metadata.evidence, []);
    assert.ok(statSync(path).size < 2000);
    assert.deepEqual(new DomainKnowledgeStore().read(path), { ...original, archive_progress_revision: job.archive_progress_revision });
    const journal = evidenceFile(path), previous = statSync(journal, { bigint: true });
    Object.defineProperty(job.evidence, "toJSON", { configurable: true, value: () => { throw new Error("不应再次序列化完整研究历史"); } });
    job.stage = "已归档";
    store.save(path, job);
    assert.equal(statSync(journal, { bigint: true }).mtimeNs, previous.mtimeNs);
    assert.equal(evidenceFile(path), journal);
    assert.equal(readdirSync(dir).filter(name => name.endsWith(".bak")).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("追加只写新记录且立即可恢复；原地修改和移除历史记录在整任务保存时可靠识别", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-evidence-change-")), path = join(dir, "job.json");
  try {
    const store = new DomainKnowledgeStore(), job = storedJob([{ text: "第一条", detail: { retained: true } }]);
    store.save(path, job);
    const originalJournal = evidenceFile(path), originalText = readFileSync(originalJournal, "utf8"), metadata = readFileSync(path, "utf8");
    Object.defineProperty(job.documents, "toJSON", { configurable: true, value: () => { throw new Error("单条证据不可序列化文稿"); } });
    store.appendEvidence(path, job, { text: "第二条", nested: { value: 1 } });
    assert.equal(readFileSync(path, "utf8"), metadata);
    assert.equal(readFileSync(originalJournal, "utf8"), originalText + JSON.stringify(job.evidence[1]) + "\n");
    assert.deepEqual((new DomainKnowledgeStore().read(path) as DomainKnowledgeJob).evidence, job.evidence, "主文件未重新保存也能恢复新记录");
    delete (job.documents as unknown as Record<string, unknown>).toJSON;
    job.evidence.push({ text: "第三条" });
    store.save(path, job);
    assert.equal(evidenceFile(path), originalJournal, "普通追加继续使用原文件");
    const oldJournalText = readFileSync(originalJournal, "utf8");
    (job.evidence[1].nested as { value: number }).value = 2;
    job.evidence.shift();
    store.save(path, job);
    assert.notEqual(evidenceFile(path), originalJournal, "原地修改不能仅按对象引用判断未变化");
    assert.equal(readFileSync(originalJournal, "utf8"), oldJournalText, "旧研究记录保留，主文件原子切换到新版本");
    assert.deepEqual((new DomainKnowledgeStore().read(path) as DomainKnowledgeJob).evidence, job.evidence);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("中断追加修复末行后继续原编号；文件缺失或中间损坏不静默丢历史", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-evidence-recover-")), path = join(dir, "job.json"), messages: string[] = [];
  try {
    const store = new DomainKnowledgeStore(), job = storedJob([{ text: "第一条" }, { text: "第二条" }]);
    store.save(path, job);
    const journal = evidenceFile(path);
    appendFileSync(journal, '{"text":');
    const restarted = new DomainKnowledgeStore(message => messages.push(message));
    const restored = restarted.read(path) as DomainKnowledgeJob;
    assert.deepEqual(restored.evidence, job.evidence);
    assert.equal(messages.length, 1);
    restarted.appendEvidence(path, restored, { text: "第三条" });
    assert.deepEqual((new DomainKnowledgeStore().read(path) as DomainKnowledgeJob).evidence.map(row => row.text), ["第一条", "第二条", "第三条"]);
    writeFileSync(journal, 'not-json\n{"text":"仍有后续记录"}\n');
    assert.throws(() => new DomainKnowledgeStore().read(path), /损坏/);
    rmSync(journal);
    assert.throws(() => new DomainKnowledgeStore().read(path), /缺失/);
    assert.throws(() => restarted.save(path, restored), /缺失/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("迁移或修改后的主文件保存失败不覆盖原任务，也不提前改变归档版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-evidence-write-failure-")), path = join(dir, "job.json");
  try {
    const job = storedJob([{ text: "原记录", nested: { count: 1 } }]), original = JSON.stringify(job);
    writeFileSync(path, original); mkdirSync(`${path}.tmp`);
    const store = new DomainKnowledgeStore();
    assert.throws(() => store.save(path, job), /EISDIR/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(job.archive_progress_revision, undefined);
    assert.ok(readdirSync(dir).some(name => name.endsWith(".bak")));
    rmSync(`${path}.tmp`, { recursive: true });
    store.save(path, job);
    const previous = readFileSync(path, "utf8"), revision = job.archive_progress_revision, journal = evidenceFile(path);
    (job.evidence[0].nested as { count: number }).count = 2;
    mkdirSync(`${path}.tmp`);
    assert.throws(() => store.save(path, job), /EISDIR/);
    assert.equal(readFileSync(path, "utf8"), previous);
    assert.equal(job.archive_progress_revision, revision);
    assert.equal(existsSync(journal), true);
    assert.deepEqual((new DomainKnowledgeStore().read(path) as DomainKnowledgeJob).evidence, [{ text: "原记录", nested: { count: 1 } }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
