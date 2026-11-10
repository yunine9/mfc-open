import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { componentGuideSection } from "./fixtures/componentGuide.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";
import { componentResearchRoute } from "../src/componentResearchRoutes.ts";
import { researchEvidencePage } from "../src/knowledgeResearchEvidence.ts";

test("#469 空记录可读取，新增记录后旧翻页位置稳定，异常总数保留", () => {
  const evidence: Array<Record<string, unknown>> = [];
  assert.deepEqual(researchEvidencePage(evidence), { total: 0, errors: 0, entries: [], before: undefined });
  evidence.push(...Array.from({ length: 100 }, (_, index) => ({ preview: `记录 ${index}`, status: index === 0 ? "failed" : "returned" })));
  const page = researchEvidencePage(evidence);
  assert.equal(page.errors, 1); assert.equal(page.before, 60);
  evidence.push({ preview: "刚追加的记录" });
  const earlier = researchEvidencePage(evidence, String(page.before));
  assert.equal(earlier.entries[0].index, 59); assert.equal(earlier.total, 101);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-reader-")), turn = randomUUID();
  const body = "# 当前文稿\n" + "已经核实的知识内容。\n".repeat(1000);
  const repository = { id: "source", name: "源码", repository: "https://example.test/source.git", branch: "main", path: "", docs_path: "docs" };
  const evidence = Array.from({ length: 1200 }, (_, i) => ({ tool: "component_source", action: "read", path: `src/${i}.cpp`,
    preview: `记录 ${i}\n` + body, result: { source: body }, status: "returned" }));
  const documents: DomainKnowledgeJob["documents"] = Array.from({ length: 110 }, (_, i) => ({ id: `doc-${i}`, title: `能力 ${i}`,
    target_id: "domain", path: `docs/${i}.md`, layer: "domain", content: body, sources: "源码依据", revision: 7, selected: true,
    base_content: body, base_revision: "a".repeat(40), history: Array.from({ length: 6 }, (_, n) => ({ revision: n + 1,
      content: `历史 ${n}\n` + body, sources: "历史依据", title: `能力 ${i}`, operator: "alice", at: "2026-10-16T00:00:00Z" })) }));
  const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title: "长期研究", scope: "完整研究", operator: "alice", created_at: "2026-10-10T00:00:00Z",
    knowledge_layout: "directory-v1", status: "done", stage: "待审查", repositories: [repository], knowledge_target: { ...repository, id: "domain" },
    material_ids: [], revisions: {}, documents, evidence, publications: [],
    turns: [{ id: turn, mode: "extract", document_ids: documents.map(d => d.id), message: "研究", operator: "alice", status: "done", created_at: "2026-10-10T00:00:00Z", proposals: [] }],
    archive_batches: [{ id: "archive-old", state: "failed", issue_no: "REQ-469", created_at: "2026-10-16T00:00:00Z", operator: "alice", documents,
      targets: [{ ...repository, id: "domain" }], publications: [] }] };
  const sections = documents.map((d, i) => ({ ...componentGuideSection(`cap-${i}`, [repository.id]), content: d.content, selected: true, revision: 7 }));
  const record: ResearchRecord = { id: `cr-${randomUUID()}`, language: "cpp", topic: "长期组件研究", operator: "alice", key: "fixture", status: "done",
    created_at: job.created_at, stage: "待审查", source_repositories: [{ ...repository, enabled: true, description: "", languages: ["cpp"] }],
    evidence, document: { overview: "组件说明", sections }, draft: sections.map(s => s.content).join("\n"),
    section_history: sections.flatMap(section => Array.from({ length: 6 }, (_, i) => ({ at: "2026-10-16T00:00:00Z", operator: "alice", section: { ...section, revision: i + 1 } }))),
    pipeline: { version: 1, skill: "fixture", tasks: sections.map((section, i) => ({ id: `plan-${i}`, title: section.title, phase: "plan", status: "done", attempts: 1,
      spec: body, dependencies: [], result: { findings: body, open_questions: [], paradigms: [] } })) } };
  const domainFile = join(dir, "domain-extraction", job.id, "job.json"), componentFile = join(dir, "component-research", record.id, "record.json");
  mkdirSync(join(dir, "domain-extraction", job.id, "skill-runs", turn), { recursive: true });
  mkdirSync(join(dir, "component-research", record.id), { recursive: true });
  writeFileSync(domainFile, JSON.stringify(job)); writeFileSync(componentFile, JSON.stringify(record));
  const workFile = join(dir, "domain-extraction", job.id, "skill-runs", turn, "work.json");
  writeFileSync(workFile, JSON.stringify({ documents: [{ id: "plan", title: "完整规划", content: body }], steps: [{ candidate: { data: body.repeat(10) } }] }));
  const domain = new DomainKnowledgeExtraction(dir, async () => { throw new Error("只读验收不能启动萃取"); });
  const component = new ComponentResearch(dir, async () => { throw new Error("只读验收不能启动萃取"); });
  return { dir, domain, component, job, record, turn, workFile, domainFile, componentFile,
    close: async () => { await domain.shutdown(); await component.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("#469 长期任务阅读仅返回当前成果，历史与动态按需完整读取且不改写任务", async t => {
  const f = fixture();
  try {
    const files = [f.domainFile, f.componentFile].map(file => readFileSync(file, "utf8"));
    for (const [kind, manager, id] of [["domain", f.domain, f.job.id], ["component", f.component, f.record.id]] as const) {
      const start = performance.now(), full = manager.get(id), fullJSON = JSON.stringify(full), fullMs = performance.now() - start;
      const readStart = performance.now(), reader = manager.reader(id), readerJSON = JSON.stringify(reader), readerMs = performance.now() - readStart;
      assert.deepEqual(reader.production, full.production);
      assert.equal(reader.deferred_details, true); assert.deepEqual(reader.evidence, []);
      assert.ok(readerJSON.length < fullJSON.length / 10, "历史累积不能继续扩大首屏响应");
      t.diagnostic(`${kind}: full ${Buffer.byteLength(fullJSON)} bytes / ${fullMs.toFixed(1)} ms; reader ${Buffer.byteLength(readerJSON)} bytes / ${readerMs.toFixed(1)} ms`);
      const first = manager.evidencePage(id); assert.equal(first.total, 1200); assert.equal(first.entries.length, 40);
      assert.equal(first.entries[0].index, 1199); assert.ok(JSON.stringify(first).length < 20000);
      const seen = new Set(first.entries.map(item => item.index)); let before = first.before;
      // 新记录追加不改变旧记录的位置，翻页不跳过任何已有内容。
      while (before !== undefined) { const page = manager.evidencePage(id, String(before)); page.entries.forEach(item => { assert.ok(!seen.has(item.index)); seen.add(item.index); }); before = page.before; }
      assert.equal(seen.size, 1200); assert.deepEqual(manager.evidenceEntry(id, "0"), full.evidence[0]);
      assert.deepEqual(manager.evidenceEntry(id, "1199"), full.evidence[1199]);
      for (const bad of ["-1", "NaN", "1.5", "1201"]) assert.throws(() => manager.evidencePage(id, bad));
      assert.throws(() => manager.evidenceEntry(id, "1200"));
    }
    const reader = f.domain.reader(f.job.id);
    assert.deepEqual(reader.documents.map(d => d.content), f.job.documents.map(d => d.content));
    assert.ok(reader.documents.every(d => !d.history.length && d.base_content === null));
    assert.equal(reader.archive_batches, undefined); assert.equal(reader.work_documents![0].content, "");
    assert.deepEqual(f.domain.documentHistory(f.job.id, "doc-109"), f.job.documents[109].history);
    assert.equal(f.domain.workDocument(f.job.id, f.turn, "plan").content, f.job.documents[0].content);
    assert.throws(() => f.domain.workDocument(f.job.id, "../another-task", "plan"));
    writeFileSync(f.workFile, JSON.stringify({ documents: [{ id: "plan", title: "更新后的规划", content: "更新后的完整正文" }] }));
    assert.equal(f.domain.reader(f.job.id).work_documents![0].title, "更新后的规划");
    assert.equal(f.domain.workDocument(f.job.id, f.turn, "plan").content, "更新后的完整正文");
    const component = f.component.reader(f.record.id);
    assert.deepEqual(component.document, f.record.document); assert.deepEqual(component.section_history, []);
    assert.ok(component.pipeline!.tasks.every(task => !task.result));
    assert.deepEqual(f.component.sectionHistory(f.record.id, "cap-109"), f.record.section_history!.filter(h => h.section.id === "cap-109"));
    assert.match(f.component.workDocument(f.record.id, "plan-109").content, /当前文稿/);
    assert.deepEqual([f.domainFile, f.componentFile].map(file => readFileSync(file, "utf8")), files);
    // HTTP 入口必须使用轻量读取，不能先 get 全量结果再裁剪。
    f.domain.get = f.component.get = () => { throw new Error("禁止读取全量详情"); };
    const service = { options: { dataDir: f.dir }, getDomainKnowledgeExtraction: () => f.domain, getComponentResearch: () => f.component };
    for (const [prefix, route, id, history, work] of [["domain-extraction", domainKnowledgeRoute, f.job.id, "doc-0", `${f.turn}/plan`],
      ["component-research", componentResearchRoute, f.record.id, "cap-0", "plan-0"]] as const) {
      for (const suffix of ["reader", "evidence?before=40", "evidence/0", `history/${history}`, `work-document/${work}`]) {
        const url = `/${prefix}/${id}/${suffix}`;
        let status = 0, value: any;
        await route({ method: "GET", url } as any, {} as any, url.split("?")[0].slice(1).split("/"), service as any, "alice", async () => { throw new Error("GET 不读请求体"); }, (_r, code, data) => { status = code; value = data; });
        assert.equal(status, 200, JSON.stringify(value)); assert.ok(value);
        if (suffix === "evidence?before=40") assert.equal(value.entries[0].index, 39);
      }
    }
  } finally { await f.close(); }
});
