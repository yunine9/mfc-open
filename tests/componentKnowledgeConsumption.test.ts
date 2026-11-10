import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { componentSection, consumptionFixture, enableComponentHints } from "./componentConsumptionFixture.ts";
import { componentKnowledgeCatalog, publishedComponentParadigms } from "../src/componentKnowledgeCatalog.ts";
import { checkComponentKnowledge } from "../src/componentKnowledgeCheck.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";

test("正式组件知识按仓库、语言和产品版本消费；无 replaces 可选型，修订/停用立即生效，草稿隔离", () => {
  const f = consumptionFixture();
  try {
    mkdirSync(join(f.data, "component-research")); writeFileSync(join(f.data, "component-research", "draft.json"), JSON.stringify(componentSection()));
    assert.equal(componentKnowledgeCatalog(f.data, f.context, ["cpp"]).paradigms.length, 0);
    const plain = componentSection("cpp", "pool-wait"); plain.paradigm!.replaces.identifiers = []; plain.paradigm!.need = "等待所有任务完成";
    const legacy = componentSection("cpp", "old"); legacy.paradigm!.status = "legacy";
    const unverified = componentSection("cpp", "unknown"); unverified.paradigm!.status = "unverified";
    const doc = f.publish([componentSection(), plain, legacy, unverified, componentSection("java", "java-pool")], { product_versions: ["v2"] });
    enableComponentHints(f);
    let catalog = componentKnowledgeCatalog(f.data, f.context, ["cpp"]);
    assert.equal(catalog.paradigms.length, 2); assert.equal(catalog.rules.length, 1);
    assert.ok(catalog.paradigms.some(p => p.need === "等待所有任务完成"));
    const p = catalog.paradigms[0], asset = new KnowledgeSearch(f.data).read(f.context, p.document_id)!;
    assert.match(asset.content.split("\n").slice(p.start_line - 1, p.end_line).join("\n"), /退出前等待/);
    assert.equal(p.document_revision, doc.revision);
    assert.equal(componentKnowledgeCatalog(f.data, { ...f.context, productVersion: "v1" }, ["cpp"]).paradigms.length, 0);
    const before = catalog.digest;
    saveKnowledgeDocument(f.data, { content: doc.content.replaceAll("Pool.submit", "Pool.enqueue") }, "expert", doc.id);
    catalog = componentKnowledgeCatalog(f.data, f.context, ["cpp"]); assert.notEqual(catalog.digest, before); assert.deepEqual(catalog.paradigms[0].api, ["Pool.enqueue"]);
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    assert.equal(componentKnowledgeCatalog(f.data, f.context, ["cpp"]).rules.length, 0);
    f.publish([componentSection()], { scope: "repository", repositories: ["https://example.test/other.git"] });
    assert.equal(componentKnowledgeCatalog(f.data, f.context, ["cpp"]).paradigms.length, 0);
    f.publish([componentSection()], { content: doc.content.replace("mfc.component-guide/v1", "mfc.component-guide/v99") });
    assert.match(componentKnowledgeCatalog(f.data, f.context, ["cpp"]).warnings.join(), /schema/);
  } finally { f.cleanup(); }
});

test("真实 AST 增量检查覆盖 C/C++/Java、新文件与工作区；MR 读指定提交，规则版本一致", async () => {
  const f = consumptionFixture();
  try {
    f.publish([componentSection(), componentSection("c", "alloc"), componentSection("java", "java-thread")]);
    const catalog = componentKnowledgeCatalog(f.data, f.context);
    writeFileSync(join(f.cwd, "existing.cpp"), "void old() { std::thread old_thread; }\nvoid unrelated() { int n = 1; }\nvoid added() { std::thread fresh; }\n");
    writeFileSync(join(f.cwd, "new.c"), "void* f() { return malloc(12); }\n");
    writeFileSync(join(f.cwd, "New.java"), "class New { Thread start() { return new Thread(); } }\n");
    writeFileSync(join(f.cwd, "comments.cpp"), 'const char* s = "std::thread"; // std::thread\n');
    const input = { cwd: f.cwd, baseline: "main", catalog, trigger: "edit" as const };
    const working = await checkComponentKnowledge(input);
    assert.equal(working.status, "completed", working.warnings.join("\n"));
    assert.deepEqual([...new Set(working.findings.map(r => r.path))].sort(), ["New.java", "existing.cpp", "new.c"]);
    assert.ok(working.findings.filter(r => r.path === "existing.cpp").every(r => r.line === 3), "旧代码不重复报错");
    f.git("add", "."); f.git("commit", "-qm", "consumer changes"); const head = f.git("rev-parse", "HEAD");
    writeFileSync(join(f.cwd, "new.c"), "void* f() { return 0; }\n");
    const mr = await checkComponentKnowledge({ ...input, target: head, trigger: "mr" });
    assert.equal(mr.status, "completed", mr.warnings.join("\n")); assert.equal(mr.rules_digest, working.rules_digest);
    assert.deepEqual(mr.findings, working.findings, "MR 使用实际提交，不受未提交文件覆盖");
    assert.equal(mr.base, f.base); assert.equal(mr.head, head);
    assert.equal((await checkComponentKnowledge({ ...input, baseline: "missing" })).status, "incomplete");
    const broken = structuredClone(catalog); broken.rules[0].rule = { kind: "nonexistent_node_kind" };
    assert.equal((await checkComponentKnowledge({ ...input, catalog: broken })).status, "incomplete");
    const previous = process.env.MFC_AST_GREP_BIN; process.env.MFC_AST_GREP_BIN = join(f.dir, "missing-ast-grep");
    try { assert.equal((await checkComponentKnowledge(input)).status, "incomplete"); }
    finally { if (previous === undefined) delete process.env.MFC_AST_GREP_BIN; else process.env.MFC_AST_GREP_BIN = previous; }
  } finally { f.cleanup(); }
});

test("分叉使用共同祖先，重命名不把旧命中当新增；组件自身实现排除，坏来源明确失败", async () => {
  const f = consumptionFixture();
  try {
    f.publish(); const catalog = componentKnowledgeCatalog(f.data, f.context);
    f.git("mv", "existing.cpp", "中文 重命名.cpp"); f.git("commit", "-qm", "rename");
    f.git("checkout", "-q", "main"); writeFileSync(join(f.cwd, "other.cpp"), "void other() { std::thread upstream; }\n"); f.git("add", "."); f.git("commit", "-qm", "upstream");
    f.git("checkout", "-q", "feature");
    const report = await checkComponentKnowledge({ cwd: f.cwd, baseline: "main", catalog, trigger: "mr", target: f.git("rev-parse", "HEAD") });
    assert.equal(report.base, f.base); assert.equal(report.findings.length, 0); assert.equal(report.status, "completed");
    f.publish([componentSection()], { research_source: { job_id: "fixture", repository: f.context.repositories[0], branch: "main", path: "" } });
    // 第一份外部组件文档保留规则，自身实现的第二份不增加规则。
    assert.equal(componentKnowledgeCatalog(f.data, f.context).rules.length, 1);
    const external = join(f.dir, "outside.cpp"); writeFileSync(external, "void x() { std::thread x; }"); symlinkSync(external, join(f.cwd, "escape.cpp"));
    const escaped = await checkComponentKnowledge({ cwd: f.cwd, baseline: "main", catalog, trigger: "edit" });
    assert.equal(escaped.status, "incomplete"); assert.match(escaped.warnings.join(), /越出代码仓/);
  } finally { f.cleanup(); }
});
