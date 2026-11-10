import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { componentGuideSection } from "./fixtures/componentGuide.ts";

const payload = "FULL_RESEARCH_PAYLOAD\n".repeat(25_000);
const repository = { id: "source", name: "源码", repository: "https://example.test/source.git", branch: "main", path: "", docs_path: "docs" };

test("领域列表不读取过程全文或携带归档副本，详情仍保留文稿、历史和实时过程文稿", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-list-summary-"));
  const id = `dkx-${randomUUID()}`, turnId = randomUUID(), root = join(dir, "domain-extraction", id);
  const document = { id: "files", title: "文件操作", target_id: "domain", path: "docs/files.md", layer: "domain" as const,
    content: payload, sources: "src/file.cpp", revision: 2, selected: true, base_content: payload, base_revision: "a".repeat(40),
    history: [{ revision: 1, title: "文件操作", content: payload, sources: "src/file.cpp", operator: "alice", at: "2026-10-12T00:00:00Z" }] };
  const job: DomainKnowledgeJob = { id, title: "文件知识", scope: "文件操作", operator: "alice", created_at: "2026-10-12T00:00:00Z",
    status: "done", stage: "等待审查", revisions: {}, repositories: [repository], knowledge_target: { ...repository, id: "domain" },
    material_ids: [], documents: [document], evidence: [{ tool: "research_note", preview: payload }], publications: [],
    turns: [{ id: turnId, mode: "extract", document_ids: [document.id], message: "萃取", operator: "alice", status: "done",
      created_at: "2026-10-12T00:00:00Z", reply: payload, proposals: [] }],
    archive_batches: [{ id: "archive", created_at: "2026-10-12T00:00:00Z", operator: "alice", state: "superseded", documents: [document], targets: [{ ...repository, id: "domain" }], publications: [] }] };
  mkdirSync(root, { recursive: true }); const bytes = JSON.stringify(job); writeFileSync(join(root, "job.json"), bytes);
  const workRoot = join(root, "skill-runs", turnId); mkdirSync(workRoot, { recursive: true }); writeFileSync(join(workRoot, "work.json"), "invalid json");
  const manager = new DomainKnowledgeExtraction(dir, async () => "unused");
  try {
    const [summary] = manager.list();
    assert.equal(summary.id, id); assert.equal(summary.production.status_label, "文稿已就绪", "候选链路词表:有稿未建 MR");
    assert.equal(summary.documents[0].path, document.path); assert.equal(summary.documents[0].revision, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 10_000);
    assert.deepEqual(manager.warnings(), [], "任务列表不能打开每个历史会话的过程文件");
    assert.ok(!JSON.stringify(summary).includes("FULL_RESEARCH_PAYLOAD"));
    summary.repositories[0].name = "列表副本";
    const detail = manager.get(id);
    assert.equal(detail.repositories[0].name, "源码"); assert.equal(detail.documents[0].content, payload);
    assert.equal(detail.documents[0].history[0].content, payload); assert.equal(detail.turns[0].reply, payload);
    assert.ok(manager.warnings().some(warning => warning.includes("过程文稿读取失败")));
    writeFileSync(join(workRoot, "work.json"), JSON.stringify({ documents: [{ id: "inventory", title: "能力盘点", content: "第一版" }] }));
    assert.equal(manager.get(id).work_documents![0].content, "第一版");
    writeFileSync(join(workRoot, "work.json"), JSON.stringify({ documents: [{ id: "inventory", title: "能力盘点", content: "第二版" }] }));
    assert.equal(manager.get(id).work_documents![0].content, "第二版", "列表优化不能缓存过期的过程文稿");
    assert.equal(readFileSync(join(root, "job.json"), "utf8"), bytes);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件列表排除分项结果与历史副本，状态与详情一致，详情和落盘内容保持完整", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-list-summary-"));
  const id = `cr-${randomUUID()}`, root = join(dir, "component-research", id);
  const section = { ...componentGuideSection("files", [repository.id]), selected: true, revision: 2, content: payload };
  const record: ResearchRecord = { id, language: "cpp", topic: "文件操作", operator: "alice", key: "fixture", status: "done",
    created_at: "2026-10-12T00:00:00Z", stage: "等待审查", source_repositories: [{ ...repository, enabled: true, description: "", languages: ["cpp"] }],
    evidence: [{ tool: "research_note", preview: payload }], draft: payload, document: { overview: payload, sections: [section] },
    section_history: [{ at: "2026-10-12T00:00:00Z", operator: "alice", section: { ...section, revision: 1 } }],
    pipeline: { version: 1, skill: "fixture", tasks: [{ id: "inventory", phase: "inventory", title: "能力盘点", spec: payload, dependencies: [], status: "done", attempts: 1,
      result: { findings: payload, open_questions: [], components: [{ id: "files", title: "文件操作", scope: payload, repository_ids: [repository.id] }] } }] } };
  mkdirSync(root, { recursive: true }); const bytes = JSON.stringify(record); writeFileSync(join(root, "record.json"), bytes);
  const manager = new ComponentResearch(dir, async () => "unused");
  try {
    assert.deepEqual(manager.warnings(), []);
    const [summary] = manager.list(true), detail = manager.get(id);
    assert.equal(summary.production!.status_label, "待审查"); assert.deepEqual(summary.production, detail.production);
    assert.equal(summary.pipeline, undefined); assert.equal(summary.section_history, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 10_000); assert.ok(!JSON.stringify(summary).includes("FULL_RESEARCH_PAYLOAD"));
    assert.equal(detail.pipeline!.tasks[0].result!.findings, payload); assert.equal(detail.section_history![0].section.content, payload);
    assert.ok(detail.work_documents![0].content.includes(payload)); assert.equal(detail.document!.sections[0].content, payload);
    summary.source_repositories![0].name = "列表副本";
    assert.equal(manager.get(id).source_repositories![0].name, "源码");
    assert.equal(readFileSync(join(root, "record.json"), "utf8"), bytes);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
