/**
 * 任务工作台的持久视觉回归目录。
 *
 * 这里列的是用户能感知的状态与动作，不是截图文件名。种子脚本把每一项
 * 变成真实 task.json / waiting.json / events.jsonl / Git 现场；契约测试
 * 则防止后续新增状态时只改页面、不补可复现场景。
 */

export const WORKBENCH_STATUSES = [
  "queued",
  "running",
  "pausing",
  "paused",
  "waiting_for_human",
  "coordinating",
  "completed",
  "verifying",
  "await_merge",
  "canceled",
  "failed",
] as const;

export type WorkbenchStatus = typeof WORKBENCH_STATUSES[number];

export interface WorkbenchUiScenario {
  key: string;
  title: string;
  status: WorkbenchStatus;
  purpose: string;
  checkpoints: string[];
  actions: string[];
}

// 动作名即界面上的字样(2026-09-06 逐个对照 web/src 核过):三个视图叫
// 「当前 / 材料 / 工作过程」,材料工具条上的检视入口叫「检视意见」。
const stableActions = ["当前", "材料", "工作过程", "检视意见"];

export const WORKBENCH_UI_SCENARIOS: readonly WorkbenchUiScenario[] = [
  {
    key: "queued",
    title: "排队中的任务",
    status: "queued",
    purpose: "核对队列位置、责任人和无须介入的平静状态",
    checkpoints: ["当前摘要", "队列位次", "材料空态", "工作过程空态"],
    actions: [...stableActions, "暂停", "取消"],
  },
  {
    key: "running-rich",
    title: "Agent 正在实现",
    status: "running",
    purpose: "覆盖进度、长说明、工具事件、知识、Token、预热和执行方案",
    checkpoints: ["运行焦点", "阶段方案", "长文分层", "原始事件", "任务上下文", "模型用量", "运行环境"],
    actions: [...stableActions, "开工前编译", "补充给 Agent", "暂停", "取消", "点击进度条阶段（阶段方案弹层）"],
  },
  {
    key: "pausing",
    title: "正在安全暂停",
    status: "pausing",
    purpose: "覆盖控制动作尚未落定的过渡态",
    checkpoints: ["暂停进度", "控制反馈", "只读工作过程"],
    actions: [...stableActions, "取消"],
  },
  {
    key: "paused-assistant",
    title: "现场已暂停并由开发助手接管",
    status: "paused",
    purpose: "覆盖恢复、交还、人工接管和跨仓同步入口",
    checkpoints: ["暂停焦点", "协作区默认展开", "助手占场说明"],
    actions: [...stableActions, "恢复", "交回给 Agent", "发送", "取消"],
  },
  {
    key: "requirement-decision",
    title: "确认需求原文",
    status: "waiting_for_human",
    purpose: "覆盖证据与单一决定同屏",
    checkpoints: ["需求原文预览", "决定背景", "单一主按钮"],
    actions: [...stableActions, "搜索", "全屏查看", "需求已确认，进入需求分析"],
  },
  {
    key: "long-form-decision",
    title: "多问题与长说明决策",
    status: "waiting_for_human",
    purpose: "覆盖 Agent 大段前言、多道选择题与自定义答复",
    checkpoints: ["长前言折叠", "多问题", "开放题", "自定义答复"],
    actions: [...stableActions, "Agent 对方案的说明", "自定义答复", "提交决定"],
  },
  {
    key: "chain-decision",
    title: "确认模块拆分与依赖",
    status: "waiting_for_human",
    purpose: "覆盖跨仓图、执行人、单号和拆分决定",
    checkpoints: ["模块图", "依赖边", "人员分配", "子任务入口"],
    actions: [...stableActions, "对整体方案提意见", "批注", "确认拆分并继续", "提交决定"],
  },
  {
    key: "push-review",
    title: "推送前检视代码与批注",
    status: "waiting_for_human",
    purpose: "覆盖 Git Diff、批注四态、邀请与检视筛选",
    checkpoints: ["代码目录", "双栏 Diff", "改动浏览", "批注四态", "MR 意见", "机器告警"],
    actions: [
      ...stableActions,
      "搜索", "全屏查看", "邀请他人检视", "等我确认", "Agent 处理中", "已完成",
      "看全部改动", "专注审阅", "折叠全部目录", "缩小 Git 字号", "放大 Git 字号",
      "行批注", "确认推送", "需要调整代码", "发送并继续修改",
    ],
  },
  {
    key: "coordinating",
    title: "跨仓子任务协同中",
    status: "coordinating",
    purpose: "覆盖父子任务、依赖关系与整体进度",
    checkpoints: ["主任务焦点", "子任务状态", "依赖图", "阻塞关系"],
    actions: [...stableActions, "查看子任务", "取消"],
  },
  {
    key: "verifying-live",
    title: "流水线验证中",
    status: "verifying",
    purpose: "覆盖机器正常推进且用户无需动作的状态",
    checkpoints: ["验证焦点", "流水线进度", "Build-Fix 状态"],
    actions: [...stableActions, "暂停", "取消"],
  },
  {
    key: "verifying-stalled",
    title: "流水线证据不足，等待补证",
    status: "verifying",
    purpose: "覆盖失败原文、证据缺口、诊断包和重跑",
    checkpoints: ["缺失维度", "失败原文", "补证材料", "停机行动"],
    actions: [...stableActions, "回灌报错", "重跑续推", "导出诊断包", "取消"],
  },
  {
    key: "scope-violation",
    title: "交付范围越界待裁决",
    status: "verifying",
    purpose: "覆盖负责文件面越界的人工作业",
    checkpoints: ["越界路径", "负责范围", "裁决权限"],
    actions: [...stableActions, "放行,随本单元交付", "打回,撤出越界改动", "重新尝试交付", "导出诊断包", "取消"],
  },
  {
    key: "await-merge",
    title: "等待检视与合入",
    status: "await_merge",
    purpose: "覆盖 MR 链接、外部责任和合入等待",
    checkpoints: ["MR 状态", "合入责任", "检视意见"],
    actions: [...stableActions, "打开合入请求", "取消"],
  },
  {
    key: "failed",
    title: "任务执行失败",
    status: "failed",
    purpose: "覆盖失败原因、诊断与重新开始",
    checkpoints: ["失败焦点", "错误长文", "历史仍可读"],
    actions: [...stableActions, "导出诊断包", "重跑续推", "删除任务", "确认删除"],
  },
  {
    key: "completed",
    title: "任务已完成",
    status: "completed",
    purpose: "覆盖终态、交付材料、用量与删除确认",
    checkpoints: ["完成焦点", "末段进度", "交付记录", "只读批注"],
    actions: [...stableActions, "全屏查看", "打包下载", "删除任务", "确认删除"],
  },
  {
    key: "canceled",
    title: "任务已取消",
    status: "canceled",
    purpose: "覆盖停止说明、只读现场和删除确认",
    checkpoints: ["取消焦点", "保留材料", "禁止新增批注"],
    actions: [...stableActions, "删除任务", "确认删除"],
  },
] as const;

export const WORKBENCH_GLOBAL_CHECKPOINTS = [
  "深夜主题",
  "云昼主题",
  "舒适密度",
  "紧凑密度",
  "1440px 桌面",
  "900px 窄桌面",
  "390px 手机",
  "Alt+1/2/3 视图快捷键",
  "Alt+R 检视快捷键",
  "Escape 分层退出",
  "空态",
  "加载态",
  "接口失败态",
  "责任人权限",
  "受邀检视人权限",
  "只读旁观权限",
] as const;
