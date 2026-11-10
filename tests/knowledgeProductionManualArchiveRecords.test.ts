import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import type { DomainArchiveBatch, DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { listKnowledgeTasks } from "../src/knowledgeTaskCenter.ts";

const target = { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains" };
function record(dir: string): DomainKnowledgeJob {
  const formal = saveKnowledgeDocument(dir, { title: "正式领域知识", content: "已审查的正式规则" }, "alice");
  return { id: `dkx-${randomUUID()}`, title: "订单域", scope: "订单规则", operator: "alice", created_at: "2026-10-03T00:00:00Z", status: "done", stage: "已发布", issue_no: "REQ-ARCHIVE",
    knowledge_target: target, repositories: [], material_ids: [], revisions: {}, turns: [], evidence: [], publications: [],
    documents: [{ id: "rules", title: formal.title, target_id: "domain", path: "domains/rules.md", layer: "domain", content: formal.content, sources: "源码",
      selected: true, revision: 1, base_content: null, base_revision: "", history: [], knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 }] };
}
function batch(job: DomainKnowledgeJob): DomainArchiveBatch {
  return { id: "manual-batch", created_at: job.created_at, operator: "alice", state: "done", issue_no: "REQ-MANUAL", documents: structuredClone(job.documents), targets: [target],
    publications: [{ target_id: "domain", branch: "codex/manual", state: "opened", url: "https://example.test/mr/1", mr_id: 1, mr_attempted: true, revision: "a".repeat(40), documents: [] }] };
}
function store(dir: string, job: DomainKnowledgeJob) {
  const root = join(dir, "domain-extraction", job.id), path = join(root, "job.json"); mkdirSync(root, { recursive: true });
  const raw = JSON.stringify(job); writeFileSync(path, raw); return { path, raw };
}

test("生产线验收3/8：人工归档嵌套单号、描述、MR链接及尝试字段坏形状逐条隔离，原字节不变且正常邻居可读", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-corrupt-record-"));
  const good = record(dir), pending = record(dir); pending.archive_batches = [{ ...batch(pending), state: "pending", issue_no: undefined, publications: [] }];
  const mutations: Array<(batch: any) => void> = [
    value => { value.issue_no = {}; }, value => { value.issue_no = "bad issue"; }, value => { value.issue_description = {}; },
    value => { value.publications[0].url = {}; }, value => { delete value.publications[0].url; }, value => { value.publications[0].url = "not-a-mr-url"; },
    value => { value.publications[0].mr_attempted = "yes"; }, value => { value.publications[0].revision = {}; },
  ];
  store(dir, good); store(dir, pending);
  const bad = mutations.map(mutate => { const job = record(dir), archive = batch(job); mutate(archive); job.archive_batches = [archive]; return { id: job.id, ...store(dir, job) }; });
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("这些记录不应研究"); });
  try {
    assert.deepEqual(new Set(manager.list().map(job => job.id)), new Set([good.id, pending.id]));
    // 候选投影词表(13ff28b7):无人工单号的恢复快照在任务卡显示「待创建 MR」,
    // 快照合法性(可列出、不误报损坏)才是本用例的主题。
    assert.equal(manager.get(pending.id).production?.archive.status_label, "待创建 MR", "F6无人工单号的发布恢复快照仍合法");
    for (const item of bad) {
      assert.throws(() => manager.get(item.id), /不存在/); assert.equal(readFileSync(item.path, "utf8"), item.raw);
      assert.ok(manager.warnings().some(warning => warning.includes(`domain-extraction/${item.id}/job.json`)));
    }
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3/8：正式文件损坏只影响对应归档预览，领域任务列表及中心保留邻居并立即点名告警", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-corrupt-formal-")), good = record(dir), broken = record(dir);
  store(dir, good); store(dir, broken);
  const formalPath = join(dir, "knowledge-documents", `${broken.documents[0].knowledge_document_id}.json`); writeFileSync(formalPath, "{broken");
  const manager = new DomainKnowledgeExtraction(dir, async () => "不应执行");
  try {
    assert.deepEqual(new Set(manager.list().map(job => job.id)), new Set([good.id, broken.id]));
    // 13ff28b7 起独立候选任务的列表与预览不消费正式文件:损坏不再打挂预览,
    // 由装载器点名告警(见末尾 center.warnings 断言),列表保留邻居。
    assert.equal(manager.get(broken.id).production?.archive.visible, true); assert.equal(manager.get(good.id).production?.archive.visible, true);
    const center = listKnowledgeTasks({ dataDir: dir, domain: manager, component: { list: () => [], get: () => { throw new Error("无组件"); } }, skillExtractionJob: () => undefined });
    assert.equal(center.tasks.length, 2); assert.ok(center.warnings.some(warning => warning.includes(`knowledge-documents/${broken.documents[0].knowledge_document_id}.json`)));
    assert.equal(readFileSync(formalPath, "utf8"), "{broken");
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收1/3/8：宕机人工归档记失败后详情、预览和回执均不得残留归档中标签", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-interrupted-state-")), job = record(dir), interrupted = batch(job);
  interrupted.state = "running"; interrupted.publications[0] = { ...interrupted.publications[0], state: "pending", url: undefined, mr_id: undefined };
  job.archive_batches = [interrupted]; job.publications = structuredClone(interrupted.publications); store(dir, job);
  const manager = new DomainKnowledgeExtraction(dir, async () => "不应执行");
  try {
    assert.equal(manager.previewArchive(job.id).status_label, "MR 创建失败");
    assert.equal(manager.get(job.id).production?.archive.publications[0].status_label, "MR 创建失败");
    assert.ok(manager.get(job.id).production?.archive.batches[0].publications.every(publication => publication.status_label === "MR 创建失败"));
    assert.deepEqual(manager.previewArchive(job.id).targets[0].actions.map(action => action.id), ["retry-archive"]);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
