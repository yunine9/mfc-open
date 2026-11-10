import { unifiedDiffRows } from "../web/src/diffLines.ts";
/**
 * diff 行 → 新文件行号。这是代码批注的定位地基:算错一位,所有代码
 * 批注都指错地方,而模型手上的文件里根本没有"diff 第几行"这回事。
 *
 * 最容易错的一处:删除行不占新文件的行号(它在新文件里已经不存在)。
 * 顺着往下数会让删除行后面的每一行都偏移。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffReviewRows,
  newFileLines,
} from "../web/src/diffLines.ts";

test("行号从 @@ 的新文件起点递推,删除行不占号", () => {
  const diff = [
    "diff --git a/SmsHandler.java b/SmsHandler.java",   // 0
    "index 111..222 100644",                             // 0
    "--- a/SmsHandler.java",                             // 0
    "+++ b/SmsHandler.java",                             // 0
    "@@ -18,6 +20,7 @@ class SmsHandler {",              // 0(hunk 头本身没行号)
    "     private void send() {",                        // 20 上下文
    "-        retry(3);",                                //  0 删除行不占号
    "+        retryOnGatewayFailure(3);",                // 21 新增
    "+        log.info(\"sent\");",                      // 22 新增
    "     }",                                            // 23 上下文
  ];
  assert.deepEqual(newFileLines(diff), [0, 0, 0, 0, 0, 20, 0, 21, 22, 23]);
});

test("多个 hunk 各自从自己的起点重新数", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    " a",
    "+b",
    "@@ -50,2 +60,2 @@",
    " x",
    "+y",
  ];
  assert.deepEqual(newFileLines(diff), [0, 1, 2, 0, 60, 61]);
});

test("没有 hunk 头就不给行号——宁可不可圈注,也不给错坐标", () => {
  assert.deepEqual(
    newFileLines(["?? web/src/new.ts"]), [0]);
  assert.deepEqual(
    newFileLines(["diff --git a/x b/x", "index 1..2"]), [0, 0]);
});

test("@@ 头省略行数(单行 hunk)照样认", () => {
  assert.deepEqual(newFileLines(["@@ -7 +9 @@", "+只有一行"]), [0, 9]);
});

test("双栏审阅把删除与新增横向配对,两侧行号各自递推", () => {
  const rows = diffReviewRows([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -8,3 +10,4 @@",
    " before",
    "-old one",
    "-old two",
    "+new one",
    "+new two",
    "+new three",
    " after",
  ]);
  assert.deepEqual(rows, [
    { type: "hunk", text: "@@ -8,3 +10,4 @@" },
    {
      type: "line",
      old: { number: 8, text: "before", kind: "context" },
      next: { number: 10, text: "before", kind: "context" },
    },
    {
      type: "line",
      old: {
        number: 9, text: "old one", kind: "removed", emphasis: [0, 3],
      },
      next: {
        number: 11, text: "new one", kind: "added", emphasis: [0, 3],
      },
    },
    {
      type: "line",
      old: {
        number: 10, text: "old two", kind: "removed", emphasis: [0, 3],
      },
      next: {
        number: 12, text: "new two", kind: "added", emphasis: [0, 3],
      },
    },
    {
      type: "line",
      next: { number: 13, text: "new three", kind: "added" },
    },
    {
      type: "line",
      old: { number: 11, text: "after", kind: "context" },
      next: { number: 14, text: "after", kind: "context" },
    },
  ]);
});

test("词级高亮:公共前后缀之外的中段标 emphasis;整行不同不标", () => {
  const rows = diffReviewRows([
    "@@ -1,3 +1,3 @@",
    "-const value = 1;",
    "-completely old",
    "-tail",
    "+const value = 42;",
    "+entirely new!",
    "+tail",
  ]);
  const [first, second, third] = rows.slice(1) as Array<
    Extract<ReturnType<typeof diffReviewRows>[number], { type: "line" }>
  >;
  // 只有 "1" → "42" 变了:两侧 emphasis 圈住变化段,文本原样保留
  // (mark 不改 textContent,批注锚定靠这一点)。
  assert.deepEqual(first.old?.emphasis, [14, 15]);
  assert.deepEqual(first.next?.emphasis, [14, 16]);
  assert.equal(first.old?.text, "const value = 1;");
  // 整行没有公共前后缀:不标,全行高亮等于没高亮。
  assert.equal(second.old?.emphasis, undefined);
  assert.equal(second.next?.emphasis, undefined);
  // 文本完全相同的配对(只是位置变化)也不标。
  assert.equal(third.old?.emphasis, undefined);
  assert.equal(third.next?.emphasis, undefined);
});

test('patch trailing newline does not create a phantom source line', () => {
 const lines = ['diff --git a/a.cpp b/a.cpp','@@ -0,0 +1,1 @@','+int value = 1;',''];
 assert.deepEqual(diffReviewRows(lines).filter(row => row.type === 'line').map(row => row.next?.number), [1]);
 assert.equal(newFileLines(lines).at(-1), 0);
});

 test('上下对比先展示完整删除块，再展示新增块，不交错两套行号', () => {
 const rows = unifiedDiffRows(diffReviewRows(['@@ -2,2 +2,3 @@','-oldA','-oldB','+newA','+newB','+newC']));
 assert.deepEqual(rows.filter(row => row.type === 'line').map(row => [row.old?.text ?? row.next?.text, row.old?.number ?? row.next?.number]),
   [['oldA',2],['oldB',3],['newA',2],['newB',3],['newC',4]]);
 });
