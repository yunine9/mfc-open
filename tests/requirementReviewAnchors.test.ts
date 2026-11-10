import test from "node:test";
import assert from "node:assert/strict";
import { reanchorRequirementAnnotations } from "../src/requirementDocument.ts";
import { reanchor } from "../src/annotations.ts";

const image = "![跨制式KPI分析界面](.mae-flow-work/review-assets/000000000000000000000000.png)";
const before = ["# 需求", "", "第一段说明", "", "**结论：涉及**", image].join("\n");

test("前文插入内容后，给 Agent 的加粗文本锚点定位到新行而不改写批注历史", () => {
  const notes = [{ anchor: "结论：涉及", line: 5 }];
  assert.deepEqual(reanchorRequirementAnnotations("新增一段\n\n" + before, notes),
    [{ anchor: "结论：涉及", line: 7 }]);
  assert.equal(notes[0].line, 5);
});

test("跨段批注漂移时起止行一起调整", () => {
  const notes = [{ anchor: "第一段说明", line: 3, line_end: 6 }];
  assert.deepEqual(reanchorRequirementAnnotations("新增一段\n\n" + before, notes),
    [{ ...notes[0], line: 5, line_end: 8 }]);
});

const table = "| 字段名 | 类型 | 约束 | 说明 |\n|--------|------|------|------|\n| user_id | string | 必填 | 用户标识 |";

test("重复表头通过划选正文区分，前文插入后仍定位到正确的整张表", () => {
  const other = table.replace("user_id", "account_id");
  const document = `新增说明\n\n第一张表\n\n${table}\n\n第二张表\n\n${other}`;
  const notes = [{ anchor: "字段名类型约束说明", quote: "字段名 类型 约束 说明 account_id string 必填 用户标识", line: 9, line_end: 11 }];
  assert.deepEqual(reanchorRequirementAnnotations(document, notes),
    [{ ...notes[0], line: 11, line_end: 13 }]);
});

test("选区内部调整换行后，末行按完整选区定位而非照搬旧长度", () => {
  const notes = [{ anchor: "起点", quote: "起点 中间 终点", line: 1, line_end: 3 }];
  assert.deepEqual(reanchorRequirementAnnotations("起点\n\n中间\n\n终点", notes),
    [{ ...notes[0], line: 1, line_end: 5 }]);
});

test("重复表头无选区可区分时仍报告歧义，不猜历史行号", () => {
  assert.equal(reanchor([{ id: "table", artifact: "doc", anchor: "字段名类型约束说明", line: 1 }],
    () => `${table}\n\n${table}`)[0].state, "ambiguous");
});

test("整个表格 DOM 的锚点不含 Markdown 分隔线，仍能映射回源码起始行", () => {
  assert.equal(reanchor([{ id: "table", artifact: "doc", anchor: "字段名类型约束说明user_idstring必填用户标识", line: 1 }],
    () => `前面新增\n\n${table}`)[0].line, 3);
});

test("不同换行符的重锚定与 Markdown 页面行号一致", () => {
  const [check] = reanchor([{ id: "cr", artifact: "doc", anchor: "目标内容", line: 1 }],
    () => "第一行\r第二行\u2028第三行\u2029目标内容");
  assert.equal(check.line, 4);
});

test("缺失材料与位置占位锚不冒充已验证的位置，也不拒绝提交", () => {
  for (const [anchor, content] of [["正文", undefined], ["第 2 行", "前文\n\n后文"]] as const) {
    const [check] = reanchor([{ id: "unknown", artifact: "doc", anchor, line: 2 }], () => content);
    assert.equal(check.state, "hit", "保留旁路放行语义");
    assert.equal(check.location_verified, false);
  }
});

test("代码批注按文件和 hunk 换算真实代码行号，不跨文件匹配", () => {
  const diff = [
    "diff --git a/one.ts b/one.ts", "--- a/one.ts", "+++ b/one.ts",
    "@@ -5,2 +5,2 @@", "-old();", "+target();", " context();",
    "diff --git a/two.ts b/two.ts", "--- a/two.ts", "+++ b/two.ts",
    "@@ -100,2 +120,3 @@", "+new();", " target();", " end();",
  ].join("\n");
  const [check] = reanchor([{ id: "code", artifact: "changes.diff", file: "two.ts",
    anchor: "target();", line: 100 }], () => diff);
  assert.equal(check.state, "moved");
  assert.equal(check.line, 121);
  const [missing] = reanchor([{ id: "code", artifact: "changes.diff", file: "missing.ts",
    anchor: "target();", line: 100 }], () => diff);
  assert.equal(missing.location_verified, false, "不能借用别的文件的同名代码");
});

test("模块改名和排序变化不会让稳定模块 ID 失联", () => {
  const [check] = reanchor([{ id: "module", artifact: "__requirement_graph__",
    anchor: "模块 r1：旧名称", line: 2 }],
  () => "模块拆分与依赖：整体方案\n模块 r2：另一个模块\n模块 r1：新名称");
  assert.equal(check.state, "moved");
  assert.equal(check.line, 3);
});
