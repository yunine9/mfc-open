import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedKnowledgeModules, knowledgeModuleNames, loadKnowledgeModules } from "../web/src/knowledgeModules.ts";
import { createKnowledgeReadCache, invalidateKnowledgeReads } from "../web/src/knowledgeReadCache.ts";
import { knowledgeDocumentResourceUrl, readKnowledgeDocument, type KnowledgeDocument } from "../web/src/knowledgeDocumentsApi.ts";
import { updateBusinessModule } from "../web/src/api.ts";

const document = (revision = "r1"): KnowledgeDocument => ({
  id: "kg-example", title: "示例", content: `正文 ${revision}`, scope: "module", module_ids: ["example"],
  repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision, history: [],
});
const module = {
  id: "example", name: "示例模块", status: "active", assets: [], repositories: [],
  description: "", revision: 1, owner: "test", maintainers: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("首页、模块和并发读取共用轻量目录，显式刷新及配置更新立即失效", async t => {
  invalidateKnowledgeReads();
  const calls: string[] = [];
  let revision = "r1";
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls.push(input);
    if (input === "/knowledge-documents?view=directory") return json({ documents: [document(revision)] });
    if (input === "/business-modules") return json({ modules: [module] });
    if (input === "/business-modules/example") return json({ ...module, revision: 2 });
    if (input === "/component-repositories") return json({ components: [] });
    if (input === "/skills?view=directory") return json({ skills: [], operations: [] });
    if (input === "/technology-stacks") return json({ stacks: [{ id: "cpp", name: "C++", enabled: true }] });
    throw new Error(`不应读取管理详情接口: ${input}`);
  });
  const home = loadKnowledgeModules(), reader = loadKnowledgeModules();
  assert.equal(home, reader, "在途目录读取合并");
  const first = await home;
  assert.equal(cachedKnowledgeModules(), first, "进入模块可同步显示已有目录");
  assert.equal(await loadKnowledgeModules(), first);
  assert.equal(calls.filter(path => path === "/knowledge-documents?view=directory").length, 1);
  assert.equal(calls.filter(path => path === "/skills?view=directory").length, 1);
  revision = "r2";
  assert.equal((await loadKnowledgeModules(true)).documents[0].revision, "r2", "手动刷新不能命中旧缓存");
  await updateBusinessModule("example", { knowledge_path: "Function_Knowledge/Access Function/示例模块" });
  assert.equal(cachedKnowledgeModules(), undefined);
  revision = "r3";
  assert.equal((await loadKnowledgeModules()).documents[0].revision, "r3");
  assert.equal(calls.filter(path => path === "/knowledge-documents?view=directory").length, 3);
});

test("技术栈改名只重投影工程目录，保留业务文稿引用", async () => {
  const data = {
    modules: [
      { key: "engineering:cpp", id: "cpp", name: "C++", description: "", category: "engineering" as const, documents: [], repositories: [], documentCount: 0, skillCount: 0, inactiveCount: 0, recentlyMaintained: 0 },
      { key: "business:example", id: "example", name: "示例", description: "", category: "business" as const, documents: [document()], repositories: [], documentCount: 1, skillCount: 0, inactiveCount: 0, recentlyMaintained: 0 },
    ], documents: [document()], warnings: [],
  };
  const next = knowledgeModuleNames(data, [{ id: "cpp", name: "团队 C++", enabled: true }])!;
  assert.equal(next.modules[0].name, "团队 C++");
  assert.equal(next.modules[1], data.modules[1]);
  assert.equal(next.documents, data.documents);
});

test("正文同版本合并请求，切换版本与失效后重新读取，不把新正文缓存成旧版本", async t => {
  invalidateKnowledgeReads();
  let calls = 0, revision = "r1";
  t.mock.method(globalThis, "fetch", async () => { calls++; return json(document(revision)); });
  const one = readKnowledgeDocument("kg-example", "r1"), two = readKnowledgeDocument("kg-example", "r1");
  assert.equal(one, two);
  assert.equal((await one).content, "正文 r1");
  await readKnowledgeDocument("kg-example", "r1");
  assert.equal(calls, 1);
  revision = "r2";
  assert.equal((await readKnowledgeDocument("kg-example", "r2")).content, "正文 r2");
  assert.equal(calls, 2);
  invalidateKnowledgeReads();
  await readKnowledgeDocument("kg-example", "r2");
  assert.equal(calls, 3);
  revision = "r3";
  await readKnowledgeDocument("kg-example", "r2", true);
  await readKnowledgeDocument("kg-example", "r2");
  assert.equal(calls, 5, "响应版本不一致时不能留在旧版本键下");
});

test("仅图片提交变化也刷新正文来源并更换资源地址，不复用同正文revision的旧提交", async t => {
  invalidateKnowledgeReads();
  let commit = "commit-a", reads = 0;
  t.mock.method(globalThis, "fetch", async (_input: string, options: { cache: string; signal: AbortSignal }) => {
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    reads++;
    return json({ ...document("same-body"), source: { repository: "https://git.example/knowledge", branch: "main", path: "模块/说明.md", revision: commit } });
  });
  const before = await readKnowledgeDocument("kg-example", "same-body", false, commit);
  commit = "commit-b";
  const after = await readKnowledgeDocument("kg-example", "same-body", false, commit);
  assert.equal(reads, 2);
  assert.equal(before.content, after.content);
  assert.equal(after.source?.revision, "commit-b");
  assert.match(knowledgeDocumentResourceUrl(before, "图片/流程.svg"), /revision=commit-a$/);
  assert.match(knowledgeDocumentResourceUrl(after, "图片/流程.svg"), /revision=commit-b$/);
});

test("必要模块配置读取失败不会发布空模块目录，也不会缓存失败结果", async t => {
  invalidateKnowledgeReads();
  let unavailable = true;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input === "/knowledge-documents?view=directory") return json({ documents: [document()] });
    if (input === "/business-modules") return unavailable ? json({ error: "temporarily unavailable" }, 503) : json({ modules: [module] });
    if (input === "/component-repositories") return json({ components: [] });
    if (input === "/skills?view=directory") return json({ skills: [], operations: [] });
    if (input === "/technology-stacks") return json({ stacks: [] });
    throw new Error(input);
  });
  await assert.rejects(loadKnowledgeModules(), /temporarily unavailable/);
  assert.equal(cachedKnowledgeModules(), undefined);
  unavailable = false;
  assert.equal((await loadKnowledgeModules()).modules[0].id, "example");
});

test("模块配置在目录返回后读取，避免把旧配置与新目录版本拼接", async t => {
  invalidateKnowledgeReads();
  let release!: (value: Response) => void, moduleReads = 0;
  t.mock.method(globalThis, "fetch", async (input: string, options?: { signal?: AbortSignal }) => {
    if (input === "/knowledge-documents?view=directory") return new Promise<Response>(resolve => { release = resolve; });
    if (input === "/business-modules") {
      moduleReads++; assert.ok(options?.signal);
      return json({ modules: [{ ...module, name: "配置更新后的模块" }] });
    }
    if (input === "/component-repositories") return json({ components: [] });
    if (input === "/skills?view=directory") return json({ skills: [], operations: [] });
    if (input === "/technology-stacks") return json({ stacks: [] });
    throw new Error(input);
  });
  const loading = loadKnowledgeModules();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(moduleReads, 0);
  release(json({ documents: [document()] }));
  assert.equal((await loading).modules[0].name, "配置更新后的模块");
  assert.equal(moduleReads, 1);
});

test("失效前的慢请求不会覆盖刷新结果，失败允许重试", async () => {
  const cache = createKnowledgeReadCache<string>({ maxEntries: 2, maxWeight: 100, ttl: 1000, weight: value => value.length });
  let finishOld!: (value: string) => void;
  const old = cache.read("document", () => new Promise(resolve => { finishOld = resolve; }));
  await Promise.resolve();
  invalidateKnowledgeReads();
  const latest = await cache.read("document", async () => "new");
  finishOld("old");
  assert.equal(await old, "old");
  assert.equal(latest, "new");
  assert.equal(cache.peek("document"), "new");
  await assert.rejects(cache.read("failed", async () => { throw new Error("network"); }), /network/);
  assert.equal(await cache.read("failed", async () => "retry"), "retry");
});

test("正文缓存按时间、条数和容量淘汰，大文件仍可正常读取", async t => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const cache = createKnowledgeReadCache<string>({ maxEntries: 2, maxWeight: 6, ttl: 10, weight: value => value.length });
  await cache.read("a", async () => "aaa");
  await cache.read("b", async () => "bbb");
  await cache.read("a", async () => "unexpected");
  await cache.read("c", async () => "ccc");
  assert.equal(cache.peek("b"), undefined, "最近未读的条目先淘汰");
  assert.equal(cache.peek("a"), "aaa");
  now = 111;
  assert.equal(cache.peek("a"), undefined, "到期后不显示旧目录");
  assert.equal(await cache.read("large", async () => "too large"), "too large");
  assert.equal(cache.peek("large"), undefined);
});
