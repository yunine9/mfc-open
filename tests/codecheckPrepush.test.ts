import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodecheckPrepush, rememberCodecheckBase } from "../src/codecheckPrepush.ts";
import { assertNoCodecheckCommits, excludeCodecheckArtifacts } from "../src/codecheckArtifacts.ts";
import { deliveryChangeSnapshot } from "../src/artifacts.ts";
import { listWorkspaceChanges, workspaceDiffAll, workspaceFileDiff } from "../src/issueFlow/materials.ts";
import { dirtyWorktree } from "../src/issueFlow/issueGit.ts";
import { createIssueTools } from "../src/issueFlow/tools.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
function git(repo: string, ...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "mfc-codecheck-"));
  t.after(() => { execFileSync("chmod", ["-R", "u+rwX", root]); rmSync(root, { recursive: true, force: true }); });
  const repo = join(root, "repo", "origin");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "code.ts"), "export const value = 1;\n");
  git(repo, "add", "code.ts"); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "main_dev_T1_20261029090000");
  const sourceRoot = join(root, "skills");
  mkdirSync(join(sourceRoot, "codecheck-prepush"), { recursive: true });
  writeFileSync(join(sourceRoot, "codecheck-prepush", "SKILL.md"), "---\nname: codecheck-prepush\ndescription: 交付前自查\nknowledge_nature: engineering\ntechnologies: [agnostic]\n---\n上传的检查方法 v1\n");
  const recordRoot = join(root, "codecheck");
  const options = { repo, workspace: root, sourceRoot, recordRoot, base };
  const change = (value: number) => {
    writeFileSync(join(repo, "code.ts"), `export const value = ${value};\n`);
    git(repo, "add", "code.ts"); git(repo, "commit", "-qm", `[T1][fix] value ${value}`);
  };
  return { root, repo, base, sourceRoot, recordRoot, options, change };
}

test("修复 B→C 后复用最终结果；重试、重启与仅改提交信息不会反复修码", async t => {
  const f = fixture(t); f.change(2);
  let calls = 0;
  const run = async (request: any) => { calls++; assert.equal(request.base, f.base); assert.match(request.prompt, /上传的检查方法 v1/); f.change(3); return "CodeCheck 通过"; };
  const [first, concurrent] = await Promise.all([runCodecheckPrepush({ ...f.options, run }), runCodecheckPrepush({ ...f.options, run })]);
  assert.equal(calls, 1); assert.equal(first.head, git(f.repo, "rev-parse", "HEAD")); assert.equal(concurrent.head, first.head);
  for (let i = 0; i < 3; i++) assert.equal((await runCodecheckPrepush({ ...f.options, run })).reused, true);
  git(f.repo, "commit", "--amend", "-qm", "[T1][fix] corrected subject");
  assert.equal((await runCodecheckPrepush({ ...f.options, run })).reused, true);
  assert.equal(calls, 1);
  f.change(4);
  await runCodecheckPrepush({ ...f.options, run: async () => { calls++; return "新代码已检查"; } });
  assert.equal(calls, 2);
});

test("执行异常不变成完成结果；工具恢复可继续，完成结果按 Skill 版本复用", async t => {
  const f = fixture(t); f.change(2); let calls = 0;
  await assert.rejects(runCodecheckPrepush({ ...f.options, run: async () => { calls++; throw new Error("CLI 不可用"); } }), /CLI 不可用/);
  const run = async () => { calls++; return "已检查"; };
  await runCodecheckPrepush({ ...f.options, run }); assert.equal(calls, 2);
  assert.equal((await runCodecheckPrepush({ ...f.options, run })).reused, true);
  assert.equal(calls, 2);
  const path = join(f.sourceRoot, "codecheck-prepush", "SKILL.md");
  writeFileSync(path, readFileSync(path, "utf8") + "v2\n");
  await runCodecheckPrepush({ ...f.options, run }); assert.equal(calls, 3);
});

test("执行中断后的修改和基点保留，恢复后继续检查，不自动跳过", async t => {
  const f = fixture(t); f.change(2);
  await assert.rejects(runCodecheckPrepush({ ...f.options, run: async () => { f.change(3); throw new Error("会话中断"); } }), /会话中断/);
  assert.equal(readFileSync(join(f.repo, "code.ts"), "utf8"), "export const value = 3;\n");
  const result = await runCodecheckPrepush({ ...f.options, run: async request => {
    assert.equal(request.base, f.base); assert.equal(request.head, git(f.repo, "rev-parse", "HEAD")); return "已继续检查";
  } });
  assert.match(result.summary, /已继续检查/); assert.equal(result.head, git(f.repo, "rev-parse", "HEAD"));
  assert.equal((await runCodecheckPrepush({ ...f.options, run: async () => { assert.fail("不能再次检查"); } })).reused, true);
});

test("开工记录固定 base；无记录旧仓按实际目标恢复，缺技能/基点不假报通过", async t => {
  const f = fixture(t); await rememberCodecheckBase(f.recordRoot, f.repo); f.change(2);
  await rememberCodecheckBase(f.recordRoot, f.repo);
  await runCodecheckPrepush({ ...f.options, base: undefined, run: async r => { assert.equal(r.base, f.base); return "已检查"; } });
  const otherRoot = join(f.root, "other-records");
  const result = await runCodecheckPrepush({ ...f.options, recordRoot: otherRoot, base: undefined, target: "main", run: async r => { assert.equal(r.base, f.base); return "已检查"; } });
  assert.equal(result.base, f.base);
  await assert.rejects(runCodecheckPrepush({ ...f.options, recordRoot: join(f.root, "no-base"), base: undefined, run: async () => { assert.fail(); } }), /无法确定修改前/);
  await assert.rejects(runCodecheckPrepush({ ...f.options, recordRoot: join(f.root, "invalid-base"), base: "a".repeat(40), run: async () => { assert.fail(); } }), /不在当前提交历史/);
  const missing = await runCodecheckPrepush({ ...f.options, sourceRoot: undefined, run: async () => { assert.fail(); } });
  assert.match(missing.summary, /没有可用/);
});

test("CodeCheck 目录不被 add -A 纳入；两类变更视图过滤未跟踪/暂存/提交与嵌套路径", async t => {
  const f = fixture(t); f.change(2);
  excludeCodecheckArtifacts(f.repo);
  mkdirSync(join(f.repo, ".codecheckcli"));
  writeFileSync(join(f.repo, ".codecheckcli", "result.json"), "secret report");
  mkdirSync(join(f.repo, "module", ".codecheckcli"), { recursive: true });
  writeFileSync(join(f.repo, "module", ".codecheckcli", "result.json"), "nested report");
  git(f.repo, "add", "-A"); assert.equal(git(f.repo, "diff", "--cached", "--name-only"), "");
  // 即使旧工作区已有强制暂存/提交，读侧仍不展示。
  git(f.repo, "add", "-f", ".codecheckcli/result.json", "module/.codecheckcli/result.json");
  assert.deepEqual(await dirtyWorktree(f.repo), []);
  assert.equal(listWorkspaceChanges(f.repo, "main").some(x => x.path.includes(".codecheckcli")), false);
  assert.equal(workspaceDiffAll(f.repo, "main").includes("report"), false);
  assert.equal(workspaceFileDiff(f.repo, ".codecheckcli/result.json", "main"), "");
  git(f.repo, "commit", "-qm", "accidental runtime files");
  writeFileSync(join(f.repo, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: f.base } }));
  const snapshot = await deliveryChangeSnapshot(f.repo);
  assert.ok(snapshot); assert.equal(snapshot.workspace_paths.some(x => x.includes(".codecheckcli")), false);
  await assert.rejects(assertNoCodecheckCommits(f.repo, f.base), /本地检查产物/);
  git(f.repo, "rm", "-r", ".codecheckcli", "module/.codecheckcli"); git(f.repo, "commit", "-qm", "remove runtime files");
  await assert.rejects(assertNoCodecheckCommits(f.repo, f.base), /本地检查产物/);
});

test("问题单 push_branch 在真实推送前执行 Skill，推送修复后的 HEAD；重推不再修码", async t => {
  const f = fixture(t); f.change(2);
  const remote = join(f.root, "origin.git"); git(f.root, "init", "-q", "--bare", remote);
  const now = new Date().toISOString();
  const state: IssueSessionState = { id: "issue-test", account: "dev", title: "test", description: "", source: "dts", ticket: "T1", repo_url: remote, repo_urls: [remote], baseline: "main", fix_branch: git(f.repo, "branch", "--show-current"), scenario: "ticket", round: 1, stage_states: ["done", "done", "done", "done", "pending"], status: "idle", stage: "mr_green", stage_note: "", created_at: now, updated_at: now, stage_at: now };
  let calls = 0;
  const tools = createIssueTools({ state, workspace: f.root, dataRoot: f.root, persist() {}, pullRepo: async () => { throw new Error("unused"); }, beforePush: async repo => {
    assert.equal(repo.dir, f.repo);
    return (await runCodecheckPrepush({ ...f.options, run: async () => { calls++; f.change(3); return "CodeCheck 通过"; } })).summary;
  } });
  const push = tools.find((tool: any) => tool.name === "push_branch") as { execute: (id: string, params: any) => Promise<unknown> };
  await push.execute("a", {} as any); await push.execute("b", {} as any);
  assert.equal(calls, 1);
  assert.equal(git(remote, "rev-parse", `refs/heads/${state.fix_branch}`), git(f.repo, "rev-parse", "HEAD"));
  assert.equal(state.pushes?.[0].sha, git(f.repo, "rev-parse", "HEAD"));
});

test("需求交付实际接线：上传技能先修复，再人工确认/宿主 push；不改变内核阶段", async t => {
  const { FakeGitPlatform } = await import("../src/gitPlatform.ts");
  const { buildService, deliveryModel, until } = await import("./delivery.helpers.ts");
  const f = fixture(t);
  git(f.repo, "branch", "master", f.base); git(f.repo, "checkout", "-q", "master");
  const platform = new FakeGitPlatform(); platform.initBare(f.repo, join(f.root, "bare")); await platform.start();
  const model = deliveryModel([{ tool: { name: "bash", input: { command: "echo feature > feature.txt" } } }, { text: "实现完成" }], f.root);
  await model.start();
  const service = buildService(platform, f.root, model.modelsJson());
  let calls = 0;
  (service as any).options.codecheck = { runner: async (request: any) => {
    calls++;
    assert.match(request.prompt, /单号：REQ9/);
    assert.match(request.prompt, /当前任务提交规范：/);
    const stateBefore = readFileSync(join(request.repo, ".mae-flow.json"), "utf8");
    writeFileSync(join(request.repo, "checked.txt"), "fixed by uploaded skill");
    git(request.repo, "add", "checked.txt"); git(request.repo, "commit", "-qm", "[REQ9][fix] CodeCheck 修复");
    assert.equal(readFileSync(join(request.repo, ".mae-flow.json"), "utf8"), stateBefore);
    return "CodeCheck 通过";
  } };
  try {
    const created = service.create("交付 REQ9: CodeCheck 自查", { ticket: "REQ9" });
    await until(() => service.get(created.id)!.status === "await_merge", "Skill 修复后继续交付");
    const task = service.get(created.id)!;
    assert.equal(calls, 1, JSON.stringify({codecheck:task.delivery?.codecheck,skills:task.host_skill_snapshot_warnings})); assert.match(task.delivery?.codecheck?.summary ?? "", /通过/);
    assert.equal(platform.branchSha("master_bot_REQ9"), task.delivery?.git_push?.sha);
    assert.equal(git(platform.barePath!, "show", `${task.delivery?.git_push?.sha}:checked.txt`), "fixed by uploaded skill");
    assert.equal(git(platform.barePath!, "ls-tree", "-r", "--name-only", task.delivery!.git_push!.sha).includes(".codecheckcli"), false);
    const internal = (service as any).tasks.get(created.id);
    await (service as any).tryDeliver(internal, internal.controlEpoch);
    assert.equal(calls, 1);
  } finally { await service.shutdown(); await model.stop(); await platform.stop(); }
});

test("问题单服务实际接线：恢复会话的 push_branch 固定调用已上传 Skill", async t => {
  const { ScriptedModelServer } = await import("../src/scriptedModel.ts");
  const { IssueFlowService } = await import("../src/issueFlow/service.ts");
  const f = fixture(t);
  const remote = join(f.root, "origin.git"); git(f.root, "clone", "-q", "--bare", f.repo, remote);
  const issueRoot = join(f.root, "issues", "issue-1");
  const clone = join(issueRoot, "repo", "origin");
  mkdirSync(join(issueRoot, "repo"), { recursive: true }); git(f.root, "clone", "-q", remote, clone);
  const branch = git(clone, "branch", "--show-current");
  const now = new Date().toISOString();
  writeFileSync(join(issueRoot, "issue.json"), JSON.stringify({ id: "issue-1", account: "dev", title: "test", description: "", source: "dts", ticket: "T1", repo_url: remote, repo_urls: [remote], baseline: "main", fix_branch: branch, scenario: "ticket", round: 1, stage_states: ["done", "done", "done", "done", "pending"], status: "running", stage: "mr_green", stage_note: "", created_at: now, updated_at: now, stage_at: now }));
  const model = new ScriptedModelServer([{ tool: { name: "push_branch", input: {} } }, { text: "已推送" }], "scripted-v1", { linear: true });
  await model.start(); let calls = 0;
  const service = new IssueFlowService({ dataDir: f.root, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    codecheck: { runner: async request => {
      calls++; assert.equal(request.base, f.base);
      assert.ok(request.prompt.includes(`当前分支：${branch}`));
      assert.match(request.prompt, /单号：T1/);
      assert.match(request.prompt, /\[T1\]\[fix\]/);
      writeFileSync(join(request.repo, "checked.txt"), "issue fix"); git(request.repo, "add", "checked.txt"); git(request.repo, "commit", "-qm", "[T1][fix] check"); return "CodeCheck 通过";
    } } });
  try {
    const { until } = await import("./delivery.helpers.ts");
    await until(() => service.get("issue-1").status === "idle", "问题单推送完成");
    assert.equal(calls, 1);
    assert.equal(git(remote, "show", `${branch}:checked.txt`), "issue fix");
    const events = readFileSync(join(issueRoot, "events.jsonl"), "utf8");
    assert.match(events, /CodeCheck 通过/);
  } finally { await service.shutdown(); await model.stop(); }
});

test("原生辅助会话收到上传正文且能执行包内 CLI，禁止自行 push", async t => {
  const { ScriptedModelServer } = await import("../src/scriptedModel.ts");
  const { runCodecheckSkillSession } = await import("../src/codecheckSkillSession.ts");
  const { EventLog } = await import("../src/semanticEvents.ts");
  const { TranscriptStore } = await import("../src/transcriptStore.ts");
  const { HumanGate } = await import("../src/humanGate.ts");
  const { dirname } = await import("node:path");
  const f = fixture(t); f.change(2);
  const bin = join(f.sourceRoot, "codecheck-prepush", "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codecheck"), '#!/bin/sh\nprintf "{\\"issues\\":[]}" > "$1"\necho CLI-EXECUTED\n');
  const result = await runCodecheckPrepush({ ...f.options, run: async request => {
    const model = new ScriptedModelServer([
      { tool: { name: "bash", input: { command: `'${join(dirname(request.skillPath), "bin", "codecheck")}' '${join(f.repo, ".codecheckcli", "result.json")}'` } } },
      { tool: { name: "bash", input: { command: "git push origin HEAD" } } },
      { text: "CodeCheck 通过；推送交给宿主" },
    ], "scripted-v1", { linear: true });
    await model.start();
    const agentDir = join(f.root, "pi-agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    try {
      const reply = await runCodecheckSkillSession({}, request, {
        taskId: "native-check", workspace: f.root, agentDir, provider: "maeflow", model: "scripted-v1",
        eventLog: new EventLog(join(f.root, "codecheck", "events.jsonl")),
        transcript: new TranscriptStore(join(f.root, "codecheck", "transcript.jsonl"), "codecheck"),
        humanGate: new HumanGate(join(f.root, "waiting.json")),
      });
      const events = readFileSync(join(f.root, "codecheck", "events.jsonl"), "utf8");
      assert.match(events, /CLI-EXECUTED/); assert.match(events, /禁止.*git push/);
      assert.match(events, /上传的检查方法 v1/);
      return reply;
    } finally { await model.stop(); }
  } });
  assert.match(result.summary, /通过/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.repo, ".codecheckcli", "result.json"), "utf8")), { issues: [] });
});

test("准备 CodeCheck 时取消任务，旧辅助会话退出后不得启动新检查", async t => {
  const { TaskService } = await import("../src/taskService.ts");
  const { CloudSession } = await import("../src/sessionDriver.ts");
  const { trackAuxiliarySession, auxiliarySessionEpoch } = await import("../src/auxiliarySessions.ts");
  const f = fixture(t); f.change(2);
  const service: any = new TaskService({ dataDir: f.root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    isolation: { image: "test", runtime: "docker" } } as any);
  const summary = service.create("检查准备阶段取消", { ticket: "T559" });
  const task = service.tasks.get(summary.id);
  task.cwd = f.repo; task.summary.status = "running";
  const epoch = task.controlEpoch;
  let launches = 0;
  const mock = t.mock.method(CloudSession, "create", async () => { launches++; throw new Error("取消后不能启动检查"); });
  trackAuxiliarySession(task, { abort: async () => { task.controlEpoch++; }, dispose() {} } as any, auxiliarySessionEpoch(task));
  try {
    await assert.rejects(service.checkCodecheckBeforePush(task, epoch, "main"), /任务已停止/);
    assert.equal(launches, 0);
  } finally { mock.mock.restore(); await service.shutdown(); }
});

test("检查不受固定墙钟时限或命令时限压缩；用户取消仍停止会话与推送", async t => {
  const { CloudSession } = await import("../src/sessionDriver.ts");
  const { runCodecheckSkillSession } = await import("../src/codecheckSkillSession.ts");
  const { abortAuxiliarySessions } = await import("../src/auxiliarySessions.ts");
  const f = fixture(t); let launches = 0, aborts = 0, disposed = 0;
  let finish: (value: any) => void = () => {};
  let onStart: () => void = () => {};
  const started = new Promise<void>(resolve => { onStart = resolve; });
  const commandTimeouts: (number | undefined)[] = [];
  let sessionOptions: any;
  const mock = t.mock.method(CloudSession, "create", async options => { sessionOptions = options; return {
    start: async () => { launches++; onStart(); return new Promise(resolve => { finish = resolve; }); },
    abort: async () => { aborts++; finish({ status: "session_ended" }); },
    dispose: () => { disposed++; }, finalReply: () => "不得当作成功",
  } as any; });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const owner = {};
    const work = runCodecheckSkillSession(owner, { repo: f.repo, base: f.base, head: f.base, skillPath: join(f.sourceRoot, "codecheck-prepush", "SKILL.md"), prompt: "run" }, {
      workspace: f.root, bashOperations: { exec: async (_command: string, _dir: string, options: { timeout?: number }) => { commandTimeouts.push(options.timeout); return { exitCode: 0 }; } },
    } as any);
    const cancelled = assert.rejects(work, /会话已停止/);
    await started;
    t.mock.timers.tick(60 * 60_000);
    await Promise.resolve();
    assert.equal(aborts, 0); assert.equal(disposed, 0);
    await sessionOptions.bashOperations.exec("codecheck", f.repo, { timeout: 7200 });
    await sessionOptions.bashOperations.exec("codecheck", f.repo, {});
    assert.deepEqual(commandTimeouts, [7200, undefined]);
    await abortAuxiliarySessions(owner);
    await cancelled;
    assert.equal(launches, 1); assert.equal(aborts, 1); assert.equal(disposed, 1);
  } finally { t.mock.timers.reset(); mock.mock.restore(); }
  const remote = join(f.root, "origin.git"); git(f.root, "init", "-q", "--bare", remote);
  const now = new Date().toISOString();
  const state: IssueSessionState = { id: "cancel", account: "dev", title: "test", description: "", source: "dts", ticket: "T1", repo_url: remote, repo_urls: [remote], baseline: "main", fix_branch: git(f.repo, "branch", "--show-current"), scenario: "ticket", round: 1, stage_states: ["done", "done", "done", "done", "pending"], status: "idle", stage: "mr_green", stage_note: "", created_at: now, updated_at: now, stage_at: now };
  const tools = createIssueTools({ state, workspace: f.root, dataRoot: f.root, persist() {}, pullRepo: async () => { throw new Error("unused"); }, beforePush: async () => "已检查", assertActive: () => { throw new Error("会话已停止"); } });
  const push = tools.find((tool: any) => tool.name === "push_branch") as { execute: (id: string, params: any) => Promise<unknown> };
  await assert.rejects(push.execute("cancel", {}), /会话已停止/);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "");
});
