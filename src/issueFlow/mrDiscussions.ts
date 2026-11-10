/** CodeHub MR 检视讨论客户端(问题流,票 01 发现与落账)。
 *
 * 只做 HTTP 形状,与 mrClient/pipelineClient 同一纪律:个人身份走
 * percent 编码请求头(令牌不进请求体,身份头构造与 pipelineClient
 * 共用一份),超时预算,错误带状态码上浮。语义是 fail-open 的查询口
 * ——适配层未配置(404)/坏响应/网络失败都归 unavailable 并带原因,
 * 调用方决定等下一轮还是降级,本客户端绝不抛错打断监看。
 */

import { pipelineHeaders } from "../pipelineClient.ts";
import { auditPlatformCall, newRequestId } from "./audit.ts";

export interface MrDiscussionItem {
  id: string;
  revision?: number;
  updated_at?: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body?: string;
}

export type MrDiscussionsFetch =
  | { kind: "available"; items: MrDiscussionItem[] }
  | { kind: "unavailable"; reason: string };

export interface MrDiscussionsCredential {
  username: string;
  password: string;
}

/** 检视回复出站信箱的一条发送(问题域简版,票 03)。三条不变量:
 * Idempotency-Key=id 稳定防重放;expected_sha 绑定装箱时的推送收据,
 * SHA 漂移绝不发送——不能借另一版代码说"已修";mr 在装箱时按 MR
 * 台账固化(同 expected_sha 的"装箱绑事实"),发送时透传给适配层——
 * 部署的命令模板引用 {mr},缺席必报「没有值」(issue-383)。缺席
 * expected_sha=不主张代码已改(责任人答复,ADR-0032),发送不做版本核对。 */
export interface MrReviewReplyOutboxItem {
  id: string;
  repo: string;
  discussion_id: string;
  /** MR 标识(iid 或完整 URL,与监看拉取同口径);装箱时从会话 MR
   * 台账按 repo 固化。旧条目缺席时发送不传,模板引用 {mr} 会诚实报错。 */
  mr?: string | number;
  /** resolve_only=true 时必须为空串:不跟帖,只代点已解决。 */
  body: string;
  resolve: boolean;
  /** 仅标已解决(2026-09-18「忽略」):走适配层独立 resolve 端点,
   * 不发答复;expected_sha 恒空(不主张代码已改,不做版本核对)。 */
  resolve_only?: boolean;
  expected_sha?: string;
  /** 装箱来源的 AI 回应时间(respond_review 的 responded_at):按次
   * 去重键——每次 respond 一条,追问线程的后续回复照发(ADR-0052)。
   * 责任人答复/忽略的装箱不带。 */
  responded_at?: string;
  /** 装箱人;缺席=Agent 草稿,责任人在场时记归属账号。 */
  author?: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_error?: string;
  created_at: string;
  delivered_at?: string;
}

export async function fetchMrDiscussions(input: {
  platformUrl: string;
  repo: string;
  /** MR 标识:iid 或完整 URL,按适配层命令模板的 {mr} 占位而定。 */
  mr?: string | number;
  credential?: MrDiscussionsCredential;
  timeoutMs?: number;
}): Promise<MrDiscussionsFetch> {
  const headers = pipelineHeaders(input.credential);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
  // 调用账(ADR-0053):拉取失败是 #383 考古的重点路径,成败都记。
  const requestId = newRequestId();
  const startedAt = Date.now();
  let failure: string | undefined;
  let status: number | undefined;
  try {
    const params = new URLSearchParams({ repo: input.repo });
    if (input.mr !== undefined) params.set("mr", String(input.mr));
    const response = await fetch(
      `${input.platformUrl.replace(/\/+$/, "")}/mr/discussions?${params}`,
      { headers, signal: controller.signal });
    status = response.status;
    if (!response.ok) {
      // 适配层的 502 正文带 CLI stderr；只记 HTTP 状态码会把真实原因
      // （429/超时/连接拒绝）丢在适配器日志里，故障无法归因。
      const text = await response.text().catch(() => "");
      let detail = text.trim();
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (parsed?.error) detail = String(parsed.error).trim();
      } catch { /* 非 JSON 就按原文摘要。 */ }
      failure = `HTTP ${response.status}${detail ? `: ${detail.slice(0, 600)}` : ""}`;
      return { kind: "unavailable", reason: failure };
    }
    const body = await response.json() as { discussions?: unknown };
    const items = (Array.isArray(body.discussions) ? body.discussions : [])
      .filter((item: any) => typeof item?.id === "string" && item.id)
      .map((item: any) => ({
        id: String(item.id),
        ...(item.revision !== undefined
          && Number.isSafeInteger(Number(item.revision))
          ? { revision: Number(item.revision) } : {}),
        ...(item.updated_at !== undefined
          ? { updated_at: String(item.updated_at) } : {}),
        ...(item.file !== undefined ? { file: String(item.file) } : {}),
        ...(item.line !== undefined ? { line: Number(item.line) } : {}),
        ...(item.severity !== undefined
          ? { severity: String(item.severity) } : {}),
        ...(item.author !== undefined ? { author: String(item.author) } : {}),
        ...(item.body !== undefined ? { body: String(item.body) } : {}),
      }));
    return { kind: "available", items };
  } catch (error) {
    failure = String(error instanceof Error ? error.message : error);
    return {
      kind: "unavailable",
      reason: failure,
    };
  } finally {
    auditPlatformCall({
      endpoint: "mr-discussions-list", request_id: requestId, startedAt,
      detail: { repo: input.repo,
        ...(input.mr !== undefined ? { mr: input.mr } : {}) },
      ...(status !== undefined ? { status } : {}),
      ...(failure ? { error: failure } : {}),
    });
    clearTimeout(timer);
  }
}
