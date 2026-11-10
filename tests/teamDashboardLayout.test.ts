import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = readFileSync(join(process.cwd(), "web/src/App.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf8");

test("团队任务统计以紧凑摘要展示规模，并用轻量筛选拆分交付中任务", () => {
  assert.match(app, /function TeamDeliveryOverview/);
  // 总览公式(2026-09-01 同步后文案):一行 aria-label 读出
  // 全部任务 = 交付中 + 已交付,三数同源 stats。
  assert.match(app,
    /全部任务 \$\{stats\.total\} 项，交付中 \$\{stats\.delivering\} 项，已交付 \$\{stats\.delivered\} 项/);
  assert.match(app, /已交付/);
  assert.match(app, /交付中/);
  // 阶段与状态两个拆解都在,各自渲染同一批交付中任务的分组计数。
  assert.match(app, /id="delivery-stage-title"/);
  assert.match(app, /id="delivery-status-title"/);
  assert.match(app, /stats\.stages\.map/);
  assert.match(app, /stats\.statuses\.filter\(\(entry\) => entry\.count > 0 \|\| selectedStatus === entry\.key\)\.map/);
  // #233 收官:breakdown 皮肤类换装为 App.tsx 的 CELL_BASE 工具类配方。
  assert.match(app, /const CELL_BASE = "flex min-h-\[38px\][^"]*rounded-lg border border-line bg-surface px-\[11px\] py-1\.5[^"]*disabled:opacity-55"/,
    "概览格按钮配方:38px 高、8px 圆角、紧凑筛选");
  assert.match(app, /const CELL_SELECTED = "flex min-h-\[38px\][^"]*border-primary[^"]*bg-primary[^"]*text-primary/);
  assert.match(app, /teamDeliveryStatusGroup\(item\.task\.status\)/);
  // #233 收官:选中态强调/零状态退后/语义色克制契约由 CELL_SELECTED 与
  // 摘要工具类承担(强调只落在当前筛选项,已交付用 text-success 点到为止)。
  assert.match(app, /disabled:cursor-default disabled:opacity-55/,
    "零状态/禁用项退后(opacity 55)");
});
