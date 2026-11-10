import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBusinessModule, readBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { moduleIncludesRepositoryKnowledge, normalizeRepositoryKnowledgeExclusions } from "../src/businessModuleKnowledgeScope.ts";

const repository = "https://git.example/shared.git";
test("目录筛选按模块持久保存，路径按段匹配，恢复不修改仓库绑定或领域目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "module-knowledge-scope-"));
  try {
    for (const id of ["orders", "stock"]) createBusinessModule(dir, {
      id, name: id, description: id, owner: "owner", repositories: [repository],
    }, "owner");
    const original = readBusinessModule(dir, "orders");
    updateBusinessModule(dir, "orders", { repository_knowledge_exclusions: [
      { repository: "https://git.example/shared", paths: ["docs/stock/flows", "docs/stock/", "docs/stock"] },
    ] }, "owner");
    const stored = readBusinessModule(dir, "orders");
    assert.deepEqual(stored.repository_knowledge_exclusions, [{ repository, paths: ["docs/stock"] }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "business-modules/orders/module.json"), "utf8")).repository_knowledge_exclusions,
      stored.repository_knowledge_exclusions, "选择写入模块记录，重启后仍然可读");
    assert.equal(moduleIncludesRepositoryKnowledge(stored, { repository, path: "docs/stock/README.md" }), false);
    assert.equal(moduleIncludesRepositoryKnowledge(stored, { repository, path: "docs/stock-extra/README.md" }), true);
    assert.equal(moduleIncludesRepositoryKnowledge(stored, { repository, path: "AGENTS.md" }), true);
    assert.equal(moduleIncludesRepositoryKnowledge(readBusinessModule(dir, "stock"), { repository, path: "docs/stock/README.md" }), true);
    updateBusinessModule(dir, "orders", { name: "交易业务" }, "owner");
    assert.deepEqual(readBusinessModule(dir, "orders").repository_knowledge_exclusions, stored.repository_knowledge_exclusions);
    const restored = updateBusinessModule(dir, "orders", { repository_knowledge_exclusions: [] }, "owner");
    assert.equal(moduleIncludesRepositoryKnowledge(restored, { repository, path: "docs/stock/README.md" }), true);
    assert.deepEqual(restored.repositories, original.repositories);
    assert.equal(restored.knowledge_path, original.knowledge_path);
    updateBusinessModule(dir, "orders", { repository_knowledge_exclusions: [{ repository, paths: ["docs"] }] }, "owner");
    const removed = updateBusinessModule(dir, "orders", { repositories: ["https://git.example/other.git"] }, "owner");
    assert.deepEqual(removed.repository_knowledge_exclusions, [], "移除仓库时清理该绑定的筛选");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("目录筛选拒绝越界路径、根导航、重复仓与其他模块独有仓", () => {
  for (const path of ["", "/", "docs/../stock", "docs//stock", "src", "AGENTS.md", "docs/.git", "docs\\stock"]) {
    assert.throws(() => normalizeRepositoryKnowledgeExclusions([{ repository, paths: [path] }], [repository]), /docs|路径/);
  }
  assert.throws(() => normalizeRepositoryKnowledgeExclusions([{ repository: "https://git.example/other.git", paths: ["docs"] }], [repository]), /关联代码仓/);
  assert.throws(() => normalizeRepositoryKnowledgeExclusions([{ repository, paths: [] }, { repository, paths: [] }], [repository]), /格式|一次/);
  assert.throws(() => normalizeRepositoryKnowledgeExclusions(null, [repository]), /格式/);
  assert.equal(moduleIncludesRepositoryKnowledge({ repositories: [repository] }, { repository: "https://git.example/other.git", path: "AGENTS.md" }), false);
});
