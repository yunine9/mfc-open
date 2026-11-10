import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeAnswerCompositionError, knowledgeAnswerSourceLines, parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";
import { KnowledgeAnswerError } from "../src/knowledgeAnswerModel.ts";
import { knowledgeAnswerCitations } from "../src/knowledgeAnswerCitations.ts";
import type { KnowledgeAnswerEvidence } from "../src/knowledgeAnswerTypes.ts";

const original = "已支付且尚未履约的订单，支付后不超过30分钟可自助取消，恰好30分钟也允许。超过30分钟转人工审核。";
const evidence = (overrides: Partial<KnowledgeAnswerEvidence> = {}): KnowledgeAnswerEvidence => ({
  id: "ev-1", kind: "material", title: "订单取消规则", content: original, digest: "digest", retrieved_at: "now", ...overrides,
});
const point = (overrides: Record<string, unknown> = {}) => ({
  kind: "answer",
  body: "已支付、尚未履约的订单适用用户自助取消入口；恰好30分钟允许，超过30分钟应转人工审核。[订单取消规则](#evidence-ev-1)",
  basis: [{ evidence_id: "ev-1", quote: original }], ...overrides,
});
const unconfirmed = (body: unknown) => ({ kind: "unconfirmed", body });
const submission = (points: unknown[] = [point()], unknowns: unknown[] = []) => ({ points: [...points, ...unknowns.map(unconfirmed)] });
const parse = (points: unknown[] = [point()], unknowns: unknown[] = [], sources = [evidence()], maxChars = 24_000) =>
  parseKnowledgeAnswerComposition(JSON.stringify(submission(points, unknowns)), sources, maxChars);
const range = (start_line: unknown, end_line: unknown, evidence_id = "ev-1") => ({ evidence_id, start_line, end_line });

test("#471 多份长引用不使合法答案失败，完整正文和引用行范围保留，原件不截断", () => {
  const sources = Array.from({ length: 8 }, (_, index) => {
    const quote = `条件 ${index + 1}：${"说明".repeat(1700)}\n例外：条件不满足时不得执行。`;
    return evidence({ id: `ev-${index + 1}`, title: `规则 ${index + 1}`, content: (quote + "\n其他内容：").padEnd(index === 7 ? 4288 : 4300, "文") });
  });
  assert.equal(sources.reduce((total, source) => total + source.content.length, 0), 34388);
  const originals = structuredClone(sources);
  const points = sources.map((source, index) => point({
    body: `第 ${index + 1} 项：满足条件才执行，例外仍然适用。`, basis: [range(1, 2, source.id)],
  }));
  const raw = JSON.stringify(submission(points, ["部署版本尚未确认。"]));
  assert.ok(raw.length < 24_000);
  const result = parseKnowledgeAnswerComposition(raw, sources);
  assert.ok(JSON.stringify(result).length <= 24_000);
  for (const item of points) assert.ok(result.markdown.includes(item.body));
  for (const source of sources) assert.ok(result.markdown.includes(`[原文 ${source.id}，第 1–2 行](#evidence-${source.id})`));
  assert.match(result.markdown, /来源原文（点击查看）/);
  assert.deepEqual(result.evidence_ids, sources.map(source => source.id));
  assert.deepEqual(result.unknowns, ["部署版本尚未确认。"]);
  assert.deepEqual(sources, originals);
});

test("#471 接近提交上限的正文与多来源引用仍完整保留，标题和转义膨胀不耗尽正文空间", () => {
  const sources = Array.from({ length: 3 }, (_, index) => evidence({ id: `ev-${index + 1}`,
    title: "<长标题>[伪链接](#evidence-missing)".repeat(100), content: "&<原文条件>".repeat(500) }));
  const points = Array.from({ length: 6 }, (_, index) => point({ kind: index === 0 ? "recommendation" : "answer",
    body: `第${index + 1}项。${"保留正文和例外。".repeat(450)}`, basis: sources.map(source => range(1, 1, source.id)) }));
  const raw = JSON.stringify(submission(points, ["部署情况未知。"]));
  assert.ok(raw.length > 22_000 && raw.length <= 24_000);
  const result = parseKnowledgeAnswerComposition(raw, sources);
  assert.ok(JSON.stringify(result).length <= 24_000);
  for (const item of points) assert.ok(result.markdown.includes(item.body));
  assert.match(result.markdown, /^\*\*建议做法：\*\*/);
  assert.deepEqual(result.unknowns, ["部署情况未知。"]);
  assert.deepEqual(result.evidence_ids, sources.map(source => source.id));
  assert.doesNotMatch(result.markdown, /missing|&lt;|<长标题>/);
});

test("宿主按完整正文与真实原句显示，不另生成标题、前提或总结，代码完整保留", () => {
  const body = "已支付、尚未履约且不超过30分钟（含30分钟）时允许自助取消。\n\n```js\nif (state !== 'PAID') return false;\n\nreturn ageMinutes <= 30;\n```";
  const secondBody = "仍限已支付、尚未履约的订单：超过30分钟应转人工审核。";
  const result = parse([point({ body }), point({ body: secondBody })], ["未取得部署版本。"]);
  assert.ok(result.markdown.startsWith(`${body}\n\n**来源原句：**`));
  assert.ok(result.markdown.includes(`\n\n${secondBody}\n\n**来源原句：**`));
  assert.ok(!result.markdown.includes("适用前提（含例外）"));
  assert.doesNotMatch(result.markdown, /^## /m);
  assert.ok(result.markdown.includes(body));
  assert.ok(result.markdown.includes(`> ${original}`));
  assert.deepEqual(result.evidence_ids, ["ev-1"]);
  assert.deepEqual(result.unknowns, ["未取得部署版本。"]);
  assert.deepEqual(Object.keys(result).sort(), ["evidence_ids", "markdown", "unknowns"]);
  assert.ok(result.markdown.endsWith("[订单取消规则](#evidence-ev-1)"));
});

test("建议用宿主固定标签明确显示，正文和连续真实原句不改写，事实与未知项仍各自保留", () => {
  const first = "优先使用平凡类型。", second = "不得访问可能已销毁的对象。";
  const source = evidence({ content: `50: ${first}\n51: ${second}`, start_line: 50, end_line: 51 });
  const fact = point({ body: "不得访问可能已销毁的对象。", basis: [range(51, 51)] });
  const body = "建议把日志移到析构前显式执行。\n\n```cpp\nWriteLog();\n```";
  const suggestion = point({ kind: "recommendation", body, basis: [range(50, 51)] });
  const result = parse([fact, unconfirmed("尚未取得实际缓存声明。"), suggestion], [], [source]);
  assert.ok(result.markdown.startsWith(`${fact.body}\n\n**来源原句：**`));
  assert.ok(result.markdown.includes(`\n\n**建议做法：**\n\n${body}\n\n**来源原句：**\n\n> ${first}\n> ${second}`));
  assert.equal(result.markdown.split("**建议做法：**").length - 1, 1);
  assert.equal(result.markdown.split(body).length - 1, 1);
  assert.doesNotMatch(result.markdown, /50:|51:|尚未取得实际缓存声明/);
  assert.deepEqual(result.evidence_ids, [source.id]);
  assert.deepEqual(result.unknowns, ["尚未取得实际缓存声明。"]);
  assert.deepEqual(Object.keys(result).sort(), ["evidence_ids", "markdown", "unknowns"]);
  assert.equal(source.content, `50: ${first}\n51: ${second}`);
  assert.ok(parse([point({ kind: "recommendation", body: "建议核对当前原件。" })]).markdown.startsWith("**建议做法：**\n\n"), "离线旧quote支路同样保留标签和引用校验");
});

test("建议仍须有实际basis，不能编造引用、借其他事项来源或放入未确认项逃过来源检查", () => {
  const suggestion = (overrides: Record<string, unknown> = {}) => point({ kind: "recommendation", body: "建议先核对规则。", basis: [range(1, 1)], ...overrides });
  for (const overrides of [
    { basis: undefined }, { basis: [] }, { basis: Array.from({ length: 4 }, () => range(1, 1)) },
    { basis: [range(1, 1, "missing")] }, { basis: [range(1, 2)] },
    { basis: [{ evidence_id: "ev-1", quote: "不存在的建议原句。" }] },
    { body: "[假来源](#evidence-missing)" }, { body: "```cpp\nWriteLog();" },
    { title: "模型自己生成的建议标题" }, { scope: "额外前提" }, { unknowns: [] },
  ]) assert.throws(() => parse([suggestion(overrides)]), KnowledgeAnswerCompositionError);
  const second = evidence({ id: "ev-2", content: "其他事项的原文。" });
  assert.throws(() => parse([suggestion({ body: "[另一事项](#evidence-ev-2)" }), point({ body: "另一事项。", basis: [range(1, 1, "ev-2")] })], [], [evidence(), second]), KnowledgeAnswerCompositionError);
  assert.throws(() => parse([suggestion({ basis: [] }), unconfirmed("这项建议缺少实际依据。")]), KnowledgeAnswerCompositionError);
  assert.throws(() => parse([{ ...unconfirmed("建议先核对规则。"), basis: [range(1, 1)] }]), KnowledgeAnswerCompositionError);
  assert.throws(() => parse([unconfirmed("[建议依据](#evidence-ev-1)")]), KnowledgeAnswerCompositionError);
});

test("建议和事实共用正文与事项上限，长引文改为链接后仍保留建议标签", () => {
  for (const body of ["", " ", null, 1, "字".repeat(4001)]) {
    assert.throws(() => parse([point({ kind: "recommendation", body })]), KnowledgeAnswerCompositionError);
  }
  assert.ok(parse([point({ kind: "recommendation", body: "字".repeat(4000) })]).markdown);
  const suggestions = Array.from({ length: 15 }, () => point({ kind: "recommendation", body: "建议核对依据。" }));
  assert.ok(parse([point(), ...suggestions]).markdown);
  assert.throws(() => parse([point(), ...suggestions, unconfirmed("还缺少现场依据。")]), KnowledgeAnswerCompositionError);

  const points = [point({ kind: "recommendation", body: "建议先核对依据。", basis: [range(1, 1)] })];
  const sources = [evidence({ content: "原文规定适用条件，建议应保留其必要前提。".repeat(80) })];
  const raw = JSON.stringify(submission(points)), result = parseKnowledgeAnswerComposition(raw, sources);
  const label = "**建议做法：**\n\n";
  assert.ok(result.markdown.startsWith(label));
  const withoutLabel = { ...result, markdown: result.markdown.slice(label.length) };
  const smallerBudget = Math.max(raw.length, JSON.stringify(withoutLabel).length, withoutLabel.markdown.length);
  assert.ok(JSON.stringify(result).length > smallerBudget, "固定标签不能在预算之外免费添加");
  const compact = parseKnowledgeAnswerComposition(raw, sources, smallerBudget);
  assert.ok(compact.markdown.startsWith(label));
  assert.ok(compact.markdown.includes(points[0].body));
  assert.ok(JSON.stringify(compact).length <= smallerBudget);
  const exact = Math.max(raw.length, result.markdown.length, JSON.stringify(result).length);
  assert.deepEqual(parseKnowledgeAnswerComposition(raw, sources, exact), result);
  assert.deepEqual(parseKnowledgeAnswerComposition(raw, sources, exact - 1), compact);
  assert.throws(() => parseKnowledgeAnswerComposition(raw, sources, raw.length - 1), /预算/);
});

test("全部未确认时保留具体未知项，不强迫编造结论或引用", () => {
  assert.deepEqual(parse([], [" 未取得本题所需的政策原文。 "]), {
    markdown: "本次查阅的资料不足以确认这些问题，具体缺口见未确认项。", evidence_ids: [], unknowns: ["未取得本题所需的政策原文。"],
  });
  assert.throws(() => parse([], []), KnowledgeAnswerCompositionError);
  assert.throws(() => parse([], [" "]), KnowledgeAnswerCompositionError);
  assert.deepEqual(parse([], ["未取得本题所需的政策原文。"], []), parse([], ["未取得本题所需的政策原文。"]));
});

test("只接受完整JSON和约定字段，固定错误类型不回显输入", () => {
  for (const raw of ["credential=private", "{}", "null", "[]", "```json\n{\"points\":[],\"unknowns\":[\"缺口\"]}\n```", '{"points":[],"unknowns":["缺口"],"summary":"遗漏条件"}']) {
    assert.throws(() => parseKnowledgeAnswerComposition(raw, [evidence()]), error => {
      assert.ok(error instanceof KnowledgeAnswerCompositionError && error instanceof KnowledgeAnswerError);
      assert.ok(!error.message.includes("private")); return true;
    });
  }
  assert.throws(() => parse([point({ summary: "再加一段没有前提的概括。" })]), KnowledgeAnswerCompositionError);
});

test("正文不可为空，长度和事项数量有明确上限", () => {
  for (const body of ["", " ", null, 1, "字".repeat(4001)]) {
    assert.throws(() => parse([point({ body })]), KnowledgeAnswerCompositionError);
  }
  assert.ok(parse([point({ body: "字".repeat(4000) })]).markdown);
  assert.ok(parse(Array.from({ length: 16 }, () => point({ body: "按原文规则处理。" }))).markdown);
  assert.throws(() => parse(Array.from({ length: 17 }, () => point())), KnowledgeAnswerCompositionError);
});

test("有依据事项须有约定类型、body和basis，旧title或scope不能被静默丢弃", () => {
  for (const extra of [{ title: "禁止所有情况" }, { scope: "原文没有给出的额外条件" },
    { title: "旧标题", scope: "旧适用前提" }, { summary: "另作概括" }]) {
    assert.throws(() => parse([point(extra)]), KnowledgeAnswerCompositionError);
  }
  const body = "如果使用函数内 thread_local，初始化允许，析构链不得访问可能已析构的 thread_local；不等于禁止访问全部其他 thread_local。";
  const result = parse([point({ body })]);
  assert.ok(result.markdown.startsWith(`${body}\n\n**来源原句：**`));
  assert.equal(result.markdown.split(body).length - 1, 1, "宿主不重复或改写正文中的条件和判断强度");
  const { kind: _kind, ...oldPoint } = point();
  for (const invalid of [oldPoint, point({ kind: "unknown" }), point({ kind: "" }), point({ kind: null }),
    { ...submission(), unknowns: [] }, { points: [oldPoint], unknowns: [] }]) {
    const raw = "points" in invalid ? JSON.stringify(invalid) : JSON.stringify({ points: [invalid] });
    assert.throws(() => parseKnowledgeAnswerComposition(raw, [evidence()]), KnowledgeAnswerCompositionError);
  }
});

test("未确认正文保留具体内容，非字符串、空白、超长或超出总事项上限都拒绝", () => {
  assert.equal(parse([point()], Array.from({ length: 15 }, (_, index) => `未取得第${index}项资料。`)).unknowns.length, 15);
  assert.equal(parse([], Array.from({ length: 16 }, () => "资料缺失。")).unknowns.length, 16);
  assert.throws(() => parse([point()], Array.from({ length: 16 }, () => "资料缺失。")), KnowledgeAnswerCompositionError);
  for (const item of [null, 1, "", " ", "字".repeat(2001)]) assert.throws(() => parse([point()], [item]), KnowledgeAnswerCompositionError);
  assert.equal(parse([], ["字".repeat(2000)]).unknowns[0].length, 2000);
});

test("未确认正文只形成一次外部unknowns，不进markdown或生成新概括，内部空白不改写", () => {
  const gap = "  历史原因无法确认。\n\n本次未取得需求或历史记录。\t仍需核对原件。  ";
  const body = "已支付、未履约且超过30分钟、不超过60分钟时，规范要求转人工，代码却允许自助取消。";
  const result = parse([unconfirmed(gap), point({ body })]);
  assert.deepEqual(result.unknowns, [gap.trim()]);
  assert.ok(result.markdown.startsWith(body));
  assert.ok(!result.markdown.includes("历史原因"));
  assert.deepEqual(result.evidence_ids, ["ev-1"]);
});

test("未确认事项不能带basis、其他字段或任何evidence指针", () => {
  for (const extra of [{ basis: [] }, { basis: [range(1, 1)] }, { title: "概括" }, { scope: "前提" }, { unknowns: [] }]) {
    assert.throws(() => parse([{ ...unconfirmed("无法确认历史原因。"), ...extra }]), KnowledgeAnswerCompositionError);
  }
  for (const body of ["[来源](#evidence-ev-1)", "#evidence-ev-1", "\\#evidence-ev-1", "`#evidence-ev-1`", "#EVIDENCE-ev-1"]) {
    assert.throws(() => parse([unconfirmed(body)]), KnowledgeAnswerCompositionError);
  }
  assert.throws(() => parse([point({ kind: "unconfirmed" })]), KnowledgeAnswerCompositionError);
});

test("每条结论必须有1至3条实际原句，来源和字段不可编造", () => {
  const valid = { evidence_id: "ev-1", quote: original };
  for (const basis of [[], Array.from({ length: 4 }, () => valid), null, [null], [{ ...valid, extra: true }], [{ evidence_id: "missing", quote: original }], [{ evidence_id: "ev-1" }]]) {
    assert.throws(() => parse([point({ basis })]), KnowledgeAnswerCompositionError);
  }
  assert.ok(parse([point({ basis: [valid, valid, valid] })]).markdown);
  assert.throws(() => parse([point()], [], []), KnowledgeAnswerCompositionError);
});

test("原句必须来自实际证据，改写、标点变化、搜索摘要和空白均拒绝", () => {
  for (const quote of ["所有订单都能取消。", original.replace("。", "；"), "搜索摘要说允许取消。", " ", null]) {
    assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote }] })]), KnowledgeAnswerCompositionError);
  }
  assert.ok(parse([point({ basis: [{ evidence_id: "ev-1", quote: "恰好30分钟也允许。" }] })]).markdown);
});

test("完整503字符真实原段可保留，1200字符边界允许而1201字符拒绝", () => {
  const paragraph = "The source document describes the scope of a rule before explaining its result. A reader must keep the object, state, time boundary, and stated exceptions together when applying that rule. The same paragraph also distinguishes an observed implementation from a business requirement, because matching a repository revision does not establish the deployed version. Preserving the complete paragraph makes those qualifications visible without joining text from unrelated locations or inventing a condition.";
  assert.equal(paragraph.length, 503);
  const actual = [evidence({ content: paragraph })];
  const result = parse([point({ basis: [{ evidence_id: "ev-1", quote: paragraph }] })], [], actual);
  assert.ok(result.markdown.includes(`> ${paragraph.replace(/\./g, "\\.")}`));
  assert.ok(parse([point({ basis: [range(1, 1)] })], [], actual).markdown.includes(`> ${paragraph.replace(/\./g, "\\.")}`));
  assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote: paragraph }] })]), /实际证据/);
  const atLimit = "字".repeat(1199) + "。";
  assert.ok(parse([point({ basis: [{ evidence_id: "ev-1", quote: atLimit }] })], [], [evidence({ content: atLimit })]).markdown);
  const tooLong = "字".repeat(1200) + "。";
  assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote: tooLong }] })], [], [evidence({ content: tooLong })]), /长度/);
  const raw = JSON.stringify(submission([point({ basis: [{ evidence_id: "ev-1", quote: paragraph }] })]));
  assert.throws(() => parseKnowledgeAnswerComposition(raw, actual, raw.length - 1), /预算/);
});

test("引句只规范空白与声明过的宿主行号，不能擅自删除真实编号", () => {
  const first = "已支付且尚未履约的订单允许取消。", second = "超过30分钟应转人工审核。";
  const sources = [evidence({ content: `100: ${first}\n101: ${second}`, start_line: 100, end_line: 101 })];
  for (const quote of [`${first}\n\t${second}`, `100: ${first}\n101: ${second}`]) {
    assert.ok(parse([point({ basis: [{ evidence_id: "ev-1", quote }] })], [], sources).markdown);
  }
  assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote: `${first} ${second}` }] })], [], [evidence({ content: sources[0].content })]), KnowledgeAnswerCompositionError);
  assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote: "1: \n2: \n3: " }] })], [], sources), KnowledgeAnswerCompositionError);
  const numbered = [evidence({ content: `1) ${first}\n2) ${second}`, start_line: 1, end_line: 2 })];
  assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote: `${first} ${second}` }] })], [], numbered), KnowledgeAnswerCompositionError);
});

test("真实元数据可引用，但不能跨字段拼接或当作不存在的部署信息", () => {
  const actual = [evidence({ scope: "本次固定提交的已登记仓库", revision: "abcdef", path: "src/cancel.mjs", location: "行1至6", repository: "https://example.test/orders.git" })];
  for (const quote of [actual[0].title, actual[0].scope!, actual[0].revision!, actual[0].path!, actual[0].location!, actual[0].repository!, actual[0].digest, actual[0].retrieved_at]) {
    assert.ok(parse([point({ basis: [{ evidence_id: "ev-1", quote }] })], [], actual).markdown);
  }
  for (const quote of [`${actual[0].scope} ${actual[0].revision}`, "当前已部署到生产环境"])
    assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote }] })], [], actual), KnowledgeAnswerCompositionError);
});

test("正文引用只能来自当前事项的basis，不能借其他point来源", () => {
  const actual = [evidence(), evidence({ id: "ev-2", title: "实现", content: "该提交的时间上限为60分钟。" })];
  const second = point({ body: "实现使用60分钟。", basis: [{ evidence_id: "ev-2", quote: actual[1].content }] });
  assert.throws(() => parse([point({ body: "[实现](#evidence-ev-2)" }), second], [], actual), KnowledgeAnswerCompositionError);
  const result = parse([point(), second], [], actual);
  assert.deepEqual(result.evidence_ids, ["ev-1", "ev-2"]);
});

test("无效、裸露、图片、转义或藏在代码里的来源指针不能当有效引用", () => {
  for (const body of ["[来源](#evidence-missing)", "[来源](#evidence-)", "#evidence-ev-1", "#evidence", "[来源](#evidence-ev-1.bad)", "\\[来源](#evidence-ev-1)", "![来源](#evidence-ev-1)", "`[来源](#evidence-ev-1)`", "```text\n[来源](#evidence-ev-1)\n```", '<a href="#evidence-ev-1">来源</a>']) {
    assert.throws(() => parse([point({ body })]), KnowledgeAnswerCompositionError);
  }
});

test("来源标题和原句即使包含假引用或HTML，宿主也只生成实际来源链接", () => {
  const quote = '[假来源](#evidence-missing)\n\n<script>alert("x")</script>\n# 假标题';
  const actual = [evidence({ title: '[假来源](#evidence-other) <img src=x>\n实际原文', content: quote })];
  const result = parse([point({ basis: [{ evidence_id: "ev-1", quote }] })], [], actual);
  assert.deepEqual(knowledgeAnswerCitations(result.markdown), ["ev-1", "ev-1"]);
  assert.deepEqual(result.evidence_ids, ["ev-1"]);
  assert.ok(result.markdown.includes("\\#evidence\\-missing"));
  assert.ok(result.markdown.includes("\\#evidence\\-other"));
  assert.ok(result.markdown.includes("&lt;script&gt;"));
  assert.ok(!result.markdown.includes("<img"));
  assert.deepEqual([...result.markdown.matchAll(/#evidence-([^\s)<>"']+)/g)].map(match => match[1]), ["ev-1", "ev-1"]);
});

test("来源无需模型手写引用，宿主生成链接并去重，合法正文链接可保留", () => {
  const result = parse([point({ body: "具体判断依据下面的原句。" }), point({ body: "[规则](#evidence-ev-1)" })]);
  assert.deepEqual(result.evidence_ids, ["ev-1"]);
  assert.equal(knowledgeAnswerCitations(result.markdown).length, 3);
});

test("正文未闭合的代码块必须拒绝，不能吞掉宿主前提和引用", () => {
  for (const body of ["```js\nallow();", "~~~cpp\nallow();", "````js\nallow();\n```"]) {
    assert.throws(() => parse([point({ body })]), /代码块/);
  }
  assert.ok(parse([point({ body: "````js\n\n```\n\nallow();\n````" })]).markdown);
});

test("原始JSON和最终结果仍受预算约束，链接展示保留正文和unknowns", () => {
  const points = [point()], unknowns = ["未取得部署信息。"], raw = JSON.stringify(submission(points, unknowns));
  const result = parseKnowledgeAnswerComposition(raw, [evidence()]);
  const exact = Math.max(raw.length, JSON.stringify(result).length);
  assert.deepEqual(parseKnowledgeAnswerComposition(raw, [evidence()], exact), result);
  assert.throws(() => parseKnowledgeAnswerComposition(raw, [evidence()], exact - 1), /预算/);
  assert.throws(() => parseKnowledgeAnswerComposition(raw, [evidence()], raw.length - 1), /预算/);
  assert.throws(() => parseKnowledgeAnswerComposition(" ".repeat(24_000) + raw, [evidence()]), /预算/);
  const heavyQuote = "[x](#evidence-fake) ".repeat(20).trim();
  const expanded = [point({ body: "结论。", basis: [{ evidence_id: "ev-1", quote: heavyQuote }] })];
  const expandedRaw = JSON.stringify(submission(expanded));
  const escaped = parseKnowledgeAnswerComposition(expandedRaw, [evidence({ content: heavyQuote })], expandedRaw.length);
  assert.ok(escaped.markdown.includes("结论。"));
  assert.deepEqual(knowledgeAnswerCitations(escaped.markdown), ["ev-1"]);
  for (const maximum of [0, -1, 1.5, Infinity]) assert.throws(() => parseKnowledgeAnswerComposition(raw, [evidence()], maximum), /预算/);
});

test("行范围由宿主取连续真实原文，原件与含前提的正文同现，不用模型抄句", () => {
  const first = "只允许 `PAID` 状态。", second = "超过30分钟转人工审核。", third = "已履约订单不适用。";
  const source = evidence({ content: `100: ${first}\n101: ${second}\n102: ${third}`, start_line: 100, end_line: 102 });
  assert.deepEqual(knowledgeAnswerSourceLines(source), { startLine: 100, lines: [first, second, third] });
  const body = "已支付且未履约时，超过30分钟转人工审核。";
  const result = parse([point({ body, basis: [range(101, 102)] })], [], [source]);
  assert.ok(result.markdown.startsWith(`${body}\n\n**来源原句：**`));
  assert.ok(result.markdown.includes(`> ${second}\n> ${third}`));
  assert.ok(!result.markdown.includes(first));
  assert.doesNotMatch(result.markdown, /101:|102:/);
  assert.deepEqual(result.evidence_ids, [source.id]);
  assert.deepEqual(knowledgeAnswerCitations(result.markdown), [source.id]);
  assert.equal(source.content, `100: ${first}\n101: ${second}\n102: ${third}`, "不更改已保存的原件");
});

test("真实raw可按声明起始行定位，未声明的数字前缀和真实编号列表原样保留", () => {
  const numberedText = "1: 真实条目一\n2: 真实条目二";
  const plain = evidence({ content: "第一行\n第二行", start_line: 50, end_line: 51 });
  assert.deepEqual(knowledgeAnswerSourceLines(plain), { startLine: 50, lines: ["第一行", "第二行"] });
  assert.ok(parse([point({ basis: [range(51, 51)] })], [], [plain]).markdown.includes("> 第二行"));
  for (const source of [evidence({ content: numberedText }), evidence({ content: numberedText, start_line: 100, end_line: 101 })]) {
    const start = source.start_line ?? 1;
    assert.deepEqual(knowledgeAnswerSourceLines(source), { startLine: start, lines: numberedText.split("\n") });
    const result = parse([point({ basis: [range(start, start + 1)] })], [], [source]);
    assert.ok(result.markdown.includes("> 1: 真实条目一\n> 2: 真实条目二"));
  }
});

test("仅完整匹配声明行号才剥宿主编号，混合、缺号、错号和缺行拒绝", () => {
  for (const content of ["100: 第一行\n第二行", "第一行\n101: 第二行", "100: 第一行\n999: 第二行", "100: 第一行\n102: 第二行", "100: 第一行\n101: 第二行\n末尾缺号"]) {
    const source = evidence({ content, start_line: 100 });
    assert.throws(() => knowledgeAnswerSourceLines(source), /行号有缺失或混合/);
    assert.throws(() => parse([point({ basis: [range(100, 100)] })], [], [source]), /行号有缺失或混合/);
  }
  const raw = evidence({ content: "100: 字面原文\n101: 仍是原文" });
  assert.deepEqual(knowledgeAnswerSourceLines(raw), { startLine: 1, lines: raw.content.split("\n") });
});

test("引用行号必须为正整数且有序，不能接受额外字段、模型quote或不存在来源", () => {
  for (const [start, end] of [[0, 1], [-1, 1], [1, 0], [2, 1], [1.5, 2], [1, 1.5], ["1", 1], [1, "1"], [null, 1], [1, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => parse([point({ basis: [range(start, end)] })]), KnowledgeAnswerCompositionError);
  }
  for (const basis of [range(1, 1, "missing"), { ...range(1, 1), quote: original }, { ...range(1, 1), extra: true }, { evidence_id: "ev-1", start_line: 1 }]) {
    assert.throws(() => parse([point({ basis: [basis] })]), KnowledgeAnswerCompositionError);
  }
});

test("范围不能超出真实已读行或声明末行，截断来源也不补出未读行", () => {
  const source = evidence({ content: "第一行\n第二行", start_line: 100, end_line: 110, truncated: true });
  assert.ok(parse([point({ basis: [range(100, 101)] })], [], [source]).markdown.includes("> 第一行\n> 第二行"));
  for (const item of [range(99, 100), range(100, 102), range(110, 110)]) {
    assert.throws(() => parse([point({ basis: [item] })], [], [source]), /本次实际读取/);
  }
  const declared = evidence({ content: "第一行\n第二行", start_line: 100, end_line: 100 });
  assert.ok(parse([point({ basis: [range(100, 100)] })], [], [declared]).markdown);
  assert.throws(() => parse([point({ basis: [range(100, 101)] })], [], [declared]), /本次实际读取/);
  for (const bad of [evidence({ start_line: 0 }), evidence({ start_line: 1.5 }), evidence({ start_line: 2, end_line: 1 }),
    evidence({ end_line: 0 }), evidence({ end_line: 1.5 }), evidence({ start_line: Number.MAX_SAFE_INTEGER, content: "一\n二" })]) {
    assert.throws(() => parse([point({ basis: [range(1, 1)] })], [], [bad]), KnowledgeAnswerCompositionError);
  }
});

test("4000字符完整行直接展示，更长原文改为来源链接且不截断，旧抄句仍保留1200上限", () => {
  const paragraph = "段".repeat(502) + "。", atLimit = "字".repeat(3999) + "。", tooLong = "字".repeat(4000) + "。";
  assert.equal(paragraph.length, 503);
  for (const content of [paragraph, atLimit]) {
    const result = parse([point({ basis: [range(1, 1)] })], [], [evidence({ content })]);
    assert.ok(result.markdown.includes(`> ${content}`));
  }
  const source = evidence({ content: tooLong });
  const result = parse([point({ basis: [range(1, 1)] })], [], [source]);
  assert.ok(result.markdown.includes("[原文 ev-1，第 1–1 行](#evidence-ev-1)"));
  assert.ok(!result.markdown.includes(tooLong.slice(0, 100)));
  assert.equal(source.content, tooLong);
  assert.throws(() => parse([point({ basis: [{ evidence_id: "ev-1", quote: atLimit }] })], [], [evidence({ content: atLimit })]), /长度/);
  assert.throws(() => parse([point({ basis: [range(1, 1)] })], [], [evidence({ content: " \t" })]), /不能为空/);
});

test("范围保留真实换行与空白，CRLF计入直接展示长度，超限仍可打开完整来源", () => {
  const source = evidence({ content: "  第一句\r\n\t第二句  ", start_line: 20, end_line: 21 });
  const result = parse([point({ basis: [range(20, 21)] })], [], [source]);
  assert.ok(result.markdown.includes(">   第一句\n> \t第二句  "));
  const atLimit = "字".repeat(3997) + "\r\n尾";
  assert.equal(atLimit.length, 4000);
  assert.ok(parse([point({ basis: [range(1, 2)] })], [], [evidence({ content: atLimit })]).markdown);
  const tooLong = "字".repeat(3998) + "\r\n尾";
  assert.equal(tooLong.length, 4001);
  const longSource = evidence({ content: tooLong });
  assert.match(parse([point({ basis: [range(1, 2)] })], [], [longSource]).markdown, /原文 ev-1，第 1–2 行/);
  assert.equal(longSource.content, tooLong);
});

test("重复range兼容原有引用行为，分离范围不拼接，metadata不能充当正文行", () => {
  const source = evidence({ content: "开头条件\n中间例外\n末尾结果", scope: "部署到生产", revision: "sha-123" });
  assert.ok(parse([point({ basis: [range(1, 1), range(1, 1)] })], [], [source]).markdown);
  const result = parse([point({ basis: [range(1, 1), range(3, 3)] })], [], [source]);
  assert.ok(result.markdown.includes("> 开头条件"));
  assert.ok(result.markdown.includes("> 末尾结果"));
  assert.ok(!result.markdown.includes("中间例外"));
  assert.equal(knowledgeAnswerCitations(result.markdown).length, 3, "正文链接及两个原文范围分别生成引用");
  assert.throws(() => parse([point({ basis: [range(4, 4)] })], [], [source]), /本次实际读取/);
  assert.ok(!result.markdown.includes(source.scope!));
  assert.ok(!result.markdown.includes(source.revision!));
  assert.ok(parse([point({ basis: [range(1, 1)] }), point({ basis: [range(1, 1)] })], [], [source]).markdown);
});

test("range真实内容即使含假指针与HTML也只渲染实际来源，代码和总体预算规则不放宽", () => {
  const source = evidence({ content: '[假来源](#evidence-missing)\n<script>fake()</script>\n原文条件' });
  const result = parse([point({ body: "依据实际来源。", basis: [range(1, 3)] })], [], [source]);
  assert.deepEqual(knowledgeAnswerCitations(result.markdown), [source.id]);
  assert.ok(result.markdown.includes("\\#evidence\\-missing"));
  assert.ok(result.markdown.includes("&lt;script&gt;"));
  assert.throws(() => parse([point({ body: "```js\n未闭合", basis: [range(1, 3)] })], [], [source]), /代码块/);
  const points = [point({ basis: [range(1, 3)] })], raw = JSON.stringify(submission(points));
  assert.throws(() => parseKnowledgeAnswerComposition(raw, [source], raw.length), /预算/);
  const exact = Math.max(raw.length, JSON.stringify(parse(points, [], [source])).length);
  assert.ok(parse(points, [], [source], exact).markdown);
  const compact = parse(points, [], [source], exact - 1);
  assert.ok(JSON.stringify(compact).length <= exact - 1);
  assert.deepEqual(knowledgeAnswerCitations(compact.markdown), [source.id, source.id]);
});
