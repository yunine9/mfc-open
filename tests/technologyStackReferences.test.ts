import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTechnologyStack, updateTechnologyStack } from "../src/technologyStacks.ts";
import { deleteTechnologyStack } from "../src/technologyStackDeletion.ts";
import { componentRepositories, saveComponentRepository } from "../src/componentRepositories.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { listSkillVersions, readHostSkillDocument, rollbackHostSkill, submitHostSkill, uploadHostSkill } from "../src/hostSkillLibrary.ts";

function temporary() { return mkdtempSync(join(tmpdir(), "mfc-stack-references-")); }
function register(dir: string) { return createTechnologyStack(dir, { name: "平台框架", id: "platform-stack" }, "dev"); }
const component = { name: "平台组件", repository: "https://code.example/team/components.git", branch: "main", path: "", languages: ["platform-stack"] };
const metadata = { nature: "engineering" as const, business_module_ids: [], repositories: [], technologies: ["platform-stack"] };
const skill = (body: string) => [{ path: "SKILL.md", content_base64: Buffer.from(`---\nname: platform-guide\ndescription: 平台开发指南\n---\n${body}\n`).toString("base64") }];

test("组件只允许目录中的技术栈；停用保留旧关联，删除后不能恢复旧编号", () => {
  const dir = temporary();
  try {
    assert.throws(() => saveComponentRepository(dir, component, "dev"), /尚未登记/);
    register(dir);
    const row = saveComponentRepository(dir, component, "dev");
    updateTechnologyStack(dir, "platform-stack", { enabled: false }, "dev");
    assert.equal(saveComponentRepository(dir, { id: row.id, name: "平台组件新版" }, "dev").languages[0], "platform-stack");
    assert.throws(() => saveComponentRepository(dir, { ...component, name: "新组件" }, "dev"), /已停用/);
    const research = new ComponentResearch(dir, async () => { throw new Error("不应启动研究"); });
    assert.throws(() => research.start({ repository_ids: [row.id], language: "platform-stack" }, "dev"), /已停用/);
    deleteTechnologyStack(dir, "platform-stack", "dev");
    assert.deepEqual(componentRepositories(dir)[0].languages, []);
    assert.equal(componentRepositories(dir)[0].enabled, false);
    assert.throws(() => saveComponentRepository(dir, { id: row.id, languages: row.languages, enabled: true }, "dev"), /尚未登记/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("知识文档保留停用关联更新正文，删除后旧研究成果不能重新关联已删技术栈", () => {
  const dir = temporary();
  try {
    register(dir);
    const row = saveKnowledgeDocument(dir, { title: "框架说明", content: "正文保留", technologies: ["platform-stack"] }, "dev");
    updateTechnologyStack(dir, "platform-stack", { enabled: false }, "dev");
    saveKnowledgeDocument(dir, { content: "正文修订" }, "dev", row.id);
    assert.throws(() => saveKnowledgeDocument(dir, { title: "新增说明", content: "正文", technologies: row.technologies }, "dev"), /已停用/);
    deleteTechnologyStack(dir, "platform-stack", "dev");
    const deletedReference = readKnowledgeDocument(dir, row.id);
    assert.equal(deletedReference.content, "正文修订");
    assert.deepEqual(deletedReference.technologies, []);
    assert.equal(deletedReference.active, false);
    assert.equal(deletedReference.technology_assignment_required, true);
    assert.throws(() => saveKnowledgeDocument(dir, { active: true, technology_assignment_required: false }, "dev", row.id), /先补充技术栈/);
    assert.throws(() => saveKnowledgeDocument(dir, { active: true, technologies: ["agnostic"] }, "dev", row.id), /先补充技术栈/);
    const afterEdit = saveKnowledgeDocument(dir, { title: "保留待关联说明" }, "dev", row.id);
    assert.equal(afterEdit.technology_assignment_required, true);
    assert.throws(() => saveKnowledgeDocument(dir, { technologies: row.technologies, active: true }, "research", row.id), /尚未登记/);
    const replacement = createTechnologyStack(dir, { name: "新框架", id: "next-stack" }, "dev");
    const restored = saveKnowledgeDocument(dir, { technologies: [replacement.id], active: true }, "dev", row.id);
    assert.equal(restored.technology_assignment_required, undefined);
    assert.equal(restored.active, true);
    assert.equal(saveKnowledgeDocument(dir, { title: "原有通用知识", content: "通用正文", active: true }, "dev").active, true);
    assert.deepEqual(saveKnowledgeDocument(dir, { title: "显式通用知识", content: "通用正文", technologies: ["agnostic"] }, "dev").technologies, ["agnostic"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Skill 上传、待审和回退同查目录，删除保留正文但旧版本不能恢复已删关联", async () => {
  const dir = temporary();
  try {
    register(dir);
    await uploadHostSkill(dir, "platform-guide", skill("正文 v1"), "dev", metadata);
    await uploadHostSkill(dir, "platform-guide", skill("正文 v2"), "dev", metadata);
    const oldVersion = listSkillVersions(dir, "platform-guide")[0].version_id;
    updateTechnologyStack(dir, "platform-stack", { enabled: false }, "dev");
    await uploadHostSkill(dir, "platform-guide", skill("正文 v3"), "dev", metadata);
    await assert.rejects(uploadHostSkill(dir, "new-guide", skill("新资料"), "dev", metadata), /已停用/);
    await assert.rejects(submitHostSkill(dir, "new-guide", skill("待审资料"), "dev", metadata), /已停用/);
    deleteTechnologyStack(dir, "platform-stack", "dev");
    assert.match(readHostSkillDocument(dir, "platform-guide").content, /正文 v3/);
    await assert.rejects(rollbackHostSkill(dir, "platform-guide", oldVersion, "dev"), /尚未登记/);
    await assert.rejects(uploadHostSkill(dir, "platform-guide", skill("恢复旧关联"), "dev", metadata), /尚未登记/);
    await assert.rejects(submitHostSkill(dir, "platform-guide", skill("恢复待审关联"), "dev", metadata), /尚未登记/);
    await assert.rejects(uploadHostSkill(dir, "platform-guide", skill("无关联"), "dev", { ...metadata, technologies: [] }), /至少选择/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
