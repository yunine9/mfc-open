import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  createBusinessModule,
  publishBusinessKnowledgeAsset,
} from "../src/businessModuleLibrary.ts";
import { createTaskServer } from "../src/server.ts";
import {
  availableUtGenerationMethod,
  TaskService,
} from "../src/taskService.ts";
import { WorkflowAssetLibrary } from "../src/workflowAssetLibrary.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import { mfcTemp } from "./mfcTmp.ts";

function service(dataDir: string): TaskService {
  return new TaskService({
    dataDir, provider: "test", model: "test-1", maxConcurrent: 0,
    modelsJson: { providers: { test: { models: [{ id: "test-1" }] } } },
    host: { kernelRoot: "/tmp", repoPath: "/tmp/fixed-demo-repo" },
    delivery: { platformUrl: "http://127.0.0.1:1" },
  });
}

function profile(technologies: string[]) {
  return [{ repository: "https://code.example/team/orders.git",
    technologies, confirmed: true }];
}

test("UT 生成方式只看本任务实际装载的 Skill，不受全局货架干扰", () => {
  assert.equal(availableUtGenerationMethod(["AutoUT"]), "AutoUT");
  assert.equal(availableUtGenerationMethod(["java-autout", "AutoUT"]),
    "java-autout");
  assert.equal(availableUtGenerationMethod(["unrelated-build"]), "仓内既有写法");
});

test("新任务每个代码仓都必须有非空技术画像，拒绝时不产生任务现场",
  async () => {
    const dataDir = mfcTemp("mfc-launch-profile-required-");
    const repository = mfcTemp("mfc-profile-required-repo-");
    execFileSync("git", ["init", "--quiet", "--bare", repository]);
    const taskService = service(dataDir);
    const server = createTaskServer(taskService);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${
      (server.address() as AddressInfo).port}`;
    try {
      const missing = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({ requirement: "C++ 仓新任务", repos: [repository] }),
      });
      assert.equal(missing.status, 400);
      assert.match(await missing.text(), /还没有选择技术栈/);

      const empty = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "不能用空画像绕过",
          repos: [repository],
          repository_profiles: [{
            repository, technologies: [], confirmed: true,
          }],
        }),
      });
      assert.equal(empty.status, 400);
      assert.match(await empty.text(), /还没有选择技术栈/);
      assert.deepEqual(taskService.list(), []);
      assert.equal(existsSync(join(dataDir, "task-1")), false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }
  });

function workflowDefinition(moduleId: string, asset: {
  id: string; version: number; digest: string;
}) {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: { standard_id: "test", standard_version: "1",
      catalog_digest: `sha256:${"a".repeat(64)}` },
    applicability: { business_module_ids: [], repositories: [],
      technologies: [] },
    edits: [{
      edit_id: "add-business-knowledge",
      stage_id: "exploration",
      op: "add",
      item: {
        id: "business-knowledge",
        kind: "knowledge",
        title: "订单状态规则",
        locked: false,
        editable: true,
        source: "workflow",
        asset_ref: {
          registry: "business_knowledge",
          business_module_id: moduleId,
          id: asset.id,
          version: String(asset.version),
          digest: asset.digest,
        },
      },
    }],
  };
}

test("工作流引用强制并入业务模块；预览返回管理定位、版本与真正命中交集",
  () => {
    const dataDir = mfcTemp("mfc-launch-authority-flow-");
    createBusinessModule(dataDir, {
      id: "orders", name: "订单域", description: "订单边界", owner: "owner",
      repositories: ["https://code.example/team/orders.git"],
    }, "admin");
    const module = publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束",
      when_to_use: "修改订单状态时", form: "rule",
      repositories: ["https://code.example/team/orders.git"],
      content: "# 订单状态规则\n",
    }, "owner");
    const asset = module.assets.find((item) => item.id === "state")!;
    const taskService = service(dataDir);
    const definition = workflowDefinition("orders", asset);
    const preview = taskService.previewLaunchKnowledge({
      repositories: ["https://code.example/team/orders.git"],
      selectedBusinessModuleIds: [],
      workflowDefinition: definition,
    });
    assert.deepEqual(preview.scope.business_module_ids, ["orders"]);
    assert.deepEqual(preview.scope.workflow_business_module_ids, ["orders"]);
    assert.deepEqual(preview.business_knowledge.map((item) => ({
      module_id: item.module_id,
      id: item.id,
      version: item.version,
      digest: item.digest,
      matched_business_module_ids: item.matched_business_module_ids,
      matched_repositories: item.matched_repositories,
    })), [{
      module_id: "orders",
      id: "state",
      version: 1,
      digest: asset.digest,
      matched_business_module_ids: ["orders"],
      matched_repositories: ["https://code.example/team/orders.git"],
    }]);
  });

test("目录损坏显式返回 source 告警与 degraded，不伪装成零匹配", () => {
  const dataDir = mfcTemp("mfc-launch-authority-degrade-");
  mkdirSync(join(dataDir, "business-modules", "broken"), { recursive: true });
  writeFileSync(join(dataDir, "business-modules", "broken", "module.json"),
    "{broken");
  const preview = service(dataDir).previewLaunchKnowledge({});
  assert.equal(preview.complete, true,
    "可选目录损坏要明确降级，但不能阻塞一项本来不依赖它的任务");
  assert.equal(preview.degraded, true);
  assert.equal(preview.warnings.some((warning) =>
    warning.source === "business_modules"
      && warning.code === "catalog_warning"), true);
});

test("团队 Skill 预览复用快照包验收，坏包不会冒充最终已固定", () => {
  const dataDir = mfcTemp("mfc-launch-authority-skill-");
  const valid = join(dataDir, "skills", "java-review");
  const oversized = join(dataDir, "skills", "oversized");
  mkdirSync(valid, { recursive: true });
  mkdirSync(oversized, { recursive: true });
  writeFileSync(join(valid, "SKILL.md"), [
    "---", "name: java-review", "description: Java review",
    "knowledge_nature: engineering", "technologies: [java]", "---",
    "", "# Review",
  ].join("\n"));
  writeFileSync(join(oversized, "SKILL.md"), [
    "---", "name: oversized", "description: Oversized skill",
    "knowledge_nature: engineering", "technologies: [java]", "---",
    "", "x".repeat(129 * 1024),
  ].join("\n"));
  const taskService = service(dataDir);
  const repositories = [profile([])[0].repository];
  const repositoryProfiles = profile(["java"]);
  const preview = taskService.previewLaunchKnowledge({
    repositories, repositoryProfiles,
  });
  assert.deepEqual(preview.team_skills.map((skill) => skill.path),
    ["java-review/SKILL.md"], JSON.stringify(preview.warnings));
  assert.match(preview.team_skills[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(preview.warnings.some((warning) =>
    warning.source === "team_skills" && /128 KiB/.test(warning.message)), true);
  assert.equal(preview.complete, true,
    "坏的是自动匹配可选包，保留明确告警并固定其余合法 Skill 即可");
  const task = taskService.create("核对团队 Skill", {
    repo: repositories[0],
    repositoryProfiles: repositoryProfiles.map((item) => ({
      ...item, updated_at: new Date().toISOString(), updated_by: "tester",
    })),
    knowledgePreviewDigest: preview.selection_digest,
  });
  assert.deepEqual(task.team_skills?.map((skill) =>
    skill.source_path ?? skill.path),
    preview.team_skills.map((skill) => skill.path));
});

test("知识清单指纹绑定创建：旧清单拒绝且不占 task id，未变化清单放行",
  () => {
    const dataDir = mfcTemp("mfc-launch-authority-digest-");
    createTechnologyStack(dataDir, { id: "java", name: "Java" }, "admin");
    const repository = "https://code.example/team/orders.git";
    createBusinessModule(dataDir, {
      id: "orders", name: "订单域", description: "订单边界", owner: "owner",
      repositories: [repository],
    }, "admin");
    publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束",
      when_to_use: "修改订单状态时", form: "rule",
      repositories: [repository], content: "# 状态规则 v1\n",
    }, "owner");
    const taskService = service(dataDir);
    const repositoryProfiles = [{
      repository, technologies: ["java"], confirmed: true,
      updated_at: new Date().toISOString(), updated_by: "tester",
    }];
    const selection = {
      repositories: [repository],
      selectedBusinessModuleIds: ["orders"],
      repositoryProfiles,
    };
    const stalePreview = taskService.previewLaunchKnowledge(selection);
    assert.equal(stalePreview.complete, true);
    assert.match(stalePreview.selection_digest, /^[a-f0-9]{64}$/);

    publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束 v2",
      when_to_use: "修改订单状态时", form: "rule",
      repositories: [repository], content: "# 状态规则 v2\n",
    }, "owner");
    const refreshedPreview = taskService.previewLaunchKnowledge(selection);
    assert.notEqual(refreshedPreview.selection_digest,
      stalePreview.selection_digest, "知识版本变化必须改变清单指纹");

    assert.throws(() => taskService.create("不能静默换知识", {
      repo: repository,
      selectedBusinessModuleIds: ["orders"],
      repositoryProfiles,
      knowledgePreviewDigest: stalePreview.selection_digest,
    }), /知识清单已变化/);
    assert.deepEqual(taskService.list(), [], "旧指纹不能产生半张任务台账");
    assert.equal(existsSync(join(dataDir, "task-1")), false,
      "指纹校验必须发生在 task id 分配与现场创建之前");

    const task = taskService.create("使用核对过的知识", {
      repo: repository,
      selectedBusinessModuleIds: ["orders"],
      repositoryProfiles,
      knowledgePreviewDigest: refreshedPreview.selection_digest,
    });
    assert.equal(task.id, "task-1", "被拒请求不能消耗任务序号");
    assert.equal(task.business_modules?.[0].assets[0].version, 2);
  });

test("技术画像记忆失败时，本单仍使用已核对画像而不静默缩小匹配范围",
  async () => {
    const dataDir = mfcTemp("mfc-launch-profile-write-");
    createTechnologyStack(dataDir, { id: "java", name: "Java" }, "admin");
    const repository = mfcTemp("mfc-launch-profile-repo-");
    execFileSync("git", ["init", "--quiet", "--bare", repository]);
    const skillRoot = join(dataDir, "skills", "java-review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), ["---", "name: java-review", "description: Java review",
      "knowledge_nature: engineering", "technologies: [java]", "---", "# Java review", "Review Java changes."].join("\n"));
    // profiles.json 故意做成目录，让“记住供下次使用”失败；当前请求的
    // 画像仍然是合法输入，不能因此从 Java 匹配退化成无技术栈。
    mkdirSync(join(dataDir, "repository-profiles", "profiles.json"), {
      recursive: true,
    });
    const taskService = service(dataDir);
    const repositoryProfiles = [{
      repository, technologies: ["java"], confirmed: true,
    }];
    const preview = taskService.previewLaunchKnowledge({
      repositories: [repository], repositoryProfiles,
    });
    assert.deepEqual(preview.team_skills.map((item) => item.name), ["java-review"]);
    const server = createTaskServer(taskService);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${
      (server.address() as AddressInfo).port}`;
    try {
      const unreviewed = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "不能绕过自动匹配清单核对",
          repos: [repository],
          repository_profiles: repositoryProfiles,
        }),
      });
      assert.equal(unreviewed.status, 409,
        "匹配到知识时，直接 POST 不能省略清单指纹");
      assert.match(await unreviewed.text(), /先在发起页核对自动匹配知识/);
      const blankDigest = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "空指纹也不能绕过",
          repos: [repository],
          repository_profiles: repositoryProfiles,
          knowledge_preview_digest: "",
        }),
      });
      assert.equal(blankDigest.status, 400);
      const response = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "沿用本单确认的 Java 技术画像",
          repos: [repository],
          repository_profiles: repositoryProfiles,
          knowledge_preview_digest: preview.selection_digest,
        }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const task = await response.json() as {
        team_skills?: Array<{ name: string }>;
        repository_profiles?: Array<{ technologies: string[] }>;
      };
      assert.deepEqual(task.repository_profiles?.[0].technologies, ["java"]);
      assert.deepEqual(task.team_skills?.map((item) => item.name), ["java-review"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }
  });

test("POST 预匹配由服务端解析已发布 workflow_selection，不创建任务现场",
  async () => {
    const dataDir = mfcTemp("mfc-launch-authority-route-");
    createBusinessModule(dataDir, {
      id: "orders", name: "订单域", description: "订单边界", owner: "owner",
      repositories: ["https://code.example/team/orders.git"],
    }, "admin");
    const module = publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束",
      when_to_use: "修改订单状态时", content: "# 状态规则\n",
    }, "owner");
    const asset = module.assets.find((item) => item.id === "state")!;
    const library = new WorkflowAssetLibrary(dataDir);
    library.create({ id: "order-flow", name: "订单流程", scope: "team",
      owner: "owner", definition: workflowDefinition("orders", asset) });
    library.submitForReview("order-flow", { actor: "owner" });
    library.approve("order-flow", { actor: "admin" });
    const taskService = service(dataDir);
    const server = createTaskServer(taskService);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${
      (server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/launch-knowledge-preview`, {
        method: "POST",
        body: JSON.stringify({
          workflow_selection: { id: "order-flow", version: "v1" },
          selected_business_module_ids: [],
        }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const preview = await response.json() as {
        business_knowledge: Array<{ module_id: string; id: string; version: number }>;
        scope: { workflow_business_module_ids: string[] };
      };
      assert.deepEqual(preview.scope.workflow_business_module_ids, ["orders"]);
      assert.deepEqual(preview.business_knowledge.map((item) => ({
        module_id: item.module_id, id: item.id, version: item.version,
      })), [{
        module_id: "orders", id: "state", version: 1,
      }], "响应必须保留可直达管理位的稳定身份");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }
    assert.deepEqual(taskService.list(), []);
  });
