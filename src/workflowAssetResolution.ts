import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
import { resolveBusinessKnowledgeAssetReference } from "./businessModuleLibrary.ts";
/** Resolve workflow asset identities against task-pinned knowledge/Skill facts. */

import { knowledgeMatchesTask } from "./knowledgeAssetModel.ts";
import {
  listHostSkillShelf,
  listHostSkillShelfRoot,
} from "./hostSkillShelf.ts";
import {
  normalizeWorkflowDefinition,
  type WorkflowAssetRef,
  type WorkflowResolvedAsset,
} from "./workflowDefinition.ts";
import type { SelectedBusinessModule } from "./businessModuleRuntime.ts";
import type { SelectedRepositorySkill } from "./repositorySkillRuntime.ts";

function bareDigest(value: string): string {
  return value.replace(/^sha256:/, "").toLowerCase();
}

function references(value: unknown): WorkflowAssetRef[] {
  try {
    const definition = normalizeWorkflowDefinition(value);
    const refs = definition.edits.flatMap((edit) =>
      (edit.op === "add" || edit.op === "replace") && edit.item.asset_ref
        ? [edit.item.asset_ref] : []);
    return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
  } catch {
    // Compiler owns the user-visible invalid-profile diagnostic.
    return [];
  }
}

export function workflowKnowledgeSelections(value: unknown): {
  businessModuleIds: string[];
  teamSkillIds: string[];
} {
  const refs = references(value);
  return {
    businessModuleIds: [...new Set(refs.flatMap((ref) =>
      ref.registry === "business_knowledge" && ref.business_module_id
        ? [ref.business_module_id] : []))],
    teamSkillIds: [...new Set(refs.flatMap((ref) =>
      ref.registry === "team_skill" ? [ref.id] : []))],
  };
}

function unavailable(ref: WorkflowAssetRef, diagnostic: string): WorkflowResolvedAsset {
  return { ...ref, state: "unavailable", diagnostic };
}

function incompatible(ref: WorkflowAssetRef, diagnostic: string): WorkflowResolvedAsset {
  return { ...ref, state: "incompatible", diagnostic };
}

function businessAsset(
  ref: WorkflowAssetRef,
  modules: SelectedBusinessModule[],
): WorkflowResolvedAsset {
  const module = modules.find((item) => item.id === ref.business_module_id);
  if (!module) return unavailable(ref,
    `业务模块 ${ref.business_module_id} 未进入本任务快照`);
  const byId = module.assets.filter((item) => item.id === ref.id);
  const asset = byId.find((item) => String(item.version) === ref.version
    && bareDigest(item.digest) === bareDigest(ref.digest));
  if (asset) return { ...ref, state: "available",
    snapshot_path: asset.form === "skill"
      ? `.mae-flow-work/business-modules/${module.id}/${asset.id}/SKILL.md`
      : `.mae-flow-work/business-modules/${module.id}/${asset.id}.md` };
  if (byId.length) return unavailable(ref,
    `业务知识 ${module.name}/${ref.id} 的固定版本或摘要已不可用`);
  return incompatible(ref,
    `业务知识 ${module.name}/${ref.id} 不适用于本任务代码仓`);
}

function repositorySkill(
  ref: WorkflowAssetRef,
  skills: SelectedRepositorySkill[],
): WorkflowResolvedAsset {
  const skill = skills.find((item) => item.repository === ref.repository
    && item.revision === ref.revision
    && item.relative_path === ref.relative_path
    && bareDigest(item.digest) === bareDigest(ref.digest));
  return skill
    ? { ...ref, state: "available" }
    : unavailable(ref,
      `仓内 Skill ${ref.id} 的仓库、revision、路径或摘要与本任务不一致`);
}

export function resolveWorkflowAssets(options: {
  definition: unknown;
  dataDir: string;
  repositories: string[];
  technologies: string[];
  businessModules: SelectedBusinessModule[];
  repositorySkills?: SelectedRepositorySkill[];
  /** 任务创建路径必须对拍任务内固定快照，不能回头读取会漂移的货架。 */
  hostSkillSnapshotRoot?: string;
}): WorkflowResolvedAsset[] {
  let shelf: ReturnType<typeof listHostSkillShelf> | undefined;
  return references(options.definition).map((ref) => {
    if (ref.registry === "platform_capability") {
      return { ...ref, state: "available" };
    }
    if (ref.registry === "business_knowledge") {
      const original = businessAsset(ref, options.businessModules);
      if (original.state === "available" || !ref.business_module_id) return original;
      const current = resolveBusinessKnowledgeAssetReference(options.dataDir, ref.business_module_id, ref.id);
      const resolved = businessAsset({ ...ref, business_module_id: current.moduleId, id: current.assetId }, options.businessModules);
      return { ...resolved, ...ref };
    }
    if (ref.registry === "repository_skill") {
      return repositorySkill(ref, options.repositorySkills ?? []);
    }
    shelf ??= options.hostSkillSnapshotRoot
      ? listHostSkillShelfRoot(options.hostSkillSnapshotRoot)
      : listHostSkillShelf(options.dataDir);
    const skill = shelf.skills.find((item) =>
      (item.source_path ?? item.path).split("/")[0] === ref.id);
    if (!skill || !skill.loadable
        || bareDigest(skill.package_digest) !== bareDigest(ref.digest)) {
      return unavailable(ref,
        `团队 Skill ${ref.id} 的固定版本当前不可装载或摘要已变化`);
    }
    if (!knowledgeMatchesTask({ ...skill, business_module_ids: resolveBusinessModuleIds(options.dataDir, skill.business_module_ids) }, {
      repositories: options.repositories,
      technologies: options.technologies,
      businessModuleIds: resolveBusinessModuleIds(options.dataDir, options.businessModules.map((item) => item.id)),
    })) {
      return incompatible(ref, `团队 Skill ${ref.id} 不适用于本任务范围`);
    }
    return { ...ref, state: "available" };
  });
}
