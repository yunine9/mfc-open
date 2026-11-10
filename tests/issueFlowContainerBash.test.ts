/**
 * 容器内超时收窄(2026-09-04)的契约测试:
 * - wrapShellLineWithTimeout/backstopTimeoutSeconds 的形状(ops 与 AI
 *   bash 共用的机制本体,src/containerTimeout.ts);
 * - AI bash 适配(issueFlow/containerBash.ts):包装+兜底余量+124 说明、
 *   无 timeout 透传、容器缺席拒绝。
 *
 * 范式提醒:这里钉的是"超时不再连坐容器"的机械事实——exec 收到的
 * timeout 必须赛输容器内 timeout(否则退化回销毁语义),124 必须带
 * 给模型一行可行动的说明。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskContainer } from "../src/containerRuntime.ts";
import {
  backstopTimeoutSeconds,
  shellQuote,
  wrapShellLineWithTimeout,
} from "../src/containerTimeout.ts";
import { createContainerBashOperations } from "../src/issueFlow/containerBash.ts";

test("容器内超时拼装:shell 行包装/引号转义/兜底余量", () => {
  assert.equal(
    wrapShellLineWithTimeout("cd repo && npm install 2>&1 | tail -25", 300),
    "timeout --kill-after=30 300 sh -c "
      + `'cd repo && npm install 2>&1 | tail -25'`,
    "shell 行整体进内层 sh -c(timeout 不解析 shell,必须再包一层)",
  );
  assert.equal(
    wrapShellLineWithTimeout("echo 'it' > f", 5),
    `timeout --kill-after=30 5 sh -c 'echo '\\''it'\\'' > f'`,
    "单引号按 shell 纪律转义",
  );
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(
    backstopTimeoutSeconds(300), 360,
    "兜底必须赛输容器内 timeout(命令预算+余量)",
  );
});

interface ExecCall {
  command: string;
  dir: string;
  options: {
    onData: (data: Buffer) => void;
    timeout?: number;
    signal?: AbortSignal;
  };
}

function fakeContainer(
  result: { exitCode: number | null },
  calls: ExecCall[],
): TaskContainer {
  return {
    exec: (command: string, dir: string, options: ExecCall["options"]) => {
      calls.push({ command, dir, options });
      return Promise.resolve(result);
    },
  } as unknown as TaskContainer;
}

test("AI bash 适配:超时命令包进容器内 timeout,124 附可行动说明", async () => {
  const calls: ExecCall[] = [];
  const container = fakeContainer({ exitCode: 124 }, calls);
  const ops = createContainerBashOperations(() => container);
  let output = "";
  const result = await ops.exec("npm install", "/ws", {
    onData: (data) => { output += data.toString("utf-8"); },
    timeout: 300,
  });
  assert.equal(result.exitCode, 124, "结果原样透传给 Pi(非异常)");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].command,
    wrapShellLineWithTimeout("npm install", 300),
    "发给容器的是包装后的命令",
  );
  assert.equal(
    calls[0].options.timeout, 360,
    "exec 兜底超时=预算+余量,必须赛输容器内 timeout",
  );
  assert.match(output, /容器内 timeout/);
  assert.match(output, /会话容器不受影响/);
  assert.match(output, /更大的 timeout 参数/, "说明必须可行动");
});

test("AI bash 适配:非 124 与无 timeout 都不包装不插话", async () => {
  const calls: ExecCall[] = [];
  const container = fakeContainer({ exitCode: 0 }, calls);
  const ops = createContainerBashOperations(() => container);
  let output = "";
  const ok = await ops.exec("ls -la", "/ws", {
    onData: (data) => { output += data.toString("utf-8"); },
    timeout: 30,
  });
  assert.equal(ok.exitCode, 0);
  assert.equal(calls[0].command, wrapShellLineWithTimeout("ls -la", 30),
    "正常完成也走包装(超时保险对每条命令一致)");
  assert.equal(output, "", "非超时完成不插说明");

  const plain: ExecCall[] = [];
  const bare = fakeContainer({ exitCode: 3 }, plain);
  const ops2 = createContainerBashOperations(() => bare);
  let output2 = "";
  const raw = await ops2.exec("grep -r foo .", "/ws", {
    onData: (data) => { output2 += data.toString("utf-8"); },
  });
  assert.equal(raw.exitCode, 3);
  assert.equal(plain[0].command, "grep -r foo .",
    "模型没传 timeout 时命令原样透传(现状行为不变)");
  assert.equal(plain[0].options.timeout, undefined);
  assert.equal(output2, "");
});

test("AI bash 适配:容器不在场拒绝执行", () => {
  const ops = createContainerBashOperations(() => undefined);
  assert.throws(
    () => ops.exec("ls", "/ws", { onData: () => {} }),
    /会话容器不在场/,
  );
});

test("AI bash 适配:预热会话剥离 AbortSignal,系统 abort 不连坐容器", async () => {
  const calls: ExecCall[] = [];
  const container = fakeContainer({ exitCode: 0 }, calls);
  const ops = createContainerBashOperations(() => container,
    { forwardAbort: false });
  const controller = new AbortController();
  controller.abort();
  await ops.exec("mvn compile", "/ws", {
    onData: () => {},
    signal: controller.signal,
  });
  assert.equal(calls[0].options.signal, undefined,
    "预热预算到点的 abort 是系统发起,signal 不得进容器(否则按 Abort "
      + "语义销毁与主会话共享的容器,把焐热的缓存连坐清掉)");
  // 主会话缺省转发,用户打断语义不变。
  const mainCalls: ExecCall[] = [];
  const mainOps = createContainerBashOperations(
    () => fakeContainer({ exitCode: 0 }, mainCalls));
  await mainOps.exec("ls", "/ws", {
    onData: () => {}, signal: controller.signal,
  });
  assert.ok(mainCalls[0].options.signal?.aborted,
    "缺省转发 signal:用户主动打断仍走既有 Abort 语义");
});
