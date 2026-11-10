import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  WORKBENCH_GLOBAL_CHECKPOINTS,
  WORKBENCH_STATUSES,
  WORKBENCH_UI_SCENARIOS,
} from "../scripts/ui-workbench-scenarios.ts";

const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf-8");
const inspector = readFileSync(
  join(process.cwd(), "web/src/TaskInspector.tsx"), "utf-8");
const fixtureSeed = readFileSync(
  join(process.cwd(), "scripts/seed-ui-workbench-fixtures.ts"), "utf-8");
const taskService = readFileSync(
  join(process.cwd(), "src/taskService.ts"), "utf-8");

test("工作台场景库覆盖全部任务状态与关键交互变体", () => {
  const statuses = new Set(WORKBENCH_UI_SCENARIOS.map((item) => item.status));
  assert.deepEqual([...statuses].sort(), [...WORKBENCH_STATUSES].sort());

  const required = [
    "queued", "running-rich", "pausing", "paused-assistant",
    "requirement-decision", "long-form-decision", "chain-decision",
    "push-review", "coordinating", "verifying-live", "verifying-stalled",
    "scope-violation", "await-merge", "failed", "completed", "canceled",
  ];
  assert.deepEqual(WORKBENCH_UI_SCENARIOS.map((item) => item.key), required);
  assert.equal(new Set(required).size, required.length, "场景键不得重复");
  assert.ok(WORKBENCH_UI_SCENARIOS.every((item) =>
    item.checkpoints.length >= 3 && item.actions.length >= 4));
});

test("场景动作覆盖工作台全部层级，不把能力删成好看的空壳", () => {
  const actions = new Set(WORKBENCH_UI_SCENARIOS.flatMap((item) => item.actions));
  for (const required of [
    "当前", "材料", "工作过程", "检视意见",
    "暂停", "取消", "恢复", "交回给 Agent", "补充给 Agent",
    "搜索", "全屏查看",
    "邀请他人检视", "等我确认", "Agent 处理中", "已完成",
    "看全部改动", "专注审阅",
    "折叠全部目录",
    "缩小 Git 字号", "放大 Git 字号", "行批注",
    "自定义答复", "提交决定", "确认推送",
    "需要调整代码", "发送并继续修改",
    "回灌报错", "重跑续推", "导出诊断包",
    "放行,随本单元交付", "打回,撤出越界改动",
    "打开合入请求", "重跑续推", "删除任务", "确认删除",
  ]) assert.ok(actions.has(required), `场景库缺少动作：${required}`);

  assert.match(workspace, /\["focus", "当前"\]/);
  assert.match(workspace, /\["materials", "材料"\]/);
  assert.match(workspace, /\["execution", "工作过程"\]/);
  assert.match(workspace, /<Composer/);
  assert.match(workspace, /<ConversationStream/);
  assert.match(workspace, /crossRepository=\{Boolean\(task\.parent_task_id\)\}/, "跨仓子任务的输入区带「通知上下游」档");
  // 2026-09-05 重建后执行面板与用量进了任务检查器(TaskInspector),
  // 工作过程视图挂的是 TaskJourney;能力没删,只是换了住处。
  assert.match(workspace, /<TaskJourney/);
  assert.match(inspector, /<ExecutionPanel/);
  assert.match(workspace, /<KnowledgeFootprint/);
  assert.match(inspector, /<TokenUsage/);
  assert.match(workspace, /<WarmupPanel/);
});

test("主题、密度、断点、快捷键、空错态与三类权限进入全局巡检表", () => {
  const checkpoints = new Set<string>(WORKBENCH_GLOBAL_CHECKPOINTS);
  for (const required of [
    "深夜主题", "云昼主题", "舒适密度", "紧凑密度",
    "1440px 桌面", "900px 窄桌面", "390px 手机",
    "Alt+1/2/3 视图快捷键", "Alt+R 检视快捷键", "Escape 分层退出",
    "空态", "加载态", "接口失败态",
    "责任人权限", "受邀检视人权限", "只读旁观权限",
  ]) assert.ok(checkpoints.has(required), `全局巡检缺少：${required}`);
});

test("持久场景使用双门禁冻结，默认生成不会覆盖已有人工现场", () => {
  assert.match(fixtureSeed, /existsSync\(join\(dataDir, "auth\.json"\)\) && !force/);
  assert.match(fixtureSeed, /需要恢复标准数据时运行 npm run ui:fixtures:reset/);
  assert.match(fixtureSeed, /ui-scenarios\.json/);
  assert.match(fixtureSeed, /input_tokens: 184320[\s\S]*updated_at: iso\(1\)/,
    "运行场景必须带可投影的真实用量时间，不能只造一个永远不显示的累计数");
  assert.match(taskService,
    /process\.env\.MAE_FLOW_UI_FIXTURE_MODE === "1"[\s\S]*summary\.ui_fixture === true/);
  assert.match(taskService, /正式数据[\s\S]*正常恢复语义/);
});
