import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { knowledgeDocumentReadRevision } from "../src/knowledgeDocumentCatalog.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import { collectSearchableKnowledge, KnowledgeSearch } from "../src/knowledgeSearch.ts";
import {
  freezeGitKnowledgeResources, gitKnowledgeResourceKey, listGitKnowledgeDocumentMetadata, listGitKnowledgeDocuments,
  listModuleRepositoryKnowledgePaths, readFrozenGitKnowledgeResource, readGitKnowledgeDocument, readGitKnowledgeResource,
  readModuleKnowledgeContentRevision, writeGitKnowledgeSnapshot, type GitKnowledgeSnapshot,
} from "../src/knowledgeRepositorySnapshots.ts";

const repository = "https://example.test/shared.git", domain = "https://example.test/knowledge.git";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const at = "2026-10-22T01:00:00.000Z", revision = "a".repeat(40);
const id = (path: string) => `kg-${hash(path)}`;
function setup(t: TestContext, additionalPaths: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-exclusions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  saveKnowledgeRepoConfig(dir, domain, { branch: "main" });
  const paths = ["AGENTS.md", "docs/A/guide.md", "docs/B/guide.md", "docs/AB/deep/guide.md", ...additionalPaths];
  for (const moduleId of ["alpha", "beta"]) createBusinessModule(dir, {
    id: moduleId, name: moduleId, owner: "fixture", description: moduleId, repositories: [repository], knowledge_path: `domains/${moduleId}`,
  }, "fixture");
  const snapshot = (moduleId: string, commit = revision, time = at): GitKnowledgeSnapshot => ({
    module_id: moduleId, location: { repository: domain, branch: "main", docs_path: `domains/${moduleId}` }, synced_at: time,
    documents: paths.map(path => ({ id: id(path), title: path, content: `# ${path}\n\n规则正文\n![图](image.png)\n`, revision: hash(path), scope: "repository",
      module_ids: [], repositories: [repository], technologies: [], product_versions: [], when_to_use: "", active: true,
      source: { repository, branch: "main", path, revision: commit }, history: [{ at: time, action: "从正式分支同步", operator: "fixture" }] })),
    repositories: [{ repository, branch: "main", revision: commit, scope: "repository", synced_at: time }], resources: {},
  });
  const alpha = snapshot("alpha"), beta = snapshot("beta");
  const image = Buffer.from("frozen image");
  alpha.resources[gitKnowledgeResourceKey(repository, "main", "docs/B/image.png", revision)] = { digest: hash(image), content_type: "image/png" };
  mkdirSync(join(dir, "knowledge-git", "resources"), { recursive: true });
  writeFileSync(join(dir, "knowledge-git", "resources", `${hash(image)}.b64`), image.toString("base64"));
  writeGitKnowledgeSnapshot(dir, alpha); writeGitKnowledgeSnapshot(dir, beta);
  const exclude = (moduleId: string, paths: string[]) => updateBusinessModule(dir, moduleId,
    { repository_knowledge_exclusions: paths.length ? [{ repository, paths }] : [] }, "fixture");
  const context = (moduleId: string) => ({ repo: "shared", repositories: [repository], moduleIds: [moduleId] });
  return { dir, paths, snapshot, alpha, beta, image, exclude, context };
}

test("完整仓快照按当前模块独立排除目录，正文、轻量目录和问答范围一致且不会跨模块", t => {
  const f = setup(t);
  f.exclude("alpha", ["docs/B"]);
  f.exclude("beta", ["docs/A"]);
  const full = listGitKnowledgeDocuments(f.dir), metadata = listGitKnowledgeDocumentMetadata(f.dir);
  assert.deepEqual(full.map(({ content: _content, ...document }) => document),
    metadata.map(({ lines: _lines, ...document }) => document));
  assert.deepEqual(readGitKnowledgeDocument(f.dir, id("docs/A/guide.md")).module_ids, ["alpha"]);
  assert.deepEqual(readGitKnowledgeDocument(f.dir, id("docs/B/guide.md")).module_ids, ["beta"]);
  assert.deepEqual(readGitKnowledgeDocument(f.dir, id("docs/AB/deep/guide.md")).module_ids, ["alpha", "beta"], "目录前缀按路径边界匹配");
  assert.deepEqual(readGitKnowledgeDocument(f.dir, id("AGENTS.md")).module_ids, ["alpha", "beta"]);
  const search = new KnowledgeSearch(f.dir);
  assert.equal(search.read(f.context("alpha"), id("docs/B/guide.md")), undefined);
  assert.ok(search.read(f.context("beta"), id("docs/B/guide.md")));
  assert.ok(!collectSearchableKnowledge(f.dir, f.context("beta")).assets.some(document => document.id === id("docs/A/guide.md")));
});

test("排除与取消排除立即生效，不改已有快照，不需重新同步，阅读版本和模块正文摘要随之更新", t => {
  const f = setup(t), source = join(f.dir, "knowledge-git", "modules", `${hash("alpha")}.json`), original = readFileSync(source, "utf8");
  const viewBefore = knowledgeDocumentReadRevision(f.dir), alphaBefore = readModuleKnowledgeContentRevision(f.dir, "alpha");
  const betaBefore = readModuleKnowledgeContentRevision(f.dir, "beta");
  const count = (moduleId: string) => listGitKnowledgeDocumentMetadata(f.dir).filter(document => document.module_ids.includes(moduleId)).length;
  assert.equal(count("alpha"), 4); assert.equal(count("beta"), 4);
  f.exclude("alpha", ["docs/B"]);
  assert.equal(count("alpha"), 3); assert.equal(count("beta"), 4);
  assert.notEqual(knowledgeDocumentReadRevision(f.dir), viewBefore);
  assert.notEqual(readModuleKnowledgeContentRevision(f.dir, "alpha"), alphaBefore);
  assert.equal(readModuleKnowledgeContentRevision(f.dir, "beta"), betaBefore);
  assert.equal(readFileSync(source, "utf8"), original);
  f.exclude("alpha", []);
  assert.equal(count("alpha"), 4); assert.equal(count("beta"), 4);
  assert.equal(readModuleKnowledgeContentRevision(f.dir, "alpha"), alphaBefore);
  assert.deepEqual(readGitKnowledgeDocument(f.dir, id("docs/B/guide.md")).module_ids, ["alpha", "beta"]);
  assert.ok(new KnowledgeSearch(f.dir).read(f.context("alpha"), id("docs/B/guide.md")));
  assert.equal(readFileSync(source, "utf8"), original);
  const beforeEmptyFolder = knowledgeDocumentReadRevision(f.dir);
  f.exclude("alpha", ["docs/not-yet-created"]);
  assert.notEqual(knowledgeDocumentReadRevision(f.dir), beforeEmptyFolder, "暂无文档的筛选配置也参与页面刷新版本");
});

test("先选公共仓最新完整快照，再投影模块范围；持有新快照的模块排除目录不影响其他模块读取与删除", t => {
  const f = setup(t);
  f.exclude("alpha", ["docs/B"]);
  const latest = f.snapshot("alpha", "b".repeat(40), "2026-10-22T02:00:00.000Z");
  latest.documents.find(document => document.id === id("docs/B/guide.md"))!.content = "共享仓最新正文";
  writeGitKnowledgeSnapshot(f.dir, latest);
  const selected = readGitKnowledgeDocument(f.dir, id("docs/B/guide.md"));
  assert.equal(selected.content, "共享仓最新正文");
  assert.deepEqual(selected.module_ids, ["beta"], "不能先按快照所属模块排除，再选最新版本");
  const deleted = f.snapshot("alpha", "c".repeat(40), "2026-10-22T03:00:00.000Z");
  deleted.documents = deleted.documents.filter(document => document.id !== id("docs/B/guide.md"));
  writeGitKnowledgeSnapshot(f.dir, deleted);
  assert.ok(!listGitKnowledgeDocumentMetadata(f.dir).some(document => document.id === id("docs/B/guide.md")));
  assert.throws(() => readGitKnowledgeDocument(f.dir, id("docs/B/guide.md")), /不存在|删除/);
});

test("全部模块排除时不再提供该正式文稿及资源，已冻结任务图片继续可读，根导航始终保留", t => {
  const f = setup(t), document = readGitKnowledgeDocument(f.dir, id("docs/B/guide.md"));
  const frozen = freezeGitKnowledgeResources(f.dir, [document]);
  assert.deepEqual(readGitKnowledgeResource(f.dir, document.id, "image.png")?.content, f.image);
  f.exclude("alpha", ["docs"]); f.exclude("beta", ["docs"]);
  assert.deepEqual(listGitKnowledgeDocumentMetadata(f.dir).map(document => document.source!.path), ["AGENTS.md"]);
  assert.throws(() => readGitKnowledgeDocument(f.dir, document.id), /不存在|删除/);
  assert.equal(readGitKnowledgeResource(f.dir, document.id, "image.png"), undefined);
  assert.throws(() => freezeGitKnowledgeResources(f.dir, [document]), /版本已变化/);
  assert.deepEqual(readFrozenGitKnowledgeResource(f.dir, frozen[document.id], "image.png")?.content, f.image);
  f.exclude("beta", []);
  assert.deepEqual(readGitKnowledgeResource(f.dir, document.id, "image.png")?.content, f.image);
});

test("筛选包含 docs 根下和嵌套文档，使用未排除的轻量索引，空仓保留 docs 根且不读取整库正文", t => {
  const f = setup(t, ["docs/README.md"]), empty = "https://example.test/empty.git";
  updateBusinessModule(f.dir, "alpha", { repositories: [repository, empty] }, "fixture");
  f.exclude("alpha", ["docs"]); f.exclude("beta", ["docs"]);
  const original = fs.readFileSync;
  fs.readFileSync = ((...args: any[]) => {
    assert.ok(!String(args[0]).includes("/knowledge-git/modules/"), "目录选择不能读取正式快照全部正文");
    return (original as any)(...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(listModuleRepositoryKnowledgePaths(f.dir, "alpha"), [
      { repository, directories: ["docs", "docs/A", "docs/AB", "docs/AB/deep", "docs/B"],
        files: ["docs/A/guide.md", "docs/AB/deep/guide.md", "docs/B/guide.md", "docs/README.md"] },
      { repository: empty, directories: ["docs"], files: [] },
    ]);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test("单篇文件可排除和恢复，正文列表、计数与问答一致，同目录其他文件和其他模块不受影响", t => {
  const f = setup(t, ["docs/README.md", "docs/README.md.backup.md", "docs/B/second.md"]);
  const count = (moduleId: string) => listGitKnowledgeDocumentMetadata(f.dir).filter(document => document.module_ids.includes(moduleId)).length;
  const search = new KnowledgeSearch(f.dir), rootFile = id("docs/README.md"), nestedFile = id("docs/B/guide.md");
  const options = listModuleRepositoryKnowledgePaths(f.dir, "alpha");
  f.exclude("alpha", ["docs/README.md", "docs/B/guide.md"]);
  assert.equal(count("alpha"), f.paths.length - 2);
  assert.equal(count("beta"), f.paths.length);
  for (const documentId of [rootFile, nestedFile]) {
    assert.deepEqual(readGitKnowledgeDocument(f.dir, documentId).module_ids, ["beta"]);
    assert.equal(search.read(f.context("alpha"), documentId), undefined);
    assert.ok(search.read(f.context("beta"), documentId));
  }
  for (const path of ["docs/README.md.backup.md", "docs/B/second.md", "AGENTS.md"]) {
    assert.ok(search.read(f.context("alpha"), id(path)), `${path} 仍在当前模块范围内`);
  }
  assert.deepEqual(listModuleRepositoryKnowledgePaths(f.dir, "alpha"), options, "排除后仍保留所有候选文件供恢复");
  f.exclude("alpha", []);
  assert.equal(count("alpha"), f.paths.length);
  assert.ok(search.read(f.context("alpha"), rootFile));
  assert.ok(search.read(f.context("alpha"), nestedFile));
});

test("已有向量索引不需重建即可按当前模块排除旧命中，取消排除立即恢复检索", async t => {
  const f = setup(t), requested: string[][] = [];
  let ingested = 0;
  const search = new KnowledgeSearch(f.dir, {
    ingest: async () => { ingested++; return true; },
    search: async ({ sources }: { sources: Array<{ id: string; path: string }> }) => {
      requested.push(sources.map(source => source.id));
      // 即使向量服务残留其他模块的旧命中，服务端仍须重新核对当前适用范围。
      const source = sources.find(source => source.id === id("docs/B/guide.md"));
      const first = source ? readFileSync(source.path, "utf8").split("\n").lastIndexOf("# docs/B/guide.md") + 1 : 20;
      return [{ id: id("docs/B/guide.md"), snippet: "B 规则", start_line: first, end_line: first + 2 }];
    },
  } as any);
  await search.prepare();
  const before = ingested;
  f.exclude("alpha", ["docs/B"]);
  assert.deepEqual((await search.searchDocuments(f.context("alpha"), "B 规则")).hits, []);
  assert.ok(!requested.at(-1)!.includes(id("docs/B/guide.md")));
  f.exclude("alpha", []);
  assert.equal((await search.searchDocuments(f.context("alpha"), "B 规则")).hits[0]?.id, id("docs/B/guide.md"));
  assert.ok(requested.at(-1)!.includes(id("docs/B/guide.md")));
  assert.equal(ingested, before, "模块筛选即时校验，正文没变时无需重算向量");
});
