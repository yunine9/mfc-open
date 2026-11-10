import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import {
  knowledgeMatchesTask,
  knowledgeMatchesIssueSession,
  normalizeKnowledgeAssetMetadata,
  readSkillKnowledgeMetadata,
  writeSkillKnowledgeMetadata,
} from "../src/knowledgeAssetModel.ts";
import {
  requireRepositoryProfiles,
  resolveRepositoryProfiles,
  saveRepositoryProfile,
} from "../src/repositoryProfiles.ts";

const SKILL = `---
name: order-troubleshooting
description: 定位订单服务故障
languages: [Java]
---

# 排障方法
`;

test("通用工程 Skill 保留明确标签，跨语言匹配但仍尊重仓库和模块范围", () => {
  const metadata = normalizeKnowledgeAssetMetadata({ nature: "engineering",
    form: "skill", technologies: ["通用"] });
  assert.deepEqual(metadata.technologies, ["agnostic"]);
  assert.deepEqual(readSkillKnowledgeMetadata(writeSkillKnowledgeMetadata(SKILL, metadata)), metadata);
  assert.equal(readSkillKnowledgeMetadata(SKILL.replace("[Java]", "[agnostic]")).nature, "engineering");
  assert.equal(readSkillKnowledgeMetadata(SKILL.replace("languages: [Java]", "knowledge_nature: business\nbusiness_modules: [orders]\nlanguages: [agnostic]")).nature, "business");
  for (const technologies of [[], ["cpp"], ["java"]]) {
    assert.equal(knowledgeMatchesTask(metadata, { repositories: [], technologies, businessModuleIds: [] }), true);
  }
  const context = { repositories: [], technologies: [], businessModuleIds: [] };
  assert.equal(knowledgeMatchesIssueSession(metadata, context), true);
  for (const restricted of [{ ...metadata, repositories: ["https://example.com/repo.git"] },
    { ...metadata, business_module_ids: ["orders"] }]) {
    assert.equal(knowledgeMatchesTask(restricted, context), false);
    assert.equal(knowledgeMatchesIssueSession(restricted, context), false);
  }
  const incomplete = { ...metadata, technologies: [] };
  assert.equal(knowledgeMatchesTask(incomplete, context), false);
  assert.equal(knowledgeMatchesIssueSession(incomplete, context), false);
});

test("统一模型：性质与作用域强制；业务模块和工程语言均可多选", () => {
  assert.throws(() => normalizeKnowledgeAssetMetadata({ form: "document" }),
    /请明确选择知识性质/, "知识入库不能靠默认值猜业务或工程性质");
  const engineering = normalizeKnowledgeAssetMetadata({
    nature: "engineering", form: "skill",
    business_module_ids: ["orders"],
    repositories: ["https://code.example/orders.git"],
    technologies: ["Java"],
  });
  assert.equal(engineering.nature, "engineering");
  assert.equal(engineering.form, "skill");
  assert.deepEqual(engineering.business_module_ids, ["orders"]);
  assert.ok(knowledgeMatchesTask(engineering, {
    repositories: ["https://code.example/orders.git"],
    technologies: ["java"], businessModuleIds: ["orders"],
  }));
  assert.equal(knowledgeMatchesTask(engineering, {
    repositories: ["https://code.example/orders.git"],
    technologies: ["java"], businessModuleIds: ["payments"],
  }), false, "模块上下文限定推荐范围，但不改变工程性质");
  assert.throws(() => normalizeKnowledgeAssetMetadata({
    nature: "business", form: "document",
    business_module_ids: ["orders"], repositories: [], technologies: ["java"],
  }), /业务知识不能标工程语言/);
  assert.throws(() => normalizeKnowledgeAssetMetadata({
    nature: "business", form: "document",
    business_module_ids: [], repositories: [], technologies: [],
  }), /至少选择一个归属业务模块/);
  assert.deepEqual(normalizeKnowledgeAssetMetadata({
    nature: "business", form: "document",
    business_module_ids: ["payments", "orders", "orders"],
    repositories: [], technologies: [],
  }).business_module_ids, ["orders", "payments"]);
  assert.throws(() => normalizeKnowledgeAssetMetadata({
    nature: "engineering", form: "rule",
    business_module_ids: [], repositories: [], technologies: [],
  }), /至少选择一种适用语言/);
  assert.deepEqual(normalizeKnowledgeAssetMetadata({
    nature: "engineering", form: "rule",
    business_module_ids: [], repositories: [], technologies: ["Java", "C++"],
  }).technologies, ["java", "cpp"]);

  const legacy = readSkillKnowledgeMetadata(SKILL);
  assert.equal(legacy.nature, "engineering");
  assert.deepEqual(legacy.technologies, ["java"]);
  const migrated = writeSkillKnowledgeMetadata(SKILL, engineering);
  assert.match(migrated, /knowledge_nature: engineering/);
  assert.match(migrated, /technologies: \[java\]/);
  assert.doesNotMatch(migrated, /^languages:/m);
});

test("仓库技术画像首次人工确认并复用；新任务不接受空技术栈", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-repository-profile-"));
  createTechnologyStack(dataDir, { id: "cpp", name: "C++" }, "admin");
  createTechnologyStack(dataDir, { id: "javascript", name: "JavaScript" }, "admin");
  const repository = "https://code.example/team/mixed.git";
  assert.equal(resolveRepositoryProfiles(dataDir, [repository])[0].profile,
    undefined);
  const saved = saveRepositoryProfile(dataDir, {
    repository, technologies: ["C++", "js"], confirmed: true,
  }, "developer-a");
  assert.deepEqual(saved.technologies, ["cpp", "javascript"]);
  const resolved = resolveRepositoryProfiles(dataDir,
    ["https://code.example/team/mixed"])[0].profile!;
  assert.equal(resolved.confirmed, true);
  assert.deepEqual(resolved.technologies, ["cpp", "javascript"]);

  assert.throws(() => saveRepositoryProfile(dataDir, {
    repository, technologies: [], confirmed: true,
  }, "developer-a"), /至少选择一种仓库技术栈/);
  assert.throws(() => requireRepositoryProfiles(
    [repository, "https://code.example/team/web.git"], [saved]),
  /代码仓 web 还没有选择技术栈/);
  assert.deepEqual(requireRepositoryProfiles([repository], [saved]), [saved]);
});
