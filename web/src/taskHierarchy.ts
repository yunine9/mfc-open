/**
 * 在调用方已经排好优先级/时间的列表上恢复任务树顺序。
 *
 * 排序只决定各个根任务组、以及同一父任务下兄弟任务的先后；子任务绝不
 * 能被另一个根任务插到主任务之外。没有出现在当前筛选结果中的父任务不
 * 会被凭空补回，孤立子任务仍按原顺序展示，并由卡片说明其主任务来源。
 */
export function orderHierarchyBy<T>(
  items: T[],
  idOf: (item: T) => string,
  parentIdOf: (item: T) => string | undefined,
): T[] {
  const ids = new Set(items.map(idOf));
  const children = new Map<string, T[]>();
  for (const item of items) {
    const parentId = parentIdOf(item);
    if (!parentId || !ids.has(parentId)) continue;
    children.set(parentId, [...(children.get(parentId) ?? []), item]);
  }

  const ordered: T[] = [];
  const visited = new Set<string>();
  const append = (item: T) => {
    const id = idOf(item);
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push(item);
    for (const child of children.get(id) ?? []) append(child);
  };

  for (const item of items) {
    const parentId = parentIdOf(item);
    if (!parentId || !ids.has(parentId)) append(item);
  }
  // 数据异常成环时也不能让任务从列表消失。
  for (const item of items) append(item);
  return ordered;
}

export function orderTaskHierarchy<T extends {
  id: string;
  parent_task_id?: string;
}>(tasks: T[]): T[] {
  return orderHierarchyBy(tasks, (task) => task.id,
    (task) => task.parent_task_id);
}

/** Resolve relationships against the full permitted list, independently of filters. */
export function taskOverviewRelationship<T extends {
  id: string;
  parent_task_id?: string;
  requirement_graph?: { stage: string; repositories: Array<{ task_id?: string }> };
}>(task: T, allTasks: T[]): { parent: T | undefined; childCount: number } {
  const children = new Set(allTasks.filter((item) => item.parent_task_id === task.id).map((item) => item.id));
  if (task.requirement_graph?.stage === "confirmed") {
    for (const repository of task.requirement_graph.repositories) {
      if (repository.task_id && repository.task_id !== task.id) children.add(repository.task_id);
    }
  }
  children.delete(task.id);
  return {
    parent: task.parent_task_id !== task.id ? allTasks.find((item) => item.id === task.parent_task_id) : undefined,
    childCount: children.size,
  };
}

/** 图什么时候该露面——页签与组件必须用同一个判定。原来页签多认一条
 * "stage=confirmed",组件不认,于是拆分确认后的父任务点进「模块与依赖」是
 * 一片空白(2026-09-06 用户在演示数据上实测:候选仓 1 个、模块 2 个)。
 * 单仓分析单拆分前也要露出概览;多仓即使最终只剩一个或零个模块仍要展示
 * 逐仓排查结论;已确认的拆分方案更不能随候选仓数量消失。 */
export function requirementGraphVisible(task: {
  parent_task_id?: string;
  repositories?: string[];
  requirement_analysis_requested?: boolean;
  requirement_graph?: {
    stage: string;
    repositories: Array<{ task_id?: string }>;
    repository_assessments?: unknown[];
  };
}): boolean {
  const graph = task.requirement_graph;
  if (!graph || task.parent_task_id) return false;
  const candidateCount = task.repositories?.length
    ?? graph.repository_assessments?.length
    ?? graph.repositories.length;
  return candidateCount >= 2
    || graph.repositories.length >= 2
    || graph.stage === "confirmed"
    || task.requirement_analysis_requested === true;
}

/** 一家人一起看:子任务跟着父任务所在的分组走。
 *
 * 列表按状态分桶(当前 / 待合入与最近完成),跨仓父任务还在推进时,先完成
 * 的那个子任务会被分到"最近完成"桶,父任务下面只剩一个子任务,人以为
 * 少了一个(2026-09-06 演练现场实锤:两个子任务只显示一个)。规则:父任务
 * 在哪个桶,它的子任务都跟去那个桶;没有父任务在列表里的子任务按自己
 * 的状态分。 */
export function keepFamiliesTogether<T extends { id: string; parent_task_id?: string }>(
  bucket: T[],
  all: T[],
): T[] {
  const inBucket = new Set(bucket.map((task) => task.id));
  const parentsHere = new Set(bucket.filter((task) => !task.parent_task_id).map((task) => task.id));
  const followers = all.filter((task) => task.parent_task_id
    && parentsHere.has(task.parent_task_id) && !inBucket.has(task.id));
  const parentElsewhere = (task: T) => Boolean(task.parent_task_id)
    && !parentsHere.has(task.parent_task_id!)
    && all.some((item) => item.id === task.parent_task_id);
  return [...bucket.filter((task) => !parentElsewhere(task)), ...followers];
}
