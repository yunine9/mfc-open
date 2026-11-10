import assert from "node:assert/strict";
import { test } from "node:test";
import { projectKnowledgeModules, knowledgeFileName, knowledgeFilePath, compareKnowledgeModules } from "../web/src/knowledgeModules.ts";
import type { KnowledgeDocument } from "../web/src/knowledgeDocumentsApi.ts";
import type { BusinessModule, HostSkillShelfEntry } from "../web/src/api.ts";
import type { ComponentRepository } from "../web/src/componentResearchApi.ts";

const now = Date.parse("2026-09-30T00:00:00Z");
const document = (id: string, patch: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({ id, title: id, scope: "platform", form: "document", module_ids: [], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true, revision: "r1", history: [], ...patch });
const module = (id: string, patch: Partial<BusinessModule> = {}): BusinessModule => ({ id, name: id, description: "", repositories: [`https://git.example/${id}.git`], owner: "a", maintainers: [], status: "active", revision: 1, assets: [], created_at: "2020-01-01", created_by: "a", updated_at: "2026-09-30", updated_by: "a", can_manage: true, ...patch });
const component: ComponentRepository = { id: "timer", name: "定时器", repository: "https://git.example/timer.git", branch: "main", path: "", languages: ["cpp"], description: "", enabled: true };

test("模块资产从稳定 focus 和资产目录恢复归属，不依赖中文名称", () => {
  const result = projectKnowledgeModules({ now, documents: [document("module:alarm:a", { focus: { kind: "business", moduleId: "alarm", assetId: "a", version: 1, digest: "digest" } })], businessModules: [module("alarm", { assets: [{ id: "a", title: "规则", form: "document", repositories: [], summary: "", when_to_use: "", version: 1, status: "published", digest: "digest", bytes: 20, updated_at: "2026-09-25", updated_by: "a" }] })], components: [] });
  const alarm = result.modules.find(m => m.key === "business:alarm")!;
  assert.equal(alarm.documents.length, 1);
  assert.equal(alarm.maintainedAt, "2026-09-25");
  assert.equal(alarm.recentlyMaintained, 1);
});

test("归档来源仓不能被误当业务适用仓，未归属知识仍可找到", () => {
  const result = projectKnowledgeModules({ documents: [document("kd-1", { source: { repository: "https://git.example/alarm.git", branch: "main", path: "docs/rule.md", revision: "sha" } })], businessModules: [module("alarm")], components: [] });
  assert.equal(result.modules.find(m => m.key === "business:alarm")!.documents.length, 0);
  assert.equal(result.modules.find(m => m.key === "unassigned")!.documents[0].id, "kd-1");
  assert.equal(knowledgeFileName(result.documents[0]), "rule.md");
  assert.equal(knowledgeFilePath(result.documents[0]), "docs/rule.md");
});

test("跨模块知识按明确适用模块出现，各目录按资产ID去重", () => {
  const doc = document("shared", { module_ids: ["alarm", "upgrade"], technologies: ["cpp"] });
  const result = projectKnowledgeModules({ documents: [doc, doc], businessModules: [module("alarm"), module("upgrade")], components: [] });
  assert.deepEqual(result.modules.filter(m => m.id !== "agnostic").map(m => [m.key, m.documentCount]), [["business:alarm", 1], ["business:upgrade", 1]]);
});

test("显式适用仓归入业务仓，组件知识直接列出而不按基础仓分组", () => {
  const result = projectKnowledgeModules({ documents: [document("repo", { repositories: ["https://git.example/alarm/"] }), document("timer-doc", { technologies: ["cpp"], repositories: [component.repository] }), document("general-cpp", { technologies: ["cpp"] })], businessModules: [module("alarm")], components: [component] });
  assert.equal(result.modules.find(m => m.key === "business:alarm")!.repositories[0].documents[0].id, "repo");
  const cpp = result.modules.find(m => m.key === "engineering:cpp")!;
  assert.deepEqual(cpp.repositories, []);
  assert.deepEqual(cpp.documents.map(doc => doc.id), ["timer-doc", "general-cpp"]);
});

test("Skill 归属从货架补齐，内部萃取Skill不进入模块且文件mtime不冒充维护记录", () => {
  const skill: HostSkillShelfEntry = { name: "告警检查", description: "", nature: "business", form: "skill", business_module_ids: ["alarm"], repositories: [], technologies: [], digest: "s1", updated_at: "2026-09-30", path: "alarm-check/SKILL.md", bytes: 30, loadable: true };
  const result = projectKnowledgeModules({ now, documents: [document("skill:alarm-check/SKILL.md", { form: "skill", focus: { kind: "skill", directory: "alarm-check", digest: "s1", packageDigest: "p1" } }), document("platform-skill-component", { form: "skill" })], businessModules: [module("alarm")], components: [], skills: [skill], skillOperations: [{ at: "2026-09-30", operator: "a", action: "reject", directory: "alarm-check" }] });
  const alarm = result.modules[0];
  assert.equal(alarm.skillCount, 1);
  assert.equal(alarm.documents[0].skillDirectory, "alarm-check");
  assert.equal(alarm.maintainedAt, undefined);
  assert.equal(result.documents.length, 1);
});

test("停用知识保留可读，未知时间不推断陈旧或近期维护", () => {
  const result = projectKnowledgeModules({ now, documents: [document("offline", { module_ids: ["alarm"], active: false }), document("active", { module_ids: ["alarm"], history: [{ at: "bad date", operator: "a", action: "edit" }] })], businessModules: [module("alarm")], components: [] });
  const alarm = result.modules[0];
  assert.equal(alarm.documents.length, 2);
  assert.equal(alarm.documentCount, 1);
  assert.equal(alarm.inactiveCount, 1);
  assert.equal(alarm.maintainedAt, undefined);
  assert.equal(alarm.recentlyMaintained, 0);
});

test("已归档或已删除模块的旧知识不会被误分到工程语言", () => {
  const result = projectKnowledgeModules({ documents: [document("old", { module_ids: ["old"], technologies: ["cpp"] })], businessModules: [module("old", { status: "archived" })], components: [] });
  assert.equal(result.modules.filter(m => m.id !== "agnostic").length, 1);
  assert.equal(result.modules.find(m => m.id !== "agnostic")!.key, "unassigned");
});

test("同一基础仓的组件按各自名称逐项保留；来源配置不产生额外目录或重复文稿", () => {
  const idle: ComponentRepository = { ...component, id: "rpc", name: "RPC 框架", repository: "https://git.example/rpc.git" };
  const source = { job_id: "cr-1", repository: component.repository, branch: "main", path: "", components: [{ id: "timer" }, { id: "rpc" }] };
  const timer = document("timer-doc", { title: "定时器", technologies: ["cpp"], research_source: source });
  const rpc = document("rpc-doc", { title: "RPC 框架", technologies: ["cpp"], research_source: source });
  const result = projectKnowledgeModules({ documents: [timer, rpc, timer],
    businessModules: [], components: [component, idle] });
  const cpp = result.modules.find(m => m.key === "engineering:cpp")!;
  assert.deepEqual(cpp.repositories, []);
  assert.deepEqual(cpp.documents.map(doc => [doc.id, doc.title]), [["timer-doc", "定时器"], ["rpc-doc", "RPC 框架"]]);
  assert.equal(cpp.documentCount, 2);
});

test("组件研究来源里的源码目录不当知识文件名：只发布在平台的组件知识按标题显示", () => {
  const doc = document("kd-guide", { title: "FileIO 使用指引", research_source: { job_id: "cr-1", repository: component.repository, branch: "main", path: "src", components: [{ id: "timer" }] } });
  assert.equal(knowledgeFileName(doc), "FileIO 使用指引");
  assert.equal(knowledgeFileName(document("kd-domain", { research_source: { job_id: "dkx-1", repository: "https://git.example/alarm.git", branch: "main", path: "docs/rule.md" } })), "rule.md", "领域研究的来源路径就是文稿路径");
  assert.equal(knowledgeFileName({ ...doc, source: { repository: "https://git.example/kb.git", branch: "main", path: "docs/fileio.md", revision: "sha" } }), "fileio.md", "归档后按归档文件名");
});


test("工程目录使用配置名称，改名不改变引用，删除后的知识仍在待整理可读", () => {
  const documents = [document("custom-guide", { technologies: ["framework-x"] })];
  const input = { documents, businessModules: [], components: [] };
  const before = projectKnowledgeModules({ ...input, technologyStacks: [{ id: "framework-x", name: "团队框架", enabled: true }] });
  const after = projectKnowledgeModules({ ...input, technologyStacks: [{ id: "framework-x", name: "团队新框架", enabled: false }] });
  assert.equal(before.modules.find(m => m.id === "framework-x")!.name, "团队框架");
  assert.equal(after.modules.find(m => m.id === "framework-x")!.name, "团队新框架");
  assert.equal(after.modules.find(m => m.id === "framework-x")!.key, before.modules.find(m => m.id === "framework-x")!.key);
  const removed = projectKnowledgeModules({ ...input, documents: [document("custom-guide", { technologies: [], active: false })], technologyStacks: [] });
  assert.equal(removed.modules.find(m => m.key === "unassigned")!.key, "unassigned");
  assert.equal(removed.modules.find(m => m.key === "unassigned")!.documents[0].id, "custom-guide");
  assert.equal(removed.modules.find(m => m.key === "unassigned")!.inactiveCount, 1);
});

test("正式目录只统计正式文档，模块保留长期领域目录绑定", () => {
  const location = { repository: "https://git.example/knowledge.git", branch: "main", docs_path: "docs/告警" };
  const result = projectKnowledgeModules({ documents: [document("formal", { module_ids: ["alarm"] })], businessModules: [module("alarm", { knowledge_location: location })], components: [] });
  assert.equal(result.modules[0].documentCount, 1);
  assert.deepEqual(result.modules[0].knowledgeLocation, location);
  assert.equal(result.documents.length, 1, "过程文稿和萃取任务不加入正式知识清单");
});

test("正式目录按维护时间与名称排序，不存在已归档或建设中分档", () => {
  const data = projectKnowledgeModules({ now, documents: [document("recent", { module_ids: ["告警"], history: [{ at: "2026-09-29", operator: "a", action: "同步" }] })], businessModules: [module("交易"), module("告警"), module("支付")], components: [] });
  assert.deepEqual(data.modules.filter(m => m.id !== "agnostic").sort(compareKnowledgeModules).map(module => module.id), ["告警", "交易", "支付"]);
});


test("工程下始终保留通用入口；通用 Skill 正式入库后按此归类", () => {
  const empty = projectKnowledgeModules({ documents: [], businessModules: [], components: [] });
  assert.equal(empty.modules[0].key, "engineering:agnostic");
  assert.equal(empty.modules[0].name, "通用");
  const skill: HostSkillShelfEntry = { name: "通用排障", description: "问题处理流程", nature: "engineering", form: "skill", business_module_ids: [], repositories: [], technologies: ["agnostic"], digest: "s1", updated_at: "2026-09-30", path: "general-triage/SKILL.md", bytes: 30, loadable: true };
  const data = projectKnowledgeModules({ documents: [], businessModules: [], components: [], skills: [skill] });
  assert.equal(data.modules[0].skillCount, 1);
  assert.equal(data.modules[0].documents[0].skillDirectory, "general-triage");
});
