/**
 * 问题流 × CodeHub 检视意见:发现与落账(票 01,2026-09-08 立项)。
 *
 * mr_green 监看期内随流水线监看节奏逐仓拉检视讨论,新意见落问题域
 * 反馈账(工作台反馈面板可见,来源标 mr_discussion)。纪律:
 * - 增量按 discussion id,已落账的不重复;
 * - fail-open:适配层未配置/拉取失败等下一轮,绝不拖垮流水线主监看;
 * - 生命周期:stage=mr_green 且会话未终态,关停即止。
 *
 * 范式与 issueFlowFixed 同款:ScriptedModelServer 剧本 + FakeGitPlatform
 * 假交付平台(seedDiscussion 注入意见),只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { fetchMrDiscussions } from "../src/issueFlow/mrDiscussions.ts";
import { reviewStore, submitReviews } from "../src/issueFlow/reviews.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 120,
  }),
};

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`超时:${what}`);
}

/** 四章节报告(submit_analysis 的机械门票)。 */
const report = () =>
  `printf '%s\\n' '# 问题分析:登录超时' '一句话总结:连接池耗尽,扩容并回收。' \\
    '## 问题现象' '登录超时。' '## 问题根因' '连接池耗尽。' \\
    '## 修改方案' '超时回收。' \\
    '## 置信度' '高:日志直接指向。' > issue-analysis.md`;

test("检视意见发现与落账:mr_green 期内新意见进反馈账,增量不重复,失败容忍", async () => {
  const dataDir = mfcTemp("mfc-issue-disc-");
  const platform = new FakeGitPlatform();
  // 流水线先挂 running:把"意见发现/增量/失败容忍"的断言窗稳稳放在
  // 验绿收口之前,收口用 finishPipeline 显式裁定。
  platform.nextPipelineStatus = "running";
  // 假平台的多仓路由要求 origin 在它的目录辖内:用 initBare 建仓(它
  // 会从源仓灌历史并登记 barePath)。
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  // 会话基线分支要在远端在架:pull_repo 按基线克隆(#441)。
  execFileSync("git", ["-C", sourceDir, "branch", "br_V100R026C10_release"]);
  const origin = platform.initBare(sourceDir, dataDir);
  await platform.start();
  // 开演前就种下第一条意见:申报即监看,首轮拉取就该落账。
  platform.seedDiscussion({
    id: "D1", file: "src/LoginService.java", line: 42,
    severity: "major", author: "检视人老王",
    body: "这里的连接池没有超时回收,存在泄漏风险",
  });
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: report() } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    // ── 用户确认后平台回合继续:修复 → 推 → MR → 申报。 ──
    { tool: { name: "complete_stage", input: { note: "修复完成,UT 15/15" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已申报,等待流水线与检视。" },
    // ── 检视意见注入(票 02)后的修复回合:修 → 推 → 重建 MR → 重新申报。 ──
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 检视意见修复:超时回收`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "检视意见已修复,重新申报", mrs: [origin] } } },
    { text: "检视意见已修复,重新申报完成。" },
    // 备用回合(增量意见 D2/D3 各触发一次注入,一回合一句收嘴)。
    { text: "收到,继续处理。" },
    { text: "收到,继续处理。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrl: origin,
      baseline: "br_V100R026C10_release",
    });
    // 推进到分析确认闸并确认,让剧本继续走到申报。等待条件必须是
    // "已收口到 waiting_user"——闸对象在 submit_analysis 当下就进状态,
    // 但 answer() 只受理收口后的会话(并发下先答会被打回)。
    await until(() => {
      const snapshot = service.get(created.id);
      return snapshot.status === "waiting_user"
        && snapshot.gate?.kind === "analysis_confirm";
    }, "分析确认闸收口");
    const gateVersion = service.get(created.id).gate!.state_version;
    service.answer(created.id, { state_version: gateVersion, code: "confirm" });
    // 申报后监看启动,首轮拉取:D1 落反馈账(工作台可见,来源标明)。
    await until(() => {
      const feedback = service.get(created.id).feedback ?? [];
      return feedback.some((record) =>
        record.source === "mr_discussion" && record.source_id === "D1");
    }, "D1 落反馈账");
    const d1 = (service.get(created.id).feedback ?? [])
      .find((record) => record.source_id === "D1")!;
    assert.match(d1.summary, /连接池没有超时回收/);
    assert.equal(d1.file, "src/LoginService.java");
    assert.equal(d1.line, 42);
    assert.equal(d1.author, "检视人老王");
    assert.match(d1.id, /^mr-discussion:/);

    // 增量:第二条意见下一拍落账;D1 仍是恰好一条,不重复。
    platform.seedDiscussion({
      id: "D2", file: "src/Pool.java", line: 7,
      author: "检视人老李", body: "这里建议加监控埋点",
    });
    await until(() => {
      const feedback = service.get(created.id).feedback ?? [];
      return feedback.some((record) => record.source_id === "D2");
    }, "D2 落反馈账");
    // 再等一拍:轮询继续跑,D1/D2 都不翻倍。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const feedback = service.get(created.id).feedback ?? [];
    assert.equal(feedback.filter((record) => record.source_id === "D1").length, 1,
      "已落账的意见不得重复");
    assert.equal(feedback.filter((record) => record.source_id === "D2").length, 1);

    // 失败容忍:适配层抖一次 503,监看不炸;下一拍恢复后新意见照落。
    platform.discussionListFailures = 1;
    platform.seedDiscussion({
      id: "D3", file: "src/Pool.java", line: 19,
      author: "检视人老李", body: "日志级别建议降为 debug",
    });
    await until(() => {
      const feedback = service.get(created.id).feedback ?? [];
      return feedback.some((record) => record.source_id === "D3");
    }, "抖动恢复后 D3 落账");
    assert.equal(service.get(created.id).status !== "failed", true,
      "拉取失败不拖垮会话");
    // 原始观察待判断语义(原「关自动修」用例的独有断言,该用例与
    // 本条重复已于 2026-09-18 删除):意见同步后 status=open。
    assert.equal((service.get(created.id).feedback ?? [])
      .find((item) => item.source_id === "D1")?.status, "open");

    // 原始意见只同步待判断批注，责任人交办前意见正文不进任何模型请求。
    assert.doesNotMatch(JSON.stringify(model.requests), /连接池没有超时回收/);
    // ── 票 03:交办 → AI respond → 出站信箱 → 发送 CodeHub(ADR-0052
    // 单通道:AI 经 respond_review 落面板账,平台按 responded_at 代发)。 ──
    const issueDir = join(dataDir, "issues", created.id);
    const d1Note = reviewStore(issueDir).list()
      .find((item) => item.external_review?.discussion_id === "D1")!;
    submitReviews(issueDir, [d1Note.id]);
    reviewStore(issueDir).respond(d1Note.id,
      { outcome: "fixed", summary: "已修复连接池回收", evidence: [] });

    const d1Discussion = platform.discussions.find((item) => item.id === "D1")!;
    await until(() => d1Discussion.replies.length > 0, "D1 回复已发送 CodeHub");
    assert.match(d1Discussion.replies[0], /已修复/);
    // 幂等:继续轮询几拍,已发送的不重发。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(d1Discussion.replies.length, 1, "重放不得产生第二条回复");

    // 检视人解决讨论 → 意见闭环标注(发送未带 resolve,归因=检视人)。
    d1Discussion.resolved = true;
    await until(() => {
      const record = (service.get(created.id).feedback ?? [])
        .find((item) => item.source_id === "D1");
      return record?.status === "closed";
    }, "D1 闭环标注");
    assert.match(
      (service.get(created.id).feedback ?? [])
        .find((item) => item.source_id === "D1")!.resolution ?? "",
      /检视人已在 CodeHub 解决/);

    // SHA 漂移终态(检视闭环 ② 改语义):直写信箱构造"绑定旧提交"的
    // pending——版本对不上直接标失败("请重写"),不再永远 pending;
    // 失败不挡新回应,重新 respond 后照常发送。
    const outboxPath = join(issueDir, "mr-review-outbox.json");
    writeFileSync(outboxPath, JSON.stringify({ items: [{
      id: "mrr-drift-test", repo: origin, discussion_id: "D2",
      body: "已补监控埋点", resolve: false,
      expected_sha: "0".repeat(40), status: "pending", attempts: 0,
      created_at: new Date().toISOString(),
    }] }));
    const d2 = platform.discussions.find((item) => item.id === "D2")!;
    await until(() => {
      const outbox = JSON.parse(readFileSync(outboxPath, "utf-8"));
      const item = outbox.items.find((entry: any) =>
        entry.discussion_id === "D2");
      return item?.status === "failed"
        && /代码已更新|重写/.test(String(item.last_error ?? ""));
    }, "SHA 漂移直接标失败(不再永远 pending)");
    assert.equal(d2.replies.length, 0, "漂移条目绝不发送");
    // 失败不挡新回应:AI 对 D2 重新 respond → 新条目绑当前收据 → 发送。
    const d2Note = reviewStore(issueDir).list()
      .find((item) => item.external_review?.discussion_id === "D2")!;
    submitReviews(issueDir, [d2Note.id]);
    reviewStore(issueDir).respond(d2Note.id,
      { outcome: "fixed", summary: "已补监控埋点(重写)", evidence: [] });
    await until(() => d2.replies.length > 0, "重写回应后 D2 发送");
    assert.match(d2.replies.at(-1)!, /重写/);

    // 验绿后仍发现迟到意见，责任人在托管期间不会漏掉新报告。
    const pushedSha = service.get(created.id).pushes!.at(-1)!.sha;
    platform.finishPipeline(pushedSha, "success");
    await until(() => {
      const transitions = service.get(created.id).transitions ?? [];
      return transitions.some((entry) => /验绿收口/.test(entry.note));
    }, "验绿收口");
    platform.seedDiscussion({
      id: "D4", file: "src/Late.java", line: 1,
      author: "迟到检视人", body: "收口后才提的意见",
    });
    await until(() => (service.get(created.id).feedback ?? []).some(record => record.source_id === "D4"), "验绿后的新报告仍落账");
    // host-calls 账(ADR-0053):监看拉取与信箱发送的每次调用一行,
    // 与 dispatch 账按 mrr-* 同 id join。
    const callRows = readFileSync(join(dataDir, "logs", "host-calls.jsonl"),
      "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(callRows.some((row: any) =>
      row.kind === "call.mr-discussions-list" && row.repo === origin),
      "讨论拉取调用进 host-calls 账");
    const replyCall = callRows.find((row: any) =>
      row.kind === "call.mr-discussion-reply" && row.discussion_id === "D1");
    assert.ok(replyCall, "回复发送调用进 host-calls 账");
    assert.match(replyCall.request_id, /^mrr-/, "request_id=信箱条目 id,两侧账可 join");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("discussions 客户端:可用/未配置/坏响应/网络失败四态,fail-open 上浮原因", async () => {
  // 200 正常形状 → available。
  const ok = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ discussions: [
      { id: "D9", body: "意见正文", file: "a.java", line: 3 },
      { not_an_id: true }, // 坏行跳过,不炸整包
    ] }));
  });
  await new Promise<void>((done) => ok.listen(0, "127.0.0.1", done));
  const okPort = (ok.address() as { port: number }).port;
  const good = await fetchMrDiscussions({
    platformUrl: `http://127.0.0.1:${okPort}`, repo: "http://r.git", mr: 7,
  });
  assert.equal(good.kind, "available");
  assert.deepEqual(good.kind === "available" && good.items.map((item) => item.id),
    ["D9"]);
  ok.close();

  // 404(适配层未配置 discussions)→ unavailable。
  const notFound = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "未配置 mr_discussions" }));
  });
  await new Promise<void>((done) => notFound.listen(0, "127.0.0.1", done));
  const missing = await fetchMrDiscussions({
    platformUrl: `http://127.0.0.1:${(notFound.address() as { port: number }).port}`,
    repo: "http://r.git",
  });
  assert.equal(missing.kind, "unavailable");
  assert.match(missing.kind === "unavailable" ? missing.reason : "", /404/);
  notFound.close();

  // 坏 JSON → unavailable,不抛。
  const garbage = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("<html>not json</html>");
  });
  await new Promise<void>((done) => garbage.listen(0, "127.0.0.1", done));
  const bad = await fetchMrDiscussions({
    platformUrl: `http://127.0.0.1:${(garbage.address() as { port: number }).port}`,
    repo: "http://r.git",
  });
  assert.equal(bad.kind, "unavailable");
  garbage.close();

  // 网络不通(连接拒绝)→ unavailable,不抛。
  const down = await fetchMrDiscussions({
    platformUrl: "http://127.0.0.1:9", repo: "http://r.git",
  });
  assert.equal(down.kind, "unavailable");
});
