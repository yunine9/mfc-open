/** 两条知识生产线共用的审阅规则；文稿格式、持久保存和执行体仍由各管理器负责。 */
export interface ReviewProposal<T = unknown> {
  turn_id: string;
  document_id: string;
  turn_status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
  status: "pending" | "accepted" | "discarded";
  base_revision: number;
  value: T;
}

/** 接续本轮候选或此前完成的同基线候选，不能使用失败、过期或未来回合的建议。 */
export function continuingReviewProposal<T>(proposals: readonly ReviewProposal<T>[], documentId: string, currentRevision: number,
  currentTurnId: string, turnIds: readonly string[]): ReviewProposal<T> | undefined {
  const sameBaseline = (proposal: ReviewProposal<T>) => proposal.document_id === documentId
    && proposal.status === "pending" && proposal.base_revision === currentRevision;
  const resumed = [...proposals].reverse().find(proposal => proposal.turn_id === currentTurnId && sameBaseline(proposal));
  if (resumed) return resumed;
  const currentIndex = turnIds.indexOf(currentTurnId);
  if (currentIndex < 0) return undefined;
  return [...proposals].reverse().find(proposal => {
    const index = turnIds.indexOf(proposal.turn_id);
    return index >= 0 && index < currentIndex && proposal.turn_status === "done" && sameBaseline(proposal);
  });
}

export function assertReviewRevision(current: number, expected: number, message = "文稿已有新版本，请比较后重新保存"): void {
  if (current !== expected) throw new Error(message);
}

/** 人工确认必须对应完成回合的最新建议和仍相同的正文基线。 */
export function assertLatestReviewProposal<T>(proposals: readonly ReviewProposal<T>[], turnId: string, documentId: string,
  currentRevision: number, working = false, revisionMessage = "文稿已有新版本，请比较差异后重新确认"): ReviewProposal<T> {
  const index = proposals.findIndex(proposal => proposal.turn_id === turnId && proposal.document_id === documentId);
  const proposal = proposals[index];
  if (!proposal) throw new Error("修订建议不存在，请刷新");
  if (proposal.status !== "pending") throw new Error("所选修改建议已处理，请刷新");
  if (proposal.turn_status !== "done") throw new Error("本轮修改尚未完成，请完成后再确认");
  if (working) throw new Error("当前研究仍在进行，请等待完成后再确认修改");
  if (proposals.slice(index + 1).some(later => later.document_id === documentId && later.status === "pending")) {
    throw new Error("已有更新的修改建议，请重新检视；如需使用此建议，请先放弃后续建议");
  }
  assertReviewRevision(currentRevision, proposal.base_revision, revisionMessage);
  return proposal;
}

export function assertNoPendingReviewProposals(proposals: readonly ReviewProposal[], selectedDocumentIds: readonly string[]): void {
  if (proposals.some(proposal => proposal.status === "pending" && selectedDocumentIds.includes(proposal.document_id))) {
    throw new Error("所选文档有尚未确认的修改，请先确认或放弃后发布");
  }
}
