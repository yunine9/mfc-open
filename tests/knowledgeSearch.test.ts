import { test } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule, updateBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { collectSearchableKnowledge, KnowledgeSearch, knowledgeProductVersions } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { knowledgeDocumentCatalog } from "../src/knowledgeDocumentCatalog.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { MemoryStore } from "../src/taskMemory.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { gitKnowledgeDocument, removeGitKnowledgeDocument } from "./fixtures/gitKnowledge.ts";

const context = { repo: "a", repositories: ["https://code.example/a.git"], moduleIds: [], productVersion: "2.7B" };

test("检索进程重启较慢时，不把启动耗时算进查询预算而丢弃正常结果", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cold-search-"));
  const children: Array<ReturnType<typeof spawn>> = [], exits: Promise<void>[] = [];
  const sidecar = new MemorySidecar({ python: process.execPath, script: join(process.cwd(), "tests/fixtures/memsearch-sidecar-stub.mjs"),
    corpusDir: join(dir, "corpus"), milvusPath: join(dir, "index.db"), env: { STUB_BOOT_DELAY_MS: "150" },
    budgets: { searchMs: 75, bootMs: 3000 },
    spawnProcess(command, args, env) {
      const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child); exits.push(new Promise(resolve => child.once("close", () => resolve())));
      return child;
    },
  });
  try {
    saveKnowledgeDocument(dir, { title: "数据库", content: "数据库插入数据" }, "owner");
    const search = new KnowledgeSearch(dir, sidecar);
    await search.prepare();
    children[0].kill(); await exits[0];
    assert.equal(await sidecar.start(), false, "异常退出后先退避，不立即重启");
    await new Promise(resolve => setTimeout(resolve, 120));
    const result = await search.searchDocuments(context, "数据库插入数据", { all: true });
    assert.equal(children.length, 2);
    assert.equal(result.available, true, "进程正常启动后返回的查询结果不能变成不可用");
    assert.deepEqual(result.warnings, []);
  } finally { sidecar.stop(); await Promise.all(exits); rmSync(dir, { recursive: true, force: true }); }
});
function seed(dir: string) {
  seedTechnologyStacks(dir, ["cpp"]);
  createBusinessModule(dir, { id: "alarm", name: "告警模块", description: "跨仓告警", owner: "owner",
    repositories: [context.repositories[0], "https://code.example/b.git"] }, "owner");
  const dedup = gitKnowledgeDocument(dir, "alarm", { title: "告警重复事件", when_to_use: "处理告警重复上报时", content: "# 重复告警\n按事件 ID 和网元 ID 去重。" });
  function document(title: string, body: string, published = true) {
    const row = saveKnowledgeDocument(dir, { title, when_to_use: "修改超时配置时", technologies: ["cpp"],
      content: body, active: published, product_versions: knowledgeProductVersions(body) }, "owner");
    return row.id;
  }
  const old = document("2.6B 超时配置", '---\nproduct_versions: ["2.6B"]\n---\n配置 request_timeout_ms，单位毫秒。');
  const current = document("2.7B 超时配置", '---\nproduct_versions: ["2.7B"]\n---\n配置 request_timeout_seconds，单位秒。');
  const pending = document("未经确认的规范", "不要使用", false);
  return { old, current, pending, dedup: dedup.id };
}

test("当前模块映射可发现跨仓知识；明确产品版本先筛选；草稿不参与；无元数据不猜版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-catalog-"));
  try {
    const ids = seed(dir);
    const catalog = collectSearchableKnowledge(dir, context);
    assert.ok(catalog.assets.some(a => a.id === ids.dedup), "无需开局先选中模块");
    assert.ok(catalog.assets.some(a => a.id === ids.current));
    assert.ok(!catalog.assets.some(a => a.id === ids.old || a.id === ids.pending));
    assert.deepEqual(knowledgeProductVersions("文档修订 2.6B；不适用于 2.7B"), []);
    assert.ok(collectSearchableKnowledge(dir, { ...context, productVersion: undefined }).assets.some(a => a.id === ids.old));
    removeGitKnowledgeDocument(dir, "alarm", ids.dedup);
    assert.ok(!collectSearchableKnowledge(dir, context).assets.some(a => a.id === ids.dedup));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("等待索引期间被停用的模块不返回；工具只回当前来源，不信旧索引正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-race-"));
  try {
    const ids = seed(dir);
    const fake = { ingest: async () => true, search: async () => {
      updateBusinessModule(dir, "alarm", { status: "archived" }, "owner");
      return [{ id: ids.dedup, snippet: "过期正文", score: 1 }];
    } } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(dir, fake);
    assert.deepEqual((await service.search(context, "告警去重")).hits, []);
    assert.equal(service.read(context, ids.dedup), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("统一工具提示词含明确动作示例；正文可离线读，停用后不能复用，故障不阻塞", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-tool-"));
  try {
    const ids = seed(dir);
    const service = new KnowledgeSearch(dir);
    const tool: any = createKnowledgeTool({ service: () => service, context: () => context });
    assert.match(tool.promptGuidelines!.join("\n"), /异步回调.*YAML/);
    assert.match(tool.promptGuidelines!.join("\n"), /不在每次/);
    const result = await tool.execute("read", { action: "read", id: ids.current });
    assert.match(result.content[0].text, /request_timeout_seconds/);
    assert.match(result.content[0].text, /不是产品版本/);
    const missing = await tool.execute("search", { action: "search", query: "超时配置" });
    assert.match(missing.content[0].text, /继续当前任务/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("真实统一工具串行索引、模块召回、版本筛选、经验搜索及停用；本机实测", { timeout: 60000 }, async t => {
  const python = process.env.MFC_MEMSEARCH_PYTHON;
  if (!python) { t.skip("设置 MFC_MEMSEARCH_PYTHON 运行真实模型"); return; }
  const dir = mkdtempSync(join(tmpdir(), "knowledge-real-"));
  const sidecar = new MemorySidecar({ python, script: join(process.cwd(), "harness/memsearch-sidecar.py"),
    corpusDir: join(dir, "corpus"), milvusPath: join(dir, "index.db"),
    env: { HF_HUB_OFFLINE: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "corp.example", no_proxy: "internal.example" } });
  try {
    const ids = seed(dir);
    const store = new MemoryStore(dir);
    const row = store.record({ source: "agent_note", judged_by: "human", scope: "platform", repo: "other", paths: [],
      task: "task-1", evidence: "example", trigger: "C++ 异步回调访问已销毁对象", conclusion: "使用弱引用，并在访问前检查对象是否仍有效。" });
    store.review(row.id, "owner", { decision: "accepted", revision: 1 });
    assert.equal(await sidecar.start(), true);
    const service = new KnowledgeSearch(dir, sidecar);
    await service.prepare();
    const tool: any = createKnowledgeTool({ service: () => service, context: () => context });
    const module = await tool.execute("module", { action: "search", query: "告警重复事件如何去重" });
    assert.ok((module.details as any).hits?.some((h: any) => h.id === ids.dedup), JSON.stringify(module));
    const version = await service.search(context, "2.7B 超时参数的配置单位");
    assert.ok(version.hits.some(h => h.id === ids.current));
    assert.ok(!version.hits.some(h => h.id === ids.old));
    const callback = await service.search(context, "回调还没结束对象就释放了怎么办");
    assert.equal(callback.hits[0]?.id, row.id, JSON.stringify(callback));
    const updated = store.review(row.id, "teammate", { decision: "accepted", revision: store.find(row.id)!.revision!,
      module: "alarm", product_versions: ["2.7B"], conclusion: "先核对回调生命周期。弱引用需判空；共享所有权场景保留强引用。" });
    await service.prepare();
    const revised = await service.search(context, "回调还没结束对象就释放了怎么办");
    assert.ok(revised.hits.some(hit => hit.id === row.id));
    assert.match(JSON.stringify(service.read(context, row.id)), /共享所有权/);
    assert.equal(service.read({ ...context, productVersion: "2.6B" }, row.id), undefined);
    store.review(row.id, "teammate", { decision: "rejected", revision: updated.revision! });
    assert.ok(!(await service.search(context, "回调还没结束对象就释放了怎么办")).hits.some(hit => hit.id === row.id));
    assert.equal(service.read(context, row.id), undefined);

    assert.deepEqual((await service.search(context, "办公室盆栽多久浇一次水")).hits, []);
    removeGitKnowledgeDocument(dir, "alarm", ids.dedup);
    assert.ok(!(await service.search(context, "告警重复事件如何去重")).hits.some(h => h.id === ids.dedup));
    const read = await tool.execute("read-old", { action: "read", id: ids.dedup });
    assert.match(read.content[0].text, /已停用/);
  } finally { sidecar.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("索引缓慢有时间上限且不重复排队；完成后下一次查询可正常使用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-budget-"));
  let finish!: (value: boolean) => void;
  let calls = 0;
  const waiting = new Promise<boolean>(resolve => { finish = resolve; });
  try {
    seed(dir);
    const fake = { ingest: async () => { calls++; return waiting; }, search: async () => [] } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(dir, fake), before = Date.now();
    const result = await service.search(context, "超时配置");
    assert.equal(result.available, false);
    assert.ok(Date.now() - before < 2500);
    assert.equal(calls, 1, "尚未完成的索引作业串行，不向侧车灌入大量超时请求");
    finish(true);
    assert.equal((await service.search(context, "超时配置")).available, true);
    assert.equal(calls, 2, "两个有效资产各索引一次，重复查询复用在途作业");
  } finally { finish?.(true); rmSync(dir, { recursive: true, force: true }); }
});

test("检索指引进入实际 PI 系统提示词，提供统一工具名及简短行动示例", async () => {
  const { buildSystemPrompt } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
  const tool = createKnowledgeTool({ service: () => undefined, context: () => context });
  const prompt = buildSystemPrompt({ cwd: "/test", selectedTools: [tool.name],
    toolSnippets: { [tool.name]: tool.promptSnippet! }, promptGuidelines: tool.promptGuidelines });
  assert.match(prompt, /knowledge\(action=search/);
  assert.match(prompt, /C\+\+ 异步回调 对象销毁 生命周期/);
  assert.match(prompt, /不在每次读文件、改代码前重复搜索/);
  assert.match(prompt, /不反复空查或等待/);
});


test("Skill 管理读原生包；knowledge 不索引、不检索、不读取 Skill 或旧发布收据", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-"));
  try {
    const root = join(dir, "skills", "build-guide");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\nname: build-guide\ndescription: 首次构建\nknowledge_nature: engineering\ntechnologies: [cpp]\n---\n# 构建指南\n当前正确做法\n");
    const service = new KnowledgeSearch(dir);
    assert.equal(service.read(context, "skill:build-guide/SKILL.md"), undefined);
    assert.match(knowledgeDocumentCatalog(dir).documents.find(d => d.id === "skill:build-guide/SKILL.md")!.content, /当前正确做法/);
    let ingested = 0;
    const search = new KnowledgeSearch(dir, {ingest:async()=>{ingested++;return true;}, search:async()=>[{id:"skill:build-guide/SKILL.md",score:1}]} as any);
    await search.prepare();
    assert.equal(ingested,0,"包括后台 prepare 也不索引技能包");
    assert.deepEqual((await search.search(context,"首次构建")).hits,[],"旧索引命中不能复活技能条目");
    rmSync(root, { recursive: true });
    assert.equal(service.read(context, "skill:build-guide/SKILL.md"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("新任务只宣传统一检索，恢复的旧会话保留工具名兼容而不重复注入检索指引", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-session-"));
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const api = service as any, task = api.tasks.get(service.create("检索经验").id);
    task.resume = false;
    assert.deepEqual(api.memoryTools(task).map((tool: any) => tool.name).sort(), ["corpus_write", "knowledge"]);
    task.resume = true;
    const tools = api.memoryTools(task);
    assert.ok(tools.some((tool: any) => tool.name === "knowledge"));
    for (const name of ["corpus_search", "corpus_expand"]) {
      const legacy = tools.find((tool: any) => tool.name === name);
      assert.ok(legacy);
      assert.deepEqual(legacy.promptGuidelines, []);
    }
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("搜索保留章节原文行号，read 定位规则和例外并拒绝旧版本位置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-lines-"));
  try {
    const ids = seed(dir);
    const fake = { ingest: async () => true, searchBudgetMs: 3000, search: async ({ sources }: any) => {
      const file = sources.find((source: any) => source.id === ids.current).path;
      const { readFileSync } = await import("node:fs");
      const lines = readFileSync(file, "utf8").split("\n");
      const line = lines.findIndex(row => row.includes("配置 request_timeout_seconds")) + 1;
      return [{ id: ids.current, score: 1, heading: "手册 > 超时", start_line: line, end_line: line, snippet: "单位秒" },
        { id: ids.current, score: 1, heading: "索引元数据", start_line: 5, end_line: 9 }];
    } } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(dir, fake);
    await service.prepare();
    const hits = (await service.search(context, "超时")).hits;
    assert.equal(hits.length, 1, "镜像元数据不能显示成原文第 1–? 行");
    const hit = hits[0];
    assert.equal(hit.start_line, 4);
    assert.equal(hit.end_line, 4);
    const tool: any = createKnowledgeTool({ service: () => service, context: () => context });
    const result = await tool.execute("read", { action: "read", id: hit.id, start_line: hit.start_line, end_line: hit.end_line, revision: hit.revision });
    assert.match(result.content[0].text, /4: 配置 request_timeout_seconds/);
    const stale = await tool.execute("old", { action: "read", id: hit.id, revision: "old" });
    assert.match(stale.content[0].text, /文档已更新/);
    const invalid = await tool.execute("invalid", { action: "read", id: hit.id, start_line: 1000 });
    assert.match(invalid.content[0].text, /读取范围无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("单份手册索引慢时已就绪知识仍可检索，并明确说明范围未完整", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-partial-"));
  let finish!: (value: boolean) => void;
  const waiting = new Promise<boolean>(resolve => { finish = resolve; });
  let calls = 0;
  try {
    seed(dir);
    const fake = { ingest: async () => ++calls === 1 ? true : waiting,
      search: async ({ sources }: any) => {
        assert.equal(sources.length, 1);
        return [{ id: sources[0].id, score: 1, snippet: "已就绪内容" }];
      } } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(dir, fake);
    const result = await service.search(context, "超时");
    assert.equal(result.available, true);
    assert.equal(result.hits.length, 1);
    assert.match(result.warnings.join(""), /不是完整知识范围/);
  } finally { finish(true); rmSync(dir, { recursive: true, force: true }); }
});


test("模块 Skill 留在管理目录和原生加载路径，不进入 knowledge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-module-skill-"));
  try {
    createBusinessModule(dir, { id: "alarm", name: "告警", description: "告警管理", owner: "owner", repositories: context.repositories }, "owner");
    publishBusinessKnowledgeAsset(dir, "alarm", { id: "check", title: "告警检查", summary: "检查告警", when_to_use: "检查告警时", form: "skill", content: "# 告警检查\n核对告警来源。" }, "owner");
    assert.equal(collectSearchableKnowledge(dir, context, true).assets.length, 0);
    const doc = knowledgeDocumentCatalog(dir).documents.find(d => d.id === "module:alarm:check");
    assert.equal(doc?.form, "skill");
    assert.equal(new KnowledgeSearch(dir).read(context, "module:alarm:check"), undefined);
    const { snapshotBusinessModules, materializeBusinessModuleKnowledge } = await import("../src/businessModuleRuntime.ts");
    const workspace = join(dir, "task-1");
    mkdirSync(workspace, { recursive: true });
    const selected = snapshotBusinessModules({ dataDir: dir, taskWorkspace: workspace, moduleIds: ["alarm"], repositories: context.repositories });
    const runtime = materializeBusinessModuleKnowledge({ selected, taskWorkspace: workspace, runtimeWorkspace: workspace });
    assert.equal(runtime.skill_paths.length, 1);
    assert.match(runtime.skill_paths[0], /SKILL\.md$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
