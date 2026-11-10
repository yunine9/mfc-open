import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { KnowledgeSourceCleanup } from "../src/knowledgeSourceCleanup.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { DomainKnowledgeJob, KnowledgeCleanupPublication } from "../src/domainKnowledgeTypes.ts";

const config = { issue_no: "REQ-cleanup", issue_description: "清理旧知识并重新萃取", title: "订单", scope: "订单业务规则",
  repositories: [{ repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/old" }] };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

for (const layout of ["module-v1", "repository-v1", "directory-v1"] as const) {
  test(`${layout} 清理：允许旧目录、非 Markdown 和 AGENTS.md，整批校验路径及预览选择`, async () => {
    const targets = [1, 2].map(index => ({ id: `repo-${index}`, name: `业务仓${index}`, repository: `https://example.test/repo-${index}.git`, branch: "main", path: "", docs_path: "docs/new" }));
    const calls: Array<{ action: string; paths: unknown }> = [];
    const cleanup = new KnowledgeSourceCleanup({
      async previewCleanup(target, paths) {
        calls.push({ action: "preview", paths });
        const entries = (paths as string[]).flatMap(path => path === "docs/old"
          ? ["docs/old/old.json", "docs/old/readme.md"] : [path])
          .map(path => ({ path, mode: "100644", oid: "a".repeat(40) }));
        return { id: `plan-${target.id}`, target_id: target.id, paths: paths as string[], target_revision: "a".repeat(40), entries };
      },
      async publishCleanup(_job, target, plan, paths) {
        calls.push({ action: "publish", paths });
        return { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: paths as string[], documents: [], branch: `cleanup-${target.id}`, state: "opened", url: `https://example.test/mr/${target.id}` };
      },
    });
    const job: DomainKnowledgeJob = { id: "dkx-cleanup", ...config, module_id: "orders", knowledge_layout: layout, operator: "alice", created_at: "now", status: "idle", stage: "等待清理",
      knowledge_target: { ...targets[0], id: "domain", repository: "" }, repositories: targets, material_ids: [], revisions: {}, documents: [], turns: [], evidence: [], publications: [],
      source_cleanup: { repositories: targets, plans: [], publications: [] } };
    const signal = new AbortController().signal;
    let saves = 0; const save = () => { saves++; };
    for (const path of [".", "/docs/old", "../docs/old", "docs/../old", ".git/config"]) {
      await assert.rejects(cleanup.action(job, "preview", { paths_by_target: { "repo-1": ["docs/old"], "repo-2": [path] } }, "alice", save, signal), /清理路径须为仓内相对/);
    }
    assert.equal(calls.length, 0, "第二仓路径无效时，第一仓也不能开始预览");
    assert.equal(saves, 0);
    await cleanup.action(job, "preview", { paths_by_target: { "repo-1": ["docs/old"], "repo-2": ["AGENTS.md", "legacy/diagram.puml"] } }, "alice", save, signal);
    assert.equal(job.source_cleanup!.plans[0].entries.length, 2, "目录展开为文件清单");
    const selected = { "repo-1": ["docs/old/old.json"], "repo-2": ["AGENTS.md", "legacy/diagram.puml"] };
    await assert.rejects(cleanup.action(job, "publish", { selected_paths_by_target: { ...selected, "repo-2": ["unpreviewed.txt"] } }, "alice", save, signal), /清理预览或文件选择无效/);
    assert.equal(calls.filter(call => call.action === "publish").length, 0);
    job.source_cleanup!.plans[1].paths = ["../outside"];
    await assert.rejects(cleanup.action(job, "publish", { selected_paths_by_target: selected }, "alice", save, signal), /清理路径须为仓内相对/);
    job.source_cleanup!.plans[1].paths = ["AGENTS.md", "legacy/diagram.puml"];
    await cleanup.action(job, "publish", { selected_paths_by_target: selected }, "alice", save, signal);
    assert.deepEqual(calls.filter(call => call.action === "publish").map(call => call.paths), Object.values(selected));
  });
}

test("萃取前清理：勾选后先保存待清理任务，不执行研究；重启保留，人工开始后才执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-prepare-")); let executions = 0;
  const execute = async () => { executions++; return "已完成"; };
  let manager = new DomainKnowledgeExtraction(dir, execute);
  try {
    const job = manager.create({ ...config, prepare_cleanup: true }, "alice");
    assert.equal(job.status, "idle", "选择清理后不能直接开始萃取");
    assert.equal(job.production?.status_label, "待清理旧知识");
    assert.equal(job.turns.length, 0); assert.equal(executions, 0);
    assert.equal((job as any).source_cleanup.repositories.length, 1);
    await manager.shutdown(); manager = new DomainKnowledgeExtraction(dir, execute);
    assert.equal(manager.get(job.id).status, "idle"); assert.equal(executions, 0);
    await (manager as any).sourceCleanupAction(job.id, "start", {}, "alice");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 1);
    assert.equal((manager.get(job.id) as any).source_cleanup.started, true);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("清理预览与 MR：保留勾选外文件，只删除预览中的旧文件，响应丢失重试沿用 MR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-git-")), source = join(dir, "source"), remote = join(dir, "remote.git");
  mkdirSync(source); git(source, "init", "-b", "main"); git(source, "config", "user.name", "fixture"); git(source, "config", "user.email", "fixture@example.test");
  mkdirSync(join(source, "docs/old"), { recursive: true });
  writeFileSync(join(source, "docs/old/remove.md"), "旧知识"); writeFileSync(join(source, "docs/old/keep.md"), "保留的知识");
  writeFileSync(join(source, "AGENTS.md"), "保留的仓库指引"); writeFileSync(join(source, "code.ts"), "export const truth = 1;");
  git(source, "add", "."); git(source, "commit", "-m", "fixture"); git(dir, "clone", "--bare", source, remote);
  const mrs: any[] = []; let loseResponse = true, queries = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json"); const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/mr/discover") { queries++; res.end(JSON.stringify({ mrs })); }
    else if (url.pathname === "/mr") {
      let text = ""; for await (const part of req) text += part;
      const body = JSON.parse(text); assert.equal(body.dts_no, config.issue_no); assert.equal(body.title, config.issue_description);
      const mr = { id: 1, url: "https://example.test/mr/1", source_branch: body.source_branch, target_branch: body.target_branch }; mrs.push(mr);
      if (loseResponse) { loseResponse = false; res.statusCode = 502; res.end("{}"); } else res.end(JSON.stringify(mr));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => `http://127.0.0.1:${(server.address() as any).port}`,
    credential: () => ({ username: "fixture", password: "fixture-password", email: "fixture@example.test" }) });
  const target = { id: "repo-1", name: "订单仓", repository: remote, branch: "main", path: "", docs_path: "docs/old" };
  const job = { id: "cleanup-fixture", ...config };
  let publication: any;
  try {
    let plan = await publisher.previewCleanup(target, ["docs/old", "AGENTS.md"], "alice");
    assert.deepEqual(plan.entries.map((entry: any) => entry.path), ["AGENTS.md", "docs/old/keep.md", "docs/old/remove.md"]);
    for (const path of [".", "/", ".git", "../outside"]) await assert.rejects(publisher.previewCleanup(target, [path], "alice"), /相对路径/);
    writeFileSync(join(source, "docs/old/keep.md"), "人工刚更新的知识"); git(source, "add", "."); git(source, "commit", "-m", "update old knowledge"); git(source, "push", remote, "HEAD:main");
    await assert.rejects(publisher.publishCleanup(job, target, plan, ["docs/old/remove.md"], undefined, "alice", () => {}), /已变化.*重新预览/);
    assert.equal(mrs.length, 0);
    plan = await publisher.previewCleanup(target, ["docs/old", "AGENTS.md"], "alice");
    await assert.rejects((publisher as any).publishCleanup(job, target, plan, ["code.ts"], undefined, "alice", () => {}), /预览/);
    const save = (next: any) => { publication = structuredClone(next); };
    await assert.rejects((publisher as any).publishCleanup(job, target, plan, ["docs/old/remove.md"], undefined, "alice", save), /502|MR 创建/);
    assert.ok(publication.revision); assert.equal(mrs.length, 1);
    assert.equal(publication.branch, "main_fixture_REQ-cleanup", "清理 MR 沿用需求的分支命名要求");
    assert.equal(git(remote, "log", "-1", "--format=%s", publication.branch), "[REQ_cleanup][feat]清理萃取前旧知识", "保持原提交信息");
    const firstBranch = publication.branch;
    publication = await (publisher as any).publishCleanup(job, target, plan, ["docs/old/remove.md"], publication, "alice", save);
    assert.equal(publication.branch, firstBranch); assert.equal(publication.url, mrs[0].url); assert.equal(mrs.length, 1);
    assert.equal(git(remote, "ls-tree", "-r", "--name-only", publication.branch), "AGENTS.md\ncode.ts\ndocs/old/keep.md");
    assert.equal(git(remote, "show", "main:docs/old/remove.md"), "旧知识", "基准分支须保持不变，等待人审查合入");
    const before = queries;
    await (publisher as any).publishCleanup(job, target, plan, ["docs/old/remove.md"], publication, "alice", save);
    assert.equal(queries, before, "已有 MR 不再查询状态或创建第二个 MR");
    assert.equal(readFileSync(join(source, "code.ts"), "utf8"), "export const truth = 1;");
  } finally { await publisher.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("清理分支：多仓按各自基准分支命名，旧失败记录按远端实际状态恢复，同名外部分支不被覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-naming-")), requests: any[] = [];
  const targets = ["master", "release/current"].map((branch, index) => {
    const source = join(dir, `source-${index}`), remote = join(dir, `remote-${index}.git`);
    mkdirSync(source); git(source, "init", "-b", branch); git(source, "config", "user.name", "fixture"); git(source, "config", "user.email", "fixture@example.test");
    mkdirSync(join(source, "docs")); writeFileSync(join(source, "docs/old.md"), "旧知识"); writeFileSync(join(source, "code.ts"), "源码");
    git(source, "add", "."); git(source, "commit", "-m", "fixture"); git(dir, "clone", "--bare", source, remote);
    return { id: `repo-${index + 1}`, name: `仓-${index + 1}`, repository: remote, branch, path: "", docs_path: "docs" };
  });
  const server = createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part; requests.push(JSON.parse(text));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: requests.length, url: `https://example.test/mr/${requests.length}` }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => `http://127.0.0.1:${(server.address() as any).port}`,
    credential: () => ({ username: "git-worker", password: "fixture-password", email: "fixture@example.test" }) });
  const job = { id: "naming-fixture", ...config, issue_no: "REQ123", issue_description: "核对订单规则" };
  try {
    for (const target of targets) {
      const plan = await publisher.previewCleanup(target, ["docs"], "platform-login");
      const previous: KnowledgeCleanupPublication = { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: ["docs/old.md"], branch: "codex/knowledge-old-failure",
        revision: "a".repeat(40), state: "failed", documents: [] };
      const publication = await publisher.publishCleanup(job, target, plan, ["docs/old.md"], previous, "platform-login", () => {});
      assert.equal(publication.branch, `${target.branch}_git-worker_REQ123`, "工号采用个人 Git 账号，与需求交付一致");
      assert.equal(git(target.repository, "log", "-1", "--format=%s", publication.branch), "[REQ123][feat]清理萃取前旧知识");
      assert.equal(requests.at(-1).source_branch, publication.branch); assert.equal(requests.at(-1).target_branch, target.branch);
      assert.equal(requests.at(-1).title, job.issue_description); assert.equal(requests.at(-1).dts_no, job.issue_no);
    }
    const target = targets[0], plan = await publisher.previewCleanup(target, ["docs"], "platform-login");
    const oldBranch = "codex/knowledge-pushed-old", oldRevision = git(target.repository, "rev-parse", "master_git-worker_REQ123");
    git(target.repository, "update-ref", `refs/heads/${oldBranch}`, oldRevision);
    const old: KnowledgeCleanupPublication = { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: ["docs/old.md"], branch: oldBranch,
      revision: oldRevision, state: "failed", documents: [] };
    const resumed = await publisher.publishCleanup(job, target, plan, ["docs/old.md"], old, "platform-login", () => {});
    assert.equal(resumed.branch, oldBranch, "已经推送的旧分支保持原记录，不擅自更名或重写远端");
    assert.equal(git(target.repository, "rev-parse", oldBranch), oldRevision); assert.equal(requests.at(-1).source_branch, oldBranch);
    const branch = "master_git-worker_REQ456", before = git(target.repository, "rev-parse", "master");
    git(target.repository, "update-ref", `refs/heads/${branch}`, before);
    await assert.rejects(publisher.publishCleanup({ ...job, issue_no: "REQ456" }, target, plan, ["docs/old.md"], undefined, "platform-login", () => {}), /已有|同名/);
    assert.equal(git(target.repository, "rev-parse", branch), before); assert.equal(requests.length, 3, "同名外部分支不能推送或创建 MR");
  } finally { await publisher.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

function cleanupFixture(dir: string, calls: string[], failures = false) {
  let fail = failures;
  const publisher: Pick<KnowledgeMrPublisher, "previewCleanup" | "publishCleanup"> = {
    async previewCleanup(target, paths) {
      const entries = (paths as string[]).map(path => ({ path: `${path}/old.md`, mode: "100644", oid: "a".repeat(40) }));
      return { id: `plan-${target.id}`, target_id: target.id, paths: paths as string[], target_revision: "a".repeat(40), entries, selected_paths: entries.map(entry => entry.path) };
    },
    async publishCleanup(job, target, plan, paths, previous, operator, save) {
      calls.push(target.id);
      const publication: KnowledgeCleanupPublication = { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: paths as string[], documents: [], branch: previous?.branch || `codex/cleanup-${target.id}`, state: "pending" };
      save(publication);
      if (fail && target.id === "repo-2") { fail = false; throw new Error("暂时无法创建 MR"); }
      return { ...publication, state: "opened", url: `https://example.test/mr/${target.id}` };
    },
  };
  const options = { sourceCleanup: new KnowledgeSourceCleanup(publisher) };
  return { options, manager: new DomainKnowledgeExtraction(dir, async () => "done", options) };
}

test("清理 HTTP：多仓部分失败保留成功 MR，重启不自动执行，人工重试只处理失败仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-http-")), calls: string[] = [];
  const fixture = cleanupFixture(dir, calls, true); let manager = fixture.manager;
  const service = { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => manager } as any;
  const server = createServer(async (request, response) => {
    const parts = request.url!.split("/").filter(Boolean);
    await domainKnowledgeRoute(request, response, parts, service, "alice", async req => {
      let text = ""; for await (const part of req) text += part; return JSON.parse(text);
    }, (res, status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (path: string, body: any) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  try {
    const job = manager.create({ ...config, prepare_cleanup: true, repositories: [config.repositories[0], { ...config.repositories[0], repository: "https://example.test/payments.git" }] }, "alice");
    const endpoint = `/domain-extraction/${job.id}/source-cleanup`;
    await post(`${endpoint}/preview`, { paths_by_target: { "repo-1": ["docs/old"], "repo-2": ["docs/old"] } });
    const input = { selected_paths_by_target: { "repo-1": ["docs/old/old.md"], "repo-2": ["docs/old/old.md"] } };
    const partial = await post(`${endpoint}/publish`, input);
    assert.deepEqual(calls, ["repo-1", "repo-2"]);
    assert.equal(partial.source_cleanup.publications[0].state, "opened"); assert.equal(partial.source_cleanup.publications[1].state, "failed");
    assert.equal(partial.production.status_label, "清理 MR 创建失败");
    await manager.shutdown(); manager = new DomainKnowledgeExtraction(dir, async () => "done", fixture.options);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2);
    const recovered = await post(`${endpoint}/publish`, input);
    assert.deepEqual(calls, ["repo-1", "repo-2", "repo-2"]);
    assert.equal(recovered.production.status_label, "待开始萃取");
    assert.equal(recovered.source_cleanup.publications[0].url, partial.source_cleanup.publications[0].url);
    assert.equal(recovered.turns.length, 0, "创建 MR 后不能自动开始研究");
  } finally { await manager.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("清理保存 EIO：选中文件保存失败不创建 MR、不污染原记录，解除故障后可重试", async t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-save-")), calls: string[] = [];
  const { manager } = cleanupFixture(dir, calls);
  let mock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const job = manager.create({ ...config, prepare_cleanup: true }, "alice");
    await manager.sourceCleanupAction(job.id, "preview", { paths_by_target: { "repo-1": ["docs/old"] } }, "alice");
    const path = join(dir, "domain-extraction", job.id, "job.json"), bytes = readFileSync(path, "utf8"), rename = fs.renameSync;
    const before = manager.get(job.id).source_cleanup;
    mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path) throw Object.assign(new Error("测试 EIO"), { code: "EIO" }); return rename(from, to);
    }); syncBuiltinESMExports();
    const input = { selected_paths_by_target: { "repo-1": ["docs/old/old.md"] } };
    await assert.rejects(manager.sourceCleanupAction(job.id, "publish", input, "alice"), /EIO/);
    assert.equal(calls.length, 0); assert.equal(readFileSync(path, "utf8"), bytes); assert.deepEqual(manager.get(job.id).source_cleanup, before);
    mock.mock.restore(); syncBuiltinESMExports();
    await manager.sourceCleanupAction(job.id, "publish", input, "alice"); assert.equal(calls.length, 1);
  } finally { mock?.mock.restore(); syncBuiltinESMExports(); await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
