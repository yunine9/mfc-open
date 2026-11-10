import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule, migrateBusinessModule, listBusinessModules, publishBusinessKnowledgeAsset,
  readBusinessKnowledgeAsset, updateBusinessModule, archiveBusinessKnowledgeAsset, readBusinessModule } from "../src/businessModuleLibrary.ts";
import { businessModuleMigrations, resolveBusinessModuleId } from "../src/businessModuleIdentity.ts";
import { prepareKnowledgeDocument, writePreparedKnowledgeDocument, readKnowledgeDocument, listKnowledgeDocumentVersions, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { readDtsModuleBindings, setDtsModuleBinding } from "../src/dtsModuleBindings.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";
import { listHostSkillShelf } from "../src/hostSkillShelf.ts";
import { MemoryStore } from "../src/taskMemory.ts";
import { TaskService } from "../src/taskService.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import type { AddressInfo } from "node:net";
import { selectBusinessModules } from "../src/businessModuleRuntime.ts";
import { resolveWorkflowAssets } from "../src/workflowAssetResolution.ts";

const repo = "https://example.test/old.git";
const settings = { provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };
function removeFixture(dir: string) {
  const writable = (path: string) => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) writable(join(path, entry.name));
  };
  writable(dir); rmSync(dir, { recursive: true, force: true });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mfc-module-migration-"));
  for (const id of ["old", "new", "third"]) createBusinessModule(dir, { id, name: `${id}模块`, description: `${id}说明`,
    owner: "expert", repositories: [id === "old" ? repo : `https://example.test/${id}.git`], mr_participants: { reviewers: [`${id}-reviewer`] } }, "expert");
  return dir;
}
const asset = { id: "rules", title: "规则", summary: "摘要", when_to_use: "开发时", content: "# 旧规则一" };
const manual = { title: "领域文档", content: "# 已经完成的成果", scope: "module", module_ids: ["old", "new"],
  archive_target: { repository: repo, branch: "main", path: "docs/old/rules.md" } };
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("等待状态超时");
}

test("整体迁移合并同名资产、历史版本和单号绑定，保留目标配置；链式迁移与重试不重复", () => {
  const dir = fixture();
  try {
    publishBusinessKnowledgeAsset(dir, "old", asset, "expert");
    publishBusinessKnowledgeAsset(dir, "old", { ...asset, content: "# 旧规则二" }, "expert");
    publishBusinessKnowledgeAsset(dir, "new", { ...asset, content: "# 目标模块原有规则" }, "expert");
    setDtsModuleBinding(dir, "DTS-123", "old", "expert");
    const mem = new MemoryStore(dir).record({ trigger: "旧模块经验", conclusion: "保留内容", module: "old", task: "task-1", repo, scope: "general", source: "user_note", judged_by: "human", paths: [], evidence: "manual" });
    const doc = saveKnowledgeDocument(dir, manual, "expert");
    const before = readFileSync(join(dir, "knowledge-documents", `${doc.id}.json`));
    const targetBefore = readBusinessModule(dir, "new");
    const target = migrateBusinessModule(dir, "old", "new", "expert");
    assert.deepEqual(listBusinessModules(dir).modules.map(m => m.id).sort(), ["new", "third"]);
    assert.deepEqual(target.repositories, targetBefore.repositories);
    assert.deepEqual(target.mr_participants, targetBefore.mr_participants);
    assert.equal(target.description, targetBefore.description);
    assert.equal(target.assets.length, 2);
    const imported = target.assets.find(a => a.id !== "rules")!;
    assert.equal(readBusinessKnowledgeAsset(dir, "new", "rules").content, "# 目标模块原有规则");
    assert.equal(readBusinessKnowledgeAsset(dir, "new", imported.id, 1).content, asset.content);
    assert.equal(readBusinessKnowledgeAsset(dir, "old", "rules", 2).content, "# 旧规则二", "旧链接仍可读取同一资产");
    assert.deepEqual(readKnowledgeDocument(dir, doc.id).module_ids, ["new"]);
    assert.equal(readKnowledgeDocument(dir, doc.id).revision, doc.revision);
    assert.deepEqual(readKnowledgeDocument(dir, doc.id).archive_target, manual.archive_target);
    assert.deepEqual(readFileSync(join(dir, "knowledge-documents", `${doc.id}.json`)), before, "迁移不重写正式内容或版本");
    assert.equal(readDtsModuleBindings(dir)["DTS-123"].module_id, "new");
    assert.equal(new MemoryStore(dir).list().find(row => row.id === mem.id)?.module, "new");
    // 模块绑定文档按 13ff28b7 语义是任务草稿(withoutBoundModuleDrafts),
    // 不进统一检索面;迁移后的模块归属由上方 module_ids 断言钉住。
    assert.equal(migrateBusinessModule(dir, "old", "new", "expert").assets.length, 2);
    assert.equal(businessModuleMigrations(dir).length, 1);
    publishBusinessKnowledgeAsset(dir, "new", { ...asset, id: imported.id, content: "# 迁移后修订" }, "expert");
    assert.equal(readBusinessKnowledgeAsset(dir, "new", imported.id).asset.version, 3);
    assert.equal(readBusinessKnowledgeAsset(dir, "new", imported.id, 1).content, asset.content);
    updateBusinessModule(dir, "new", { description: "新的配置说明" }, "expert");
    assert.equal(readBusinessModule(dir, "new").assets.length, 2, "编辑配置不能复制迁入资产");
    migrateBusinessModule(dir, "new", "third", "expert");
    assert.equal(resolveBusinessModuleId(dir, "old"), "third");
    assert.deepEqual(readKnowledgeDocument(dir, doc.id).module_ids, ["third"]);
    assert.equal(readBusinessModule(dir, "third").assets.length, 2);
    assert.equal(readBusinessKnowledgeAsset(dir, "third", imported.id).content, "# 迁移后修订");
    archiveBusinessKnowledgeAsset(dir, "third", imported.id, "expert");
    assert.equal(readBusinessModule(dir, "third").assets.find(a => a.id === imported.id)?.status, "archived");
    assert.throws(() => migrateBusinessModule(dir, "third", "old", "expert"), /已迁移/);
    assert.throws(() => updateBusinessModule(dir, "old", { status: "active" }, "expert"), /已迁移/);
    assert.throws(() => createBusinessModule(dir, { id: "old", name: "重建", description: "重建", owner: "expert", repositories: [repo] }, "expert"), /已存在/);
  } finally { removeFixture(dir); }
});

test("预检失败不切换任何归属；迁移期间已准备的发布仍可提交原精确版本", () => {
  const dir = fixture();
  try {
    const pending = prepareKnowledgeDocument(dir, manual, "expert");
    assert.throws(() => migrateBusinessModule(dir, "old", "old", "expert"), /另一个/);
    updateBusinessModule(dir, "new", { status: "archived" }, "expert");
    assert.throws(() => migrateBusinessModule(dir, "old", "new", "expert"), /正常使用/);
    assert.equal(businessModuleMigrations(dir).length, 0);
    updateBusinessModule(dir, "new", { status: "active" }, "expert");
    migrateBusinessModule(dir, "old", "new", "expert");
    const result = writePreparedKnowledgeDocument(dir, pending);
    assert.equal(result.revision, pending.document.revision);
    assert.deepEqual(readKnowledgeDocument(dir, result.id).module_ids, ["new"]);
    saveKnowledgeDocument(dir, { content: "# 继续完善的成果" }, "expert", result.id, { expectedRevision: result.revision });
    assert.equal(listKnowledgeDocumentVersions(dir, result.id).length, 2);
  } finally { removeFixture(dir); }
});

test("运行中的萃取迁移后原轮次继续保存，重启后归属、正文、资料和归档路径保留", async () => {
  const dir = fixture(); let release = () => {}, started = false, runs = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    runs++; started = true;
    const document = { id: "rule", title: "规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain" as const, content: "# 已有成果", sources: "源码依据" };
    input.save(document);
    await new Promise<void>(resolve => release = resolve);
    input.save({ ...document, content: "# 接着保存的成果" });
    return "完成";
  });
  let restored: DomainKnowledgeExtraction | undefined;
  try {
    const job = service.create({ module_id: "old", issue_no: "REQ-123" }, "expert");
    await until(() => started && service.get(job.id).documents.length === 1);
    const before = service.get(job.id);
    migrateBusinessModule(dir, "old", "new", "expert");
    assert.equal(service.get(job.id).module_id, "new");
    assert.equal(service.get(job.id).module_name, "new模块");
    assert.equal(service.taskRows()[0].module_id, "new");
    assert.equal(service.list()[0].module_id, "new");
    release(); await until(() => service.get(job.id).status === "done");
    const after = service.get(job.id);
    assert.equal(runs, 1); assert.equal(after.turns[0].id, before.turns[0].id);
    assert.equal(after.documents[0].content, "# 接着保存的成果");
    assert.equal(after.documents[0].path, before.documents[0].path);
    assert.deepEqual(after.knowledge_target, before.knowledge_target);
    assert.deepEqual(after.repositories, before.repositories);
    assert.deepEqual(after.material_ids, before.material_ids);
    // 13ff28b7 起领域任务无「先发布」一步(publish 已成指路墓碑),
    // 迁移后的模块归属由上方 readKnowledgeDocument 断言覆盖。
    await service.shutdown();
    restored = new DomainKnowledgeExtraction(dir, async () => { assert.fail("完成任务不能重跑"); });
    assert.equal(restored.get(job.id).module_id, "new");
    assert.equal(restored.get(job.id).documents[0].content, after.documents[0].content);
  } finally { release(); await service.shutdown(); await restored?.shutdown(); removeFixture(dir); }
});

test("迁移 API 校验登录，需求、问题、交付分析和单号绑定同步归入目标模块", async () => {
  const dir = fixture();
  const tasks = new TaskService({ dataDir: dir, ...settings });
  const issueOptions = { dataDir: dir, ...settings, dts: new MockDtsGateway(), deferRecovery: true, maxConcurrentTurns: 0 };
  const issues = new IssueFlowService(issueOptions);
  const auth = new LocalAuth(join(dir, "auth.json")); auth.bootstrapAdmin("admin", "admin-password"); auth.createUser("expert", "expert-password", "developer");
  const server = createTaskServer(tasks, { auth, issueFlow: issues });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = tasks.create("迁移需求", { businessModuleId: "old" });
    const issue = issues.create({ account: "expert", title: "迁移问题", ticket: "DTS-123", moduleId: "old" });
    setDtsModuleBinding(dir, "DTS-123", "old", "expert");
    const url = `${base}/business-modules/old/migration`;
    assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ target_id: "new" }) })).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "expert", password: "expert-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const preview = await fetch(url, { headers: { cookie } });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { documents: 0, extraction_tasks: 0, delivery_tasks: 1, issue_sessions: 1 });
    const moved = await fetch(url, { method: "POST", headers: { cookie }, body: JSON.stringify({ target_id: "new" }) });
    assert.equal(moved.status, 200, await moved.text());
    const staleEdit = await fetch(`${base}/business-modules/old`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ name: "旧窗口的配置" }) });
    assert.equal(staleEdit.status, 400);
    assert.equal(readBusinessModule(dir, "new").name, "new模块");
    assert.equal(tasks.get(task.id)?.business_module?.id, "new");
    assert.equal(tasks.list().find(row => row.id === task.id)?.business_module?.name, "new模块");
    assert.equal(tasks.deliveryAnalysis().rows.find(row => row.id === task.id)?.business_module?.id, "new");
    assert.equal(issues.get(issue.id).module_id, "new"); assert.equal(issues.get(issue.id).module, "new模块");
    assert.equal(issues.list()[0].module_id, "new");
    const recoveredTasks = new TaskService({ dataDir: dir, ...settings }); recoveredTasks.recover();
    assert.equal(recoveredTasks.get(task.id)?.business_module?.id, "new"); await recoveredTasks.shutdown();
    const restored = new IssueFlowService(issueOptions); restored.start();
    assert.equal(restored.get(issue.id).module_id, "new"); await restored.shutdown();
    assert.equal(readDtsModuleBindings(dir)["DTS-123"].module_id, "new");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await tasks.shutdown(); await issues.shutdown(); removeFixture(dir); }
});

test("旧知识引用、工作流固定资产与业务 Skill 在迁移后仍可消费，包内容不变", () => {
  const dir = fixture(), workspace = join(dir, "test-workspace"); mkdirSync(workspace);
  try {
    const module = publishBusinessKnowledgeAsset(dir, "old", asset, "expert");
    const original = module.assets[0];
    const ref = { registry: "business_knowledge", business_module_id: "old", id: original.id, version: String(original.version), digest: `sha256:${original.digest}` };
    const definition = { schema: "mae-flow-workflow-definition/1", base: { standard_id: "std", standard_version: "1", catalog_digest: `sha256:${"a".repeat(64)}` },
      applicability: { business_module_ids: ["old"], repositories: [], technologies: [] },
      edits: [{ edit_id: "asset-1", stage_id: "stage", op: "add", item: { id: "item-1", kind: "knowledge", title: "规则", locked: false, editable: true, source: "workflow", asset_ref: ref } }] };
    const skill = join(dir, "skills", "module-rules", "SKILL.md"); mkdirSync(join(dir, "skills", "module-rules"), { recursive: true });
    const text = "---\nname: module-rules\ndescription: Module rules\nknowledge_nature: business\nbusiness_modules: [old]\n---\n\n# 业务规则\n保留原包。\n";
    writeFileSync(skill, text);
    const pinned = selectBusinessModules({ dataDir: dir, moduleIds: ["old"] });
    migrateBusinessModule(dir, "old", "new", "expert");
    const selected = selectBusinessModules({ dataDir: dir, moduleIds: ["old", "new"] });
    assert.equal(selected.length, 1);
    for (const businessModules of [pinned, selected]) {
      const result = resolveWorkflowAssets({ definition, dataDir: dir, businessModules, repositories: [], technologies: [] });
      assert.equal(result.length, 1); assert.equal(result[0].state, "available", result[0].diagnostic);
      assert.equal(result[0].business_module_id, "old", "固定工作流的引用身份保留，正文位置解析到现有快照");
    }
    // 模块资产已退出统一检索面(业务正文统一从正式 Git 快照读取);固定
    // 引用身份的保留由旧模块键直读资产钉住(与工作流解析同一语义)。
    assert.equal(readBusinessKnowledgeAsset(dir, "old", "rules").content, asset.content);
    assert.deepEqual(listHostSkillShelf(dir).skills[0].business_module_ids, ["new"]);
    const loaded = materializeHostSkills({ moduleDataDir: dir, sourceRoot: join(dir, "skills"), workspaceRoot: workspace, snapshotRoot: join(workspace, "snapshot"),
      context: { repositories: [], technologies: [], businessModuleIds: ["new"] } });
    assert.deepEqual(loaded.names, ["module-rules"], loaded.warnings.join("; "));
    assert.equal(readFileSync(skill, "utf8"), text);
  } finally { removeFixture(dir); }
});

test("迁移记录无法落盘时，原模块、目标模块和正式知识均保持原状", () => {
  const dir = fixture();
  try {
    const document = saveKnowledgeDocument(dir, { ...manual, module_ids: ["old"] }, "expert");
    mkdirSync(join(dir, "business-module-migrations.json.tmp"));
    assert.throws(() => migrateBusinessModule(dir, "old", "new", "expert"));
    assert.equal(listBusinessModules(dir).modules.length, 3);
    assert.deepEqual(readKnowledgeDocument(dir, document.id).module_ids, ["old"]);
    assert.equal(businessModuleMigrations(dir).length, 0);
    rmSync(join(dir, "business-module-migrations.json.tmp"), { recursive: true });
    migrateBusinessModule(dir, "old", "new", "expert");
    assert.deepEqual(readKnowledgeDocument(dir, document.id).module_ids, ["new"]);
  } finally { removeFixture(dir); }
});
