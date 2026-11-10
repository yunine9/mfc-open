import { writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
  /** 下单审计是诊断旁路：任务主账已经由 task.json 原子落袋，审计文件
   * 写失败不能把一张已创建任务回滚掉；但服务日志必须明确报出缺口。
   * 文件采用原子替换，避免进程中断留下半截 JSON 冒充完整记录。 */
export function recordTaskCreationAudit(
    task: { summary: { workspace: string; id: string } },
    audit: Record<string, unknown>,
    log?: (message: string) => void,
  ): void {
    const path = join(task.summary.workspace, "creation-audit.json");
    const temporary = `${path}.tmp`;
    let persisted = false;
    let writeError: string | undefined;
    try {
      writeFileSync(temporary, JSON.stringify(audit, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      persisted = true;
    } catch (error) {
      writeError = String(error);
      try { rmSync(temporary, { force: true }); } catch { /* 旁路清理尽力而为 */ }
    }
    try {
      log?.(`[task-create] ${JSON.stringify({
        ...audit,
        audit_file: persisted ? path : null,
        audit_write_error: writeError ?? null,
      })}`);
      if (writeError) {
        log?.(
          `任务 ${task.summary.id} 下单审计文件落盘失败(任务主账已保存): ${writeError}`);
      }
    } catch {
      // 日志接收器是旁路，不能因为接收器自身异常破坏已创建任务。
    }
  }
