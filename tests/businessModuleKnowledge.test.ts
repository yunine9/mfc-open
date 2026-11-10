import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule, defaultModuleKnowledgePath, normalizeModuleKnowledgeLocation, normalizeModuleKnowledgePath, readBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { resolveModuleKnowledgeLocation, saveModuleKnowledgeLocation } from "../src/businessModuleKnowledge.ts";
import { readKnowledgeRepoConfig, saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

const moduleId = "module-4a96";
const defaultPath = "Function_Knowledge/Access Function/交易业务";
const location = { repository: "https://git.example/knowledge.git", branch: "main", docs_path: "domains/交易业务" };
function moduleFile(dir: string, id = moduleId) { return join(dir, "business-modules", id, "module.json"); }
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-module-knowledge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createBusinessModule(dir, { id: moduleId, name: "交易业务", description: "交易全流程", owner: "owner", repositories: ["https://git.example/code.git"] }, "owner");
  return dir;
}
function rawModule(dir: string, patch: Record<string, unknown>) {
  const saved = JSON.parse(readFileSync(moduleFile(dir), "utf8"));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete saved[key]; else saved[key] = value;
  }
  writeFileSync(moduleFile(dir), JSON.stringify(saved));
  return readFileSync(moduleFile(dir), "utf8");
}

test("新模块只保存仓内目录，固定默认路径保留空格和大小写，未配置全局仓时不产生有效位置", t => {
  const dir = setup(t), before = readFileSync(moduleFile(dir), "utf8");
  assert.equal(readBusinessModule(dir, moduleId).knowledge_path, defaultPath);
  assert.equal(JSON.parse(before).knowledge_location, undefined);
  assert.equal(resolveModuleKnowledgeLocation(dir, moduleId), undefined);
  assert.equal(readFileSync(moduleFile(dir), "utf8"), before, "读取不能隐式保存配置");
  saveKnowledgeRepoConfig(dir, location.repository);
  assert.deepEqual(resolveModuleKnowledgeLocation(dir, moduleId), { ...location, branch: "master", docs_path: defaultPath });
  assert.equal(readFileSync(moduleFile(dir), "utf8"), before);
  assert.equal(defaultModuleKnowledgePath(" .交易/退款:业务. "), "Function_Knowledge/Access Function/交易-退款-业务");
});

test("模块只固定路径，仓库和分支始终取全局配置；改名不迁目录，已创建任务的快照不变", t => {
  const dir = setup(t);
  saveKnowledgeRepoConfig(dir, location.repository, { branch: location.branch, docs_path: "ignored-global-prefix" });
  const first = readBusinessModule(dir, moduleId);
  saveModuleKnowledgeLocation(dir, moduleId, { knowledge_path: location.docs_path }, "owner", first.revision);
  const snapshot = resolveModuleKnowledgeLocation(dir, moduleId)!;
  updateBusinessModule(dir, moduleId, { name: "交易中心" }, "owner");
  assert.equal(readBusinessModule(dir, moduleId).knowledge_path, location.docs_path);
  saveKnowledgeRepoConfig(dir, "https://git.example/new-global.git", { branch: "release/2026", docs_path: "also-ignored" });
  assert.deepEqual(resolveModuleKnowledgeLocation(dir, moduleId), { repository: "https://git.example/new-global.git", branch: "release/2026", docs_path: location.docs_path });
  saveModuleKnowledgeLocation(dir, moduleId, "domains/交易中心", "owner");
  assert.deepEqual(snapshot, location, "任务已有位置快照不受全局或模块配置更新影响");
  assert.throws(() => saveModuleKnowledgeLocation(dir, moduleId, location.docs_path, "owner", first.revision), /配置已变化/);
});

test("已有模块无目录时只读派生默认路径，首次普通修改保留原模块名目录并持久化", t => {
  const dir = setup(t), before = rawModule(dir, { knowledge_path: undefined, knowledge_location: undefined });
  saveKnowledgeRepoConfig(dir, location.repository, { branch: "main" });
  assert.equal(readBusinessModule(dir, moduleId).knowledge_path, defaultPath);
  assert.deepEqual(resolveModuleKnowledgeLocation(dir, moduleId), { ...location, docs_path: defaultPath });
  assert.equal(readFileSync(moduleFile(dir), "utf8"), before);
  updateBusinessModule(dir, moduleId, { name: "交易中心" }, "owner");
  assert.equal(readBusinessModule(dir, moduleId).knowledge_path, defaultPath);
  assert.equal(JSON.parse(readFileSync(moduleFile(dir), "utf8")).knowledge_path, defaultPath);
});

test("旧 location 记录只兼容原 docs_path，忽略历史仓库和分支且读取不改盘", t => {
  const dir = setup(t), before = rawModule(dir, { knowledge_path: undefined, knowledge_location: { repository: "https://old.example/old.git", branch: "old-branch", docs_path: "legacy/交易" } });
  saveKnowledgeRepoConfig(dir, location.repository, { branch: "main" });
  assert.deepEqual(resolveModuleKnowledgeLocation(dir, moduleId), { ...location, docs_path: "legacy/交易" });
  assert.equal(readBusinessModule(dir, moduleId).knowledge_location, undefined);
  assert.equal(readFileSync(moduleFile(dir), "utf8"), before);
  updateBusinessModule(dir, moduleId, { name: "交易中心" }, "owner");
  const saved = JSON.parse(readFileSync(moduleFile(dir), "utf8"));
  assert.equal(saved.knowledge_path, "legacy/交易"); assert.equal(saved.knowledge_location, undefined);
  rawModule(dir, { knowledge_path: undefined, knowledge_location: { repository: "ignored" } });
  assert.throws(() => readBusinessModule(dir, moduleId), /目录损坏/);
});

test("所有启用模块在同一仓内检查相同或嵌套路径，失败原子保留原配置，停用模块不占目录", t => {
  const dir = setup(t);
  saveKnowledgeRepoConfig(dir, location.repository, { branch: "main" });
  saveModuleKnowledgeLocation(dir, moduleId, location.docs_path, "owner");
  createBusinessModule(dir, { id: "other", name: "另一模块", description: "另一个模块", owner: "owner", repositories: ["https://git.example/code.git"] }, "owner");
  const otherBefore = readFileSync(moduleFile(dir, "other"), "utf8");
  for (const path of [location.docs_path, "DOMAINS/交易业务", "domains", `${location.docs_path}/nested`]) {
    assert.throws(() => saveModuleKnowledgeLocation(dir, "other", path, "owner"), /重叠/);
    assert.equal(readFileSync(moduleFile(dir, "other"), "utf8"), otherBefore);
  }
  updateBusinessModule(dir, moduleId, { status: "archived" }, "owner");
  saveModuleKnowledgeLocation(dir, "other", location.docs_path, "owner");
  assert.equal(readBusinessModule(dir, "other").knowledge_path, location.docs_path);
  assert.throws(() => updateBusinessModule(dir, moduleId, { status: "active" }, "owner"), /重叠/);
});

test("旧客户端不能覆写模块仓库或分支，兼容相同全局位置时也只保存路径", t => {
  const dir = setup(t);
  saveKnowledgeRepoConfig(dir, location.repository, { branch: "main" });
  const before = readFileSync(moduleFile(dir), "utf8");
  for (const wrong of [{ ...location, repository: "https://other.example/knowledge.git" }, { ...location, branch: "foreign" }]) {
    assert.throws(() => updateBusinessModule(dir, moduleId, { knowledge_location: wrong }, "owner"), /平台统一配置/);
    assert.throws(() => saveModuleKnowledgeLocation(dir, moduleId, { location: wrong, knowledge_path: "attempted-bypass" }, "owner"), /平台统一配置/);
    assert.throws(() => createBusinessModule(dir, { id: "bad", name: "坏模块", description: "坏模块", owner: "owner", repositories: ["https://git.example/code.git"], knowledge_location: wrong }, "owner"), /平台统一配置/);
    assert.equal(readFileSync(moduleFile(dir), "utf8"), before);
    assert.deepEqual(readKnowledgeRepoConfig(dir), { url: location.repository, branch: "main" });
  }
  saveModuleKnowledgeLocation(dir, moduleId, { location }, "owner");
  const saved = JSON.parse(readFileSync(moduleFile(dir), "utf8"));
  assert.equal(saved.knowledge_path, location.docs_path); assert.equal(saved.knowledge_location, undefined);
  assert.throws(() => updateBusinessModule(dir, moduleId, { knowledge_location: location, knowledge_path: "different" }, "owner"), /参数不一致/);
});

test("目录与旧位置校验拒绝越界、无效分支和地址中的凭据", () => {
  for (const docs_path of ["", "/absolute", "../parent", "docs/../parent", "C:/docs", "docs\\module", "docs/.git/config", "docs//module"]) {
    assert.throws(() => normalizeModuleKnowledgePath(docs_path), /相对目录/);
    assert.throws(() => normalizeModuleKnowledgeLocation({ ...location, docs_path }), /相对目录/);
  }
  for (const branch of ["", "-main", "../main", "refs//main", ".hidden", "main.lock", "@"]) {
    assert.throws(() => normalizeModuleKnowledgeLocation({ ...location, branch }), /分支格式/);
  }
  assert.throws(() => normalizeModuleKnowledgeLocation({ ...location, repository: "https://user:password@git.example/knowledge.git" }), /凭据/);
  assert.deepEqual(normalizeModuleKnowledgeLocation({ ...location, docs_path: " domains/交易业务/ " }), location);
});
