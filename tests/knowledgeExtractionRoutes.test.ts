import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

test("知识萃取 HTTP 权限、上传关联、修订与 Git 正文管理边界", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-routes-"));
  const auth = new LocalAuth(join(root, "auth.json")); auth.bootstrapAdmin("admin", "admin-fixture-password"); auth.createUser("dev", "dev-fixture-password", "developer");
  const service = new TaskService({ dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const domain = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "rules", title: "规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "# 规则\n测试内容", sources: "测试资料" }, { content: null, revision: "a".repeat(40) }); return "已保存";
  });
  (service as any).domainKnowledgeExtraction = domain;
  const server = createTaskServer(service, { auth }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, cookie = "", body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async (user: string) => (await request("/auth/login", "", { username: user, password: `${user}-fixture-password` })).headers.get("set-cookie")!.split(";")[0];
  try {
    for (const path of ["/domain-extraction", "/knowledge-materials/material-unknown", "/knowledge-extraction/skills/domain", "/knowledge-extraction/skills/component-analysis"]) assert.equal((await request(path)).status, 401);
    const dev = await login("dev"), admin = await login("admin");
    const skill: any = await (await request("/knowledge-extraction/skills/domain", dev)).json();
    assert.equal(skill.can_manage, false); assert.equal(skill.name, "business-docs-generator");
    assert.equal((await request("/knowledge-extraction/skills/domain", "", { files: skill.files, expected_digest: skill.digest })).status, 401);
    for (const actor of [dev, admin]) {
      assert.equal((await request("/knowledge-extraction/skills/domain", actor, { files: skill.files, expected_digest: skill.digest })).status, 405);
      assert.equal((await request("/knowledge-extraction/skills/domain/rollback", actor, { version_id: "old", expected_digest: skill.digest })).status, 405);
    }
    assert.equal((await (await request("/knowledge-extraction/skills/domain", dev)).json() as any).digest, skill.digest);
    const componentSkill: any = await (await request("/knowledge-extraction/skills/component", dev)).json();
    assert.equal(componentSkill.can_manage, false);
    assert.equal((await request("/knowledge-extraction/skills/component", dev, { files: componentSkill.files, expected_digest: componentSkill.digest })).status, 405);
    assert.equal((await request("/knowledge-extraction/skills/component/rollback", admin, { version_id: "old", expected_digest: componentSkill.digest })).status, 405);
    const analysisPath = "/knowledge-extraction/skills/component-analysis";
    const analysisSkill: any = await (await request(analysisPath, dev)).json();
    assert.equal(analysisSkill.name, "component-module-analysis"); assert.equal(analysisSkill.can_manage, false);
    const revisedAnalysis = { ...analysisSkill.files, "SKILL.md": analysisSkill.files["SKILL.md"] + "\n按源码边界分析独立模块。\n" };
    assert.equal((await request(analysisPath, "", { files: revisedAnalysis, expected_digest: analysisSkill.digest })).status, 401);
    assert.equal((await request(analysisPath, dev, { files: revisedAnalysis, expected_digest: analysisSkill.digest })).status, 405);
    assert.equal((await request(analysisPath, admin, { files: revisedAnalysis, expected_digest: analysisSkill.digest })).status, 405);
    assert.equal((await (await request("/knowledge-extraction/skills/component", dev)).json() as any).digest, componentSkill.digest);
    assert.equal((await request(`${analysisPath}/rollback`, dev, { version_id: "old", expected_digest: analysisSkill.digest })).status, 405);
    assert.equal((await (await request(analysisPath, dev)).json() as any).digest, analysisSkill.digest);
    const upload = await request("/knowledge-materials", dev, { name: "rules.txt", content_base64: Buffer.from("业务资料测试").toString("base64") }); assert.equal(upload.status, 201);
    const material: any = await upload.json(); assert.equal(material.state, "ready");
    const start = await request("/domain-extraction", dev, { issue_no: "REQ-123", title: "领域", scope: "规则", material_ids: [material.id], repositories: [{ repository: "https://example.test/business.git", branch: "main", docs_path: "docs" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } });
    assert.equal(start.status, 202); const job: any = await start.json();
    for (let i = 0; i < 100 && domain.get(job.id).status !== "done"; i++) await new Promise(r => setTimeout(r, 5));
    const detail: any = await (await request(`/domain-extraction/${job.id}`, dev)).json(); assert.equal(detail.operator, "dev"); assert.equal(detail.issue_no, "REQ-123");
    assert.equal((await request(`/domain-extraction/${job.id}/resume`, "", {})).status, 401);
    const resumed: any = await (await request(`/domain-extraction/${job.id}/resume`, dev, { use_latest_skill: true })).json();
    assert.equal(resumed.turns.length, 1); assert.equal(resumed.turns[0].id, detail.turns[0].id); assert.equal(resumed.turns[0].use_latest_skill, true);
    for (let i = 0; i < 100 && domain.get(job.id).status !== "done"; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal((await request(`/domain-extraction/${job.id}/issue`, dev, { issue_no: "" })).status, 400);
    assert.equal((await request(`/domain-extraction/${job.id}/issue`, dev, { issue_no: "REQ-456", issue_description: "" })).status, 400);
    const associated = await request(`/domain-extraction/${job.id}/issue`, dev, { issue_no: "REQ-456", issue_description: "  核对领域规则  " });
    assert.equal(associated.status, 200); const association: any = await associated.json();
    assert.equal(association.issue_no, "REQ-456"); assert.equal(association.issue_description, "核对领域规则"); assert.deepEqual(detail.material_ids, [material.id]);
    createBusinessModule(root, { id: "trade", name: "交易", description: "交易业务", owner: "dev", repositories: ["https://example.test/source.git"] }, "dev");
    const later = await request("/domain-extraction", dev, { issue_no: "REQ-later", module_id: "trade", baseline_branch: "release" });
    assert.equal(later.status, 202); const deferred: any = await later.json();
    for (let i = 0; i < 100 && domain.get(deferred.id).status !== "done"; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(domain.get(deferred.id).archive_configured, false); assert.equal(domain.get(deferred.id).source_repositories![0].branch, "release");
    const location = await request(`/domain-extraction/${deferred.id}/archive-targets`, dev, { base_revision: 0, targets: [{ id: "domain", repository: "https://example.test/archive.git", branch: "docs", docs_path: "new/domain" }] });
    // directory-v1:显式 docs_path 即最终目录,不再自动拼模块名子目录。
    assert.equal(location.status, 200); assert.equal((await location.json() as any).documents[0].path, "new/domain/rules.md");
    const edited = await request(`/domain-extraction/${job.id}/edit`, dev, { document: { ...detail.documents[0], content: "人工核对后的规则" }, base_revision: 1 }); assert.equal(edited.status, 200);
    assert.equal((await request(`/domain-extraction/${job.id}/edit`, dev, { document: detail.documents[0], base_revision: 1 })).status, 400);
    const doc = saveKnowledgeDocument(root, { title: "领域规则", content: "Git 正文", scope: "platform", research_source: { job_id: job.id, repository: "https://example.test/knowledge.git", branch: "main", path: "domains/rules.md" }, source: { repository: "https://example.test/knowledge.git", branch: "main", path: "domains/rules.md", revision: "a".repeat(40) } }, "dev");
    assert.equal((await request(`/knowledge-documents/${doc.id}`, dev, { content: "绕开 MR 修改" })).status, 400);
    assert.equal((await request(`/knowledge-documents/${doc.id}`, dev, { active: false })).status, 400, "启停也必须提供版本号");
    assert.equal((await request(`/knowledge-documents/${doc.id}`, dev, { active: false, expected_revision: doc.revision })).status, 200);
    assert.equal((await request(`/domain-extraction/${job.id}/delete`, "", {})).status, 401);
    const deleted = await request(`/domain-extraction/${job.id}/delete`, dev, {});
    assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal((await request(`/domain-extraction/${job.id}`, dev)).status, 404);
    const remaining: any = await (await request("/domain-extraction", dev)).json();
    assert.ok(!remaining.records.some((r: any) => r.id === job.id));
// 13ff28b7:任务删除连带其绑定文稿(领域正文由 Git 保存,平台不留副本);
    // 共享材料是任务无关资产,仍保留(下行)。
    assert.equal((await request(`/knowledge-documents/${doc.id}`, dev)).status, 404);
    assert.equal((await request(`/knowledge-materials/${material.id}`, dev)).status, 200);
  } finally { await service.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
