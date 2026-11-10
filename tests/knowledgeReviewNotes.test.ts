import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKnowledgeReviewNotes, listKnowledgeReviewNotes, resolveKnowledgeReviewNotes, saveKnowledgeReviewNote, type KnowledgeReviewSources } from "../src/knowledgeReviewNotes.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { uploadHostSkill } from "../src/hostSkillLibrary.ts";
import { createBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-review-notes-"));
  const domainJob = { id: "dkx-1", documents: [{ id: "rules", title: "业务规则", content: "第一行\n第二行", revision: 3 }, { id: "api", title: "接口规则", content: "正文", revision: 2 }], turns: [] } as unknown as DomainKnowledgeJob;
  const componentJob = { id: "cr-1", document: { overview: "总览", sections: [{ id: "pool", title: "连接池", content: "第一行\n第二行", revision: 4 }, { id: "cache", title: "缓存", revision: 1 }] }, review_turns: [] } as unknown as ResearchRecord;
  const calls: Array<{ kind: string; input: unknown; operator: string }> = [];
  const sources: KnowledgeReviewSources = { dataDir,
    domain: { get: () => structuredClone(domainJob), run: (_id, input, operator) => {
      calls.push({ kind: "domain", input, operator });
      domainJob.turns.push({ id: domainJob.turns.length ? `turn-domain-${domainJob.turns.length + 1}` : "turn-domain", mode: "revise", document_ids: input.document_ids!, message: input.message!, review_note_ids: input.review_note_ids, operator, created_at: new Date().toISOString(), status: "queued", proposals: [] });
      return structuredClone(domainJob);
    } },
    component: { get: () => structuredClone(componentJob), review: (_id, input, operator) => {
      calls.push({ kind: "component", input, operator });
      componentJob.review_turns!.push({ ...input, id: "turn-component", operator, created_at: new Date().toISOString(), status: "queued" });
      return structuredClone(componentJob);
    } },
  };
  return { dataDir, sources, domainJob, componentJob, calls, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("批注按文稿持久化并保留选中位置，不要求版本；非法路径不能写入", () => {
  const f = fixture();
  try {
    const result = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "line", line: 2, line_end: 2, quote: "第二行", context_before: "第一行", note: "补充失败处理" }, "alice");
    assert.equal(result.notes[0].status, "open");
    assert.equal(result.notes[0].operator, "alice");
    assert.equal(result.notes[0].document_title, "业务规则");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "domain", "dkx-1"), JSON.parse(JSON.stringify(result)));
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "domain", "../dkx-1"), /编号无效/);
    assert.equal(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes.length, 1);
  } finally { f.cleanup(); }
});

test("文稿更新后仍把所选意见交给原领域修订入口，并记录该轮；不能重复提交", () => {
  const f = fixture();
  try {
    saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "补充失败处理" }, "alice");
    const notes = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "api", scope: "document", note: "增加示例" }, "bob").notes;
    f.domainJob.documents[0].revision = 4; f.domainJob.documents[0].content = "已调整后的正文";
    const result = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "reviewer");
    assert.equal(result.notes[0].status, "submitted");
    assert.equal(result.notes[1].status, "open");
    assert.equal(result.turn_id, "turn-domain");
    assert.equal(result.notes[0].submitted_by, "reviewer");
    const input = f.calls[0].input as { mode: string; document_ids: string[]; message: string; review_note_ids: string[] };
    assert.equal(input.mode, "revise");
    assert.deepEqual(input.document_ids, ["rules"]);
    assert.deepEqual(input.review_note_ids, [notes[0].id]);
    assert.match(input.message, /补充失败处理/);
    assert.match(input.message, /核对最新正文/);
    assert.doesNotMatch(input.message, /草稿版本/);
    assert.doesNotMatch(input.message, /增加示例/);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "reviewer"), /已经提交/);
    assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});

test("跨文稿行、整篇和全局意见超过 20000 字仍可一次提交领域修订，未选意见保留", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 65; index++) saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", index % 3 === 0
      ? { document_id: "rules", scope: "line", line: 2, quote: "原行引用".repeat(600), context_before: "保存时的前文", context_after: "保存时的后文", note: `行意见 ${index}：${"补充业务边界和失败条件。".repeat(160)}` }
      : index % 3 === 1 ? { document_id: "api", scope: "document", note: `整篇意见 ${index}：${"补充接口返回条件。".repeat(160)}` }
        : { document_id: "", scope: "study", note: `全局意见 ${index}：${"统一业务术语和必要关联。".repeat(160)}` }, "alice");
    const before = listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes;
    const ids = before.slice(0, 64).map(note => note.id);
    assert.ok(JSON.stringify(before).length > 20_000);
    let taskReads = 0;
    const get = f.sources.domain.get;
    f.sources.domain.get = id => { taskReads++; return get(id); };
    const result = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [...ids, ids[0]] }, "reviewer");
    assert.ok(taskReads <= 3, "批量校验不能按意见条数重复读取大型任务及全部文稿");
    assert.equal(f.calls.length, 1);
    const input = f.calls[0].input as { mode: string; document_ids: string[]; message: string; review_note_ids: string[] };
    assert.equal(input.mode, "revise");
    assert.deepEqual(input.document_ids, ["rules", "api"]);
    assert.deepEqual(input.review_note_ids, ids);
    assert.equal(input.message.length < 20_000, true);
    assert.match(input.message, /共 64 条意见/);
    assert.match(input.message, /knowledge_review_notes/);
    assert.doesNotMatch(input.message, /原行引用/);
    assert.ok(!input.message.includes(before[0].note), "只提供有界摘要，不把完整意见重新注入每个会话");
    assert.deepEqual(result.notes.filter(note => note.status === "submitted").map(note => note.id), ids);
    assert.equal(result.notes[64].status, "open");
    for (let index = 0; index < before.length; index++) {
      assert.equal(result.notes[index].note, before[index].note);
      assert.equal(result.notes[index].quote, before[index].quote);
      assert.equal(result.notes[index].context_before, before[index].context_before);
      assert.equal(result.notes[index].context_after, before[index].context_after);
    }
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes, result.notes);
    assert.deepEqual(f.domainJob.turns[0].review_note_ids, ids);
  } finally { f.cleanup(); }
});

test("组件批量意见仍沿用 20000 字限制，拒绝时全部保留为未提交", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 3; index++) saveKnowledgeReviewNote(f.sources, "component", "cr-1", {
      document_id: "pool", scope: "document", note: `意见 ${index}：${"补充连接回收条件。".repeat(900)}`,
    }, "alice");
    const notes = listKnowledgeReviewNotes(f.sources, "component", "cr-1").notes;
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: notes.map(note => note.id) }, "alice"), /超过 20000 字/);
    assert.equal(f.calls.length, 0);
    assert.equal(listKnowledgeReviewNotes(f.sources, "component", "cr-1").notes.every(note => note.status === "open"), true);
  } finally { f.cleanup(); }
});

test("文稿删除或原修订入口拒绝时保留未处理意见，不假装成功", () => {
  const f = fixture();
  try {
    const { notes } = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "补充边界" }, "alice");
    const removed = f.domainJob.documents.shift()!;
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "alice"), /不存在/);
    f.domainJob.documents.unshift({ ...removed, revision: 4 });
    f.sources.domain.run = () => { throw new Error("本轮仍在进行"); };
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "alice"), /仍在进行/);
    assert.equal(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes[0].status, "open");
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("组件批注按现有单章节返工边界提交，跨章节不会部分执行", () => {
  const f = fixture();
  try {
    saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "pool", scope: "line", line: 1, note: "说明回收时机" }, "alice");
    const { notes } = saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "cache", scope: "document", note: "增加失效示例" }, "alice");
    f.componentJob.document!.sections[0].revision = 5;
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: notes.map(note => note.id) }, "alice"), /一个章节/);
    assert.equal(f.calls.length, 0);
    const result = applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [notes[0].id] }, "alice");
    assert.equal(result.turn_id, "turn-component");
    const input = f.calls[0].input as { mode: string; section_id: string; message: string };
    assert.equal(input.mode, "rework");
    assert.equal(input.section_id, "pool");
    assert.match(input.message, /第 1 行/);
  } finally { f.cleanup(); }
});

test("正式文档意见保存后可刷新查看，修改正文后直接标为已处理，不绑定版本", () => {
  const f = fixture();
  try {
    const doc = saveKnowledgeDocument(f.dataDir, { title: "订单规则", content: "第一行\n第二行" }, "alice");
    const other = saveKnowledgeDocument(f.dataDir, { title: "其他规则", content: "其他文档" }, "alice");
    const input = { document_id: doc.id, scope: "line" as const, line: 2, quote: "第二行", note: "补充异常处理" };
    const saved = saveKnowledgeReviewNote(f.sources, "published", doc.id, input, "alice");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", doc.id), JSON.parse(JSON.stringify(saved)));
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "published", doc.id, { ...input, document_id: other.id }, "alice"), /不存在/);
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "published", `../${doc.id}`), /编号无效/);
    assert.throws(() => resolveKnowledgeReviewNotes(f.sources, "published", other.id, { note_ids: [saved.notes[0].id] }, "alice"), /不存在/);
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "published", other.id), { notes: [], submissions: {} });
    saveKnowledgeDocument(f.dataDir, { content: "改后的正文\n已补充异常处理" }, "bob", doc.id);
    const resolved = resolveKnowledgeReviewNotes(f.sources, "published", doc.id, { note_ids: [saved.notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(resolved.notes[0].resolved_by, "bob");
    assert.equal(resolved.notes[0].quote, "第二行", "正文更新不抹掉原意见引用");
    assert.deepEqual(resolveKnowledgeReviewNotes(f.sources, "published", doc.id, { note_ids: [saved.notes[0].id] }, "alice"), resolved, "重复处理不改写处理人");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", doc.id), resolved);
    const next = saveKnowledgeReviewNote(f.sources, "published", doc.id, { ...input, note: "再次补充" }, "alice");
    assert.equal(next.notes.length, 2);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "published", doc.id, { note_ids: [next.notes[1].id] }, "alice"), /先更新文档/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("Skill Markdown 意见按包和文件隔离，更新包后仍可处理，拒绝越界路径与其他文件", async () => {
  const f = fixture();
  seedTechnologyStacks(f.dataDir, ["java"]);
  const skill = "---\nname: review-skill\ndescription: 审阅测试\n---\n\n# Skill\n查看参考文档。";
  const metadata = { nature: "engineering" as const, business_module_ids: [], repositories: [], technologies: ["java"] };
  const files = (text: string) => [{ path: "SKILL.md", content_base64: Buffer.from(skill).toString("base64") },
    { path: "references/guide.md", content_base64: Buffer.from(text).toString("base64") },
    { path: "scripts/run.txt", content_base64: Buffer.from("不属于Markdown").toString("base64") }];
  try {
    await uploadHostSkill(f.dataDir, "review_skill.v1", files("使用说明"), "alice", metadata);
    await uploadHostSkill(f.dataDir, "another-skill", files("其他包说明"), "alice", metadata);
    const input = { document_id: "references/guide.md", scope: "document" as const, note: "补充使用示例" };
    const saved = saveKnowledgeReviewNote(f.sources, "skill", "review_skill.v1", input, "alice");
    assert.equal(saved.notes[0].document_id, input.document_id);
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "skill", "review_skill.v1", { ...input, document_id: "../SKILL.md" }, "alice"), /不存在/);
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "skill", "review_skill.v1", { ...input, document_id: "scripts/run.txt" }, "alice"), /不存在/);
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "skill", "../review_skill.v1"), /编号无效/);
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "skill", "another-skill"), { notes: [], submissions: {} });
    assert.throws(() => resolveKnowledgeReviewNotes(f.sources, "skill", "another-skill", { note_ids: [saved.notes[0].id] }, "alice"), /不存在/);
    await uploadHostSkill(f.dataDir, "review_skill.v1", files("已补充使用示例"), "bob", metadata);
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "skill", "review_skill.v1"), JSON.parse(JSON.stringify(saved)));
    const resolved = resolveKnowledgeReviewNotes(f.sources, "skill", "review_skill.v1", { note_ids: [saved.notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(resolved.notes[0].resolved_by, "bob");
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "skill", "review_skill.v1", { note_ids: [saved.notes[0].id] }, "bob"), /先更新文档/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("组件章节的意见可在人工修改后标为已处理，不触发新研究", () => {
  const f = fixture();
  try {
    const { notes } = saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "pool", scope: "line", line: 1, note: "补充连接释放时机" }, "alice");
    f.componentJob.document!.sections[0].revision = 5;
    const resolved = resolveKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(f.calls.length, 0);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [notes[0].id] }, "bob"), /已经提交/);
  } finally { f.cleanup(); }
});

test("本地模块资料不再作为正式文稿，模块 Skill 批注仍持久化、隔离并安全存储", () => {
  const f = fixture();
  try {
    createBusinessModule(f.dataDir, { id: "orders", name: "订单", description: "订单模块", owner: "alice", repositories: ["https://example.test/orders.git"] }, "alice");
    const asset = { id: "rules", title: "订单规则", summary: "订单规则摘要", when_to_use: "研究订单时", content: "# 规则\n原有业务资料" };
    publishBusinessKnowledgeAsset(f.dataDir, "orders", asset, "alice");
    publishBusinessKnowledgeAsset(f.dataDir, "orders", { ...asset, id: "legacy-skill", form: "skill", title: "模块 Skill" }, "alice");
    publishBusinessKnowledgeAsset(f.dataDir, "orders", { ...asset, id: "other-skill", form: "skill", title: "其他模块 Skill" }, "alice");
    const localId = "module:orders:rules";
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "published", localId), /文档已不存在/);
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "published", localId, { document_id: localId, scope: "document", note: "不能把本地资料当作已合入知识" }, "alice"), /文档已不存在/);
    const id = "module:orders:legacy-skill", otherId = "module:orders:other-skill";
    const result = saveKnowledgeReviewNote(f.sources, "published", id, { document_id: id, scope: "line", line: 2, note: "补充失败条件" }, "alice");
    assert.equal(result.notes[0].document_id, id); assert.equal(result.notes[0].document_title, "模块 Skill");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", id), JSON.parse(JSON.stringify(result)));
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "published", otherId), { notes: [], submissions: {} });
    assert.throws(() => resolveKnowledgeReviewNotes(f.sources, "published", otherId, { note_ids: [result.notes[0].id] }, "alice"), /不存在/);
    assert.match(readdirSync(join(f.dataDir, "knowledge-review", "published"))[0], /^asset-[a-f0-9]{64}\.json$/);
    for (const bad of ["module:orders:../rules", "module:orders:rules\0", "module:orders:" + "a".repeat(512)]) assert.throws(() => listKnowledgeReviewNotes(f.sources, "published", bad), /编号无效/);
    publishBusinessKnowledgeAsset(f.dataDir, "orders", { ...asset, id: "legacy-skill", form: "skill", title: "模块 Skill", content: "# 规则\n已补充失败条件" }, "bob");
    const resolved = resolveKnowledgeReviewNotes(f.sources, "published", id, { note_ids: [result.notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", id), resolved);
    assert.equal(saveKnowledgeReviewNote(f.sources, "published", id, { document_id: id, scope: "document", note: "补充模块 Skill 示例" }, "alice").notes.length, 2);
    assert.equal(f.calls.length, 0, "保存和处理 Skill 意见不触发研究任务");
  } finally { f.cleanup(); }
});

test("#457 整体意见不绑定某一文档，领域覆盖全部文稿，组件交给整体返工", () => {
  const f = fixture();
  try {
    const domain = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "", scope: "study", note: "缺少异常恢复，几份文稿介绍重复" }, "alice");
    f.domainJob.documents.shift();
    const applied = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [domain.notes[0].id] }, "alice");
    assert.deepEqual((f.calls[0].input as any).document_ids, ["api"]);
    assert.match((f.calls[0].input as any).message, /本次任务的全部文稿/);
    assert.equal(applied.submissions[applied.turn_id!].working, true);
    assert.match(applied.submissions[applied.turn_id!].status_label, /等待 Agent/);
    f.domainJob.turns[0].status = "done";
    assert.match(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").submissions[applied.turn_id!].status_label, /修改完成/);
    const component = saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "", scope: "study", note: "补充缺失内容，删除重复介绍" }, "alice");
    const result = applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [component.notes[0].id] }, "alice");
    assert.equal((f.calls[1].input as any).section_id, "");
    f.componentJob.review_turns![0].status = "failed"; f.componentJob.review_turns![0].error = "来源读取失败";
    const failed = listKnowledgeReviewNotes(f.sources, "component", "cr-1");
    assert.equal(failed.notes[0].status, "open");
    assert.equal(failed.submissions[result.turn_id!].working, false);
    assert.equal(failed.submissions[result.turn_id!].error, "来源读取失败");
  } finally { f.cleanup(); }
});

test("领域意见按检视轮次提交，省略轮次参数也不能混入另一轮或旧意见", () => {
  const f = fixture(), inspection = randomUUID(), other = randomUUID();
  try {
    for (const [document_id, inspection_id] of [["rules", inspection], ["api", inspection], ["rules", other], ["rules", undefined]]) {
      saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: document_id!, scope: "document", note: "核对规则", inspection_id }, "alice");
    }
    const notes = listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes;
    assert.equal(notes[0].inspection_id, inspection);
    for (const note_ids of [[notes[0].id, notes[2].id], [notes[0].id, notes[3].id]]) {
      assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids }, "alice"), /同一检视轮次/);
    }
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id], inspection_id: other }, "alice"), /同一检视轮次/);
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "核对", inspection_id: "not-a-uuid" }, "alice"), /轮次编号无效/);
    assert.equal(f.calls.length, 0);
    const submitted = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id, notes[1].id], inspection_id: inspection }, "alice");
    assert.deepEqual(submitted.notes.filter(note => note.status === "submitted").map(note => note.id), [notes[0].id, notes[1].id]);
    assert.equal(submitted.notes[2].status, "open"); assert.equal(submitted.notes[3].status, "open");
  } finally { f.cleanup(); }
});

for (const terminal of ["failed", "cancelled", "discarded"] as const) test(`领域 ${terminal} 批次只显式复制重试，保留原意见与批次历史`, () => {
  const f = fixture(), inspection = randomUUID();
  try {
    saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "line", line: 2, quote: "第二行", context_before: "第一行", note: "补充失败条件", inspection_id: inspection }, "alice");
    const saved = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "", scope: "study", note: "同步接口描述", inspection_id: inspection }, "bob");
    const ids = saved.notes.map(note => note.id);
    const first = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: ids, inspection_id: inspection }, "alice");
    const path = join(f.dataDir, "knowledge-review/domain/dkx-1.json"), original = readFileSync(path, "utf8");
    f.domainJob.turns[0].status = terminal === "discarded" ? "done" : terminal;
    if (terminal === "discarded") f.domainJob.turns[0].proposals.push({ status: "discarded", document: { id: "rules" } } as any);
    const history = listKnowledgeReviewNotes(f.sources, "domain", "dkx-1");
    assert.deepEqual(history.notes, first.notes); assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(history.submissions[first.turn_id!].retryable, true);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: ids }, "alice"), /已经提交/);
    const run = f.sources.domain.run;
    f.sources.domain.run = (id, input, operator) => {
      const staged = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(input.review_note_ids!.every(id => staged.some((note: any) => note.id === id)), "真实 run 校验意见时新副本已可读取");
      return run(id, input, operator);
    };
    const second = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: ids, retry: true }, "reviewer");
    assert.deepEqual(second.notes.slice(0, 2), first.notes, "原意见及提交人、时间和轮次都不覆盖");
    const copies = second.notes.slice(2);
    assert.equal(copies.length, 2); assert.equal(copies[0].inspection_id, copies[1].inspection_id); assert.notEqual(copies[0].inspection_id, inspection);
    for (let index = 0; index < copies.length; index++) {
      assert.notEqual(copies[index].id, ids[index]); assert.equal(copies[index].retry_of, ids[index]);
      assert.equal(copies[index].note, first.notes[index].note); assert.equal(copies[index].quote, first.notes[index].quote);
      assert.equal(copies[index].context_before, first.notes[index].context_before); assert.equal(copies[index].turn_id, second.turn_id);
      assert.equal(copies[index].submitted_by, "reviewer"); assert.equal(copies[index].status, "submitted");
    }
    assert.deepEqual(f.domainJob.turns[1].review_note_ids, copies.map(note => note.id));
    assert.equal(second.submissions[first.turn_id!].retryable, false);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: ids, retry: true }, "reviewer"), /不能重试/);
    assert.equal(f.calls.length, 2);
  } finally { f.cleanup(); }
});

test("旧 open 带提交轮次仍是历史意见，不能混入新检视；成功历史不能重试", () => {
  const f = fixture();
  try {
    const saved = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "历史意见" }, "alice");
    const first = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id] }, "alice");
    const path = join(f.dataDir, "knowledge-review/domain/dkx-1.json"), legacy = first.notes.map(note => ({ ...note, status: "open" }));
    writeFileSync(path, JSON.stringify(legacy)); f.domainJob.turns[0].status = "done";
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes, legacy);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id] }, "alice"), /已经提交/);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id], retry: true }, "alice"), /不能重试/);
    f.domainJob.turns[0].status = "failed";
    const retry = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id], retry: true }, "alice");
    assert.deepEqual(retry.notes[0], legacy[0]); assert.equal(retry.notes[1].retry_of, legacy[0].id);
  } finally { f.cleanup(); }
});

test("旧未提交意见可显式复制到新轮次，原 open 记录不再可普通重复提交", () => {
  const f = fixture();
  try {
    const saved = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "旧意见" }, "alice");
    const result = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id], retry: true }, "bob");
    assert.deepEqual(result.notes[0], JSON.parse(JSON.stringify(saved.notes[0]))); assert.equal(result.notes[1].retry_of, saved.notes[0].id);
    assert.ok(result.notes[1].inspection_id); assert.equal(result.notes[1].status, "submitted");
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id] }, "alice"), /已生成重试批次/);
  } finally { f.cleanup(); }
});

test("失败重试沿同源链追踪，活动、已成功或已处理的后代阻止再次重试旧批次", () => {
  const f = fixture();
  try {
    const saved = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "核对边界" }, "alice");
    const first = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id] }, "alice"); f.domainJob.turns[0].status = "failed";
    const second = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [first.notes[0].id], retry: true }, "alice"); f.domainJob.turns[1].status = "failed";
    const third = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [second.notes[1].id], retry: true }, "alice");
    assert.equal(third.notes[2].retry_of, second.notes[1].id);
    for (const status of ["queued", "running", "paused", "done"] as const) {
      f.domainJob.turns[2].status = status;
      for (const note of third.notes) assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [note.id], retry: true }, "alice"), /不能重试/);
      const response = listKnowledgeReviewNotes(f.sources, "domain", "dkx-1");
      assert.equal(response.submissions[first.turn_id!].retryable, false); assert.equal(response.submissions[second.turn_id!].retryable, false);
    }
    f.domainJob.turns[2].status = "failed";
    resolveKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [third.notes[2].id] }, "alice");
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [first.notes[0].id], retry: true }, "alice"), /不能重试/);
    assert.equal(f.calls.length, 3);
  } finally { f.cleanup(); }
});

test("重试不能混合失败批次；run 拒绝时回滚新副本并逐字保留原记录", () => {
  const f = fixture();
  try {
    const ids: string[] = [];
    for (const document_id of ["rules", "api"]) {
      const saved = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id, scope: "document", note: "核对边界" }, "alice");
      const id = saved.notes.at(-1)!.id; ids.push(id);
      applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [id] }, "alice"); f.domainJob.turns.at(-1)!.status = "failed";
    }
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: ids, retry: true }, "alice"), /同一批次/);
    const path = join(f.dataDir, "knowledge-review/domain/dkx-1.json"), original = readFileSync(path, "utf8");
    f.sources.domain.run = (_id, input) => {
      const staged = JSON.parse(readFileSync(path, "utf8")); assert.equal(staged.length, 3);
      assert.equal(staged[2].id, input.review_note_ids![0]); throw new Error("服务正在停止");
    };
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [ids[0]], retry: true }, "alice"), /服务正在停止/);
    assert.equal(readFileSync(path, "utf8"), original); assert.equal(f.domainJob.turns.length, 2);
    assert.equal(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes.length, 2);
  } finally { f.cleanup(); }
});

test("回合已保存但批注提交标记尚未落盘，重启按精确意见编号恢复且不重复提交", () => {
  const f = fixture();
  try {
    const saved = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "核对边界" }, "alice");
    const first = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [saved.notes[0].id] }, "alice");
    f.domainJob.turns[0].status = "failed";
    const clone = { ...saved.notes[0], id: randomUUID(), retry_of: saved.notes[0].id, inspection_id: randomUUID(), status: "open" as const };
    const untouched = { ...saved.notes[0], id: randomUUID(), note: "另一条尚未提交的意见" };
    const path = join(f.dataDir, "knowledge-review/domain/dkx-1.json");
    writeFileSync(path, JSON.stringify([...first.notes, clone, untouched]));
    f.domainJob.turns.push({ ...f.domainJob.turns[0], id: "interrupted-submit", status: "running", review_note_ids: [clone.id], operator: "reviewer" });
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [clone.id] }, "alice"), /已经提交/);
    const restored = listKnowledgeReviewNotes({ ...f.sources }, "domain", "dkx-1");
    assert.deepEqual(restored.notes[0], first.notes[0]); assert.deepEqual(restored.notes[2], JSON.parse(JSON.stringify(untouched)));
    assert.equal(restored.notes[1].status, "submitted"); assert.equal(restored.notes[1].turn_id, "interrupted-submit");
    assert.equal(restored.notes[1].submitted_by, "reviewer"); assert.equal(restored.notes[1].retry_of, first.notes[0].id);
    assert.equal(restored.submissions[first.turn_id!].retryable, false);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [first.notes[0].id], retry: true }, "alice"), /不能重试/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), restored.notes); assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});
