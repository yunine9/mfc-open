import { resolve } from "node:path";

/** Agent 自己维护的工作记录；宿主不读取、不据此拦截流程。 */
export const PENDING_DECISIONS_FILE = ".mae-flow-work/pending-decisions.json";

export function pendingDecisionRecoveryPrompt(): string {
  return `新交办、插话、恢复会话或上下文压缩后，先读取 ${PENDING_DECISIONS_FILE}（存在时），结合原有文档和工具结果接续。保留先前分析、已完成修改、验证结果及未完成事项；只更新用户明确取消或替换的部分，不因新交办清空旧记录。结束回合前，核对文件中的未决问题，并回看已宣布但未完成的动作（待举卡、待登记目标变更等）；有则完成，暂不能完成要说明具体原因和下一步，不能只因本批意见已处理就静默结束。`;
}

export function pendingDecisionsPrompt(workspace: string): string {
  return [
    "[保留工作结果与未决决策]",
    `确实需要用户拍板的业务或设计问题，先用文件工具写入 ${resolve(workspace, PENDING_DECISIONS_FILE)}，然后立即调用 AskUserQuestion；不要只宣布稍后举卡，也不要把处理新意见、登记目标变更或推送排在举卡之前。没有未决问题时无需创建文件；用户已明确授权的工作直接做，不增加确认。`,
    '文件格式示例：{"decisions":[{"id":"decision-1","question":"要决定什么","options":["方案一","方案二"],"recommended":"方案一","basis":"依据、影响及对应材料路径","status":"pending"}]}。读取后在原记录上更新，保持稳定 id，保留已形成的分析与历史结果，不用空文件或新批次覆盖旧条目。',
    "举卡后仍是待用户答复；只有收到用户的明确决定才能记为 resolved 并写入 answer，用户明确取消或替换才记为 canceled 并说明依据。已答复的问题不重复举卡，不能把新交办自动当作旧问题已解决。",
    pendingDecisionRecoveryPrompt(),
    "已有推理和验证能复用就复用；确需等待用户时，在现有进展说明中点明尚有几个问题待决定，并直接举卡或说明当前无法举卡的原因。不要重新跑整项任务，也不要把过程记录当成交付代码提交。",
  ].join("\n");
}
