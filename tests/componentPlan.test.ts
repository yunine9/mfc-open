import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumptionFixture, componentSection } from "./componentConsumptionFixture.ts";
import { ComponentPlan, COMPONENT_PLAN_TEMPLATE } from "../src/componentPlan.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { componentCards, componentCardId } from "../src/componentKnowledgeCards.ts";
import { exportComponentArtifacts } from "../src/componentParadigms.ts";
import { componentIndexSources } from "../src/componentCardIndex.ts";
import { deleteComponentDocuments } from "../src/componentKnowledgeDeletion.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { ComponentKnowledgeConsumption } from "../src/componentKnowledgeConsumption.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { COMPONENT_ANALYST_MISSION } from "../src/componentKnowledgePlanning.ts";

function setup(f: ReturnType<typeof consumptionFixture>, search = new KnowledgeSearch(f.data)) {
  const events: any[] = [], path = join(f.cwd, "implementation.md"); writeFileSync(path, "# 实施计划\n\n保留原有任务\n\n" + COMPONENT_PLAN_TEMPLATE);
  const plan = new ComponentPlan({ workspace: f.cwd, cwd: () => f.cwd, baseline: () => "main", search: () => search, context: () => f.context, usage: () => events });
  const tool = createKnowledgeTool({ service: () => search, context: () => f.context, plan: () => plan, onUse: e => events.push(e) });
  const run = (input: any) => tool.execute("fixture", input, undefined, undefined, {} as any) as Promise<any>;
  const row = (line: string) => writeFileSync(path, readFileSync(path, "utf8").replace("<!-- component-plan:end -->", line + "\n<!-- component-plan:end -->"));
  return { events, path, plan, tool, run, row, search };
}

test("编码前分析技能交回职责和依据，派生卡片仅含推荐范式且包含稳定来源", () => {
  const recommended = componentSection(), legacy = componentSection("cpp", "old-pool"); legacy.paradigm!.status = "legacy";
  const out = exportComponentArtifacts([recommended, legacy]);
  const files = Object.keys(out.files).filter(path => path.startsWith("derived/cards/"));
  assert.equal(files.length, 1); assert.match(out.files[files[0]], /card-id: cpp\/pool\/pool-submit/);
  assert.match(out.files[files[0]], /要做的事：执行后台任务/); assert.match(out.files[files[0]], /替代的原始写法：std::thread/);
  assert.match(COMPONENT_ANALYST_MISSION, /编码前组件分析/);
  assert.match(COMPONENT_ANALYST_MISSION, /不直接修改计划或业务代码/);
  assert.match(COMPONENT_ANALYST_MISSION, /主 Agent 负责整合并传递所选资料给编码 Agent/);
});

test("同一 knowledge 工具完成 context/search/read/validate，真实检索记录写回原计划且幂等", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), s = setup(f);
    const context = await s.run({ action: "component_context", plan_path: s.path });
    assert.equal(context.details.mode, "full"); assert.equal(context.details.count, 1);
    const result = await s.run({ action: "search", scope: "components", plan_path: s.path, capability: "C1", query: "C++ 执行后台任务" });
    const hit = result.details.hits[0]; assert.equal(hit.retrieval, "local"); assert.equal(hit.card_id, "cpp/pool/pool-submit");
    await s.run({ action: "read", plan_path: s.path, capability: "C1", id: hit.id, revision: hit.revision, start_line: hit.start_line, end_line: hit.end_line });
    s.row(`| C1 | 后台处理 | 使用 | ${hit.card_id} | ${doc.id}@${doc.revision} | 退出前等待任务完成；先 join 再释放对象 | 已链接 pool v2 |`);
    const validated = await s.run({ action: "plan", operation: "validate", plan_path: s.path });
    assert.equal(validated.details.valid, true, JSON.stringify(validated)); assert.deepEqual(validated.details.warnings, []);
    const content = readFileSync(s.path, "utf8"); assert.match(content, /保留原有任务/); assert.match(content, /检索记录（系统生成）/); assert.match(content, /C\+\+ 执行后台任务/);
    await s.run({ action: "plan", operation: "validate", plan_path: s.path }); assert.equal(readFileSync(s.path, "utf8"), content);
    assert.deepEqual(s.plan.recordedPaths(), ["implementation.md"]);
    assert.deepEqual(s.events.filter(e => ["search", "expand", "component_plan"].includes(e.moment)).map(e => e.plan.path), Array(4).fill("implementation.md"));
  } finally { f.cleanup(); }
});

test("拒绝旧版本和非推荐范式；不使用有依据，缺少检索记录仅提示，缺口可回看", async () => {
  const f = consumptionFixture();
  try {
    const old = componentSection("cpp", "legacy"); old.paradigm!.status = "legacy";
    const doc = f.publish([componentSection(), old]), s = setup(f);
    s.row(`| C1 | 后台任务 | 使用 | cpp/pool/legacy | ${doc.id}@${doc.revision} | 已核对退出行为 | 有依赖 |`);
    s.row("| C2 | 毫秒调度 | 不使用 | - | - | 自行管理计时精度与退出 | 当前组件仅支持秒级精度 | ");
    s.row("| C3 | 网络重试 | 待核实 | - | - | - | 缺少正式契约 | ");
    const result = await s.run({ action: "plan", operation: "validate", plan_path: s.path });
    assert.equal(result.details.valid, false); assert.equal(result.details.blocks_delivery, false);
    assert.match(result.details.errors.join(), /不是推荐状态/); assert.match(result.details.warnings.join(), /检索证据较少/);
    assert.equal((await s.run({ action: "plan", operation: "gaps" })).content[0].text.includes("毫秒调度"), true);
    writeFileSync(s.path, readFileSync(s.path, "utf8").replace("cpp/pool/legacy", "cpp/pool/pool-submit"));
    saveKnowledgeDocument(f.data, { content: doc.content.replace("pool v2", "pool v3") }, "expert", doc.id);
    assert.match(s.plan.validate(s.path).errors.join(), /版本已变/);
    assert.throws(() => s.plan.path("../outside.md"));
  } finally { f.cleanup(); }
});

test("组件目录过多时仍可翻页浏览，查询按语言限制", async () => {
  const f = consumptionFixture();
  try {
    f.publish(Array.from({length:13},(_,i)=>componentSection(i === 0 ? "java" : "cpp", `pool-${i}`)));
    const s = setup(f), context = s.search.componentContext(f.context);
    assert.equal(context.mode, "paged"); assert.equal(context.hits.length, 12); assert.equal(context.next_offset, 12);
    assert.equal(s.search.componentContext(f.context, context.next_offset!).hits.length, 1);
    const result = await s.search.search(f.context, "Java 后台任务", 5, true);
    assert.equal(result.hits.length, 1); assert.equal(result.hits[0].card_id, "java/pool/pool-0");
  } finally { f.cleanup(); }
});

test("实现对照发现遗漏、计划外接口；提交检查复用原计划，知识问题不阻断", async () => {
  const f = consumptionFixture();
  try {
    const extra = componentSection("cpp", "timer"); extra.paradigm!.component = "timer"; extra.paradigm!.api = ["Timer.schedule"];
    const doc = f.publish([componentSection(), extra]), s = setup(f);
    s.row(`| C1 | 后台任务 | 使用 | cpp/pool/pool-submit | ${doc.id}@${doc.revision} | 等待任务完成后释放 | 已链接 pool v2 |`);
    await s.run({ action: "plan", operation: "validate", plan_path: s.path });
    writeFileSync(join(f.cwd, "new.cpp"), 'void work() { timer.schedule(job); } // submit 不代表真的调用\n');
    const result = await s.run({ action: "plan", operation: "check_impl", plan_path: s.path });
    assert.match(result.details.findings.join(), /未观察到计划接口/); assert.match(result.details.findings.join(), /计划外接口 schedule/);
    writeFileSync(join(f.cwd, "new.cpp"), 'void work() { pool.submit(job); }\n');
    const aligned = await s.plan.check(s.path); assert.deepEqual(aligned.findings, []);
    f.git("add", "."); f.git("commit", "-qm", "implementation");
    const consumer = new ComponentKnowledgeConsumption({ dataDir: f.data, cwd: f.cwd, context: () => f.context, languages: () => ["cpp"], baseline: () => "main", plan: () => s.plan });
    const report = await consumer.check({ trigger: "mr", target: f.git("rev-parse", "HEAD") });
    assert.equal(report.plans?.length, 1); assert.deepEqual(report.plans?.[0].findings, []);
    await deleteComponentDocuments(f.data, [doc], "expert", s.search);
    assert.match((await consumer.check({trigger:"mr",target:f.git("rev-parse","HEAD")})).plans![0].findings.join(), /不存在/);
  } finally { f.cleanup(); }
});

test("真实 memsearch 索引正式用法，换说法返回短卡片；删除后派生索引一起清理", { timeout: 60000 }, async t => {
  const python = process.env.MFC_MEMSEARCH_PYTHON; if (!python) return t.skip("需要真实 memsearch 环境");
  const f = consumptionFixture(), sidecar = new MemorySidecar({ python, script: join(process.cwd(), "harness/memsearch-sidecar.py"), corpusDir: join(f.data, "corpus"), milvusPath: join(f.data, "index.db"), env: {HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1"}, budgets: {ingestMs:20000} });
  try {
    const doc = f.publish(), search = new KnowledgeSearch(f.data, sidecar); await search.prepare();
    const result = await search.search(f.context, "C++ 把工作放到线程池异步执行，关闭时等待结束", 5, true);
    assert.equal(result.hits[0]?.id, doc.id); assert.equal(result.hits[0].retrieval, "memsearch");
    assert.equal(result.hits[0].card_id, "cpp/pool/pool-submit"); assert.match(search.read(f.context, doc.id)!.content, /完整示例|最佳示例/);
    const sources = componentIndexSources(f.data, doc.id)!; assert.deepEqual(sources, [`component-card:${doc.id}:pool-submit`]);
    const { createHash } = await import("node:crypto");
    const path = join(f.data, "corpus/_knowledge", `${createHash("sha256").update(sources[0]).digest("hex")}.md`);
    assert.ok((sidecar.indexedSections(path) ?? 0) >= 1); assert.match(readFileSync(path,"utf8"), /```cpp/);
    assert.match(readFileSync(path,"utf8"), /接入配置/); assert.doesNotMatch(JSON.stringify(result.hits), /```cpp/);
    assert.equal((await deleteComponentDocuments(f.data, [doc], "expert", search)).pending.length, 0);
    assert.equal(existsSync(path), false); assert.equal(componentIndexSources(f.data, doc.id), undefined);
    assert.equal(await sidecar.reindex(), 0); assert.deepEqual((await search.search(f.context,"线程池")).hits, []);
  } finally { sidecar.stop(); f.cleanup(); }
});

test("真实萃取的完整 API 签名按函数名对照，不把参数类型当接口", async () => {
  const f = consumptionFixture();
  try {
    const section = componentSection();
    section.paradigm!.api = ["void acme::Pool::submit(std::function<void()>)", "void acme::Pool::wait()"];
    const doc = f.publish([section]), s = setup(f);
    s.row(`| C1 | 后台任务 | 使用 | cpp/pool/pool-submit | ${doc.id}@${doc.revision} | 等待完成后释放 | 使用已有任务池 |`);
    writeFileSync(join(f.cwd, "new.cpp"), "void work() { pool.submit(job); pool.wait(); }\n");
    assert.deepEqual((await s.plan.check(s.path)).findings, []);
    writeFileSync(join(f.cwd, "new.cpp"), "std::function<void()> callback; // submit wait 只是注释\n");
    assert.match((await s.plan.check(s.path)).findings.join(), /未观察到计划接口/);
  } finally { f.cleanup(); }
});
