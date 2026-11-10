import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { storyArtifacts, writeStoryArtifacts } from "./requirementGraphFixture.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-graph-feedback-"));
  const logs: string[] = [];
  const service = new TaskService({ autoArchitecture: false, dataDir: dir,
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dir, "no-kernel") }, log: message => logs.push(message) });
  const parent = service.create("分析需求", { repos: [join(dir, "repo")],
    requirementAnalysis: true, account: "owner", ticket: "REQ1" });
  const internal = service as any, state = internal.tasks.get(parent.id);
  state.cwd = parent.workspace;
  state.summary.status = "running";
  state.summary.waiting = undefined;
  const definition = { repository_assessments: [{ name: "repo", url: parent.repositories![0],
    outcome: "change_required", reason: "需要实现" }],
    repositories: [{ id: "unit", name: "模块", url: parent.repositories![0], responsibility: "完整实现" }], dependencies: [] };
  const directory = join(state.cwd, ".mae-flow-work", "REQ1");
  const artifacts = writeStoryArtifacts(directory, "REQ1", "# 设计\n完整需求。\n", definition);
  const graphPath = join(directory, "requirement-graph.json");
  const steers: string[] = [];
  state.driver = { steer: async (message: string) => { steers.push(message); }, dispose() {} };
  t.after(async () => {
    state.driver = undefined;
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (value: unknown) => writeFileSync(graphPath, JSON.stringify(value));
  const refresh = () => { internal.refreshRequirementGraph(state); return state.summary.requirement_graph; };
  return { service, internal, state, parent, directory, graphPath, artifacts, steers, logs, write, refresh };
}

test("坏图全部缺失字段只用一条 steer 反馈，修正后恢复且不再提示", t => {
  const f = fixture(t);
  f.write({ nodes: [], edges: [] });
  assert.equal(f.refresh().projection_state, "invalid");
  assert.equal(f.steers.length, 1);
  for (const field of ["plan_revision", "repository_assessments", "repositories", "dependencies", "story_sha256"])
    assert.ok(f.steers[0].includes(field), field);
  assert.match(f.steers[0], /只修正该文件.*不要改 story.md 正文/);
  writeFileSync(f.graphPath, f.artifacts.graph);
  assert.equal(f.refresh().projection_state, "ready");
  assert.equal(f.refresh().projection_error, undefined);
  assert.equal(f.steers.length, 1);
  assert.equal(readFileSync(join(f.directory, "story.md"), "utf8"), f.artifacts.chain);
});

for (const inactive of ["no-driver", "waiting_for_human", "paused", "canceled", "completed", "failed"])
  test(`${inactive} 时不注入，错误仍可落盘`, t => {
    const f = fixture(t);
    if (inactive === "no-driver") f.state.driver = undefined;
    else f.state.summary.status = inactive;
    f.write({});
    assert.doesNotThrow(f.refresh);
    f.internal.persist(f.state);
    const saved = JSON.parse(readFileSync(join(f.parent.workspace, "task.json"), "utf8"));
    assert.equal(saved.summary.requirement_graph.projection_state, "invalid");
    assert.match(saved.summary.requirement_graph.projection_error, /plan_revision/);
    assert.equal(f.steers.length, 0);
  });

test("同一坏图去重，修改后最多提示两轮，成功后清空预算", t => {
  const f = fixture(t);
  f.write({}); f.refresh(); f.refresh();
  assert.equal(f.steers.length, 1);
  f.write({ nodes: [] }); f.refresh();
  assert.equal(f.steers.length, 2);
  f.write({ nodes: [], edges: [] });
  const result = f.refresh(); f.refresh();
  assert.equal(f.steers.length, 2);
  assert.match(result.projection_error, /已自动提示 Agent 修正 2 轮，仍未通过/);
  assert.ok(f.logs.some(message => message.includes("已自动提示 Agent 修正 2 轮")));
  writeFileSync(f.graphPath, f.artifacts.graph);
  assert.equal(f.refresh().projection_state, "ready");
  f.write({}); f.refresh();
  assert.equal(f.steers.length, 3, "成功后新的错误可重新反馈");
});

test("JSON 解析失败仅反馈一条错误，null/数组根值也能反馈修复", t => {
  const f = fixture(t);
  writeFileSync(f.graphPath, "{");
  assert.equal(f.refresh().projection_error, "requirement-graph.json 文件不是合法 JSON");
  assert.equal(f.steers[0].split("\n- ").length, 2);
  writeFileSync(f.graphPath, f.artifacts.graph); f.refresh();
  for (const value of [null, []]) {
    f.write(value);
    assert.match(f.refresh().projection_error, /必须是 JSON 对象/);
  }
});

test("逐项及交叉校验汇总非法值、仓库、重复 id、排查结论及依赖错误", t => {
  const f = fixture(t), graph = JSON.parse(f.artifacts.graph);
  const assessment = graph.repository_assessments[0], unit = graph.repositories[0];
  graph.repository_assessments = [null, { ...assessment, outcome: "unknown", reason: "" },
    { ...assessment, outcome: "no_change" }, { ...assessment, url: "not-ordered" }];
  graph.repositories = [null, unit, { ...unit, url: "not-ordered", responsibility: "" }];
  graph.dependencies = [null, { dependent: "unit", prerequisite: "unit", reason: "循环" },
    { dependent: "unit", prerequisite: "unknown", reason: "未知" }];
  f.write(graph);
  const result = f.refresh();
  assert.equal(f.steers.length, 1);
  for (const problem of ["outcome 值", "缺 reason", "未下单的仓库", "重复的排查结论", "id 重复",
    "不是下单仓库地址", "缺少 responsibility", "无需修改，却生成了模块交付单元", "依赖关系包含未知模块、自依赖或缺少原因"])
    assert.ok(result.projection_error.includes(problem), problem);
});

test("单项契约错误的用户文案保持原样", t => {
  const f = fixture(t);
  const cases: Array<[string, string]> = [
    ["plan_revision", "requirement-graph.json 缺少合法的 plan_revision"],
    ["story_sha256", "requirement-graph.json 缺少合法的设计摘要（story_sha256 / 旧 chain_sha256）"],
    ["dependencies", "缺少 dependencies；没有硬依赖时也必须明确写空数组"],
  ];
  for (const [field, expected] of cases) {
    writeFileSync(f.graphPath, f.artifacts.graph); f.refresh();
    const graph = JSON.parse(f.artifacts.graph); delete graph[field]; f.write(graph);
    assert.equal(f.refresh().projection_error, expected);
  }
});

for (const conflict of ["sealed-review", "sealed-revision", "replay", "legacy", "revision-mismatch", "digest-mismatch"])
  test(`流程冲突 ${conflict} 保留原文案且不反馈修文件`, t => {
    const f = fixture(t);
    f.refresh();
    const graph = JSON.parse(f.artifacts.graph);
    let expected: RegExp;
    if (conflict.startsWith("sealed")) {
      const waiting = f.state.humanGate.createWaiting({ taskId: f.parent.id, step: "requirement-analysis",
        callId: "review", questionInput: { questions: [{ question: "确认方案？", options: ["需要修改", "确认并生成任务"] }] } });
      f.state.summary.status = "waiting_for_human"; f.state.summary.waiting = waiting;
      assert.equal(f.internal.sealRequirementGraphReview(f.state, waiting), true);
      graph.repositories[0].responsibility += "新内容";
      // 即使同时写坏 schema，流程冲突也不能变成自动改写指令。
      delete graph.repository_assessments;
      if (conflict === "sealed-revision") {
        f.state.summary.status = "running"; f.state.summary.waiting = undefined;
      }
      expected = conflict === "sealed-review" ? /送审中的版本 r1 已发生变化/ : /版本 r1 已经送审，产物内容不能原地改写/;
    } else if (conflict === "replay") {
      f.state.summary.requirement_graph.reviewed_plan_revisions = ["r1"];
      expected = /版本号 r1 已经送审过，不能重复使用/;
    } else if (conflict === "legacy") {
      writeFileSync(join(f.directory, "story.md"), "# 旧方案\n");
      delete graph.plan_revision; delete graph.story_sha256;
      expected = /机读依赖图仍是旧格式/;
    } else if (conflict === "revision-mismatch") {
      graph.plan_revision = "r2"; expected = /设计文档版本 r1 与机读图版本 r2 不一致/;
    } else {
      graph.story_sha256 = "a".repeat(64); expected = /设计文档内容已经变化，但机读依赖图还没有同步更新/;
    }
    f.write(graph);
    assert.match(f.refresh().projection_error, expected);
    assert.equal(f.steers.length, 0);
  });

test("回合结束无需页面读取：先刷新图，再经未送达插话续跑修复并正常封版", async t => {
  const f = fixture(t), queued: string[] = [];
  let continuations = 0;
  f.write({ nodes: [], edges: [] });
  f.state.driver.steer = async (message: string) => {
    f.steers.push(message);
    await Promise.resolve(); // 与 Pi 输入预处理后的异步排队一致。
    queued.push(message);
  };
  f.state.driver.takeUndeliveredSteers = () => queued.splice(0);
  f.state.driver.continueWith = async (message: string) => {
    continuations++;
    assert.match(message, /不符合契约/);
    writeFileSync(f.graphPath, f.artifacts.graph);
    const waiting = f.state.humanGate.createWaiting({ taskId: f.parent.id, step: "requirement-analysis",
      callId: "fixed-review", questionInput: { questions: [{ question: "确认方案？", options: ["需要修改", "确认并生成任务"] }] } });
    return { status: "waiting_for_human", waiting };
  };
  await f.internal.settleTurn(f.state, Promise.resolve({ status: "turn_finished" }));
  assert.equal(continuations, 1);
  assert.equal(f.steers.length, 1);
  assert.equal(f.state.summary.status, "waiting_for_human");
  assert.equal(f.state.summary.requirement_graph.projection_state, "ready");
  assert.equal(f.state.summary.requirement_graph.review_snapshot.plan_revision, "r1");
  assert.deepEqual(f.state.summary.requirement_graph.reviewed_plan_revisions, ["r1"]);
});

test("页面读取直接触发反馈，同步返回不等待 steer 完成，发送失败仅记日志", async t => {
  const f = fixture(t);
  f.write({});
  let release!: () => void;
  f.state.driver.steer = (message: string) => { f.steers.push(message); return new Promise<void>(resolve => { release = resolve; }); };
  assert.equal(f.service.get(f.parent.id)!.requirement_graph!.projection_state, "invalid");
  assert.equal(f.steers.length, 1);
  release();
  writeFileSync(f.graphPath, f.artifacts.graph); f.refresh();
  f.write({});
  f.state.driver.steer = async () => { throw new Error("steer unavailable"); };
  assert.doesNotThrow(f.refresh);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.logs.some(message => message.includes("steer unavailable")));
});

for (const transition of ["confirmed", "canceled", "completed", "delivery"])
  test(`离开分析或结束任务 ${transition} 时释放修正记录`, t => {
    const f = fixture(t);
    f.write({}); f.refresh();
    assert.equal(f.internal.requirementGraphCorrections.size, 1);
    if (transition === "confirmed") f.state.summary.requirement_graph.stage = "confirmed";
    else if (transition === "delivery") f.state.summary.requirement_analysis_requested = undefined;
    else f.state.summary.status = transition;
    f.internal.persist(f.state);
    assert.equal(f.internal.requirementGraphCorrections.size, 0);
  });

test("暂停后恢复保留累计提示次数，不获得额外修正轮数", t => {
  const f = fixture(t);
  f.write({}); f.refresh();
  f.state.summary.status = "paused";
  f.internal.persist(f.state); f.refresh();
  f.state.summary.status = "running";
  f.write({ nodes: [] }); f.refresh();
  f.write({ edges: [] });
  assert.match(f.refresh().projection_error, /已自动提示 Agent 修正 2 轮/);
  assert.equal(f.steers.length, 2);
});

test("真实 Pi 会话无人读取页面：坏图结束发言后收到完整反馈，修好后继续正常送审", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-graph-feedback-session-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const artifacts = storyArtifacts("# 设计\n完整需求。\n", {
    repository_assessments: [{ name: "repo", url: repo, outcome: "change_required", reason: "需要实现" }],
    repositories: [{ id: "unit", name: "模块", url: repo, responsibility: "完整实现" }], dependencies: [],
  });
  const story = ".mae-flow-work/REQ1/story.md", graph = ".mae-flow-work/REQ1/requirement-graph.json";
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: `cat > ${story} <<'STORY'\n${artifacts.chain}STORY\ncat > ${graph} <<'GRAPH'\n{"nodes":[],"edges":[]}\nGRAPH` } } },
    { text: "分析结束。" },
    { tool: { name: "bash", input: { command: `cat > ${graph} <<'GRAPH'\n${artifacts.graph}\nGRAPH` } } },
    { text: "已修正机读图。" },
    { tool: { name: "AskUserQuestion", input: { questions: [{ question: "确认方案？", options: ["需要修改", "确认方案"], recommended: "确认方案" }] } } },
  ], "scripted-v1", { linear: true });
  await model.start();
  const logs: string[] = [];
  const service = new TaskService({ autoArchitecture: false, dataDir: dir,
    provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(), maxConcurrent: 1,
    host: { kernelRoot: join(dir, "no-kernel") }, log: message => logs.push(message) });
  t.after(async () => { await service.shutdown(); await model.stop(); rmSync(dir, { recursive: true, force: true }); });
  const parent = service.create("分析完整需求", { repos: [repo], requirementAnalysis: true, account: "owner", ticket: "REQ1" });
  const state = (service as any).tasks.get(parent.id);
  const deadline = Date.now() + 20_000;
  while (state.summary.status !== "waiting_for_human") {
    assert.notEqual(state.summary.status, "failed", state.summary.detail);
    assert.ok(Date.now() < deadline, `等待真实会话送审超时：${state.summary.status} ${state.summary.detail}；场景 ${model.served.slice(-10).join(",")}；${logs.slice(-10).join("\n")}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const repairRequest = JSON.stringify(model.requests[2].messages);
  assert.equal(repairRequest.match(/requirement-graph.json 不符合契约/g)?.length, 1);
  for (const field of ["plan_revision", "repository_assessments", "repositories", "dependencies"])
    assert.ok(repairRequest.includes(field), field);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  assert.deepEqual(state.summary.requirement_graph.reviewed_plan_revisions, ["r1"]);
  assert.equal(readFileSync(join(state.cwd, story), "utf8"), artifacts.chain);
});
