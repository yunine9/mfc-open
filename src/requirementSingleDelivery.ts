import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { materializeAnalysisDecisions } from "./analysisDecisionContext.ts";
import { isMainTaskDelivery } from "./requirementDecisionContract.ts";
import { compileWorkflow } from "./workflowCompiler.ts";
import { resolveWorkflowAssets } from "./workflowAssetResolution.ts";
import { withWorkflowSupplements } from "./workflowProfileRuntime.ts";
import type { TaskSummary } from "./taskService.ts";

/** 仅在分析资源已经停止后切换；候选仓的历史结论保留在已确认的需求图中。 */
export function prepareMainTaskDelivery(task: {
  summary: TaskSummary; cwd?: string; mission?: string; resume?: boolean;
  progressCache?: unknown; pendingResume?: unknown;
}, dataDir: string): void {
  const summary = { ...task.summary }, unit = summary.requirement_graph!.repositories[0];
  const index = summary.repositories!.indexOf(unit.url);
  const code = task.cwd && join(task.cwd, `${index + 1}-${basename(unit.url).replace(/\.git$/, "") || "repo"}`);
  // 分析用聚合目录不是真正的代码仓；原有单仓开发现场也不能抢走这次分析的代码。
  const cwd = code && existsSync(join(code, ".git")) ? code : undefined;
  summary.repo_url = unit.url;
  summary.repositories = [unit.url];
  summary.ticket = unit.ticket ?? summary.ticket;
  const owner = unit.assignee ?? summary.luban_account;
  summary.collaborators = [...new Set([...(summary.collaborators ?? []), summary.luban_account]
    .filter((account): account is string => !!account && account !== owner))];
  summary.luban_account = owner;
  summary.repository_profiles = summary.repository_profiles?.filter(item => item.repository === unit.url);
  summary.repository_skills = summary.repository_skills?.filter(item => item.repository === unit.url);
  const profile = summary.workflow_profile;
  if (profile?.base_snapshot) {
    const definition = {
      schema: "mae-flow-workflow-definition/1",
      base: { standard_id: profile.base_snapshot.standard_id, standard_version: profile.base_snapshot.standard_version,
        catalog_digest: profile.base_snapshot.catalog_digest },
      applicability: { repositories: [unit.url], technologies: summary.repository_profiles?.flatMap(item => item.technologies) ?? [],
        business_module_ids: summary.business_modules?.map(item => item.id) ?? [] },
      edits: profile.edits,
    };
    summary.workflow_profile = withWorkflowSupplements(compileWorkflow({ baseSnapshot: profile.base_snapshot,
      definition, source: profile.source, resolvedAssets: resolveWorkflowAssets({ definition, dataDir,
        repositories: [unit.url], technologies: definition.applicability.technologies,
        businessModules: summary.business_modules ?? [], repositorySkills: summary.repository_skills,
        hostSkillSnapshotRoot: join(summary.workspace, "host-skill-snapshot"),
      }),
    }), profile.supplements ?? []);
  }
  delete summary.requirement_analysis_requested;
  delete summary.requirement_analysis_confirmation_required;
  summary.waiting = undefined;
  summary.progress = undefined;
  task.summary = summary;
  task.cwd = cwd;
  task.progressCache = undefined;
  task.mission = undefined;
  task.pendingResume = undefined;
  task.resume = false;
  summary.status = "queued";
  summary.detail = "方案已确认，在本任务继续开发与交付";
}

/** 新会话和重启都从同一份人工事实继续，不能再套用只读分析阶段的指令。 */
export function mainTaskDeliveryContext(summary: TaskSummary, cwd: string): string {
  if (!isMainTaskDelivery(summary)) return "";
  return [
    "需求分析与方案确认已完成；只有一个交付单元，现在由本任务完成开发、验证和交付，不创建子任务。"
      + "先读 .mae-flow-unit.md 和 .mae-flow-chain.md，沿用已确认的设计和业务答复，不重新进行拆分分析。"
      + "当前已进入正式交付流程，以内核当前步骤继续；此前只读分析的限制不再适用。",
    materializeAnalysisDecisions(summary.workspace, join(cwd, ".mae-flow-work", summary.ticket ?? summary.id)),
  ].filter(Boolean).join("\n\n");
}
