/**
 * 下单表单(口径 2026-08-18 按内网实战重定):
 * - **交付仓必填**,没有"默认仓"这回事——一个部署服务很多个仓,
 *   默认值只会让人漏看一眼就把单下错地方;
 * - **模型不给选**:管理员统一配一个,表单只显示"这单用谁跑";
 *   管理员贴完 models.json 即自动生效(不必再手打一遍 provider/model);
 * - 车道与修复轮预算仍按单可选;
 * - **配置没配齐不给下单**:服务级(模型/平台/通知)+ 个人级
 *   (Git 令牌/通知令牌)缺一样都 409,前端把缺项摆明面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { Notifier } from "../src/notifier.ts";
import { RuntimeSettings } from "../src/settings.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import {
  TaskService,
  createRequirementAnalysisGateContract,
} from "../src/taskService.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { createTaskServer } from "../src/server.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import {
  createBusinessModule,
  publishBusinessKnowledgeAsset,
} from "../src/businessModuleLibrary.ts";
import { writeRequirementArtifacts } from "./requirementGraphFixture.ts";
import { mfcTemp } from "./mfcTmp.ts";

const SCRIPT: Scene[] = [{ text: "完成。" }];

test("代码仓不可选时必须解释部署原因；正式多仓模式保持可填写", () => {
  const base = { dataDir: mfcTemp("mfc-repo-availability-"),
    maxConcurrent: 0, provider: "test", model: "test", modelsJson: {} };
  const demo = new TaskService(base).launchOptions().repo;
  assert.equal(demo.enabled, false);
  assert.match(demo.disabled_reason ?? "", /kernel-mode/);
  const issue = new TaskService({ ...base, requirementDisabled: true })
    .launchOptions().repo;
  assert.match(issue.disabled_reason ?? "", /仅启用了问题处理/);
  const kernelRoot = discoverKernelRoot(process.cwd())!;
  const pinned = new TaskService({ ...base,
    host: { kernelRoot, repoPath: "/tmp/fixed-repository", repoPinned: true },
  }).launchOptions().repo;
  assert.equal(pinned.enabled, false);
  assert.match(pinned.disabled_reason ?? "", /移除固定 repo 参数/);
  const normal = new TaskService({ ...base, host: { kernelRoot } })
    .launchOptions().repo;
  assert.deepEqual(normal, { enabled: true, required: true });
});

test("launch-options:生效模型来自 models.json,设置层压部署层", () => {
  const dataDir = mfcTemp("mfc-lf-");
  const settings = new RuntimeSettings(dataDir);
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1",
    modelsJson: { providers: {
      a: { models: [{ id: "a-1" }, { id: "a-2" }] },
      b: { models: [{ id: "b-1" }] },
    } },
    delivery: { platformUrl: "http://x", repairRounds: 3 },
    settings,
  });
  const before = service.launchOptions();
  assert.deepEqual(before.model, { provider: "a", model: "a-1" });
  assert.equal(before.repair_rounds, 3);

  // 设置层热改:生效模型与预算跟着走
  settings.updateModels({
    json: { providers: { c: { models: [{ id: "c-1" }] } } },
    provider: "c", model: "c-1",
  });
  settings.updateRuntime({ repair_rounds: 0 });
  const after = service.launchOptions();
  assert.deepEqual(after.model, { provider: "c", model: "c-1" });
  assert.equal(after.repair_rounds, 0);
});

test("下单审计同时记输入值、生效值与来源，不把需求全文刷进日志", () => {
  const dataDir = mfcTemp("mfc-lf-audit-");
  const settings = new RuntimeSettings(dataDir);
  settings.updateRuntime({ repair_rounds: 3 });
  const logs: string[] = [];
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    delivery: { platformUrl: "http://x", repairRounds: 5 },
    settings,
    log: (message) => logs.push(message),
  });
  const requirement = "AUDIT_SECRET_REQUIREMENT 调整订单状态";
  const task = service.create(requirement, {
    title: "订单状态修复", account: "alice", lane: "完整开发",
    repairRounds: 0,
    taskInstructions: "AUDIT_SECRET_INSTRUCTION 不确定时不要猜",
  });
  const auditText = readFileSync(
    join(dataDir, task.id, "creation-audit.json"), "utf-8");
  const audit = JSON.parse(auditText);
  assert.equal(audit.origin, "user_request");
  assert.deepEqual(audit.request.repair_rounds,
    { provided: true, value: 0 });
  assert.deepEqual(audit.effective.repair_rounds, {
    value: 0, source: "task_request", disabled: true, unlimited: false,
  });
  assert.equal(audit.request.requirement.bytes,
    Buffer.byteLength(requirement, "utf-8"));
  assert.match(audit.request.requirement.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!auditText.includes("AUDIT_SECRET_REQUIREMENT"),
    "审计文件只记需求指纹，全文仍以 task.json 为准");
  assert.ok(!auditText.includes("AUDIT_SECRET_INSTRUCTION"),
    "执行补充不得泄入公共诊断日志");
  const log = logs.find((line) => line.startsWith("[task-create] "));
  assert.ok(log, "服务日志必须有可检索的结构化下单记录");
  assert.match(log!, /"source":"task_request"/);
  assert.ok(!log!.includes("AUDIT_SECRET_REQUIREMENT"));

  const inherited = service.create("子任务", {
    parentTaskId: task.id,
    internalRequirement: true,
    repairRounds: task.repair_rounds,
  });
  const childAudit = JSON.parse(readFileSync(
    join(dataDir, inherited.id, "creation-audit.json"), "utf-8"));
  assert.equal(childAudit.origin, "cross_repository_child");
  assert.equal(childAudit.parent_task_id, task.id);
  assert.deepEqual(childAudit.effective.repair_rounds, {
    value: 0, source: "parent_task", disabled: true, unlimited: false,
  });

  const teamDefault = service.create("沿用团队设置");
  const defaultAudit = JSON.parse(readFileSync(
    join(dataDir, teamDefault.id, "creation-audit.json"), "utf-8"));
  assert.deepEqual(defaultAudit.request.repair_rounds,
    { provided: false, value: null });
  assert.deepEqual(defaultAudit.effective.repair_rounds, {
    value: 3, source: "runtime_setting", disabled: false, unlimited: false,
  });
});

test("业务模块目录不返回正文；下单只交 ID，服务端固定当时版本", () => {
  const dataDir = mfcTemp("mfc-lf-module-");
  createBusinessModule(dataDir, {
    id: "orders", name: "订单域", description: "订单创建与履约",
    owner: "owner-a", repositories: ["https://code.example/orders.git"],
  }, "admin");
  publishBusinessKnowledgeAsset(dataDir, "orders", {
    id: "state", title: "状态机", summary: "状态迁移约束",
    when_to_use: "改订单状态时", content: "MODULE_BODY_MUST_NOT_BE_IN_CATALOG",
  }, "owner-a");
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  const options = service.launchOptions();
  assert.deepEqual(options.business_modules.map((item) => ({
    id: item.id, owner: item.owner, assets: item.assets,
    knowledge: item.knowledge,
  })), [{
    id: "orders", owner: "owner-a", assets: 1,
    knowledge: [{
      id: "state", title: "状态机", summary: "状态迁移约束",
      when_to_use: "改订单状态时", form: "document",
      repositories: [], version: 1,
    }],
  }]);
  assert.doesNotMatch(JSON.stringify(options), /MODULE_BODY_MUST_NOT_BE_IN_CATALOG/);

  const task = service.create("调整订单状态", {
    selectedBusinessModuleIds: ["orders"],
  });
  assert.equal(task.business_modules?.[0].revision, 2);
  assert.equal(task.business_modules?.[0].assets[0].version, 1);
  assert.doesNotMatch(JSON.stringify(task), /MODULE_BODY_MUST_NOT_BE_IN_CATALOG/,
    "任务摘要只存版本身份，不存正文");
  assert.match(readFileSync(join(dataDir, task.id,
    task.business_modules![0].assets[0].snapshot_path), "utf-8"),
  /MODULE_BODY_MUST_NOT_BE_IN_CATALOG/);
});

test("同仓并行不按责任人豁免 AR 冲突；失败后重来仍沿用单号", () => {
  // 撞单的真实代价:两单派生同名分支,第二单非快进推送失败烧完预算,
  // 同分支对的 MR 还会被幂等复用互相污染(2026-08-30 审计,"跑挂了
  // 直接重下"是最常见操作)。
  const dataDir = mfcTemp("mfc-lf-dup-");
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  const first = service.create("需求一", {
    ticket: "REQ-9", account: "alice",
  });
  assert.throws(() => service.create("需求一再来一单", {
    ticket: "REQ-9", account: "alice",
  }), (error: unknown) => error instanceof Error
    && error.message.includes(first.id)
    && error.message.includes("同名分支"),
  "在途重复下单必须拒绝并点名旧单");
  // 换责任人也不能让同仓并行任务复用 AR。
  assert.throws(() => service.create("同单号别人下", {
    ticket: "REQ-9", account: "bob",
  }), /同仓并行/);
  // 旧单进入终态后重下是合法的重来。
  (service as any).tasks.get(first.id).summary.status = "failed";
  assert.ok(service.create("重来一单", {
    ticket: "REQ-9", account: "alice",
  }).id);
});

test("多仓撞单门禁按完整 repositories 集合求交,不只比较首仓", () => {
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-multi-dup-"),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const api = "https://codehub/team/api.git";
  const web = "https://codehub/team/web.git";
  const admin = "https://codehub/team/admin.git";
  const docs = "https://codehub/team/docs.git";
  const first = service.create("跨仓需求", {
    ticket: "REQ-MULTI-DUP", account: "alice", repos: [api, web],
  });
  assert.equal(first.repo_url, api, "兼容字段仍是首仓，回归必须覆盖第二仓相交");
  assert.throws(() => service.create("第二仓相撞", {
    ticket: "REQ-MULTI-DUP", account: "alice", repos: [admin, web],
  }), (error: unknown) => error instanceof Error
    && error.message.includes(first.id)
    && error.message.includes("同名分支"),
  "旧任务第二仓与新任务第二仓相交也必须拒绝");
  assert.ok(service.create("仓集合完全不相交", {
    ticket: "REQ-MULTI-DUP", account: "alice", repos: [admin, docs],
  }).id, "完整集合无交集时不应误伤同单号的独立仓交付");
});

test("团队 Skill 进入统一下单目录；普通任务自动固定全部适用版本", () => {
  const dataDir = mfcTemp("mfc-lf-team-skill-");
  for (const [name, marker, language] of [
    ["java-check", "JAVA-CHECK-BODY", "java"],
    ["cpp-check", "CPP-CHECK-BODY", "cpp"],
  ] as const) {
    const directory = join(dataDir, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), [
      "---", `name: ${name}`, `description: ${name} guide`,
      "knowledge_nature: engineering", `technologies: [${language}]`,
      "---", "", marker,
    ].join("\n"));
  }
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  const options = service.launchOptions();
  assert.deepEqual(options.team_skills.map((item) => item.path).sort(),
    ["cpp-check/SKILL.md", "java-check/SKILL.md"]);
  assert.doesNotMatch(JSON.stringify(options), /JAVA-CHECK-BODY|CPP-CHECK-BODY/,
    "下单目录不能返回 Skill 正文");

  const automatic = service.create("采用自动匹配的团队 Skill", {
    repositoryProfiles: [{
      repository: "https://code.example/team/mixed.git",
      technologies: ["java", "cpp"], confirmed: true,
      updated_at: new Date().toISOString(), updated_by: "tester",
    }],
  });
  assert.deepEqual(automatic.team_skills?.map((item) => item.name).sort(),
    ["cpp-check", "java-check"],
  "选择字段缺席时，服务端必须兜底装配全部适用项");
});

test("模型默认自动派生:管理员只贴 models.json 也能直接用", () => {
  // 实测踩到:服务起来后表单是空的,人不知道还差"再手打一遍
  // provider/model"这一步。贴完就该能用——第一个 provider 的第一个
  // 模型即默认,显式配了才压过它。
  const dataDir = mfcTemp("mfc-lf-auto-");
  const settings = new RuntimeSettings(dataDir);
  settings.updateModels({
    json: { providers: { gw: { models: [{ id: "glm-5.1" }, { id: "x" }] } } },
  });
  const service = new TaskService({
    dataDir, provider: "", model: "", modelsJson: {}, settings,
  });
  assert.deepEqual(service.launchOptions().model,
    { provider: "gw", model: "glm-5.1" });
  assert.ok(!service.launchOptions().blockers
    .some((item) => item.key === "model"), "配了就不该再报缺模型");
});

test("配置缺项:只拦真会咬人的那几样,文案说清去哪配", () => {
  // 一刀切的门禁会把用不上那件东西的部署一起挡在门外:纯会话形态
  // (不接代码仓)要什么 Git 令牌?没接通知端点要什么通知令牌?
  // 所以每条缺项都绑自己的前提。
  const dataDir = mfcTemp("mfc-lf-block-");
  const kernel = new TaskService({
    dataDir, provider: "", model: "", modelsJson: {},
    host: { kernelRoot: "/tmp" },   // 接了仓,但没配平台
  });
  const keys = kernel.launchOptions().blockers.map((item) => item.key);
  assert.ok(keys.includes("model"), "没模型任何任务都跑不了,要拦");
  assert.ok(keys.includes("platform"), "内核模式没平台=交付不出去,要拦");
  assert.equal(kernel.launchOptions().needs.git_token, true,
    "接了代码仓就要个人 Git 令牌");
  assert.equal(kernel.launchOptions().needs.luban_token, false,
    "没接通知端点就别要通知令牌");
  // 缺项文案要说清由谁处理、以及不处理会怎样,不能只报一个字段名。
  for (const item of kernel.launchOptions().blockers) {
    assert.ok(/管理页|个人设置|部署维护/.test(item.label) && /；|;/.test(item.label),
      `缺项文案没说清去哪配/后果: ${item.label}`);
  }
  // 纯会话形态(不接仓):平台与 Git 令牌都不该被要求
  const chat = new TaskService({
    dataDir: mfcTemp("mfc-lf-chat-"),
    provider: "gw", model: "m",
    modelsJson: { providers: { gw: { models: [{ id: "m" }] } } },
  });
  assert.deepEqual(chat.launchOptions().blockers, []);
  assert.equal(chat.launchOptions().needs.git_token, false);
});

test("交付方式:选项与默认值都取自内核 flow.json,自造的当场打回", () => {
  // 内网实战逮住的摩擦:表单原来自造"快速/慢速车道",而内核 workflow_select
  // 的选项是 full/hotfix/tweak/review(完整开发/已定位问题修复/局部修改/
  // 处理评审意见)。两套词对不上 → 下单选过的交付方式在流程里又被问一遍。
  // 分类是内核的领地,宿主现读它的定义;这条用例就是防再抄一份的封条。
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核(仓内 kernel/ 快照应随仓自带)");
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-lane-"),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot, repoPath: "/tmp/repo" },
  });
  const workflows = service.launchOptions().workflows;
  // review 不在新单表单里(内核 flow.json 的 new_order_choices:它仅限
  // 已交付单,新单选它必错;检视意见由 MR 修复环自动处理)。
  assert.deepEqual(workflows.map((item) => item.key),
    ["full", "hotfix", "tweak"]);
  assert.equal(workflows.find((item) => item.key === "tweak")!.label,
    "局部修改");
  assert.throws(() => service.create("新单想选评审",
    { repo: "https://x/r.git", ticket: "REQ1", lane: "处理评审意见" }),
    /交付方式只能是/);
  // 不填=内核第一项;自造词打回(免得下单选了个内核不认识的答案)
  assert.equal(service.create("默认交付方式").lane, workflows[0].label);
  assert.equal(service.create("空字符串也使用默认交付方式", { lane: "" }).lane,
    workflows[0].label,
    "旧前端 select 显示默认项却提交空串时不能阻断下单");
  assert.equal(service.create("纯空白也使用默认交付方式", { lane: "   " }).lane,
    workflows[0].label);
  assert.equal(service.create("点名交付方式", { lane: "局部修改" }).lane,
    "局部修改");
  assert.throws(() => service.create("x", { lane: "慢速车道" }),
    /交付方式只能是/);

  // 取值走的是内核**明面上的契约**(steps --json),不是扒 flow.json
  // 的内脏。这条同时兼作收编快照的新鲜度检查:快照旧到没有这个宿主口
  // 就会在这里露馅,而不是等到内网真跑时才发现表单是空的。
  const catalog = JSON.parse(execFileSync("python3",
    [join(kernelRoot, "scripts", "mae-flow.py"), "steps", "--json"],
    { encoding: "utf-8" }).trim().split("\n").pop()!);
  assert.deepEqual(
    catalog.workflows
      .filter((item: { for_new_orders: boolean }) => item.for_new_orders)
      .map((item: { key: string; answers: string[] }) =>
        ({ key: item.key, label: item.answers[0] })),
    workflows.map((item) => ({ key: item.key, label: item.label })),
    "表单选项必须与内核目录(新单可选集)逐字一致");
  // 下单页只讲适用场景，不再拿步数/拍板数让人猜该选哪个。
  const byKey = Object.fromEntries(
    workflows.map((item) => [item.key, item]));
  assert.match(byKey.full.description ?? "", /新功能|较大改动/);
  assert.match(byKey.hotfix.description ?? "", /问题原因.*明确/);
  assert.match(byKey.tweak.description ?? "", /只改一小块/);
  assert.equal(workflows.some((item) =>
    /\d+\s*步|拍板/.test(item.description ?? "")), false);
});

test("文字补充:团队约定+任务补充编译进 supplement-only 定格档并留快照", () => {
  // v1 阶段勾选定制已退役(2026-08-29):想改结构走工作流资产;
  // 文字建议层统一落 workflow_profile.supplements。
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核");
  const dataDir = mfcTemp("mfc-lf-stage-plan-");
  const settings = new RuntimeSettings(dataDir);
  settings.updateExecutionPolicy({
    team_instructions: "不确定的外部行为明确说明",
  });
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot, repoPath: "/tmp/repo" }, settings,
  });
  const task = service.create("验证文字补充", {
    taskInstructions: "先跑完整构建，再开始猜测范围外行为",
  });
  const supplements = task.workflow_profile?.supplements ?? [];
  assert.deepEqual(supplements.map((item) => item.scope), ["team", "task"]);
  assert.equal(supplements[0].instructions, "不确定的外部行为明确说明");
  assert.equal(supplements[1].instructions,
    "先跑完整构建，再开始猜测范围外行为");
  assert.equal(task.workflow_profile?.final_snapshot, undefined,
    "只写补充不许伪造结构化定格");
  settings.updateExecutionPolicy({ team_instructions: "后来改掉的约定" });
  assert.equal(
    (task.workflow_profile?.supplements ?? [])[0].instructions,
    "不确定的外部行为明确说明",
    "任务创建后必须保留当时的团队快照");
});

test("结构化工作流:下单固定唯一最终方案，平台下限不可删且有明确诊断", () => {
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核");
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-workflow-v2-"),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot, repoPath: "/tmp/repo" },
  });
  const standard = service.launchOptions().workflow_standard!;
  assert.equal(standard.standard_id, "mae-flow.standard");
  const task = service.create("使用精确工作流完成任务", {
    workflowDefinition: {
      schema: "mae-flow-workflow-definition/1",
      base: { standard_id: standard.standard_id,
        standard_version: standard.standard_version,
        catalog_digest: standard.catalog_digest },
      applicability: { business_module_ids: [], repositories: [], technologies: [] },
      edits: [
        { edit_id: "remove-code-standard", stage_id: "platform.construction",
          op: "remove", target_id: "code-taste-standard" },
        { edit_id: "remove-push-floor", stage_id: "platform.delivery",
          op: "remove", target_id: "host-git-push" },
      ],
    },
  });
  assert.equal(task.workflow_profile?.source.kind, "task");
  assert.equal(task.workflow_profile?.source.id, task.id);
  assert.equal(task.workflow_profile?.final_snapshot?.stages.find((item) =>
    item.id === "platform.construction")?.items.some((item) =>
      item.id === "code-taste-standard"), false);
  assert.equal(task.workflow_profile?.final_snapshot?.stages.find((item) =>
    item.id === "platform.delivery")?.items.some((item) =>
      item.id === "host-git-push"), true);
  assert.equal(task.workflow_profile?.diagnostics[0].code, "base_item_restored");
  assert.match(task.workflow_profile?.diagnostics[0].fallback ?? "", /保留/);
});

test("单号/基线分支:下单收齐,基线默认 master,纯会话仍保留 AR/REQ 入口", () => {
  // 用户 2026-08-19 拍板:这两项和交付方式一样在表单上一次给完,
  // 不让模型开工后再逐项来问。单号必填与"交付仓必填"同口径;
  // 基线分支给默认 master——多数单就交到 master,少数改一下即可。
  const kernel = new TaskService({
    dataDir: mfcTemp("mfc-lf-ticket-"),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  assert.deepEqual(kernel.launchOptions().ticket,
    { enabled: true, required: true });
  assert.deepEqual(kernel.launchOptions().baseline,
    { enabled: true, default: "master" });
  assert.throws(() => kernel.create("没单号", { repo: "https://x/r.git" }),
    /单号/);
  assert.throws(() => kernel.create("坏单号",
    { repo: "https://x/r.git", ticket: "REQ 123" }), /空白字符/);
  const created = kernel.create("齐活",
    { repo: "https://x/r.git", ticket: "REQ2026001" });
  assert.equal(created.ticket, "REQ2026001");
  assert.equal(created.baseline, "master", "不填基线就默认 master");
  const picked = kernel.create("点名基线",
    { repo: "https://x/r.git", ticket: "DTS9", baseline: "develop" });
  assert.equal(picked.baseline, "develop");

  // 纯会话形态不强制单号，但 AR/REQ 是业务身份，创建页仍应保留入口；
  // 基线才是代码交付专属字段。
  const chat = new TaskService({
    dataDir: mfcTemp("mfc-lf-chat2-"),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  assert.deepEqual(chat.launchOptions().ticket,
    { enabled: true, required: false });
  assert.equal(chat.launchOptions().baseline.enabled, false);
  assert.equal(chat.create("纯会话不需要单号").ticket, undefined);
});

test("统一需求图:单仓是一个节点,多仓进入同一任务的需求分析阶段", () => {
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-graph-"),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const one = service.create("单仓需求", {
    title: "订单状态接口", repos: ["https://codehub/team/api.git"], ticket: "REQ-G1",
  });
  assert.equal(one.title, "订单状态接口");
  assert.equal(one.requirement, "单仓需求", "任务名称不能覆盖需求原文");
  assert.equal(one.repo_url, "https://codehub/team/api.git");
  assert.equal(one.requirement_graph?.stage, "confirmed");
  assert.equal(one.requirement_graph?.repositories.length, 1);
  assert.deepEqual(one.requirement_graph?.dependencies, []);

  const many = service.create("多仓需求", {
    repos: [
      "https://codehub/team/api.git",
      "https://codehub/team/web.git",
      "https://codehub/team/api.git", // 重复输入只保留一个节点
    ],
    account: "owner",
    collaborators: ["alice", "bob", "alice", "owner"],
  });
  assert.deepEqual(many.repositories, [
    "https://codehub/team/api.git", "https://codehub/team/web.git",
  ]);
  assert.equal(many.requirement_graph?.stage, "analysis");
  assert.equal(many.ticket, undefined,
    "跨仓主任务尚未形成最终交付单元，下单时不应强收 AR 单号");
  assert.deepEqual(many.requirement_graph?.repositories.map((item) => item.ticket),
    [undefined, undefined]);
  assert.deepEqual(many.requirement_graph?.repositories.map((item) => item.assignee),
    [undefined, undefined], "讨论参与人不能被误写成逐仓执行人");
  assert.deepEqual(many.collaborators, ["alice", "bob"],
    "主责任人之外的多人可在创建主任务时直接受邀参与讨论");
  assert.deepEqual(many.requirement_graph?.repositories.map((item) => item.name),
    ["api", "web"]);
  assert.equal(many.parent_task_id, undefined,
    "多仓需求仍是一张普通需求单，不是第二套任务类型");
  assert.throws(() => service.create("普通单仓不创建讨论组", {
    repo: "https://codehub/team/api.git", ticket: "REQ-G2-SINGLE",
    account: "owner", collaborators: ["alice"],
  }), /只有先分析再拆分的主任务可以邀请讨论参与人/);
});

test("需求图确认:复用普通任务生成各仓交付,硬依赖保持排队", async () => {
  const dataDir = mfcTemp("mfc-lf-chain-confirm-");
  const kernelRoot = discoverKernelRoot(process.cwd())!;
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot },
    collaborationAssigneeReadiness: (account) => account === "alice"
      || account === "bob"
      ? { ready: true, missing: [] }
      : { ready: false, missing: ["CodeHub Token"] },
  });
  const standard = service.launchOptions().workflow_standard!;
  const workflowStage = standard.stages.find((item) =>
    item.id === "platform.construction") ?? standard.stages[0];
  const repositorySkill = {
    id: "api-diagnosis", repository: "https://codehub/team/api.git",
    revision: "main-deadbeef", name: "api-diagnosis",
    description: "API 问题定位", relative_path: ".claude/skills/api-diagnosis/SKILL.md",
    source: ".claude", digest: "c".repeat(64),
  };
  assert.throws(() => service.create("单仓不能伪装转交", {
    repo: "https://codehub/team/api.git", ticket: "REQ-SINGLE",
    repositoryAssignees: { "https://codehub/team/api.git": "alice" },
    account: "owner",
  }), /单仓任务责任人必须是当前下单人/);
  assert.throws(() => service.create("责任人不合法时整单拒绝", {
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    ticket: "REQ-BAD-OWNER",
    repositoryTickets: {
      "https://codehub/team/api.git": "REQ-BAD-API",
      "https://codehub/team/web.git": "REQ-BAD-WEB",
    },
    repositoryAssignees: {
      "https://codehub/team/api.git": "alice",
      "https://codehub/team/web.git": "ghost",
    },
    account: "owner",
  }), /web\.git.*ghost.*不可委派.*CodeHub Token/,
  "任一责任人不存在或未就绪都必须让整张跨仓任务创建失败");
  assert.throws(() => service.create("讨论参与人未就绪时整单拒绝", {
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    account: "owner", collaborators: ["charlie"],
  }), /charlie.*个人设置尚未就绪.*CodeHub Token/,
  "下单时邀请的讨论参与人也必须已完成个人设置");
  assert.equal(service.list().length, 0, "失败创建不能留下半张主任务");
  const parent = service.create("跨仓交付", {
    title: "跨仓订单状态交付",
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    ticket: "REQ-G3-API",
    repositoryTickets: {
      "https://codehub/team/api.git": "REQ-G3-API",
      "https://codehub/team/web.git": "REQ-G3-WEB",
    },
    repositoryAssignees: {
      "https://codehub/team/api.git": "alice",
      "https://codehub/team/web.git": "bob",
    },
    account: "owner", collaborators: ["alice"], repairRounds: 0,
    repositorySkills: [repositorySkill],
    workflowDefinition: {
      schema: "mae-flow-workflow-definition/1",
      base: { standard_id: standard.standard_id,
        standard_version: standard.standard_version,
        catalog_digest: standard.catalog_digest },
      applicability: { business_module_ids: [],
        repositories: [repositorySkill.repository], technologies: [] },
      edits: [{ edit_id: "api-skill", stage_id: workflowStage.id, op: "add",
        item: { id: "api-diagnosis-skill", kind: "skill",
          title: "API 问题定位", locked: false, editable: true,
          source: "workflow", use: { mode: "when_needed" },
          asset_ref: { registry: "repository_skill", id: repositorySkill.id,
            version: repositorySkill.revision, digest: repositorySkill.digest,
            nature: "engineering", form: "skill",
            repository: repositorySkill.repository,
            revision: repositorySkill.revision,
            relative_path: repositorySkill.relative_path } } }],
    },
  });
  assert.deepEqual(parent.collaborators, ["alice"],
    "讨论参与人应在主任务创建时就进入协作现场");
  const state = (service as any).tasks.get(parent.id);
  const root = join(dataDir, parent.id, "repositories");
  const artifacts = join(root, ".mae-flow-work", "REQ-G3-API");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, ".ticket-id"), "REQ-G3-API\n");
  writeRequirementArtifacts(artifacts, "REQ-G3-API", "# 已确认方案\n", {
    repository_assessments: [
      { name: "api", url: "https://codehub/team/api.git",
        outcome: "change_required", reason: "接口需要调整" },
      { name: "web", url: "https://codehub/team/web.git",
        outcome: "change_required", reason: "页面需要消费接口" },
    ],
    repositories: [
      { id: "api", name: "api", url: "https://codehub/team/api.git",
        responsibility: "提供接口",
        scope: { name: "接口模块", paths: ["src/api/"] } },
      { id: "web", name: "web", url: "https://codehub/team/web.git",
        responsibility: "消费接口",
        scope: { name: "页面模块", paths: ["src/web/"] } },
    ],
    // 历史产物的 from/to 是“api 先于 web”；升级后仍要读成 web 等 api。
    dependencies: [{ from: "api", to: "web", reason: "等待接口可用" }],
  });
  state.cwd = root;
  assert.doesNotThrow(() => service.saveRequirementRepositoryAssignmentDraft(
    parent.id, { api: "alice" }, { api: "REQ-G3-API" }));
  assert.equal(service.get(parent.id)!.requirement_graph?.repositories
    .find((repository) => repository.id === "api")?.assignee, "alice",
  "分工草稿允许只保存一个单元，不强迫用户填完后才能切走");
  const persistedDraft = JSON.parse(readFileSync(
    join(dataDir, parent.id, "task.json"), "utf-8"));
  assert.equal(persistedDraft.summary.requirement_graph.repositories
    .find((repository: { id: string }) => repository.id === "api").assignee,
  "alice", "责任人草稿必须进入服务端任务账，而不是只放浏览器内存");
  assert.throws(() => service.setRequirementCollaborators(parent.id,
    ["alice", "charlie"]), /charlie.*CodeHub Token/,
  "个人设置不完整的人不能受邀参与主任务");
  assert.deepEqual(service.setRequirementCollaborators(parent.id,
    ["alice", "bob", "alice", "owner"]).collaborators, ["alice", "bob"],
  "共同开发者去重且不重复列出唯一主责任人");
  assert.throws(() => service.assignRequirementRepositories(parent.id, {
    api: "alice", web: "charlie",
  }), /charlie.*CodeHub Token/, "个人设置不完整的人不能接仓库任务");
  service.assignRequirementRepositories(parent.id, {
    api: "alice", web: "bob",
  });
  (service as any).createRepositoryDeliveries(state);
  const graph = service.get(parent.id)!.requirement_graph!;
  const apiTask = service.get(graph.repositories[0].task_id!)!;
  const webTask = service.get(graph.repositories[1].task_id!)!;
  assert.equal(graph.stage, "confirmed");
  assert.equal(apiTask.parent_task_id, parent.id);
  assert.equal(apiTask.repair_rounds, 0,
    "跨仓子任务必须如实继承父任务的修复策略");
  assert.equal(webTask.repair_rounds, 0);
  assert.equal(apiTask.luban_account, "alice");
  assert.equal(webTask.luban_account, "bob");
  assert.equal(apiTask.ticket, "REQ-G3-API",
    "每个仓必须使用拆分前固定的独立 AR 单号");
  assert.equal(webTask.ticket, "REQ-G3-WEB");
  assert.equal(apiTask.parent_task?.title, "跨仓订单状态交付",
    "子任务读侧应直接给出可返回的主任务摘要");
  assert.equal(graph.repositories[0].task_status, "queued",
    "主任务协作树应投影子任务实时进展");
  assert.equal(apiTask.requirement, parent.requirement,
    "子任务需求原文必须保持用户原文");
  assert.match(readFileSync(
    join(dataDir, apiTask.id, "unit-brief.md"), "utf-8"),
  /AR 单号：REQ-G3-API/);
  assert.deepEqual(apiTask.blocked_by, undefined);
  assert.deepEqual(webTask.blocked_by, [apiTask.id]);
  // 方案正文落工作区文件而非内联进需求(整份方案进 prompt 会被模型
  // 当实施计划直接开写,跳过流程头部——2026-08-19 内网实锤)。
  assert.equal(webTask.requirement, parent.requirement,
    "任务书独立落盘，不再藏在需求原文末尾");
  assert.match(
    readFileSync(join(dataDir, webTask.id, "chain-plan.md"), "utf-8"),
    /已确认方案/,
    "人工检视过的 Chain 正文随子任务落盘,配置阶段经需求文档被读");
  assert.equal(apiTask.title, "接口模块 · 跨仓订单状态交付");
  assert.equal(webTask.title, "页面模块 · 跨仓订单状态交付");
  assert.ok(apiTask.workflow_profile?.final_snapshot?.stages
    .flatMap((item) => item.items)
    .some((item) => item.id === "api-diagnosis-skill"),
  "适用于 API 仓的固定 Skill 应保留在 API 子任务最终方案");
  assert.ok(!webTask.workflow_profile?.final_snapshot?.stages
    .flatMap((item) => item.items)
    .some((item) => item.id === "api-diagnosis-skill"),
  "父任务工作流必须按子仓重编，不能把 API Skill 整份复制给 Web 子任务");
  assert.ok(webTask.workflow_profile?.diagnostics.some((item) =>
    item.code === "asset_unavailable"),
  "子仓不适用的资产必须明确记录降级，不能静默消失");

  // 上游完成后，下游启动前拿到真实交接：实际提交文件、责任人和 AI
  // 收口说明都来自上游现场，不再只看最初 Chain 计划。
  const upstreamCwd = join(dataDir, "upstream-real-delivery");
  mkdirSync(upstreamCwd, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "master", upstreamCwd]);
  writeFileSync(join(upstreamCwd, "api.ts"), "export const version = 1;\n");
  execFileSync("git", ["-C", upstreamCwd, "add", "api.ts"]);
  execFileSync("git", ["-C", upstreamCwd, "commit", "-q", "-m", "base"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const baseline = execFileSync("git", ["-C", upstreamCwd, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).trim();
  writeFileSync(join(upstreamCwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  writeFileSync(join(upstreamCwd, "api.ts"), "export const version = 2;\n");
  execFileSync("git", ["-C", upstreamCwd, "add", "api.ts"]);
  execFileSync("git", ["-C", upstreamCwd, "commit", "-q", "-m", "change api"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const apiState = (service as any).tasks.get(apiTask.id);
  apiState.cwd = upstreamCwd;
  new EventLog(join(apiState.summary.workspace, "events.jsonl")).append({
    eventId: 1, taskId: apiTask.id, sessionId: "main",
    ts: new Date().toISOString(), kind: "assistant_message",
    payload: { text: "接口字段 version 已升级，前端需要按新契约消费。" },
  });
  const downstreamCwd = join(dataDir, "downstream-start");
  mkdirSync(downstreamCwd, { recursive: true });
  assert.equal(await (service as any).materializeDependencyHandoff(
    (service as any).tasks.get(webTask.id), downstreamCwd), true);
  const handoff = readFileSync(
    join(downstreamCwd, ".mae-flow-dependencies.md"), "utf-8");
  assert.match(handoff, /责任人：alice/);
  assert.match(handoff, /api\.ts/);
  assert.match(handoff, /version 已升级/);

  const update = await service.publishCrossRepositoryUpdate(
    apiTask.id, "alice", "version 字段改成字符串，请下游核对兼容性");
  assert.deepEqual(update.target_task_ids, [webTask.id]);
  assert.match(service.get(parent.id)!.cross_repository_updates![0].text,
    /改成字符串/);
  assert.equal(service.get(webTask.id)!.cross_repository_updates?.[0].id,
    update.id, "分工后的影响必须同步主任务和所有兄弟子任务");

  // 可重入:部分仓已有 task_id 时重跑,不许重复建任务(第 N 个仓
  // create 抛错/中途重启后的重试路径)。
  const before = service.list().length;
  (service as any).createRepositoryDeliveries(state);
  assert.equal(service.list().length, before, "重复确认不许再生任务");

  // 结构化确认入口:平台按钮直达,不依赖模型把选项原文写对;
  // 非分析单调用要如实拒绝。
  assert.equal((await service.confirmRequirementGraph(parent.id)).requirement_graph
    ?.repositories.every((repository) => repository.task_id), true);
  await assert.rejects(() => service.confirmRequirementGraph(apiTask.id),
    /不是多仓需求分析单/);
});

test("分析现场只读:真 push 必须在传输层死掉,不靠 prompt 嘱咐", async () => {
  // 分析会话没有内核 preTool 门禁兜底,"禁止推送"若只是开场白的一句
  // 话,模型犯浑就真推上去了。用真仓验证:readonly 克隆后 push 失败,
  // 普通克隆(交付任务)push 照常。
  const dataDir = mfcTemp("mfc-lf-readonly-");
  const origin = join(dataDir, "origin");
  execFileSync("git", ["init", "-q", "-b", "master", origin]);
  execFileSync("git", ["-C", origin, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: { ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const guarded = await (service as any).cloneRepo(
    join(dataDir, "ws1"), undefined, undefined, origin,
    undefined, "1-origin", true);
  execFileSync("git", ["-C", guarded, "commit", "-q", "--allow-empty",
    "-m", "escape"], { env: { ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.throws(() => execFileSync(
    "git", ["-C", guarded, "push", "-q", "origin", "master"],
    { stdio: "pipe" }), "只读分析现场的 push 必须失败");
  const normal = await (service as any).cloneRepo(
    join(dataDir, "ws2"), undefined, undefined, origin, undefined, "repo");
  const localExclude = readFileSync(
    join(normal, ".git", "info", "exclude"), "utf-8");
  for (const root of [
    ".agents", ".pi", ".claude", ".cac", ".codex", ".cursor",
    ".windsurf", ".gemini",
  ]) {
    assert.match(localExclude, new RegExp(`/${root.replace(".", "\\.")}/`),
      `${root} 未登记为 clone 本地运行资产`);
  }
  assert.match(localExclude, /^docs\/req\/$/m,
    "平台落盘的需求原文必须是 clone 本地资产，不能逼 Agent 修改业务 .gitignore");
  mkdirSync(join(normal, ".claude", "skills", "central"), { recursive: true });
  writeFileSync(join(normal, ".claude", "skills", "central", "SKILL.md"),
    "center injected\n");
  assert.doesNotThrow(() => execFileSync("git", ["-C", normal,
    "check-ignore", "-q", ".claude/skills/central/SKILL.md"]));
  execFileSync("git", ["-C", normal, "commit", "-q", "--allow-empty",
    "-m", "deliver"], { env: { ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  execFileSync("git", ["-C", normal, "push", "-q", "origin",
    "master:deliver-check"], { stdio: "pipe" });
});

test("需求分析与内核物理隔离，旧的错误配置待办可从原现场自愈", () => {
  const dataDir = mfcTemp("mfc-analysis-isolation-");
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/kernel" },
  });
  const parent = service.create("分析跨仓改动", {
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    account: "owner",
  });
  const state = (service as any).tasks.get(parent.id);
  const root = join(dataDir, parent.id, "repositories");
  const api = join(root, "1-api");
  mkdirSync(api, { recursive: true });
  const leakedState = join(api, ".mae-flow.json");
  writeFileSync(leakedState, JSON.stringify({ current: "config_confirm" }));
  state.cwd = root;
  const waiting = state.humanGate.createWaiting({
    taskId: parent.id, step: "需求分析", callId: "wrong-kernel-question",
    questionInput: { questions: [{ question: "请选择单号", options: ["A"] }] },
  });
  state.summary.waiting = waiting;
  state.summary.status = "waiting_for_human";

  assert.equal((service as any).stalledStep(state), undefined,
    "分析单永远不能被解释为尚未 init");
  assert.equal((service as any).recoverMisroutedRequirementAnalysisWaiting(
    state, waiting), true);
  assert.equal(state.summary.status, "queued");
  assert.equal(state.summary.waiting, undefined);
  assert.equal(existsSync(leakedState), false);
  assert.match(state.pendingResume.decision, /平台误触发/);

  const artifacts = join(root, ".mae-flow-work", parent.id);
  mkdirSync(artifacts, { recursive: true });
  const gate = createRequirementAnalysisGateContract(root, artifacts);
  assert.equal(gate("Write", join(artifacts, "requirement-graph.json"), {} as any),
    undefined);
  assert.equal(gate("Edit", join(api, "src/api.ts"), {} as any)?.action, "deny");
  assert.equal(gate("Bash", "python /kernel/mae-flow.py init", {} as any)?.action,
    "deny");
  assert.equal(gate("Bash", "rg TODO 1-api", {} as any), undefined);
});

test("前置死透不许无限等:取消→子任务如实 failed;失败→留队说明", async () => {
  const dataDir = mfcTemp("mfc-lf-chain-dep-");
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const parent = service.create("前置任务", {
    repos: ["https://codehub/team/api.git"], ticket: "REQ-D1",
  });
  const child = service.create("后置任务", {
    repos: ["https://codehub/team/web.git"], ticket: "REQ-D1",
    parentTaskId: "task-0", blockedBy: [parent.id],
  } as any);
  // maxConcurrent 0:两单都停在队列里,泵只做依赖清账不真启动。
  const parentState = (service as any).tasks.get(parent.id);
  parentState.summary.status = "failed";
  await (service as any).pump();
  assert.equal(service.get(child.id)!.status, "queued",
    "前置失败还有救(可重试),子任务留队");
  assert.match(service.get(child.id)!.detail ?? "", /前置任务.*失败/,
    "但必须把话写在明面上,不许静默蹲着");

  parentState.summary.status = "queued";
  await service.cancel(parent.id, "tester");
  // cancel 内部已触发泵(fire-and-forget),等它跑完。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.get(child.id)!.status, "failed",
    "前置取消是终态,等它=永远等——子任务必须如实 failed");
  assert.match(service.get(child.id)!.detail ?? "", /已取消或不存在/);
});

test("假通知服务不索个人令牌;部署切真端点后要求立刻恢复", () => {
  // 内网 agent 实测:演示形态(serve 自起假通知服务)登进去第一件事就被
  // "先配个人通知令牌"挡住——假件收什么都行,那个令牌谁也不消费,
  // 这是一道谁也过不去也不必过的假门。判定跟着**生效端点**走:
  // 部署切成真端点后要求立刻恢复(真件确实按令牌认人)。
  let override: { endpoint?: string } = {};
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-fake-luban-"),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    notifier: new Notifier({
      endpoint: "http://127.0.0.1:1/notify",
      fake: true,
      live: () => override,
    }),
  });
  assert.equal(service.launchOptions().needs.luban_token, false,
    "假件在场不该逼人配令牌");
  override = { endpoint: "http://assistant.example.com/notify" };
  assert.equal(service.launchOptions().needs.luban_token, true,
    "切了真端点,个人令牌的要求要立刻回来");
});

test("下单即校验:不存在的模型、负预算、带密码的仓地址,当场打回", () => {
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-"),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp", repoPath: "/tmp/repo" },
  });
  assert.throws(() =>
    service.create("x", { model: { provider: "a", model: "无此模型" } }),
    /没有模型/);
  assert.throws(() =>
    service.create("x", { repairRounds: -1 }), /≥0/);
  assert.throws(() => service.create("x", {
    taskInstructions: "过长".repeat(1001),
  }), /不能超过 2000/);
  // 明文凭据拼 URL 是堵死的洞,下单口也不许开
  assert.throws(() =>
    service.create("x", { repo: "https://user:pass@codehub.example.com/r.git" }),
    /不许携带账号密码/);
  assert.throws(() =>
    service.create("x", { repo: "https://a b/r.git" }), /空白字符/);
  // SSH 地址下单即拒(内网实锤:宿主凭据链是 HTTPS 令牌,SSH 推送必然
  // publickey 拒绝,还死在整轮流程跑完之后)。两种写法都要认得出。
  assert.throws(() =>
    service.create("x", {
      repo: "ssh://codehub.example.com:2222/example-org/Access/SONService.git" }),
    /请填 HTTPS 地址/);
  assert.throws(() =>
    service.create("x", { repo: "git@codehub.example.com:example-org/r.git" }),
    /请填 HTTPS 地址/);
  // 本地路径(演练/试跑的假件形态)不能被 SSH 拦截误伤
  assert.doesNotThrow(() =>
    service.create("x", { repo: "/tmp/bare-repo.git" }));

  // 没接内核模式:仓字段整个不该出现(enabled=false),硬塞就打回
  const bald = new TaskService({
    dataDir: mfcTemp("mfc-lf-"),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  assert.equal(bald.launchOptions().repo.enabled, false);
  assert.throws(() => bald.create("x", { repo: "https://x/r.git" }),
    /未接内核模式/);
});

test("任务执行补充在下单时固定，不与需求正文或内核红线混为一体", () => {
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-profile-"),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  const task = service.create("实现兼容旧数据的读取", {
    taskInstructions: "  先核对线上旧格式\n不确定时明确说明  ",
  });
  assert.equal(task.requirement, "实现兼容旧数据的读取");
  const supplements = task.workflow_profile?.supplements ?? [];
  assert.equal(supplements[0]?.scope, "task");
  assert.equal(supplements[0]?.instructions,
    "先核对线上旧格式\n不确定时明确说明");
  assert.match(task.workflow_profile?.revision ?? "",
    /^sha256:[a-f0-9]{64}$/);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mfc-lf-${name}-`));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

test("仓库地址在下单前按真实 Git 身份探测，并逐仓返回人话错误", async () => {
  const repository = makeRepo("probe-ok");
  const missing = join(tmpdir(), `mfc-probe-missing-${Date.now()}`);
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核");
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-probe-"),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot },
  });
  const server = createTaskServer(service);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/repositories/probe`, {
        method: "POST",
        body: JSON.stringify({ repositories: [
          repository, missing, "git@example.com:team/repo.git",
        ] }),
      });
    const body = await readJson(response) as {
      repositories: Array<{ repository: string; reachable: boolean; message: string }>;
    };
    assert.equal(response.status, 200);
    assert.deepEqual(body.repositories.map((item) => item.reachable),
      [true, false, false]);
    assert.match(body.repositories[0].message, /地址有效/);
    assert.match(body.repositories[1].message, /不存在|填写有误/);
    assert.match(body.repositories[2].message, /HTTPS/);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("发起页会防抖探测仓库并阻止坏地址，退出图标的对比色来自主题令牌", () => {
  const source = readFileSync(join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  const style = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf-8");
  const tokens = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf-8");
  assert.match(source, /probeRepositories\(repositoriesToProbe/);
  assert.match(source, /repositoryProbeBlocked/);
  assert.match(source, /正在检查仓库地址/);
  // 2026-09-05 起主题不再靠 data-theme 补丁覆盖硬编码色;#228 侧栏换装后
  // 退出钮走 shadcn ghost 皮,对比色经 tailwind 桥取 tokens(--faint/
  // --text-strong),legacy 的 .logout-button/.density-switch 规则已拆除。
  assert.doesNotMatch(style, /\.logout-button|\.density-switch/);
  assert.match(tokens, /:root \{[\s\S]*?--faint: #[0-9a-f]{6}/);
  assert.match(tokens, /:root\[data-theme="dark"\] \{[\s\S]*?--faint: #[0-9a-f]{6}/);
});

test("REQ 单号字段明确要求填写 AR 对应单号，并说明无法按格式区分 FuR", () => {
  const source = readFileSync(join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  assert.match(source, /AR 对应的 REQ 单号/);
  assert.match(source, /placeholder="例如：REQ2026xxxx"/);
  assert.match(source, /不要填写 FuR 对应的 REQ 单号/);
  assert.match(source, /两者格式相同，系统无法自动识别/);
});

test("分析主任务先选讨论参与人，拆分后再逐单元填写执行人和 AR 单号", () => {
  const launch = readFileSync(join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  const style = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf-8");
  const picker = readFileSync(join(process.cwd(),
    "web/src/RepositoryAssigneePicker.tsx"), "utf-8");
  const api = readFileSync(join(process.cwd(), "web/src/api.ts"), "utf-8");
  assert.match(launch, /第 \$\{index \+ 1\} 个仓库的 AR 单号/);
  assert.match(launch, /repositoryTickets: repoFieldsEnabled/);
  assert.doesNotMatch(launch, /repositoryAssignees: repoFieldsEnabled/);
  assert.doesNotMatch(launch, /第 \$\{index \+ 1\} 个仓库的责任人/);
  assert.match(launch, /谁一起把需求聊清楚/);
  assert.match(launch, /可多选；只邀请，不在这里按仓分工/);
  assert.match(launch, /collaborators: analysisTeamVisible \? collaborators : undefined/);
  assert.match(api, /collaborators: extras\?\.collaborators/);
  // 跨仓主任务先讨论：下单不收单号，提交也不带。
  assert.match(launch, /options\.ticket\.enabled && !ticketsDeferred/);
  assert.match(launch, /ticket: ticketsDeferred \? undefined/);
  // 2026-09-03 用户拍板:单仓没有"大需求先分析再拆分"开关。拆不拆是
  // 分析的产物,由 Agent 读完仓后 propose_split 提议;下单的人不提前判断。
  assert.doesNotMatch(launch, /repo-analysis-toggle|requirementAnalysis|先分析，再拆分/,
    "发起表单不许再出现大需求开关");
  assert.doesNotMatch(style, /repo-analysis/, "开关的样式一并删干净");
  assert.doesNotMatch(api, /requirement_analysis:/, "下单 API 不再带这个字段");
  assert.match(launch,
    /const analysisEligible = repoFieldsEnabled && repositoriesToProbe\.length > 0/);
  assert.match(launch,
    /const analysisTeamVisible = analysisEligible && multiRepository;/);
  assert.match(launch, /const ticketsDeferred = analysisTeamVisible/);
  assert.match(launch,
    /const repositoryTicketBlocked = Boolean\(options\?\.ticket\.enabled\)[\s\S]*?&& !ticketsDeferred/);
  // 拆分说明上移为下单表单仓区注记(2026-09 Story 检视);Picker 只管逐单元编辑。
  assert.match(launch, /拆分后再逐单元填写执行人与 AR 单号/);
  assert.match(picker, /onChange=\{\(event\) => chooseTicket/);
  // 执行人与 AR 都属于最终交付单元；执行人始终可选，免单号的分析
  // 主任务在同一确认区补齐 AR。
  // #233 收官:皮肤类换装为工具类,负责人栏保持 grid 小标签 + UserPicker。
  assert.match(picker, /<div className="grid min-w-0 gap-\[3px\]">\s*<small className="text-xs text-muted-foreground">负责人<\/small>/);
  assert.match(picker, /ariaLabel=\{\`\$\{rowLabel\}的执行人\`\}/);
  assert.doesNotMatch(picker, /repository-assignee-readonly/);
  // #214 输入簇换装后,单号编辑框是 shadcn Input(属性逐一保真)。
  assert.match(picker,
    /<Input type="text" className="min-h-\[34px\] font-mono text-xs font-semibold" value=\{ticket\}/);
  assert.doesNotMatch(picker, /repository-ticket-readonly|isUnitRow\(repository\) \|\| !ticket\.trim\(\)/,
    "已有单号与输入首字符都不能把编辑框变回只读");
  assert.match(picker, /chooseAssignee/);
  assert.match(picker, /已自动保存/);
  const workspace = readFileSync(join(process.cwd(),
    "web/src/TaskWorkspace.tsx"), "utf-8");
  assert.match(workspace, /putRepositoryAssignees/,
    "逐单元分工必须自动写回服务端，不能只活在 React state 里");
});

test("需求多份资料预览与补充说明并存，创建时传原始材料标识", () => {
  const source = readFileSync(join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  assert.match(source, /KnowledgeMaterialUpload purpose="requirement"/);
  assert.match(source, /previewRequirementMaterials/);
  assert.match(source, /requirementMaterialIds: requirementMaterials.length/);
  assert.match(source, /required=\{!requirementMaterials.length\}/);
  assert.doesNotMatch(source, /setRequirement\(preview.requirement\)/,
    "预览不能覆盖用户补充说明或造成重复拼接");
});

test("下单草稿在关闭、刷新和多份资料场景都保留材料标识", () => {
  const source = readFileSync(
    join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  assert.match(source, /requirementMaterials\?: MaterialSummary\[\]/);
  assert.match(source, /validDraft\?\.requirementMaterials \?\? \[\]/);
  assert.match(source, /latestDraft\.current = \{/,
    "卸载时应能取得最后一次渲染的完整值");
  assert.match(source, /window\.addEventListener\("pagehide", flushDraft\)/,
    "刷新和关闭标签页必须同步落盘");
  assert.match(source, /也覆盖父页面切栏目、快捷入口把发起弹层直接卸载/);
  assert.match(source,
    /variant="outline" size="sm" onClick=\{\(\) => \{[\s\S]*?persistDraft\(\);[\s\S]*?onClose\(\);/,
    "主动退出不能等防抖计时器碰运气");
});

test("修复轮手刹只恢复当前草稿，不会从上一张任务偷偷带入", () => {
  const source = readFileSync(
    join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  assert.match(source,
    /const \[repairRounds, setRepairRounds\] = useState\(\s*validDraft\?\.repairRounds \?\? ""\);/,
  "未提交草稿可恢复本单的显式选择");
  assert.doesNotMatch(source, /savedPreferences\?\.repairRounds/,
    "0=关闭自动修复，不能作为下一单的默认值");
  assert.match(source, /validDraft\?\.repairRounds\?\.trim\(\)/,
    "草稿里真有手刹时要自动展开，不能藏起来");
  assert.match(source, /repairRounds === "0"[\s\S]*?"自动修复已关闭"/,
    "0 必须按关闭能力告警，不能只写成机械的 0 轮");
  assert.match(source,
    /<Input type="text" inputMode="numeric" pattern="\[0-9\]\*"/,
    "修复轮手刹不能用 number spinner，空值误触会直接变 0");
  assert.match(source, /留空=平台默认 20 轮；填 0=关闭/,
    "placeholder 要把默认与关闭的区别说明白");
  assert.match(source, /检视、冲突或流水线失败将等人处理/,
    "真填 0 时要直说会失去什么能力");
});

test("消费:任务级代码仓压过部署仓,克隆的就是下单填的那个", async () => {
  const repoA = makeRepo("aaa");
  const repoB = makeRepo("bbb");
  writeFileSync(join(repoB, ".mae-flow-defaults.json"), JSON.stringify({
    执行补充: "修改接口前先检查兼容调用方",
  }));
  git(repoB, "add", ".mae-flow-defaults.json");
  git(repoB, "commit", "--quiet", "-m", "add repository execution preset");
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核(MAE_FLOW_HOME/仓内 kernel/ 皆无)");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-repo-"),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot, repoPath: repoA, python: "python3" },
  });
  const id = service.create("验证任务级代码仓", { repo: repoB }).id;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  const task = service.get(id)!;
  // 此剧本只验证 clone，不推进内核；宿主会机械 init 到 config_confirm，
  // 模型的一句“完成”仍必须被终态硬门禁如实打回。
  assert.equal(task.status, "failed");
  assert.match(task.detail ?? "",
    /config_confirm|尚未到 terminal|状态文件不存在|尚未初始化/);
  assert.equal(task.repo_url, repoB);
  assert.equal(task.workflow_profile?.supplements?.find(
    (item) => item.scope === "repository")?.instructions,
  "修改接口前先检查兼容调用方");
  assert.equal(task.repository_supplement_resolved, true);
  // 克隆目录名与 origin 都指向下单填的仓,不是部署仓
  const clone = join(task.workspace, basename(repoB));
  assert.equal(git(clone, "remote", "get-url", "origin"), repoB);
  await model.stop();
});

test("消费:任务级模型选择压过服务默认(默认是打不通的网关)", async () => {
  // 服务默认 provider 指向死地址;任务点名剧本模型 → 能收口
  // = 会话真用了任务级选择。
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const scripted = (model.modelsJson() as {
    providers: Record<string, unknown>;
  }).providers;
  const service = new TaskService({
    dataDir: mfcTemp("mfc-lf-run-"),
    provider: "dead", model: "dead-1",
    modelsJson: { providers: {
      ...scripted,
      dead: { baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
              apiKey: "x", models: [{ id: "dead-1" }] },
    } },
  });
  const id = service.create("验证任务级模型",
    { model: { provider: "maeflow", model: "scripted-v1" } }).id;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  assert.equal(service.get(id)!.status, "completed",
    service.get(id)!.detail ?? "");
  assert.deepEqual(service.get(id)!.model_choice,
    { provider: "maeflow", model: "scripted-v1" });
  await model.stop();
});

test("路由:没配齐令牌 409 不给下单;补齐后放行;坏参数仍 400", async () => {
  const dataDir = mfcTemp("mfc-lf-http-");
  createBusinessModule(dataDir, { id: "launch-domain", name: "下单测试",
    description: "完整表单用于验证令牌检查", owner: "dev",
    repositories: ["https://code.example/repo.git"] }, "dev");
  const business_module_id = "launch-domain";
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 通知端点在场(服务级不缺),缺的只有这个人自己的两个令牌
    notifier: new Notifier({ endpoint: "http://127.0.0.1:1" }),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const anonymous = await fetch(`${base}/launch-options`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "dev", password: "dev-password-11" }),
    });
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
    const options = await readJson(
      await fetch(`${base}/launch-options`, { headers: { cookie } }));
    assert.deepEqual(options.model,
      { provider: "maeflow", model: "scripted-v1" });
    const keys = options.blockers.map((item: { key: string }) => item.key);
    // 这个部署接了通知端点、没接代码仓:只该要通知令牌
    assert.deepEqual(keys, ["luban_token"],
      `缺项应只有通知令牌,实际: ${keys.join(",")}`);

    // 后端硬拦:绕过界面直接打接口一样不给下单
    const blocked = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "x", business_module_id }),
    });
    assert.equal(blocked.status, 409);
    assert.match((await readJson(blocked)).error, /配置未完成/);

    // 本人配上令牌 → 放行(管理员代配不了,密钥只写不读)
    auth.setLubanToken("dev", "luban-yyyy");
    const ok = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "配齐后下单", business_module_id }),
    });
    assert.equal(ok.status, 201);

    // 参数校验照旧:坏模型/负预算 400(不是 409,那是配置问题)
    const bad = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "x", business_module_id,
        model: { provider: "maeflow", model: "不存在" } }),
    });
    assert.equal(bad.status, 400);
    const worse = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "x", business_module_id, repair_rounds: -2 }),
    });
    assert.equal(worse.status, 400);
  } finally {
    server.close();
    await model.stop();
  }
});
