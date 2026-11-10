import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { closeKernelDelivery, ensureKernelHostCapability } from "../src/kernelDelivery.ts";
import { continuationHistoryZip, continuationInstructions } from "../src/taskContinuation.ts";
import { buildDeliveryAnalysis, collectDeliveryCode } from "../src/deliveryAnalytics.ts";
import { aggregateDelivery, aggregateDeliveryModules, aggregateDeliveryTokens } from "../src/deliveryAnalyticsSummary.ts";

const kernelRoot = join(process.cwd(), "kernel");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), "mfc-continue-"));
  const source = join(root, "source"); mkdirSync(source);
  git(source, "init", "-q", "-b", "master");
  git(source, "config", "user.name", "alice"); git(source, "config", "user.email", "alice@example.test");
  writeFileSync(join(source, "main.cpp"), "int base = 1;\n");
  writeFileSync(join(source, ".gitignore"), "target/\n.mae-flow*\n");
  git(source, "add", "."); git(source, "commit", "-qm", "base");
  const options = { dataDir: join(root, "data"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot, repoPath: source, python: "python3", continuousReview: true } };
  const service = new TaskService(options);
  const created = service.create("原需求：实现批量处理", { account: "alice", repo: source, ticket: "REQ-1", baseline: "master" });
  const task = (service as any).tasks.get(created.id);
  const cwd = join(created.workspace, "source");
  git(root, "clone", "-q", source, cwd);
  git(cwd, "config", "user.name", "alice"); git(cwd, "config", "user.email", "alice@example.test");
  const branch = "master_alice_REQ-1";
  git(cwd, "checkout", "-qb", branch);
  writeFileSync(join(cwd, "main.cpp"), "int base = 1;\nint delivered = 2;\n");
  git(cwd, "add", "main.cpp"); git(cwd, "commit", "-qm", "first delivery");
  const sha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "push", "-q", "origin", `${branch}:refs/heads/${branch}`);
  git(source, "merge", "--ff-only", branch);
  git(source, "branch", "-D", branch); // 合入后删除远端工作分支。
  writeFileSync(join(source, "upstream.cpp"), "int upstream = 3;\n");
  git(source, "add", "."); git(source, "commit", "-qm", "another delivery");
  const latest = git(source, "rev-parse", "HEAD");
  const authority = ensureKernelHostCapability({ workspace: created.workspace, taskId: created.id, cwd });
  writeFileSync(join(cwd, ".mae-flow-order.json"), JSON.stringify({
    execution_contract: { schema: "mae-flow-execution/1", host: "cloud", compile: "pipeline", ut_write: "agent",
      ut_run: "pipeline", codecheck: "pipeline", git_push: "host", continuous_review: true, host_authority: authority },
    "单号": "REQ-1", "基线分支": "master", "工号": "alice", "交付方式": "局部修改",
  }));
  const host = new KernelHost({ kernelRoot, workspace: cwd, taskId: created.id, transcriptPath: join(created.workspace, "transcript.jsonl") });
  await host.bootstrapManaged("原需求");
  const initialized = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
  initialized.step_heads = { branch_create: git(cwd, "rev-parse", "master") };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(initialized));
  closeKernelDelivery({ host: options.host, cwd, workspace: created.workspace, taskId: created.id,
    sha, eventId: "first-merge" });
  task.cwd = cwd;
  task.summary.status = "completed";
  task.summary.delivery = { mr_id: 1, mr_url: "https://git.example/mr/1", mr_state: "已合入", merged_sha: sha,
    source_branch: branch, target_branch: "master", git_push: { sha, ref: `refs/heads/${branch}`, remote: "origin" }, pipeline: "success" };
  (service as any).persist(task);
  mkdirSync(join(cwd, "target")); writeFileSync(join(cwd, "target", "compiled.o"), "build cache");
  mkdirSync(join(cwd, ".mae-flow-work", "REQ-1"), { recursive: true });
  writeFileSync(join(cwd, ".mae-flow-work", "REQ-1", "story.md"), "原交付设计");
  writeFileSync(join(cwd, "main.cpp"), "unimportant leftovers\n");
  writeFileSync(join(created.workspace, "annotations.jsonl"), "old feedback\n");
  writeFileSync(join(created.workspace, "交付报告.md"), "first MR summary");
  t.after(async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { service, task, created, root, source, cwd, branch, latest, options, host };
}

test("合入后原任务继续：更新基准、丢弃残留修改、保留缓存材料，内核正规换轮且请求幂等", async t => {
  const f = await fixture(t);
  const before = await collectDeliveryCode(f.task.summary, f.cwd, f.task.summary.delivery.git_push.sha);
  const next = await f.service.continueDelivery(f.created.id, "修复空行，并更新说明", "continue-request-1", "alice");
  assert.equal(next.id, f.created.id); assert.equal(next.status, "queued");
  assert.equal(next.delivery, undefined); assert.equal(next.delivery_history?.[0].delivery?.mr_id, 1);
  assert.equal(git(f.cwd, "branch", "--show-current"), f.branch);
  assert.equal(git(f.cwd, "rev-parse", "HEAD"), f.latest);
  assert.equal(git(f.cwd, "rev-parse", "master"), f.latest);
  assert.equal(git(f.cwd, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(readFileSync(join(f.cwd, "target/compiled.o"), "utf8"), "build cache");
  assert.equal(readFileSync(join(f.cwd, ".mae-flow-work/REQ-1/story.md"), "utf8"), "原交付设计");
  const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.current, "config_confirm");
  assert.equal(JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json.last"), "utf8")).current, "end");
  assert.equal(existsSync(join(f.created.workspace, "annotations.jsonl")), false);
  assert.equal(existsSync(join(f.created.workspace, "交付报告.md")), false);
  assert.ok(continuationHistoryZip(f.created.workspace, "continue-request-1").length > 0);
  assert.match(continuationInstructions(next), /修复空行/);
  const repeat = await f.service.continueDelivery(f.created.id, "修复空行，并更新说明", "continue-request-1", "alice");
  assert.equal(repeat.delivery_history?.length, 1);
  assert.equal((f.service as any).current(f.task, f.task.controlEpoch), false, "旧回调不再拥有状态写入权");
  f.task.summary.status = "failed"; (f.service as any).persist(f.task);
  assert.equal(f.service.get(f.created.id)?.status, "queued");
  const report = buildDeliveryAnalysis([next]);
  assert.equal(report.rows.length, 2); assert.equal(report.rows.filter(r => r.merged).length, 1);
  assert.deepEqual(report.rows[0].metric?.retained, before.retained, "继续修改不会抹掉此前统计");
  const recovered = new TaskService(f.options); recovered.recover();
  assert.equal(recovered.get(f.created.id)?.status, "queued", "重启不能从旧 close 恢复完成");
  await recovered.shutdown();
});

test("远端分支仍存在时不覆盖；失败跨重启后按已保存要求重试", async t => {
  const f = await fixture(t);
  git(f.source, "branch", f.branch);
  await assert.rejects(f.service.continueDelivery(f.created.id, "修复边界", "continue-request-2", "alice"), /同名工作分支仍存在/);
  assert.match(readFileSync(join(f.cwd, "main.cpp"), "utf8"), /leftovers/);
  const recovered = new TaskService(f.options); recovered.recover();
  t.after(() => recovered.shutdown());
  assert.equal(recovered.get(f.created.id)?.continuation?.state, "failed");
  assert.equal(recovered.get(f.created.id)?.status, "completed");
  git(f.source, "branch", "-D", f.branch);
  const next = await recovered.continueDelivery(f.created.id, "修复边界", "continue-request-2", "alice");
  assert.equal(next.status, "queued"); assert.equal(next.delivery_history?.length, 1);
});

test("继续修改只接受任务责任人的明确要求，普通 bootstrap 仍拒绝终态", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.continueDelivery(f.created.id, "", "continue-request-3", "alice"), /填写本次/);
  await assert.rejects(f.service.continueDelivery(f.created.id, "修改", "continue-request-3", "bob"), /责任人/);
  await assert.rejects(f.host.bootstrapManaged("随便继续"), /终态/);
  assert.equal(f.service.get(f.created.id)?.continuation, undefined);
});

test("内核初始化后宿主中断，重启重试沿用已初始化现场且不重复历史", async t => {
  const f = await fixture(t);
  const original = KernelHost.prototype.initializeNextDelivery;
  KernelHost.prototype.initializeNextDelivery = async function () {
    await original.call(this);
    throw new Error("模拟初始化后的服务中断");
  };
  try {
    await assert.rejects(f.service.continueDelivery(f.created.id, "修复空行", "interrupted-request", "alice"), /服务中断/);
  } finally { KernelHost.prototype.initializeNextDelivery = original; }
  const recovered = new TaskService(f.options); recovered.recover();
  try {
    const next = await recovered.continueDelivery(f.created.id, "修复空行", "interrupted-request", "alice");
    assert.equal(next.status, "queued");
    assert.equal(next.delivery_history?.length, 1);
    assert.equal(readFileSync(join(f.cwd, "target/compiled.o"), "utf8"), "build cache");
    assert.equal(JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json.last"), "utf8")).current, "end");
  } finally { await recovered.shutdown(); }
});

test("连续交付保留每个 MR 的代码统计，新一轮不重复统计已有代码", async t => {
  const f = await fixture(t);
  const first = await collectDeliveryCode(f.task.summary, f.cwd, f.task.summary.delivery.git_push.sha);
  await f.service.continueDelivery(f.created.id, "补充空行处理", "second-delivery-request", "alice");
  const task = (f.service as any).tasks.get(f.created.id);
  const path = join(f.cwd, ".mae-flow.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.step_heads = { branch_create: f.latest };
  writeFileSync(path, JSON.stringify(state));
  writeFileSync(join(f.cwd, "empty.cpp"), "int skip_empty = 1;\n");
  git(f.cwd, "add", "empty.cpp"); git(f.cwd, "commit", "-qm", "handle empty lines");
  const sha = git(f.cwd, "rev-parse", "HEAD");
  git(f.cwd, "push", "-q", "origin", `${f.branch}:refs/heads/${f.branch}`);
  git(f.source, "merge", "--ff-only", f.branch); git(f.source, "branch", "-D", f.branch);
  task.summary.delivery = { ...f.task.summary.delivery, mr_id: 2, mr_url: "https://git.example/mr/2", merged_sha: sha,
    git_push: { sha, ref: `refs/heads/${f.branch}`, remote: "origin" } };
  task.summary.status = "completed";
  closeKernelDelivery({ host: f.options.host, cwd: f.cwd, workspace: f.created.workspace,
    taskId: f.created.id, sha, eventId: "second-merge" });
  (f.service as any).persist(task);
  const second = await collectDeliveryCode(task.summary, f.cwd, sha);
  const next = await f.service.continueDelivery(f.created.id, "更新边界测试", "third-delivery-request", "alice");
  assert.deepEqual(next.delivery_history?.map(h => h.delivery?.mr_id), [1, 2]);
  const report = buildDeliveryAnalysis([next]);
  assert.equal(report.rows.length, 3);
  assert.deepEqual(report.rows.filter(r => r.merged).map(r => r.metric?.retained), [first.retained, second.retained]);
  assert.equal(aggregateDelivery(report.rows).total, 2);
  assert.equal(git(f.cwd, "rev-parse", "HEAD"), sha);
  await assert.rejects(f.service.continueDelivery(f.created.id, "旧请求", "second-delivery-request", "alice"), /请求已结束/);
});

test("交付统计按每次交付累加代码，任务 Token 只计算一次", () => {
  const metric = { retained: { first: 10, review: 0, pipeline: 0, other: 0 }, rework: { first: 0, review: 0, pipeline: 0, other: 0 }, deleted: 0 } as any;
  const rows = ["initial", "next"].map(delivery_id => ({ id: "task-1", delivery_id, title: "任务", repo: "repo", modules: [],
    merged: true, at: "2026-09-28", metric, business_module: { id: "m", name: "模块" } }));
  assert.equal(aggregateDelivery(rows).total, 20);
  assert.equal(aggregateDeliveryModules(rows)[0].lines, 20);
  assert.equal(aggregateDeliveryTokens(rows.map(r => r.id), [{ id: "task-1", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }]).total, 15);
});

test("子任务继续修改使主任务恢复协调，内核未完成时不能重置目录", async t => {
  const f = await fixture(t);
  const created = f.service.create("主需求", { account: "alice" });
  const parent = (f.service as any).tasks.get(created.id);
  parent.summary.requirement_analysis_requested = true;
  parent.summary.requirement_graph = { stage: "confirmed", repositories: [{
    id: "repo-1", name: "代码仓", url: f.source, task_id: f.created.id,
  }], dependencies: [] };
  f.task.summary.parent_task_id = created.id;
  (f.service as any).persist(f.task);
  assert.equal(f.service.get(created.id)?.status, "completed");
  const path = join(f.cwd, ".mae-flow.json");
  const saved = readFileSync(path, "utf8");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(saved), current: "build" }));
  await assert.rejects(f.service.continueDelivery(f.created.id, "修复空行", "child-delivery-request", "alice"), /不能重置代码目录/);
  assert.match(readFileSync(join(f.cwd, "main.cpp"), "utf8"), /leftovers/);
  writeFileSync(path, saved);
  await f.service.continueDelivery(f.created.id, "修复空行", "child-delivery-request", "alice");
  assert.equal(f.service.get(created.id)?.status, "coordinating");
});

test("最终 MR 的目标分支不同或无法确认时，继续修改和重试都不触碰原任务或工作区", async t => {
  const f = await fixture(t);
  const original = f.task.summary.delivery;
  const final = { url: "https://code.example/team/repo/-/merge_requests/2", id: 2, repo: f.source,
    source_branch: "local-edit", target_branch: "release/v2", state: "merged" };
  const head = git(f.cwd, "rev-parse", "HEAD");
  const dirtyFile = readFileSync(join(f.cwd, "main.cpp"), "utf8");
  const taskFile = join(f.created.workspace, "task.json");
  const requestId = "final-mr-retry";
  const saved = { id: requestId, text: "继续调整", actor: "alice", at: new Date().toISOString(),
    state: "failed", error: "原准备记录", branch: f.branch, baseline: "master" };
  let waits = 0;
  f.task.finalMrAnalysis = { get work() { waits++; return Promise.resolve(); } };
  for (const [oldTarget, nextTarget, finalTarget, orderBaseline, expected] of [
    ["master", undefined, "release/v2", "master", /master.*release\/v2.*创建新任务/],
    ["master", "release/v2", "release/v2", "master", /master.*release\/v2.*创建新任务/],
    ["master", "staging", "master", "master", /master.*staging.*创建新任务/],
    [undefined, undefined, "release/v2", undefined, /原交付目标分支为未知.*release\/v2.*创建新任务/],
    ["master", undefined, undefined, "master", /master.*目标分支为未知.*确认目标分支/],
  ] as const) {
    f.task.summary.baseline = orderBaseline;
    f.task.summary.delivery = { ...original, target_branch: oldTarget, final_mr: { ...final, target_branch: finalTarget } };
    f.task.summary.continuation = nextTarget ? { ...saved, baseline: nextTarget } : undefined;
    const before = structuredClone(f.task.summary);
    const persisted = readFileSync(taskFile, "utf8");
    await assert.rejects(f.service.continueDelivery(f.created.id, saved.text, requestId, "alice"), expected);
    assert.deepEqual(f.task.summary, before);
    assert.equal(readFileSync(taskFile, "utf8"), persisted);
    assert.equal(existsSync(join(f.created.workspace, "delivery-history", requestId)), false);
    assert.equal(git(f.cwd, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(f.cwd, "main.cpp"), "utf8"), dirtyFile);
  }
  for (const state of ["opened", "closed", undefined]) {
    f.task.summary.delivery = { ...original, final_mr: { ...final, target_branch: "master", state } };
    await assert.rejects(f.service.continueDelivery(f.created.id, saved.text, requestId, "alice"), /尚未确认最终 MR 已合入/);
  }
  assert.equal(waits, 0);
});

test("最终 MR 仅换源分支，旧任务能从已记录的原基线继续并保留最终 MR 历史", async t => {
  const f = await fixture(t);
  f.task.summary.delivery.target_branch = undefined;
  f.task.summary.delivery.final_mr = { url: "https://code.example/team/repo/-/merge_requests/2", id: 2,
    repo: f.source, source_branch: "local-edit", target_branch: "master", state: "merged" };
  const next = await f.service.continueDelivery(f.created.id, "继续调整", "same-target-new-source", "alice");
  assert.equal(next.status, "queued");
  assert.equal(next.continuation?.baseline, "master");
  assert.equal(git(f.cwd, "rev-parse", "HEAD"), f.latest);
  assert.equal(next.delivery_history?.[0].delivery?.final_mr?.source_branch, "local-edit");
});

test("未建平台 MR 时用本轮宿主推送记录恢复平台工作分支，在最终 MR 合入后继续修改", async t => {
  const f = await fixture(t);
  const d = f.task.summary.delivery;
  const sha = d.git_push.sha;
  f.task.summary.status = "await_merge";
  delete d.mr_id; delete d.mr_url; delete d.source_branch;
  const finalUrl = "https://code.example/team/repo/-/merge_requests/2";
  t.mock.method(f.service as any, "readFinalMr", async () => ({ url: finalUrl, iid: "2", repo: f.source,
    source_branch: "local-owner-branch", target_branch: "master", sha, base_sha: git(f.cwd, "rev-parse", sha + "^"), state: "merged" }));
  const merged = await f.service.linkFinalMr(f.created.id, finalUrl);
  assert.equal(merged.delivery?.initial_mr, undefined);
  assert.equal(merged.delivery?.source_branch, f.branch);
  assert.equal(merged.delivery?.final_mr?.source_branch, "local-owner-branch");
  const next = await f.service.continueDelivery(f.created.id, "继续调整", "recovered-platform-branch", "alice");
  assert.equal(next.status, "queued"); assert.equal(next.continuation?.branch, f.branch);
  assert.equal(git(f.cwd, "branch", "--show-current"), f.branch);
});
