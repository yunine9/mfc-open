/**
 * 检视分诊的长轴集成(ADR-0035,脚本化模型+真服务;先例
 * tests/issueFlowContract.test.ts / issueFlowFixed.helpers.ts):
 * - 提交检视只送出+递分诊,不再整体回退、不再置 review_active、不再
 *   冻结版本快照(快照时机迁到修改型申报);
 * - 纯回复型批次:respond_review 逐条落账,原地闭环——阶段/轮次不变、
 *   版本数不变、analysis_confirm 闸保持原样(不是二次确认)、流程照常
 *   可推进;
 * - 含修改型批次:declare_review_rework 触发原回退链路(轮次+1、
 *   reviews/ 出新快照、意见清单重注入),重写后修改型意见逐条 respond
 *   交代、报告不带「检视意见回应」段(ADR-0036),submit_analysis 后
 *   确认卡照旧;
 * - 混合批次:按修改型处理,回复型意见在分诊回合逐条 respond,修改型
 *   意见在重写后逐条 respond。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { ANALYSIS_DOC_NAME } from "../src/issueFlow/documents.ts";
import {
  addReview,
  renderReviewNotes,
  renderReviewThread,
  reviewStore,
  snapshotAnalysisVersion,
  submitReviews,
} from "../src/issueFlow/reviews.ts";
import { listAnalysisVersions } from "../src/issueFlow/analysisVersions.ts";
import { importExternalReviews } from "../src/externalReviewInbox.ts";
import { mfcTemp } from "./mfcTmp.ts";
import {
  bareOrigin,
  fastPoll,
  TICKET,
  until,
} from "./issueFlowFixed.helpers.ts";

const REPORT_V1 = "# 问题分析\n\n## 问题现象\n压测登录超时。\n"
  + "## 问题根因\n连接池耗尽。\n## 修改方案\n超时回收。\n"
  + "\n## 置信度\n高。\n";

/** 开一局跑到「分析确认闸」挂起的真服务:剧本前七幕与全链契约测试
 * 同款(拉单→拉仓→写报告→submit_analysis);后续幕由各用例续写。 */
async function bootToConfirmGate() {
  const dataDir = mfcTemp("mfc-issue-triage-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      `cat > issue-analysis.md <<'EOF'\n${REPORT_V1}EOF` } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
  });
  const created = service.create({
    account: "dev",
    title: "登录超时",
    description: "压测环境登录超时,疑似连接池耗尽",
    ticket: TICKET,
    source: "dts",
    repoUrl: origin,
    environment: {
      hosts: ["192.0.2.8"],
      backendPassword: "env-shared-secret",
    },
  });
  await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      ? issue : undefined;
  }, "首轮分析确认闸");
  const root = join(dataDir, "issues", created.id);
  return { service, model, id: created.id, root, script };
}

/** 等一个状态谓词成立,失败时把服务错误带出来。 */
async function waitIssue(
  service: IssueFlowService,
  id: string,
  what: string,
  predicate: (issue: ReturnType<IssueFlowService["get"]>) => boolean,
) {
  return until(() => {
    const issue = service.get(id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return predicate(issue) ? issue : undefined;
  }, what);
}

function snapshotCount(root: string): number {
  const dir = join(root, "reviews");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.startsWith("issue-analysis@")).length;
}

test("纯回复型批次:提交后原地分诊——不回退、版本数不变、逐条 respond 落账、确认卡原样保留、流程照常可推进", async () => {
  const { service, model, id, root } = await bootToConfirmGate();
  try {
    const before = service.get(id);
    const gateBefore = before.gate!;
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "为什么断定是连接池而不是带宽?",
    });
    service.addReview(id, {
      line: 5, anchor: "超时回收。", note: "这个方案已在线上验证过吗?",
    });
    // 分诊回合的剧本先就位(linear 模式按请求序取幕,幕到晚了会重放
    // 旧幕):AI 逐条 respond 后收嘴。
    model.script.push({ tool: { name: "respond_review", input: {
      items: [
        { review: 1, reply: "压测日志显示连接等待超时,带宽利用率仅 40%,已排除带宽。",
          outcome: "not_fixed" },
        { review: 2, reply: "尚未线上验证,需要你确认是否接受仿真环境结论。",
          outcome: "needs_clarification" },
      ],
    } } });
    model.script.push({ text: "已逐条回复两条意见,报告无需改动。" });
    const result = service.submitReviews(id);
    assert.match(result.stage_note, /已接收 2 条/);

    // 分诊回合:意见清单+分诊准则进模型。
    const triageRequest = await until(() => model.requests[7]
      ? JSON.stringify(model.requests[7]) : undefined, "分诊回合派出");
    assert.match(triageRequest, /回复型/);
    assert.match(triageRequest, /修改型/);
    assert.match(triageRequest, /意见1/);
    assert.match(triageRequest, /respond_review/);

    // 回合收口:回到同一张确认卡(不是重举的新卡,也不是二次确认)。
    const settled = await waitIssue(service, id, "分诊回合收口回确认卡",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");
    assert.equal(settled.gate!.id, gateBefore.id,
      "analysis_confirm 闸保持原样:用户只是插了问话,待确认状态保留");
    assert.equal(settled.gate!.state_version, gateBefore.state_version);

    // 不回退:阶段/轮次/段状态原地不动;不置 review_active。
    assert.equal(settled.stage, "analyze");
    assert.equal(settled.round, 1);
    assert.deepEqual(settled.stage_states, before.stage_states);
    assert.equal(settled.review_active, undefined,
      "纯回复型不置 review_active(不进入检视重写态)");

    // 不出版本:reviews/ 无快照,版本投影只有 live 一版。
    assert.equal(snapshotCount(root), 0, "纯回复型批次不冻结版本快照");
    const versions = listAnalysisVersions(root);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].snapshot, undefined);

    // respond 逐条落账:回复原文在 summary,outcome 按语义。
    const reviews = service.listReviews(id).reviews;
    const answered = reviews.filter((item) => item.response);
    assert.equal(answered.length, 2, "两条意见都有 AI 回复");
    assert.match(answered[0].response!.summary, /带宽利用率仅 40%/);
    assert.equal(answered[0].response!.outcome, "not_fixed");
    assert.equal(answered[1].response!.outcome, "needs_clarification");

    // 流程照常可推进:确认后照旧进问题修复。
    service.answer(id, {
      state_version: settled.gate!.state_version, code: "confirm",
    });
    await waitIssue(service, id, "确认后进入问题修复",
      (issue) => issue.stage === "fix");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("含修改型批次:declare_review_rework 触发整体回退重写——轮次+1、此刻才快照出版本、确认卡照旧", async () => {
  const { service, model, id, root, script } = await bootToConfirmGate();
  try {
    const gateBefore = service.get(id).gate!;
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "补上连接池打满的监控证据,并修订方案",
    });
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 1 }],
      reason: "根因依据缺口必须补测,方案要连带修订",
    } } });
    // 重写版是干净纸面(ADR-0036):应答不进报告,交代走 respond_review。
    model.script.push({ tool: { name: "bash", input: { command:
      "cat > issue-analysis.md <<'EOF'\n"
      + REPORT_V1.replace("连接池耗尽。", "连接池耗尽(已补监控证据)。")
      + "EOF" } } });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 1, reply: "已补连接池打满时的监控证据,方案同步修订为监控告警+提前回收。",
        outcome: "fixed", evidence: ["已核连接池打满时的监控日志,出处随文标注"] }],
    } } });
    model.script.push({ tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽(已补证据)" } } });
    model.script.push({ text: "修订版已重新提交,等待确认。" });
    service.submitReviews(id);
    assert.match(JSON.stringify(script[8]), /issue-analysis\.md/,
      "申报后平台注入意见清单,AI 据此整份重写");

    const settled = await waitIssue(service, id, "重写后重举确认卡",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm"
        && issue.gate!.id !== gateBefore.id);

    // 原回退链路照旧:回退问题分析、轮次+1。
    assert.equal(settled.stage, "analyze");
    assert.equal(settled.round, 2, "修改型回退,分析轮次+1");
    assert.match(settled.stage_note ?? "", /用户检视分析报告,提交 1 条修订意见/,
      "回退措辞沿用「用户检视分析报告…」措辞族");
    // 申报时刻才快照:reviews/ 出新快照,版本账 +1(初版=冻结版)。
    assert.equal(snapshotCount(root), 1, "版本快照随修改型申报落账");
    const versions = listAnalysisVersions(root);
    assert.ok(versions.length >= 2, "冻结版+最新版两版在账");
    assert.ok(versions[0].snapshot, "初版带 reviews/ 快照");
    // 回退轮次账进转移账(第 N 轮)。
    const state = JSON.parse(readFileSync(join(root, "issue.json"), "utf-8"));
    assert.ok((state.transitions as Array<{ note: string }>).some((item) =>
      /第 2 轮:用户检视分析报告/.test(item.note)),
      "回退转移账带轮次与措辞族");
    // 检视回复落账在意见处(ADR-0036):修改型意见重写后逐条 respond,
    // 报告本身不带应答段。
    const answered = service.listReviews(id).reviews
      .find((item) => item.seq === 1)?.response;
    assert.equal(answered?.outcome, "fixed", "修改型意见重写后逐条 respond 交代");
    assert.match(answered?.summary ?? "", /监控证据/);
    assert.equal(readFileSync(join(root, ANALYSIS_DOC_NAME), "utf-8")
      .includes("检视意见回应"), false, "重写版报告不带「检视意见回应」段");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("混合批次:按修改型回退重写,回复型在分诊回合逐条 respond,修改型在重写后逐条 respond 交代", async () => {
  const { service, model, id, root } = await bootToConfirmGate();
  try {
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "连接池配的是多大?",
    });
    service.addReview(id, {
      line: 5, anchor: "超时回收。", note: "方案改成连接池扩容+超时回收双管齐下",
    });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 1, reply: "当前连接池 50,压测并发 200。", outcome: "not_fixed" }],
    } } });
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 2 }], reason: "方案本身要改,须整份重写",
    } } });
    // 修改型意见不在分诊回合冒充已回复:respond 在申报与重写之后
    // (linear 剧本按请求序取幕,顺序即回合时序);报告是干净纸面。
    model.script.push({ tool: { name: "bash", input: { command:
      "cat > issue-analysis.md <<'EOF'\n"
      + REPORT_V1.replace("超时回收。", "连接池扩容+超时回收。")
      + "EOF" } } });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 2, reply: "方案已改为连接池扩容+超时回收双管齐下。",
        outcome: "fixed", evidence: ["修改方案:扩容+回收"] }],
    } } });
    model.script.push({ tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案已扩容" } } });
    model.script.push({ text: "混合批处理完,等待确认。" });
    service.submitReviews(id);

    const settled = await waitIssue(service, id, "混合批次重写收口",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" && issue.round === 2);
    assert.equal(settled.stage, "analyze");
    assert.equal(snapshotCount(root), 1, "混合批次出版本");
    const reviews = service.listReviews(id).reviews;
    assert.equal(reviews.find((item) => item.seq === 1)?.response?.outcome,
      "not_fixed", "回复型意见在混合批次里也逐条 respond");
    assert.equal(reviews.find((item) => item.seq === 2)?.response?.outcome,
      "fixed", "修改型意见在重写后逐条 respond 交代(ADR-0036)");
    assert.equal(readFileSync(join(root, ANALYSIS_DOC_NAME), "utf-8")
      .includes("检视意见回应"), false, "重写版报告不带「检视意见回应」段");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("提交检视不再即时快照:两批提交零快照;申报时刻冻结的批次窗口仍把意见对回它锚定的版本", () => {
  const root = mfcTemp("mfc-issue-triage-snapshot-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v1\n\n根因一。\n");
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "问一句" });
  submitReviews(root);
  assert.equal(snapshotCount(root), 0, "提交检视不冻结快照(ADR-0035)");
  assert.deepEqual(listAnalysisVersions(root).map((entry) => entry.name), ["初版"]);
  assert.equal(listAnalysisVersions(root)[0].snapshot, undefined);

  // 第二批照旧只送出:提交与快照彻底脱钩。
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "再补证据" });
  submitReviews(root);
  assert.equal(snapshotCount(root), 0);

  // 修改型申报时刻才冻结:两批意见都锚在这份未被改动的报告上。
  snapshotAnalysisVersion(root);
  assert.equal(snapshotCount(root), 1);
  let versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版"],
    "快照与 live 同文时由快照条代表(修订版尚不存在)");
  assert.equal(versions[0].review_ids.length, 2,
    "批次窗口接得住新时机:两批意见都对回冻结版");

  // AI 重写后:修订1=live,初版锚两批意见,存量口径不变。
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v2\n\n根因已修订。\n");
  versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版", "修订1"]);
  assert.equal(versions[0].review_ids.length, 2);
  assert.deepEqual(versions[1].review_ids, [], "最新版是干净纸面");
});

test("分诊渲染:triage 版意见清单不预设重写(无重写契约);修改版改为逐条 respond 交代,报告不带应答段(ADR-0036)", () => {
  const root = mfcTemp("mfc-issue-triage-render-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告\n\n根因:重试无上限。\n");
  const first = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  const second = addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  const sent = submitReviews(root);
  assert.equal(sent.length, 2);

  // 修改版(默认):逐条 respond 交代护栏与 submit_analysis 收尾在
  // (ADR-0036),报告正文不再要应答段。
  const rework = renderReviewNotes([second, first], "登录超时", 2);
  assert.match(rework, /respond_review/);
  assert.match(rework, /不许漏号/);
  assert.match(rework, /已回复过的不必重发/);
  assert.match(rework, /保持干净纸面/);
  assert.match(rework, /重新 submit_analysis/);
  assert.match(rework, /第 2 轮/);
  // 应答段指令已删(ADR-0036),护栏只反向点名禁写。
  assert.doesNotMatch(rework, /开头加一段「检视意见回应」/);
  assert.match(rework, /不写「检视意见回应」/);

  // 分诊版:清单与定位护栏在,重写契约让位分诊准则(在提示词资产里)。
  const triage = renderReviewNotes([second, first], "登录超时", 1, "triage");
  assert.match(triage, new RegExp(`意见1\\. \\[${first.id}\\]`));
  assert.match(triage, /要求:加重试上限/);
  assert.match(triage, /以原文为准定位/, "定位护栏两版共用");
  assert.doesNotMatch(triage, /请按意见修订报告与方案/, "分诊版不预设整批重写");
  assert.doesNotMatch(triage, /「检视意见回应」/);
  assert.doesNotMatch(triage, /重新 submit_analysis/);
});

test("检视回复环(账本):用户回复留档快照旧回执并清空,未处理前不能叠,AI 同 revision 重新 respond 接上", () => {
  const root = mfcTemp("mfc-issue-reply-ledger-");
  addReview(root, { author: "dev", line: 3, anchor: "连接池耗尽", note: "为什么断定是连接池?" });
  submitReviews(root);
  const store = reviewStore(root);
  const item = store.list()[0];
  store.respond(item.id, {
    outcome: "needs_clarification", summary: "请提供压测并发数与连接池配置", evidence: [],
  });

  // 用户在意见处回复:留档并快照所回应的回执,当前回执清空。
  const replied = store.replyToResponse(item.id, "并发 200,连接池 50。", "dev");
  assert.equal(replied.response, undefined, "回执清空,球踢回 Agent");
  assert.equal(replied.status, "sent", "意见保持已提交态,respond_review 仍可定位");
  assert.equal(replied.author_replies?.length, 1);
  assert.equal(replied.author_replies?.[0].text, "并发 200,连接池 50。");
  assert.equal(replied.author_replies?.[0].response.summary, "请提供压测并发数与连接池配置",
    "被回应的旧回执快照在回复处,清空后仍可见");
  assert.equal(replied.author_replies?.[0].revision, 0);

  // 上一条回复未被 AI 处理前不能叠。
  assert.throws(() => store.replyToResponse(item.id, "再补一句", "dev"),
    /等它处理/);

  // AI 按 thread 重新 respond(同 revision):新回执接上,留档不动。
  const again = store.respond(item.id, {
    outcome: "not_fixed", summary: "并发 200 配 50 连接池在正常配比内,无需改动", evidence: [],
  });
  assert.equal(again.response?.summary, "并发 200 配 50 连接池在正常配比内,无需改动");
  assert.equal(again.author_replies?.length, 1, "旧回复留档不因新回执丢失");

  // 线程渲染:意见原文 + 「你的回复 → 用户的回复」按序齐全。
  const thread = renderReviewThread(again);
  assert.match(thread, /意见1\./);
  assert.match(thread, /要求:为什么断定是连接池\?/);
  assert.match(thread, /你的回复.*请提供压测并发数与连接池配置/);
  assert.match(thread, /用户的回复.*并发 200,连接池 50。/);
  assert.match(thread, /你的回复.*正常配比内/);
  assert.throws(() => renderReviewThread({ ...again, seq: undefined } as never),
    /无号即坏账/);
});

test("检视回复环(服务):意见处就地回复唤醒 AI 再答复——线程进模型、新回执落账、确认卡保持原样", async () => {
  const { service, model, id } = await bootToConfirmGate();
  try {
    const gateBefore = service.get(id).gate!;
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "为什么断定是连接池而不是带宽?",
    });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 1, reply: "请提供压测并发数与连接池配置。",
        outcome: "needs_clarification" }],
    } } });
    model.script.push({ text: "已回复意见1,等待用户补充。" });
    service.submitReviews(id);
    await waitIssue(service, id, "分诊回合回复落账",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm"
        && !!service.listReviews(id).reviews.find((item) => item.seq === 1)?.response);

    // 用户在意见处就地回复(needs_clarification 的补充说明走同一入口)。
    // 答复回合的剧本先就位(linear 模式按请求序取幕)。
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 1, reply: "并发 200 配 50 连接池在正常配比内,已排除连接池问题。",
        outcome: "not_fixed" }],
    } } });
    model.script.push({ text: "已按用户的补充重新答复意见1。" });
    const requestsBefore = model.requests.length;
    const result = service.replyToReview(id, 1, "并发 200,连接池 50。");
    assert.match(result.stage_note ?? "", /意见1/);

    // 答复回合:回复线程递给 AI(回复环准则+完整线程),不是重新分诊全批。
    const replyRequest = await until(() => {
      const found = model.requests.slice(requestsBefore)
        .find((request) => JSON.stringify(request).includes("用户的回复"));
      return found ?? undefined;
    }, "答复回合派出");
    // 请求体带着完整会话历史(早期分诊词在场),只看最新一条用户消息。
    const messages = (replyRequest.messages as Array<{ content: unknown }>);
    const latestUserMessage = JSON.stringify(messages.at(-1));
    assert.match(latestUserMessage, /\[检视回复\]/);
    assert.match(latestUserMessage, /意见1\./);
    assert.match(latestUserMessage, /你的回复.*请提供压测并发数与连接池配置/);
    assert.match(latestUserMessage, /用户的回复.*并发 200,连接池 50。/);
    assert.doesNotMatch(latestUserMessage, /\[检视意见分诊\]/,
      "回复环不重走全批分诊");

    // 收口:新回执落账,留档线程完整,确认卡保持原样。
    const settled = await waitIssue(service, id, "答复回合收口回确认卡",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm"
        && service.listReviews(id).reviews.find((item) => item.seq === 1)
          ?.response?.outcome === "not_fixed");
    assert.equal(settled.gate!.id, gateBefore.id, "确认卡保持原样");
    const thread = service.listReviews(id).reviews.find((item) => item.seq === 1)!;
    assert.equal(thread.response!.summary.includes("已排除连接池问题"), true);
    assert.equal(thread.author_replies?.length, 1);
    assert.equal(thread.author_replies?.[0].text, "并发 200,连接池 50。");
    assert.equal(thread.author_replies?.[0].response.outcome, "needs_clarification");

    // 协作流留痕:回复以用户插话气泡回放。
    const conversation = service.conversation(id);
    assert.ok(conversation.items.some((item) =>
      item.kind === "steer" && item.text.includes("回复了意见1")),
    "回复在协作流留痕(steer 气泡)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("意见清单快照(#366):提交检视落 reviews/review-notes.md,装全部可引用意见而非仅本批;清单自带恢复源指路", async () => {
  const { service, model, id, root } = await bootToConfirmGate();
  try {
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "第一批意见:补压测数据。",
    });
    model.script.push({ text: "第一批收到,等一并分诊。" });
    service.submitReviews(id);
    await waitIssue(service, id, "第一批分诊回合收口",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");

    const firstRound = readFileSync(
      join(root, "reviews", "review-notes.md"), "utf-8");
    assert.match(firstRound, /第一批意见:补压测数据/);
    assert.match(firstRound, /reviews\/review-notes\.md/,
      "清单渲染自带恢复源指路(#366)");

    // 第二批提交后快照覆写为全集:第一批意见不丢(不是「仅当前批」)。
    service.addReview(id, {
      line: 5, anchor: "超时回收。", note: "第二批意见:说清回滚。",
    });
    model.script.push({ text: "第二批收到,等一并分诊。" });
    service.submitReviews(id);
    await waitIssue(service, id, "第二批分诊回合收口",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");
    const full = readFileSync(
      join(root, "reviews", "review-notes.md"), "utf-8");
    assert.match(full, /第一批意见:补压测数据/, "跨批次意见都在快照里");
    assert.match(full, /第二批意见:说清回滚/);
    assert.match(full, /共 2 条意见/, "快照装全部可引用意见(意见号全集)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("unknown_ref 回执(#366):引用不存在的意见号,打回附全部可引用意见摘要(台账 id/位置/要求)与快照指路", async () => {
  const { service, model, id } = await bootToConfirmGate();
  try {
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "为什么断定是连接池?",
    });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 9, reply: "先猜一条", outcome: "not_fixed" }],
    } } });
    model.script.push({ text: "打回收到,不再凭空编号。" });
    service.submitReviews(id);
    const receipt = await until(() => {
      const hit = model.requests.map((request) => JSON.stringify(request))
        .find((text) => text.includes("不在可引用意见里"));
      return hit ?? undefined;
    }, "unknown_ref 回执回到模型");
    assert.match(receipt, /意见1 \[an-/, "摘要带台账 id,可改用 id 精确引用");
    assert.match(receipt, /为什么断定是连接池/, "摘要带要求原文线索");
    assert.match(receipt, /reviews\/review-notes\.md/, "回执指路快照全文");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("unknown_seq 打回同款带正文(#366);申报成功后快照以 rework 契约覆写,轮次与注入清单一致", async () => {
  const { service, model, id, root } = await bootToConfirmGate();
  try {
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "补监控证据并修订方案",
    });
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 9 }],
      reason: "幻觉意见号,先吃一次打回",
    } } });
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 1 }],
      reason: "根因依据缺口必须补测,方案要连带修订",
    } } });
    model.script.push({ tool: { name: "bash", input: { command:
      "cat > issue-analysis.md <<'EOF'\n"
      + REPORT_V1.replace("连接池耗尽。", "连接池耗尽(已补监控证据)。")
      + "EOF" } } });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 1, reply: "已补监控证据,方案同步修订。",
        outcome: "fixed", evidence: ["监控日志出处随文标注"] }],
    } } });
    model.script.push({ tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽(已补证据)" } } });
    model.script.push({ text: "修订版已重新提交,等待确认。" });
    service.submitReviews(id);

    const receipt = await until(() => {
      const hit = model.requests.map((request) => JSON.stringify(request))
        .find((text) => text.includes("不在本批待分诊意见里"));
      return hit ?? undefined;
    }, "unknown_seq 回执回到模型");
    assert.match(receipt, /意见1 \[an-/, "unknown_seq 同款附摘要");
    assert.match(receipt, /reviews\/review-notes\.md/);

    await waitIssue(service, id, "重写后重举确认卡",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");

    // 幻觉申报不落版本快照;成功的申报才快照(+1)。
    assert.equal(snapshotCount(root), 1, "版本快照只随成功申报冻结");
    const notes = readFileSync(
      join(root, "reviews", "review-notes.md"), "utf-8");
    assert.match(notes, /不许漏号/, "快照已按 rework 契约覆写");
    assert.match(notes, /第 2 轮/, "快照轮次与注入清单口径一致(回退后)");
    assert.match(notes, /补监控证据并修订方案/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("MR 检视意见申报回退被打回:护栏指路修码重推/直接作答,不触发整体回退(ADR-0052)", async () => {
  const { service, model, id, root, script } = await bootToConfirmGate();
  try {
    // 造一条外部批注(MR 检视意见,同监看同步形状:draft 态、带 scope)。
    importExternalReviews(reviewStore(root), {
      scope: "http://git.example/r/repo.git:3",
      mrUrl: "http://git.example/r/repo.git/-/merge_requests/3",
      owner: "dev",
      items: [{ id: "E1", body: "这个函数有空指针风险",
        author: "检视人老王", file: "src/LoginService.java", line: 42 }],
    });
    const note = reviewStore(root).list()
      .find((item) => item.external_review?.discussion_id === "E1")!;
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: note.seq! }], reason: "意见要改代码,想走回退",
    } } });
    model.script.push({ text: "收到,按指路处理。" });
    service.submitReviews(id, [note.id]);

    const receipt = await until(() => {
      const hit = model.requests.map((request) => JSON.stringify(request))
        .find((text) => text.includes("没有报告回退"));
      return hit ?? undefined;
    }, "护栏打回文本回到模型");
    assert.match(receipt, /同一修复分支/, "指路修码重推");
    assert.match(receipt, /respond_review/, "指路直接作答");

    const settled = await waitIssue(service, id, "分诊回合收口",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");
    // 申报未执行:不回退、不出版本、闸保持原样。
    assert.equal(settled.round, 1, "不回退,轮次不动");
    assert.equal(settled.stage, "analyze");
    assert.equal(snapshotCount(root), 0, "护栏打回不冻结版本快照");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("交办分节:外部意见配 MR 话术、报告意见配报告话术,混合批次两节拼接(ADR-0052)", async () => {
  const { service, model, id, root, script } = await bootToConfirmGate();
  try {
    const reported = service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "连接池配的是多大?",
    });
    importExternalReviews(reviewStore(root), {
      scope: "http://git.example/r/repo.git:3",
      mrUrl: "http://git.example/r/repo.git/-/merge_requests/3",
      owner: "dev",
      items: [{ id: "E1", body: "这里建议加监控埋点",
        author: "检视人老李", file: "src/Pool.java", line: 7 }],
    });
    const external = reviewStore(root).list()
      .find((item) => item.external_review?.discussion_id === "E1")!;
    model.script.push({ text: "分诊收到,逐条处理。" });
    // 混合批次:报告意见与外部意见一批交办(外部必须显式列 id)。
    service.submitReviews(id, [reported.id, external.id]);

    const injected = await until(() => {
      const hit = model.requests.map((request) => JSON.stringify(request))
        .find((text) => text.includes("MR 检视意见分诊"));
      return hit ?? undefined;
    }, "MR 话术注入");
    assert.match(injected, /分析报告提交了 1 条/,
      "同批报告意见保留报告检视话术(review.triage)");
    assert.match(injected, /不要调 declare_review_rework/,
      "MR 话术自带边界提示");
    assert.match(injected, /这里建议加监控埋点/, "外部意见正文在清单里");
    // 事件落账是整批口径:count=2。
    const settled = await waitIssue(service, id, "分诊回合收口",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");
    assert.equal(settled.round, 1);
    // 投递账与回合汇总账(ADR-0053):交办通知进了哪条路、回合怎么收口,
    // 只凭 audit/ 账面可答。
    const deliveryRows = readFileSync(join(root, "audit", "delivery.jsonl"),
      "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const injectedRow = deliveryRows.find((row: any) =>
      row.kind === "delivery.turn" && row.decision === "started"
      && /分析报告提交了 1 条/.test(row.msg));
    assert.ok(injectedRow, "投递账记交办通知与判定分支");
    assert.ok(injectedRow.turn_id?.startsWith("t-"), "投递行带回合关联 id");
    const canonicalRows = readFileSync(join(root, "audit", "canonical.jsonl"),
      "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(canonicalRows.some((row: any) =>
      row.kind === "canonical.turn" && row.turn_id === injectedRow.turn_id),
      "回合收口汇总行与投递行同 turn_id");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
