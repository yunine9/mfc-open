/**
 * 弹层基件迁移(shadcn Dialog)后的 node 冒烟。Dialog 开着的本体走
 * portal 到 body,renderToStaticMarkup 没有 DOM,输出是空串(2026-09-11
 * 实测)——所以这里只冒烟"关着零渲染 + 导入链通(@/ 别名、@base-ui、cn、
 * lucide 在根侧 tsx 下可解析)";开态视觉、Esc 不连坐 window 返回键、
 * 焦点归还都是客户端行为,留给浏览器人工过目,别当它测过(边界与
 * uiModal 时代一致)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { QuickWishButton } from "../web/src/WishQuickCreate.tsx";
import { RepositoryResourceNotice } from "../web/src/RepositoryResourceNotice.tsx";

// 根测试运行器按 classic JSX 装载 web 组件(rootErrorBoundary 用例同款)。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("QuickWishButton:关着只渲染触发按钮,弹层与旧 Modal 零残留", () => {
  const html = renderToStaticMarkup(
    React.createElement(QuickWishButton, { onOpenWall: () => {} }));
  assert.match(html, /快速提问题/, "触发按钮要在");
  assert.ok(!html.includes("ui-modal"), "旧 Modal 类不该再出现");
  assert.ok(!html.includes("一句话说明问题"), "关着的弹层表单不该渲染出来");
});

test("RepositoryResourceNotice:没读到规则时零渲染", () => {
  // effects 在 SSR 不跑,rules 恒为初始 []——按"无规则返回 null"收口。
  const html = renderToStaticMarkup(
    React.createElement(RepositoryResourceNotice, { repositories: [] }));
  assert.equal(html, "");
});
