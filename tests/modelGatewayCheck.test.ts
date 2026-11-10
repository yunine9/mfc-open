/**
 * 模型网关连通性测试(modelGatewayCheck)的两层:
 * - resolveGatewayTarget:表单草稿 > 已存配置 > 部署默认,密钥留空=沿用;
 * - checkModelGateway:一次真实 POST,网络连通(有无 HTTP 响应)与模型
 *   问答(状态码/回复内容)分项结论。
 *
 * 夹具全在本地:ScriptedModelServer 演"健康的 Anthropic 兼容网关",
 * 裸 http 服务演 401/404 的病网关,关闭的端口演拒连。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { ScriptedModelServer } from "../src/scriptedModel.ts";
import type { SystemCheckItem, SystemCheckResult } from "../src/taskService.ts";
import {
  checkModelGateway,
  GatewayCheckError,
  resolveGatewayTarget,
} from "../src/modelGatewayCheck.ts";

function item(result: SystemCheckResult, key: string): SystemCheckItem {
  const found = result.items.find((entry) => entry.key === key);
  assert.ok(found, `结果里必须有 ${key} 项`);
  return found;
}

/** 对所有 POST 固定回一个状态码的病网关。 */
async function statusServer(status: number, body?: string): Promise<{
  baseUrl: string; close: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" })
        .end(body ?? JSON.stringify({ type: "error",
          error: { message: `fixture ${status}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) =>
      server.close(() => resolve())),
  };
}

test("resolveGatewayTarget:草稿优先,留空回落已存,全空才拒绝", () => {
  const stored = {
    provider: "maeflow",
    model: "stored-model",
    json: { providers: { maeflow: {
      baseUrl: "http://stored.example",
      apiKey: "stored-key",
      api: "anthropic-messages",
      models: [{ id: "stored-model" }],
    } } },
  };
  // 草稿全覆盖
  assert.deepEqual(
    resolveGatewayTarget({
      url: "http://draft.example", api_key: "draft-key",
      model: "draft-model", api: "openai-completions",
    }, stored, undefined),
    { baseUrl: "http://draft.example", apiKey: "draft-key",
      model: "draft-model", api: "openai-completions" });
  // 密钥留空=沿用已存;api 没送也沿用已存(界面不回填,保存测试同口径)
  assert.deepEqual(
    resolveGatewayTarget({ url: "http://draft.example" }, stored, undefined),
    { baseUrl: "http://draft.example", apiKey: "stored-key",
      model: "stored-model", api: "anthropic-messages" });
  // 没草稿没已存,部署 --models 兜底;api 也跟着部署层走
  assert.deepEqual(
    resolveGatewayTarget({}, undefined,
      { providers: { deploy: {
        baseUrl: "http://deploy.example", apiKey: "deploy-key",
        api: "anthropic-messages", models: [{ id: "deploy-model" }],
      } } }),
    { baseUrl: "http://deploy.example", apiKey: "deploy-key",
      model: "deploy-model", api: "anthropic-messages" });
  // 三层全空:格式落默认 OpenAI Chat(与表单默认一致)
  assert.deepEqual(
    resolveGatewayTarget({}, undefined,
      { providers: { deploy: {
        baseUrl: "http://deploy.example", apiKey: "deploy-key",
        models: [{ id: "deploy-model" }],
      } } }),
    { baseUrl: "http://deploy.example", apiKey: "deploy-key",
      model: "deploy-model", api: "openai-completions" });
  // 三层都拼不齐:如实报"没得测",不编结果
  assert.throws(() => resolveGatewayTarget({}, undefined, undefined),
    GatewayCheckError);
  assert.throws(() => resolveGatewayTarget({ url: "notaurl", api_key: "k",
    model: "m" }, undefined, undefined), GatewayCheckError);
  // 表单外的格式(pi 还有十种)测试不承诺,直说而不是乱测
  assert.throws(() => resolveGatewayTarget({
    url: "http://x", api_key: "k", model: "m", api: "google-generative-ai",
  }, undefined, undefined), /暂只支持/);
});

test("checkModelGateway:健康网关——网络通 + 问答正常", async () => {
  const gateway = new ScriptedModelServer(
    [{ text: "正常" }], "scripted-v1");
  await gateway.start();
  try {
    const result = await checkModelGateway({
      baseUrl: gateway.baseUrl, apiKey: "scripted", model: "scripted-v1",
      api: "anthropic-messages",
    });
    assert.equal(result.overall, "ok");
    assert.equal(item(result, "network").status, "ok");
    const chat = item(result, "chat");
    assert.equal(chat.status, "ok");
    assert.match(chat.detail, /正常/);
  } finally {
    await gateway.stop();
  }
});

test("checkModelGateway:推理模型预算可容纳 thinking 后的正文", async () => {
  let maxTokens = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      maxTokens = Number(body.max_tokens ?? 0);
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          type: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "先按要求判断回复内容" },
            { type: "text", text: "正常" },
          ],
        }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await checkModelGateway({
      baseUrl: base, apiKey: "glm-key", model: "glm-5.3-flash",
      api: "anthropic-messages",
    });
    assert.equal(result.overall, "ok");
    assert.equal(item(result, "chat").status, "ok");
    assert.match(item(result, "chat").detail, /正常/);
    assert.ok(maxTokens >= 128,
      "连通测试必须给推理块和最终文本都留出输出预算");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("checkModelGateway:OpenAI Chat——/chat/completions + Bearer 鉴权", async () => {
  // 真 OpenAI 形状的网关:校验路径与鉴权头,回 choices 结构。
  const seen: Array<{ path: string; auth: string; body: any }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      seen.push({
        path: request.url ?? "",
        auth: String(request.headers.authorization ?? ""),
        body,
      });
      if (request.url !== "/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "正常" } }],
        }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await checkModelGateway({
      baseUrl: base, apiKey: "sk-openai", model: "glm-5.1",
      api: "openai-completions",
    });
    assert.equal(result.overall, "ok");
    assert.equal(seen[0].path, "/chat/completions",
      "OpenAI Chat 格式必须打到 chat/completions");
    assert.equal(seen[0].auth, "Bearer sk-openai",
      "OpenAI Chat 格式用 Bearer 鉴权");
    assert.equal(seen[0].body.model, "glm-5.1");
    assert.match(item(result, "chat").detail, /正常/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("checkModelGateway:401——网络通,密钥被拒并指向密钥", async () => {
  const gateway = await statusServer(401);
  try {
    const result = await checkModelGateway({
      baseUrl: gateway.baseUrl, apiKey: "wrong", model: "any",
      api: "anthropic-messages",
    });
    assert.equal(result.overall, "error");
    assert.equal(item(result, "network").status, "ok");
    const chat = item(result, "chat");
    assert.equal(chat.status, "error");
    assert.match(chat.detail, /401/);
    assert.match(chat.suggestion ?? "", /API Key/);
  } finally {
    await gateway.close();
  }
});

test("checkModelGateway:404——指向 Anthropic 兼容路径的建议", async () => {
  const gateway = await statusServer(404);
  try {
    const result = await checkModelGateway({
      baseUrl: gateway.baseUrl, apiKey: "k", model: "any",
      api: "anthropic-messages",
    });
    const chat = item(result, "chat");
    assert.equal(chat.status, "error");
    assert.match(chat.detail, /404/);
    assert.match(chat.suggestion ?? "", /v1\/messages/);
  } finally {
    await gateway.close();
  }
});

test("checkModelGateway:端口不通——网络项分类报错,问答跳过", async () => {
  // 先起一个拿到空闲端口,再立刻关掉——用它当"没人监听"的地址。
  const probe = await statusServer(200);
  const deadBase = probe.baseUrl;
  await probe.close();
  const result = await checkModelGateway({
    baseUrl: deadBase, apiKey: "k", model: "any",
      api: "anthropic-messages",
  });
  assert.equal(result.overall, "error");
  const network = item(result, "network");
  assert.equal(network.status, "error");
  assert.match(network.detail, /ECONNREFUSED|未能送达/);
  assert.equal(item(result, "chat").status, "warning");
});

test("checkModelGateway:400——透出网关原文,建议核对模型名", async () => {
  const gateway = await statusServer(400,
    JSON.stringify({ type: "error",
      error: { type: "invalid_request_error",
        message: "model not found: no-such-model" } }));
  try {
    const result = await checkModelGateway({
      baseUrl: gateway.baseUrl, apiKey: "k", model: "no-such-model",
      api: "anthropic-messages",
    });
    const chat = item(result, "chat");
    assert.equal(chat.status, "error");
    assert.match(chat.detail, /model not found/);
    assert.match(chat.suggestion ?? "", /模型名称/);
  } finally {
    await gateway.close();
  }
});
