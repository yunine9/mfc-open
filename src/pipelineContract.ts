/**
 * Cloud 与流水线适配层之间的逐项质量事实。
 *
 * 总体 status 只负责告诉宿主“一次 run 是否结束”；是否可以交付只由
 * 内核对这三类 check 的裁决决定。缺项、未知状态或畸形字段都按没有
 * 可核销证据处理，绝不拿总体绿灯补猜。
 */

export const PIPELINE_DIMENSIONS = ["COMPILE", "UT", "CODECHECK"] as const;

export type PipelineDimension = typeof PIPELINE_DIMENSIONS[number];

export type PipelineCheckStatus =
  | "success"
  | "failed"
  | "running"
  | "pending"
  | "canceled"
  | "skipped"
  | "not_run";

/** 单条缺陷/错误明细(CodeCheck 规则命中、编译错误等)。全部可选宽进:
 * 它是给修复 Agent 的诊断增益,不是核销证据——核销只认 dimension+status。 */
export interface PipelineDefect {
  /** 命中规则/错误类别(如 CodeCheck 规则名、编译错误码)。 */
  rule?: string;
  file?: string;
  line?: number;
  severity?: string;
  /** 产生这条缺陷的工具名(SuperChecker 等"不可修工具"分诊用)。 */
  tool?: string;
  message: string;
}

export interface PipelineCheck {
  dimension: PipelineDimension;
  status: PipelineCheckStatus;
  job?: string;
  url?: string;
  /** 所属流水线 stage(toolkit 对齐:精确到"哪个 stage 的哪个 job")。 */
  stage?: string;
  /** 本维度的执行工具(CODECHECK 可能多工具聚合时取主工具)。 */
  tool?: string;
  /** 失败明细(规则/文件/行号/描述)。缺席=平台没给,不影响核销。 */
  details?: PipelineDefect[];
}

const DIMENSIONS = new Set<string>(PIPELINE_DIMENSIONS);
const CHECK_STATUSES = new Set<string>([
  "success", "failed", "running", "pending", "canceled", "skipped",
  "not_run",
]);

/** 平台响应是运行时输入，过这一道才进入任务摘要和内核事实文件。 */
export function parsePipelineChecks(value: unknown): PipelineCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const checks: PipelineCheck[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const row = raw as Record<string, unknown>;
    const dimension = String(row.dimension ?? "").toUpperCase();
    const status = String(row.status ?? "").toLowerCase();
    if (!DIMENSIONS.has(dimension) || !CHECK_STATUSES.has(status)) {
      return undefined;
    }
    checks.push({
      dimension: dimension as PipelineDimension,
      status: status as PipelineCheckStatus,
      ...(row.job !== undefined && row.job !== ""
        ? { job: String(row.job) } : {}),
      ...(row.url !== undefined && row.url !== ""
        ? { url: String(row.url) } : {}),
      ...(row.stage !== undefined && row.stage !== ""
        ? { stage: String(row.stage) } : {}),
      ...(row.tool !== undefined && row.tool !== ""
        ? { tool: String(row.tool) } : {}),
      ...(() => {
        const details = parsePipelineDefects(row.details);
        return details.length ? { details } : {};
      })(),
    });
  }
  return checks;
}

/** 缺陷明细宽进严出:畸形条目丢弃而不是整包作废——它是诊断增益,
 * 不参与核销;核心字段(dimension/status)仍然严格。单条上限防日志
 * 灌爆任务摘要。 */
const MAX_DEFECTS_PER_CHECK = 200;
const MAX_DEFECT_MESSAGE = 2000;

export function parsePipelineDefects(value: unknown): PipelineDefect[] {
  if (!Array.isArray(value)) return [];
  const defects: PipelineDefect[] = [];
  for (const raw of value) {
    if (defects.length >= MAX_DEFECTS_PER_CHECK) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const message = String(row.message ?? "").trim();
    if (!message) continue;
    const line = Number(row.line);
    defects.push({
      message: message.slice(0, MAX_DEFECT_MESSAGE),
      ...(row.rule ? { rule: String(row.rule) } : {}),
      ...(row.file ? { file: String(row.file) } : {}),
      // CodeCheck 的 line=0 是合法哨兵，表示整文件/MR 级规则。保留下来
      // 供证据层区分“范围规则”和“平台根本没给定位”。
      ...(Number.isFinite(line) && line >= 0 ? { line } : {}),
      ...(row.severity ? { severity: String(row.severity) } : {}),
      ...(row.tool ? { tool: String(row.tool) } : {}),
    });
  }
  return defects;
}

/** 修复使命用的结构化失败摘要:每个失败维度一段,带 stage/job/tool
 * 与前若干条缺陷明细(文件:行 [规则] 描述)。toolkit 对齐:让修复
 * Agent 知道"哪个 stage 的哪个 job 的哪个工具挂了",不用对着日志猜。 */
export function summarizeFailedChecks(
  checks: PipelineCheck[] | undefined,
  maxDefectsPerCheck = 8,
): string[] {
  const lines: string[] = [];
  for (const check of checks ?? []) {
    if (check.status !== "failed") continue;
    const where = [
      check.stage ? `stage=${check.stage}` : "",
      check.job ? `job=${check.job}` : "",
      check.tool ? `tool=${check.tool}` : "",
    ].filter(Boolean).join(" ");
    const total = check.details?.length ?? 0;
    lines.push(`${check.dimension}${where ? `(${where})` : ""}: failed`
      + (total ? `,缺陷 ${total} 条` : "")
      + (check.url ? ` ${check.url}` : ""));
    // 超限指标逐项呈现，普通缺陷才按摘要预算截取，避免只讲首个错误。
    const metrics = (check.details ?? []).filter((d) =>
      d.rule === "quality_metric" && d.severity === "error");
    const selected = [...metrics, ...(check.details ?? [])
      .filter((d) => !metrics.includes(d)).slice(0, maxDefectsPerCheck)];
    for (const defect of selected) {
      const site = defect.file
        ? `${defect.file}${defect.line ? `:${defect.line}` : ""} ` : "";
      const tag = [defect.tool, defect.rule, defect.severity]
        .filter(Boolean).join("/");
      lines.push(`  - ${site}${tag ? `[${tag}] ` : ""}${defect.message}`);
    }
    if (total > selected.length) {
      lines.push(`  - …还有 ${total - selected.length} 条,`
        + "完整清单见本轮派发的流水线镜像材料");
    }
  }
  return lines;
}

/** "不可自动修复工具"分诊(toolkit 的 UNFIXABLE_TOOLS 对齐):
 * CODECHECK 失败但产生失败的工具全部在不可修集合里(如 SuperChecker
 * ——要人工在平台上处理/豁免),派发修复会话只会白烧一轮。
 * 判定必须**全体**命中且证据充分:任何一个失败维度不是 CODECHECK、
 * 或缺 tool 证据、或工具不在集合里,都返回 false(照常派发修复)——
 * 拿不准时宁可多修一轮,不许把可修的红灯误判成等人。 */
export function onlyUnfixableToolFailures(
  checks: PipelineCheck[] | undefined,
  unfixableTools: string[] | undefined,
): boolean {
  const unfixable = new Set(
    (unfixableTools ?? []).map((tool) => tool.trim().toLowerCase())
      .filter(Boolean));
  if (!unfixable.size) return false;
  const failed = (checks ?? []).filter((check) => check.status === "failed");
  if (!failed.length) return false;
  return failed.every((check) => {
    if (check.dimension !== "CODECHECK") return false;
    const tools = [
      ...(check.tool ? [check.tool] : []),
      ...(check.details ?? []).map((defect) => defect.tool ?? ""),
    ].filter(Boolean).map((tool) => tool.toLowerCase());
    return tools.length > 0
      && tools.every((tool) => unfixable.has(tool));
  });
}

/** 流水线 run 的选取守卫——防过期结果的宿主级机械核验。
 *
 * 内网对比报告(2026-08-28)实锤的头号根因:MR 头上没有效流水线时
 * 平台挂旧分支的灯(is_valid:false),或返回的 run 根本属于别的提交;
 * 我们照单全收,修复环就一直"是好是坏的"。规矩(本仓宪法):流水线
 * 结果绑 SHA,旧绿灯不背书新代码。
 *
 * run.sha / run.is_valid 是适配层新增的可选回显:给了就机械核验,
 * 不给(老配置)保持旧行为——升级不破老部署,但 selftest 会建议配上。
 * 返回终态 run 与被拒 run 的诚实描述(进日志/detail,人能看见为什么
 * 还在等)。 */
export function selectTerminalRun<T extends {
  status?: string; sha?: string; is_valid?: boolean;
}>(runs: T[] | undefined, sha: string): { run?: T; rejected: string[] } {
  const rejected: string[] = [];
  let chosen: T | undefined;
  for (const run of runs ?? []) {
    if (run.is_valid === false) {
      rejected.push("is_valid=false(MR 头上无有效流水线,挂的是过期结果)");
      continue;
    }
    const runSha = String(run.sha ?? "").trim();
    if (runSha && sha && runSha !== sha) {
      rejected.push(`run 绑定 ${runSha.slice(0, 12)} ≠ 当次提交 `
        + `${sha.slice(0, 12)}(过期结果,拒绝背书)`);
      continue;
    }
    if (run.status === "success" || run.status === "failed") chosen = run;
  }
  return { run: chosen, rejected };
}
