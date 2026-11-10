import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReviewAnnotations } from "../src/feedbackPolicy.ts";
import { TaskService } from "../src/taskService.ts";
import { readArtifact, listArtifactDocuments } from "../src/artifacts.ts";
import { OVERALL_STORY_ARTIFACT, readCurrentStory, readStoryState } from "../src/overallStoryStore.ts";
import type { StoryRun } from "../src/overallStory.ts";
import { REQUIREMENT_GRAPH_ARTIFACT } from "../src/annotations.ts";
import { writeStoryArtifacts } from "./requirementGraphFixture.ts";
import { KERNEL_ROOT } from "./kernelFixture.ts";

function fixture(autoArchitecture = false) {
  const root = mkdtempSync(join(tmpdir(), "mfc-main-story-"));
  const options = { autoArchitecture, dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: KERNEL_ROOT } };
  const service = new TaskService(options);
  const parent = service.create("按模块交付通知功能", {
    account: "owner", ticket: "REQ-STORY", requirementAnalysis: true,
    repos: ["https://example.invalid/svc.git"],
  });
  const state = (service as any).tasks.get(parent.id);
  state.cwd = join(parent.workspace, "repositories");
  const directory = join(state.cwd, ".mae-flow-work", parent.ticket!);
  const definition = {
    repository_assessments: [{ name: "svc", url: parent.repositories![0],
      outcome: "change_required", reason: "通知和查询模块需要实现" }],
    repositories: [
      { id: "notify", name: "通知", url: parent.repositories![0], responsibility: "发送通知及模块验证" },
      { id: "query", name: "查询", url: parent.repositories![0], responsibility: "查询通知及模块验证" },
    ], dependencies: [],
  };
  const draft = writeStoryArtifacts(directory, parent.ticket!, "# Story\n\n通知接口契约\n", definition).chain;
  (service as any).refreshRequirementGraph(state);
  const sources = { publishedStory: false, taskMaterialRoot: parent.workspace, analysisStory: `${parent.ticket}/story.md` };
  const createChildren = () => {
    state.summary.requirement_graph.repositories.forEach((node: any, i: number) => { node.ticket = `REQ-STORY-${i}`; });
    (service as any).createRepositoryDeliveries(state);
    sources.publishedStory = true;
    return state.summary.requirement_graph.repositories.map((node: any) => (service as any).tasks.get(node.task_id));
  };
  return { root, options, service, parent, state, directory, draft, definition, sources, createChildren,
    async dispose() { state.driver = undefined; await service.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

test("确认建单发布 Story 后只补图一次，重复采用不重复调用模型", async () => {
  const f = fixture(true);
  try {
    let calls = 0;
    const coordinator = f.service.overallStories;
    (coordinator as any).options.run = async (_task: unknown, job: StoryRun) => {
      calls++;
      assert.equal(job.architectureOnly, true);
      assert.equal(job.before, f.draft);
      throw new Error("架构模型暂不可用");
    };
    f.createChildren();
    assert.equal(readCurrentStory(f.parent.workspace), f.draft);
    assert.equal(coordinator.status(f.parent.id).job?.by, "系统");
    await coordinator.settled(f.parent.id);
    assert.equal(calls, 1);
    assert.equal(coordinator.status(f.parent.id).error, "架构模型暂不可用");
    f.createChildren();
    assert.equal(calls, 1);
    assert.equal(coordinator.status(f.parent.id).error_kind, "architecture");
  } finally { await f.dispose(); }
});

test("分析 Story 使用稳定入口：可批注、仍走分析 Agent；缺少同步摘要不能建单", async () => {
  const f = fixture();
  try {
    const docs = listArtifactDocuments(f.state.cwd, f.sources);
    assert.equal(docs.filter((doc) => doc.purpose === "overall_story").length, 1);
    assert.equal(readArtifact(f.state.cwd, OVERALL_STORY_ARTIFACT, f.sources)?.content, f.draft);
    assert.ok(!docs.some((doc) => doc.name === "REQ-STORY/story.md"));
    f.state.summary.status = "running";
    const messages: string[] = [];
    f.state.driver = { steer: async (text: string) => { messages.push(text); } };
    const note = f.service.addAnnotation(f.parent.id, { author: "owner", kind: "doc",
      artifact: OVERALL_STORY_ARTIFACT, file: OVERALL_STORY_ARTIFACT,
      anchor: "通知接口契约", line: 4, note: "说明失败重试" });
    const graphNote = f.service.addAnnotation(f.parent.id, { author: "owner", kind: "doc",
      artifact: REQUIREMENT_GRAPH_ARTIFACT, file: REQUIREMENT_GRAPH_ARTIFACT,
      anchor: "模块 notify", line: 2, note: "通知模块负责重试" });
    const sent = await f.service.sendAnnotations(f.parent.id, [note.id, graphNote.id], "owner");
    assert.deepEqual(sent.sent, [note.id, graphNote.id]);
    assert.equal(messages.length, 1);
    assert.deepEqual(agentReviewAnnotations(f.service.listAnnotations(f.parent.id).items).map((item) => item.id), [note.id, graphNote.id], "分析 Story 的意见由当前分析 Agent 逐条交回执，不能被已发布 Story 的专用通道排除");
    assert.match(messages[0], /\.mae-flow-work\/REQ-STORY\/story.md/);
    assert.match(messages[0], /story_sha256/);
    assert.equal(readStoryState(f.parent.workspace).current, undefined);
    writeFileSync(join(f.directory, "story.md"), `${f.draft}\n未同步修改`);
    assert.throws(f.createChildren, /内容已经变化/);
    assert.ok(f.state.summary.requirement_graph.repositories.every((node: any) => !node.task_id));
  } finally { await f.dispose(); }
});

test("已确认 Story 更新同步子任务材料和通知；恢复幂等，保留调度与历史版本", async () => {
  const f = fixture();
  try {
    const children = f.createChildren();
    const coordinator = (f.service as any).overallStories;
    const first = readStoryState(f.parent.workspace).current!;
    assert.ok(first);
    assert.equal(coordinator.status(f.parent.id).can_confirm, true, "子 Story 尚未生成不阻断全局设计");
    const graph = structuredClone(f.state.summary.requirement_graph);
    const steered: string[] = [];
    children[0].summary.status = "running";
    children[0].cwd = join(children[0].summary.workspace, "code");
    mkdirSync(children[0].cwd);
    children[0].driver = { steer: async (text: string) => { steered.push(text); } };
    const statuses = children.map((child: any) => child.summary.status);
    coordinator.options.ready = () => {};
    coordinator.options.run = async (_task: unknown, job: StoryRun) => {
      mkdirSync(job.root, { recursive: true });
      writeFileSync(join(job.root, "story.md"), `${job.before}\n重试使用幂等键`);
    };
    coordinator.generate(f.parent.id, "owner");
    await coordinator.settled(f.parent.id);
    const published = readCurrentStory(f.parent.workspace);
    const second = readStoryState(f.parent.workspace).current!;
    assert.notEqual(second, first);
    assert.match(published, /重试使用幂等键/);
    assert.equal(coordinator.revision(f.parent.id, first).content, f.draft);
    for (const child of children) {
      assert.equal(readFileSync(join(child.summary.workspace, "chain-plan.md"), "utf8"), published);
      assert.equal(child.summary.cross_repository_updates.length, 2);
      child.driver = undefined;
    }
    assert.equal(readFileSync(join(children[0].cwd, ".mae-flow-chain.md"), "utf8"), published);
    assert.equal(steered.length, 1);
    assert.deepEqual(children.map((child: any) => child.summary.status), statuses);
    assert.deepEqual(f.state.summary.requirement_graph, graph);
    assert.equal(readArtifact(f.state.cwd, OVERALL_STORY_ARTIFACT, f.sources)?.content, published);
    // 模拟材料尚未同步完便中断；版本库才是当前设计，分析旧稿不能覆盖它。
    writeFileSync(join(children[0].summary.workspace, "chain-plan.md"), "旧副本");
    writeFileSync(join(children[0].cwd, ".mae-flow-chain.md"), "旧副本");
    (f.service as any).adoptRequirementStory(f.state);
    assert.equal(readCurrentStory(f.parent.workspace), published);
    assert.equal(readStoryState(f.parent.workspace).revisions.length, 2);
    assert.equal(children[0].summary.cross_repository_updates.length, 2);
    assert.equal(readFileSync(join(children[0].cwd, ".mae-flow-chain.md"), "utf8"), published);
    // 真实落盘恢复：父任务与子任务均为暂停状态，不启动测试外的 Agent。
    children[1].summary.delivery = { stalled: true, scope_violation: { paths: ["shared.ts"], noted_at: "old" } };
    for (const task of [f.state, ...children]) {
      task.summary.status = "canceled";
      (f.service as any).persist(task);
    }
    writeFileSync(join(children[1].summary.workspace, "chain-plan.md"), "旧副本");
    const restored = new TaskService(f.options);
    restored.recover();
    try {
      assert.equal(readFileSync(join(children[1].summary.workspace, "chain-plan.md"), "utf8"), published);
      assert.equal(restored.get(f.parent.id)!.cross_repository_updates?.length, 2);
      assert.equal(readStoryState(f.parent.workspace).current, second);
      assert.equal(restored.get(children[1].summary.id)!.status, "canceled");
      assert.equal(restored.get(children[1].summary.id)!.delivery?.scope_violation, undefined);
      assert.equal(restored.get(children[1].summary.id)!.delivery_scope_exemptions, undefined);
    } finally { await restored.shutdown(); }
  } finally { await f.dispose(); }
});


test("无需修改也发布分析 Story；发布索引损坏时不把分析旧稿冒充最新设计", async () => {
  const f = fixture();
  try {
    writeStoryArtifacts(f.directory, f.parent.ticket!, "# Story\n现有能力满足需求", {
      repositories: [], dependencies: [], repository_assessments: [{
        ...f.definition.repository_assessments[0], outcome: "no_change", reason: "已有能力满足需求",
      }],
    }, "r2");
    assert.deepEqual(f.createChildren(), []);
    const coordinator = (f.service as any).overallStories;
    assert.equal(coordinator.status(f.parent.id).eligible, true);
    assert.match(readCurrentStory(f.parent.workspace), /现有能力满足需求/);
    writeFileSync(join(f.parent.workspace, "overall-story", "state.json"), "broken");
    assert.equal(readArtifact(f.state.cwd, OVERALL_STORY_ARTIFACT, f.sources), undefined);
    assert.ok(!listArtifactDocuments(f.state.cwd, f.sources).some((doc) => doc.name === "REQ-STORY/story.md"));
  } finally { await f.dispose(); }
});
