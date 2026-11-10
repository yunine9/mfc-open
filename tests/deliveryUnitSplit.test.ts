/** 功能模块拆分的端到端验证：Story 发布、同仓串行、参考目录和旧现场兼容。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { deliveryChangeSnapshot, listArtifactDocuments, readArtifact } from "../src/artifacts.ts";
import { readJson } from "../src/jsonBody.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import {
  requirementArtifacts, storyArtifacts, writeStoryArtifacts,
  writeRequirementArtifacts,
} from "./requirementGraphFixture.ts";
import {
  type RequirementGraph, TaskControlError, TaskService,
} from "../src/taskService.ts";

import { OVERALL_STORY_ARTIFACT, readCurrentStory, readStoryState } from "../src/overallStoryStore.ts";

const GIT_ENV = { ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function until<T>(
  probe: () => T | undefined, what: string, timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("单仓拆分:同 AR 单号确认→串行子任务+任务书+全局 Story 发布", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-unit-split-e2e-"));
  const repo = join(dataDir, "svc-core");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const ticket = "REQ2026083100";
  // 同一个仓两个单元:url 都照录下单地址,靠 id + scope 区分。
  const graphDefinition = {
    repository_assessments: [{ name: "svc-core", url: repo,
      outcome: "change_required", reason: "契约与过滤模块均需修改" }],
    repositories: [
      { id: "unit-contract", name: "svc-core", url: repo,
        responsibility: "接口契约骨架,整体编译得过",
        scope: { name: "契约骨架", paths: ["src/contract/"] } },
      { id: "unit-filter", name: "svc-core", url: repo,
        responsibility: "过滤模块实现",
        scope: { name: "过滤实现" } },
    ],
    dependencies: [{ dependent: "unit-filter", prerequisite: "unit-contract", reason: "依赖公共契约落地" }],
  };
  const chainBody = "# 单仓拆分方案\n契约先行,过滤在后。\n";
  const artifacts = storyArtifacts(chainBody, graphDefinition);
  const graphJson = artifacts.graph;
  const artifactDir = join(".mae-flow-work", ticket);
  const script: Scene[] = [
    { text: "读仓现场,写方案与机读投影",
      tool: { name: "bash", input: { command:
        `ls 1-svc-core && ` +
        `cat > "${join(artifactDir, "story.md")}" << 'CHAIN_EOF'\n` +
        `${artifacts.chain}CHAIN_EOF\n` +
        `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "拆分方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
    { text: "方案已确认,分析收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    autoArchitecture: false,
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    const parent = service.create("单仓大需求:契约先行,过滤模块化", {
      account: "cloudbot", ticket,
      repos: [repo],
      requirementAnalysis: true,
    });
    assert.equal(parent.requirement_analysis_requested, true,
      "显式分析意愿必须落盘(重启后仍是分析单)");
    assert.equal(parent.requirement_graph?.stage, "analysis",
      "单仓 + 显式要求 = 走分析前置阶段");
    const prompt = (service as any).requirementAnalysisPrompt(
      (service as any).tasks.get(parent.id), dataDir);
    assert.ok(prompt.includes(`将语义产物写入 ${join(dataDir, ".mae-flow-work", ticket, "architecture.semantic.json")}，JSON 格式：`));
    assert.match(prompt, /架构语义是本次需求分析必须交付的产物之一/);
    assert.match(prompt, /缺失时平台不会生成架构图/);
    assert.match(prompt, /4\+1/);
    assert.match(prompt, /原 Story 模板/);
    assert.match(prompt, /后续每个功能模块包含完整接口接入、业务逻辑和测试/);
    assert.match(prompt, /scope.paths 只是可选参考路径/);
    assert.match(prompt, /story_sha256/);
    assert.match(prompt, /不再生成独立 CHAIN/);
    assert.match(prompt, /建议拆分或不拆分、理由和拟定的交付边界/);
    assert.match(prompt, /拆与不拆由责任人在现有方案确认卡上决定/);

    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    const nodes = card.requirement_graph!.repositories;
    assert.equal(nodes.length, 2, "一个仓允许拆出两个单元节点");
    assert.deepEqual(nodes.map((node) => node.scope?.name),
      ["契约骨架", "过滤实现"]);

    // 骨架→实现属于串行接力，后续单元会在上游 MR 合入后从远端基准
    // 分支重新建现场；父子目录重叠、相同 AR 都是合法的交付安排。
    const parentState = (service as any).tasks.get(parent.id);
    const graphPath = join(parentState.cwd, artifactDir,
      "requirement-graph.json");
    // r1 已经随上面的确认卡送审。下面要改负责面，先模拟用户选择
    // “需要修改”后进入的返工回合；不能在原确认卡还开着时偷换文件。
    parentState.summary.status = "running";
    parentState.summary.waiting = undefined;
    const overlappingGraph = JSON.parse(graphJson) as RequirementGraph;
    overlappingGraph.repositories[1].scope!.paths = ["src/contract/filter/"];
    writeStoryArtifacts(dirname(graphPath), ticket, chainBody,
      overlappingGraph as unknown as Record<string, unknown>, "r2");
    assert.doesNotThrow(() => (service as any).requirementGraphPlan(
      parentState,
      { "unit-contract": "cloudbot", "unit-filter": "cloudbot" },
      { "unit-contract": ticket, "unit-filter": ticket },
    ), "有序的同仓交付单元可以声明相同或互相包含的允许改动范围");
    writeStoryArtifacts(dirname(graphPath), ticket, chainBody,
      graphDefinition, "r3");
    const revisedReview = parentState.humanGate.createWaiting({
      taskId: parent.id,
      step: "requirement-analysis",
      callId: "unit-split-revised-review",
      questionInput: { questions: [{
        question: "修改后的拆分方案是否确认?",
        options: ["确认并生成任务", "需要修改"],
      }] },
    });
    parentState.summary.status = "waiting_for_human";
    parentState.summary.waiting = revisedReview;
    (service as any).sealRequirementGraphReview(parentState, revisedReview);

    // 两个同仓单元有明确公共契约依赖，可以由同一责任人共用同一 AR。
    const confirmed = await service.confirmRequirementGraph(parent.id, {
      repository_assignees: {
        "unit-contract": "cloudbot", "unit-filter": "cloudbot",
      },
      repository_tickets: {
        "unit-contract": ticket, "unit-filter": ticket,
      },
    });
    assert.equal(confirmed.status, "coordinating");

    const graph = service.get(parent.id)!.requirement_graph!;
    assert.equal(graph.stage, "confirmed");
    const contractChild = service.get(graph.repositories[0].task_id!)!;
    const filterChild = service.get(graph.repositories[1].task_id!)!;
    assert.deepEqual(filterChild.blocked_by, [contractChild.id],
      "真实公共契约依赖在建单时保留");
    assert.equal(contractChild.blocked_by, undefined);
    await service.cancel(contractChild.id, "tester");
    await service.cancel(filterChild.id, "tester");
    assert.equal(service.get(parent.id)?.status, "canceled",
      "全部子任务取消时主任务也取消，不冒充交付完成");

    assert.equal(contractChild.delivery_scope, undefined);
    assert.equal(filterChild.delivery_scope, undefined);
    assert.equal(graph.source_document, "story.md");
    const published = readCurrentStory(parent.workspace);
    assert.equal(published, readFileSync(join(parentState.cwd, artifactDir, "story.md"), "utf8"));
    assert.ok(readStoryState(parent.workspace).confirmed);
    const sources = { taskMaterialRoot: parent.workspace, analysisStory: `${ticket}/story.md` };
    const docs = listArtifactDocuments(parentState.cwd, sources);
    assert.equal(docs.filter((d) => d.purpose === "overall_story").length, 1);
    assert.ok(!docs.some((d) => d.name === `${ticket}/story.md`));
    assert.equal(readArtifact(parentState.cwd, OVERALL_STORY_ARTIFACT, sources)?.content, published);
    assert.equal(service.get(parent.id)!.cross_repository_updates?.length, 1);
    (service as any).adoptRequirementStory(parentState);
    assert.equal(service.get(parent.id)!.cross_repository_updates?.length, 1, "发布重试不重复广播");
    assert.equal(contractChild.ticket, ticket);
    assert.equal(filterChild.ticket, ticket);
    assert.equal(contractChild.delivery, undefined,
      "第一个子任务必须拥有独立交付状态");
    assert.equal(filterChild.delivery, undefined,
      "后续同分支子任务不能继承上一任务的 MR 或推送收据");
    assert.match(contractChild.title ?? "", /契约骨架/,
      "子任务标题要带单元名,列表里才分得清同仓的两单");
    // 需求原文保持原样；任务书独立且位于第一阅读入口，不再藏在长原文末尾。
    assert.equal(contractChild.requirement, parent.requirement);
    assert.equal(filterChild.requirement, parent.requirement);
    const contractBrief = readFileSync(
      join(dataDir, contractChild.id, "unit-brief.md"), "utf-8");
    const filterBrief = readFileSync(
      join(dataDir, filterChild.id, "unit-brief.md"), "utf-8");
    assert.match(contractBrief, /第 1\/2 个交付单元/);
    assert.match(filterBrief, /第 2\/2 个交付单元/);
    assert.match(filterBrief, /未限定目录/);
    assert.match(filterBrief, /依赖的上游[\s\S]*契约骨架/,
      "隐式串行边必须写进下游任务书");
    assert.match(contractBrief, /依赖本单元的下游[\s\S]*过滤实现/,
      "隐式串行边必须让上游知道有人基于它开发");
    assert.match(filterBrief, /\.mae-flow-unit\.md[\s\S]*\.mae-flow-chain\.md/,
      "任务书必须把自己放在整体方案之前");
    assert.match(filterBrief, /不得重新询问主任务已经确认的事项/,
      "子任务必须消费主任务已拍板结论,不能重新开一轮相同澄清");
    assert.ok(!filterChild.requirement.includes("契约先行,过滤在后"),
      "方案正文不得内联进需求");
    const plan = readFileSync(
      join(dataDir, filterChild.id, "chain-plan.md"), "utf-8");
    assert.match(plan, /单仓拆分方案/, "CHAIN 正文随子任务落盘");

    // 全部子任务真实完成后父任务才收口。以下手工改写子任务状态仅为验证
    // 汇总；另起一个汇总现场（同 chainAnalysis，bf1e30dc）。
    const internal = service as any;
    internal.tasks.get(parent.id).summary.status = "coordinating";
    for (const child of [contractChild, filterChild]) {
      const state = internal.tasks.get(child.id);
      state.summary.status = "completed";
      internal.persist(state);
    }
    assert.equal(service.get(parent.id)?.status, "completed");
  } finally {
    await model.stop();
  }
});

/** 负责面门禁的真仓现场:baseline 一笔,面内一笔,越界一笔。
 * src/filterX 专门用来验前缀按路径段闭合——裸 startsWith 会把它
 * 误认成 src/filter 面内。 */
function scopedRepository(target?: string) {
  const cwd = target ?? mkdtempSync(join(tmpdir(), "mfc-scope-gate-"));
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
  git("init", "--quiet", "-b", "master");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  const baseline = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "src", "filter"), { recursive: true });
  mkdirSync(join(cwd, "src", "filterX"), { recursive: true });
  mkdirSync(join(cwd, "src", "contract"), { recursive: true });
  writeFileSync(join(cwd, "src", "filter", "impl.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "src", "filterX", "other.ts"), "export const b = 1;\n");
  writeFileSync(join(cwd, "src", "contract", "api.ts"), "export const c = 1;\n");
  // 内核流程要求每个单元都写的规格:在面外,但不是越界(见下面的断言)。
  mkdirSync(join(cwd, "docs", "specs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "specs", "index.md"), "# specs\n");
  writeFileSync(join(cwd, "docs", "specs", "filter.md"), "# filter\n");
  git("add", "src", "docs");
  git("commit", "--quiet", "-m", "unit work");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_watch",
    revision: 3,
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host",
      continuous_review: true, source: "order",
    },
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: baseline, delivery_watch: head },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], initial_dirty: [],
  }));
  return cwd;
}

async function scopedTask() {
  const model = new ScriptedModelServer([
    { text: "完成。" }, { text: "备用一。" }, { text: "备用二。" },
  ]);
  await model.start();
  const service = new TaskService({
    autoArchitecture: false,
    dataDir: mkdtempSync(join(tmpdir(), "mfc-scope-gate-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("负责面门禁演练", { account: "worker" }).id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口", 20_000);
  const internal = (service as any).tasks.get(id);
  // 与生产一致：代码仓必须在任务 workspace 之内，宿主 capability 根
  // 才能由不可伪造的目录关系确定。
  internal.cwd = scopedRepository(
    join(internal.summary.workspace, "scope-repo-fixture"));
  internal.summary.status = "verifying";
  internal.summary.delivery_scope = { name: "过滤实现", paths: ["src/filter/"] };
  (service as any).options.host = {
    kernelRoot: join(process.cwd(), "kernel"),
    python: "python3",
    continuousReview: true,
  };
  sealPipelineLifecycle({
    cwd: internal.cwd,
    workspace: internal.summary.workspace,
    taskId: id,
    kernelRoot: join(process.cwd(), "kernel"),
  });
  return { service, model, id, internal };
}

test("模块路径只是参考：目录外提交不会阻断或产生新门禁", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    const before = await deliveryChangeSnapshot(internal.cwd);
    assert.equal(await (service as any).deliveryScopeAllowsPush(internal), true);
    assert.equal(internal.summary.delivery?.scope_violation, undefined);
    assert.equal(internal.summary.delivery_scope_exemptions, undefined);
    assert.deepEqual(await deliveryChangeSnapshot(internal.cwd), before, "保留真实提交与改动");
    await service.cancel(id, "tester");
  } finally { await model.stop(); }
});

test("负责面门禁:目标分支前进并合入后不把其他任务文件误报为本单元越界", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    const cwd = internal.cwd as string;
    const git = (...args: string[]) => execFileSync(
      "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
    const baseline = JSON.parse(readFileSync(
      join(cwd, ".mae-flow.json"), "utf-8")).step_heads.branch_create;
    git("switch", "--quiet", "-c", "upstream-work", baseline);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "other-task.md"), "other task\n");
    git("add", "docs/other-task.md");
    git("commit", "--quiet", "-m", "other task");
    const upstream = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/master", upstream);
    git("switch", "--quiet", "master");
    git("merge", "--quiet", "--no-edit", "upstream-work");

    assert.equal(
      await (service as any).deliveryScopeAllowsPush(internal), true);
    assert.equal(internal.summary.delivery?.scope_violation, undefined);
    const snapshot = await deliveryChangeSnapshot(cwd);
    assert.ok(snapshot?.baseline);
    const presentation = await (service as any).buildPushReviewPresentation(
      internal, snapshot, false);
    // 规格产物是本单元 MR 的净贡献之一(要随 MR 检视),只是不算越界。
    assert.deepEqual(presentation.committed_paths, [
      "docs/specs/filter.md", "docs/specs/index.md",
      "src/contract/api.ts", "src/filter/impl.ts", "src/filterX/other.ts",
    ], "最终交付清单同样只显示本单元 MR 净贡献");
    assert.ok(!presentation.committed_paths.includes("docs/other-task.md"));
    await service.cancel(id, "tester");
  } finally {
    await model.stop();
  }
});

test("旧目录裁决入口不可派发撤出代码使命，过时卡在正常验证时清理", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    internal.summary.delivery = { scope_violation: { paths: ["src/contract/api.ts"], noted_at: "old" } };
    const before = await deliveryChangeSnapshot(internal.cwd);
    for (const decision of ["allow", "revert"] as const) {
      assert.throws(() => service.decideScopeViolation(id, decision, "boss"), /模块目录限制已取消/);
    }
    assert.equal(await (service as any).deliveryScopeAllowsPush(internal), true);
    assert.equal(internal.summary.delivery.scope_violation, undefined);
    assert.deepEqual(await deliveryChangeSnapshot(internal.cwd), before);
    await service.cancel(id, "tester");
  } finally { await model.stop(); }
});

test("负责面门禁 HTTP:非主责任人 403 并点名应联系的账号", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-scope-http-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("main-owner", "main-owner-pass", "developer");
  auth.createUser("other-dev", "other-developer-pass", "developer");
  const service = new TaskService({
    autoArchitecture: false,
    dataDir: join(root, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const parent = service.create("跨单元主任务", { account: "main-owner" });
  const child = service.create("越界子任务", { account: "other-dev" });
  const childState = (service as any).tasks.get(child.id);
  childState.summary.parent_task_id = parent.id;
  childState.summary.delivery_scope = {
    name: "过滤实现", paths: ["src/filter/"],
  };
  childState.summary.delivery = {
    scope_violation: {
      paths: ["src/filterX/other.ts"], noted_at: new Date().toISOString(),
    },
  };
  (service as any).persist(childState);
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({
        username: "other-dev", password: "other-developer-pass",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const denied = await fetch(`${base}/tasks/${child.id}/scope-decision`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ decision: "allow" }),
    });
    assert.equal(denied.status, 403);
    const payload = await readJson(denied);
    assert.match(payload.error, /主任务责任人 main-owner.*联系该账号/);
    assert.deepEqual(service.get(child.id)?.delivery?.scope_violation?.paths,
      ["src/filterX/other.ts"], "越权点击不得改变待裁决现场");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("单号延后:勾分析拆分下单免单号,确认卡逐单元补齐后才放行", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-unit-split-noticket-"));
  const repo = join(dataDir, "svc-solo");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const chainBody = "# 免单号拆分方案\n契约先行。\n";
  const artifacts = requirementArtifacts(chainBody, {
    repository_assessments: [{ name: "svc-solo", url: repo,
      outcome: "change_required", reason: "需要拆分契约和实现" }],
    repositories: [
      { id: "unit-a", name: "svc-solo", url: repo, responsibility: "契约",
        scope: { name: "契约骨架", paths: ["src/a/"] } },
      { id: "unit-b", name: "svc-solo", url: repo, responsibility: "实现",
        scope: { name: "过滤实现", paths: ["src/b/"] } },
    ],
    dependencies: [],
  });
  const graphJson = artifacts.graph;
  // 没有单号时产物目录按任务 id 命名;会话 cwd 是 <任务id>/repositories,
  // 场景里从上级目录名取 id,和真模型看到的指引路径同源。
  const script: Scene[] = [
    { text: "读仓,写免单号现场的产物",
      tool: { name: "bash", input: { command:
        `tid=$(basename "$(dirname "$PWD")") && ls 1-svc-solo && ` +
        `mkdir -p ".mae-flow-work/$tid" && ` +
        `cat > ".mae-flow-work/$tid/CHAIN-$tid.md" << 'CHAIN_EOF'\n` +
        `${artifacts.chain}CHAIN_EOF\n` +
        `cat > ".mae-flow-work/$tid/requirement-graph.json" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "拆分方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
    { text: "确认完毕,收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    autoArchitecture: false,
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    // 内核模式下普通单不填单号照旧拒绝——豁免只给显式勾了分析的主任务。
    assert.throws(() => service.create("没单号的普通单", {
      account: "cloudbot", repos: [repo],
    }), /AR 单号/);
    const parent = service.create("免单号大需求:先拆再定单号", {
      account: "cloudbot", repos: [repo], requirementAnalysis: true,
    });
    assert.equal(parent.ticket, undefined, "分析主任务不再持有单号");
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    assert.equal(card.requirement_graph?.repositories.length, 2);
    // 不补单号直接确认:必须收到"逐单元补齐"的人话拒绝,而不是拿
    // 任务 id 兜底后报出莫名其妙的"同单号"撞分支错。
    await assert.rejects(
      () => service.confirmRequirementGraph(parent.id),
      (error: unknown) => error instanceof TaskControlError
        && /确认拆分时逐单元补齐/.test((error as Error).message));
    const confirmed = await service.confirmRequirementGraph(parent.id, {
      repository_assignees: { "unit-a": "cloudbot", "unit-b": "cloudbot" },
      repository_tickets: {
        "unit-a": "REQ2026090201", "unit-b": "REQ2026090202",
      },
    });
    assert.equal(confirmed.status, "coordinating");
    const graph = service.get(parent.id)!.requirement_graph!;
    const first = service.get(graph.repositories[0].task_id!)!;
    const second = service.get(graph.repositories[1].task_id!)!;
    await service.cancel(first.id, "tester");
    await service.cancel(second.id, "tester");
    assert.equal(first.ticket, "REQ2026090201");
    assert.equal(second.ticket, "REQ2026090202");
    assert.equal(first.requirement, parent.requirement);
    assert.match(readFileSync(
      join(dataDir, first.id, "unit-brief.md"), "utf-8"),
    /AR 单号：REQ2026090201/);
    assert.deepEqual(second.blocked_by ?? [], [],
      "独立 AR 的无依赖同仓单元不应增加等待");
  } finally {
    await model.stop();
  }
});

test("同仓拆多单元:新节点继承该仓下单责任人为默认,单号仍逐单元确认", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-unit-inherit-"));
  const repoA = join(dataDir, "svc-a");
  const repoB = join(dataDir, "svc-b");
  for (const repo of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "master", repo]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
      "-m", "init"], { env: GIT_ENV });
  }
  const service = new TaskService({
    autoArchitecture: false,
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  const parent = service.create("多仓需求,A 仓要拆", {
    account: "owner", ticket: "REQ2026090301",
    repos: [repoA, repoB],
    repositoryAssignees: { [repoA]: "alice", [repoB]: "bob" },
    repositoryTickets: {
      [repoA]: "REQ2026090301", [repoB]: "REQ2026090302",
    },
  });
  const state = (service as any).tasks.get(parent.id);
  // 模拟分析会话现场:A 仓拆成两个单元,B 仓保持一个节点。
  const cwd = join(dataDir, "analysis-cwd");
  const artifactDir = join(cwd, ".mae-flow-work", "REQ2026090301");
  writeRequirementArtifacts(artifactDir, "REQ2026090301",
    "# 多仓模块方案\nA 拆成契约与实现，B 负责消费。\n", {
    repository_assessments: [
      { name: "svc-a", url: repoA, outcome: "change_required",
        reason: "契约和过滤实现需要修改" },
      { name: "svc-b", url: repoB, outcome: "change_required",
        reason: "消费接口需要修改" },
    ],
    repositories: [
      { id: "unit-a1", name: "svc-a", url: repoA, responsibility: "契约",
        scope: { name: "契约骨架", paths: ["src/contract/"] } },
      { id: "unit-a2", name: "svc-a", url: repoA, responsibility: "实现",
        scope: { name: "过滤实现", paths: ["src/filter/"] } },
      { id: "unit-b", name: "svc-b", url: repoB, responsibility: "消费接口",
        scope: { name: "接口消费", paths: ["src/client/"] } },
    ],
    dependencies: [],
  });
  state.cwd = cwd;
  (service as any).refreshRequirementGraph(state);
  const nodes = state.summary.requirement_graph.repositories;
  assert.deepEqual(nodes.map((node: { assignee?: string }) => node.assignee),
    ["alice", "alice", "bob"],
    "拆分后单元默认继承该仓下单责任人,不得回落主责任人");
  assert.deepEqual(nodes.map((node: { ticket?: string }) => node.ticket),
    [undefined, undefined, "REQ2026090302"],
    "同仓单元的单号逐项确认但允许填相同 AR；单节点仓照旧");
  assert.equal(nodes[2].assignee, "bob",
    "未拆分的仓经 url 兜底完整保留下单事实");
});

test("同仓串行单元共用远端分支时，上一轮合入后下一轮可快进推送", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-unit-same-ticket-git-"));
  const bare = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--quiet", bare]);
  const branch = "master_owner_REQ-SAME";
  const first = join(root, "first");
  execFileSync("git", ["clone", "--quiet", bare, first]);
  execFileSync("git", ["-C", first, "checkout", "--quiet", "-b", "master"]);
  writeFileSync(join(first, "base.txt"), "base\n");
  execFileSync("git", ["-C", first, "add", "."]);
  execFileSync("git", ["-C", first, "commit", "--quiet", "-m", "base"], { env: GIT_ENV });
  execFileSync("git", ["-C", first, "push", "--quiet", bare, "master"]);
  execFileSync("git", ["-C", first, "checkout", "--quiet", "-b", branch]);
  writeFileSync(join(first, "unit-1.txt"), "one\n");
  execFileSync("git", ["-C", first, "add", "."]);
  execFileSync("git", ["-C", first, "commit", "--quiet", "-m", "unit one"], { env: GIT_ENV });
  execFileSync("git", ["-C", first, "push", "--quiet", bare, branch]);
  execFileSync("git", ["--git-dir", bare, "update-ref", "refs/heads/master",
    execFileSync("git", ["-C", first, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()]);

  const second = join(root, "second");
  execFileSync("git", ["clone", "--quiet", "--branch", "master", bare, second]);
  execFileSync("git", ["-C", second, "checkout", "--quiet", "-b", branch]);
  writeFileSync(join(second, "unit-2.txt"), "two\n");
  execFileSync("git", ["-C", second, "add", "."]);
  execFileSync("git", ["-C", second, "commit", "--quiet", "-m", "unit two"], { env: GIT_ENV });
  execFileSync("git", ["-C", second, "push", "--quiet", bare, branch]);
  assert.doesNotThrow(() => execFileSync("git", ["--git-dir", bare,
    "merge-base", "--is-ancestor", "master", branch]));
  assert.equal(execFileSync("git", ["--git-dir", bare, "rev-list", "--count",
    "master.." + branch], { encoding: "utf8" }).trim(), "1");
});
