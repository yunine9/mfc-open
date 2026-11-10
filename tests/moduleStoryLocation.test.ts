import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleStoryLine } from "../web/src/moduleStoryLocation.ts";

test("模块按第一列稳定 ID 定位当前 Story，不误跳到依赖提及或旧行号", () => {
  const story = "# 模块\n| 单元 | 职责 |\n| unit-1 | 先做 |\n| unit-2 | 依赖 unit-1 |";
  assert.equal(moduleStoryLine(story, { id: "unit-1", name: "同步" }), 3);
  assert.equal(moduleStoryLine("新增内容\n" + story, { id: "unit-2", name: "已改名" }), 5);
  assert.equal(moduleStoryLine(story + "\n| unit-1 | 另一个说明 |", { id: "unit-1", name: "同步" }), undefined);
});

test("不匹配代码示例，旧文档仅对唯一模块标题回退定位", () => {
  const story = "```text\n| unit-1 | 示例 |\n```\n### 订单同步模块\n具体设计";
  assert.equal(moduleStoryLine(story, { id: "unit-1", name: "订单同步" }), 4);
  assert.equal(moduleStoryLine(story + "\n### 订单同步模块", { id: "unit-1", name: "订单同步" }), undefined);
  assert.equal(moduleStoryLine(story, { id: "missing", name: "订单查询" }), undefined);
});
