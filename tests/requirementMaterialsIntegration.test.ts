import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";
import { buildRequirementMaterials } from "../src/requirementMaterials.ts";
import { materializeRequirementDocument, requirementContext } from "../src/requirementDocument.ts";
import { prepareRequirementReviewWorkspace } from "../src/requirementReviewAgent.ts";
import { writeStoryArtifacts } from "./requirementGraphFixture.ts";

test("多资料 API：预览、创建、原件下载使用同一份完整正文，失败资料不能遗漏后创建", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-multi-requirement-api-"));
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function post(path: string, body: unknown) {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  const files = [
    { name: "目标.md", text: "# 业务目标\n支持批量导入。" },
    { name: "验收.txt", text: "失败后不得重复导入，这是第二份资料独有的验收约束。" },
  ];
  const ids: string[] = [];
  for (const file of files) {
    const upload = await post("/knowledge-materials", { name: file.name, content_base64: Buffer.from(file.text).toString("base64"), scope: "本次需求" });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.state, "ready", upload.body.error);
    ids.push(upload.body.id);
  }
  const preview = await post("/requirement-materials/preview", { material_ids: ids, requirement: "仅面向内部用户。" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.sources.length, 2);
  for (const text of [...files.map(file => file.text), "仅面向内部用户。"]) assert.ok(preview.body.requirement.includes(text));
  assert.ok(preview.body.sources.every((source: any) => source.content === undefined));
  const created = await post("/tasks", { title: "多份需求", requirement_material_ids: ids, requirement: "仅面向内部用户。" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.requirement, preview.body.requirement);
  assert.equal(created.body.waiting.step, "cloud_requirement_analysis_confirm", "沿用一次需求确认");
  for (const [index, source] of created.body.requirement_document.sources.entries()) {
    const response = await fetch(`${base}/tasks/${created.body.id}/requirement-sources?path=${encodeURIComponent(source.path)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /^attachment/);
    assert.equal(await response.text(), files[index].text);
  }
  const missing = await post("/tasks", { requirement_material_ids: [...ids, "material-00000000-0000-0000-0000-000000000000"] });
  assert.equal(missing.status, 400);
  assert.equal(service.list().length, 1);
});

test("多资料修订、拆分与恢复：第二份验收保留，当前修订不被原件覆盖，原件随子任务保存", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-multi-requirement-life-"));
  const options = { autoArchitecture: false, dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dataDir, "no-kernel") }, projection: { upsertTask: async () => {}, deleteTask: async () => {} } as any };
  const service = new TaskService(options), services = [service];
  t.after(async () => { for (const item of services) await item.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  const materialRoot = join(dataDir, "knowledge-materials");
  const ids: string[] = [];
  for (const [name, text] of [["目标.md", "# 目标\n旧称呼"], ["验收.md", "# 验收\n第二份专属约束：不能重复扣款。"]]) {
    ids.push((await saveKnowledgeMaterial(materialRoot, { name, content_base64: Buffer.from(text).toString("base64") })).id);
  }
  const input = buildRequirementMaterials(materialRoot, ids);
  const repos = [join(dataDir, "repo-a"), join(dataDir, "repo-b")];
  const parent = service.create(input.requirement, { requirementDocumentName: input.document_name,
    requirementSources: input.sources, requirementAssets: input.assets, requirementWarnings: input.warnings,
    repos, requirementAnalysis: true, account: "owner", ticket: "MULTI" });
  const internal = service as any, state = internal.tasks.get(parent.id);
  const revised = parent.requirement.replace("旧称呼", "已批注修订的新称呼");
  internal.applyRequirementContent(state, revised);
  internal.persist(state);
  prepareRequirementReviewWorkspace(parent.workspace, join(parent.workspace, "review"), revised, state.summary.requirement_document);
  assert.equal(readFileSync(join(parent.workspace, "review", "requirement.md"), "utf8"), revised);
  for (const source of input.sources) assert.deepEqual(readFileSync(join(parent.workspace, "review", source.path)), source.content);
  state.cwd = parent.workspace;
  writeStoryArtifacts(join(parent.workspace, ".mae-flow-work", "MULTI"), "MULTI", "# 已确认整体设计\n页面与接口共同遵守不重复扣款约束。", {
    repository_assessments: repos.map((url, i) => ({ name: `仓${i}`, url, outcome: "change_required", reason: "需要实现" })),
    repositories: repos.map((url, i) => ({ id: `unit-${i}`, name: `模块${i}`, url, ticket: `SUB${i}`, responsibility: "实现对应模块", scope: { name: `模块${i}` } })), dependencies: [],
  });
  internal.refreshRequirementGraph(state);
  internal.createRepositoryDeliveries(state);
  const children = service.list().filter(item => item.parent_task_id === parent.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.requirement, revised);
    assert.equal(child.requirement_document?.sources?.length, 2);
    for (const source of input.sources) assert.deepEqual(readFileSync(join(child.workspace, source.path)), source.content);
    materializeRequirementDocument(child.workspace, child.requirement, child.requirement_document, true);
    assert.match(readFileSync(join(child.workspace, ".mae-flow-requirement.md"), "utf8"), /不能重复扣款/);
    const prompt = requirementContext(child.requirement, child.requirement_document);
    assert.match(prompt, /没有主文档/);
    assert.match(prompt, /不得只读第一份/);
  }
  const restored = new TaskService(options); services.push(restored); restored.recover();
  assert.equal(restored.get(parent.id)?.requirement, revised);
  assert.equal(restored.get(children[0].id)?.requirement_document?.sources?.length, 2);
  const childState = (restored as any).tasks.get(children[0].id);
  childState.summary.status = "failed";
  const rerun = await restored.rerunFromStart(children[0].id);
  assert.equal(rerun.requirement, revised);
  for (const source of input.sources) assert.deepEqual(readFileSync(join(rerun.workspace, source.path)), source.content);
});
