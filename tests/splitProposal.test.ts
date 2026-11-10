/**
 * Agent 在开发中提议拆分(docs/delivery-unit-split-design.md 2026-09-03 勘误)。
 *
 * 2026-09-03 用户拍板:下单时的「大需求先分析再拆分」开关取消——拆不拆是
 * 分析的产物,下单的人在信息最少的时刻判不准;读完仓的 Agent 才判得准。
 * 但人有最后一票:提议不直接转身,而是举一张决定卡,选「不拆」会话原地
 * 继续、零成本;选拆才掐掉编码会话、按分析单重启。
 *
 * 这里真跑接力:编码会话用假件顶替(真编码会话要内核+容器,那条链由
 * rejectionPaths 等覆盖),卡由宿主真建、决定真走 decide;选拆之后分析
 * 会话真跑只读克隆与剧本模型→写图→确认卡→按单元生成两个串行子任务。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import { requirementArtifacts } from "./requirementGraphFixture.ts";
import { EventLog } from "../src/semanticEvents.ts";

const GIT_ENV = { ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const ACCEPT = "先分析再拆分";
const DECLINE = "不拆，一个任务干完";

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

function makeRepo(root: string): string {
  const repo = join(root, "svc-core");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  return repo;
}

/** 假编码会话:只实现宿主会碰到的几个口——举卡挂起、决定回注、中止。
 * 举卡时把状态切成 waiting_for_human(真会话由 settle 循环做这件事)。 */
function fakeDriver(state: any) {
  const calls = { aborted: false, disposed: false, resumed: [] as any[] };
  let pending: ((text: string) => void) | undefined;
  let turnEnd: ((outcome: unknown) => void) | undefined;
  const driver = {
    calls,
    awaitHostDecision: (record: any) => {
      state.summary.waiting = record;
      state.summary.status = "waiting_for_human";
      return new Promise<string>((resolve) => { pending = resolve; });
    },
    resumeWithDecision: async (record: any) => {
      calls.resumed.push(record);
      pending?.(`用户决定:${record.decision}`);
      pending = undefined;
      return new Promise((resolve) => { turnEnd = resolve; });
    },
    endTurn: () => turnEnd?.({ status: "session_ended", detail: "test" }),
    abort: async () => {
      calls.aborted = true;
      pending?.("[mae-flow-cloud] 会话已由宿主中止");
      pending = undefined;
    },
    dispose: () => { calls.disposed = true; },
    pendingSteers: () => [], takeUndeliveredSteers: () => [],
  };
  return driver;
}

const PROPOSAL = {
  reason: "要改 14 处:偏好存储 3 个文件、过滤逻辑 5 个、装配与构建 6 处",
  suggested_units: ["契约骨架:接口与注册占位", "过滤实现"],
};

test("提议拆分→决定卡→责任人选拆:掐会话、按分析单重启→确认卡两单元→同仓并行子任务", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-split-proposal-"));
  const repo = makeRepo(dataDir);
  const ticket = "REQ2026090301";
  const artifactDir = join(".mae-flow-work", ticket);
  const artifacts = requirementArtifacts(
    "# 拆分方案\n契约先行,过滤在后。\n", {
    repository_assessments: [{ name: "svc-core", url: repo,
      outcome: "change_required", reason: "契约和过滤模块需要分别交付" }],
    repositories: [
      { id: "unit-contract", name: "svc-core", url: repo,
        responsibility: "接口契约骨架,整体编译得过",
        scope: { name: "契约骨架", paths: ["src/contract/"] } },
      { id: "unit-filter", name: "svc-core", url: repo,
        responsibility: "过滤模块实现",
        scope: { name: "过滤实现", paths: ["src/filter/"] } },
    ],
    dependencies: [],
  });
  const graphJson = artifacts.graph;
  // 分析会话的剧本:写方案与机读图,举确认卡。
  const analysisScenes: Scene[] = [
    { text: "分析现场:写方案与机读投影",
      tool: { name: "bash", input: { command:
        `ls 1-svc-core && mkdir -p "${artifactDir}" && ` +
        `cat > "${join(artifactDir, `CHAIN-${ticket}.md`)}" << 'CHAIN_EOF'\n` +
        `${artifacts.chain}CHAIN_EOF\n` +
        `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "拆分方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
    { text: "方案已确认,分析收口。" },
  ];
  const model = new ScriptedModelServer(analysisScenes);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 0,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    // 下单没有开关:单仓就是普通任务,退化图 stage=confirmed。
    const parent = service.create("通知按用户偏好过滤", {
      account: "cloudbot", ticket, repos: [repo],
    });
    assert.equal(parent.requirement_analysis_requested, undefined);
    assert.equal(parent.requirement_graph?.stage, "confirmed");
    const internal = service as any;
    const state = internal.tasks.get(parent.id);
    new EventLog(join(state.summary.workspace, "events.jsonl")).append({
      eventId: 1, taskId: parent.id, sessionId: "main", ts: new Date().toISOString(),
      kind: "user_message", payload: { via: "interrupt", text: "[责任人 cloudbot 插话] 同步采用 upsert；重复 id 整批拒绝。" },
    });
    assert.equal(internal.splitTools(state).length, 1,
      "单仓直接开发的主任务挂 propose_split");

    // 假装编码会话正在跑。
    internal.queue = internal.queue.filter((id: string) => id !== parent.id);
    state.summary.status = "running";
    state.cwd = join(dataDir, "old-coding-clone");
    state.mission = "旧使命";
    const driver = fakeDriver(state);
    state.driver = driver;

    // 提议 = 举卡挂起,不是转身。
    const toolResult = internal.proposeSplit(state, PROPOSAL, "call-split-1") as Promise<string>;
    await until(() => state.summary.waiting ? true : undefined, "拆分决定卡");
    const raised = service.get(parent.id)!;
    assert.equal(raised.status, "waiting_for_human");
    assert.equal(raised.waiting?.step, "cloud_split_proposal");
    assert.equal(raised.split_escalation?.decision, "pending");
    assert.equal(raised.requirement_analysis_requested, undefined,
      "人没拍板前不许转成分析单");
    assert.equal(raised.requirement_graph?.stage, "confirmed");
    const question = (raised.waiting!.question as any).questions[0];
    assert.deepEqual(question.options, [ACCEPT, DECLINE]);
    assert.match(raised.waiting!.context ?? "", /偏好存储 3 个文件/);
    assert.match(raised.waiting!.context ?? "", /1\. 契约骨架:接口与注册占位/);
    assert.equal(raised.waiting!.choice_effects?.map((item) => item.key).join(","),
      "split,decline", "两个选项的语义投影给页面");
    // 卡上再提就是"等拍板",不重复举卡。
    assert.match(await internal.proposeSplit(state, PROPOSAL, "call-split-2"),
      /等责任人拍板/);
    // 拆不拆是主责任人的一票。
    await assert.rejects(() => service.decide(parent.id, {
      state_version: raised.waiting!.state_version,
      answers: { [question.question]: ACCEPT }, actor: "mallory",
    }), (error: unknown) => error instanceof TaskControlError
      && /只有主责任人 cloudbot/.test((error as Error).message));

    // 选拆:转身在决定里完成——掐会话、清现场指针、按分析单排队。
    await service.decide(parent.id, {
      state_version: raised.waiting!.state_version,
      answers: { [question.question]: ACCEPT }, actor: "cloudbot",
    });
    assert.match(await toolResult, /会话已由宿主中止/,
      "挂起的工具由 abort 解开,不许无限等");
    const queued = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "queued" ? now : undefined;
    }, "转身排队");
    assert.ok(driver.calls.aborted && driver.calls.disposed, "旧编码会话必须被掐掉并释放");
    assert.equal(driver.calls.resumed.length, 0, "选拆不回注会话,直接掐");
    assert.equal(queued.split_escalation?.decision, "split");
    assert.equal(queued.split_escalation?.decided_by, "cloudbot");
    assert.equal(queued.requirement_analysis_requested, true,
      "拍板即落盘:重启后仍是分析单");
    assert.equal(queued.requirement_graph?.stage, "analysis");
    assert.equal(queued.waiting, undefined);
    assert.equal(state.driver, undefined);
    assert.equal(state.cwd, undefined, "旧编码现场作废,分析单重新只读克隆");
    assert.equal(state.mission, undefined);
    assert.match(queued.detail ?? "", /已转为全局分析:要改 14 处/);
    assert.equal(internal.splitTools(state).length, 0, "分析单不再挂 propose_split");
    assert.match(await internal.proposeSplit(state, PROPOSAL, "call-split-3"),
      /已经是分析拆分单/);

    // 放开并发,分析单真跑:只读克隆到 repositories/,分析剧本写图、举卡。
    internal.options.maxConcurrent = 1;
    void internal.pump();
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human"
        && (now.requirement_graph?.repositories.length ?? 0) === 2 ? now : undefined;
    }, "拆分确认卡");
    assert.deepEqual(card.requirement_graph!.repositories.map((node) => node.scope?.name),
      ["契约骨架", "过滤实现"]);
    assert.match(String(state.cwd), /repositories$/, "分析现场在 workspace/repositories");
    const oldArtifacts = join(state.summary.workspace, "a-old-coding-clone", ".mae-flow-work", ticket);
    mkdirSync(oldArtifacts, { recursive: true });
    writeFileSync(join(oldArtifacts, "story.md"), "旧编码仓遗留 Story");
    assert.equal(service.artifactRoot(parent.id), state.cwd,
      "转拆分后的全局分析产物不能被旧编码仓的遗留文件抢先命中");
    // 分析提示词把上一位 Agent 的判断当起点,不当结论。
    const prompt = internal.requirementAnalysisPrompt(state, String(state.cwd));
    assert.match(prompt, /上一位 Agent.*结合需求和模块边界提议拆分/);
    assert.match(prompt, /偏好存储 3 个文件/);
    assert.match(prompt, /它建议的切法:\n1\. 契约骨架:接口与注册占位\n2\. 过滤实现/);
    assert.match(prompt, /切法可以推翻/);
    assert.match(prompt, /inherited-decisions\.json/);
    const inherited = JSON.parse(readFileSync(join(String(state.cwd), ".mae-flow-work", ticket,
      "inherited-decisions.json"), "utf8"));
    assert.ok(inherited.records.some((item: any) => item.kind === "supplement"
      && item.text.includes("同步采用 upsert；重复 id 整批拒绝")), "转入分析不能丢掉已读过的责任人插话");
    assert.ok(inherited.records.some((item: any) => item.kind === "decision"
      && item.actor === "cloudbot" && item.text.includes(ACCEPT)), "人工答复原文与身份必须一同传递");

    assert.throws(() => internal.requirementGraphPlan(internal.tasks.get(parent.id),
      { "unit-contract": "cloudbot", "unit-filter": "cloudbot" },
      { "unit-contract": "REQ-SAME", "unit-filter": "REQ-SAME" }),
      /同仓并行.*不能共用 AR/, "分析确认阶段就发现并行分支单号冲突");
    // 人确认:单号逐单元定(父单号不下传),同仓无依赖单元并行。
    const confirmed = await service.confirmRequirementGraph(parent.id, {
      repository_assignees: { "unit-contract": "cloudbot", "unit-filter": "cloudbot" },
      repository_tickets: { "unit-contract": "REQ2026090302", "unit-filter": "REQ2026090303" },
    });
    assert.equal(confirmed.status, "coordinating");
    const graph = service.get(parent.id)!.requirement_graph!;
    const contractChild = service.get(graph.repositories[0].task_id!)!;
    const filterChild = service.get(graph.repositories[1].task_id!)!;
    await service.cancel(contractChild.id, "tester");
    await service.cancel(filterChild.id, "tester");
    assert.deepEqual(filterChild.blocked_by ?? [], [],
      "同仓无依赖单元不应被补入串行等待");
    assert.equal(contractChild.ticket, "REQ2026090302");
    assert.equal(internal.splitTools(internal.tasks.get(filterChild.id)).length, 0,
      "子任务不挂 propose_split");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("责任人选不拆:会话原地继续、记下否决、以后不再受理;不转成分析单", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-split-decline-"));
  const repo = makeRepo(dataDir);
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  const internal = service as any;
  let driver: ReturnType<typeof fakeDriver> | undefined;
  try {
    const task = service.create("小改一处", {
      account: "cloudbot", ticket: "REQ2026090310", repos: [repo] });
    const state = internal.tasks.get(task.id);
    internal.queue = [];
    state.summary.status = "running";
    state.cwd = join(dataDir, "coding-clone");
    driver = fakeDriver(state);
    state.driver = driver;
    const toolResult = internal.proposeSplit(state, PROPOSAL, "call-split-1") as Promise<string>;
    await until(() => state.summary.waiting ? true : undefined, "拆分决定卡");
    const raised = service.get(task.id)!;
    const question = (raised.waiting!.question as any).questions[0];
    await service.decide(task.id, {
      state_version: raised.waiting!.state_version,
      answers: { [question.question]: DECLINE }, actor: "cloudbot",
    });
    assert.match(await toolResult, /责任人决定:不拆，一个任务干完.*不要再提议拆分/,
      "模型拿到的是一句明确的话,不是决定原文");
    const declined = service.get(task.id)!;
    assert.equal(declined.status, "running", "原地继续,零成本");
    assert.equal(declined.split_escalation?.decision, "declined");
    assert.equal(declined.requirement_analysis_requested, undefined,
      "否决后仍是普通单,不是分析单");
    assert.equal(declined.requirement_graph?.stage, "confirmed");
    assert.equal(declined.waiting, undefined);
    assert.equal(driver.calls.resumed.length, 1, "决定回注会话,而不是掐掉");
    assert.equal(driver.calls.aborted, false);
    assert.equal(state.cwd, join(dataDir, "coding-clone"), "现场不动");
    // 以后再提一律挡回去。
    assert.match(await internal.proposeSplit(state, PROPOSAL, "call-split-2"),
      /已否决/);
  } finally {
    driver?.endTurn();
    await service.shutdown();
  }
});

test("拒绝口径:子任务、多仓、已推送、非运行中都不受理,只回一句话", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-split-proposal-guard-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const internal = service as any;
  const fake = (summary: Record<string, unknown>) => ({
    summary: { status: "running", repositories: ["git@x:a/b.git"], ...summary },
    controlEpoch: 0,
  });
  try {
    assert.match(await internal.proposeSplit(fake({ parent_task_id: "task-1" }),
      { reason: "x" }, "c"), /子任务/);
    assert.match(await internal.proposeSplit(fake({ repositories: ["a", "b"] }),
      { reason: "x" }, "c"), /分析拆分单|单仓/);
    assert.match(await internal.proposeSplit(fake({ delivery: { sha: "abc" } }),
      { reason: "x" }, "c"), /已有推送/);
    assert.match(await internal.proposeSplit(fake({ status: "queued" }),
      { reason: "x" }, "c"), /queued/);
    assert.match(await internal.proposeSplit(fake({}), { reason: "   " }, "c"),
      /不能为空/);
    assert.match(await internal.proposeSplit(
      fake({ split_escalation: { decision: "declined" } }), { reason: "x" }, "c"),
      /已否决/);
    assert.equal(internal.splitTools(fake({ parent_task_id: "task-1" })).length, 0);
    assert.equal(internal.splitTools(fake({ repositories: ["a", "b"] })).length, 0);
    assert.equal(internal.splitTools(fake({})).length, 1,
      "单仓直接开发的主任务挂 propose_split");
  } finally {
    void service.shutdown();
  }
});
