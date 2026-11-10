/**
 * 自动验证停摆的类别——**唯一的停摆策略表**。
 *
 * 为什么要有(2026-09-06 盘账,docs/stall-sites-20260906.md):
 * markVerificationStalled 有 24 个调用点、另有 2 处直接写 stalled,每处只带
 * 一句中文原因、没有类别。于是内核抖一下和收据造假被一视同仁地"停下喊人";
 * 页面对所有停摆说同一句"查看失败原因并重跑续推",任务卡甚至对没有修复环
 * 的停摆一律写"确认外部平台恢复后点重新尝试交付"——对合入 SHA 对不上、
 * 外来提交这类完整性停摆,这句话是在劝人跳过核实直接重试。
 *
 * 类别按"人接手要做什么"分,不按"错在哪个模块"分。措辞不点名按钮文字
 * (任务卡上叫「重新尝试交付」或「重跑续推」,两处不同),统一说"重试交付"。
 */
export type StallClass =
  | "infrastructure"
  | "evidence_missing"
  | "evidence_invalid"
  | "contract"
  | "safety";

export interface StallPolicy {
  /** 通知与页面上的短标签。 */
  label: string;
  /** 停之前理应先带预算自愈;只有基础设施类为 true。调用点拿不到预算
   * 上下文时仍会直接停,但类别告诉人"这不是你的错,等恢复再重试"。 */
  retry_first: boolean;
  /** 焦点里的"下一步":去哪、做什么、做完会怎样。 */
  next_action: string;
}

export const STALL_POLICY: Readonly<Record<StallClass, StallPolicy>> = {
  infrastructure: {
    label: "平台或内核暂时不通",
    retry_first: true,
    next_action: "不用改代码:等平台或内核恢复后在任务页重试交付,机器从停下的地方接着验证",
  },
  evidence_missing: {
    label: "缺少材料",
    retry_first: false,
    next_action: "按停摆原因把缺的材料补齐(回灌流水线原文、补 Build-Fix 收据或平台事实)后在任务页重试交付",
  },
  evidence_invalid: {
    label: "材料不合格",
    retry_first: false,
    next_action: "看停摆原因点名的收据问题,让 Agent 重做或在工作台补说明,再在任务页重试交付",
  },
  contract: {
    label: "配置或平台契约不对",
    retry_first: false,
    next_action: "修正任务配置、平台接入或提交本身后在任务页重试交付;配置不改,重试结果不变",
  },
  safety: {
    label: "完整性待核实",
    retry_first: false,
    next_action: "先人工核实分支与提交(是否被平台改写、是否有外来改动),确认无误再重试交付;系统不会自动重试",
  },
};

export const STALL_CLASSES = Object.keys(STALL_POLICY) as StallClass[];

export function isStallClass(value: unknown): value is StallClass {
  return typeof value === "string" && (STALL_CLASSES as string[]).includes(value);
}
