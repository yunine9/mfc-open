import {
  listProductVersions, matchProductVersion, type ProductVersion,
} from "../configurationCenter.ts";
import {
  isIssueInterventionTier, type IssueInterventionTier,
} from "../auth.ts";
/**
 * 问题流 HTTP 路由(/issues/*)。
 *
 * 与任务 API(/tasks/*)平行的独立命名空间:鉴权沿用会话 cookie,
 * 权限语义(查看模式):读(概要/时间线/材料/事件/SSE 事件流)登录
 * 即可,写(一切改变会话现场的动作)仅会话归属人——管理员也不写
 * ("管理员不处理问题单"同一角色边界)。SSE 事件尾随与任务侧同款
 * (300ms 轮询 + 字节偏移增量),只是终态判定换成问题域的状态集。
 * 免登录允许清单(ADR-0069):GET /issues/dts、GET /issues/dts/:ticket、
 * GET|PUT /issues/dts-bindings 匿名可达(函数开头的 anonymousAllowed),
 * 其余路由登录闸照旧。
 *
 *   GET  /issues                      → 我的会话列表
 *   POST /issues                      → 登记(201 摘要)
 *   GET  /issues/dts                  → DTS 名下问题单(拉单)
 *   GET  /issues/dts/:ticket          → 单张问题单详情(拉单页签展开用)
 *   PUT    /issues/dts-auto-claim-exclusions/:ticket → 标记这张单不自动
 *                                      接单(ADR-0070;登录闸后,不在
 *                                      免登录允许清单)
 *   DELETE /issues/dts-auto-claim-exclusions/:ticket → 取消排除,恢复
 *                                      自动接单(同上,登录闸后)
 *   GET  /issues/dts-file?path=…      → 描述内嵌图代理(后端带回二进制)
 *   GET  /issues/:id                  → 详情(状态 + 消息 + 问题卡)
 *   GET  /issues/:id/materials        → 材料清单(变更/日志/人工台账/推送记录)
 *   GET  /issues/:id/materials/diff   → 单文件 diff(?path=,对 HEAD)
 *                                      / 单仓切片(?repo=,无标记)
 *                                      / 聚合(缺省,带仓库分段标记)
 *   GET  /issues/:id/materials/logs/archive → 拉取日志整包下载(ZIP;
 *                                      空/缺 404;读,无终态闸)
 *   POST /issues/:id/logs/fetch     → 主动拉取日志意图递交(仅归属者;
 *                                      守卫+留痕+发送通知,平台不代拉)
 *   GET  /issues/:id/materials/events → 原始事件尾随(?limit=,现场页签)
 *   GET  /issues/:id/timeline         → 耗时与卡点(纯函数归纳,只读)
 *   GET  /issues/:id/documents        → 过程文档清单(分析报告+Agent 落
 *                                      的其他 .md)
 *   GET  /issues/:id/documents/read   → 读一份过程文档(?name=;缺失为
 *                                      200 {unavailable},不 404)
 *   GET  /issues/:id/documents/archive → 全部过程文档打包下载(ZIP)
 *   GET  /issues/:id/workspace-image → 会话工作区图片回显(?path=;
 *                                      只认工单/登记截图两种白名单
 *                                      形状,#376)
 *   GET  /issues/:id/analysis-versions → 分析报告版本清单(#262:检视
 *                                      提交时冻结的快照 + live 最新版,
 *                                      去重后命名初版/修订N)
 *   GET  /issues/:id/analysis-versions/read → 读一版内容(?name=版本名;
 *                                      白名单只认推导出的版本,缺失为
 *                                      200 {unavailable},不 404)
 *   GET  /issues/:id/reviews          → 检视面板(意见+锚点检测+回合标记)
 *   POST /issues/:id/reviews          → 记一条检视草稿(悬停圈注)
 *   POST /issues/:id/reviews/send     → 提交检视意见(递 AI 分诊,ADR-0035)
 *   DELETE /issues/:id/reviews/:rid   → 移除一条意见(软删留痕)
 *   GET  /issues/:id/export           → 现场记录导出(单文件 Markdown:
 *                                      事件流逐字 + 台账,复盘用)
 *   GET  /issues/:id/events           → SSE:事件流尾随
 *   POST /issues/:id/reply            → 续聊
 *   POST /issues/:id/decision         → 问题卡作答
 *   POST /issues/:id/repos            → 调整会话仓清单(#241;只校验+
 *                                      留痕+发送通知,清单由 Agent 经
 *                                      pull_repo/remove_repo 执行后变化)
 *   POST /issues/:id/environment      → 网管环境配置(env_needed 闸的
 *                                      作答口;decline:true=拒绝,票 93;
 *                                      environment_id=台账快照,#150)
 *   POST /issues/:id/interrupt        → 补充(运行中送达 AI)
 *   POST /issues/:id/takeover         → 人工接管(打断 AI,现场交由人工)
 *   POST /issues/:id/takeover/note    → 接管期人工操作记录(只记账不投喂)
 *   POST /issues/:id/takeover/resume  → 交还(AI 带着人工记录继续)
 *   POST /issues/:id/ticket           → 绑定单号
 *   POST /issues/:id/control          → 归档/取消
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IssueFlowService } from "./service.ts";
import { normalizeRepairMrUrl } from "../mrImport.ts";
import {
  DtsGatewayUnconfiguredError,
  toHttpError,
} from "./errors.ts";
import {
  BusinessModuleError,
} from "../businessModuleLibrary.ts";
import {
  DtsModuleBindingError,
  readDtsModuleBindings,
  setDtsModuleBinding,
} from "../dtsModuleBindings.ts";
import {
  DtsAutoClaimExclusionError,
  readDtsAutoClaimExclusions,
  setDtsAutoClaimExclusion,
} from "../dtsAutoClaimExclusions.ts";
import {
  bundleSessionLogs,
  IssueLogsArchiveTooLargeError,
  listMaterials,
  recentEvents,
  sessionWorkspaceDiffAll,
  sessionWorkspaceFileDiff,
  sessionWorkspaceRepoDiff,
} from "./materials.ts";
import {
  bundleSessionDocuments,
  IssueDocumentsArchiveTooLargeError,
  listSessionDocuments,
  readSessionDocument,
} from "./documents.ts";
import {
  listAnalysisVersions,
  readAnalysisVersion,
} from "./analysisVersions.ts";
import type { DtsGateway } from "./gateways.ts";
import { DTS_FILE_ORIGIN } from "./gateways.ts";
import {
  ISSUE_CANCEL_REASON_UNKNOWN_ERROR,
  ISSUE_CANCEL_REASONS,
  isTerminal,
  type IssueCancelReason,
  type IssueEnvType,
} from "./state.ts";
import {
  ISSUE_IMAGE_MAX_BYTES,
  readStagedImage,
  stageIssueImage,
} from "./issueImages.ts";
import { stageIssueAttachmentStream } from "./issueAttachments.ts";
import { readWorkspaceImage } from "./workspaceImages.ts";
import { listBusinessModules } from "../businessModuleLibrary.ts";

export interface IssueViewer {
  username: string;
  role?: string;
}

export interface IssueRouteOptions {
  managedMr?: (url: string) => string | undefined;
  issueFlow?: IssueFlowService;
  /** DTS 网关直连(拉单/单据详情/内嵌图代理;收窄票 #7:服务不再
   * 转手)。缺席时按原透传层的同一句 fail-loud 打回。 */
  dts?: DtsGateway;
  viewer?: IssueViewer;
  /** 会话鉴权是否启用(测试直连形态没有 auth)。 */
  authEnabled: boolean;
  /** 服务端运行日志(口径与问题服务一致:路由层的动作留痕)。 */
  log?: (message: string) => void;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("请求体超过 2MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(new Error(`JSON 解析失败: ${String(error)}`));
      }
    });
    request.on("error", reject);
  });
}

/** 读原始二进制请求体(图片上传用),上限可配。 */
function readRawBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MiB`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function streamIssueEvents(
  issueFlow: IssueFlowService,
  id: string,
  response: ServerResponse,
): void {
  streamIssueJsonl(issueFlow, id, response,
    () => join(issueFlow.session(id).root, "events.jsonl"));
}

/** 问题域 JSONL 尾随 SSE(主会话事件流与预热直播⑤共用):路径按拍
 *  解析——预热文件启动前不存在,先只发心跳,出现后从头重放(断线重连
 *  天然幂等,客户端按事件锚去重)。终态即收流。 */
function streamIssueJsonl(
  issueFlow: IssueFlowService,
  id: string,
  response: ServerResponse,
  pathOf: () => string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  let offset = 0;
  let carry = Buffer.alloc(0);
  let closed = false;
  response.on("close", () => (closed = true));
  const push = () => {
    if (closed) return;
    const path = pathOf();
    if (existsSync(path) && statSync(path).size > offset) {
      const fd = openSync(path, "r");
      let read = 0;
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(statSync(path).size - offset);
        read = readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      offset += read;
      carry = Buffer.concat([carry, chunk.subarray(0, read)]);
      const cut = carry.lastIndexOf(0x0a);
      if (cut >= 0) {
        const complete = carry.subarray(0, cut).toString("utf-8");
        carry = Buffer.from(carry.subarray(cut + 1));
        for (const line of complete.split("\n")) {
          if (line.trim()) response.write(`data: ${line}\n\n`);
        }
      }
    }
    const issue = issueFlow.get(id);
    if (issue && isTerminal(issue.status)) {
      response.end();
      return;
    }
    setTimeout(push, 300);
  };
  push();
}

/** DTS 网关直连的缺席守卫:缺席即"未配置",是环境档(409),不是
 * 上游故障——按 #9 的口径抛 DtsGatewayUnconfiguredError。 */
function requireDts(dts: DtsGateway | undefined): DtsGateway {
  if (!dts) {
    throw new DtsGatewayUnconfiguredError(
      "DTS 网关未配置(部署需 --dts-mcp-url 与 token)");
  }
  return dts;
}

/** 分支匹配的配置读取(ADR-0038):配置文件损坏时按"零配置"处理——
 * 列表分支列全体按未配置呈现,发起全部拒绝,不为坏配置炸掉拉单页。
 * 自动接单扫描(ADR-0061)同款消费。 */
export function configuredVersionRows(dataDir: string) {
  try {
    return listProductVersions(dataDir);
  } catch {
    return [];
  }
}

/** 给单据补分支(列表与详情同源):按分支匹配口径(单据版本包含配置
 * 版本,多命中取最长)解析;未命中不加字段,前端按「未配置分支」呈现。 */
function withDtsBranch<T extends { version?: string }>(
  rows: ProductVersion[], ticket: T,
): T {
  const row = matchProductVersion(rows, ticket.version);
  return row ? { ...ticket, branch: row.branch } : ticket;
}

/** DTS 模块强匹配的模块库索引(ADR-0056):在架业务模块按「名称
 * trim 后」建 name→ids 映射;重名收敛到同键多 id,查询端多命中即
 * 未匹配。每次请求建一次,列表与详情共用。自动接单扫描(ADR-0061)
 * 每拍建一次,同款消费。 */
export function dtsFeatureModuleIndex(dataDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  try {
    for (const mod of listBusinessModules(dataDir).modules) {
      if (mod.status !== "active") continue;
      const name = mod.name.trim();
      if (!name) continue;
      index.set(name, [...(index.get(name) ?? []), mod.id]);
    }
  } catch {
    // 模块库不可读按零配置处理(与分支配置同一姿态):全体未匹配,
    // 发起走必填,不为坏数据炸拉单页。
  }
  return index;
}

/** 特性名→模块 ID 的强匹配单点(ADR-0056):完全相等且唯一命中才
 * 返回,未命中/多命中 undefined。列表带出与自动接单(ADR-0061)
 * 共用这一个判定,永不漂移。 */
export function matchDtsModule(
  index: Map<string, string[]>, featureName: string | undefined,
): string | undefined {
  const feature = featureName?.trim();
  const hits = feature ? index.get(feature) : undefined;
  return hits?.length === 1 ? hits[0] : undefined;
}

/** 给单据补模块(列表与详情同源,ADR-0056):特性名 trim 后与模块
 *  名称完全相等且唯一命中才带出;未命中/多命中不加字段,前端按
 *  「未匹配」呈现走必填。 */
function withDtsModule<T extends { featureName?: string }>(
  index: Map<string, string[]>, ticket: T,
): T {
  const moduleId = matchDtsModule(index, ticket.featureName);
  return moduleId ? { ...ticket, module_id: moduleId } : ticket;
}

/** 给单据补自动接单排除标记(ADR-0070):被标记排除的单带
 *  auto_claim_excluded:true;缺省允许不加字段——前端两态下拉的
 *  缺省值即「允许」。列表是前端渲染与扫描闸共读的同一份事实。 */
function withAutoClaimExclusion<T extends { ticket: string }>(
  exclusions: ReturnType<typeof readDtsAutoClaimExclusions>, row: T,
): T {
  return exclusions[row.ticket]
    ? { ...row, auto_claim_excluded: true } : row;
}

/** 处理 /issues/* 请求;返回 false 表示与问题域无关。 */
export async function handleIssueRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  routeOptions: IssueRouteOptions,
): Promise<boolean> {
  const repairTool = parts[0] === "pipeline-repairs";
  if (parts[0] !== "issues" && !repairTool) return false;
  const { issueFlow } = routeOptions;
  if (!issueFlow) {
    json(response, 404, { error: "问题流服务未启用" });
    return true;
  }
  if (repairTool !== (issueFlow.options?.purpose === "pipeline_repair")) {
    json(response, 404, { error: "未知接口" }); return true;
  }
  if (repairTool && ((parts[1] && !parts[1].startsWith("mr-repair-"))
    || ["ticket", "ticket-template", "environment", "repos", "logs", "code-origin"].includes(parts[2] ?? ""))) {
    json(response, 404, { error: "流水线修复工具不提供问题交付接口" }); return true;
  }
  const viewer = routeOptions.viewer;
  const method = request.method ?? "GET";
  // 免登录允许清单(ADR-0069,#566):拉单/单据详情/单号→模块绑定读写
  // 这一撮与人无关的参考数据接口匿名可达,支撑无头本地客户端零凭据
  // 集成。精确到 method+path,清单之外(含新增路由)默认仍在闸后。
  const anonymousAllowed =
    (method === "GET" && parts[1] === "dts" && parts.length === 2)
    || (method === "GET" && parts[1] === "dts" && parts.length === 3)
    || (method === "GET" && parts[1] === "dts-bindings" && parts.length === 2)
    || (method === "PUT" && parts[1] === "dts-bindings" && parts.length === 3);
  if (routeOptions.authEnabled && !viewer && !anonymousAllowed) {
    json(response, 401, { error: "请先登录" });
    return true;
  }
  const done = (status: number, body: unknown): true => {
    json(response, status, body);
    return true;
  };
  /** 归属(写闸):写操作的唯一拒绝口——每条写路由自带这道仅归属人
   * 校验,管理员也不写(问题处理是开发者的活,与"管理员不发起任务"
   * 同一角色边界)。读没有闸:查看模式(spec: issue-session-view-mode)
   * 对登录用户全开放,不再有"本人或管理员"的整体闸盖住读写。 */
  const own = (account: string): boolean =>
    viewer ? viewer.username === account : true;

  try {
    if (method === "GET" && parts.length === 1) {
      // ?scope=all:团队看板视角看所有人的问题会话;缺省只看本人——
      // 「我的问题」单一列表(ADR-0031,2026-09-16 修订):归属**或**
      // 登记人是自己,登记给他人要跟踪的与名下要推进的同列。读没有闸:
      // 查看模式(spec: issue-session-view-mode)对登录用户全开放。
      const scopeAll = new URL(request.url ?? "", "http://x")
        .searchParams.get("scope") === "all";
      const mine = issueFlow.list(
        viewer && viewer.role !== "admin" && !scopeAll
          ? viewer.username : undefined);
      return done(200, { issues: mine });
    }

    if (method === "POST" && parts.length === 1 && repairTool) {
      if (viewer?.role === "admin") return done(403, { error: "请使用开发者账号接入 MR" });
      const body = await readBody(request);
      const url = normalizeRepairMrUrl(body.mr_url);
      const managed = routeOptions.managedMr?.(url);
      if (managed) return done(409, { error: managed });
      return done(201, await issueFlow.importMr(url, viewer?.username ?? "local"));
    }
    if (method === "POST" && parts.length === 2 && parts[1] === "from-mr") return done(404, { error: "请使用流水线修复工具" });
    if (method === "POST" && parts.length === 1) {
      if (viewer?.role === "admin") {
        return done(403, {
          error: "管理员不发起问题会话——用开发者账号登录处理问题",
        });
      }
      const body = await readBody(request);
      const source = body.source === "dts" ? "dts" as const : "manual" as const;
      // 登记页指派(ADR-0031):手工登记必填责任人——登记完成即移交,
      // 没有责任人就没有人接;DTS 页签发起不带(自助流程原样,归属=
      // 发起人)。登录用户恒以登录态为登记人,客户端改写不收。
      const assignee = body.assignee ? String(body.assignee) : undefined;
      if (source === "manual" && !assignee) {
        return done(409, {
          error: "手工登记必须指名责任人:登记完成后由责任人推进,"
            + "请回登记页选择责任人后再登记",
        });
      }
      const ticket = body.ticket ? String(body.ticket) : undefined;
      let productVersion = String(body.product_version ?? "").trim();
      // 版本必填(2026-09-18):手工登记必须指明问题发生的版本——版本是
      // 复现与修复的基线。与上方手工必填责任人同位同尺;DTS 来源不带,
      // 版本由单据按配置中心映射推导(下方自动补)。
      if (source === "manual" && !productVersion) {
        return done(409, {
          error: "手工登记必须选择产品版本:版本是复现与修复的基线,"
            + "请回登记页选择后再发起",
        });
      }
      // 模块发起闸(ADR-0056):DTS 来源必带模块——列上带出或人工
      // 改选,发起前已定局,服务端不再补猜;都不在即拒,与分支闸同款。
      if (source === "dts" && !body.module_id) {
        return done(400, {
          error: "单据未匹配到业务模块:请到 DTS 列表「所属模块」列"
            + "选择模块后再发起",
        });
      }
      // 会话级介入档位(ADR-0057):DTS 列表发起前按单选定,随创建
      // 请求定格——发起后不可改,终身不随全局改档;缺席=跟随全局。
      let interventionTier: IssueInterventionTier | undefined;
      if (body.intervention_tier !== undefined
          && body.intervention_tier !== null
          && body.intervention_tier !== "") {
        const tier = String(body.intervention_tier);
        if (!isIssueInterventionTier(tier)) {
          return done(400, {
            error: "介入档位不合法(只支持 全自动/优先报告/优先对齐 三档)",
          });
        }
        interventionTier = tier;
      }
      let dtsVersion: string | undefined;
      if (!productVersion && source === "dts" && ticket && routeOptions.dts) {
        try {
          // 详情只为分支匹配取版本号(ADR-0038);模块已在上面闸上定局。
          dtsVersion = (await routeOptions.dts.detail(ticket)).version;
        } catch {
          // 版本读不到由下方分支闸如实报错,这里不另造错误。
        }
      }
      // 分支匹配(ADR-0038):DTS 发起没有显式选版本时,按单据版本
      // 包含匹配配置中心带出分支;未命中即拒——分支是逐单强制项,
      // "未匹配沿用原基线"的静默兜底已随列表选择框退役。读不到版本
      // (网关缺席/详情失败/单据无版本)同尺拒绝:没有分支就不发车。
      if (!productVersion && source === "dts") {
        const row = matchProductVersion(
          configuredVersionRows(issueFlow.dataDir), dtsVersion);
        if (!row) {
          return done(400, {
            error: `单据版本未配置分支:${dtsVersion
              ? `版本「${dtsVersion}」没有匹配到配置中心的版本与分支映射`
              : "未能读取单据版本"}。请到配置中心「版本与分支」维护后再发起`,
          });
        }
        productVersion = row.version;
      }
      // 环境段(#150,ADR-0020 快照语义):environment_id 在场即从台账
      // 快照——前端永远没有密码,值由服务端解密取用;与手填字段互斥,
      // 同给 400 打回。页面凭据不入台账,登记快照仍随手填带上。
      let environmentInput: Record<string, unknown> | undefined;
      if (body.environment) {
        if (body.environment.environment_id !== undefined
            && body.environment.environment_id !== null) {
          if (body.environment.hosts !== undefined
              || body.environment.backend_password !== undefined
              || body.environment.env_type !== undefined
              || body.environment.port !== undefined) {
            return done(400, {
              error: "台账快照与手工填写互斥:选了环境管理里的环境,"
                + "就不要再填地址、端口、形态或密码",
            });
          }
          environmentInput = {
            environmentId: String(body.environment.environment_id),
          };
        } else {
          environmentInput = {
            name: body.environment.name === undefined
              ? undefined : String(body.environment.name),
            hosts: Array.isArray(body.environment.hosts)
              ? body.environment.hosts.map(String) : [],
            ...(body.environment.port !== undefined
              ? { port: Number(body.environment.port) } : {}),
            ...(body.environment.env_type !== undefined
              ? { envType: String(body.environment.env_type) as IssueEnvType } : {}),
            backendPassword: String(body.environment.backend_password ?? ""),
          };
        }
      }
      const created = issueFlow.create({
        // 归属=责任人(ADR-0031);登录在场时登记人恒取登录态,
        // body.account 只留给无登录态的测试世界。
        account: String(viewer?.username ?? body.account ?? ""),
        ...(assignee ? { assignee } : {}),
        ...(viewer?.username ? { reporter: viewer.username } : {}),
        title: String(body.title ?? ""),
        description: body.description === undefined
          ? undefined : String(body.description),
        // 附加信息(原发起备注,DTS 列表随单填写,#502 更名):原样进
        // 登记元信息,开场词要求 AI 优先读;没填不带,不造空串。
        ...(body.remark ? { remark: String(body.remark) } : {}),
        source,
        ...(ticket ? { ticket } : {}),
        ...(body.repo_url ? { repoUrl: String(body.repo_url) } : {}),
        ...(Array.isArray(body.repo_urls)
          ? { repoUrls: body.repo_urls.map(String) } : {}),
        ...(body.baseline ? { baseline: String(body.baseline) } : {}),
        ...(productVersion ? { productVersion } : {}),
        ...(body.module ? { module: String(body.module) } : {}),
        // 模块发起前已定局(ADR-0056):DTS 恒带,登记页/无单必选;
        // create 校验在架与仓绑定,通过即开场可用。
        ...(body.module_id ? { moduleId: String(body.module_id) } : {}),
        // 会话级介入档位(ADR-0057):发起前选了才带,缺席=跟随全局。
        ...(interventionTier ? { interventionTier } : {}),
        ...(environmentInput ? { environment: environmentInput } : {}),
      });
      return done(201, created);
    }

    if (method === "GET" && parts[1] === "dts" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      // 直连 DTS 网关(收窄票 #7):服务不再转手拉单。
      // 协助处理(2026-09-17):?owner= 指名看谁名下的单,缺省仍是本人。
      // 读侧换视角不发所有权——发起后的会话归属仍=登录发起人;会话
      // 列表读本就全员开放(?scope=all),这里同尺不另设闸。
      const owner = new URL(request.url ?? "", "http://x")
        .searchParams.get("owner")?.trim() ?? "";
      // 匿名拉单(ADR-0069)owner 必填:鉴权开着的部署里没有登录态就
      // 没有缺省视角,显式指名,不静默查空。无鉴权本地单人形态
      // (authEnabled:false)维持原缺省——那不是匿名客户端。
      if (!owner && !viewer && routeOptions.authEnabled) {
        return done(400, {
          error: "缺少 owner:匿名拉单必须在 ?owner= 显式指名查看谁名下的问题单",
        });
      }
      // 分支列数据源(ADR-0038):匹配在后端单点,列表逐单带出——
      // 前端纯展示,列显示与发起解析永不漂移。模块带出同一纪律
      // (ADR-0056):特性名与模块名强匹配,服务端单点逐单带出。自动
      // 接单排除标记(ADR-0070)照此富集:排除表后端单点逐单带出。
      const versionRows = configuredVersionRows(issueFlow.dataDir);
      const moduleIndex = dtsFeatureModuleIndex(issueFlow.dataDir);
      const exclusions = readDtsAutoClaimExclusions(issueFlow.dataDir);
      const tickets = (await requireDts(routeOptions.dts)
        .listByOwner(owner || String(viewer?.username ?? "")))
        .map(ticket => withAutoClaimExclusion(exclusions,
          withDtsModule(moduleIndex, withDtsBranch(versionRows, ticket))));
      return done(200, { tickets, mock: routeOptions.dts?.mock === true });
    }

    // 单张问题单详情(页签展开用):登录即可查本人名下任意单。
    if (method === "GET" && parts[1] === "dts" && parts.length === 3) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      const ticket = decodeURIComponent(parts[2]);
      if (!ticket) return done(400, { error: "缺少问题单号" });
      // 详情与列表同源补分支与模块(ADR-0038/ADR-0056):远程查单
      // 入列的单子,两列不因绕过列表而缺席。
      const detail = await requireDts(routeOptions.dts).detail(ticket);
      return done(200, withDtsModule(dtsFeatureModuleIndex(issueFlow.dataDir),
        withDtsBranch(configuredVersionRows(issueFlow.dataDir), detail)));
    }

    // 单号→模块人工改选(spec #57 起;ADR-0056 后只存人工改选):
    // 团队共享事实,登录即可读写——
    // 管理员也在内(维护数据不算"处理问题单",与上方按人拉单的 403
    // 边界不同)。
    if (method === "GET" && parts[1] === "dts-bindings"
        && parts.length === 2) {
      return done(200, {
        bindings: readDtsModuleBindings(issueFlow.dataDir),
      });
    }
    if (method === "PUT" && parts[1] === "dts-bindings"
        && parts.length === 3) {
      const ticket = decodeURIComponent(parts[2]);
      const body = await readBody(request);
      // 空串/缺席 = 解绑(幂等);有值 = 绑定(校验模块存在且 active)。
      const moduleId = body.module_id === undefined
        || body.module_id === null
        || String(body.module_id).trim() === ""
        ? null : String(body.module_id).trim();
      // 操作人(ADR-0069):登录态在场恒取登录身份,客户端改写不收
      // (与 POST /issues 登记人同哲学);匿名改选由请求体 account
      // 自报工号(内网信任调用方),缺席打回。
      const updatedBy = viewer?.username
        ?? String(body.account ?? "").trim();
      if (!updatedBy) {
        return done(400, {
          error: "缺少操作人账号:匿名改选必须在请求体携带 account(工号)",
        });
      }
      try {
        const { previous } = setDtsModuleBinding(
          issueFlow.dataDir, ticket, moduleId, updatedBy);
        return done(200, {
          ticket,
          ...(moduleId ? { module_id: moduleId } : { cleared: true }),
          ...(previous ? { previous } : {}),
        });
      } catch (error) {
        // 绑定的域校验(单号格式/模块不存在或已归档)是人话打回;
        // 其余照旧走尾部单点映射。
        if (error instanceof DtsModuleBindingError
            || error instanceof BusinessModuleError) {
          return done(409, { error: error.message });
        }
        throw error;
      }
    }

    // 自动接单单级排除(ADR-0070):PUT 落条目=排除、DELETE 删条目=
    // 恢复允许,幂等。改写有操作人,不进免登录允许清单(ADR-0069
    // 结构性默认:新增接口默认在闸后)——操作人恒取登录身份,客户端
    // 改写不收;body.account 只留给无登录态的本地单人形态(与
    // PUT dts-bindings 同哲学)。能看见这单就能改:团队共享事实,
    // 人人可写,与单号→模块映射同尺。
    if ((method === "PUT" || method === "DELETE")
        && parts[1] === "dts-auto-claim-exclusions" && parts.length === 3) {
      const ticket = decodeURIComponent(parts[2]);
      const body = await readBody(request);
      const updatedBy = viewer?.username
        ?? String(body.account ?? "").trim();
      if (!updatedBy) {
        return done(400, {
          error: "缺少操作人账号:请先登录,或在请求体携带 account(工号)",
        });
      }
      try {
        const { entry } = setDtsAutoClaimExclusion(
          issueFlow.dataDir, ticket, method === "PUT", updatedBy);
        return done(200, {
          ticket,
          excluded: method === "PUT",
          ...(entry ? { updated_by: entry.updated_by, updated_at: entry.updated_at } : {}),
        });
      } catch (error) {
        // 单号格式校验(与问题流服务端同一把尺)是人话打回 409。
        if (error instanceof DtsAutoClaimExclusionError) {
          return done(409, { error: error.message });
        }
        throw error;
      }
    }

    // DTS 文件代理(GET /issues/dts-file?path=/v1/nfs/...):描述内嵌
    // 图的浏览器直连跨域且无 cookie,由后端带同源 token 回取二进制。
    // path 只收站内绝对路径(/开头),不成为任意外链跳板。
    if (method === "GET" && parts[1] === "dts-file" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      const path = String(
        new URL(request.url ?? "", "http://x").searchParams.get("path") ?? "");
      if (!path || !path.startsWith("/")) {
        return done(400, { error: "缺少合法 path 参数(须为站内绝对路径)" });
      }
      // 直连 DTS 网关代理回取(收窄票 #7)。失败不再本地包 502(#9):
      // 网关查询失败 502、未配置 409,与拉单/详情/关联转正同走尾部
      // toHttpError 单点出码。
      const file = await requireDts(routeOptions.dts).proxyFile(path);
      response.writeHead(200, {
        "content-type": file.contentType,
        "cache-control": "public, max-age=86400",
      });
      response.end(file.data);
      return true;
    }

    // 登记现象描述内嵌截图上传(POST /issues/issue-image,raw binary):
    // 粘贴/拖拽的图片落 staging(content-addressed),返回工作区相对路径
    // 引用(issue-images/<hash>.<ext>)——前端把它插入 description。
    // 管理员不发起问题会话,同 POST /issues 的角色边界。
    if (parts[1] === "issue-image" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不发起问题会话" });
      }
      const dataDir = routeOptions.issueFlow?.dataDir ?? "";
      if (!dataDir) return done(500, { error: "数据目录未配置" });
      if (method === "POST") {
        const data = await readRawBody(request, ISSUE_IMAGE_MAX_BYTES);
        const contentType = String(request.headers["content-type"] ?? "");
        try {
          const result = stageIssueImage({ data, contentType, dataDir });
          return done(201, { path: result.path, bytes: result.bytes });
        } catch (error) {
          return done(400, {
            error: String(error instanceof Error ? error.message : error),
          });
        }
      }
      if (method === "GET") {
        const path = String(
          new URL(request.url ?? "", "http://x").searchParams.get("path") ?? "");
        if (!path) return done(400, { error: "缺少 path 参数" });
        const image = readStagedImage({ path, dataDir });
        if (!image) return done(404, { error: "图片不存在或路径非法" });
        response.writeHead(200, {
          "content-type": image.mime_type,
          "content-length": image.data.length,
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=86400",
        });
        response.end(image.data);
        return true;
      }
    }

    // 登记附件上传(POST /issues/issue-attachment?name=<原始文件名>,
    // raw binary 流式):日志等文件边写边算哈希落 staging,超上限中途
    // 掐断(不为大包付整包内存),返回工作区相对路径引用
    // (attachments/<hash>.<ext>)——前端把它以纯文本插入 description。
    // 无回显路由:附件是给 AI 读的分析材料,人不预览。
    // 管理员不发起问题会话,同 POST /issues 的角色边界。
    if (parts[1] === "issue-attachment" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不发起问题会话" });
      }
      const dataDir = routeOptions.issueFlow?.dataDir ?? "";
      if (!dataDir) return done(500, { error: "数据目录未配置" });
      if (method === "POST") {
        const filename = new URL(request.url ?? "", "http://x")
          .searchParams.get("name") ?? undefined;
        try {
          const result = await stageIssueAttachmentStream(request,
            { dataDir, filename });
          return done(201, { path: result.path, bytes: result.bytes });
        } catch (error) {
          return done(400, {
            error: String(error instanceof Error ? error.message : error),
          });
        }
      }
    }

    // 外部图片代理转存(POST /issues/proxy-image,#276):粘贴的外部
    // <img src="https://..."> 图前端拿不到字节(跨域带不上对方站的
    // Cookie),由后端下载落 staging,返回 issue-images/<hash>.<ext>
    // 引用——前端用它替换原 src。data: URL 的字节就在 src 里,前端本地
    // 转 Blob 走既有上传,不进这里;file:/// 在前端拦截,路由层仍以
    // 协议白名单兜一道。DTS 域的图(单据描述内嵌图被整体复制的典型
    // 形态)裸 fetch 无凭据必 401,改走 DtsGateway.proxyFile 同源凭据
    // 回取(#276 环境实测)。管理员不发起问题会话,同 POST /issues 的
    // 角色边界。
    if (method === "POST" && parts[1] === "proxy-image" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不发起问题会话" });
      }
      const dataDir = routeOptions.issueFlow?.dataDir ?? "";
      if (!dataDir) return done(500, { error: "数据目录未配置" });
      const body = await readBody(request);
      const url = String(body.url ?? "").trim();
      if (!url) return done(400, { error: "缺少 url 参数" });
      if (!/^https?:\/\//i.test(url)) {
        return done(400, { error: "仅支持 http/https 图片 URL" });
      }
      const target = new URL(url);
      const viaDts = target.origin === DTS_FILE_ORIGIN;
      // DTS 域必须有网关才谈得上回取;未配置按拉单同款 409 出码,
      // 不落进下面的兜底 catch 假装成上游故障。
      if (viaDts && !routeOptions.dts) {
        return done(409, { error: "DTS 网关未配置,无法回取 DTS 图" });
      }
      try {
        let data: Buffer;
        let contentType: string;
        if (viaDts) {
          // DTS 域:按单据同源凭据回取,与 GET /issues/dts-file 同一条
          // 认证通路;未配置网关按拉单同款 409 出码,不假装能裸拉。
          const file = await requireDts(routeOptions.dts)
            .proxyFile(target.pathname + target.search);
          data = file.data;
          contentType = file.contentType;
          if (data.length > ISSUE_IMAGE_MAX_BYTES) {
            return done(413, {
              error: `图片超过 ${
                Math.round(ISSUE_IMAGE_MAX_BYTES / 1024 / 1024)}MB 上限`,
            });
          }
        } else {
          const upstream = await fetch(url, {
            signal: AbortSignal.timeout(15_000),
            redirect: "follow",
          });
          if (!upstream.ok) {
            return done(502, { error: `下载失败: HTTP ${upstream.status}` });
          }
          // 非图片 content-type 拒收(需认证的上游典型回 HTML 登录页):
          // 落一张渲染不出的图不如当场失败,前端按失败丢图保文字。
          contentType = upstream.headers.get("content-type") ?? "";
          if (!contentType.startsWith("image/")) {
            return done(415, {
              error: `URL 返回的不是图片(${contentType || "无 content-type"})`,
            });
          }
          // 边读边限量:上游大小未知,不能整包 arrayBuffer 进内存。
          const chunks: Buffer[] = [];
          let size = 0;
          const reader = upstream.body?.getReader();
          if (reader) {
            for (;;) {
              const { done: streamed, value } = await reader.read();
              if (streamed) break;
              size += value.byteLength;
              if (size > ISSUE_IMAGE_MAX_BYTES) {
                void reader.cancel();
                return done(413, {
                  error: `图片超过 ${
                    Math.round(ISSUE_IMAGE_MAX_BYTES / 1024 / 1024)}MB 上限`,
                });
              }
              chunks.push(Buffer.from(value));
            }
          }
          data = Buffer.concat(chunks);
        }
        const result = stageIssueImage({ data, contentType, dataDir });
        return done(201, { path: result.path, bytes: result.bytes });
      } catch (error) {
        return done(502, {
          error: `代理下载失败: ${
            String(error instanceof Error ? error.message : error)}`,
        });
      }
    }

    // 一次率二轴(团队问题页签统计块):完成交付会话的聚合,
    // 口径见 CONTEXT「一次修复成功率」「一次定位成功率」词条;读开放
    // 与列表同权(查看模式)。字面路由必须住在 :id 捕获之前,
    // 不然 "stats" 会被当会话 id。
    if (method === "GET" && parts[1] === "stats" && parts.length === 2) {
      return done(200, issueFlow.onceRates());
    }

    // 90%AI生成达标率(ADR-0044/0045):终态伴生快照(code-origin.json)
    // 的读侧聚合,分母三态排除口径见 service.onceGeneratedStats。字面
    // 路由同样必须住在 :id 捕获之前;读开放与 stats 同权(查看模式)。
    if (method === "GET" && parts[1] === "once-generated"
      && parts.length === 2) {
      // days=时间过滤(按结论时刻近 N 天;缺省=全部)。
      const query = new URL(request.url ?? "", "http://x").searchParams;
      const days = Number(query.get("days") ?? "");
      return done(200, issueFlow.onceGeneratedStats(
        Number.isFinite(days) && days > 0 ? days : undefined, { from: query.get("completed_from") ?? undefined, before: query.get("completed_before") ?? undefined }));
    }

    // 登记问题统计(ADR-0048):无单会话的结论漏斗与研究质量,只数
    // 结论已出的会话。days=时间过滤(按结论时刻近 N 天;缺省=全部);
    // 读开放与 stats 同权(查看模式)。
    if (method === "GET" && parts[1] === "registration-stats"
      && parts.length === 2) {
      const query = new URL(request.url ?? "", "http://x").searchParams;
      const days = Number(query.get("days") ?? "");
      return done(200, issueFlow.registrationStats(
        Number.isFinite(days) && days > 0 ? days : undefined, { from: query.get("completed_from") ?? undefined, before: query.get("completed_before") ?? undefined }));
    }

    // 单会话首次生成明细(伴生快照原样):会话详情下钻的证据面。
    // 伴生缺席(未归档/未算完/早于起算日期)如实 404,不猜不补。
    if (method === "GET" && parts[1] && parts[2] === "code-origin"
      && parts.length === 3) {
      const snapshot = issueFlow.codeOriginDetail(
        decodeURIComponent(parts[1]));
      return snapshot
        ? done(200, snapshot)
        : done(404, {
          error: "该会话暂无首次生成统计(未归档、未算完或早于起算日期)",
        });
    }

    const id = parts[1];
    if (!id) return done(404, { error: "未知问题接口" });
    // 查看模式:这里不再有整体归属闸——GET(概要/时间线/材料/事件/
    // SSE 事件流)登录即可;非 GET 的拒绝完全靠每条写路由自己的 own()
    // 闸(403 文案指明动作与归属限制)。brief 只供各写闸取归属账号。
    const brief = issueFlow.list().find((item) => item.id === id);

    if (method === "GET" && parts.length === 2) {
      return done(200, issueFlow.get(id));
    }

    // ---- 会话材料(交付材料页签):路由直连 materials.ts,服务不再
    // 转手(收窄票 #7);issueFlow.session 只负责"哪个会话、现场在哪"。
    // 读:登录即可(查看模式);人工修改写口已随 ADR-0028 整链退役,
    // 本组路由只读。路径防穿越在 materials 层双保险。fail-open 语义:
    // 读类故障以 400 带人话返回,页面给空态,不拖垮会话。
    if (parts[2] === "materials" && parts.length === 3) {
      const session = issueFlow.session(id);
      return done(200, listMaterials(session.state, session.root));
    }
    if (parts[2] === "materials" && parts.length === 4 && method === "GET") {
      const query = new URL(request.url ?? "/", "http://x").searchParams;
      // 会话定位在 try 外(#9):未知会话按 404 出码,不被读类 fail-open
      // 的 400 吞掉;材料读本身失败才回 400 带人话,页面给空态。
      const session = issueFlow.session(id);
      try {
        if (parts[3] === "diff") {
          // 带 path = 单文件;带 repo = 单仓切片(#32,服务端只回该仓,
          // 前端逐仓审阅不再解析分段标记);都不带 = 聚合 diff(带
          // 「===== 仓库 =====」标记,合并视图照旧)。
          const repo = query.get("repo");
          const path = query.get("path");
          return done(200, {
            diff: repo
              ? sessionWorkspaceRepoDiff(session.state, session.root, repo)
              : path
                ? sessionWorkspaceFileDiff(session.state, session.root, path)
                : sessionWorkspaceDiffAll(session.state, session.root),
          });
        }
        if (parts[3] === "events") {
          const raw = Number(query.get("limit") ?? 200);
          const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 200;
          return done(200, { events: recentEvents(session.root, limit) });
        }
      } catch (reason) {
        return done(400, {
          error: String(reason instanceof Error ? reason.message : reason),
        });
      }
    }
    // 拉取日志整包下载(ADR-0026):日志的人读面收敛为 zip,在线树/
    // 查看器/解压随页签退役。读操作(查看模式可下),无终态闸——与
    // 导出现场记录/文档打包同口径;空/缺 404(按钮本就不渲染,防
    // API 直调拿到空包),超限 413 带人话。
    if (method === "GET" && parts[2] === "materials"
        && parts[3] === "logs" && parts[4] === "archive"
        && parts.length === 5) {
      const session = issueFlow.session(id);
      let archive;
      try {
        archive = bundleSessionLogs(session.root);
      } catch (reason) {
        if (reason instanceof IssueLogsArchiveTooLargeError) {
          return done(413, { error: reason.message });
        }
        throw reason;
      }
      if (!archive) return done(404, { error: "还没有拉取过日志" });
      const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
      const filename = `${id}-拉取日志-${day}.zip`;
      const filenameAscii = `${safeId}-fetched-logs-${day}.zip`;
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.data.length),
        "content-disposition": `attachment; filename="${filenameAscii}"`
          + `; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      });
      response.end(archive.data);
      return true;
    }
    // 耗时与卡点(只读):消息账 + 转移账归纳成"时间去哪了、卡在谁身上"。
    // 归纳是纯函数(sessionView.ts),路由只负责门禁与投影——口径同
    // 需求侧 /tasks/:id/timeline:能看会话就能看它经历了什么。
    if (method === "GET" && parts[2] === "timeline" && parts.length === 3) {
      return done(200, issueFlow.timeline(id));
    }

    // 过程文档(只读旁路,数据面在 documents.ts):清单 + 单份读取。
    // 读取缺失为 200 {unavailable}——"还没生成"不是"没有这个接口",
    // 前端据此出空态而不是报错。
    if (method === "GET" && parts[2] === "documents" && parts.length === 3) {
      const session = issueFlow.session(id);
      return done(200, { documents: listSessionDocuments(session.root) });
    }
    if (method === "GET" && parts[2] === "documents"
        && parts[3] === "read" && parts.length === 4) {
      const session = issueFlow.session(id);
      const name = String(
        new URL(request.url ?? "", "http://x").searchParams.get("name") ?? "");
      const read = readSessionDocument(session.root, name);
      if (!read) return done(200, { unavailable: "文档不存在" });
      return done(200, {
        name: read.meta.name,
        label: read.meta.label,
        content: read.content,
        ...(read.truncated ? { truncated: true } : {}),
      });
    }
    if (method === "GET" && parts[2] === "documents"
        && parts[3] === "archive" && parts.length === 4) {
      const session = issueFlow.session(id);
      let archive;
      try {
        archive = bundleSessionDocuments(session.root);
      } catch (reason) {
        if (reason instanceof IssueDocumentsArchiveTooLargeError) {
          return done(413, { error: reason.message });
        }
        throw reason;
      }
      if (!archive) return done(409, { error: "暂无可打包的过程文档" });
      const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
      const filename = `${id}-过程文档-${day}.zip`;
      const filenameAscii = `${safeId}-process-documents-${day}.zip`;
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.data.length),
        "content-disposition": `attachment; filename="${filenameAscii}"`
          + `; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      });
      response.end(archive.data);
      return true;
    }

    // 会话工作区图片回显(只读旁路,数据面在 workspaceImages.ts):
    // 分析报告 markdown 里嵌入的截图引用(工单截图、登记截图两种
    // 白名单形状)经此从会话工作区读盘给浏览器(#376)。形状白名单即
    // 边界,读无闸(查看模式,与 documents/reviews 同语义);缺失与
    // 非法形状同一个 404 出码,不泄露盘面事实。
    if (method === "GET" && parts[2] === "workspace-image"
        && parts.length === 3) {
      const session = issueFlow.session(id);
      const path = String(
        new URL(request.url ?? "", "http://x").searchParams.get("path") ?? "");
      if (!path) return done(400, { error: "缺少 path 参数" });
      const image = readWorkspaceImage({ root: session.root, path });
      if (!image) return done(404, { error: "图片不存在或路径非法" });
      response.writeHead(200, {
        "content-type": image.mime_type,
        "content-length": String(image.data.length),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=86400",
      });
      response.end(image.data);
      return true;
    }

    // 分析报告版本(#262,ADR-0025):平台在检视提交时冻结的快照推导出
    // 「初版/修订N」,live 恒为最新版。读:登录即可(查看模式,与
    // documents/reviews 同语义);版本是记账行为,没有写面。缺失同样以
    // 200 {unavailable} 出码——"还没有这一版"不是"没有这个接口"。
    if (method === "GET" && parts[2] === "analysis-versions"
        && parts.length === 3) {
      const session = issueFlow.session(id);
      return done(200, { versions: listAnalysisVersions(session.root) });
    }
    if (method === "GET" && parts[2] === "analysis-versions"
        && parts[3] === "read" && parts.length === 4) {
      const session = issueFlow.session(id);
      const name = String(
        new URL(request.url ?? "", "http://x").searchParams.get("name") ?? "");
      const read = readAnalysisVersion(session.root, name);
      if (!read) return done(200, { unavailable: "版本不存在" });
      return done(200, {
        name: read.meta.name,
        content: read.content,
        ...(read.truncated ? { truncated: true } : {}),
      });
    }

    // 协作流(只读,ADR-0018):事件账本投影成任务侧会话流同形状条目,
    // 右栏「与 Agent 协作」对话框消费;在场闸由服务侧从状态投影为
    // waiting 卡。查看模式语义与 documents/reviews 一致:登录即可读。
    // (#260 删 GET /issues/:id/dialogue:复盘问答投影随「过程问答」
    // 页签退役,现场直播与协作流继续由 conversation 承担。)
    if (method === "GET" && parts[2] === "conversation" && parts.length === 3) {
      return done(200, issueFlow.conversation(id));
    }

    // 检视(ADR-0007):意见账本 + 提交重跑。读:登录即可(查看模式);
    // 记/删/提交:仅归属人。提交是"整体回退"这一有后果动作的人工触发
    // 源,服务层把门(固定流程/未终态/非转正继承/不可叠加/状态在
    // 等或闲置);这里的轻量确认在页面层,服务端只认状态守卫。
    if (method === "GET" && parts[2] === "reviews" && parts.length === 3) {
      return done(200, issueFlow.listReviews(id));
    }
    if (method === "POST" && parts[2] === "reviews" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能记检视意见" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.addReview(id, {
        line: Number(body.line),
        anchor: String(body.anchor ?? ""),
        quote: String(body.quote ?? ""), line_end: Number(body.line_end ?? 0),
        context_before: String(body.context_before ?? ""), context_after: String(body.context_after ?? ""),
        note: String(body.note ?? ""),
      }));
    }
    if (method === "POST" && parts[2] === "reviews"
        && parts[3] === "send" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能提交检视" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.submitReviews(id, Array.isArray(body.ids) ? body.ids.map(String) : undefined));
    }
    // 意见处就地回复(检视回复环):review = 意见号或台账 id。
    if (method === "POST" && parts[2] === "reviews"
        && parts[3] === "reply" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能回复检视意见" });
      }
      const body = await readBody(request);
      const reference = /^\d+$/.test(String(body.review ?? ""))
        ? Number(body.review) : String(body.review ?? "");
      return done(200, issueFlow.replyToReview(id, reference, String(body.text ?? "")));
    }
    if (method === "PATCH" && parts[2] === "reviews" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) return done(403, { error: "只有归属人能处理意见" });
      const body = await readBody(request);
      return done(200, issueFlow.updateExternalReview(id, decodeURIComponent(parts[3]), {
        ...(typeof body.context === "string" ? { context: body.context } : {}),
        ...(typeof body.reply === "string" ? { reply: body.reply } : {}),
        ...(body.resolve_remote === true ? { resolve_remote: true } : {}),
      }));
    }
    if (method === "DELETE" && parts[2] === "reviews" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能移除检视意见" });
      }
      return done(200, issueFlow.dropReview(id, String(parts[3])));
    }

    // 现场记录导出(GET /issues/:id/export):事件流逐字 + 台账 → 单文件
    // Markdown,人粗读 + 喂 AI 复盘(2026-08-28 拍板)。内容不脱敏,
    // 文件头自带传播提示;disposition 双文件名(ASCII 兜底 + UTF-8 中文)。
    if (method === "GET" && parts[2] === "export" && parts.length === 3) {
      const record = issueFlow.exportWorksite(id);
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${record.filenameAscii}"`
          + `; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      });
      response.end(record.markdown);
      return true;
    }

    // 环境预热直播(对齐清单⑤):预热会话事件尾随,读 <会话根>/warmup/
    // events.jsonl;读路由登录即可(查看模式同款),凭据与内容不涉密。
    if (method === "GET" && parts.length === 4
        && parts[2] === "warmup" && parts[3] === "events") {
      streamIssueJsonl(issueFlow, id, response,
        () => join(issueFlow.session(id).root, "warmup", "events.jsonl"));
      return true;
    }

    if (method === "GET" && parts[2] === "events" && parts.length === 3) {
      streamIssueEvents(issueFlow, id, response);
      return true;
    }

    if (method === "POST" && parts[2] === "reply" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能续聊" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.reply(id, String(body.text ?? "")));
    }

    if (method === "POST" && parts[2] === "decision" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能作答" });
      }
      const body = await readBody(request);
      const answers = body.answers && typeof body.answers === "object"
        ? Object.fromEntries(Object.entries(body.answers)
          .map(([key, value]) => [key, String(value)]))
        : undefined;
      // skill 圈选闸(ADR-0011)的勾选清单:字符串数组,服务端按闸上
      // 清单核子集——浏览器自报路径在裁决层被拒。
      const selection = Array.isArray(body.selection)
        ? body.selection.map((item: unknown) => String(item))
        : undefined;
      return done(200, issueFlow.answer(id, {
        state_version: Number(body.state_version),
        decision: String(body.decision ?? ""),
        // 决策码(平台闸的裁决协议):与 decision 并行携带,文案不是匹配键。
        ...(body.code !== undefined ? { code: String(body.code) } : {}),
        ...(answers ? { answers } : {}),
        ...(selection ? { selection } : {}),
        ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
      }));
    }

    // 会话仓清单调整(#241,元信息页签的仓编辑器):设计裁定=端点不直
    // 改仓清单——只校验+留痕+发送通知,清单由 Agent 经 pull_repo(新增,
    // 幂等入列)/remove_repo(移除,#240,远端分支现查)执行后变化。写闸
    // 照 reply 同款:仅归属人,管理员不写。全空 diff 在这里 400 人话打回;
    // 域校验(https/在册/模块绑定/上限)在服务层走 IssueControlError,
    // 由尾部单点映射出码。
    if (method === "POST" && parts[2] === "repos" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能调整会话的代码仓清单" });
      }
      const body = await readBody(request);
      const add = Array.isArray(body.add) ? body.add.map(String) : [];
      const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
      if (!add.some((item) => item.trim())
          && !remove.some((item) => item.trim())) {
        return done(400, {
          error: "新增与移除都为空:至少指派一个要新增或要移除的代码仓",
        });
      }
      return done(200, issueFlow.requestRepoChanges(id, { add, remove }));
    }

    // 主动拉取日志(#268,Agent 主理第二例,ADR-0026):按钮不执行任何
    // 事——端点只守卫+留痕+发送通知词(终态/queued 由服务层打回),
    // 拉取由 Agent 按技能 fetch-logs 执行(缺环境走既有环境闸)。写闸
    // 仅归属人,与调整关联仓同款。
    if (method === "POST" && parts[2] === "logs"
        && parts[3] === "fetch" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只能请求拉取自己会话的日志" });
      }
      return done(200, issueFlow.requestLogFetch(id));
    }

    // 网管环境配置(env_needed 闸的作答口):登记时没配环境,拉日志/
    // 换库现场举闸后在这里补地址与网管后台密码。密码只经此进 vault(与
    // 登记同一条存储路径),状态/事件里永远只有引用——成功即清闸并开
    // 平台回合让 Agent 重试。闸只收地址+后台密码:页面凭据是登记侧的
    // 四件套,现场补配的流程(抓日志/换库)碰不到网管页面。
    // 快照语义(#150,ADR-0020):environment_id 在场即从环境台账快照,
    // 服务端解密取值(前端零密码),与手填同一条 storeEnvironment 路径;
    // 与 decline 互斥、与手填字段互斥,同给一律 400。
    // decline 分支(票 93)是同一提交口上的拒绝路:归属人认定这一动作
    // 不需要网管环境,硬拒绝+可解锢(配置成功自动解除);闸不在场由
    // 服务层如实打回。手填路另带可选 root 密码与「存入环境管理」沉淀。
    if (method === "POST" && parts[2] === "environment" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能作答网管环境卡(填写或拒绝)" });
      }
      const body = await readBody(request);
      if (body.environment_id !== undefined
          && body.environment_id !== null) {
        if (body.decline === true) {
          return done(400, {
            error: "台账快照与拒绝互斥:要么从环境管理选环境提交,"
              + "要么拒绝这张卡",
          });
        }
        if (body.hosts !== undefined
            || body.backend_password !== undefined
            || body.port !== undefined
            || body.env_type !== undefined
            || body.root_password !== undefined
            || body.save_to_registry !== undefined) {
          return done(400, {
            error: "台账快照与手工填写互斥:要么从环境管理选环境提交,"
              + "要么手动填写(含 root 密码与存入环境管理)",
          });
        }
        return done(200, issueFlow.attachEnvironment(id, {
          environmentId: String(body.environment_id),
        }));
      }
      if (body.decline === true) {
        // note 只收字符串:null/数字等脏输入不当理由入账转 AI。
        const note = typeof body.note === "string" && body.note.trim()
          ? { note: String(body.note) } : undefined;
        return done(200, issueFlow.declineEnvironment(id, note));
      }
      return done(200, issueFlow.attachEnvironment(id, {
        hosts: Array.isArray(body.hosts) ? body.hosts.map(String) : [],
        ...(body.port !== undefined ? { port: Number(body.port) } : {}),
        ...(body.env_type !== undefined
          ? { envType: String(body.env_type) as IssueEnvType } : {}),
        backendPassword: String(body.backend_password ?? ""),
        // 手填可选 root 密码(空串 = 留空,与后台密码相同,不落独立凭据)。
        ...(typeof body.root_password === "string"
            && body.root_password.trim()
          ? { rootPassword: body.root_password.trim() } : {}),
      }, { saveToRegistry: body.save_to_registry === true }));
    }

    if (method === "POST" && parts[2] === "interrupt" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能补充" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.steer(id, String(body.text ?? "")));
    }

    // 人工接管三口(2026-09-07 走查拍板):接管=打断 AI(回合中止,
    // 现场交由人工);note=期间人工操作只记账不投喂;resume=交还,
    // AI 带着接管期人工记录继续。写闸同 control:仅归属人,管理员不写。
    if (method === "POST" && parts[2] === "takeover" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能接管会话" });
      }
      return done(200, issueFlow.takeover(id));
    }

    if (method === "POST" && parts[2] === "takeover"
        && parts[3] === "note" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能记录人工操作" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.addTakeoverNote(id, String(body.text ?? "")));
    }

    if (method === "POST" && parts[2] === "takeover"
        && parts[3] === "resume" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能交还会话" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.resumeFromTakeover(id,
        typeof body.note === "string" ? { note: body.note } : undefined));
    }

    if (method === "POST" && parts[2] === "ticket" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能绑定单号" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.bindTicket(id, String(body.ticket ?? "")));
    }

    // 提单模板(ADR-0048):确认是问题闭环的会话在场。登记人(只读/
    // 查看模式)也要能拿到模板去提单——读路由登录即可,不设归属人门。
    if (method === "GET" && parts[2] === "ticket-template" && parts.length === 3) {
      const text = issueFlow.ticketTemplate(id);
      if (text === undefined) {
        return done(404, { error: "提单模板不存在(非问题/取消的会话或早期会话没有模板)" });
      }
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      response.end(text);
      return true;
    }

    // 关联转正已退役(ADR-0048):无单会话确认是问题即闭环归档并产出
    // 提单模板;手动归档也已退役(ADR-0057)。显式 410 给旧前端一个
    // 明确指引,不留裸报错。
    if (method === "POST" && parts[2] === "associate" && parts.length === 3) {
      return done(410, {
        error: "关联转正已退役:无单会话确认是问题即闭环归档(提单模板已出)",
      });
    }

    if (method === "POST" && parts[2] === "control" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能重跑或取消会话" });
      }
      const body = await readBody(request);
      // 动作白名单 fail-loud:拼错的动作打回 400,不静默落成别的动作。
      const action = ["cancel", "revive"].includes(String(body.action))
        ? String(body.action) as "cancel" | "revive" : undefined;
      if (!action) {
        return done(400, { error: "未知 control 动作,只支持重跑/取消" });
      }
      // 终止原因(#541):cancel 动作的独立入参(不复用 revive 的 note),
      // 词表白名单与动作同款 fail-loud;缺席=无原因取消(历史路径),
      // 行为不变。revive 不收原因,递了也不透传。
      const reason = typeof body.reason === "string"
        && (ISSUE_CANCEL_REASONS as readonly string[]).includes(body.reason)
        ? body.reason as IssueCancelReason : undefined;
      if (body.reason !== undefined && !reason) {
        return done(400, { error: ISSUE_CANCEL_REASON_UNKNOWN_ERROR });
      }
      const reasonText = typeof body.reason_text === "string"
        && body.reason_text.trim() ? body.reason_text : undefined;
      // 说明与原因的组合也 fail-loud(#540 复审):说明只跟「其他原因」
      // 有意义,缺席原因或搭配其他原因递说明,与词表外原因同款 400——
      // 不静默丢弃(服务端「非 other 不落说明」的兜底语义不变)。
      if (reasonText && reason !== "other") {
        return done(400, { error: "终止说明只搭配「其他原因」有效:"
          + "请把 reason 设为 other,或去掉 reason_text" });
      }
      return done(200, await issueFlow.control(id, {
        action,
        ...(body.note !== undefined ? { note: String(body.note) } : {}),
        ...(reason ? { reason } : {}),
        ...(reason && reasonText ? { reasonText } : {}),
      }));
    }

    return done(404, { error: "未知问题接口" });
  } catch (error) {
    // 单点映射(#9):域错误族 → 状态码 + 对外消息,错误族与口径见
    // errors.ts 的映射表。未登记的失败原样上抛,交服务器兜底 500——
    // 不猜码,也不在路径上各自包一层。
    const mapped = toHttpError(error);
    if (!mapped) throw error;
    return done(mapped.status, { error: mapped.message });
  }
}
