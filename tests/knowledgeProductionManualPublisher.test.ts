import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import type { MrParticipants } from "../src/mrParticipants.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5_000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-publisher-")), source = join(dir, "source"), remote = join(dir, "remote.git");
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 }).trim();
  git("-C", source, "init", "-b", "main"); git("-C", source, "config", "user.name", "Fixture"); git("-C", source, "config", "user.email", "alice@example.test");
  writeFileSync(join(source, "code.ts"), "原有代码\n"); git("-C", source, "add", "."); git("-C", source, "commit", "-m", "fixture"); git("clone", "--bare", source, remote);
  const requests: string[] = [], mrs: Array<{ id: number; url: string; source_branch: string; target_branch: string }> = [], inputs: Array<{ title: string; dts_no: string; participants?: MrParticipants }> = [];
  const saves: DomainPublication[] = [], createSnapshots: Array<DomainPublication | undefined> = [];
  const response = { disconnectCreate: false, gates: "opened", participantStatus: "applied" as "applied" | "failed" };
  const server = createServer(async (request, res) => {
    const url = new URL(request.url!, "http://fixture"); requests.push(url.pathname);
    if (url.pathname === "/mr/discover") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ mrs: mrs.filter(mr => mr.source_branch === url.searchParams.get("source_branch") && mr.target_branch === url.searchParams.get("target_branch")) })); return;
    }
    if (url.pathname === "/mr/gates") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ mr_state: response.gates, gates: [] })); return; }
    if (url.pathname !== "/mr") { res.writeHead(404); res.end("{}"); return; }
    let text = ""; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text), mr = { id: mrs.length + 1, url: `https://example.test/mr/${mrs.length + 1}`, source_branch: input.source_branch, target_branch: input.target_branch };
    inputs.push({ title: input.title, dts_no: input.dts_no, ...(input.participants ? { participants: input.participants } : {}) });
    createSnapshots.push(structuredClone(saves.at(-1)));
    mrs.push(mr);
    if (response.disconnectCreate) { res.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...mr,
      ...(input.participants ? { participants: { status: response.participantStatus, requested: input.participants } } : {}) }));
  });
  await bounded(new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)), "手动归档HTTP夹具启动超过5秒");
  const formal = saveKnowledgeDocument(dir, { title: "订单规则", content: "# 订单\n已发布第一版\n", scope: "platform" }, "alice");
  const target = { id: "domain", name: "知识仓", repository: remote, branch: "main", path: "", docs_path: "domains" };
  const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title: "订单规则", scope: "订单", issue_no: "REQ-130", issue_description: "归档订单已发布版本", operator: "alice",
    created_at: "2026-10-03T00:00:00.000Z", status: "done", stage: "已入库", knowledge_target: target, repositories: [], material_ids: [],
    revisions: {}, turns: [], evidence: [], publications: [], documents: [{ id: "orders", title: formal.title, target_id: "domain", layer: "domain", path: "domains/orders.md",
      content: formal.content, sources: "固定版本源码", selected: true, revision: 1, base_content: null, base_revision: "", history: [],
      knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 }] };
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credential: () => ({ username: "alice", password: "fixture-personal-token", email: "alice@example.test" }) });
  let saved: DomainPublication | undefined;
  return { dir, job, target, formal, publisher, response, requests, mrs, inputs, saves, createSnapshots, git, remote,
    save: (publication: DomainPublication) => { saved = structuredClone(publication); saves.push(saved); }, last: () => saved!,
    async close() { await bounded(publisher.shutdown(), "手动归档发布器未停止"); server.closeAllConnections(); await bounded(new Promise<void>(resolve => server.close(() => resolve())), "手动归档HTTP夹具未关闭"); rmSync(dir, { recursive: true, force: true }); } };
}

test("任务修订先查询真实 MR 状态，未合入时续推同分支，不改正式知识快照", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "第一版人工归档超过5秒");
    assert.equal(first.state, "opened"); assert.equal(f.mrs.length, 1);
    const second = saveKnowledgeDocument(f.dir, { ...readKnowledgeDocument(f.dir, f.formal.id), content: "# 订单\n已发布第二版\n" }, "editor", f.formal.id, { expectedRevision: f.formal.revision });
    f.job.documents[0] = { ...f.job.documents[0], content: second.content, revision: 2, published_revision: second.revision, published_document_revision: 2 };
    const formalPath = join(f.dir, "knowledge-documents", `${f.formal.id}.json`), before = readFileSync(formalPath, "utf8");
    const next = await bounded(f.publisher.publish(f.job, f.target, first, "alice", f.save), "第二版人工归档超过5秒");
    assert.equal(next.branch, first.branch, "同一未合入任务继续使用原分支"); assert.equal(next.url, first.url); assert.equal(f.mrs.length, 1);
    assert.equal(f.requests.filter(path => path === "/mr/gates").length, 1, "续推前必须确认原 MR 尚未合入");
    assert.equal(f.git("-C", f.remote, "show", `${first.branch}:domains/orders.md`), "# 订单\n已发布第二版");
    assert.equal(f.git("-C", f.remote, "show", `${next.branch}:domains/orders.md`), "# 订单\n已发布第二版");
    assert.equal(next.documents[0].knowledge_revision, second.revision); assert.equal(readFileSync(formalPath, "utf8"), before, "归档仅推精确正式快照，不回写正式内容、版本或历史");
  } finally { await f.close(); }
});

test("MR 回执丢失后先找回原链接并核对生命周期，恢复时不重复创建", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "knowledge-documents", `${f.formal.id}.json`), before = readFileSync(path, "utf8");
    f.response.disconnectCreate = true;
    await assert.rejects(bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "首次归档失败未返回"), /MR.*尚未确认|暂时故障/);
    const attempted = f.last(); assert.equal(attempted.mr_attempted, true); assert.equal(attempted.url, undefined); assert.equal(f.mrs.length, 1);
    bindModule(f); // 原请求无人员配置；后来绑定模块也不能给已存在的 MR 猜一份新名单。
    f.response.disconnectCreate = false; f.response.gates = "opened";
    const recovered = await bounded(f.publisher.publish(f.job, f.target, { ...attempted, state: "failed" }, "alice", f.save), "人工重试未取回原MR");
    assert.equal(recovered.branch, attempted.branch); assert.equal(recovered.url, f.mrs[0].url); assert.equal(recovered.mr_id, f.mrs[0].id);
    assert.equal(f.requests.filter(path => path === "/mr").length, 1); assert.equal(f.requests.filter(path => path === "/mr/discover").length, 1);
    assert.equal(f.requests.filter(path => path === "/mr/gates").length, 1, "回执恢复后核对真实生命周期");
    assert.equal(recovered.mr_participants, undefined); assert.ok(!f.requests.includes("/mr/participants"));
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { await f.close(); }
});

test("生产线验收5：人工归档仅填写单号即可创建MR，未填描述时采用知识标题", { timeout: 20_000 }, async () => {
  const f = await fixture(); delete f.job.issue_description;
  try {
    const result = await bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "仅单号归档超过5秒");
    assert.equal(result.state, "opened"); assert.deepEqual(f.inputs, [{ title: f.job.title, dts_no: f.job.issue_no }]);
  } finally { await f.close(); }
});

test("MR 创建回执丢失后又修订文稿，先找回原 MR 再续推，不能创建重复 MR", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.response.disconnectCreate = true;
    await assert.rejects(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), /MR.*尚未确认|暂时故障/);
    const previous = f.last();
    assert.equal(previous.url, undefined); assert.equal(previous.mr_attempted, true); assert.equal(f.mrs.length, 1);
    f.job.documents[0] = { ...f.job.documents[0], revision: 2, content: "# 回执丢失后的修订" };
    f.response.disconnectCreate = false;
    const updated = await f.publisher.publish(f.job, f.target, previous, "alice", f.save);
    assert.equal(updated.branch, previous.branch); assert.equal(updated.url, f.mrs[0].url); assert.equal(f.mrs.length, 1);
    assert.equal(f.requests.filter(path => path === "/mr/discover").length, 1);
    assert.equal(f.git("-C", f.remote, "show", `${updated.branch}:domains/orders.md`), "# 回执丢失后的修订");
  } finally { await f.close(); }
});

test("任务 MR 已关闭时保留正文并拒绝另建 MR，需要恢复原 MR 后继续", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "第一版归档超过5秒");
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const second = saveKnowledgeDocument(f.dir, { ...readKnowledgeDocument(f.dir, f.formal.id), when_to_use: "新增的已审核适用场景" }, "editor", f.formal.id, { expectedRevision: f.formal.revision });
    assert.notEqual(second.revision, f.formal.revision); assert.equal(second.content, f.formal.content);
    f.job.documents[0] = { ...f.job.documents[0], revision: 2, published_revision: second.revision, published_document_revision: 2 };
    f.response.gates = "closed";
    await assert.rejects(bounded(f.publisher.publish(f.job, f.target, first, "alice", f.save), "已关闭 MR 查询超过5秒"), /MR 已关闭/);
    assert.equal(f.mrs.length, 1);
    assert.equal(f.git("-C", f.remote, "show", `${first.branch}:domains/orders.md`), f.formal.content.trim());
    assert.equal(f.requests.filter(path => path === "/mr/gates").length, 1);
    f.response.gates = "opened";
    const next = await bounded(f.publisher.publish(f.job, f.target, first, "alice", f.save), "恢复原 MR 超过5秒");
    assert.equal(next.branch, first.branch); assert.equal(next.url, first.url); assert.equal(f.mrs.length, 1);
    assert.equal(next.documents[0].knowledge_revision, second.revision);
  } finally { await f.close(); }
});

test("生产线验收6/14：同一物理仓和分支的多个逻辑目标一次MR导出各自目录的精确正式文件", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const sibling = { ...f.target, id: "repo-1", name: "源码仓内说明", docs_path: "guides/source" };
    const formal = saveKnowledgeDocument(f.dir, { title: "仓内说明", content: "# 源码规则\n第二份正式知识\n", scope: "platform" }, "alice");
    f.job.repositories = [sibling];
    f.job.documents.push({ ...f.job.documents[0], id: "source-guide", title: formal.title, target_id: sibling.id, path: "guides/source/rules.md",
      content: formal.content, knowledge_document_id: formal.id, published_revision: formal.revision });
    const result = await bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "同仓多目标归档超过5秒");
    assert.equal(result.state, "opened"); assert.equal(result.target_id, f.target.id); assert.equal(f.mrs.length, 1);
    assert.equal(f.requests.filter(path => path === "/mr").length, 1);
    assert.deepEqual(result.documents.map(document => document.path).sort(), ["domains/orders.md", "guides/source/rules.md"]);
    assert.equal(f.git("-C", f.remote, "show", `${result.branch}:domains/orders.md`), f.formal.content.trim());
    assert.equal(f.git("-C", f.remote, "show", `${result.branch}:guides/source/rules.md`), formal.content.trim());
    assert.equal(f.job.documents[1].target_id, sibling.id, "归组不能篡改知识所属的逻辑目标");
    assert.equal(result.documents.find(document => document.id === "source-guide")!.knowledge_revision, formal.revision);
  } finally { await f.close(); }
});

const modulePeople: MrParticipants = { reviewers: ["l00000000"], approval_approvers: ["a00123456"] };
function bindModule(f: Awaited<ReturnType<typeof fixture>>) {
  const module = createBusinessModule(f.dir, { id: "orders", name: "订单", description: "订单代码模块", owner: "alice",
    repositories: ["https://example.test/orders-code.git"], mr_participants: modulePeople }, "alice");
  f.job.module_id = module.id;
  return module;
}

test("知识归档创建时传模块人员，失败保留opened，配置变化后已有MR不追补", { timeout: 20_000 }, async () => {
  const f = await fixture(); bindModule(f); f.response.participantStatus = "failed";
  try {
    const first = await bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "归档创建超时");
    assert.equal(first.state, "opened"); assert.equal(first.mr_participants?.status, "failed");
    assert.deepEqual(f.inputs[0].participants, modulePeople, "公共知识仓不必属于模块代码仓清单");
    assert.equal(f.createSnapshots[0]?.mr_attempted, true);
    assert.equal(f.createSnapshots[0]?.mr_participants?.status, "failed", "发出创建请求前保存尚未确认状态");
    assert.deepEqual(f.createSnapshots[0]?.mr_participants?.requested, modulePeople);
    updateBusinessModule(f.dir, "orders", { mr_participants: { reviewers: ["new-reviewer"], approval_approvers: [] } }, "alice");
    renameSync(f.remote, `${f.remote}.offline`); // 复用已有 MR 不应再操作 Git。
    f.response.participantStatus = "applied";
    const next = await bounded(f.publisher.publish(f.job, f.target, first, "alice", f.save), "MR 复用超时");
    assert.equal(next.state, "opened"); assert.equal(next.url, first.url); assert.equal(next.revision, first.revision);
    assert.deepEqual(next.mr_participants, first.mr_participants);
    assert.equal(f.mrs.length, 1); assert.equal(f.requests.filter(path => path === "/mr").length, 1);
    await f.publisher.publish(f.job, f.target, next, "alice", f.save);
    const legacy = { ...next }; delete legacy.mr_participants;
    await f.publisher.publish(f.job, f.target, legacy, "alice", f.save);
    assert.deepEqual(f.requests.filter(path => path !== "/mr/gates"), ["/mr"], "失败或未记录人员的旧 MR 都不重新套用模块配置");
    assert.equal(f.requests.filter(path => path === "/mr/gates").length, 3, "已有 MR 只补查询生命周期，不更新人员");
  } finally { await f.close(); }
});

test("知识归档回执丢失后discover只恢复链接和原人员记录，不更新人员或操作Git", { timeout: 20_000 }, async () => {
  const f = await fixture(); bindModule(f); f.response.disconnectCreate = true;
  try {
    await assert.rejects(bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "归档失败未返回"), /MR.*尚未确认|暂时故障/);
    const previous = f.last(); assert.equal(previous.mr_participants?.status, "failed");
    assert.deepEqual(previous.mr_participants?.requested, modulePeople);
    updateBusinessModule(f.dir, "orders", { mr_participants: { reviewers: ["new-reviewer"], approval_approvers: [] } }, "alice");
    renameSync(f.remote, `${f.remote}.offline`); f.response.disconnectCreate = false;
    const result = await bounded(f.publisher.publish(f.job, f.target, previous, "alice", f.save), "归档恢复超时");
    assert.equal(result.state, "opened"); assert.equal(result.url, f.mrs[0].url);
    assert.deepEqual(result.mr_participants, previous.mr_participants);
    assert.deepEqual(f.requests, ["/mr", "/mr/discover", "/mr/gates"]);
    assert.equal(f.mrs.length, 1);
  } finally { await f.close(); }
});

test("知识清理MR创建时传模块人员，重试同计划只复用链接，不更新人员", { timeout: 20_000 }, async () => {
  const f = await fixture(); bindModule(f); f.response.participantStatus = "failed";
  try {
    const plan = await f.publisher.previewCleanup(f.target, ["code.ts"], "alice");
    const first = await bounded(f.publisher.publishCleanup(f.job, f.target, plan, ["code.ts"], undefined, "alice", f.save), "清理创建超时");
    assert.equal(first.state, "opened"); assert.equal(first.mr_participants?.status, "failed");
    assert.deepEqual(f.inputs[0].participants, modulePeople);
    assert.deepEqual(f.createSnapshots[0]?.mr_participants?.requested, modulePeople);
    updateBusinessModule(f.dir, "orders", { mr_participants: { reviewers: ["new-reviewer"], approval_approvers: [] } }, "alice");
    renameSync(f.remote, `${f.remote}.offline`); f.response.participantStatus = "applied";
    const next = await bounded(f.publisher.publishCleanup(f.job, f.target, plan, ["code.ts"], first, "alice", f.save), "清理MR复用超时");
    assert.equal(next.state, "opened"); assert.equal(next.url, first.url); assert.equal(next.revision, first.revision);
    assert.deepEqual(next.mr_participants, first.mr_participants);
    await f.publisher.publishCleanup(f.job, f.target, plan, ["code.ts"], next, "alice", f.save);
    assert.deepEqual(f.requests, ["/mr"]); assert.equal(f.mrs.length, 1);
  } finally { await f.close(); }
});

test("知识清理MR回执丢失后discover只复用链接，不重删文件或更新人员", { timeout: 20_000 }, async () => {
  const f = await fixture(); bindModule(f); f.response.disconnectCreate = true;
  try {
    const plan = await f.publisher.previewCleanup(f.target, ["code.ts"], "alice");
    await assert.rejects(bounded(f.publisher.publishCleanup(f.job, f.target, plan, ["code.ts"], undefined, "alice", f.save), "清理失败未返回"), /MR.*尚未确认|暂时故障/);
    const previous = f.last() as Awaited<ReturnType<KnowledgeMrPublisher["publishCleanup"]>>;
    assert.equal(previous.mr_participants?.status, "failed");
    renameSync(f.remote, `${f.remote}.offline`); f.response.disconnectCreate = false;
    const original = structuredClone(previous);
    const result = await bounded(f.publisher.publishCleanup(f.job, f.target, plan, ["code.ts"], previous, "alice", f.save), "清理恢复超时");
    assert.equal(result.state, "opened"); assert.equal(result.url, f.mrs[0].url);
    assert.equal(result.revision, original.revision); assert.deepEqual(result.removed_paths, original.removed_paths);
    assert.deepEqual(result.mr_participants, original.mr_participants);
    assert.deepEqual(f.requests, ["/mr", "/mr/discover"]); assert.equal(f.mrs.length, 1);
  } finally { await f.close(); }
});

test("知识任务未绑定模块时不推断默认人员", { timeout: 20_000 }, async () => {
  const f = await fixture(); bindModule(f); delete f.job.module_id;
  try {
    const result = await bounded(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), "未绑定模块归档超时");
    assert.equal(f.inputs[0].participants, undefined); assert.equal(result.mr_participants, undefined);
    assert.deepEqual(f.requests, ["/mr"]);
  } finally { await f.close(); }
});
