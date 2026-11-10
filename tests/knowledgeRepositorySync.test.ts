import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createBusinessModule, updateBusinessModule, publishBusinessKnowledgeAsset, readBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import { listFormalKnowledgeDocuments, readKnowledgeDocument, readKnowledgeDocumentFacts, saveKnowledgeDocument, listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { collectSearchableKnowledge } from "../src/knowledgeSearch.ts";
import { knowledgeDocumentCatalog, knowledgeDocumentReadRevision } from "../src/knowledgeDocumentCatalog.ts";
import { syncModuleKnowledge, readModuleKnowledgeSync, readGitKnowledgeResource } from "../src/knowledgeRepositorySync.ts";
import { readGitKnowledgeSnapshot, writeModuleKnowledgeSync, freezeGitKnowledgeResources, readFrozenGitKnowledgeResource, type FrozenGitKnowledgeResources } from "../src/knowledgeRepositorySnapshots.ts";
import { saveKnowledgeRepoConfig, clearKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-git-"));
  const dataDir = join(root, "data"), knowledge = join(root, "knowledge"), code = join(root, "code");
  const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (repo: string, path: string, content: string | Buffer) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  const commit = (repo: string) => { git(repo, "add", "-A"); git(repo, "commit", "-qm", "fixture"); return git(repo, "rev-parse", "HEAD"); };
  for (const repo of [knowledge, code]) { mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test"); }
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0, 128]);
  put(knowledge, "domains/orders/README.md", "# 订单领域\n\n正式交易规则\n\n![状态](images/state.png)\n");
  put(knowledge, "domains/orders/images/state.png", image);
  put(knowledge, "domains/stock/README.md", "# 库存领域\n\n库存规则\n");
  put(knowledge, "private/not-knowledge.md", "# 不应读取\n其他团队资料\n");
  put(code, "AGENTS.md", "# 仓库导航\n\n见 docs/architecture.md\n");
  put(code, "docs/architecture.md", "# 公共架构\n\n共享代码仓规则\n");
  put(code, "src/hidden.md", "# 代码内容不作为正式知识\n");
  const revision = commit(knowledge); commit(code);
  const location = (path: string) => ({ repository: knowledge, branch: "main", docs_path: path });
  saveKnowledgeRepoConfig(dataDir, knowledge, { branch: "main" });
  for (const [id, path] of [["orders", "domains/orders"], ["stock", "domains/stock"]]) createBusinessModule(dataDir, {
    id, name: id, description: `${id} module`, owner: "owner", repositories: [code], knowledge_path: path,
  }, "owner");
  return { root, dataDir, knowledge, code, git, put, commit, image, revision, location, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Git 正式分支独立建库，限定领域目录，公共仓文档保留仓级作用域并跨模块去重", async () => {
  const f = fixture();
  try {
    const old = saveKnowledgeDocument(f.dataDir, { title: "旧任务文稿", content: "尚未合入的内容", scope: "module", module_ids: ["orders"] }, "owner");
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 0, "保存绑定后不能把旧任务的发布记录当作远端知识");
    const synced = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.equal(synced.state, "ready", synced.error); assert.equal(synced.commit, f.revision);
    assert.equal(synced.document_count, 3);
    const documents = listFormalKnowledgeDocuments(f.dataDir);
    assert.equal(documents.length, 3); assert.equal(listKnowledgeDocuments(f.dataDir)[0].id, old.id, "旧任务成果没有被删除");
    const domain = documents.find(document => document.scope === "module")!;
    assert.deepEqual(domain.module_ids, ["orders"]); assert.match(domain.content, /正式交易规则/);
    assert.deepEqual(readKnowledgeDocument(f.dataDir, domain.id), domain);
    assert.deepEqual(readGitKnowledgeResource(f.dataDir, domain.id, "images/state.png")?.content, f.image);
    assert.equal(readGitKnowledgeResource(f.dataDir, domain.id, "../../../../etc/passwd"), undefined);
    assert.equal(readGitKnowledgeResource(f.dataDir, domain.id, "%2Fetc/passwd"), undefined);
    for (const document of documents.filter(document => document.scope === "repository")) {
      assert.deepEqual(document.module_ids, ["orders", "stock"]); assert.deepEqual(document.repositories, [f.code]);
      assert.ok(["AGENTS.md", "docs/architecture.md"].includes(document.source!.path));
      assert.equal(document.source!.branch, "main");
    }
    assert.equal((await syncModuleKnowledge(f.dataDir, "stock", "owner")).state, "ready");
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 4, "共享代码仓的两篇文档只显示一份");
    const selected = collectSearchableKnowledge(f.dataDir, { repo: "code", repositories: [f.code], moduleIds: ["orders"] });
    assert.equal(selected.assets.length, 3); assert.ok(!selected.assets.some(asset => /库存规则|尚未合入/.test(asset.content)));
    assert.equal(knowledgeDocumentCatalog(f.dataDir).documents.length, 4);
  } finally { f.cleanup(); }
});

test("固定正式分支提交，增改删原子切换；失败保留上次快照，恢复后继续同步", async () => {
  const f = fixture();
  try {
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "ready");
    const original = listFormalKnowledgeDocuments(f.dataDir).find(document => document.scope === "module")!;
    const initialReading = knowledgeDocumentReadRevision(f.dataDir);
    f.git(f.knowledge, "checkout", "-qb", "candidate");
    f.put(f.knowledge, "domains/orders/README.md", "# 未合入草稿\n不能进入正式问答\n"); f.commit(f.knowledge);
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "ready");
    assert.equal(readKnowledgeDocument(f.dataDir, original.id).content, original.content);
    assert.equal(knowledgeDocumentReadRevision(f.dataDir), initialReading, "未合入分支不触发正式阅读刷新");
    f.git(f.knowledge, "checkout", "-q", "main");
    f.put(f.knowledge, "domains/orders/README.md", "# 订单领域\n合入后的新规则\n");
    f.put(f.knowledge, "domains/orders/rules.md", "# 新增规则\n新文件\n");
    const updatedRevision = f.commit(f.knowledge);
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).commit, updatedRevision);
    const updatedReading = knowledgeDocumentReadRevision(f.dataDir);
    assert.notEqual(updatedReading, initialReading, "正式分支更新后阅读版本随同步改变");
    assert.equal(readKnowledgeDocument(f.dataDir, original.id).id, original.id); assert.match(readKnowledgeDocument(f.dataDir, original.id).content, /合入后的新规则/);
    const newDoc = listFormalKnowledgeDocuments(f.dataDir).find(document => document.source?.path.endsWith("rules.md"))!;
    f.git(f.knowledge, "rm", "-q", "domains/orders/rules.md"); f.commit(f.knowledge);
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "ready");
    assert.throws(() => readKnowledgeDocument(f.dataDir, newDoc.id), /不存在|删除/);
    const afterDeletion = knowledgeDocumentReadRevision(f.dataDir);
    assert.notEqual(afterDeletion, updatedReading);
    const successful = readModuleKnowledgeSync(f.dataDir, "orders")!;
    f.git(f.knowledge, "branch", "-m", "main", "moved");
    const failed = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.equal(failed.state, "partial"); assert.equal(failed.synced_at, successful.synced_at); assert.equal(failed.commit, successful.commit);
    assert.ok(failed.warnings?.some(warning => warning.includes("领域目录")));
    assert.match(readKnowledgeDocument(f.dataDir, original.id).content, /合入后的新规则/);
    assert.equal(knowledgeDocumentReadRevision(f.dataDir), afterDeletion, "同步失败保留上次成功阅读版本");
    f.git(f.knowledge, "branch", "-m", "moved", "main");
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "ready");
  } finally { f.cleanup(); }
});

test("关联公共仓不可达不阻塞领域目录；保留该仓上次文档，恢复后删除同步不会被其他模块旧快照复活", async () => {
  const f = fixture();
  try {
    renameSync(f.code, `${f.code}-offline`);
    const first = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.equal(first.state, "partial"); assert.equal(first.document_count, 1);
    assert.match(listFormalKnowledgeDocuments(f.dataDir)[0].content, /正式交易规则/);
    renameSync(`${f.code}-offline`, f.code);
    await syncModuleKnowledge(f.dataDir, "orders", "owner"); await syncModuleKnowledge(f.dataDir, "stock", "owner");
    const repoDoc = listFormalKnowledgeDocuments(f.dataDir).find(document => document.source?.path === "docs/architecture.md")!;
    renameSync(f.code, `${f.code}-offline`);
    f.put(f.knowledge, "domains/orders/README.md", "# 订单领域\n公共仓离线时更新领域规则\n"); f.commit(f.knowledge);
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "partial");
    assert.ok(listFormalKnowledgeDocuments(f.dataDir).some(document => document.id === repoDoc.id));
    assert.match(listFormalKnowledgeDocuments(f.dataDir).find(document => document.scope === "module" && document.module_ids.includes("orders"))!.content, /公共仓离线时更新/);
    renameSync(`${f.code}-offline`, f.code);
    f.git(f.code, "rm", "-q", "docs/architecture.md"); f.commit(f.code);
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "ready");
    assert.ok(!listFormalKnowledgeDocuments(f.dataDir).some(document => document.id === repoDoc.id), "库存模块旧快照不能复活公共仓已删除文件");
  } finally { f.cleanup(); }
});

test("未配置领域目录也不退回本地业务正文；原记录保留，Skill 原生目录不受影响", () => {
  const f = fixture();
  try {
    clearKnowledgeRepoConfig(f.dataDir);
    createBusinessModule(f.dataDir, { id: "unconfigured", name: "未配置", description: "未绑定来源", owner: "owner", repositories: [f.code] }, "owner");
    const candidate = saveKnowledgeDocument(f.dataDir, { title: "旧萃取文稿", content: "尚未合入", scope: "module", module_ids: ["unconfigured"],
      research_source: { job_id: "dkx-old" } }, "owner");
    const manual = saveKnowledgeDocument(f.dataDir, { title: "旧本地模块文档", content: "本地发布不能代替 Git 合入", scope: "module", module_ids: ["unconfigured"] }, "owner");
    publishBusinessKnowledgeAsset(f.dataDir, "unconfigured", { id: "legacy", title: "原生旧模块文档", summary: "旧正文", when_to_use: "查询时", content: "旧模块资产尚未上库" }, "owner");
    publishBusinessKnowledgeAsset(f.dataDir, "unconfigured", { id: "check", title: "检视技能", summary: "原生技能", when_to_use: "检视时", form: "skill", content: "# 检视技能\n按需读取正文。" }, "owner");
    const legacyIds = new Set([candidate.id, manual.id, "module:unconfigured:legacy"]);
    assert.ok(listKnowledgeDocuments(f.dataDir).some(document => document.id === candidate.id));
    assert.equal(readKnowledgeDocument(f.dataDir, manual.id).content, manual.content);
    assert.equal(readBusinessKnowledgeAsset(f.dataDir, "unconfigured", "legacy").content, "旧模块资产尚未上库");
    assert.ok(!listFormalKnowledgeDocuments(f.dataDir).some(document => legacyIds.has(document.id)));
    assert.ok(!collectSearchableKnowledge(f.dataDir, { repo: "code", repositories: [f.code], moduleIds: ["unconfigured"] }).assets.some(asset => legacyIds.has(asset.id)));
    const catalog = knowledgeDocumentCatalog(f.dataDir).documents;
    assert.ok(!catalog.some(document => legacyIds.has(document.id)));
    assert.equal(catalog.find(document => document.id === "module:unconfigured:check")?.form, "skill");
  } finally { f.cleanup(); }
});

test("目录绑定修改后不显示旧目录；取消同步不会清空已有正式知识", async () => {
  const f = fixture();
  try {
    await syncModuleKnowledge(f.dataDir, "orders", "owner");
    const before = listFormalKnowledgeDocuments(f.dataDir).map(document => document.id);
    const abort = new AbortController(); abort.abort();
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner", { signal: abort.signal })).state, "failed");
    assert.deepEqual(listFormalKnowledgeDocuments(f.dataDir).map(document => document.id), before);
    updateBusinessModule(f.dataDir, "orders", { knowledge_path: "new/orders" }, "owner");
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 0);
    assert.equal(readModuleKnowledgeSync(f.dataDir, "orders"), undefined);
    assert.equal((await syncModuleKnowledge(f.dataDir, "orders", "owner")).state, "ready");
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).filter(document => document.scope === "module").length, 0);
  } finally { f.cleanup(); }
});

test("提交未变复用原快照；进程中断的同步状态明确提示可重试", async () => {
  const f = fixture();
  try {
    const first = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    const snapshot = readGitKnowledgeSnapshot(f.dataDir, "orders");
    const next = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.equal(next.state, "ready"); assert.equal(next.synced_at, first.synced_at);
    assert.strictEqual(readGitKnowledgeSnapshot(f.dataDir, "orders"), snapshot, "原快照文件不重写，不重新读正文和图片");
    writeModuleKnowledgeSync(f.dataDir, { ...next, state: "syncing" });
    const interrupted = readModuleKnowledgeSync(f.dataDir, "orders")!;
    assert.equal(interrupted.state, "failed"); assert.match(interrupted.error!, /中断/);
    assert.equal(interrupted.synced_at, first.synced_at);
  } finally { f.cleanup(); }
});

test("仓库正式摘要使用 Git 编号，不误报为本地知识文件损坏", async () => {
  const f = fixture();
  try {
    await syncModuleKnowledge(f.dataDir, "orders", "owner");
    const document = listFormalKnowledgeDocuments(f.dataDir).find(document => document.scope === "module")!;
    assert.deepEqual(readKnowledgeDocumentFacts(f.dataDir, document.id), { id: document.id, revision: document.revision });
  } finally { f.cleanup(); }
});

test("领域目录与代码仓在同一物理仓的不同分支时，各自读取正确正式版本", async () => {
  const f = fixture();
  try {
    f.git(f.code, "checkout", "-qb", "knowledge");
    f.put(f.code, "domains/orders/README.md", "# 订单领域\n领域独立分支的正式规则\n");
    f.put(f.code, "docs/architecture.md", "# 非仓级正式内容\n此分支不能作为代码仓正式知识\n");
    const knowledgeRevision = f.commit(f.code);
    f.git(f.code, "checkout", "-q", "main");
    const codeRevision = f.git(f.code, "rev-parse", "HEAD");
    saveKnowledgeRepoConfig(f.dataDir, f.code, { branch: "knowledge" });
    updateBusinessModule(f.dataDir, "orders", { knowledge_path: "domains/orders" }, "owner");
    const result = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.equal(result.state, "ready", result.error); assert.equal(result.commit, knowledgeRevision);
    const documents = listFormalKnowledgeDocuments(f.dataDir);
    const domain = documents.find(document => document.scope === "module")!;
    const code = documents.find(document => document.source?.path === "docs/architecture.md")!;
    assert.equal(domain.source?.branch, "knowledge"); assert.equal(domain.source?.revision, knowledgeRevision);
    assert.equal(code.source?.branch, "main"); assert.equal(code.source?.revision, codeRevision); assert.match(code.content, /共享代码仓规则/);
    assert.equal(result.repositories?.find(source => source.scope === "repository")?.branch, "main");
  } finally { f.cleanup(); }
});

test("损坏的同步记录与正式快照明确报错，保留原文件后可从真实 Git 重建", async () => {
  const f = fixture();
  try {
    await syncModuleKnowledge(f.dataDir, "orders", "owner");
    const root = join(f.dataDir, "knowledge-git"), key = createHash("sha256").update("orders").digest("hex");
    const brokenStatus = "{broken status", brokenSnapshot = JSON.stringify({ module_id: "orders", location: f.location("domains/orders"), documents: "broken snapshot" });
    writeFileSync(join(root, "status", `${key}.json`), brokenStatus);
    writeFileSync(join(root, "modules", `${key}.json`), brokenSnapshot);
    const diagnostic = readModuleKnowledgeSync(f.dataDir, "orders")!;
    assert.equal(diagnostic.state, "failed"); assert.match(diagnostic.error!, /损坏.*重建/);
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 0);
    const recovered = await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.equal(recovered.state, "ready", recovered.error); assert.equal(recovered.commit, f.revision);
    assert.equal(listFormalKnowledgeDocuments(f.dataDir).length, 3);
    for (const [folder, content] of [["status", brokenStatus], ["modules", brokenSnapshot]]) {
      const backup = readdirSync(join(root, folder)).find(name => name.startsWith(`${key}.json.corrupt-`));
      assert.ok(backup, `${folder} 的损坏记录必须保留`); assert.equal(readFileSync(join(root, folder, backup), "utf8"), content);
    }
  } finally { f.cleanup(); }
});

test("独立检视冻结原提交图片引用，后台同步和快照替换不改变任务图片", async () => {
  const f = fixture();
  try {
    f.put(f.knowledge, "domains/orders/other.md", "# 其他文稿\n\n![其他图](images/other.png)\n");
    f.put(f.knowledge, "domains/orders/images/other.png", Buffer.from([137, 80, 78, 71, 42]));
    const originalCommit = f.commit(f.knowledge);
    await syncModuleKnowledge(f.dataDir, "orders", "owner");
    const documents = listFormalKnowledgeDocuments(f.dataDir).filter(document => document.scope === "module");
    const document = documents.find(document => document.source?.path.endsWith("/README.md"))!;
    const frozen = JSON.parse(JSON.stringify(freezeGitKnowledgeResources(f.dataDir, documents))) as FrozenGitKnowledgeResources;
    assert.equal(frozen[document.id].source.path, document.source?.path);
    assert.equal(frozen[document.id].source.revision, originalCommit);
    assert.deepEqual(Object.keys(frozen[document.id].resources), ["domains/orders/images/state.png"]);
    assert.equal(Object.values(frozen).reduce((sum, refs) => sum + Object.keys(refs.resources).length, 0), 2, "每篇只冻结自身引用，不能重复收集同仓全部图片");
    assert.equal(readFrozenGitKnowledgeResource(f.dataDir, frozen[document.id], "images/other.png"), undefined);
    const updatedImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 127, 255]);
    f.put(f.knowledge, "domains/orders/images/state.png", updatedImage); f.commit(f.knowledge);
    await syncModuleKnowledge(f.dataDir, "orders", "owner");
    assert.deepEqual(readGitKnowledgeResource(f.dataDir, document.id, "images/state.png")?.content, updatedImage);
    assert.deepEqual(readFrozenGitKnowledgeResource(f.dataDir, frozen[document.id], "images/state.png")?.content, f.image);
    assert.throws(() => freezeGitKnowledgeResources(f.dataDir, [document]), /正式文档版本已变化/);
    rmSync(join(f.dataDir, "knowledge-git", "modules"), { recursive: true });
    assert.deepEqual(readFrozenGitKnowledgeResource(f.dataDir, frozen[document.id], "images/state.png")?.content, f.image);
    assert.equal(readFrozenGitKnowledgeResource(f.dataDir, frozen[document.id], "../../../etc/passwd"), undefined);
    assert.equal(readFrozenGitKnowledgeResource(f.dataDir, frozen[document.id], "https://example.test/image.png"), undefined);
  } finally { f.cleanup(); }
});
