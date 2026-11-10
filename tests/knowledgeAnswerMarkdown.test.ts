import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";
import { KnowledgeAnswerMarkdown } from "../web/src/KnowledgeAnswerMarkdown.tsx";
import { answerParts } from "../web/src/knowledgeAnswerPresentation.ts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const render = (text: string) => renderToStaticMarkup(React.createElement(KnowledgeAnswerMarkdown, { text, onOpenKnowledgeLink: () => {} }));
function answer(quote: string, title = "规则原文", body = "**条件**仍须符合规则。") {
  return parseKnowledgeAnswerComposition(JSON.stringify({ points: [{ kind: "answer", body, basis: [{ evidence_id: "ev-1", quote }] }] }), [
    { id: "ev-1", kind: "material", title, content: quote, digest: "fixture", retrieved_at: "fixture" },
  ]).markdown;
}

test("来源原句从正文移到来源按钮，传给侧栏的文字逐字还原", () => {
  for (const quote of [
    "thread_local <Task> & Pool.submit()",
    "C:\\work\\file_(v1).txt；\\_、\\[、\\\\、\\` 保持原文。",
    "字面实体 &lt; &gt; &amp; &amp;lt; &quot; &#65; 不继续解码。",
    "`代码`、**重点**、{字段}、# 标题、+ 增量、- 减量、! 提示、| 分隔。",
    "第一行\n> 第二行：<Task> &amp;\n第三行：[仅原文](#evidence-fake)",
  ]) {
    const text = answer(quote), parts = answerParts(text);
    assert.deepEqual(parts.filter(part => part.kind === "sources"), [{ kind: "sources", citations: [{ id: "ev-1", label: "规则原文", quote }] }]);
    const html = render(text);
    assert.doesNotMatch(html, /<blockquote|来源原句/);
    assert.match(html, /<b>条件<\/b>仍须符合规则/);
    assert.match(html, /aria-label="查看来源：规则原文"/);
  }
});

test("来源标题作为纯文本显示，保留 C++、括号、HTML、实体与假链接", () => {
  for (const title of [
    "Google C++ 风格指南 / src/file_(v1).txt #section",
    "C:\\work\\file_(v1).txt；\\_、\\\\、\\` 保持原文。",
    "[章节] [嵌套[方括号]]；\\[、\\] 保持原文。",
    "字面实体 &lt; &gt; &amp; &amp;lt; &quot; &#65; 不继续解码。",
    '<script>alert("标题")</script> `代码`、**重点**、{字段}、+、-、!、|',
    '[假来源](#evidence-other) <img src=x>',
  ]) {
    const text = answer("原文条件。", title), parts = answerParts(text);
    assert.equal(parts[1].kind === "sources" && parts[1].citations[0].label, title);
    const html = render(text);
    assert.ok(html.includes(renderToStaticMarkup(React.createElement("span", null, title))));
    assert.equal((html.match(/class="ka-source-link"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<(?:script|a|img|code)\b/);
  }
});

test("引用中的假来源与HTML既不插进正文，也不创建额外按钮", () => {
  const quote = '<script>alert("原文")</script> [伪来源](#evidence-fake) [外链](https://example.com)';
  const text = answer(quote), html = render(text);
  assert.equal((html.match(/class="ka-source-link"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<(?:script|a|img|blockquote)\b|伪来源|外链/);
  const source = answerParts(text)[1];
  assert.equal(source.kind === "sources" && source.citations[0].quote, quote);
});

test("正文中的来源链接继续可点击，只有内部来源标签还原转义", () => {
  const label = String.raw`C\+\+ &lt;Task&gt; &amp;lt;`;
  const html = render([`[${label}](#evidence-ev_1-A)`, `[${label}](#chapter)`, `[${label}](https://example.com/rules)`].join("\n"));
  const decoded = renderToStaticMarkup(React.createElement("span", null, "C++ <Task> &lt;")).slice(6, -7);
  const unchanged = renderToStaticMarkup(React.createElement("span", null, label)).slice(6, -7);
  assert.deepEqual([...html.matchAll(/class="knowledge-inline-link">([\s\S]*?)<\/button>/g)].map(match => match[1]), [decoded, unchanged]);
  assert.ok(html.includes(`<a href="https://example.com/rules" target="_blank" rel="noreferrer">${unchanged}</a>`));
});

test("同段多个来源、同源多段引用和长回答的行号链接保持对应关系", () => {
  const text = "结论一\n\n**来源原句：**\n\n> 条件一\n\n[规则](#evidence-ev-1)\n\n> 条件二\n\n[代码](#evidence-ev-2)\n\n**建议做法：**\n\n建议保留例外\n\n**来源原文（点击查看）：**\n\n[原文 ev-1，第 42–45 行](#evidence-ev-1)";
  const parts = answerParts(text);
  assert.deepEqual(parts.filter(part => part.kind === "sources").map(part => part.citations), [
    [{ id: "ev-1", label: "规则", quote: "条件一" }, { id: "ev-2", label: "代码", quote: "条件二" }],
    [{ id: "ev-1", label: "原文 ev-1，第 42–45 行" }],
  ]);
  const html = render(text);
  assert.match(html, /建议保留例外/);
  assert.equal((html.match(/<span>1<\/span>/g) ?? []).length, 2);
  assert.equal((html.match(/<span>2<\/span>/g) ?? []).length, 1);
});

test("代码示例中的来源标记、普通引用及不完整来源不能被收起或丢失", () => {
  for (const text of [
    "````md\n**来源原句：**\n\n> 示例\n\n[示例](#evidence-demo)\n`````\n保留代码后的正文",
    "~~~md\n**来源原文（点击查看）：**\n\n[示例](#evidence-demo)\n~~~",
    "正文\n\n> 普通引用",
    "正文\n\n**来源原句：**\n\n> 缺少来源链接的内容",
    "正文\n\n**来源原句：**\n\n> 外部链接不能作为平台来源\n\n[示例](https://example.com)",
  ]) assert.deepEqual(answerParts(text), [{ kind: "body", text }]);
});
