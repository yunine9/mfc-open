import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { COMPONENT_ANALYST, childKnowledgeTools, componentAnalysisPrompt } from "../src/componentKnowledgePlanning.ts";
import { consumptionFixture } from "./componentConsumptionFixture.ts";
import { TaskService } from "../src/taskService.ts";
import { ComponentKnowledgeConsumption } from "../src/componentKnowledgeConsumption.ts";

const messages = (request: unknown) => JSON.stringify((request as any).messages);
const system = (request: any) => JSON.stringify(request.system ?? request.messages.filter((m: any) => m.role === "system"));

test("启动目录的解析警告也有容量上限，并明确当前知识可能不完整", () => {
  const directory = { mode: "full", count: 0, offset: 0, page_size: 12, next_offset: null, hits: [],
    warnings: Array.from({ length: 50 }, () => "解析失败" + "😀".repeat(10_000)) };
  const prompt = componentAnalysisPrompt("后台任务", directory);
  const json = prompt.split("【当前可查阅的组件能力目录】\n")[1].split("\n")[0];
  const shown = JSON.parse(json);
  assert.ok(json.length < 2_000, "大量长诊断不能扩大自动提供的目录");
  assert.equal(shown.warnings.length, 4);
  assert.match(shown.warnings[0], /已省略/);
  assert.match(shown.warnings[3], /47 条.*可能不完整/);
  assert.equal(directory.warnings.length, 50, "原始诊断仍供按需查阅");
});

for (const indexed of [true, false]) test(`编码前组件分析：启动目录、${indexed ? "memsearch" : "本地检索"}、完整用法及报告交回主会话`, async () => {
  const f = consumptionFixture(), doc = f.publish();
  let searches = 0, directories = 0;
  const search = new KnowledgeSearch(f.data, indexed ? {
    ingest: async () => true,
    search: async () => { searches++; return [{ id: `component-card:${doc.id}:pool-submit`, heading: "后台任务统一执行", score: 1 }]; },
  } as any : undefined);
  const uses: any[] = [];
  const knowledge = createKnowledgeTool({ service: () => search, context: () => f.context, onUse: e => uses.push(e) });
  const control = defineTool({ name: "push_branch", label: "push", description: "宿主推送", parameters: Type.Object({}), execute: async () => { throw new Error("不应调用"); } });
  assert.deepEqual(childKnowledgeTools([knowledge, control, null, {}]), [knowledge]);
  const plan = join(f.cwd, "implementation.md");
  const original = "# 实施计划\n## 原有任务\n批量导出报告；已有包装负责初始化。\n";
  writeFileSync(plan, original);
  const task = `本次业务目标：批量导出报告，前台保持响应。确认要求：退出时等待已开始工作完成。工作项：生成报告、后台执行、退出清理。相关代码：existing.cpp；初步方案：自行创建线程，允许提出替代方案。实施附录：${plan}。`;
  const report = `生成报告仍由业务代码负责；后台执行复用 Pool.submit，已有封装负责初始化，业务代码负责退出前等待任务完成和捕获对象的生命周期。依赖待核实，文档修订号不是依赖版本。依据：${doc.id}@${doc.revision}，paradigm_id=pool-submit；编码时读公共配置、示例与约束。`;
  const read = { action: "read", id: doc.id, revision: doc.revision, paradigm_id: "pool-submit" };
  const scenes: Scene[] = [
    { tool: { name: "read", input: { path: "existing.cpp" } } },
    { tool: { name: "Task", input: { subagent_type: COMPONENT_ANALYST, description: "分析本次实现可复用的组件", prompt: task } } },
    { tool: { name: "knowledge", input: { action: "search", scope: "components", query: "C++ 后台执行 退出等待" } } },
    { tool: { name: "knowledge", input: read } },
    { text: report },
    { tool: { name: "write", input: { path: plan, content: original + "\n## 组件使用\n" + report + "\n" } } },
    { tool: { name: "knowledge", input: read } },
    { text: "已整合职责分工并读取正式用法，继续实现。" },
  ];
  const model = new ScriptedModelServer(scenes, "scripted-v1", { linear: true });
  let session: CloudSession | undefined;
  try {
    await model.start();
    const agentDir = join(f.dir, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    const events = new EventLog(join(f.dir, "events.jsonl"));
    session = await CloudSession.create({ taskId: "component-test", workspace: f.cwd, agentDir, provider: "maeflow", model: "scripted-v1", eventLog: events,
      transcript: new TranscriptStore(join(f.dir, "transcript.jsonl"), "main"), gate: new GateService({ workspace: f.cwd, cwd: f.cwd }),
      humanGate: new HumanGate(join(f.dir, "waiting.json")), extraTools: [knowledge, control],
      componentKnowledge: new ComponentKnowledgeConsumption({ dataDir: f.data, cwd: f.cwd, context: () => f.context, languages: () => ["cpp"], baseline: () => "main" }),
      componentAnalysisContext: () => { directories++; return search.componentContext(f.context); } });
    const outcome = await session.start("进入 build，先读清实施任务并完成编码前组件分析。");
    assert.equal(outcome.status, "turn_finished");
    assert.match(system(model.requests[0]), /开始编码前.*component-plan-agent/);
    assert.match(system(model.requests[0]), /全部实施工作项/);
    assert.match(system(model.requests[0]), /整合进现有 implementation/);
    assert.ok(!messages(model.requests[1]).includes(doc.id), "广泛阅读现有代码不触发组件资料注入");
    assert.equal(directories, 1, "目录只在专门的组件分析会话启动时提供");
    const child = model.requests[2] as any;
    assert.ok(messages(child).includes(task));
    assert.match(messages(child), /当前可查阅的组件能力目录/);
    assert.ok(messages(child).includes(doc.id));
    assert.match(messages(child), /执行后台任务/);
    assert.ok(!messages(child).includes("链接已发布的 pool target"), "启动只给目录，不灌入全文");
    const names = child.tools.map((t: any) => t.function?.name ?? t.name);
    assert.ok(names.includes("knowledge")); assert.ok(!names.includes("push_branch"));
    assert.doesNotMatch(system(child), /等待分析报告再编码/);
    assert.match(messages(model.requests[4]), /链接已发布的 pool target/);
    assert.match(messages(model.requests[4]), /任务结束前不能释放捕获的对象/);
    assert.match(messages(model.requests[4]), /TEST\(Pool, ExecutesTask\)/);
    assert.ok(messages(model.requests[5]).includes(report), "主会话确实收到职责、条件与原文入口");
    assert.match(readFileSync(plan, "utf8"), /原有任务/);
    assert.ok(readFileSync(plan, "utf8").includes(report));
    assert.match(messages(model.requests[7]), /链接已发布的 pool target/);
    assert.equal(events.replay().find(e => e.kind === "agent_finished")?.payload.final_text, report);
    assert.equal(uses.filter(e => e.moment === "expand").length, 2);
    assert.equal(searches, indexed ? 1 : 0);
  } finally { session?.dispose(); await model.stop(); f.cleanup(); }
});

for (const kind of ["reviewer-agent", COMPONENT_ANALYST]) test(`${kind}：普通子会话不加载目录，组件目录故障可通过知识工具继续读取`, async () => {
  const f = consumptionFixture(), doc = f.publish(), search = new KnowledgeSearch(f.data);
  const isAnalyst = kind === COMPONENT_ANALYST;
  let directories = 0;
  const scenes: Scene[] = [
    { tool: { name: "Task", input: { subagent_type: kind, description: "分析当前任务", prompt: "后台任务执行；待核实组件依赖。" } } },
    ...(isAnalyst ? [{ tool: { name: "knowledge", input: { action: "component_context" } } }] : []),
    { text: "已完成本次分析，版本仍待核实。" },
    { text: "收到分析报告。" },
  ];
  const model = new ScriptedModelServer(scenes, "scripted-v1", { linear: true });
  let session: CloudSession | undefined;
  try {
    await model.start(); const agentDir = join(f.dir, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    session = await CloudSession.create({ taskId: "component-scope", workspace: f.cwd, agentDir, provider: "maeflow", model: "scripted-v1",
      eventLog: new EventLog(join(f.dir, "events.jsonl")), transcript: new TranscriptStore(join(f.dir, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace: f.cwd, cwd: f.cwd }), humanGate: new HumanGate(join(f.dir, "waiting.json")),
      extraTools: [createKnowledgeTool({ service: () => search, context: () => f.context })],
      componentAnalysisContext: () => { directories++; throw new Error("目录临时不可用"); } });
    assert.equal((await session.start("开始分析")).status, "turn_finished");
    assert.equal(directories, isAnalyst ? 1 : 0);
    if (isAnalyst) {
      assert.match(messages(model.requests[1]), /启动目录读取未完成/);
      assert.ok(messages(model.requests[2]).includes(doc.id));
    } else {
      assert.doesNotMatch(messages(model.requests[1]), /组件能力目录/);
      assert.ok(!messages(model.requests[1]).includes(doc.id));
    }
    assert.match(messages(model.requests.at(-1)), /版本仍待核实/);
  } finally { session?.dispose(); await model.stop(); f.cleanup(); }
});

test("宿主启动目录与知识工具使用同一范围，停用后不再提供旧来源", async () => {
  const f = consumptionFixture(), doc = f.publish();
  const service: any = new TaskService({ dataDir: f.data, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const summary = service.create("组件分析目录"); service.removeFromQueue(summary.id);
    const task = service.tasks.get(summary.id);
    task.cwd = f.cwd; task.summary.repo_url = f.context.repositories[0]; task.summary.repositories = f.context.repositories;
    task.summary.product_version = "v2";
    const initial = service.componentAnalysisContext(task);
    const tool = service.memoryTools(task).find((t: any) => t.name === "knowledge");
    const current = await tool.execute("catalog", { action: "component_context" });
    assert.deepEqual(initial, current.details);
    assert.ok(initial.hits.some((h: any) => h.id === doc.id));
    const { saveKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    assert.equal(service.componentAnalysisContext(task).hits.length, 0);
  } finally { await service.shutdown(); f.cleanup(); }
});
