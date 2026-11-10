/**
 * 问题流的视觉旁路(#41):vision 透传后主会话获得 inspect_image,
 * 识图走独立旁路——图片本体只发给专用视觉模型,主上下文只收文字回执;
 * 视觉端点连败熔断也只影响工具,不炸回合;未配置时与现状完全一致。
 * 造假端点先例抄自 tests/visionCapability.test.ts(剧本假模型对拍)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { visionProbePng } from "../src/visionCapability.ts";
import { forceRm, mfcTemp } from "./mfcTmp.ts";

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
  dump?: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let nextDump = Date.now() + 10_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (dump && Date.now() >= nextDump) {
      nextDump = Date.now() + 10_000;
      console.error(`[diag ${what}] ${dump()}`);
    }
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 真模型(剧本)+ 专用视觉模型(剧本)拼成一份 models.json:视觉角色
 * 必须显式声明 input 含 image,否则组装逻辑会拒绝暴露工具。 */
async function startModels(mainScript: Scene[]): Promise<{
  main: ScriptedModelServer;
  vision: ScriptedModelServer;
  modelsJson: Record<string, unknown>;
}> {
  const main = new ScriptedModelServer(mainScript);
  const vision = new ScriptedModelServer([
    { text: "结论:红、绿、蓝。可见证据:三个色块。OCR:无。不确定项:无。" },
  ], "vision-v1");
  await main.start();
  await vision.start();
  const mainJson = main.modelsJson("maeflow") as any;
  const visionJson = vision.modelsJson("vision") as any;
  visionJson.providers.vision.models[0].input = ["text", "image"];
  return {
    main,
    vision,
    modelsJson: { providers: { ...mainJson.providers, ...visionJson.providers } },
  };
}

/** 首幕先举问题卡,给测试一个确定的窗口往会话工作区放图片(工作区
 * 目录在 create() 时才建出来,首轮回合启动与写文件赛跑不可靠)。 */
const ASK_SCENE: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "截图已收到,要现在识图吗?",
    options: ["开始识图", "先等等"],
    recommended: "开始识图",
  }] } },
};

const INSPECT_SCENE: Scene = {
  tool: { name: "inspect_image", input: {
    images: [{ path: "screen.png", label: "界面截图" }],
    question: "从左到右有哪些颜色?",
  } },
};

test("配 vision 的问题会话:工具清单含 inspect_image,识图走旁路且主上下文只收文字", async () => {
  const dataDir = mfcTemp("mfc-issue-vision-");
  const { main, vision, modelsJson } = await startModels([
    ASK_SCENE,
    INSPECT_SCENE,
    { text: "根据图片证据,截图从左到右是红、绿、蓝。" },
  ]);
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson,
    vision: { provider: "vision", model: "vision-v1" },
  });
  try {
    const created = service.create({ account: "dev", title: "界面截图疑似异常",
      ticket: "DTS-VIS" });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "waiting_user" ? issue : undefined;
    }, "首轮问题卡", undefined, () => {
      const i = service.get(created.id);
      return JSON.stringify({ reqs: main.requests.length, served: main.served.join('+'), status: i.status, stage: i.stage,
        gate: i.gate?.kind, note: i.stage_note?.slice(0, 60), error: i.error });
    });
    const workspace = join(dataDir, "issues", created.id);
    writeFileSync(join(workspace, "screen.png"), visionProbePng());
    service.answer(created.id, {
      state_version: waiting.waiting!.state_version, decision: "开始识图",
    });
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "识图回合收口");

    // AI 工具清单(主模型请求体里的 tools)确实带上了 inspect_image。
    const toolNames = ((main.requests[0].tools as Array<{ name?: string }>) ?? [])
      .map((tool) => tool.name);
    assert.ok(toolNames.includes("inspect_image"),
      `inspect_image 应在工具清单里(实际 ${JSON.stringify(toolNames)})`);

    // 旁路纪律:图片只发给了专用视觉模型(带 image 块)。
    assert.equal(vision.requests.length, 1);
    assert.equal(
      (vision.requests[0].messages as any[])[0].content[1].type, "image");

    // 主模型三次请求全程不含图像内容,收到的工具回执是文字结论。
    const mainText = JSON.stringify(main.requests);
    assert.doesNotMatch(mainText, /"type":"image"/);
    assert.doesNotMatch(mainText, /iVBORw0KGgo/);
    assert.match(mainText, /红、绿、蓝/);
    assert.match(mainText, /非可信观察结果/,
      "回执必须带非可信观察标记(证据类文字的既有契约)");

    // transcript 与视觉缓存同样不留图像字节;缓存落在会话工作区的
    // vision-cache(与需求侧 workspace/vision-cache 同一约定)。
    assert.doesNotMatch(
      readFileSync(join(workspace, "transcript.jsonl"), "utf-8"),
      /iVBORw0KGgo/);
    assert.equal(readdirSync(join(workspace, "vision-cache")).length, 1);
    assert.match(idle.last_reply ?? "", /红、绿、蓝/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await main.stop();
    await vision.stop();
    forceRm(dataDir);
  }
});

test("视觉端点连败两次熔断:第三召不再打端点并回文本,回合照常收口", async () => {
  const dataDir = mfcTemp("mfc-issue-vision-fail-");
  const { main, vision, modelsJson } = await startModels([
    ASK_SCENE,
    INSPECT_SCENE,
    INSPECT_SCENE,
    INSPECT_SCENE,
    { text: "识图服务暂不可用,已如实告知用户,先给出基于日志的判断。" },
  ]);
  vision.failWith("vision gateway down", 2);
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson,
    vision: { provider: "vision", model: "vision-v1" },
    // 卡要留给人工作答(手动 answer 驱动识图/熔断):钉三档对齐。
    interventionTier: () => "3",
  });
  try {
    const created = service.create({ account: "dev", title: "识图连败",
      ticket: "DTS-VIS2" });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "waiting_user" ? issue : undefined;
    }, "首轮问题卡", undefined, () => {
      const i = service.get(created.id);
      return JSON.stringify({ reqs: main.requests.length, served: main.served.join('+'), status: i.status, stage: i.stage,
        gate: i.gate?.kind, note: i.stage_note?.slice(0, 60), error: i.error });
    });
    writeFileSync(join(dataDir, "issues", created.id, "screen.png"),
      visionProbePng());
    service.answer(created.id, {
      state_version: waiting.waiting!.state_version, decision: "开始识图",
    });
    const idle = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle" ? issue : undefined;
    }, "熔断回合收口", undefined, () => {
      const i = service.get(created.id);
      return JSON.stringify({ reqs: main.requests.length, served: main.served.join('+'), status: i.status, stage: i.stage,
        note: i.stage_note?.slice(0, 60), error: i.error });
    });

    // 前两次失败打到端点,第三次被熔断拦下(不再发请求),回合不炸。
    assert.equal(vision.requests.length, 2);
    assert.equal(idle.error, undefined);
    const mainText = JSON.stringify(main.requests);
    assert.match(mainText, /图片识别失败（1\/2）/, "首败要带次数回执");
    assert.match(mainText, /熔断/, "第三召收到的是熔断文本");
    assert.match(idle.last_reply ?? "", /暂不可用/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await main.stop();
    await vision.stop();
    forceRm(dataDir);
  }
});

test("未配置 vision:工具清单不含 inspect_image,其余照旧", async () => {
  const dataDir = mfcTemp("mfc-issue-vision-off-");
  const model = new ScriptedModelServer([
    { text: "收到问题,先给初步结论。" },
  ]);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create({ account: "dev", title: "不配视觉",
      ticket: "DTS-VIS3" });
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口");
    const toolNames = ((model.requests[0].tools as Array<{ name?: string }>) ?? [])
      .map((tool) => tool.name);
    assert.ok(!toolNames.includes("inspect_image"),
      "未配置时 inspect_image 不应出现(实际 "
        + `${JSON.stringify(toolNames)})`);
    assert.ok(existsSync(join(dataDir, "issues", created.id, "transcript.jsonl")),
      "会话正本照常落盘");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    forceRm(dataDir);
  }
});
