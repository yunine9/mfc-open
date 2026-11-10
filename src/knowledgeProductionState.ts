import type { DomainDocument, DomainKnowledgeJob, DomainPublication } from "./domainKnowledgeTypes.ts";
import type { ResearchRecord } from "./componentResearch.ts";
import type { ExtractionJobRecord } from "./knowledgeExtraction.ts";
import type { SkillSubmissionRecord } from "./hostSkillLibrary.ts";
import type { KnowledgeTaskGroup } from "./knowledgeTaskCenterTypes.ts";
import { needsModuleKnowledgeLayout } from "./domainKnowledgeLayout.ts";

import type { KnowledgeProductionAction, KnowledgeDocumentState, KnowledgePublicationState, KnowledgeProductionView } from "./knowledgeProductionTypes.ts";
export type { KnowledgeProductionAction, KnowledgeDocumentState, KnowledgePublicationState, KnowledgeProductionView } from "./knowledgeProductionTypes.ts";
type Input = { kind: "domain"; record: DomainKnowledgeJob; current_revisions?: Record<string, string> }
  | { kind: "component"; record: ResearchRecord; archive?: DomainKnowledgeJob; current_revisions?: Record<string, string> }
  | { kind: "skill-extraction"; record: ExtractionJobRecord }
  | { kind: "skill-submission"; record: SkillSubmissionRecord };

export function currentKnowledgeArchiveBatches(job: DomainKnowledgeJob, current_revisions?: Record<string, string>, currentDocuments = job.documents) {
  if (!job.component_research_id) {
    const documents = currentDocuments.filter(document => document.selected && (!document.deleted || document.base_content !== null));
    return (job.archive_batches ?? []).filter(batch => !!batch.issue_no && batch.state !== "superseded"
      && documents.length === batch.documents.length && documents.every(document => batch.documents.some(old => old.id === document.id
        && old.revision === document.revision && old.content === document.content && !!old.deleted === !!document.deleted
        && (old.archive_path ?? old.path) === (document.archive_path ?? document.path)))
      && batch.targets.every(target => [job.knowledge_target, ...job.repositories].some(current => current.id === target.id
        && current.repository === target.repository && current.branch === target.branch && current.docs_path === target.docs_path)));
  }

  const documents = currentDocuments.filter(document => !!document.knowledge_document_id && (!current_revisions || !!current_revisions[document.knowledge_document_id]));
  const targets = [job.knowledge_target, ...job.repositories].filter(target => documents.some(document => document.target_id === target.id));
  return (job.archive_batches ?? []).filter(batch => !!batch.issue_no && batch.state !== "superseded" && batch.documents.length > 0
    && batch.knowledge_layout === job.knowledge_layout
    && batch.documents.length === documents.length && documents.every(document => batch.documents.some(old => old.id === document.id
      && old.target_id === document.target_id && (old.archive_path ?? old.path) === (document.archive_path ?? document.path)
      && old.knowledge_document_id === document.knowledge_document_id && old.published_revision === (current_revisions
        ? current_revisions[document.knowledge_document_id!] : document.published_revision)))
    && targets.length === batch.targets.length && targets.every(target => batch.targets.some(old => old.id === target.id
      && old.repository === target.repository && old.branch === target.branch && old.docs_path === target.docs_path)));
}
function documentProposalState(job: DomainKnowledgeJob, document: DomainDocument) {
  const pending = [...job.turns].reverse().flatMap(turn => turn.proposals.map(proposal => ({ turn, proposal })))
    .find(({ proposal }) => proposal.document.id === document.id && proposal.status === "pending");
  const name = document.path || document.title;
  const proposal_problem = !pending ? undefined : pending.turn.status !== "done" ? `${name} 的修改尚未完成，完成后才能确认发布。`
    : pending.proposal.base_revision !== document.revision ? `${name} 的正文已变化，请重新修改或放弃这份修改结果后再发布。` : undefined;
  return { pending, proposal_problem };
}
function documentState(job: DomainKnowledgeJob, document: DomainDocument): KnowledgeDocumentState {
  const { pending, proposal_problem } = documentProposalState(job, document);
  const confirmedDeletion = document.deleted && !!document.knowledge_document_id && document.published_document_revision === document.revision;
  const needsLayout = needsModuleKnowledgeLayout(job) && !confirmedDeletion;
  const changed = !!pending || document.published_document_revision !== document.revision || needsLayout;
  return { id: document.id, changed, published_revision: document.published_document_revision, knowledge_document_id: document.knowledge_document_id,
    status_label: document.deleted ? changed ? "待删除" : "已删除" : needsLayout && !pending && document.published_document_revision === document.revision ? "待整理发布" : changed ? "待审查" : "已入库", proposal_problem };
}
function publicationState(job: DomainKnowledgeJob, publication: DomainPublication): KnowledgePublicationState {
  const target = [job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id)?.name ?? publication.target_id;
  const replacement = publication.url ? job.archive_batches?.flatMap(batch => batch.replacements ?? []).find(item =>
    ["closed", "merged"].includes(item.state) && item.publication.url === publication.url) : undefined;
  const status_label = replacement?.state === "closed" ? "旧 MR 已撤销" : replacement?.state === "merged" ? "已合入，保留原提交"
    : { pending: "归档中", opened: "已归档", failed: "归档失败" }[publication.state];
  return { key: `${publication.target_id}:${publication.branch}`, target, status_label, url: publication.url, error: publication.error,
    mr_participants: publication.mr_participants };
}

function projectDomainCandidates(job: DomainKnowledgeJob): KnowledgeProductionView {
  const link = (action: KnowledgeProductionAction): KnowledgeProductionAction => ({ ...action,
    href: action.href ?? `?kbPage=task&kbKind=domain&kbTask=${encodeURIComponent(job.id)}${action.view === "progress" ? "" : "&kbReview=1"}${action.view === "archive" ? "&kbStage=publish" : ""}` });
  const working = ["queued", "running"].includes(job.status), modifying = ["revise", "update"].includes(job.turns.at(-1)?.mode ?? "");
  const current = currentKnowledgeArchiveBatches(job);
  const anyMerged = job.publications.some(publication => publication.mr_state === "merged");
  const allCurrentMerged = current.some(batch => batch.targets.length > 0 && batch.targets.every(target => batch.publications.some(publication => {
    const archived = batch.targets.find(candidate => candidate.id === publication.target_id);
    return archived?.repository === target.repository && archived.branch === target.branch && publication.mr_state === "merged";
  })));
  const failed = !allCurrentMerged && current.some(batch => batch.state === "failed"), archiving = current.some(batch => batch.state === "running");
  const opened = current.some(batch => batch.state === "done" && batch.targets.every(target => batch.publications.some(publication => {
    const archived = batch.targets.find(candidate => candidate.id === publication.target_id);
    return archived?.repository === target.repository && archived.branch === target.branch && publication.state === "opened";
  })));
  const inspecting = job.task_kind === "inspection" && job.status === "idle" && !job.turns.length;
  const noChanges = job.task_kind === "inspection" && job.status === "done" && !job.turns.length
    && job.documents.every(document => document.content === document.base_content && !document.deleted && document.path === (document.base_path ?? document.path));
  // 旧知识清理(模块迁移,#489)在独立任务上仍会发生:候选投影补齐与主投影
  // 同款的清理分支,否则清理任务显示「待开始」,开始萃取/清理旧知识的
  // 入口与失败文案全部丢失(2026-10-31 清存量红实锤)。
  const cleanup = job.source_cleanup && !job.source_cleanup.started ? job.source_cleanup : undefined;
  const cleanupReady = !!cleanup && cleanup.plans.length === cleanup.repositories.length
    && cleanup.plans.every(plan => !(plan.selected_paths ?? plan.entries.map(entry => entry.path)).length
      || cleanup.publications.some(publication => publication.target_id === plan.target_id && publication.url));
  const cleanupFailed = !!cleanup?.publications.some(publication => publication.state === "failed");
  const status_label = working ? job.status === "queued" ? "排队中" : modifying ? "修改中" : "研究中"
    : archiving ? "正在创建 MR" : failed ? anyMerged ? "部分 MR 已合入，剩余 MR 创建失败" : "MR 创建失败" : allCurrentMerged ? "MR 已合入" : anyMerged ? "部分 MR 已合入" : job.status === "paused" ? "等待你确认"
    : job.status === "failed" ? "执行失败" : job.status === "cancelled" ? "已停止"
    : cleanup ? cleanupReady ? "待开始萃取" : cleanupFailed ? "清理 MR 创建失败" : "待清理旧知识"
    : inspecting ? "检视中" : noChanges ? "检视完成，无需修改" : opened ? "MR 待合入" : job.documents.length ? "文稿已就绪" : "待开始";
  const archiveAction = link({ id: "archive", label: failed ? "重试失败仓 MR" : opened || anyMerged ? "查看 MR" : "创建 MR", view: "archive" });
  const next = link(working || archiving || ["failed", "cancelled", "paused"].includes(job.status) ? { id: "progress", label: "查看进展", view: "progress" }
    : allCurrentMerged ? { id: "knowledge", label: "查看正式知识", view: "review", href: `?kbPage=module&kbModule=${encodeURIComponent(`business:${job.module_id ?? ""}`)}` }
    : inspecting ? { id: "review", label: "继续检视", view: "review" }
    : cleanup ? { id: "progress", label: cleanupReady ? "开始萃取" : "清理旧知识", view: "progress" }
    : archiveAction);
  const capabilities = job.turns.at(-1)?.research?.capabilities ?? [];
  const group = working || archiving ? "running" : failed || anyMerged && !allCurrentMerged ? "attention" : allCurrentMerged || opened || noChanges ? "completed" : "attention";
  const docs = job.documents.map(document => {
    const { pending, proposal_problem } = documentProposalState(job, document);
    // save 候选表示保留文稿；旧删除标记仍留在基线供确认与历史对照。
    const deleted = pending && !proposal_problem ? false : document.deleted;
    const target = [job.knowledge_target, ...job.repositories].find(target => target.id === document.target_id);
    const publication = job.publications.find(publication => {
      const archived = [job.knowledge_target, ...job.repositories].find(candidate => candidate.id === publication.target_id);
      return target && archived?.repository === target.repository && archived.branch === target.branch;
    });
    const submitted = publication?.state === "opened" && publication.documents.some(old => old.id === document.id && old.revision === document.revision
      && old.content === document.content && old.path === (document.archive_path ?? document.path) && !!old.deleted === !!document.deleted);
    return { id: document.id, changed: publication?.mr_state !== "merged" && (!!pending || !submitted), status_label: publication?.mr_state === "merged" ? "已合入"
      : submitted && !pending ? "MR 已提交" : publication?.state === "failed" ? "MR 创建失败" : deleted ? "待删除" : "任务文稿", knowledge_document_id: document.knowledge_document_id, proposal_problem };
  });
  const statePublication = (publication: DomainPublication): KnowledgePublicationState => ({ key: `${publication.target_id}:${publication.branch}`,
    target: [job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id)?.name ?? publication.target_id,
    status_label: publication.mr_state === "merged" ? "已合入" : publication.mr_state === "closed" ? "MR 已关闭" : publication.state === "opened" ? "MR 待合入" : publication.state === "failed" ? "MR 创建失败" : "正在创建 MR",
    url: publication.url, error: publication.error, mr_participants: publication.mr_participants });
  return JSON.parse(JSON.stringify({ status_label, group, next_action: next, working, modifying, documents: docs,
    research_actions: allCurrentMerged ? [next] : anyMerged ? [archiveAction] : working ? [link({ id: "stop", label: "停止本轮", view: "progress" })]
      : inspecting ? [link({ id: "review", label: "继续检视", view: "review" })]
      : ["failed", "cancelled"].includes(job.status) ? [link({ id: "resume", label: "接续原任务", view: "progress" })]
      : job.documents.length && !noChanges ? [link({ id: "review", label: "开始检视", view: "review" }), archiveAction] : [],
    knowledge_document_id: job.documents.find(document => document.knowledge_document_id)?.knowledge_document_id,
    platform_message: "任务文稿保留在当前任务中；MR 合入并同步后，正式知识库才会更新。",
    // 过程文稿(skill-runs work)与任务文稿同样可读:候选任务只有过程稿时
    // 也要给出阅读入口(2026-10-31 清存量红实锤:曾被 documents-only 判空抹掉)。
    navigation: { ready_message: inspecting ? "连续记录意见，结束检视后再统一修改。" : anyMerged ? allCurrentMerged ? "后续修改请从正式知识库开始新的检视。" : "已有 MR 合入；剩余失败仓可继续重试原批次，正文修改请从正式知识库开始新的检视。" : job.documents.length ? "可直接创建 MR，也可先检视文稿并继续修改。" : job.work_documents?.length ? "已生成的过程文稿已保留，可先阅读后继续研究。" : undefined,
      ready_action_label: job.documents.length || job.work_documents?.length ? "查看文稿" : undefined },
    review: { readonly: anyMerged, active_message: working ? "本轮正在执行，已有文稿与意见均保留。" : undefined, sections: [],
      turns: job.turns.map(turn => ({ id: turn.id, status_label: { queued: "等待处理", running: "正在处理", paused: "等待你的答复", done: "本轮已完成", failed: "本轮失败，文稿保留", cancelled: "本轮已停止，文稿保留" }[turn.status] })),
      capabilities: capabilities.map(capability => ({ id: capability.id, status_label: { pending: "待处理", researched: "已完成", blocked: "受阻" }[capability.state] })),
      progress_message: capabilities.length ? `研究步骤 · ${capabilities.filter(capability => capability.state === "researched").length} / ${capabilities.length} 步已完成` : undefined },
    archive: { visible: !!job.documents.length || !!job.archive_batches?.length, state: failed ? "failed" : archiving ? "running" : opened ? "opened" : "done",
      group: failed || anyMerged && !allCurrentMerged ? "attention" : archiving ? "running" : "completed", status_label: failed ? anyMerged ? "部分 MR 已合入，剩余 MR 创建失败" : "MR 创建失败" : allCurrentMerged ? "MR 已合入" : anyMerged ? "部分 MR 已合入" : opened ? "MR 待合入" : archiving ? "正在创建 MR" : "待创建 MR",
      title: `${job.documents.length} 份任务文稿`, message: allCurrentMerged ? "已确认全部目标 MR 合入；正式知识库以同步结果为准。" : anyMerged ? "已合入目标不会再次提交；剩余失败仓可以重试原批次。正文修改请从正式知识库开始新的检视。" : "创建 MR 后仍可在原任务修改，更新同一个 MR。",
      actions: allCurrentMerged || noChanges ? [] : [archiveAction], publications: job.publications.map(statePublication),
      batches: (job.archive_batches ?? []).filter(batch => !!batch.issue_no).map((batch, index) => ({ id: batch.id, title: `第 ${index + 1} 次提交 · ${batch.issue_no}`,
        actions: batch.state === "failed" ? [{ id: "retry-archive", label: "重试原批次", view: "archive" as const, batch_id: batch.id }] : [],
        status_label: batch.state === "failed" ? "MR 提交失败" : batch.state === "done" ? "MR 已提交" : "正在提交 MR", publications: batch.publications.map(statePublication), superseded: [] })) },
  })) as KnowledgeProductionView;
}

/** 唯一的生产状态投影。先看需要人处理的归档事实，再看研究结果；不从旧记录补猜入库版本。 */
export function projectKnowledgeProduction(input: Input): KnowledgeProductionView {
  if (input.kind === "domain" && !input.record.component_research_id) return projectDomainCandidates(input.record);
  const record = input.record;
  const job = input.kind === "domain" ? input.record : input.kind === "component" ? input.archive : undefined;
  const ownerKind = input.kind === "domain" && job?.component_research_id ? "component" : input.kind;
  const ownerId = input.kind === "domain" && job?.component_research_id ? job.component_research_id : input.kind === "skill-submission" ? `${input.record.directory}/${input.record.id}` : record.id;
  // 动作已指向别的对象（如制作 Skill 跳到它的提交）时保留原链接。
  const actionLink = (action: KnowledgeProductionAction): KnowledgeProductionAction => ({ ...action,
    href: action.href ?? `?kbPage=task&kbKind=${ownerKind}&kbTask=${encodeURIComponent(ownerId)}${action.view === "progress" ? "" : "&kbReview=1"}${action.view === "archive" ? "&kbStage=publish" : ""}` });
  const documents = input.kind === "domain" ? input.record.documents.map(document => documentState(input.record, document)) : [];
  const working = ["queued", "running"].includes(record.status);
  const modifying = input.kind === "domain" ? ["revise", "update"].includes(input.record.turns.at(-1)?.mode ?? "")
    : input.kind === "component" ? !!input.record.update_document_id || !!input.record.review_turns?.some(turn => ["queued", "running"].includes(turn.status) && turn.mode !== "discuss") : false;
  const formalId = input.kind === "component" ? input.record.document_id ?? input.record.update_document_id ?? job?.documents[0]?.knowledge_document_id
    : input.kind === "domain" ? input.record.documents[0]?.knowledge_document_id : undefined;
  const published = input.kind === "domain" ? input.record.documents.filter(document => !!document.knowledge_document_id && (!input.current_revisions || !!input.current_revisions[document.knowledge_document_id])).length
    : input.kind === "component" ? Number(!!formalId && (!input.current_revisions || !!input.current_revisions[formalId])) : 0;
  const confirmedDeletions = input.kind === "domain" ? input.record.documents.filter(document => document.deleted
    && document.published_document_revision === document.revision && !!document.knowledge_document_id
    && (!input.current_revisions || !!input.current_revisions[document.knowledge_document_id])).length : 0;
  const onlyDeletions = confirmedDeletions > 0 && confirmedDeletions === published;
  const currentBatches = job ? currentKnowledgeArchiveBatches(job, input.kind === "domain" || input.kind === "component" ? input.current_revisions : undefined) : [];
  const current = currentBatches.flatMap(batch => batch.publications);
  const archiveFailed = currentBatches.some(batch => batch.state === "failed") || current.some(publication => publication.state === "failed");
  const archiveRunning = currentBatches.some(batch => batch.state === "running");
  const archiveOpened = currentBatches.some(batch => batch.state === "done" && batch.targets.every(target => batch.publications.some(publication => {
    const archived = batch.targets.find(candidate => candidate.id === publication.target_id);
    return archived?.repository === target.repository && archived.branch === target.branch && publication.state === "opened";
  })));
  const archiveState = archiveRunning ? "running" : archiveFailed ? "failed" : archiveOpened ? "opened" : "done";
  const archiveLabel = archiveRunning ? "归档中" : archiveFailed ? "归档失败" : archiveOpened ? "已归档" : "已发布（未归档）";
  const hasArchiveHistory = !!job?.archive_batches?.some(batch => !!batch.issue_no);
  const archiveActions: KnowledgeProductionAction[] = published || hasArchiveHistory ? [actionLink({ id: "archive", label: !published ? "归档记录" : input.kind === "domain" && !job?.component_research_id && archiveState === "done" ? "创建归档 MR" : "归档", view: "archive" })] : [];
  let status_label: string, group: KnowledgeTaskGroup, next_action: KnowledgeProductionAction;
  if (archiveFailed) {
    status_label = "归档失败"; group = "attention"; next_action = archiveActions[0] ?? { id: "review", label: "审查成果", view: "review" };
  } else if (archiveRunning) {
    status_label = "归档中"; group = "running"; next_action = archiveActions[0] ?? { id: "progress", label: "查看进展", view: "progress" };
  } else if (input.kind === "domain" && record.status === "paused") {
    status_label = "等待你确认"; group = "attention"; next_action = { id: "respond", label: "查看待确认内容", view: "progress" };
  } else if (input.kind === "domain" && input.record.source_cleanup && !input.record.source_cleanup.started) {
    const cleanup = input.record.source_cleanup;
    const ready = cleanup.plans.length === cleanup.repositories.length && cleanup.plans.every(plan => !(plan.selected_paths ?? plan.entries.map(entry => entry.path)).length
      || cleanup.publications.some(publication => publication.target_id === plan.target_id && publication.url));
    status_label = ready ? "待开始萃取" : cleanup.publications.some(publication => publication.state === "failed") ? "清理 MR 创建失败" : "待清理旧知识";
    group = "attention"; next_action = { id: "progress", label: ready ? "开始萃取" : "清理旧知识", view: "progress" };
  } else if (record.status === "failed" || record.status === "cancelled" || record.status === "idle") {
    status_label = record.status === "failed" ? "执行失败" : record.status === "cancelled" ? "已停止" : "待开始";
    group = "attention"; next_action = input.kind === "skill-extraction" ? { id: "progress", label: "查看失败原因", view: "progress" } : { id: "resume", label: "继续研究", view: "progress" };
  } else if (working) {
    status_label = record.status === "queued" ? "排队中" : modifying ? "修改中" : "研究中"; group = "running";
    next_action = { id: "progress", label: "查看进展", view: "progress" };
  } else if (input.kind === "skill-extraction" && input.record.submission_id) {
    // 草稿已提交审查：制作任务结束，审查只在提交那一条上做（D9 只审一次）。
    status_label = "已提交审查"; group = "completed";
    const [directory, submission] = input.record.submission_id.split("/");
    next_action = { id: "submission", label: "查看提交", view: "review",
      href: `?kbPage=task&kbKind=skill-submission&kbTask=${encodeURIComponent(`${directory}/${submission}`)}&kbReview=1` };
  } else if (input.kind === "skill-submission") {
    const status = input.record.status;
    status_label = status === "pending" ? "待审查" : status === "approving" ? "审核通过中" : status === "approved" ? "已上架" : "已退回";
    group = status === "pending" || status === "approving" || status === "rejected" ? "attention" : "completed";
    next_action = status === "rejected" ? { id: "resubmit", label: "修改后重新提交", view: "review" }
      : { id: status === "approved" ? "knowledge" : "review", label: status === "approved" ? "查看知识" : "审查成果", view: "review" };
  } else {
    const draft = input.kind === "domain" ? documents.some(document => document.changed)
      : input.kind === "component" ? !!input.record.update_document_id || !published && (!!input.record.document || !!input.record.draft) : input.record.status === "done";
    // 制作 Skill 的草稿由发起人编辑后提交，真正的审查在提交那一条上，这里不叫"待审查"。
    const makingSkill = input.kind === "skill-extraction";
    status_label = draft ? makingSkill ? "待提交" : "待审查" : published ? archiveLabel : "已完成";
    group = draft ? "attention" : "completed";
    next_action = draft ? { id: "review", label: makingSkill ? "编辑并提交" : "审查成果", view: "review" } : { id: "knowledge", label: "查看知识", view: "review" };
    if (!draft && input.kind === "domain" && !job?.component_research_id && published && archiveState === "done") next_action = archiveActions[0];
  }
  const documentCount = input.kind === "domain" ? input.record.documents.length + (input.record.work_documents?.length ?? 0) : input.kind === "component" ? input.record.document?.sections.length ?? Number(!!input.record.draft) : 0;
  const workDocumentCount = input.kind === "component" ? input.record.work_documents?.length ?? 0 : 0;
  const readableCount = documentCount + workDocumentCount;
  const readonly = input.kind === "component" ? !!input.record.document_id : input.kind === "skill-submission" ? input.record.status !== "pending" : false;
  const sections = input.kind === "component" ? input.record.document?.sections ?? [] : [];
  const componentTurns = input.kind === "component" ? input.record.review_turns ?? [] : [];
  const capabilities = input.kind === "domain" ? input.record.turns.at(-1)?.research?.capabilities ?? [] : [];
  const turnLabels = { queued: "等待处理…", running: "正在查阅资料并处理…", paused: "等待你的答复，文稿与进度已保留", cancelled: "本轮已停止，原稿保留", failed: "本轮失败，原稿保留", done: "本轮已完成" };
  const research_actions: KnowledgeProductionAction[] = [];
  if (input.kind === "domain" || input.kind === "component") {
    if (working) research_actions.push({ id: "stop", label: "停止本轮", view: "progress" });
    else if (record.status === "paused") { /* 待确认卡片承接答复，不能用普通接续按钮替人确认。 */ }
    else if (["failed", "cancelled", "idle"].includes(record.status) && !(input.kind === "domain" && input.record.source_cleanup && !input.record.source_cleanup.started)) research_actions.push({ id: "resume", label: "继续研究", view: "progress" });
    else if (documentCount) research_actions.push(published && !documents.some(document => document.changed) && !(input.kind === "component" && input.record.update_document_id)
      ? { id: "update", label: "更新知识", view: "review" } : { id: "publish", label: "确认并发布", view: "review" });
  }
  if (input.kind === "skill-submission" && input.record.status === "pending") research_actions.push(
    { id: "reject", label: "需要调整", view: "review" }, { id: "publish", label: "发布 Skill", view: "review" });
  if (input.kind === "skill-submission" && input.record.status === "rejected") research_actions.push({ id: "resubmit", label: "修改后重新提交", view: "review" });
  if (input.kind === "skill-extraction" && input.record.status === "done" && input.record.draft && !input.record.submission_id) research_actions.push({ id: "review", label: "编辑并提交", view: "review" });
  const archiveInstruction = input.kind === "domain" && !job?.component_research_id
    ? "要交付到代码仓时，点「创建归档 MR」，平台使用任务已有单号直接归档。"
    : "要交付到代码仓时，点「归档」填写单号创建 MR。";
  let ready_message: string | undefined;
  if (readableCount) {
    if (!documentCount && workDocumentCount) ready_message = working ? "已有过程文稿可以先阅读，组件用法仍在生成。" : "已生成的过程文稿已保留，可先阅读后继续研究。";
    else if (working) ready_message = "已有文稿可以先审阅，后续内容仍在生成。";
    else if (record.status === "paused") ready_message = "请先审阅当前文稿，再确认或提出调整意见。";
    else if (next_action.view === "archive") ready_message = `${status_label}；请打开归档查看记录。`;
    else ready_message = group === "attention" ? input.kind === "domain" && input.record.documents.some(document => document.deleted && documents.find(item => item.id === document.id)?.changed)
      ? `请审查文稿：勾选要确认的变化，点「确认并发布」后发布正文或从正式知识库删除已标记的文稿。${archiveInstruction}`
      : `请审查文稿：勾选要发布的文稿，点「确认并发布」后平台上立即可读。${archiveInstruction}`
      : onlyDeletions ? `文档删除已确认。${archiveInstruction}` : confirmedDeletions ? `文稿变更已确认，可继续审阅。${archiveInstruction}` : `知识已入库，可继续阅读文稿。${archiveInstruction}`;
  }
  const view: KnowledgeProductionView = { status_label, group, next_action, working, modifying, documents,
    research_actions,
    review: { readonly,
      selection_message: sections.length ? `${sections.length} 项能力 · ${readonly ? "已入库" : "已选"} ${sections.filter(section => section.selected).length} 项 · 合成 1 篇知识` : undefined,
      active_message: working ? "本轮正在执行，可先填写下一条意见；完成或停止后继续发送。" : undefined,
      sections: sections.map(section => {
        const pending = [...componentTurns].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending");
        const proposal_problem = !pending ? undefined : pending.status !== "done" ? "本轮修改尚未完成" : pending.proposal?.base_revision !== section.revision ? "修改与当前文稿冲突，请查看差异" : undefined;
        return { id: section.id, status_label: !section.revision ? "正在萃取" : `${readonly ? section.selected ? "已入库" : "未入库 · 原稿保留" : section.selected ? "已选择" : "未选择"} · 修订 ${section.revision}`,
          proposal_problem, proposal_message: pending && !proposal_problem && !readonly ? "修改后文稿 · 确认并发布后生效" : undefined };
      }),
      turns: (input.kind === "domain" ? input.record.turns : componentTurns).map(turn => ({ id: turn.id, status_label: turnLabels[turn.status],
        proposal_status_label: "proposal" in turn && turn.proposal ? { pending: "修改待确认", accepted: "修改已确认", discarded: "修改已放弃" }[turn.proposal.status] : undefined })),
      capabilities: capabilities.map(capability => ({ id: capability.id, status_label: { pending: "待处理", researched: "已完成", blocked: "受阻" }[capability.state] })),
      progress_message: capabilities.length ? `研究步骤 · ${capabilities.filter(capability => capability.state === "researched").length} / ${capabilities.length} 步已完成` : undefined },
    knowledge_document_id: formalId,
    platform_message: [input.kind === "domain" && needsModuleKnowledgeLayout(input.record) && documents.some(document => document.changed)
      ? "确认并发布时，平台自动整理模块目录和相对链接，只发布本次勾选的文稿，不重新萃取。" : "",
      published && (working || documents.some(document => document.changed) || input.kind === "component" && !!input.record.update_document_id)
        ? "修改期间继续使用已入库知识，确认发布后再更新。" : ""].filter(Boolean).join("\n") || undefined,
    // 进行中的状态只在标题行的状态标签里说一次；页签并进标题行后，旁边再挂一个"研究中"就重复了。
    navigation: { ready_message,
      ready_action_label: readableCount ? !working && next_action.view === "review" && next_action.id === "review" ? "审查成果" : "查看文稿" : undefined },
    archive: { visible: !!published || hasArchiveHistory, state: archiveState, group: archiveFailed ? "attention" : archiveRunning ? "running" : "completed",
      status_label: archiveLabel, title: onlyDeletions ? "文档删除已确认，可手工归档" : confirmedDeletions ? `${published} 份文稿变更已确认，可手工归档` : published ? `${published} 份知识已发布，平台立即可读` : "Git 归档记录",
      message: currentBatches.find(batch => batch.state === "failed")?.error || current.find(publication => publication.state === "failed")?.error
        || (archiveRunning ? "正在创建归档 MR" : archiveOpened ? "MR 已创建，后续合入由人处理。" : `${onlyDeletions ? "文档删除已确认" : confirmedDeletions ? "文稿变更已确认" : "平台知识已发布"}。${archiveInstruction}`),
      actions: archiveActions, publications: job ? [...job.publications, ...job.publication_history ?? []].map(publication => publicationState(job, publication)) : [],
      batches: (job?.archive_batches ?? []).filter(batch => !!batch.issue_no).map((batch, index) => ({ id: batch.id, title: `第 ${index + 1} 批 · ${batch.issue_no} · ${batch.documents.length} 份`,
        status_label: { pending: "归档中", running: "归档中", done: "已归档", failed: "归档失败", superseded: "已被新归档替换" }[batch.state],
        actions: batch.state === "failed" ? [{ id: "retry-archive", label: "重试原批次", view: "archive" as const, batch_id: batch.id }] : [],
        publications: job ? batch.publications.map(publication => publicationState(job, publication)) : [],
        replacements: batch.replacements?.map(replacement => ({ key: `${replacement.target.id}:${replacement.publication.branch}`,
          target: replacement.target.name, url: replacement.publication.url, error: replacement.error,
          status_label: { pending: "新 MR 创建后撤销旧 MR", closed: "旧 MR 已撤销", merged: "旧 MR 已合入，保留原提交，无需撤销", failed: "旧 MR 撤销失败，可重试" }[replacement.state] })), superseded: [] })),
    } };
  if (input.kind === "component" && input.archive?.production) {
    view.archive = { ...input.archive.production.archive, actions: archiveActions };
    if (!working && view.archive.visible && !input.record.update_document_id && !["failed", "cancelled", "idle"].includes(record.status)) {
      view.status_label = view.archive.status_label; view.group = view.archive.group;
      if (view.archive.state === "failed" || view.archive.state === "running") view.next_action = archiveActions[0];
    }
  }
  // HTTP 与管理器读取必须返回相同的只读契约，缺少的可选字段不伪造为显式 undefined。
  view.next_action = actionLink(view.next_action);
  return JSON.parse(JSON.stringify(view)) as KnowledgeProductionView;
}
