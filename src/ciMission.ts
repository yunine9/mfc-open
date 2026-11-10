import type { TaskSummary } from "./taskService.ts";

export const CI_MISSION_END = "[本轮流水线修复目标结束]";
const LEGACY_END = '流水线"及原因,不许拿无关的汇报顶替诊断。';

/** 只撤出系统生成且已经发布修复版本的 CI 使命，保留后续追加的人话。
 * 不能因 loop.kind=ci 就清空整个 mission：中途可能已加入新的检视要求。 */
export function remainingCiMission(mission: string | undefined, summary: TaskSummary): string | undefined {
  const delivery = summary.delivery, loop = delivery?.loop;
  if (!mission?.startsWith("当前目标是处理本轮流水线失败(") || loop?.kind !== "ci"
      || !loop.last_sha || !delivery?.git_push?.sha || delivery.git_push.sha === loop.last_sha
      || !mission.includes(`分支上提交 ${loop.last_sha} 的权威流水线结果是 failed`)) return mission;
  const marker = mission.includes(CI_MISSION_END) ? CI_MISSION_END : LEGACY_END;
  const end = mission.indexOf(marker);
  return end < 0 ? mission : mission.slice(end + marker.length).trim();
}

export function shouldVerifyCiPush(mission: string | undefined, summary: TaskSummary): boolean {
  return !!mission && remainingCiMission(mission, summary) === ""
    && !summary.delivery?.loop?.workspace_review_pending;
}
