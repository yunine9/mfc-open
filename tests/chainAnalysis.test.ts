/**
 * 跨仓需求的分析会话端到端(真会话,不是把产物直接写盘绕过去):
 * 两个真 git 仓下单 → 分析会话把仓克隆成只读现场 → 剧本模型读仓、
 * 写 CHAIN 文档和机读需求图、举确认卡 → 用户答「确认并生成任务」→
 * 平台按依赖生成两个子任务(后者等前者)→ 分析单收口。
 *
 * 不需要内核:分析阶段本来就在内核流程之外(平台前置阶段),各仓的
 * 内核交付链在子任务里跑,那条链由 orderFacts/rejectionPaths 端到端
 * 覆盖。这里专门验"分析会话→确认→拆单"这一段此前没人真跑过的路。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { requirementAnnotationInstructions } from "../src/requirementReviewAgent.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { REQUIREMENT_GRAPH_ARTIFACT } from "../src/annotations.ts";
import {
  requirementArtifacts,
  writeRequirementArtifacts,
} from "./requirementGraphFixture.ts";

const GIT_ENV = { ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "master", path]);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  return path;
}

async function until<T>(
  probe: () => T | undefined, what: string, timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("跨仓分析会话:候选仓逐仓判断→只按改动模块建任务→依赖调度→收口", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-e2e-"));
  const apiRepo = makeRepo(dataDir, "svc-api");
  const webRepo = makeRepo(dataDir, "svc-web");
  const auditRepo = makeRepo(dataDir, "svc-audit");
  const ticket = "REQ2026081930";
  // 机读需求图:url 必须原样照录下单地址(投影按白名单全等过滤)。
  const artifacts = requirementArtifacts(
    "# 跨仓方案\n\n- svc-api：提供接口\n- svc-web：消费接口\n\n"
      + "先 api 后 web,接口契约见正文。\n", {
    repository_assessments: [
      { name: "svc-api", url: apiRepo, outcome: "change_required",
        reason: "接口定义与实现需要调整", evidence: ["src/api.ts:createOrder"] },
      { name: "svc-web", url: webRepo, outcome: "change_required",
        reason: "页面需要消费新接口", evidence: ["src/order.ts:submit"] },
      { name: "svc-audit", url: auditRepo, outcome: "no_change",
        reason: "现有审计事件已经覆盖且接口未变化", evidence: ["src/audit.ts:record"] },
    ],
    repositories: [
      { id: "unit-api", name: "svc-api", url: apiRepo, responsibility: "提供接口",
        scope: { name: "订单接口", paths: ["src/api/"] } },
      { id: "unit-web", name: "svc-web", url: webRepo, responsibility: "消费接口",
        scope: { name: "订单页面", paths: ["src/order/"] } },
    ],
    dependencies: [
      { dependent: "unit-web", prerequisite: "unit-api",
        reason: "svc-web 依赖 svc-api，接口没就绪前端无从联调" },
    ],
  });
  const graphJson = artifacts.graph;
  const artifactDir = join(".mae-flow-work", ticket);
  const script: Scene[] = [
    { text: "读两仓现场,写方案与机读投影",
      tool: { name: "bash", input: { command:
        `ls 1-svc-api 2-svc-web && ` +
        `cat > "${join(artifactDir, `CHAIN-${ticket}.md`)}" << 'CHAIN_EOF'\n` +
        `${artifacts.chain}CHAIN_EOF\n` +
        `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    // 模型照抄清单序号提问(内网实锤):卡上必须已经换成仓库名。
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "repo-1 与 repo-2 的接口契约方案是否确认?",
          options: ["确认,按7单元+依赖顺序生成任务", "需要修改"],
          recommended: "确认,按7单元+依赖顺序生成任务" }] } } },
    { text: "方案已确认,分析收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({ endpoint: luban.endpoint });
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
    notifier,
  });
  try {
    const parent = service.create("跨仓交付:api 出接口,web 消费,audit 仅排查", {
      account: "cloudbot", ticket,
      repos: [apiRepo, webRepo, auditRepo],
    });
    // 受邀参与讨论的人:能答卡、要收通知;拆单仍只认责任人。
    service.setRequirementCollaborators(parent.id, ["alice"]);
    const prompt = (service as any).requirementAnalysisPrompt(
      (service as any).tasks.get(parent.id), dataDir);
    assert.match(prompt, /- svc-api \| /, "清单第一列是仓库名,模型照抄它去提问");
    assert.doesNotMatch(prompt, /repo-\d+ \|/, "序号不再出现在清单里");
    assert.match(prompt, /称呼仓库一律用仓库名/);
    assert.match(prompt, /生产者、转换者、消费者和责任系统/,
      "跨仓分析必须在拆单前追清新增数据由谁产生");
    assert.match(prompt, /仓库清单之外.*外部系统/,
      "外部生产系统不能拖到某个子任务质询时才发现");
    assert.match(prompt, /候选仓只是排查范围/,
      "下单仓不能被默认当成开发任务");
    assert.match(prompt, /repository_assessments/,
      "机读图必须逐仓记录改与不改的结论");
    assert.equal(parent.requirement_graph?.stage, "analysis");
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    // 卡到手时投影应已能从产物读出依赖(面板据此画图)。
    assert.equal(card.requirement_graph?.projection_state, "ready");
    assert.equal(card.requirement_graph?.dependencies.length, 1);
    assert.equal(card.requirement_graph?.repositories.length, 2,
      "选了三个候选仓，也只能为两个实际改动模块建任务");
    assert.equal(card.requirement_graph?.repository_assessments?.length, 3);
    assert.equal(card.requirement_graph?.repository_assessments?.[2].outcome,
      "no_change");
    const firstMessage = readFileSync(join(parent.workspace, "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .find((event) => event.kind === "user_message")?.payload?.text;
    assert.match(firstMessage ?? "", /"repository_assessments":\[\{"name":"仓库名","url":"原始地址","outcome":"change_required"/,
      "机读图示例必须进入真实分析会话的首条消息，而非只存在于提示词函数里");
    assert.match(firstMessage ?? "", /outcome 只能写 change_required 或 no_change/);
    assert.equal(card.requirement_graph?.review_snapshot?.waiting_id,
      card.waiting?.waiting_id,
      "最终方案卡出现时必须锁定用户实际看到的版本");
    const persistedCard = JSON.parse(readFileSync(
      join(parent.workspace, "task.json"), "utf-8"));
    assert.equal(persistedCard.summary.requirement_graph.review_snapshot.waiting_id,
      card.waiting?.waiting_id,
      "送审快照必须先于通知持久化，重启后不能丢");
    // 卡上不能出现 repo-1/repo-2(内网实锤"完全看不懂是哪个仓"):prompt
    // 改按名称呼,举卡文本再机械替换一道兜底。
    const asked = String(
      (card.waiting?.question as any)?.questions?.[0]?.question ?? "");
    assert.match(asked, /svc-api 与 svc-web/, `卡上要用仓库名:${asked}`);
    assert.doesNotMatch(asked, /repo-\d/);
    // 参与人过得了 HTTP 权限闸,但"确认并生成任务"改任务形状,只认责任人。
    await assert.rejects(service.decide(parent.id, {
      actor: "alice", state_version: card.waiting!.state_version,
      decision: "确认并生成任务",
    }), /只有主责任人 cloudbot 可以确认拆分方案/);
    assert.equal(service.get(parent.id)?.status, "waiting_for_human",
      "被拒的拍板不消费卡");
    // 问题卡通知责任人和受邀参与人各一条(通知键按人分开)。
    const recipients = await until(() => {
      const accounts = notifier.list()
        .filter((record) => record.waiting_id.startsWith(card.waiting!.waiting_id))
        .map((record) => record.account).sort();
      return accounts.length >= 2 ? accounts : undefined;
    }, "参与人通知");
    assert.deepEqual(recipients, ["alice", "cloudbot"]);
    assert.deepEqual((card.waiting!.question as any).questions[0].options, ["确认方案", "需要修改"]);
    // 模拟升级前留下的空 step、自由文案待答卡；展示与提交必须同一契约。
    const pending = (service as any).tasks.get(parent.id).summary.waiting;
    pending.step = "";
    pending.question = { questions: [{ question: asked,
      options: ["确认,按7单元+依赖顺序生成任务", "确认并生成任务", "确认并继续开发", "确认分析结论", "需要修改"] }] };
    assert.deepEqual((service.get(parent.id)!.waiting!.question as any).questions[0].options,
      ["确认方案", "需要修改"]);
    const confirmed = await service.decide(parent.id, {
      actor: "cloudbot", state_version: card.waiting!.state_version,
      selected_options: { [asked]: "确认方案" },
    });
    // 分析会话同步收口，但跨仓主任务要继续汇总各仓交付；不能把
    // “拆单成功”冒充为“整个需求完成”。
    assert.equal(confirmed.status, "coordinating",
      "确认后主任务应进入子任务进行中");
    assert.equal(confirmed.waiting, undefined);
    const graph = service.get(parent.id)!.requirement_graph!;
    assert.equal(graph.stage, "confirmed");
    const apiChild = service.get(graph.repositories[0].task_id!)!;
    const webChild = service.get(graph.repositories[1].task_id!)!;
    // 升级现场：旧版把任务书塞在需求末尾且没有独立文件。部署恢复时
    // 必须从父任务已确认图机械补齐，当前已生成的任务也能继续用。
    const internal = service as any;
    const apiState = internal.tasks.get(apiChild.id);
    rmSync(join(dataDir, apiChild.id, "unit-brief.md"));
    apiState.summary.requirement = `${parent.requirement}\n\n本单元任务书(旧格式)`;
    internal.persist(apiState);
    assert.equal(internal.ensureDeliveryUnitMaterials(apiState), true);
    assert.equal(service.get(apiChild.id)?.requirement, parent.requirement);
    assert.ok(existsSync(join(dataDir, apiChild.id, "unit-brief.md")));
    // 子任务立即取消:它们的交付链(内核)由别的端到端覆盖,这里不跑
    // (父单收口会放出并发槽,晚一步取消子会话就会去误消费剧本场景)。
    await service.cancel(apiChild.id, "tester");
    await service.cancel(webChild.id, "tester");
    assert.equal(service.get(parent.id)?.status, "canceled",
      "全部子任务取消时主任务也取消，不冒充交付完成");
    // 以下手工改写子任务状态仅为验证旧任务书与汇总；另起一个汇总现场。
    internal.tasks.get(parent.id).summary.status = "coordinating";
    for (const child of [apiChild, webChild]) {
      const state = internal.tasks.get(child.id);
      state.summary.status = "completed";
      internal.persist(state);
    }
    assert.equal(service.get(parent.id)?.status, "completed",
      "全部子任务真实完成后父任务才完成");

    // 现场:两仓按序克隆成只读(pushurl 已改指死路)。
    const root = join(dataDir, parent.id, "repositories");
    for (const name of ["1-svc-api", "2-svc-web", "3-svc-audit"]) {
      assert.ok(existsSync(join(root, name)), `${name} 该被克隆`);
      const pushurl = execFileSync("git",
        ["-C", join(root, name), "config", "remote.origin.pushurl"],
        { encoding: "utf-8" }).trim();
      assert.match(pushurl, /mae-flow-readonly/, "分析现场必须只读");
    }
    // 拆单事实:职责、依赖、继承(单号/归属)、方案正文随子任务走。
    assert.equal(apiChild.repo_url, apiRepo);
    assert.equal(webChild.repo_url, webRepo);
    assert.equal(service.list().filter((item) => item.parent_task_id === parent.id).length,
      2, "无需修改的 audit 仓只留分析结论，不生成子任务");
    assert.equal(apiChild.delivery_scope, undefined);
    assert.equal(webChild.delivery_scope, undefined);
    assert.deepEqual(webChild.blocked_by, [apiChild.id]);
    assert.equal(apiChild.blocked_by, undefined);
    assert.equal(apiChild.parent_task_id, parent.id);
    assert.equal(apiChild.ticket, ticket);
    assert.equal(apiChild.luban_account, "cloudbot");
    // 方案正文不进需求原文(整份方案塞 prompt 会被模型当实施计划直接
    // 开写,跳过流程头部——内网实锤):落成工作区文件,需求里只指路,
    // launch 再把它带进克隆并经下单事实指给「需求文档」。
    assert.equal(apiChild.requirement, parent.requirement,
      "子任务的需求原文必须保持用户原文，不能再拼接任务书");
    assert.ok(!apiChild.requirement.includes("先 api 后 web"),
      "方案正文不得内联进需求");
    assert.match(readFileSync(
      join(dataDir, apiChild.id, "unit-brief.md"), "utf-8"), /提供接口/);
    const plan = readFileSync(
      join(dataDir, apiChild.id, "chain-plan.md"), "utf-8");
    assert.match(plan, /跨仓方案/, "人工检视过的 CHAIN 正文随子任务落盘");
    assert.match(plan, /提供接口/, "方案文件带当前仓职责");
  } finally {
    await model.stop();
    await luban.stop();
  }
});

test("机读图写错字段时一次报出缺项和合法枚举，修正后恢复就绪", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-schema-"));
  const apiRepo = makeRepo(dataDir, "schema-api");
  const webRepo = makeRepo(dataDir, "schema-web");
  const ticket = "REQ-SCHEMA";
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  t.after(async () => { await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  const parent = service.create("双仓交付", {
    account: "owner", ticket, repos: [apiRepo, webRepo],
  });
  const state = (service as any).tasks.get(parent.id);
  state.cwd = join(parent.workspace, "repositories");
  const artifactDir = join(state.cwd, ".mae-flow-work", ticket);
  const assessments = [
    { name: "schema-api", url: apiRepo, outcome: "change_required", reason: "接口需要调整", evidence: ["src/api.ts"] },
    { name: "schema-web", url: webRepo, outcome: "change_required", reason: "页面需要调整", evidence: ["src/web.ts"] },
  ];
  const units = [
    { id: "api", name: "schema-api", url: apiRepo, responsibility: "提供接口", scope: { name: "接口" } },
    { id: "web", name: "schema-web", url: webRepo, responsibility: "消费接口", scope: { name: "页面" } },
  ];
  const write = (graph: Record<string, unknown>) => {
    writeRequirementArtifacts(artifactDir, ticket, "# 双仓方案\n接口与页面分别交付。\n", graph);
    (service as any).refreshRequirementGraph(state);
    return state.summary.requirement_graph;
  };
  const missingFields = write({
    repository_assessments: [
      { repo: "schema-api", assessment: "接口需要调整", outcome: "in_scope" },
      assessments[1],
    ], repositories: units, dependencies: [],
  });
  assert.equal(missingFields.projection_state, "invalid");
  assert.match(missingFields.projection_error, /缺 name.*缺 url.*outcome 值 "in_scope" 不合法.*缺 reason/);
  assert.match(missingFields.projection_error, /change_required 或 no_change/);
  assert.match(missingFields.projection_error, /"evidence":\[/);

  const wrongUnit = write({
    repository_assessments: assessments,
    repositories: [{ path: "schema-api", role: "提供接口" }, units[1]],
    dependencies: [],
  });
  assert.equal(wrongUnit.projection_state, "invalid");
  assert.match(wrongUnit.projection_error, /第 1 个模块交付单元缺少 id、name、url、responsibility/);
  assert.match(wrongUnit.projection_error, /repositories\[\] 每项示例/);

  const fixed = write({ repository_assessments: assessments, repositories: units, dependencies: [] });
  assert.equal(fixed.projection_state, "ready");
  assert.equal(fixed.projection_error, undefined);
});

test("真实模块依赖图缺失时拒绝确认，不能拿候选仓占位图生成任务", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-missing-graph-"));
  const firstRepo = makeRepo(dataDir, "svc-first");
  const secondRepo = makeRepo(dataDir, "svc-second");
  const ticket = "REQ2026090401";
  const artifactDir = join(".mae-flow-work", ticket);
  const model = new ScriptedModelServer([
    { text: "只写了给人看的方案，漏掉机读图",
      tool: { name: "bash", input: { command:
        `printf '%s' '# 方案已写，但模块图缺失\n' > "${
          join(artifactDir, `CHAIN-${ticket}.md`)}"` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "方案是否确认?",
      options: ["确认并生成任务", "需要修改"],
      recommended: "确认并生成任务",
    }] } } },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    const parent = service.create("分析两个候选仓的真实改动模块", {
      account: "cloudbot", ticket, repos: [firstRepo, secondRepo],
    });
    const card = await until(() => {
      const now = service.get(parent.id)!;
      return now.status === "waiting_for_human" ? now : undefined;
    }, "缺图确认卡");
    assert.equal(card.requirement_graph?.projection_state, "pending");
    assert.equal(card.requirement_graph?.repositories.length, 2,
      "占位节点仍可用于展示候选仓，但不是交付单元");
    await assert.rejects(
      () => service.confirmRequirementGraph(parent.id),
      /模块拆分与依赖图尚未生成完整/,
    );
    assert.equal(service.list().filter((item) =>
      item.parent_task_id === parent.id).length, 0,
    "缺图时一个子任务都不能生成");
    assert.equal(service.get(parent.id)?.status, "waiting_for_human",
      "拒绝确认不能消费原决定卡");
  } finally {
    await service.cancel(service.list()[0].id, "tester").catch(() => undefined);
    await model.stop();
  }
});

test("所有候选仓均无需修改时确认结论直接完成，不制造空子任务", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-no-change-"));
  const firstRepo = makeRepo(dataDir, "svc-reader");
  const secondRepo = makeRepo(dataDir, "svc-ledger");
  const ticket = "REQ2026090402";
  const artifactDir = join(".mae-flow-work", ticket);
  const artifacts = requirementArtifacts(
    "# 排查结论\n两个仓均无需修改。\n", {
    repository_assessments: [
      { name: "svc-reader", url: firstRepo, outcome: "no_change",
        reason: "现有读取接口已经满足需求", evidence: ["src/read.ts:get"] },
      { name: "svc-ledger", url: secondRepo, outcome: "no_change",
        reason: "账本格式没有变化", evidence: ["src/ledger.ts:append"] },
    ],
    repositories: [],
    dependencies: [],
  });
  const graphJson = artifacts.graph;
  const model = new ScriptedModelServer([
    { text: "逐仓核对后无需修改",
      tool: { name: "bash", input: { command:
        `cat > "${join(artifactDir, `CHAIN-${ticket}.md`)}" << 'CHAIN_EOF'\n`
        + `${artifacts.chain}CHAIN_EOF\n`
        + `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n`
        + `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "是否确认无需修改代码?",
      options: ["确认分析结论", "需要修改"],
      recommended: "确认分析结论",
    }] } } },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    const parent = service.create("核对现有链路是否已经满足", {
      account: "cloudbot", ticket, repos: [firstRepo, secondRepo],
    });
    const card = await until(() => {
      const now = service.get(parent.id)!;
      return now.status === "waiting_for_human" ? now : undefined;
    }, "无需改动确认卡");
    assert.equal(card.requirement_graph?.projection_state, "ready");
    assert.equal(card.requirement_graph?.repositories.length, 0);
    const confirmed = await service.confirmRequirementGraph(parent.id);
    assert.equal(confirmed.status, "completed");
    assert.match(confirmed.detail ?? "", /均无需修改/);
    assert.equal(service.list().filter((item) =>
      item.parent_task_id === parent.id).length, 0);
  } finally {
    await model.stop();
  }
});

test("CHAIN 与机读图强同步；图上模块批注复用统一批注账", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-revision-"));
  const apiRepo = makeRepo(dataDir, "revision-api");
  const webRepo = makeRepo(dataDir, "revision-web");
  const ticket = "REQ2026090403";
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  const parent = service.create("强同步拆分方案", {
    account: "owner", ticket, repos: [apiRepo, webRepo],
  });
  const state = (service as any).tasks.get(parent.id);
  const cwd = join(parent.workspace, "repositories");
  const artifactDir = join(cwd, ".mae-flow-work", ticket);
  const graph = {
    repository_assessments: [
      { name: "revision-api", url: apiRepo, outcome: "change_required",
        reason: "接口需要调整" },
      { name: "revision-web", url: webRepo, outcome: "change_required",
        reason: "页面需要跟随" },
    ],
    repositories: [
      { id: "unit-api", name: "revision-api", url: apiRepo,
        responsibility: "提供接口",
        scope: { name: "接口模块", paths: ["src/api/"] } },
      { id: "unit-web", name: "revision-web", url: webRepo,
        responsibility: "消费接口",
        scope: { name: "页面模块", paths: ["src/web/"] } },
    ],
    dependencies: [{ dependent: "unit-web", prerequisite: "unit-api",
      reason: "页面等待接口" }],
  };
  const first = writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口先行，页面随后。\n", graph, "r1");
  state.cwd = cwd;
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  assert.equal(state.summary.requirement_graph.plan_revision, "r1");

  // 模型分步写文件时，轮询可短暂读到缺 SHA 的 JSON；补齐即恢复，不能缓存拒绝。
  const incomplete = JSON.parse(first.graph);
  delete incomplete.chain_sha256;
  writeFileSync(join(artifactDir, "requirement-graph.json"), JSON.stringify(incomplete));
  for (let i = 0; i < 2; i++) {
    (service as any).refreshRequirementGraph(state);
    assert.equal(state.summary.requirement_graph.projection_state, "invalid");
    assert.match(state.summary.requirement_graph.projection_error, /chain_sha256/);
  }
  writeFileSync(join(artifactDir, "requirement-graph.json"), first.graph);
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  assert.equal(state.summary.requirement_graph.projection_error, undefined);

  // 页面轮询可能在 Agent 尚未写完时先读到 r1。它只是草稿投影，不是
  // 送审动作；同一分析回合继续完善职责/证据不能因此被误判成偷换版本。
  const refinedGraph = {
    ...graph,
    repository_assessments: graph.repository_assessments.map((item, index) =>
      index === 0 ? { ...item, reason: "接口定义与调用点都需要调整" } : item),
    repositories: graph.repositories.map((item, index) =>
      index === 0 ? { ...item, responsibility: "提供接口并完成调用点接线" } : item),
  };
  writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口先行，页面随后。\n", refinedGraph, "r1");
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready",
    "举卡前同一 revision 的中间稿可继续完善");
  assert.equal(state.summary.requirement_graph.repositories[0].responsibility,
    "提供接口并完成调用点接线");

  const annotation = service.addAnnotation(parent.id, {
    author: "reviewer",
    artifact: REQUIREMENT_GRAPH_ARTIFACT,
    file: "模块拆分与依赖 / 模块 / 接口模块",
    line: 2,
    anchor: "模块 unit-api：接口模块",
    quote: "revision-api · 接口模块\n职责：提供接口\n负责面：src/api/",
    note: "这个模块还太大，请继续拆成协议和实现。",
    kind: "doc",
  });
  assert.equal(service.listAnnotations(parent.id).checks[0]?.state, "hit",
    "图批注要按模块 id 命中当前图，不依赖 JSON 行号");
  assert.match(service.previewAnnotations(parent.id, [annotation.id]), /方案结构/);
  assert.match(requirementAnnotationInstructions([annotation])!, /同步修订当前设计文档.*旧现场沿用 CHAIN.*requirement-graph\.json/);

  // 只改人看的文档：版本标记和 JSON 都没动，真实字节摘要必须立即失配。
  writeFileSync(join(artifactDir, `CHAIN-${ticket}.md`),
    first.chain.replace("接口先行", "接口协议先行"));
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "invalid");
  assert.match(state.summary.requirement_graph.projection_error,
    /文档内容已经变化.*机读依赖图还没有同步/);
  assert.throws(() => (service as any).requirementGraphPlan(state),
    /模块拆分与依赖图尚未生成完整/);

  // 两份一起升级到 r2 后恢复；最终确认卡出现时才把 r2 封成送审快照。
  writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口协议先行，页面随后。\n", graph, "r2");
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  assert.equal(state.summary.requirement_graph.plan_revision, "r2");
  const review = state.humanGate.createWaiting({
    taskId: parent.id,
    step: "requirement-analysis",
    callId: "chain-revision-review-r2",
    questionInput: { questions: [{
      question: "检视方案与依赖图",
      options: ["需要修改", "确认并生成任务"],
    }] },
  });
  state.summary.status = "waiting_for_human";
  state.summary.waiting = review;
  assert.equal((service as any).sealRequirementGraphReview(state, review), true);
  assert.equal(state.summary.requirement_graph.review_snapshot.plan_revision, "r2");
  assert.deepEqual(state.summary.requirement_graph.reviewed_plan_revisions, ["r2"]);

  // 送审后职责、证据和依赖都属于检视对象；同 revision 偷换仍必须被拒。
  writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口协议先行，页面随后。\n", {
      ...graph,
      dependencies: [],
    }, "r2");
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "invalid");
  assert.match(state.summary.requirement_graph.projection_error,
    /送审中的版本 r2 已发生变化/);

  // 人选择修改后进入下一轮，r3 在再次举卡前同样可以多次保存；旧的 r2
  // 送审记录仍保留，不能因为开放草稿就丢掉历史防偷换能力。
  state.summary.status = "running";
  state.summary.waiting = undefined;
  writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口协议先行，页面随后。\n", graph, "r3");
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口协议先行，页面随后。\n", refinedGraph, "r3");
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  assert.equal(state.summary.requirement_graph.review_snapshot.plan_revision, "r2");

  const nextReview = state.humanGate.createWaiting({
    taskId: parent.id,
    step: "requirement-analysis",
    callId: "chain-revision-review-r3",
    questionInput: { questions: [{
      question: "再次检视方案与依赖图",
      options: ["需要修改", "确认并生成任务"],
    }] },
  });
  state.summary.status = "waiting_for_human";
  state.summary.waiting = nextReview;
  assert.equal((service as any).sealRequirementGraphReview(state, nextReview), true);
  (service as any).persist(state);
  assert.deepEqual(state.summary.requirement_graph.reviewed_plan_revisions,
    ["r2", "r3"]);

  // 真正重建 TaskService，证明封版不是只在内存里有效。
  const restored = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  restored.recover();
  const restoredState = (restored as any).tasks.get(parent.id);
  assert.equal(restoredState.summary.requirement_graph.review_snapshot.plan_revision,
    "r3");
  assert.deepEqual(restoredState.summary.requirement_graph.reviewed_plan_revisions,
    ["r2", "r3"]);
  writeRequirementArtifacts(artifactDir, ticket,
    "# 模块方案\n接口协议先行，页面随后。\n", graph, "r3");
  (restored as any).refreshRequirementGraph(restoredState);
  assert.equal(restoredState.summary.requirement_graph.projection_state, "invalid");
  assert.match(restoredState.summary.requirement_graph.projection_error,
    /送审中的版本 r3 已发生变化/);
});

test("在途旧任务恢复：轮询记下 r4 中间稿时，以确认卡当前完整产物封版", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-draft-migration-"));
  const apiRepo = makeRepo(dataDir, "draft-api");
  const webRepo = makeRepo(dataDir, "draft-web");
  const ticket = "REQ2026090405";
  const options = {
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  };
  const service = new TaskService(options);
  const parent = service.create("恢复 r4 中间稿", {
    account: "owner", ticket, repos: [apiRepo, webRepo],
  });
  const state = (service as any).tasks.get(parent.id);
  const cwd = join(parent.workspace, "repositories");
  const artifactDir = join(cwd, ".mae-flow-work", ticket);
  const graph = {
    repository_assessments: [
      { name: "draft-api", url: apiRepo, outcome: "change_required",
        reason: "接口需要修改" },
      { name: "draft-web", url: webRepo, outcome: "change_required",
        reason: "页面需要修改" },
    ],
    repositories: [
      { id: "api", name: "draft-api", url: apiRepo,
        responsibility: "接口中间稿",
        scope: { name: "接口", paths: ["src/api/"] } },
      { id: "web", name: "draft-web", url: webRepo,
        responsibility: "页面",
        scope: { name: "页面", paths: ["src/web/"] } },
    ],
    dependencies: [{ dependent: "web", prerequisite: "api", reason: "等待接口" }],
  };
  state.cwd = cwd;
  writeRequirementArtifacts(artifactDir, ticket,
    "# r4 方案\n接口先行。\n", graph, "r4");
  (service as any).refreshRequirementGraph(state);
  const intermediateSha = state.summary.requirement_graph.projection_sha256;

  // Agent 在同一回合继续完善 r4，但旧服务尚未来得及刷新 task.json。
  writeRequirementArtifacts(artifactDir, ticket,
    "# r4 方案\n接口先行。\n", {
      ...graph,
      repositories: graph.repositories.map((item, index) => index === 0
        ? { ...item, responsibility: "接口契约、实现与调用点接线" } : item),
    }, "r4");
  const review = state.humanGate.createWaiting({
    taskId: parent.id,
    step: "requirement-analysis",
    callId: "legacy-r4-review",
    questionInput: { questions: [{
      question: "r4 方案是否确认?",
      options: ["需要修改", "确认并生成任务"],
    }] },
  });
  state.summary.status = "waiting_for_human";
  state.summary.waiting = review;
  // 精确模拟旧版落盘形态：只有中间 projection_sha256，没有送审快照。
  (service as any).writeTaskState(state);

  const restored = new TaskService(options);
  restored.recover();
  const recovered = restored.get(parent.id)!;
  assert.equal(recovered.requirement_graph?.projection_state, "ready");
  assert.equal(recovered.requirement_graph?.plan_revision, "r4");
  assert.notEqual(recovered.requirement_graph?.projection_sha256, intermediateSha);
  assert.equal(recovered.requirement_graph?.review_snapshot?.waiting_id,
    review.waiting_id);
  assert.equal(recovered.requirement_graph?.review_snapshot?.projection_sha256,
    recovered.requirement_graph?.projection_sha256);
});

test("升级前已生成的存量依赖图继续展示；返工后再强制升级同步契约", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-legacy-"));
  const apiRepo = makeRepo(dataDir, "legacy-api");
  const webRepo = makeRepo(dataDir, "legacy-web");
  const ticket = "REQ2026090404";
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  const parent = service.create("存量模块方案", {
    account: "owner", ticket, repos: [apiRepo, webRepo],
  });
  const state = (service as any).tasks.get(parent.id);
  assert.equal(state.summary.requirement_graph.sync_required, true,
    "新任务从创建时就必须执行强同步契约");
  const cwd = join(parent.workspace, "repositories");
  const artifactDir = join(cwd, ".mae-flow-work", ticket);
  mkdirSync(artifactDir, { recursive: true });
  const chainPath = join(artifactDir, `CHAIN-${ticket}.md`);
  writeFileSync(chainPath, "# 存量方案\n接口先行，页面随后。\n");
  writeFileSync(join(artifactDir, "requirement-graph.json"), JSON.stringify({
    repository_assessments: [
      { name: "legacy-api", url: apiRepo, outcome: "change_required",
        reason: "接口需要调整" },
      { name: "legacy-web", url: webRepo, outcome: "change_required",
        reason: "页面需要跟随" },
    ],
    repositories: [
      { id: "unit-api", name: "legacy-api", url: apiRepo,
        responsibility: "提供接口",
        scope: { name: "接口模块", paths: ["src/api/"] } },
      { id: "unit-web", name: "legacy-web", url: webRepo,
        responsibility: "消费接口",
        scope: { name: "页面模块", paths: ["src/web/"] } },
    ],
    dependencies: [{ dependent: "unit-web", prerequisite: "unit-api",
      reason: "页面等待接口" }],
  }));
  state.cwd = cwd;
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "invalid");
  assert.match(state.summary.requirement_graph.projection_error, /仍是旧格式/,
    "新任务不能利用存量兼容口绕过强同步");

  // 模拟升级前已经生成并持久化为 ready 的任务：当时没有 strict 标记。
  delete state.summary.requirement_graph.sync_required;
  state.summary.requirement_graph.projection_state = "ready";
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "ready");
  assert.equal(state.summary.requirement_graph.repositories.length, 2);
  assert.equal(state.summary.requirement_graph.sync_required, false);

  // 兼容仅限原样展示；存量内容一旦返工，就不能继续拿旧格式蒙混过去。
  writeFileSync(chainPath, "# 存量方案\n接口协议先行，页面随后。\n");
  (service as any).refreshRequirementGraph(state);
  assert.equal(state.summary.requirement_graph.projection_state, "invalid");
  assert.match(state.summary.requirement_graph.projection_error,
    /存量方案已经发生修改.*plan_revision/);
});
