import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/semanticEvents.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function coreFixture(root: string): { repo: string; kernel: string } {
  const repo = join(root, "repo");
  const kernel = join(root, "kernel");
  mkdirSync(repo);
  mkdirSync(join(kernel, "flow"), { recursive: true });
  mkdirSync(join(kernel, "scripts"), { recursive: true });
  writeFileSync(join(kernel, "flow", "flow.json"), JSON.stringify({
    steps: {
      build: { title: "自由实现与定稿", allow_source_edit: true },
      delivery_review: {
        title: "交付清单确认",
        user_ack: true,
        approval_subject: { kind: "worktree" },
      },
      external_verify: { title: "等待流水线", host_wait: true },
    },
  }));
  // Cloud/内核协议集成假件：纯映射由 mae-flow 内核单测覆盖；这里验证
  // Cloud 确实把用户要求、助手结果、工具事实和文件清单交给内核。
  writeFileSync(join(kernel, "scripts", "mae-flow.py"), [
    "import json, os, sys",
    "facts=json.load(open(sys.argv[sys.argv.index('--file')+1], encoding='utf-8'))",
    "state=json.load(open('.mae-flow.json', encoding='utf-8'))",
    "old=state['current']",
    "target={'delivery_review':'build','external_verify':'build'}.get(old, old)",
    "state['user_intervention']=facts",
    "state['current']=target",
    "json.dump(state, open('.mae-flow.json','w',encoding='utf-8'), ensure_ascii=False)",
    "print(json.dumps({'changed':True,'from':old,'target':target}, ensure_ascii=False))",
  ].join("\n"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "fixture"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", repo, "add", "source.ts"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 3,
  }));
  return { repo, kernel };
}

test("开发助手:安全暂停主任务后执行真实命令，回复/工具结果可见且不推进主状态", async () => {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      questions: [{ question: "主任务要继续吗?", options: ["继续", "停止"],
        recommended: "继续" }],
    } } },
    { tool: { name: "bash", input: { command:
      "printf 'assistant-ok\\n' > assistant-proof.txt && printf 'command-ok\\n'",
    } } },
    { text: "已创建 assistant-proof.txt，命令执行成功；没有提交或推送。" },
    { tool: { name: "bash", input: { command:
      "test \"$(cat assistant-proof.txt)\" = assistant-ok && printf 'second-ok\\n'",
    } } },
    { text: "第二轮仍在同一代码现场，证明文件检查通过。" },
    { tool: { name: "bash", input: { command: "__MFC_HOLD__" } } },
  ], "scripted-v1", { linear: true });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-developer-assistant-flow-"));
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    isolation: {
      image: "fixture/developer-assistant:test",
      containerFactory: containers.factory,
    },
  });

  try {
    const id = service.create("旁路助手集成演练").id;
    await until(() => service.get(id)?.status === "waiting_for_human",
      "主任务进入人工节点");

    const started = service.startDeveloperAssistant(
      id, "直接跑命令并留下一个证明文件", "alice");
    assert.equal(started.messages.some((item) =>
      item.role === "user" && /直接跑命令/.test(item.text)), true,
    "第一条指令必须在暂停收口前就持久化");
    assert.equal(["acquiring", "working"].includes(started.state), true,
      "服务端应自动接管，不再要求前端先暂停");
    await until(() => service.get(id)?.status === "paused",
      "服务端把主任务收到安全暂停边界");
    assert.throws(() => service.resume(id, "alice"), /开发接管会话/);

    await until(() => service.developerAssistant(id).state === "ready",
      "开发助手返回结果");
    const summary = service.get(id)!;
    const view = service.developerAssistant(id);
    const proof = join(summary.workspace, "assistant-proof.txt");

    assert.equal(summary.status, "paused",
      "助手完成后主任务必须保持暂停，等待用户明确交还");
    assert.equal(existsSync(proof), true);
    assert.ok(containers.records.length >= 2,
      "主任务暂停后应为开发助手创建独立容器");
    assert.equal(containers.records.at(-1)?.volumes.some((volume) =>
      volume.split(":")[1] === join(summary.workspace, "pipeline")), false,
    "真实开发助手入口不能继承流水线修复材料");
    assert.equal(readFileSync(proof, "utf-8"), "assistant-ok\n");
    assert.match(view.messages.at(-1)?.text ?? "", /命令执行成功/);
    assert.equal(view.tools.some((tool) => tool.name.toLowerCase() === "bash"
      && tool.state === "passed" && /command-ok/.test(tool.result ?? "")), true,
    "侧栏应直接拿到真实工具结果，不只展示 Agent 自述");

    const events = new EventLog(join(summary.workspace, "events.jsonl")).replay();
    assert.equal(events.some((event) =>
      event.sessionId === "developer-assistant"
      && event.kind === "tool_finished"), true,
    "开发助手完整工具轨迹应进入任务 SSE 正本");
    assert.equal(events.filter((event) =>
      event.sessionId === "developer-assistant").every((event) =>
        event.taskId === id), true);

    const assistantContainer = containers.records.at(-1)!;
    assert.equal(assistantContainer.stopped, false,
      "单轮结束后必须保留开发容器，维持 CLI 心流");
    assert.equal(assistantContainer.commands.some((command) =>
      command.includes("assistant-proof.txt")), true);

    service.startDeveloperAssistant(id, "继续检查刚才的证明文件", "alice");
    await until(() => service.developerAssistant(id).state === "ready",
      "开发助手第二轮返回结果");
    assert.equal(containers.records.at(-1), assistantContainer,
      "连续输入必须复用同一个接管容器");
    assert.match(service.developerAssistant(id).messages.at(-1)?.text ?? "",
      /第二轮仍在同一代码现场/);

    service.startDeveloperAssistant(id, "开始一个可以手动停止的长动作", "alice");
    await until(() => assistantContainer.commands.some((command) =>
      command.includes("__MFC_HOLD__")), "开发助手进入长动作");
    const stopped = await service.stopDeveloperAssistant(id, "alice");
    assert.equal(stopped.state, "ready");
    assert.equal(service.get(id)?.status, "paused",
      "停止当前动作不等于交还主任务");
    assert.match(stopped.messages.at(-1)?.text ?? "", /代码现场仍由你接管/);

    const resumed = await service.returnDeveloperAssistant(id, "alice");
    assert.equal(resumed.status, "waiting_for_human",
      "交还后应回到原来的 Mae-Flow/主任务状态，而不是由助手越级推进");
    assert.equal(assistantContainer.stopped, true,
      "显式交还时才释放开发容器");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("开发助手:主会话正在执行时立即中止，资源释放后自动接管", async () => {
  let releaseMain!: () => void;
  const heldMain = new Promise<void>((resolve) => { releaseMain = resolve; });
  const model = new ScriptedModelServer([
    { text: "迟到的主会话结果。" },
    { text: "已接管正在运行的主现场，可以继续输入。" },
  ], "scripted-v1", {
    linear: true,
    beforeScene: ({ requestNumber }) => requestNumber === 1 ? heldMain : undefined,
  });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-developer-assistant-running-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    isolation: {
      image: "fixture/developer-assistant:test",
      containerFactory: containers.factory,
    },
  });

  try {
    const id = service.create("运行中直接接管").id;
    await until(() => service.get(id)?.status === "running"
      && model.requests.length >= 1, "主会话正在等待模型响应");

    const started = service.startDeveloperAssistant(
      id, "不用我先点暂停，直接接管主现场", "alice");
    assert.equal(started.state, "acquiring");
    assert.equal(service.get(id)?.status, "pausing");
    assert.equal(started.messages.at(-1)?.text,
      "不用我先点暂停，直接接管主现场");

    await until(() => service.developerAssistant(id).state === "ready",
      "主会话中止后自动进入开发 CLI");
    assert.deepEqual(model.served, [1], "接管不依赖主会话结束回合");
    assert.equal(service.get(id)?.status, "paused");
    assert.match(service.developerAssistant(id).messages.at(-1)?.text ?? "",
      /已接管正在运行的主现场/);
    assert.equal(containers.records.length, 2,
      "主会话容器必须先收口，开发 CLI 再使用独立容器");
    assert.equal(containers.records[0].stopped, true);
    assert.equal(containers.records[1].stopped, false);
  } finally {
    releaseMain();
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("开发助手:用户可跨流程位置接管，并把变更/命令结果一次性交给主会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-developer-assistant-core-"));
  const { repo, kernel } = coreFixture(root);
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command:
      "printf 'export const fixed = true;\\n' > fixed.ts && printf 'unit-ok\\n'",
    } } },
    { text: "已修复 fixed.ts，并完成定向检查。" },
    { tool: { name: "bash", input: { command:
      "printf 'export const reviewFixed = true;\\n' > review-fixed.ts",
    } } },
    { text: "已按用户介入要求调整 review-fixed.ts。" },
    { tool: { name: "bash", input: { command:
      "printf 'export const ciFixed = true;\\n' > ci-fixed.ts",
    } } },
    { text: "已处理流水线问题并留下 ci-fixed.ts。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const dataDir = join(root, "data");
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 0,
    host: { kernelRoot: kernel, repoPath: repo },
    isolation: {
      image: "fixture/developer-assistant:test",
      containerFactory: containers.factory,
    },
  });

  try {
    const id = service.create("修复代码并交还").id;
    await service.pause(id, "alice");
    const internal = (service as unknown as {
      tasks: Map<string, { cwd?: string }>;
    }).tasks.get(id)!;
    internal.cwd = repo;

    assert.equal(service.developerAssistant(id).availability.code, "edit_window");
    service.startDeveloperAssistant(id, "修复并运行检查", "alice");
    await until(() => service.developerAssistant(id).state === "ready",
      "内核窗口中的助手完成");

    const view = service.developerAssistant(id);
    assert.equal(view.handoff?.state, "running",
      "CLI 就绪不等于交还完成，起点必须持续保留");

    // revision 只是启动时的定位信息。即使内核账本被其他恢复动作刷新，
    // 交还也必须让主 Agent 重新读 current，而不是把任务卡在 paused。
    writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
      current: "build", revision: 4,
    }));
    const resumed = await service.returnDeveloperAssistant(id, "alice");
    assert.equal(resumed.status, "queued");
    const saved = JSON.parse(readFileSync(
      join(dataDir, id, "task.json"), "utf-8"));
    assert.match(saved.assistant_handoff, /fixed\.ts/);
    assert.match(saved.assistant_handoff, /unit-ok/);
    assert.match(saved.assistant_handoff, /不是 Mae-Flow 步骤、批准或质量证据/);
    assert.equal(service.developerAssistant(id).handoff?.state, "returned");
    const reconciledState = JSON.parse(readFileSync(
      join(repo, ".mae-flow.json"), "utf-8"));
    assert.equal(reconciledState.user_intervention.actor, "alice");
    assert.match(reconciledState.user_intervention.request, /修复并运行检查/);
    assert.match(reconciledState.user_intervention.assistant_summary, /已修复 fixed\.ts/);
    assert.deepEqual(reconciledState.user_intervention.changed_paths, ["fixed.ts"]);
    assert.match(reconciledState.user_intervention.executions[0].result, /unit-ok/);

    const reviewId = service.create("审批阶段也可由用户接管").id;
    await service.pause(reviewId, "alice");
    const reviewTask = (service as unknown as {
      tasks: Map<string, { cwd?: string }>;
    }).tasks.get(reviewId)!;
    reviewTask.cwd = repo;
    writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
      current: "delivery_review", revision: 4,
      approval_subject: { id: "subject-a" },
    }));
    const reviewAvailability = service.developerAssistant(reviewId).availability;
    assert.equal(reviewAvailability.available, true);
    assert.equal(reviewAvailability.code, "user_override");

    const reviewState = reviewTask as unknown as {
      summary: {
        status: string;
        waiting?: unknown;
        control?: { paused_from?: string };
      };
      humanGate: {
        createWaiting(options: Record<string, unknown>): unknown;
      };
    };
    reviewState.summary.waiting = reviewState.humanGate.createWaiting({
      taskId: reviewId,
      step: "delivery_review",
      callId: "review-card",
      questionInput: {
        questions: [{
          question: "代码是否可以继续？",
          options: ["我已认真检视并完成自验证，继续", "需要调整代码"],
        }],
      },
    });
    reviewState.summary.control = { paused_from: "waiting_for_human" };
    service.startDeveloperAssistant(reviewId, "这里需要直接调整", "alice");
    await until(() => service.developerAssistant(reviewId).state === "ready",
      "审批阶段由用户接管完成");
    const reviewResumed = await service.returnDeveloperAssistant(reviewId, "alice");
    assert.equal(reviewResumed.status, "queued");
    const reviewSaved = JSON.parse(readFileSync(
      join(dataDir, reviewId, "task.json"), "utf-8"));
    assert.equal(reviewSaved.waiting, undefined,
      "旧审批卡应按原选项“需要调整代码”收口，不能继续挂住");
    const reviewWaiting = JSON.parse(readFileSync(
      join(dataDir, reviewId, "waiting.json"), "utf-8"));
    assert.equal((Object.values(reviewWaiting.records)[0] as { status?: string })
      ?.status, "superseded",
      "旧卡只标记失效，不能伪造一份通过或打回答案");
    assert.equal(JSON.parse(readFileSync(
      join(repo, ".mae-flow.json"), "utf-8")).current, "build",
    "内核应把介入改代码退回 build，不回放已经失效的旧审批答案");

    const verifyingId = service.create("流水线阶段由用户接管").id;
    await service.pause(verifyingId, "alice");
    const verifyingTask = (service as unknown as {
      tasks: Map<string, {
        cwd?: string;
        summary: {
          control?: { paused_from?: string };
          delivery?: Record<string, unknown>;
        };
      }>;
    }).tasks.get(verifyingId)!;
    verifyingTask.cwd = repo;
    verifyingTask.summary.control = { paused_from: "verifying" };
    verifyingTask.summary.delivery = {
      sha: "old-pipeline-sha",
      pipeline: "success",
      mr_url: "https://code.example/mr/1",
    };
    writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
      current: "external_verify", revision: 9,
    }));
    service.startDeveloperAssistant(
      verifyingId, "流水线方向错了，直接修当前代码", "alice");
    await until(() => service.developerAssistant(verifyingId).state === "ready",
      "验证阶段由用户接管完成");
    const verifyingResumed = await service.returnDeveloperAssistant(
      verifyingId, "alice");
    assert.equal(verifyingResumed.status, "queued",
      "用户改过代码后不能继续轮询旧流水线，必须重建主会话");
    assert.equal(verifyingResumed.delivery?.sha, undefined);
    assert.equal(verifyingResumed.delivery?.mr_url, "https://code.example/mr/1",
      "旧流水线事实作废，但现有 MR 身份应保留供后续更新");
    assert.equal(JSON.parse(readFileSync(
      join(repo, ".mae-flow.json"), "utf-8")).current, "build");

    const ordinaryId = service.create("普通暂停恢复不能重放旧介入").id;
    await service.pause(ordinaryId, "alice");
    const ordinaryTask = (service as unknown as {
      tasks: Map<string, {
        cwd?: string;
        summary: { workspace: string; delivery?: Record<string, unknown> };
      }>;
    }).tasks.get(ordinaryId)!;
    ordinaryTask.cwd = repo;
    ordinaryTask.summary.delivery = { sha: "fresh-pipeline-sha" };
    writeFileSync(join(ordinaryTask.summary.workspace, "developer-assistant.json"),
      JSON.stringify({
        state: "completed", messages: [],
        handoff: {
          id: "already-applied", state: "returned",
          started_at: "2026-08-23T00:00:00.000Z",
          returned_at: "2026-08-23T00:01:00.000Z",
          initial: { sha: "a", fingerprint: "before", paths: [], path_fingerprints: {} },
          current: { sha: "a", fingerprint: "after", paths: [], path_fingerprints: {} },
          changed_paths: ["src/old.ts"], message: "已经交还过",
        },
      }));
    const replay = (service as unknown as {
      prepareDeveloperAssistantReturn(
        task: unknown, actor: string,
      ): unknown;
    }).prepareDeveloperAssistantReturn(ordinaryTask, "alice");
    assert.equal(replay, undefined);
    assert.equal(ordinaryTask.summary.delivery?.sha, "fresh-pipeline-sha",
      "历史 returned 不能在以后普通暂停时再次作废新流水线");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
