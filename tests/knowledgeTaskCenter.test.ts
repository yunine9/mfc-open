import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentKnowledgeTask, domainKnowledgeTask, latestKnowledgeResearchNote, listKnowledgeTasks, skillExtractionTask, skillSubmissionTask } from "../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import type { SkillSubmissionRecord } from "../src/hostSkillLibrary.ts";
import { knowledgeTaskElapsed, knowledgeTaskAction } from "../web/src/knowledgeTaskCenterApi.ts";

function domain(): DomainKnowledgeJob {
  // 13ff28b7 双链路:本文件钉发布/归档词表(主投影),种子声明组件派生;
  // 独立候选任务的词表见 knowledgeProductionStatus 集成用例。
  return { id: "domain-1", component_research_id: "cr-1", title: "结算", scope: "结算模块", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "本轮完成，等待审查", revisions: {}, repositories: [], knowledge_target: { id: "domain", name: "知识仓", repository: "https://code.example/knowledge", branch: "main", path: "", docs_path: "docs" }, material_ids: [], documents: [{ id: "doc", title: "结算规则", target_id: "domain", path: "docs/a.md", layer: "domain", content: "规则", sources: "", selected: true, revision: 2, base_content: null, base_revision: "", history: [] }], turns: [], evidence: [], publications: [] };
}

test("研究动态只取最新公开研究文字，保留真实时间，跳过工具原文", () => {
  const note = latestKnowledgeResearchNote([
    { tool: "research_note", preview: "旧分析", at: "2026-09-30T01:00:00Z" },
    { tool: "research_note", preview: "## 新分析\n**已核对**调用关系", at: "2026-09-30T01:02:00Z" },
    { tool: "component_source", preview: "原始工具输出", at: "2026-09-30T01:03:00Z" },
  ]);
  assert.deepEqual(note, { text: "新分析 已核对调用关系", at: "2026-09-30T01:02:00Z" });
  assert.equal(latestKnowledgeResearchNote([{ tool: "read", preview: "不能变成思考" }]), undefined);
  assert.equal(latestKnowledgeResearchNote([{ tool: "research_note", preview: "a".repeat(300), at: "bad" }])?.text.length, 180);
});

test("领域研究完成不等于发布；发布后新稿与归档失败仍可处理", () => {
  const job = domain();
  assert.equal(domainKnowledgeTask(job).status_label, "待审查");
  job.documents[0].knowledge_document_id = "kd-1";
  job.documents[0].published_document_revision = 2;
  assert.equal(domainKnowledgeTask(job).status_label, "已发布（未归档）");
  job.documents[0].published_revision = "formal";
  job.archive_batches = [{ id: "archive", issue_no: "REQ-MANUAL", created_at: job.created_at, operator: "alice", state: "failed", documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: [], error: "Git失败" }];
  assert.equal(domainKnowledgeTask(job).status_label, "归档失败");
  job.archive_batches = [];
  job.documents[0].revision = 3;
  assert.equal(domainKnowledgeTask(job).status_label, "待审查");
  job.status = "running";
  assert.equal(domainKnowledgeTask(job).group, "running");
  assert.equal(domainKnowledgeTask(job).started_at, undefined);
});

test("领域任务的开始时间与运行时长取最近一轮实际开跑到收口，新一轮排队时不沿用上一轮", () => {
  const job = domain();
  const turn = (id: string, extra: Partial<DomainKnowledgeJob["turns"][number]>) => ({ id, mode: "extract" as const, document_ids: [], message: "", operator: "alice", status: "done" as const, created_at: "2026-09-30T01:00:00Z", proposals: [], ...extra });
  job.turns = [turn("t1", { started_at: "2026-09-30T01:05:00Z", finished_at: "2026-09-30T01:17:30Z" })];
  assert.equal(domainKnowledgeTask(job).started_at, "2026-09-30T01:05:00Z");
  assert.equal(knowledgeTaskElapsed(domainKnowledgeTask(job)), "12 分 30 秒");
  job.turns.push(turn("t2", { mode: "discuss", status: "queued", created_at: "2026-09-30T02:00:00Z" })); job.status = "queued";
  assert.equal(domainKnowledgeTask(job).started_at, undefined);
  assert.equal(knowledgeTaskElapsed(domainKnowledgeTask(job)), "—");
  job.turns[1] = { ...job.turns[1], status: "running", started_at: "2026-09-30T02:01:00Z" }; job.status = "running";
  assert.equal(knowledgeTaskElapsed(domainKnowledgeTask(job), Date.parse("2026-09-30T02:01:42Z")), "42 秒");
});

test("组件研究保留执行结束，但不把创建当开始；发布与待审稿分开", () => {
  const record = { id: "component-1", language: "cpp", topic: "线程池", operator: "bob", status: "done", created_at: "2026-09-30T01:00:00Z", finished_at: "2026-09-30T01:10:00Z", stage: "待审查", draft: "# 线程池", evidence: [] } as unknown as ResearchRecord;
  assert.equal(componentKnowledgeTask(record).group, "attention");
  assert.equal(knowledgeTaskElapsed(componentKnowledgeTask(record)), "—");
  record.started_at = "2026-09-30T01:02:00Z";
  assert.equal(knowledgeTaskElapsed(componentKnowledgeTask(record)), "8 分 0 秒");
  record.document_id = "kd-1";
  assert.equal(componentKnowledgeTask(record).status_label, "已发布（未归档）");
});

test("Skill 审核等待不能作为运行时长，重启中断无结束时间不继续计时", () => {
  const submission = { id: "submission-1", directory: "review-skill", operator: "alice", created_at: "2026-09-30T01:00:00Z", decided_at: "2026-09-30T06:00:00Z", status: "approved", business_module_ids: [], technologies: [] } as unknown as SkillSubmissionRecord;
  assert.equal(skillSubmissionTask(submission).id, "review-skill/submission-1");
  assert.equal(knowledgeTaskElapsed(skillSubmissionTask(submission)), "—");
  const extraction = skillExtractionTask({ id: "ke-1", status: "failed", repo: "repo", intent: "重启中断", operator: "alice", started_at: "2026-09-30T01:00:00Z" });
  assert.equal(knowledgeTaskElapsed(extraction, Date.parse("2026-09-30T02:00:00Z")), "—");
  extraction.status = "running";
  assert.equal(knowledgeTaskElapsed(extraction, Date.parse("2026-09-30T01:03:05Z")), "3 分 5 秒");
  extraction.status = "done"; extraction.finished_at = "2026-09-30T01:04:10Z";
  assert.equal(knowledgeTaskElapsed(extraction), "4 分 10 秒");
});

test("任务中心保留既有任务与后台诊断，来源不可用不增加待处理数量", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-task-center-"));
  try {
    mkdirSync(join(dataDir, "knowledge-extract", "ke-123"), { recursive: true });
    writeFileSync(join(dataDir, "knowledge-extract", "not-a-job"), "");
    const job = domain();
    const result = listKnowledgeTasks({ dataDir,
      domain: { list: () => [{ id: job.id }], get: () => job },
      component: { list: () => { throw new Error("unavailable"); }, get: () => { throw new Error("missing"); } },
      skillExtractionJob: id => ({ id, status: "failed", repo: "repo", intent: "参考仓制作", operator: "alice", started_at: "2026-09-30T02:00:00Z", error: "服务重启中断" }),
    });
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].id, "ke-123");
    assert.deepEqual(result.summary, { running: 0, attention: 2, total: 2 });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /基础组件萃取/);
    assert.equal("documents" in result.tasks[1], false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});


test("人工归档进行时提供归档入口，旧版本失败不覆盖新版本状态", () => {
  const job = domain();
  Object.assign(job.documents[0], { knowledge_document_id: "kd-1", published_document_revision: 2, published_revision: "new" });
  job.archive_batches = [
    { id: "old", created_at: job.created_at, operator: "alice", state: "failed", issue_no: "REQ-OLD", documents: [{ ...job.documents[0], published_revision: "old" }], targets: [job.knowledge_target], publications: [] },
    { id: "new", created_at: job.created_at, operator: "alice", state: "running", issue_no: "REQ-NEW", documents: [{ ...job.documents[0] }], targets: [job.knowledge_target], publications: [] },
  ];
  assert.equal(domainKnowledgeTask(job).status_label, "归档中");
  assert.equal(domainKnowledgeTask(job).group, "running");
  assert.equal(knowledgeTaskAction(domainKnowledgeTask(job)).view, "archive");
  job.archive_batches[1].state = "done";
  job.archive_batches[1].publications = [{ target_id: "domain", branch: "codex/manual", state: "opened", documents: [], url: "https://example.test/mr/1" }];
  assert.equal(domainKnowledgeTask(job).status_label, "已归档");
  job.status = "running";
  assert.equal(knowledgeTaskAction(domainKnowledgeTask(job)).view, "progress");
  job.status = "cancelled";
  assert.equal(domainKnowledgeTask(job).group, "attention");
});

test("组件归档失败仍打开已发布文稿，和领域任务一样保留处理入口", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-task-archive-"));
  try {
    const record = { id: "component-1", status: "done", topic: "线程池", document_id: "kd-1", evidence: [] } as unknown as ResearchRecord;
    const archive = domain();
    Object.assign(archive.documents[0], { knowledge_document_id: "kd-1", published_revision: "formal", published_document_revision: 2 });
    archive.archive_batches = [{ id: "failed", issue_no: "REQ-MANUAL", created_at: archive.created_at, operator: "alice", state: "failed", documents: structuredClone(archive.documents), targets: [archive.knowledge_target], publications: [] }];
    const result = listKnowledgeTasks({ dataDir, domain: { list: () => [], get: () => archive, componentArchive: () => archive }, component: { list: () => [record], get: () => record }, skillExtractionJob: () => undefined });
    assert.equal(result.tasks[0].status_label, "归档失败");
    assert.equal(result.summary.attention, 1);
    assert.equal(knowledgeTaskAction(result.tasks[0]).view, "archive");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("#457 模块建设状态来自进行中任务，选最新任务，已完成和失败不冒充建设中", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-module-running-"));
  try {
    const jobs = [
      { ...domain(), id: "old", module_id: "trade", status: "running" as const },
      { ...domain(), id: "new", module_id: "trade", status: "queued" as const, created_at: "2026-10-09T00:00:00Z" },
      { ...domain(), id: "done", module_id: "other" },
      { ...domain(), id: "failed", module_id: "failed", status: "failed" as const },
    ];
    const source = { dataDir, domain: { list: () => jobs, get: (id: string) => jobs.find(job => job.id === id)! }, component: { list: () => [], get: () => { throw new Error("unused"); } }, skillExtractionJob: () => undefined };
    assert.deepEqual(listKnowledgeTasks(source).module_activity, [{ module_id: "trade", task_id: "new", status_label: "建设中" }]);
    jobs[0].status = "done" as any; jobs[1].status = "done" as any;
    assert.deepEqual(listKnowledgeTasks(source).module_activity, []);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("#517 文档数量包含已保存的过程记录，不计空占位或删除稿，不返回全文", () => {
  const job = domain(); job.module_id = "trade";
  job.documents.push({ ...job.documents[0], id: "empty", content: "  " }, { ...job.documents[0], id: "deleted", deleted: true });
  job.work_documents = [{ id: "inventory", title: "能力盘点", content: "过程正文", turn_id: "turn-1" }];
  const row = domainKnowledgeTask(job);
  assert.equal(row.module_id, "trade");
  assert.deepEqual(row.document_summary, { total: 2, published: 0, drafts: 1, process: 1 });
  assert.ok(!JSON.stringify(row).includes("过程正文"));
  assert.equal("documents" in row, false);
  assert.deepEqual(row.module_entry, { kind: "task" });
});

test("#517 已发布未归档仍进入任务，当前版本归档成功后进入正式文档", () => {
  const job = domain(); job.knowledge_layout = "directory-v1";
  Object.assign(job.documents[0], { knowledge_document_id: "kd-1", published_document_revision: 2, published_revision: "formal" });
  assert.deepEqual(domainKnowledgeTask(job).module_entry, { kind: "task" });
  job.archive_batches = [{ id: "archive", knowledge_layout: job.knowledge_layout, created_at: job.created_at, operator: "alice", state: "done", issue_no: "REQ-1", documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: [{ target_id: "domain", state: "opened", branch: "archive", documents: [], url: "https://example.test/mr/1" }] }];
  assert.deepEqual(domainKnowledgeTask(job).module_entry, { kind: "document", document_id: "kd-1" });
  job.documents[0].revision++;
  assert.deepEqual(domainKnowledgeTask(job).module_entry, { kind: "task" }, "未归档的新稿不能跳到旧正式版本");
  job.archive_batches[0].state = "failed";
  assert.deepEqual(domainKnowledgeTask(job).module_entry, { kind: "task" });
});

test("#517 最新任务结束后，旧的运行任务不能重新覆盖模块入口", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-latest-module-"));
  try {
    const jobs = [{ ...domain(), id: "old", module_id: "trade", status: "running" as const }, { ...domain(), id: "new", module_id: "trade", created_at: "2026-10-16T00:00:00Z" }];
    const result = listKnowledgeTasks({ dataDir, domain: { list: () => jobs, get: id => jobs.find(job => job.id === id)! }, component: { list: () => [], get: () => { throw new Error("unused"); } }, skillExtractionJob: () => undefined });
    assert.deepEqual(result.module_activity, []);
    assert.equal(result.tasks.length, 2, "旧任务仍保留在任务中心");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
