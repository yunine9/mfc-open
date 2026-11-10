import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { saveState, type IssueSessionState } from "./state.ts";

/** 迁出早期混入问题会话的工具记录，保留代码、对话与失败材料。 */
export function migrateMrRepairRecords(dataDir: string, log?: (message: string) => void): void {
  const issues = join(dataDir, "issues");
  if (!existsSync(issues)) return;
  for (const name of readdirSync(issues)) {
    if (!/^issue-\d+$/.test(name)) continue;
    const source = join(issues, name);
    let state: IssueSessionState;
    try { state = JSON.parse(readFileSync(join(source, "issue.json"), "utf8")); }
    catch { continue; }
    if (state.scenario !== "mr_repair") continue;
    const base = `mr-repair-legacy-${name}`;
    let id = base, target = join(dataDir, "pipeline-repairs", id), suffix = 1;
    while (existsSync(target)) { id = `${base}-${++suffix}`; target = join(dataDir, "pipeline-repairs", id); }
    mkdirSync(join(dataDir, "pipeline-repairs"), { recursive: true });
    renameSync(source, target);
    state.id = id;
    if (state.status === "archived") state.status = "idle";
    delete state.conclusion;
    saveState(target, state);
    log?.(`流水线修复记录已迁到独立目录：${name} → ${id}`);
  }
}
