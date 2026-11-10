import type { DomainDocument, DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

export function domainDocumentHasChanges(job: DomainKnowledgeJob, document: DomainDocument): boolean {
  return job.production?.documents.find(item => item.id === document.id)?.changed === true;
}

export function latestDomainProposal(job: DomainKnowledgeJob, documentId: string) {
  for (const turn of [...(job.turns ?? [])].reverse()) {
    const proposal = turn.proposals.find(item => item.document.id === documentId && item.status === "pending");
    if (proposal) return { turn, proposal };
  }
}

export function domainProposalProblem(job: DomainKnowledgeJob, document: DomainDocument): string | undefined {
  return job.production?.documents.find(item => item.id === document.id)?.proposal_problem;
}

/** 未完成或已冲突的修改不替换正文预览。 */
export function domainReviewDocument(job: DomainKnowledgeJob, document: DomainDocument): DomainDocument {
  const pending = latestDomainProposal(job, document.id);
  return pending && !domainProposalProblem(job, document) ? { ...document, ...pending.proposal.document, deleted: false } : document;
}

/** 文件导航、检索和正文使用同一份可检视候选，发布基线仍保留在 job.documents。 */
export function domainReviewDocuments(job: DomainKnowledgeJob): DomainDocument[] {
  return job.documents.map(document => domainReviewDocument(job, document));
}

export function domainPublicationInput(job: DomainKnowledgeJob) {
  const selected = job.documents.filter(document => document.selected && domainDocumentHasChanges(job, document));
  return { document_ids: selected.map(document => document.id), expected_revisions: Object.fromEntries(selected.map(document => [document.id, document.revision])) };
}

/** 先检查整批文稿，再确认修改；正式发布只使用各次响应中的最新版本。 */
export async function confirmDomainPublication(job: DomainKnowledgeJob, request: (action: "proposal" | "publish", input: unknown) => Promise<DomainKnowledgeJob>): Promise<DomainKnowledgeJob> {
  if (["queued", "running"].includes(job.status)) throw new Error("本轮正在执行，完成后才能确认发布。");
  const input = domainPublicationInput(job);
  if (!input.document_ids.length) throw new Error("请先选择要发布的文稿。");
  const documents = job.documents.filter(document => input.document_ids.includes(document.id));
  for (const document of documents) {
    const problem = domainProposalProblem(job, document);
    if (problem) throw new Error(problem);
  }
  let next = job;
  const expectedRevisions = { ...input.expected_revisions };
  for (const document of documents) {
    const pending = latestDomainProposal(job, document.id);
    if (!pending) continue;
    const current = next.documents.find(item => item.id === document.id);
    const currentPending = latestDomainProposal(next, document.id);
    if (!current || current.revision !== document.revision || currentPending?.turn.id !== pending.turn.id) throw new Error("文稿已有新修改，请重新检视后发布。");
    const problem = domainProposalProblem(next, current);
    if (problem) throw new Error(problem);
    next = await request("proposal", { turn_id: pending.turn.id, document_id: document.id, decision: "accept" });
    const confirmed = next.documents.find(item => item.id === document.id);
    if (!confirmed) throw new Error("文稿已变化，请刷新后重新检视。");
    expectedRevisions[document.id] = confirmed.revision;
  }
  for (const document of documents) {
    if (next.documents.find(item => item.id === document.id)?.revision !== expectedRevisions[document.id] || latestDomainProposal(next, document.id)) throw new Error("文稿已有新修改，请重新检视后发布。");
  }
  return request("publish", { document_ids: input.document_ids, expected_revisions: expectedRevisions });
}
