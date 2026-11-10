import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 2026-09-06 度量:12 天 245 个 fix 提交里 98 个(40%)落在 src/taskService.ts
// (21,630 行)。它是修 bug 的重灾区,原因不是某个 bug,而是交付恢复、停摆、
// 合入监视、推送确认……所有状态机都堆在一处,改一处牵一处。棘轮只锁
// "不再长":每绞杀式抽出一块就把上限往下拧;要加代码先把相关块抽走再加。
// 上限故意零余量——让"顺手加了 30 行"的改动立刻被问一句"能不能放别处"。
// 度量口径与 wc -l 一致(数换行符),免得两边对不上。
const LIMITS: Record<string, number> = {
  "src/taskService.ts": 20983,
};

for (const [file, limit] of Object.entries(LIMITS)) {
  test(`体量棘轮:${file} 不超过 ${limit} 行`, () => {
    const content = readFileSync(join(process.cwd(), file), "utf-8");
    const lines = (content.match(/\n/g) ?? []).length;
    assert.ok(lines <= limit,
      `${file} 现在 ${lines} 行,上限 ${limit}。别往这里加:先把相关块抽成独立`
      + "模块(README「已知边界」2026-09-06 体量棘轮),抽完把上限拧到新值。");
  });
}
