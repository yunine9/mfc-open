/**
 * MR 检视回复发送原语(需求侧与问题流共用,2026-09-16 抽取)。
 *
 * 共享件只收"怎么发":端点形状、幂等键头、请求体契约、非 2xx 抛错。
 * 何时发、SHA 怎么绑、重试几票是两侧各自拍板的政策(需求侧持票等
 * 收据,问题侧漂移即作废),不在这里,也不许悄悄统一。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { postMrDiscussionReply } from "../src/mrDiscussionReply.ts";

interface Captured {
  method?: string;
  url?: string;
  idempotencyKey?: string;
  contentType?: string;
  raw: string;
}

async function withCapture(
  run: (url: string, captured: Captured[]) => Promise<void>,
  status = 200,
): Promise<void> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const msg = request as IncomingMessage;
      const header = (name: string): string | undefined => {
        const value = msg.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      captured.push({
        method: msg.method,
        url: msg.url,
        idempotencyKey: header("idempotency-key"),
        contentType: header("content-type"),
        raw: Buffer.concat(chunks).toString("utf-8"),
      });
      response.statusCode = status;
      response.end(status === 200 ? "{}" : "boom");
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${
    (server.address() as AddressInfo).port}`;
  try {
    await run(url, captured);
  } finally {
    server.close();
  }
}

const base = (url: string) => ({
  platformUrl: url,
  discussionId: "disc-42",
  repo: "https://example.com/git/demo.git",
  body: "已修,请复核",
  resolve: false,
  idempotencyKey: "mrr-abc123",
  headers: { authorization: "Bearer t" },
});

test("发送原语:端点形状、幂等键头与请求体契约", async () => {
  await withCapture(async (url, captured) => {
    await postMrDiscussionReply(base(url));
    assert.equal(captured.length, 1);
    const hit = captured[0];
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, "/mr/discussions/disc-42/reply");
    assert.equal(hit.idempotencyKey, "mrr-abc123");
    assert.equal(hit.contentType, "application/json");
    const parsed = JSON.parse(hit.raw);
    assert.deepEqual(parsed, {
      repo: "https://example.com/git/demo.git",
      body: "已修,请复核",
      resolve: false,
      idempotency_key: "mrr-abc123",
    });
  });
});

test("发送原语:讨论 id 按路径段编码,mr 在场才出现,平台尾斜杠被剥", async () => {
  await withCapture(async (url, captured) => {
    await postMrDiscussionReply({
      ...base(url), platformUrl: `${url}/`,
      discussionId: "a/b c", mr: "17",
    });
    assert.equal(captured[0].url, "/mr/discussions/a%2Fb%20c/reply");
    const parsed = JSON.parse(captured[0].raw);
    assert.equal(parsed.mr, "17");
  });
  await withCapture(async (url, captured) => {
    await postMrDiscussionReply(base(url));
    assert.equal("mr" in JSON.parse(captured[0].raw), false);
  });
});

test("发送原语:自定义头透传,非 2xx 抛错带状态码", async () => {
  await withCapture(async (url, captured) => {
    await postMrDiscussionReply(base(url));
    assert.equal(captured[0].contentType, "application/json");
  });
  await withCapture(async (url) => {
    await assert.rejects(
      postMrDiscussionReply(base(url)),
      (error: Error) => /HTTP 503/.test(error.message),
    );
  }, 503);
});
