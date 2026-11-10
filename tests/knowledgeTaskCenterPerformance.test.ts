import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { componentKnowledgeTask, domainKnowledgeTask, listKnowledgeTasks } from "../src/knowledgeTaskCenter.ts";
import { listKnowledgeDocumentFacts, readKnowledgeDocumentFacts, readKnowledgeDocumentVersion, readKnowledgeArchiveVersionFacts, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { eraseKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { writeKnowledgeDeletion } from "../src/knowledgeDeletionStore.ts";
import { componentGuideSection } from "./fixtures/componentGuide.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-task-center-fast-"));
  const body = "# 文件操作\n" + "完整正文与历史仍留在详情。\n".repeat(3000);
  const formal = saveKnowledgeDocument(dir, { title: "文件操作", content: body, scope: "platform" }, "alice");
  const repository = { id: "source", name: "源码", repository: "https://example.test/source.git", branch: "main", path: "", docs_path: "docs" };
  const domainId = `dkx-${randomUUID()}`, componentId = `cr-${randomUUID()}`, turnId = randomUUID();
  const document = { id: "files", title: "文件操作", target_id: "domain", path: "docs/files.md", layer: "domain" as const,
    content: body, sources: "src/file.cpp", revision: 1, selected: true, base_content: body, base_revision: "a".repeat(40),
    knowledge_document_id: formal.id, published_document_revision: 1, published_revision: formal.revision,
    history: [{ revision: 1, content: body, sources: "src/file.cpp", title: "文件操作", operator: "alice", at: "2026-10-12T00:00:00Z" }] };
  const job: DomainKnowledgeJob = { id: domainId, title: "文件领域知识", scope: "文件操作", operator: "alice", created_at: "2026-10-12T00:00:00Z",
    status: "done", stage: "等待审查", repositories: [repository], knowledge_target: { ...repository, id: "domain" }, material_ids: [], revisions: {},
    documents: [document], turns: [{ id: turnId, mode: "extract", document_ids: [document.id], message: "萃取", operator: "alice", status: "done",
      created_at: "2026-10-12T00:00:00Z", started_at: "2026-10-12T00:01:00Z", finished_at: "2026-10-12T00:02:00Z", proposals: [] }],
    evidence: [{ tool: "component_source", preview: body }, { tool: "research_note", preview: "已核对文件关闭条件。", at: "2026-10-12T00:02:00Z" }], publications: [],
    archive_batches: [{ id: "old-archive", issue_no: "REQ-files", created_at: "2026-10-12T00:00:00Z", operator: "alice", state: "failed", error: "原归档失败",
      documents: [document], targets: [{ ...repository, id: "domain" }], publications: [] }] };
  const workFile = join(dir, "domain-extraction", domainId, "skill-runs", turnId, "work.json");
  const jobRoot = join(dir, "domain-extraction", domainId); mkdirSync(jobRoot, { recursive: true }); writeFileSync(join(jobRoot, "job.json"), JSON.stringify(job));
  mkdirSync(join(jobRoot, "skill-runs", turnId), { recursive: true }); writeFileSync(workFile, JSON.stringify({ documents: [{ id: "inventory", title: "能力盘点", content: body }] }));
  const section = { ...componentGuideSection("files", [repository.id]), content: body, selected: true, revision: 1 };
  const record: ResearchRecord = { id: componentId, language: "cpp", topic: "文件组件知识", operator: "alice", key: "fixture", status: "done",
    created_at: "2026-10-12T00:00:00Z", stage: "等待审查", source_repositories: [{ ...repository, enabled: true, description: "", languages: ["cpp"] }],
    evidence: [{ tool: "research_note", preview: "已核对组件调用。" }], document: { overview: body, sections: [section] }, draft: body,
    document_id: formal.id, published_revision: formal.revision,
    section_history: [{ at: "2026-10-12T00:00:00Z", operator: "alice", section }],
    pipeline: { version: 1, skill: "fixture", tasks: [{ id: "inventory", title: "能力盘点", phase: "inventory", spec: body, dependencies: [], attempts: 1, status: "done",
      result: { findings: body, open_questions: [], components: [{ id: "files", title: "文件操作", scope: body, repository_ids: [repository.id] }] } }] } };
  const componentRoot = join(dir, "component-research", componentId); mkdirSync(componentRoot, { recursive: true }); writeFileSync(join(componentRoot, "record.json"), JSON.stringify(record));
  const domain = new DomainKnowledgeExtraction(dir, async () => "unused");
  const component = new ComponentResearch(dir, async () => "unused", undefined, (id, summaryOnly) => domain.componentArchive(id, summaryOnly));
  const sources = { dataDir: dir, domain, component, skillExtractionJob: () => undefined };
  return { dir, formal, domainId, componentId, workFile, domain, component, sources, close: async () => { await domain.shutdown(); await component.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("任务中心不调用完整列表或详情，保留同一状态、公开研究摘要和真实时间", async () => {
  const f = fixture();
  try {
    const expectedDomain = domainKnowledgeTask(f.domain.get(f.domainId)), expectedComponent = componentKnowledgeTask(f.component.get(f.componentId));
    f.domain.get = () => { throw new Error("任务中心禁止读取全文详情"); };
    f.domain.list = () => { throw new Error("任务中心禁止先读取另一份列表"); };
    f.component.get = () => { throw new Error("任务中心禁止读取全文详情"); };
    f.component.list = () => { throw new Error("任务中心禁止读取全文列表"); };
    const data = listKnowledgeTasks(f.sources);
    assert.deepEqual(data.warnings, []); assert.equal(data.tasks.length, 2);
    assert.deepEqual(data.tasks.find(task => task.id === f.domainId), expectedDomain);
    assert.deepEqual(data.tasks.find(task => task.id === f.componentId), expectedComponent);
    assert.ok(!JSON.stringify(data).includes("完整正文与历史"));
    assert.equal(data.tasks.find(task => task.id === f.domainId)!.latest_note!.text, "已核对文件关闭条件。");
  } finally { await f.close(); }
});

test("未变化的任务中心请求不重读正式知识或过程全文，正式版本与删除立即生效", async () => {
  const f = fixture(), originalRead = fs.readFileSync;
  try {
    listKnowledgeTasks(f.sources);
    const reads: string[] = [];
    fs.readFileSync = ((path: any, ...args: any[]) => {
      if (String(path).includes("/knowledge-documents/") || String(path).endsWith("/work.json")) reads.push(String(path));
      return (originalRead as any)(path, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const stable = listKnowledgeTasks(f.sources); assert.deepEqual(reads, []); assert.equal(stable.tasks.find(task => task.id === f.domainId)!.status_label, "MR 创建失败");
    const file = join(f.dir, "knowledge-documents", `${f.formal.id}.json`), replacement = file + ".replacement";
    const raw = JSON.parse(originalRead(file, "utf8")); raw.revision = "b".repeat(64);
    writeFileSync(replacement, JSON.stringify(raw)); renameSync(replacement, file);
    const updated = listKnowledgeTasks(f.sources);
    // 独立任务的批次按冻结任务稿判当前,不随正式版本漂移:标签稳定。
    assert.equal(updated.tasks.find(task => task.id === f.domainId)!.status_label, "MR 创建失败", "旧版本失败批次不覆盖刚读到的新版本");
    assert.equal(reads.filter(path => path === file).length, 1, "同一请求中正式扫描和两个任务只解析同一文件一次");
    writeKnowledgeDeletion(f.dir, { id: f.formal.id, title: f.formal.title, revision: raw.revision, at: "2026-10-12T00:03:00Z", operator: "alice", index_ids: [f.formal.id], index_state: "removed" });
    eraseKnowledgeDocument(f.dir, f.formal.id);
    const deleted = listKnowledgeTasks(f.sources);
    // 候选任务的归档入口不随正式删除隐藏(正文在任务里);正式侧的删除
    // 立即生效由组件行与告警通道体现。
    assert.equal(deleted.tasks.find(task => task.id === f.domainId)!.production!.archive.visible, true);
    assert.equal(deleted.tasks.find(task => task.id === f.componentId)!.status_label, f.component.get(f.componentId).production!.status_label);
    assert.throws(() => readKnowledgeDocumentFacts(f.dir, f.formal.id), /知识已删除/);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); await f.close(); }
});

test("过程文稿变化和坏文件修复作废旧摘要，坏正式文件不因缓存而隐藏", async () => {
  const f = fixture();
  try {
    assert.equal(readKnowledgeDocumentFacts(f.dir, f.formal.id).revision, f.formal.revision);
    const facts = readKnowledgeDocumentFacts(f.dir, f.formal.id); facts.revision = "不能污染缓存";
    assert.equal(readKnowledgeDocumentFacts(f.dir, f.formal.id).revision, f.formal.revision);
    const emptyId = `dkx-${randomUUID()}`, emptyRoot = join(f.dir, "domain-extraction", emptyId);
    const job = JSON.parse(readFileSync(join(f.dir, "domain-extraction", f.domainId, "job.json"), "utf8"));
    job.id = emptyId; job.documents = []; job.archive_batches = []; mkdirSync(emptyRoot, { recursive: true }); writeFileSync(join(emptyRoot, "job.json"), JSON.stringify(job));
    const emptyWork = join(emptyRoot, "skill-runs", job.turns[0].id, "work.json"); mkdirSync(join(emptyRoot, "skill-runs", job.turns[0].id), { recursive: true });
    writeFileSync(emptyWork, JSON.stringify({ documents: [{ id: "inventory", title: "盘点", content: "能力盘点正文" }] }));
    const domain = new DomainKnowledgeExtraction(f.dir, async () => "unused");
    try {
      const row = () => domain.taskRows().find(task => task.id === emptyId)!;
      assert.equal(row().production!.navigation.ready_action_label, "查看文稿");
      writeFileSync(emptyWork, JSON.stringify({ documents: [] })); assert.equal(row().production!.navigation.ready_action_label, undefined);
      writeFileSync(emptyWork, "{"); assert.equal(row().production!.navigation.ready_action_label, undefined);
      assert.ok(domain.warnings().some(warning => warning.includes(emptyId)));
      writeFileSync(emptyWork, JSON.stringify({ documents: [{ id: "inventory", title: "修复后盘点", content: "新的完整正文" }] }));
      assert.equal(row().production!.navigation.ready_action_label, "查看文稿");
    } finally { await domain.shutdown(); }
    const file = join(f.dir, "knowledge-documents", `${f.formal.id}.json`), original = readFileSync(file, "utf8");
    writeFileSync(file, "{"); const warnings: string[] = []; assert.deepEqual(listKnowledgeDocumentFacts(f.dir, warnings), []);
    assert.ok(warnings.some(warning => warning.includes(f.formal.id))); assert.throws(() => readKnowledgeDocumentFacts(f.dir, f.formal.id), /记录损坏/);
    writeFileSync(file, original); assert.equal(readKnowledgeDocumentFacts(f.dir, f.formal.id).revision, f.formal.revision);
    const repairedWarnings: string[] = []; assert.equal(listKnowledgeDocumentFacts(f.dir, repairedWarnings).length, 1); assert.deepEqual(repairedWarnings, []);
  } finally { await f.close(); }
});

test("组件归档摘要保留结构损坏告警，不把只有版本号的坏组件文稿显示成可归档", async () => {
  const f = fixture();
  try {
    const file = join(f.dir, "knowledge-documents", `${f.formal.id}.json`), raw = JSON.parse(readFileSync(file, "utf8"));
    raw.content = '---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: {"broken":true}\n---\n\n# 文件操作\n正文';
    writeFileSync(file, JSON.stringify(raw));
    const archiveId = `dkx-${randomUUID()}`, root = join(f.dir, "domain-extraction", archiveId);
    const archive = JSON.parse(readFileSync(join(f.dir, "domain-extraction", f.domainId, "job.json"), "utf8"));
    archive.id = archiveId; archive.component_research_id = f.componentId;
    mkdirSync(root, { recursive: true }); writeFileSync(join(root, "job.json"), JSON.stringify(archive));
    const domain = new DomainKnowledgeExtraction(f.dir, async () => "unused");
    const component = new ComponentResearch(f.dir, async () => "unused", undefined, (id, summaryOnly) => domain.componentArchive(id, summaryOnly));
    try {
      const data = listKnowledgeTasks({ ...f.sources, domain, component });
      assert.ok(data.warnings.some(warning => warning.includes("损坏的组件知识结构")));
      // 坏组件文稿不再显示成「可归档」:入口仍在但只是只读的归档记录。
      assert.equal(data.tasks.find(task => task.id === f.componentId)!.production!.archive.visible, true);
      // 投影不读正文(性能),坏结构由告警点名+归档预览拒绝(纵深防御,
      // 预览拒绝在 knowledgeProductionManualArchiveRecords 钉);入口仍可见。
      assert.deepEqual(data.tasks.find(task => task.id === f.componentId)!.production!.archive.actions.map(action => [action.id, action.label]), [["archive", "归档"]]);
      assert.deepEqual(data.tasks.find(task => task.id === f.componentId)!.production, component.get(f.componentId).production);
    } finally { await domain.shutdown(); await component.shutdown(); }
  } finally { await f.close(); }
});

test("已确认删除的版本摘要复用校验，删除记录和精确版本文件变化仍立即拒绝旧结果", async () => {
  const f = fixture(), originalRead = fs.readFileSync;
  try {
    readKnowledgeDocumentVersion(f.dir, f.formal.id, f.formal.revision);
    const deletion = { id: f.formal.id, title: f.formal.title, revision: f.formal.revision, at: "2026-10-12T00:03:00Z", operator: "alice", index_ids: [f.formal.id], index_state: "removed" as const };
    writeKnowledgeDeletion(f.dir, deletion); eraseKnowledgeDocument(f.dir, f.formal.id);
    assert.equal(readKnowledgeArchiveVersionFacts(f.dir, f.formal.id, f.formal.revision).revision, f.formal.revision);
    const reads: string[] = [];
    fs.readFileSync = ((path: any, ...args: any[]) => {
      if (String(path).includes("/knowledge-document-versions/")) reads.push(String(path));
      return (originalRead as any)(path, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    assert.equal(readKnowledgeArchiveVersionFacts(f.dir, f.formal.id, f.formal.revision).revision, f.formal.revision); assert.deepEqual(reads, []);
    writeKnowledgeDeletion(f.dir, { ...deletion, revision: "b".repeat(64) });
    assert.throws(() => readKnowledgeArchiveVersionFacts(f.dir, f.formal.id, f.formal.revision), /只能归档删除时绑定/);
    writeKnowledgeDeletion(f.dir, deletion);
    const versionFile = join(f.dir, "knowledge-document-versions", f.formal.id, `${f.formal.revision}.json`);
    writeFileSync(versionFile, "{"); assert.throws(() => readKnowledgeArchiveVersionFacts(f.dir, f.formal.id, f.formal.revision), /归档版本记录损坏/);
    rmSync(versionFile); assert.throws(() => readKnowledgeArchiveVersionFacts(f.dir, f.formal.id, f.formal.revision), /精确归档版本未保留/);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); await f.close(); }
});
