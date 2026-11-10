/**
 * 模型流传输预算的契约(根因见 src/modelTransport.ts 头注)。
 *
 * 裁判用真件:真 HTTP 服务端、真 undici dispatcher、真掐线——预算是否生效
 * 不靠读配置判断,靠沉默的连接到点被掐来证明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  createModelFetch,
  withModelTransport,
} from "../src/modelTransport.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
}

function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

test("模型流空闲预算必须高于 undici 默认的 300s,否则修了等于没修", () => {
  assert.ok(MODEL_STREAM_IDLE_TIMEOUT_MS > 300_000,
    `预算 ${MODEL_STREAM_IDLE_TIMEOUT_MS}ms 没有超过 Node 默认的 300s`);
  assert.ok(Number.isFinite(MODEL_STREAM_IDLE_TIMEOUT_MS) && MODEL_STREAM_IDLE_TIMEOUT_MS > 0,
    "预算必须是有限的:红线是等待必须带预算");
});

test("沉默的 SSE 在空闲预算到点被掐,错误如实抛出而不是无限等", async () => {
  // 服务端发完响应头和第一块就一声不吭——GLM 长生成吐首个 token 前就是这样。
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: message_start\ndata: {}\n\n");
  });
  const url = await listen(server);
  try {
    const fetch = createModelFetch(700);
    const started = Date.now();
    const response = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    await assert.rejects(async () => {
      for await (const _chunk of response.body as AsyncIterable<Uint8Array>) {
        // 一直等下一块,直到预算掐线。
      }
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 600 && elapsed < 5000,
      `应在 700ms 预算附近掐线,实测 ${elapsed}ms`);
  } finally {
    await shutdown(server);
  }
});

test("首字节之前同样有预算:服务端不回响应头,fetch 到点拒绝", async () => {
  const server = createServer(() => { /* 永不回应 */ });
  const url = await listen(server);
  try {
    const fetch = createModelFetch(500);
    const started = Date.now();
    await assert.rejects(fetch(url, { method: "POST", body: "{}" }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 5000,
      `应在 500ms 预算附近拒绝,实测 ${elapsed}ms`);
  } finally {
    await shutdown(server);
  }
});

test("withModelTransport 只在调用方没带 fetch 时注入,带了就尊重调用方", () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const runtime = {
    stream: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      seen.push(options); return "stream";
    },
    streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      seen.push(options); return "simple";
    },
  };
  const injected = (() => undefined) as unknown as typeof globalThis.fetch;
  const own = (() => undefined) as unknown as typeof globalThis.fetch;
  const wrapped = withModelTransport(runtime, injected);
  assert.equal(wrapped.streamSimple({}, {}, { timeoutMs: 1 }), "simple");
  assert.equal(seen[0]?.fetch, injected);
  assert.equal(seen[0]?.timeoutMs, 1, "其余选项必须原样透传");
  assert.equal(wrapped.stream({}, {}, { fetch: own }), "stream");
  assert.equal(seen[1]?.fetch, own, "调用方自带 fetch 时不能被覆盖");
  wrapped.streamSimple({}, {});
  assert.equal(seen[2]?.fetch, injected, "没有 options 也要注入");
});
