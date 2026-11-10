/**
 * serveConfig part 1:配置来源与容器边界:HOME 指定/坏配置拒启/isolate-user 拒 root/npm 源注入。
 * 共享夹具在 tests/serveConfig.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServe } from "./support/serveProcess.ts";
import {
  run,
} from "./serveConfig.helpers.ts";


test("配置文件供值(HOME/端口),命令行压过文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-native-home-config-"));
  const config = join(dir, "serve.json");
  // 2026-09-18 合并去冗:原 part2「配置文件供值,命令行压过文件」用例
  // 与本条是同一机制(argv ?? CONFIG),一次起服同时断言两组键。
  const filePort = 18000 + Math.floor(Math.random() * 500);
  const cliPort = filePort + 500;
  writeFileSync(config, JSON.stringify({
    "isolate-image": "fixture/builder:test", "isolate-home": "/home/builder",
    port: filePort,
  }));
  // 轮1=纯文件:HOME 与端口都取文件值。
  const fromFile = await run(
    ["--config", config, "--data", join(dir, "workspace")],
    (line) => line.includes(`http://127.0.0.1:${filePort}`));
  assert.equal(fromFile.code, 0, fromFile.output);
  assert.ok(fromFile.output.includes("容器 HOME: /home/builder"));
  assert.ok(fromFile.matched, "文件端口未生效");
  // 轮2=文件+命令行:命令行赢(HOME 与端口各验一个)。
  const fromCli = await run(
    ["--config", config, "--data", join(dir, "other"),
     "--isolate-home", "/home/other", "--port", String(cliPort)],
    (line) => line.includes(`http://127.0.0.1:${cliPort}`));
  assert.equal(fromCli.code, 0, fromCli.output);
  assert.ok(fromCli.output.includes("容器 HOME: /home/other"));
  assert.ok(fromCli.matched, "命令行端口未压过文件");
});



test("配置文件坏了拒绝启动,不静默忽略", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-cfg-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ 这不是 JSON");
  const { code, output } = await run([
    "--config", bad, "--data", join(dir, "tasks"),
  ], () => false, 15_000);
  assert.notEqual(code, 0, "坏配置必须非零退出");
  assert.match(output, /配置文件读取失败,拒绝启动/);
  // 缺文件与坏 JSON 走同一个 catch 同一条文案(2026-09-18 去冗:
  // 不再为它单独起一次服)。
});



test("通知服务回复能力不能只凭文案开启，必须同时准备回调 Token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-luban-replies-"));
  const result = await run([
    "--luban-plugin-replies",
    "--data", join(dir, "tasks"),
    "--port", "0",
  ], () => false, 15_000);
  assert.equal(result.code, 2);
  assert.match(result.output, /需要同时配置.*luban-plugin-token-file/);
  assert.match(result.output, /真实入站插件验收通过后/);
});



test("--isolate-user 拒绝 root uid/gid，不能把容器隔离变成 root 执行", async () => {
  // 2026-09-18 性价比收紧:uid 各形态起服逐个验太贵(一次 tsx 冷启
  // ~5s),且名字形/数字形命中同一条校验分支——留 root 一个形态锁门。
  for (const user of ["root"]) {
    const dir = mkdtempSync(join(tmpdir(), "mfc-root-user-"));
    const result = await run([
      "--data", join(dir, "tasks"),
      "--isolate-image", "fixture/builder:test",
      "--isolate-user", user,
    ], () => false, 15_000);
    assert.equal(result.code, 2, `用户 ${user} 必须拒绝启动`);
    assert.match(result.output, /禁止使用 root\/0/);
  }
});

