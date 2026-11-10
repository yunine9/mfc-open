/** One-time recovery for tasks created before the continuous-review contract. */

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { adoptKernelDeliveryWatch, type KernelDeliveryHost } from "./kernelDelivery.ts";
import { runSafeWorktreeGit } from "./safeGit.ts";

export type ContinuousReviewMigrationResult =
  | { kind: "none" }
  | { kind: "adopted_watch"; migration_id: string }
  | { kind: "restored_accident"; migration_id: string };

export class ContinuousReviewMigrationError extends Error {}

function readObject(path: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function assertEqual(
  actual: unknown,
  expected: string | undefined,
  label: string,
): void {
  if (!expected) return;
  if (String(actual ?? "").trim() !== expected.trim()) {
    throw new ContinuousReviewMigrationError(
      `${label}不一致（现场=${String(actual ?? "缺失")}，台账=${expected}），拒绝覆盖现场`,
    );
  }
}

function currentBranch(cwd: string): string {
  const result = runSafeWorktreeGit(cwd, ["branch", "--show-current"]);
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

function lastVerifiedSha(state: Record<string, any>): string {
  return String(state?.quality?.external_verification?.sha ?? "").trim();
}

function isAncestor(cwd: string, ancestor: string): boolean {
  return runSafeWorktreeGit(
    cwd, ["merge-base", "--is-ancestor", ancestor, "HEAD"],
  ).status === 0;
}

function atomicRestore(path: string, value: Record<string, any>): void {
  const temporary = `${path}.migration-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

/**
 * Migrate only mechanically provable old states. Completed/canceled and active
 * repair/verification states are deliberately untouched.
 */
export function migrateContinuousReviewTask(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  taskId: string;
  status: string;
  ticket?: string;
  baseline?: string;
  sourceBranch?: string;
  reviewRepair: boolean;
}): ContinuousReviewMigrationResult {
  if (["completed", "canceled"].includes(input.status)) return { kind: "none" };
  const statePath = join(input.cwd, ".mae-flow.json");
  const state = readObject(statePath);
  if (!state) return { kind: "none" };

  if (input.status === "await_merge" && state.current === "end") {
    const closeEvents = Array.isArray(state?.delivery_loop?.close_events)
      ? state.delivery_loop.close_events : [];
    const mergedClose = closeEvents.some((item: any) =>
      item?.reason === "merged" && String(item?.sha ?? "").trim());
    // 新契约可能已完成可信 close，只是进程死在 task.json 投影之前。
    // 这不是 legacy end，绝不能反向 adopt 回 delivery_watch；recover 会
    // 用 completion attestation 直接补写 completed。
    if (state?.execution_contract?.continuous_review === true || mergedClose) {
      return { kind: "none" };
    }
    const migrationId = `migrate-watch:${input.taskId}:${lastVerifiedSha(state)}`;
    adoptKernelDeliveryWatch({
      host: input.host,
      cwd: input.cwd,
      workspace: input.workspace,
      migrationId,
      taskId: input.taskId,
    });
    return { kind: "adopted_watch", migration_id: migrationId };
  }

  if (!input.reviewRepair
      || !["config_confirm", "workflow_select"].includes(String(state.current))) {
    return { kind: "none" };
  }

  const lastPath = `${statePath}.last`;
  const archived = existsSync(lastPath) ? readObject(lastPath) : undefined;
  if (!archived || archived.current !== "end") {
    throw new ContinuousReviewMigrationError(
      "检视返工现场已回到配置阶段，但找不到同任务的终态 .last，拒绝猜测恢复",
    );
  }
  if (archived?.execution_contract?.host !== "cloud") {
    throw new ContinuousReviewMigrationError(".last 不是 Cloud 执行契约，拒绝恢复");
  }
  assertEqual(archived?.config?.["单号"], input.ticket, "任务单号");
  assertEqual(archived?.config?.["基线分支"], input.baseline, "基线分支");
  const workspaceBranch = input.sourceBranch || currentBranch(input.cwd);
  assertEqual(archived?.config?.["分支名"], workspaceBranch || undefined, "工作分支");
  const sha = lastVerifiedSha(archived);
  if (!sha || !isAncestor(input.cwd, sha)) {
    throw new ContinuousReviewMigrationError(
      `.last 的已验证提交 ${sha || "缺失"} 不在当前 HEAD 历史中，拒绝覆盖现场`,
    );
  }

  // 只恢复内核状态文件；代码工作区、索引和新轮真实修改保持原样。
  // .last 作为事故证据原地保留，不删除也不改写。
  atomicRestore(statePath, archived);
  const migrationId = `migrate-accident:${input.taskId}:${sha}`;
  try {
    adoptKernelDeliveryWatch({
      host: input.host,
      cwd: input.cwd,
      workspace: input.workspace,
      migrationId,
      taskId: input.taskId,
    });
  } catch (cause) {
    // restore 与 adopt 是一个迁移事务。宿主命令可能因签名、状态锁或
    // 磁盘故障失败；把事故现场原子放回去，下一次 recover 才仍能命中
    // 同一条迁移，而不是永久留下一个既非旧流程也非新流程的 end。
    try {
      atomicRestore(statePath, state);
    } catch (rollbackCause) {
      throw new ContinuousReviewMigrationError(
        `持续检视迁移失败且事故现场回滚失败：${String(rollbackCause)}`,
        { cause },
      );
    }
    throw cause;
  }
  return { kind: "restored_accident", migration_id: migrationId };
}
