/**
 * 归档冻结 metrics.json(工单 #325,ADR-0042):会话到达任一终态
 * (交付归档/取消/失败)的那一刻,平台把全部事实账投影计算一次,
 * 冻结成会话目录下的只读快照——此后不再变。
 *
 * 覆盖:
 * 1. 事实投影逐字段断言(纯构建函数直测:仓数/推送/检视三口径/
 *    版本数/验证失败数/红灯处置结局/外部头观测/阶段耗时/答卡/
 *    回退/MR 事实/端到端时长);
 * 2. 交付归档、取消、失败三种终态各自生成快照(经服务公开路);
 * 3. 降级:投影中途抛错(账损坏现场)→ 收口照常完成,缺项标
 *    「不可得」,其余照写;
 * 4. 只生成一次:同一会话重复触发终态路径,快照内容一字不变;
 * 5. 一次率两轴与统计取数行为不变(本单不接读侧)。
 *
 * 范式与 issueMergeArchive 同款:种子现场直接写 issue.json 与各账,
 * 服务构造即走恢复路径,只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { GATE_OPTIONS } from "../src/issueFlow/stageRegistry.ts";
import {
  FIXED_TICKET_STAGES,
  VERIFY_FAIL_NOTE_PREFIX,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import {
  buildIssueMetricsSnapshot,
  ISSUE_METRICS_FILE,
  ISSUE_METRICS_SCHEMA_VERSION,
  type IssueMetricsSnapshot,
  type IssueMetricsUnavailable,
} from "../src/issueFlow/metricsSnapshot.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-3001";
const R1 = "http://git.test/r1.git";
const R2 = "http://git.test/r2.git";
const BRANCH = `master_dev_${TICKET}`;

const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

async function until<T>(probe: () => T | undefined, what: string,
  timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const isUnavailable = (value: unknown): value is IssueMetricsUnavailable =>
  Boolean(value) && typeof value === "object"
  && typeof (value as IssueMetricsUnavailable).unavailable === "string";

/** 断言数值段未被降级并取出。 */
function asNumber(value: number | IssueMetricsUnavailable, what: string)
  : number {
  if (isUnavailable(value)) {
    assert.fail(`${what} 不该降级,却标了:${value.unavailable}`);
  }
  return value;
}

function readSnapshot(root: string): IssueMetricsSnapshot {
  const path = join(root, ISSUE_METRICS_FILE);
  assert.ok(existsSync(path), `快照应存在:${path}`);
  return JSON.parse(readFileSync(path, "utf-8")) as IssueMetricsSnapshot;
}

// ---- 种子现场:一份带全部账面事实的会话 ----

interface SeedOptions {
  id?: string;
  status?: IssueSessionState["status"];
  /** 有单五阶段里 mr_green 的下标(种子阶段表用)。 */
  conclusion?: IssueSessionState["conclusion"];
  error?: string;
  /** MR 全部合入(交付归档路的前置)。 */
  allMerged?: boolean;
  /** 挂一张未答的「流水线不可修」卡(waiting_user 现场)。 */
  unfixableGate?: boolean;
  /** 反馈账中段写一行坏 JSON(降级现场)。 */
  corruptFeedback?: boolean;
  /** 检视账读取必炸(降级现场:目录顶替账本文件)。 */
  corruptReviews?: boolean;
}

/** 全部种子时刻由 base 派生(分钟偏移),阶段耗时与端到端时长可精确断言。 */
function seedFacts(dataDir: string, options: SeedOptions = {}): {
  root: string; id: string; base: number;
} {
  const id = options.id ?? "issue-1";
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  const base = Date.now() - 120 * 60_000;
  const at = (minutes: number) =>
    new Date(base + minutes * 60_000).toISOString();
  const sha12 = (prefix: string) => prefix.repeat(12);
  const MR_GREEN = FIXED_TICKET_STAGES.indexOf("mr_green");
  const latestSha = "f".repeat(40);
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev", reporter: "dev",
    created_at: at(0), updated_at: at(115),
    title: "快照字段夹具", description: "", source: "dts", ticket: TICKET,
    repo_url: R1, repo_urls: [R1, R2],
    scenario: "ticket", round: 2,
    stage_states: FIXED_TICKET_STAGES.map((_, index) =>
      index === MR_GREEN ? "in_progress" : "done"),
    status: options.status ?? "idle",
    stage: "mr_green", stage_note: "", stage_at: at(110),
    pushes: [{ repo: R1, branch: BRANCH, sha: latestSha, at: at(85) }],
    mrs: [{
      repo: R1, branch: BRANCH, target: "master",
      title: `[${TICKET}] 快照字段夹具`,
      url: "http://git.test/mr/1", iid: "1", at: at(90),
      merged_at: at(112), merged_sha: "ab".repeat(20),
    }, {
      repo: R2, branch: BRANCH, target: "master",
      title: `[${TICKET}] 快照字段夹具(二仓)`,
      url: "http://git.test/mr/2", iid: "2", at: at(91),
      ...(options.allMerged
        ? { merged_at: at(113), merged_sha: "cd".repeat(20) }
        : { closed_at: at(113) }),
    }],
    pipelines: {
      [R1]: {
        sha: sha12("c"), status: "failed", watching: false,
        started_at: at(60), deadline: at(120), round: 1, reds: 1,
      },
    },
    ...(options.unfixableGate ? {
      gate: {
        id: "gate-unfix-1",
        kind: "pipeline_unfixable" as const,
        state_version: 1,
        question: { questions: [{
          question: "流水线失败项都是不可自动修复的工具告警,"
            + "是否已在交付平台处理/豁免?",
          options: GATE_OPTIONS.pipeline_unfixable.options,
        }] },
        pipeline: { repo: R1, sha: sha12("c") },
        created_at: at(100),
      },
    } : {}),
    ...(options.conclusion ? { conclusion: options.conclusion } : {}),
    ...(options.error ? { error: options.error } : {}),
    transitions: [
      { at: at(5), source: "platform", stage: "dts_info",
        note: "固定流程会话已登记(有单五阶段)" },
      { at: at(15), source: "platform", stage: "prep_repo", note: "进入准备" },
      { at: at(35), source: "platform", stage: "analyze", note: "进入问题分析" },
      // 推送账:转移账每笔一条(仓、分支、提交号前 12 位)。
      { at: at(40), source: "platform",
        note: `分支已推送 ${R1} ${BRANCH} @ ${sha12("a")}` },
      { at: at(45), source: "platform",
        note: `分支已推送 ${R1} ${BRANCH} @ ${sha12("b")}`
          + "(强制覆盖远端同名分支)" },
      { at: at(55), source: "platform", stage: "fix",
        note: "用户确认分析报告,进入问题修改" },
      // 红灯三种处置结局各一笔(近期提交 9a4d5f75 的转移账文案)。
      { at: at(60), source: "platform",
        note: `流水线失败(${R1})@ ${sha12("c")}` },
      { at: at(62), source: "platform",
        note: `MR 已合入,旧提交 ${sha12("d")} 的流水线随合入取消,`
          + `不作失败处理(${R1}),归档路接管` },
      { at: at(64), source: "platform",
        note: `旧提交 ${sha12("e")} 的流水线结果到达时,分支最新提交已变`
          + `为 ${sha12("f")}(${R1})——结果丢弃,不作失败处理,`
          + "检查目标跟随切换后按新提交继续" },
      // 外部头观测(c12c1cf0 的转移账文案)。
      { at: at(66), source: "platform",
        note: `分支头已被平台外提交 ${sha12("9")} 取代,`
          + `检查目标跟随切换(${R1})` },
      // 验证未通过:一次率同法的裸前缀账 + 生产形状的回退轮次账。
      { at: at(70), source: "platform",
        note: `${VERIFY_FAIL_NOTE_PREFIX}:复现仍存在` },
      { at: at(80), source: "platform", stage: "analyze",
        note: `第 2 轮:${VERIFY_FAIL_NOTE_PREFIX}:复现仍存在` },
      { at: at(100), source: "platform", stage: "fix",
        note: "用户确认分析报告,进入问题修改" },
      { at: at(110), source: "platform", stage: "mr_green",
        note: "进入提交 MR·跑绿" },
      { at: at(115), source: "platform", note: "全部 MR 合入,自动归档收口" },
    ],
  }, null, 1));
  // 检视账:两批平台检视(3 条意见)+ 一条非检视通道的送出(不计)。
  // 降级现场用目录顶替账本文件:账本读取对中间坏行自愈(跳过/截断),
  // 只有读取本身炸才触发该段降级,目录是确定性的炸法(EISDIR)。
  if (options.corruptReviews) {
    mkdirSync(join(root, "reviews.jsonl"));
  } else {
    writeFileSync(join(root, "reviews.jsonl"), [
      JSON.stringify({ op: "sent", ids: ["an-1", "an-2"],
        via: "issue_review", at: at(50), by: "dev" }),
      JSON.stringify({ op: "sent", ids: ["an-3"],
        via: "issue_review", at: at(90), by: "dev" }),
      JSON.stringify({ op: "sent", ids: ["an-9"],
        via: "interrupt", at: at(95), by: "dev" }),
    ].join("\n") + "\n");
  }
  // 分析报告版本账:一份冻结快照 + 不同于快照的 live 文件 = 2 版。
  mkdirSync(join(root, "reviews"), { recursive: true });
  writeFileSync(join(root, "reviews",
    `issue-analysis@r${(base + 52 * 60_000).toString(36)}.md`),
    "# 冻结版 v1\n");
  writeFileSync(join(root, "issue-analysis.md"), "# 最新版\n");
  // MR 评论的发现账(反馈账):2 条 MR 评论 + 1 条流水线反馈(不计)。
  mkdirSync(join(root, "feedback"), { recursive: true });
  const feedbackLine = (source: string, key: string) => JSON.stringify({
    op: "upsert",
    record: {
      id: `${source}:${key}`, batch_id: `${source}:${key}:0`,
      source, source_id: key, source_revision: 0, observed_sha: latestSha,
      summary: `[normal] ${key}`, verification: "reviewer",
      status: "open", updated_at: at(95),
    },
  });
  writeFileSync(join(root, "feedback", "index.jsonl"),
    options.corruptFeedback
      ? [feedbackLine("mr_discussion", "d1"), "{{{坏账现场:not json",
        feedbackLine("mr_discussion", "d2"),
        feedbackLine("pipeline", "p1")].join("\n") + "\n"
      : [feedbackLine("mr_discussion", "d1"),
        feedbackLine("mr_discussion", "d2"),
        feedbackLine("pipeline", "p1")].join("\n") + "\n");
  // Agent 问题卡账(waiting.json):一张已答 + 一张随终态作废。
  writeFileSync(join(root, "waiting.json"), JSON.stringify({
    records: {
      [`${id}:call-1`]: {
        waiting_id: `${id}:call-1`, task_id: id, step: "analyze",
        call_id: "call-1", question: {}, state_version: 2,
        status: "resolved", decision: "确认方案A", notes: "",
        created_at: at(30), resolved_at: at(31),
      },
      [`${id}:call-2`]: {
        waiting_id: `${id}:call-2`, task_id: id, step: "fix",
        call_id: "call-2", question: {}, state_version: 2,
        status: "superseded", decision: "",
        notes: "会话已取消,待办作废",
        created_at: at(60), resolved_at: at(61),
      },
    },
  }, null, 1));
  // 事件账:两条平台闸作答(带 gate 快照)+ 一条非闸决定(不计入闸口径)。
  const event = (eventId: number, minutes: number, payload: Record<string, unknown>) =>
    JSON.stringify({ eventId, taskId: id, sessionId: id, ts: at(minutes),
      kind: "human_decision", payload });
  writeFileSync(join(root, "events.jsonl"), [
    event(1, 50, {
      waiting_id: "gate-1", state_version: 1, decision: "确认,进入修改",
      notes: "",
      gate: { kind: "analysis_confirm", questions: [
        { question: "分析报告是否确认?", options: [] }] },
    }),
    event(2, 70, {
      waiting_id: "gate-2", state_version: 1, decision: "验证发现问题",
      notes: "",
      gate: { kind: "env_verify", questions: [
        { question: "环境验证是否通过?", options: [] }] },
    }),
    event(3, 75, {
      waiting_id: `${id}:call-1`, state_version: 2,
      decision: "确认方案A", notes: "",
    }),
  ].join("\n") + "\n");
  return { root, id, base };
}

function makeService(dataDir: string, model?: ScriptedModelServer)
  : IssueFlowService {
  return new IssueFlowService({
    dataDir,
    provider: model ? "maeflow" : "unused",
    model: model ? "scripted-v1" : "unused",
    modelsJson: model ? model.modelsJson() : {},
    settings: fastPoll,
    dts: new MockDtsGateway(),
  });
}

// ---- 1. 事实投影:纯构建函数逐字段断言 ----

test("事实投影:全部字段从现有账现算,口径分列不混算", () => {
  const dataDir = mfcTemp("mfc-issue-metrics-unit-");
  const seeded = seedFacts(dataDir, { status: "archived" });
  const { root, base } = seeded;
  const state = JSON.parse(readFileSync(join(root, "issue.json"), "utf-8")) as IssueSessionState;
  state.conclusion = { kind: "delivered", summary: "修复完成",
    at: new Date(base + 120 * 60_000).toISOString() };
  const snapshot = buildIssueMetricsSnapshot(root, state);

  assert.equal(snapshot.schema_version, ISSUE_METRICS_SCHEMA_VERSION,
    "生成版本戳");
  assert.equal(snapshot.session_id, "issue-1");
  assert.equal(snapshot.terminal_status, "archived");
  assert.equal(snapshot.ticket, TICKET);
  assert.equal(snapshot.conclusion_kind, "delivered");
  assert.equal(snapshot.created_at, state.created_at);
  assert.equal(snapshot.concluded_at, state.conclusion?.at,
    "结论时刻=结论账的 at");
  assert.equal(asNumber(snapshot.end_to_end_ms, "端到端时长"),
    120 * 60_000, "发起→结论时刻整 2 小时");
  assert.ok(snapshot.generated_at, "生成时刻在场");

  // 仓与推送:仓数来自仓清单,推送次数与提交号清单来自转移账逐笔事实,
  // 每仓最新一笔另列(state.pushes 只留每仓最新,数不出次数)。
  assert.equal(snapshot.repo_count, 2);
  assert.deepEqual(snapshot.repo_urls, [R1, R2]);
  assert.equal(snapshot.pushes.total, 2, "推送总次数按转移账逐笔计");
  assert.deepEqual(snapshot.pushes.by_repo, [{
    repo: R1, push_count: 2,
    commits: ["a".repeat(12), "b".repeat(12)],
    branches: [BRANCH],
  }], "各仓推送次数与提交号清单");
  assert.deepEqual(snapshot.pushes.latest, [{
    repo: R1, branch: BRANCH, sha: "f".repeat(40),
    at: state.pushes![0]!.at,
  }], "每仓最新推送收据原样保留");

  // 检视三口径分列:平台检视意见条数 / 检视批次数 / MR 评论条数。
  assert.equal(snapshot.reviews.platform_review_comments, 3,
    "平台检视意见条数=两批合计 3 条");
  assert.equal(snapshot.reviews.review_batches, 2,
    "检视批次数=sent/issue_review 操作数");
  assert.equal(asNumber(snapshot.reviews.mr_comments, "MR 评论条数"), 2,
    "MR 评论条数=反馈账 mr_discussion 记录数");

  assert.equal(snapshot.report_version_count, 2,
    "分析报告版本数(初版+修订1)");
  assert.equal(snapshot.verify_fail_count, 2,
    "验证未通过次数:转移账包含计(#328),裸前缀与「第 N 轮:」生产格式都算");

  // 红灯各轮处置结局三分 + 外部头观测。
  assert.deepEqual(snapshot.pipeline.red_light_rounds, {
    repaired: 1, canceled_by_merge: 1, discarded_on_head_move: 1,
  }, "修复/随合入取消/随头变丢弃各一轮");
  assert.deepEqual(snapshot.pipeline.external_head_observations, {
    count: 1,
    records: [{
      sha: "9".repeat(12),
      at: new Date(base + 66 * 60_000).toISOString(),
    }],
  }, "外部头观测:次数保留,明细=取代分支头的提交短码+发现时刻");

  assert.deepEqual(snapshot.rollbacks, {
    count: 1, reasons: [`${VERIFY_FAIL_NOTE_PREFIX}:复现仍存在`],
  }, "回退次数与原因(转移账第 N 轮条目)");

  // 阶段耗时:回退重进的阶段分段累计(dts_info 10 分、prep_repo 20 分、
  // analyze 20+20 分、fix 25+10 分、mr_green 110 分起到结论时刻 10 分)。
  assert.ok(!isUnavailable(snapshot.stage_durations_ms),
    "阶段耗时不降级");
  const durations = snapshot.stage_durations_ms as Record<string, number>;
  assert.deepEqual(durations, {
    dts_info: 10 * 60_000,
    prep_repo: 20 * 60_000,
    analyze: 40 * 60_000,
    fix: 35 * 60_000,
    mr_green: 10 * 60_000,
  }, "各阶段耗时按转移账阶段标记分段累计");

  // 答卡:平台闸作答(次数/按闸种类/答案分布)+ Agent 卡(举/答/作废)。
  assert.deepEqual(snapshot.answers.platform_gates, {
    answered: 2,
    by_kind: { analysis_confirm: 1, env_verify: 1 },
    decisions: { "确认,进入修改": 1, "验证发现问题": 1 },
  }, "平台闸答卡:非闸的 human_decision 不计入");
  assert.deepEqual(snapshot.answers.agent_cards, {
    raised: 2, answered: 1, superseded: 1,
    decisions: { "确认方案A": 1 },
  }, "Agent 问题卡:举 2 答 1 作废 1");

  // MR 事实:数量/合入/关闭与逐条记录。
  assert.equal(snapshot.mrs.total, 2);
  assert.equal(snapshot.mrs.merged, 1);
  assert.equal(snapshot.mrs.closed, 1, "关闭=未合入但已关");
  assert.deepEqual(snapshot.mrs.records, [{
    repo: R1, branch: BRANCH, target: "master",
    url: "http://git.test/mr/1", iid: "1", at: state.mrs![0]!.at,
    merged_at: state.mrs![0]!.merged_at, merged_sha: "ab".repeat(20),
  }, {
    repo: R2, branch: BRANCH, target: "master",
    url: "http://git.test/mr/2", iid: "2", at: state.mrs![1]!.at,
    closed_at: state.mrs![1]!.closed_at,
  }], "MR 事实原样投影(标题等展示字段不带)");

  // 提交归属/逐推送 diff 两层(#326 填实):要读代码现场——夹具仓是
  // 假 URL、工作区没有 repo/ 克隆,两层逐仓如实降级,其余段不受影响。
  // 逐层断言在 tests/issueMetricsAttribution.test.ts。
  assert.ok(!isUnavailable(snapshot.commit_attribution),
    "归属层本身不整层降级(逐仓降级)");
  assert.equal(snapshot.commit_attribution.by_repo.length, 2,
    "每个 MR 一条归属段");
  for (const entry of snapshot.commit_attribution.by_repo) {
    assert.ok(isUnavailable(entry), "缺现场的仓如实降级");
    assert.match(entry.unavailable, /工作区没有该仓的克隆/);
  }
  assert.ok(!isUnavailable(snapshot.per_push_diffs), "diff 层不整层降级");
  assert.equal(snapshot.per_push_diffs.by_repo.length, 1,
    "有推送账的仓一条 diff 段");
  for (const entry of snapshot.per_push_diffs.by_repo) {
    assert.ok(isUnavailable(entry), "缺现场的仓如实降级");
    assert.match(entry.unavailable, /工作区没有该仓的克隆/);
  }
});

// ---- 2. 三种终态各自生成快照 ----

test("交付归档:全部 MR 合入自动收口,快照当场冻结", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-archive-");
  const model = new ScriptedModelServer([{ text: "收到。" }], "scripted-v1",
    { linear: true });
  await model.start();
  // 不给交付平台地址:合入事实完全由账面承担,答「重新监看」即短路归档。
  const { root, id } = seedFacts(dataDir, {
    status: "waiting_user", allMerged: true, unfixableGate: true,
  });
  const service = makeService(dataDir, model);
  try {
    const gateVersion = service.get(id).gate!.state_version;
    const summary = service.answer(id, { state_version: gateVersion, code: "resume" });
    assert.equal(summary.status, "archived", "作答回执即归档");
    const snapshot = readSnapshot(root);
    assert.equal(snapshot.terminal_status, "archived");
    assert.equal(snapshot.conclusion_kind, "delivered");
    assert.equal(snapshot.pushes.total, 2);
    assert.equal(snapshot.reviews.review_batches, 2);
    assert.equal(snapshot.report_version_count, 2);
    assert.equal(snapshot.verify_fail_count, 2);
    assert.equal(snapshot.mrs.merged, 2, "全部合入是归档的前置");
    // 作答本身也进事件账:平台闸答卡 3 次(含本次不可修闸)。
    const gates = snapshot.answers.platform_gates;
    assert.ok(!isUnavailable(gates), "闸答卡段不降级");
    assert.equal(gates.answered, 3);
    assert.equal(gates.by_kind.pipeline_unfixable, 1);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("取消:control 落终态后快照生成", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-cancel-");
  const { root, id } = seedFacts(dataDir, { status: "idle" });
  const service = makeService(dataDir);
  try {
    const summary = await service.control(id, { action: "cancel" });
    assert.equal(summary.status, "canceled");
    const snapshot = readSnapshot(root);
    assert.equal(snapshot.terminal_status, "canceled");
    assert.equal(snapshot.conclusion_kind, undefined, "取消不写结论");
    assert.equal(snapshot.repo_count, 2, "取消路的事实投影照全");
    assert.equal(asNumber(snapshot.reviews.mr_comments, "MR 评论条数"), 2);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("取消带终止原因:原因与说明随终态冻结进快照,无原因取消快照不带(#541)", async () => {
  // 快照是终态时刻的冻结投影(#325,ADR-0042):取消原因与说明在场就
  // 一起冻进去,统计侧(#542/#543)只读快照不再回翻状态文件。无原因
  // 取消(历史路径)的快照不带这两个键——"缺席"本身就是兼容语义。
  const dataDir = mfcTemp("mfc-issue-metrics-cancel-reason-");
  const withReason = seedFacts(dataDir, { status: "idle", id: "issue-1" });
  const legacy = seedFacts(dataDir, { status: "idle", id: "issue-2" });
  const service = makeService(dataDir);
  try {
    await service.control("issue-1", {
      action: "cancel", reason: "other", reasonText: "等了二十分钟没有反应",
    });
    const snapA = readSnapshot(withReason.root);
    assert.equal(snapA.terminal_status, "canceled");
    assert.equal(snapA.cancel_reason, "other", "原因随终态冻结进快照");
    assert.equal(snapA.cancel_reason_text, "等了二十分钟没有反应",
      "说明随终态冻结进快照");
    await service.control("issue-2", { action: "cancel" });
    const snapB = readSnapshot(legacy.root);
    assert.equal(snapB.terminal_status, "canceled");
    assert.equal(snapB.cancel_reason, undefined, "无原因取消的快照不带原因键");
    assert.equal(snapB.cancel_reason_text, undefined, "无原因取消的快照不带有说明键");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("失败:模型回合失败落终态后快照生成", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-failed-");
  const model = new ScriptedModelServer([{ text: "(被故障顶掉)" }],
    "scripted-v1");
  await model.start();
  const { root, id } = seedFacts(dataDir, { status: "idle" });
  const service = makeService(dataDir, model);
  try {
    // 配额给足 5(大于网关自动重试 3 次),让故障穿透成终态模型错误。
    model.failWith("内部错误:测试注入的模型故障", 5);
    const replied = service.reply(id, "继续推进");
    assert.equal(replied.status, "running");
    const failed = await until(() => {
      const issue = service.get(id);
      return issue.status === "failed" ? issue : undefined;
    }, "回合失败落终态");
    assert.match(failed.error ?? "", /测试注入的模型故障/);
    const snapshot = readSnapshot(root);
    assert.equal(snapshot.terminal_status, "failed");
    assert.equal(snapshot.pushes.total, 2, "失败路的账面事实照记");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 3. 降级:投影中途抛错不阻塞收口 ----

test("降级:反馈账与检视账损坏→取消照常完成,坏账各段标不可得,其余照写", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-degrade-");
  const { root, id } = seedFacts(dataDir, {
    status: "idle", corruptFeedback: true, corruptReviews: true,
  });
  const service = makeService(dataDir);
  try {
    const summary = await service.control(id, { action: "cancel" });
    assert.equal(summary.status, "canceled", "降级不得阻塞取消");
    const snapshot = readSnapshot(root);
    assert.ok(isUnavailable(snapshot.reviews.mr_comments),
      "坏账的 MR 评论列标不可得");
    assert.match((snapshot.reviews.mr_comments as IssueMetricsUnavailable)
      .unavailable, /损坏|不可得/, "缺项说明原因");
    assert.ok(isUnavailable(snapshot.reviews.review_batches),
      "检视账读不了:批次数标不可得(不再拖垮整份快照)");
    assert.ok(isUnavailable(snapshot.reviews.platform_review_comments),
      "意见条数与批次数同一份检视账,一起降级");
    assert.equal(snapshot.report_version_count, 2,
      "版本账可读,该段照写");
    assert.equal(snapshot.verify_fail_count, 2,
      "转移账可读,验证未通过次数照写");
    assert.equal(snapshot.repo_count, 2);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 4. 只生成一次 ----

test("只生成一次:failed 之后再取消,快照内容一字不变", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-once-");
  const model = new ScriptedModelServer([{ text: "(被故障顶掉)" }],
    "scripted-v1");
  await model.start();
  const { root, id } = seedFacts(dataDir, { status: "idle" });
  const service = makeService(dataDir, model);
  try {
    model.failWith("内部错误:测试注入的模型故障", 5);
    service.reply(id, "继续推进");
    await until(() =>
      service.get(id).status === "failed" ? service.get(id) : undefined,
    "先落 failed 终态");
    const first = readFileSync(join(root, ISSUE_METRICS_FILE), "utf-8");
    // failed 的出口是取消或异常重跑(ADR-0055):第二次终态路径不得重写快照。
    const canceled = await service.control(id, { action: "cancel" });
    assert.equal(canceled.status, "canceled");
    const second = readFileSync(join(root, ISSUE_METRICS_FILE), "utf-8");
    assert.equal(second, first, "重复终态触发不重写快照(内容稳定)");
    assert.equal(readSnapshot(root).terminal_status, "failed",
      "快照定格在第一次终态");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 5. 一次率两轴与统计取数行为不变 ----

test("一次率两轴:快照接入不改变既有统计输出", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-oncerates-");
  // 两个终态会话:issue-1 完成交付(两版报告+一次验证未通过),
  // issue-2 完成交付(一版报告+零验证失败)。
  const base1 = seedFacts(dataDir, {
    id: "issue-1", status: "archived",
    conclusion: { kind: "delivered", summary: "修复完成",
      at: new Date().toISOString() },
  });
  const base2 = seedFacts(dataDir, {
    id: "issue-2", status: "archived", allMerged: true,
    conclusion: { kind: "delivered", summary: "修复完成",
      at: new Date().toISOString() },
  });
  // issue-2 改成一版报告、零验证未通过:撤掉冻结快照与验证失败账。
  const versionFile = join(base2.root, "reviews",
    `issue-analysis@r${(base2.base + 52 * 60_000).toString(36)}.md`);
  const issue2 = JSON.parse(readFileSync(join(base2.root, "issue.json"), "utf-8")) as IssueSessionState;
  issue2.transitions = issue2.transitions!.filter((item) =>
    !item.note.includes(VERIFY_FAIL_NOTE_PREFIX));
  writeFileSync(join(base2.root, "issue.json"), JSON.stringify(issue2, null, 1));
  const { rmSync } = await import("node:fs");
  rmSync(versionFile);
  const service = new IssueFlowService({
    dataDir, provider: "unused", model: "unused", modelsJson: {},
    deferRecovery: true,
    dts: new MockDtsGateway(),
  });
  try {
    service.start();
    assert.deepEqual(service.onceRates(), {
      total: 2,
      delivered: 2,
      terminated: 0,
      localization: { passed: 1, total: 2, rate: 50 },
      repair: { passed: 1, total: 2, rate: 50 },
      per_session: [
        { id: "issue-1", reviews: 2, localization_pass: false, repair_pass: false },
        { id: "issue-2", reviews: 2, localization_pass: true, repair_pass: true },
      ],
    }, "两轴口径与统计输出和接入前一致(版本数/验证失败/检视批次取数不变;#542 分母三分解 delivered/terminated 在无终止时与 total 同值)");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
