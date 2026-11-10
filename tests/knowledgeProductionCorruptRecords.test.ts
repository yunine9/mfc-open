import assert from "node:assert/strict";
import { componentGuideEvidence, componentGuideOverview, componentGuideSection } from "./fixtures/componentGuide.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch, researchDraftContext, researchSourceRepositories, type ResearchRecord } from "../src/componentResearch.ts";
import { ComponentResearchPipeline } from "../src/componentResearchPipeline.ts";
import { listKnowledgeDocuments, prepareKnowledgeDocument, readKnowledgeDocument, saveKnowledgeDocument, writePreparedKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { writeKnowledgeDeletion } from "../src/knowledgeDeletionStore.ts";
import { listKnowledgeTasks } from "../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";

const repository = { id: "orders", name: "订单", repository: "https://example.test/orders.git", branch: "main", path: "", docs_path: "domains" };
function domainRecord(): DomainKnowledgeJob {
  return { id: `dkx-${randomUUID()}`, title: "正常领域研究", scope: "订单规则", operator: "alice", created_at: "2026-10-02T00:00:00Z", repositories: [repository], knowledge_target: { ...repository, id: "domain" }, material_ids: [], status: "done", stage: "等待审查", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
}
function componentRecord(): ResearchRecord {
  return { id: `cr-${randomUUID()}`, component: { id: "orders", name: "订单", repository: repository.repository, branch: "main", path: "", languages: ["java"], enabled: true, description: "" }, language: "java", topic: "正常组件研究", operator: "alice", key: "fixture", status: "done", created_at: "2026-10-02T00:00:00Z", stage: "等待审查", evidence: [] };
}
function write(dir: string, relative: string, content: string) { const path = join(dir, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; }
function assertWarnings(warnings: string[], paths: string[]) { for (const path of paths) assert.ok(warnings.some(warning => warning.includes(path)), `告警应点名 ${path}`); }

function legacyComponentGuide(status: "done" | "failed" = "done"): ResearchRecord {
  const record = componentRecord(); record.status = status; record.format = "joint-document";
  const section = { ...componentGuideSection("files", [researchSourceRepositories(record)[0].id], { language: "java" }), selected: true, revision: 2 };
  delete (section as Partial<typeof section>).unit_tests;
  delete (section.paradigm as Partial<NonNullable<typeof section.paradigm>>).test_evidence;
  section.content = "旧版使用正文，保留人工确认的限制。";
  record.document = { overview: "旧版组件总览", sections: [section] }; record.draft = "旧版整篇文稿";
  record.evidence = componentGuideEvidence("java", [researchSourceRepositories(record)[0].id]);
  record.section_history = [{ at: record.created_at, operator: "alice", section: { ...structuredClone(section), revision: 1 } }];
  record.review_turns = [{ id: "old-review", section_id: section.id, mode: "rework", message: "原意见", operator: "alice", created_at: record.created_at,
    status: "done", proposal: { status: "discarded", base_revision: 1, section: structuredClone(section) } }];
  return record;
}

for (const status of ["done", "failed"] as const) test(`组件旧稿兼容：缺少 UT 新字段的 ${status} 记录、历史和建议可读，不改推荐事实或磁盘`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-legacy-guide-")), record = legacyComponentGuide(status);
  const bytes = JSON.stringify(record), path = write(dir, `component-research/${record.id}/record.json`, bytes);
  let executions = 0;
  const service = new ComponentResearch(dir, async () => { executions++; return "不能自动执行旧稿"; });
  try {
    assert.deepEqual(service.warnings(), []);
    assert.equal(service.list().length, 1);
    const loaded = service.get(record.id);
    assert.equal(loaded.status, status); assert.equal(loaded.draft, record.draft);
    for (const section of [loaded.document!.sections[0], loaded.section_history![0].section, loaded.review_turns![0].proposal!.section]) {
      assert.equal(section.content, record.document!.sections[0].content);
      assert.equal(section.unit_tests, ""); assert.deepEqual(section.paradigm!.test_evidence, []);
      assert.equal(section.paradigm!.status, "recommended", "历史推荐判断不在读取时偷偷改写");
    }
    assert.match(loaded.production!.platform_message!, /仅供研究参考.*补齐单元测试示例与测试证据/);
    if (status === "done") assert.throws(() => service.publish(record.id, { title: record.topic, document_id: null, update_document_id: null,
      sections: [{ id: "files", revision: 2, proposal_id: null }] }, "alice"), /已完成.*最佳示例/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 0); assert.equal(readFileSync(path, "utf8"), bytes);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件旧稿兼容：发布意图中的旧文稿、历史与建议可读，读取不提交正式知识", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-legacy-intent-")), record = legacyComponentGuide();
  const formal = prepareKnowledgeDocument(dir, { title: "旧组件指南", content: "原来确认的正式正文" }, "alice");
  record.publication_intent = { formal, record: { ...structuredClone(record), document_id: formal.document.id, published_revision: formal.document.revision } };
  const bytes = JSON.stringify(record), path = write(dir, `component-research/${record.id}/record.json`, bytes);
  const service = new ComponentResearch(dir, async () => { throw new Error("读取意图不能重新研究"); });
  try {
    assert.deepEqual(service.warnings(), []);
    const intent = service.get(record.id).publication_intent!;
    for (const section of [intent.record.document!.sections[0], intent.record.section_history![0].section, intent.record.review_turns![0].proposal!.section]) {
      assert.equal(section.unit_tests, ""); assert.deepEqual(section.paradigm!.test_evidence, []);
      assert.equal(section.paradigm!.status, "recommended");
    }
    assert.equal(existsSync(join(dir, "knowledge-documents", `${formal.document.id}.json`)), false);
    assert.equal(readFileSync(path, "utf8"), bytes);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件旧稿兼容：新增字段已有错误类型仍隔离，正文、历史、建议及发布意图都不能被补空掩盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-invalid-guide-fields-"));
  const records: Array<{ id: string; path: string; bytes: string }> = [];
  for (const location of ["document", "history", "proposal", "intent"] as const) for (const field of ["unit_tests", "test_evidence"] as const) {
    const record = legacyComponentGuide();
    if (location === "intent") {
      const formal = prepareKnowledgeDocument(dir, { title: "旧组件指南", content: "已有正文" }, "alice");
      record.publication_intent = { formal, record: { ...structuredClone(record), document_id: formal.document.id, published_revision: formal.document.revision } };
    }
    const section = location === "history" ? record.section_history![0].section : location === "proposal" ? record.review_turns![0].proposal!.section
      : location === "intent" ? record.publication_intent!.record.document!.sections[0] : record.document!.sections[0];
    if (field === "unit_tests") (section as unknown as Record<string, unknown>).unit_tests = null;
    else (section.paradigm as unknown as Record<string, unknown>).test_evidence = "不是数组";
    const bytes = JSON.stringify(record), path = write(dir, `component-research/${record.id}/record.json`, bytes);
    records.push({ id: record.id, path, bytes });
  }
  const service = new ComponentResearch(dir, async () => "不能执行损坏记录");
  try {
    assert.equal(service.list().length, 0); assert.equal(service.warnings().length, records.length);
    for (const record of records) {
      assert.ok(service.warnings().some(warning => warning.includes(record.id)));
      assert.equal(readFileSync(record.path, "utf8"), record.bytes);
    }
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件旧稿兼容：整体修订能够读到原稿，补齐新格式后仍需人工发布", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-legacy-rework-")), record = legacyComponentGuide();
  write(dir, `component-research/${record.id}/record.json`, JSON.stringify(record));
  let executions = 0;
  const service = new ComponentResearch(dir, async input => {
    executions++;
    assert.match(input.record.draft!, /旧版组件总览/); assert.match(input.record.draft!, /保留人工确认/);
    assert.equal(input.readDocument!().sections[0].content, record.document!.sections[0].content);
    input.editDocument!({ action: "overview", overview: componentGuideOverview("修订后的文件组件用途。", "使用 JDK 11。") });
    input.editDocument!({ action: "section", section: componentGuideSection("files", [researchSourceRepositories(record)[0].id], { language: "java" }) });
    return "已核对并补齐测试示例，等待人工审查。";
  });
  try {
    service.review(record.id, { section_id: "", mode: "rework", message: "补齐测试示例" }, "alice");
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    const revised = service.get(record.id);
    assert.equal(executions, 1); assert.equal(revised.status, "done", revised.error);
    assert.ok(revised.document!.sections[0].unit_tests.includes("assert"));
    assert.equal(revised.document_id, undefined);
    assert.equal(revised.section_history!.at(-1)!.section.content, record.document!.sections[0].content);
    assert.ok(!revised.production!.platform_message?.includes("旧版组件草稿"));
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件旧稿兼容：在途旧记录仍接续原任务，缺少新增字段不使其从列表消失", { timeout: 3_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-legacy-running-")), record = legacyComponentGuide();
  record.status = "running";
  write(dir, `component-research/${record.id}/record.json`, JSON.stringify(record));
  let executions = 0;
  const service = new ComponentResearch(dir, async input => {
    executions++;
    assert.equal(input.record.id, record.id);
    assert.equal(input.readDocument!().sections[0].content, record.document!.sections[0].content);
    await new Promise<void>((resolve, reject) => {
      const budget = setTimeout(() => reject(new Error("模拟旧研究未在 2 秒内停止")), 2_000);
      input.signal.addEventListener("abort", () => { clearTimeout(budget); resolve(); }, { once: true });
    });
    return "已响应停止";
  });
  try {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(executions, 1); assert.deepEqual(service.warnings(), []);
    assert.equal(service.list()[0].id, record.id); assert.equal(service.get(record.id).status, "running");
    assert.equal(service.get(record.id).document!.sections[0].unit_tests, "");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

for (const legacy of [true, false]) test(`组件接续：${legacy ? "旧 pipeline 全部 done 不重做，旧稿进入审查但不能发布" : "新版空 UT 即使 pipeline 全部 done 也不能冒充完成"}`, { timeout: 5_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-completed-pipeline-")), record = legacyComponentGuide();
  const pipelineFile = join(dir, "component-research", record.id, "component-pipeline", "state.json");
  const original = new ComponentResearchPipeline(pipelineFile, "same-method", [researchSourceRepositories(record)[0].id]);
  await original.run({ signal: new AbortController().signal,
    execute: async task => ({ findings: "已保存的模拟研究结果", open_questions: [],
      ...(task.phase === "inventory" ? { components: [{ id: "files", title: "文件处理", repository_ids: [researchSourceRepositories(record)[0].id], scope: "src/files.java" }] } : {}),
      ...(task.phase === "plan" ? { paradigms: [{ id: "write", title: "写入文件", need: "保存数据" }] } : {}) }),
    review: async () => undefined, changed() {},
  });
  const sectionId = "paradigm-files-write";
  const persistedPipeline = JSON.parse(readFileSync(pipelineFile, "utf8"));
  record.status = "running"; record.pipeline = persistedPipeline;
  record.document!.sections[0].id = sectionId; record.review_turns = []; record.section_history = [];
  if (!legacy) record.document = { overview: componentGuideOverview(), sections: [{ ...componentGuideSection(sectionId, [researchSourceRepositories(record)[0].id], { language: "java" }), unit_tests: "", selected: true, revision: 2 }] };
  write(dir, `component-research/${record.id}/record.json`, JSON.stringify(record));
  let authors = 0, reviews = 0;
  const service = new ComponentResearch(dir, async input => {
    const resumed = new ComponentResearchPipeline(pipelineFile, "same-method", [researchSourceRepositories(record)[0].id]);
    await resumed.run({ signal: input.signal,
      execute: async () => { authors++; throw new Error("done 项不能重做"); },
      review: async () => { reviews++; throw new Error("done 项不能重审"); },
      changed: state => input.update({ pipeline: state }),
    });
    return legacy ? researchDraftContext(input.record, input.readDocument!()) : "结束当前模拟执行";
  });
  try {
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
    const resumed = service.get(record.id);
    assert.equal(authors, 0); assert.equal(reviews, 0);
    assert.deepEqual(resumed.pipeline, persistedPipeline);
    assert.equal(resumed.status, legacy ? "done" : "failed", resumed.error);
    if (legacy) {
      assert.match(resumed.production!.platform_message!, /仅供研究参考/);
      assert.equal(resumed.document!.sections[0].content, record.document!.sections[0].content);
      assert.throws(() => service.publish(record.id, { title: record.topic, document_id: null, update_document_id: null,
        sections: [{ id: sectionId, revision: 2, proposal_id: null }] }, "alice"), /已完成.*最佳示例/);
    } else assert.match(resumed.error!, /联合草稿尚不完整/);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件旧稿兼容：已发布旧稿开始更新不把显示用空字段写回，重启仍可读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-legacy-begin-update-")), record = legacyComponentGuide();
  const formal = saveKnowledgeDocument(dir, { title: "旧组件指南", content: "原正式正文" }, "alice");
  record.document_id = formal.id; record.published_revision = formal.revision;
  const path = write(dir, `component-research/${record.id}/record.json`, JSON.stringify(record));
  const service = new ComponentResearch(dir, async () => "不自动研究已完成旧稿");
  let restarted: ComponentResearch | undefined;
  try {
    assert.equal(service.beginUpdate(record.id, "alice").update_document_id, formal.id);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(Object.hasOwn(saved.document.sections[0], "unit_tests"), false);
    assert.equal(Object.hasOwn(saved.document.sections[0].paradigm, "test_evidence"), false);
    restarted = new ComponentResearch(dir, async () => "不自动研究已完成旧稿");
    assert.deepEqual(restarted.warnings(), []); assert.equal(restarted.get(record.id).status, "done");
  } finally { await service.shutdown(); await restarted?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("#450：旧组件 mode=component、status=done 仍在知识任务中心可见，读取不改原记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue450-component-legacy-"));
  const record = { ...componentRecord(), mode: "component", draft: "已有组件知识正文" };
  const path = write(dir, `component-research/${record.id}/record.json`, JSON.stringify(record));
  const bytes = readFileSync(path, "utf8");
  let service: ComponentResearch | undefined, executions = 0;
  try {
    service = new ComponentResearch(dir, async () => { executions++; return "unused"; });
    const center = listKnowledgeTasks({ dataDir: dir, component: service,
      domain: { list: () => [], get: () => { throw new Error("无领域任务"); } }, skillExtractionJob: () => undefined });
    assert.deepEqual(center.warnings, [], "已完成的旧格式记录不应误报损坏");
    assert.deepEqual(center.tasks.map(task => [task.id, task.status]), [[record.id, "done"]]);
    assert.equal(service.get(record.id).draft, record.draft);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 0, "读取已完成的旧记录不能重新执行");
    assert.equal(readFileSync(path, "utf8"), bytes);
  } finally { await service?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("#450：组件记录格式告警指出具体字段，JSON 错误不泄漏正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue450-component-format-"));
  const invalid = componentRecord(), malformed = componentRecord();
  let service: ComponentResearch | undefined;
  try {
    write(dir, `component-research/${invalid.id}/record.json`, JSON.stringify({ ...invalid, document: { overview: "正文", sections: [{ id: "invalid", title: "无效能力" }] } }));
    write(dir, `component-research/${malformed.id}/record.json`, '{"private_note":"DO_NOT_EXPOSE_450",');
    service = new ComponentResearch(dir, async () => "unused");
    const warnings = service.warnings();
    assert.match(warnings.find(w => w.includes(invalid.id))!, /document\.sections\[0\]\.content/);
    assert.match(warnings.find(w => w.includes(malformed.id))!, /JSON/);
    assert.ok(warnings.every(w => !w.includes("DO_NOT_EXPOSE_450")));
  } finally { await service?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("#450：启动恢复写盘失败不把有效组件记录误报损坏或从列表丢弃", async t => {
  const dir = mkdtempSync(join(tmpdir(), "issue450-component-resume-"));
  const record = componentRecord(); record.status = "running"; record.format = "joint-document";
  let service: ComponentResearch | undefined, writes: ReturnType<typeof t.mock.method> | undefined, executions = 0;
  const path = write(dir, `component-research/${record.id}/record.json`, JSON.stringify(record));
  const original = readFileSync(path, "utf8"), rename = fs.renameSync;
  try {
    writes = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path) throw Object.assign(new Error("injected persistence failure"), { code: "EIO" });
      return rename(from, to);
    }); syncBuiltinESMExports();
    service = new ComponentResearch(dir, async () => { executions++; return "unused"; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.list().length, 1, "读取有效的任务必须保留可见");
    assert.equal(service.get(record.id).status, "failed", "写盘失败不能自动继续执行");
    assert.equal(executions, 0);
    assert.match(service.warnings().join("\n"), /恢复.*保存失败.*EIO/);
    assert.doesNotMatch(service.warnings().join("\n"), /记录损坏/);
    assert.equal(readFileSync(path, "utf8"), original);
    writes.mock.restore(); syncBuiltinESMExports();
    service.retry(record.id, "alice");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 1, "磁盘恢复后人工重试应能继续原任务");
    assert.equal(service.get(record.id).status, "done");
    assert.deepEqual(service.warnings(), [], "成功保存后清除恢复失败告警");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "done");
  } finally { writes?.mock.restore(); syncBuiltinESMExports(); await service?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

// 从 r8 搬入：每个读取器必须隔离单条坏记录，不能让正常邻居消失。
test("生产线验收3：领域与组件隔离语法坏及合法 JSON 坏形状记录，正常邻居可用且原坏文件不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-corrupt-records-"));
  const goodDomain = domainRecord(), goodComponent = componentRecord();
  const malformedDomain = domainRecord(), malformedComponent = componentRecord();
  const bad = [
    { relative: `domain-extraction/dkx-${randomUUID()}/job.json`, content: '{"id":' },
    { relative: `domain-extraction/${malformedDomain.id}/job.json`, content: JSON.stringify({ ...malformedDomain, documents: {}, turns: [] }) },
    { relative: `component-research/cr-${randomUUID()}/record.json`, content: "" },
    { relative: `component-research/${malformedComponent.id}/record.json`, content: JSON.stringify({ ...malformedComponent, evidence: {}, document: { sections: {} } }) },
  ];
  let domain: DomainKnowledgeExtraction | undefined, component: ComponentResearch | undefined;
  try {
    write(dir, `domain-extraction/${goodDomain.id}/job.json`, JSON.stringify(goodDomain));
    write(dir, `component-research/${goodComponent.id}/record.json`, JSON.stringify(goodComponent));
    for (const item of bad) write(dir, item.relative, item.content);
    domain = new DomainKnowledgeExtraction(dir, async () => "unused");
    component = new ComponentResearch(dir, async () => "unused");
    assert.deepEqual(domain.list().map(record => record.id), [goodDomain.id]);
    assert.deepEqual(component.list().map(record => record.id), [goodComponent.id]);
    assert.equal(domain.get(goodDomain.id).title, goodDomain.title); assert.equal(component.get(goodComponent.id).topic, goodComponent.topic);
    assertWarnings(domain.warnings(), bad.slice(0, 2).map(item => item.relative));
    assertWarnings(component.warnings(), bad.slice(2).map(item => item.relative));
    for (const item of bad) assert.equal(readFileSync(join(dir, item.relative), "utf8"), item.content, "不自动移动、改写或删除坏文件");
  } finally { await domain?.shutdown(); await component?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3：正式库隔离坏 JSON 与坏形状文档，列表和新发布仍可用且告警点名文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-corrupt-documents-"));
  try {
    const good = saveKnowledgeDocument(dir, { title: "好文档", content: "正文" }, "alice");
    const malformedId = `kd-${randomUUID()}`;
    const bad = [
      { relative: `knowledge-documents/kd-${randomUUID()}.json`, content: "" },
      { relative: `knowledge-documents/${malformedId}.json`, content: JSON.stringify({ ...good, id: malformedId, history: {}, content: null }) },
    ];
    for (const item of bad) write(dir, item.relative, item.content);
    const warnings: string[] = [];
    assert.deepEqual(listKnowledgeDocuments(dir, warnings).map(document => document.id), [good.id]);
    assertWarnings(warnings, bad.map(item => item.relative));
    const next = saveKnowledgeDocument(dir, { title: "新发布", content: "新正文" }, "alice");
    assert.deepEqual(new Set(listKnowledgeDocuments(dir).map(document => document.id)), new Set([good.id, next.id]));
    for (const item of bad) assert.equal(readFileSync(join(dir, item.relative), "utf8"), item.content);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("领域、组件和正式库坏记录保留后台诊断，不增加知识任务待处理数量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-corrupt-center-"));
  const goodDomain = domainRecord(), goodComponent = componentRecord();
  const bad = [`domain-extraction/dkx-${randomUUID()}/job.json`, `component-research/cr-${randomUUID()}/record.json`, `knowledge-documents/kd-${randomUUID()}.json`];
  let domain: DomainKnowledgeExtraction | undefined, component: ComponentResearch | undefined;
  try {
    write(dir, `domain-extraction/${goodDomain.id}/job.json`, JSON.stringify(goodDomain));
    write(dir, `component-research/${goodComponent.id}/record.json`, JSON.stringify(goodComponent));
    for (const path of bad) write(dir, path, "{");
    domain = new DomainKnowledgeExtraction(dir, async () => "unused"); component = new ComponentResearch(dir, async () => "unused");
    const center = listKnowledgeTasks({ dataDir: dir, domain, component, skillExtractionJob: () => undefined });
    assert.deepEqual(new Set(center.tasks.map(task => task.id)), new Set([goodDomain.id, goodComponent.id]));
    assertWarnings(center.warnings, bad);
    assert.equal(center.summary.attention, center.tasks.filter(task => task.group === "attention").length, "后台诊断不计入待处理任务");
    for (const path of bad) assert.equal(readFileSync(join(dir, path), "utf8"), "{");
  } finally { await domain?.shutdown(); await component?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4：正式库准备只读并确定精确版本，提交原子写入且 unchanged 不增版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-prepared-document-"));
  try {
    const prepared = prepareKnowledgeDocument(dir, { title: "订单规则", content: "第一版" }, "alice");
    assert.match(prepared.document.id, /^kd-[a-f0-9-]{36}$/); assert.match(prepared.document.revision, /^[a-f0-9]{64}$/);
    assert.equal(prepared.previous_revision, null); assert.equal(prepared.unchanged, false);
    assert.equal(existsSync(join(dir, "knowledge-documents")), false); assert.equal(existsSync(join(dir, "knowledge-document-versions")), false);
    const committed = writePreparedKnowledgeDocument(dir, prepared);
    assert.deepEqual(committed, prepared.document); assert.deepEqual(readKnowledgeDocument(dir, committed.id), JSON.parse(JSON.stringify(prepared.document)));
    const versions = join(dir, "knowledge-document-versions", committed.id);
    const before = readdirSync(versions).sort(), original = readFileSync(join(dir, "knowledge-documents", `${committed.id}.json`), "utf8");
    const unchanged = prepareKnowledgeDocument(dir, { content: committed.content }, "bob", committed.id, { expectedRevision: committed.revision });
    assert.equal(unchanged.unchanged, true); assert.equal(unchanged.previous_revision, committed.revision);
    writePreparedKnowledgeDocument(dir, unchanged);
    assert.deepEqual(readdirSync(versions).sort(), before); assert.equal(readFileSync(join(dir, "knowledge-documents", `${committed.id}.json`), "utf8"), original);
    assert.ok(readdirSync(join(dir, "knowledge-documents")).every(path => !path.endsWith(".tmp")));
    assert.ok(readdirSync(versions).every(path => !path.endsWith(".tmp")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4：准备后基线前进或知识被删除，提交拒绝且不覆盖正式版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-prepared-conflict-"));
  try {
    const original = saveKnowledgeDocument(dir, { title: "订单规则", content: "第一版" }, "alice");
    const prepared = prepareKnowledgeDocument(dir, { content: "待提交修改" }, "alice", original.id, { expectedRevision: original.revision });
    const newer = saveKnowledgeDocument(dir, { content: "他人刚发布" }, "bob", original.id, { expectedRevision: original.revision });
    assert.throws(() => writePreparedKnowledgeDocument(dir, prepared), /已有新版本/);
    assert.equal(readKnowledgeDocument(dir, original.id).revision, newer.revision);
    const deleted = prepareKnowledgeDocument(dir, { content: "删除前准备的修改" }, "alice", original.id, { expectedRevision: newer.revision });
    const bytes = readFileSync(join(dir, "knowledge-documents", `${original.id}.json`), "utf8");
    writeKnowledgeDeletion(dir, { id: original.id, title: original.title, revision: newer.revision, at: new Date().toISOString(), operator: "bob", index_ids: [], index_state: "pending" });
    assert.throws(() => writePreparedKnowledgeDocument(dir, deleted), /已删除/);
    assert.equal(readFileSync(join(dir, "knowledge-documents", `${original.id}.json`), "utf8"), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4：准备后模块停用或研究知识删除，提交重验后不产生正式知识及版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-prepared-validation-"));
  try {
    createBusinessModule(dir, { id: "orders", name: "订单", description: "订单规则", owner: "alice", repositories: [repository.repository] }, "alice");
    const prepared = prepareKnowledgeDocument(dir, { title: "模块规则", content: "正文", scope: "module", module_ids: ["orders"] }, "alice");
    updateBusinessModule(dir, "orders", { status: "archived" }, "bob");
    assert.throws(() => writePreparedKnowledgeDocument(dir, prepared), /业务模块已停用/);
    assert.equal(existsSync(join(dir, "knowledge-documents")), false); assert.equal(existsSync(join(dir, "knowledge-document-versions")), false);
    const research = prepareKnowledgeDocument(dir, { title: "研究规则", content: "研究正文", research_source: { job_id: "dkx-deleted", repository: repository.repository, branch: "main", path: "domains/rules.md" } }, "alice");
    writeKnowledgeDeletion(dir, { id: `kd-${randomUUID()}`, title: "已删除研究规则", revision: "a".repeat(64), at: new Date().toISOString(), operator: "bob", research_job_id: "dkx-deleted", index_ids: [], index_state: "pending" });
    assert.throws(() => writePreparedKnowledgeDocument(dir, research), /本次萃取的知识已删除/);
    assert.equal(existsSync(join(dir, "knowledge-documents")), false); assert.equal(existsSync(join(dir, "knowledge-document-versions")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3（F5）：活动组件讨论缺少文稿或对应章节时逐条隔离，坏字节不改且正常邻居可读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-active-shape-"));
  const good = componentRecord();
  const bad = ["missing-document", "missing-section"].map(kind => {
    const record = componentRecord();
    record.status = "running";
    record.review_turns = [{ id: "review-original", section_id: "orders", mode: "discuss", message: "讨论订单组件", operator: "alice", status: "running", created_at: record.created_at }];
    if (kind === "missing-section") record.document = { overview: "已有总览", sections: [] };
    return { path: `component-research/${record.id}/record.json`, bytes: JSON.stringify(record) };
  });
  let research: ComponentResearch | undefined;
  try {
    write(dir, `component-research/${good.id}/record.json`, JSON.stringify(good));
    for (const entry of bad) write(dir, entry.path, entry.bytes);
    let executions = 0;
    research = new ComponentResearch(dir, async () => { executions++; throw new Error("损坏记录不应进入执行"); });
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.deepEqual(research.list().map(record => record.id), [good.id]);
    assert.equal(research.get(good.id).topic, good.topic);
    assert.equal(executions, 0);
    assertWarnings(research.warnings(), bad.map(entry => entry.path));
    for (const entry of bad) assert.equal(readFileSync(join(dir, entry.path), "utf8"), entry.bytes);
  } finally {
    await research?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收3（F5）：范式证据只认任务参考范围，范围外仓的证据如实失败；重启读取与写入口一致", async () => {
  const { saveComponentRepository } = await import("../src/componentRepositories.ts");
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-multi-repository-read-"));
  seedTechnologyStacks(dir, ["java"]);
  const first = saveComponentRepository(dir, { name: "订单组件", repository: "https://example.test/orders.git", branch: "main", path: "src", languages: ["java"] }, "alice");
  const second = saveComponentRepository(dir, { name: "公共文件组件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["java"] }, "alice");
  const evidence = { repository_id: first.id, path: "src/Orders.java", revision: "a".repeat(40), start: 1, end: 3 };
  let cited = evidence;
  let initial: ComponentResearch | undefined, restarted: ComponentResearch | undefined;
  try {
    initial = new ComponentResearch(dir, async input => {
      input.editDocument!({ action: "overview", overview: componentGuideOverview("订单组件通过公共文件组件保存数据。", "依赖公共文件组件。") });
      input.editDocument!({ action: "outline", entries: [{ id: "orders", title: "订单保存", repository_ids: [first.id] }] });
      input.editDocument!({ action: "section", section: { id: "orders", title: "订单保存", repository_ids: [first.id], content: "订单保存约束。", interfaces: "save(order)", integration: "依赖公共文件组件。",
        example: "```java\nFiles.save(order);\n```", unit_tests: "", sources: "公共文件实现", related_ids: [],
        paradigm: { kind: "contracts", component: "orders", language: "java", status: "unverified", need: "保存订单", api: ["Files.save"], applicability: "公共文件组件可用。",
          replaces: { identifiers: [], imports: [], patterns: [] }, evidence: [cited], usage_evidence: [], test_evidence: [], open_questions: [] } } });
      return "草稿已保存";
    });
    // 明确限定参考来源范围时，未纳入范围的仓不能成为该任务的源码依据。
    cited = { ...evidence, repository_id: second.id };
    const misplaced = initial.start({ language: "java", repository_ids: [first.id]}, "alice");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(initial.get(misplaced.id).status, "failed");
    assert.match(initial.get(misplaced.id).error!, /基础仓固定版本/);
    initial.remove(misplaced.id, "alice");
    cited = evidence;
    const job = initial.start({ language: "java", repository_ids: [first.id]}, "alice");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(initial.get(job.id).status, "done", initial.get(job.id).error);
    const before = initial.get(job.id);
    const path = join(dir, "component-research", job.id, "record.json"), bytes = readFileSync(path, "utf8");
    await initial.shutdown();
    restarted = new ComponentResearch(dir, async () => { throw new Error("已完成研究无需再执行"); });
    assert.deepEqual(restarted.warnings(), []);
    assert.deepEqual(restarted.get(job.id), JSON.parse(JSON.stringify(before)));
    assert.deepEqual(restarted.get(job.id).document!.sections[0].paradigm!.evidence, [evidence]);
    assert.equal(readFileSync(path, "utf8"), bytes, "合法旧记录无需改写");
  } finally {
    await initial?.shutdown(); await restarted?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
