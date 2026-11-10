import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codecheckToolchainStats, prepareCodecheckToolchain, reclaimCodecheckToolchain,
  seedCodecheckToolchain } from "../src/codecheckToolchain.ts";
import { runCodecheckPrepush } from "../src/codecheckPrepush.ts";
import { reclaimWorkspace } from "../src/workspaceReclaim.ts";
import { forceRm } from "./mfcRm.ts";

const tool = (version = "1.0") => `home/product/tools/agent/${version}/CodeCheckAgent/tools/check`;
function put(root: string, path: string, content = "binary") {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, { mode: 0o755 });
  return file;
}
function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-codecheck-toolchain-"));
  t.after(() => forceRm(dataDir));
  const a = join(dataDir, "task-a", "repo"), b = join(dataDir, "task-b", "repo");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const root = join(dataDir, "shared/codecheck-agent");
  const master = (version = "1.0") => join(root, "product", version);
  const install = (repo: string, version = "1.0") => put(join(repo, ".codecheckcli"), tool(version));
  return { dataDir, a, b, root, master, install };
}
function sameFile(a: string, b: string) {
  const left = statSync(a), right = statSync(b);
  assert.deepEqual([left.dev, left.ino], [right.dev, right.ino]);
}
function age(root: string) {
  const file = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.lastUsedAt = Date.now() - 100_000;
  writeFileSync(file, JSON.stringify(manifest));
}

test("首个任务懒加载母本，第二个任务硬链接复用；只包含稳定工具文件", async t => {
  const f = fixture(t);
  assert.equal(existsSync(f.root), false);
  const first = await prepareCodecheckToolchain(f.dataDir, f.a);
  assert.ok(first.release);
  assert.ok(existsSync(join(f.root, ".bootstrap.lock")));
  const installed = f.install(f.a);
  const cli = join(f.a, ".codecheckcli");
  for (const path of ["codecheck-result.json", "prepush-context.json", "skills/a/SKILL.md",
    "home/product/tools/agent/1.0/logs/run.log", "home/product/tools/agent/1.0/.lock",
    "home/product/tools/agent/1.0/tmp/incomplete", "home/product/tools/agent/1.0/check.tmp"]) put(cli, path, "private");
  symlinkSync("check", join(installed, "..", "alias"));
  symlinkSync("/etc/passwd", join(installed, "..", "external"));
  await seedCodecheckToolchain(f.dataDir, f.a);
  first.release?.();
  assert.equal(existsSync(join(f.root, ".bootstrap.lock")), false);
  const manifest = JSON.parse(readFileSync(join(f.master(), "manifest.json"), "utf8"));
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.bytes, 6);
  assert.equal(manifest.toolchainRoot, "home/product/tools/agent/1.0");
  assert.ok(manifest.createdAt && manifest.lastUsedAt);
  assert.equal(existsSync(join(f.master(), "tree/codecheck-result.json")), false);
  put(join(f.b, ".codecheckcli"), "codecheck-result.json", "own result");
  await prepareCodecheckToolchain(f.dataDir, f.b);
  sameFile(installed, join(f.master(), "tree", tool()));
  sameFile(join(f.b, ".codecheckcli", tool()), join(f.master(), "tree", tool()));
  assert.ok(statSync(join(f.b, ".codecheckcli", tool())).mode & constants.S_IXUSR);
  assert.equal(readlinkSync(join(f.b, ".codecheckcli", tool(), "..", "alias")), "check");
  assert.equal(readFileSync(join(f.b, ".codecheckcli/codecheck-result.json"), "utf8"), "own result");
  assert.deepEqual(codecheckToolchainStats(f.dataDir, f.b), { masters: 1, bytes: 6, taskBytes: 16, taskIncrementalBytes: 10 });
});

test("同进程并发 seed 共享工作；跨进程目录锁阻止重复写母本", async t => {
  const f = fixture(t); f.install(f.a); f.install(f.b);
  mkdirSync(join(f.root, "product/.1.0.lock"), { recursive: true });
  const pending = Promise.all([seedCodecheckToolchain(f.dataDir, f.a), seedCodecheckToolchain(f.dataDir, f.b)]);
  await delay(80);
  assert.equal(existsSync(join(f.master(), "manifest.json")), false);
  rmSync(join(f.root, "product/.1.0.lock"), { recursive: true });
  await pending;
  assert.deepEqual(readdirSync(join(f.root, "product")), ["1.0"]);
  sameFile(join(f.master(), "tree", tool()), join(f.a, ".codecheckcli", tool()));

  // 两个真正的 Node 进程各有独立 Promise 表，必须靠目录锁复用同一份母本。
  f.install(f.a, "2.0"); f.install(f.b, "2.0");
  const code = `import { seedCodecheckToolchain } from ${JSON.stringify(new URL("../src/codecheckToolchain.ts", import.meta.url).href)};
    await seedCodecheckToolchain(process.argv[1], process.argv[2]);`;
  const child = (repo: string) => new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.dataDir, repo], { stdio: ["ignore", "ignore", "pipe"] });
    t.after(() => { if (proc.exitCode === null) proc.kill(); });
    let stderr = "";
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.once("error", reject);
    proc.once("exit", status => status === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([child(f.a), child(f.b)]);
  assert.equal(codecheckToolchainStats(f.dataDir).masters, 2);
  assert.deepEqual(readdirSync(join(f.root, "product")), ["1.0", "2.0"]);
});

test("版本升级优先新版本；过期旧母本解链不影响在途任务，最新版本保留", async t => {
  const f = fixture(t); const old = f.install(f.a);
  await seedCodecheckToolchain(f.dataDir, f.a);
  f.install(f.a, "2.0"); await seedCodecheckToolchain(f.dataDir, f.a);
  assert.ok(existsSync(f.master()));
  await prepareCodecheckToolchain(f.dataDir, f.b);
  assert.equal(existsSync(join(f.b, ".codecheckcli", tool())), false);
  sameFile(join(f.b, ".codecheckcli", tool("2.0")), join(f.master("2.0"), "tree", tool("2.0")));
  age(f.master()); age(f.master("2.0"));
  assert.deepEqual(reclaimCodecheckToolchain(f.dataDir, { maxAgeMs: 1_000 }), { masters: 1, bytes: 6 });
  assert.equal(existsSync(f.master()), false);
  assert.ok(existsSync(f.master("2.0")));
  assert.equal(readFileSync(old, "utf8"), "binary");
  assert.equal(statSync(old).nlink, 1);
});

test("模拟跨盘 EXDEV：落母本和准备都回退复制，复制文件计入任务增量", async t => {
  const f = fixture(t); const original = f.install(f.a);
  const code = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    fs.linkSync = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    syncBuiltinESMExports();
    const { seedCodecheckToolchain, prepareCodecheckToolchain } = await import(${JSON.stringify(new URL("../src/codecheckToolchain.ts", import.meta.url).href)});
    await seedCodecheckToolchain(process.argv[1], process.argv[2]);
    await prepareCodecheckToolchain(process.argv[1], process.argv[3]);`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.dataDir, f.a, f.b], { stdio: ["ignore", "ignore", "pipe"] });
    t.after(() => { if (proc.exitCode === null) proc.kill(); });
    let stderr = ""; proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.once("error", reject);
    proc.once("exit", status => status === 0 ? resolve() : reject(new Error(stderr)));
  });
  const master = join(f.master(), "tree", tool()), prepared = join(f.b, ".codecheckcli", tool());
  assert.notEqual(statSync(original).ino, statSync(master).ino);
  assert.notEqual(statSync(prepared).ino, statSync(master).ino);
  assert.equal(readFileSync(prepared, "utf8"), "binary");
  assert.equal(statSync(prepared).mode & 0o777, 0o755);
  assert.deepEqual(codecheckToolchainStats(f.dataDir, f.b), { masters: 1, bytes: 6, taskBytes: 6, taskIncrementalBytes: 6 });
});

test("回收跳过持锁的旧母本，准备复用会刷新最近使用时间", async t => {
  const f = fixture(t); f.install(f.a); f.install(f.a, "2.0");
  await seedCodecheckToolchain(f.dataDir, f.a);
  age(f.master());
  mkdirSync(join(f.root, "product/.1.0.lock"));
  assert.equal(reclaimCodecheckToolchain(f.dataDir, { maxAgeMs: 1000 }).masters, 0);
  rmSync(join(f.root, "product/.1.0.lock"), { recursive: true });
  age(f.master("2.0"));
  await prepareCodecheckToolchain(f.dataDir, f.b);
  assert.ok(JSON.parse(readFileSync(join(f.master("2.0"), "manifest.json"), "utf8")).lastUsedAt > Date.now() - 1000);
});

test("已有任务文件不覆盖，独立副本按任务增量计；每个产品分别保留最新版本", async t => {
  const f = fixture(t); f.install(f.a); await seedCodecheckToolchain(f.dataDir, f.a);
  put(join(f.b, ".codecheckcli"), tool(), "task local");
  await prepareCodecheckToolchain(f.dataDir, f.b);
  assert.equal(readFileSync(join(f.b, ".codecheckcli", tool()), "utf8"), "task local");
  assert.equal(codecheckToolchainStats(f.dataDir, f.b).taskIncrementalBytes, 10);
  put(join(f.a, ".codecheckcli"), tool().replace("product", "other"), "other");
  await seedCodecheckToolchain(f.dataDir, f.a);
  age(f.master());
  assert.equal(reclaimCodecheckToolchain(f.dataDir, { maxAgeMs: 0 }).masters, 0);
  assert.equal(codecheckToolchainStats(f.dataDir).masters, 2);
});

test("任务工作区回收包含 .codecheckcli，删除任务引用后母本仍可复用", async t => {
  const f = fixture(t); mkdirSync(join(f.a, ".git")); f.install(f.a);
  await seedCodecheckToolchain(f.dataDir, f.a);
  await prepareCodecheckToolchain(f.dataDir, f.b);
  const masterFile = join(f.master(), "tree", tool());
  assert.equal(statSync(masterFile).nlink, 3);
  const result = reclaimWorkspace(join(f.dataDir, "task-a"), { cwd: f.a, dataDir: f.dataDir });
  assert.equal(result.refused, undefined);
  assert.equal(existsSync(join(f.a, ".codecheckcli")), false);
  assert.equal(readFileSync(masterFile, "utf8"), "binary");
  assert.equal(statSync(masterFile).nlink, 2);
  assert.equal(readFileSync(join(f.b, ".codecheckcli", tool()), "utf8"), "binary");
});

test("准备锁有等待预算；非法清单和任务软链接不会写到工作区外", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".bootstrap.lock"), { recursive: true });
  await assert.rejects(prepareCodecheckToolchain(f.dataDir, f.a, { lockTimeoutMs: 25 }), /超时/);
  rmSync(join(f.root, ".bootstrap.lock"), { recursive: true });
  f.install(f.a); await seedCodecheckToolchain(f.dataDir, f.a);
  const external = join(f.dataDir, "external"); mkdirSync(external);
  symlinkSync(external, join(f.b, ".codecheckcli"));
  await assert.rejects(prepareCodecheckToolchain(f.dataDir, f.b), /普通目录/);
  assert.deepEqual(readdirSync(external), []);
  const file = join(f.master(), "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.files[0].path = `${manifest.toolchainRoot}/../../../../escape`;
  writeFileSync(file, JSON.stringify(manifest));
  // 损坏清单只被跳过，不让所有任务失去去重能力；准备阶段不按清单写盘。
  const skipped = await prepareCodecheckToolchain(f.dataDir, f.a);
  skipped.release?.();
  assert.deepEqual(readdirSync(external), []);
  await seedCodecheckToolchain(f.dataDir, f.a);
  const rebuilt = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rebuilt.toolchainRoot, "home/product/tools/agent/1.0");
  assert.ok(existsSync(join(f.a, ".codecheckcli", tool())));
});

function prepushFixture(t: TestContext) {
  const f = fixture(t);
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const repo of [f.a, f.b]) {
    git(repo, "init", "-q", "-b", "main"); put(repo, "code.ts", "base");
    git(repo, "add", "code.ts"); git(repo, "commit", "-qm", "base");
  }
  const sourceRoot = join(f.dataDir, "skills");
  put(sourceRoot, "codecheck-prepush/SKILL.md", "---\nname: codecheck-prepush\ndescription: 检查\nknowledge_nature: engineering\ntechnologies: [agnostic]\n---\n检查代码\n");
  const options = (repo: string) => ({ repo, workspace: repo, recordRoot: join(f.dataDir, "records"), sourceRoot,
    moduleDataDir: f.dataDir, base: git(repo, "rev-parse", "HEAD") });
  return { ...f, options, git };
}

test("runCodecheckPrepush 两任务并发首次触发只下载一次；再次运行同仓复用预置工具链", async t => {
  const f = prepushFixture(t); let downloads = 0, calls = 0;
  const logs: string[] = [];
  const run = async ({ repo }: { repo: string }) => {
    calls++;
    if (!existsSync(join(repo, ".codecheckcli", tool()))) { downloads++; await delay(80); f.install(repo); }
    put(join(repo, ".codecheckcli"), "codecheck-result.json", "result");
    return "checked";
  };
  await Promise.all([f.a, f.b].map(repo => runCodecheckPrepush({ ...f.options(repo), run, log: message => logs.push(message) })));
  assert.equal(calls, 2); assert.equal(downloads, 1);
  sameFile(join(f.a, ".codecheckcli", tool()), join(f.b, ".codecheckcli", tool()));
  assert.ok(logs.some(message => /母本 1 份 \/ 6 字节/.test(message) && /增量/.test(message)));
  put(f.b, "code.ts", "changed"); f.git(f.b, "add", "code.ts"); f.git(f.b, "commit", "-qm", "change");
  await runCodecheckPrepush({ ...f.options(f.b), run });
  assert.equal(calls, 3); assert.equal(downloads, 1);
});

test("准备或落母本失败不改变 runner 结果；runner 失败释放首次锁、不保存母本", async t => {
  const f = prepushFixture(t); let calls = 0; const logs: string[] = [];
  const invalidData = put(f.dataDir, "not-a-directory");
  const result = await runCodecheckPrepush({ ...f.options(f.a), moduleDataDir: invalidData,
    log: message => logs.push(message), run: async () => { calls++; return "checked"; } });
  assert.equal(result.summary, "checked"); assert.equal(calls, 1);
  assert.ok(logs.some(message => message.includes("准备失败")));
  assert.ok(logs.some(message => message.includes("保存或统计失败")));
  await assert.rejects(runCodecheckPrepush({ ...f.options(f.b), run: async () => { f.install(f.b); throw new Error("runner failed"); } }), /runner failed/);
  assert.equal(existsSync(join(f.root, ".bootstrap.lock")), false);
  assert.equal(existsSync(join(f.master(), "manifest.json")), false);
  await runCodecheckPrepush({ ...f.options(f.b), run: async () => "recovered" });
  assert.ok(existsSync(join(f.master(), "manifest.json")));
});

test("缺 moduleDataDir 时 prepare/seed 完全 no-op", async t => {
  const f = fixture(t);
  assert.deepEqual(await prepareCodecheckToolchain(undefined, f.a), {});
  await seedCodecheckToolchain(undefined, f.a);
  assert.deepEqual(readdirSync(f.a), []);
  assert.equal(existsSync(f.root), false);
  assert.deepEqual(codecheckToolchainStats(f.dataDir), { masters: 0, bytes: 0, taskBytes: 0, taskIncrementalBytes: 0 });
});
