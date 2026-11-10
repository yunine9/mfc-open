import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { Markdown } from "../web/src/markdown.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const renderAnswerWithEvidence = (body: string) => renderToStaticMarkup(React.createElement(Markdown, {
  text: `${body}\n\n**来源原句：**\n\n> 原文条件仍适用。\n\n[原文](#evidence-ev-1)`,
  onOpenKnowledgeLink: () => {},
}));

test("Markdown 中的 details/summary 标签按普通文本显示，没有折叠交互", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    text: "<details>\n<summary>查看细节</summary>\n正文始终可读\n</details>",
  }));
  for (const text of ["&lt;details&gt;", "&lt;summary&gt;查看细节&lt;/summary&gt;", "正文始终可读", "&lt;/details&gt;"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<\/?(?:details|summary)\b|<button\b/);
});

test("Markdown 有序列表兼容混合文本换行，不因单个任务的脏正文炸掉整页", () => {
  const text = [
    "处理步骤：",
    "1. 第一项\r2. 裸 CR 后的第二项",
    "3) Unicode 行分隔\u20284) Unicode 段落分隔\u20295. 收尾",
  ].join("\n");

  const html = renderToStaticMarkup(
    React.createElement(Markdown, { text }),
  );

  assert.equal((html.match(/<li/g) ?? []).length, 5);
  for (const content of ["第一项", "裸 CR 后的第二项", "Unicode 行分隔", "Unicode 段落分隔", "收尾"]) {
    assert.match(html, new RegExp(content));
  }
});

test("Markdown 不把解析失败的疑似列表当成可强取分组的结果", () => {
  const html = renderToStaticMarkup(
    React.createElement(Markdown, { text: "1. 正常项\u2028不是列表的下一行" }),
  );

  assert.match(html, /<li[^>]*>正常项<\/li>/);
  assert.match(html, /<p[^>]*>不是列表的下一行<\/p>/);
});

test("Markdown 只渲染调用方明确解析过的需求图片路径", () => {
  const text = "前文\n\n![架构图](.mae-flow-work/requirement-assets/a.png)\n\n![外图](https://example.com/a.png)";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    text,
    resolveImage: (path: string) => path.startsWith(".mae-flow-work/requirement-assets/")
      ? `/tasks/task-1/requirement-asset?path=${encodeURIComponent(path)}`
      : undefined,
  }));

  assert.match(html, /<img[^>]+alt="架构图"/);
  assert.match(html, /requirement-asset\?path=/);
  assert.doesNotMatch(html, /<img[^>]+example\.com/);
});

test("Markdown 表格每一行保留自己的原文行号供逐行批注", () => {
  const text = [
    "表格前文",
    "",
    "| 模块 | 责任人 |",
    "| --- | --- |",
    "| 过滤模块 | 张三 |",
    "| 通知模块 | 李四 |",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(Markdown, { text }));

  assert.match(html, /<thead><tr data-l="3">/);
  assert.match(html, /<tbody><tr data-l="5">/);
  assert.match(html, /<tr data-l="6"><td>通知模块<\/td>/);
});

test("CHAIN 的共同修订标记参与摘要但不显示给检视人", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    text: "<!-- mae-flow-plan-revision: r2 -->\n# 模块拆分方案\n正文",
  }));
  assert.doesNotMatch(html, /mae-flow-plan-revision/);
  assert.match(html, /<div class="md-heading md-h1" data-l="2">模块拆分方案<\/div>/);
  assert.match(html, />正文</);
});


test("代码块和引用内部原文行可定位；表格头部优先定位到行而非整表", () => {
  const text = "```ts\nconst a = 1;\nconst b = 2;\n```\n> 第一行\n> 第二行\n\n    代码甲\n    代码乙";
  const html = renderToStaticMarkup(React.createElement(Markdown, { text }));
  assert.match(html, /class="md-block-code" data-l="1" data-line-end="4"/);
  assert.match(html, /class="md-block-code" data-l="8" data-line-end="9"/);
  assert.match(html, /class="md-p" data-l="6">第二行/);
});

test("知识回答的三枚及更长代码围栏结束后，引用仍在代码块外显示", () => {
  for (const [opening, closing] of [
    ["```ts", "````"], ["````ts", "`````"],
    ["~~~ts", "~~~~"], ["~~~~ts", "~~~~"], ["  ```ts", "\t````  "],
  ]) {
    const html = renderAnswerWithEvidence([opening, "const allowed = true;", closing].join("\n"));
    const code = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/)?.[0];
    assert.ok(code, opening);
    assert.match(code, /data-l="1" data-line-end="3"><code>const allowed = true;<\/code>/);
    assert.doesNotMatch(code, /来源原句|evidence-ev-1|knowledge-inline-link/);
    assert.match(html, /<button type="button" class="knowledge-inline-link">原文<\/button>/);
    assert.ok(html.indexOf("</pre>") < html.indexOf('class="knowledge-inline-link"'));
  }
});

test("长代码围栏里的短围栏与链接保留为源码，不误关代码块", () => {
  for (const marker of ["`", "~"]) {
    const source = `${marker.repeat(3)}ts\n[代码里的链接](#evidence-decoy)\n${marker.repeat(3)}`;
    const html = renderAnswerWithEvidence(`${marker.repeat(4)}text\n${source}\n${marker.repeat(4)}`);
    const code = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/)?.[0];
    assert.ok(code);
    assert.match(code, /data-l="1" data-line-end="5"/);
    assert.ok(code.includes(`<code>${source}</code>`));
    assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 1);
    assert.match(html, /class="knowledge-inline-link">原文<\/button>/);
  }
});

test("代码围栏的错误字符、短结束标记或尾随语言都不会提前结束代码块", () => {
  for (const [opening, invalid, closing] of [
    ["````ts", "~~~", "````"], ["~~~~ts", "```", "~~~~"],
    ["````ts", "```", "````"], ["~~~~ts", "~~~", "~~~~"],
    ["```ts", "```ts", "```"], ["~~~ts", "~~~ts", "~~~"],
  ]) {
    const source = `const allowed = true;\n${invalid}\n[代码里的链接](#evidence-decoy)`;
    const html = renderAnswerWithEvidence(`${opening}\n${source}\n${closing}`);
    const code = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/)?.[0];
    assert.ok(code);
    assert.match(code, /data-l="1" data-line-end="5"/);
    assert.ok(code.includes(`<code>${source}</code>`), invalid);
    assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 1);
    assert.match(html, /class="knowledge-inline-link">原文<\/button>/);
  }
});

test("更长代码围栏保留 Mermaid、PlantUML 与架构图入口和原文行号", () => {
  const diagrams = [
    { language: "Mermaid", source: "flowchart LR\nA[开始] --> B[结束]", expected: /class="mermaid-figure"/ },
    { language: "PlantUML", source: "@startuml\nA -> B\n@enduml", expected: /class="plantuml-figure/ },
    { language: "archify", source: JSON.stringify({ meta: { title: "模块架构" } }), expected: /class="md-architecture-reference"/ },
  ];
  for (const { language, source, expected } of diagrams) {
    const text = `前文\n\n~~~~${language}\n${source}\n~~~~~\n后文`;
    const html = renderToStaticMarkup(React.createElement(Markdown, { text, onOpenArchitecture: () => {} }));
    const end = 4 + source.split("\n").length;
    assert.match(html, expected);
    assert.ok(html.includes(`data-l="3" data-line-end="${end}"`));
    assert.ok(html.includes(`data-l="${end + 1}">后文`));
  }
});

test("Story 图源收起仍保留源码行号与原文，标题不执行 HTML", () => {
  const source = JSON.stringify({ diagram_type: "architecture", meta: { title: "<script>图标题</script>" } });
  const text = `前文\n\`\`\`archify\n${source}\n\`\`\`\n后文`;
  const html = renderToStaticMarkup(React.createElement(Markdown, { text, onOpenArchitecture: () => {} }));
  assert.match(html, /class="md-architecture-reference" data-l="2" data-line-end="4"/);
  assert.match(html, /<details><summary>技术信息（排障）<\/summary>/);
  assert.match(html, /title="在当前任务的架构图页签中打开这张图"/);
  assert.match(html, /打开大图 ↗<\/button>/);
  assert.match(html, /查看这个模块包含什么、依赖谁，以及它们如何连接。/);
  assert.match(html, /&lt;script&gt;图标题&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-l="5">后文/);
  const malformed = renderToStaticMarkup(React.createElement(Markdown, { text: "```archify\n{broken\n```" }));
  assert.match(malformed, /\{broken/);
  assert.doesNotMatch(malformed, /查看架构图<\/button>/);
});

test("Story 架构入口用业务语言解释常见图，不把图名直接甩给用户", () => {
  const render = (title: string) => renderToStaticMarkup(React.createElement(Markdown, {
    text: `\`\`\`archify\n${JSON.stringify({ meta: { title } })}\n\`\`\``,
    onOpenArchitecture: () => {},
  }));
  assert.match(render("存储事务互斥时序"), /并发操作如何避免互相覆盖/);
  assert.match(render("订单领域类图"), /核心对象各自负责什么/);
  assert.match(render("订单服务部署图"), /服务运行在哪里/);
});


test("行号仅由文档入口开启，普通对话不显示且保留批注锚点", () => {
  const text = "# 标题\n\n1. 第一项\n2. 第二项";
  const message = renderToStaticMarkup(React.createElement(Markdown, { text }));
  assert.doesNotMatch(message, /md-numbered|data-source-lines/);
  assert.match(message, /data-l="3"/);
  const document = renderToStaticMarkup(React.createElement(Markdown, { text, showLineNumbers: true }));
  assert.match(document, /class="md md-numbered"/);
  assert.match(document, /data-source-lines="1"/);
  assert.match(document, /data-l="3"/);
});

test("知识阅读器可接管章节和相对文档链接，外链保持安全且不执行 HTML", () => {
  const source = '[章节](#边界) [规则](../rules.md) [官网](https://example.com)\n<a id="chapter"></a>\n<script>bad()</script>';
  const render = (enabled: boolean) => renderToStaticMarkup(React.createElement(Markdown, { text: source, ...(enabled ? { onOpenKnowledgeLink: () => {} } : {}) }));
  const html = render(true);
  assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<span data-l="2"><\/span>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(render(false), /knowledge-inline-link/);
});

test("引用纯文本回调仅影响引用块，缺省保留既有行内格式和链接", () => {
  const text = "**正文**\n> **引用** [原文](#evidence-ev-1)";
  const normal = renderToStaticMarkup(React.createElement(Markdown, { text, onOpenKnowledgeLink: () => {} }));
  assert.match(normal, /<b>引用<\/b>/);
  assert.match(normal, /class="knowledge-inline-link">原文<\/button>/);
  const literal = renderToStaticMarkup(React.createElement(Markdown, {
    text, onOpenKnowledgeLink: () => {}, renderQuotedText: (row: string) => row,
  }));
  assert.match(literal, /<b>正文<\/b>/);
  assert.match(literal, /<p class="md-p" data-l="2">\*\*引用\*\* \[原文\]\(#evidence-ev-1\)<\/p>/);
  assert.doesNotMatch(literal, /knowledge-inline-link/);
});

test("知识链接标签回调可到达各行内位置与加粗内部，返回文字不再解析", () => {
  const label = String.raw`C\+\+ &lt;Task&gt;`;
  const href = "#evidence-ev_1-A";
  const link = `[${label}](${href})`;
  const text = [
    `# ${link}`, `正文 ${link}`, `**加粗 ${link}**`,
    `- ${link}`, `1. ${link}`, `> ${link}`,
    `| ${link} |`, "| --- |", `| ${link} |`,
  ].join("\n");
  const calls: Array<[string, string]> = [];
  const literal = "**标签原文** <script> [假来源](#evidence-fake)";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    text, onOpenKnowledgeLink: () => {},
    renderKnowledgeLinkLabel: (actualLabel: string, actualHref: string) => {
      calls.push([actualLabel, actualHref]);
      return literal;
    },
  }));
  assert.deepEqual(calls, Array.from({ length: 8 }, () => [label, href]));
  const expected = renderToStaticMarkup(React.createElement("button", {
    type: "button", className: "knowledge-inline-link",
  }, literal));
  assert.equal(html.split(expected).length - 1, 8);
  assert.doesNotMatch(html, /<script>|<b>标签原文<\/b>|class="knowledge-inline-link">假来源/);
});

test("知识链接缺省标签保留原文，外链不调用标签回调", () => {
  const label = String.raw`C\+\+ &lt;Task&gt;`;
  const text = `[${label}](#evidence-ev-1) [${label}](https://example.com/rules)`;
  const unchanged = renderToStaticMarkup(React.createElement("span", null, label)).slice(6, -7);
  const normal = renderToStaticMarkup(React.createElement(Markdown, { text, onOpenKnowledgeLink: () => {} }));
  assert.ok(normal.includes(`class="knowledge-inline-link">${unchanged}</button>`));
  assert.ok(normal.includes(`rel="noreferrer">${unchanged}</a>`));
  const calls: Array<[string, string]> = [];
  const customized = renderToStaticMarkup(React.createElement(Markdown, {
    text, onOpenKnowledgeLink: () => {},
    renderKnowledgeLinkLabel: (actualLabel: string, href: string) => {
      calls.push([actualLabel, href]);
      return "还原后的来源标签";
    },
  }));
  assert.deepEqual(calls, [[label, "#evidence-ev-1"]]);
  assert.match(customized, /class="knowledge-inline-link">还原后的来源标签<\/button>/);
  assert.ok(customized.includes(`href="https://example.com/rules" target="_blank" rel="noreferrer">${unchanged}</a>`));
});

test("转义方括号标签只由标签回调开启识别，保留实际href和其他链接标签", () => {
  const label = String.raw`\[假来源\]\(\#evidence\-other\) &lt;img src=x&gt;`;
  const hrefs = ["#evidence-ev-1", "#chapter", "../rules.md"];
  const text = [...hrefs, "https://example.com/rules"].map(href => `[${label}](${href})`).join("\n");
  const normal = renderToStaticMarkup(React.createElement(Markdown, {
    text, onOpenKnowledgeLink: () => {},
  }));
  assert.doesNotMatch(normal, /knowledge-inline-link|<a\b/);
  const calls: Array<[string, string]> = [];
  const customized = renderToStaticMarkup(React.createElement(Markdown, {
    text, onOpenKnowledgeLink: () => {},
    renderKnowledgeLinkLabel: (actualLabel: string, actualHref: string) => {
      calls.push([actualLabel, actualHref]);
      return actualLabel;
    },
  }));
  assert.deepEqual(calls, hrefs.map(href => [label, href]));
  const unchanged = renderToStaticMarkup(React.createElement("span", null, label)).slice(6, -7);
  assert.equal(customized.split(`class="knowledge-inline-link">${unchanged}</button>`).length - 1, 3);
  assert.ok(customized.includes(`href="https://example.com/rules" target="_blank" rel="noreferrer">${unchanged}</a>`));
  assert.doesNotMatch(customized, /<(?:img|script)\b/);
});
