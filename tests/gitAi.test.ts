import test, { after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAiSession } from "../src/gitAi.ts";
import { publicGitAiNote, preserveGitAiNotes } from "../src/gitAiNotes.ts";
import { pushFromIssueWorkspace } from "../src/issueFlow/issueGit.ts";
import { TaskService } from "../src/taskService.ts";
import { prepareTicketRewrite, applyTicketRewrite } from "../src/ticketCorrection.ts";

const original = process.env.MFC_GIT_AI_ENABLED;
before(() => { process.env.MFC_GIT_AI_ENABLED = "1"; });
after(() => { if (original === undefined) delete process.env.MFC_GIT_AI_ENABLED; else process.env.MFC_GIT_AI_ENABLED = original; });
const key = "s_11111111111111::t_22222222222222";
function note(sha: string, lines = "2", file = "sample.txt") {
  return `${JSON.stringify(file)}\n  ${key} ${lines}\n---\n` + JSON.stringify({
    schema_version: "authorship/3.0.0", base_commit_sha: sha, prompts: { sensitive: { messages: "PRIVATE PROMPT" } },
    sessions: { s_11111111111111: { agent_id: { tool: "pi", id: "PRIVATE SESSION", model: "test-model" },
      human_author: "PRIVATE AUTHOR", session_path: "/private/native/session" } },
    private_extra: "PRIVATE EXTRA",
  });
}
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mfc-git-ai-test-")), repo = join(root, "repo"), remote = join(root, "remote.git");
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); git(root, "init", "-q", "--bare", remote);
  writeFileSync(join(repo, "sample.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD"); git(repo, "push", "-q", remote, "main"); git(repo, "checkout", "-qb", "feature-OLD");
  writeFileSync(join(repo, "sample.txt"), "base\nAI one\n"); git(repo, "commit", "-qam", "[OLD][feat] first");
  const sha = git(repo, "rev-parse", "HEAD"); git(repo, "notes", "--ref=ai", "add", "-m", note(sha), sha);
  return { root, repo, remote, base, sha };
}

test("匿名传输仅保留授权字段，拒绝绝对路径及旧 prompt 记录", () => {
  const result = publicGitAiNote(note("a".repeat(40)), "b".repeat(40))!;
  assert.match(result, /test-model/); assert.doesNotMatch(result, /PRIVATE|\/private\/|private_extra/);
  assert.equal(JSON.parse(result.split("\n---\n")[1]).sessions.s_11111111111111.agent_id.id, "s_11111111111111");
  assert.equal(publicGitAiNote(note("a".repeat(40), "2", "/private/path"), "b".repeat(40)), undefined);
  assert.equal(publicGitAiNote(note("a".repeat(40), "2", "../secret"), "b".repeat(40)), undefined);
});

test("Git AI 缺失、异常或日志抛错，不改变原 Bash 的参数和结果", async () => {
  const calls: any[] = [];
  const backend = { exec: async (...args: any[]) => { calls.push(args); if (String(args[0]).startsWith("test -x")) throw new Error("missing"); return { exitCode: 7 }; } };
  const tracker = new GitAiSession(backend, "/tmp", () => { throw new Error("log failed"); });
  await tracker.before({ toolName: "bash", toolCallId: "x", input: { command: "original" } }, { cwd: "/tmp", sessionManager: { getSessionId: () => "session" } });
  const options = { onData: () => {}, signal: new AbortController().signal };
  assert.deepEqual(await tracker.operations().exec("original", "/tmp", options), { exitCode: 7 });
  assert.deepEqual(calls.at(-1), ["original", "/tmp", options]);
  assert.equal(calls[0][2].timeout, undefined, "不能因观察命令销毁编码容器");
  await tracker.after({ toolCallId: "x" });
});

test("错误工具结果仍记录部分修改，且归因载荷不包含原生会话文件或代码正文", async t => {
  const f = fixture(t); const calls: string[] = [];
  const tracker = new GitAiSession({ exec: async command => { calls.push(command); return { exitCode: 0 }; } }, f.repo);
  await tracker.before({ toolName: "edit", toolCallId: "e", input: { path: "sample.txt" } },
    { cwd: f.repo, model: { provider: "test", id: "model" }, sessionManager: { getSessionId: () => "native" } });
  await tracker.after({ toolCallId: "e" });
  assert.ok(calls.some(command => command.includes("after_edit")));
  assert.ok(calls.some(command => command.includes('"session_path":"/dev/null"')));
  assert.ok(calls.every(command => !command.includes("dirty_files")));
});

for (const flow of ["requirement", "issue"] as const) {
  for (const reject of [false, true]) test(`${flow} 真实推送：${reject ? "Notes 被拒仍保留代码成功" : "同步匿名 Notes，重复推送不改已有记录"}`, async t => {
    const f = fixture(t); const logs: string[] = [];
    if (reject) {
      const hook = join(f.remote, "hooks", "update"); writeFileSync(hook, '#!/bin/sh\n[ "$1" != "refs/notes/ai" ]\n'); chmodSync(hook, 0o755);
    }
    let push: () => Promise<any>;
    if (flow === "issue") push = () => pushFromIssueWorkspace({ dataDir: join(f.root, "data"), repoDir: f.repo, repoUrl: f.remote, branch: "feature-OLD", log: text => logs.push(text) });
    else {
      const service: any = new TaskService({ dataDir: join(f.root, "data"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, log: (text: string) => logs.push(text) });
      t.after(() => service.shutdown());
      const summary = service.create("Git AI synthetic transport"); const task = service.tasks.get(summary.id);
      task.cwd = f.repo; task.summary.repo_url = f.remote; task.summary.baseline = "main"; task.summary.status = "running";
      task.summary.delivery = { source_branch: "feature-OLD", target_branch: "main", sha: f.base }; service.removeFromQueue(summary.id);
      push = () => service.pushFromHostTransport(task, "feature-OLD", f.sha);
    }
    assert.equal((await push()).sha, f.sha);
    assert.equal(git(f.root, `--git-dir=${f.remote}`, "rev-parse", "feature-OLD"), f.sha);
    if (reject) {
      assert.ok(logs.some(line => line.includes("Notes 同步未完成")));
      assert.equal(spawnSync("git", [`--git-dir=${f.remote}`, "show-ref", "--verify", "--quiet", "refs/notes/ai"]).status, 1);
    } else {
      const remoteNote = git(f.root, `--git-dir=${f.remote}`, "notes", "--ref=ai", "show", f.sha);
      assert.match(remoteNote, /test-model/); assert.doesNotMatch(remoteNote, /PRIVATE|private_extra/);
      const notesHead = git(f.root, `--git-dir=${f.remote}`, "rev-parse", "refs/notes/ai");
      await push(); assert.equal(git(f.root, `--git-dir=${f.remote}`, "rev-parse", "refs/notes/ai"), notesHead);
    }
  });
}

test("同步保留远端其他任务 Notes，不发送本地无关分支归因", async t => {
  const f = fixture(t);
  git(f.root, `--git-dir=${f.remote}`, "notes", "--ref=ai", "add", "-m", "another task", f.base);
  git(f.repo, "checkout", "-qb", "unrelated", f.base); writeFileSync(join(f.repo, "other.txt"), "unrelated\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "unrelated"); const other = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "notes", "--ref=ai", "add", "-m", note(other, "1", "other.txt"), other); git(f.repo, "checkout", "-q", "feature-OLD");
  await pushFromIssueWorkspace({ dataDir: join(f.root, "data"), repoDir: f.repo, repoUrl: f.remote, branch: "feature-OLD" });
  assert.equal(git(f.root, `--git-dir=${f.remote}`, "notes", "--ref=ai", "show", f.base), "another task");
  assert.doesNotMatch(git(f.root, `--git-dir=${f.remote}`, "notes", "--ref=ai", "list"), new RegExp(other));
});

test("整理多条提交保留各行来源；人工行及工作区不受影响", async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "sample.txt"), "base\nAI one\nAI two\nhuman\n"); git(f.repo, "commit", "-qam", "second");
  const old = git(f.repo, "rev-parse", "HEAD"); git(f.repo, "notes", "--ref=ai", "add", "-m", note(old, "3"), old);
  const tree = git(f.repo, "rev-parse", "HEAD^{tree}"); const rewritten = git(f.repo, "commit-tree", tree, "-p", f.base, "-m", "squashed");
  writeFileSync(join(f.repo, "uncommitted.txt"), "keep me"); const status = git(f.repo, "status", "--porcelain");
  await preserveGitAiNotes(f.repo, new Map([[old, rewritten]]));
  const preserved = git(f.repo, "notes", "--ref=ai", "show", rewritten);
  assert.match(preserved, /  s_11111111111111::t_22222222222222 2-3\n/);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), old); assert.equal(git(f.repo, "status", "--porcelain"), status);
});

test("单号纠正真实重建及恢复入口保留 Notes，坏 Notes 不阻断改写", async t => {
  const f = fixture(t); const plan = await prepareTicketRewrite(f.repo, "OLD", "NEW", f.base);
  await applyTicketRewrite(f.repo, plan); assert.match(git(f.repo, "notes", "--ref=ai", "show", plan.head), /test-model/);
  await applyTicketRewrite(f.repo, plan); assert.equal(git(f.repo, "rev-parse", "HEAD"), plan.head);
  const logs: string[] = []; git(f.repo, "notes", "--ref=ai", "add", "-f", "-m", "malformed", plan.head);
  await preserveGitAiNotes(f.repo, new Map([[plan.head, f.sha]]), text => logs.push(text));
  assert.ok(logs.length); assert.equal(git(f.repo, "rev-parse", "HEAD"), plan.head);
});

test("关闭功能时不发送 Notes，也不改写元数据", async t => {
  const f = fixture(t); process.env.MFC_GIT_AI_ENABLED = "0";
  try {
    await pushFromIssueWorkspace({ dataDir: join(f.root, "data"), repoDir: f.repo, repoUrl: f.remote, branch: "feature-OLD" });
    assert.equal(spawnSync("git", [`--git-dir=${f.remote}`, "show-ref", "--verify", "--quiet", "refs/notes/ai"]).status, 1);
  } finally { process.env.MFC_GIT_AI_ENABLED = "1"; }
});

for (const broken of [false, true]) test(`真实 Pi 主会话和子 Agent ${broken ? "归因失败仍正常完成" : "均调用采集且使用各自会话标识"}`, async t => {
  const { CloudSession } = await import("../src/sessionDriver.ts");
  const { ScriptedModelServer } = await import("../src/scriptedModel.ts");
  const { EventLog } = await import("../src/semanticEvents.ts");
  const { TranscriptStore } = await import("../src/transcriptStore.ts");
  const { GateService } = await import("../src/gateService.ts");
  const { HumanGate } = await import("../src/humanGate.ts");
  const f = fixture(t), commands: string[] = [], logs: string[] = [];
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: "main-command" } } },
    { tool: { name: "Task", input: { subagent_type: "reviewer-agent", description: "验证归因", prompt: "执行子命令" } } },
    { tool: { name: "bash", input: { command: "child-command" } } },
    { text: "子 Agent 完成。" }, { text: "主 Agent 完成。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const agentDir = join(f.root, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  let session: Awaited<ReturnType<typeof CloudSession.create>> | undefined;
  try {
    session = await CloudSession.create({ taskId: "REQ-GIT-AI", workspace: f.repo, agentDir,
      provider: "maeflow", model: "scripted-v1", eventLog: new EventLog(join(f.root, "events.jsonl")),
      transcript: new TranscriptStore(join(f.root, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace: f.repo, cwd: f.repo }), humanGate: new HumanGate(join(f.root, "waiting.json")),
      log: text => logs.push(text), bashOperations: { exec: async command => {
        commands.push(command); return { exitCode: broken && command.includes("'checkpoint'") ? 1 : 0 };
      } },
    });
    const outcome = await session.start("开始"); assert.equal(outcome.status, "turn_finished", outcome.detail);
    const business = commands.filter(command => /(?:^|\n)(main|child)-command$/.test(command));
    assert.equal(business.length, 2);
    if (broken) {
      assert.deepEqual(business, ["main-command", "child-command"]);
      assert.ok(logs.some(line => line.includes("修改前记录未完成")));
    } else {
      const pre = commands.filter(command => command.includes('"hook_event_name":"before_command"'));
      const post = commands.filter(command => command.includes('"hook_event_name":"after_command"'));
      assert.equal(pre.length, 2); assert.equal(post.length, 2);
      assert.ok(pre.every(command => command.includes('"model":"maeflow/scripted-v1"')));
      const sessions = new Set(pre.map(command => /"session_id":"([^"]+)"/.exec(command)?.[1]));
      assert.equal(sessions.size, 2); assert.ok(!sessions.has(undefined));
      assert.ok(business.every(command => command.includes("GIT_TRACE2_EVENT")));
      assert.ok(!logs.some(line => line.startsWith("Git AI ")));
    }
  } finally { session?.dispose(); await model.stop(); }
});
