/**
 * 三种反馈来源的逐条回执都必须能登记进真内核——不是只有流水线那条。
 *
 * 2026-09-02 修掉 canonical() 把 undefined 键签进摘要的 bug 之后,用户追问
 * "是不是没别的问题了"。空口不算数:工作台批注(Cloud 平台的检视意见)和
 * MR 讨论(检视人意见)各自拼回执的代码路径不同——批注走 annotations.jsonl
 * 的 response,MR 走 review_replies.md——这里让 taskService 真实的
 * recordActiveFeedbackResult 对着真内核各走一遍,登记成功才算数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FeedbackStore } from "../src/feedbackStore.ts";
import { AnnotationStore } from "../src/annotations.ts";
import { KERNEL_UNAVAILABLE, openKernelFeedback } from "../src/kernelDelivery.ts";
import { importExternalReviews } from "../src/externalReviewInbox.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import { withLiveReviewReceipts } from "../src/liveReviewReceipts.ts";
import { createServer } from "node:http";
import { REVIEW_MISSION_END } from "../src/reviewHandoff.ts";
import { TaskHostLedger, queueTaskHostOperation, finishTaskHostOperation } from "../src/taskHostTools.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "sources", GIT_AUTHOR_EMAIL: "s@example.com",
  GIT_COMMITTER_NAME: "sources", GIT_COMMITTER_EMAIL: "s@example.com",
};

test("完整 MR 修复经真实推送和内核登记后由宿主发送，不再唤醒 Agent；重启不重复推送/回复", async () => {
  const s = await watchingService("review-handoff"), api = s.service as any;
  const git = (...args: string[]) => execFileSync("git", ["-C", s.cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
  let replies = 0, resumes = 0, watches = 0, pipelineStatus = "running";
  const server = createServer((req, res) => {
    if (req.url?.includes("/reply")) { replies++; req.resume(); res.end("{}"); }
    else if (req.url?.startsWith("/pipeline/status")) res.end(JSON.stringify({ runs: [{
      sha: s.internal.summary.delivery.git_push.sha, status: pipelineStatus, run_id: "new-run" }] }));
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const remote = join(s.workspace, "remote.git");
    git("init", "--bare", "-q", remote); git("checkout", "-qb", "feature");
    git("push", "-q", remote, "master");
    s.internal.summary.repo_url = remote;
    s.internal.summary.status = "running";
    s.internal.summary.delivery = { mr_url: "https://code/mr/1", mr_id: 1,
      loop: { kind: "review", review_source: "platform", review_ids: "d1:r1", state: "repairing" } };
    s.internal.mission = `MR 上有 1 条检视意见待处理\n${REVIEW_MISSION_END}`;
    s.open("handoff", [{ id: "mr:d1", source: "mr_discussion", source_id: "d1", source_revision: 1,
      kind: "code_review", summary: "补齐实现", verification: "reviewer" }]);
    writeFileSync(join(s.cwd, "main.ts"), "export const ready = false;\n");
    git("add", "main.ts"); git("commit", "-qm", "fix review");
    const flow = readState(s.cwd); flow.current = "external_verify";
    writeFileSync(join(s.cwd, ".mae-flow.json"), JSON.stringify(flow)); // 模拟 Agent 已完成本轮编码步骤。
    writeFileSync(join(s.workspace, "review_replies.md"), "[d1]\n已补齐实现并核对调用方。\n");
    api.options.delivery = { platformUrl: `http://127.0.0.1:${(server.address() as any).port}`, pollIntervalMs: 100_000 };
    api.ensureMergeWatch = () => { watches++; };
    api.enqueueRepair = () => { resumes++; };
    const host = api.taskHostRuntime(s.internal);
    host.allowPush = async () => true;
    host.confirmPush = async () => true;
    await queueTaskHostOperation(host, "review-push", { action: "push", reason: "完成检视修复" });
    await finishTaskHostOperation(host);
    const ledger = new TaskHostLedger(s.internal.summary), op = ledger.read().operations[0];
    assert.equal(op.state, "succeeded", op.result);
    assert.equal(op.review_handoff, true);
    assert.equal(resumes, 0);
    assert.equal(replies, 1);
    assert.ok(watches > 0);
    assert.equal(s.internal.summary.status, "verifying");
    assert.equal(s.internal.summary.delivery.pipeline, "running");
    assert.equal(s.internal.summary.delivery.pipeline_background, false);
    assert.equal(s.internal.mission, undefined);
    assert.equal(git("--git-dir", remote, "rev-parse", "feature"), op.sha);
    const batch = readState(s.cwd).delivery_loop.batches.find((b: any) => b.batch_id === "handoff");
    assert.ok(batch.result_digest, "清空草稿前已登记真实内核结果");
    assert.equal(batch.status, "awaiting_verification", "仍由检视人验收");
    assert.equal(readFileSync(join(s.workspace, "review_replies.md"), "utf8"), "");
    ledger.update({ ...op, state: "running" }); // 崩溃在交接已落盘、操作尚未标成功的窗口。
    pipelineStatus = "success";
    const recovering = api.taskHostRuntime(s.internal);
    recovering.push = async () => { throw new Error("不应重复传输"); };
    await finishTaskHostOperation(recovering);
    assert.equal(ledger.read().operations[0].state, "succeeded");
    assert.equal(resumes, 0); assert.equal(replies, 1);
    assert.equal(s.internal.summary.status, "await_merge", s.internal.summary.detail);
    assert.equal(readState(s.cwd).current, "delivery_watch", "绿灯须经真实内核核销后才等待合入");
  } finally { server.closeAllConnections(); server.close(); await s.stop(); }
});

test("跨 CI 轮次已答讨论不重复入账；新正文按新意见交办，其他 MR 的回复不算", async () => {
  const s = await watchingService("review-history"), api = s.service as any;
  try {
    s.internal.summary.status = "await_merge";
    s.internal.summary.repo_url = "repo";
    s.internal.summary.delivery = { mr_id: 1, mr_url: "https://code/mr/1", loop: { kind: "ci", state: "verifying" } };
    const outbox = api.deliveryOutbox(s.internal);
    for (const [id, mr] of [["done", 1], ["other", 2]] as const) {
      const entry = outbox.enqueueReviewReply({ discussion_id: id, source_revision: 1, body: "已处理",
        repo: "repo", mr, resolve: false, expected_sha: "a".repeat(40) });
      outbox.markDelivered(entry.id);
    }
    // 发送台账跨 CI/检视轮次保留：已答事实的权威记录仍在账上，按仓+MR 各归各位。
    const delivered = outbox.list().filter((item: any) =>
      item.kind === "review_reply" && item.state === "delivered");
    assert.equal(delivered.length, 2);
    assert.ok(delivered.some((item: any) =>
      item.payload.discussion_id === "done" && String(item.payload.mr) === "1"));
    assert.ok(delivered.some((item: any) =>
      item.payload.discussion_id === "other" && String(item.payload.mr) === "2"));

    // 外部意见一律先入待判断批注等责任人交办（cbe741e 拍板，不再自动派发修复）；
    // 合入监听每轮重新拉取讨论，走的是同一条 importExternalReviews 同步。
    const store = api.annotations(s.internal);
    const scope = "https://code/mr/1";
    const observe = (items: Array<{ id: string; body: string }>) => importExternalReviews(store,
      { scope, mrUrl: scope, owner: "本地用户", items });
    const [note] = observe([{ id: "done", body: "补充要求" }]);
    assert.equal(note.route, "owner_reply");
    assert.equal(note.agent_assigned, undefined, "入账只落待判断批注，不自动派发修复");

    // 责任人已答复后，同一讨论在等检视人点“已解决”期间反复轮询不复活。
    store.replyAsOwner(note.id, "本地用户", "已在 MR 回复中说明", true);
    assert.equal(observe([{ id: "done", body: "补充要求" }]).length, 0);

    // 同一讨论出现新正文 = 新的待判断批注，等责任人重新判断。
    const followUps = observe([{ id: "done", body: "补充要求（检视人追问）" }]);
    assert.equal(followUps.length, 1);

    // 其他 MR 的台账回复不算：mr2 上已答复不抑制 mr1 同名讨论入账。
    assert.equal(observe([{ id: "other", body: "另一条意见" }]).length, 1);
    assert.equal(delivered.length, outbox.list().filter((item: any) =>
      item.kind === "review_reply" && item.state === "delivered").length,
      "重新观察不改动发送台账");
  } finally { await s.stop(); }
});

async function until(probe: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const readState = (cwd: string) =>
  JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));

async function watchingService(label: string) {
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), `mfc-sources-${label}-`)),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create(`反馈来源回执 ${label}`, { account: "worker" }).id;
  const waiting = service.get(id)?.waiting;
  if (waiting?.step === "cloud_requirement_analysis_confirm") {
    const question = (waiting.question.questions as Array<{ question: string }>)[0].question;
    await service.decide(id, { waiting_id: waiting.waiting_id, state_version: waiting.state_version,
      selected_options: { [question]: "需求已确认，进入需求分析" } });
  }
  await until(() => service.get(id)?.status === "completed", "首轮会话收口");
  const internal = (service as any).tasks.get(id);
  const workspace = internal.summary.workspace as string;
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
  git("init", "--quiet", "-b", "master");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git("add", "main.ts");
  git("commit", "--quiet", "-m", "baseline");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_watch", revision: 3,
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host",
      continuous_review: true, source: "order",
    },
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: head, delivery_watch: head },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], initial_dirty: [],
  }));
  internal.cwd = cwd;
  sealPipelineLifecycle({ cwd, workspace, taskId: id, kernelRoot: KERNEL_ROOT });
  (service as any).options.host = {
    kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true,
  };
  const open = (batchId: string, items: Array<Record<string, unknown>>) => {
    openKernelFeedback({
      host: { kernelRoot: KERNEL_ROOT }, cwd, workspace,
      batch: {
        schema: "mae-flow-feedback-batch/1",
        batch_id: batchId, task_id: id, base_sha: head,
        opened_at: new Date().toISOString(),
        items: items as any,
      },
    });
    (service as any).syncFeedbackStoreFromKernel(internal);
  };
  const stop = async () => {
    await service.cancel(id, "tester").catch(() => undefined);
    await service.shutdown();
    await model.stop();
  };
  return { service, internal, workspace, cwd, open, stop };
}

test("task-4 形态：四条文件回执、三条已发送、一条草稿，运行中登记后可交还真内核", async () => {
  const { service, internal, workspace, cwd, open, stop } = await watchingService("live-workspace");
  try {
    const store = new AnnotationStore(join(workspace, "annotations.jsonl"));
    const items = [1, 2, 3, 4].map((line) => store.add({ author: "reviewer",
      artifact: "main.ts", file: "main.ts", line, anchor: "ready", note: "补充空值处理", kind: "code" }));
    store.markSent(items.slice(0, 3).map((a) => a.id), "review_repair");
    open("fb-live", [{ id: `ws:${items[0].id}`, source: "workspace", source_id: items[0].id,
      source_revision: 0, kind: "code", summary: items[0].note, verification: "author" }]);
    internal.summary.delivery = { loop: { review_source: "workspace", state: "repairing",
      workspace_review_annotation_ids: items.map((a) => a.id) } };
    writeFileSync(join(cwd, "main.ts"), "export const ready = false;\n");
    execFileSync("git", ["add", "main.ts"], { cwd, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "repair"], { cwd, env: GIT_ENV });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(join(workspace, "reviews/local-receipts.json"), JSON.stringify({ receipts:
      items.map((a) => ({ annotation_id: a.id, revision: 0, outcome: "fixed",
        summary: "已补充空值处理与对应测试", evidence: ["main.ts:1"] })) }));
    const hooks = withLiveReviewReceipts(undefined, { current: () => true,
      list: () => store.list(), consume: () => (service as any).consumeReviewProcessingReceipts(internal), log() {} });
    await hooks.preTool!({ eventId: 1, taskId: internal.summary.id, sessionId: "main", ts: "",
      kind: "tool_requested", payload: { name: "Bash", input: { command: "current" } } });
    assert.ok(store.list().slice(0, 3).every((a) => a.response?.fixed_sha === head));
    assert.equal(store.list()[3].response, undefined);
    assert.equal((service as any).recordActiveFeedbackResult(internal), undefined);
    const batch = readState(cwd).delivery_loop.batches.find((b: any) => b.batch_id === "fb-live");
    assert.ok(batch.result_digest);
    assert.equal(batch.results[0].status, "fixed");
    assert.ok(store.list().every((a) => a.status !== "verified"));
  } finally { await stop(); }
});

test("工作台批注来源:Agent 逐条回应(不带证据)登记进真内核", async () => {
  const { service, internal, workspace, cwd, open, stop } =
    await watchingService("workspace");
  try {
    const store = new AnnotationStore(join(workspace, "annotations.jsonl"));
    const first = store.add({
      author: "reviewer", artifact: "story.md", file: "story.md", line: 3,
      anchor: "空值分支", note: "空值分支没处理", kind: "doc",
    });
    const second = store.add({
      author: "reviewer", artifact: "main.ts", file: "main.ts", line: 1,
      anchor: "ready", note: "命名不清晰", kind: "code",
    });
    store.markSent([first.id, second.id], "interrupt");
    open("fb-ws", [
      { id: `ws:${first.id}`, source: "workspace", source_id: first.id,
        source_revision: 0, kind: "doc", summary: first.note, verification: "author" },
      { id: `ws:${second.id}`, source: "workspace", source_id: second.id,
        source_revision: 0, kind: "code", summary: second.note, verification: "author" },
    ]);
    // 一条给了证据,一条没给——不给证据是常态,不能因此拒收。
    store.respond(first.id, {
      outcome: "not_fixed", summary: "该路径不可达，已在文档说明", evidence: [],
    });
    store.respond(second.id, {
      outcome: "needs_clarification", summary: "两种命名都合理，需要作者定",
      evidence: ["main.ts:1"],
    });
    const failure = (service as any).recordActiveFeedbackResult(internal);
    assert.match(failure, /工作台/, "需要人工判断时明确说明反馈来源");
    assert.match(failure, /两种命名都合理，需要作者定/,
      "needs_clarification 的具体判断保留在停机原因中");
    assert.doesNotMatch(failure, /该路径不可达，已在文档说明/, "已解释条目不混入待人工原因");
    const batch = readState(cwd).delivery_loop.batches.find(
      (item: any) => item.batch_id === "fb-ws");
    assert.ok(batch.result_digest, "内核已登记本批回执");
    assert.deepEqual(batch.results.map((item: any) => item.status).sort(),
      ["explained", "needs_human"]);
    assert.equal((service as any).recordActiveFeedbackResult(internal), failure,
      "结果重放仍保留真正需要人工判断的意见");
    const shown = service.get(internal.summary.id)?.feedback?.find(item => item.id === `ws:${second.id}`);
    assert.equal(shown?.source, "workspace");
    assert.equal(shown?.summary, second.note);
    assert.match(shown?.resolution ?? "", /两种命名都合理，需要作者定/);
    assert.equal(readState(cwd).current, "feedback_triage");
  } finally {
    await stop();
  }
});

test("需要人工的混合反馈保留流水线和 MR 逐条原因，重放与丢失索引恢复不吞摘要", async () => {
  const { service, internal, workspace, cwd, open, stop } = await watchingService("human-summary");
  const api = service as any;
  try {
    const batchId = "fb-human-summary";
    open(batchId, [
      { id: "pipeline:human", source: "pipeline", source_id: "COMPILE", source_revision: 0,
        kind: "quality_failure", summary: "流水线需要调整测试配置", verification: "机器门禁" },
      { id: "mr:human", source: "mr_discussion", source_id: "discussion-human", source_revision: 0,
        kind: "code_review", summary: "检视人要求更改公共接口", verification: "reviewer" },
      { id: "build:explained", source: "build_fix", source_id: "build-explained", source_revision: 0,
        kind: "quality_failure", summary: "旧配置告警", verification: "机器门禁" },
    ]);
    const results = [
      { id: "pipeline:human", status: "needs_human", summary: "目标分支 UT 要求需要仓库管理员确认。" },
      { id: "mr:human", status: "needs_human", summary: "检视人要求修改接口，调用契约需要作者决定。" },
      { id: "build:explained", status: "explained", summary: "这条已解释，无需人工处理。" },
    ];
    writeFileSync(api.feedbackResultPath(internal, batchId), JSON.stringify({ schema: "mae-flow-feedback-results/1", batch_id: batchId, results }));
    const failure = api.recordActiveFeedbackResult(internal);
    assert.match(failure, /流水线.*目标分支 UT 要求需要仓库管理员确认/);
    assert.match(failure, /MR.*检视人要求修改接口，调用契约需要作者决定/);
    assert.doesNotMatch(failure, /这条已解释|旧配置告警/);
    const recorded = readState(cwd).delivery_loop.batches.find((batch: any) => batch.batch_id === batchId);
    assert.equal(recorded.status, "needs_human", "展示原因不能替代人工裁决或自动放行");
    assert.deepEqual(recorded.results.map(({ id, status, summary }: any) => ({ id, status, summary })), results);
    assert.equal(service.get(internal.summary.id)?.feedback?.find(item => item.id === "build:explained")?.status,
      "awaiting_verification", "首次登记的已解释条目等待核验，不跟着整批人工待办或自动闭环");
    assert.equal(api.recordActiveFeedbackResult(internal), failure, "结果已登记后的重放显示同一份具体原因");
    const projected = service.get(internal.summary.id)?.feedback ?? [];
    assert.equal(projected.find(item => item.id === "build:explained")?.status, "awaiting_verification");
    for (const result of results.filter(result => result.status === "needs_human")) {
      assert.equal(projected.find(item => item.id === result.id)?.resolution, result.summary);
    }
    rmSync(join(workspace, "feedback", "index.jsonl"));
    assert.equal(api.recordActiveFeedbackResult(internal), failure, "展示来自权威逐条结果，不依赖可重建索引是否存在");
    const restored = service.get(internal.summary.id)?.feedback ?? [];
    assert.equal(restored.find(item => item.id === "build:explained")?.status, "awaiting_verification",
      "索引恢复后的逐条状态与首次登记一致");
    for (const result of results.filter(result => result.status === "needs_human")) {
      assert.equal(restored.find(item => item.id === result.id)?.resolution, result.summary);
    }
    assert.equal(readState(cwd).current, "feedback_triage");
  } finally { await stop(); }
});

test("Build-Fix 来源:回执文件不存在=这批还没人处理,恢复时重新派单而不是停摆", async () => {
  // 内网 task-38 实锤:prepush 校验失败登记了 build_fix 批次,12:29 建批、
  // 12:48 部署重启,Agent 一次都没被拉起来处理过。恢复时读不到 result json
  // 就报"Agent 没有留下本批逐条反馈回执"并停摆等人——可 Agent 压根没机会写。
  const { service, internal, open, stop } = await watchingService("buildfix");
  try {
    open("fb-bf", [
      { id: "build_fix:c1:r0", source: "build_fix", source_id: "c1",
        source_revision: 0, kind: "quality_failure",
        summary: "编译未通过：报告中的命令没有在本会话真实成功执行",
        verification: "机器门禁" },
    ]);
    const missing = (service as any).recordActiveFeedbackResult(internal);
    assert.match(missing, /本批逐条反馈回执尚未落盘/);
    assert.match(missing, /尚未被修复会话处理过/);
    assert.doesNotMatch(missing, /Agent 没有留下/,
      "没给过机会就别说人家没留下");

    // 恢复路径:不停摆,重新派给修复会话,清单随使命带上。
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      mr_state: "验证中",
      waiting_on: `${KERNEL_UNAVAILABLE}：登记回执时内核未就绪`,
    };
    (service as any).persist(internal);
    await (service as any).runDeliveryRecovery(internal, internal.controlEpoch);
    assert.equal(internal.summary.status, "queued",
      "这批还没人处理过,应该重新派单");
    assert.equal(internal.summary.delivery.stalled, undefined,
      "不能停摆等人");
    assert.match(String(internal.mission ?? ""), /还没有被处理过/);
    assert.match(String(internal.mission ?? ""), /build_fix:c1:r0/,
      "使命里要带上本批反馈清单");

    // 文件存在但坏了才是"回执不合格":措辞与出路都不同。
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      mr_state: "验证中",
      waiting_on: `${KERNEL_UNAVAILABLE}：登记回执时内核未就绪`,
    };
    writeFileSync(
      (service as any).feedbackResultPath(internal, "fb-bf"), "{ 不是 JSON");
    const broken = (service as any).recordActiveFeedbackResult(internal);
    assert.match(broken, /无法读取/);
    assert.doesNotMatch(broken, /尚未落盘/);
    await (service as any).runDeliveryRecovery(internal, internal.controlEpoch);
    assert.equal(internal.summary.status, "verifying",
      "回执确实不合格时照旧停下叫人,不许无限重派");
    assert.ok(internal.summary.delivery.stalled, "不合格要如实停摆");
  } finally {
    await stop();
  }
});

test("MR 检视人意见来源:review_replies.md 逐条回复登记进真内核", async () => {
  const { service, internal, workspace, cwd, open, stop } =
    await watchingService("mr");
  try {
    open("fb-mr", [
      { id: "mr:d-1", source: "mr_discussion", source_id: "d-1", source_revision: 0,
        kind: "code_review", summary: "请补空值分支", verification: "reviewer" },
      { id: "mr:d-2", source: "mr_discussion", source_id: "d-2", source_revision: 0,
        kind: "code_review", summary: "日志级别过高", verification: "reviewer" },
    ]);
    const retry = (service as any).activeFeedbackReceiptInstructions(internal);
    assert.ok(retry.includes(JSON.stringify(join(workspace, "review_replies.md"))));
    assert.match(retry, /\[d-1\]/);
    assert.match(retry, /\[d-2\]/);
    assert.doesNotMatch(retry, /\[mr:d-1\]/);
    writeFileSync(join(workspace, "review_replies.md"), "[d-1] 已修改\n[d-1] 不修改\n[d-2] 已降低日志级别");
    assert.match((service as any).recordActiveFeedbackResult(internal), /ID 重复/);
    assert.equal(readState(cwd).delivery_loop.batches[0].result_digest, undefined);
    writeFileSync(join(workspace, "review_replies.md"), [
      "[d-1] 已补空值分支，见 main.ts 第 3 行。",
      "[d-2]",
      "已降为 debug 级别。",
      "",
    ].join("\n"));
    const failure = (service as any).recordActiveFeedbackResult(internal);
    assert.equal(failure, undefined, `登记不该失败:${failure}`);
    const batch = readState(cwd).delivery_loop.batches.find(
      (item: any) => item.batch_id === "fb-mr");
    assert.ok(batch.result_digest, "内核已登记本批回执");
    assert.equal(batch.results.length, 2);
    assert.ok(batch.results.every((item: any) => item.status === "explained"));
  } finally {
    await stop();
  }
});

test("MR 部分回复已发送后补交，不把旧讨论正文混进新回复", async () => {
  const { service, internal, workspace, cwd, stop } = await watchingService("partial-mr");
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    internal.summary.repo_url = "https://code.example.invalid/repo.git";
    internal.summary.delivery = { loop: { kind: "review", review_source: "mr_discussion",
      review_ids: "d-new:r0,d-old:r0", replied_ids: "d-old:r0" } };
    (service as any).prePushRevision = async () => ({ sha });
    writeFileSync(join(workspace, "review_replies.md"), "[d-new] 新讨论的回复\n[d-old] 已发送的旧回复");
    assert.deepEqual(await (service as any).stageReviewReplies(internal), { ok: true });
    const entries = (service as any).deliveryOutbox(internal).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.discussion_id, "d-new");
    assert.equal(entries[0].payload.body, "新讨论的回复");
  } finally { await stop(); }
});

test("流水线摘要误拼进 ID 必须拒收；模板保留原 ID，准确回执才登记", async () => {
  const { service, internal, cwd, open, stop } = await watchingService("pipeline-id");
  try {
    const id = `pipeline:${"94746097".padEnd(40, "a")}:CODECHECK+COMPILE:r0@${"94746097".padEnd(40, "a")}`;
    const summary = "FAILED stage=CodeCheck2.0 job=CodeCheck2.0\n【质量门禁指标】请核对";
    open("fb-pipeline-id", [{ id, source: "pipeline", source_id: "CODECHECK+COMPILE",
      source_revision: 0, kind: "quality_failure", summary, verification: "机器门禁" }]);
    const instructions = (service as any).activeFeedbackReceiptInstructions(internal) as string;
    const start = instructions.indexOf('{\n  "schema"');
    const end = instructions.indexOf("\n只填写每条", start);
    const receipt = JSON.parse(instructions.slice(start, end));
    assert.equal(receipt.batch_id, "fb-pipeline-id");
    assert.equal(receipt.results[0].id, id);
    assert.equal(receipt.results[0].status, "", "平台不得代填处理结论");
    assert.doesNotMatch(instructions, new RegExp("本轮反馈完整 ID："));
    const path = (service as any).feedbackResultPath(internal, "fb-pipeline-id");
    const check = () => {
      writeFileSync(path, JSON.stringify(receipt));
      return (service as any).recordActiveFeedbackResult(internal);
    };
    receipt.results[0] = { id: id + "：" + summary.split("\n")[0], status: "explained",
      summary: "已核对流水线原始报告，需重新执行检查", evidence: "流水线报告" };
    assert.match(check(), /逐条反馈回执含重复、夹带或字段不完整/);
    assert.equal(readState(cwd).delivery_loop.batches[0].result_digest, undefined);
    receipt.results[0].id = id;
    receipt.results.push({ ...receipt.results[0] });
    assert.match(check(), /逐条反馈回执含重复、夹带或字段不完整/);
    receipt.results.pop();
    assert.equal(check(), undefined);
    assert.ok(readState(cwd).delivery_loop.batches[0].result_digest);
  } finally { await stop(); }
});

test("结果 A 在推送前登记，发布 B 后幂等收口仍可信，篡改结果必须拒绝", async () => {
  const { service, internal, workspace, cwd, open, stop } =
    await watchingService("published-result-replay");
  const statePath = join(cwd, ".mae-flow.json");
  try {
    const api = service as any;
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
      { encoding: "utf8", env: GIT_ENV }).trim();
    const store = new AnnotationStore(join(workspace, "annotations.jsonl"));
    const note = store.add({ author: "owner", artifact: "main.ts", file: "main.ts",
      line: 1, anchor: "ready", note: "补齐逻辑", kind: "code" });
    store.markSent([note.id], "interrupt");
    open("published-result-replay", [{ id: `ws:${note.id}`, source: "workspace",
      source_id: note.id, source_revision: 0, kind: "code", summary: note.note,
      verification: "author" }]);
    writeFileSync(join(cwd, "main.ts"), "export const ready = false;\n");
    git("add", "main.ts"); git("commit", "-qm", "fix A");
    const resultHead = git("rev-parse", "HEAD");
    store.respond(note.id, { outcome: "fixed", summary: "已修复", evidence: ["main.ts:1"] });
    // 统计真实内核进程，不用耗时阈值，也不替代收据判定。
    const trace = join(workspace, "kernel-calls.jsonl");
    const wrapper = join(workspace, "count-python");
    writeFileSync(trace, "");
    writeFileSync(wrapper, ["#!/usr/bin/env python3", "import json, os, sys",
      `with open(${JSON.stringify(trace)}, "a") as f:`,
      '    f.write(json.dumps(sys.argv[1:]) + "\\n")',
      'os.execvp("python3", ["python3", *sys.argv[1:]])', ""].join("\n"));
    chmodSync(wrapper, 0o755);
    api.options.host.python = wrapper;
    const attestations = (): string[][] => readFileSync(trace, "utf8").trim()
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((args: string[]) => args.includes("attest"));
    assert.equal(readState(cwd).delivery_loop.published, undefined);
    assert.equal(api.recordActiveFeedbackResult(internal), undefined,
      "首次结果登记无需推送收据，必须发生在交付之前");
    assert.ok(attestations().some((args) => args.includes("--feedback-loop")),
      "首次登记前核验反馈事实");
    assert.equal(attestations().filter((args) => args.includes("--feedback-loop")).length, 2,
      "登记前后各核验一次反馈事实，不再传递流程动作白名单");
    const originalBatch = readState(cwd).delivery_loop.batches[0];
    assert.equal(originalBatch.result_head, resultHead);

    // 模拟宿主整理交付产生新提交；登记发布事实不会重写 Agent 的处理版本。
    writeFileSync(join(cwd, "extra.txt"), "delivery adjustment\n");
    git("add", "extra.txt"); git("commit", "-qm", "fix B");
    const publishedHead = git("rev-parse", "HEAD");
    assert.notEqual(resultHead, publishedHead);
    api.recordPublishedPush(internal,
      { sha: publishedHead, ref: "refs/heads/feature", remote: "origin" });
    const published = readState(cwd);
    assert.equal(published.delivery_loop.published.sha, publishedHead);
    // 内核正常推进或其他事实更新，不应让已登记结果、提示词和索引消失。
    published.current = "external_verify";
    published.user_intervention = { updated: true };
    writeFileSync(statePath, JSON.stringify(published));
    assert.equal(api.activeKernelFeedback(internal)?.items.length, 1,
      "步骤推进后提示词仍能读取活动反馈");
    for (let replay = 0; replay < 2; replay++) {
      const before = attestations().length;
      assert.equal(api.recordActiveFeedbackResult(internal), undefined);
      assert.equal(attestations().length - before, 1,
        "每次重放重新核验一次，展示复用本次已核验快照");
      assert.equal(new FeedbackStore(join(workspace, "feedback", "index.jsonl"))
        .list().find((item) => item.source_id === note.id)?.status, "awaiting_verification",
        "处理回执不能冒充用户验收通过");
      assert.deepEqual(readState(cwd).delivery_loop.batches[0], originalBatch,
        "重放只补投影，不重写结果或冒充最终质量闭环");
    }

    const beforeSync = attestations().length;
    api.syncFeedbackStoreFromKernel(internal);
    assert.equal(attestations().length - beforeSync, 1, "独立展示同步仍重新核验");

    // 在核验与投影之间换掉磁盘状态：只能展示刚核验的快照，下一次必须拒绝伪造。
    const sync = api.syncFeedbackStoreFromKernel;
    const altered = structuredClone(published);
    altered.delivery_loop.batches[0].results[0].summary = "伪造处理结论";
    api.syncFeedbackStoreFromKernel = function(task: unknown, projectionOnly: boolean, state: unknown) {
      writeFileSync(statePath, JSON.stringify(altered));
      return sync.call(this, task, projectionOnly, state);
    };
    try {
      assert.equal(api.recordActiveFeedbackResult(internal), undefined);
      assert.ok(!readFileSync(join(workspace, "feedback", "index.jsonl"), "utf8")
        .includes("伪造处理结论"), "不能投影未经核验的新磁盘状态");
      assert.match(api.recordActiveFeedbackResult(internal), /缺少 Cloud 宿主权威收据/);
    } finally {
      api.syncFeedbackStoreFromKernel = sync;
      writeFileSync(statePath, JSON.stringify(published));
    }

    const brokenPython = join(workspace, "unavailable-python");
    writeFileSync(brokenPython, "#!/bin/sh\necho invalid-response\n");
    chmodSync(brokenPython, 0o755);
    api.options.host.python = brokenPython;
    const beforeFailure = readFileSync(join(workspace, "feedback", "index.jsonl"), "utf8");
    try {
      assert.match(api.recordActiveFeedbackResult(internal), new RegExp(KERNEL_UNAVAILABLE),
        "先前成功不能掩盖当前内核故障，保留自动恢复分类");
      assert.equal(readFileSync(join(workspace, "feedback", "index.jsonl"), "utf8"), beforeFailure);
    } finally {
      api.options.host.python = wrapper;
    }
    assert.equal(api.recordActiveFeedbackResult(internal), undefined, "内核恢复后可直接重试成功");

    for (const field of ["result_head", "result_digest", "summary"]) {
      const altered = JSON.parse(JSON.stringify(published));
      const batch = altered.delivery_loop.batches[0];
      if (field === "summary") batch.results[0].summary = "伪造处理结论";
      else batch[field] = field === "result_head" ? publishedHead : "forged";
      writeFileSync(statePath, JSON.stringify(altered));
      try {
        assert.match(api.recordActiveFeedbackResult(internal), /缺少 Cloud 宿主权威收据/,
          `${field} 被篡改时不能因认可发布收据而放行`);
      } finally {
        writeFileSync(statePath, JSON.stringify(published));
      }
    }
    assert.equal(api.recordActiveFeedbackResult(internal), undefined);
  } finally {
    await stop();
  }
});

for (const changed of [false, true]) test(`396：20 条人工已闭环意见先登记再交付，不催重复处理（代码变化=${changed}）`, async () => {
  const s = await watchingService(`396-${changed}`), api = s.service as any;
  try {
    const store = new AnnotationStore(join(s.workspace, "annotations.jsonl"));
    const notes = Array.from({ length: 20 }, (_, i) => store.add({ author: "owner", artifact: "main.ts",
      file: "main.ts", line: i + 1, anchor: "ready", note: "确认这处实现", kind: "code" }));
    store.markSent(notes.map(n => n.id), "review_repair");
    s.open("fb-396", notes.map(n => ({ id: `workspace:${n.id}`, source: "workspace", source_id: n.id,
      source_revision: 0, kind: "code_review", summary: n.note, verification: "author" })));
    assert.equal(readState(s.cwd).delivery_loop.batches[0].status, "repairing");
    assert.equal(api.activeFeedbackResult(s.internal), undefined,
      "工作台意见直接消费批注事实，不再要求另一份 JSON 回执");
    for (const note of notes) {
      if (changed) {
        store.respond(note.id, { outcome: "fixed", summary: "已按要求修改", evidence: ["main.ts:1"] });
        store.resolveAsOwner(note.id, "owner", { revision: 0, outcome: "fixed", reason: "已核对" });
      } else store.verify(note.id, "owner");
    }
    if (changed) {
      writeFileSync(join(s.cwd, "main.ts"), "export const ready = false;\n");
      execFileSync("git", ["add", "main.ts"], { cwd: s.cwd, env: GIT_ENV });
      execFileSync("git", ["commit", "-qm", "修复"], { cwd: s.cwd, env: GIT_ENV });
    }
    s.internal.summary.status = "running";
    s.internal.summary.delivery = { pipeline: "success", loop: { kind: "review", state: "repairing",
      review_source: "workspace", workspace_review_annotation_ids: notes.map(n => n.id) } };
    let nudges = 0, deliveries = 0;
    s.internal.driver = { isIdle: true, takeUndeliveredSteers: () => [], finalReply: () => "已处理",
      dispose() {}, continueWith: async () => { nudges++; throw new Error("不应重复催办"); } };
    api.tryDeliver = async () => { deliveries++; s.internal.summary.status = "verifying"; };
    assert.equal(readState(s.cwd).current, "feedback_triage");
    await api.settle(s.internal, Promise.resolve({ status: "turn_finished" }), s.internal.controlEpoch);
    assert.equal(nudges, 0, s.internal.summary.detail);
    assert.equal(deliveries, 1, s.internal.summary.detail);
    assert.equal(readState(s.cwd).current, changed ? "external_verify" : "delivery_watch");
    const batch = readState(s.cwd).delivery_loop.batches[0];
    assert.equal(batch.results.length, 20);
    assert.ok(batch.results.every((row: any) => row.status === "explained"));
    assert.equal(batch.status, changed ? "awaiting_verification" : "closed");
    assert.equal(s.internal.summary.status, "verifying", "交给宿主不冒充 MR 合入或任务完成");
  } finally { await s.stop(); }
});

test("396：已登记结果的旧任务停在 feedback_triage 时幂等交还，不改写原回执", async () => {
  const s = await watchingService("396-replay"), api = s.service as any;
  try {
    const store = new AnnotationStore(join(s.workspace, "annotations.jsonl"));
    const note = store.add({ author: "owner", artifact: "main.ts", file: "main.ts", line: 1,
      anchor: "ready", note: "补齐实现", kind: "code" });
    store.markSent([note.id], "review_repair");
    s.open("fb-396-old", [{ id: `workspace:${note.id}`, source: "workspace", source_id: note.id,
      source_revision: 0, kind: "code_review", summary: note.note, verification: "author" }]);
    store.respond(note.id, { outcome: "fixed", summary: "已补齐", evidence: ["main.ts:1"] });
    writeFileSync(join(s.cwd, "main.ts"), "export const ready = false;\n");
    execFileSync("git", ["add", "main.ts"], { cwd: s.cwd, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "修复"], { cwd: s.cwd, env: GIT_ENV });
    assert.equal(api.recordActiveFeedbackResult(s.internal), undefined);
    const state = readState(s.cwd), original = structuredClone(state.delivery_loop.batches[0]);
    state.current = "feedback_triage";
    writeFileSync(join(s.cwd, ".mae-flow.json"), JSON.stringify(state));
    assert.equal(api.recordActiveFeedbackResult(s.internal), undefined);
    assert.equal(readState(s.cwd).current, "external_verify");
    assert.deepEqual(readState(s.cwd).delivery_loop.batches[0], original);
  } finally { await s.stop(); }
});
