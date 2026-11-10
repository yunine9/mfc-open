/**
 * 持续检视闭环的批 0 契约。
 *
 * 本文件故意不使用 managedFlowFixture，也不写 `.mae-flow.json`。事故
 * 复现中的每一次状态变化都由 vendored Mae-Flow 的 Hook/CLI 产生：
 * init → config-review/done → goto external_verify → pipeline record → end，
 * 再用真实 init 生成本次事故相同的 `.last + config_confirm` 形态，最后
 * 走生产迁移与 delivery feedback-open 恢复原任务。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { inspectKernelTaskCompletion, inspectKernelDeliveryReady } from "../src/terminalAttestation.ts";
import { migrateContinuousReviewTask } from "../src/continuousReviewMigration.ts";
import {
  closeKernelDelivery,
  createKernelHostProof,
  openKernelFeedback,
  recordKernelFeedbackResult,
  controlKernelFeedback,
  attestKernelHost,
} from "../src/kernelDelivery.ts";

const KERNEL_ROOT = discoverKernelRoot(process.cwd());
assert.ok(KERNEL_ROOT, "发布件必须包含 vendored Mae-Flow 内核");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "continuous-review-contract",
  GIT_AUTHOR_EMAIL: "continuous-review-contract@example.com",
  GIT_COMMITTER_NAME: "continuous-review-contract",
  GIT_COMMITTER_EMAIL: "continuous-review-contract@example.com",
};

const TICKET = "REQ2026090101";
const REQUIREMENT = "交付持续检视契约测试，并批准测试宿主进入外部验证。";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  }).trim();
}

function kernel(cwd: string, ...args: string[]): string {
  return execFileSync(
    "python3",
    [join(KERNEL_ROOT!, "scripts", "mae-flow.py"), ...args],
    {
      cwd,
      env: { ...process.env, MAE_FLOW_HOST: "cloud" },
      encoding: "utf-8",
    },
  );
}

function readState(cwd: string, suffix = ""): Record<string, any> {
  return JSON.parse(readFileSync(
    join(cwd, `.mae-flow.json${suffix}`), "utf-8"));
}

function messageId(cwd: string, contains: string): string {
  const line = kernel(cwd, "messages")
    .split(/\r?\n/)
    .find((row) => row.includes(contains));
  const id = line?.trim().split(/\s+/)[0] ?? "";
  assert.ok(id, `messages 中找不到包含“${contains}”的真实用户消息`);
  return id;
}

/** 按生产布局铺现场:<data>/<task>/<repo>。宿主信任根落在 <data>/,由
 * Cloud 端建;内核从 repo 往上两级找它,永远先看这一级。原来仓直接建在
 * tmp 根下,内核的"上两级"就变成整台机器共享的 /var/folders/<hash>/——
 * 任何一次旧代码或别的会话在那留下 .host-capabilities,内核就优先信它,
 * 而本测试写的是 tmp 根下那份,十二条契约整齐报"凭据不在信任根内"
 * (2026-09-02 全量实锤;单跑主库旧副本反而是绿的,更有迷惑性)。 */
function repository(): string {
  const cwd = join(mkdtempSync(join(tmpdir(), "mfc-continuous-review-")),
    "task", "repo");
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "contract@test");
  git(cwd, "config", "user.name", "contract-test");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git(cwd, "add", "main.ts");
  git(cwd, "commit", "--quiet", "-m", "initial");
  writeFileSync(join(cwd, ".mae-flow-order.json"), JSON.stringify({
    execution_contract: {
      schema: "mae-flow-execution/1",
      host: "cloud",
      compile: "pipeline",
      ut_write: "agent",
      ut_run: "pipeline",
      codecheck: "pipeline",
      git_push: "host",
    },
    "UT生成方式": "仓内写法",
  }, null, 2));
  return cwd;
}

async function reproduceTerminalRollover(): Promise<{
  cwd: string;
  batch: Parameters<typeof openKernelFeedback>[0]["batch"];
  before: Record<string, any>;
  after: Record<string, any>;
  archived?: Record<string, any>;
  lastPreserved: boolean;
  migrationRetryProved: boolean;
}> {
  const cwd = repository();
  const host = new KernelHost({
    kernelRoot: KERNEL_ROOT!,
    workspace: cwd,
    transcriptPath: join(cwd, "transcript.jsonl"),
    taskId: "continuous-review-contract",
    python: "python3",
  });

  await host.bootstrapManaged(REQUIREMENT);
  const requirementMessage = messageId(cwd, "持续检视契约测试");
  kernel(cwd, "requirement-record", "--message-id", requirementMessage,
    "--ticket", TICKET);
  kernel(cwd, "config-review",
    "--set", "工号=contract-test",
    "--set", "基线分支=master",
    "--set", `单号=${TICKET}`,
    "--set", "单号类型=REQ",
    "--set", `需求文档=docs/req/REQ-${TICKET}.md`,
    "--set", "UT生成方式=仓内写法");
  await host.postTool({
    eventId: 1,
    taskId: "continuous-review-contract",
    sessionId: "main",
    ts: new Date().toISOString(),
    kind: "tool_finished",
    payload: {
      call_id: "config-confirm",
      name: "AskUserQuestion",
      input: { questions: [{
        question: "上述完整配置是否正确?",
        options: ["确认以上全部配置", "需要修改"],
      }] },
      answers: { "上述完整配置是否正确?": "确认以上全部配置" },
    },
  });
  kernel(cwd, "done");

  // 这里只用 goto 缩短无关的方案/编码链；goto 本身也由真实内核验真并
  // 落盘。关键的 terminal 则必须由真实 pipeline PASS 路由产生。
  await host.bootstrap("批准契约测试宿主切换到 external_verify。\n");
  const gotoMessage = messageId(cwd, "external_verify");
  kernel(cwd, "goto", "external_verify", "--force",
    "--message-id", gotoMessage);
  assert.equal(readState(cwd).current, "external_verify");

  const sha = git(cwd, "rev-parse", "HEAD");
  const facts = join(cwd, "pipeline-pass.json");
  writeFileSync(facts, JSON.stringify({
    sha,
    status: "success",
    source: "continuous-review-contract",
    git_push: { sha, ref: "refs/heads/master", remote: "origin" },
  }, null, 2));
  kernel(cwd, "pipeline", "record", "--file", facts);

  const before = readState(cwd);
  assert.equal(before.current, "end",
    "事故前置必须由真实 pipeline PASS 把真实内核推进到 end");
  assert.equal(before.config?.["单号"], TICKET,
    "终态必须带着真实 config-review/done 产生的配置，不能是空壳状态");
  assert.equal(existsSync(join(cwd, ".mae-flow.json.last")), false);

  // 真实事故不是夹具手写状态：旧宿主对 terminal 再执行 init，内核
  // 自己产出 `.last` 并回到 config_confirm。
  kernel(cwd, "init");
  const accident = readState(cwd);
  const archived = readState(cwd, ".last");
  assert.equal(accident.current, "config_confirm");
  assert.equal(archived.current, "end");
  assert.throws(() => migrateContinuousReviewTask({
    host: { kernelRoot: KERNEL_ROOT!, python: "mae-flow-python-missing" },
    cwd,
    workspace: dirname(cwd),
    taskId: "task-real-last",
    status: "queued",
    ticket: TICKET,
    baseline: "master",
    sourceBranch: archived.config?.["分支名"],
    reviewRepair: true,
    // python 起不来是基础设施故障:三次预算重试用尽后以"内核暂时不可用"
    // 抛出,和内核明确拒收("内核持续检视命令失败")分开。
  }), /内核暂时不可用/);
  assert.equal(readState(cwd).current, "config_confirm",
    "adopt 失败必须原子回滚事故现场，下一次 recover 才能重试");
  migrateContinuousReviewTask({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd,
    workspace: dirname(cwd),
    taskId: "task-real-last",
    status: "queued",
    ticket: TICKET,
    baseline: "master",
    sourceBranch: archived.config?.["分支名"],
    reviewRepair: true,
  });
  // 事故前的 PASS 来自旧契约，没有宿主收据。迁移完成后由 Cloud 用同
  // 一份平台事实补签一次，后续 close 才能证明这张绿灯不是 Agent
  // 直接改状态伪造的。
  const migratedFacts = JSON.parse(readFileSync(facts, "utf-8"));
  const pipelineProof = createKernelHostProof({
    cwd,
    workspace: dirname(cwd),
    taskId: "task-real-last",
    action: "pipeline-record",
    payload: migratedFacts,
  });
  try {
    kernel(cwd, "pipeline", "record", "--file", facts,
      "--host-proof", pipelineProof.path);
  } finally {
    pipelineProof.cleanup();
  }
  const watch = readState(cwd);
  assert.equal(watch.current, "delivery_watch");
  const batch = {
    schema: "mae-flow-feedback-batch/1" as const,
    batch_id: "fb-real-last-1",
    task_id: "task-real-last",
    base_sha: git(cwd, "rev-parse", "HEAD"),
    opened_at: new Date().toISOString(),
    items: [{
      id: "mr:d-1", source: "mr_discussion", source_id: "d-1",
      source_revision: 0, kind: "code_review",
      summary: "请修复空值场景", verification: "reviewer",
    }],
  };
  openKernelFeedback({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd, workspace: dirname(cwd), batch,
  });
  return {
    cwd,
    batch,
    before,
    after: readState(cwd),
    archived,
    lastPreserved: existsSync(join(cwd, ".mae-flow.json.last")),
    migrationRetryProved: true,
  };
}

let sharedScene: ReturnType<typeof reproduceTerminalRollover> | undefined;
function contractScene(): ReturnType<typeof reproduceTerminalRollover> {
  return sharedScene ??= reproduceTerminalRollover();
}

test("内核来源契约：Cloud 专属分支和分叉基线必须同时写进 VENDORED", () => {
  const metadata = readFileSync(join(KERNEL_ROOT!, "VENDORED"), "utf-8");
  assert.match(metadata, /^来源: mae-flow@[0-9a-f]{40}$/m);
  assert.match(metadata, /^分支: cloud\/workflow-customization$/m);
  assert.match(metadata,
    /^基线: mae-flow@ad5b92af3e19766558dbca476389dda5cd80d076$/m);
  assert.match(metadata, /更新跑 harness\/sync-kernel\.sh/,
    "快照必须保留禁止手改、只从源仓同步的纪律");
});

test("真实 .last 事故迁移：end 收到平台检视意见后续原单且不再重问配置", async () => {
  const scene = await contractScene();
  const actual = {
    current: scene.after.current,
    ticket: scene.after.config?.["单号"] ?? null,
    archivedCurrent: scene.archived?.current ?? null,
    lastPreserved: scene.lastPreserved,
  };
  assert.deepEqual(actual, {
    current: "feedback_triage",
    ticket: TICKET,
    archivedCurrent: "end",
    lastPreserved: true,
  });
});

test("事故迁移：首次 adopt 失败会回滚，第二次原地恢复成功", async () => {
  const scene = await contractScene();
  assert.equal(scene.migrationRetryProved, true);
  assert.equal(scene.after.current, "feedback_triage");
});

test("契约：一个 Cloud 任务从创建到 MR 合入只能执行一次 init", async () => {
  const scene = await contractScene();
  assert.equal(scene.lastPreserved, true);
  assert.equal(existsSync(join(scene.cwd, ".mae-flow.json.last.last")), false,
    "生产迁移和 feedback-open 都不得再归档一次状态");
  assert.deepEqual(scene.after.config, scene.before.config);
});

test("契约：MR 未合入前的反馈不得重问配置、交付方式或原需求", async () => {
  const scene = await contractScene();
  const current = kernel(scene.cwd, "current");
  assert.match(current, /当前步骤:\s*feedback_triage/);
  assert.doesNotMatch(current, /当前步骤:\s*(config_confirm|workflow_select)/);
});

test("契约：反馈修复始终沿用任务号、仓库、基线、分支、MR、责任人与资产快照", async () => {
  const scene = await contractScene();
  for (const key of ["单号", "基线分支", "分支名", "工号"]) {
    assert.equal(scene.after.config?.[key], scene.before.config?.[key], key);
  }
  assert.deepEqual(scene.after.choices, scene.before.choices);
  assert.equal(scene.after.execution_contract?.continuous_review, true);
});

test("契约：push、MR 创建和流水线变绿都不是任务终态", async () => {
  const scene = await contractScene();
  const flow = JSON.parse(readFileSync(join(KERNEL_ROOT!, "flow", "flow.json"), "utf-8"));
  assert.equal(flow.steps.delivery_watch.terminal, undefined);
  assert.equal(scene.after.current, "feedback_triage");
});

test("契约：同一 HEAD 的反馈重放幂等，新 HEAD 让旧质量证据失效", async () => {
  const scene = await contractScene();
  const before = readState(scene.cwd).delivery_loop.batches.length;
  const replay = openKernelFeedback({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd: scene.cwd, workspace: dirname(scene.cwd), batch: scene.batch,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(readState(scene.cwd).delivery_loop.batches.length, before);
});

test("契约：同一任务最多一个代码 writer，后到反馈进入队列", async () => {
  const scene = await contractScene();
  const second = {
    ...scene.batch,
    batch_id: "fb-real-last-2",
    items: [{
      id: "pipeline:compile", source: "pipeline", source_id: "compile",
      source_revision: 0, kind: "quality_failure",
      summary: "编译失败", verification: "pipeline",
    }],
  };
  const opened = openKernelFeedback({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd: scene.cwd, workspace: dirname(scene.cwd), batch: second,
  });
  const state = readState(scene.cwd);
  assert.equal(opened.status, "queued");
  assert.equal(state.delivery_loop.active_batch_id, scene.batch.batch_id);
  assert.equal(state.delivery_loop.batches.filter(
    (item: any) => item.status === "repairing").length, 1);
});

test("契约：每条反馈都有来源和精确回执，总体回复不能冒充闭环", async () => {
  const scene = await contractScene();
  assert.throws(() => recordKernelFeedbackResult({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd: scene.cwd,
    workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id,
    batchId: scene.batch.batch_id,
    changed: false,
    results: [],
  }), /缺少: mr:d-1/);
  const item = readState(scene.cwd).delivery_loop.batches[0].items[0];
  assert.equal(item.source, "mr_discussion");
  assert.equal(item.verification, "reviewer");
});

test("契约：新 HEAD 清掉旧绿灯，同一处理结果重放幂等", async () => {
  const scene = await contractScene();
  writeFileSync(join(scene.cwd, "main.ts"), "export const ready = false;\n");
  git(scene.cwd, "add", "main.ts");
  git(scene.cwd, "commit", "--quiet", "-m", "fix feedback");
  const input = {
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd: scene.cwd,
    workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id,
    batchId: scene.batch.batch_id,
    changed: true,
    results: [{ id: "mr:d-1", status: "fixed" as const,
      summary: "已修复", evidence: "main.ts" }],
  };
  const first = recordKernelFeedbackResult(input);
  const replay = recordKernelFeedbackResult(input);
  const state = readState(scene.cwd);
  assert.equal(first.status, "awaiting_verification");
  assert.equal(replay.idempotent, true);
  assert.notEqual(state.quality?.external_verification?.sha,
    git(scene.cwd, "rev-parse", "HEAD"));
});

let humanScene: ReturnType<typeof reproduceTerminalRollover> | undefined;
function needsHumanScene(): ReturnType<typeof reproduceTerminalRollover> {
  return humanScene ??= reproduceTerminalRollover();
}

test("契约：模糊或无法处理时明确停点，不猜、不糊弄、不无限空转", async () => {
  const scene = await needsHumanScene();
  recordKernelFeedbackResult({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd: scene.cwd,
    workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id,
    batchId: scene.batch.batch_id,
    changed: false,
    results: [{ id: "mr:d-1", status: "needs_human",
      summary: "空值代表缺省还是非法输入会产生不同实现，需要检视人决定" }],
  });
  const batch = readState(scene.cwd).delivery_loop.batches[0];
  assert.equal(batch.status, "needs_human");
  assert.match(batch.results[0].summary, /不同实现/);
  assert.notEqual(readState(scene.cwd).current, "end");
});

test("契约：只有 MR 合入或用户主动停止，Cloud 与内核才一起终止", async () => {
  const scene = await needsHumanScene();
  const sha = git(scene.cwd, "rev-parse", "HEAD");
  assert.notEqual(readState(scene.cwd).current, "end");
  closeKernelDelivery({
    host: { kernelRoot: KERNEL_ROOT!, python: "python3" },
    cwd: scene.cwd,
    workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id,
    sha,
    eventId: `mr-merged:${sha}`,
  });
  assert.equal(readState(scene.cwd).current, "end");
});


test("外部新 SHA 的可信 close 解锁终态，旧流水线不伪造为新 SHA PASS", async () => {
  const scene = await needsHumanScene();
  const before = readState(scene.cwd).quality;
  const merged = "f".repeat(40);
  const host = { kernelRoot: KERNEL_ROOT!, python: "python3" };
  closeKernelDelivery({ host, cwd: scene.cwd, workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id, sha: merged, eventId: `external:${merged}` });
  const trust = { workspace: dirname(scene.cwd), taskId: scene.batch.task_id, python: "python3" };
  const completion = inspectKernelTaskCompletion(scene.cwd, KERNEL_ROOT!, true, trust);
  assert.equal(completion.complete, true);
  assert.equal(completion.external_passed, false, "外部合入不伪造流水线已通过");
  assert.deepEqual(readState(scene.cwd).quality, before);
  assert.equal(inspectKernelDeliveryReady(scene.cwd, KERNEL_ROOT!, true, trust).complete, false);
  const state = readState(scene.cwd);
  state.delivery_loop.close_events.at(-1).sha = "a".repeat(40);
  writeFileSync(join(scene.cwd, ".mae-flow.json"), JSON.stringify(state));
  assert.equal(inspectKernelTaskCompletion(scene.cwd, KERNEL_ROOT!, true, trust).complete, false,
    "Agent 改写合入 SHA 后宿主签名必须失效");
});

test("目标调整：暂缓 A 后提升 B，真实收据可恢复且不伪造质量结论", async () => {
  const scene = await reproduceTerminalRollover();
  const host = { kernelRoot: KERNEL_ROOT!, python: "python3" };
  const before = readState(scene.cwd);
  const second = { ...scene.batch, batch_id: "fb-next-target", items: [{
    ...scene.batch.items[0], id: "mr:d-2", source_id: "d-2", summary: "修复 B",
  }] };
  openKernelFeedback({ host, cwd: scene.cwd, workspace: dirname(scene.cwd), batch: second });
  const input = { host, cwd: scene.cwd, workspace: dirname(scene.cwd), taskId: scene.batch.task_id,
    operationId: "owner-target-1", target: "修复 B，先推送", actor: "owner", requestId: "owner-message-7",
    reason: "A 本轮不需要修复", feedbackId: "mr:d-1" };
  const result = controlKernelFeedback(input);
  const after = readState(scene.cwd);
  assert.equal(result.status, "target-updated");
  assert.equal(after.delivery_loop.active_batch_id, second.batch_id);
  assert.equal(after.delivery_loop.batches[0].status, "deferred");
  assert.equal(after.delivery_loop.batches[0].result_digest, undefined);
  assert.deepEqual(after.quality, before.quality);
  assert.equal(controlKernelFeedback(input).idempotent, true);
  assert.equal(readState(scene.cwd).delivery_loop.controls.length, 1);
  assert.throws(() => controlKernelFeedback({ ...input, target: "暗改原决定" }), /同一目标调整操作/);
  const attest = (state: any) => attestKernelHost({ host, cwd: scene.cwd, state,
    lifecycle: ["feedback-open"], feedbackLoop: true });
  assert.equal(attest(after).feedbackLoop, true);
  assert.equal(attest({ ...after, current: "build" }).feedbackLoop, true,
    "正常工作阶段前移不应让已登记的暂缓失效");
  const forged = structuredClone(after);
  forged.delivery_loop.deferred_feedback["mr:d-2"] = forged.delivery_loop.target;
  assert.equal(attest(forged).feedbackLoop, false, "不能手改 JSON 夹带忽略另一条");
});

test("目标调整：仅暂缓一条不吞同批其他意见，也不要求 Agent 假造被暂缓项的回执", async () => {
  const scene = await reproduceTerminalRollover();
  const host = { kernelRoot: KERNEL_ROOT!, python: "python3" };
  const second = { ...scene.batch, batch_id: "fb-two-items", items: [
    { ...scene.batch.items[0], id: "mr:d-2", source_id: "d-2" },
    { ...scene.batch.items[0], id: "mr:d-3", source_id: "d-3" },
  ] };
  openKernelFeedback({ host, cwd: scene.cwd, workspace: dirname(scene.cwd), batch: second });
  const common = { host, cwd: scene.cwd, workspace: dirname(scene.cwd), taskId: scene.batch.task_id,
    target: "处理剩余意见", actor: "owner", requestId: "message", reason: "此项延期" };
  controlKernelFeedback({ ...common, operationId: "defer-first", feedbackId: "mr:d-1" });
  controlKernelFeedback({ ...common, operationId: "defer-second", feedbackId: "mr:d-2" });
  assert.equal(readState(scene.cwd).delivery_loop.active_batch_id, second.batch_id);
  assert.throws(() => recordKernelFeedbackResult({ host, cwd: scene.cwd, workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id, batchId: second.batch_id, changed: false, results: [] }), /mr:d-3/);
  recordKernelFeedbackResult({ host, cwd: scene.cwd, workspace: dirname(scene.cwd),
    taskId: scene.batch.task_id, batchId: second.batch_id, changed: false,
    results: [{ id: "mr:d-3", status: "explained", summary: "已核对 B 无需改动" }] });
  const final = readState(scene.cwd).delivery_loop.batches[1];
  assert.equal(final.results.find((row: any) => row.id === "mr:d-2").status, "explained");
  assert.match(final.results.find((row: any) => row.id === "mr:d-2").summary, /责任人暂缓/);
});
