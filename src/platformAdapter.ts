import { createHash } from "node:crypto";
import { PlatformQueryCache, codeHubRateLimited, type QueryResult } from "./platformQueryCache.ts";
/**
 * CodeHub 适配层——把内部 CLI(codehubcli)翻译成宿主消费的三端点契约。
 *
 * 定位:进内网当天要填的只有配置文件里的命令行,本文件零改动。
 * 内部平台是 CodeHub(类比 GitHub):CLI 配一个平台 token 即可做
 * MR 等操作;宿主每个请求带任务归属人的令牌头,MR 发起人=本人,
 * 没带时回落适配层自己配的服务账号 token。
 *
 * 契约(与 docs/deploy-intranet.md 一字对应):
 *   POST /mr               {repo, source_branch, target_branch, title} → {url}
 *   POST /pipeline/trigger {repo, sha} → {status, log?, checks?}
 *   GET  /pipeline/status?sha=&repo=&mr=<iid>
 *        → {runs: [{status, log?, checks?}]}
 *   GET  /pipeline/artifacts?sha=&repo=&mr=<完整 MR URL>
 *        → {files: [{name, text}]}
 *
 * 纪律(与本仓宪法一致):
 * - 诚实失败:CLI 缺失/非零退出/输出解析不出/状态映射不到,一律 502
 *   带原文,绝不猜一个状态糊弄宿主——假绿比失败害人;
 * - 一切等待带预算:CLI 调用有超时(默认 60s),绝无无限等待;
 * - 密钥不落日志:token 只进 CLI 参数,日志里一律掩码;
 * - 配置坏了拒绝启动(部署配置语义,同 serve --config)。
 *
 * 配置形状(JSON,权限 600——里面可能有服务账号 token):
 * {
 *   "port": 8790,
 *   "token": "<服务账号令牌,可选>",        // 或 "token_file": "路径"
 *   "timeout_s": 60,
 *   "mr_create": {
 *     "command": ["codehubcli", "mr", "create", "--repo", "{repo}",
 *                 "--source", "{source_branch}", "--target", "{target_branch}",
 *                 "--title", "{title}", "--token", "{token}", "--json"],
 *     "url": {"json": "data.web_url"}      // 或 {"regex": "https://\\S+"}
 *   },
 *   "pipeline_trigger": {
 *     "command": [...同上占位符,外加 {sha}...],
 *     "status": {"json": "data.state"},
 *     "log": {"json": "data.fail_log"},    // 可选
 *     "checks": {"json": "data.jobs"},     // 可选，建议配置以便诊断
 *     "check_dimension": {"json": "quality_dimension"},
 *     "check_status": {"json": "state"},
 *     "check_job": {"json": "name"},       // 可选
 *     "check_url": {"json": "web_url"},    // 可选
 *     "status_map": {"SUCCESS": "success", "FAILED": "failed",
 *                    "RUNNING": "running", "PENDING": "running"},
 *     "check_status_map": {"SUCCESS": "success", "FAILED": "failed",
 *                          "PENDING": "pending", "SKIPPED": "skipped"}
 *   },
 *   "pipeline_status": {
 *     "command": [...],
 *     "runs": {"json": "data.runs"},       // 指向数组;缺省=整个输出是数组
 *     "status": {"json": "state"},         // 相对每个 run 元素
 *     "log": {"json": "fail_log"},
 *     "checks": {"json": "jobs"},         // 相对每个 run 元素
 *     "check_dimension": {"json": "quality_dimension"},
 *     "check_status": {"json": "state"},
 *     "check_job": {"json": "name"},
 *     "status_map": {...},
 *     "check_status_map": {...}
 *   }
 * }
 *
 * push/MR 自动触发的平台只需 "pipeline_trigger": {"observe_only": true}，
 * 此时复用 pipeline_status 的真实结果，不配置触发命令或固定状态。
 *
 * 占位符:{repo} {source_branch} {target_branch} {title} {sha} {mr}
 *        注意:{mr} 在 status/gates/discussions 是 MR iid，在 artifacts
 *        是完整 MR URL；两类命令是不同端点，不能共用对其形状的猜测。
 *        {repo_path}(从 {repo} 自动派生的 URL 编码项目路径,
 *          CodeHub REST 的 /projects/{路径}/ 直接用,不用手抄项目 id)
 *        {id} {body} {note_id} {idempotency_key}(检视回复链)
 *        {token} {git_username}(后两个优先取请求头里的个人身份)。
 * 命令以 argv 数组直接 spawn,不过 shell——标题带空格、注入都不是问题。
 *
 * 按能力核对报告(2026-08-17)补的三个口子:
 * - mr_lookup:先查后建(A2:CLI 幂等报 stderr、REST 静默 200 空
 *   body,形状不统一,查询是唯一稳的路);
 * - mr_gates.bools/reason/ignore_fields:mergeable_state 平铺布尔
 *   形状(B 节:九项门禁 + ~18 个额外布尔 + reason 文案对象);
 * - discussion_resolve:回复与"标已解决"两个调用(D3),宿主默认
 *   不代 resolve,带 resolve:true 才执行第二条。
 * adapter.json 的参考填法见 docs/mr-loop-adaptation.md §11。
 */

import { execFile } from "node:child_process";
import { normalizeRepairMrUrl, parseDeliveryMr } from "./mrImport.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { appendAudit } from "./issueFlow/audit.ts";
import { hasMrParticipants, MR_PARTICIPANT_ROLES, normalizeMrParticipants, type MrParticipants, type MrParticipantsResult } from "./mrParticipants.ts";
import {
  PIPELINE_DIMENSIONS,
  parsePipelineDefects,
  type PipelineCheck,
  type PipelineCheckStatus,
} from "./pipelineContract.ts";

type Extract = { json?: string; regex?: string; const?: string };

interface CommandSpec {
  command: string[];
  /** 创建 MR 时把非空名单作为 flag 与逗号分隔账号两个 argv 追加。
   * 平台参数由部署配置提供；未映射的角色不冒充设置成功。 */
  participant_flags?: Partial<Record<keyof MrParticipants, string>>;
  timeout_s?: number;
  /** 命令输出**就是宿主契约 JSON**(pipeline_status: {runs:[...]})——
   * 仓内自带的编排脚本(deploy/adapter-tools/)用这个形态,免去逐字段
   * 抽取配置;status 仍逐 run 核验契约词,不放松诚实纪律。 */
  contract?: boolean;
  status?: Extract;
  log?: Extract;
  url?: Extract;
  runs?: Extract;
  status_map?: Record<string, string>;
  /** run 级回显(pipeline_status 用,全部可选;2026-08-28 对比报告的
   * 防过期结果根治):run_sha=这条 run 绑定的提交,is_valid=平台"MR 头上
   * 是否有效流水线"标记。配了宿主就机械核验"结果属于当次提交",
   * 不配保持旧行为(selftest 会点名建议)。 */
  run_sha?: Extract;
  pipeline_id?: Extract;
  is_valid?: Extract;
  web_url?: Extract;
  /** 一次流水线 run 内的逐项质量结果。checks 指数组，后续字段相对
   * 数组元素抽取。缺席允许 trigger 只回 running；终态缺席会被宿主
   * fail-closed 留在 verifying，不能拿总体 success 代替。 */
  checks?: Extract;
  check_dimension?: Extract;
  check_status?: Extract;
  check_job?: Extract;
  check_url?: Extract;
  /** stage/tool/details 默认读取同名字段，也允许模板指定其他路径。 */
  check_stage?: Extract;
  check_tool?: Extract;
  check_details?: Extract;
  check_status_map?: Record<string, string>;
  /** MR 标识(iid)抽取(mr_create/mr_lookup 用,可选):抽到了就随
   * {url} 一起回给宿主,后续门禁/讨论查询带回来当 {mr}。 */
  id?: Extract;
  /** 检视回复的 note id 抽取(discussion_reply 用,可选):新代 CLI
   * 的 resolve 要的是 note id 而不是讨论 id(能力核对报告 D3),
   * 从 reply 命令的输出里抽出来,喂给 discussion_resolve 的 {note_id}。 */
  note_id?: Extract;
  /** CLI 不支持幂等键参数时(codehub-cli mr review reply 无 --idempotency-key),
   * 设 true 降级:不要求模板引用 {idempotency_key}，靠宿主 outbox 的
   * delivered 标记防重放(重启丢 outbox 除外)。模板应带 --no-cache
   * 避免缓存层假成功。不设时(默认)模板必须引用 {idempotency_key}，
   * 否则 platformAdapter 拒绝执行(fail-closed 防重复发言)。 */
  idempotency_no_cli_key?: boolean;
}

/** 自动触发的平台复用状态查询；真正触发的平台仍须配置可执行命令。 */
type PipelineTriggerSpec = (CommandSpec & { observe_only?: false })
  | { observe_only: true };

/** 列表型端点(门禁/讨论/材料):items 指到数组,fields 逐字段抽。 */
interface ListSpec extends CommandSpec {
  /** 数组在输出 JSON 里的位置(缺省=输出本身就是数组)。 */
  items?: Extract;
  /** 每个元素抽哪些字段(点路径相对元素本身)。 */
  fields?: Record<string, Extract>;
  /** 门禁 passed 的判定词(原始值命中任一=通过),缺省
   * ["true","1","passed","success","yes"](大小写不敏感)。 */
  passed_values?: string[];
  /** MR 生命周期抽取与映射(mr_gates 用):opened/merged/closed。 */
  mr_state?: Extract;
  mr_state_map?: Record<string, string>;
  /** MR 详情的源提交 SHA，供宿主已有的合入版本校验使用。 */
  mr_sha?: Extract;
  /** 材料落盘目录模板(pipeline_artifacts 用):命令负责把日志下载到
   * 这个目录(可用 {sha}/{repo} 占位),适配层读目录里全部文件返回
   * ——SSE 日志网关那类"先落盘再取"的形态就走这条,不用逐字段抽。 */
  files_dir?: string;
  /** 平铺布尔门禁模式(mr_gates 用)——CodeHub mergeable_state 的
   * 真实形状(能力核对报告 B 节):不是数组,是"字段名→布尔"的
   * 平铺对象。bools 指到那个对象,每个布尔字段就是一项门禁;配了
   * bools 就不走 items/fields。 */
  bools?: Extract;
  /** 门禁未过原因的文案对象(可选,与 bools 搭配):平台把每项的
   * 解释放在 reason 对象里,同名字段的文案作为 detail 带给宿主。 */
  reason?: Extract;
  /** 不是门禁的布尔字段(bools 模式用),如 merge_request_switch
   * (MR 功能总开关)——列在这里的字段跳过,不当门禁上报。 */
  ignore_fields?: string[];
}

/** 多候选降级链(toolkit 对齐,2026-08-28 对比报告差距①):一个端点
 * 可配多个候选命令(如 编排脚本→REST→CLI),首个成功赢,每路失败
 * 原因记日志并在全败时聚合上报——信息获取不再单点故障。每个候选是
 * 完整的 spec(各自的抽取配置),向后兼容单命令写法。 */
type Degradable<T extends CommandSpec> = T | { candidates: T[] };

function candidatesOf<T extends CommandSpec>(
  spec: Degradable<T>,
): T[] {
  return "candidates" in spec && Array.isArray(spec.candidates)
    ? spec.candidates : [spec as T];
}

interface AdapterConfig {
  port?: number;
  /** 监听地址,默认 127.0.0.1(只给本机宿主)。适配层在 Windows 侧、
   * 宿主在 WSL 里时才需要放开(它拿着服务令牌,放开要想清楚)。 */
  host?: string;
  token?: string;
  token_file?: string;
  timeout_s?: number;
  mr_create: CommandSpec;
  /** 知识归档独立模板，使用任务填写的关联单号。 */
  mr_create_knowledge?: CommandSpec;
  /** 创建前按目标仓成员权限筛选审批人，输出 username/access_level。 */
  mr_approver_members?: ListSpec;
  /** 先查后建(可选):建 MR 前先查同分支对有没有已开的 MR,查到了
   * 直接复用。CodeHub 的建 MR 幂等语义不统一(CLI 报 stderr、REST
   * 静默回 200 空 body——能力核对报告 A2 实测),查询是唯一稳的路。
   * 抽取:url 必配(查到即回),id 可选;查不到/命令失败=走创建。 */
  mr_lookup?: CommandSpec;
  /** 全生命周期精确查找，不复用“只查 opened”的创建前查询。 */
  mr_discover?: CommandSpec;
  /** 只凭 MR 链接读取仓库、源/目标分支和提交；用于独立流水线修复。 */
  mr_detail?: CommandSpec;
  /** 单号纠正成功后关闭旧 MR。未配置时保留旧 MR 并明确报告清理失败。 */
  mr_close?: CommandSpec;
  pipeline_trigger: PipelineTriggerSpec;
  pipeline_status: Degradable<CommandSpec>;
  /** MR 闭环的四个可选端点(docs/mr-loop-adaptation.md §3):
   * 不配=对应 HTTP 路由回 404,宿主 fail-open 回纯流水线语义。 */
  mr_gates?: ListSpec;
  mr_discussions?: ListSpec;
  discussion_reply?: CommandSpec;
  /** 标记讨论"已解决"的第二条命令(可选):CodeHub 回复与 resolve
   * 是两个调用(报告 D3)。宿主请求带 resolve:true 且配了它才执行;
   * 宿主默认不代 resolve(那是检视人的职责),所以多数部署不用配。 */
  discussion_resolve?: CommandSpec;
  pipeline_artifacts?: Degradable<ListSpec>;
}

const CONTRACT_STATUS = new Set(["success", "failed", "running"]);
const CONTRACT_CHECK_STATUS = new Set<PipelineCheckStatus>([
  "success", "failed", "running", "pending", "canceled", "skipped",
  "not_run",
]);
const CONTRACT_DIMENSION = new Set<string>(PIPELINE_DIMENSIONS);

class AdapterError extends Error {}

/** 点路径取值:"data.runs.0.state" 一路走下去,走不通=undefined。
 * 空路径 "" = 整个输出本身(mergeable_state 那类布尔平铺在根上的用)。 */
function dig(source: unknown, path: string): unknown {
  if (path === "") return source;
  let current: any = source;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

/** 从 CLI 输出里抠一个值。json=点路径(要求 stdout 是 JSON),
 * regex=第一个捕获组(没有捕获组就取整个匹配),const=固定值
 * (给"触发成功但不回状态"的 CLI 用)。抠不到=诚实报错,不猜。 */
function extract(
  spec: Extract | undefined,
  what: string,
  stdout: string,
  parsed: () => unknown,
): unknown {
  if (!spec) return undefined;
  if (spec.const !== undefined) return spec.const;
  if (spec.json !== undefined) {
    const value = dig(parsed(), spec.json);
    if (value === undefined) {
      throw new AdapterError(
        `${what}: CLI 输出的 JSON 里没有 ${spec.json}(输出前 500 字:`
        + `${stdout.slice(0, 500)})`);
    }
    return value;
  }
  if (spec.regex !== undefined) {
    const match = new RegExp(spec.regex, "m").exec(stdout);
    if (!match) {
      throw new AdapterError(
        `${what}: 正则 ${spec.regex} 在 CLI 输出里没匹配到`);
    }
    return match[1] ?? match[0];
  }
  throw new AdapterError(`${what}: 抽取配置必须给 json/regex/const 之一`);
}

/** 平台状态 → 契约状态。映射表没配=输出必须已经是契约词;
 * 映射不到=502,拒绝猜测——把 UNKNOWN 猜成 running 会让宿主
 * 白轮询到预算耗尽,猜成 failed 会白烧一轮修复。 */
function mapStatus(
  raw: unknown,
  map: Record<string, string> | undefined,
): string {
  const key = String(raw ?? "");
  const mapped = map ? map[key] ?? map[key.toUpperCase()] : key;
  if (!mapped || !CONTRACT_STATUS.has(mapped)) {
    throw new AdapterError(
      `流水线状态 "${key}" 不在映射表里,拒绝猜测——`
      + `请在 status_map 里补上它对应 success/failed/running 哪个`);
  }
  return mapped;
}

function mapCheckStatus(
  raw: unknown,
  map: Record<string, string> | undefined,
): PipelineCheckStatus {
  const key = String(raw ?? "");
  const mapped = map ? map[key] ?? map[key.toUpperCase()] : key.toLowerCase();
  if (!mapped || !CONTRACT_CHECK_STATUS.has(mapped as PipelineCheckStatus)) {
    throw new AdapterError(
      `流水线逐项状态 "${key}" 不在映射表里,拒绝猜测——`
      + `请在 check_status_map 里映射为 `
      + `success/failed/running/pending/canceled/skipped/not_run`);
  }
  return mapped as PipelineCheckStatus;
}

/** 从一次 run 的原始输出中抽出 COMPILE/UT/CODECHECK 逐项事实。 */
function extractChecks(
  spec: CommandSpec,
  stdout: string,
  parsed: () => unknown,
): PipelineCheck[] | undefined {
  if (!spec.checks) return undefined;
  const rawChecks = extract(spec.checks, "checks 数组", stdout, parsed);
  if (!Array.isArray(rawChecks)) {
    throw new AdapterError("checks 抽出来的不是数组——检查 checks 点路径");
  }
  const dimensionSpec = spec.check_dimension ?? { json: "dimension" };
  const statusSpec = spec.check_status ?? { json: "status" };
  return rawChecks.map((raw, index) => {
    const item = () => raw;
    const dimension = String(extract(
      dimensionSpec, `checks[${index}] dimension`, stdout, item,
    ) ?? "").toUpperCase();
    if (!CONTRACT_DIMENSION.has(dimension)) {
      throw new AdapterError(
        `checks[${index}] dimension "${dimension}" 不受支持，`
        + `只允许 COMPILE/UT/CODECHECK`);
    }
    const status = mapCheckStatus(extract(
      statusSpec, `checks[${index}] status`, stdout, item,
    ), spec.check_status_map ?? spec.status_map);
    const optional = (fieldSpec: Extract | undefined) => {
      const value = fieldSpec
        ? extractOptional(fieldSpec, stdout, item) : undefined;
      return value !== undefined && value !== "" ? String(value) : undefined;
    };
    const job = optional(spec.check_job);
    const url = optional(spec.check_url);
    const stage = optional(spec.check_stage ?? { json: "stage" });
    const tool = optional(spec.check_tool ?? { json: "tool" });
    const details = parsePipelineDefects(extractOptional(
      spec.check_details ?? { json: "details" }, stdout, item));
    return {
      dimension: dimension as PipelineCheck["dimension"],
      status,
      ...(job !== undefined ? { job } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(tool !== undefined ? { tool } : {}),
      ...(details.length ? { details } : {}),
    };
  });
}

/** is_valid 原始值 → 布尔。平台可能给布尔、"false"/"0"、大小写混杂;
 * 只有明确的否定词才判 false——半懂不懂的值当 true(拒过期结果另有
 * run_sha 核验兜底,别把有效流水线误杀成过期结果)。 */
function parseValidity(raw: unknown): boolean {
  if (raw === false) return false;
  return !["false", "0", "no"].includes(String(raw ?? "").toLowerCase());
}

/** 把适配器的多条流水线统一成旧→新。现网外置配置曾长期请求
 * sort=desc；宿主升级为 runs.at(-1) 后若继续原样透传，会把最老 run
 * 当成当前事实。pipeline_id 是唯一可靠顺序键：完整时机械升序；只有
 * 明确 is_valid=false 的过期结果允许缺 id 并被放到最前。其余多 run 无法
 * 判断新旧，宁可让该候选失败，也不能拿历史绿灯放行。 */
function orderStatusRuns(
  runs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (runs.length <= 1) return runs;
  const rows = runs.map((run) => {
    const raw = String(run.pipeline_id ?? "").trim();
    return {
      run,
      id: /^\d+$/.test(raw) ? BigInt(raw) : undefined,
    };
  });
  if (rows.every((row) => row.id !== undefined)) {
    return rows.sort((left, right) => left.id! < right.id! ? -1
      : left.id! > right.id! ? 1 : 0).map((row) => row.run);
  }
  const ordered = rows.filter((row) => row.id !== undefined);
  const missing = rows.filter((row) => row.id === undefined);
  if (ordered.length > 0
      && missing.every((row) => row.run.is_valid === false)) {
    ordered.sort((left, right) => left.id! < right.id! ? -1
      : left.id! > right.id! ? 1 : 0);
    return [...missing.map((row) => row.run),
      ...ordered.map((row) => row.run)];
  }
  throw new AdapterError(
    "pipeline_status 返回多条 run，但 pipeline_id 缺失或不是十进制整数，"
    + "无法可靠判断最新流水线；请配置 pipeline_id 抽取或改用 contract 输出",
  );
}

export class PlatformAdapter {
  private readonly config: AdapterConfig;
  private serviceToken = "";
  private readonly queries = new PlatformQueryCache();
  /** 调用账落点(#408):构造时按配置文件位置定。 */
  private adapterCallsFile = "";

  constructor(configPath: string, private log = console.error) {
    // 部署配置语义:坏了拒绝启动。带着一半配置起服,比不起服更害人。
    const raw = readFileSync(configPath, "utf-8");
    this.config = JSON.parse(raw) as AdapterConfig;
    const mrCreate = this.config.mr_create;
    if (!Array.isArray(mrCreate?.command) || mrCreate.command.length === 0) {
      throw new Error("配置缺 mr_create.command(argv 数组)");
    }
    const trigger = this.config.pipeline_trigger;
    if (trigger?.observe_only !== true
        && (!Array.isArray(trigger?.command) || trigger.command.length === 0)) {
      throw new Error("配置缺 pipeline_trigger.command(argv 数组)");
    }
    // pipeline_status 允许降级链:每个候选都要是完整可执行的 spec。
    const statusCandidates = this.config.pipeline_status
      ? candidatesOf(this.config.pipeline_status) : [];
    if (!statusCandidates.length) {
      throw new Error("配置缺 pipeline_status(单命令或 candidates 数组)");
    }
    statusCandidates.forEach((candidate, index) => {
      if (!Array.isArray(candidate?.command) || !candidate.command.length) {
        throw new Error(
          `pipeline_status 候选[${index}] 缺 command(argv 数组)`);
      }
    });
    if (this.config.token_file) {
      this.serviceToken = readFileSync(this.config.token_file, "utf-8").trim();
    } else if (this.config.token) {
      this.serviceToken = this.config.token;
    }
    if (!this.serviceToken) {
      // 显眼警告,不拒启:引用 {token} 的命令模板仍可靠请求头里的
      // 个人令牌逐请求工作;两头皆空时每条命令都会 401(issue-383:
      // token 文件在盘但 adapter.json 没引用,25,712 条 401 靠考古发现)。
      // 让「没配服务令牌」在启动一瞬可见,而不是在错误日志里沉底。
      console.warn("[adapter] 未配置服务令牌(token/token_file 皆空):"
        + "引用 {token} 的命令模板将逐请求依赖个人令牌头,"
        + "缺失时全部失败——请检查 adapter.json");
    }
    // 调用账落点(#408):配置文件旁 logs/adapter-calls.jsonl——适配层
    // 是独立进程,不知识别的 dataDir;与配置同区,部署纪律见文档。
    this.adapterCallsFile = join(
      dirname(configPath), "logs", "adapter-calls.jsonl");
  }

  /** 模板套值 + 执行。token 优先用请求头里的个人令牌(MR 发起人=
   * 本人),没有回落服务账号;引用了 {token} 又两头都没有=502,
   * 不带着空令牌去撞平台。 */
  private run(
    spec: CommandSpec,
    values: Record<string, string>,
    maxBuffer = 8 * 1024 * 1024,
  ): Promise<string> {
    const secrets = [values.token, this.serviceToken]
      .filter((value): value is string => !!value);
    const redact = (raw: unknown): string => {
      let text = String(raw ?? "");
      for (const secret of secrets) {
        text = text.split(secret).join("<token>");
      }
      return text;
    };
    const [executable, ...args] = spec.command.map((part) =>
      part.replace(/\{(\w+)\}/g, (_whole, name: string) => {
        const value = values[name];
        if (value === undefined || value === "") {
          throw new AdapterError(
            `命令引用了 {${name}} 但没有值`
            + (name === "token" ? "(个人令牌没带、服务账号也没配)" : ""));
        }
        return value;
      }));
    const timeoutMs =
      (spec.timeout_s ?? this.config.timeout_s ?? 60) * 1000;
    return new Promise((resolve, reject) => {
      execFile(executable, args,
        { encoding: "utf-8", timeout: timeoutMs, maxBuffer },
        (error, stdout, stderr) => {
          if (error) {
            reject(new AdapterError(
              `CLI 失败: ${executable} 退出异常(`
              + `${redact(error.message).slice(0, 200)})`
              + `\nstderr: ${redact(stderr).slice(0, 1000)}`));
          } else {
            // Windows CLI(WSL 互操作调 .exe / 适配层直跑 Windows)输出
            // 是 \r\n,\r 会咬正则抽取一口——统一归一化,JSON 不受影响。
            resolve(String(stdout).replace(/\r/g, ""));
          }
        });
    });
  }

  /** 请求级取值表。个人身份从请求头来(percent 编码,防非 ASCII
   * 撞 HTTP 头限制),宿主侧 tryDeliver 同一约定。 */
  private values(
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const decode = (value: unknown) => {
      try {
        return decodeURIComponent(String(value ?? ""));
      } catch {
        return String(value ?? "");
      }
    };
    const personal = decode(headers["x-mfc-git-token"]);
    // Node 会把真实 HTTP 头归一成小写；handle 也会被测试/嵌入方直接
    // 调用，那里未必归一。大小写不敏感地读取，header 优先、请求体
    // idempotency_key 兼容没有转发该头的旧网关。模板显式引用
    // {idempotency_key} 后，真实 discussion_reply CLI 才能把宿主 outbox
    // 的稳定动作键传给平台，封住“远端成功、本地未落账”的重放窗口。
    const idempotencyHeader = Object.entries(headers).find(([name]) =>
      name.toLowerCase() === "idempotency-key")?.[1];
    const idempotencyKey = decode(Array.isArray(idempotencyHeader)
      ? idempotencyHeader[0] : idempotencyHeader).trim()
      || String(body.idempotency_key ?? "").trim();
    // {repo_path}:从仓库 URL 自动派生"URL 编码的项目路径"——
    // CodeHub REST 按 /api/v3/projects/{路径}/... 定位仓,人不该手抄
    // 项目 id(用户拍板:能从 MR/仓地址推出来的就自动拿)。
    // 非 URL(本地路径/空)时留空,模板引用到会诚实报"没有值"。
    const repoUrl = String(body.repo ?? "");
    let repoPath = "";
    try {
      repoPath = new URL(repoUrl).pathname
        .replace(/^\/+/, "").replace(/\.git$/, "");
    } catch { /* 不是 URL 就没有路径可派生 */ }
    return {
      repo: repoUrl,
      repo_path: encodeURIComponent(repoPath),
      source_branch: String(body.source_branch ?? ""),
      target_branch: String(body.target_branch ?? ""),
      title: String(body.title ?? ""),
      // E2E 单号(REQ/DTS 都可能):mr_create 模板拿它填 --e2e-issues,
      // MR 与单号在平台侧可追踪。取值表是白名单不是任意透传——body 里
      // 没带而模板引用了 {dts_no},render 会诚实报"没有值",别猜。
      dts_no: String(body.dts_no ?? ""),
      sha: String(body.sha ?? ""),
      mr: String(body.mr ?? ""),
      id: String(body.id ?? ""),
      body: String(body.body ?? ""),
      resolve: String(body.resolve ?? ""),
      idempotency_key: idempotencyKey,
      token: personal || this.serviceToken,
      git_username: decode(headers["x-mfc-git-user"]),
    };
  }

  /** pipeline_status 单候选执行。contract 模式=命令输出就是宿主契约
   * (仓内编排脚本形态);模板模式=逐字段抽取。两条路的 status 都逐
   * run 核验契约词——降级不降诚实。 */
  private async statusRuns(
    spec: CommandSpec,
    values: Record<string, string>,
  ): Promise<Array<Record<string, unknown>>> {
    const stdout = await this.run(spec, values);
    let parsedCache: unknown;
    const parsed = () => parsedCache ??= JSON.parse(stdout);
    if (spec.contract) {
      const list = (parsed() as { runs?: unknown }).runs;
      if (!Array.isArray(list)) {
        throw new AdapterError(
          "contract 模式要求输出 {runs:[...]},实际没有 runs 数组"
          + `(输出前 300 字: ${stdout.slice(0, 300)})`);
      }
      const runs = list.map((run, index) => {
        const row = (run ?? {}) as Record<string, unknown>;
        const status = String(row.status ?? "");
        if (!CONTRACT_STATUS.has(status)) {
          throw new AdapterError(
            `contract 模式 runs[${index}].status "${status}" 不是契约词`
            + "(success/failed/running)——脚本必须自己完成映射,不猜");
        }
        // 白名单透传:契约外的字段不带给宿主,脚本升级不会悄悄改契约。
        return {
          status,
          ...(row.log !== undefined ? { log: String(row.log) } : {}),
          ...(Array.isArray(row.checks) ? { checks: row.checks } : {}),
          ...(row.sha ? { sha: String(row.sha) } : {}),
          ...(row.pipeline_id
            ? { pipeline_id: String(row.pipeline_id) } : {}),
          ...(row.is_valid !== undefined
            ? { is_valid: parseValidity(row.is_valid) } : {}),
          ...(row.web_url ? { web_url: String(row.web_url) } : {}),
        };
      });
      return orderStatusRuns(runs);
    }
    const list = spec.runs
      ? extract(spec.runs, "runs 数组", stdout, parsed)
      : parsed();
    if (!Array.isArray(list)) {
      throw new AdapterError("pipeline_status 抽出来的不是数组");
    }
    const runs = list.map((run) => {
      const current = () => run;
      const status = mapStatus(
        extract(spec.status, "run 状态", stdout, current),
        spec.status_map);
      const log = spec.log
        ? String(extractOptional(spec.log, stdout, current) ?? "")
        : undefined;
      const checks = extractChecks(spec, stdout, current);
      const optional = (fieldSpec: Extract | undefined) => {
        const value = fieldSpec
          ? extractOptional(fieldSpec, stdout, current) : undefined;
        return value !== undefined && value !== "" ? value : undefined;
      };
      const sha = optional(spec.run_sha);
      const pipelineId = optional(spec.pipeline_id);
      const validity = optional(spec.is_valid);
      const webUrl = optional(spec.web_url);
      return {
        status,
        ...(log !== undefined ? { log } : {}),
        ...(checks !== undefined ? { checks } : {}),
        ...(sha !== undefined ? { sha: String(sha) } : {}),
        ...(pipelineId !== undefined
          ? { pipeline_id: String(pipelineId) } : {}),
        ...(validity !== undefined
          ? { is_valid: parseValidity(validity) } : {}),
        ...(webUrl !== undefined ? { web_url: String(webUrl) } : {}),
      };
    });
    return orderStatusRuns(runs);
  }

  /** pipeline_artifacts 单候选执行:命令下载到目录(SSE 网关那类)→
   * 读目录;或命令直接输出 JSON → items/fields 抽 {name, text}。 */
  private async artifactFiles(
    spec: ListSpec,
    values: Record<string, string>,
  ): Promise<Array<{ name: string; text: string }>> {
    if (spec.files_dir) {
      await this.run(spec, values);
      const dir = spec.files_dir.replace(/\{(\w+)\}/g,
        (_whole, name: string) => values[name] ?? "");
      return existsSync(dir)
        ? readdirSync(dir).map((name) => ({
            name,
            text: readFileSync(join(dir, name), "utf-8"),
          }))
        : [];
    }
    const { items } = await this.runList(spec, values, 128 * 1024 * 1024);
    return items
      .filter((row) => row.name !== undefined && row.text !== undefined)
      .map((row) => ({ name: String(row.name), text: String(row.text) }));
  }

  /** 列表端点的通用执行:跑命令→取数组→逐字段抽。字段抽取失败按
   * "这个字段没有"处理(可选字段是常态),但 items 指错=502 明说。 */
  private async runList(
    spec: ListSpec,
    values: Record<string, string>,
    maxBuffer?: number,
  ): Promise<{ stdout: string; parsed: () => unknown;
               items: Array<Record<string, unknown>> }> {
    const stdout = await this.run(spec, values, maxBuffer);
    let parsedCache: unknown;
    const parsed = () => parsedCache ??= JSON.parse(stdout);
    const rawList = spec.items
      ? extract(spec.items, "items 数组", stdout, parsed)
      : parsed();
    if (!Array.isArray(rawList)) {
      throw new AdapterError("items 抽出来的不是数组——检查 items 点路径");
    }
    const items = rawList.map((element) => {
      const row: Record<string, unknown> = {};
      for (const [name, fieldSpec] of Object.entries(spec.fields ?? {})) {
        row[name] = extractOptional(fieldSpec, stdout, () => element);
      }
      return row;
    });
    return { stdout, parsed, items };
  }

  private async eligibleApprovers(requested: string[], values: Record<string, string>): Promise<{ accounts: string[]; message?: string }> {
    const spec = this.config.mr_approver_members;
    if (!spec) return { accounts: [], message: "未配置仓库成员查询，本次未添加审批人" };
    try {
      // 不缓存跨仓或跨身份的权限快照；查询有界，不能挡住 MR 创建。
      const { items } = await this.runList({ ...spec, timeout_s: Math.min(spec.timeout_s ?? 15, 15) }, values);
      const allowed = new Set<string>();
      for (const row of items) {
        const level = typeof row.access_level === "string" && /^\d+$/.test(row.access_level)
          ? Number(row.access_level) : row.access_level;
        if (typeof row.username !== "string" || !row.username.trim() || typeof level !== "number" || !Number.isInteger(level)) {
          throw new AdapterError("仓库成员缺少有效账号或权限等级");
        }
        if (level >= 35 && row.username !== values.git_username) allowed.add(row.username);
      }
      const accounts = requested.filter(account => allowed.has(account));
      const omitted = requested.filter(account => !allowed.has(account));
      return { accounts, ...(omitted.length ? { message: `本次未添加未确认审批资格的账号：${omitted.join(", ")}` } : {}) };
    } catch {
      // 上游错误可能包含凭据；后台保留未确认事实，不把原始响应带给用户。
      return { accounts: [], message: "仓库成员查询失败或响应无效，本次未添加审批人" };
    }
  }

  /** 查同分支对已开的 MR(mr_lookup 配了才查)。查询失败/抽不到 url
   * 一律回 undefined——查不到不是错,走创建;真正的诚实失败留给
   * 创建那一步报。 */
  private async lookupMr(
    values: Record<string, string>,
  ): Promise<{ url: string; id?: string } | undefined> {
    const spec = this.config.mr_lookup;
    if (!spec?.url) return undefined;
    try {
      const stdout = await this.run(spec, values);
      let parsedCache: unknown;
      const parsed = () => parsedCache ??= JSON.parse(stdout);
      const url = String(extractOptional(spec.url, stdout, parsed) ?? "");
      if (!url) return undefined;
      const id = spec.id
        ? extractOptional(spec.id, stdout, parsed) : undefined;
      return { url, ...(id !== undefined ? { id: String(id) } : {}) };
    } catch {
      return undefined;
    }
  }

  private gatePassed(spec: ListSpec, raw: unknown): boolean {
    const accepted = (spec.passed_values
      ?? ["true", "1", "passed", "success", "yes"])
      .map((word) => word.toLowerCase());
    return accepted.includes(String(raw ?? "").toLowerCase());
  }

  /** 对外入口:适配层调用账(ADR-0053,#408)统一在此记——每请求一行
   *  (端点/状态/耗时/错误原文),parent_request_id 取宿主透传的
   *  x-mfc-request-id,两侧账按同一动作 id 对上(#383② 的另一半)。
   *  账落配置文件旁 logs/adapter-calls.jsonl,复用审计原语(双时间、
   *  fail-open、滚动压缩)。body/query 只记白名单参数摘要,密钥头
   *  (x-mfc-git-token 等)永不进账;CLI 错误原文在 run() 内已掩码。 */
  async handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<QueryResult> {
    const startedAt = Date.now();
    const rawParent = headers["x-mfc-request-id"];
    const parentValue = Array.isArray(rawParent) ? rawParent[0] : rawParent;
    let parentRequestId: string | undefined;
    try {
      parentRequestId = decodeURIComponent(String(parentValue ?? "")) || undefined;
    } catch {
      parentRequestId = String(parentValue ?? "") || undefined;
    }
    const summary: Record<string, unknown> = {};
    for (const key of ["repo", "mr", "sha", "dts_no", "discussion_id"] as const) {
      const value = body[key] ?? query.get(key);
      if (value !== undefined && value !== null && value !== "") {
        summary[key] = value;
      }
    }
    try {
      const identity = this.values({}, headers);
      const scope = createHash("sha256").update(identity.token).digest("hex");
      const configured = path === "/mr/gates" ? this.config.mr_gates
        : path === "/mr/discussions" ? this.config.mr_discussions
        : path === "/mr/discover" ? this.config.mr_discover
        : path === "/pipeline/status" ? this.config.pipeline_status
        : path === "/pipeline/artifacts" ? this.config.pipeline_artifacts : undefined;
      const read = method === "GET" && !!configured;
      const params = new URLSearchParams(query); params.sort();
      // 已指定 MR 时，两流程附带的分支名差异不应拆成两次对象查询。
      if (path === "/mr/gates" && params.get("mr")
          && this.config.mr_gates?.command.some(arg => arg.includes("{mr}"))
          && !this.config.mr_gates.command.some(arg => /\{(?:source|target)_branch\}/.test(arg))) {
        params.delete("source_branch"); params.delete("target_branch");
      }
      const observed = read ? await this.queries.read(scope, path + "?" + params, () => this.route(method, path, query, body, headers), path !== "/pipeline/artifacts")
        : { result: await this.route(method, path, query, body, headers), source: "direct" };
      const result = observed.result;
      if (method === "POST" && result.status >= 200 && result.status < 300) this.queries.invalidate(scope);
      appendAudit(this.adapterCallsFile, {
        kind: "adapter.call",
        msg: `${method} ${path} → ${result.status}`,
        ...(parentRequestId ? { parent_request_id: parentRequestId } : {}),
        endpoint: `${method} ${path}`,
        status: result.status,
        query_source: observed.source,
        duration_ms: Date.now() - startedAt,
        ...(Object.keys(summary).length ? { params: summary } : {}),
        ...(result.status >= 400 ? { level: "warn" as const } : {}),
      });
      return result;
    } catch (error) {
      // AdapterError 的消息在 run() 内已过密钥掩码;此处如实记账再抛,
      // HTTP 层(serve)照旧把 AdapterError 转 502。
      appendAudit(this.adapterCallsFile, {
        kind: "adapter.call", level: "error",
        msg: `${method} ${path} → 异常`,
        ...(parentRequestId ? { parent_request_id: parentRequestId } : {}),
        endpoint: `${method} ${path}`,
        duration_ms: Date.now() - startedAt,
        ...(Object.keys(summary).length ? { params: summary } : {}),
        error: String(error instanceof Error ? error.message : error),
      });
      throw error;
    }
  }

  private async route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ status: number; payload: unknown }> {
    if (method === "GET" && path === "/") {
      return { status: 200, payload: {
        ok: true,
        endpoints: ["POST /mr", "POST /pipeline/trigger",
                    "GET /pipeline/status?sha=&repo="],
      } };
    }
    if (method === "POST" && path === "/mr") {
      const requested = body.participants === undefined ? undefined : normalizeMrParticipants(body.participants);
      const values = this.values(body, headers);
      if (body.purpose === "knowledge" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(values.dts_no)) throw new AdapterError("知识归档必须填写一个有效的关联单号");
      // 先查后建:同分支对已有开着的 MR 就复用,不去撞平台的幂等
      // 语义(CLI 报 stderr / REST 静默 200 空 body,形状不统一)。
      const found = await this.lookupMr(values);
      const reused = (mr: { url: string; id?: string }) => ({ status: 201, payload: { ...mr,
        ...(hasMrParticipants(requested) ? { participants: { status: "skipped", requested,
          message: "已有 MR 保留原人员设置；如需调整，请在 CodeHub 中维护" } satisfies MrParticipantsResult } : {}) } });
      if (found) return reused(found);
      const spec = body.purpose === "knowledge" ? this.config.mr_create_knowledge ?? this.config.mr_create : this.config.mr_create;
      if (body.purpose === "knowledge" && !spec.command.some(arg => arg.includes("{dts_no}"))) throw new AdapterError("知识归档命令未配置单号关联，请在 mr_create_knowledge 中配置 {dts_no}");
      const command = [...spec.command];
      let participants: MrParticipantsResult | undefined;
      if (hasMrParticipants(requested)) {
        const messages: string[] = [];
        for (const role of MR_PARTICIPANT_ROLES) {
          if (!requested[role].length) continue;
          const flag = spec.participant_flags?.[role];
          if (typeof flag !== "string" || !/^--?[A-Za-z][A-Za-z0-9-]*$/.test(flag)) {
            messages.push(`创建 MR 命令未配置有效的人员参数: ${role}`);
          } else {
            let accounts = requested[role];
            if (role === "approval_approvers") {
              const eligible = await this.eligibleApprovers(accounts, values);
              accounts = eligible.accounts;
              if (eligible.message) messages.push(eligible.message);
            }
            if (accounts.length) command.push(flag, accounts.join(","));
          }
        }
        // applied 表示创建命令成功接受了名单，不表示另行回读核验。
        participants = { status: messages.length ? "failed" : "applied", requested,
          ...(messages.length ? { message: messages.join("；") } : {}) };
      }
      try {
        const stdout = await this.run({ ...spec, command }, values);
        let parsedCache: unknown;
        const parsed = () => parsedCache ??= JSON.parse(stdout);
        const url = extract(spec.url, "MR 链接", stdout, parsed);
        if (typeof url !== "string" || !url.trim()) throw new AdapterError("创建 MR 命令未返回有效的 MR 链接");
        const id = spec.id
          ? extractOptional(spec.id, stdout, parsed) : undefined;
        return { status: 201, payload: {
          url,
          ...(id !== undefined ? { id: String(id) } : {}),
          ...(participants ? { participants } : {}),
        } };
      } catch (error) {
        // 退出异常或输出不完整也可能已经创建成功，只查询恢复链接。
        // 不去掉人员参数重新创建，避免同一请求造成重复 MR。
        const retried = await this.lookupMr(values);
        if (retried) return reused(retried);
        throw error;
      }
    }
    if (method === "POST" && path === "/pipeline/trigger") {
      const spec = this.config.pipeline_trigger;
      if (spec.observe_only === true) {
        const result = await this.handle("GET", "/pipeline/status", new URLSearchParams({
          sha: String(body.sha ?? ""), repo: String(body.repo ?? ""), mr: String(body.mr ?? ""),
        }), {}, headers);
        return result.status >= 200 && result.status < 300 ? { ...result, status: 201 } : result;
      }
      const stdout = await this.run(spec, this.values(body, headers));
      let parsedCache: unknown;
      const parsed = () => parsedCache ??= JSON.parse(stdout);
      const status = mapStatus(
        extract(spec.status, "流水线状态", stdout, parsed), spec.status_map);
      const log = spec.log
        ? String(extractOptional(spec.log, stdout, parsed) ?? "") : undefined;
      const checks = extractChecks(spec, stdout, parsed);
      return { status: 201, payload: {
        status, log, ...(checks !== undefined ? { checks } : {}),
      } };
    }
    if (method === "GET" && path === "/pipeline/status") {
      const values = this.values({
        sha: query.get("sha") ?? "",
        repo: query.get("repo") ?? "",
        // MR 标识(宿主知道就带):actual_head_pipeline 按 MR 定位,
        // 编排脚本有它就免去"用 sha 反查 MR"的一跳。
        mr: query.get("mr") ?? "",
      }, headers);
      // 降级链:候选逐个试,首个成功赢;每路失败原因单独记日志,
      // 全败聚合上报——单点故障是对比报告点名的差距①。
      const failures: string[] = [];
      for (const spec of candidatesOf(this.config.pipeline_status)) {
        try {
          return { status: 200,
                   payload: { runs: await this.statusRuns(spec, values) } };
        } catch (error) {
          if (codeHubRateLimited(error)) throw error;
          const reason = String((error as Error).message ?? error);
          failures.push(reason.slice(0, 500));
          this.log(`[adapter] pipeline_status 候选[${failures.length - 1}] `
            + `失败,尝试下一路: ${reason.slice(0, 300)}`);
        }
      }
      throw new AdapterError(
        "pipeline_status 全部候选失败:\n"
        + failures.map((why, index) => `候选[${index}]: ${why}`).join("\n"));
    }
    // ---- MR 闭环的四个可选端点:不配=404,宿主 fail-open ----
    if (method === "GET" && path === "/mr/detail") {
      if (!this.config.mr_detail) return { status: 404, payload: { error: "未配置 mr_detail" } };
      const url = normalizeRepairMrUrl(query.get("mr_url"));
      const head = query.get("version_head");
      if (head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head))
        return { status: 400, payload: { error: "MR 比较版本无效" } };
      const output = await this.run(this.config.mr_detail, this.values({ mr: url, sha: head ?? "current" }, headers));
      return { status: 200, payload: parseDeliveryMr(JSON.parse(output), url) };
    }
    if (method === "GET" && path === "/mr/discover") {
      if (!this.config.mr_discover) return { status: 404, payload: { error: "未配置 mr_discover" } };
      const values = this.values({ repo: query.get("repo") ?? "", source_branch: query.get("source_branch") ?? "", target_branch: query.get("target_branch") ?? "" }, headers);
      const payload = JSON.parse(await this.run(this.config.mr_discover, values));
      if (!Array.isArray(payload?.mrs)) throw new AdapterError("MR 查找未返回 mrs 数组");
      return { status: 200, payload };
    }
    if (method === "POST" && path === "/mr/close") {
      const spec = this.config.mr_close;
      if (!spec) return { status: 404, payload: { error: "未配置 mr_close，请更新 adapter.json" } };
      const values = this.values(body, headers);
      const result = JSON.parse(await this.run(spec, values));
      const state = String(result.state ?? result.mr_state ?? "");
      if (state !== "closed") throw new AdapterError(`旧 MR 未关闭，平台返回状态：${state || "未知"}`);
      return { status: 200, payload: { mr_state: "closed" } };
    }
    if (method === "GET" && path === "/mr/gates") {
      const spec = this.config.mr_gates;
      if (!spec) return { status: 404, payload: { error: "未配置 mr_gates" } };
      const values = this.values({
        repo: query.get("repo") ?? "",
        source_branch: query.get("source_branch") ?? "",
        target_branch: query.get("target_branch") ?? "",
        mr: query.get("mr") ?? "",
      }, headers);
      const mrStateOf = (stdout: string, parsed: () => unknown) => {
        const rawState = spec.mr_state
          ? String(extractOptional(spec.mr_state, stdout, parsed) ?? "")
          : "opened";
        const mapped = spec.mr_state_map?.[rawState] ?? rawState;
        return ["opened", "merged", "closed"].includes(mapped)
          ? mapped : "opened"; // 认不出的生命周期按在途处理,别把单误杀
      };
      const mrShaOf = (stdout: string, parsed: () => unknown) => {
        if (!spec.mr_sha) return {};
        const sha = extract(spec.mr_sha, "MR 源提交 SHA", stdout, parsed);
        if (typeof sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
          throw new AdapterError("MR 源提交 SHA 缺失或无效");
        }
        return { sha };
      };
      // 平铺布尔模式:CodeHub mergeable_state 的真实形状(报告 B 节)
      // ——门禁不是数组,是对象里一堆 *_passed 布尔 + reason 文案。
      // 布尔字段即门禁(非布尔跳过),ignore_fields 剔掉总开关类字段;
      // 宿主那头"认不出的名字按等人处理",所以多出来的布尔门禁安全。
      if (spec.bools) {
        const stdout = await this.run(spec, values);
        let parsedCache: unknown;
        const parsed = () => parsedCache ??= JSON.parse(stdout);
        const bools = extract(spec.bools, "门禁布尔对象", stdout, parsed);
        if (!bools || typeof bools !== "object" || Array.isArray(bools)) {
          throw new AdapterError(
            "bools 抽出来的不是对象——检查 bools 点路径");
        }
        const reason = spec.reason
          ? extractOptional(spec.reason, stdout, parsed) : undefined;
        const ignore = new Set(spec.ignore_fields ?? []);
        const gates = Object.entries(bools as Record<string, unknown>)
          .filter(([name, value]) =>
            typeof value === "boolean" && !ignore.has(name))
          .map(([name, value]) => {
            const why = (reason as Record<string, unknown> | undefined)
              ?.[name];
            return {
              name,
              passed: value as boolean,
              ...(why !== undefined && why !== null && why !== "" ? {
                detail: typeof why === "string" ? why : JSON.stringify(why),
              } : {}),
            };
          });
        return { status: 200, payload: {
          mr_state: mrStateOf(stdout, parsed), ...mrShaOf(stdout, parsed), gates } };
      }
      const { stdout, parsed, items } = await this.runList(spec, values);
      return { status: 200, payload: {
        mr_state: mrStateOf(stdout, parsed),
        ...mrShaOf(stdout, parsed),
        gates: items
          .filter((row) => row.name !== undefined)
          .map((row) => ({
            name: String(row.name),
            passed: this.gatePassed(spec, row.passed),
            ...(row.detail !== undefined
              ? { detail: String(row.detail) } : {}),
          })),
      } };
    }
    if (method === "GET" && path === "/mr/discussions") {
      const spec = this.config.mr_discussions;
      if (!spec) {
        return { status: 404, payload: { error: "未配置 mr_discussions" } };
      }
      const { items } = await this.runList(spec, this.values({
        repo: query.get("repo") ?? "",
        mr: query.get("mr") ?? "",
      }, headers));
      return { status: 200, payload: {
        discussions: items
          .filter((row) => row.id !== undefined && row.id !== "")
          .map((row) => ({
            id: String(row.id),
            ...(row.revision !== undefined
              && Number.isSafeInteger(Number(row.revision))
              ? { revision: Number(row.revision) } : {}),
            ...(row.updated_at !== undefined
              ? { updated_at: String(row.updated_at) } : {}),
            ...(row.file !== undefined ? { file: String(row.file) } : {}),
            ...(row.line !== undefined ? { line: Number(row.line) } : {}),
            ...(row.severity !== undefined
              ? { severity: String(row.severity) } : {}),
            ...(row.author !== undefined
              ? { author: String(row.author) } : {}),
            ...(row.body !== undefined ? { body: String(row.body) } : {}),
          })),
      } };
    }
    {
      const replyMatch = path.match(/^\/mr\/discussions\/([^/]+)\/reply$/);
      if (method === "POST" && replyMatch) {
        const spec = this.config.discussion_reply;
        if (!spec) {
          return { status: 404,
                   payload: { error: "未配置 discussion_reply" } };
        }
        const values = this.values(
          { ...body, id: decodeURIComponent(replyMatch[1]) }, headers);
        // 宿主 outbox 带了 idempotency_key 时，模板必须引用它——否则
        // "远端成功、本地未落 delivered"的重放会重复发言。codehub-cli
        // 这类 CLI 没有幂等键参数时，配 idempotency_no_cli_key=true
        // 降级：靠 outbox 的 delivered 标记防重放（重启丢 outbox 除外），
        // 不靠 CLI 幂等。模板仍应带 --no-cache 避免缓存层假成功。
        if (values.idempotency_key
            && !spec.command.some((part) =>
              part.includes("{idempotency_key}"))
            && !spec.idempotency_no_cli_key) {
          throw new AdapterError(
            "discussion_reply 收到了 idempotency_key，但命令模板未引用 "
            + "{idempotency_key}；已拒绝非幂等发送，请把该占位符传给"
            + "平台支持的幂等请求头或稳定键参数，"
            + "或在配置里设 idempotency_no_cli_key=true 降级为 outbox 防重放");
        }
        const stdout = await this.run(spec, values);
        // 回复与"标已解决"是两个调用(报告 D3)。宿主默认不代
        // resolve(检视人的职责);带了 resolve:true 且配了第二条
        // 命令才执行——新代 CLI 要 note id,从 reply 输出里抽。
        let resolved = false;
        if (values.resolve === "true" && this.config.discussion_resolve) {
          let parsedCache: unknown;
          const parsed = () => parsedCache ??= JSON.parse(stdout);
          const noteId = spec.note_id
            ? String(extractOptional(spec.note_id, stdout, parsed) ?? "")
            : "";
          await this.run(this.config.discussion_resolve,
            { ...values, note_id: noteId });
          resolved = true;
        }
        return { status: 200, payload: { ok: true, resolved } };
      }
    }
    {
      // 仅标已解决、不跟帖(2026-09-18,问题流「忽略」用):与 reply 的
      // 差别是没有答复输出,拿不到 note id——部署的 discussion_resolve
      // 模板要按讨论 id({id})解析才能走这条路;按 {note_id} 写的旧
      // 模板只服务"答复带 resolve"的老路,走这里会拿空 note id,如实
      // 404 提示。宿主仍不主动调它,只在宿主动作明确要求时执行。
      const resolveMatch = path.match(/^\/mr\/discussions\/([^/]+)\/resolve$/);
      if (method === "POST" && resolveMatch) {
        const spec = this.config.discussion_resolve;
        if (!spec) {
          return { status: 404,
                   payload: { error: "未配置 discussion_resolve" } };
        }
        // 请求体原样透传(与 reply 处理器同款):模板引用 {mr} 之类的
        // 占位符时值来自 body——手工挑字段会把 body 里的 mr 丢掉,
        // 模板必然报「引用了 {mr} 但没有值」(issue-383 的确定性故障)。
        await this.run(spec, this.values(
          { ...body, id: decodeURIComponent(resolveMatch[1]) }, headers));
        return { status: 200, payload: { ok: true, resolved: true } };
      }
    }
    if (method === "GET" && path === "/pipeline/artifacts") {
      if (!this.config.pipeline_artifacts) {
        return { status: 404,
                 payload: { error: "未配置 pipeline_artifacts" } };
      }
      // 这里的 mr 契约是完整 MR URL。宿主 mirrorPipelineArtifacts 与
      // pipeline-artifacts.sh 的第 4 参都按 MR-first 语义传递；不要改成
      // status 主路使用的 iid，否则 query_mr_info 无法定位 MR。
      const values = this.values({
        sha: query.get("sha") ?? "",
        repo: query.get("repo") ?? "",
        mr: query.get("mr") ?? "",
      }, headers);
      // 降级链同 pipeline_status:失败材料是修复 Agent 的口粮,一路
      // 挂了换下一路,全败才 502。空文件列表不算失败(材料可能真没有),
      // 但记一句日志方便排查"桥跑了却没落盘"。
      const failures: string[] = [];
      for (const spec of candidatesOf(this.config.pipeline_artifacts)) {
        try {
          const files = await this.artifactFiles(spec, values);
          if (!files.length) {
            this.log("[adapter] pipeline_artifacts 本路成功但零文件"
              + "(材料缺席或落盘目录配错)");
          }
          return { status: 200, payload: { files } };
        } catch (error) {
          if (codeHubRateLimited(error)) throw error;
          const reason = String((error as Error).message ?? error);
          failures.push(reason.slice(0, 500));
          this.log(`[adapter] pipeline_artifacts 候选[${failures.length - 1}]`
            + ` 失败,尝试下一路: ${reason.slice(0, 300)}`);
        }
      }
      throw new AdapterError(
        "pipeline_artifacts 全部候选失败:\n"
        + failures.map((why, index) => `候选[${index}]: ${why}`).join("\n"));
    }
    return { status: 404, payload: { error: "未知路径" } };
  }

  /** 自检(--selftest):把"内网那边的形状"打印出来带回给外网看——
   * 每个端点的解析后命令(令牌打码)、只读端点的一次真实调用与契约
   * 字段核对。变更类端点(mr_create/trigger/reply)只印命令不执行。 */
  async selftest(sample: Record<string, string>): Promise<string> {
    const lines: string[] = ["== adapter selftest =="];
    const mask = (parts: string[]) => parts
      .map((part) => part.replace(/\{token\}/g, "<token>")).join(" ");
    const trigger = this.config.pipeline_trigger;
    lines.push(trigger.observe_only === true
      ? "[配置] pipeline_trigger: observe_only，复用 pipeline_status，只观察已有运行"
      : `[配置] pipeline_trigger(只印不执行): ${mask(trigger.command)}`);
    const sections: Array<[string, CommandSpec | undefined]> = [
      ["mr_create(只印不执行)", this.config.mr_create],
      ["mr_close(只印不执行)", this.config.mr_close],
      ["mr_lookup(先查后建的查询)", this.config.mr_lookup],
      ["mr_discover(全生命周期查找)", this.config.mr_discover],
      ["mr_detail(独立修复读取 MR)", this.config.mr_detail],
      ["mr_gates", this.config.mr_gates],
      ["mr_discussions", this.config.mr_discussions],
      ["discussion_reply(只印不执行)", this.config.discussion_reply],
      ["discussion_resolve(只印不执行)", this.config.discussion_resolve],
    ];
    for (const [name, spec] of sections) {
      lines.push(spec
        ? `[配置] ${name}: ${mask(spec.command)}`
        : `[缺席] ${name}: 未配置(对应端点 404,宿主按旧语义 fail-open)`);
    }
    const knowledgeCreate = this.config.mr_create_knowledge;
    const members = this.config.mr_approver_members;
    lines.push(members
      ? `[配置] mr_approver_members(创建前筛选审批人): ${mask(members.command)}`
      : "[缺席] mr_approver_members: 未配置，创建时将省略审批人");
    lines.push(knowledgeCreate
      ? `[配置] mr_create_knowledge(只印不执行): ${mask(knowledgeCreate.command)}`
      : "[配置] mr_create_knowledge: 未配置，复用 mr_create");
    for (const [name, spec] of [["mr_create", this.config.mr_create],
      ["mr_create_knowledge", knowledgeCreate ?? this.config.mr_create]] as const) {
      lines.push(`[配置] ${name}.participant_flags: ${JSON.stringify(spec.participant_flags ?? {})}`);
    }
    if (this.config.discussion_reply
        && !this.config.discussion_reply.command.some((part) =>
          part.includes("{idempotency_key}"))) {
      lines.push("[错误] discussion_reply 未引用 {idempotency_key}："
        + "宿主虽会携带稳定动作键，但当前 CLI 模板无法把它传给平台，"
        + "真实回复会 fail-closed 保持 outbox pending；请在平台支持的"
        + "幂等参数或请求头位置补上该占位符");
    }
    // 降级链端点逐候选打印——内网对拍时一眼看清有几路、各是什么。
    for (const [name, degradable] of [
      ["pipeline_status", this.config.pipeline_status],
      ["pipeline_artifacts", this.config.pipeline_artifacts],
    ] as const) {
      if (!degradable) {
        lines.push(`[缺席] ${name}: 未配置`);
        continue;
      }
      candidatesOf(degradable).forEach((candidate, index) => {
        lines.push(`[配置] ${name} 候选[${index}]`
          + `${candidate.contract ? "(contract 直通)" : ""}: `
          + mask(candidate.command));
      });
    }
    const statusCandidates = candidatesOf(this.config.pipeline_status);
    lines.push(statusCandidates.some((spec) => spec.contract
      || (spec.checks && spec.check_dimension && spec.check_status))
      ? "[配置] 流水线逐项结果: ok"
      : "[建议] 流水线逐项结果: 当前使用整体流水线核销；建议为 "
        + "pipeline_status 配置 checks / check_dimension / check_status "
        + "(或用 contract 模式的编排脚本)，以便红灯时精确诊断");
    lines.push(statusCandidates.some((spec) => spec.contract
      || spec.run_sha || spec.is_valid)
      ? "[配置] 防过期结果核验: ok (run_sha / is_valid 至少一路可回显)"
      : "[建议] 防过期结果核验: 建议配置 run_sha / is_valid 回显——"
        + "MR 头上无有效流水线时平台挂旧灯,宿主拿不到绑定 SHA 就"
        + "无法机械拒收(2026-08-28 对比报告头号根因)");
    const probes: Array<[string, string, URLSearchParams]> = [
      ["GET /pipeline/status", "/pipeline/status",
       new URLSearchParams({
         sha: sample.sha ?? "", repo: sample.repo ?? "",
         mr: sample.mr ?? "",
       })],
      ["GET /mr/gates", "/mr/gates", new URLSearchParams({
        repo: sample.repo ?? "",
        source_branch: sample.source_branch ?? "",
        target_branch: sample.target_branch ?? "",
        mr: sample.mr ?? "" })],
      ["GET /mr/discussions", "/mr/discussions", new URLSearchParams({
        repo: sample.repo ?? "", mr: sample.mr ?? "" })],
      ["GET /pipeline/artifacts", "/pipeline/artifacts",
       new URLSearchParams({
         sha: sample.sha ?? "", repo: sample.repo ?? "",
         mr: sample.mr_url ?? "",
       })],
    ];
    for (const [label, path, query] of probes) {
      try {
        const result = await this.handle("GET", path, query, {}, {});
        lines.push(`[试跑] ${label} -> HTTP ${result.status}`);
        lines.push("  " + JSON.stringify(result.payload).slice(0, 1500));
      } catch (error) {
        lines.push(`[试跑] ${label} -> 失败: `
          + String((error as Error).message).slice(0, 500));
      }
    }
    lines.push("把以上输出原样带回外网,契约对不上的在外网改,内网不打补丁。");
    return lines.join("\n");
  }

  serve(port?: number): Promise<number> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          response.writeHead(400).end('{"error":"请求体不是 JSON"}');
          return;
        }
        this.handle(request.method ?? "GET", url.pathname,
          url.searchParams, body,
          request.headers as Record<string, string | undefined>)
          .then(({ status, payload, headers }) => {
            response
              .writeHead(status, { "content-type": "application/json", ...headers })
              .end(JSON.stringify(payload));
          })
          .catch((error) => {
            // 诚实失败:宿主拿到 502 会如实记"平台不可用",
            // 绝不下发一个猜出来的状态。日志里不出现令牌。
            this.log(`[adapter] ${url.pathname}: ${String(error?.message ?? error)}`);
            response
              .writeHead(502, { "content-type": "application/json" })
              .end(JSON.stringify({ error: String(error?.message ?? error) }));
          });
      });
    });
    return new Promise((resolve) => {
      const listenPort = port ?? this.config.port ?? 8790;
      // 默认只听回环:适配层拿着服务令牌执行 CLI,敞给全网卡等于
      // 内网任何人都能借服务账号建 MR。宿主在本机时不需要暴露;
      // 适配层跑在 Windows 侧、宿主在 WSL 里隔墙喊话时,配置里
      // 显式给 host(如 0.0.0.0),自担边界。
      const listenHost = this.config.host ?? "127.0.0.1";
      server.listen(listenPort, listenHost, () =>
        resolve((server.address() as { port: number }).port));
    });
  }
}

/** 可选字段的抽取:抠不到不报错(log 缺席是常态),抠到才带上。 */
function extractOptional(
  spec: Extract,
  stdout: string,
  parsed: () => unknown,
): unknown {
  try {
    return extract(spec, "", stdout, parsed);
  } catch {
    return undefined;
  }
}

// 直跑入口:npm run adapter -- --config /etc/mae-flow-cloud/adapter.json
if (process.argv[1]?.endsWith("platformAdapter.ts")) {
  const flagAt = process.argv.indexOf("--config");
  const configPath = flagAt >= 0 ? process.argv[flagAt + 1] : "";
  if (!configPath) {
    console.error("用法: tsx src/platformAdapter.ts --config <adapter.json>");
    process.exit(2);
  }
  const argValue = (name: string) => {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] ?? "" : "";
  };
  try {
    const adapter = new PlatformAdapter(configPath);
    if (process.argv.includes("--selftest")) {
      // 自检形态:打印形状与只读试跑结果后退出——输出誊回外网,
      // 等于外网看到了内网的真实返回(防分叉纪律的口子)。
      void adapter.selftest({
        repo: argValue("--repo"),
        source_branch: argValue("--source-branch"),
        target_branch: argValue("--target-branch"),
        sha: argValue("--sha"),
        mr: argValue("--mr"),
        mr_url: argValue("--mr-url"),
      }).then((report) => {
        console.log(report);
        process.exit(0);
      });
    } else {
      void adapter.serve().then((port) => {
        console.log(`[adapter] CodeHub 适配层就绪: http://127.0.0.1:${port}`);
        console.log("[adapter] 宿主侧: npm run serve -- --platform http://127.0.0.1:" + port);
      });
    }
  } catch (error) {
    console.error(`[adapter] 配置不可用,拒绝启动: ${String(error)}`);
    process.exit(2);
  }
}
