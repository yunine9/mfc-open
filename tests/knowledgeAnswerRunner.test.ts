import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Check } from "typebox/value";
import { createKnowledgeAnswerRunner } from "../src/knowledgeAnswerRunner.ts";
import { parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";
import type { KnowledgeAnswerContext, KnowledgeAnswerEvidence, KnowledgeAnswerExecution } from "../src/knowledgeAnswerTypes.ts";
import { KnowledgeAnswerSubmissionError, type KnowledgeAnswerModelRequest, type KnowledgeAnswerModelOutput } from "../src/knowledgeAnswerModel.ts";
import { KnowledgeAnswers } from "../src/knowledgeAnswers.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { MemorySidecar } from "../src/memorySidecar.ts";

const SOURCE = "只有条件满足时才允许使用；其他情况未规定。";
const composition = (body = "本资料所述的场景，且条件满足时允许使用；其他情况尚未核实。", quote = SOURCE) => ({
  points: [{ kind: "answer", body, basis: [{ evidence_id: "e1", quote }] }],
});
const output = (value: unknown): KnowledgeAnswerModelOutput => ({ text: typeof value === "string" ? value : JSON.stringify(value), complete: true });
const evidence = (content = SOURCE): KnowledgeAnswerEvidence[] => [{ id: "e1", kind: "knowledge", title: "原文", content, revision: "r1",
  digest: createHash("sha256").update(content).digest("hex"), retrieved_at: "now" }];

for (const unavailable of [true, false]) test(`真实问答流程区分检索故障与正常无命中（故障=${unavailable}）`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-search-state-"));
  const search = new KnowledgeSearch(dir, { ingest: async () => true, remove: async () => true,
    search: async () => unavailable ? undefined : [] } as unknown as MemorySidecar);
  let modelCalls = 0;
  const answers = new KnowledgeAnswers(dir, createKnowledgeAnswerRunner({ dataDir: dir, search: () => search,
    model: () => ({ provider: "test", model: "test", json: {} }),
    createModel: async () => ({ dispose() {}, async run() { modelCalls++; throw new Error("没有原文不得生成答案"); } }),
  }));
  try {
    saveKnowledgeDocument(dir, { title: "数据库插入数据", content: "调用数据库组件插入接口，并提交事务。" }, "owner");
    await search.prepare();
    const { record } = answers.create({ question: "这个组件怎么接入？有哪些配置和使用限制？数据库 插入数据" }, "owner");
    const deadline = Date.now() + 2000;
    let result = answers.get(record.id, "owner");
    while (["queued", "running"].includes(result.status) && Date.now() < deadline) {
      await pause(10); result = answers.get(record.id, "owner");
    }
    assert.equal(result.status, unavailable ? "failed" : "done");
    assert.equal(modelCalls, 0);
    if (unavailable) {
      assert.match(result.error!, /文档检索暂时不可用/);
      assert.equal(result.answer, undefined);
      assert.ok(!result.activity.some(row => row.stage === "done" || row.stage === "checking"));
    } else {
      assert.match(result.answer!.markdown, /未在本次可检索/);
      assert.deepEqual(result.answer!.evidence_ids, []);
    }
  } finally { await answers.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
// 模型输出均为 mock，只证明原句、引用、容量与执行边界，不证明模型能正确理解原文。
function fixture(options: {
  run?: (request: KnowledgeAnswerModelRequest, index: number) => Promise<KnowledgeAnswerModelOutput>;
  content?: string; empty?: boolean; timeoutMs?: number; evidenceChars?: number; contextChars?: number;
  question?: string; context?: KnowledgeAnswerContext; inputBudgetChars?: number; modelDelayMs?: number;
} = {}) {
  const controller = new AbortController(), requests: KnowledgeAnswerModelRequest[] = [], warnings: string[] = [], stages: string[] = [];
  let disposed = 0, choiceOwner: string | undefined;
  const input: KnowledgeAnswerExecution = {
    root: "/tmp/knowledge-answer-test", signal: controller.signal,
    record: { id: "qa", owner: "alice", question: options.question ?? "原问题：条件满足时能使用吗？", context: options.context ?? { module_ids: ["business-a"], product_version: "v1" }, status: "running", stage: "researching", created_at: "now", updated_at: "now", evidence: [], activity: [], warnings },
    progress: (stage, message) => stages.push(`${stage}:${message}`), warn: message => warnings.push(message),
    addEvidence: value => {
      const row = { ...value, id: `e${input.record.evidence.length + 1}`, digest: createHash("sha256").update(value.content).digest("hex"), retrieved_at: "now" };
      input.record.evidence.push(row); return row;
    },
  };
  const runner = createKnowledgeAnswerRunner({ dataDir: "/tmp/unused", search: () => ({} as any),
    model: owner => { choiceOwner = owner; return { provider: "test-provider", model: "test-model", json: {} }; },
    limits: { timeoutMs: options.timeoutMs ?? 1000, ...(options.evidenceChars ? { evidenceChars: options.evidenceChars } : {}),
      ...(options.contextChars ? { contextChars: options.contextChars } : {}) },
    retrieve: async execution => {
      if (!options.empty) execution.addEvidence({ kind: "knowledge", title: "原文", content: options.content ?? SOURCE, revision: "r1" });
    },
    createModel: async () => {
      if (options.modelDelayMs) await new Promise(resolve => setTimeout(resolve, options.modelDelayMs));
      return {
        inputBudgetChars: options.inputBudgetChars,
        dispose: () => { disposed++; },
        async run(request) {
          requests.push(request);
          if (options.run) return options.run(request, requests.length - 1);
          return output(composition(undefined, (options.content ?? SOURCE).slice(0, 180)));
        },
      };
    },
  });
  return { input, runner, controller, requests, warnings, stages, disposed: () => disposed, choiceOwner: () => choiceOwner };
}

test("固定检索后只调用一次回答模型，输入仅包含原问题、上下文与原文快照", async () => {
  const f = fixture({ context: { module_ids: ["business-a", "business-b"], document_id: "doc-a", product_version: "v1" } });
  const result = await f.runner(f.input);
  assert.equal(f.choiceOwner(), "alice");
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
  const request = f.requests[0], value = JSON.parse(request.user);
  assert.equal(request.tools.length, 0);
  assert.equal(request.maxRounds, 1);
  assert.equal(request.maxToolCalls, 0);
  assert.equal(request.outputTool?.name, "submit_knowledge_answer");
  const submission = composition();
  const submittedPoint = { ...submission.points[0], basis: [{ evidence_id: "e1", start_line: 1, end_line: 1 }] };
  assert.ok(Check(request.outputTool!.parameters, { ...submission, points: [submittedPoint] }));
  assert.ok(Check(request.outputTool!.parameters, { points: [{ ...submittedPoint, kind: "recommendation" }] }));
  assert.equal(Check(request.outputTool!.parameters, { points: [{ kind: "recommendation", body: "建议" }] }), false);
  for (const extra of [{ title: "任何情况都允许。" }, { scope: "题目未要求的额外限制。" }])
    assert.equal(Check(request.outputTool!.parameters, { ...submission, points: [{ ...submittedPoint, ...extra }] }), false);
  assert.equal(Check(request.outputTool!.parameters, { points: [{ kind: "unconfirmed", body: "尚未取得实际配置，不能确认。" }] }), true);
  assert.equal(Check(request.outputTool!.parameters, { ...submission, unknowns: ["另外概括一次。"] }), false);
  assert.equal(Check(request.outputTool!.parameters, { points: [{ kind: "unconfirmed", body: "缺口", basis: submittedPoint.basis }] }), false);
  assert.equal(request.maxRounds, 1);
  assert.equal(request.maxToolCalls, 0);
  assert.deepEqual(Object.keys(value).sort(), ["context", "question", "received_evidence"]);
  assert.equal(value.question, f.input.record.question);
  assert.deepEqual(value.context, f.input.record.context);
  assert.deepEqual(value.received_evidence, f.input.record.evidence.map(source => ({ ...source, content: `1: ${source.content}` })));
  assert.equal(f.input.record.evidence[0].content, SOURCE, "显示行号不会改写保存的原件或摘要");
  assert.doesNotMatch(request.user + request.system, /PLAN_POISON|RESEARCH_SUMMARY|SOURCE_DESCRIPTION_MUST/);
  assert.match(request.system, /只依据本次提供的知识文档原文/);
  assert.doesNotMatch(request.system, /thread_local|超过30且不超过60|30–60/);
  assert.match(result.markdown, /本资料所述的场景，且条件满足时/);
  assert.match(result.markdown, /允许使用/);
  assert.match(result.markdown, /#evidence-e1/);
  assert.deepEqual(result.evidence_ids, ["e1"]);
  assert.ok(f.stages.some(stage => stage.startsWith("checking:") && stage.includes("引用")));
  assert.equal(f.input.record.answer, undefined, "runner only returns a result for the store to publish after completion");
  assert.equal(f.disposed(), 1);
});

test("建议与原文判断分项提交，宿主固定标示建议且共用真实引用校验", async () => {
  const f = fixture({ run: async request => {
    const points = [
      { kind: "answer", basis: [{ evidence_id: "e1", start_line: 1, end_line: 1 }], body: "条件满足时允许使用。" },
      { kind: "recommendation", basis: [{ evidence_id: "e1", start_line: 1, end_line: 1 }], body: "如果暂时不能核实条件，建议等确认后再使用。" },
    ];
    assert.ok(Check(request.outputTool!.parameters, { points }));
    return output({ points });
  } });
  const answer = await f.runner(f.input);
  assert.match(answer.markdown, /^条件满足时允许使用。/);
  assert.match(answer.markdown, /\*\*建议做法：\*\*[\s\S]*如果暂时不能核实条件/);
  assert.deepEqual(answer.evidence_ids, ["e1"]);
  assert.deepEqual(answer.unknowns, []);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
  assert.equal(f.disposed(), 1);
});

test("#471 引文展开超限由平台改为来源链接，不重新请求模型", async () => {
  const content = "规则正文。".repeat(600) + "\n例外必须保留。";
  const points = Array.from({ length: 8 }, (_, index) => ({ kind: "answer", body: `第 ${index + 1} 项完整结论及例外。`,
    basis: [{ evidence_id: "e1", start_line: 1, end_line: 2 }] }));
  const f = fixture({ content, run: async request => {
    assert.match(request.system, /输出 JSON 总长度最多/);
    assert.doesNotMatch(request.system, /输出 JSON 及平台渲染/);
    return output({ points });
  } });
  const result = await f.runner(f.input);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
  assert.ok(JSON.stringify(result).length <= 24_000);
  for (const point of points) assert.ok(result.markdown.includes(point.body));
  assert.match(result.markdown, /第 1–2 行/);
  assert.equal(f.input.record.evidence[0].content, content);
  assert.equal(f.disposed(), 1);
});

test("#476 已读原文的8174字符长行可引用，不因展示长度重新生成答案", async () => {
  const content = "资料说明\n" + "原文".repeat(4080) + "相关条件和例外必须完整保留。";
  assert.equal(content.split("\n")[1].length, 8174);
  const f = fixture({ content, run: async request => {
    assert.doesNotMatch(request.system, /原文最多4000字符/);
    return output({ points: [{ kind: "answer", body: "依据原文解释，条件和例外均保留。",
      basis: [{ evidence_id: "e1", start_line: 2, end_line: 2 }] }] });
  } });
  const result = await f.runner(f.input);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
  assert.match(result.markdown, /依据原文解释，条件和例外均保留。/);
  assert.ok(result.markdown.includes("[原文 e1，第 2–2 行](#evidence-e1)"));
  assert.deepEqual(result.evidence_ids, ["e1"]);
  assert.equal(f.input.record.evidence[0].content, content);
  assert.equal(f.disposed(), 1);
});

test("提交格式失败与原句失败共用一次重试，第三次不会启动", async () => {
  let attempts = 0;
  const f = fixture({ run: async () => {
    if (!attempts++) throw new KnowledgeAnswerSubmissionError("提交参数不是完整 JSON");
    return output(composition(undefined, "不是实际原句"));
  } });
  await assert.rejects(f.runner(f.input), /实际证据/);
  assert.equal(attempts, 2);
  assert.equal(f.requests[0].user, f.requests[1].user);
  assert.equal(f.input.record.answer, undefined);
  assert.equal(f.disposed(), 1);
});

test("完整提交重新生成后可交付，多行代码和引号按JSON转义还原", async () => {
  let attempts = 0;
  const body = '逐项检查。\n\n```ts\nconst path = "C:\\\\cache";\nuse(path);\n```';
  const f = fixture({ run: async request => {
    if (!attempts++) throw new KnowledgeAnswerSubmissionError("提交参数不是完整 JSON");
    assert.ok(request.system.includes(String.raw`换行写成 \n、双引号写成 \"、反斜杠写成 \\`));
    assert.match(request.system, /通过 submit_knowledge_answer 工具/);
    return output(composition(body));
  } });
  const result = await f.runner(f.input);
  assert.ok(result.markdown.includes(body));
  assert.ok(result.markdown.includes('\n\n```ts\n'));
  assert.equal(attempts, 2);
  assert.equal(f.requests[0].deadlineAt, f.requests[1].deadlineAt);
  assert.equal(f.disposed(), 1);
});

test("回答按宿主行号引用真实连续原文，显示编号不会改写原件摘要", async () => {
  const content = "允许使用。\n例外仍需核实。";
  const f = fixture({ content, run: async request => {
    const input = JSON.parse(request.user);
    assert.equal(input.received_evidence[0].content, "1: 允许使用。\n2: 例外仍需核实。");
    const value = { points: [{ kind: "answer", body: "仅限资料所述场景，允许使用；其他条件尚未核实。",
      basis: [{ evidence_id: "e1", start_line: 1, end_line: 2 }] }] };
    assert.ok(Check(request.outputTool!.parameters, value));
    return output(value);
  } });
  const result = await f.runner(f.input);
  assert.ok(result.markdown.includes("> 允许使用。\n> 例外仍需核实。"));
  assert.ok(!result.markdown.includes("> 1:"));
  assert.equal(f.input.record.evidence[0].content, content);
  assert.equal(f.input.record.evidence[0].digest, createHash("sha256").update(content).digest("hex"));
  assert.equal(f.requests.filter(request => request.stage === "answering").length, 1);
});

test("宿主保留含条件的完整正文及实际原句，不另生成重复判断", () => {
  const unknownBody = "另一实现所用配置尚未确认。";
  const value = { points: [...composition("条件满足时允许使用，其他场景尚未核实。解释与建议可以保留。\n\n```ts\nif (condition) use();\n```").points,
    { kind: "unconfirmed", body: unknownBody }] };
  const result = parseKnowledgeAnswerComposition(JSON.stringify(value), evidence());
  for (const text of [value.points[0].body, SOURCE]) assert.ok(result.markdown.includes(text), text);
  assert.doesNotMatch(result.markdown, /## |适用前提/);
  assert.match(result.markdown, />/);
  assert.match(result.markdown, /\[.*\]\(#evidence-e1\)/);
  assert.deepEqual(result.unknowns, [unknownBody]);
  assert.ok(!result.markdown.includes(unknownBody), "未确认事项按原文单独显示，不在正文重复概括");
  assert.deepEqual(result.evidence_ids, ["e1"]);
  assert.deepEqual(Object.keys(result).sort(), ["evidence_ids", "markdown", "unknowns"]);
});

test("不存在的引句只允许一次全新回答修复，不把错误输出或研究意见带入", async () => {
  let attempts = 0;
  const f = fixture({ run: async () => output(attempts++ === 0
    ? composition("BAD_OUTPUT_POISON：所有情况都必须使用。", "ACTUAL_SOURCE_DOES_NOT_CONTAIN_THIS") : composition()) });
  const result = await f.runner(f.input);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering", "answering"]);
  assert.equal(f.requests[0].user, f.requests[1].user);
  assert.doesNotMatch(f.requests[1].user + f.requests[1].system, /BAD_OUTPUT_POISON|ACTUAL_SOURCE_DOES_NOT_CONTAIN_THIS|PLAN_POISON|RESEARCH_SUMMARY/);
  assert.match(f.requests[1].system, /格式或引用校验/);
  assert.match(f.requests[1].system, /具体原因：引用的原句不在本次实际证据中/);
  assert.deepEqual(JSON.parse(f.requests[1].user).received_evidence, JSON.parse(f.requests[0].user).received_evidence);
  assert.doesNotMatch(result.markdown, /BAD_OUTPUT_POISON/);
  assert.equal(f.input.record.evidence.length, 1);
  assert.equal(f.disposed(), 1);
});

test("两次都没有真实原句时明确失败，不额外调用模型或交付草稿", async () => {
  const f = fixture({ run: async () => output(composition("DRAFT_ONLY", "不存在的依据")) });
  await assert.rejects(f.runner(f.input));
  assert.deepEqual(f.requests.map(request => request.stage), ["answering", "answering"]);
  assert.equal(f.input.record.answer, undefined);
  assert.equal(f.input.record.evidence.length, 1);
  assert.equal(f.disposed(), 1);
});

test("正文虚构的来源不能借真实basis混入答案", async () => {
  const f = fixture({ run: async () => output(composition("DRAFT_ONLY [伪造](#evidence-fake)")) });
  await assert.rejects(f.runner(f.input), /引用|来源/);
  assert.equal(f.requests.filter(request => request.stage === "answering").length, 2);
  assert.equal(f.input.record.evidence.length, 1);
  assert.equal(f.input.record.answer, undefined);
});

test("JSON与原句错误共用一次格式修复额度，不能获得第三次回答", async () => {
  let attempts = 0;
  const f = fixture({ run: async () => attempts++ === 0 ? output("BAD_JSON_POISON") : output(composition(undefined, "来源中没有这句话")) });
  await assert.rejects(f.runner(f.input));
  assert.equal(attempts, 2);
  assert.equal(f.requests[0].user, f.requests[1].user);
  assert.doesNotMatch(f.requests[1].user + f.requests[1].system, /BAD_JSON_POISON/);
  assert.equal(f.input.record.answer, undefined);
});

test("提供方异常不透传认证、内网地址或模型草稿，仍清理连接", async () => {
  const f = fixture({ run: async () => { throw new Error("api_key=SECRET https://private-endpoint request=DRAFT_ONLY"); } });
  await assert.rejects(f.runner(f.input), error => {
    assert.doesNotMatch(String(error), /SECRET|private-endpoint|DRAFT_ONLY/); return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.input.record.answer, undefined);
  assert.equal(f.disposed(), 1);
});

test("未完整结束的回答即使含合法JSON也不能展示或用格式重试掩盖预算失败", async () => {
  for (const [reason, message] of [["output_limit", /模型输出上限/], ["context_limit", /上下文预算/], [undefined, /未完整结束/]] as const) {
    const f = fixture({ run: async () => ({ ...output(composition("PARTIAL_DRAFT")), complete: false, reason }) });
    await assert.rejects(f.runner(f.input), message);
    assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
    assert.equal(f.input.record.evidence.length, 1);
    assert.equal(f.input.record.answer, undefined);
    assert.equal(f.disposed(), 1);
  }
});

test("共享deadline约束不遵守取消的回答模型，等待和资源清理有界", async () => {
  const f = fixture({ timeoutMs: 30, run: async () => new Promise(() => {}) });
  const started = performance.now();
  await assert.rejects(f.runner(f.input), /时间预算|取消/);
  assert.ok(performance.now() - started < 1000);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.disposed(), 1);
  assert.equal(f.input.record.answer, undefined);
});

test("格式修复仍用原deadline，不能重新获得完整时间预算", async () => {
  let attempts = 0;
  const f = fixture({ timeoutMs: 40, run: async () => attempts++ === 0 ? output("invalid") : new Promise(() => {}) });
  const started = performance.now();
  await assert.rejects(f.runner(f.input), /时间预算|取消/);
  assert.equal(attempts, 2);
  assert.equal(f.requests[0].deadlineAt, f.requests[1].deadlineAt);
  assert.ok(performance.now() - started < 1000);
  assert.equal(f.disposed(), 1);
});

test("用户取消后即使模型返回完整回答也不能发布，并清理当前调用", async () => {
  const f = fixture({ run: async () => { f.controller.abort(); return output(composition()); } });
  await assert.rejects(f.runner(f.input), /取消/);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
  assert.equal(f.input.record.answer, undefined);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.disposed(), 1);
});

test("模型初始化晚于取消完成时也回收资源，不启动研究或回答", async () => {
  const f = fixture({ modelDelayMs: 40 });
  const running = f.runner(f.input);
  f.controller.abort();
  await assert.rejects(running, /取消/);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.requests.length, 0);
  assert.equal(f.disposed(), 1);
});

test("没有实际原文时固定说明无法确认，不调用模型凭记忆作答", async () => {
  const f = fixture({ empty: true });
  const result = await f.runner(f.input);
  assert.deepEqual(f.requests.map(request => request.stage), []);
  assert.deepEqual(result.evidence_ids, []);
  assert.equal(result.unknowns.length, 1);
  assert.match(result.markdown, /不代表.*不存在/);
});

test("超出原文预算不会先保存或发送超额内容", async () => {
  const f = fixture({ evidenceChars: 64, content: "原文".repeat(1000) });
  await assert.rejects(f.runner(f.input), /原文预算/);
  assert.equal(f.input.record.evidence.length, 0);
  assert.deepEqual(f.requests.map(request => request.stage), []);
  assert.ok(f.warnings.some(warning => warning.includes("原文预算")));
  assert.equal(f.disposed(), 1);
});

test("来源预算服从实际模型上下文容量，而非仅宿主配置", async () => {
  const f = fixture({ contextChars: 120_000, evidenceChars: 72_000, inputBudgetChars: 4000, content: "原文".repeat(1500) });
  await assert.rejects(f.runner(f.input), /原文预算/);
  assert.equal(f.input.record.evidence.length, 0);
  assert.equal(f.requests.length, 0);
});

test("长问题与已读原文仍完整进入回答，输入包装也在上下文预算内", async () => {
  const content = "原文条件及例外。".repeat(500);
  const f = fixture({ contextChars: 24_000, question: "具体条件？".repeat(400), content, run: async request => {
    const envelopeChars = request.system.length + JSON.stringify([{ role: "user", content: request.user, timestamp: 9_999_999_999_999 }]).length + 2;
    assert.ok(envelopeChars <= request.maxContextChars, `${envelopeChars} > ${request.maxContextChars}`);
    const value = JSON.parse(request.user);
    assert.equal(value.question, f.input.record.question);
    assert.equal(value.received_evidence[0].content, `1: ${content}`);
    assert.match(request.system, /总长度.*最多/);
    return output(composition(undefined, "原文条件及例外。"));
  } });
  const result = await f.runner(f.input);
  assert.deepEqual(result.evidence_ids, ["e1"]);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
});

test("模型拒绝超额完整输入时明确失败，不删来源、静默截断或再调用", async () => {
  const question = "q".repeat(4000), content = "c".repeat(4000);
  const f = fixture({ contextChars: 8192, question, content, run: async request => {
    const value = JSON.parse(request.user);
    assert.equal(value.question, question);
    assert.equal(value.received_evidence[0].content, `1: ${content}`);
    assert.ok(request.system.length + request.user.length > request.maxContextChars);
    return { text: "", complete: false, reason: "context_limit" };
  } });
  await assert.rejects(f.runner(f.input), /上下文|预算/);
  assert.deepEqual(f.requests.map(request => request.stage), ["answering"]);
  assert.equal(f.input.record.evidence[0].content.length, 4000);
  assert.equal(f.input.record.answer, undefined);
  assert.equal(f.disposed(), 1);
});

test("真实引句必须来自对应快照，存在于其他来源的句子不能借编号使用", () => {
  const sources = [...evidence(), { ...evidence("另一来源的条件。 ")[0], id: "e2", title: "另一来源" }];
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify(composition(undefined, "另一来源的条件。")), sources));
  const value = composition();
  value.points[0].basis.push({ evidence_id: "e2", quote: "另一来源的条件。" });
  const result = parseKnowledgeAnswerComposition(JSON.stringify(value), sources);
  assert.deepEqual(new Set(result.evidence_ids), new Set(["e1", "e2"]));
  assert.match(result.markdown, /#evidence-e2/);
});

test("条件分处不同原句时不能拼接成一条虚构原句", () => {
  const sources = evidence("条件A满足时允许。这里另有一段解释。条件B必须核实。");
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify(composition(undefined, "条件A满足时允许。条件B必须核实。")), sources));
  const value = composition(undefined, "条件A满足时允许。");
  value.points[0].basis.push({ evidence_id: "e1", quote: "条件B必须核实。" });
  const result = parseKnowledgeAnswerComposition(JSON.stringify(value), sources);
  assert.deepEqual(result.evidence_ids, ["e1"], "multiple actual quotes of one source keep one source reference");
});

test("某项正文只能链接本项实际basis，不能借其他项的来源", () => {
  const sources = [...evidence(), { ...evidence("另一个事实。")[0], id: "e2" }];
  const value = composition("[另一来源](#evidence-e2)");
  value.points.push({ kind: "answer", body: "另一来源所述范围内，说明另一事实。", basis: [{ evidence_id: "e2", quote: "另一个事实。" }] });
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify(value), sources), /引用|来源/);
});

test("完整输出必须是JSON，说明文字和代码框不能靠截取冒充完整输出", () => {
  const raw = JSON.stringify(composition()), fence = "```";
  assert.deepEqual(parseKnowledgeAnswerComposition(` \n${raw}\n`, evidence()), parseKnowledgeAnswerComposition(raw, evidence()));
  for (const value of [`说明\n${raw}`, `${fence}json\n${raw}\n${fence}`, `${fence}json\n${raw}`, `${raw}\n还有说明`]) assert.throws(() => parseKnowledgeAnswerComposition(value, evidence()), /JSON/);
});

test("不能用旧markdown合同、额外概括字段或空basis绕开完整答复与原句", () => {
  const value = composition();
  for (const invalid of [
    { markdown: "原条件已省略", evidence_ids: ["e1"], unknowns: [] },
    { ...value, final_summary: "因此所有情况都允许。" },
    { ...value, points: [{ ...value.points[0], title: "所有情况都允许。" }] },
    { ...value, points: [{ ...value.points[0], scope: " " }] },
    { ...value, points: [{ ...value.points[0], basis: [] }] },
    { ...value, points: [{ ...value.points[0], basis: [{ evidence_id: "fake", quote: SOURCE }] }] },
  ]) assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify(invalid), evidence()));
});

test("未确认事项与回答共用原始输出和宿主渲染预算，不能分类型绕过容量", () => {
  const value = composition();
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify({ points: Array.from({ length: 16 }, () => ({ kind: "unconfirmed", body: "u".repeat(2000) })) }), evidence(), 24_000));
  const unknownBody = "另一条件尚未确认。";
  const compact = { points: [...value.points, { kind: "unconfirmed", body: unknownBody }] }, raw = JSON.stringify(compact);
  assert.throws(() => parseKnowledgeAnswerComposition(raw, evidence(), raw.length - 1));
  const result = parseKnowledgeAnswerComposition(raw, evidence(), 2000);
  assert.deepEqual(result.unknowns, [unknownBody]);
  assert.ok(JSON.stringify(result).length <= 2000);
});

test("只有具体未知项时可以交付有边界的说明，空回答不能伪装完成", () => {
  const value = { points: [{ kind: "unconfirmed", body: "该场景的配置和实现未取得，无法判断。" }] };
  const result = parseKnowledgeAnswerComposition(JSON.stringify(value), evidence());
  assert.deepEqual(result.evidence_ids, []);
  assert.deepEqual(result.unknowns, [value.points[0].body]);
  assert.ok(result.markdown.trim());
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify({ points: [] }), evidence()));
});

test("文档问答公共入口：实际读取已发布文档，一次生成并保存可核对的引用", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
  const { KnowledgeSearch } = await import("../src/knowledgeSearch.ts");
  const { KnowledgeAnswers } = await import("../src/knowledgeAnswers.ts");
  const dir = mkdtempSync(join(tmpdir(), "qa-document-pipeline-"));
  const doc = saveKnowledgeDocument(dir, { title: "重试规则", content: "# 重试\n失败后最多尝试三次；取消后不得重试。" }, "owner");
  const search = new KnowledgeSearch(dir);
  let calls = 0;
  const answers = new KnowledgeAnswers(dir, createKnowledgeAnswerRunner({ dataDir: dir, search: () => search,
    model: () => ({ provider: "test", model: "test", json: {} }),
    createModel: async () => ({ dispose() {}, async run(request) {
      calls++;
      assert.equal(request.stage, "answering"); assert.deepEqual(request.tools, []); assert.equal(request.images, undefined);
      const source = JSON.parse(request.user).received_evidence[0];
      assert.equal(source.source_id, doc.id); assert.equal(source.revision, doc.revision);
      assert.equal(source.content, "1: # 重试\n2: 失败后最多尝试三次；取消后不得重试。");
      return output({ points: [{ kind: "answer", body: "按文档，失败后最多尝试三次；取消后不得重试。",
        basis: [{ evidence_id: source.id, start_line: 2, end_line: 2 }] }] });
    } }),
  }));
  try {
    const started = answers.create({ question: "失败后重试几次？", context: { document_id: doc.id } }, "alice").record;
    for (let n = 0; n < 100 && ["queued", "running"].includes(answers.get(started.id, "alice").status); n++) await new Promise(resolve => setTimeout(resolve, 5));
    const saved = answers.get(started.id, "alice");
    assert.equal(saved.status, "done", saved.error); assert.equal(calls, 1);
    assert.equal(saved.evidence[0].content, doc.content); assert.deepEqual(saved.answer!.evidence_ids, [saved.evidence[0].id]);
    assert.match(saved.answer!.markdown, /取消后不得重试/);
  } finally { await answers.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
