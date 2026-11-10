import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformQueryCache } from "../src/platformQueryCache.ts";
import { PlatformAdapter } from "../src/platformAdapter.ts";

const ok = (value = 1) => ({ status: 200, payload: { value } });

test("相同查询并发合并，30 秒内复用独立副本，到期重新读取", async () => {
  let now = 0, calls = 0;
  const cache = new PlatformQueryCache(30_000, () => now);
  const load = async () => ok(++calls);
  const results = await Promise.all(Array.from({ length: 100 }, () => cache.read("token", "mr/7", load)));
  assert.equal(calls, 1);
  assert.equal(results.filter(row => row.source === "shared").length, 99);
  (results[0].result.payload as { value: number }).value = 99;
  now = 29_999;
  assert.deepEqual((await cache.read("token", "mr/7", load)).result, ok(1));
  now++;
  assert.deepEqual((await cache.read("token", "mr/7", load)).result, ok(2));
});

test("凭据、MR 和提交 SHA 分开缓存，普通异常不缓存也不触发限流", async () => {
  const cache = new PlatformQueryCache();
  let calls = 0;
  for (const [scope, query] of [["a", "mr/1"], ["b", "mr/1"], ["a", "mr/2"], ["a", "sha/1"], ["a", "sha/2"]]) {
    await cache.read(scope, query, async () => ok(++calls));
  }
  assert.equal(calls, 5);
  await assert.rejects(cache.read("a", "broken", async () => { throw new Error("connection reset"); }), /connection reset/);
  assert.equal((await cache.read("a", "broken", async () => ok())).result.status, 200);
});

test("同一凭据所有端点共享 10/30/60 秒退避，冷却后只允许一个恢复探测", async () => {
  let now = 0, calls = 0;
  const cache = new PlatformQueryCache(30_000, () => now);
  const limited = async () => { calls++; throw new Error("server rate limited, please retry later (retried 3 times)"); };
  for (const delay of [10, 30, 60]) {
    const { result } = await cache.read("a", "gates", limited);
    assert.equal(result.status, 429);
    assert.equal(result.headers?.["retry-after"], String(delay));
    assert.equal((await cache.read("a", "discussions", limited)).source, "cooldown");
    now += delay * 1000;
  }
  assert.equal(calls, 3);
  assert.equal((await cache.read("b", "gates", async () => ok())).result.status, 200);
  let finish!: (value: ReturnType<typeof ok>) => void;
  const recovering = cache.read("a", "pipeline", () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.equal((await cache.read("a", "other-mr", limited)).source, "cooldown");
  finish(ok());
  assert.equal((await recovering).result.status, 200);
  assert.equal((await cache.read("a", "other-mr", limited)).result.headers?.["retry-after"], "30");
  now += 30_000;
  await cache.read("a", "probe-2", async () => ok());
  assert.equal((await cache.read("a", "other-mr", limited)).result.headers?.["retry-after"], "10");
  now += 10_000;
  await cache.read("a", "probe-3", async () => ok());
  assert.equal((await cache.read("a", "other-mr", async () => ok())).result.status, 200);
});

test("成功写入使旧缓存失效，也不复用写入前尚未完成的读取", async () => {
  const cache = new PlatformQueryCache();
  let finish!: (value: ReturnType<typeof ok>) => void;
  const before = cache.read("a", "gates", () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.invalidate("a");
  assert.deepEqual((await cache.read("a", "gates", async () => ok(2))).result, ok(2));
  finish(ok(1));
  await before;
  assert.deepEqual((await cache.read("a", "gates", async () => ok(3))).result, ok(2));
});

test("真实 CLI：门禁查询跨流程合并，写操作不缓存且使读取失效，SHA 和令牌隔离", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-query-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "cli.mjs"), calls = join(dir, "calls"), config = join(dir, "adapter.json");
  writeFileSync(cli, `import {appendFileSync} from 'node:fs';
const [mode] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, mode+'\\n');
console.log(JSON.stringify(mode==='close' ? {state:'closed'} : mode==='status' ? {runs:[]} : {gates:[]}));`);
  const command = (mode: string, ...args: string[]) => [process.execPath, cli, mode, ...args];
  writeFileSync(config, JSON.stringify({ token: "service-token", mr_create: { command: command("create") },
    pipeline_trigger: { observe_only: true }, pipeline_status: { command: command("status", "{sha}"), contract: true },
    mr_gates: { command: command("gates", "{mr}", "{token}"), items: { json: "gates" }, fields: {} },
    mr_close: { command: command("close", "{mr}") } }));
  const adapter = new PlatformAdapter(config, () => {});
  const read = (path: string, query: string, headers = {}) => adapter.handle("GET", path, new URLSearchParams(query), {}, headers);
  await Promise.all([read("/mr/gates", "repo=r&mr=7&source_branch=s&target_branch=main"), read("/mr/gates", "mr=7&repo=r")]);
  const count = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0;
  assert.equal(count(), 1);
  await read("/mr/gates", "repo=r&mr=7", { "x-mfc-git-token": "personal" });
  await read("/mr/gates", "repo=r&mr=8");
  await read("/pipeline/status", "repo=r&sha=a");
  await read("/pipeline/status", "repo=r&sha=b");
  assert.equal(count(), 5);
  for (let i = 0; i < 2; i++) await adapter.handle("POST", "/mr/close", new URLSearchParams(), { repo: "r", mr: "7" }, {});
  await read("/mr/gates", "repo=r&mr=7");
  assert.equal(count(), 8);
  const audit = readFileSync(join(dir, "logs", "adapter-calls.jsonl"), "utf8");
  assert.match(audit, /"query_source":"shared"/);
  assert.doesNotMatch(audit, /service-token|personal/);
});

test("真实 CLI：显式限流停止候选重试，同令牌其他端点和用户名不再执行 CLI", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-query-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "cli.mjs"), calls = join(dir, "calls"), config = join(dir, "adapter.json");
  writeFileSync(cli, `import {appendFileSync} from 'node:fs';
const [mode, token] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, mode+'\\n');
if(token==='shared') { console.error('server rate limited, please retry later (retried 3 times)'); process.exit(2); }
console.log(JSON.stringify({runs:[],gates:[]}));`);
  const command = (mode: string) => [process.execPath, cli, mode, "{token}"];
  writeFileSync(config, JSON.stringify({ token: "shared", mr_create: { command: command("create") },
    pipeline_trigger: { observe_only: true }, pipeline_status: { candidates: [
      { command: command("status-first"), contract: true }, { command: command("status-fallback"), contract: true }] },
    mr_gates: { command: command("gates"), items: { json: "gates" }, fields: {} } }));
  const adapter = new PlatformAdapter(config, () => {});
  const status = await adapter.handle("POST", "/pipeline/trigger", new URLSearchParams(), { repo: "r", sha: "a" }, {});
  assert.equal(status.status, 429);
  assert.equal(status.headers?.["retry-after"], "10");
  assert.equal((await adapter.handle("GET", "/mr/gates", new URLSearchParams("repo=r&mr=7"), {}, { "x-mfc-git-user": "another-user" })).status, 429);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["status-first"]);
  assert.equal((await adapter.handle("GET", "/mr/gates", new URLSearchParams("repo=r&mr=7"), {}, { "x-mfc-git-token": "other" })).status, 200);
});


test("材料查询只合并并发和共享限流，不长时间缓存大日志", async () => {
  const cache = new PlatformQueryCache();
  let calls = 0;
  const load = async () => ok(++calls);
  await Promise.all([cache.read("a", "artifacts", load, false), cache.read("a", "artifacts", load, false)]);
  assert.equal(calls, 1);
  await cache.read("a", "artifacts", load, false);
  assert.equal(calls, 2);
  await cache.read("a", "gates", async () => { throw new Error("HTTP 429"); });
  assert.equal((await cache.read("a", "artifacts", load, false)).source, "cooldown");
  assert.equal(calls, 2);
});
