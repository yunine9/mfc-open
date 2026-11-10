/**
 * Read the kernel's explanation contract without copying workflow semantics.
 *
 * The command is deliberately read-only.  Old kernels and non-kernel tasks
 * simply return no plan; Cloud never invents a second mapping as a fallback.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  WorkflowDiagnostic,
  WorkflowPlanItem,
  WorkflowSourceRef,
} from "./workflowDefinition.ts";

export interface ExecutionPlanActivity {
  id: string;
  title: string;
  description: string;
  required: boolean;
  source?: "platform_default" | "customized";
  locked?: boolean;
  editable?: boolean;
  instructions?: string;
}

export interface ExecutionPlanResource {
  id: string;
  kind: "guidance" | "standard" | "agent" | "platform" | "knowledge"
    | "skill" | "tool";
  name: string;
  ref?: string;
  usage: "required" | "when_needed" | "on_demand";
  preferred?: boolean;
  locked?: boolean;
  editable?: boolean;
  source?: "platform" | "workflow" | "task";
  instructions?: string;
}

export interface ExecutionPlaybookOption {
  id: string;
  version: string;
  title: string;
  summary: string;
  phase: string;
  activities: ExecutionPlanActivity[];
  resources: ExecutionPlanResource[];
}

export interface ExecutionPlan {
  schema: "mae-flow-execution-plan/1";
  plan_id: string;
  plan_revision: string;
  step: {
    id: string;
    title: string;
    phase: string;
    state_revision?: number;
  };
  strategy: {
    id: string;
    version: string;
    title: string;
    summary: string;
    // "platform" 是内核 _strategy_source 对 source.kind 的透传值之一,
    // 类型联合漏列只是失真不炸(2026-08-30 审计 P2-16),补齐对拍。
    source: "platform_default" | "platform" | "workflow" | "task";
    selection_reason: string;
  };
  contract: {
    human_decision: boolean;
    evidence: Array<{ type: string; label: string }>;
    outputs: string[];
  };
  activities: ExecutionPlanActivity[];
  resources: ExecutionPlanResource[];
  /** 结构化工作流启用时，这就是 Agent 消费的唯一有序阶段方案。 */
  workflow_items: WorkflowPlanItem[];
  knowledge: {
    loading: "indexed_on_demand";
    explanation: string;
  };
  customization: {
    mode: "bounded" | "structural";
    customizable: string[];
    locked: string[];
    effective_source: "platform_default" | "platform_default+overrides"
      | "compiled_final_plan";
    profile_revision?: string;
    layers: Array<{
      scope: "team" | "business_module" | "repository" | "task";
      source_id: string;
      title: string;
      instructions: string;
    }>;
    stage_layers: Array<{
      scope: "team" | "business_module" | "repository" | "task";
      source_id: string;
      title: string;
      playbook_id: string;
      instructions?: string;
      optional_activities: string[];
      preferred_resources: string[];
    }>;
    workflow_source?: WorkflowSourceRef;
    diagnostics?: WorkflowDiagnostic[];
  };
}

export interface ExecutionPlanReading {
  plan?: ExecutionPlan;
  /** 内核 stderr 里的 ⚠ 告警(定制文件坏了、已退平台默认等)。
   * 曾经被 stdio ignore 整段扔掉——用户看着创建时的定格副本,Agent
   * 实际按平台默认在跑,无人被通知(2026-08-30 审计 P0-1)。 */
  kernel_warnings: string[];
}

/** 只有带 final_snapshot 的结构化方案才承诺由 compiled_final_plan
 * 执行。supplement-only profile 本来就按平台默认方案叠加 overrides；
 * 此时 platform_default+overrides 证明补充已经生效，不是投影缺失。 */
export function hasStructuralWorkflowProjectionMismatch(
  profile: { final_snapshot?: unknown } | undefined,
  plan: Pick<ExecutionPlan, "customization"> | undefined,
): boolean {
  return Boolean(profile?.final_snapshot && plan
    && plan.customization.effective_source !== "compiled_final_plan");
}

interface CacheEntry {
  fingerprint: string;
  value: ExecutionPlanReading;
}

const cache = new Map<string, CacheEntry>();

function fingerprint(kernelRoot: string, workspace: string): string {
  return [
    join(workspace, ".mae-flow.json"),
    join(workspace, ".mae-flow-work", "execution-profile.json"),
    join(workspace, ".mae-flow-work", "workflow-profile.json"),
    join(kernelRoot, "flow", "flow.json"),
    join(kernelRoot, "flow", "playbooks.json"),
  ].map((path) => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path}:missing`;
    }
  }).join("\0");
}

function validPlan(value: unknown): value is ExecutionPlan {
  const plan = value as Partial<ExecutionPlan> | undefined;
  return plan?.schema === "mae-flow-execution-plan/1"
    && typeof plan.plan_id === "string"
    && typeof plan.plan_revision === "string"
    && typeof plan.step?.id === "string"
    && typeof plan.step?.title === "string"
    && typeof plan.strategy?.title === "string"
    && typeof plan.strategy?.version === "string"
    && Array.isArray(plan.activities)
    && Array.isArray(plan.resources)
    && (plan.workflow_items === undefined || Array.isArray(plan.workflow_items))
    && Array.isArray(plan.contract?.evidence)
    && Array.isArray(plan.contract?.outputs)
    && Array.isArray(plan.customization?.locked)
    && (plan.customization?.layers === undefined
      || Array.isArray(plan.customization.layers));
}

export function readCurrentExecutionPlanReading(options: {
  kernelRoot?: string;
  workspace?: string;
  python?: string;
}): ExecutionPlanReading {
  const { kernelRoot, workspace } = options;
  const empty: ExecutionPlanReading = { kernel_warnings: [] };
  if (!kernelRoot || !workspace) return empty;
  const script = join(kernelRoot, "scripts", "mae-flow.py");
  const state = join(workspace, ".mae-flow.json");
  if (!existsSync(script) || !existsSync(state)) return empty;
  const key = `${kernelRoot}\0${workspace}`;
  const currentFingerprint = fingerprint(kernelRoot, workspace);
  const cached = cache.get(key);
  if (cached?.fingerprint === currentFingerprint) return cached.value;

  const value: ExecutionPlanReading = { kernel_warnings: [] };
  try {
    const result = spawnSync(
      options.python ?? "python3",
      [script, "execution-plan", "--json"],
      {
        cwd: workspace,
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // 只收 ⚠ 行:那是内核说人话的告警口径。旧内核不识别子命令时
    // stderr 是 argparse 用法转储,不是告警,照旧安静降级。
    value.kernel_warnings = (result.stderr ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("⚠"));
    if (result.status === 0) {
      const parsed = JSON.parse(
        (result.stdout ?? "").trim().split("\n").at(-1) ?? "{}");
      if (validPlan(parsed)) {
        value.plan = {
          ...parsed,
          workflow_items: parsed.workflow_items ?? [],
          customization: {
            ...parsed.customization,
            layers: parsed.customization.layers ?? [],
            stage_layers: parsed.customization.stage_layers ?? [],
          },
        };
      }
    }
  } catch {
    // 旧内核没有命令、状态正在原子替换或只读投影超时：不影响任务。
  }
  cache.set(key, { fingerprint: currentFingerprint, value });
  return value;
}

export function readCurrentExecutionPlan(options: {
  kernelRoot?: string;
  workspace?: string;
  python?: string;
}): ExecutionPlan | undefined {
  return readCurrentExecutionPlanReading(options).plan;
}

const pendingReadings = new Map<string, Promise<ExecutionPlanReading>>();

/** HTTP 详情查询不能用同步 Python 阻塞其他请求；相同版本的并发读取共用一次查询。 */
export async function readCurrentExecutionPlanReadingAsync(options: {
  kernelRoot?: string; workspace?: string; python?: string;
}): Promise<ExecutionPlanReading> {
  const { kernelRoot, workspace } = options;
  const empty: ExecutionPlanReading = { kernel_warnings: [] };
  if (!kernelRoot || !workspace) return empty;
  const script = join(kernelRoot, "scripts", "mae-flow.py");
  if (!existsSync(script) || !existsSync(join(workspace, ".mae-flow.json"))) return empty;
  const key = `${kernelRoot}\0${workspace}`;
  const version = fingerprint(kernelRoot, workspace);
  const cached = cache.get(key);
  if (cached?.fingerprint === version) return cached.value;
  const pendingKey = `${key}\0${version}`;
  const pending = pendingReadings.get(pendingKey);
  if (pending) return pending;
  const reading = new Promise<ExecutionPlanReading>(resolve => {
    execFile(options.python ?? "python3", [script, "execution-plan", "--json"],
      { cwd: workspace, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const value: ExecutionPlanReading = { kernel_warnings: String(stderr ?? "").split("\n").map(line => line.trim()).filter(line => line.startsWith("⚠")) };
        if (!error) {
          try {
            const parsed = JSON.parse(String(stdout).trim().split("\n").at(-1) ?? "{}");
            if (validPlan(parsed)) value.plan = { ...parsed, workflow_items: parsed.workflow_items ?? [],
              customization: { ...parsed.customization, layers: parsed.customization.layers ?? [], stage_layers: parsed.customization.stage_layers ?? [] } };
          } catch { /* 保持只读展示的兼容降级。 */ }
        }
        // 查询期间现场改变时，不用旧结果覆盖较新的缓存。
        if (fingerprint(kernelRoot, workspace) === version) cache.set(key, { fingerprint: version, value });
        resolve(value);
      });
  }).finally(() => pendingReadings.delete(pendingKey));
  pendingReadings.set(pendingKey, reading);
  return reading;
}

export function clearExecutionPlanCache(): void {
  cache.clear();
}

/** The launch/settings UI reads the same versioned catalog that the kernel
 * compiles.  Failure returns an empty catalog: the UI then offers no invented
 * customization, while the fixed workflow remains usable. */
export function readExecutionPlaybookOptions(
  kernelRoot: string | undefined,
): ExecutionPlaybookOption[] {
  if (!kernelRoot) return [];
  try {
    const value = JSON.parse(readFileSync(
      join(kernelRoot, "flow", "playbooks.json"), "utf-8")) as {
        schema?: string;
        playbooks?: Array<Record<string, unknown>>;
      };
    if (value.schema !== "mae-flow-playbook-catalog/1"
        || !Array.isArray(value.playbooks)) return [];
    const parsed = value.playbooks.flatMap((raw) => {
      const id = String(raw.id ?? "").trim();
      const version = String(raw.version ?? "").trim();
      const title = String(raw.title ?? "").trim();
      const summary = String(raw.summary ?? "").trim();
      const phase = String(raw.phase ?? "").trim();
      if (!id || !version || !title || !summary || !phase) return [];
      const rawActivities = Array.isArray(raw.activities) ? raw.activities : [];
      const activities = rawActivities.flatMap((item) => {
            const activity = item as Record<string, unknown>;
            const activityId = String(activity.id ?? "").trim();
            const activityTitle = String(activity.title ?? "").trim();
            const description = String(activity.description ?? "").trim();
            if (!activityId || !activityTitle || !description) return [];
            return [{
              id: activityId,
              title: activityTitle,
              description,
              required: activity.required === true,
            }];
          });
      if (activities.length !== rawActivities.length) return [];
      const rawResources = Array.isArray(raw.resources) ? raw.resources : [];
      const resources = rawResources.flatMap((item) => {
            const resource = item as Record<string, unknown>;
            const resourceId = String(resource.id ?? "").trim();
            const name = String(resource.name ?? "").trim();
            const kind = String(resource.kind ?? "") as ExecutionPlanResource["kind"];
            const usage = String(resource.usage ?? "") as ExecutionPlanResource["usage"];
            if (!resourceId || !name
                || !["guidance", "standard", "agent", "platform", "knowledge",
                  "skill", "tool"].includes(kind)
                || !["required", "when_needed", "on_demand"].includes(usage)) {
              return [];
            }
            return [{
              id: resourceId,
              kind,
              name,
              ...(resource.ref ? { ref: String(resource.ref) } : {}),
              usage,
            }];
          });
      if (resources.length !== rawResources.length) return [];
      return [{ id, version, title, summary, phase, activities, resources }];
    });
    return parsed.length === value.playbooks.length ? parsed : [];
  } catch {
    return [];
  }
}
