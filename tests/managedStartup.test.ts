/**
 * Cloud 托管启动红线：模型第一条工具调用之前，宿主必须已经完成
 * Mae-Flow init/current。需求文案是否含“交付/开发/修改”不得影响它。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "managed-startup-test",
  GIT_AUTHOR_EMAIL: "managed-startup@example.com",
  GIT_COMMITTER_NAME: "managed-startup-test",
  GIT_COMMITTER_EMAIL: "managed-startup@example.com",
};

function repository(root: string): string {
  const path = join(root, "plain-requirement-repo");
  execFileSync("git", ["init", "-q", "-b", "master", path]);
  writeFileSync(join(path, "main.ts"), "export const colour = 'red';\n");
  execFileSync("git", ["-C", path, "add", "main.ts"], { env: GIT_ENV });
  execFileSync("git", ["-C", path, "commit", "-qm", "initial"], {
    env: GIT_ENV,
  });
  return path;
}

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${what}`);
}

test("普通措辞也先机械 init/current，模型首个 Edit 在配置阶段被拒绝", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-managed-startup-"));
  const repo = repository(dataDir);
  const kernelRoot = discoverKernelRoot(process.cwd());
  assert.ok(kernelRoot, "发布件必须包含 vendored Mae-Flow 内核");
  const model = new ScriptedModelServer([
    { text: "我先直接修改按钮颜色。", tool: { name: "edit", input: {
      path: "main.ts",
      edits: [{
        oldText: "export const colour = 'red';",
        newText: "export const colour = 'blue';",
      }],
    } } },
    { text: "收到门禁反馈，停止修改并回到当前流程。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot, repoPath: repo, python: "python3", continuousReview: true,
    },
  });
  try {
    const task = service.create("把首页按钮改成蓝色", {
      account: "dev",
      lane: "局部修改",
      ticket: "REQ-MANAGED-STARTUP",
    });
    const cwd = join(task.workspace, basename(repo));
    await until(() => {
      const path = join(task.workspace, "events.jsonl");
      if (!existsSync(path)) return false;
      return readFileSync(path, "utf-8").split("\n").some((line) => {
        if (!line) return false;
        const event = JSON.parse(line);
        return event.kind === "tool_finished"
          && event.payload?.name === "Edit";
      });
    }, "首个 Edit 被内核裁决");

    const state = JSON.parse(readFileSync(
      join(cwd, ".mae-flow.json"), "utf-8"));
    assert.equal(state.current, "config_confirm",
      "模型入场时必须已经脱离 INACTIVE");
    assert.equal(state.execution_contract?.continuous_review, true,
      "启动握手通过的新任务必须把持续检视能力写进不可变执行契约");
    assert.equal(readFileSync(join(cwd, "main.ts"), "utf-8"),
      "export const colour = 'red';\n",
      "配置确认前的首个源码修改不能落盘");
    const events = readFileSync(join(task.workspace, "events.jsonl"), "utf-8");
    assert.match(events, /交付方式尚未选定|配置确认/,
      "模型必须收到可行动的内核拒绝原因");
    const firstRequest = JSON.stringify(model.requests[0] ?? {});
    assert.match(firstRequest, /config_confirm|配置确认/,
      "第一轮上下文必须直接包含 current，而不是只叫模型自行 init");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("vendored Cloud Hook 在 grill 阶段放行 Edit 与 Bash 写源码(步骤级源码闸已退役)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-managed-grill-"));
  const repo = repository(root);
  mkdirSync(join(root, "pipeline"));
  mkdirSync(join(root, "reviews"));
  writeFileSync(join(root, "pipeline", "compile.log"), "BUILD FAILURE\n");
  writeFileSync(join(root, "reviews", "discussions.json"), "[]\n");
  const vendored = join(process.cwd(), "kernel");
  assert.ok(existsSync(join(vendored, "hooks", "dispatch.py")),
    "Cloud 发布快照必须包含可执行 Hook");
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "grill",
    config: { "单号": "REQ-GRILL-GATE", "基线分支": "master" },
    choices: { workflow: "full" },
    history: [{ step: "workflow_select", result: "done" }],
    started: "2026-08-25 10:00:00",
  }));
  const host = new KernelHost({
    kernelRoot: vendored,
    workspace: repo,
    fileAccessRoot: root,
    transcriptPath: join(root, "transcript.jsonl"),
    taskId: "managed-grill",
    python: "python3",
  });
  const guidance = await host.bootstrapManaged("继续梳理需求边界");
  assert.match(guidance, /grill|需求澄清|需求质询/);
  const localTemplate = join(
    repo, ".mae-flow-work", "plugin-resources", "assets",
    "GRILL-PREP-TEMPLATE.md");
  const sourceTemplate = join(
    vendored, "skills", "mae-flow", "assets", "GRILL-PREP-TEMPLATE.md");
  assert.match(guidance, new RegExp(localTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "current 必须把仓内物化模板交给模型");
  assert.equal(guidance.includes(sourceTemplate), false,
    "current 不得暴露会被文件门禁拒绝的内核源码路径");

  const read = (callId: string, path: string) => host.preTool({
    eventId: 1, taskId: "managed-grill", sessionId: "main", ts: "",
    kind: "tool_requested",
    payload: { call_id: callId, name: "Read", input: { path } },
  });
  assert.equal(await read("read-local-template", localTemplate), undefined);
  assert.equal(await read("read-pipeline", "../pipeline/compile.log"), undefined);
  assert.equal(await read("read-reviews", "../reviews/discussions.json"), undefined);
  assert.equal((await read("read-kernel-source", sourceTemplate))?.action, "deny");
  assert.equal((await read("read-other-task", "../../other-task/secret"))?.action,
    "deny");

  const reply = await host.preTool({
    eventId: 1, taskId: "managed-grill", sessionId: "main", ts: "",
    kind: "tool_requested",
    payload: {
      call_id: "write-review-replies", name: "Write",
      input: { path: "../review_replies.md", content: "[discussion-1]\n已修复\n" },
    },
  });
  assert.equal(reply, undefined,
    "任务根内的检视回复文件必须通过内核路径边界");

  const edit = await host.preTool({
    eventId: 1, taskId: "managed-grill", sessionId: "main", ts: "",
    kind: "tool_requested",
    payload: {
      call_id: "edit-grill", name: "Edit",
      input: { path: "main.ts", edits: [{ oldText: "red", newText: "blue" }] },
    },
  });
  // 步骤级"本步禁改源码"2026-08-28 随内核 8863f99 退役(编码阶段自由):
  // workflow 已选定后 grill 改码放行——之前流水线修复 Agent 就是被这条
  // 拦成"能提交不能编辑"。头部纪律(上一个用例)与只读资源保护不动。
  assert.equal(edit, undefined,
    "workflow 已选定,grill 改源码必须放行");

  const bash = await host.preTool({
    eventId: 2, taskId: "managed-grill", sessionId: "main", ts: "",
    kind: "tool_requested",
    payload: {
      call_id: "bash-grill", name: "Bash",
      input: { command: "sed -i s/red/blue/ main.ts" },
    },
  });
  assert.equal(bash, undefined,
    "Bash 写源码与 Edit 是同一条自由");
});
