import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { HostGitSandbox, type PreparedHostGit } from "../src/hostGitSandbox.ts";
import { syncKnowledgeSource } from "../src/knowledgeExtractionFactory.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runGenericDomainKnowledge as runDomainKnowledge } from "./helpers/extractionSkillFixture.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

// RED 时旧实现会忽略第六参；类型断言只让测试观察公开调用，不替实现补取版本。
const syncWithBaselines = syncKnowledgeSource as (root: string, repository: string, branch: string, sandbox: PreparedHostGit,
  signal?: AbortSignal, baselineRevisions?: string[]) => ReturnType<typeof syncKnowledgeSource>;

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "production-source-baseline-")), work = join(root, "work"), remote = join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(work); git(work, "init", "-b", "main"); git(work, "config", "user.name", "Fixture"); git(work, "config", "user.email", "fixture@example.test");
  mkdirSync(join(work, "src")); writeFileSync(join(work, "src/rules.ts"), "export const status = 'created';\n"); writeFileSync(join(work, "outside.ts"), "export const privateValue = 'old';\n");
  git(work, "add", "."); git(work, "commit", "-m", "base"); const base = git(work, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", work, remote], { stdio: "ignore" });
  return { root, work, remote, base, git, advance() {
    writeFileSync(join(work, "src/rules.ts"), "export const status = 'paid';\n"); writeFileSync(join(work, "outside.ts"), "export const privateValue = 'new';\n");
    git(work, "add", "."); git(work, "commit", "-m", "update"); git(work, "push", remote, "main"); return git(work, "rev-parse", "HEAD");
  } };
}
async function terminal(read: () => { status: string }) {
  const until = Date.now() + 5_000;
  while (["queued", "running"].includes(read().status) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!["queued", "running"].includes(read().status), "测试任务应在五秒内完成");
}

for (const identity of [{ operator: "bob", token: "bob-new-token" }, { operator: "alice", token: "alice-new-token" }]) {
  test(`生产线验收12：F17 ${identity.operator === "bob" ? "换人" : "换令牌"}的全新浅缓存按需取回旧SHA，返回仍是本轮最新版本`, async () => {
    const f = sourceFixture(), sandbox = new HostGitSandbox(f.root), first = sandbox.prepare({ username: "alice", password: "alice-old-token" });
    let next: PreparedHostGit | undefined;
    try {
      const old = await syncWithBaselines(join(f.root, "alice-old-cache"), f.remote, "main", first); assert.equal(old.revision, f.base);
      const latest = f.advance(); next = sandbox.prepare({ username: identity.operator, password: identity.token });
      const prepared = await syncWithBaselines(join(f.root, `${identity.operator}-new-cache`), f.remote, "main", next, undefined, [f.base]);
      assert.equal(prepared.revision, latest, "取基线不能把 FETCH_HEAD 当作本轮版本返回");
      assert.doesNotThrow(() => f.git(prepared.root, "cat-file", "-e", `${f.base}^{commit}`), "来源比较之前旧版本已在本次调用人的缓存中");
      const patch = f.git(prepared.root, "diff", `${f.base}..${prepared.revision}`, "--", "src");
      assert.match(patch, /-export const status = 'created'/); assert.match(patch, /\+export const status = 'paid'/); assert.doesNotMatch(patch, /privateValue/);
      assert.ok(existsSync(join(prepared.root, "shallow")), "只补需要的版本，不把源码缓存改成无限拉全历史");
      const config = readFileSync(join(prepared.root, "config"), "utf8"); assert.doesNotMatch(config, /alice-old-token|alice-new-token|bob-new-token|credential\.helper/);
    } finally { sandbox.cleanup(first); sandbox.cleanup(next); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("生产线验收12：F17远端无法取回旧SHA时点名基线不可得，不伪装成本地源码操作失败", async () => {
  const f = sourceFixture(), sandbox = new HostGitSandbox(f.root), prepared = sandbox.prepare({ username: "bob", password: "fixture-token" }), missing = "a".repeat(40);
  try {
    f.advance();
    await assert.rejects(syncWithBaselines(join(f.root, "fresh-cache"), f.remote, "main", prepared, undefined, [missing]), (error: Error) => {
      assert.ok(error.message.includes(`基线版本 ${missing} 在源码仓中已不可得`)); assert.doesNotMatch(error.message, /本地源码操作失败|fixture-token/); return true;
    });
  } finally { sandbox.cleanup(prepared); rmSync(f.root, { recursive: true, force: true }); }
});

for (const available of [true, false]) {
  test(`生产线验收12：F17领域来源变化工具向源码装配请求旧SHA并${available ? "真实比较允许范围" : "如实返回基线不可得"}`, async t => {
    const f = sourceFixture(), latest = f.advance(), sandbox = new HostGitSandbox(f.root), prepared = sandbox.prepare({ username: "bob", password: "fixture-token" });
    const baseline = available ? f.base : "a".repeat(40), requests: Array<string[] | undefined> = [];
    let observed: any;
    const session = t.mock.method(CloudSession, "create", async (config: any) => ({
      async start() {
        observed = await config.extraTools.find((tool: any) => tool.name === "knowledge_source_changes").execute("changes", { repository_id: "repo-1" });
        const result = await config.extraTools.find((tool: any) => tool.name === "knowledge_work_result").execute("done", { summary: "已检查来源变化", document_ids: ["rules"] });
        assert.equal(!!result.isError, false); return { status: "turn_finished" };
      }, dispose() {}, abort: async () => {},
    }) as any);
    const service = new DomainKnowledgeExtraction(f.root, input => {
      input.turn.previous_revisions = { "repo-1": baseline };
      input.save({ id: "rules", title: "订单规则", target_id: "domain", path: "docs/订单/rules.md", layer: "domain", content: "# 订单规则\n已有待审草稿", sources: "测试提供的业务规则" });
      return runDomainKnowledge(input, { dataDir: f.root, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
        source: async (_repo, operator, signal, baselineRevisions?: string[]) => {
          assert.equal(operator, "bob"); requests.push(baselineRevisions);
          return syncWithBaselines(join(f.root, "bob-fresh-cache"), f.remote, "main", prepared, signal, baselineRevisions);
        } });
    });
    try {
      const job = service.create({ title: "订单", scope: "状态", issue_no: "REQ-1", repositories: [{ repository: "https://example.test/source.git", branch: "main", path: "src" }] }, "bob");
      await terminal(() => service.get(job.id)); assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
      assert.ok(requests.some(revisions => revisions?.includes(baseline)), "Agent 把旧基线交给当前人的源码准备调用");
      const text = observed.content[0].text;
      if (available) { assert.equal(!!observed.isError, false, text); assert.match(text, /created/); assert.match(text, /paid/); assert.doesNotMatch(text, /privateValue/); assert.equal(service.get(job.id).turns[0].revisions?.["repo-1"], latest); }
      else { assert.equal(observed.isError, true); assert.ok(text.includes(`基线版本 ${baseline} 在源码仓中已不可得`)); assert.doesNotMatch(text, /本地源码操作失败/); }
    } finally { await service.shutdown(); session.mock.restore(); sandbox.cleanup(prepared); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("生产线验收12：F17组件接续研究请求本轮固定SHA，不拿换令牌后的仓库HEAD替代", async () => {
  const f = sourceFixture(), ec = join(f.root, "ec"), previousEc = process.env.MAE_FLOW_EC_BIN;
  f.advance(); writeFileSync(ec, `#!${process.execPath}\nconsole.log('fixture ec tools');\n`, { mode: 0o700 }); process.env.MAE_FLOW_EC_BIN = ec;
  seedTechnologyStacks(f.root, ["java"]);
  const component = saveComponentRepository(f.root, { name: "基础库", repository: "https://example.test/base.git", branch: "main", path: "src", languages: ["java"] }, "bob");
  let requested: string[] | undefined;
  const service = new ComponentResearch(f.root, input => {
    input.record.revisions = { [component.id]: f.base };
    return runComponentResearch(input, { dataDir: f.root, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
      source: async (_component, _operator, _signal, baselineRevisions?: string[]) => { requested = baselineRevisions; throw new Error("FIXTURE_SOURCE_STOP"); } });
  });
  try {
    const job = service.start({ language: "java" }, "bob"); await terminal(() => service.get(job.id));
    assert.match(service.get(job.id).error ?? "", /FIXTURE_SOURCE_STOP/); assert.deepEqual(requested, [f.base]);
  } finally { await service.shutdown(); if (previousEc === undefined) delete process.env.MAE_FLOW_EC_BIN; else process.env.MAE_FLOW_EC_BIN = previousEc; rmSync(f.root, { recursive: true, force: true }); }
});
