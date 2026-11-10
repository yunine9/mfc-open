import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { fetchMrGates } from "../src/mrGateClient.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
const pause = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms));
async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = realSetTimeout(() => reject(new Error(message)), 5000); })]);
  } finally { if (timer) realClearTimeout(timer); }
}
async function ready(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(message); await pause(10); }
}
const publish = (publisher: KnowledgeMrPublisher, job: DomainKnowledgeJob, target: DomainKnowledgeJob["knowledge_target"], previous: DomainPublication | undefined,
  save: (value: DomainPublication) => void, signal: AbortSignal) =>
  publisher.publish(job, target, previous, "alice", save, signal);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-manual-archive-transport-")), source = join(root, "source"), remote = join(root, "remote.git");
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  git("-C", source, "init", "-b", "main"); git("-C", source, "config", "user.name", "Fixture"); git("-C", source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "code.ts"), "source\n"); git("-C", source, "add", "."); git("-C", source, "commit", "-m", "fixture"); git("clone", "--bare", source, remote);
  const response = { status: 200, reason: "", headers: {} as Record<string, string>, hold: "", state: "opened" };
  const requests: string[] = [], closed = new Set<string>(), held = new Map<string, ServerResponse>();
  const server = createServer(async (request, res) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    for await (const _ of request) { /* 请求正文使用真实 HTTP。 */ }
    requests.push(path);
    if (response.hold === path) { held.set(path, res); res.once("close", () => closed.add(path)); return; }
    res.writeHead(response.status, { "content-type": "application/json", ...response.headers });
    res.end(JSON.stringify(response.status !== 200 ? { error: response.reason }
      : path === "/mr/gates" ? { mr_state: response.state, gates: [] }
      : path === "/mr/discover" ? { mrs: [] } : { id: 1, url: "https://example.test/repo/merge_requests/1" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => platformUrl,
    credential: () => ({ username: "fixture", password: "fixture-password", email: "fixture@example.test" }) });
  const target = { id: "domain", name: "领域仓", repository: remote, branch: "main", path: "", docs_path: "docs/domain" };
  const formal = saveKnowledgeDocument(root, { title: "订单规则", content: "# 订单规则", scope: "platform" }, "alice");
  const job: DomainKnowledgeJob = { id: "dkx-manual-archive-transport", issue_no: "REQ-1", issue_description: "整理订单规则", title: "订单", scope: "规则", operator: "alice", created_at: new Date().toISOString(),
    repositories: [], knowledge_target: target, material_ids: [], status: "done", stage: "待审查", revisions: {}, turns: [], evidence: [], publications: [],
    documents: [{ id: "orders", title: "订单规则", target_id: "domain", path: "docs/domain/orders.md", layer: "domain", content: "# 订单规则", sources: "固定版本源码", revision: 1, selected: true, base_content: null, base_revision: "", knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1, history: [] }] };
  const publication: DomainPublication = { target_id: "domain", branch: "codex/knowledge-fixture", state: "failed", mr_attempted: true,
    documents: job.documents.map(doc => ({ id: doc.id, path: doc.path, content: doc.content, revision: doc.revision,
      knowledge_document_id: doc.knowledge_document_id, knowledge_revision: doc.published_revision })) };
  const saved: DomainPublication[] = [];
  const release = (path: string, body: unknown = { mr_state: response.state, gates: [] }) => {
    const res = held.get(path); if (!res || res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); held.delete(path);
  };
  return { root, remote, platformUrl, publisher, target, job, publication, response, requests, closed, saved, release, formal,
    save: (value: DomainPublication) => { saved.push(structuredClone(value)); },
    async close(work?: Promise<unknown>) {
      for (const path of held.keys()) release(path);
      server.closeAllConnections();
      if (work) await bounded(work.catch(() => undefined), "测试清理时 MR 调用未结束");
      await bounded(publisher.shutdown(), "测试清理时发布器未结束");
      await bounded(new Promise<void>(resolve => server.close(() => resolve())), "HTTP 夹具未关闭");
      rmSync(root, { recursive: true, force: true });
    } };
}

for (const operation of ["discover", "create"] as const) {
  test(`生产线验收9/14：${operation}外部15秒预算真实取消HTTP连接，不等各自默认超时`, { timeout: 15_000 }, async t => {
    const f = await fixture(), controller = new AbortController(), reason = new Error("单次 MR 操作超过15秒预算");
    const path = operation === "discover" ? "/mr/discover" : "/mr";
    f.response.hold = path;
    let work: Promise<DomainPublication> | undefined;
    try {
      // 假时间推进调用总预算；真实网络准备与退出仍各有5秒预算。
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const flight: Promise<DomainPublication> = publish(f.publisher, f.job, f.target, operation === "discover" ? f.publication : undefined, f.save, controller.signal);
      work = flight;
      let settled = false; void flight.then(() => { settled = true; }, () => { settled = true; });
      await ready(() => f.requests.includes(path), "真实 MR 请求未到达平台");
      const budget = setTimeout(() => controller.abort(reason), 15_000);
      t.mock.timers.tick(14_999); await pause(20); assert.equal(settled, false);
      t.mock.timers.tick(1);
      await assert.rejects(bounded(flight, "15秒预算用完后 HTTP 仍未取消"), /单次 MR 操作超过15秒预算/);
      await ready(() => f.closed.has(path), "平台仍收到未取消的 HTTP 连接");
      assert.equal(f.saved.some(value => value.state === "opened"), false, "取消后不能保存创建成功");
      clearTimeout(budget);
    } finally { t.mock.timers.reset(); controller.abort(reason); await f.close(work); }
  });
}

for (const operation of ["create"] as const) {
  test(`生产线验收9/14：${operation}平台忽略abort后迟到成功不得更新正式库或保存opened`, { timeout: 15_000 }, async t => {
    const f = await fixture(), controller = new AbortController(), reason = new Error("单次 MR 操作已取消");
    let release!: (response: Response) => void, called = false;
    t.mock.method(globalThis, "fetch", async () => { called = true; return new Promise<Response>(resolve => { release = resolve; }); });
    const authoritative = join(f.root, "knowledge-documents", `${f.formal.id}.json`), bytes = readFileSync(authoritative);
    const work = publish(f.publisher, f.job, f.target, undefined, f.save, controller.signal);
    void work.catch(() => undefined);
    try {
      await ready(() => called, "MR 调用未开始"); controller.abort(reason);
      release(Response.json({ id: 1, url: "https://example.test/repo/merge_requests/1" }));
      await assert.rejects(bounded(work, "迟到的 MR 调用未结束"), /单次 MR 操作已取消/);
      assert.deepEqual(readFileSync(authoritative), bytes);
      assert.equal(f.saved.some(value => value.state === "opened"), false);
    } finally { controller.abort(reason); t.mock.restoreAll(); await f.close(work); }
  });
}

test("生产线验收9：问题流与需求共享MR查询默认失败字符串仍为HTTP429", async () => {
  const f = await fixture(); f.response.status = 429; f.response.reason = "限流原文";
  try {
    let reason = "";
    const result = await fetchMrGates({ platformUrl: f.platformUrl, headers: {}, repo: f.remote, requireExisting: true,
      delivery: { mr_id: 1, source_branch: "codex/fixture", target_branch: "main" }, onFailure: value => { reason = value; } });
    assert.equal(result, undefined); assert.equal(reason, "HTTP 429");
  } finally { await f.close(); }
});
