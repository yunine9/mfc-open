/**
 * CodeHub MR 检视回复的发送原语(需求侧与问题流共用,2026-09-16 抽取)。
 *
 * 只收"怎么发":端点形状、幂等键头、请求体契约、非 2xx 抛错。
 * 何时发、SHA 怎么绑、重试几票是两侧各自拍板的政策(需求侧持票等
 * 匹配收据,问题侧漂移即作废、超限交人工),不进这里——两边的差异
 * 是各自的设计决策,不是漂移,不许在这里悄悄统一。
 *
 * 审计(ADR-0053):每次调用记 host-calls 账(端点/耗时/错误原文),
 * 并把 requestId 透传 x-mfc-request-id 头——适配层(#408)记宿主侧
 * id 为 parent_request_id,两侧日志按同一动作对上(#383② 的解药)。
 */

import { auditPlatformCall, newRequestId } from "./issueFlow/audit.ts";

export interface MrDiscussionReplyRequest {
  platformUrl: string;
  /** 讨论 id,按路径段编码。 */
  discussionId: string;
  repo: string;
  body: string;
  resolve: boolean;
  /** 幂等键:同键重放不产生第二条 CodeHub 回复。 */
  idempotencyKey: string;
  mr?: string | number;
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** 审计关联 id(ADR-0053):调用方动作 id(问题流信箱条目 id);
   *  缺席自动生成。 */
  requestId?: string;
  issueId?: string;
}

export async function postMrDiscussionReply(
  request: MrDiscussionReplyRequest,
): Promise<void> {
  const requestId = request.requestId ?? newRequestId();
  const startedAt = Date.now();
  const response = await fetch(
    `${request.platformUrl.replace(/\/+$/, "")}/mr/discussions/`
      + `${encodeURIComponent(request.discussionId)}/reply`, {
        method: "POST",
        ...(request.signal ? { signal: request.signal } : {}),
        headers: {
          ...request.headers,
          "content-type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
          "x-mfc-request-id": encodeURIComponent(requestId),
        },
        body: JSON.stringify({
          repo: request.repo,
          ...(request.mr !== undefined ? { mr: request.mr } : {}),
          body: request.body,
          resolve: request.resolve,
          idempotency_key: request.idempotencyKey,
        }),
      });
  auditPlatformCall({
    endpoint: "mr-discussion-reply", request_id: requestId,
    ...(request.issueId ? { issue_id: request.issueId } : {}),
    startedAt,
    detail: { repo: request.repo, discussion_id: request.discussionId,
      ...(request.mr !== undefined ? { mr: request.mr } : {}),
      resolve: request.resolve },
    ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** 仅标已解决、不跟帖(2026-09-18,问题流「忽略」用):CodeHub 的
 *  回复与 resolve 是两个调用,这里走适配层独立的 resolve 端点——部署
 *  的 discussion_resolve 模板须按讨论 id({id})解析,不依赖答复输出
 *  里的 note id。 */
export interface MrDiscussionResolveRequest {
  platformUrl: string;
  discussionId: string;
  repo: string;
  idempotencyKey: string;
  mr?: string | number;
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** 审计关联 id(ADR-0053),同 reply。 */
  requestId?: string;
  issueId?: string;
}

export async function postMrDiscussionResolve(
  request: MrDiscussionResolveRequest,
): Promise<void> {
  const requestId = request.requestId ?? newRequestId();
  const startedAt = Date.now();
  const response = await fetch(
    `${request.platformUrl.replace(/\/+$/, "")}/mr/discussions/`
      + `${encodeURIComponent(request.discussionId)}/resolve`, {
        method: "POST",
        ...(request.signal ? { signal: request.signal } : {}),
        headers: {
          ...request.headers,
          "content-type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
          "x-mfc-request-id": encodeURIComponent(requestId),
        },
        body: JSON.stringify({
          repo: request.repo,
          ...(request.mr !== undefined ? { mr: request.mr } : {}),
          idempotency_key: request.idempotencyKey,
        }),
      });
  auditPlatformCall({
    endpoint: "mr-discussion-resolve", request_id: requestId,
    ...(request.issueId ? { issue_id: request.issueId } : {}),
    startedAt,
    detail: { repo: request.repo, discussion_id: request.discussionId,
      ...(request.mr !== undefined ? { mr: request.mr } : {}) },
    ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
