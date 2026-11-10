import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveAnalysisContextSnapshot } from "../src/analysisContextSnapshot.ts";

test("保存实际会话输入和版本，重启同一会话不覆盖旧快照", async t => {
  const root = await mkdtemp(join(tmpdir(), "analysis-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
  const sha = "a".repeat(40);
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, ".git", "refs", "heads", "main"), sha);
  const input = {
    eventLogPath: join(root, "events.jsonl"), platformRoot: root,
    taskId: "task-1", sessionId: "child-1", provider: "gateway", model: "model-a", step: "编码",
    session: {
      systemPrompt: "实际系统提示",
      getAllTools: () => [{ name: "read", description: "按段读取", parameters: { type: "object" } }, { name: "bash" }],
      getActiveToolNames: () => ["read"],
    },
    agentsFiles: [{ path: "AGENTS.md", content: "仓库真实要求" }],
  };
  const first = await saveAnalysisContextSnapshot(input);
  const second = await saveAnalysisContextSnapshot(input);
  assert.ok(first && second);
  assert.notEqual(first, second);
  const data = JSON.parse(await readFile(first, "utf8"));
  assert.equal(data.system_prompt, "实际系统提示");
  assert.equal(data.agents_files[0].content, "仓库真实要求");
  assert.equal(data.agents_files[0].digest, createHash("sha256").update("仓库真实要求").digest("hex"));
  assert.equal(data.tools[0].active, true);
  assert.equal(data.tools[1].active, false);
  assert.deepEqual(data.tools[0].parameters, { type: "object" });
  assert.equal(data.platform_version.git_head, sha);
  assert.match(data.platform_version.source, /deployment_version_unconfirmed/);
  assert.equal((await stat(first)).mode & 0o777, 0o600);
  assert.equal((await readdir(join(root, "analysis-context"))).length, 2);
});

test("SDK mock 缺少观测方法时保留未知而不编造上下文", async t => {
  const root = await mkdtemp(join(tmpdir(), "analysis-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await saveAnalysisContextSnapshot({
    eventLogPath: join(root, "events.jsonl"), platformRoot: root,
    taskId: "task-1", sessionId: "main", provider: "gateway", model: "model", session: {},
  });
  assert.ok(path);
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.equal(data.system_prompt, null);
  assert.equal(data.tools, null);
  assert.equal(data.agents_files, null);
  assert.equal(data.platform_version.git_head, null);
});

test("拒绝符号链接输出目录，失败不影响任务或抛出原始异常", async t => {
  const root = await mkdtemp(join(tmpdir(), "analysis-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  const task = join(root, "task");
  await mkdir(outside);
  await mkdir(task);
  await symlink(outside, join(task, "analysis-context"));
  const logs: string[] = [];
  const result = await saveAnalysisContextSnapshot({
    eventLogPath: join(task, "events.jsonl"), platformRoot: root,
    taskId: "task-1", sessionId: "main", provider: "gateway", model: "model", session: {},
    log: text => logs.push(text),
  });
  assert.equal(result, undefined);
  assert.equal(logs.length, 1);
  assert.deepEqual(await readdir(outside), []);
});

test("SDK getter 异常和日志异常都只让本次快照缺失", async () => {
  const result = await saveAnalysisContextSnapshot({
    eventLogPath: "/unused/events.jsonl", taskId: "task-1", sessionId: "main", provider: "gateway", model: "model",
    session: { get systemPrompt(): string { throw new Error("敏感内容不应进入日志"); } },
    log: () => { throw new Error("log unavailable"); },
  });
  assert.equal(result, undefined);
});

test("快照脱敏且不序列化 session 中的认证对象", async t => {
  const root = await mkdtemp(join(tmpdir(), "analysis-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = {
    systemPrompt: "业务要求；api_key=sample-private-value",
    auth: { privateValue: "must-not-serialize-session-auth" },
  };
  const path = await saveAnalysisContextSnapshot({
    eventLogPath: join(root, "events.jsonl"), platformRoot: root,
    taskId: "task-1", sessionId: "main", provider: "gateway", model: "model", session,
  });
  assert.ok(path);
  const text = await readFile(path, "utf8");
  assert.ok(!text.includes("sample-private-value"));
  assert.ok(!text.includes("must-not-serialize-session-auth"));
  const data = JSON.parse(text);
  assert.equal(data.capture_stage, "session_created");
  assert.match(data.note, /不代表每轮动态扩展/);
  assert.match(data.system_prompt, /REDACTED/);
});
