import { CloudSession, type CloudSessionOptions } from "./sessionDriver.ts";
import { auxiliarySessionEpoch, trackAuxiliarySession, untrackAuxiliarySession } from "./auxiliarySessions.ts";
import { GateService } from "./gateService.ts";
import { createPrePushGateContract } from "./prepushAgent.ts";
import type { CodecheckRequest } from "./codecheckPrepush.ts";
import { dirname } from "node:path";

/** 辅助会话随原任务取消；没有固定总时限、交付工具或失败后自动开新轮。 */
export async function runCodecheckSkillSession(
  owner: object,
  request: CodecheckRequest,
  options: Omit<CloudSessionOptions, "gate">,
): Promise<string> {
  const epoch = auxiliarySessionEpoch(owner);
  const driver = await CloudSession.create({ ...options,
    resumeSession: false, sessionId: "codecheck", allowHumanQuestions: false,
    allowSubagents: false, extraTools: [], repositorySkillPaths: [request.skillPath],
    hostSkillsDir: undefined, hostHooks: undefined,
    gate: new GateService({ workspace: options.workspace, cwd: options.workspace,
      contract: createPrePushGateContract(),
      extraLedgerFiles: ["issue.json", "issue.json.tmp"],
      extraLedgerDirs: ["codecheck", "skills", dirname(request.skillPath)],
      failClosed: true, log: options.log }),
    currentStep: () => "推送前 CodeCheck 自查",
    compactAnchor: () => `仅完成本次 CodeCheck 自查，仓库 ${request.repo}，基点 ${request.base}；禁止 push 和重启流程。`,
  });
  trackAuxiliarySession(owner, driver, epoch);
  try {
    const outcome = await driver.start(request.prompt);
    if (auxiliarySessionEpoch(owner) !== epoch || outcome.status !== "turn_finished") {
      throw new Error(outcome.detail ?? outcome.reason ?? "CodeCheck 会话已停止");
    }
    return driver.finalReply();
  } finally {
    untrackAuxiliarySession(owner, driver);
    driver.dispose();
  }
}
