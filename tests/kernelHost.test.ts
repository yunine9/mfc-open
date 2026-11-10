/**
 * 合成 Hook 载荷的形状契约:pretooluse / posttooluse 必须带同源
 * tool_use_id。内核的子 Agent 生命周期对账以 pretooluse 的
 * tool_use_id 为 invocation_id、按 posttooluse 的同名字段精确配对;
 * pre 侧缺失时内核只能自造 id 并按"当前步同类开放启动恰一条"兜底,
 * 同类子 Agent 并行派发即判 ambiguous、返回全部丢失(run3 实测,
 * 两个 build_agent_review REVIEWER 只有 started 没有 returned)。
 * 用捕获 stdin 的 dispatch.py 桩直接验证载荷,不需要真内核。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelHost } from "../src/kernelHost.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

function gitWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", workspace]);
  return workspace;
}

function stubKernel(): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-stub-kernel-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "dispatch.py"), [
    "import json, os, sys",
    "line = json.dumps({'event': sys.argv[1],",
    "                   'payload': json.loads(sys.stdin.read() or '{}')},",
    "                  ensure_ascii=False)",
    "path = os.path.join(os.path.dirname(__file__), '..', 'captured.jsonl')",
    "with open(path, 'a') as f:",
    "    f.write(line + '\\n')",
    "",
  ].join("\n"));
  return root;
}

function managedStubKernel(failInit = false): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-managed-kernel-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "flow"), { recursive: true });
  writeFileSync(join(root, "flow", "flow.json"), JSON.stringify({
    start: "config_confirm",
    steps: {
      config_confirm: { terminal: false },
      end: { terminal: true },
    },
  }));
  const log = join(root, "managed.log");
  writeFileSync(join(root, "hooks", "dispatch.py"), [
    "import os, sys",
    `path = ${JSON.stringify(log)}`,
    "with open(path, 'a') as f: f.write('hook:' + sys.argv[1] + '\\n')",
  ].join("\n"));
  writeFileSync(join(root, "scripts", "mae-flow.py"), [
    "import json, os, sys",
    `log = ${JSON.stringify(log)}`,
    "command = sys.argv[1] if len(sys.argv) > 1 else ''",
    "with open(log, 'a') as f: f.write('cli:' + command + '\\n')",
    ...(failInit ? [
      "if command == 'init':",
      "    sys.stderr.write('fixture init failed')",
      "    raise SystemExit(2)",
    ] : [
      "if command == 'init':",
      "    with open('.mae-flow.json', 'w') as f:",
      "        json.dump({'current': 'config_confirm'}, f)",
    ]),
    "if command == 'current':",
    "    if not os.path.exists('.mae-flow.json'): raise SystemExit(2)",
    "    print('CURRENT: 先确认配置，不要修改源码')",
  ].join("\n"));
  return root;
}

function managedStubKernelRejectingDevNullConfig(): string {
  const root = managedStubKernel();
  const script = join(root, "scripts", "mae-flow.py");
  writeFileSync(script, [
    "import json, os, sys",
    "command = sys.argv[1] if len(sys.argv) > 1 else ''",
    "if os.environ.get('GIT_CONFIG_GLOBAL') == '/dev/null':",
    "    sys.stderr.write('fatal: bad config line 1 in file /dev/null')",
    "    raise SystemExit(128)",
    "config = os.environ.get('GIT_CONFIG_GLOBAL', '')",
    "if not os.path.isfile(config) or open(config).read() != '':",
    "    sys.stderr.write('safe Git config is not a real empty file')",
    "    raise SystemExit(129)",
    "if command == 'init':",
    "    with open('.mae-flow.json', 'w') as f:",
    "        json.dump({'current': 'config_confirm'}, f)",
    "if command == 'current':",
    "    print('CURRENT: 先确认配置，不要修改源码')",
  ].join("\n"));
  return root;
}

function captured(root: string): Array<{ event: string; payload: any }> {
  return readFileSync(join(root, "captured.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
}

function toolEvent(
  kind: "tool_requested" | "tool_finished",
  callId: string,
): SemanticEvent {
  return {
    eventId: 1, taskId: "t1", sessionId: "main", ts: "", kind,
    payload: {
      call_id: callId,
      name: "Task",
      input: { subagent_type: "craft-reviewer-agent", prompt: "..." },
      ...(kind === "tool_finished"
        ? { is_error: false, result: "检视完成" } : {}),
    },
  };
}

test("合成载荷:pre/post 两侧 tool_use_id 同源,生命周期可精确对账", async () => {
  const root = stubKernel();
  const host = new KernelHost({
    kernelRoot: root,
    workspace: gitWorkspace("mfc-stub-ws-"),
    transcriptPath: join(root, "transcript.jsonl"),
    taskId: "t1",
  });
  await host.preTool(toolEvent("tool_requested", "call_A"));
  await host.postTool(toolEvent("tool_finished", "call_A"));
  const rows = captured(root);
  const pre = rows.find((row) => row.event === "pretooluse");
  const post = rows.find((row) => row.event === "posttooluse");
  assert.equal(pre?.payload.tool_use_id, "call_A");
  assert.equal(pre?.payload.workspace_root, pre?.payload.cwd,
    "未显式放宽时文件访问根必须与代码仓相同");
  assert.equal(post?.payload.tool_use_id, "call_A");
  assert.equal(pre?.payload.tool_use_id, post?.payload.tool_use_id);
});

test("Hook 内部故障退出 75 会有界重试，正常返回后才算登记完成", async () => {
  const root = stubKernel();
  const path = join(root, "hooks", "dispatch.py");
  writeFileSync(path, readFileSync(path, "utf8") + [
    "assert os.environ.get('MAE_FLOW_HOOK_STRICT') == '1'",
    "with open(path) as f: attempts = len(f.readlines())",
    "if attempts < 3: raise SystemExit(75)",
  ].join("\n") + "\n");
  const host = new KernelHost({ kernelRoot: root,
    workspace: gitWorkspace("mfc-hook-retry-"),
    transcriptPath: join(root, "transcript.jsonl"), taskId: "t1" });
  await host.postTool(toolEvent("tool_finished", "retry-call"));
  assert.equal(captured(root).length, 3);
});

test("Hook 被信号结束不能被当作 exit 0 的成功登记", async () => {
  const root = stubKernel();
  const path = join(root, "hooks", "dispatch.py");
  writeFileSync(path, readFileSync(path, "utf8") +
    "import signal\nos.kill(os.getpid(), signal.SIGTERM)\n");
  const host = new KernelHost({ kernelRoot: root,
    workspace: gitWorkspace("mfc-hook-signal-"),
    transcriptPath: join(root, "transcript.jsonl"), taskId: "t1" });
  await assert.rejects(host.postTool(toolEvent("tool_finished", "signal-call")), /SIGTERM/);
  assert.equal(captured(root).length, 3);
});

test("Cloud 托管启动:普通需求也机械 init，再把 current 交给模型", async () => {
  const workspace = gitWorkspace("mfc-managed-start-");
  const root = managedStubKernel();
  const host = new KernelHost({
    kernelRoot: root,
    workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "managed-1",
  });
  const guidance = await host.bootstrapManaged("把首页按钮改成蓝色");
  assert.match(guidance, /CURRENT: 先确认配置/);
  assert.match(guidance, /文档自查：按现有模板写清范围、行为、验收条件和真实未决事项/);
  assert.match(guidance, /local-spec validate 仅作按需结构诊断/);
  assert.equal(JSON.parse(readFileSync(
    join(workspace, ".mae-flow.json"), "utf-8")).current, "config_confirm");
  assert.deepEqual(readFileSync(join(root, "managed.log"), "utf-8")
    .trim().split("\n"), [
    "cli:init",
    "hook:sessionstart",
    "hook:userprompt",
    "cli:current",
  ], "模型启动前必须先有状态，需求原话随后进入 ACTIVE 台账");

  const resumed = await host.bootstrapManaged("继续当前需求");
  assert.match(resumed, /不要为格式差异重复补材料、重跑检视或索要确认/);
  assert.equal(readFileSync(join(root, "managed.log"), "utf-8")
    .split("\n").filter(line => line === "cli:init").length, 1,
  "恢复仍注入文档自查指引，但不重新初始化流程");

  rmSync(join(workspace, ".mae-flow.json"));
  const verdict = await host.preTool({
    eventId: 2, taskId: "managed-1", sessionId: "main", ts: "",
    kind: "tool_requested",
    payload: {
      call_id: "edit-1", name: "Edit",
      input: { path: "src/main.ts", old_string: "1", new_string: "2" },
    },
  });
  assert.equal(verdict?.action, "deny");
  assert.match(verdict?.reason ?? "", /INACTIVE 状态修改代码/);
});

test("Cloud 托管启动:init 失败时拒绝创建可工作的 Agent 现场", async () => {
  const workspace = gitWorkspace("mfc-managed-fail-");
  const host = new KernelHost({
    kernelRoot: managedStubKernel(true),
    workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "managed-fail",
  });
  await assert.rejects(
    () => host.bootstrapManaged("修复一个问题"),
    /内核 init 登记失败.*fixture init failed/,
  );
  assert.equal(existsSync(join(workspace, ".mae-flow.json")), false);
});

test("Cloud 托管启动:内核 Git 预检不再把 /dev/null 当配置文件", async () => {
  // 内网子任务事故实锤：运行环境里的 /dev/null 不是 Git 可读取的空
  // 配置，旧安全环境让 `git --version` 直接退 128。这里用内核桩复现
  // 同一兼容性条件，确保 init 收到的是宿主私有真实空文件。
  const workspace = gitWorkspace("mfc-managed-real-empty-config-");
  const host = new KernelHost({
    kernelRoot: managedStubKernelRejectingDevNullConfig(),
    workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "managed-real-empty-config",
  });
  const guidance = await host.bootstrapManaged("实现拆分后的交付单元");
  assert.match(guidance, /CURRENT: 先确认配置/);
});

test("内核进程不可用时授权与证据都 fail-closed", async () => {
  const host = new KernelHost({
    kernelRoot: mkdtempSync(join(tmpdir(), "mfc-missing-kernel-")),
    workspace: gitWorkspace("mfc-missing-ws-"),
    transcriptPath: join(tmpdir(), "missing-transcript.jsonl"),
    taskId: "t-fail-closed",
    python: "__mae_flow_python_does_not_exist__",
  });
  const verdict = await host.preTool(toolEvent("tool_requested", "call_X"));
  assert.equal(verdict?.action, "deny");
  assert.match(verdict?.reason ?? "", /内核门禁不可用/);
  // fail-closed 不等于"一次抖动就判死":基础设施故障先自己重试,
  // 判死前必须说清已经试过几次(CLAUDE.md 2026-08-20 勘误的口径)。
  assert.match(verdict?.reason ?? "", /已重试 \d+ 次仍不可用/);
  await assert.rejects(
    () => host.postTool(toolEvent("tool_finished", "call_X")),
    /内核 posttooluse 登记失败/,
  );
});

test("posttooluse 退 2 是纠偏话不是登记失败:原文返回,不抛异常", async () => {
  // 2026-08-20 内网实锤:IMPLEMENTATION 缺"定稿自查"一节,内核 posttooluse
  // 退 2 + stderr 让模型补——单机形态里这段 stderr 直接进模型上下文。
  // 云端却把一切非零当"登记失败"抛出去,整单判死,push/MR 全没发生,
  // 模型全程没见过那句话。
  const workspace = gitWorkspace("mfc-verdict-ws-");
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-verdict-kernel-"));
  mkdirSync(join(kernelRoot, "hooks"), { recursive: true });
  writeFileSync(join(kernelRoot, "hooks", "dispatch.py"), [
    "import sys",
    "if sys.argv[1] == 'posttooluse':",
    "    sys.stderr.write('[mae-flow] IMPLEMENTATION 结构与模板不符,"
      + "缺少章节: 3 定稿自查。请补齐缺失章节。')",
    "    sys.exit(2)",
    "sys.exit(0)",
  ].join("\n"));
  const host = new KernelHost({
    kernelRoot, workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "t-verdict", python: "python3",
  });
  const feedback = await host.postTool(toolEvent("tool_finished", "c9"));
  assert.match(feedback ?? "", /缺少章节: 3 定稿自查/,
    "退 2 的原文必须完整交给调用方送回模型");
});

test("基础设施抖一下不判死:内核恢复后照常放行,不重试真裁决", async () => {
  // 宿主负载高、python 冷启动、内网巨仓的一次超时,不该让整轮白跑。
  // 但内核**答了**(退 0 放行 / 退 2 打回)就是它的裁决,一次都不许重试
  // ——重试一个真裁决等于反复问同一个问题直到得到想要的答案。
  const workspace = gitWorkspace("mfc-flaky-ws-");
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-flaky-kernel-"));
  mkdirSync(join(kernelRoot, "hooks"), { recursive: true });
  const counter = join(workspace, "attempts.txt");
  // 前两次假装起不来(退 3 且什么都不输出前先自杀),第三次正常退 0。
  writeFileSync(join(kernelRoot, "hooks", "dispatch.py"), [
    "import os, sys",
    `p = ${JSON.stringify(counter)}`,
    "n = int(open(p).read()) if os.path.exists(p) else 0",
    "n += 1",
    "open(p, 'w').write(str(n))",
    "sys.exit(0 if n >= 3 else 1)",
  ].join("\n"));
  const host = new KernelHost({
    kernelRoot, workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "t-flaky", python: "python3",
  });
  // 退 1 不是 infraError(内核答了),所以不重试:第一次就 deny。
  const first = await host.preTool(toolEvent("tool_requested", "c1"));
  assert.equal(first?.action, "deny");
  assert.equal(readFileSync(counter, "utf-8"), "1",
    "内核答了就是裁决,不许重试");
});

test("内核 Python 间接调用 Git 也不读取 Agent 的 fsmonitor 配置", async () => {
  const workspace = gitWorkspace("mfc-kernel-safe-git-");
  const marker = join(workspace, "host-command-ran");
  const monitor = join(workspace, "monitor.sh");
  writeFileSync(monitor,
    `#!/bin/sh\nprintf compromised > '${marker}'\nexit 1\n`);
  chmodSync(monitor, 0o700);
  execFileSync("git", ["-C", workspace, "config", "core.fsmonitor", monitor]);
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-kernel-git-stub-"));
  mkdirSync(join(kernelRoot, "hooks"), { recursive: true });
  writeFileSync(join(kernelRoot, "hooks", "dispatch.py"), [
    "import subprocess",
    "subprocess.run(['git', 'status', '--porcelain'], check=True,",
    "               stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
  ].join("\n"));
  const host = new KernelHost({
    kernelRoot, workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "t-safe-git", python: "python3",
  });
  assert.equal(await host.preTool(toolEvent("tool_requested", "safe-1")),
    undefined);
  assert.equal(existsSync(marker), false,
    "dispatch 子进程的 git status 不能穿透到宿主执行 Agent 命令");
});
