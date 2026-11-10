import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { createKnowledgeAnswerModel, KnowledgeAnswerSubmissionError, knowledgeAnswerReasoningOptions, type KnowledgeAnswerModelObservation, type KnowledgeAnswerModelRequest } from "../src/knowledgeAnswerModel.ts";

const response = (content: any[], stopReason = "stop") => ({ role: "assistant", content, stopReason, provider: "test", model: "m", api: "openai-completions", timestamp: Date.now(), usage: {} } as any);
const stream = (value: any) => ({ async *[Symbol.asyncIterator]() {}, result: async () => value } as any);
const streamEvents = (value: any, events: any[]) => ({ async *[Symbol.asyncIterator]() { yield* events; }, result: async () => value } as any);
const outputTool = { name: "submit_answer", description: "提交完整答案，不执行其他动作", parameters: Type.Object({
  points: Type.Array(Type.Object({ kind: Type.Literal("answer"), body: Type.String(),
    basis: Type.Array(Type.Object({ evidence_id: Type.String(), start_line: Type.Integer(), end_line: Type.Integer() }, { additionalProperties: false })) }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false }) };
const submitted = (body = "答复") => ({ points: [{ kind: "answer", body,
  basis: [{ evidence_id: "ev-1", start_line: 1, end_line: 1 }] }] });
const submitCall = (args: unknown, id = "submit-1", name = outputTool.name) => ({ type: "toolCall", id, name, arguments: args });
function submitEvents(raw: string, call: any, contentIndex = 0): any[] {
  const middle = Math.floor(raw.length / 2);
  return [{ type: "toolcall_start", contentIndex },
    { type: "toolcall_delta", contentIndex, delta: raw.slice(0, middle) },
    { type: "toolcall_delta", contentIndex, delta: raw.slice(middle) },
    { type: "toolcall_end", contentIndex, toolCall: call }];
}
function request(signal: AbortSignal, override: Partial<KnowledgeAnswerModelRequest> = {}): KnowledgeAnswerModelRequest {
  return { stage: "answering", system: "仅基于原文", user: "问题与原文", tools: [], signal, deadlineAt: performance.now() + 1000,
    maxRounds: 1, maxToolCalls: 0, maxContextChars: 100_000, maxOutputTokens: 1000, onTool: () => {}, warn: () => {}, ...override };
}

test("研究后的两次回答都重建消息，不载入编码工具，临时配置0600且结束删除", async () => {
  const controller = new AbortController(), seen: any[] = [];
  let configPath = "", calls = 0;
  const model = await createKnowledgeAnswerModel({ choice: { provider: "custom", model: "custom-model", json: { privateKey: "secret-test" } }, signal: controller.signal,
    runtimeFactory: async options => {
      configPath = options!.modelsPath!;
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
      assert.equal(statSync(options!.authPath!).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(options!.authPath!, "utf8")), {});
      assert.equal(options!.allowModelNetwork, false);
      assert.equal(options!.refreshOnCreate, false);
      return {
        getModel: (provider, id) => { assert.equal(provider, "custom"); assert.equal(id, "custom-model"); return { id, provider, api: "openai-completions", reasoning: false, maxTokens: 4096, contextWindow: 128_000 } as any; },
        streamSimple: (_model, context, options) => {
          seen.push({ context: structuredClone(context), options });
          return stream(calls++ === 0 ? response([{ type: "toolCall", id: "c1", name: "read_source", arguments: {} }], "toolUse") : response([{ type: "text", text: "完成" }]));
        },
      };
    },
  });
  try {
    const tools = [{ name: "read_source", label: "读取", description: "只读", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "原文" }], details: {} }) }];
    assert.equal((await model.run(request(controller.signal, { stage: "researching", tools, maxRounds: 2, maxToolCalls: 1 }))).complete, true);
    await model.run(request(controller.signal, { user: "FIRST_ANSWER_INPUT" }));
    await model.run(request(controller.signal, { user: "SECOND_ANSWER_INPUT" }));
    assert.deepEqual(seen[0].context.tools.map((tool: any) => tool.name), ["read_source"]);
    assert.deepEqual(seen[1].context.messages.map((message: any) => message.role), ["user", "assistant", "toolResult"]);
    assert.deepEqual(seen[2].context.messages.map((message: any) => message.role), ["user"]);
    assert.deepEqual(seen[2].context.tools, []);
    assert.deepEqual(seen[3].context.messages.map((message: any) => message.role), ["user"]);
    assert.deepEqual(seen[3].context.tools, []);
    assert.equal(seen[2].context.messages[0].content, "FIRST_ANSWER_INPUT");
    assert.equal(seen[3].context.messages[0].content, "SECOND_ANSWER_INPUT");
    assert.doesNotMatch(JSON.stringify(seen[3].context), /FIRST_ANSWER_INPUT|toolResult|read_source/);
    assert.equal(seen[0].options.maxRetries, 0);
    assert.equal(seen[0].options.reasoning, undefined);
    assert.equal(seen[0].options.onPayload, undefined);
    assert.ok(seen[0].options.timeoutMs <= 1000);
  } finally { await model.dispose(); }
  assert.equal(existsSync(dirname(configPath)), false);
  assert.equal(seen[0].options.signal.aborted, true);
});

test("同轮只读查询并行但最多三项，乱序完成仍按调用顺序返回且不超工具预算", async () => {
  const signal = new AbortController().signal, started: string[] = [], seen: any[] = [];
  const releases = new Map<string, () => void>();
  const calls = Array.from({ length: 5 }, (_, index) => ({ type: "toolCall", id: `c${index}`, name: "read_source", arguments: {} }));
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: (_model, context) => { seen.push(structuredClone(context)); return stream(seen.length % 2 === 1 ? response(calls, "toolUse") : response([{ type: "text", text: "资料查阅结束" }])); } }),
  });
  const tools = [{ name: "read_source", label: "读取资料", description: "只读", parameters: Type.Object({}),
    execute: async (id: string) => { started.push(id); await new Promise<void>(resolve => releases.set(id, resolve)); return { content: [{ type: "text" as const, text: id }], details: {} }; } }];
  const waitFor = async (count: number) => { for (let n = 0; n < 100 && started.length < count; n++) await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(started.length, count); };
  try {
    const pending = model.run(request(signal, { stage: "researching", tools, maxRounds: 2, maxToolCalls: 5 }));
    await waitFor(3); releases.get("c2")!(); releases.get("c1")!(); releases.get("c0")!();
    await waitFor(5); releases.get("c4")!(); releases.get("c3")!();
    assert.equal((await pending).complete, true);
    assert.deepEqual(seen[1].messages.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId), calls.map(call => call.id));
    started.length = 0; releases.clear();
    const limited = model.run(request(signal, { stage: "researching", tools, maxRounds: 2, maxToolCalls: 2 }));
    await waitFor(2); releases.get("c1")!(); releases.get("c0")!();
    assert.equal((await limited).reason, "tool_limit");
    assert.deepEqual(started, ["c0", "c1"]);
  } finally { for (const resolve of releases.values()) resolve(); await model.dispose(); }
});

test("研究用原生low、回答用原生medium，GLM5.3兼容路径回答用high且保留思考", async () => {
  const glm = { api: "anthropic-messages", id: "glm-5.3", reasoning: false } as const;
  for (const stage of ["researching", "answering"] as const) {
    const options = knowledgeAnswerReasoningOptions(glm, stage);
    assert.equal(options.reasoning, undefined);
    const payload = await (options.onPayload as any)({ model: "glm-5.3", thinking: { type: "enabled" }, output_config: { other: "preserved" } });
    assert.deepEqual(payload, { model: "glm-5.3", thinking: { type: "enabled" }, output_config: { other: "preserved", effort: stage === "researching" ? "low" : "high" } });
  }
  assert.deepEqual(knowledgeAnswerReasoningOptions({ api: "openai-responses", id: "native", reasoning: true }, "answering"), { reasoning: "medium" });
  assert.deepEqual(knowledgeAnswerReasoningOptions({ api: "openai-responses", id: "native", reasoning: true }, "researching"), { reasoning: "low" });
  assert.deepEqual(knowledgeAnswerReasoningOptions({ api: "anthropic-messages", id: "unknown-compat", reasoning: false }, "answering"), {});
  assert.deepEqual(knowledgeAnswerReasoningOptions({ api: "openai-completions", id: "glm-5.3", reasoning: false }, "answering"), {});
  assert.deepEqual(knowledgeAnswerReasoningOptions({ api: "anthropic-messages", id: "native", reasoning: true }, "answering"), { reasoning: "medium" });
});

test("初始化失败清理认证临时目录且不透传供应方错误", async () => {
  let path = "";
  await assert.rejects(createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal: new AbortController().signal,
    runtimeFactory: async options => { path = dirname(options!.modelsPath!); throw new Error("token=SECRET"); },
  }), error => { assert.doesNotMatch(String(error), /SECRET/); return true; });
  assert.equal(existsSync(path), false);
});

test("取消中断不回应的流且临时配置仍可立即清理", async () => {
  const controller = new AbortController();
  let path = "";
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal: controller.signal,
    runtimeFactory: async options => {
      path = dirname(options!.modelsPath!);
      return { getModel: () => ({ id: "m", provider: "test", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any),
        streamSimple: () => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, result: async () => response([]) } as any) };
    },
  });
  const pending = model.run(request(controller.signal));
  controller.abort();
  await assert.rejects(pending, /取消|时间预算/);
  await model.dispose();
  assert.equal(existsSync(path), false);
});

test("工具参数失败保留未知而非执行，达到工具次数预算后停止研究", async () => {
  let executed = 0, warned = 0;
  const controller = new AbortController();
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal: controller.signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => stream(response([{ type: "toolCall", id: "c1", name: "read_source", arguments: { forbidden: true } }], "toolUse")) }),
  });
  try {
    const result = await model.run(request(controller.signal, { stage: "researching", maxRounds: 3, maxToolCalls: 1, warn: () => { warned++; }, tools: [{
      name: "read_source", label: "读取", description: "只读", parameters: Type.Object({ required: Type.String() }, { additionalProperties: false }),
      execute: async () => { executed++; return { content: [{ type: "text", text: "original" }], details: {} }; },
    }] }));
    assert.equal(result.complete, false);
    assert.equal(result.reason, "tool_limit");
    assert.equal(executed, 0);
    assert.equal(warned, 1);
  } finally { await model.dispose(); }
});

test("模型截断输出不作为完整答案，工具名未授权立即失败", async () => {
  let responseValue = response([{ type: "text", text: "DRAFT" }], "length");
  const signal = new AbortController().signal;
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any), streamSimple: () => stream(responseValue) }),
  });
  try {
    assert.deepEqual(await model.run(request(signal)), { text: "", complete: false, reason: "output_limit" });
    responseValue = response([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "pwd" } }], "toolUse");
    await assert.rejects(model.run(request(signal, { maxToolCalls: 1 })), /未提供的工具/);
  } finally { await model.dispose(); }
});

test("安全观察仅记录实际参数与数值，输出超限也保留终态且不包含正文或认证", async () => {
  const observed: KnowledgeAnswerModelObservation[] = [], signal = new AbortController().signal;
  const privateValue = "PRIVATE_OBSERVER_CONTENT", hiddenThinking = "PRIVATE_THINKING_CONTENT";
  const model = await createKnowledgeAnswerModel({ choice: { provider: "private-provider", model: "glm-5.3", json: { privateKey: privateValue } }, signal,
    observe: event => { observed.push(event); },
    runtimeFactory: async () => ({ getModel: () => ({ id: "glm-5.3", api: "anthropic-messages", reasoning: false, maxTokens: 16384, contextWindow: 128_000 } as any),
      streamSimple: (_model, _context, options) => ({
        async *[Symbol.asyncIterator]() {
          const payload: any = await options!.onPayload!({ model: privateValue, max_tokens: 16384, prompt: privateValue,
            thinking: { type: "enabled", content: hiddenThinking }, output_config: { credential: privateValue }, authorization: privateValue }, _model);
          assert.equal(payload.output_config.effort, "high", "观察不能覆盖实际 high 配置");
          assert.equal(payload.thinking.content, hiddenThinking, "观察不能更改模型载荷");
          yield { type: "thinking_delta", delta: hiddenThinking } as any;
          yield { type: "thinking_delta", delta: "再次思考" } as any;
          yield { type: "text_delta", delta: privateValue } as any;
          yield { type: "text_delta", delta: "再次文字" } as any;
        },
        result: async () => ({ ...response([{ type: "thinking", thinking: hiddenThinking }, { type: "text", text: privateValue }], "length"),
          errorMessage: privateValue, usage: { input: 4000, output: 16384, cacheRead: 0, totalTokens: 20384, reasoning: Infinity, cacheWrite: -1,
            privateKey: privateValue, prompt: privateValue, cost: { amount: 3 } } }),
      } as any) }),
  });
  try {
    assert.deepEqual(await model.run(request(signal, { system: privateValue, user: privateValue, maxOutputTokens: 16384 })),
      { text: "", complete: false, reason: "output_limit" });
    assert.deepEqual(observed.map(event => event.event), ["request_start", "request_payload", "first_thinking_delta", "first_text_delta", "request_end"]);
    assert.ok(observed.every(event => event.stage === "answering" && event.round === 1));
    const payload = observed.find(event => event.event === "request_payload")!;
    assert.equal(payload.event, "request_payload");
    if (payload.event === "request_payload") { assert.equal(payload.max_tokens, 16384); assert.equal(payload.effort, "high"); assert.equal(payload.thinking_type, "enabled"); }
    const end = observed.at(-1)!;
    assert.equal(end.event, "request_end");
    if (end.event === "request_end") {
      assert.equal(end.stop_reason, "length"); assert.equal(end.text_chars, privateValue.length); assert.equal(end.thinking_chars, hiddenThinking.length);
      assert.deepEqual(end.usage, { input: 4000, output: 16384, cacheRead: 0, totalTokens: 20384 });
    }
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_|private-provider|privateKey|prompt|authorization|credential|errorMessage/);
    assert.ok(observed.filter(event => "elapsed_ms" in event).every(event => Number.isFinite((event as any).elapsed_ms) && (event as any).elapsed_ms >= 0));
  } finally { await model.dispose(); }
});

test("观察拒绝未知载荷枚举，同步或异步记录失败不影响回答", async () => {
  const signal = new AbortController().signal;
  for (const asynchronous of [false, true]) {
    const observations: KnowledgeAnswerModelObservation[] = [];
    const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
      observe(event) { observations.push(event); if (asynchronous) return Promise.reject(new Error("private-observer-error")); throw new Error("private-observer-error"); },
      runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", reasoning: false, maxTokens: 4096, contextWindow: 128_000 } as any),
        streamSimple: (_model, _context, options) => ({ async *[Symbol.asyncIterator]() {
          await options!.onPayload!({ max_tokens: NaN, thinking: { type: "private-thinking-type" }, output_config: { effort: "private-effort" } }, _model);
        }, result: async () => response([{ type: "text", text: "完成" }]) } as any) }),
    });
    try {
      assert.equal((await model.run(request(signal))).text, "完成");
      const payload = observations.find(event => event.event === "request_payload");
      assert.deepEqual(payload, { stage: "answering", round: 1, event: "request_payload", elapsed_ms: (payload as any).elapsed_ms,
        effort: "unknown", thinking_type: "unknown" });
      assert.doesNotMatch(JSON.stringify(observations), /private-/);
    } finally { await model.dispose(); }
  }
});

test("来源模型请求异常仍记录安全失败分类，不输出提供方错误", async () => {
  const signal = new AbortController().signal, observed: KnowledgeAnswerModelObservation[] = [];
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    observe: event => { observed.push(event); },
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => { throw new Error("PRIVATE_PROVIDER_ERROR"); } }),
  });
  try {
    await assert.rejects(model.run(request(signal)), /未生成可展示/);
    assert.equal(observed.at(-1)?.event, "request_failed");
    assert.equal((observed.at(-1) as any).reason, "operation_failed");
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_PROVIDER_ERROR/);
  } finally { await model.dispose(); }
});

test("提交拒绝按协议、原始JSON、schema与预算分类，观察失败不改变结果或泄漏原文", async () => {
  const signal = new AbortController().signal, body = "PRIVATE_SUBMISSION_BODY", thinking = "PRIVATE_SUBMISSION_THINKING";
  const args = submitted(body), raw = JSON.stringify(args), call = submitCall(args), invalid = { points: [], privateBody: body };
  const cases = [
    { category: "tool_protocol", error: "答案提交重复开始", value: response([call], "toolUse"), events: [
      { type: "toolcall_start", contentIndex: 0 }, { type: "toolcall_start", contentIndex: 0 }] },
    { category: "tool_protocol", error: "答案提交结束后仍收到参数", value: response([call], "toolUse"),
      events: [...submitEvents(raw, call), { type: "toolcall_delta", contentIndex: 0, delta: body }] },
    { category: "tool_protocol", error: "答案提交重复结束", value: response([call], "toolUse"),
      events: [...submitEvents(raw, call), { type: "toolcall_end", contentIndex: 0, toolCall: call }] },
    { category: "budget", error: "答案提交参数超过本次预算", value: response([call], "toolUse"),
      events: submitEvents(body.repeat(200), call), maxContextChars: 2000 },
    { category: "tool_protocol", error: "模型须完整提交唯一答案，不能混用其他工具或未结束的参数", value: response([call], "toolUse"),
      events: submitEvents(raw, call).slice(0, -1) },
    { category: "raw_json", error: "答案提交参数不是完整 JSON", value: response([call], "toolUse"), events: submitEvents(raw.slice(0, -1), call) },
    { category: "schema", error: "答案提交字段不符合定义", value: response([call], "toolUse"), events: submitEvents(JSON.stringify(invalid), call) },
    { category: "raw_json", error: "答案文本不是完整 JSON", value: response([{ type: "text", text: raw.slice(0, -1) }]), events: [] },
    { category: "schema", error: "答案文本字段不符合定义", value: response([{ type: "text", text: JSON.stringify(invalid) }]), events: [] },
  ];
  for (const asynchronous of [false, true]) {
    const observed: KnowledgeAnswerModelObservation[] = [];
    let selected = cases[0];
    const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: { auth: "PRIVATE_AUTH" } }, signal,
      observe(event) { observed.push(event); if (asynchronous) return Promise.reject(new Error("PRIVATE_OBSERVER_ERROR")); throw new Error("PRIVATE_OBSERVER_ERROR"); },
      runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "anthropic-messages", maxTokens: 4096, contextWindow: 128_000 } as any),
        streamSimple: () => streamEvents({ ...selected.value, content: [{ type: "thinking", thinking }, ...selected.value.content], errorMessage: "PRIVATE_PROVIDER_ERROR" },
          [{ type: "thinking_delta", delta: thinking }, ...selected.events]) }),
    });
    try {
      for (selected of cases) {
        observed.length = 0;
        await assert.rejects(model.run(request(signal, { outputTool, user: body, maxContextChars: selected.maxContextChars ?? 100_000 })),
          error => error instanceof KnowledgeAnswerSubmissionError && error.message === selected.error);
        const rejected = observed.filter(event => event.event === "submission_rejected");
        assert.equal(rejected.length, 1, selected.error);
        assert.deepEqual(rejected[0], { stage: "answering", round: 1, event: "submission_rejected", category: selected.category,
          elapsed_ms: (rejected[0] as any).elapsed_ms });
        assert.ok(Number.isFinite((rejected[0] as any).elapsed_ms) && (rejected[0] as any).elapsed_ms >= 0);
        assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_|privateBody|errorMessage|arguments|auth/);
      }
      selected = { ...cases[0], value: response([call], "toolUse"), events: submitEvents(raw, call) };
      observed.length = 0;
      assert.deepEqual(JSON.parse((await model.run(request(signal, { outputTool }))).text), args);
      assert.equal(observed.some(event => event.event === "submission_rejected"), false);
    } finally { await model.dispose(); }
  }
});

test("终结工具提交采用完整原始JSON，保留多行代码，忽略过场文本且不执行或追加对话", async () => {
  const signal = new AbortController().signal, seen: any[] = [];
  const body = '说明\n\n```cpp\nconst char* path = "C:\\\\temp";\nreturn path;\n```';
  const actual = submitted(body), call = submitCall(submitted("SDK对象不能成为答案"));
  const value = response([{ type: "text", text: "下面提交答案，不作为答复正文。" }, call], "toolUse");
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "anthropic-messages", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: (_model, context, options) => {
        seen.push({ context: structuredClone(context), options });
        return streamEvents(value, [{ type: "text_delta", delta: "下面提交答案。" }, ...submitEvents(JSON.stringify(actual), call, 1)]);
      } }),
  });
  try {
    const result = await model.run(request(signal, { outputTool }));
    assert.equal(result.complete, true);
    assert.deepEqual(JSON.parse(result.text), actual);
    assert.equal(JSON.parse(result.text).points[0].body, body);
    assert.doesNotMatch(result.text, /下面提交|SDK对象/);
    assert.equal(seen.length, 1, "提交后不能再要求模型总结");
    assert.deepEqual(seen[0].context.messages.map((message: any) => message.role), ["user"]);
    assert.deepEqual(seen[0].context.tools, [outputTool]);
    assert.equal(seen[0].options.toolChoice, undefined, "兼容路径不能猜测强制工具参数");
    assert.equal(seen[0].context.tools[0].strict, undefined);
  } finally { await model.dispose(); }
});

test("SDK修复后的完整对象不能补救缺少结尾或非法转义的原始提交", async () => {
  const signal = new AbortController().signal, args = submitted("PRIVATE_SUBMISSION_BODY"), call = submitCall(args);
  let raw = JSON.stringify(args).slice(0, -1);
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => streamEvents(response([call], "toolUse"), submitEvents(raw, call)) }),
  });
  try {
    for (raw of [JSON.stringify(args).slice(0, -1), JSON.stringify(args).replace("PRIVATE_SUBMISSION_BODY", String.raw`bad\q`)]) {
      await assert.rejects(model.run(request(signal, { outputTool })), error => {
        assert.ok(error instanceof KnowledgeAnswerSubmissionError);
        assert.match(error.message, /完整 JSON/);
        assert.doesNotMatch(error.message, /PRIVATE_|bad/);
        return true;
      });
    }
  } finally { await model.dispose(); }
});

test("完整JSON仍须符合提交schema，不能依据SDK对象补齐字段", async () => {
  const signal = new AbortController().signal, call = submitCall(submitted());
  let raw = "";
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-responses", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => streamEvents(response([call], "toolUse"), submitEvents(raw, call)) }),
  });
  try {
    for (const invalid of [{ points: [] }, { ...submitted(), extra: "不接受" }, { points: [], unknowns: "类型不符" }]) {
      raw = JSON.stringify(invalid);
      await assert.rejects(model.run(request(signal, { outputTool })), error => {
        assert.ok(error instanceof KnowledgeAnswerSubmissionError);
        assert.match(error.message, /字段不符合/);
        return true;
      });
    }
  } finally { await model.dispose(); }
});

test("提交必须唯一、matching且结束，缺少原始参数或结束事件不能展示", async () => {
  const signal = new AbortController().signal, args = submitted(), raw = JSON.stringify(args), call = submitCall(args);
  const other = submitCall(args, "submit-2"), wrong = submitCall(args, "wrong", "read_source");
  const cases = [
    { calls: [call, other], events: [...submitEvents(raw, call), ...submitEvents(raw, other, 1)] },
    { calls: [wrong], events: submitEvents(raw, wrong) },
    { calls: [call], events: submitEvents(raw, call).slice(0, -1) },
    { calls: [call], events: [{ type: "toolcall_end", contentIndex: 0, toolCall: call }] },
    { calls: [call], events: [...submitEvents(raw, call), { type: "toolcall_end", contentIndex: 0, toolCall: call }] },
    { calls: [call], events: [...submitEvents(raw, call), { type: "toolcall_delta", contentIndex: 0, delta: " " }] },
    { calls: [call], events: submitEvents(raw, { ...call, id: "mismatched-id" }) },
    { calls: [call], events: submitEvents(raw, call), stopReason: "stop" },
    { calls: [call], events: [...submitEvents(raw, call), { type: "toolcall_start", contentIndex: 1 }] },
    { calls: [], events: [], stopReason: "stop" },
  ];
  let selected = cases[0];
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "anthropic-messages", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => streamEvents(response(selected.calls, selected.stopReason ?? "toolUse"), selected.events) }),
  });
  try {
    for (selected of cases) await assert.rejects(model.run(request(signal, { outputTool })), KnowledgeAnswerSubmissionError);
  } finally { await model.dispose(); }
});

test("无任何工具事件时兼容完整文本JSON，不能用文本补救已开始的工具提交", async () => {
  const signal = new AbortController().signal, args = submitted("首行\n第二行");
  let events: any[] = [], text = JSON.stringify(args);
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "google-generative-ai", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => streamEvents(response([{ type: "text", text }], "stop"), events) }),
  });
  try {
    assert.deepEqual(JSON.parse((await model.run(request(signal, { outputTool }))).text), args);
    for (text of [JSON.stringify(args).slice(0, -1), "过场文字" + JSON.stringify(args), JSON.stringify({ points: [] })]) {
      await assert.rejects(model.run(request(signal, { outputTool })), KnowledgeAnswerSubmissionError);
    }
    text = JSON.stringify(args);
    events = [{ type: "toolcall_start", contentIndex: 0 }];
    await assert.rejects(model.run(request(signal, { outputTool })), KnowledgeAnswerSubmissionError);
  } finally { await model.dispose(); }
});

test("Gemini原生对象转换成单个参数delta也可终结提交", async () => {
  const signal = new AbortController().signal, args = submitted("第一行\n第二行"), call = submitCall(args);
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "google-generative-ai", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => streamEvents(response([call], "toolUse"), [
        { type: "toolcall_start", contentIndex: 0 }, { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args) },
        { type: "toolcall_end", contentIndex: 0, toolCall: call },
      ]) }),
  });
  try { assert.deepEqual(JSON.parse((await model.run(request(signal, { outputTool }))).text), args); }
  finally { await model.dispose(); }
});

test("提交不跨轮或混用研究工具，两次独立请求不拼接参数", async () => {
  const signal = new AbortController().signal, args = submitted(), call = submitCall(args), contexts: any[] = [];
  let raw = JSON.stringify(args);
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: (_model, context) => { contexts.push(structuredClone(context)); return streamEvents(response([call], "toolUse"), submitEvents(raw, call)); } }),
  });
  try {
    const queryTool = { name: "read_source", label: "读取", description: "只读", parameters: Type.Object({}),
      execute: async () => { throw new Error("不得执行"); } };
    for (const override of [{ stage: "researching" as const }, { maxRounds: 2 }, { tools: [queryTool] }]) {
      await assert.rejects(model.run(request(signal, { outputTool, ...override })), /独立回答请求/);
    }
    assert.equal(contexts.length, 0);
    assert.equal((await model.run(request(signal, { outputTool, user: "原问题一" }))).complete, true);
    raw = "}";
    await assert.rejects(model.run(request(signal, { outputTool, user: "原问题二" })), KnowledgeAnswerSubmissionError);
    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts[1].messages.map((message: any) => message.role), ["user"]);
    assert.equal(contexts[1].messages[0].content, "原问题二");
    assert.doesNotMatch(JSON.stringify(contexts[1]), /原问题一|toolResult/);
  } finally { await model.dispose(); }
});

test("已取得合法提交参数也不能接受length、错误或取消终态", async () => {
  const signal = new AbortController().signal, args = submitted(), call = submitCall(args), raw = JSON.stringify(args);
  let stopReason = "length";
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "m", api: "anthropic-messages", maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: () => streamEvents(response([call], stopReason), submitEvents(raw, call)) }),
  });
  try {
    assert.deepEqual(await model.run(request(signal, { outputTool })), { text: "", complete: false, reason: "output_limit" });
    for (stopReason of ["aborted", "error"]) await assert.rejects(model.run(request(signal, { outputTool })), /未生成可展示/);
  } finally { await model.dispose(); }
});

test("答案工具参数流等待中取消仍立即返回并清理临时认证", async () => {
  const controller = new AbortController(), args = submitted(), call = submitCall(args);
  let configPath = "", entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "m", json: {} }, signal: controller.signal,
    runtimeFactory: async options => {
      configPath = options!.modelsPath!;
      return { getModel: () => ({ id: "m", api: "anthropic-messages", maxTokens: 4096, contextWindow: 128_000 } as any),
        streamSimple: () => ({ async *[Symbol.asyncIterator]() {
          yield { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args).slice(0, -1) };
          entered();
          await new Promise(() => {});
        }, result: async () => response([call], "toolUse") } as any) };
    },
  });
  const pending = model.run(request(controller.signal, { outputTool }));
  await began;
  controller.abort();
  await assert.rejects(pending, /取消|时间预算/);
  await model.dispose();
  assert.equal(existsSync(dirname(configPath)), false);
});

test("研究工具收到实际模型，图片按视觉预算计入并原样进入下一轮", async () => {
  const signal = new AbortController().signal, contexts: any[] = [], data = "A".repeat(300_000);
  let calls = 0;
  const selected = { id: "vision", api: "openai-completions", input: ["text", "image"], maxTokens: 4096, contextWindow: 128_000 } as any;
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "vision", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => selected,
      streamSimple: (_model, context) => {
        contexts.push(structuredClone(context));
        return stream(calls++ === 0 ? response([{ type: "toolCall", id: "image-1", name: "image_source", arguments: {} }], "toolUse") : response([{ type: "text", text: "已看到图" }]));
      } }),
  });
  try {
    const tool = { name: "image_source", label: "读图", description: "原始图片", parameters: Type.Object({}),
      execute: async (_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: any) => {
        assert.equal(ctx.model, selected);
        return { content: [{ type: "text" as const, text: "图片引用 e1" }, { type: "image" as const, data, mimeType: "image/png" }], details: {} };
      } };
    const result = await model.run(request(signal, { stage: "researching", tools: [tool], maxRounds: 2, maxToolCalls: 1, maxContextChars: 20_000 }));
    assert.equal(result.complete, true);
    assert.equal(contexts[1].messages.at(-1).content[1].data, data);
    assert.equal(contexts[1].messages.at(-1).isError, false);
    const answer = await model.run(request(signal, { user: "根据原图回答", images: [{ label: "e1 原图", data, mimeType: "image/png" }], maxContextChars: 20_000 }));
    assert.equal(answer.complete, true);
    assert.deepEqual(contexts[2].messages[0].content, [{ type: "text", text: "根据原图回答" }, { type: "text", text: "e1 原图" }, { type: "image", data, mimeType: "image/png" }]);
    const over = await model.run(request(signal, { images: Array.from({ length: 6 }, () => ({ label: "原图", data, mimeType: "image/png" })), maxContextChars: 20_000 }));
    assert.equal(over.reason, "context_limit");
    assert.equal(contexts.length, 3, "图片也有总预算，不能靠短元数据无限加入");
  } finally { await model.dispose(); }
});

test("纯文本模型不能接收回答图片，长工具文字仍受上下文预算限制", async () => {
  const signal = new AbortController().signal, contexts: any[] = []; let calls = 0;
  const model = await createKnowledgeAnswerModel({ choice: { provider: "test", model: "text", json: {} }, signal,
    runtimeFactory: async () => ({ getModel: () => ({ id: "text", api: "openai-completions", input: ["text"], maxTokens: 4096, contextWindow: 128_000 } as any),
      streamSimple: (_model, context) => {
        contexts.push(structuredClone(context));
        return stream(calls++ === 0 ? response([{ type: "toolCall", id: "large-1", name: "source", arguments: {} }], "toolUse") : response([{ type: "text", text: "仅有缺口" }]));
      } }),
  });
  try {
    await assert.rejects(model.run(request(signal, { images: [{ label: "原图", data: "AAAA", mimeType: "image/png" }] })), /不支持图片/);
    const tool = { name: "source", label: "读取", description: "正文", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "原文".repeat(8000) }], details: {} }) };
    assert.equal((await model.run(request(signal, { stage: "researching", tools: [tool], maxRounds: 2, maxToolCalls: 1, maxContextChars: 20_000 }))).complete, true);
    assert.equal(contexts[1].messages.at(-1).isError, true);
    assert.match(contexts[1].messages.at(-1).content[0].text, /超过上下文预算/);
  } finally { await model.dispose(); }
});
