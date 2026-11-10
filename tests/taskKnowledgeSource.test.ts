import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { KnowledgeTrace, knowledgeUsageSnapshot } from "../src/knowledgeTrace.ts";
import { readTaskKnowledgeSource } from "../src/taskKnowledgeSource.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

function fixture(path = "repo/CLAUDE.md") {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-knowledge-source-"));
  const ref = { id: "rules:guide", name: "CLAUDE.md", kind: "rules" as const, path };
  const trace = new KnowledgeTrace(join(workspace, "knowledge-events.jsonl"), "task-1", workspace);
  trace.record("loaded", "main", ref);
  return { workspace, usage: knowledgeUsageSnapshot({ workspace }), resourceId: ref.id };
}

test("知识原文只读已登记资源，内容变更有版本提示", () => {
  const options = fixture();
  mkdirSync(join(options.workspace, "repo"));
  writeFileSync(join(options.workspace, "repo/CLAUDE.md"), "# 任务规则\n先检查接口");
  const row = options.usage!.resources[0];
  row.digest = createHash("sha256").update("旧规则").digest("hex");
  const result = readTaskKnowledgeSource(options);
  assert.match(result.content, /任务规则/);
  assert.equal(result.version_changed, true);
  assert.throws(() => readTaskKnowledgeSource({ ...options, resourceId: "repo/CLAUDE.md" }), /不在本任务/);
});

test("知识原文不能借路径越界或软链接读取其他任务文件", () => {
  const secret = fixture();
  writeFileSync(join(secret.workspace, "private.md"), "其他任务的原文");
  const outside = fixture(join(secret.workspace, "private.md"));
  assert.throws(() => readTaskKnowledgeSource(outside), /原文已不在/);
  const linked = fixture("linked.md");
  symlinkSync(join(secret.workspace, "private.md"), join(linked.workspace, "linked.md"));
  assert.throws(() => readTaskKnowledgeSource(linked), /原文已不在/);
});

test("宿主加载的规则可按确切登记路径查看，不开放宿主其他文档", () => {
  const host = mkdtempSync(join(tmpdir(), "mfc-host-rules-"));
  writeFileSync(join(host, "CLAUDE.md"), "# 宿主规则");
  const options = fixture(`${basename(host)}/CLAUDE.md`);
  assert.match(readTaskKnowledgeSource({ ...options, hostRulesRoot: host }).content, /宿主规则/);
  writeFileSync(join(host, "private.md"), "私有文件");
  const denied = fixture(`${basename(host)}/private.md`);
  assert.throws(() => readTaskKnowledgeSource({ ...denied, hostRulesRoot: host }), /原文已不在/);
});

test("知识原文 API 从任务知识 ID 读取，缺失资源给出可见原因", async (t) => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "mfc-knowledge-api-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("查看本任务知识");
  const repo = join(task.workspace, "repo");
  mkdirSync(join(repo, ".mae-flow-work"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "# 原文\n已保留");
  const trace = new KnowledgeTrace(join(task.workspace, "knowledge-events.jsonl"), task.id, repo);
  trace.record("loaded", "main", { id: "rules:CLAUDE.md", name: "CLAUDE.md", kind: "rules", path: "CLAUDE.md" });
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await service.shutdown(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks/${task.id}/knowledge-source?resource=`;
  const response = await fetch(url + encodeURIComponent("rules:CLAUDE.md"));
  assert.equal(response.status, 200);
  assert.match((await response.json() as { content: string }).content, /已保留/);
  const missing = await fetch(url + "unknown");
  assert.equal(missing.status, 404);
  assert.match((await missing.json() as { error: string }).error, /不在本任务/);
});
