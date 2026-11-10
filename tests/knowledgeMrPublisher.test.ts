import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { listKnowledgeDocuments, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

test("生产线验收5/14：人工归档所选正式知识原样推根目录和子目录，只改MR分支且保留其他文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-path-publish-")), source = join(root, "source"), remote = join(root, "remote.git");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-b", "master"); writeFileSync(join(source, "AGENTS.md"), "旧规范\n"); writeFileSync(join(source, "code.ts"), "源码\n");
  git(source, "add", "."); git(source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"); git(root, "clone", "--bare", source, remote);
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: 1, url: "https://example.test/mr/1" })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => `http://127.0.0.1:${(server.address() as any).port}`, credential: () => ({ username: "fixture", password: "fixture-password", email: "fixture@example.test" }) });
  const target = { id: "domain", name: "知识仓", repository: remote, branch: "master", path: "", docs_path: "docs/knowledge" };
  const job: DomainKnowledgeJob = { id: "dkx-paths", title: "规则", scope: "规则", issue_no: "REQ-files", issue_description: "整理业务规范与领域文档", operator: "user", created_at: "now", repositories: [], knowledge_target: target, material_ids: [], status: "done", stage: "归档", revisions: {}, turns: [], evidence: [], publications: [], documents: ["AGENTS.md", "docs/domain/rules.md", "guides/extra.md"].map((path, index) => ({ id: `doc-${index}`, title: path, path, archive_path: path, target_id: "domain", layer: "domain", content: "新知识", sources: "已核对源码", revision: 1, selected: true, base_content: path === "AGENTS.md" ? "旧规范\n" : null, base_revision: git(source, "rev-parse", "HEAD"), history: [] })) };
  try {
    for (const doc of job.documents) {
      const formal = saveKnowledgeDocument(root, { title: doc.title, content: doc.content, scope: "platform" }, "user");
      doc.knowledge_document_id = formal.id; doc.published_revision = formal.revision; doc.published_document_revision = doc.revision;
    }
    const publication = await publisher.publish(job, target, undefined, "user", () => {});
    assert.equal(publication.state, "opened");
    assert.equal(publication.branch, "master_fixture_REQ-files", "归档分支沿用基线、个人 Git 账号与单号，不能用平台用户代替 Git 账号");
    for (const doc of job.documents) assert.equal(git(remote, "show", `${publication.branch}:${doc.path}`), doc.content, "MR 原样保存 Skill 正文，不添加平台来源章节");
    assert.equal(git(remote, "show", `${publication.branch}:code.ts`), "源码");
    assert.equal(git(remote, "show", "master:AGENTS.md"), "旧规范");
  } finally { await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("生产线验收5/14：组件正式版本手动归档只提交一篇正文，结构字段留在平台且不修改平台正文", async () => {
  const { researchDocumentMarkdown } = await import("../src/componentResearchDocument.ts");
  const { componentArchiveParts } = await import("../src/componentKnowledgeArchiveFormat.ts");
  const { componentSection } = await import("./componentConsumptionFixture.ts");
  const { publishedComponentParadigms } = await import("../src/componentKnowledgeDocument.ts");
  const root = mkdtempSync(join(tmpdir(), "component-clean-publish-")), source = join(root, "source"), remote = join(root, "remote.git");
  seedTechnologyStacks(root, ["cpp"]);
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "code.cpp"), "// original\n"); git(source, "add", "."); git(source, "commit", "-m", "fixture"); git(root, "clone", "--bare", source, remote);
  const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: 1, url: "https://example.test/mr/1" })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => `http://127.0.0.1:${(server.address() as any).port}`, credential: () => ({ username: "Fixture", password: "fixture-password", email: "fixture@example.test" }) });
  const target = { id: "domain", name: "组件知识仓", repository: remote, branch: "main", path: "", docs_path: "docs/components" };
  const section = componentSection();
  const formalContent = researchDocumentMarkdown("任务池使用指南", { overview: "## 组件用途\n提交后台任务并在退出前等待完成。\n\n## 接入配置\n链接 pool v2 并保留任务的完整生命周期。", sections: [section] }, true);
  const { content } = componentArchiveParts(formalContent);
  const path = "docs/components/cpp/任务池使用指南.md";
  const job: DomainKnowledgeJob = { id: "dkx-clean-guide", component_research_id: "cr-components", title: "任务池使用指南", issue_no: "REQ-guide", issue_description: "补齐任务池的安全使用指南", scope: "组件归档", operator: "expert", created_at: "now", repositories: [], knowledge_target: target, material_ids: [], status: "done", stage: "审查", revisions: {}, turns: [], evidence: [], publications: [], documents: [{ id: "guide", title: "任务池使用指南", path, target_id: "domain", layer: "domain", content, sources: "核对过的源码与调用", revision: 1, selected: true, base_content: null, base_revision: "", history: [] }] };
  try {
    const local = saveKnowledgeDocument(root, { title: job.title, content: formalContent, technologies: ["cpp"] }, "expert");
    Object.assign(job.documents[0], { knowledge_document_id: local.id, published_revision: local.revision, published_document_revision: 1 });
    const first = await publisher.publish(job, target, undefined, "expert", () => {});
    assert.equal(first.branch, "main_Fixture_REQ-guide");
    const md = git(remote, "show", `${first.branch}:${path}`);
    assert.doesNotMatch(md, /everycode|repository_id|schema:|来源|a{40}/);
    assert.match(md, /Pool.submit/);
    assert.equal(first.documents.length, 1, "一个组件一篇正文，不带结构文件");
    assert.deepEqual(git(remote, "-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", first.branch).trim().split("\n").sort(), ["code.cpp", path].sort());
    const formal = listKnowledgeDocuments(root); assert.equal(formal.length, 1);
    assert.equal(formal[0].revision, local.revision, "手动归档不改平台正文或版本");
    const parsed = publishedComponentParadigms({ id: formal[0].id, revision: formal[0].revision, content: formal[0].content, productVersions: [] });
    assert.deepEqual(parsed[0].replaces, section.paradigm!.replaces, "结构字段仍在平台正式库，程序消费不依赖 Git");
    assert.deepEqual(parsed[0].evidence, section.paradigm!.evidence);
  } finally { await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
