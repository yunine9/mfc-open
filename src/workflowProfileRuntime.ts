/** Task-pinned structural workflow profile projection and prompt fallback. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { compileWorkflow } from "./workflowCompiler.ts";
import type {
  WorkflowDefinition,
  WorkflowExecutionProfileV2,
  WorkflowPlanItem,
  WorkflowResolvedAsset,
  WorkflowSupplement,
} from "./workflowDefinition.ts";
import {
  WORKFLOW_DEFINITION_SCHEMA,
  WORKFLOW_EXECUTION_PROFILE_SCHEMA,
  workflowDigest,
} from "./workflowDefinition.ts";

const SUPPLEMENT_SCOPE_ORDER: Record<WorkflowSupplement["scope"], number> = {
  team: 0, business_module: 1, repository: 2, task: 3,
};

/**
 * 把文字建议层写进定格方案并重算 revision(revision 盖整个 payload,
 * 内核按同一算法复验)。没有结构化定格时产出 supplement-only 档——
 * 按平台默认方案执行、只叠建议;两者皆空返回 undefined。
 * v1 execution-profile 已退役(2026-08-29):这是建议层唯一的落点。
 */
export function withWorkflowSupplements(
  profile: WorkflowExecutionProfileV2 | undefined,
  supplements: WorkflowSupplement[],
): WorkflowExecutionProfileV2 | undefined {
  const ordered = supplements
    .map((item) => ({ ...item }))
    .sort((left, right) =>
      SUPPLEMENT_SCOPE_ORDER[left.scope] - SUPPLEMENT_SCOPE_ORDER[right.scope]);
  if (!ordered.length) return profile;
  const payload = {
    ...(profile
      ? Object.fromEntries(Object.entries(profile)
          .filter(([key]) => key !== "schema" && key !== "revision"))
      : {
          source: { kind: "platform" as const, id: "mae-flow.standard" },
          edits: [],
          asset_manifest: [],
          diagnostics: [],
        }),
    supplements: ordered,
  };
  return {
    schema: WORKFLOW_EXECUTION_PROFILE_SCHEMA,
    revision: workflowDigest(payload),
    ...structuredClone(payload),
  } as WorkflowExecutionProfileV2;
}

export const WORKFLOW_PROFILE_PATH = join(
  ".mae-flow-work", "workflow-profile.json");

/**
 * 创建时固定的是不可变资产身份；每次会话启动仍要对拍实际投影结果。
 * 单篇正文损坏时，只把对应资产标为不可用并重新编译那一项，替换操作
 * 会恢复 base item，其他有效定制和平台流程继续。
 */
export function reconcileWorkflowProfileAssets(
  profile: WorkflowExecutionProfileV2 | undefined,
  materializedPaths: Iterable<string>,
): WorkflowExecutionProfileV2 | undefined {
  if (!profile) return undefined;
  // supplement-only 档没有结构化资产,无从损坏也无从重编。
  if (!profile.base_snapshot || !profile.final_snapshot) return profile;
  const available = new Set([...materializedPaths]
    .map((path) => path.replaceAll("\\", "/")));
  let changed = false;
  const resolved = profile.asset_manifest.map((asset) => {
    const path = asset.snapshot_path?.replaceAll("\\", "/");
    if (asset.state !== "available" || !path || available.has(path)) {
      return { ...asset };
    }
    changed = true;
    return {
      ...asset,
      state: "unavailable" as const,
      diagnostic: `${asset.registry}:${asset.id}@${asset.version} 的任务固定正文未能投影`,
    };
  });
  if (!changed) return profile;
  const definition: WorkflowDefinition = {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    base: {
      standard_id: profile.base_snapshot.standard_id,
      standard_version: profile.base_snapshot.standard_version,
      catalog_digest: profile.base_snapshot.catalog_digest,
    },
    applicability: {
      business_module_ids: [], repositories: [], technologies: [],
    },
    edits: structuredClone(profile.edits),
  };
  // 重编产物不带 supplements(编译器只管结构),必须把建议层接回来,
  // 否则单项资产损坏的自愈会顺手弄丢任务补充。
  return withWorkflowSupplements(compileWorkflow({
    baseSnapshot: profile.base_snapshot,
    definition,
    source: profile.source,
    resolvedAssets: resolved,
  }), profile.supplements ?? []);
}

function resolvedAsset(
  profile: WorkflowExecutionProfileV2,
  item: WorkflowPlanItem,
): WorkflowResolvedAsset | undefined {
  const ref = item.asset_ref;
  if (!ref) return undefined;
  return profile.asset_manifest.find((asset) =>
    asset.registry === ref.registry && asset.id === ref.id
    && asset.version === ref.version && asset.digest === ref.digest
    && asset.business_module_id === ref.business_module_id
    && asset.repository === ref.repository
    && asset.revision === ref.revision
    && asset.relative_path === ref.relative_path);
}

function itemPrompt(
  profile: WorkflowExecutionProfileV2,
  item: WorkflowPlanItem,
  index: number,
): string {
  const asset = resolvedAsset(profile, item);
  const details = [item.instructions];
  if (asset?.snapshot_path) {
    details.push(`正文按需读取：${asset.snapshot_path}`);
  } else if (asset && ["team_skill", "repository_skill"]
      .includes(asset.registry)) {
    details.push(`固定 Skill：${asset.id}@${asset.version}（从任务 Skill 索引读取）`);
  }
  return `${index + 1}. ${item.title}${details.filter(Boolean).length
    ? `（${details.filter(Boolean).join("；")}）` : ""}`;
}

export function materializeWorkflowProfile(
  workspace: string,
  profile: WorkflowExecutionProfileV2 | undefined,
): string | undefined {
  if (!profile) return undefined;
  const path = join(workspace, WORKFLOW_PROFILE_PATH);
  const directory = join(workspace, ".mae-flow-work");
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o440,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o440);
    return path;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** 仅在非内核任务或现场文件投影失败时使用；不把资产正文灌入上下文。 */
export function workflowProfilePrompt(
  profile: WorkflowExecutionProfileV2 | undefined,
): string {
  if (!profile) return "";
  const lines: string[] = [];
  const finalSnapshot = profile.final_snapshot;
  if (finalSnapshot) {
    const source = profile.source.kind === "platform"
      ? "平台标准方案"
      : `${profile.source.kind === "workflow" ? "工作流" : "本任务定制"}`
        + ` ${profile.source.id}${profile.source.version
          ? `@${profile.source.version}` : ""}`;
    lines.push(
      `──── 已固定的最终执行方案（${source}） ────`,
      ...finalSnapshot.stages.flatMap((stage) => [
        `【${stage.phase} · ${stage.title}】`,
        stage.items.length
          ? stage.items.map((item, index) =>
              itemPrompt(profile, item, index)).join("\n")
          : "采用该阶段内核合同，不额外指定做法。",
      ]),
    );
    if (profile.diagnostics.length) {
      lines.push("已明确降级：", ...profile.diagnostics.map((item) =>
        `- ${item.message}${item.fallback ? `；${item.fallback}` : ""}`));
    }
    lines.push(
      "边界：这里只描述阶段内采用的做法；阶段、退出条件、真实证据、"
        + "人工决定以及 Git/写入/交付权限仍以平台内核为准。",
    );
  }
  const supplements = profile.supplements ?? [];
  if (supplements.length) {
    // 与内核 render_workflow_supplements 同一措辞:非内核任务与投影
    // 失败兜底也要拿到同款建议层,不因通道不同而少话。
    lines.push(
      "──── 已固定的执行补充（建议层） ────",
      ...supplements.flatMap((item) => [
        `【${item.title}】`, item.instructions,
      ]),
      "边界：这些补充只调整关注点、执行顺序和协作方式；若与当前阶段指令、"
        + "真实证据、人工决定或 Git/写入/交付权限冲突，冲突部分无效，"
        + "继续按平台规则执行并明确说明。",
    );
  }
  return lines.join("\n");
}
