import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EventLog } from "../src/semanticEvents.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { visionProbePng } from "../src/visionCapability.ts";
import {
  materializeRequirementAssets,
  storeRequirementAssets,
} from "../src/requirementBundle.ts";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";
import { buildRequirementMaterials } from "../src/requirementMaterials.ts";
import { requirementContext, type RequirementDocumentMeta } from "../src/requirementDocument.ts";

function zip(files: Array<{ name: string; content: Buffer | string }>): Buffer {
  return execFileSync("python3", ["-c", "import io,json,base64,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n for f in json.load(sys.stdin): z.writestr(f['name'],base64.b64decode(f['content']))\nsys.stdout.buffer.write(b.getvalue())"], {
    input: JSON.stringify(files.map(file => ({ name: file.name, content: Buffer.from(file.content).toString("base64") }))),
  });
}

test("ZIP 图文需求端到端：Agent 收到完整原文、读取真实图片并使用识图结果", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-requirement-agent-"));
  const material = await saveKnowledgeMaterial(root, { name: "蓝色发布.zip", content_base64: zip([
    {
      name: "方案/发布设计.md",
      content: "# 蓝色发布拓扑\n\n这是不可丢失的原文验收句。\n\n![发布拓扑](图片/拓扑.png)",
    },
    { name: "约束/验收.md", content: "# 第二份文档\n这是另一份文档里不可丢失的独立验收条件。" },
    { name: "方案/图片/拓扑.png", content: visionProbePng() },
  ]).toString("base64") });
  assert.equal(material.state, "ready", material.error);
  const parsed = buildRequirementMaterials(root, [material.id]);
  const imagePath = parsed.assets[0].path;
  const main = new ScriptedModelServer([
    {
      text: "我先按需求文档引用读取图片。",
      tool: { name: "inspect_image", input: {
        images: [{ path: imagePath, label: "发布拓扑" }],
        question: "图片中从左到右有哪些颜色？",
      } },
    },
    { text: "原文要求已读取；图片证据显示从左到右是红、绿、蓝。" },
  ], "main-v1");
  const vision = new ScriptedModelServer([
    { text: "结论：红、绿、蓝。可见证据：三个色块。OCR：无。不确定项：无。" },
  ], "vision-v1");
  await main.start();
  await vision.start();
  try {
    const taskWorkspace = join(root, "task");
    const runtimeWorkspace = join(root, "repo");
    const agentDir = join(root, "agent");
    mkdirSync(taskWorkspace);
    mkdirSync(runtimeWorkspace);
    mkdirSync(agentDir);
    storeRequirementAssets(taskWorkspace, parsed.assets);
    const meta: RequirementDocumentMeta = {
      name: parsed.document_name,
      sources: parsed.sources.map(({ content: _, ...source }) => source),
      bytes: Buffer.byteLength(parsed.requirement),
      context_mode: "inline",
      assets: parsed.assets.map(({ content: _content, ...asset }) => asset),
    };
    materializeRequirementAssets(taskWorkspace, runtimeWorkspace, meta);

    const mainJson = main.modelsJson("main") as any;
    const visionJson = vision.modelsJson("vision") as any;
    visionJson.providers.vision.models[0].input = ["text", "image"];
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      ...mainJson.providers,
      ...visionJson.providers,
    } }));
    const eventPath = join(root, "events.jsonl");
    const session = await CloudSession.create({
      taskId: "bundle-task",
      workspace: runtimeWorkspace,
      agentDir,
      provider: "main",
      model: "main-v1",
      eventLog: new EventLog(eventPath),
      transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace: runtimeWorkspace }),
      humanGate: new HumanGate(join(root, "waiting.json")),
      allowHumanQuestions: false,
      allowSubagents: false,
      vision: {
        choice: { provider: "vision", model: "vision-v1" },
        cacheDir: join(root, "vision-cache"),
      },
    });
    const prompt = requirementContext(parsed.requirement, meta);
    const outcome = await session.start(prompt);

    assert.equal(outcome.status, "turn_finished");
    assert.ok((main.requests[0].tools as Array<{ name: string }>).some((tool) => tool.name === "bash"),
      "普通编码会话必须保留 Bash，不能被需求修订专项白名单误伤");
    const firstRequest = JSON.stringify(main.requests[0]);
    assert.match(firstRequest, /不可丢失的原文验收句/);
    assert.match(firstRequest, /另一份文档里不可丢失的独立验收条件/);
    assert.ok(firstRequest.includes(imagePath), "Agent 首轮必须拿到真实图片相对路径");
    assert.match(firstRequest, /InspectImage/);
    assert.equal(vision.requests.length, 1, "必须真实发起一次视觉模型请求");
    assert.match(JSON.stringify(vision.requests[0]), /"type":"image"/);
    assert.match(readFileSync(eventPath, "utf-8"), /InspectImage/);
    assert.match(session.finalReply(), /红、绿、蓝/);
    session.dispose();
  } finally {
    await main.stop();
    await vision.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
