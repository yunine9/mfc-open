/**
 * 文字建议层(supplements)的构造与校验。
 *
 * v1 execution-profile 已于 2026-08-29 整体退役并入 v2
 * workflow-profile(用户拍板趁无存量窗口统一):任务补充说明、团队
 * 执行约定、仓库执行约定统一编译成 WorkflowSupplement,由
 * withWorkflowSupplements 写进定格方案(或 supplement-only 档),
 * 内核只认一个文件。有界"阶段勾选可选动作/优先能力"由 v2 结构化
 * 定制整体覆盖,已删除。
 *
 * 建议层的边界不变:只调整关注点、顺序和协作,永远低于阶段合同、
 * 真实证据、人工决定与权限。
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowSupplement } from "./workflowDefinition.ts";

export const MAX_TASK_EXECUTION_INSTRUCTIONS = 2_000;
const MAX_REPOSITORY_DEFAULTS_BYTES = 64 * 1024;

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Keep useful line breaks, reject binary/control transport and cap prompt size. */
function normalizeExecutionInstructions(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).replace(/\r\n?/g, "\n")
    .replace(/[\u0000\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n").map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n").trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_TASK_EXECUTION_INSTRUCTIONS) {
    throw new Error(
      `${label}不能超过 ${MAX_TASK_EXECUTION_INSTRUCTIONS} 个字符；`
      + "请只写关注点、顺序偏好和协作要求，详细需求放在需求正文",
    );
  }
  return normalized;
}

export function normalizeTaskExecutionInstructions(
  value: string | undefined,
): string | undefined {
  return normalizeExecutionInstructions(value, "本任务执行补充");
}

export function normalizeTeamExecutionInstructions(
  value: string | undefined,
): string | undefined {
  return normalizeExecutionInstructions(value, "团队执行约定");
}

export function normalizeRepositoryExecutionInstructions(
  value: string | undefined,
): string | undefined {
  return normalizeExecutionInstructions(value, "代码仓执行约定");
}

/** 下单时刻可得的两层:团队约定 + 本任务补充。仓库约定在首次 clone
 * 后由 resolveRepositorySupplement 补进来(它长在仓库文件里)。 */
export function buildTaskSupplements(
  taskId: string,
  instructions: string | undefined,
  teamInstructions?: string,
): WorkflowSupplement[] {
  const normalized = normalizeTaskExecutionInstructions(instructions);
  const normalizedTeam = normalizeTeamExecutionInstructions(teamInstructions);
  const supplements: WorkflowSupplement[] = [];
  if (normalizedTeam) {
    supplements.push({
      scope: "team",
      source_id: "team-default",
      title: "团队执行约定",
      instructions: normalizedTeam,
    });
  }
  if (normalized) {
    supplements.push({
      scope: "task",
      source_id: oneLine(taskId).slice(0, 120),
      title: "本任务补充",
      instructions: normalized,
    });
  }
  return supplements;
}

/**
 * 仓库可在受版本控制的 .mae-flow-defaults.json 里声明一条「执行补充」。
 * 只在首次 clone 后读取一次并固定进定格方案;之后恢复/重跑沿用快照,
 * 不随仓库或管理设置漂移。坏配置只明确降级,不阻塞任务。
 */
export function resolveRepositorySupplement(input: {
  workspace: string;
  repositoryId: string;
}): { supplement?: WorkflowSupplement; warning?: string } {
  const path = join(input.workspace, ".mae-flow-defaults.json");
  if (!existsSync(path)) return {};
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(".mae-flow-defaults.json 必须是仓库内普通文件");
    }
    if (stat.size > MAX_REPOSITORY_DEFAULTS_BYTES) {
      throw new Error(".mae-flow-defaults.json 超过 64 KiB");
    }
    const defaults = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      throw new Error(".mae-flow-defaults.json 顶层必须是对象");
    }
    const raw = (defaults as Record<string, unknown>)["执行补充"];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return {};
    }
    if (typeof raw !== "string") {
      throw new Error(".mae-flow-defaults.json 的「执行补充」必须是字符串");
    }
    const instructions = normalizeRepositoryExecutionInstructions(raw);
    if (!instructions) return {};
    return {
      supplement: {
        scope: "repository",
        source_id: oneLine(input.repositoryId).slice(0, 300),
        title: "代码仓执行约定",
        instructions,
      },
    };
  } catch (error) {
    return {
      warning: `代码仓执行约定未采用，继续使用其余执行方案：${
        error instanceof Error ? error.message : String(error)}`,
    };
  }
}
