/**
 * 生成一套可以跨重启重复使用的任务工作台现场。
 *
 * 默认只在 .ui-fixtures 不存在时生成；日常 `npm run ui:preview` 直接沿用。
 * 需要回到标准样本时显式执行 `npm run ui:fixtures:reset`。
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { LocalAuth } from "../src/auth.ts";
import { FeedbackStore } from "../src/feedbackStore.ts";
import { ReviewStore } from "../src/reviews.ts";
import {
  WORKBENCH_UI_SCENARIOS,
  type WorkbenchStatus,
} from "./ui-workbench-scenarios.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
const force = process.argv.includes("--force");
const requested = process.argv.find((value, index) => index > 1
  && value !== "--force");
const dataDir = resolve(repositoryRoot, requested ?? ".ui-fixtures");

if (dataDir === repositoryRoot
    || !dataDir.startsWith(repositoryRoot + sep)) {
  throw new Error("UI fixture 目录必须是当前仓库内的独立子目录");
}
if (existsSync(join(dataDir, "auth.json")) && !force) {
  console.log(`[ui-fixtures] 沿用现有场景：${dataDir}`);
  console.log("[ui-fixtures] 需要恢复标准数据时运行 npm run ui:fixtures:reset");
  process.exit(0);
}
if (force && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const auth = new LocalAuth(join(dataDir, "auth.json"));
auth.bootstrapAdmin("admin", "mae-flow-demo");
auth.createUser("dev", "mae-flow-demo", "developer", "林知远");
auth.createUser("reviewer", "mae-flow-demo", "developer", "周谨");
auth.createUser("observer", "mae-flow-demo", "developer", "陈默");
auth.setCommitter("reviewer", true);

const now = Date.now();
const iso = (minutesAgo = 0) => new Date(now - minutesAgo * 60_000).toISOString();
const phases = ["启动", "澄清需求", "定规格", "写设计", "写代码", "检视与验证", "已合入"];

function progress(index: number, step: string) {
  return {
    phases,
    current_index: index,
    current_phase: phases[Math.max(0, Math.min(index, phases.length - 1))],
    step_id: `fixture-step-${index}`,
    step,
    revision: 7,
  };
}

function waitingRecord(
  taskId: string,
  step: string,
  questions: Array<{ question: string; options?: string[] }>,
  context: string,
  preface?: string,
) {
  const waitingId = `${taskId}:fixture-waiting`;
  return {
    waiting_id: waitingId,
    task_id: taskId,
    step,
    call_id: "fixture-waiting",
    question: { questions },
    context,
    ...(preface ? { preface } : {}),
    state_version: 1,
    status: "waiting",
    decision: "",
    notes: "",
    created_at: iso(42),
    resolved_at: "",
    reminders: 0,
  };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function writeJsonl(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function seedDocuments(cwd: string, ticket: string, variant: string) {
  const root = join(cwd, ".mae-flow-work", ticket);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".ticket-id"), ticket + "\n");
  writeFileSync(join(root, "spec.md"), [
    `# ${ticket} 规格说明`,
    "",
    "## 要解决的问题",
    "开发者进入任务后，需要立即读懂当前状态、下一步和责任方。",
    "",
    "## 体验约束",
    "- 正常推进时保持安静，不用日志制造忙碌感。",
    "- 需要决定时，把真正相关的证据和动作放在同一屏。",
    "- 长说明先给结论，再按需展开原文和审计记录。",
    "",
    `> 场景标识：${variant}`,
    "",
  ].join("\n"));
  writeFileSync(join(root, "design.md"), [
    `# ${ticket} 交互设计`,
    "",
    "## 信息层级",
    "1. 当前：回答现在发生了什么、是否需要我处理。",
    "2. 产物：完整阅读、搜索、对比和圈选批注。",
    "3. 活动：先展示人的阶段摘要，原始事件按需展开。",
    "",
    "## 验收",
    "所有动作都必须有成功、失败、无权限和处理中反馈。",
  ].join("\n"));
}

function seedGit(cwd: string): { base: string; head: string } {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Mae-Flow Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Mae-Flow Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main", cwd], { env });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "workspace.ts"), [
    "export function workspaceHeadline(status: string) {",
    "  return `任务状态：${status}`;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(cwd, "README.md"), "# Workbench fixture\n");
  execFileSync("git", ["-C", cwd, "add", "."], { env });
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "fixture: baseline"], { env });
  const base = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    env, encoding: "utf-8",
  }).trim();
  writeFileSync(join(cwd, "src", "workspace.ts"), [
    "export interface WorkspaceFocus {",
    "  headline: string;",
    "  nextAction: string;",
    "}",
    "",
    "export function workspaceHeadline(status: string): WorkspaceFocus {",
    "  return {",
    "    headline: `任务状态：${status}`,",
    "    nextAction: status === 'waiting_for_human' ? '请核对后决定' : '无需介入',",
    "  };",
    "}",
    "",
  ].join("\n"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "workspace.test.ts"), [
    "import { workspaceHeadline } from '../src/workspace';",
    "",
    "console.assert(workspaceHeadline('running').nextAction === '无需介入');",
    "",
  ].join("\n"));
  execFileSync("git", ["-C", cwd, "add", "."], { env });
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "feat: clarify workspace focus"], { env });
  const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    env, encoding: "utf-8",
  }).trim();
  writeFileSync(join(cwd, "src", "workspace.ts"),
    readWorkspaceWithPendingPolish());
  return { base, head };
}

function readWorkspaceWithPendingPolish(): string {
  return [
    "export interface WorkspaceFocus {",
    "  headline: string;",
    "  nextAction: string;",
    "}",
    "",
    "export function workspaceHeadline(status: string): WorkspaceFocus {",
    "  const waiting = status === 'waiting_for_human';",
    "  return {",
    "    headline: `任务状态：${status}`,",
    "    nextAction: waiting ? '请核对证据后决定' : '无需介入',",
    "  };",
    "}",
    "",
  ].join("\n");
}

function eventRows(taskId: string) {
  return [
    { eventId: 1, taskId, sessionId: "main", ts: iso(31),
      kind: "session_started", payload: { resume: false } },
    { eventId: 2, taskId, sessionId: "main", ts: iso(29),
      kind: "assistant_message", payload: { text: "我先核对现有工作台的状态来源和交互边界，避免把展示问题误当成流程问题。" } },
    { eventId: 3, taskId, sessionId: "main", ts: iso(27),
      kind: "tool_requested", payload: { call_id: "read-1", name: "Read", input: { file_path: "src/workspace.ts" } } },
    { eventId: 4, taskId, sessionId: "main", ts: iso(26),
      kind: "tool_output", payload: { name: "Read", text: "读取 18 行", log_path: "logs/read-1.log" } },
    { eventId: 5, taskId, sessionId: "main", ts: iso(26),
      kind: "tool_finished", payload: { call_id: "read-1", name: "Read", input: { file_path: "src/workspace.ts" }, is_error: false, result: "读取完成" } },
    { eventId: 6, taskId, sessionId: "main", ts: iso(19),
      kind: "assistant_message", payload: { text: "结论：一级结构只需要当前、产物、活动。协作、邀请与审计仍然完整保留，但应该在用户真正需要它们时出现。下面继续验证等待决定与长文阅读。" } },
    { eventId: 7, taskId, sessionId: "main", ts: iso(16),
      kind: "tool_requested", payload: { call_id: "test-1", name: "Bash", input: { command: "npm test -- workspace" } } },
    { eventId: 8, taskId, sessionId: "main", ts: iso(14),
      kind: "tool_finished", payload: { call_id: "test-1", name: "Bash", input: { command: "npm test -- workspace" }, is_error: false, result: "78 tests passed" } },
  ];
}

function baseSummary(
  id: string,
  title: string,
  status: WorkbenchStatus,
  workspace: string,
  cwd: string,
  ticket: string,
) {
  return {
    id,
    ui_fixture: true,
    title,
    requirement: [
      `# ${title}`,
      "",
      "作为一名对效率和信息质量都很挑剔的开发者，我希望三秒内判断是否需要介入。",
      "",
      "## 验收标准",
      "- 当前状态、下一步和责任方清楚",
      "- 证据和决定同屏，长文按需展开",
      "- 材料、批注、接管、日志与审计能力完整保留",
    ].join("\n"),
    status,
    created_at: iso(180),
    updated_at: iso(4),
    last_progress_at: iso(7),
    workspace,
    luban_account: "dev",
    lane: "完整开发",
    ticket,
    host_skills_pinned: true,
    repository_profiles: [{ name: "mae-flow-cloud", url: "fixture://mae-flow-cloud",
      branch: "main", language: "TypeScript", build: "npm test" }],
    repositories: ["fixture://mae-flow-cloud"],
    progress: progress(0, "准备任务现场"),
    detail: "工作台视觉回归固定场景",
  } as Record<string, unknown>;
}

function applyScenario(
  key: string,
  id: string,
  summary: Record<string, unknown>,
  git: { base: string; head: string } | undefined,
) {
  const longPreface = [
    "# 交互边界核对",
    "",
    "我已经完成现状梳理。先给结论：当前实现可以继续推进，但有三处约束需要你明确。",
    "",
    "## 已确认的事实",
    "",
    "- 旧数据和旧任务必须继续可读。",
    "- 后端流程、权限和审计语义保持不变。",
    "- 当前、产物、活动是三种不同的信息任务。",
    "- 原始 Agent 输出属于审计材料，不是默认阅读界面。",
    "",
    "## 仍需决定",
    "",
    "1. 移动端是否把决定动作前置。",
    "2. Agent 原始输出默认如何展开。",
    "3. 是否还有必须保留的操作习惯。",
    "",
    "## 影响范围",
    "",
    "以下问题会影响最终交互，但不会改变后端流程和权限。完整分析、权衡与失败路径均保留在活动视图中。",
    "",
    "## 回退原则",
    "",
    "如果证据不足，界面宁可明确提示需要核对，也不替用户猜测或自动提交。",
  ].join("\n");
  if (key === "queued") Object.assign(summary, {
    queue_position: 3,
    progress: progress(0, "等待执行资源"),
    detail: "前面还有 2 个任务，轮到后自动开始",
  });
  if (key === "running-rich") Object.assign(summary, {
    progress: progress(4, "重构任务工作台布局与阅读层级"),
    baseline_build: { status: "passed", sha: git?.base ?? "a".repeat(40),
      detail: "基线编译与 1437 项测试通过", build_command: "npm test",
      started_at: iso(65), finished_at: iso(58) },
    repository_skills: [{ repository: "mae-flow-cloud", path: ".agents/frontend/SKILL.md",
      digest: "fixture-skill", bytes: 1200, description: "前端体验与可访问性约束" }],
    detail: "Agent 正在写代码；正常推进无需盯日志",
  });
  if (key === "pausing") Object.assign(summary, {
    progress: progress(4, "正在保存现场并释放执行资源"),
    control: { last_action: "pause", actor: "dev", at: iso(1), paused_from: "running" },
    detail: "正在安全暂停，已完成的产物不会丢失",
  });
  if (key === "paused-assistant") Object.assign(summary, {
    progress: progress(4, "现场已暂停"),
    assistant_engaged: true,
    control: { last_action: "pause", actor: "dev", at: iso(18), paused_from: "running" },
    detail: "开发助手正在使用现场；完成后交还主任务",
    cross_repository_updates: [{ id: "sync-1", parent_task_id: "task-9",
      source_task_id: id, source_repository: "mae-flow-cloud", author: "reviewer",
      text: "公共类型已经收口，依赖仓可按新字段继续。", target_task_ids: ["task-9"], created_at: iso(12) }],
  });
  if (key === "requirement-decision") Object.assign(summary, {
    requirement_analysis_confirmation_required: true,
    progress: progress(1, "确认需求原文"),
    waiting: waitingRecord(id, "cloud_requirement_analysis_confirm", [
      { question: "需求原文是否已经确认？", options: ["需求已确认，进入需求分析"] },
    ], "请核对左侧原文；需要修改可直接圈选并写批注。"),
    detail: "等待负责人确认需求原文",
  });
  if (key === "long-form-decision") Object.assign(summary, {
    progress: progress(2, "确认交互边界"),
    waiting: waitingRecord(id, "config_confirm", [
      { question: "移动端是否把决定卡放在阅读材料之前？", options: ["是，动作优先", "否，证据优先"] },
      { question: "Agent 原始输出默认如何展示？", options: ["默认折叠，审计时展开", "始终完整展开"] },
      { question: "还有必须保留的操作习惯吗？" },
    ], "三项选择共同决定工作台的默认阅读节奏。", longPreface),
    detail: "等待负责人确认交互边界",
  });
  if (key === "chain-decision") Object.assign(summary, {
    requirement_analysis_requested: true,
    progress: progress(2, "确认模块拆分"),
    requirement_graph: {
      stage: "analysis", projection_state: "ready", plan_revision: "fixture-r3",
      repositories: [
        { id: "cloud", name: "mae-flow-cloud", url: "fixture://cloud",
          responsibility: "任务编排与工作台", scope: { name: "Cloud 前端", paths: ["web/src/**"] }, assignee: "dev", ticket: "REQ-UI-301" },
        { id: "kernel", name: "mae-flow", url: "fixture://kernel",
          responsibility: "阶段真相与执行方案", scope: { name: "内核协议", paths: ["flow/**", "scripts/**"] }, assignee: "reviewer", ticket: "REQ-UI-302" },
        { id: "docs", name: "design-system", url: "fixture://design-system",
          responsibility: "视觉基线与组件约束", scope: { name: "设计系统", paths: ["tokens/**", "patterns/**"] }, assignee: "dev", ticket: "REQ-UI-303" },
      ],
      dependencies: [
        { from: "cloud", to: "kernel", reason: "界面只消费内核阶段真相" },
        { from: "cloud", to: "docs", reason: "视觉规则来自统一基线" },
      ],
    },
    waiting: waitingRecord(id, "requirement_chain_confirm", [
      { question: "按当前模块与依赖拆分执行吗？", options: ["确认拆分并继续", "需要调整方案"] },
    ], "确认后系统会按依赖顺序创建子任务。"),
    detail: "等待确认模块拆分与执行人",
  });
  if (key === "push-review" && git) Object.assign(summary, {
    progress: progress(5, "检视本次修改与交付范围"),
    baseline: git.base,
    push_confirmation: true,
    waiting: waitingRecord(id, "cloud_push_confirm", [
      { question: "是否推送当前改动？", options: ["确认推送", "需要调整代码"] },
    ], "核对变更、批注和将推送文件；未跟踪产物不会自动进入交付。"),
    delivery: {
      mr_url: "https://code.example.test/mae-flow/merge_requests/128",
      mr_state: "推送前检视",
      waiting_on: "等待负责人核对本次修改",
      push_review: { kind: "delivery", title: "本次修改", description: "工作台信息架构重构",
        base_sha: git.base, baseline_sha: git.base, head_sha: git.head,
        has_focused_changes: true, file_count: 2, additions: 18, deletions: 3,
        commits: [{ sha: git.head, subject: "feat: clarify workspace focus" }],
        all_paths: ["src/workspace.ts", "tests/workspace.test.ts"],
        committed_paths: ["src/workspace.ts", "tests/workspace.test.ts"],
        agent_note: longPreface, verification: "类型检查与交互契约通过" },
    },
    detail: "等待负责人完成推送前检视",
  });
  if (key === "push-review" && summary.waiting) Object.assign((summary.waiting as ReturnType<typeof waitingRecord>).question, { delivery_files: [
    { path: "src/workspace.ts", label: "修改" }, { path: "tests/workspace.test.ts", label: "新增" },
  ] });
  if (key === "coordinating") Object.assign(summary, {
    progress: progress(4, "两个交付单元并行推进"),
    // 候选仓必须与拆分出的模块一致:原来只有 1 个候选仓却拆出 2 个模块,
    // 依赖图组件按候选仓数判"不必展示",工作台的「模块与依赖」一片空白。
    repositories: ["fixture://frontend", "fixture://quality"],
    collaborators: ["reviewer"],
    requirement_graph: {
      stage: "confirmed", projection_state: "ready", plan_revision: "fixture-parent",
      repositories: [
        { id: "frontend", name: "前端工作台", url: "fixture://frontend",
          responsibility: "信息架构与交互", task_id: "task-2", assignee: "dev",
          task_status: "running", current_phase: "写代码" },
        { id: "quality", name: "质量基线", url: "fixture://quality",
          responsibility: "场景与回归", task_id: "task-10", assignee: "reviewer",
          task_status: "verifying", current_phase: "检视与验证" },
      ],
      dependencies: [{ from: "quality", to: "frontend", reason: "实现完成后执行全场景验收" }],
    },
    detail: "2 个交付单元正在推进，完成后自动收口",
  });
  // 跨仓父任务 task-9 的两个交付单元:列表要能看出层级(缩进+连线)。
  if (key === "running-rich" || key === "verifying-live") {
    Object.assign(summary, { parent_task_id: "task-9" });
  }
  if (key === "verifying-live") Object.assign(summary, {
    progress: progress(5, "流水线正在核对当前提交"),
    delivery: { mr_url: "https://code.example.test/mae-flow/merge_requests/129",
      mr_state: "验证中", pipeline: "running · 6/9 检查完成",
      waiting_on: "等待单元测试与 CodeCheck 返回",
      prepush: { state: "testing", round: 1, message: "运行单元测试与静态检查", sha: git?.head, updated_at: iso(2) } },
    detail: "验证自动推进中，无需人工介入",
  });
  if (key === "verifying-stalled") Object.assign(summary, {
    progress: progress(5, "流水线证据不足"),
    delivery: { mr_url: "https://code.example.test/mae-flow/merge_requests/130",
      mr_state: "验证停机", pipeline: "failed · COMPILE 证据缺失",
      waiting_on: "需要补充编译失败原文",
      stalled: "流水线连续三次未返回可核销的编译日志",
      evidence_gap: { sha: git?.head ?? "b".repeat(40), state: "waiting_human",
        missing_dimensions: ["COMPILE"], available_dimensions: ["UT", "CODECHECK"],
        reasons: ["编译 Job 只返回了状态，没有失败日志", "现有摘要不足以定位到模块"], attempts: 3, notified_at: iso(8) },
      loop: { round: 3, max: 3, state: "halted", kind: "ci",
        diagnosis: "缺少可执行失败原文，自动修改可能误伤业务代码",
        failure: "Compile job failed: artifact log was not uploaded" } },
    detail: "自动修复已停，需要补充证据或接管",
  });
  if (key === "scope-violation") Object.assign(summary, {
    progress: progress(5, "交付范围门禁"),
    delivery_scope: { name: "工作台前端", paths: ["web/src/**", "tests/*Workspace*.test.ts"] },
    delivery: { waiting_on: "等待主任务责任人裁决越界文件",
      stalled: "本单元修改超出确认的负责文件面",
      scope_violation: { paths: ["src/taskService.ts", "package.json"], noted_at: iso(9) } },
    detail: "发现 2 个越界文件，已停止交付",
  });
  if (key === "await-merge") Object.assign(summary, {
    progress: progress(5, "等待 CodeHub 检视与合入"),
    delivery: { mr_url: "https://code.example.test/mae-flow/merge_requests/131",
      mr_state: "已开放", pipeline: "success", waiting_on: "等待 reviewer 完成检视并合入" },
    detail: "代码与流水线均已就绪，等待外部合入",
  });
  if (key === "failed") Object.assign(summary, {
    progress: progress(4, "执行环境初始化失败"),
    detail: "统一任务容器启动失败：镜像缺少非 root builder 用户。任务从未开始写代码，可修复环境后从头重跑。",
  });
  if (key === "completed") Object.assign(summary, {
    progress: progress(6, "全部交付完成"),
    completed_at: iso(22),
    memories_recorded: 3,
    delivery: { mr_url: "https://code.example.test/mae-flow/merge_requests/127",
      mr_state: "已合入", pipeline: "success" },
    detail: "改动已合入，材料、批注和活动记录已归档",
  });
  if (key === "canceled") Object.assign(summary, {
    progress: progress(3, "用户主动停止"),
    completed_at: iso(35),
    control: { last_action: "cancel", actor: "dev", at: iso(35), paused_from: "running" },
    detail: "任务已由责任人停止；此前产物和审计记录仍可阅读",
  });
}

const reviewStore = new ReviewStore(join(dataDir, "reviews.jsonl"));

for (const [index, scenario] of WORKBENCH_UI_SCENARIOS.entries()) {
  const id = `task-${index + 1}`;
  const ticket = `UI${String(index + 1).padStart(4, "0")}`;
  const workspace = join(dataDir, id);
  const cwd = join(workspace, "origin");
  mkdirSync(cwd, { recursive: true });
  seedDocuments(cwd, ticket, scenario.key);
  const needsGit = ["running-rich", "push-review", "verifying-live",
    "verifying-stalled", "completed"].includes(scenario.key);
  const git = needsGit ? seedGit(cwd) : undefined;
  const summary = baseSummary(
    id, scenario.title, scenario.status, workspace, cwd, ticket);
  applyScenario(scenario.key, id, summary, git);
  const waiting = summary.waiting as ReturnType<typeof waitingRecord> | undefined;
  // 阶段真相只在工作区:服务端从 .mae-flow-work/panel-pulse.js 投影进度,
  // task.json 里的 progress 不算数。没有脉冲的单仓任务一律占位到「启动」,
  // 用户在演示数据上看到"验证中的任务进度条停在启动"(2026-09-06)。
  // 不写 step id:假 id 会撞上按步骤名判断的契约。
  const progressSnapshot = summary.progress as
    { current_phase: string; step?: string; revision?: number } | undefined;
  if (progressSnapshot && !summary.requirement_graph) {
    mkdirSync(join(cwd, ".mae-flow-work"), { recursive: true });
    writeFileSync(join(cwd, ".mae-flow-work", "panel-pulse.js"),
      `window.__maeFlowPulse = ${JSON.stringify({
        phase: progressSnapshot.current_phase,
        step_title: progressSnapshot.step ?? "",
        revision: progressSnapshot.revision ?? 7,
      })};\n`);
  }
  writeJson(join(workspace, "task.json"), {
    summary,
    cwd,
    token_usage_state: scenario.key === "running-rich" || scenario.key === "completed"
      ? { schema: "mae-flow-token-usage/1", input_tokens: 184320,
          output_tokens: 28740, updated_at: iso(1),
          recent: [{ input_tokens: 1260, output_tokens: 430, at: iso(0) }] }
      : { schema: "mae-flow-token-usage/1", input_tokens: 0,
          output_tokens: 0, recent: [] },
  });
  if (waiting) {
    writeJson(join(workspace, "waiting.json"), {
      records: { [waiting.waiting_id]: waiting },
    });
  }
  writeJsonl(join(workspace, "events.jsonl"), eventRows(id));

  if (scenario.key === "running-rich") {
    writeJsonl(join(workspace, "knowledge-events.jsonl"), [
      { id: "knowledge-1", task_id: id, kind: "repository_skill",
        name: "前端体验约束", path: ".agents/frontend/SKILL.md",
        repository: "mae-flow-cloud", selected: true, ts: iso(24),
        session_id: "main", session_role: "main", action: "read",
        observed_path: ".agents/frontend/SKILL.md" },
    ]);
  }

  if (scenario.key === "push-review") {
    const annotations = new AnnotationStore(join(workspace, "annotations.jsonl"));
    annotations.add({ author: "dev", artifact: "__workspace_diff__",
      file: "src/workspace.ts", line: 9, anchor: "headline: `任务状态：${status}`",
      note: "状态标题需要保留业务语气，不能直接暴露枚举值。", kind: "code" });
    const fixed = annotations.add({ author: "reviewer", artifact: "__workspace_diff__",
      file: "src/workspace.ts", line: 11, anchor: "nextAction: waiting",
      note: "下一步文案要告诉用户为什么需要介入。", kind: "code" });
    annotations.markSent([fixed.id], "review_repair", "reviewer");
    annotations.respond(fixed.id, { outcome: "fixed",
      summary: "已把动作改成“请核对证据后决定”，并补充等待条件。",
      evidence: ["src/workspace.ts:11"], fixed_sha: git?.head });
    const clarified = annotations.add({ author: "dev", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 7, anchor: "长文按需展开",
      note: "请明确多长算长文，以及默认展示多少。", kind: "doc" });
    annotations.markSent([clarified.id], "queued_decision", "dev");
    annotations.respond(clarified.id, { outcome: "needs_clarification",
      summary: "建议以信息任务而不是字数为边界：结论常显，论证与原文折叠。",
      evidence: [] });
    const closed = annotations.add({ author: "dev", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 6, anchor: "证据和决定同屏",
      note: "决定卡旁必须能看到对应证据。", kind: "doc" });
    annotations.markSent([closed.id], "decision", "dev");
    annotations.respond(closed.id, { outcome: "fixed", summary: "已加入证据预览。",
      evidence: ["web/src/TaskWorkspace.tsx"], fixed_sha: git?.head });
    annotations.verify(closed.id, "dev");

    const feedback = new FeedbackStore(join(workspace, "feedback", "index.jsonl"));
    feedback.upsert([
      { id: "fb-mr-1", batch_id: "fixture-mr", source: "mr_discussion",
        source_id: "discussion-18", source_revision: 0,
        observed_sha: git?.head ?? "c".repeat(40),
        summary: "移动端检视入口不应被挤成竖排。", material: "MR !128",
        file: "web/src/task-workspace.css", line: 950, author: "周谨",
        verification: "390px 下入口为图标按钮且可访问名称完整",
        status: "awaiting_verification", updated_at: iso(6) },
      { id: "fb-ci-1", batch_id: "fixture-ci", source: "pipeline",
        source_id: "CodeCheck", source_revision: 0,
        observed_sha: git?.head ?? "c".repeat(40),
        summary: "主 bundle 超过建议阈值。", material: "pipeline/codecheck.log",
        verification: "后续拆包，不阻塞本轮纯界面重构",
        status: "needs_human", updated_at: iso(5) },
    ]);

    const invitation = reviewStore.create({ taskId: id, taskTitle: scenario.title,
      requester: "dev", committer: "reviewer" });
    reviewStore.delivery(invitation.id, { delivered: true, attempts: 1 });
  }
}

writeFileSync(join(dataDir, ".task-sequence"),
  `${WORKBENCH_UI_SCENARIOS.length}\n`, { mode: 0o600 });
writeJson(join(dataDir, "ui-scenarios.json"), {
  schema: "mae-flow-ui-workbench-scenarios/1",
  generated_at: new Date(now).toISOString(),
  accounts: ["dev", "reviewer", "observer", "admin"],
  password: "mae-flow-demo",
  scenarios: WORKBENCH_UI_SCENARIOS.map((scenario, index) => ({
    task_id: `task-${index + 1}`,
    ...scenario,
  })),
});

console.log(`[ui-fixtures] 已生成 ${WORKBENCH_UI_SCENARIOS.length} 个工作台场景`);
console.log(`[ui-fixtures] 数据目录：${dataDir}`);
console.log("[ui-fixtures] 预览：npm run ui:preview");
console.log("[ui-fixtures] 登录：dev / mae-flow-demo");
