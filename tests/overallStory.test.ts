import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverallStoryCoordinator, collectStoryInput, type StoryRun } from "../src/overallStory.ts";
import { OVERALL_STORY_ARTIFACT, readStoryState, writeStoryState, currentStoryFile, readCurrentStory, readCurrentStoryArchitecture } from "../src/overallStoryStore.ts";
import { AnnotationStore, reanchor } from "../src/annotations.ts";
import { annotationClosure } from "../src/feedbackPolicy.ts";
import { readArtifact, listArtifactDocuments } from "../src/artifacts.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { overallStoryGate, overallStoryMission, runOverallStorySession } from "../src/overallStoryAgent.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { KERNEL_ROOT } from "./kernelFixture.ts";

function fixture(autoArchitecture = false) {
  const root = mkdtempSync(join(tmpdir(), "mfc-overall-story-"));
  const task = { summary: { id: "parent", workspace: join(root, "parent"), requirement: "# 整体需求\n跨模块验收", status: "completed",
    requirement_graph: { stage: "confirmed", repositories: [
      { id: "web", name: "用户界面", task_id: "child", ticket: "REQ-1" },
      { id: "api", name: "服务接口", task_id: "missing" },
    ], dependencies: [{ from: "web", to: "api", reason: "调用接口" }] },
  } as TaskSummary };
  const child = { summary: { id: "child", workspace: join(root, "child") } as TaskSummary };
  mkdirSync(task.summary.workspace); mkdirSync(join(child.summary.workspace, ".mae-flow-work/REQ-1"), { recursive: true });
  const childDoc = join(child.summary.workspace, ".mae-flow-work/REQ-1/story.md");
  writeFileSync(childDoc, "# Story\n原始场景");
  const store = new AnnotationStore(join(task.summary.workspace, "annotations.jsonl"));
  let calls = 0;
  let runner: (t: typeof task, job: StoryRun) => Promise<void> = async (_t, job) => {
    mkdirSync(job.root, { recursive: true });
    writeFileSync(join(job.root, "story.md"), job.before ? `${job.before}\n新增说明` : "# 整体 Story\n\n验收口径\n待补充接口 Story");
    writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({
      annotation_id: a.id, outcome: "fixed", summary: "已补充验收说明", evidence: ["story.md:5"],
    }))));
  };
  const options = { autoArchitecture, task: (id: string) => id === "parent" ? task : id === "child" ? child : undefined,
    artifactRoot: (id: string) => id === "child" ? child.summary.workspace : undefined,
    ready() {}, run: async (t: typeof task, job: StoryRun) => { calls++; await runner(t, job); } };
  const coordinator = new OverallStoryCoordinator(options);
  const note = (text = "补充口径") => store.add({ author: "reviewer", artifact: OVERALL_STORY_ARTIFACT,
    file: OVERALL_STORY_ARTIFACT, kind: "doc", anchor: "验收口径", line: 3, note: text });
  return { task, child, childDoc, root, store, coordinator, options, note, calls: () => calls,
    runner: (next: typeof runner) => { runner = next; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("架构图可从无到有并更新，失败保留旧图，正文和确认不变", async () => {
  const f = fixture();
  try {
    f.coordinator.adoptAnalysis("parent", "# Story\n完整设计\n```archify\n{}\n```", "owner");
    const before = readCurrentStory(f.task.summary.workspace);
    const confirmed = readStoryState(f.task.summary.workspace).confirmed;
    let title = "首版模块";
    f.runner(async (_task, job) => {
      assert.equal(job.architectureOnly, true);
      assert.match(f.coordinator.status("parent").job?.progress ?? "", /正在准备/);
      job.onProgress?.("Agent 正在依据完整 Story 生成架构图");
      assert.match(f.coordinator.status("parent").job?.progress ?? "", /完整 Story/);
      assert.equal(job.before, before);
      const event = {} as import("../src/semanticEvents.ts").SemanticEvent;
      assert.equal(overallStoryGate(job.root, true)("Write", "story.md", event)?.action, "deny");
      assert.equal(overallStoryGate(job.root, true)("Write", "architecture.semantic.json", event)?.action, "allow");
      assert.match(overallStoryMission(job), /整个 story.md/);
      writeFileSync(join(job.root, "architecture.json"), JSON.stringify({ schema_version: 1, diagrams: [{
        id: "module", view: "logical", source: { schema_version: 1, diagram_type: "architecture", meta: { title },
          components: [{ id: "api", type: "backend", label: title, pos: [40, 40], size: [180, 64] }], connections: [] },
      }] }));
    });
    f.coordinator.generateArchitecture("parent", "owner");
    assert.throws(() => f.coordinator.generateArchitecture("parent", "owner"), /正在更新/);
    await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined);
    assert.match(readCurrentStoryArchitecture(f.task.summary.workspace)!, /首版模块/);
    title = "更新模块";
    f.coordinator.generateArchitecture("parent", "owner"); await f.coordinator.settled("parent");
    const updated = readCurrentStoryArchitecture(f.task.summary.workspace)!;
    assert.match(updated, /更新模块/);
    f.runner(async () => { throw new Error("模型暂时不可用"); });
    f.coordinator.generateArchitecture("parent", "owner"); await f.coordinator.settled("parent");
    assert.match(f.coordinator.status("parent").error!, /模型暂时不可用/);
    assert.equal(f.coordinator.status("parent").error_kind, "architecture");
    assert.equal(readCurrentStoryArchitecture(f.task.summary.workspace), updated);
    assert.equal(readCurrentStory(f.task.summary.workspace), before);
    assert.deepEqual(readStoryState(f.task.summary.workspace).confirmed, confirmed);
  } finally { await f.coordinator.shutdown(); f.dispose(); }
});

test("子任务可以依据自己的完整 Story 从无到有刷新图，不修改主任务图源", async () => {
  const f = fixture();
  try {
    f.child.summary.parent_task_id = "parent";
    f.child.summary.ticket = "REQ-1";
    const before = readFileSync(f.childDoc, "utf8");
    let title = "模块首版";
    f.runner(async (task, job) => {
      assert.equal(task.summary.id, "child");
      assert.equal(job.architectureOnly, true);
      assert.equal(job.before, before);
      writeFileSync(join(job.root, "architecture.json"), JSON.stringify({ schema_version: 1, diagrams: [{
        id: "module", view: "logical", source: { schema_version: 1, diagram_type: "architecture", meta: { title },
          components: [{ id: "api", type: "backend", label: title, pos: [40, 40], size: [180, 64] }], connections: [] },
      }] }));
    });
    for (const name of ["模块首版", "模块更新版"]) {
      title = name;
      f.coordinator.generateArchitecture("child", "owner");
      await f.coordinator.settled("child");
      assert.equal(f.coordinator.status("child").error, undefined);
      assert.match(readCurrentStoryArchitecture(f.child.summary.workspace, before)!, new RegExp(name));
    }
    assert.equal(readFileSync(f.childDoc, "utf8"), before);
    assert.equal(readCurrentStoryArchitecture(f.task.summary.workspace), undefined);
  } finally { await f.coordinator.shutdown(); f.dispose(); }
});

test("未登记全局版本的分析 Story 也能更新架构图，生成期间正文变化不发布旧图", async () => {
  const f = fixture();
  const coordinator = new OverallStoryCoordinator({ ...f.options,
    artifactRoot: (id) => id === "parent" ? f.task.summary.workspace : f.options.artifactRoot(id) });
  try {
    const graph = f.task.summary.requirement_graph!;
    graph.stage = "analyzing" as typeof graph.stage;
    const path = join(f.task.summary.workspace, ".mae-flow-work/parent/story.md");
    mkdirSync(join(f.task.summary.workspace, ".mae-flow-work/parent"), { recursive: true });
    writeFileSync(path, "# 现有分析 Story\n完整模块说明");
    let drift = false;
    f.runner(async (_task, job) => {
      assert.match(job.before, /现有分析 Story/);
      writeFileSync(join(job.root, "architecture.json"), JSON.stringify({ schema_version: 1, diagrams: [{
        id: "api", view: "logical", source: { schema_version: 1, diagram_type: "architecture", meta: { title: "模块架构" },
          components: [{ id: "api", type: "backend", label: "API", pos: [40, 40], size: [180, 64] }], connections: [] },
      }] }));
      if (drift) writeFileSync(path, "# 现有分析 Story\n职责已经变化");
    });
    coordinator.generateArchitecture("parent", "owner"); await coordinator.settled("parent");
    assert.equal(coordinator.status("parent").error, undefined);
    assert.match(readCurrentStoryArchitecture(f.task.summary.workspace, readFileSync(path, "utf8"))!, /模块架构/);
    assert.equal(readStoryState(f.task.summary.workspace).current, undefined);
    assert.equal(readStoryState(f.task.summary.workspace).confirmed, undefined);
    graph.stage = "confirmed"; graph.source_document = "story.md";
    drift = true;
    coordinator.generateArchitecture("parent", "owner"); await coordinator.settled("parent");
    assert.match(coordinator.status("parent").error!, /Story 已更新/);
    assert.equal(readCurrentStoryArchitecture(f.task.summary.workspace, readFileSync(path, "utf8")), undefined);
  } finally { await coordinator.shutdown(); f.dispose(); }
});

test("新 Story 输入跟踪模块职责；升级不改变历史汇总稿的摘要形态", () => {
  const f = fixture();
  try {
    const old = collectStoryInput(f.task, f.options).fingerprint;
    f.task.summary.requirement_graph!.repositories[0].responsibility = "查询模块的完整功能与测试";
    assert.equal(collectStoryInput(f.task, f.options).fingerprint, old);
    f.task.summary.requirement_graph!.source_document = "story.md";
    const current = collectStoryInput(f.task, f.options).fingerprint;
    f.task.summary.requirement_graph!.repositories[0].responsibility = "查询模块增加分页契约";
    assert.notEqual(collectStoryInput(f.task, f.options).fingerprint, current);
  } finally { f.dispose(); }
});

test("发布后的子任务同步失败保留文档和已处理回执，不把意见重新送回草稿", async () => {
  const f = fixture();
  const coordinator = new OverallStoryCoordinator({ ...f.options,
    published() { throw new Error("子任务材料暂时不可写"); } });
  try {
    coordinator.generate("parent", "owner");
    await coordinator.settled("parent");
    const first = readStoryState(f.task.summary.workspace).current;
    const note = f.note();
    coordinator.submit("parent", [note], "reviewer");
    await coordinator.settled("parent");
    assert.notEqual(readStoryState(f.task.summary.workspace).current, first);
    const updated = f.store.list().find((item) => item.id === note.id)!;
    assert.equal(updated.sent_via, "overall_story");
    assert.equal(updated.response?.outcome, "fixed");
    assert.match(coordinator.status("parent").error!, /子任务材料暂时不可写/);
    assert.equal(coordinator.status("parent").error_kind, "story");
  } finally { await coordinator.shutdown(); f.dispose(); }
});

test("子任务即使携带已确认拆分方案也不能生成、更新、确认或派送整体 Story 意见", () => {
  const f = fixture();
  try {
    f.child.summary.parent_task_id = f.task.summary.id;
    f.child.summary.requirement_graph = f.task.summary.requirement_graph;
    assert.equal(f.coordinator.status("parent").eligible, true);
    const status = f.coordinator.status("child");
    assert.equal(status.eligible, false);
    assert.equal(status.can_confirm, false);
    assert.throws(() => f.coordinator.generate("child", "owner"), /请在主任务/);
    assert.throws(() => f.coordinator.confirm("child", "revision", "owner"), /请在主任务/);
    assert.throws(() => f.coordinator.submit("child", [], "owner"), /请在主任务/);
    assert.equal(f.calls(), 0);
  } finally { f.dispose(); }
});

test("整体 Story 来源、缺失、版本与确认：只认文件变化，主任务完成后仍可使用", async () => {
  const f = fixture();
  try {
    assert.equal(f.coordinator.status("parent").sources[1].missing, "子任务 Story 尚不可读");
    f.coordinator.generate("parent", "owner"); f.coordinator.generate("parent", "owner");
    await f.coordinator.settled("parent");
    assert.equal(f.calls(), 1, "重复请求不启动第二个写者");
    const first = f.coordinator.status("parent");
    assert.ok(first.current); assert.equal(first.can_confirm, false);
    assert.equal(f.task.summary.status, "completed");
    const doc = readArtifact(undefined, OVERALL_STORY_ARTIFACT, { taskMaterialRoot: f.task.summary.workspace });
    assert.match(doc!.content, /验收口径/);
    assert.equal(listArtifactDocuments(undefined, { taskMaterialRoot: f.task.summary.workspace })[0].purpose, "overall_story");
    assert.equal(listArtifactDocuments(undefined, { taskMaterialRoot: f.task.summary.workspace })[0].story_published, true);
    f.child.summary.updated_at = new Date().toISOString();
    assert.equal(f.coordinator.status("parent").stale, false);
    writeFileSync(f.childDoc, "# Story\n新的场景");
    assert.equal(f.coordinator.status("parent").stale, true);
    assert.equal(f.calls(), 1, "源变化不自动生成");
    f.task.summary.requirement_graph!.repositories.pop();
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    const second = f.coordinator.status("parent");
    assert.equal(second.can_confirm, true); assert.notEqual(second.current, first.current);
    assert.match(f.coordinator.revision("parent", second.current!).diff, /新增说明/);
    assert.match(f.coordinator.revision("parent", first.current!).content, /验收口径/);
    assert.throws(() => f.coordinator.confirm("parent", first.current!, "owner"), /已变化/);
    assert.equal(f.coordinator.confirm("parent", second.current!, "owner").confirmed!.by, "owner");
    f.note(); assert.equal(f.coordinator.status("parent").can_confirm, false);
    assert.throws(() => f.coordinator.revision("parent", "../../etc/passwd"), /不存在/);
  } finally { f.dispose(); }
});

test("受邀意见立即持久化排队、串行处理，复检属于作者；处理意见不偷偷同步新来源", async () => {
  const f = fixture();
  try {
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    writeFileSync(f.childDoc, "# Story\n后来改变的设计");
    let release!: () => void;
    const pause = new Promise<void>((r) => { release = r; });
    let runs = 0;
    f.runner(async (_t, job) => {
      runs++;
      assert.match(job.input.files["children/1.md"], /原始场景/, "反馈只修改当前版本来源");
      if (runs === 1) await pause;
      mkdirSync(job.root, { recursive: true });
      writeFileSync(join(job.root, "story.md"), "新增开头\n" + job.before);
      writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({
        annotation_id: a.id, outcome: "fixed", summary: "已在文档开头补充整体场景说明", evidence: ["story.md:1"],
      }))));
    });
    const a = f.note(), b = f.note("第二条");
    f.coordinator.submit("parent", [a], "reviewer");
    await Promise.resolve();
    assert.equal(f.store.list()[0].sent_via, "overall_story_processing");
    assert.throws(() => f.store.verify(a.id, "reviewer"), /排队或处理中/);
    f.coordinator.submit("parent", [b], "reviewer");
    assert.equal(f.store.list()[1].sent_via, "overall_story_queue");
    release(); await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined); assert.equal(runs, 2); assert.equal(f.coordinator.status("parent").stale, true);
    const processed = f.store.list()[0];
    const facts = { task_status: "completed", archival: true, review_ready: false, review_annotation_ids: [] };
    assert.equal(annotationClosure(processed, facts, { username: "reviewer", can_override: false, can_route_others: false }).can_verify, true);
    assert.equal(annotationClosure(processed, facts, { username: "owner", can_override: false, can_route_others: true }).can_verify, false);
    const checks = reanchor(f.store.list(), () => readCurrentStory(f.task.summary.workspace));
    assert.equal(checks[0].state, "moved"); assert.equal(checks[0].line, 5);
    assert.throws(() => f.store.verify(a.id, "owner"), /只能由他裁决/);
    f.store.verify(a.id, "reviewer"); assert.equal(f.store.list()[0].status, "verified");
  } finally { f.dispose(); }
});

test("失败、停止、重启不会覆盖正本，失败不计入人工退回", async () => {
  const f = fixture();
  try {
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    const before = readCurrentStory(f.task.summary.workspace), first = readStoryState(f.task.summary.workspace).current;
    f.runner(async (_t, job) => { mkdirSync(job.root, { recursive: true }); writeFileSync(join(job.root, "story.md"), "半份文档"); throw new Error("模型断开"); });
    const a = f.note(); f.coordinator.submit("parent", [a]); await f.coordinator.settled("parent");
    assert.match(f.coordinator.status("parent").error!, /模型断开/);
    assert.equal(readCurrentStory(f.task.summary.workspace), before);
    assert.equal(f.store.list()[0].status, "draft"); assert.equal(f.store.list()[0].returned ?? 0, 0);
    f.runner(async (_t, job) => { await new Promise<void>((r) => job.signal.addEventListener("abort", () => r(), { once: true })); });
    f.coordinator.generate("parent", "owner"); await Promise.resolve();
    await f.coordinator.stop("parent");
    assert.equal(readStoryState(f.task.summary.workspace).current, first);
    const state = readStoryState(f.task.summary.workspace); state.job = { id: "interrupted", by: "owner", started_at: "yesterday" };
    writeStoryState(f.task.summary.workspace, state); f.store.markSent([a.id], "overall_story_processing");
    const recovered = new OverallStoryCoordinator(f.options);
    assert.match(recovered.status("parent").error!, /中断/);
    assert.equal(f.store.list()[0].status, "draft"); assert.equal(readCurrentStory(f.task.summary.workspace), before);
  } finally { f.dispose(); }
});

test("发布指针已写入、回执尚未登记时重启，恢复已有回执而非重复修改", async () => {
  const f = fixture();
  try {
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    const a = f.note(); f.coordinator.submit("parent", [a]); await f.coordinator.settled("parent");
    f.store.markSent([a.id], "overall_story_processing");
    const recovered = new OverallStoryCoordinator(f.options);
    recovered.status("parent");
    assert.equal(f.store.list()[0].sent_via, "overall_story");
    assert.equal(f.store.list()[0].response!.outcome, "fixed");
  } finally { f.dispose(); }
});

test("文件边界禁止链接逃逸；缺失或歧义的子任务 Story 不被猜测", () => {
  const f = fixture();
  try {
    rmSync(f.childDoc); symlinkSync("/etc/hosts", f.childDoc);
    assert.ok(collectStoryInput(f.task, f.options).sources[0].missing);
    mkdirSync(join(f.root, "other")); symlinkSync(join(f.root, "other"), join(f.task.summary.workspace, "overall-story"));
    assert.throws(() => currentStoryFile(f.task.summary.workspace), /越界/);
    const contract = overallStoryGate("/workspace");
    const gate = (tool: string, value: string) => contract(tool, value, {} as import("../src/semanticEvents.ts").SemanticEvent);
    assert.equal(gate("Write", "story.md")?.action, "allow");
    assert.equal(gate("Write", "architecture.semantic.json")?.action, "allow");
    for (const path of ["inputs/requirement.md", "../story.md", "/tmp/escape"]) assert.equal(gate("Write", path)?.action, "deny");
    assert.equal(gate("Bash", "pwd")?.action, "deny");
  } finally { f.dispose(); }
});

test("真实文档会话沿用内核 Story 模板并单独生成平台图源，无需主 Agent 或 Bash", async () => {
  const f = fixture();
  const model = new ScriptedModelServer([
    { tool: { name: "read", input: { path: "inputs/template.md" } } },
    { tool: { name: "write", input: { path: "story.md", content: "# 整体 Story\n待补充接口 Story" } } },
    { tool: { name: "write", input: { path: "architecture.semantic.json", content: JSON.stringify({ schema_version: 1,
      title: "整体模块协作", modules: [{ id: "story", name: "整体 Story", type: "external",
        summary: "提供跨模块设计依据", responsibility: "记录整体设计", interfaces: "Story 文档",
        acceptance: "责任人可检视", evidence: "整体 Story" }], relations: [] }) } } },
    { text: "整理完成，缺少接口子任务 Story。" },
  ]);
  await model.start();
  try {
    f.runner(async (task, job) => {
      await runOverallStorySession(task, job, { taskId: "parent", workspace: task.summary.workspace,
        kernelRoot: KERNEL_ROOT, model: { provider: "maeflow", model: "scripted-v1" }, models: model.modelsJson() });
      assert.equal(readFileSync(join(job.root, "inputs/template.md"), "utf8"), readFileSync(join(KERNEL_ROOT, "skills/mae-flow/assets/STORY-TEMPLATE.md"), "utf8"));
      assert.match(overallStoryMission(job), /无权修改子任务/);
      assert.match(overallStoryMission(job), /不要生成 Archify 字段、坐标、尺寸、端口或折线/);
    });
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined);
    assert.match(readCurrentStory(f.task.summary.workspace), /整体 Story/);
    const architecture = JSON.parse(readCurrentStoryArchitecture(f.task.summary.workspace)!);
    assert.match(architecture.story_sha256, /^[a-f0-9]{64}$/);
    assert.equal(architecture.diagrams.length, 1);
    assert.ok(new EventLog(join(f.task.summary.workspace, "events.jsonl")).replay().some((e) => e.kind === "tool_requested"));
  } finally { await model.stop(); f.dispose(); }
});

test("分析缺少架构产物时发布立即成功，自动会话只生成架构且 Story 保持不变", async () => {
  const f = fixture(true);
  const semantic = JSON.stringify({ schema_version: 1, title: "订单模块", modules: [
    { id: "api", name: "订单 API", type: "backend", summary: "处理订单",
      responsibility: "受理订单", interfaces: "订单接口", acceptance: "可以创建订单", evidence: "订单模块负责处理订单" },
  ], relations: [] });
  const model = new ScriptedModelServer([
    { tool: { name: "read", input: { path: "story.md" } } },
    { tool: { name: "write", input: { path: "architecture.semantic.json", content: semantic } } },
    { text: "语义提炼完成" },
  ], "scripted-v1", { linear: true });
  await model.start();
  try {
    const story = "# Story\n订单模块负责处理订单";
    f.runner(async (task, job) => {
      assert.equal(job.architectureOnly, true);
      assert.equal(job.before, story);
      await runOverallStorySession(task, job, { taskId: "parent", workspace: task.summary.workspace,
        kernelRoot: KERNEL_ROOT, model: { provider: "maeflow", model: "scripted-v1" }, models: model.modelsJson() });
    });
    assert.equal(f.coordinator.adoptAnalysis("parent", story, "owner"), undefined);
    assert.equal(readCurrentStory(f.task.summary.workspace), story);
    assert.equal(f.calls(), 0, "发布不等待异步模型调用");
    assert.equal(f.coordinator.status("parent").label, "Agent 正在更新架构图");
    assert.equal(f.coordinator.status("parent").job?.by, "系统");
    f.coordinator.recoverTask("parent");
    assert.equal(f.coordinator.status("parent").error, undefined, "运行中的任务不能误判为中断");
    await f.coordinator.settled("parent");
    assert.equal(f.calls(), 1);
    assert.equal(f.coordinator.status("parent").error, undefined);
    assert.match(readCurrentStoryArchitecture(f.task.summary.workspace)!, /订单模块/);
    assert.equal(readCurrentStory(f.task.summary.workspace), "# Story\n订单模块负责处理订单");
  } finally { await f.coordinator.shutdown(); await model.stop(); f.dispose(); }
});

test("自动补图默认开启，失败保留原因，同一修订再次发布或重启均不重试", async () => {
  const f = fixture();
  const { autoArchitecture: _disabled, ...options } = f.options;
  const coordinator = new OverallStoryCoordinator(options);
  try {
    f.runner(async () => { throw new Error("模型暂时不可用"); });
    const story = "# Story\n完整模块职责";
    coordinator.adoptAnalysis("parent", story, "owner", " ", "\n");
    const revision = readStoryState(f.task.summary.workspace).current;
    await coordinator.settled("parent");
    assert.equal(f.calls(), 1);
    assert.equal(coordinator.status("parent").error, "模型暂时不可用");
    assert.equal(coordinator.status("parent").error_kind, "architecture");
    coordinator.adoptAnalysis("parent", story, "owner");
    const recovered = new OverallStoryCoordinator(options);
    try {
      recovered.recoverTask("parent");
      recovered.adoptAnalysis("parent", story, "owner");
      await recovered.settled("parent");
      assert.equal(recovered.status("parent").current, revision);
      assert.equal(recovered.status("parent").error, "模型暂时不可用");
      assert.equal(recovered.status("parent").error_kind, "architecture");
      assert.equal(f.calls(), 1);
    } finally { await recovered.shutdown(); }
  } finally { await coordinator.shutdown(); f.dispose(); }
});

test("重启恢复已中断的架构任务后，再次采用 Story 不覆盖中断原因或补跑", async () => {
  const f = fixture();
  try {
    f.coordinator.adoptAnalysis("parent", "# Story\n已发布", "owner");
    const state = readStoryState(f.task.summary.workspace);
    state.job = { id: "interrupted", by: "系统", kind: "architecture", started_at: "yesterday" };
    writeStoryState(f.task.summary.workspace, state);
    const recovered = new OverallStoryCoordinator({ ...f.options, autoArchitecture: true });
    try {
      recovered.recoverTask("parent");
      const error = recovered.status("parent").error;
      assert.match(error!, /上次架构图生成会话已中断/);
      recovered.adoptAnalysis("parent", "# Story\n已发布", "owner");
      assert.equal(recovered.status("parent").error, error);
      assert.equal(recovered.status("parent").error_kind, "architecture");
      assert.equal(recovered.status("parent").job, undefined);
      assert.equal(f.calls(), 0);
    } finally { await recovered.shutdown(); }
  } finally { f.dispose(); }
});

test("分析已有旧平台架构产物时直接采用，不启动自动任务", async () => {
  const f = fixture(true);
  try {
    const architecture = JSON.stringify({ schema_version: 1, diagrams: [{ id: "api", view: "logical",
      source: { schema_version: 1, diagram_type: "architecture", meta: { title: "现有模块" },
        components: [{ id: "api", type: "backend", label: "接口", pos: [40, 40], size: [180, 64] }], connections: [] } }] });
    f.coordinator.adoptAnalysis("parent", "# Story\n接口职责", "owner", architecture);
    await f.coordinator.settled("parent");
    assert.equal(f.calls(), 0);
    assert.equal(f.coordinator.status("parent").job, undefined);
    assert.match(readCurrentStoryArchitecture(f.task.summary.workspace)!, /现有模块/);
  } finally { await f.coordinator.shutdown(); f.dispose(); }
});

for (const condition of ["canceled", "stopped", "empty", "child", "disabled"] as const) {
  test(`自动补图跳过 ${condition}，不影响 Story 发布`, async () => {
    const f = fixture(condition !== "disabled");
    try {
      if (condition === "canceled") f.task.summary.status = "canceled";
      if (condition === "stopped") await f.coordinator.shutdown();
      if (condition === "child") f.task.summary.parent_task_id = "another-parent";
      const story = condition === "empty" ? " \n" : "# Story\n模块设计";
      assert.equal(f.coordinator.adoptAnalysis("parent", story, "owner"), undefined);
      await f.coordinator.settled("parent");
      assert.ok(readStoryState(f.task.summary.workspace).current);
      assert.equal(f.calls(), 0);
      assert.equal(f.coordinator.status("parent").job, undefined);
    } finally { await f.coordinator.shutdown(); f.dispose(); }
  });
}

test("自动补图启动异常只记日志，Story 仍成功发布", async () => {
  const f = fixture(true), logs: string[] = [];
  const coordinator = new OverallStoryCoordinator({ ...f.options, log: (message) => logs.push(message),
    ready() { throw new Error("模型尚未配置"); } });
  try {
    assert.equal(coordinator.adoptAnalysis("parent", "# Story\n模块职责", "owner"), undefined);
    assert.equal(readCurrentStory(f.task.summary.workspace), "# Story\n模块职责");
    assert.equal(f.calls(), 0);
    assert.match(logs[0], /自动补充架构图未启动.*模型尚未配置/);
  } finally { await coordinator.shutdown(); f.dispose(); }
});

test("发布回调已启动架构任务时，自动补图不再启动第二个任务", async () => {
  const f = fixture(true);
  const coordinator = new OverallStoryCoordinator({ ...f.options,
    published() { coordinator.generateArchitecture("parent", "owner"); } });
  try {
    f.runner(async () => { throw new Error("保留当前任务的错误"); });
    coordinator.adoptAnalysis("parent", "# Story\n模块职责", "owner");
    assert.equal(coordinator.status("parent").job?.by, "owner");
    await coordinator.settled("parent");
    assert.equal(f.calls(), 1);
    assert.equal(coordinator.status("parent").error, "保留当前任务的错误");
  } finally { await coordinator.shutdown(); f.dispose(); }
});

test("分析阶段的架构语义由宿主布局并真实渲染后随 Story 发布", async () => {
  const f = fixture(true);
  try {
    const semantic = JSON.stringify({ schema_version: 1, title: "订单协作", modules: [
      { id: "ui", name: "订单界面", type: "frontend", summary: "提交订单" },
      { id: "api", name: "订单服务", type: "backend", summary: "处理订单" },
    ], relations: [{ from: "ui", to: "api", label: "提交订单" }] });
    f.coordinator.adoptAnalysis("parent", "# Story\n订单界面向订单服务提交订单", "owner", undefined, semantic);
    assert.equal(f.coordinator.status("parent").job?.kind, "architecture");
    await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined);
    const architecture = JSON.parse(readCurrentStoryArchitecture(f.task.summary.workspace)!);
    assert.equal(architecture.diagrams[0].source.meta.views[0].label, "订单界面 → 订单服务");
    assert.equal(f.calls(), 0, "已有语义时只编译，不调用模型补图");
  } finally { await f.coordinator.shutdown(); f.dispose(); }
});

test("TaskService 转交整体 Story：completed 可提交，普通原文仍禁止、重复提交幂等", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-story-service-"));
  const service = new TaskService({ dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const task = service.create("需求", { account: "owner", collaborators: ["reviewer"], requirementAnalysis: true });
    const internal = (service as any).tasks.get(task.id);
    internal.summary.status = "completed";
    internal.summary.requirement_graph = { stage: "confirmed", repositories: [{ id: "x", name: "x" }], dependencies: [] };
    const coordinator = new OverallStoryCoordinator({ task: () => internal, artifactRoot: () => undefined, ready() {},
      run: async (_t, job) => {
        mkdirSync(job.root, { recursive: true }); writeFileSync(join(job.root, "story.md"), "# Story\n说明");
        writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({ annotation_id: a.id,
          outcome: "not_fixed", summary: "需要子任务先修改设计", evidence: [] }))));
      } });
    (service as any).overallStories = coordinator;
    coordinator.generate(task.id, "owner"); await coordinator.settled(task.id);
    const note = service.addAnnotation(task.id, { author: "reviewer", artifact: OVERALL_STORY_ARTIFACT,
      file: OVERALL_STORY_ARTIFACT, line: 2, anchor: "说明", note: "改设计", kind: "doc" });
    await assert.rejects(service.sendAnnotations(task.id, [note.id], "reviewer"), /责任人/);
    assert.deepEqual((await service.sendAnnotations(task.id, [note.id], "owner")).sent, [note.id]);
    await coordinator.settled(task.id);
    assert.deepEqual((await service.sendAnnotations(task.id, [note.id], "owner", true)).sent, [note.id]);
    const ordinary = service.addAnnotation(task.id, { author: "reviewer", artifact: "__task_requirement__",
      file: "需求原文", line: 1, anchor: "需求", note: "修改原文", kind: "doc" });
    await assert.rejects(service.sendAnnotations(task.id, [ordinary.id], "owner"), /已经结束/);
    await assert.rejects(service.sendAnnotations(task.id, [note.id], "stranger"), /责任人/);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP：受邀检视人能读整体 Story，只有责任人能生成和确认", async () => {
  const { createTaskServer } = await import("../src/server.ts");
  const { LocalAuth } = await import("../src/auth.ts");
  const root = mkdtempSync(join(tmpdir(), "mfc-story-auth-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("owner", "owner-password", "developer");
  auth.createUser("reviewer", "reviewer-password", "developer");
  const service = new TaskService({ dataDir: join(root, "tasks"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("需求", { account: "owner", collaborators: ["reviewer"], requirementAnalysis: true });
  let generated = 0, confirmed = 0, architecture = 0;
  (service as any).overallStories = { status: () => ({ current: "one", label: "待检视" }),
    generate: () => { generated++; return {}; }, generateArchitecture: () => { architecture++; return {}; }, confirm: () => { confirmed++; return {}; }, shutdown: async () => {} };
  const server = createTaskServer(service, { auth });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const login = async (name: string) => (await fetch(base + "/auth/login", { method: "POST", body: JSON.stringify({ username: name, password: name + "-password" }) })).headers.get("set-cookie")!.split(";")[0];
    const reviewer = await login("reviewer"), owner = await login("owner");
    const url = `${base}/tasks/${task.id}/overall-story`;
    assert.equal((await fetch(url, { headers: { cookie: reviewer } })).status, 200);
    assert.equal((await fetch(url, { method: "POST", headers: { cookie: reviewer }, body: "{}" })).status, 403);
    assert.equal((await fetch(url + "/architecture", { method: "POST", headers: { cookie: reviewer } })).status, 403);
    assert.equal((await fetch(url + "/architecture", { method: "POST", headers: { cookie: owner } })).status, 202);
    assert.equal(architecture, 1);
    assert.equal((await fetch(url + "/confirm", { method: "POST", headers: { cookie: reviewer }, body: '{"revision":"one"}' })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { cookie: owner }, body: "{}" })).status, 202);
    assert.equal((await fetch(url + "/confirm", { method: "POST", headers: { cookie: owner }, body: '{"revision":"one"}' })).status, 200);
    assert.equal(generated, 1); assert.equal(confirmed, 1);
  } finally { await new Promise<void>((r) => server.close(() => r())); await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ["reopen", "resubmit", "edit", "resolve"] as const) {
 test(`整体 Story 旧轮完成保留人工 ${action}，不污染新版本`, async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.coordinator.generate("parent", "owner");
    await f.coordinator.settled("parent");
    const note = f.note();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    f.runner(async (_task, job) => {
      entered(); await hold;
      mkdirSync(job.root, { recursive: true });
      writeFileSync(join(job.root, "story.md"), `${job.before}\n旧轮完成的改动`);
      writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({
        annotation_id: a.id, revision: a.rework ?? 0, outcome: "fixed", summary: "已在整体 Story 中补充本轮要求的验收说明", evidence: ["story.md:5"],
      }))));
    });
    f.coordinator.submit("parent", [note], "reviewer");
    await started;
    if (action === "edit") f.store.edit(note.id, "新的验收口径说明", "reviewer", true);
    else if (action === "resolve") f.store.resolveAsOwner(note.id, "owner",
      { revision: 0, outcome: "deferred", reason: "下一轮补充约定" });
    else {
      f.store.reopen(note.id, "owner", undefined, true);
      if (action === "resubmit") f.coordinator.submit("parent", f.store.drafts(), "owner");
    }
    release();
    await f.coordinator.settled("parent");
    const saved = f.store.list()[0];
    assert.equal(saved.status, action === "resolve" ? "verified" : action === "resubmit" ? "sent" : "draft");
    assert.equal(saved.rework ?? 0, action === "resolve" ? 0 : 1);
    if (action === "resubmit") {
      assert.equal(saved.response?.revision, 1);
      assert.equal(f.calls(), 3, "生成、旧轮修订、新轮修订分别执行");
    } else assert.equal(saved.response, undefined);
    assert.equal(f.coordinator.status("parent").error, undefined, "旧回执不适用不代表已发布的文档修订失败");
  } finally { release?.(); await f.coordinator.shutdown(); f.dispose(); }
});

}


test("旧单仓 confirmed 且无子任务时，Story 批注交给当前任务，不要求生成汇总版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-legacy-story-review-"));
  const service = new TaskService({ dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const task = service.create("修改服务", { account: "owner", ticket: "REQ-43" });
    const internal = (service as any).tasks.get(task.id);
    internal.summary.requirement_graph = { stage: "confirmed", repositories: [{ id: "repo-1", name: "FMEMateService", ticket: "REQ-43" }], dependencies: [] };
    internal.cwd = task.workspace;
    writeFileSync(join(task.workspace, ".mae-flow.json"), "{}");
    mkdirSync(join(task.workspace, ".mae-flow-work/REQ-43"), { recursive: true });
    writeFileSync(join(task.workspace, ".mae-flow-work/REQ-43/story.md"), "# Story\n当前设计");
    assert.equal(readStoryState(task.workspace).current, undefined);
    const docs = listArtifactDocuments(task.workspace, { taskMaterialRoot: task.workspace, analysisStory: "REQ-43/story.md" });
    assert.equal(docs.find(doc => doc.name === OVERALL_STORY_ARTIFACT)?.story_published, undefined);
    const note = service.addAnnotation(task.id, { author: "owner", artifact: OVERALL_STORY_ARTIFACT,
      file: "story.md", line: 2, anchor: "当前设计", note: "补充异常处理", kind: "doc" });
    assert.deepEqual((await service.sendAnnotations(task.id, [note.id], "owner")).sent, [note.id]);
    assert.equal(readStoryState(task.workspace).current, undefined, "不凭空生成另一份 Story");
    const instructions = internal.pendingMainSteers.join("\n");
    assert.match(instructions, /补充异常处理/);
    assert.match(instructions, /实际编辑文件为 .mae-flow-work\/REQ-43\/story.md/);
    assert.doesNotMatch(instructions, /plan_revision|story_sha256/, "普通 Story 检视不要求重新拆分任务");
    assert.equal(service.listAnnotations(task.id).items.find(item => item.id === note.id)?.status, "sent");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const selfLinked of [false, true]) {
  test(`HTTP：旧单仓四条 Story 草稿重启后可批量提交（自关联=${selfLinked}）`, async () => {
    const { createTaskServer } = await import("../src/server.ts");
    const root = mkdtempSync(join(tmpdir(), "mfc-story-legacy-http-"));
    const options = { dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };
    let service = new TaskService(options);
    let server: ReturnType<typeof createTaskServer> | undefined;
    try {
      const task = service.create("修改服务", { ticket: "REQ-43" });
      const internal = (service as any).tasks.get(task.id);
      internal.summary.requirement_graph = { stage: "confirmed", repositories: [{ id: "repo-1", name: "FMEMateService",
        ticket: "REQ-43", ...(selfLinked ? { task_id: task.id } : {}) }], dependencies: [] };
      internal.cwd = task.workspace;
      writeFileSync(join(task.workspace, ".mae-flow.json"), "{}");
      mkdirSync(join(task.workspace, ".mae-flow-work/REQ-43"), { recursive: true });
      writeFileSync(join(task.workspace, ".mae-flow-work/REQ-43/story.md"), "# Story\n当前设计");
      const notes = ["客户面感知，需要返回提示信息", "不回显文案需要调整", "会话不存在要回显合适文案", "这是给北向 MCP 使用的"].map(note =>
        service.addAnnotation(task.id, { author: "本地用户", artifact: OVERALL_STORY_ARTIFACT,
          file: "story.md", line: 2, anchor: "当前设计", note, kind: "doc" }));
      (service as any).persist(internal);
      await service.shutdown();
      service = new TaskService(options);
      assert.equal(service.recover().restored, 1);
      server = createTaskServer(service);
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      const response = await fetch(`${base}/tasks/${task.id}/annotations/send`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: notes.map(note => note.id) }) });
      const result = await response.json() as { sent?: string[] };
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.deepEqual(result.sent, notes.map(note => note.id));
      assert.equal(readStoryState(task.workspace).current, undefined, "不需要创建整体 Story 版本");
      const restored = (service as any).tasks.get(task.id);
      const instructions = restored.pendingMainSteers.join("\n");
      for (const note of notes) assert.ok(instructions.includes(note.note));
      assert.match(instructions, /实际编辑文件为 .mae-flow-work\/REQ-43\/story.md/);
      assert.equal(service.listAnnotations(task.id).items.filter(note => note.status === "sent").length, 4);
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await service.shutdown(); rmSync(root, { recursive: true, force: true });
    }
  });
}
