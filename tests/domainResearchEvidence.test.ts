import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { businessKnowledgeEvidenceId, knowledgeEvidenceTool } from "../src/domainResearchEvidence.ts";
import { knowledgeMaterialTool } from "../src/knowledgeMaterials.ts";
import { wxdoubaoTool } from "../src/wxdoubao.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";

test("业务资料正文产生可回查引用，目录和空章节不冒充已读取事实", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-evidence-"));
  try {
    const material = await businessMaterial(root), events: Array<Record<string, unknown>> = [];
    const tool = knowledgeMaterialTool([material], join(root, "knowledge-materials"), event => {
      const id = businessKnowledgeEvidenceId(event); events.push({ ...event, evidence_id: id }); return id;
    });
    await tool.execute("list", {}, undefined, undefined, {} as never); assert.equal(events.length, 0);
    await tool.execute("past-end", { id: material.id, start: 9999 }, undefined, undefined, {} as never); assert.equal(events.length, 0);
    const read = await tool.execute("read", { id: material.id }, undefined, undefined, {} as never);
    const data = JSON.parse((read.content[0] as { text: string }).text);
    assert.equal(data.evidence_id, events[0].evidence_id); assert.match(data.sections[0].text, /月底结算/);
    await tool.execute("read-again", { id: material.id }, undefined, undefined, {} as never);
    assert.equal(events[0].evidence_id, events[1].evidence_id, "重复阅读沿用引用，不虚增独立业务证据");
    const restored = JSON.parse(JSON.stringify(events));
    const reference = await knowledgeEvidenceTool(() => restored).execute("lookup", { evidence_id: data.evidence_id }, undefined, undefined, {} as never);
    const location = JSON.parse((reference.content[0] as { text: string }).text);
    assert.equal(location.material_id, material.id); assert.equal(location.version, material.version); assert.ok(location.locations.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("无线豆包实际响应有引用编号，重启后原文可分页回查；失败和空结果没有依据编号", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-query-evidence-")), executable = join(root, "cli");
  const values = { MAE_FLOW_WXDOUBAO_BIN: executable, WXDOUBAO_USERID: "fixture-user", WXDOUBAO_TOKEN: "fixture-credential" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  try {
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{structuredContent:{reason:"历史重复扣款",url:"https://example.test/decision",body:"x".repeat(20000)}}}));`, { mode: 0o700 });
    const records: Array<Record<string, unknown>> = [];
    const tool = wxdoubaoTool(new AbortController().signal, event => {
      const id = businessKnowledgeEvidenceId(event); records.push({ ...event, evidence_id: id }); return id;
    }, { evidencePaging: true });
    const response = await tool.execute("query", { question: "为什么月底不能立即取消" }, undefined, undefined, {} as never);
    const data = JSON.parse((response.content[0] as { text: string }).text); assert.ok(data.evidence_id);
    assert.equal(data.content.length, 8000); assert.equal(data.next_start, 8001); assert.equal(data.data, undefined);
    const restored = JSON.parse(JSON.stringify(records)), read = knowledgeEvidenceTool(() => restored);
    const remainder = parse(await read.execute("remaining", { evidence_id: data.evidence_id, start: data.next_start, count: 16000 }, undefined, undefined, {} as never));
    assert.equal(data.content + remainder.content, JSON.stringify(records[0].result), "首次返回有界，完整长结果可无损回读");
    const first = parse(await read.execute("page", { evidence_id: data.evidence_id, count: 100 }, undefined, undefined, {} as never));
    assert.equal(first.next_start, 101); assert.match(first.content, /历史重复扣款/); assert.equal(first.content.length, 100);
    const next = parse(await read.execute("page", { evidence_id: data.evidence_id, start: first.next_start, count: 100 }, undefined, undefined, {} as never));
    assert.equal(next.content.length, 100); assert.equal(next.query.question, "为什么月底不能立即取消");
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{structuredContent:[]}}));`, { mode: 0o700 });
    const empty = parse(await tool.execute("empty", { question: "暂无资料" }, undefined, undefined, {} as never));
    assert.equal(empty.state, "empty"); assert.equal(empty.evidence_id, undefined);
    assert.equal(businessKnowledgeEvidenceId({ tool: "business_knowledge", status: "failed" }), undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

test("共享资料目录按内容检索、去重和分页，只有回读检索正文才记录读取", async () => {
  const records: Array<Record<string, unknown>> = [
    { tool: "business_knowledge", action: "knowledge_search", status: "available", evidence_id: "old", query: { question: "结算取消" }, result: { text: "冲正要求，关联 AR123" }, at: "2026-09-20" },
    { tool: "business_knowledge", action: "knowledge_search", status: "available", evidence_id: "new", query: { question: "结算取消" }, result: { text: "更新后的规则，关联 AR123" }, worker_id: "child", at: "2026-09-21" },
    { tool: "business_knowledge", action: "knowledge_search", status: "available", evidence_id: "new", query: { question: "结算取消" }, result: { text: "更新后的规则，关联 AR123" }, at: "2026-09-22" },
    { tool: "knowledge_evidence", action: "read", status: "returned", evidence_id: "new" },
    { tool: "business_knowledge", action: "knowledge_search", status: "empty", query: { question: "其他规则" } },
    { tool: "business_knowledge", action: "knowledge_search", status: "failed", error: "身份不匹配", error_code: "authentication" },
    { tool: "knowledge_material", status: "returned", evidence_id: "material", material_id: "m1", locations: ["章节 1"] },
  ];
  const reads: Array<Record<string, unknown>> = [], tool = knowledgeEvidenceTool(() => JSON.parse(JSON.stringify(records)), e => reads.push(e));
  const execute = (params: Parameters<typeof tool.execute>[1]) => tool.execute("lookup", params, undefined, undefined, {} as never);
  const first = parse(await execute({ action: "list", query: "ar123", count: 1 }));
  assert.equal(first.total, 2); assert.equal(first.next_start, 2); assert.equal(first.entries[0].evidence_id, "new");
  assert.equal(first.entries[0].at, "2026-09-22"); assert.equal(first.entries[0].content, undefined);
  const next = parse(await execute({ action: "list", query: "ar123", start: 2 }));
  assert.equal(next.entries[0].evidence_id, "old");
  const all = parse(await execute({})); assert.equal(all.total, 5);
  assert.equal(all.entries.find((e: any) => e.status === "failed").evidence_id, undefined);
  assert.equal(all.entries.find((e: any) => e.status === "empty").evidence_id, undefined);
  assert.equal(reads.length, 0, "列表不冒充读过正文");
  await execute({ evidence_id: "new", start: 99999 });
  await execute({ evidence_id: "material" }); assert.equal(reads.length, 0, "资料位置和空分页不冒充原文");
  assert.match(((await execute({ action: "read" })).content[0] as { text: string }).text, /不在本次研究/);
  assert.match(((await execute({ evidence_id: "missing" })).content[0] as { text: string }).text, /不在本次研究/);
  const body = parse(await execute({ evidence_id: "new", count: 5 }));
  assert.equal(reads.length, 1); assert.equal(reads[0].evidence_id, "new"); assert.equal(reads[0].end, 5);
  assert.equal(body.next_start, 6); assert.equal(reads[0].result, undefined, "回读记录不重复存储全文");
});

function parse(result: { content: Array<{ type: string; text?: string }> }) { assert.equal(result.content[0].type, "text"); return JSON.parse(result.content[0].text!); }
