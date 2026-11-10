import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequirementAnalysisGateContract } from "../src/requirementAnalysisGate.ts";
import { GateService } from "../src/gateService.ts";
import { prepareReviewReplyFile, taskAgentMaterialInstructions } from "../src/taskAgentFiles.ts";
import { observeMrDiscussions } from "../src/mrDiscussions.ts";
import { TaskService } from "../src/taskService.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

test("分析门禁只额外开放指定回执：同目录其他文件、别的任务及软链越界仍拒绝", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-agent-files-"));
  const cwd = join(workspace, "repositories");
  const artifacts = join(cwd, ".mae-flow-work", "任务 2");
  const receipts = join(workspace, "reviews", "local-receipts.json");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(join(workspace, "reviews"));
  const gate = new GateService({ workspace, cwd,
    contract: createRequirementAnalysisGateContract(cwd, artifacts, undefined, receipts) });
  const write = (path: string) => gate.decide({
    eventId: 1, taskId: "task-2", sessionId: "main", ts: new Date().toISOString(), kind: "tool_requested",
    payload: { name: "Write", call_id: "write", input: { path, content: "{}" } },
  } as SemanticEvent);
  assert.equal(write(receipts).action, "allow");
  assert.equal(write(join(artifacts, "requirement-graph.json")).action, "allow");
  for (const path of [join(workspace, "reviews", "other.json"),
    join(workspace, "task.json"), join(cwd, "src", "main.ts"),
    join(workspace, "..", "task-3", "reviews", "local-receipts.json")]) {
    assert.equal(write(path).action, "deny", path);
  }
  symlinkSync(join(workspace, "..", "other-task-receipts.json"), receipts);
  assert.equal(write(receipts).action, "deny", "拼写正确不能绕过真实路径边界");
});

test("材料绝对路径不受 Bash cd 影响；MR 回复准备保留文件与 inode", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-任务 空格-"));
  const cwd = join(workspace, "repositories", ".mae-flow-work", "task-2");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(workspace, "reviews"));
  const receipts = join(workspace, "reviews", "local-receipts.json");
  assert.ok(taskAgentMaterialInstructions(workspace).includes(JSON.stringify(receipts)));
  execFileSync("sh", ["-c", 'cd .. && printf "%s" "$2" > "$1"', "receipt-writer",
    receipts, '{"receipts":[]}'], { cwd });
  assert.equal(readFileSync(receipts, "utf-8"), '{"receipts":[]}');
  const replies = prepareReviewReplyFile(workspace);
  writeFileSync(replies, "[discussion-1]\n已处理");
  const inode = statSync(replies).ino;
  prepareReviewReplyFile(workspace);
  assert.equal(statSync(replies).ino, inode, "容器挂载的文件不能被替换");
  assert.equal(readFileSync(replies, "utf-8"), "[discussion-1]\n已处理");
});

test("持续检视反馈批次的派单路径与服务端消费路径一致，不随 cwd 变化", async () => {
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-feedback-path-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const summary = service.create("回执定位");
  const task = service.tasks.get(summary.id);
  try {
    task.cwd = join(summary.workspace, "repositories", ".mae-flow-work", "task-2");
    mkdirSync(task.cwd, { recursive: true });
    const batchId = "batch-with-spaces 2";
    writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ delivery_loop: {
      active_batch_id: batchId, batches: [{ batch_id: batchId,
        items: [{ id: "build-1", source: "build_fix", summary: "修复编译" }] }],
    } }));
    const path = service.feedbackResultPath(task, batchId);
    assert.ok(service.activeFeedbackReceiptInstructions(task).includes(JSON.stringify(path)));
    assert.doesNotMatch(service.activeFeedbackReceiptInstructions(task), /\.\.\/feedback/);
    assert.equal(readFileSync(path, "utf-8"), "");
  } finally {
    await service.shutdown();
  }
});

test("远端意见同步与回复草稿准备保持挂载 inode，保留需求图片及另一条检视回执", async () => {
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-review-mount-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const summary = service.create("挂载目录不能换 inode");
  const task = service.tasks.get(summary.id);
  try {
    const reviews = join(summary.workspace, "reviews");
    const asset = join(reviews, "assets", "image.png");
    const receipts = join(reviews, "local-receipts.json");
    mkdirSync(join(reviews, "assets"), { recursive: true });
    writeFileSync(asset, "input-image");
    writeFileSync(receipts, "existing-receipt");
    const directoryInode = statSync(reviews).ino;
    // 确认制(ADR-0032):远端意见只观察入账不派单,reviews 目录与其
    // 既有资产(需求图片、其他回执)原样保留,不换 inode。
    task.summary.repo_url = "https://example.invalid/repo.git";
    observeMrDiscussions(summary.workspace, "a".repeat(40),
      [{ id: "review-1", body: "检查空值", revision: 1 }]);
    assert.equal(statSync(reviews).ino, directoryInode);
    assert.equal(readFileSync(asset, "utf-8"), "input-image");
    assert.equal(readFileSync(receipts, "utf-8"), "existing-receipt");
    const replies = prepareReviewReplyFile(summary.workspace);
    const replyInode = statSync(replies).ino;
    writeFileSync(replies, "[review-1]\n已补充空值处理及检验。");
    task.summary.delivery = {
      sha: "a".repeat(40),
      loop: { kind: "review", review_ids: "review-1:r1" },
    };
    task.cwd = summary.workspace;
    service.prePushRevision = async () => ({ sha: "a".repeat(40) });
    assert.deepEqual(await service.stageReviewReplies(task), { ok: true });
    assert.equal(statSync(replies).ino, replyInode);
    assert.equal(readFileSync(replies, "utf-8"), "", "已入发送账的草稿原地清空");
  } finally {
    await service.shutdown();
  }
});
