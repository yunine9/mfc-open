/**
 * "对人说话的口径"是提示不是校验(用户 2026-09-05 拍板):
 * - 常量里四件事都在:结论先行、不贴 diff/日志、过程话压成一句、说人话;
 * - 只经 pi 的 appendSystemPromptOverride 挂到 driver 自己的会话(子 Agent 不挂);
 * - 只有主会话与开发助手两个 create 站点打开它,专项会话不面对人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HUMAN_FACING_STYLE } from "../src/sessionDriver.ts";

test("口径常量说全四件事,且不是命令式校验", () => {
  // 骨架借自 ayghri/i-have-adhd(先说动作、不寒暄、多步编号、一个下一步、
  // 列表封顶、报错就事论事),再加本仓的现场约束。
  for (const cue of ["先说结论", "不写开场白", "结尾只给一个下一步", "用编号", "封顶五条",
    "进展到哪了", "不要把整段 diff", "过程话", "就事论事", "听得懂的话", "用中文", "例外"]) {
    assert.ok(HUMAN_FACING_STYLE.includes(cue), `缺少:${cue}`);
  }
  assert.doesNotMatch(HUMAN_FACING_STYLE, /必须|禁止|否则/, "是口径提示,不是门禁措辞");
});

test("只挂在 driver 自己的会话上,且只有主会话与开发助手打开", () => {
  const driver = readFileSync(new URL("../src/sessionDriver.ts", import.meta.url), "utf8");
  assert.match(driver,
    /this\.options\.humanFacing && config\.sessionId === this\.sessionId[\s\S]*?\? \[HUMAN_FACING_STYLE, pendingDecisionsPrompt\(workspace\)\] : \[\][\s\S]*?appendSystemPromptOverride: \(base: string\[\]\) => \[[\s\S]*?\.\.\.base, \.\.\.appendedSystemPrompt/);
  const service = readFileSync(new URL("../src/taskService.ts", import.meta.url), "utf8");
  assert.equal((service.match(/humanFacing: true,/g) ?? []).length, 2,
    "主会话 + 开发助手,专项会话(编译/预热/抽取/需求检视)不挂");
});
