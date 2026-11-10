import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDeliveryPlatform } from "../src/deliveryPlatformProbe.ts";
import { TaskService } from "../src/taskService.ts";

async function endpoint(payload: unknown): Promise<{
  url: string; close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("平台预检不是 ping：完整能力契约才算就绪", async () => {
  const platform = await endpoint({
    ok: true,
    endpoints: [
      "POST /mr",
      "POST /pipeline/trigger",
      "GET /pipeline/status?sha=&repo=",
    ],
  });
  try {
    const check = await probeDeliveryPlatform(platform.url);
    assert.equal(check.ready, true);
    assert.match(check.detail, /MR 创建.*流水线触发.*状态查询/);
  } finally {
    await platform.close();
  }
});

test("平台地址返回 200 + 空对象也判红，并阻止代码任务下单", async () => {
  const wrong = await endpoint({});
  try {
    const check = await probeDeliveryPlatform(wrong.url);
    assert.equal(check.ready, false);
    assert.match(check.detail, /不是完整/);
    assert.match(check.suggestion ?? "", /缺少能力/);

    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-platform-preflight-")),
      provider: "model", model: "model-1",
      modelsJson: { providers: { model: { models: [{ id: "model-1" }] } } },
      host: { kernelRoot: "/kernel" },
      delivery: { platformUrl: wrong.url },
    });
    await service.refreshDeliveryPlatformCheck();
    assert.match(
      service.launchOptions().blockers
        .find((item) => item.key === "platform_unhealthy")?.label ?? "",
      /平台预检未通过.*不是完整/,
    );
  } finally {
    await wrong.close();
  }
});

test("平台网络不可达时快速给出可执行原因", async () => {
  const check = await probeDeliveryPlatform("http://127.0.0.1:1", 200);
  assert.equal(check.ready, false);
  assert.equal(check.detail, "交付平台连接失败");
  assert.ok(check.suggestion);
});
