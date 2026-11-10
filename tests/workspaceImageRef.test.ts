/**
 * 报告嵌图引用换算的纯函数测试(#376/#381):白名单内外、穿越、
 * URL 拼装形状——只测换算行为,不测渲染器。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceImage } from "../web/src/issues/workspaceImageRef.ts";

test("白名单命中:工单截图与登记截图都换算成会话图片回显 URL", () => {
  const ticket = resolveWorkspaceImage("issue-9",
    "ticket-images/DTS2026091738381/d65d964ac359071a.png");
  assert.equal(ticket,
    "/issues/issue-9/workspace-image"
    + "?path=ticket-images%2FDTS2026091738381%2Fd65d964ac359071a.png");

  const reg = resolveWorkspaceImage("issue-9",
    "issue-images/abcd1234ef567890.jpg");
  assert.equal(reg,
    "/issues/issue-9/workspace-image?path=issue-images%2Fabcd1234ef567890.jpg");
});

test("白名单外:非图片引用一律 undefined,渲染器原样显文本", () => {
  for (const ref of [
    "repo/mgr/main.py",
    "issue-analysis.md",
    "attachments/abcd1234ef567890.log",
    "local-logs/app.log",
    "ticket-images/d65d964ac359071a.png",
    "issue-images/DTS2026091738381/d65d964ac359071a.png",
    "ticket-images/DTS2026091738381/abc.png",
    "ticket-images/DTS2026091738381/d65d964ac359071a.html",
    "issue-images/abcd1234ef567890.svg",
    "ticket-images/../abcd1234ef567890.png",
    "ticket-images/D\0TS/abcd1234ef567890.png",
    "![已渲染过的完整图语法](issue-images/abcd1234ef567890.jpg)",
  ]) {
    assert.equal(resolveWorkspaceImage("issue-9", ref), undefined, ref);
  }
});
