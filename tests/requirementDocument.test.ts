import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_REQUIREMENT_DOCUMENT,
  INLINE_REQUIREMENT_DOCUMENT_BYTES,
  MAX_REQUIREMENT_DOCUMENT_BYTES,
  STORED_REQUIREMENT_DOCUMENT,
  materializeRequirementDocument,
  requirementContext,
  requirementDocumentMeta,
  storeRequirementDocument,
} from "../src/requirementDocument.ts";
import { TaskService } from "../src/taskService.ts";

test("Markdown 设计文档:只认 .md，限制大小，短文仍直接进入上下文", () => {
  assert.throws(() => requirementDocumentMeta("text", "design.txt"),
    /只支持.*\.md/);
  assert.throws(() => requirementDocumentMeta(
    "x".repeat(MAX_REQUIREMENT_DOCUMENT_BYTES + 1), "design.md"),
  /不能超过 8192 KiB/);

  const meta = requirementDocumentMeta("# 目标\n完成上传", "方案.MD");
  assert.deepEqual(meta, {
    name: "方案.MD",
    bytes: Buffer.byteLength("# 目标\n完成上传"),
    context_mode: "inline",
  });
  assert.equal(requirementContext("# 目标\n完成上传", meta),
    "# 目标\n完成上传");
});

test("长 Markdown 完整落盘，首轮只给提纲和分段读取路径", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-long-requirement-"));
  const content = "# 总体设计\n" + "详细约束与验收标准。\n"
    .repeat(4_000);
  const meta = requirementDocumentMeta(content, "总体设计.md")!;
  assert.equal(meta.context_mode, "file");
  storeRequirementDocument(workspace, content, meta);
  assert.equal(readFileSync(join(workspace, STORED_REQUIREMENT_DOCUMENT), "utf-8"),
    content, "落盘原文必须逐字保留");

  const repo = join(workspace, "repo");
  mkdirSync(repo);
  const relative = materializeRequirementDocument(repo, content, meta);
  assert.equal(relative, AGENT_REQUIREMENT_DOCUMENT);
  assert.equal(readFileSync(join(repo, relative!), "utf-8"), content);
  const prompt = requirementContext(content, meta, relative);
  assert.match(prompt, /总体设计\.md/);
  assert.match(prompt, /按章节分段阅读/);
  assert.match(prompt, /\.mae-flow-requirement\.md/);
  assert.ok(Buffer.byteLength(prompt) < INLINE_REQUIREMENT_DOCUMENT_BYTES,
    "长文档不能又被完整塞回开场上下文");
});

test("长文档物化拒绝业务仓同名软链，不越界覆盖宿主文件", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-requirement-link-"));
  const outside = join(workspace, "outside.md");
  const repo = join(workspace, "repo");
  mkdirSync(repo);
  writeFileSync(outside, "keep");
  symlinkSync(outside, join(repo, AGENT_REQUIREMENT_DOCUMENT));
  const content = "x".repeat(INLINE_REQUIREMENT_DOCUMENT_BYTES + 1);
  const meta = requirementDocumentMeta(content, "design.md")!;
  assert.throws(() => materializeRequirementDocument(repo, content, meta));
  assert.equal(readFileSync(outside, "utf-8"), "keep");
});

test("任务创建把长文档模式与完整原文一起持久化", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-requirement-task-"));
  const content = "# 架构\n" + "约束。".repeat(
    INLINE_REQUIREMENT_DOCUMENT_BYTES);
  const service = new TaskService({
    dataDir: dir, provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const task = service.create(content, {
    title: "长设计文档任务",
    requirementDocumentName: "architecture.md",
  });
  assert.equal(task.requirement, content);
  assert.equal(task.requirement_document?.name, "architecture.md");
  assert.equal(task.requirement_document?.context_mode, "file");
  assert.ok(existsSync(join(task.workspace, STORED_REQUIREMENT_DOCUMENT)));
  assert.equal(JSON.parse(readFileSync(
    join(task.workspace, "task.json"), "utf-8")).summary.requirement_document.name,
  "architecture.md");
});
