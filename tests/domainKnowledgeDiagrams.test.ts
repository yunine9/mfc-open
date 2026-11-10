import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { createKnowledgeDiagramChecker, knowledgeDiagramBlocks, knowledgeDiagramFeedback } from "../src/domainKnowledgeDiagrams.ts";
import { PLANTUML_SOURCE_LIMIT, type PlantUmlResult } from "../src/plantumlRender.ts";

// 所有渲染均注入确定性替身；这里验证宿主识别、诊断、缓存和取消，不证明真实 PlantUML 文法。
const validSvg: PlantUmlResult = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>' };
const source = "@startuml\nparticipant A\nparticipant B\nA -> B : request\n@enduml";
const fenced = (body: string, marker = "```", info = "plantuml") => `${marker}${info}\n${body}\n${marker}`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("图围栏未闭合、语言错误、缺结束符与单块多图都明确失败，未发现图单独报告零数量", async () => {
  let calls = 0;
  const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async () => { calls++; return validSvg; } });
  const cases = [
    { text: `\`\`\`plantuml\n${source}`, error: /未闭合/ },
    { text: `\`\`\`plantuml\n${source}\n~~~`, error: /未闭合/ },
    { text: `\`\`\`\`plantuml\n${source}\n\`\`\``, error: /未闭合/ },
    { text: fenced(source, "```", "puml"), error: /必须仅标为 plantuml/ },
    { text: fenced(source, "```", "text"), error: /必须仅标为 plantuml/ },
    { text: source, error: /完整的 plantuml 代码块/ },
    { text: fenced("@startuml\nA -> B"), error: /仅含一张图/ },
    { text: fenced(`${source}\n${source}`), error: /仅含一张图/ },
    { text: fenced(""), error: /仅含一张图/ },
  ];
  for (const item of cases) {
    const report = await check(item.text);
    assert.equal(report.status, "invalid", item.text);
    assert.equal(report.total, 1, item.text);
    assert.match(report.diagrams[0].error ?? "", item.error);
  }
  assert.equal(calls, 0, "结构错误不应送给渲染器或冒充成功");
  assert.deepEqual(await check("正文\n```ts\nconst answer = 42;\n```"), { status: "valid", total: 0, checked: 0, diagrams: [] });
});

test("图识别与页面统一 CRLF、裸 CR 和 Unicode 换行，支持大小写标签及波浪围栏", async () => {
  for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    for (const [marker, info] of [["```", "PlantUML"], ["~~~~", "PLANTUML"]]) {
      const received: string[] = [];
      const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async text => { received.push(text); return validSvg; } });
      const markdown = ["标题", `${marker}${info}`, ...source.split("\n"), marker].join(separator);
      const report = await check(markdown);
      assert.equal(report.status, "valid"); assert.equal(report.total, 1); assert.equal(report.checked, 1);
      assert.equal(report.diagrams[0].line, 3);
      assert.deepEqual(received, [source], "不同换行不能漏掉整张图");
    }
  }
});

test("页面不渲染的引用图和额外语言信息返回明确错误，不宣称图可展示", async () => {
  let calls = 0;
  const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async () => { calls++; return validSvg; } });
  for (const info of ["plantuml title=业务", "plantuml {#diagram}", "plantuml\tlinenums"]) {
    const report = await check(fenced(source, "```", info));
    assert.equal(report.status, "invalid"); assert.match(report.diagrams[0].error ?? "", /必须仅标为 plantuml/);
  }
  const report = await check(fenced(source).split("\n").map(line => `> ${line}`).join("\n"));
  assert.equal(report.status, "invalid"); assert.match(report.diagrams[0].error ?? "", /引用块之外/);
  assert.equal(calls, 0);
});

test("特殊显示名、消息换行、缩进及 note 内引用文本原样交给渲染器，引用内反引号不是结束围栏", async () => {
  const actual = [
    "@startuml", '  participant "订单/服务::Core<T> (入口)" as A', '  participant "库存(服务)" as B',
    "  A -> B : reserve(quantity)\\n结果", "note over A", "> 待复核业务条件", "> ```", "end note", "@enduml",
  ].join("\n");
  const controller = new AbortController(), received: string[] = [];
  const check = createKnowledgeDiagramChecker({ signal: controller.signal, render: async (text, options) => {
    received.push(text); assert.equal(options?.signal, controller.signal); assert.equal(options?.sandbox, true); return validSvg;
  } });
  const blocks = knowledgeDiagramBlocks(fenced(actual));
  assert.equal(blocks.length, 1); assert.equal(blocks[0].error, undefined); assert.equal(blocks[0].source, actual);
  const report = await check(fenced(actual));
  assert.equal(report.status, "valid"); assert.deepEqual(received, [actual]);
});

test("语法错误 SVG 转为有限的文字诊断并保留文稿位置", async () => {
  const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async () => ({ syntax_error: true,
    svg: `<svg>${Array.from({ length: 14 }, (_, i) => `<text>source-line-${i}</text>`).join("")}<text>Syntax Error? &#x884c; &lt;T&gt; &amp; <tspan>bad arrow</tspan></text></svg>` }) });
  const report = await check(`说明\n\n${fenced(source)}`);
  assert.equal(report.status, "invalid"); assert.equal(report.total, 1); assert.equal(report.diagrams[0].line, 4);
  const error = report.diagrams[0].error ?? "";
  assert.match(error, /Syntax Error\? 行 <T> & bad arrow/); assert.doesNotMatch(error, /source-line-0\b|<svg|<text|<tspan/);
  assert.ok(error.length <= 1600);
  assert.match(knowledgeDiagramFeedback("business-flow", report), /business-flow: PlantUML invalid，已检查 1\/1 张图/);
  assert.match(knowledgeDiagramFeedback("business-flow", report), /第 1 张，文稿第 4 行/);
});

test("按完整图源复用渲染，正文位置变化仍返回新位置，图源变化必须重新检查", async () => {
  const received: string[] = [];
  const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async text => { received.push(text); return validSvg; } });
  await check(fenced(source)); await check(fenced(source));
  const moved = await check(`新的说明\n\n${fenced(source)}`);
  assert.equal(moved.diagrams[0].line, 4); assert.equal(received.length, 1);
  const changed = source.replace("request", "requestWithCondition");
  await check(fenced(changed)); await check(fenced(source));
  assert.deepEqual(received, [source, changed]);
});

test("同一检查器并发读取相同图只渲染一次", async () => {
  const gate = deferred<void>(); let calls = 0;
  const controller = new AbortController();
  const check = createKnowledgeDiagramChecker({ signal: controller.signal, render: async () => { calls++; await gate.promise; return validSvg; } });
  const pending = [check(fenced(source)), check(`前言\n${fenced(source)}`)];
  try {
    await nextTurn(); assert.equal(calls, 1);
    gate.resolve(); const reports = await Promise.all(pending);
    assert.ok(reports.every(report => report.status === "valid"));
    assert.deepEqual(reports.map(report => report.diagrams[0].line), [2, 3]);
  } finally { controller.abort(); gate.resolve(); await Promise.allSettled(pending); }
});

test("运行不可用停止剩余图检查且不缓存为成功，恢复后可以检查全部图", async () => {
  let calls = 0, unavailable = true;
  const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async () => {
    calls++; return unavailable ? { error: "服务端没有 Java" } : validSvg;
  } });
  const markdown = [source, source.replace("request", "second"), source.replace("request", "third")].map(text => fenced(text)).join("\n\n");
  const first = await check(markdown);
  assert.equal(first.status, "unavailable"); assert.equal(first.total, 3); assert.equal(first.checked, 1); assert.equal(calls, 1);
  assert.match(first.diagrams[0].error ?? "", /没有 Java/);
  unavailable = false;
  const retry = await check(markdown);
  assert.equal(retry.status, "valid"); assert.equal(retry.checked, 3); assert.equal(calls, 4);
});

test("单图大小按 UTF-8 字节限制，超限不启动渲染", async () => {
  let calls = 0;
  const check = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async () => { calls++; return validSvg; } });
  const large = `@startuml\nnote as N\n${"汉".repeat(Math.ceil(PLANTUML_SOURCE_LIMIT / 3))}\nend note\n@enduml`;
  assert.ok(large.length < PLANTUML_SOURCE_LIMIT); assert.ok(Buffer.byteLength(large) > PLANTUML_SOURCE_LIMIT);
  const report = await check(fenced(large));
  assert.equal(report.status, "invalid"); assert.match(report.diagrams[0].error ?? "", /256 KiB/); assert.equal(calls, 0);
});

test("不同检查器共用最多两个渲染槽，等待期间取消不占槽或阻挡后续任务", async () => {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const gates = Array.from({ length: 4 }, () => deferred<void>());
  const started: number[] = []; let active = 0, maximum = 0;
  const checkers = controllers.map((controller, i) => createKnowledgeDiagramChecker({ signal: controller.signal, render: async () => {
    active++; maximum = Math.max(maximum, active); started.push(i);
    try { await gates[i].promise; return validSvg; } finally { active--; }
  } }));
  const pending = checkers.map(check => check(fenced(source)));
  for (const promise of pending) void promise.catch(() => {});
  try {
    await nextTurn(); assert.deepEqual(started, [0, 1]); assert.equal(active, 2);
    controllers[2].abort(new Error("取消等待中的图检查"));
    await assert.rejects(pending[2], /取消等待中的图检查/);
    gates[0].resolve(); assert.equal((await pending[0]).status, "valid");
    await nextTurn(); assert.deepEqual(started, [0, 1, 3]); assert.equal(active, 2);
    gates[1].resolve(); gates[3].resolve();
    assert.equal((await pending[1]).status, "valid"); assert.equal((await pending[3]).status, "valid");
    assert.equal(maximum, 2); assert.equal(active, 0);
  } finally {
    for (const controller of controllers) controller.abort();
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
  }
});

test("已取消任务不启动渲染，渲染期间取消不能把随后返回的 SVG 当作通过", async () => {
  const preCancelled = new AbortController(); preCancelled.abort(new Error("预先取消"));
  let calls = 0;
  const cancelledCheck = createKnowledgeDiagramChecker({ signal: preCancelled.signal, render: async () => { calls++; return validSvg; } });
  await assert.rejects(cancelledCheck(fenced(source)), /预先取消/); assert.equal(calls, 0);
  const activeController = new AbortController(), gate = deferred<void>();
  const check = createKnowledgeDiagramChecker({ signal: activeController.signal, render: async () => { calls++; await gate.promise; return validSvg; } });
  const pending = check(fenced(source)); void pending.catch(() => {});
  try {
    await nextTurn(); assert.equal(calls, 1);
    activeController.abort(new Error("渲染期间取消")); gate.resolve();
    await assert.rejects(pending, /渲染期间取消/);
    const following = createKnowledgeDiagramChecker({ signal: new AbortController().signal, render: async () => validSvg });
    assert.equal((await following(fenced(source))).status, "valid");
  } finally { activeController.abort(); gate.resolve(); await Promise.allSettled([pending]); }
});
