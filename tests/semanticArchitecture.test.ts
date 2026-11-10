import assert from "node:assert/strict";
import test from "node:test";
import { compileSemanticArchitecture, SEMANTIC_ARCHITECTURE_GUIDANCE } from "../src/semanticArchitecture.ts";
import { storyArchitecture } from "../src/storyArchitecture.ts";
import { renderArchify } from "../src/archifyRender.ts";

test("分析提示词要求必须交付架构语义，文件路径只出现一次供宿主替换", () => {
  assert.ok(SEMANTIC_ARCHITECTURE_GUIDANCE.startsWith("架构语义是本次需求分析必须交付的产物之一"));
  assert.match(SEMANTIC_ARCHITECTURE_GUIDANCE, /写完 Story 后必须写它/);
  assert.match(SEMANTIC_ARCHITECTURE_GUIDANCE, /缺失时平台不会生成架构图/);
  assert.match(SEMANTIC_ARCHITECTURE_GUIDANCE, /不要以 Story 已完成为由省略/);
  assert.equal(SEMANTIC_ARCHITECTURE_GUIDANCE.split("architecture.semantic.json").length - 1, 1);
});

test("语义模块由宿主生成坐标与连线，首次即可通过真实 Archify 渲染", async () => {
  const story = "# Story\n界面调用编排服务，编排服务写入版本存储。";
  const semantic = JSON.stringify({ schema_version: 1, title: "需求模块协作", modules: [
    { id: "workbench", name: "任务工作台", type: "frontend", summary: "发起与检视任务",
      responsibility: "展示任务状态", interfaces: "任务 API", acceptance: "可查看处理结果", evidence: "界面调用编排服务" },
    { id: "orchestrator", name: "任务编排", type: "backend", summary: "推进任务与文档会话",
      responsibility: "组织任务状态", interfaces: "任务 API 与存储", acceptance: "任务持续推进", evidence: "编排服务" },
    { id: "versions", name: "版本存储", type: "database", summary: "保存 Story 版本",
      responsibility: "保存已发布版本", interfaces: "文件版本", acceptance: "历史版本可读", evidence: "版本存储" },
  ], relations: [
    { from: "workbench", to: "orchestrator", label: "提交与查询" },
    { from: "orchestrator", to: "versions", label: "发布版本" },
  ] });
  const artifact = await compileSemanticArchitecture(story, semantic);
  const projection = storyArchitecture(story, artifact);
  assert.deepEqual(projection.warnings, []);
  assert.equal(projection.diagrams.length, 1);
  assert.equal(projection.diagrams[0].nodes?.length, 3);
  assert.equal(projection.diagrams[0].source.diagram_type, "architecture");
  const meta = projection.diagrams[0].source.meta as { views: unknown[] };
  assert.deepEqual(meta.views, [
    { id: "collaboration-1", label: "任务工作台 → 任务编排", focus: ["workbench", "orchestrator"], note: "提交与查询" },
    { id: "collaboration-2", label: "任务编排 → 版本存储", focus: ["orchestrator", "versions"], note: "发布版本" },
  ]);
  const rendered = await renderArchify(projection.diagrams[0].source);
  assert.ok(rendered.html, rendered.error);
  assert.match(rendered.html!, /id="guided-view-play"/);
  assert.match(rendered.html!, /collaboration-1/);
});

test("没有关系的单模块图仍生成可播放讲解入口", async () => {
  const artifact = await compileSemanticArchitecture("# Story\n单模块", JSON.stringify({
    schema_version: 1, title: "单模块", modules: [{ id: "only", name: "唯一模块", summary: "承担全部职责" }], relations: [],
  }));
  const source = JSON.parse(artifact).diagrams[0].source;
  assert.deepEqual(source.meta.views, [
    { id: "module-1", label: "唯一模块", focus: ["only"], note: "承担全部职责" },
  ]);
  const rendered = await renderArchify(source);
  assert.ok(rendered.html, rendered.error);
  assert.match(rendered.html!, /module-1/);
});

test("语义产物拒绝重复模块和未知关系端点", async () => {
  const base = { schema_version: 1, title: "错误样本", modules: [
    { id: "one", name: "一", summary: "一" }, { id: "one", name: "二", summary: "二" },
  ], relations: [] };
  await assert.rejects(compileSemanticArchitecture("Story", JSON.stringify(base)), /id 重复/);
  base.modules[1].id = "two";
  base.relations = [{ from: "one", to: "missing", label: "调用" }] as never[];
  await assert.rejects(compileSemanticArchitecture("Story", JSON.stringify(base)), /未知模块/);
});
