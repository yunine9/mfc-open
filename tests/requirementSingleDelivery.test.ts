import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskService } from "../src/taskService.ts";
import { writeStoryArtifacts } from "./requirementGraphFixture.ts";
import { recoverTaskCwd } from "../src/taskWorkspaceRecovery.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { mainTaskDeliveryContext } from "../src/requirementSingleDelivery.ts";
import { isMainTaskDelivery } from "../src/requirementDecisionContract.ts";
import { readArchitectureStory } from "../src/storyArchitectureSource.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { compileWorkflow } from "../src/workflowCompiler.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import type { AddressInfo } from "node:net";
import { resolveWorkflowAssets } from "../src/workflowAssetResolution.ts";

function fixture(t: any, candidates = 1, autoArchitecture = false) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-single-delivery-"));
  const options = { autoArchitecture, dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dir, "no-kernel") }, projection: { upsertTask: async () => {}, deleteTask: async () => {} } as any };
  const service = new TaskService(options), services = [service];
  t.after(async () => { for (const item of services) await item.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const repos = Array.from({ length: candidates }, (_, i) => join(dir, `repo-${i}`));
  const parent = service.create("一个任务完成整个需求", { repos, requirementAnalysis: candidates === 1, account: "owner", ticket: "REQ-ANALYSIS" });
  const internal = service as any, state = internal.tasks.get(parent.id);
  state.cwd = join(parent.workspace, "repositories");
  const code = join(state.cwd, `${candidates}-repo-${candidates - 1}`);
  execFileSync("git", ["init", "-q", "-b", "master", code]);
  writeFileSync(join(code, "README.md"), "原始代码\n");
  const definition = {
    repository_assessments: repos.map((url, i) => ({ name: `repo-${i}`, url,
      outcome: i === candidates - 1 ? "change_required" : "no_change", reason: "已核对代码" })),
    repositories: [{ id: "only", name: "业务模块", url: repos.at(-1), responsibility: "完整实现并验证需求", scope: { name: "完整需求" } }],
    dependencies: [],
  };
  writeStoryArtifacts(join(state.cwd, ".mae-flow-work", "REQ-ANALYSIS"), "REQ-ANALYSIS", "# 已确认设计\n一个任务即可完整交付。\n", definition);
  internal.refreshRequirementGraph(state);
  const waiting = state.humanGate.createWaiting({ taskId: parent.id, step: "requirement-analysis", callId: "confirm-single",
    questionInput: { questions: [{ question: "是否确认方案？", options: ["确认并生成任务", "需要修改"] }] } });
  state.summary.waiting = waiting; state.summary.status = "waiting_for_human";
  internal.sealRequirementGraphReview(state, waiting);
  const confirm = () => service.confirmRequirementGraph(parent.id, {
    repository_assignees: { only: "developer" }, repository_tickets: { only: "REQ-DELIVERY" },
  });
  const recover = () => { const restored = new TaskService(options); services.push(restored); restored.recover(); return restored; };
  return { service, internal, state, parent, repos, code, confirm, recover, waiting };
}

test("单单元继续开发只为首次发布的分析 Story 自动补图一次，重启不重试", async t => {
  const f = fixture(t, 1, true);
  let calls = 0;
  const coordinator = f.service.overallStories;
  (coordinator as any).options.run = async (_task: unknown, job: import("../src/overallStory.ts").StoryRun) => {
    calls++;
    assert.equal(job.architectureOnly, true);
    assert.match(job.before, /已确认设计/);
    throw new Error("自动架构任务失败");
  };
  await f.confirm();
  await coordinator.settled(f.parent.id);
  assert.equal(calls, 1);
  assert.equal(coordinator.status(f.parent.id).error, "自动架构任务失败");
  const revision = coordinator.status(f.parent.id).current;
  await f.confirm();
  const restored = f.recover();
  assert.equal(restored.overallStories.status(f.parent.id).current, revision);
  assert.equal(restored.overallStories.status(f.parent.id).error, "自动架构任务失败");
  assert.equal(restored.overallStories.status(f.parent.id).job, undefined);
  assert.equal(calls, 1);
});

for (const candidates of [1, 2]) test(`${candidates} 个候选仓收敛为一个交付单元：确认后原任务继续，重复确认和重启不建子任务`, async t => {
  const f = fixture(t, candidates);
  assert.equal(f.internal.autoAnswerFor(f.state, true), undefined,
    "月光模式也不能代责任人同意不拆分的最终方案");
  const result = await f.confirm();
  assert.equal(f.service.list().length, 1, "单个交付单元不新增子任务");
  assert.equal(result.id, f.parent.id);
  assert.equal(result.status, "queued");
  assert.equal(result.parent_task_id, undefined);
  assert.equal(result.luban_account, "developer");
  assert.equal(result.ticket, "REQ-DELIVERY");
  assert.equal(result.repo_url, f.repos.at(-1));
  assert.deepEqual(result.repositories, [f.repos.at(-1)]);
  assert.equal(result.requirement_analysis_requested, undefined);
  assert.equal(result.requirement_graph?.repository_assessments?.length, candidates, "仍保留所有候选仓排查结论");
  assert.equal(result.requirement_graph?.repositories[0].task_id, result.id);
  assert.equal(f.internal.isRequirementAnalysis(f.state), false);
  assert.equal(f.state.cwd, f.code, "沿用已分析的实际开发仓，不能把聚合分析目录交给内核");
  assert.equal(readFileSync(join(f.code, "README.md"), "utf8"), "原始代码\n");
  assert.match(readFileSync(join(result.workspace, "chain-plan.md"), "utf8"), /已确认设计/);
  assert.match(readFileSync(join(result.workspace, "unit-brief.md"), "utf8"), /已确认|已经确认/);
  assert.equal(f.state.summary.waiting, undefined);
  const prompt = mainTaskDeliveryContext(result, f.code);
  assert.match(prompt, /不重新进行拆分分析/);
  const decisions = JSON.parse(readFileSync(join(f.code, ".mae-flow-work", "REQ-DELIVERY", "inherited-decisions.json"), "utf8"));
  assert.ok(decisions.records.some((record: any) => record.text.includes("确认方案")));
  await f.confirm();
  assert.equal(f.service.list().length, 1);
  const restored = f.recover();
  const saved = restored.get(result.id)!;
  assert.equal(saved.status, "queued");
  assert.equal(restored.list().length, 1);
  assert.equal((restored as any).tasks.get(result.id).cwd, f.code);
  assert.equal(recoverTaskCwd(saved, saved.workspace, f.code), f.code);
  assert.equal((restored as any).isRequirementAnalysis((restored as any).tasks.get(result.id)), false);
});

test("单单元确认必须先停止分析资源，清理失败不启动开发，重试保持同一任务", async t => {
  const f = fixture(t);
  let stops = 0;
  f.state.container = { stop: async () => { if (++stops === 1) throw new Error("模拟分析容器未停止"); } };
  await f.confirm();
  assert.equal(f.service.get(f.parent.id)?.status, "failed");
  assert.equal(f.service.list().length, 1);
  assert.ok(!f.internal.queue.includes(f.parent.id));
  assert.equal(f.internal.isRequirementAnalysis(f.state), true);
  await f.confirm();
  assert.equal(stops, 2);
  assert.equal(f.service.get(f.parent.id)?.status, "queued");
  assert.equal(f.service.list().length, 1);
});

test("在主任务交付后从头重跑：沿用负责人及协作者，不把自己当作子任务", async t => {
  const f = fixture(t);
  await f.confirm();
  f.state.summary.status = "failed";
  const restarted = await f.service.rerunFromStart(f.parent.id);
  assert.equal(restarted.id, f.parent.id);
  assert.equal(restarted.status, "queued");
  assert.equal(restarted.luban_account, "developer");
  assert.deepEqual(restarted.collaborators, ["owner"]);
  assert.equal(restarted.ticket, "REQ-DELIVERY");
  assert.equal(f.service.list().length, 1);
  assert.equal(f.internal.isRequirementAnalysis(f.internal.tasks.get(restarted.id)), false);
});

test("交接状态落盘失败保留分析现场，不以未保存的新身份启动，重试不生成子任务", async t => {
  const f = fixture(t, 2);
  const persist = f.internal.persist.bind(f.internal);
  let failOnce = true;
  f.internal.persist = (state: any, strict?: boolean, ...rest: any[]) => {
    if (strict && state.summary.status === "queued" && failOnce) {
      failOnce = false; throw new Error("模拟交接状态落盘失败");
    }
    return persist(state, strict, ...rest);
  };
  const result = await f.confirm();
  assert.equal(result.status, "failed");
  assert.equal(f.internal.isRequirementAnalysis(f.state), true);
  assert.equal(result.ticket, "REQ-ANALYSIS");
  assert.deepEqual(result.repositories, f.repos);
  assert.ok(!f.internal.queue.includes(f.parent.id));
  await f.confirm();
  assert.equal(f.service.get(f.parent.id)?.status, "queued");
  assert.equal(f.state.cwd, f.code);
  assert.equal(f.service.list().length, 1);
});

test("单单元继续开发后：过程文档与批注读取开发 Story，保留已确认的分析方案", async t => {
  const f = fixture(t);
  await f.confirm();
  assert.match(readArchitectureStory(f.state.summary, f.service.artifactRoot(f.parent.id))!.content, /已确认设计/);
  const storyDir = join(f.code, ".mae-flow-work", "REQ-DELIVERY");
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, "story.md"), "# 开发阶段设计\n实际实现细节。\n");
  const auth = new LocalAuth(join(f.parent.workspace, "test-auth.json"));
  auth.bootstrapAdmin("admin", "test-password-455");
  const server = createTaskServer(f.service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "test-password-455" }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
  const response = await fetch(`${base}/tasks/${f.parent.id}/artifacts?kind=doc`, { headers });
  assert.equal(response.status, 200);
  const docs = await response.json() as Array<{ name: string }>;
  assert.ok(docs.some(item => item.name === "REQ-DELIVERY/story.md"), JSON.stringify(docs));
  assert.ok(docs.some(item => item.name === "task-materials/overall-story.md"));
  assert.match(f.internal.annotationArtifactContent(f.state, "REQ-DELIVERY/story.md"), /实际实现细节/);
  assert.match((await f.internal.annotationArtifactContentAsync(f.state, "REQ-DELIVERY/story.md")), /实际实现细节/);
  assert.match(readArchitectureStory(f.state.summary, f.service.artifactRoot(f.parent.id))!.content, /实际实现细节/);
});

test("候选仓收敛后重编执行方案，只使用实际开发仓的固定 Skill", async t => {
  const f = fixture(t, 2);
  f.service.options.host!.kernelRoot = discoverKernelRoot(process.cwd())!;
  const standard = f.service.launchOptions().workflow_standard!;
  const stage = standard.stages.find(item => item.id === "platform.construction")!;
  const skills = f.repos.map((repository, i) => ({ id: `skill-${i}`, repository, revision: "fixed-revision", name: `skill-${i}`, description: "仓库专用测试技能",
    relative_path: `.claude/skills/skill-${i}/SKILL.md`, source: ".claude", digest: "c".repeat(64) }));
  const definition = { schema: "mae-flow-workflow-definition/1", base: { standard_id: standard.standard_id,
    standard_version: standard.standard_version, catalog_digest: standard.catalog_digest },
    applicability: { repositories: f.repos, technologies: [], business_module_ids: [] },
    edits: skills.map(skill => ({ edit_id: skill.id, stage_id: stage.id, op: "add", item: { id: skill.id, kind: "skill",
      title: skill.name, locked: false, editable: true, source: "workflow", use: { mode: "when_needed" },
      asset_ref: { registry: "repository_skill", id: skill.id, version: skill.revision, digest: skill.digest,
        nature: "engineering", form: "skill", repository: skill.repository, revision: skill.revision, relative_path: skill.relative_path } } })) };
  f.state.summary.repository_skills = skills;
  f.state.summary.workflow_profile = compileWorkflow({ baseSnapshot: standard, definition,
    source: { kind: "platform", id: "mae-flow.standard" }, resolvedAssets: resolveWorkflowAssets({ definition,
      dataDir: f.service.options.dataDir, repositories: f.repos, technologies: [], businessModules: [], repositorySkills: skills }) });
  assert.equal(f.state.summary.workflow_profile.final_snapshot.stages.flatMap((item: any) => item.items).filter((item: any) => /^skill-/.test(item.id)).length, 2);
  const result = await f.confirm();
  const items = result.workflow_profile!.final_snapshot!.stages.flatMap(item => item.items);
  assert.ok(items.some(item => item.id === "skill-1"));
  assert.ok(!items.some(item => item.id === "skill-0"));
  assert.ok(result.workflow_profile!.diagnostics.some(item => item.code === "asset_unavailable"));
  assert.deepEqual(result.repository_skills?.map(item => item.id), ["skill-1"]);
});

test("单单元确认在交接中取消：停止资源后不能重新排队", async t => {
  const f = fixture(t);
  f.state.container = { stop: async () => { f.state.summary.status = "canceled"; f.state.controlEpoch += 1; } };
  await f.confirm();
  assert.equal(f.service.get(f.parent.id)?.status, "canceled");
  await assert.rejects(f.confirm, /任务已取消/);
  assert.equal(f.service.list().length, 1);
  assert.ok(!f.internal.queue.includes(f.parent.id));
});

test("决定已保存但交接尚未完成：服务重启消费原决定，不重问、不生成子任务", async t => {
  const f = fixture(t, 2);
  f.service.assignRequirementRepositories(f.parent.id, { only: "developer" }, { only: "REQ-DELIVERY" });
  f.state.humanGate.resolve(f.waiting.waiting_id, { stateVersion: f.waiting.state_version,
    decision: "确认并生成任务", decidedBy: "owner" });
  f.internal.persist(f.state);
  const restored = f.recover();
  for (let i = 0; i < 100 && restored.get(f.parent.id)?.status === "waiting_for_human"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(restored.list().length, 1);
  assert.equal(restored.get(f.parent.id)?.status, "queued");
  assert.equal(restored.get(f.parent.id)?.ticket, "REQ-DELIVERY");
  assert.equal((restored as any).isRequirementAnalysis((restored as any).tasks.get(f.parent.id)), false);
});

for (const answer of ["确认方案", "确认并生成任务", "确认并继续开发", "确认分析结论"])
for (const mode of ["decision", "selected_options", "answers"] as const)
test(`${answer} 经 ${mode} 入口在主任务交付，旧的单子任务不被合并`, async t => {
  const f = fixture(t);
  f.state.summary.waiting = f.state.humanGate.createWaiting({ taskId: f.parent.id, step: "requirement-analysis", callId: "continue-main",
    questionInput: { questions: [{ question: "确认后继续开发？", options: ["确认并继续开发", "需要修改"] }] } });
  const waiting = f.state.summary.waiting;
  assert.deepEqual((f.service.get(f.parent.id)!.waiting!.question as any).questions[0].options, ["确认方案", "需要修改"]);
  const submission = mode === "decision" ? { decision: answer } : { [mode]: { "确认后继续开发？": answer } };
  await f.service.decide(f.parent.id, { state_version: waiting.state_version, ...submission, actor: "owner",
    repository_assignees: { only: "developer" }, repository_tickets: { only: "REQ-DELIVERY" } });
  assert.equal(f.service.list().length, 1);
  assert.equal(f.service.get(f.parent.id)?.status, "queued");
  assert.ok(isMainTaskDelivery(f.service.get(f.parent.id)!));
  assert.equal(isMainTaskDelivery({ ...f.service.get(f.parent.id)!, requirement_graph: {
    ...f.state.summary.requirement_graph, repositories: [{ task_id: "old-child" }],
  } }), false);
});

test("分析确认后真实启动开发会话：工作区进入代码仓，内核初始化，继承设计和人工答复", async t => {
  const f = fixture(t, 2);
  const root = f.service.options.host!.kernelRoot;
  for (const name of ["scripts", "hooks", "flow"]) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "flow", "flow.json"), JSON.stringify({ start: "config_confirm", steps: { config_confirm: { terminal: false }, end: { terminal: true } } }));
  writeFileSync(join(root, "hooks", "dispatch.py"), "import sys\nsys.exit(0)\n");
  writeFileSync(join(root, "scripts", "mae-flow.py"), [
    "import json, sys", "command = sys.argv[1] if len(sys.argv) > 1 else ''", "if command == 'init':",
    "    with open('.mae-flow.json', 'w') as f: json.dump({'current': 'config_confirm'}, f)",
    "if command == 'current': print('CURRENT: 继续当前交付任务')",
  ].join("\n"));
  const model = new ScriptedModelServer([{ tool: { name: "AskUserQuestion", input: { questions: [{ question: "开发会话已开始", options: ["继续", "稍后"] }] } } }]);
  await model.start();
  t.after(async () => { await f.service.cancel(f.parent.id, "test").catch(() => {}); await model.stop(); });
  await f.confirm();
  f.service.options.modelsJson = model.modelsJson();
  f.service.options.provider = "maeflow";
  f.service.options.model = "scripted-v1";
  f.service.options.maxConcurrent = 1;
  void f.internal.pump();
  const deadline = Date.now() + 15_000;
  while (!model.requests.length) {
    const current = f.service.get(f.parent.id)!;
    if (current.status === "failed" || Date.now() > deadline) assert.fail(current.detail ?? "开发会话启动超时");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.service.list().length, 1);
  assert.equal(f.state.cwd, f.code);
  assert.ok(existsSync(join(f.code, ".mae-flow.json")), "已从分析阶段进入内核开发流程");
  const order = JSON.parse(readFileSync(join(f.code, ".mae-flow-order.json"), "utf8"));
  assert.equal(order["单号"], "REQ-DELIVERY");
  assert.equal(order["工号"], "developer");
  assert.equal(order["需求文档"], ".mae-flow-unit.md");
  assert.match(readFileSync(join(f.code, ".mae-flow-chain.md"), "utf8"), /已确认设计/);
  const opening = JSON.stringify(model.requests[0]);
  assert.match(opening, /需求分析与方案确认已完成/);
  assert.match(opening, /inherited-decisions.json/);
  assert.doesNotMatch(opening, /你正在执行云端平台的需求分析/);
});

test("磁盘旧待答卡重启后展示规范选项，旧答复仍可提交且保留原文", async t => {
  const f = fixture(t);
  f.waiting.question = { questions: [{ question: "是否确认方案？",
    options: ["确认并生成任务", "确认并继续开发", "确认分析结论", "需要修改"], recommended: "确认分析结论" }] };
  f.internal.persist(f.state);
  const restored = f.recover();
  const waiting = restored.get(f.parent.id)!.waiting!;
  const item = (waiting.question as any).questions[0];
  assert.deepEqual(item.options, ["确认方案", "需要修改"]);
  assert.equal(item.recommended, "确认方案");
  await restored.decide(f.parent.id, { state_version: waiting.state_version,
    selected_options: { "是否确认方案？": "确认分析结论" }, actor: "owner",
    repository_assignees: { only: "developer" }, repository_tickets: { only: "REQ-DELIVERY" } });
  assert.equal(restored.get(f.parent.id)?.status, "queued");
  assert.equal(restored.list().length, 1);
  const resolved = (restored as any).tasks.get(f.parent.id).humanGate.get(waiting.waiting_id);
  assert.equal(resolved.answers["是否确认方案？"], "确认分析结论");
});
