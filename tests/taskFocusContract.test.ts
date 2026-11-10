/**
 * 任务焦点的全分支契约(纯函数,不起服务)。
 *
 * 为什么要有:十天 204 笔 fix 里 46 笔是"卡片/状态文案不自述"——页面上只剩
 * "验证中""失败"三两个字,人不知道轮到谁、该去哪、做完会怎样。焦点模块
 * 是这些文案的唯一来源(README:前端不推断状态),但此前只有零星用例按
 * 分支各测各的;改一处措辞、加一个分支,没有任何东西提醒"其它分支的自述
 * 是否还成立"。
 *
 * 本文件做两件事:
 * 1. 逐分支锁定当前输出(表驱动,与 src/taskFocus.ts 的 `return focus(`
 *    一一对应)。改文案必须来改这张表——这是有意的摩擦,不是负担;
 * 2. 横切规则:凡 needs_attention 的焦点,必须有明确的负责方、标题不能是
 *    裸状态词、下一步必须给人一个动作。任何新分支自动受约束。
 *
 * 分支数按源码里 `return focus(` 的个数锁死:新增分支不补表,这里先红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectTaskFocus, type TaskFocus } from "../src/taskFocus.ts";

type Input = Parameters<typeof projectTaskFocus>[0];

interface Row {
  /** 对应源码分支的说明,排查时按它找。 */
  branch: string;
  input: Input;
  expect: TaskFocus;
}

const F = (
  kind: TaskFocus["kind"], headline: string, next_action: string,
  owner: TaskFocus["owner"], priority: number, needs_attention = false,
): TaskFocus => ({ kind, headline, next_action, owner, needs_attention, priority });

/** 每个 `return focus(` 至少一行;有条件措辞的分支把每种措辞都列出来。 */
const ROWS: Row[] = [
  { branch: "继续修改·准备中",
    input: { status: "completed", continuation: { state: "preparing" } },
    expect: F("machine", "正在准备继续修改", "正在更新基准并保留原目录与缓存", "agent", 50) },
  { branch: "继续修改·准备失败待重试",
    input: { status: "completed", continuation: { state: "failed", error: "基准拉取失败" } },
    expect: F("human_action", "继续修改准备未完成", "打开原任务，重试继续修改", "responsible", 96, true) },
  { branch: "继续修改·准备完成后正常排队",
    input: { status: "queued", continuation: { state: "active" } },
    expect: F("machine", "任务正在执行队列中等待", "获得执行资源后自动开始", "platform", 30) },
  { branch: "coordinating·有异常子任务",
    input: { status: "coordinating", detail: "1/2 个子任务已完成",
      requirement_graph: { repositories: [{ task_status: "completed" }, { task_status: "failed" }] } },
    expect: F("human_action", "1/2 个子任务已完成", "打开主任务查看并处理异常子任务", "responsible", 96, true) },
  { branch: "coordinating·都在推进",
    input: { status: "coordinating", requirement_graph: { repositories: [{ task_status: "running" }] } },
    expect: F("machine", "子任务正在推进", "等待各子任务完成或取消", "agent", 50) },
  { branch: "waiting_for_human·澄清卡",
    input: { status: "waiting_for_human", waiting: { question: { purpose: "clarification", questions: [{}] } } },
    expect: F("human_action", "Agent 处理检视意见时缺少信息,需要你补充",
      "答复后 Agent 继续处理这条意见;这不是最终验收", "responsible", 100, true) },
  { branch: "waiting_for_human·N 个决策项",
    input: { status: "waiting_for_human", waiting: { question: { questions: [{}, {}] } } },
    expect: F("human_action", "需要确认 2 个决策项", "提交决定后 Agent 自动继续", "responsible", 100, true) },
  { branch: "waiting_for_human·无结构化问题",
    input: { status: "waiting_for_human" },
    expect: F("human_action", "需要负责人确认", "提交决定后 Agent 自动继续", "responsible", 100, true) },
  { branch: "failed·从未起跑(下单配置问题)",
    input: { status: "failed", detail: "克隆失败: repository not found" },
    expect: F("blocked", "克隆失败: repository not found",
      "多为下单配置问题(仓库/分支/单号):修正后重新发起任务", "responsible", 95, true) },
  { branch: "failed·跑起来后失败",
    input: { status: "failed", progress: { current_phase: "build" } },
    expect: F("blocked", "任务执行失败", "查看代码与未提交文件，补充处理要求；原因解除后可按原流程重试", "responsible", 95, true) },
  { branch: "paused·助手占场",
    input: { status: "paused", assistant_engaged: true },
    expect: F("blocked", "开发助手正在接管代码现场，主任务已安全暂停",
      "在右栏输入框切到「我来接手」完成工作并点「交回给 Agent」后自动继续", "responsible", 90, true) },
  { branch: "paused·普通暂停",
    input: { status: "paused" },
    expect: F("blocked", "任务已暂停，现场已经保留", "需要继续时从当前现场恢复", "responsible", 90, true) },
  { branch: "证据缺口·点名维度",
    input: { status: "verifying", delivery: { evidence_gap: { state: "waiting_human", missing_dimensions: ["UT", "CodeCheck"] } } },
    expect: F("human_action", "流水线 UT、CodeCheck 缺少具体报错",
      "在工作台《流水线证据缺口》材料上批注并回灌平台原文", "responsible", 98, true) },
  { branch: "证据缺口·未点名维度",
    input: { status: "verifying", delivery: { evidence_gap: { state: "waiting_human" } } },
    expect: F("human_action", "流水线缺少可修复的具体报错",
      "在工作台《流水线证据缺口》材料上批注并回灌平台原文", "responsible", 98, true) },
  { branch: "Build-Fix·进程活着且在跑",
    input: { status: "running", delivery: { prepush: { state: "compiling", round: 2 }, prepush_runtime: { state: "running" } } },
    expect: F("machine", "正在进行 Build-Fix（第 2 轮）", "定向编译与受影响 UT 通过后继续交付", "agent", 58) },
  { branch: "Build-Fix·服务恢复中",
    input: { status: "verifying", delivery: { prepush: { state: "testing" }, prepush_runtime: { state: "recovering", message: "正在接回上次的 Build-Fix" } } },
    expect: F("machine", "正在接回上次的 Build-Fix", "定向编译与受影响 UT 通过后继续交付", "agent", 58) },
  { branch: "停摆·stalled 原因",
    input: { status: "verifying", delivery: { stalled: "宿主推送失败: fatal: remote rejected" } },
    expect: F("blocked", "宿主推送失败: fatal: remote rejected", "查看失败原因并重跑续推", "responsible", 92, true) },
  { branch: "停摆·基础设施类按类别给下一步",
    input: { status: "verifying", delivery: { stalled: "内核暂时不可用: dispatch 超时", stall_class: "infrastructure" } },
    expect: F("blocked", "内核暂时不可用: dispatch 超时",
      "不用改代码:等平台或内核恢复后在任务页重试交付,机器从停下的地方接着验证", "responsible", 92, true) },
  { branch: "停摆·材料缺失类",
    input: { status: "verifying", delivery: { stalled: "当前 HEAD 尚无有效 Build-Fix 收据", stall_class: "evidence_missing" } },
    expect: F("blocked", "当前 HEAD 尚无有效 Build-Fix 收据",
      "按停摆原因把缺的材料补齐(回灌流水线原文、补 Build-Fix 收据或平台事实)后在任务页重试交付", "responsible", 92, true) },
  { branch: "停摆·材料不合格类",
    input: { status: "verifying", delivery: { stalled: "批注 a-1 标了 fixed 但没有 evidence", stall_class: "evidence_invalid" } },
    expect: F("blocked", "批注 a-1 标了 fixed 但没有 evidence",
      "看停摆原因点名的收据问题,让 Agent 重做或在工作台补说明,再在任务页重试交付", "responsible", 92, true) },
  { branch: "停摆·配置契约类",
    input: { status: "verifying", delivery: { stalled: "未配置交付平台", stall_class: "contract" } },
    expect: F("blocked", "未配置交付平台",
      "修正任务配置、平台接入或提交本身后在任务页重试交付;配置不改,重试结果不变", "responsible", 92, true) },
  { branch: "停摆·完整性类不劝人直接重试",
    input: { status: "verifying", delivery: { stalled: "平台实际合入的提交 abc1234 与本任务验证过的 def5678 不一致", stall_class: "safety" } },
    expect: F("blocked", "平台实际合入的提交 abc1234 与本任务验证过的 def5678 不一致",
      "先人工核实分支与提交(是否被平台改写、是否有外来改动),确认无误再重试交付;系统不会自动重试", "responsible", 92, true) },
  { branch: "停摆·类别只在 stalled 存在时生效",
    input: { status: "verifying", delivery: { stall_class: "safety", loop: { state: "halted", diagnosis: "修复会话判断需人工处理" } } },
    expect: F("blocked", "修复会话判断需人工处理", "查看失败原因并重跑续推", "responsible", 92, true) },
  { branch: "停摆·修复环 halted 带诊断",
    input: { status: "verifying", delivery: { loop: { state: "halted", diagnosis: "修复会话判断需人工处理" } } },
    expect: F("blocked", "修复会话判断需人工处理", "查看失败原因并重跑续推", "responsible", 92, true) },
  { branch: "停摆·修复环 exhausted 无诊断",
    input: { status: "verifying", delivery: { loop: { state: "exhausted", round: 3, max: 3 } } },
    expect: F("blocked", "自动验证已停止", "查看失败原因并重跑续推", "responsible", 92, true) },
  { branch: "Build-Fix·环境故障",
    input: { status: "running", delivery: { prepush: { state: "environment_error", message: "构建镜像拉取失败" } } },
    expect: F("blocked", "构建镜像拉取失败", "等待平台恢复编译环境", "platform", 85, true) },
  { branch: "Build-Fix·代码侧 blocked",
    input: { status: "running", delivery: { prepush: { state: "blocked" } } },
    expect: F("blocked", "Build-Fix 暂时无法继续", "查看编译或 UT 失败现场", "agent", 85, true) },
  { branch: "canceled", input: { status: "canceled" },
    expect: F("inactive", "任务已取消", "无需继续处理", "none", 0) },
  { branch: "completed", input: { status: "completed" },
    expect: F("done", "交付已经完成", "可在交付历史中复盘", "none", 5) },
  { branch: "await_merge·MR 已关闭",
    input: { status: "await_merge", delivery: { mr_state: "已关闭" } },
    expect: F("human_action", "MR 已关闭，任务仍在等待处理", "重新打开 MR 继续推进，或主动停止任务", "responsible", 94, true) },
  { branch: "await_merge·waiting_on 优先",
    input: { status: "await_merge", delivery: { waiting_on: "等待检视人审批", mr_state: "opened" } },
    expect: F("human_action", "等待检视人审批", "打开 MR 完成检视、审批与合入", "responsible", 82, true) },
  { branch: "await_merge·只有 mr_state",
    input: { status: "await_merge", delivery: { mr_state: "opened" } },
    expect: F("human_action", "合入请求：opened", "打开 MR 完成检视、审批与合入", "responsible", 82, true) },
  { branch: "await_merge·什么都没有",
    input: { status: "await_merge" },
    expect: F("human_action", "验证通过，等待合入", "打开 MR 完成检视、审批与合入", "responsible", 82, true) },
  { branch: "pausing", input: { status: "pausing" },
    expect: F("machine", "正在安全暂停当前会话", "保存现场后自动进入暂停状态", "platform", 55) },
  { branch: "修复环·检视返工(kind=review)",
    input: { status: "running", delivery: { loop: { state: "repairing", kind: "review", round: 0 } } },
    expect: F("machine", "Agent 正在按检视意见修改", "修改完成后重新出检视卡", "agent", 60) },
  { branch: "修复环·流水线修复(kind=ci)",
    input: { status: "running", delivery: { loop: { state: "repairing", kind: "ci", round: 1 } } },
    expect: F("machine", "Agent 正在修复流水线问题", "产生新提交后自动重新验证", "agent", 60) },
  { branch: "Build-Fix·会话中断",
    input: { status: "verifying", delivery: { prepush: { state: "compiling" }, prepush_runtime: { state: "interrupted" } } },
    expect: F("blocked", "Build-Fix 已经中断，当前没有执行会话", "服务会自动恢复；未恢复时可手动重跑编译", "platform", 88, true) },
  { branch: "Build-Fix·排队(无活性信息)",
    input: { status: "verifying", delivery: { prepush: { state: "queued" } } },
    expect: F("machine", "正在进行 Build-Fix", "记录本次验证结果后继续当前工作", "agent", 58) },
  { branch: "verifying·权威流水线",
    input: { status: "verifying", delivery: { waiting_on: "流水线 #12 运行中" } },
    expect: F("external", "流水线 #12 运行中", "验证通过后进入等待合入", "platform", 45) },
  { branch: "queued·等前置任务",
    input: { status: "queued", blocked_by: ["task-2"] },
    expect: F("external", "等待 1 个前置任务完成", "依赖满足后自动开始", "platform", 35) },
  { branch: "queued·有位次",
    input: { status: "queued", queue_position: 2, detail: "人工重跑,重新入队" },
    expect: F("machine", "排队等待执行资源(第 2 位)", "人工重跑,重新入队", "platform", 30) },
  { branch: "queued·无位次",
    input: { status: "queued" },
    expect: F("machine", "任务正在执行队列中等待", "获得执行资源后自动开始", "platform", 30) },
  { branch: "running·里程碑受阻",
    input: { status: "running", progress: { step: "build", milestone: { event: "blocked", reason: "依赖下载超时" } } },
    expect: F("machine", "依赖下载超时", "Agent 正在定位并尝试解除阻塞", "agent", 65) },
  { branch: "running·有步骤名",
    input: { status: "running", progress: { step: "story" } },
    expect: F("machine", "Agent 正在推进：story", "当前工作完成后自动进入下一步", "agent", 40) },
  { branch: "running·无步骤名",
    input: { status: "running" },
    expect: F("machine", "Agent 正在推进任务", "当前工作完成后自动进入下一步", "agent", 40) },
  { branch: "未知状态兜底",
    input: { status: "something_new", detail: "迁移中" },
    expect: F("inactive", "迁移中", "无需人工操作", "none", 0) },
];

test("焦点契约:表覆盖源码里的每一个分支(新增分支必须补表)", () => {
  const source = readFileSync(new URL("../src/taskFocus.ts", import.meta.url), "utf-8");
  const sites = (source.match(/return focus\(/g) ?? []).length;
  assert.equal(sites, 25,
    `src/taskFocus.ts 现在有 ${sites} 个 return focus( 分支;改了分支数请同步更新本表与这里的常量`);
  assert.ok(ROWS.length >= sites, "契约表的行数不能少于分支数");
});

for (const row of ROWS) {
  test(`焦点契约:${row.branch}`, () => {
    assert.deepEqual(projectTaskFocus(row.input), row.expect);
  });
}

/** 横切规则:等人的焦点必须自述"谁、干什么、之后怎样"。
 * 动作词表是"下一步必须给人一个动词"的最低要求;"正在…"是机器口吻,
 * 不许出现在要人动手的下一步里。 */
const ACTION_WORD = /打开|查看|答复|提交|修正|重新|重跑|重试|恢复|回灌|批注|接手|继续|等待|停止|核实|补齐/;

test("焦点契约:凡 needs_attention 必有负责方、非裸状态标题、带动作的下一步", () => {
  const attention = ROWS.filter((row) => row.expect.needs_attention);
  assert.ok(attention.length >= 15, "等人分支至少 15 条,少了说明表被裁了");
  for (const row of attention) {
    const result = projectTaskFocus(row.input);
    assert.notEqual(result.owner, "none", `${row.branch}: 等人的焦点必须有负责方`);
    assert.ok(["human_action", "blocked"].includes(result.kind),
      `${row.branch}: 等人的焦点只能是 human_action 或 blocked`);
    assert.ok(result.headline.trim().length >= 4, `${row.branch}: 标题不能是裸状态词`);
    assert.doesNotMatch(result.headline, /^(verifying|failed|paused|queued|running)$/i,
      `${row.branch}: 标题不能直接吐状态枚举`);
    assert.match(result.next_action, ACTION_WORD,
      `${row.branch}: 下一步「${result.next_action}」没有给人一个动作`);
    assert.doesNotMatch(result.next_action, /^正在/,
      `${row.branch}: 要人动手的下一步不能是机器口吻`);
    assert.ok(result.priority >= 82, `${row.branch}: 等人的焦点排序必须压过机器态`);
  }
});

test("焦点契约:机器/外部/终态焦点不冒充人工待办", () => {
  for (const row of ROWS.filter((item) => !item.expect.needs_attention)) {
    const result = projectTaskFocus(row.input);
    assert.equal(result.needs_attention, false, row.branch);
    assert.ok(result.priority < 82, `${row.branch}: 非人工焦点不得排到人工待办之前`);
    assert.notEqual(result.kind, "human_action", row.branch);
  }
});
