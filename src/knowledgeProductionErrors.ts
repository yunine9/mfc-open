import { classifyDeliveryFailure } from "./deliveryFailure.ts";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const KNOWLEDGE_RESEARCH_BUDGET_MESSAGE = "已达研究总预算 48 小时，本轮停止；可在审查当前草稿后发起更新";

export interface KnowledgeFailureDetails { httpStatus?: number }
/** 只保留真实响应码，平台正文中提到的其他HTTP码不改变错误分类。 */
export function knowledgeHttpFailure(response: Pick<Response, "status">, reason: string): Error {
  return Object.assign(new Error(reason), { httpStatus: response.status });
}
export function knowledgeFailureDetails(error: unknown): KnowledgeFailureDetails {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const details = current as Error & KnowledgeFailureDetails;
    if (Number.isInteger(details.httpStatus) && details.httpStatus! >= 100 && details.httpStatus! <= 599) {
      return { httpStatus: details.httpStatus };
    }
  }
  return {};
}

export type KnowledgeGitFailureKind = "authentication" | "network" | "non_fast_forward" | "not_found" | "unknown";
export function classifyKnowledgeGitFailure(diagnostics: string): KnowledgeGitFailureKind {
  if (/Authentication failed|could not read Username|(?:HTTP|status|error)[ :=]+(?:401|403)\b|returned error:\s*(?:401|403)\b/i.test(diagnostics)) return "authentication";
  if (/Could not resolve host|timed out|Failed to connect|Could not connect|Connection (?:refused|reset)|Empty reply from server/i.test(diagnostics)) return "network";
  if (/non-fast-forward|fetch first/i.test(diagnostics)) return "non_fast_forward";
  if (/not found|does not appear to be a git repository|repository .*does not exist|not our ref|couldn't find remote ref|unadvertised object/i.test(diagnostics)) return "not_found";
  return "unknown";
}

/** 分类沿用平台客户端的失败原因，给人对应的处理动作。 */
export function knowledgeFailureDisposition(error: unknown): "retry" | "stall" {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const reason = message(cause), status = knowledgeFailureDetails(error).httpStatus ?? reason.match(/\bHTTP (\d{3})\b/)?.[1];
  // 平台正文可能提到上游的其他 HTTP 码，只按客户端写在原文前的响应码分类。
  if (status) return classifyDeliveryFailure(`HTTP ${status}`).disposition === "stall" ? "stall" : "retry";
  if (/Git (?:鉴权失败|非快进|仓库不存在)/.test(reason)) return "stall";
  return classifyDeliveryFailure(reason).disposition === "stall" ? "stall" : "retry";
}

export function knowledgeGitFailure(kind: KnowledgeGitFailureKind, context: string): Error {
  const reason = kind === "authentication" ? "Git 鉴权失败；请到「个人设置 → CodeHub」更新个人令牌，并核对仓库权限"
    : kind === "network" ? "Git 网络暂时故障；请检查网络和 Git 服务连接，恢复后可重试"
    : kind === "non_fast_forward" ? "Git 非快进：远端分支已有新提交；请先拉取并核对远端更新后再发布"
    : kind === "not_found" ? "Git 仓库不存在或版本不可访问；请检查仓库地址、路径及个人访问权限，或联系仓库管理员"
    : "Git 操作失败，请检查个人权限、分支和网络";
  return new Error(`${context} ${reason}；未覆盖远端提交`);
}

export function knowledgeMrFailure(error: unknown, operation: "MR 创建" | "原分支 MR 查询", secrets: string[] = []): Error {
  let reason = message(error);
  for (const secret of secrets.filter(Boolean)) {
    for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) reason = reason.split(form).join("[已隐藏]");
  }
  reason = reason.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@");
  // 格式化后的 cause 保留真实响应信息，但不能带回原错误中的令牌。
  const details = knowledgeFailureDetails(error), original = Object.assign(new Error(reason), details);
  const status = details.httpStatus ?? Number(reason.match(/\bHTTP (\d{3})\b/)?.[1]);
  let next: string;
  if (knowledgeFailureDisposition(original) === "stall") {
    next = status === 401 ? "请到「个人设置 → CodeHub」更新个人令牌，并核对 Git 账号"
      : status === 403 ? "请确认个人账号有目标仓与 MR 操作权限，或联系仓库管理员授予权限"
      : status === 404 ? "请联系管理员检查 MR 平台地址、目标仓库与 MR 是否存在"
      : status === 400 ? "请联系管理员按平台原文检查 mr_create_knowledge 命令配置及请求内容"
      : "请联系管理员按平台原文检查 MR 平台配置与响应内容";
    return new Error(`${operation}失败：${reason}；${next}`, { cause: original });
  }
  const prefix = operation === "MR 创建" ? "文档已推送，MR 创建尚未确认" : `${operation}暂时失败`;
  return new Error(`${prefix}；暂时故障：${reason}；服务恢复后可手动重试，将先查询已有 MR 并沿用原分支`, { cause: original });
}
