/** 模块统一维护默认检视人与审批人。 */
export interface MrParticipants {
  reviewers: string[];
  approval_approvers: string[];
}

export const MR_PARTICIPANT_ROLES = ["reviewers", "approval_approvers"] as const;
export const MR_PARTICIPANT_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

export interface MrParticipantsResult {
  status: "applied" | "failed" | "skipped";
  requested: MrParticipants;
  message?: string;
}

export function normalizeMrParticipants(value: unknown): MrParticipants {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MR 默认人员必须是包含默认检视人与审批人名单的对象");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !MR_PARTICIPANT_ROLES.includes(key as typeof MR_PARTICIPANT_ROLES[number]))) {
    throw new Error("MR 默认人员包含未知角色");
  }
  return Object.fromEntries(MR_PARTICIPANT_ROLES.map(role => {
    const list = input[role] === undefined ? [] : input[role];
    if (!Array.isArray(list) || list.some(item => typeof item !== "string")) {
      throw new Error("MR 人员名单必须是 CodeHub 账号数组");
    }
    const accounts = [...new Set((list as string[]).map(item => item.trim()).filter(Boolean))];
    if (accounts.some(account => !MR_PARTICIPANT_ACCOUNT_PATTERN.test(account))) {
      throw new Error("MR 人员请填写有效的 CodeHub 账号，不能包含空格或分隔符");
    }
    return [role, accounts];
  })) as unknown as MrParticipants;
}

export function hasMrParticipants(value: MrParticipants | undefined): value is MrParticipants {
  return !!value && MR_PARTICIPANT_ROLES.some(role => value[role].length > 0);
}

export function mrParticipantsMessage(result: MrParticipantsResult | undefined): string {
  if (!result) return "";
  if (result.status === "applied") return "已按模块配置设置 MR 人员。";
  if (result.status === "skipped") return result.message ?? "已有 MR 保留原人员设置。";
  return "";
}
