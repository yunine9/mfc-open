import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { eraseKnowledgeDocument, listKnowledgeDocuments, readKnowledgeArchiveVersion, readKnowledgeDocument, readKnowledgeDocumentVersion, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { writeKnowledgeDeletion } from "../src/knowledgeDeletionStore.ts";
import { componentArchiveParts, componentArchivePath } from "../src/componentKnowledgeArchiveFormat.ts";
import { researchDocumentMarkdown } from "../src/componentResearchDocument.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { componentGuideOverview, componentGuideSection } from "./fixtures/componentGuide.ts";
import type { DomainArchiveBatch, DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

const oldPath = "docs/knowledge/SONCommMgr/SONCommMgr.md";
const newPath = "docs/knowledge/SONComm/SONComm.md";
const original = "# SONComm\n已确认的旧版知识。\n";
const updated = "# SONComm\n已确认的改名后知识。\n";

async function fixture(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-document-rename-")), source = join(dir, "source"), remote = join(dir, "remote.git");
  mkdirSync(source);
  const gitRaw = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
  const git = (...args: string[]) => gitRaw(...args).trim();
  git("-C", source, "init", "-b", "main");
  git("-C", source, "config", "user.name", "Fixture"); git("-C", source, "config", "user.email", "alice@example.test");
  const write = (path: string, content: string) => { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), content); };
  write("code.ts", "export const untouched = true;\n");
  for (const [path, content] of Object.entries(files)) write(path, content);
  git("-C", source, "add", "."); git("-C", source, "commit", "-m", "fixture");
  const baseline = git("-C", source, "rev-parse", "HEAD");
  git("clone", "--bare", source, remote);
  const requests: string[] = [], mrs: Array<{ id: number; url: string; source_branch: string; target_branch: string }> = [];
  const lifecycle = { state: "opened", failClose: false, loseCloseResponse: false, mergeBeforeClose: false };
  const closeRequests: Array<{ repo: string; mr: string | number; username?: string; token?: string }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); requests.push(url.pathname);
    if (url.pathname === "/mr/gates") {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ mr_state: lifecycle.state, gates: [] })); return;
    }
    if (url.pathname === "/mr/close") {
      let body = ""; for await (const chunk of request) body += chunk;
      closeRequests.push({ ...JSON.parse(body), username: request.headers["x-mfc-git-user"] as string | undefined, token: request.headers["x-mfc-git-token"] as string | undefined });
      if (lifecycle.mergeBeforeClose) lifecycle.state = "merged";
      else if (!lifecycle.failClose) lifecycle.state = "closed";
      response.statusCode = lifecycle.failClose || lifecycle.loseCloseResponse ? 502 : 200;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ mr_state: lifecycle.state })); return;
    }
    if (url.pathname === "/mr/discover") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ mrs: mrs.filter(mr => mr.source_branch === url.searchParams.get("source_branch") && mr.target_branch === url.searchParams.get("target_branch")) }));
      return;
    }
    if (url.pathname !== "/mr") { response.statusCode = 404; response.end("{}"); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), mr = { id: mrs.length + 1, url: `https://example.test/mr/${mrs.length + 1}`, source_branch: input.source_branch, target_branch: input.target_branch };
    mrs.push(mr); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(mr));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const target = { id: "domain", name: "知识仓", repository: remote, branch: "main", path: "", docs_path: "docs/knowledge" };
  const formal = saveKnowledgeDocument(dir, { title: "SONComm", content: original, scope: "platform", archive_target: { repository: remote, branch: "main", path: oldPath } }, "alice");
  const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title: "DSON 模块知识", scope: "SONComm", issue_no: "REQ-466", operator: "alice",
    created_at: "2026-10-12T00:00:00.000Z", status: "done", stage: "已入库", knowledge_target: target, repositories: [], material_ids: [], component_research_id: "cr-fixture",
    revisions: {}, turns: [], evidence: [], publications: [], documents: [{ id: "son-comm", title: formal.title, target_id: "domain", layer: "domain", path: oldPath,
      content: formal.content, sources: "固定版本源码", selected: true, revision: 1, base_content: null, base_revision: baseline, history: [],
      knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 }] };
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credential: () => ({ username: "alice", password: "fixture-token", email: "alice@example.test" }) });
  let last: DomainPublication | undefined;
  const save = (publication: DomainPublication) => { last = structuredClone(publication); };
  const publish = (previous?: DomainPublication, callback = save) => publisher.publish(job, target, previous, "alice", callback);
  const rename = (path = newPath) => {
    const document = job.documents[0], previous = readKnowledgeDocument(dir, formal.id);
    document.base_path ??= document.path;
    const next = saveKnowledgeDocument(dir, { ...previous, content: updated, archive_target: { repository: target.repository, branch: target.branch, path } }, "alice", formal.id, { expectedRevision: previous.revision });
    Object.assign(document, { path, content: next.content, revision: document.revision + 1, published_revision: next.revision, published_document_revision: document.revision + 1 });
  };
  const freeze = (publication: DomainPublication) => {
    const batch: DomainArchiveBatch = { id: randomUUID(), created_at: new Date().toISOString(), operator: "alice", state: "done", issue_no: "REQ-466",
      documents: structuredClone(job.documents), targets: [structuredClone(target)], publications: [structuredClone(publication)] };
    (job.archive_batches ??= []).push(batch);
  };
  const remove = () => {
    const document = job.documents[0], current = readKnowledgeDocument(dir, formal.id);
    const deletionVersion = saveKnowledgeDocument(dir, { ...current, active: false }, "alice", formal.id, { expectedRevision: current.revision });
    readKnowledgeDocumentVersion(dir, deletionVersion.id, deletionVersion.revision);
    document.revision++;
    Object.assign(document, { deleted: true, content: deletionVersion.content, published_revision: deletionVersion.revision, published_document_revision: document.revision });
    writeKnowledgeDeletion(dir, { id: deletionVersion.id, title: deletionVersion.title, revision: deletionVersion.revision,
      at: new Date().toISOString(), operator: "alice", research_job_id: job.id, index_ids: [deletionVersion.id], index_state: "removed" });
    eraseKnowledgeDocument(dir, deletionVersion.id);
    return deletionVersion;
  };
  const tree = (revision: string, path: string) => git("-C", remote, "--literal-pathspecs", "ls-tree", revision, "--", path);
  const content = (revision: string, path: string) => gitRaw("-C", remote, "show", `${revision}:${path}`);
  return { dir, source, remote, target, job, formal, publisher, requests, mrs, lifecycle, closeRequests, git, gitRaw, write, baseline, save, publish, rename, freeze, remove, tree, content,
    last: () => last!,
    async close() { await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); rmSync(dir, { recursive: true, force: true }); } };
}

test("Issue489：归档分支沿用需求命名并避让已有同名分支，不接管其他提交", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    for (const branch of ["main_alice_REQ-466", "main_alice_REQ-466_2"]) f.git("-C", f.remote, "update-ref", `refs/heads/${branch}`, f.baseline);
    const publication = await f.publish();
    assert.equal(publication.branch, "main_alice_REQ-466_3");
    for (const branch of ["main_alice_REQ-466", "main_alice_REQ-466_2"]) assert.equal(f.git("-C", f.remote, "rev-parse", branch), f.baseline);
    assert.equal(f.mrs[0].source_branch, publication.branch);
    assert.equal(f.mrs[0].target_branch, "main");
  } finally { await f.close(); }
});

test("Issue489：新版本不复用已删除远端的旧 MR 分支名，已推送旧格式分支仍精确恢复", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    assert.equal(first.branch, "main_alice_REQ-466");
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.git("-C", f.remote, "update-ref", "-d", `refs/heads/${first.branch}`);
    f.rename();
    const next = await f.publish();
    assert.equal(next.branch, "main_alice_REQ-466_2");
    const oldBranch = "codex/knowledge-existing-attempt";
    f.git("-C", f.remote, "update-ref", `refs/heads/${oldBranch}`, next.revision!);
    const recovered = await f.publish({ ...next, branch: oldBranch, state: "failed", url: undefined, mr_id: undefined, mr_attempted: undefined });
    assert.equal(recovered.branch, oldBranch);
    assert.equal(recovered.revision, next.revision);
  } finally { await f.close(); }
});

test("Issue489：撤销旧 MR 使用个人凭据及项目 MR 编号，已合入与已关闭返回不同终态", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const publication = await f.publish();
    const old = { ...publication, mr_id: 987654, url: "https://codehub.example.test/group/repo/merge_requests/47" };
    f.lifecycle.loseCloseResponse = true;
    assert.equal(await f.publisher.closePublication(f.job, f.target, old, "alice"), "closed");
    assert.deepEqual(f.closeRequests, [{ repo: f.remote, mr: "47", username: "alice", token: "fixture-token" }]);
    assert.equal(await f.publisher.closePublication(f.job, f.target, old, "alice"), "closed");
    assert.equal(f.closeRequests.length, 1, "回执丢失后已关闭的 MR 不再次发送关闭操作");
    f.lifecycle.state = "merged";
    assert.equal(await f.publisher.closePublication(f.job, f.target, old, "alice"), "merged");
    assert.equal(f.closeRequests.length, 1, "已合入保留真实状态，不声称撤销成功");
    f.lifecycle.state = "opened"; f.lifecycle.failClose = true; f.lifecycle.mergeBeforeClose = true;
    assert.equal(await f.publisher.closePublication(f.job, f.target, old, "alice"), "merged", "查询后并发合入时，关闭失败后的复查仍记录真实合入状态");
    f.lifecycle.mergeBeforeClose = false;
    f.lifecycle.state = "opened"; f.lifecycle.failClose = true;
    await assert.rejects(f.publisher.closePublication(f.job, f.target, old, "alice"), /关闭失败 HTTP 502/);
  } finally { await f.close(); }
});

/** 正式文稿的 module_ids 现在要求业务模块在册(prepareKnowledgeDocument
 * 校验),fixture 先把模块种进库里;同 id 重复种直接放过。 */
function seedModule(f: Awaited<ReturnType<typeof fixture>>, moduleId: string): void {
  try {
    createBusinessModule(f.dir, { id: moduleId, name: moduleId, description: "归档用例模块", owner: "alice",
      repositories: [f.target.repository] }, "alice");
  } catch { /* 已在册 */ }
}

function repositoryJob(f: Awaited<ReturnType<typeof fixture>>, moduleId: string, directory: string, files: Record<string, string>): DomainKnowledgeJob {
  const target = { ...f.target, docs_path: directory };
  seedModule(f, moduleId);
  const documents = Object.entries(files).map(([path, content], index) => {
    const formal = saveKnowledgeDocument(f.dir, { title: `${moduleId} 的知识`, content, scope: "module", module_ids: [moduleId],
      archive_target: { repository: target.repository, branch: target.branch, path } }, "alice");
    return { id: `${moduleId}-${index}`, title: formal.title, target_id: target.id, layer: "domain" as const, path, content, sources: "已核对源码",
      selected: true, revision: 1, base_content: null, base_revision: f.baseline, history: [], knowledge_document_id: formal.id,
      published_revision: formal.revision, published_document_revision: 1 };
  });
  return { ...f.job, id: `dkx-${randomUUID()}`, module_id: moduleId, knowledge_layout: "repository-v1", knowledge_target: target, repositories: [], documents,
    publications: [], archive_batches: [], publication_history: [] };
}

function directoryJob(f: Awaited<ReturnType<typeof fixture>>, moduleId: string, domainDirectory: string, codeDirectory?: string): DomainKnowledgeJob {
  seedModule(f, moduleId);
  const domain = { ...f.target, docs_path: domainDirectory }, repository = { ...f.target, id: "code", name: "代码仓", docs_path: codeDirectory ?? "docs/unused" };
  const values = [{ target: domain, layer: "domain" as const, file: "README.md", content: `# ${moduleId}领域说明\n` },
    ...(codeDirectory ? [{ target: repository, layer: "repository" as const, file: "module-map.md", content: `# ${moduleId}代码地图\n` }] : [])];
  const jobId = `dkx-${randomUUID()}`;
  const documents = values.map(({ target, layer, file, content }, index) => {
    const path = `${target.docs_path}/${file}`, id = `${moduleId}-${index}`;
    const formal = saveKnowledgeDocument(f.dir, { title: `${moduleId}知识`, content, scope: "module", module_ids: [moduleId],
      archive_target: { repository: target.repository, branch: target.branch, path },
      research_source: { job_id: jobId, document_id: id, layer, repository: target.repository, branch: target.branch, path } }, "alice");
    return { id, title: formal.title, target_id: target.id, layer, path, content, sources: "已核对源码与资料", selected: true,
      revision: 1, base_content: null, base_revision: f.baseline, history: [], knowledge_document_id: formal.id,
      published_revision: formal.revision, published_document_revision: 1 };
  });
  return { ...f.job, id: jobId, module_id: moduleId, knowledge_layout: "directory-v1", knowledge_target: domain,
    repositories: codeDirectory ? [repository] : [], documents, publications: [], archive_batches: [], publication_history: [] };
}

test("Issue489补充：领域仓AGENTS仅写所选目录，索引使用目录相对路径并保留仓根原文件", { timeout: 20_000 }, async () => {
  const oldRoot = "# 仓根其他规则\n不属于当前领域目录。\n", f = await fixture({ "AGENTS.md": oldRoot, "index.md": "其他既有文稿。\n" });
  try {
    const job = directoryJob(f, "orders", "handbook/订单领域"), result = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    const navigation = f.content(result.revision!, "handbook/订单领域/AGENTS.md");
    assert.match(navigation, /^# AGENTS\.md — 领域知识导航/);
    assert.match(navigation, /- ` README\.md `/);
    assert.doesNotMatch(navigation, /handbook\//, "目录入口链接相对本目录，不能重复附加仓根路径");
    assert.equal(f.content(result.revision!, "AGENTS.md"), oldRoot, "纯领域归档不生成或覆盖仓根入口");
    assert.equal(f.content(result.revision!, "index.md"), "其他既有文稿。\n", "不扫描删除无关根文件");
    assert.deepEqual(result.navigation_files, [{ path: "handbook/订单领域/AGENTS.md", content: navigation }]);
    assert.equal(result.documents.some(document => /AGENTS\.md$/.test(document.path)), false, "派生导航与正式研究正文分别记录");
    assert.equal(f.content(result.revision!, job.documents[0].path), job.documents[0].content);
  } finally { await f.close(); }
});

test("Issue489补充：同一物理仓兼具领域与代码角色，各自AGENTS只导航对应知识", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = directoryJob(f, "orders", "docs/订单领域", "docs/订单实现"), first = await f.publisher.publish(a, a.knowledge_target, undefined, "alice", f.save);
    assert.equal(first.documents.length, 2, "同仓双角色在一次MR保存两份正文");
    const root = f.content(first.revision!, "AGENTS.md"), domain = f.content(first.revision!, "docs/订单领域/AGENTS.md");
    assert.ok(root.includes("docs/订单实现/module-map.md"));
    assert.ok(!root.includes("订单领域"), "领域目录不能被合成代码仓根入口");
    assert.match(domain, /README\.md/); assert.doesNotMatch(domain, /module-map|订单实现/);
    assert.equal(first.navigation_files?.length, 2);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const b = directoryJob(f, "billing", "docs/账单领域", "docs/账单实现"), second = await f.publisher.publish(b, b.knowledge_target, undefined, "alice", f.save);
    const secondRoot = f.content(second.revision!, "AGENTS.md");
    assert.ok(secondRoot.includes("docs/订单实现/module-map.md")); assert.ok(secondRoot.includes("docs/账单实现/module-map.md"));
    assert.ok(!secondRoot.includes("领域"));
    assert.equal(f.content(second.revision!, "docs/订单领域/AGENTS.md"), domain, "另一个领域目标保留自己的目录入口");
    assert.ok(f.content(second.revision!, "docs/账单领域/AGENTS.md").includes("README.md"));
    assert.equal(f.content(second.revision!, "code.ts"), "export const untouched = true;\n");
  } finally { await f.close(); }
});

test("Issue489补充：正式角色元数据可在代码根索引丢失后恢复代码入口，领域入口仍独立", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = directoryJob(f, "orders", "docs/订单领域", "docs/订单实现"), first = await f.publisher.publish(a, a.knowledge_target, undefined, "alice", f.save);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write("AGENTS.md", "# 失去旧索引的仓根说明\n"); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "replace navigation"); f.git("-C", f.source, "push", f.remote, "main");
    const b = directoryJob(f, "billing", "docs/账单领域", "docs/账单实现"), second = await f.publisher.publish(b, b.repositories[0], undefined, "alice", f.save);
    const root = f.content(second.revision!, "AGENTS.md");
    assert.ok(root.includes("docs/订单实现/module-map.md")); assert.ok(root.includes("docs/账单实现/module-map.md"));
    assert.ok(!root.includes("领域/README.md"), "scope=module仍根据layer正确区分代码和领域");
  } finally { await f.close(); }
});

test("Issue489补充：改领域目录只清理冻结且全文相同的旧派生入口，恢复不改原SHA", { timeout: 40_000 }, async t => {
  for (const modified of [false, true]) await t.test(modified ? "维护人改过旧入口" : "原派生入口", async () => {
    const f = await fixture();
    try {
      const job = directoryJob(f, "orders", "docs/旧目录"), first = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
      job.archive_batches = [{ id: randomUUID(), created_at: "now", operator: "alice", state: "done", issue_no: "REQ-466", knowledge_layout: "directory-v1",
        documents: structuredClone(job.documents), targets: [structuredClone(job.knowledge_target)], publications: [structuredClone(first)] }];
      f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
      if (modified) {
        f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
        f.write("docs/旧目录/AGENTS.md", "# 维护人调整后的入口\n"); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "edit old directory navigation"); f.git("-C", f.source, "push", f.remote, "main");
      }
      const doc = job.documents[0], old = readKnowledgeDocument(f.dir, doc.knowledge_document_id!);
      doc.base_path = doc.path; doc.base_content = doc.content; doc.path = "docs/新目录/README.md"; doc.revision++;
      const formal = saveKnowledgeDocument(f.dir, { ...old, archive_target: { repository: f.remote, branch: "main", path: doc.path } }, "alice", old.id, { expectedRevision: old.revision });
      doc.published_revision = formal.revision; doc.published_document_revision = doc.revision; job.knowledge_target.docs_path = "docs/新目录";
      await assert.rejects(f.publisher.publish(job, job.knowledge_target, undefined, "alice", publication => {
        if (publication.documents.length) throw new Error("模拟推送后保存中断"); f.save(publication);
      }), /模拟推送后保存中断/);
      const attempted = f.last();
      assert.equal(f.tree(attempted.revision!, "docs/旧目录/README.md"), "");
      if (modified) assert.equal(f.content(attempted.revision!, "docs/旧目录/AGENTS.md"), "# 维护人调整后的入口\n");
      else assert.equal(f.tree(attempted.revision!, "docs/旧目录/AGENTS.md"), "", "精确确认的旧派生入口随已覆盖正文迁移删除");
      assert.match(f.content(attempted.revision!, "docs/新目录/AGENTS.md"), /README\.md/);
      const recovered = await f.publisher.publish(job, job.knowledge_target, { ...attempted, state: "failed" }, "alice", f.save);
      assert.equal(recovered.revision, attempted.revision); assert.equal(recovered.branch, attempted.branch);
      assert.deepEqual(recovered.navigation_files, attempted.navigation_files, "精确版本重试保留派生文件快照");
    } finally { await f.close(); }
  });
});

test("Issue489补充：同批次删除旧目录文稿并迁移存活稿，删除只能使用已确认的原位置", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const job = directoryJob(f, "orders", "docs/旧目录"), deleted = job.documents[0];
    const liveFormal = saveKnowledgeDocument(f.dir, { title: "存活规则", content: "# 存活规则\n", scope: "module", module_ids: ["orders"],
      archive_target: { repository: f.remote, branch: "main", path: "docs/旧目录/rules.md" },
      research_source: { job_id: job.id, document_id: "live-rules", layer: "domain", repository: f.remote, branch: "main", path: "docs/旧目录/rules.md" } }, "alice");
    const live = { ...structuredClone(deleted), id: "live-rules", title: liveFormal.title, content: liveFormal.content,
      path: "docs/旧目录/rules.md", knowledge_document_id: liveFormal.id, published_revision: liveFormal.revision };
    job.documents.push(live);
    const first = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    job.archive_batches = [{ id: randomUUID(), created_at: "now", operator: "alice", state: "done", issue_no: "REQ-466", knowledge_layout: "directory-v1",
      documents: structuredClone(job.documents), targets: [structuredClone(job.knowledge_target)], publications: [structuredClone(first)] }];
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const oldDeleted = readKnowledgeDocument(f.dir, deleted.knowledge_document_id!), deletion = saveKnowledgeDocument(f.dir,
      { ...oldDeleted, active: false }, "alice", oldDeleted.id, { expectedRevision: oldDeleted.revision });
    Object.assign(deleted, { deleted: true, revision: 2, published_revision: deletion.revision, published_document_revision: 2 });
    writeKnowledgeDeletion(f.dir, { id: deletion.id, title: deletion.title, revision: deletion.revision, at: new Date().toISOString(),
      operator: "alice", research_job_id: job.id, index_ids: [deletion.id], index_state: "removed" });
    eraseKnowledgeDocument(f.dir, deletion.id);
    const oldLive = readKnowledgeDocument(f.dir, live.knowledge_document_id!);
    Object.assign(live, { base_path: live.path, base_content: live.content, path: "docs/新目录/rules.md", revision: 2, published_document_revision: 2 });
    const moved = saveKnowledgeDocument(f.dir, { ...oldLive, archive_target: { repository: f.remote, branch: "main", path: live.path } },
      "alice", oldLive.id, { expectedRevision: oldLive.revision });
    live.published_revision = moved.revision; job.knowledge_target.docs_path = "docs/新目录";
    deleted.archive_path = "docs/无关目录/README.md";
    await assert.rejects(f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save), /删除文稿的归档位置与已确认正式版本不一致/);
    delete deleted.archive_path;
    const result = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    assert.equal(f.tree(result.revision!, "docs/旧目录/README.md"), "");
    assert.equal(f.tree(result.revision!, "docs/旧目录/rules.md"), "");
    assert.equal(f.tree(result.revision!, "docs/旧目录/AGENTS.md"), "");
    assert.equal(f.content(result.revision!, "docs/新目录/rules.md"), live.content);
    assert.equal(f.tree(result.revision!, "docs/新目录/README.md"), "", "已确认删除不能被迁入新目录重新写出");
    assert.match(f.content(result.revision!, "docs/新目录/AGENTS.md"), /rules\.md/);
    assert.equal(result.documents.find(document => document.id === deleted.id)?.path, "docs/旧目录/README.md");
  } finally { await f.close(); }
});

test("Issue489：按仓根相对路径归档，根导航兼容旧模块入口并保留其他自定义目录", { timeout: 30_000 }, async () => {
  const oldRoot = "# 旧根说明\n\n## 模块索引\n\n- ` docs/knowledge/ `\n\n## 阅读与维护约定\n旧业务规则。\n";
  const f = await fixture({ "AGENTS.md": oldRoot, "docs/knowledge/existing/README.md": "# 已有模块\n", "src/example/README.md": "源码说明。\n" });
  try {
    const a = repositoryJob(f, "orders", ".", { "docs/module-map.md": "# 仓库模块地图\n", "docs/rules.md": "# 业务规则\n" });
    const first = await f.publisher.publish(a, a.knowledge_target, undefined, "alice", f.save);
    assert.equal(f.content(first.revision!, "docs/module-map.md"), a.documents[0].content);
    assert.equal(f.tree(first.revision!, "docs/knowledge/orders/docs/module-map.md"), "", "publisher 不增加默认目录、模块 ID 或仓名");
    const root = f.content(first.revision!, "AGENTS.md");
    assert.match(root, /docs\/module-map\.md/);
    assert.match(root, /docs\/knowledge\/existing\/README\.md/);
    assert.doesNotMatch(root, /旧业务规则|src\/example/);
    assert.equal(first.documents.some(document => document.path === "AGENTS.md"), false, "根导航不是正式知识文稿");
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const b = repositoryJob(f, "billing", "handbook`rules", { "handbook`rules/README.md": "# 账单模块入口\n" });
    const second = await f.publisher.publish(b, b.knowledge_target, undefined, "alice", f.save);
    const secondRoot = f.content(second.revision!, "AGENTS.md");
    assert.match(secondRoot, /docs\/module-map\.md/);
    assert.match(secondRoot, /docs\/knowledge\/existing\/README\.md/);
    assert.ok(secondRoot.includes("`` handbook`rules/README.md ``"), "实际路径含反引号时使用完整 code span");
    assert.equal(f.content(second.revision!, "code.ts"), "export const untouched = true;\n");
    assert.equal(f.content(`${first.revision}^`, "AGENTS.md"), oldRoot);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    const legacy = moduleJob(f, "legacy"), legacyPublication = await f.publisher.publish(legacy, legacy.knowledge_target, undefined, "alice", f.save);
    const legacyRoot = f.content(legacyPublication.revision!, "AGENTS.md");
    assert.match(legacyRoot, /docs\/module-map\.md/, "旧冻结布局继续归档时保留新布局的实际入口");
    assert.ok(legacyRoot.includes("`` handbook`rules/README.md ``"));
  } finally { await f.close(); }
});

test("Issue489：旧归档目录迁移至仓根相对路径只移除已核对原文稿，重试保留精确 SHA", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original, "AGENTS.md": "旧的共享根说明。\n", "docs/unrelated.md": "其他模块文稿。\n" });
  try {
    seedModule(f, "orders");
    f.job.knowledge_layout = "repository-v1"; f.job.module_id = "orders"; f.target.docs_path = ".";
    f.job.documents[0].base_content = original;
    f.rename("docs/module-map.md");
    await assert.rejects(f.publish(undefined, publication => {
      if (publication.documents.length) throw new Error("模拟新目录推送后回执保存失败");
      f.save(publication);
    }), /模拟新目录推送后回执保存失败/);
    const attempted = f.last();
    assert.equal(f.tree(attempted.revision!, oldPath), "");
    assert.equal(f.content(attempted.revision!, "docs/module-map.md"), updated);
    assert.equal(f.content(attempted.revision!, "docs/unrelated.md"), "其他模块文稿。\n");
    const recovered = await f.publish({ ...attempted, state: "failed" });
    assert.equal(recovered.branch, attempted.branch);
    assert.equal(recovered.revision, attempted.revision);
    assert.match(f.content(recovered.revision!, "AGENTS.md"), /docs\/module-map\.md/);
  } finally { await f.close(); }
});

test("Issue466：未归档草稿的原路径在 Git 不存在，不凭修订历史删除其他 Git 文件", { timeout: 20_000 }, async () => {
  const unrelated = "docs/knowledge/unrelated.md";
  const f = await fixture({ [unrelated]: original });
  try {
    f.job.documents[0].history.push({ revision: 1, path: unrelated, content: original, sources: "旧草稿", title: "SONCommMgr", operator: "alice", at: new Date().toISOString() });
    f.rename();
    const publication = await f.publish();
    assert.equal(f.content(publication.revision!, unrelated), original, "没有 Git 基线或已推送快照，历史正文相同也不能授权删除");
    assert.equal(f.tree(publication.revision!, oldPath), "");
    assert.equal(f.content(publication.revision!, newPath), updated);
    assert.equal(f.content(publication.revision!, "code.ts"), "export const untouched = true;\n");
  } finally { await f.close(); }
});

test("Issue466：删除未归档草稿且 Git 没有该文件，纯删除批次可归档且不产生文档", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.rename("AGENTS.md");
    const deleted = f.remove();
    assert.throws(() => readKnowledgeDocument(f.dir, deleted.id), /知识已删除/);
    assert.throws(() => readKnowledgeDocumentVersion(f.dir, deleted.id, deleted.revision), /知识已删除/);
    assert.equal(listKnowledgeDocuments(f.dir).length, 0);
    assert.equal(readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision).document.revision, deleted.revision);
    const result = await f.publish();
    assert.equal(result.state, "opened");
    assert.equal(result.documents[0].deleted, true);
    assert.equal(result.documents[0].path, "AGENTS.md", "授权目标仓内的根 Markdown 不受默认目录限制");
    assert.equal(f.tree(result.revision!, "AGENTS.md"), "");
    assert.equal(f.tree(result.revision!, oldPath), "");
    assert.equal(f.content(result.revision!, "code.ts"), "export const untouched = true;\n");
    assert.equal(listKnowledgeDocuments(f.dir).length, 0);
  } finally { await f.close(); }
});

test("Issue466：初始 Git Markdown 删除只删除已核对文件，普通知识读取仍拒绝已删版本", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; const deleted = f.remove();
    const result = await f.publish();
    assert.equal(f.tree(result.revision!, oldPath), "");
    assert.equal(f.git("-C", f.remote, "rev-parse", `${result.revision}^`), f.baseline);
    assert.equal(f.content(f.baseline, oldPath), original);
    assert.equal(result.documents[0].knowledge_revision, deleted.revision);
    assert.equal(result.documents[0].deleted, true);
    assert.throws(() => readKnowledgeDocumentVersion(f.dir, deleted.id, deleted.revision), /知识已删除/);
  } finally { await f.close(); }
});

test("Issue466：已发布知识删除在同一树删除当前名字及可核对旧名字，旧 MR 仍可追溯", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first); f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename(); const second = await f.publish(); f.freeze(second); f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write(oldPath, original); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "retain duplicate old name"); f.git("-C", f.source, "push", f.remote, "main");
    f.remove();
    const result = await f.publish();
    assert.equal(f.tree(result.revision!, oldPath), "");
    assert.equal(f.tree(result.revision!, newPath), "");
    assert.equal(f.content(first.revision!, oldPath), original);
    assert.equal(f.content(second.revision!, newPath), updated);
    assert.equal(result.documents[0].deleted, true);
    assert.equal(f.content(result.revision!, "code.ts"), "export const untouched = true;\n");
  } finally { await f.close(); }
});

test("Issue466：删除文件已被修改，或旧名已归他人知识时拒绝并保留远端文件", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original;
    f.write(oldPath, "他人修改的正文\n"); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "edit old document"); f.git("-C", f.source, "push", f.remote, "main");
    f.remove();
    const branches = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
    await assert.rejects(f.publish(), /删除原文件.*已被修改.*未删除/);
    assert.equal(f.content("main", oldPath), "他人修改的正文\n");
    assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
    assert.equal(f.mrs.length, 0);
  } finally { await f.close(); }
  const owned = await fixture({ [oldPath]: original });
  try {
    owned.job.documents[0].base_content = original; owned.rename();
    const owner = saveKnowledgeDocument(owned.dir, { title: "另一模块", content: original, scope: "platform", archive_target: { repository: owned.remote, branch: "main", path: oldPath } }, "bob");
    owned.remove();
    await assert.rejects(owned.publish(), /原路径.*已被其他正式知识使用.*未删除/);
    assert.equal(owned.content("main", oldPath), original);
    assert.equal(readKnowledgeDocument(owned.dir, owner.id).content, original);
    assert.equal(owned.mrs.length, 0);
  } finally { await owned.close(); }
});

test("Issue466：删除提交推送后记录写失败，人工重试复用删除分支和精确版本", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; const deleted = f.remove();
    await assert.rejects(f.publish(undefined, publication => {
      if (publication.documents.length) throw new Error("模拟删除推送后的保存失败");
      f.save(publication);
    }), /模拟删除推送后的保存失败/);
    const attempted = f.last();
    assert.equal(attempted.attempted_documents?.[0].deleted, true);
    assert.equal(f.tree(attempted.revision!, oldPath), "");
    const recovered = await f.publish({ ...attempted, state: "failed" });
    assert.equal(recovered.branch, attempted.branch);
    assert.equal(recovered.revision, attempted.revision);
    assert.equal(recovered.documents[0].deleted, true);
    assert.equal(recovered.documents[0].knowledge_revision, deleted.revision);
    assert.equal(f.mrs.length, 1);
    assert.throws(() => readKnowledgeDocument(f.dir, deleted.id), /知识已删除/);
  } finally { await f.close(); }
});

test("Issue466：未确认的草稿删除及已删除知识的旧写入快照都不能执行 Git 操作", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].deleted = true;
    await assert.rejects(f.publish(), /请先确认发布当前删除文稿/);
    const deleted = f.remove();
    f.job.documents[0].deleted = false;
    await assert.rejects(f.publish(), /知识已删除.*不能重新写入/);
    f.job.documents[0].deleted = true; f.job.documents[0].published_document_revision = f.job.documents[0].revision - 1;
    await assert.rejects(f.publish(), /请先确认发布当前删除文稿/);
    assert.equal(f.content("main", oldPath), original);
    assert.equal(f.mrs.length, 0);
    assert.equal(readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision).document.id, deleted.id);
  } finally { await f.close(); }
});

test("Issue466：已删知识内部归档只认 tombstone 精确版本并校验保留记录", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const prior = f.formal.revision, deleted = f.remove();
    assert.notEqual(deleted.revision, prior);
    assert.throws(() => readKnowledgeArchiveVersion(f.dir, deleted.id, prior), /只能归档删除时绑定的精确版本/);
    const path = join(f.dir, "knowledge-document-versions", deleted.id, `${deleted.revision}.json`), before = readFileSync(path, "utf8");
    for (const change of [
      (value: any) => { value.document.id = `kd-${randomUUID()}`; },
      (value: any) => { value.document.revision = "a".repeat(64); },
      (value: any) => { value.document.content = ""; },
      (value: any) => { value.operator = ""; },
      (value: any) => { value.published_at = "invalid"; },
    ]) {
      const value = JSON.parse(before); change(value); writeFileSync(path, JSON.stringify(value));
      assert.throws(() => readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision), /归档版本记录损坏/);
    }
    writeFileSync(path, before);
    assert.equal(readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision).document.id, deleted.id);
    assert.throws(() => readKnowledgeDocumentVersion(f.dir, deleted.id, deleted.revision), /知识已删除/);
  } finally { await f.close(); }
});

test("Issue466：原路径在 Git 存在但没有可核对基线时拒绝改名，保留原文件", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].history.push({ revision: 1, path: oldPath, content: original, sources: "旧草稿", title: "SONCommMgr", operator: "alice", at: new Date().toISOString() });
    f.rename();
    await assert.rejects(f.publish(), /原文件.*无法核对.*未删除/);
    assert.equal(f.content("main", oldPath), original);
    assert.equal(f.tree("main", newPath), "");
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("Issue466：初始 Git 基线改名在同一提交删除旧文件并写新文件，稳定知识 ID 保留", { timeout: 20_000 }, async () => {
  const referencePaths = ["docs/knowledge/module-map.md", "docs/knowledge/AGENTS.md"];
  const oldReference = `参阅 [SONCommMgr](${oldPath})。\n`, newReference = `参阅 [SONComm](${newPath})。\n`;
  const f = await fixture({ [oldPath]: original, ...Object.fromEntries(referencePaths.map(path => [path, oldReference])) });
  try {
    f.job.documents[0].base_content = original;
    f.rename();
    for (const [index, path] of referencePaths.entries()) {
      const formal = saveKnowledgeDocument(f.dir, { title: index ? "AGENTS" : "module-map", content: newReference, scope: "platform", archive_target: { repository: f.remote, branch: "main", path } }, "alice");
      f.job.documents.push({ id: `reference-${index}`, title: formal.title, target_id: "domain", layer: "domain", path, content: formal.content, sources: "改名映射", selected: true, revision: 1, base_content: oldReference, base_revision: f.baseline, history: [], knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 });
    }
    const publication = await f.publish();
    assert.equal(f.tree(publication.revision!, oldPath), "");
    assert.equal(f.content(publication.revision!, newPath), updated);
    assert.equal(f.git("-C", f.remote, "rev-parse", `${publication.revision}^`), f.baseline);
    assert.equal(publication.documents[0].id, "son-comm");
    assert.equal(publication.documents[0].knowledge_document_id, f.formal.id);
    assert.equal(readKnowledgeDocument(f.dir, f.formal.id).archive_target?.path, newPath);
    assert.equal(f.content(publication.revision!, "code.ts"), "export const untouched = true;\n");
    for (const path of referencePaths) {
      assert.equal(f.content(publication.revision!, path), newReference, "引用随改名进入同一 Git 树提交");
      assert.equal(f.content(f.baseline, path), oldReference);
    }
  } finally { await f.close(); }
});

test("Issue466：已推送归档批次提供旧文件证据，目录和文件改名不会留下原文件", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename();
    const next = await f.publish();
    assert.notEqual(next.branch, first.branch);
    assert.equal(f.tree(next.revision!, oldPath), "");
    assert.equal(f.content(next.revision!, newPath), updated);
    assert.equal(f.content(first.revision!, oldPath), original, "原归档版本和 MR 快照不改变");
    assert.equal(f.job.archive_batches![0].publications[0].documents[0].path, oldPath);
  } finally { await f.close(); }
});

test("Issue466：旧 publication_history 按精确正式版本核对目标后安全改名", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.job.publication_history = [structuredClone(first)];
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename();
    const next = await f.publish();
    assert.equal(f.tree(next.revision!, oldPath), "");
    assert.equal(f.content(next.revision!, newPath), updated);
  } finally { await f.close(); }
});

test("Issue466：原路径被另一篇正式知识重用，旧内容相同也不能在后续改名中删除", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename();
    const second = await f.publish(); f.freeze(second);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    const owner = saveKnowledgeDocument(f.dir, { title: "新的独立模块", content: original, scope: "platform",
      archive_target: { repository: f.remote, branch: "main", path: oldPath },
      research_source: { job_id: `dkx-${randomUUID()}`, document_id: "other-module", repository: f.remote, branch: "main", path: oldPath } }, "bob");
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write(oldPath, original); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "another knowledge owns old path"); f.git("-C", f.source, "push", f.remote, "main");
    const formalFile = join(f.dir, "knowledge-documents", `${owner.id}.json`), formalBefore = readFileSync(formalFile, "utf8");
    const branches = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
    const thirdPath = "docs/knowledge/通信/SONComm.md";
    f.rename(thirdPath);
    await assert.rejects(f.publish(), /原路径.*已被其他正式知识使用.*未删除/);
    assert.equal(f.content("main", oldPath), original, "另一个任务的文件与历史正文相同，也必须保留");
    assert.equal(f.content("main", newPath), updated);
    assert.equal(f.tree("main", thirdPath), "");
    assert.equal(readFileSync(formalFile, "utf8"), formalBefore, "不改变另一个任务的正式知识");
    assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
    assert.equal(f.mrs.length, 2, "所有权冲突不推送或创建第三个 MR");
  } finally { await f.close(); }
});

for (const changed of ["old", "destination"] as const) {
  test(`Issue466：${changed === "old" ? "并发修改旧文件" : "新目的地被其他文件占用"}时拒绝改名，不推送或创建 MR`, { timeout: 20_000 }, async () => {
    const f = await fixture({ [oldPath]: original });
    try {
      f.job.documents[0].base_content = original; f.rename();
      f.write(changed === "old" ? oldPath : newPath, changed === "old" ? "管理员修改的新内容\n" : updated);
      f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "concurrent change"); f.git("-C", f.source, "push", f.remote, "main");
      const branches = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
      await assert.rejects(f.publish(), changed === "old" ? /原文件.*已被修改/ : /改名目标.*已有其他文件/);
      assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
      assert.equal(f.requests.length, 0);
      assert.equal(f.content("main", oldPath), changed === "old" ? "管理员修改的新内容\n" : original);
      assert.equal(changed === "destination" ? f.content("main", newPath) : f.tree("main", newPath), changed === "destination" ? updated : "");
    } finally { await f.close(); }
  });
}

test("Issue466：新目录含软链接时拒绝改名并保留旧文件", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; f.rename();
    symlinkSync("../SONCommMgr", join(f.source, "docs/knowledge/SONComm"));
    f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "add symlink"); f.git("-C", f.source, "push", f.remote, "main");
    await assert.rejects(f.publish(), /父路径包含文件或软链接/);
    assert.equal(f.content("main", oldPath), original);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("Issue466：另一目标分支的归档快照不能授权删除当前分支的旧文件", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/release", first.revision!);
    f.target.branch = "release";
    f.rename();
    await assert.rejects(f.publish(), /原文件.*无法核对.*未删除/);
    assert.equal(f.content("release", oldPath), original);
    assert.equal(f.tree("release", newPath), "");
    assert.equal(f.job.archive_batches![0].targets[0].branch, "main");
  } finally { await f.close(); }
});

test("Issue466：组件知识标题改名也复用归档器，同一正式知识只移出一篇正文", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    createTechnologyStack(f.dir, { name: "C++" }, "fixture");
    f.job.component_research_id = `cr-${randomUUID()}`;
    const document = { overview: componentGuideOverview(), sections: [{ ...componentGuideSection("file-operations", ["reference"]), selected: true, revision: 1 }] };
    const firstContent = researchDocumentMarkdown("FileMgr", document);
    const firstPath = componentArchivePath(f.target.docs_path, { title: "FileMgr", technologies: ["cpp"] });
    const previous = readKnowledgeDocument(f.dir, f.formal.id);
    const firstFormal = saveKnowledgeDocument(f.dir, { ...previous, title: "FileMgr", content: firstContent, technologies: ["cpp"], archive_target: { repository: f.remote, branch: "main", path: firstPath } }, "alice", f.formal.id, { expectedRevision: previous.revision });
    Object.assign(f.job.documents[0], { path: firstPath, title: firstFormal.title, content: firstFormal.content, published_revision: firstFormal.revision });
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const nextPath = componentArchivePath(f.target.docs_path, { title: "文件操作", technologies: ["cpp"] });
    const nextFormal = saveKnowledgeDocument(f.dir, { ...firstFormal, title: "文件操作", content: researchDocumentMarkdown("文件操作", document), archive_target: { repository: f.remote, branch: "main", path: nextPath } }, "alice", f.formal.id, { expectedRevision: firstFormal.revision });
    Object.assign(f.job.documents[0], { path: nextPath, title: nextFormal.title, content: nextFormal.content, revision: 2, published_revision: nextFormal.revision, published_document_revision: 2 });
    const next = await f.publish();
    assert.equal(f.tree(next.revision!, firstPath), "");
    assert.equal(f.content(next.revision!, nextPath), componentArchiveParts(nextFormal.content).content);
    assert.doesNotMatch(f.content(next.revision!, nextPath), /component_paradigms|schema:/);
    assert.equal(next.documents.length, 1);
    assert.equal(next.documents[0].knowledge_document_id, firstFormal.id);
    assert.equal(f.content(first.revision!, firstPath), componentArchiveParts(firstFormal.content).content);
  } finally { await f.close(); }
});

test("Issue466：改名提交已推送但回执保存失败，重试沿用精确分支和同一提交", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; f.rename();
    await assert.rejects(f.publish(undefined, publication => {
      if (publication.documents.length) throw new Error("模拟推送后记录写失败");
      f.save(publication);
    }), /模拟推送后记录写失败/);
    const attempted = f.last();
    assert.ok(attempted.revision);
    assert.deepEqual(attempted.documents, [], "恢复只拿到推送前的保存窗口，不能假装已有完整推送回执");
    assert.equal(f.git("-C", f.remote, "rev-parse", attempted.branch), attempted.revision);
    assert.equal(f.tree(attempted.revision!, oldPath), "");
    assert.equal(f.content(attempted.revision!, newPath), updated);
    assert.equal(f.requests.length, 0);
    const next = await f.publish({ ...attempted, state: "failed" });
    assert.equal(next.branch, attempted.branch);
    assert.equal(next.revision, attempted.revision, "精确远端版本已完成改名，不重复写提交");
    assert.equal(next.state, "opened");
    assert.equal(f.mrs.length, 1);
    assert.equal(f.tree(next.revision!, oldPath), "");
    assert.equal(f.content(next.revision!, newPath), updated);
  } finally { await f.close(); }
});

test("共享仓归档：同路径普通更新核对研究基线，不覆盖人工修改或恢复已删文件", { timeout: 60_000 }, async t => {
  const cases = [
    { name: "基线未变化可更新", baseline: original, current: original, allowed: true },
    { name: "不知道原正文不能覆盖已有文件", baseline: null, current: original, allowed: false },
    { name: "研究后人工修改不能覆盖", baseline: original, current: "人工补充的业务约束\n", allowed: false },
    { name: "研究后人工删除不能恢复", baseline: original, current: null, allowed: false },
    { name: "远端已经是本次正文可幂等归档", baseline: null, current: updated, allowed: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = await fixture({ [oldPath]: original });
    try {
      const document = f.job.documents[0];
      const next = saveKnowledgeDocument(f.dir, { ...f.formal, content: updated }, "alice", f.formal.id, { expectedRevision: f.formal.revision });
      Object.assign(document, { content: next.content, revision: 2, published_revision: next.revision, published_document_revision: 2, base_content: scenario.baseline });
      if (scenario.current !== original) {
        if (scenario.current === null) rmSync(join(f.source, oldPath)); else f.write(oldPath, scenario.current);
        f.git("-C", f.source, "add", "-A"); f.git("-C", f.source, "commit", "-m", "independent repository edit"); f.git("-C", f.source, "push", f.remote, "main");
      }
      const before = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
      if (scenario.allowed) {
        const result = await f.publish();
        assert.equal(f.content(result.revision!, oldPath), updated);
        assert.equal(f.content(result.revision!, "code.ts"), "export const untouched = true;\n");
        assert.equal(f.mrs.length, 1);
      } else {
        await assert.rejects(f.publish(), /归档文件.*已变化或缺少原始内容.*未覆盖/);
        assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), before, "拒绝操作不推送分支或改远端");
        assert.equal(f.requests.length, 0, "有冲突时不创建 MR");
      }
      if (scenario.current === null) assert.equal(f.tree("main", oldPath), "");
      else assert.equal(f.content("main", oldPath), scenario.current);
      assert.equal(document.content, updated, "归档冲突不丢失已完成的研究文稿");
    } finally { await f.close(); }
  });
});

test("共享仓归档：普通更新沿用已推送快照，推送后保存中断可恢复同一分支", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first); f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const document = f.job.documents[0];
    const next = saveKnowledgeDocument(f.dir, { ...f.formal, content: updated }, "alice", f.formal.id, { expectedRevision: f.formal.revision });
    Object.assign(document, { content: next.content, revision: 2, published_revision: next.revision, published_document_revision: 2 });
    assert.equal(document.base_content, null, "首次新增没有源码基线，后续使用已推送正文作为基线");
    await assert.rejects(f.publish(undefined, publication => {
      if (publication.documents.length) throw new Error("模拟推送后记录写失败");
      f.save(publication);
    }), /模拟推送后记录写失败/);
    const attempted = f.last();
    assert.ok(attempted.revision);
    assert.equal(f.git("-C", f.remote, "rev-parse", attempted.branch), attempted.revision);
    assert.equal(f.content(attempted.revision!, oldPath), updated);
    const recovered = await f.publish({ ...attempted, state: "failed" });
    assert.equal(recovered.branch, attempted.branch);
    assert.equal(recovered.revision, attempted.revision);
    assert.equal(f.mrs.length, 2, "首次归档和新版本各一个 MR，恢复不重复提交");
    assert.equal(f.content("main", oldPath), original, "新版本在 MR 分支等待审阅");
  } finally { await f.close(); }
});

function moduleJob(f: Awaited<ReturnType<typeof fixture>>, moduleId: string, bases = ["docs/knowledge"]): DomainKnowledgeJob {
  createBusinessModule(f.dir, { id: moduleId, name: `业务模块 ${moduleId}`, description: "共享仓内的独立业务范围", owner: "alice", repositories: ["https://example.test/shared.git"] }, "alice");
  const targets = bases.map((base, index) => ({ ...f.target, id: index ? `repo-${index}` : "domain", docs_path: `${base}/${moduleId}` }));
  const documents = targets.map(target => {
    const path = `${target.docs_path}/README.md`;
    const formal = saveKnowledgeDocument(f.dir, { title: `${moduleId} 的模块入口`, content: `# ${moduleId}\n\n本模块已经核对的业务范围与文稿索引。\n`, scope: "module", module_ids: [moduleId],
      archive_target: { repository: target.repository, branch: target.branch, path } }, "alice");
    return { id: `readme-${target.id}`, title: formal.title, target_id: target.id, layer: target.id === "domain" ? "domain" as const : "repository" as const, path,
      content: formal.content, sources: "已确认的业务范围与源码", selected: true, revision: 1, base_content: null, base_revision: f.baseline, history: [],
      knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 };
  });
  return { ...f.job, id: `dkx-${randomUUID()}`, module_id: moduleId, knowledge_layout: "module-v1", knowledge_target: targets[0], repositories: targets.slice(1), documents,
    publications: [], archive_batches: [], publication_history: [] };
}

test("共享仓模块导航：归档覆盖旧根正文，同目录的两个模块共享完整通用导航", { timeout: 20_000 }, async () => {
  const manual = "# 仓库维护规范\r\n\r\n构建命令和审阅要求由仓库维护人管理。\r\n";
  const f = await fixture({ "AGENTS.md": manual });
  try {
    const a = moduleJob(f, "orders"), first = await f.publisher.publish(a, a.knowledge_target, undefined, "alice", f.save);
    const firstRoot = f.content(first.revision!, "AGENTS.md");
    assert.match(firstRoot, /^# AGENTS\.md — 仓库知识导航\n/);
    assert.doesNotMatch(firstRoot, /仓库维护规范|构建命令和审阅要求由仓库维护人管理/);
    assert.doesNotMatch(firstRoot, /<!--|mae-flow:module-knowledge/);
    assert.match(firstRoot, /docs\/knowledge\//);
    assert.match(firstRoot, /只读相关模块.*按需读取/s);
    assert.match(firstRoot, /不全量加载知识目录/);
    assert.match(firstRoot, /范围、版本与来源/);
    assert.match(firstRoot, /当前行为查源码和配置，业务目标及约束查资料/);
    assert.match(firstRoot, /不推广全仓/);
    assert.ok(firstRoot.length < 1000, "通用指引保持简短，不随模块数量堆叠规则");
    assert.doesNotMatch(firstRoot, /orders/, "共享入口不包含当前任务的模块名或编号");
    assert.equal(f.content(`${first.revision}^`, "AGENTS.md"), manual, "旧根正文仍可从 Git 历史找回");
    assert.equal(first.documents.length, 1, "派生根入口不作为模块的正式知识");
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    const adjusted = firstRoot.replace("只读相关模块", "每次加载所有模块") + "\n人工补充：共享代码改动需要跨模块核对。\n";
    f.write("AGENTS.md", adjusted); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "maintainer adjusts navigation"); f.git("-C", f.source, "push", f.remote, "main");
    const b = moduleJob(f, "billing"), second = await f.publisher.publish(b, b.knowledge_target, undefined, "alice", f.save);
    assert.equal(f.content(second.revision!, "AGENTS.md"), firstRoot, "新归档按统一格式重建根导航，不保留旧根的人工补充");
    assert.equal(f.content(`${second.revision}^`, "AGENTS.md"), adjusted);
    assert.equal(f.content(second.revision!, a.documents[0].path), a.documents[0].content);
    assert.equal(f.content(second.revision!, b.documents[0].path), b.documents[0].content);
    assert.deepEqual(f.git("-C", f.remote, "diff", "--name-only", `${second.revision}^`, second.revision!).split("\n"), ["AGENTS.md", b.documents[0].path], "根覆盖在 MR 差异中可见");
    assert.equal(f.content(second.revision!, "code.ts"), "export const untouched = true;\n");
  } finally { await f.close(); }
});

test("共享仓模块导航：正式模块位置补全自定义目录，后续从可读索引继续发现", { timeout: 30_000 }, async () => {
  const sourceReadme = "源码模块说明，不是归档知识入口。\n";
  const f = await fixture({ "src/orders/README.md": sourceReadme });
  try {
    const base = "handbook/业务`knowledge", a = moduleJob(f, "orders", [base]);
    const first = await f.publisher.publish(a, a.knowledge_target, undefined, "alice", f.save);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write("AGENTS.md", "# 原有仓库说明\n这是没有平台目录标记的旧根。\n");
    f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "unmanaged root"); f.git("-C", f.source, "push", f.remote, "main");
    const b = moduleJob(f, "billing"), second = await f.publisher.publish(b, b.knowledge_target, undefined, "alice", f.save);
    const secondRoot = f.content(second.revision!, "AGENTS.md");
    assert.ok(secondRoot.includes(`${base}/`), "当前任务之外已归档模块的正式位置提供自定义目录");
    assert.match(secondRoot, /docs\/knowledge\//);
    assert.doesNotMatch(secondRoot, /<!--|mae-flow:module-knowledge/);
    assert.doesNotMatch(secondRoot, /src\/|原有仓库说明|没有平台目录标记/);
    assert.equal(f.content(second.revision!, "src/orders/README.md"), sourceReadme, "不扫描或改写源码目录");
    f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    const previous = readKnowledgeDocument(f.dir, a.documents[0].knowledge_document_id!);
    saveKnowledgeDocument(f.dir, { ...previous, archive_target: { repository: f.target.repository, branch: "main", path: "relocated/knowledge/orders/README.md" } }, "alice", previous.id, { expectedRevision: previous.revision });
    const c = moduleJob(f, "reporting"), third = await f.publisher.publish(c, c.knowledge_target, undefined, "alice", f.save);
    assert.equal(f.content(third.revision!, "AGENTS.md"), secondRoot, "正式位置变更尚未归档时，可读索引仍能发现 Git 中现有模块入口，包括含反引号的目录");
    assert.equal(f.content(third.revision!, a.documents[0].path), a.documents[0].content);
  } finally { await f.close(); }
});

test("共享仓模块导航：已归档的避让入口在其他目录归档后仍可发现，正式位置也能恢复入口", { timeout: 30_000 }, async () => {
  const f = await fixture({ "src/orders/README-source-2.md": "源码目录中的同名文件。\n" });
  try {
    const base = "handbook/archived", a = moduleJob(f, "orders", [base]), document = a.documents[0];
    const previous = readKnowledgeDocument(f.dir, document.knowledge_document_id!);
    document.path = `${base}/orders/README-${document.id}-2.md`;
    const formal = saveKnowledgeDocument(f.dir, { ...previous, archive_target: { repository: f.target.repository, branch: "main", path: document.path } }, "alice", previous.id, { expectedRevision: previous.revision });
    document.published_revision = formal.revision;
    const first = await f.publisher.publish(a, a.knowledge_target, undefined, "alice", f.save);
    assert.equal(f.tree(first.revision!, `${base}/orders/README.md`), "", "只归档避让后的入口，不新建或覆盖 canonical README");
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const b = moduleJob(f, "billing"), second = await f.publisher.publish(b, b.knowledge_target, undefined, "alice", f.save);
    const root = f.content(second.revision!, "AGENTS.md");
    assert.ok(root.includes(`${base}/`), "已知旧目录只含 README-id-2.md 时也继续保留入口");
    assert.match(root, /docs\/knowledge\//);
    assert.ok(root.includes("`README-*.md` 时一并核对入口"));
    assert.doesNotMatch(root, /src\//, "不会扫描源码里的同名 README 推断归档目录");
    assert.equal(f.content(second.revision!, document.path), document.content);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write("AGENTS.md", "# 未管理的旧根\n");
    f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "remove root directory index"); f.git("-C", f.source, "push", f.remote, "main");
    const c = moduleJob(f, "reporting", ["guides/knowledge"]), third = await f.publisher.publish(c, c.knowledge_target, undefined, "alice", f.save);
    assert.ok(f.content(third.revision!, "AGENTS.md").includes(`${base}/`), "正式模块位置中的避让入口也能补回缺失的根目录记录");
    assert.equal(f.content(third.revision!, document.path), document.content);
  } finally { await f.close(); }
});

test("共享仓模块导航：旧平台块只恢复校验过的目录，空目录与软链接入口不进入新根", { timeout: 20_000 }, async () => {
  const base = "handbook/legacy", hash = createHash("sha256").update(base).digest("hex").slice(0, 16);
  const oldRoot = "# 旧规范\n旧命令：never-run-this\n\n"
    + `<!-- mae-flow:module-knowledge:${hash}:start -->\n业务模块知识保存在 \` ${base}/ \` 的各子目录。\n旧平台正文不得沿用。\n<!-- mae-flow:module-knowledge:${hash}:end -->\n`
    + `<!-- mae-flow:module-knowledge:${hash}:start -->\n业务模块知识保存在 \` src/ \` 的各子目录。\n<!-- mae-flow:module-knowledge:${hash}:end -->\n`
    + '<!-- mae-flow:module-knowledge-bases:v1 ["removed/knowledge","links","nested"] -->\n';
  const f = await fixture({ "AGENTS.md": oldRoot, [`${base}/archived/README.md`]: "已有归档知识入口。\n",
    "src/orders/README.md": "源码说明。\n", "nested/group/old/README.md": "不是 base 直属模块入口。\n" });
  try {
    mkdirSync(join(f.source, "links", "orders"), { recursive: true });
    symlinkSync("../../code.ts", join(f.source, "links", "orders", "README.md"));
    f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "symlink readme"); f.git("-C", f.source, "push", f.remote, "main");
    const job = moduleJob(f, "billing"), result = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    const root = f.content(result.revision!, "AGENTS.md");
    assert.match(root, /handbook\/legacy\//);
    assert.match(root, /docs\/knowledge\//);
    assert.doesNotMatch(root, /<!--|mae-flow:module-knowledge|旧规范|never-run-this|旧平台正文|:start|src\/|removed\/|links|nested/);
    assert.equal(f.content(`${result.revision}^`, "AGENTS.md"), oldRoot, "旧正文仅留在 Git 历史中");
    assert.equal(f.content(result.revision!, `${base}/archived/README.md`), "已有归档知识入口。\n");
  } finally { await f.close(); }
});

test("共享仓模块导航：完整导航列出同仓两种知识目录，推送后保存中断恢复不改写提交", { timeout: 20_000 }, async () => {
  const f = await fixture({ "other/knowledge/catalog/README.md": "已有 Git 文件，尚无正式模块位置。\n" });
  try {
    const job = moduleJob(f, "orders", ["domain-docs", "docs/knowledge"]);
    await assert.rejects(f.publisher.publish(job, job.knowledge_target, undefined, "alice", publication => {
      if (publication.documents.length) throw new Error("模拟推送后记录写失败");
      f.save(publication);
    }), /模拟推送后记录写失败/);
    const attempted = f.last();
    const root = f.content(attempted.revision!, "AGENTS.md");
    assert.doesNotMatch(root, /<!--|mae-flow:module-knowledge/);
    assert.equal((root.match(/## 模块索引/g) ?? []).length, 1);
    assert.match(root, /domain-docs\//); assert.match(root, /docs\/knowledge\//);
    assert.doesNotMatch(root, /orders/);
    moduleJob(f, "catalog", ["other/knowledge"]);
    const recovered = await f.publisher.publish(job, job.knowledge_target, { ...attempted, state: "failed" }, "alice", f.save);
    assert.equal(recovered.branch, attempted.branch); assert.equal(recovered.revision, attempted.revision);
    assert.equal(f.content(recovered.revision!, "AGENTS.md"), root);
    assert.doesNotMatch(root, /other\/knowledge/, "已推送恢复不因后来新增的正式模块位置改写原 SHA");
    assert.equal(recovered.documents.length, 2);
    assert.equal(listKnowledgeDocuments(f.dir).filter(document => document.archive_target?.path === "AGENTS.md").length, 0);
    assert.equal(f.mrs.length, 1);
  } finally { await f.close(); }
});

test("共享仓模块导航：根入口为符号链接或目录时拒绝归档，模块不能提交根文件正文", { timeout: 40_000 }, async t => {
  for (const kind of ["symlink", "directory", "module-root-write"]) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const job = moduleJob(f, "orders");
      if (kind === "module-root-write") job.documents[0].path = "AGENTS.md";
      else {
        if (kind === "symlink") symlinkSync("code.ts", join(f.source, "AGENTS.md"));
        else f.write("AGENTS.md/nested.md", "保留已有目录\n");
        f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "non-file agent path"); f.git("-C", f.source, "push", f.remote, "main");
      }
      const before = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
      await assert.rejects(f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save), kind === "module-root-write" ? /本模块文稿须保存在/ : /文档路径不是普通文件/);
      assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), before);
      assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
});

test("共享仓模块导航：自定义目录含反引号时仍生成完整的 Markdown 代码路径", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const base = "docs/know`ledge-->目录", job = moduleJob(f, "orders", [base]);
    const result = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    const root = f.content(result.revision!, "AGENTS.md");
    assert.ok(root.includes(`\`\` ${base}/ \`\``), "围栏不能被路径中的反引号提前结束");
    assert.doesNotMatch(root, /<!--|mae-flow:module-knowledge/, "路径仅出现在可读索引，不再写入隐藏标记");
    assert.ok(root.includes("## 模块索引\n"), "自定义路径不作为 Markdown 标题源码");
    assert.ok(root.includes("## 阅读与维护约定\n"));
    assert.equal(f.content(result.revision!, job.documents[0].path), job.documents[0].content);
  } finally { await f.close(); }
});

test("共享仓目录整理：已完成旧任务保留历史归档，迁移归档重写公共根并保留公共文稿", { timeout: 30_000 }, async () => {
  const manual = "# 仓库公共规范\n保持人工维护的构建约定。\n";
  const f = await fixture({ "AGENTS.md": manual, [oldPath]: original });
  try {
    f.job.documents[0].base_content = original;
    const rootFormal = saveKnowledgeDocument(f.dir, { title: "旧任务导航", content: manual, scope: "platform",
      archive_target: { repository: f.target.repository, branch: f.target.branch, path: "AGENTS.md" } }, "alice");
    f.job.documents.push({ ...f.job.documents[0], id: "root", title: rootFormal.title, path: "AGENTS.md", content: manual,
      base_content: manual, knowledge_document_id: rootFormal.id, published_revision: rootFormal.revision });
    const legacy = await f.publish(); f.freeze(legacy); f.git("-C", f.remote, "update-ref", "refs/heads/main", legacy.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    const currentRoot = manual + "\n另一业务模块补充的公共规则。\n", currentPublic = original + "\n其他维护人的公共说明。\n";
    f.write("AGENTS.md", currentRoot); f.write(oldPath, currentPublic);
    f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "shared documentation advances"); f.git("-C", f.source, "push", f.remote, "main");
    createBusinessModule(f.dir, { id: "orders", name: "订单模块", description: "共享仓内的订单范围", owner: "alice", repositories: ["https://example.test/shared.git"] }, "alice");
    f.job.module_id = "orders"; f.job.knowledge_layout = "module-v1";
    f.job.knowledge_target = { ...f.target, docs_path: "docs/knowledge/orders" };
    const formalIds = f.job.documents.map(document => document.knowledge_document_id);
    for (const document of f.job.documents) {
      const path = document.path === "AGENTS.md" ? "docs/knowledge/orders/README.md" : "docs/knowledge/orders/SONCommMgr/SONCommMgr.md";
      const previous = readKnowledgeDocument(f.dir, document.knowledge_document_id!);
      const formal = saveKnowledgeDocument(f.dir, { ...previous, archive_target: { repository: f.target.repository, branch: f.target.branch, path } }, "alice", previous.id, { expectedRevision: previous.revision });
      Object.assign(document, { path, base_content: null, base_revision: "", published_revision: formal.revision }); delete document.base_path;
    }
    const migrated = await f.publisher.publish(f.job, f.job.knowledge_target, undefined, "alice", f.save);
    assert.deepEqual(migrated.documents.map(document => document.knowledge_document_id), formalIds, "迁移保留正式知识身份");
    assert.match(f.content(migrated.revision!, "AGENTS.md"), /^# AGENTS\.md — 仓库知识导航\n/);
    assert.doesNotMatch(f.content(migrated.revision!, "AGENTS.md"), /人工维护的构建约定|另一业务模块补充的公共规则/);
    assert.equal(f.content(`${migrated.revision}^`, "AGENTS.md"), currentRoot, "根覆盖保留在 Git 历史中，不再沿用旧正文");
    assert.equal(f.content(migrated.revision!, oldPath), currentPublic, "公共 docs 文件保留其他模块及人工内容");
    for (const document of f.job.documents) assert.equal(f.content(migrated.revision!, document.path), document.content);
    assert.equal(f.job.archive_batches?.[0].publications[0].revision, legacy.revision, "历史归档继续可追溯");
  } finally { await f.close(); }
});

test("共享仓目录整理：已归档的旧父 AGENTS 随入口迁移，人工修改或其他知识占用时拒绝删除", { timeout: 50_000 }, async t => {
  for (const state of ["unchanged", "modified", "other-owner"]) await t.test(state, async () => {
    const parentAgent = "domain-docs/AGENTS.md", f = await fixture({ [parentAgent]: original });
    try {
      const document = f.job.documents[0];
      const firstFormal = saveKnowledgeDocument(f.dir, { ...f.formal, archive_target: { repository: f.target.repository, branch: "main", path: parentAgent } }, "alice", f.formal.id, { expectedRevision: f.formal.revision });
      Object.assign(document, { path: parentAgent, base_content: original, published_revision: firstFormal.revision });
      const legacy = await f.publish(); f.freeze(legacy); f.git("-C", f.remote, "update-ref", "refs/heads/main", legacy.revision!);
      if (state === "modified") {
        f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
        f.write(parentAgent, original + "\n其他模块后来补充的规则。\n");
        f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "shared parent rules advance"); f.git("-C", f.source, "push", f.remote, "main");
      }
      createBusinessModule(f.dir, { id: "orders", name: "订单模块", description: "订单业务范围", owner: "alice", repositories: ["https://example.test/shared.git"] }, "alice");
      f.job.module_id = "orders"; f.job.knowledge_layout = "module-v1";
      f.job.knowledge_target = { ...f.target, docs_path: "domain-docs/orders" };
      const path = "domain-docs/orders/index.md";
      const relocated = saveKnowledgeDocument(f.dir, { ...firstFormal, scope: "module", module_ids: ["orders"], archive_target: { repository: f.target.repository, branch: "main", path } }, "alice", firstFormal.id, { expectedRevision: firstFormal.revision });
      Object.assign(document, { path, base_content: null, base_revision: "", published_revision: relocated.revision }); delete document.base_path;
      if (state === "other-owner") saveKnowledgeDocument(f.dir, { title: "仍使用旧父入口的其他知识", content: original, scope: "platform", archive_target: { repository: f.target.repository, branch: "main", path: parentAgent } }, "alice");
      const before = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
      if (state !== "unchanged") {
        await assert.rejects(f.publisher.publish(f.job, f.job.knowledge_target, undefined, "alice", f.save), state === "modified" ? /原文件.*已被修改/ : /原路径.*已被其他正式知识使用/);
        assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), before);
        assert.notEqual(f.tree("main", parentAgent), "", "未确认内容或归属时不删除旧入口");
      } else {
        const result = await f.publisher.publish(f.job, f.job.knowledge_target, undefined, "alice", f.save);
        assert.equal(f.tree(result.revision!, parentAgent), "", "移除会继续作用于新模块目录的已归档旧父入口");
        assert.equal(f.content(result.revision!, path), original);
        assert.match(f.content(result.revision!, "AGENTS.md"), /^# AGENTS\.md — 仓库知识导航\n/);
        assert.equal(f.content(`${result.revision}^`, parentAgent), original);
      }
    } finally { await f.close(); }
  });
});

test("共享仓目录整理：冻结的本模块旧目录可以安全改名，根导航移除已空目录", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const job = moduleJob(f, "orders"), first = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    job.archive_batches = [{ id: randomUUID(), created_at: new Date().toISOString(), operator: "alice", state: "done", documents: structuredClone(job.documents),
      targets: [structuredClone(job.knowledge_target)], publications: [structuredClone(first)] }];
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const document = job.documents[0], beforePath = document.path;
    job.knowledge_target = { ...job.knowledge_target, docs_path: "guides/knowledge/orders" };
    document.path = "guides/knowledge/orders/README.md";
    const previous = readKnowledgeDocument(f.dir, document.knowledge_document_id!);
    const formal = saveKnowledgeDocument(f.dir, { ...previous, archive_target: { repository: f.target.repository, branch: f.target.branch, path: document.path } }, "alice", previous.id, { expectedRevision: previous.revision });
    document.published_revision = formal.revision;
    const moved = await f.publisher.publish(job, job.knowledge_target, undefined, "alice", f.save);
    assert.equal(f.tree(moved.revision!, beforePath), "", "冻结目录证明这是本模块自己的旧文稿");
    assert.equal(f.content(moved.revision!, document.path), document.content);
    const root = f.content(moved.revision!, "AGENTS.md");
    assert.match(root, /guides\/knowledge\//);
    assert.doesNotMatch(root, /docs\/knowledge/);
    assert.equal(f.content(`${moved.revision}^`, "AGENTS.md"), f.content(first.revision!, "AGENTS.md"));
  } finally { await f.close(); }
});
