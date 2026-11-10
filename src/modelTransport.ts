/**
 * 模型流的传输预算——只给模型请求用的 fetch。
 *
 * 根因(cross-glm53-20260906c 实锤,本机对拍 301.5s 复现):Node 自带 undici
 * 的 bodyTimeout / headersTimeout 默认都是 300s——SSE 连接上 300s 没收到任何
 * 字节就掐线,pi-ai 把它收口成 stopReason=error、errorMessage="terminated"。
 * GLM 的 Anthropic 兼容网关在长生成(写 Story 卡这类)吐出第一个可见 token 之前
 * 一声不吭:全部演练里成功样本最长 246s,失败样本全落在 305~322s——正好是
 * 300s 掐线再加 pi 三次快速失败的自动重试。
 *
 * pi 自己的 CLI 也是 300s(configureHttpDispatcher),但那只在 CLI 入口装,
 * 走 SDK 的宿主从没装过;它的导出表也不放这个模块。所以宿主自备一个带
 * 长预算的 dispatcher,按请求塞给 pi-ai(`options.fetch` 是 pi-ai 的正式选项),
 * 不动全局 fetch,平台/内核请求照旧 Node 默认——它们本来就有各自的预算。
 *
 * 预算仍是有限的(红线:等待必须带预算):10 分钟一个字节都没有就认输,
 * 由 pi 的错误路径如实收口。10 分钟是"已知失败区间的两倍",不是上限的证明。
 */
import { Agent } from "undici";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;

type ModelFetch = typeof globalThis.fetch;

/** 一个 dispatcher 服务全部模型请求:连接复用与 Node 默认一致,只改空闲预算。 */
export function createModelFetch(idleTimeoutMs = MODEL_STREAM_IDLE_TIMEOUT_MS): ModelFetch {
  const dispatcher = new Agent({
    bodyTimeout: idleTimeoutMs,
    headersTimeout: idleTimeoutMs,
  });
  // 用 Node 自带的 fetch 而不是 npm undici 的 fetch:Response 留在全局 realm,
  // Anthropic SDK 那头的类型检查不会因为跨包对象而翻车。dispatcher 是 undici 7
  // 的标准选项,Node 24 内置的也是 undici 7(pi 的 CLI 多年就是这么搭的)。
  return ((input, init) =>
    globalThis.fetch(input, { ...(init ?? {}), dispatcher } as RequestInit)) as ModelFetch;
}

interface StreamRuntime {
  stream: (model: any, context: any, options?: any) => any;
  streamSimple: (model: any, context: any, options?: any) => any;
}

/** 给 pi 的 ModelRuntime 套上模型 fetch:调用方自带 fetch 时尊重调用方。 */
export function withModelTransport<T extends StreamRuntime>(
  runtime: T,
  fetch: ModelFetch = createModelFetch(),
): T {
  const stream = runtime.stream.bind(runtime);
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.stream = (model, context, options) =>
    stream(model, context, { ...(options ?? {}), fetch: options?.fetch ?? fetch });
  runtime.streamSimple = (model, context, options) =>
    streamSimple(model, context, { ...(options ?? {}), fetch: options?.fetch ?? fetch });
  return runtime;
}

/** 单发无工具补全。超时即弃,不做任何重试——起草是旁路,人可以再点。 */
export async function draftWithModel(input: {
  modelsJson: Record<string, unknown>;
  provider: string;
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
}): Promise<string> {
  const agentDir = mkdtempSync(join(tmpdir(), "mfc-model-reply-"));
  try {
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(input.modelsJson));
    const runtime = await ModelRuntime.create({
      modelsPath: join(agentDir, "models.json"),
    });
    const model = runtime.getModel(input.provider, input.model);
    if (!model) {
      throw new Error(
        `models.json 里找不到模型 ${input.provider}/${input.model}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),
      input.timeoutMs ?? 180_000);
    try {
      const reply = await runtime.completeSimple(model, {
        systemPrompt: input.system,
        messages: [{
          role: "user", content: input.user, timestamp: Date.now(),
        }],
      }, { signal: controller.signal } as never);
      const text = (reply.content ?? [])
        .filter((item): item is { type: "text"; text: string } =>
          (item as { type?: string }).type === "text")
        .map((item) => item.text).join("\n").trim();
      if (!text) {
        throw new Error(
          `模型没有返回草稿(stopReason=${String((reply as {
            stopReason?: string }).stopReason ?? "?")})`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}
