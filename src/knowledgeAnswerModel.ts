/** 问答专用模型会话：只有显式提供的只读工具，不加载编码提示或工作区工具。 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent as HttpAgent } from "undici";
import { Check } from "typebox/value";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";

type RequestContext = Parameters<ModelRuntime["streamSimple"]>[1];
type Message = RequestContext["messages"][number];
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
export type KnowledgeAnswerTool = ToolDefinition<any, any>;
export type KnowledgeAnswerRuntime = Pick<ModelRuntime, "getModel" | "streamSimple">;
export interface KnowledgeAnswerModelChoice { provider: string; model: string; json: unknown }

/** 只暴露宿主自己生成的错误，提供方错误可能含端点、请求和认证信息。 */
export class KnowledgeAnswerError extends Error {}
/** 提交协议或格式不完整，可在同一原问题和证据上重新生成一次；不包含模型原文。 */
export class KnowledgeAnswerSubmissionError extends KnowledgeAnswerError {}

export interface KnowledgeAnswerModelRequest {
  stage: "researching" | "answering";
  system: string;
  user: string;
  images?: Array<{ label: string; data: string; mimeType: string }>;
  tools: KnowledgeAnswerTool[];
  /** 回答阶段唯一的终结工具，只接收答案，不执行来源查询或产生副作用。 */
  outputTool?: Pick<KnowledgeAnswerTool, "name" | "description" | "parameters">;
  signal: AbortSignal;
  deadlineAt: number;
  maxRounds: number;
  maxToolCalls: number;
  maxContextChars: number;
  maxOutputTokens: number;
  onTool(name: string): void;
  warn(message: string): void;
}
export interface KnowledgeAnswerModelOutput {
  text: string;
  complete: boolean;
  reason?: "round_limit" | "tool_limit" | "context_limit" | "output_limit";
}
export interface KnowledgeAnswerModel {
  /** 每次调用新建消息列表；运行时和连接池可复用，研究历史绝不跨调用携带。 */
  run(request: KnowledgeAnswerModelRequest): Promise<KnowledgeAnswerModelOutput>;
  inputBudgetChars?: number;
  dispose(): void | Promise<void>;
}

/** Base64 是传输编码，不能当作正文 token；每张图片预留独立的视觉输入预算。 */
function contextCharacters(value: unknown): number {
  let images = 0;
  const text = JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && entry.type === "image") {
      images++;
      return { type: "image", mimeType: entry.mimeType };
    }
    return entry;
  });
  return text.length + images * 4096;
}
type AnswerStage = KnowledgeAnswerModelRequest["stage"];
type ObservedEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "omitted" | "unknown";
type ObservedThinking = "disabled" | "enabled" | "adaptive" | "omitted" | "unknown";
type ObservedUsage = Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "reasoning" | "totalTokens", number>>;
type SubmissionRejectionCategory = "tool_protocol" | "raw_json" | "schema" | "budget";
/** 观察记录只含固定枚举和数值，不包含模型标识、请求、配置、错误正文或思考内容。 */
export type KnowledgeAnswerModelObservation = { stage: AnswerStage; round: number } & (
  { event: "request_start"; requested_max_tokens: number }
  | { event: "request_payload"; elapsed_ms: number; max_tokens?: number; effort: ObservedEffort; thinking_type: ObservedThinking }
  | { event: "first_text_delta" | "first_thinking_delta"; elapsed_ms: number }
  | { event: "request_end"; elapsed_ms: number; stop_reason: "stop" | "length" | "toolUse" | "error" | "aborted" | "pending" | "unknown";
      usage: ObservedUsage; text_chars: number; thinking_chars: number }
  | { event: "request_failed"; elapsed_ms: number; reason: "cancelled" | "deadline" | "operation_failed" }
  | { event: "submission_rejected"; elapsed_ms: number; category: SubmissionRejectionCategory }
);
export interface KnowledgeAnswerModelOptions {
  choice: KnowledgeAnswerModelChoice;
  signal: AbortSignal;
  /** 默认不记录或写盘；回调失败不影响模型调用，接收方不得据此取得原文。 */
  observe?: (event: KnowledgeAnswerModelObservation) => void | Promise<void>;
  /** 离线协议测试注入，不读取机器上的默认模型或认证文件。 */
  runtimeFactory?: (options: Parameters<typeof ModelRuntime.create>[0]) => Promise<KnowledgeAnswerRuntime>;
}

export function throwIfAnswerStopped(signal: AbortSignal, deadlineAt = Infinity): void {
  if (signal.aborted) throw new KnowledgeAnswerError("知识问答已取消或超过时间预算");
  if (performance.now() >= deadlineAt) throw new KnowledgeAnswerError("知识问答超过时间预算");
}

/** 对不遵守 AbortSignal 的第三方等待也及时返回，底层仍收到同一个取消信号。 */
export async function waitForAnswerOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throwIfAnswerStopped(signal); }
  let stop: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(new KnowledgeAnswerError("知识问答已取消或超过时间预算"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { if (stop) signal.removeEventListener("abort", stop); }
}

/** 研究用低强度；GLM 5.3 回答用提供方的 high，其他推理模型由 SDK 映射中等强度。 */
export function knowledgeAnswerReasoningOptions(model: Pick<Parameters<ModelRuntime["streamSimple"]>[0], "api" | "id" | "reasoning">,
  stage: KnowledgeAnswerModelRequest["stage"]): Partial<NonNullable<Parameters<ModelRuntime["streamSimple"]>[2]>> {
  const effort = stage === "researching" ? "low" : "medium";
  if (model.api === "anthropic-messages" && /^glm-5\.3(?:-|$)/i.test(model.id)) {
    return { onPayload: payload => {
      const original = payload as Record<string, unknown>;
      const config = original.output_config && typeof original.output_config === "object" && !Array.isArray(original.output_config)
        ? original.output_config as Record<string, unknown> : {};
      return { ...original, output_config: { ...config, effort: stage === "researching" ? "low" : "high" } };
    } };
  }
  return model.reasoning ? { reasoning: effort } : {};
}

export async function createKnowledgeAnswerModel(options: KnowledgeAnswerModelOptions): Promise<KnowledgeAnswerModel> {
  throwIfAnswerStopped(options.signal);
  const observe = (event: KnowledgeAnswerModelObservation) => {
    if (!options.observe) return;
    try { void Promise.resolve(options.observe(event)).catch(() => undefined); } catch { /* 记录失败不影响回答。 */ }
  };
  const temporary = mkdtempSync(join(tmpdir(), "mfc-knowledge-answer-"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  let dispatcher: HttpAgent | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    options.signal.removeEventListener("abort", stop);
    // 认证文件不等待网络连接关闭后才删除。
    rmSync(temporary, { recursive: true, force: true });
    await dispatcher?.destroy();
  };
  try {
    // 配置可能含认证信息；目录由 mkdtemp 创建，文件仅当前用户可读写。
    writeFileSync(join(temporary, "models.json"), JSON.stringify(options.choice.json), { mode: 0o600, flag: "wx" });
    writeFileSync(join(temporary, "auth.json"), "{}", { mode: 0o600, flag: "wx" });
    const runtime = await waitForAnswerOperation((options.runtimeFactory ?? ModelRuntime.create)({
      modelsPath: join(temporary, "models.json"), authPath: join(temporary, "auth.json"),
      modelsStorePath: join(temporary, "models-cache.json"),
      allowModelNetwork: false, refreshOnCreate: false, signal: controller.signal,
    }), controller.signal);
    throwIfAnswerStopped(controller.signal);
    const model = runtime.getModel(options.choice.provider, options.choice.model);
    if (!model) throw new KnowledgeAnswerError("当前主模型配置中找不到所选模型");
    dispatcher = new HttpAgent({ bodyTimeout: 600_000, headersTimeout: 600_000 });
    const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
    const inputBudgetChars = Math.max(1024, Math.floor((model.contextWindow || 128_000) - Math.min(model.maxTokens || 8192, 16384) - 4096));
    return {
      inputBudgetChars,
      dispose,
      async run(request) {
        const signal = AbortSignal.any([controller.signal, request.signal]);
        throwIfAnswerStopped(signal, request.deadlineAt);
        const tools = new Map(request.tools.map(tool => [tool.name, tool]));
        if (tools.size !== request.tools.length) throw new KnowledgeAnswerError("问答工具名称重复");
        const outputTool = request.outputTool;
        if (outputTool && (request.stage !== "answering" || request.tools.length || request.maxRounds !== 1)) {
          throw new KnowledgeAnswerError("答案提交只允许一个独立回答请求，不混用来源工具或继续对话");
        }
        if (request.images?.length && !model.input?.includes("image")) throw new KnowledgeAnswerError("当前问答模型不支持图片，不能基于尚未读取的图片生成答案");
        const messages: Message[] = [{ role: "user", content: request.images?.length
          ? [{ type: "text" as const, text: request.user }, ...request.images.flatMap(image => [
            { type: "text" as const, text: image.label }, { type: "image" as const, data: image.data, mimeType: image.mimeType }])]
          : request.user, timestamp: Date.now() }];
        const contextBudget = Math.min(request.maxContextChars, inputBudgetChars);
        let toolCalls = 0;
        try {
          for (let round = 0; round < request.maxRounds; round++) {
            throwIfAnswerStopped(signal, request.deadlineAt);
            const definitions = (outputTool ? [outputTool] : [...tools.values()])
              .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
            if (request.system.length + contextCharacters(messages) + JSON.stringify(definitions).length > contextBudget) {
              return { text: "", complete: false, reason: "context_limit" };
            }
            const began = performance.now(), meta = { stage: request.stage, round: round + 1 };
            const elapsed = () => Math.max(0, Math.round(performance.now() - began));
            const submissionError = (category: SubmissionRejectionCategory, message: string) => {
              observe({ ...meta, event: "submission_rejected", elapsed_ms: elapsed(), category });
              return new KnowledgeAnswerSubmissionError(message);
            };
            const maxTokens = Math.min(request.maxOutputTokens, model.maxTokens || request.maxOutputTokens);
            const reasoning = knowledgeAnswerReasoningOptions(model, request.stage);
            const onPayload: typeof reasoning.onPayload = options.observe ? async (payload, selectedModel) => {
              const next = (await reasoning.onPayload?.(payload, selectedModel)) ?? payload;
              const row = next && typeof next === "object" ? next as Record<string, any> : {};
              const effort = row.output_config?.effort ?? row.reasoning_effort ?? row.reasoning?.effort;
              const thinking = row.thinking?.type;
              observe({ ...meta, event: "request_payload", elapsed_ms: elapsed(),
                ...(typeof row.max_tokens === "number" && Number.isFinite(row.max_tokens) && row.max_tokens >= 0 ? { max_tokens: row.max_tokens }
                  : typeof row.max_output_tokens === "number" && Number.isFinite(row.max_output_tokens) && row.max_output_tokens >= 0 ? { max_tokens: row.max_output_tokens } : {}),
                effort: effort === undefined ? "omitted" : ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : "unknown",
                thinking_type: thinking === undefined ? "omitted" : ["disabled", "enabled", "adaptive"].includes(thinking) ? thinking : "unknown" });
              return next;
            } : reasoning.onPayload;
            observe({ ...meta, event: "request_start", requested_max_tokens: maxTokens });
            let firstText = false, firstThinking = false, response: AssistantMessage;
            const rawInputs = new Map<number, string>();
            const endedCalls = new Map<number, { id: string; name: string }>();
            try {
              const stream = runtime.streamSimple(model, { systemPrompt: request.system, messages, tools: definitions }, {
                signal, fetch, maxRetries: 0, timeoutMs: Math.max(1, Math.ceil(request.deadlineAt - performance.now())),
                maxTokens, ...reasoning, ...(onPayload ? { onPayload } : {}),
              });
              response = await waitForAnswerOperation((async () => {
                for await (const event of stream) {
                  throwIfAnswerStopped(signal, request.deadlineAt);
                  if (!firstText && event.type === "text_delta" && event.delta.length) {
                    firstText = true; observe({ ...meta, event: "first_text_delta", elapsed_ms: elapsed() });
                  }
                  if (!firstThinking && event.type === "thinking_delta" && event.delta.length) {
                    firstThinking = true; observe({ ...meta, event: "first_thinking_delta", elapsed_ms: elapsed() });
                  }
                  if (outputTool) {
                    if (event.type === "toolcall_start") {
                      if (rawInputs.has(event.contentIndex) || endedCalls.has(event.contentIndex)) {
                        throw submissionError("tool_protocol", "答案提交重复开始");
                      }
                      rawInputs.set(event.contentIndex, "");
                    }
                    if (event.type === "toolcall_delta") {
                      if (endedCalls.has(event.contentIndex)) throw submissionError("tool_protocol", "答案提交结束后仍收到参数");
                      const raw = (rawInputs.get(event.contentIndex) ?? "") + event.delta;
                      if (raw.length > contextBudget) throw submissionError("budget", "答案提交参数超过本次预算");
                      rawInputs.set(event.contentIndex, raw);
                    }
                    if (event.type === "toolcall_end") {
                      if (endedCalls.has(event.contentIndex)) throw submissionError("tool_protocol", "答案提交重复结束");
                      endedCalls.set(event.contentIndex, { id: event.toolCall.id, name: event.toolCall.name });
                    }
                  }
                }
                return await stream.result();
              })(), signal);
              const usage: ObservedUsage = {};
              for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
                const value = response.usage?.[key];
                if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
              }
              observe({ ...meta, event: "request_end", elapsed_ms: elapsed(),
                stop_reason: (["stop", "length", "toolUse", "error", "aborted", "pending"] as const).find(value => value === response.stopReason) ?? "unknown",
                usage, text_chars: response.content.filter(block => block.type === "text").reduce((sum, block) => sum + block.text.length, 0),
                thinking_chars: response.content.filter(block => block.type === "thinking").reduce((sum, block) => sum + block.thinking.length, 0) });
            } catch (error) {
              observe({ ...meta, event: "request_failed", elapsed_ms: elapsed(), reason: signal.aborted ? "cancelled"
                : performance.now() >= request.deadlineAt ? "deadline" : "operation_failed" });
              throw error;
            }
            throwIfAnswerStopped(signal, request.deadlineAt);
            if (response.stopReason === "aborted" || response.stopReason === "error") throw new KnowledgeAnswerError("模型调用未完成，未生成可展示的答案");
            if (response.stopReason === "length") return { text: "", complete: false, reason: "output_limit" };
            const text = response.content.filter(block => block.type === "text").map(block => block.text).join("");
            const calls = response.content.filter((block): block is ToolCall => block.type === "toolCall");
            if (outputTool) {
              // 部分模型返回完整文本 JSON。仅在本次没有任何工具事件时兼容，不能用正文补救残缺提交。
              if (!calls.length && !rawInputs.size && !endedCalls.size && response.stopReason === "stop") {
                let args: unknown;
                try { args = JSON.parse(text); }
                catch { throw submissionError("raw_json", "答案文本不是完整 JSON"); }
                if (!Check(outputTool.parameters, args)) throw submissionError("schema", "答案文本字段不符合定义");
                return { text: JSON.stringify(args), complete: true };
              }
              const [index, ended] = [...endedCalls][0] ?? [];
              const call = calls[0];
              if (response.stopReason !== "toolUse" || calls.length !== 1 || endedCalls.size !== 1
                || rawInputs.size !== 1 || index === undefined || !rawInputs.has(index)
                || !call || call.name !== outputTool.name || ended?.name !== call.name || ended?.id !== call.id) {
                throw submissionError("tool_protocol", "模型须完整提交唯一答案，不能混用其他工具或未结束的参数");
              }
              let args: unknown;
              // SDK 会修补不完整工具 JSON；答案必须依据原始参数严格解析，不能使用其修补后的 arguments。
              try { args = JSON.parse(rawInputs.get(index)!); }
              catch { throw submissionError("raw_json", "答案提交参数不是完整 JSON"); }
              if (!Check(outputTool.parameters, args)) throw submissionError("schema", "答案提交字段不符合定义");
              return { text: JSON.stringify(args), complete: true };
            }
            if (!calls.length) {
              if (response.stopReason !== "stop" || !text.trim()) throw new KnowledgeAnswerError("模型未返回完整内容");
              return { text, complete: true };
            }
            messages.push(response);
            const allowed = calls.slice(0, Math.max(0, request.maxToolCalls - toolCalls));
            toolCalls += allowed.length;
            // 同一轮提交的只读查询没有结果依赖，最多三项并行，按原调用顺序交回模型。
            for (let offset = 0; offset < allowed.length; offset += 3) {
              throwIfAnswerStopped(signal, request.deadlineAt);
              const results = await Promise.all(allowed.slice(offset, offset + 3).map(async (call): Promise<Message> => {
                throwIfAnswerStopped(signal, request.deadlineAt);
                const tool = tools.get(call.name);
                if (!tool) throw new KnowledgeAnswerError("模型请求了本次问答未提供的工具");
                request.onTool(tool.name);
                let result: { content: any[]; isError?: boolean };
                try {
                  const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
                  if (!Check(tool.parameters, args)) throw new KnowledgeAnswerError("工具参数不符合定义");
                  const value = await waitForAnswerOperation(Promise.resolve(tool.execute(call.id, args, signal, undefined, { hasUI: false, model } as any)), signal);
                  throwIfAnswerStopped(signal, request.deadlineAt);
                  if (!Array.isArray(value?.content) || value.content.some(block => block.type !== "text" && block.type !== "image")) throw new KnowledgeAnswerError("问答工具只能返回文本或原始图片");
                  if (value.content.some(block => block.type === "image") && !model.input?.includes("image")) throw new KnowledgeAnswerError("当前问答模型不支持图片，尚未读取图中内容");
                  result = value;
                  if ((value as any).isError) request.warn("来源工具未完成一次查询，不能据此认定相关知识不存在");
                } catch (error) {
                  throwIfAnswerStopped(signal, request.deadlineAt);
                  request.warn("来源工具查询失败，已保留未确认状态");
                  result = { isError: true, content: [{ type: "text", text: "此次查询未完成或参数无效，没有取得可确认的新证据。请检查参数或使用其他适用来源，不能据此断言知识不存在。" }] };
                }
                // 超长工具回复不进入历史；来源保存的原文仍受 runner 的独立证据预算保护。
                if (contextCharacters(result.content) > contextBudget / 2) {
                  request.warn("一次工具返回超过研究上下文预算，请使用较小范围或分页读取");
                  result = { isError: true, content: [{ type: "text", text: "返回内容超过上下文预算，本条未展开。请缩小读取范围或分页；未展开的内容不代表不存在。" }] };
                }
                return { role: "toolResult", toolCallId: call.id, toolName: call.name,
                  content: result.content, isError: Boolean(result.isError), timestamp: Date.now() };
              }));
              messages.push(...results);
            }
            if (allowed.length < calls.length) return { text: "", complete: false, reason: "tool_limit" };
          }
          return { text: "", complete: false, reason: "round_limit" };
        } catch (error) {
          if (error instanceof KnowledgeAnswerError) throw error;
          throw new KnowledgeAnswerError("模型或来源调用失败，未生成可展示的答案");
        }
      },
    };
  } catch (error) {
    await dispose();
    if (error instanceof KnowledgeAnswerError) throw error;
    throw new KnowledgeAnswerError("无法初始化知识问答主模型，请检查模型配置");
  }
}
