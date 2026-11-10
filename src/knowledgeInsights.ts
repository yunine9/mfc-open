/**
 * 团队知识飞轮的只读聚合。
 *
 * 输入只来自任务摘要与知识足迹，输出只用于运营观察。这里不修改仓库、
 * 不评价某个内核步骤是否通过，也不把相关性包装成因果关系。
 */

import type {
  KnowledgeKind,
  TaskKnowledgeUsage,
} from "./knowledgeTrace.ts";

export type KnowledgeRecommendationKind =
  | "coverage-gap"
  | "needs-review"
  | "selected-unused"
  | "promote";

export type KnowledgeRecommendationTone = "attention" | "info" | "positive";

export interface KnowledgeInsightResource {
  key: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  /** 可读性:选中资源带仓内扫描的描述,自发读取的文档带观测时抽的
   * 首标题摘要。没有它,排行里就只剩文件名,人没法判断值不值得读。 */
  description?: string;
  repository?: string;
  scope?: "task" | "repository" | "team" | "module";
  module_id?: string;
  module_name?: string;
  asset_version?: number;
  provided_tasks: number;
  selected_tasks: number;
  loaded_tasks: number;
  accessed_tasks: number;
  access_events: number;
  completed_tasks: number;
  repair_tasks: number;
  attention_tasks: number;
  last_used_at?: string;
}

export interface KnowledgeRecommendation {
  id: string;
  kind: KnowledgeRecommendationKind;
  tone: KnowledgeRecommendationTone;
  title: string;
  evidence: string;
  action: string;
  resource_key?: string;
  task_ids?: string[];
}

export interface TeamKnowledgeInsights {
  generated_at: string;
  summary: {
    tracked_tasks: number;
    accessed_tasks: number;
    unique_resources: number;
    active_resources: number;
    selected_unused: number;
    opportunities: number;
    access_rate: number;
  };
  resources: KnowledgeInsightResource[];
  recommendations: KnowledgeRecommendation[];
}

export interface KnowledgeInsightTask {
  id: string;
  status: string;
  repository_skills?: unknown[];
  business_modules?: unknown[];
  knowledge_usage?: TaskKnowledgeUsage;
  focus?: { needs_attention?: boolean };
  delivery?: {
    loop?: {
      round?: number;
      kind?: string;
      state?: string;
    };
    prepush?: {
      state?: string;
      round?: number;
    };
  };
}

/** 货架条目的效果账:消费率 × prepush 一次过对照。只做相关性观察,
 * 不评价内核裁决——read 过的单一次过率明显低于没 read 的,是"内容
 * 可能误导"的修订信号,不是判决书。 */
export interface HostSkillEffect {
  /** 足迹里出现过该 skill(available)的追踪任务数。 */
  provided_tasks: number;
  /** 真 read 过的任务数——货架消费率的分子。 */
  accessed_tasks: number;
  access_events: number;
  /** read 过且随后出现修复信号的任务数。 */
  repair_tasks: number;
  /** read 过且 prepush 有结论(passed/首轮失败)的任务数。 */
  prepush_measured: number;
  /** 其中首轮一次通过的。 */
  prepush_first_pass: number;
  /** 对照组:没 read 该 skill 但 prepush 有结论的追踪任务。 */
  baseline_measured: number;
  baseline_first_pass: number;
  /** 修订信号:low-consumption=上架没人读(描述可能没写清);
   * high-friction=读了仍频繁修复(内容可能过期或误导)。 */
  signal?: "low-consumption" | "high-friction";
  signal_evidence?: string;
}

/** 宿主 skill 在足迹里的形态(sessionDriver 注册规则):kind=skill、
 * 无 repository、path 落在任务内快照目录。path 带版本 key 会随内容
 * 变化,name(pi 装载名,与货架同源)才是跨版本的稳定关联键。 */
function hostSkillName(resource: {
  kind: KnowledgeKind;
  repository?: string;
  path: string;
  name: string;
}): string | undefined {
  if (resource.kind !== "skill" || resource.repository) return undefined;
  return resource.path.startsWith(".mae-flow-work/host-skills/")
      || resource.path.startsWith("宿主技能/")
    ? resource.name : undefined;
}

/** prepush 结论口径:passed 且首轮=一次过;repairing/blocked=首轮
 * 没过(在修或停了都改变不了首轮失败的事实);environment_error 与
 * preparing 不计入——基础设施故障和没跑完不算任何 skill 的账。 */
function prepushVerdict(task: KnowledgeInsightTask): {
  measured: boolean;
  firstPass: boolean;
} {
  const prepush = task.delivery?.prepush;
  const round = prepush?.round ?? 0;
  if (prepush?.state === "passed") {
    return { measured: true, firstPass: round <= 1 };
  }
  if ((prepush?.state === "repairing" || prepush?.state === "blocked")
      && round >= 1) {
    return { measured: true, firstPass: false };
  }
  return { measured: false, firstPass: false };
}

/** 按货架关联键(skill 名)聚合效果账。 */
export function buildHostSkillEffects(
  tasks: KnowledgeInsightTask[],
): Map<string, HostSkillEffect> {
  const effects = new Map<string, HostSkillEffect>();
  let totalMeasured = 0;
  let totalFirstPass = 0;
  const seed = (name: string): HostSkillEffect => {
    const existing = effects.get(name);
    if (existing) return existing;
    const fresh: HostSkillEffect = {
      provided_tasks: 0, accessed_tasks: 0, access_events: 0,
      repair_tasks: 0, prepush_measured: 0, prepush_first_pass: 0,
      baseline_measured: 0, baseline_first_pass: 0,
    };
    effects.set(name, fresh);
    return fresh;
  };
  for (const task of tasks.filter(tracked)) {
    const verdict = prepushVerdict(task);
    if (verdict.measured) {
      totalMeasured += 1;
      if (verdict.firstPass) totalFirstPass += 1;
    }
    const seen = new Set<string>();
    for (const resource of task.knowledge_usage?.resources ?? []) {
      const name = hostSkillName(resource);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const effect = seed(name);
      effect.provided_tasks += 1;
      if (resource.read_count > 0) {
        effect.accessed_tasks += 1;
        effect.access_events += resource.read_count;
        if (repaired(task)) effect.repair_tasks += 1;
        if (verdict.measured) {
          effect.prepush_measured += 1;
          if (verdict.firstPass) effect.prepush_first_pass += 1;
        }
      }
    }
  }
  for (const effect of effects.values()) {
    effect.baseline_measured = totalMeasured - effect.prepush_measured;
    effect.baseline_first_pass = totalFirstPass - effect.prepush_first_pass;
    if (effect.provided_tasks >= 3 && effect.accessed_tasks === 0) {
      effect.signal = "low-consumption";
      effect.signal_evidence = `${effect.provided_tasks} 个任务装载,无一主动读取`
        + `——描述可能没写清何时该用,或内容已无人需要`;
    } else if (effect.accessed_tasks >= 2
        // 严格多数才亮牌:2 读 1 修这种半对半的小样本不贴"待修订",
        // 通用排行的 needs-review 建议(≥半数)仍会提示复核。
        && effect.repair_tasks * 2 > effect.accessed_tasks) {
      effect.signal = "high-friction";
      effect.signal_evidence = `${effect.accessed_tasks} 个任务读取,`
        + `${effect.repair_tasks} 个随后出现修复信号——内容可能过期或误导`
        + `(相关性提示,不是判决)`;
    }
  }
  return effects;
}

function resourceKey(resource: {
  kind: KnowledgeKind;
  name: string;
  path: string;
  repository?: string;
  scope?: string;
  module_id?: string;
}): string {
  if (resource.scope === "module") {
    return ["module", resource.module_id ?? "", resource.kind, resource.path]
      .join("\0");
  }
  // 团队宿主 Skill 会随投影机制和版本产生不同展示路径：老任务是
  // `宿主技能/<name>/SKILL.md`，固定快照后是
  // `.mae-flow-work/host-skills/<version-key>/SKILL.md`。路径只是某次任务
  // 的快照位置，Skill 名才是货架的稳定身份；否则同一资产每更新一次
  // 就会在团队页多出一行。
  const hostName = hostSkillName(resource);
  if (hostName) return ["team", "skill", hostName].join("\0");
  return [resource.repository ?? "", resource.kind, resource.path].join("\0");
}

function displayPath(resource: {
  kind: KnowledgeKind;
  name: string;
  path: string;
  repository?: string;
}): string {
  const hostName = hostSkillName(resource);
  return hostName ? `宿主技能/${hostName}/SKILL.md` : resource.path;
}

function completed(task: KnowledgeInsightTask): boolean {
  return task.status === "completed" || task.status === "await_merge";
}

function repaired(task: KnowledgeInsightTask): boolean {
  const loop = task.delivery?.loop;
  return !!loop && ((loop.round ?? 0) > 0 || !!loop.kind
    || loop.state === "halted" || loop.state === "exhausted");
}

function needsAttention(task: KnowledgeInsightTask): boolean {
  return task.focus?.needs_attention === true
    || task.status === "failed" || task.status === "paused";
}

function tracked(task: KnowledgeInsightTask): boolean {
  return !!task.knowledge_usage
    || task.repository_skills !== undefined
    || task.business_modules !== undefined;
}

/** 团队页只统计有正式团队/模块身份的资产。任务文档与仓库项目规则
 * 都属于各自现场，不能因为一次 read 就晋升成团队知识。业务模块知识
 * 只有经过 Owner 显式发布且带 module scope，才具备稳定复用身份。 */
function reusableResource(resource: {
  kind: KnowledgeKind;
  scope?: string;
  repository?: string;
  path: string;
  name: string;
}): boolean {
  if (resource.scope === "module") {
    return resource.kind === "skill" || resource.kind === "document";
  }
  if (resource.kind !== "skill") return false;
  // Skill 只是文件形态，不等于团队资产。业务仓原生 Skill 带 repository，
  // 只属于该仓任务现场；只有平台团队 Skill（含老任务的宿主快照路径）
  // 才进入团队知识运营。
  return resource.scope === "team" || !!hostSkillName(resource);
}

function teamTracked(task: KnowledgeInsightTask): boolean {
  return (task.business_modules?.length ?? 0) > 0
    || (task.knowledge_usage?.resources.some(reusableResource) ?? false);
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function recommendations(
  resources: KnowledgeInsightResource[],
  frictionWithoutAccess: string[],
): KnowledgeRecommendation[] {
  const result: KnowledgeRecommendation[] = [];
  if (frictionWithoutAccess.length) {
    result.push({
      id: "coverage-gap",
      kind: "coverage-gap",
      tone: "attention",
      title: "返工或关注任务缺少主动知识访问",
      evidence: `${frictionWithoutAccess.length} 个任务出现修复或人工关注信号，`
        + "但没有观察到 Agent 主动读取业务知识。",
      action: "回看共同问题：仓库现场可补参考资料或项目规则；跨任务共识应由 Owner 提炼为模块知识或团队 Skill。",
      task_ids: frictionWithoutAccess.slice(0, 8),
    });
  }

  for (const resource of resources.filter((item) => item.accessed_tasks >= 2
      && item.repair_tasks * 2 >= item.accessed_tasks).slice(0, 3)) {
    result.push({
      id: `review:${resource.key}`,
      kind: "needs-review",
      tone: "attention",
      title: `建议复核「${resource.name}」`,
      evidence: `${resource.accessed_tasks} 个任务主动访问，其中 `
        + `${resource.repair_tasks} 个随后出现修复信号。`,
      action: "核对内容是否过期、是否缺少关键命令或容易被误解；这里只表示相关性。",
      resource_key: resource.key,
    });
  }

  for (const resource of resources.filter((item) => item.selected_tasks >= 2
      && item.accessed_tasks === 0).slice(0, 3)) {
    result.push({
      id: `unused:${resource.key}`,
      kind: "selected-unused",
      tone: "info",
      title: `「${resource.name}」多次入选但未被主动访问`,
      evidence: `${resource.selected_tasks} 个任务选择了它，尚未观察到读取或检索。`,
      action: "检查名称和描述是否足够明确；若长期无用，可降低推荐优先级。",
      resource_key: resource.key,
    });
  }

  for (const resource of resources.filter((item) => item.accessed_tasks >= 3
      && item.completed_tasks >= 2 && item.repair_tasks === 0).slice(0, 2)) {
    result.push({
      id: `promote:${resource.key}`,
      kind: "promote",
      tone: "positive",
      title: `「${resource.name}」值得提升可见性`,
      evidence: `${resource.accessed_tasks} 个任务主动访问，`
        + `${resource.completed_tasks} 个已经交付，暂未观察到修复信号。`,
      action: "可考虑在 AGENTS.md 或任务推荐中更明确地指向它。",
      resource_key: resource.key,
    });
  }
  return result.slice(0, 8);
}

/** 聚合同一批任务的知识使用趋势。仓库/模块资源按作用域+路径合并；
 * 团队宿主 Skill 按名称跨历史路径和内容版本合并。内容 digest 不拆行，
 * 便于观察同一资产跨版本的长期表现。 */
export function buildTeamKnowledgeInsights(
  tasks: KnowledgeInsightTask[],
  now = new Date(),
): TeamKnowledgeInsights {
  const observed = tasks.filter(teamTracked);
  const aggregate = new Map<string, KnowledgeInsightResource>();
  const taskAccess = new Set<string>();
  const frictionWithoutAccess: string[] = [];

  for (const task of observed) {
    const usage = task.knowledge_usage;
    const reusable = (usage?.resources ?? []).filter(reusableResource);
    const accessed = reusable.some((item) => item.read_count > 0);
    if (accessed) taskAccess.add(task.id);
    if (!accessed && (repaired(task) || needsAttention(task))) {
      frictionWithoutAccess.push(task.id);
    }
    // 历史任务若在升级前后都留下同一宿主 Skill 的不同路径，归一化后
    // 仍只能算“一个任务提供/选择/访问过一次”；访问事件本身则继续
    // 累加，保留真实阅读次数。
    const providedKeys = new Set<string>();
    const selectedKeys = new Set<string>();
    const loadedKeys = new Set<string>();
    const accessedKeys = new Set<string>();
    for (const resource of reusable) {
      const key = resourceKey(resource);
      const hostName = hostSkillName(resource);
      const item = aggregate.get(key) ?? {
        key,
        kind: resource.kind,
        name: resource.name,
        path: displayPath(resource),
        repository: resource.repository,
        ...(hostName ? { scope: "team" as const }
          : resource.scope ? { scope: resource.scope } : {}),
        ...(resource.module_id ? { module_id: resource.module_id } : {}),
        ...(resource.module_name ? { module_name: resource.module_name } : {}),
        ...(resource.asset_version !== undefined
          ? { asset_version: resource.asset_version } : {}),
        provided_tasks: 0,
        selected_tasks: 0,
        loaded_tasks: 0,
        accessed_tasks: 0,
        access_events: 0,
        completed_tasks: 0,
        repair_tasks: 0,
        attention_tasks: 0,
      };
      item.name = resource.name || item.name;
      if (!item.description && resource.description) {
        item.description = resource.description;
      }
      if (!providedKeys.has(key)) {
        item.provided_tasks += 1;
        providedKeys.add(key);
      }
      if (resource.selected && !selectedKeys.has(key)) {
        item.selected_tasks += 1;
        selectedKeys.add(key);
      }
      if (resource.loaded_count > 0 && !loadedKeys.has(key)) {
        item.loaded_tasks += 1;
        loadedKeys.add(key);
      }
      if (resource.read_count > 0) {
        item.access_events += resource.read_count;
        if (!accessedKeys.has(key)) {
          item.accessed_tasks += 1;
          if (completed(task)) item.completed_tasks += 1;
          if (repaired(task)) item.repair_tasks += 1;
          if (needsAttention(task)) item.attention_tasks += 1;
          accessedKeys.add(key);
        }
      }
      if (resource.last_at
          && (!item.last_used_at || resource.last_at > item.last_used_at)) {
        item.last_used_at = resource.last_at;
      }
      aggregate.set(key, item);
    }
  }

  const resources = [...aggregate.values()].sort((left, right) =>
    right.accessed_tasks - left.accessed_tasks
      || right.access_events - left.access_events
      || right.loaded_tasks - left.loaded_tasks
      || left.name.localeCompare(right.name));
  const advice = recommendations(resources, frictionWithoutAccess);
  return {
    generated_at: now.toISOString(),
    summary: {
      tracked_tasks: observed.length,
      accessed_tasks: taskAccess.size,
      unique_resources: resources.length,
      active_resources: resources.filter((item) => item.accessed_tasks > 0).length,
      selected_unused: resources.filter((item) => item.selected_tasks > 0
        && item.accessed_tasks === 0).length,
      opportunities: advice.filter((item) => item.tone !== "positive").length,
      access_rate: percent(taskAccess.size, observed.length),
    },
    resources,
    recommendations: advice,
  };
}
