// repros/r9 实测：平台确定的拒绝原因不能变成反复创建 MR 的提示。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { readMrFailureBody } from "../src/mrGateClient.ts";
import { knowledgeFailureDisposition } from "../src/knowledgeProductionErrors.ts";
import { syncKnowledgeSource } from "../src/knowledgeExtractionFactory.ts";
import { HostGitSandbox } from "../src/hostGitSandbox.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

async function fixture(password = "fixture-password") {
  const root = mkdtempSync(join(tmpdir(), "production-errors-")), remote = join(root, "remote.git"), source = join(root, "source");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "code.ts"), "source\n"); git(source, "add", "."); git(source, "commit", "-m", "fixture");
  execFileSync("git", ["clone", "--bare", source, remote], { stdio: "ignore" });
  const response = { create: 200, gates: 200, discover: 200, reason: "", disconnect: "", disconnectAfterHeaders: "" };
  const requests: string[] = [];
  let incomplete: import("node:http").ServerResponse | undefined;
  const server: Server = createServer(async (request, res) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    requests.push(path); for await (const _ of request) { /* 保留真实 POST 正文读取。 */ }
    if (response.disconnect === path) { request.socket.destroy(); return; }
    if (response.disconnectAfterHeaders === path) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"mrs":'); incomplete = res; return; }
    const status = path === "/mr" ? response.create : path === "/mr/gates" ? response.gates : response.discover;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status !== 200 ? { error: response.reason } : path === "/mr/gates" ? { mr_state: "opened", gates: [] }
      : path === "/mr/discover" ? { mrs: [] } : { id: 1, url: "https://example.test/repo/merge_requests/1" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => platformUrl,
    credential: () => ({ username: "Fixture", password, email: "fixture@example.test" }) });
  const target = { id: "domain", name: "领域仓", repository: remote, branch: "main", path: "", docs_path: "docs/domain" };
  const formal = saveKnowledgeDocument(root, { title: "状态", content: "# 状态", scope: "platform" }, "alice");
  const doc: DomainKnowledgeJob["documents"][number] = { id: "states", title: "状态", target_id: target.id, path: "docs/domain/states.md", layer: "domain", content: "# 状态", sources: "source", revision: 1, selected: true, base_content: null, base_revision: "", knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1, history: [] };
  const job: DomainKnowledgeJob = { id: "dkx-error-fixture", issue_no: "REQ-1", issue_description: "整理订单状态", title: "订单", scope: "状态", operator: "alice", created_at: new Date().toISOString(), repositories: [], knowledge_target: target,
    material_ids: [], status: "done", stage: "待审查", revisions: {}, documents: [doc], turns: [], evidence: [], publications: [] };
  let saved: DomainPublication | undefined;
  const save = (value: DomainPublication) => { saved = structuredClone(value); };
  return { root, publisher, platformUrl, target, job, response, requests, save, saved: () => saved, disconnectBody: () => incomplete?.destroy(),
    async close() { await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

function failedReceipt(f: Awaited<ReturnType<typeof fixture>>): DomainPublication {
  return { target_id: "domain", branch: "codex/knowledge-fixture", state: "failed", mr_attempted: true,
    documents: f.job.documents.map(doc => ({ id: doc.id, path: doc.path, content: doc.content, revision: doc.revision,
      knowledge_document_id: doc.knowledge_document_id, knowledge_revision: doc.published_revision })) };
}

test("生产线验收9：r9 真实 Git 创建 MR 的400保留配置原文，人工重试401指出个人设置而不让人无效重试", async () => {
  const f = await fixture();
  try {
    f.response.create = 400; f.response.reason = "知识归档命令未配置单号关联，请在 mr_create_knowledge 中配置 {dts_no}";
    await assert.rejects(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), (error: Error) => {
      assert.match(error.message, /HTTP 400/); assert.ok(error.message.includes(f.response.reason));
      assert.match(error.message, /联系.*管理员.*mr_create_knowledge/); assert.doesNotMatch(error.message, /重试|稍后/); return true;
    });
    assert.equal(f.saved()?.mr_attempted, true, "确定的拒绝仍保留已经推送的分支事实");
    f.response.create = 401; f.response.reason = "token expired";
    await assert.rejects(f.publisher.publish(f.job, f.target, f.saved(), "alice", f.save), (error: Error) => {
      assert.match(error.message, /HTTP 401/); assert.ok(error.message.includes(f.response.reason));
      assert.match(error.message, /个人设置.*CodeHub.*令牌/); assert.doesNotMatch(error.message, /重试|稍后/); return true;
    });
    // 13ff28b7 重试链路在入口与建单前各确认一次原分支(首次未发现时第二次
    // 再核),语义仍是「先确认再重试」,不再是单次。
    assert.equal(f.requests.filter(path => path === "/mr/discover").length, 2, "人工重试先确认原分支是否已有MR");
    assert.equal(f.requests.filter(path => path === "/mr/gates").length, 0, "创建后的MR状态不参与归档");
  } finally { await f.close(); }
});

const deterministic = [
  { status: 400, reason: "mr_create_knowledge 缺少 {dts_no} 单号关联配置", next: /联系.*管理员.*mr_create_knowledge/ },
  { status: 401, reason: "token expired", next: /个人设置.*CodeHub.*令牌/ },
  { status: 403, reason: "permission denied", next: /权限|管理员/ },
  { status: 404, reason: "repository not found", next: /地址|仓库|管理员/ },
];
for (const operation of ["create", "discover"] as const) for (const { status, reason, next } of deterministic) {
  test(`生产线验收9：MR ${operation} HTTP ${status}带平台原文和可执行下一步，确定性错误不提示重试`, async () => {
    const f = await fixture();
    try {
      f.response[operation] = status; f.response.reason = reason;
      const previous: DomainPublication | undefined = operation === "create" ? undefined
        : failedReceipt(f);
      await assert.rejects(f.publisher.publish(f.job, f.target, previous, "alice", f.save), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.ok(error.message.includes(reason));
        assert.equal(knowledgeFailureDisposition(error), "stall", "人工下一步与错误文案使用同一确定性分类");
        assert.match(error.message, next); assert.doesNotMatch(error.message, /重试|稍后/); return true;
      });
    } finally { await f.close(); }
  });
}

for (const operation of ["create", "discover"] as const) for (const status of [429, 503]) {
  test(`生产线验收9：MR ${operation} HTTP ${status}如实显示暂时故障与平台原文`, async () => {
    const f = await fixture();
    try {
      f.response[operation] = status; f.response.reason = status === 429 ? "rate limit exceeded" : "gateway unavailable";
      const previous: DomainPublication | undefined = operation === "create" ? undefined
        : failedReceipt(f);
      await assert.rejects(f.publisher.publish(f.job, f.target, previous, "alice", f.save), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.ok(error.message.includes(f.response.reason));
        assert.equal(knowledgeFailureDisposition(error), "retry", "暂时故障如实保留，修好后由人手动重试");
        assert.match(error.message, /暂时|稍后|重试/); assert.doesNotMatch(error.message, /更新个人令牌|联系管理员配置/); return true;
      });
    } finally { await f.close(); }
  });
}

for (const operation of ["create", "discover"] as const) {
  test(`生产线验收9：MR ${operation}连接中断保留网络原文并说明暂时故障`, async () => {
    const f = await fixture();
    try {
      f.response.disconnect = operation === "create" ? "/mr" : "/mr/discover";
      const previous: DomainPublication | undefined = operation === "create" ? undefined
        : failedReceipt(f);
      await assert.rejects(f.publisher.publish(f.job, f.target, previous, "alice", f.save), (error: Error) => {
        assert.match(error.message, /fetch failed|socket|connection|网络/i); assert.match(error.message, /暂时|稍后|重试/); return true;
      });
    } finally { await f.close(); }
  });
}

test("生产线验收9：MR 平台回显个人令牌时，保留平台原因且隐藏凭据", async () => {
  const f = await fixture();
  try {
    f.response.create = 401; f.response.reason = "token fixture-password expired";
    await assert.rejects(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), (error: Error) => {
      assert.match(error.message, /HTTP 401.*token.*expired/); assert.doesNotMatch(error.message, /fixture-password/);
      assert.doesNotMatch(String(error.cause), /fixture-password/); return true;
    });
  } finally { await f.close(); }
});

test("生产线验收9：MR 错误正文连接不结束时只等待10秒，取消读取并如实写明超时", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false, settled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("未结束的错误正文")); }, cancel() { cancelled = true; } });
  try {
    const result = readMrFailureBody(new Response(stream)).then(value => { settled = true; return value; }, error => { settled = true; return error as Error; });
    await setImmediate(); t.mock.timers.tick(9_999); await setImmediate(); assert.equal(settled, false);
    t.mock.timers.tick(1); await setImmediate();
    const error = await result; assert.ok(error instanceof Error); assert.match(error.message, /错误正文读取超时.*10 秒/);
    assert.equal(cancelled, true, "预算结束后不留下继续读取响应体的工作");
  } finally { t.mock.timers.reset(); }
});

const gitFailures = [
  { diagnostic: "fatal: Authentication failed", category: /Git 鉴权失败/, next: /个人设置.*CodeHub.*令牌/, disposition: "stall" },
  { diagnostic: "fatal: could not read Username for https://example.test: No such device or address", category: /Git 鉴权失败/, next: /个人设置.*CodeHub.*令牌/, disposition: "stall" },
  { diagnostic: "fatal: The requested URL returned error: 403", category: /Git 鉴权失败/, next: /权限|管理员/, disposition: "stall" },
  { diagnostic: "fatal: Could not resolve host: codehub.example.test", category: /Git 网络.*故障/, next: /网络.*恢复|恢复.*重试/, disposition: "retry" },
  { diagnostic: "fatal: connection timed out", category: /Git 网络.*故障/, next: /网络.*恢复|恢复.*重试/, disposition: "retry" },
  { diagnostic: "! [rejected] knowledge -> knowledge (non-fast-forward)", category: /非快进|远端分支已有新提交/, next: /先.*拉取.*核对/, disposition: "stall" },
  { diagnostic: "! [rejected] knowledge -> knowledge (fetch first)", category: /非快进|远端分支已有新提交/, next: /先.*拉取.*核对/, disposition: "stall" },
  { diagnostic: "fatal: repository https://example.test/missing.git not found", category: /Git 仓库不存在|找不到仓库/, next: /仓库地址.*权限|仓库管理员/, disposition: "stall" },
] as const;
for (const { diagnostic, category, next, disposition } of gitFailures) {
  test(`生产线验收9：F14真实 Git 接收端返回 ${diagnostic}，分类下一步且不泄漏诊断中的令牌`, async () => {
    const f = await fixture();
    try {
      // 从真实 Git 子进程取得 stderr；远端 hook 用固定文本模拟平台的具体拒绝原因。
      const hook = join(f.root, "remote.git", "hooks", "pre-receive");
      writeFileSync(hook, `#!/bin/sh\ncat <<'DIAGNOSTIC' >&2\n${diagnostic}\nfixture-password\nDIAGNOSTIC\nexit 1\n`); chmodSync(hook, 0o700);
      await assert.rejects(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), (error: Error) => {
        assert.match(error.message, category); assert.match(error.message, next); assert.match(error.message, /未覆盖远端/);
        assert.doesNotMatch(error.message, /fixture-password/); assert.doesNotMatch(String(error.cause), /fixture-password/);
        assert.equal(knowledgeFailureDisposition(error), disposition);
        if (disposition === "stall") assert.doesNotMatch(error.message, /重试|稍后/);
        return true;
      });
      assert.equal(f.requests.filter(path => path === "/mr").length, 0, "推送拒绝时没有创建 MR");
    } finally { await f.close(); }
  });
}

for (const status of [401, 404]) {
  test(`生产线验收9：F14真实源码 Git fetch HTTP ${status}与归档共用错误分类`, async () => {
    const f = await fixture(), sandbox = new HostGitSandbox(f.root), prepared = sandbox.prepare({ username: "Fixture", password: "fixture-password" });
    try {
      // 第五组实测：宿主代理会在请求到达夹具前返回 502，不能拿它冒充夹具的 401/404。
      for (const key of Object.keys(prepared.env)) if (/^(?:https?|all)_proxy$/i.test(key)) delete prepared.env[key];
      prepared.env.NO_PROXY = prepared.env.no_proxy = "127.0.0.1,localhost";
      f.response.discover = status; f.response.reason = status === 401 ? "token expired" : "repository not found";
      await assert.rejects(syncKnowledgeSource(join(f.root, "source-cache"), `${f.platformUrl}/source.git`, "main", prepared), (error: Error) => {
        assert.ok(f.requests.some(path => path.startsWith("/source.git")), "实际 Git 请求必须到达本地 HTTP 夹具");
        assert.match(error.message, status === 401 ? /Git 鉴权失败/ : /Git 仓库不存在|找不到仓库/);
        assert.match(error.message, status === 401 ? /个人设置.*CodeHub.*令牌/ : /仓库地址|仓库管理员/);
        assert.doesNotMatch(error.message, /fixture-password/); assert.doesNotMatch(String(error.cause), /fixture-password/);
        assert.equal(knowledgeFailureDisposition(error), "stall"); return true;
      });
    } finally { sandbox.cleanup(prepared); await f.close(); }
  });
}

for (const status of [429, 503]) {
  test(`生产线验收9：F13实际 HTTP ${status}的原文内含HTTP401仍按真正响应码判暂时故障`, async () => {
    const f = await fixture();
    try {
      f.response.create = status; f.response.reason = "upstream HTTP 401 temporarily unavailable";
      await assert.rejects(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.ok(error.message.includes(f.response.reason));
        assert.equal(knowledgeFailureDisposition(error), "retry"); assert.match(error.message, /暂时故障|恢复.*重试/); return true;
      });
    } finally { await f.close(); }
  });
}

test("生产线验收9：F13平台 JSON 回显带引号与反斜杠的个人令牌也隐藏可还原形式", async () => {
  const token = 'fixture"password\\suffix', escaped = JSON.stringify(token).slice(1, -1), f = await fixture(token);
  try {
    f.response.create = 401; f.response.reason = `token ${token} expired`;
    await assert.rejects(f.publisher.publish(f.job, f.target, undefined, "alice", f.save), (error: Error) => {
      assert.match(error.message, /HTTP 401.*token.*expired/);
      for (const value of [token, encodeURIComponent(token), escaped]) {
        assert.ok(!error.message.includes(value), "错误文案隐藏凭据所有已知表示"); assert.ok(!String(error.cause).includes(value), "原始原因也不留下可还原令牌");
      }
      return true;
    });
  } finally { await f.close(); }
});

test("生产线验收9：F13发现 MR 收到200响应头后断连仍说明暂时故障与下一步", async t => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  let received!: () => void; const headersReceived = new Promise<void>(resolve => { received = resolve; });
  const interception = t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const result = await originalFetch(...args); if (String(args[0]).includes("/mr/discover?")) received(); return result;
  });
  try {
    f.response.disconnectAfterHeaders = "/mr/discover";
    const previous: DomainPublication = { ...failedReceipt(f), state: "pending" };
    const result = f.publisher.publish(f.job, f.target, previous, "alice", f.save).then(() => undefined, error => error as Error);
    await headersReceived; f.disconnectBody();
    const error = await result; assert.ok(error instanceof Error);
    assert.match(error.message, /原分支 MR 查询.*暂时/); assert.match(error.message, /terminated|fetch failed|socket|connection/i);
    assert.equal(knowledgeFailureDisposition(error), "retry"); assert.match(error.message, /恢复.*重试/);
    assert.equal(f.requests.filter(path => path === "/mr").length, 0);
  } finally { interception.mock.restore(); await f.close(); }
});
