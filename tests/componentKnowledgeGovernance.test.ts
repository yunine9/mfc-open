import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { consumptionFixture, enableComponentHints } from "./componentConsumptionFixture.ts";
import { ComponentKnowledgeConsumption } from "../src/componentKnowledgeConsumption.ts";
import { componentGovernance } from "../src/componentKnowledgeGovernance.ts";
import { readComponentPolicies, saveComponentPolicy, componentObservations, addComponentFeedback, recordComponentObservations, componentFeedback, applyComponentExemptions } from "../src/componentKnowledgePolicy.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { componentKnowledgeRoute } from "../src/componentKnowledgeRoutes.ts";

const consumer = (f: ReturnType<typeof consumptionFixture>) => new ComponentKnowledgeConsumption({ dataDir: f.data, cwd: f.cwd, context: () => f.context, languages: () => ["cpp"], baseline: () => "main" });

test("超过旧数量上限后，人工误报判断、命中依据和策略历史仍在", async () => {
  const f = consumptionFixture();
  try {
    f.publish(); enableComponentHints(f);
    const c = consumer(f), report = await c.check({ trigger: "sample" });
    const observation = componentObservations(f.data)[0];
    assert.ok(observation);
    const root = join(f.data, "component-governance");
    const input = { item_id: observation.rule_id, source_digest: observation.source_digest, observation_id: observation.id, kind: "false_positive", reason: "这里是已确认的底层实现" };
    const original = addComponentFeedback(f.data, input, "reviewer");
    // 模拟已有历史数据到达旧阈值，再通过真实写入口增加一条。
    writeFileSync(join(root, "observations.json"), JSON.stringify([observation, ...Array.from({ length: 1999 }, (_, n) => ({ ...observation, id: `old-${n}`, path: `old-${n}.cpp` }))]));
    recordComponentObservations(f.data, observation.repository, { ...report, findings: [{ ...report.findings[0], path: "new.cpp" }] });
    assert.equal(componentObservations(f.data).length, 2001);
    assert.ok(componentObservations(f.data).some(item => item.id === observation.id));
    writeFileSync(join(root, "feedback.json"), JSON.stringify([original, ...Array.from({ length: 1999 }, (_, n) => ({ ...original, id: `feedback-${n}`, observation_id: undefined, kind: "quality_ok", operator: `person-${n}` }))]));
    addComponentFeedback(f.data, { ...input, observation_id: undefined, kind: "quality_ok" }, "new-reviewer");
    assert.equal(componentFeedback(f.data).length, 2001);
    const checked = { ...report, findings: report.findings.map(finding => ({ ...finding })) };
    applyComponentExemptions(f.data, observation.repository, checked);
    assert.equal(checked.findings[0].exempt_reason, input.reason, "新反馈不能使已确认的误报再次提示");
    addComponentFeedback(f.data, { ...input, kind: "useful", reason: "重新确认这次需要提示" }, "reviewer");
    const history = JSON.parse(readFileSync(join(root, "policy-history.json"), "utf8"));
    writeFileSync(join(root, "policy-history.json"), JSON.stringify(Array.from({ length: 1000 }, (_, n) => ({ ...history[0], reason: `历史判断 ${n}` }))));
    policy(f, c.catalog().rules[0], "off");
    const stored = JSON.parse(readFileSync(join(root, "policy-history.json"), "utf8"));
    assert.equal(stored.length, 1001);
    assert.equal(stored[0].reason, "历史判断 0");
  } finally { f.cleanup(); }
});
function policy(f: ReturnType<typeof consumptionFixture>, item: { id: string; source_digest: string }, level: string, scope: string[] = []) {
  return saveComponentPolicy(f.data, item.id, item.source_digest, { revision: readComponentPolicies(f.data).revision, source_digest: item.source_digest, level, scope, owner: "线程池负责人", reason: "已核对实际使用边界" }, "reviewer");
}
test("默认候选不进入 Agent 提示；策略即时生效、按路径检查、停用和源修订失效", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), c = consumer(f); mkdirSync(join(f.cwd, "src"));
    writeFileSync(join(f.cwd, "src/new.cpp"), "void x() { std::thread value; }\n");
    writeFileSync(join(f.cwd, "outside.cpp"), "void x() { std::thread value; }\n");
    const rule = c.catalog().rules[0];
    assert.equal(await c.afterTool("Bash", {}), undefined);
    assert.equal(componentObservations(f.data).length, 2);
    policy(f, rule, "warning", ["src/**"]);
    const visible = await c.afterTool("Bash", {}); assert.match(visible!, /src\/new.cpp/); assert.doesNotMatch(visible!, /outside.cpp/);
    policy(f, rule, "off"); assert.equal(await c.afterTool("Bash", {}), undefined);
    policy(f, rule, "warning");
    saveKnowledgeDocument(f.data, { content: doc.content.replaceAll("Pool.submit", "Pool.enqueue") }, "expert", doc.id);
    assert.equal(c.catalog().rules[0].policy.level, "shadow"); assert.equal(c.catalog().rules[0].policy.stale, true);
    assert.equal(await c.afterTool("Bash", {}), undefined);
    policy(f, c.catalog().rules[0], "off");
    saveKnowledgeDocument(f.data, { content: doc.content }, "expert", doc.id);
    assert.equal(c.catalog().rules[0].policy.level, "off", "急停不因文档更新恢复");
    assert.throws(() => policy(f, rule, "error"), /不能拦截/);
    assert.throws(() => policy(f, rule, "warning", ["../src/**"]), /路径范围/);
    assert.throws(() => saveComponentPolicy(f.data, rule.id, rule.source_digest, { revision: -1 }, "x"), /已被其他人更新/);
    writeFileSync(join(f.data, "component-governance/rule-policy.json"), "broken");
    assert.equal(c.catalog().rules[0].policy.level, "shadow"); assert.equal(await c.afterTool("Bash", {}), undefined);
  } finally { f.cleanup(); }
});
test("实际存量样本、重复检查去重、带理由的误报豁免与质量反馈闭环", async () => {
  const f = consumptionFixture();
  try {
    f.publish(); enableComponentHints(f); const c = consumer(f);
    const sample = await c.check({ trigger: "sample" });
    assert.equal(sample.status, "completed", sample.warnings.join()); assert.equal(sample.findings[0].path, "existing.cpp");
    assert.match(sample.findings[0].context!, /old_thread/);
    await c.check({ trigger: "sample" }); assert.equal(componentObservations(f.data).length, 1);
    writeFileSync(join(f.cwd, "new.cpp"), "void x() { std::thread value; }\n");
    assert.match((await c.afterTool("Write", { path: "new.cpp" }))!, /new.cpp/);
    const observation = componentObservations(f.data).find(r => r.path === "new.cpp")!;
    const row = { item_id: observation.rule_id, source_digest: observation.source_digest, observation_id: observation.id, kind: "false_positive", reason: "组件底层适配器必须创建原生线程" };
    addComponentFeedback(f.data, row, "expert"); addComponentFeedback(f.data, row, "expert");
    assert.equal(await consumer(f).afterTool("Write", { path: "new.cpp" }), undefined, "当前代码的合理例外不再提示");
    let item = componentGovernance(f.data).items.find(r => r.id === observation.rule_id)!;
    assert.equal(item.stats.observed, 2); assert.equal(item.stats.reviewed, 1); assert.equal(item.stats.exempt, 1); assert.equal(item.feedback.length, 1);
    addComponentFeedback(f.data, { ...row, observation_id: undefined, kind: "counterexample", reason: "初始化期任务池尚不可用，请缩小范围" }, "expert");
    item = componentGovernance(f.data).items.find(r => r.id === observation.rule_id)!; assert.equal(item.needs_review, true);
    assert.equal(item.policy.level, "warning", "反馈不会自动修改人工策略");
    addComponentFeedback(f.data, { ...row, kind: "useful", reason: "重新确认该位置适用，撤回此前豁免" }, "expert");
    assert.match((await consumer(f).afterTool("Write", { path: "new.cpp" }))!, /new.cpp/);
    assert.equal(componentGovernance(f.data).items.find(r => r.id === observation.rule_id)!.stats.exempt, 0);
    assert.throws(() => addComponentFeedback(f.data, { ...row, observation_id: undefined }, "expert"), /实际命中样本/);
    writeFileSync(join(f.cwd, "new.cpp"), "void changed() { std::thread another; }\n");
    assert.match((await consumer(f).afterTool("Write", { path: "new.cpp" }))!, /new.cpp/, "代码内容变化后重新观察");
    assert.throws(() => addComponentFeedback(f.data, { ...row, source_digest: "other" }, "expert"), /版本不一致/);
  } finally { f.cleanup(); }
});
test("治理接口从真实目录取当前版本，拒绝伪造条目，反例研究传递来源仓与待验证主张", async () => {
  const f = consumptionFixture();
  try {
    f.publish(); const item = componentGovernance(f.data).items.find(i => i.kind === "rule")!;
    let challenge: any;
    const service: any = { options: { dataDir: f.data }, getComponentResearch: () => ({ list: () => [], startChallenge: (input: any) => { challenge = input; return { id: "challenge" }; } }) };
    async function request(parts: string[], body: any, method = "POST") {
      let result: any; await componentKnowledgeRoute({ method } as any, {} as any, ["component-knowledge", ...parts], service, "owner", async () => body, (_r, status, value) => { result = { status, value }; }); return result;
    }
    assert.equal((await request([item.id, "policy"], { revision: 0, source_digest: "stale", level: "warning" })).status, 400);
    assert.equal((await request(["fake", "feedback"], {})).status, 400);
    const artifacts = await request([item.id, "artifacts"], undefined, "GET");
    assert.equal(artifacts.status, 200); assert.ok(artifacts.value.files[`derived/ast-grep/rules/${item.id}.yml`]);
    const knowledge = componentGovernance(f.data).items.find(i => i.kind === "mapping")!;
    assert.equal((await request([knowledge.id, "policy"], { source_digest: knowledge.source_digest })).status, 400);
    assert.equal((await request([item.id, "challenge"], { source_digest: item.source_digest })).status, 202);
    assert.deepEqual(challenge.repository_ids, ["base"]); assert.match(challenge.claim, /std::thread/);
    assert.equal((await request([item.id, "policy"], { revision: 0, source_digest: item.source_digest, level: "warning", owner: "owner", reason: "已核对适用边界" })).status, 200);
    assert.equal(componentGovernance(f.data).items.find(i => i.id === item.id)!.policy.level, "warning");
  } finally { f.cleanup(); }
});

test("MR 组件计划核对只观察：读计划足迹失败记进报告，不抛给宿主 push", async () => {
  // delivery.part6 实测：recordedPaths() 读足迹抛错曾一路冒泡到 pushFromHost，
  // 把一次正常推送整个打断。观察类检查的故障只能如实记账，不能变成推送失败。
  const f = consumptionFixture();
  try {
    const sha = f.git("rev-parse", "HEAD");
    const c = new ComponentKnowledgeConsumption({ dataDir: f.data, cwd: f.cwd, context: () => f.context,
      languages: () => ["cpp"], baseline: () => "main",
      plan: () => ({ recordedPaths: () => { throw new TypeError("足迹不可读"); } }) as never });
    const report = await c.check({ target: sha, trigger: "mr" });
    assert.deepEqual(report.plans, []);
    assert.ok(report.warnings.some(w => /组件计划核对未完成：足迹不可读/.test(w)), report.warnings.join());
  } finally { f.cleanup(); }
});
