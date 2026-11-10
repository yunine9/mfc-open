import { componentPipelineScript, fixtureUnitTest } from "./componentPipelineFixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { genericDomainSkillFixture, runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";
import { bundledExtractionSkill } from "../src/knowledgeExtractionSkills.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("等待会话超时");
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-continuity-")), source = join(dir, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); writeFileSync(join(source, "code.ts"), "const ORIGINAL_CONTEXT = true;\n"); git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  return { dir, source, revision: git("rev-parse", "HEAD"), git };
}
const document = { id: "rules", title: "规则", target_id: "domain", path: "docs/knowledge/rules.md", layer: "domain", content: "规则正文", sources: "repo-1 code.ts" };

test("领域萃取重启沿用原轮次、Pi 上下文和固定来源方法，不重复保存草稿", async () => {
  const f = fixture(); let paused = false, release!: () => void;
  const hold = new Promise<void>(resolve => release = resolve);
  const material = await businessMaterial(f.dir);
  const sourcePath = "references/business-sources.md", sourceMethod = bundledExtractionSkill("domain").files[sourcePath];
  assert.ok(sourceMethod?.trim(), "内置方法应提供来源研究文件");
  const method = { ...genericDomainSkillFixture,
    "SKILL.md": `${genericDomainSkillFixture["SKILL.md"]}\n每个会话通过 [来源研究](${sourcePath}) 读取本轮固定的方法。`,
    [sourcePath]: sourceMethod };
  const sourceResults = (request: Record<string, unknown>) => {
    const blocks = ((request.messages ?? []) as any[]).flatMap(message => Array.isArray(message.content) ? message.content : []);
    const ids = new Set(blocks.filter(block => block.type === "tool_use" && block.name === "extraction_skill" && block.input?.path === sourcePath).map(block => block.id));
    return blocks.filter(block => block.type === "tool_result" && ids.has(block.tool_use_id)).map(block => {
      assert.ok(!block.is_error, "来源方法回读必须实际成功");
      return typeof block.content === "string" ? block.content : (block.content ?? []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
    });
  };
  const model = new ScriptedModelServer([
    { tool: { name: "extraction_skill", input: { path: sourcePath } } },
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "component_source", input: { action: "read", component_id: "repo-1", path: "code.ts" } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { text: "等待证据核对" },
    { tool: { name: "extraction_skill", input: { path: sourcePath } } },
    { tool: { name: "knowledge_draft", input: { action: "read", id: "rules" } } },
    { tool: { name: "knowledge_work", input: { action: "list" } } },
    { tool: { name: "knowledge_work_result", input: { summary: "沿用原研究结果完成", document_ids: ["rules"] } } },
    { text: "完成" },
  ], "scripted-v1", { linear: true, beforeScene: async ({ index }) => { if (index === 4 && !paused) { paused = true; await hold; } } });
  await model.start();
  const options = { dataDir: f.dir, model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async () => ({ root: f.source, revision: f.revision }) };
  let service = new DomainKnowledgeExtraction(f.dir, input => runDomainKnowledgeFixture(method, input, options));
  try {
    const job = service.create({ issue_no: "REQ1", title: "业务", scope: "提取业务规则", material_ids: [material.id], repositories: [{ name: "业务", repository: "https://example.test/business.git", branch: "master" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "docs/knowledge" } }, "expert");
    await until(() => paused);
    const turnId = service.get(job.id).turns[0].id;
    const pinnedDigest = service.get(job.id).turns[0].skill?.digest;
    assert.ok(pinnedDigest); assert.deepEqual(sourceResults(model.requests.at(-1)!), [sourceMethod]);
    await service.shutdown(); release();
    assert.equal(service.get(job.id).status, "queued");
    method[sourcePath] = "NEW_SOURCE_METHOD_MUST_NOT_REPLACE_RUNNING_TASK";
    service = new DomainKnowledgeExtraction(f.dir, input => runDomainKnowledgeFixture(method, input, options));
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    const result = service.get(job.id);
    assert.equal(result.status, "done", result.error);
    assert.equal(result.turns.length, 1); assert.equal(result.turns[0].id, turnId);
    assert.equal(result.documents.length, 1); assert.equal(result.documents[0].revision, 1);
    assert.equal(result.evidence.filter(e => e.tool === "component_source" && e.action === "read").length, 1);
    assert.match(JSON.stringify(model.requests.at(-1)), /ORIGINAL_CONTEXT/);
    // 重启后工具继续可用，脚本再次读取固定包；实际结果而非提示词措辞证明方法可回读。
    for (const request of [model.requests[0], model.requests.at(-1)!]) {
      const tools = (request.tools as Array<{ name: string }>).map(tool => tool.name);
      for (const name of ["extraction_skill", "knowledge_material", "business_knowledge", "knowledge_evidence"]) assert.ok(tools.includes(name), name);
    }
    assert.deepEqual(sourceResults(model.requests.at(-1)!), [sourceMethod, sourceMethod]);
    assert.equal(result.turns[0].skill?.digest, pinnedDigest);
    const pinned = JSON.parse(readFileSync(join(f.dir, "domain-extraction", job.id, "skill.json"), "utf8"));
    assert.equal(pinned.digest, pinnedDigest); assert.equal(pinned.files[sourcePath], sourceMethod);
    assert.match(readFileSync(join(f.dir, "domain-extraction", job.id, "skill-runs", turnId, "coordinator", "events.jsonl"), "utf8"), /"context_restored":true/);
  } finally { release(); await service.shutdown(); await model.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("组件萃取重启保留通过的小任务并创建新会话；明确停止不复活", async () => {
  const f = fixture(); let paused = false, release!: () => void;
  const hold = new Promise<void>(resolve => release = resolve), oldEc = process.env.MAE_FLOW_EC_BIN;
  const ec = join(f.dir, "ec"); writeFileSync(ec, `#!/usr/bin/env node\nprocess.stdout.write(process.argv[4]?.includes("tests/") ? ${JSON.stringify(fixtureUnitTest)} : "caller code\\n");\n`, { mode: 0o700 }); process.env.MAE_FLOW_EC_BIN = ec;
  seedTechnologyStacks(f.dir, ["cpp"]);
  const row = saveComponentRepository(f.dir, { name: "组件", repository: "https://example.test/component.git", branch: "master", path: "", languages: ["cpp"] }, "expert");
  const fixtureScript = componentPipelineScript(row.id, "code.ts", f.revision, "caller code\n", fixtureUnitTest);
  let model = new ScriptedModelServer(fixtureScript.script, "scripted-v1", { linear: true, beforeScene: async ({ index }) => {
    if (index === fixtureScript.offsets["plan-pool"] && !paused) { paused = true; await hold; }
  } });
  await model.start();
  const options = { dataDir: f.dir, model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async () => ({ root: f.source, revision: f.revision }) };
  let service = new ComponentResearch(f.dir, input => runComponentResearch(input, options));
  try {
    const job = service.start({ language: "cpp" }, "expert");
    await until(() => paused); await service.shutdown(); release(); await model.stop();
    assert.equal(service.get(job.id).status, "queued");
    assert.equal(service.get(job.id).pipeline!.tasks.find(t => t.id === "inventory")!.status, "done");
    const inventoryReads = service.get(job.id).evidence.filter(e => e.pipeline_task === "inventory").length;
    model = new ScriptedModelServer(fixtureScript.script.slice(fixtureScript.offsets["plan-pool"]), "scripted-v1", { linear: true }); await model.start();
    service = new ComponentResearch(f.dir, input => runComponentResearch(input, options));
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    assert.equal(service.get(job.id).evidence.filter(e => e.pipeline_task === "inventory").length, inventoryReads);
    assert.equal(service.get(job.id).document!.sections.length, 4);
    service.remove(job.id, "expert");
    const stopped = service.start({ language: "cpp" }, "expert"); assert.notEqual(stopped.id, job.id); service.stop(stopped.id); await service.shutdown();
    service = new ComponentResearch(f.dir, async () => { throw new Error("不应执行已停止任务"); });
    assert.equal(service.get(stopped.id).status, "cancelled");
  } finally { release(); await service.shutdown(); await model.stop(); if (oldEc === undefined) delete process.env.MAE_FLOW_EC_BIN; else process.env.MAE_FLOW_EC_BIN = oldEc; rmSync(f.dir, { recursive: true, force: true }); }
});

test("生产线验收14：领域修订建议在重启前落盘，停止后可编辑、主动接续保护人工版本", async () => {
  const f = fixture(); let saved = false;
  let service = new DomainKnowledgeExtraction(f.dir, async input => {
    if (input.turn.mode === "extract") { input.save({ ...document, layer: "domain" }, { content: null, revision: f.revision }); return "首次完成"; }
    input.save({ ...document, layer: "domain", content: "待审查建议" }); saved = true;
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return "迟到答复";
  });
  try {
    const job = service.create({ issue_no: "REQ1", title: "业务", scope: "规则", repositories: [{ repository: "https://example.test/business.git", branch: "master" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "docs/knowledge" } }, "expert");
    await until(() => service.get(job.id).status === "done");
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "补充规则" }, "expert");
    await until(() => saved);
    assert.throws(() => service.edit(job.id, { document: { ...document, layer: "domain", content: "人工新版本" }, base_revision: 1 }, "editor"), /研究进行中/);
    service.stop(job.id); await service.shutdown();
    const turn = service.get(job.id).turns.at(-1)!;
    assert.equal(turn.proposals[0].document.content, "待审查建议");
    service.edit(job.id, { document: { ...document, layer: "domain", content: "人工新版本" }, base_revision: 1 }, "editor");
    service = new DomainKnowledgeExtraction(f.dir, async input => {
      assert.equal(input.turn.id, turn.id);
      assert.equal(input.turn.proposals[0].document.content, "待审查建议");
      input.save({ ...document, layer: "domain", content: "接续后的建议" });
      return "修订完成";
    });
    service.resume(job.id, "expert");
    await until(() => service.get(job.id).status === "done");
    assert.equal(service.get(job.id).turns.at(-1)!.proposals[0].base_revision, 1);
    assert.throws(() => service.decide(job.id, turn.id, document.id, "accept", "expert"), /新版本/);
    assert.equal(service.get(job.id).documents[0].content, "人工新版本");
  } finally { await service.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});
