import { useTechnologyStacks } from "./useTechnologyStacks";
import { ProductVersionPicker } from "./ProductVersionPicker";
import { RepositoryResourceNotice } from "./RepositoryResourceNotice";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createTask,
  getLaunchKnowledgePreview,
  getLaunchOptions,
  listCollaborationAssignees,
  listWorkflowAssets,
  previewRequirementMaterials,
  probeRepositories,
  type AuthUser,
  type CollaborationAssignee,
  type LaunchKnowledgeMatchedScope,
  type LaunchKnowledgePreview,
  type LaunchOptions,
  type RepositoryProbeResult,
  type RequirementMaterialsPreview,
  type TaskSummary,
  type WorkflowAssetSummary,
} from "./api";
import {
  asRepositoryProfiles,
  RepositoryTechnologyPicker,
  type RepositoryTechnologyDraft,
} from "./RepositoryTechnologyPicker";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import { userLabel } from "./UserPicker";
import {
  knowledgeAssetPath,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";
import {
  SchemeSelector,
  type WorkflowSchemeSelection,
} from "./workflows";
import { Markdown } from "./markdown";
import { KnowledgeMaterialUpload, type MaterialSummary } from "./KnowledgeMaterialUpload";
import { Empty, EmptyDescription } from "@/components/Empty";
import { Alert, AlertTitle } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

// 问题单入口已迁往「问题处理」页(/issues,见 web/src/issues/):
// 问题流是"先研究后补单"的动态对话,与需求的固定交付流水线分属
// 两个范式,不再共用发起表单。这里只保留需求入口。
const LAUNCH_DRAFT_VERSION = 1;
type LaunchDraft = {
  version: 1;
  updatedAt: string;
  title: string;
  requirement: string;
  requirementMaterials?: MaterialSummary[];
  repos: string[];
  repositoryTickets?: string[];
  collaborators?: string[];
  ticket: string;
  baseline: string;
  productVersion?: string;
  lane: string;
  repairRounds: string;
  taskInstructions?: string;
  businessModuleId?: string;
  workflowSelection?: WorkflowSchemeSelection;
  repositoryTechnologies?: RepositoryTechnologyDraft[];
};
type LaunchPreferences = {
  recentRepos: string[];
  baseline?: string;
  lane?: string;
};

function storageKey(kind: "draft" | "preferences", account: string): string {
  return `mae-flow:launch:${kind}:${account}`;
}

function readStored<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : undefined;
  } catch {
    return undefined;
  }
}

function restoredRepositoryTechnologies(
  value: unknown,
): RepositoryTechnologyDraft[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const repository = typeof item.repository === "string"
      ? item.repository.trim() : "";
    if (!repository || !Array.isArray(item.technologies)) return [];
    return [{
      repository,
      technologies: item.technologies.filter((technology): technology is string =>
        typeof technology === "string").slice(0, 50),
      confirmed: item.technologies.some(technology => typeof technology === "string" && technology.length > 0),
      ...(typeof item.remembered === "boolean"
        ? { remembered: item.remembered } : {}),
    }];
  });
}

function repositoryIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

const KNOWLEDGE_FORM_LABEL = {
  document: "文档",
  skill: "Skill",
  rule: "规则",
  example: "示例",
} as const;

/** #229 去 legacy:launch-* 容器配方退役,换工具类。区块壳/字段名/字段
 * 注记是全页共用版式,先落成一处词典;颜色全部经语义令牌桥或 var()
 * 简写取 tokens,不再按家族复制配方。 */
const SECTION = "min-w-0 rounded-lg border border-line px-[18px] pt-[17px] pb-[18px] bg-[color-mix(in_srgb,var(--surface-soft)_72%,var(--surface))]";
const FIELD_LABEL = "mb-[7px] block text-sm font-bold text-muted-foreground";

/** 区块头(原 .launch-section-head):编号盒 + 标题/注记 + 右置"必填"药丸。 */
function SectionHead({ step, title, note, mark, className }: {
  step: string;
  title: ReactNode;
  note: string;
  mark?: ReactNode;
  className?: string;
}) {
  return <div className={cn("mb-3.5 flex items-center gap-[9px]", className)}>
    <i aria-hidden className="grid size-[25px] shrink-0 place-items-center rounded-[7px] bg-(--accent-soft) font-mono text-xs font-bold text-primary">{step}</i>
    <div className="grid min-w-0 gap-0.5">
      <strong className="text-sm text-text-strong">{title}</strong>
      <small className="text-sm text-muted-foreground">{note}</small>
    </div>
    {mark !== undefined && <em className="ml-auto shrink-0 rounded-full bg-(--attention-soft) px-[7px] py-0.5 text-sm font-bold not-italic text-attention">{mark}</em>}
  </div>;
}

/** 知识形态徽标(原 .launch-knowledge-form 色板 1:1 收编 Badge):
 * 文档=brand(accent 底)、Skill=success、规则=warning、示例=merge
 * (旧硬编码紫收编令牌)。 */
const KNOWLEDGE_FORM_BADGE = {
  document: "brand",
  skill: "success",
  rule: "warning",
  example: "merge",
} as const satisfies Record<keyof typeof KNOWLEDGE_FORM_LABEL,
  ComponentProps<typeof Badge>["variant"]>;

/** 站内打开只接管普通点击；Cmd/Ctrl/Shift/Alt 点击保留浏览器原生的
 * 新标签页、新窗口等行为，知识链接因此既能直达也能按用户习惯打开。 */
export function isPlainKnowledgeActivation(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

function LaunchKnowledgeRow({ form, title, summary, whenToUse, scope, version,
  href, onOpen }: {
  form: keyof typeof KNOWLEDGE_FORM_LABEL;
  title: string;
  summary: string;
  whenToUse: string;
  scope: string;
  version?: string;
  href: string;
  onOpen: () => void;
}) {
  return <a className="grid w-full min-h-[62px] grid-cols-[44px_minmax(0,1fr)_minmax(150px,0.42fr)] items-center gap-2.5 px-3 py-[9px] text-left no-underline transition-[background,box-shadow] hover:bg-muted focus-visible:relative focus-visible:z-[1] focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] [&:not(:first-of-type)]:border-t [&:not(:first-of-type)]:border-line max-[680px]:min-h-0 max-[680px]:grid-cols-[40px_minmax(0,1fr)] max-[680px]:items-start max-[680px]:gap-x-2.5 max-[680px]:gap-y-[7px] max-[680px]:px-2.5 max-[680px]:py-[11px]" href={href}
    aria-label={`查看全文：${title}${version ? `，${version}` : ""}，命中依据：${scope}`}
    title={`到团队资产查看全文：${title}`}
    onClick={(event) => {
      if (!isPlainKnowledgeActivation(event)) return;
      event.preventDefault();
      onOpen();
    }}>
    <Badge variant={KNOWLEDGE_FORM_BADGE[form]}
      className="w-10 max-[680px]:col-start-1 max-[680px]:row-start-1 justify-center">
      {KNOWLEDGE_FORM_LABEL[form]}</Badge>
    <span className="grid min-w-0 gap-0.5 max-[680px]:col-start-2 max-[680px]:row-start-1">
      <span className="flex min-w-0 items-center gap-[7px] max-[680px]:flex-wrap max-[680px]:items-start">
        <strong title={title} className="min-w-0 flex-[0_1_auto] truncate text-xs text-text-strong max-[680px]:basis-full">{title}</strong>
        {version && <code className="shrink-0 rounded-full bg-(--accent-soft) px-[5px] py-px font-sans text-[9px] font-bold text-primary">{version}</code>}
      </span>
      <small title={summary || whenToUse} className="truncate text-xs not-italic leading-tight text-muted-foreground max-[680px]:whitespace-normal max-[680px]:text-clip max-[680px]:[overflow-wrap:anywhere]">{summary || whenToUse || "暂无说明"}</small>
      {summary && whenToUse && <em title={whenToUse} className="truncate text-xs not-italic leading-tight text-faint max-[680px]:whitespace-normal max-[680px]:text-clip max-[680px]:[overflow-wrap:anywhere]">适合：{whenToUse}</em>}
    </span>
    <span className="grid min-w-0 gap-0.5 border-l border-line pl-2.5 max-[680px]:col-start-2 max-[680px]:row-start-2 max-[680px]:border-l-0 max-[680px]:border-t max-[680px]:pl-0 max-[680px]:pt-[7px]">
      <small className="text-[9px] text-faint">命中依据</small>
      <strong title={scope} className="truncate text-xs text-success max-[680px]:whitespace-normal max-[680px]:text-clip max-[680px]:[overflow-wrap:anywhere]">{scope}</strong>
      <em className="text-[9px] font-bold not-italic text-primary">查看全文 <span aria-hidden>→</span></em>
    </span>
  </a>;
}

function LaunchRequirementTeam({
  owner,
  people,
  selected,
  loaded,
  error,
  onChange,
}: {
  owner: AuthUser;
  people: CollaborationAssignee[];
  selected: string[];
  loaded: boolean;
  error: string;
  onChange: (accounts: string[]) => void;
}) {
  const choices = people.filter((person) => person.username !== owner.username);
  const known = new Set(choices.map((person) => person.username));
  for (const username of selected) {
    if (!known.has(username) && username !== owner.username) {
      choices.push({ username, ready: false, missing: ["账号已不可用"] });
    }
  }
  const toggle = (username: string) => onChange(selected.includes(username)
    ? selected.filter((account) => account !== username)
    : selected.length < 20 ? [...selected, username] : selected);

  return <section className="requirement-team-picker mt-3"
    aria-label="主任务讨论参与人">
    <header>
      <div><span>讨论参与人</span><strong>谁一起把需求聊清楚</strong></div>
      <small>可多选；只邀请，不在这里按仓分工</small>
    </header>
    <div className="requirement-team-owner">
      <i aria-hidden>主</i>
      <span><strong>{userLabel(owner)}</strong>
        <small>主责任人 · 最终确认、拆分和任务控制</small></span>
    </div>
    <div className="requirement-team-members">
      {!loaded && <p>正在读取可邀请成员…</p>}
      {loaded && choices.length === 0 && <p>当前没有其他可邀请的成员。</p>}
      {choices.map((person) => {
        const checked = selected.includes(person.username);
        return <label key={person.username}
          className={`${checked ? "selected" : ""}${person.ready ? "" : " unready"}`}>
          <Checkbox checked={checked}
            disabled={(!person.ready || selected.length >= 20) && !checked}
            onCheckedChange={() => toggle(person.username)} />
          <span><strong>{userLabel(person)}</strong>
            <small>{person.ready ? "个人设置已就绪，可参与讨论"
              : `暂不可邀请 · 缺 ${person.missing.join("、")}`}</small></span>
        </label>;
      })}
    </div>
    {error && <p className="requirement-team-error" role="status">{error}</p>}
    <footer>
      <p>参与人可以补充材料、送批注并和 AI 讨论；最终决定仍由主责任人提交。</p>
      <strong>{selected.length ? `已邀请 ${selected.length} 人` : "暂不邀请其他人"}</strong>
    </footer>
  </section>;
}

export function LaunchWorkspace({
  session,
  onCreated,
  onClose,
  onOpenWorkflowAssets,
  onOpenKnowledgeAsset,
}: {
  session: AuthUser;
  /** 创建成功的任务摘要交给调用方,当场打开/高亮,下单不再零反馈。 */
  onCreated: (task: TaskSummary) => void | Promise<void>;
  onClose: () => void;
  onOpenWorkflowAssets?: (workflowId?: string) => void;
  onOpenKnowledgeAsset: (target: KnowledgeAssetFocus) => void;
}) {
  useTechnologyStacks();
  const [restoredDraft] = useState(() =>
    readStored<LaunchDraft>(storageKey("draft", session.username)));
  const [savedPreferences] = useState(() =>
    readStored<LaunchPreferences>(storageKey("preferences", session.username)));
  const validDraft = restoredDraft?.version === LAUNCH_DRAFT_VERSION
      && (restoredDraft as LaunchDraft & { entryKind?: string }).entryKind !== "dts"
    ? restoredDraft : undefined;
  const [requirement, setRequirement] = useState(
    validDraft?.requirement ?? "");
  const [requirementMaterials, setRequirementMaterials] = useState<MaterialSummary[]>(
    validDraft?.requirementMaterials ?? []);
  const [materialPreview, setMaterialPreview] = useState<{
    key: string; preview?: RequirementMaterialsPreview; error?: string;
  }>();
  const [materialPreviewRetry, setMaterialPreviewRetry] = useState(0);
  const [documentLoading, setDocumentLoading] = useState(false);
  const materialPreviewKey = JSON.stringify([requirement,
    requirementMaterials.map(material => [material.id, material.state])]);
  const materialPreviewBlocked = requirementMaterials.length > 0 && (
    requirementMaterials.some(material => material.state !== "ready")
    || materialPreview?.key !== materialPreviewKey || !materialPreview.preview);
  useEffect(() => {
    if (!requirementMaterials.length || requirementMaterials.some(material => material.state !== "ready")) return;
    const controller = new AbortController();
    const key = materialPreviewKey;
    const timer = window.setTimeout(() => {
      void previewRequirementMaterials(requirementMaterials.map(material => material.id), requirement, controller.signal)
        .then(preview => {
          if (controller.signal.aborted) return;
          const ids = new Set(preview.sources.map(source => source.id));
          if (ids.size !== requirementMaterials.length
              || requirementMaterials.some(material => !ids.has(material.id))) {
            throw new Error("预览未包含全部已上传资料，请重试或重新上传缺失资料。");
          }
          setMaterialPreview({ key, preview });
        }).catch(cause => {
          if (!controller.signal.aborted) setMaterialPreview({ key,
            error: cause instanceof Error ? cause.message : "需求资料预览失败" });
        });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [materialPreviewKey, materialPreviewRetry]);
  const [businessModuleId, setBusinessModuleId] = useState(validDraft?.businessModuleId ?? "");
  const [moduleRefreshError, setModuleRefreshError] = useState("");
  const [title, setTitle] = useState(validDraft?.title ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  // 任务级可填项(2026-08-18 重定口径):交付仓**必填**、交付方式、修复轮
  // 预算。模型不给选——管理员统一配一个,这里只显示"这单用谁跑"。
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const initialRepos = validDraft?.repos?.length
    ? validDraft.repos
    : savedPreferences?.recentRepos?.[0]
      ? [savedPreferences.recentRepos[0]] : [""];
  const [repos, setRepos] = useState(initialRepos);
  const [repositoryTickets, setRepositoryTickets] = useState(() =>
    initialRepos.map((_, index) => validDraft?.repositoryTickets?.[index]
      ?? validDraft?.ticket ?? ""));
  const [collaborators, setCollaborators] = useState(() => [...new Set(
    (validDraft?.collaborators ?? []).filter((account) =>
      account && account !== session.username),
  )].slice(0, 20));
  const [collaborationAssignees, setCollaborationAssignees] =
    useState<CollaborationAssignee[]>([]);
  const [collaborationAssigneesLoaded, setCollaborationAssigneesLoaded] =
    useState(false);
  const [collaborationAssigneesError, setCollaborationAssigneesError] =
    useState("");
  const [repositoryProbeResults, setRepositoryProbeResults] =
    useState<RepositoryProbeResult[]>([]);
  const [repositoryProbeKey, setRepositoryProbeKey] = useState("");
  const [repositoryProbeLoading, setRepositoryProbeLoading] = useState(false);
  const [repositoryProbeError, setRepositoryProbeError] = useState("");
  const repositoryProbeRequest = useRef(0);
  // 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
  // 不让模型开工后再逐项来问(用户 2026-08-19 拍板,基线默认 master)。
  const [ticket, setTicket] = useState(validDraft?.ticket ?? "");
  const [productVersion, setProductVersion] = useState(validDraft?.productVersion ?? "");
  const [baseline, setBaseline] = useState(
    validDraft?.baseline ?? savedPreferences?.baseline ?? "");
  // 交付方式下单就定(用户拍板:不让 agent 再问一遍);选项与默认值
  // 都来自内核,空串=等 options 到了再取第一项。
  const [lane, setLane] = useState(
    validDraft?.lane ?? savedPreferences?.lane ?? "");
  // 修复轮数是“关闭自动修复”级别的任务手刹，不能像仓库/基线一样
  // 跨任务记忆。旧实现把一次填写的 0 存成长期偏好，下一单即使没有
  // 打开折叠区也会静默提交 repair_rounds=0；跨仓拆单还会把它复制给
  // 每个子任务。只恢复当前未提交草稿，成功下单后下一单重新留空。
  const [repairRounds, setRepairRounds] = useState(
    validDraft?.repairRounds ?? "");
  const [taskInstructions, setTaskInstructions] = useState(
    validDraft?.taskInstructions ?? "");
  // 预览与提交共用所属模块，不再按公共仓推断其他模块或恢复旧的独立选择。
  const selectedBusinessModuleIds = useMemo(
    () => businessModuleId ? [businessModuleId] : [], [businessModuleId]);
  const [draftSavedAt, setDraftSavedAt] = useState(
    validDraft?.updatedAt ?? "");
  const [repositoryTechnologies, setRepositoryTechnologies] =
    useState<RepositoryTechnologyDraft[]>(() =>
      restoredRepositoryTechnologies(validDraft?.repositoryTechnologies));
  const [workflowAssets, setWorkflowAssets] = useState<WorkflowAssetSummary[]>([]);
  const [workflowAssetsLoaded, setWorkflowAssetsLoaded] = useState(false);
  const [workflowSelection, setWorkflowSelection] = useState<WorkflowSchemeSelection | undefined>(
    validDraft?.workflowSelection);
  const [workflowSelectionNotice, setWorkflowSelectionNotice] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(
    validDraft?.workflowSelection
    || validDraft?.taskInstructions?.trim()
    || validDraft?.repairRounds?.trim(),
  ));
  const latestDraft = useRef<LaunchDraft | undefined>(undefined);
  const discardDraftOnClose = useRef(false);
  const [knowledgePreview, setKnowledgePreview] =
    useState<LaunchKnowledgePreview>();
  const [knowledgePreviewLoading, setKnowledgePreviewLoading] = useState(true);
  const [knowledgePreviewError, setKnowledgePreviewError] = useState("");
  const [knowledgePreviewKey, setKnowledgePreviewKey] = useState("");
  const knowledgePreviewRequest = useRef(0);
  const [knowledgePreviewRefresh, setKnowledgePreviewRefresh] = useState(0);
  const businessModules = useMemo(() => {
    const wantedRepos = new Set(repos.map(repositoryIdentity).filter(Boolean));
    return [...(options?.business_modules ?? [])].sort((left, right) => {
      const leftMatch = left.repositories.some((repo) =>
        wantedRepos.has(repositoryIdentity(repo)));
      const rightMatch = right.repositories.some((repo) =>
        wantedRepos.has(repositoryIdentity(repo)));
      return Number(rightMatch) - Number(leftMatch)
        || left.name.localeCompare(right.name);
    });
  }, [options, repos]);
  const businessModuleNames = useMemo(() => new Map(
    businessModules.map((module) => [module.id, module.name])),
  [businessModules]);
  // 固定仓部署不接受仓库输入,预览/提交也一并按 enabled 裁字段——
  // 隐藏控件不等于字段不存在(MFC-033)。
  const repoFieldsEnabled = options?.repo.enabled !== false;
  const repositoriesToProbe = useMemo(() => [...new Set(
    repos.map((item) => item.trim()).filter(Boolean),
  )], [repos]);
  const multiRepository = repositoriesToProbe.length > 1;
  const analysisEligible = repoFieldsEnabled && repositoriesToProbe.length > 0;
  // 多仓天然先形成主任务共同澄清,参与人属于主任务,不与任何一个仓库预绑定。
  // 单仓没有"大需求"开关了(2026-09-03 用户拍板):拆不拆是分析的产物,
  // 由 Agent 读完仓后提议(propose_split),不由下单的人提前判断。
  const analysisTeamVisible = analysisEligible && multiRepository;
  // 只要要先分析，最终交付单元就还没有形成；单号此时既无法准确
  // 归属，也不该让人填两遍，统一延后到拆分确认时逐单元收。
  const ticketsDeferred = analysisTeamVisible;
  const expectedRepositoryProbeKey = JSON.stringify(repositoriesToProbe);
  const repositoryProbeByUrl = useMemo(() => new Map(
    repositoryProbeResults.map((item) => [item.repository, item]),
  ), [repositoryProbeResults]);
  const repositoryProbeSettled = repositoryProbeKey
    === expectedRepositoryProbeKey;
  const repositoryProbeBlocked = repoFieldsEnabled
    && repositoriesToProbe.length > 0
    && (repositoryProbeLoading || !repositoryProbeSettled
      || !!repositoryProbeError
      || repositoryProbeResults.some((item) => !item.reachable));
  const confirmedRepositoryTechnologyIds = new Set(repositoryTechnologies
    .filter((item) => item.confirmed && item.technologies.length > 0)
    .map((item) => repositoryIdentity(item.repository)));
  const repositoryTechnologyBlocked = repoFieldsEnabled
    && repositoriesToProbe.length > 0
    && repositoriesToProbe.some((repository) =>
      !confirmedRepositoryTechnologyIds.has(repositoryIdentity(repository)));
  const repositoryTicketBlocked = Boolean(options?.ticket.enabled)
    && !ticketsDeferred
    && (repoFieldsEnabled
      ? repos.some((repo, index) => {
          if (!repo.trim()) return false;
          const value = repositoryTickets[index]?.trim() ?? "";
          return (options?.ticket.required && !value) || /\s/.test(value);
        })
      : (options?.ticket.required && !ticket.trim()) || /\s/.test(ticket.trim()));
  const collaboratorBlocked = analysisTeamVisible && collaborators.some(
    (account) => !collaborationAssigneesLoaded
      || collaborationAssignees.find((item) => item.username === account)
        ?.ready !== true);
  const previewInput = useMemo(() => ({
    repos: repoFieldsEnabled
      ? repos.map((item) => item.trim()).filter(Boolean) : [],
    selectedBusinessModuleIds,
    repositoryProfiles: repoFieldsEnabled && repositoryTechnologies.length > 0
        && repositoryTechnologies.every((item) =>
          item.confirmed && item.technologies.length > 0)
      ? asRepositoryProfiles(repositoryTechnologies) : undefined,
    workflowSelection,
  }), [repoFieldsEnabled, repos, selectedBusinessModuleIds,
    repositoryTechnologies, workflowSelection]);
  const expectedKnowledgePreviewKey = JSON.stringify(previewInput);
  const matchingModuleKnowledge = knowledgePreview?.business_knowledge ?? [];
  const matchingTeamSkills = knowledgePreview?.team_skills ?? [];
  const repositoryName = (value: string) => value.replace(/\/+$/, "")
    .split("/").at(-1)?.replace(/\.git$/i, "") || value;
  const describeMatchedScope = (item: LaunchKnowledgeMatchedScope) => {
    const scopes = item.matched_business_module_ids.map((id) =>
      `模块：${businessModuleNames.get(id) ?? id}`);
    scopes.push(...item.matched_technologies.map((technology) =>
      `技术栈：${knowledgeLanguageLabel(technology)}`));
    scopes.push(...item.matched_repositories.map((repository) =>
      `仓库：${repositoryName(repository)}`));
    return scopes.join(" · ") || "团队通用";
  };
  const matchedTeamKnowledgeCount = matchingTeamSkills.length;
  const deliveryLocationVisible = !!options;
  const selectedModuleKnowledgeCount = matchingModuleKnowledge.length;
  const selectedKnowledgeCount = selectedModuleKnowledgeCount
    + matchedTeamKnowledgeCount;
  const previewBusinessModuleIds = knowledgePreview?.scope.business_module_ids
    ?? selectedBusinessModuleIds;
  const knowledgeNotices = [
    ...(knowledgePreview?.errors ?? []),
    ...(knowledgePreview?.warnings ?? []),
  ];
  // 明确选中的知识无法固定才阻塞。自动目录是可选增强：读不到时把
  // 降级清单和原因摊给人看，仍允许发起；创建现场继续用 digest 对拍，
  // 目录若恢复或变化会要求刷新，绝不会静默换一份名单。
  const blockers = options?.blockers ?? [];
  const previewSettled = knowledgePreviewKey === expectedKnowledgePreviewKey;
  const knowledgeBlocked = knowledgePreviewLoading || !previewSettled
    || !!knowledgePreviewError || !knowledgePreview?.complete;
  const blocked = optionsLoading || documentLoading || materialPreviewBlocked
    || blockers.length > 0 || !!optionsError
    || knowledgeBlocked || repositoryProbeBlocked || repositoryTicketBlocked
    || repositoryTechnologyBlocked || collaboratorBlocked;

  useEffect(() => {
    let alive = true;
    void getLaunchOptions().then((result) => {
      if (!alive) return;
      setOptions(result);
      // 固定仓部署(repo.enabled=false)只是不渲染仓库输入框,但草稿/
      // 最近使用里恢复的旧仓值仍在 state 里,提交时会被暗带上——服务端
      // 虽会拒绝,用户却在一个没有仓库输入框的页面上收到"仓库不对"
      // (MFC-033 实证)。拿到配置就把不该存在的字段清干净。
      if (!result.repo.enabled) {
        setRepos([""]);
        setRepositoryTickets([""]);
        setRepositoryTechnologies([]);
      }
      setBaseline((current) => current.trim()
        || (result.baseline.enabled ? result.baseline.default : ""));
      setLane((current) => current || result.workflows[0]?.label || "");
    }).catch(() => {
      if (alive) setOptionsError("未能读取任务配置，请刷新后重试");
    }).finally(() => {
      if (alive) setOptionsLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // 配置中心另页打开，保留本页所有草稿和附件；返回时只刷新模块目录。
  useEffect(() => {
    let alive = true;
    let request = 0;
    const refreshModules = () => {
      if (document.visibilityState === "hidden") return;
      const current = ++request;
      void getLaunchOptions().then(result => {
        if (alive && current === request) {
          setOptions(previous => previous ? { ...previous, business_modules: result.business_modules } : previous);
          setModuleRefreshError("");
        }
      }).catch(() => {
        if (alive && current === request) setModuleRefreshError("模块目录刷新失败，请点击刷新模块重试。");
      });
    };
    window.addEventListener("focus", refreshModules);
    document.addEventListener("visibilitychange", refreshModules);
    window.addEventListener("refresh-business-modules", refreshModules);
    return () => {
      alive = false;
      window.removeEventListener("focus", refreshModules);
      document.removeEventListener("visibilitychange", refreshModules);
      window.removeEventListener("refresh-business-modules", refreshModules);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void listCollaborationAssignees().then((items) => {
      if (!alive) return;
      setCollaborationAssignees(items);
      setCollaborationAssigneesError("");
    }).catch(() => {
      if (!alive) return;
      setCollaborationAssignees([]);
      // 名单读不到就没法核对就绪;与其把草稿里的参与人当"未就绪"卡住
      // 发起、再让人手动逐个取消,不如如实说清并直接清空——文案和动作
      // 要一致(2026-09-02 检视)。
      setCollaborators([]);
      setCollaborationAssigneesError(
        "暂时读不到可邀请成员，本次发起不邀请其他人；发起后可在主任务里再邀请。");
    }).finally(() => {
      if (alive) setCollaborationAssigneesLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!options?.repo.enabled || repositoriesToProbe.length === 0) {
      setRepositoryProbeResults([]);
      setRepositoryProbeKey(expectedRepositoryProbeKey);
      setRepositoryProbeLoading(false);
      setRepositoryProbeError("");
      return;
    }
    const request = ++repositoryProbeRequest.current;
    const key = expectedRepositoryProbeKey;
    const controller = new AbortController();
    setRepositoryProbeLoading(true);
    setRepositoryProbeError("");
    const timer = window.setTimeout(() => {
      void probeRepositories(repositoriesToProbe, controller.signal)
        .then((result) => {
          if (repositoryProbeRequest.current !== request) return;
          setRepositoryProbeResults(result);
          setRepositoryProbeKey(key);
        }).catch((cause) => {
          if (repositoryProbeRequest.current !== request) return;
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setRepositoryProbeResults([]);
          setRepositoryProbeKey(key);
          setRepositoryProbeError(cause instanceof Error
            ? cause.message : "仓库地址暂时无法检查");
        }).finally(() => {
          if (repositoryProbeRequest.current === request) {
            setRepositoryProbeLoading(false);
          }
        });
    }, 420);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (repositoryProbeRequest.current === request) {
        repositoryProbeRequest.current += 1;
      }
    };
  }, [expectedRepositoryProbeKey, options?.repo.enabled]);

  useEffect(() => {
    if (!options) return;
    const request = ++knowledgePreviewRequest.current;
    const key = expectedKnowledgePreviewKey;
    const controller = new AbortController();
    setKnowledgePreviewLoading(true);
    setKnowledgePreviewError("");
    // 仓库、模块和语言选择都可能连续变化；短防抖只发最后一次权威预览。
    // 序号同时让已经在途但无法 Abort 的旧响应失效。
    const timer = window.setTimeout(() => {
      void getLaunchKnowledgePreview(previewInput, controller.signal).then((result) => {
        if (knowledgePreviewRequest.current !== request) return;
        setKnowledgePreview(result);
        setKnowledgePreviewKey(key);
      }).catch((cause) => {
        if (knowledgePreviewRequest.current !== request) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setKnowledgePreview(undefined);
        setKnowledgePreviewKey(key);
        setKnowledgePreviewError(cause instanceof Error
          ? cause.message : "自动匹配清单暂时无法核对");
      }).finally(() => {
        if (knowledgePreviewRequest.current === request) {
          setKnowledgePreviewLoading(false);
        }
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (knowledgePreviewRequest.current === request) {
        knowledgePreviewRequest.current += 1;
      }
    };
  }, [expectedKnowledgePreviewKey, options, knowledgePreviewRefresh]);

  // 团队工作流是可选增强：目录暂时不可用时仍可用 Mae-Flow 标准方案
  // 正常下单，不能把团队资产读失败升级成新门禁。
  useEffect(() => {
    let alive = true;
    void listWorkflowAssets().then((result) => {
      if (!alive) return;
      setWorkflowAssets(result.items);
      setWorkflowAssetsLoaded(true);
      if (result.warnings.length) {
        setWorkflowSelectionNotice(`部分工作流暂不可见：${result.warnings.join("；")}`);
      }
    }).catch(() => {
      if (!alive) return;
      setWorkflowAssetsLoaded(true);
      setWorkflowSelectionNotice("工作流目录暂不可用，本次继续采用 Mae-Flow 标准方案。");
    });
    return () => { alive = false; };
  }, []);

  // 始终保留当前渲染对应的完整快照。关闭弹层时组件会立刻卸载，不能
  // 再依赖 300ms 防抖回调读取状态；ref 让卸载/pagehide 都能同步落盘。
  latestDraft.current = {
    version: LAUNCH_DRAFT_VERSION,
    updatedAt: new Date().toISOString(),
    title,
    requirement,
    requirementMaterials,
    repos,
    repositoryTickets,
    collaborators,
    ticket,
    baseline,
    productVersion,
    lane,
    repairRounds,
    taskInstructions,
    businessModuleId,
    workflowSelection,
    repositoryTechnologies: repositoryTechnologies.map((item) => ({
      ...item, technologies: [...item.technologies],
    })),
  };

  const persistDraft = (showSaved = true) => {
    const draft = latestDraft.current;
    if (!draft || discardDraftOnClose.current) return;
    try {
      localStorage.setItem(storageKey("draft", session.username),
        JSON.stringify(draft));
      if (showSaved) setDraftSavedAt(draft.updatedAt);
    } catch {
      // 草稿是体验增强；浏览器禁用存储时不阻止发起任务。
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(persistDraft, 300);
    return () => window.clearTimeout(timer);
  }, [title, requirement, requirementMaterials, repos, repositoryTickets,
    collaborators, ticket,
    baseline, productVersion, lane, repairRounds, taskInstructions,
    businessModuleId,
    workflowSelection, repositoryTechnologies,
    session.username]);

  useEffect(() => {
    const flushDraft = () => persistDraft(false);
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      // 也覆盖父页面切栏目、快捷入口把发起弹层直接卸载的情况。
      flushDraft();
    };
  }, [session.username]);

  useEffect(() => {
    if (!workflowAssetsLoaded || !workflowSelection) return;
    const selected = workflowAssets.find((item) => item.id === workflowSelection.id);
    if (!selected?.selectable_for_tasks) {
      setWorkflowSelection(undefined);
      setWorkflowSelectionNotice(
        "草稿中选择的工作流已归档、未发布或不可见，已明确回退到 Mae-Flow 标准方案。");
    }
  }, [workflowAssets, workflowAssetsLoaded, workflowSelection]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting && !documentLoading) {
        persistDraft();
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, submitting, documentLoading]);

  function changeRepository(index: number, value: string) {
    setRepos((current) => current.map(
      (item, itemIndex) => itemIndex === index ? value : item));
  }

  function addRepository() {
    setRepos((current) => [...current, ""]);
    setRepositoryTickets((current) => [...current, ""]);
  }

  function removeRepository(index: number) {
    setRepos((current) => current.filter(
      (_, itemIndex) => itemIndex !== index));
    setRepositoryTickets((current) => current.filter(
      (_, itemIndex) => itemIndex !== index));
  }

  function changeRepositoryTicket(index: number, value: string) {
    setRepositoryTickets((current) => current.map(
      (item, itemIndex) => itemIndex === index ? value : item));
  }

  function changeBaseline(value: string) {
    setBaseline(value);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || (!requirement.trim() && !requirementMaterials.length) || submitting || blocked) return;
    if (!businessModules.some(module => module.id === businessModuleId)) {
      setError("请选择所属业务模块；暂无模块时，请先到配置中心创建");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const created = await createTask(
        requirement.trim(),
        session.username,   // 归属人=本人;管理员不发起任务(入口已隐藏)
        {
          title: title.trim(),
          repo: repoFieldsEnabled ? repos[0]?.trim() || undefined : undefined,
          repos: repoFieldsEnabled
            ? repos.map((item) => item.trim()).filter(Boolean) : [],
          repositoryTickets: repoFieldsEnabled && options?.ticket.enabled
              && !ticketsDeferred
            ? Object.fromEntries(repos.flatMap((repo, index) => {
                const normalized = repo.trim();
                return normalized
                  ? [[normalized, repositoryTickets[index]?.trim() ?? ""]] : [];
              })) : undefined,
          // 主任务参与人只参与澄清和讨论，不与仓库绑定；最终交付单元
          // 的执行人在拆分确认时再选择。
          collaborators: analysisTeamVisible ? collaborators : undefined,
          // select 虽然会视觉显示第一项，但用户没手动切换时 state 仍是
          // 空串；提交必须使用屏幕上真正显示的默认项。
          lane: lane || options?.workflows[0]?.label,
          ticket: ticketsDeferred ? undefined : ((repoFieldsEnabled
            ? repositoryTickets.find((_, index) => repos[index]?.trim())
            : ticket) ?? "").trim() || undefined,
          baseline: baseline.trim() || undefined,
          productVersion,
          repairRounds: repairRounds.trim() === ""
            ? undefined : Number(repairRounds),
          // 精确工作流与自由补充不叠加，避免用户选了一个方案，Agent
          // 又同时收到另一套阶段指令。特殊要求写在需求正文即可。
          taskInstructions: workflowSelection
            ? undefined : taskInstructions.trim() || undefined,
          workflowSelection,
          selectedBusinessModuleIds, businessModuleId,
          knowledgePreviewDigest: knowledgePreview?.selection_digest,
          // 团队通用知识不由下单人逐项治理。字段始终缺席，服务端按
          // 仓库、技术栈和业务模块在创建现场自动匹配并固定版本。
          repositoryProfiles: repoFieldsEnabled
              && repositoryTechnologies.length > 0
              && repositoryTechnologies.every((item) =>
                item.confirmed && item.technologies.length > 0)
            ? asRepositoryProfiles(repositoryTechnologies) : undefined,
          requirementMaterialIds: requirementMaterials.length
            ? requirementMaterials.map(material => material.id) : undefined,
        },
      );
      const usedRepos = repos.map((item) => item.trim()).filter(Boolean);
      const recentRepos = [...new Set([
        ...usedRepos,
        ...(savedPreferences?.recentRepos ?? []),
      ])].slice(0, 5);
      discardDraftOnClose.current = true;
      try {
        localStorage.setItem(storageKey("preferences", session.username),
          JSON.stringify({
            recentRepos,
            baseline: baseline.trim(),
            lane: lane || options?.workflows[0]?.label,
          } satisfies LaunchPreferences));
        localStorage.removeItem(storageKey("draft", session.username));
      } catch {
        // 不影响已经成功创建的任务。
      }
      await onCreated(created);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : "任务没有发起成功，请检查服务后重试。");
      // 目录可能恰在预览后发生了版本变化。任何创建失败都重新核对一次，
      // 尤其让 selection_digest 冲突恢复成可见的新清单，而不是反复提交旧版。
      setKnowledgePreviewLoading(true);
      setKnowledgePreviewKey("");
      setKnowledgePreviewRefresh((current) => current + 1);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="workspace-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="launch-workspace-title"
    >
      <header className="ws-head">
        <Button type="button" variant="outline" size="sm" onClick={() => {
          persistDraft();
          onClose();
        }} disabled={submitting || documentLoading} aria-label="取消创建任务">
          <svg viewBox="0 0 20 20" aria-hidden><path d="m6 6 8 8M14 6l-8 8" /></svg>
          <span>取消</span>
        </Button>
        <div className="ws-identity">
          <div className="ws-identity-line"><code>新任务</code></div>
          <strong id="launch-workspace-title">创建交付任务</strong>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-faint">
          <i aria-hidden className="size-1.5 rounded-full bg-success" />草稿自动保存</span>
      </header>

      {/* 原 .launch-workspace-body:占满弹层剩余高度自滚动,页面底色上
          洗一层右上角 accent 光晕(背景两段式经任意值直译)。 */}
      <main className="min-h-0 flex-1 overflow-y-auto bg-(--page) px-8 pt-[26px] pb-[42px] [background-image:radial-gradient(circle_at_78%_0,var(--accent-soft),transparent_34%)] max-[760px]:px-3.5 max-[760px]:pt-5 max-[760px]:pb-9">
        <section className="mx-auto w-[min(1380px,100%)] rounded-lg border border-line bg-surface shadow-(--shadow-xs) max-[480px]:rounded-md" aria-labelledby="launch-title">
          <div className="min-w-0 rounded-lg px-[26px] pt-6 pb-7 max-[1080px]:px-6 max-[1080px]:pt-[22px] max-[1080px]:pb-6 max-[760px]:px-3.5 max-[760px]:pt-[17px] max-[760px]:pb-5">
            <div className="mb-[18px] flex min-h-[42px] items-center justify-between gap-[18px]">
              <div className="grid gap-0.5">
                <span className="font-mono text-xs font-bold text-primary">发起任务</span>
                <strong id="launch-title" className="text-xl text-text-strong">说清任务，确认交付位置</strong>
                <p className="mt-0.5 text-[13px] leading-normal text-muted-foreground">必填信息都在当前页面；模块知识随所属业务模块自动带入。</p>
              </div>
              <small className="inline-flex items-center gap-1.5 text-sm text-muted-foreground max-[760px]:hidden">
                <i aria-hidden className="size-1.5 rounded-full bg-primary" /> 必填项始终可见</small>
            </div>
            {(title.trim() || requirement.trim() || requirementMaterials.length > 0 || repos.some((repo) => repo.trim()))
              && draftSavedAt && <div className="-mt-1 mb-3.5 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-[11px] py-[9px] text-sm text-muted-foreground" role="status">
                <span>草稿已自动保存 · {new Date(draftSavedAt).toLocaleTimeString([], {
                  hour: "2-digit", minute: "2-digit",
                })}</span>
                <Button type="button" variant="ghost" size="sm" className="text-primary" disabled={submitting || documentLoading} onClick={() => {
                  setTitle("");
                  setRequirement("");
                  setRequirementMaterials([]);
                  setMaterialPreview(undefined);
                  setRepos([""]);
                  setRepositoryTickets([""]);
                  setCollaborators([]);
                  setTicket("");
                  setBusinessModuleId("");
                  setRepositoryTechnologies([]);
                  // 清空必须清干净:执行补充/交付方式/基线/修复轮/工作流
                  // 选择原来被留着,上一单的指示会悄悄跟进下一单,而且
                  // 下一拍自动保存又把它们写回草稿(2026-08-30 审计)。
                  setTaskInstructions("");
                  setWorkflowSelection(undefined);
                  setLane("");
                  setBaseline("");
                  setRepairRounds("");
                  setError("");
                  try { localStorage.removeItem(storageKey("draft", session.username)); } catch { /* noop */ }
                }}>清空草稿</Button>
              </div>}

            {optionsLoading && <div className="mb-3.5 rounded-lg border border-line bg-surface-2 px-3.5 py-[13px] text-sm text-muted-foreground">正在读取任务配置…</div>}
            {optionsError && <Alert variant="destructive" className="mb-3.5" role="alert"><strong>暂时无法发起</strong><p>{optionsError}</p></Alert>}
            {!optionsLoading && blockers.length > 0 && (
              <Alert variant="warning" className="mb-3.5" role="alert">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden className="grid size-[25px] shrink-0 place-items-center rounded-lg bg-(--attention-soft) text-[13px] font-extrabold text-attention">!</span>
                  <div className="grid gap-0.5"><strong className="text-[13.5px] text-text-strong">还差 {blockers.length} 项配置</strong><small className="text-sm text-muted-foreground">补齐后即可发起任务</small></div>
                </div>
                <ul className="m-0 mt-2.5 grid list-none gap-[5px] p-0">
                  {blockers.map((item) => (
                    <li key={item.key} className="flex items-baseline gap-2 text-sm leading-normal">
                      <Badge variant={item.where === "admin" ? "neutral" : "destructive"} className="shrink-0">
                        {item.where === "admin" ? "管理员" : "你自己"}
                      </Badge>
                      {item.label}
                    </li>
                  ))}
                </ul>
                <p className="mb-0 mt-[9px] text-sm leading-normal text-muted-foreground">个人凭据只能由本人在“个人设置”配置，密钥不会回显。</p>
              </Alert>
            )}

            {/* 原 .composer.launch-composer:双栏工作面——左需求右交付,
                交付方式/知识区/按需区/提交栏跨双栏;1120px 起退单列。 */}
            <form className="grid grid-cols-[minmax(0,1.58fr)_minmax(360px,0.92fr)] items-start gap-3.5 max-[1120px]:grid-cols-1" onSubmit={submit}>
              <RepositoryResourceNotice repositories={repositoriesToProbe} baseline={baseline} />
              <section className={cn(SECTION, "col-start-1 row-start-1 h-full max-[1120px]:col-start-1 max-[1120px]:row-auto")}>
                <SectionHead step="1" title="任务与需求" note="说清目标、范围和完成标准即可" mark="必填" />
                <label className="block max-w-[680px]">
                  <span className={FIELD_LABEL}>任务名称</span>
                  <Input type="text" value={title} maxLength={80}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="例如：修复通知模板变量缺失"
                    autoFocus required />
                </label>
                <div className="space-y-3 pt-1">
                  <label className="grid gap-2 text-sm font-bold text-muted-foreground" htmlFor="launch-requirement">
                    {requirementMaterials.length ? "补充说明（可选）" : "需求说明"}
                    <Textarea id="launch-requirement" className="min-h-40 resize-y font-normal"
                      value={requirement} onChange={event => setRequirement(event.target.value)}
                      placeholder="可直接填写需求，也可上传多份文档；这里填写的说明会与所有文档一起保留"
                      rows={6} required={!requirementMaterials.length} disabled={submitting} />
                  </label>
                  <KnowledgeMaterialUpload purpose="requirement" materials={requirementMaterials}
                    onChange={setRequirementMaterials} onBusy={setDocumentLoading} disabled={submitting} />
                  {requirementMaterials.length > 0 && <div aria-label="完整需求预览" className="rounded-lg border border-line bg-surface p-3">
                    <div className="mb-3 flex items-center justify-between gap-3 border-b border-line pb-2 text-sm">
                      <strong>完整需求预览</strong><span className="text-muted-foreground">补充说明与全部资料共同构成需求</span>
                    </div>
                    {materialPreview?.key === materialPreviewKey && materialPreview.error
                      ? <div role="alert" className="flex items-center gap-3 text-sm text-danger">
                          <span>{materialPreview.error}</span><Button type="button" size="xs" variant="outline"
                            onClick={() => { setMaterialPreview(undefined); setMaterialPreviewRetry(value => value + 1); }}>重试预览</Button>
                        </div>
                      : materialPreviewBlocked
                        ? <p role="status" className="text-sm text-muted-foreground">{requirementMaterials.some(material => material.state !== "ready")
                            ? "请先处理解析失败的资料，完整预览将包含所有已上传文件。" : "正在合并全部资料并生成预览…"}</p>
                        : materialPreview?.preview && <>
                            {!!materialPreview.preview.warnings.length && <details className="mb-3 text-sm text-amber-700">
                              <summary>有 {materialPreview.preview.warnings.length} 条解析提醒</summary>
                              <ul>{materialPreview.preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                            </details>}
                            <div className="max-h-[520px] overflow-auto">
                              <Markdown showLineNumbers text={materialPreview.preview.requirement}
                                resolveImage={path => {
                                  const asset = materialPreview.preview?.assets.find(item => item.path === path);
                                  return asset ? `data:${asset.mime_type};base64,${asset.content_base64}` : undefined;
                                }} />
                            </div>
                          </>}
                  </div>}
                </div>
              </section>

              {options && deliveryLocationVisible && (
                <section className={cn(SECTION, "col-start-2 row-start-1 max-[1120px]:col-start-1 max-[1120px]:row-auto")}>
                  <SectionHead step="2" title="交付定位" note="让 Agent 进入正确仓库和基线" mark="必填" />
                  {!options.repo.enabled && <div className="grid gap-1.5" role="status">
                    <label className="block">
                      <span className={FIELD_LABEL}>代码仓</span>
                      <Input type="text" disabled placeholder="当前部署不支持逐单选择代码仓"
                        aria-describedby="launch-repository-unavailable" />
                    </label>
                    <p id="launch-repository-unavailable" className="mb-0 text-sm text-muted-foreground">
                      {options.repo.disabled_reason
                        || "当前部署未开放代码仓选择，请联系管理员检查部署模式。"}
                    </p>
                  </div>}
                  {options.repo.enabled && (
                    <div className="grid gap-1.5">
                      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
                        <span className="text-sm font-bold text-text">{ticketsDeferred ? "待分析的代码仓" : "代码仓与对应 AR 单号"}
                          {options.repo.required ? "（至少一个）" : ""}</span>
                        <small className="shrink-0 text-right text-sm text-muted-foreground">{ticketsDeferred
                          ? "给 AI 查看代码的候选范围；不代表已经拆分或分工"
                          : "一个仓一行；需要共同讨论的人在下方统一邀请"}</small>
                      </div>
                      <div className="grid gap-[7px]">
                        {repos.map((value, index) => (
                          <div key={index}
                            className={cn("grid grid-cols-[28px_minmax(0,1fr)_30px] items-center gap-[7px]",
                              options.ticket.enabled && !ticketsDeferred
                              && "grid-cols-[28px_minmax(0,1.35fr)_minmax(135px,0.58fr)_30px] max-[760px]:grid-cols-[28px_minmax(0,1fr)] max-[760px]:[&>input:nth-of-type(2)]:col-[2/-1]")}>
                            <span className="text-center font-mono text-xs font-bold text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                            <Input type="text" value={value}
                              onChange={(event) => changeRepository(index, event.target.value)}
                              placeholder="https://codehub…/team/project.git"
                              aria-label={`第 ${index + 1} 个代码仓地址`}
                              list="launch-recent-repositories"
                              spellCheck={false}
                              aria-invalid={Boolean(value.trim()
                                && repositoryProbeSettled
                                && repositoryProbeByUrl.get(value.trim())
                                  ?.reachable === false)}
                              required={options.repo.required} />
                            {options.ticket.enabled && !ticketsDeferred
                              && <Input type="text"
                              value={repositoryTickets[index] ?? ""}
                              onChange={(event) => changeRepositoryTicket(
                                index, event.target.value)}
                              placeholder="该仓对应的 AR 单号"
                              aria-label={`第 ${index + 1} 个仓库的 AR 单号`}
                              aria-invalid={Boolean((repositoryTickets[index] ?? "").trim()
                                && /\s/.test((repositoryTickets[index] ?? "").trim()))}
                              spellCheck={false}
                              required={options.ticket.required && Boolean(value.trim())} />}
                            {repos.length > 1 && <Button type="button"
                              variant="outline" size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={`移除第 ${index + 1} 个仓库`}
                              onClick={() => removeRepository(index)}>×</Button>}
                            {value.trim() && <small
                              className={cn("col-[2/-1] -mt-0.5 flex items-center gap-1.5 text-sm leading-tight before:size-1.5 before:shrink-0 before:rounded-full before:bg-current",
                                repositoryProbeLoading || !repositoryProbeSettled
                                  ? "text-primary"
                                  : repositoryProbeByUrl.get(value.trim())?.reachable
                                    ? "text-success" : "text-danger")}
                              role={repositoryProbeSettled
                                && repositoryProbeByUrl.get(value.trim())?.reachable === false
                                ? "alert" : "status"}>
                              {repositoryProbeLoading || !repositoryProbeSettled
                                ? "正在检查仓库地址…"
                                : repositoryProbeByUrl.get(value.trim())?.message
                                  ?? repositoryProbeError
                                  ?? "仓库地址暂时无法检查"}
                            </small>}
                          </div>
                        ))}
                      </div>
                      <Button type="button" variant="outline" size="sm"
                        className="w-fit border-dashed text-primary"
                        onClick={addRepository}>
                        <span>＋</span> 添加代码仓
                      </Button>
                      {options.ticket.enabled && !ticketsDeferred
                        && <small className="text-sm text-muted-foreground">
                        请填写每个仓自己的 AR 对应 REQ 单号，不要填 FuR；两者格式相同，系统无法自动识别。
                      </small>}
                      {/* 多仓天然先形成主任务共同分析,开关开不开结果一样;
                          留着它只会让人以为还有得选(2026-09-02 检视)。 */}
                      {analysisEligible && multiRepository && (
                        <small className="text-sm text-muted-foreground">
                          多个代码仓会先形成主任务共同分析，拆分后再逐单元填写执行人与 AR 单号。
                        </small>
                      )}
                      {analysisTeamVisible && <LaunchRequirementTeam
                        owner={session}
                        people={collaborationAssignees}
                        selected={collaborators}
                        loaded={collaborationAssigneesLoaded}
                        error={collaborationAssigneesError}
                        onChange={setCollaborators}
                      />}
                      <datalist id="launch-recent-repositories">
                        {(savedPreferences?.recentRepos ?? []).map((repo) => (
                          <option key={repo} value={repo} />
                        ))}
                      </datalist>
                    </div>
                  )}
                  {options.repo.enabled && <RepositoryTechnologyPicker
                    repositories={repos}
                    value={repositoryTechnologies}
                    onChange={setRepositoryTechnologies} />}
                  {((options.ticket.enabled && !options.repo.enabled)
                    || options.baseline.enabled) && (
                    <div className="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 max-[760px]:grid-cols-1 max-[760px]:gap-2.5">
                      {options.ticket.enabled && !options.repo.enabled && (
                        <label className="block">
                          <span className={FIELD_LABEL}>AR 对应的 REQ 单号
                            {options.ticket.required ? "（必填）" : ""}</span>
                          <Input type="text" value={ticket}
                            onChange={(event) => setTicket(event.target.value)}
                            placeholder="例如：REQ2026xxxx"
                            spellCheck={false}
                            required={options.ticket.required} />
                          <small className="mt-[7px] block text-sm font-semibold leading-normal text-attention">
                            请确认这是 AR 对应的 REQ 单号，不要填写 FuR 对应的 REQ 单号；
                            两者格式相同，系统无法自动识别。
                          </small>
                        </label>
                      )}
                      {options.baseline.enabled && (
                        <ProductVersionPicker value={productVersion} baseline={baseline}
                          onLegacyBranch={changeBaseline}
                          onChange={(version, branch) => { setProductVersion(version); changeBaseline(branch); }} />
                      )}
                    </div>
                  )}
                  <label className="mt-3 block">
                    <span className={FIELD_LABEL}>所属业务模块（必填）</span>
                    <select required className="h-10 w-full rounded-md border border-line bg-surface px-3 text-base"
                      value={businessModuleId} onChange={event => setBusinessModuleId(event.target.value)}>
                      <option value="">请选择所属业务模块</option>
                      {businessModules.map(module => <option key={module.id} value={module.id}>{module.name}</option>)}
                    </select>
                    {!businessModules.length && <span className="mt-1 block text-sm text-muted-foreground">暂无业务模块，请先到配置中心创建。</span>}
                  </label>
                  <div className="mt-2 flex items-center gap-3 text-sm">
                    <a href="/configuration?tab=modules" target="_blank" rel="noopener noreferrer"
                      className="text-primary underline" onClick={() => persistDraft(false)}>没有合适的模块？去配置中心新建 ↗</a>
                    <button type="button" className="text-primary underline"
                      onClick={() => window.dispatchEvent(new Event("refresh-business-modules"))}>刷新模块</button>
                    <span className="text-muted-foreground">原页草稿保留，返回后自动刷新</span>
                  </div>
                  {moduleRefreshError && <p role="status" className="mt-1 text-sm text-danger">{moduleRefreshError}</p>}
                </section>
              )}
              {options && options.workflows.length > 0 &&
                <section className={cn(SECTION, "col-span-full row-start-2 max-[1120px]:row-auto",
                  !deliveryLocationVisible && "col-start-2 row-auto self-stretch")}>
                  <SectionHead step="3" title="交付方式" note="选择最接近本次任务的交付规模" mark="必填" />
                  <fieldset className="col-span-full m-0 min-w-0 border-0 p-0">
                    {/* 原生 radio 换 RadioGroup:required/name 交由组级
                        属性(表单校验语义不变),选中皮交 RadioGroupItem。 */}
                    <RadioGroup
                      className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2 max-[760px]:grid-cols-1"
                      name="delivery-workflow"
                      required
                      value={lane || options.workflows[0].label}
                      onValueChange={(value) => setLane(value)}>
                      {options.workflows.map((item) => (
                        <label key={item.key}
                          className={cn("relative grid min-h-[82px] min-w-0 cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-start gap-[9px] rounded-[10px] border px-[11px] py-2.5 text-text transition-[border-color,background,box-shadow] hover:border-line-strong focus-within:border-primary focus-within:ring-3 focus-within:ring-[color-mix(in_srgb,var(--accent)_11%,transparent)]",
                            (lane || options.workflows[0].label) === item.label
                              ? "border-primary bg-(--accent-soft) shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_8%,transparent)]"
                              : "border-line",
                            "max-[760px]:min-h-0")}>
                          <RadioGroupItem value={item.label} />
                          <span className="grid min-w-0 gap-0.5"><strong className="text-sm text-text-strong">{item.label}</strong>
                            {item.description && <small className="line-clamp-2 text-sm leading-snug text-muted-foreground">{item.description}</small>}</span>
                        </label>
                      ))}
                    </RadioGroup>
                  </fieldset>
                </section>}

              {/* 原 .launch-knowledge-quick:accent 软底的自动匹配速览,
                  degraded/blocked 态原是区块类驱动计数药丸变色,现直接
                  落在 Badge 的条件类上。 */}
              {options && <section
                className="col-span-full min-w-0 rounded-lg border border-[color-mix(in_srgb,var(--accent)_24%,var(--line))] bg-[color-mix(in_srgb,var(--accent-soft)_38%,var(--surface))] px-3.5 py-[13px]"
                aria-label="自动匹配的平台知识清单">
                <header className="flex items-center justify-between gap-3.5">
                  <div className="grid min-w-0 gap-0.5"><span className="font-mono text-xs font-bold text-primary">自动匹配</span><strong className="text-[15px] text-text-strong">平台管理的本任务知识</strong>
                    <small className="text-sm leading-snug text-muted-foreground">按业务模块、代码仓、语言和工作流匹配平台知识；无需手工勾选</small></div>
                  <em className={cn("shrink-0 rounded-full bg-surface px-2 py-1 text-xs font-extrabold not-italic shadow-[inset_0_0_0_1px_var(--line)]",
                    knowledgePreview?.degraded ? "text-attention"
                      : knowledgePreview && !knowledgePreview.complete
                        ? "text-danger" : "text-primary")}>
                    {knowledgePreviewLoading || !previewSettled
                      ? "核对中…"
                      : knowledgePreviewError ? "暂不可用"
                        : `${selectedKnowledgeCount} 项`}</em>
                </header>
                <p className="mt-2.5 mb-0 text-[13px] leading-normal text-faint">
                  下单页自动带入知识库已同步并保留的模块文档与平台 Skill；仓库里的 <code>AGENTS.md</code> 和其他未纳入知识库的项目规则，仍由 Agent 运行时自行读取。
                </p>
                {knowledgePreviewLoading || !previewSettled ? (
                  <div className="mt-2.5 rounded-lg bg-surface px-[11px] py-2.5 text-xs text-muted-foreground">正在核对知识名称、版本与作用域…</div>
                ) : knowledgePreviewError ? (
                  <div className="mt-2.5 grid gap-[3px] rounded-lg bg-[color-mix(in_srgb,var(--danger)_9%,var(--surface))] px-[11px] py-[9px] text-xs">
                    <strong className="text-danger">知识清单暂时无法核对</strong><span className="leading-snug text-muted-foreground">{knowledgePreviewError}</span>
                  </div>
                ) : <>
                  {knowledgePreview?.degraded && (
                    <div className={cn("mt-2.5 grid gap-[3px] rounded-lg px-[11px] py-[9px] text-xs",
                      knowledgePreview.complete
                        ? "bg-(--attention-soft)"
                        : "bg-[color-mix(in_srgb,var(--danger)_9%,var(--surface))]")}>
                      <strong className={cn("text-text-strong",
                        knowledgePreview.complete ? "text-attention" : "text-danger")}>{knowledgePreview.complete
                        ? "部分可选知识暂不可用，本次按下面的可用清单继续"
                        : "明确选择的知识暂时无法固定"}</strong>
                      <span className="leading-snug text-muted-foreground">{knowledgeNotices.map((notice) => notice.message)
                        .slice(0, 2).join("；")}</span>
                    </div>
                  )}
                  {selectedKnowledgeCount > 0 ? (
                    <div className="mt-2.5 grid max-h-[220px] grid-cols-[repeat(2,minmax(0,1fr))] gap-[7px] overflow-auto [scrollbar-gutter:stable] max-[680px]:grid-cols-1">
                      {matchingModuleKnowledge.map((item) => (
                        <a key={`business/${item.module_id}/${item.id}`}
                          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-line bg-surface px-[9px] py-2 no-underline transition-[border-color,transform] hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent)_50%,var(--line))]"
                          href={knowledgeAssetPath({ kind: "business",
                            moduleId: item.module_id, assetId: item.id,
                            version: item.version, digest: item.digest })}
                          onClick={(event) => {
                            if (!isPlainKnowledgeActivation(event)) return;
                            event.preventDefault(); persistDraft();
                            onOpenKnowledgeAsset({ kind: "business",
                              moduleId: item.module_id, assetId: item.id,
                              version: item.version, digest: item.digest });
                          }}>
                          <b className="rounded-md bg-(--accent-soft) px-[5px] py-[3px] text-xs text-primary">业务</b><span className="grid min-w-0 gap-0.5"><strong className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-strong">{item.title}</strong>
                            <small className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">{describeMatchedScope(item)}</small></span>
                        </a>
                      ))}
                      {matchingTeamSkills.map((item) => (
                        <a key={`skill/${item.path}`}
                          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-line bg-surface px-[9px] py-2 no-underline transition-[border-color,transform] hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent)_50%,var(--line))]"
                          href={knowledgeAssetPath({ kind: "skill",
                            directory: item.path.split("/")[0] || item.path,
                            digest: item.digest,
                            packageDigest: item.package_digest })}
                          onClick={(event) => {
                            if (!isPlainKnowledgeActivation(event)) return;
                            event.preventDefault(); persistDraft();
                            onOpenKnowledgeAsset({ kind: "skill",
                              directory: item.path.split("/")[0] || item.path,
                              digest: item.digest,
                              packageDigest: item.package_digest });
                          }}>
                          <b className="rounded-md bg-(--accent-soft) px-[5px] py-[3px] text-xs text-primary">平台 Skill</b><span className="grid min-w-0 gap-0.5"><strong className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-strong">{item.name}</strong>
                            <small className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">{describeMatchedScope(item)}</small></span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <Empty className="mt-2.5 p-2.5">
                      <EmptyDescription>当前没有匹配到 Mae-Flow 平台管理的知识；不影响发起。</EmptyDescription>
                    </Empty>
                  )}
                </>}
              </section>}

              {options && <details className="group col-span-full min-w-0 overflow-hidden rounded-lg border border-line bg-surface" open={advancedOpen}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                <summary className="grid min-h-[68px] cursor-pointer list-none grid-cols-[34px_minmax(250px,1fr)_auto_20px] items-center gap-3 bg-[color-mix(in_srgb,var(--surface-soft)_74%,var(--surface))] px-4 py-3 transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden max-[680px]:grid-cols-[34px_minmax(0,1fr)_18px] max-[680px]:items-start max-[680px]:gap-x-2.5 max-[680px]:gap-y-2 max-[680px]:px-3 max-[680px]:py-[11px]">
                  <span aria-hidden className="grid size-[34px] place-items-center rounded-lg bg-(--accent-soft) text-primary max-[680px]:col-start-1 max-[680px]:row-span-2 max-[680px]:row-start-1">
                    <svg viewBox="0 0 20 20" className="size-[18px] fill-none stroke-current stroke-[1.5] [stroke-linecap:round]"><path d="M4 5h12M7 10h9M4 15h12M7 3v4M13 8v4M9 13v4" /></svg>
                  </span>
                  <span className="grid min-w-0 gap-[3px] max-[680px]:col-start-2 max-[680px]:row-start-1"><strong className="text-sm text-text-strong">按需配置</strong>
                    <small className="text-sm text-muted-foreground max-[680px]:[overflow-wrap:anywhere]">工作流、修复设置和 Mae-Flow 平台知识清单</small></span>
                  <span className="flex flex-wrap justify-end gap-1.5 max-[680px]:col-span-2 max-[680px]:col-start-2 max-[680px]:row-start-2 max-[680px]:justify-start">
                    <Badge variant="neutral">{workflowSelection ? "定制工作流" : "标准工作流"}</Badge>
                    {knowledgePreviewLoading || !previewSettled
                      ? <Badge variant="neutral">知识核对中</Badge>
                      : selectedKnowledgeCount > 0
                        ? <Badge variant="neutral">{selectedKnowledgeCount} 项平台知识</Badge>
                        : <Badge variant="neutral">无平台知识</Badge>}
                    {knowledgePreview?.degraded && <Badge variant="warning">{
                      knowledgePreview.complete ? "知识已降级" : "知识需处理"}</Badge>}
                    {repairRounds && <Badge variant={repairRounds === "0"
                      ? "warning" : "neutral"}>{repairRounds === "0"
                        ? "自动修复已关闭" : `${repairRounds} 轮修复`}</Badge>}
                  </span>
                  <svg viewBox="0 0 20 20" aria-hidden className="size-[18px] fill-none stroke-muted-foreground stroke-[1.7] transition-transform [stroke-linecap:round] [stroke-linejoin:round] group-open:rotate-180 max-[680px]:col-start-3 max-[680px]:row-start-1">
                    <path d="m6 8 4 4 4-4" /></svg>
                </summary>
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-3 border-t border-line p-3.5 max-[680px]:grid-cols-1 max-[680px]:p-2.5">
                  <section className={cn(SECTION, "col-span-full",
                    "[&_.wf-scheme-selector]:grid-cols-[minmax(170px,0.65fr)_minmax(280px,1.35fr)_auto_auto]",
                    "max-[680px]:[&_.wf-scheme-selector]:grid-cols-[minmax(0,1fr)]!",
                    "max-[680px]:[&_.wf-scheme-title]:min-w-0!")}>
                    <SectionHead step="流" title="工作流与执行提醒" note="只有对阶段编排有明确要求时才调整" />
                    <SchemeSelector workflows={workflowAssets} value={workflowSelection}
                      disabled={!workflowAssetsLoaded}
                      onChange={(selection) => {
                        setWorkflowSelection(selection);
                        setWorkflowSelectionNotice("");
                      }}
                      onOpenEditor={(workflowId) => {
                        persistDraft();
                        onOpenWorkflowAssets?.(workflowId);
                      }} />
                    {workflowSelectionNotice && <p className="mb-0 mt-2.5 text-sm text-attention"
                      role="status">{workflowSelectionNotice}</p>}
                    <div className="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 max-[760px]:grid-cols-1 max-[760px]:gap-2.5">
                      <label className="block max-w-[300px] max-[760px]:max-w-none">
                        <span className={FIELD_LABEL}>修复轮预算</span>
                        <Input type="text" inputMode="numeric" pattern="[0-9]*"
                          value={repairRounds}
                          onChange={(event) => {
                            const value = event.target.value.trim();
                            if (/^\d*$/.test(value)) setRepairRounds(value);
                          }}
                          placeholder={options.repair_rounds !== undefined
                            ? `留空=团队默认 ${options.repair_rounds} 轮；填 0=关闭`
                            : "留空=平台默认 20 轮；填 0=关闭"} />
                        <small className={cn("mt-1.5 block text-sm leading-snug text-muted-foreground",
                          repairRounds === "0"
                            && "rounded-lg border border-[color-mix(in_srgb,var(--danger)_28%,var(--line))] bg-(--danger-soft) px-[9px] py-[7px] font-bold text-danger")}>
                          {repairRounds === "0"
                            ? "本任务已关闭自动修复；检视、冲突或流水线失败将等人处理。"
                            : "留空沿用团队设置；只有明确要关闭自动修复时才填 0。"}
                        </small>
                      </label>
                      {!workflowSelection && <label className="relative col-span-full block rounded-[10px] border border-line bg-[color-mix(in_srgb,var(--surface)_88%,var(--accent-soft))] px-3.5 py-3">
                        <span className={FIELD_LABEL}>给标准方案的补充提醒</span>
                        <Textarea value={taskInstructions} maxLength={2000}
                          className="mt-2 min-h-21 resize-y"
                          onChange={(event) => setTaskInstructions(event.target.value)}
                          placeholder="例如：不确定时明确说明，不要猜；优先兼容旧数据。" />
                        <small className="mt-[7px] block max-w-[calc(100%-80px)] text-sm leading-normal text-muted-foreground">选择定制工作流后不再叠加，避免两套指令摩擦。</small>
                        <em className="absolute bottom-3 right-3.5 font-mono text-xs font-medium not-italic text-faint">{taskInstructions.length}/2000</em>
                      </label>}
                    </div>
                  </section>
              {/* 原 .launch-task-resources:发起前的权威知识清单,区块内
                  自滚动(max-h 410px),窄屏摘要换成两行铺排。 */}
              {options && <section className={cn(SECTION, "col-span-full grid gap-[11px]")}>
                <SectionHead step="知" title="平台管理的本任务知识" mark={knowledgePreviewLoading || !previewSettled
                  ? "核对中" : knowledgePreview?.complete
                    ? knowledgePreview.degraded ? "部分降级" : "权威预览"
                    : "需要处理"} className="mb-px"
                  note="仅展示业务知识与平台团队 Skill；逐项可进入团队资产查看全文" />
                <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-3.5 rounded-lg border border-line bg-surface px-3 py-[11px] max-[680px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[680px]:gap-y-0">
                  <span className="grid min-w-[68px] gap-px max-[680px]:min-w-0"><strong className="text-[18px] text-text-strong">{selectedModuleKnowledgeCount}</strong>
                    <small className="text-xs text-muted-foreground">模块知识</small></span>
                  <span className="grid min-w-[68px] gap-px border-l border-line pl-3.5 max-[680px]:min-w-0"><strong className="text-[18px] text-text-strong">{matchedTeamKnowledgeCount}</strong>
                    <small className="text-xs text-muted-foreground">平台团队资产</small></span>
                  <p className="mb-0 truncate text-right text-xs leading-normal text-muted-foreground max-[680px]:col-span-full max-[680px]:mt-[9px] max-[680px]:border-t max-[680px]:pt-[9px] max-[680px]:text-left max-[680px]:[text-overflow:clip] max-[680px]:whitespace-normal max-[680px]:[overflow-wrap:anywhere]">{previewBusinessModuleIds.length
                    ? `来自 ${previewBusinessModuleIds.map((id) =>
                        businessModules.find((item) => item.id === id)?.name)
                      .filter(Boolean).join("、")} 模块${
                        knowledgePreview?.scope.workflow_business_module_ids.length
                          ? "（含工作流带入）" : ""}`
                    : "尚未关联业务模块；仍会使用匹配的工程知识和平台团队 Skill"}</p>
                </div>
                {(knowledgePreviewError || knowledgeNotices.length > 0)
                  && <Alert variant={knowledgePreview?.complete ? "warning" : "destructive"}
                    role={knowledgePreview?.complete ? "status" : "alert"}
                    className="gap-[3px] px-3 py-2.5 text-xs leading-normal">
                    <AlertTitle className="text-xs">{knowledgePreview?.complete
                      ? knowledgePreview.degraded
                        ? "部分可选知识已降级，本次按当前清单继续"
                        : "自动匹配已应用容量规则"
                      : "明确选择的知识暂时不能固定"}</AlertTitle>
                    {knowledgePreviewError && <span className="[overflow-wrap:anywhere]">{knowledgePreviewError}</span>}
                    {knowledgeNotices.map((notice, index) => <span
                      key={`${notice.source}/${notice.code}/${index}`}
                      className="[overflow-wrap:anywhere]">
                      {notice.message}</span>)}
                  </Alert>}
                <div className="min-w-0 max-h-[410px] overflow-auto rounded-[10px] border border-line bg-surface max-[680px]:max-w-full max-[680px]:overflow-x-hidden" aria-label="自动匹配的平台知识清单">
                  <div className="sticky top-0 z-[2] flex min-h-[42px] items-center justify-between gap-3 border-b border-line bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] px-3 py-[9px] [backdrop-filter:blur(8px)]">
                    <strong className="text-xs text-text-strong">发起前固定清单</strong>
                    <span className="text-xs font-bold text-primary">{knowledgePreviewLoading || !previewSettled
                      ? "正在由服务端核对"
                      : selectedKnowledgeCount
                        ? `共 ${selectedKnowledgeCount} 项` : "没有匹配项"}</span>
                  </div>
                  {!knowledgePreviewLoading && previewSettled
                    && matchingModuleKnowledge.length > 0 && <section
                    className="[&:not(:first-of-type)]:border-t [&:not(:first-of-type)]:border-line">
                    <header className="flex min-h-[33px] items-center justify-between gap-2.5 bg-surface-2 px-3 py-[7px]"><strong className="text-xs text-text">业务知识</strong>
                      <em className="text-xs not-italic text-muted-foreground">{matchingModuleKnowledge.length} 项</em></header>
                    {matchingModuleKnowledge.map((item) =>
                      <LaunchKnowledgeRow key={`${item.module_id}/${item.id}`}
                        form={item.form} title={item.title}
                        summary={item.summary} whenToUse={item.when_to_use}
                        version={`v${item.version}`}
                        scope={describeMatchedScope(item)}
                        href={knowledgeAssetPath({ kind: "business",
                          moduleId: item.module_id, assetId: item.id,
                          version: item.version, digest: item.digest })}
                        onOpen={() => {
                          persistDraft();
                          onOpenKnowledgeAsset({ kind: "business",
                            moduleId: item.module_id, assetId: item.id,
                            version: item.version, digest: item.digest });
                        }} />)}
                  </section>}
                  {!knowledgePreviewLoading && previewSettled
                    && matchingTeamSkills.length > 0 && <section
                    className="[&:not(:first-of-type)]:border-t [&:not(:first-of-type)]:border-line">
                    <header className="flex min-h-[33px] items-center justify-between gap-2.5 bg-surface-2 px-3 py-[7px]"><strong className="text-xs text-text">平台团队 Skill</strong>
                      <em className="text-xs not-italic text-muted-foreground">{matchingTeamSkills.length} 项</em></header>
                    {matchingTeamSkills.map((item) =>
                      <LaunchKnowledgeRow key={item.path} form="skill"
                        title={item.name} summary={item.description}
                        whenToUse=""
                        version={`版本 ${item.digest.slice(0, 8)}`}
                        scope={describeMatchedScope(item)}
                        href={knowledgeAssetPath({ kind: "skill",
                          directory: item.path.split("/")[0] || item.path,
                          digest: item.digest,
                          packageDigest: item.package_digest })}
                        onOpen={() => {
                          persistDraft();
                          onOpenKnowledgeAsset({ kind: "skill",
                            directory: item.path.split("/")[0] || item.path,
                            digest: item.digest,
                            packageDigest: item.package_digest });
                        }} />)}
                  </section>}
                  {!knowledgePreviewLoading && previewSettled
                    && !knowledgePreviewError && selectedKnowledgeCount === 0 && <Empty
                    className="py-4.5">
                    <EmptyDescription>没有匹配到 Mae-Flow 平台管理的知识；不影响发起。</EmptyDescription>
                  </Empty>}
                </div>
                <div className="flex items-baseline gap-2 px-0.5 text-xs leading-normal text-muted-foreground max-[680px]:grid max-[680px]:gap-0.5">
                  <strong className="whitespace-nowrap text-success max-[680px]:whitespace-normal">{knowledgePreviewLoading || !previewSettled
                    ? "正在核对最终名单"
                    : selectedKnowledgeCount
                      ? `将固定 ${selectedKnowledgeCount} 项平台知识` : "将固定 0 项平台知识"}</strong>
                  <span>{knowledgePreview?.complete
                    ? knowledgePreview.degraded
                      ? "可选目录的降级原因已明确列出；创建时仍按本清单指纹核对，目录变化会要求刷新。"
                      : "清单与任务创建复用同一套选择器和容量规则；点击任一项可查看当前全文与版本。"
                    : "明确选择的资产无法固定前不会发起，避免定制工作流缺能力却假装生效。"}</span>
                </div>
              </section>}
                </div>
              </details>}
              {error && <div className="col-span-full mt-2.5 text-base text-danger" role="alert">{error}</div>}
              {/* 原 .launch-submit-bar:贴住弹层可视区底边的提交栏
                  (bottom 负值吃掉 main 的下内边距)。 */}
              <footer className="sticky bottom-[-28px] z-[4] col-span-full flex min-h-[62px] items-center justify-between gap-4 border-t border-line bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-0.5 pt-3 max-[760px]:flex-col max-[760px]:items-stretch">
                <div className="grid gap-[3px]"><strong className="text-sm text-text-strong">{blocked
                  ? documentLoading || materialPreviewBlocked
                    ? "需求资料尚未准备完整"
                  : collaboratorBlocked
                    ? "参与人尚未就绪"
                  : repositoryTicketBlocked
                    ? "请补齐逐仓 AR 单号"
                  : repositoryTechnologyBlocked
                    ? "请选择仓库技术栈"
                  : repositoryProbeBlocked
                    ? repositoryProbeLoading || !repositoryProbeSettled
                      ? "正在检查代码仓"
                      : "代码仓暂不可用"
                  : knowledgePreviewLoading || !previewSettled
                    ? "正在核对知识清单"
                    : knowledgePreviewError || !knowledgePreview?.complete
                      ? "知识清单尚未核对完整"
                      : "暂时不能发起"
                  : "信息确认后即可启动"}</strong><small>{blocked
                  ? documentLoading || materialPreviewBlocked
                    ? "请查看需求资料中的上传、解析或预览结果后重试"
                  : collaboratorBlocked
                    ? "请移除个人设置未就绪的参与人，再发起主任务"
                  : repositoryTicketBlocked
                    ? "每个已填写的代码仓都需要自己的 AR 单号，且单号不能含空格"
                  : repositoryTechnologyBlocked
                    ? "每个代码仓至少选择一种技术栈，系统才能准确匹配工程知识和 Skill"
                  : repositoryProbeBlocked
                    ? repositoryProbeLoading || !repositoryProbeSettled
                      ? "正在确认地址与当前 Git 身份是否真的可访问"
                      : "请根据仓库地址下方的原因修正后再发起"
                  : knowledgePreviewLoading || !previewSettled
                    ? "服务端正在固定本次任务会使用的全文与版本"
                    : knowledgePreviewError || !knowledgePreview?.complete
                      ? "请查看“本任务知识”中的明确原因后重试"
                      : "请先处理上方配置项"
                  : "任务创建后会自动进入你的工作台"}</small></div>
                <Button type="submit" size="lg" className="h-10 min-w-[126px] shadow-[0_6px_16px_color-mix(in_srgb,var(--accent)_23%,transparent)] max-[760px]:w-full"
                  disabled={submitting || blocked}>
                  <span>{submitting
                    ? "正在发起"
                    : optionsLoading
                      ? "读取配置中"
                    : documentLoading || materialPreviewBlocked
                      ? "需求资料未就绪"
                    : collaboratorBlocked
                      ? "参与人未就绪"
                    : repositoryTicketBlocked
                      ? "逐仓单号未完成"
                    : repositoryTechnologyBlocked
                      ? "请选择技术栈"
                    : repositoryProbeBlocked
                      ? repositoryProbeLoading || !repositoryProbeSettled
                        ? "检查仓库中"
                        : "仓库不可用"
                      : knowledgePreviewLoading || !previewSettled
                        ? "核对知识中"
                        : knowledgePreviewError || !knowledgePreview?.complete
                          ? "知识预览未完成"
                      : blocked
                        ? "配置未完成"
                        : "确认发起"}</span>
                  <svg viewBox="0 0 20 20" aria-hidden><path d="M4 10h11M11 6l4 4-4 4" /></svg>
                </Button>
              </footer>
            </form>
          </div>
        </section>
      </main>
    </section>
  );
}
