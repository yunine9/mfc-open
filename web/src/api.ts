import { issueApiUrl } from "./issues/issueLink";
import type { CompletionRange } from "../../src/completionRange";
import { invalidateKnowledgeReads } from "./knowledgeReadCache";
import { resolveTaskDemoAsset } from "./taskDemoSandbox";
import type { MrParticipantsResult } from "../../src/mrParticipants";
import type { ComponentKnowledgeCheckReport } from "../../src/componentKnowledgeTypes";
import type { KnowledgeProductionView } from "../../src/knowledgeProductionTypes";
import type { AnnotationSubmissionView } from "../../src/annotationSubmissionView";
export type { AnnotationSubmissionView } from "../../src/annotationSubmissionView";
import type { DependencyAdjustment, EarlyStartInput, EarlyStartPreview } from "../../src/dependencySchedulingTypes";
export type { EarlyStartPreview } from "../../src/dependencySchedulingTypes";
/**
 * 任务 API 的类型化镜像。前端不推断状态(主 spec §5.1):
 * 这里的类型就是 taskService.TaskSummary 的形状,文案与判断
 * 全部来自服务端镜像,前端只负责呈现与提交决定。
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "waiting_for_human"
  | "coordinating"
  | "completed"
  | "verifying"
  | "await_merge"
  | "canceled"
  | "failed";

export interface DeliveryFile { path: string; label: string; previous?: string }
export interface PushFileList {
  branch: string; head_sha: string; base_sha?: string;
  comparison?: "remote_branch" | "target_branch";
  files?: DeliveryFile[]; unavailable_reason?: string;
}

export const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "进行中",
  pausing: "正在暂停",
  paused: "已暂停",
  waiting_for_human: "等你决定",
  coordinating: "子任务进行中",
  completed: "已完成",
  failed: "出错了",
  verifying: "代码已提交,流水线验证中",
  await_merge: "已提合入请求,等待合入",
  canceled: "已取消",
};

/** 修复停机(需人工):服务端 taskFocus.projectRepairStopped 的镜像,与
 * retry 准入同源——只有这时 verifying 的任务才给重跑按钮(在途验证点重跑
 * =重复烧流水线)。2026-09-06 起前端不再按 loop/prepush 自己判。 */
export function repairStopped(task: { repair_stopped?: boolean }): boolean {
  return task.repair_stopped === true;
}

/** 状态短文案:服务端 status_label 的镜像(taskFocus.projectStatusLabel)。
 * 只知道状态码的地方(跨仓子任务行、历史)退回状态词表——那是词典不是推断。 */
export function statusText(task: {
  status: TaskStatus;
  status_label?: string;
}): string {
  return task.status_label ?? STATUS_TEXT[task.status] ?? task.status;
}

export type UserRole = "admin" | "developer";

/** 个人模型网关(ADR-0068)的掩码视图:配没配齐、网关地址/模型名/
 * 接口格式明文与密钥末 4 位——密钥本体永不回传,与服务端 auth.ts
 * 的 PersonalModelsView 同形。 */
export interface PersonalModelsView {
  configured: boolean;
  url?: string;
  model?: string;
  api?: string;
  key_hint?: string;
}

export interface AuthUser {
  username: string;
  display_name?: string;
  role: UserRole;
  /** 管理员配置的可选检视人；不是角色，也不会自动收到任务通知。 */
  committer?: boolean;
  /** 自动接单开关(ADR-0061,2026-10-10 修订迁入个人设置):true=本人
   *  已开启,名下符合条件的新 DTS 单由平台定时自动发起。缺省关闭。 */
  issue_auto_claim?: boolean;
  /** 个人 Git 令牌的掩码提示(••••末4位);没配则缺席。只写不读:
   * 明文永远不会出现在任何 API 响应里。 */
  git_token_hint?: string;
  /** 署名邮箱(必填,commit 归属与平台对人都按它)。git 用户名即登录
   * 账号名,不另配。非密,可回显。 */
  git_email?: string;
  /** 个人通知令牌的掩码提示;同样只写不读。通知以令牌对应的人的
   * 身份发,所以按人配——管理员配一个服务号,大家收到的都是机器人。 */
  luban_token_hint?: string;
  /** 月光模式(免审批):开着时本人**需求交付**任务的人工节点自动放行。 */
  moonlight?: boolean;
  /** push 前清单过目的个人默认。缺省即开:只有显式 false 是关。 */
  push_confirmation?: boolean;
  /** 问题处理介入档位(ADR-0019 按流剥离):三档缺省二档,与需求侧
   * 两轴互不带动。 */
  issue_intervention_tier?: "1" | "2" | "3";
  /** 个人模型网关(ADR-0068)的掩码视图:配齐后本人名下任务的主模型
   * 调用整体走它,清空即回落平台网关。密钥只写不读,只回末 4 位。
   * /auth/users 等公开视图不带这个字段,缺席=没配置。 */
  personal_models?: PersonalModelsView;
}

/** 给协作界面显示姓名的最窄成员视图；不携带角色、权限或个人配置。 */
export interface PersonIdentity {
  username: string;
  display_name?: string;
}

export interface CollaborationAssignee {
  username: string;
  display_name?: string;
  ready: boolean;
  missing: string[];
}

export type WishKind = "wish" | "issue";
export type WishStatus = "open" | "accepted" | "done" | "declined";

export interface WishWallImage {
  id: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  url: string;
}

export interface WishWallItem {
  id: string;
  kind: WishKind;
  title: string;
  detail?: string;
  author: string;
  created_at: string;
  status: WishStatus;
  decision_note?: string;
  decided_by?: string;
  decided_at?: string;
  images: WishWallImage[];
  votes: number;
  viewer_voted: boolean;
  can_delete: boolean;
  can_manage: boolean;
}

export interface WishImageUpload {
  mime_type: string;
  content_base64: string;
}

export async function importIssueMr(mrUrl: string): Promise<IssueSummary> {
  const response = await fetch("/pipeline-repairs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mr_url: mrUrl }) });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listWishes(): Promise<WishWallItem[]> {
  const response = await fetch("/wishes");
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json() as { wishes: WishWallItem[] }).wishes;
}

export async function createWish(input: {
  kind: WishKind;
  title: string;
  detail?: string;
  images: WishImageUpload[];
}): Promise<WishWallItem> {
  const response = await fetch("/wishes", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function setWishVote(
  id: string,
  voted: boolean,
): Promise<WishWallItem> {
  const response = await fetch(`/wishes/${encodeURIComponent(id)}/vote`, {
    method: "POST",
    body: JSON.stringify({ voted }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function setWishStatus(
  id: string,
  status: WishStatus,
  note?: string,
): Promise<WishWallItem> {
  const response = await fetch(`/wishes/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, note }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function deleteWish(id: string): Promise<void> {
  const response = await fetch(`/wishes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await errorText(response));
}

export interface MoonlightPreview {
  waiting: number;
  eligible: number;
  blocked_annotations: number;
  blocked_other: number;
}

export async function getMoonlightPreview(): Promise<MoonlightPreview> {
  const response = await fetch("/auth/me/moonlight-preview");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 默认只影响后续节点；当前待办必须在用户看过预览后显式提交。 */
export async function putMoonlight(
  on: boolean,
  includeCurrent = false,
  expectedEligible?: number,
): Promise<{ moonlight: boolean; swept: number } & MoonlightPreview> {
  const response = await fetch("/auth/me/moonlight", {
    method: "PUT",
    body: JSON.stringify({
      on,
      include_current: includeCurrent,
      expected_eligible: expectedEligible,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** push 前清单过目的个人默认(缺省即开)。 */
export async function putPersonalPushConfirmation(
  on: boolean,
): Promise<AuthUser> {
  const response = await fetch("/auth/me/push-confirmation", {
    method: "PUT",
    body: JSON.stringify({ on }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 问题处理介入档位(ADR-0019 按流剥离):一档全自动、二档优先报告
 * (缺省)、三档优先对齐。现读现判、切换即刻生效,不追溯已
 * 挂起的卡,没有需求侧月光的预览/清扫动作。 */
export async function putIssueInterventionTier(
  tier: "1" | "2" | "3",
): Promise<AuthUser> {
  const response = await fetch("/auth/me/issue-intervention", {
    method: "PUT",
    body: JSON.stringify({ tier }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** push 前人工确认开关。已推送后再开会 409,如实提示。 */
export async function putPushConfirmation(
  taskId: string,
  on: boolean,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/push-confirmation`, {
      method: "PUT",
      body: JSON.stringify({ on }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function putTaskApprovalMode(
  taskId: string,
  mode: "inherit" | "manual" | "moonlight",
  includeCurrent = false,
): Promise<{ task: TaskSummary; swept: number; blocked_annotations: number }> {
  const response = await fetch(`/tasks/${taskId}/moonlight`, {
    method: "PUT",
    body: JSON.stringify({ mode, include_current: includeCurrent }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 响应体按调用方声明的类型解出来。根 tsconfig 用的是 node 的 fetch 类型,
 * `json()` 返回 unknown;原来 140 处直接 return,根 typecheck 一直是红的,
 * 闸门形同虚设(2026-09-06)。这里不做运行时校验——前端一切文案来自服务端
 * 镜像,形状契约由服务端测试兜底。 */
async function parseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

/** 出错响应体:只承诺可能有 error 字段,其余字段一律 unknown。 */
async function errorBody(response: Response): Promise<{ error?: string } & Record<string, unknown>> {
  return await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>;
}

async function errorText(response: Response): Promise<string> {
  const body = await errorBody(response);
  return String(body.error ?? `HTTP ${response.status}`);
}

export async function getSession(signal?: AbortSignal): Promise<AuthUser | null> {
  const response = await fetch("/auth/me", { signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function login(
  username: string,
  password: string,
): Promise<AuthUser> {
  const response = await fetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}

/** 设置/更换/删除(传空串)自己的 Git 令牌+署名邮箱(必填)。
 * 回的只有掩码+邮箱;git 用户名即登录账号名,不另配。 */
export async function putGitToken(
  token: string,
  gitEmail?: string,
): Promise<{
  git_token_hint?: string;
  git_email?: string;
}> {
  const response = await fetch("/auth/me/git-token", {
    method: "PUT",
    body: JSON.stringify({ token, git_email: gitEmail }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function putLubanToken(
  token: string,
): Promise<{ luban_token_hint?: string }> {
  const response = await fetch("/auth/me/luban-token", {
    method: "PUT",
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 用已保存的个人 Token 走一遍正式通知服务发送链路。 */
export async function testLubanConnection(): Promise<{
  ok: true;
  message: string;
}> {
  const response = await fetch("/auth/me/luban-test", { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 模型网关四字段表单(地址/密钥/模型/接口格式):平台网关(管理页)与
 * 个人网关(ADR-0068,个人设置)同一套口径——api_key 留空=沿用已存
 * (界面永远不回填明文),其余字段缺席=沿用已存。 */
export interface ModelsFormFields {
  url?: string;
  api_key?: string;
  model?: string;
  api?: string;
}

/** 保存/更换个人模型网关(ADR-0068):四字段与平台网关同一套合并
 * 口径。谁登录配谁的;回的只有掩码视图。 */
export async function putPersonalModels(
  body: ModelsFormFields & {
    /** true=删除个人网关,名下任务回落平台网关。 */
    clear?: boolean;
  },
): Promise<PersonalModelsView> {
  const response = await fetch("/auth/me/models", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 清除个人模型网关:等价于 putPersonalModels({ clear: true })。 */
export function clearPersonalModels(): Promise<PersonalModelsView> {
  return putPersonalModels({ clear: true });
}

/** 个人网关连通性测试:测当前表单草稿,密钥留空时服务端沿用已存,
 * 与保存同一口径。个人通道没有部署层兜底——没配又没草稿时服务端
 * 明说"没得测",不拿平台网关凑数。 */
export async function postPersonalModelsCheck(
  body: ModelsFormFields,
): Promise<SystemCheckResult> {
  const response = await fetch("/auth/me/models/check", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listUsers(): Promise<AuthUser[]> {
  const response = await fetch("/auth/users");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listPeople(): Promise<PersonIdentity[]> {
  const response = await fetch("/auth/people");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listCollaborationAssignees(
  /** "issue":问题登记指派的固定映射(ADR-0031)——只认 Git 令牌+邮箱,
   * 不问通知服务令牌;映射在服务端,客户端只点名场景。 */
  flow?: "issue",
): Promise<CollaborationAssignee[]> {
  const response = await fetch(flow
    ? `/auth/collaboration-assignees?flow=${flow}`
    : "/auth/collaboration-assignees");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole,
  displayName?: string,
): Promise<AuthUser> {
  const response = await fetch("/auth/users", {
    method: "POST",
    body: JSON.stringify({ username, password, role, display_name: displayName }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function putUserDisplayName(
  username: string,
  displayName: string,
): Promise<AuthUser> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}/display-name`, {
      method: "PUT",
      body: JSON.stringify({ display_name: displayName }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 管理员重置密码:内部平台,不验旧密码(忘了就找管理员)。 */
export async function resetUserPassword(
  username: string,
  password: string,
): Promise<void> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}/password`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    });
  if (!response.ok) throw new Error(await errorText(response));
}

/** 管理员删账号(物理删除;不能删自己/最后一个管理员,服务端把关)。 */
export async function deleteUser(username: string): Promise<void> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorText(response));
}

export async function listCommitters(): Promise<AuthUser[]> {
  const response = await fetch("/auth/committers");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function putCommitter(
  username: string,
  on: boolean,
): Promise<AuthUser> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}/committer`, {
      method: "PUT",
      body: JSON.stringify({ on }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 自动接单开关(ADR-0061,2026-10-10 修订):个人自助,谁登录改谁的,
 *  缺省关闭。管理员账号服务端拒收(管理员不处理问题单)。 */
export async function putMyIssueAutoClaim(on: boolean): Promise<AuthUser> {
  const response = await fetch("/auth/me/issue-auto-claim", {
    method: "PUT",
    body: JSON.stringify({ on }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 自动接单下次发起时刻(个人设置问号悬停卡的数据源)。null=调度器
 *  未装配或管理员把扫描间隔设为 0(前端显示「已暂停」)。 */
export async function getIssueAutoClaimNextRun(): Promise<{
  next_run_at: string | null;
}> {
  const response = await fetch("/issues/auto-claim");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 多仓需求图的结构化确认:消费同一张人工检视卡并恢复分析会话，
 * 随后幂等生成各仓交付；不是独立于审批卡之外的第二套状态。 */
export async function confirmRequirementGraph(
  taskId: string,
  repositoryAssignees?: Record<string, string>,
  repositoryTickets?: Record<string, string>,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/graph/confirm`, {
      method: "POST",
      body: JSON.stringify({ repository_assignees: repositoryAssignees,
        repository_tickets: repositoryTickets }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function putRepositoryAssignees(
  taskId: string,
  repositoryAssignees: Record<string, string>,
  repositoryTickets?: Record<string, string>,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/repository-assignees`, {
      method: "PUT",
      body: JSON.stringify({ repository_assignees: repositoryAssignees,
        repository_tickets: repositoryTickets }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function putTaskCollaborators(
  taskId: string,
  collaborators: string[],
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/collaborators`, {
      method: "PUT",
      body: JSON.stringify({ collaborators }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function requestCommitterReview(
  taskId: string,
  committer: string,
): Promise<ReviewRequest> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/review-request`, {
    method: "POST",
    body: JSON.stringify({ committer }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface ReviewRequest {
  id: string;
  task_id: string;
  task_title: string;
  requester: string;
  committer: string;
  status: "pending" | "completed" | "canceled";
  created_at: string;
  completed_at?: string;
  canceled_at?: string;
  delivered: boolean;
  attempts: number;
  last_error?: string;
}

export async function listMyReviews(): Promise<ReviewRequest[]> {
  const response = await fetch("/reviews/mine");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listTaskReviews(taskId: string): Promise<ReviewRequest[]> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/reviews`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function completeReview(reviewId: string): Promise<ReviewRequest> {
  const response = await fetch(
    `/reviews/${encodeURIComponent(reviewId)}/complete`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface WaitingQuestion {
  question: string;
  options?: string[];
}

export interface TaskProgress {
  phases: string[];
  current_index: number;
  current_phase: string;
  /** 稳定内核步骤 ID；界面仍展示 step 人话标题。 */
  step_id?: string;
  step?: string;
  revision?: number;
  /** 子任务里程碑由服务端透传；缺席时沿用原有阶段进度展示。 */
  milestone?: {
    task_id: string;
    title: string;
    event: "started" | "completed" | "blocked";
    reason?: string;
  };
}

/** Cloud 在每次 push 前运行的独立验证会话。它不属于内核流程状态，
 * 因此只作为 delivery 的可选事实镜像；旧后端不返回时前端保持原样。 */
export type PrepushState =
  | "queued"
  | "preparing"
  | "compiling"
  | "testing"
  | "repairing"
  | "blocked"
  | "environment_error"
  | "passed";

export interface PrepushVerification {
  state: PrepushState | (string & {});
  /** 自动修复轮次；只有 Cloud 启动修复 Agent 后才会出现。 */
  round?: number;
  /** 当前动作或异常摘要，由 Cloud 原样透传。 */
  message?: string;
  /** 本次验证绑定的提交；push 只能复用同一 SHA 的通过结果。 */
  sha?: string;
  updated_at?: string;
}

/** 当前 serve 对 Build-Fix 的真实执行所有权；与可持久化领域阶段分开。 */
export interface PrepushRuntime {
  state: "running" | "recovering" | "interrupted" | "stopped" | "idle";
  message: string;
}

export interface TaskTokenUsage {
  /** 均为模型提供方真实上报；服务端不做字符数估算。 */
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** 最近 60 秒吞吐；没有新响应时会自然归零。 */
  input_tokens_per_minute: number;
  output_tokens_per_minute: number;
  rate_window_seconds: 60;
  updated_at: string;
  source: "provider";
}

export interface WorkflowPlanItem {
  id: string;
  kind: "activity" | "knowledge" | "skill" | "agent" | "tool" | "instruction";
  title: string;
  description?: string;
  locked: boolean;
  editable: boolean;
  source: "platform" | "workflow" | "task";
  slot?: string;
  asset_ref?: WorkflowAssetRef;
  instructions?: string;
  use?: { mode: "available" | "when_needed" | "on_stage_enter" | "before_item";
    anchor?: string };
}

export interface WorkflowAssetRef {
  registry: "business_knowledge" | "team_skill"
    | "repository_skill" | "platform_capability";
  id: string;
  version: string;
  digest: string;
  nature?: "business" | "engineering";
  form?: "document" | "skill" | "rule" | "example";
  business_module_id?: string;
  repository?: string;
  revision?: string;
  relative_path?: string;
}

export type WorkflowEdit =
  | { edit_id: string; stage_id: string; op: "add";
      item: WorkflowPlanItem; position?: { before?: string; after?: string } }
  | { edit_id: string; stage_id: string; op: "remove"; target_id: string }
  | { edit_id: string; stage_id: string; op: "replace"; target_id: string;
      item: WorkflowPlanItem }
  | { edit_id: string; stage_id: string; op: "move"; target_id: string;
      position: { before?: string; after?: string } }
  | { edit_id: string; stage_id: string; op: "configure"; target_id: string;
      use?: WorkflowPlanItem["use"]; instructions?: string };

export interface WorkflowDefinition {
  schema: "mae-flow-workflow-definition/1";
  base: { standard_id: string; standard_version: string;
    catalog_digest: string };
  applicability: {
    business_module_ids: string[];
    repositories: string[];
    technologies: string[];
  };
  edits: WorkflowEdit[];
}

export interface WorkflowDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  fallback?: string;
  stage_id?: string;
  item_id?: string;
}

export interface WorkflowStagePlan {
  id: string;
  title: string;
  phase: string;
  steps: string[];
  slots: Array<{ id: string; cardinality: "one" | "many" }>;
  items: WorkflowPlanItem[];
}

export interface WorkflowExecutionProfile {
  schema: "mae-flow-execution-profile/2";
  revision: string;
  source: { kind: "platform" | "workflow" | "task";
    id: string; label?: string; version?: string; digest?: string };
  /** 两快照可整体缺席(supplement-only:只写了文字补充、没选工作流
   * 的任务),此时按平台默认方案执行、只叠 supplements。 */
  base_snapshot?: { standard_id: string; standard_version: string;
    catalog_digest: string; stages: WorkflowStagePlan[] };
  final_snapshot?: { standard_id: string; standard_version: string;
    catalog_digest: string; stages: WorkflowStagePlan[] };
  edits: WorkflowEdit[];
  asset_manifest: Array<WorkflowAssetRef & {
    state: "available" | "unavailable" | "incompatible";
    snapshot_path?: string;
    diagnostic?: string;
  }>;
  diagnostics: WorkflowDiagnostic[];
  /** 文字建议层(v1 执行补充退役并入,2026-08-29)。 */
  supplements?: Array<{
    scope: "team" | "business_module" | "repository" | "task";
    source_id: string;
    title: string;
    instructions: string;
  }>;
}

/** 资产库/编辑器语境的标准快照(必有结构);任务档上的
 * base/final 才可能缺席(supplement-only)。 */
export type WorkflowStandardBase =
  NonNullable<WorkflowExecutionProfile["base_snapshot"]>;

export type WorkflowAssetStatus =
  | "draft" | "pending_review" | "published" | "archived";

export interface WorkflowAssetSummary {
  id: string;
  name: string;
  description?: string;
  scope: "personal" | "team";
  owner: string;
  maintainers: string[];
  status: WorkflowAssetStatus;
  latest_version: number;
  draft_revision: number;
  copied_from?: WorkflowExecutionProfile["source"];
  selectable_for_tasks: boolean;
  technology_assignment_required?: true;
  /** 最新已知适用范围;缺席=旧资产未声明,列表按"未限定"展示。 */
  applicability?: {
    business_module_ids: string[];
    repositories: string[];
    technologies: string[];
  };
  updated_at: string;
  permissions: {
    can_view: boolean;
    can_edit: boolean;
    can_submit: boolean;
    can_publish: boolean;
    can_archive: boolean;
  };
}

export interface WorkflowDraftRecord {
  schema: "mae-flow-workflow-draft/1";
  revision: number;
  definition: WorkflowDefinition;
  digest: string;
  updated_at: string;
  updated_by: string;
}

export interface WorkflowAssetDetail {
  asset: WorkflowAssetSummary;
  draft: WorkflowDraftRecord;
  versions: Array<{ version: number; digest: string;
    published_at: string; published_by: string }>;
}

export interface WorkflowAssetCatalogItem {
  ref: WorkflowAssetRef;
  type: "knowledge" | "skill" | "agent" | "tool" | "capability";
  title: string;
  summary: string;
  when_to_use?: string;
  nature?: "business" | "engineering";
  form?: "document" | "skill" | "rule" | "example";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  availability: "available" | "unavailable";
  warning?: string;
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
    source: "platform_default" | "workflow" | "task";
    selection_reason: string;
  };
  contract: {
    human_decision: boolean;
    evidence: Array<{ type: string; label: string }>;
    outputs: string[];
  };
  activities: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    source?: "platform_default" | "customized";
  }>;
  resources: Array<{
    id: string;
    kind: "guidance" | "standard" | "agent" | "platform" | "knowledge"
      | "skill" | "tool";
    name: string;
    ref?: string;
    usage: "required" | "when_needed" | "on_demand";
    preferred?: boolean;
  }>;
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
    /** 文字建议层(v2 supplements;plan 契约沿用 layers 旧名)。 */
    layers: Array<{
      scope: "team" | "business_module" | "repository" | "task";
      source_id: string;
      title: string;
      instructions: string;
    }>;
    workflow_source?: { kind: "platform" | "workflow" | "task";
      id: string; version?: string; digest?: string };
    diagnostics?: WorkflowDiagnostic[];
  };
}

export interface ExecutionPlaybookOption {
  id: string;
  version: string;
  title: string;
  summary: string;
  phase: string;
  activities: ExecutionPlan["activities"];
  resources: ExecutionPlan["resources"];
}

export interface PushReviewPresentation {
  kind: "delivery" | "feedback" | "pipeline" | "conflict" | "rework";
  title: string;
  description: string;
  base_sha: string;
  baseline_sha: string;
  head_sha: string;
  has_focused_changes: boolean;
  file_count: number;
  additions: number;
  deletions: number;
  /** 设置时 additions/deletions 是占位 0,界面必须显示原因而不是 +0/−0。 */
  stats_unavailable_reason?: string;
  commits: Array<{ sha: string; subject: string }>;
  all_paths: string[];
  committed_paths: string[];
  agent_note?: string;
  verification?: string;
}

export type FeedbackSource = "workspace" | "build_fix" | "pipeline"
  | "mr_discussion" | "conflict" | "scope" | "push_confirmation";
export type FeedbackStatus = "open" | "repairing" | "addressed"
  | "awaiting_verification" | "closed" | "needs_human" | "deferred"
  | "superseded" | "superseded_by_merge";
export interface FeedbackRecord {
  id: string;
  batch_id: string;
  source: FeedbackSource;
  source_id: string;
  source_revision: number;
  observed_sha: string;
  summary: string;
  material?: string;
  file?: string;
  line?: number;
  /** CodeHub 检视人显示名;机器来源没有。 */
  author?: string;
  verification: string;
  status: FeedbackStatus;
  resolution?: string;
  updated_at: string;
}

export interface RequirementSourceMeta {
  id: string;
  name: string;
  path: string;
  bytes: number;
  digest: string;
  document_count?: number;
  locations?: string[];
}

export interface TaskSummary {
  origin?: "requirement" | "issue";
  delivery_report?: { status: "running" | "completed" | "partial" | "failed"; available: boolean; message: string; head: string };
  continuation?: { id: string; text: string; actor: string; at: string; state: "preparing" | "failed" | "active"; error?: string; branch: string; baseline: string };
  delivery_history?: Array<{ id: string; started_at: string; completed_at: string; delivery: TaskSummary["delivery"]; request?: string; archive: string }>;
  delivery_generation?: string;
  delivery_started_at?: string;
  id: string;
  title?: string;
  requirement: string;
  requirement_analysis_confirmation_required?: boolean;
  requirement_analysis_confirmed_at?: string;
  /** 本单落下的记忆条数;明细走 listTaskMemories。 */
  memories_recorded?: number;
  requirement_revision?: {
    id: string;
    state: "running" | "failed";
    annotation_ids: string[];
    started_at: string;
    finished_at?: string;
    error?: string;
  };
  /** 已完成的每一轮需求修改;对比按 id 另取。 */
  requirement_revisions?: Array<{
    id: string;
    at: string;
    annotation_ids: string[];
    additions: number;
    deletions: number;
  }>;
  requirement_document?: {
    name: string;
    bytes: number;
    context_mode: "inline" | "file";
    bundle_name?: string;
    sources?: RequirementSourceMeta[];
    warnings?: string[];
    assets?: Array<{
      path: string;
      source_path: string;
      mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      bytes: number;
      digest: string;
    }>;
  };
  status: TaskStatus;
  /** 服务端对现有事实的唯一扫读解释；旧后端缺席时界面安全降级。 */
  focus?: {
    kind: "human_action" | "blocked" | "machine" | "external" | "done" | "inactive";
    headline: string;
    next_action: string;
    owner: "responsible" | "agent" | "platform" | "none";
    needs_attention: boolean;
    priority: number;
  };
  /** 状态短文案(服务端 projectStatusLabel);statusText() 只读它。 */
  status_label?: string;
  /** 机器停了该人上(服务端 projectRepairStopped);repairStopped() 只读它。 */
  repair_stopped?: boolean;
  /** 下单时选的模型;缺席=跟随服务当前默认。页面据此说清"谁跑的"。 */
  model_choice?: { provider: string; model: string };
  detail?: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  token_usage?: TaskTokenUsage;
  /** 最近一次主会话解析到的网关通道(ADR-0068):platform=平台网关,
   * personal=本人自配的个人网关;beta 是退役前历史任务的事实账,照读
   * 不动。缺席=标记尚未写(老任务/未启动)。 */
  model_lane?: "platform" | "personal" | "beta";
  /** 执行队列位次(1 起,服务端投影):排队的单要能回答"排到哪了"。 */
  queue_position?: number;
  /** 开发助手正占有主现场(paused 期间):恢复入口是"交还主任务"。 */
  assistant_engaged?: boolean;
  /** 环境预热编译收据(服务端镜像):基线红=环境/上游的锅,与本单
   * 增量无关;不构成任何交付证据。 */
  baseline_build?: {
    status: "running" | "passed" | "failed" | "infrastructure_failure";
    sha: string;
    detail?: string;
    build_command?: string;
    started_at: string;
    finished_at?: string;
  };
  /** 下单事实「UT生成方式」的镜像。"仓内既有写法"= 没指向团队 Skill,
   * skill 不被读取是正确行为——这句话要在界面上说破,别让人翻内核文件。 */
  ut_generation_method?: string;
  /** 现场被回收的时刻。有值 = 代码克隆等大件已删,过程记录/证据/批注仍在。
   * 页面据此如实说明,别让人对着 404 的代码差异发愣。 */
  workspace_reclaimed_at?: string;
  luban_account?: string;
  /** 跨仓主任务共同开发者；主责任人仍是唯一的 luban_account。 */
  collaborators?: string[];
  approval_mode?: "inherit" | "manual" | "moonlight";
  repo_url?: string;
  repositories?: string[];
  repository_profiles?: RepositoryProfile[];
  /** 首次进入 Git 现场后固定的仓库原生 Skill；平台只消费，不管理。 */
  repository_skills?: SelectedRepositorySkill[];
  /** 从团队资产固定的 Skill 形态知识。 */
  team_skills?: HostSkillShelfEntry[];
  /** 创建任务时固定的业务模块与知识版本；正文不进入任务摘要。 */
  business_modules?: SelectedBusinessModule[];
  business_module?: { id: string; name: string };
  business_module_history?: Array<{ at: string; by: string; from?: { id: string; name: string }; to?: { id: string; name: string } }>;
  /** Cloud 的知识消费观测，不参与内核裁决。 */
  knowledge_usage?: TaskKnowledgeUsage;
  /** 持续检视明细；原始材料仍按来源留在各自账本。 */
  feedback?: FeedbackRecord[];
  /** 当前任务的反馈索引不可读；服务端会隔离坏账并从内核恢复。 */
  feedback_error?: string;
  /** 仓内 Skill 与代码交付使用同一基线。 */
  baseline?: string;
  product_version?: string;
  /** 新任务复用时沿用的交付方式与修复预算。 */
  lane?: string;
  repair_rounds?: number;
  /** 业务需求/问题单号；与平台内部 task-xx 分开显示。 */
  ticket?: string;
  ticket_correction?: { id: string; old_ticket: string; ticket: string; title: string; actor: string;
    state: "running" | "failed" | "completed"; message: string; at: string; can_cancel?: boolean; cleanup_only?: boolean };
  requirement_graph?: {
    stage: "analysis" | "confirmed";
    /** pending 是下单候选仓占位；只有 ready 才能据此创建模块任务。 */
    projection_state?: "pending" | "ready" | "invalid";
    projection_error?: string;
    plan_revision?: string;
    sync_required?: boolean;
    chain_sha256?: string;
    source_document?: "story.md" | "chain";
    projection_sha256?: string;
    repository_assessments?: Array<{
      name: string; url: string;
      outcome: "change_required" | "no_change";
      reason: string; evidence?: string[];
    }>;
    repositories: Array<{
      id: string; name: string; url: string; responsibility?: string;
      /** Agent 分析出的功能模块和可选代码参考位置。 */
      scope?: { name: string; paths: string[] };
      assignee?: string; ticket?: string; task_id?: string;
      task_status?: TaskStatus; current_phase?: string;
    }>;
    /** `from 依赖 to`：from 等待 to，to 是前置仓库。 */
    dependencies: Array<{ from: string; to: string; reason?: string }>;
  };
  parent_task_id?: string;
  parent_task?: {
    id: string; title?: string; ticket?: string; status: TaskStatus;
  };
  blocked_by?: string[];
  dependency_adjustments?: DependencyAdjustment[];
  /** 本任务作为交付单元的负责文件面;缺席=整仓无边界。 */
  delivery_scope?: { name: string; paths: string[] };
  /** 先分析拆分:由 Agent 在开发中提议(propose_split)置上,或原位重跑沿用。 */
  requirement_analysis_requested?: boolean;
  /** Agent 提议拆分留下的事实:为什么、建议怎么切、在哪个阶段。 */
  split_escalation?: {
    at: string; reason: string; suggested_units?: string[]; phase?: string;
    /** pending=卡上等人;split=已转身;declined=人否决,按一个任务干完。 */
    decision: "pending" | "split" | "declined";
    decided_by?: string; decided_at?: string;
  };
  cross_repository_updates?: CrossRepositoryUpdate[];
  waiting?: {
    waiting_id: string;
    state_version: number;
    /** 待办生成时刻:等待时长的唯一来源(服务端本来就发)。 */
    created_at?: string;
    step?: string;
    question?: {
      /** 提交前只读文件事实，不提交选择、不参与授权。 */
      delivery_files?: DeliveryFile[];
      push_file_list?: PushFileList;
      questions?: WaitingQuestion[];
      /** clarification = Agent 处理检视意见时缺信息,单独问人;不是验收。 */
      purpose?: "confirmation" | "clarification";
      /** 澄清卡追问的检视意见 ID。 */
      annotation_ids?: string[];
    };
    /** 提问前模型的最后一段话:"如上表"这类指代的落点。 */
    context?: string;
    /** 举卡前 Agent 刚展示的上文(完整清单/确认单),随卡呈现防盲签。 */
    preface?: string;
    recommended_view?: "source" | "doc" | "chain" | "diff";
    /** 由服务端读取内核 flow 投影；前端据此识别关闭检视与继续处理意见
     * 的选项，不维护 build_review 等阶段表。 */
    choice_effects?: Array<{
      key: string;
      answers: string[];
      allows_source_edit: boolean;
      handles_feedback: boolean;
      closes_feedback: boolean;
    }>;
  };
  notify?: {
    delivered: boolean;
    settled?: boolean;
    attempts: number;
    last_error?: string;
  };
  delivery?: {
    git_push?: { sha: string };
    source_branch?: string;
    target_branch?: string;
    initial_mr?: { url: string; head?: string; base?: string };
    final_mr?: {
      url: string; id: string | number; repo: string; source_branch: string; target_branch: string;
      state: "opened" | "closed" | "merged"; head?: string; base?: string; merged_at?: string;
    };
    component_knowledge?: ComponentKnowledgeCheckReport;
    mr_participants?: MrParticipantsResult;
    /** 最近一次推送的起点，仅用于代码增量展示。 */
    last_push_base_sha?: string;
    mr_url?: string;
    mr_state?: string;
    merged_sha?: string;
    pipeline?: string;
    /** 当前 SHA 的验证是否只是编码期间的旁路观察，重启时据此续接。 */
    pipeline_background?: boolean;
    skipped?: string;
    /** Cloud 原生 Build-Fix；缺席表示服务端尚未开始或不支持该能力。 */
    prepush?: PrepushVerification;
    /** 进程活性只看这里，不能再由旧存储字段 prepush.state=preparing 推断。 */
    prepush_runtime?: PrepushRuntime;
    /** 当前 push 检视的阅读导航，展示实际提交内容。 */
    push_review?: PushReviewPresentation;
    /** 历史目录限制卡，恢复或继续验证时清理。 */
    scope_violation?: { paths: string[]; noted_at: string };
    /** 卡在哪一环的人话(等审批、等某一项核销结果……)。服务端一直
     * 在写,前端一直没显示——于是"验证中"三个字后面藏着的真实原因
     * 谁也看不到,任务看着像马上要成了,其实早就停了。 */
    waiting_on?: string;
    /** 自愈已停、等人介入的原因。有它就该亮牌子给「重跑续推」。 */
    stalled?: string;
    /** 停摆类别(服务端 stallPolicy);前端只透传,不据此拼文案。 */
    stall_class?: "infrastructure" | "evidence_missing" | "evidence_invalid" | "contract" | "safety";
    /** 红灯维度缺少可修复原文；工作台据此开放“批注回灌”入口。 */
    evidence_gap?: {
      sha: string;
      state: "retrying" | "waiting_human" | "partial";
      missing_dimensions: Array<"COMPILE" | "UT" | "CODECHECK">;
      available_dimensions: Array<"COMPILE" | "UT" | "CODECHECK">;
      reasons: string[];
      attempts: number;
      notified_at?: string;
    };
    /** 修复环账本(服务端事实镜像,前端不推断只呈现)。 */
    loop?: {
      round: number;
      max?: number;
      state: "repairing" | "verifying" | "green" | "merged" | "exhausted" | "halted";
      kind?: "ci" | "review" | "conflict";
      review_source?: "platform" | "workspace";
      /** true=人工意见已修复，push 前必须回到意见作者逐条复检。 */
      workspace_review_recheck_required?: boolean;
      workspace_review_annotation_ids?: string[];
      diagnosis?: string;
      /** 流水线失败的平台原文(摘要)。刹车告警必须连它一起亮:诊断是
       * 会话的收口发言,可能在聊别的事(内网实锤:最后一轮会话在补文档
       * 章节,告警正文全是章节标题,流水线到底红在哪谁也看不见)。 */
      failure?: string;
    };
  };
  /** 旧任务历史兼容字段，界面不再使用文件选择。 */
  delivery_selection?: {
    paths: string[];
    observed_paths: string[];
    excluded_paths: string[];
    status: "requested" | "confirmed";
    waiting_id: string;
    head: string;
    baseline?: string;
    confirmation_mode?: "human" | "policy";
    confirmation_reason?: string;
    updated_at: string;
  };
  /** push 前人工确认(任务级显式开关,缺省继承个人设置)。 */
  push_confirmation?: boolean;
  progress?: TaskProgress;
  /** 当前阶段采用什么做法的只读说明；状态与完成条件仍以内核为准。 */
  execution_plan?: ExecutionPlan;
  /** 活方案对拍告警:定制链任何一环退化(定格文件损坏、阶段失配、
   * 活方案没吃到定格)都在这里,有值必须标红——不许界面展示定格副本
   * 而 Agent 实际跑平台默认。 */
  execution_plan_alerts?: string[];
  workflow_profile?: WorkflowExecutionProfile;
  workflow_profile_warning?: string;
  host_skills_pinned?: boolean;
  host_skill_snapshot_warnings?: string[];
  control?: {
    last_action: "pause" | "resume" | "cancel";
    actor: string;
    at: string;
    paused_from?: TaskStatus;
  };
}

export interface CrossRepositoryUpdate {
  id: string;
  parent_task_id: string;
  source_task_id: string;
  source_repository?: string;
  author: string;
  text: string;
  target_task_ids: string[];
  created_at: string;
}

/** 历史条目(服务端 projection.ts 的 TaskHistoryEntry 镜像)。 */
export type TaskHistoryEntry = TaskSummary & {
  event_count: number;
  updated_at: string;
};

/** 历史任务投影(需服务端配 --pg)。404 时把服务端的解释原样带回。 */
export async function listHistory(): Promise<{
  entries?: TaskHistoryEntry[];
  unavailable?: string;
}> {
  const response = await fetch("/history");
  if (response.status === 401) throw new Error(await errorText(response));
  if (!response.ok) {
    const body = await errorBody(response);
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { entries: await parseJson(response) };
}

export interface SemanticEvent {
  eventId: number;
  execution?: { source: "main" | "build_fix"; attempt: string; round?: number };
  kind: string;
  ts: string;
  /** 同一任务的主 Agent、开发助手、子 Agent 共用事件流，用它区分来源。 */
  sessionId?: string;
  payload: Record<string, unknown>;
}

export async function listTasks(): Promise<TaskSummary[]> {
  const response = await fetch("/tasks");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function getTask(taskId: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 团队知识运营使用独立低频读接口，不扩大任务列表轮询响应。 */
export async function getKnowledgeInsights(): Promise<TeamKnowledgeInsights> {
  const response = await fetch("/knowledge-insights");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 下单表单的数据源:可选模型清单(≤1 个时不必展示下拉)与当前默认。 */
export interface LaunchBlocker {
  key: string;
  label: string;
  where: "admin" | "me";
}

export interface LaunchOptions {
  /** 当前生效的模型(展示用;模型不给选,管理员统一配一个)。 */
  model?: { provider: string; model: string };
  /** 数字=手刹上限；平台缺省为 20，0 表示关闭。 */
  repair_rounds?: number;
  /** enabled=false 时展示不可用原因，不能把代码仓入口静默隐藏。
   * required=true 时必填——本部署不设默认仓,每单写明交到哪儿。 */
  repo: { enabled: boolean; required: boolean; disabled_reason?: string };
  /** 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
   * 不让模型开工后再逐项来问(和交付方式同一逻辑)。 */
  ticket: { enabled: boolean; required: boolean };
  baseline: { enabled: boolean; default: string };
  /** 没配齐的配置项:where=admin 归管理员,me 归本人。非空=不给下单。 */
  blockers: LaunchBlocker[];
  /** 交付方式:**取自内核 flow.json**(key=内核代号,label=给人看的),
   * 前端一个字都不许另抄——抄了就会出现"页面说快速/慢速、内核只认
   * 完整开发/局部修改",于是下单选过的交付方式在流程里又被问一遍。
   * 空数组=读不到内核定义,那就不预选,老老实实等流程里问。 */
  /** description 只说适用场景；steps/acks 是内核目录的兼容字段，
   * 下单页不用它们解释交付方式。 */
  workflows: Array<
    { key: string; label: string; description?: string;
      steps?: number; acks?: number }>;
  execution_playbooks: ExecutionPlaybookOption[];
  workflow_standard?: WorkflowStandardBase;
  /** 已发布的可选业务模块摘要；知识正文不会随目录接口返回。 */
  business_modules: BusinessModuleLaunchOption[];
  team_skills: HostSkillShelfEntry[];
}

export interface LaunchKnowledgeMatchedScope {
  matched_business_module_ids: string[];
  matched_repositories: string[];
  matched_technologies: string[];
}

export interface LaunchBusinessKnowledgePreview
  extends LaunchKnowledgeMatchedScope {
  module_id: string;
  module_name: string;
  module_revision: number;
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: KnowledgeForm;
  repositories: string[];
  version: number;
  digest: string;
  bytes: number;
}

export interface LaunchTeamSkillPreview
  extends HostSkillShelfEntry, LaunchKnowledgeMatchedScope {
  package_digest: string;
}

export interface LaunchKnowledgePreviewNotice {
  source: "business_modules" | "team_skills"
    | "repository_profiles";
  code: "catalog_unavailable" | "catalog_warning" | "limit_applied"
    | "selection_invalid";
  message: string;
}

export interface LaunchKnowledgePreview {
  complete: boolean;
  degraded: boolean;
  scope: {
    repositories: string[];
    technologies: string[];
    business_module_ids: string[];
    workflow_business_module_ids: string[];
    workflow_team_skill_ids: string[];
  };
  business_knowledge: LaunchBusinessKnowledgePreview[];
  team_skills: LaunchTeamSkillPreview[];
  selection_digest: string;
  warnings: LaunchKnowledgePreviewNotice[];
  errors: LaunchKnowledgePreviewNotice[];
}

export async function getLaunchKnowledgePreview(input: {
  repos: string[];
  selectedBusinessModuleIds: string[];
  repositoryProfiles?: Array<Pick<RepositoryProfile,
    "repository" | "technologies" | "confirmed">>;
  workflowSelection?: { id: string; version?: number | string };
}, signal?: AbortSignal): Promise<LaunchKnowledgePreview> {
  const response = await fetch("/launch-knowledge-preview", {
    method: "POST",
    signal,
    body: JSON.stringify({
      repos: input.repos,
      selected_business_module_ids: input.selectedBusinessModuleIds,
      repository_profiles: input.repositoryProfiles,
      workflow_selection: input.workflowSelection,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface RepositoryProfile {
  repository: string;
  technologies: string[];
  confirmed: boolean;
  updated_at: string;
  updated_by: string;
}

export async function resolveRepositoryProfiles(
  repositories: string[],
): Promise<Array<{ repository: string; profile?: RepositoryProfile }>> {
  const response = await fetch("/repository-profiles/resolve", {
    method: "POST",
    body: JSON.stringify({ repositories }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return (await parseJson<{ repositories: Array<{ repository: string; profile?: RepositoryProfile }> }>(response)).repositories;
}

export interface RepositoryProbeResult {
  repository: string;
  reachable: boolean;
  message: string;
}

export async function probeRepositories(
  repositories: string[],
  signal?: AbortSignal,
): Promise<RepositoryProbeResult[]> {
  const response = await fetch("/repositories/probe", {
    method: "POST",
    signal,
    body: JSON.stringify({ repositories }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return (await parseJson<{ repositories: RepositoryProbeResult[] }>(response)).repositories;
}

export async function saveRepositoryProfile(input: {
  repository: string;
  technologies: string[];
  confirmed?: boolean;
}): Promise<RepositoryProfile> {
  const response = await fetch("/repository-profiles", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface BusinessModuleLaunchOption {
  id: string;
  name: string;
  description: string;
  owner: string;
  repositories: string[];
  revision: number;
  assets: number;
  /** 可核对的已发布知识目录，不含正文；可选以兼容滚动升级中的旧服务。 */
  knowledge?: Array<{
    id: string;
    title: string;
    summary: string;
    when_to_use: string;
    form: KnowledgeForm;
    repositories: string[];
    version: number;
  }>;
  updated_at: string;
}

export type KnowledgeNature = "business" | "engineering" | "unclassified";
export type KnowledgeForm = "document" | "skill" | "rule" | "example";

export interface BusinessKnowledgeAsset {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: KnowledgeForm;
  repositories: string[];
  status: "published" | "archived";
  version: number;
  digest: string;
  bytes: number;
  updated_at: string;
  updated_by: string;
}

export type MrParticipants = import("../../src/mrParticipants").MrParticipants;
export interface BusinessModuleKnowledgeLocation { repository: string; branch: string; docs_path: string }
export interface BusinessModuleKnowledgeLocationResult {
  configured: boolean; knowledge_path?: string; location?: BusinessModuleKnowledgeLocation;
  module_revision?: number;
  sync?: { state: "syncing" | "ready" | "partial" | "failed"; synced_at?: string; attempted_at?: string; commit?: string; document_count: number; error?: string; warnings?: string[] };
}
export async function businessModuleKnowledgeRequest(moduleId: string, input?: { knowledge_path: string; expected_revision?: number }): Promise<BusinessModuleKnowledgeLocationResult> {
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}/knowledge-location`, input ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
  } : { signal: AbortSignal.timeout(30_000) });
  const result = await response.json() as BusinessModuleKnowledgeLocationResult & { error?: string };
  if (!response.ok) throw new Error(result.error || "领域知识目录读取失败");
  if (input) invalidateKnowledgeReads();
  return result;
}

export interface BusinessModuleKnowledgeScope {
  module_revision: number;
  repositories: Array<{ repository: string; directories: string[]; files: string[]; excluded_paths: string[] }>;
}
export async function businessModuleKnowledgeScopeRequest(
  moduleId: string,
  input?: { expected_revision: number; repositories: Array<{ repository: string; excluded_paths: string[] }> },
  signal?: AbortSignal,
): Promise<BusinessModuleKnowledgeScope> {
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}/knowledge-scope`, {
    cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    ...(input ? { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const result = await response.json() as BusinessModuleKnowledgeScope & { error?: string };
  if (!response.ok) throw new Error(result.error || (input ? "文档筛选保存失败" : "文档筛选读取失败"));
  if (input) invalidateKnowledgeReads();
  return result;
}

export interface BusinessModule {
  id: string;
  name: string;
  description: string;
  owner: string;
  maintainers: string[];
  repositories: string[];
  knowledge_path?: string;
  knowledge_location?: BusinessModuleKnowledgeLocation;
  mr_participants?: MrParticipants;
  /** 参考组件仓订阅(ADR-0054):公共组件仓登记表条目 id 引用。 */
  reference_component_repos?: string[];
  status: "active" | "archived";
  revision: number;
  assets: BusinessKnowledgeAsset[];
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  can_manage: boolean;
}

export interface SelectedBusinessModule {
  id: string;
  name: string;
  description: string;
  owner: string;
  revision: number;
  assets: Array<{
    id: string;
    title: string;
    summary: string;
    when_to_use: string;
    form: KnowledgeForm;
    repositories: string[];
    version: number;
    digest: string;
    bytes: number;
    snapshot_path: string;
  }>;
}

export interface BusinessModuleOperation {
  at: string;
  operator: string;
  action: "create" | "update" | "archive" | "publish_asset" | "archive_asset" | "migrate";
  module_id: string;
  asset_id?: string;
  version?: number;
  detail?: string;
}

export interface BusinessModuleCatalog {
  modules: BusinessModule[];
  warnings: string[];
  operations: BusinessModuleOperation[];
}

export interface BusinessModuleMigrationPreview {
  documents: number; extraction_tasks: number; delivery_tasks: number; issue_sessions: number;
}
export async function previewBusinessModuleMigration(id: string): Promise<BusinessModuleMigrationPreview> {
  const response = await fetch(`/business-modules/${encodeURIComponent(id)}/migration`);
  const result = await response.json() as BusinessModuleMigrationPreview & { error?: string };
  if (!response.ok) throw new Error(result.error || "无法读取迁移范围");
  return result;
}
export async function migrateBusinessModule(id: string, targetId: string): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(id)}/migration`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_id: targetId }),
  });
  const result = await response.json() as BusinessModule & { error?: string };
  if (!response.ok) throw new Error(result.error || "迁移失败");
  invalidateKnowledgeReads();
  return result;
}

export async function getBusinessModules(signal?: AbortSignal): Promise<BusinessModuleCatalog> {
  const response = await fetch("/business-modules", signal ? { signal, cache: "no-store" } : undefined);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function createBusinessModule(input: {
  id?: string;
  name: string;
  description: string;
  owner?: string;
  maintainers?: string[];
  repositories: string[];
  knowledge_path?: string;
  reference_component_repos?: string[];
  mr_participants?: MrParticipants;
}): Promise<BusinessModule> {
  const response = await fetch("/business-modules", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  invalidateKnowledgeReads();
  return parseJson(response);
}

export async function updateBusinessModule(
  id: string,
  patch: Partial<Pick<BusinessModule,
    "name" | "description" | "owner" | "maintainers" | "repositories"
    | "reference_component_repos" | "mr_participants" | "status" | "knowledge_path">>,
): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await errorText(response));
  invalidateKnowledgeReads();
  return parseJson(response);
}

export async function getBusinessKnowledgeAsset(
  moduleId: string,
  assetId: string,
  version?: number,
): Promise<{
  module_id: string;
  module_name: string;
  asset: BusinessKnowledgeAsset;
  content: string;
}> {
  const query = version === undefined ? ""
    : `?version=${encodeURIComponent(String(version))}`;
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}`
    + `/assets/${encodeURIComponent(assetId)}${query}`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function publishBusinessKnowledgeAsset(
  moduleId: string,
  assetId: string,
  input: Pick<BusinessKnowledgeAsset, "title" | "summary" | "when_to_use">
    & { form: KnowledgeForm; repositories: string[]; content: string },
): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}`
    + `/assets/${encodeURIComponent(assetId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function archiveBusinessKnowledgeAsset(
  moduleId: string,
  assetId: string,
): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}`
    + `/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export class WorkflowApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "WorkflowApiError";
  }
}

async function workflowResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as {
    error?: unknown; code?: unknown; current_revision?: unknown };
  throw new WorkflowApiError(
    String(body.error ?? `HTTP ${response.status}`),
    body.code === undefined ? undefined : String(body.code),
    body.current_revision === undefined
      ? undefined : Number(body.current_revision),
  );
}

export async function listWorkflowAssets(): Promise<{
  items: WorkflowAssetSummary[];
  warnings: string[];
}> {
  return workflowResponse(await fetch("/workflow-assets"));
}

export async function getWorkflowAssetCatalog(): Promise<{
  items: WorkflowAssetCatalogItem[];
  warnings: string[];
}> {
  return workflowResponse(await fetch("/workflow-assets/catalog"));
}

export async function getWorkflowStandard(): Promise<
WorkflowStandardBase> {
  return workflowResponse(await fetch("/workflow-assets/standard"));
}

export async function getWorkflowAsset(id: string): Promise<WorkflowAssetDetail> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}`));
}

export async function createWorkflowAsset(input: {
  id?: string;
  name: string;
  description?: string;
  scope: "personal" | "team";
  maintainers?: string[];
  definition: WorkflowDefinition;
}): Promise<WorkflowAssetSummary> {
  return workflowResponse(await fetch("/workflow-assets", {
    method: "POST", body: JSON.stringify(input),
  }));
}

export async function saveWorkflowDraft(
  id: string,
  definition: WorkflowDefinition,
  expectedRevision: number,
): Promise<WorkflowAssetDetail> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}/draft`, {
      method: "PUT",
      body: JSON.stringify({
        definition, expected_revision: expectedRevision,
      }),
    }));
}

export async function copyWorkflowAsset(
  id: string,
  input: {
    source_version?: number | string;
    name: string;
    description?: string;
    scope: "personal" | "team";
    maintainers?: string[];
  },
): Promise<WorkflowAssetSummary> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}/copy`, {
      method: "POST", body: JSON.stringify(input),
    }));
}

export async function workflowAssetAction(
  id: string,
  action: "submit" | "withdraw" | "approve" | "reject" | "archive",
  input: { reason?: string } = {},
): Promise<WorkflowAssetSummary> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}/${action}`, {
      method: "POST", body: JSON.stringify(input),
    }));
}

export async function getLaunchOptions(): Promise<LaunchOptions> {
  const response = await fetch("/launch-options");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface BuildInfo {
  /** 部署时间(服务启动时间);null 表示服务端未返回。 */
  build_hash: string | null;
}

export async function getBuildInfo(): Promise<BuildInfo> {
  const response = await fetch("/build-info");
  if (!response.ok) return { build_hash: null };
  return parseJson(response);
}

/** 业务仓自带的、可由本任务显式启用的 Skill。扫描只建立目录，真正
 * 读取哪个 Skill、何时读取由 Agent 按任务语义决定。 */
export interface RepositorySkill {
  id: string;
  name: string;
  description: string;
  relative_path: string;
  source: string;
  digest: string;
  selectable: boolean;
  warning?: string;
}

export type KnowledgeKind = "rules" | "document" | "skill";
export type KnowledgeAction = "available" | "loaded" | "read" | "searched";

export interface TaskKnowledgeResource {
  id: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  repository?: string;
  description?: string;
  digest?: string;
  selected?: boolean;
  scope?: "task" | "repository" | "team" | "module";
  module_id?: string;
  module_name?: string;
  asset_version?: number;
  state: "available" | "loaded" | "used";
  available_count: number;
  loaded_count: number;
  read_count: number;
  search_count?: number;
  first_at?: string;
  last_at?: string;
}

export interface TaskKnowledgeSource {
  name: string; path: string; content: string; version_changed: boolean;
}

export async function readTaskKnowledgeSource(taskId: string, resourceId: string): Promise<TaskKnowledgeSource> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/knowledge-source?resource=${encodeURIComponent(resourceId)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface TaskKnowledgeUsage {
  summary: {
    resources: number;
    loaded: number;
    used: number;
    skills_used: number;
    selected_unused: number;
  };
  resources: TaskKnowledgeResource[];
  events: Array<{
    id: string;
    kind: KnowledgeKind;
    name: string;
    path: string;
    repository?: string;
    selected?: boolean;
    scope?: "task" | "repository" | "team" | "module";
    module_id?: string;
    module_name?: string;
    asset_version?: number;
    ts: string;
    session_id: string;
    session_role: "main" | "subagent" | "prepush" | "developer-assistant" | "warmup";
    step?: string;
    action: KnowledgeAction;
    observed_path?: string;
  }>;
}

export type KnowledgeRecommendationKind =
  | "coverage-gap"
  | "needs-review"
  | "selected-unused"
  | "promote";

export interface KnowledgeInsightResource {
  key: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  /** 可读性:选中资源=仓内扫描的描述;自发读取=观测时抽的首标题摘要。 */
  description?: string;
  repository?: string;
  scope?: "task" | "repository" | "team" | "module";
  module_id?: string;
  module_name?: string;
  asset_version?: number;
  provided_tasks: number;
  selected_tasks: number;
  loaded_tasks: number;
  accessed_tasks: number;
  access_events: number;
  completed_tasks: number;
  repair_tasks: number;
  attention_tasks: number;
  last_used_at?: string;
}

export interface KnowledgeRecommendation {
  id: string;
  kind: KnowledgeRecommendationKind;
  tone: "attention" | "info" | "positive";
  title: string;
  evidence: string;
  action: string;
  resource_key?: string;
  task_ids?: string[];
}

/** 团队 Skill 货架条目:部署数据目录 skills/ 里当前生效的资产身份。
 * 正文不进接口;digest 是版本锚。 */
/** 货架条目的效果账(飞轮第 3 步):消费率 × prepush 一次过对照。
 * 只是相关性观察,不构成对任何任务或 skill 的裁决。 */
export interface HostSkillEffect {
  provided_tasks: number;
  accessed_tasks: number;
  access_events: number;
  repair_tasks: number;
  prepush_measured: number;
  prepush_first_pass: number;
  baseline_measured: number;
  baseline_first_pass: number;
  signal?: "low-consumption" | "high-friction";
  signal_evidence?: string;
}

export interface HostSkillShelfEntry {
  name: string;
  description: string;
  nature: KnowledgeNature;
  form: "skill";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  digest: string;
  updated_at: string;
  path: string;
  bytes: number;
  /** false = pi 装载器不认(缺 name/description 等),放了也不进会话。 */
  loadable: boolean;
  effect?: HostSkillEffect;
}

export interface HostSkillShelf {
  root_exists: boolean;
  skills: HostSkillShelfEntry[];
  warnings: string[];
}

export interface SkillKnowledgeMetadataInput {
  nature: Exclude<KnowledgeNature, "unclassified">;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

/** 资产库操作留痕(谁/何时/什么动作/什么指纹),服务端逐条记录。 */
export interface SkillOperationRecord {
  production?: KnowledgeProductionView;
  at: string;
  operator: string;
  action: "upload" | "update" | "offline" | "rollback"
    | "submit" | "approve" | "reject";
  directory: string;
  skill_digest?: string;
  package_digest?: string;
  files?: number;
  bytes?: number;
  detail?: string;
}

/** 开发者提交的待审 skill 包:人人可提交,管理员审核上架。 */
export interface SkillSubmissionRecord {
  production?: KnowledgeProductionView;
  id: string;
  directory: string;
  operator: string;
  created_at: string;
  status: "pending" | "approving" | "approved" | "rejected";
  skill_digest: string;
  package_digest: string;
  files: number;
  bytes: number;
  nature?: KnowledgeNature;
  business_module_ids?: string[];
  repositories?: string[];
  technologies?: string[];
  decided_at?: string;
  decided_by?: string;
  reject_reason?: string;
}

export interface SkillVersionRecord {
  version_id: string;
  archived_at: string;
  action: string;
  operator: string;
  skill_digest: string;
  package_digest: string;
  files: number;
  bytes: number;
}

export interface SkillUploadFile {
  path: string;
  content_base64: string;
}

export interface HostSkillDocument {
  directory: string;
  path: string;
  content: string;
  digest: string;
  package_digest: string;
  bytes: number;
}

/** 货架 + 留痕一次取齐(管理面自刷新用,与 knowledge-insights 解耦)。 */
export async function getSkillLibrary(options: { directoryOnly?: boolean } = {}): Promise<
  HostSkillShelf & { operations: SkillOperationRecord[] }
> {
  const response = await fetch(options.directoryOnly ? "/skills?view=directory" : "/skills");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function getSkillDocument(
  directory: string,
): Promise<HostSkillDocument> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface SkillExtractionJob {
  production?: KnowledgeProductionView;
  id: string;
  status: "queued" | "running" | "done" | "failed";
  repo: string;
  intent: string;
  path_hint?: string;
  operator: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  draft?: string;
  notes?: string;
  error?: string;
  /** 草稿已提交到 Skill 库审查（"目录/提交号"）。 */
  submission_id?: string;
}

/** 定向知识提取:从参考仓起草 SKILL.md。起草是异步的,拿 id 轮询。 */
export async function startSkillExtraction(input: {
  repo: string;
  intent: string;
  pathHint?: string;
}): Promise<SkillExtractionJob> {
  const response = await fetch("/knowledge/skill-extract", {
    method: "POST",
    body: JSON.stringify({
      repo: input.repo,
      intent: input.intent,
      ...(input.pathHint ? { path_hint: input.pathHint } : {}),
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function getSkillExtraction(
  id: string,
): Promise<SkillExtractionJob> {
  const response = await fetch(
    `/knowledge/skill-extract/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function submitSkill(
  directory: string,
  files: SkillUploadFile[],
  metadata?: SkillKnowledgeMetadataInput,
): Promise<SkillSubmissionRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/submissions`, {
      method: "POST",
      body: JSON.stringify({ files, ...metadata }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function updateSkillKnowledgeMetadata(
  directory: string,
  metadata: SkillKnowledgeMetadataInput,
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/classification`, {
      method: "PATCH",
      body: JSON.stringify(metadata),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function updateSkillPackage(
  directory: string,
  mode: "edit" | "replace",
  expectedPackageDigest: string,
  files: SkillUploadFile[],
): Promise<SkillOperationRecord> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}/package`, {
    method: "PATCH",
    body: JSON.stringify({ mode, expected_package_digest: expectedPackageDigest, files }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listSkillSubmissions(): Promise<SkillSubmissionRecord[]> {
  const response = await fetch("/skills/submissions");
  if (!response.ok) throw new Error(await errorText(response));
  return (await parseJson<{ submissions?: SkillSubmissionRecord[] }>(response)).submissions ?? [];
}

export async function approveSkillSubmission(
  directory: string,
  id: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/submissions/`
    + `${encodeURIComponent(id)}/approve`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function rejectSkillSubmission(
  directory: string,
  id: string,
  reason?: string,
): Promise<SkillSubmissionRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/submissions/`
    + `${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? "" }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function offlineSkill(
  directory: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listSkillVersions(
  directory: string,
): Promise<SkillVersionRecord[]> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/versions`);
  if (!response.ok) throw new Error(await errorText(response));
  return (await parseJson<{ versions?: SkillVersionRecord[] }>(response)).versions ?? [];
}

export async function rollbackSkill(
  directory: string,
  version: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface TeamKnowledgeInsights {
  generated_at: string;
  summary: {
    tracked_tasks: number;
    accessed_tasks: number;
    unique_resources: number;
    active_resources: number;
    selected_unused: number;
    opportunities: number;
    access_rate: number;
  };
  resources: KnowledgeInsightResource[];
  recommendations: KnowledgeRecommendation[];
  /** 团队 Skill 货架(旧服务端没有该字段,前端按缺席兼容)。 */
  host_skills?: HostSkillShelf;
}

/** 已经由服务端目录令牌验证、记在任务上的仓内 Skill。Chain 检视页
 * 只用它展示/映射当前选择，不接收浏览器自报的正文或绝对路径。 */
export interface SelectedRepositorySkill extends RepositorySkill {
  repository: string;
  revision: string;
}

export interface RepositorySkillCatalog {
  catalog_token: string;
  repositories: Array<{
    repository: string;
    revision: string;
    skills: RepositorySkill[];
    error?: string;
  }>;
}

/** 明确由用户触发，不随仓库输入自动 clone/扫描。 */
export async function scanRepositorySkills(
  repositories: string[],
  baseline?: string,
  signal?: AbortSignal,
): Promise<RepositorySkillCatalog> {
  const response = await fetch("/repository-skills/scan", {
    method: "POST",
    signal,
    body: JSON.stringify({
      repositories,
      baseline: baseline?.trim() || undefined,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function createTask(
  requirement: string,
  account?: string,
  extras?: {
    title?: string;
    repo?: string;
    repos?: string[];
    /** 普通单仓或旧客户端可在发起时提交；分析主任务延后到拆分确认。 */
    repositoryTickets?: Record<string, string>;
    /** 旧客户端的逐仓执行人；新入口在拆分确认时按交付单元收集。 */
    repositoryAssignees?: Record<string, string>;
    /** 需求分析主任务的讨论参与人；不与仓库或交付单元绑定。 */
    collaborators?: string[];
    lane?: string;
    ticket?: string;
    baseline?: string;
    productVersion?: string;
    model?: { provider: string; model: string };
    repairRounds?: number;
    taskInstructions?: string;
    workflowDefinition?: unknown;
    workflowSelection?: { id: string; version?: number | string };
    repositorySkillCatalogToken?: string;
    selectedRepositorySkillIds?: string[];
    selectedBusinessModuleIds?: string[];
    businessModuleId?: string;
    knowledgePreviewDigest?: string;
    repositoryProfiles?: Array<Pick<RepositoryProfile,
      "repository" | "technologies" | "confirmed">>;
    requirementDocumentName?: string;
    requirementMaterialIds?: string[];
  },
  // 返回创建结果:调用方靠它把新任务当场打开/高亮。原来丢弃 201 响应
  // 体,下单成功零反馈,人会怀疑没提交成功再点一次(2026-08-30 审计)。
): Promise<TaskSummary> {
  const response = await fetch("/tasks", {
    method: "POST",
    body: JSON.stringify({
      requirement,
      requirement_document_name: extras?.requirementDocumentName,
      requirement_material_ids: extras?.requirementMaterialIds,
      title: extras?.title?.trim() || undefined,
      account: account || undefined,
      repo: extras?.repo || undefined,
      repos: extras?.repos?.length ? extras.repos : undefined,
      repository_tickets: extras?.repositoryTickets,
      repository_assignees: extras?.repositoryAssignees,
      collaborators: extras?.collaborators,
      // 空白等于没选，由服务端使用内核第一项；不要把 "" 伪装成
      // 一个需要校验的交付方式。
      lane: extras?.lane?.trim() || undefined,
      ticket: extras?.ticket || undefined,
      baseline: extras?.baseline || undefined,
      product_version: extras?.productVersion || undefined,
      model: extras?.model,
      repair_rounds: extras?.repairRounds,
      task_instructions: extras?.taskInstructions?.trim() || undefined,
      workflow_definition: extras?.workflowDefinition,
      workflow_selection: extras?.workflowSelection,
      repository_skill_catalog_token:
        extras?.repositorySkillCatalogToken || undefined,
      selected_repository_skill_ids:
        extras?.selectedRepositorySkillIds,
      selected_business_module_ids: extras?.selectedBusinessModuleIds,
      business_module_id: extras?.businessModuleId,
      knowledge_preview_digest: extras?.knowledgePreviewDigest,
      repository_profiles: extras?.repositoryProfiles,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return await response.json() as TaskSummary;
}

export interface RequirementMaterialsPreview {
  requirement: string;
  document_name: string;
  sources: RequirementSourceMeta[];
  assets: Array<{
    path: string;
    source_path: string;
    mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    bytes: number;
    content_base64: string;
  }>;
  warnings: string[];
}

export async function previewRequirementMaterials(
  materialIds: string[],
  requirement: string,
  signal?: AbortSignal,
): Promise<RequirementMaterialsPreview> {
  const response = await fetch("/requirement-materials/preview", {
    method: "POST",
    body: JSON.stringify({ material_ids: materialIds, requirement }),
    signal,
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface TaskAttachment { path: string; name: string; bytes: number }
export async function uploadTaskAttachment(taskId: string, file: File): Promise<TaskAttachment> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/attachments?name=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 提交决定。结构化选项与自由说明分开，服务端统一查询未闭环批注。 */
export async function decide(
  taskId: string,
  stateVersion: number,
  selectedOptions: Record<string, string>,
  freeResponses: Record<string, string>,
  comment?: string,
  /** 随这次决定一起提交的批注:圈过的几处就是"需要修改"的理由。
   * 渲染由服务端做——清单格式和那四条护栏只该有一份。 */
  annotationIds?: string[],
  /** Chain 方案确认与 Skill 选择共用一次提交。字段缺席=沿用父任务
   * 已有选择；目录读取成功后即使 ids 为空也必须提交，明确表示清空。 */
  repositorySkills?: {
    catalogToken: string;
    selectedIds: string[];
  },
  /** Chain 图上的逐仓责任人；只在“确认并生成任务”时发送。 */
  repositoryAssignees?: Record<string, string>,
  /** Chain 图上的逐仓 AR 单号；与责任人同一次确认提交。 */
  repositoryTickets?: Record<string, string>,
  /** 当前卡的稳定身份；用于把成功请求的网络重放识别为幂等成功。 */
  waitingId?: string,
): Promise<{ conflict?: string }> {
  const response = await fetch(`/tasks/${taskId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      waiting_id: waitingId,
      state_version: stateVersion,
      selected_options: selectedOptions,
      free_responses: freeResponses,
      comment: comment?.trim() || undefined,
      annotation_ids: annotationIds?.length ? annotationIds : undefined,
      repository_skill_catalog_token: repositorySkills?.catalogToken,
      selected_repository_skill_ids: repositorySkills?.selectedIds,
      repository_assignees: repositoryAssignees,
      repository_tickets: repositoryTickets,
    }),
  });
  if (response.status === 409) {
    const body = await errorBody(response);
    return { conflict: String(body.error ?? "任务状态已变化") };
  }
  if (!response.ok) return { conflict: await errorText(response) };
  return {};
}

export interface ExternalAction {
  idemKey: string;
  kind: string;
  request: Record<string, unknown>;
  result?: Record<string, unknown>;
  sha?: string;
  startedAt: string;
  finishedAt?: string;
}

/** 重跑一单:终态任务续接内核当前步骤。非终态时服务端会拒绝,
 * 把它的解释原样带回。 */
export async function retryTask(
  taskId: string,
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${taskId}/retry`, { method: "POST" });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 越界改动裁决:allow=豁免这些路径继续交付,revert=下修复令撤出改动。
 * 服务端只认主任务责任人;403 的解释原样带回给界面展示。 */
export async function decideScopeViolation(
  taskId: string,
  decision: "allow" | "revert",
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/scope-decision`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 清空同一任务的旧现场并从第一步重跑。服务端只允许责任人操作真终态。 */
export async function rerunTaskFromStart(
  taskId: string,
): Promise<{ task?: TaskSummary; error?: string }> {
  const response = await fetch(`/tasks/${taskId}/rerun`, { method: "POST" });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { task: await parseJson(response) };
}

/** 责任人可删除自己的真终态历史；管理员可删除任意真终态历史。 */
export async function deleteHistoryTask(
  taskId: string,
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 跑动中插话:发送即打断,模型把手头这一轮做完就收到。
 * 服务端拒绝的理由(正等你决定 / 没有在跑的会话)原样带回,前端不改写
 * ——它比我们更清楚这一单此刻处在什么状态。 */
/** 插话里的 @ 知识引用:只传结构化标识,正文由服务端解析并在发送时
 * 固定版本(客户端拼正文会绕过注入预算与足迹)。 */
export interface SteerReference {
  kind: "skill" | "business";
  directory?: string;
  module_id?: string;
  asset_id?: string;
}

export async function interruptTask(
  taskId: string,
  text: string,
  references?: SteerReference[],
  attachments?: TaskAttachment[],
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${taskId}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      attachments: attachments?.map(file => file.path),
      ...(references?.length
        ? { references: references.map((item) => ({
            kind: item.kind,
            directory: item.directory,
            module_id: item.module_id,
            asset_id: item.asset_id,
          })) }
        : {}),
    }),
  });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

export async function publishCrossRepositoryUpdate(
  taskId: string,
  text: string,
): Promise<CrossRepositoryUpdate> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/cross-repository-update`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface DeveloperAssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface DeveloperAssistantToolRun {
  call_id: string;
  name: string;
  input: string;
  result?: string;
  state: "running" | "passed" | "failed";
  started_at: string;
  finished_at?: string;
}

export interface DeveloperAssistantAvailability {
  available: boolean;
  code: "edit_window" | "user_override" | "approval_pending" | "host_wait"
    | "not_editable" | "core_unavailable" | "session_only";
  mode: "edit" | "unavailable";
  reason: string;
  core?: {
    step: string;
    title?: string;
    revision?: number;
    approval_subject_id?: string;
  };
}

export interface DeveloperAssistantHandoff {
  state: "running" | "unchanged" | "changed" | "returned" | "blocked";
  message: string;
  changed_paths?: string[];
  started_at: string;
  finished_at?: string;
  returned_at?: string;
}

export interface DeveloperAssistantView {
  state: "idle" | "acquiring" | "working" | "ready" | "returning"
    | "running" | "completed" | "failed" | "interrupted";
  messages: DeveloperAssistantMessage[];
  tools: DeveloperAssistantToolRun[];
  availability: DeveloperAssistantAvailability;
  handoff?: DeveloperAssistantHandoff;
  updated_at?: string;
  error?: string;
}

export async function getDeveloperAssistant(
  taskId: string,
): Promise<DeveloperAssistantView> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant`,
  );
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function startDeveloperAssistant(
  taskId: string,
  text: string,
): Promise<DeveloperAssistantView> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function stopDeveloperAssistant(
  taskId: string,
): Promise<DeveloperAssistantView> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant/interrupt`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function returnDeveloperAssistant(
  taskId: string,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant/return`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function controlTask(
  taskId: string,
  action: "pause" | "resume" | "cancel",
): Promise<{ task?: TaskSummary; error?: string }> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
  });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { task: await parseJson(response) };
}

/** 发过的补充说明 + 送达与否。delivered 是可观测事实(消息已离开
 * pi 的待送队列 = 已进入模型上下文),不是推断。 */
export interface InterruptRecord {
  text: string;
  at: string;
  delivered: boolean;
  /** 不走 steer 的两条路:随下一次决定送达 / 任务启动时并入使命。 */
  deferred?: "decision" | "mission";
  /** @ 引用的知识名(带发送时固定的版本号);正文不回传。 */
  references?: string[];
  /** 你说完之后它说的话(按时间切到下一条插话为止)。
   * 刻意不叫 reply:宿主没法证明哪一段是在答你,只能给时间顺序。 */
  said: Array<{ text: string; at: string }>;
}

export async function listInterrupts(
  taskId: string,
): Promise<InterruptRecord[]> {
  const response = await fetch(`/tasks/${taskId}/interrupts`);
  if (!response.ok) return [];
  return parseJson(response);
}

/* ---------------- 检视批注 ---------------- */

/** 需求原文来自任务快照；这个保留标识与服务端 annotations.ts 同合同。 */
export const TASK_REQUIREMENT_ARTIFACT = "__task_requirement__";
/** 模块拆分图的虚拟批注靶；服务端按模块/依赖 id 重建锚点文本。 */
export const REQUIREMENT_GRAPH_ARTIFACT = "__requirement_graph__";

/** 批注附图引用(服务端 reviewAssets):path 是 Agent 工作区相对路径。 */
export interface AnnotationImage { path: string; label?: string }

export function annotationAssetUrl(taskId: string, path: string): string {
  return resolveTaskDemoAsset(taskId, path)
    ?? `/tasks/${encodeURIComponent(taskId)}/annotation-asset?path=${encodeURIComponent(path)}`;
}

/** 把一张图先存成检视图片资产,拿到 Agent 能读的路径;随后随批注引用。 */
export async function uploadAnnotationAsset(
  taskId: string,
  file: Blob,
): Promise<{ path?: string; mime_type?: string; bytes?: number; error?: string }> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  }
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/annotation-assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content_base64: btoa(binary) }),
  });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return parseJson(response);
}

export interface Annotation {
  external_review?: { scope: string; discussion_id: string; content_key: string; mr_url?: string };
  id: string;
  author: string;
  created_at: string;
  artifact: string;
  file: string;
  line: number;
  anchor: string;
  context_before?: string;
  context_after?: string;
  /** 划选一块时的整块原文与末行;定位仍靠 anchor。 */
  quote?: string;
  line_end?: number;
  note: string;
  images?: AnnotationImage[];
  edited_at?: string;
  kind: "doc" | "code";
  /** 缺省值兼容旧任务：一律按交给 Agent 处理。memory = 记为记忆:不发给
   * 任何人,圈选即闭环。 */
  route?: "agent" | "owner_reply" | "owner_decision" | "memory";
  assignee?: string;
  status: "draft" | "sent" | "verified" | "dropped";
  agent_assigned?: boolean;
  agent_context?: { text: string; by: string; at: string; revision: number };
  sent_at?: string;
  sent_via?: "interrupt" | "decision" | "pipeline_evidence" | "review_repair"
    | "queued_decision" | "owner_pending" | "overall_story_queue" | "overall_story_processing" | "overall_story" | "requirement_queue" | "requirement_review";
  /** 责任人可以原样转交他人的意见；作者与转交人分别留痕。 */
  sent_by?: string;
  response?: {
    revision: number;
    outcome: "fixed" | "not_fixed" | "needs_clarification";
    summary: string;
    evidence: string[];
    fixed_sha?: string;
    responded_at: string;
  };
  owner_reply?: {
    author: string;
    text: string;
    replied_at: string;
  };
  resolution?: { revision: number; outcome: "fixed" | "not_adopted" | "deferred" | "accepted_risk"; reason: string; by: string; at: string };
  needs_owner_closure?: boolean;
  withdrawal_requested?: { by: string; at: string };
  verified_at?: string;
  /** 非作者代确认时的实际操作者；缺席表示由意见作者本人确认。 */
  verified_by?: string;
  /** 意见正文的版本号(0/缺省 = 首版):返工与改字重提都会加一。 */
  rework?: number;
  /** 人点过几次"仍需调整"(0/缺省 = 没退回过)。 */
  returned?: number;
  /** Agent 追问过什么;作者补充说明重提后留档,下一轮给模型看。带 answer
   * 的是人在澄清卡上直接答的。 */
  clarifications?: Array<{
    question: string;
    asked_at: string;
    answered_at: string;
    answer?: string;
    answered_by?: string;
    revision?: number;
  }>;
  /** 作者在意见处对 Agent 回应的逐条回复(问题域检视回复环):每条快照
   * 它所回应的回执,按序即完整线程。 */
  author_replies?: Array<{
    text: string;
    replied_at: string;
    by?: string;
    revision: number;
    response: NonNullable<Annotation["response"]>;
  }>;
}

export interface AnchorCheck {
  id: string;
  state: "hit" | "moved" | "gone" | "ambiguous";
  line_end?: number;
  location_verified?: boolean;
  line?: number;
  now?: string;
}

/** 一条意见此刻的处境:**服务端 feedbackPolicy 算好的结论**。
 *
 * 页面不再按 status/sent_via/response 自己推一遍——那份推法曾经和服务端
 * 各走各的,每加一个入口就多一处不一致(2026-09-04 盘账:本周 42 条 fix
 * 落在这个概念上)。这里只渲染:文案照抄 text/hint,按钮照 can_* 开关。 */
export interface AnnotationClosure {
  id: string;
  tone: "draft" | "waiting" | "review" | "done";
  text: string;
  hint?: string;
  bucket: "mine" | "agent" | "closed";
  delivery_text: string;
  verdict_ready: boolean;
  actionable: boolean;
  can_verify: boolean;
  owner_controlled?: boolean;
  can_resolve?: boolean;
  can_delete?: boolean;
  can_edit?: boolean;
  can_reopen?: boolean;
  can_override_verify: boolean;
  can_override_drop: boolean;
  can_route: boolean;
  needs_clarification: boolean;
  receipt_missing: boolean;
}

export async function listAnnotations(
  taskId: string,
): Promise<{
  items: Annotation[];
  checks: AnchorCheck[];
  closures: AnnotationClosure[];
  submission?: AnnotationSubmissionView;
  /** 最后一批批注送出后,AI 在主会话说的原话(未做逐条对应)。 */
  reply?: { texts: string[]; truncated: boolean };
}> {
  const response = await fetch(`/tasks/${taskId}/annotations`);
  if (!response.ok) return { items: [], checks: [], closures: [] };
  return parseJson(response);
}

export async function addAnnotation(
  taskId: string,
  input: Omit<Annotation, "id" | "author" | "created_at" | "status">,
): Promise<{ annotation?: Annotation; error?: string }> {
  const response = await fetch(`/tasks/${taskId}/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { annotation: await parseJson(response) };
}

/* ---------------- 任务记忆 ---------------- */

/** 与服务端 taskMemory.ts 同合同。正文在 md 里,列表只带这些。 */
export interface MemoryRecord {
  dimension?: "业务规则与边界" | "组件与接口用法" | "设计与实现约束" | "编码规范" | "测试与验证" | "分析与工作方法";
  can_review?: boolean;
  source_repo?: string;
  module?: string;
  product_versions?: string[];
  merged_into?: string;
  maintenance_note?: string;
  edited_by?: string;
  edited_at?: string;
  basis?: { trigger: string; conclusion: string; scope: MemoryRecord["scope"] };
  review?: { status: "pending" | "accepted" | "rejected"; by?: string; at?: string;
    original?: { trigger: string; conclusion: string; scope: MemoryRecord["scope"] } };

  id: string;
  source: "annotation" | "prepush_fix" | "user_note" | "agent_note" | "delivery_review";
  judged_by: "human" | "pipeline" | "agent";
  scope: "one_off" | "local" | "general" | "platform";
  repo: string;
  paths: string[];
  line?: number;
  phase?: string;
  task: string;
  evidence: string;
  author?: string;
  trigger: string;
  quote?: string;
  problem?: string;
  conclusion: string;
  supersedes?: string;
  at: string;
  file: string;
  withdrawn?: boolean;
  superseded_by?: string;
  /** trigger/scope 是模板给的、模型起草的,还是起草失败保留模板。 */
  draft?: "template" | "model" | "failed";
  /** 当前服务中该条记忆是否真的存在整理作业。 */
  drafting?: boolean;
  revision?: number;
  archived?: boolean;
  archive_reason?: string;
}

/** 效能页「任务记忆」只读页签(服务端 src/taskMemory.ts 的镜像)。 */
export interface MemoryRepoInsight {
  repo: string; total: number; active: number; archived: number; withdrawn: number;
  one_off: number; pushes: number; hits: number; reworks: number;
}
export interface MemoryInsightRow {
  module?: string;
  product_versions?: string[];
  merged_into?: string;
  can_review?: boolean;
  review?: MemoryRecord["review"];
  id: string; repo: string; trigger: string; conclusion: string;
  source: MemoryRecord["source"]; judged_by: MemoryRecord["judged_by"];
  scope: MemoryRecord["scope"]; draft: "template" | "model" | "failed";
  drafting: boolean;
  at: string; task: string; paths: string[]; line?: number;
  weight: number; pushes: number; hits: number; reworks: number; last_used?: string;
  archived?: boolean; archive_reason?: string; withdrawn?: boolean; superseded_by?: string;
}
export interface MemoryInsights {
  generated_at: string;
  drafting: number;
  sidecar: "ready" | "unavailable" | "absent";
  repos: MemoryRepoInsight[];
  memories: MemoryInsightRow[];
}
export async function getMemoryInsights(): Promise<MemoryInsights> {
  const response = await fetch("/memory-insights");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}
export async function readMemoryInsight(
  id: string,
): Promise<{ record: MemoryRecord; content: string } | undefined> {
  const response = await fetch(`/memory-insights/${encodeURIComponent(id)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 这单用到的记忆:宿主三个时刻的推送 + Agent 自己的检索/展开。 */
export interface MemoryUsageRow {
  /** 首改目录时推的是目录摘要而不是逐条。 */
  digest?: boolean;
  ts: string;
  moment: "launch" | "phase" | "edit" | "search" | "expand" | "context" | "component_check" | "component_plan";
  plan?: { path: string; capability?: string; operation: string; errors?: number; warnings?: number };
  status?: "ready" | "unavailable" | "empty" | "rejected";
  assets?: Array<{ id: string; revision: string; start_line?: number; end_line?: number; heading?: string; card_id?: string; retrieval?: string }>;
  check?: { trigger: string; head?: string; findings: number; hints: number; rules_digest: string };
  ids: string[];
  query?: string;
  phase?: string;
  dir?: string;
}

export async function listTaskMemoryUsage(taskId: string): Promise<MemoryUsageRow[]> {
  const response = await fetch(`/tasks/${taskId}/memories/usage`);
  if (!response.ok) return [];
  return parseJson(response);
}

export async function reviewTaskMemory(taskId: string, record: MemoryRecord,
  input: { dimension?: MemoryRecord["dimension"]; decision: "pending" | "accepted" | "rejected"; module?: string; product_versions?: string[]; repo?: string; merged_into?: string; note?: string; trigger?: string; conclusion?: string; scope?: MemoryRecord["scope"] }): Promise<MemoryRecord> {
  const response = await fetch(`/memory-insights/${encodeURIComponent(record.id)}/review`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, revision: record.revision ?? 1 }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function listTaskMemories(taskId: string): Promise<MemoryRecord[]> {
  const response = await fetch(`/tasks/${taskId}/memories`);
  if (!response.ok) return [];
  return parseJson(response);
}

export async function readTaskMemory(
  taskId: string,
  memoryId: string,
): Promise<{ record: MemoryRecord; content: string } | undefined> {
  const response = await fetch(
    `/tasks/${taskId}/memories/${encodeURIComponent(memoryId)}`);
  if (!response.ok) return undefined;
  return parseJson(response);
}

export async function withdrawTaskMemory(
  taskId: string,
  memoryId: string,
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/memories/${encodeURIComponent(memoryId)}/withdraw`,
    { method: "POST" });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

export async function dropAnnotation(
  taskId: string,
  annotationId: string,
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}`,
    { method: "DELETE" });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

export async function supplementAnnotation(taskId: string, annotationId: string, context: string): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ context }),
  });
  return response.ok ? {} : await errorBody(response);
}

export async function editAnnotation(
  taskId: string,
  annotationId: string,
  note: string,
): Promise<{ annotation?: Annotation; error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { annotation: await parseJson(response) };
}

/** 检视闭环的裁决:verdict = verify(确认通过) | reopen(返工再送一轮)。 */
export async function judgeAnnotation(
  taskId: string,
  annotationId: string,
  verdict: "verify" | "reopen" | "resolve",
  decision?: { revision: number; outcome?: string; reason?: string },
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}/${verdict}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decision ?? {}) });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 通过执行中补充通道发送给模型。ids 省略=全部待提交批注。 */
export async function sendAnnotations(
  taskId: string,
  ids?: string[],
  context?: string,
): Promise<{ sent?: string[]; receipt?: string; error?: string }> {
  const response = await fetch(`/tasks/${taskId}/annotations/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(ids ? { ids } : {}), ...(context ? { context } : {}) }),
  });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return await parseJson(response);
}

export async function replyToAnnotation(
  taskId: string,
  annotationId: string,
  text: string,
): Promise<{ annotation?: Annotation; error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}/reply`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  if (!response.ok) {
    const body = await errorBody(response);
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { annotation: await parseJson(response) };
}

/** 外部动作台账(需服务端配 --pg)。404 时把服务端的解释原样带回。 */
export async function listActions(
  taskId: string,
): Promise<{ actions?: ExternalAction[]; unavailable?: string }> {
  const response = await fetch(`/tasks/${taskId}/actions`);
  if (!response.ok) {
    const body = await errorBody(response);
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { actions: await parseJson(response) };
}

export type SseConnectionState = "connecting" | "live" | "reconnecting" | "ended";

/** SSE 事件流:重放 + 跟进,组件卸载时调用返回的清理函数。
 * error 时不能主动 close：EventSource 自带断线重连，服务端重放再由
 * eventId 去重；主动关闭会把一次内网抖动变成永久断流。 */
export function tailEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${taskId}/events`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

/** Build-Fix 的实时事件流:换轮(修复后新 HEAD 再验)由服务端切文件
 * 并从头重放新一轮,前端只管渲染。 */
/** Build-Fix 失败停机后,人拍板跳过本地验证、直推流水线裁决。 */
export async function skipBuildFix(taskId: string): Promise<void> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/build-fix/skip`, { method: "POST" });
  if (!response.ok) {
    const body = await errorBody(response);
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
}

/** 人工重跑 Build-Fix:僵尸现场(重启杀掉在途轮)的出路;真在跑时
 * 服务端拒绝并明说"正在进行",等于一次活性探测。 */
export async function retryBuildFix(taskId: string): Promise<void> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/build-fix/retry`, { method: "POST" });
  if (!response.ok) {
    const body = await errorBody(response);
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
}

/** 停止在途的 Build-Fix 并直推流水线(用户拍板的合并语义):中止本轮、
 * 如实收口停机账,随即绑当下 HEAD 跳过,编译与单元测试交由权威流水线裁决。
 * 停止瞬间恰好通过的按通过继续;暂停中的任务只停不推。 */
export async function stopBuildFix(taskId: string): Promise<void> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/build-fix/stop`, { method: "POST" });
  if (!response.ok) {
    const body = await errorBody(response);
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
}

/** 环境预热编译的实时事件流,与 Build-Fix 同一套 SSE 语义。 */
export function tailWarmupEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${taskId}/warmup/events`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

/** 问题侧环境预热的实时事件流(⑤):与需求侧同一 SSE 语义,预热会话
 *  的事件落 <会话根>/warmup/events.jsonl,服务端尾随吐出。 */
export function tailIssueWarmupEvents(
  issueId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(issueApiUrl(`/issues/${encodeURIComponent(issueId)}/warmup/events`));
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

export function tailBuildFixEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
  options?: { follow?: boolean },
): () => void {
  return tailExecutionProjection(taskId, "build-fix", onEvent, onState, options);
}

export function tailExecutionEvents(taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void) {
  return tailExecutionProjection(taskId, "execution", onEvent, onState);
}

function tailExecutionProjection(taskId: string, sourceKind: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
  options?: { follow?: boolean }): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${encodeURIComponent(taskId)}/${sourceKind}/events${options?.follow === false ? "?follow=false" : ""}`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  source.addEventListener("end", () => { source.close(); onState?.("ended"); });
  return () => source.close();
}

/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const skipPrepushVerification = skipBuildFix;
/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const retryPrepushVerification = retryBuildFix;
/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const stopPrepushVerification = stopBuildFix;
/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const tailPrepushEvents = tailBuildFixEvents;

/** 问题会话的实时事件流:服务端从头重放 events.jsonl 后持续跟进
 * (300ms 增量),与任务侧 /tasks/:id/events 同一套 SSE 语义。 */
export function tailIssueEvents(
  issueId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(issueApiUrl(`/issues/${encodeURIComponent(issueId)}/events`));
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

/** 交付时间线条目(服务端 src/timeline.ts 的镜像)。 */
export interface TimelineEntry {
  ts: string;
  kind: "session" | "phase" | "ask" | "decision" | "agent" | "quality" | "memory";
  title: string;
  detail?: string;
  tone: "info" | "attention" | "success" | "danger";
}

/** 任务的人话时间线。服务端未提供该路由(旧进程)时把解释带回,
 * 不假装"这单什么都没发生"。 */
export async function listTimeline(
  taskId: string,
): Promise<{ entries?: TimelineEntry[]; unavailable?: string }> {
  const response = await fetch(`/tasks/${taskId}/timeline`);
  if (!response.ok) {
    const body = await errorBody(response);
    return {
      unavailable: response.status === 404
        ? "时间线接口尚未就绪(服务重启后可用)。"
        : String(body.error ?? `HTTP ${response.status}`),
    };
  }
  return { entries: await parseJson(response) };
}

/** 检视产物(服务端 src/artifacts.ts 的镜像):决策处要看的材料。 */
export interface ArtifactMeta {
  name: string;
  label: string;
  kind: "doc" | "diff";
  bytes: number;
  modified_at: string;
  /** 差异产物包含的真实文件数；文档产物不提供。 */
  file_count?: number;
  /** 完整变更目录；正文在点开文件时另取，避免大文件吃掉整个响应。 */
  change_files?: ArtifactChangeFile[];
  /** 未跟踪目录根；目录内容由用户展开时分页读取。 */
  untracked_directories?: ArtifactChangeDirectory[];
  /** Cloud 生成材料的稳定用途；页面不应靠文件名猜业务语义。 */
  purpose?: "pipeline_evidence_gap" | "delivery_unit_brief" | "delivery_plan" | "overall_story";
  /** 此文档来自已发布的 Story 修订，而非工作区分析稿。 */
  story_published?: boolean;
}

export interface ArtifactChangeFile {
  path: string;
  stage: "committed" | "committed_working" | "staged"
    | "staged_working" | "unstaged" | "untracked";
  additions: number;
  deletions: number;
  stats_status?: "unavailable" | "binary";
}

export interface ArtifactChangeDirectory {
  path: string;
  stage: "untracked";
}

export interface ArtifactChangeDirectoryEntry {
  path: string;
  kind: "file" | "directory";
  file_count: number;
  stage: "untracked";
  stats_status?: "unavailable" | "binary";
  additions?: number;
  deletions?: number;
}

export interface ArtifactChangeDirectoryPage {
  path: string;
  entries: ArtifactChangeDirectoryEntry[];
  total_entries: number;
  total_files: number;
  next_offset?: number;
}

export async function listArtifacts(
  taskId: string,
  signal?: AbortSignal,
  onDocuments?: (result: { items?: ArtifactMeta[]; unavailable?: string }) => void,
): Promise<{ items?: ArtifactMeta[]; unavailable?: string }> {
  if (onDocuments) {
    // 文档到达即可阅读；耗时的 Git 变更扫描独立返回，不挡住任务入口。
    const [documents, changes] = await Promise.all([
      fetchArtifacts(taskId, signal, "doc").then(result => { onDocuments(result); return result; }),
      fetchArtifacts(taskId, signal, "diff"),
    ]);
    return {
      items: [...(documents.items ?? []), ...(changes.items ?? [])]
        .sort((a, b) => b.modified_at.localeCompare(a.modified_at)),
      unavailable: documents.unavailable ?? changes.unavailable,
    };
  }
  return fetchArtifacts(taskId, signal);
}

async function fetchArtifacts(taskId: string, signal?: AbortSignal, kind?: "doc" | "diff")
  : Promise<{ items?: ArtifactMeta[]; unavailable?: string }> {
  const response = await fetch(`/tasks/${taskId}/artifacts${kind ? `?kind=${kind}` : ""}`, { signal });
  if (!response.ok) {
    const body = await errorBody(response);
    return {
      unavailable: response.status === 404
        ? "产物接口尚未就绪(服务重启后可用)。"
        : String(body.error ?? `HTTP ${response.status}`),
    };
  }
  const items: ArtifactMeta[] = await parseJson(response);
  // 前后端滚动升级时旧服务会忽略 kind，客户端仍按请求分类，避免重复条目。
  return { items: kind ? items.filter(item => item.kind === kind) : items };
}

/** 管理页运行时设置(服务端 src/settings.ts 的镜像)。
 * 密钥只写不读:视图里只有掩码(••••末4位),明文永远不出网。 */
export interface SettingsView {
  runtime: {
    max_concurrent?: number;
    /** 问题流回合并发额度(问题会话同时推进的回合上限)。 */
    issue_max_turns?: number;
    /** 问题单环境预热开关;默认关闭,1=开启。 */
    issue_warmup_enabled?: number;
    /** 问题会话回合前压缩的事件量阈值;0=关(缺省)。 */
    issue_compact_every_events?: number;
    /** 终态(取消/归档)问题单代码现场回收开关;0=关。 */
    issue_repo_reclaim?: number;
    /** 问题单构建产物冷却期(小时);0=关。 */
    issue_build_products_cooldown_hours?: number;
    repair_rounds?: number;
    /** 守闸器阈值(分钟,#248);0=关闭。 */
    env_verify_watchdog_minutes?: number;
    /** 自动接单扫描间隔(秒,ADR-0061);缺省 1800(半小时),0=关闭。 */
    issue_auto_claim_interval_s?: number;
    poll_interval_s?: number;
    poll_timeout_s?: number;
    workspace_retention_days?: number;
    build_cache_retention_days?: number;
    build_cache_max_gb?: number;
  };
  execution_policy: {
    blocked_repository_resources?: string[];
    /** 只影响保存后新建任务；每单会固定快照(编译为 team 层补充)。 */
    team_instructions?: string;
  };
  execution_playbooks: ExecutionPlaybookOption[];
  models: {
    configured: boolean;
    provider?: string;
    model?: string;
    url?: string;
    /** 接口格式(openai-completions | anthropic-messages);未配置过时
     * 由表单默认值接手。 */
    api?: string;
    key_hint?: string;
    providers: Array<{ name: string; models: string[]; key_hint?: string }>;
    vision: {
      configured: boolean;
      provider?: string;
      model?: string;
      url?: string;
      api?: string;
      key_hint?: string;
    };
  };
  /** 未设置覆盖时实际采用的服务默认值，不让管理员猜启动参数。 */
  defaults: {
    runtime: {
      max_concurrent: number;
      issue_max_turns: number;
      issue_warmup_enabled: number;
      issue_compact_every_events: number;
      issue_repo_reclaim: number;
      issue_build_products_cooldown_hours: number;
      repair_rounds: number | null;
      env_verify_watchdog_minutes: number;
      issue_auto_claim_interval_s: number;
      poll_interval_s: number;
      poll_timeout_s: number;
      workspace_retention_days: number;
      build_cache_retention_days: number;
      build_cache_max_gb: number;
    };
    models: {
      configured: boolean;
      url?: string;
      model?: string;
      /** 部署默认协议;健康检查与真实调用必须同协议(MFC-011)。 */
      api?: "openai-completions" | "anthropic-messages";
      vision: {
        configured: boolean;
        provider?: string;
        model?: string;
        url?: string;
        api?: string;
      };
    };
  };
}

export interface SystemCheckItem {
  key: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
  suggestion?: string;
}

export interface SystemCheckResult {
  checked_at: string;
  overall: "ok" | "warning" | "error";
  items: SystemCheckItem[];
}

export async function getSystemCheck(): Promise<SystemCheckResult> {
  const response = await fetch("/settings/check");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function getSettings(): Promise<SettingsView> {
  const response = await fetch("/settings");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface BuildCacheEntry {
  key: string;
  repository_hint?: string;
  last_used_at: string;
  size_bytes: number;
  active: boolean;
  tracked: boolean;
}

export interface BuildCacheStatus {
  configured: boolean;
  root?: string;
  caches: number;
  active: number;
  total_bytes: number;
  entries: BuildCacheEntry[];
  policy: { retention_days: number; max_bytes: number };
}

export interface BuildCacheReclaimResult {
  reclaimed: number;
  freed_bytes: number;
  skipped_active: number;
  failed: Array<{ key: string; error: string }>;
  status: BuildCacheStatus;
}

export async function getBuildCacheStatus(): Promise<BuildCacheStatus> {
  const response = await fetch("/settings/build-cache");
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function reclaimUnusedBuildCaches(): Promise<BuildCacheReclaimResult> {
  const response = await fetch("/settings/build-cache/reclaim", {
    method: "POST",
    body: JSON.stringify({ all_unused: true }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

async function putSettings(
  section: "runtime" | "models" | "vision" | "execution-policy",
  body: unknown,
): Promise<SettingsView> {
  const response = await fetch(`/settings/${section}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export function putRuntimeSettings(
  body: Record<string, unknown>,
): Promise<SettingsView> {
  return putSettings("runtime", body);
}

export function putExecutionPolicySettings(body: {
  blocked_repository_resources?: string[];
  team_instructions: string;
}): Promise<SettingsView> {
  return putSettings("execution-policy", body);
}

export function putModelsSettings(
  body: ModelsFormFields & { url: string; api_key: string },
): Promise<SettingsView> {
  return putSettings("models", body);
}

/** 模型网关连通性测试:发送一条真实问答请求,返回网络连通/模型问答
 * 两项结论。字段留空 = 服务端沿用已存配置(密钥不回传明文)。 */
export async function postModelsCheck(
  body: ModelsFormFields,
): Promise<SystemCheckResult> {
  const response = await fetch("/settings/models/check", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export function putVisionSettings(body: {
  url: string;
  api_key: string;
  model: string;
  api: string;
}): Promise<SettingsView> {
  return putSettings("vision", body);
}

export interface VisionProbeResult {
  status: "ready" | "failed";
  provider: string;
  model: string;
  latency_ms: number;
  response?: string;
  error?: string;
}

export async function testVisionCapability(): Promise<VisionProbeResult> {
  const response = await fetch("/settings/vision/test", { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function readRequirementRevision(
  taskId: string,
  revisionId: string,
): Promise<{ before?: string; diff?: string; unavailable?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/requirement-revisions/${encodeURIComponent(revisionId)}`);
  if (!response.ok) {
    const body = await errorBody(response);
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  const body = await parseJson<Record<string, unknown>>(response);
  return { before: String(body.before ?? ""), diff: String(body.diff ?? "") };
}

export async function readArtifact(
  taskId: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ content?: string; kind?: string; branch?: string; unavailable?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/artifacts/${encodeURIComponent(name)}`, { signal });
  if (!response.ok) {
    const body = await errorBody(response);
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  const body = await parseJson<Record<string, unknown>>(response);
  return {
    content: String(body.content ?? ""),
    kind: String(body.kind ?? "doc"),
    branch: body.branch ? String(body.branch) : undefined,
  };
}

export async function readArtifactFileDiff(
  taskId: string,
  path: string,
  signal?: AbortSignal,
): Promise<{
  content?: string;
  branch?: string;
  truncated?: boolean;
  unavailable?: string;
}> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/artifacts/file-diff?path=${
      encodeURIComponent(path)}`, { signal });
  if (!response.ok) {
    const body = await errorBody(response);
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  const body = await parseJson<Record<string, unknown>>(response);
  return {
    content: String(body.content ?? ""),
    branch: body.branch ? String(body.branch) : undefined,
    truncated: body.truncated === true,
  };
}

export async function listArtifactChangeDirectory(
  taskId: string,
  path: string,
  offset = 0,
): Promise<ArtifactChangeDirectoryPage> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/artifacts/change-directory?path=${
      encodeURIComponent(path)}&offset=${Math.max(0, Math.floor(offset))}`);
  if (!response.ok) {
    const body = await errorBody(response);
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
  return await response.json() as ArtifactChangeDirectoryPage;
}

/** 只读浏览导航，不依赖待审批卡。 */
export async function readDiffReview(taskId: string, signal?: AbortSignal): Promise<PushReviewPresentation | undefined> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/diff-review`, { signal });
  if (!response.ok) throw new Error(`读取代码比较范围失败：HTTP ${response.status}`);
  const body = await parseJson<{ review?: PushReviewPresentation | null }>(response);
  return body.review ?? undefined;
}

/** push 检视只允许二选一：看这次处理，或看从任务基线起的完整交付。
 * Git revision 由服务端从任务历史选取，页面不传 ref，也不要求有审批卡。 */
export async function readPushReviewDiff(
  taskId: string,
  scope: "changes" | "full",
  signal?: AbortSignal,
): Promise<{
  content?: string;
  branch?: string;
  unavailable?: string;
  /** HTTP 状态只在不可用时返回，供工作台区分“版本已失效”和暂时故障。 */
  status?: number;
}> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/push-review-diff?scope=${scope}`, { signal });
  if (!response.ok) {
    const body = await errorBody(response);
    return {
      unavailable: String(body.error ?? `HTTP ${response.status}`),
      status: response.status,
    };
  }
  const body = await parseJson<Record<string, unknown>>(response);
  return {
    content: String(body.content ?? ""),
    branch: body.branch ? String(body.branch) : undefined,
  };
}

// ---- 问题流(与需求任务平行的独立会话域) ----

/** 后端认证类报错的机器标记(src/issueFlow/issueGit.ts 的
 * GIT_AUTH_ERROR_TAG 手工镜像,#10 契约护栏未做,双端要同步):
 * 会话页的错误横幅命中它才给「去个人设置配置令牌」跳转——人话改字
 * 不再破坏跳转(旧锚是文案里嵌「Git 令牌」字样)。 */
export const GIT_AUTH_ERROR_TAG = "[git-auth]";

export type IssueStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "idle"
  | "archived"
  | "canceled"
  | "failed";

/** 状态的人话文案。idle 与 waiting_user 的展示已归一为「等你答复」
 * (2026-09-08 用户拍板:两者对人没差别——卡片在等或停机等继续,都是
 * 等人;聚合与筛选把它们算作一格,底层状态保持各自的行为语义)。
 * 2026-09-19 起环境验证卡在场的等待改显「待验证」(issueStatusText
 * 派生)——等的是验证不是答复,通过无需作答,MR 全部合入即视为
 * 通过(ADR-0034)。 */
export const ISSUE_STATUS_TEXT: Record<IssueStatus, string> = {
  queued: "排队启动中",
  running: "AI 处理中",
  waiting_user: "等你答复",
  idle: "等你答复",
  archived: "已归档",
  canceled: "已取消",
  failed: "异常",
};

/** 状态文案(按在场卡派生):环境验证卡在场时显示「待验证」——通过
 * 无需作答(合入即通过,ADR-0034),这张卡等的不是答复;其余状态走
 * ISSUE_STATUS_TEXT。列表与详情的 payload 都带 gate,卡面事实现成。 */
export function issueStatusText(issue: {
  status: IssueStatus;
  gate?: IssueGateCard;
  scenario?: IssueScenario;
  stage_states?: IssueStageState[];
}): string {
  if (issue.scenario === "mr_repair") {
    if (issue.status === "canceled") return "已停止";
    if (issue.stage_states?.[0] === "done") return "修复完成";
    if (issue.status === "idle") return "等待输入";
  }
  if (issue.status === "waiting_user" && issue.gate?.kind === "env_verify") {
    return "待验证";
  }
  return ISSUE_STATUS_TEXT[issue.status];
}

/** 「进行中」口径:未收口(非归档/非取消)。问题处理页默认筛选项与
 * 侧栏「问题处理」父行徽章共用这一份判定,收口状态增减时两处同源,
 * 不许各写各的减法。 */
export const isIssueActive = (status: IssueStatus): boolean =>
  status !== "archived" && status !== "canceled";

// ---- 固定流程(2026-08-27 拍板;#98 单路径化:前端不再感知"模式") ----

export type IssueScenario = "ticket" | "no_ticket" | "mr_repair";
export type FixedIssueStage =
  | "dts_info"
  | "prep_repo"
  | "analyze"
  | "fix"
  | "mr_green"
  | "conclude";

/** 五阶段(2026-09-02 拍板:换库验证封存下线,流程终点=MR 跑绿)。 */
export const FIXED_TICKET_STAGES: FixedIssueStage[] = [
  "dts_info", "prep_repo", "analyze", "fix", "mr_green",
];
export const FIXED_NO_TICKET_STAGES: FixedIssueStage[] = [
  "prep_repo", "analyze", "conclude",
];

const FIXED_STAGE_TEXT: Record<FixedIssueStage, string> = {
  dts_info: "获取 DTS 单信息",
  prep_repo: "拉取代码仓",
  analyze: "问题分析",
  fix: "问题修复",
  mr_green: "提交 MR·跑绿",
  conclude: "确定结论",
};

/** 旧现场词表:已移除的阶段(ut 并入 fix、换库验证封存下线)原样示人,
 * 前端不猜。 */
const LEGACY_STAGE_TEXT: Record<string, string> = {
  ut: "单元测试验证",
  deploy_verify: "换库环境验证(已下线)",
};

/** 阶段中文名(固定流程词表;对不上(旧现场/异键)原样示人——前端不猜)。 */
export function issueStageText(issue: {
  scenario?: IssueScenario;
  stage: FixedIssueStage;
}): string {
  if (issue.scenario === "mr_repair" && issue.stage === "mr_green") return "修复已有 MR 流水线";
  return FIXED_STAGE_TEXT[issue.stage]
    ?? LEGACY_STAGE_TEXT[issue.stage]
    ?? String(issue.stage);
}

/** 固定流程场景的阶段序列(进度条用)。 */
export function fixedStageList(
  scenario: IssueScenario | undefined,
): FixedIssueStage[] {
  return scenario === "no_ticket"
    ? FIXED_NO_TICKET_STAGES : scenario === "mr_repair" ? ["mr_green"] : FIXED_TICKET_STAGES;
}

/** 单阶段执行状态:inherited=转正继承,redo=验证回退待重做。 */
export type IssueStageState =
  | "pending"
  | "in_progress"
  | "done"
  | "inherited"
  | "redo";

/** 平台问题卡(固定流程的人工硬闸):形状与 Agent 问题卡同构,
 * IssueDecisionCard 直接复用渲染。 */
export type IssueGateKind =
  | "analysis_confirm"
  | "conclude"
  | "env_verify"
  // 2026-08-28:代码仓缺口不再走平台闸(pull_repo 工具化);
  // 网管环境缺配置(拉日志/换库现场补配)仍由工具现场举。
  | "env_needed"
  // skill 圈选闸(ADR-0011):分析入口的多选闸,月光关档举起;
  // 勾选清单走 selection 专用口,码表只有「都不用」单码。
  | "skill_select"
  // 流水线红灯人工闸(2026-09-01,票 03):不可修告警闸(人在交付平台
  // 处理/豁免后作答,平台重置监看账重看同一 SHA)与证据回灌闸(把报错
  // 原文粘贴进作答=回灌证据续跑修复)。问的是人工事实,月光永不代答。
  | "pipeline_unfixable"
  | "pipeline_evidence";

/** 闸卡选项 = 决策码 + 文案对(服务端 src/issueFlow/stageRegistry.ts
 * 的 GateOption 镜像):渲染 label,提交 code——文案改字零协议后果。 */
export interface IssueGateOption {
  code: string;
  label: string;
}

/** skill 圈选清单项(服务端 IssueSkillChoice 镜像):path 是会话工作区
 * 相对路径,多仓同名 skill 靠仓段天然唯一;repo 是仓地址(分组展示)。 */
export interface IssueSkillChoice {
  path: string;
  repo: string;
  name: string;
  description: string;
}

export interface IssueGateCard {
  id: string;
  kind: IssueGateKind;
  state_version: number;
  question: { questions?: Array<{
    question: string;
    options: IssueGateOption[];
    /** 推荐项的码(ADR-0004,只标注不预选):分析确认闸在码表里定死,
     * 无单结论闸从 AI 提案派生;换库验证宿主定不了,不硬给。 */
    recommended?: string;
  }> };
  context?: string;
  /** 仅 env_needed:闸为哪类动作而举(logs=拉日志 / deploy=换库部署)。 */
  scope?: "logs" | "deploy";
  /** 仅 skill_select:扫描所得的圈选清单,作答 selection 必须是其子集。 */
  skills?: IssueSkillChoice[];
  /** 仅 pipeline_unfixable/pipeline_evidence:闸归属的仓与提交(卡面
   * 展示用;作答续跑按它在服务端重置监看账/注入证据)。 */
  pipeline?: { repo: string; sha: string };
  proposal?: {
    conclusion?: "issue" | "non_issue";
    summary?: string;
    report?: string;
  };
  created_at: string;
}

/** 终止原因(#541):稳定英文值是协议,界面渲染中文——resolved=问题已
 * 处理(默认)/accidental=无需处理(原文案「误发起」,2026-11-03 更名
 * 只动文案,ADR-0072)/wrong_module=业务模块绑错/
 * inaccurate=分析不准确/slow=速度太慢/disobedient=指令不遵从/
 * unclear_plan=方案未明确/other=其他(附选填说明);排除类排在下拉
 * 前段。与服务端 state.ts 的词表同一份语义。 */
export type IssueCancelReason =
  | "resolved"
  | "accidental"
  | "wrong_module"
  | "inaccurate"
  | "slow"
  | "disobedient"
  | "unclear_plan"
  | "other";

export interface IssueSummary {
  imported_mr?: import("../../src/mrImportTypes").RepairMr;
  id: string;
  /** 归属账号=问题责任人(ADR-0031):写操作与闸口通知的唯一对象。 */
  account: string;
  /** 最近一次会话启动解析到的网关通道(ADR-0068):platform=平台
   * 网关,personal=本人自配的个人网关;beta 是退役前历史会话的
   * 事实账,照读不动。缺席=老会话/未启动。 */
  model_lane?: "platform" | "personal" | "beta";
  /** 登记人(ADR-0031,通常是测试):登记完成即撒手只读跟踪;缺席=
   * 指派机制前的老会话(服务端读盘即补齐=归属)。 */
  reporter?: string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  /** 附加信息(原发起备注,DTS 列表随单填写,#502 更名):登记元信息
   * 的一部分,AI 开场被要求优先读;尾部可带随单附件路径引用。缺席=
   * 发起时没填(含机制加入前的老会话)。 */
  remark?: string;
  /** 会话级介入档位(ADR-0057):发起前按单选定并定格,发起后不可改;
   * 缺席=跟随全局。列表据此显示「特例档名 / 跟随全局」。 */
  intervention_tier?: "1" | "2" | "3";
  /** 自动接单(ADR-0061):发起方式=自动的展示标记;流程语义与人工
   * 发起完全一致,会话页据此挂「自动接单」徽标。缺席=人工发起。 */
  auto_claim?: true;
  source: "manual" | "dts";
  ticket?: string;
  repo_url?: string;
  /** 全部关联仓(彼此平等;与 repo_url 由服务端 dual-write 保持一致)。 */
  repo_urls?: string[];
  /** 参考仓台账(ADR-0054):拉取时命中公共组件仓目录的只读参考件;
   * 不在 repo_urls 里,交付工具结构够不着。会话页据此渲染「参考仓·只读」。 */
  public_repos?: Array<{ url: string; name: string; at: string }>;
  /** 用户指派过的地址(永久留痕):展示层据此把「运行中经人指派」的
   * 在册仓与登记自带仓区分开(用户指派徽标)。 */
  assigned_repos?: string[];
  /** 知识仓装载账(ADR-0033):开工即装的只读参考件;status=ready 才
   * 有现场。会话页据此渲染「知识仓·只读」卡片(装了才出)。 */
  knowledge_repo?: {
    url: string;
    name: string;
    status: "ready" | "skipped";
    note?: string;
    at: string;
  };
  module?: string;
  /** 登记选定的业务模块 ID(module 标签的来源留痕)。 */
  module_id?: string;
  /** 登记基线(分支/tag 等起点说明;问题流登记表单未暴露)。 */
  baseline?: string;
  product_version?: string;
  /** 登记时带的网管环境(地址列表与 vault 引用;密码只存服务端,永不上线)。
   * root_credential_ref 只在独立 root 密码显式存在时在场(ADR-0020:继承
   * 后台密码的会话不落独立凭据)。environment_source_ip 在场=本环境来自
   * 环境管理台账的选定时点快照(#150,非密来源展示用);手填环境没有
   * 这个字段。 */
  environment?: {
    credential_ref: string;
    name: string;
    hosts: string[];
    port: number;
    root_credential_ref?: string;
    /** 快照来源(#150):选定时点的台账主 IP(非密),展示「来自环境管理」用。 */
    environment_source_ip?: string;
    /** 环境形态:虚拟化/容器化 K8s,决定日志抓取引擎;登记或配置卡选定。 */
    env_type?: "virtualized" | "k8s";
  };
  scenario?: IssueScenario;
  stage_states?: IssueStageState[];
  round?: number;
  /** 检视回合进行中(ADR-0007):意见已提交、整体回退到分析重跑,
   * 期间检视入口置灰;新一轮 submit_analysis 时清除。 */
  review_active?: boolean;
  /** skill 圈选台账(ADR-0011):analyze 入口圈选的必读集合;字段在场
   * =已作答(skills 空=明确跳过)。工作台据此展示当前必读集合。 */
  skill_selection?: { at: string; skills: IssueSkillChoice[] };
  /** 业务知识台账(ADR-0012):进入 analyze 时按绑定模块定格的资产库
   * 知识清单(只读投影在 .mae-flow-work/business-modules/)。 */
  business_knowledge?: {
    at: string;
    entries: Array<{
      id: string;
      module_id: string;
      module_name: string;
      title: string;
      summary: string;
      when_to_use: string;
      form: string;
      version: number;
      relative_path: string;
    }>;
  };
  gate?: IssueGateCard;
  ut?: { passed: boolean; summary: string; log_path?: string; round: number; at: string };
  /** 流水线监看(按仓,键=仓地址;一仓一 MR 一流水线)。 */
  pipelines?: Record<string, {
    sha: string;
    status: "running" | "success" | "failed";
    watching: boolean;
    started_at: string;
    deadline: string;
    /** 已自动延期的次数(#372):轮询预算到点先终查,仍在跑且没延期过
     *  就延长一个完整预算再停表——计数随账上 wire,与监看账同进退。 */
    deadline_extensions?: number;
    last_error?: string;
    round: number;
    /** 本仓累计红灯次数(绿了清零):修复轮预算(repair_rounds)的计数,
     *  超限停表请人工。 */
    reds?: number;
    /** 终态落账的检查项(服务端 settlePipeline 存);失败项据此呈现。 */
    checks?: Array<{ dimension: string; status: string; job?: string; url?: string }>;
    /** 证据重试窗字段已随红灯分诊退场(#247,ADR-0024):新写入不再
     *  产生,保留类型只为存量磁盘旧账的只读兼容。 */
    evidence_retry_deadline?: string;
    evidence_retry_attempts?: number;
    evidence_failure_log?: string;
    last_repair_sha?: string;
    last_failure_summary?: string;
    /** 分支头是平台外提交(ADR-0041):字段在场=当前检查目标不是本
     *  会话自己推的——平台按分支最新提交检查,外部推送自动跟随。 */
    external_head?: true;
  }>;
  /** 建 MR 后与需求交付共用的持续检视索引。 */
  feedback?: FeedbackRecord[];
  converted_from?: string;
  converted_to?: string;
  /** 转正继承的交付账引用(#31 只读引用):指向转正前的旧会话,仓卡
   * 渲染时按它经详情接口读旧账并标注「转正前」;旧会话被物理清理时
   * 静默缺省(仓卡退回现状)。 */
  inherited_accounts?: { issue: string };
  /** 人工接管标记(2026-09-07 走查拍板):字段在场=AI 已暂停、人工作业
   * 中——头部「人工接管中」徽标与输入区 takeover 模式都靠它分派;
   * by=接管人,at=接管时刻。交还(resume)后消失。 */
  takeover?: { at: string; by: string };
  status: IssueStatus;
  stage: FixedIssueStage;
  stage_note: string;
  /** 当前阶段的进入时刻(ISO)。 */
  stage_at: string;
  /** 网管环境是否已配置(服务端 summarize 派生)。 */
  has_environment: boolean;
  /** 该单已被排除出自动接单(ADR-0070 单级排除;与 DTS 列表行的同名
   *  字段同一口径,稀疏在场,缺席=允许):终止确认框据此抑制「将改为
   *  排除」的事前提示(ADR-0072)。 */
  auto_claim_excluded?: true;
  /** 本回合已用催办次数(服务端催办预算账;前端暂不消费)。 */
  nudges?: number;
  conclusion?: {
    kind: "non_issue" | "delivered" | "issue";
    summary: string;
    at: string;
  };
  /** 推送账(按仓,一仓一分支)。 */
  pushes?: Array<{ repo: string; branch: string; sha: string; at: string }>;
  /** MR 账(按仓,一仓一 MR;merged_*=合入事实,ADR-0022)。 */
  mrs?: Array<{ repo: string; branch: string; target?: string; title: string; url?: string; iid?: string; at: string; merged_at?: string; merged_sha?: string; closed_at?: string; participants?: MrParticipantsResult }>;
  /** 环境预热收据(对齐清单⑤):running 时工作台直播编译,结束折叠。 */
  warmup?: {
    status: "running" | "passed" | "infrastructure_failure" | "skipped";
    started_at: string;
    finished_at?: string;
    detail?: string;
    build_command?: string;
  };
  /** 阶段转移审计:agent 声明与 platform 机械事实同账。 */
  transitions?: Array<{
    at: string; source: "agent" | "platform"; stage?: FixedIssueStage; note: string;
  }>;
  error?: string;
  last_reply?: string;
  /** 代码现场已回收的时刻(磁盘治理):终态单的 repo/ 被清扫器删除后
   *  落此标记——工作区变更签据此如实降级。 */
  repo_reclaimed_at?: string;
  /** 构建产物已回收的时刻(磁盘治理):返工首编为全量(依赖缓存热)。 */
  build_products_reclaimed_at?: string;
  /** 终止原因(#541):canceled 终态伴生,稳定英文值——resolved=问题已
   *  处理(默认)/accidental=无需处理(ADR-0072 更名)/wrong_module=
   *  业务模块绑错/inaccurate=分析不准确/slow=速度太慢/
   *  disobedient=指令不遵从/unclear_plan=方案未明确/other=其他;
   *  缺席=无原因取消(历史路径)。 */
  cancel_reason?: IssueCancelReason;
  /** 终止补充说明(#541):仅 cancel_reason="other" 带,选填人话。 */
  cancel_reason_text?: string;
}

export interface IssueWaitingCard {
  waiting_id: string;
  state_version: number;
  /** 选项一律是码+文案对:平台闸的码出自服务端注册表码表,Agent 卡
   * 的码由服务端投影时按题号/序号派发(opt-题-序)。渲染 label,
   * 提交 code。 */
  question: { questions?: Array<{
    question: string;
    options: IssueGateOption[];
    /** 推荐项的投影码(ADR-0004,只标注不预选):Agent 卡由服务端把
     * 推荐原文对回 opt-题-序 码,平台闸码表定死/提案派生;前端按码
     * 标徽标,渲染 label、提交 code 的既有约定不变。 */
    recommended?: string;
  }> };
  context?: string;
  created_at: string;
  /** 平台闸专用(会话视图从 detail.gate 带过来):闸的种类与用途面。
   * env_needed 据此渲染专用环境表单,skill_select 据此渲染多选圈选卡,
   * pipeline_unfixable/pipeline_evidence 渲染流水线红灯人工卡,其余闸
   * 仍走通用选项卡。 */
  gate_kind?: IssueGateKind;
  gate_scope?: "logs" | "deploy";
  /** 仅 skill_select:圈选清单(会话视图从 detail.gate.skills 带过来)。 */
  gate_skills?: IssueSkillChoice[];
  /** 仅 pipeline_unfixable/pipeline_evidence:闸归属的仓与提交(会话
   * 视图从 detail.gate.pipeline 带过来,卡面展示定位用)。 */
  gate_pipeline?: { repo: string; sha: string };
  /** 以下为服务端 humanGate 记录随线携带的内部账(卡片只渲染上面的
   * 子集):契约测试(issueFlowContract)钉整卡形状,服务端加字段先
   * 来这里补镜再让测试转绿。 */
  task_id?: string;
  step?: string;
  call_id?: string;
  status?: "waiting" | "resolved" | "superseded";
  decision?: string;
  answers?: Record<string, string>;
  notes?: string;
  resolved_at?: string;
}

export interface IssueDetail extends IssueSummary {
  waiting?: IssueWaitingCard;
  has_analysis: boolean;
  /** 一次结果章(仅「有单+修复完成归档」的会话带):与团队页一次率
   *  两轴同口径——定位=分析报告一版过,修复=环境验证零失败。无单、
   *  取消、失败、非问题收口的会话不带此字段,界面不渲染。 */
  once_outcome?: {
    localization_pass: boolean;
    repair_pass: boolean;
  };
}

export interface DtsTicketBrief {
  ticket: string;
  title: string;
  status?: string;
  version?: string;
  /** 分支匹配结果(ADR-0038):服务端按配置中心映射逐单补齐;未命中
   * 配置时不带,页面按「未配置分支」呈现并禁止发起。 */
  branch?: string;
  /** 模块强匹配带出(ADR-0056):特性名与模块名精确相等且唯一才带,
   * 未命中/重名歧义不带,页面按「未匹配」呈现走必填。 */
  module_id?: string;
  severity?: string;
  submitter?: string;
  url?: string;
  description?: string;
  /** 自动接单单级排除标记(ADR-0070):服务端按排除表逐单补齐;在场=
   *  排除(定时扫描器跳过这张单),缺席=允许不带字段——两态下拉的
   *  缺省值即「允许」。 */
  auto_claim_excluded?: boolean;
}

/** 单张问题单详情(页签展开用):列表字段优先,详情接口补齐描述全文。
 * content = mcpResultText 原文(兜底展示),description = detailDesc 全文。 */
export interface DtsTicketDetail {
  ticket: string;
  title: string;
  content: string;
  description?: string;
  severity?: string;
  version?: string;
  /** 分支匹配结果(ADR-0038):同列表;远程查单入列也带。 */
  branch?: string;
  /** 模块强匹配带出(ADR-0056):同列表,远程查单入列不缺席。 */
  module_id?: string;
  url?: string;
  submitter?: string;
  /** 状态名:远程查单入列要靠它过"开发人员实施修改"可拉取判定。 */
  status?: string;
}

/** env_needed 闸的环境表单 wire 形(POST /issues/:id/environment 请求体,
 * 与服务端 routes 的读取一一对应)。两条作答路(#150,ADR-0020):
 * - 手填:地址 + 端口 + 环境形态 + 网管后台密码,另带可选 root 密码
 *   (留空 = 与后台密码相同)与「存入环境管理」沉淀勾选
 *   (save_to_registry);形态决定日志抓取引擎。
 * - 台账快选:只带 environment_id——值由服务端从台账解密快照进会话
 *   vault,前端永远没有密码;与手填字段互斥,服务端同给 400。
 * 密码只进服务端 vault,不落状态/事件;现场补配的流程碰不到网管页面,
 * 没有页面凭据的位置。decline 分支复用本形状(hosts/backend_password
 * 占位过类型,服务端不读)。 */
export interface IssueEnvironmentForm {
  /** 手填网管环境 IP(单个);快照提交只带 environment_id 时省略。 */
  hosts?: string[];
  port?: number;
  /** 环境形态(虚拟化/容器化):手填提交必带(表单 ready 门强制);
   * decline 分支不带。 */
  env_type?: "virtualized" | "k8s";
  /** 手填网管后台密码;快照提交省略。 */
  backend_password?: string;
  /** 台账快选(#150):选中的环境管理条目 id,提交即服务端快照。 */
  environment_id?: string;
  /** 手填可选独立 root 密码:留空 = 与后台密码相同(服务端不落独立凭据)。 */
  root_password?: string;
  /** 手填沉淀(#150,ADR-0020):把这次手填幂等存进环境管理台账
   * (创建者/更新人=作答人;不覆盖台账已显式配置的密码)。 */
  save_to_registry?: boolean;
}

async function issueFetch(
  path: string,
  init?: RequestInit,
): Promise<any> {
  const response = await fetch(issueApiUrl(path), init);
  if (!response.ok) {
    const body = await errorBody(response);
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
  return parseJson(response);
}

export function listPipelineRepairs(): Promise<IssueSummary[]> {
  return issueFetch("/pipeline-repairs").then(body => body.issues ?? []);
}

export function listIssues(): Promise<IssueSummary[]> {
  return issueFetch("/issues").then((body) => body.issues ?? []);
}

/** 团队看板视角:拉所有人的问题会话(?scope=all)。列表只读,
 * 详情仍按归属校验——只看标题/状态/责任人/阶段,不碰决策与材料。 */
export function listAllIssues(): Promise<IssueSummary[]> {
  return issueFetch("/issues?scope=all").then((body) => body.issues ?? []);
}

/** 首次生成占比与 90%AI生成达标率(ADR-0045,工单 #342):终态伴生
 *  快照(code-origin.json)的读侧聚合,工作量口径(增删行均计)。
 *  分母=有数据(伴生在场且有工作变更行)的完成交付会话;rate null=分母 0
 *  (前端显示 —);pending/unsupported 是口径透明度的伴随计数。字段
 *  纪律(#353):页面常驻旧版前端,后端先行更新时本端点的响应仍会被
 *  旧代码消费——字段加减保持可选,消费方按缺省处理,不得假设总在场。 */
/** per_session ok 行携带的单仓工作行(与服务端 IssueOnceGeneratedSessionRepo
 *  同源镜像;ADR-0065)。 */
export interface IssueOnceGeneratedSessionRepoRow {
  repo: string;
  first: number;
  rework: number;
  external: number;
}

export interface IssueOnceGeneratedSessionRow {
  id: string;
  title: string;
  /** 特性(业务模块名标签;空白归「未分类」)。 */
  module: string;
  concluded_at: string;
  /** ok=有统计数据;no_code=伴生在场但无源码工作行;pending=支持期内
   *  待算;unsupported=早于起算日期(不进统计);canceled=负面原因
   *  主动终止(#542,不进两轴与占比,concluded_at=取消时刻)。 */
  state: "ok" | "no_code" | "pending" | "unsupported" | "canceled";
  /** 首次生成占比(百分数一位小数);仅 ok 行有。 */
  share?: number;
  pass?: boolean;
  lines?: { first: number; rework: number; external: number };
  /** 各仓工作行明细(仅 ok 行;ADR-0065 特性树仓行与按会话仓过滤
   *  的数据源,老前端按缺省处理)。 */
  by_repo?: IssueOnceGeneratedSessionRepoRow[];
  /** 以下工作机器事实仅 ok 行有;canceled 行缺席不设键(#540 复审),
   *  消费方按缺省处理,不得把 false/0 假值当事实。 */
  /** 检视批次数(先行能力,呈现用)。 */
  reviews?: number;
  /** 一次定位:分析报告一版过(与一次定位率同源判定)。 */
  localization_pass?: boolean;
  /** 一次验证:验证不通过次数=0(未答卡=通过)。 */
  verify_pass?: boolean;
  /** 一次解决:定位与验证双一次。 */
  solved_pass?: boolean;
  /** 发起人(发起登记的登录账号;缺席按缺省处理,#353 字段纪律)。 */
  reporter?: string;
  /** 终止原因(#542):仅 canceled 行有。 */
  cancel_reason?: IssueCancelReason;
  /** 终止补充说明(#542):仅 canceled 行且原因=other 时可能在场。 */
  cancel_reason_text?: string;
}

/** 一根比率轴:分子、分母与占比(一次定位剔除转正会话后,分母可
 *  与完成交付全集不同)。 */
export interface IssueOnceGeneratedAxis {
  passed: number;
  total: number;
  rate: number | null;
}

/** 按代码仓的跨会话聚合行(只出代码衍生指标;过程率不设仓维度)。 */
export interface IssueOnceGeneratedRepoRow {
  repo: string;
  /** 涉及会话数(多仓会话按仓各计一次)。 */
  sessions: number;
  first: number;
  rework: number;
  external: number;
  total: number;
  share: number | null;
}

export interface IssueOnceGenerated {
  /** 达标线(参数,部署可调;调线不动统计逻辑)。 */
  threshold_percent: number;
  /** 起算日期:此前终态的会话不进统计。 */
  supported_since: string;
  total: number;
  passed: number;
  rate: number | null;
  /** 完成交付会话总数(一次定位/一次验证两轴的分母)。 */
  delivered: number;
  /** 负面原因主动终止的会话数(#542,一次解决率分母中记失败的部分)。 */
  terminated: number;
  /** 一次定位率(报告一版过;分母剔除转正会话后可与 delivered 不同)。 */
  localization: IssueOnceGeneratedAxis;
  /** 一次验证率(验证不通过次数=0)。 */
  verify: IssueOnceGeneratedAxis;
  /** 一次解决率(定位与验证双一次;分母=完成交付+负面终止,#542)。 */
  solved: IssueOnceGeneratedAxis;
  by_repo: IssueOnceGeneratedRepoRow[];
  pending: number;
  unsupported: number;
  no_code: number;
  per_session: IssueOnceGeneratedSessionRow[];
}

function completionStatsQuery(days?: number, range: CompletionRange = {}) {
  const query = new URLSearchParams();
  if (days) query.set("days", String(days));
  if (range.from) query.set("completed_from", range.from);
  if (range.before) query.set("completed_before", range.before);
  return query.size ? `?${query}` : "";
}
export function getIssueOnceGenerated(days?: number, range?: CompletionRange): Promise<IssueOnceGenerated> {
  return issueFetch(`/issues/once-generated${completionStatsQuery(days, range)}`);
}

/** 登记问题统计(ADR-0048,口径 2026-10-16 由 ADR-0064 收紧):无单
 *  会话的结论漏斗与研究质量,人群=研究结论已出(非问题/确认是问题;
 *  取消是退场、不算研究结论,不进任何数字;研究进行中一律不进,
 *  挂起已退役,存量读盘即按取消退场同不入统计)。 */
export interface IssueRegistrationSessionRow {
  id: string;
  title: string;
  module: string;
  reporter: string;
  account: string;
  concluded_at: string;
  conclusion: "non_issue" | "issue";
  report_version_count: number;
  /** 一次定位(报告一版过)。 */
  localization_pass: boolean;
}

export interface IssueRegistrationGroupRow {
  key: string;
  total: number;
  non_issue: number;
  issue_confirmed: number;
  localization_passed: number;
  localization_total: number;
  localization_rate: number | null;
}

export interface IssueRegistrationStats {
  /** 研究结论已出 = 非问题 + 确认是问题(本页唯一分母全集)。 */
  total: number;
  non_issue: number;
  issue_confirmed: number;
  /** 一次定位,分母同 total。 */
  localization: { passed: number; total: number; rate: number | null };
  per_session: IssueRegistrationSessionRow[];
  by_module: IssueRegistrationGroupRow[];
  by_reporter: IssueRegistrationGroupRow[];
}

export function getIssueRegistrationStats(
  days?: number, range?: CompletionRange,
): Promise<IssueRegistrationStats> {
  return issueFetch(`/issues/registration-stats${completionStatsQuery(days, range)}`);
}

/** 单会话首次生成明细(伴生快照原样,会话详情下钻的证据面)。
 *  by_repo 两态:可得(三分类行数+逐提交证据)或「不可得」(人话理由)。 */
export interface IssueCodeOriginCommitRow {
  sha: string;
  subject: string;
  at: string;
  origin: "first" | "rework" | "external";
  /** 该提交的源码新增行数。 */
  adds: number;
  /** 该提交的源码删除行数(与新增同权,正向工作量)。 */
  dels: number;
  /** 该提交已被 force push 覆盖、不在最终历史里(v4 起;v2/v3 数据
   *  无此字段=留存提交)。 */
  overwritten?: boolean;
}

export interface IssueCodeOriginRepoOk {
  repo: string;
  branch: string;
  head: string;
  head_basis: "merged_sha" | "mr_branch" | "local_push";
  base: string;
  boundary: { kind: string; at: string; push_sha: string } | null;
  lines: { first: number; rework: number; external: number };
  commits: IssueCodeOriginCommitRow[];
  /** 读侧响应可带:会话 mrs 账按 仓+分支 join 出的 MR 链接(可选)。 */
  mr_url?: string;
}

export interface IssueCodeOriginRepoUnavailable {
  repo: string;
  branch: string;
  unavailable: string;
  /** 同 RepoOk(读侧 join,缺席=该仓没有 MR 记录)。 */
  mr_url?: string;
}

export interface IssueCodeOriginDetail {
  schema_version: number;
  generated_at: string;
  session_id: string;
  by_repo: Array<IssueCodeOriginRepoOk | IssueCodeOriginRepoUnavailable>;
}

export function getIssueCodeOrigin(id: string): Promise<IssueCodeOriginDetail> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/code-origin`);
}

export function getIssue(id: string): Promise<IssueDetail> {
  return issueFetch(`/issues/${encodeURIComponent(id)}`);
}

/** 登记侧网管环境(wire 形,与服务端 service.ts 的 normalizeEnvironmentInput
 * 同一把尺):密码只进服务端 vault,任何接口不回显。无单登记服务端
 * 强制 module_id + 环境(spec #15 的 wire 无兼容包袱)。
 * 快照语义(#150,ADR-0020):从环境管理选中提交只带 environment_id——
 * 服务端从台账解密快照进会话 vault(前端永远没有密码)。
 * 页面凭据已整体废弃(2026-09-10:流程不登录网管页面)。 */
export interface IssueRegistrationEnvironmentSnapshot {
  environment_id: string;
}

export interface IssueRegistrationEnvironmentManual {
  hosts: string[];
  /** 环境形态(虚拟化/容器化 K8s),决定日志抓取引擎。 */
  env_type: "virtualized" | "k8s";
  backend_password: string;
}

export type IssueRegistrationEnvironment =
  | IssueRegistrationEnvironmentSnapshot
  | IssueRegistrationEnvironmentManual;

export function createIssue(input: {
  title: string;
  description?: string;
  /** 附加信息(原发起备注,DTS 列表随单填写,#502 更名):进登记元
   * 信息,AI 开场被要求重点优先读;尾部可带随单附件路径引用(服务端
   * 与描述同规则提取同步)。不传=没填。 */
  remark?: string;
  source?: "manual" | "dts";
  ticket?: string;
  repo_url?: string;
  /** 多仓登记(模块带仓是常态):全部关联仓彼此平等,哪些交付由 AI 裁决。 */
  repo_urls?: string[];
  baseline?: string;
  product_version?: string;
  module?: string;
  /** 登记选定的业务模块 ID:后端校验存在且 active,名称派生 module。
   * 无单号登记服务端强制必带,并按模块绑定整表带出仓。 */
  module_id?: string;
  /** 会话级介入档位(ADR-0057):DTS 列表发起前按单选定,随创建请求
   * 定格,发起后不可改;不传=跟随全局。 */
  intervention_tier?: "1" | "2" | "3";
  environment?: IssueRegistrationEnvironment;
  /** 责任人(ADR-0031):登记完成后问题的归属与推进人;登记人=当前
   * 登录用户由服务端取,客户端不传。 */
  assignee?: string;
}): Promise<IssueSummary> {
  return issueFetch("/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** 现象描述内嵌截图:粘贴/拖拽上传图片,返回工作区相对路径引用
 * (issue-images/<hash>.<ext>),前端把它插入 description。 */
export async function uploadIssueImage(
  blob: Blob,
): Promise<{ path: string; bytes: number }> {
  return issueFetch("/issues/issue-image", {
    method: "POST",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
}

/** 登记附件上传(日志等文件,类型不限,单个 500MB 上限):原始文件名
 * 走查询串(服务端取扩展名),字节流式落服务端 staging,返回工作区
 * 相对路径引用(attachments/<hash>.<ext>),前端把它以纯文本插入
 * description——附件是给 AI 读的分析材料,人不预览。 */
export async function uploadIssueAttachment(
  file: File,
): Promise<{ path: string; bytes: number }> {
  return issueFetch(
    `/issues/issue-attachment?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
}

/** 外部图片代理转存(#276):粘贴的外部 <img src="https://..."> 图
 * 前端拿不到字节(跨域带不上对方站的 Cookie),交后端下载落 staging,
 * 返回 issue-images/<hash>.<ext> 引用。data: URL 不走这里(字节已在
 * src 里,前端本地转 Blob 走 uploadIssueImage)。 */
export async function proxyIssueImage(
  url: string,
): Promise<{ path: string; bytes: number }> {
  return issueFetch("/issues/proxy-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

/** 已上传截图的预览 URL(从 staging 回显二进制)。path 是 uploadIssueImage
 * 返回的相对路径引用(issue-images/<hash>.<ext>)。 */
export function issueImageUrl(path: string): string {
  return `/issues/issue-image?path=${encodeURIComponent(path)}`;
}

export function replyIssue(id: string, text: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** 关联仓清单变更(#241):把人对清单的增删裁定一次性通知给 Agent 执行。
 * body { add, remove } 至少一边非空(服务端校验,失败 4xx + 人话中文,
 * 经 issueFetch 抛 Error);add 必须 https:// 前缀、不与现清单重复、合并
 * 计数 ≤ 8,remove 不得是模块绑定仓——这些口径 MetaPane 先行同款即时
 * 校验,别等服务端打回。成功 = HTTP 2xx(回会话概要,与 reply 类端点
 * 同款);清单本身不随本调用乐观更新,随既有事件流(SSE)自刷。 */
export function requestIssueRepoChanges(
  id: string,
  input: { add: string[]; remove: string[] },
): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** 主动拉取日志(#268,Agent 主理第二例,ADR-0026):按钮只递交意图——
 * 端点守卫+留痕+发送通知词,拉取由 Agent 按技能 fetch-logs 执行(缺
 * 环境走既有环境闸),平台不代拉。成功 = HTTP 2xx 会话概要;日志清单
 * 不随本调用更新,随既有 updated_at 轮询自刷。 */
export function requestIssueLogFetch(id: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/logs/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

/** 问题卡作答:decision 是人话文本(显示/自由作答);平台闸另带决策码
 * code(裁决按它分派,文案不是匹配键);Agent 卡带逐题作答 answers
 * (键=题号,值=决策码或自由文本)。 */
export function answerIssue(id: string, input: {
  state_version: number;
  decision: string;
  code?: string;
  answers?: Record<string, string>;
  /** skill 圈选闸(ADR-0011)的勾选清单;空数组=「都不用」。 */
  selection?: string[];
  notes?: string;
}): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function steerIssue(id: string, text: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** 人工接管(2026-09-07 走查拍板):打断 AI 当前回合,现场交由人工
 * (AI 暂停,会话保留);接管期人工操作经 addIssueTakeoverNote 记账,
 * 交还经 resumeIssueTakeover——AI 带着人工记录继续。 */
export function takeoverIssue(id: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/takeover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

/** 接管期人工操作记录:只记账不投喂 AI,交还时随交接词回灌。 */
export function addIssueTakeoverNote(
  id: string,
  text: string,
): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/takeover/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** 交还:AI 带着接管期人工记录继续;note 是可选的交还说明。 */
export function resumeIssueTakeover(
  id: string,
  note?: string,
): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/takeover/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
}

/** 网管环境配置(env_needed 闸的作答口):登记时没配环境,拉日志/
 * 换库现场举闸后在这里补地址与网管后台密码。密码只进服务端 vault,不落
 * 状态/事件;成功即清闸,平台会开回合让 AI 重试刚才的操作。 */
export function attachIssueEnvironment(
  id: string,
  input: IssueEnvironmentForm,
): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/environment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function bindIssueTicket(id: string, ticket: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
}

/** 提单模板(ADR-0048):确认是问题闭环会话的提单文稿原样取回。
 *  404(非问题/取消/早期会话没有模板)返回 null,调用方据此不渲染。 */
export async function getIssueTicketTemplate(id: string): Promise<string | null> {
  const response = await fetch(issueApiUrl(`/issues/${encodeURIComponent(id)}/ticket-template`));
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await errorBody(response);
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
  return response.text();
}

export function controlIssue(id: string, input: {
  action: "cancel" | "revive";
  /** revive 专用(ADR-0055):操作者一句话说明,随恢复回合送达 AI。 */
  note?: string;
  /** 终止原因(#541):cancel 动作的独立入参(不复用 revive 的 note),
   *  界面下拉必选;缺席=无原因取消(历史路径)。revive 不收。 */
  reason?: IssueCancelReason;
  /** 终止补充说明(#541):仅 reason="other" 有意义,选填。 */
  reason_text?: string;
}): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function listDtsTickets(owner?: string): Promise<{
  tickets: DtsTicketBrief[];
  /** 外部开发模式(--dts-mock):单据为模拟数据,页面要挂 DEV 徽标。 */
  mock: boolean;
}> {
  // owner 缺省查本人;传了即协助视角(?owner= 指名看谁名下的单)。
  const body = await issueFetch(owner
    ? `/issues/dts?owner=${encodeURIComponent(owner)}` : "/issues/dts");
  return { tickets: body.tickets ?? [], mock: body.mock === true };
}

export function getDtsTicketDetail(ticket: string): Promise<DtsTicketDetail> {
  return issueFetch(`/issues/dts/${encodeURIComponent(ticket)}`);
}

// ---- 会话材料(交付材料页签;全部旁路,失败给空态) ----

export interface IssueWorkspaceChange {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

/** 拉取日志条目(#47):local-logs 相对路径,type=dir 的 size 恒 0,
 * archive 按扩展名标注(压缩包行才有解压按钮)。 */
export interface IssueLogEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  archive: boolean;
}

export interface IssueLogListing {
  entries: IssueLogEntry[];
  truncated: boolean;
}

export interface IssueMaterials {
  ticket?: string;
  pushes: Array<{ repo: string; branch: string; sha: string; at: string }>;
  mrs: Array<{ repo: string; branch: string; target?: string; title: string; url?: string; iid?: string; at: string; merged_at?: string; merged_sha?: string; closed_at?: string; participants?: MrParticipantsResult }>;
  changes: IssueWorkspaceChange[];
  logs: IssueLogListing;
}

export interface IssueRawEvent {
  eventId?: number;
  ts?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

export function getIssueMaterials(id: string): Promise<IssueMaterials> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials`);
}

export function getIssueFileDiff(
  id: string, path?: string, repo?: string,
): Promise<{ diff: string }> {
  // path = 单文件;repo = 单仓切片(服务端只回该仓,无分段标记,#32)。
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (repo) params.set("repo", repo);
  const query = params.toString();
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/diff${query ? `?${query}` : ""}`);
}

export function getIssueRawEvents(
  id: string, limit = 200,
): Promise<{ events: IssueRawEvent[] }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/events?limit=${limit}`);
}

// ---- 问题会话的视图旁路(服务端 src/issueFlow/sessionView.ts 的镜像) ----

/** 一段"等人"的时长:closed = 有下一条人话封口;open_ended = 问题卡
 * 还开着,ms 以查询时刻截止。 */
export interface IssueTimelineWait {
  start: string;
  end?: string;
  ms: number;
  open_ended?: boolean;
  question: string;
}

/** 关键事件(消息节选级别,不是整段聊天):assistant=结论文节选、
 * decision=用户决策节选、stage=阶段切换(source 标记 AI 上报/平台事实)。 */
export interface IssueTimelineEvent {
  ts: string;
  kind: "assistant" | "decision" | "stage";
  source?: string;
  title: string;
  detail?: string;
}

/** 「耗时与卡点」视图:问题域的消息账 + 转移账归纳结论。 */
export interface IssueTimeline {
  span: { start: string; end: string; ms: number };
  human_waits: IssueTimelineWait[];
  human_wait_ms: number;
  human_wait_share: number;
  longest_waits: IssueTimelineWait[];
  decisions: number;
  blocker: string;
  events: IssueTimelineEvent[];
}

/** 时间线接口尚未就绪(旧进程)时把解释带回,不假装"什么都没发生"。 */
export async function getIssueTimeline(
  id: string,
): Promise<{ timeline?: IssueTimeline; unavailable?: string }> {
  const response = await fetch(issueApiUrl(`/issues/${encodeURIComponent(id)}/timeline`));
  if (!response.ok) {
    const body = await errorBody(response);
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { timeline: await parseJson(response) };
}

// ---- 过程文档(材料页签的过程文档子视图;数据面 documents.ts) ----

export interface IssueDocMeta {
  name: string;
  label: string;
  bytes: number;
  modified_at: string;
}

/** 过程文档清单(分析报告固定首位 + Agent 落的其他 .md)。 */
export function getIssueDocuments(id: string): Promise<{
  documents: IssueDocMeta[];
}> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/documents`);
}

/** 读一份过程文档。缺失为 200 {unavailable}(还没生成),404 只在
 * 问题号未知时出现。 */
export async function getIssueDocument(
  id: string,
  name: string,
): Promise<{ content?: string; truncated?: boolean; unavailable?: string }> {
  const body = await issueFetch(
    `/issues/${encodeURIComponent(id)}/documents/read?name=${encodeURIComponent(name)}`);
  return {
    content: body.content ? String(body.content) : undefined,
    truncated: body.truncated === true ? true : undefined,
    unavailable: body.unavailable ? String(body.unavailable) : undefined,
  };
}

// ---- 分析报告版本(#262,ADR-0025:平台冻结快照,版本页签初版/修订N) ----

/** 服务端 analysisVersions.ts 的 wire 镜像:第 j 份快照 = 第 j 批检视
 * 提交时冻结的报告,live 恒为最新版;相邻同文去重后按时间序命名
 * (初版/修订1/修订2…)。review_ids = 该批提交的意见 id,画冻结版的
 * 锚点标记用;最新版的干净纸面只有草稿标记,故恒为空。 */
export interface IssueAnalysisVersion {
  index: number;
  name: string;
  bytes: number;
  modified_at: string;
  latest: boolean;
  review_ids: string[];
  snapshot?: string;
}

/** 分析报告版本清单(没有检视过的会话只有 live 一版)。 */
export function getIssueAnalysisVersions(id: string): Promise<{
  versions: IssueAnalysisVersion[];
}> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/analysis-versions`);
}

/** 读一个版本的内容(?name=版本名,如 初版/修订1)。缺失为 200
 * {unavailable},404 只在问题号未知时出现。 */
export async function getIssueAnalysisVersion(
  id: string,
  name: string,
): Promise<{ name?: string; content?: string; truncated?: boolean; unavailable?: string }> {
  const body = await issueFetch(
    `/issues/${encodeURIComponent(id)}/analysis-versions/read?name=${encodeURIComponent(name)}`);
  return {
    name: body.name ? String(body.name) : undefined,
    content: body.content ? String(body.content) : undefined,
    truncated: body.truncated === true ? true : undefined,
    unavailable: body.unavailable ? String(body.unavailable) : undefined,
  };
}

// ---- 检视(分析报告正文下方的检视区;ADR-0007,服务端 reviews.ts) ----

/** 服务端 Annotation 的 wire 镜像(问题域只用 doc 一类;verified 等
 * 逐条裁决字段是需求流闭环的,问题域不出,故不镜;response 自
 * ADR-0035 检视分诊起随回复型意见出)。 */
export interface IssueReview {
  external_review?: Annotation["external_review"];
  agent_context?: Annotation["agent_context"];
  agent_assigned?: boolean;
  owner_reply?: Annotation["owner_reply"];
  resolution?: Annotation["resolution"];
  /** AI 的逐条回复(ADR-0035):回复型意见由 respond_review 原地答复,
   * 检视面板在该意见下呈现(需求侧批注回复同款体验);被用户回复
   * 取代的旧回执随 author_replies 留档,最新回应只在 response。 */
  response?: Annotation["response"];
  /** 用户在意见处对 AI 回复的再回复(检视回复环):每条快照它所回应
   * 的回执,按序即完整线程;上一条回复未被 AI 处理前不能再叠。 */
  author_replies?: Annotation["author_replies"];
  quote?: string;
  line_end?: number;
  id: string;
  /** 意见号(#261,ADR-0025):会话内单调分配、永不复用、跨批次连续,
   * 检视区以「意见N」为主键标识;功能上线前的旧账可能缺席。 */
  seq?: number;
  author: string;
  created_at: string;
  artifact: string;
  file: string;
  line: number;
  anchor: string;
  context_before?: string;
  context_after?: string;
  note: string;
  kind: "doc" | "code";
  status: "draft" | "sent" | "verified" | "dropped";
  sent_at?: string;
  sent_via?: string;
  edited_at?: string;
}

/** 锚点检测(送出后原文还在吗):gone = 已被改动(唯一判据),
 * moved = 仅漂移,ambiguous = 多处命中。 */
export interface IssueReviewCheck {
  location_verified?: boolean;
  id: string;
  state: "hit" | "moved" | "gone" | "ambiguous";
  line?: number;
  now?: string;
}

export function getIssueReviews(id: string): Promise<{
  reviews: IssueReview[];
  checks: IssueReviewCheck[];
  review_active: boolean;
}> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews`);
}

export function addIssueReview(id: string, input: {
  quote?: string;
  line_end?: number;
  line: number;
  anchor: string;
  context_before?: string;
  context_after?: string;
  note: string;
}): Promise<IssueReview> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function dropIssueReview(id: string, reviewId: string): Promise<IssueReview> {
  return issueFetch(
    `/issues/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}`,
    { method: "DELETE" });
}

/** 提交检视:整体回退到问题分析(有后果,页面层先轻量确认)。 */
/** resolve_remote=随 reply 在 CodeHub 的讨论串代点已解决(仅 reply
 *  有效,2026-09-18 拍板);本地闭环已随 2026-09-18 走查退役。 */
export function updateIssueReview(id: string, reviewId: string, body: { context?: string; reply?: string; resolve_remote?: boolean }): Promise<IssueReview> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

export function sendIssueReviews(id: string, ids?: string[]): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }),
  });
}

/** 意见处就地回复(检视回复环):review = 意见号或台账 id,答复递给
 * AI 在该意见处再答复。 */
export function replyIssueReview(id: string, review: number | string, text: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ review, text }),
  });
}

/** DTS 单号→业务模块的人工改选条目(团队共享;updated_by/at 供对账)。 */
export interface DtsModuleBindingEntry {
  module_id: string;
  updated_by: string;
  updated_at: string;
}

/** 拉全量人工改选映射(小对象,一次拿全;DTS 页签激活时调用)。 */
export function getDtsModuleBindings(): Promise<
  Record<string, DtsModuleBindingEntry>
> {
  return issueFetch("/issues/dts-bindings")
    .then((body) => body.bindings ?? {});
}

/** 写单条人工改选:moduleId 为空 = 解绑(幂等)。选即存,无保存按钮。 */
export function putDtsModuleBinding(
  ticket: string,
  moduleId: string | null,
): Promise<{ ticket: string; module_id?: string; cleared?: boolean }> {
  return issueFetch(
    `/issues/dts-bindings/${encodeURIComponent(ticket)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(moduleId ? { module_id: moduleId } : {}),
    },
  );
}

/** 写自动接单单级排除(ADR-0070):excluded=true 落条目(PUT)、false
 *  删条目恢复允许(DELETE),幂等。接口在登录闸后,操作人取登录身份,
 *  客户端不传账号。 */
export function putDtsAutoClaimExclusion(
  ticket: string,
  excluded: boolean,
): Promise<{ ticket: string; excluded: boolean;
  updated_by?: string; updated_at?: string }> {
  return issueFetch(
    `/issues/dts-auto-claim-exclusions/${encodeURIComponent(ticket)}`,
    {
      method: excluded ? "PUT" : "DELETE",
      ...(excluded && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    },
  );
}

/* ---------------------------------------------------------------- *
 * 会话流(右栏):服务端把事件账、决定账、批注账、反馈索引拼成"回合"。
 * 页面只渲染、不推断——谁说的、什么时候、针对哪条意见都由服务端给。
 * ---------------------------------------------------------------- */

export interface ConversationSteps {
  calls: number;
  errors: number;
  reads: number;
  edits: number;
  bash: number;
  agents: number;
  sample: Array<{ kind: "edit" | "bash" | "agent"; subject: string }>;
}

export interface ConversationAnnotationRef {
  id: string;
  author: string;
  kind: string;
  file: string;
  line: number;
  note: string;
}

export type ConversationItem =
  | { kind: "push_file_list"; id: string; ts: string; manifest: PushFileList }
  | {
      kind: "session"; id: string; ts: string;
      phase: "started" | "ended";
      resume?: boolean; reason?: string; detail?: string;
    }
  | {
      kind: "turn"; id: string; ts: string; end_ts: string;
      /** narration = 说完就去调工具的过程话;handoff = 说完举卡/收口的交接语。 */
      texts: Array<{ ts: string; text: string; truncated: boolean; role: "narration" | "handoff" }>;
      steps: ConversationSteps;
      open: boolean;
    }
  | {
      kind: "card"; id: string; ts: string; waiting_id: string; step: string;
      purpose: "confirmation" | "clarification";
      annotation_ids: string[];
      questions: Array<{ question: string; options: string[] }>;
      status: "waiting" | "resolved" | "superseded";
    }
  | {
      kind: "decision"; id: string; ts: string; waiting_id: string;
      by?: string; decision: string; answers?: Record<string, string>;
      notes: string; purpose: "confirmation" | "clarification";
      annotation_ids: string[];
    }
  | {
      kind: "steer"; id: string; ts: string; text: string;
      references?: string[]; deferred?: "decision" | "mission";
      delivered: boolean;
    }
  | {
      kind: "annotations_sent"; id: string; ts: string; by?: string;
      via: string; items: ConversationAnnotationRef[];
    }
  | {
      kind: "receipts"; id: string; ts: string;
      items: Array<ConversationAnnotationRef & {
        outcome: string; summary: string; revision: number;
        current: boolean; fixed_sha?: string;
      }>;
    }
  | {
      kind: "owner_reply"; id: string; ts: string;
      annotation: ConversationAnnotationRef; by: string; text: string;
    }
  | {
      kind: "clarified"; id: string; ts: string;
      annotation: ConversationAnnotationRef; by?: string;
      question: string; answer: string;
    }
  | {
      kind: "verified"; id: string; ts: string;
      annotation: ConversationAnnotationRef; by?: string; resolution?: Annotation["resolution"];
    }
  | {
      kind: "reopened"; id: string; ts: string;
      annotation: ConversationAnnotationRef; note?: string; returned: number; by?: string;
    }
  | { kind: "withdrawal_requested"; id: string; ts: string; annotation: ConversationAnnotationRef; by: string }
  | { kind: "revised"; id: string; ts: string; annotation: ConversationAnnotationRef }
  | { kind: "delivery_reset"; id: string; ts: string; annotation: ConversationAnnotationRef; reason: string }
  | {
      kind: "external"; id: string; ts: string; source: FeedbackSource;
      author?: string;
      items: Array<{
        id: string; summary: string; file?: string; line?: number;
        status: FeedbackStatus; resolution?: string;
      }>;
    }
  | {
      kind: "sync"; id: string; ts: string; direction: "received" | "published";
      by: string; repository?: string; targets: number; text: string;
    }
  | {
      kind: "assistant"; id: string; ts: string; role: "user" | "assistant";
      text: string;
    };

export interface ConversationView {
  items: ConversationItem[];
  events_seen: number;
  problems: string[];
}

/** 会话流。旧进程没有这条路由时把原因带回,页面如实说"读不到",
 * 不假装这单没发生过任何往来。 */
export async function getConversation(
  taskId: string,
): Promise<{ view?: ConversationView; unavailable?: string }> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/conversation`);
  if (!response.ok) {
    const body = await errorBody(response);
    return {
      unavailable: response.status === 404
        ? "会话流接口尚未就绪(服务重启后可用)。"
        : String(body.error ?? `HTTP ${response.status}`),
    };
  }
  return { view: await parseJson(response) };
}

/** 服务端 PlantUML 出图结果:svg 或出不了图的原因;语法错误时 svg 是标出错行的错误图。 */
export interface PlantUmlRender {
  svg?: string;
  syntax_error?: boolean;
  error?: string;
  cached?: boolean;
}

export async function renderPlantUml(source: string): Promise<PlantUmlRender> {
  const response = await fetch("/diagrams/plantuml", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/* ---------------------------------------------------------------- *
 * 问题域协作流(#124 右栏「与 Agent 协作」):GET /issues/:id/conversation
 * 把事件账本投影成任务侧 ConversationItem 同形状的条目(服务端本体是
 * src/issueFlow/conversation.ts 的 issueConversation 纯函数)。前端只
 * 渲染、不推断——成员类型与排序都由服务端给;同名成员(session/turn/
 * card/decision/steer)逐字段对齐任务侧,receipts 是问题域扩展(平台
 * 工具回执)。历史卡/裁决/回执只读回放。
 * ---------------------------------------------------------------- */

export interface IssueConversationQuestion {
  question: string;
  options: string[];
}

/** 回合步骤计数(逐字段对齐任务侧 ConversationSteps)。 */
export interface IssueConversationSteps {
  calls: number;
  errors: number;
  reads: number;
  edits: number;
  bash: number;
  agents: number;
  /** 最能说明"这回合干了什么"的几步(改了哪些文件、跑了什么命令)。 */
  sample: Array<{ kind: "edit" | "bash" | "agent"; subject: string }>;
}

export type IssueConversationItem =
  | {
      kind: "session"; id: string; ts: string;
      phase: "started" | "ended";
      resume?: boolean; detail?: string;
    }
  | {
      kind: "turn"; id: string; ts: string; end_ts: string;
      /** narration = 说完就去调工具的过程话;handoff = 说完举卡/收口的交接语。 */
      texts: Array<{ ts: string; text: string; truncated: boolean;
        role: "narration" | "handoff" }>;
      steps: IssueConversationSteps;
      open: boolean;
    }
  | {
      kind: "card"; id: string; ts: string; waiting_id: string; step: string;
      purpose: "confirmation" | "clarification";
      annotation_ids: string[];
      questions: IssueConversationQuestion[];
      /** superseded = 因人工接管现场而作废的历史卡(任务侧同款三态)。 */
      status: "waiting" | "resolved" | "superseded";
    }
  | {
      kind: "decision"; id: string; ts: string; waiting_id: string; by?: string;
      decision: string; notes: string;
      purpose: "confirmation" | "clarification";
      annotation_ids: string[];
      /** 平台闸作答带的问句快照(在闸事件的 payload 里随行)。 */
      questions?: IssueConversationQuestion[];
    }
  | {
      kind: "steer"; id: string; ts: string; text: string;
      delivered: boolean;
    }
  | {
      kind: "review"; id: string; ts: string; receipt?: string; delivery_mode?: "incremental";
      count: number; text: string;
    }
  | {
      kind: "receipts"; id: string; ts: string;
      items: Array<{ name: string; outcome: "success" | "error"; summary: string }>;
    };

export interface IssueConversationView {
  items: IssueConversationItem[];
  /** 账本里读到的全部事件行数(含被投影跳过的)——前端"已读水位"。 */
  events_seen: number;
  truncated: boolean;
}

/** 问题会话协作流(右栏「与 Agent 协作」消费)。 */
export function getIssueConversation(
  id: string,
): Promise<IssueConversationView> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/conversation`);
}

// ---- 环境管理(ADR-0020;票 #149 前端半边):网管环境台账的类型化镜像。
// 台账是全局团队资源,四条路由都只要登录;这里只镜像 wire 形状,不做推断。

export type EnvironmentForm = "virtualized" | "k8s";

export interface EnvironmentProbeView {
  state: "unverified" | "ok" | "failed";
  /** 失败二分(#151 探活回填;本票恒缺席)。 */
  reason?: "auth" | "unreachable";
  at?: string;
}

/** 台账条目视图:服务端 EnvironmentRegistryView 的镜像。零密码字段——
 * 机密只出 password_configured / root_password_inherited 两个非密布尔,
 * 明文密码永不进任何响应、也永不回显进表单。 */
export interface EnvironmentView {
  id: string;
  ip: string;
  port: number;
  form: EnvironmentForm;
  tags: string[];
  probe: EnvironmentProbeView;
  /** true = 没有显式 root 密码,解析值 = 后台密码(表单标记用)。 */
  root_password_inherited: boolean;
  /** 机密只出"已配置"布尔(编辑时以此显示"已配置"占位)。 */
  password_configured: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

/** IP 撞车(POST/PUT 都可能 409):带既有条目 id,页面据此引导去编辑。 */
export class EnvironmentIpConflictError extends Error {
  constructor(readonly existingId: string) {
    super("该 IP 已存在于台账");
  }
}

async function environmentError(response: Response): Promise<Error> {
  const body = await errorBody(response);
  if (response.status === 409 && typeof body.existing_id === "string") {
    return new EnvironmentIpConflictError(body.existing_id);
  }
  return new Error(String(body.error ?? `HTTP ${response.status}`));
}

export async function listEnvironments(): Promise<EnvironmentView[]> {
  const response = await fetch("/environments");
  if (!response.ok) throw new Error(await errorText(response));
  return (await parseJson<{ environments: EnvironmentView[] }>(response))
    .environments;
}

export async function createEnvironment(input: {
  ip: string;
  port?: number;
  form: EnvironmentForm;
  backend_password: string;
  /** 缺席/空 = 留空继承后台密码(placeholder 引导的语义)。 */
  root_password?: string | null;
  tags?: string[];
}): Promise<EnvironmentView> {
  const response = await fetch("/environments", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await environmentError(response);
  return parseJson(response);
}

/** 编辑:backend_password 缺席/空 = 不变(不回显、留空即不改);
 * root_password 缺席 = 不变,传 null = 清显式值回落继承后台密码。 */
export async function updateEnvironment(
  id: string,
  patch: {
    ip?: string;
    port?: number;
    form?: EnvironmentForm;
    backend_password?: string;
    root_password?: string | null;
    tags?: string[];
  },
): Promise<EnvironmentView> {
  const response = await fetch(`/environments/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await environmentError(response);
  return parseJson(response);
}

export async function deleteEnvironment(id: string): Promise<void> {
  const response = await fetch(`/environments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await errorText(response));
}

/** 测试连接/探活的结论:探测失败是正常结论不是 HTTP 错误——一律 200 带
 * ok,失败时 reason 二分(auth=认证失败,unreachable=不可达);缺参才 400。 */
export type EnvironmentTestOutcome =
  | { ok: true }
  | { ok: false; reason: "auth" | "unreachable" };

/** 测试连接(#151):对表单当前值(新增/编辑弹层里现输的)当场验一次,
 * 只探测、不落任何存储;密码是现输的,必须已填。 */
export async function testEnvironmentConnection(payload: {
  ip: string;
  port?: number;
  backend_password: string;
}): Promise<EnvironmentTestOutcome> {
  const response = await fetch("/environments/test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await environmentError(response);
  return parseJson(response);
}

/** 探活已存条目(#151):用台账后台密码对主 IP 探一次并持久化三态,
 * 返回更新后的视图(行内探活与编辑态测试连接都走这里);未知条目 404。 */
export async function probeEnvironment(id: string): Promise<EnvironmentView> {
  const response = await fetch(
    `/environments/${encodeURIComponent(id)}/probe`,
    { method: "POST" },
  );
  if (!response.ok) throw await environmentError(response);
  return parseJson(response);
}

export async function syncTaskSkills(taskId: string): Promise<{ added: string[]; warnings: string[]; receipt: string }> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/skills/sync`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function previewTaskEarlyStart(taskId: string, input: EarlyStartInput = {}): Promise<EarlyStartPreview> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/early-start/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}
export async function startTaskEarly(taskId: string, input: EarlyStartInput): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/early-start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export interface ProductVersion {
  id: string; version: string; branch: string;
  /** 参与自动接单(ADR-0061):true=该版本组名下状态合适的新 DTS 单
   *  会被自动接单扫描发起;缺席=false(老版本缺省不参与)。 */
  auto_claim?: boolean;
}
export function productVersionRequest(method?: "GET"): Promise<{ versions: ProductVersion[] }>;
export function productVersionRequest(method: "POST" | "PUT", row: Partial<ProductVersion>): Promise<ProductVersion>;
export function productVersionRequest(method: "DELETE", row: Partial<ProductVersion>): Promise<{ ok: true }>;
export async function productVersionRequest(method = "GET", row?: Partial<ProductVersion>): Promise<unknown> {
  const response = await fetch(`/product-versions${row?.id ? `/${encodeURIComponent(row.id)}` : ""}`, {
    method, headers: { "content-type": "application/json" },
    ...(method !== "GET" && method !== "DELETE" ? { body: JSON.stringify(row) } : {}),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 知识仓配置(#286):管理员专属,单仓单值;缺席 config 为 null。 */
export interface KnowledgeRepoConfig { url: string; branch?: string; docs_path?: string }
export function knowledgeRepoRequest(method?: "GET"): Promise<{ config: KnowledgeRepoConfig | null }>;
export function knowledgeRepoRequest(method: "PUT", row: KnowledgeRepoConfig): Promise<{ config: KnowledgeRepoConfig }>;
export function knowledgeRepoRequest(method: "DELETE"): Promise<{ ok: true }>;
export async function knowledgeRepoRequest(method = "GET", row?: KnowledgeRepoConfig): Promise<unknown> {
  const response = await fetch("/knowledge-repo", {
    method, headers: { "content-type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify(row) } : {}),
  });
  if (!response.ok) throw new Error(await errorText(response));
  if (method !== "GET") invalidateKnowledgeReads();
  return response.json();
}

export async function createMemoryDraft(trigger: string, conclusion: string): Promise<MemoryRecord> {
  const response = await fetch("/memory-insights", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trigger, conclusion }) });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}
export async function memoryHistory(id: string): Promise<MemoryRecord[]> {
  const response = await fetch(`/memory-insights/${encodeURIComponent(id)}/history`);
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function linkFinalMr(taskId: string, url: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/final-mr`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function getFinalMrComparison(taskId: string, generation: string, signal: AbortSignal): Promise<import("../../src/deliveryAnalyticsTypes").MrComparisonDetail> {
  const query = new URLSearchParams({ generation });
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/final-mr-comparison?${query}`, { signal });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function correctTaskTicket(taskId: string, ticket: string, title: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/correct-ticket`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket, title }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function cancelTaskTicketCorrection(taskId: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/correct-ticket`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

/** 已合入后复用原任务和目录开始修改。requestId 保持不变可安全重试。 */
export async function continueTaskDelivery(taskId: string, text: string, requestId: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/continue-delivery`, {
    method: "POST", body: JSON.stringify({ text, request_id: requestId }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}

export async function generateDeliveryReport(taskId: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/delivery-report`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return parseJson(response);
}
