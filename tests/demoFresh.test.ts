/**
 * 演示模式不许静默删数据(用户实测踩的坑,2026-08-17):
 * 随手起个演示实例指到真数据目录,一条 await_merge 的真单当场蒸发——
 * 原实现每次启动 rmSync(dataDir),理由是"剧本假设新场"。
 *
 * 现在的契约:
 * - 默认沿用现有数据,并明说"要白纸起步加 --fresh";
 * - --fresh 才清,且清之前把要删掉的任务现场数出来告诉人;
 * - 真模型模式本来就不清(那条老规矩别被这次改动带坏)。
 *
 * 走真子进程:清场发生在启动早期,只有真跑一遍才算数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServe } from "./support/serveProcess.ts";

function boot(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawnServe(args);
    let output = "";
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const watch = (chunk: Buffer) => {
      output += chunk.toString();
      // 端口那行=启动完成,清场早就发生过了
      if (output.includes("http://127.0.0.1:")) stop();
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

/** 造一个"有真任务现场"的数据目录。 */
function seedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-fresh-"));
  const task = join(dir, "task-1");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.json"), JSON.stringify({
    summary: { id: "task-1", requirement: "别把我删了", status: "await_merge" },
  }));
  return dir;
}

test("演示模式默认不清场:既有任务现场必须还在", async () => {
  const dir = seedDataDir();
  const port = 18600 + Math.floor(Math.random() * 300);
  const output = await boot(["--data", dir, "--port", String(port)]);
  assert.ok(existsSync(join(dir, "task-1", "task.json")),
    `演示模式把既有任务删了,输出:\n${output.slice(0, 800)}`);
  assert.match(output, /沿用现有数据/, "沿用了就要说一声,别让人猜");
});

test("--fresh 才清场,并且把要删的数量说出来", async () => {
  const dir = seedDataDir();
  const port = 18900 + Math.floor(Math.random() * 300);
  const output = await boot(
    ["--data", dir, "--port", String(port), "--fresh"]);
  assert.ok(!existsSync(join(dir, "task-1")), "--fresh 应当真清");
  assert.match(output, /清空数据目录/);
  assert.match(output, /1 个任务现场/, "删几个要数出来给人看");
});
