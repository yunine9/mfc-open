/**
 * 「跟不跟着滚」的契约。
 *
 * 用户 2026-08-22 原话:"sse 流一直在刷,我想停在某一处看下,就给我刷到
 * 最下面了"。修复的全部实质就是这个判据,所以它必须是可测的纯函数,而不是
 * 埋在组件里的一行 if——埋进去就没人能证明它对。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { atBottom, backlog, BOTTOM_SLACK } from "../web/src/follow.ts";

/** 只给判据用得着的那三个数。 */
function box(scrollTop: number, options?: {
  scrollHeight?: number; clientHeight?: number;
}) {
  return {
    scrollHeight: options?.scrollHeight ?? 1000,
    clientHeight: options?.clientHeight ?? 300,
    scrollTop,
  };
}

test("人在底部:跟着滚,他要的就是最新的", () => {
  assert.equal(atBottom(box(700)), true, "scrollTop=700 正好到底");
});

test("往上翻一点点仍算在底部:亚像素和一帧延迟不该让跟随失灵", () => {
  // 卡死在"严格等于"上会出现"明明在底部却判成没在",于是新事件永远不跟随。
  assert.equal(atBottom(box(700 - (BOTTOM_SLACK - 1))), true);
});

test("真往回看了就撒手——这是整个修复的意义", () => {
  assert.equal(atBottom(box(700 - BOTTOM_SLACK)), false, "刚过余量就算离开");
  assert.equal(atBottom(box(200)), false, "翻回中段,别把他拽回来");
  assert.equal(atBottom(box(0)), false, "翻到最顶上更不能拽");
});

test("内容没撑满容器时算贴底:那时根本没有「往回看」这回事", () => {
  // scrollHeight ≤ clientHeight、scrollTop=0,差值为负,必须判成贴底,
  // 否则一个刚展开、只有两条事件的面板会一上来就显示"已暂停跟随"。
  assert.equal(atBottom(box(0, { scrollHeight: 120, clientHeight: 300 })), true);
  assert.equal(atBottom(box(0, { scrollHeight: 300, clientHeight: 300 })), true);
});

test("积压条数不为负:面板重开会把计数清零", () => {
  assert.equal(backlog(12, 5), 7);
  assert.equal(backlog(5, 5), 0);
  // 切任务/收起再展开时 events 被清空,count 会小于 mark——
  // 不兜住就会在角上显示 "-3 条新的"。
  assert.equal(backlog(2, 5), 0);
});
