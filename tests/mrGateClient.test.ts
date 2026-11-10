import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchMrGates } from "../src/mrGateClient.ts";
import { classifyDeliveryFailure } from "../src/deliveryFailure.ts";

async function platform(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const options = { repo: "repo", headers: {}, requireExisting: true,
  delivery: { mr_id: 42, source_branch: "feature", target_branch: "main" } };

test("读取响应体时超时仍属网络故障，不能误判成 JSON 契约错误", async t => {
  const platformUrl = await platform(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"mr_state":');
  });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(50));
  let failure = "";
  assert.equal(await fetchMrGates({ ...options, platformUrl, onFailure: reason => { failure = reason; } }), undefined);
  assert.ok(failure);
  assert.equal(classifyDeliveryFailure(failure).disposition, "retry");
});

for (const body of ['not json', 'null', '[]', '{"mr_state":"unknown"}']) {
  test(`MR 响应 ${body} 保留确定性错误而不是猜成 opened`, async t => {
    const platformUrl = await platform(t, (_req, res) => res.end(body));
    let failure = "";
    assert.equal(await fetchMrGates({ ...options, platformUrl, onFailure: reason => { failure = reason; } }), undefined);
    assert.equal(classifyDeliveryFailure(failure).disposition, "stall");
    assert.match(failure, /交付平台响应不完整/);
  });
}

test("连接被断开可重试；不输出个人令牌", async t => {
  const platformUrl = await platform(t, req => req.socket.destroy());
  let failure = "";
  assert.equal(await fetchMrGates({ ...options, platformUrl,
    headers: { "x-mfc-git-token": "test-private-token" },
    onFailure: reason => { failure = reason; } }), undefined);
  assert.ok(failure);
  assert.equal(classifyDeliveryFailure(failure).disposition, "retry");
  assert.ok(!failure.includes("test-private-token"));
});
