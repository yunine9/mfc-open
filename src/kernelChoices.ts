/**
 * 内核的交付方式选项——**问内核要,不在 TS 侧另抄一份**。
 *
 * 踩过的坑(2026-08-18 内网实战):下单表单曾自造一套"快速/慢速"车道,
 * 而内核 `workflow_select` 步的真实选项是
 * full/hotfix/tweak/review → 完整开发 / 已定位问题修复 / 局部修改 /
 * 处理评审意见。两套话对不上,于是"下单已选"永远匹配不上内核举的卡,
 * 用户在页面上被再问一遍交付方式——他明明在下单时就答过了。
 *
 * 这正是红线"连阶段→步骤的映射都不许在 TS 侧再抄一份"的实例:分类是
 * 内核的领地。取法优先走**明面上的契约** `mae-flow.py steps --json`
 * (为此在内核里加的宿主口,判定与分类仍归内核);拿不到才退回直接读
 * `flow/flow.json`——那是扒内脏,布局一改就哑,只当兜底。两条都不成
 * (快照残缺/python 不在)就回空数组,调用方退回"不预选",fail-open
 * 到人工,绝不猜一套选项出来。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 一个交付方式:key 是内核的 choice(full/hotfix/…),label 是回传
 * 内核的选项原文；description 只说适用场景，给下单的人做选择。
 * steps/acks 仍是内核目录中的可观测事实，但不再用作下单说明。 */
export interface WorkflowChoice {
  key: string;
  label: string;
  description?: string;
  steps?: number;
  acks?: number;
}

/** 某个人工选项会把内核带到哪里。Cloud 只消费 flow 的审批主题、确认
 * 答案、分支与目标步骤语义，不认识 build_review / Story 等阶段名，也
 * 不另抄一张“哪个按钮算返工”的表。 */
export interface StepChoiceEffect {
  key: string;
  answers: string[];
  nextStep?: string;
  allowsSourceEdit: boolean;
  /** 该选择会留在/进入一个用于落实检视意见的步骤。 */
  handlesFeedback: boolean;
  /** 该选择会关闭当前检视并继续，不应携带未闭环意见。 */
  closesFeedback: boolean;
}

/** 目录里还带着"能不能给新单选"这一位。下单表单要的是能选的那批,
 * 修复环要的恰恰是**不给新单选**的那个(review)——所以缓存存全量,
 * 各取所需,不必为此再问内核第二遍。 */
interface WorkflowEntry extends WorkflowChoice {
  forNewOrders: boolean;
}

const cache = new Map<string, WorkflowEntry[]>();
const effectCache = new Map<string, StepChoiceEffect[]>();
const surfaceCache = new Map<string, "doc" | "diff" | undefined>();

/** 开发机会优先使用兄弟目录的活内核，它可能比 Cloud 收编快照
 * 旧一版。代号/选项原文仍以活内核为准；旧目录只缺新增的场景
 * 说明时，才从与 Cloud 同版发布的内核快照补这一个展示字段。 */
function workflowDescriptions(kernelRoot: string): Record<string, string> {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel");
  for (const root of [...new Set([kernelRoot, bundled])]) {
    try {
      const flow = JSON.parse(readFileSync(join(root, "flow", "flow.json"), "utf-8"));
      const rows = flow?.steps?.workflow_select?.choice_descriptions;
      if (rows && typeof rows === "object") {
        return Object.fromEntries(Object.entries(rows)
          .map(([key, value]) => [key, String(value).trim()])
          .filter(([, value]) => value));
      }
    } catch {
      // 场景说明缺席不影响选项原文与下单。
    }
  }
  return {};
}

/** 首选:问内核要机读目录。python 不在/命令老(旧快照没有 --json)都
 * 只是拿不到,不是错误——静静退回兜底。 */
function fromKernelCommand(kernelRoot: string): WorkflowEntry[] {
  const script = join(kernelRoot, "scripts", "mae-flow.py");
  if (!existsSync(script)) return [];
  const stdout = execFileSync("python3", [script, "steps", "--json"], {
    encoding: "utf-8",
    timeout: 15_000,      // 旁路取值也不许无限等待(红线)
    stdio: ["ignore", "pipe", "ignore"],
  });
  const catalog = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  const descriptions = workflowDescriptions(kernelRoot);
  return ((catalog.workflows ?? []) as Array<Record<string, any>>)
    .map((item) => {
      const chain = (item.steps ?? []) as Array<{ user_ack?: boolean }>;
      const key = String(item.key ?? "");
      const description = String(item.description ?? descriptions[key] ?? "").trim();
      return {
        key,
        // answers[0] 是内核对账用的原文;没有就退回展示名
        label: String(item.answers?.[0] ?? item.label ?? ""),
        ...(description ? { description } : {}),
        forNewOrders: item.for_new_orders !== false,
        ...(chain.length ? {
          steps: chain.length,
          acks: chain.filter((step) => step.user_ack).length,
        } : {}),
      };
    })
    .filter((item) => item.key && item.label);
}

/** 内核流程要求每个单元都写的规格产物在哪(flow.json 的 specs_truth,
 * 如 docs/specs、openspec/specs)。负责面门禁拿它判"这是流程产物,不是
 * 改动面"——每个交付单元都得往这里写规格,它们是全仓共用的流程真相,
 * 不属于任何一个单元认领的文件面(内网实锤:pnp-deploy-contract 单元
 * 因 docs/specs/index.md 被判越界)。模式从内核读,TS 不复刻。 */
export function kernelSpecsTruth(kernelRoot: string | undefined): RegExp | undefined {
  if (!kernelRoot) return undefined;
  const path = join(kernelRoot, "flow", "flow.json");
  if (!existsSync(path)) return undefined;
  try {
    const flow = JSON.parse(readFileSync(path, "utf-8"));
    const pattern = String(flow?.specs_truth ?? "").trim();
    return pattern ? new RegExp(pattern) : undefined;
  } catch {
    return undefined;
  }
}

/** 兜底:直接读 flow.json。够用但耦合内核文件布局,能问就别读。 */
function fromFlowJson(kernelRoot: string): WorkflowEntry[] {
  const path = join(kernelRoot, "flow", "flow.json");
  if (!existsSync(path)) return [];
  const flow = JSON.parse(readFileSync(path, "utf-8"));
  const step = flow?.steps?.workflow_select ?? {};
  const answers = (step.choice_answers ?? {}) as Record<string, string[]>;
  const descriptions = workflowDescriptions(kernelRoot);
  // 字段缺席(老 flow)=全部可给新单选。
  const newOrder = Array.isArray(step.new_order_choices)
    ? new Set((step.new_order_choices as unknown[]).map(String))
    : undefined;
  return ((step.choices ?? []) as unknown[])
    .map((key) => ({
      key: String(key),
      label: answers[String(key)]?.[0],
      ...(String(descriptions[String(key)] ?? "").trim()
        ? { description: String(descriptions[String(key)]).trim() } : {}),
      forNewOrders: !newOrder || newOrder.has(String(key)),
    }))
    .filter((item): item is WorkflowEntry => !!item.label);
}

function allWorkflows(kernelRoot: string | undefined): WorkflowEntry[] {
  if (!kernelRoot) return [];
  const cached = cache.get(kernelRoot);
  if (cached) return cached;
  let entries: WorkflowEntry[] = [];
  for (const read of [fromKernelCommand, fromFlowJson]) {
    try {
      entries = read(kernelRoot);
    } catch {
      entries = [];   // 读不动=不预选,不猜
    }
    if (entries.length) break;
  }
  cache.set(kernelRoot, entries);
  return entries;
}

/** 下单表单能列的交付方式:只有新单可选的那批。review 仅限已交付单
 * (内核目录的 for_new_orders,来源是 flow.json 的 new_order_choices)
 * ——新单选它跳过设计与定稿还不碰规格,必错;检视意见由修复环自动走。 */
export function workflowChoices(kernelRoot: string | undefined): WorkflowChoice[] {
  return allWorkflows(kernelRoot)
    .filter((item) => item.forNewOrders)
    .map(({ forNewOrders: _drop, ...choice }) => choice);
}

/** 某个交付方式回传给内核的**选项原文**;问不到内核就回空串。
 * 修复环要拿它写下单事实,而 workflowChoices 按设计把 review 滤掉了。
 * 别在调用方写死"处理评审意见"——那正是本文件开头那条教训。 */
export function workflowLabel(
  kernelRoot: string | undefined,
  key: string,
): string {
  return allWorkflows(kernelRoot).find((item) => item.key === key)?.label ?? "";
}

/** 读取一步的选项效果。拿不到契约就回空数组：界面不替内核猜分支，
 * 服务端也保持旧行为；拿得到时，附带待修改批注就能与真正的可写返工
 * 分支联动。 */
export function stepChoiceEffects(
  kernelRoot: string | undefined,
  stepId: string | undefined,
): StepChoiceEffect[] {
  if (!kernelRoot || !stepId) return [];
  const cacheKey = `${kernelRoot}\0${stepId}`;
  const cached = effectCache.get(cacheKey);
  if (cached) return cached;
  let effects: StepChoiceEffect[] = [];
  try {
    const path = join(kernelRoot, "flow", "flow.json");
    if (!existsSync(path)) return [];
    const flow = JSON.parse(readFileSync(path, "utf-8"));
    const steps = (flow?.steps ?? {}) as Record<string, Record<string, any>>;
    const step = steps[stepId] ?? {};
    const answers = (step.choice_answers ?? {}) as Record<string, unknown[]>;
    const next = step.next && typeof step.next === "object"
      ? step.next as Record<string, unknown> : {};
    const reviewsFeedback = Boolean(step.approval_subject);
    effects = ((step.choices ?? []) as unknown[]).map((rawKey) => {
      const key = String(rawKey);
      const nextStep = next[key] === undefined ? undefined : String(next[key]);
      const target = nextStep ? steps[nextStep] : undefined;
      const handlesFeedback = reviewsFeedback && Boolean(
        target?.clear_hint || target?.allow_source_edit);
      return {
        key,
        answers: Array.isArray(answers[key])
          ? answers[key].map(String).filter(Boolean) : [],
        ...(nextStep ? { nextStep } : {}),
        allowsSourceEdit: Boolean(target?.allow_source_edit),
        handlesFeedback,
        closesFeedback: reviewsFeedback && !handlesFeedback,
      };
    }).filter((effect) => effect.key && effect.answers.length);
    // Spec/Story/轻量范围检视在原步骤内修改材料，只有“确认答案”是
    // 内核契约；其余回答会让 Agent 留在本步继续处理。把确认建模成关闭
    // 效果，界面再从真实问题卡的其他选项中推荐“需要调整”。
    if (!effects.length && reviewsFeedback
        && Array.isArray(step.confirmation_answers)) {
      const nextStep = typeof step.next === "string" ? step.next : undefined;
      effects = [{
        key: "confirm",
        answers: step.confirmation_answers.map(String).filter(Boolean),
        ...(nextStep ? { nextStep } : {}),
        allowsSourceEdit: Boolean(nextStep && steps[nextStep]?.allow_source_edit),
        handlesFeedback: false,
        closesFeedback: true,
      }];
    }
  } catch {
    effects = [];
  }
  effectCache.set(cacheKey, effects);
  return effects;
}

/** 人工检视应先打开哪类证据。映射只消费内核 approval_subject 的类型，
 * 不认识任何步骤 id：artifacts 看过程文档，worktree 看代码变更。 */
export function stepReviewSurface(
  kernelRoot: string | undefined,
  stepId: string | undefined,
): "doc" | "diff" | undefined {
  if (!kernelRoot || !stepId) return undefined;
  const cacheKey = `${kernelRoot}\0${stepId}`;
  if (surfaceCache.has(cacheKey)) return surfaceCache.get(cacheKey);
  let surface: "doc" | "diff" | undefined;
  try {
    const path = join(kernelRoot, "flow", "flow.json");
    if (existsSync(path)) {
      const flow = JSON.parse(readFileSync(path, "utf-8"));
      const subject = flow?.steps?.[stepId]?.approval_subject;
      if (subject?.kind === "worktree") surface = "diff";
      else if (subject?.kind === "artifacts") surface = "doc";
    }
  } catch {
    surface = undefined;
  }
  surfaceCache.set(cacheKey, surface);
  return surface;
}

/** 精确匹配内核给出的 choice key 或选项原文。trim 只吸收表单空白，
 * 不做模糊包含，避免把“无需修改”误认成“需要修改”。 */
export function matchesStepChoice(
  effect: StepChoiceEffect,
  answer: string,
): boolean {
  const normalized = answer.trim();
  return normalized === effect.key
    || effect.answers.some((candidate) => candidate.trim() === normalized);
}
