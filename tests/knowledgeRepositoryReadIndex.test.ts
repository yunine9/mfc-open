import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";
import type { KnowledgeDocument } from "../src/knowledgeDocuments.ts";
import {
  gitKnowledgeResourceKey, listGitKnowledgeDocumentMetadata, readGitKnowledgeDocument, readGitKnowledgeResource,
  readModuleKnowledgeContentRevision, readModuleKnowledgeSync, writeGitKnowledgeSnapshot, writeModuleKnowledgeSync, type GitKnowledgeSnapshot,
} from "../src/knowledgeRepositorySnapshots.ts";

const repository = "https://example.test/domain.git", codeRepository = "https://example.test/shared.git";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const at = "2026-10-20T10:00:00.000Z";
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-read-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  saveKnowledgeRepoConfig(dir, repository, { branch: "main" });
  return dir;
}
function snapshot(dir: string, moduleId: string, count = 1, size = 100): GitKnowledgeSnapshot {
  createBusinessModule(dir, { id: moduleId, name: moduleId, owner: "fixture", repositories: [codeRepository],
    description: "阅读索引测试", knowledge_path: `domains/${moduleId}` }, "fixture");
  return { module_id: moduleId, location: { repository, branch: "main", docs_path: `domains/${moduleId}` },
    synced_at: at, resources: {}, repositories: [{ repository, branch: "main", revision: "a".repeat(40), scope: "module", synced_at: at }],
    documents: Array.from({ length: count }, (_,number): KnowledgeDocument => ({
      id: `kg-${hash(`${moduleId}/${number}`)}`, title: `Document ${number}`, content: `# 文档 ${number}\n${"a".repeat(size)}\n`,
      scope: "module", module_ids: [moduleId], repositories: [], technologies: [], product_versions: [], when_to_use: "", active: true,
      revision: hash(`${moduleId}/${number}/revision`), source: { repository, branch: "main", path: `domains/${moduleId}/${number}.md`, revision: "a".repeat(40) },
      history: [{ at, action: "从正式分支同步", operator: "fixture" }],
    })),
  };
}
function trackReads<T>(operation: () => T) {
  const originalRead = fs.readFileSync, originalRange = fs.readSync;
  let snapshots = 0, snapshotBytes = 0, bodyBytes = 0;
  fs.readFileSync = ((...args: any[]) => {
    const value = (originalRead as any)(...args);
    if (String(args[0]).includes("/knowledge-git/modules/")) { snapshots++; snapshotBytes += Buffer.byteLength(value); }
    return value;
  }) as typeof fs.readFileSync;
  fs.readSync = ((...args: any[]) => {
    const bytes = (originalRange as any)(...args); bodyBytes += bytes; return bytes;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { return { value: operation(), snapshots, snapshotBytes, bodyBytes }; }
  finally { fs.readFileSync = originalRead; fs.readSync = originalRange; syncBuiltinESMExports(); }
}

test("超过 32 MiB 的多模块目录与单篇阅读不会重读全库正文，图片读取不读 Markdown", t => {
  const dir = setup(t), snapshots: GitKnowledgeSnapshot[] = [];
  for (let i = 0; i < 6; i++) snapshots.push(snapshot(dir, `module-${i}`, 200, 32 * 1024));
  const target = snapshots[0].documents[0], image = Buffer.from("fixture image"), resourcePath = "domains/module-0/diagram.png";
  target.content += "![状态](diagram.png)";
  snapshots[0].resources[gitKnowledgeResourceKey(repository, "main", resourcePath, target.source!.revision)] = { digest: hash(image), content_type: "image/png" };
  mkdirSync(join(dir, "knowledge-git", "resources"), { recursive: true });
  writeFileSync(join(dir, "knowledge-git", "resources", `${hash(image)}.b64`), image.toString("base64"));
  for (const value of snapshots) writeGitKnowledgeSnapshot(dir, value);
  for (let run = 0; run < 2; run++) {
    const metadata = trackReads(() => listGitKnowledgeDocumentMetadata(dir));
    assert.equal(metadata.value.length, 1200);
    assert.equal(metadata.snapshots, 0);
    assert.equal(metadata.bodyBytes, 0);
    assert.ok(metadata.value.every(document => !("content" in document)));
    assert.equal(metadata.value.find(document => document.id === target.id)?.lines, 3);
    const document = trackReads(() => readGitKnowledgeDocument(dir, target.id));
    assert.deepEqual(document.value, target);
    assert.equal(document.snapshots, 0);
    assert.equal(document.bodyBytes, Buffer.byteLength(target.content), "只读取选中文档的正文范围");
    const resource = trackReads(() => readGitKnowledgeResource(dir, target.id, "diagram.png"));
    assert.deepEqual(resource.value?.content, image);
    assert.equal(resource.snapshots, 0); assert.equal(resource.bodyBytes, 0);
  }
});

test("旧快照首次建立阅读索引，随后仅读摘要；派生正文与索引损坏均可从原快照恢复", t => {
  const dir = setup(t), value = snapshot(dir, "legacy", 200, 96 * 1024);
  const sourceDirectory = join(dir, "knowledge-git", "modules");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(join(sourceDirectory, `${hash(value.module_id)}.json`), JSON.stringify(value));
  const first = trackReads(() => listGitKnowledgeDocumentMetadata(dir));
  assert.equal(first.snapshots, 1); assert.ok(first.snapshotBytes > 16 * 1024 * 1024);
  assert.equal(trackReads(() => listGitKnowledgeDocumentMetadata(dir)).snapshots, 0);
  const root = join(dir, "knowledge-git", "read-cache", hash(value.module_id));
  const generation = () => join(root, readdirSync(root)[0]);
  const savedIndex = join(generation(), "index.json");
  writeFileSync(savedIndex, `${readFileSync(savedIndex, "utf8")}\n`);
  const persistent = trackReads(() => listGitKnowledgeDocumentMetadata(dir));
  assert.equal(persistent.value.length, 200);
  assert.equal(persistent.snapshots, 0, "内存缓存未命中时，只解析持久索引，不重读正式正文");
  writeFileSync(join(generation(), "contents.bin"), "truncated");
  assert.deepEqual(readGitKnowledgeDocument(dir, value.documents[1].id), value.documents[1]);
  writeFileSync(join(generation(), "index.json"), "{invalid");
  assert.equal(listGitKnowledgeDocumentMetadata(dir).length, 200);
  assert.equal(trackReads(() => readGitKnowledgeDocument(dir, value.documents[2].id)).snapshots, 0);
  const revised = { ...value, synced_at: "2026-10-20T11:00:00.000Z", documents: [{ ...value.documents[0], title: "修改后的标题", content: "修改后的正文" }] };
  writeGitKnowledgeSnapshot(dir, revised);
  assert.deepEqual(readGitKnowledgeDocument(dir, value.documents[0].id), revised.documents[0]);
  assert.equal(readdirSync(root).length, 1, "只保留当前快照的派生正文，不积累旧版本");
});

test("轻量目录与定点读取遵守公共仓最新删除、模块停用和目录配置变化", t => {
  const dir = setup(t), old = snapshot(dir, "module-a"), newer = snapshot(dir, "module-b");
  const shared: KnowledgeDocument = { ...old.documents[0], id: `kg-${hash("shared")}`, scope: "repository", module_ids: [],
    repositories: [codeRepository], source: { repository: codeRepository, branch: "main", path: "docs/shared.md", revision: "a".repeat(40) } };
  old.documents.push(shared);
  old.repositories.push({ repository: codeRepository, branch: "main", revision: "a".repeat(40), scope: "repository", synced_at: at });
  newer.synced_at = "2026-10-20T11:00:00.000Z";
  newer.repositories.push({ repository: codeRepository, branch: "main", revision: "b".repeat(40), scope: "repository", synced_at: newer.synced_at });
  writeGitKnowledgeSnapshot(dir, old);
  assert.equal(readGitKnowledgeDocument(dir, shared.id).content, shared.content);
  writeGitKnowledgeSnapshot(dir, newer);
  assert.ok(!listGitKnowledgeDocumentMetadata(dir).some(document => document.id === shared.id));
  assert.throws(() => readGitKnowledgeDocument(dir, shared.id), /不存在|删除/);
  updateBusinessModule(dir, "module-a", { status: "archived" }, "fixture");
  assert.equal(listGitKnowledgeDocumentMetadata(dir).length, 1);
  updateBusinessModule(dir, "module-b", { knowledge_path: "domains/moved" }, "fixture");
  assert.equal(listGitKnowledgeDocumentMetadata(dir).length, 0);
});

test("正文索引摘要忽略同步时间与无关源码提交，实际知识版本变化才改变", t => {
  const dir = setup(t), value = snapshot(dir, "stable");
  writeGitKnowledgeSnapshot(dir, value);
  const before = readModuleKnowledgeContentRevision(dir, value.module_id);
  const unrelated = { ...value, synced_at: "2026-10-20T11:00:00.000Z",
    repositories: value.repositories.map(repository => ({ ...repository, revision: "b".repeat(40) })),
    documents: value.documents.map(document => ({ ...document, source: { ...document.source!, revision: "b".repeat(40) } })) };
  writeGitKnowledgeSnapshot(dir, unrelated);
  assert.equal(readModuleKnowledgeContentRevision(dir, value.module_id), before);
  writeGitKnowledgeSnapshot(dir, { ...unrelated, documents: unrelated.documents.map(document => ({ ...document, revision: hash("updated"), content: "更新正文" })) });
  assert.notEqual(readModuleKnowledgeContentRevision(dir, value.module_id), before);
});

test("阅读缓存目录不可写时，正式快照仍成功保存且目录、正文和同步状态继续可读", t => {
  const dir = setup(t), value = snapshot(dir, "blocked-cache");
  const cache = join(dir, "knowledge-git", "read-cache");
  mkdirSync(join(dir, "knowledge-git"), { recursive: true });
  writeFileSync(cache, "ordinary file blocks cache directories");
  assert.doesNotThrow(() => writeGitKnowledgeSnapshot(dir, value));
  writeModuleKnowledgeSync(dir, { module_id: value.module_id, location: value.location, state: "ready", attempted_at: at,
    synced_at: at, document_count: value.documents.length, repositories: value.repositories });
  assert.equal(listGitKnowledgeDocumentMetadata(dir).length, 1);
  assert.deepEqual(readGitKnowledgeDocument(dir, value.documents[0].id), value.documents[0]);
  assert.equal(readModuleKnowledgeSync(dir, value.module_id)?.state, "ready");
  const updated = { ...value, documents: [{ ...value.documents[0], content: "缓存不可写时的新正文", revision: hash("next") }] };
  assert.doesNotThrow(() => writeGitKnowledgeSnapshot(dir, updated));
  assert.deepEqual(readGitKnowledgeDocument(dir, updated.documents[0].id), updated.documents[0]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "knowledge-git", "modules", `${hash(value.module_id)}.json`), "utf8")), updated,
    "加速缓存故障不能回滚或覆盖已成功保存的正式快照");
  rmSync(cache);
  assert.equal(listGitKnowledgeDocumentMetadata(dir).length, 1, "缓存目录恢复后可以自动重建");
  assert.equal(trackReads(() => readGitKnowledgeDocument(dir, updated.documents[0].id)).snapshots, 0);
});
