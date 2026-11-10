import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventLog } from "../src/semanticEvents.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import {
  createInspectImageTool,
  createVisionToolState,
  probeVisionCapability,
  visionProbePng,
} from "../src/visionCapability.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mae-flow-vision-test-"));
}

function okResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 2, output: 3 },
  };
}

test("InspectImage 只读工作区图片，缓存结果且不把图片字节写入缓存", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "repo");
    const cacheDir = join(root, "cache");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "screen.png"), visionProbePng());
    let calls = 0;
    const runtime = {
      getModel: () => ({ id: "qwen-vl", input: ["text", "image"] }),
      completeSimple: async () => {
        calls += 1;
        return okResponse("结论：红绿蓝；可见证据：三个色块；OCR：无；不确定项：无");
      },
    };
    const tool = createInspectImageTool({
      runtime,
      workspace,
      config: { choice: { provider: "qwen", model: "qwen-vl" }, cacheDir },
      state: createVisionToolState(),
      sessionId: "main",
    });
    const args = { images: [{ path: "screen.png" }], question: "有哪些颜色？" };
    const first = await (tool.execute as any)("one", args, undefined);
    const second = await (tool.execute as any)("two", args, undefined);
    assert.equal(calls, 1);
    assert.equal(first.details.cache_hit, false);
    assert.equal(second.details.cache_hit, true);
    const cache = readFileSync(join(cacheDir, `${first.details.key}.json`), "utf-8");
    assert.match(cache, /红绿蓝/);
    assert.doesNotMatch(cache, /iVBORw0KGgo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("InspectImage 拒绝绝对路径、URI 与越界软链", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "repo");
    mkdirSync(workspace);
    const outside = join(root, "outside.png");
    writeFileSync(outside, visionProbePng());
    symlinkSync(outside, join(workspace, "escape.png"));
    const tool = createInspectImageTool({
      runtime: {
        getModel: () => ({ input: ["text", "image"] }),
        completeSimple: async () => okResponse("不应调用"),
      },
      workspace,
      config: { choice: { provider: "qwen", model: "qwen-vl" },
        cacheDir: join(root, "cache") },
      state: createVisionToolState(),
      sessionId: "main",
    });
    const invoke = (path: string) => (tool.execute as any)("x", {
      images: [{ path }], question: "看什么？",
    }, undefined);
    await assert.rejects(() => invoke(outside), /相对路径/);
    await assert.rejects(() => invoke("https://example.test/a.png"), /不接受 URL/);
    await assert.rejects(() => invoke("escape.png"), /越出任务工作区/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("InspectImage 连续失败两次后熔断，第三次不再请求模型", async () => {
  const root = tempRoot();
  try {
    const workspace = join(root, "repo");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "screen.png"), visionProbePng());
    let calls = 0;
    const tool = createInspectImageTool({
      runtime: {
        getModel: () => ({ input: ["text", "image"] }),
        completeSimple: async () => {
          calls += 1;
          throw new Error("gateway unavailable");
        },
      },
      workspace,
      config: { choice: { provider: "qwen", model: "qwen-vl" },
        cacheDir: join(root, "cache") },
      state: createVisionToolState(),
      sessionId: "main",
    });
    const args = { images: [{ path: "screen.png" }], question: "看什么？" };
    await assert.rejects(() => (tool.execute as any)("1", args), /1\/2/);
    await assert.rejects(() => (tool.execute as any)("2", args), /2\/2/);
    const stopped = await (tool.execute as any)("3", args);
    assert.equal(calls, 2);
    assert.equal(stopped.details.circuit_open, true);
    assert.match(stopped.content[0].text, /停止重试/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("管理页探测做真实图片请求并校验红绿蓝语义", async () => {
  const server = new ScriptedModelServer([
    { text: "结论：从左到右为红色、绿色、蓝色。可见证据：三个色块。OCR：无。不确定项：无。" },
  ], "vision-v1");
  await server.start();
  try {
    const modelsJson = server.modelsJson("vision");
    const spec = (modelsJson as any).providers.vision;
    spec.models[0].input = ["text", "image"];
    const result = await probeVisionCapability({
      modelsJson,
      choice: { provider: "vision", model: "vision-v1" },
    });
    assert.equal(result.status, "ready");
    const request = server.requests[0] as any;
    assert.equal(request.messages[0].content[1].type, "image");
  } finally {
    await server.stop();
  }
});

test("主 Agent 可调用 InspectImage，专用模型结果回到原会话", async () => {
  const root = tempRoot();
  const main = new ScriptedModelServer([
    { text: "我先读取截图。", tool: { name: "inspect_image", input: {
      images: [{ path: "screen.png", label: "界面截图" }],
      question: "从左到右有哪些颜色？",
    } } },
    { text: "根据图片证据，截图从左到右是红、绿、蓝。" },
  ], "main-v1");
  const vision = new ScriptedModelServer([
    { text: "结论：红、绿、蓝。可见证据：三个色块。OCR：无。不确定项：无。" },
  ], "vision-v1");
  await main.start();
  await vision.start();
  try {
    const workspace = join(root, "repo");
    const agentDir = join(root, "agent");
    mkdirSync(workspace);
    mkdirSync(agentDir);
    writeFileSync(join(workspace, "screen.png"), visionProbePng());
    const mainJson = main.modelsJson("main") as any;
    const visionJson = vision.modelsJson("vision") as any;
    visionJson.providers.vision.models[0].input = ["text", "image"];
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      ...mainJson.providers,
      ...visionJson.providers,
    } }));
    const session = await CloudSession.create({
      taskId: "vision-task",
      workspace,
      agentDir,
      provider: "main",
      model: "main-v1",
      eventLog: new EventLog(join(root, "events.jsonl")),
      transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace }),
      humanGate: new HumanGate(join(root, "waiting.json")),
      allowHumanQuestions: false,
      allowSubagents: false,
      vision: {
        choice: { provider: "vision", model: "vision-v1" },
        cacheDir: join(root, "vision-cache"),
      },
    });
    const outcome = await session.start("请确认截图内容");
    assert.equal(outcome.status, "turn_finished");
    assert.match(session.finalReply(), /红、绿、蓝/);
    assert.equal(vision.requests.length, 1);
    const transcript = readFileSync(join(root, "transcript.jsonl"), "utf-8");
    assert.doesNotMatch(transcript, /iVBORw0KGgo/);
    session.dispose();
  } finally {
    await main.stop();
    await vision.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
