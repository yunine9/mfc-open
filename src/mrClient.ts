/**
 * MR 创建的公共客户端(需求交付与问题流共用)。
 *
 * 两个流程用同一格式调用同一个端点:交付平台适配层(src/
 * platformAdapter.ts)的 POST /mr——它负责真正的 codehub CLI 调用、
 * 模板占位符(含 {dts_no} → --e2e-issues 单号关联)、输出抽取与幂等。
 * 这里只做 HTTP 形状:个人身份走 percent 编码请求头(令牌不进请求体,
 * 请求体会被外部动作台账记进投影),按操作设置超时预算,错误带状态码上浮。
 */

import { readMrFailureBody } from "./mrGateClient.ts";
import { knowledgeHttpFailure } from "./knowledgeProductionErrors.ts";
import { hasMrParticipants, normalizeMrParticipants, type MrParticipants, type MrParticipantsResult } from "./mrParticipants.ts";

export interface MergeRequestCredential {
  username: string;
  password: string;
}

export interface MergeRequestCall {
  platformUrl: string;
  /** 目标仓地址;缺席时适配层按自身单仓配置处理(与旧请求体一致)。 */
  repo?: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  /** 单号(REQ/DTS):适配层拿它填 CLI 的单号关联参数。 */
  dtsNo?: string;
  credential?: MergeRequestCredential;
  timeoutMs?: number;
  purpose?: "knowledge";
  /** 知识发布显式启用；共享客户端的原默认行为保持不变。 */
  signal?: AbortSignal;
  includeFailureMetadata?: boolean;
  participants?: MrParticipants;
}

export interface MergeRequestReceipt {
  url: string;
  id?: string | number;
  /** 平台返回的原始响应体。外部动作台账(主 spec §11)记的是"平台到底
   * 回了什么",恢复时要拿它对远端真实状态——抽剩 url/id 再入账等于自己
   * 把证据裁掉了,所以整体原样带出。 */
  raw: Record<string, unknown>;
  participants?: MrParticipantsResult;
}

function participantResult(requested: MrParticipants, raw: unknown): MrParticipantsResult {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (!["applied", "failed", "skipped"].includes(String(value.status))) {
    return { status: "failed", requested, message: "适配器未返回创建时的人员结果，请确认已部署创建参数配置" };
  }
  return { status: value.status as MrParticipantsResult["status"], requested,
    ...(typeof value.message === "string" ? { message: value.message } : {}) };
}

export async function closeMergeRequest(call: {
  platformUrl: string; repo: string; mr: string | number; credential?: MergeRequestCredential;
}): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.credential) {
    headers["x-mfc-git-user"] = encodeURIComponent(call.credential.username);
    headers["x-mfc-git-token"] = encodeURIComponent(call.credential.password);
  }
  const response = await fetch(`${call.platformUrl.replace(/\/+$/, "")}/mr/close`, {
    method: "POST", headers, body: JSON.stringify({ repo: call.repo, mr: call.mr }), signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`旧 MR 关闭失败 HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  const result = await response.json() as { mr_state?: string };
  if (result.mr_state !== "closed") throw new Error("平台未确认旧 MR 已关闭");
}

export async function createMergeRequest(
  call: MergeRequestCall,
): Promise<MergeRequestReceipt> {
  const participants = call.participants ? normalizeMrParticipants(call.participants) : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (call.credential) {
    headers["x-mfc-git-user"] = encodeURIComponent(call.credential.username);
    headers["x-mfc-git-token"] = encodeURIComponent(call.credential.password);
  }
  const controller = new AbortController();
  // 覆盖带人员参数的创建、前置查找与异常补查，避免 MR 已建却先丢失回执。
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? (hasMrParticipants(participants) ? 210_000 : 90_000));
  const signal = call.signal ? AbortSignal.any([controller.signal, call.signal]) : controller.signal;
  try {
    if (call.signal || call.includeFailureMetadata) signal.throwIfAborted();
    const response = await fetch(`${call.platformUrl.replace(/\/+$/, "")}/mr`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(call.repo ? { repo: call.repo } : {}),
        source_branch: call.sourceBranch,
        target_branch: call.targetBranch,
        title: call.title,
        ...(call.dtsNo ? { dts_no: call.dtsNo } : {}),
        ...(call.purpose ? { purpose: call.purpose } : {}),
        ...(hasMrParticipants(participants) ? { participants } : {}),
      }),
      signal,
    });
    if (call.signal || call.includeFailureMetadata) signal.throwIfAborted();
    if (!response.ok) {
      if (call.includeFailureMetadata) {
        const failure = knowledgeHttpFailure(response, `MR 创建失败 HTTP ${response.status}`);
        const detail = await readMrFailureBody(response, signal).catch(error => error instanceof Error ? error.message : String(error));
        signal.throwIfAborted();
        failure.message += detail ? `: ${detail}` : "";
        throw failure;
      }
      const text = await response.text().catch(() => "");
      call.signal?.throwIfAborted();
      throw new Error(`MR 创建失败 HTTP ${response.status}`
        + (text ? `: ${text.slice(0, 300)}` : ""));
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (call.signal || call.includeFailureMetadata) signal.throwIfAborted();
    const url = String(body.url ?? "");
    if (!url) {
      throw new Error(`平台返回里没有 MR 链接(url): ${JSON.stringify(body).slice(0, 300)}`);
    }
    return {
      url,
      ...(body.id !== undefined && body.id !== null && body.id !== ""
        ? { id: body.id as string | number } : {}),
      raw: body,
      ...(hasMrParticipants(participants) ? { participants: participantResult(participants, body.participants) } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
