/**
 * 根错误边界的契约:渲染异常必须变成"能读的错误页",不是白屏。
 *
 * 2026-08-29 实测:知识清单点某一行白屏。全仓当时只有 LaunchWorkspace
 * 里一个局部边界,别处抛异常 React 就卸载整棵树——页面纯白、零线索,
 * 用户只能说"卡死了"。白屏最坏的地方不是坏了,是坏了还不留证据。
 *
 * 测得到什么、测不到什么(不含糊):
 * - 测得到:getDerivedStateFromError 的接管开关、降级页的内容、以及
 *   无异常时的透传。这三条覆盖了"人看到什么"。
 * - 测不到:React **只在客户端渲染时**触发错误边界,SSR 里异常直接
 *   往上抛。本仓没有 DOM 环境(不为一个用例引 jsdom),所以"真的接住
 *   一次客户端异常"这一段没有被自动化验证——如实记在这里,别当它测过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { RootErrorBoundary } from "../web/src/RootErrorBoundary.tsx";

// 根测试运行器按 classic JSX 装载 web 组件(与 activityDiagram 用例同款)。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

// 降级页要读 location;SSR 里没有,补最小替身。
const globals = globalThis as Record<string, unknown>;
globals.location ??= { pathname: "/tasks", search: "?id=1" };

test("根错误边界:拿到异常就切降级页(接管开关)", () => {
  const boom = new Error("知识清单渲染炸了");
  assert.deepEqual(RootErrorBoundary.getDerivedStateFromError(boom),
    { error: boom }, "必须把异常记进 state,否则不会切降级页");
});

test("根错误边界:降级页把错误原文摆在页面上,不是只写进控制台", () => {
  const boundary = new RootErrorBoundary({ children: null });
  boundary.state = {
    error: new Error("知识清单渲染炸了"),
    componentStack: "\n    at TaskKnowledgeSelector\n    at LaunchWorkspace",
  };
  const html = renderToStaticMarkup(boundary.render());

  assert.ok(html.length > 0, "页面不能是空的——空 = 白屏");
  assert.match(html, /页面出错了/, "要有一句人话说明发生了什么");
  // 最关键的一条:只写进 console 等于要求报障的人自己会开 F12,
  // 把排障成本转嫁给了最不该承担它的人。
  assert.match(html, /知识清单渲染炸了/, "错误原文必须出现在页面上");
  assert.match(html, /TaskKnowledgeSelector/, "组件栈要带上,才定位得到是哪一块");
  assert.match(html, /刷新页面/, "要给一条走得通的出路");
});

test("根错误边界:没有异常时一个字都不插手", () => {
  const html = renderToStaticMarkup(
    React.createElement(RootErrorBoundary, null,
      React.createElement("main", { id: "app" }, "正常内容")));
  assert.equal(html, '<main id="app">正常内容</main>');
});
