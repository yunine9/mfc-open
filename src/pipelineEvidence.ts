/**
 * 流水线红灯维度与“可供修复的具体证据”对齐。
 *
 * status 只说明 COMPILE / UT / CODECHECK 哪一维红；artifacts 才回答
 * 为什么红。两者必须逐维度对齐，不能用“整个材料包非空”替代。
 * 这里是纯判定层，不推进任务、不调用外部系统，方便拿内网真实样例回归。
 */
import type {
  PipelineCheck,
  PipelineDimension,
} from "./pipelineContract.ts";

export interface PipelineArtifactText {
  name: string;
  text: string;
}

export interface PipelineEvidenceAssessment {
  failedDimensions: PipelineDimension[];
  availableDimensions: PipelineDimension[];
  missingDimensions: PipelineDimension[];
  sources: Partial<Record<PipelineDimension, string[]>>;
  reasons: Partial<Record<PipelineDimension, string[]>>;
  /** 跨维度兜底背书的来源(带"归类错配"标注,维度前缀:来源)。
   *  执行层把它带进回合/使命文案,让修复侧知道这段日志与失败维度
   *  的归属关系存疑,以日志原文为准定位。 */
  fallbackSources: string[];
}

export const PIPELINE_DIMENSION_TEXT: Record<PipelineDimension, string> = {
  COMPILE: "编译/构建",
  UT: "UT/覆盖率",
  CODECHECK: "CodeCheck",
};

const NO_DATA = /^(?:no data(?: found)?|not found|empty|null|undefined)$/i;
const COMPILE_ERROR = /(?:fatal error|\berror:|undefined reference|collect2:|ld(?:\.lld)?: error|make(?:\[\d+\])?: \*\*\*|\[ERROR\]|killed signal|compilation failure|build failure)/i;
// 既有 C/C++/Maven 分支保持向后兼容;后半段是前端 runner(Jest/Mocha/
// Vitest)的失败特征。JS 正则没有扩展模式,写成纯 alternation。
// 旧尺子对 Jest 输出全部不中:"Tests: 1 failed" 的 fail 不紧跟 tests、
// "FAIL src/x.test.jsx" 不是 FAILED 在 test 之后。汇总行的冒号可选:
// Jest 是 "Tests: 1 failed",Vitest 是 "Test Files 1 failed"。
const UT_ERROR = /(?:tests? (?:run:.*)?fail(?:ed|ure)?|\btest case failed\b|\btest case\s+[^\r\n]+?\s+failed\b|\bfailure total:\s*[1-9]\d*\b|\bTests run:\s*\d+,\s*Failures:\s*[1-9]\d*\b|failures?!!!|assert(?:ion)?(?:error| failed)|expected .+ (?:but|to)|unit tests? failed|coverage.+(?:below|less|failed)|\bFAILED\b.+(?:test|case)|\[\s*FAILED\s*\]\s+(?:[1-9]\d*\s+tests?\b|[\w/:-]+(?:\.[\w/:-]+)+)|\bCPP_UT\b|\bFAIL\b\s+\S+\.(?:test|spec)\.(?:js|jsx|ts|tsx)|\bTest (?:Suites|Files):?\s*[1-9]\d*\s+failed|\bTests:?\s*[1-9]\d*\s+failed|\b\d+\s+failing\b|^\s*[●✖×]\s+\S)/im;
const UT_CASE_ERROR = /(?:^\s*(?:\[ERROR\]\s*)?[\w.$]+Test\.[\w$]+:\d+|^\s*[\w.$]+Test\s*>\s*.+\s+FAILED\b|^\s*FAILED\s+\S+\.py(?:::\S+)+\b|^\s*--- FAIL:\s*Test\S+|^\s*test\s+\S+\s+\.\.\.\s+FAILED\b|^\s*Failed\s+[\w.]+\s+\[\d+\s*(?:ms|s)\])/im;
const PATH_WITH_LINE = /(?:[A-Za-z]:)?[^\s"']+\.(?:c|cc|cpp|cxx|h|hpp|java|kt|py|js|jsx|ts|tsx|go|rs|cs|xml):\d+/i;
const TEST_FILE_PATH = /\.(?:test|spec)\.(?:js|jsx|ts|tsx|java|kt|py)\b/i;
// 带脚本名的非零退出能指向出错的命令；单独的失败计数不能。
const SCRIPT_EXIT_ERROR = /\.(?:py|sh)\b[^\r\n]*(?:\r?\n[^\r\n]*)?\bexit\s+(?:code|status)\s*[:=]?\s*-?[1-9]\d*\b/i;

const TOOL_DIMENSIONS: Array<[RegExp, PipelineDimension]> = [
  [/^(?:cloudbuild2\.0|build2\.0)$/i, "COMPILE"],
  [/^(?:cpp_ut|ut|unit[_-]?test|coverage)$/i, "UT"],
  [/^(?:codecheck|codecheckfortest|codechecktest|superchecker|codecheck)/i,
    "CODECHECK"],
];

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function meaningful(text: string): boolean {
  const value = text.trim();
  return !!value && !NO_DATA.test(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function dimensionOfTool(tool: unknown): PipelineDimension | undefined {
  const name = String(tool ?? "").trim();
  return TOOL_DIMENSIONS.find(([pattern]) => pattern.test(name))?.[1];
}

/** 按日志内容嗅探它能背书的维度(可命中多个)。record-id 的 toolName
 * 归类只是弱提示:build2.0 这类复合构建工具靠名字分不清这次是编译挂
 * 还是 UT 挂(真实案例:CodeCheck2.0 下 build2.0 跑 JS UT,通过率不达标,
 * record 却全被归到编译维),日志真实维度由内容决定。 */
function sniffDimensions(text: string): PipelineDimension[] {
  const dims = new Set<PipelineDimension>();
  if (UT_ERROR.test(text) || UT_CASE_ERROR.test(text)) dims.add("UT");
  if (COMPILE_ERROR.test(text)) dims.add("COMPILE");
  // 堆栈行(路径:行号)逐行归维:部分 runner 的失败堆栈未必带 FAIL/
  // 汇总关键字,但 path:line 就够定位;测试文件堆栈归 UT,其余归编译
  // ——同一份日志可能两种堆栈都有,整份二选一会丢掉其中一维。
  for (const line of text.split(/\r?\n/)) {
    if (PATH_WITH_LINE.test(line)) {
      dims.add(TEST_FILE_PATH.test(line) ? "UT" : "COMPILE");
    }
  }
  return [...dims];
}

/** 找 JSON 里真正可定位的一条缺陷，而不是“defectCount=3”这类汇总。 */
function hasLocatedDefect(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLocatedDefect);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const entries = Object.entries(row);
  const field = entries.find(([key, current]) =>
    /^(?:file|file_?path|filename|relative_?path|path)$/i.test(key)
      && meaningful(String(current ?? "")));
  const line = entries.find(([key, current]) =>
    /^(?:line|line_?(?:no|num|number)|lineno|linenum|start_?line|new_?line)$/i
      .test(key)
      // CodeCheck 用 0 表示整文件/MR 级规则，不是“缺少定位”。负数才是
      // 非法值；同时仍要求 file + diagnosis，避免 defectCount=0 之类的
      // 汇总字段冒充可修证据。
      && Number.isFinite(Number(current)) && Number(current) >= 0);
  const diagnosis = entries.find(([key, current]) =>
    /^(?:message|msg|description|detail|rule|rule_?(?:id|name)|indicator_?name|checker_?name|error)$/i
      .test(key) && meaningful(String(current ?? "")));
  if (field && line && diagnosis) return true;
  return entries.some(([, nested]) => hasLocatedDefect(nested));
}

function actionableCodecheck(text: string): boolean {
  if (!meaningful(text)) return false;
  const parsed = parseJson(text);
  if (parsed !== undefined && hasLocatedDefect(parsed)) return true;
  return PATH_WITH_LINE.test(text)
    && /(?:rule|codecheck|checker|severity|缺陷|[A-Z](?:\.[A-Z0-9_-]+){2,})/i
      .test(text);
}

/** 没有逐项检查时，只有摘要里实际出现的诊断才能代替一次失败的产物请求。 */
export function hasActionablePipelineSummary(summary: string): boolean {
  // stage/job、工具名本身只能说明哪一项失败。
  const diagnostic = summary.replace(/^\s*FAILED stage=.*$/gm, "").replace(/\bCPP_UT\b/gi, "");
  return sniffDimensions(diagnostic).length > 0 || SCRIPT_EXIT_ERROR.test(diagnostic)
    || actionableCodecheck(diagnostic);
}

// 指标型质量门缺陷的指标名关键词。word 表保持克制:说明文/规则描述
// 里出现"覆盖率""用例"不算数,只认指标名字段(见下)。
const UT_INDICATOR_WORDS = /(?:pass rate|通过率|\bdt\b|coverage|覆盖率)/i;

/** 指标型缺陷(通过率/DT/覆盖率)没有 file:line,过不了 hasLocatedDefect
 * 的三要素,但它是 UT 失败的明确信号(真实案例:"js pass rate 99.78<100"
 * +DT 缺陷,构建 record 本身 SUCCESS)。关键词只认 indicatorName 类
 * 字段,不扫全 JSON——规则描述、策略说明里出现同词不是指标型缺陷。 */
function indicatorDefectSignalsUt(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(indicatorDefectSignalsUt);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, current]) =>
    /^indicator_?name$/i.test(key)
      ? typeof current === "string" && UT_INDICATOR_WORDS.test(current)
      : indicatorDefectSignalsUt(current));
}

function actionableStructuredError(text: string): boolean {
  if (!meaningful(text)) return false;
  const parsed = parseJson(text);
  if (parsed !== undefined && hasLocatedDefect(parsed)) return true;
  return COMPILE_ERROR.test(text) || UT_ERROR.test(text)
    || UT_CASE_ERROR.test(text)
    || PATH_WITH_LINE.test(text);
}

function pipelineInfoRecordDimensions(
  artifacts: PipelineArtifactText[],
): Map<string, PipelineDimension> {
  const info = artifacts.find((item) => item.name === "pipeline_info.json");
  const parsed = info ? parseJson(info.text) : undefined;
  const rows = parsed && typeof parsed === "object"
    && Array.isArray((parsed as Record<string, unknown>).defects)
    ? (parsed as { defects: unknown[] }).defects : [];
  const mapped = new Map<string, PipelineDimension>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const dimension = dimensionOfTool(row.toolName ?? row.tool_name ?? row.tool);
    if (!dimension) continue;
    const recordIds = Array.isArray(row.record_ids)
      ? row.record_ids : Array.isArray(row.recordIds) ? row.recordIds : [];
    for (const record of recordIds) {
      const id = String(record ?? "").trim();
      if (id) mapped.set(id, dimension);
    }
  }
  return mapped;
}

function summaryReasons(
  artifacts: PipelineArtifactText[],
): Partial<Record<PipelineDimension, string[]>> {
  const item = artifacts.find((entry) =>
    entry.name === "pipeline_log_summary.json");
  const parsed = item ? parseJson(item.text) : undefined;
  const strategies = parsed && typeof parsed === "object"
    ? (parsed as Record<string, any>).strategies : undefined;
  const note = (name: string): string | undefined => {
    const row = strategies?.[name];
    if (!row || row.status !== "failed") return undefined;
    const text = String(row.note ?? `${name} 未拿到证据`).trim();
    return text || `${name} 未拿到证据`;
  };
  return {
    COMPILE: unique([note("build-logs")].filter(Boolean) as string[]),
    UT: unique([note("build-logs"), note("coverage")]
      .filter(Boolean) as string[]),
    CODECHECK: unique([note("codecheck")].filter(Boolean) as string[]),
  };
}

function addSource(
  sources: Partial<Record<PipelineDimension, string[]>>,
  dimension: PipelineDimension,
  source: string,
): void {
  (sources[dimension] ??= []).push(source);
}

/**
 * 人工回灌只对当时明确缺失的维度背书；普通批注不会被自动扩大解释。
 */
export function assessPipelineRepairEvidence(input: {
  checks: PipelineCheck[] | undefined;
  artifacts: PipelineArtifactText[];
  /** status 接口随终态直接返回的失败摘要；它也必须按内容逐维归类，
   * 不能因为非空就给所有红灯维度背书。 */
  failureSummary?: string;
  humanEvidence?: { dimensions: PipelineDimension[]; text: string };
}): PipelineEvidenceAssessment {
  const failedDimensions = unique((input.checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => check.dimension));
  const sources: Partial<Record<PipelineDimension, string[]>> = {};
  const recordDimensions = pipelineInfoRecordDimensions(input.artifacts);

  const summary = input.failureSummary?.trim() ?? "";
  if (meaningful(summary)) {
    if (failedDimensions.includes("COMPILE") && (COMPILE_ERROR.test(summary) || SCRIPT_EXIT_ERROR.test(summary))) {
      addSource(sources, "COMPILE", "流水线终态失败摘要");
    }
    if (failedDimensions.includes("UT") && UT_ERROR.test(summary)) {
      addSource(sources, "UT", "流水线终态失败摘要");
    }
    if (failedDimensions.includes("CODECHECK")
        && actionableCodecheck(summary)) {
      addSource(sources, "CODECHECK", "流水线终态失败摘要");
    }
  }

  for (const check of input.checks ?? []) {
    if (check.status !== "failed" || !check.details?.length) continue;
    if (check.dimension === "CODECHECK") {
      if (check.details.some((detail) =>
        !!detail.file && detail.line !== undefined
        && detail.line >= 0 && meaningful(detail.message))) {
        addSource(sources, "CODECHECK", "status checks 的文件/范围缺陷明细");
      }
      continue;
    }
    if (check.details.some((detail) => meaningful(detail.message)
      && (!!detail.file || (!!detail.rule && detail.rule !== "quality_metric") || !!detail.line))) {
      addSource(sources, check.dimension, "status checks 的结构化失败明细");
    }
  }

  for (const artifact of input.artifacts) {
    const { name, text } = artifact;
    if (name === "codecheck_detail.json") {
      if (actionableCodecheck(text)) {
        addSource(sources, "CODECHECK", name);
      } else if (indicatorDefectSignalsUt(parseJson(text))) {
        // 指标型缺陷不是可定位报错本身,它只指认"UT 在红"——定位仍要
        // 看对应构建日志的失败用例;故只作 UT 信号,不冒充 CodeCheck 证据。
        addSource(sources, "UT",
          `${name}(指标型质量门缺陷:通过率/DT 类指标红)`);
      }
      continue;
    }
    if (/^coverage_diff_.+\.json$/i.test(name)
        && meaningful(text) && !/no data(?: found)?/i.test(text)) {
      addSource(sources, "UT", name);
      continue;
    }
    const build = /^(?:build_log_|build_errors_|build_error_excerpt_)(.+)\.(?:txt|json)$/i
      .exec(name);
    if (!build) continue;
    const recordId = build[1];
    const mapped = [...recordDimensions.entries()].find(([id]) =>
      recordId === id || name.includes(id))?.[1];
    if (name.startsWith("build_log_")) {
      // 全量日志:内容嗅探为主、record-id 归类为弱提示。并集的前提是
      // 内容有强特征——零特征的日志连映射维度也不背书(旧基线如此):
      // 日志里没有可定位报错时,派发修复只会照着一份没有内容的日志猜改。
      const candidate = new Set(sniffDimensions(text));
      if (mapped && candidate.size) candidate.add(mapped);
      for (const dimension of candidate) {
        addSource(sources, dimension, name);
      }
      continue;
    }
    if (name.startsWith("build_error_excerpt_")) {
      // 摘要保留了完整日志中的失败原文。CPP_UT 的 record 可能被平台
      // 标作 build2.0，不能让这个弱标签覆盖明确的测试失败行。
      const detected = sniffDimensions(text);
      for (const dimension of detected) addSource(sources, dimension, name);
      if (!detected.length && mapped && actionableStructuredError(text)) {
        addSource(sources, mapped, name);
      }
      continue;
    }
    // 结构化错误 JSON 按 record 映射维度判定(缺省编译)。
    const dimension = mapped ?? "COMPILE";
    if (actionableStructuredError(text)) addSource(sources, dimension, name);
  }

  if (input.humanEvidence?.dimensions.length
      && meaningful(input.humanEvidence.text)) {
    for (const dimension of input.humanEvidence.dimensions) {
      addSource(sources, dimension, "工作台人工批注回灌");
    }
  }

  // 跨维度兜底:平台对失败维度的归类可能错(真实案例 issue-28:报
  // CodeCheck 红,缺陷挂在 build2.0 的 record 上,errorInfo 拒答,
  // 镜像日志内容却是 Jest UT 失败)。若某失败维度手里一张证据都没有,
  // 而镜像里存在"有可定位内容、且未被任何失败维度认领"的构建日志,
  // 把它作为该维度的弱证据并明示错配——修复回合本来就能读到日志
  // 全文,背书宽松的代价远低于漏判举卡把人拉进来贴原文。"未被失败
  // 维度认领"是硬条件:日志已给某个失败维度背过书,说明内容就归那
  // 一维,拿去替别的维度背书是误导(编译堆栈救不了 UT 缺口)。
  const fallbackSources: string[] = [];
  const unclaimedLocatedLogs = input.artifacts.filter((artifact) =>
    /^build_log_/.test(artifact.name)
    && sniffDimensions(artifact.text).length > 0
    && !failedDimensions.some((dimension) =>
      (sources[dimension] ?? []).includes(artifact.name)));
  if (unclaimedLocatedLogs.length) {
    for (const dimension of failedDimensions) {
      if ((sources[dimension]?.length ?? 0) === 0) {
        const source = `${unclaimedLocatedLogs[0].name}`
          + "(跨维度兜底:内容含可定位报错,record-id 归类与失败维度不一致)";
        addSource(sources, dimension, source);
        fallbackSources.push(`${PIPELINE_DIMENSION_TEXT[dimension]}: ${source}`);
      }
    }
  }

  for (const dimension of Object.keys(sources) as PipelineDimension[]) {
    sources[dimension] = unique(sources[dimension] ?? []);
  }
  const availableDimensions = failedDimensions.filter((dimension) =>
    (sources[dimension]?.length ?? 0) > 0);
  const missingDimensions = failedDimensions.filter((dimension) =>
    !availableDimensions.includes(dimension));
  const reasons = summaryReasons(input.artifacts);
  for (const dimension of missingDimensions) {
    const existing = reasons[dimension] ?? [];
    if (!existing.length) existing.push(
      `${PIPELINE_DIMENSION_TEXT[dimension]} 红灯，但没有可定位的具体报错`);
    reasons[dimension] = unique(existing);
  }
  return {
    failedDimensions,
    availableDimensions,
    missingDimensions,
    sources,
    reasons,
    fallbackSources,
  };
}
