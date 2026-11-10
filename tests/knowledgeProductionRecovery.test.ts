// 从 r7-lazy-recovery 翻转：启动即接续，不靠访问知识接口触发。
import assert from "node:assert/strict";
import { componentGuideOverview } from "./fixtures/componentGuide.ts";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskService } from "../src/taskService.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";

const createdAt = "2026-10-02T00:00:00.000Z";
const target = { id: "domain", name: "知识仓", repository: "https://example.test/k.git", branch: "main", path: "", docs_path: "domains" };
const component = { id: "component-files", name: "文件组件", repository: "https://example.test/files.git", branch: "main", path: "", languages: ["cpp"], description: "文件处理", enabled: true };

function save(dataDir: string, directory: string, id: string, name: string, record: unknown): string {
  const path = join(dataDir, directory, id, name);
  mkdirSync(join(dataDir, directory, id), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return path;
}
function domain(status: DomainKnowledgeJob["status"]): DomainKnowledgeJob {
  return { id: `dkx-${randomUUID()}`, title: "订单", scope: "订单规则", issue_no: "REQ-1", operator: "alice", created_at: createdAt,
    repositories: [], material_ids: [], knowledge_target: target,
    status, stage: "研究中", revisions: { domain: "kept-revision" }, documents: [], evidence: [], publications: [],
    turns: status === "done" ? [] : [{ id: "original-turn", mode: "extract", document_ids: [], message: "订单", operator: "alice", status: status as "queued" | "running", created_at: createdAt, proposals: [] }],
    archive_batches: [] };
}
function componentRecord(status: "queued" | "running"): ResearchRecord {
  return { id: `cr-${randomUUID()}`, component, components: [component], language: "cpp", topic: "文件处理", operator: "alice", key: status,
    status, created_at: createdAt, stage: "研究中", format: "joint-document", revisions: { [component.id]: "kept-revision" },
    document: { overview: componentGuideOverview("已保存的跨仓说明"), sections: [{ id: "files", title: "文件处理", repository_ids: [component.id], selected: true,
      revision: 0, content: "", interfaces: "", integration: "", example: "", unit_tests: "", sources: "", related_ids: [] }] }, evidence: [{ tool: "previous-source", path: "src/file.cpp" }],
    review_turns: [{ id: "original-review", section_id: "files", mode: "discuss", message: "补充说明", operator: "alice", status, created_at: createdAt }] };
}
async function settleStartup(): Promise<void> {
  // 管理器接续通过微任务启动；不用访问接口，也不等待真实模型。
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

test("生产线验收1（F4/r7）：无人访问知识接口，领域及组件的排队和运行研究自动接续原记录", { timeout: 3_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-knowledge-startup-"));
  const domainRows = (["queued", "running"] as const).map(status => domain(status));
  const componentRows = (["queued", "running"] as const).map(componentRecord);
  const domainPaths = domainRows.map(job => save(dataDir, "domain-extraction", job.id, "job.json", job));
  const componentPaths = componentRows.map(record => save(dataDir, "component-research", record.id, "record.json", record));
  // 缺少模型配置是确定性终态，证明执行已接续；不启动真实模型或 Git。
  const service = new TaskService({ dataDir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  try {
    await settleStartup();
    for (const [index, path] of domainPaths.entries()) {
      const saved = JSON.parse(readFileSync(path, "utf8")) as DomainKnowledgeJob;
      assert.equal(saved.status, "failed", "领域研究必须在无人访问时开始执行");
      assert.match(saved.error ?? "", /配置主模型/);
      assert.equal(saved.id, domainRows[index].id);
      assert.equal(saved.turns[0].id, "original-turn");
      assert.equal(saved.turns[0].status, "failed");
      assert.deepEqual(saved.revisions, domainRows[index].revisions);
    }
    for (const [index, path] of componentPaths.entries()) {
      const saved = JSON.parse(readFileSync(path, "utf8")) as ResearchRecord;
      assert.equal(saved.status, "failed", "组件研究必须在无人访问时开始执行");
      assert.match(saved.error ?? "", /配置主模型/);
      assert.equal(saved.id, componentRows[index].id);
      assert.equal(saved.review_turns![0].id, "original-review");
      assert.equal(saved.review_turns![0].status, "failed");
      assert.deepEqual(saved.document, componentRows[index].document);
      assert.deepEqual(saved.revisions, componentRows[index].revisions);
      assert.deepEqual(saved.evidence, componentRows[index].evidence);
    }
  } finally {
    await service.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("生产线验收1（F4/r7）：研究已完成时宕机中的人工归档记失败，不接续Git或重新研究", { timeout: 3_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-knowledge-startup-archive-"));
  const jobs = [domain("done"), { ...domain("done"), component_research_id: `cr-${randomUUID()}` }];
  const paths = jobs.map(job => {
    job.archive_batches = [{ id: "original-batch", created_at: createdAt, operator: "alice", state: "running", issue_no: "REQ-MANUAL", documents: [], targets: [], publications: [] }];
    return save(dataDir, "domain-extraction", job.id, "job.json", job);
  });
  const service = new TaskService({ dataDir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  try {
    await settleStartup();
    for (const [index, path] of paths.entries()) {
      const saved = JSON.parse(readFileSync(path, "utf8")) as DomainKnowledgeJob;
      assert.equal(saved.status, "done", "只接续归档，不重新研究");
      assert.equal(saved.id, jobs[index].id);
      assert.equal(saved.archive_batches![0].id, "original-batch");
      assert.equal(saved.archive_batches![0].state, "failed", "中断人工操作不能停在 running或自动启动Git");
      assert.match(saved.archive_batches![0].error ?? "", /重启.*手动重试/);
      assert.equal(saved.component_research_id, jobs[index].component_research_id);
    }
  } finally {
    await service.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
