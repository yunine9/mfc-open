import assert from "node:assert/strict";
import { test } from "node:test";
import { componentUsageDocument } from "../src/componentKnowledgeCards.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import type { ComponentResearch } from "../src/componentResearch.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { componentSection, consumptionFixture } from "./componentConsumptionFixture.ts";

test("按需求发现能力后，可一次读取公共接入配置和所选完整用法，不混入其他用法", async () => {
  const f = consumptionFixture();
  try {
    const target = componentSection(), sibling = componentSection("cpp", "sibling");
    target.content += "\n\n### 常见误用\nTAIL_CONSTRAINT：对象销毁后不得提交回调。";
    target.paradigm!.applicability = "正式适用条件：仅对可等待完成的后台任务适用。";
    target.paradigm!.open_questions = ["跨模块退出顺序仍需对照实际调用方核实。"];
    sibling.content = sibling.content.replace("业务需要后台执行有限任务。", "SIBLING_BODY_MUST_NOT_APPEAR");
    sibling.paradigm!.evidence = [{ ...sibling.paradigm!.evidence[0], path: "src/sibling-only.cpp", revision: "d".repeat(40) }];
    const doc = f.publish([target, sibling]), service = new KnowledgeSearch(f.data), events: any[] = [];
    // 需求侧形态(ADR-0062):research 在场,组件研究指引完整;问题侧
    // 只读装配的指引裁剪由 issueKnowledgeRetrieval.test.ts 单独把关。
    const tool: any = createKnowledgeTool({ service: () => service, context: () => f.context, onUse: event => events.push(event), research: () => ({}) as unknown as ComponentResearch });
    const found = await tool.execute("find", { action: "search", scope: "components", query: "后台任务执行完成等待" });
    const hit = found.details.hits.find((hit: any) => hit.paradigm_id === target.id);
    assert.ok(hit); assert.match(hit.summary, /要做的事/);
    assert.ok(found.content[0].text.includes(`"paradigm_id":"${target.id}"`));
    const read = await tool.execute("read", { action: "read", id: hit.id, revision: hit.revision, paradigm_id: hit.paradigm_id });
    assert.equal(read.details.complete, true); assert.equal(read.details.next_offset, null);
    assert.equal(read.details.revision, doc.revision);
    assert.match(read.content[0].text, /使用 pool v2 并保持统一生命周期/);
    assert.match(read.content[0].text, /链接已发布的 pool target/);
    assert.ok(read.content[0].text.includes(target.paradigm!.applicability));
    assert.ok(read.content[0].text.includes(`源码修订：${target.paradigm!.evidence[0].revision}`));
    assert.match(read.content[0].text, /仓库：base；路径：src\/pool.cpp/);
    assert.ok(read.content[0].text.includes(target.paradigm!.usage_evidence[0]));
    assert.ok(read.content[0].text.includes(target.paradigm!.test_evidence[0]));
    assert.ok(read.content[0].text.includes(target.paradigm!.open_questions[0]));
    assert.match(read.content[0].text, /### 关键接口[\s\S]*### 完整示例[\s\S]*### 单元测试示例[\s\S]*### 使用约束[\s\S]*TAIL_CONSTRAINT/);
    assert.doesNotMatch(read.content[0].text, /SIBLING_BODY_MUST_NOT_APPEAR|sibling-only.cpp|component_paradigms:|## 用法导航/);
    const expanded = events.at(-1);
    assert.equal(expanded.moment, "expand"); assert.equal(expanded.status, "ready");
    assert.equal(expanded.assets.filter((asset: any) => asset.start_line).length, 2);
    for (const range of read.details.source_ranges) {
      const original = doc.content.split(/\r?\n/).slice(range.start_line - 1, range.end_line).join("\n");
      assert.ok(read.content[0].text.includes(original), "来源范围与实际展示的正式正文对应");
    }
    assert.doesNotMatch(tool.promptGuidelines.join("\n"), /自动提供的符号|读代码.*自动/);
    assert.match(tool.promptGuidelines.join("\n"), /当前任务明确要求开展组件研究时/);
    assert.doesNotMatch(tool.promptGuidelines.join("\n"), /检索不到.*发起后台研究/);
  } finally { f.cleanup(); }
});

test("长公共配置和超长单行按字符续读，跨页不切断Unicode字符且尾部约束不丢失", async () => {
  const f = consumptionFixture();
  try {
    const target = componentSection();
    target.title = "😀".repeat(150);
    target.integration = "LONG_CONFIG_START";
    target.example = '```cpp\nconst char* payload = "' + "z".repeat(45_000) + '";\n```';
    target.content += "\n\n### 常见误用\nFINAL_CONSTRAINT：所有回调结束后才允许释放资源。";
    const doc = f.publish([target]), service = new KnowledgeSearch(f.data);
    const original = service.read(f.context, doc.id)!;
    const prefix = componentUsageDocument(original, target.id)!.text.indexOf("LONG_CONFIG_START");
    // 让第20,000个UTF-16码元恰好落在表情字符中间，检验分页边界。
    const config = "LONG_CONFIG_START" + "x".repeat(19_999 - prefix - "LONG_CONFIG_START".length) + "😀" + "y".repeat(45_000);
    const updated = saveKnowledgeDocument(f.data, { content: doc.content.replace("LONG_CONFIG_START", config) }, "expert", doc.id);
    const expected = componentUsageDocument(service.read(f.context, doc.id)!, target.id)!.text;
    const events: any[] = [];
    const tool: any = createKnowledgeTool({ service: () => service, context: () => f.context, onUse: event => events.push(event) });
    let offset: number | null = 0, pages = 0;
    const chunks: string[] = [];
    do {
      const read = await tool.execute("read", { action: "read", id: doc.id, revision: updated.revision, paradigm_id: target.id, offset });
      const text = read.content[0].text as string;
      assert.ok(text.length <= 24_000, "超长单行也不能突破单次回复容量");
      assert.equal(read.details.offset, offset); assert.equal(read.details.total_chars, expected.length);
      assert.equal(read.details.complete, read.details.next_offset === null);
      if (!read.details.complete) {
        assert.match(text, /complete=false.*未读内容/);
        assert.ok(read.details.next_offset > offset!);
        assert.ok(text.includes(`"offset":${read.details.next_offset}`));
      } else assert.match(text, /complete=true.*连同从 offset=0/);
      const chunk = text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\ncomplete="));
      assert.ok(chunk.length <= 20_000);
      assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      chunks.push(chunk); offset = read.details.next_offset; pages++;
      assert.ok(pages < 20, "字符分页必须向前推进");
    } while (offset !== null);
    assert.ok(pages > 4); assert.equal(chunks.join(""), expected);
    assert.match(chunks.at(-1)!, /FINAL_CONSTRAINT/);
    assert.ok(!events[0].assets.some((asset: any) => asset.start_line), "只展示区块前半部分时不登记成完整原文区块");
    assert.doesNotMatch(chunks[0], /FINAL_CONSTRAINT/);
  } finally { f.cleanup(); }
});

test("组件连续阅读要求修订与合法偏移，修订变化、停用和范围撤销立即拒绝旧阅读", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), service = new KnowledgeSearch(f.data);
    let context = f.context;
    const tool: any = createKnowledgeTool({ service: () => service, context: () => context });
    const input = { action: "read", id: doc.id, revision: doc.revision, paradigm_id: "pool-submit" };
    assert.match((await tool.execute("missing", { ...input, revision: undefined })).content[0].text, /需要提供.*revision/);
    assert.match((await tool.execute("unknown", { ...input, paradigm_id: "missing" })).content[0].text, /没有此用法编号/);
    assert.match((await tool.execute("mixed", { ...input, start_line: 1 })).content[0].text, /勿同时传/);
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.match((await tool.execute("invalid", { ...input, offset })).content[0].text, /offset 无效/);
    }
    const updated = saveKnowledgeDocument(f.data, { content: doc.content.replace("使用 pool v2", "使用 pool v2.1") }, "expert", doc.id);
    assert.match((await tool.execute("stale", { ...input, offset: 10 })).content[0].text, /文档已更新/);
    const scoped = saveKnowledgeDocument(f.data, { scope: "repository", repositories: ["https://example.test/consumer.git"] }, "expert", doc.id);
    context = { ...context, repositories: ["https://example.test/other.git"] };
    assert.match((await tool.execute("denied", { ...input, revision: scoped.revision })).content[0].text, /取不到/);
    context = f.context;
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    assert.match((await tool.execute("withdrawn", { ...input, revision: updated.revision })).content[0].text, /取不到/);
  } finally { f.cleanup(); }
});

test("接入配置保留公共与共享分组，排除其他用法专属配置，围栏中的分组文字保持原样", () => {
  const f = consumptionFixture();
  try {
    const target = componentSection(), shared = componentSection("cpp", "shared"), other = componentSection("cpp", "other");
    target.title = "目标*用法、配置"; shared.title = "共享用法"; other.title = "其他用法";
    target.integration = shared.integration = "SHARED_CONFIGURATION\n```text\n**其他用法**\nCODE_FENCE_CONFIG\n```";
    other.integration = "UNRELATED_CONFIGURATION";
    const doc = f.publish([target, shared, other]), search = new KnowledgeSearch(f.data);
    const usage = componentUsageDocument(search.read(f.context, doc.id)!, target.id)!;
    assert.match(usage.text, /使用 pool v2/);
    assert.match(usage.text, /SHARED_CONFIGURATION/);
    assert.match(usage.text, /CODE_FENCE_CONFIG/);
    assert.doesNotMatch(usage.text, /UNRELATED_CONFIGURATION/);
  } finally { f.cleanup(); }
});
