import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { listArtifactsAsync, readArtifactAsync, bundleArtifactDocuments } from "../src/artifacts.ts";

test("失败需求超过保留期，清扫和服务重启都保留恢复现场", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-failed-retention-")), workspace = join(dataDir, "task-1"), cwd = join(workspace, "orders");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(workspace, "pi-agent"));
  writeFileSync(join(cwd, "pending.cpp"), "还未推送的修改");
  writeFileSync(join(workspace, "pi-agent", "session.jsonl"), "恢复所需会话");
  writeFileSync(join(workspace, "task.json"), JSON.stringify({ cwd, summary: {
    id: "task-1", ticket: "REQ1", requirement: "待恢复需求", status: "failed", workspace,
    repo_url: "https://example.test/orders.git", created_at: "2026-08-01T00:00:00Z", completed_at: "2026-08-02T00:00:00Z",
  } }));
  const options = { dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dataDir, "no-kernel") }, workspaceRetentionDays: 14 };
  const services: TaskService[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const service = new TaskService(options); services.push(service);
      assert.equal(service.recover().restored, 1);
      assert.equal(service.reclaimIdleWorkspaces(Date.parse("2026-10-13T00:00:00Z")).reclaimed, 0);
      assert.equal(service.get("task-1")!.status, "failed");
      assert.equal(service.get("task-1")!.workspace_reclaimed_at, undefined);
      assert.equal(readFileSync(join(cwd, "pending.cpp"), "utf8"), "还未推送的修改");
      assert.equal(readFileSync(join(workspace, "pi-agent", "session.jsonl"), "utf8"), "恢复所需会话");
    }
  } finally { for (const service of services) await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("归档需求回收代码后及服务重启后，原任务仍可列出、阅读和下载文稿，需求原文与修订不丢失", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-archived-documents-")), workspace = join(dataDir, "task-1"), cwd = join(workspace, "orders");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const materials = join(cwd, ".mae-flow-work", "REQ1");
  mkdirSync(materials, { recursive: true });
  mkdirSync(join(workspace, "requirement-history"));
  writeFileSync(join(workspace, "requirement-input.md"), "完整需求原文");
  writeFileSync(join(workspace, "requirement-history", "revision.before.md"), "原始修订全文");
  writeFileSync(join(materials, ".ticket-id"), "REQ1");
  writeFileSync(join(materials, "spec.md"), "# 约束\n不能丢掉的原文");
  writeFileSync(join(materials, "story.md"), "# Story\n交付故事");
  writeFileSync(join(workspace, "交付报告.md"), "交付报告全文");
  writeFileSync(join(cwd, "main.cpp"), "代码可以回收");
  writeFileSync(join(workspace, "task.json"), JSON.stringify({ cwd, summary: {
    id: "task-1", ticket: "REQ1", requirement: "完整需求原文", status: "completed", workspace,
    delivery: { mr_state: "已合入", mr_url: "https://example.test/mr/1" },
    repo_url: "https://example.test/orders.git", created_at: "2026-08-01T00:00:00Z", completed_at: "2026-08-02T00:00:00Z",
  } }));
  const options = { dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dataDir, "no-kernel") }, workspaceRetentionDays: 14 };
  const service = new TaskService(options), services = [service];
  try {
    assert.equal(service.recover().restored, 1);
    assert.equal(service.reclaimIdleWorkspaces(Date.parse("2026-10-13T00:00:00Z")).reclaimed, 1);
    assert.equal(existsSync(cwd), false);
    const restarted = new TaskService(options); services.push(restarted); assert.equal(restarted.recover().restored, 1);
    for (const reader of services) {
      assert.equal(reader.get("task-1")!.status, "completed");
      assert.ok(reader.get("task-1")!.workspace_reclaimed_at);
      const root = reader.artifactRoot("task-1"), sources = { taskMaterialRoot: workspace };
      const documents = await listArtifactsAsync(root, sources, "doc");
      assert.ok(documents.some(document => document.name === "REQ1/spec.md"));
      assert.ok(documents.some(document => document.name === "REQ1/story.md"));
      assert.ok(documents.some(document => document.name === "task-materials/交付报告.md"));
      assert.equal((await readArtifactAsync(root, "REQ1/spec.md", sources))?.content, "# 约束\n不能丢掉的原文");
      assert.ok(bundleArtifactDocuments(root, sources));
      assert.equal(readFileSync(join(workspace, "requirement-input.md"), "utf8"), "完整需求原文");
      assert.equal(readFileSync(join(workspace, "requirement-history", "revision.before.md"), "utf8"), "原始修订全文");
    }
  } finally { for (const item of services) await item.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});
