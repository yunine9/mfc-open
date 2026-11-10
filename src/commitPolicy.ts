/**
 * CodeHub 默认项目钩子的提交标题契约。
 *
 * 业务 Agent 仍由 Mae-Flow 内核约束为 `[单号][feat|fix]描述`；Cloud 还会
 * 产生 Build-Fix/清单整理/冲突合并等内核外提交，但普通提交仍只准 feat/fix，
 * 因此在真正 push 前必须用同一份机器规则复核，不能只靠远端宽松超集。
 */

export const DEFAULT_COMMIT_CONVENTION =
  "业务提交使用 [单号][feat|fix]描述；Build-Fix 修复使用 [单号][fix]描述；"
  + "平台整理也使用 [单号][fix]描述；合并提交保留平台允许的 Merge 信息。";

const TYPES = "feat|fix|refactor|test|chore|docs|style";

/** 与内网 CodeHub default hook 已取证的五个分支保持同形。 */
export const DEFAULT_CODEHUB_COMMIT_SUBJECT = new RegExp(
  "^(?:"
  + `\\[\\w+\\]\\[(?:${TYPES})\\]\\s*\\S.*`
  + "|Merge remote-tracking branch '.+' into \\w+"
  + "|merge '.+' into '.+'"
  + "|Merge branch '.+' of .+ into .+"
  + "|Merge branch '.+' of .+"
  + ")$",
);

/** Mae-Flow 自己的任务契约比 CodeHub default hook 更窄：普通提交只准
 * feat/fix。远端接受 chore 不代表 Cloud 可以绕开内核口径生成 chore。 */
export const DEFAULT_TASK_COMMIT_SUBJECT = new RegExp(
  "^(?:"
  + "\\[\\w+\\]\\[(?:feat|fix)\\]\\s*\\S.*"
  + "|Merge remote-tracking branch '.+' into \\w+"
  + "|merge '.+' into '.+'"
  + "|Merge branch '.+' of .+ into .+"
  + "|Merge branch '.+' of .+"
  + ")$",
);

export interface CommitSubjectRecord {
  sha: string;
  subject: string;
}

export class CommitMessagePolicyError extends Error {
  constructor(
    message: string,
    readonly commits: CommitSubjectRecord[] = [],
  ) {
    super(message);
    this.name = "CommitMessagePolicyError";
  }
}

export function validPlatformCommitSubject(subject: string): boolean {
  return DEFAULT_CODEHUB_COMMIT_SUBJECT.test(String(subject ?? "").trim());
}

export function validTaskCommitSubject(subject: string): boolean {
  return DEFAULT_TASK_COMMIT_SUBJECT.test(String(subject ?? "").trim());
}

function commitKey(value: string): string {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "") || "TASK";
}

function inferredType(subject: string): "feat" | "fix" {
  const conventional = String(subject ?? "").trim().match(
    /^(?:\[[^\]]+\]\[)?(feat|fix)(?:\]|(?:\([^)]*\))?:)/i,
  );
  return conventional?.[1]?.toLowerCase() === "feat" ? "feat" : "fix";
}

function cleanDescription(subject: string): string {
  const cleaned = String(subject ?? "")
    .split(/\r?\n/, 1)[0]
    .replace(/^\[[^\]]+\]\[(?:feat|fix|refactor|test|chore|docs|style)\]\s*/i, "")
    .replace(/^(?:feat|fix|refactor|test|chore|docs|style)(?:\([^)]*\))?:\s*/i, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "修正本次交付提交说明").slice(0, 180);
}

/** 把一个不合规的普通提交标题修成平台可接收标题，不改提交内容。 */
export function repairedPlatformCommitSubject(
  ticket: string,
  subject: string,
): string {
  return `[${commitKey(ticket)}][${inferredType(subject)}]${cleanDescription(subject)}`;
}

/** Cloud 自己生成提交时必须从源头使用同一规则。 */
export function cloudCommitSubject(
  ticket: string,
  type: "feat" | "fix",
  description: string,
): string {
  return `[${commitKey(ticket)}][${type}]${cleanDescription(description)}`;
}

export function commitHookRejection(value: string): boolean {
  const text = String(value ?? "");
  return /does not match the regular-expression/i.test(text)
    || /Deny by project hooks setting[^\n]*message of commit/i.test(text);
}

export function rejectedCommitSha(value: string): string | undefined {
  return String(value ?? "").match(/message of commit ['"]([0-9a-f]{7,64})['"]/i)?.[1];
}
