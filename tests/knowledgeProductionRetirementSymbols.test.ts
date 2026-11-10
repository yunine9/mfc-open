import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const retired = [
  "knowledgeCandidates", "engineeringKnowledgeRuntime", "skillDistiller",
  "knowledgeConsolidation", "knowledgeConsolidationAgent",
  "knowledgeConsolidationAudit", "knowledgeConsolidationStore",
  "knowledgeConsolidationTypes", "domainKnowledgeProbe",
  // knowledgeSourceCleanup 原 B1 退役后,被 #489 模块迁移的「旧知识清理」
  // 特性有意复名复活(src/knowledgeSourceCleanup.ts,现行机器非僵尸)。

  "componentApiBoundary", "componentResearchDocumentTool", "componentResearchMission",
  "KnowledgeDocuments", "KnowledgeCatalogTree", "KnowledgeTrial",
  "KnowledgeExport", "KnowledgeRepositoryTree", "KnowledgeConsolidation",
  "KnowledgeConsolidationAudit",
  // KnowledgeSourceCleanup(类/页组件)原 B1 退役后,被 #489 模块迁移的
  // 「旧知识清理」特性有意复名复活:src/knowledgeSourceCleanup.ts 与
  // web/src/KnowledgeSourceCleanup.tsx 都是现行机器,DomainKnowledgeExtraction
  // 与 KnowledgeLibrary 在用,非僵尸。
];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|js|mjs|py)$/.test(entry.name) ? [path] : [];
  });
}

test("B1验收1：退役符号与旧页面没有运行调用方", () => {
  const pattern = new RegExp(`\\b(?:${retired.join("|")})\\b`);
  for (const directory of ["src", "web/src", "harness", "scripts", "tests"]) {
    for (const path of sources(join(root, directory))) {
      if (basename(path) === "knowledgeProductionRetirementSymbols.test.ts") continue;
      assert.doesNotMatch(readFileSync(path, "utf8"), pattern, path);
    }
  }
});

test("B1验收3：退役模块与专属测试已经删除", () => {
  for (const name of retired) {
    for (const directory of ["src", "web/src", "tests", "tests/browser"]) {
      for (const suffix of [".ts", ".tsx", ".test.ts"]) {
        const path = join(root, directory, name + suffix);
        assert.equal(readdirSync(join(root, directory)).includes(name + suffix), false, path);
      }
    }
  }
});
