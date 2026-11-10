/** 工作流编辑器使用的统一只读资产目录。正文不出接口。 */

import { listBusinessModules } from "./businessModuleLibrary.ts";
import { listHostSkillShelf } from "./hostSkillShelf.ts";
import type {
  WorkflowAssetForm,
  WorkflowAssetNature,
  WorkflowAssetRef,
  WorkflowStandardSnapshot,
} from "./workflowDefinition.ts";

export interface WorkflowAssetCatalogItem {
  ref: WorkflowAssetRef;
  type: "knowledge" | "skill" | "agent" | "tool" | "capability";
  title: string;
  summary: string;
  when_to_use?: string;
  nature?: WorkflowAssetNature;
  form?: WorkflowAssetForm;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  availability: "available" | "unavailable";
  warning?: string;
}

export interface WorkflowAssetCatalog {
  items: WorkflowAssetCatalogItem[];
  warnings: string[];
}

function digest(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function platformItems(
  standard: WorkflowStandardSnapshot | undefined,
): WorkflowAssetCatalogItem[] {
  if (!standard) return [];
  const seen = new Set<string>();
  const items: WorkflowAssetCatalogItem[] = [];
  for (const item of standard.stages.flatMap((stage) => stage.items)) {
    if (item.locked || !["agent", "tool"].includes(item.kind)
        || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({
      ref: {
        registry: "platform_capability",
        id: item.id,
        version: standard.standard_version,
        digest: digest(standard.catalog_digest),
        nature: "engineering",
      },
      type: item.kind as "agent" | "tool",
      title: item.title,
      summary: item.description ?? "Mae-Flow 标准方案提供的工程能力",
      nature: "engineering",
      business_module_ids: [],
      repositories: [],
      technologies: [],
      availability: "available",
    });
  }
  return items;
}

export function listWorkflowAssetCatalog(options: {
  dataDir: string;
  standard?: WorkflowStandardSnapshot;
}): WorkflowAssetCatalog {
  const items: WorkflowAssetCatalogItem[] = [];
  const warnings: string[] = [];
  try {
    const catalog = listBusinessModules(options.dataDir);
    warnings.push(...catalog.warnings.map((item) => `业务知识：${item}`));
    for (const module of catalog.modules) {
      if (module.status !== "active") continue;
      for (const asset of module.assets) {
        if (asset.status !== "published") continue;
        items.push({
          ref: {
            registry: "business_knowledge",
            id: asset.id,
            version: String(asset.version),
            digest: digest(asset.digest),
            nature: "business",
            form: asset.form,
            business_module_id: module.id,
          },
          type: asset.form === "skill" ? "skill" : "knowledge",
          title: asset.title,
          summary: asset.summary,
          when_to_use: asset.when_to_use,
          nature: "business",
          form: asset.form,
          business_module_ids: [module.id],
          repositories: [...asset.repositories],
          technologies: [],
          availability: "available",
        });
      }
    }
  } catch (error) {
    warnings.push(`业务知识目录不可用：${String(error)}`);
  }
  try {
    const shelf = listHostSkillShelf(options.dataDir);
    warnings.push(...shelf.warnings.map((item) => `团队 Skill：${item}`));
    for (const skill of shelf.skills) {
      const directory = skill.path.split("/")[0];
      if (!directory) continue;
      items.push({
        ref: {
          registry: "team_skill",
          id: directory,
          // Skill 的附件也是能力的一部分；工作流按整包指纹固定，不能
          // 只盯 SKILL.md 而让 references/scripts 悄悄漂移。
          version: skill.package_digest,
          digest: digest(skill.package_digest),
          ...(skill.nature === "business" || skill.nature === "engineering"
            ? { nature: skill.nature } : {}),
          form: "skill",
        },
        type: "skill",
        title: skill.name,
        summary: skill.description,
        ...(skill.nature === "business" || skill.nature === "engineering"
          ? { nature: skill.nature } : {}),
        form: "skill",
        business_module_ids: [...skill.business_module_ids],
        repositories: [...skill.repositories],
        technologies: [...skill.technologies],
        availability: skill.loadable && skill.nature !== "unclassified"
          ? "available" : "unavailable",
        ...(!skill.loadable
          ? { warning: "Pi 装载器未接受这个 Skill" }
          : skill.nature === "unclassified"
            ? { warning: "缺少知识性质与作用域标签，请先完成治理" }
            : {}),
      });
    }
  } catch (error) {
    warnings.push(`团队 Skill 目录不可用：${String(error)}`);
  }
  items.push(...platformItems(options.standard));
  items.sort((left, right) => left.type.localeCompare(right.type)
    || left.title.localeCompare(right.title)
    || left.ref.id.localeCompare(right.ref.id));
  return { items, warnings };
}
