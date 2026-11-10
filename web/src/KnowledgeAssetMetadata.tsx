import type { ComponentProps, ReactNode } from "react";
import type {
  BusinessModule,
  KnowledgeNature,
  SkillKnowledgeMetadataInput,
} from "./api";
import {
  KnowledgeLanguagePicker,
  KnowledgeLanguageTags,
} from "./KnowledgeLanguages";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";

export interface SkillMetadataDraft {
  nature?: SkillKnowledgeMetadataInput["nature"];
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

export const EMPTY_SKILL_METADATA: SkillMetadataDraft = {
  business_module_ids: [], repositories: [], technologies: [],
};

export function skillMetadataInput(
  value: SkillMetadataDraft,
): SkillKnowledgeMetadataInput | undefined {
  if (!value.nature) return undefined;
  if (value.nature === "business" && !value.business_module_ids.length) {
    return undefined;
  }
  if (value.nature === "engineering" && !value.technologies.length) {
    return undefined;
  }
  return {
    nature: value.nature,
    business_module_ids: value.business_module_ids,
    repositories: value.repositories,
    technologies: value.nature === "engineering" ? value.technologies : [],
  };
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value) : [...values, value];
}

/** 性质徽标词表(原 .kind-* 配色 1:1 收编):业务=success(绿)、
 * 工程=brand(存量主动作紫)、未分类=neutral;KnowledgeAssets 的行内
 * 性质徽标同用这一份,别再各写各的色。 */
export const NATURE_BADGE_VARIANT = {
  business: "success",
  engineering: "brand",
  unclassified: "neutral",
} as const satisfies Record<KnowledgeNature, ComponentProps<typeof Badge>["variant"]>;

/** 多选芯片按钮(原 .skill-module-picker button / .knowledge-language-picker
 * button 同一款:选中=主动作描边+浅底加粗,未选=灰描边)。 */
function ChipToggle({ pressed, children, onClick, title }: {
  pressed: boolean;
  children: ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return <button type="button" aria-pressed={pressed} title={title}
    className={cn("inline-flex items-baseline gap-1.5 rounded-md border",
      "px-2.5 py-1 text-sm transition-colors",
      pressed
        ? "border-primary bg-primary/5 font-bold text-primary"
        : "border-line bg-surface text-muted-foreground hover:border-line-strong")}
    onClick={onClick}>{children}</button>;
}

export function SkillMetadataEditor({ value, modules, onChange }: {
  value: SkillMetadataDraft;
  modules: BusinessModule[];
  onChange: (value: SkillMetadataDraft) => void;
}) {
  const activeModules = modules.filter((module) => module.status === "active");
  const repositoryOptions = [...new Set(activeModules.flatMap((module) =>
    module.repositories))];
  const chooseNature = (nature: Exclude<KnowledgeNature, "unclassified">) =>
    onChange({ ...value, nature,
      technologies: nature === "business" ? [] : value.technologies });
  return <div className="grid gap-2">
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="知识性质">
      <button type="button" aria-pressed={value.nature === "business"}
        onClick={() => chooseNature("business")}
        className={cn("grid min-w-0 gap-1 rounded-lg border p-2.5 text-left",
          "transition-colors",
          value.nature === "business"
            ? "border-primary bg-primary/5 text-primary ring-2 ring-primary/10"
            : "border-line bg-surface text-muted-foreground hover:border-line-strong")}>
        <strong className={cn("text-sm", value.nature === "business"
          && "text-primary")}>业务知识</strong>
        <small className="text-sm/normal">领域概念、规则、流程与业务边界</small>
      </button>
      <button type="button" aria-pressed={value.nature === "engineering"}
        onClick={() => chooseNature("engineering")}
        className={cn("grid min-w-0 gap-1 rounded-lg border p-2.5 text-left",
          "transition-colors",
          value.nature === "engineering"
            ? "border-primary bg-primary/5 text-primary ring-2 ring-primary/10"
            : "border-line bg-surface text-muted-foreground hover:border-line-strong")}>
        <strong className={cn("text-sm", value.nature === "engineering"
          && "text-primary")}>工程知识</strong>
        <small className="text-sm/normal">编码、构建、测试、排障和技术方法</small>
      </button>
    </div>
    {!value.nature && <p className="m-0 rounded-md bg-attention-soft p-2
      text-sm/relaxed text-attention">
      先判断正文讲业务事实还是工程方法；Skill 只是它的呈现形态。</p>}

    {value.nature && <div className="grid gap-2 rounded-md bg-muted p-2.5">
      <span className="grid gap-0.5"><strong className="text-sm
        text-foreground">{value.nature === "business" ? "归属业务模块（必选，可多选）"
        : "业务模块上下文（可选）"}</strong><small className="text-sm
        text-faint">
        {value.nature === "business"
          ? "业务知识必须至少归属一个模块；跨模块知识可以多选。"
          : "例如订单仓排障 Skill 仍是工程知识，这里只说明使用语境。"}
      </small></span>
      {activeModules.length ? <div className="flex flex-wrap gap-1.5">
        {activeModules.map((module) => <ChipToggle key={module.id}
          pressed={value.business_module_ids.includes(module.id)}
          onClick={() => onChange({ ...value,
            business_module_ids: toggle(value.business_module_ids, module.id) })}>
          {module.name}<small className="text-xs text-faint">{module.id}</small>
        </ChipToggle>)}
      </div> : <small className="text-sm text-attention">
        目前没有启用中的业务模块。</small>}
    </div>}

    {value.nature && repositoryOptions.length > 0
      && <div className="grid gap-2 rounded-md bg-muted p-2.5">
        <span className="grid gap-0.5"><strong className="text-sm
          text-foreground">适用代码仓（可选）</strong><small className="text-sm
          text-faint">
          不选表示不限仓库；选择后只向涉及这些仓库的任务推荐。</small></span>
        <div className="flex flex-wrap gap-1.5">
          {repositoryOptions.map((repository) => <ChipToggle key={repository}
            title={repository}
            pressed={value.repositories.includes(repository)}
            onClick={() => onChange({ ...value,
              repositories: toggle(value.repositories, repository) })}>
            {repository.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/i, "")
              || repository}</ChipToggle>)}
        </div>
      </div>}

    {value.nature === "engineering" && <div className="grid gap-2
      rounded-md bg-muted p-2.5">
      <span className="grid gap-0.5"><strong className="text-sm
        text-foreground">适用技术栈（必选，可多选）</strong><small
        className="text-sm text-faint">
        不区分语言时选“通用”；具体技术栈在配置中心维护。</small></span>
      <KnowledgeLanguagePicker value={value.technologies}
        includeAgnostic
        onChange={(technologies) => onChange({ ...value, technologies })} />
      {!value.technologies.length && <p className="m-0 rounded-md
        bg-attention-soft p-2 text-sm/relaxed text-attention">
        请选择至少一种适用技术栈；匹配不上应由知识治理者修正标签。</p>}
    </div>}

    <p className="m-0 border-l-3 border-line-strong p-2 text-sm/relaxed
      text-faint">
      性质看正文，不看挂载位置。业务知识按模块匹配，工程知识按技术栈匹配；若正文同时讲两类内容，请拆成两项知识。</p>
  </div>;
}

const NATURE_LABEL: Record<KnowledgeNature, string> = {
  business: "业务知识", engineering: "工程知识", unclassified: "待补属性",
};

export function SkillMetadataTags({ nature, formLabel = "Skill 形态",
  moduleIds, repositories, technologies, modules }: {
  nature: KnowledgeNature;
  /** 形态徽标文案:沉淀候选是文档/规则/示例等,不再是固定"Skill 形态"。 */
  formLabel?: string;
  moduleIds: string[];
  repositories: string[];
  technologies: string[];
  modules: BusinessModule[];
}) {
  const names = new Map(modules.map((module) => [module.id, module.name]));
  return <span className="flex flex-wrap items-center gap-1">
    <Badge variant={NATURE_BADGE_VARIANT[nature]}>{NATURE_LABEL[nature]}</Badge>
    <Badge variant="neutral">{formLabel}</Badge>
    {moduleIds.map((id) => <Badge variant="success" key={id}>
      {names.get(id) ?? id}</Badge>)}
    {repositories.map((repository) => <Badge variant="brand" key={repository}
      className="max-w-45 truncate">{repository.replace(/\/+$/, "")
        .split("/").at(-1)?.replace(/\.git$/i, "") || repository}</Badge>)}
    {nature === "engineering" && <KnowledgeLanguageTags
      languages={technologies} empty="待补技术栈关联" />}
  </span>;
}
