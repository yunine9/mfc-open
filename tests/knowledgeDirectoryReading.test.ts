import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { knowledgeDocumentCatalog, knowledgeDocumentDirectory, knowledgeDocumentReadRevision, readCatalogKnowledgeDocument } from "../src/knowledgeDocumentCatalog.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createTaskServer } from "../src/server.ts";
import type { TaskService } from "../src/taskService.ts";
import { MemoryStore } from "../src/taskMemory.ts";
import { gitKnowledgeDocument } from "./fixtures/gitKnowledge.ts";
import { readGitKnowledgeSnapshot, writeGitKnowledgeSnapshot } from "../src/knowledgeRepositorySnapshots.ts";
import { submitHostSkill, approveSkillSubmission } from "../src/hostSkillLibrary.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";

test("轻量目录保留正式知识与经验的展示口径，读取单篇不装配全库正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-directory-"));
  const original = fs.readFileSync;
  try {
    createBusinessModule(dir, { id: "access", name: "接入", description: "接入模块", owner: "owner", repositories: ["https://example.test/access.git"] }, "owner");
    const git = gitKnowledgeDocument(dir, "access", { title: "接入说明.md", content: "# 接入\n正文\n" });
    const manual = saveKnowledgeDocument(dir, { title: "工程手册", content: "# 工程\n约定" }, "owner");
    const draft = saveKnowledgeDocument(dir, { title: "旧业务草稿", content: "不要作为正式知识", scope: "module", module_ids: ["access"] }, "owner");
    const store = new MemoryStore(dir);
    const memory = store.record({ source: "agent_note", judged_by: "human", scope: "platform", repo: "r", paths: [],
      task: "task-1", evidence: "fixture", trigger: "读取文件", conclusion: "检查句柄" });
    store.review(memory.id, "owner", { decision: "accepted", revision: 1 });
    const full = knowledgeDocumentCatalog(dir).documents.map(({ content, ...document }) =>
      ({ ...document, lines: content.split("\n").length }));
    assert.deepEqual(knowledgeDocumentDirectory(dir), full);
    assert.ok(!full.some(document => document.id === draft.id));
    const reads: string[] = [];
    fs.readFileSync = ((path: any, ...args: any[]) => {
      if (String(path).includes("/knowledge-git/modules/") || String(path).includes("/knowledge-documents/")) reads.push(String(path));
      return (original as any)(path, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const lightweight = knowledgeDocumentDirectory(dir);
    assert.equal(knowledgeDocumentReadRevision(dir), knowledgeDocumentReadRevision(dir, lightweight),
      "轮询版本与本次目录返回的版本一致");
    assert.equal(reads.length, 0, "已有目录缓存时不再读正式快照及旧文稿正文");
    assert.equal(readCatalogKnowledgeDocument(dir, git.id)?.content, git.content);
    assert.equal(reads.length, 0, "单篇 Git 正文也不能重新扫描全部快照或旧文稿");
    assert.equal(lightweight.find(document => document.id === git.id)?.lines, 3);
    assert.ok(lightweight.every(document => !("content" in document)));
    const changed = saveKnowledgeDocument(dir, { content: "# 工程\n新规则\n" }, "owner", manual.id);
    reads.length = 0;
    const next = knowledgeDocumentDirectory(dir).find(document => document.id === manual.id)!;
    assert.equal(next.revision, changed.revision);
    assert.equal(next.lines, 3);
    assert.equal(reads.filter(path => path.endsWith(`${manual.id}.json`)).length, 1,
      "变更后只读取这篇正文以更新目录");
    assert.equal(readCatalogKnowledgeDocument(dir, draft.id), undefined);
  } finally {
    fs.readFileSync = original; syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill 提交时选择的技术栈进入生效包，并在知识目录中保留归属", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-directory-"));
  try {
    createTechnologyStack(dir, { name: "Java" }, "owner");
    const source = "---\nname: uploaded-guide\ndescription: Java 编码规范\n---\n\n# 编码规范\n";
    const submission = await submitHostSkill(dir, "uploaded-guide", [
      { path: "SKILL.md", content_base64: Buffer.from(source).toString("base64") },
    ], "owner", { nature: "engineering", business_module_ids: [], repositories: [], technologies: ["java"] });
    assert.match(readFileSync(join(dir, "skill-submissions", "uploaded-guide", submission.id, "package", "SKILL.md"), "utf8"), /technologies: \[java\]/);
    await approveSkillSubmission(dir, "uploaded-guide", submission.id, "reviewer");
    const id = "skill:uploaded-guide/SKILL.md";
    for (const document of [knowledgeDocumentCatalog(dir).documents.find(row => row.id === id),
      knowledgeDocumentDirectory(dir).find(row => row.id === id), readCatalogKnowledgeDocument(dir, id)]) {
      assert.deepEqual(document?.technologies, ["java"]);
    }

    mkdirSync(join(dir, "skills", "legacy-guide"));
    writeFileSync(join(dir, "skills", "legacy-guide", "SKILL.md"),
      "---\nname: legacy-guide\ndescription: 旧版 Skill\n---\n\n# 旧版\n");
    assert.deepEqual(knowledgeDocumentDirectory(dir).find(row => row.id === "skill:legacy-guide/SKILL.md")?.technologies, [],
      "没有知识标签的旧 Skill 继续留在待整理范围");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("知识目录 HTTP 不计算全文索引或需求任务效果，任务摘要不返回文稿清单", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-directory-http-"));
  let effects = 0, domainLists = 0;
  const service = {
    options: { dataDir: dir },
    getKnowledgeSearch: () => { throw new Error("轻量目录不应读取索引状态"); },
    hostSkillShelf: () => { effects++; return { root_exists: false, skills: [], warnings: [] }; },
    getDomainKnowledgeExtraction: () => ({ taskRows: () => { domainLists++; return []; }, warnings: () => [] }),
    getComponentResearch: () => ({ taskRows: () => [], warnings: () => [] }),
    skillExtractionJob: () => undefined,
    knowledgeRecordWarnings: () => [],
  } as unknown as TaskService;
  const server = createTaskServer(service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  try {
    const doc = saveKnowledgeDocument(dir, { title: "工程手册", content: "# 规则\n正文" }, "owner");
    const list = await get("/knowledge-documents?view=directory");
    assert.equal(list.documents[0].id, doc.id);
    assert.equal(list.documents[0].content, undefined);
    const versionResponse = await fetch(origin + "/knowledge-documents?view=revision");
    assert.equal(versionResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await versionResponse.json(), { revision: list.revision }, "版本检查只返回摘要");
    saveKnowledgeDocument(dir, { content: "# 规则\n更新正文" }, "owner", doc.id);
    const changed = await get("/knowledge-documents?view=revision");
    assert.notEqual(changed.revision, list.revision);
    assert.equal((await get("/knowledge-documents?view=directory")).revision, changed.revision);
    assert.equal((await get(`/knowledge-documents/${doc.id}`)).content, "# 规则\n更新正文");
    await get("/skills?view=directory"); await get("/skills?view=directory");
    assert.equal(effects, 0, "目录请求不能投影需求任务");
    await get("/skills");
    assert.equal(effects, 1, "管理页仍保留原效果统计");
    assert.deepEqual(await get("/knowledge-tasks?summary=1"), { summary: { running: 0, attention: 0, total: 0 } });
    await get("/knowledge-tasks?summary=1");
    assert.equal(domainLists, 1, "多个页面的短时间摘要读取共用结果");
    assert.ok(Array.isArray((await get("/knowledge-tasks")).tasks));
    assert.equal(domainLists, 2, "任务中心完整列表始终读取当前状态");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("阅读版本忽略同步时间，但识别图片提交、文稿删除和模块绑定变化", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-read-revision-"));
  try {
    createBusinessModule(dir, { id: "access", name: "接入", description: "接入模块", owner: "owner", repositories: ["https://example.test/access.git"] }, "owner");
    gitKnowledgeDocument(dir, "access", { title: "接入说明", content: "# 接入\n![架构](architecture.png)" });
    const snapshot = readGitKnowledgeSnapshot(dir, "access")!;
    const initial = knowledgeDocumentReadRevision(dir);
    const refreshed = structuredClone(snapshot);
    refreshed.synced_at = "2099-01-01T00:00:00.000Z";
    for (const source of refreshed.repositories) source.synced_at = refreshed.synced_at;
    for (const document of refreshed.documents) document.history[0].at = refreshed.synced_at;
    writeGitKnowledgeSnapshot(dir, refreshed);
    assert.equal(knowledgeDocumentReadRevision(dir), initial, "同步时间不能触发正文反复加载");
    for (const source of refreshed.repositories) source.revision = "image-only-commit";
    for (const document of refreshed.documents) document.source!.revision = "image-only-commit";
    writeGitKnowledgeSnapshot(dir, refreshed);
    const imageRevision = knowledgeDocumentReadRevision(dir);
    assert.notEqual(imageRevision, initial, "只改图片的来源提交也要通知阅读页");
    writeGitKnowledgeSnapshot(dir, { ...refreshed, documents: [] });
    const empty = knowledgeDocumentReadRevision(dir);
    assert.notEqual(empty, imageRevision, "最后一篇被删除也必须刷新");
    updateBusinessModule(dir, "access", { knowledge_path: "domains/new-access" }, "owner");
    const rebound = knowledgeDocumentReadRevision(dir);
    assert.notEqual(rebound, empty, "空目录的绑定改变也要更新");
    updateBusinessModule(dir, "access", { name: "新接入" }, "owner");
    assert.notEqual(knowledgeDocumentReadRevision(dir), rebound, "首页模块名称跟随配置更新");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
