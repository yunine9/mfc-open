import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DeliveryImprovements, readImprovementPolicy, updateImprovementPolicy, initializeImprovementPolicy, runImprovementAgent } from "../src/deliveryImprovement.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { collectDeliveryCode, awaitTaskDeliveryAnalytics } from "../src/deliveryAnalytics.ts";
import type { TaskSummary } from "../src/taskService.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "delivery-improvement-")), workspace = join(root, "task"); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const summary = { id: "task-1", title: "test", workspace, requirement: "test", created_at: "2026-01-02T00:00:00.000Z", completed_at: "2026-01-03T00:00:00.000Z", status: "completed", delivery: { git_push: { sha: "a".repeat(40), remote: "origin", ref: "refs/heads/task" }, mr_state: "merged" } } as TaskSummary;
  const options = () => ({ dataDir: root, model: { choice: { provider: "fixture", model: "fixture" }, json: {} } });
  return { root, workspace, summary, task: { summary }, options };
}
function stateRoot(task: TaskSummary) { return join(task.workspace, "delivery-improvement", createHash("sha256").update(task.delivery_generation ?? "initial").digest("hex").slice(0, 20)); }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));

test("默认全部策略也分析缺统计的新交付，报告保留证据限制", async t => {
  const f = fixture(t); let calls = 0;
  updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 100 }, "2026-01-01T00:00:00.000Z");
  const service = new DeliveryImprovements(f.options, async input => { calls++; assert.equal(input.row?.metric, undefined); return "统计和代码不可用，不能解释逐提交变化。"; });
  service.consider(f.task); await tick(); await service.flush();
  assert.equal(calls, 1); assert.equal(service.view(f.summary).state?.status, "completed"); await service.shutdown();
});

test("停止排队分析不等待其他任务，取消后不启动模型", async t => {
  const f = fixture(t); let release!: () => void, calls = 0;
  const latch = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const service = new DeliveryImprovements(f.options, async () => { calls++; await latch; return "报告"; });
  const second = { summary: { ...f.summary, id: "task-2", workspace: join(f.root, "task-2") } }; mkdirSync(second.summary.workspace);
  service.start(f.task); await tick(); service.start(second);
  await service.stopTask(second.summary.id);
  assert.equal(service.isRunning(second.summary.id), false); assert.equal(service.view(second.summary).state?.status, "failed");
  release(); await service.flush(); assert.equal(calls, 1); await service.shutdown();
});

test("自动策略：默认启用100%、保存启用时间、阈值类型与范围校验", t => {
  const f = fixture(t), original = readImprovementPolicy(f.root);
  assert.equal(original.enabled, true); assert.equal(original.threshold_percent, 100);
  initializeImprovementPolicy(f.root); const initialized = readImprovementPolicy(f.root); assert.ok(initialized.enabled_after);
  initializeImprovementPolicy(f.root); assert.deepEqual(readImprovementPolicy(f.root), initialized);
  const a = updateImprovementPolicy(f.root, { enabled: false, threshold_percent: 50 }, "2026-01-01T00:00:00.000Z"); assert.equal(a.enabled, false);
  const b = updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 0 }, "2026-01-02T00:00:00.000Z");
  assert.equal(b.enabled_after, "2026-01-02T00:00:00.000Z");
  assert.equal(updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 100 }, "2026-01-04T00:00:00.000Z").enabled_after, b.enabled_after);
  for (const value of [-1, 101, NaN, Infinity, "50", null]) assert.throws(() => updateImprovementPolicy(f.root, { enabled: true, threshold_percent: value }));
  for (const enabled of [1, "true", null, undefined]) assert.throws(() => updateImprovementPolicy(f.root, { enabled, threshold_percent: 50 }));
  writeFileSync(join(f.root, "delivery-improvement-policy.json"), JSON.stringify({ enabled: true, threshold_percent: "50" }));
  assert.equal(typeof readImprovementPolicy(f.root).threshold_percent, "number");
});

test("报告协调：并发去重、仅报告不改任务、失败保留旧报告和版本过期提示", async t => {
  const f = fixture(t); let calls = 0, release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const before = structuredClone(f.summary);
  const service = new DeliveryImprovements(f.options, async () => { calls++; await latch; return "已证实原因与建议"; });
  service.start(f.task); service.start(f.task); await tick(); assert.equal(calls, 1); release(); await service.flush();
  assert.equal(service.view(f.summary).state?.status, "completed");
  assert.match(service.view(f.summary, true).markdown!, /已证实原因与建议/); assert.deepEqual(f.summary, before);
  const failing = new DeliveryImprovements(f.options, async () => { throw new Error("password=private-example"); });
  const old = service.view(f.summary, true).markdown;
  failing.start(f.task); await failing.flush();
  assert.equal(failing.view(f.summary).state?.status, "failed"); assert.equal(failing.view(f.summary, true).markdown, old);
  assert.doesNotMatch(failing.view(f.summary).state?.message ?? "", /private-example/);
  f.summary.delivery!.git_push!.sha = "b".repeat(40);
  assert.equal(failing.view(f.summary).state?.stale, true);
  await service.shutdown(); await failing.shutdown();
});

test("不同交付generation各自存报告；关联范围及限制进入manifest", async t => {
  const f = fixture(t), related = join(f.root, "related"); mkdirSync(related);
  const seen: string[] = [];
  const service = new DeliveryImprovements(() => ({ ...f.options(), related: [{ summary: { ...f.summary, id: "parent", workspace: related } }] }), async input => {
    seen.push(input.task.delivery_generation ?? "initial");
    assert.equal(input.scopes.parent.root, related); assert.equal(input.scopes.platform.sourceOnly, true);
    return `报告 ${input.task.delivery_generation ?? "initial"}`;
  });
  service.start(f.task); await service.flush(); const initial = structuredClone(f.summary);
  f.summary.delivery_generation = "round-2"; service.start(f.task); await service.flush();
  assert.deepEqual(seen, ["initial", "round-2"]);
  assert.match(service.view(initial, true).markdown!, /报告 initial/);
  assert.match(service.view(f.summary, true).markdown!, /报告 round-2/);
  assert.notEqual(stateRoot(initial), stateRoot(f.summary)); await service.shutdown();
});

test("服务重启：遗留queued/running不可假装仍运行，可手动重新分析", async t => {
  const f = fixture(t), root = stateRoot(f.summary); mkdirSync(root, { recursive: true });
  for (const status of ["queued", "running"]) {
    writeFileSync(join(root, "state.json"), JSON.stringify({ status, head: f.summary.delivery!.git_push!.sha, started_at: "2026-01-01T00:00:00.000Z", available: false }));
    const service = new DeliveryImprovements(f.options, async () => "重试成功");
    assert.equal(service.isRunning(f.summary.id), false);
    assert.equal(service.view(f.summary).state?.status, "failed");
    service.start(f.task); await service.flush(); assert.equal(service.view(f.summary).state?.status, "completed"); await service.shutdown();
  }
});

async function gitTask(t: { after(fn: () => void): void }, repair = true) {
  const f = fixture(t), cwd = join(f.root, "repo"); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  const commit = (message: string) => { git("add", "--all"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  writeFileSync(join(cwd, "existing.cpp"), "int baseline = 0;\n"); const base = commit("baseline"); git("update-ref", "refs/remotes/origin/main", base); git("checkout", "-b", "task");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: base } }));
  writeFileSync(join(cwd, "feature.cpp"), "int first = 1;\nint second = 2;\n"); const first = commit("first");
  f.summary.delivery!.target_branch = "main"; f.summary.delivery!.git_push!.sha = first; await collectDeliveryCode(f.summary, cwd, first);
  if (!repair) { f.summary.delivery!.merged_sha = first; return { ...f, task: { summary: f.summary, cwd } }; }
  f.summary.delivery!.loop = { kind: "review", round: 1, state: "repairing", last_sha: first };
  writeFileSync(join(cwd, "feature.cpp"), "int first = 10;\nint second = 2;\n"); const head = commit("repair");
  f.summary.delivery!.git_push!.sha = head; f.summary.delivery!.merged_sha = head; await collectDeliveryCode(f.summary, cwd, head);
  return { ...f, task: { summary: f.summary, cwd } };
}

test("自动分析：仅启用后的新交付，严格低于阈值且合入后触发一次，历史交付不回填", async t => {
  const f = await gitTask(t); let calls = 0;
  updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 50 }, "2026-01-01T00:00:00.000Z");
  const service = new DeliveryImprovements(f.options, async () => { calls++; return "自动报告"; });
  service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 0, "50%等于阈值不触发");
  updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 51 });
  f.summary.completed_at = "2025-12-01T00:00:00.000Z";
  service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 0, "启用前完成的历史交付不能回填");
  f.summary.created_at = "2025-11-01T00:00:00.000Z"; f.summary.completed_at = "2026-01-03T00:00:00.000Z";
  service.consider(f.task); service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 1);
  service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 1); await service.shutdown();
});

test("分析Agent：三个专家并行后综合，所有会话只有只读分析工具", async t => {
  const f = fixture(t), configs: any[] = []; let expertDone = 0;
  t.mock.method(CloudSession, "create", async (config: any) => {
    configs.push(config); const index = configs.length;
    assert.deepEqual([...config.allowedTools].sort(), ["analysis_code", "analysis_evidence"]);
    assert.equal(config.allowHumanQuestions, false); assert.equal(config.allowSubagents, false); assert.equal(config.excludeAgentFiles, true);
    return { start: async () => { if (index <= 3) { await tick(); expertDone++; } else assert.equal(expertDone, 3); return { status: "turn_finished" }; }, finalReply: () => index <= 3 ? `专家${index}证据` : "综合结论 password=secret-value", dispose() {}, abort: async () => {} };
  });
  const output = await runImprovementAgent({ root: f.root, task: f.summary, scopes: { task: { root: f.workspace, description: "任务" } }, instructions: "只根据证据", template: "报告模板" }, new AbortController().signal, f.options());
  assert.equal(configs.length, 4); assert.equal(expertDone, 3); assert.match(output, /综合结论/); assert.doesNotMatch(output, /secret-value/);
});


test("100%策略覆盖首次实现完整保留的交付；未合入和关闭开关均不触发", async t => {
  const f = await gitTask(t, false); let calls = 0;
  updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 100 }, "2026-01-01T00:00:00.000Z");
  const service = new DeliveryImprovements(f.options, async () => { calls++; return "全部交付分析"; });
  f.summary.delivery!.mr_state = "等待合入";
  service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 0);
  f.summary.delivery!.mr_state = "merged";
  updateImprovementPolicy(f.root, { enabled: false, threshold_percent: 100 });
  service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 0);
  updateImprovementPolicy(f.root, { enabled: true, threshold_percent: 100 }, "2026-01-01T00:00:00.000Z");
  service.consider(f.task); await awaitTaskDeliveryAnalytics(f.summary); await tick(); await service.flush(); assert.equal(calls, 1); await service.shutdown();
});

test("专家失败保留缺口并继续综合，最终会话异常不返回伪报告", async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(CloudSession, "create", async () => {
    const index = ++calls;
    return { start: async () => { if (index === 1) throw new Error("one specialist failed"); return { status: "turn_finished" }; }, finalReply: () => "有证据的报告", dispose() {}, abort: async () => {} };
  });
  const input = { root: f.root, task: f.summary, scopes: { analysis: { root: f.root, description: "分析" } }, instructions: "核实", template: "报告" };
  assert.match(await runImprovementAgent(input, new AbortController().signal, f.options()), /报告/);
  assert.equal(calls, 4);
  const { readFileSync } = await import("node:fs");
  const dimensions = JSON.parse(readFileSync(join(f.root, "dimensions.json"), "utf8"));
  assert.equal(dimensions.filter((d: any) => d.status === "failed").length, 1);
  t.mock.method(CloudSession, "create", async () => ({ start: async () => ({ status: "failed" }), finalReply: () => "不能发布的报告", dispose() {}, abort: async () => {} }));
  await assert.rejects(runImprovementAgent(input, new AbortController().signal, f.options()), /正常结束/);
});


test("真实分析入口加载新版 Skill，当前货架与历史快照分开读取且工具保持只读", async t => {
  const f = fixture(t);
  for (const [root, text] of [[join(f.root, "skills/java-autout"), "CURRENT_RULE"],
    [join(f.workspace, "host-skill-snapshot/java-autout"), "HISTORICAL_RULE"]]) {
    mkdirSync(join(root, "procedures"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), text);
    writeFileSync(join(root, "procedures/mock_strategy.md"), text + "_MOCK");
  }
  mkdirSync(join(f.workspace, "analysis-context"));
  writeFileSync(join(f.workspace, "analysis-context/session.json"), JSON.stringify({ system_prompt: "HISTORICAL_PROMPT" }));
  writeFileSync(join(f.root, "private-data.json"), "PRIVATE_DATA");
  let calls = 0;
  t.mock.method(CloudSession, "create", async (config: any) => {
    calls++;
    assert.deepEqual([...config.allowedTools].sort(), ["analysis_code", "analysis_evidence"]);
    const tool = config.extraTools.find((entry: any) => entry.name === "analysis_evidence");
    const read = async (scope: string, path: string) => JSON.parse((await tool.execute("read", { action: "read", scope, path })).content[0].text);
    assert.match((await read("skill_library", "java-autout/procedures/mock_strategy.md")).text, /CURRENT_RULE_MOCK/);
    assert.match((await read("task", "host-skill-snapshot/java-autout/procedures/mock_strategy.md")).text, /HISTORICAL_RULE_MOCK/);
    assert.match((await read("task", "analysis-context/session.json")).text, /HISTORICAL_PROMPT/);
    const manifest = JSON.parse((await read("analysis", "manifest.json")).text);
    assert.match(manifest.scopes.skill_library, /当前版本/);
    assert.match(manifest.limitations.join("\n"), /当前货架不能替代缺失历史/);
    await assert.rejects(read("skill_library", "../private-data.json"));
    return {
      start: async (prompt: string) => {
        assert.match(prompt, /修改构成与占比/);
        assert.match(prompt, /五类原因/);
        assert.match(prompt, /当时正文不可得/);
        assert.match(prompt, /每个提交只计一次/);
        assert.match(prompt, /低频但导致关键功能失效/);
        return { status: "turn_finished" };
      },
      finalReply: () => "根据已读取证据给出报告", dispose() {}, abort: async () => {},
    };
  });
  const service = new DeliveryImprovements(f.options);
  service.start(f.task); await service.flush();
  assert.equal(service.view(f.summary).state?.status, "completed", service.view(f.summary).state?.message);
  assert.equal(calls, 4, "三个维度和综合会话均收到真实 Skill 与相同证据读取边界");
  await service.shutdown();
});
