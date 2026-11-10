import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { GateService } from "../src/gateService.ts";
import { createRequirementReviewGateContract, prepareRequirementReviewWorkspace } from "../src/requirementReviewAgent.ts";
import { storeRequirementAssets, type RequirementAsset } from "../src/requirementBundle.ts";
import type { RequirementDocumentMeta } from "../src/requirementDocument.ts";
import { REVIEW_ASSET_STORE, readReviewAsset, storeReviewAsset } from "../src/reviewAssets.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TaskService } from "../src/taskService.ts";
import { visionProbePng } from "../src/visionCapability.ts";

function bundleImage(): RequirementAsset {
  const content = visionProbePng();
  const digest = createHash("sha256").update(content).digest("hex");
  return { path: `.mae-flow-work/requirement-assets/${digest.slice(0, 24)}.png`,
    source_path: "images/design.png", mime_type: "image/png", bytes: content.length, digest, content };
}

test("需求修订准备两类图片，只允许读取附件，仍禁止命令、写图和越界读取", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-review-assets-gate-"));
  try {
    const reviewRoot = join(root, "requirement-review", "round-1");
    const review = storeReviewAsset(root, undefined, visionProbePng());
    const bundle = bundleImage();
    storeRequirementAssets(root, [bundle]);
    const { content: _content, ...assetMeta } = bundle;
    const meta: RequirementDocumentMeta = { name: "需求.md", bytes: 10, context_mode: "inline", assets: [assetMeta] };
    prepareRequirementReviewWorkspace(root, reviewRoot, "需求原文", meta);
    const gate = new GateService({ workspace: reviewRoot, cwd: reviewRoot, failClosed: true,
      contract: createRequirementReviewGateContract(reviewRoot, meta) });
    const decision = (name: string, path: string) => gate.decide({
      eventId: 1, taskId: "task-2", sessionId: "review", ts: new Date().toISOString(),
      kind: "tool_requested", payload: { name, input: name === "Bash" ? { command: path } : { path } },
    }).action;
    for (const path of [review.path, bundle.path]) {
      assert.deepEqual(readFileSync(join(reviewRoot, path)), visionProbePng());
      assert.equal(decision("Read", path), "allow");
      assert.equal(decision("Read", join(reviewRoot, path)), "allow");
      for (const tool of ["Edit", "MultiEdit", "Write"]) assert.equal(decision(tool, path), "deny");
    }
    assert.equal(decision("Bash", "cp ../../reviews/assets/*.png ."), "deny");
    assert.equal(decision("Read", "../../task.json"), "deny");
    assert.equal(decision("Read", ".mae-flow-work/review-assets/../../task.json"), "deny");
    assert.equal(decision("Read", ".mae-flow-work/review-assets/notes.txt"), "deny");
    const outside = join(root, "outside.png");
    writeFileSync(outside, visionProbePng());
    const link = ".mae-flow-work/review-assets/000000000000000000000000.png";
    symlinkSync(outside, join(reviewRoot, link));
    assert.equal(decision("Read", link), "deny", "图片路径白名单不能绕过真实文件边界");
    assert.equal(decision("Edit", "requirement.md"), "allow");
    assert.equal(decision("Write", "requirement.md"), "deny");
    assert.equal(decision("Write", "receipts.json"), "allow");
    assert.equal(readFileSync(join(reviewRoot, "requirement.md"), "utf-8"), "需求原文");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("需求检视会话按原路径读取附图并调用视觉模型，再修改正文留下回执", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-review-assets-agent-"));
  const bundle = bundleImage();
  const review = storeReviewAsset(join(root, "upload"), undefined, visionProbePng());
  const original = `原始口径\n\n![截图](${review.path})\n\n![设计](${bundle.path})`;
  const main = new ScriptedModelServer([
    { tool: { name: "read", input: { path: review.path } } },
    { tool: { name: "read", input: { path: bundle.path } } },
    { tool: { name: "inspect_image", input: { images: [{ path: review.path }], question: "从左到右是什么颜色？" } } },
    { tool: { name: "edit", input: { path: "requirement.md", edits: [{ oldText: "原始口径", newText: "色块从左到右是红、绿、蓝" }] } } },
    { tool: { name: "write", input: { path: "receipts.json", content: "" } } },
    { text: "已根据附图修改正文。" },
  ], "main-v1", { linear: true });
  const vision = new ScriptedModelServer([{ text: "图中从左到右是红、绿、蓝色块。" }], "vision-v1");
  await main.start();
  await vision.start();
  try {
    const mainJson = main.modelsJson("main") as any;
    const visionJson = vision.modelsJson("vision") as any;
    visionJson.providers.vision.models[0].input = ["text", "image"];
    const service = new TaskService({ dataDir: join(root, "data"), maxConcurrent: 0,
      provider: "main", model: "main-v1", vision: { provider: "vision", model: "vision-v1" },
      modelsJson: { providers: { ...mainJson.providers, ...visionJson.providers } } });
    const task = service.create(original, { account: "owner", requirementAnalysisConfirmation: true,
      requirementDocumentName: "需求.md", requirementAssets: [bundle] });
    storeReviewAsset(task.workspace, undefined, visionProbePng());
    assert.equal(existsSync(join(task.workspace, review.path)), false, "复现：图片只有任务原始存储，没有运行副本");
    const note = service.addAnnotation(task.id, { author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "原始口径", note: "根据附图写明颜色顺序", kind: "doc" });
    main.script[4].tool!.input.content = JSON.stringify([{ annotation_id: note.id,
      outcome: "fixed", summary: "根据图片补充颜色顺序", evidence: ["requirement.md:1"] }]);
    await service.sendAnnotations(task.id, [note.id], "owner");
    const offered = (main.requests[0].tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.deepEqual(offered.sort(), ["edit", "inspect_image", "read", "write"],
      "需求编辑会话只能暴露可用的文件和看图工具，不能把 Bash 广告给模型再逐次拒绝");
    assert.doesNotMatch(JSON.stringify(main.requests[0].system), /Use bash for file operations like ls, rg, find/);
    assert.equal(service.get(task.id)?.requirement, original.replace("原始口径", "色块从左到右是红、绿、蓝"));
    const events = new EventLog(service.eventLogPath(task.id)).replay();
    const reads = events.filter((event) => event.kind === "tool_finished" && event.payload.name === "Read");
    assert.equal(reads.length, 2);
    assert.ok(reads.every((event) => !event.payload.is_error), JSON.stringify(reads));
    assert.equal(vision.requests.length, 1, "修订会话必须实际接入已配置视觉模型");
    assert.match(JSON.stringify(vision.requests[0]), /"type":"image"/);
    assert.ok(events.some((event) => event.kind === "tool_finished" && event.payload.name === "InspectImage" && !event.payload.is_error));
    assert.deepEqual(readReviewAsset(task.workspace, review.path)?.content, visionProbePng(), "会话清理不能删除原图");
    assert.equal(service.listAnnotations(task.id).items[0].response?.outcome, "fixed");
  } finally {
    await main.stop();
    await vision.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("图片复制失败不静默开始修订，错误仍可定位到准备阶段", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-review-assets-error-"));
  try {
    mkdirSync(join(root, REVIEW_ASSET_STORE, "000000000000000000000000.png"), { recursive: true });
    assert.throws(() => prepareRequirementReviewWorkspace(root, join(root, "review"), "原文", undefined), /copyfile/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
