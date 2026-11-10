/**
 * 模型网关连通性测试(管理页「测试连通」的后半边)。
 *
 * 一次 POST 同时回答两件事:
 * 1. 网络连通——网关可解析、可建连、TLS 正常(收到任何 HTTP 状态码即算通,
 *    拒连/超时/DNS/证书按原因分类报给人);
 * 2. 模型问答——与生产同款的 Anthropic Messages 请求(pi 走官方 SDK,
 *    同一发 x-api-key + /v1/messages),验证 200 且回复非空,并区分
 *    密钥错/路径错/模型名错/限流/网关 5xx/空回复。
 *
 * 刻意不引新依赖:pi-ai 只是传递依赖,直接 import 它是拿解析器赌博;
 * 裸 fetch 复刻线上流量,诊断粒度(HTTP 状态码原文)反而更细。
 */

import type {
  SystemCheckItem,
  SystemCheckResult,
  SystemCheckStatus,
} from "./taskService.ts";
import { jsonProviders, type ModelsFormPatch, type ModelsSettings } from "./settings.ts";

export class GatewayCheckError extends Error {}

/** 表单支持的两种接口格式(pi 的 json 通路还有十种,测试只承诺这两种)。 */
export type GatewayApi = "openai-completions" | "anthropic-messages";

export interface GatewayTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  api: GatewayApi;
}

/** 表单草稿 > 管理页已存配置 > 部署 --models 兜底。密钥与 updateModels
 * 同口径:留空=沿用已存,界面永远不回填明文。三层拼完仍缺项就如实
 * 拒绝——测试打不出去的配置,报"没得测"比编造假结果诚实。 */
export function resolveGatewayTarget(
  body: ModelsFormPatch,
  stored: ModelsSettings | undefined,
  deployment: Record<string, unknown> | undefined,
): GatewayTarget {
  const storedProviders = jsonProviders(stored?.json);
  const storedProvider = stored?.provider
    || Object.keys(storedProviders)[0];
  const storedSpec = storedProviders[storedProvider ?? ""] ?? {};
  const deploymentProviders = jsonProviders(deployment);
  const deploymentSpec = deploymentProviders[Object.keys(deploymentProviders)[0] ?? ""] ?? {};
  const baseUrl = String(body.url ?? "").trim()
    || String(storedSpec.baseUrl ?? "").trim()
    || String(deploymentSpec.baseUrl ?? "").trim();
  const apiKey = String(body.api_key ?? "").trim()
    || String(storedSpec.apiKey ?? "").trim()
    || String(deploymentSpec.apiKey ?? "").trim();
  const model = String(body.model ?? "").trim()
    || String(stored?.model ?? "").trim()
    || String(deploymentSpec.models?.[0]?.id ?? "").trim();
  // 格式与表单默认同源:没说就 OpenAI Chat;已存/部署层带着什么就照用。
  const api = body.api !== undefined && String(body.api).trim()
    ? String(body.api)
    : String(storedSpec.api ?? deploymentSpec.api ?? "").trim()
      || "openai-completions";
  if (api !== "openai-completions" && api !== "anthropic-messages") {
    throw new GatewayCheckError(
      `测试连通暂只支持 OpenAI Chat 与 Anthropic Messages 两种接口格式`
      + `(当前配置是 ${api});其余格式请用网关侧手段验证`);
  }
  if (!baseUrl || !apiKey || !model) {
    throw new GatewayCheckError(
      "还没有可测试的模型网关配置:请先填写网关地址、API Key 和模型名称(或先保存)");
  }
  try {
    void new URL(baseUrl);
  } catch {
    throw new GatewayCheckError(`模型网关地址不是合法 URL: ${baseUrl}`);
  }
  return { baseUrl, apiKey, model, api: api as GatewayApi };
}

/** fetch 的失败原因散落在 cause 链的 code/name/message 里,undici 各版本
 * 包法不一;全部摊平成一段文本再按特征分类,比逐层猜稳。 */
function flattenError(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  while (cursor && parts.length < 8) {
    const node = cursor as { code?: unknown; name?: unknown; message?: unknown };
    if (node.code !== undefined) parts.push(String(node.code));
    if (node.name) parts.push(String(node.name));
    if (node.message) parts.push(String(node.message));
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

function networkFailure(error: unknown): SystemCheckItem {
  const text = flattenError(error);
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: "连接网关超时,未收到任何 HTTP 响应",
      suggestion: "检查网络/防火墙/代理是否放行该网关地址,或地址是否写错" };
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: "域名解析失败(ENOTFOUND)",
      suggestion: "检查网关地址拼写与部署机的 DNS 配置" };
  }
  if (/ECONNREFUSED/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: "连接被拒绝(ECONNREFUSED):端口未开放或被防火墙拦截",
      suggestion: "核对网关端口,确认服务在监听、防火墙放行" };
  }
  if (/certificate|CERT_|SSL|TLS|self-signed/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: `TLS 握手失败(证书问题): ${text.slice(0, 160)}`,
      suggestion: "内部 CA 需受系统信任;检查证书是否过期或域名不匹配" };
  }
  return { key: "network", label: "网络连通", status: "error",
    detail: `请求未能送达网关: ${text.slice(0, 200)}` };
}

function chatItem(
  api: GatewayApi,
  status: number,
  bodyText: string,
  elapsedMs: number,
  endpoint: string,
): SystemCheckItem {
  const gatewayMessage = (() => {
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      return message ? String(message).slice(0, 160) : "";
    } catch {
      return "";
    }
  })();
  if (status === 200) {
    const reply = extractReply(api, bodyText);
    if (!reply) {
      return { key: "chat", label: "模型问答", status: "warning",
        detail: "网关返回 200,但回复里没有文本内容",
        suggestion: "部分代理会吞正文;用网关侧日志核对模型是否真的出话" };
    }
    return { key: "chat", label: "模型问答", status: "ok",
      detail: `问答正常(${elapsedMs}ms):${reply.slice(0, 60)}` };
  }
  if (status === 401 || status === 403) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: `网关拒绝密钥(HTTP ${status})`
        + (gatewayMessage ? `:${gatewayMessage}` : ""),
      suggestion: "检查 API Key 是否正确、是否有该模型的调用权限" };
  }
  if (status === 404) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: "网关返回 404:接口路径不存在",
      suggestion: `按 ${WIRE[api].label} 格式,测试请求发往 ${endpoint};`
        + "确认网关地址与所选接口格式匹配" };
  }
  if (status === 400) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: `网关拒绝请求(400)${gatewayMessage ? `:${gatewayMessage}` : ""}`,
      suggestion: "常见原因是模型名称不被网关识别;核对「模型名称」字段" };
  }
  if (status === 429) {
    return { key: "chat", label: "模型问答", status: "warning",
      detail: "网关可达且密钥有效,但当前限流(429)",
      suggestion: "网关与密钥本身没问题;稍后重试或调大配额" };
  }
  if (status >= 500) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: `网关服务端错误(HTTP ${status})`
        + (gatewayMessage ? `:${gatewayMessage}` : ""),
      suggestion: "网络与密钥已通过;联系网关维护方排查服务端" };
  }
  return { key: "chat", label: "模型问答", status: "warning",
    detail: `网关返回了非预期状态 HTTP ${status}`
      + (gatewayMessage ? `:${gatewayMessage}` : ""),
    suggestion: "网络与密钥大概率没问题;核对网关对该接口的支持程度" };
}

function extractReply(api: GatewayApi, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      content?: Array<{ type?: string; text?: unknown }>;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    if (api === "anthropic-messages") {
      return (parsed.content ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => String(block.text ?? ""))
        .join(" ")
        .trim();
    }
    return String(parsed.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return "";
  }
}

/** 每种格式与 pi 生产流量同款:同一路径拼接、同一鉴权头、同一消息体。 */
const WIRE: Record<GatewayApi, {
  path: string;
  headers: (apiKey: string) => Record<string, string>;
  label: string;
}> = {
  "anthropic-messages": {
    path: "/v1/messages",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    label: "Anthropic Messages",
  },
  "openai-completions": {
    path: "/chat/completions",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    label: "OpenAI Chat",
  },
};

/** 一次真实请求,两项结论。网络项看"有没有 HTTP 响应",问答项看
 * "响应说了什么"——同一发请求,不重复打网关。 */
export async function checkModelGateway(
  target: GatewayTarget,
  timeoutMs = 15_000,
): Promise<SystemCheckResult> {
  const wire = WIRE[target.api];
  const endpoint = `${target.baseUrl.replace(/\/+$/, "")}${wire.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let bodyText = "";
  let network: SystemCheckItem;
  let chat: SystemCheckItem | undefined;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...wire.headers(target.apiKey),
      },
      body: JSON.stringify({
        model: target.model,
        // 推理模型会先返回 thinking block。32 token 可能刚好全耗在
        // thinking 上，网关明明正常却被判成“没有文本”；健康检查给
        // 足够的小预算容纳思考+两个字正文，仍远小于业务请求。
        max_tokens: 256,
        messages: [{
          role: "user",
          content: "连通性测试:请只回复两个字:正常",
        }],
        stream: false,
      }),
    });
    const status = response.status;
    bodyText = await response.text();
    const elapsed = Date.now() - startedAt;
    network = { key: "network", label: "网络连通", status: "ok",
      detail: `网关可达,已收到 HTTP 响应(${elapsed}ms)` };
    chat = chatItem(target.api, status, bodyText, elapsed, endpoint);
  } catch (error) {
    if (controller.signal.aborted) {
      network = { key: "network", label: "网络连通", status: "error",
        detail: `连接网关超时(${timeoutMs / 1000} 秒),未收到任何 HTTP 响应`,
        suggestion: "检查网络/防火墙/代理是否放行该网关地址,或地址是否写错" };
    } else {
      network = networkFailure(error);
    }
    chat = { key: "chat", label: "模型问答", status: "warning",
      detail: "网络连通未通过,问答测试已跳过" };
  } finally {
    clearTimeout(timer);
  }
  const items = [network, chat];
  const overall: SystemCheckStatus = items.some((item) => item.status === "error")
    ? "error"
    : items.some((item) => item.status === "warning") ? "warning" : "ok";
  return { checked_at: new Date().toISOString(), overall, items };
}
