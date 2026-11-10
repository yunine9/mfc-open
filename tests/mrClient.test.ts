/**
 * MR 公共客户端(需求交付与问题流共用)的契约。
 *
 * 重点是 raw:外部动作台账(主 spec §11)记的是"平台到底回了什么",
 * 恢复时拿它对远端真实状态。把响应抽剩 url/id 再入账等于自断证据——
 * 2026-08-29 实测踩过:需求交付改走这个客户端时台账只剩两个字段,
 * 平台回的 iid/state/target 全丢了,谁也复原不了当时发生过什么。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createMergeRequest } from "../src/mrClient.ts";

test("MR 客户端:慢平台携带人员创建后仍能收到回执，显式超时继续生效", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reply!: () => void;
  let requestSignal!: AbortSignal;
  t.mock.method(globalThis, "fetch", (_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    requestSignal = options.signal!;
    requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
    reply = () => resolve(new Response(JSON.stringify({ url: "https://codehub/mr/42", id: 42,
      participants: { status: "applied" } }), { headers: { "content-type": "application/json" } }));
  }));
  const call = { platformUrl: "http://adapter", sourceBranch: "feature", targetBranch: "main", title: "test",
    participants: { reviewers: ["alice"], approval_approvers: [] } };
  const creating = createMergeRequest(call);
  // 模拟前置查找与携带人员创建共耗时 130 秒。
  t.mock.timers.tick(130_000);
  assert.equal(requestSignal.aborted, false);
  reply();
  const receipt = await creating;
  assert.equal(receipt.id, 42);
  assert.equal(receipt.participants?.status, "applied");

  const limited = createMergeRequest({ ...call, timeoutMs: 100 });
  const rejected = assert.rejects(limited, { name: "AbortError" });
  t.mock.timers.tick(100);
  await rejected;
});

async function fakePlatform(
  handler: (body: any) => { status?: number; json?: unknown },
): Promise<{ url: string; seen: any[]; headers: any[]; stop: () => Promise<void> }> {
  const seen: any[] = [];
  const headers: any[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      seen.push(body);
      headers.push(request.headers);
      const reply = handler(body);
      response.writeHead(reply.status ?? 200,
        { "content-type": "application/json" });
      response.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    headers,
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test("MR 客户端:平台响应原样带出,台账不丢字段", async () => {
  const platform = await fakePlatform(() => ({
    json: {
      url: "http://codehub/mr/42", id: 42,
      // 平台真实回包里的其余事实:恢复时要靠它们对远端状态。
      iid: 7, state: "opened", target_branch: "master",
      web_url: "http://codehub/x/mr/42",
    },
  }));
  try {
    const receipt = await createMergeRequest({
      platformUrl: platform.url,
      repo: "ssh://git@codehub/x.git",
      sourceBranch: "feat/a", targetBranch: "master", title: "REQ1: 加个功能",
      dtsNo: "REQ1",
      credential: { username: "alice", password: "tok-secret" },
    });
    assert.equal(receipt.url, "http://codehub/mr/42");
    assert.equal(receipt.id, 42);
    // 抽剩两个字段就等于把证据裁掉了,这里逐项点名。
    assert.deepEqual(receipt.raw, {
      url: "http://codehub/mr/42", id: 42, iid: 7, state: "opened",
      target_branch: "master", web_url: "http://codehub/x/mr/42",
    });

    // 请求形状:单号走 dts_no(适配层的 {dts_no} 占位符按它填 CLI 的
    // 单号关联参数),令牌只进请求头——请求体会被台账记进投影。
    assert.deepEqual(platform.seen[0], {
      repo: "ssh://git@codehub/x.git", source_branch: "feat/a",
      target_branch: "master", title: "REQ1: 加个功能", dts_no: "REQ1",
    });
    assert.equal(platform.headers[0]["x-mfc-git-token"], "tok-secret");
    assert.ok(!JSON.stringify(platform.seen[0]).includes("tok-secret"),
      "令牌绝不能进请求体");
  } finally {
    await platform.stop();
  }
});

test("MR 客户端:平台没回链接就是失败,不许拿空 url 往下走", async () => {
  const platform = await fakePlatform(() => ({ json: { id: 9 } }));
  try {
    await assert.rejects(
      () => createMergeRequest({
        platformUrl: platform.url,
        sourceBranch: "feat/a", targetBranch: "master", title: "t",
      }),
      /没有 MR 链接/);
  } finally {
    await platform.stop();
  }
});

test("MR 客户端:HTTP 错误带状态码与正文,别让人对着空白排障", async () => {
  const platform = await fakePlatform(() => ({
    status: 502, json: { error: "codehub cli 超时" },
  }));
  try {
    await assert.rejects(
      () => createMergeRequest({
        platformUrl: platform.url,
        sourceBranch: "feat/a", targetBranch: "master", title: "t",
      }),
      (error: Error) => {
        assert.match(error.message, /HTTP 502/);
        assert.match(error.message, /codehub cli 超时/);
        return true;
      });
  } finally {
    await platform.stop();
  }
});
