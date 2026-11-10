/**
 * 问题工作台(v2 studio 骨架)左栏高度契约:ws-evidence 是滚动容器,
 * 左栏面板必须生长吃满余量——否则短内容下方整段留白(2026-09-09 用户
 * 报告:对话现场只占上半屏)。ADR-0018 骨架重排把旧 issue-two-pane 的
 * 拉伸链留在死代码里,这里把新骨架的契约钉住,防止再被重排丢掉。
 * #231 改锚:契约原住 issue-workspace 家族(style.css),随去 legacy
 * 整族退役后,拉伸配方直译进 SessionView/MaterialsPane 的工具类——
 * 断言改钉组件源码,守卫语义不变。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sessionView = readFileSync(
  join(process.cwd(), "web/src/issues/SessionView.tsx"), "utf8");
const materialsPane = readFileSync(
  join(process.cwd(), "web/src/issues/MaterialsPane.tsx"), "utf8");

test("问题工作台 v2:左栏面板在 ws-evidence 里生长吃满余量", () => {
  // 面板必须 flex 生长,否则短内容下方整段留白;限高只在宽屏
  // (min-[1101px],直译旧 @media (min-width: 1101px))。
  assert.match(sessionView,
    /"flex min-h-80 min-w-0 flex-1 flex-col gap-2\.5",/);
  assert.match(sessionView, /min-\[1101px\]:max-h-\[calc\(100dvh-150px\)\]/);
});

test("问题工作台 v2:四个材料页签根节点同构拉伸并自滚", () => {
  const rule = materialsPane.match(
    /issue-materials grid content-start gap-3\.5 ([^"]*)"/);
  assert.ok(rule, "材料根的拉伸工具类必须在场");
  assert.match(rule[1], /flex-1/, "材料根必须吃满面板");
  assert.match(rule[1], /overflow-y-auto/, "材料根自滚,长文档不撑破面板");
});

test("对话现场的直播流保持内滚链:面板体、流壳、流三层都吃满", () => {
  const body = sessionView.match(
    /"\[&_\.event-panel-body\]:relative \[&_\.event-panel-body\]:flex[^"]*"/);
  assert.ok(body, "面板体拉伸工具类必须在场");
  assert.match(body[0], /\[&_\.event-panel-body\]:flex-1/, "面板体吃满左栏");
  // 流壳 event-workspace 是 panel-body 与流之间的中间层:壳不生长,
  // 流再 flex 也只是内容高(2026-09-09 下半屏留白的真正断点)。
  assert.match(sessionView,
    /"\[&_\.event-workspace\]:min-h-0 \[&_\.event-workspace\]:flex-1"/,
    "流壳吃满面板体");
  assert.match(sessionView,
    /"\[&_\.event-workspace>\.event-stream\]:h-full \[&_\.event-workspace>\.event-stream\]:max-h-none"/,
    "流撑满流壳,工作台内不设 540px 帽(贴底跟随依赖吃满)");
  // 窄屏单列:左栏不吃视口高,现场流恢复 62vh 帽保住内滚(旧媒体查询直译)。
  assert.match(sessionView,
    /max-\[1100px\]:\[&_\.event-panel-body>\.event-stream\]:max-h-\[62vh\]/);
});
