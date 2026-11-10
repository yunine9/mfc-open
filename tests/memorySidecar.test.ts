/**
 * 任务记忆检索旁路(docs/knowledge-memory-design.md §7/§8)第二期契约。
 *
 * 假件(tests/fixtures/memsearch-sidecar-stub.mjs,同协议、不装模型)承载
 * 全部语义:配对、预算超时返回空、进程死了按需重拉、起不来就 unavailable;
 * 工具 repo 由宿主固定;三个推送时刻的内容与足迹。真件(memsearch venv)
 * 没有就**显式 skip 并明说**,有就跑 health/ingest/search/expand 一遍。
 */

import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { MemoryStore } from "../src/taskMemory.ts";
import { createMemoryTools, renderMemoryHits } from "../src/memoryTools.ts";
import { TaskService } from "../src/taskService.ts";

const STUB = resolve(process.cwd(), "tests/fixtures/memsearch-sidecar-stub.mjs");
const REAL_PYTHON = process.env.MFC_MEMSEARCH_PYTHON
  ?? resolve(process.cwd(), "..", "..", "..", ".local", "memsearch-venv", "bin", "python");
const REAL_SCRIPT = resolve(process.cwd(), "harness", "memsearch-sidecar.py");

function corpusWith(records: number): { dataDir: string; store: MemoryStore; ids: string[] } {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-sidecar-"));
  const store = new MemoryStore(dataDir);
  const ids: string[] = [];
  for (let index = 0; index < records; index += 1) {
    ids.push(store.record({
      source: index % 2 ? "prepush_fix" : "annotation",
      judged_by: index % 2 ? "pipeline" : "human", scope: "local",
      repo: "notify-service", paths: [index % 2 ? "pom.xml" : "src/filter/FilterEngine.java"],
      line: index % 2 ? undefined : 88, phase: "写代码", task: `task-old-${index}`,
      evidence: `e${index}`, trigger: index % 2 ? "加新渠道时" : "改过滤顺序时",
      conclusion: index % 2 ? "枚举新增渠道要同步改 registry.xml"
        : "黑名单判断必须在渠道开关之前",
    }).id);
  }
  return { dataDir, store, ids };
}

function stub(dataDir: string, env: Record<string, string> = {}, budgets = {}) {
  return new MemorySidecar({
    python: process.execPath, script: STUB,
    corpusDir: join(dataDir, "corpus"), milvusPath: join(dataDir, "memsearch", "milvus.db"),
    env, budgets, log: () => {},
  });
}

test("假 sidecar:ready 配对、search/expand 语义、repo 由宿主固定", async () => {
  const { dataDir, ids } = corpusWith(2);
  const sidecar = stub(dataDir);
  try {
    assert.equal(await sidecar.start(), true);
    assert.equal(await sidecar.health(), true);
    const hits = await sidecar.search({ query: "黑名单", repo: "notify-service" });
    assert.deepEqual(hits?.map((hit) => hit.id), [ids[0]]);
    assert.deepEqual(await sidecar.search({ query: "黑名单", repo: "other" }), [],
      "repo 是过滤键,别的仓的一条都不给");
    const scoped = await sidecar.search({ query: "渠道", repo: "notify-service", pathPrefix: "pom" });
    assert.deepEqual(scoped?.map((hit) => hit.id), [ids[1]]);
    const content = await sidecar.expand(ids[0]);
    assert.match(content ?? "", /^---\nid: /);
    assert.equal(await sidecar.expand("c-nope-000000"), undefined);
  } finally {
    sidecar.stop();
  }
});

test("预算:search 超预算返回 undefined 而不是挂着;进程死了按需重拉", async () => {
  const { dataDir } = corpusWith(1);
  const slow = stub(dataDir, { STUB_SLOW_SEARCH: "1" }, { searchMs: 200 });
  try {
    const started = Date.now();
    assert.equal(await slow.search({ query: "x", repo: "notify-service" }), undefined);
    assert.ok(Date.now() - started < 1500, "超时必须按预算返回,不能等 3 秒");
  } finally {
    slow.stop();
  }
  const dying = stub(dataDir, { STUB_DIE_AFTER: "1" });
  try {
    assert.equal(await dying.health(), true);
    await new Promise((tick) => setTimeout(tick, 150));
    assert.equal(dying.available, false, "应答一条就自杀的假件此时应已不在");
    assert.equal(await dying.health(), true, "下一次调用自动重拉");
  } finally {
    dying.stop();
  }
  const broken = stub(dataDir, { STUB_BOOT_FAIL: "1" }, { bootMs: 2000 });
  try {
    assert.equal(await broken.start(), false);
    assert.equal(await broken.search({ query: "x", repo: "r" }), undefined);
  } finally {
    broken.stop();
  }
});

test("停止旁路立即结束在途长预算请求，不遗留等待或重拉进程", async () => {
  const { dataDir } = corpusWith(0);
  const sidecar = stub(dataDir, { STUB_SLOW_SEARCH: "1" }, { searchMs: 600_000 });
  assert.equal(await sidecar.start(), true);
  const pending = sidecar.search({ query: "x", repo: "r" });
  await new Promise(resolve => setImmediate(resolve));
  sidecar.stop();
  const timeout = setTimeout(() => assert.fail("stop 未结束请求"), 1000);
  try {
    assert.equal(await pending, undefined);
    assert.equal(await sidecar.start(), false);
  } finally { clearTimeout(timeout); sidecar.stop(); }
});

test("已 ready 的进程连续退出也累计失败，五次后停止重启", async () => {
  const { dataDir } = corpusWith(0);
  let starts = 0;
  const closed: Promise<void>[] = [];
  const sidecar = new MemorySidecar({ python: process.execPath, script: STUB,
    corpusDir: join(dataDir, "corpus"), milvusPath: join(dataDir, "index.db"),
    env: { STUB_DIE_AFTER: "1" },
    spawnProcess(command, args, env) {
      starts++;
      const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      closed.push(new Promise(resolve => child.once("close", () => resolve())));
      return child;
    },
  });
  try {
    for (let index = 0; index < 5; index++) {
      assert.equal(await sidecar.health(), true);
      await closed[index];
      assert.equal(await sidecar.start(), false, "退出后立即查询不能绕过退避");
      if (index < 4) await new Promise(resolve => setTimeout(resolve, 120 * 2 ** index));
    }
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(await sidecar.start(), false);
    assert.equal(starts, 5, "ready 不能清零异常退出次数");
  } finally { sidecar.stop(); await Promise.all(closed); }
});

test("启动超时强制结束忽略 TERM 的进程，退出前不创建第二个索引写入者", async () => {
  const { dataDir } = corpusWith(0);
  let starts = 0;
  let closed: Promise<void> | undefined;
  const sidecar = new MemorySidecar({ python: process.execPath, script: STUB,
    corpusDir: join(dataDir, "corpus"), milvusPath: join(dataDir, "index.db"),
    budgets: { bootMs: 250 }, env: { STUB_IGNORE_TERM: "1", STUB_BOOT_DELAY_MS: "5000" },
    spawnProcess(command, args, env) {
      starts++;
      const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      closed = new Promise(resolve => child.once("close", () => resolve()));
      return child;
    },
  });
  try {
    assert.equal(await sidecar.start(), false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await sidecar.start(), false);
    assert.equal(starts, 1);
    await closed;
    assert.equal(sidecar.available, false);
  } finally { sidecar.stop(); await closed; }
});

test("工具:corpus_search 结果封顶带 id/判定者/位置;expand 形状校验;足迹回调", async () => {
  const { dataDir, ids } = corpusWith(2);
  const sidecar = stub(dataDir);
  const used: Array<{ moment: string; ids: string[] }> = [];
  try {
    const [search, expand] = createMemoryTools({
      repo: "notify-service",
      search: (input) => sidecar.search({ ...input, repo: "notify-service" }),
      expand: (id) => sidecar.expand(id),
      onUse: (event) => used.push({ moment: event.moment, ids: event.ids }),
    }) as any[];
    assert.equal(search.name, "corpus_search");
    assert.ok(search.promptGuidelines[0].includes("之前"), "触发写成动作锚定");
    const result = await search.execute("call-1", { query: "黑名单" });
    assert.match(result.content[0].text, new RegExp(`\\(${ids[0]}\\) \\[人确认 · \\d{4}-\\d{2}-\\d{2} · src/filter/FilterEngine.java:88\\]`));
    const bad = await expand.execute("call-2", { memory_id: "../etc/passwd" });
    assert.match(bad.content[0].text, /形状不对/);
    const full = await expand.execute("call-3", { memory_id: ids[0] });
    assert.match(full.content[0].text, /## 结论/);
    assert.deepEqual(used.map((row) => row.moment), ["search", "expand"]);
  } finally {
    sidecar.stop();
  }
  assert.equal(renderMemoryHits([]), "没有命中的记忆。");
});

test("真 memsearch sidecar:health/ingest/search/expand 一遍(venv 缺席则显式 skip)", async (t) => {
  if (!existsSync(REAL_PYTHON)) {
    t.skip(`找不到 memsearch venv 的 python(${REAL_PYTHON});设 MFC_MEMSEARCH_PYTHON 后重跑`);
    return;
  }
  const { dataDir, store, ids } = corpusWith(2);
  const sidecar = new MemorySidecar({
    python: REAL_PYTHON, script: REAL_SCRIPT,
    corpusDir: store.root, milvusPath: join(dataDir, "memsearch", "milvus.db"),
    budgets: { searchMs: 5_000, ingestMs: 20_000 },
    env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    log: () => {},
  });
  try {
    assert.equal(await sidecar.start(), true, "真 sidecar 起不来");
    assert.equal(await sidecar.health(), true);
    for (const id of ids) {
      const row = store.review(id, "owner", { decision: "accepted", revision: store.find(id)!.revision ?? 1 });
      assert.equal(await sidecar.ingest(join(store.root, row.file)), true);
    }
    const hits = await sidecar.search({ query: "被关掉的渠道为什么还跑黑名单", repo: "notify-service" });
    assert.equal(hits?.[0]?.id, ids[0], "换说法也要首位命中");
    assert.match((await sidecar.expand(ids[0])) ?? "", /黑名单判断必须在渠道开关之前/);
    assert.equal(readFileSync(join(store.root, store.find(ids[0])!.file), "utf-8").includes("## 结论"), true);
  } finally {
    sidecar.stop();
  }
});


test("本机检索连接绕过代理，并保留使用方已有的代理排除项", async () => {
  const { dataDir } = corpusWith(0);
  const supplied = { NO_PROXY: "corp.example", no_proxy: "internal.example", HTTPS_PROXY: "http://127.0.0.1:9" };
  let captured: NodeJS.ProcessEnv | undefined;
  const sidecar = new MemorySidecar({ python: process.execPath, script: STUB,
    corpusDir: join(dataDir, "corpus"), milvusPath: join(dataDir, "index.db"), env: supplied,
    spawnProcess: (command, args, env) => { captured = env; return spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); } });
  try {
    assert.equal(await sidecar.start(), true);
    assert.equal(captured?.NO_PROXY, captured?.no_proxy);
    for (const host of ["corp.example", "internal.example", "localhost", "127.0.0.1", "::1"]) {
      assert.ok(captured?.NO_PROXY?.split(",").includes(host));
    }
    assert.equal(captured?.HTTPS_PROXY, supplied.HTTPS_PROXY);
    assert.equal(supplied.no_proxy, "internal.example", "只修改子进程环境，不改调用方配置");
  } finally { sidecar.stop(); }
});

test("真实 sidecar：冷索引后台准备，默认三秒预算连续查询、编辑后不返回旧正文", async t => {
  if (!existsSync(REAL_PYTHON)) return t.skip("需要 MFC_MEMSEARCH_PYTHON");
  const { rmSync } = await import("node:fs");
  const { dataDir, store, ids } = corpusWith(1);
  const row = store.review(ids[0], "owner", { decision: "accepted", revision: store.find(ids[0])!.revision ?? 1 });
  const path = join(store.root, row.file);
  const logs: string[] = [];
  let exited: Promise<void> | undefined;
  const sidecar = new MemorySidecar({ python: REAL_PYTHON, script: REAL_SCRIPT,
    corpusDir: store.root, milvusPath: join(dataDir, "milvus.db"),
    env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, log: value => logs.push(value),
    spawnProcess(command, args, env) {
      const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      exited = new Promise(resolve => child.once("close", () => resolve()));
      return child;
    },
  });
  t.after(async () => { sidecar.stop(); await exited; rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(await sidecar.start(), true);
  assert.equal(sidecar.searchBudgetMs, 3000);
  const input = { query: "黑名单和渠道开关的判断顺序", repo: "notify-service" };
  assert.equal(await sidecar.search(input), undefined, "首次索引准备不能冒充无命中");
  const readyBy = Date.now() + 10_000;
  let prepared = false;
  while (Date.now() < readyBy) {
    await new Promise(resolve => setTimeout(resolve, 20));
    if ((await sidecar.search(input))?.[0]?.id === ids[0]) { prepared = true; break; }
  }
  assert.ok(prepared, "无需显式 ingest，后台索引应完成并恢复检索");
  const elapsed: number[] = [];
  for (let index = 0; index < 5; index++) {
    const start = Date.now();
    const hits = await sidecar.search(input);
    elapsed.push(Date.now() - start);
    assert.equal(hits?.[0]?.id, ids[0]);
  }
  t.diagnostic(`本机真实检索五次耗时(ms): ${elapsed.join(", ")}`);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("黑名单判断必须在渠道开关之前", "渠道开关判断必须先执行"));
  assert.equal(await sidecar.search(input), undefined, "修改后旧索引正文不能混入结果");
  assert.equal(await sidecar.ingest(path, 20_000), true);
  const updated = await sidecar.search(input);
  assert.ok(updated?.[0]?.snippet?.includes("渠道开关判断必须先执行"));
  assert.ok(!updated?.some(hit => hit.snippet?.includes("黑名单判断必须在渠道开关之前")));
  assert.equal(await sidecar.health(), true);
  // stdout reply can arrive just before the stderr diagnostics.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(logs.some(line => line.includes('"embed_ms"') && line.includes('"database_ms"')));
  assert.ok(!logs.some(line => line.includes("too_many_pings")));
});
