import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AnnotationPermissionError } from "./annotations.ts";
import { NotFoundError, TaskControlError } from "./errors.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import type { TaskSummary, RequirementGraph } from "./taskService.ts";

import type { DependencyTaskRef, DependencyAdjustment, EarlyStartInput, EarlyStartPreview } from "./dependencySchedulingTypes.ts";
export type { DependencyAdjustment, EarlyStartInput, EarlyStartPreview } from "./dependencySchedulingTypes.ts";

interface ScheduledTask {
  summary: TaskSummary; cwd?: string; driver?: unknown; container?: unknown;
  prepushActive?: unknown; assistantActive?: unknown; containerReopen?: unknown;
}
export interface DependencyHost<T extends ScheduledTask = ScheduledTask> {
  tasks: Map<string, T>;
  completed(task: T | undefined): boolean;
  persist(task: T, strict?: boolean): void;
  wake(task: T): void;
}

function ref(task: TaskSummary | undefined, id: string): DependencyTaskRef {
  return { id, title: task?.title || id, ticket: task?.ticket || "", repository: task?.repo_url || task?.repositories?.[0] || "" };
}
function ownerOf<T extends ScheduledTask>(host: DependencyHost<T>, task: T): string {
  if (!task.summary.parent_task_id) return task.summary.luban_account ?? "本地用户";
  const parent = host.tasks.get(task.summary.parent_task_id);
  if (!parent) throw new TaskControlError("主任务记录缺失，无法确认谁能调整执行顺序");
  return parent.summary.luban_account ?? "本地用户";
}
function worker(summary: TaskSummary): boolean {
  return !["canceled", "coordinating"].includes(summary.status)
    && !(summary.status === "failed" && !summary.delivery?.mr_url && !summary.delivery?.git_push) && !summary.requirement_analysis_requested
    && summary.requirement_graph?.stage !== "analysis"
    && !summary.requirement_graph?.repositories.some(node => !!node.task_id && node.task_id !== summary.id);
}
function repo(summary: TaskSummary): string {
  return repositoryIdentity(summary.repo_url || summary.repositories?.[0] || "");
}
/** 所有路径都遍历，不能用“只删最后一个前置”漏掉长链、菱形与跨主任务依赖。 */
function ancestors<T extends ScheduledTask>(host: DependencyHost<T>, id: string,
  replacement?: { id: string; dependencies: string[] }): Set<string> {
  const found = new Set<string>();
  const visiting = new Set<string>();
  const walk = (current: string) => {
    if (visiting.has(current)) throw new TaskControlError("任务依赖存在循环，暂不能调整执行顺序");
    if (found.has(current)) return;
    visiting.add(current);
    const dependencies = replacement?.id === current ? replacement.dependencies : host.tasks.get(current)?.summary.blocked_by ?? [];
    for (const dependency of dependencies) walk(dependency);
    visiting.delete(current); found.add(current);
  };
  walk(id); found.delete(id);
  return found;
}
function pristine(task: ScheduledTask): boolean {
  // recover 会给所有任务设置 resume，包括一直在等前置的子任务。
  // 恢复标记只决定续跑方式，不能当成已开工凭据；这里只检查真实现场。
  return !task.cwd && !task.driver && !task.container && !task.containerReopen
    && !task.prepushActive && !task.assistantActive && !task.summary.baseline_build
    && !task.summary.delivery && !existsSync(join(task.summary.workspace, ".mae-flow.json"));
}

export function previewEarlyStart<T extends ScheduledTask>(host: DependencyHost<T>, id: string,
  actor: string, input: EarlyStartInput = {}): EarlyStartPreview {
  const task = host.tasks.get(id);
  if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
  const summary = task.summary, owner = ownerOf(host, task);
  const toRef = (key: string) => ref(host.tasks.get(key)?.summary, key);
  const pending = (key: string) => !host.completed(host.tasks.get(key));
  const direct = [...new Set(summary.blocked_by ?? [])];
  const prerequisites = direct.filter(pending);
  const released = [...new Set(input.release_ids ?? prerequisites)].sort();
  if (released.some(key => !prerequisites.includes(key))) throw new TaskControlError("前置任务已变化，请刷新影响范围后重试");
  const remaining = direct.filter(key => !released.includes(key));
  const replacement = { id, dependencies: remaining };
  const before = ancestors(host, id), after = ancestors(host, id, replacement);
  const noLongerWaiting = [...before].filter(key => !after.has(key) && pending(key)).sort();
  const parallel = [...host.tasks.values()].filter(other => other !== task && worker(other.summary)
    && (before.has(other.summary.id) || (repo(summary) && repo(other.summary) === repo(summary)))
    && !host.completed(other) && !after.has(other.summary.id)
    && !ancestors(host, other.summary.id, replacement).has(id))
    .map(other => toRef(other.summary.id)).sort((a, b) => a.id.localeCompare(b.id));
  const ticket = String(input.ticket ?? summary.ticket ?? "").trim();
  const conflicts = parallel.filter(other => ticket && other.ticket === ticket
    && repo(summary) && repositoryIdentity(other.repository) === repo(summary));
  // 切断中间节点会影响其后继的传递依赖；不能只核对目标自己的 AR。
  const downstream = [...host.tasks.values()].filter(other => other !== task && worker(other.summary) && pending(other.summary.id))
    .map(other => {
      const prior = ancestors(host, other.summary.id);
      if (!prior.has(id)) return undefined;
      const next = ancestors(host, other.summary.id, replacement);
      const lost = [...prior].filter(key => !next.has(key) && pending(key));
      if (!lost.length) return undefined;
      return { task: toRef(other.summary.id), no_longer_waiting: lost.map(toRef),
        conflicts: lost.filter(key => {
          const predecessor = host.tasks.get(key);
          return predecessor && worker(predecessor.summary) && repo(other.summary)
            && repo(predecessor.summary) === repo(other.summary) && predecessor.summary.ticket === other.summary.ticket
            && !ancestors(host, key, replacement).has(other.summary.id);
        }).map(toRef) };
    }).filter((item): item is NonNullable<typeof item> => !!item).sort((a,b) => a.task.id.localeCompare(b.task.id));
  const unavailable = summary.status !== "queued" ? "只支持尚未开工、正在等待前置任务的任务"
    : !pristine(task) ? "该任务已有执行现场，不能通过提前开始修改分支与执行安排"
    : !prerequisites.length ? "当前没有需要解除的前置等待"
    : summary.parent_task_id && ["canceled", "completed"].includes(host.tasks.get(summary.parent_task_id)!.summary.status)
      ? "主任务已结束，不能调整执行安排" : undefined;
  const errors: string[] = [];
  if (!released.length) errors.push("请选择不再等待的前置任务");
  if (!ticket) errors.push("请填写此任务的 AR 单号");
  else if (/\s/.test(ticket)) errors.push("AR 单号不能包含空白字符");
  if (conflicts.length) errors.push(`AR ${ticket} 与可能并行的同仓任务 ${conflicts.map(item => item.id).join("、")} 相同，请更换此任务的单号`);
  for (const item of downstream) if (item.conflicts.length) errors.push(
    `后续任务 ${item.task.id} 也会提前，与 ${item.conflicts.map(conflict => conflict.id).join("、")} 同仓同 AR（${item.task.ticket}）；请先调整 ${item.task.id} 的执行安排与单号`);
  const result = (remaining.filter(pending).length ? `仍需等待 ${remaining.filter(pending).join("、")}`
    : "解除等待后自动入队，有空闲执行名额时开始") + (downstream.length
      ? "；这些后续任务也可能随之提前，其他任务的执行先后保持不变" : "；其余任务保持原顺序");
  const view = { task: toRef(id), owner, can_operate: actor === owner,
    available: !unavailable, ...(unavailable ? { unavailable_reason: unavailable } : {}),
    prerequisites: prerequisites.map(toRef), release_ids: released,
    no_longer_waiting: noLongerWaiting.map(toRef), remaining: remaining.filter(pending).map(toRef),
    parallel, conflicts, downstream, ticket, errors, result };
  // 不绑定无关的 updated_at/模型进度；只绑定用户看到的影响、归属、单号和有效依赖。
  const revision = createHash("sha256").update(JSON.stringify({ ...view, can_operate: undefined,
    direct: direct.sort(), after: [...after].sort(), pristine: pristine(task) })).digest("hex");
  return { ...view, revision };
}

/** 同步校验、单任务原子落盘后才唤醒调度；没有第二个状态写入者，也不调用 Agent。 */
export function applyEarlyStart<T extends ScheduledTask>(host: DependencyHost<T>, id: string,
  actor: string, input: EarlyStartInput): TaskSummary {
  const task = host.tasks.get(id);
  if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
  const owner = ownerOf(host, task);
  if (owner !== actor) throw new AnnotationPermissionError(`只有主任务责任人 ${owner} 可以调整执行顺序`);
  const previous = task.summary.dependency_adjustments?.find(change => change.revision === input.revision);
  if (previous && previous.by === actor && previous.ticket === (input.ticket?.trim() ?? previous.ticket)
      && JSON.stringify(previous.released) === JSON.stringify([...new Set(input.release_ids ?? previous.released)].sort())) {
    host.wake(task); return task.summary; // 网络重试只重放回执，不重复移除依赖或生成任务。
  }
  const preview = previewEarlyStart(host, id, actor, input);
  if (!preview.available) throw new TaskControlError(preview.unavailable_reason!);
  if (!input.revision || input.revision !== preview.revision) throw new TaskControlError("执行安排或单号已变化，请重新查看影响后确认");
  if (preview.errors.length) throw new TaskControlError(preview.errors.join("；"));
  const oldSummary = task.summary;
  const remaining = (oldSummary.blocked_by ?? []).filter(key => !preview.release_ids.includes(key));
  const change: DependencyAdjustment = { revision: preview.revision, at: new Date().toISOString(), by: actor,
    released: preview.release_ids, remaining, no_longer_waiting: preview.no_longer_waiting.map(item => item.id),
    parallel: preview.parallel.map(item => item.id), downstream: preview.downstream.map(item => item.task.id), previous_ticket: oldSummary.ticket ?? "", ticket: preview.ticket };
  task.summary = { ...oldSummary, blocked_by: remaining,
    ticket: preview.ticket,
    requirement_graph: oldSummary.requirement_graph ? { ...oldSummary.requirement_graph, repositories: oldSummary.requirement_graph.repositories.map(node => ({ ...node, ticket: preview.ticket })) } : undefined,
    detail: preview.remaining.length ? `等待前置任务 ${preview.remaining.map(item => item.id).join("、")} 完成`
      : "责任人已解除前置等待，正在排队启动", dependency_adjustments: [...(oldSummary.dependency_adjustments ?? []), change] };
  try { host.persist(task); } catch (error) { task.summary = oldSummary; throw error; }
  host.wake(task);
  return task.summary;
}

/** 业务设计仍沿用 Story；这段只覆盖已经被责任人改变的调度与单号。 */
export function dependencyScheduleContext(summary: TaskSummary): string {
  if (!summary.dependency_adjustments?.length) return "";
  const last = summary.dependency_adjustments.at(-1)!;
  const released = [...new Set(summary.dependency_adjustments.flatMap(change => change.no_longer_waiting))];
  return ["## 责任人已调整执行安排", `- 操作者：${last.by}；时间：${last.at}`,
    `- 当前 AR 单号：${summary.ticket}。分支和提交使用此单号。`,
    `- 不再等待这些任务合入：${released.join("、")}。原任务书或 Story 中相应的等待安排已被本记录取代。`,
    `- 保留的前置任务：${summary.blocked_by?.join("、") || "无"}。`,
    "- 这是责任人的调度决定，不代表上游已完成。按当前基线继续本任务，代码和接口情况据实处理；不要自行恢复已解除的等待。"].join("\n");
}

/** 同号只容许一个在途执行者；恢复出两个候选时按就绪队列顺序占用，不能互相等死。 */
export function concurrentTicketConflict<T extends ScheduledTask>(host: DependencyHost<T>, task: T, queue: string[]): T | undefined {
  const summary = task.summary;
  if (!summary.ticket || !repo(summary) || !worker(summary)) return undefined;
  const upstream = ancestors(host, summary.id);
  return [...host.tasks.values()].find(other => other !== task && worker(other.summary)
    && other.summary.ticket === summary.ticket && repo(other.summary) === repo(summary)
    && !upstream.has(other.summary.id) && !ancestors(host, other.summary.id).has(summary.id)
    && !host.completed(other)
    && (other.summary.status !== "queued" || (
      (other.summary.blocked_by ?? []).every(key => host.completed(host.tasks.get(key)))
      && queue.indexOf(other.summary.id) >= 0 && queue.indexOf(other.summary.id) < queue.indexOf(summary.id))));
}

/** 原来的依赖队列维护抽到同一模块，启动与提前开始共用同一份 blocked_by 事实。 */
export function refreshDependencyQueue<T extends ScheduledTask>(host: DependencyHost<T>, queue: string[]): void {
  for (const id of [...queue]) {
    const task = host.tasks.get(id);
    if (!task || task.summary.status !== "queued") continue;
    const dependencies = task.summary.blocked_by ?? [];
    const gone = dependencies.filter(key => !host.tasks.has(key) || host.tasks.get(key)!.summary.status === "canceled");
    if (gone.length) {
      queue.splice(queue.indexOf(id), 1); task.summary.status = "failed";
      task.summary.detail = `前置任务 ${gone.join("、")} 已取消或不存在,本任务不会启动`;
      host.persist(task, false); continue;
    }
    const stuck = dependencies.filter(key => host.tasks.get(key)?.summary.status === "failed");
    const waiting = dependencies.filter(key => !host.completed(host.tasks.get(key)));
    const conflict = concurrentTicketConflict(host, task, queue);
    const detail = conflict ? `AR ${task.summary.ticket} 正由同仓任务 ${conflict.summary.id} 使用，等待该任务完成或调整单号`
      : stuck.length ? `前置任务 ${stuck.join("、")} 失败,重试它后本任务自动启动;不打算修就取消本任务`
      : waiting.length ? `等待前置任务 ${waiting.join("、")} 完成` : undefined;
    if (detail && task.summary.detail !== detail) { task.summary.detail = detail; host.persist(task, false); }
  }
}

/** 分工图显示运行中的真实等待关系；原始 Story 继续保留业务设计。 */
export function scheduledGraphDependencies<T extends ScheduledTask>(host: DependencyHost<T>, graph: RequirementGraph) {
  const byTask = new Map(graph.repositories.filter(node => node.task_id).map(node => [node.task_id!, node.id]));
  return graph.repositories.flatMap(node => {
    const child = node.task_id ? host.tasks.get(node.task_id) : undefined;
    if (!child) return graph.dependencies.filter(edge => edge.from === node.id);
    return (child.summary.blocked_by ?? []).flatMap(id => {
      const to = byTask.get(id);
      return to ? [graph.dependencies.find(edge => edge.from === node.id && edge.to === to)
        ?? { from: node.id, to, reason: "按当前执行顺序等待前置任务完成" }] : [];
    });
  });
}

/** 不把仍等依赖的任务算作执行名额前方的排队人数。 */
export function runnableQueueIndex<T extends ScheduledTask>(host: DependencyHost<T>, queue: string[], id: string): number {
  return queue.filter(key => {
    const task = host.tasks.get(key);
    return task?.summary.status === "queued" && !concurrentTicketConflict(host, task, queue)
      && (task.summary.blocked_by ?? []).every(key => host.completed(host.tasks.get(key)));
  }).indexOf(id);
}
