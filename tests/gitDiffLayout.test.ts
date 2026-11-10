import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIFF_FONT_SIZE,
  clampDiffFontSize,
  clampDiffSplit,
  clampTreePanelWidth,
  diffSplitFromPointer,
} from "../web/src/gitDiffLayout.ts";

test("目录栏拖拽有上下界，并给代码区保留最小宽度", () => {
  assert.equal(clampTreePanelWidth(100, 1200), 240);
  assert.equal(clampTreePanelWidth(900, 1200), 560);
  assert.equal(clampTreePanelWidth(560, 900), 480,
    "900px 容器至少给代码留下 420px");
});

test("变更前后拖拽限制在 25%~75%，指针位置按画布换算", () => {
  assert.equal(diffSplitFromPointer(300, 100, 800), 25);
  assert.equal(diffSplitFromPointer(500, 100, 800), 50);
  assert.equal(diffSplitFromPointer(900, 100, 800), 75);
  assert.equal(clampDiffSplit(61.26), 61.3);
});

test("Git 字号缩放限制在 12~20px，坏值恢复默认", () => {
  assert.equal(clampDiffFontSize(8), 12);
  assert.equal(clampDiffFontSize(17.4), 17);
  assert.equal(clampDiffFontSize(30), 20);
  assert.equal(clampDiffFontSize(Number.NaN), DEFAULT_DIFF_FONT_SIZE);
});
