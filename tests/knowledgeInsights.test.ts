import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  buildTeamKnowledgeInsights,
  type KnowledgeInsightTask,
} from "../src/knowledgeInsights.ts";
import type { TaskKnowledgeUsage } from "../src/knowledgeTrace.ts";
import type { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

function usage(options: {
  id: string;
  name: string;
  path: string;
  kind?: "document" | "skill" | "rules";
  selected?: boolean;
  loaded?: number;
  reads?: number;
  scope?: "team" | "module";
  repository?: string | null;
}): TaskKnowledgeUsage {
  const loaded = options.loaded ?? 1;
  const reads = options.reads ?? 0;
  return {
    summary: {
      resources: 1,
      loaded: loaded > 0 ? 1 : 0,
      used: loaded > 0 || reads > 0 ? 1 : 0,
      skills_used: options.kind === "skill" && reads > 0 ? 1 : 0,
      selected_unused: options.selected && options.kind === "skill" && !reads ? 1 : 0,
    },
    resources: [{
      id: options.id,
      kind: options.kind ?? "document",
      name: options.name,
      path: options.path,
      ...(options.repository === null ? {}
        : { repository: options.repository
            ?? "https://code.example/team/orders.git" }),
      ...(options.scope ? { scope: options.scope } : {}),
      selected: options.selected,
      state: reads > 0 ? "used" : loaded > 0 ? "loaded" : "available",
      available_count: 0,
      loaded_count: loaded,
      read_count: reads,
      last_at: "2026-08-24T08:00:00.000Z",
    }],
    events: [],
  };
}

test("业务仓 Skill 只留在仓库任务现场，不进入团队知识聚合", () => {
  const tasks: KnowledgeInsightTask[] = [
    { id: "task-1", status: "completed", repository_skills: [],
      knowledge_usage: usage({ id: "v1", kind: "skill", name: "订单构建", path: ".agents/skills/build/SKILL.md", reads: 2 }) },
    { id: "task-2", status: "verifying", repository_skills: [],
      delivery: { loop: { round: 1, kind: "ci", state: "repairing" } },
      knowledge_usage: usage({ id: "v2", kind: "skill", name: "订单构建指南", path: ".agents/skills/build/SKILL.md", reads: 1 }) },
    { id: "legacy", status: "completed" },
  ];
  const result = buildTeamKnowledgeInsights(tasks, new Date("2026-08-24T09:00:00Z"));
  assert.equal(result.summary.tracked_tasks, 0);
  assert.deepEqual(result.resources, []);
  assert.deepEqual(result.recommendations, []);
});

test("团队宿主 Skill 按名称跨旧路径、快照版本合并且每任务只计一次", () => {
  const resource = (path: string, reads: number, selected = false) => ({
    id: `skill:java-autout:${path}`,
    kind: "skill" as const,
    name: "java-autout",
    path,
    selected,
    state: reads > 0 ? "used" as const : "loaded" as const,
    available_count: 1,
    loaded_count: 1,
    read_count: reads,
    last_at: "2026-08-29T08:00:00.000Z",
  });
  const tasks: KnowledgeInsightTask[] = [{
    id: "legacy", status: "completed", repository_skills: [],
    knowledge_usage: {
      summary: { resources: 1, loaded: 1, used: 1, skills_used: 1,
        selected_unused: 0 },
      resources: [resource("宿主技能/java-autout/SKILL.md", 1)],
      events: [],
    },
  }, {
    id: "snapshot-v1", status: "completed", repository_skills: [],
    knowledge_usage: {
      summary: { resources: 2, loaded: 2, used: 2, skills_used: 2,
        selected_unused: 0 },
      // 同一任务即使在升级边界留下两个路径，也只能贡献一个任务数；
      // 两次真实读取仍都属于访问事件。
      resources: [
        resource(".mae-flow-work/host-skills/111111/SKILL.md", 2, true),
        resource("宿主技能/java-autout/SKILL.md", 1, true),
      ],
      events: [],
    },
  }, {
    id: "snapshot-v2", status: "running", repository_skills: [],
    knowledge_usage: {
      summary: { resources: 1, loaded: 1, used: 1, skills_used: 1,
        selected_unused: 0 },
      resources: [resource(
        ".mae-flow-work/host-skills/222222/SKILL.md", 3)],
      events: [],
    },
  }];

  const result = buildTeamKnowledgeInsights(tasks);
  assert.equal(result.resources.length, 1,
    "旧虚拟路径和不同版本哈希都属于同一个团队 Skill");
  assert.deepEqual(result.resources[0], {
    key: "team\0skill\0java-autout",
    kind: "skill",
    name: "java-autout",
    path: "宿主技能/java-autout/SKILL.md",
    repository: undefined,
    scope: "team",
    provided_tasks: 3,
    selected_tasks: 1,
    loaded_tasks: 3,
    accessed_tasks: 3,
    access_events: 7,
    completed_tasks: 2,
    repair_tasks: 0,
    attention_tasks: 0,
    last_used_at: "2026-08-29T08:00:00.000Z",
  });
});

test("飞轮给出覆盖缺口、选而未用和正向沉淀建议", () => {
  const unused = usage({ id: "skill", kind: "skill", name: "发布助手",
    path: ".mae-flow-work/host-skills/release/SKILL.md", selected: true,
    reads: 0, scope: "team", repository: null });
  const proven = usage({ id: "repository-skill", kind: "skill", name: "交付检查",
    path: ".mae-flow-work/host-skills/delivery/SKILL.md", reads: 1,
    scope: "team", repository: null });
  const tasks: KnowledgeInsightTask[] = [
    { id: "gap", status: "paused", knowledge_usage: usage({
      id: "team-gap", kind: "skill", name: "待读取团队 Skill",
      path: ".mae-flow-work/host-skills/gap/SKILL.md", loaded: 0, reads: 0,
      scope: "team", repository: null,
    }) },
    { id: "unused-1", status: "running", repository_skills: [{}], knowledge_usage: unused },
    { id: "unused-2", status: "running", repository_skills: [{}], knowledge_usage: unused },
    ...[1, 2, 3].map((index): KnowledgeInsightTask => ({
      id: `done-${index}`, status: "completed",
      knowledge_usage: proven,
    })),
  ];
  const result = buildTeamKnowledgeInsights(tasks);
  assert.equal(result.summary.tracked_tasks, 6);
  assert.equal(result.summary.accessed_tasks, 3);
  assert.equal(result.summary.selected_unused, 1);
  assert.ok(result.recommendations.some((item) =>
    item.kind === "coverage-gap" && item.task_ids?.includes("gap")));
  assert.ok(result.recommendations.some((item) => item.kind === "selected-unused"));
  assert.ok(result.recommendations.some((item) => item.kind === "promote"));
});

test("小样本只展示事实，不强行生成资源优劣结论", () => {
  const result = buildTeamKnowledgeInsights([{
    id: "task-1", status: "running",
    knowledge_usage: usage({ id: "one", name: "单次知识", path: "docs/one.md", reads: 1 }),
  }]);
  assert.equal(result.summary.opportunities, 0);
  assert.deepEqual(result.recommendations, []);
});

test("只有正式模块文档进入团队飞轮，任务 docs 与项目规则继续留在仓库现场", () => {
  const moduleUsage: TaskKnowledgeUsage = {
    summary: { resources: 3, loaded: 0, used: 3, skills_used: 0, selected_unused: 0 },
    resources: [{
      id: "module:orders:state:v3", kind: "document", name: "订单状态机",
      path: ".mae-flow-work/business-modules/orders/state.md",
      scope: "module", module_id: "orders", module_name: "订单域",
      asset_version: 3, selected: true, state: "used",
      available_count: 1, loaded_count: 0, read_count: 2,
    }, {
      id: "observed:task-doc", kind: "document", name: "本需求设计",
      path: "docs/requirement.md", state: "used",
      available_count: 0, loaded_count: 0, read_count: 1,
    }, {
      id: "rules:orders", kind: "rules", name: "AGENTS.md",
      path: "AGENTS.md", repository: "https://code.example/orders.git",
      state: "used", available_count: 1, loaded_count: 1, read_count: 2,
    }],
    events: [],
  };
  const result = buildTeamKnowledgeInsights([{
    id: "task-module", status: "completed", business_modules: [{}],
    knowledge_usage: moduleUsage,
  }]);
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].name, "订单状态机");
  assert.equal(result.resources[0].scope, "module");
  assert.equal(result.resources[0].module_name, "订单域");
  assert.ok(!result.resources.some((item) => item.name === "本需求设计"));
  assert.ok(!result.resources.some((item) => item.kind === "rules"),
    "项目规则可以留在本单足迹，但绝不能出现在团队资产聚合中");
});

test("团队知识效能使用独立只读 HTTP 接口", async () => {
  const expected = buildTeamKnowledgeInsights([],
    new Date("2026-08-24T09:00:00Z"));
  const service = { knowledgeInsights: () => expected } as TaskService;
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/knowledge-insights`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});

/** 飞轮第 3 步:货架效果账。宿主 skill 按 name 跨版本关联(path 带
 * 版本 key 不能当键);prepush 口径:passed 首轮=一次过,repairing/
 * blocked=首轮失败,environment_error 不计任何 skill 的账。 */
function hostSkillTask(options: {
  id: string;
  skills: Array<{ name: string; reads: number }>;
  prepush?: { state: string; round: number };
  repairRound?: number;
}): KnowledgeInsightTask {
  return {
    id: options.id,
    status: "completed",
    knowledge_usage: {
      summary: {
        resources: options.skills.length,
        loaded: 0,
        used: options.skills.filter((item) => item.reads > 0).length,
        skills_used: options.skills.filter((item) => item.reads > 0).length,
        selected_unused: 0,
      },
      resources: options.skills.map((skill) => ({
        id: `skill:${skill.name}`,
        kind: "skill" as const,
        name: skill.name,
        path: `.mae-flow-work/host-skills/deadbeef1234/SKILL.md`,
        state: skill.reads > 0 ? "used" as const : "available" as const,
        available_count: 1,
        loaded_count: 0,
        read_count: skill.reads,
      })),
      events: [],
    },
    delivery: {
      ...(options.prepush ? { prepush: options.prepush } : {}),
      ...(options.repairRound ? { loop: { round: options.repairRound } } : {}),
    },
  };
}

test("货架效果账:消费率、prepush 一次过对照与修订信号", async () => {
  const { buildHostSkillEffects } = await import("../src/knowledgeInsights.ts");
  const effects = buildHostSkillEffects([
    // java-autout:读了且首轮一次过。
    hostSkillTask({ id: "t1", skills: [{ name: "java-autout", reads: 2 }],
      prepush: { state: "passed", round: 1 } }),
    // 读了,修了三轮才过,且有修复环记录。
    hostSkillTask({ id: "t2", skills: [{ name: "java-autout", reads: 1 }],
      prepush: { state: "passed", round: 3 }, repairRound: 1 }),
    // 没读但一次过:进对照组。
    hostSkillTask({ id: "t3", skills: [{ name: "java-autout", reads: 0 }],
      prepush: { state: "passed", round: 1 } }),
    // 基础设施故障:不计任何账。
    hostSkillTask({ id: "t4", skills: [{ name: "java-autout", reads: 0 }],
      prepush: { state: "environment_error", round: 1 } }),
    // ghost 上架 3 单无人读:低消费信号。
    hostSkillTask({ id: "t5", skills: [{ name: "ghost", reads: 0 }] }),
    hostSkillTask({ id: "t6", skills: [{ name: "ghost", reads: 0 }] }),
    hostSkillTask({ id: "t7", skills: [{ name: "ghost", reads: 0 }] }),
    // flaky 读 2 单全返修:高摩擦信号。
    hostSkillTask({ id: "t8", skills: [{ name: "flaky", reads: 1 }],
      prepush: { state: "blocked", round: 2 }, repairRound: 2 }),
    hostSkillTask({ id: "t9", skills: [{ name: "flaky", reads: 1 }],
      repairRound: 1 }),
  ]);

  const autout = effects.get("java-autout")!;
  assert.equal(autout.provided_tasks, 4);
  assert.equal(autout.accessed_tasks, 2);
  assert.equal(autout.access_events, 3);
  assert.equal(autout.repair_tasks, 1);
  assert.deepEqual(
    [autout.prepush_first_pass, autout.prepush_measured], [1, 2],
    "读过的:t1 一次过,t2 三轮过;t4 环境故障不计账");
  assert.deepEqual(
    [autout.baseline_first_pass, autout.baseline_measured], [1, 2],
    "对照组=没读它但有结论的:t3 一次过 + t8(blocked=首轮失败)");
  assert.equal(autout.signal, undefined, "有人读且不高摩擦,不出信号");

  const ghost = effects.get("ghost")!;
  assert.equal(ghost.signal, "low-consumption");
  assert.match(String(ghost.signal_evidence), /3 个任务装载/);

  const flaky = effects.get("flaky")!;
  assert.equal(flaky.signal, "high-friction");
  assert.equal(flaky.repair_tasks, 2);
});

test("任务自己的 document 不进入团队知识聚合", () => {
  const result = buildTeamKnowledgeInsights([{
    id: "requirement-task",
    status: "completed",
    knowledge_usage: usage({
      id: "requirement", kind: "document", name: "REQ-1001 需求说明",
      path: "docs/REQ-1001.md", reads: 3,
    }),
  }]);
  assert.equal(result.summary.tracked_tasks, 0,
    "只有任务文档的单不应稀释团队知识使用率");
  assert.deepEqual(result.resources, []);
  assert.deepEqual(result.recommendations, []);
});

test("聚合保留可复用资源描述:可读性字段不许在聚合层丢失", () => {
  const result = buildTeamKnowledgeInsights([{
    id: "t1",
    status: "completed",
    knowledge_usage: {
      summary: { resources: 1, loaded: 1, used: 1, skills_used: 0,
        selected_unused: 0 },
      resources: [{
        id: "skill-1", kind: "skill", name: "订单对接",
        path: ".mae-flow-work/host-skills/orders/SKILL.md",
        scope: "team",
        description: "订单域的对接说明与重试口径",
        state: "used", available_count: 1, loaded_count: 1, read_count: 2,
      }],
      events: [],
    },
  }]);
  assert.equal(result.resources[0].description, "订单域的对接说明与重试口径");
});
