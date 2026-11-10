import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { consumptionFixture, componentSection } from "./componentConsumptionFixture.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { componentKnowledgeCatalog } from "../src/componentKnowledgeCatalog.ts";
import { componentKnowledgeArtifacts } from "../src/componentKnowledgeArtifacts.ts";
import { restoreComponentArchive } from "../src/componentKnowledgeArchiveFormat.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

test("同一 knowledge 工具直接查询结构化组件，读正文记录版本；停用同时撤销查询与检查", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish([componentSection()], { product_versions: ["v2"] }), service = new KnowledgeSearch(f.data), events: any[] = [];
    const tool = createKnowledgeTool({ service: () => service, context: () => f.context, onUse: e => events.push(e) });
    const run = (input: any) => tool.execute("query", input, undefined, undefined, {} as any);
    const found: any = await run({ action: "search", query: "C++ 后台任务" });
    assert.equal(found.details.hits.length, 1); assert.equal(found.details.hits[0].id, doc.id);
    assert.equal(events[0].moment, "search"); assert.equal(events[0].assets[0].revision, doc.revision);
    const hit = found.details.hits[0];
    const read: any = await run({ action: "read", id: hit.id, revision: hit.revision, start_line: hit.start_line, end_line: hit.end_line });
    assert.match(read.content[0].text, /退出前等待/); assert.equal(events[1].moment, "expand");
    assert.equal(events[1].assets[0].start_line, hit.start_line);
    assert.equal((await service.search({ ...f.context, productVersion: "v1" }, "后台任务")).hits.length, 0);
    const p = componentKnowledgeCatalog(f.data, f.context).paradigms[0];
    const files = componentKnowledgeArtifacts(f.data, p.mapping_id);
    const rule = componentKnowledgeCatalog(f.data, f.context).rules[0];
    assert.deepEqual(JSON.parse(files.files[`derived/ast-grep/rules/${rule.id}.yml`]).rule, rule.rule);
    assert.ok(files.files[`derived/ast-grep/rule-tests/${rule.id}-test.yml`]);
    assert.doesNotMatch(files.files["source.md"], /schema:|repository_id|everycode-/);
    assert.equal(restoreComponentArchive(files.files["source.md"], files.files["source.metadata.json"]).trim(), doc.content.trim());
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    assert.equal((await service.search(f.context, "后台任务")).hits.length, 0);
    assert.equal(service.read(f.context, doc.id), undefined);
    assert.equal(componentKnowledgeCatalog(f.data, f.context).rules.length, 0);
    assert.throws(() => componentKnowledgeArtifacts(f.data, p.mapping_id), /停用/);
  } finally { f.cleanup(); }
});

test("普通文档仍经共享搜索服务；组件返回短卡片，来源修订即时更新", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(); let ingested = 0, ordinaryId = "";
    const sidecar: any = { ingest: async () => { ingested++; return true; }, search: async (input: any) => { ordinaryId = input.sources[0].id; const start = readFileSync(input.sources[0].path, "utf8").split("\n").findIndex(line => line === "# 上传") + 1; return input.sources.map((s: any) => ({ id: s.id, snippet: "文件上传规定", start_line: start, end_line: start + 1 })); } };
    const ordinary = saveKnowledgeDocument(f.data, { title: "上传规范", scope: "platform", content: "# 上传\n必须限制大小。" }, "expert");
    const service = new KnowledgeSearch(f.data, sidecar);
    const found = await service.search(f.context, "后台任务 上传");
    assert.equal(ingested, 2); assert.equal(ordinaryId, ordinary.id);
    assert.ok(found.hits.some(h => h.id === doc.id)); assert.ok(found.hits.some(h => h.id === ordinary.id));
    saveKnowledgeDocument(f.data, { content: doc.content.replaceAll("Pool.submit", "Pool.enqueue") }, "expert", doc.id);
    const updated = await service.search(f.context, "Pool.enqueue");
    assert.match(updated.hits.find(h => h.id === doc.id)!.summary!, /Pool.enqueue/); assert.notEqual(updated.hits.find(h => h.id === doc.id)!.revision, doc.revision);
    assert.equal(ingested, 3);
  } finally { f.cleanup(); }
});

test("普通检索故障不丢组件结果；异步等待期间停用的组件不会被旧结果带回", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(); saveKnowledgeDocument(f.data, { title: "普通资料", scope: "platform", content: "# 资料\n通用约束" }, "expert");
    const failed = new KnowledgeSearch(f.data, { ingest: async () => true, search: async () => { throw new Error("offline"); } } as any);
    assert.equal((await failed.search(f.context, "后台任务")).hits[0].id, doc.id);
    const withdrawn = new KnowledgeSearch(f.data, { ingest: async () => { saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id); return false; } } as any);
    assert.equal((await withdrawn.search(f.context, "后台任务")).hits.length, 0);
  } finally { f.cleanup(); }
});
