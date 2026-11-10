/**
 * serveConfig 拆分后的共享夹具与辅助函数(原 tests/serveConfig.test.ts 逐字搬移;
 * 2026-09-11 负载均衡拆分——node:test 按文件并行、文件内串行,60s+ 的
 * 单文件拖累全量墙钟)。不带 .test.ts 后缀,测试运行器不会执行本文件;
 * 各 part 按需 import,断言与测试行为零变化。
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
/**
 * 配置文件契约(--config):
 * - 文件坏了拒绝启动,不静默忽略——带着一半配置起服比不起服更害人
 *   (你以为切了真件,其实还在假件上);
 * - 文件供值、命令行压过文件——排障时临时改参数不必动文件。
 *
 * 走真子进程:CONFIG 在模块加载期读 argv,单测里改 argv 测不到真路径。
 */



export function run(
  args: string[],
  probe: (line: string) => boolean,
  timeoutMs = 30_000,
): Promise<{ code: number | null; output: string; matched: boolean }> {
  return new Promise((resolve) => {
    const child = spawnServe(args);
    let output = "";
    let matched = false;
    const finish = (code: number | null) =>
      resolve({ code, output, matched });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const watch = (chunk: Buffer) => {
      output += chunk.toString();
      if (!matched && output.split("\n").some(probe)) {
        matched = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        // 命中即收:等子进程退出由 close 收口
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}
