import { createHash } from "node:crypto";

/** 需求图节点 = 交付单元。历史上节点就是"仓"(单仓单节点);单仓
 * 拆分(docs/delivery-unit-split-design.md)后同一 url 可有多个节点,
 * 靠 scope 区分"这个仓里的哪一块"。字段名保留 Repository 以兼容既有
 * 图产物与投影,不做迁移。 */
export interface RequirementProjectionRepository {
  id: string;
  name: string;
  url: string;
  responsibility?: string;
  /** 交付单元的文件面(单仓拆分):单元名 + 负责路径前缀。缺席 =
   * 整仓一个单元(旧语义)。paths 是仓内相对路径前缀,允许指向尚不
   * 存在的目录(纯新增模块)。 */
  scope?: {
    name: string;
    paths: string[];
  };
  /** 人工委派的逐仓责任人。只保存稳定账号名，个人凭据仍按启动时现取。 */
  assignee?: string;
  /** 当前仓实际使用的业务需求单号。缺席时兼容为沿用父任务单号。 */
  ticket?: string;
  task_id?: string;
}

/** 下单仓库只是分析候选，不等于一定要创建开发任务。分析会话必须逐仓
 * 给出结论；只有 change_required 的仓内模块才会进入交付图。 */
export interface RequirementRepositoryAssessment {
  name: string;
  url: string;
  outcome: "change_required" | "no_change";
  reason: string;
  evidence?: string[];
}

export interface RequirementDependency {
  /** 依赖方。语义是 `from 依赖 to`，因此 from 必须等待 to。 */
  from: string;
  /** 被依赖的前置仓库。 */
  to: string;
  reason?: string;
}

interface RawRequirementDependency {
  /** 新格式：字段本身就说明方向。 */
  dependent?: string;
  prerequisite?: string;
  /** 旧格式：历史约定是 from 先于 to，但早期模型偶尔会按自然语言写反。 */
  from?: string;
  to?: string;
  reason?: string;
}

function dependencyStatement(
  reason: string | undefined,
  dependent: RequirementProjectionRepository | undefined,
  prerequisite: RequirementProjectionRepository | undefined,
): boolean {
  if (!reason || !dependent || !prerequisite) return false;
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dependentNames = [...new Set([dependent.id, dependent.name])];
  const prerequisiteNames = [...new Set([prerequisite.id, prerequisite.name])];
  return dependentNames.some((left) => prerequisiteNames.some((right) =>
    new RegExp(`${escaped(left)}.{0,32}(?:依赖|等待|晚于|后于).{0,32}${escaped(right)}`, "i")
      .test(reason)));
}

// 需求分析的机读格式同时给开场提示和投影报错使用，避免 Agent 写错后
// 只能猜字段名。示例值必须是合法枚举，不能把两个值拼成一个示例值。
export const REQUIREMENT_ASSESSMENT_EXAMPLE =
  '{"name":"仓库名","url":"原始地址","outcome":"change_required","reason":"结论理由","evidence":["代码依据"]}';
export const REQUIREMENT_UNIT_EXAMPLE =
  '{"id":"unit-1","name":"仓库名","url":"原始地址","responsibility":"本模块做什么","scope":{"name":"功能模块名","paths":[]}}';
const REQUIREMENT_ASSESSMENT_FORMAT =
  `repository_assessments[] 每项示例：${REQUIREMENT_ASSESSMENT_EXAMPLE}；`
    + 'url 必须照录下单地址，outcome 只允许 change_required 或 no_change。';
const REQUIREMENT_UNIT_FORMAT =
  `repositories[] 每项示例：${REQUIREMENT_UNIT_EXAMPLE}；`
    + 'url 必须照录下单地址，scope.paths 可为空数组。';

export class RequirementGraphContractError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("；\n"));
  }
}

interface RawRequirementProjection {
  plan_revision?: string;
  chain_sha256?: string;
  story_sha256?: string;
  repository_assessments?: RequirementRepositoryAssessment[];
  repositories?: Array<Partial<RequirementProjectionRepository>>;
  dependencies?: RawRequirementDependency[];
}

export interface RequirementProjection {
  planRevision: string;
  actualChainSha: string;
  projectionSha: string;
  declaresSyncContract: boolean;
  assessments: RequirementRepositoryAssessment[];
  repositories: RequirementProjectionRepository[];
  dependencies: RequirementDependency[];
}

interface RequirementProjectionSources extends Pick<RequirementProjection,
  "planRevision" | "actualChainSha" | "projectionSha" | "declaresSyncContract"> {
  parsed: RawRequirementProjection;
  problems: string[];
}

/** 先解析两份原文及同步契约，宿主据此核对送审状态，再校验图内字段。
 * 分两步保留流程冲突优先级，避免把已送审内容的改写提示成自动修文件。 */
export function parseRequirementProjectionSources(
  graphSource: string, chainSource: string, sourceDocument: "story.md" | "chain",
): RequirementProjectionSources {
  let json: unknown;
  try {
    json = JSON.parse(graphSource);
  } catch {
    throw new RequirementGraphContractError(["requirement-graph.json 文件不是合法 JSON"]);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new RequirementGraphContractError(["requirement-graph.json 必须是 JSON 对象"]);
  }
  const problems: string[] = [];
  const parsed = json as RawRequirementProjection;
  const planRevision = String(parsed.plan_revision ?? "").trim();
  const revisionMarkers = [...chainSource.matchAll(
    /<!--\s*mae-flow-plan-revision:\s*([A-Za-z0-9._:-]{1,80})\s*-->/g,
  )];
  const claimedChainSha = String((sourceDocument === "story.md"
    ? parsed.story_sha256 ?? parsed.chain_sha256 : parsed.chain_sha256) ?? "")
    .trim().toLowerCase().replace(/^sha256:/, "");
  const actualChainSha = createHash("sha256")
    .update(chainSource, "utf-8").digest("hex");
  const projectionSha = createHash("sha256")
    .update(graphSource, "utf-8").digest("hex");
  const declaresSyncContract = Boolean(
    planRevision || revisionMarkers.length || claimedChainSha,
  );
  if (declaresSyncContract) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(planRevision)) {
      problems.push("requirement-graph.json 缺少合法的 plan_revision");
    }
    if (revisionMarkers.length !== 1) {
      problems.push("设计文档必须且只能声明一个 mae-flow-plan-revision");
    }
    if (revisionMarkers.length === 1 && /^[A-Za-z0-9._:-]{1,80}$/.test(planRevision)
        && revisionMarkers[0][1] !== planRevision) {
      throw new Error(`设计文档版本 ${revisionMarkers[0][1]} 与机读图版本 ${
        planRevision} 不一致`);
    }
    if (!/^[a-f0-9]{64}$/.test(claimedChainSha)) {
      problems.push("requirement-graph.json 缺少合法的设计摘要（story_sha256 / 旧 chain_sha256）");
    }
    if (/^[a-f0-9]{64}$/.test(claimedChainSha) && claimedChainSha !== actualChainSha) {
      throw new Error("设计文档内容已经变化，但机读依赖图还没有同步更新");
    }
  }
  return { parsed, problems, planRevision, actualChainSha, projectionSha, declaresSyncContract };
}

/** 只处理数据：收集契约问题、继承既有单元分配、规范化依赖方向。
 * 不读文件、不修改上一版图，也不参与任务状态或人工确认。 */
export function validateRequirementProjection(
  source: RequirementProjectionSources, expected: readonly string[],
  previous: { repositories: RequirementProjectionRepository[] } | undefined,
): RequirementProjection {
  const { parsed, planRevision, actualChainSha, projectionSha, declaresSyncContract } = source;
  const problems = [...source.problems];
  if (!Array.isArray(parsed.repository_assessments)) {
    problems.push(`缺少 repository_assessments，无法区分需修改仓与仅排查仓。${REQUIREMENT_ASSESSMENT_FORMAT}`);
  }
  const seenAssessmentUrls = new Set<string>();
  const assessments = (Array.isArray(parsed.repository_assessments)
    ? parsed.repository_assessments : []).map((item, index) => {
    const url = String(item?.url ?? "").trim();
    const name = String(item?.name ?? "").trim();
    const outcome = item?.outcome;
    const reason = String(item?.reason ?? "").trim();
    const fieldProblems = [
      !name ? "缺 name" : "",
      !url ? "缺 url" : "",
      outcome !== "change_required" && outcome !== "no_change"
        ? `outcome 值 ${JSON.stringify(String(outcome ?? "未填写").slice(0, 60))} 不合法` : "",
      !reason ? "缺 reason" : "",
    ].filter(Boolean);
    if (fieldProblems.length) {
      problems.push(`第 ${index + 1} 条排查结论字段不合法：${fieldProblems.join("、")}。${REQUIREMENT_ASSESSMENT_FORMAT}`);
    }
    if (url && !expected.includes(url)) {
      problems.push(`排查结论包含未下单的仓库：${url}。${REQUIREMENT_ASSESSMENT_FORMAT}`);
    }
    if (url && seenAssessmentUrls.has(url)) {
      problems.push(`仓库 ${name || url} 出现了重复的排查结论`);
    }
    seenAssessmentUrls.add(url);
    const evidence = Array.isArray(item?.evidence)
      ? item.evidence.map((entry) => String(entry).trim()).filter(Boolean)
          .slice(0, 20)
      : undefined;
    return { name, url, outcome, reason,
      ...(evidence?.length ? { evidence } : {}) };
  });
  const missingAssessments = expected.filter((url) =>
    !seenAssessmentUrls.has(url));
  if (Array.isArray(parsed.repository_assessments) && missingAssessments.length) {
    problems.push(`还有 ${missingAssessments.length} 个候选仓没有排查结论`);
  }
  if (!Array.isArray(parsed.repositories)) {
    problems.push(`缺少 repositories，模块交付单元尚未生成。${REQUIREMENT_UNIT_FORMAT}`);
  }
  const rawNodes = Array.isArray(parsed.repositories) ? parsed.repositories : [];
  // 同 url 是否唯一,决定旧图产物按 url 兜底匹配是否安全:单仓
  // 拆分后一个仓可有多个单元节点,url 兜底会把责任人/单号/task_id
  // 错配到别的单元上,只有该 url 仍然单节点时才允许。
  const urlCounts = new Map<string, number>();
  for (const item of rawNodes) {
    const url = String(item?.url ?? "").trim();
    urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
  }
  // 拆分前每个仓只有一个节点(建单初始图),它身上带着下单时填的
  // 责任人。同仓拆出多单元后新节点 id 对不上、url 兜底又因多节点
  // 关闭,责任人会整个丢掉——确认卡只读展示时全员回落主责任人
  // (2026-09-01 用户指出)。这里按"旧图该 url 唯一节点"继承责任人
  // 作为**默认值**;单号仍由确认卡逐单元填写（允许同仓串行单元
  // 共用同一 AR），task_id 绝不继承(会把别的单元错认成自己)。
  const previousNodes = previous?.repositories ?? [];
  const previousUrlCounts = new Map<string, number>();
  for (const node of previousNodes) {
    previousUrlCounts.set(node.url,
      (previousUrlCounts.get(node.url) ?? 0) + 1);
  }
  const repositories = rawNodes.map((item, index) => {
    const id = String(item?.id ?? "").trim();
    const name = String(item?.name ?? "").trim();
    const url = String(item?.url ?? "").trim();
    const responsibility = String(item?.responsibility ?? "").trim();
    const missing = [
      !id ? "id" : "", !name ? "name" : "",
      !url ? "url" : "", !responsibility ? "responsibility" : "",
    ].filter(Boolean);
    if (missing.length) {
      problems.push(`第 ${index + 1} 个模块交付单元缺少 ${missing.join("、")}。${REQUIREMENT_UNIT_FORMAT}`);
    }
    if (url && !expected.includes(url)) {
      problems.push(`模块交付单元 ${name} 的 url 不是下单仓库地址：${url}。${REQUIREMENT_UNIT_FORMAT}`);
    }
    const known = previous?.repositories
      .find((candidate) => candidate.id === id
        || (urlCounts.get(url) === 1 && candidate.url === url));
    const inheritedAssignee = known?.assignee
      ?? (previousUrlCounts.get(url) === 1
        ? previousNodes.find((node) => node.url === url)?.assignee
        : undefined);
    // 路径是可选阅读导航，模块边界由职责与契约表达，不再作为修改白名单。
    const scopeName = String(item?.scope?.name ?? name).trim() || name;
    const scopePaths = Array.isArray(item?.scope?.paths)
      ? item.scope.paths.map(String).map((path) => path.trim()).filter(Boolean)
      : [];
    return {
      id, name, url, responsibility,
      scope: { name: scopeName, paths: scopePaths },
      assignee: inheritedAssignee,
      ticket: known?.ticket,
      task_id: known?.task_id,
    };
  });
  if (new Set(repositories.map((item) => item.id)).size
      !== repositories.length) {
    problems.push("模块交付单元 id 重复");
  }
  const unitsByUrl = new Map<string, number>();
  for (const repository of repositories) {
    unitsByUrl.set(repository.url, (unitsByUrl.get(repository.url) ?? 0) + 1);
  }
  for (const assessment of Array.isArray(parsed.repositories) ? assessments : []) {
    const units = unitsByUrl.get(assessment.url) ?? 0;
    if (assessment.outcome === "change_required" && units === 0) {
      problems.push(`仓库 ${assessment.name} 标记为需要修改，但没有模块交付单元`);
    }
    if (assessment.outcome === "no_change" && units > 0) {
      problems.push(`仓库 ${assessment.name} 标记为无需修改，却生成了模块交付单元`);
    }
  }
  const ids = new Set(repositories.map((item) => item.id));
  // 新产物使用 dependent/prerequisite 消除歧义。旧版契约原本是
  // from 先于 to；若 reason 明确写了“A 依赖 B”，则以人工看到的
  // 说明为准，兼容早期模型把旧字段按自然语言填写的任务。
  if (!Array.isArray(parsed.dependencies)) {
    problems.push("缺少 dependencies；没有硬依赖时也必须明确写空数组");
  }
  const dependencies = (Array.isArray(parsed.dependencies) ? parsed.dependencies : []).map((item) => {
    const edge = item ?? {};
    if (edge.dependent && edge.prerequisite) return {
      from: edge.dependent, to: edge.prerequisite, reason: edge.reason,
    };
    const legacyFrom = edge.from ?? "";
    const legacyTo = edge.to ?? "";
    const fromRepository = repositories.find((item) => item.id === legacyFrom);
    const toRepository = repositories.find((item) => item.id === legacyTo);
    const reasonUsesNaturalDirection = dependencyStatement(
      edge.reason, fromRepository, toRepository);
    return reasonUsesNaturalDirection
      ? { from: legacyFrom, to: legacyTo, reason: edge.reason }
      : { from: legacyTo, to: legacyFrom, reason: edge.reason };
  });
  for (const edge of dependencies) {
    if ((Array.isArray(parsed.repositories) && (!ids.has(edge.from) || !ids.has(edge.to)))
        || edge.from === edge.to
        || !String(edge.reason ?? "").trim()) {
      problems.push("依赖关系包含未知模块、自依赖或缺少原因");
    }
  }
  if (problems.length) throw new RequirementGraphContractError([...new Set(problems)]);
  return { planRevision, actualChainSha, projectionSha, declaresSyncContract,
    assessments, repositories, dependencies };
}
