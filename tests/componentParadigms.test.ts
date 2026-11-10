import { test } from "node:test";
import assert from "node:assert/strict";
import { readComponentArtifact, exportComponentArtifacts, deriveComponentArtifacts, validateComponentParadigm } from "../src/componentParadigms.ts";
import type { ResearchSection } from "../src/componentResearchDocument.ts";
export const paradigmSection = (id = "paradigm-pool-submit"): ResearchSection => ({
  id, title: "后台执行任务", repository_ids: ["base"], revision: 1, selected: true, related_ids: [],
  content: "### 适用场景\n业务需要后台执行任务。\n\n### 使用步骤\n任务归池管理；退出前等待所有任务完成。\n\n### 使用约束\n等待完成前保持任务数据存活。", interfaces: "Pool::Submit", integration: "链接 pool target。",
  example: "```cpp\nPool p; p.Submit(work); p.Wait();\n```", unit_tests: "GoogleTest 用例，链接 pool 与 gtest_main 后运行 ctest。\n```cpp\nTEST(Pool, Completes) { Pool p; bool done = false; p.Submit([&] { done = true; }); p.Wait(); EXPECT_TRUE(done); }\n```", sources: "", paradigm: {
    kind: "paradigm", component: "pool", language: "cpp", status: "recommended", need: "后台执行任务", api: ["Pool::Submit"],
    applicability: "依赖 pool v2；组件自身实现除外", replaces: { identifiers: ["std::thread"], imports: [], patterns: [] },
    evidence: [{ repository_id: "base", path: "src/pool.cpp", revision: "a".repeat(40), start: 1, end: 2 }],
    usage_evidence: ["everycode-" + "b".repeat(24)], test_evidence: ["everycode-" + "c".repeat(24)], open_questions: [],
  },
});
test("B1验收1、B1验收3：只使用干净 Markdown 与独立元数据，派生覆盖无替代关系的能力并排除 legacy", () => {
  const section = paradigmSection(); const plain = paradigmSection("paradigm-pool-wait"); plain.paradigm!.replaces.identifiers = []; plain.paradigm!.need = "等待任务完成";
  const legacy = paradigmSection("paradigm-pool-old"); legacy.paradigm!.status = "legacy";
  const exported = exportComponentArtifacts([section, plain, legacy]);
  assert.equal(exported.catalog.length, 2); assert.equal(exported.rules.length, 1); assert.equal(exported.enabled, false);
  for (const entry of exported.catalog) assert.ok(exported.files[entry.path], "程序索引必须能定位实际范式文件");
  assert.match(exported.mapping, /等待任务完成/); assert.doesNotMatch(exported.mapping, /paradigm-pool-old/);
  const sources = Object.fromEntries(Object.entries(exported.files).filter(([path]) => path.startsWith("components/")));
  const derived = deriveComponentArtifacts(sources); assert.deepEqual(derived.rules, exported.rules); assert.equal(derived.digest, exported.digest);
  assert.deepEqual(deriveComponentArtifacts(Object.fromEntries(Object.entries(sources).reverse())), derived, "输入文件枚举顺序不能改变派生结果");
  const path = Object.keys(sources).find(p => p.endsWith(".metadata.json"))!;
  const metadata = JSON.parse(sources[path]); metadata.need = "按队列执行任务";
  const changed = { ...sources, [path]: JSON.stringify(metadata) };
  assert.match(deriveComponentArtifacts(changed).mapping, /按队列执行任务/); assert.notEqual(deriveComponentArtifacts(changed).digest, exported.digest);
  const markdown = sources[path.replace(/\.metadata\.json$/, ".md")];
  assert.doesNotMatch(markdown, /everycode-|repository_id|a{40}|^---|## 来源/);
  assert.match(markdown, /Pool::Submit/); assert.match(markdown, /p.Wait/);
  assert.match(markdown, /### 单元测试示例/); assert.match(markdown, /EXPECT_TRUE/);
  assert.deepEqual(JSON.parse(sources[path]).evidence, section.paradigm!.evidence);
  assert.deepEqual(readComponentArtifact(markdown, sources[path]).paradigm, section.paradigm);
  const missing = { ...sources }; delete missing[path]; assert.throws(() => deriveComponentArtifacts(missing), /元数据/);
  const orphan = { ...sources }; delete orphan[path.replace(/\.metadata\.json$/, ".md")]; assert.throws(() => deriveComponentArtifacts(orphan), /缺少对应文档/);
  assert.throws(() => deriveComponentArtifacts({ ...sources, [path]: JSON.stringify({ ...metadata, schema: "unknown" }) }), /格式/);

});
test("程序读取严格拒绝坏字段、类型、版本、路径、重复编号，不静默漏掉文档", () => {
  const exported = exportComponentArtifacts([paradigmSection()]);
  const path = exported.catalog[0].path, source = exported.files[path];
  const metadata = JSON.parse(exported.files[path.replace(/\.md$/, ".metadata.json")]);
  for (const fields of [{ ...metadata, schema: "unknown" }, { ...metadata, need: undefined }, { ...metadata, need: null },
    { ...metadata, api: "Pool::Submit" }, { ...metadata, status: "published" }, { ...metadata, extra: true }]) {
    assert.throws(() => readComponentArtifact(source, JSON.stringify(fields)));
  }
  assert.throws(() => readComponentArtifact(source, undefined), /元数据/);
  assert.throws(() => readComponentArtifact(`---\n${source}`, JSON.stringify(metadata)), /格式/);
  assert.throws(() => deriveComponentArtifacts({ "components/pool/wrong.md": source,
    "components/pool/wrong.metadata.json": JSON.stringify(metadata) }), /路径/);
  const p = paradigmSection().paradigm!; assert.throws(() => validateComponentParadigm({ ...p, extra: true } as any, ["base"]), /未知/);
  assert.throws(() => validateComponentParadigm({ ...p, replaces: { ...p.replaces, hidden: true } } as any, ["base"]));
  for (const path of ["AGENTS.md", "docs/old.cpp", "../pool.cpp"]) assert.throws(() => validateComponentParadigm({ ...p, evidence: [{ ...p.evidence[0], path }] }, ["base"]));
  assert.throws(() => validateComponentParadigm({ ...p, evidence: [null] } as any, ["base"]));
  assert.throws(() => validateComponentParadigm({ ...p, usage_evidence: [] }, ["base"]), /调用证据/);
  assert.throws(() => validateComponentParadigm({ ...p, test_evidence: [] }, ["base"]), /测试证据/);
  assert.throws(() => readComponentArtifact(source.replace("### 单元测试示例", "### 检查过程"), JSON.stringify(metadata)), /检查过程/);
});
