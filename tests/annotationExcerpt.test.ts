import test from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { readFileSync } from "node:fs";
import ts from "typescript";

// CSS 在真实应用入口加载；这里仅渲染组件验证历史片段的可读性与转义。
const source = readFileSync("web/src/AnnotationExcerpt.tsx", "utf8").replace('import "./annotate.css";', "");
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
const exports: Record<string, any> = {};
new Function("exports", "React", compiled)(exports, React);

test("无法定位时旧批注仍可回看，历史代码转义显示且保留查看文件入口", () => {
  const html = renderToStaticMarkup(React.createElement(exports.AnnotationExcerpt, {
    item: { file: "sample.ts", anchor: "if (a > b) <script>alert(1)</script>", note: "补边界判断" },
    onOpen: () => {},
  }));
  assert.match(html, /批注时原文/);
  assert.match(html, /补边界判断/);
  assert.match(html, /查看当前文件/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("跨行原片段与前后文保留换行，旧 anchor 不覆盖完整选区", () => {
  const html = renderToStaticMarkup(React.createElement(exports.AnnotationExcerpt, {
    item: { file: "story.md", anchor: "short", quote: "第一行\n第二行", note: "合并表述", context_before: "前段", context_after: "后段" },
  }));
  assert.match(html, /第一行\n第二行/);
  assert.match(html, /前段/); assert.match(html, /后段/);
  assert.doesNotMatch(html, /short/);
});
