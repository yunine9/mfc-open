import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService, type RequirementGraph } from "../src/taskService.ts";
import { collectStoryInput } from "../src/overallStory.ts";
import { writeRequirementArtifacts, writeStoryArtifacts } from "./requirementGraphFixture.ts";

function fixture(t: TestContext, count = 2, sameRepo = false, story = false) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-parent-recovery-"));
  const options = { autoArchitecture: false, dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dir, "no-kernel") },
    // Production enables the projection store: persist -> project -> refresh graph.
    projection: { upsertTask: async () => {} } as any };
  const service = new TaskService(options);
  const services = [service];
  t.after(async () => { for (const item of services) await item.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const repos = Array.from({ length: sameRepo ? 1 : count }, (_, i) => join(dir, `repo-${i}`));
  const parent = service.create("测试拆分需求", { repos, requirementAnalysis: true, account: "owner", ticket: "REQ1" });
  const internal = service as any;
  const state = internal.tasks.get(parent.id);
  state.cwd = parent.workspace;
  const definition = {
    repository_assessments: repos.map(url => ({ name: url.split("/").at(-1), url, outcome: "change_required", reason: "需要实现" })),
    repositories: Array.from({ length: count }, (_, i) => ({ id: `unit-${i}`, name: `模块${i}`,
      url: repos[sameRepo ? 0 : i], ticket: `REQ${i + 10}`, responsibility: `实现模块${i}`,
      scope: { name: `模块${i}` } })), dependencies: sameRepo
      ? Array.from({ length: count - 1 }, (_, i) => ({ dependent: `unit-${i + 1}`, prerequisite: `unit-${i}`, reason: "依赖前序接口" })) : [],
  };
  (story ? writeStoryArtifacts : writeRequirementArtifacts)(join(parent.workspace, ".mae-flow-work", "REQ1"), "REQ1", "# 整体方案\n模块职责与协作。\n", definition);
  internal.refreshRequirementGraph(state);
  const split = () => {
    internal.createRepositoryDeliveries(state);
    state.summary.status = "coordinating";
    internal.persist(state);
    return [...internal.tasks.values()].filter((child: any) => child.summary.parent_task_id === parent.id) as any[];
  };
  const save = (task: any) => internal.writeTaskState(task, true);
  const recover = () => { const restored = new TaskService(options); services.push(restored); restored.recover(); return restored; };
  return { service, internal, parent, state, split, save, recover };
}

test("启用生产投影时拆单不会丢失后续 task_id 和 confirmed，重复调用不重复建单", t => {
  const f = fixture(t, 6);
  const children = f.split();
  const graph = f.service.get(f.parent.id)!.requirement_graph!;
  assert.equal(graph.stage, "confirmed");
  assert.deepEqual(graph.repositories.map(node => node.task_id), children.map(child => child.summary.id));
  f.split();
  assert.equal(f.internal.tasks.size, 7);
  const saved = JSON.parse(readFileSync(join(f.parent.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.requirement_graph.stage, "confirmed");
  assert.ok(saved.summary.requirement_graph.repositories.every((node: any) => node.task_id));
});

test("建单中途失败后保留已创建关联，重试只补剩余单元", t => {
  const f = fixture(t, 3);
  const create = f.service.create.bind(f.service);
  let calls = 0;
  f.service.create = (...args) => {
    if (++calls === 2) throw new Error("模拟第二个子任务创建失败");
    return create(...args);
  };
  assert.throws(() => f.split(), /模拟第二个/);
  const partial = f.service.get(f.parent.id)!.requirement_graph!;
  assert.equal(partial.stage, "confirmed");
  assert.equal(partial.repositories.filter(node => node.task_id).length, 1);
  const first = partial.repositories[0].task_id;
  f.service.create = create;
  const children = f.split();
  assert.equal(children.length, 3);
  assert.equal(f.service.get(f.parent.id)!.requirement_graph!.repositories[0].task_id, first);
});

for (const [count, story] of [[6, false], [2, true]] as const) {
  test(`旧${story ? "Story" : "CHAIN"}主任务：${count}个子任务完成后重启恢复关联并收口，不重复建单`, t => {
    const f = fixture(t, count, false, story);
    const children = f.split();
    for (const child of children) {
      child.summary.status = "completed";
      child.summary.workspace_reclaimed_at = new Date().toISOString();
      f.save(child);
    }
    const graph: RequirementGraph = f.state.summary.requirement_graph;
    graph.stage = "analysis";
    for (const node of graph.repositories.slice(1)) delete node.task_id;
    f.save(f.state);
    const restored = f.recover();
    const result = restored.get(f.parent.id)!;
    assert.equal(result.status, "completed");
    assert.equal(result.requirement_graph!.stage, "confirmed");
    assert.deepEqual(result.requirement_graph!.repositories.map(node => node.task_id), children.map(child => child.summary.id));
    assert.equal(restored.list().length, count + 1);
    assert.equal((result.requirement_graph as any).confirmed_at, undefined, "不得编造人工确认时间");
    if (story) assert.ok(collectStoryInput({ summary: result }, {
      task: id => { const summary = restored.get(id); return summary ? { summary } : undefined; },
      artifactRoot: () => undefined,
    }).sources.every(source => source.task_id));
  });
}

test("同仓多个模块使用已有任务书匹配，不按同 AR 或完成顺序错配", t => {
  const f = fixture(t, 3, true);
  const children = f.split();
  f.state.summary.requirement_graph.stage = "analysis";
  for (const node of f.state.summary.requirement_graph.repositories) delete node.task_id;
  children.forEach(child => { child.summary.status = "completed"; child.summary.ticket = "SAME"; child.summary.title = "已改名"; });
  f.internal.reconcileRequirementParent(f.state, true);
  assert.equal(f.state.summary.status, "completed");
  assert.deepEqual(f.state.summary.requirement_graph.repositories.map((node: any) => node.task_id), children.map(child => child.summary.id));
});

test("缺失子任务、同仓归属不明、外部任务映射不能被误判完成", t => {
  const f = fixture(t, 2, true);
  const children = f.split();
  children.forEach(child => child.summary.status = "completed");
  const graph = f.state.summary.requirement_graph;
  graph.stage = "analysis";
  delete graph.repositories[1].task_id;
  rmSync(join(children[1].summary.workspace, "unit-brief.md"));
  f.internal.reconcileRequirementParent(f.state, true);
  assert.equal(f.state.summary.status, "coordinating");
  graph.repositories[1].task_id = "task-missing";
  f.internal.reconcileRequirementParent(f.state, true);
  assert.equal(f.state.summary.status, "coordinating");
  graph.repositories[1].task_id = children[1].summary.id;
  children[1].summary.parent_task_id = "other-parent";
  f.internal.reconcileRequirementParent(f.state, true);
  assert.equal(f.state.summary.status, "coordinating");
});

test("未确认分析不自动通过；失败子任务和图外兄弟仍需处理", t => {
  const f = fixture(t);
  const children = f.split();
  children.forEach(child => child.summary.status = "completed");
  f.state.summary.requirement_graph.stage = "analysis";
  f.state.summary.status = "waiting_for_human";
  f.internal.reconcileRequirementParent(f.state, true);
  assert.equal(f.state.summary.status, "waiting_for_human");
  assert.equal(f.state.summary.requirement_graph.stage, "analysis");
  f.state.summary.status = "coordinating";
  for (const status of ["failed", "paused", "running"]) {
    children[1].summary.status = status;
    f.internal.reconcileRequirementParent(f.state, true);
    assert.equal(f.state.summary.status, "coordinating");
  }
  children[1].summary.status = "completed";
  const extra = f.service.create("遗漏的实际子任务", { repo: children[0].summary.repo_url,
    ticket: "REQ99", parentTaskId: f.parent.id, internalRequirement: true });
  f.internal.reconcileRequirementParent(f.state);
  assert.equal(f.state.summary.status, "coordinating");
  f.internal.tasks.get(extra.id).summary.status = "completed";
  f.internal.persist(f.internal.tasks.get(extra.id));
  assert.equal(f.state.summary.status, "completed");
});

test("取消两项不再需要的子任务后主任务收口，重启后保留数量", async t => {
  const f = fixture(t, 7);
  const children = f.split();
  for (const child of children.slice(0, 5)) {
    child.summary.status = "completed";
    child.summary.workspace_reclaimed_at = new Date().toISOString();
    f.internal.persist(child);
  }
  children[5].summary.status = "waiting_for_human";
  f.internal.persist(children[5]);
  await f.service.cancel(children[5].summary.id, "owner");
  assert.equal(f.service.get(f.parent.id)?.status, "coordinating");
  await f.service.cancel(children[6].summary.id, "owner");
  const result = f.service.get(f.parent.id)!;
  assert.equal(result.status, "completed");
  assert.match(result.detail ?? "", /5\/7 个子任务已完成，2 个已取消/);
  const restored = f.recover();
  assert.equal(restored.get(f.parent.id)?.status, "completed");
  assert.match(restored.get(f.parent.id)?.detail ?? "", /5\/7 个子任务已完成，2 个已取消/);
});

test("全部子任务取消时主任务也取消，不冒充代码交付", t => {
  const f = fixture(t);
  const children = f.split();
  for (const child of children) {
    child.summary.status = "canceled";
    f.internal.persist(child);
  }
  assert.equal(f.service.get(f.parent.id)?.status, "canceled");
});

test("明确取消或失败的主任务不因子任务完成而被自动恢复", t => {
  const f = fixture(t);
  const children = f.split();
  children.forEach(child => child.summary.status = "completed");
  for (const status of ["failed", "canceled"]) {
    f.state.summary.status = status;
    f.internal.reconcileRequirementParent(f.state, true);
    assert.equal(f.state.summary.status, status);
  }
});
