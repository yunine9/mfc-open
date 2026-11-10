import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes, type IssueRouteOptions } from "../src/issueFlow/routes.ts";
import { shouldNudgeFixed, loadState, saveState } from "../src/issueFlow/state.ts";
import { stageAllowsTool, STAGE_ROUTES, stageBriefLines } from "../src/issueFlow/stageRegistry.ts";
import { issueFixedOpeningPrompt, issueResumePrompt } from "../src/issueFlow/prompt.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import type { RepairMr } from "../src/mrImportTypes.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { bareOrigin, GIT_ENV, until, fastPoll, LoopPlatform } from "./issueFlowFixed.helpers.ts";

const url = "https://codehub.test/team/repo/merge_requests/1288";
const fixture: RepairMr = { url, iid: "1288", title: "已有 MR 的编译修复", repo: "https://codehub.test/team/repo.git",
  source_branch: "feature/existing", target_branch: "master", sha: "a".repeat(40), state: "opened" };
const credential = () => ({ username: "dev", password: "git-token", email: "dev@example.com" });

test("已有 MR 复用原生会话：原分支拉取、红灯修复、真实推送、绿灯收口；不创建单据或 MR", async () => {
  const dataDir = mfcTemp("issue-mr-import-");
  const repo = bareOrigin(dataDir);
  execFileSync("git", ["--git-dir", repo, "branch", fixture.source_branch, "master"], { env: GIT_ENV });
  const head = () => execFileSync("git", ["--git-dir", repo, "rev-parse", fixture.source_branch], { encoding: "utf8" }).trim();
  const firstSha = head();
  const platform = new LoopPlatform();
  await platform.start();
  const scenes: Scene[] = [
    { tool: { name: "pull_repo", input: { url: repo } } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "push_branch", input: { force: true } } },
    { text: "代码已拉取，等待当前提交的流水线结果。" },
    { tool: { name: "bash", input: { command: "cd repo/origin && printf 'fixed\\n' > fix.txt && git add fix.txt && git -c user.name=test -c user.email=t@e commit -qm 'fix pipeline'" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "complete_stage", input: { note: "已修复原 MR，等待流水线", mrs: [repo] } } },
    { text: "修复已推送原分支。" },
    { text: "流水线通过，等待人工审批与合入。" },
  ];
  const model = new ScriptedModelServer(scenes, "scripted-v1", { linear: true });
  await model.start();
  let detailsRead = 0;
  const service = new IssueFlowService({ purpose: "pipeline_repair", dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    settings: fastPoll, platformUrl: platform.baseUrl, gitCredential: credential,
    mrDetails: async () => { detailsRead++; return { ...fixture, repo, sha: head() }; } });
  try {
    const created = await service.importMr(url, "dev");
    assert.equal(created.scenario, "mr_repair");
    assert.equal(created.stage, "mr_green");
    assert.deepEqual(created.stage_states, ["in_progress"]);
    assert.equal(created.ticket, undefined);
    assert.equal(created.pushes, undefined, "导入不能伪造推送记录");
    assert.equal(created.pipelines, undefined, "先拉取 MR 原分支，再启动失败检查");
    assert.equal(created.mrs?.[0]?.url, url);
    assert.equal((await service.importMr(url + "?tab=pipeline", "dev")).id, created.id, "重复接入复用原会话");
    await assert.rejects(service.importMr(url, "other"), /其他成员/);
    const done = await until(() => {
      const state = service.get(created.id);
      if (state.status === "failed") throw new Error(state.error);
      // ADR-0073:mr_repair 修绿总结轮后直接落 archived,idle 只是总结轮
      // 尚未落定时的中间态,两者都算收口完成。
      return state.stage_states?.[0] === "done"
        && (state.status === "idle" || state.status === "archived") ? state : undefined;
    }, "原生 MR 红转绿", 30_000);
    assert.notEqual(head(), firstSha);
    assert.equal(done.pushes?.[0]?.sha, head());
    assert.equal(done.pushes?.[0]?.branch, fixture.source_branch);
    assert.equal(done.pipelines?.[repo]?.status, "success");
    assert.equal(done.gate, undefined, "已有 MR 修复不引入环境验收卡");
    assert.equal(done.mrs?.length, 1);
    assert.equal(done.mrs?.[0]?.url, url);
    assert.equal(platform.seen.some(call => call.method === "POST" && call.url === "/mr"), false);
    assert.ok(platform.seen.some(call => call.url.includes(firstSha)), "直接监看导入的真实提交");
    assert.ok(platform.seen.some(call => call.url.includes(head())), "推送后监看新提交");
    assert.ok(detailsRead >= 3, "推送前再次读取 MR 状态");
    const root = join(dataDir, "pipeline-repairs", created.id);
    const state = loadState(root);
    assert.ok(state);
    assert.equal(state.fix_branch, fixture.source_branch);
    assert.equal(shouldNudgeFixed(state), false);
    assert.match(issueFixedOpeningPrompt(state), /前置.*不适用/);
    assert.match(issueResumePrompt(state, "继续"), /前置调查步骤不适用/);
    assert.ok(issueResumePrompt(state, "继续").includes(fixture.source_branch));
    const events = readFileSync(join(root, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const tool = (name: string) => events.filter(row => row.kind === "tool_finished" && row.payload?.name === name).map(row => row.payload);
    assert.equal(tool("create_mr")[0].is_error, true);
    assert.match(tool("push_branch")[0].result, /不允许强制覆盖/);
    assert.equal(tool("push_branch").at(-1).is_error, false);
    assert.equal(tool("dts_get_ticket").length, 0);
  } finally { await service.shutdown(); await model.stop(); await platform.stop(); }
});

test("导入并发去重且失败不留半成会话，旧场景的工具范围保持原样", async () => {
  let release!: (mr: RepairMr) => void;
  const pending = new Promise<RepairMr>(resolve => { release = resolve; });
  const service = new IssueFlowService({ purpose: "pipeline_repair", dataDir: mfcTemp("issue-mr-lock-"), provider: "maeflow", model: "unused", modelsJson: {}, platformUrl: "http://127.0.0.1:1", gitCredential: credential,
    mrDetails: async () => pending });
  try {
    const first = service.importMr(url, "dev"), duplicate = service.importMr(url, "dev");
    await assert.rejects(service.importMr(url, "other"), /其他成员/);
    release({ ...fixture, state: "closed" });
    await assert.rejects(first, /已关闭或合入/);
    await assert.rejects(duplicate, /已关闭或合入/);
    assert.equal(service.list().length, 0);
    assert.deepEqual(STAGE_ROUTES.mr_repair, ["mr_green"]);
    for (const name of ["create_mr", "request_env", "dts_get_ticket"]) {
      assert.equal(stageAllowsTool("mr_repair", "mr_green", name), false);
      assert.equal(stageAllowsTool("ticket", "mr_green", name), true);
    }
    assert.equal(stageAllowsTool("no_ticket", "conclude", "push_branch"), false);
    assert.equal(stageAllowsTool("ticket", "fix", "push_branch"), false);
    assert.ok(!stageBriefLines("mr_repair", "mr_green", "").at(-1)?.includes("create_mr"));
  } finally { await service.shutdown(); }
});

test("已有 MR 当前提交已经全绿：先拉原分支再核验，无需制造提交或推送", async () => {
  const dataDir = mfcTemp("issue-mr-already-green-"), repo = bareOrigin(dataDir);
  execFileSync("git", ["--git-dir", repo, "branch", fixture.source_branch, "master"], { env: GIT_ENV });
  const sha = execFileSync("git", ["--git-dir", repo, "rev-parse", fixture.source_branch], { encoding: "utf8" }).trim();
  const platform = new LoopPlatform("success"); await platform.start();
  const model = new ScriptedModelServer([
    { tool: { name: "pull_repo", input: { url: repo } } },
    { tool: { name: "complete_stage", input: { note: "核验已有 MR", mrs: [repo] } } },
    { text: "等待已有提交的流水线结果。" },
    { text: "已有提交全绿，无需修改代码。" },
  ], "scripted-v1", { linear: true }); await model.start();
  const service = new IssueFlowService({ purpose: "pipeline_repair", dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl, gitCredential: credential, mrDetails: async () => ({ ...fixture, repo, sha }) });
  try {
    const created = await service.importMr(url, "dev");
    assert.equal(created.pipelines, undefined);
    assert.equal(loadState(join(dataDir, "pipeline-repairs", created.id))?.mr_gate, undefined, "导入本身不代替原阶段核验");
    await until(() => service.get(created.id).stage_states?.[0] === "done" ? true : undefined, "已有提交全绿", 15_000);
    assert.equal(service.get(created.id).pushes, undefined);
    assert.equal(service.get(created.id).gate, undefined);
    assert.equal(service.get(created.id).pipelines?.[repo]?.sha, sha);
    assert.equal(platform.seen.some(call => call.method === "POST" && call.url === "/mr"), false);
  } finally { await service.shutdown(); await model.stop(); await platform.stop(); }
});

test("修绿总结轮落定即归档收口(ADR-0073):终态当场清名单外,现场不再永驻", async () => {
  const dataDir = mfcTemp("issue-mr-archive-"), repo = bareOrigin(dataDir);
  execFileSync("git", ["--git-dir", repo, "branch", fixture.source_branch, "master"], { env: GIT_ENV });
  const sha = execFileSync("git", ["--git-dir", repo, "rev-parse", fixture.source_branch], { encoding: "utf8" }).trim();
  const platform = new LoopPlatform("success"); await platform.start();
  const model = new ScriptedModelServer([
    { tool: { name: "pull_repo", input: { url: repo } } },
    { tool: { name: "complete_stage", input: { note: "核验已有 MR", mrs: [repo] } } },
    { text: "修复核验完成,本次修复总结如下。" },
  ], "scripted-v1", { linear: true }); await model.start();
  const service = new IssueFlowService({ purpose: "pipeline_repair", dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl, gitCredential: credential, mrDetails: async () => ({ ...fixture, repo, sha }) });
  try {
    const created = await service.importMr(url, "dev");
    const root = join(dataDir, "pipeline-repairs", created.id);
    // 名单外堆积(现网 2026-11 同款):导入后、收尾前在场。
    for (const name of ["pi-agent", ".codecheck-home", "skills"]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "payload.bin"), "heavy");
    }
    await until(() => service.get(created.id).status === "archived" ? true : undefined,
      "修绿总结轮后落终态", 15_000);
    const state = loadState(root);
    assert.equal(state?.conclusion?.kind, "delivered", "结论落账");
    assert.equal(state?.mr_repair_closing, undefined, "收口旗子清除");
    for (const name of ["pi-agent", ".codecheck-home", "skills"]) {
      assert.equal(existsSync(join(root, name)), false,
        `${name} 名单外当场清,不等清扫`);
    }
    assert.ok(existsSync(join(root, "issue.json")), "台账保留");
    const events = readFileSync(join(root, "events.jsonl"), "utf-8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.kind === "workspace_reclaimed"
      && event.payload.scope === "loose"), "当场清留痕落事件账");
  } finally { await service.shutdown(); await model.stop(); await platform.stop(); }
});

test("已有 MR 推送前重新核对生命周期，MR 被关闭后不能继续推送", async () => {
  const dataDir = mfcTemp("issue-mr-closed-");
  const repo = bareOrigin(dataDir);
  execFileSync("git", ["--git-dir", repo, "branch", fixture.source_branch, "master"], { env: GIT_ENV });
  const head = () => execFileSync("git", ["--git-dir", repo, "rev-parse", fixture.source_branch], { encoding: "utf8" }).trim();
  const sha = head();
  const model = new ScriptedModelServer([
    { tool: { name: "pull_repo", input: { url: repo } } },
    { tool: { name: "bash", input: { command: "cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m fix" } } },
    { tool: { name: "push_branch", input: {} } },
    { text: "MR 已关闭，停止推送。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  let reads = 0;
  const service = new IssueFlowService({ purpose: "pipeline_repair", dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    platformUrl: "http://127.0.0.1:1", gitCredential: credential,
    mrDetails: async () => ({ ...fixture, repo, sha, state: ++reads === 1 ? "opened" : "closed" }) });
  try {
    const created = await service.importMr(url, "dev");
    await until(() => service.get(created.id).status === "idle" ? true : undefined, "MR 变更后拒推", 15_000);
    assert.equal(head(), sha);
    assert.equal(service.get(created.id).pushes, undefined);
    const events = readFileSync(join(dataDir, "pipeline-repairs", created.id, "events.jsonl"), "utf8");
    assert.match(events, /已有 MR 的状态、仓库或分支已变化/);
  } finally { await service.shutdown(); await model.stop(); }
});

test("导入落盘后进程中断，恢复同一会话和原提交监看，不伪造推送或丢失现场", async () => {
  const dataDir = mfcTemp("issue-mr-recover-"), root = join(dataDir, "pipeline-repairs", "mr-repair-1");
  mkdirSync(root, { recursive: true });
  const repo = bareOrigin(dataDir);
  execFileSync("git", ["--git-dir", repo, "branch", fixture.source_branch, "master"], { env: GIT_ENV });
  const sha = execFileSync("git", ["--git-dir", repo, "rev-parse", fixture.source_branch], { encoding: "utf8" }).trim();
  const mr = { ...fixture, repo, sha };
  mkdirSync(join(root, "repo"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--branch", fixture.source_branch, repo, join(root, "repo", "origin")], { env: GIT_ENV });
  const now = new Date().toISOString();
  saveState(root, { id: "mr-repair-1", account: "dev", created_at: now, updated_at: now, title: fixture.title, description: "修复已有 MR", source: "manual",
    scenario: "mr_repair", imported_mr: mr, repo_url: repo, repo_urls: [repo], baseline: fixture.target_branch,
    fix_branch: fixture.source_branch, stage: "mr_green", stage_states: ["in_progress"], stage_at: now, stage_note: "接入 MR 后中断",
    status: "idle", round: 1, mrs: [{ repo, branch: fixture.source_branch, target: fixture.target_branch, url, title: fixture.title, iid: fixture.iid, at: now }],
    mr_gate: { mrs: [repo], at: now } });
  const prior = JSON.stringify({ ts: now, kind: "prior_import", payload: { url } }) + "\n";
  writeFileSync(join(root, "events.jsonl"), prior);
  const platform = new LoopPlatform("success"); await platform.start();
  const model = new ScriptedModelServer([{ text: "原 MR 流水线已通过，等待人合入。" }], "scripted-v1", { linear: true }); await model.start();
  const service = new IssueFlowService({ purpose: "pipeline_repair", dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl, gitCredential: credential });
  try {
    await until(() => service.get("mr-repair-1").stage_states?.[0] === "done" ? true : undefined, "导入后中断恢复", 15_000);
    assert.equal(service.list().length, 1);
    assert.equal(service.get("mr-repair-1").pushes, undefined);
    assert.equal(service.get("mr-repair-1").pipelines?.[repo]?.sha, sha);
    assert.ok(readFileSync(join(root, "events.jsonl"), "utf8").startsWith(prior));
  } finally { await service.shutdown(); await model.stop(); await platform.stop(); }
});

function post(payload: unknown, options: IssueRouteOptions) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request: any = new EventEmitter(); request.method = "POST"; request.url = "/pipeline-repairs";
    let status = 0;
    void handleIssueRoutes(request, { writeHead: (code: number) => { status = code; }, end: (text: string) => resolve({ status, body: JSON.parse(text) }) } as any,
      ["pipeline-repairs"], options).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload))); request.emit("end");
  });
}

test("原生导入路由使用登录身份，拒绝匿名、管理员与需求任务正在管理的 MR", async () => {
  const seen: unknown[] = [];
  const service = { options: { purpose: "pipeline_repair" }, importMr: async (...args: unknown[]) => { seen.push(args); return { id: "issue-1" }; } } as unknown as IssueFlowService;
  const base = { issueFlow: service, authEnabled: true };
  assert.equal((await post({ mr_url: url }, base)).status, 401);
  assert.equal((await post({ mr_url: url }, { ...base, viewer: { username: "admin", role: "admin" } })).status, 403);
  const dev = { ...base, viewer: { username: "dev", role: "developer" as const } };
  assert.equal((await post({ mr_url: url }, { ...dev, managedMr: () => "原任务正在处理" })).status, 409);
  const response = await post({ mr_url: url, account: "other" }, dev);
  assert.equal(response.status, 201);
  assert.deepEqual(seen, [[url, "dev"]]);
});
