import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { writeRequirementArtifacts } from "./requirementGraphFixture.ts";
import { mfcTemp } from "./mfcTmp.ts";

const KERNEL = resolve("kernel");

function repository(name: string, skills: Array<{
  root: ".agents" | ".pi" | ".claude" | ".cac";
  name: string;
  marker: string;
}>): string {
  const root = mkdtempSync(join(tmpdir(), `mfc-skill-flow-${name}-`));
  execFileSync("git", ["init", "--quiet", "--initial-branch=master"], { cwd: root });
  for (const skill of skills) {
    const directory = join(root, skill.root, "skills", skill.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.marker}`,
      "---",
      "",
      `正文 ${skill.marker}`,
      "",
    ].join("\n"));
  }
  writeFileSync(join(root, "README.md"), `${name}\n`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "--quiet", "-m", "init",
  ], { cwd: root });
  return root;
}

function service(dataDir: string): TaskService {
  return new TaskService({
    dataDir,
    provider: "unused",
    model: "unused",
    modelsJson: {
      providers: { unused: { models: [{ id: "unused" }] } },
    },
    maxConcurrent: 0,
    host: { kernelRoot: KERNEL },
    delivery: { platformUrl: "http://127.0.0.1:1" },
  });
}

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 40));
  }
}

test("目录令牌把服务端发现结果还原为任务 Skill 清单", async () => {
  const repo = repository("api", [
    { root: ".agents", name: "domain-api", marker: "DOMAIN-API-MARKER" },
    { root: ".cac", name: "release-notes", marker: "RELEASE-MARKER" },
  ]);
  mkdirSync(join(repo, "docs", "domain"), { recursive: true });
  writeFileSync(join(repo, "docs", "domain", "api.md"),
    "# API 领域知识\n\n错误码与幂等规则。\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "--quiet", "-m", "knowledge",
  ], { cwd: repo });
  const taskService = service(mfcTemp("mfc-skill-flow-data-"));
  const catalog = await taskService.scanRepositorySkills({
    repositories: [repo], baseline: "master", account: "dev",
  });
  assert.equal(catalog.repositories.length, 1);
  assert.equal(catalog.repositories[0].skills.length, 2);
  const chosen = catalog.repositories[0].skills.find(
    (skill) => skill.name === "domain-api")!;
  const task = taskService.create("修改 API", {
    account: "dev",
    repo,
    ticket: "REQ20260001",
    baseline: "master",
    repositorySkillCatalogToken: catalog.catalog_token,
    selectedRepositorySkillIds: [chosen.id],
  });
  assert.deepEqual(task.repository_skills?.map((skill) => skill.name),
    ["domain-api"]);
  assert.equal(task.repository_skills?.[0].repository, repo);
  assert.equal(task.repository_skills?.[0].relative_path,
    ".agents/skills/domain-api/SKILL.md");
});

test("目录令牌绑定用户/仓/基线，伪造 Skill id 不能下单", async () => {
  const repo = repository("guard", [
    { root: ".pi", name: "guard-rules", marker: "GUARD-MARKER" },
  ]);
  const taskService = service(mfcTemp("mfc-skill-guard-data-"));
  const catalog = await taskService.scanRepositorySkills({
    repositories: [repo], baseline: "master", account: "alice",
  });
  assert.throws(() => taskService.create("伪造选择", {
    account: "bob",
    repo,
    ticket: "REQ20260002",
    baseline: "master",
    repositorySkillCatalogToken: catalog.catalog_token,
    selectedRepositorySkillIds: ["forged"],
  }), /不属于当前登录用户/);

  const own = await taskService.scanRepositorySkills({
    repositories: [repo], baseline: "master", account: "alice",
  });
  assert.throws(() => taskService.create("伪造选择", {
    account: "alice",
    repo,
    ticket: "REQ20260003",
    baseline: "master",
    repositorySkillCatalogToken: own.catalog_token,
    selectedRepositorySkillIds: ["forged"],
  }), /不存在或不可/);
});

test("宿主 Skill 以 Pi 解析的 frontmatter name 拦截仓内同名选择", async () => {
  const repo = repository("host-conflict", [
    { root: ".agents", name: "domain-api", marker: "REPOSITORY-DOMAIN-API" },
  ]);
  const dataDir = mfcTemp("mfc-skill-host-conflict-");
  const hostDirectory = join(dataDir, "skills", "legacy-folder-alias");
  mkdirSync(hostDirectory, { recursive: true });
  writeFileSync(join(hostDirectory, "SKILL.md"), [
    "---",
    "name: domain-api",
    "description: HOST-DOMAIN-API",
    "---",
    "",
    "宿主正文",
    "",
  ].join("\n"));
  const taskService = service(dataDir);

  const catalog = await taskService.scanRepositorySkills({
    repositories: [repo], baseline: "master", account: "dev",
  });
  const discovered = catalog.repositories[0].skills[0];
  assert.equal(discovered.name, "domain-api");
  assert.equal(discovered.selectable, false);
  assert.match(discovered.warning ?? "", /与平台常驻 Skill 同名/);
  assert.throws(() => taskService.create("不能选择被宿主覆盖的能力", {
    account: "dev",
    repo,
    ticket: "REQ20260009",
    baseline: "master",
    repositorySkillCatalogToken: catalog.catalog_token,
    selectedRepositorySkillIds: [discovered.id],
  }), /不存在或不可由 Agent 自主使用/);
});

test("宿主 Skill 解析失败时不拿目录名误拦仓内 Skill", async () => {
  const repo = repository("broken-host-skill", [
    { root: ".agents", name: "domain-api", marker: "VALID-REPOSITORY-SKILL" },
  ]);
  const dataDir = mfcTemp("mfc-skill-broken-host-");
  const hostDirectory = join(dataDir, "skills", "domain-api");
  mkdirSync(hostDirectory, { recursive: true });
  // Pi 对缺 description 的 SKILL.md 不加载；catalog 必须使用同一个
  // 结果，不能自行拿目录名兜底后把有效仓内 Skill 错判为常驻同名。
  writeFileSync(join(hostDirectory, "SKILL.md"), [
    "---",
    "name: domain-api",
    "---",
    "",
    "缺少 description",
    "",
  ].join("\n"));
  const taskService = service(dataDir);

  const catalog = await taskService.scanRepositorySkills({
    repositories: [repo], baseline: "master", account: "dev",
  });
  const discovered = catalog.repositories[0].skills[0];
  assert.equal(discovered.name, "domain-api");
  assert.equal(discovered.selectable, true);
  assert.equal(discovered.warning, undefined);
});

test("跨仓拆出的子任务只继承自己仓库的 Skill", async () => {
  const repoA = repository("a", [
    { root: ".agents", name: "same-name", marker: "A-MARKER" },
  ]);
  const repoB = repository("b", [
    { root: ".agents", name: "same-name", marker: "B-MARKER" },
  ]);
  const taskService = service(mfcTemp("mfc-skill-chain-data-"));
  const catalog = await taskService.scanRepositorySkills({
    repositories: [repoA, repoB], baseline: "master", account: "dev",
  });
  const ids = catalog.repositories.flatMap((item) => item.skills.map((skill) => skill.id));
  const parent = taskService.create("跨仓修改", {
    account: "dev",
    repos: [repoA, repoB],
    ticket: "REQ20260004",
    baseline: "master",
    repositorySkillCatalogToken: catalog.catalog_token,
    selectedRepositorySkillIds: ids,
  });
  const state = (taskService as any).tasks.get(parent.id);
  state.cwd = join(parent.workspace, "repositories");
  const artifactDirectory = join(
    state.cwd, ".mae-flow-work", "REQ20260004");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(artifactDirectory, "CHAIN-REQ20260004.md"),
    "# 已确认跨仓方案\n");
  state.summary.requirement_graph = {
    stage: "confirmed",
    repositories: [
      { id: "repo-1", name: "a", url: repoA, responsibility: "A" },
      { id: "repo-2", name: "b", url: repoB, responsibility: "B" },
    ],
    dependencies: [],
  };
  (taskService as any).createRepositoryDeliveries(state);
  const children = taskService.list().filter((item) => item.parent_task_id === parent.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.repository_skills?.length, 1);
    assert.equal(child.repository_skills?.[0].repository, child.repo_url);
  }
});

test("旧跨仓父任务恢复拆单保持 undefined，子任务仍把本仓 Skill 交给 Pi", async () => {
  const repoA = repository("legacy-a", [
    { root: ".agents", name: "legacy-a-guide", marker: "LEGACY-A-SKILL" },
  ]);
  const repoB = repository("legacy-b", [
    { root: ".pi", name: "legacy-b-guide", marker: "LEGACY-B-SKILL" },
  ]);
  const dataDir = mfcTemp("mfc-skill-legacy-chain-");
  const originalService = service(dataDir);
  const parent = originalService.create("恢复旧跨仓任务并继续拆单", {
    account: "dev",
    repos: [repoA, repoB],
    ticket: "REQ20260010",
    baseline: "master",
  });
  const originalState = (originalService as any).tasks.get(parent.id);
  const analysisRoot = join(parent.workspace, "repositories");
  const artifactDirectory = join(
    analysisRoot, ".mae-flow-work", "REQ20260010");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(artifactDirectory, "CHAIN-REQ20260010.md"),
    "# 旧任务已确认的跨仓方案\n");
  originalState.cwd = analysisRoot;
  originalState.summary.status = "waiting_for_human";
  delete originalState.summary.repository_skills;
  originalState.summary.requirement_graph = {
    stage: "confirmed",
    repositories: [
      { id: "repo-1", name: "legacy-a", url: repoA, responsibility: "A" },
      { id: "repo-2", name: "legacy-b", url: repoB, responsibility: "B" },
    ],
    dependencies: [],
  };
  (originalService as any).persist(originalState);
  const oldTaskJson = JSON.parse(readFileSync(
    join(parent.workspace, "task.json"), "utf-8"));
  assert.equal("repository_skills" in oldTaskJson.summary, false,
    "测试现场必须真的是升级前缺字段的任务");

  const model = new ScriptedModelServer([{ text: "已读取旧任务能力目录。" }]);
  await model.start();
  const recoveredService = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 0,
    host: { kernelRoot: KERNEL },
    delivery: { platformUrl: "http://127.0.0.1:1" },
  });
  const childIds: string[] = [];
  try {
    assert.deepEqual(recoveredService.recover(), { restored: 1, requeued: 0 });
    const recoveredParent = (recoveredService as any).tasks.get(parent.id);
    assert.equal(recoveredParent.summary.repository_skills, undefined);
    (recoveredService as any).createRepositoryDeliveries(recoveredParent);

    const children = recoveredService.list()
      .filter((item) => item.parent_task_id === parent.id);
    childIds.push(...children.map((item) => item.id));
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.equal(child.repository_skills, undefined,
        "旧父任务拆出的子任务不能把缺字段归一化为空数组");
      const persisted = JSON.parse(readFileSync(
        join(child.workspace, "task.json"), "utf-8"));
      assert.equal("repository_skills" in persisted.summary, false);
    }

    // 让队首的 A 子任务走正式 TaskService launch；selected=undefined 会
    // 触发旧版兼容发现，随后快照路径必须真进入 Pi 的系统能力目录。
    (recoveredService as any).options.maxConcurrent = 1;
    await (recoveredService as any).pump();
    await until(() => model.requests.length > 0, "Pi 收到旧子任务首个请求");
    (recoveredService as any).options.maxConcurrent = 0;
    const firstRequest = JSON.stringify(model.requests[0]);
    assert.match(firstRequest, /LEGACY-A-SKILL/);
    assert.ok(!firstRequest.includes("LEGACY-B-SKILL"),
      "单仓子任务不得顺带加载另一个仓的旧 Skill");
  } finally {
    (recoveredService as any).options.maxConcurrent = 0;
    for (const id of childIds) {
      await recoveredService.cancel(id, "测试清理").catch(() => undefined);
    }
    await recoveredService.cancel(parent.id, "测试清理").catch(() => undefined);
    await model.stop();
  }
});

test("Chain 检视决定可更新按仓 Skill，先落盘再生成子任务", async () => {
  const repoA = repository("review-a", [
    { root: ".agents", name: "review-a-guide", marker: "REVIEW-A" },
  ]);
  const repoB = repository("review-b", [
    { root: ".pi", name: "review-b-guide", marker: "REVIEW-B" },
  ]);
  const taskService = service(mfcTemp("mfc-skill-review-data-"));
  const parent = taskService.create("跨仓方案先分析、检视时再选能力", {
    account: "dev",
    repos: [repoA, repoB],
    ticket: "REQ20260007",
    baseline: "master",
  });
  const state = (taskService as any).tasks.get(parent.id);
  state.cwd = join(parent.workspace, "repositories");
  mkdirSync(state.cwd, { recursive: true });
  const artifactDirectory = join(
    state.cwd, ".mae-flow-work", "REQ20260007");
  mkdirSync(artifactDirectory, { recursive: true });
  writeRequirementArtifacts(artifactDirectory, "REQ20260007",
    "# 已确认跨仓方案\n", {
    repository_assessments: [
      { name: "review-a", url: repoA, outcome: "change_required", reason: "A" },
      { name: "review-b", url: repoB, outcome: "change_required", reason: "B" },
    ],
    repositories: [
      { id: "repo-1", name: "review-a", url: repoA, responsibility: "A",
        scope: { name: "A 模块", paths: ["src/a/"] } },
      { id: "repo-2", name: "review-b", url: repoB, responsibility: "B",
        scope: { name: "B 模块", paths: ["src/b/"] } },
    ],
    dependencies: [],
  });
  const waiting = state.humanGate.createWaiting({
    taskId: parent.id,
    step: "requirement-analysis",
    callId: "chain-review",
    questionInput: {
      questions: [{
        question: "检视方案与依赖图",
        options: ["需要修改", "确认并生成任务"],
      }],
    },
  });
  state.summary.status = "waiting_for_human";
  state.summary.waiting = waiting;

  const catalog = await taskService.scanRepositorySkills({
    repositories: [repoA, repoB], baseline: "master", account: "dev",
  });
  const selectedIds = catalog.repositories.flatMap(
    (item) => item.skills.map((skill) => skill.id));
  const confirmed = await taskService.decide(parent.id, {
    state_version: waiting.state_version,
    decision: "确认并生成任务",
    repository_skill_catalog_token: catalog.catalog_token,
    selected_repository_skill_ids: selectedIds,
  });

  assert.equal(confirmed.status, "coordinating");
  const persisted = JSON.parse(readFileSync(
    join(parent.workspace, "task.json"), "utf-8"));
  assert.deepEqual(
    persisted.summary.repository_skills.map((skill: any) => skill.name).sort(),
    ["review-a-guide", "review-b-guide"],
  );
  const children = taskService.list()
    .filter((item) => item.parent_task_id === parent.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.repository_skills?.length, 1);
    assert.equal(child.repository_skills?.[0].repository, child.repo_url);
  }
});

test("Chain 检视按成功仓覆盖选择，扫描失败仓保留原 Skill", async () => {
  const repoA = repository("merge-a", [
    { root: ".agents", name: "merge-a-old", marker: "MERGE-A-OLD" },
    { root: ".agents", name: "merge-a-new", marker: "MERGE-A-NEW" },
    ...Array.from({ length: 18 }, (_, index) => ({
      root: ".agents" as const,
      name: `merge-a-extra-${index + 1}`,
      marker: `MERGE-A-EXTRA-${index + 1}`,
    })),
  ]);
  const repoB = repository("merge-b", [
    { root: ".pi", name: "merge-b-keep", marker: "MERGE-B-KEEP" },
  ]);
  const repoC = repository("merge-c", [
    { root: ".cac", name: "merge-c-clear", marker: "MERGE-C-CLEAR" },
  ]);
  const taskService = service(mfcTemp("mfc-skill-merge-data-"));
  const initialCatalog = await taskService.scanRepositorySkills({
    repositories: [repoA, repoB, repoC], baseline: "master", account: "dev",
  });
  const initialIds = [
    initialCatalog.repositories[0].skills.find(
      (skill) => skill.name === "merge-a-old")!.id,
    initialCatalog.repositories[1].skills.find(
      (skill) => skill.name === "merge-b-keep")!.id,
    initialCatalog.repositories[2].skills.find(
      (skill) => skill.name === "merge-c-clear")!.id,
  ];
  const parent = taskService.create("跨仓检视按仓更新能力", {
    account: "dev",
    repos: [repoA, repoB, repoC],
    ticket: "REQ20260008",
    baseline: "master",
    repositorySkillCatalogToken: initialCatalog.catalog_token,
    selectedRepositorySkillIds: initialIds,
  });
  const originalB = parent.repository_skills!.find(
    (skill) => skill.repository === repoB)!;
  const state = (taskService as any).tasks.get(parent.id);
  state.cwd = join(parent.workspace, "repositories");
  mkdirSync(state.cwd, { recursive: true });
  const artifactDirectory = join(
    state.cwd, ".mae-flow-work", "REQ20260008");
  mkdirSync(artifactDirectory, { recursive: true });
  writeRequirementArtifacts(artifactDirectory, "REQ20260008",
    "# 已确认跨仓方案\n", {
    repository_assessments: [
      { name: "merge-a", url: repoA, outcome: "change_required", reason: "A" },
      { name: "merge-b", url: repoB, outcome: "change_required", reason: "B" },
      { name: "merge-c", url: repoC, outcome: "change_required", reason: "C" },
    ],
    repositories: [
      { id: "repo-1", name: "merge-a", url: repoA, responsibility: "A",
        scope: { name: "A 模块", paths: ["src/a/"] } },
      { id: "repo-2", name: "merge-b", url: repoB, responsibility: "B",
        scope: { name: "B 模块", paths: ["src/b/"] } },
      { id: "repo-3", name: "merge-c", url: repoC, responsibility: "C",
        scope: { name: "C 模块", paths: ["src/c/"] } },
    ],
    dependencies: [],
  });
  const waiting = state.humanGate.createWaiting({
    taskId: parent.id,
    step: "requirement-analysis",
    callId: "chain-merge-review",
    questionInput: {
      questions: [{
        question: "检视方案与依赖图",
        options: ["需要修改", "确认并生成任务"],
      }],
    },
  });
  state.summary.status = "waiting_for_human";
  state.summary.waiting = waiting;

  // 模拟 B 仓在检视时临时不可访问；A/C 仍可正常读取。
  renameSync(repoB, `${repoB}-offline`);
  const reviewCatalog = await taskService.scanRepositorySkills({
    repositories: [repoA, repoB, repoC], baseline: "master", account: "dev",
  });
  assert.equal(reviewCatalog.repositories[0].error, undefined);
  assert.ok(reviewCatalog.repositories[1].error);
  assert.equal(reviewCatalog.repositories[2].error, undefined);
  const newA = reviewCatalog.repositories[0].skills.find(
    (skill) => skill.name === "merge-a-new")!;

  // 成功仓本次选 20 项、失败 B 仓还要保留 1 项时，
  // 必须按合并后总数拒绝；校验失败也不消费令牌。
  await assert.rejects(taskService.decide(parent.id, {
    state_version: waiting.state_version,
    decision: "确认并生成任务",
    repository_skill_catalog_token: reviewCatalog.catalog_token,
    selected_repository_skill_ids: reviewCatalog.repositories[0].skills
      .map((skill) => skill.id),
  }), /最多选择 20 个仓内 Skill/);

  const confirmed = await taskService.decide(parent.id, {
    state_version: waiting.state_version,
    decision: "确认并生成任务",
    repository_skill_catalog_token: reviewCatalog.catalog_token,
    // A 从 old 覆盖为 new；C 本次无 ID，因此显式清空。
    selected_repository_skill_ids: [newA.id],
  });

  assert.equal(confirmed.status, "coordinating");
  const persisted = JSON.parse(readFileSync(
    join(parent.workspace, "task.json"), "utf-8"));
  assert.deepEqual(
    persisted.summary.repository_skills.map((skill: any) => skill.name),
    ["merge-a-new", "merge-b-keep"],
  );
  const persistedB = persisted.summary.repository_skills.find(
    (skill: any) => skill.repository === repoB);
  assert.deepEqual(persistedB, originalB,
    "B 扫描失败时应原样保留父任务旧 Skill");

  const children = taskService.list()
    .filter((item) => item.parent_task_id === parent.id);
  assert.equal(children.length, 3);
  assert.deepEqual(children.find((item) => item.repo_url === repoA)
    ?.repository_skills?.map((skill) => skill.name), ["merge-a-new"]);
  assert.deepEqual(children.find((item) => item.repo_url === repoB)
    ?.repository_skills?.map((skill) => skill.name), ["merge-b-keep"]);
  assert.deepEqual(children.find((item) => item.repo_url === repoC)
    ?.repository_skills?.map((skill) => skill.name), []);
});

test("HTTP 显式选择保持兼容；未选择时等待 Git 现场原生发现", async () => {
  const repo = repository("http", [
    { root: ".agents", name: "http-api", marker: "HTTP-MARKER" },
  ]);
  const dataDir = mfcTemp("mfc-skill-http-data-");
  // 技术栈确认是新任务硬契约:栈须在库(requireTechnologyStacks),先种。
  seedTechnologyStacks(dataDir, ["javascript"]);
  const taskService = service(dataDir);
  const server = createTaskServer(taskService);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const scanned = await fetch(`${base}/repository-skills/scan`, {
      method: "POST",
      body: JSON.stringify({ repositories: [repo], baseline: "master" }),
    });
    const scannedText = await scanned.text();
    assert.equal(scanned.status, 200, scannedText);
    const catalog = JSON.parse(scannedText) as any;
    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        requirement: "HTTP 任务",
        title: "HTTP 任务",
        repo,
        ticket: "REQ20260005",
        baseline: "master",
        repository_profiles: [{
          repository: repo, technologies: ["javascript"], confirmed: true,
        }],
        repository_skill_catalog_token: catalog.catalog_token,
        selected_repository_skill_ids: [catalog.repositories[0].skills[0].id],
      }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const task = JSON.parse(createdText) as any;
    assert.equal(task.repository_skills[0].name, "http-api");

    const plain = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        requirement: "不选 Skill",
        title: "不选 Skill",
        repo,
        ticket: "REQ20260006",
        baseline: "master",
      }),
    });
    const plainText = await plain.text();
    assert.equal(plain.status, 201, plainText);
    assert.equal("repository_skills" in (JSON.parse(plainText) as any), false);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
