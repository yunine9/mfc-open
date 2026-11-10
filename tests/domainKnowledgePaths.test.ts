import assert from "node:assert/strict";
import { test } from "node:test";
import { assertModuleKnowledgePath, moduleKnowledgePaths, readableDomainKnowledgeDirectory, repairModuleKnowledgePath, needsModuleKnowledgeLayout, directoryKnowledgeDirectory, directoryKnowledgePath } from "../src/domainKnowledgeLayout.ts";

const target = { id: "repo", old_directory: "docs", new_directory: "docs/orders", collision_group: "shared:main" };
const document = (id: string, path: string, target_id = target.id) => ({ id, path, target_id });

test("Issue489：领域目录替换内部编号段，不重复追加业务名，部分迁移也可恢复", () => {
  const id = "module-5d312e96-7b1f-4a75-b3f4-ab4624a831ce";
  assert.equal(readableDomainKnowledgeDirectory(`docs/${id}/domains`, id, "产品管理"), "docs/产品管理/domains");
  assert.equal(readableDomainKnowledgeDirectory("docs/产品管理", id, "产品管理"), "docs/产品管理");
  assert.equal(readableDomainKnowledgeDirectory(id, id, "产品管理"), "产品管理");
  assert.equal(readableDomainKnowledgeDirectory(id, id, id), "领域知识");
  assert.equal(repairModuleKnowledgePath("domains/产品管理", "domains/产品管理", `domains/${id}/rules.md`), "domains/产品管理/rules.md");
  assert.equal(repairModuleKnowledgePath(".", ".", `docs/knowledge/${id}/FMProductFrontendService/docs/module-map.md`, ["FMProductFrontendService"]), "docs/module-map.md");
  assert.equal(repairModuleKnowledgePath(".", ".", `docs/${id}/docs/${id}/FMProductFrontendService/docs/module-map.md`, ["FMProductFrontendService"]), "docs/module-map.md");
  assert.equal(needsModuleKnowledgeLayout({ module_id: id, knowledge_layout: "module-v1" }), true);
  assert.equal(needsModuleKnowledgeLayout({ module_id: id, knowledge_layout: "repository-v1" }), true);
  assert.equal(needsModuleKnowledgeLayout({ module_id: id, knowledge_layout: "directory-v1" }), false);
  const target = { id: "domain", name: "知识仓", repository: "https://example.test/repo.git", branch: "main", path: "", docs_path: `domains/${id}` };
  assert.equal(needsModuleKnowledgeLayout({ knowledge_layout: "repository-v1", knowledge_target: target }), true, "没有模块关联的旧目录也不能漏掉");
  assert.equal(needsModuleKnowledgeLayout({ component_research_id: "component", knowledge_target: target }), false);
});

test("Issue489：统一最终目录，保留真正的内部子目录且迁移幂等", () => {
  const id = "module-5d312e96-7b1f-4a75-b3f4-ab4624a831ce", directory = "docs/产品管理";
  assert.equal(directoryKnowledgeDirectory(".", "产品管理", id, false), directory);
  assert.equal(directoryKnowledgeDirectory("domain-docs", "产品管理", id, true), directory);
  assert.equal(directoryKnowledgeDirectory(`teams/${id}`, "产品管理", id, true), "teams/产品管理");
  for (const path of ["index.md", "domain-docs/index.md", "docs/index.md"]) assert.equal(directoryKnowledgePath(".", directory, path), `${directory}/index.md`);
  assert.equal(directoryKnowledgePath("domain-docs", directory, "domain-docs/domains/order.md"), `${directory}/domains/order.md`);
  assert.equal(directoryKnowledgePath(`docs/knowledge/${id}`, directory, `docs/knowledge/${id}/domains/order.md`), `${directory}/domains/order.md`);
  assert.equal(directoryKnowledgePath(".", directory, `docs/knowledge/${id}/FMProductFrontendService/docs/module-map.md`, ["FMProductFrontendService"]), `${directory}/module-map.md`);
  assert.equal(directoryKnowledgePath(".", directory, "AGENTS.md"), `${directory}/README.md`);
  assert.equal(directoryKnowledgePath(directory, directory, `${directory}/domains/order.md`), `${directory}/domains/order.md`);
  assert.throws(() => assertModuleKnowledgePath({ knowledge_layout: "directory-v1" }, { docs_path: directory }, "index.md"), /归档目录/);
  assert.throws(() => assertModuleKnowledgePath({ knowledge_layout: "directory-v1" }, { docs_path: directory }, `${directory}/AGENTS.md`), /不生成 AGENTS/);
});

test("批量整理优先保留根入口，README 与嵌套 index 重名时保留全部文稿", () => {
  const documents = [document("z-nav", "AGENTS.md"), document("a-notes", "docs/README.md"),
    document("t-nav", "docs/topic/AGENTS.md"), document("t-index", "docs/topic/index.md")];
  const before = structuredClone(documents), result = moduleKnowledgePaths(documents, [target]);
  assert.deepEqual(Object.fromEntries(result.paths), {
    "a-notes": "docs/orders/README-a-notes.md", "t-index": "docs/orders/topic/index.md",
    "t-nav": "docs/orders/topic/index-t-nav.md", "z-nav": "docs/orders/README.md",
  });
  assert.deepEqual(result.renamed, [
    { id: "a-notes", target_id: "repo", path: "docs/orders/README-a-notes.md", desired_path: "docs/orders/README.md" },
    { id: "t-nav", target_id: "repo", path: "docs/orders/topic/index-t-nav.md", desired_path: "docs/orders/topic/index.md" },
  ]);
  for (const path of result.paths.values()) {
    assertModuleKnowledgePath({ module_id: "orders", knowledge_layout: "module-v1" }, { docs_path: target.new_directory }, path);
    assert.doesNotMatch(path, /(^|\/)agents\.md$/i);
  }
  assert.deepEqual(documents, before, "纯函数不改变原文稿或编号");
});

test("批量整理与输入顺序无关，二次整理不再次追加后缀", () => {
  const documents = [document("root", "agents.md"), document("intro", "docs/README.md"),
    document("nested", "docs/nested/Agents.md"), document("index", "docs/nested/index.md")];
  const first = moduleKnowledgePaths(documents, [target]);
  assert.deepEqual(moduleKnowledgePaths([...documents].reverse(), [target]), first);
  const nextDocuments = documents.map(doc => ({ ...doc, path: first.paths.get(doc.id)! }));
  const second = moduleKnowledgePaths(nextDocuments, [target]);
  assert.deepEqual(second.paths, first.paths);
  assert.deepEqual(second.renamed, []);
});

test("已有后缀位置先保留，冲突文稿按稳定编号继续递增避让", () => {
  const documents = [document("root", "AGENTS.md"), document("intro", "docs/README.md"),
    document("suffix-one", "docs/README-intro.md"), document("suffix-two", "docs/README-intro-2.md")];
  const result = moduleKnowledgePaths(documents, [target]);
  assert.equal(result.paths.get("root"), "docs/orders/README.md");
  assert.equal(result.paths.get("intro"), "docs/orders/README-intro-3.md");
  assert.equal(result.paths.get("suffix-one"), "docs/orders/README-intro.md");
  assert.equal(result.paths.get("suffix-two"), "docs/orders/README-intro-2.md");
  assert.deepEqual(moduleKnowledgePaths([...documents].reverse(), [target]), result);
});

test("普通重名优先保留已就位的文稿，人工指定路径也参与完整避让", () => {
  const documents = [document("a-move", "docs/topic.md"), document("z-keep", "docs/orders/topic.md"),
    { ...document("root", "AGENTS.md"), desired_path: "docs/orders/README.md" },
    { ...document("notes", "docs/README.md"), desired_path: "docs/orders/custom/notes.md" }];
  const result = moduleKnowledgePaths(documents, [target]);
  assert.equal(result.paths.get("z-keep"), "docs/orders/topic.md");
  assert.equal(result.paths.get("a-move"), "docs/orders/topic-a-move.md");
  assert.equal(result.paths.get("root"), "docs/orders/README.md");
  assert.equal(result.paths.get("notes"), "docs/orders/custom/notes.md");
  assert.deepEqual(result.renamed.map(doc => doc.id), ["a-move"]);
});

test("同仓同分支的逻辑目标统一避让，不同仓或分支可以保留相同文件名", () => {
  const targets = [target, { ...target, id: "domain", old_directory: "domain-docs" },
    { ...target, id: "release", collision_group: "shared:release" },
    { ...target, id: "other", collision_group: "other:main" }];
  const documents = [document("repo-root", "AGENTS.md"), document("domain-root", "AGENTS.md", "domain"),
    document("release-root", "AGENTS.md", "release"), document("other-root", "AGENTS.md", "other")];
  const result = moduleKnowledgePaths(documents, targets);
  assert.equal(result.paths.get("domain-root"), "docs/orders/README.md");
  assert.equal(result.paths.get("repo-root"), "docs/orders/README-repo-root.md");
  assert.equal(result.paths.get("release-root"), "docs/orders/README.md");
  assert.equal(result.paths.get("other-root"), "docs/orders/README.md");
  assert.deepEqual(moduleKnowledgePaths([...documents].reverse(), [...targets].reverse()), result);
});

test("其他正式知识的路径优先保留，根入口和已有后缀都自动避让", () => {
  const occupied = ["docs/orders/README.md", "docs/orders/README-root.md", "docs/orders/README-root-2.md"]
    .map(path => ({ collision_group: target.collision_group, path }));
  const documents = [document("root", "AGENTS.md"), document("notes", "docs/README.md")];
  const result = moduleKnowledgePaths(documents, [target], occupied);
  assert.equal(result.paths.get("root"), "docs/orders/README-root-3.md");
  assert.equal(result.paths.get("notes"), "docs/orders/README-notes.md");
  assert.deepEqual(result.renamed.map(doc => doc.id), ["notes", "root"]);
  assert.deepEqual(moduleKnowledgePaths([...documents].reverse(), [target], [...occupied].reverse()), result);
  const repeated = moduleKnowledgePaths(documents.map(doc => ({ ...doc, path: result.paths.get(doc.id)! })), [target], occupied);
  assert.deepEqual(repeated.paths, result.paths);
  assert.deepEqual(repeated.renamed, []);
  for (const path of result.paths.values()) assert.ok(!occupied.some(location => location.path === path));
});

test("外部占用范围按仓和分支隔离，同名文稿不用跨范围改名", () => {
  const occupied = [{ collision_group: "other:main", path: "docs/orders/README.md" },
    { collision_group: "shared:release", path: "docs/orders/README.md" }];
  const result = moduleKnowledgePaths([document("root", "AGENTS.md")], [target], occupied);
  assert.equal(result.paths.get("root"), "docs/orders/README.md");
  assert.deepEqual(result.renamed, []);
});

test("同任务另一篇已发布的正式位置不让给新根入口，只允许原文稿复用", () => {
  const documents = [document("root", "AGENTS.md"), document("keeper", "docs/orders/README.md")];
  const occupied = [{ collision_group: target.collision_group, path: "docs/orders/README.md", document_id: "keeper" }];
  const result = moduleKnowledgePaths(documents, [target], occupied);
  assert.equal(result.paths.get("root"), "docs/orders/README-root.md");
  assert.equal(result.paths.get("keeper"), "docs/orders/README.md");
  assert.deepEqual(result.renamed.map(doc => doc.id), ["root"]);
  assert.deepEqual(moduleKnowledgePaths([...documents].reverse(), [target], occupied), result);
});

test("自动避让可复用本篇自己的后缀位置，多重占用仍保护其他知识", () => {
  const occupied = [{ collision_group: target.collision_group, path: "docs/orders/README.md" },
    { collision_group: target.collision_group, path: "docs/orders/README-root.md", document_id: "root" }];
  const result = moduleKnowledgePaths([document("root", "AGENTS.md")], [target], occupied);
  assert.equal(result.paths.get("root"), "docs/orders/README-root.md");
  const contested = [...occupied, { collision_group: target.collision_group, path: "docs/orders/README-root.md", document_id: "other" }];
  assert.equal(moduleKnowledgePaths([document("root", "AGENTS.md")], [target], contested).paths.get("root"), "docs/orders/README-root-2.md");
});

test("仅大小写不同的文件名和已有后缀也避让，保留实际路径大小写", () => {
  const documents = [document("root", "AGENTS.md"), document("notes", "docs/readme.md")];
  const occupied = [{ collision_group: target.collision_group, path: "docs/orders/README-NOTES.md" }];
  const result = moduleKnowledgePaths(documents, [target], occupied);
  assert.equal(result.paths.get("root"), "docs/orders/README.md");
  assert.equal(result.paths.get("notes"), "docs/orders/readme-notes-2.md");
  const owned = [{ collision_group: target.collision_group, path: "docs/orders/readme.md", document_id: "notes" }];
  const retained = moduleKnowledgePaths(documents, [target], owned);
  assert.equal(retained.paths.get("root"), "docs/orders/README-root.md");
  assert.equal(retained.paths.get("notes"), "docs/orders/readme.md");
});

test("文稿映射保留子目录，并拒绝目录穿越及不存在的目标", () => {
  const result = moduleKnowledgePaths([document("extra", "guide/nested/rules.md")], [target]);
  assert.equal(result.paths.get("extra"), "docs/orders/guide/nested/rules.md");
  assert.throws(() => moduleKnowledgePaths([document("escape", "../other/rules.md")], [target]), /归档目录内的 Markdown/);
  assert.throws(() => moduleKnowledgePaths([document("unknown", "AGENTS.md", "unknown")], [target]), /归档目标不存在/);
  assert.throws(() => moduleKnowledgePaths([document("same", "docs/one.md"), document("same", "docs/two.md")], [target]), /编号不能重复/);
});
