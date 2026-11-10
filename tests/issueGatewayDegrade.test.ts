/**
 * 问题流的 DTS/MCP 网关配置坏了,不许连累需求流。
 *
 * 红线依据:旁路一律 fail-open。DTS 网关对需求流程是彻头彻尾的旁路——
 * 它坏了,需求任务照样该下单、该跑、该交付。
 *
 * 2026-08-29 实测踩过:mcp-token 缺省会自动装载 /etc/mae-flow-cloud/
 * mcp-token,一个空文件就 process.exit(2) 把整台机器(含需求流)挡在
 * 启动线外——而没有任何人点过「问题处理」。
 *
 * 反过来 --issue-only 下问题处理就是全部业务,配置坏了必须当场拒启:
 * 那时候降级"照常起服"才是骗人(起来了但什么也干不了)。
 *
 * 走真子进程:配置在模块加载期读 argv,单测改 argv 测不到真路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServe } from "./support/serveProcess.ts";

function run(
  args: string[],
  probe: (line: string) => boolean,
  timeoutMs = 40_000,
): Promise<{ code: number | null; output: string; matched: boolean }> {
  return new Promise((resolve) => {
    const child = spawnServe(args);
    let output = "";
    let matched = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const watch = (chunk: Buffer) => {
      output += chunk.toString();
      if (!matched && output.split("\n").some(probe)) {
        matched = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, matched });
    });
  });
}

/** 空 token 文件 = 最容易发生的那种坏配置(touch 出来的占位、写失败)。 */
function emptyTokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-mcp-token-"));
  const path = join(dir, "mcp-token");
  writeFileSync(path, "   \n");
  return path;
}

/** 显式空配置:裸跑 serve 会读本机 /etc/mae-flow-cloud/serve.json 进
 * 机器调试形态(2026-10-21 实测;AGENTS.md 界面纪律同款要求)。 */
function hermeticConfig(): string {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-serve-config-")), "serve.json");
  writeFileSync(path, "{}");
  return path;
}

test("MCP token 坏了:完整部署照常起服,需求流程不受影响", async () => {
  const token = emptyTokenFile();
  const data = mkdtempSync(join(tmpdir(), "mfc-mcp-degrade-"));
  // 探针钉的是"服务真的听上了端口"——不是"没报错"。降级必须是起得来,
  // 不是安静地死。
  const { output, matched } = await run(
    ["--config", hermeticConfig(), "--data", data, "--port", "0", "--mcp-token-file", token],
    (line) => line.includes("[serve] http://"),
  );
  assert.ok(matched, `问题流 token 坏了不该挡住起服;实际输出:\n${output}`);
  // 而且必须大声记账:静默降级 = 你以为接了 DTS,其实没接。
  assert.match(output, /MCP token 读取失败/);
  assert.match(output, /本次不接 DTS 网关/);
  assert.match(output, /需求流程不受影响/);
});

test("MCP token 坏了:--issue-only 下问题处理是全部业务,当场拒启", async () => {
  const token = emptyTokenFile();
  const data = mkdtempSync(join(tmpdir(), "mfc-mcp-issueonly-"));
  const { code, output } = await run(
    ["--config", hermeticConfig(), "--data", data, "--port", "0", "--issue-only", "--mcp-token-file", token],
    () => false,
    25_000,
  );
  assert.notEqual(code, 0, `--issue-only 下坏 token 必须非零退出:\n${output}`);
  assert.match(output, /拒绝启动/);
});
