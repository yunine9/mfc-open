import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRASH_LOG_MAX_BYTES } from "../src/processGuard.ts";

const guardUrl = new URL("../src/processGuard.ts", import.meta.url).href;
const outputUrl = new URL("../src/processOutput.ts", import.meta.url).href;
async function childRun(source: string, closePipes = false) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", b => { diagnostics = (diagnostics + b).slice(-4000); });
  child.stdout?.resume();
  child.on("message", message => {
    if (message === "ready") {
      if (closePipes) { child.stdout?.destroy(); child.stderr?.destroy(); }
      child.send("go");
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, `child did not finish cleanly: ${diagnostics}`);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}

test("真实关闭 stdout/stderr 后，异常处理不会自激刷盘，进程继续响应", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-broken-output-"));
  try {
    await childRun(`
      import assert from 'node:assert/strict';
      import { guardProcess } from ${JSON.stringify(guardUrl)};
      import { muzzleBrokenPipes } from ${JSON.stringify(outputUrl)};
      const temporary = () => {};
      process.stderr.on('error', temporary);
      const count = process.stderr.listenerCount('error');
      muzzleBrokenPipes(); muzzleBrokenPipes();
      assert.equal(process.stderr.listenerCount('error'), count + 1);
      process.stderr.removeListener('error', temporary);
      guardProcess(${JSON.stringify(dir)});
      process.once('message', () => {
        for (let i = 0; i < 1000; i++) { console.log('output'); console.error('output'); }
        setImmediate(() => { throw new Error('real uncaught error'); });
        Promise.reject(new Error('real rejection'));
        setTimeout(() => process.exit(0), 200);
      });
      process.send('ready');
    `, true);
    const log = readFileSync(join(dir, "crash.log"), "utf8");
    assert.match(log, /real uncaught error/);
    assert.match(log, /real rejection/);
    assert.ok(Buffer.byteLength(log) < 10_000);
    assert.ok(!log.includes("EPIPE"), "断管道不能进入崩溃递归");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("重复异常合并，超大历史日志与后续日志轮转总量不超过 10 MiB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-bounded-crash-"));
  try {
    const path = join(dir, "crash.log");
    writeFileSync(path, "old evidence\n");
    truncateSync(path, 100 * 1024 * 1024); // Sparse legacy oversized file.
    await childRun(`
      import assert from 'node:assert/strict';
      import { statSync } from 'node:fs';
      import { createCrashRecorder } from ${JSON.stringify(guardUrl)};
      const record = createCrashRecorder(${JSON.stringify(dir)});
      const repeated = new Error('repeat');
      record('error', repeated);
      const size = statSync(${JSON.stringify(path)}).size;
      for (let i = 0; i < 10000; i++) record('error', repeated);
      assert.equal(statSync(${JSON.stringify(path)}).size, size);
      for (let i = 0; i < 210; i++) record('error', i + ':' + 'x'.repeat(100000));
    `);
    assert.deepEqual(readdirSync(dir).sort(), ["crash.log", "crash.log.1"]);
    for (const name of readdirSync(dir)) assert.ok(statSync(join(dir, name)).size <= CRASH_LOG_MAX_BYTES);
    assert.match(readFileSync(path, "utf8"), /209:/, "最新异常保留");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("日志目录不可写或错误对象自身出错，不再抛出二次异常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-crash-unwritable-"));
  try {
    const file = join(dir, "file"); writeFileSync(file, "not a directory");
    await childRun(`
      import { createCrashRecorder } from ${JSON.stringify(guardUrl)};
      const record = createCrashRecorder(${JSON.stringify(file)});
      record('error', new Error('still alive'));
      record('error', {toString() {throw new Error('bad error object');}});
      record('error', new Error('also alive'));
    `);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
