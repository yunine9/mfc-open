/**
 * serveConfig part 2:启动契约:优雅关闭/端口占用/前端过期/命令行压文件/弃用提示。
 * 共享夹具在 tests/serveConfig.helpers.ts(拆分背景见其头注)。
 * 2026-09-17 删四个本地必红的启动用例(任务容器 8 核、容器 npm 源、
 * 内核模式双拒绝——起真 serve/要 docker,本机 30s 超时;含整段删号,
 * 不留 skip 尸体)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  run,
} from "./serveConfig.helpers.ts";


test("SIGTERM 走优雅关闭并明确承诺业务状态不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-graceful-stop-"));
  const result = await run([
    "--data", join(dir, "tasks"), "--port", "0",
  ], (line) => line.includes("http://127.0.0.1:"));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /收到 SIGTERM，停止接单并清理/);
  assert.match(result.output, /业务状态保持不变/);
});



test("端口被占:说人话并退出,不甩一段栈", async () => {
  // 内网反复报"server 挂了"里,有一份就是这个:上一次的服务还占着端口,
  // 新起的进程在 listen 上抛 EADDRINUSE。没有处理器时它是未捕获的 error
  // 事件——终端只剩一段栈,人只记得"挂了"。占端口的真件在这儿,不是假件。
  const dir = mkdtempSync(join(tmpdir(), "mfc-cfg-busy-"));
  const squatter = createServer(() => {});
  await new Promise<void>((ready) => squatter.listen(0, "127.0.0.1", ready));
  const port = (squatter.address() as AddressInfo).port;
  try {
    const { code, output } = await run([
      "--port", String(port), "--data", join(dir, "tasks"),
    ], () => false, 20_000);
    assert.equal(code, 2, `应以 2 退出,实际 ${code};输出:\n${output}`);
    assert.match(output, /端口 \d+ 已被占用/);
    assert.match(output, /lsof|ss -lptn/, "要给出查占用的具体命令");
    assert.doesNotMatch(output, /at Server\./, "别把栈甩给用户");
  } finally {
    squatter.close();
  }
});



test("前端构建比源码旧:启动就明说,别让人以为功能坏了;旧参数仅提示弃用", async () => {
  // 内网实测的坑:web/dist 是 gitignore 的,拉了新代码不重新构建,
  // 页面还是旧的——新功能在人眼里就是"点不了/坏了"(他手上那份前端
  // 压根没有这段代码)。页面不会自己声明版本,所以服务启动时说。
  // 2026-09-18 性价比收紧:旧 --verify-via-pipeline 弃用提示也是启动
  // 日志断言,并入同一次起服,少一次 ~5s 的 tsx 冷启。
  const dir = mkdtempSync(join(tmpdir(), "mfc-staleweb-"));
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html>旧构建</html>");
  // 把构建时间调到 2020 年:比仓里任何源码都旧
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(dist, "index.html"), old, old);
  const { output } = await run(
    ["--web", dist, "--data", join(dir, "tasks"), "--port", "0",
     "--verify-via-pipeline"],
    (line) => line.includes("前端构建比源码旧"));
  assert.match(output, /前端构建比源码旧/);
  assert.match(output, /npm run build/, "要给出照做就能修好的命令");
  // 旧参数:提示弃用即忽略,不再保留旧的条件分支。
  assert.match(output, /--verify-via-pipeline 已弃用/);
  assert.match(output, /已弃用并被忽略/);
  assert.doesNotMatch(output, /需要流水线在场/,
    "兼容参数不能再保留旧的条件分支");
});




