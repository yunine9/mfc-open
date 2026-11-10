import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mfcTemp } from "./mfcTmp.ts";
import { TaskService } from "../src/taskService.ts";
import { createTechnologyStack, listTechnologyStacks, updateTechnologyStack } from "../src/technologyStacks.ts";
import { deleteTechnologyStack } from "../src/technologyStackDeletion.ts";
import { resolveRepositoryProfiles, saveRepositoryProfile } from "../src/repositoryProfiles.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";
import { readSkillKnowledgeMetadata, knowledgeMatchesTask, knowledgeMatchesIssueSession } from "../src/knowledgeAssetModel.ts";
import { componentRepositories } from "../src/componentRepositories.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { saveKnowledgeDocument, readKnowledgeDocument, readKnowledgeDocumentVersion } from "../src/knowledgeDocuments.ts";
import { WorkflowAssetLibrary } from "../src/workflowAssetLibrary.ts";

const repository = "https://code.example/team/orders.git";
const stackId = "order-runtime";
function service(dataDir: string) {
  return new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {},
    maxConcurrent: 0, host: { kernelRoot: "/tmp", repoPath: "/tmp/fixed-demo-repo" } });
}
function skill(dataDir: string, name: string, technologies: string[], legacy = false) {
  const path = join(dataDir, "skills", name, "SKILL.md");
  mkdirSync(join(dataDir, "skills", name), { recursive: true });
  writeFileSync(path, ["---", `name: ${name}`, "description: Review order changes",
    ...(legacy ? [] : ["knowledge_nature: engineering"]),
    `${legacy ? "languages" : "technologies"}: [${technologies.join(", ")}]`, "---",
    "", "# Review orders", "BODY-MUST-STAY\n"].join("\n"));
  return path;
}
function definition(technologies: string[]) {
  return { schema: "mae-flow-workflow-definition/1",
    base: { standard_id: "test", standard_version: "1", catalog_digest: `sha256:${"a".repeat(64)}` },
    applicability: { business_module_ids: [], repositories: [], technologies }, edits: [] };
}

test("自定义目录ID贯通画像、预览和交付Skill快照；改名与停用不改写旧单", async () => {
  const dataDir = mfcTemp("mfc-stack-references-");
  createTechnologyStack(dataDir, { id: stackId, name: "订单运行环境" }, "admin");
  createTechnologyStack(dataDir, { id: "billing-runtime", name: "计费运行环境" }, "admin");
  skill(dataDir, "order-review", [stackId, "billing-runtime"]);
  skill(dataDir, "billing-review", ["billing-runtime"]);
  const profile = saveRepositoryProfile(dataDir, { repository, technologies: [stackId] }, "user");
  const tasks = service(dataDir);
  try {
    const preview = tasks.previewLaunchKnowledge({ repositories: [repository] });
    assert.equal(preview.complete, true, JSON.stringify(preview.errors));
    assert.deepEqual(preview.team_skills.map((item) => item.name), ["order-review"], "多选仍表示任一适用");
    assert.deepEqual(preview.scope.technologies, [stackId]);
    updateTechnologyStack(dataDir, stackId, { name: "订单平台技术栈" }, "admin");
    assert.equal(tasks.previewLaunchKnowledge({ repositories: [repository] }).selection_digest,
      preview.selection_digest, "名称不参与关联和清单身份");
    const task = tasks.create("修改订单代码", { repo: repository, repositoryProfiles: [profile],
      requireRepositoryProfiles: true, knowledgePreviewDigest: preview.selection_digest });
    profile.technologies.push("billing-runtime");
    assert.deepEqual(task.repository_profiles?.[0].technologies, [stackId], "任务快照不复用调用方可变数组");
    assert.deepEqual(task.team_skills?.map((item) => item.name), ["order-review"]);
    updateTechnologyStack(dataDir, stackId, { enabled: false }, "admin");
    const unavailable = tasks.previewLaunchKnowledge({ repositories: [repository] });
    assert.equal(unavailable.complete, false);
    assert.match(unavailable.errors[0].message, /已停用/);
    assert.throws(() => tasks.create("新下单不能选停用项", {
      repo: repository, requireRepositoryProfiles: true }), /已停用/);
    assert.deepEqual(resolveRepositoryProfiles(dataDir, [repository])[0].profile?.technologies, [stackId]);
    const workspace = join(dataDir, "delivery-session"); mkdirSync(workspace);
    const loaded = materializeHostSkills({ sourceRoot: join(task.workspace, "host-skill-snapshot"),
      workspaceRoot: workspace, snapshotRoot: join(workspace, "skills"),
      context: { repositories: [repository], technologies: task.repository_profiles![0].technologies, businessModuleIds: [] } });
    assert.deepEqual(loaded.names, ["order-review"], JSON.stringify(loaded.warnings));
  } finally { await tasks.shutdown(); }
});

test("未登记技术栈不能保存、预览或创建新任务，拒绝不会产生任务", async () => {
  const dataDir = mfcTemp("mfc-stack-unknown-");
  const tasks = service(dataDir);
  const profile = { repository, technologies: ["unknown-stack"], confirmed: true, updated_at: "", updated_by: "user" };
  try {
    assert.throws(() => saveRepositoryProfile(dataDir, profile, "user"), /尚未登记/);
    const preview = tasks.previewLaunchKnowledge({ repositories: [repository], repositoryProfiles: [profile] });
    assert.equal(preview.complete, false); assert.match(preview.errors[0].message, /尚未登记/);
    assert.throws(() => tasks.create("无效技术栈", { repo: repository,
      repositoryProfiles: [profile], requireRepositoryProfiles: true }), /尚未登记/);
    const workflowPreview = tasks.previewLaunchKnowledge({ workflowDefinition: definition(["unknown-stack"]) });
    assert.equal(workflowPreview.complete, false);
    assert.equal(workflowPreview.errors[0].source, "workflow");
    assert.throws(() => tasks.create("不能从工作流带回已删除关联", {
      workflowDefinition: definition(["unknown-stack"]) }), /尚未登记/);
    assert.deepEqual(tasks.list(), []);
  } finally { await tasks.shutdown(); }
});

test("删除清理当前所有关联，保留正文及历史任务和发布版本", async () => {
  const dataDir = mfcTemp("mfc-stack-delete-");
  createTechnologyStack(dataDir, { id: stackId, name: "待删除技术栈" }, "admin");
  createTechnologyStack(dataDir, { id: "java", name: "Java" }, "admin");
  saveRepositoryProfile(dataDir, { repository, technologies: [stackId] }, "user");
  saveRepositoryProfile(dataDir, { repository: "https://code.example/mixed.git", technologies: [stackId, "java"] }, "user");
  writeFileSync(join(dataDir, "component-repositories.json"), JSON.stringify([
    { id: "only", name: "Only", languages: [stackId], enabled: true },
    { id: "mixed", name: "Mixed", languages: [stackId, "java"], enabled: true },
  ]));
  const text = "# 知识正文\nBODY-MUST-STAY\n";
  const document = saveKnowledgeDocument(dataDir, { title: "单栈知识", content: text, technologies: [stackId] }, "user");
  const mixedDocument = saveKnowledgeDocument(dataDir, { title: "多栈知识", content: text, technologies: [stackId, "java"] }, "user");
  const onlySkill = skill(dataDir, "only-review", [stackId]);
  const mixedSkill = skill(dataDir, "mixed-review", [stackId, "java"], true);
  const workflows = new WorkflowAssetLibrary(dataDir);
  workflows.create({ id: "order-flow", name: "订单方案", scope: "team", owner: "user", definition: definition([stackId]) });
  workflows.submitForReview("order-flow", { actor: "user" }); workflows.approve("order-flow", { actor: "reviewer" });
  const versionPath = join(dataDir, "workflow-assets", "order-flow", "versions", "v1.json");
  const versionBefore = readFileSync(versionPath, "utf8");
  const tasks = service(dataDir);
  try {
    const task = tasks.create("已有交付任务", { repo: repository, requireRepositoryProfiles: true });
    const snapshotBefore = JSON.stringify(task.repository_profiles);
    deleteTechnologyStack(dataDir, stackId, "admin");
    assert.deepEqual(listTechnologyStacks(dataDir).map((item) => item.id), ["java"]);
    const profile = resolveRepositoryProfiles(dataDir, [repository])[0].profile!;
    assert.deepEqual(profile.technologies, []); assert.equal(profile.confirmed, false);
    assert.equal(tasks.previewLaunchKnowledge({ repositories: [repository] }).complete, false);
    assert.deepEqual(componentRepositories(dataDir).map((item) => [item.languages, item.enabled]), [[[], false], [["java"], true]]);
    const current = readKnowledgeDocument(dataDir, document.id);
    assert.equal(current.content, text); assert.deepEqual(current.technologies, []); assert.equal(current.active, false);
    assert.equal(current.technology_assignment_required, true);
    assert.throws(() => saveKnowledgeDocument(dataDir, { active: true }, "user", document.id), /补充技术栈关联/);
    assert.deepEqual(readKnowledgeDocument(dataDir, mixedDocument.id).technologies, ["java"]);
    assert.equal(readKnowledgeDocument(dataDir, mixedDocument.id).active, true);
    assert.deepEqual(readKnowledgeDocumentVersion(dataDir, document.id, document.revision).document.technologies, [stackId]);
    assert.equal(new KnowledgeSearch(dataDir).read({ repo: "orders", repositories: [repository], moduleIds: [] }, document.id), undefined);
    const cleared = readSkillKnowledgeMetadata(readFileSync(onlySkill, "utf8"));
    assert.equal(cleared.nature, "engineering"); assert.deepEqual(cleared.technologies, []);
    assert.equal(knowledgeMatchesTask(cleared, { repositories: [], technologies: ["java"], businessModuleIds: [] }), false);
    assert.equal(knowledgeMatchesIssueSession(cleared, { repositories: [], businessModuleIds: [] }), false);
    assert.match(readFileSync(onlySkill, "utf8"), /BODY-MUST-STAY/);
    assert.deepEqual(readSkillKnowledgeMetadata(readFileSync(mixedSkill, "utf8")).technologies, ["java"]);
    assert.doesNotMatch(readFileSync(mixedSkill, "utf8"), /^languages:/m);
    const workflow = workflows.get("order-flow");
    assert.deepEqual(workflow.draft.definition.applicability.technologies, []);
    assert.equal(workflow.asset.technology_assignment_required, true);
    assert.equal(workflow.asset.status, "draft"); assert.equal(workflow.asset.selectable_for_tasks, false);
    assert.equal(readFileSync(versionPath, "utf8"), versionBefore);
    assert.throws(() => workflows.copy({ source: { kind: "workflow", id: "order-flow", version: "v1" },
      name: "不能恢复旧关联", scope: "team", owner: "user" }), /尚未登记/);
    assert.throws(() => workflows.saveDraft("order-flow", { definition: definition([stackId]),
      expected_revision: workflow.draft.revision, actor: "user" }), /尚未登记/);
    workflows.submitForReview("order-flow", { actor: "user" });
    assert.throws(() => workflows.approve("order-flow", { actor: "reviewer" }), /补齐技术栈/);
    assert.equal(JSON.stringify(task.repository_profiles), snapshotBefore);
    const workspace = join(dataDir, "old-delivery"); mkdirSync(workspace);
    const loaded = materializeHostSkills({ sourceRoot: join(task.workspace, "host-skill-snapshot"),
      workspaceRoot: workspace, snapshotRoot: join(workspace, "skills"),
      context: { repositories: [repository], technologies: [stackId], businessModuleIds: [] } });
    assert.deepEqual(loaded.names.sort(), ["mixed-review", "only-review"]);
    deleteTechnologyStack(dataDir, stackId, "admin");
    assert.equal(workflows.get("order-flow").draft.revision, workflow.draft.revision);
  } finally { await tasks.shutdown(); }
});

test("先完整读取再清理，坏来源不会冒充删除成功", () => {
  const dataDir = mfcTemp("mfc-stack-delete-read-failure-");
  createTechnologyStack(dataDir, { id: stackId, name: "待删除" }, "admin");
  const componentPath = join(dataDir, "component-repositories.json");
  const before = JSON.stringify([{ id: "component", languages: [stackId], enabled: true }]);
  writeFileSync(componentPath, before);
  mkdirSync(join(dataDir, "repository-profiles")); writeFileSync(join(dataDir, "repository-profiles", "profiles.json"), "{broken");
  assert.throws(() => deleteTechnologyStack(dataDir, stackId, "admin"), /清理未完成.*重试/);
  assert.equal(readFileSync(componentPath, "utf8"), before);
  assert.equal(listTechnologyStacks(dataDir)[0].id, stackId);
});

test("部分写入失败保留目录与恢复依据，修复后同一删除可完成", () => {
  const dataDir = mfcTemp("mfc-stack-delete-write-failure-");
  createTechnologyStack(dataDir, { id: stackId, name: "待删除" }, "admin");
  writeFileSync(join(dataDir, "component-repositories.json"), JSON.stringify([{ id: "component", languages: [stackId], enabled: true }]));
  saveRepositoryProfile(dataDir, { repository, technologies: [stackId] }, "user");
  const blocked = join(dataDir, "repository-profiles", "profiles.json.tmp"); mkdirSync(blocked);
  assert.throws(() => deleteTechnologyStack(dataDir, stackId, "admin"), /清理未完成.*重试/);
  assert.deepEqual(componentRepositories(dataDir)[0].languages, []);
  assert.equal(listTechnologyStacks(dataDir)[0].id, stackId);
  assert.deepEqual(resolveRepositoryProfiles(dataDir, [repository])[0].profile?.technologies, [stackId]);
  assert.match(readFileSync(join(dataDir, "technology-stack-operations.jsonl"), "utf8"), /technology-stack-deletion-backups/);
  rmSync(blocked, { recursive: true }); deleteTechnologyStack(dataDir, stackId, "admin");
  assert.deepEqual(listTechnologyStacks(dataDir), []);
  assert.deepEqual(resolveRepositoryProfiles(dataDir, [repository])[0].profile?.technologies, []);
});
