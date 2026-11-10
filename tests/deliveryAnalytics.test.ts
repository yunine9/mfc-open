import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { inferCommitOrigin } from "../src/deliveryOriginInference.ts";
import { calculateDeliveryCode } from "../src/deliveryAnalyticsGit.ts";
import { collectDeliveryCode, buildDeliveryAnalysis, hasFinalMrSample, readFinalMrComparison, observeDeliveryCode, awaitDeliveryAnalytics, repairOrigin, recordDeliveryPublication } from "../src/deliveryAnalytics.ts";
import { DeliveryImprovements } from "../src/deliveryImprovement.ts";
import { aggregateDelivery, aggregateDeliveryModules } from "../src/deliveryAnalyticsSummary.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-analysis-")), cwd = join(dir, "repo"), workspace = join(dir, "task-1");
  mkdirSync(cwd); mkdirSync(workspace);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  const write = (path: string, content: string) => writeFileSync(join(cwd, path), content);
  const commit = (subject: string) => { git("add", "--all"); git("commit", "-m", subject); return git("rev-parse", "HEAD"); };
  write("existing.cpp", "int baseline = 1;\n");
  const base = commit("baseline"); git("update-ref", "refs/remotes/origin/main", base); git("checkout", "-b", "task");
  write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: base } }));
  const summary = { id: "task-1", title: "真实 Git 统计测试", requirement: "test", status: "await_merge", workspace,
    created_at: new Date().toISOString(), delivery: { target_branch: "main" } } as TaskSummary;
  const publish = (sha: string) => { summary.delivery!.git_push = { sha, ref: "refs/heads/task", remote: "origin" }; };
  return { dir, cwd, workspace, git, write, commit, base, summary, publish };
}

test("真实 Git：首次保留、CI、检视、反复修改分别计数；最终比率不是累计提交量", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\nint b = 2;\nint c = 3;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first };
  f.write("feature.cpp", "int a = 10;\nint b = 2;\nint c = 3;\n"); const ci = f.commit("not inferred from subject");
  f.publish(ci); await collectDeliveryCode(f.summary, f.cwd, ci);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "review", last_sha: ci };
  f.write("feature.cpp", "int a = 20;\nint b = 2;\nint c = 3;\n"); const head = f.commit("review");
  f.publish(head); const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.deepEqual(result.retained, { first: 2, pipeline: 0, review: 1, other: 0 });
  assert.deepEqual(result.rework, { first: 0, pipeline: 2, review: 2, other: 0 });
  f.summary.status = "completed"; f.summary.delivery!.mr_state = "已合入"; f.summary.delivery!.merged_sha = head;
  f.git("update-ref", "refs/remotes/origin/main", head);
  rmSync(f.cwd, { recursive: true });
  const report = buildDeliveryAnalysis([f.summary]);
  assert.equal(report.rows[0].metric!.head, head, "workspace reclamation preserves numbers");
  assert.equal(aggregateDelivery(report.rows).firstPercent, 2 / 3 * 100);
});

test("平台外协作按本轮实际交接或吸收提交标记，同一 MR 也能体现", t => {
  const { summary, base } = fixture(t);
  const mr = "https://code.example/team/repo/-/merge_requests/1";
  const delivery = { mr_url: mr, mr_state: "merged", merged_sha: base };
  summary.delivery_history = [{
    id: "initial", archive: "history", started_at: summary.created_at, completed_at: summary.created_at,
    delivery: { ...delivery, foreign_commits: { count: 1, base_sha: base, absorbed_at: summary.created_at, subjects: ["调整实现"] } },
  }];
  summary.delivery = { ...delivery, mr_url: mr + "2" };
  summary.delivery_generation = "next";
  const flags = () => buildDeliveryAnalysis([summary]).rows.map(row => !!row.external_collaboration);
  assert.deepEqual(flags(), [true, false], "上一轮的外部提交、这一轮新开的 MR 均不会给新一轮打标");
  summary.delivery.final_mr = { id: 12, url: summary.delivery.mr_url!, repo: "team/repo", state: "merged",
    source_branch: "feature", target_branch: "main", head: base };
  assert.deepEqual(flags(), [true, true], "显式交给平台只读跟踪即已交接，无需对比链接或猜测作者");
});

test("#462 已完成交付保留待对账文案时仍计为已合入，未完成任务不提前计入", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int feature = 1;\n");
  const head = f.commit("实现"); f.publish(head);
  await collectDeliveryCode(f.summary, f.cwd, head);
  f.summary.completed_at = "2026-09-21T10:00:00.000Z";
  const pending = "已合入（内核终态待对账）";
  const cases: Array<[TaskSummary["status"], string | undefined, boolean]> = [
    ["completed", pending, true], ["completed", "已合入", true], ["completed", "merged", true],
    ["verifying", pending, false], ["await_merge", pending, false], ["canceled", pending, false],
    ["completed", "等待合入", false], ["completed", "已关闭", false], ["completed", undefined, false],
  ];
  for (const [status, mrState, expected] of cases) {
    f.summary.status = status; f.summary.delivery!.mr_state = mrState;
    const original = structuredClone(f.summary);
    const report = buildDeliveryAnalysis([f.summary]);
    assert.equal(report.rows[0].merged, expected, `${status} / ${mrState}`);
    assert.equal(aggregateDelivery(report.rows.filter(row => row.merged)).total, expected ? 1 : 0);
    assert.equal(aggregateDeliveryModules(report.rows).length, expected ? 1 : 0);
    assert.deepEqual(f.summary, original, "统计读取不改写任务或合入事实");
  }
  f.summary.status = "running";
  f.summary.delivery_history = [{ id: "initial", started_at: f.summary.created_at, archive: join(f.workspace, "delivery-history", "initial"),
    completed_at: f.summary.completed_at, delivery: { ...f.summary.delivery!, mr_state: pending } }];
  f.summary.delivery_generation = "second";
  f.summary.delivery = {};
  f.summary.completed_at = undefined;
  const report = buildDeliveryAnalysis([f.summary]);
  assert.deepEqual(report.rows.map(row => row.merged), [true, false], "历史交付与本轮交付分别判断");
  assert.equal(aggregateDelivery(report.rows.filter(row => row.merged)).total, 1);
});

test("目标分支的外来修改与合并提交不算任务首次提交或返工", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int own = 1;\n"); const first = f.commit("own");
  f.git("checkout", "main"); f.write("existing.cpp", "int upstream = 2;\n"); const upstream = f.commit("someone else");
  f.git("update-ref", "refs/remotes/origin/main", upstream); f.git("checkout", "task"); f.git("merge", "--no-ff", "main", "-m", "sync target");
  const head = f.git("rev-parse", "HEAD"); f.publish(head);
  const metric = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(metric.first, first); assert.equal(metric.base, upstream);
  assert.deepEqual(metric.retained, { first: 1, pipeline: 0, review: 0, other: 0 });
  assert.equal(metric.commits.length, 1); assert.equal(aggregateDelivery([{ metric } as any]).total, 1);
});

test("纯重命名不增加返工；包含空格和换行的路径可追溯", async t => {
  const f = fixture(t), original = "new space\nfile.cpp", renamed = "renamed file.cpp";
  f.write(original, "int a = 1;\nint b = 2;\n"); const first = f.commit("first");
  f.git("mv", original, renamed); const head = f.commit("rename");
  const metric = await calculateDeliveryCode({ cwd: f.cwd, base: f.base, head });
  assert.equal(metric.retained.first, 2); assert.equal(metric.first, first);
  assert.equal(metric.commits[1].additions, 0); assert.equal(metric.commits[1].deletions, 0);
});

test("修改已存在文件后重命名只计真实变化；删除、文档、生成物不会虚增最终代码", async t => {
  const f = fixture(t);
  f.write("existing.cpp", "int baseline = 2;\n"); f.write("README.md", "docs\n");
  mkdirSync(join(f.cwd, "generated")); f.write("generated/a.cpp", "ignore\n"); const first = f.commit("first");
  f.git("mv", "existing.cpp", "renamed.cpp"); const head = f.commit("rename");
  const metric = await calculateDeliveryCode({ cwd: f.cwd, base: f.base, head });
  assert.equal(metric.retained.first, 1); assert.ok(metric.excluded_files >= 2);
  f.git("rm", "renamed.cpp"); const deleted = f.commit("remove");
  const final = await calculateDeliveryCode({ cwd: f.cwd, base: f.base, head: deleted, first });
  assert.equal(aggregateDelivery([{ metric: final } as any]).total, 0);
  assert.equal(final.deleted, 1);
});

test("并行流水线与检视有明确CI依据归流水线；首个文档提交不会被换成首个代码提交", async t => {
  const f = fixture(t); f.write("README.md", "first docs\n"); const first = f.commit("docs");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first, workspace_review_pending: true };
  f.write("feature.cpp", "int a = 1;\n"); const head = f.commit("CI fix but really mixed"); f.publish(head);
  const metric = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(metric.first, first); assert.equal(metric.retained.pipeline, 1); assert.equal(metric.retained.first, 0);
  assert.equal(repairOrigin({ round: 1, state: "repairing", kind: "conflict" }), "review");
});

test("历史改写不重定义首次提交；合入后可用任务基线补算；采集失败不改变任务", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.git("reset", "--soft", f.base); const head = f.commit("rewritten first"); f.publish(head);
  const before = JSON.stringify(f.summary); observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(JSON.stringify(f.summary), before);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined);
  const other = { ...f.summary, id: "task-2", workspace: join(f.dir, "task-2") };
  f.git("update-ref", "refs/remotes/origin/main", head);
  const recovered = await collectDeliveryCode(other, f.cwd, head);
  assert.equal(recovered.base, f.base); assert.equal(recovered.retained.first, 1);
});

test("父任务和问题单不重复纳入；缺失证据不参与平均；汇总按代码行加权", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const head = f.commit("first"); f.publish(head);
  await collectDeliveryCode(f.summary, f.cwd, head);
  f.summary.parent_task_id = "task-parent"; f.summary.status = "completed";
  Object.assign(f.summary.delivery!, { mr_state: "merged", merged_sha: head });
  const report = buildDeliveryAnalysis([f.summary, { ...f.summary, id: "task-parent", parent_task_id: undefined },
    { ...f.summary, id: "issue-task", origin: "issue" }, { ...f.summary, id: "task-missing" }]);
  assert.deepEqual(report.rows.map(r => r.id), ["task-1", "task-missing"]);
  const total = aggregateDelivery(report.rows); assert.equal(total.available, 1); assert.equal(total.tasks, 2); assert.equal(total.firstPercent, 100);
});

test("API 需登录，普通团队成员可读，响应与程序化统计一致", async t => {
  const f = fixture(t), auth = new LocalAuth(join(f.dir, "auth.json"));
  auth.bootstrapAdmin("admin", "analytics-test-pass"); auth.createUser("developer", "analytics-test-pass", "developer");
  const expected = buildDeliveryAnalysis([f.summary]);
  const service = new TaskService({ dataDir: f.dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  service.deliveryAnalysis = () => expected;
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${url}/delivery-analytics`)).status, 401);
  const response = await fetch(`${url}/auth/login`, { method: "POST", body: JSON.stringify({ username: "developer", password: "analytics-test-pass" }) });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const result = await fetch(`${url}/delivery-analytics`, { headers: { cookie } });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), JSON.parse(JSON.stringify(expected)));
});

test("漏采推送仍按修复起点归因，不把更早的未知提交归入本轮", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.write("feature.cpp", "int a = 2;\n"); const unsampled = f.commit("unknown");
  f.summary.delivery!.loop = { round: 2, state: "repairing", kind: "review", last_sha: unsampled };
  f.write("feature.cpp", "int a = 3;\n"); const head = f.commit("change"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.commits.find(c => c.sha === unsampled)?.origin, "first");
  assert.equal(result.commits.find(c => c.sha === head)?.origin, "review");
  assert.deepEqual(result.rework, { first: 0, pipeline: 0, review: 2, other: 0 });
  const fresh = { ...f.summary, id: "task-fresh" };
  const withoutSnapshot = await collectDeliveryCode(fresh, f.cwd, head);
  assert.deepEqual(withoutSnapshot.retained, result.retained, "归因不要求曾采集上轮快照");
});

test("同一源版本的新证据自动更新缓存，合入后仍沿用采集基线，刷新不重复计数", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const head = f.commit("change"); f.publish(head);
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric?.retained.first, 1);
  f.git("update-ref", "refs/remotes/origin/main", head);
  f.summary.delivery!.loop = { round: 1, state: "merged", kind: "ci", last_sha: first };
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  const corrected = buildDeliveryAnalysis([f.summary]).rows[0].metric!;
  assert.equal(corrected.retained.pipeline, 1); assert.equal(corrected.rework.pipeline, 2);
  assert.equal(corrected.base, f.base);
  const cacheDir = join(f.dir, ".delivery-analysis");
  const cachePath = join(cacheDir, readdirSync(cacheDir).find(name => name.endsWith(".json"))!);
  const legacy = JSON.parse(readFileSync(cachePath, "utf8"));
  delete legacy.attribution;
  legacy.metric.commits.find((c: { sha: string }) => c.sha === head).origin = "other";
  legacy.metric.retained = { first: 0, pipeline: 0, review: 0, other: 1 };
  writeFileSync(cachePath, JSON.stringify(legacy));
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric!.retained.pipeline, 1, "旧版缓存自动升级");
  observeDeliveryCode(f.summary, f.cwd, head, true); await awaitDeliveryAnalytics();
  const refreshed = buildDeliveryAnalysis([f.summary]).rows[0].metric!;
  assert.deepEqual(refreshed.rework, corrected.rework);
  assert.equal(refreshed.commits.length, 2);
});

test("无效修复锚不使统计失败，已识别的历史原因不被后来轮次覆盖", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const ci = f.commit("change"); f.publish(ci);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first };
  await collectDeliveryCode(f.summary, f.cwd, ci);
  f.write("feature.cpp", "int a = 3;\n"); const head = f.commit("change again"); f.publish(head);
  f.summary.delivery!.loop = { round: 2, state: "repairing", kind: "review", last_sha: first };
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.commits.find(c => c.sha === ci)?.origin, "pipeline");
  assert.equal(result.commits.find(c => c.sha === head)?.origin, "review");
  f.git("checkout", "main"); f.write("other.cpp", "int other = 1;\n"); const unrelated = f.commit("unrelated");
  f.git("checkout", "task");
  for (const anchor of [unrelated, "a".repeat(40), "not-a-sha"]) {
    f.summary.delivery!.loop!.last_sha = anchor;
    const isolated = await collectDeliveryCode({ ...f.summary, id: `task-${anchor}` }, f.cwd, head);
    assert.equal(isolated.retained.first, 1);
  }
});

test("真实 squash 合入目标 SHA 不等于源 SHA，仍计入汇总；旧源快照不冒充新推送", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const head = f.commit("second"); f.publish(head);
  await collectDeliveryCode(f.summary, f.cwd, head);
  f.git("checkout", "main"); f.git("merge", "--squash", "task"); const merged = f.commit("squashed delivery");
  f.summary.status = "completed";
  Object.assign(f.summary.delivery!, { mr_state: "merged", merged_sha: merged });
  assert.equal(aggregateDelivery(buildDeliveryAnalysis([f.summary]).rows).available, 1);
  rmSync(f.cwd, { recursive: true });
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric!.head, head);
  f.publish(merged);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined);
});


test("15 个提交：仅最后轮次在 loop 中，历史批次仍完整恢复前几轮分类", async t => {
  const f = fixture(t), commits: string[] = [];
  for (let i = 0; i < 15; i++) {
    f.write("feature.cpp", `int a = ${i};\n`); commits.push(f.commit(`commit ${i}`));
  }
  const head = commits[14]; f.publish(head);
  f.summary.delivery!.loop = { round: 3, state: "merged", kind: "review", last_sha: commits[13] };
  const before = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(before.commits.filter(c => c.origin === "first").length, 14);
  const batch = (id: string, base: string, end: string, source: string) => ({
    task_id: f.summary.id, batch_id: id, base_sha: base, result_head: end,
    result_digest: "recorded", items: [{ source }], status: "closed",
  });
  f.write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: f.base }, delivery_loop: { batches: [
    batch("review-1", commits[0], commits[3], "mr_discussion"),
    batch("ci-1", commits[3], commits[10], "pipeline"),
    batch("review-2", commits[10], commits[13], "workspace"),
  ] } }));
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  const result = buildDeliveryAnalysis([f.summary]).rows[0].metric!;
  assert.deepEqual(result.commits.map(c => c.origin), ["first", ...Array(3).fill("review"), ...Array(7).fill("pipeline"), ...Array(4).fill("review")]);
  assert.deepEqual(result.rework, { first: 0, pipeline: 14, review: 14, other: 0 });
  assert.match(result.commits[1].origin_evidence!.join(" "), /review-1/);
});

test("推送时先保存区间，Git 采集失败后仍能恢复多轮；重复登记不重复计数", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const ci = f.commit("ci"); f.publish(ci);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first };
  recordDeliveryPublication(f.summary, join(f.dir, "missing"), ci); await awaitDeliveryAnalytics();
  f.write("feature.cpp", "int a = 3;\n"); const review = f.commit("review"); f.publish(review);
  f.summary.delivery!.loop = { round: 2, state: "repairing", kind: "review", last_sha: ci };
  recordDeliveryPublication(f.summary, undefined, review);
  recordDeliveryPublication(f.summary, undefined, review);
  delete f.summary.delivery!.loop;
  const result = await collectDeliveryCode(f.summary, f.cwd, review);
  assert.deepEqual(result.commits.map(c => c.origin), ["first", "pipeline", "review"]);
  assert.deepEqual(result.rework, { first: 0, pipeline: 2, review: 2, other: 0 });
});

test("反馈区间交叠有明确CI依据归流水线；其他任务、仅验证通过、未处理批次不能冒充修复证据", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const head = f.commit("change"); f.publish(head);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "review", last_sha: first };
  const batch = { task_id: f.summary.id, batch_id: "ci", base_sha: first, result_head: head,
    result_digest: "recorded", items: [{ source: "pipeline" }], status: "closed" };
  const writeBatches = (batches: unknown[]) => f.write(".mae-flow.json", JSON.stringify({
    step_heads: { branch_create: f.base }, delivery_loop: { batches } }));
  writeBatches([batch, { ...batch, batch_id: "review", items: [{ source: "workspace" }] }]);
  const mixed = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(mixed.retained.pipeline, 1); assert.equal(mixed.commits[1].origin_evidence!.length, 2);
  writeBatches([{ ...batch, task_id: "another-task" },
    { ...batch, result_digest: undefined, result_head: undefined, verified_sha: head },
    { ...batch, result_digest: undefined, status: "queued" }]);
  const ignored = await collectDeliveryCode({ ...f.summary, workspace: join(f.dir, "fresh-task") }, f.cwd, head);
  assert.equal(ignored.retained.review, 1);
  writeBatches([{ ...batch, result_digest: undefined, result_head: undefined, superseded_by_push: head }]);
  const published = await collectDeliveryCode({ ...f.summary, workspace: join(f.dir, "published-task") }, f.cwd, head);
  assert.equal(published.retained.pipeline, 1, "被本次发布替代的流水线反馈保留修复区间");
});


test("缺少历史记录时按提交说明推断，最终代码来源与累计修改同步更新", async t => {
  const f = fixture(t);
  f.write("a.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("a.cpp", "int a = 2;\n"); f.commit("按检视意见删除IR接口token");
  f.write("b.cpp", "int b = 1;\n"); f.commit("修复CodeCheck行宽");
  f.write("c.cpp", "int c = 1;\n"); f.commit("补单测修复DT覆盖率");
  f.write("d.cpp", "int d = 1;\n"); f.commit("调整实现\n\nAddress review feedback and fix CodeCheck warnings");
  f.write("e.cpp", "int e = 1;\n"); const head = f.commit("新增功能"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.first, first);
  assert.deepEqual(result.commits.map(c => c.origin), ["first", "review", "pipeline", "pipeline", "pipeline", "review"]);
  assert.deepEqual(result.retained, { first: 0, review: 2, pipeline: 3, other: 0 });
  // 推断分类的词表断言归 Test17;此处留 origin_evidence 标注一条。
  assert.match(result.commits[1].origin_evidence!.join(" "), /推断/);
});


test("提交推断识别明确修复线索；普通修正默认归检视，两类线索有明确CI依据归流水线", () => {
  for (const text of ["按检视意见删除IR接口token", "address review feedback", "fix", "调整实现", "补单测"]) {
    assert.equal(inferCommitOrigin(text)?.origin, "review", text);
  }
  for (const text of ["按评审意见修复CodeCheck", "移除GTEST_SKIP", "修复CodeCheck行宽", "补单测修复DT覆盖率", "fix build failure"]) {
    assert.equal(inferCommitOrigin(text)?.origin, "pipeline", text);
  }
  for (const text of ["新增CodeCheck报告展示", "新增业务功能"]) {
    assert.equal(inferCommitOrigin(text)?.origin, "review", text);
  }
});


test("task-6：配置先提交、多次实现和文档整理均为首轮，仅末次CodeCheck为修复", async t => {
  const f = fixture(t);
  f.write("app_define.json", "{}\n"); const first = f.commit("配置订阅");
  f.write("service.java", "class A {}\nclass B {}\nclass C {}\n"); f.commit("实现接口与分页");
  f.write("docs.md", "knowledge\n"); f.commit("归档知识");
  f.write("urls.java", "class URLs {}\n"); f.commit("跨仓通知同步");
  f.write("docs.md", "more knowledge\n"); f.commit("归档跨仓知识");
  f.write("delivery.md", "checklist\n"); f.commit("交付清单整理");
  f.git("rm", "delivery.md"); const initialEnd = f.commit("撤出越界文件");
  f.write("service.java", "class A { /* fixed */ }\nclass B {}\nclass C {}\n");
  const head = f.commit("修复CodeCheck告警"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.first, first);
  assert.deepEqual(result.initial_implementation, { end: initialEnd, basis: "commit_message" });
  assert.deepEqual(result.commits.map(c => c.origin), [...Array(7).fill("first"), "pipeline"]);
  assert.deepEqual(result.retained, { first: 4, pipeline: 1, review: 0, other: 0 });
  assert.equal(aggregateDelivery(buildDeliveryAnalysis([f.summary]).rows).firstPercent, 80);
});

test("无修复迹象暂计首轮；正式反馈记录优先；单纯收到意见不切断首轮", async t => {
  const f = fixture(t);
  f.write("a.cpp", "int a = 1;\n"); const first = f.commit("新增接口");
  f.write("b.cpp", "int b = 1;\n"); const second = f.commit("补单测"); f.publish(second);
  let result = await collectDeliveryCode(f.summary, f.cwd, second);
  assert.equal(result.retained.first, 2); assert.equal(result.initial_implementation?.basis, "no_repair_found");
  const batch = { task_id: f.summary.id, batch_id: "review", base_sha: first,
    items: [{ source: "workspace" }], status: "queued" };
  const writeState = (record: unknown) => f.write(".mae-flow.json", JSON.stringify({
    step_heads: { branch_create: f.base }, delivery_loop: { batches: [record] } }));
  writeState(batch);
  result = await collectDeliveryCode(f.summary, f.cwd, second);
  assert.equal(result.retained.first, 2);
  writeState({ ...batch, status: "closed", result_digest: "recorded", result_head: second });
  result = await collectDeliveryCode(f.summary, f.cwd, second);
  assert.deepEqual(result.initial_implementation, { end: first, basis: "repair_record" });
  assert.deepEqual(result.retained, { first: 1, review: 1, pipeline: 0, other: 0 });
});


test("task-5：首次取样已有责任人直接推送，合入后仍计算真实分支交付", async t => {
  const f = fixture(t);
  f.write("service.cpp", "int a = 1;\nint b = 2;\n"); const published = f.commit("主体实现");
  f.publish(published);
  f.write("service.cpp", "int a = 3;\nint b = 2;\n"); const ownerHead = f.commit("修改静态清理");
  Object.assign(f.summary.delivery!, { foreign_commits: { base_sha: ownerHead, count: 46 }, merged_sha: ownerHead, mr_state: "merged" });
  f.summary.status = "completed";
  f.git("update-ref", "refs/remotes/origin/main", ownerHead);
  const metric = await collectDeliveryCode(f.summary, f.cwd, published);
  assert.equal(metric.head, ownerHead); assert.equal(metric.published_head, published);
  assert.deepEqual(metric.retained, { first: 1, review: 1, pipeline: 0, other: 0 });
  assert.equal(aggregateDelivery(buildDeliveryAnalysis([f.summary]).rows).firstPercent, 50);
});


test("模块分布只看根需求归属，忽略子任务知识模块；父任务不重复计数", async t => {
  const f = fixture(t); f.write("code.cpp", "int a = 1;\nint b = 2;\n");
  const head = f.commit("实现"); f.publish(head); await collectDeliveryCode(f.summary, f.cwd, head);
  f.summary.status = "completed"; f.summary.delivery!.mr_state = "merged";
  f.summary.parent_task_id = "parent";
  f.summary.business_module = { id: "wrong", name: "子任务遗留归属" };
  const parent = { ...f.summary, id: "parent", parent_task_id: undefined, business_module: { id: "alarm", name: "旧名称" } };
  const standalone = { ...f.summary, id: "solo", parent_task_id: undefined, business_module: undefined };
  await collectDeliveryCode(standalone, f.cwd, head);
  let report = buildDeliveryAnalysis([f.summary, parent, standalone], [{ id: "alarm", name: "告警模块" }]);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.rows[0].business_module, { id: "alarm", name: "告警模块" });
  let groups = aggregateDeliveryModules([...report.rows, report.rows[0]]);
  assert.equal(groups.length, 2); assert.ok(groups.every(group => group.lines === 2 && group.percent === 50));
  parent.business_module = { id: "report", name: "报表模块" };
  report = buildDeliveryAnalysis([f.summary, parent, standalone]);
  groups = aggregateDeliveryModules(report.rows);
  assert.ok(groups.some(group => group.id === "report" && group.percent === 50));
  report.rows[1].merged = false;
  assert.equal(aggregateDeliveryModules(report.rows)[0].percent, 100);
});


test("task-12：纯JSON配置修改正常统计，Markdown与二进制不进入行数", async t => {
  const f = fixture(t);
  f.write("febs.json", '{"menu": "old"}\n{"license": "old"}\n'); const first = f.commit("配置菜单和权限");
  f.write("febs.json", '{"menu": "new"}\n{"license": "new"}\n');
  f.write("notes.md", "do not count\n");
  writeFileSync(join(f.cwd, "icon.bin"), Buffer.from([0, 1, 2, 0, 3]));
  const head = f.commit("按检视意见修改配置"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.first, first);
  assert.deepEqual(result.retained, { first: 0, pipeline: 0, review: 2, other: 0 });
  assert.equal(result.commits[1].additions, 2); assert.equal(result.commits[1].deletions, 2);
  for (const path of ["deploy.yaml", "config.xml", "settings.ini", "Dockerfile", "package-lock.json"]) {
    f.write(path, "text delivery\n");
  }
  const next = f.commit("调整配置");
  const final = await collectDeliveryCode(f.summary, f.cwd, next);
  assert.equal(Object.values(final.retained).reduce((a, b) => a + b, 0), 7);
});

test("#457 完成日期过滤不回退到创建或更新时间，结束日按浏览器本地整天包含", async () => {
  const { completedInRange, validateCompletionRange } = await import("../src/completionRange.ts");
  const task = { id: "completion-date", workspace: join(tmpdir(), "completion-date-fixture"), title: "早创建晚完成", requirement: "test", status: "completed", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", completed_at: "2026-10-09T15:59:59.999Z", delivery: { mr_state: "merged" } } as TaskSummary;
  const range = { from: "2026-10-08T16:00:00.000Z", before: "2026-10-09T16:00:00.000Z" };
  const row = buildDeliveryAnalysis([task]).rows[0];
  assert.equal(row.completed_at, task.completed_at);
  assert.equal(completedInRange(row.completed_at, range), true);
  assert.equal(completedInRange("2026-10-08T15:59:59.999Z", range), false);
  assert.equal(completedInRange(range.before, range), false);
  assert.equal(buildDeliveryAnalysis([{ ...task, status: "running" }]).rows[0].completed_at, undefined);
  assert.equal(completedInRange(buildDeliveryAnalysis([{ ...task, completed_at: undefined }]).rows[0].completed_at, range), false);
  assert.throws(() => validateCompletionRange({ from: "invalid" }), /无效/);
  assert.throws(() => validateCompletionRange({ from: range.before, before: range.from }), /开始日期/);
});

const initialUrl = "https://code.test/org/repo/merge_requests/12", finalUrl = "https://code.test/org/repo/merge_requests/13";
function setFinalMr(f: ReturnType<typeof fixture>, initial: string, final: string, base: string) {
  Object.assign(f.summary.delivery!, { initial_mr: { url: initialUrl, head: initial, base: f.base },
    final_mr: { url: finalUrl, id: 13, repo: "org/repo", source_branch: "dev", target_branch: "main", state: "merged", head: final, base } });
  f.summary.status = "completed";
}
test("另一个 MR 改写提交并更新目标基线：真实比较两份补丁，不把目标更新或旧行数纳入最终归因", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "keep();\nold();\nrepeat();\nrepeat();\n");
  f.write(".env", "MY_VAR=sensitiveFixtureValue"); f.write("docs.md", "ignore-me");
  const first = f.commit("平台初版"); f.publish(first);
  await collectDeliveryCode(f.summary, f.cwd, first);
  f.git("checkout", "main");
  f.write("unrelated.cpp", "upstream();\n");
  const otherBase = f.commit("目标基线更新");
  f.git("checkout", "-b", "dev");
  f.write("feature.cpp", "keep();\nnewer();\nrepeat();\n");
  const head = f.commit("另开 MR");
  let analyzed = 0;
  const improvement = new DeliveryImprovements(() => ({ dataDir: f.dir, model: { json: {} } }), async input => {
    analyzed++;
    if (!input.task.delivery?.final_mr) return "原 MR 分析";
    assert.equal(input.row?.metric?.content_comparison?.reference, "initial_mr");
    assert.match(input.instructions, /mr-comparison.json/);
    const files = JSON.parse(readFileSync(join(input.root, "mr-comparison.json"), "utf8")).files;
    assert.match(files[0].change_patch, /newer/);
    return "最终 MR 分析";
  });
  t.after(() => improvement.shutdown());
  improvement.start({ summary: f.summary, cwd: f.cwd });
  await improvement.flush();
  assert.equal(analyzed, 1);
  setFinalMr(f, first, head, otherBase);
  assert.equal(improvement.view(f.summary).state, undefined, "同一交付的原 MR 报告不能作为最终版报告");
  assert.throws(() => improvement.start({ summary: f.summary, cwd: f.cwd }), /尚未采集/);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined, "新对象未采集也不能退回原报告");
  observeDeliveryCode(f.summary, f.cwd, head);
  await awaitDeliveryAnalytics();
  const row = buildDeliveryAnalysis([f.summary]).rows[0], c = row.mr_comparison!;
  assert.equal(row.mr_url, finalUrl); assert.equal(row.merged, true); assert.deepEqual(row.metric?.retained, { first: 2, pipeline: 0, review: 1, other: 0 });
  assert.equal(c.method, "patch", c.reason);
  assert.equal(row.final_code_lines, 3); assert.equal(row.final_deleted_lines, 2);
  assert.deepEqual(c.files, [{ path: "feature.cpp", changed: true, retained: 2, removed: 2, added: 1 }]);
  const detail = readFinalMrComparison(f.summary)!;
  improvement.start({ summary: f.summary, cwd: f.cwd }); await improvement.flush();
  assert.equal(improvement.view(f.summary).state?.status, "completed"); assert.equal(analyzed, 2);
  assert.equal(detail.comparison_basis, "patch");
  assert.match(detail.files[0].change_patch, /-\+old\(\);/); assert.match(detail.files[0].change_patch, /\+\+newer\(\);/);
  assert.doesNotMatch(JSON.stringify(detail), /sensitiveFixtureValue|ignore-me|upstream/);
  assert.equal(readFinalMrComparison(f.summary, "bogus"), undefined);
  rmSync(f.cwd, { recursive: true }); assert.deepEqual(readFinalMrComparison(f.summary), detail);
  f.summary.delivery!.final_mr!.base = head;
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].mr_comparison!.method, "unavailable");
  assert.equal(readFinalMrComparison(f.summary), undefined);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].final_code_lines, undefined, "旧基线的行数不能挪用");
});
test("最终 MR 续用初版：保留真实提交归因，显示换序差异，绝不将后续本地提交记作原来的 CI 修复", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "old();\nkeep();\n"); const first = f.commit("平台初版"); f.publish(first);
  await collectDeliveryCode(f.summary, f.cwd, first);
  f.summary.delivery!.loop = { kind: "ci", round: 1, state: "repairing", last_sha: first };
  f.write("feature.cpp", "keep();\nold();\n"); const final = f.commit("稍作调整");
  setFinalMr(f, first, final, f.base);
  observeDeliveryCode(f.summary, f.cwd, final); await awaitDeliveryAnalytics();
  const row = buildDeliveryAnalysis([f.summary]).rows[0], comparison = row.mr_comparison!;
  assert.equal(comparison.method, "ancestry", comparison.reason);
  assert.equal(row.metric?.head, final, row.unavailable);
  assert.equal(row.metric?.commits.at(-1)?.origin, "review");
  assert.equal(comparison.files?.[0].changed, true); assert.equal(comparison.added, 0);
  const details = readFinalMrComparison(f.summary)!;
  assert.equal(details.comparison_basis, "head"); assert.match(details.files[0].change_patch, /^-old\(\);$/m);
  f.summary.delivery!.initial_mr!.head = undefined;
  observeDeliveryCode(f.summary, f.cwd, final); await awaitDeliveryAnalytics();
  const missing = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(missing.merged, true); assert.equal(missing.mr_comparison?.method, "unavailable"); assert.equal(missing.metric, undefined); assert.equal(missing.final_code_lines, 2);
});

test("最终 MR 三类行以最终代码为分母，合主干、删除行和 CI 后追加的普通修改不会串类", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "initial-A\nfor-ci\nfor-owner\ntemporary\n");
  const initial = f.commit("需求实现"); f.publish(initial); await collectDeliveryCode(f.summary, f.cwd, initial);
  f.git("checkout", "main"); f.write("upstream.cpp", "unrelated\n"); const upstream = f.commit("其他需求");
  f.git("checkout", "task"); f.git("merge", "--no-ff", "main", "-m", "同步基线");
  f.write("feature.cpp", "initial-A\npipeline-B\nfor-owner\ntemporary\n");
  const ci = f.commit("处理 B");
  f.summary.delivery!.loop = { kind: "ci", round: 1, state: "repairing", last_sha: initial };
  f.publish(ci); recordDeliveryPublication(f.summary, f.cwd, ci); await awaitDeliveryAnalytics();
  f.write("feature.cpp", "initial-A\npipeline-B\nlocal-C\n"); f.write("existing.cpp", "");
  const final = f.commit("本地继续改完需求"); setFinalMr(f, initial, final, upstream);
  observeDeliveryCode(f.summary, f.cwd, final); await awaitDeliveryAnalytics();
  const row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.deepEqual(row.metric?.retained, { first: 1, pipeline: 1, review: 1, other: 0 }, row.unavailable);
  assert.equal(row.final_code_lines, Object.values(row.metric!.retained).reduce((a, b) => a + b, 0));
  assert.equal(row.final_code_lines, 3); assert.equal(row.final_deleted_lines, 1);
  assert.match(row.metric!.commits.find(c => c.sha === ci)!.origin_evidence!.join(" "), /流水线修复轮次/);
  assert.match(row.metric!.commits.find(c => c.sha === final)!.origin_evidence!.join(" "), /初版 MR 发布后的修改/);
  const dir = join(f.dir, ".delivery-analysis");
  const file = join(dir, readdirSync(dir).find(name => name.endsWith(".json") && !name.endsWith(".patch.json"))!);
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  const localCommit = legacy.metric.commits.find((c: {sha:string}) => c.sha === final);
  localCommit.origin_evidence = ["初版 MR 发布后的修改。缺少明确的流水线修复证据，归入检视及其他修改。"];
  writeFileSync(file, JSON.stringify(legacy));
  const displayed = buildDeliveryAnalysis([f.summary]).rows[0].metric?.commits.find(c => c.sha === final);
  assert.deepEqual(displayed?.origin_evidence, ["初版 MR 发布后的修改。缺少明确的流水线修复证据，归入检视修改。"]);
  delete legacy.final_size;
  legacy.metric.retained = { first: 1, pipeline: 2, review: 0, other: 0 };
  localCommit.origin = "pipeline";
  writeFileSync(file, JSON.stringify(legacy));
  const beforeUpgrade = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(beforeUpgrade.final_code_lines, 3); assert.equal(beforeUpgrade.metric, undefined);
  observeDeliveryCode(f.summary, f.cwd, final, true); await awaitDeliveryAnalytics();
  assert.deepEqual(buildDeliveryAnalysis([f.summary]).rows[0].metric?.retained, row.metric!.retained, "不能从旧最终快照继承错误的推断，但保留真实流水线轮次");
  const previous = structuredClone(f.summary.delivery);
  f.summary.delivery_history = [{ id: "initial", archive: "1", started_at: "", completed_at: "", delivery: previous! }];
  f.summary.delivery_generation = "next"; f.summary.delivery = {};
  assert.deepEqual(buildDeliveryAnalysis([f.summary]).rows.map(r => r.final_code_lines), [3, undefined]);
});

test("初版只在合并提交的第二父链，不把合入的代码猜成首轮或检视修改", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "initial\n"); const initial = f.commit("初版"); f.publish(initial);
  f.git("checkout", "-b", "owner-side", f.base); f.write("local.cpp", "independent\n"); f.commit("本地修改");
  f.git("merge", "--no-ff", "task", "-m", "并入初版"); const final = f.git("rev-parse", "HEAD");
  setFinalMr(f, initial, final, f.base);
  observeDeliveryCode(f.summary, f.cwd, final); await awaitDeliveryAnalytics();
  const row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.final_code_lines, 2); assert.equal(row.metric, undefined);
  assert.equal(row.mr_comparison?.method, "ancestry"); assert.match(row.unavailable ?? "", /主提交链/);
});

test("缺初版的最终 MR 可以只有重命名或删除，真实零行与无法读取有区别；旧快照只补采一次", async t => {
  const f = fixture(t);
  f.git("mv", "existing.cpp", "renamed.cpp");
  const head = f.commit("rename only"); f.publish(head);
  setFinalMr(f, f.base, head, f.base); delete f.summary.delivery!.initial_mr!.head;
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  const row = () => buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row().final_code_lines, 0); assert.equal(row().final_deleted_lines, 0); assert.equal(row().metric, undefined);
  const dir = join(f.dir, ".delivery-analysis");
  const path = join(dir, readdirSync(dir).find(p => p.endsWith(".json") && !p.endsWith(".patch.json"))!);
  const old = JSON.parse(readFileSync(path,"utf8")); delete old.final_size; writeFileSync(path, JSON.stringify(old));
  assert.equal(hasFinalMrSample(f.summary), false); assert.equal(row().final_code_lines, undefined);
  observeDeliveryCode(f.summary, f.cwd, head, true); await awaitDeliveryAnalytics();
  assert.equal(row().final_code_lines, 0); assert.equal(hasFinalMrSample(f.summary), true);
  f.git("rm", "renamed.cpp"); const deleted = f.commit("delete file"); f.summary.delivery!.final_mr!.head = deleted;
  assert.equal(row().final_code_lines, undefined);
  observeDeliveryCode(f.summary, f.cwd, deleted); await awaitDeliveryAnalytics();
  assert.equal(row().final_code_lines, 0); assert.equal(row().final_deleted_lines, 1);
  f.summary.delivery!.final_mr!.head = "f".repeat(40);
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(row().final_code_lines, undefined); assert.equal(hasFinalMrSample(f.summary), true);
});

test("原 MR 外部改写后合入或 Git 对象缺失，不得继续展示平台旧版本行数和百分比", async t => {
  const f = fixture(t);
  f.write("version.cpp", "cloud version\n"); const pushed = f.commit("初版"); f.publish(pushed);
  await collectDeliveryCode(f.summary, f.cwd, pushed);
  f.git("checkout", "-b", "rewrite", f.base); f.write("unrelated.cpp", "external\n"); const rewritten = f.commit("rewrite");
  f.summary.status = "completed";
  for (const head of [rewritten, "f".repeat(40)]) {
    Object.assign(f.summary.delivery!, { foreign_commits: { count: 1, base_sha: head }, merged_sha: head, mr_state: "merged" });
    let row = buildDeliveryAnalysis([f.summary]).rows[0];
    assert.equal(row.merged, true); assert.equal(row.metric, undefined); assert.equal(row.final_code_lines, undefined);
    observeDeliveryCode(f.summary, f.cwd, head, true); await awaitDeliveryAnalytics();
    row = buildDeliveryAnalysis([f.summary]).rows[0];
    assert.equal(row.metric, undefined); assert.equal(row.final_code_lines, undefined);
    assert.match(row.unavailable ?? "", /外部提交/);
  }
});

test("只有最终 MR 时按实际补丁展示代码，提交历史提供修复分界后才计算占比", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "initial();\ncheck();\nflow();\n");
  const first = f.commit("实现订单查询");
  setFinalMr(f, first, first, f.base); delete f.summary.delivery!.initial_mr;
  observeDeliveryCode(f.summary, f.cwd, first); await awaitDeliveryAnalytics();
  let row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.mr_comparison?.method, "final"); assert.equal(row.initial_mr_url, undefined);
  assert.equal(row.final_code_lines, 3); assert.equal(row.metric, undefined);
  const detail = readFinalMrComparison(f.summary)!;
  assert.equal(detail.comparison_basis, "final"); assert.equal(detail.files[0].initial_patch, "");
  assert.match(detail.files[0].change_patch, /\+initial\(\);/);
  f.write("feature.cpp", "initial();\nchecked();\nflow();\n"); f.commit("fix CI failure in CodeCheck");
  f.write("feature.cpp", "initial();\nchecked();\nowner();\n"); const final = f.commit("调整订单路径");
  f.summary.delivery!.final_mr!.head = final;
  observeDeliveryCode(f.summary, f.cwd, final); await awaitDeliveryAnalytics();
  row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.mr_comparison?.method, "final"); assert.equal(row.final_code_lines, 3);
  assert.deepEqual(row.metric?.retained, {first:1,pipeline:1,review:1,other:0}, row.unavailable);
  assert.equal(row.metric?.initial_implementation?.basis, "commit_message");
  assert.match(row.metric!.commits[1].origin_evidence!.join(" "), /推断/);
});

test("平台推了分支但尚未建 MR：精确对照推送版本，区分后续本地补丁与目标仓的更新", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "first();\nold();\n"); const pushed = f.commit("平台实现"); f.publish(pushed);
  f.git("checkout", "main"); f.write("other.cpp","upstream();\n"); const base = f.commit("其他需求");
  f.git("checkout", "task"); f.git("merge", "--no-ff", "main", "-m", "同步目标分支");
  f.write("feature.cpp", "first();\nlocal();\n"); const final = f.commit("开发者本地改动");
  setFinalMr(f, pushed, final, base); delete f.summary.delivery!.initial_mr;
  observeDeliveryCode(f.summary, f.cwd, final); await awaitDeliveryAnalytics();
  let row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.initial_mr_url, undefined); assert.equal(row.mr_url, finalUrl);
  assert.equal(row.mr_comparison?.initial_head, pushed); assert.equal(row.mr_comparison?.reference, "platform_push");
  assert.deepEqual(row.mr_comparison?.files?.map(f => f.path), ["feature.cpp"]);
  let detail = readFinalMrComparison(f.summary)!;
  assert.equal(detail.reference, "platform_push"); assert.equal(detail.comparison_basis, "patch");
  assert.match(detail.files[0].change_patch, /old\(\)/); assert.match(detail.files[0].change_patch, /local\(\)/);
  assert.deepEqual(row.metric?.retained, { first:1,pipeline:0,review:1,other:0 }, row.unavailable);
  assert.equal(row.metric?.initial_implementation?.basis, "platform_push");
  assert.doesNotMatch(JSON.stringify(row.metric), /初版 MR/);
  // 外部分支独立改写，合入版本可查，但不再冒充从平台提交延续。
  f.git("checkout", "-b", "standalone", base); f.write("feature.cpp", "rewritten();\n"); const rewritten = f.commit("重写需求");
  f.summary.delivery!.final_mr!.head = rewritten;
  observeDeliveryCode(f.summary, f.cwd, rewritten); await awaitDeliveryAnalytics();
  row = buildDeliveryAnalysis([f.summary]).rows[0]; detail = readFinalMrComparison(f.summary)!;
  assert.equal(row.mr_comparison?.method, "final"); assert.equal(row.mr_comparison?.reference, undefined);
  assert.equal(row.metric, undefined); assert.equal(row.final_code_lines, 1); assert.equal(detail.comparison_basis, "final");
  f.write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: rewritten } }));
  observeDeliveryCode(f.summary, f.cwd, rewritten, true); await awaitDeliveryAnalytics();
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].mr_comparison?.method, "final", "记录的起点不属于平台推送历史");
  f.write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: f.base } }));
  observeDeliveryCode(f.summary, f.cwd, rewritten, true); await awaitDeliveryAnalytics();
  row = buildDeliveryAnalysis([f.summary]).rows[0]; detail = readFinalMrComparison(f.summary)!;
  assert.equal(row.mr_comparison?.method, "patch"); assert.equal(row.mr_comparison?.reference, "platform_push");
  assert.equal(detail.reference, "platform_push"); assert.equal(row.final_code_lines, 1); assert.deepEqual(row.metric?.retained, { first: 0, pipeline: 0, review: 1, other: 0 });
  assert.match(detail.files[0].change_patch, /rewritten\(\)/); assert.match(detail.files[0].change_patch, /first\(\)/);
  f.write("feature.cpp", "rewritten();\npipeline();\n"); f.commit("修复 CodeCheck");
  f.write("feature.cpp", "rewritten();\npipeline();\nlocal();\n"); const reviewed = f.commit("本地调整");
  f.summary.delivery!.final_mr!.head = reviewed;
  observeDeliveryCode(f.summary, f.cwd, reviewed); await awaitDeliveryAnalytics();
  row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.mr_comparison?.method, "patch");
  assert.equal(row.metric?.initial_implementation?.basis, "content_comparison");
  assert.deepEqual(row.metric?.retained, { first: 0, pipeline: 1, review: 2, other: 0 }, row.unavailable);
  const prior = readFinalMrComparison(f.summary)!;
  rmSync(join(f.cwd, ".mae-flow.json"));
  observeDeliveryCode(f.summary, f.cwd, reviewed, true); await awaitDeliveryAnalytics();
  assert.deepEqual(readFinalMrComparison(f.summary), prior, "历史基线丢失不能覆盖已采到的两版差异");
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].mr_comparison?.method, "patch");
  const dir = join(f.dir, ".delivery-analysis");
  const reportFile = join(dir, readdirSync(dir).find(name => name.endsWith(".json") && !name.endsWith(".patch.json"))!);
  const savedKey = JSON.parse(readFileSync(reportFile, "utf8")).comparison_key;
  rmSync(`${reportFile}.${savedKey}.patch.json`);
  observeDeliveryCode(f.summary, f.cwd, reviewed, true); await awaitDeliveryAnalytics();
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].mr_comparison?.method, "final");
  assert.equal(readFinalMrComparison(f.summary)?.comparison_basis, "final", "旧详情已丢失时仍保存可读的最终版");
});

test("最终 MR 直接合入平台已推送版本，按真实推送划分首轮并保留推送前的修复证据", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "first();\nsecond();\n"); const first = f.commit("需求实现"); f.publish(first);
  setFinalMr(f, first, first, f.base); delete f.summary.delivery!.initial_mr;
  observeDeliveryCode(f.summary, f.cwd, first); await awaitDeliveryAnalytics();
  let row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.mr_comparison?.reference, "platform_push");
  assert.ok(row.mr_comparison?.files?.every(file => !file.changed));
  assert.deepEqual(row.metric?.retained, { first: 2, pipeline: 0, review: 0, other: 0 }, row.unavailable);
  assert.equal(row.metric?.initial_implementation?.basis, "platform_push");
  f.write("feature.cpp", "first();\nchecked();\n"); const ci = f.commit("调整实现"); f.publish(ci);
  f.write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: f.base }, delivery_loop: { batches: [{
    batch_id: "ci-before-push", task_id: f.summary.id, items: [{source:"pipeline"}], base_sha: first,
    result_digest: "confirmed", result_head: ci }] } }));
  f.summary.delivery!.final_mr!.head = ci;
  observeDeliveryCode(f.summary, f.cwd, ci); await awaitDeliveryAnalytics();
  row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.deepEqual(row.metric?.retained, { first: 1, pipeline: 1, review: 0, other: 0 }, row.unavailable);
  assert.equal(row.metric?.initial_implementation?.basis, "repair_record");
});

test("关联本地快照含未提交及未跟踪源码；工作区回收后仍能按内容计算三类及删除", async t => {
  const { captureLocalCodeSnapshot, awaitLocalCodeSnapshot, readLocalCodeSnapshot } = await import("../src/finalMrLocalSnapshot.ts");
  const f = fixture(t);
  f.write("feature.cpp", "keep();\nold();\nrepeat();\nrepeat();\n");
  const first = f.commit("平台实现"); f.publish(first);
  f.write("feature.cpp", "staged();\n"); f.git("add", "feature.cpp");
  f.write("feature.cpp", "keep();\nlocal();\nrepeat();\nrepeat();\n");
  f.write("untracked.ts", "export const local = 1;\n");
  f.write("ignore.md", "ignored");
  f.write("binary.bin", "\0binary");
  const before = f.git("status", "--porcelain=v1");
  const refs = f.git("show-ref"), index = f.git("diff", "--cached");
  const errors: string[] = [];
  captureLocalCodeSnapshot(f.summary, f.cwd, finalUrl, s => errors.push(s));
  await awaitLocalCodeSnapshot(f.summary, finalUrl);
  assert.deepEqual(errors, []);
  const snapshot = readLocalCodeSnapshot(f.summary, finalUrl)!;
  assert.ok(snapshot.includes_untracked); assert.equal(snapshot.head, first); assert.equal(snapshot.base, f.base);
  assert.deepEqual(Object.keys(snapshot.patches).sort(), ["feature.cpp", "untracked.ts"]);
  assert.equal(f.git("status", "--porcelain=v1"), before);
  assert.equal(f.git("show-ref"), refs); assert.equal(f.git("diff", "--cached"), index);
  const { statSync } = await import("node:fs");
  const stored = readdirSync(join(f.dir, ".delivery-analysis")).find(p => p.endsWith(".local.json"))!;
  assert.equal(statSync(join(f.dir, ".delivery-analysis", stored)).mode & 0o777, 0o600);
  f.git("reset", "--hard", f.base); // 仅测试仓；模拟在独立历史实现最终版。
  f.write("feature.cpp", "keep();\nnew();\nrepeat();\n");
  f.write("untracked.ts", "export const local = 1;\n");
  const localHead = f.commit("本地完成");
  f.summary.delivery!.loop = { kind: "ci", round: 1, state: "repairing", last_sha: localHead };
  f.write("feature.cpp", "keep();\nnew();\nrepeat();\nci();\n");
  const head = f.commit("处理反馈");
  const finalRepo = join(f.dir, "final-objects");
  execFileSync("git", ["clone", "--quiet", f.cwd, finalRepo]);
  setFinalMr(f, first, head, f.base);
  rmSync(f.cwd, { recursive: true }); f.summary.workspace_reclaimed_at = new Date().toISOString();
  observeDeliveryCode(f.summary, finalRepo, head, true); await awaitDeliveryAnalytics();
  const row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.final_code_lines, 5);
  assert.deepEqual(row.metric?.retained, { first: 3, pipeline: 1, review: 1, other: 0 });
  assert.equal(row.metric?.deleted, 2);
  assert.equal(row.metric?.content_comparison?.reference, "local_snapshot");
  assert.equal(readFinalMrComparison(f.summary)?.reference, "local_snapshot");
  assert.equal(aggregateDelivery([row]).firstPercent, 60);
});

test("快照失败不抛异常，缺少快照与 Git 对象时不编造数字", async t => {
  const { captureLocalCodeSnapshot, awaitLocalCodeSnapshot, readLocalCodeSnapshot } = await import("../src/finalMrLocalSnapshot.ts");
  const f = fixture(t), errors: string[] = [];
  captureLocalCodeSnapshot(f.summary, f.workspace, finalUrl, s => errors.push(s));
  await awaitLocalCodeSnapshot(f.summary, finalUrl);
  assert.equal(errors.length, 1); assert.equal(readLocalCodeSnapshot(f.summary, finalUrl), undefined);
  setFinalMr(f, "a".repeat(40), "b".repeat(40), "c".repeat(40));
  observeDeliveryCode(f.summary, f.cwd, "b".repeat(40), true); await awaitDeliveryAnalytics();
  const row = buildDeliveryAnalysis([f.summary]).rows[0];
  assert.equal(row.metric, undefined); assert.equal(row.final_code_lines, undefined); assert.ok(row.unavailable);
});
