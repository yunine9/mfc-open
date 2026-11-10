import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { componentCards, componentCardText } from "../src/componentKnowledgeCards.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { MemorySidecar } from "../src/memorySidecar.ts";
import { componentSection, consumptionFixture } from "./componentConsumptionFixture.ts";

test("组件目录超过一页仍可发现所有候选，每页至多12条，普通浏览不要求写计划", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(Array.from({ length: 25 }, (_, i) => componentSection("cpp", `usage-${String(i).padStart(2, "0")}`)));
    const service = new KnowledgeSearch(f.data), tool: any = createKnowledgeTool({ service: () => service, context: () => f.context });
    const ids: string[] = [];
    let offset: number | null = 0;
    const sizes: number[] = [];
    do {
      const response = await tool.execute("browse", { action: "component_context", offset });
      const page = response.details;
      assert.equal(page.count, 25); assert.equal(page.offset, offset); assert.equal(page.page_size, 12);
      assert.ok(page.hits.every((hit: any) => hit.id === doc.id && hit.revision === doc.revision));
      assert.doesNotMatch(response.content[0].text, /component-plan:|把以下表格|```cpp/);
      if (page.next_offset !== null) assert.match(response.content[0].text, new RegExp(`offset=${page.next_offset}`));
      sizes.push(page.hits.length); ids.push(...page.hits.map((hit: any) => hit.card_id)); offset = page.next_offset;
    } while (offset !== null);
    assert.deepEqual(sizes, [12, 12, 1]); assert.equal(new Set(ids).size, 25);
    assert.deepEqual(service.componentContext(f.context).hits.map(hit => hit.card_id), ids.slice(0, 12));
  } finally { f.cleanup(); }
});

test("目录每页使用当前权限范围和修订，停用及不适用版本不返回；非法offset从第一页恢复", () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(Array.from({ length: 13 }, (_, i) => componentSection("cpp", `usage-${i}`)));
    f.publish([componentSection("cpp", "other-repo")], { scope: "repository", repositories: ["https://example.test/other.git"] });
    f.publish([componentSection("cpp", "other-version")], { product_versions: ["v1"] });
    f.publish([componentSection("cpp", "inactive")], { active: false });
    saveKnowledgeDocument(f.data, { title: "普通组件介绍", content: "这份普通文档没有正式组件用法。" }, "expert");
    const service = new KnowledgeSearch(f.data);
    for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12" as unknown as number]) {
      const page = service.componentContext(f.context, offset);
      assert.equal(page.offset, 0); assert.equal(page.hits.length, 12); assert.match(page.warnings.join(), /offset 无效/);
    }
    const pastEnd = service.componentContext(f.context, 1000);
    assert.equal(pastEnd.offset, 13); assert.deepEqual(pastEnd.hits, []); assert.equal(pastEnd.next_offset, null);
    const updated = saveKnowledgeDocument(f.data, { content: doc.content.replace("使用 pool v2", "使用 pool v2 并核对配置") }, "expert", doc.id);
    assert.notEqual(updated.revision, doc.revision);
    const last = service.componentContext(f.context, 12);
    assert.equal(last.count, 13); assert.equal(last.hits.length, 1); assert.equal(last.hits[0].revision, updated.revision);
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    assert.equal(service.componentContext(f.context, 12).count, 0);
    assert.deepEqual(service.componentContext(f.context).hits, []);
  } finally { f.cleanup(); }
});

test("长适用条件与接口列表只返回有界摘要，目录按字符预算分页且不会漏项或原地循环", async () => {
  const f = consumptionFixture();
  try {
    const sections = Array.from({ length: 13 }, (_, i) => {
      const section = componentSection("cpp", `long-${String(i).padStart(2, "0")}`);
      section.title = "后台任务说明".repeat(100);
      section.paradigm!.need = "执行后台任务".repeat(100);
      section.paradigm!.applicability = "调用前核对生命周期与任务调度边界。".repeat(190);
      section.paradigm!.api = Array.from({ length: 20 }, (_, n) => `Pool.submit_${n}(${'parameter_'.repeat(120)})`);
      return section;
    });
    const doc = f.publish(sections, { product_versions: ["v2", ...Array.from({ length: 19 }, (_, i) => `v${i}-${"x".repeat(500)}`)] });
    const service = new KnowledgeSearch(f.data), ids: string[] = [];
    let offset: number | null = 0, pages = 0;
    do {
      const page = service.componentContext(f.context, offset);
      assert.ok(JSON.stringify(page.hits).length <= 12_000, "序列化后的目录条目不超出字符预算");
      assert.ok(page.hits.length > 0 && page.hits.length <= 12);
      assert.equal(page.mode, "paged");
      for (const hit of page.hits) {
        assert.ok(hit.title.length <= 160 && hit.heading!.length <= 160);
        assert.ok(hit.whenToUse.length <= 240 && hit.summary!.length <= 480);
        assert.match(hit.whenToUse, /已省略.*原文/);
        assert.match(hit.summary!, /仅摘要.*完整接口、条件和约束请读原文/);
        assert.match(hit.versionNote, /版本列表已省略/);
        assert.ok(hit.productVersions.every(version => doc.product_versions.includes(version)), "不得把截短值当成版本");
        assert.equal(hit.id, doc.id); assert.equal(hit.revision, doc.revision);
      }
      ids.push(...page.hits.map(hit => hit.card_id!)); pages++;
      assert.ok(pages <= sections.length, "每页至少推进一条");
      if (page.next_offset !== null) assert.equal(page.next_offset, offset + page.hits.length);
      offset = page.next_offset;
    } while (offset !== null);
    assert.ok(pages > 2, "长条目在达到12条前按字符预算分页");
    assert.equal(ids.length, sections.length); assert.equal(new Set(ids).size, sections.length);
    const finalPage = service.componentContext(f.context, sections.length - 1);
    assert.equal(finalPage.hits.length, 1); assert.equal(finalPage.next_offset, null);
    const found = await service.search(f.context, "后台任务", 5, true);
    assert.equal(found.hits.length, 5);
    assert.ok(found.hits.every(hit => hit.whenToUse.length <= 240 && hit.summary!.length <= 480));
    assert.match(service.read(f.context, doc.id)!.content, /parameter_parameter_parameter_/);
    assert.ok(service.read(f.context, doc.id)!.content.includes(sections[0].paradigm!.applicability), "正式原文仍保留全部条件");
  } finally { f.cleanup(); }
});

function detailedSection() {
  const section = componentSection();
  section.content = "### 适用场景\n处理分片导出。\n\n### 使用步骤\n提交任务后等待完成。\n\n### 使用约束\n取消回调结束后才释放挂起句柄。\n\n### 常见误用\n重复关闭会丢失尚未交付的结果。";
  section.interfaces = "Pool.submit；Pool.await_completion 返回最终状态。";
  section.integration = "设置 channel_backpressure=bounded。\n\n```text\n## 用法导航\nfenced_configuration_key=enabled\n```";
  section.example = "```cpp\nPool pool;\npool.submit(work);\n// BODY_SENTINEL_DO_NOT_RETURN\npool.wait();\n```";
  return section;
}

test("离线搜索能按正式正文的场景、接口、约束、误用和接入配置发现组件，返回保持短卡片", async () => {
  const f = consumptionFixture();
  try {
    const other = componentSection("cpp", "other-usage"); other.title = "SiblingOnlyMarker";
    other.content = other.content.replace("业务需要后台执行有限任务。", "SiblingBodyOnlyMarker");
    const doc = f.publish([detailedSection(), other]), service = new KnowledgeSearch(f.data);
    const cards = componentCards(service.catalog(f.context).assets).cards;
    const target = cards.find(card => card.paradigm.id === "pool-submit")!;
    assert.doesNotMatch(target.asset.content, /\[SiblingOnlyMarker\]|SiblingBodyOnlyMarker/);
    assert.match(target.asset.content, /fenced_configuration_key/);
    for (const query of ["分片导出", "await_completion", "取消回调", "挂起句柄", "重复关闭", "channel_backpressure", "fenced_configuration_key"]) {
      const result = await service.search(f.context, query, 5, true);
      assert.ok(result.hits.some(hit => hit.paradigm_id === "pool-submit"), `未召回正文线索：${query}`);
      assert.ok(result.hits.every(hit => hit.retrieval === "local"));
      assert.doesNotMatch(JSON.stringify(result.hits), /BODY_SENTINEL_DO_NOT_RETURN|```cpp/);
    }
    const unrelated = await service.search(f.context, "SiblingBodyOnlyMarker", 5, true);
    assert.deepEqual(unrelated.hits.map(hit => hit.paradigm_id), ["other-usage"]);
    const hit = (await service.search(f.context, "挂起句柄", 5, true)).hits[0];
    const source = service.read(f.context, hit.id)!.content.split(/\r?\n/).slice(hit.start_line! - 1, hit.end_line).join("\n");
    assert.equal(hit.id, doc.id); assert.equal(hit.revision, doc.revision);
    assert.match(source, /Pool.await_completion/); assert.match(source, /重复关闭/);
    saveKnowledgeDocument(f.data, { product_versions: ["v1"] }, "expert", doc.id);
    assert.deepEqual((await service.search(f.context, "挂起句柄", 5, true)).hits, []);
  } finally { f.cleanup(); }
});

test("memsearch收到当前正式正文，旧短卡片镜像重新索引；索引片段不能代替源文档返回", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish([detailedSection()]);
    const indexed: Array<{ path: string; content: string }> = [];
    const sidecar = {
      ingest: async (path: string) => { indexed.push({ path, content: readFileSync(path, "utf8") }); return true; },
      remove: async () => true,
      search: async ({ sources, query }: { sources: Array<{ id: string; path: string }>; query: string }) => sources
        .filter(source => readFileSync(source.path, "utf8").includes(query))
        .map(source => ({ id: source.id, score: 1, start_line: 900, end_line: 999, snippet: "不可信的旧索引正文" })),
    } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(f.data, sidecar);
    await service.prepare();
    assert.equal(indexed.length, 1); assert.match(indexed[0].content, /channel_backpressure|取消回调/);
    const card = componentCards(service.catalog(f.context).assets).cards[0];
    writeFileSync(indexed[0].path, componentCardText(card.paradigm, doc.id, doc.revision));
    // 升级后原文修订未变，旧进程留下的短卡片镜像仍须按当前正文重建并导入。
    const upgraded = new KnowledgeSearch(f.data, sidecar);
    const result = await upgraded.search(f.context, "挂起句柄", 5, true);
    assert.equal(indexed.length, 2); assert.match(indexed[1].content, /挂起句柄/);
    assert.equal(result.hits.length, 1); assert.equal(result.hits[0].retrieval, "memsearch");
    assert.equal(result.hits[0].start_line, card.paradigm.start_line);
    assert.equal(result.hits[0].end_line, card.paradigm.end_line);
    assert.doesNotMatch(JSON.stringify(result.hits), /不可信的旧索引正文|BODY_SENTINEL/);
    saveKnowledgeDocument(f.data, { content: doc.content.replace("挂起句柄", "续传句柄") }, "expert", doc.id);
    const revised = await upgraded.search(f.context, "续传句柄", 5, true);
    assert.equal(indexed.length, 3); assert.notEqual(revised.hits[0].revision, doc.revision);
    assert.match(indexed[2].content, /续传句柄/);
  } finally { f.cleanup(); }
});

test("组件索引查询期间被撤回或更新时丢弃旧结果", async () => {
  for (const change of ["withdraw", "update"] as const) {
    const f = consumptionFixture();
    try {
      const doc = f.publish([detailedSection()]);
      const sidecar = { ingest: async () => true, search: async ({ sources }: any) => {
        saveKnowledgeDocument(f.data, change === "withdraw" ? { active: false } : { content: doc.content.replace("挂起句柄", "续传句柄") }, "expert", doc.id);
        return [{ id: sources[0].id, score: 1 }];
      } } as unknown as MemorySidecar;
      const service = new KnowledgeSearch(f.data, sidecar);
      assert.deepEqual((await service.search(f.context, "挂起句柄", 5, true)).hits, []);
    } finally { f.cleanup(); }
  }
});
