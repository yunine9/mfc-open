import { listKnowledgeDocuments } from "./knowledgeDocuments.ts";
import { readHostSkillPackage, readSkillSubmissionPackage } from "./hostSkillLibrary.ts";
import { readKnowledgeSkillContext, saveKnowledgeSkillContext } from "./knowledgeSkillContext.ts";
import { listKnowledgeTasks } from "./knowledgeTaskCenter.ts";
import { listHostSkillShelf } from "./hostSkillShelf.ts";
import { projectKnowledgeProduction } from "./knowledgeProductionState.ts";
import { listKnowledgeReviewNotes, saveKnowledgeReviewNote, applyKnowledgeReviewNotes, resolveKnowledgeReviewNotes, type KnowledgeReviewKind, type KnowledgeReviewNoteInput } from "./knowledgeReviewNotes.ts";
import { componentKnowledgeRoute } from "./componentKnowledgeRoutes.ts";
import { readFinalMrComparison } from "./deliveryAnalytics.ts";
import { normalizeRepairMrUrl } from "./mrImportTypes.ts";
import { continuationHistoryZip } from "./taskContinuation.ts";
import { finalMrContinuationBlock } from "./finalMrContinuationPolicy.ts";
import { domainKnowledgeRoute } from "./domainKnowledgeRoutes.ts";
import { extractionConfigurationRoute } from "./knowledgeExtractionRoutes.ts";
import { componentResearchRoute } from "./componentResearchRoutes.ts";
import { knowledgeDocumentRoute } from "./knowledgeDocumentRoutes.ts";
import { knowledgeAnswerRoute, lubanKnowledgeRoute } from "./knowledgeAnswerRoutes.ts";
import { KnowledgeAnswerError, type KnowledgeAnswers } from "./knowledgeAnswers.ts";
import { randomUUID } from "node:crypto";
import { traceHttpRequest, sanitizeBrowserTimings } from "./runtimeDiagnostics.ts";
import { MemoryStore } from "./taskMemory.ts";
import { listProductVersions, saveProductVersion, deleteProductVersion } from "./configurationCenter.ts";
import { listTechnologyStacks, createTechnologyStack, updateTechnologyStack, requireTechnologyStacks, TechnologyStackError } from "./technologyStacks.ts";
import { deleteTechnologyStack } from "./technologyStackDeletion.ts";
import { readKnowledgeRepoConfig, saveKnowledgeRepoConfig, clearKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";
import { resolveModuleKnowledgeLocation, saveModuleKnowledgeLocation } from "./businessModuleKnowledge.ts";
import { readModuleKnowledgeSync } from "./knowledgeRepositorySync.ts";
import { listModuleRepositoryKnowledgePaths } from "./knowledgeRepositorySnapshots.ts";
import { readResourceBlocks } from "./repositoryResourcePolicy.ts";
/**
 * 任务 API(主 spec §5.1/§5.2):REST 命令 + SSE 事件流,零框架依赖。
 *
 *   POST /tasks                {requirement}            → 201 摘要
 *   GET  /tasks                                         → 列表
 *   GET  /knowledge-insights                            → 团队知识效能(只读)
 *   GET  /memory-insights                               → 任务记忆总览(只读,可见不可管)
 *   GET  /memory-insights/:mid                          → 一条记忆的原文(归档的也能读)
 *   GET  /business-modules                              → 业务模块、Owner 与知识目录
 *   POST /business-modules                              → 团队成员创建模块
 *   PUT  /business-modules/:id                          → 团队成员维护模块与仓库映射
 *   GET/PUT/DELETE /business-modules/:id/assets/:asset  → 查看/发布/归档模块知识
 *   GET  /skills                                        → Skill 货架 + 操作留痕
 *   GET  /skills/:dir/versions                          → 归档版本痕(可回退点)
 *   GET  /skills/submissions                            → 待审/已裁决提交台账(登录即可)
 *   POST /skills/:dir/submissions {files:[…]}           → 开发者提交待审(登录即可,同一道验收闸)
 *   POST /skills/:dir/submissions/:id/approve           → 审核通过并上架(管理员)
 *   POST /skills/:dir/submissions/:id/reject {reason?}  → 驳回留痕(管理员)
 *   DELETE /skills/:dir                                 → 下线并归档(管理员)
 *   POST /skills/:dir/rollback {version}                → 回退归档版本(管理员)
 *   POST /knowledge/skill-extract {repo,intent,path_hint?} → 定向提取起草(登录即可)
 *   GET  /knowledge/skill-extract/:id                   → 提取任务状态/草稿
 *   GET  /tasks/:id                                     → 详情(含待办)
 *   POST /tasks/:id/decision   {state_version,decision,notes?}
 *        → 200;版本冲突/已被抢先 → 409 "任务状态已变化"(先到决定生效)
 *   PUT  /tasks/:id/collaborators {collaborators[]}     → 跨仓主任务共同开发者
 *   POST /tasks/:id/interrupt  {text}                   → 200;跑动中插话(发送即打断)
 *   GET/POST /tasks/:id/developer-assistant             → 旁路开发助手现场/发起处理
 *   POST /tasks/:id/pause|resume|cancel                 → 200;任务控制
 *   POST /tasks/:id/rerun                               → 200;原位清空并从头重跑
 *   DELETE /tasks/:id                                   → 200;责任人/管理员彻底删除真终态历史
 *   GET  /tasks/:id/interrupts                          → 发过的插话 + 送达与否
 *   GET  /tasks/:id/memories                            → 本单落下的记忆(只读)
 *   GET  /tasks/:id/memories/usage                      → 这单用到的记忆(推送/检索足迹)
 *   POST /tasks/:id/memories/:mid/withdraw              → 撤回自己圈的记忆
 *   GET  /tasks/:id/annotations                         → 待送出批注 + 锚点现状
 *   POST /tasks/:id/annotations {artifact,file,line,anchor,note,kind} → 201
 *   PATCH /tasks/:id/annotations/:annId {note}        → 修改(只能改自己的)
 *   DELETE /tasks/:id/annotations/:annId                → 作者删除草稿或申请撤回已提交表达
 *   POST /tasks/:id/annotations/send {ids?}             → 走插话通道当场送给模型
 *   POST /tasks/:id/annotations/:annId/verify           → 责任人逐条确认（revision 必填）
 *   POST /tasks/:id/annotations/:annId/reopen           → 裁决:返工,退回草稿再送一轮
 *   GET  /tasks/:id/events                              → SSE:重放事件日志后持续跟进
 *   GET  /tasks/:id/build-fix/events                    → SSE:Build-Fix 实时事件(换轮自动切新)
 *   POST /tasks/:id/build-fix/skip                      → 失败停机后人工拍板跳过,直推流水线裁决
 *   POST /tasks/:id/build-fix/retry                     → 人工重跑 Build-Fix(僵尸现场出路/活性探针)
 *   POST /tasks/:id/build-fix/stop                      → 停止在途 Build-Fix 并直推流水线(绑 HEAD 跳过)
 *   /prepush/*                                          → 旧客户端兼容别名
 *   GET  /tasks/:id/warmup/events                       → SSE:环境预热编译实时事件
 *   GET  /tasks/:id/timeline                            → 人话交付时间线(只读现场)
 *   GET  /tasks/:id/activity                            → 行为摘要:此刻在干嘛/分段折叠/异常信号
 *   GET  /tasks/:id/push-review-diff?scope=changes|full → 当前 push 检视比较(只读)
 *   GET  /tasks/:id/artifacts[/:name]                   → 检视产物清单/内容(只读现场)
 *
 * Web 不自行推断状态:详情与列表只是 TaskService 状态的镜像,
 * 事件流只是 events.jsonl 的镜像——真相都在文件与状态机里。
 */

import { createServer, type Server } from "node:http";
import { readTaskKnowledgeSource } from "./taskKnowledgeSource.ts";
import { isIssueInterventionTier } from "./auth.ts";
import { storyArchitecture } from "./storyArchitecture.ts";
import { currentStoryFile, readCurrentStoryArchitecture } from "./overallStoryStore.ts";
import { readArchitectureStory } from "./storyArchitectureSource.ts";
import { isMainTaskDelivery } from "./requirementDecisionContract.ts";
import { renderArchify, ARCHIFY_COMMIT } from "./archifyRender.ts";
import {
  createReadStream,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { StateConflictError } from "./humanGate.ts";
import {
  DEFAULT_BUILD_CACHE_MAX_GB,
  DEFAULT_BUILD_CACHE_RETENTION_DAYS,
  DEFAULT_WORKSPACE_RETENTION_DAYS,
  type DeliveryCompileAction,
  NotFoundError,
  TaskControlError,
  type RequirementGraph,
  type SteerKnowledgeReference,
  type TaskService,
} from "./taskService.ts";
import { PLANTUML_SOURCE_LIMIT, renderPlantUml } from "./plantumlRender.ts";
import { REVIEW_ASSET_MAX_BYTES, ReviewAssetError } from "./reviewAssets.ts";
import { buildTimelineAsync } from "./timeline.ts";
import { streamExecutionEvents } from "./executionEvents.ts";
import {
  ArtifactArchiveTooLargeError,
  bundleArtifactDocuments,
  listArtifactsAsync,
  listArtifactChangeDirectoryAsync,
  readArtifactAsync,
  readArtifactFileDiffAsync,
} from "./artifacts.ts";
import { WEB_PAGE } from "./webPage.ts";
import { readTaskDemoSnapshot } from "./taskDemoSnapshot.ts";
import { generateTaskDemoCard, TaskDemoCardError } from "./taskDemoCard.ts";
import {
  cookieValue,
  type AuthUser,
  type LocalAuth,
} from "./auth.ts";
import { SettingsError } from "./settings.ts";
import {
  checkModelGateway,
  GatewayCheckError,
  resolveGatewayTarget,
} from "./modelGatewayCheck.ts";
import {
  AnnotationError,
  AnnotationPermissionError,
  AnnotationConflictError,
} from "./annotations.ts";
import {
  WishWallError,
  WishWallNotFoundError,
  WishWallPermissionError,
  WishWallStore,
  type WishRecord,
  type WishStatus,
} from "./wishWall.ts";
import type { LubanApprovalGateway } from "./lubanApproval.ts";
import { buildRequirementMaterials } from "./requirementMaterials.ts";
import { handleIssueRoutes } from "./issueFlow/routes.ts";
import { autoClaimNextRunAt } from "./issueFlow/autoClaim.ts";
import { DEFAULT_ISSUE_AUTO_CLAIM_INTERVAL_S } from "./issueFlow/autoClaim.ts";
import {
  ISSUE_BUILD_PRODUCTS_COOLDOWN_HOURS_DEFAULT,
  ISSUE_REPO_RECLAIM_DEFAULT,
  ISSUE_WARMUP_ENABLED_DEFAULT,
  ENV_VERIFY_WATCHDOG_MINUTES_DEFAULT,
} from "./issueFlow/service.ts";
import { EnvironmentRegistry } from "./environmentRegistry.ts";
import { handleEnvironmentRoutes } from "./environmentRegistryRoutes.ts";
import {
  SkillLibraryError,
  SkillVersionConflictError,
  updateHostSkillPackage,
  approveSkillSubmission,
  listSkillOperations,
  listSkillSubmissions,
  listSkillVersions,
  offlineHostSkill,
  readHostSkillDocument,
  rejectSkillSubmission,
  rollbackHostSkill,
  submitHostSkill,
  updateHostSkillKnowledgeMetadata,
  uploadHostSkill,
} from "./hostSkillLibrary.ts";
import {
  BusinessModuleError,
  archiveBusinessKnowledgeAsset,
  canManageBusinessModule,
  createBusinessModule,
  listBusinessModules,
  migrateBusinessModule,
  publishBusinessKnowledgeAsset,
  readBusinessKnowledgeAsset,
  readBusinessModule,
  updateBusinessModule,
} from "./businessModuleLibrary.ts";
import {
  normalizeKnowledgeAssetMetadata,
  repositoryIdentity,
  type KnowledgeAssetMetadata,
} from "./knowledgeAssetModel.ts";
import {
  normalizeRepositoryProfile,
  requireRepositoryProfiles,
  RepositoryProfileError,
  resolveRepositoryProfiles,
  saveRepositoryProfile,
} from "./repositoryProfiles.ts";
import {
  WorkflowAssetError,
  WorkflowAssetLibrary,
  canEdit as canEditWorkflow,
  canPublish as canPublishWorkflow,
  canView as canViewWorkflow,
} from "./workflowAssetLibrary.ts";
import type { WorkflowSourceRef } from "./workflowDefinition.ts";
import { listWorkflowAssetCatalog } from "./workflowAssetRegistry.ts";
import { readWorkflowStandardSnapshot } from "./workflowCatalog.ts";

/** 正式前端静态文件的最小类型表:Vite 产物就这几种。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

class RequestBodyTooLargeError extends Error {}

function readBody(
  request: import("node:http").IncomingMessage,
  limit = Number.POSITIVE_INFINITY,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new RequestBodyTooLargeError("请求内容过大"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/** 回调正文卡在 16 KiB：这里只有工号和一条文本命令，大包没有用途。 */
function readRawBody(
  request: import("node:http").IncomingMessage,
  limit = 16 * 1024,
): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) reject(new Error("回调正文超过 16 KiB"));
      else resolveBody(Buffer.concat(chunks).toString("utf-8"));
    });
    request.on("error", reject);
  });
}

/** 校验/领域错误给人看:取 message,剥掉嵌套 "Error: " 前缀。
 * 用户曾直面 "Error: 密码至少需要 10 个字符"(MFC-018.1)。 */
function humanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^(Error:\s*)+/, "");
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

function skillMetadataFromBody(
  dataDir: string,
  body: any,
): KnowledgeAssetMetadata {
  const rawTechnologies = body.technologies ?? body.languages;
  if (rawTechnologies !== undefined && !Array.isArray(rawTechnologies)) {
    throw new SkillLibraryError("工程语言标签必须是数组");
  }
  if (body.business_module_ids !== undefined
      && !Array.isArray(body.business_module_ids)) {
    throw new SkillLibraryError("业务模块必须是数组");
  }
  if (body.repositories !== undefined && !Array.isArray(body.repositories)) {
    throw new SkillLibraryError("适用仓库必须是数组");
  }
  try {
    const technologies = rawTechnologies?.map(String) ?? [];
    const metadata = normalizeKnowledgeAssetMetadata({
      nature: body.nature,
      form: "skill",
      business_module_ids: body.business_module_ids?.map(String) ?? [],
      repositories: body.repositories?.map(String) ?? [],
      technologies,
    }, { fixedForm: "skill" });
    for (const id of metadata.business_module_ids) {
      const module = readBusinessModule(dataDir, id);
      if (module.status !== "active") {
        throw new SkillLibraryError(`业务模块 ${module.name} 已归档，不能关联新 Skill`);
      }
    }
    return metadata;
  } catch (error) {
    if (error instanceof SkillLibraryError) throw error;
    if (error instanceof BusinessModuleError) {
      throw new SkillLibraryError(error.message);
    }
    throw new SkillLibraryError(
      error instanceof Error ? error.message : String(error));
  }
}

/** 从这次 HTTP 请求还原用户真正访问的站点。浏览器 Origin 最接近
 * 用户地址栏，即使反代把后端 Host 改成 127.0.0.1 也不受影响；其次
 * 才认 X-Forwarded-* 与 Host。--public-url 只用于特殊部署覆盖。 */
function requestBaseUrl(
  request: import("node:http").IncomingMessage,
): string | undefined {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  const origin = first(request.headers.origin);
  if (origin && origin !== "null") {
    try {
      const parsed = new URL(origin);
      if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch { /* 坏 Origin 继续走代理头和 Host，不挡请求。 */ }
  }
  const host = first(request.headers["x-forwarded-host"])
    ?? first(request.headers.host);
  if (!host || /[\r\n/\\]/.test(host)) return undefined;
  const forwardedProtocol = first(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function createTaskServer(
  service: TaskService,
  options: {
    webRoot?: string;
    auth?: LocalAuth;
    lubanApproval?: LubanApprovalGateway;
    lubanKnowledgeToken?: string;
    knowledgeAnswers?: KnowledgeAnswers;
    issueFlow?: import("./issueFlow/service.ts").IssueFlowService;
    pipelineRepairs?: import("./issueFlow/service.ts").IssueFlowService;
    mcpGateway?: import("./issueFlow/gateways.ts").McpGateway;
    /** DTS 网关:问题路由直连拉单/详情/内嵌图代理(服务不再转手)。 */
    dts?: import("./issueFlow/gateways.ts").DtsGateway;
    /** 问题路由的台账日志(人工修改留痕,与问题服务同一口径)。 */
    log?: (message: string) => void;
    /** 部署版本号(服务启动时间):页面侧边栏显示,部署后确认代码生效。 */
    buildHash?: string;
    startup?: Pick<import("./startupRecovery.ts").StartupRecovery, "state">;
  } = {},
): Server {
  // TaskService 也可由测试、pilot 或嵌入式调用方直接构造。只要 HTTP
  // 边界接了账号库，就补上同一份委派就绪校验，避免绕过 serve.ts
  // 时“候选列表说未就绪，提交接口却放行”的双重真相。
  if (options.auth && !service.options.collaborationAssigneeReadiness) {
    service.options.collaborationAssigneeReadiness = (account) =>
      options.auth!.collaborationAssignees(service.launchOptions().needs)
        .find((candidate) => candidate.username === account)
        ?? { ready: false, missing: ["账号不存在或不是可用开发账号"] };
  }
  // 许愿墙按路由首次使用时才要求完整 TaskService 数据目录。知识效能等
  // 独立只读接口会用最小服务替身，旁路能力不能在起服阶段反向绑死它们。
  let wishWall: WishWallStore | undefined;
  const getWishWall = () => wishWall ??= new WishWallStore(
    join(service.options.dataDir, "wish-wall"));
  let workflowAssets: WorkflowAssetLibrary | undefined;
  const getWorkflowAssets = () => workflowAssets ??= new WorkflowAssetLibrary(
    service.options.dataDir);
  // 环境管理台账(#149,ADR-0020):按路由首次使用时才落 dataDir,与
  // wishWall 同款惰性——旁路/最小服务替身不在起服阶段反向绑死台账。
  let environmentRegistry: EnvironmentRegistry | undefined;
  const getEnvironmentRegistry = () =>
    environmentRegistry ??= new EnvironmentRegistry(service.options.dataDir);
  // 知识效能等独立只读接口会传最小服务替身；工作流旁路不能在起服
  // 阶段要求完整 TaskService.options，更不能反向绑死无关读侧。
  const workflowKernelRoot = service.options?.host?.kernelRoot
    ?? service.options?.workflowCatalogRoot;
  const browserTimingLast = new Map<string, number>();
  let knowledgeTaskSummary: { at: number; summary: ReturnType<typeof listKnowledgeTasks>["summary"] } | undefined;
  return createServer(async (request, response) => {
    traceHttpRequest(request, response, options.log ?? service.options?.log);
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")
        && ["business-modules", "skills", "memories"].includes(parts[0])) {
      response.once("finish", () => {
        if (response.statusCode < 300) service.prepareKnowledgeIndex?.();
      });
    }
    try {
      if (options.startup && request.method === "GET" && url.pathname === "/health") {
        return json(response, options.startup.state === "ready" ? 200 : 503,
          { status: options.startup.state });
      }
      if (options.startup && options.startup.state !== "ready") {
        response.setHeader("Retry-After", "3");
        return json(response, 503, { error: options.startup.state === "failed"
          ? "服务恢复失败，请管理员检查启动日志" : "服务正在恢复任务，请稍后重试" });
      }
      const sessionToken = cookieValue(
        request.headers.cookie,
        "mae_flow_session",
      );
      const viewer = options.auth?.sessionUser(sessionToken);
      if (request.method === "POST" && url.pathname === "/browser-timing") {
        if (options.auth && !viewer) return json(response, 401, { error: "请先登录" });
        const account = viewer?.username ?? "local";
        const previous = browserTimingLast.get(account) ?? 0;
        if (Date.now() - previous < 5_000) return json(response, 204, {});
        browserTimingLast.set(account, Date.now());
        const body = await readBody(request, 8_192);
        const entries = sanitizeBrowserTimings(body.entries);
        if (entries.length) (options.log ?? service.options?.log)?.(`[browser-timing] ${JSON.stringify({ at: new Date().toISOString(), entries })}`);
        return json(response, 204, {});
      }
      if (viewer) {
        // 两侧通知深链都靠真实访问入口兜底:需求侧 /work 与问题侧
        // /issues 同款自学,--public-url 缺席时不能只剩路径后缀。
        const linkBase = requestBaseUrl(request);
        service.observeLinkBase(linkBase);
        options.issueFlow?.observeLinkBase(linkBase);
      }

      // 小鲁班插件回调使用独立固定 Token，不依赖浏览器 Cookie。插件
      // 只获得这一个纯文本入口，绝不能借它穿透成通用任务 API。
      if (parts[0] === "integrations" && parts[1] === "luban"
          && parts[2] === "plugin" && parts.length === 3) {
        if (!options.lubanApproval) {
          return json(response, 404, { error: "未启用小鲁班手机审批" });
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          return json(response, 405, { error: "只接受 POST" });
        }
        let rawBody: string;
        try {
          rawBody = await readRawBody(request);
        } catch (error) {
          return json(response, 413, { error: humanError(error) });
        }
        const first = (value: string | string[] | undefined) =>
          Array.isArray(value) ? value[0] : value;
        const authorization = first(request.headers.authorization);
        const reply = await options.lubanApproval.handle({
          rawBody,
          token: first(request.headers["x-mfc-luban-plugin-token"])
            ?? authorization?.replace(/^Bearer\s+/i, ""),
        });
        return json(response, reply.status, {
          text: reply.text,
          ...(reply.replayed ? { replayed: true } : {}),
        });
      }
      if (parts[0] === "integrations" && parts[1] === "luban" && parts[2] === "knowledge" && parts.length === 3) {
        return lubanKnowledgeRoute(request, response, () => options.knowledgeAnswers ?? service.getKnowledgeAnswers(), {
          token: options.lubanKnowledgeToken,
          accountEnabled: account => !!options.auth?.sessionView(account),
        }, readBody, json);
      }
      /** 当前登录者自己缺的配置。两样都是"以本人身份做事"的凭据:
       * Git 令牌决定 push 与 MR 发起人是谁,通知令牌决定消息以谁的
       * 身份发——管理员代配不了(密钥只写不读),所以只能各人自己配,
       * 没配就别让他下单(用户 2026-08-18 拍板)。 */
      const personalBlockers = (
        who: { username: string; role?: string } | undefined,
      ): Array<{ key: string; label: string; where: "admin" | "me" }> => {
        if (!options.auth || !who) return [];
        // 管理员不发起任务,个人令牌对他不咬人——别拿"你缺 Git 令牌"
        // 去烦一个本来就不下单的角色。
        if (who.role === "admin") return [];
        const needs = service.launchOptions().needs;
        const missing: Array<
          { key: string; label: string; where: "admin" | "me" }> = [];
        const credential = needs.git_token
          ? options.auth.gitCredential(who.username) : undefined;
        if (needs.git_token && !credential) {
          missing.push({ key: "git_token", where: "me",
            label: "CodeHub Token 未配置（个人设置 → 个人接入），"
              + "没有它无法用你的身份推送代码" });
        }
        // 邮箱与令牌同级必填(用户拍板):commit 署名要它,平台按邮箱
        // 对人——缺它推上去的提交是无主的。老账号只配过令牌没配邮箱,
        // 在这儿被逮住补配,而不是等提交推上去才发现署名残缺。
        if (needs.git_token && credential && !credential.email) {
          missing.push({ key: "git_email", where: "me",
            label: "个人邮箱未配置（个人设置 → 个人接入），"
              + "Git 提交署名和 CodeHub 归属需要它" });
        }
        if (needs.luban_token && !options.auth.lubanToken(who.username)) {
          missing.push({ key: "luban_token", where: "me",
            label: "小鲁班 Token 未配置（个人设置 → 个人接入），"
              + "没有它就无法及时提醒你处理任务" });
        }
        return missing;
      };

      // 登录页资产公开，身份 API 自己决定是否需要会话。
      if (parts[0] === "auth") {
        if (request.method === "POST" && parts[1] === "login") {
          if (!options.auth) {
            return json(response, 404, { error: "未启用本地登录" });
          }
          const body = await readBody(request);
          const result = options.auth.authenticate(
            String(body.username ?? ""),
            String(body.password ?? ""),
            request.socket.remoteAddress ?? "unknown",
          );
          if (result.blockedForMs) {
            const seconds = Math.ceil(result.blockedForMs / 1000);
            response.setHeader("retry-after", String(seconds));
            // 锁多久要说清:服务端明明算了时长,前端不读 header,
            // 用户只看到"稍后"干等(MFC-031)。时长直接进文案。
            const wait = seconds >= 60
              ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
            return json(response, 429, {
              error: `登录失败次数过多，请约 ${wait} 后再试`,
              retry_after_s: seconds,
            });
          }
          if (!result.user) {
            return json(response, 401, { error: "账号或密码错误" });
          }
          const token = options.auth.createSession(result.user);
          response.setHeader("set-cookie", sessionCookie(token, request));
          // 登录成功后的首屏与刷新页面走的 /auth/me 必须是同一份视图。
          // 之前这里只回账号/角色，前端便把已有 Token 状态覆盖成“未配”。
          return json(response, 200,
            options.auth.sessionView(result.user.username));
        }
        if (request.method === "GET" && parts[1] === "me"
            && parts.length === 2) {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          // 只在即时身份查询续期，慢请求不携带可能覆盖后来登录的旧 Cookie。
          response.setHeader("set-cookie", sessionCookie(sessionToken!, request));
          return json(response, 200,
            options.auth!.sessionView(viewer.username));
        }
        if (request.method === "GET" && parts[1] === "me"
            && parts[2] === "moonlight-preview") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          return json(response, 200,
            service.previewMoonlight(viewer.username));
        }
        // 月光模式默认只影响后续节点。当前待办必须由调用方展示预览后
        // 显式带 include_current，且数量没有在确认期间发生变化。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "moonlight") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          const on = body.on === true;
          const preview = service.previewMoonlight(viewer.username);
          const includeCurrent = on && body.include_current === true;
          if (includeCurrent && Number(body.expected_eligible) !== preview.eligible) {
            return json(response, 409, {
              error: "待办数量已变化，请重新预览后确认",
              ...preview,
            });
          }
          options.auth!.setMoonlight(viewer.username, on);
          const swept = includeCurrent
            ? service.sweepMoonlight(viewer.username) : 0;
          return json(response, 200, { moonlight: on, swept, ...preview });
        }
        // push 前清单过目的个人默认(缺省即开):谁登录改谁的。
        // 关掉不撤已举的卡——那张卡按当时意愿举的,点确认即走。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "push-confirmation") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          options.auth!.setPushConfirmation(viewer.username, body.on === true);
          return json(response, 200,
            options.auth!.sessionView(viewer.username));
        }
        // 问题处理介入档位(ADR-0019,与需求侧两轴路由平行):三档
        // 缺省二档,一人一根旋钮。闸位策略由问题流按档位现读现判,
        // 这里只做存取与校验。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "issue-intervention") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          const tier = body.tier;
          if (!isIssueInterventionTier(tier)) {
            return json(response, 400, { error: "非法介入档位" });
          }
          options.auth!.setIssueInterventionTier(viewer.username, tier);
          return json(response, 200,
            options.auth!.sessionView(viewer.username));
        }
        // 自动接单开关(ADR-0061,2026-10-10 修订迁入个人设置):个人
        // 自助,谁登录改谁的,缺省关闭。管理员账号在 LocalAuth 拒收
        // (管理员不写问题会话,开了也轮不到)。翻转下一拍扫描生效。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "issue-auto-claim") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          try {
            options.auth!.setIssueAutoClaim(viewer.username, body.on === true);
          } catch (error) {
            return json(response, 400, { error: humanError(error) });
          }
          return json(response, 200,
            options.auth!.sessionView(viewer.username));
        }
        // 个人 Git 令牌:谁登录改谁的,写完只回掩码(只写不读)。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "git-token") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          try {
            options.auth!.setGitToken(
              viewer.username,
              String(body.token ?? ""),
              body.git_email === undefined
                ? undefined : String(body.git_email),
            );
          } catch (error) {
            return json(response, 400, { error: humanError(error) });
          }
          return json(response, 200,
            options.auth!.gitProfile(viewer.username));
        }
        // 个人通知令牌(小鲁班):同样只写不读。按人存是因为那个接口
        // 以令牌对应的人的身份发消息——管理员配一个服务号,所有人收到
        // 的都是同一个机器人；各人配自己的，普通提醒发给自己，主动
        // 邀请检视时则发给所选 Committer 工号。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "luban-token") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          try {
            options.auth!.setLubanToken(
              viewer.username, String(body.token ?? ""));
          } catch (error) {
            return json(response, 400, { error: humanError(error) });
          }
          return json(response, 200, {
            luban_token_hint: options.auth!.lubanTokenHint(viewer.username),
          });
        }
        // 个人设置里的连通测试必须复用正式发送端点与本人 Token；不能
        // 用一条绕过认证的“假成功”测试链路误导用户。
        if (request.method === "POST" && parts[1] === "me"
            && parts[2] === "luban-test") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const notifier = service.options.notifier;
          if (!notifier) {
            return json(response, 503, { error: "当前部署未启用小鲁班通知" });
          }
          if (notifier.needsPersonalToken()
              && !options.auth!.lubanToken(viewer.username)) {
            return json(response, 409, { error: "请先保存小鲁班 Token" });
          }
          const result = await notifier.testDelivery(viewer.username);
          if (!result.ok) {
            const reason = result.error?.match(/HTTP\s+\d{3}/)?.[0]
              ?? "通知服务暂不可用";
            return json(response, 502, {
              error: `测试消息未送达（${reason}），请检查 Token 或通知服务配置`,
            });
          }
          return json(response, 200, {
            ok: true,
            message: "测试消息已发送，请在小鲁班中确认是否收到。",
          });
        }
        // 个人模型网关(ADR-0068):成员自助配模型接入,四字段与平台
        // 网关同一套表单。谁登录配谁的;密钥只写不读,写完只回掩码。
        // 四字段全空或 clear=true=删除配置,名下任务回落平台网关。
        if (request.method === "PUT" && parts[1] === "me"
            && parts[2] === "models" && parts.length === 3) {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          try {
            options.auth!.setPersonalModels(viewer.username, body);
          } catch (error) {
            return json(response, 400, { error: humanError(error) });
          }
          return json(response, 200,
            options.auth!.personalModelsView(viewer.username));
        }
        // 个人网关连通测试:表单草稿 > 本人已存配置(密钥留空=沿用,
        // 与保存同口径)。个人通道没有部署层兜底——没配又没草稿就
        // 明说"没得测",不拿平台网关凑数。
        if (request.method === "POST" && parts[1] === "me"
            && parts[2] === "models" && parts[3] === "check"
            && parts.length === 4) {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const body = await readBody(request);
          let target;
          try {
            target = resolveGatewayTarget(
              body, options.auth!.personalModels(viewer.username), undefined);
          } catch (error) {
            if (error instanceof GatewayCheckError) {
              return json(response, 400, { error: error.message });
            }
            throw error;
          }
          return json(response, 200, await checkModelGateway(target));
        }
        if (request.method === "POST" && parts[1] === "logout") {
          options.auth?.endSession(sessionToken);
          response.setHeader("set-cookie", sessionCookie("", request, true));
          return json(response, 200, { ok: true });
        }
        // 协作界面需要把账号翻译成人名。只读这两个公开身份字段;角色、
        // 权限与个人配置仍只在管理员账号接口里出现。免登录允许清单
        // (ADR-0069):匿名可读——工号→姓名是协作界面的公开参考数据。
        if (request.method === "GET" && parts[1] === "people"
            && parts.length === 2) {
          return json(response, 200, (options.auth?.listUsers() ?? [])
            .map(({ username, display_name }) => ({
              username,
              ...(display_name ? { display_name } : {}),
            })));
        }
        if (parts[1] === "users") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          if (viewer.role !== "admin") {
            return json(response, 403, { error: "只有管理员可以管理账号" });
          }
          if (request.method === "GET" && parts.length === 2) {
            return json(response, 200, options.auth?.listUsers() ?? []);
          }
          if (request.method === "POST" && parts.length === 2) {
            const body = await readBody(request);
            try {
              const user = options.auth!.createUser(
                String(body.username ?? ""),
                String(body.password ?? ""),
                String(body.role ?? "developer") as "admin" | "developer",
                body.display_name === undefined
                  ? undefined : String(body.display_name),
              );
              return json(response, 201, user);
            } catch (error) {
              return json(response, 400, { error: humanError(error) });
            }
          }
          if (request.method === "PUT" && parts.length === 4
              && parts[3] === "committer") {
            const body = await readBody(request);
            try {
              const user = options.auth!.setCommitter(
                decodeURIComponent(parts[2]), body.on === true);
              return json(response, 200, user);
            } catch (error) {
              return json(response, 400, { error: humanError(error) });
            }
          }
          // (自动接单开关已迁入个人设置:PUT /auth/me/issue-auto-claim,
          // ADR-0061 2026-10-10 修订——按人代开名单制退役。)
          if (request.method === "PUT" && parts.length === 4
              && parts[3] === "display-name") {
            const body = await readBody(request);
            try {
              const user = options.auth!.setDisplayName(
                decodeURIComponent(parts[2]),
                body.display_name === undefined
                  ? undefined : String(body.display_name));
              return json(response, 200, user);
            } catch (error) {
              return json(response, 400, { error: humanError(error) });
            }
          }
          // 内部平台的管理员特权(用户拍板:内网自用,不要自助找回那
          // 套):改密码不验旧密码;删号即物理删除。守自己的两条底线
          // (删自己/删最后一个管理员)在 LocalAuth 里,这儿只递操作人。
          if (request.method === "PUT" && parts.length === 4
              && parts[3] === "password") {
            const body = await readBody(request);
            try {
              options.auth!.resetPassword(
                decodeURIComponent(parts[2]), String(body.password ?? ""));
              return json(response, 200, { ok: true });
            } catch (error) {
              return json(response, 400, { error: humanError(error) });
            }
          }
          if (request.method === "DELETE" && parts.length === 3) {
            try {
              options.auth!.deleteUser(
                decodeURIComponent(parts[2]), viewer.username);
              return json(response, 200, { ok: true });
            } catch (error) {
              return json(response, 400, { error: humanError(error) });
            }
          }
        }
        // Committer 名单不是账号管理能力：登录开发需要读取它，才能主动
        // 选择检视人；只有上面的管理员接口可以改名单。
        if (request.method === "GET" && parts[1] === "committers") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          return json(response, 200,
            options.auth?.listUsers().filter((user) => user.committer) ?? []);
        }
        // 跨仓分工候选：所有登录者都可读，但只给“是否就绪+缺项”，
        // 不给 token hint、邮箱或管理员账号。服务形态决定哪些配置必需;
        // ?flow=issue 是问题登记指派的固定映射(ADR-0031):只认 Git
        // 令牌+署名邮箱,不问小鲁班令牌——问题通知是旁路,不因缺通知
        // 令牌挡指派。映射钉死在服务端,客户端只点名场景,不递需求。
        if (request.method === "GET" && parts[1] === "collaboration-assignees") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          const issueNeeds = new URL(request.url ?? "", "http://x")
            .searchParams.get("flow") === "issue";
          return json(response, 200, options.auth?.collaborationAssignees(
            issueNeeds
              ? { git_token: true, luban_token: false }
              : service.launchOptions().needs) ?? []);
        }
        return json(response, 404, { error: "未知身份接口" });
      }

      // 管理页服务设置:运行参数与模型网关。仓库/平台/端口等部署形态
      // 不在这儿——由启动配置固定注入，管理员只看自检结果。
      // 密钥只写不读:GET 永远给掩码,PUT 不给的键保持不动。
      if (parts[0] === "settings") {
        if (options.auth) {
          if (!viewer) return json(response, 401, { error: "请先登录" });
          if (viewer.role !== "admin") {
            return json(response, 403, { error: "只有管理员可以改服务设置" });
          }
        }
        if (request.method === "GET" && parts[1] === "check") {
          return json(response, 200, await service.systemCheck());
        }
        const settings = service.options.settings;
        if (!settings) {
          return json(response, 404, { error: "本部署未接运行时设置" });
        }
        const settingsView = () => {
          const providers = (service.options.modelsJson as {
            providers?: Record<string, any>;
          }).providers ?? {};
          const provider = service.options.provider || Object.keys(providers)[0];
          const modelSpec = providers[provider] ?? {};
          const model = service.options.model
            || String(modelSpec.models?.[0]?.id ?? "");
          const visionChoice = service.options.vision;
          const visionSpec = visionChoice
            ? providers[visionChoice.provider] ?? {} : {};
          return ({
            ...settings.view(),
            execution_playbooks: service.launchOptions().execution_playbooks,
            defaults: {
              runtime: {
                max_concurrent: service.options.maxConcurrent ?? 2,
                // 问题流回合并发缺省(--issue-max-turns);实际生效值
                // 还可能被管理页运行时旋钮 issue_max_turns 覆盖,
                // 与 max_concurrent 同一展示口径:这里只给部署层缺省。
                issue_max_turns: options.issueFlow?.options.maxConcurrentTurns
                  ?? 10,
                issue_compact_every_events: 0, // 旧客户端兼容，容量管理已自动化
                // 终态现场回收缺省开(磁盘治理票 01),管理页旋钮
                // issue_repo_reclaim 可关;可再生编译产物默认闲置 24h 后清理。
                // 缺省值从 service 导入,两处不许漂移。
                issue_repo_reclaim: ISSUE_REPO_RECLAIM_DEFAULT,
                issue_warmup_enabled: ISSUE_WARMUP_ENABLED_DEFAULT,
                issue_build_products_cooldown_hours:
                  ISSUE_BUILD_PRODUCTS_COOLDOWN_HOURS_DEFAULT,
                // 守闸器阈值缺省(#248):与 service 旋钮同源,两处不漂移。
                env_verify_watchdog_minutes:
                  ENV_VERIFY_WATCHDOG_MINUTES_DEFAULT,
                // 自动接单扫描间隔缺省(ADR-0061):与调度器同源常量,
                // 缺省半小时,0=关(总开关)。
                issue_auto_claim_interval_s: DEFAULT_ISSUE_AUTO_CLAIM_INTERVAL_S,
                repair_rounds: service.options.delivery?.repairRounds ?? null,
                poll_interval_s:
                  (service.options.delivery?.pollIntervalMs ?? 30_000) / 1000,
                poll_timeout_s:
                  (service.options.delivery?.pollTimeoutMs ?? 30 * 60_000) / 1000,
                workspace_retention_days:
                  service.options.workspaceRetentionDays
                    ?? DEFAULT_WORKSPACE_RETENTION_DAYS,
                build_cache_retention_days:
                  service.options.buildCacheRetentionDays
                    ?? DEFAULT_BUILD_CACHE_RETENTION_DAYS,
                build_cache_max_gb:
                  service.options.buildCacheMaxGb
                    ?? DEFAULT_BUILD_CACHE_MAX_GB,
              },
              models: {
                configured: !!modelSpec.baseUrl && !!modelSpec.apiKey && !!model,
                url: modelSpec.baseUrl ? String(modelSpec.baseUrl) : undefined,
                model: model || undefined,
                // 协议随默认配置一并下发:健康检查必须按部署真实协议
                // 测,不能 UI 默认 openai、部署实际 anthropic——同一份
                // 配置一边假绿一边假红(MFC-011)。
                api: modelSpec.api === "anthropic-messages"
                  ? "anthropic-messages" : "openai-completions",
                vision: {
                  configured: !!visionChoice?.model && !!visionSpec.baseUrl
                    && !!visionSpec.apiKey,
                  provider: visionChoice?.provider,
                  model: visionChoice?.model,
                  url: visionSpec.baseUrl
                    ? String(visionSpec.baseUrl) : undefined,
                  api: visionSpec.api ? String(visionSpec.api) : undefined,
                },
              },
            },
          });
        };
        try {
          if (request.method === "GET" && parts.length === 1) {
            return json(response, 200, settingsView());
          }
          if (request.method === "GET" && parts[1] === "build-cache") {
            return json(response, 200, await service.buildCacheStatus());
          }
          if (request.method === "POST" && parts[1] === "build-cache"
              && parts[2] === "reclaim") {
            const body = await readBody(request);
            return json(response, 200, await service.reclaimIdleBuildCaches({
              allUnused: body.all_unused === true,
            }));
          }
          if (request.method === "PUT" && parts[1] === "runtime") {
            settings.updateRuntime(await readBody(request));
            return json(response, 200, settingsView());
          }
          if (request.method === "PUT" && parts[1] === "execution-policy") {
            const body = await readBody(request);
            // 团队阶段勾选定制(stage_customizations)已随 v1 退役:
            // 想定制阶段结构请建团队工作流资产;这里只剩文字约定。
            if ("stage_customizations" in body) {
              return json(response, 400, {
                error: "团队阶段执行方案已退役,请改用团队工作流资产做结构化定制",
              });
            }
            settings.updateExecutionPolicy(body);
            return json(response, 200, settingsView());
          }
          if (request.method === "PUT" && parts[1] === "models") {
            settings.updateModels(await readBody(request));
            return json(response, 200, settingsView());
          }
          // 模型网关连通性测试:表单草稿优先,留空回落已存配置/部署
          // 默认(密钥"留空=沿用"与保存同口径)。与部署自检的分工:
          // 自检只读不外发;这里管理员主动发起一次真实外发请求。
          if (request.method === "POST" && parts[1] === "models"
              && parts[2] === "check") {
            const body = await readBody(request);
            const target = resolveGatewayTarget(body, settings.models(),
              service.options.modelsJson as Record<string, unknown> | undefined);
            return json(response, 200, await checkModelGateway(target));
          }
          if (request.method === "PUT" && parts[1] === "vision") {
            const body = await readBody(request);
            settings.updateVision({
              ...(body as Record<string, unknown>),
              base_json: service.options.modelsJson,
              base_vision: service.options.vision,
            });
            return json(response, 200, settingsView());
          }
          if (request.method === "POST" && parts[1] === "vision"
              && parts[2] === "test") {
            return json(response, 200, await service.testVisionCapability());
          }
        } catch (error) {
          if (error instanceof SettingsError
              || error instanceof GatewayCheckError) {
            return json(response, 400, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知设置接口" });
      }

      // MCP 网关健康检查(GET /mcp-health):握手 + tools/list,一次
      // 验证连通性、token 有效性与工具清单(inputSchema 原样带回——
      // 华为网关 arg0/arg1 的参数映射就靠它对拍)。无鉴权:探活端点
      // 只暴露工具名与 schema,不含 token 也不含单据数据。网关没配
      // 返回 200+ok:false(服务活着,MCP 未启用不是故障);连不上才 502。
      if (request.method === "GET" && url.pathname === "/mcp-health") {
        if (!options.mcpGateway) {
          return json(response, 200, {
            ok: false,
            error: "MCP 网关未配置(需 --dts-mcp-url 与 --mcp-token-file)",
          });
        }
        const result = await options.mcpGateway.healthCheck();
        return json(response, result.ok ? 200 : 502, result);
      }

      // 问题流 API(/issues/*):独立于任务命名空间;未启用时由路由
      // 自己 404。必须先于静态托管兜底(非 /tasks 的 GET 会被接管)。
      if (parts[0] === "issues" || parts[0] === "pipeline-repairs") {
        // 自动接单下次发起时刻(ADR-0061 修订):个人设置问号悬停卡的
        // 数据源。调度器未装配(测试/旁路形态)或间隔为 0 时为 null,
        // 前端显示「已暂停」。GET 且两级路径,若放行会给 SPA 深链,先截。
        if (request.method === "GET" && parts[1] === "auto-claim"
            && parts.length === 2) {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          // 间隔改 0 后旧定时器要到点才重排,窗口期内排程时刻是陈旧的
          // ——暂停口径以当前旋钮为准,现读现判。
          const intervalSeconds = service.options.settings?.runtime()
            .issue_auto_claim_interval_s;
          return json(response, 200, {
            next_run_at: intervalSeconds === 0
              ? null : autoClaimNextRunAt(),
          });
        }
        // GET /issues 与 /issues/:id 既是 API 也是问题工作台的深链地址
        // (裸 /issues=登记页,带 id=会话工作台;小鲁班通知点开即达)。
        // 与 /tasks/:id 的旧通知兼容同一判别式:浏览器导航(Accept 要
        // text/html)让给前端 SPA,程序 fetch(默认 Accept: */*)照旧拿
        // JSON,API 契约零变化。
        const issuePage = request.method === "GET"
          && parts.length <= 2
          && String(request.headers.accept ?? "").includes("text/html");
        if (!issuePage) {
          const handled = await handleIssueRoutes(request, response, parts, {
            issueFlow: parts[0] === "pipeline-repairs" ? options.pipelineRepairs : options.issueFlow,
            managedMr: url => service.list().some(task => !["completed", "failed", "canceled"].includes(task.status)
              && task.delivery?.mr_url === url) ? "这个 MR 正由需求任务管理，请在原任务处理"
              : options.issueFlow?.list().some(issue => !["archived", "canceled", "failed"].includes(issue.status)
                && issue.mrs?.some(mr => mr.url === url)) ? "这个 MR 正由问题会话处理，请在原会话继续" : undefined,
            dts: options.dts,
            viewer: viewer ?? undefined,
            authEnabled: Boolean(options.auth),
            log: options.log,
          });
          if (handled) return;
        }
      }

      // 环境管理 API(/environments/*,票 #149,ADR-0020):全局台账,
      // 登录即可读写(admin 同样可管理,不做归属闸与角色 403);未启用
      // 时由路由自己 404。必须先于静态托管兜底(非 /tasks 的 GET 会被
      // 接管);GET /environments 同时是页签深链地址,浏览器导航(Accept
      // 要 text/html)让给前端 SPA,与 /issues/:id 的判别式同款。
      if (parts[0] === "environments") {
        const envPage = request.method === "GET"
          && parts.length === 1
          && String(request.headers.accept ?? "").includes("text/html");
        if (!envPage) {
          const handled = await handleEnvironmentRoutes(request, response, parts, {
            registry: getEnvironmentRegistry(),
            viewer: viewer ?? undefined,
            authEnabled: Boolean(options.auth),
          });
          if (handled) return;
        }
      }

      // 部署版本号:任何页面加载时可查(无需登录),用于确认部署生效。
      if (request.method === "GET" && url.pathname === "/build-info") {
        return json(response, 200, { build_hash: options.buildHash ?? null });
      }

      // PlantUML 出图:参考实现在服务端跑(vendor 里的 jar + 宿主 JDK),
      // 前端只显示 SVG。出不了图返回原因,页面原样显示源码(旁路 fail-open)。
      if (request.method === "POST" && url.pathname === "/diagrams/plantuml") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        const body = await readBody(request, PLANTUML_SOURCE_LIMIT + 4096);
        const rendered = await renderPlantUml(String(body?.source ?? ""), {
          cacheDir: join(service.options.dataDir, "diagram-cache"),
        });
        return json(response, 200, rendered);
      }

      // 下单表单的数据源:模型清单与当前默认。登录即可看(不是密钥,
      // 只有名字);选项从当前生效的 models.json 来,设置层热改即时反映。
      // 必须先于静态托管兜底(和 /history 一样,非 /tasks 的 GET 会被接管)。
      if (request.method === "GET" && url.pathname === "/launch-options") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        // 表单展示的"这单会用谁跑"按登录人解析:配了个人网关的成员
        // 显示其个人网关(ADR-0068);无认证部署 viewer 缺席=平台口径。
        const launch = service.launchOptions(viewer?.username);
        return json(response, 200, {
          ...launch,
          blockers: [...launch.blockers, ...personalBlockers(viewer)],
        });
      }

      if (request.method === "GET" && url.pathname === "/repository-resource-policy") {
        if (options.auth && !viewer) return json(response, 401, { error: "请先登录" });
        return json(response, 200, { rules: readResourceBlocks(service.options.dataDir) });
      }

      // 仓库 Skill 目录属于下单前的显式只读动作：用户填好仓和基线后
      // 才触发，服务端用本人的 Git 凭据读取；不把路径/正文交给浏览器
      // 决定。管理员没有下单入口，也不替开发者读取私仓。
      if (request.method === "POST"
          && url.pathname === "/repository-skills/scan") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        if (viewer?.role === "admin") {
          return json(response, 403, { error: "管理员不发起任务，不能读取仓内能力" });
        }
        const blockers = personalBlockers(viewer)
          .filter((item) => item.key === "git_token" || item.key === "git_email");
        if (blockers.length) {
          return json(response, 409, {
            error: "请先完成个人 CodeHub 接入，再读取私有仓库能力",
            blockers,
          });
        }
        try {
          const body = await readBody(request);
          const repositories = Array.isArray(body.repositories)
            ? body.repositories.map(String) : [];
          const baseline = body.baseline === undefined
            ? undefined : String(body.baseline);
          return json(response, 200, await service.scanRepositorySkills({
            repositories,
            baseline,
            previewBlocked: body.preview_blocked === true,
            account: viewer?.username,
          }));
        } catch (error) {
          return json(response, 400, { error: humanError(error) });
        }
      }

      // 仓库地址在下单前就做轻量可达性探测。探测使用服务端的个人
      // Git 身份，浏览器只拿“可访问/原因”，不会接触令牌或 Git 输出。
      if (request.method === "POST"
          && url.pathname === "/repositories/probe") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        try {
          const body = await readBody(request);
          const repositories = Array.isArray(body.repositories)
            ? body.repositories.map(String) : [];
          return json(response, 200, await service.probeRepositories({
            repositories,
            account: viewer?.username,
          }));
        } catch (error) {
          return json(response, 400, { error: humanError(error) });
        }
      }

      const protectedRoute =
        url.pathname === "/history" || parts[0] === "tasks"
        || url.pathname === "/launch-knowledge-preview"
        || url.pathname === "/knowledge-insights"
        || parts[0] === "delivery-analytics"
        || url.pathname.startsWith("/memory-insights")
        || parts[0] === "reviews" || parts[0] === "repository-skills"
        || parts[0] === "repositories"
        || parts[0] === "skills"
        // 免登录允许清单(ADR-0069,#566):只有模块目录的 GET 列表
        // 匿名放行(本地无头客户端的参考数据);写与逐模块操作仍闸。
        || (parts[0] === "business-modules"
          && !(request.method === "GET" && parts.length === 1))
        || parts[0] === "component-knowledge" || parts[0] === "product-versions" || parts[0] === "component-repositories" || parts[0] === "component-research"
        || ["domain-extraction", "knowledge-materials", "knowledge-extraction", "knowledge-tasks", "knowledge-review"].includes(parts[0])
        || parts[0] === "knowledge-repo"
        || parts[0] === "technology-stacks"
        || parts[0] === "repository-profiles"
        || parts[0] === "knowledge-documents"
        || parts[0] === "knowledge-answers"
        || parts[0] === "workflow-assets"
        || parts[0] === "wishes";
      // 兼容已经发出去的旧通知。/tasks/:id 是 JSON API，但旧链接若由
      // 浏览器作为页面打开，应带人去新的任务工作台；程序 fetch 默认
      // Accept: */*，仍拿原来的 JSON，不改变 API 契约。
      const legacyTaskPage = request.method === "GET"
        && parts[0] === "tasks" && parts.length === 2
        && String(request.headers.accept ?? "").includes("text/html");
      if (legacyTaskPage) {
        response.writeHead(302, {
          location: `/work/${encodeURIComponent(decodeURIComponent(parts[1]))}`,
          "cache-control": "no-store",
        });
        return response.end();
      }
      if (options.auth && protectedRoute && !viewer) {
        return json(response, 401, { error: "请先登录" });
      }

      // 历史读侧(§11):任务摘要投影来自 PG,跨进程生命周期。
      // 必须先于静态托管兜底判定——非 /tasks 前缀的 GET 会被它接管。
      if (request.method === "GET" && url.pathname === "/history") {
        const projection = service.options.projection;
        if (!projection) {
          return json(response, 404,
            { error: "未配置 PostgreSQL 投影(--pg),没有历史可查" });
        }
        return json(response, 200, await projection.listTaskHistory());
      }
      // 团队知识运营同样先于静态前端兜底；否则这个非 /tasks 的 GET
      // 会被当成前端资源并返回 404。只读口径与团队任务可见性一致。
      if (request.method === "GET" && url.pathname === "/knowledge-insights") {
        return json(response, 200, service.knowledgeInsights());
      }
      if (request.method === "GET" && url.pathname === "/delivery-analytics") {
        const report = service.deliveryAnalysis(url.searchParams.get("refresh") === "1");
        return json(response, 200, report.improvement_policy ? { ...report, improvement_policy: { ...report.improvement_policy, can_configure: !options.auth || viewer?.role === "admin" } } : report);
      }
      if (request.method === "PUT" && url.pathname === "/delivery-analytics/improvement-policy") {
        if (options.auth && viewer?.role !== "admin") return json(response, 403, { error: "只有管理员可以修改自动分析设置" });
        try { return json(response, 200, service.improvementPolicy(await readBody(request))); }
        catch (error) { return json(response, 400, { error: humanError(error) }); }
      }
      // 登录成员共同维护经验；修改只影响知识复用，不授予任务操作权限。
      if (parts[0] === "memory-insights") {
        const store = new MemoryStore(service.options.dataDir);
        const mid = parts[1] ? decodeURIComponent(parts[1]) : undefined;
        const actor = viewer?.username ?? "本地用户";
        if (request.method === "POST") {
          try {
            const body = await readBody(request);
            if (!mid) {
              const record = store.record({ source: "user_note", judged_by: "human", scope: "platform",
                repo: "_platform", task: "", paths: [], evidence: "manual", author: actor,
                trigger: String(body.trigger ?? ""), conclusion: String(body.conclusion ?? "") });
              return json(response, 201, record);
            }
            if (parts.length === 3 && parts[2] === "review") {
              if (body.module && body.module !== store.find(mid)?.module) {
                const module = readBusinessModule(service.options.dataDir, String(body.module));
                if (module.status !== "active") return json(response, 400, { error: "请选择配置中心中有效的业务模块" });
              }
              return json(response, 200, store.review(mid, actor, body));
            }
          } catch (error) { return json(response, 400, { error: humanError(error) }); }
        }
        if (request.method === "GET" && !mid) {
          const insights = service.memoryInsights();
          return json(response, 200, { ...insights, memories: insights.memories.map(row => ({ ...row, can_review: true })) });
        }
        if (request.method === "GET" && mid && parts[2] === "history") return json(response, 200, store.history(mid));
        if (request.method === "GET" && mid) {
          const found = service.readMemoryInsight(mid);
          return found ? json(response, 200, { ...found, record: { ...found.record, can_review: true } })
            : json(response, 404, { error: "这条记忆不存在" });
        }
      }
      // 发起页权威知识预匹配：只回元数据与固定身份，不分配 task id、
      // 不写任务现场。保存的工作流选择必须在服务端解析已发布版本，
      // 浏览器不能自报它引用了哪些知识来影响自动匹配。
      if (request.method === "POST"
          && url.pathname === "/launch-knowledge-preview") {
        try {
          const body = await readBody(request);
          let workflowDefinition = body.workflow_definition;
          const workflowSelection = body.workflow_selection
              && typeof body.workflow_selection === "object"
            ? body.workflow_selection as Record<string, unknown> : undefined;
          if (workflowSelection && workflowDefinition !== undefined) {
            return json(response, 400, {
              error: "工作流方案选择与本任务临时定制不能同时提交",
            });
          }
          if (workflowSelection) {
            const id = String(workflowSelection.id ?? "").trim();
            const detail = getWorkflowAssets().get(id);
            const operator = viewer?.username ?? "本地部署";
            if (!canViewWorkflow(detail.asset, operator)
                || !detail.asset.selectable_for_tasks) {
              return json(response, 409, {
                error: "所选工作流方案不可用、未发布或已归档，请重新选择",
              });
            }
            const rawVersion = workflowSelection.version;
            const version = rawVersion == null || rawVersion === ""
              ? undefined : Number(String(rawVersion).replace(/^v/, ""));
            if (version !== undefined
                && (!Number.isInteger(version) || version < 1)) {
              return json(response, 400, { error: "工作流方案版本不合法" });
            }
            const published = getWorkflowAssets().getPublished(id, version);
            requireTechnologyStacks(service.options.dataDir, published.definition.applicability.technologies);
            workflowDefinition = published.definition;
          }
          const repositories = Array.isArray(body.repos)
            ? body.repos.map(String)
            : Array.isArray(body.repositories)
              ? body.repositories.map(String)
              : body.repo === undefined ? [] : [String(body.repo)];
          const repositoryProfiles = Array.isArray(body.repository_profiles)
            ? body.repository_profiles.map((item: Record<string, unknown>) => ({
                repository: String(item.repository ?? ""),
                technologies: Array.isArray(item.technologies)
                  ? item.technologies.map(String) : [],
                confirmed: item.confirmed !== false,
              })) : undefined;
          return json(response, 200, service.previewLaunchKnowledge({
            repositories,
            selectedBusinessModuleIds:
              Array.isArray(body.selected_business_module_ids)
                ? body.selected_business_module_ids.map(String) : undefined,
            selectedHostSkillPaths:
              Array.isArray(body.selected_host_skill_paths)
                ? body.selected_host_skill_paths.map(String) : undefined,
            repositoryProfiles,
            workflowDefinition,
          }));
        } catch (error) {
          return json(response, 400, { error: humanError(error) });
        }
      }
      if (parts[0] === "repository-profiles") {
        const operator = viewer?.username ?? "本地部署";
        try {
          if (request.method === "POST" && parts[1] === "resolve") {
            const body = await readBody(request);
            return json(response, 200, { repositories: resolveRepositoryProfiles(
              service.options.dataDir,
              Array.isArray(body.repositories)
                ? body.repositories.map(String) : [],
            ) });
          }
          if (request.method === "PUT" && parts.length === 1) {
            const body = await readBody(request);
            return json(response, 200, saveRepositoryProfile(
              service.options.dataDir, {
                repository: String(body.repository ?? ""),
                technologies: Array.isArray(body.technologies)
                  ? body.technologies.map(String) : [],
                confirmed: body.confirmed !== false,
              }, operator));
          }
        } catch (error) {
          if (error instanceof RepositoryProfileError) {
            return json(response, 400, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知仓库技术画像接口" });
      }
      if (parts[0] === "knowledge-tasks" && request.method === "GET" && parts.length === 1) {
        const summaryOnly = url.searchParams.get("summary") === "1";
        if (summaryOnly && knowledgeTaskSummary && Date.now() - knowledgeTaskSummary.at < 10_000) {
          return json(response, 200, { summary: knowledgeTaskSummary.summary });
        }
        const data = listKnowledgeTasks({ dataDir: service.options.dataDir,
          domain: service.getDomainKnowledgeExtraction(), component: service.getComponentResearch(),
          skillExtractionJob: id => service.skillExtractionJob(id), warnings: () => service.knowledgeRecordWarnings() });
        knowledgeTaskSummary = { at: Date.now(), summary: data.summary };
        return json(response, 200, summaryOnly ? { summary: data.summary } : data);
      }
      if (parts[0] === "knowledge-review") {
        const sources = { dataDir: service.options.dataDir, domain: service.getDomainKnowledgeExtraction(), component: service.getComponentResearch() };
        const kind = parts[1] as KnowledgeReviewKind, id = decodeURIComponent(parts[2] ?? "");
        try {
          if (request.method === "GET" && parts.length === 3) return json(response, 200, listKnowledgeReviewNotes(sources, kind, id));
          if (request.method === "POST" && parts.length === 3) return json(response, 200, saveKnowledgeReviewNote(sources, kind, id, await readBody(request) as unknown as KnowledgeReviewNoteInput, viewer?.username ?? "本地部署"));
          if (request.method === "POST" && parts.length === 4 && parts[3] === "apply") return json(response, 202, applyKnowledgeReviewNotes(sources, kind, id, await readBody(request) as { note_ids: string[] }, viewer?.username ?? "本地部署"));
          if (request.method === "POST" && parts.length === 4 && parts[3] === "resolve") return json(response, 200, resolveKnowledgeReviewNotes(sources, kind, id, await readBody(request) as { note_ids: string[] }, viewer?.username ?? "本地部署"));
          return json(response, 404, { error: "未知知识审阅接口" });
        } catch (error) { return json(response, 400, { error: (error as Error).message }); }
      }
      if (parts[0] === "component-knowledge") return componentKnowledgeRoute(request, response, parts, service, viewer?.username ?? "本地部署", readBody, json);
      if (["component-repositories", "component-research"].includes(parts[0])) return componentResearchRoute(request, response, parts, service, viewer?.username ?? "本地部署", readBody, json);
      if (["domain-extraction", "knowledge-materials"].includes(parts[0])) return domainKnowledgeRoute(request, response, parts, service,
        viewer?.username ?? "本地部署", readBody, json);
      if (parts[0] === "knowledge-extraction") return extractionConfigurationRoute(request, response, parts, service.options.dataDir,
        viewer?.username ?? "本地部署", readBody, json);
      if (parts[0] === "knowledge-documents") return knowledgeDocumentRoute(request, response, parts, service, viewer?.username ?? "本地部署", readBody, json);
      if (parts[0] === "knowledge-answers") return knowledgeAnswerRoute(request, response, parts,
        options.knowledgeAnswers ?? service.getKnowledgeAnswers(), service.options.dataDir, viewer?.username ?? "本地部署", readBody, json, service.getKnowledgeSearch());
      // 许愿墙是团队公共入口，但不是公共互联网资源：正文和截图都要求
      // 登录。每个人可发布、点赞和移除自己的内容；管理员负责明确接纳
      // 与闭环，拒绝必须说明原因。
      if (parts[0] === "wishes") {
        const operator = viewer?.username ?? "本地用户";
        const admin = !options.auth || viewer?.role === "admin";
        const present = (record: WishRecord) => {
          const { voters, images, ...rest } = record;
          return {
            ...rest,
            images: images.map((image) => ({
              ...image,
              url: `/wishes/images/${encodeURIComponent(image.id)}`,
            })),
            votes: voters.length,
            viewer_voted: voters.includes(operator),
            can_delete: admin || record.author === operator,
            can_manage: admin,
          };
        };
        try {
          if (request.method === "GET" && parts.length === 1) {
            return json(response, 200,
              { wishes: getWishWall().list().map(present) });
          }
          if (request.method === "POST" && parts.length === 1) {
            // 4 * 5 MB 图片经 Base64 后约 27 MB；业务总量另由 store 卡在
            // 12 MB，这里 30 MB 是传输保险丝，避免恶意正文撑爆进程。
            const body = await readBody(request, 30 * 1024 * 1024);
            return json(response, 201, present(getWishWall().create({
              kind: body.kind,
              title: body.title,
              detail: body.detail,
              images: body.images,
            }, operator)));
          }
          if (request.method === "GET" && parts.length === 3
              && parts[1] === "images") {
            const image = getWishWall().readImage(decodeURIComponent(parts[2]));
            response.writeHead(200, {
              "content-type": image.mime_type,
              "content-length": image.data.length,
              "content-disposition": "inline",
              "x-content-type-options": "nosniff",
              "cache-control": "private, max-age=86400",
            });
            return response.end(image.data);
          }
          if (request.method === "POST" && parts.length === 3
              && parts[2] === "vote") {
            const body = await readBody(request);
            return json(response, 200, present(getWishWall().setVote(
              decodeURIComponent(parts[1]), operator, Boolean(body.voted))));
          }
          if (request.method === "PATCH" && parts.length === 3
              && parts[2] === "status") {
            if (!admin) {
              return json(response, 403,
                { error: "只有管理员可以接纳、暂不接纳或闭环" });
            }
            const body = await readBody(request);
            return json(response, 200, present(getWishWall().setStatus(
              decodeURIComponent(parts[1]), String(body.status) as WishStatus,
              operator, body.note)));
          }
          if (request.method === "DELETE" && parts.length === 2) {
            getWishWall().delete(decodeURIComponent(parts[1]), operator, admin);
            return json(response, 200, { ok: true });
          }
        } catch (error) {
          if (error instanceof WishWallNotFoundError) {
            return json(response, 404, { error: error.message });
          }
          if (error instanceof WishWallPermissionError) {
            return json(response, 403, { error: error.message });
          }
          if (error instanceof WishWallError) {
            return json(response, 400, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知许愿墙接口" });
      }
      // 配置中心与环境台账一样，由所有已登录成员维护。
      if (parts[0] === "technology-stacks") {
        try {
          const dataDir = service.options.dataDir;
          const operator = viewer?.username ?? "本地部署";
          if (request.method === "GET" && parts.length === 1) {
            return json(response, 200, { stacks: listTechnologyStacks(dataDir) });
          }
          if (request.method === "POST" && parts.length === 1) {
            return json(response, 201, { stack: createTechnologyStack(dataDir, await readBody(request), operator) });
          }
          if (request.method === "PUT" && parts.length === 2) {
            return json(response, 200, { stack: updateTechnologyStack(dataDir, decodeURIComponent(parts[1]), await readBody(request), operator) });
          }
          if (request.method === "DELETE" && parts.length === 2) {
            await deleteTechnologyStack(dataDir, decodeURIComponent(parts[1]), operator);
            return json(response, 200, { ok: true });
          }
          return json(response, 405, { error: "不支持的技术栈配置操作" });
        } catch (error) { return json(response, 400, { error: humanError(error) }); }
      }

      if (parts[0] === "product-versions") {
        try {
          const dataDir = service.options.dataDir;
          if (request.method === "GET" && parts.length === 1) {
            return json(response, 200, { versions: listProductVersions(dataDir) });
          }
          if ((request.method === "POST" && parts.length === 1)
              || (request.method === "PUT" && parts.length === 2)) {
            const body = await readBody(request);
            return json(response, request.method === "POST" ? 201 : 200,
              saveProductVersion(dataDir, { version: body.version, branch: body.branch,
                id: parts.length === 2 ? decodeURIComponent(parts[1]) : undefined,
                // 参与自动接单标记(ADR-0061):缺席=沿用已存值(服务端
                // 口径),老客户端编辑版本名不悄悄改勾选。
                auto_claim: body.auto_claim === undefined
                  ? undefined : body.auto_claim === true }));
          }
          if (request.method === "DELETE" && parts.length === 2) {
            deleteProductVersion(dataDir, decodeURIComponent(parts[1]));
            return json(response, 200, { ok: true });
          }
          return json(response, 405, { error: "不支持的配置操作" });
        } catch (error) { return json(response, 400, { error: humanError(error) }); }
      }

      // 知识仓(#286,ADR-0033):配置中心唯一的管理员专属页签——强制
      // 全局影响所有人的所有会话,是运营决策不是团队协作资产,读写都过
      // admin 闸(非管理员 403:前端页签本就不渲染,这是直连 API 的兜闸)。
      if (parts[0] === "knowledge-repo") {
        const admin = !options.auth || viewer?.role === "admin";
        if (!admin) {
          return json(response, 403, { error: "知识仓配置仅管理员可维护" });
        }
        const dataDir = service.options.dataDir;
        try {
          if (request.method === "GET" && parts.length === 1) {
            return json(response, 200,
              { config: readKnowledgeRepoConfig(dataDir) ?? null });
          }
          if (request.method === "PUT" && parts.length === 1) {
            const body = await readBody(request);
            return json(response, 200,
              { config: saveKnowledgeRepoConfig(dataDir, body.url, { branch: body.branch, docs_path: body.docs_path }) });
          }
          if (request.method === "DELETE" && parts.length === 1) {
            clearKnowledgeRepoConfig(dataDir);
            return json(response, 200, { ok: true });
          }
          return json(response, 405, { error: "不支持的配置操作" });
        } catch (error) { return json(response, 400, { error: humanError(error) }); }
      }

      // 业务模块统一保存仓库映射和领域知识读写目录；知识页不另存一份设置。
      // 旧 Owner 字段仅保留历史元数据，不承担权限判定。
      if (parts[0] === "business-modules") {
        const dataDir = service.options.dataDir;
        const operator = viewer?.username ?? "本地部署";
        const admin = !options.auth || viewer?.role === "admin";
        const existingUsers = () => new Set(
          options.auth?.listUsers().map((user) => user.username) ?? [operator]);
        const assertMembers = (owner: string, maintainers: string[]) => {
          if (!options.auth) return;
          const users = existingUsers();
          for (const username of [owner, ...maintainers]) {
            if (!users.has(username)) {
              throw new BusinessModuleError(`账号 ${username} 不存在`);
            }
          }
        };
        const view = (module: ReturnType<typeof readBusinessModule>) => ({
          ...module,
          knowledge_location: resolveModuleKnowledgeLocation(dataDir, module.id),
          can_manage: canManageBusinessModule(
            module, viewer?.username, admin),
        });
        try {
          if (request.method === "GET" && parts.length === 1) {
            const catalog = listBusinessModules(dataDir);
            return json(response, 200, {
              ...catalog,
              modules: catalog.modules.map(view),
            });
          }
          if (request.method === "POST" && parts.length === 1) {
            const body = await readBody(request);
            const owner = String(body.owner ?? viewer?.username ?? "local");
            const maintainers = Array.isArray(body.maintainers)
              ? body.maintainers.map(String) : [];
            assertMembers(owner, maintainers);
            const created = createBusinessModule(dataDir, {
              id: String(body.id ?? `module-${randomUUID()}`),
              name: String(body.name ?? ""),
              description: String(body.description ?? ""),
              owner,
              maintainers,
              repositories: Array.isArray(body.repositories)
                ? body.repositories.map(String) : [],
              mr_participants: body.mr_participants,
              knowledge_path: body.knowledge_path,
              knowledge_location: body.knowledge_location,
              reference_component_repos: Array.isArray(
                body.reference_component_repos)
                ? body.reference_component_repos.map(String) : [],
            }, operator);
            if (resolveModuleKnowledgeLocation(dataDir, created.id)) service.startModuleKnowledgeSync(created.id, operator);
            return json(response, 201, view(created));
          }
          if (parts.length === 3 && parts[2] === "knowledge-scope") {
            const moduleId = decodeURIComponent(parts[1]);
            const scopeView = () => {
              const module = readBusinessModule(dataDir, moduleId);
              if (module.id !== moduleId || module.status !== "active") throw new BusinessModuleError("模块已迁移或停用，请刷新列表");
              return { module_revision: module.revision,
                repositories: listModuleRepositoryKnowledgePaths(dataDir, moduleId).map(entry => {
                  const excluded_paths = module.repository_knowledge_exclusions?.find(item =>
                    repositoryIdentity(item.repository) === repositoryIdentity(entry.repository))?.paths ?? [];
                  return { ...entry, excluded_paths };
                }) };
            };
            response.setHeader("Cache-Control", "no-store");
            if (request.method === "GET") return json(response, 200, scopeView());
            if (request.method === "PUT") {
              const body = await readBody(request, 512 * 1024);
              if (!body || typeof body !== "object" || Array.isArray(body)) throw new BusinessModuleError("文档筛选格式不正确");
              const current = readBusinessModule(dataDir, moduleId);
              if (!canManageBusinessModule(current, viewer?.username, admin)) return json(response, 403, { error: "请登录后修改知识文档筛选" });
              if (current.id !== moduleId || current.status !== "active") throw new BusinessModuleError("模块已迁移或停用，请刷新列表");
              if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision !== current.revision) {
                return json(response, 409, { error: "模块配置已变化，请重新打开筛选后保存" });
              }
              if (!Array.isArray(body.repositories) || body.repositories.some((entry: any) =>
                !entry || typeof entry.repository !== "string" || !Array.isArray(entry.excluded_paths))) {
                throw new BusinessModuleError("请按关联代码仓保存文档筛选");
              }
              updateBusinessModule(dataDir, moduleId, { repository_knowledge_exclusions: body.repositories.map((entry: any) =>
                ({ repository: entry.repository, paths: entry.excluded_paths })) }, operator);
              service.prepareKnowledgeIndex();
              return json(response, 200, scopeView());
            }
          }
          if (parts.length === 3 && ["knowledge-location", "knowledge-sync"].includes(parts[2])) {
            const moduleId = decodeURIComponent(parts[1]);
            const current = readBusinessModule(dataDir, moduleId);
            const locationView = () => ({ knowledge_path: readBusinessModule(dataDir, moduleId).knowledge_path, location: resolveModuleKnowledgeLocation(dataDir, moduleId),
              configured: !!resolveModuleKnowledgeLocation(dataDir, moduleId),
              module_revision: readBusinessModule(dataDir, moduleId).revision,
              sync: readModuleKnowledgeSync(dataDir, moduleId) });
            if (request.method === "GET" && parts[2] === "knowledge-location") return json(response, 200, locationView());
            if (request.method === "POST") {
              if (!canManageBusinessModule(current, viewer?.username, admin)) return json(response, 403, { error: "请登录后修改领域知识配置" });
              const body = await readBody(request, 8192);
              if (parts[2] === "knowledge-location") {
                if (body.expected_revision !== undefined && !Number.isSafeInteger(body.expected_revision)) throw new BusinessModuleError("模块配置版本无效，请刷新后重试");
                saveModuleKnowledgeLocation(dataDir, moduleId, body, operator, body.expected_revision);
              }
              if (resolveModuleKnowledgeLocation(dataDir, moduleId)) service.startModuleKnowledgeSync(moduleId, operator);
              else if (parts[2] === "knowledge-sync") throw new BusinessModuleError("请先由管理员配置平台领域知识仓库");
              return json(response, 202, parts[2] === "knowledge-location" ? locationView() : readModuleKnowledgeSync(dataDir, moduleId));
            }
          }
          if (parts.length === 3 && parts[2] === "migration") {
            const sourceId = decodeURIComponent(parts[1]);
            const source = readBusinessModule(dataDir, sourceId);
            if (request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.target_id !== "string") throw new BusinessModuleError("请选择目标模块");
              return json(response, 200, view(migrateBusinessModule(dataDir, sourceId, body.target_id, operator)));
            }
            if (request.method === "GET") {
              if (source.id !== sourceId) throw new BusinessModuleError("模块已迁移，请刷新列表");
              return json(response, 200, {
                documents: source.assets.length + listKnowledgeDocuments(dataDir).filter(doc => doc.module_ids.includes(sourceId)).length,
                extraction_tasks: service.getDomainKnowledgeExtraction().taskRows().filter(job => job.module_id === sourceId).length,
                delivery_tasks: service.businessModuleTaskCount(sourceId),
                issue_sessions: options.issueFlow?.list().filter(issue => issue.module_id === sourceId).length ?? 0,
              });
            }
          }
          if (request.method === "GET" && parts.length === 2) {
            return json(response, 200,
              view(readBusinessModule(dataDir, decodeURIComponent(parts[1]))));
          }
          if (request.method === "PUT" && parts.length === 2) {
            const current = readBusinessModule(
              dataDir, decodeURIComponent(parts[1]));
            if (!canManageBusinessModule(
                current, viewer?.username, admin)) {
              return json(response, 403,
                { error: "请登录后修改模块" });
            }
            const body = await readBody(request);
            const owner = body.owner === undefined
              ? current.owner : String(body.owner);
            const maintainers = body.maintainers === undefined
              ? current.maintainers
              : Array.isArray(body.maintainers)
                ? body.maintainers.map(String) : [];
            assertMembers(owner, maintainers);
            const updated = updateBusinessModule(
              dataDir, decodeURIComponent(parts[1]), {
                name: body.name === undefined ? undefined : String(body.name),
                description: body.description === undefined
                  ? undefined : String(body.description),
                owner,
                maintainers,
                repositories: body.repositories === undefined
                  ? undefined : Array.isArray(body.repositories)
                    ? body.repositories.map(String) : [],
                mr_participants: body.mr_participants,
                knowledge_path: body.knowledge_path,
                knowledge_location: body.knowledge_location,
                reference_component_repos:
                  body.reference_component_repos === undefined
                    ? undefined : Array.isArray(body.reference_component_repos)
                      ? body.reference_component_repos.map(String) : [],
                status: body.status === undefined
                  ? undefined : String(body.status) as "active" | "archived",
              }, operator);
            if ((body.knowledge_path !== undefined || body.knowledge_location !== undefined) && updated.status === "active" && resolveModuleKnowledgeLocation(dataDir, updated.id)) service.startModuleKnowledgeSync(updated.id, operator);
            return json(response, 200, view(updated));
          }
          if (request.method === "GET" && parts.length === 4
              && parts[2] === "assets") {
            const rawVersion = url.searchParams.get("version");
            const version = rawVersion === null ? undefined : Number(rawVersion);
            if (version !== undefined
                && (!Number.isInteger(version) || version < 1)) {
              return json(response, 400, { error: "知识版本不合法" });
            }
            return json(response, 200, readBusinessKnowledgeAsset(
              dataDir, decodeURIComponent(parts[1]),
              decodeURIComponent(parts[3]), version));
          }
          if (request.method === "PUT" && parts.length === 4
              && parts[2] === "assets") {
            const current = readBusinessModule(
              dataDir, decodeURIComponent(parts[1]));
            if (!canManageBusinessModule(
                current, viewer?.username, admin)) {
              return json(response, 403,
                { error: "请登录后发布知识" });
            }
            const body = await readBody(request);
            return json(response, 200, view(publishBusinessKnowledgeAsset(
              dataDir, decodeURIComponent(parts[1]), {
                id: decodeURIComponent(parts[3]),
                title: String(body.title ?? ""),
                summary: String(body.summary ?? ""),
                when_to_use: String(body.when_to_use ?? ""),
                form: body.form === undefined
                  ? undefined : String(body.form) as KnowledgeAssetMetadata["form"],
                repositories: body.repositories === undefined
                  ? undefined : Array.isArray(body.repositories)
                    ? body.repositories.map(String) : [],
                content: String(body.content ?? ""),
              }, operator)));
          }
          if (request.method === "DELETE" && parts.length === 4
              && parts[2] === "assets") {
            const current = readBusinessModule(
              dataDir, decodeURIComponent(parts[1]));
            if (!canManageBusinessModule(
                current, viewer?.username, admin)) {
              return json(response, 403,
                { error: "请登录后归档知识" });
            }
            return json(response, 200, view(archiveBusinessKnowledgeAsset(
              dataDir, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]), operator)));
          }
        } catch (error) {
          if (error instanceof BusinessModuleError) {
            return json(response, 400, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知业务模块接口" });
      }
      // 定向知识提取(登录即可发起):从参考仓读出一份 SKILL.md 草稿,
      // 回填提交表单由人编辑;上架仍走 /skills 的提交/审核闸,这里只是
      // 起草。克隆用发起人自己的 git 凭据——他没权限看的仓,平台也不
      // 替他看。GET 需先于静态托管兜底。
      if (parts[0] === "knowledge" && parts[1] === "skill-extract") {
        if (options.auth && !viewer) {
          return json(response, 401, { error: "请先登录" });
        }
        const operator = viewer?.username ?? "本地部署";
        try {
          if (request.method === "POST" && parts.length === 2) {
            const body = await readBody(request);
            const metadata = body.nature ? skillMetadataFromBody(service.options.dataDir, body) : undefined;
            if (metadata) requireTechnologyStacks(service.options.dataDir, metadata.technologies);
            const job = service.startSkillExtraction({
              repo: String(body.repo ?? ""),
              intent: String(body.intent ?? ""),
              pathHint: typeof body.path_hint === "string"
                ? body.path_hint : undefined,
              operator,
            });
            if (metadata) saveKnowledgeSkillContext(service.options.dataDir, job.id, metadata);
            return json(response, 200, { ...job, knowledge_scope: metadata, production: projectKnowledgeProduction({ kind: "skill-extraction", record: job }) });
          }
          if (request.method === "POST" && parts.length === 4 && parts[3] === "submitted") {
            const body = await readBody(request, 8192);
            const job = service.markSkillExtractionSubmitted(decodeURIComponent(parts[2]), String(body.submission_id ?? ""));
            return json(response, 200, { ...job, knowledge_scope: readKnowledgeSkillContext(service.options.dataDir, job.id), production: projectKnowledgeProduction({ kind: "skill-extraction", record: job }) });
          }
          if (request.method === "GET" && parts.length === 3) {
            const job = service.skillExtractionJob(
              decodeURIComponent(parts[2]));
            if (!job) {
              return json(response, 404, { error: "提取任务不存在" });
            }
            return json(response, 200, { ...job, knowledge_scope: readKnowledgeSkillContext(service.options.dataDir, job.id), production: projectKnowledgeProduction({ kind: "skill-extraction", record: job }) });
          }
        } catch (error) {
          if (error instanceof SkillLibraryError || error instanceof TechnologyStackError) return json(response, 400, { error: error.message });
          if (error instanceof NotFoundError) return json(response, 404, { error: error.message });
          if (error instanceof TaskControlError) {
            return json(response, 409, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知知识提取接口" });
      }
      // 团队 Skill 资产库：登录成员可维护已发布包，操作人逐条记录。
      // 写进数据目录即对下一单生效，
      // 快照器每任务从源重造——这里不用通知任何运行时组件。
      // GET 也必须先于静态托管兜底,否则会被当前端资源接管。
      if (parts[0] === "skills") {
        const dataDir = service.options.dataDir;
        if (request.method === "GET" && parts.length === 1) {
          return json(response, 200, {
            ...(url.searchParams.get("view") === "directory" ? listHostSkillShelf(dataDir) : service.hostSkillShelf()),
            operations: listSkillOperations(dataDir),
          });
        }
        try {
          if (request.method === "GET" && parts.length === 4 && parts[2] === "submissions") {
            const pack = readSkillSubmissionPackage(dataDir, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
            return json(response, 200, { ...pack, production: projectKnowledgeProduction({ kind: "skill-submission", record: pack.record }) });
          }
          if (request.method === "GET" && parts.length === 3 && parts[2] === "package") {
            return json(response, 200, readHostSkillPackage(dataDir, decodeURIComponent(parts[1])));
          }
          if (request.method === "GET" && parts.length === 3
              && parts[2] === "versions") {
            return json(response, 200, {
              versions: listSkillVersions(
                dataDir, decodeURIComponent(parts[1])),
            });
          }
          // 提交待审(2026-08-27 用户拍板:人人可提交,管理员审核
          // 上架)。提交走与上架同一道完整验收闸;读列表登录即可
          // ——谁提交了什么、裁决结果如何是团队可见的台账。
          if (request.method === "GET" && parts.length === 2
              && parts[1] === "submissions") {
            const warnings: string[] = [];
            return json(response, 200,
              { submissions: listSkillSubmissions(dataDir, warnings).map(record => ({ ...record, production: projectKnowledgeProduction({ kind: "skill-submission", record }) })), warnings });
          }
          if (request.method === "GET" && parts.length === 2) {
            return json(response, 200, readHostSkillDocument(
              dataDir, decodeURIComponent(parts[1])));
          }
          if (request.method === "POST" && parts.length === 3
              && parts[2] === "submissions") {
            const body = await readBody(request);
            const record = await submitHostSkill(
              dataDir, decodeURIComponent(parts[1]),
              Array.isArray(body.files) ? body.files : [],
              viewer?.username ?? "本地部署",
              skillMetadataFromBody(dataDir, body));
            return json(response, 200, { ...record, production: projectKnowledgeProduction({ kind: "skill-submission", record }) });
          }
          const operator = viewer?.username ?? "本地部署";
          if (request.method === "PATCH" && parts.length === 3 && parts[2] === "package") {
            const body = await readBody(request);
            return json(response, 200, await updateHostSkillPackage(
              dataDir, decodeURIComponent(parts[1]), {
                mode: body.mode,
                expected_package_digest: body.expected_package_digest,
                files: body.files,
              }, operator));
          }
          if (request.method === "PATCH" && parts.length === 3
              && parts[2] === "classification") {
            const body = await readBody(request);
            return json(response, 200, await updateHostSkillKnowledgeMetadata(
              dataDir, decodeURIComponent(parts[1]),
              skillMetadataFromBody(dataDir, body), operator));
          }
          if (request.method === "DELETE" && parts.length === 2) {
            return json(response, 200, await offlineHostSkill(
              dataDir, decodeURIComponent(parts[1]), operator));
          }
          if (request.method === "POST" && parts.length === 3
              && parts[2] === "rollback") {
            const body = await readBody(request);
            return json(response, 200, await rollbackHostSkill(
              dataDir, decodeURIComponent(parts[1]),
              String(body.version ?? ""), operator));
          }
          if (request.method === "POST" && parts.length === 5
              && parts[2] === "submissions" && parts[4] === "approve") {
            const directory = decodeURIComponent(parts[1]), id = decodeURIComponent(parts[3]);
            const operation = await approveSkillSubmission(dataDir, directory, id, operator);
            const { record } = readSkillSubmissionPackage(dataDir, directory, id);
            return json(response, 200, { ...operation, production: projectKnowledgeProduction({ kind: "skill-submission", record }) });
          }
          if (request.method === "POST" && parts.length === 5
              && parts[2] === "submissions" && parts[4] === "reject") {
            const body = await readBody(request);
            const record = await rejectSkillSubmission(
              dataDir, decodeURIComponent(parts[1]),
              decodeURIComponent(parts[3]), operator,
              typeof body.reason === "string" ? body.reason : undefined);
            return json(response, 200, { ...record, production: projectKnowledgeProduction({ kind: "skill-submission", record }) });
          }
        } catch (error) {
          if (error instanceof SkillVersionConflictError) {
            return json(response, 409, { error: error.message });
          }
          if (error instanceof SkillLibraryError) {
            return json(response, 400, { error: error.message });
          }
          if (error instanceof TaskControlError) {
            return json(response, 409, { error: error.message });
          }
          throw error;
        }
        return json(response, 404, { error: "未知 Skill 资产接口" });
      }
      // 工作流方案是 Cloud 团队资产，不是 Mae-Flow 插件主线配置。
      // 定义只保存结构化差异；发布版本不可覆盖，任务选用时再固定为
      // 完整最终方案快照。团队方案由所有者维护、管理员终审；个人方案
      // 只有所有者/维护者可见，不会因为管理员身份自动泄露。
      if (parts[0] === "workflow-assets") {
        const library = getWorkflowAssets();
        const operator = viewer?.username ?? "本地部署";
        const admin = !options.auth || viewer?.role === "admin";
        const decorate = (asset: ReturnType<typeof library.get>["asset"]) => ({
          ...asset,
          permissions: {
            can_view: canViewWorkflow(asset, operator),
            can_edit: canEditWorkflow(asset, operator),
            can_submit: canEditWorkflow(asset, operator),
            can_publish: asset.scope === "team"
              ? admin : canPublishWorkflow(asset, operator),
            can_archive: admin || canEditWorkflow(asset, operator),
          },
        });
        const visible = (id: string) => {
          const detail = library.get(id);
          return canViewWorkflow(detail.asset, operator) ? detail : undefined;
        };
        const existingUsers = () => new Set(
          options.auth?.listUsers().map((user) => user.username) ?? [operator]);
        const maintainers = (value: unknown): string[] => {
          const list = Array.isArray(value) ? value.map(String) : [];
          if (options.auth) {
            const users = existingUsers();
            const missing = list.find((username) => !users.has(username));
            if (missing) {
              throw new WorkflowAssetError(
                "invalid_input", `维护者账号不存在:${missing}`);
            }
          }
          return list;
        };
        try {
          if (request.method === "GET" && parts.length === 1) {
            const result = library.list();
            return json(response, 200, {
              ...result,
              items: result.items.filter((item) =>
                canViewWorkflow(item, operator)).map(decorate),
            });
          }
          if (request.method === "POST" && parts.length === 1) {
            const body = await readBody(request);
            const created = library.create({
              id: body.id === undefined ? undefined : String(body.id),
              name: String(body.name ?? ""),
              description: body.description === undefined
                ? undefined : String(body.description),
              scope: String(body.scope ?? "personal") as "personal" | "team",
              owner: operator,
              maintainers: maintainers(body.maintainers),
              definition: body.definition,
              actor: operator,
            });
            return json(response, 201, decorate(created));
          }
          if (request.method === "GET" && parts.length === 2
              && parts[1] === "catalog") {
            return json(response, 200, listWorkflowAssetCatalog({
              dataDir: service.options.dataDir,
              standard: readWorkflowStandardSnapshot(workflowKernelRoot),
            }));
          }
          if (request.method === "GET" && parts.length === 2
              && parts[1] === "standard") {
            const standard = readWorkflowStandardSnapshot(workflowKernelRoot);
            return standard
              ? json(response, 200, standard)
              : json(response, 503, {
                  error: "平台标准方案暂不可读；现有方案仍可查看，但不能安全创建或编辑",
                });
          }
          if (parts.length >= 2) {
            const id = decodeURIComponent(parts[1]);
            const detail = visible(id);
            if (!detail) {
              return json(response, 404, { error: "工作流方案不存在或无权查看" });
            }
            if (request.method === "GET" && parts.length === 2) {
              return json(response, 200, {
                ...detail,
                asset: decorate(detail.asset),
              });
            }
            if (request.method === "GET" && parts.length === 4
                && parts[2] === "versions") {
              const version = Number(String(parts[3]).replace(/^v/, ""));
              return json(response, 200, library.getPublished(id, version));
            }
            if (request.method === "PUT" && parts.length === 3
                && parts[2] === "draft") {
              if (!canEditWorkflow(detail.asset, operator)) {
                return json(response, 403, { error: "只有方案所有者或维护者可以修改草稿" });
              }
              const body = await readBody(request);
              const updated = library.saveDraft(id, {
                definition: body.definition,
                expected_revision: Number(body.expected_revision),
                actor: operator,
              });
              return json(response, 200, {
                ...updated, asset: decorate(updated.asset),
              });
            }
            if (request.method === "POST" && parts.length === 3
                && parts[2] === "copy") {
              const body = await readBody(request);
              const copied = library.copy({
                source: {
                  kind: "workflow",
                  id,
                  ...(body.source_version == null ? {}
                    : { version: String(body.source_version) }),
                },
                name: String(body.name ?? `${detail.asset.name}（副本）`),
                description: body.description === undefined
                  ? detail.asset.description : String(body.description),
                scope: String(body.scope ?? "personal") as "personal" | "team",
                owner: operator,
                maintainers: maintainers(body.maintainers),
                actor: operator,
              });
              return json(response, 201, decorate(copied));
            }
            if (request.method === "POST" && parts.length === 3
                && ["submit", "withdraw"].includes(parts[2])) {
              if (!canEditWorkflow(detail.asset, operator)) {
                return json(response, 403, { error: "只有方案所有者或维护者可以提交或撤回" });
              }
              const updated = parts[2] === "submit"
                ? library.submitForReview(id, { actor: operator })
                : library.withdraw(id, { actor: operator });
              return json(response, 200, decorate(updated));
            }
            if (request.method === "POST" && parts.length === 3
                && parts[2] === "approve") {
              const allowed = detail.asset.scope === "team"
                ? admin : canPublishWorkflow(detail.asset, operator);
              if (!allowed) {
                return json(response, 403,
                  { error: "团队方案需要管理员审核；个人方案只能由所有者发布" });
              }
              return json(response, 200, decorate(
                library.approve(id, { actor: operator })));
            }
            if (request.method === "POST" && parts.length === 3
                && parts[2] === "reject") {
              const allowed = detail.asset.scope === "team"
                ? admin : detail.asset.owner === operator;
              if (!allowed) {
                return json(response, 403, { error: "没有权限驳回这个方案" });
              }
              const body = await readBody(request);
              return json(response, 200, decorate(library.reject(id, {
                actor: operator,
                reason: body.reason === undefined
                  ? undefined : String(body.reason),
              })));
            }
            if (request.method === "POST" && parts.length === 3
                && parts[2] === "archive") {
              if (!admin && !canEditWorkflow(detail.asset, operator)) {
                return json(response, 403, { error: "没有权限归档这个方案" });
              }
              return json(response, 200, decorate(
                library.archive(id, { actor: operator })));
            }
          }
        } catch (error) {
          if (error instanceof WorkflowAssetError) {
            const status = error.code === "not_found" ? 404
              : error.code === "revision_conflict"
                  || error.code === "invalid_state"
                  || error.code === "version_exists" ? 409
                : error.code === "corrupted" ? 422 : 400;
            return json(response, status, {
              error: error.message,
              code: error.code,
              ...(error.current_revision === undefined ? {}
                : { current_revision: error.current_revision }),
            });
          }
          throw error;
        }
        return json(response, 404, { error: "未知工作流方案接口" });
      }
      // Committer 的个人检视收件箱。名单只决定“还能不能被新邀请”，
      // 已经发给本人的邀请即使后来移出名单也仍应可见、可完成。
      if (parts[0] === "reviews") {
        if (!viewer) return json(response, 401, { error: "请先登录" });
        if (request.method === "GET" && parts[1] === "mine") {
          return json(response, 200, service.listReviewsFor(viewer.username));
        }
        if (request.method === "POST" && parts.length === 3
            && parts[2] === "complete") {
          try {
            return json(response, 200,
              service.completeReview(decodeURIComponent(parts[1]), viewer.username));
          } catch (error) {
            return json(response, 403, { error: humanError(error) });
          }
        }
        return json(response, 404, { error: "未知检视接口" });
      }
      // 静态前端(webRoot=React 构建产物):/ 与非 API 路径出文件;
      // /work/:taskId[/review/:reviewId] 与 /help[/article] 是前端深链，
      // 文件系统里当然没有这些文件，必须回退 index.html 交给 React
      // 解析。/help/*.png 等有扩展名的截图仍按静态资产处理，缺失就 404，
      // 不能拿 index.html 冒充成功图片。
      // 没配 webRoot 时零构建演示页兜底——两种形态永远有一个能用。
      if (request.method === "GET"
          && (url.pathname === "/" || parts[0] !== "tasks")) {
        const workspaceRoute = parts[0] === "work" && parts.length >= 2;
        const helpRoute = parts[0] === "help" && extname(url.pathname) === "";
        // 问题工作台深链(小鲁班通知的落点):上一段已把带 text/html 的
        // GET /issues 与 /pipeline-repairs 的列表、详情让出，这里交给 React。
        const issuesRoute = parts[0] === "issues" || parts[0] === "pipeline-repairs";
        // 环境管理页签深链(#149):API 判别式放行的 text/html GET 在这里接住交给 React。
        const environmentsRoute = parts[0] === "environments" && parts.length === 1;
        const appRoute = workspaceRoute || helpRoute || issuesRoute || environmentsRoute
          || (parts[0] === "configuration" && parts.length === 1);
        const exactFile = options.webRoot
          ? staticFile(options.webRoot, url.pathname)
          : undefined;
        const file = exactFile ?? (options.webRoot && appRoute
          ? staticFile(options.webRoot, "/") : undefined);
        if (file) {
          response.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
            // index.html 一个缓存头都不带时,浏览器可以按启发式规则自行
            // 缓存——包名带 hash 也救不了:入口页是旧的,它引的就永远是
            // 旧包。修了三轮图,人看到的可能一直是修之前那版。
            // 入口页每次回源,带 hash 的资产则可以长期缓存。
            "cache-control": file.endsWith(".html")
              ? "no-cache" : "public, max-age=31536000, immutable",
          });
          return response.end(readFileSync(file));
        }
        if (url.pathname === "/" || appRoute) {
          response.writeHead(200,
            { "content-type": "text/html; charset=utf-8" });
          return response.end(WEB_PAGE);
        }
        return json(response, 404, { error: "未知路径" });
      }
      if (request.method === "POST" && url.pathname === "/requirement-materials/preview") {
        if (options.auth && !viewer) return json(response, 401, { error: "请先登录" });
        try {
          const body = await readBody(request, 12 * 1024 * 1024);
          const result = buildRequirementMaterials(join(service.options.dataDir, "knowledge-materials"),
            body.material_ids, body.requirement);
          return json(response, 200, {
            ...result,
            sources: result.sources.map(({ content: _content, ...source }) => source),
            assets: result.assets.map(({ content, ...asset }) => ({ ...asset, content_base64: content.toString("base64") })),
          });
        } catch (error) {
          return json(response, 400, { error: humanError(error) });
        }
      }
      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = await readBody(request, 42 * 1024 * 1024);
        let requirementMaterials: ReturnType<typeof buildRequirementMaterials> | undefined;
        try {
          if (body.requirement_material_ids !== undefined) {
            requirementMaterials = buildRequirementMaterials(join(service.options.dataDir, "knowledge-materials"),
              body.requirement_material_ids, body.requirement);
          }
        } catch (error) {
          return json(response, 400, { error: humanError(error) });
        }
        const title = body.title === undefined
          ? undefined : String(body.title).trim() || undefined;
        const requirement = String(
          requirementMaterials?.requirement ?? body.requirement ?? "").trim();
        if (!requirement) {
          return json(response, 400, { error: "requirement 不能为空" });
        }
        // 管理员不发起任务(用户 2026-08-19 拍板):管理平台与干活是两个
        // 角色——管理员配服务、建账号、兜底控制,任务由开发者自己发起、
        // 挂在自己名下。替人下单看似方便,实际是把"以谁的身份推代码/
        // 收通知"的归属搞混的入口(之前那套"管理员填账号替人下单"的
        // 逻辑连带它踩过的归属人为空的坑,一并退役)。
        if (viewer?.role === "admin") {
          return json(response, 403, {
            error: "管理员不发起任务——用开发者账号登录下单;"
              + "管理员负责配置平台、管理账号与兜底控制",
          });
        }
        const businessModuleId = typeof body.business_module_id === "string" ? body.business_module_id.trim() : "";
        // 归属模块:登录下单且平台已配置模块库时必选——让用户选归属的前提
        // 是平台真的配置了归属选项。本地单人/测试(无鉴权)与未配置模块库
        // 的部署不卡创建,否则所有不带模块的既有脚本与测试全部 400。
        const hasBusinessModules = listBusinessModules(service.options.dataDir).modules.length > 0;
        if (viewer && hasBusinessModules && !businessModuleId) {
          return json(response, 400, { error: "请选择所属业务模块" });
        }
        // 任务归属人=登录者本人(不许替别人下单);无鉴权形态(本地
        // 单人/测试)沿用请求体里的账号。
        const account = viewer?.username
          ?? (body.account ? String(body.account) : undefined);
        const requirementDocumentName = requirementMaterials?.document_name
          ?? (body.requirement_document_name === undefined
            ? undefined : String(body.requirement_document_name));
        // 任务级可配(用户拍板):交付代码仓、交付方式(选项来自内核)、修复轮预算。
        const repo = body.repo === undefined ? undefined : String(body.repo);
        const repos = Array.isArray(body.repos)
          ? body.repos.map(String) : undefined;
        // 兼容旧前端：select 显示了默认项但可能提交空串。空白就是
        // “未指定”，交给 TaskService 采用内核默认交付方式。
        const lane = body.lane === undefined
          ? undefined : String(body.lane).trim() || undefined;
        const ticket = body.ticket === undefined
          ? undefined : String(body.ticket);
        const repositoryTickets = body.repository_tickets
            && typeof body.repository_tickets === "object"
            && !Array.isArray(body.repository_tickets)
          ? Object.fromEntries(Object.entries(
              body.repository_tickets as Record<string, unknown>,
            ).map(([repository, value]) => [repository, String(value ?? "")]))
          : undefined;
        const repositoryAssignees = body.repository_assignees
            && typeof body.repository_assignees === "object"
            && !Array.isArray(body.repository_assignees)
          ? Object.fromEntries(Object.entries(
              body.repository_assignees as Record<string, unknown>,
            ).map(([repository, value]) => [repository, String(value ?? "")]))
          : undefined;
        const collaborators = Array.isArray(body.collaborators)
          ? body.collaborators.map(String) : undefined;
        const baseline = body.baseline === undefined ? undefined : String(body.baseline);
        const model = body.model
          ? {
              provider: String((body.model as { provider?: unknown })
                .provider ?? ""),
              model: String((body.model as { model?: unknown }).model ?? ""),
            }
          : undefined;
        const repairRounds = body.repair_rounds === undefined
          || body.repair_rounds === null || body.repair_rounds === ""
          ? undefined : Number(body.repair_rounds);
        const taskInstructions = body.task_instructions == null
          ? undefined : String(body.task_instructions);
        let workflowDefinition = body.workflow_definition;
        let workflowSource: WorkflowSourceRef | undefined;
        const workflowSelection = body.workflow_selection &&
            typeof body.workflow_selection === "object"
          ? body.workflow_selection as Record<string, unknown> : undefined;
        const repositorySkillCatalogToken =
          body.repository_skill_catalog_token === undefined
            ? undefined : String(body.repository_skill_catalog_token);
        const selectedRepositorySkillIds =
          Array.isArray(body.selected_repository_skill_ids)
            ? body.selected_repository_skill_ids.map(String) : undefined;
        const selectedHostSkillPaths =
          Array.isArray(body.selected_host_skill_paths)
            ? body.selected_host_skill_paths.map(String) : undefined;
        const selectedBusinessModuleIds =
          Array.isArray(body.selected_business_module_ids)
            ? body.selected_business_module_ids.map(String) : undefined;
        let knowledgePreviewDigest = body.knowledge_preview_digest === undefined
          ? undefined : String(body.knowledge_preview_digest).trim();
        if (body.knowledge_preview_digest !== undefined
            && !/^[a-f0-9]{64}$/.test(knowledgePreviewDigest ?? "")) {
          return json(response, 400, { error: "知识清单指纹不合法" });
        }
        const providedRepositoryProfiles = Array.isArray(body.repository_profiles)
          ? body.repository_profiles.flatMap((item: Record<string, unknown>) => {
              try {
                return [normalizeRepositoryProfile({
                  repository: String(item.repository ?? ""),
                  technologies: Array.isArray(item.technologies)
                    ? item.technologies.map(String) : [],
                  confirmed: item.confirmed !== false,
                }, account ?? "本地部署", service.options.dataDir)];
              } catch (error) {
                service.options.log?.(
                  `仓库技术画像无效(本单不采用): ${String(error)}`);
                return [];
              }
            }) : undefined;
        const requestedRepositories = repos?.length
          ? repos : repo ? [repo] : [];
        let repositoryProfiles = providedRepositoryProfiles;
        if (requestedRepositories.length) {
          try {
            if (repositoryProfiles === undefined) {
              repositoryProfiles = resolveRepositoryProfiles(
                service.options.dataDir, requestedRepositories)
                .flatMap((item) => item.profile ? [{ ...item.profile }] : []);
            }
            repositoryProfiles = requireRepositoryProfiles(
              requestedRepositories, repositoryProfiles, service.options.dataDir);
            if (providedRepositoryProfiles !== undefined) {
              repositoryProfiles = repositoryProfiles.map((current) => {
                try {
                  return saveRepositoryProfile(
                    service.options.dataDir, current, account ?? "本地部署");
                } catch (error) {
                  // 记忆失败不改变本次选择：预览与任务仍使用同一份画像。
                  service.options.log?.(
                    `仓库技术画像保存失败(本单仍采用): ${String(error)}`);
                  return current;
                }
              });
            }
          } catch (error) {
            return json(response, 400, { error: humanError(error) });
          }
        }
        // 配置没配齐不给下单(用户拍板)。前端会把缺项摆在明面上,
        // 但拦必须在后端——绕过界面直接打接口的一样要被拦住,
        // 否则任务会带着缺失的令牌一路跑到推送/通知那步才炸。
        const blockers = [
          ...service.launchOptions().blockers,
          ...personalBlockers(viewer),
        ];
        if (blockers.length) {
          return json(response, 409, {
            error: "配置未完成,先补齐这些再下单:"
              + blockers.map((item) => item.label).join(";"),
            blockers,
          });
        }
        try {
          if (workflowSelection && workflowDefinition !== undefined) {
            return json(response, 400, {
              error: "工作流方案选择与本任务临时定制不能同时提交",
            });
          }
          if (workflowSelection) {
            const id = String(workflowSelection.id ?? "").trim();
            const detail = getWorkflowAssets().get(id);
            const operator = viewer?.username ?? account ?? "本地部署";
            if (!canViewWorkflow(detail.asset, operator)
                || !detail.asset.selectable_for_tasks) {
              return json(response, 409, {
                error: "所选工作流方案不可用、未发布或已归档，请重新选择",
              });
            }
            const rawVersion = workflowSelection.version;
            const version = rawVersion == null || rawVersion === ""
              ? undefined : Number(String(rawVersion).replace(/^v/, ""));
            if (version !== undefined
                && (!Number.isInteger(version) || version < 1)) {
              return json(response, 400, { error: "工作流方案版本不合法" });
            }
            const published = getWorkflowAssets().getPublished(id, version);
            requireTechnologyStacks(service.options.dataDir, published.definition.applicability.technologies);
            workflowDefinition = published.definition;
            workflowSource = {
              kind: "workflow",
              id,
              label: detail.asset.name,
              version: `v${published.version}`,
              digest: published.digest,
            };
          }
          if (!knowledgePreviewDigest) {
            const preview = service.previewLaunchKnowledge({
              repositories: repos?.length ? repos : repo ? [repo] : [],
              selectedBusinessModuleIds,
              selectedHostSkillPaths,
              repositoryProfiles,
              workflowDefinition,
            });
            const matched = preview.business_knowledge.length
              + preview.team_skills.length;
            if (!preview.complete || matched > 0) {
              return json(response, 409, {
                error: "请先在发起页核对自动匹配知识全文与版本，再提交当前清单指纹",
              });
            }
            // 兼容没有平台知识的旧客户端，但仍把权威空清单绑定到创建，
            // 防止预检后目录新增资产而被静默带入。
            knowledgePreviewDigest = preview.selection_digest;
          }
          // UI 会即时探测，但真正“不让坏地址创建任务”必须由服务端兜底：
          // 旧页面、脚本或竞态都不能绕过这道闸。固定仓部署没有逐单地址，
          // 由启动自检负责，不在这里重复探测。知识清单契约先判，保持旧
          // 客户端拿到“先核对清单”的 409 后能按原流程自愈。
          if (service.launchOptions().repo.enabled
              && requestedRepositories.length > 0) {
            const probed = await service.probeRepositories({
              repositories: requestedRepositories,
              account,
            });
            const failed = probed.repositories.filter((item) => !item.reachable);
            if (failed.length) {
              return json(response, 400, {
                error: "代码仓不可访问，任务未创建："
                  + failed.map((item) => `${item.repository}（${item.message}）`).join("；"),
                repositories: probed.repositories,
              });
            }
          }
          return json(response, 201, service.create(requirement,
            {
              title, account, repo, repos,
              requirementDocumentName,
              requirementAssets: requirementMaterials?.assets,
              requirementSources: requirementMaterials?.sources,
              requirementWarnings: requirementMaterials?.warnings,
              lane, ticket, repositoryTickets, repositoryAssignees,
              collaborators,
              baseline, productVersion: body.product_version === undefined ? undefined : String(body.product_version), model,
              repairRounds, taskInstructions,
              workflowDefinition, workflowSource,
              repositorySkillCatalogToken,
              selectedRepositorySkillIds,
              selectedHostSkillPaths,
              selectedBusinessModuleIds,
              businessModuleId,
              repositoryProfiles,
              requireRepositoryProfiles: requestedRepositories.length > 0,
              knowledgePreviewDigest,
              // 下单后先在工作台检视需求原文；主责任人确认才入队。
              requirementAnalysisConfirmation: true,
            }));
        } catch (error) {
          return json(response, 400, { error: humanError(error) });
        }
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        return json(response, 200, service.list());
      }
      if (parts[0] === "tasks" && parts.length >= 2) {
        const id = parts[1];
        if (parts.length === 3 && parts[2] === "demo-snapshot") {
          if (!viewer) return json(response, 401, { error: "请先以管理员身份登录" });
          if (viewer.role !== "admin") return json(response, 403, { error: "只有管理员可以创建演示副本" });
          if (request.method !== "GET") {
            response.setHeader("allow", "GET");
            return json(response, 405, { error: "演示来源只接受读取" });
          }
          response.setHeader("cache-control", "no-store");
          return json(response, 200, await readTaskDemoSnapshot(service, id));
        }
        if (parts.length === 3 && parts[2] === "demo-card") {
          if (!viewer) return json(response, 401, { error: "请先以管理员身份登录" });
          if (viewer.role !== "admin") return json(response, 403, { error: "只有管理员可以补充演示卡片" });
          if (request.method !== "POST") {
            response.setHeader("allow", "POST");
            return json(response, 405, { error: "演示补卡只接受 POST" });
          }
          const body = await readBody(request);
          if (typeof body.phase !== "string" || !body.phase.trim() || body.phase.length > 80) {
            return json(response, 400, { error: "请选择要补充的阶段" });
          }
          response.setHeader("cache-control", "no-store");
          const controller = new AbortController();
          const cancel = () => controller.abort();
          response.once("close", cancel);
          try {
            return json(response, 200, await generateTaskDemoCard(service, id, body.phase, { signal: controller.signal }));
          } catch (error) {
            if (error instanceof TaskDemoCardError) return json(response, error.status, { error: error.message });
            throw error;
          } finally { response.off("close", cancel); }
        }
        const correction = request.method !== "GET" ? storedTask(service, id)?.ticket_correction : undefined;
        if (request.method !== "GET" && parts[2] !== "correct-ticket"
            && correction && correction.state !== "completed" && !correction.cleanup_only) {
          return json(response, 409, { error: "单号正在纠正，请在任务详情中查看进度或重试" });
        }
        if (request.method !== "GET" && service.historyMutationInProgress(id)) {
          return json(response, 409, {
            error: `任务 ${id} 正在准备继续修改、清空重跑或删除，请勿同时修改`,
          });
        }
        if (request.method === "PUT" && parts.length === 3 && parts[2] === "business-module") {
          const body = await readBody(request);
          if (typeof body.module_id !== "string") return json(response, 400, { error: "module_id 必须为字符串" });
          try { return json(response, 200, service.setBusinessModule(id, body.module_id, viewer?.username ?? "本地部署")); }
          catch (error) { return json(response, 400, { error: humanError(error) }); }
        }
        if (request.method === "GET" && parts.length === 2) {
          const task = service.getAsync ? await service.getAsync(id) : service.get(id);
          if (!task) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, task);
        }
        if (request.method === "GET" && parts.length === 3 && parts[2] === "knowledge-source") {
          const task = service.getAsync ? await service.getAsync(id) : service.get(id);
          if (!task) return json(response, 404, { error: `任务 ${id} 不存在` });
          try {
            return json(response, 200, readTaskKnowledgeSource({
              workspace: task.workspace, repositoryRoot: service.artifactRoot(id),
              hostRulesRoot: process.cwd(), usage: task.knowledge_usage,
              resourceId: url.searchParams.get("resource") ?? "",
            }));
          } catch (error) {
            return json(response, 404, { error: humanError(error) });
          }
        }
        if (parts.length === 3 && parts[2] === "attachments") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: "任务不存在" });
          if (request.method === "POST") {
            if (!canCollaborate(viewer, target, !!options.auth)) return json(response, 403, { error: "只有任务责任人或受邀协作者可以上传附件" });
            try {
              return json(response, 201, await service.uploadConversationAttachment(id, request, url.searchParams.get("name") ?? "attachment.bin"));
            } catch (error) { return json(response, 400, { error: humanError(error) }); }
          }
          if (request.method === "GET") {
            try {
              const { meta, file } = service.conversationAttachment(id, url.searchParams.get("path") ?? "");
              response.writeHead(200, { "content-type": "application/octet-stream", "content-length": meta.bytes,
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`, "cache-control": "no-store" });
              createReadStream(file).on("error", () => response.destroy()).pipe(response);
              return;
            } catch (error) { return json(response, 404, { error: humanError(error) }); }
          }
        }
        // 批注附图:上传落盘拿路径,再随批注引用;读取只认资产模块的路径形状。
        if (request.method === "POST" && parts.length === 3
            && parts[2] === "annotation-assets") {
          const body = await readBody(request, REVIEW_ASSET_MAX_BYTES * 2);
          let bytes: Buffer;
          try {
            bytes = Buffer.from(String(body?.content_base64 ?? ""), "base64");
          } catch {
            return json(response, 400, { error: "图片内容不是合法的 base64" });
          }
          try {
            return json(response, 201, service.storeAnnotationAsset(id, bytes));
          } catch (error) {
            if (error instanceof ReviewAssetError) return json(response, 400, { error: error.message });
            throw error;
          }
        }
        if (request.method === "GET" && parts.length === 3
            && parts[2] === "annotation-asset") {
          const asset = service.annotationAsset(id, url.searchParams.get("path") ?? "");
          if (!asset) return json(response, 404, { error: "批注附图不存在" });
          response.writeHead(200, {
            "content-type": asset.mime_type,
            "content-length": asset.content.length,
            "content-disposition": "inline",
            "x-content-type-options": "nosniff",
            "cache-control": "private, max-age=86400",
          });
          return response.end(asset.content);
        }
        if (request.method === "GET" && parts.length === 3
            && parts[2] === "requirement-sources") {
          const source = service.requirementSource(id, url.searchParams.get("path") ?? "");
          if (!source) return json(response, 404, { error: "需求原件不存在" });
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": source.content.length,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(source.name)}`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
          });
          return response.end(source.content);
        }
        if (request.method === "GET" && parts.length === 3
            && parts[2] === "requirement-asset") {
          const path = url.searchParams.get("path") ?? "";
          const asset = service.requirementAsset(id, path);
          if (!asset) return json(response, 404, { error: "需求图片不存在" });
          response.writeHead(200, {
            "content-type": asset.mime_type,
            "content-length": asset.content.length,
            "content-disposition": "inline",
            "x-content-type-options": "nosniff",
            "cache-control": "private, max-age=86400",
          });
          return response.end(asset.content);
        }
        // 需求确认阶段某一轮 Agent 修改的对比:改前全文 + diff。看得见任务
        // 就看得见对比,它和需求原文本身一样是任务事实。
        if (request.method === "GET" && parts.length === 4
            && parts[2] === "requirement-revisions") {
          const revision = service.requirementRevision(id, parts[3]);
          if (!revision) return json(response, 404, { error: "这一轮修改的记录不存在" });
          return json(response, 200, revision);
        }
        if (request.method === "DELETE" && parts.length === 2) {
          const target = service.get(id);
          let taskAccount = target?.luban_account;
          if (!target && service.options.projection) {
            const identity = await service.options.projection.taskIdentity(id);
            taskAccount = identity.luban_account;
          }
          if (options.auth
              && viewer?.role !== "admin"
              && (!viewer || !taskAccount || viewer.username !== taskAccount)) {
            return json(response, 403, {
              error: "只能删除自己负责的历史任务",
            });
          }
          const deleted = await service.hardDeleteHistory(id);
          options.lubanApproval?.purgeTask(id);
          return json(response, 200, deleted);
        }
        if (request.method === "POST" && parts[2] === "decision") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          // 受邀参与讨论的人(协作者/逐仓责任人)在分析期可以答卡——邀请了
          // 就得能回答(2026-09-04 用户拍板)。拍板类决定由 decide() 再按
          // 责任人硬闸一次,这里只挡"是否参与"。
          // 澄清卡(Agent 追问某条检视意见)同理:被追问的意见作者能答——
          // 问的是他,不能只让责任人替他猜(2026-09-05)。
          if (!canCollaborate(viewer, target, !!options.auth)
              && !(options.auth && service.canAnswerClarification(id, viewer?.username))) {
            return json(response, 403, { error: "只有责任人或受邀参与讨论的人可以回答这张卡"
              + (target.luban_account ? `,请联系责任人 ${target.luban_account}` : "") });
          }
          const body = await readBody(request);
          const task = await service.decide(id, {
            // 操作人取登录会话,不信请求体:决定要答得出"谁点的"。
            actor: viewer?.username,
            waiting_id: body.waiting_id === undefined
              ? undefined : String(body.waiting_id),
            state_version: Number(body.state_version),
            selected_options: body.selected_options
              && typeof body.selected_options === "object"
              ? body.selected_options : undefined,
            free_responses: body.free_responses
              && typeof body.free_responses === "object"
              ? body.free_responses : undefined,
            comment: body.comment !== undefined
              ? String(body.comment) : undefined,
            decision: body.decision !== undefined
              ? String(body.decision) : undefined,
            answers: body.answers && typeof body.answers === "object"
              ? body.answers : undefined,
            notes: body.notes ? String(body.notes) : undefined,
            annotation_ids: Array.isArray(body.annotation_ids)
              ? body.annotation_ids.map(String) : undefined,
            repository_skill_catalog_token:
              body.repository_skill_catalog_token === undefined
                ? undefined : String(body.repository_skill_catalog_token),
            selected_repository_skill_ids:
              Array.isArray(body.selected_repository_skill_ids)
                ? body.selected_repository_skill_ids.map(String) : undefined,
            repository_assignees: body.repository_assignees
              && typeof body.repository_assignees === "object"
              && !Array.isArray(body.repository_assignees)
              ? Object.fromEntries(Object.entries(body.repository_assignees)
                  .map(([repositoryId, account]) =>
                    [repositoryId, String(account)]))
              : undefined,
            repository_tickets: body.repository_tickets
              && typeof body.repository_tickets === "object"
              && !Array.isArray(body.repository_tickets)
              ? Object.fromEntries(Object.entries(body.repository_tickets)
                  .map(([repositoryId, ticket]) =>
                    [repositoryId, String(ticket)]))
              : undefined,
            delivery_paths: Array.isArray(body.delivery_paths)
              ? body.delivery_paths.map(String) : undefined,
            delivery_compile_action:
              typeof body.delivery_compile_action === "string"
                ? body.delivery_compile_action as DeliveryCompileAction
                : undefined,
          });
          return json(response, 200, task);
        }
        if (request.method === "PUT" && parts[2] === "moonlight") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能调整分配给自己的任务" });
          }
          const body = await readBody(request);
          const mode = String(body.mode ?? "inherit");
          if (!(["inherit", "manual", "moonlight"] as string[]).includes(mode)) {
            return json(response, 400, { error: "任务审批方式无效" });
          }
          return json(response, 200, service.setTaskApprovalMode(
            id,
            mode as "inherit" | "manual" | "moonlight",
            body.include_current === true,
          ));
        }
        // 主任务采用“一个主责任人 + 多位共同开发者”：大家都能参与
        // 澄清和送意见，最终决定与任务控制仍只归主责任人。
        if (request.method === "PUT" && parts[2] === "collaborators") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只有主任务责任人可以邀请共同开发者" });
          }
          const body = await readBody(request);
          const collaborators = Array.isArray(body.collaborators)
            ? body.collaborators.map(String) : [];
          return json(response, 200,
            service.setRequirementCollaborators(id, collaborators));
        }
        // 拆分前先保存逐仓分工，受邀人即可进入同一主任务协作现场。
        // 最终确认仍只有主任务责任人能提交，协作者不能代拍板。
        if (request.method === "PUT" && parts[2] === "repository-assignees") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只有主任务责任人可以保存分工" });
          }
          const body = await readBody(request);
          const assignments = body.repository_assignees
            && typeof body.repository_assignees === "object"
            && !Array.isArray(body.repository_assignees)
            ? Object.fromEntries(Object.entries(body.repository_assignees)
                .map(([repositoryId, account]) =>
                  [repositoryId, String(account)]))
            : {};
          const tickets = body.repository_tickets
            && typeof body.repository_tickets === "object"
            && !Array.isArray(body.repository_tickets)
            ? Object.fromEntries(Object.entries(body.repository_tickets)
                .map(([repositoryId, ticket]) =>
                  [repositoryId, String(ticket)]))
            : undefined;
          return json(response, 200,
            service.saveRequirementRepositoryAssignmentDraft(
              id, assignments, tickets));
        }
        // push 前人工确认交付范围(任务级显式开关)。未显式设置时按
        // 个人默认；开着时宿主在 prepush 收敛后挂云端原生 diff 卡。
        if (request.method === "PUT" && parts[2] === "push-confirmation") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能调整分配给自己的任务" });
          }
          const body = await readBody(request);
          try {
            return json(response, 200,
              service.setPushConfirmation(id, body.on === true));
          } catch (error) {
            if (error instanceof TaskControlError) {
              return json(response, 409, { error: error.message });
            }
            throw error;
          }
        }
        // 多仓需求图的结构化确认:平台自己的按钮,不依赖模型把
        // 「确认并生成任务」的选项原文写对(魔法字符串漂了会静默丢单,
        // 车道双问同款教训)。幂等:已生成的仓不重复建。
        if (request.method === "POST" && parts[2] === "graph"
            && parts[3] === "confirm") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能处理分配给自己的任务" });
          }
          const body = await readBody(request);
          return json(response, 200, await service.confirmRequirementGraph(id, {
            catalog_token: body.repository_skill_catalog_token === undefined
              ? undefined : String(body.repository_skill_catalog_token),
            selected_ids: Array.isArray(body.selected_repository_skill_ids)
              ? body.selected_repository_skill_ids.map(String) : undefined,
            repository_assignees: body.repository_assignees
              && typeof body.repository_assignees === "object"
              && !Array.isArray(body.repository_assignees)
              ? Object.fromEntries(Object.entries(body.repository_assignees)
                  .map(([repositoryId, account]) =>
                    [repositoryId, String(account)]))
              : undefined,
            repository_tickets: body.repository_tickets
              && typeof body.repository_tickets === "object"
              && !Array.isArray(body.repository_tickets)
              ? Object.fromEntries(Object.entries(body.repository_tickets)
                  .map(([repositoryId, ticket]) =>
                    [repositoryId, String(ticket)]))
              : undefined,
          }));
        }
        // Committer 检视必须由该单责任人主动发起。管理员只维护名单，
        // 即使拥有其他操作兜底权，也不能替开发点击邀请。
        if (request.method === "POST" && parts[2] === "review-request") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!viewer || viewer.username !== target.luban_account) {
            return json(response, 403,
              { error: "只有该任务责任人可以邀请 Committer 检视" });
          }
          const body = await readBody(request);
          const committer = String(body.committer ?? "").trim();
          const allowed = options.auth?.listUsers().some((user) =>
            user.username === committer && user.committer);
          if (!allowed) {
            return json(response, 400,
              { error: "请选择管理员配置的 Committer" });
          }
          return json(response, 200,
            await service.requestReview(id, viewer.username, committer));
        }
        if (request.method === "GET" && parts[2] === "reviews") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, service.listTaskReviews(id));
        }
        if (request.method === "GET" && parts[2] === "events") {
          return streamEvents(service, id, response);
        }
        if (request.method === "GET"
            && ["execution", "build-fix", "prepush"].includes(parts[2])
            && parts[3] === "events") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return streamExecutionEvents(response, target.workspace, {
            buildFixOnly: parts[2] !== "execution",
            follow: url.searchParams.get("follow") !== "false",
            terminal: () => ["completed", "failed", "canceled"].includes(storedTask(service, id)?.status ?? "canceled"),
          });
        }
        // 环境预热编译的实时事件流(用户点名:预热进展必须清楚可见)。
        if (request.method === "GET" && parts[2] === "warmup"
            && parts[3] === "events") {
          return streamJsonlAsSse(service, id, response,
            () => service.warmupEventLogPath(id));
        }
        if (parts[2] === "developer-assistant") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (request.method === "GET") {
            return json(response, 200, await service.developerAssistantAsync(id));
          }
          if (request.method === "POST") {
            if (!canOperate(viewer, target.luban_account, !!options.auth)) {
              return json(response, 403,
                { error: "只能为分配给自己的任务使用开发助手" });
            }
            if (parts[3] === "interrupt") {
              return json(response, 200, await service.stopDeveloperAssistant(
                id, viewer?.username ?? "本地用户"));
            }
            if (parts[3] === "return") {
              return json(response, 200, await service.returnDeveloperAssistant(
                id, viewer?.username ?? "本地用户"));
            }
            const body = await readBody(request);
            return json(response, 202, service.startDeveloperAssistant(
              id,
              String(body.text ?? ""),
              viewer?.username ?? "本地用户",
            ));
          }
        }
        // 发过的补充说明 + 送达与否:发出去没有回执等于对着空气说话。
        if (request.method === "GET" && parts[2] === "interrupts") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, await service.listInterruptsAsync(id));
        }
        // 检视批注:圈注权和送达权分开——谁都能圈。作者可提交自己的
        // 意见；任务责任人还可以原样转交他人的意见，但不能改写或替他
        // 闭环。这样路过成员留下的有效意见不会成为无人能接的草稿。
        // 任务记忆:只读列表、原文、撤回。没有编辑——改就是再圈一次。
        if (parts[2] === "memories") {
          if (!storedTask(service, id)) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (request.method === "GET" && parts.length === 3) {
            return json(response, 200, service.listTaskMemories(id).map(row => ({ ...row,
              can_review: true })));
          }
          // 这单用到的:宿主三次推送 + Agent 自己查/展开的足迹。
          if (request.method === "GET" && parts.length === 4 && parts[3] === "usage") {
            return json(response, 200, service.listTaskMemoryUsage(id));
          }
          if (request.method === "GET" && parts.length === 4) {
            const found = service.readTaskMemory(id, decodeURIComponent(parts[3]));
            return found ? json(response, 200, found)
              : json(response, 404, { error: "这条记忆不存在" });
          }
          if (request.method === "POST" && parts.length === 5 && parts[4] === "review") {
            const body = await readBody(request);
            return json(response, 200, service.reviewTaskMemory(id, decodeURIComponent(parts[3]), viewer?.username ?? "本地用户", body, !options.auth || viewer?.role === "admin"));
          }
          if (request.method === "POST" && parts.length === 5
              && parts[4] === "withdraw") {
            return json(response, 200, service.withdrawTaskMemory(
              id, decodeURIComponent(parts[3]), viewer?.username ?? "本地用户"));
          }
        }
        if (parts[2] === "delivery-improvement" && parts.length === 4 && parts[3] === "evidence" && request.method === "GET") {
          if (!storedTask(service, id)) return json(response, 404, { error: `任务 ${id} 不存在` });
          response.setHeader("cache-control", "no-store");
          try { return json(response, 200, service.deliveryImprovementEvidence(id, url.searchParams.get("delivery_id") ?? undefined, url.searchParams.get("ref") ?? "")); }
          catch (error) { return json(response, 404, { error: humanError(error) }); }
        }
        if (parts[2] === "delivery-improvement" && parts.length === 3 && ["GET", "POST"].includes(request.method ?? "")) {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (request.method === "POST" && !canOperate(viewer, target.luban_account, !!options.auth))
            return json(response, 403, { error: "只有任务责任人或管理员可以启动交付分析" });
          response.setHeader("cache-control", "no-store");
          try { return json(response, request.method === "POST" ? 202 : 200,
            service.deliveryImprovement(id, url.searchParams.get("delivery_id") ?? undefined, request.method === "POST")); }
          catch (error) { return json(response, 400, { error: humanError(error) }); }
        }
        if (request.method === "POST" && parts[2] === "delivery-report" && parts.length === 3) {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth))
            return json(response, 403, { error: "只有任务责任人或管理员可以生成或更新交付报告" });
          return json(response, 202, service.generateDeliveryReport(id));
        }
        if (parts[2] === "overall-story") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (request.method === "GET") {
            return json(response, 200, parts[3] === "revisions" && parts[4]
              ? service.overallStories.revision(id, parts[4]) : service.overallStories.status(id));
          }
          if (request.method === "POST") {
            if (!canOperate(viewer, target.luban_account, !!options.auth)) {
              return json(response, 403, { error: "只有责任人可以生成、更新或确认整体 Story；受邀者可提交检视意见" });
            }
            const actor = viewer?.username ?? "本地用户";
            if (parts[3] === "architecture") return json(response, 202, service.overallStories.generateArchitecture(id, actor));
            if (parts[3] === "stop") return json(response, 200, await service.overallStories.stop(id));
            if (parts[3] === "confirm") {
              const body = await readBody(request);
              return json(response, 200, service.overallStories.confirm(id, String(body.revision ?? ""), actor));
            }
            if (parts.length !== 3) return json(response, 404, { error: "整体 Story 操作不存在" });
            return json(response, 202, service.overallStories.generate(id, actor));
          }
        }
        if (request.method === "POST" && parts[2] === "early-start"
            && (parts.length === 3 || (parts.length === 4 && parts[3] === "preview"))) {
          const body = await readBody(request);
          if (body.release_ids !== undefined && (!Array.isArray(body.release_ids)
              || body.release_ids.some((value: unknown) => typeof value !== "string"))) {
            return json(response, 400, { error: "前置任务清单格式不正确" });
          }
          if ([body.ticket, body.revision].some(value => value !== undefined && typeof value !== "string")) {
            return json(response, 400, { error: "单号和预览版本必须为文本" });
          }
          const input = { release_ids: body.release_ids as string[] | undefined,
            ticket: body.ticket === undefined ? undefined : String(body.ticket),
            revision: body.revision === undefined ? undefined : String(body.revision) };
          const actor = viewer?.username ?? "本地用户";
          return json(response, 200, parts[3] === "preview"
            ? service.previewEarlyStart(id, actor, input) : service.startTaskEarly(id, actor, input));
        }
        if (parts[2] === "annotations") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          const author = viewer?.username ?? "本地用户";
          if (request.method === "GET" && parts.length === 3) {
            // 闭环判定连同人名一起在服务端算完:页面只渲染,不推断。
            const people = options.auth?.listUsers() ?? [];
            return json(response, 200, await service.listAnnotationsAsync(id, {
              username: author,
              can_override: !options.auth || viewer?.role === "admin",
              can_route_others: canOperate(
                viewer, target.luban_account, !!options.auth),
              person_name: (username: string) =>
                people.find((person) => person.username === username)
                  ?.display_name?.trim() || username,
            }));
          }
          if (request.method === "POST" && parts.length === 3) {
            const body = await readBody(request);
            return json(response, 201, service.addAnnotation(id, {
              author,
              artifact: String(body.artifact ?? ""),
              file: String(body.file ?? ""),
              line: Number(body.line ?? 0),
              anchor: String(body.anchor ?? ""),
              quote: String(body.quote ?? ""),
              context_before: String(body.context_before ?? ""),
              context_after: String(body.context_after ?? ""),
              line_end: Number(body.line_end ?? 0),
              note: String(body.note ?? ""),
              kind: body.kind === "code" ? "code" : "doc",
              route: "owner_reply",
              images: Array.isArray(body.images) ? body.images : undefined,
            }));
          }
          // 记下后的意见统一由当前责任人处理；受邀检视人保留阅读与批注入口。
          if (request.method === "POST" && parts[3] === "send") {
            if (author !== (target.luban_account ?? "本地用户"))
              return json(response, 403, { error: "只有当前任务责任人可以转交检视意见" });
            const body = await readBody(request);
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
            return json(response, 200,
              await service.sendAnnotations(id, ids, author,
                canOperate(viewer, target.luban_account, !!options.auth), true, String(body.context ?? "")));
          }
          if (request.method === "GET" && parts[3] === "preview") {
            return json(response, 200,
              { text: service.previewAnnotations(id) });
          }
          if (request.method === "POST" && parts.length === 5
              && parts[4] === "reply") {
            const annotationId = decodeURIComponent(parts[3]);
            const body = await readBody(request);
            const annotation = service.listAnnotations(id).items.find((item) =>
              item.id === annotationId);
            if (!annotation) {
              return json(response, 404, { error: `批注 ${annotationId} 不存在` });
            }
            const isOwner = (target.luban_account ?? "本地用户") === author;
            if (!isOwner) {
              return json(response, 403, {
                error: `这条意见需要任务责任人 ${annotation.assignee
                  ?? target.luban_account ?? "（未配置）"} 答复`,
              });
            }
            return json(response, 200, await service.replyToAnnotation(
              id, annotationId, author, String(body.text ?? ""),
              viewer?.role === "admin"));
          }
          // 作者负责提出意见，记下后的修改与删除统一由当前责任人操作。
          if (request.method === "PATCH" && parts.length === 4) {
            const body = await readBody(request);
            if (typeof body.context === "string") return json(response, 200,
              service.supplementAnnotation(id, decodeURIComponent(parts[3]), body.context, author));
            return json(response, 200,
              service.editAnnotation(id, decodeURIComponent(parts[3]),
                String(body.note ?? ""), author));
          }
          // 已交接意见不能删除；新一轮重新处理后可删除，历史仍留账。
          if (request.method === "DELETE" && parts.length === 4) {
            return json(response, 200,
              service.dropAnnotation(id, decodeURIComponent(parts[3]), author,
                viewer?.role === "admin"));
          }
          // 处置权属于当前任务责任人。版本由页面明确提交，服务层再次复核身份。
          if (request.method === "POST" && parts.length === 5
              && ["verify", "resolve", "reopen"].includes(parts[4])) {
            if ((target.luban_account ?? "本地用户") !== author) {
              return json(response, 403, { error: "只有当前任务责任人可以逐条闭环检视意见" });
            }
            const body = await readBody(request);
            if (!Number.isInteger(body.revision) || Number(body.revision) < 0) {
              return json(response, 409, { error: "请刷新意见后逐条处置，缺少当前意见版本" });
            }
            const annotationId = decodeURIComponent(parts[3]);
            if (parts[4] === "reopen") return json(response, 200, await service.reopenAnnotation(
              id, annotationId, author, Number(body.revision)));
            return json(response, 200, service.verifyAnnotation(id, annotationId, author, false, {
              revision: Number(body.revision), outcome: parts[4] === "verify" ? "fixed" : body.outcome,
              reason: String(body.reason ?? ""),
            }));
          }
        }
        // 任务责任人显式补充新上架的团队技能，保留原快照版本。
        if (request.method === "POST" && parts.length === 4 && parts[2] === "skills" && parts[3] === "sync") {
          return json(response, 200, await service.syncTaskSkills(id, viewer?.username ?? "本地用户"));
        }
        // 跑动中插话(本地 CLI 的 ESC 等价物):发送即打断,模型把手头
        // 这一轮做完就收到。权限同决定——插话也是在指挥这一单,不是围观。
        if (request.method === "POST" && parts[2] === "interrupt") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canCollaborate(viewer, target, !!options.auth)) {
            return json(response, 403, { error: "只有任务责任人或受邀协作者可以参与讨论" });
          }
          const body = await readBody(request);
          // @ 知识引用:前端只传结构化标识,正文由服务端解析并在发送时
          // 固定版本——客户端拼正文会绕过注入预算与足迹。
          const references = Array.isArray(body.references)
            ? (body.references as Array<Record<string, unknown>>)
              .map((item) => ({
                kind: String(item?.kind ?? "") as
                  SteerKnowledgeReference["kind"],
                directory: item?.directory === undefined
                  ? undefined : String(item.directory),
                module_id: item?.module_id === undefined
                  ? undefined : String(item.module_id),
                asset_id: item?.asset_id === undefined
                  ? undefined : String(item.asset_id),
              }))
            : undefined;
          const task = await service.interrupt(
            id, service.withConversationAttachments(id, String(body.text ?? ""), body.attachments), viewer?.username, references);
          return json(response, 200, task);
        }
        if (request.method === "POST" && parts[2] === "cross-repository-update") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只有当前子任务责任人可以同步跨仓影响" });
          }
          const body = await readBody(request);
          return json(response, 201, await service.publishCrossRepositoryUpdate(
            id,
            viewer?.username ?? target.luban_account ?? "本地用户",
            String(body.text ?? ""),
          ));
        }
        if (request.method === "POST" && parts[2] === "correct-ticket" && parts.length === 3) {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) return json(response, 403, { error: "只有任务责任人可以纠正单号" });
          const body = await readBody(request);
          if (body.action === "cancel") return json(response, 200, service.cancelTicketCorrection(id));
          return json(response, 202, service.correctTicket(id, {
            ticket: String(body.ticket ?? ""), title: String(body.title ?? ""),
          }, viewer?.username ?? "本地用户"));
        }
        if (request.method === "POST"
            && ["pause", "resume", "cancel"].includes(parts[2])) {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能控制分配给自己的任务" });
          }
          const actor = viewer?.username ?? "本地用户";
          if (parts[2] === "pause") {
            return json(response, 200, await service.pause(id, actor));
          }
          if (parts[2] === "resume") {
            return json(response, 200, service.resume(id, actor));
          }
          return json(response, 200, await service.cancel(id, actor));
        }
        // 重跑一单(run7 实测的运维刚需):环境故障被迫收口的任务,
        // 修好环境后续接内核当前步骤,不从头再来。终态校验在服务层。
        if (request.method === "POST" && parts[2] === "retry") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能重跑分配给自己的任务"
              + (target.luban_account ? `,请联系责任人 ${target.luban_account}` : "") });
          }
          return json(response, 200, service.retry(id, viewer?.username));
        }
        if (parts.length === 3 && parts[2] === "final-mr" && request.method === "POST") {
          const task = storedTask(service, id);
          if (!task) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, task.luban_account, !!options.auth))
            return json(response, 403, { error: "只有任务责任人或管理员可以关联最终 MR" });
          const body = await readBody(request);
          let mrUrl: string;
          try { mrUrl = normalizeRepairMrUrl(body.url); }
          catch (error) { return json(response, 400, { error: humanError(error) }); }
          return json(response, 200, await service.linkFinalMr(id, mrUrl));
        }
        if (parts.length === 3 && parts[2] === "final-mr-comparison" && request.method === "GET") {
          const task = storedTask(service, id);
          if (!task) return json(response, 404, { error: `任务 ${id} 不存在` });
          const comparison = readFinalMrComparison(task, url.searchParams.get("generation") ?? undefined);
          if (!comparison) return json(response, 404, { error: "该轮交付的代码对比尚不可用" });
          response.setHeader("cache-control", "no-store");
          return json(response, 200, comparison);
        }
        if (request.method === "POST" && parts[2] === "refresh-mr" && parts.length === 3) {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) return json(response, 403, { error: "只能操作分配给自己的任务" });
          const body = await readBody(request);
          return json(response, 200, await service.refreshRemoteDelivery(
            id,
            viewer?.username,
            typeof body.mr_id === "string" ? body.mr_id : undefined,
            { administrator: !options.auth || viewer?.role === "admin" },
          ));
        }
        // Build-Fix 失败停机后,人可拍板跳过本地验证,直推流水线裁决。
        if (request.method === "POST"
            && ["build-fix", "prepush"].includes(parts[2])
            && parts[3] === "skip") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能操作分配给自己的任务" });
          }
          return json(response, 200,
            await service.skipPrePushVerification(id, viewer?.username));
        }
        // 人工重跑 Build-Fix:重启杀掉在途轮留下的僵尸现场,或失败停机
        // 后想再来一轮。真在跑时服务端拒绝并明说,兼作活性探针。
        if (request.method === "POST"
            && ["build-fix", "prepush"].includes(parts[2])
            && parts[3] === "retry") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能操作分配给自己的任务" });
          }
          return json(response, 200,
            await service.retryPrePush(id, viewer?.username));
        }
        // 停止在途的 Build-Fix 并直推流水线:收口停机账后立刻绑 HEAD 跳过。
        if (request.method === "POST"
            && ["build-fix", "prepush"].includes(parts[2])
            && parts[3] === "stop") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能操作分配给自己的任务" });
          }
          return json(response, 200,
            await service.stopPrePush(id, viewer?.username));
        }
        if (request.method === "GET" && parts[2] === "delivery-history" && parts.length === 4) {
          const target = storedTask(service, id);
          if (!target?.delivery_history?.some(item => item.archive === parts[3])) return json(response, 404, { error: "交付历史不存在" });
          const archive = continuationHistoryZip(target.workspace, parts[3]);
          response.writeHead(200, { "content-type": "application/zip", "content-length": archive.length,
            "content-disposition": `attachment; filename="${id}-delivery-history.zip"`, "cache-control": "no-store" });
          return response.end(archive);
        }
        if (request.method === "POST" && parts[2] === "continue-delivery") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (options.auth && (!viewer || viewer.role === "admin" || viewer.username !== target.luban_account)) {
            return json(response, 403, { error: "只有该任务责任人可以继续修改" });
          }
          const branchError = target.status === "completed" && finalMrContinuationBlock(target);
          if (branchError) return json(response, 409, { error: branchError });
          const blockers = [...service.launchOptions().blockers, ...personalBlockers(viewer)];
          if (blockers.length) return json(response, 409, { error: "配置未完成，请先补齐：" + blockers.map(item => item.label).join("；"), blockers });
          const body = await readBody(request);
          const result = await service.continueDelivery(id, String(body.text ?? ""),
            String(body.request_id ?? ""), viewer?.username ?? target.luban_account ?? "本地用户");
          options.lubanApproval?.purgeTask(id);
          return json(response, 200, result);
        }
        // 从头重跑会原位覆盖旧任务及其审计现场。管理员不替开发者发起
        // 或冒用其代码身份；鉴权部署下只能由任务本人执行。
        if (request.method === "POST" && parts[2] === "rerun") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (options.auth && (!viewer || viewer.role === "admin"
              || viewer.username !== target.luban_account)) {
            return json(response, 403, { error: "只有该任务责任人可以从头重跑" });
          }
          const blockers = [
            ...service.launchOptions().blockers,
            ...personalBlockers(viewer),
          ];
          if (blockers.length) {
            return json(response, 409, {
              error: "配置未完成,先补齐这些再从头重跑:"
                + blockers.map((item) => item.label).join(";"),
              blockers,
            });
          }
          options.lubanApproval?.purgeTask(id);
          return json(response, 200, await service.rerunFromStart(id));
        }
        // 行为摘要(只读):事件流折叠成人看得过来的分段与异常信号。
        // 权限口径同任务详情;纯展示,不参与任何判定。
        if (request.method === "GET" && parts[2] === "activity") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, await service.activityAsync(id));
        }
        // 会话流(只读):人和 Agent 之间的回合。权限口径同任务详情;
        // 纯展示,不参与判定。
        if (request.method === "GET" && parts[2] === "conversation") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, await service.conversationAsync(id));
        }
        // 交付时间线(只读):现场文件读成人话,权限口径同任务详情
        // ——能看任务就能看它经历了什么。纯展示,不参与判定。
        if (request.method === "GET" && parts[2] === "timeline") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          // 代码工作区经现成的公开方法反推:面板在 <cwd>/.mae-flow-work/
          // 之下,拿不到就交给 buildTimeline 自己在工作区里找。
          const panel = service.panelFile(id, "panel.html")
            ?? service.panelFile(id, "panel-pulse.js");
          const cwd = panel ? dirname(dirname(panel)) : undefined;
          return json(response, 200,
            await buildTimelineAsync(target.workspace, cwd, await service.readDisplayEvents(id)));
        }
        // 越界裁决(单仓拆分负责面门禁):裁决权只在主责任人手里——
        // 单元责任人自己放行自己的越界,边界就形同虚设。
        if (request.method === "POST" && parts[2] === "scope-decision") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          const parent = target.parent_task_id
            ? service.get(target.parent_task_id) : undefined;
          const decider = parent?.luban_account ?? target.luban_account;
          if (!canOperate(viewer, decider, !!options.auth)) {
            return json(response, 403,
              { error: `越界改动只能由主任务责任人 ${
                decider ?? "（账号未配置）"} 裁决，请联系该账号处理` });
          }
          const body = await readBody(request);
          const decision = body.decision === "allow" ? "allow"
            : body.decision === "revert" ? "revert" : undefined;
          if (!decision) {
            return json(response, 400,
              { error: "decision 必须是 allow(放行)或 revert(打回)" });
          }
          return json(response, 200, service.decideScopeViolation(
            id, decision, viewer?.username ?? decider ?? "本地用户"));
        }
        // 问题定位一键采集(只读现场+现查 git/容器):现采现回并留档。
        // 权限口径同任务详情;能看任务就能拿它的诊断包。
        if (request.method === "GET" && parts.length === 3
            && parts[2] === "diagnostics") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          const bundle = await service.exportDiagnostics(id);
          response.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition":
              `attachment; filename="${id}-diagnostics.md"`,
          });
          return response.end(bundle.content);
        }
        if (request.method === "GET" && parts.length === 3 && parts[2] === "diff-review") {
          const review = await service.diffReview(id);
          return json(response, 200, { review: review ?? null });
        }
        if (request.method === "GET" && parts.length === 3
            && parts[2] === "push-review-diff") {
          const scope = url.searchParams.get("scope") === "full"
            ? "full" : "changes";
          const comparison = await service.pushReviewDiff(id, scope);
          if (!comparison) {
            return json(response, 404, {
              error: "当前代码差异暂不可读，请刷新重试",
            });
          }
          return json(response, 200, comparison);
        }
        // Story 只提供版本和设计定位；架构页只读平台内部 architecture.json，
        // 不接受客户端提供任意图源或文件路径。
        if (request.method === "GET" && parts[2] === "architecture" && parts.length <= 4) {
          const load = async () => {
            const target = storedTask(service, id);
            if (!target) return undefined;
            return readArchitectureStory(target, service.artifactRoot(id));
          };
          const loadArchify = (): string | undefined => {
            const target = storedTask(service, id);
            if (!target) return undefined;
            // 主、子任务刷新都发布到各自工作区；优先读取与当前 Story 绑定的发布版本。
            const published = readCurrentStoryArchitecture(target.workspace, readArchitectureStory(target, service.artifactRoot(id))?.content ?? "");
            if (published) return published;
            const root = service.artifactRoot(id);
            if (!root) return undefined;
            const path = join(root, ".mae-flow-work", target.ticket ?? target.id, "architecture.json");
            if (!existsSync(path)) return undefined;
            const stat = statSync(path);
            if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined;
            return readFileSync(path, "utf8");
          };
          const artifact = await load();
          if (!artifact) return json(response, 404, {
            error: storedTask(service, id)?.parent_task_id
              ? "尚无模块 Story，请先完成当前模块设计"
              : "尚无全局 Story，请先完成主任务分析",
          });
          if (artifact.truncated) return json(response, 413, { error: "Story 超过读取上限，请先阅读完整文档" });
          const architecture = loadArchify();
          const projection = storyArchitecture(artifact.content, architecture);
          response.setHeader("cache-control", "no-store");
          if (parts.length === 3) return json(response, 200, {
            ...projection, renderer: ARCHIFY_COMMIT,
            diagrams: projection.diagrams.map(({ source: _source, ...diagram }) => diagram),
          });
          if (url.searchParams.get("revision") !== projection.revision) {
            return json(response, 409, { error: "Story 已更新，请刷新架构图" });
          }
          const diagram = projection.diagrams.find((item) => item.id === parts[3]);
          if (!diagram) return json(response, 404, { error: "当前 Story 中没有这张图" });
          const result = await renderArchify(diagram.source);
          const after = await load();
          if (!after || after.content !== artifact.content || loadArchify() !== architecture) {
            return json(response, 409, { error: "生成期间 Story 或平台图源已更新，请刷新架构图" });
          }
          return json(response, 200, { ...result, revision: projection.revision });
        }
        // 检视产物(只读):决策与证据必须同屏——审批卡问"Spec 确认吗",
        // spec.md 就该在旁边,而不是让人跳到另一套界面里翻。权限口径
        // 同任务详情;能读哪些文件由 artifacts.ts 的白名单把守。
        if (request.method === "GET" && parts[2] === "artifacts") {
          const target = storedTask(service, id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          const root = service.artifactRoot(id);
          const sources = {
            pipelineRoot: join(target.workspace, "pipeline"),
            taskMaterialRoot: target.workspace,
            publishedStory: !!currentStoryFile(target.workspace),
            analysisStory: target.requirement_graph && !target.parent_task_id && !isMainTaskDelivery(target)
              ? `${target.ticket ?? target.id}/story.md` : undefined,
          };
          if (parts.length === 3) {
            // 代码现场尚未 init 时也可能已有任务级流水线补证材料；两路
            // 独立 fail-open，不能用 root 缺失把 pipeline/ 一起吞掉。
            const kind = url.searchParams.get("kind");
            return json(response, 200,
              await listArtifactsAsync(root, sources,
                kind === "doc" || kind === "diff" ? kind : undefined));
          }
          if (parts.length === 4 && parts[3] === "archive") {
            let archive;
            try {
              archive = bundleArtifactDocuments(root, sources);
            } catch (reason) {
              if (reason instanceof ArtifactArchiveTooLargeError) {
                return json(response, 413, { error: reason.message });
              }
              throw reason;
            }
            if (!archive) {
              return json(response, 409, { error: "暂无可打包的过程文档" });
            }
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
            return response.end(archive.data);
          }
          if (parts.length === 4 && parts[3] === "file-diff") {
            const path = url.searchParams.get("path") ?? "";
            const diff = await readArtifactFileDiffAsync(root, path);
            if (!diff) {
              return json(response, 404, {
                error: "这个文件已不在当前工作区变更中，请刷新后重试",
              });
            }
            return json(response, 200, diff);
          }
          if (parts.length === 4 && parts[3] === "change-directory") {
            const path = url.searchParams.get("path") ?? "";
            const offset = Number.parseInt(
              url.searchParams.get("offset") ?? "0", 10);
            const page = await listArtifactChangeDirectoryAsync(
              root, path, Number.isFinite(offset) ? offset : 0);
            if (!page) {
              return json(response, 404, {
                error: "这个目录已不在当前未跟踪变更中，请刷新后重试",
              });
            }
            return json(response, 200, page);
          }
          // name 里带 `/`(单号目录/文件名):编码与未编码两种形态都收。
          const name = decodeURIComponent(parts.slice(3).join("/"));
          const artifact = await readArtifactAsync(root, name, sources);
          if (!artifact) {
            return json(response, 404,
              { error: `没有可检视的产物「${name}」` });
          }
          return json(response, 200, artifact);
        }
        // 审计读侧(§11):外部动作台账来自 PG 投影。没配投影时
        // 明说,而不是空数组装作"没有动作"。
        if (request.method === "GET" && parts[2] === "actions") {
          const projection = service.options.projection;
          if (!projection) {
            return json(response, 404,
              { error: "未配置 PostgreSQL 投影(--pg),没有台账可查" });
          }
          return json(response, 200, await projection.listActions(id));
        }
        // 内核现场面板(铁原则:请用户检视的东西必须在面板可见)。
        // panel 是内核生成的单文件 HTML,pulse/stamp 是它的自动刷新
        // 探针(相对路径 script src),同前缀一起放行。
        if (request.method === "GET" && parts.length === 3
            && ["panel", "panel-pulse.js", "panel-stamp.js"]
              .includes(parts[2])) {
          const name = parts[2] === "panel" ? "panel.html" : parts[2];
          const file = service.panelFile(id, name);
          if (!file) {
            return json(response, 404, {
              error: "这个任务还没有现场面板(流程未初始化或演练模式)",
            });
          }
          response.writeHead(200, {
            "content-type": name.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/html; charset=utf-8",
          });
          return response.end(readFileSync(file));
        }
      }
      return json(response, 404, { error: "未知路径" });
    } catch (error) {
      if (error instanceof KnowledgeAnswerError) return json(response, error.status, { error: error.message });
      if (error instanceof RequestBodyTooLargeError) {
        return json(response, 413, { error: error.message });
      }
      if (error instanceof StateConflictError) {
        // 先到决定生效:后到的提交必须知道自己没生效,不能静默吞掉。
        const message = error.message.startsWith("任务状态已变化")
          ? error.message : `任务状态已变化: ${error.message}`;
        return json(response, 409, { error: message });
      }
      if (error instanceof TaskControlError) {
        return json(response, 409, { error: error.message });
      }
      if (error instanceof NotFoundError) {
        return json(response, 404, { error: error.message });
      }
      if (error instanceof AnnotationPermissionError) {
        return json(response, 403, { error: error.message });
      }
      if (error instanceof AnnotationConflictError) {
        return json(response, 409, { error: error.message });
      }
      if (error instanceof AnnotationError) {
        return json(response, 400, { error: error.message });
      }
      return json(response, 500, { error: humanError(error) });
    }
  });
}

function canOperate(
  viewer: AuthUser | undefined,
  taskAccount: string | undefined,
  authEnabled: boolean,
): boolean {
  if (!authEnabled) return true;
  return viewer?.role === "admin"
    || (!!viewer && !!taskAccount && viewer.username === taskAccount);
}

function canCollaborate(
  viewer: AuthUser | undefined,
  task: {
    luban_account?: string;
    collaborators?: string[];
    requirement_graph?: RequirementGraph;
  },
  authEnabled: boolean,
): boolean {
  if (canOperate(viewer, task.luban_account, authEnabled)) return true;
  if (!viewer || task.requirement_graph?.stage !== "analysis") return false;
  return task.collaborators?.includes(viewer.username) === true
    || task.requirement_graph.repositories.some((repository) =>
      repository.assignee === viewer.username);
}

function sessionCookie(
  token: string,
  request: import("node:http").IncomingMessage,
  expired = false,
): string {
  const secure = request.headers["x-forwarded-proto"] === "https"
    ? "; Secure"
    : "";
  const age = expired ? 0 : 365 * 24 * 60 * 60;
  return `mae_flow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; `
    + `SameSite=Strict; Max-Age=${age}${secure}`;
}

/** webRoot 内定位静态文件:/ → index.html。resolve 后必须仍在
 * webRoot 里——路径穿越不是 404 的一种,是攻击,直接不认。 */
function staticFile(
  webRoot: string,
  pathname: string,
): string | undefined {
  const root = resolve(webRoot);
  const target = resolve(
    join(root, pathname === "/" ? "index.html" : pathname));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return existsSync(target) && statSync(target).isFile()
    ? target
    : undefined;
}

/** SSE:先重放事件日志,再轮询追加行;客户端断开即停。
 *
 * 增量读:按字节偏移只取新增部分——整文件重读在长日志下是
 * O(n²) 读放大(run7 现场几百 KB,每 300ms 全量读一遍)。
 * 事件行必须完整推送:尾部没换行的半行(写入方还在写)连同
 * 可能被读界切开的 UTF-8 多字节字符一起留在 carry(按字节存,
 * 提前解码就是乱码),凑齐换行才出手。 */
function streamEvents(
  service: TaskService,
  id: string,
  response: import("node:http").ServerResponse,
): void {
  streamJsonlAsSse(service, id, response, () => service.eventLogPath(id));
}

function storedTask(service: TaskService, id: string) {
  return service.storedTaskSummary ? service.storedTaskSummary(id) : service.get(id);
}

function streamJsonlAsSse(
  service: TaskService,
  id: string,
  response: import("node:http").ServerResponse,
  resolvePath: () => string | undefined,
): void {
  if (!storedTask(service, id)) {
    return json(response, 404, { error: `任务 ${id} 不存在` });
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.flushHeaders();
  let activePath: string | undefined;
  let offset = 0;
  let carry: Buffer[] = [], carryBytes = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string[] = [], next = 0;
  let hasMore = false;
  let inode: number | undefined;
  response.on("close", () => {
    closed = true; clearTimeout(timer); response.removeListener("drain", push); pending = []; carry = []; carryBytes = 0;
  });
  const push = () => {
    if (closed) return;
    while (next < pending.length) {
      const line = pending[next++];
      if (line.trim() && !response.write(`data: ${line}\n\n`)) {
        response.once("drain", push); return;
      }
    }
    pending = []; next = 0;
    const path = resolvePath();
    if (path !== activePath) {
      // 换文件(prepush 换轮)= 新的一份日志,从头放;半行缓存作废。
      activePath = path;
      offset = 0;
      carry = []; carryBytes = 0;
      inode = undefined;
    }
    hasMore = false;
    if (path && existsSync(path)) {
      const stat = statSync(path);
      if (inode !== stat.ino || stat.size < offset) { offset = 0; carry = []; carryBytes = 0; }
      inode = stat.ino;
      const fd = openSync(path, "r");
      let read = 0;
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(Math.min(256 * 1024, Math.max(0, stat.size - offset)));
        read = readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      offset += read;
      hasMore = offset < stat.size;
      chunk = chunk.subarray(0, read);
      const cut = chunk.lastIndexOf(0x0a);
      if (cut >= 0) {
        const complete = Buffer.concat([...carry, chunk.subarray(0, cut)], carryBytes + cut).toString("utf-8");
        carry = []; carryBytes = 0;
        pending = complete.split("\n");
      }
      if (cut + 1 < chunk.length) {
        const rest = Buffer.from(chunk.subarray(cut + 1)); carry.push(rest); carryBytes += rest.length;
      }
    }
    const status = storedTask(service, id)?.status;
    if (!hasMore && !pending.length && (status === "completed" || status === "failed" || status === "canceled")) {
      response.end();
      return;
    }
    timer = setTimeout(push, hasMore || pending.length ? 0 : 300);
  };
  push();
}
