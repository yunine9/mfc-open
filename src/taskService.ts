import { parseRequirementProjectionSources, validateRequirementProjection, RequirementGraphContractError,
  REQUIREMENT_ASSESSMENT_EXAMPLE, REQUIREMENT_UNIT_EXAMPLE,
  type RequirementProjectionRepository, type RequirementRepositoryAssessment, type RequirementDependency,
} from "./requirementProjection.ts";
export type { RequirementRepositoryAssessment, RequirementDependency } from "./requirementProjection.ts";
import { runCodecheckPrepush, type CodecheckRunner } from "./codecheckPrepush.ts";
import { isReviewTaskEnded } from "./reviewParticipation.ts";
import { runCodecheckSkillSession } from "./codecheckSkillSession.ts";
import { createContainerBashOperations } from "./issueFlow/containerBash.ts";
import { assertNoCodecheckCommits, CodecheckArtifactCommitError } from "./codecheckArtifacts.ts";
import { storeTaskAttachment, taskAttachment, taskAttachmentContext, materializeTaskAttachments } from "./taskAttachments.ts";
import type { IncomingMessage } from "node:http";
import { resolveBusinessModuleId, resolveBusinessModuleRef } from "./businessModuleIdentity.ts";
import { resolveModuleKnowledgeLocation } from "./businessModuleKnowledge.ts";
import { KnowledgeTaskCapacity } from "./knowledgeTaskCapacity.ts";
import { createDomainKnowledgeExtraction, createComponentKnowledgeExtraction, syncKnowledgeSource, type DomainKnowledgeExtraction, type ComponentResearch } from "./knowledgeExtractionFactory.ts";
import { KnowledgeAnswers, KnowledgeAnswerError } from "./knowledgeAnswers.ts";
import { syncModuleKnowledge, readModuleKnowledgeSync } from "./knowledgeRepositorySync.ts";
import { readModuleKnowledgeContentRevision } from "./knowledgeRepositorySnapshots.ts";
import { createKnowledgeAnswerRunner } from "./knowledgeAnswerRunner.ts";
import { COMMIT_CONTENT_GUIDANCE } from "./ownerDecisionContext.ts";
import { deliveryFileList, pendingPushFiles, type PushFileList } from "./deliveryFileList.ts";
import { humanFeedbackReason, resolvedWorkspaceFeedback, resumeRecordedFeedback } from "./feedbackCompletion.ts";
import { gitNullPaths, recoverQuotedGitPaths } from "./gitPaths.ts";
import { correctKernelTicket } from "./kernelDelivery.ts";
import { closeMergeRequest } from "./mrClient.ts";
import { ticketCorrectionBlocks, prepareTicketRewrite, applyTicketRewrite, correctionJournal, validateCorrectionTicket, writeCorrectionJson, mapCorrectionReferences, migrateTicketArtifacts, type TicketCorrection, type TicketRewrite } from "./ticketCorrection.ts";
import { annotationSubmissionView, type AnnotationSubmissionView } from "./annotationSubmissionView.ts";
import { assertRepositoryCloneAddress } from "./repositoryAddress.ts";
import { applyGitCommitIdentity, gitCommitIdentityConfigs } from "./gitCommitIdentity.ts";
import { DeliveryExperiences } from "./deliveryExperience.ts";
import { DeliverySummaries, deliveryReportView, type DeliveryReportView } from "./deliverySummary.ts";
import { DeliveryImprovements, initializeImprovementPolicy, readImprovementPolicy, updateImprovementPolicy } from "./deliveryImprovement.ts";
import { memoryFeedbackEvidence } from "./memoryFeedback.ts";
import { progressAdvanced, taskProgressTimestamp } from "./taskProgressTime.ts";
import type { ComponentRepository } from "./componentRepositories.ts";
import { importExternalReviews, importStoredExternalReviews, notifyExternalReviews } from "./externalReviewInbox.ts";
import { awaitTaskDeliveryAnalytics, buildDeliveryAnalysis, observeDeliveryCode, recordDeliveryPublication } from "./deliveryAnalytics.ts";
import { concurrentWorkPrompt } from "./concurrentWorkPrompt.ts";
import { resolveProductBranch } from "./configurationCenter.ts";
import { createMemoryContext } from "./memoryContext.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { applyEarlyStart, previewEarlyStart, refreshDependencyQueue, concurrentTicketConflict, scheduledGraphDependencies, runnableQueueIndex, dependencyScheduleContext, type DependencyAdjustment, type EarlyStartInput } from "./dependencyScheduling.ts";
import { resumePrePushVerification } from "./prepushRecovery.ts";
import { fetchMrDiscussions, observeMrDiscussions, discussionRevision, discussionKey, type DiscussionItem, type DiscussionFetch } from "./mrDiscussions.ts";
import { postMrDiscussionReply } from "./mrDiscussionReply.ts";
import { reconcileRemoteDelivery, remoteDeliveryAllowsProceed, observePublishedBranch, mergedIncludesLocalHead, needsRemoteRecovery, type RemoteReconcileHost } from "./remoteDeliveryReconcile.ts";
import { requirementDecisionContract, confirmsRequirementGraph, REQUIREMENT_GRAPH_APPROVE, isMainTaskDelivery } from "./requirementDecisionContract.ts";
import { recoverTaskCwd } from "./taskWorkspaceRecovery.ts";
import { retireKernelReviewRequest } from "./kernelReviewRequest.ts";
import { CI_MISSION_END, shouldVerifyCiPush } from "./ciMission.ts";
import { scopePipelineArtifacts } from "./pipelineArtifactScope.ts";
import { annotationReviewAnswer, submitAnnotationReviewDecision, explicitlyRequestsReviewFeedback, isReviewAdjustmentAnswer, reviewDecisionContract, pendingReviewAnnotation } from "./reviewDecisionContract.ts";
import { recordMemoryUsage, readMemoryUsage, type MemoryUsageEvent } from "./memoryUsage.ts";
import { resumedWarmupBaselineMatches } from "./baselineWarmup.ts";
import { historicalPipelineFeedback, observedPipelineRun, projectPipelineRun, enterRepairVerification, projectPushReceipt, confirmedPipelineRun, validPushReceipt } from "./pipelineHandoff.ts";
import { watchTaskPipeline } from "./taskPipelineWatch.ts";
import { getPipelineStatus, triggerPipeline, type PipelineRun } from "./pipelineClient.ts";
import { readResourceBlocks } from "./repositoryResourcePolicy.ts";
import { orderedRecord, decisionRequestDigest } from "./decisionRequestDigest.ts";
import { confirmHostPush, PUSH_SCOPE_GUIDANCE, HOST_PUSH_CHOICE_EFFECTS, HOST_PUSH_CONFIRM_STEP } from "./taskPushConfirmation.ts";
import { readAnalysisArchitecture, STORY_ARCHITECTURE_GUIDANCE } from "./storyArchitecture.ts";
import { readAnalysisSemanticArchitecture, SEMANTIC_ARCHITECTURE_GUIDANCE } from "./semanticArchitecture.ts";
import { feedbackReceiptInstructions } from "./feedbackReceiptInstructions.ts";
import type { AnnotationResolution } from "./annotations.ts";
import { readRequirementPlan, currentRequirementPlan } from "./requirementPlan.ts";
import { requirementDiff } from "./documentDiff.ts";
import { withLiveReviewReceipts } from "./liveReviewReceipts.ts";
import { recordTaskCreationAudit } from "./taskCreationAudit.ts";
import { parseDocumentReviewReceipts } from "./documentReviewReceipts.ts";
import { OverallStoryCoordinator } from "./overallStory.ts";
import { OVERALL_STORY_ARTIFACT, currentStoryFile, readStoryState } from "./overallStoryStore.ts";
import { runOverallStorySession } from "./overallStoryAgent.ts";
import { auxiliarySessionEpoch, hasAuxiliarySessions, trackAuxiliarySession, untrackAuxiliarySession, abortAuxiliarySessions, interruptWarmupReceipt } from "./auxiliarySessions.ts";
/**
 * 任务编排(主 spec §5.2 的任务 API + 流程编排两个模块的骨架)。
 *
 * 一个任务 = 一个工作区 + 一个进程内 pi 会话 + 三份现场文件
 * (events.jsonl / transcript.jsonl / waiting.json)。状态由 outcome
 * 驱动,不由 Web 推断(主 spec §5.1:Web 只承担交互与展示)。
 *
 * 并发受限:超出 maxConcurrent 的任务排队(§4 受限并发任务队列)。
 * 决定消费走 HumanGate 的先到生效语义,冲突原样抛给 API 层变 409。
 */

import { taskAgentMaterialInstructions, prepareReviewReplyFile, repairTaskAgentFileOwnership } from "./taskAgentFiles.ts";
import { createRequirementAnalysisGateContract } from "./requirementAnalysisGate.ts";
export { createRequirementAnalysisGateContract } from "./requirementAnalysisGate.ts";
import { prepareMaeBuildSupport, isMaeRepository, maeBuildRoot, maeBuildVolumes, MAE_BUILD_ASSETS, MAE_BUILD_MOUNT } from "./maeBuildSupport.ts";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync, fsyncSync, closeSync,} from "node:fs";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { hostSkillNames } from "./hostSkillRuntime.ts";
import { launchRepositoryOptions } from "./launchRepositoryOptions.ts";
import { annotationSubmissionReceipt, resumeQueuedAnnotationSubmission, assertAnnotationOwnerAccess, annotationSubmissionPlan, pickAnnotationSubmission, requirementSubmissionReceipt, submitAnnotationWithReceipts } from "./annotationSubmission.ts";
import { resetQueuedRequirementReviews, submitRequirementReview, interruptRequirementReviews } from "./requirementReviewQueue.ts";
import {
  AnnotationPermissionError,
  AnnotationStore,
  REQUIREMENT_GRAPH_ARTIFACT,
  TASK_REQUIREMENT_ARTIFACT,
  reanchor,
  renderAnnotations,
  type Annotation,
  type AnnotationOperation,
  type AnchorCheck,
  type AnnotationInput,
  type SentVia,
} from "./annotations.ts";
import {
  MemoryError,
  MemoryStore,
  memoryAccessible,
  repoSlug,
  type MemoryInput,
  type MemoryRecord,
  type MemoryInsights,
  type MemoryRepoInsight,
  type MemoryStats,
  EMPTY_STATS,
  memoryWeight,
} from "./taskMemory.ts";
import { MemorySidecar, DEFAULT_MEMORY_BUDGETS, type MemorySearchHit } from "./memorySidecar.ts";
import { createMemoryTools, memoryContextQuery, resolveMemoryHits } from "./memoryTools.ts";
import { KnowledgeSearch, resolveKnowledgeModules, type KnowledgeContext } from "./knowledgeSearch.ts";
import { createKnowledgeTool } from "./knowledgeTools.ts";
import { ComponentKnowledgeConsumption } from "./componentKnowledgeConsumption.ts";
import { ComponentPlan } from "./componentPlan.ts";
import type { TaskDeliverySummary } from "./taskDeliverySummary.ts";
import { DELIVERY_SPLIT_GUIDANCE } from "./deliverySplitGuidance.ts";
import { createSplitProposalTool, type SplitProposalInput } from "./splitProposalTool.ts";
import { projectKernelFeedback } from "./feedbackProjection.ts";
import { readTaskHostDocument } from "./taskHostDocuments.ts";
import { collectAgentDiagnostics } from "./taskHostDiagnostics.ts";
import { TaskHostLedger, hostResumeMission, createTaskHostTools, finishTaskHostOperation, recordTaskHostInstruction, refreshOwnerInputProjection, taskDeferredFeedback, deferredAnnotationIds, deferredPipeline, taskHostGoal, relatedHostTask, settleVerificationStop, recoverHostPushProjection, type TaskHostRuntime } from "./taskHostTools.ts";
import { prepareHostPush } from "./hostPushPreparation.ts";
import { deliveryCommitTree } from "./deliveryCommitTree.ts";
import { canHandoffReview, handoffReview } from "./reviewHandoff.ts";
import { prepareMainTaskDelivery, mainTaskDeliveryContext } from "./requirementSingleDelivery.ts";
import { materializeAnalysisDecisions } from "./analysisDecisionContext.ts";
import {
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  sep as pathSep,
} from "node:path";
import {
  annotationClosures,
  answeredClarificationReceipt,
  blockingAnnotations,
  agentReviewAnnotations,
  clarificationRoundsLeft,
  describeReviewProcessingGap,
  MAX_CLARIFICATION_ROUNDS,
  pendingReviewProcessing,
  reviewProcessingKey,
  workspaceReviewReady,
  type AnnotationClosure,
  type AnnotationClosureFacts,
  parseWorkspaceReviewReceipts,
  unansweredAnnotations,
  workspaceReviewReceiptInstructions,
  type WorkspaceReviewReceipt,
} from "./feedbackPolicy.ts";
import {
  type PushReviewPolicy, describeDirtyPaths, listedPaths,
  normalizedDeliveryPaths, pushReviewCallId, pushReviewPolicyFor, hasPushApproval, latestPushDecision,
  pushWaitingDetail, samePaths,
} from "./pushReviewPolicy.ts";
import {
  DeliveryOutbox,
  parseReviewReplies,
  type DeliveryOutboxItem,
} from "./deliveryOutbox.ts";
import {
  compareDeliveryRevisions,
  deliveryChangeSnapshot,
  frozenTaskBaseline,
  DIFF_NAME,
  PIPELINE_EVIDENCE_GAP_FILE,
  readArtifact,
  readArtifactAsync,
  resolveArtifactRoot,
  type DeliveryRevisionComparison,
} from "./artifacts.ts";
import { KernelHost } from "./kernelHost.ts";
import {
  collectTaskDiagnostics,
  writeTaskDiagnostics,
  type DiagnosticsInput,
} from "./taskDiagnostics.ts";
import {
  matchesStepChoice,
  stepChoiceEffects,
  stepReviewSurface,
  workflowChoices,
  workflowLabel,
  type StepChoiceEffect,
  kernelSpecsTruth,
} from "./kernelChoices.ts";
import {
  hasStructuralWorkflowProjectionMismatch,
  readCurrentExecutionPlanReading,
  readCurrentExecutionPlanReadingAsync,
  type ExecutionPlanReading,
  readExecutionPlaybookOptions,
  type ExecutionPlan,
  type ExecutionPlaybookOption,
} from "./executionPlan.ts";
import {
  buildTaskSupplements,
  normalizeTaskExecutionInstructions,
  resolveRepositorySupplement,
} from "./executionProfile.ts";
import { compileWorkflow } from "./workflowCompiler.ts";
import { readWorkflowStandardSnapshot } from "./workflowCatalog.ts";
import {
  materializeWorkflowProfile,
  reconcileWorkflowProfileAssets,
  withWorkflowSupplements,
  workflowProfilePrompt,
} from "./workflowProfileRuntime.ts";
import {
  resolveWorkflowAssets,
} from "./workflowAssetResolution.ts";
import type {
  WorkflowExecutionProfileV2,
  WorkflowResolvedAsset,
  WorkflowSourceRef,
  WorkflowStandardSnapshot,
} from "./workflowDefinition.ts";
import { normalizeWorkflowDefinition } from "./workflowDefinition.ts";
import { requireTechnologyStacks } from "./technologyStacks.ts";
import {
  probeDeliveryPlatform,
  type DeliveryPlatformCheck,
} from "./deliveryPlatformProbe.ts";
import type { DeploymentRuntimeCheck } from "./deploymentPreflight.ts";

/**
 * 任务快照会把知识与 Skill 包设成只读；直接 rm -r 时，macOS 会因为
 * 只读子目录无法摘除目录项而报 ENOTEMPTY。清理前只在已校验的任务树
 * 内恢复目录权限，遇到软链接只删除链接本身，绝不跟随到任务外。
 */
function removeTaskTree(path: string): void {
  const makeRemovable = (current: string): void => {
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) {
      chmodSync(current, 0o600);
      return;
    }
    chmodSync(current, 0o700);
    for (const entry of readdirSync(current)) {
      makeRemovable(join(current, entry));
    }
  };
  makeRemovable(path);
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
import {
  AGENT_REQUIREMENT_DOCUMENT,
  MAX_REQUIREMENT_DOCUMENT_BYTES,
  STORED_REQUIREMENT_DOCUMENT,
  materializeDeliveryDocument,
  materializeRequirementDocument,
  requirementContext,
  requirementDocumentMeta,
  storeRequirementDocument,
  type RequirementDocumentMeta,
  readRequirementRevision,
  storeRequirementRevision,
} from "./requirementDocument.ts";
import {
  loadRequirementAssets,
  materializeRequirementAssets,
  readRequirementAsset as readStoredRequirementAsset,
  storeRequirementAssets,
  type RequirementAsset,
} from "./requirementBundle.ts";
import {
  loadRequirementSources,
  materializeRequirementSources,
  readRequirementSource as readStoredRequirementSource,
  storeRequirementSources,
  type RequirementSource,
} from "./requirementMaterials.ts";
import { readJson } from "./jsonBody.ts";
import { fetchMrGates } from "./mrGateClient.ts";
import {
  isBlindPipelineInput,
  mirrorPipelineArtifacts as mirrorPipelineArtifactsShared,
} from "./pipelineMirror.ts";
import type {
  Notifier,
  NotifyQuestion,
  NotifyRecord,
} from "./notifier.ts";
import { EventLog, type SemanticEvent } from "./semanticEvents.ts";
import { DisplayEventReader, annotationReply } from "./displayEvents.ts";
import { pushWithFreshBranch, rejectedByBranchAdvance, RemoteBranchAdvancedError, RemoteBranchBusyError } from "./pushRace.ts";
import {
  buildActivity, readActivityEvents, type ActivityView,
} from "./activity.ts";
import { buildConversation, type ConversationView } from "./conversation.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import {
  HumanGate,
  StateConflictError,
  renderDecision,
  type WaitingRecord,
} from "./humanGate.ts";
import { humanizeRepositoryIds } from "./repositoryNames.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";
import { continueRetainedSession, discardRetainedSession, retainIdleSession, handoffSession, hostActionStopsContainer } from "./hostSessionContinuity.ts";
import {
  probeVisionCapability,
  type VisionModelChoice,
  type VisionProbeResult,
} from "./visionCapability.ts";
import {
  TaskContainer,
  TaskContainerExecTimeoutError,
  TaskContainerUnavailableError,
  sweepManagedTaskContainers,
  taskContainerInstance,
  type DockerRunner,
  type TaskContainerLimits,
  type TaskContainerMetadata,
  type TaskContainerOptions,
} from "./containerRuntime.ts";
import {
  prepareContainerHostPaths,
  prepareContainerWritableFile,
  repairContainerKernelOwnership,
  repairContainerMutationOwnership,
} from "./containerOwnership.ts";
import type { ExternalAction, PgProjection } from "./projection.ts";
import { SystemCheckTrace } from "./runtimeDiagnostics.ts";
import { runDeploymentCheck } from "./deploymentSystemCheck.ts";
import type { ModelsSettings, RuntimeSettings } from "./settings.ts";
import { personalLaneChoice, resolveModelConfig, type ResolvedModelConfig } from "./modelResolution.ts";
import { ReviewStore, assertReviewCanComplete, type ReviewRequest } from "./reviews.ts";
import {
  onlyUnfixableToolFailures,
  parsePipelineChecks,
  selectTerminalRun,
  summarizeFailedChecks,
  type PipelineCheck,
} from "./pipelineContract.ts";
import {
  assessPipelineRepairEvidence,
  PIPELINE_DIMENSION_TEXT,
  type PipelineArtifactText,
  type PipelineEvidenceAssessment,
} from "./pipelineEvidence.ts";
import {
  inspectKernelPosition, inspectKernelDeliveryReady, stalledKernelStep,
  inspectKernelTaskCompletion,
  type KernelCompletionAttestation,
} from "./terminalAttestation.ts";
import {
  closeKernelDelivery,
  createKernelHostProof,
  ensureKernelHostCapability,
  kernelHostCapabilityPresent,
  KernelUnavailableError,
  openKernelFeedback,
  recordKernelFeedbackResult,
  recordKernelPublishedPush,
  refreshKernelPanel,
  trustedKernelHostFeedback,
  type KernelFeedbackBatch,
} from "./kernelDelivery.ts";
import { kernelPhases, type KernelPhaseVocabulary } from "./kernelPhases.ts";
import { discoverKernelRoot } from "./kernelDiscovery.ts";
import {
  ContinuousReviewMigrationError,
  migrateContinuousReviewTask,
} from "./continuousReviewMigration.ts";
import {
  FeedbackStore,
  FeedbackStoreCorruptionError,
  type FeedbackRecord,
  type FeedbackSource,
} from "./feedbackStore.ts";
import { feedbackBatchId, feedbackIdentity } from "./feedbackLoop.ts";
import {
  materializeRepositorySkills,
  type SelectedRepositorySkill,
  validRepositorySkillPath,
} from "./repositorySkillRuntime.ts";
import { listBusinessModules, readBusinessModule, readBusinessKnowledgeAsset } from "./businessModuleLibrary.ts";
import {
  materializeBusinessModuleKnowledge,
  copyBusinessModuleSnapshots,
  snapshotBusinessModules,
  type MaterializedBusinessModuleKnowledge,
  type SelectedBusinessModule,
} from "./businessModuleRuntime.ts";
import {
  requireRepositoryProfiles,
  resolveRepositoryProfiles,
  type RepositoryProfile,
} from "./repositoryProfiles.ts";
import {
  effectiveLaunchKnowledgeSelections,
  previewLaunchKnowledge,
  type LaunchKnowledgePreview,
  type LaunchKnowledgePreviewInput,
} from "./launchKnowledgePreview.ts";
import {
  discoverRepositorySkills,
  type RepositorySkillCatalog,
  type RepositorySkillDescriptor,
} from "./repositorySkills.ts";
import {
  KnowledgeTrace,
  knowledgeUsageSnapshot,
  type KnowledgeResourceRef,
  type TaskKnowledgeUsage,
} from "./knowledgeTrace.ts";
import {
  buildHostSkillEffects,
  buildTeamKnowledgeInsights,
  type HostSkillEffect,
  type KnowledgeInsightTask,
  type TeamKnowledgeInsights,
} from "./knowledgeInsights.ts";
import {
  listHostSkillShelf,
  listHostSkillShelfRoot,
  type HostSkillShelf,
  type HostSkillShelfEntry,
} from "./hostSkillShelf.ts";
import { materializeHostSkills } from "./hostSkillRuntime.ts";
import { readHostSkillDocument, scanForSecrets, recoverSkillSubmissions, readSkillSubmissionPackage, SkillLibraryError } from "./hostSkillLibrary.ts";
import {
  EXTRACTION_TIMEOUT_MS,
  buildExtractionMission,
  parseExtractionDraft,
  persistExtractionJob,
  readExtractionJob,
  type ExtractionJobRecord,
} from "./knowledgeExtraction.ts";
import {
  REQUIREMENT_REVIEW_DOCUMENT,
  REQUIREMENT_REVIEW_RECEIPTS,
  REQUIREMENT_REVIEW_SESSION_POLICY,
  createRequirementReviewGateContract,
  prepareRequirementReviewWorkspace,
  requirementAnnotationInstructions,
  requirementReviewMission,
} from "./requirementReviewAgent.ts";

import { GIT_TRANSFER_TIMEOUT_MS } from "./gitTransferBudget.ts";
const MAX_REQUIREMENT_RECEIPTS_BYTES = 128 * 1024;

/** 货架条目在读侧的完整形态:资产事实+效果账。 */
export type DecoratedHostSkillShelf = HostSkillShelf & {
  skills: Array<HostSkillShelfEntry
    & { effect?: HostSkillEffect }>;
};
import {
  PrePushCommands,
  unfinishedPrePushTools,
  recordInterruptedPrePushTools,
  buildFixScopeReview,
  createPrePushGateContract,
  parsePrePushAgentReport,
  prePushMission,
  verifyPrePushEvidence,
  type PrePushAgentReport,
  type PrePushRunRequest,
  type PrePushRunResult,
  type PrePushRunner,
  prePushEvidenceFacts,
} from "./prepushAgent.ts";
import {
  parseWarmupReport,
  warmupMission,
  type WarmupRunRequest,
  type WarmupRunResult,
  type WarmupRunner,
} from "./warmupAgent.ts";
import {
  detectPrePushBuildProfile,
  isPrePushBuildCommand,
  fullSuiteCommandVerdict,
  PrePushCommandRepeatGuard,
  prePushCommandIdentity,
  prePushCommandTimeoutSeconds,
  resolvePrePushExecutionBudget,
} from "./prepushBuildPlaybook.ts";
import {
  hasContainerVolumeDestination,
  inspectPrePushEnvironment,
  prePushEnvironmentCommand,
} from "./prepushEnvironment.ts";
import {
  PRE_PUSH_EXECUTION_SCHEMA,
  attestPrePushExecution,
  beginPrePushAttempt,
  createPrePushVerification,
  failPrePushEnvironment,
  getReusablePushReceipt,
  observePrePushRevision,
  recordPrePushReport,
  rebindEquivalentPrePushRevision,
  retryPrePushVerification,
  restorePrePushVerification,
  sameRevision,
  type PrePushExecutionAttestation,
  type PrePushReport,
  type PrePushRevision,
  type PrePushVerificationState,
} from "./prePushVerification.ts";
import {
  CommitMessagePolicyError,
  DEFAULT_COMMIT_CONVENTION,
  cloudCommitSubject,
  commitHookRejection,
  rejectedCommitSha,
  repairedPlatformCommitSubject,
  validTaskCommitSubject,
  type CommitSubjectRecord,
} from "./commitPolicy.ts";
import { continuationTarget, finalMrContinuationBlock } from "./finalMrContinuationPolicy.ts";
import { applyFinalMrLink, refreshLinkedFinalMr } from "./taskFinalMrTracking.ts";
import { captureOriginalMr, type FinalDeliveryMr } from "./taskFinalMr.ts";
import { FinalMrSamples, type MrSamplingState } from "./finalMrSamples.ts";
import { readFinalDeliveryMr, normalizeRepairMrUrl } from "./mrImport.ts";
import { HostGitSandbox, runGitProcess } from "./hostGitSandbox.ts";
import { preserveGitAiNotes, publishGitAiNotes } from "./gitAiNotes.ts";
import { archiveContinuationRuntime, continuationInstructions, continuationPending, resetContinuationBranch, snapshotContinuation, type TaskContinuation, type TaskDeliveryHistory } from "./taskContinuation.ts";
import { TaskBranchSync, type BranchSyncRequest } from "./taskBranchSync.ts";
import {
  classifyDeliveryFailure,
  deliveryFailureMessage,
  FEEDBACK_RESULT_MISSING,
  heldForKernelUnavailable,
} from "./deliveryFailure.ts";
import {
  evidenceRetryStillValid, recoveryDelayMs, recoveryStillNeeded as stillNeedsRecovery,
  resolveVerifyDeadline, routeReceiptFailure, stallClassForError, stallDetail,
  stallNotice, stallReasonOf, stallWrite, verificationBudgetMs,
} from "./deliveryRecovery.ts";
import {
  CLOSED_MR_WRITE, REOPENED_MR_WRITE, autoRepairDisabledText, classifyGates,
  mergedCompletionDetail, mergedPendingAttestationWrite,
  nextWatchStep, stopFailures, waitingWrite,
  type GateView,
} from "./mergeWatch.ts";
import { crossRepositoryUpdateContext, syncCrossRepositoryGroup } from "./crossRepositoryUpdates.ts";
import { materializeReviewAssets, readReviewAsset, storeReviewAsset } from "./reviewAssets.ts";
import { type StallClass } from "./stallPolicy.ts";
import {
  emptyTokenUsageState,
  recordTokenUsage,
  restoreTokenUsageState,
  tokenUsageSnapshot,
  type ModelTokenUsageSample,
  type TaskTokenUsage,
  type TokenUsageState,
} from "./tokenUsage.ts";
import {
  createSafeGitView,
  runSafeWorktreeGit,
  runSafeWorktreeGitAsync,
  safeGitEnvironment,
  type SafeGitCommitIdentity,
} from "./safeGit.ts";
import {
  AGENT_PLATFORM_LOCAL_EXCLUDES, removeLegacyDeliveryExcludes,
  AGENT_PLATFORM_ROOTS,
  FLOW_RUNTIME_LOCAL_EXCLUDES,
  AGENT_PLATFORM_PATHSPECS,
  describeAgentPlatformRoots,
  isAgentPlatformPath,
} from "./agentPlatformPaths.ts";
import {
  humanBytes,
  judgeReclaim,
  reclaimWorkspace,
} from "./workspaceReclaim.ts";
import {
  buildCacheKey,
  cacheKeyFromPath,
  inspectBuildCaches,
  reclaimBuildCaches,
  type BuildCacheReclaimResult,
  type BuildCacheStatus,
} from "./buildCache.ts";
import { perRepoBuildCacheMounts } from "./buildCacheMounts.ts";
import {
  IssueEnvironmentVault,
  type IssueEnvironmentInput,
  type IssueEnvironmentRef,
} from "./issueEnvironment.ts";
import {
  deliveryStopped, projectRepairStopped, projectStatusLabel, projectTaskFocus, type TaskFocus,
} from "./taskFocus.ts";
import { NotFoundError, TaskControlError } from "./errors.ts";
import { createMergeRequest } from "./mrClient.ts";
import { resolveModuleMrParticipants } from "./moduleMrParticipants.ts";
import type { MrParticipantsResult } from "./mrParticipants.ts";
import { MR_DESCRIPTION_STEP, askMrDescription, savedMrDescription } from "./mrDescription.ts";
import {
  DEVELOPER_ASSISTANT_SESSION,
  appendDeveloperAssistantMessage,
  developerAssistantConversation,
  developerAssistantGateContract,
  developerAssistantHandoffPrompt,
  developerAssistantMission,
  developerAssistantTools,
  writeDeveloperAssistant,
  interruptDeveloperAssistant,
  readDeveloperAssistant,
  type DeveloperAssistantView,
} from "./developerAssistant.ts";
import {
  beginDeveloperAssistantHandoff,
  captureDeveloperAssistantWorktree,
  finishDeveloperAssistantHandoff,
  inspectDeveloperAssistantAvailability,
  markDeveloperAssistantReturned,
  summarizeDeveloperAssistantChangedPaths,
  type DeveloperAssistantAvailability,
  type DeveloperAssistantHandoff,
} from "./developerAssistantHandoff.ts";

/** 现场保留期默认两周(用户 2026-08-22 拍板)。 */
export const DEFAULT_WORKSPACE_RETENTION_DAYS = 14;
/** 构建缓存比任务现场更值得复用，但也必须有自动止涨边界。 */
export const DEFAULT_BUILD_CACHE_RETENTION_DAYS = 30;
export const DEFAULT_BUILD_CACHE_MAX_GB = 100;
const FINAL_MR_ASSISTANT_READ_ONLY = "已关联最终 MR，请在本地修改代码。任务完成后可按任务详情中的提示开始下一轮修改。";
const DELIVERY_CHAIN_SOURCE = "chain-plan.md";
const DELIVERY_UNIT_SOURCE = "unit-brief.md";
const AGENT_DELIVERY_CHAIN = ".mae-flow-chain.md";
const AGENT_DELIVERY_UNIT = ".mae-flow-unit.md";

/** 交付失败在页面上的人话。原始异常仍进服务日志/诊断包；任务摘要只
 * 保留用户能据此行动的结论，避免 TypeError 和宿主绝对路径外泄。 */
export function userFacingDeliveryFailure(error: unknown): string {
  const raw = String(error).replace(/^(Error:\s*)+/, "").trim();
  if (commitHookRejection(raw)) {
    const sha = rejectedCommitSha(raw);
    return `推送被仓库拒绝：提交${sha ? ` ${sha.slice(0, 12)}` : ""}`
      + "的说明不符合仓库规范。远端没有接收这次更新，请修正提交说明后重新尝试交付";
  }
  if (/\bfetch failed\b/i.test(raw)) {
    return "交付平台暂时连接不上，请检查平台地址或网络";
  }
  if (/平台返回里没有 MR 链接/i.test(raw)) {
    return "交付平台响应不完整，未返回 MR 链接";
  }
  if (/remote unpack failed:\s*unable to create temporary object directory/i
    .test(raw)) {
    return "宿主推送失败：远端代码仓暂时无法写入，请检查仓库服务或存储权限";
  }
  // 非快进拒收 = 探测与推送之间有人往分支上推了东西。它不是坏契约,
  // 重试有意义:下一轮 tryDeliver 开头会把外来提交接上再推。这句话
  // 因此必须留在自愈通道里,别落进 deterministicDeliveryFailure。
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(raw)) {
    return "远端分支已被他人更新，系统会把新提交接上后重试推送";
  }
  return raw.replace(
    /failed to push some refs to\s+(['"])[^'"]+\1/gi,
    "未能更新远端分支",
  );
}

export type TaskStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "waiting_for_human"
  | "coordinating"   // 跨仓主任务已拆单，等待子任务完成或取消
  | "completed"
  | "verifying"      // MR 已建,权威流水线未过(主 spec §10:不能标完成)
  | "await_merge"    // 流水线通过,等待人工合入;系统不自动合并
  | "canceled"
  | "failed";

/** prepush 领域台账之外的进程活性投影。它只回答当前 serve 是否真的
 * 持有执行权，不写进 task.json，也不能被当作验证结论。 */
export type PrePushRuntimeState =
  | "running"
  | "recovering"
  | "interrupted"
  | "stopped"
  | "idle";

const HARD_DELETE_STATUSES: readonly TaskStatus[] = [
  "completed", "failed", "canceled",
];

export interface TaskDeletionResult {
  id: string;
  deleted: true;
  local_task: boolean;
  projection_task: boolean;
  reviews_removed: number;
  notifications_removed: number;
}

export interface TaskProgress {
  /** 与内核现场看板同源的展示阶段；这里只镜像，不参与流程判定。 */
  phases: string[];
  current_index: number;
  current_phase: string;
  /** 内核步骤稳定 ID，仅供宿主读取 flow.json 契约；step 是给人看的标题，
   * 两者不可混用（标题可本地化，也可能随文案迭代变化）。 */
  step_id?: string;
  step?: string;
  revision?: number;
  /** build 内的非门禁观察事件；不改变阶段、不参与完成判定。 */
  milestone?: {
    task_id: string;
    title: string;
    event: "started" | "completed" | "blocked";
    reason?: string;
  };
}

/** 数据契约由 requirementProjection 定义；子任务实时状态由宿主补充。 */
export interface RequirementRepository extends RequirementProjectionRepository {
  /** 父任务读侧投影的子任务实时状态；不写回 Chain 产物。 */
  task_status?: TaskStatus;
  current_phase?: string;
}

/** Cloud 的质量动作分工是部署事实，不由用户或每单参数选择。 */
const CLOUD_EXECUTION_CONTRACT = {
  schema: "mae-flow-execution/1",
  host: "cloud",
  compile: "pipeline",
  ut_write: "agent",
  ut_run: "pipeline",
  codecheck: "pipeline",
  git_push: "host",
} as const;

function taskHostSkillsDir(dataDir: string, summary: TaskSummary): string {
  return summary.host_skills_pinned
    ? join(summary.workspace, "host-skill-snapshot")
    : join(dataDir, "skills");
}

export function availableUtGenerationMethod(
  loadedSkillNames: string[] = [],
): string {
  const unique = [...new Set(loadedSkillNames.filter((name) =>
    /(?:^|[-_])(?:java[-_])?(?:auto)?ut(?:$|[-_])/i.test(name)
      || /ut[-_]generator/i.test(name)))];
  const rank = (name: string): number => {
    const normalized = name.toLowerCase();
    if (normalized === "java-autout") return 0;
    if (normalized === "autout") return 1;
    return 2;
  };
  unique.sort((left, right) => rank(left) - rank(right)
    || left.localeCompare(right));
  return unique[0] ?? "仓内既有写法";
}

function validateRepositoryAddress(candidate: string): void {
  if (/\s/.test(candidate)) {
    throw new Error("代码仓地址不能含空白字符");
  }
  if (!candidate || candidate.startsWith("-") || /[\0\r\n]/.test(candidate)) {
    throw new Error("代码仓地址不能含控制字符或以 - 开头");
  }
  if (/^(?:ssh:\/\/|git\+ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(candidate)) {
    throw new Error(
      `代码仓请填 HTTPS 地址(收到 SSH 形式: ${candidate})。`
      + `宿主推送与 MR 用个人令牌走 HTTPS,SSH 没有可用凭据,`
      + `会在交付推送时 Permission denied`);
  }
  if (/^https?:\/\//i.test(candidate)) {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) {
      throw new Error("代码仓 URL 不许携带账号密码——鉴权使用个人 CodeHub Token");
    }
    assertRepositoryCloneAddress(candidate);
  }
}

/** 分析中的初始仓库节点只是候选占位。只有 projection_state=ready 才是
 * Agent 根据代码事实生成、可以拿来拆任务的模块依赖图。 */
export interface RequirementGraph {
  stage: "analysis" | "confirmed";
  projection_state?: "pending" | "ready" | "invalid";
  projection_error?: string;
  /** Story（旧版 CHAIN）与机读图共同携带的修订号；二者不一致时禁止拆单。 */
  plan_revision?: string;
  /** 新建分析任务必须使用强同步契约；存量任务缺席时先兼容展示，
   * 一旦产物发生返工就要求升级。 */
  sync_required?: boolean;
  /** Agent 在图文件里声明的设计文档原文摘要，由宿主按真实字节复核。 */
  chain_sha256?: string;
  /** 新分析用 Story；缺席为历史 CHAIN。摘要沿用旧字段以兼容已保存快照。 */
  source_document?: "story.md" | "chain";
  /** 宿主对 requirement-graph.json 原文计算的摘要，用来阻止同 revision
   * 偷换任一份产物；这是当前草稿的投影账，不要求 Agent 写入图文件。
   * 是否已经送审不能由这个字段判断：页面轮询也会刷新草稿投影。 */
  projection_sha256?: string;
  /** 真正展示给人检视时封存的版本。Agent 运行中可以在同一 revision
   * 内反复完善草稿；一旦举出最终方案确认卡，这份快照就不可改写。 */
  review_snapshot?: {
    waiting_id: string;
    plan_revision: string;
    chain_sha256: string;
    projection_sha256: string;
    sealed_at: string;
  };
  /** 已经送审过的修订号。打回后必须使用新号，不能回收旧号冒充新稿。 */
  reviewed_plan_revisions?: string[];
  repository_assessments?: RequirementRepositoryAssessment[];
  repositories: RequirementRepository[];
  dependencies: RequirementDependency[];
}

export interface CrossRepositoryUpdate {
  id: string;
  parent_task_id: string;
  source_task_id: string;
  source_repository?: string;
  author: string;
  text: string;
  target_task_ids: string[];
  created_at: string;
}

/** push 前检视的阅读导航。展示本次实际改动，不把历史文件选择变成后续修复边界。 */
export interface PushReviewPresentation {
  kind: "delivery" | "feedback" | "pipeline" | "conflict" | "rework";
  title: string;
  description: string;
  base_sha: string;
  baseline_sha: string;
  head_sha: string;
  has_focused_changes: boolean;
  file_count: number;
  additions: number;
  deletions: number;
  /** 逐行统计不可得的原因(如提交历史与对比基点不连续)。设置时
   * additions/deletions 是占位 0,界面必须显示这句话而不是 +0/−0
   * ——文件数有值、行数假零的混合结果比没有更误导(MFC-040)。 */
  stats_unavailable_reason?: string;
  commits: Array<{ sha: string; subject: string }>;
  /** 完整工作区变化供阅读；committed_paths 是当前已提交的 MR 文件变化。 */
  all_paths: string[];
  committed_paths: string[];
  agent_note?: string;
  verification?: string;
}

/** Agent 在开发中提议拆分(propose_split)留下的事实:为什么、建议怎么切、
 * 在哪个阶段。有它就说明这单是从直接开发转成分析拆分的。 */
export interface SplitEscalation {
  at: string;
  reason: string;
  suggested_units?: string[];
  /** 提议时所处阶段(来自进度镜像,可能没有)。 */
  phase?: string;
  /** pending=卡上等人;split=人选了拆,已转身;declined=人否决,按一个任务干完。 */
  decision: "pending" | "split" | "declined";
  decided_by?: string;
  decided_at?: string;
}

export interface TaskSummary {
  id: string;
  delivery_report?: DeliveryReportView;
  continuation?: TaskContinuation;
  delivery_history?: TaskDeliveryHistory[];
  delivery_generation?: string;
  delivery_started_at?: string;
  /** 仅供本地 UI 场景库冻结状态；必须同时显式开启
   * MAE_FLOW_UI_FIXTURE_MODE，正式任务永远不会写入。 */
  ui_fixture?: true;
  /** 扫读标题:需求原文仍完整保留在 requirement。旧任务缺席时由读侧
   * 从需求首行生成,不要求迁移现场文件。 */
  title?: string;
  requirement: string;
  /** 新下单是否必须经人工确认才进入需求分析。旧任务缺席时不补卡，
   * 避免升级后把已在途任务突然挂起。 */
  requirement_analysis_confirmation_required?: boolean;
  /** 人工明确点击“进入需求分析”的时刻；从这一刻起需求正本锁定。 */
  requirement_analysis_confirmed_at?: string;
  /** 本单落下的记忆条数(含已撤回)。只是个数,让人一眼看到"这单记了
   * 东西";明细走 /tasks/:id/memories。 */
  memories_recorded?: number;
  /** 需求确认阶段由 Agent 串行落实检视意见。人始终只读文档，因此
   * 不需要编辑锁/版本合并；running 时整体确认按钮必须禁用。 */
  requirement_revision?: {
    id: string;
    state: "running" | "failed";
    annotation_ids: string[];
    started_at: string;
    finished_at?: string;
    error?: string;
  };
  /** 已完成的每一轮需求修改:改前全文和 diff 落在工作区
   * requirement-history/,这里只放账目,页面按 id 取对比。 */
  requirement_revisions?: Array<{
    id: string;
    at: string;
    annotation_ids: string[];
    additions: number;
    deletions: number;
  }>;
  /** 用户上传或因过长而转为按段读取的 Markdown 原文。requirement 仍
   * 完整保留用于界面查看；这个字段决定 Agent 是否直接内联全文。 */
  requirement_document?: RequirementDocumentMeta;
  status: TaskStatus;
  /** 执行队列位次(1 起,读侧投影,不落盘):排队的单必须能回答
   * "排到哪了",否则陈旧 detail 会让它看起来像在推进。 */
  queue_position?: number;
  /** 读侧统一投影：只解释当前事实，不参与流程迁移或门禁。 */
  focus?: TaskFocus;
  /** 状态短文案(taskFocus.projectStatusLabel);前端不再按 loop/prepush 自己拼。 */
  status_label?: string;
  /** 机器停了该人上(taskFocus.projectRepairStopped);与 retry 准入同源。 */
  repair_stopped?: boolean;
  waiting?: WaitingRecord & {
    /** 推荐先看的证据面，由内核 approval_subject 或 Cloud 原生分析类型投影。 */
    recommended_view?: "source" | "doc" | "chain" | "diff";
    /** 只读投影：选项会关闭检视，还是进入/留在意见处理步骤。前端据此
     * 提示未闭环意见，不能在 TS 里手写内核步骤分支表。 */
    choice_effects?: Array<{
      key: string;
      answers: string[];
      allows_source_edit: boolean;
      handles_feedback: boolean;
      closes_feedback: boolean;
    }>;
  };
  detail?: string;
  created_at: string;
  /** 任务运营时间:updated_at 是任意任务事实最近变更,last_progress_at
   * 只在状态/阶段推进时变化,领导据此识别“长时间没有有效进展”。 */
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  /** 模型提供方真实上报的任务级累计与最近一分钟吞吐。主/子/prepush
   * Agent 统一计入；缺席表示网关没有可靠 usage，绝不按字符数估算。 */
  token_usage?: TaskTokenUsage;
  /** 环境预热编译(观测旁路,fail-open):现场就绪后专职会话在编码
   * 容器里编译基线——验环境+焐缓存+沉淀构建入口。收据绑起跑 SHA,
   * 基线红=环境/上游的锅;结果绝不构成交付证据(核销在 prepush+
   * 流水线)。 */
  baseline_build?: {
    status: "running" | "passed" | "failed" | "infrastructure_failure";
    sha: string;
    detail?: string;
    build_command?: string;
    started_at: string;
    finished_at?: string;
  };
  /** 下单事实里的「UT生成方式」镜像。实锤(2026-08-27 内网):这个值
   * 原来只活在工作区 .mae-flow.json,内网按 task.json 排查 UT skill
   * 为什么没被消费,四个人对着空气找。等于"仓内既有写法"= 没指向
   * 任何团队 Skill(货架为空或命名没命中 UT 模式),skill 不被读是
   * 正确行为不是 bug——这句话必须能在界面上看到。 */
  ut_generation_method?: string;
  workspace: string;
  /** 现场被回收的时刻(ISO)。有值 = 克隆等重货已删,台账还在。
   * 它还是一道闸:恢复时**不许再拿内核状态重新裁决这单**——原件已经
   * 不在了,再量一遍只会把收好口的老单翻成"验证中"甚至重新推分支
   * (同一个坑 settledBeforeContract 已经踩过一次)。 */
  workspace_reclaimed_at?: string;
  /** 小鲁班通知账号(任务创建时填写,主 spec §5.1)。 */
  luban_account?: string;
  /** 待办来源域(小鲁班手机审批展示用):需求任务缺省 requirement;
   * 问题会话等待卡的投影标 issue(卡面称呼「问题 单号 · 会话」)。 */
  origin?: "requirement" | "issue";
  /** 跨仓主任务的共同开发者。主责任人仍由 luban_account 唯一确定；
   * 协作者可参与分析讨论与送出批注，但不能提交最终决定或控制任务。 */
  collaborators?: string[];
  /** 单任务审批方式。缺席=继承个人设置；manual 可压过全局月光模式，
   * moonlight 仅放行本任务。 */
  approval_mode?: "inherit" | "manual" | "moonlight";
  /** 下单时填的交付代码仓;缺席=部署仓(--repo)。记在任务上:
   * 重启续跑同仓不漂移,MR/流水线请求也带它给平台适配层。 */
  repo_url?: string;
  /** 需求影响的全部仓库。repo_url 保留为单仓交付兼容字段。 */
  repositories?: string[];
  /** 首次人工确认的仓库技术画像在下单时固定，后续修改只影响新任务。 */
  repository_profiles?: RepositoryProfile[];
  /** Git 仓库原生 Skill 的固定快照。字段缺席表示尚未进入代码现场；
   * 首次 clone 后只发现 Git 已跟踪内容并立即固化，平台不提供发布、
   * 编辑或知识入库。空数组表示该 commit 没有可用仓内 Skill。 */
  repository_skills?: SelectedRepositorySkill[];
  /** 本任务从团队知识货架固定的 Skill 形态资产；正文位于任务快照，
   * 页面只展示元数据，Agent 仍通过 Skill 索引按需读取。 */
  team_skills?: HostSkillShelfEntry[];
  /** 用户下单时明确选择的业务模块及不可变知识快照。只把标题、摘要、
   * 适用场景和任务内路径目录交给 Agent，正文必须按需读取；模块后来
   * 更新不会改写运行中或历史任务。 */
  business_modules?: SelectedBusinessModule[];
  /** Single requirement ownership for reporting; children read their root parent. */
  business_module?: { id: string; name: string };
  business_module_history?: Array<{ at: string; by: string; from?: { id: string; name: string }; to?: { id: string; name: string } }>;
  /** 任务详情读侧投影：提供/加载/阅读的宿主事实，不参与任务落盘。 */
  knowledge_usage?: TaskKnowledgeUsage;
  /** 持续检视轻量索引；原始事实仍由各来源账本负责。 */
  feedback?: FeedbackRecord[];
  /** 单任务反馈索引不可读时的显式诊断；不得拖垮整个任务列表。 */
  feedback_error?: string;
  /** 多仓时由 Chain 产物投影；单仓时是一个节点的退化图。 */
  requirement_graph?: RequirementGraph;
  /** 单仓先分析拆分。2026-09-03 起下单不再有开关(仓数与勾选都不该决定
   * 拆不拆):它只由 Agent 在开发中 propose_split 置上,或原位重跑沿用。
   * 落盘,重启后 isRequirementAnalysis 判定不变。 */
  requirement_analysis_requested?: boolean;
  split_escalation?: SplitEscalation;
  /** 本任务作为交付单元的负责文件面(仓内相对路径前缀)。交付门禁
   * 据此校验越界;缺席 = 整仓无边界(普通任务/旧现场)。 */
  delivery_scope?: { name: string; paths: string[] };
  /** 主责任人放行过的越界文件(逐文件豁免,落盘)。 */
  delivery_scope_exemptions?: string[];
  /** 确认 Chain 方案后生成的普通仓库交付任务关系。 */
  parent_task_id?: string;
  /** 子任务头部使用的父任务摘要；读侧投影，不复制父任务整份数据。 */
  parent_task?: {
    id: string;
    title?: string;
    ticket?: string;
    status: TaskStatus;
  };
  blocked_by?: string[];
  dependency_adjustments?: DependencyAdjustment[];
  /** 分工后的接口/契约变化回流主任务，并复制给直接相关上下游子任务。 */
  cross_repository_updates?: CrossRepositoryUpdate[];
  /** 交付方式(用户拍板:下单就选好,不让 agent 来问)。取值是**内核
   * flow.json 里 workflow_select 的选项原文**(完整开发/已定位问题修复/
   * 局部修改/处理评审意见),不是宿主自造的词——自造过一次,结果是
   * 卡来了永远对不上、用户在流程里被重复问一遍(2026-08-18 内网实测)。
   * 内核仍会举卡(流程规则是内核的,宿主不删它的问题),对得上就自动
   * 交卷(预答,不是代判)。 */
  lane?: string;
  /** 需求/问题单号(REQ/DTS)。下单就给(用户 2026-08-19 拍板),
   * 开场当事实喂给模型——配置确认不再为它开口问。 */
  ticket?: string;
  ticket_correction?: TicketCorrection;
  /** 基线分支,默认 master(同一次拍板)。 */
  baseline?: string;
  product_version?: string;
  /** 下单时选的模型;缺席=跟随服务当前默认(设置层/部署层)。
   * 记在任务上是为了两件事:重启续跑不漂移、页面能说清"谁跑的"。 */
  model_choice?: { provider: string; model: string };
  /** 最近一次主会话启动解析到的网关通道(ADR-0039/0068):platform=
   *  平台网关,personal=归属人的个人网关;beta 是 Beta 网关时期的
   *  历史事实(ADR-0068 退役),读取侧照常兼容。fail-open 回落不回改
   *  本标记;精确消耗看 token_usage 与网关侧账。 */
  model_lane?: "platform" | "personal" | "beta";
  /** 下单时的修复轮预算;缺席=跟随服务当前默认。0=本单关掉修复环。 */
  repair_rounds?: number;
  /** 代码仓执行约定已完成首次解析并固定进 workflow_profile.supplements;
   * 即使仓内没有配置或配置损坏,也要固定这次结果——恢复/重跑不能从
   * 后来变化的仓库文件偷偷换方案。(v1 execution_profile 三字段已随
   * v1 退役删除,2026-08-29 无存量窗口统一。) */
  repository_supplement_resolved?: boolean;
  /** 专业用户选定/定制的结构化工作流。base 与 final 都在下单时固定，
   * 任务只执行 final_snapshot；恢复、修复和历史查看不追随目录升级。 */
  workflow_profile?: WorkflowExecutionProfileV2;
  /** 标准目录暂不可读等非阻断降级；不能静默假装定制已生效。 */
  workflow_profile_warning?: string;
  /** 活方案对拍告警(详情投影时算):内核 stderr 的 ⚠、执行方案里的
   * profile_invalid 诊断、以及"任务定了格但活方案没吃到定格"的失配。
   * 曾经整条链路静默——界面展示创建时定格副本,Agent 实际跑平台默认,
   * 无人被通知(2026-08-30 审计 P0-1)。有值必须标红呈现。 */
  execution_plan_alerts?: string[];
  /** 新任务在创建时固定团队 Skill；旧任务缺席时才兼容读取实时货架。 */
  host_skills_pinned?: boolean;
  host_skill_snapshot_warnings?: string[];
  /** 最近一张待办的通知发送事实(失败标红的依据,不影响流程)。 */
  notify?: Pick<
    NotifyRecord,
    "delivered" | "settled" | "attempts" | "last_error"
  >;
  /** Git 交付事实(§10):MR 链接/状态、流水线结果、或没交付的原因。
   * sha = 流水线绑定的代码版本,也是重启后续轮的锚。 */
  delivery?: TaskDeliverySummary;
  /** 旧版文件选择记录，仅供历史兼容和清理旧 ignore，不再新增或控制提交。 */
  delivery_selection?: {
    paths: string[];
    observed_paths: string[];
    excluded_paths: string[];
    status: "requested" | "confirmed";
    waiting_id: string;
    head: string;
    baseline?: string;
    confirmation_mode?: "human" | "policy";
    confirmation_reason?: string;
    updated_at: string;
  };
  /** push 前人工确认(任务级显式开关;缺省由个人设置决定)。
   * 确认后沿用决定；明确返工则修改后重新确认，不涉及文件勾选。 */
  push_confirmation?: boolean;
  /** 从现场看板的 panel-pulse.js/panel.html 读取的进度摘要。 */
  progress?: TaskProgress;
  /** 内核对当前阶段默认做法的只读解释；不参与状态迁移或完成裁决。 */
  execution_plan?: ExecutionPlan;
  /** 人工控制台账。paused_from 是恢复时的扳道锚点：等待决定、流水线
   * 验证和普通执行的恢复方式不同，不能靠前端猜。 */
  control?: {
    last_action: "pause" | "resume" | "cancel";
    actor: string;
    at: string;
    paused_from?: TaskStatus;
  };
}

export interface TaskServiceOptions {
  /** 测试和固定剧本可关闭分析发布后的自动补图，生产默认开启。 */
  autoArchitecture?: boolean;
  dataDir: string;
  provider: string;
  model: string;
  /** 每个任务 agent 目录的 models.json 内容(生产=GLM 网关,演练=剧本假模型)。 */
  modelsJson: Record<string, unknown>;
  /** serve 启动时采集的 Linux/容器信号事实；直接构造的测试形态可缺席。 */
  deploymentRuntime?: DeploymentRuntimeCheck;
  /** 问题流专用部署(--issue-only):需求流程整体停用——内核/交付
   * 平台/prepush 不加载,create() 直接拒绝,launchOptions 摆出明面
   * 的 blocker。历史任务台账仍可读(管理/兜底不受影响)。 */
  requirementDisabled?: boolean;
  /** 可选语义索引；未配置时记忆仍能写入、展开和按索引推送。 */
  memory?: {
    python: string;
    script: string;
    milvusPath: string;
    provider?: string;
    model?: string;
    env?: NodeJS.ProcessEnv;
  };
  /** @deprecated 兼容旧调用方；经验整理始终使用任务主模型，此配置不再生效。 */
  memoryDraftModel?: { provider: string; model: string };
  /** @deprecated 兼容旧调用方；过程中不再进行单条模型提炼。 */
  memoryDrafter?: (prompt: { system: string; user: string }) => Promise<string>;
  /** 可选的专用视觉模型角色。模型定义位于同一份 models.json，主 Agent
   * 仅通过 InspectImage Tool 调用它，不切换主会话模型。 */
  vision?: VisionModelChoice;
  maxConcurrent?: number;
  /** 现场保留期(天)。终态任务过期后回收克隆等重货,台账原样留下;
   * 0 = 永不回收。部署值,可被管理页运行时设置压过。默认见 serve.ts。 */
  workspaceRetentionDays?: number;
  /** 仓库级构建缓存连续未使用多少天后回收；0 = 不按时间回收。 */
  buildCacheRetentionDays?: number;
  /** 构建缓存总容量上限(GB)，超出后按最久未用优先回收；0 = 不限。 */
  buildCacheMaxGb?: number;
  contract?: GateContract;
  /** 内核模式(阶段 1 纵向闭环):任务=克隆 repoPath → 内核 bootstrap
   * (sessionstart+userprompt 捕获需求、铺转发壳)→ 深层门禁与证据
   * 全部经 kernelHost 走内核 dispatch。不配则为纯会话模式(演练)。 */
  /** repoPath 仅用于 --repo 钉死单仓的演示/测试形态；正式下单逐单填仓。 */
  host?: {
    kernelRoot: string;
    repoPath?: string;
    python?: string;
    /** 仅 serve 启动握手确认能力后置真。缺席保持旧契约，绝不假装
     * 新内核可用；这也是测试桩与历史直接构造调用的显式分流。 */
    continuousReview?: boolean;
    /** serve 部署以 --repo 钉死单仓时置真:逐单 repo 被拒、表单不再
     * 收仓库地址(MFC-024)。直接构造 TaskService 的测试/试跑 harness
     * 不置,repoPath 仍只是缺省克隆源。 */
    repoPinned?: boolean;
  };
  /** Cloud 工作流资产使用的只读目录根；不会开启代码仓、内核执行或交付。
   * 演示形态也可据此创建、发布并真实编译工作流方案。 */
  workflowCatalogRoot?: string;
  /** 小鲁班通知(内网能力,外部用 FakeLubanServer 模拟)。 */
  notifier?: Notifier;
  /** Git 交付(§10):平台 API 地址(外部=FakeGitPlatform)。
   * 配了它,任务收轮后由服务账号建 MR + 触发权威流水线。
   * 真实流水线是异步的:触发后 running,由带预算的轮询收敛
   * (poll* 两个旋钮给测试和内网调参;预算耗尽留痕请人工,不卡死)。 */
  delivery?: {
    platformUrl: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
    /** 红灯详细证据暂不可得时的跨请求重试间隔。不与状态轮询
     * 共用：采集 artifacts 较重，默认每 3 分钟重试一次。 */
    evidenceRetryMs?: number;
    /** 流水线红灯的修复轮预算(默认 20;0 = 关掉修复环,红灯即留痕请人工)。
     * 每轮 = 一次专职修复会话 + 一次新流水线;耗尽如实停在 verifying。 */
    repairRounds?: number;
    /** 发布检视回复时顺手标"已解决"。默认关——内网既有框架的实证
     * (报告 D3):平台文化是"回复归作者,resolve 归检视人",代点
     * 是越权。平台/团队明确允许代点的部署再打开。 */
    resolveDiscussions?: boolean;
    /** 不可自动修复的质量工具名单(toolkit 的 UNFIXABLE_TOOLS 对齐,
     * 如 ["SuperChecker"]):CODECHECK 红灯全部来自这些工具时不派发修复
     * 会话,直接如实等人——派了也是白烧一轮(2026-08-28 对比报告)。
     * 判定要有 tool 证据且全体命中才生效,拿不准照常派发修复。 */
    unfixableTools?: string[];
  };
  /** 环境预热编译专员(观测旁路)。**缺席即不启用**——serve/pilot 在
   * 隔离模式下显式开启;隐式默认开曾把 prepushIntegration 的 linear
   * 剧本搅乱(预热会话偷吃场景),测试形态必须零意外会话。runner 是
   * 测试注入口,生产走编码容器里的独立 Pi 会话。 */
  warmup?: {
    enabled?: boolean;
    runner?: WarmupRunner;
    /** 专员会话墙钟预算,超时如实记 infrastructure_failure(默认 25 分钟)。 */
    attemptTimeoutMs?: number;
  };
  /** 上传 Skill 的固定调用；runner 仅用于执行器替换和定向测试。 */
  codecheck?: { runner?: CodecheckRunner };
  /** 按需调用的 Cloud-native 编译/UT Agent；enabled 仅表示能力可用，
   * 不在交付前自动执行。Agent/责任人主动请求时使用独立 Pi 会话；
   * 基线预热由 warmup 独立启用，二者结果不互相替代。 */
  prepush?: {
    enabled?: boolean;
    runner?: PrePushRunner;
    /** 编译属于重资源动作，和普通 Agent 并发分开计数。默认只放行一单，
     * 避免同一台内网宿主被多个 Maven/C++ 进程瞬间打满。 */
    buildSlots?: number;
    /** 单次 prepush Agent 的墙钟预算。命令各自有 timeout 仍不够：模型可
     * 在多个失败命令之间无限换策略。普通仓默认 30 分钟，含 C++ 的仓库
     * 默认 60 分钟；超时明确收口并销毁 attempt 容器。 */
    attemptTimeoutMs?: number;
    /** Maven/CMake/Make 等重型构建的单命令预算。模型给出的更短 timeout
     * 会被提升到这里，避免已知慢仓被随手填的 600 秒截断。普通仓默认
     * 20 分钟，含 C++ 的仓库默认 45 分钟。 */
    buildCommandTimeoutMs?: number;
  };
  /** DTS 日志/换库/回滚的部署适配器。缺席时问题单仍可按手填材料完成
   * 诊断和代码交付，绝不能因为尚未接内部环境系统而卡死。 */
  /** 审批链接的前缀(通知里带的 URL),如 http://host:port。 */
  linkBase?: string;
  /** PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的读侧。
   * 纯旁路——写失败不改流程,不配则一切照旧(文件即真相)。 */
  projection?: PgProjection;
  /** @deprecated 上下文由 CloudSession 按容量主动管理；保留旧调用参数兼容。 */
  compactEveryEvents?: number;
  /** 容器隔离(设计文档):bash 命令进任务专属容器执行,镜像按
   * 试点仓选。容器起不来任务如实 failed,不静默降级回宿主。
   * volumes = 额外挂载,"宿主:容器" 形状;
   * memory/cpus/user = 资源限额与身份映射,不配即不限。 */
  isolation?: {
    image: string;
    volumes?: string[];
    /** 构建缓存宿主根目录。平台按仓库 URL 的哈希自动分区，绝不让
     * Maven/npm/ccache 在无关业务仓之间共享同一份可写缓存。 */
    cacheRoot?: string;
    memory?: string;
    cpus?: string;
    user?: string;
    pidsLimit?: number;
    labels?: Record<string, string>;
    readOnlyRoot?: boolean;
    tmpfsHome?: string | false;
    tmpfsTmp?: string | false;
    network?: string;
    environment?: NodeJS.ProcessEnv;
    forwardEnvironment?: readonly string[];
    stopGraceSeconds?: number;
    managementTimeoutMs?: number;
    /** Docker CLI 注入口，仅供无 daemon 单测和受控运行时适配。 */
    runner?: DockerRunner;
    /** 窄测试/运行时适配注入口。生产不配置时始终使用 TaskContainer；
     * 结构化接口让测试能证明普通会话与 prepush 都没有宿主 Bash 回退。 */
    containerFactory?: TaskContainerFactory;
  };
  /** 提交信息规范(部署级一句话,进每个会话的开场)。
   *
   * **业务提交的格式权威在内核**(`[<单号>][feat|fix]描述`,内核门禁
   * 直接 block),平台 pre-receive 钩子的正则是它的超集,天然兼容
   * ——这个旗子不是用来改写内核规则的,配成别的格式只会让 agent 写出
   * 内核当场拒收的信息(反例见部署手册)。
   *
   * 它存在是为了内核管不到的那部分:合并提交(冲突修复产生、由宿主
   * 直接推送)、revert、或某些仓额外要求的前缀——平台钩子照样会按
   * 正则拒收 push,而那时代码早写完了,重来一遍纯浪费。 */
  commitConvention?: string;
  /** 运行时设置覆盖(管理页):并发/修复轮/轮询/通知/模型网关。
   * 部署配置是底,这层是热改;各消费点即时读,生效边界见 settings.ts。 */
  settings?: RuntimeSettings;
  /** System credential fallback for read-only component source fetches only. */
  platformGitCredential?: () => { username: string; password: string } | undefined;
  /** 按任务归属人取个人 Git 凭据(serve 接 LocalAuth.gitCredential)。
   * 有凭据→只在宿主 clone/push 的短生命周期 helper 中使用；Agent
   * 目录与仓库配置永远不落 token/helper。没有→维持部署级访问方式
   * (服务账号/开放内网)。 */
  gitCredential?: (
    account?: string,
  ) => { username: string; password: string; email?: string } | undefined;
  /** 个人模型网关查询口(ADR-0068,serve 接 LocalAuth.personalModels):
   *  按任务归属人现取其自配的模型接入,配齐则名下任务的主模型调用
   *  整体走它;缺席/未配=undefined,走平台网关。 */
  personalModels?: (account?: string) => ModelsSettings | undefined;
  /** 月光模式(免审批)查询口:按任务归属人现读现判(serve 接
   * LocalAuth.moonlightEnabled)。开着时该用户任务的人工节点由
   * 系统代答放行,答复里写明预授权与复盘要求;随时可开可关。 */
  moonlight?: (account?: string) => boolean;
  /** push 前人工确认(交付清单过目)查询口:与 moonlight 同纪律,
   * 按任务归属人现读现判(serve 接 LocalAuth.pushConfirmationEnabled,
   * 真人缺省即开)。任务级显式设置(setPushConfirmation)优先于它。 */
  pushConfirmation?: (account?: string) => boolean;
  /** 跨仓委派的服务端就绪校验。生产接 LocalAuth 的窄视图；测试/纯
   * 会话形态可缺席，保持既有 TaskService 单元测试不依赖账号库。 */
  collaborationAssigneeReadiness?: (
    account: string,
  ) => { ready: boolean; missing: string[] };
  log?: (message: string) => void;
  /** 服务日志环形缓冲的读口(serve 注入)。诊断包用它切最近日志;
   * 缺席时诊断包只是少一节,采集本身照常。 */
  recentLog?: () => string[];
}

export interface TaskCommandContainer {
  /** 真 Docker 后端在 start 后提供；测试/私有执行器可不实现。 */
  readonly metadata?: TaskContainerMetadata;
  readonly diagnostics?: { containerId?: string; phase: string };
  start(): Promise<void>;
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
  stop(): Promise<void>;
}

export interface TaskContainerFactoryInput {
  image: string;
  workspace: string;
  name: string;
  log?: (message: string) => void;
  volumes: string[];
  limits: TaskContainerLimits;
  options: TaskContainerOptions;
}

export type TaskContainerFactory = (
  input: TaskContainerFactoryInput,
) => TaskCommandContainer;

/** 最后兜底预算；同 SHA/同反馈版本无进展仍会更早停下。 */
export const DEFAULT_REPAIR_ROUNDS = 20;
function discussionKeyFromParts(id: string, revision?: number): string {
  return `${id}:r${revision ?? 0}`;
}

function discussionIdFromKey(key: string): string {
  return key.replace(/:r\d+$/, "");
}

function discussionRevisionFromKey(key: string): number {
  const matched = key.match(/:r(\d+)$/);
  return matched ? Number(matched[1]) : 0;
}

/** 小鲁班链接必须落到前端任务工作台，而不是 /tasks/:id 的 JSON API。
 * 身份只认登录会话，URL 只承载任务定位；每个任务因此也有可复制、
 * 可刷新、可从通知直接进入的稳定页面地址。 */
function personalTaskLink(
  linkBase: string | undefined,
  _account: string,
  taskId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/work/${encodeURIComponent(taskId)}`;
}

function reviewTaskLink(
  linkBase: string | undefined,
  taskId: string,
  reviewId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/work/${encodeURIComponent(taskId)}`
    + `/review/${encodeURIComponent(reviewId)}`;
}

export type SystemCheckStatus = "ok" | "warning" | "error";
export interface SystemCheckItem {
  key: string;
  label: string;
  status: SystemCheckStatus;
  detail: string;
  suggestion?: string;
}
export interface SystemCheckResult {
  checked_at: string;
  overall: SystemCheckStatus;
  items: SystemCheckItem[];
}

/** 自由需求原文 → 可扫读标题。它只是展示摘要,不改需求输入；按首个非空
 * 行截断,避免把一整段需求塞进团队列表。 */
function taskTitle(requirement: string): string {
  const first = requirement.split(/\r?\n/)
    .map((line) => line.trim()).find(Boolean) ?? "未命名任务";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** task.status 与 detail 必须描述同一个当下。AskUserQuestion 的完整结构
 * 已经在 waiting 中，这里只提取一行可扫读摘要；不能继续沿用启动、恢复
 * 或上一张卡的旧文案，否则页面会把活任务显示成仍在等待续跑。 */
function waitingTaskDetail(waiting: WaitingRecord | undefined): string {
  const raw = waiting?.question?.questions;
  const questions = Array.isArray(raw) ? raw : [];
  // 澄清卡是 Agent 处理检视意见时缺信息在问人,与"要不要通过"的确认卡
  // 是两回事,一行摘要就得分开说。
  const clarifying = waiting?.question?.purpose === "clarification";
  const first = questions.length && questions[0]
    && typeof questions[0] === "object"
    ? String((questions[0] as Record<string, unknown>).question ?? "")
      .replace(/\s+/g, " ").trim()
    : "";
  if (!first) {
    return clarifying ? "Agent 处理检视意见时缺少信息,等待你补充" : "Agent 正在等待你的决定";
  }
  const clipped = first.length > 120 ? `${first.slice(0, 119)}…` : first;
  return `${clarifying ? "Agent 需要补充信息" : "等待你回答"}：${clipped}`
    + (questions.length > 1 ? `（共 ${questions.length} 个问题）` : "");
}

/** 重启前发出、但很可能没送到模型的插话。
 *
 * 插话走 pi 的 steer,消息压在**进程内存**队列里,进程一死就没了;事件
 * 日志是唯一跨进程活下来的账。判据很朴素:最后一次 turn_finished 之后
 * 出现的插话,还没有任何一个回合消化过它。
 *
 * 取舍写在明处:回合跑到一半被杀时,已经送进上下文的那条也会被算成
 * "没送到",于是重建会话里出现两遍。**宁可重复也不能吞掉**——重复顶多
 * 让模型多确认一句,吞掉则是人说过的话凭空消失。
 *
 * 读不动就当没有(旁路一律 fail-open,绝不能挡住任务重建)。
 */
function undeliveredInterrupts(workspace: string): string[] {
  try {
    const events = new EventLog(join(workspace, "events.jsonl")).replay();
    let since = -1;
    events.forEach((event, at) => {
      if (event.kind === "turn_finished" || event.payload?.via === "continue_delivery") since = at;
    });
    return events.slice(since + 1)
      .filter((event) => event.kind === "user_message"
        && event.payload?.via === "interrupt")
      .map((event) => String(event.payload?.text ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 读取内核定义的 append-only build 观察事件。坏文件只影响这一行进度，
 * 不能拖住任务列表，更不能被 Cloud 当成第二套流程状态。 */
function latestBuildMilestone(text: string): TaskProgress["milestone"] {
  if (!text) return undefined;
  try {
    const rows = JSON.parse(text)?.events;
    if (!Array.isArray(rows)) return undefined;
    const row = [...rows].reverse().find((item) => item
      && typeof item === "object"
      && ["started", "completed", "blocked"].includes(String(item.event))
      && String(item.task_id ?? "").trim()
      && String(item.task_title ?? "").trim());
    if (!row) return undefined;
    return {
      task_id: String(row.task_id),
      title: String(row.task_title),
      event: String(row.event) as "started" | "completed" | "blocked",
      ...(String(row.reason ?? "").trim()
        ? { reason: String(row.reason).trim() } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface TaskState extends MrSamplingState {
  summary: TaskSummary;
  /** 持久化在 task.json 的内部台账；不属于流程状态，也不更新推进时间。 */
  tokenUsage: TokenUsageState;
  driver?: CloudSession;
  humanGate: HumanGate;
  /** 任务代码工作区(host 模式=仓库克隆目录),交付模块读内核状态用。 */
  cwd?: string;
  /** 活的通知记录:后台退避重试会原地更新,查询时投影最新事实。 */
  notifyRecord?: NotifyRecord;
  /** 催办账本:上次催办时内核停在哪一步 + 累计次数。
   * 同一步催过没动弹就不再催(催办只对"忘了继续"有效,
   * 对"推不动"无效);累计上限防对话式空转。 */
  nudgedStep?: string;
  nudgeCount?: number;
  /** 回合收口时检视意见还没处理完的催办账(内存态):同一批意见最多让原
   * 会话接着处理两次,催不动就按原路收口,由推送卡那道兜底再派一次。 */
  reviewProcessingNudge?: { key: string; count: number };
  /** 任务专属容器(隔离模式):随任务起,随收口停。人工等待期间保持
   * 原实例不动，保证 Agent 的 HOME、/tmp 与执行环境连续。 */
  container?: TaskCommandContainer;
  /** 容器该挂哪个目录。需求理解单挂 repositories/,普通单挂仓根。 */
  containerWorkspace?: string;
  /** 防御性重建的防重入:一个回合里并发的多条 Bash 只开一个容器。 */
  containerReopen?: Promise<TaskCommandContainer>;
  /** 合入监控环的防重入锁(内存态):一任务只挂一环。 */
  mergeWatchActive?: boolean;
  /** 同一次平台冲突只补充一次指令；门禁恢复后允许通知下一次冲突。 */
  conflictNotice?: string;
  deliveryActive?: boolean;
  /** 交付检查和后台监听可能同时看到合入，只允许一次停止 writer / close。 */
  mergeSettlement?: Promise<void>;
  transportActive?: Promise<NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>>;
  hostActionActive?: Promise<boolean>;
  /** 宿主操作期间暂停的原会话；不拥有工作区写权限，不持久化。 */
  retainedSession?: { driver: CloudSession; epoch: number; message?: string };
  mrCreateActive?: ReturnType<typeof createMergeRequest>;
  /** 人工关联最终 MR 时等已启动的内核初始化结束，再登记合入。 */
  kernelBootstrap?: Promise<string>;
  /** 流水线轮询按 SHA 防重入；新 SHA 可以立刻接棒，旧轮醒来后自退。 */
  pipelinePollSha?: string;
  pipelinePollEpoch?: number;
  /** 流水线证据核销重试的防重入锁。纯宿主 timer，不占 Agent 会话。 */
  evidenceRetryActive?: boolean;
  /** 红灯具体报错采集的防重入锁；与绿灯核销证据不是同一条链。 */
  repairEvidenceRetryActive?: boolean;
  deliveryRecoveryActive?: boolean;
  deliveryRecoveryDeadlineTimer?: ReturnType<typeof setTimeout>;
  /** 检视回复账本发送的单飞锁；恢复、交付与合入 watcher 共用。 */
  reviewOutboxFlush?: Promise<boolean>;
  /** 环境预热的防重入锁(内存态):一任务只跑一个预热专员。 */
  warmupActive?: boolean;
  /** 所有 push 入口共享同一个异步准备动作；避免恢复轮询与会话收口
   * 同时撞进来，为同一 HEAD 启两个编译 Agent。 */
  prepushActive?: Promise<boolean>;
  /** 启动恢复的防重锁。它覆盖 tryDeliver 进入 prepushActive 之前的异步
   * 对账窗口，避免两条恢复旁路同时看到“还没有在跑”而各起一轮。 */
  prepushRecoveryActive?: boolean;
  /** prepush 回合的宿主中断信号。Pi 的 abort 偶尔只回到 idle、没有让
   * 已返回给调用方的 turn Promise 收口；这条信号用于结束宿主等待，
   * 容器销毁仍是进程树终止的安全边界。 */
  prepushAbort?: AbortController;
  /** 已自动采集过诊断包的事故键(内存态)。同一事故只落一份,
   * 重复 persist 不刷屏;文件名里的 hash 负责跨重启去重。 */
  lastDiagnosticsKey?: string;
  /** 恢复标记:launch 走重建会话路径(不重克隆、内核 current 续跑)。 */
  resume?: boolean;
  /** 恢复期收到的人工决定:重建会话就绪后由 driver 补登记再续跑。 */
  pendingResume?: WaitingRecord;
  /** 已由内核接纳且严格写入 task.json 的用户介入 id；只供崩溃重放。 */
  appliedDeveloperInterventionId?: string;
  /** task.json 先隐藏、waiting.json 后作废的那一张旧卡。 */
  obsoleteDeveloperWaiting?: {
    waitingId: string;
    stateVersion: number;
  };
  /** 专项使命(修复环):下次会话的压轴指令,消费即清。
   * 要随 task.json 落盘——修复会话跑一半被重启,使命不能丢。 */
  mission?: string;
  /** 会话收口时的最后发言(内存态):修复会话不提交时它就是诊断,
   * halted 裁决把它带给人。不落盘——窗口极窄,时间线里也有原文。 */
  lastReply?: string;
  /** 避免列表轮询反复解析未变化的现场面板。 */
  progressPulse?: string;
  progressCache?: TaskProgress;
  /** 老任务旧词表脉冲只让内核重写一次;成不成都不再重试,避免每次
   * 轮询都拉一个内核子进程。 */
  pulseRefreshAttempted?: boolean;
  /** persist 用来识别真正的状态推进,避免普通元数据更新冒充进展。 */
  lastPersistedStatus?: TaskStatus;
  /** 每次取消/暂停/恢复都会换代。异步回调只允许修改启动时那一代，
   * 防止“取消后又被旧回调写成完成”。进程重启后旧 Promise 已不存在。 */
  controlEpoch: number;
  /** 用户主动召唤的旁路开发助手。它只在主任务 paused 时运行，不参与
   * 内核状态迁移；Promise 只代表当前一轮，ready 时会话和容器继续保留。 */
  assistantActive?: Promise<void>;
  /** 开发助手回合换代号。停止当前动作只终止旁路回合，不改主任务 epoch。 */
  assistantEpoch?: number;
  /** 暂停边界从 Pi 内存队列取回的主任务补充。恢复主会话前一直保留，
   * listInterrupts 也据此如实维持“待读取”。 */
  pendingMainSteers?: string[];
  /** 开发助手交还给重建主会话的一次性现场摘要。它不是内核证据；
   * 必须持久化，避免服务死在 resume→launch 之间把用户改动上下文丢掉。 */
  pendingAssistantHandoff?: string;
  /** 等人决定期间通过 @ 引用注入的知识正文(版本已在发送时固定)。
   * 随下一次决定的 notes 一并送达 Agent;必须持久化,否则重启会把
   * 人已经"说过"的引用悄悄吞掉。 */
  pendingDecisionKnowledge?: string[];
  /** 交付失败日志聚合:同一指纹只全文记一次,其后按计数聚合
   * (MFC-020:同文 MR-400 曾刷 86 条)。进程内即可,不持久化。 */
  deliveryFailureLog?: { fingerprint: string; count: number };
}

interface PrePushBuildWaiter {
  task: TaskState;
  epoch: number;
  resolve: (release: (() => void) | undefined) => void;
}

interface PipelineAttestation {
  verdict: string;
  sha?: string;
  reason?: string;
  checks?: Record<string, unknown>;
}

interface UserInterventionReconciliation {
  id: string;
  changed: boolean;
  from: string;
  target: string;
}

interface GitPushReceipt {
  sha: string;
  ref: string;
  remote: string;
  url?: string;
}

interface RepositorySkillCatalogTicket {
  account?: string;
  repositories: string[];
  baseline?: string;
  expiresAt: number;
  catalogs: RepositorySkillCatalog[];
}

export interface RepositorySkillCatalogResponse {
  catalog_token: string;
  repositories: RepositorySkillCatalog[];
}

export interface RepositoryProbeResult {
  repository: string;
  reachable: boolean;
  message: string;
}

export interface RepositoryProbeResponse {
  repositories: RepositoryProbeResult[];
}

/** 所有审批入口共用的决定契约。
 *
 * selected_options 只承载内核选项原文；free_responses 承载开放题答案或
 * 选择题的补充说明，永远不参与流程分支匹配。decision/answers/notes 仅
 * 保留给旧调用方兼容，进入 HumanGate 前仍会执行同样的菜单校验。 */
export type DeliveryCompileAction = "rerun" | "skip";

export interface DecisionSubmission {
  /** 页面看到的待办身份。只靠 state_version=1 无法区分两张先后生成的
   * 卡，也无法在任务概要已推进后识别同一次网络重试。 */
  waiting_id?: string;
  state_version: number;
  selected_options?: Record<string, string>;
  free_responses?: Record<string, string>;
  comment?: string;
  decision?: string;
  answers?: Record<string, string>;
  notes?: string;
  annotation_ids?: string[];
  repository_skill_catalog_token?: string;
  selected_repository_skill_ids?: string[];
  /** Chain 确认与逐仓委派同一次乐观锁提交，键是需求图 repository.id。 */
  repository_assignees?: Record<string, string>;
  /** Chain 拆单时逐仓固定的 AR/REQ 单号；默认值由页面带入父任务单号。 */
  repository_tickets?: Record<string, string>;
  /** 兼容旧客户端请求去重；不再按路径选择修改提交。 */
  delivery_paths?: string[];
  /** 兼容旧客户端请求去重；不再根据文件选择发起编译。 */
  delivery_compile_action?: DeliveryCompileAction;
  /** 操作人(HTTP 层从登录会话注入,自动交卷不填)。只入审计账,
   * 不参与请求指纹——同内容的网络重试无论谁发都幂等。 */
  actor?: string;
}

/** push 前确认卡的云端原生步骤名与选项原文。步骤不在内核流程里,
 * stepReviewSurface 对未知步骤默认给 "diff"，只读展示实际改动。 */
const CLOUD_PUSH_CONFIRM_STEP = "cloud_push_confirm";
const PUSH_CONFIRM_ACCEPT = "确认推送";
const PUSH_CONFIRM_REWORK = "需要调整代码";
/** 新下单进入需求分析前的显式人工边界。它是 Cloud 入口闸门，不属于
 * 内核步骤：确认前只由文档 Agent 按意见改正本，不启动正式执行会话；
 * 确认后才入队。 */
const CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP =
  "cloud_requirement_analysis_confirm";
/** Agent 提议拆分的决定卡:Cloud 自己的步骤,不在内核流程里。人有最后一票
 * ——选「不拆」编码会话原地继续,零成本;选拆才转身成分析单。 */
const CLOUD_SPLIT_PROPOSAL_STEP = "cloud_split_proposal";
/** "这批还没人处理"与"回执不合格"是两回事。批次刚登记就被重启/异常打断
 * 时 Agent 一次都没跑过,回执文件当然不存在——那不该报"Agent 没有留下
 * 回执"再停摆等人(内网 task-38 实锤:12:29 建 build_fix 批次、12:48 部署
 * 重启,Agent 从没被拉起来,恢复时直接判停摆)。带这个前缀的原因表示
 * "尚未处理",恢复路径据此重新派单;Agent 刚跑完一轮却没写的那条路径
 * 不看前缀,照旧自动补交一次。 */

const SPLIT_PROPOSAL_ACCEPT = "先分析再拆分";
const SPLIT_PROPOSAL_DECLINE = "不拆，一个任务干完";
const REQUIREMENT_ANALYSIS_ACCEPT =
  "需求已确认，进入需求分析";

export class TaskService {
  private readonly displayEvents = new DisplayEventReader({ log: message => this.options.log?.(message) });

  async readDisplayEvents(id: string): Promise<SemanticEvent[]> {
    if (!this.tasks.has(id)) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.displayEvents.read(this.eventLogPath(id));
  }

  async activityAsync(id: string) { return this.activity(id, await this.readDisplayEvents(id)); }
  async conversationAsync(id: string) { return this.conversation(id, await this.readDisplayEvents(id)); }
  async listInterruptsAsync(id: string) { return this.listInterrupts(id, await this.readDisplayEvents(id)); }
  async developerAssistantAsync(id: string) { return this.developerAssistant(id, await this.readDisplayEvents(id)); }
  /** 没有部署级 public URL 时，记住最近一次已登录用户实际访问的地址。
   * 通知由该次请求触发时即可带上同事能访问的内网 Host，而不是回环地址。 */
  private observedLinkBase?: string;
  private tasks = new Map<string, TaskState>();
  private requirementGraphCorrections = new Map<string, { count: number; fingerprints: Set<string> }>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;
  /** 编译槽与普通 Agent 并发彻底分账。槽位释放才唤醒下一单，等待者
   * 仍保留在任务现场里，可暂停/取消，不靠不可见的 Promise 排队。 */
  private activePrePushBuilds = 0;
  private prePushBuildQueue: PrePushBuildWaiter[] = [];
  /** 所有已创建且尚未确认删除的容器。任务字段只指向“当前”一个，
   * 这个集合还能覆盖 system-check 与正在 finally 清理的旧 attempt。 */
  private activeContainers = new Set<TaskCommandContainer>();
  private activeContainerContexts = new Map<TaskCommandContainer, {
    name: string;
    image: string;
    role: string;
    taskId: string;
    cacheKeys: string[];
  }>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private reviews: ReviewStore;
  private repositorySkillCatalogs =
    new Map<string, RepositorySkillCatalogTicket>();
  /** 逐任务决定锁：处理决定含异步操作，两次点击可能在真正落锁前
   * 同时越过校验。相同请求共享结果，不同请求仍由先到决定语义拒绝。 */
  private activeDecisions = new Map<string, {
    waitingId: string;
    digest: string;
    promise: Promise<TaskSummary>;
  }>();
  /** 原位重跑与彻底删除共享同一把逐任务锁，防止两个破坏性请求在
   * projection await 期间都拿着旧 TaskState 继续执行。 */
  private historyMutationActive = new Set<string>();
  private readonly finalMrSamples = new FinalMrSamples<TaskState>({
    current: task => !this.shuttingDown && this.tasks.get(task.summary.id) === task,
    platformUrl: () => this.effectivePlatformUrl(),
    settings: task => ({ credential: this.options.gitCredential?.(task.summary.luban_account),
      dataDir: this.options.dataDir, log: this.options.log }),
    detail: (task, url) => this.readFinalMr(task, url),
    save: task => this.writeTaskState(task),
    sampled: task => this.considerDeliveryImprovement(task),
    background: (task, description, work) => this.bypass(task, description, work),
  });
  /** 每次体积扫描都可能很重；自动回收与管理员手动回收不许重叠。 */
  private buildCacheReclaimActive = false;
  /** 平台探测是异步的，launchOptions 只消费最近一次事实。serve 在开放
   * HTTP 前先探一次，管理页每次“重新检查”都会刷新。 */
  private deliveryPlatformCheck?: DeliveryPlatformCheck;
  private activeSystemCheck?: Promise<SystemCheckResult>;
  private systemCheckTrace?: SystemCheckTrace;

  private readonly deliveryExperiences = new DeliveryExperiences<TaskState>(task => ({
    store: this.memories(), repo: this.memoryRepo(task),
    module: (task.summary.business_module ?? this.tasks.get(task.summary.parent_task_id ?? "")?.summary.business_module)?.id,
    model: this.sessionModels(task), onTokenUsage: sample => this.recordTaskTokenUsage(task, sample), log: this.options.log, onPublished: () => { task.summary.memories_recorded = this.memories().list({ task: task.summary.id }).length; this.persist(task); },
    evidence: () => [
      ...this.annotations(task).list().map(row => ({ ...row, id: `annotation:${row.id}` })),
      ...new FeedbackStore(join(task.summary.workspace, "feedback/index.jsonl")).list().map(row => ({ ...row, id: `feedback:${row.id}` })),
    ],
    notify: async (count, firstId) => {
      if (!this.options.notifier || !task.summary.luban_account) return;
      await this.options.notifier.notifyOutcome({ taskId: task.summary.id, account: task.summary.luban_account,
        status: "交付后经验草稿已生成", summary: `本次交付整理出 ${count} 条经验草稿，请尽快审核内容与适用范围，可修改后决定哪些采纳入库。`,
        link: `${(this.notificationLinkBase() ?? "").replace(/\/$/, "")}/?kbPage=experience&memory_id=${firstId}&source_task=${task.summary.id}` });
    },
  }));
  private readonly deliverySummaries = new DeliverySummaries<TaskState>(task => ({
    notifier: this.options.notifier, taskLink: personalTaskLink(this.notificationLinkBase(), task.summary.luban_account ?? "", task.summary.id),
    model: this.sessionModels(task), onTokenUsage: sample => this.recordTaskTokenUsage(task, sample), log: this.options.log, onPublished: () => this.persist(task),
  }));
  private readonly deliveryImprovements = new DeliveryImprovements<TaskState>(task => ({
    dataDir: this.options.dataDir, kernelRoot: this.options.host?.kernelRoot,
    model: this.sessionModels(task), onTokenUsage: sample => this.recordTaskTokenUsage(task, sample), log: this.options.log,
    vision: this.taskVision(task), knowledgeHistory: () => memoryFeedbackEvidence(task.summary.workspace, this.memories()),
    platformContext: () => ({ runtime_overrides: this.options.settings?.runtime(), execution_policy: this.options.settings?.executionPolicy(),
      warmup_enabled: this.options.warmup?.enabled === true, prepush_enabled: this.options.prepush?.enabled === true,
      prepush_build_slots: this.options.prepush?.buildSlots,
      repair_rounds: this.options.delivery?.repairRounds, poll_interval_ms: this.options.delivery?.pollIntervalMs,
      poll_timeout_ms: this.options.delivery?.pollTimeoutMs, continuous_review: this.options.host?.continuousReview }),
    related: [...this.tasks.values()].filter(other => other.summary.id === task.summary.parent_task_id
      || other.summary.parent_task_id === task.summary.id
      || (!!task.summary.parent_task_id && other.summary.parent_task_id === task.summary.parent_task_id)
      || task.summary.blocked_by?.includes(other.summary.id)),
  }));
  readonly overallStories: OverallStoryCoordinator<TaskState>;

  constructor(readonly options: TaskServiceOptions) {
    this.overallStories = new OverallStoryCoordinator<TaskState>({
      autoArchitecture: this.options.autoArchitecture,
      task: (id) => this.tasks.get(id),
      log: (message) => this.options.log?.(message),
      artifactRoot: (id) => this.artifactRoot(id),
      published: (task, content, revision) => this.syncPublishedStory(task, content, revision),
      ready: () => {
        if (!this.options.host?.kernelRoot || !this.activeModelChoice()) {
          throw new TaskControlError("模型或内核 Story 模板未配置，暂时无法生成整体 Story");
        }
      },
      run: (task, job) => {
        const modelBundle = this.sessionModels(task, "auto");
        return runOverallStorySession(task, job, {
          taskId: task.summary.id, workspace: task.summary.workspace,
          kernelRoot: this.options.host!.kernelRoot, requirementDocument: task.summary.requirement_document,
          model: modelBundle.choice!, models: modelBundle.json,
          vision: this.taskVision(task), onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
          log: this.options.log,
        });
      },
    });
    // 只从本次启用之后的完成交付开始自动分析，不批量补跑旧任务。
    try { initializeImprovementPolicy(options.dataDir); } catch (error) { options.log?.(`自动交付分析设置未保存：${String(error)}`); }
    this.knowledgeTaskCapacity.register(() => this.extractionRunning.size, () => this.pumpSkillExtraction());
    this.reviews = new ReviewStore(join(options.dataDir, "reviews.jsonl"),
      (id) => isReviewTaskEnded(this.tasks.get(id)?.summary.status));
    if (options.memory) {
      // 旁路:起不来只记日志,任务照跑;首次真用时再等 ready。
      this.memorySidecar = new MemorySidecar({
        python: options.memory.python,
        script: options.memory.script,
        corpusDir: join(options.dataDir, "corpus"),
        milvusPath: options.memory.milvusPath,
        provider: options.memory.provider,
        model: options.memory.model,
        env: options.memory.env,
        log: options.log,
      });
      void this.memorySidecar.start().then((ok) => {
        options.log?.(ok ? "任务记忆检索旁路已就绪" : "任务记忆检索旁路未就绪,开局推送退回索引级");
        if (ok) this.prepareKnowledgeIndex();
      });
    }
    // 沉底扫描(§6):起服务后稍等一会儿做一次,之后每天一次。旁路,
    // 失败只记日志;只碰一年以上从未用过、或失锚半年以上的记录。
    this.memorySweepTimer = setTimeout(() => {
      this.sweepMemoryArchive();
      this.memorySweepTimer = setInterval(() => this.sweepMemoryArchive(), 24 * 3_600_000);
      this.memorySweepTimer.unref?.();
    }, 30_000);
    this.memorySweepTimer.unref?.();
    // 被彻底删除的最高编号不能在重启后复用；否则旧通知/浏览器收藏会
    // 悄悄指向一张毫不相关的新任务。水位单独留在 dataDir，不属于任
    // 何任务历史，因此硬删除不会碰它。
    try {
      const value = Number(readFileSync(
        join(options.dataDir, ".task-sequence"), "utf-8").trim());
      if (Number.isSafeInteger(value) && value >= 0) this.counter = value;
    } catch {
      // 旧部署没有水位文件；recover 会从仍在盘上的 task-N 补出起点。
    }
    // 桌面通知只有 serve --desktop-notify 显式要了才开(它会设
    // MAE_FLOW_DESKTOP_NOTIFY);其余一切宿主进程——测试、probe、pilot——
    // 一律静音。少了这道闸,npm test 拉起真内核当裁判时会把用户的 mac
    // 弹一串"需要你确认"(实锤弹过);环境变量随子进程继承,一处设置全链生效。
    if (!process.env.MAE_FLOW_DESKTOP_NOTIFY) {
      process.env.MAE_FLOW_NO_NOTIFY ??= "1";
    }
    // 服务启动即接续研究与平台发布，不等待用户首次打开知识页面。
    this.getDomainKnowledgeExtraction();
    this.getComponentResearch().recoverPublications();
    this.bypass(undefined, "Skill 审核恢复", recoverSkillSubmissions(options.dataDir, this.skillRecoveryWarnings));
    this.knowledgeRepositoryTimer = setTimeout(() => {
      this.refreshKnowledgeRepositories();
      this.knowledgeRepositoryTimer = setInterval(() => this.refreshKnowledgeRepositories(), 60_000);
      this.knowledgeRepositoryTimer.unref?.();
    }, 5_000);
    this.knowledgeRepositoryTimer.unref?.();
  }

  async refreshDeliveryPlatformCheck(): Promise<DeliveryPlatformCheck | undefined> {
    const platform = this.effectivePlatformUrl();
    if (!platform) {
      this.deliveryPlatformCheck = undefined;
      return undefined;
    }
    this.deliveryPlatformCheck = await probeDeliveryPlatform(platform);
    return this.deliveryPlatformCheck;
  }

  observeLinkBase(base: string | undefined): void {
    if (this.options.linkBase || !base) return;
    // 回环地址永不入账:它只对本机成立,发给别人就是死链(内网实锤:
    // 邀请检视的链接是 127.0.0.1)。管理员在服务器本机或经 SSH 隧道
    // (Host 就是 127.0.0.1)登录一次,不该把全体人的通知地址带沟里——
    // 学过的可用地址也不许被回环访问冲掉。
    try {
      const host = new URL(base).hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1"
          || host === "::1" || host === "[::1]") {
        return;
      }
    } catch {
      return;   // 解析不了的地址不入账
    }
    this.observedLinkBase = base.replace(/\/+$/, "");
  }

  private notificationLinkBase(): string | undefined {
    return this.options.linkBase ?? this.observedLinkBase;
  }

  private createTaskContainer(
    input: TaskContainerFactoryInput,
  ): TaskCommandContainer {
    if (this.shuttingDown) {
      throw new Error("服务正在关闭，拒绝创建新的任务容器");
    }
    const instance = taskContainerInstance(this.options.dataDir);
    const ownedInput: TaskContainerFactoryInput = {
      ...input,
      options: {
        ...input.options,
        runner: input.options.runner ?? this.options.isolation?.runner,
        labels: {
          ...(input.options.labels ?? {}),
          // 完整 dataDir 指纹是跨重启 ownership；短名字只供人辨认。
          "com.mae-flow-cloud.instance": instance.fingerprint,
        },
      },
    };
    const created = this.options.isolation?.containerFactory?.(ownedInput)
      ?? new TaskContainer(
        ownedInput.image,
        ownedInput.workspace,
        ownedInput.name,
        ownedInput.log,
        ownedInput.volumes,
        ownedInput.limits,
        ownedInput.options,
      );
    const service = this;
    let startPromise: Promise<void> | undefined;
    const tracked: TaskCommandContainer = {
      get metadata() { return created.metadata; },
      get diagnostics() { return created.diagnostics; },
      start: async () => {
        if (service.shuttingDown) {
          await created.stop();
          service.activeContainers.delete(tracked);
          service.activeContainerContexts.delete(tracked);
          throw new Error("服务正在关闭，拒绝启动新的任务容器");
        }
        if (!startPromise) {
          const attempt = Promise.resolve().then(() => {
            // Root 守护进程 + 非 root 容器时，clone、内核 bootstrap 和
            // 宿主文件工具留下的是 root 属主。必须在真正 docker run 前
            // 统一交给容器用户；只在 clone 后做一次会漏掉随后生成的
            // .mae-flow 状态，靠 umask 0000 又会把现场开放给所有用户。
            const prepared = prepareContainerHostPaths({
              log: message => service.options.log?.(`${message} container=${ownedInput.name}`),
              workspace: ownedInput.workspace,
              volumes: ownedInput.volumes,
              user: ownedInput.limits.user,
              cacheRoot: service.options.isolation?.cacheRoot,
              markerRoot: join(
                service.options.dataDir, ".container-ownership"),
            });
            if (prepared.active
                && (prepared.workspaceEntries || prepared.cacheTrees)) {
              service.options.log?.(
                `[container-ownership] ${ownedInput.name}: `
                + `workspace=${prepared.workspaceEntries},`
                + `cache-trees=${prepared.cacheTrees},`
                + `owner=${prepared.owner!.uid}:${prepared.owner!.gid}`,
              );
            }
            return created.start();
          });
          startPromise = attempt.then(async () => {
            // docker run/inspect 在 await 期间收到 SIGTERM：容器可能刚刚
            // 出现。必须先确认删除，再让 start 以关闭错误返回。
            if (service.shuttingDown) {
              await created.stop();
              service.activeContainers.delete(tracked);
              service.activeContainerContexts.delete(tracked);
              throw new Error("服务关闭期间任务容器完成启动，已立即回收");
            }
          }).finally(() => { startPromise = undefined; });
        }
        return startPromise;
      },
      exec: (command, cwd, options) => {
        if (service.shuttingDown) {
          return Promise.reject(new Error(
            "服务正在关闭，拒绝向任务容器下发新的命令"));
        }
        return created.exec(command, cwd, options);
      },
      stop: async () => {
        // 不与 docker run/inspect 对冲；让启动动作先取得明确结果，再按
        // ownership 执行 TERM→KILL→rm。否则可能“先查不存在、后 run 出来”。
        if (startPromise) await startPromise.catch(() => undefined);
        await created.stop();
        service.activeContainers.delete(tracked);
        service.activeContainerContexts.delete(tracked);
      },
    };
    this.activeContainers.add(tracked);
    const cacheKeys = [...new Set(ownedInput.volumes
      .map((volume) => volume.split(":")[0])
      .map((source) => service.options.isolation?.cacheRoot
        ? cacheKeyFromPath(service.options.isolation.cacheRoot, source)
        : undefined)
      .filter((key): key is string => !!key))];
    this.activeContainerContexts.set(tracked, {
      name: ownedInput.name,
      image: ownedInput.image,
      role: ownedInput.options.labels?.["com.mae-flow-cloud.role"] ?? "unknown",
      taskId: ownedInput.options.labels?.["com.mae-flow-cloud.task"] ?? "system",
      cacheKeys,
    });
    return tracked;
  }

  /**
   * 起一个普通编码任务容器并等它就绪。
   *
   * 抽出来让会话开场与活会话缺失容器时的防御性重建共用同一套挂载、
   * 限额与 label，不能在恢复路径上悄悄换掉隔离参数。
   */
  private async startCodingContainer(
    task: TaskState,
    safety: {
      gitReadOnly?: boolean;
      /** 主任务的流水线修复会话需要通过 Bash 读取 ../pipeline/。默认
       * 开启；开发助手等旁路角色必须显式关闭，不能顺手获得任务材料。 */
      pipelineArtifacts?: boolean;
      /** 主任务需要通过 Bash 读取批注、写逐条回执。只挂任务自己的
       * reviews 子目录，不暴露 task.json/pi-agent 等宿主控制数据。 */
      reviewMaterials?: boolean;
    } = {},
  ): Promise<TaskCommandContainer> {
    const isolation = this.options.isolation;
    if (!isolation) throw new Error("未配置任务容器隔离");
    const cwd = task.containerWorkspace;
    if (!cwd) throw new Error("任务容器工作区未知，拒绝按猜测挂载");
    const {
      image, volumes, memory, cpus, user, pidsLimit, labels,
      readOnlyRoot, tmpfsHome, tmpfsTmp, network,
      forwardEnvironment, stopGraceSeconds, managementTimeoutMs,
    } = isolation;
    // 容器名带数据目录指纹:同 dataDir 重启后同名(孤儿可清扫),
    // 不同实例(测试与试跑并行)绝不同名——只按任务 id 命名时,
    // 另一实例的 rm -f 会把这边活着的容器当孤儿误杀(实测:
    // run7 续跑期间并行跑隔离测试,容器被杀,模型如实报告
    // "执行容器丢失",整单被迫收口)。
    const instance = taskContainerInstance(this.options.dataDir).namePrefix;
    // host 模式的两条硬依赖也要进容器:内核插件根(转发壳硬编码
    // 其绝对路径,只读)与 Git 远端——但只有本地路径仓(演示裸仓)
    // 才需要挂载;URL 仓走网络,拿路径当挂载参数只会喂 docker 垃圾。
    const effectiveRepo =
      task.summary.repo_url ?? this.effectiveDefaultRepo();
    const analysisOnly = this.isRequirementAnalysis(task);
    const hostMounts = this.options.host && !analysisOnly
      ? [
          `${this.options.host.kernelRoot}:${this.options.host.kernelRoot}:ro`,
          ...(effectiveRepo && existsSync(effectiveRepo)
            // 本地裸仓只供演练/离线环境读取。Agent 的 push 已由宿主
            // 统一执行，不能因“这是本地路径”就把远端仓 RW 交给容器。
            ? [`${effectiveRepo}:${effectiveRepo}:ro`] : []),
        ]
      : [];
    // 需求分析只读候选仓。即便模型忽略提示词或通过 Bash 绕过文件工具，
    // 也不能在候选仓里 init、改业务代码或生成内核状态；内核目录本身
    // 也不会挂进这类容器。
    const analysisRepositoryMounts = analysisOnly
      ? (task.summary.repositories ?? []).map((repository, index) => join(cwd,
          `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`))
        .filter((path) => existsSync(path))
        .map((path) => `${path}:${path}:ro`)
      : [];
    const gitPath = join(cwd, ".git");
    const pipelineArtifacts = resolve(task.summary.workspace, "pipeline");
    const mountPipelineArtifacts = safety.pipelineArtifacts ?? true;
    const prepushArtifacts = resolve(task.summary.workspace, "prepush");
    if (mountPipelineArtifacts) {
      // 容器通常早于首轮权威流水线启动。bind 源必须现在就存在，后续
      // mirrorPipelineArtifacts 只原地刷新内容，运行中的容器即可看到。
      mkdirSync(pipelineArtifacts, { recursive: true });
      mkdirSync(prepushArtifacts, { recursive: true });
    }
    const reviewMaterials = resolve(task.summary.workspace, "reviews");
    const mountReviewMaterials = safety.reviewMaterials ?? true;
    if (mountReviewMaterials) {
      mkdirSync(reviewMaterials, { recursive: true });
      // Linux root 守护进程会把代码仓交给非 root 容器用户；reviews 是
      // 独立 bind，不能漏掉同一份属主交接，否则 rw 挂载仍会 EACCES。
      const prepared = prepareContainerHostPaths({
        workspace: reviewMaterials,
        volumes: [],
        user,
        markerRoot: join(this.options.dataDir, ".container-ownership"),
      });
      if (prepared.active && prepared.workspaceEntries) {
        this.options.log?.(
          `[container-ownership] ${task.summary.id}: reviews=`
          + `${prepared.workspaceEntries},owner=${prepared.owner!.uid}:`
          + `${prepared.owner!.gid}`);
      }
    }
    // feedback/ 同时保存宿主可信索引，绝不能像 reviews 一样整目录
    // 交给 Agent。当前活跃批次若需要机器回执，只预建、交接并挂载那
    // 一枚 result 文件；旧任务 mission 中的 ../feedback/result-* 路径
    // 因此也能在升级后原样续跑。
    const reviewReplies = mountReviewMaterials
      ? prepareReviewReplyFile(task.summary.workspace, user) : undefined;
    const feedbackResult = this.activeFeedbackResult(task);
    if (feedbackResult) this.prepareFeedbackResultFile(task, feedbackResult.path);
    const mounts = await this.taskContainerMounts(task, [
      ...hostMounts,
      ...analysisRepositoryMounts,
      ...(volumes ?? []),
      ...(mountPipelineArtifacts
        ? [`${pipelineArtifacts}:${pipelineArtifacts}:ro`,
          `${prepushArtifacts}:${prepushArtifacts}:ro`] : []),
      // 兼容测试和旧现场直接把任务根当 cwd 的形态：主工作区挂载已经
      // 包含 reviews，不重复覆盖隔离关键目录。正式任务 cwd 是仓库子目录，
      // 因而这里只额外挂入一个任务专属的小目录。
      ...(mountReviewMaterials && resolve(cwd) !== resolve(task.summary.workspace)
        ? [`${reviewMaterials}:${reviewMaterials}:rw`] : []),
      ...(reviewReplies && resolve(cwd) !== resolve(task.summary.workspace)
        ? [`${reviewReplies}:${reviewReplies}:rw`] : []),
      ...(feedbackResult
        ? [`${feedbackResult.path}:${feedbackResult.path}:rw`] : []),
      ...(safety.gitReadOnly && existsSync(gitPath)
        ? [`${gitPath}:${gitPath}:ro`] : []),
    ]);
    const container = this.createTaskContainer({
      image,
      workspace: cwd,
      name: `mfc-${instance}-${task.summary.id}`,
      log: this.options.log,
      volumes: mounts.volumes,
      limits: { memory, cpus, user, pidsLimit },
      options: {
        labels: {
          ...(labels ?? {}),
          "com.mae-flow-cloud.task": task.summary.id,
          "com.mae-flow-cloud.role": "coding",
        },
        readOnlyRoot,
        tmpfsHome,
        tmpfsTmp,
        network,
        environment: mounts.environment,
        forwardEnvironment,
        stopGraceSeconds,
        managementTimeoutMs,
      },
    });
    await container.start();
    return container;
  }

  /**
   * 取得可用的任务容器:正常会话始终复用原实例；句柄异常缺失时才
   * 防御性重建。人工等待本身绝不走这里的重建分支。
   *
   * 开不起来一律抛给调用方 → 变成这条 Bash 的执行失败。这里绝不
   * 能退回宿主执行:那是"要隔离就真隔离"红线的正面。
   */
  private async activeTaskContainer(
    task: TaskState,
  ): Promise<TaskCommandContainer> {
    if (this.shuttingDown || task.summary.delivery?.final_mr || ["canceled", "paused", "pausing"].includes(task.summary.status))
      throw new TaskControlError("任务已停止，不再启动或使用执行容器");
    if (task.container) return task.container;
    const epoch = task.controlEpoch;
    if (!task.containerReopen) {
      // 重开是异步的,期间用户完全可能按下暂停/取消——那条路径刚
      // 停完容器就把 task.container 置空,我们再挂一个上去就是无主
      // 泄漏。拿 epoch 当凭证:换了就地自毁,不往任务上挂。
      task.containerReopen = this.startCodingContainer(task)
        .then(async (container) => {
          if (!this.current(task, epoch)) {
            await container.stop().catch(() => undefined);
            throw new Error("任务容器重开期间任务已暂停或取消，已就地回收");
          }
          if (task.container) {
            await container.stop().catch(() => undefined);
            return task.container;
          }
          task.container = container;
          this.options.log?.(
            `任务 ${task.summary.id} 收到新命令,任务容器已重新开起`);
          return container;
        })
        .finally(() => { task.containerReopen = undefined; });
    }
    return task.containerReopen;
  }

  /** recover 前调用：只清扫完整 dataDir ownership 指纹匹配的遗留容器。 */
  async sweepOrphanContainers(): Promise<{ found: number; removed: string[] }> {
    const isolation = this.options.isolation;
    if (!isolation) return { found: 0, removed: [] };
    const instance = taskContainerInstance(this.options.dataDir);
    return sweepManagedTaskContainers({
      instanceFingerprint: instance.fingerprint,
      namePrefix: instance.namePrefix,
      legacyIssueRoot: join(this.options.dataDir, "issues"),
      stopGraceSeconds: isolation.stopGraceSeconds,
      managementTimeoutMs: isolation.managementTimeoutMs,
      runner: isolation.runner,
      log: this.options.log,
    });
  }

  /**
   * 进程级优雅关闭。只换掉内存 epoch、停调度并释放资源，不改写任务
   * 业务状态；下次启动仍由 recover 按原来的 task.json 续跑。
   */
  async shutdown(): Promise<void> {
    clearTimeout(this.knowledgePrepareTimer);
    clearTimeout(this.knowledgeRepositoryTimer);
    this.memorySidecar?.stop();
    if (this.memorySweepTimer) clearTimeout(this.memorySweepTimer);
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const task of this.tasks.values()) clearTimeout(task.deliveryRecoveryDeadlineTimer);
    for (const sync of this.knowledgeRepositorySyncs.values()) sync.abort.abort(new Error("服务正在停止，知识同步可在重启后接续"));
    this.shutdownPromise = (async () => {
      this.queue = [];
      const waiters = this.prePushBuildQueue.splice(0);
      for (const waiter of waiters) waiter.resolve(undefined);

      const drivers = new Map<CloudSession, string>();
      const backgroundWork: Array<{
        taskId: string;
        role: string;
        work: Promise<unknown>;
      }> = [{ taskId: "delivery-improvement", role: "交付改进分析", work: this.deliveryImprovements.shutdown() }, { taskId: "delivery-experience", role: "交付经验", work: this.deliveryExperiences.shutdown() }, { taskId: "delivery-summary", role: "交付报告", work: this.deliverySummaries.shutdown() }, { taskId: "overall-story", role: "整体 Story", work: this.overallStories.shutdown() },
        { taskId: "domain-extraction", role: "领域知识萃取", work: this.domainKnowledgeExtraction?.shutdown() ?? Promise.resolve() },
        { taskId: "component-research", role: "组件知识萃取", work: this.componentResearch?.shutdown() ?? Promise.resolve() },
        { taskId: "knowledge-answers", role: "知识问答", work: this.knowledgeAnswers?.shutdown() ?? Promise.resolve() },
        ...[...this.knowledgeRepositorySyncs].map(([id, sync]) => ({ taskId: id, role: "知识仓同步", work: sync.work }))];
      for (const task of this.tasks.values()) {
        discardRetainedSession(task);
        if (task.finalMrAnalysis?.running) backgroundWork.push({ taskId: task.summary.id, role: "最终 MR 代码对比", work: task.finalMrAnalysis.work });
        // 旧回调即使稍后返回，也不能在关机窗口改写业务状态。
        task.controlEpoch += 1;
        task.assistantEpoch = (task.assistantEpoch ?? 0) + 1;
        task.prepushAbort?.abort();
        backgroundWork.push({ taskId: task.summary.id, role: "auxiliary", work: abortAuxiliarySessions(task) });
        task.prepushAbort = undefined;
        if (task.driver) drivers.set(task.driver, task.summary.id);
        task.driver = undefined;
        task.container = undefined;
        if (task.prepushActive) {
          backgroundWork.push({
            taskId: task.summary.id,
            role: "prepush",
            work: task.prepushActive,
          });
        }
        if (task.reviewOutboxFlush) {
          // 回复请求已经可能到达外部平台，不能在 shutdown 返回后仍让
          // 旧进程追加账本/持久化，与随后启动的新进程恢复链并发。
          backgroundWork.push({
            taskId: task.summary.id,
            role: "review-outbox",
            work: task.reviewOutboxFlush,
          });
        }
        if (task.assistantActive) {
          interruptDeveloperAssistant(
            task.summary.workspace,
            "服务关闭中断了本轮开发助手，可在重启后重新发起",
          );
          backgroundWork.push({
            taskId: task.summary.id,
            role: "developer-assistant",
            work: task.assistantActive,
          });
        }
      }

      const cleanup: Array<{ label: string; work: Promise<unknown> }> = [];
      for (const [driver, taskId] of drivers) {
        cleanup.push({ label: `phase=abort-session task=${taskId}`,
          work: driver.abort() });
      }
      for (const container of this.activeContainers) {
        const metadata = container.metadata;
        const planned = this.activeContainerContexts.get(container);
        const role = metadata?.labels["com.mae-flow-cloud.role"]
          ?? planned?.role ?? "unknown";
        const taskId = metadata?.labels["com.mae-flow-cloud.task"]
          ?? planned?.taskId ?? "system";
        const name = metadata?.name ?? planned?.name ?? "unknown";
        const id = metadata?.containerId.slice(0, 12) ?? "unknown";
        const image = metadata?.immutableImageReference
          ?? planned?.image ?? "unknown";
        const label = `phase=remove-container role=${role} task=${taskId}`
          + ` name=${name} id=${id} image=${image}`;
        this.options.log?.(`服务关闭 ${label}`);
        cleanup.push({ label, work: container.stop() });
      }
      for (const background of backgroundWork) {
        cleanup.push({
          label: `phase=await-${background.role} task=${background.taskId}`,
          work: background.work,
        });
      }
      const contextual = cleanup.map(({ label, work }) => work.catch((cause) => {
        throw new Error(`${label}: ${String(cause)}`, { cause });
      }));
      const settled = await Promise.allSettled(contextual);
      for (const driver of drivers.keys()) driver.dispose();
      this.activePrePushBuilds = 0;
      const failures = settled
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => item.reason);
      if (failures.length) {
        throw new AggregateError(failures,
          `服务关闭时有 ${failures.length} 项资源未能确认释放: `
            + failures.map(String).join(" | "));
      }
      this.options.log?.(`服务关闭完成: ${cleanup.length} 项会话/容器资源已释放`);
    })();
    return this.shutdownPromise;
  }

  private async taskContainerMounts(
    task: TaskState,
    volumes: string[],
  ): Promise<{ volumes: string[]; environment: NodeJS.ProcessEnv }> {
    const repository = task.summary.repo_url
      ?? this.effectiveDefaultRepo()
      ?? task.cwd
      ?? task.summary.id;
    const root = dirname(resolve(task.cwd ?? task.summary.workspace));
    const environment: NodeJS.ProcessEnv = {};
    if (isMaeRepository(repository) && !this.isRequirementAnalysis(task)) {
      environment.MFC_MAE_BUILD_ROOT = root;
      environment.MFC_MAE_BASELINE = task.summary.baseline ?? "";
      const sandbox = this.prepareHostGitSandbox(this.options.gitCredential?.(task.summary.luban_account));
      try {
        await prepareMaeBuildSupport({ root, workspace: task.cwd, dataDir: this.options.dataDir, repositories: [repository], log: this.options.log, user: this.options.isolation?.user,
          clone: async (url, target, ref) => { await this.cloneRepo(dirname(target), sandbox, undefined, url, ref, basename(target), true, true); } });
        volumes = [...volumes, ...maeBuildVolumes(root, task.cwd)];
      } catch (error) { environment.MFC_MAE_BUILD_ERROR = String(error); this.options.log?.(`[mae-build] ${task.summary.id} 构建资源未就绪: ${String(error)}`); }
      finally { this.cleanupHostGitCredential(sandbox); }
    }
    const mounted = this.containerMountsForRepository(repository, [...volumes, `${MAE_BUILD_ASSETS}:${MAE_BUILD_MOUNT}:ro`], task.cwd);
    return { ...mounted, environment: { ...mounted.environment, ...environment } };
  }

  private containerMountsForRepository(
    repository: string,
    volumes: string[],
    workspace?: string,
  ): { volumes: string[]; environment: NodeJS.ProcessEnv } {
    const isolation = this.options.isolation;
    return perRepoBuildCacheMounts({
      cacheRoot: isolation?.cacheRoot,
      cacheKeySource: repository,
      volumes,
      seedEnvironment: isolation?.environment,
      cppSdkDestination: workspace
        ? join(dirname(resolve(workspace)), "cpp_sdk_repository")
        : undefined,
      ccacheBaseDirSource: workspace,
      maeFlowHost: process.env.MAE_FLOW_HOST,
    });
  }

  private prePushBuildSlotCount(): number {
    const configured = Number(this.options.prepush?.buildSlots ?? 1);
    return Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured)) : 1;
  }

  private releasePrePushBuildSlot(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activePrePushBuilds = Math.max(0, this.activePrePushBuilds - 1);
      this.drainPrePushBuildQueue();
    };
  }

  private drainPrePushBuildQueue(): void {
    if (this.shuttingDown) {
      const waiters = this.prePushBuildQueue.splice(0);
      for (const waiter of waiters) waiter.resolve(undefined);
      return;
    }
    const slots = this.prePushBuildSlotCount();
    while (this.activePrePushBuilds < slots
        && this.prePushBuildQueue.length) {
      const waiter = this.prePushBuildQueue.shift()!;
      if (!this.current(waiter.task, waiter.epoch)
          || waiter.task.summary.status === "paused"
          || waiter.task.summary.status === "pausing") {
        waiter.resolve(undefined);
        continue;
      }
      this.activePrePushBuilds += 1;
      waiter.task.summary.detail = `已获得 Build-Fix 构建资源（`
        + `${this.activePrePushBuilds}/${slots} 使用中）`;
      // 出队时把排队文案换掉,否则整轮编译期间气泡都还挂着"排队等待"。
      const granted = waiter.task.summary.delivery?.prepush;
      if (granted?.state === "preparing") {
        this.setPrePushState(waiter.task, {
          ...granted,
          message: "已获得编译槽位，正在启动 Build-Fix",
          updated_at: new Date().toISOString(),
        });
      }
      this.persist(waiter.task);
      waiter.resolve(this.releasePrePushBuildSlot());
    }
  }

  private acquirePrePushBuildSlot(
    task: TaskState,
    epoch: number,
  ): Promise<(() => void) | undefined> {
    if (this.shuttingDown) return Promise.resolve(undefined);
    if (!this.current(task, epoch)) return Promise.resolve(undefined);
    const slots = this.prePushBuildSlotCount();
    if (this.activePrePushBuilds < slots) {
      this.activePrePushBuilds += 1;
      return Promise.resolve(this.releasePrePushBuildSlot());
    }
    task.summary.detail = `等待 Build-Fix 构建资源（${this.activePrePushBuilds}/`
      + `${slots} 使用中，按任务顺序排队）`;
    // 排队真相也要进 prepush 现场:气泡读的是 prepush.message 不是任务
    // detail,不写这里用户看到的就是一动不动的"准备"(实锤被当成卡死)。
    const waiting = task.summary.delivery?.prepush;
    if (waiting?.state === "preparing") {
      this.setPrePushState(task, {
        ...waiting,
        message: `排队等待编译槽位（${this.activePrePushBuilds}/${slots} `
          + "使用中，前面的构建结束后自动开始）",
        updated_at: new Date().toISOString(),
      });
    }
    this.persist(task);
    return new Promise((resolve) => {
      this.prePushBuildQueue.push({ task, epoch, resolve });
    });
  }

  private removePrePushBuildWaiter(task: TaskState): void {
    const kept: PrePushBuildWaiter[] = [];
    for (const waiter of this.prePushBuildQueue) {
      if (waiter.task === task) waiter.resolve(undefined);
      else kept.push(waiter);
    }
    this.prePushBuildQueue = kept;
  }

  businessModuleTaskCount(moduleId: string): number {
    return [...this.tasks.values()].filter(task => !task.summary.parent_task_id && task.summary.origin !== "issue"
      && task.summary.business_module && resolveBusinessModuleId(this.options.dataDir, task.summary.business_module.id) === moduleId).length;
  }

  private moduleOwnership(summary: TaskSummary): TaskSummary {
    return { ...summary,
      ...(summary.business_module ? { business_module: resolveBusinessModuleRef(this.options.dataDir, summary.business_module) } : {}),
      ...(summary.business_modules ? { business_modules: summary.business_modules.map(module => resolveBusinessModuleRef(this.options.dataDir, module)) } : {}),
    };
  }

  list(): TaskSummary[] {
    return [...this.tasks.values()]
      .map((task) => this.project(task))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private requireBusinessModule(id: string): { id: string; name: string } {
    const module = listBusinessModules(this.options.dataDir).modules.find(m => m.id === resolveBusinessModuleId(this.options.dataDir, id) && m.status === "active");
    if (!module) throw new TaskControlError("请选择配置中心中有效的业务模块");
    return { id: module.id, name: module.name };
  }

  setBusinessModule(id: string, moduleId: string, actor: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new TaskControlError("任务不存在");
    if (task.summary.parent_task_id) throw new TaskControlError("请到主任务修改所属业务模块，子任务自动使用主任务归属");
    if (task.summary.origin === "issue") throw new TaskControlError("此入口用于需求业务模块归属");
    const next = moduleId ? this.requireBusinessModule(moduleId) : undefined;
    const previous = task.summary.business_module;
    if (previous?.id !== next?.id) {
      task.summary.business_module_history = [...(task.summary.business_module_history ?? []),
        { at: new Date().toISOString(), by: actor, from: previous, to: next }];
      task.summary.business_module = next;
      this.persist(task);
    }
    return this.get(id)!;
  }

  generateDeliveryReport(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new TaskControlError("任务不存在");
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，请在交付分析中查看最终代码差异");
    if (!task.cwd || task.summary.workspace_reclaimed_at || !existsSync(task.cwd))
      throw new TaskControlError("代码现场已回收或不可用，无法补全实际改动报告");
    if (task.summary.status === "canceled" || continuationPending(task.summary))
      throw new TaskControlError("任务已取消或正在准备继续修改，暂时不能生成报告");
    if (!task.summary.delivery?.git_push?.sha || !task.summary.delivery.mr_url || !task.summary.delivery.target_branch)
      throw new TaskControlError("请在代码已推送且 MR 创建成功后生成报告");
    this.deliverySummaries.start(task, false, true);
    return this.project(task);
  }

  deliveryAnalysis(retry = false): ReturnType<typeof buildDeliveryAnalysis> {
    for (const task of this.tasks.values()) {
      if (task.summary.delivery?.final_mr) this.finalMrSamples.schedule(task, retry);
      else if (task.summary.delivery?.git_push?.sha) observeDeliveryCode(task.summary, task.cwd, task.summary.delivery.git_push.sha, retry);
    }
    const summaries = [...this.tasks.values()].map(task => ({ ...task.summary, token_usage: tokenUsageSnapshot(task.tokenUsage) }));
    const profiles = resolveRepositoryProfiles(this.options.dataDir, [...new Set(summaries.map(t => t.repo_url).filter((r): r is string => !!r))]).flatMap(r => r.profile ? [r.profile] : []);
    for (const task of this.tasks.values()) this.considerDeliveryImprovement(task);
    const report = buildDeliveryAnalysis(summaries.map(summary => this.moduleOwnership(summary)), listBusinessModules(this.options.dataDir).modules, profiles);
    for (const row of report.rows) {
      const task = this.tasks.get(row.id)!;
      const delivery = (task.summary.delivery_generation ?? "initial") === row.delivery_id ? task.summary.delivery
        : task.summary.delivery_history?.find(item => item.id === row.delivery_id)?.delivery;
      row.improvement = this.deliveryImprovements.view({ ...task.summary,
        delivery_generation: row.delivery_id === "initial" ? undefined : row.delivery_id,
        delivery: { ...delivery, git_push: { ...delivery?.git_push, sha: row.metric?.published_head ?? row.metric?.head ?? "" } } as TaskSummary["delivery"],
      }).state;
    }
    return { ...report, improvement_policy: readImprovementPolicy(this.options.dataDir) };
  }

  improvementPolicy(input?: { enabled?: unknown; threshold_percent?: unknown }) {
    return input ? updateImprovementPolicy(this.options.dataDir, input) : readImprovementPolicy(this.options.dataDir);
  }

  private improvementOwner(id: string, deliveryId?: string): TaskState {
    const task = this.tasks.get(id);
    if (!task || task.summary.origin === "issue") throw new TaskControlError("需求任务不存在");
    if (!deliveryId || deliveryId === (task.summary.delivery_generation ?? "initial")) return task;
    const previous = task.summary.delivery_history?.find(h => h.id === deliveryId);
    if (!previous) throw new TaskControlError("指定交付记录不存在");
    const original = JSON.parse(readFileSync(join(task.summary.workspace, "delivery-history", previous.archive, "summary.json"), "utf8"));
    return { ...task, summary: { ...original, workspace: task.summary.workspace,
      delivery_generation: previous.id === "initial" ? undefined : previous.id,
      delivery_history: task.summary.delivery_history } };
  }

  deliveryImprovement(id: string, deliveryId?: string, start = false) {
    const task = this.improvementOwner(id, deliveryId);
    if (start && (continuationPending(task.summary) || task.summary.status === "canceled"))
      throw new TaskControlError("任务正在准备继续修改或已经取消，暂时不能启动分析");
    return start ? this.deliveryImprovements.start(task) : this.deliveryImprovements.view(task.summary, true);
  }

  deliveryImprovementEvidence(id: string, deliveryId: string | undefined, reference: string) {
    return this.deliveryImprovements.evidence(this.improvementOwner(id, deliveryId).summary, reference);
  }

  private considerDeliveryImprovement(task: TaskState) {
    if (task.finalMrAnalysis?.running || !readImprovementPolicy(this.options.dataDir).enabled) return;
    try { this.deliveryImprovements.consider(task); }
    catch (error) { this.options.log?.(`交付改进分析未启动：${String(error)}`); }
  }

  /** 团队知识运营读模型。独立接口按需计算，避免把所有任务足迹塞进
   * 1.5 秒一次的任务列表轮询。任何建议都不参与流程或质量裁决。 */
  knowledgeInsights(): TeamKnowledgeInsights & { host_skills: HostSkillShelf } {
    // 货架(部署态资产)与足迹(消费聚合)同口径一次给全:足迹只看得见
    // 被任务带过的资源,放坏了的 skill 在足迹里隐形,货架把它照出来。
    const projected = [...this.tasks.values()]
      .map((task) => this.project(task, true));
    return {
      ...buildTeamKnowledgeInsights(projected),
      host_skills: this.decorateHostSkillShelf(projected),
    };
  }

  /** 货架 + 效果账(飞轮第 3 步):每个条目带消费率与 prepush 一次过
   * 对照,低消费/高摩擦亮修订信号。/skills 管理接口与知识效能页共用
   * 这一份,数字口径不许有两套。 */
  hostSkillShelf(): DecoratedHostSkillShelf {
    return this.decorateHostSkillShelf([...this.tasks.values()]
      .map((task) => this.project(task, true)));
  }

  private decorateHostSkillShelf(
    tasks: KnowledgeInsightTask[],
  ): DecoratedHostSkillShelf {
    const shelf = listHostSkillShelf(this.options.dataDir);
    const effects = buildHostSkillEffects(tasks);
    return {
      ...shelf,
      skills: shelf.skills.map((skill) => {
        return {
          ...skill,
          effect: effects.get(skill.name),
        };
      }),
    };
  }

  // ---- 定向知识提取(知识库侧旁路,不建任务、不碰交付链) ----

  private extractionJobs = new Map<string, ExtractionJobRecord>();
  private knowledgeTaskCapacity = new KnowledgeTaskCapacity();
  private extractionRunning = new Set<string>();

  private extractionRoot(id: string): string {
    return join(this.options.dataDir, "knowledge-extract", id);
  }

  /** 与领域、组件萃取共用执行名额，满额后排队。 */
  startSkillExtraction(input: {
    repo: string;
    intent: string;
    pathHint?: string;
    operator: string;
  }): ExtractionJobRecord {
    const repo = input.repo.trim();
    const intent = input.intent.trim();
    const pathHint = input.pathHint?.trim() || undefined;
    if (!repo || /[\0\r\n\s]/.test(repo) || repo.length > 500) {
      throw new TaskControlError("请填写合法的参考仓地址(不含空白字符)");
    }
    if (!intent || intent.length > 500) {
      throw new TaskControlError("请用一句话写清楚要提取什么(500 字内)");
    }
    if (pathHint && (pathHint.startsWith("/") || pathHint.includes(".."))) {
      throw new TaskControlError("路径提示只接受仓内相对路径");
    }
    if (this.shuttingDown) throw new TaskControlError("服务正在关闭，请稍后再试");
    if (!this.activeModelChoice()) {
      throw new TaskControlError("模型网关未配置,无法提取(管理页 → 模型网关)");
    }
    const id = `ke-${Date.now().toString(36)}-${
      Math.random().toString(36).slice(2, 8)}`;
    const record: ExtractionJobRecord = {
      id,
      status: "queued",
      repo,
      intent,
      ...(pathHint ? { path_hint: pathHint } : {}),
      operator: input.operator,
      created_at: new Date().toISOString(),
    };
    this.extractionJobs.set(id, record);
    persistExtractionJob(this.extractionRoot(id), record, this.options.log);
    this.pumpSkillExtraction();
    return { ...record };
  }

  private pumpSkillExtraction() {
    if (this.shuttingDown) return;
    for (const record of this.extractionJobs.values()) {
      if (!this.knowledgeTaskCapacity.canStart()) return;
      if (record.status !== "queued") continue;
      record.status = "running";
      record.started_at = new Date().toISOString();
      this.extractionRunning.add(record.id);
      persistExtractionJob(this.extractionRoot(record.id), record, this.options.log);
      this.bypass(undefined, "定向知识提取", this.runSkillExtraction(record).finally(() => {
        this.extractionRunning.delete(record.id);
        this.knowledgeTaskCapacity.wake();
      }));
    }
  }

  /** 制作 Skill 的草稿已由人编辑并提交审查：记下提交号，制作任务随之结束。 */
  markSkillExtractionSubmitted(id: string, submissionId: string): ExtractionJobRecord {
    const job = this.skillExtractionJob(id);
    if (!job) throw new NotFoundError("提取任务不存在");
    if (job.status !== "done" || !job.draft) throw new SkillLibraryError("草稿尚未生成，不能记为已提交");
    const [directory, submission, ...rest] = submissionId.split("/");
    if (!directory || !submission || rest.length) throw new SkillLibraryError("提交编号无效");
    readSkillSubmissionPackage(this.options.dataDir, directory, submission);
    const record = { ...job, submission_id: submissionId };
    if (this.extractionJobs.has(id)) this.extractionJobs.set(id, record);
    persistExtractionJob(this.extractionRoot(id), record, this.options.log);
    return { ...record };
  }

  skillExtractionJob(id: string): ExtractionJobRecord | undefined {
    const live = this.extractionJobs.get(id);
    if (live) return { ...live };
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return undefined;
    const stored = readExtractionJob(this.extractionRoot(id));
    if (stored && ["queued", "running"].includes(stored.status)) {
      // 服务重启把跑一半的 job 带走了:如实报中断,不装完成不装原因。
      return {
        ...stored,
        status: "failed",
        error: "服务重启中断了这次提取,请重新发起",
      };
    }
    return stored;
  }

  private async runSkillExtraction(record: ExtractionJobRecord): Promise<void> {
    const root = this.extractionRoot(record.id);
    const finish = (patch: Partial<ExtractionJobRecord>) => {
      Object.assign(record, patch,
        { finished_at: new Date().toISOString() });
      this.extractionJobs.set(record.id, { ...record });
      persistExtractionJob(root, record, this.options.log);
    };
    let container: TaskContainer | undefined;
    try {
      mkdirSync(root, { recursive: true });
      // 只读克隆:凭据用发起人自己的(没权限当场报),pushurl 毒化由
      // cloneRepo 的 readonly 分支负责——禁令不能只写在提示词里。
      const identity = this.options.gitCredential?.(record.operator);
      const prepared = identity
        ? this.prepareHostGitSandbox(identity) : undefined;
      let cloneDir: string;
      try {
        cloneDir = await this.cloneRepo(
          root, prepared, identity, record.repo, undefined, "source", true);
      } catch (error) {
        finish({
          status: "failed",
          error: `参考仓克隆失败(地址不可达或无权限):${String(
            error instanceof Error ? error.message : error).slice(0, 300)}`,
        });
        return;
      } finally {
        this.cleanupHostGitCredential(prepared);
      }
      const agentDir = join(root, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      this.hardenAgentGitBoundary(agentDir, cloneDir);
      writeFileSync(join(agentDir, "models.json"),
        JSON.stringify(this.resolvedModels().json));
      // 隔离模式:提取会话与任务同纪律,Bash 进专属容器(role 已入
      // 清扫白名单,kill -9 后启动清扫认得它)。
      if (this.options.isolation) {
        const isolation = this.options.isolation;
        const instance = taskContainerInstance(this.options.dataDir);
        container = new TaskContainer(
          isolation.image,
          root,
          `mfc-${instance.namePrefix}-${record.id}`,
          (message) => this.options.log?.(
            `[knowledge-extract-container] ${message}`),
          isolation.volumes,
          {
            memory: isolation.memory,
            cpus: isolation.cpus,
            pidsLimit: isolation.pidsLimit,
            user: isolation.user,
          },
          {
            network: isolation.network,
            labels: {
              "com.mae-flow-cloud.instance": instance.fingerprint,
              "com.mae-flow-cloud.role": "knowledge-extract",
              "com.mae-flow-cloud.task": record.id,
            },
          },
        );
        prepareContainerHostPaths({
          workspace: root,
          volumes: isolation.volumes ?? [],
          user: isolation.user,
          markerRoot: join(this.options.dataDir, ".container-ownership"),
        });
        await container.start();
      }
      const active = this.activeModelChoice()!;
      const driver = await CloudSession.create({
        taskId: `knowledge-extract:${record.id}`,
        workspace: cloneDir,
        agentDir,
        repositoryResourceBlocks: () =>
          readResourceBlocks(this.options.dataDir),
        provider: active.provider,
        model: active.model,
        eventLog: new EventLog(join(root, "events.jsonl")),
        transcript: new TranscriptStore(
          join(root, "transcript.jsonl"), "main"),
        // 边界=提取目录(克隆在其内);产物走最终回复,不落工作区文件,
        // 会话对仓的任何写入都是越界。
        gate: new GateService({
          workspace: cloneDir,
          cwd: cloneDir,
          failClosed: Boolean(this.options.host),
          log: this.options.log,
        }),
        humanGate: new HumanGate(join(root, "waiting.json")),
        allowHumanQuestions: false,
        allowSubagents: false,
        sessionId: "knowledge-extract",
        currentStep: () => "定向知识提取",
        compactAnchor: () => `定向知识提取:${record.intent.slice(0, 60)}`,
        ...(container
          ? {
              bashOperations: {
                exec: (command, dir, execOptions) =>
                  container!.exec(command, dir, execOptions),
              },
            }
          : {}),
        log: this.options.log,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void driver.abort().catch(() => undefined);
      }, EXTRACTION_TIMEOUT_MS);
      timer.unref?.();
      try {
        let outcome = await driver.start(buildExtractionMission({
          repoLabel: record.repo,
          intent: record.intent,
          pathHint: record.path_hint,
          timeoutMinutes: Math.round(EXTRACTION_TIMEOUT_MS / 60_000),
        }));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (timedOut) {
            finish({
              status: "failed",
              error: `提取超过 ${Math.round(EXTRACTION_TIMEOUT_MS / 60_000)} `
                + "分钟预算,已安全停止;可换更具体的意图或路径提示重试",
            });
            return;
          }
          if (outcome.status === "session_ended") {
            finish({
              status: "failed",
              error: outcome.detail ?? "提取会话异常结束",
            });
            return;
          }
          const parsed = parseExtractionDraft(driver.finalReply());
          if (parsed) {
            try {
              // 草稿也要过密钥扫描:参考仓的配置样例里完全可能躺着
              // 真实令牌,上架闸兜底之前先在源头拒掉。
              scanForSecrets("SKILL.md(提取草稿)",
                Buffer.from(parsed.draft, "utf-8"));
            } catch (error) {
              finish({
                status: "failed",
                error: `草稿含敏感值,已整份作废:${String(
                  error instanceof Error ? error.message : error)
                  .slice(0, 200)}`,
              });
              return;
            }
            finish({ status: "done", draft: parsed.draft,
              notes: parsed.notes });
            return;
          }
          // 格式缺失给补交机会(最多两次),与预热同款,不把整轮判死;
          // 最后一轮不再补交——发出去的提醒必须有人读它的回答。
          if (attempt === 2) break;
          outcome = await driver.continueWith(
            "产出格式不对:请只输出 ===SKILL=== 与 ===NOTES=== 结构,"
            + "重新给出完整草稿,不要输出其他文字。");
        }
        finish({ status: "failed",
          error: "提取会话多次提醒后仍未按格式产出草稿,请重试" });
      } finally {
        clearTimeout(timer);
        driver.dispose();
      }
    } catch (error) {
      finish({
        status: "failed",
        error: String(error instanceof Error ? error.message : error)
          .slice(0, 300),
      });
    } finally {
      if (container) await container.stop().catch(() => undefined);
    }
  }

  get(id: string): TaskSummary | undefined {
    const task = this.tasks.get(id);
    return task ? this.project(task, true) : undefined;
  }

  async getAsync(id: string): Promise<TaskSummary | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const started = performance.now();
    const reading = await readCurrentExecutionPlanReadingAsync({
      kernelRoot: this.options.host?.kernelRoot,
      workspace: task.cwd ?? task.summary.workspace, python: this.options.host?.python,
    });
    const planRead = performance.now();
    const summary = this.tasks.get(id) === task ? this.project(task, true, reading) : undefined;
    if (performance.now() - started >= 250) this.options.log?.(`[task-read] ${JSON.stringify({ id,
      plan_ms: Math.round(planRead - started), projection_ms: Math.round(performance.now() - planRead) })}`);
    return summary;
  }

  /** 文件读取和事件流只需要已保存的元数据，不应顺便计算整份任务详情。 */
  storedTaskSummary(id: string): Readonly<TaskSummary> | undefined {
    const summary = this.tasks.get(id)?.summary;
    return summary ? { ...summary } : undefined;
  }

  async uploadConversationAttachment(id: string, request: IncomingMessage, name: string) {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (["completed", "canceled"].includes(task.summary.status)) throw new TaskControlError("任务已结束，不能上传附件");
    return storeTaskAttachment(task.summary.workspace, task.cwd, request, name);
  }

  conversationAttachment(id: string, path: string) {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return taskAttachment(task.summary.workspace, path);
  }

  withConversationAttachments(id: string, text: string, paths: unknown): string {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    try { return taskAttachmentContext(task.summary.workspace, task.cwd, id, text, paths); }
    catch (error) { throw new TaskControlError(String((error as Error).message)); }
  }

  /** 批注附图落盘:任务目录是真相,同时铺进 Agent 工作区供 inspect_image 读。 */
  storeAnnotationAsset(id: string, bytes: Buffer) {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return storeReviewAsset(task.summary.workspace, task.cwd, bytes);
  }

  annotationAsset(id: string, path: string): { mime_type: string; content: Buffer } | undefined {
    const task = this.tasks.get(id);
    return task ? readReviewAsset(task.summary.workspace, path) : undefined;
  }

  requirementAsset(
    id: string,
    path: string,
  ): { mime_type: string; content: Buffer } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const asset = readStoredRequirementAsset(
      task.summary.workspace, task.summary.requirement_document, path);
    return asset
      ? { mime_type: asset.meta.mime_type, content: asset.content }
      : undefined;
  }

  requirementSource(id: string, path: string): { name: string; content: Buffer } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const source = readStoredRequirementSource(
      task.summary.workspace, task.summary.requirement_document, path);
    return source ? { name: source.meta.name, content: source.content } : undefined;
  }

  /** 多份来源合成当前需求正文；确认后只修订正文，不从原件重新生成。
   * 需求确认阶段只允许专用 Agent
   * 根据已提交批注更新，避免人与 Agent 双写。 */
  private applyRequirementContent(
    task: TaskState,
    content: string,
  ): boolean {
    if (!content.trim()) throw new TaskControlError("需求原文不能为空");
    if (content === task.summary.requirement) return false;
    const previous = task.summary.requirement_document;
    const maxBytes = Buffer.byteLength(task.summary.requirement, "utf-8")
        > MAX_REQUIREMENT_DOCUMENT_BYTES
      ? MAX_REQUIREMENT_DOCUMENT_BYTES * 2
      : MAX_REQUIREMENT_DOCUMENT_BYTES;
    let next: RequirementDocumentMeta | undefined;
    try {
      next = requirementDocumentMeta(content, previous?.name, maxBytes);
    } catch (error) {
      throw new TaskControlError(String(
        error instanceof Error ? error.message : error));
    }
    if (next && previous) {
      next = {
        ...next,
        ...(previous.sources?.length ? { context_mode: "file" as const } : {}),
        ...(previous.bundle_name ? { bundle_name: previous.bundle_name } : {}),
        ...(previous.assets?.length ? { assets: previous.assets } : {}),
        ...(previous.sources?.length ? { sources: previous.sources } : {}),
        ...(previous.warnings?.length ? { warnings: previous.warnings } : {}),
      };
    }
    task.summary.requirement = content;
    task.summary.requirement_document = next;
    storeRequirementDocument(task.summary.workspace, content, next);
    return true;
  }

  /** 需求确认阶段只有 Agent 写文档，人只通过批注表达修改意见。每轮
   * 在任务目录生成一份隔离副本，轻量 Agent 用 Read/Edit 原位修改并
   * 写结构化回执；宿主校验、留 diff 后才替换正本。模型回复不再搬运
   * 完整正文，因此长文也不受单次输出上限约束。 */
  private async reviseRequirementFromAnnotations(
    task: TaskState,
    annotations: Annotation[],
  ): Promise<void> {
    const sessionEpoch = auxiliarySessionEpoch(task);
    const waiting = task.summary.waiting;
    if (this.shuttingDown || task.summary.status !== "waiting_for_human"
        || waiting?.step !== CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP) {
      throw new TaskControlError("当前已经不在需求确认阶段");
    }
    const modelBundle = this.sessionModels(task, "auto");
    const model = modelBundle.choice;
    if (!model) throw new TaskControlError("模型网关未配置，Agent 暂时无法修改需求文档");
    const revisionId = randomUUID();
    task.summary.requirement_revision = {
      id: revisionId,
      state: "running",
      annotation_ids: annotations.map((item) => item.id),
      started_at: new Date().toISOString(),
    };
    task.summary.detail = `Agent 正在落实 ${annotations.length} 条需求检视意见`;
    this.persist(task);
    const reviewRoot = join(
      task.summary.workspace, "requirement-review", revisionId);
    const documentPath = join(reviewRoot, REQUIREMENT_REVIEW_DOCUMENT);
    const receiptsPath = join(reviewRoot, REQUIREMENT_REVIEW_RECEIPTS);
    let driver: CloudSession | undefined;
    let succeeded = false;
    try {
      prepareRequirementReviewWorkspace(task.summary.workspace, reviewRoot,
        task.summary.requirement, task.summary.requirement_document);

      const agentDir = join(
        task.summary.workspace, "requirement-review-agent");
      mkdirSync(agentDir, { recursive: true });
      this.hardenAgentGitBoundary(agentDir);
      writeFileSync(join(agentDir, "models.json"),
        JSON.stringify(modelBundle.json), { mode: 0o600 });
      driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: reviewRoot,
        agentDir,
        repositoryResourceBlocks: () =>
          readResourceBlocks(this.options.dataDir),
        provider: model.provider,
        model: model.model,
        eventLog: new EventLog(this.eventLogPath(task.summary.id)),
        transcript: new TranscriptStore(
          join(task.summary.workspace, "requirement-history", `${revisionId}.transcript.jsonl`), `requirement-review:${revisionId}`),
        gate: new GateService({
          contract: createRequirementReviewGateContract(reviewRoot,
            task.summary.requirement_document),
          workspace: reviewRoot,
          cwd: reviewRoot,
          failClosed: true,
          log: this.options.log,
        }),
        humanGate: new HumanGate(join(reviewRoot, "waiting.json")),
        ...REQUIREMENT_REVIEW_SESSION_POLICY,
        sessionId: `requirement-review:${revisionId}`,
        vision: this.taskVision(task),
        currentStep: () => "落实需求检视意见",
        compactAnchor: () =>
          `只修改 ${REQUIREMENT_REVIEW_DOCUMENT} 中本轮意见指向的内容`,
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        log: this.options.log,
      });
      trackAuxiliarySession(task, driver, sessionEpoch);
      const outcome = await driver.start(requirementReviewMission({
        annotations,
        ticket: this.ticketOf(task),
      }, task.summary.requirement));
      if (outcome.status === "session_ended" && outcome.reason === "failed") {
        throw new TaskControlError(
          `需求文档修改 Agent 未完成：${outcome.detail ?? "模型调用失败"}`);
      }
      const current = task.summary.requirement_revision;
      if (this.shuttingDown || auxiliarySessionEpoch(task) !== sessionEpoch || current?.id !== revisionId
          || task.summary.status !== "waiting_for_human"
          || task.summary.waiting?.waiting_id !== waiting.waiting_id) {
        throw new StateConflictError("Agent 修改完成前任务状态已经变化，本轮结果未写入");
      }
      if (!existsSync(receiptsPath)) {
        const last = driver.finalReply().trim().slice(0, 240);
        throw new TaskControlError(
          "Agent 没有留下逐条检视回执，本轮拒收，原文未变"
          + (last ? `；Agent 最后说明：${last}` : ""));
      }
      const receiptStat = lstatSync(receiptsPath);
      if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
        throw new TaskControlError("Agent 的逐条回执不是普通文件，本轮拒收，原文未变");
      }
      if (receiptStat.size > MAX_REQUIREMENT_RECEIPTS_BYTES) {
        throw new TaskControlError("Agent 的逐条回执异常过大，本轮拒收，原文未变");
      }
      let rawReceipts: string;
      let after: string;
      try {
        rawReceipts = new TextDecoder("utf-8", { fatal: true })
          .decode(readFileSync(receiptsPath));
        after = new TextDecoder("utf-8", { fatal: true })
          .decode(readFileSync(documentPath));
      } catch {
        throw new TaskControlError(
          "Agent 写下的需求文档或逐条回执不是有效 UTF-8 文本，本轮拒收，原文未变");
      }
      // 回执和 MR 检视一样按 id 逐条对拍,少一条、多一条、说不清都不收。
      // 区别只在传输方式:它是一个小型 JSON 文件，不再与完整正文揉进回复。
      const receipts = parseDocumentReviewReceipts(rawReceipts, annotations);
      const before = task.summary.requirement;
      const reportsFixed = receipts.some((item) => item.outcome === "fixed");
      if (reportsFixed && after === before) {
        throw new TaskControlError(
          "Agent 回执说已经修改，但需求原文没有变化；本轮拒收，检视意见仍可重提");
      }
      if (!reportsFixed && after !== before) {
        throw new TaskControlError(
          "Agent 修改了需求原文，但逐条回执没有说明哪条已落实；本轮拒收，原文未变");
      }
      // 批注是修改意图，不是段落白名单。连带修改由完整 diff 和人工复检确认。
      // 改前全文和 diff 先落盘再覆盖正文:页面靠它给人看"这一轮改了什么",
      // 没有它,人只能把整篇重读一遍。
      const diff = requirementDiff(before, after);
      storeRequirementRevision(task.summary.workspace, revisionId, before, diff.text);
      this.applyRequirementContent(task, after);
      task.summary.requirement_revisions = [
        ...(task.summary.requirement_revisions ?? []),
        {
          id: revisionId,
          at: new Date().toISOString(),
          annotation_ids: annotations.map((item) => item.id),
          additions: diff.additions,
          deletions: diff.deletions,
        },
      ];
      // 先把新正文落袋，再把意见标成已送达。即使进程在两者之间中断，
      // 恢复后也只会要求重提，不会拿半份文档冒充已经闭环。
      this.persist(task);
      const store = this.annotations(task);
      const applied = new Set(store.markSentFor(annotations, "interrupt"));
      for (const receipt of receipts) {
        if (!applied.has(receipt.annotation_id)) continue;
        store.respond(receipt.annotation_id, {
          revision: receipt.revision,
          outcome: receipt.outcome,
          summary: receipt.summary,
          evidence: receipt.evidence ?? [],
        });
      }
      task.summary.requirement_revision = undefined;
      task.summary.detail = "Agent 已修改需求文档，等待检视意见闭环后确认进入分析";
      this.persist(task);
      succeeded = true;
    } catch (error) {
      const current = task.summary.requirement_revision;
      if (!this.shuttingDown && auxiliarySessionEpoch(task) === sessionEpoch && current?.id === revisionId
          && task.summary.status === "waiting_for_human") {
        const message = String(error instanceof Error ? error.message : error)
          .slice(0, 500);
        task.summary.requirement_revision = {
          ...current,
          state: "failed",
          finished_at: new Date().toISOString(),
          error: message,
        };
        task.summary.detail = `Agent 修改需求文档失败：${message}`;
        this.persist(task);
      }
      throw error;
    } finally {
      untrackAuxiliarySession(task, driver);
      try {
        driver?.dispose();
      } catch (error) {
        this.options.log?.(
          `任务 ${task.summary.id} 需求文档修改会话释放失败：${String(error)}`);
      }
      // 执行事件已进任务日志，会话和改动历史已进 requirement-history，副本不再
      // 有权威价值；失败现场保留，便于定位模型/门禁/文件错误。
      if (succeeded && existsSync(reviewRoot)) {
        try {
          removeTaskTree(reviewRoot);
        } catch (error) {
          // 临时副本清扫是旁路，不能把已经可靠入账的成功轮反报成失败。
          this.options.log?.(
            `任务 ${task.summary.id} 需求文档修改临时目录清理失败：${String(error)}`);
        }
      }
    }
  }

  /** 页面按 id 取某一轮修改的对比:改前全文 + 统一 diff。 */
  requirementRevision(
    id: string,
    revisionId: string,
  ): { before: string; diff: string; entry?: NonNullable<TaskSummary["requirement_revisions"]>[number] } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const stored = readRequirementRevision(task.summary.workspace, revisionId);
    if (!stored) return undefined;
    return {
      ...stored,
      entry: task.summary.requirement_revisions?.find((item) => item.id === revisionId),
    };
  }

  historyMutationInProgress(id: string): boolean {
    return this.historyMutationActive.has(id);
  }

  /** 责任人主动发出的 Committer 检视邀请。邀请先落盘，再发送；通知
   * 失败也不会把“有人应当检视”这个事实弄丢。 */
  async requestReview(
    id: string,
    requester: string,
    committer: string,
  ): Promise<ReviewRequest> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (isReviewTaskEnded(task.summary.status)) throw new TaskControlError(
      `任务已${task.summary.status === "canceled" ? "取消" : "结束"}，不能再邀请检视`);
    const notifier = this.options.notifier;
    if (!notifier) throw new Error("本部署未接通知器");
    const review = this.reviews.create({
      taskId: id,
      taskTitle: task.summary.title ?? taskTitle(task.summary.requirement),
      requester,
      committer,
    });
    const result = await notifier.notifyReview({
      taskId: id,
      senderAccount: requester,
      account: committer,
      summary: review.task_title,
      link: reviewTaskLink(this.notificationLinkBase(), id, review.id),
    });
    return this.reviews.delivery(review.id, result);
  }

  listReviewsFor(committer: string): ReviewRequest[] {
    return this.reviews.forCommitter(committer);
  }

  listTaskReviews(taskId: string): ReviewRequest[] {
    if (!this.tasks.has(taskId)) throw new NotFoundError(`任务 ${taskId} 不存在`);
    return this.reviews.forTask(taskId);
  }

  completeReview(id: string, committer: string): ReviewRequest {
    const current = this.reviews.list().find((item) => item.id === id);
    if (!current) throw new Error(`检视邀请 ${id} 不存在`);
    if (current.committer !== committer) {
      throw new Error("只能完成邀请给自己的检视");
    }
    if (current.status !== "pending") return current;
    const task = this.tasks.get(current.task_id);
    if (!task) throw new Error(`任务 ${current.task_id} 不存在`);
    assertReviewCanComplete(this.annotations(task).visible().filter((item) =>
      item.author === committer));
    const record = this.reviews.complete(id, committer);
    // 收口回执:发起人在等这个信号——不发,他只能反复刷页面或线下问
    // (2026-08-30 审计:检视完成静默,两边互等)。纯旁路,失败只留日志。
    if (this.options.notifier && record.requester
        && record.requester !== committer) {
      this.bypass(undefined, "检视完成回执", this.options.notifier.notifyOutcome({
        taskId: record.task_id,
        account: record.requester,
        status: `review-completed:${record.id}`,
        summary: `${committer} 已完成对「${record.task_title}」的检视,`
          + "可以继续推进任务",
        link: personalTaskLink(
          this.notificationLinkBase(), record.requester, record.task_id),
      }));
    }
    return record;
  }

  /** 启动一次与真实任务同约束的短命容器，验证的不是宿主 PATH，而是
   * 真正会承载 Agent 命令的镜像、挂载、身份和工具链。 */
  private async probeTaskContainerToolchain(trace?: SystemCheckTrace): Promise<{
    ready: boolean;
    detail: string;
    suggestion?: string;
  }> {
    const isolation = this.options.isolation;
    if (!isolation) {
      return {
        ready: false,
        detail: "未配置统一任务容器",
        suggestion: "启动时加 --isolate-image <统一构建镜像>",
      };
    }
    // 自检也使用真实的“父目录/仓名”包络，避免工具链全绿、内部 C++
    // 项目却因 build/../../ 被拍扁到根目录而失败。
    const workspaceRoot = join(this.options.dataDir, "system-check-container");
    const workspace = join(workspaceRoot, "MfcProbeRepository");
    mkdirSync(workspace, { recursive: true });
    const kernelRoot = this.options.host?.kernelRoot;
    const mounted = this.containerMountsForRepository(
      "mae-flow-cloud/system-check",
      [
        ...(isolation.volumes ?? []),
        ...(kernelRoot ? [`${kernelRoot}:${kernelRoot}:ro`] : []),
      ],
      workspace,
    );
    const expectsMavenSettings = hasContainerVolumeDestination(
      mounted.volumes,
      "/etc/mae-flow/maven/settings.xml",
    );
    const instance = taskContainerInstance(this.options.dataDir).namePrefix;
    const containerName = `mfc-${instance}-system-check-${randomUUID().slice(0, 8)}`;
    const container = this.createTaskContainer({
      image: isolation.image,
      workspace,
      name: containerName,
      log: this.options.log,
      volumes: mounted.volumes,
      limits: {
        memory: isolation.memory,
        cpus: isolation.cpus,
        user: isolation.user,
        pidsLimit: isolation.pidsLimit,
      },
      options: {
        labels: {
          ...(isolation.labels ?? {}),
          "com.mae-flow-cloud.role": "system-check",
        },
        readOnlyRoot: isolation.readOnlyRoot,
        tmpfsHome: isolation.tmpfsHome,
        tmpfsTmp: isolation.tmpfsTmp,
        network: isolation.network,
        environment: {
          ...mounted.environment,
          ...(kernelRoot ? { MFC_KERNEL_ROOT: kernelRoot } : {}),
          ...(expectsMavenSettings ? { MFC_EXPECT_MAVEN_SETTINGS: "1" } : {}),
        },
        forwardEnvironment: isolation.forwardEnvironment,
        stopGraceSeconds: isolation.stopGraceSeconds,
        managementTimeoutMs: isolation.managementTimeoutMs,
      },
    });
    let output = "";
    let failure: unknown;
    let failurePhase = "start";
    let detail = "";
    try {
      await (trace ? trace.phase("container.start", () => container.start()) : container.start());
      failurePhase = "toolchain-exec";
      const command = [
        "set -eu",
        // 写入真正的 bind-mounted workspace，避免“只在 /tmp 能编译”
        // 的坏镜像通过自检。EXIT trap 保证失败路径也不留探针文件。
        'scratch="$PWD/.mfc-self-check-$$"',
        'trap \'rm -rf "$scratch"\' EXIT',
        'mkdir -p "$scratch"',
        'test -w "$PWD"',
        // Maven 会从 passwd 数据库而非 $HOME 发现用户目录；两者漂移时
        // settings 明明挂好了也会被 Maven 静默忽略。
        'passwd_home="$(awk -F: -v uid="$(id -u)" \'$3 == uid { print $6; exit }\' /etc/passwd)"',
        'test -n "$passwd_home"',
        'test "$passwd_home" = "$HOME"',
        // 五类缓存都必须是实际可写挂载；逐个写读删，不只看目录权限位。
        'sdk_cache="$(dirname "$PWD")/cpp_sdk_repository"',
        'for cache in /cache/maven /cache/npm /cache/ccache /cache/xdg "$sdk_cache"; do test -d "$cache"; probe="$cache/.mfc-self-check-$$"; printf cache-ok > "$probe"; test "$(cat "$probe")" = cache-ok; rm -f "$probe"; done',
        // 复现内部 C++ 仓 svc_profile.sh 的路径算法：仓库 build/../../
        // 必须回到聚合根，聚合根/<仓名> 必须就是当前仓库。
        'mkdir -p "$PWD/build"',
        'envelope_root="$(cd "$PWD/build/../.." && pwd)"',
        'test "$envelope_root/$(basename "$PWD")" = "$PWD"',
        // 内部基础镜像曾把 profile、平台 CLI 和 CA 路径做成 0750
        // root:root；root 阶段 docker build 全绿，10001 真跑却全拒绝。
        'for script in /etc/profile.d/*.sh; do test ! -e "$script" || test -r "$script"; done',
        'for directory in /etc/pki /etc/pki/tls /etc/pki/tls/certs; do test ! -e "$directory" || test -x "$directory"; done',
        'for ca in /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt; do test ! -e "$ca" || test -r "$ca"; done',
        'for optional in codehub-cli spes; do path="$(command -v "$optional" 2>/dev/null || true)"; test -z "$path" || test -x "$path"; done',
        // 真任务会把内核根只读挂入；父目录 0750 时工具链自检会绿，
        // mae-flow 第一条命令却 Permission denied。这里必须同形验证。
        'if test -n "${MFC_KERNEL_ROOT:-}"; then test -x "$MFC_KERNEL_ROOT"; test -r "$MFC_KERNEL_ROOT/scripts/mae-flow.py"; fi',
        "java -version 2>&1",
        "java -version 2>&1 | grep -Eq 'version \\\"21([.]|\\\"| )'",
        'mvn_info="$(mvn --version 2>&1)"',
        'printf \'%s\\n\' "$mvn_info"',
        'printf \'%s\\n\' "$mvn_info" | grep -Eq \'Java version: 21([., ]|$)\'',
        'mvn_java_home="$(printf \'%s\\n\' "$mvn_info" | sed -n \'s/^.*runtime: \\([^,]*\\).*$/\\1/p\' | head -n 1)"',
        'test -n "$mvn_java_home"',
        'test -r "$mvn_java_home/lib/security/cacerts"',
        'if test "${MFC_EXPECT_MAVEN_SETTINGS:-}" = 1; then test -r /etc/mae-flow/maven/settings.xml; test -r "$HOME/.m2/settings.xml"; fi',
        "node --version",
        'test "$(node -p \'Number(process.versions.node.split(\".\")[0])\')" -ge 18',
        "npm --version",
        'test "$(npm --version | cut -d. -f1)" -ge 9',
        "c++ --version",
        "ar --version",
        "bison --version",
        "flex --version",
        "if command -v ccache >/dev/null 2>&1; then ccache --version; else echo __MFC_CCACHE_OPTIONAL_MISSING__; fi",
        "git --version",
        "python3 --version",
        // Cloud 的真正第一步不是“Python 能启动”，而是托管任务能在同一
        // 容器挂载/用户下完成 init，并在 config_confirm 拒绝源码写入。
        // 过去自检全绿但 init 失败后 INACTIVE 继续放行，正是因为只测了
        // 文件可读，从未打过这条真实入口。
        'if test -n "${MFC_KERNEL_ROOT:-}"; then flow_probe="$scratch/managed-flow"; mkdir -p "$flow_probe"; cd "$flow_probe"; git init -q; git config user.name mfc-probe; git config user.email mfc-probe@localhost; printf \'export const probe = 1;\\n\' > main.ts; git add main.ts; git commit -qm initial; printf \'%s\\n\' \'{"execution_contract":{"schema":"mae-flow-execution/1","host":"cloud","compile":"pipeline","ut_write":"agent","ut_run":"pipeline","codecheck":"pipeline","git_push":"host"},"UT生成方式":"仓内写法"}\' > .mae-flow-order.json; MAE_FLOW_HOST=cloud python3 "$MFC_KERNEL_ROOT/scripts/mae-flow.py" init > init.log; test -s .mae-flow.json; MAE_FLOW_HOST=cloud python3 "$MFC_KERNEL_ROOT/scripts/mae-flow.py" current > current.log; grep -q \'config_confirm\\|配置确认\' current.log; if MAE_FLOW_HOST=cloud python3 "$MFC_KERNEL_ROOT/scripts/mae-flow.py" gate edit main.ts > gate.log 2>&1; then echo \'managed flow edit gate unexpectedly allowed source write\' >&2; exit 41; fi; grep -q \'交付方式尚未选定\' gate.log; cd "$OLDPWD"; fi',
        'printf \'class MfcSelfCheck { public static void main(String[] a) { System.out.print("java-ok"); } }\\n\' > "$scratch/MfcSelfCheck.java"',
        'javac -d "$scratch" "$scratch/MfcSelfCheck.java"',
        'java -cp "$scratch" MfcSelfCheck',
        'printf \'#include <iostream>\\nint main(){std::cout<<" cpp-ok";}\\n\' > "$scratch/check.cpp"',
        'c++ "$scratch/check.cpp" -o "$scratch/check"',
        '"$scratch/check"',
        "node -e 'process.stdout.write(\" node-ok\")'",
        'printf \' __MFC_CONTAINER_TOOLCHAIN_OK__\\n\'',
      ].join("; ");
      const execute = () => container.exec(command, workspace, {
        timeout: 60,
        onData: (chunk) => { output += chunk.toString(); },
      });
      const result = await (trace ? trace.phase("container.exec", execute) : execute());
      if (result.exitCode !== 0
          || !output.includes("__MFC_CONTAINER_TOOLCHAIN_OK__")) {
        throw new Error(`容器工具链自检退出码 ${result.exitCode}`);
      }
      failurePhase = "verify-metadata";
      const immutable = container.metadata?.immutableImageReference
        ?? isolation.image;
      detail = `镜像 ${immutable} 已真实启动；passwd HOME 与容器 HOME 一致，`
        + `Maven 实际运行于 JDK 21 且 JVM cacerts 可读${expectsMavenSettings
          ? "、部署 Maven settings 已接入" : ""}；bind 工作区可写并以 JDK 21/Maven、`
        + "C/C++ 完成编译执行，Maven/npm/ccache/XDG 缓存均可写；"
        + "Node 18+/npm 9+、Git、Python 工具及 profile/CA/可选平台 CLI"
        + `${kernelRoot ? "、Mae-Flow 内核挂载" : ""}权限通过`;
      if (output.includes("__MFC_CCACHE_OPTIONAL_MISSING__")) detail += "；ccache 未安装，使用原生编译器（不影响编译）";
      if (kernelRoot) {
        detail += "；容器内托管任务 init/current 与配置阶段源码写入拦截通过";
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await (trace ? trace.phase("container.stop", () => container.stop()) : container.stop());
      } catch (error) {
        failurePhase = failure ? `${failurePhase}+cleanup` : "cleanup";
        failure = failure
          ? new AggregateError([failure, error], "自检容器执行及清理均失败")
          : error;
      }
    }
    if (!failure) return { ready: true, detail };
    const tail = output.trim().split("\n").slice(-8).join(" | ");
    const metadata = container.metadata;
    const context = `phase=${failurePhase === "start" ? container.diagnostics?.phase ?? failurePhase : failurePhase} role=system-check name=${containerName}`
      + ` id=${(metadata?.containerId ?? container.diagnostics?.containerId)?.slice(0, 12) ?? "unknown"}`
      + ` image=${metadata?.immutableImageReference ?? isolation.image}`;
    return {
      ready: false,
      detail: "统一任务容器或其工具链不可用",
      suggestion: `${context}: ${String(failure)}`
        + `${tail ? `；末段输出: ${tail}` : ""}`,
    };
  }

  /** 管理员部署自检：不发送测试消息、不创建业务任务，也不改变运行配置；
   * 会启动并销毁一个短命构建容器，以免把宿主工具链误报成任务可用。 */
  systemCheckStatus() { return this.systemCheckTrace?.snapshot(); }

  systemCheck(): Promise<SystemCheckResult> {
    // 部署脚本与管理页同时自检时共用正在执行的检查，避免重复启动容器。
    if (this.activeSystemCheck) return this.activeSystemCheck;
    const trace = this.systemCheckTrace = new SystemCheckTrace(this.options.log);
    this.activeSystemCheck = Promise.resolve().then(() => this.runSystemCheck(trace)).then(result => {
      trace.finish({ overall: result.overall, checks: result.items.map(item => ({ key: item.key, status: item.status })) });
      return result;
    }, error => { trace.finish({ error: true }); throw error; }).finally(() => {
      this.activeSystemCheck = undefined; this.systemCheckTrace = undefined;
    });
    return this.activeSystemCheck;
  }

  private runSystemCheck(trace: SystemCheckTrace): Promise<SystemCheckResult> {
    return runDeploymentCheck({ options: this.options, model: this.activeModelChoice(),
      vision: this.activeVisionChoice(), linkBase: this.notificationLinkBase(),
      platform: this.effectivePlatformUrl(), buildSlots: this.prePushBuildSlotCount(), trace,
      refreshPlatform: () => this.refreshDeliveryPlatformCheck(),
      probeContainer: () => this.probeTaskContainerToolchain(trace) });
  }

  private project(task: TaskState, includeKnowledgeUsage = false, preparedPlan?: ExecutionPlanReading): TaskSummary {
    this.refreshRequirementGraph(task);
    const record = task.notifyRecord;
    const summary = this.moduleOwnership(task.summary);
    let feedback: FeedbackRecord[] = [];
    let feedbackError: string | undefined;
    try {
      feedback = new FeedbackStore(
        join(task.summary.workspace, "feedback", "index.jsonl"),
      ).list();
    } catch (error) {
      feedbackError = `这张任务的持续检视索引损坏，已隔离该任务并等待从内核恢复：${
        String(error).slice(0, 500)}`;
    }
    // 进度条只有一套词表(内核 flow/phases.json)。有内核脉冲就照它;没有
    // (还没开工、分析主任务不跑内核、老任务旧词表)才按任务状态占一段。
    // 原来这里在进入持续检视后强行换成本仓自己写的五段——和内核看板、
    // 前端兜底各说各话,老任务停在哪套显示哪套,点阶段名去内核方案词表里
    // 按名字找也必然落空(用户实锤:黄字"不匹配")。
    const rawProgress = this.taskProgress(task);
    const progress: TaskProgress | undefined = rawProgress?.phases.length
      ? rawProgress
      : this.placeholderProgress(task, rawProgress) ?? rawProgress;
    const requirementGraph = summary.requirement_graph
      ? {
          ...summary.requirement_graph,
          dependencies: scheduledGraphDependencies(this.dependencyHost(), summary.requirement_graph),
          repositories: summary.requirement_graph.repositories.map((repository) => {
            const child = repository.task_id
              ? this.tasks.get(repository.task_id) : undefined;
            return child ? {
              ...repository,
              ticket: child.summary.ticket,
              task_status: child.summary.status,
              current_phase: this.taskProgress(child)?.current_phase,
            } : { ...repository };
          }),
        }
      : undefined;
    const parent = summary.parent_task_id
      ? this.tasks.get(summary.parent_task_id) : undefined;
    const planReading = includeKnowledgeUsage
      ? preparedPlan ?? readCurrentExecutionPlanReading({
          kernelRoot: this.options.host?.kernelRoot,
          workspace: task.cwd ?? summary.workspace,
          python: this.options.host?.python,
        })
      : undefined;
    const executionPlan = planReading?.plan;
    // 活方案对拍(审计 P0-1):定制链路上任何一环退化都必须走到人眼前。
    const planAlerts: string[] = [];
    if (planReading) {
      planAlerts.push(...planReading.kernel_warnings);
      for (const diag of executionPlan?.customization.diagnostics ?? []) {
        if (diag.code === "profile_invalid") {
          planAlerts.push(`⚠ ${diag.message}`);
        }
      }
      if (!planAlerts.length && executionPlan
          && hasStructuralWorkflowProjectionMismatch(
            summary.workflow_profile, executionPlan)) {
        // 这里只处理真正带 final_snapshot 的结构化定格。补充型 profile
        // 正常来源就是 platform_default+overrides，已由上面的谓词排除；
        // 结构化方案退化时按事实说投影缺失，不把责任推给 Agent。
        planAlerts.push(
          "⚠ 本任务下单时定格的工作流方案投影缺失或未被内核读到"
          + `(内核实际执行来源: ${executionPlan.customization.effective_source})`
          + "——通常为投影缺失而非执行偏离;若需确认,请核对任务详情中的方案指纹。");
      }
    }
    const contractStep = this.reviewContractStep(task, summary.waiting);
    // cloud_push_confirm 是 Cloud 自己生成的卡，不在内核 flow.json 里。
    // 云端原生卡隔离内核脉冲，不继承当前内核步骤的检视与选项语义。
    // 在同一处把关闭/返工语义投影出去，历史待办读取时也能立即恢复。
    const choiceEffects: StepChoiceEffect[] = summary.waiting?.step === HOST_PUSH_CONFIRM_STEP
      ? HOST_PUSH_CHOICE_EFFECTS : summary.waiting?.step === CLOUD_SPLIT_PROPOSAL_STEP
        ? [{
            key: "split",
            answers: [SPLIT_PROPOSAL_ACCEPT],
            allowsSourceEdit: false,
            handlesFeedback: false,
            closesFeedback: false,
          }, {
            key: "decline",
            answers: [SPLIT_PROPOSAL_DECLINE],
            allowsSourceEdit: false,
            handlesFeedback: false,
            closesFeedback: false,
          }]
      : summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP
        ? [{
            key: "confirm",
            answers: [PUSH_CONFIRM_ACCEPT, "确认按清单推送", "确认推送并进入检视"],
            allowsSourceEdit: false,
            handlesFeedback: false,
            closesFeedback: true,
          }, {
            key: "rework",
            answers: [PUSH_CONFIRM_REWORK, "需要调整代码（按清单返工）"],
            allowsSourceEdit: true,
            handlesFeedback: true,
            closesFeedback: false,
          }]
        : stepChoiceEffects(
            this.options.host?.kernelRoot,
            contractStep,
          );
    const reviewContract = summary.waiting ? reviewDecisionContract(requirementDecisionContract(summary.waiting.question, this.isRequirementAnalysis(task)), choiceEffects) : undefined;
    const recommendedView: "source" | "doc" | "chain" | "diff" | undefined =
      summary.waiting?.step === HOST_PUSH_CONFIRM_STEP ? "diff"
      : summary.waiting?.step === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP
        || summary.waiting?.step === CLOUD_SPLIT_PROPOSAL_STEP
        || summary.waiting?.step === MR_DESCRIPTION_STEP
        ? "source"
      : this.isRequirementAnalysis(task)
      ? "chain"
      // 云端原生步骤的检视面由云端自己钉死,不搭内核映射的兜底便车。
      : summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP
        ? "diff"
        : stepReviewSurface(
            this.options.host?.kernelRoot,
            contractStep,
          );
    // 排队位次投影:status=queued 时人第一想知道的是"排到哪了"。
    const queueIndex = summary.status === "queued"
      ? runnableQueueIndex(this.dependencyHost(true), this.queue, summary.id) : -1;
    const projectedDelivery = summary.delivery
      ? {
          ...summary.delivery,
          ...(summary.delivery.prepush ? {
            prepush_runtime: this.prePushRuntime(task),
          } : {}),
        }
      : undefined;
    const projected = {
      ...summary,
      requirement_graph: requirementGraph,
      parent_task: parent ? {
        id: parent.summary.id,
        title: parent.summary.title,
        ticket: parent.summary.ticket,
        status: parent.summary.status,
      } : undefined,
      delivery: projectedDelivery,
      delivery_report: deliveryReportView(summary.workspace),
      // 开发助手占场时,"从当前现场恢复"是条死路(resume 会 409 让人
      // 去交还)——focus 必须知道占场事实才能指对路(MFC-029)。
      ...(task.assistantActive ? { assistant_engaged: true } : {}),
      ...(queueIndex >= 0 ? { queue_position: queueIndex + 1 } : {}),
      title: summary.title ?? taskTitle(summary.requirement),
      updated_at: summary.updated_at ?? summary.created_at,
      last_progress_at: taskProgressTimestamp(summary),
      notify: record
        ? {
            delivered: record.delivered,
            settled: record.settled,
            attempts: record.attempts,
            last_error: record.last_error,
          }
        : undefined,
      progress,
      execution_plan: executionPlan,
      ...(planAlerts.length ? { execution_plan_alerts: planAlerts } : {}),
      token_usage: tokenUsageSnapshot(task.tokenUsage),
      model_lane: summary.model_lane,
      waiting: summary.waiting
        ? {
            ...summary.waiting,
            question: reviewContract!.question,
            ...(recommendedView ? { recommended_view: recommendedView } : {}),
            ...(choiceEffects.length ? {
              choice_effects: reviewContract!.effects.map((effect) => ({
                key: effect.key,
                answers: effect.answers,
                allows_source_edit: effect.allowsSourceEdit,
                handles_feedback: effect.handlesFeedback,
                closes_feedback: effect.closesFeedback,
              })),
            } : {}),
          }
        : undefined,
      knowledge_usage: includeKnowledgeUsage
        ? knowledgeUsageSnapshot({
            workspace: task.summary.workspace,
            selectedSkills: summary.repository_skills,
            businessModules: summary.business_modules,
          })
        : undefined,
      ...(feedback.length ? { feedback } : {}),
      ...(feedbackError ? { feedback_error: feedbackError } : {}),
    };
    return { ...projected, focus: projectTaskFocus(projected),
      status_label: projectStatusLabel(projected), repair_stopped: projectRepairStopped(projected) };
  }

  /** 知识足迹是 Cloud 观测旁路：阶段只读内核投影，写失败不影响任务。 */
  private knowledgeTrace(task: TaskState, cwd: string): KnowledgeTrace {
    return new KnowledgeTrace(
      join(task.summary.workspace, "knowledge-events.jsonl"),
      task.summary.id,
      cwd,
      () => this.taskProgress(task)?.step ?? "",
      this.options.log,
    );
  }

  private isRequirementAnalysis(task: TaskState): boolean {
    // 多仓天然先分析;单仓在下单时显式勾选"大需求先拆分"也走同一条
    // 分析→确认→拆单链路(单仓拆分,docs/delivery-unit-split-design.md)。
    return ((task.summary.repositories?.length ?? 0) > 1
        || task.summary.requirement_analysis_requested === true)
      && !task.summary.parent_task_id;
  }

  /** 只有最终拆分方案确认卡才是“送审”边界。分析过程中的普通澄清卡、
   * 页面轮询和文件保存都不能把半成品封版。 */
  private isRequirementGraphReviewWaiting(
    task: TaskState,
    waiting: WaitingRecord | undefined = task.summary.waiting,
  ): boolean {
    if (!waiting || !this.isRequirementAnalysis(task)) return false;
    const questions = (requirementDecisionContract(waiting.question, true).questions ?? []) as Array<{
      options?: string[];
    }>;
    return questions.some((question) => (question.options ?? [])
      .some((option) => confirmsRequirementGraph(String(option))));
  }

  /** 新下单先停在工作台的需求原文检视：人只提批注，专用 Agent
   * 修改当前正本；只有主责任人明确确认才启动正式需求分析。 */
  private openRequirementAnalysisConfirmation(task: TaskState): WaitingRecord {
    const waiting = task.humanGate.createWaiting({
      taskId: task.summary.id,
      step: CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP,
      callId: `requirement-analysis-${randomUUID()}`,
      questionInput: { questions: [{
        question: "需求原文是否已经确认？",
        options: [REQUIREMENT_ANALYSIS_ACCEPT],
      }] },
      context: "请在左侧需求原文上圈选内容并填写检视意见，提交后由 Agent 修改。所有意见闭环后，确认当前文档并启动需求分析。",
    });
    task.summary.waiting = waiting;
    task.summary.status = "waiting_for_human";
    task.summary.detail = "正在工作台检视需求文档，确认后进入需求分析";
    return waiting;
  }

  private requirementAnalysisEntryAccepted(waiting: WaitingRecord): boolean {
    return [...Object.values(waiting.answers ?? {}), waiting.decision]
      .some((answer) => answer === REQUIREMENT_ANALYSIS_ACCEPT);
  }

  private finishRequirementAnalysisEntryDecision(
    task: TaskState,
    waiting: WaitingRecord,
  ): void {
    if (this.requirementAnalysisEntryAccepted(waiting)) {
      task.summary.requirement_analysis_confirmed_at = waiting.resolved_at
        || new Date().toISOString();
      task.summary.requirement_revision = undefined;
      task.summary.waiting = undefined;
      task.summary.status = "queued";
      task.summary.detail = "已确认进入需求分析，需求文档已锁定，等待启动";
      this.persist(task);
      if (!this.queue.includes(task.summary.id)) this.queue.push(task.summary.id);
      this.bypass(undefined, "任务泵", this.pump());
      return;
    }
    this.openRequirementAnalysisConfirmation(task);
    this.persist(task);
    this.notifyWaiting(task);
  }

  private taskProgress(task: TaskState): TaskProgress | undefined {
    return this.readProgress(task);
  }

  private currentStepLabel(task: TaskState): string {
    return this.taskProgress(task)?.step ?? "";
  }

  /** WaitingRecord.step 是通知与页面共用的人话标题；流程契约必须读 pulse
   * 里的稳定步骤 ID。旧任务或纯会话模式没有 pulse 时才兼容原字段。 */
  private reviewContractStep(
    task: TaskState,
    waiting: Pick<WaitingRecord, "step"> | undefined,
  ): string | undefined {
    return waiting?.step === HOST_PUSH_CONFIRM_STEP ? waiting.step : this.taskProgress(task)?.step_id ?? waiting?.step;
  }

  /** 内核没给脉冲时按任务状态占一段。占哪一段由 flow/phases.json 的
   * placeholders 按角色指定(受理未开工 / 大需求分析中 / 拆分后子任务
   * 开发中 / 终态),名字一律来自那份文件,这里不写任何阶段字面量。 */
  private placeholderProgress(
    task: TaskState,
    raw?: TaskProgress,
  ): TaskProgress | undefined {
    const vocabulary = this.phaseVocabulary();
    if (!vocabulary) return undefined;
    const { names: phases, placeholders } = vocabulary;
    const summary = task.summary;
    const analysis = this.isRequirementAnalysis(task);
    const phase = summary.status === "completed" ? placeholders.terminal
      : analysis
        ? (summary.requirement_graph?.stage === "analysis"
          ? placeholders.analysis : placeholders.delivering)
        : placeholders.queued;
    const index = phases.indexOf(phase);
    return {
      phases,
      current_index: index,
      current_phase: phase,
      // 脉冲里的步骤事实(step_id/标题/里程碑)是契约,轨道占位不吞掉它们。
      ...(raw?.step_id ? { step_id: raw.step_id } : {}),
      ...(raw?.revision !== undefined ? { revision: raw.revision } : {}),
      ...(raw?.milestone ? { milestone: raw.milestone } : {}),
      step: summary.status === "completed"
        ? (summary.delivery?.mr_url ? "MR 已合入，任务完成" : "任务完成")
        : raw?.step ?? summary.detail,
    };
  }

  /** Agent 写结构化投影，Markdown 仍是给人检视的正文。下单时那份一仓
   * 一节点的数据只用于展示候选仓，绝不能在这里“读取失败就沿用”——那会
   * 把候选仓直接建成子任务。分析期任何缺失/坏产物都显式标成未就绪。 */
  private refreshRequirementGraph(task: TaskState): void {
    if (!this.isRequirementAnalysis(task)
        || ["canceled", "completed", "failed"].includes(task.summary.status)) {
      this.requirementGraphCorrections.delete(task.summary.id);
    }
    if (!this.isRequirementAnalysis(task) || !task.cwd) return;
    const previous = task.summary.requirement_graph;
    // 已确认的图已经成为任务编排事实，不再让工作区文件反向改写它。
    if (previous?.stage === "confirmed"
        || task.summary.status === "coordinating") {
      this.requirementGraphCorrections.delete(task.summary.id);
      return;
    }
    const ticket = task.summary.ticket ?? task.summary.id;
    const path = join(task.cwd, ".mae-flow-work", ticket,
      "requirement-graph.json");
    const plan = readRequirementPlan(task.cwd, ticket);
    const markUnavailable = (
      state: "pending" | "invalid",
      message?: string,
    ): void => {
      if (!task.summary.requirement_graph) return;
      task.summary.requirement_graph.projection_state = state;
      task.summary.requirement_graph.projection_error = message;
    };
    if (!existsSync(path)) {
      markUnavailable("pending");
      return;
    }
    let graphSource = "";
    try {
      if (!plan?.content.trim() || plan.truncated) {
        throw new Error("缺少完整全局 Story（旧任务可用 CHAIN），无法核对机读图来自哪一版设计");
      }
      graphSource = readFileSync(path, "utf-8");
      const source = parseRequirementProjectionSources(
        graphSource, plan.content, plan.source_document);
      const { planRevision, actualChainSha, projectionSha, declaresSyncContract } = source;
      if (!declaresSyncContract) {
        // 上线前已经生成并等待用户检视的存量图没有修订字段。先照常展示，
        // 并记住此刻两份原文的摘要；一旦任一份变化，必须升级契约，不能
        // 借“兼容旧单”永久绕过同步校验。新任务从创建时就带 strict 标记。
        if (previous?.sync_required) {
          throw new Error("机读依赖图仍是旧格式；请让 Agent 同步更新方案文档和依赖图后再确认");
        }
        if ((previous?.chain_sha256 && previous.chain_sha256 !== actualChainSha)
            || (previous?.projection_sha256
              && previous.projection_sha256 !== projectionSha)) {
          throw new Error("存量方案已经发生修改；请让 Agent 同步更新两份产物并补充 plan_revision");
        }
      } else {
        const sealed = previous?.review_snapshot;
        const activeSealedReview = sealed
          && task.summary.status === "waiting_for_human"
          && task.summary.waiting?.waiting_id === sealed.waiting_id
          && this.isRequirementGraphReviewWaiting(task);
        if (activeSealedReview
            && (sealed.plan_revision !== planRevision
              || sealed.chain_sha256 !== actualChainSha
              || sealed.projection_sha256 !== projectionSha)) {
          throw new Error(
            `送审中的版本 ${sealed.plan_revision} 已发生变化；请先选择“需要修改”，`
            + "完成返工并生成新版本后再送审",
          );
        }
        if (sealed?.plan_revision === planRevision
            && (sealed.chain_sha256 !== actualChainSha
              || sealed.projection_sha256 !== projectionSha)) {
          throw new Error(`版本 ${planRevision} 已经送审，产物内容不能原地改写；请同时更新两份产物并换用新的 plan_revision`);
        }
        if ((previous?.reviewed_plan_revisions ?? []).includes(planRevision)
            && sealed?.plan_revision !== planRevision) {
          throw new Error(`版本号 ${planRevision} 已经送审过，不能重复使用；请换用新的 plan_revision`);
        }
      }
      const { assessments, repositories, dependencies } = validateRequirementProjection(
        source, task.summary.repositories ?? [], previous);
      this.requirementGraphCorrections.delete(task.summary.id);
      task.summary.requirement_graph = {
        stage: task.summary.requirement_graph?.stage ?? "analysis",
        projection_state: "ready",
        sync_required: declaresSyncContract,
        ...(planRevision ? { plan_revision: planRevision } : {}),
        chain_sha256: actualChainSha,
        source_document: plan.source_document,
        projection_sha256: projectionSha,
        ...(previous?.review_snapshot ? {
          review_snapshot: { ...previous.review_snapshot },
        } : {}),
        ...(previous?.reviewed_plan_revisions?.length ? {
          reviewed_plan_revisions: [...previous.reviewed_plan_revisions],
        } : {}),
        repository_assessments: assessments,
        repositories,
        dependencies,
      };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof RequirementGraphContractError) {
        this.correctRequirementGraph(task, graphSource, error);
        const attempts = this.requirementGraphCorrections.get(task.summary.id)?.count ?? 0;
        if (attempts >= 2) message += `（已自动提示 Agent 修正 ${attempts} 轮，仍未通过）`;
      }
      markUnavailable("invalid", message);
      this.options.log?.(`任务 ${task.summary.id} 模块依赖图不可用: ${message}`);
    }
  }

  private correctRequirementGraph(
    task: TaskState, source: string, error: RequirementGraphContractError,
  ): void {
    if (!this.isRequirementAnalysis(task) || task.summary.status !== "running"
        || !task.driver || task.assistantActive || this.isRequirementGraphReviewWaiting(task)) return;
    const correction = this.requirementGraphCorrections.get(task.summary.id)
      ?? { count: 0, fingerprints: new Set<string>() };
    if (correction.count >= 2) return;
    const fingerprint = createHash("sha256").update(source).update("\0").update(error.message).digest("hex");
    if (correction.fingerprints.has(fingerprint)) return;
    correction.count++;
    correction.fingerprints.add(fingerprint);
    this.requirementGraphCorrections.set(task.summary.id, correction);
    const message = "requirement-graph.json 不符合契约：\n"
      + error.problems.map(problem => `- ${problem}`).join("\n")
      + "\n请只修正该文件，不要改 story.md 正文；补齐后结束本轮。";
    // 仍用原会话插话；回合间隙未送达的消息由 settleTurn 原有续跑路径消费。
    try {
      this.bypass(task, "反馈依赖图契约错误", task.driver.steer(message));
    } catch (failure) {
      this.options.log?.(`任务 ${task.summary.id} 依赖图修正提示未送达: ${String(failure)}`);
    }
  }

  /** 把“人此刻看到的方案”封成不可变快照。封版只发生在最终确认卡
   * 出现时；同一轮 Agent 在举卡前可以反复完善同一个 revision。 */
  private sealRequirementGraphReview(
    task: TaskState,
    waiting: WaitingRecord | undefined = task.summary.waiting,
  ): boolean {
    if (!this.isRequirementGraphReviewWaiting(task, waiting)) return false;
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    if (!graph || graph.projection_state !== "ready"
        || !graph.plan_revision || !graph.chain_sha256
        || !graph.projection_sha256 || !waiting) {
      return false;
    }
    const previous = graph.review_snapshot;
    if (previous?.waiting_id === waiting.waiting_id
        && previous.plan_revision === graph.plan_revision
        && previous.chain_sha256 === graph.chain_sha256
        && previous.projection_sha256 === graph.projection_sha256) {
      return false;
    }
    const reviewed = new Set(graph.reviewed_plan_revisions ?? []);
    if (reviewed.has(graph.plan_revision)
        && (previous?.plan_revision !== graph.plan_revision
          || previous.chain_sha256 !== graph.chain_sha256
          || previous.projection_sha256 !== graph.projection_sha256)) {
      graph.projection_state = "invalid";
      graph.projection_error = `版本号 ${graph.plan_revision} 已经送审过，不能重复使用；请换用新的 plan_revision`;
      return false;
    }
    reviewed.add(graph.plan_revision);
    graph.review_snapshot = {
      waiting_id: waiting.waiting_id,
      plan_revision: graph.plan_revision,
      chain_sha256: graph.chain_sha256,
      projection_sha256: graph.projection_sha256,
      sealed_at: new Date().toISOString(),
    };
    graph.reviewed_plan_revisions = [...reviewed];
    return true;
  }

  /** 进度条的阶段词表:内核 flow/phases.json,随 kernel/ 快照发布;
   * 没配 host 时用本仓随发布的快照(serve 的内核发现规则同源)。 */
  private phaseVocabulary(): KernelPhaseVocabulary | undefined {
    return kernelPhases(this.options.host?.kernelRoot
      ?? discoverKernelRoot(resolve(process.cwd())));
  }

  /** 列表里的阶段轨道必须与现场看板同源，不能在 Web 复刻状态机。
   * pulse 给当前阶段/步骤(内核按 flow/phases.json 算好),阶段顺序读同一份
   * phases.json;pulse 未变化就复用缓存。
   *
   * 2026-09-02 起不再解析 panel.html 拿阶段顺序:panel.html 只在 Agent 的
   * Hook 事件里重生成,宿主推进的阶段(登记 PASS、合入收口)它跟不上;
   * 而且老任务的 panel.html 还是旧词表。脉冲里的阶段名不在当前词表里
   * (老任务、旧内核)就当没有内核进度,交给占位进度按状态给一段,
   * 绝不把旧词表原样端出来——那正是"每个任务进度条都不一样"的来源。 */
  private readProgress(task: TaskState): TaskProgress | undefined {
    if (!task.cwd) return undefined;
    const pulsePath = join(task.cwd, ".mae-flow-work", "panel-pulse.js");
    if (!existsSync(pulsePath)) return undefined;
    // 词表缺失或脉冲里的阶段名不在词表里(老任务、旧内核、测试夹具的
    // 假内核):阶段轨道留空,但 step_id / 步骤标题 / 里程碑照常给——
    // 检视面、流程契约都靠脉冲里的 step_id,不能因为画不了轨道就丢掉。
    const phases = this.phaseVocabulary()?.names ?? [];
    try {
      const pulseText = readFileSync(pulsePath, "utf-8");
      const milestonePath = join(task.cwd, ".mae-flow.json.build-milestones");
      const milestoneText = existsSync(milestonePath)
        ? readFileSync(milestonePath, "utf-8") : "";
      const progressSource = `${phases.join("\0")}\0${pulseText}\0${milestoneText}`;
      if (progressSource === task.progressPulse) return task.progressCache;
      const first = pulseText.indexOf("{");
      const last = pulseText.lastIndexOf("}");
      if (first < 0 || last <= first) return undefined;
      const pulse = JSON.parse(pulseText.slice(first, last + 1));
      const currentPhase = String(pulse.phase ?? "").trim();
      const currentIndex = phases.indexOf(currentPhase);
      // 脉冲带着旧词表的阶段名(阶段词表升级前的老任务):让内核按当前
      // 词表重写一次,写完缓存自然失效、下次投影就对了。只试一次,旁路。
      if (currentIndex < 0 && currentPhase && phases.length
          && this.options.host && !task.pulseRefreshAttempted) {
        task.pulseRefreshAttempted = true;
        const cwd = task.cwd;
        this.bypass(task, "按当前阶段词表重写内核脉冲",
          refreshKernelPanel({ host: this.options.host, cwd })
            .then(() => { task.progressPulse = undefined; }));
      }
      const milestone = String(pulse.step ?? "") === "build"
        ? latestBuildMilestone(milestoneText) : undefined;
      const progress: TaskProgress = {
        phases: currentIndex >= 0 ? phases : [],
        current_index: currentIndex,
        current_phase: currentIndex >= 0 ? currentPhase : "",
        step_id: pulse.step ? String(pulse.step) : undefined,
        step: pulse.step_title ? String(pulse.step_title) : undefined,
        revision: Number.isFinite(Number(pulse.revision))
          ? Number(pulse.revision) : undefined,
        ...(milestone ? { milestone } : {}),
      };
      if (progressAdvanced(task.progressCache, progress)) {
        const at = Math.max(lstatSync(pulsePath).mtimeMs, milestone ? lstatSync(milestonePath).mtimeMs : 0);
        if (at > Date.parse(task.summary.last_progress_at ?? task.summary.created_at)) {
          task.summary.last_progress_at = new Date(at).toISOString();
          this.writeTaskState(task);
        }
      }
      task.progressPulse = progressSource;
      task.progressCache = progress;
      return progress;
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 进度摘要读取失败: ${String(error)}`);
      return undefined;
    }
  }

  eventLogPath(id: string): string {
    return join(this.tasks.get(id)!.summary.workspace, "events.jsonl");
  }

  /** 最新一轮推送前验证的事件日志路径(轮号最大者)。还没有任何轮目录
   * 时返回 undefined——SSE 端每拍重解析,等它出现;换轮(修复后新
   * HEAD 再验)时路径变化,SSE 端据此重置偏移从头放新一轮。
   * 用户点名的可观测性缺口:prepush 会话的事件一直落在轮目录里,
   * 但没有任何接口流出去,页面只有粗粒度 state。 */
  prePushEventLogPath(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const root = join(task.summary.workspace, "prepush");
    let best: { round: number; dir: string } | undefined;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = /^round-(\d+)-/.exec(entry.name);
        if (!match) continue;
        const round = Number(match[1]);
        if (!best || round > best.round) {
          best = { round, dir: join(root, entry.name) };
        }
      }
    } catch {
      return undefined; // prepush/ 还没建:本任务尚未走到推送前验证
    }
    return best ? join(best.dir, "events.jsonl") : undefined;
  }

  warmupEventLogPath(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const path = join(task.summary.workspace, "warmup", "events.jsonl");
    return existsSync(path) ? path : undefined;
  }

  /** 基线现场就绪即后台预编译；恢复需核对基线，不以会话次数判断。
   * 编译失败只记事实，不阻断主任务。 */
  private startBaselineWarmup(task: TaskState, epoch: number): void {
    try {
      const configured = this.options.warmup;
      if (!configured || configured.enabled === false) return;
      // 原生路径要真容器;测试注入 runner 时放行。
      if (!configured.runner && !this.options.isolation) return;
      if (this.isRequirementAnalysis(task)) return; // 分析单没有可编译的仓
      if (!task.cwd || task.warmupActive) return;
      // 中断/基础设施失败不等于编译完成；恢复时按真实基线核对后补跑。
      if (task.summary.baseline_build?.finished_at
          && task.summary.baseline_build.status !== "infrastructure_failure") return;
      task.warmupActive = true;
      void this.performBaselineWarmup(task, task.resume === true)
        .catch((error) => this.options.log?.(
          `任务 ${task.summary.id} 环境预热异常(fail-open): ${String(error)}`))
        .finally(() => { task.warmupActive = false; });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 环境预热启动失败(fail-open): ${String(error)}`);
    }
  }

  private async performBaselineWarmup(task: TaskState, resuming: boolean): Promise<void> {
    const sessionEpoch = auxiliarySessionEpoch(task);
    const head = await runSafeWorktreeGitAsync(
      task.cwd!, ["rev-parse", "--verify", "HEAD"], { timeoutMs: 30_000 });
    if (this.shuttingDown || auxiliarySessionEpoch(task) !== sessionEpoch) return;
    const sha = String(head.stdout ?? "").trim();
    const startedAt = new Date().toISOString();
    if (head.status !== 0 || !sha) {
      task.summary.baseline_build = {
        status: "infrastructure_failure", sha: "",
        detail: `读取基线 HEAD 失败: ${String(head.stderr ?? "").slice(0, 200)}`,
        started_at: startedAt, finished_at: new Date().toISOString(),
      };
      this.persist(task);
      return;
    }
    if (resuming && !await resumedWarmupBaselineMatches(task.cwd!, sha,
        task.summary.baseline_build?.sha, task.summary.baseline)) {
      this.options.log?.(`任务 ${task.summary.id} 未补跑基线预编译：当前 HEAD 已变化或基线无法确认`);
      return;
    }
    // 工作区已有业务改动 = 这不再是基线,预热收据会把半成品的编译错
    // 扣到"环境/上游"头上——宁可不预热,不出冤案。不落收据:没跑
    // 就是没跑,不伪装成基础设施故障。
    const dirty = await this.prePushDirtyPaths(task);
    if (this.shuttingDown || auxiliarySessionEpoch(task) !== sessionEpoch) return;
    if (dirty.length) {
      this.options.log?.(
        `任务 ${task.summary.id} 工作区已有改动(${dirty.length} 处),`
        + "跳过基线预热——预热只评判基线代码");
      return;
    }
    task.summary.baseline_build = {
      status: "running", sha, started_at: startedAt,
    };
    this.persist(task);
    this.options.log?.(
      `任务 ${task.summary.id} 环境预热开跑(基线 ${sha.slice(0, 12)})`);
    const request: WarmupRunRequest = {
      taskId: task.summary.id, workspace: task.cwd!, sha,
    };
    let result: WarmupRunResult;
    try {
      result = await (this.options.warmup?.runner
        ? this.options.warmup.runner(request)
        : this.runCloudWarmupAgent(task, request, sessionEpoch));
    } catch (error) {
      result = {
        status: "infrastructure_failure",
        message: String(
          error instanceof Error ? error.message : error).slice(0, 300),
      };
    }
    if (this.shuttingDown || auxiliarySessionEpoch(task) !== sessionEpoch || !this.tasks.has(task.summary.id)) return;
    task.summary.baseline_build = {
      status: result.status,
      sha,
      ...(result.message ? { detail: result.message.slice(0, 600) } : {}),
      ...(result.build_command
        ? { build_command: result.build_command } : {}),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
    this.persist(task);
    this.options.log?.(
      `任务 ${task.summary.id} 环境预热收口: ${result.status}`
      + (result.message ? ` — ${result.message.slice(0, 120)}` : ""));
  }

  /** 基线预热独立会话：复用编码容器，不修改源码、不产交付证据。 */
  private async runCloudWarmupAgent(
    task: TaskState,
    request: WarmupRunRequest,
    sessionEpoch: number,
  ): Promise<WarmupRunResult> {
    if (this.shuttingDown || auxiliarySessionEpoch(task) !== sessionEpoch) throw new TaskControlError("预热已停止");
    if (!task.cwd) throw new Error("环境预热缺少代码工作区");
    const agentDir = join(task.summary.workspace, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    this.hardenAgentGitBoundary(agentDir, task.cwd);
    // 同 prepush:build-notes 目录宿主预建,Agent 只写放行的那个文件。
    mkdirSync(join(task.cwd, ".mae-flow-work"), { recursive: true });
    const modelBundle = this.sessionModels(task);
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(modelBundle.json));
    const runRoot = join(task.summary.workspace, "warmup");
    mkdirSync(runRoot, { recursive: true });
    const eventLog = new EventLog(join(runRoot, "events.jsonl"));
    const transcript = new TranscriptStore(
      join(runRoot, "transcript.jsonl"), "main");
    const attemptTimeoutMs =
      this.options.warmup?.attemptTimeoutMs ?? (maeBuildRoot(task.cwd) ? 90 : 25) * 60_000;
    let timedOut = false;
    const driver = await CloudSession.create({
      taskId: `${task.summary.id}:warmup`,
      workspace: task.cwd,
      agentDir,
      repositoryResourceBlocks: () =>
        readResourceBlocks(this.options.dataDir),
      hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
      knowledgeModuleDataDir: this.options.dataDir,
      knowledgeContext: task.summary.host_skills_pinned ? undefined : {
        repositories: task.summary.repositories ?? [],
        technologies: [...new Set((task.summary.repository_profiles ?? [])
          .flatMap((profile) => profile.technologies))],
        businessModuleIds: (task.summary.business_modules ?? [])
          .map((module) => module.id),
      },
      repositorySkillPaths: [],
      repositorySkillResources: [],
      knowledgeTrace: this.knowledgeTrace(task, task.cwd),
      provider: modelBundle.choice?.provider ?? this.options.provider,
      model: modelBundle.choice?.model ?? this.options.model,
      eventLog,
      transcript,
      gate: new GateService({
        contract: createPrePushGateContract(this.options.contract),
        workspace: task.cwd,
        cwd: task.cwd,
        log: this.options.log,
        failClosed: Boolean(this.options.host),
      }),
      humanGate: task.humanGate,
      allowHumanQuestions: false,
      streamBashOutput: true,
      sessionId: "warmup",
      currentStep: () => "环境预热编译",
      compactAnchor: () =>
        `环境预热编译任务(基线 ${request.sha.slice(0, 12)})`,
      onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
      bashOperations: this.options.isolation
        ? {
            exec: async (command, dir, execOptions) => {
              if (auxiliarySessionEpoch(task) !== sessionEpoch) throw new TaskControlError("预热已停止");
              const container = await this.activeTaskContainer(task);
              if (auxiliarySessionEpoch(task) !== sessionEpoch) throw new TaskControlError("预热已停止");
              return container.exec(command, dir, { ...execOptions, timeout: prePushCommandTimeoutSeconds(command, execOptions.timeout,
                  resolvePrePushExecutionBudget(detectPrePushBuildProfile(task.cwd!), { attemptTimeoutMs })) });
            },
          }
        : undefined,
      afterFileMutation: this.options.isolation
        ? (path) => {
          repairContainerMutationOwnership({
            workspace: task.cwd!,
            path,
            user: this.options.isolation?.user,
          });
        }
        : undefined,
      log: this.options.log,
    });
    trackAuxiliarySession(task, driver, sessionEpoch);
    const timer = setTimeout(() => {
      timedOut = true;
      void driver.abort().catch(() => undefined);
    }, attemptTimeoutMs);
    timer.unref?.();
    try {
      let outcome = await driver.start(warmupMission(
        request, Math.round(attemptTimeoutMs / 60_000)));
      for (let correction = 0; correction < 2; correction += 1) {
        if (this.shuttingDown || auxiliarySessionEpoch(task) !== sessionEpoch) return { status: "infrastructure_failure", message: "预热已停止" };
        if (timedOut) {
          return {
            status: "infrastructure_failure",
            message: `环境预热超过 ${Math.ceil(attemptTimeoutMs / 60_000)} `
              + "分钟预算,已安全停止;不代表基线编译失败",
          };
        }
        if (outcome.status === "session_ended") {
          return {
            status: "infrastructure_failure",
            message: outcome.detail ?? outcome.reason ?? "预热会话异常结束",
          };
        }
        const report = parseWarmupReport(driver.finalReply());
        if (report) return report;
        // 报告缺失只是格式问题,给一次补交机会,别把整轮预热判死。
        outcome = await driver.continueWith(
          "预热尚未收口:请按任务说明输出单行 JSON 的 <warmup-result> 结构。");
      }
      return {
        status: "infrastructure_failure",
        message: "预热会话未产出合法的 <warmup-result> 报告",
      };
    } finally {
      clearTimeout(timer);
      untrackAuxiliarySession(task, driver);
      driver.dispose();
    }
  }

  /** 行为摘要只呈现事实；HTTP 传入共享的异步增量读取结果。 */
  activity(id: string, events = readActivityEvents(this.eventLogPath(id))): ActivityView {
    const task = this.tasks.get(id)!;
    return buildActivity(events, {
      running: task.summary.status === "running",
    });
  }

  /** 会话流(只读投影):事件账、决定账、批注账、反馈索引、开发助手
   * 往来拼成"谁对谁说了什么、现在轮到谁"。每本账各自降级,读不动的写进
   * problems——旁路绝不因一本账坏了把整栏拖没。 */
  conversation(id: string, events = readActivityEvents(this.eventLogPath(id))): ConversationView {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const workspace = task.summary.workspace;
    const problems: string[] = [];
    let waiting: WaitingRecord[] = [];
    try {
      waiting = task.humanGate.all();
    } catch (error) {
      problems.push(`决定账读取失败:${String(error).slice(0, 200)}`);
    }
    let annotations: Annotation[] = [];
    let annotationHistory: AnnotationOperation[] = [];
    try {
      const store = this.annotations(task);
      annotations = store.list();
      annotationHistory = store.history();
    } catch (error) {
      problems.push(`批注账读取失败:${String(error).slice(0, 200)}`);
    }
    let feedback: FeedbackRecord[] = [];
    try {
      feedback = new FeedbackStore(join(workspace, "feedback", "index.jsonl")).list();
    } catch (error) {
      problems.push(`持续检视索引读取失败:${String(error).slice(0, 200)}`);
    }
    let interrupts: ReturnType<TaskService["listInterrupts"]> = [];
    try {
      interrupts = this.listInterrupts(id, events as SemanticEvent[]);
    } catch {
      // listInterrupts 自己已 fail-open;这里只是双保险
    }
    let assistant: Array<{
      id: string; role: "user" | "assistant"; text: string; at: string;
    }> = [];
    try {
      // 只读快照,不走 developerAssistant():那条读法会顺手中断失活会话,
      // 投影不该有副作用。
      assistant = developerAssistantConversation(
        readDeveloperAssistant(workspace), events as SemanticEvent[]);
    } catch (error) {
      problems.push(`开发助手往来读取失败:${String(error).slice(0, 200)}`);
    }
    return buildConversation({
      events, waiting, annotations, annotationHistory, feedback, interrupts,
      assistant, running: task.summary.status === "running", problems,
      taskId: task.summary.id,
      crossRepositoryUpdates: task.summary.cross_repository_updates ?? [],
    });
  }

  /** 内核现场面板文件(panel.html / panel-pulse.js / panel-stamp.js)。
   * 名字白名单由路由把守,这里只按任务工作区定位;不存在返回 undefined。 */
  panelFile(id: string, name: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task?.cwd) return undefined;
    const file = join(task.cwd, ".mae-flow-work", name);
    return existsSync(file) ? file : undefined;
  }

  /** 检视产物的根:与 /artifacts 路由同一口径——批注重锚定回头读的
   * 必须是人当初圈的那份材料,两处口径分家就会出现"页面上有、重锚定
   * 说没有"。 */
  artifactRoot(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    // 某些演练/旧任务把 task.cwd 指向任务目录，而该目录也可能因团队
    // 知识投影含 `.mae-flow-work`；它不是 Git 代码现场，不能抢在真正
    // 的 `<workspace>/<repo>` 前面。全局分析现场是 repositories 容器目录，
    // 自身没有 .git；转拆分后必须优先它，不能又读到留下来的旧编码仓。
    const cwd = task.cwd && (
      existsSync(join(task.cwd, ".git"))
      || existsSync(join(task.cwd, ".mae-flow.json"))
      || (this.isRequirementAnalysis(task)
        && resolve(task.cwd) === resolve(task.summary.workspace, "repositories")))
      ? task.cwd : undefined;
    return resolveArtifactRoot(task.summary.workspace, cwd);
  }

  /** 代码浏览独立于审批：只读计算比较基点，不创建待办或写入授权。 */
  async diffReview(id: string): Promise<PushReviewPresentation | undefined> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!task.cwd) return undefined;
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot?.baseline) return undefined;
    return this.buildPushReviewPresentation(task, snapshot,
      Boolean(task.summary.delivery?.loop?.workspace_review_recheck_required));
  }

  /** Git ref 由服务端从任务历史选取；没有审批卡也能只读比较。 */
  async pushReviewDiff(
    id: string,
    scope: "changes" | "full",
  ): Promise<{ content: string; branch?: string; truncated?: boolean } | undefined> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!task.cwd) return undefined;
    if (scope === "changes") {
      const review = await this.diffReview(id);
      if (review?.has_focused_changes) {
        return compareDeliveryRevisions(task.cwd, review.base_sha, review.head_sha);
      }
    }
    const root = this.artifactRoot(id);
    return root ? readArtifactAsync(root, DIFF_NAME) : undefined;
  }

  private memoryStore?: MemoryStore;
  private memorySidecar?: MemorySidecar;
  private memorySweepTimer?: NodeJS.Timeout;

  private memories(): MemoryStore {
    return this.memoryStore ??= new MemoryStore(this.options.dataDir);
  }

  private refreshOwnerInputs(task: TaskState): void {
    try { refreshOwnerInputProjection(this.taskHostRuntime(task)); }
    catch (error) { this.options.log?.(`用户输入已落账，阅读副本更新失败：${String(error)}`); }
  }

  private annotations(task: TaskState): AnnotationStore {
    return new AnnotationStore(
      join(task.summary.workspace, "annotations.jsonl"), true, () => this.refreshOwnerInputs(task));
  }

  /* ---------------------------------------------------------------- *
   * 检视意见的"处理完成"闸(用户 2026-09-05 拍板):
   * 中途提交的意见 Agent 要及时处理;最终"是否通过 / 确认推送"卡出现之前,
   * 所有已提交意见必须处理完成——只认当前版本的 fixed 回执,"收到了""回了
   * 一句"、旧版本回执、not_fixed、needs_clarification 都不算。确实缺信息
   * 可以单独追问(澄清卡),答了继续处理。处理完成 ≠ 验收:任务责任人仍逐条处置。
   * 三道检查共用下面这组方法:举卡前(beforeReviewQuestion,拦下让原会话
   * 继续)、回合收口(settleTurn,催原会话接着处理)、推送卡前(
   * pushConfirmationSatisfied,重新派单)。原来只在人点"通过"时拦,卡已经
   * 举出来了,人只剩"需要调整"可点——举卡时机太早。
   * ---------------------------------------------------------------- */

  /** 逐条回执文件:普通插话、决定卡随批、MR 修复共用同一份。 */
  private reviewReceiptsPath(task: TaskState): string {
    return resolve(task.summary.workspace, "reviews", "local-receipts.json");
  }

  /** 送意见给 Agent 之前把 reviews 目录建好:使命里说"不要创建上级目录",
   * 目录就得由平台准备。建不出来只记日志——它不该拦住意见送达。 */
  private ensureReviewsDir(task: TaskState): void {
    try {
      mkdirSync(join(task.summary.workspace, "reviews"), { recursive: true });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} reviews 目录创建失败(意见照送): ${String(error)}`);
    }
  }

  /** 回执地址由消费者确定，文件工具或 Bash 切换目录都不能改变它。 */
  private reviewReceiptInstructionsFor(task: TaskState, items: Annotation[]): string {
    if (items.length) this.ensureReviewsDir(task);
    return workspaceReviewReceiptInstructions(items, this.reviewReceiptsPath(task));
  }

  /** 读盘上的逐条回执并登记进批注账。与 MR 修复轮的
   * consumeWorkspaceReviewReceipts 不同:这里不是"这轮必须齐",而是"此刻
   * 盘上有什么就记什么"——举卡前、回合收口、推送卡前都会读,允许 Agent
   * 分批落盘。畸形/重复/未知 id 是错误(要 Agent 修文件,返回原因);旧版本
   * 回执、人已答过的追问、已闭环意见的残留是历史,直接忽略。 */
  private async consumeReviewProcessingReceipts(
    task: TaskState,
  ): Promise<string | undefined> {
    const epoch = task.controlEpoch;
    const store = this.annotations(task);
    const listed = store.list();
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source === "workspace" && loop.workspace_review_annotation_ids) {
      // 首版未送出的草稿不是本轮回检任务；改字/系统重置/人工返工都会
      // 增加 rework，必须继续保留这些已进入过处理流程的意见。
      const unsent = new Set(listed.filter((item) => item.status === "draft"
        && !item.sent_at && !(item.rework ?? 0)).map((item) => item.id));
      const ids = loop.workspace_review_annotation_ids.filter((id) => !unsent.has(id));
      if (ids.length !== loop.workspace_review_annotation_ids.length) {
        loop.workspace_review_annotation_ids = ids;
        this.options.log?.(`任务 ${task.summary.id} 回检清单排除未发送初稿，草稿原样保留`);
        this.persist(task);
      }
    }
    const submitted = agentReviewAnnotations(listed);
    if (!submitted.length) return undefined;
    const path = this.reviewReceiptsPath(task);
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      return `逐条检视回执不是可读取的 JSON(${String(error)}),请修正后继续。`;
    }
    const rows = Array.isArray(raw) ? raw
      : raw && typeof raw === "object"
        ? (raw as { receipts?: unknown }).receipts : undefined;
    if (!Array.isArray(rows)) return "逐条检视回执缺少 receipts 数组。";
    const byId = new Map(submitted.map((item) => [item.id, item]));
    const known = new Set(listed.map((item) => item.id));
    const live = rows.filter((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      const id = String(record.annotation_id ?? "");
      const target = byId.get(id);
      // 已闭环/撤回/退回草稿的意见留下的条目是历史;真正没见过的 id 留给
      // 校验报"未知意见"。
      if (!target) return !known.has(id);
      const revision = Number(record.revision ?? 0);
      // 改字/返工之后的旧版本回执也是历史,不背书新文字,也不算错。
      return !(Number.isInteger(revision) && revision < (target.rework ?? 0));
    });
    const parsed = parseWorkspaceReviewReceipts(live, submitted);
    const error = parsed.errors.length || parsed.unexpected_ids.length
      ? `逐条检视回执未通过核对:${[
        ...parsed.errors,
        ...parsed.unexpected_ids.map((id) => `未知意见 ${id}`),
      ].join(";")}` : undefined;
    let sha: string | undefined;
    for (const receipt of parsed.receipts) {
      const target = byId.get(receipt.annotation_id)!;
      // 人在澄清卡上已经答过的追问,Agent 原样再抄一遍不能把它"复活"。
      if (answeredClarificationReceipt(target, receipt)) continue;
      const before = target.response?.revision === receipt.revision
        ? target.response : undefined;
      if (before && before.outcome === receipt.outcome
          && before.summary === receipt.summary
          && JSON.stringify(before.evidence)
            === JSON.stringify(receipt.evidence ?? [])) continue;
      if (sha === undefined) {
        // 没有 git 现场(演练/测试)就不绑提交;读不到不是回执的错。
        try { sha = task.cwd ? (await this.prePushRevision(task)).sha : ""; }
        catch { sha = ""; }
      }
      if (!this.current(task, epoch)) return undefined;
      const current = store.list().find((item) => item.id === receipt.annotation_id);
      if (!current || !agentReviewAnnotations([current]).length
          || (current.rework ?? 0) !== receipt.revision
          || answeredClarificationReceipt(current, receipt)) continue;
      store.respond(receipt.annotation_id, {
        revision: receipt.revision,
        outcome: receipt.outcome,
        summary: receipt.summary,
        evidence: receipt.evidence ?? [],
        ...(sha ? { fixed_sha: sha } : {}),
      });
    }
    return error;
  }

  /** 此刻还没处理完成的意见,外加回执文件本身的问题(读不动/格式坏)。
   * 文件坏了但没有待处理意见时不算事——没有东西被它挡着,只记日志。 */
  private async reviewProcessingGap(task: TaskState): Promise<{
    pending: Annotation[];
    error?: string;
  }> {
    const error = await this.consumeReviewProcessingReceipts(task);
    const deferred = deferredAnnotationIds(this.taskHostRuntime(task));
    const pending = pendingReviewProcessing(this.annotations(task).list()).filter(item => !deferred.has(`${item.id}:r${item.rework ?? 0}`));
    if (error && !pending.length) {
      this.options.log?.(`任务 ${task.summary.id} 回执文件有问题但无待处理意见: ${error}`);
    }
    return { pending, ...(error && pending.length ? { error } : {}) };
  }

  /** 给 Agent 的纠偏话:哪些意见还没处理完、各卡在哪、怎么写回执、缺
   * 信息怎么问。三道检查用同一段话,模型看到的要求不会前后不一。 */
  private reviewProcessingPrompt(
    task: TaskState,
    pending: Annotation[],
    error?: string,
  ): string {
    return [
      `还有 ${pending.length} 条已提交的检视意见没有处理完成:不能举起整体确认卡、`
        + "不能交付,也不要就此结束本轮。",
      error ? `另外,回执文件有问题:${error}` : "",
      "逐条现状:\n" + pending.map((item) =>
        `- ${describeReviewProcessingGap(item)}`).join("\n"),
      renderAnnotations(pending, this.ticketOf(task)),
      this.reviewReceiptInstructionsFor(task, pending),
      "先把要求明确的意见改完并逐条登记 fixed 回执;确实缺信息的才单独追问"
        + "(purpose=clarification,只问缺的信息),人答复后按答复继续并更新回执。"
        + "全部处理完再举确认卡。处理完成不等于验收:任务责任人会逐条"
        + "确认,你不能替他们点通过。",
    ].filter(Boolean).join("\n\n");
  }

  /** 举卡前的核对(接 CloudSession.beforeHumanQuestion):还有意见没处理完
   * 就不许举确认卡;只放行形状合规的澄清卡。返回文字 = 拦下,原会话拿着
   * 这段话继续干活,不创建待办、不通知人、不伪造人的同意。 */
  private async beforeReviewQuestion(
    task: TaskState,
    input: Record<string, unknown>,
  ): Promise<string | undefined> {
    const { pending, error } = await this.reviewProcessingGap(task);
    if (!pending.length) return undefined;
    if (input.purpose === "clarification") {
      const rejected = this.clarificationCardRejection(task, pending, input);
      if (!rejected) return undefined;
      this.options.log?.(`任务 ${task.summary.id} 澄清卡不合规被拦:${rejected}`);
      return [rejected, this.reviewProcessingPrompt(task, pending, error)].join("\n\n");
    }
    this.options.log?.(`任务 ${task.summary.id} 举卡被拦:${pending.length} 条检视意见`
      + `未处理完成(${reviewProcessingKey(pending)})`);
    return this.reviewProcessingPrompt(task, pending, error);
  }

  /** 澄清卡合规三条:①annotation_ids 都是当前正 needs_clarification 的意见
   * (先把疑问写进回执,再问人——回执是账,卡只是问);②同一版正文的追问
   * 次数没用完;③选项里没有通过/推送/验收类字样,也没有内核当前步骤的关闭
   * 选项——追问不能顺带把验收夹带过去。不合规返回原因。 */
  private clarificationCardRejection(
    task: TaskState,
    pending: Annotation[],
    input: Record<string, unknown>,
  ): string | undefined {
    const ids = Array.isArray(input.annotation_ids)
      ? input.annotation_ids.map(String) : [];
    if (!ids.length) return "补充信息卡必须用 annotation_ids 指明追问的是哪几条意见。";
    const byId = new Map(pending.map((item) => [item.id, item]));
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) return `意见 ${id} 不在待处理清单里,不能为它追问。`;
      const current = item.response?.revision === (item.rework ?? 0)
        ? item.response : undefined;
      if (current?.outcome !== "needs_clarification") {
        return `意见 ${id} 还没有当前版本的 needs_clarification 回执;先把具体疑问`
          + "写进回执,再追问。";
      }
      if (clarificationRoundsLeft(item) <= 0) {
        return `意见 ${id} 的追问已达 ${MAX_CLARIFICATION_ROUNDS} 次上限,不能再问;`
          + "按最合理理解处理,并在回执 summary 写明假设。";
      }
    }
    const questions = Array.isArray(input.questions)
      ? input.questions as Array<{ options?: unknown }> : [];
    const options = questions.flatMap((question) =>
      Array.isArray(question?.options) ? question.options.map(String) : []);
    const closing = stepChoiceEffects(this.options.host?.kernelRoot,
      this.reviewContractStep(task, undefined)).filter((effect) => effect.closesFeedback);
    const approval = options.find((option) =>
      closing.some((effect) => matchesStepChoice(effect, option))
      || /确认.*(?:通过|推送|验收|合入)|全部通过|按清单推送|approve/i.test(option));
    if (approval) {
      return `补充信息卡只能问缺少的信息,不能带「${approval}」这类通过/推送/验收选项。`;
    }
    return undefined;
  }

  /** 澄清卡答复落账:追问连同答复留档、当前回执清空、盘上那条旧追问回执
   * 剪掉——Agent 按答复继续并重新写回执,不能拿"问过了"当处理完成,也
   * 不能再问同一件事。答复原文随决定(renderDecision)回注给会话。 */
  private recordClarificationAnswers(
    task: TaskState,
    waiting: WaitingRecord,
    resolved: WaitingRecord,
    actor?: string,
  ): void {
    const question = (waiting.question ?? {}) as Record<string, unknown>;
    if (question.purpose !== "clarification") return;
    const ids = Array.isArray(question.annotation_ids)
      ? question.annotation_ids.map(String) : [];
    if (!ids.length) return;
    const answer = renderDecision(resolved).trim();
    if (!answer) return;
    const store = this.annotations(task);
    const answered: string[] = [];
    for (const id of ids) {
      try {
        store.answerClarification(id, answer, actor);
        answered.push(id);
      } catch (error) {
        // 作者已改字重提、或 Agent 已另写回执:这份答复只是迟到的历史。
        this.options.log?.(
          `任务 ${task.summary.id} 追问答复未落到 ${id}: ${String(error)}`);
      }
    }
    if (answered.length) this.pruneReviewReceipts(task, answered);
  }

  /** 从回执文件里剪掉这些意见的条目:人答完追问后,盘上那条
   * needs_clarification 不能再被读成"还在等人"。文件是仓外派生物,剪不动
   * 只记日志(读侧还有 answeredClarificationReceipt 兜着)。 */
  private pruneReviewReceipts(task: TaskState, ids: string[]): void {
    const path = this.reviewReceiptsPath(task);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const drop = new Set(ids);
      const keep = (rows: unknown[]) => rows.filter((row) => !drop.has(
        String((row as Record<string, unknown> | null)?.annotation_id ?? "")));
      const next = Array.isArray(raw) ? keep(raw)
        : raw && typeof raw === "object" && Array.isArray(raw.receipts)
          ? { ...raw, receipts: keep(raw.receipts) } : raw;
      writeFileSync(path, JSON.stringify(next, null, 2));
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 剪除已答复追问的回执失败(读侧另有兜底): ${String(error)}`);
    }
  }

  /** 推送卡前的兜底:意见还没处理完就不举最终卡,按既有续跑机制把任务重新
   * 排队让 Agent 接着处理(此时原会话已收口,不会有第二个 Agent 并发)。
   * 同一批意见只派一次:派过一轮回来还没完成,就不再空转,让卡如实出现,
   * 人在卡上看到"未处理"只能选返工。 */
  private dispatchReviewProcessing(
    task: TaskState,
    pending: Annotation[],
  ): "dispatched" | "busy" | "exhausted" {
    const key = reviewProcessingKey(pending);
    const delivery = task.summary.delivery ?? (task.summary.delivery = {});
    if (delivery.review_processing_dispatched_for === key) {
      this.options.log?.(`任务 ${task.summary.id} 检视意见 ${key} 派过一轮仍未处理完成,`
        + "不再重派,按现状举卡");
      return "exhausted";
    }
    // 有会话在跑/在排队就不另起——这条路是"回合收口后才发现"的兜底。
    if (task.driver || ["running", "queued"].includes(task.summary.status)) return "busy";
    delivery.review_processing_dispatched_for = key;
    this.enqueueRepair(task, this.reviewProcessingPrompt(task, pending),
      `还有 ${pending.length} 条检视意见未处理完成,已让 Agent 继续处理`);
    this.options.log?.(
      `任务 ${task.summary.id} 推送卡前发现 ${pending.length} 条检视意见未处理完成,重新派单(${key})`);
    return "dispatched";
  }

  private hasPublishedOverallStory(task: TaskState): boolean {
    return !task.summary.parent_task_id && !!currentStoryFile(task.summary.workspace);
  }

  /** 批注靶子既可能是真实产物，也可能是任务快照里的需求原文。 */
  private annotationArtifactContent(
    task: TaskState,
    artifact: string,
  ): string | undefined {
    if (artifact === TASK_REQUIREMENT_ARTIFACT) {
      return task.summary.requirement;
    }
    if (artifact === REQUIREMENT_GRAPH_ARTIFACT) {
      return this.requirementGraphAnnotationContent(task);
    }
    const root = this.artifactRoot(task.summary.id);
    return readArtifact(root, artifact, {
      pipelineRoot: join(task.summary.workspace, "pipeline"),
      taskMaterialRoot: task.summary.workspace,
      analysisStory: task.summary.requirement_graph && !task.summary.parent_task_id && !isMainTaskDelivery(task.summary)
        ? `${task.summary.ticket ?? task.summary.id}/story.md` : undefined,
      publishedStory: this.hasPublishedOverallStory(task),
    })?.content;
  }

  private async annotationArtifactContentAsync(
    task: TaskState,
    artifact: string,
  ): Promise<string | undefined> {
    if (artifact === TASK_REQUIREMENT_ARTIFACT) {
      return task.summary.requirement;
    }
    if (artifact === REQUIREMENT_GRAPH_ARTIFACT) {
      return this.requirementGraphAnnotationContent(task);
    }
    const root = this.artifactRoot(task.summary.id);
    return (await readArtifactAsync(root, artifact, {
      pipelineRoot: join(task.summary.workspace, "pipeline"),
      taskMaterialRoot: task.summary.workspace,
      analysisStory: task.summary.requirement_graph && !task.summary.parent_task_id && !isMainTaskDelivery(task.summary)
        ? `${task.summary.ticket ?? task.summary.id}/story.md` : undefined,
      publishedStory: this.hasPublishedOverallStory(task),
    }))?.content;
  }

  /** 图上批注的可重锚定文本。行号只是现有批注合同的辅助字段，真正稳定
   * 的定位是整体标识、模块 id 和依赖两端 id；模块改名不让意见失联，
   * 节点/边被删则如实显示靶子已经变化。 */
  private requirementGraphAnnotationContent(task: TaskState): string | undefined {
    const graph = task.summary.requirement_graph;
    if (!graph) return undefined;
    return [
      "模块拆分与依赖：整体方案",
      ...graph.repositories.map((item) =>
        `模块 ${item.id}：${item.scope?.name ?? item.name}`),
      ...graph.dependencies.map((edge) =>
        `依赖 ${edge.from} -> ${edge.to}`),
    ].join("\n");
  }

  /** 单号来自内核状态文件;拿不到就退回任务号——不为抬头编内容。 */
  private ticketOf(task: TaskState): string {
    try {
      const statePath = join(task.cwd ?? "", ".mae-flow.json");
      if (task.cwd && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        const ticket = String(state?.config?.["单号"] ?? "").trim();
        if (ticket) return ticket;
      }
    } catch {
      // 读不到就用任务号,批注照样送得出去。
    }
    return task.summary.id;
  }

  /** 批注清单(草稿 + 已送出)+ 每条的锚点现状。
   *
   * 已送出的不下架:人得看得见"这条提过没有、它动了没有"。而"动了没有"
   * 我们只报事实不下结论——锚点原文还在原处,就是它还没碰这里;原文不见
   * 了,就是这处已经被改动。是不是**照你说的**改的,由你看了再说,系统
   * 不替你判断"已采纳"(那是推断,不是事实)。
   *
   * 锚点检查是旁路:读不到材料按"还在"放行,绝不因为它挡住人送意见。
   * 同步操作只取批注与锚点；页面需要的 AI 回复由异步读侧提供。
   */
  listAnnotations(id: string): {
    items: Annotation[];
    checks: AnchorCheck[];
  } {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.reconcileResolvedDecisionAnnotations(task);
    if (task.summary.delivery?.mr_url) importStoredExternalReviews(this.annotations(task), task.summary.workspace, task.summary.delivery.mr_url, task.summary.luban_account ?? "本地用户");
    const items = this.annotations(task).visible();
    const checks = reanchor(items, (artifact) =>
      this.annotationArtifactContent(task, artifact));
    return { items, checks };
  }

  /** 工作台轮询专用异步读侧。先按 artifact 去重读取，再用同一份快照
   * 重锚定，避免 N 条代码批注触发 N 次完整 Git diff。 */
  /** 面板要的全部事实。**闭环判定只在 feedbackPolicy 里做一次**:页面
   * 拿到的是结论(状态词、提示、按钮开关),不再自己按 sent_via 推一遍。
   * viewer 缺席=无认证部署的单用户语义,权限全开。 */
  async listAnnotationsAsync(id: string, viewer?: {
    username: string;
    can_override: boolean;
    can_route_others: boolean;
    person_name?: (username: string) => string;
  }): Promise<{
    items: Annotation[];
    checks: AnchorCheck[];
    closures: AnnotationClosure[];
    submission: AnnotationSubmissionView;
    reply?: { texts: string[]; truncated: boolean };
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.reconcileResolvedDecisionAnnotations(task);
    if (task.summary.delivery?.mr_url) importStoredExternalReviews(this.annotations(task), task.summary.workspace, task.summary.delivery.mr_url, task.summary.luban_account ?? "本地用户");
    const items = this.annotations(task).visible();
    const reply = items.some(item => item.sent_at)
      ? this.readDisplayEvents(id).then(events => annotationReply(events, items.map(item => item.sent_at)))
        .catch(() => undefined) : Promise.resolve(undefined);
    const contents = new Map<string, string | undefined>();
    await Promise.all([...new Set(items.map((item) => item.artifact))]
      .map(async (artifact) => {
        contents.set(artifact,
          await this.annotationArtifactContentAsync(task, artifact));
      }));
    const checks = reanchor(items, (artifact) => contents.get(artifact));
    const closures = annotationClosures(
      items,
      this.annotationClosureFacts(task),
      {
        username: viewer?.username ?? "本地用户",
        can_override: viewer?.can_override ?? true,
        can_route_others: viewer?.can_route_others ?? true,
      },
      {
        // "被改动"只认一个判据:锚定的原文消失了。行号漂移不算——
        // 原文还在就说明这处还没动,只是别处改动把行挤走了。
        anchor_gone_ids: checks.filter((check) => check.state === "gone")
          .map((check) => check.id),
        ...(viewer?.person_name ? { person_name: viewer.person_name } : {}),
      },
    );
    return { items, checks, closures, submission: this.annotationSubmissionView(task), reply: await reply };
  }

  private annotationSubmissionView(task: TaskState): AnnotationSubmissionView {
    const waiting = task.summary.waiting;
    const push = waiting && [CLOUD_PUSH_CONFIRM_STEP, "host_push_confirm"].includes(waiting.step);
    const reviewDecision = !!waiting && !!annotationReviewAnswer(waiting.question,
      push ? [] : stepChoiceEffects(this.options.host?.kernelRoot, this.reviewContractStep(task, waiting)), !!push);
    return annotationSubmissionView({ status: task.summary.status,
      openMr: this.hasOpenMergeRequest(task),
      evidenceAwaiting: !!task.summary.delivery?.evidence_gap?.missing_dimensions.length,
      publishedStory: this.hasPublishedOverallStory(task), reviewDecision,
      requirementReview: waiting?.step === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP });
  }

  /** 判定要用的任务侧事实。取现成字段,不猜。 */
  private annotationClosureFacts(task: TaskState): AnnotationClosureFacts {
    const loop = task.summary.delivery?.loop;
    const ready = workspaceReviewReady({
      task_status: task.summary.status,
      waiting_step: task.summary.waiting?.step,
      review_source: loop?.review_source,
      recheck_required: loop?.workspace_review_recheck_required,
    });
    return {
      task_status: task.summary.status,
      task_owner: task.summary.luban_account ?? "本地用户",
      owner_controlled: true,
      review_ready: ready,
      review_annotation_ids: ready
        ? loop?.workspace_review_annotation_ids ?? [] : [],
      archival: task.summary.status === "completed",
    };
  }

  /** 发过的插话 + 送达与否。
   *
   * "我发了然后就没了,咋知道它消费了没"——发出去没有回执,等于让人对着
   * 空气说话。送达是可观测的:pi 把消息移出 steering 队列的那一刻,就是
   * 它进入模型上下文的那一刻。这里只报这个事实,不替人判断"它照做了没"
   * ——那要看它后面干了什么,判断权是人的。
   *
   * said:捎话之后模型说的话。用户 2026-08-22 原话:"有时我是问了个问题,
   * 有时我是下达了个指令,我看不到 agent 的回复"——只报"已读取"而不给
   * 下文,提问就永远没有答案,那这个框一半是废的。
   *
   * 口径仍是事实而非推断:**这些是你说完之后它说的话,不是"对你的回复"**。
   * 我们没法证明哪句是答你的(steer 在回合间隙送达,模型可能先把手头
   * 那段话说完),所以只按时间切片给到下一条插话为止,标签也这么写。 */
  listInterrupts(id: string, preparedEvents?: SemanticEvent[]): Array<{
    /** 人写的附言原文;引用的知识正文不在这里,只给名字。 */
    text: string; at: string; delivered: boolean;
    /** 不走 steer 的两条路:随下一次决定送达 / 任务启动时并入使命。 */
    deferred?: "decision" | "mission";
    /** @ 引用的知识名(发送时固定的版本号一起给)。 */
    references?: string[];
    said: Array<{ text: string; at: string }>;
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const pending = new Set([
      ...(task.driver?.pendingSteers() ?? []),
      ...(task.pendingMainSteers ?? []),
    ]);
    // 延后送达的判据同样是事实:随决定送达的,决定提交时清 pendingDecision
    // Knowledge 就是送达;排队期的,任务离开排队(且没被取消)、并且不再
    // 压在 pendingMainSteers 里,才是随首条 prompt 进了模型。
    const awaitingDecision = new Set(task.pendingDecisionKnowledge ?? []);
    const missionDelivered = !["queued", "canceled"]
      .includes(task.summary.status);
    try {
      const rows: Array<{
        text: string; at: string; delivered: boolean;
        deferred?: "decision" | "mission";
        references?: string[];
        said: Array<{ text: string; at: string }>;
      }> = [];
      for (const event of preparedEvents ?? readActivityEvents(this.eventLogPath(id))) {
        if (event.kind === "user_message"
            && event.payload?.via === "interrupt") {
          // 送达判定必须拿送达用的整段正文去比队列;展示另给。
          const text = String(event.payload?.text ?? "");
          const display = typeof event.payload?.display === "string"
            ? event.payload.display : text;
          const references = Array.isArray(event.payload?.references)
            ? (event.payload.references as unknown[]).map(String) : undefined;
          const deferred = event.payload?.deferred === "decision"
            || event.payload?.deferred === "mission"
            ? event.payload.deferred as "decision" | "mission" : undefined;
          rows.push({
            text: display, at: String(event.ts ?? ""),
            delivered: deferred === "decision" ? !awaitingDecision.has(text)
              : deferred === "mission"
                ? missionDelivered && !pending.has(text)
              : !pending.has(text),
            ...(deferred ? { deferred } : {}),
            ...(references?.length ? { references } : {}),
            said: [],
          });
          continue;
        }
        // 还没有人捎过话,前面的说明与这个框无关,不收。
        if (event.kind !== "assistant_message" || !rows.length) continue;
        const said = String(event.payload?.text ?? "").trim();
        // 一条插话下面挂太多段就成了第二个过程记录,收前 4 段够看趋势;
        // 想看全的在「过程记录」里,那才是原话的正本。
        if (said && rows[rows.length - 1].said.length < 4) {
          rows[rows.length - 1].said.push({
            text: said, at: String(event.ts ?? ""),
          });
        }
      }
      return rows;
    } catch {
      return [];      // 读不动就当没有:旁路绝不挡住页面
    }
  }

  addAnnotation(id: string, input: AnnotationInput): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.status === "canceled") {
      throw new TaskControlError("任务已由用户停止，不能再新增批注");
    }
    const route = input.route ?? "agent";
    const needsOwner = route !== "agent" && route !== "memory";
    const assignee = needsOwner ? task.summary.luban_account ?? "本地用户" : undefined;

    const record = this.annotations(task).add({ ...input, route, assignee });
    // 记录经验关联文件的后续意见，供复盘核对；不能据此判定经验有害。
    if (route === "agent" && record.kind === "code" && record.file) {
      this.noteMemoryRework(task, record.file);
    }
    if (route === "memory") {
      // 圈选即闭环:人主动说"记下来",不经 Agent、不进决定卡。写不进语料
      // 就不留半截批注——人以为记了其实没记,比当场报错糟得多。
      try {
        this.recordMemory(task, this.memoryFromAnnotation(task, record, "user_note"));
      } catch (error) {
        this.annotations(task).drop(record.id, record.author);
        throw error instanceof MemoryError
          ? new TaskControlError(error.message) : error;
      }
    }
    return record;
  }

  /** 记忆来源之一:批注。人圈的(user_note)结论就是那句话;闭环的
   * (annotation)意见是问题、Agent 回执是结论。位置从锚点来:代码是
   * 文件+行,过程文档是文档名,需求原文是任务级。 */
  private memoryFromAnnotation(
    task: TaskState,
    item: Annotation,
    source: "annotation" | "user_note",
  ): MemoryInput {
    const code = item.kind === "code";
    const where = item.artifact === TASK_REQUIREMENT_ARTIFACT ? "需求原文"
      : item.file || item.artifact;
    const trigger = code
      ? `改 ${item.file}${item.line ? ` 第 ${item.line} 行附近` : ""}时`
      : `${where}里「${(item.quote ?? item.anchor).replace(/\s+/g, " ").slice(0, 40)}」这一段`;
    const phase = task.summary.progress?.current_phase;
    return {
      source,
      judged_by: "human",
      scope: source === "user_note" ? "general" : "local",
      repo: repoSlug(task.summary.repo_url ?? task.summary.repositories?.[0]),
      paths: code && item.file ? [item.file] : [],
      ...(code && item.line ? { line: item.line } : {}),
      ...(phase ? { phase } : {}),
      task: task.summary.id,
      evidence: `annotation:${item.id}`,
      author: item.author,
      trigger,
      // 划选了一块就记整块:记忆的价值一半在语境里。
      quote: item.quote ?? item.anchor,
      ...(source === "annotation"
        ? { problem: item.note, conclusion: item.response?.summary || item.note }
        // 没写一句话就把原文本身当结论:记的是"这段话",不是对它的评价。
        : { conclusion: item.note || item.quote || item.anchor }),
    };
  }

  private taskMemoryContext(task: TaskState): (messages: any[]) => Promise<any[]> {
    return createMemoryContext({
      budgetMs: (this.memorySidecar?.searchBudgetMs ?? DEFAULT_MEMORY_BUDGETS.searchMs) + 500,
      context: () => memoryContextQuery(task),
      search: async query => {
        // 侧车在服务启动时预热；模型前台不等待最长 60 秒的冷启动。
        if (!this.memorySidecar?.available) return undefined;
        const eligible = new Set(this.memoryCandidates(task).map(row => row.id));
        return (await this.memorySearch(task, { query, limit: 8 }))?.filter(hit => eligible.has(hit.id)).map(hit => hit.id);
      },
      resolve: ids => {
        const rows = new Map(this.memories().list().map(row => [row.id, row]));
        return ids.flatMap(id => {
          const row = rows.get(id);
          const who = row?.judged_by === "human" ? "人确认" : row?.judged_by === "agent" ? "Agent 记录" : "流水线";
          return row && memoryAccessible(row, this.memoryRepo(task), this.memoryModules(task), task.summary.product_version) ? [{ id, revision: String(row.revision ?? 1),
            text: `[${row.scope === "platform" ? "平台通用" : "本仓"} · ${who} · ${row.at.slice(0, 10)}] ${row.trigger}: ${row.conclusion}${row.product_versions?.length ? `（适用版本：${row.product_versions.join("、")}）` : ""}`,
          }] : [];
        });
      },
      onUse: event => this.logMemoryUsage(task, { moment: "context", ...event }),
    });
  }

  private memoryRepo(task: TaskState): string {
    return repoSlug(task.summary.repo_url ?? task.summary.repositories?.[0]);
  }

  private taskKnowledgeContext(task: TaskState): KnowledgeContext {
    const module = task.summary.business_module
      ?? this.tasks.get(task.summary.parent_task_id ?? "")?.summary.business_module;
    return { repo: this.memoryRepo(task),
      repositories: [...new Set([...(task.summary.repositories ?? []), ...(task.summary.repo_url ? [task.summary.repo_url] : [])])],
      moduleIds: module ? [module.id] : (task.summary.business_modules ?? []).map(item => item.id),
      productVersion: task.summary.product_version };
  }

  private memoryModules(task: TaskState): string[] {
    return resolveKnowledgeModules(this.options.dataDir, this.taskKnowledgeContext(task)).modules.map(module => module.id);
  }

  async sampleComponentKnowledge(id: string) {
    const task = this.tasks.get(id);
    if (!task?.cwd) throw new Error("请选择已准备好代码工作区的需求任务");
    const consumer = this.componentKnowledge(task);
    if (!consumer) throw new Error("该任务没有组件知识消费上下文");
    return consumer.check({ trigger: "sample" });
  }

  private componentKnowledge(task: TaskState) {
    if (!task.cwd || this.isRequirementAnalysis(task)) return undefined;
    return new ComponentKnowledgeConsumption({ dataDir: this.options.dataDir, cwd: task.cwd,
      plan: () => this.componentPlan(task),
      context: () => {
        const module = task.summary.business_module ?? this.tasks.get(task.summary.parent_task_id ?? "")?.summary.business_module;
        return { repo: this.memoryRepo(task), repositories: [...new Set([...(task.summary.repositories ?? []), ...(task.summary.repo_url ? [task.summary.repo_url] : [])])],
          moduleIds: module ? [module.id] : (task.summary.business_modules ?? []).map(m => m.id), productVersion: task.summary.product_version };
      },
      languages: () => [...new Set((task.summary.repository_profiles ?? []).flatMap(p => p.technologies)
        .map(l => ({ "c++": "cpp", cxx: "cpp" }[l.toLowerCase()] ?? l.toLowerCase())))],
      baseline: () => {
        if (task.summary.delivery?.target_branch || task.summary.baseline) return task.summary.delivery?.target_branch ?? task.summary.baseline!;
        try { return String(JSON.parse(readFileSync(join(task.cwd!, ".mae-flow.json"), "utf8"))?.config?.["基线分支"] ?? ""); } catch { return ""; }
      },
      onReport: report => {
        if (report.trigger === "sample") return;
        task.summary.delivery = { ...task.summary.delivery, component_knowledge: report }; this.persist(task);
        this.logMemoryUsage(task, { moment: "component_check", status: report.status === "incomplete" ? "unavailable" : "ready",
          ids: [...new Set(report.findings.map(f => f.document_id))],
          assets: [...new Map(report.findings.map(f => [JSON.stringify([f.document_id, f.document_revision, f.document_line]), { id: f.document_id, revision: f.document_revision, start_line: f.document_line }])).values()],
          check: { trigger: report.trigger, head: report.head, findings: report.findings.length,
            hints: report.findings.filter(f => f.level === "warning" && !f.exempt_reason).length, rules_digest: report.rules_digest } }); },
    });
  }

  private componentAnalysisContext(task: TaskState) {
    const directory = this.getKnowledgeSearch().componentContext(this.taskKnowledgeContext(task));
    this.logMemoryUsage(task, { moment: "context", phase: "component_analysis",
      ids: directory.hits.map(hit => hit.id), assets: directory.hits,
      status: directory.warnings.length ? "unavailable" : directory.hits.length ? "ready" : "empty" });
    return directory;
  }

  /** 平台与本仓有效记忆；仅仓库记忆检查路径是否仍存在。 */
  private memoryCandidates(task: TaskState): MemoryRecord[] {
    const repo = this.memoryRepo(task);
    const store = this.memories();
    const stats = store.ledger.stats();
    // 失锚只在真现场(有 .git)里记台账:假 cwd 会把好记忆记成失锚,半年后误沉底。
    const realCheckout = !!task.cwd && existsSync(join(task.cwd, ".git"));
    const rows = store.list().filter((row) => {
      if (!memoryAccessible(row, repo, this.memoryModules(task), task.summary.product_version)
          || row.scope === "one_off" || (row.task === task.summary.id && row.scope !== "platform")) return false;
      if (row.scope === "local" && task.cwd && row.paths[0] && !existsSync(join(task.cwd, row.paths[0]))) {
        if (realCheckout && !stats.get(row.id)?.unanchored_since) {
          store.ledger.append({ kind: "unanchored", id: row.id,
            task: task.summary.id, note: row.paths[0] });
        }
        return false;
      }
      return true;
    });
    return this.rankMemories(rows, stats);
  }

  /** §5 排序:权重高的在前,同权重新的在前。 */
  private rankMemories(rows: MemoryRecord[], stats: Map<string, MemoryStats>): MemoryRecord[] {
    const now = Date.now();
    return [...rows].sort((a, b) =>
      memoryWeight(b, stats.get(b.id) ?? EMPTY_STATS, now)
        - memoryWeight(a, stats.get(a.id) ?? EMPTY_STATS, now)
      || b.at.localeCompare(a.at));
  }

  private async memorySearch(
    task: TaskState,
    input: { query: string; pathPrefix?: string; limit?: number },
  ): Promise<MemorySearchHit[] | undefined> {
    if (!this.memorySidecar) return undefined;
    const store = this.memories(), repo = this.memoryRepo(task);
    const sources = store.list().filter(row => memoryAccessible(row, repo, this.memoryModules(task), task.summary.product_version)
      && (!input.pathPrefix || row.scope === "platform" || row.paths.some(path => path.startsWith(input.pathPrefix!))))
      .map(row => ({ id: row.id, path: join(store.root, row.file) }));
    const hits = await this.memorySidecar.search({ ...input, repo, sources });
    if (!hits) return undefined;
    return resolveMemoryHits(hits, id => this.memories().find(id), this.memoryRepo(task), this.memoryModules(task), task.summary.product_version);
  }

  /** 拆分提议工具:只有单仓直接开发的主任务才挂;分析单、子任务不挂。 */
  private splitTools(task: TaskState): unknown[] {
    const summary = task.summary;
    if (summary.parent_task_id || this.isRequirementAnalysis(task) || isMainTaskDelivery(summary)
        || (summary.repositories?.length ?? 0) !== 1) return [];
    return [createSplitProposalTool((input, callId) => this.proposeSplit(task, input, callId))];
  }

  /** Agent 在开发中提议拆分(docs/delivery-unit-split-design.md 2026-09-03
   * 勘误):拆不拆是分析的产物,不是下单时的开关;但人有最后一票——受理
   * 即举决定卡,会话停在这里等责任人拍板(同 AskUserQuestion 的挂起点)。
   * 选拆:decide 里转身成分析单,本会话被掐掉;选不拆:原地继续,以后
   * 不再受理。拒绝用一句人话回给模型,不抛错。 */
  private async proposeSplit(
    task: TaskState,
    input: SplitProposalInput,
    callId: string,
  ): Promise<string> {
    const summary = task.summary;
    if (isMainTaskDelivery(summary)) return "方案已确认由本任务完整交付，按已确认范围继续开发，不再提议拆分。";
    if (summary.parent_task_id) {
      return "本单是拆分后的交付单元子任务,不能再拆;按任务书范围继续。";
    }
    if (this.isRequirementAnalysis(task)) {
      return "本单已经是分析拆分单,按分析流程走到确认即可。";
    }
    if ((summary.repositories?.length ?? 0) !== 1) {
      return "只有单仓直接开发任务可以转为拆分分析。";
    }
    if (summary.delivery?.sha || summary.delivery?.mr_url) {
      return "本单已有推送或 MR,不能再转为拆分;按现状继续交付。";
    }
    if (summary.split_escalation?.decision === "declined") {
      return "责任人已否决拆分:按一个任务干完,不要再提议。";
    }
    if (summary.split_escalation) {
      return "拆分提议已在卡上等责任人拍板;请停止调用工具,结束本轮发言。";
    }
    if (summary.status !== "running") {
      return `本单当前状态是 ${summary.status},不能转为拆分。`;
    }
    const reason = input.reason.trim();
    if (!reason) return "reason 不能为空:写清拆分依据、功能边界及交付关系。";
    const driver = task.driver;
    if (!driver) return "当前没有可挂起的会话,稍后再试。";
    const units = (input.suggested_units ?? [])
      .map((unit) => unit.trim()).filter(Boolean).slice(0, 20);
    summary.split_escalation = {
      at: new Date().toISOString(),
      reason: reason.slice(0, 2000),
      ...(units.length ? { suggested_units: units } : {}),
      ...(summary.progress?.current_phase
        ? { phase: summary.progress.current_phase } : {}),
      decision: "pending",
    };
    this.persist(task);
    const record = task.humanGate.createWaiting({
      taskId: summary.id,
      step: CLOUD_SPLIT_PROPOSAL_STEP,
      callId,
      questionInput: { questions: [{
        question: "Agent 建议把本单拆成多个交付单元。先分析再拆分,还是不拆、一个任务干完?",
        options: [SPLIT_PROPOSAL_ACCEPT, SPLIT_PROPOSAL_DECLINE],
        recommended: SPLIT_PROPOSAL_ACCEPT,
      }] },
      context: [
        `**Agent 读完仓后，结合需求和模块边界提议拆分。**`,
        `理由:${reason}`,
        ...(units.length ? ["建议的切法:", ...units.map((unit, index) => `${index + 1}. ${unit}`)] : []),
        "",
        `选「${SPLIT_PROPOSAL_ACCEPT}」:当前编码会话终止,以只读分析现场重新启动,`
        + "走澄清→改动面盘点→划分方向卡→拆分方案→确认→按单元建子任务;"
        + "单号在确认卡上逐单元填,按分析确认的真实依赖启动；同仓独立单元可并行并须使用不同 AR，“提前开始”仅用于后续调整。",
        `选「${SPLIT_PROPOSAL_DECLINE}」:Agent 原地继续,按一个任务做完,不再提议。`,
      ].join("\n"),
    });
    // 会话挂起点:决定到达前 pi 停在这里。选拆时 decide 会掐掉本会话,
    // 这个 Promise 由 abort 解开;选不拆时拿到决定原文,给模型一句明确的话。
    const text = await driver.awaitHostDecision(record);
    if (task.summary.split_escalation?.decision === "declined") {
      return `责任人决定:${SPLIT_PROPOSAL_DECLINE}。继续当前流程,把本单当一个任务做完,不要再提议拆分。`;
    }
    return text;
  }

  /** 拆分卡拍板后的宿主动作:拆→转身;不拆→记下否决,会话原地继续。
   * decide 与重启后回放已决待办都走这里。 */
  private async applySplitProposalDecision(
    task: TaskState,
    resolved: WaitingRecord,
  ): Promise<void> {
    const escalation = task.summary.split_escalation;
    const submitted = [...Object.values(resolved.answers ?? {}), resolved.decision];
    const accepted = submitted.includes(SPLIT_PROPOSAL_ACCEPT);
    if (!escalation) return;
    escalation.decision = accepted ? "split" : "declined";
    escalation.decided_by = resolved.decided_by;
    escalation.decided_at = new Date().toISOString();
    task.summary.waiting = undefined;
    if (accepted) {
      task.summary.requirement_analysis_requested = true;
      // 单仓下单时是一个节点的退化图(stage confirmed),退回分析态;节点
      // 保留:责任人默认沿用,单号在确认卡上逐单元定。
      task.summary.requirement_graph = {
        stage: "analysis",
        sync_required: true,
        repositories: (task.summary.requirement_graph?.repositories ?? []).map((node) => ({
          ...node, task_id: undefined, task_status: undefined,
        })),
        dependencies: [],
      };
      this.persist(task);
      await this.restartAsSplitAnalysis(task);
      return;
    }
    if (task.driver) {
      task.summary.status = "running";
      task.summary.detail = "责任人决定不拆,按一个任务继续";
      this.persist(task);
      this.bypass(task, "拆分否决续跑",
        this.settle(task, task.driver.resumeWithDecision(resolved)));
      return;
    }
    // 重启后回放:旧会话已死,决定只剩"不拆"这个事实;重建会话时那次
    // propose_split 调用按 interrupted 登记,模型再提会被"已否决"挡住。
    task.summary.status = "queued";
    task.summary.detail = "责任人决定不拆,等待重建会话续跑";
    task.resume = true;
    this.persist(task);
    if (!this.queue.includes(task.summary.id)) this.queue.push(task.summary.id);
    this.bypass(undefined, "任务泵", this.pump());
  }

  /** 拆分转身:掐掉编码会话与容器,清空现场指针,按分析单重新排队。
   * 清理的纪律同 finishPause:资源没确认释放就如实 failed,不静默续跑。 */
  private async restartAsSplitAnalysis(task: TaskState): Promise<void> {
    if (task.summary.split_escalation?.decision !== "split") return;
    if (!["running", "waiting_for_human"].includes(task.summary.status)) return;
    task.controlEpoch += 1;
    const epoch = task.controlEpoch;
    const driver = task.driver;
    const container = task.container;
    task.summary.detail = "已确认模块拆分，正在转为全局分析";
    this.persist(task);
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    // await 之后状态可能已被 cancel 换走;TS 把开头的 running 判断记到了
    // 这里,得显式放宽。
    const statusNow = task.summary.status as TaskStatus;
    if (task.controlEpoch !== epoch || statusNow === "canceled") return;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      task.summary.status = "failed";
      task.summary.detail = "转为拆分分析失败,执行资源未能确认释放:"
        + failures.join(";") + "。可取消后重新下单";
      this.persist(task);
      this.notifyOutcome(task);
      return;
    }
    // 旧编码现场作废:分析单会在 workspace/repositories 下重新只读克隆。
    task.cwd = undefined;
    task.mission = undefined;
    task.progressCache = undefined;
    task.resume = false;
    task.summary.progress = undefined;
    task.summary.status = "queued";
    task.summary.detail = `已确认模块拆分，已转为全局分析:${
      task.summary.split_escalation.reason.replace(/\s+/g, " ").slice(0, 80)}`;
    this.persist(task);
    this.queue.push(task.summary.id);
    this.bypass(undefined, "任务泵", this.pump());
  }

  private domainKnowledgeExtraction?: DomainKnowledgeExtraction;
  private skillRecoveryWarnings: string[] = [];
  knowledgeRecordWarnings(): string[] { return [...this.skillRecoveryWarnings]; }
  getDomainKnowledgeExtraction(): DomainKnowledgeExtraction {
    return this.domainKnowledgeExtraction ??= createDomainKnowledgeExtraction({
      capacity: this.knowledgeTaskCapacity,
      dataDir: this.options.dataDir, platformUrl: () => this.effectivePlatformUrl(),
      credential: operator => this.options.gitCredential?.(operator), onIndexed: () => this.prepareKnowledgeIndex(),
      model: () => { const active = this.activeModelChoice(); return active ? { ...active, json: this.resolvedModels().json } : undefined; },
      source: (repository, operator, signal, baselineRevisions) => this.componentResearchSource({ ...repository, languages: ["agnostic"], description: "业务知识研究", enabled: true }, operator, signal, baselineRevisions),
    });
  }
  private componentResearch?: ComponentResearch;
  getComponentResearch(): ComponentResearch {
    return this.componentResearch ??= createComponentKnowledgeExtraction({
      capacity: this.knowledgeTaskCapacity,
      dataDir: this.options.dataDir, onIndexed: () => this.prepareKnowledgeIndex(),
      model: () => { const active = this.activeModelChoice(); return active ? { ...active, json: this.resolvedModels().json } : undefined; },
      source: (component, operator, signal, baselineRevisions) => this.componentResearchSource(component, operator, signal, baselineRevisions),
      archiveFor: (id, summaryOnly) => this.getDomainKnowledgeExtraction().componentArchive(id, summaryOnly),
    });
  }
  private componentSourceLocks = new Map<string, Promise<unknown>>();
  private async componentResearchSource(component: ComponentRepository, operator: string, signal?: AbortSignal, baselineRevisions: string[] = []) {
    const identity = this.options.gitCredential?.(operator) ?? this.options.platformGitCredential?.();
    const key = createHash("sha256").update(JSON.stringify([operator, identity, component.repository, component.branch])).digest("hex");
    const root = join(this.options.dataDir, "component-source-cache", key);
    const previous = this.componentSourceLocks.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      const sandbox = this.prepareHostGitSandbox(identity);
      try {
        return await syncKnowledgeSource(root, component.repository, component.branch, sandbox, signal, baselineRevisions);
      } finally { this.cleanupHostGitCredential(sandbox); }
    });
    this.componentSourceLocks.set(key, work);
    try { return await work; } finally { if (this.componentSourceLocks.get(key) === work) this.componentSourceLocks.delete(key); }
  }

  private knowledgeSearch?: KnowledgeSearch;
  getKnowledgeSearch(): KnowledgeSearch {
    return this.knowledgeSearch ??= new KnowledgeSearch(this.options.dataDir, this.memorySidecar);
  }

  private knowledgeAnswers?: KnowledgeAnswers;
  getKnowledgeAnswers(): KnowledgeAnswers {
    if (this.shuttingDown) throw new KnowledgeAnswerError(503, "问答服务正在停止，请稍后重试");
    return this.knowledgeAnswers ??= new KnowledgeAnswers(this.options.dataDir, createKnowledgeAnswerRunner({
      dataDir: this.options.dataDir,
      // 知识问答在 ADR-0068 覆盖清单内,choice 三件套必须同源:pi 严格按
      // provider/model 键查现场 json,平台键配个人现场 json 会当场
      // 「找不到所选模型」(Beta 期旧伤,双轴评审修);未命中沿用平台
      // 口径 activeModelChoice。
      model: owner => {
        const resolved = this.resolvedModels(owner);
        const active = personalLaneChoice(resolved)
          ?? this.activeModelChoice();
        return active ? { ...active, json: resolved.json } : undefined;
      },
      search: () => this.getKnowledgeSearch(),
    }));
  }

  private knowledgePrepareTimer?: ReturnType<typeof setTimeout>;
  private knowledgeRepositoryTimer?: ReturnType<typeof setTimeout>;
  private knowledgePublicationCheckedAt = 0;
  private knowledgeRepositorySyncs = new Map<string, { abort: AbortController; work: Promise<unknown> }>();
  private knowledgeRepositoryCompletedAt = new Map<string, number>();

  /** 同步在后台进行；目录阅读与长程萃取不等待 Git 网络请求。 */
  startModuleKnowledgeSync(moduleId: string, operator: string): void {
    if (this.shuttingDown) throw new TaskControlError("服务正在停止，请稍后重试知识同步");
    const module = readBusinessModule(this.options.dataDir, moduleId);
    if (!resolveModuleKnowledgeLocation(this.options.dataDir, module.id)) throw new TaskControlError("请先由管理员配置平台领域知识仓库，并设置本模块的领域知识目录");
    if (this.knowledgeRepositorySyncs.has(module.id)) return;
    const previousContent = readModuleKnowledgeContentRevision(this.options.dataDir, module.id);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("本次知识同步超时，保留上次成功版本，可重试")), 200_000);
    timeout.unref?.();
    const work = syncModuleKnowledge(this.options.dataDir, module.id, operator, {
      signal: abort.signal,
      credential: this.options.platformGitCredential?.() ?? this.options.gitCredential?.(operator),
    }).then(() => {
      if (readModuleKnowledgeContentRevision(this.options.dataDir, module.id) !== previousContent) this.prepareKnowledgeIndex();
    }).catch(error => {
      this.options.log?.(`模块 ${module.name} 知识同步失败：${String(error)}`);
    }).finally(() => {
      clearTimeout(timeout);
      this.knowledgeRepositoryCompletedAt.set(module.id, Date.now());
      this.knowledgeRepositorySyncs.delete(module.id);
      this.refreshKnowledgeRepositories();
    });
    this.knowledgeRepositorySyncs.set(module.id, { abort, work });
  }

  private refreshKnowledgeRepositories(): void {
    if (this.shuttingDown) return;
    if (Date.now() - this.knowledgePublicationCheckedAt >= 60_000) {
      this.knowledgePublicationCheckedAt = Date.now();
      void this.domainKnowledgeExtraction?.refreshPublicationStatus().catch(error => this.options.log?.(`知识 MR 状态刷新失败：${String(error)}`));
    }
    if (this.knowledgeRepositorySyncs.size >= 2) return;
    try {
      const now = Date.now();
      const candidates = listBusinessModules(this.options.dataDir).modules.flatMap(module => {
        if (module.status !== "active" || this.knowledgeRepositorySyncs.has(module.id)
          || now - (this.knowledgeRepositoryCompletedAt.get(module.id) ?? 0) < 60_000) return [];
        try {
          if (!resolveModuleKnowledgeLocation(this.options.dataDir, module.id)) return [];
          const attemptedAt = Date.parse(readModuleKnowledgeSync(this.options.dataDir, module.id)?.attempted_at ?? "") || 0;
          return now - attemptedAt < 60_000 ? [] : [{ module, attemptedAt }];
        } catch (error) {
          this.options.log?.(`模块 ${module.name} 知识同步调度失败：${String(error)}`);
          return [];
        }
      }).sort((a, b) => a.attemptedAt - b.attemptedAt || a.module.id.localeCompare(b.module.id));
      // 先处理等待最久的模块；慢同步完成后也须冷却，不能反复占满两个后台名额。
      for (const { module } of candidates) {
        if (this.knowledgeRepositorySyncs.size >= 2) break;
        try {
          this.startModuleKnowledgeSync(module.id, module.updated_by);
        } catch (error) { this.options.log?.(`模块 ${module.name} 知识同步调度失败：${String(error)}`); }
      }
    } catch (error) { this.options.log?.(`知识仓同步调度失败：${String(error)}`); }
  }

  prepareKnowledgeIndex(): void {
    if (!this.memorySidecar || this.shuttingDown) return;
    clearTimeout(this.knowledgePrepareTimer);
    this.knowledgePrepareTimer = setTimeout(() => {
      const search = this.knowledgeSearch ??= new KnowledgeSearch(this.options.dataDir, this.memorySidecar);
      void search.prepare().catch(error => this.options.log?.(`知识预索引失败：${String(error)}`));
    }, 250);
    this.knowledgePrepareTimer.unref?.();
  }

  private memoryTools(task: TaskState): unknown[] | undefined {
    const memoryTools = createMemoryTools({
      repo: this.memoryRepo(task),
      search: (input) => this.memorySearch(task, input),
      expand: async (id) => {
        const row = this.memories().find(id);
        return row && memoryAccessible(row, this.memoryRepo(task), this.memoryModules(task), task.summary.product_version) ? this.memories().read(id) : undefined;
      },
      write: (input, callId) => this.recordMemory(task, { ...input,
        source: "agent_note", judged_by: "agent", repo: this.memoryRepo(task),
        task: task.summary.id, evidence: `agent:${callId}`, author: "Agent" }),
      onUse: (event) => this.logMemoryUsage(task, event),
    });
    // Persisted sessions may still contain calls to the old tool names. Keep
    // aliases there, without advertising them as a second search workflow.
    const legacy = task.resume ? memoryTools.filter(tool => tool.name !== "corpus_write")
      .map(tool => ({ ...tool, promptSnippet: undefined, promptGuidelines: [],
        description: `历史会话兼容入口；新的检索和展开请使用 knowledge。${tool.description}` })) : [];
    return [...legacy, ...memoryTools.filter(tool => tool.name === "corpus_write"), createKnowledgeTool({
      service: () => this.knowledgeSearch ??= new KnowledgeSearch(this.options.dataDir, this.memorySidecar),
      context: () => this.taskKnowledgeContext(task),
      onUse: event => this.logMemoryUsage(task, event),
      plan: () => this.componentPlan(task),
      research: () => this.getComponentResearch(),
      researchOperator: () => task.summary.luban_account ?? "本地部署",
    })];
  }

  private logMemoryUsage(task: TaskState, event: MemoryUsageEvent): void {
    recordMemoryUsage({ workspace: task.summary.workspace, taskId: task.summary.id,
      store: () => this.memories(), log: this.options.log }, event);
  }

  private componentPlan(task: TaskState) {
    return new ComponentPlan({ workspace: task.summary.workspace, cwd: () => task.cwd,
      baseline: () => task.summary.delivery?.target_branch ?? task.summary.baseline ?? "",
      search: () => this.getKnowledgeSearch(), context: () => ({ repo: this.memoryRepo(task),
        repositories: [...new Set([...(task.summary.repositories ?? []), ...(task.summary.repo_url ? [task.summary.repo_url] : [])])],
        moduleIds: (() => { const module = task.summary.business_module ?? this.tasks.get(task.summary.parent_task_id ?? "")?.summary.business_module;
          return module ? [module.id] : (task.summary.business_modules ?? []).map(item => item.id); })(), productVersion: task.summary.product_version }),
      usage: () => readMemoryUsage(task.summary.workspace) });
  }

  listTaskMemoryUsage(id: string): Array<Record<string, unknown>> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return readMemoryUsage(task.summary.workspace);
  }

  private recordMemory(task: TaskState, input: MemoryInput): MemoryRecord {
    const record = this.memories().record(input);
    // 索引是旁路:失败只记日志,正本已在 md 里,删索引重建也不丢。
    // 候选留档，采纳后才写入语义索引。
    // 主动记录直接保存；自动提炼仅由交付完成旁路触发。
    task.summary.memories_recorded = (task.summary.memories_recorded ?? 0) + 1;
    this.persist(task);
    this.options.log?.(
      `任务 ${task.summary.id} 记忆入库 ${record.id}(${record.source})`);
    return record;
  }

  listTaskMemories(id: string): MemoryRecord[] {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.memories().list({ task: id }).map((row) => ({ ...row, drafting: false }));
  }

  readTaskMemory(
    id: string,
    memoryId: string,
  ): { record: MemoryRecord; content: string } | undefined {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const record = this.memories().find(memoryId);
    if (!record || record.task !== id) return undefined;
    const content = this.memories().read(memoryId);
    return content === undefined ? undefined : { record, content };
  }

  reviewTaskMemory(id: string, memoryId: string, by: string, input: import("./taskMemory.ts").MemoryReviewInput, privileged = false): MemoryRecord {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (this.memories().find(memoryId)?.task !== id) throw new NotFoundError("记忆不属于本任务");
    try {
      const record = this.memories().review(memoryId, by, input);
      if (record.review?.status === "accepted") void this.memorySidecar?.ingest(join(this.memories().root, record.file)).catch(error => this.options.log?.(`经验索引更新失败，采纳记录已保存: ${String(error)}`));
      return record;
    } catch (error) { throw error instanceof MemoryError ? new TaskControlError(error.message) : error; }
  }

  withdrawTaskMemory(id: string, memoryId: string, by: string): MemoryRecord {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const found = this.memories().find(memoryId);
    if (!found || found.task !== id) throw new NotFoundError(`记忆 ${memoryId} 不存在`);
    try {
      return this.memories().withdraw(memoryId, by);
    } catch (error) {
      throw error instanceof MemoryError
        ? new TaskControlError(error.message) : error;
    }
  }

  /** 等在途起草全部落地(测试与优雅关闭用)。 */
  async flushMemoryDrafts(): Promise<void> {
    await this.deliveryExperiences.flush();
  }

  /** 记录已提供经验与同文件意见的关联，同一任务每条只记一次。
   * 不推断因果、不影响排序；记录失败只记日志。 */
  private noteMemoryRework(task: TaskState, file: string): void {
    try {
      const pushed = new Set<string>();
      for (const row of this.listTaskMemoryUsage(task.summary.id)) {
        if (!["launch", "phase", "edit", "context"].includes(String(row.moment))) continue;
        for (const id of (Array.isArray(row.ids) ? row.ids : []) as unknown[]) {
          pushed.add(String(id));
        }
      }
      if (!pushed.size) return;
      const ledger = this.memories().ledger;
      const already = new Set(ledger.rows()
        .filter((row) => row.kind === "rework" && row.task === task.summary.id)
        .map((row) => row.id));
      for (const record of this.memories().list()) {
        if (!pushed.has(record.id) || already.has(record.id)) continue;
        if (!record.paths.includes(file)) continue;
        ledger.append({ kind: "rework", id: record.id, task: task.summary.id, note: file });
        this.options.log?.(
          `经验 ${record.id} 提供后，关联文件 ${file} 出现新意见，已记录供复盘核对`);
      }
    } catch (error) {
      this.options.log?.(`记忆效果账写入失败: ${String(error)}`);
    }
  }

  /** 目录摘要:按成员 id 集合缓存在 corpus/_digests/ 下;成员没变就复用,
   * 变了就重做(模型 10 s 预算,失败用确定性兜底)。 */
  /** §6 沉底扫描。归档了东西就重建索引,让它们真的不再被检索到;
   * 重建是旁路(预算见 sidecar),没完成前归档的仍可能被搜到——如实记日志。 */
  sweepMemoryArchive(options: {
    now?: number; idleDays?: number; unanchoredDays?: number;
  } = {}): Array<{ id: string; reason: string }> {
    try {
      const archived = this.memories().sweepArchive(options);
      if (archived.length) {
        this.options.log?.(`任务记忆沉底 ${archived.length} 条:`
          + archived.map((row) => `${row.id}(${row.reason})`).join("; "));
        void this.memorySidecar?.reindex().then((chunks) => this.options.log?.(
          chunks === undefined
            ? "沉底后索引重建未完成(旁路不可用),归档的记忆在重建前仍可能被检索到"
            : `沉底后索引重建完成,${chunks} 块`));
      }
      return archived;
    } catch (error) {
      this.options.log?.(`任务记忆沉底扫描失败: ${String(error)}`);
      return [];
    }
  }

  /** 效能页只读页签(§9 可见不可管):全仓记忆 + 台账统计,按权重排。 */
  memoryInsights(): MemoryInsights {
    const store = this.memories();
    const stats = store.ledger.stats();
    const now = Date.now();
    const repos = new Map<string, MemoryRepoInsight>();
    const memories = store.list().map((row) => {
      const own = stats.get(row.id) ?? EMPTY_STATS;
      const bucket = repos.get(row.repo) ?? {
        repo: row.repo, total: 0, active: 0, archived: 0, withdrawn: 0, one_off: 0,
        pushes: 0, hits: 0, reworks: 0,
      };
      bucket.total += 1;
      if (row.withdrawn) bucket.withdrawn += 1;
      else if (row.archived) bucket.archived += 1;
      else if (!row.superseded_by && row.review?.status === "accepted") {
        bucket.active += 1;
        if (row.scope === "one_off") bucket.one_off += 1;
      }
      bucket.pushes += own.pushes;
      bucket.hits += own.hits;
      bucket.reworks += own.reworks;
      repos.set(row.repo, bucket);
      return {
        id: row.id, repo: row.repo, trigger: row.trigger, review: row.review,
        module: row.module, product_versions: row.product_versions, edited_by: row.edited_by, edited_at: row.edited_at, merged_into: row.merged_into, maintenance_note: row.maintenance_note,
        conclusion: row.conclusion.replace(/\s+/g, " ").slice(0, 240),
        source: row.source, judged_by: row.judged_by, scope: row.scope,
        draft: row.draft ?? "template", drafting: false, at: row.at, task: row.task,
        paths: row.paths, ...(row.line ? { line: row.line } : {}),
        weight: Number(memoryWeight(row, own, now).toFixed(3)),
        pushes: own.pushes, hits: own.hits, reworks: own.reworks,
        ...(own.last_used ? { last_used: own.last_used } : {}),
        ...(row.archived ? { archived: true, archive_reason: row.archive_reason } : {}),
        ...(row.withdrawn ? { withdrawn: true } : {}),
        ...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
      };
    }).sort((a, b) => b.weight - a.weight || b.at.localeCompare(a.at));
    return {
      generated_at: new Date(now).toISOString(),
      drafting: this.deliveryExperiences.activeCount,
      sidecar: this.memorySidecar
        ? (this.memorySidecar.available ? "ready" : "unavailable") : "absent",
      repos: [...repos.values()].sort((a, b) => b.total - a.total),
      memories,
    };
  }

  readMemoryInsight(memoryId: string): { record: MemoryRecord; content: string } | undefined {
    const record = this.memories().find(memoryId);
    if (!record) return undefined;
    const content = this.memories().read(memoryId);
    return content === undefined ? undefined : { record, content };
  }

  /** 责任人回答检视意见。普通问答由责任人逐条确认；“决策后处理”把
   * 责任人的原话继续交给 Agent，遇到现有人工决定卡则排进该卡，不
   * 越过任务本身的审批边界。 */
  async replyToAnnotation(
    id: string,
    annotationId: string,
    by: string,
    text: string,
    override = false,
  ): Promise<Annotation> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const store = this.annotations(task);
    const before = store.list().find((item) => item.id === annotationId);
    if (!before) throw new NotFoundError(`批注 ${annotationId} 不存在`);
    if (before.status === "draft" && (task.summary.status === "canceled"
        || (task.summary.status === "completed" && !(this.hasPublishedOverallStory(task) && before.artifact === OVERALL_STORY_ARTIFACT)))) {
      throw new TaskControlError(task.summary.status === "completed"
        ? "任务已经交付，这条意见只能作为归档记录，不能再发起答复"
        : "任务已由用户停止，不能再发起答复");
    }
    this.assertAnnotationOwner(task, by);
    const adminOverride = before.assignee !== by;
    let replied: Annotation;
    if (before.owner_reply) {
      if (before.route !== "owner_decision") {
        throw new TaskControlError("责任人已经答复，请逐条处置或让提出人继续补充意见");
      }
      if (before.assignee && before.assignee !== by && !adminOverride) {
        throw new AnnotationPermissionError(
          `这条意见指派给 ${before.assignee}，只能由他继续处理`);
      }
      replied = before;
    } else {
      replied = store.replyAsOwner(annotationId, by, text, adminOverride);
      this.persist(task);
    }
    // 答复通知提出人继续补充意见；闭环仍由任务责任人逐条决定。
    // “责任人决策”下一棒在 Agent，不在这里制造一条对提出人无动作的通知；
    // Agent 真正处理完以后仍走既有的复检通知。
    if (replied.route === "owner_reply" && replied.author !== by && !replied.external_review) {
      const notifier = this.options.notifier;
      if (notifier) {
        const title = String(task.summary.title ?? task.summary.requirement
          ?? task.summary.id).trim().slice(0, 80) || task.summary.id;
        this.bypass(task, `责任人答复通知 ${replied.author}`,
          notifier.notifyReviewReady({
            taskId: task.summary.id,
            senderAccount: by,
            account: replied.author,
            summary: `责任人 ${by} 已答复你在「${title}」中提出的检视意见。`
              + "可继续补充意见；最终由任务责任人逐条闭环。",
            link: personalTaskLink(
              this.notificationLinkBase(), replied.author, task.summary.id),
            revisionKey: `owner-reply:${replied.id}:r${replied.rework ?? 0}`,
          }));
      }
    }
    return this.annotations(task).list().find((item) => item.id === annotationId)!;
  }

  dropAnnotation(
    id: string,
    annotationId: string,
    by: string,
    override = false,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const annotations = this.annotations(task);
    this.assertAnnotationOwner(task, by);
    const item = annotations.list().find((entry) => entry.id === annotationId);
    if (!item) throw new NotFoundError(`批注 ${annotationId} 不存在`);
    if (item?.agent_assigned || (item?.status === "sent" && item.sent_via !== "owner_pending") || item?.status === "verified") throw new TaskControlError("已交给 Agent 或已闭环的意见不能删除");
    const dropped = annotations.drop(annotationId, by, true);
    if (dropped.status === "dropped") this.resolveFeedbackRecords(task, (record) =>
      record.source === "workspace" && record.source_id === dropped.id,
      "closed", "责任人删除待处理意见");
    this.refreshWorkspaceReviewClosure(task);
    return dropped;
  }

  supplementAnnotation(id: string, annotationId: string, context: string, by: string): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.assertAnnotationOwner(task, by);
    return this.annotations(task).saveAgentContext(annotationId, by, context);
  }

  editAnnotation(
    id: string,
    annotationId: string,
    note: string,
    by: string,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const store = this.annotations(task);
    this.assertAnnotationOwner(task, by);
    const item = store.list().find((one) => one.id === annotationId);
    if (!item) throw new NotFoundError(`批注 ${annotationId} 不存在`);
    if (item?.status === "verified") throw new TaskControlError("已闭环意见保留历史；如有新意见请另行提出");
    if (item?.agent_assigned || (item?.status === "sent" && item.sent_via !== "owner_pending")) throw new TaskControlError("已交给 Agent 的意见请等待答复后重新处理，再修改或补充");
    if (item.external_review) throw new TaskControlError("外部检视原文保留，请使用补充修改要求");
    return store.edit(annotationId, note, by, true);
  }

  /** 当前任务责任人逐条处置；保留 override 参数兼容旧调用，但不再授予代签权限。 */
  verifyAnnotation(
    id: string,
    annotationId: string,
    by: string,
    override = false,
    decision?: Omit<AnnotationResolution, "by" | "at">,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const annotations = this.annotations(task);
    const item = annotations.list().find((one) => one.id === annotationId);
    this.assertAnnotationOwner(task, by);
    if (task.summary.status === "completed" && !(this.hasPublishedOverallStory(task) && item?.artifact === OVERALL_STORY_ARTIFACT)) throw new TaskControlError("任务已归档，代码检视记录只读");
    if (!item) throw new NotFoundError(`批注 ${annotationId} 不存在`);
    if (!(item.response && item.response.revision === (item.rework ?? 0)) && !(item.owner_reply && item.sent_via === "owner_pending")) throw new TaskControlError("请先交给 Agent 处理并取得处理依据，或由责任人自行答复后再确认闭环");
    const verified = annotations.resolveAsOwner(annotationId, by, decision ?? {
      revision: item.rework ?? 0, outcome: "fixed", reason: "",
    });
    // 闭环保留原始依据；经验统一在 MR 合入完成后提炼。
    this.resolveFeedbackRecords(task, (record) =>
      record.source === "workspace" && record.source_id === verified.id
        && record.source_revision === (verified.rework ?? 0),
    "closed", `责任人 ${by} 逐条处置：${verified.resolution?.outcome}；${verified.resolution?.reason || verified.response?.summary || "已核对答复"}`);
    this.refreshWorkspaceReviewClosure(task);
    return verified;
  }

  private assertAnnotationOwner(task: TaskState, by: string): void {
    assertAnnotationOwnerAccess(by, task.summary.luban_account ?? "本地用户", task.summary.status);
  }

  /** 裁决另半边:返工。锚点若已失效,趁重锚定结果在手边把它换成当前
   * 原文——不换的话,退回的草稿定位还是指着一段已经不存在的文字。
   * 异步读产物:代码批注锚在完整 diff 上,同步读等于在 HTTP 路由里
   * 现算全工作区 diff(内网实锤:大仓上一次就是主线程堵 20 秒)。 */
  async reopenAnnotation(
    id: string, annotationId: string, by: string, expectedRevision?: number,
  ): Promise<Annotation> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.assertAnnotationOwner(task, by);
    const store = this.annotations(task);
    const item = store.list().find((one) => one.id === annotationId);
    if (task.summary.status === "completed" && !(this.hasPublishedOverallStory(task) && item?.artifact === OVERALL_STORY_ARTIFACT)) throw new TaskControlError("任务已归档，代码检视记录只读");
    let update: { line?: number; anchor?: string } | undefined;
    if (item) {
      const content = await this.annotationArtifactContentAsync(
        task, item.artifact);
      const [check] = reanchor([item], () => content);
      if (check?.state === "moved") update = { line: check.line };
      if (check?.state === "gone" && check.now) {
        update = { line: item.line, anchor: check.now };
      }
    }
    this.assertAnnotationOwner(task, by);
    const current = store.list().find((one) => one.id === annotationId);
    if (expectedRevision !== undefined && expectedRevision !== (current?.rework ?? 0)) throw new TaskControlError("意见版本已变化，请刷新后处理");
    if (current?.status !== "sent" && current?.status !== "verified") throw new TaskControlError("这条意见已退回，请刷新查看记录");
    if (current.status === "sent" && current.sent_via !== "owner_pending" && !current.response) throw new TaskControlError("Agent 尚在处理，请等待答复后继续处理");
    return store.reopen(annotationId, by, update, true);
  }

  /** 把批注渲染成模型清单。ids 省略=全部待送出的。
   * 只渲染不落状态——决定卡要先给人看一眼再决定送不送。 */
  previewAnnotations(id: string, ids?: string[]): string {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const picked = this.pickDrafts(task, ids);
    return renderAnnotations(picked, this.ticketOf(task));
  }

  /** 送批注:走插话通道,当场发给正在跑的模型。
   * 送达之后才标 sent——先标后发会留下"提过了"的假账,而人会据此
   * 以为说过了。 */
  async sendAnnotations(
    id: string,
    ids?: string[],
    actor?: string,
    allowForeign = false,
    backgroundRequirementReview = false,
    context = "",
  ): Promise<{
    sent: string[]; text: string; receipt?: string;
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    if (task.summary.status === "canceled") throw new TaskControlError("任务已由用户停止，不能再提交批注");
    const sender = actor ?? "本地用户";
    this.assertAnnotationOwner(task, sender);
    const owner = task.summary.luban_account ?? "本地用户";
    if (context.trim() && ids?.length !== 1) throw new TaskControlError("请逐条补充并发送检视意见");
    const requirementReview = task.summary.waiting?.step
      === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP;
    const { selected: picked } = annotationSubmissionPlan({
      items: this.annotations(task).list(), ids, sender, owner,
      allowForeign, requirementReview,
    });
    const publishedStory = this.hasPublishedOverallStory(task);
    const overall = publishedStory ? picked.filter((item) => item.artifact === OVERALL_STORY_ARTIFACT) : [];
    if (overall.length && overall.length !== picked.length) throw new TaskControlError("请将整体 Story 与其他材料的意见分开提交");
    if (task.summary.status === "completed" && !overall.length) throw new TaskControlError("MR 已合入，任务已经结束，不能再提交批注");
    if (!picked.length) {
      return { sent: [], text: "没有待发送的检视意见" };
    }
    const action = this.annotationSubmissionView(task)[overall.length ? "story" : "ordinary"];
    if (!action.enabled) throw new TaskControlError(action.hint);
    if (task.summary.status === "waiting_for_human" && !overall.length && await this.submitAnnotationReviewDecision(task, picked, sender, context)) {
      const sent = this.annotations(task).list().filter(item => picked.some(note => note.id === item.id)
        && item.status !== "draft" && item.sent_via !== "owner_pending").map(item => item.id);
      return { sent, text: renderAnnotations(picked, this.ticketOf(task)),
        receipt: annotationSubmissionReceipt(this.annotations(task).list(), sent, picked.length, task.summary.status) };
    }
    const delivered = await submitAnnotationWithReceipts(this.annotations(task), picked, sender, context,
      snapshot => this.deliverAgentAnnotations(task, snapshot, undefined, false, sender, backgroundRequirementReview),
      { requirementReview, ticket: this.ticketOf(task) });
    return {
      sent: delivered.sent,
      text: delivered.text,
      receipt: requirementReview ? requirementSubmissionReceipt(this.annotations(task).list(), delivered.sent)
        : annotationSubmissionReceipt(this.annotations(task).list(), delivered.sent, picked.length, task.summary.status),
    };
  }

  private async submitAnnotationReviewDecision(task: TaskState, picked: Annotation[], actor: string, context = ""): Promise<boolean> {
    return submitAnnotationReviewDecision({ status: task.summary.status, waiting: task.summary.waiting,
      ids: picked.map(item => item.id), actor, context,
      effects: () => stepChoiceEffects(this.options.host?.kernelRoot, this.reviewContractStep(task, task.summary.waiting)),
      decide: input => this.decide(task.summary.id, input) });
  }

  private async deliverAgentAnnotations(
    task: TaskState,
    picked: Annotation[],
    ownerDecisionContext?: string,
    queueAtHumanGate = false,
    sentBy?: string,
    backgroundRequirementReview = false,
  ): Promise<{ sent: string[]; text: string }> {
    if (this.hasPublishedOverallStory(task)
        && picked.some((item) => item.artifact === OVERALL_STORY_ARTIFACT)) {
      return this.overallStories.submit(task.summary.id, picked, sentBy);
    }
    const text = [
      ownerDecisionContext,
      concurrentWorkPrompt(),
      renderAnnotations(picked, this.ticketOf(task)),
      requirementAnnotationInstructions(picked, `.mae-flow-work/${task.summary.ticket ?? task.summary.id}/story.md`, this.isRequirementAnalysis(task)),
    ].filter(Boolean).join("\n\n");
    if (task.summary.status === "waiting_for_human"
        && task.summary.waiting?.step
          === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP) {
      await submitRequirementReview(task, this.annotations(task), picked,
        (batch) => this.reviseRequirementFromAnnotations(task, batch),
        backgroundRequirementReview ? (error) => {
          task.summary.detail = `Agent 修改需求失败，意见已恢复待提交：${String(error)}`;
          this.persist(task);
        } : undefined, sentBy);
      return { sent: picked.map((item) => item.id), text };
    }
    const gap = task.summary.delivery?.evidence_gap;
    // 有证据缺口时不能把任何批注都武断地解释成“流水线日志”。用户也
    // 可能正在代码 diff 上提功能意见；那一类必须走 MR 检视修复，不能
    // 被塞进 CI 取证字段后悄悄丢失。只有批注落在流水线材料上才回灌。
    const pipelineEvidence = Boolean(gap?.missing_dimensions.length)
      && picked.every((item) => /(?:pipeline|build|compile|codecheck|\but\b|日志|流水线)/i
        .test(`${item.artifact}\n${item.file}`));
    if (gap?.missing_dimensions.length && pipelineEvidence) {
      const combined = [gap.human_evidence, text]
        .map((item) => String(item ?? "").trim()).filter(Boolean)
        .join("\n\n").slice(0, 12_000);
      gap.human_evidence = combined;
      gap.human_dimensions = [...new Set([
        ...(gap.human_dimensions ?? []), ...gap.missing_dimensions,
      ])];
      // 活的修复会话直接收到；尚未启动的队列使命原位补充；全缺证据
      // 停在 verifying 时则重新分诊并自动派发修复。三种状态共用一条批注账。
      if (task.summary.status === "running" && task.driver) {
        await task.driver.steer(text);
      } else if (["queued", "running"].includes(task.summary.status)
          && task.mission) {
        task.mission += "\n\n- 人工刚从工作台贴回的流水线报错原文：\n"
          + text;
        if (task.retainedSession) task.pendingMainSteers = [...(task.pendingMainSteers ?? []), text];
      } else if (task.summary.status === "verifying") {
        task.summary.detail = "已收到人工流水线报错，正在自动恢复修复分诊";
        task.summary.delivery!.waiting_on = undefined;
        const loop = task.summary.delivery?.loop;
        if (loop?.kind === "ci" && loop.last_sha === gap.sha) {
          // 部分证据派发修复后，会话可能在人工回灌到达前因“缺信息且无新
          // 提交”停下。同 SHA 刹车防的是拿同一份输入空转，不该挡住
          // 新到的人类证据。把它作为原修复轮的续段重开，round 不加一。
          loop.last_sha = undefined;
          loop.round = Math.max(0, loop.round - 1);
          loop.state = "verifying";
          loop.diagnosis = undefined;
        }
        const max = this.repairBudget(task);
        const sha = gap.sha;
        const log = gap.failure_log ?? "";
        setImmediate(() => this.bypass(task, "人工流水线证据回灌",
          this.dispatchCiRepair(task, sha, log, max, task.controlEpoch)));
      } else {
        throw new NotFoundError(
          `任务 ${task.summary.id} 当前是 ${task.summary.status}，不能恢复流水线修复`);
      }
      const sent = this.annotations(task).markSentFor(picked, "pipeline_evidence", sentBy);
      this.persist(task);
      return { sent, text };
    }
    if (queueAtHumanGate && task.summary.status === "waiting_for_human") {
      this.annotations(task).markSentFor(
        picked, "queued_decision", sentBy);
      this.persist(task);
      return { sent: picked.map((item) => item.id), text };
    }
    if (["paused", "pausing"].includes(task.summary.status)) {
      const sent = this.annotations(task).markSentFor(picked, "queued_decision", sentBy);
      this.persist(task);
      return { sent, text };
    }
    if (task.summary.status === "queued" && !this.hasOpenMergeRequest(task)) {
      task.pendingMainSteers = [...(task.pendingMainSteers ?? []), text, this.reviewReceiptInstructionsFor(task, picked)];
      const sent = this.annotations(task).markSentFor(picked, "interrupt", sentBy);
      this.persist(task);
      return { sent, text };
    }
    if (this.hasOpenMergeRequest(task) && task.summary.status !== "waiting_for_human") {
      return this.sendMergeRequestReview(task, picked, text, sentBy);
    }
    // 任务正等人决定时，责任人转交的意见先持久化排队，
    // 正文由当前决定的 continuation 送达 Agent。
    if (task.summary.status === "waiting_for_human") {
      this.annotations(task).markSentFor(
        picked, "queued_decision", sentBy);
      this.persist(task);
      return { sent: picked.map((item) => item.id), text };
    }
    // 回执契约随意见一起到:原来普通插话只让 Agent"逐条回我改了什么",
    // 没有机器回执,平台无从判断处理完没有(举卡前那道闸要读它)。
    this.ensureReviewsDir(task);
    await this.interrupt(task.summary.id,
      [text, this.reviewReceiptInstructionsFor(task, picked)].join("\n\n"), undefined, undefined, "review_batch");
    const sent = this.annotations(task).markSentFor(picked, "interrupt", sentBy);
    return { sent, text };
  }

  /** MR 已经存在但尚未合入时，本地批注不是“给旧会话插句话”，而是
   * 当前 MR 的下一轮修改要求。运行中的修复会话直接合并处理；没有活
   * 会话时开启内核正式的 review 轮。始终复用原分支、原 MR。 */
  private async sendMergeRequestReview(
    task: TaskState,
    picked: Annotation[],
    text: string,
    sentBy?: string,
  ): Promise<{ sent: string[]; text: string }> {
    // 不可送达时先拒绝，不能先向内核开出一批任务再告诉用户“没提交”。
    const assertDeliverable = () => {
      if (!this.hasOpenMergeRequest(task)) throw new TaskControlError("当前 MR 或任务已结束，不能再提交检视修改");
      if (["paused", "pausing", "waiting_for_human"].includes(task.summary.status)) {
        throw new TaskControlError(task.summary.status === "waiting_for_human"
          ? "Agent 正在等你回答当前问题。这批批注已保存，请在当前决定卡提交；系统会把批注一并交给 Agent"
          : "任务当前已暂停，批注已经保存；恢复任务后即可提交给 Agent 继续修改");
      }
    };
    assertDeliverable();
    // await_merge 的页面与平台“刚刚点合入”可能竞态。能查询到终态就
    // 先如实收口；平台不支持门禁契约则 fail-open，后续 push 仍会以
    // 远端事实失败，不拿一次查询抖动阻塞人的意见。
    if (["await_merge", "verifying"].includes(task.summary.status)) {
      const view = await this.fetchGates(task);
      if (view?.mrState === "merged" || view?.mrState === "closed") {
        await this.settleMergeState(task, view.mrState, view.sourceSha);
        throw new TaskControlError(view.mrState === "merged"
          ? "MR 已合入，当前任务已经结束；如需继续修改，请创建后续任务"
          : "MR 已关闭，不能再向原 MR 提交修改；请重新打开 MR 或创建后续任务");
      }
    }
    if (!this.hasOpenMergeRequest(task)) {
      throw new TaskControlError(
        "当前 MR 已结束，不能再向原分支提交检视修改");
    }

    const delivered = this.mergeRequestReviewPrompt(task, text, picked);
    // prepush 是另一只专项 Agent，也会暂时占用 task.driver。把功能检视
    // steer 给它会与“只做编译/UT”使命打架。安全中止旧验证（不清现场），
    // 换代 epoch 让旧回调失去写状态权，再开正式 review 轮；新轮结束后
    // 会从头对新 HEAD 做 prepush，证据不会复用旧结果。
    let interruptedBuildFix = false;
    if (task.prepushActive) {
      interruptedBuildFix = true;
      task.controlEpoch += 1;
      const active = task.prepushActive;
      task.prepushAbort?.abort();
      await active.catch(() => undefined);
      if (task.prepushActive === active) task.prepushActive = undefined;
    }

    // 人工意见先入持久反馈账，再决定是 steer 当前 writer 还是排下一批。
    // 内核若已有 active batch 会把它排成 queued；绝不因新意见并发启动
    // 第二个 Agent。材料先落盘，重启后仍能从同一 source revision 恢复。
    assertDeliverable();
    const reviewsDir = join(task.summary.workspace, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, "local-annotations.json"), JSON.stringify({
      task_id: task.summary.id,
      mr_url: task.summary.delivery?.mr_url,
      submitted_at: new Date().toISOString(),
      annotations: picked,
    }, null, 2));
    this.openFeedbackBatch(task, "workspace", picked.map((item) => ({
      id: `workspace:${item.id}:r${item.rework ?? 0}`,
      source: "workspace",
      source_id: item.id,
      source_revision: item.rework ?? 0,
      kind: "code_review",
      summary: item.note.slice(0, 1000),
      material: resolve(task.summary.workspace, "reviews", "local-annotations.json"),
      verification: item.author,
      file: item.file,
      line: item.line,
    })));

    if (interruptedBuildFix && task.summary.status === "running"
        && !task.driver) {
      // performPrePush 的旧回调已因 epoch 失效，不再有权把 running 改回
      // verifying。宿主在确认专项 writer 已停净后先恢复到可派单投影，
      // 下面统一入口会启动人工反馈轮；否则会误等一个永远不会出现的
      // 主 driver，并把意见塞进无人消费的 pendingMainSteers。
      task.summary.status = "verifying";
      task.summary.detail = "Build-Fix 已为人工意见让出执行权，正在接续检视修复";
    }

    if (task.summary.status === "running") {
      // status 会在 launch 入口先切 running，driver 稍后才就绪。这个短窗
      // 不能误判成“没有会话”再开第二只 Agent；直接持久化到
      // pendingMainSteers，由 launch 在 start 后补送，不让提交请求空等。
      if (task.summary.status === "running" && task.driver) {
        await task.driver.steer(delivered);
      } else if (task.summary.status === "running") {
        task.pendingMainSteers = [...new Set([
          ...(task.pendingMainSteers ?? []), delivered,
        ])];
      } else {
        // 等待 driver 的几毫秒里旧会话可能刚好收口。此时再走一次本方法
        // 的状态分支，仍只会开一轮正式 review，不会与旧 writer 重叠。
        return this.sendMergeRequestReview(task, picked, text, sentBy);
      }
      this.rememberWorkspaceReview(task, picked);
      this.persist(task);
    } else if (task.summary.status === "queued" && task.mission) {
      // 还没拿到并发槽，直接把意见并进同一份持久使命；不会多起一轮。
      task.mission += `\n\n${delivered}`;
      if (task.retainedSession) task.pendingMainSteers = [...(task.pendingMainSteers ?? []), delivered];
      this.rememberWorkspaceReview(task, picked);
      this.persist(task);
    } else if (task.summary.status === "waiting_for_human") {
      throw new TaskControlError(
        "Agent 正在等你回答当前问题。这批批注已保存，请在当前决定卡提交；系统会把批注一并交给 Agent");
    } else if (["paused", "pausing"].includes(task.summary.status)) {
      throw new TaskControlError(
        "任务当前已暂停，批注已经保存；恢复任务后即可提交给 Agent 继续修改");
    } else {
      // 终止旧 SHA 的流水线/合入监控写权限，平台上的旧流水线可以自然
      // 跑完，但它再也不能把新开的检视轮状态覆盖回去。
      task.controlEpoch += 1;
      this.dispatchWorkspaceReviewRepair(task, picked, text);
    }
    const sent = this.annotations(task).markSentFor(picked, "review_repair", sentBy);
    return { sent, text };
  }

  private hasOpenMergeRequest(task: TaskState): boolean {
    const delivery = task.summary.delivery;
    if (!delivery?.mr_url || delivery.final_mr) return false;
    if (["completed", "canceled"].includes(task.summary.status)) {
      return false;
    }
    return !String(delivery.mr_state ?? "").startsWith("已合入")
      && delivery.mr_state !== "已关闭";
  }

  private mergeRequestReviewPrompt(task: TaskState, text: string, annotations: Annotation[]): string {
    return [
      "[MR 本地检视 · 用户已明确提交]",
      "这批意见是责任人明确交办的当前 MR 修改要求，结合正在进行的修复处理；不要另起交付分支或 MR。",
      text,
      "逐条核对并处理：要求明确就直接修改，不要再问一次‘是否接纳’；只有语义确实不清、不同理解会造成不同代码结果时才举卡，并把歧义说具体。",
      this.reviewReceiptInstructionsFor(task, annotations),
      "按责任人的最新目标安排工作；明确暂缓的旧问题用 task_control 登记，未取消的问题仍保留。已提交成果可用 task_control push 请求宿主阶段性推送，无需等所有问题修完。",
    ].filter(Boolean).join("\n\n");
  }

  /** 人工意见与正在运行的 CI 修复并流时，仍要留下独立的回检账。
   * “责任人让 Agent 继续”只会推进修改，不能覆盖意见作者的裁决权。 */
  private rememberWorkspaceReview(
    task: TaskState,
    annotations: Annotation[],
  ): void {
    const delivery = task.summary.delivery;
    if (!delivery) return;
    const max = this.repairBudget(task);
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    const startsNewCycle = !loop.workspace_review_recheck_required;
    loop.kind = "review";
    loop.review_source = "workspace";
    loop.workspace_review_pending = true;
    loop.workspace_review_recheck_required = true;
    loop.workspace_review_annotation_ids = [...new Set([
      ...(loop.workspace_review_annotation_ids ?? []),
      ...annotations.map((item) => item.id),
    ])];
    if (startsNewCycle || !loop.review_ids) {
      loop.review_ids = `workspace:${annotations.map((item) =>
        `${item.id}:r${item.rework ?? 0}`).sort().join(",")}:${Date.now()}`;
    }
    // 意见可能并入正在跑的 CI/冲突会话，不一定经过独立 review 派单。
    // 因此材料必须在登记 review cycle 的同一处落盘，不能只靠
    // dispatchWorkspaceReviewRepair 的旁支写文件。
    try {
      const reviewsDir = join(task.summary.workspace, "reviews");
      mkdirSync(reviewsDir, { recursive: true });
      const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
      const current = this.annotations(task).list().filter((item) =>
        wanted.has(item.id));
      writeFileSync(join(reviewsDir, "local-annotations.json"), JSON.stringify({
        task_id: task.summary.id,
        mr_url: delivery.mr_url,
        submitted_at: new Date().toISOString(),
        annotations: current,
      }, null, 2));
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 本地检视材料落盘失败(使命正文仍可用): ${String(error)}`);
    }
    // 同一任务上一轮的回执不能被下一轮误消费。删除的是仓外派生文件，
    // append-only 批注账里的历史回应仍完整保留。
    if (startsNewCycle) {
      try {
        rmSync(this.reviewReceiptsPath(task),
          { force: true });
      } catch { /* 下轮缺文件会明确停下，不拿清理故障挡住意见送达 */ }
    }
  }

  /** 消费本地检视 Agent 的结构化逐条回执。机器回应只写回批注账，不
   * 自动 verify；作者仍要看新代码后亲自裁决。 */
  /** 本轮还欠 Agent 回执的意见:已送出、且当前轮还没答。Agent 已经答
   * "需要补充说明"的那条不算欠——球在作者脚下,再要它答一遍就是让它把
   * 同一个问题重复问(内网实锤)。 */
  private awaitingAgentReceipt(item: Annotation): boolean {
    if (item.status !== "sent") return false;
    return !(item.response?.revision === (item.rework ?? 0)
      && item.response.outcome === "needs_clarification");
  }

  private async consumeWorkspaceReviewReceipts(task: TaskState): Promise<{
    ok: boolean;
    detail?: string;
    /** Agent 说需要作者补充说明的意见——是合法结论不是失败:球交给作者。 */
    clarifications?: Array<{ annotation_id: string; summary: string }>;
  }> {
    const epoch = task.controlEpoch;
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source !== "workspace") return { ok: true };
    const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
    if (!wanted.size) return { ok: true }; // 只有整体说明，由最终总检卡闭环
    const listed = this.annotations(task).list();
    const expected = agentReviewAnnotations(listed).filter((item) =>
      wanted.has(item.id) && this.awaitingAgentReceipt(item));
    if (!expected.length) return { ok: true };
    // 同一回执文件服务多批意见：已知但不属于当前批的条目不算“多出”，
    // 不替其他批次或专项会话登记；真正未知的 ID 仍明确报错。
    const expectedIds = new Set(expected.map((item) => item.id));
    const stale = new Set(listed.filter((item) => !expectedIds.has(item.id)).map((item) => item.id));
    const path = this.reviewReceiptsPath(task);
    const missing = expected.map((item) => item.id).join("、");
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return {
        ok: false,
        detail: code === "ENOENT"
          ? `Agent 没有留下逐条检视回执（缺 ${missing}）。`
            + "没有拿总体回复冒充逐条闭环。"
          : `逐条检视回执无法读取（缺 ${missing}）：${String(error)}。`
            + "没有拿总体回复冒充逐条闭环。",
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        detail: `Agent 留下的逐条检视回执不是有效 JSON（涉及 ${missing}）：`
          + `${String(error)}。没有拿总体回复冒充逐条闭环。`,
      };
    }
    // 回执可能包含作者尚未发送的草稿或已闭环意见；只消费本轮已发送项，
    // 不替作者发送草稿，也不让这些已知残留阻断有效回执。
    const dropStale = (rows: unknown[]) => rows.filter((row) => !stale.has(
      String((row as Record<string, unknown> | null)?.annotation_id ?? "")));
    if (raw && typeof raw === "object" && !Array.isArray(raw)
        && Array.isArray((raw as { receipts?: unknown }).receipts)) {
      (raw as { receipts: unknown[] }).receipts =
        dropStale((raw as { receipts: unknown[] }).receipts);
    } else if (Array.isArray(raw)) {
      raw = dropStale(raw);
    }
    const parsed = parseWorkspaceReviewReceipts(raw, expected);
    if (parsed.errors.length || parsed.missing_ids.length
        || parsed.unexpected_ids.length) {
      const facts = [
        parsed.missing_ids.length
          ? `缺少 ${parsed.missing_ids.join("、")}` : "",
        parsed.unexpected_ids.length
          ? `多出 ${parsed.unexpected_ids.join("、")}` : "",
        ...parsed.errors,
      ].filter(Boolean);
      return {
        ok: false,
        detail: `逐条检视回执不完整：${facts.join("；")}。已停下等待明确处理。`,
      };
    }
    const sha = task.cwd ? (await this.prePushRevision(task)).sha : undefined;
    const latest = new Map(agentReviewAnnotations(this.annotations(task).list()).map((item) => [item.id, item]));
    if (!this.current(task, epoch) || parsed.receipts.some((receipt) =>
      !latest.has(receipt.annotation_id) || (latest.get(receipt.annotation_id)!.rework ?? 0) !== receipt.revision)) {
      return { ok: false, detail: "任务或检视意见已变化，旧回执未登记，请按当前意见重新核对。" };
    }
    for (const receipt of parsed.receipts) {
      this.annotations(task).respond(receipt.annotation_id, {
        revision: receipt.revision,
        outcome: receipt.outcome,
        summary: receipt.summary,
        evidence: receipt.evidence ?? [],
        fixed_sha: sha,
      });
    }
    const clarification = parsed.receipts.filter((receipt) =>
      receipt.outcome === "needs_clarification");
    if (!clarification.length) return { ok: true };
    // "需要补充说明"是合法结论:回执齐了、球在作者脚下。原来把它当回执
    // 失败——先催 Agent"只补回执"(它只能把同一个问题再写一遍),两次后
    // 判 halted、通知责任人"自动补交仍未完成"(内网实锤:人看到的是一条
    // 报错,不是一个问题)。现在:通知意见作者,流程照走,push 前的
    // "逐条意见未闭环"那层会等作者补充并重提。
    const byId = new Map(listed.map((item) => [item.id, item]));
    for (const receipt of clarification) {
      const author = byId.get(receipt.annotation_id)?.author;
      if (!author || !this.options.notifier) continue;
      this.bypass(task, "追问通知", this.options.notifier.notifyOutcome({
        taskId: task.summary.id,
        account: author,
        status: "review_clarification",
        summary: `Agent 对你的检视意见 ${receipt.annotation_id} 有疑问:${
          receipt.summary.slice(0, 200)}。请在工作台「补充说明后重提」`,
        link: personalTaskLink(this.notificationLinkBase(), author, task.summary.id),
      }));
    }
    return {
      ok: true,
      clarifications: clarification.map((receipt) => ({
        annotation_id: receipt.annotation_id, summary: receipt.summary,
      })),
    };
  }

  /** 人工意见修复完以后，意见作者是唯一裁决人。最后一条点通过时只
   * 解除“逐条意见未闭环”这一层，不替任务责任人点击最终 push 卡。
   * 两层职责分开，既不会被责任人越权代签，也不会因为旧卡状态互相
   * 覆盖而出现“都通过了仍提交不了”。 */
  private refreshWorkspaceReviewClosure(task: TaskState): void {
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source !== "workspace"
        || !loop.workspace_review_recheck_required) return;
    const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
    if (!wanted.size) return; // 只有整体说明，由最终总检卡闭环
    const pending = this.annotations(task).list().filter((item) =>
      wanted.has(item.id)
      && (item.status === "draft" || item.status === "sent"));
    if (task.summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP) {
      task.summary.detail = pending.length
        ? `等待 ${pending.length} 条检视意见由责任人逐条处置`
        : "检视意见已全部闭环，等待责任人确认推送";
      this.persist(task);
    }
    if (pending.length || task.summary.waiting?.step !== CLOUD_PUSH_CONFIRM_STEP) {
      return;
    }
    const account = task.summary.luban_account;
    const notifier = this.options.notifier;
    if (!account || !notifier) return;
    const cycle = createHash("sha256")
      .update(loop.review_ids ?? [...wanted].sort().join(","))
      .digest("hex").slice(0, 16);
    this.bypass(task, "检视意见全部闭环通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `review-ready-to-push:${cycle}`,
      summary: "本轮人工检视意见已全部由责任人逐条处置，可以打开任务完成最终确认并推送。",
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  private pickDrafts(
    task: TaskState,
    ids?: string[],
    actor?: string,
    allowForeign = false,
    acceptRequirementSubmitted = false,
  ): Annotation[] {
    return pickAnnotationSubmission(this.annotations(task).list(), ids,
      actor, allowForeign, acceptRequirementSubmitted);
  }

  /** 决定卡与“主动送批注”不是同一种提交语义。
   *
   * 页面打开后，批注可能先通过插话通道从 draft 变成 sent；随后提交的
   * 决定仍携带旧 ID。它已经送达，不该重复发送，更不能因此拦住本次新写
   * 的补充说明。存在但已 sent/verified/dropped 的条目幂等跳过；真正不
   * 存在的 ID 仍拒绝，避免把跨任务或损坏的引用静默吞掉。 */
  private pickDecisionDrafts(
    task: TaskState,
    ids: string[],
    actor?: string,
  ): Annotation[] {
    const wanted = new Set(ids);
    const items = this.annotations(task).list();
    const found = new Set(items.map((item) => item.id));
    if ([...wanted].some((id) => !found.has(id))) {
      throw new NotFoundError("有批注不存在，请刷新后重试");
    }
    if (actor && items.some((item) => wanted.has(item.id)
        && item.status === "draft" && item.author !== actor)) {
      throw new AnnotationPermissionError("只能随决定提交自己写的批注");
    }
    return items.filter((item) =>
      pendingReviewAnnotation(item) && wanted.has(item.id)
        && (!actor || item.author === actor));
  }

  /** MR/流水线连接是部署基础设施，管理员页面只读自检、不暴露地址。 */
  private effectivePlatformUrl(): string | undefined {
    return this.options.delivery?.platformUrl;
  }

  private effectiveDefaultRepo(): string | undefined {
    return this.options.host?.repoPath;
  }

  /** 生效的提交信息规范(设置层压部署层)。平台钩子按正则拒收不合规
   * 提交(内网实测),这条规矩要在每个会话开场就给——包括修复会话。 */
  private effectiveCommitConvention(): string | undefined {
    const text = this.options.commitConvention;
    const trimmed = String(text ?? "").trim();
    return trimmed || DEFAULT_COMMIT_CONVENTION;
  }

  /** 当前生效的 models.json 同形内容(设置层压部署层)——
   * 下单模型选项和校验共用这一个口径。 */
  private activeModelsJson(): Record<string, unknown> {
    return (this.options.settings?.models().json ?? this.options.modelsJson
      ?? {}) as Record<string, unknown>;
  }

  /** 当前生效的视觉角色。角色必须指向 models.json 中明确声明支持图片
   * 的模型；配置漂移时宁可不暴露 Tool，也不把图片误发给文本模型。 */
  private activeVisionChoice(): VisionModelChoice | undefined {
    const choice = this.options.settings?.models().vision ?? this.options.vision;
    if (!choice?.provider || !choice?.model) return undefined;
    const spec = (this.activeModelsJson() as {
      providers?: Record<string, { models?: Array<{
        id?: string; input?: string[];
      }> }>;
    }).providers?.[choice.provider]?.models?.find((item) =>
      String(item?.id ?? "") === choice.model);
    return Array.isArray(spec?.input) && spec.input.includes("image")
      ? choice : undefined;
  }

  private taskVision(task: TaskState) {
    const choice = this.activeVisionChoice();
    return choice ? {
      choice,
      cacheDir: join(task.summary.workspace, "vision-cache"),
      timeoutMs: 45_000,
    } : undefined;
  }

  /** 管理页的一键实测：系统色块图 → 当前视觉模型角色 → 语义校验。
   * 不创建任务、不读取业务图片、不修改配置。 */
  async testVisionCapability(): Promise<VisionProbeResult> {
    const choice = this.activeVisionChoice();
    if (!choice) {
      return {
        status: "failed",
        provider: this.options.settings?.models().vision?.provider
          ?? this.options.vision?.provider ?? "",
        model: this.options.settings?.models().vision?.model
          ?? this.options.vision?.model ?? "",
        latency_ms: 0,
        error: "图片识别模型未完整配置，或模型未声明支持 image 输入",
      };
    }
    return probeVisionCapability({
      modelsJson: this.activeModelsJson(),
      choice,
      timeoutMs: 45_000,
    });
  }

  /** 发起页只读预匹配；不创建 task id、不写任务现场、不返回正文。 */
  previewLaunchKnowledge(
    input: LaunchKnowledgePreviewInput,
  ): LaunchKnowledgePreview {
    return previewLaunchKnowledge(this.options.dataDir, input);
  }

  /** 下单表单的数据源。
   *
   * 口径(用户 2026-08-18 拍板,按内网实战定的):
   * - **交付仓必填**,没有"默认仓"这回事——一个部署要服务很多个仓,
   *   默认仓只会让人漏看一眼就把单下错地方;
   * - **模型不给选**:管理员统一配一个,所有人用同一个。选择权留给
   *   人只会制造"为什么他的比我快"的困惑,也让成本不可控;
   * - 交付方式与修复轮预算仍按单可选(前者决定走哪条链,后者是钱);
   *   交付方式的选项**现读内核 flow.json**,前端与本文件都不另抄一份。
   *
   * `model` 字段仍然返回当前生效的那一个——不是给人选,是给界面显示
   * "这单会用谁跑",让人心里有数。 */
  launchOptions(account?: string): {
    /** 当前生效的模型(展示用,下单表单不提供选择;配了个人网关的
     * 成员展示个人网关,ADR-0068)。 */
    model?: { provider: string; model: string };
    /** 当前默认修复轮；缺省仍明确返回平台兜底 20。 */
    repair_rounds?: number;
    repo: ReturnType<typeof launchRepositoryOptions>;
    /** 单号/基线分支:内核配置确认要的两项事实,表单下单就收——
     * 和交付方式同一逻辑,不让模型开工后逐项来问。 */
    ticket: { enabled: boolean; required: boolean };
    baseline: { enabled: boolean; default: string };
    /** 交付方式选项:**现读内核 flow.json**,不在 TS 侧另抄一份。
     * 空数组=读不到内核定义,表单就别摆出选择(下单不预选,卡到时
     * 老老实实问人)。 */
    workflows: Array<
      { key: string; label: string; description?: string;
        steps?: number; acks?: number }>;
    /** 阶段内可组合项与能力偏好，和 Agent 消费的是同一份内核目录。 */
    execution_playbooks: ExecutionPlaybookOption[];
    /** 专业编辑器的精确标准基线；缺席时隐藏定制入口，不影响普通下单。 */
    workflow_standard?: WorkflowStandardSnapshot;
    /** 显式发布的业务模块目录。这里只给下单所需摘要，不含知识正文。 */
    business_modules: Array<{
      id: string;
      name: string;
      description: string;
      owner: string;
      repositories: string[];
      revision: number;
      assets: number;
      knowledge: Array<{
        id: string;
        title: string;
        summary: string;
        when_to_use: string;
        form: "document" | "skill" | "rule" | "example";
        repositories: string[];
        version: number;
      }>;
      updated_at: string;
    }>;
    /** 团队管理的 Skill 形态知识目录；正文不随下单接口返回。 */
    team_skills: HostSkillShelfEntry[];
    /** 服务级缺的配置(管理员去补)。非空=不给下单。 */
    blockers: Array<{ key: string; label: string; where: "admin" | "me" }>;
    /** 本部署要不要这两把个人令牌(由形态决定,见下方注释)。 */
    needs: { git_token: boolean; luban_token: boolean };
  } {
    // 表单要展示的"这单会用谁跑":配了个人网关的成员显示其个人网关
    // 模型(ADR-0068,让位判定见 personalLaneChoice),其余人显示平台
    // 网关现选。仍是展示位,不给选。
    const laneResolved = account ? this.resolvedModels(account) : undefined;
    const active = personalLaneChoice(laneResolved)
      ?? this.activeModelChoice();
    const blockers: Array<
      { key: string; label: string; where: "admin" | "me" }> = [];
    let businessModules: Array<{
      id: string; name: string; description: string; owner: string;
      repositories: string[]; revision: number; assets: number;
      knowledge: Array<{
        id: string; title: string; summary: string; when_to_use: string;
        form: "document" | "skill" | "rule" | "example";
        repositories: string[]; version: number;
      }>;
      updated_at: string;
    }> = [];
    let teamSkills: HostSkillShelfEntry[] = [];
    const workflowCatalogRoot = this.options.host?.kernelRoot
      ?? this.options.workflowCatalogRoot;
    const executionPlaybooks = readExecutionPlaybookOptions(
      workflowCatalogRoot);
    const workflowStandard = readWorkflowStandardSnapshot(
      workflowCatalogRoot);
    try {
      businessModules = listBusinessModules(this.options.dataDir).modules
        .filter((module) => module.status === "active")
        .map((module) => {
          const knowledge = module.assets
            .filter((asset) => asset.status === "published")
            .map((asset) => ({
              id: asset.id,
              title: asset.title,
              summary: asset.summary,
              when_to_use: asset.when_to_use,
              form: asset.form,
              repositories: [...asset.repositories],
              version: asset.version,
            }));
          return {
            id: module.id,
            name: module.name,
            description: module.description,
            owner: module.owner,
            repositories: module.repositories,
            revision: module.revision,
            assets: knowledge.length,
            knowledge,
            updated_at: module.updated_at,
          };
        });
    } catch (error) {
      // 模块知识是可选上下文；目录损坏要告警，但不能让所有人无法下单。
      this.options.log?.(`[business-modules] 下单目录读取失败(fail-open): ${error}`);
    }
    if (this.options.requirementDisabled) {
      blockers.push({ key: "requirement_disabled", where: "admin",
        label: "本部署为问题流专用(--issue-only),需求流程未启用;"
          + "处理问题请前往「问题处理」页" });
    }
    try {
      teamSkills = listHostSkillShelf(this.options.dataDir).skills
        .filter((skill) => skill.loadable
          && skill.nature !== "unclassified");
    } catch (error) {
      this.options.log?.(
        `[team-skills] 下单目录读取失败(fail-open): ${String(error)}`);
    }
    // 每条缺项**只在它真会咬人时才拦**:纯会话形态(不接代码仓)拦
    // Git 令牌毫无道理,没接通知端点拦通知令牌也一样——一刀切的门禁
    // 会把用不上那件东西的部署一起挡在门外。
    if (!active) {
      blockers.push({ key: "model", where: "admin",
        label: "模型网关未配置(管理页 → 模型网关,填写地址、API Key 和模型名称)"
          + ";没有它任何任务都跑不起来" });
    }
    if (this.options.host && !this.effectivePlatformUrl()) {
      blockers.push({ key: "platform", where: "admin",
        label: "交付基础设施未就绪；代码暂时无法交付，请联系部署维护人员检查 MR / 流水线服务" });
    }
    if (this.options.host && this.deliveryPlatformCheck
        && !this.deliveryPlatformCheck.ready) {
      blockers.push({ key: "platform_unhealthy", where: "admin",
        label: `交付平台预检未通过：${this.deliveryPlatformCheck.detail}` });
    }
    if (this.options.host && this.options.deploymentRuntime?.status === "error") {
      blockers.push({ key: "deployment_runtime", where: "admin",
        label: `部署自检未通过：${this.options.deploymentRuntime.detail}` });
    }
    return {
      model: active,
      repair_rounds: this.options.settings?.runtime().repair_rounds
        ?? this.options.delivery?.repairRounds
        ?? DEFAULT_REPAIR_ROUNDS,
      repo: launchRepositoryOptions(this.options.host, this.options.requirementDisabled),
      // AR/REQ 是业务任务身份，不是内核实现细节。即使是纯会话或本地
      // 演示形态也要保留填写入口；只有“是否强制填写”才随代码交付
      // 形态变化，避免同一套创建页在不同部署里凭空少一项。
      ticket: {
        enabled: true,
        required: !!this.options.host && !this.options.host.repoPath,
      },
      baseline: { enabled: !!this.options.host, default: "master" },
      workflows: workflowChoices(workflowCatalogRoot),
      execution_playbooks: executionPlaybooks,
      workflow_standard: workflowStandard,
      business_modules: businessModules,
      team_skills: teamSkills,
      blockers,
      needs: {
        // 个人令牌该不该要,由部署形态决定(同上:只拦真会咬人的)。
        git_token: !!this.options.host,
        // 假小鲁班不索令牌(没人消费它);切了真端点要求立刻恢复。
        // 判定在 Notifier 里,跟着生效端点走——内网 agent 实测在演示
        // 形态被"先配令牌"挡住,那是一道谁也过不去也不必过的假门。
        luban_token: this.options.notifier?.needsPersonalToken() ?? false,
      },
    };
  }

  /** 当前生效的模型:设置层显式配的 > models.json 里的第一个 >
   * 部署参数。**自动兜底那一步是有意的**——管理员贴完 models.json
   * 就能用,不必再手打一遍 provider/model(实测:服务起来后表单是空的,
   * 人不知道还差一步)。 */
  private activeModelChoice(): { provider: string; model: string } | undefined {
    const override = this.options.settings?.models() ?? {};
    const providers = (this.activeModelsJson() as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    }).providers ?? {};
    const firstProvider = Object.keys(providers)[0];
    const provider = override.provider || this.options.provider || firstProvider;
    const listed = (providers[provider ?? ""]?.models ?? [])
      .map((item) => String(item?.id ?? "")).filter(Boolean);
    const model = override.model || listed[0] || this.options.model;
    return provider && model ? { provider, model } : undefined;
  }

  /** 网关解析咽喉(ADR-0039/0068):「settings 压部署参数」的唯一合并点,
   *  会话启动点一律从这拿现场 models.json 与 provider/model,不许再
   *  各自内联一条 fallback 链——散弹式漏站(主会话换了网关、摘要
   *  还走老网关)就是这么来的。operator=任务归属人,按人取其个人
   *  网关(配齐即整体换装);缺席=平台口径。 */
  private resolvedModels(operator?: string): ResolvedModelConfig {
    return resolveModelConfig({
      settings: this.options.settings,
      deployment: {
        modelsJson: this.options.modelsJson,
        provider: this.options.provider,
        model: this.options.model,
        vision: this.options.vision,
      },
      personal: operator
        ? this.options.personalModels?.(operator) : undefined,
      operator,
      log: (message) => this.options.log?.(message),
    });
  }

  /** 本任务会话应用的整套模型配置:任务级 model_choice(下单冻结)>
   *  解析咽喉;个人网关命中时 model_choice 让位,模型以个人网关配置
   *  为准(ADR-0068,承 Beta 旧例)。原九处内联链有两种口味,这里保持
   *  各自等价:
   *  - plain(主会话/预热/摘要起草/prepush/开发助手):字段链到底,
   *    设置层没配就用部署参数,不做 models.json 首项兜底;
   *  - auto(需求修订/整体 Story):沿用 activeModelChoice 的首项
   *    兜底("贴完 models.json 就能用")。 */
  private sessionModels(task: TaskState, flavor: "plain" | "auto" = "plain"):
    ResolvedModelConfig & { choice?: { provider: string; model: string } } {
    const resolved = this.resolvedModels(task.summary.luban_account);
    // 个人网关命中:任务级 model_choice 让位(判定收在 personalLaneChoice,
    // ADR-0068,承 Beta 旧例),模型以个人网关配置为准。
    if (resolved.lane === "personal") {
      return { ...resolved, choice: personalLaneChoice(resolved) };
    }
    const choice = task.summary.model_choice
      ?? (flavor === "auto"
        ? this.activeModelChoice()
        : (resolved.provider && resolved.model
            ? { provider: resolved.provider, model: resolved.model }
            : undefined));
    return { ...resolved, choice };
  }

  /**
   * 用户在下单页显式触发的只读目录发现。令牌把“谁、哪些仓、哪条
   * 基线、当时看到的 Skill”绑在一起；创建任务只交所选 id，不接受
   * 浏览器自报路径或正文。
   */
  async scanRepositorySkills(input: {
    repositories: string[]; previewBlocked?: boolean;
    baseline?: string;
    account?: string;
  }): Promise<RepositorySkillCatalogResponse> {
    if (!this.options.host) throw new Error("本部署未接代码仓，无法读取仓内能力");
    const repositories = input.repositories
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    if (!repositories.length) throw new Error("请先填写至少一个代码仓");
    if (repositories.length > 12) throw new Error("一次最多读取 12 个代码仓");
    repositories.forEach(validateRepositoryAddress);
    const baseline = input.baseline?.trim() || "master";
    if (/\s/.test(baseline)) throw new Error("基线分支不能含空白字符");

    const credential = this.options.gitCredential?.(input.account);
    // 只读发现同样带着用户的个人令牌上网,和 clone/push 用同一套加固
    // 沙箱:部署机全局配置里的 insteadOf 改道不能把令牌带去别处。
    const prepared = credential
      ? this.prepareHostGitSandbox(credential) : undefined;
    const catalogs: RepositorySkillCatalog[] = [];
    try {
      for (const repository of repositories) {
        const discovered = await discoverRepositorySkills({
          repository,
          blockedPaths: readResourceBlocks(this.options.dataDir), previewBlocked: input.previewBlocked,
          baseline,
          credentialHelper: prepared?.helper,
          credentialArgs: prepared?.args,
          credentialEnv: prepared?.env,
          timeoutMs: 30_000,
        });
        catalogs.push(this.catalogWithConflicts({
          ...discovered,
          // 服务端选择与任务 summary 均使用用户输入的规范化字符串；
          // 发现器内部即使为本地相对路径做了绝对化，也不能让 key 漂移。
          repository,
        }));
      }
    } finally {
      this.cleanupHostGitCredential(prepared);
    }

    const now = Date.now();
    for (const [key, value] of this.repositorySkillCatalogs) {
      if (value.expiresAt <= now) this.repositorySkillCatalogs.delete(key);
    }
    while (this.repositorySkillCatalogs.size >= 64) {
      const oldest = this.repositorySkillCatalogs.keys().next().value;
      if (!oldest) break;
      this.repositorySkillCatalogs.delete(oldest);
    }
    const catalogToken = randomUUID();
    this.repositorySkillCatalogs.set(catalogToken, {
      account: input.account,
      repositories,
      baseline,
      expiresAt: now + 10 * 60_000,
      catalogs,
    });
    return { catalog_token: catalogToken, repositories: catalogs };
  }

  /**
   * 下单前的轻量可达性探测。这里只问远端“能否读取引用”，不 clone、
   * 不扫描内容，也不在浏览器里碰个人令牌。与真正 clone/push 共用同一
   * 套临时凭据和隔离 Git 环境，避免表单探测绿、真正执行却因身份不同红。
   */
  async probeRepositories(input: {
    repositories: string[];
    account?: string;
  }): Promise<RepositoryProbeResponse> {
    if (!this.options.host) {
      throw new Error("本部署未接代码仓，无法探测仓库地址");
    }
    const repositories = input.repositories
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    if (repositories.length > 12) throw new Error("一次最多探测 12 个代码仓");
    const credential = this.options.gitCredential?.(input.account);
    const sandbox = this.prepareHostGitSandbox(credential);
    try {
      const results = await Promise.all(repositories.map(async (repository) => {
        try {
          validateRepositoryAddress(repository);
          const windowsDrive = /^[a-z]:[\\/]/i.test(repository);
          if (!windowsDrive
              && /^[a-z][a-z\d+.-]*:/i.test(repository)
              && !/^(?:https?|file):\/\//i.test(repository)) {
            throw new Error("代码仓传输协议不受支持，只允许 HTTPS 或本地仓");
          }
          const remote = /^(?:https?|file):\/\//i.test(repository)
            ? repository : resolve(repository);
          const checked = await runGitProcess([
            ...sandbox.args, "ls-remote", "--symref", remote, "HEAD",
          ], {
            timeoutMs: 8_000,
            maxBuffer: 64 * 1024,
            env: sandbox.env,
          });
          if (checked.status === 0 && !checked.error && !checked.timedOut) {
            return { repository, reachable: true,
              message: "地址有效，仓库可访问" };
          }
          const detail = `${checked.stderr}\n${checked.error?.message ?? ""}`;
          const message = checked.timedOut
            ? "连接超时，请检查仓库服务或网络"
            : /authentication|authorization|access denied|forbidden|403|401|could not read username|terminal prompts disabled/i.test(detail)
              ? "仓库需要权限，请检查个人 Git Token"
              : /not found|does not exist|repository.*not found|no such file|not a git repository|does not appear to be a git repository/i.test(detail)
                ? "仓库不存在或地址填写有误"
                : /could not resolve host|name or service not known/i.test(detail)
                  ? "无法解析仓库主机，请检查域名"
                  : /failed to connect|couldn't connect|connection refused|network is unreachable/i.test(detail)
                    ? "无法连接仓库服务，请检查网络或地址"
                    : "仓库无法访问，请检查地址和个人 Git Token";
          return { repository, reachable: false, message };
        } catch (error) {
          return { repository, reachable: false,
            message: error instanceof Error ? error.message : "仓库地址无效" };
        }
      }));
      return { repositories: results };
    } finally {
      this.cleanupHostGitCredential(sandbox);
    }
  }

  private catalogWithConflicts(
    catalog: RepositorySkillCatalog,
  ): RepositorySkillCatalog {
    const hostNames = new Set(
      hostSkillNames(this.options.dataDir).map((name) => name.toLowerCase()));
    const counts = new Map<string, number>();
    for (const skill of catalog.skills) {
      const key = skill.name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const reserved = (name: string) => name === "mae-flow"
      || name === "build-fix"
      || /^(?:comet|openspec|ponytail)(?:-|$)/.test(name);
    const skills = catalog.skills.map((skill): RepositorySkillDescriptor => {
      const name = skill.name.toLowerCase();
      const conflict = hostNames.has(name)
        ? "与平台常驻 Skill 同名"
        : reserved(name)
          ? "与 Mae-Flow 平台能力重名"
          : (counts.get(name) ?? 0) > 1
            ? "本仓存在同名 Skill，无法确定应加载哪一个"
            : undefined;
      return conflict
        ? { ...skill, selectable: false, warning: conflict }
        : skill;
    });
    return { ...catalog, skills };
  }

  private selectedResourcesFromCatalog(options: {
    catalogToken?: string;
    selectedSkillIds?: string[];
    repositories: string[];
    baseline?: string;
    account?: string;
    /** Chain 检视重新读取目录时，不能因单个仓临时扫描失败
     * 就把父任务上已经确认的 Skill 清掉。仅该场景传入旧值；
     * 新下单仍不会从扫描失败的仓带入任何选择。 */
    preserveSkillsForErroredRepositories?: SelectedRepositorySkill[];
  }): {
    skills: SelectedRepositorySkill[];
  } {
    const skillIds = [...new Set((options.selectedSkillIds ?? []).map(String))];
    if (!skillIds.length && !options.catalogToken) {
      return { skills: [] };
    }
    if (!options.catalogToken) throw new Error("选择仓内能力前请重新读取 Skill 目录");
    const ticket = this.repositorySkillCatalogs.get(options.catalogToken);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      this.repositorySkillCatalogs.delete(options.catalogToken);
      throw new Error("仓内能力目录已过期，请重新读取后再发起任务");
    }
    if (ticket.account !== options.account) {
      throw new Error("仓内能力目录不属于当前登录用户");
    }
    if (JSON.stringify(ticket.repositories) !== JSON.stringify(options.repositories)
        || ticket.baseline !== options.baseline) {
      throw new Error("代码仓或基线已变化，请重新读取仓内能力");
    }
    if (skillIds.length > 20) throw new Error("每个任务最多选择 20 个仓内 Skill");
    const skillsById = new Map<string, {
      catalog: RepositorySkillCatalog;
      skill: RepositorySkillDescriptor;
    }>();
    const successfulRepositories = new Set(
      ticket.catalogs.filter((catalog) => !catalog.error)
        .map((catalog) => catalog.repository));
    for (const catalog of ticket.catalogs) {
      // 失败目录不参与 ID 还原。即使未来某个发现器在
      // error 上还附了部分 skills，也不能把不完整快照当成可选清单。
      if (catalog.error) continue;
      for (const skill of catalog.skills) {
        skillsById.set(skill.id, { catalog, skill });
      }
    }
    const selectedSkills = skillIds.map((id): SelectedRepositorySkill => {
      const found = skillsById.get(id);
      if (!found || !found.skill.selectable) {
        throw new Error("所选仓内 Skill 不存在或不可由 Agent 自主使用，请重新读取");
      }
      if (!validRepositorySkillPath(found.skill.relative_path)) {
        throw new Error("仓内 Skill 路径不合法");
      }
      return {
        id: found.skill.id,
        repository: found.catalog.repository,
        revision: found.catalog.revision,
        name: found.skill.name,
        description: found.skill.description,
        relative_path: found.skill.relative_path,
        source: found.skill.source,
        digest: found.skill.digest,
      };
    });
    const mergedSkills = options.preserveSkillsForErroredRepositories === undefined
      ? selectedSkills
      : ticket.repositories.flatMap((repository) => {
          if (successfulRepositories.has(repository)) {
            // 成功仓以本次 IDs 为准；没选中任何项就是显式清空。
            return selectedSkills.filter((skill) => skill.repository === repository);
          }
          // catalog.error（以及防御性的目录缺失）保留该仓旧值，
          // 不影响其他成功仓的更新。
          return options.preserveSkillsForErroredRepositories!
            .filter((skill) => skill.repository === repository)
            .map((skill) => ({ ...skill }));
        });
    if (mergedSkills.length > 20) {
      throw new Error("每个任务最多选择 20 个仓内 Skill");
    }
    this.repositorySkillCatalogs.delete(options.catalogToken);
    return { skills: mergedSkills };
  }

  /** 仓内知识的事实源只有 Git。首次进入 checkout 时把发现到的精确
   * commit/path/digest 固定到任务；MFC 不产生自己的发布版本，也不在
   * 后续会话重新扫描已经被 Agent 修改过的工作区。 */
  private freezeRepositoryNativeSkills(
    task: TaskState,
    materialized: ReturnType<typeof materializeRepositorySkills>,
  ): void {
    if (task.summary.repository_skills !== undefined) return;
    task.summary.repository_skills = materialized.entries
      .map(({ skill }) => ({ ...skill }));
    this.persist(task);
  }

  create(
    requirement: string,
    options: {
      /** 用户明确填写的任务名称：只用于列表/通知/搜索，不替代需求原文。 */
      title?: string;
      account?: string;
      repo?: string;
      repos?: string[];
      lane?: string;
      /** 需求/问题单号(REQ/DTS):内核配置确认的"单号"项,下单就给,
       * 不让模型开工后再来问一遍(用户 2026-08-19 拍板)。 */
      ticket?: string;
      /** 多仓发起时按仓库地址绑定的 AR 单号。缺席时兼容旧客户端：
       * 所有仓沿用 ticket；一旦提交则每个仓都必须有且只能有一个。 */
      repositoryTickets?: Record<string, string>;
      /** 旧客户端可在多仓发起时按仓库地址预填执行人；新入口统一在
       * 最终交付单元形成后再分配。普通单仓缺席时仍默认为下单人。 */
      repositoryAssignees?: Record<string, string>;
      /** 分析主任务的讨论参与人；不与仓库或交付单元绑定。 */
      collaborators?: string[];
      /** 原位重跑沿用主任务已受邀的参与人:他们在受邀时已核过就绪,
       * 之后个人设置过期与否在他们自己行动时再查;不让别人的令牌过期
       * 挡住主责任人重跑。 */
      collaboratorsTrusted?: boolean;
      /** 基线分支,默认 master(同一次拍板)。 */
      baseline?: string;
      productVersion?: string;
      model?: { provider: string; model: string };
      repairRounds?: number;
      /** 任务级低优先级执行补充；详细需求仍放 requirement。编译进
       * workflow_profile.supplements(v1 execution-profile 已退役)。 */
      taskInstructions?: string;
      /** 仅供原位重跑继承「代码仓约定已解析」的事实。 */
      repositorySupplementResolved?: boolean;
      /** 专业模式提交结构化编辑；普通用户缺席即保持既有 Mae-Flow。 */
      workflowDefinition?: unknown;
      /** 保存的工作流/任务复制由服务端资产路由传入；普通 API 不自报。 */
      workflowSource?: WorkflowSourceRef;
      workflowResolvedAssets?: WorkflowResolvedAsset[];
      /** 仅供原位重跑、跨仓拆单复制已经固定的完整最终方案。 */
      workflowProfile?: WorkflowExecutionProfileV2;
      workflowProfileWarning?: string;
      /** 重跑/拆单从父现场复制已经固定的团队 Skill，而不是重新读货架。 */
      hostSkillSnapshotSourceWorkspace?: string;
      /** 浏览器上传的原始文件名；正文仍由 requirement 统一承载。 */
      requirementDocumentName?: string;
      /** ZIP 材料包已由入口解析并改写为安全相对路径的图片。 */
      requirementBundleName?: string;
      requirementAssets?: RequirementAsset[];
      requirementSources?: RequirementSource[];
      requirementWarnings?: string[];
      /** Chain 拆单内部标记；外部下单绝不设置。子任务 requirement 仍是
       * 原始需求，单元任务书单独落盘，不再拼到长文档末尾。 */
      internalRequirement?: boolean;
      /** 单仓先走分析拆分。下单 API 不再接受它(2026-09-03 用户拍板:
       * 拆不拆是分析的产物,不是下单时的开关);只剩原位重跑沿用旧单事实
       * 这一个来源,Agent 提议拆分走 proposeSplit 在运行中置位。多仓天然
       * 分析,无需设置。 */
      requirementAnalysis?: boolean;
      /** 普通新下单进入工作台后先检视需求原文；人工确认后才正式
       * 进入需求分析。重跑和跨仓拆出的内部任务不重复举卡。 */
      requirementAnalysisConfirmation?: boolean;
      /** Chain 确认后生成的仓库交付任务使用；不暴露给普通 API。 */
      parentTaskId?: string;
      /** Chain 拆单内部定格的两份任务材料。当前单元任务书是执行入口，
       * 整体方案只负责解释上下游；普通下单 API 不接收。 */
      deliveryUnitMaterials?: { chain: string; unit: string };
      blockedBy?: string[];
      /** 交付单元的负责文件面(单仓拆分,Chain 建单内部下传):交付
       * 门禁据此校验越界。普通下单不暴露。 */
      deliveryScope?: { name: string; paths: string[] };
      /** 仅供原位从头重跑：复用已删除的 task-N，并等清理完成后再入队。 */
      reuseTaskId?: string;
      deferQueue?: boolean;
      /** 普通 API 只提交短期目录令牌和所选 id；服务端把它还原为
       * 已验证清单。repositorySkills 只供 Chain 拆单内部透传。 */
      repositorySkillCatalogToken?: string;
      selectedRepositorySkillIds?: string[];
      repositorySkills?: SelectedRepositorySkill[];
      /** 内部复制/旧客户端的精确团队 Skill 清单；普通下单页面不暴露
       * 选择，字段缺席时由服务端按任务范围自动匹配全部。工作流精确
       * 引用的 Skill 会在服务端强制并入。 */
      selectedHostSkillPaths?: string[];
      /** 普通下单只提交正式模块 ID；服务端在创建现场时固定当时的已发布
       * 资产版本与正文快照，浏览器不能自报内容。 */
      selectedBusinessModuleIds?: string[];
      businessModuleId?: string;
      /** 前端首次人工确认并由服务端验过的技术画像；知识旁路字段。 */
      repositoryProfiles?: RepositoryProfile[];
      /** 普通新下单开启：每个仓必须有非空技术画像。内部拆单/
       * 重跑和历史调用不开启，避免倒查老任务。 */
      requireRepositoryProfiles?: boolean;
      /** 发起页服务端预览的有序清单指纹；不一致时拒绝静默换名单。 */
      knowledgePreviewDigest?: string;
      /** 仅供跨仓拆单：从父任务复制已经固定的模块版本与正文。 */
      businessModules?: SelectedBusinessModule[];
      businessModuleSourceWorkspace?: string;
      /** 仅供旧跨仓父任务拆单：旧现场没有 repository_skills 字段时，
       * 子任务必须继续保留 undefined，让物化器走旧版全量加载兼容；
       * 不能与新下单的“明确未选择”空数组混为一谈。 */
      preserveUndefinedRepositorySkills?: boolean;
    } = {},
  ): TaskSummary {
    if (this.options.requirementDisabled) {
      throw new Error(
        "本部署为问题流专用(--issue-only),需求流程未启用;"
        + "处理问题请前往「问题处理」页");
    }
    const explicitTitle = options.title?.trim().replace(/\s+/g, " ") || undefined;
    if (explicitTitle && explicitTitle.length > 80) {
      throw new Error("任务名称不能超过 80 个字符");
    }
    let requirementDocument = requirementDocumentMeta(
      requirement, options.requirementDocumentName,
      options.internalRequirement
        ? MAX_REQUIREMENT_DOCUMENT_BYTES * 2
        : MAX_REQUIREMENT_DOCUMENT_BYTES);
    if (options.requirementBundleName || options.requirementAssets?.length || options.requirementSources?.length) {
      if (!requirementDocument) {
        throw new Error("需求资料必须包含可读取的完整正文");
      }
      requirementDocument = {
        ...requirementDocument,
        ...(options.requirementSources?.length ? { context_mode: "file" as const } : {}),
        bundle_name: options.requirementBundleName,
        assets: options.requirementAssets?.map(
          ({ content: _content, ...asset }) => asset) ?? [],
        sources: options.requirementSources?.map(
          ({ content: _content, ...source }) => source),
        warnings: options.requirementWarnings,
      };
    }
    // 交付方式:选项是内核的领地,现读它的 flow.json 校验
    // (2026-08-18 修正:此前 TS 侧自造"快速/慢速",与内核的
    // full/hotfix/tweak/review 对不上,预选永远匹配不上内核举的卡,
    // 用户下单答过一次、页面上还要再答一次)。读不到内核定义时不校验
    // ——宁可放行也不拿一套猜出来的选项挡人。
    const workflowCatalogRoot = this.options.host?.kernelRoot
      ?? this.options.workflowCatalogRoot;
    const workflowCatalog = workflowChoices(workflowCatalogRoot);
    const laneChoices = workflowCatalog.map((item) => item.label);
    const requestedLane = options.lane?.trim() || undefined;
    if (requestedLane !== undefined && laneChoices.length
        && !laneChoices.includes(requestedLane)) {
      throw new Error(
        `交付方式只能是 ${laneChoices.join("/")},收到: ${requestedLane}`);
    }
    // 单号/基线分支:内核配置确认要的两项事实,下单就收齐(和交付方式
    // 同一逻辑:能在表单上一次给完的,不让模型开工后逐项来问)。单号
    // 只在内核模式必填——纯会话形态没有配置确认这回事。校验只做"像不
    // 像个单号"的最低限(非空、无空白);REQ→feat/DTS→fix 的推导是
    // 内核的判定,宿主不代判。
    const legacyTicket = (options.ticket ?? "").trim() || undefined;
    if (legacyTicket && /\s/.test(legacyTicket)) {
      throw new Error("单号不能含空白字符");
    }
    const baseline = (resolveProductBranch(this.options.dataDir, options.productVersion, options.baseline) ?? "").trim()
      || (this.options.host ? "master" : undefined);
    if (baseline && /\s/.test(baseline)) {
      throw new Error("基线分支不能含空白字符");
    }
    const repositories = (options.repos?.length
      ? options.repos : options.repo ? [options.repo] : [])
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    const analysisParent = !options.parentTaskId
      && (repositories.length > 1 || options.requirementAnalysis === true);
    const repositoryTickets = new Map<string, string>();
    if (options.repositoryTickets !== undefined) {
      for (const [rawRepository, rawTicket] of Object.entries(
          options.repositoryTickets)) {
        const repository = rawRepository.trim();
        if (!repositories.includes(repository)) {
          throw new Error(`逐仓单号对应了本任务之外的代码仓：${repository}`);
        }
        const current = String(rawTicket).trim();
        if (!current) {
          throw new Error(`请填写代码仓 ${repository} 对应的 AR 单号`);
        }
        if (/\s/.test(current)) {
          throw new Error(`代码仓 ${repository} 的 AR 单号不能含空白字符`);
        }
        repositoryTickets.set(repository, current);
      }
      const missing = repositories.find((repository) =>
        !repositoryTickets.has(repository));
      if (missing) {
        throw new Error(`请填写代码仓 ${missing} 对应的 AR 单号`);
      }
    } else if (legacyTicket) {
      repositories.forEach((repository) =>
        repositoryTickets.set(repository, legacyTicket));
    }
    const ticket = repositories.length
      ? repositoryTickets.get(repositories[0]) ?? legacyTicket
      : legacyTicket;
    // 多仓或显式勾选"先分析拆分"的主任务不跑内核交付(只读分析,
    // 无分支无 MR),单号在拆分确认卡上逐单元收——那时才知道有几个交付。见
    // requirementGraphPlan 的对称校验:确认时每个单元必须有真单号。
    const ticketDeferredToSplit = analysisParent;
    if (!ticket && this.options.host && !this.options.host.repoPath
        && !ticketDeferredToSplit) {
      throw new Error("请填写每个代码仓对应的 AR 单号——分支名和提交信息都要用它");
    }
    const repositoryAssignees = new Map<string, string>();
    if (options.repositoryAssignees !== undefined) {
      for (const [rawRepository, rawAccount] of Object.entries(
          options.repositoryAssignees)) {
        const repository = rawRepository.trim();
        if (!repositories.includes(repository)) {
          throw new Error(`逐仓责任人对应了本任务之外的代码仓：${repository}`);
        }
        const account = String(rawAccount).trim();
        if (!account) throw new Error(`请为代码仓 ${repository} 选择责任人`);
        const readiness = this.options.collaborationAssigneeReadiness?.(account);
        if (readiness && !readiness.ready) {
          throw new Error(
            `代码仓 ${repository} 的责任人 ${account} 不可委派：`
            + readiness.missing.join("、"));
        }
        repositoryAssignees.set(repository, account);
      }
      const missing = repositories.find((repository) =>
        !repositoryAssignees.has(repository));
      if (missing) throw new Error(`请为代码仓 ${missing} 选择责任人`);
    } else if (options.account && !analysisParent) {
      repositories.forEach((repository) =>
        repositoryAssignees.set(repository, options.account!));
    }
    if (repositories.length === 1 && options.account
        && options.repositoryAssignees !== undefined
        && repositoryAssignees.get(repositories[0]) !== options.account) {
      throw new Error("单仓任务责任人必须是当前下单人；多仓任务才支持逐仓分工");
    }
    const collaborators = [...new Set((options.collaborators ?? [])
      .map((account) => String(account).trim())
      .filter((account) => account && account !== options.account))];
    if (collaborators.length && !analysisParent && !options.collaboratorsTrusted) {
      throw new Error("只有先分析再拆分的主任务可以邀请讨论参与人");
    }
    if (collaborators.length > 20) {
      throw new Error("一个主任务最多邀请 20 位讨论参与人");
    }
    for (const account of options.collaboratorsTrusted ? [] : collaborators) {
      const readiness = this.options.collaborationAssigneeReadiness?.(account);
      if (readiness && !readiness.ready) {
        throw new Error(
          `${account} 的个人设置尚未就绪：${readiness.missing.join("、")}`,
        );
      }
    }
    // 同仓并行不允许共用 AR，不能靠换责任人绕过。内部拆单允许串行复用，
    // 调度与提前开始时还会按实际依赖关系复核。不同仓不占用彼此的单号。
    if (ticket && !options.internalRequirement) {
      const duplicate = [...this.tasks.values()].find((existing) => {
        const summary = existing.summary;
        if (["completed", "failed", "canceled"].includes(summary.status)) {
          return false;
        }
        if ((summary.ticket ?? "") !== ticket) return false;
        const existingRepositories = [...new Set([
          ...(summary.repositories ?? []),
          ...(summary.repo_url ? [summary.repo_url] : []),
        ].map((item) => String(item).trim()).filter(Boolean))];
        return existingRepositories.length === 0 || repositories.length === 0
          || existingRepositories.some((repository) =>
            repositories.some(candidate => repositoryIdentity(candidate) === repositoryIdentity(repository)));
      });
      if (duplicate) {
        throw new TaskControlError(
          `单号 ${ticket} 已有在途任务 ${duplicate.summary.id}`
          + `(状态 ${duplicate.summary.status})。同仓并行任务不能使用相同 AR，以免同名分支或交付记录混淆`
          + "；请更换单号，或在旧任务上继续(重跑/答卡)，或先取消"
          + "它再重新发起");
      }
    }
    const repo = repositories[0];
    // 交付仓必填(用户 2026-08-18 拍板:没有"默认仓"这回事)。一个
    // 部署要服务很多个仓,兜底一个默认值只会让人漏看一眼就把单下错
    // 地方——宁可当场拒绝,也不替人猜他要交到哪儿。
    // 唯一豁免:部署显式用 `--repo` 钉死了单仓(演示/试跑/测试的
    // harness 形态,那是命令行不是产品面)。生产按 `--kernel-mode`
    // 不带 `--repo` 起,于是每单都必须写明。
    if (!repo && this.options.host && !this.options.host.repoPath) {
      throw new Error(
        "请填写交付代码仓——本部署不设默认仓,每单都要写明交到哪个仓");
    }
    for (const candidate of repositories) {
      if (!this.options.host) {
        throw new Error("本部署未接内核模式,任务不克隆代码仓");
      }
      // SSH、明文 userinfo 与控制字符的口径同时服务任务创建和 Skill
      // 目录扫描，不能让“能列出、却注定无法交付”的仓进入下一步。
      validateRepositoryAddress(candidate);
    }
    // 钉死单仓部署(serve --repo/假平台,repoPinned)不接受逐单仓:
    // 任务会克隆用户填的地址、把分支推到那里,而交付平台盯的是部署仓
    // ——推送与 MR 各查各的,走到最后一步才 MR 400,整单白烧
    // (e2e-picky-20260830 实锤,MFC-004/024)。与部署仓相同的写法
    // 放行;直接构造 TaskService 的测试/试跑不置 repoPinned,不受限。
    const pinnedRepo = this.options.host?.repoPinned
      ? this.options.host.repoPath : undefined;
    if (pinnedRepo && repositories.length && !options.internalRequirement) {
      const normalize = (value: string) =>
        /^(https?|ssh|git):\/\//i.test(value) ? value : resolve(value);
      const pinnedNormalized = normalize(pinnedRepo);
      const mismatched = repositories.filter((candidate) =>
        normalize(candidate) !== pinnedNormalized);
      if (mismatched.length) {
        throw new Error(
          `本部署已用固定交付仓启动,不接受逐单代码仓(${mismatched[0]})。`
          + "留空即使用部署仓;需要逐单交付请以 --kernel-mode(不带 --repo)部署");
      }
    }
    if (options.model) {
      // 下单不再给选模型(用户拍板:管理员统一配一个)。这条通路留给
      // 试跑器/测试显式指定,仍然当场校验存在性——选了不存在的模型,
      // 晚到会话启动才炸是坑人。
      const providers = (this.activeModelsJson() as {
        providers?: Record<string, { models?: Array<{ id?: string }> }>;
      }).providers ?? {};
      const listed = (providers[options.model.provider]?.models ?? [])
        .map((item) => String(item?.id ?? ""));
      if (!listed.includes(options.model.model)) {
        throw new Error(
          `没有模型 ${options.model.provider}/${options.model.model}`);
      }
    }
    if (options.repairRounds !== undefined
        && (!Number.isFinite(options.repairRounds)
            || options.repairRounds < 0)) {
      throw new Error("修复轮预算必须是 ≥0 的数字");
    }
    // 先校验再分配 task id，避免一个超长输入白白消耗任务序号。
    const taskInstructions = normalizeTaskExecutionInstructions(
      options.taskInstructions);
    const directResources = options.repositorySkills !== undefined;
    const explicitCatalogSelection = options.repositorySkillCatalogToken !== undefined
      || options.selectedRepositorySkillIds !== undefined;
    const selectedResources = !options.preserveUndefinedRepositorySkills
        && !directResources && explicitCatalogSelection
      ? this.selectedResourcesFromCatalog({
          catalogToken: options.repositorySkillCatalogToken,
          selectedSkillIds: options.selectedRepositorySkillIds,
          repositories,
          baseline,
          account: options.account,
        })
      : undefined;
    const repositorySkills = options.preserveUndefinedRepositorySkills
      ? undefined
      : directResources
        ? (options.repositorySkills ?? []).map((skill) => {
            if (!repositories.includes(skill.repository)
                || !validRepositorySkillPath(skill.relative_path)) {
              throw new Error(`仓内 Skill ${skill.name} 不属于本任务代码仓`);
            }
            return { ...skill };
          })
      : selectedResources?.skills;
    if ((repositorySkills?.length ?? 0) > 20) {
      throw new Error("每个任务最多选择 20 个仓内 Skill");
    }
    // 画像必须在知识预览和 task id 分配前定格：同一份输入同时决定
    // 团队 Skill 和任务台账；被拒的新单也不应留下空现场。
    let repositoryProfiles = options.repositoryProfiles ?? [];
    if (options.repositoryProfiles === undefined && repositories.length) {
      try {
        repositoryProfiles = resolveRepositoryProfiles(
          this.options.dataDir, repositories)
          .flatMap((item) => item.profile ? [{ ...item.profile }] : []);
      } catch (error) {
        if (options.requireRepositoryProfiles) {
          throw new Error(
            "仓库技术画像暂时无法读取，请在发起页重新选择：" + String(error));
        }
        this.options.log?.(
          "[repository-profiles] 读取失败，已退化为按仓库匹配"
          + "（不影响旧流程）：" + String(error));
      }
    }
    if (options.requireRepositoryProfiles && repositories.length) {
      repositoryProfiles = requireRepositoryProfiles(
        repositories, repositoryProfiles, this.options.dataDir);
    }
    repositoryProfiles = repositoryProfiles.map((profile) => ({
      ...profile, technologies: [...profile.technologies],
    }));
    if (options.workflowDefinition !== undefined && !options.workflowProfile
        && !options.hostSkillSnapshotSourceWorkspace) {
      requireTechnologyStacks(this.options.dataDir,
        normalizeWorkflowDefinition(options.workflowDefinition).applicability.technologies);
    }
    const profileTechnologies = [...new Set(repositoryProfiles
      .flatMap((profile) => profile.technologies))];
    const effectiveKnowledgeSelections = effectiveLaunchKnowledgeSelections({
      selectedBusinessModuleIds: options.selectedBusinessModuleIds,
      workflowDefinition: !options.workflowProfile
        ? options.workflowDefinition : undefined,
    });
    const workflowSelections = effectiveKnowledgeSelections.workflow;
    const selectedBusinessModuleIds =
      effectiveKnowledgeSelections.businessModuleIds;
    let expectedKnowledgePreview:
      ReturnType<typeof previewLaunchKnowledge> | undefined;
    if (options.knowledgePreviewDigest) {
      const currentPreview = previewLaunchKnowledge(this.options.dataDir, {
        repositories,
        selectedBusinessModuleIds: options.selectedBusinessModuleIds,
        selectedHostSkillPaths: options.selectedHostSkillPaths,
        repositoryProfiles,
        workflowDefinition: !options.workflowProfile
          ? options.workflowDefinition : undefined,
      });
      if (!currentPreview.complete) {
        throw new Error("发起前知识清单暂时无法完整核对，请稍后重试");
      }
      if (currentPreview.selection_digest !== options.knowledgePreviewDigest) {
        throw new Error("发起前知识清单已变化，请核对更新后的清单再发起");
      }
      expectedKnowledgePreview = currentPreview;
    }
    const id = options.reuseTaskId ?? this.allocateTaskId();
    if (options.reuseTaskId && (!/^task-\d+$/.test(id)
        || this.tasks.has(id) || existsSync(join(this.options.dataDir, id)))) {
      throw new TaskControlError(`任务 ${id} 不能安全地原位重建`);
    }
    const businessModule = options.businessModuleId ? this.requireBusinessModule(options.businessModuleId) : undefined;
    if (businessModule && options.parentTaskId) throw new TaskControlError("子任务统一使用主任务所属业务模块");
    const workspace = join(this.options.dataDir, id);
    let workflowProfileWarning = options.workflowProfileWarning;
    let workflowProfile = options.workflowProfile
      ? structuredClone(options.workflowProfile) : undefined;
    mkdirSync(workspace, { recursive: true });
    if (options.requirementAssets?.length) {
      storeRequirementAssets(workspace, options.requirementAssets);
    }
    if (options.requirementSources?.length) {
      storeRequirementSources(workspace, options.requirementSources);
    }
    let issueEnvironments: IssueEnvironmentRef[] = [];
    let businessModules: SelectedBusinessModule[] = [];
    let teamSkills: HostSkillShelfEntry[] = [];
    let hostSkillSnapshotWarnings: string[] = [];
    try {
      if (options.deliveryUnitMaterials) {
        if (!options.parentTaskId) {
          throw new Error("只有拆分后的子任务可以携带单元任务书");
        }
        writeFileSync(join(workspace, DELIVERY_CHAIN_SOURCE),
          options.deliveryUnitMaterials.chain, { mode: 0o600 });
        writeFileSync(join(workspace, DELIVERY_UNIT_SOURCE),
          options.deliveryUnitMaterials.unit, { mode: 0o600 });
      }
      if (options.businessModules !== undefined) {
        if (!options.businessModuleSourceWorkspace) {
          throw new Error("复制业务模块快照时缺少父任务现场");
        }
        businessModules = copyBusinessModuleSnapshots({
          selected: options.businessModules,
          sourceTaskWorkspace: options.businessModuleSourceWorkspace,
          targetTaskWorkspace: workspace,
          repositories,
        });
      } else {
        businessModules = snapshotBusinessModules({
          dataDir: this.options.dataDir,
          taskWorkspace: workspace,
          moduleIds: selectedBusinessModuleIds,
          repositories,
        });
      }
      const hostSkillSnapshotRoot = join(workspace, "host-skill-snapshot");
      mkdirSync(hostSkillSnapshotRoot, { recursive: true, mode: 0o750 });
      const hostSkillSourceRoot = options.hostSkillSnapshotSourceWorkspace
        ? join(options.hostSkillSnapshotSourceWorkspace, "host-skill-snapshot")
        : join(this.options.dataDir, "skills");
      let selectedHostSkillPaths = options.selectedHostSkillPaths === undefined
          && workflowSelections.teamSkillIds.length === 0
        ? undefined : [...new Set((options.selectedHostSkillPaths ?? [])
          .map((item) => String(item).trim()).filter(Boolean))];
      // 专业工作流是用户明确编排，引用的团队 Skill 不能被普通清单里的
      // 一次取消勾选悄悄拿掉；核心流程仍不依赖任何知识资产。
      if (selectedHostSkillPaths && workflowSelections.teamSkillIds.length
          && !options.hostSkillSnapshotSourceWorkspace) {
        try {
          const shelf = listHostSkillShelf(this.options.dataDir);
          const required = shelf.skills.filter((skill) =>
            workflowSelections.teamSkillIds.includes(
              (skill.source_path ?? skill.path).split("/")[0]))
            .map((skill) => skill.path);
          selectedHostSkillPaths = [...new Set([
            ...selectedHostSkillPaths, ...required,
          ])];
        } catch (error) {
          this.options.log?.(
            `[host-skill-snapshot] 工作流团队 Skill 目录解析失败(fail-open): ${String(error)}`);
        }
      }
      const hostSkillSnapshot = materializeHostSkills({ moduleDataDir: this.options.dataDir,
        sourceRoot: hostSkillSourceRoot,
        workspaceRoot: workspace,
        snapshotRoot: hostSkillSnapshotRoot,
        selectedSourcePaths: options.hostSkillSnapshotSourceWorkspace
          ? undefined : selectedHostSkillPaths,
        // 新任务自动匹配并固定版本。新跨仓子任务复制父快照时仍按该
        // 子仓画像收窄，避免 C++ 单元带入 Java Skill；无画像的旧任务
        // 保留原来的整份复制语义。
        context: !options.hostSkillSnapshotSourceWorkspace
            || profileTechnologies.length > 0 ? {
          repositories, technologies: profileTechnologies,
          businessModuleIds: businessModules.map((module) => module.id),
        } : undefined,
      });
      hostSkillSnapshotWarnings = hostSkillSnapshot.warnings;
      try {
        teamSkills = listHostSkillShelfRoot(hostSkillSnapshotRoot).skills;
      } catch (error) {
        hostSkillSnapshotWarnings.push(`团队 Skill 清单读取失败：${String(error)}`);
      }
      for (const warning of hostSkillSnapshotWarnings) {
        this.options.log?.(
          `[host-skill-snapshot] 任务 ${id}: ${warning}`);
      }
      if (expectedKnowledgePreview) {
        const expectedBusiness = expectedKnowledgePreview.business_knowledge
          .map((item) => ({
            module_id: item.module_id,
            module_revision: item.module_revision,
            id: item.id,
            version: item.version,
            digest: item.digest,
          }));
        const actualBusiness = businessModules.flatMap((module) =>
          module.assets.map((asset) => ({
            module_id: module.id,
            module_revision: module.revision,
            id: asset.id,
            version: asset.version,
            digest: asset.digest,
          })));
        const expectedSkills = expectedKnowledgePreview.team_skills
          .map((item) => ({
            path: item.path,
            digest: item.digest,
            package_digest: item.package_digest,
          }));
        const actualSkills = teamSkills.map((item) => ({
          path: item.source_path ?? item.path,
          digest: item.digest,
          package_digest: item.package_digest,
        }));
        if (JSON.stringify({ business: actualBusiness,
          skills: actualSkills })
            !== JSON.stringify({ business: expectedBusiness,
              skills: expectedSkills })) {
          throw new Error(
            "发起前知识清单未能按核对版本完整固定，请重新核对后再发起");
        }
      }
      storeRequirementDocument(workspace, requirement, requirementDocument);
    } catch (error) {
      removeTaskTree(workspace);
      throw error;
    }
    if (!workflowProfile && options.workflowDefinition !== undefined) {
      const standard = readWorkflowStandardSnapshot(
        workflowCatalogRoot);
      if (!standard) {
        workflowProfileWarning = [
          workflowProfileWarning,
          "工作流标准目录暂不可读，已采用既有 Mae-Flow 默认流程；本次定制未生效",
        ].filter(Boolean).join("；");
      } else {
        workflowProfile = compileWorkflow({
          baseSnapshot: standard,
          definition: options.workflowDefinition,
          source: options.workflowSource ?? { kind: "task", id },
          resolvedAssets: options.workflowResolvedAssets
            ?? resolveWorkflowAssets({
              definition: options.workflowDefinition,
              dataDir: this.options.dataDir,
              repositories,
              technologies: profileTechnologies,
              businessModules,
              repositorySkills,
              hostSkillSnapshotRoot: join(workspace, "host-skill-snapshot"),
            }),
        });
      }
    }
    // 文字建议层(任务补充+团队约定)并入定格方案;没选工作流也一样
    // ——产出 supplement-only 档,内核只认这一个文件(v1 退役)。
    // 原位重跑/拆单传入的 workflowProfile 已带 supplements,不重复叠。
    if (!options.workflowProfile) {
      const supplements = buildTaskSupplements(
        id, taskInstructions,
        this.options.settings?.executionPolicy().team_instructions);
      if (supplements.length) {
        workflowProfile = withWorkflowSupplements(
          workflowProfile, supplements);
      }
    }
    const summary: TaskSummary = {
      id,
      // 旧调用方/历史兼容仍可从首行生成；产品下单界面会明确收任务名称，
      // 不再让用户输入的长需求文档悄悄承担标题职责。
      title: explicitTitle ?? taskTitle(requirement),
      requirement,
      requirement_document: requirementDocument,
      status: "queued",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      workspace,
      luban_account: options.account || undefined,
      collaborators: collaborators.length ? collaborators : undefined,
      repo_url: repo,
      repositories: repositories.length ? repositories : undefined,
      repository_profiles: repositories.length
        ? repositoryProfiles
          .filter((profile) => repositories.some((repository) =>
            repository.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()
            === profile.repository.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()))
        : undefined,
      repository_skills: repositorySkills,
      team_skills: teamSkills.length ? teamSkills : undefined,
      business_modules: businessModules.length ? businessModules : undefined,
      business_module: businessModule,
      business_module_history: businessModule ? [{ at: new Date().toISOString(), by: options.account ?? "本地部署", to: businessModule }] : undefined,
      requirement_graph: repositories.length
        ? {
            stage: analysisParent ? "analysis" : "confirmed",
            // 这里只是让分析开始前能展示候选仓、邀请参与人，不是 Agent
            // 产出的交付图。确认入口必须等 requirement-graph.json 被成功
            // 解析后看到 ready，绝不能拿这份一仓一节点的占位数据建任务。
            projection_state: analysisParent ? "pending" : "ready",
            ...(analysisParent ? { sync_required: true } : {}),
            repositories: repositories.map((url, index) => ({
              id: `repo-${index + 1}`,
              name: basename(url).replace(/\.git$/, "") || `仓库 ${index + 1}`,
              url,
              ticket: repositoryTickets.get(url) ?? ticket,
              assignee: repositoryAssignees.get(url),
            })),
            dependencies: [],
          }
        : undefined,
      parent_task_id: options.parentTaskId,
      ...(options.requirementAnalysis === true && !options.parentTaskId
        ? { requirement_analysis_requested: true } : {}),
      ...(options.requirementAnalysisConfirmation === true
          && !options.parentTaskId && !options.internalRequirement
          && !options.reuseTaskId
        ? { requirement_analysis_confirmation_required: true } : {}),
      blocked_by: options.blockedBy?.length ? [...options.blockedBy] : undefined,
      ...(options.deliveryScope?.paths.length
        ? { delivery_scope: {
            name: options.deliveryScope.name,
            paths: [...options.deliveryScope.paths],
          } }
        : {}),
      // 用户拍板:交付方式下单就定,不让 agent 再问一遍。默认取内核
      // 选项里的第一项(通常是"完整开发"),读不到内核就不预选。
      lane: requestedLane ?? laneChoices[0],
      ticket,
      baseline,
      product_version: options.productVersion,
      model_choice: options.model,
      repair_rounds: options.repairRounds,
      repository_supplement_resolved: options.repositorySupplementResolved,
      workflow_profile: workflowProfile,
      workflow_profile_warning: workflowProfileWarning,
      host_skills_pinned: true,
      host_skill_snapshot_warnings: hostSkillSnapshotWarnings.length
        ? hostSkillSnapshotWarnings : undefined,
    };
    const runtimeRepairRounds =
      this.options.settings?.runtime().repair_rounds;
    const deploymentRepairRounds = this.options.delivery?.repairRounds;
    const effectiveRepairRounds = options.repairRounds
      ?? runtimeRepairRounds ?? deploymentRepairRounds
      ?? DEFAULT_REPAIR_ROUNDS;
    const creationOrigin = options.parentTaskId
      ? "cross_repository_child"
      : options.reuseTaskId ? "rerun_from_start" : "user_request";
    const repairRoundSource = options.repairRounds !== undefined
      ? options.parentTaskId ? "parent_task"
        : options.reuseTaskId ? "rerun_snapshot" : "task_request"
      : runtimeRepairRounds !== undefined ? "runtime_setting"
        : deploymentRepairRounds !== undefined ? "deployment"
          : "platform_default";
    // 下单审计记录“输入事实 + 最终采用值 + 来源”，尤其不能只留一个
    // repair_rounds=0 让事后的人猜究竟是用户本单填写、团队设置，还是
    // 跨仓父任务传下来的。需求和执行补充的全文已经在 task.json/定格
    // profile 中，只在公共日志写长度与指纹，避免大段业务内容刷日志。
    const creationAudit = {
      schema: "mae-flow-task-creation-audit/1",
      event: "task_created",
      recorded_at: summary.created_at,
      task_id: id,
      origin: creationOrigin,
      parent_task_id: options.parentTaskId ?? null,
      task_record: "task.json",
      request: {
        title: explicitTitle ?? null,
        account: options.account?.trim() || null,
        requirement: {
          bytes: Buffer.byteLength(requirement, "utf-8"),
          sha256: createHash("sha256").update(requirement).digest("hex"),
          document_name: requirementDocument?.name ?? null,
          bundle_name: requirementDocument?.bundle_name ?? null,
          asset_count: requirementDocument?.assets?.length ?? 0,
        },
        repositories: repositories.map((repository) => ({
          url: repository,
          ticket: repositoryTickets.get(repository) ?? null,
          assignee: repositoryAssignees.get(repository) ?? null,
        })),
        lane: requestedLane ?? null,
        ticket: legacyTicket ?? null,
        baseline: baseline ?? null,
        product_version: options.productVersion ?? null,
        model: options.model ?? null,
        repair_rounds: {
          provided: options.repairRounds !== undefined,
          value: options.repairRounds ?? null,
        },
        requirement_analysis: options.requirementAnalysis === true,
        collaborators: collaborators.length ? collaborators : null,
        task_instructions: taskInstructions ? {
          bytes: Buffer.byteLength(taskInstructions, "utf-8"),
          sha256: createHash("sha256").update(taskInstructions).digest("hex"),
        } : null,
        knowledge_preview_digest: options.knowledgePreviewDigest ?? null,
        selected_business_module_ids:
          options.selectedBusinessModuleIds ?? null,
        selected_repository_skill_ids:
          options.selectedRepositorySkillIds ?? null,
        selected_team_skill_paths: options.selectedHostSkillPaths ?? null,
        workflow_source: options.workflowSource ?? null,
      },
      effective: {
        title: summary.title,
        account: summary.luban_account ?? null,
        repositories: summary.repositories ?? [],
        lane: summary.lane ?? null,
        ticket: summary.ticket ?? null,
        baseline: summary.baseline ?? null,
        model: summary.model_choice ?? this.activeModelChoice() ?? null,
        repair_rounds: {
          value: effectiveRepairRounds,
          source: repairRoundSource,
          disabled: effectiveRepairRounds === 0,
          unlimited: false,
        },
        requirement_graph_stage: summary.requirement_graph?.stage ?? null,
        workflow: workflowProfile ? {
          source: workflowProfile.source,
          revision: workflowProfile.revision,
          diagnostics: workflowProfile.diagnostics.map((item) => item.code),
          warning: workflowProfileWarning ?? null,
        } : { source: { kind: "platform", id: "default" },
          revision: null, diagnostics: [], warning: workflowProfileWarning ?? null },
        repository_profiles: (summary.repository_profiles ?? []).map((profile) => ({
          repository: profile.repository,
          technologies: profile.technologies,
          confirmed: profile.confirmed,
        })),
        repository_skills: (repositorySkills ?? []).map((skill) => ({
          id: skill.id,
          repository: skill.repository,
          revision: skill.revision,
          path: skill.relative_path,
          digest: skill.digest,
        })),
        team_skills: teamSkills.map((skill) => ({
          name: skill.name,
          path: skill.source_path ?? skill.path,
          nature: skill.nature,
          digest: skill.digest,
          package_digest: skill.package_digest,
        })),
        business_modules: businessModules.map((module) => ({
          id: module.id,
          revision: module.revision,
          assets: module.assets.map((asset) => ({
            id: asset.id, version: asset.version, digest: asset.digest,
          })),
        })),
      },
    };
    const task: TaskState = {
      summary,
      tokenUsage: emptyTokenUsageState(),
      humanGate: new HumanGate(join(workspace, "waiting.json")),
      lastPersistedStatus: summary.status,
      controlEpoch: 0,
    };
    this.tasks.set(id, task);
    if (summary.requirement_analysis_confirmation_required) {
      this.openRequirementAnalysisConfirmation(task);
    }
    try {
      this.persist(task);
      recordTaskCreationAudit(task, creationAudit, this.options.log);
    } catch (error) {
      // 任务事实落不了盘就不能留下半个现场:没有 task.json 的工作区
      // 谁也回收不了。这里必须走 removeTaskTree——知识与 Skill 快照
      // 是只读的,裸 rmSync 会 ENOTEMPTY(见该函数头注释),回滚二次
      // 抛错反而把真正的落盘错误盖掉。
      this.tasks.delete(id);
      removeTaskTree(workspace);
      throw error;
    }
    if (summary.parent_task_id) this.syncCrossRepositoryUpdates(task);
    if (summary.requirement_analysis_confirmation_required) {
      this.notifyWaiting(task);
    } else if (!options.deferQueue) {
      this.queue.push(id);
      this.bypass(undefined, "任务泵", this.pump());
    }
    return { ...summary };
  }

  private allocateTaskId(): string {
    this.counter += 1;
    try {
      this.persistTaskSequence();
    } catch (error) {
      this.counter -= 1;
      throw error;
    }
    return `task-${this.counter}`;
  }

  private persistTaskSequence(): void {
    mkdirSync(this.options.dataDir, { recursive: true });
    const path = join(this.options.dataDir, ".task-sequence");
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${this.counter}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private writeTaskState(task: TaskState, strict = false): boolean {
    if (this.tasks.has(task.summary.id) && this.tasks.get(task.summary.id) !== task) return false;
    try {
      const path = join(task.summary.workspace, "task.json");
      writeFileSync(path + ".tmp", JSON.stringify({
        summary: task.summary,
        cwd: task.cwd,
        mission: task.mission,
        assistant_handoff: task.pendingAssistantHandoff,
        pending_main_steers: task.pendingMainSteers,
        pending_decision_knowledge: task.pendingDecisionKnowledge,
        pending_resume_waiting_id: task.pendingResume?.waiting_id,
        applied_developer_intervention_id:
          task.appliedDeveloperInterventionId,
        obsolete_developer_waiting: task.obsoleteDeveloperWaiting,
        token_usage_state: task.tokenUsage,
        notify_record: task.notifyRecord,
      }, null, 1));
      // 状态权威文件耐久写(票 #163):tmp 内容 fsync 后再 rename——
      // 硬断电最坏退回上一版,不再是全零块。代价 3.2ms/次,可忽略。
      {
        const fd = openSync(path + ".tmp", "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      renameSync(path + ".tmp", path);
      return true;
    } catch (error) {
      this.options.log?.(`任务 ${task.summary.id} 落盘失败: ${String(error)}`);
      if (strict) {
        throw new TaskControlError(
          `任务现场未能可靠落盘，已停止本次交还，可直接重试：${String(error)}`,
        );
      }
      return false;
    }
  }

  private recordTaskTokenUsage(
    task: TaskState,
    sample: ModelTokenUsageSample,
  ): void {
    if (this.shuttingDown) return;
    task.tokenUsage = recordTokenUsage(task.tokenUsage, sample);
    // Token 流量不是阶段推进，不能刷新 updated_at / 卡点时钟。
    this.writeTaskState(task);
  }

  /** 子任务的状态变化必须回写主任务。取消表示这部分工作不再需要；
   * 其余范围全部完成后主任务收口，不能把取消项写成已交付。 */
  private reconcileRequirementParent(parent: TaskState, recoverLinks = false): void {
    const graph = parent.summary.requirement_graph;
    if (!this.isRequirementAnalysis(parent) || !graph
        || graph.repositories.length === 0
        || parent.summary.status === "canceled"
        || parent.summary.status === "failed") return;
    // 已交给子任务的历史主单可能被展示投影覆盖，丢掉 stage/task_id。
    // 从真实父子关系恢复，不能要求人重新审批，也不能按同仓/同 AR 猜。
    if (graph.stage !== "confirmed" && (!recoverLinks
        || !["coordinating", "completed"].includes(parent.summary.status))) return;
    const actualChildren = [...this.tasks.values()].filter((child) =>
      child.summary.parent_task_id === parent.summary.id);
    const used = new Set(graph.repositories.map((node) => node.task_id).filter(Boolean));
    let repaired = false;
    for (const node of graph.repositories) {
      // 恢复关联只在重启读完全部任务后进行，不能拿加载到一半的候选集匹配。
      if (!recoverLinks || node.task_id) continue;
      const sameRepository = actualChildren.filter((child) =>
        !used.has(child.summary.id) && child.summary.repo_url === node.url);
      const label = node.scope?.name ?? node.name;
      const candidates = graph.repositories.filter((other) => other.url === node.url).length === 1
        ? sameRepository : sameRepository.filter((child) => {
          // 同仓多单元只认创建时随任务保存的任务书；标题/单号可以改，
          // 不能用它们猜测模块归属。旧材料缺失时保留现场，不误收口。
          try {
            return readFileSync(join(child.summary.workspace, DELIVERY_UNIT_SOURCE), "utf8")
              .split(/\r?\n/, 1)[0] === `# 当前单元任务书：${label}`;
          } catch { return false; }
        });
      if (candidates.length !== 1) continue;
      node.task_id = candidates[0].summary.id;
      used.add(node.task_id);
      repaired = true;
    }
    const children = graph.repositories.map((repository) =>
      repository.task_id ? this.tasks.get(repository.task_id) : undefined);
    if (children.some((child) => !child
        || child.summary.parent_task_id !== parent.summary.id)
        || new Set(children).size !== children.length) {
      if (repaired) this.persist(parent, false, false);
      return;
    }
    if (graph.stage !== "confirmed") {
      graph.stage = "confirmed";
      repaired = true;
    }
    // 不能只看图中幸存的映射而漏掉实际已创建的兄弟任务。
    const states = actualChildren;
    const completed = states.filter((child) =>
      child.summary.status === "completed").length;
    const canceled = states.filter((child) =>
      child.summary.status === "canceled").length;
    const attention = states.filter((child) => [
      "waiting_for_human", "paused", "failed",
    ].includes(child.summary.status)).length;
    const allClosed = completed + canceled === states.length;
    const nextStatus: TaskStatus = allClosed
      ? completed ? "completed" : "canceled" : "coordinating";
    const progress = `${completed}/${states.length} 个子任务已完成`
      + (canceled ? `，${canceled} 个已取消` : "");
    const nextDetail = allClosed
      ? completed ? `${progress}，当前需求已完成` : "全部子任务已取消，主任务随之取消"
      : progress
        + (attention ? `，${attention} 个需要处理` : "，其余正在推进");
    const previousStatus = parent.summary.status;
    if (!repaired && previousStatus === nextStatus && parent.summary.detail === nextDetail) return;
    parent.summary.status = nextStatus;
    parent.summary.detail = nextDetail;
    parent.summary.waiting = undefined;
    this.persist(parent, false, false);
    if (previousStatus !== "completed" && nextStatus === "completed") {
      this.notifyOutcome(parent);
    }
  }

  /** 任务事实落盘(原子写):进程可死,任务不能死。
   * summary+cwd 就是重启后重建 TaskState 需要的全部——待办在
   * waiting.json、事件在 events.jsonl、流程真相在内核状态文件。 */
  private persist(
    task: TaskState,
    strict = false,
    reconcileParent = true,
  ): void {
    if (this.tasks.get(task.summary.id) !== task) return;
    if (!this.isRequirementAnalysis(task) || task.summary.requirement_graph?.stage === "confirmed"
        || ["canceled", "completed", "failed"].includes(task.summary.status)) {
      this.requirementGraphCorrections.delete(task.summary.id);
    }
    if (task.retainedSession && (task.retainedSession.epoch !== task.controlEpoch
        || ["paused", "pausing", "canceled", "completed", "failed", "await_merge"].includes(task.summary.status))) {
      discardRetainedSession(task);
    }
    const now = new Date().toISOString();
    if (task.lastPersistedStatus !== undefined
        && task.lastPersistedStatus !== task.summary.status) {
      task.summary.last_progress_at = now;
    }
    if (task.summary.status === "completed") {
      task.summary.completed_at ??= now;
    } else {
      delete task.summary.completed_at;
    }
    task.summary.updated_at = now;
    task.lastPersistedStatus = task.summary.status;
    this.writeTaskState(task, strict);
    if (!task.summary.delivery?.final_mr) {
      this.deliveryExperiences.start(task);
      this.deliverySummaries.start(task);
    }
    this.considerDeliveryImprovement(task);
    if (isReviewTaskEnded(task.summary.status)) this.reviews.cancelTask(task.summary.id);
    // 文件先落袋(它才是真相),投影旁路跟进;失败由投影自己 fail-open。
    this.bypass(task, "投影 upsert",
      this.options.projection?.upsertTask(this.project(task)));
    this.maybeCaptureDiagnostics(task);
    if (reconcileParent && task.summary.parent_task_id) {
      const parent = this.tasks.get(task.summary.parent_task_id);
      if (parent) this.reconcileRequirementParent(parent);
    }
  }

  /** 任务一进事故态(failed / 交付停摆)就自动落一份诊断包——第一
   * 时间抓现场,人来看时不用再翻七八处。纯旁路:采集失败只记日志,
   * 绝不影响任务;同一事故(状态+原因)只落一份。 */
  private maybeCaptureDiagnostics(task: TaskState): void {
    const stalled = task.summary.delivery?.stalled ?? "";
    const key = task.summary.status === "failed"
      ? `failed:${task.summary.detail ?? ""}`
      : stalled ? `stalled:${stalled}` : "";
    if (!key || task.lastDiagnosticsKey === key) return;
    task.lastDiagnosticsKey = key;
    this.bypass(task, "诊断包采集", writeTaskDiagnostics({
      ...this.diagnosticsInput(task),
      reason: key.startsWith("failed:")
        ? `任务失败:${task.summary.detail ?? ""}`
        : `交付停摆:${stalled}`,
      dedupeKey: key,
    }).then(({ path, skipped }) => {
      if (!skipped) {
        this.options.log?.(`任务 ${task.summary.id} 已自动落诊断包:${path}`);
      }
    }));
  }

  private diagnosticsInput(task: TaskState): DiagnosticsInput {
    const meta = task.container?.metadata;
    return {
      taskId: task.summary.id,
      workspace: task.summary.workspace,
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(this.options.recentLog
        ? { serviceLogTail: this.options.recentLog() } : {}),
      ...(meta ? { container: {
        name: meta.name, containerId: meta.containerId } } : {}),
      dataDir: this.options.dataDir,
    };
  }

  /** 人工导出诊断包(页面按钮/HTTP):现采现回,同时落盘留档。 */
  async exportDiagnostics(
    id: string,
  ): Promise<{ path: string; content: string }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const input = { ...this.diagnosticsInput(task), reason: "人工导出" };
    const content = await collectTaskDiagnostics(input);
    const dir = join(task.summary.workspace, "diagnostics");
    mkdirSync(dir, { recursive: true });
    const path = join(dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-manual.md`);
    writeFileSync(path, content);
    return { path, content };
  }

  /** 服务重启后恢复任务(服务启动时调用一次):
   * - 终态任务(completed/failed/verifying/await_merge)只重建索引;
   * - waiting_for_human 原地挂起,决定到来时走重建会话续跑;
   * - 崩溃时在跑/在排队的任务重新入队,以内核 current 为锚续跑。 */
  recover(): { restored: number; requeued: number } {
    let restored = 0;
    let requeued = 0;
    if (!existsSync(this.options.dataDir)) return { restored, requeued };
    // 按任务号数值排序,不是字典序:task-10 若排在 task-2 前面,重启后
    // 重建的等待队列会悄悄插队(2026-08-29 部署审计实锤)。
    for (const name of readdirSync(this.options.dataDir).sort((a, b) => {
      const [na, nb] = [a, b].map((item) =>
        /^task-\d+$/.test(item) ? Number(item.slice(5)) : Number.NaN);
      return Number.isNaN(na) || Number.isNaN(nb)
        ? a.localeCompare(b) : na - nb;
    })) {
      const workspace = join(this.options.dataDir, name);
      const path = join(workspace, "task.json");
      if (!/^task-\d+$/.test(name) || !existsSync(path)
          || this.tasks.has(name)) {
        continue;
      }
      this.options.log?.(`开始恢复任务 ${name}`);
      const recoveryStarted = performance.now();
      try {
        const saved = JSON.parse(readFileSync(path, "utf-8"));
        const summary = saved.summary as TaskSummary;
        // 旧版遗留的交付方式("快速/慢速"是宿主自造的词,内核不认):
        // 留着它,预答会永远命中不了内核举的卡——续跑的老单看起来就是
        // "更新了还在中途问交付方式"。清掉+留痕,让老单诚实地走真等人。
        const laneChoices = workflowChoices(this.options.host?.kernelRoot)
          .map((item) => item.label);
        if (summary.lane && laneChoices.length
            && !laneChoices.includes(summary.lane)) {
          this.options.log?.(
            `任务 ${summary.id} 的交付方式「${summary.lane}」不在内核选项`
            + `(${laneChoices.join("/")})里——旧版自造的词,已清除;`
            + `流程举卡时将真等人,答卡请选内核选项原文`);
          summary.lane = undefined;
        }
        const savedCwd = typeof saved.cwd === "string" ? saved.cwd : undefined;
        const recoveredCwd = recoverTaskCwd(summary, workspace, savedCwd);
        const task: TaskState = {
          summary,
          tokenUsage: restoreTokenUsageState(saved.token_usage_state),
          humanGate: new HumanGate(join(workspace, "waiting.json")),
          cwd: recoveredCwd,
          resume: true,
          mission: typeof saved.mission === "string"
            ? saved.mission : undefined,
          pendingAssistantHandoff:
            typeof saved.assistant_handoff === "string"
              ? saved.assistant_handoff : undefined,
          pendingMainSteers: Array.isArray(saved.pending_main_steers)
            ? saved.pending_main_steers.map(String).filter(Boolean) : undefined,
          pendingDecisionKnowledge:
            Array.isArray(saved.pending_decision_knowledge)
              ? saved.pending_decision_knowledge.map(String).filter(Boolean)
              : undefined,
          assistantEpoch: 0,
          appliedDeveloperInterventionId:
            typeof saved.applied_developer_intervention_id === "string"
              ? saved.applied_developer_intervention_id : undefined,
          obsoleteDeveloperWaiting:
            saved.obsolete_developer_waiting
              && typeof saved.obsolete_developer_waiting.waitingId === "string"
              && Number.isInteger(saved.obsolete_developer_waiting.stateVersion)
              ? saved.obsolete_developer_waiting : undefined,
          lastPersistedStatus: summary.status,
          // 上一段进程记下的通知发送结果(含"没送到"红旗)要跟着回来,
          // 页面才不会把发送失败演成"通知过了"。
          notifyRecord: saved.notify_record
              && typeof saved.notify_record.waiting_id === "string"
            ? saved.notify_record as NotifyRecord : undefined,
          controlEpoch: 0,
        };
        // 决定已落袋但重建会话尚未启动：只保存权威账的 ID，重启仍带回原话。
        if (typeof saved.pending_resume_waiting_id === "string") {
          const pending = task.humanGate.get(saved.pending_resume_waiting_id);
          if (pending?.status === "resolved") task.pendingResume = pending;
        }
        this.tasks.set(summary.id, task);
        // 准备继续修改可能在 Git/内核初始化之间中断，不能用旧合入记录恢复完成或启动 Agent。
        if (continuationPending(summary)) {
          restored++;
          summary.continuation!.state = "failed";
          summary.continuation!.error = "上次准备被服务重启中断，请点击继续修改重试";
          summary.detail = summary.continuation!.error;
          this.writeTaskState(task);
          this.counter = Math.max(this.counter, Number(summary.id.slice("task-".length)) || 0);
          this.replayProjection(task);
          continue;
        }
        // 旧版把一次交付异常留在 skipped；后续等待合入、完成或明确停摆
        // 已有更新的结论，不再把历史异常当作第二个当前阻塞原因。
        if (summary.delivery?.skipped && (summary.delivery.stalled
            || ["await_merge", "completed"].includes(summary.status))) {
          delete summary.delivery.skipped;
          this.writeTaskState(task);
        }
        if (interruptWarmupReceipt(summary.baseline_build)) this.writeTaskState(task);
        // 本地视觉回归需要同一批排队/运行/验证/待合入样本跨重启保持
        // 原样，否则 recover 会把它们重新入队或继续轮询，浏览器刚打开
        // 场景就消失。双重门禁：环境变量 + 单任务标记缺一不可，正式数据
        // 即使误开环境变量也仍按正常恢复语义执行。
        if (process.env.MAE_FLOW_UI_FIXTURE_MODE === "1"
            && summary.ui_fixture === true) {
          this.counter = Math.max(
            this.counter, Number(name.slice("task-".length)) || 0);
          restored += 1;
          continue;
        }
        if (summary.delivery?.final_mr) {
          // 开发者接手后恢复只读监听。旧工作区的验证、检视和推送都不再续跑。
          this.counter = Math.max(this.counter, Number(name.slice("task-".length)) || 0);
          restored++;
          this.replayProjection(task);
          if (summary.status === "completed") this.finalMrSamples.schedule(task);
          continue;
        }
        if (ticketCorrectionBlocks(summary.ticket_correction)) {
          summary.ticket_correction!.state = "failed";
          summary.ticket_correction!.message = "服务重启中断了纠正，请在任务详情中继续重试";
          summary.status = "paused";
          this.writeTaskState(task);
          this.counter = Math.max(this.counter, Number(name.slice("task-".length)) || 0);
          restored += 1;
          continue;
        }
        this.deliveryExperiences.start(task);
        if (recoverHostPushProjection(summary)) this.writeTaskState(task);
        this.deliverySummaries.start(task, true);
        if (!["completed", "canceled"].includes(summary.status) && validPushReceipt(summary.delivery?.git_push))
          this.recordPublishedPush(task, summary.delivery.git_push);
        if (recoveredCwd !== savedCwd) {
          this.options.log?.(
            `任务 ${summary.id} 已从单号目录恢复代码现场: ${recoveredCwd ?? "未找到唯一候选"}`,
          );
          // 自愈结果立刻回写；否则每次重启都重复猜一次，且下一个进程仍
          // 会读到 cwd=null。这里只补内部索引，不制造流程状态变化。
          if (recoveredCwd) this.writeTaskState(task);
        }
        if (summary.delivery?.scope_violation) {
          delete summary.delivery.scope_violation;
          if (summary.delivery.stalled) {
            summary.delivery.waiting_on = "旧模块目录限制已取消，请继续验证";
            summary.detail = "旧模块目录限制已取消；原改动保留，继续任务后执行正常验证与检视";
          }
          this.persist(task);
        }
        resetQueuedRequirementReviews(this.annotations(task));
        try { this.overallStories.recoverTask(summary.id); }
        catch (error) { this.options.log?.(`整体 Story 恢复失败 ${summary.id}：${String(error)}`); }
        if (summary.requirement_revision?.state === "running") {
          const interruptedIds = new Set(
            summary.requirement_revision.annotation_ids ?? []);
          const store = this.annotations(task);
          for (const item of store.list()) {
            if (interruptedIds.has(item.id) && item.status === "sent") {
              store.reopen(item.id, item.author);
            }
          }
          summary.requirement_revision = {
            ...summary.requirement_revision,
            state: "failed",
            finished_at: new Date().toISOString(),
            error: "服务重启中断了本轮修改，请重新提交这些检视意见",
          };
          summary.detail = "需求文档修改被服务重启中断，请重新提交检视意见";
          this.persist(task);
        }
        // 先迁移内核事实，再让任何恢复队列/对账逻辑观察它。这样旧的
        // await_merge end 不会被当伪终态重跑，真实事故留下的 config
        // 重开现场也不会先启动第二只 Agent。completed/canceled 原样跳过。
        if (this.options.host?.continuousReview && task.cwd) {
          try {
            const migrated = migrateContinuousReviewTask({
              host: this.options.host,
              cwd: task.cwd,
              workspace,
              taskId: summary.id,
              status: summary.status,
              ticket: summary.ticket,
              baseline: summary.baseline ?? summary.delivery?.target_branch,
              sourceBranch: summary.delivery?.source_branch,
              reviewRepair: summary.delivery?.loop?.kind === "review",
            });
            if (migrated.kind === "restored_accident") {
              this.openPersistedReviewFeedback(task);
              summary.detail = "已恢复原任务的持续检视现场，将从当前反馈继续";
              this.writeTaskState(task);
            } else if (migrated.kind === "adopted_watch") {
              this.options.log?.(
                `任务 ${summary.id} 已从旧 end 幂等迁移到 delivery_watch`,
              );
            }
          } catch (error) {
            const diagnosis = error instanceof ContinuousReviewMigrationError
              ? error.message : String(error);
            this.markVerificationStalled(task,
              `持续检视迁移无法安全完成：${diagnosis}`,
              stallClassForError(error, "contract"));
          }
        }
        if (!["completed", "canceled"].includes(summary.status)
            && this.continuousReviewTask(task)) {
          const completed = this.taskCompletionAttestation(task);
          if (completed?.complete) {
            const closeEvent = this.latestKernelCloseEvent(task);
            const unpushedCommits = Array.isArray(closeEvent?.unpushed_local_commits)
              ? closeEvent.unpushed_local_commits.length : 0;
            const unpushedPaths = Array.isArray(closeEvent?.unpushed_local_paths)
              ? closeEvent.unpushed_local_paths.length : 0;
            if (summary.delivery?.loop) summary.delivery.loop.state = "merged";
            if (summary.delivery) {
              summary.delivery.mr_state = "已合入";
              summary.delivery.merged_sha = String(closeEvent?.sha ?? "");
              summary.delivery.stalled = undefined;
              summary.delivery.stall_class = undefined;
              summary.delivery.waiting_on = undefined;
            }
            summary.status = "completed";
            summary.detail = unpushedCommits || unpushedPaths
              ? `服务重启后已从可信 close 恢复完成；合入时另有 ${unpushedCommits}`
                + ` 个未推送提交、${unpushedPaths} 个未提交路径，均已留痕`
              : "服务重启后已从可信 MR 合入 close 恢复完成";
            this.persist(task);
            const account = summary.luban_account;
            if (this.options.notifier && account) {
              this.bypass(task, "恢复收口通知", this.options.notifier.notifyOutcome({
                taskId: summary.id,
                account,
                status: "merged",
                summary: `MR 已合入${summary.delivery?.mr_url
                  ? `:${summary.delivery.mr_url}` : ""}`,
                link: personalTaskLink(
                  this.notificationLinkBase(), account, summary.id),
              }));
            }
          }
        }
        this.reconcileResolvedDecisionAnnotations(task);
        this.annotations(task).resetUnsentAssignments(this.annotations(task).list());
        let authoritativeWaiting = summary.waiting
          ? task.humanGate.get(summary.waiting.waiting_id) : undefined;
        if (summary.status === "waiting_for_human"
            && retireKernelReviewRequest(task.humanGate, authoritativeWaiting)) {
          summary.waiting = undefined;
          summary.status = "queued";
          task.resume = true;
          authoritativeWaiting = undefined;
          this.persist(task);
        }
        if (this.recoverMisroutedRequirementAnalysisWaiting(
          task, authoritativeWaiting)) {
          authoritativeWaiting = undefined;
        }
        // 升级前已经停在最终方案确认卡的任务没有 review_snapshot。
        // 这里以恢复时磁盘上的完整产物做一次迁移封版，避免继续拿运行中
        // 被页面轮询碰巧读到的中间哈希当成正式版本。
        const sealedRecoveredRequirementGraph =
          summary.status === "waiting_for_human"
          && authoritativeWaiting?.status === "waiting"
          && this.sealRequirementGraphReview(task, authoritativeWaiting);
        // 修复旧版本已经落盘的矛盾投影：waiting.json 明确仍在等当前
        // 问题，task.json 的 detail 却可能还写着“服务重启,等待续跑”。
        // 重启时就以人工待办权威账重建展示文案，不要求用户再触发一次
        // 状态变化；这也是升级后让在途任务立即自愈的入口。
        if (summary.status === "waiting_for_human"
            && authoritativeWaiting?.status === "waiting") {
          const detail = waitingTaskDetail(authoritativeWaiting);
          if (summary.detail !== detail) {
            summary.detail = detail;
            this.persist(task);
          } else if (sealedRecoveredRequirementGraph) {
            // 不触发一整轮状态迁移，只把新补的送审快照原子落袋。
            this.writeTaskState(task);
          }
        }
        // 旧版本把 repairing 一直保留到流水线最终绿灯。若修复使命已经
        // 消费完，真实当前动作其实是 prepush/流水线验证；恢复时同步
        // 校正，不能让重新部署后的老任务继续同时显示两种当前阶段。
        if (enterRepairVerification(task)) this.persist(task);
        const assistantSnapshot = readDeveloperAssistant(workspace);
        if (assistantSnapshot.handoff?.id
            && assistantSnapshot.handoff.state !== "returned"
            && task.appliedDeveloperInterventionId
              === assistantSnapshot.handoff.id) {
          const obsolete = task.obsoleteDeveloperWaiting;
          if (obsolete) {
            this.supersedeWaitingForUserIntervention(task, {
              waiting_id: obsolete.waitingId,
              state_version: obsolete.stateVersion,
            });
          }
          this.markPreparedDeveloperAssistantReturned(task);
        }
        this.counter = Math.max(
          this.counter, Number(name.slice("task-".length)) || 0);
        restored += 1;
        let terminalMismatch = false;
        // 现场回收过的单:内核状态原件已经删了,再对账一次必然"读不到证据"
        // → 老单被翻成验证中,tryDeliver 甚至会把早已合入的分支重新推回去。
        // 这正是"老单不被新尺子重新量"那条教训的同一个坑,只是这回尺子
        // 是我们自己弄丢的。回收 = 台账封存,不再重新裁决。
        if (["completed", "await_merge"].includes(summary.status)
            && !summary.workspace_reclaimed_at
            && !this.settledBeforeContract(task)) {
          const attestation = summary.status === "await_merge"
            ? this.deliveryReadyAttestation(task)
            : this.taskCompletionAttestation(task);
          if (attestation && !attestation.complete) {
            terminalMismatch = true;
            delete summary.completed_at;
            if (attestation.kind === "external_verify"
                || (attestation.terminal && attestation.external_required)) {
              // 进程可能死在“平台已回结果→内核登记→状态投影”之间。
              // 恢复只重做对账/核销，不拿旧 task.json 直接放行。
              summary.status = "verifying";
              summary.detail = `恢复对账：${attestation.reason}`;
              summary.delivery = {
                ...summary.delivery,
                mr_state: "验证中",
                waiting_on: attestation.reason,
              };
            } else {
              summary.status = "queued";
              summary.detail = `恢复对账发现伪终态：${attestation.reason}，`
                + "将从内核 current 继续";
              task.resume = true;
            }
            this.persist(task);
          }
        }
        this.replayProjection(task);
        // 进程退出时可能只来得及留下 running，内核已明确交给宿主。
        // 不再派一轮只会 current/done 的 Agent；未答卡、暂停和待执行的
        // 宿主请求仍各走原入口，不能被这次恢复抢走。
        if (["running", "queued"].includes(summary.status) && !task.mission && this.atExternalVerificationWait(task)
            && authoritativeWaiting?.status !== "waiting" && !new TaskHostLedger(summary).pending()) {
          summary.status = "verifying"; summary.detail = "Agent 已结束，宿主正在接续交付与流水线验证";
          task.mission = undefined; this.persist(task);
        }
        // annotations.jsonl 是工作台人工裁决的权威账。部署前若批注已被
        // 撤回/确认、进程却死在 FeedbackStore 核销前，不能在重启后把
        // 已关闭意见重新显示成进行中；反过来，Agent 仅回复 fixed 仍须
        // 等提出人确认，绝不能趁恢复自动关闭。
        try {
          this.syncFeedbackStoreFromKernel(task, true);
          this.reconcileWorkspaceFeedbackAuthority(task);
        } catch (error) {
          const detail = `持续检视索引损坏或不可写，已停止自动闭环，不能静默隐藏反馈：${
            String(error).slice(0, 800)}`;
          this.options.log?.(`任务 ${summary.id} ${detail}`);
          if (!["completed", "canceled"].includes(summary.status)) {
            this.markVerificationStalled(task, detail, "infrastructure");
          }
        }
        const reviewOutboxStalled = this.reviewReplyOutboxStalled(task);
        if (!["completed", "canceled"].includes(summary.status)
            && summary.status !== "await_merge"
            && !reviewOutboxStalled
            && summary.delivery?.git_push?.sha) {
          this.bypass(task, "检视回复 outbox 恢复",
            this.flushReviewReplyOutbox(task));
        }
        // 服务在“正在暂停”窗口退出时，所有执行资源已经随进程消失；
        // 恢复为 paused 比擅自续跑更符合用户最后一次明确指令。
        if (summary.status === "pausing") {
          summary.status = "paused";
          summary.detail = "服务重启时已完成暂停";
          summary.control = {
            ...(summary.control ?? {
              last_action: "pause",
              actor: "系统",
              at: new Date().toISOString(),
            }),
            last_action: "pause",
            paused_from: summary.control?.paused_from ?? "running",
          };
          this.persist(task);
        }
        if (summary.status === "paused"
            && readDeveloperAssistant(workspace).state === "acquiring") {
          this.activatePendingDeveloperAssistant(task);
        }
        if (this.recoverFailedEarlyPipeline(task)) { requeued += 1; continue; }
        const prepushRecovery = this.reconcileInterruptedPrePush(task);
        if (prepushRecovery !== "none") {
          if (prepushRecovery === "scheduled") requeued += 1;
          // prepush 是独立交付会话；已经接管或明确停机后，不得再掉进
          // 通用 verifying/任务队列分支启动第二条恢复链。
          continue;
        }
        // 尚无 MR 时先继续交付，不能拿旧 not_found 空查裸分支。
        if (summary.status === "verifying" && !summary.delivery?.stalled
            && this.needsDeliveryBeforePipeline(task)) {
          this.bypass(task, "恢复交付", this.tryDeliver(task, task.controlEpoch));
          continue;
        }
        if (this.recoverEarlyPipeline(task)) { requeued += 1; continue; }
        if (summary.status === "verifying"
            && !summary.delivery?.stalled
            && summary.delivery?.pipeline !== "success"
            && this.dispatchPromotedFeedback(task)) {
          requeued += 1;
          continue;
        }
        // 进程可死,轮询不死:重启前在等流水线的任务续轮
        // (锚是 delivery.sha,结果仍只认绑定版本)。
        if (summary.status === "verifying" && reviewOutboxStalled) {
          // delivery-outbox.jsonl 是可由管理员原地修复的持久化账本。
          // 修复后须在本进程续接 tryDeliver，不能只清掉 stalled 后等
          // 第二次重启才继续交付。
          this.scheduleDeliveryRecovery(task, task.controlEpoch);
        } else if (summary.status === "verifying"
            && summary.delivery?.evidence_gap
            && summary.delivery.sha) {
          // 红灯证据缺口是交付侧等待，不是内核编码会话停机。进程重启后
          // 继续从同一 SHA 取证/分诊；不能走 tryDeliver 重做 prepush，
          // 更不能把主 Agent 从 current 重新拉起来猜改。
          const gap = summary.delivery.evidence_gap;
          const max = this.repairBudget(task);
          this.bypass(task, "流水线失败证据恢复",
            this.dispatchCiRepair(task, summary.delivery.sha,
              gap.failure_log ?? "", max, task.controlEpoch));
        } else if (summary.status === "verifying" && !summary.delivery?.stalled
            && (summary.delivery?.pipeline?.startsWith("running") || summary.delivery?.pipeline === "not_found"
              || summary.delivery?.pipeline === "查询失败，正在重试")) {
          // 已有 MR 且远端尚未给终态，续查同 SHA；不要重建 MR 或重触发。
          // running 可能带注记，仍属运行中；查不到有效 run 则受原验证期限约束。
          this.bypass(task, "流水线轮询",
            this.pollPipeline(task, task.controlEpoch));
        } else if (summary.status === "verifying"
            && summary.delivery?.pipeline === "success"
            && summary.delivery.sha) {
          // 平台已绿但内核还没 PASS（进程可能死在登记窗口，或当时逐项
          // 结果不完整）：重启只重做核销，不重复触发同 SHA 流水线。
          this.bypass(task, "流水线证据核销",
            this.pipelineVerdict(task, summary.delivery.sha, "success", "", summary.delivery.checks, task.controlEpoch));
        } else if (summary.status === "verifying"
            && !summary.delivery?.stalled) {
          // 没有可续轮的旧平台状态也不能静默蹲住；让 tryDeliver 查远端
          // 分支并触发/恢复权威验证，仍由内核裁决是否能到 end。
          // 这一支原来只认 terminalMismatch(落盘是 completed/await_merge
          // 的伪终态),于是"落盘就是 verifying、连平台状态都没有"的那类
          // ——推送失败停在等待点的——重启后一行代码都不碰它,永远蹲着
          // (实测)。已经如实停摆的不动:那是在等人,不是在等机器。
          this.bypass(task, "验证恢复对账",
            this.tryDeliver(task, task.controlEpoch));
        }
        // task.json 仍在等人而权威账已 resolved/superseded：前者带决定
        // 续跑，后者仅恢复宿主 MR 描述卡；普通 Agent 旧卡不得复活。
        if (summary.status === "waiting_for_human" &&
            authoritativeWaiting?.status === "superseded"
            && authoritativeWaiting.step === MR_DESCRIPTION_STEP) {
          // 保留旧卡审计，回到原交付入口按同一 AR 单另举新卡。
          this.continueAfterMrDescription(task, "原 MR 描述卡已失效，正在重新发起填写");
          requeued += 1;
        } else if (summary.status === "waiting_for_human"
            && authoritativeWaiting?.status === "resolved") {
          // task.json 只是页面投影副本，真正的决定在 waiting.json。
          // 旧代码检查 summary.waiting.status，恰好检查了崩溃前的 stale
          // 副本，注释写着“以 waiting.json 为准”却从未读它。
          this.bypass(task, "已决待办恢复对账",
            this.resumeResolvedDecision(task, authoritativeWaiting));
          requeued += 1;
        } else if (summary.status === "running" || summary.status === "queued") {
          summary.status = "queued";
          summary.detail = this.options.requirementDisabled
            ? "问题流专用部署(--issue-only),需求流程未加载;"
              + "用完整部署重启后自动续跑"
            : (terminalMismatch ? summary.detail : "服务重启,等待续跑");
          this.persist(task);
          this.queue.push(summary.id);
          requeued += 1;
        }
      } catch (error) {
        this.options.log?.(`恢复 ${name} 失败: ${String(error)}`);
      } finally {
        this.options.log?.(`[task-recovery] ${JSON.stringify({ id: name, elapsed_ms: Math.round(performance.now() - recoveryStarted) })}`);
      }
    }
    // 全部任务加载后先恢复父子关联，再发布 Story/补任务书；不受加载顺序影响。
    for (const task of this.tasks.values()) {
      if (this.isRequirementAnalysis(task)) this.reconcileRequirementParent(task, true);
    }
    // 确认建单后发布 Story 的进程中断可恢复；先加载全部子任务再同步。
    for (const task of this.tasks.values()) {
      if (task.summary.requirement_graph?.stage !== "confirmed") continue;
      try { this.adoptRequirementStory(task); }
      catch (error) { this.options.log?.(`全局 Story 发布恢复失败 ${task.summary.id}: ${error}`); }
    }
    // 等全部任务都加载完再补子任务材料：父任务可能排在子任务之后，
    // 单任务恢复循环里还不一定找得到它。补齐发生在任务泵启动前，当前
    // 已经生成的在途子任务升级后也会先拿到自己的任务书再恢复 Agent。
    for (const task of this.tasks.values()) {
      if (!task.summary.parent_task_id) continue;
      try {
        this.ensureDeliveryUnitMaterials(task);
      } catch (error) {
        this.options.log?.(
          `任务 ${task.summary.id} 补齐交付单元材料失败，将保留原现场: ${String(error)}`);
      }
    }
    // 全部任务恢复后补齐历史广播，避免加载顺序影响接收范围。
    for (const parentId of new Set([...this.tasks.values()]
      .map((task) => task.summary.parent_task_id).filter(Boolean))) {
      const parent = this.tasks.get(parentId!);
      if (parent) this.syncCrossRepositoryUpdates(parent);
    }
    if (this.counter > 0) {
      try {
        this.persistTaskSequence();
      } catch (error) {
        this.options.log?.(`任务编号水位落盘失败: ${String(error)}`);
      }
    }
    // 独立于恢复分支；修复排队、prepush 恢复的 continue 也不能漏掉 MR。
    for (const task of this.tasks.values()) {
      this.ensureMergeWatch(task);
      if (!task.summary.delivery?.final_mr && needsRemoteRecovery(task.summary, task.cwd, task.mission)) {
        if (["running", "queued", "failed"].includes(task.summary.status)) { task.summary.status = "verifying"; this.persist(task); }
        this.bypass(task, "恢复推送确认前核验远端", this.refreshRemoteDelivery(task.summary.id, task.summary.luban_account));
      }
    }
    if (requeued) this.bypass(undefined, "任务泵", this.pump());
    return { restored, requeued };
  }

  /** 现场保留期(天):管理页运行时设置 > 部署值 > 默认 14 天。
   * 0 = 永不回收(诚实的"关掉",不是偷偷不干活)。 */
  workspaceRetentionDays(): number {
    const runtime = this.options.settings?.runtime().workspace_retention_days;
    const value = runtime ?? this.options.workspaceRetentionDays
      ?? DEFAULT_WORKSPACE_RETENTION_DAYS;
    return Number.isFinite(value) && value >= 0
      ? value : DEFAULT_WORKSPACE_RETENTION_DAYS;
  }

  buildCacheRetentionDays(): number {
    const runtime = this.options.settings?.runtime().build_cache_retention_days;
    const value = runtime ?? this.options.buildCacheRetentionDays
      ?? DEFAULT_BUILD_CACHE_RETENTION_DAYS;
    return Number.isFinite(value) && value >= 0
      ? value : DEFAULT_BUILD_CACHE_RETENTION_DAYS;
  }

  buildCacheMaxGb(): number {
    const runtime = this.options.settings?.runtime().build_cache_max_gb;
    const value = runtime ?? this.options.buildCacheMaxGb
      ?? DEFAULT_BUILD_CACHE_MAX_GB;
    return Number.isFinite(value) && value >= 0
      ? value : DEFAULT_BUILD_CACHE_MAX_GB;
  }

  /**
   * 真正占用缓存的容器 + 仍可能继续执行的任务共同构成租约。
   * 后者覆盖服务刚恢复、任务已入队但容器尚未创建的窄竞态。
   */
  private activeBuildCacheKeys(): Set<string> {
    const keys = new Set<string>();
    for (const context of this.activeContainerContexts.values()) {
      context.cacheKeys.forEach((key) => keys.add(key));
    }
    if (!this.options.isolation?.cacheRoot) return keys;
    for (const task of this.tasks.values()) {
      if (HARD_DELETE_STATUSES.includes(task.summary.status)) continue;
      const repository = task.summary.repo_url
        ?? this.effectiveDefaultRepo()
        ?? task.cwd
        ?? task.summary.id;
      keys.add(buildCacheKey(repository));
    }
    return keys;
  }

  async buildCacheStatus(): Promise<BuildCacheStatus> {
    return inspectBuildCaches({
      cacheRoot: this.options.isolation?.cacheRoot,
      activeKeys: this.activeBuildCacheKeys(),
      retentionDays: this.buildCacheRetentionDays(),
      maxBytes: this.buildCacheMaxGb() * 1024 ** 3,
    });
  }

  async reclaimIdleBuildCaches(options: {
    allUnused?: boolean;
    now?: number;
  } = {}): Promise<BuildCacheReclaimResult> {
    if (this.buildCacheReclaimActive) {
      throw new TaskControlError("构建缓存正在清理，请稍后重试");
    }
    this.buildCacheReclaimActive = true;
    try {
      const result = await reclaimBuildCaches({
        cacheRoot: this.options.isolation?.cacheRoot,
        activeKeys: () => this.activeBuildCacheKeys(),
        retentionDays: this.buildCacheRetentionDays(),
        maxBytes: this.buildCacheMaxGb() * 1024 ** 3,
        allUnused: options.allUnused,
        now: options.now,
      });
      if (result.reclaimed || result.failed.length || result.skipped_active) {
        this.options.log?.(`[build-cache] 回收 ${result.reclaimed} 个分区，释放 `
          + `${humanBytes(result.freed_bytes)}`
          + `${result.skipped_active ? `，跳过占用中 ${result.skipped_active} 个` : ""}`
          + `${result.failed.length ? `，失败 ${result.failed.length} 个` : ""}`);
      }
      return result;
    } finally {
      this.buildCacheReclaimActive = false;
    }
  }

  /**
   * 扫一遍终态任务,回收过了保留期的现场(纯旁路,fail-open)。
   *
   * 由 serve 定时驱动,不在这里起 setInterval——TaskService 一直没有自己的
   * 定时器,加一个就多一个重启后忘了清的句柄。
   *
   * 只删克隆等能再生的重货,台账原样留下(见 workspaceReclaim.ts)。
   * 回收后把 workspace_reclaimed_at 记进 task.json:页面据此如实说
   * "现场已回收",恢复时据此**不再重新裁决**这单。
   */
  reclaimIdleWorkspaces(now = Date.now()): {
    reclaimed: number; freed: number;
  } {
    const retentionDays = this.workspaceRetentionDays();
    let reclaimed = 0;
    let freed = 0;
    for (const task of this.tasks.values()) {
      const summary = task.summary;
      if (continuationPending(summary) || this.historyMutationActive.has(summary.id)) continue;
      const verdict = judgeReclaim({
        id: summary.id,
        status: summary.status,
        workspace: summary.workspace,
        completed_at: summary.completed_at,
        updated_at: summary.updated_at,
        created_at: summary.created_at,
        workspace_reclaimed_at: summary.workspace_reclaimed_at,
      }, {
        now,
        retentionDays,
        // 状态是收口那一刻写的,清理和收尾可能正擦肩而过:句柄还在就不碰。
        busy: !!task.driver || !!task.container || !!task.containerReopen || !!task.finalMrAnalysis?.running || this.deliverySummaries.isRunning(summary.id) || this.deliveryImprovements.isRunning(summary.id),
      });
      if (!verdict.reclaim) continue;
      try {
        const result = reclaimWorkspace(summary.workspace, {
          cwd: task.cwd,
          // 现场路径是任务创建时写死的绝对路径,现场目录被拷走/搬走之后
          // 它会指向别处——删除动作必须自己验边界,不能信这个字段。
          dataDir: this.options.dataDir,
        });
        if (result.refused) {
          this.options.log?.(`回收现场 ${summary.id} 被边界拦下: ${result.refused}`);
          continue;
        }
        summary.workspace_reclaimed_at = new Date(now).toISOString();
        this.persist(task);
        reclaimed += 1;
        freed += result.freed;
        this.options.log?.(
          `回收现场 ${summary.id}(${verdict.reason}):释放 `
          + `${humanBytes(result.freed)},删除 ${result.removed.join("、") || "无"}`
          + `;台账与证据保留${result.snapshotted ? ",内核阶段已留档" : ""}`);
      } catch (error) {
        // 回收是旁路:删不动就是磁盘没省下来,绝不许它影响任务读写。
        this.options.log?.(`回收现场 ${summary.id} 失败: ${String(error)}`);
      }
    }
    return { reclaimed, freed };
  }

  /** 恢复重放投影(§11):以现场文件为源补齐读侧——摘要整行覆盖,
   * 事件副本重灌((taskId,eventId) 幂等锚把重复兜成 no-op)。
   * 现场文件损坏只影响投影补齐,不影响任务恢复本身。 */
  private replayProjection(task: TaskState): void {
    const projection = this.options.projection;
    if (!projection) return;
    this.bypass(task, "投影 upsert",
      projection.upsertTask(this.project(task)));
    this.bypass(task, "投影事件恢复", projection.replayEvents?.(
      task.summary.id, join(task.summary.workspace, "events.jsonl")));
  }

  /** 重跑一单:completed/failed 的任务重新入队,host 模式以内核
   * current 为锚续跑。用于环境修复后续推(run7-resume 实测:容器
   * 被并行实例误杀,整单被迫收口,内核还停在 verify_ut——环境
   * 修好后流程应当接着推,而不是从头再来)。
   *
   * verifying 的准入按事实收窄:只有修复环停机(halted/exhausted)
   * 或轮询预算耗尽的才许重跑——在途轮询/修复中点重跑只会重复烧
   * 流水线。停机重跑=人工背书"外部的事我办完了/值得再试":清掉
   * 停机账本,同 SHA 也给全新的修复机会(halted 的 last_sha 刹车
   * 挡的是"机器无人看管地空转",不该挡人工明确授权的再来一次)。 */
  /** 用户显式跳过推送前验证(仅失败停机后可用)。本地验证是省流水线
   * 的前闸,不是权威——权威裁决在绑 SHA 流水线,所以这是"fail-closed
   * 停下后由人接手"的合法出路,不是自动降级。跳过绑当下 HEAD:之后
   * 出现新提交,跳过即失效,重新走真验证(旧拍板不背书新代码)。 */
  async skipPrePushVerification(
    id: string,
    actor?: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    if (task.prepushActive) {
      throw new TaskControlError("Build-Fix 正在进行中，不能跳过");
    }
    const prepush = task.summary.delivery?.prepush;
    if (!prepush
        || !["blocked", "environment_error"].includes(prepush.state)) {
      throw new TaskControlError(
        "只有 Build-Fix 失败停机后才能跳过；当前没有可跳过的失败验证");
    }
    if (!task.cwd) {
      throw new TaskControlError("代码现场不可用,无法绑定跳过时刻的 HEAD");
    }
    const revision = await this.prePushRevision(task);
    this.setPrePushState(task, {
      ...prepush,
      state: "user_skipped",
      // 恒填(无鉴权部署记"用户")，并用 reason 区分“失败后放行”和
      // “清单调整后不重编”。只有前者需要给 MR 加风险标记。
      skipped_by: actor ?? "用户",
      skip_reason: "failed_build_fix",
      sha: revision.sha,
      workspace_fingerprint: revision.workspace_fingerprint,
      message: `${actor ?? "用户"}选择跳过本地验证,`
        + "编译与 UT 交由权威流水线裁决",
      updated_at: new Date().toISOString(),
    });
    this.persist(task);
    // 复用「重跑续推」的恢复链路续接交付;交付环走到 preparePush 时
    // 命中同 HEAD 的跳过放行,不再起验证 Agent。
    return this.retry(id, actor);
  }

  /** 用户显式重跑推送前编译。实锤场景(2026-08-27 内网):部署重启杀掉
   * 在途编译轮后,任务停在 verifying、prepush 停在 preparing,而
   * 「重跑续推」按 verifying 在途拒绝——人对着僵尸现场没有任何出路。
   * 这个口子同时是活性探针:真在跑时 prepushActive 挡住并明说
   * "正在进行",人立刻知道不是卡死。只动 prepush,不重排内核会话。 */
  async retryPrePush(id: string, actor?: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    if (task.prepushActive) {
      throw new TaskControlError(
        "Build-Fix 正在进行中（本进程内有在途轮），不是卡死；"
        + "等本轮收口或失败停机后再重跑");
    }
    if (task.driver || task.container) {
      throw new TaskControlError(
        "任务的执行资源尚未释放（会话或容器仍在），不能重跑 Build-Fix");
    }
    const prepush = task.summary.delivery?.prepush;
    if (!prepush) {
      throw new TaskControlError("该任务还没有 Build-Fix 现场，无可重跑");
    }
    if (prepush.state === "passed") {
      throw new TaskControlError(
        "Build-Fix 已通过，收据仍绑定当前 HEAD，无需重跑");
    }
    if (!task.cwd) {
      throw new TaskControlError("代码现场不可用，无法重跑 Build-Fix");
    }
    if (!["verifying", "failed"].includes(task.summary.status)) {
      throw new TaskControlError(
        `任务状态是 ${task.summary.status},只有 verifying/failed 的任务`
        + "能重跑 Build-Fix");
    }
    const epoch = task.controlEpoch;
    task.summary.status = "verifying";
    task.summary.detail = actor
      ? `人工重跑 Build-Fix(${actor})` : "人工重跑 Build-Fix";
    this.markBuildFixResuming(task);
    this.persist(task);
    // 交付链自己会收口僵尸 attempt(restore 的 recovered 转移)并起新轮;
    // 这里只负责把链路重新踢活。
    this.bypass(task, "Build-Fix 人工重跑",
      this.resumePrePushVerification(task, epoch));
    return this.project(task);
  }

  /** 用户主动停止在途的推送前编译并直推流水线(2026-08-27 用户拍板:
   * "把停止变为停止并直推流水线")。语义是两步一次点完:先中止本轮
   * (在跑的走 prepushAbort;还在排编译槽位队的直接出队——这条路不
   * 经过 runner 收口,得在这里如实补账,否则留下 preparing 僵尸),
   * 收口成失败停机后立刻走跳过链路(绑当下 HEAD 的 user_skipped,
   * 编译与 UT 交由权威流水线裁决,任务自动续跑)。不是静默放行:
   * 停机账、跳过拍板都如实落在现场里。两个例外:本轮在停止瞬间已经
   * 通过的,按通过继续推,不冤枉它;暂停中的任务只停不推——暂停是
   * 用户更早的明确指令,不许被顺手续跑。 */
  async stopPrePush(id: string, actor?: string, pushAfterStop = true): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    const active = task.prepushActive;
    if (!active) {
      throw new TaskControlError(
        "当前没有在途的 Build-Fix；失败停机后请用重跑或跳过");
    }
    // 中止要反复补刀直到本轮真正收口:prepushAbort 在拿到编译槽位后
    // 才创建、排队 waiter 也是晚注册的,单发 abort 会打空(竞态)。
    // 这个等待有出路——attempt 预算兜底,绝不会无限等。
    await settleVerificationStop(active, () => { this.removePrePushBuildWaiter(task); task.prepushAbort?.abort(); });
    const prepush = task.summary.delivery?.prepush;
    if (prepush && !["passed", "blocked", "environment_error", "user_skipped"]
      .includes(prepush.state)) {
      // 排队被打断的路径没有 runner 报告,补一笔如实的停机账。
      this.setPrePushState(task, {
        ...prepush,
        state: "environment_error",
        active_attempt: undefined,
        message: `${actor ?? "用户"}停止了本轮 Build-Fix${pushAfterStop ? "，直推流水线裁决" : "，按新要求继续"}`,
        updated_at: new Date().toISOString(),
      });
    }
    if (!pushAfterStop) {
      task.summary.detail = "本轮验证已停止，未自动跳过验证或推送";
      this.persist(task);
      return this.project(task);
    }
    // 停止瞬间恰好收口通过的:交付链已按收据继续推,别再动它。
    const closedState = task.summary.delivery?.prepush?.state;
    if (closedState === "passed") {
      this.persist(task);
      return this.project(task);
    }
    if (["paused", "pausing", "canceled"].includes(task.summary.status)) {
      // 暂停/取消是用户更早的明确指令,只停编译,不顺手续跑去推。
      task.summary.detail = "Build-Fix 已由用户停止";
      this.persist(task);
      return this.project(task);
    }
    task.summary.status = "failed";
    task.summary.detail = "Build-Fix 已由用户停止，转直推流水线";
    this.persist(task);
    // 停止并直推:失败停机后立刻走既有跳过链路(绑 HEAD 的
    // user_skipped + retry 续跑),语义与人分两步点完全一致。
    return this.skipPrePushVerification(id, actor);
  }

  retry(id: string, actor?: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    const { status, delivery } = task.summary;
    // stalled = 外部验证的自愈预算已经烧完并如实停下(推送一直失败、
    // 流水线迟迟不给可核销结果……)。它必须和修复环停机同等对待:
    // 那种状态下没有任何东西在收敛,再拦着人重跑就是把任务锁死。
    const evidenceStopped = delivery?.evidence_gap?.state === "waiting_human";
    const repairStopped = deliveryStopped(delivery) || evidenceStopped;
    if (status === "verifying" && !repairStopped) {
      throw new NotFoundError(
        `任务 ${id} 流水线验证还在进行中,重跑会重复烧流水线;` +
        `等它收敛或停机后再说`);
    }
    if (continuationPending(task.summary)) throw new TaskControlError("请使用继续修改入口重试准备，不能按旧流程重跑");
    if (!["completed", "failed", "verifying"].includes(status)) {
      throw new NotFoundError(
        `任务 ${id} 状态是 ${status},只有 completed/failed/停机的 verifying 可重跑`);
    }
    if (task.container || task.driver) {
      throw new TaskControlError(
        `任务 ${id} 上一次执行资源尚未确认释放，拒绝重跑；`
        + "请先取消重试或重启服务触发 ownership 清扫",
      );
    }
    // 常规“重跑续推”只续接交付，不因旧 Build-Fix 失败强制再烧一轮。
    // 原结果保留；真正重跑独立验证仍由 retryPrePush / retry_verification 发起。
    const failedPrePush = delivery?.prepush;
    if (status === "failed" && failedPrePush
        && ["blocked", "environment_error"].includes(failedPrePush.state)
        && task.cwd) {
      task.summary.status = "verifying";
      task.summary.detail = "继续交付；独立 Build-Fix 结果保留，不自动重跑";
      this.markBuildFixResuming(task);
      this.persist(task);
      this.bypass(task, "交付重试", this.tryDeliver(task, task.controlEpoch));
      return { ...task.summary };
    }
    if (status === "verifying" && evidenceStopped && delivery?.evidence_gap) {
      // 人点“重试”只重新打开平台取证预算；它不是授权主 Agent 在没有
      // 报错时重跑编码，也不应凭空消耗 CI 修复轮次。
      const gap = delivery.evidence_gap;
      gap.state = "retrying";
      gap.attempts = 0;
      gap.retry_deadline = new Date(
        Date.now() + this.repairEvidenceBudgetMs()).toISOString();
      gap.notified_at = undefined;
      delivery.pipeline = "failed(人工要求重新取证)";
      delivery.waiting_on = "正在重新拉取流水线具体报错，尚未派 Agent";
      task.summary.detail = delivery.waiting_on;
      this.persist(task);
      const max = this.repairBudget(task);
      this.bypass(task, "人工重试流水线失败证据",
        this.dispatchCiRepair(task, gap.sha, gap.failure_log ?? "",
          max, task.controlEpoch));
      return { ...task.summary };
    }
    // 检视轮因缺逐条回执停机时,generic retry 曾把 loop 连同批注 id、
    // review_source 一起清空——批注停在 sent、恢复意图全丢,唯一出路
    // 变成删批注(e2e-picky-20260830 双复现,MFC-003)。这里改成保留
    // 检视账,派一条"只补回执"的窄使命,不清 loop、不烧无关修复。
    if (status === "verifying") {
      const loop = task.summary.delivery?.loop;
      const pendingReview = loop?.kind === "review"
        && loop.review_source === "workspace"
        ? unansweredAnnotations(this.annotations(task).list(),
            loop.workspace_review_annotation_ids ?? [])
        : [];
      if (loop && pendingReview.length) {
        loop.state = "repairing";
        loop.diagnosis = undefined;
        // 人明确点了重跑，这是一次新的恢复尝试；新会话仍应先自己补救
        // 一次格式/落盘疏漏，不能因为上一会话用过自动预算就立即停机。
        loop.workspace_review_receipt_retry_for = undefined;
        task.summary.delivery!.stalled = undefined;
        task.summary.delivery!.stall_class = undefined;
        task.summary.delivery!.waiting_on = undefined;
        task.summary.delivery!.verify_deadline = undefined;
        task.summary.delivery!.pipeline = "人工重跑,补齐检视回执";
        this.enqueueRepair(task, [
          "上一轮检视修改已经完成,但缺少机器可核对的逐条回执,系统据此停下。",
          "本次使命只有一件事:复核当前 HEAD 上这些意见的落实情况并补写回执;",
          "不要重新修改代码,除非复核发现某条意见确实没有落实。",
          this.reviewReceiptInstructionsFor(task, pendingReview),
        ].join("\n"), "人工重跑:复核当前 HEAD 并补齐逐条检视回执");
        return { ...task.summary };
      }
    }
    // 外部交付接口停机只需要宿主重试 MR / 流水线。旧实现把任务重新
    // 入 Agent 队列，模型醒来后只能读到 external_verify 再原样结束：
    // 用户白等一轮还多烧 token。没有修复环、没有证据缺口时，清掉
    // 上一轮错误并直接继续交付。整理失败同样属于宿主交付失败，
    // 不能只恢复 verifying，却让 failed 重新启动编码 Agent。
    if (delivery && ((status === "verifying" && delivery.stalled)
          || (status === "failed" && delivery.skipped))
        && !delivery.evidence_gap
        // 生产任务必须已经离开可编辑步骤。历史工作流以 end 表示 Agent
        // 已收口，新工作流以 external_verify 表示宿主等待；两者都只该
        // 续宿主交付。无 host 的纯交付演练没有内核状态文件。
        && (this.atHostDeliveryWait(task)
          || (status === "verifying" && !this.options.host))) {
      task.summary.status = "verifying";
      delete task.summary.completed_at;
      delivery.pipeline = "人工重跑,待重新验证";
      delivery.stalled = undefined;
      delivery.stall_class = undefined;
      delivery.verify_deadline = undefined;
      delivery.skipped = undefined;
      delivery.waiting_on = undefined;
      task.summary.detail = actor
        ? `人工重新尝试交付(${actor})` : "人工重新尝试交付";
      this.markBuildFixResuming(task);
      this.persist(task);
      this.bypass(task, "人工重新尝试交付",
        this.tryDeliver(task, task.controlEpoch));
      return this.project(task);
    }
    if (status === "verifying" && task.summary.delivery) {
      task.summary.delivery.loop = undefined;
      task.summary.delivery.evidence_gap = undefined;
      task.summary.delivery.pipeline = "人工重跑,待重新验证";
      // 人工背书"再试一次":停摆账本清掉,自愈预算重新开表。
      task.summary.delivery.stalled = undefined;
      task.summary.delivery.stall_class = undefined;
      task.summary.delivery.verify_deadline = undefined;
      // 失败原因属于上一轮事故；续推已经受理后继续把它渲染成
      // “交付已阻止”，会与正在运行的新状态互相矛盾。历史仍在诊断包
      // 与服务日志里，当前态只保留这一轮的事实。
      task.summary.delivery.skipped = undefined;
      task.summary.delivery.waiting_on = undefined;
    }
    if (status === "failed" && delivery) {
      delivery.skipped = undefined;
      delivery.waiting_on = undefined;
    }
    task.summary.status = "queued";
    delete task.summary.completed_at;
    task.summary.detail = actor
      ? `人工重跑(${actor}),续接内核当前步骤` : "人工重跑,续接内核当前步骤";
    task.resume = true;
    this.persist(task);
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  /** 已合入任务的继续修改：保留任务、目录和缓存，显式开始新的内核流程。 */
  async continueDelivery(id: string, text: string, requestId: string, actor: string): Promise<TaskSummary> {
    let task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw new TaskControlError("继续修改请求编号无效");
    const message = text.trim();
    if (!message || message.length > 12_000) throw new TaskControlError("请填写本次修改要求（不超过 12000 字）");
    if (task.summary.luban_account && task.summary.luban_account !== actor) throw new TaskControlError("只有任务责任人可以继续修改");
    if (task.summary.continuation?.id === requestId && task.summary.continuation.state === "active") return this.project(task);
    if (task.summary.delivery_history?.some(item => item.archive === requestId)) {
      throw new TaskControlError("这次继续修改请求已结束，请重新填写本次修改要求");
    }
    const pending = continuationPending(task.summary);
    if (task.summary.status !== "completed" || this.isRequirementAnalysis(task) || task.summary.origin === "issue") {
      throw new TaskControlError("请在 MR 已合入的具体代码任务中继续修改；主任务请打开对应子任务");
    }
    const blocked = finalMrContinuationBlock(task.summary);
    if (blocked) throw new TaskControlError(blocked);
    const release = this.beginHistoryMutation(id);
    try {
      if (!this.options.host) throw new TaskControlError("当前部署没有启用需求内核");
      if (task.finalMrAnalysis) await task.finalMrAnalysis.work;
      if (!pending && !["merged", "已合入"].includes(task.summary.delivery?.mr_state ?? "")) {
        throw new TaskControlError("当前任务没有已合入的 MR，不能开始下一次交付");
      }
      if (task.driver || task.container || task.containerReopen || task.prepushActive || task.assistantActive
          || task.mergeSettlement || task.deliveryActive || task.evidenceRetryActive
          || task.transportActive || task.hostActionActive || task.mrCreateActive
          || task.reviewOutboxFlush || hasAuxiliarySessions(task)) {
        throw new TaskControlError("上一轮执行仍在结束，请稍后继续修改");
      }
      const previous = task.summary;
      const branch = previous.continuation && pending ? previous.continuation.branch : previous.delivery?.source_branch;
      const baseline = continuationTarget(previous);
      if (!branch || !baseline) throw new TaskControlError("历史交付缺少工作分支或基准分支，无法继续修改");
      if (task.cwd && existsSync(task.cwd)) {
        const state = new KernelHost({ kernelRoot: this.options.host.kernelRoot,
          workspace: task.cwd, taskId: id, transcriptPath: join(previous.workspace, "transcript.jsonl") }).flowState();
        if (state && !state.terminal && !(pending && state.current === "config_confirm")) {
          throw new TaskControlError(`内核仍在 ${state.current}，不能重置代码目录`);
        }
      }
      const continuation: TaskContinuation = pending ? { ...previous.continuation!, state: "preparing", error: undefined }
        : { id: requestId, text: message, actor, at: new Date().toISOString(), state: "preparing", branch, baseline };
      if (pending && message !== continuation.text) throw new TaskControlError("上次准备尚未完成，请先按已保存的要求重试");
      snapshotContinuation(previous, task.cwd, continuation.id);
      // 替换运行对象，使旧监听与迟到回调仍属于旧对象；任务 ID 和累计用量保留。
      task.controlEpoch += 1;
      discardRetainedSession(task);
      const replacement: TaskState = { summary: { ...structuredClone(previous), continuation },
        cwd: task.cwd, humanGate: task.humanGate, tokenUsage: task.tokenUsage,
        controlEpoch: task.controlEpoch, assistantEpoch: 0 };
      task = replacement;
      this.tasks.set(id, task);
      task.summary.detail = "正在从最新基准准备继续修改，保留原目录与构建缓存";
      this.writeTaskState(task, true);
      this.removeFromQueue(id);
      await Promise.all([this.deliverySummaries.stopTask(id), this.deliveryExperiences.stopTask(id), this.deliveryImprovements.stopTask(id), awaitTaskDeliveryAnalytics(previous)]);
      const repo = task.summary.repo_url ?? this.effectiveDefaultRepo();
      if (!repo) throw new TaskControlError("任务没有配置代码仓");
      validateRepositoryAddress(repo);
      if (/^[a-z][a-z\d+.-]*:/i.test(repo) && !/^(?:https?|file):\/\//i.test(repo)
          && !/^[a-z]:[\\/]/i.test(repo)) throw new TaskControlError("代码仓传输协议不受支持");
      const sandbox = this.prepareHostGitSandbox(this.options.gitCredential?.(task.summary.luban_account));
      try {
        if (!task.cwd || !existsSync(task.cwd)) {
          task.cwd = await this.cloneRepo(task.summary.workspace, sandbox,
            this.options.gitCredential?.(task.summary.luban_account), repo, baseline);
          this.writeTaskState(task, true);
        }
        await resetContinuationBranch({ cwd: task.cwd, repo, branch, baseline, sandbox });
      } finally { this.cleanupHostGitCredential(sandbox); }
      if (this.shuttingDown) throw new TaskControlError("服务正在关闭，请重启后重试继续修改");
      const original = snapshotContinuation(task.summary, task.cwd, continuation.id);
      archiveContinuationRuntime(task.summary.workspace, continuation.id, new TaskHostLedger(task.summary).path);
      const kernel = new KernelHost({ kernelRoot: this.options.host.kernelRoot, python: this.options.host.python,
        workspace: task.cwd!, fileAccessRoot: task.summary.workspace,
        transcriptPath: join(task.summary.workspace, "transcript.jsonl"), taskId: id });
      await kernel.initializeNextDelivery();
      if (this.shuttingDown) throw new TaskControlError("服务正在关闭，请重启后重试继续修改");
      const summary = task.summary;
      summary.delivery_history = [...(original.delivery_history ?? []), {
        id: original.delivery_generation ?? "initial", started_at: original.delivery_started_at ?? original.created_at,
        completed_at: original.completed_at ?? continuation.at, delivery: original.delivery,
        request: original.continuation?.text, archive: continuation.id,
      }];
      summary.delivery_generation = continuation.id;
      summary.delivery_started_at = new Date().toISOString();
      summary.continuation = { ...continuation, state: "active" };
      for (const key of ["delivery", "delivery_selection", "waiting", "progress", "execution_plan", "control",
        "completed_at", "baseline_build", "notify", "feedback", "feedback_error", "focus", "status_label",
        "repair_stopped", "execution_plan_alerts", "workspace_reclaimed_at", "ticket_correction"] as const) delete summary[key];
      summary.baseline = baseline;
      summary.lane = "局部修改";
      summary.status = "queued";
      summary.detail = "继续修改已受理，沿用原任务和代码目录";
      task.humanGate = new HumanGate(join(summary.workspace, "waiting.json"));
      task.resume = false;
      try { this.persist(task, true, true); }
      catch (error) { summary.continuation.state = "failed"; throw error; }
      try {
        const log = new EventLog(this.eventLogPath(id), event => this.bypass(task, "记录继续修改", this.options.projection?.appendEvent(event)));
        log.append({ eventId: log.lastEventId() + 1, taskId: id, sessionId: "main", ts: continuation.at,
          kind: "user_message", payload: { text: continuation.text, actor, via: "continue_delivery" } });
        recordTaskHostInstruction(summary, continuation.text, actor);
      } catch (error) { this.options.log?.(`继续修改要求已随任务保存，时间线记录失败：${String(error)}`); }
      this.queue.push(id);
      this.bypass(undefined, "任务泵", this.pump());
      return this.project(task);
    } catch (error) {
      if (task && continuationPending(task.summary)) {
        task.summary.status = "completed";
        task.summary.continuation!.state = "failed";
        task.summary.continuation!.error = String(error);
        task.summary.detail = `继续修改准备未完成：${String(error)}。修改要求已保存，可重试`;
        this.writeTaskState(task);
        this.replayProjection(task);
      }
      throw error;
    } finally { release(); }
  }

  /** 从头重跑不是 retry：它原位覆盖同一个 task-N，只继承下单配置与
   * 结构关系，不继承工作区、流程进度、人工卡、交付结果或检视记录。 */
  async rerunFromStart(id: string): Promise<TaskSummary> {
    const release = this.beginHistoryMutation(id);
    try {
      return await this.rerunFromStartLocked(id);
    } finally {
      release();
    }
  }

  private async rerunFromStartLocked(id: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (continuationPending(task.summary)) throw new TaskControlError("继续修改尚未准备完成，请先从继续修改入口重试");
    if (!HARD_DELETE_STATUSES.includes(task.summary.status)) {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只有 completed/failed/canceled`
        + " 的任务可以从头重跑",
      );
    }
    if (task.driver || task.container || task.containerReopen
        || task.prepushActive || task.assistantActive
        || task.mergeSettlement || task.evidenceRetryActive
        || task.repairEvidenceRetryActive
        || task.deliveryRecoveryActive || task.reviewOutboxFlush || task.finalMrAnalysis?.running || this.deliveryImprovements.isRunning(id)) {
      throw new TaskControlError(
        `任务 ${id} 仍有执行资源或后台收尾动作，暂不能从头重跑`,
      );
    }
    const generatedChildren = task.summary.requirement_graph?.repositories
      .flatMap((repository) => repository.task_id && repository.task_id !== id ? [repository.task_id] : [])
      ?? [];
    if (generatedChildren.length) {
      throw new TaskControlError(
        `该跨仓父任务已生成子任务 ${generatedChildren.join("、")}；`
        + "原位重跑会造成重复拆单，请在对应子任务上分别从头重跑",
      );
    }
    const source = task.summary;
    const preserveUndefinedRepositorySkills =
      source.repository_skills === undefined;
    const workspace = resolve(this.options.dataDir, id);
    const dataRoot = resolve(this.options.dataDir);
    const backup = join(dataRoot, `.${id}.rerun-${randomUUID()}`);
    const createOptions = {
      title: source.title,
      account: source.luban_account,
      repo: source.repo_url,
      repos: source.repositories ? [...source.repositories] : undefined,
      collaborators: source.collaborators ? [...source.collaborators] : undefined,
      collaboratorsTrusted: true,
      requirementAnalysis: source.requirement_analysis_requested === true,
      lane: source.lane,
      ticket: source.ticket,
      baseline: source.baseline,
      model: source.model_choice ? { ...source.model_choice } : undefined,
      repairRounds: source.repair_rounds,
      repositorySupplementResolved: source.repository_supplement_resolved,
      workflowProfile: source.workflow_profile,
      workflowProfileWarning: source.workflow_profile_warning,
      requirementDocumentName: source.requirement_document?.name,
      requirementBundleName: source.requirement_document?.bundle_name,
      requirementAssets: loadRequirementAssets(
        workspace, source.requirement_document),
      requirementSources: loadRequirementSources(workspace, source.requirement_document),
      requirementWarnings: source.requirement_document?.warnings,
      internalRequirement: Boolean(source.parent_task_id),
      parentTaskId: source.parent_task_id,
      blockedBy: source.blocked_by ? [...source.blocked_by] : undefined,
      repositorySkills: preserveUndefinedRepositorySkills
        ? undefined
        : source.repository_skills!.map((item) => ({ ...item })),
      businessModuleId: source.parent_task_id ? undefined : source.business_module?.id,
      businessModules: (source.business_modules ?? []).map((module) => ({
        ...module,
        assets: module.assets.map((asset) => ({ ...asset })),
      })),
      businessModuleSourceWorkspace: backup,
      repositoryProfiles: source.repository_profiles?.map((item) => ({ ...item })),
      hostSkillSnapshotSourceWorkspace: backup,
      preserveUndefinedRepositorySkills,
      reuseTaskId: id,
      deferQueue: true,
    };

    if (dirname(workspace) !== dataRoot) {
      throw new TaskControlError(`任务 ${id} 的重建路径越过数据目录边界`);
    }
    if (existsSync(workspace) && !lstatSync(workspace).isSymbolicLink()) {
      const realRoot = realpathSync(dataRoot);
      const realWorkspace = realpathSync(workspace);
      if (dirname(realWorkspace) !== realRoot) {
        throw new TaskControlError(`任务 ${id} 的真实路径越过数据目录边界`);
      }
    }
    const hadWorkspace = existsSync(workspace);
    let movedWorkspace = false;

    try {
      if (this.options.projection) {
        await this.options.projection.deleteTask(id, true);
      }
      // 数据库事务期间原现场保持原位；这样进程若在 await 中退出，重启
      // 仍能从 task.json 恢复并重放投影。其后的替换均为同步文件操作。
      if (hadWorkspace) {
        renameSync(workspace, backup);
        movedWorkspace = true;
      }
      this.removeFromQueue(id);
      this.tasks.delete(id);
      const replacement = this.create(source.requirement, createOptions);
      this.reviews.purgeTask(id);
      this.options.notifier?.purgeTask(id);
      if (hadWorkspace) removeTaskTree(backup);
      this.queue.push(id);
      this.bypass(undefined, "任务泵", this.pump());
      return replacement;
    } catch (error) {
      this.removeFromQueue(id);
      this.tasks.delete(id);
      removeTaskTree(workspace);
      if (movedWorkspace && existsSync(backup)) renameSync(backup, workspace);
      this.tasks.set(id, task);
      this.persist(task);
      throw error;
    }
  }

  /** 管理员彻底删除一张真终态历史。外部 Git/MR 本身不属于 Cloud
   * 存储，不在此处远程销毁；Cloud 内的工作区、凭据、检视、引用和
   * PostgreSQL 投影全部清理。 */
  async hardDeleteHistory(id: string): Promise<TaskDeletionResult> {
    const release = this.beginHistoryMutation(id);
    try {
      return await this.hardDeleteHistoryLocked(id);
    } finally {
      release();
    }
  }

  private async hardDeleteHistoryLocked(id: string): Promise<TaskDeletionResult> {
    const taskNumber = /^task-(\d+)$/.exec(id)?.[1];
    const numericId = Number(taskNumber);
    if (!taskNumber || !Number.isSafeInteger(numericId) || numericId < 1) {
      throw new NotFoundError(`任务 ${id} 不存在`);
    }
    const task = this.tasks.get(id);
    if (task && !HARD_DELETE_STATUSES.includes(task.summary.status)) {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只能彻底删除 `
        + "completed/failed/canceled 的历史任务",
      );
    }
    if (task && (task.driver || task.container || task.containerReopen
        || task.prepushActive || task.assistantActive
        || task.mergeSettlement || task.evidenceRetryActive
        || task.repairEvidenceRetryActive
        || task.deliveryRecoveryActive || task.reviewOutboxFlush || task.finalMrAnalysis?.running || this.deliveryImprovements.isRunning(id))) {
      throw new TaskControlError(
        `任务 ${id} 仍有执行资源或后台收尾动作，拒绝彻底删除`,
      );
    }
    const liveReferences = [...this.tasks.values()].filter((other) =>
      other !== task && !HARD_DELETE_STATUSES.includes(other.summary.status)
      && (other.summary.parent_task_id === id
        || other.summary.blocked_by?.includes(id)));
    if (liveReferences.length) {
      throw new TaskControlError(
        `任务 ${id} 仍被未终止任务 ${liveReferences
          .map((item) => item.summary.id).join("、")} 引用，`
        + "请先让关联任务收口或取消，拒绝删除后改变其调度语义",
      );
    }

    // 先把删除目标解析到 dataDir 的直属 task-N；绝不信 task.json 里的
    // workspace 字段。目录若是软链，后续只 unlink 软链本身，不跟出去。
    const dataRoot = resolve(this.options.dataDir);
    const workspace = resolve(dataRoot, id);
    if (dirname(workspace) !== dataRoot) {
      throw new TaskControlError(`任务 ${id} 的删除路径越过数据目录边界`);
    }
    if (existsSync(workspace) && !lstatSync(workspace).isSymbolicLink()) {
      const realRoot = realpathSync(dataRoot);
      const realWorkspace = realpathSync(workspace);
      if (dirname(realWorkspace) !== realRoot) {
        throw new TaskControlError(`任务 ${id} 的真实路径越过数据目录边界`);
      }
    }

    // projection-only 的历史编号也可能高于本机仍保留的现场。先封存水
    // 位再删，避免下一次重启把已经发出去过的永久链接复用给别的任务。
    this.counter = Math.max(this.counter, numericId);
    this.persistTaskSequence();

    const projection = this.options.projection;
    const projected = projection
      ? await projection.deleteTask(id, Boolean(task))
      : { found: false, deleted: false };
    if (!task && !projected.found) {
      throw new NotFoundError(`任务 ${id} 不存在`);
    }
    if (projected.found && !projected.deleted) {
      throw new TaskControlError(
        `任务 ${id} 的历史状态是 ${projected.status}，只能彻底删除 `
        + "completed/failed/canceled 的历史任务",
      );
    }

    const reviewsRemoved = this.reviews.purgeTask(id);
    const notificationsRemoved = this.options.notifier?.purgeTask(id) ?? 0;
    this.removeFromQueue(id);

    // 清除其余现场对这张任务的结构化引用，避免看板留下点不开的父子
    // 链。逐张严格落盘；失败时保留源任务在内存，管理员可原样重试。
    for (const other of this.tasks.values()) {
      if (other === task) continue;
      let changed = false;
      if (other.summary.parent_task_id === id) {
        delete other.summary.parent_task_id;
        changed = true;
      }
      if (other.summary.blocked_by?.includes(id)) {
        const kept = other.summary.blocked_by.filter((item) => item !== id);
        other.summary.blocked_by = kept.length ? kept : undefined;
        changed = true;
      }
      for (const repository of
        other.summary.requirement_graph?.repositories ?? []) {
        if (repository.task_id === id) {
          delete repository.task_id;
          changed = true;
        }
      }
      if (changed) this.persist(other, true);
    }

    removeTaskTree(workspace);
    this.tasks.delete(id);
    return {
      id,
      deleted: true,
      local_task: Boolean(task),
      projection_task: projected.found,
      reviews_removed: reviewsRemoved,
      notifications_removed: notificationsRemoved,
    };
  }

  private beginHistoryMutation(id: string): () => void {
    if (this.historyMutationActive.has(id)) {
      throw new TaskControlError(`任务 ${id} 正在准备继续修改、清空重跑或删除，请勿重复操作`);
    }
    this.historyMutationActive.add(id);
    return () => this.historyMutationActive.delete(id);
  }

  /** 需求图体检(只验不建):图齐不齐、依赖合不合法、有没有环。
   * 单独成函数的原因是 decide() 的顺序纪律——校验必须在决定落袋
   * (humanGate.resolve 的乐观锁)之前,建任务必须在之后;原来两件事
   * 挤在一个函数里,版本冲突 409 时子任务已经先落地了。 */
  private requirementGraphPlan(
    task: TaskState,
    assignmentOverrides?: Record<string, string>,
    ticketOverrides?: Record<string, string>,
  ): {
    graph: RequirementGraph;
    order: string[];
    incoming: Map<string, string[]>;
  } {
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    // stage=analysis 时只认 Agent 机读产物成功解析后的 ready。下单初始化
    // 的候选仓占位图即使“覆盖全部仓库”也不能通过；无改动仓只需要有
    // assessment，不需要、也不允许伪造交付节点。
    if (!graph || (graph.stage === "analysis"
        && graph.projection_state !== "ready")) {
      const reason = graph?.projection_error
        ? `：${graph.projection_error}` : "";
      throw new NotFoundError(
        `模块拆分与依赖图尚未生成完整${reason}。请让 Agent 补齐后再确认`,
      );
    }
    const ticket = task.summary.ticket ?? task.summary.id;
    const artifact = currentRequirementPlan(task.summary, task.cwd);
    if (!artifact?.content.trim()) {
      throw new NotFoundError("全局设计正文尚未生成，请先让 Agent 补齐 Story");
    }
    // 执行顺序由显式依赖计算；参考路径不参与权限或计划确认。
    // 下单免了单号的分析单,确认是单号的最后收口:每个单元必须有
    // 真单号(覆盖值或已分工保存的),否则子任务建出来内核没法派生
    // 分支。不查这里,撞分支校验会拿任务 id 兜底,报出"同单号"这种
    // 让人摸不着头脑的错。纯会话形态(无内核)不强制,与下单同口径。
    if (this.options.host && !this.options.host.repoPath) {
      const missing = graph.repositories.find((repository) =>
        !(ticketOverrides?.[repository.id] ?? repository.ticket
          ?? task.summary.ticket));
      if (missing) {
        throw new TaskControlError(
          `请为交付单元「${missing.scope?.name ?? missing.name}」填写 AR `
          + "单号——下单时未填单号的需求,确认拆分时逐单元补齐");
      }
    }
    // 真实前置合入后从最新基线启动；无依赖的单元各自分支、MR 并行。
    const ids = new Set(graph.repositories.map((repository) => repository.id));
    const prerequisites = new Map<string, string[]>();
    for (const id of ids) prerequisites.set(id, []);
    for (const edge of graph.dependencies) {
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) {
        throw new NotFoundError("需求图包含无效依赖，请让 Agent 修正后再确认");
      }
      // `from 依赖 to`：from 的前置项是 to。
      prerequisites.get(edge.from)!.push(edge.to);
    }
    const remaining = new Set(ids);
    const order: string[] = [];
    while (remaining.size) {
      const ready = [...remaining].filter((id) =>
        (prerequisites.get(id) ?? []).every((parent) => !remaining.has(parent)));
      if (!ready.length) throw new NotFoundError("仓库依赖存在循环，不能生成任务");
      ready.forEach((id) => { remaining.delete(id); order.push(id); });
    }
    // 只执行已确认的真实依赖；同仓不能自动推导串行。
    const dependsOn = (from: string, target: string): boolean =>
      (prerequisites.get(from) ?? []).some(id => id === target || dependsOn(id, target));
    for (let i = 0; i < graph.repositories.length; i++) {
      const left = graph.repositories[i];
      for (const right of graph.repositories.slice(i + 1)) {
        if (repositoryIdentity(left.url) !== repositoryIdentity(right.url)
            || dependsOn(left.id, right.id) || dependsOn(right.id, left.id)) continue;
        const leftTicket = ticketOverrides?.[left.id] ?? left.ticket ?? task.summary.ticket;
        const rightTicket = ticketOverrides?.[right.id] ?? right.ticket ?? task.summary.ticket;
        // 已建单任务沿用持久化的执行安排，不因新建单规则阻断旧任务材料恢复。
        if (graph.stage !== "confirmed" && leftTicket && leftTicket === rightTicket) {
          throw new TaskControlError(`同仓并行单元「${left.scope?.name ?? left.name}」与「${right.scope?.name ?? right.name}」不能共用 AR ${leftTicket}，请填写不同单号；只有真实依赖才应安排串行`);
        }
      }
    }
    return { graph, order, incoming: prerequisites };
  }

  /** 主任务采用“一个主责任人 + 多位共同开发者”。协作者参与澄清，
   * 但最终确认和任务控制仍只有主责任人，避免多人同时改写结论。 */
  setRequirementCollaborators(
    id: string,
    accounts: string[],
  ): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("只有需求分析主任务可以邀请共同开发者");
    }
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    // 单仓拆分后主任务可能只有一个仓:协作者在澄清期就要能进场
    // (划分方向卡批注插话),不再要求图先拆出 ≥2 节点。
    if (!graph || !graph.repositories.length) {
      throw new NotFoundError("需求图尚未生成，暂不能邀请共同开发者");
    }
    if (graph.stage === "confirmed"
        || graph.repositories.some((repository) => repository.task_id)) {
      throw new TaskControlError("仓库任务已经生成，主任务协作成员不能再调整");
    }
    const owner = task.summary.luban_account;
    const normalized = [...new Set(accounts.map((account) => account.trim())
      .filter((account) => account && account !== owner))];
    if (normalized.length > 20) {
      throw new TaskControlError("一个跨仓主任务最多邀请 20 位共同开发者");
    }
    for (const account of normalized) {
      const readiness = this.options.collaborationAssigneeReadiness?.(account);
      if (readiness && !readiness.ready) {
        throw new TaskControlError(
          `${account} 的个人设置尚未就绪：${readiness.missing.join("、")}`,
        );
      }
    }
    task.summary.collaborators = normalized;
    this.persist(task);
    return { ...task.summary };
  }

  /** 人工分工是主任务契约的一部分，不是 create 子任务时临时拼的参数。
   * 全量提交避免半张图新、半张图旧；就绪校验失败时一项都不落盘。 */
  assignRequirementRepositories(
    id: string,
    assignments: Record<string, string>,
    tickets?: Record<string, string>,
  ): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("只有需求分析主任务可以委派交付单元责任人");
    }
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    // 单仓拆分:单元 ≥1 即可分工(每个单元一行,单元数由图说了算)。
    if (!graph || !graph.repositories.length) {
      throw new NotFoundError("需求图尚未生成，暂不能分工");
    }
    if (graph.stage === "confirmed"
        || graph.repositories.some((repository) => repository.task_id)) {
      throw new TaskControlError("仓库任务已经生成，责任人不能在主任务上改派");
    }
    const ids = new Set(graph.repositories.map((repository) => repository.id));
    const submitted = Object.keys(assignments);
    const unknown = submitted.filter((repositoryId) => !ids.has(repositoryId));
    const missingRepositories = [...ids].filter((repositoryId) =>
      !Object.prototype.hasOwnProperty.call(assignments, repositoryId));
    const ticketKeys = Object.keys(tickets ?? {});
    const unknownTickets = ticketKeys.filter((repositoryId) => !ids.has(repositoryId));
    const missingTickets = tickets ? [...ids].filter((repositoryId) =>
      !Object.prototype.hasOwnProperty.call(tickets, repositoryId)) : [];
    if (unknown.length || missingRepositories.length
        || unknownTickets.length || missingTickets.length) {
      throw new TaskControlError("请为需求图中的每个仓库完整选择责任人后再保存");
    }
    const normalized = new Map<string, string>();
    const normalizedTickets = new Map<string, string>();
    for (const repository of graph.repositories) {
      const account = String(assignments[repository.id] ?? "").trim();
      if (!account) {
        throw new TaskControlError(`仓库 ${repository.name} 尚未选择责任人`);
      }
      const readiness = this.options.collaborationAssigneeReadiness?.(account);
      if (readiness && !readiness.ready) {
        throw new TaskControlError(
          `${account} 的个人设置尚未就绪：${readiness.missing.join("、")}`,
        );
      }
      normalized.set(repository.id, account);
      const ticket = String(tickets?.[repository.id]
        ?? repository.ticket ?? task.summary.ticket ?? "").trim();
      if (!ticket) {
        throw new TaskControlError(`仓库 ${repository.name} 尚未填写 AR 单号`);
      }
      if (/\s/.test(ticket)) {
        throw new TaskControlError(`仓库 ${repository.name} 的 AR 单号不能含空白字符`);
      }
      normalizedTickets.set(repository.id, ticket);
    }
    for (const repository of graph.repositories) {
      repository.assignee = normalized.get(repository.id)!;
      repository.ticket = normalizedTickets.get(repository.id)!;
    }
    this.persist(task);
    return { ...task.summary };
  }

  /** 方案确认卡里的分工草稿要边填边落盘。它和最终确认是两件事：
   * 这里允许只填一部分，切换任务、刷新页面后仍能恢复；真正创建子任务
   * 时仍由 assignRequirementRepositories 做全量完整性与就绪校验。 */
  saveRequirementRepositoryAssignmentDraft(
    id: string,
    assignments: Record<string, string>,
    tickets?: Record<string, string>,
  ): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("只有需求分析主任务可以保存交付单元分工草稿");
    }
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    if (!graph || !graph.repositories.length) {
      throw new NotFoundError("需求图尚未生成，暂不能保存分工草稿");
    }
    if (graph.stage === "confirmed"
        || graph.repositories.some((repository) => repository.task_id)) {
      throw new TaskControlError("仓库任务已经生成，责任人不能在主任务上改派");
    }
    const ids = new Set(graph.repositories.map((repository) => repository.id));
    const unknown = [...Object.keys(assignments), ...Object.keys(tickets ?? {})]
      .filter((repositoryId) => !ids.has(repositoryId));
    if (unknown.length) {
      throw new TaskControlError(
        `分工草稿包含已失效的交付单元：${[...new Set(unknown)].join("、")}`,
      );
    }
    for (const repository of graph.repositories) {
      if (Object.prototype.hasOwnProperty.call(assignments, repository.id)) {
        const account = String(assignments[repository.id] ?? "").trim();
        if (account) {
          const readiness = this.options.collaborationAssigneeReadiness?.(account);
          if (readiness && !readiness.ready) {
            throw new TaskControlError(
              `${account} 的个人设置尚未就绪：${readiness.missing.join("、")}`,
            );
          }
          repository.assignee = account;
        } else {
          delete repository.assignee;
        }
      }
      if (tickets
          && Object.prototype.hasOwnProperty.call(tickets, repository.id)) {
        const ticket = String(tickets[repository.id] ?? "").trim();
        if (/\s/.test(ticket)) {
          throw new TaskControlError(
            `仓库 ${repository.name} 的 AR 单号不能含空白字符`,
          );
        }
        if (ticket) repository.ticket = ticket;
        else delete repository.ticket;
      }
    }
    this.persist(task);
    return { ...task.summary };
  }

  /** 同一需求广播：先落盘，再通知正在运行的 Agent；其他任务继续时读取。 */
  private syncCrossRepositoryUpdates(task: TaskState): void {
    const parent = task.summary.parent_task_id
      ? this.tasks.get(task.summary.parent_task_id) : task;
    if (!parent) return;
    try {
      syncCrossRepositoryGroup(parent, this.tasks.values(), (member) => { this.persist(member); this.refreshOwnerInputs(member); });
    } catch (error) {
      this.options.log?.(`[cross-repo-update] ${task.summary.id} 历史通知补齐失败，保留已有记录: ${error}`);
    }
  }

  async publishCrossRepositoryUpdate(
    id: string,
    author: string,
    text: string,
  ): Promise<CrossRepositoryUpdate> {
    const source = this.tasks.get(id);
    if (!source) throw new NotFoundError(`任务 ${id} 不存在`);
    const message = text.trim();
    if (!message) throw new TaskControlError("请写清楚发生了什么变化或哪里不确定");
    if (message.length > 8_000) {
      throw new TaskControlError("单条跨仓同步不能超过 8000 字");
    }
    const parentId = source.summary.parent_task_id;
    const parent = parentId ? this.tasks.get(parentId) : undefined;
    const graph = parent?.summary.requirement_graph;
    if (!parent) {
      throw new NotFoundError("该任务不隶属于可协作的跨仓大任务");
    }
    const sourceRepository = graph?.repositories.find((repository) =>
      repository.task_id === source.summary.id);
    const update: CrossRepositoryUpdate = {
      id: `cross-${randomUUID()}`,
      parent_task_id: parentId!,
      source_task_id: source.summary.id,
      source_repository: sourceRepository?.name ?? source.summary.repo_url,
      author,
      text: message,
      target_task_ids: [],
      created_at: new Date().toISOString(),
    };
    const recorded = syncCrossRepositoryGroup(parent, this.tasks.values(),
      (member) => { this.persist(member); this.refreshOwnerInputs(member); }, update).find((item) => item.id === update.id)!;
    // 先落盘再并行入队，一个 Agent 的即时发送失败不影响其他任务。
    await Promise.all([parent.summary.id, ...recorded.target_task_ids].map(async (targetId) => {
      const target = this.tasks.get(targetId);
      if (!target || target.summary.status !== "running") return;
      try {
        const context = crossRepositoryUpdateContext(target);
        if (target.driver) {
          await target.driver.steer([
            `[需求协作通知 · ${author} · ${sourceRepository?.name ?? id}]`,
            message, context,
          ].join("\n"));
        }
      } catch (cause) {
        this.options.log?.(
          `[cross-repo-update] ${update.id} 即时发送 ${targetId} 失败，已落盘待后续注入: ${cause}`);
      }
    }));
    return recorded;
  }

  /** 从已确认机读图机械生成当前单元任务书。它是子任务的执行边界；
   * 原始需求与全局 Story 提供业务背景、约束来源和上下游解释，不能
   * 反过来把本单元扩大成整张需求。 */
  private deliveryUnitBrief(
    parent: TaskState,
    repository: RequirementRepository,
    order: string[],
    incoming: Map<string, string[]>,
  ): string {
    const graph = parent.summary.requirement_graph!;
    const id = repository.id;
    const label = repository.scope?.name ?? repository.name;
    const position = `${order.indexOf(id) + 1}/${order.length}`;
    const describe = (otherId: string): string => {
      const other = graph.repositories.find((item) => item.id === otherId);
      return other ? (other.scope?.name ?? other.name) : otherId;
    };
    const reasonFor = (dependent: string, prerequisite: string): string =>
      graph.dependencies.find((edge) =>
        edge.from === dependent && edge.to === prerequisite)?.reason?.trim() ?? "";
    const upstream = (incoming.get(id) ?? []).map((otherId) => {
      const reason = reasonFor(id, otherId);
      return `- ${describe(otherId)}${reason ? `：${reason}` : ""}`;
    });
    const downstream = order
      .filter((otherId) => (incoming.get(otherId) ?? []).includes(id))
      .map((otherId) => {
        const reason = reasonFor(otherId, id);
        return `- ${describe(otherId)}${reason ? `：${reason}` : ""}`;
      });
    return [
      `# 当前单元任务书：${label}`,
      "",
      "> **这是当前任务的执行入口和范围边界。** 整体方案用于"
        + "核对上下游，原始需求用于按需核对背景、约束和验收来源；不得仅因"
        + "参考材料涉及其他模块，就擅自扩大本单元范围。",
      "",
      "## 材料优先级",
      "",
      `1. \`${AGENT_DELIVERY_UNIT}\`：先读本任务书，明确自己要交付什么。`,
      `2. \`${AGENT_DELIVERY_CHAIN}\`：再读全局 Story（历史任务为拆分方案），核对 4+1、接口与上下游。`,
      `3. \`${AGENT_REQUIREMENT_DOCUMENT}\`：按需查阅用户原始需求，核对业务背景、约束和验收来源。`,
      "",
      "## 本单元交付",
      "",
      `- 位置：第 ${position} 个交付单元`,
      `- 单元：${label}`,
      `- 代码仓：${repository.name}`,
      `- 责任人：${repository.assignee ?? parent.summary.luban_account ?? "未指定"}`,
      `- AR 单号：${repository.ticket ?? parent.summary.ticket ?? "未填写"}`,
      `- 核心职责：${repository.responsibility ?? "以整体拆分方案中的当前单元章节为准"}`,
      "",
      "## 预计涉及的代码位置（仅供参考）",
      "",
      ...(repository.scope?.paths.length
        ? repository.scope.paths.map((path) => `- \`${path}\``)
        : ["- 未限定目录；可在当前代码仓内完成上述职责所需的最小改动。"]),
      "",
      "## 上下游关系",
      "",
      ...(upstream.length ? ["### 依赖的上游", "", ...upstream, ""]
        : ["- 无前置交付单元。", ""]),
      ...(downstream.length ? ["### 依赖本单元的下游", "", ...downstream, ""]
        : ["- 无下游交付单元。", ""]),
      "## 执行边界",
      "",
      "- 按职责完成模块实现与验证；公共骨架按契约、装配和编译验收，不冒充业务可用。参考路径不是修改白名单。",
      "- 全局 Story 定义模块职责、关键类与接口、4+1 和验收依据；开发阶段的 Spec 细化模块测试设计，Story 细化实现。",
      "- 上游已合入时，核对当前代码接口与全局 Story；设计修订时同步核对变化及影响，不把旧快照当作最新约定。",
      "- 局部兼容调整自主完成并说明；影响验收、兼容性或其他模块的变化优先交责任人判断，不因文件变化机械阻断。",
      "- 不得重新询问主任务已经确认的事项，也不得把其他单元的工作收进本单元。",
      "",
    ].join("\n");
  }

  /** 升级前的子任务只有 chain-plan.md，任务书被拼在长需求末尾。重启时
   * 从父任务已确认图补出独立任务书，并把“需求原文”恢复成用户原文。
   * 只修同时能找到父任务和 task_id 映射的确定形态，无法确认时不猜。 */
  private ensureDeliveryUnitMaterials(task: TaskState): boolean {
    if (!task.summary.parent_task_id) return false;
    const parent = this.tasks.get(task.summary.parent_task_id);
    const repository = parent?.summary.requirement_graph?.repositories
      .find((item) => item.task_id === task.summary.id);
    if (!parent || !repository) return false;
    const chainPath = join(task.summary.workspace, DELIVERY_CHAIN_SOURCE);
    const unitPath = join(task.summary.workspace, DELIVERY_UNIT_SOURCE);
    const requirementPolluted = task.summary.requirement
      !== parent.summary.requirement
      && task.summary.requirement.startsWith(parent.summary.requirement)
      && task.summary.requirement.includes("本单元任务书");
    if (parent.summary.requirement_graph?.source_document === "story.md"
        && parent.summary.requirement_graph.stage === "confirmed") {
      const plan = currentRequirementPlan(parent.summary, parent.cwd);
      const revision = readStoryState(parent.summary.workspace).current;
      if (plan?.content && revision) this.syncPublishedStory(parent, plan.content, revision);
    }
    if (existsSync(chainPath) && existsSync(unitPath) && !requirementPolluted) {
      return false;
    }
    const { order, incoming } = this.requirementGraphPlan(parent);
    if (!existsSync(chainPath)) {
      const artifact = currentRequirementPlan(parent.summary, parent.cwd);
      if (!artifact?.content) return false;
      writeFileSync(chainPath, artifact.content, { mode: 0o600 });
    }
    if (!existsSync(unitPath)) {
      writeFileSync(unitPath,
        this.deliveryUnitBrief(parent, repository, order, incoming),
        { mode: 0o600 });
    }
    if (requirementPolluted) {
      task.summary.requirement = parent.summary.requirement;
      task.summary.requirement_document = parent.summary.requirement_document
        ? structuredClone(parent.summary.requirement_document) : undefined;
      materializeRequirementAssets(parent.summary.workspace, task.summary.workspace, task.summary.requirement_document);
      materializeRequirementSources(parent.summary.workspace, task.summary.workspace, task.summary.requirement_document);
      storeRequirementDocument(task.summary.workspace,
        task.summary.requirement, task.summary.requirement_document);
      this.persist(task);
    }
    this.options.log?.(
      `任务 ${task.summary.id} 已补齐当前单元任务书与整体拆分方案入口`);
    return true;
  }

  /** 人工确认全局 Story（旧版 CHAIN）后，把图上的模块交付单元落成现有普通任务。
   * 可重入:已有 task_id 的单元跳过(第 N 个单元 create 抛错或中途重启后
   * 重试,不许把前面的单元再建一遍);每建一个就 persist——task_id 只写
   * 内存的话,重启即失忆,重试必出重复任务。 */
  private createRepositoryDeliveries(task: TaskState): void {
    const { graph, order, incoming } = this.requirementGraphPlan(task);
    if (graph.repositories.length === 0) {
      graph.stage = "confirmed";
      task.summary.detail = "分析结论已确认：候选仓均无需修改，未生成开发任务";
      this.persist(task);
      this.adoptRequirementStory(task);
      return;
    }
    if (graph.repositories.every((repository) => repository.task_id)) {
      graph.stage = "confirmed";
      this.persist(task);
      this.adoptRequirementStory(task);
      return;
    }
    const artifact = currentRequirementPlan(task.summary, task.cwd);
    if (!artifact?.content) {
      throw new TaskControlError(
        "已确认的整体拆分方案暂时无法读取，未生成子任务；请刷新后重试");
    }
    if (graph.repositories.length === 1) {
      materializeDeliveryDocument(task.summary.workspace, DELIVERY_CHAIN_SOURCE, artifact.content);
      writeFileSync(join(task.summary.workspace, DELIVERY_UNIT_SOURCE),
        this.deliveryUnitBrief(task, graph.repositories[0], order, incoming), { mode: 0o600 });
      graph.stage = "confirmed";
      graph.repositories[0].task_id = task.summary.id;
      this.persist(task, true);
      this.adoptRequirementStory(task);
      return;
    }
    // 确认事实先落盘，再逐个建单。persist 的展示投影会刷新 analysis 图，
    // 若到循环末尾才 confirmed，后续 task_id/stage 会写进被替换的旧对象。
    // confirmed 不代表已建齐；未关联单元继续由下面的可重入建单补齐。
    graph.stage = "confirmed";
    this.persist(task);
    const taskIds = new Map<string, string>();
    for (const repository of graph.repositories) {
      if (repository.task_id) taskIds.set(repository.id, repository.task_id);
    }
    for (const id of order) {
      const repository = graph.repositories.find((item) => item.id === id)!;
      if (repository.task_id) continue;
      const blockers = (incoming.get(id) ?? [])
        .map((parent) => taskIds.get(parent)).filter(Boolean) as string[];
      const unitLabel = repository.scope?.name ?? repository.name;
      const unitBrief = this.deliveryUnitBrief(task, repository, order, incoming);
      const preserveUndefinedRepositorySkills =
        task.summary.repository_skills === undefined;
      const parentWorkflow = task.summary.workflow_profile;
      const child = this.create(task.summary.requirement, {
        // 单元名在前:父标题常常本身就是截到 80 字的需求首行,单元名放后面
        // 会被截掉,列表里两个子任务一模一样(2026-09-06 跨仓真模型演练实锤)。
        title: taskTitle(
          `${unitLabel} · ${task.summary.title ?? taskTitle(task.summary.requirement)}`),
        account: repository.assignee ?? task.summary.luban_account,
        repo: repository.url,
        lane: task.summary.lane,
        ticket: repository.ticket ?? task.summary.ticket,
        baseline: task.summary.baseline,
        model: task.summary.model_choice,
        repairRounds: task.summary.repair_rounds,
        // 父任务的文字补充随拆单下传(团队约定会按当前设置重建,
        // 仓库约定由子任务自己的首次 clone 重新解析)。
        taskInstructions: parentWorkflow?.supplements
          ?.find((item) => item.scope === "task")?.instructions,
        // 子任务的仓库、技术和可用 Skill 已经变窄，不能整份照搬父任务
        // 的最终方案；用父 profile 保存的 base+edits 在子任务快照上重编，
        // 不适用资产逐项回退，平台流程继续。supplement-only 档没有
        // base_snapshot,无结构可重编。
        workflowDefinition: parentWorkflow?.base_snapshot ? {
          schema: "mae-flow-workflow-definition/1",
          base: {
            standard_id: parentWorkflow.base_snapshot.standard_id,
            standard_version: parentWorkflow.base_snapshot.standard_version,
            catalog_digest: parentWorkflow.base_snapshot.catalog_digest,
          },
          applicability: {
            business_module_ids: (task.summary.business_modules ?? [])
              .map((module) => module.id),
            repositories: [repository.url],
            technologies: (task.summary.repository_profiles ?? [])
              .filter((profile) => profile.repository === repository.url)
              .flatMap((profile) => profile.technologies),
          },
          edits: structuredClone(parentWorkflow.edits),
        } : undefined,
        workflowSource: parentWorkflow?.base_snapshot
          ? structuredClone(parentWorkflow.source) : undefined,
        workflowProfileWarning: task.summary.workflow_profile_warning,
        hostSkillSnapshotSourceWorkspace: task.summary.workspace,
        parentTaskId: task.summary.id,
        deliveryUnitMaterials: {
          chain: artifact.content,
          unit: unitBrief,
        },
        internalRequirement: true,
        requirementDocumentName: task.summary.requirement_document?.name,
        requirementBundleName: task.summary.requirement_document?.bundle_name,
        requirementAssets: loadRequirementAssets(
          task.summary.workspace, task.summary.requirement_document),
        requirementSources: loadRequirementSources(task.summary.workspace, task.summary.requirement_document),
        requirementWarnings: task.summary.requirement_document?.warnings,
        blockedBy: blockers,
        repositorySkills: preserveUndefinedRepositorySkills
          ? undefined
          : task.summary.repository_skills!.filter(
              (skill) => skill.repository === repository.url),
        businessModules: (task.summary.business_modules ?? [])
          .map((module) => ({
            ...module,
            assets: module.assets.map((asset) => ({ ...asset })),
          })),
        businessModuleSourceWorkspace: task.summary.workspace,
        repositoryProfiles: (task.summary.repository_profiles ?? [])
          .filter((profile) => profile.repository === repository.url),
        preserveUndefinedRepositorySkills,
      });
      repository.task_id = child.id;
      taskIds.set(id, child.id);
      this.persist(task);
    }
    graph.stage = "confirmed";
    task.summary.detail = `需求方案已确认，已生成 ${order.length} 个模块开发任务`;
    this.persist(task);
    this.adoptRequirementStory(task);
  }

  private adoptRequirementStory(task: TaskState): void {
    if (task.summary.requirement_graph?.source_document !== "story.md"
        || (isMainTaskDelivery(task.summary) && !this.isRequirementAnalysis(task))) return;
    const plan = currentRequirementPlan(task.summary, task.cwd);
    if (!plan?.content) return;
    if (!readStoryState(task.summary.workspace).current
        && createHash("sha256").update(plan.content, "utf8").digest("hex")
          !== task.summary.requirement_graph.chain_sha256) {
      throw new TaskControlError("分析 Story 已偏离确认版本，保留现有任务材料，请恢复已确认文档后重试发布");
    }
    const ticket = task.summary.ticket ?? task.summary.id;
    const semanticArchitecture = readAnalysisSemanticArchitecture(task.cwd, ticket);
    this.overallStories.adoptAnalysis(task.summary.id, plan.content,
      task.summary.luban_account ?? "责任人",
      semanticArchitecture ? undefined : readAnalysisArchitecture(task.cwd, ticket),
      semanticArchitecture);
  }
  /** 派生材料随发布版本更新；通知使用已有持久账本，不改变任务编排。 */
  private syncPublishedStory(parent: TaskState, content: string, revision: string): void {
    if (parent.summary.requirement_graph?.source_document !== "story.md") return;
    for (const node of parent.summary.requirement_graph.repositories) {
      const child = node.task_id ? this.tasks.get(node.task_id) : undefined;
      if (!child) continue;
      try {
        materializeDeliveryDocument(child.summary.workspace, DELIVERY_CHAIN_SOURCE, content);
        if (child.cwd && existsSync(child.cwd)) materializeDeliveryDocument(child.cwd, AGENT_DELIVERY_CHAIN, content);
      } catch (cause) {
        this.options.log?.(`全局 Story ${revision} 向 ${child.summary.id} 同步失败，下次启动重试: ${cause}`);
      }
    }
    if (isMainTaskDelivery(parent.summary)) return;
    const id = `story-${revision}`;
    const alreadyRecorded = parent.summary.cross_repository_updates?.some((item) => item.id === id);
    const message = `全局 Story 已发布版本 ${revision}。请读取 ${AGENT_DELIVERY_CHAIN}，`
      + "核对本模块职责、接口和验收场景的变化；必要时同步子 Spec/Story。"
      + "文档更新不表示代码已完成，也不自动重启任务。职责或接口出现歧义、冲突时请责任人判断。";
    const update: CrossRepositoryUpdate = {
      id, parent_task_id: parent.summary.id, source_task_id: parent.summary.id,
      source_repository: "全局 Story",
      author: readStoryState(parent.summary.workspace).revisions.find((item) => item.id === revision)?.by ?? "系统",
      text: message, target_task_ids: [], created_at: new Date().toISOString(),
    };
    // 同一版本只记一条消息；恢复时仍补齐新增子任务和落盘失败的材料。
    const recorded = syncCrossRepositoryGroup(parent, this.tasks.values(),
      (member) => { this.persist(member); this.refreshOwnerInputs(member); }, alreadyRecorded ? undefined : update)
      .find((item) => item.id === id);
    if (alreadyRecorded || !recorded) return;
    this.bypass(parent, "全局 Story 更新提示", Promise.all(recorded.target_task_ids.map(async (targetId) => {
      const target = this.tasks.get(targetId);
      if (!target?.driver || target.summary.status !== "running") return;
      try { await target.driver.steer(`${message}\n${crossRepositoryUpdateContext(target)}`); }
      catch (cause) { this.options.log?.(`全局 Story 即时提示 ${targetId} 失败，已落盘待继续时读取: ${cause}`); }
    })));
  }

  /** 有依赖的子任务启动时，把“上游实际交付”而非最初计划交给它。
   * 这是 Cloud 编排上下文，不是内核步骤/完成证据；读取失败 fail-open，
   * 但文件一旦生成就进入 prompt 硬要求，避免接口已经变了下游还按旧
   * Chain 猜。 */
  private async materializeDependencyHandoff(
    task: TaskState,
    cwd: string,
  ): Promise<boolean> {
    const blockers = task.summary.blocked_by ?? [];
    if (!blockers.length) return false;
    const parent = task.summary.parent_task_id
      ? this.tasks.get(task.summary.parent_task_id) : undefined;
    const graph = parent?.summary.requirement_graph;
    const currentRepository = graph?.repositories.find((repository) =>
      repository.task_id === task.summary.id);
    const sections: string[] = [];
    for (const blockerId of blockers) {
      const predecessor = this.tasks.get(blockerId);
      if (!predecessor) continue;
      const predecessorRepository = graph?.repositories.find((repository) =>
        repository.task_id === blockerId);
      const edge = currentRepository && predecessorRepository
        ? graph?.dependencies.find((candidate) =>
            candidate.from === currentRepository.id
            && candidate.to === predecessorRepository.id)
        : undefined;
      const snapshot = predecessor.cwd && existsSync(predecessor.cwd)
        ? await deliveryChangeSnapshot(predecessor.cwd).catch(() => undefined)
        : undefined;
      let assistantSummary = "";
      try {
        const messages = new EventLog(join(
          predecessor.summary.workspace, "events.jsonl")).replay()
          .filter((event) => event.kind === "assistant_message"
            && String(event.sessionId ?? "main") === "main")
          .map((event) => String(event.payload?.text ?? "").trim())
          .filter(Boolean);
        assistantSummary = messages.slice(-2).join("\n\n").slice(0, 3500);
      } catch {
        // 交接的其他事实仍可用，事件旁路损坏不拦下游启动。
      }
      const delivery = predecessor.summary.delivery;
      sections.push([
        `## ${predecessorRepository?.name ?? predecessor.summary.repo_url ?? blockerId}`,
        `- 前置任务：${blockerId}`,
        `- 责任人：${predecessor.summary.luban_account ?? "未记录"}`,
        `- 当前状态：${predecessor.summary.status}`,
        edge?.reason ? `- 依赖原因：${edge.reason}` : "",
        delivery?.sha ? `- 交付 SHA：${delivery.sha}` : "",
        delivery?.mr_url ? `- 合并请求：${delivery.mr_url}` : "",
        snapshot?.committed_paths.length
          ? `- 实际改动文件：\n${snapshot.committed_paths
              .map((path) => `  - ${path}`).join("\n")}`
          : "- 实际改动文件：现场未提供可证明的提交清单，请不要据此猜接口未变",
        assistantSummary
          ? `\n### 上游 AI 收口说明\n\n${assistantSummary}` : "",
      ].filter(Boolean).join("\n"));
    }
    if (!sections.length) return false;
    writeFileSync(join(cwd, ".mae-flow-dependencies.md"), [
      "# 跨仓前置交接（平台生成）",
      "",
      "以下内容来自前置仓的真实交付现场，优先用于核对最初 Chain 契约。",
      "开始设计或修改接口前必须阅读；若实际交付与 Chain 文档、当前仓实现",
      "不一致，停止猜测并向责任人举卡，把冲突回报跨仓主任务。",
      "",
      ...sections,
      "",
    ].join("\n"));
    return true;
  }

  /** 需求图面板不是第二套审批:分析会话正在等人时,这颗结构化按钮
   * 先消费当前 HumanGate 决定、恢复同一会话,再幂等生成各仓普通任务。
   * 这样不会出现“子任务已经生成,父分析单却还在等确认”的双状态。
   * 已经收尾的旧单仍允许从图面板补建,用于兼容历史现场。 */
  async confirmRequirementGraph(
    id: string,
    skillSelection?: {
      catalog_token?: string;
      selected_ids?: string[];
      repository_assignees?: Record<string, string>;
      repository_tickets?: Record<string, string>;
    },
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (isMainTaskDelivery(task.summary) && !this.isRequirementAnalysis(task)) return { ...task.summary };
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("该任务不是多仓需求分析单,没有需求图可确认");
    }
    // 正常路径在举卡时已经封版；这一步同时兜住升级前已经在等待中的
    // 老任务：第一次确认只认用户此刻实际看到的文件，随后立即锁定。
    this.sealRequirementGraphReview(task);
    this.requirementGraphPlan(task, skillSelection?.repository_assignees,
      skillSelection?.repository_tickets);
    const alreadyGenerated = task.summary.requirement_graph?.repositories
      .every((repository) => repository.task_id) ?? false;
    if (alreadyGenerated && !isMainTaskDelivery(task.summary) && task.summary.status !== "waiting_for_human") {
      return { ...task.summary };
    }
    if (task.summary.status === "waiting_for_human" && task.summary.waiting) {
      const questions = (
        requirementDecisionContract(task.summary.waiting.question, true).questions ?? []
      ) as Array<{ question?: string; options?: string[] }>;
      if (questions.length !== 1) {
        throw new NotFoundError(
          "仍有多项需求问题待澄清，请先逐题处理，再确认跨仓方案",
        );
      }
      const expectedConfirmation = REQUIREMENT_GRAPH_APPROVE;
      const decision = questions[0]?.options?.find((option) =>
        confirmsRequirementGraph(option)) ?? expectedConfirmation;
      await this.decide(id, {
        state_version: task.summary.waiting.state_version,
        decision,
        repository_skill_catalog_token: skillSelection?.catalog_token,
        selected_repository_skill_ids: skillSelection?.selected_ids,
        repository_assignees: skillSelection?.repository_assignees,
        repository_tickets: skillSelection?.repository_tickets,
        // 收尾令随决定送达:确认后父会话再举卡会被系统代答赶下台
        // (autoAnswerFor 的分析单兜底),但第一选择是它自己别举。
        notes: "方案确认后由平台接续开发：一个单元在本任务继续，多个单元生成子任务；"
          + "请写一段简短收尾说明后立即结束,不要再提问。",
      });
      // decide 会在标准选项命中时生成任务；这里再走一次幂等兜底，
      // 让模型即使把选项写成“方案通过”也不会丢掉拆单动作。
      if (this.isRequirementAnalysis(task)) this.createRepositoryDeliveries(task);
      return { ...task.summary };
    }
    if (task.summary.status === "canceled") throw new TaskControlError("任务已取消，不能继续确认方案");
    if (!["completed", "failed"].includes(task.summary.status)) {
      throw new NotFoundError("需求分析尚未进入人工检视，暂不能确认方案");
    }
    if (skillSelection?.repository_assignees && !alreadyGenerated) {
      this.assignRequirementRepositories(id, skillSelection.repository_assignees,
        skillSelection.repository_tickets);
    }
    this.createRepositoryDeliveries(task);
    await this.finishRequirementAnalysis(task);
    return { ...task.summary };
  }

  /** 确认后结束分析会话：一个单元在本任务开发，多个单元汇总子任务，零单元完成。 */
  private async finishRequirementAnalysis(task: TaskState): Promise<void> {
    const epoch = ++task.controlEpoch;
    const inMain = isMainTaskDelivery(task.summary);
    this.removeFromQueue(task.summary.id);
    const hasDeliveries = (task.summary.requirement_graph?.repositories.length ?? 0) > 0;
    task.summary.status = inMain ? "waiting_for_human" : hasDeliveries ? "coordinating" : "completed";
    if (hasDeliveries) delete task.summary.completed_at;
    else task.summary.completed_at = new Date().toISOString();
    task.mission = undefined;
    this.persist(task);
    const driver = task.driver;
    const container = task.container;
    const prepushAbort = task.prepushAbort;
    prepushAbort?.abort();
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    if (task.prepushAbort === prepushAbort) task.prepushAbort = undefined;
    if (task.controlEpoch !== epoch) return;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      if (inMain) task.summary.status = "failed";
      task.summary.detail = (inMain ? "分析资源尚未释放，未启动开发，请重试方案确认：" : hasDeliveries
        ? "子任务已开始推进，但分析资源未能确认释放："
        : "分析结论已确认且无需修改代码，但分析资源未能确认释放：")
        + failures.join("；") + "。服务重启会按 ownership 再清扫";
      this.persist(task);
      this.options.log?.(`任务 ${task.summary.id} 分析收口清理不完整: `
        + failures.join(" | "));
    }
    if (inMain) {
      if (failures.length) return;
      const previous = { summary: task.summary, cwd: task.cwd, mission: task.mission,
        resume: task.resume, progressCache: task.progressCache, pendingResume: task.pendingResume };
      try {
        prepareMainTaskDelivery(task, this.options.dataDir);
        this.persist(task, true);
      } catch (cause) { Object.assign(task, previous); throw cause; }
      if (!this.queue.includes(task.summary.id)) this.queue.push(task.summary.id);
    } else this.reconcileRequirementParent(task);
    this.bypass(undefined, "任务泵", this.pump());
  }

  private normalizeDecisionSubmission(
    waiting: WaitingRecord,
    input: DecisionSubmission,
  ): {
    decision: string;
    answers: Record<string, string>;
    notes?: string;
  } {
    const questions = (((waiting.question as {
      questions?: unknown;
    } | undefined)?.questions) ?? []) as Array<{
      question?: unknown;
      options?: unknown;
    }>;
    const menu = questions.map((item) => ({
      question: String(item?.question ?? "").trim(),
      options: Array.isArray(item?.options)
        ? item.options.map(String).map((value) => value.trim()).filter(Boolean)
        : [],
    })).filter((item) => item.question);
    // 升级前已打开的卡仍可提交旧确认串；仅在卡片提供规范确认选项时兼容。
    const matchesOption = (options: string[], answer: string) => options.includes(answer)
      || (options.includes(REQUIREMENT_GRAPH_APPROVE) && confirmsRequirementGraph(answer));
    const usesStructuredContract = input.selected_options !== undefined
      || input.free_responses !== undefined
      || input.comment !== undefined;
    const answers: Record<string, string> = {};
    const notes = [input.comment, input.notes]
      .map((value) => String(value ?? "").trim()).filter(Boolean);

    if (usesStructuredContract) {
      const selected = input.selected_options ?? {};
      const free = input.free_responses ?? {};
      const known = new Set(menu.map((item) => item.question));
      for (const key of [...Object.keys(selected), ...Object.keys(free)]) {
        if (!known.has(key)) {
          throw new TaskControlError(`决定包含未知问题：${key}`);
        }
      }
      for (const item of menu) {
        const selectedOption = String(selected[item.question] ?? "").trim();
        const freeResponse = String(free[item.question] ?? "").trim();
        const optional = /可忽略|若上题|如无|可跳过|可不填/.test(item.question);
        if (item.options.length) {
          if (selectedOption) {
            if (!matchesOption(item.options, selectedOption)) {
              throw new TaskControlError(
                `“${item.question}”必须选择卡片中的结构化选项，不能把自由说明当作流程分支`,
              );
            }
            answers[item.question] = selectedOption;
          }
          if (freeResponse) {
            if (selectedOption) {
              notes.push(`问题“${item.question}”的补充说明：${freeResponse}`);
            } else {
              // 模型给出的选项可能不完备。强迫用户任选一个再补充会把
              // 错误分支写进内核收据；没有选项时，自由回复就是主答案。
              answers[item.question] = freeResponse;
            }
          }
          if (!selectedOption && !freeResponse && !optional) {
            throw new TaskControlError(
              `“${item.question}”尚未选择选项或填写自定义答复`);
          }
        } else {
          if (selectedOption) {
            throw new TaskControlError(`“${item.question}”是开放题，不接受结构化选项`);
          }
          if (freeResponse) answers[item.question] = freeResponse;
          if (!freeResponse && !optional) {
            throw new TaskControlError(`“${item.question}”尚未填写开放题答案`);
          }
        }
      }
    } else if (input.answers && Object.keys(input.answers).length) {
      Object.assign(answers, input.answers);
      for (const item of menu) {
        const value = String(answers[item.question] ?? "").trim();
        if (value && item.options.length && !matchesOption(item.options, value)) {
          throw new TaskControlError(
            `“${item.question}”必须选择卡片中的结构化选项；自由说明请使用 comment`,
          );
        }
      }
    }

    let decision = String(
      input.decision ?? Object.values(answers).join("\n"),
    ).trim();
    if (!usesStructuredContract && menu.length > 1) {
      for (const item of menu) {
        if (/可忽略|若上题|如无|可跳过|可不填/.test(item.question)) continue;
        if (!String(answers[item.question] ?? "").trim()) {
          throw new TaskControlError(`“${item.question}”尚未填写决定`);
        }
      }
    }
    if (!Object.keys(answers).length && decision && menu.length === 1
        && menu[0].options.length && !matchesOption(menu[0].options, decision)) {
      throw new TaskControlError(
        `“${menu[0].question}”必须选择卡片中的结构化选项；自由说明请使用 comment`,
      );
    }
    if (!decision && Object.keys(answers).length) {
      decision = Object.values(answers).join("\n").trim();
    }
    if (!decision) {
      throw new NotFoundError(
        "决定不能为空：选择题请提交 selected_options，开放题请提交 free_responses",
      );
    }
    return {
      decision,
      answers,
      notes: notes.length ? notes.join("\n\n") : undefined,
    };
  }

  private unresolvedAnnotations(task: TaskState): Annotation[] {
    return blockingAnnotations(
      this.annotations(task).visible(),
      task.summary.luban_account,
    );
  }

  private pushConfirmationAccepted(waiting: WaitingRecord): boolean {
    const answers = Object.values(waiting.answers ?? {});
    // 已发出的卡片文案是历史契约；只认明确确认原文，绝不做包含匹配。
    return (answers.length ? answers : [waiting.decision]).every((answer) =>
      answer === PUSH_CONFIRM_ACCEPT || answer === "确认按清单推送" || answer === "确认推送并进入检视");
  }

  private markResolvedDecisionAnnotations(
    task: TaskState,
    waiting: WaitingRecord,
  ): void {
    try {
      const drafts = this.annotations(task).pendingReview();
      const durableIds = waiting.continuation?.annotation_ids;
      const ids = Array.isArray(durableIds)
        ? durableIds.map(String)
        // 新记录明确没带 annotation_ids 就是真的没选，不能因为自由说明
        // 恰好重复了批注原文而误标。只有修复前的旧账才走正文反推。
        : waiting.request_digest
          ? []
          // 兼容修复前已 resolved、却死在 markSent 前的记录。旧账没有
          // id，只认 resolved_at 之前且“要求+原文”都逐字进入决定 notes
          // 的草稿；后来新圈的意见绝不能被旧决定顺手标成已发送。
          : drafts.filter((item) => item.created_at <= waiting.resolved_at
            && waiting.notes.includes(item.note)
            && waiting.notes.includes(item.anchor)).map((item) => item.id);
      if (!ids.length) return;
      const versions = waiting.continuation?.annotation_versions;
      const history = Array.isArray(versions) ? [] : this.annotations(task).history();
      const pending = drafts.filter((item) => {
        if (!ids.includes(item.id)) return false;
        if (Array.isArray(versions)) {
          // 同一个 id 会在退回、改字后继续使用；旧决定只授权当时那版正文。
          return versions.some((version) => version?.id === item.id
            && version.revision === (item.rework ?? 0) && version.note === item.note);
        }
        // 在途旧决定没有版本快照，只补从未完成的投影。决定之后已有送达、
        // 退回、改字或系统重置记录，就不能再拿它覆盖后来的人工作业。
        return !history.some((operation) => {
          if (operation.op === "sent") return operation.ids.includes(item.id)
            && operation.at >= waiting.resolved_at;
          return (operation.op === "edit" || operation.op === "reopen"
            || operation.op === "delivery_reset" || operation.op === "clarified")
            && operation.id === item.id && operation.at >= waiting.resolved_at;
        });
      }).map((item) => item.id);
      for (const id of pending) {
        const item = drafts.find(item => item.id === id)!;
        if (pendingReviewAnnotation(item)) this.annotations(task).assignToAgent(id, waiting.decided_by ?? task.summary.luban_account ?? "本地用户");
      }
      if (pending.length) this.annotations(task).markSent(pending, "decision", waiting.decided_by);
    } catch (error) {
      // waiting.json 已经把决定、批注 id 和完整原文一起落袋。批注账只是
      // 展示投影，写坏不能把已经生效的决定伪装成“提交失败”；重启或
      // 同请求重放会继续尝试对账。
      this.options.log?.(`任务 ${task.summary.id} 批注送达状态暂未落盘: ${String(error)}`);
    }
  }

  /** 决定事实和批注展示是两个 append-only 账。若进程死在两次写之间，
   * 任务可能已经继续、summary.waiting 也已清空；因此不能只在“当前卡”
   * 恢复时对账。任务恢复和批注读侧都用全部 resolved 收据补投影。 */
  private reconcileResolvedDecisionAnnotations(task: TaskState): void {
    try {
      if (!this.annotations(task).pendingReview().length) return;
      for (const waiting of task.humanGate.resolved()) {
        this.markResolvedDecisionAnnotations(task, waiting);
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 批注送达投影暂无法对账: ${String(error)}`);
    }
  }

  /** push 卡没有挂起的 Agent 工具调用，必须由宿主消费 resolved 收据。
   * 这一个函数同时服务正常提交、完全相同的网络重放和崩溃恢复。 */
  private finishResolvedPushConfirmation(
    task: TaskState,
    waiting: WaitingRecord,
  ): void {
    // 返工先登记正式反馈批次，而且必须在消费卡、改任何内存态之前。
    // feedback-open 幂等；失败时卡和 Cloud 状态原样保留，可安全重放。
    if (!this.pushConfirmationAccepted(waiting)) {
      this.openFeedbackBatch(task, "push_confirmation", [{
        id: `push-confirmation:${waiting.waiting_id}`,
        source: "push_confirmation",
        source_id: waiting.waiting_id,
        source_revision: 0,
        kind: "delivery_scope",
        summary: waiting.notes.trim().slice(0, 1000)
          || "用户要求调整本轮待推送文件",
        verification: waiting.decided_by
          ?? task.summary.luban_account ?? "owner",
      }]);
    }
    task.summary.waiting = undefined;
    // 人解决这张卡(不论通过还是返工)就是"看过了这个 HEAD":钉住它,
    // 复检轮的"这次修改"从这里起算(MFC-035)。
    const reviewedHead = task.summary.delivery?.push_review?.head_sha;
    if (reviewedHead) {
      task.summary.delivery = { ...task.summary.delivery, last_reviewed_head: reviewedHead };
    }
    if (task.summary.delivery) delete task.summary.delivery.push_review;
    if (this.pushConfirmationAccepted(waiting)) {
      this.resolveFeedbackRecords(task,
        (record) => record.source === "push_confirmation",
        "closed", "任务责任人已确认本轮待推送内容");
      const loop = task.summary.delivery?.loop;
      if (loop?.workspace_review_recheck_required) {
        loop.workspace_review_recheck_required = false;
        loop.workspace_review_annotation_ids = undefined;
      }
      task.summary.status = "verifying";
      task.summary.detail = "已确认推送，继续交付";
      this.persist(task);
      this.bypass(task, "push 确认续推",
        this.tryDeliver(task, task.controlEpoch));
      return;
    }
    const review = [waiting.decision, ...Object.values(waiting.answers ?? {}), waiting.notes].filter(Boolean).join("\n").trim();
    const annotationIds = Array.isArray(waiting.continuation?.annotation_ids)
      ? waiting.continuation.annotation_ids.map(String) : [];
    const annotations = this.annotations(task).list().filter((item) =>
      annotationIds.includes(item.id));
    // 即使只有补充说明、没有逐行批注，也要回到同一张总检卡；有逐行
    // 批注时则必须由各自作者逐条裁决，责任人的“继续”不能代点通过。
    this.rememberWorkspaceReview(task, annotations);
    // push 确认卡上的整体返工没有逐行批注，也必须进入当前反馈批次。
    // rememberWorkspaceReview 还服务“意见并入正在运行的会话”，不能在
    // helper 内无条件改状态；这里旧会话已收口，明确切到 repairing 投影。
    if (task.summary.delivery?.loop) {
      task.summary.delivery.loop.state = "repairing";
      task.summary.delivery.loop.round = 0;
    }
    // 内核已在本函数入口进入 feedback_triage；此刻作废云侧旧 SHA 证据。
    if (task.summary.delivery) {
      delete task.summary.delivery.prepush;
      delete task.summary.delivery.pipeline;
      delete task.summary.delivery.checks;
      delete task.summary.delivery.sha;
      delete task.summary.delivery.git_push;
      delete task.summary.delivery.stalled;
      delete task.summary.delivery.stall_class;
      delete task.summary.delivery.evidence_gap;
      delete task.summary.delivery.verify_deadline;
      delete task.summary.delivery.skipped;
    }
    this.enqueueRepair(task, [
      "用户要求调整本次推送，按以下意见继续修复：",
      review,
      "文件勾选机制已取消，不读取历史清单来限制修复或要求扩大范围；用户明确的修改要求仍须遵守。",
      "完成后继续现有推送与流水线验证。",
      // 回执契约必须与 post-MR review 同一份:少了它,Agent 改完代码
      // 也不知道要写 local-receipts.json,收口时被回执门禁如实拦下,
      // 形成"改了却过不去"的死锁(e2e-picky-20260830 双复现,MFC-002)。
      this.reviewReceiptInstructionsFor(task, annotations),
    ].filter(Boolean).join("\n"), "按检视意见继续修改");
  }

  /** 拍板类决定只认主责任人。受邀参与讨论的人(协作者、逐仓责任人)能回答
   * 分析期的澄清题,但"进不进分析""拆不拆""确认并生成任务"改的是任务
   * 的形状——讨论开放,拍板不开放(2026-09-04 用户拍板)。管理员替人拍板
   * 走 HTTP 层的 canOperate,这里只看提交者是不是责任人。 */
  private assertOwnerDecides(
    task: TaskState,
    actor: string | undefined,
    what: string,
  ): void {
    const owner = task.summary.luban_account;
    if (actor && owner && actor !== owner) {
      throw new TaskControlError(`只有主责任人 ${owner} 可以${what}`);
    }
  }

  /** 拍板类卡:只认责任人,受邀参与人只读、也不通知。 */
  private ownerOnlyWaiting(waiting: { step: string }): boolean {
    return waiting.step === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP
      || waiting.step === CLOUD_SPLIT_PROPOSAL_STEP
      || waiting.step === MR_DESCRIPTION_STEP;
  }

  /** 分析期能回答问题卡的人:协作者 + 逐仓责任人,去掉责任人自己。
   * 与 server.ts 的 canCollaborate 同一口径——那边放行 HTTP,这边决定
   * 通知谁。分析确认后 stage 变了,自然没人了。 */
  private discussionParticipants(task: TaskState): string[] {
    const graph = task.summary.requirement_graph;
    if (graph?.stage !== "analysis") return [];
    const people = new Set<string>([
      ...(task.summary.collaborators ?? []),
      ...graph.repositories.flatMap((repository) =>
        repository.assignee ? [repository.assignee] : []),
    ]);
    if (task.summary.luban_account) people.delete(task.summary.luban_account);
    return [...people];
  }

  /** 分析清单里的仓库名,按下单顺序对应机读序号 repo-1、repo-2…
   * (与 create() 建图节点的规则一致);名字取仓库地址末段。 */
  private analysisRepositoryNames(
    task: TaskState,
  ): Array<{ id: string; name: string }> {
    return (task.summary.repositories ?? []).map((url, index) => ({
      id: `repo-${index + 1}`,
      name: basename(url).replace(/\.git$/, "") || `仓库 ${index + 1}`,
    }));
  }

  private continueAfterMrDescription(task: TaskState, detail: string): void {
    task.summary.waiting = undefined;
    task.summary.status = "verifying";
    task.summary.detail = detail;
    this.persist(task);
    const pendingHost = new TaskHostLedger(task.summary).pending();
    this.bypass(task, "MR 描述卡后继续交付", pendingHost?.input.action === "create_mr"
      ? this.finishHostAction(task)
      : this.tryDeliver(task, task.controlEpoch));
  }

  private async resumeResolvedDecision(
    task: TaskState,
    waiting: WaitingRecord,
  ): Promise<void> {
    // 正常卡和 push 卡都可能死在 waiting.json 已落袋、批注投影尚未
    // markSent 的窗口。恢复动作首先对账，不能只让 Agent 收到正文却在
    // 页面继续显示“待提交”。失败会由 helper 记日志并保持流程可继续。
    if (waiting.step === MR_DESCRIPTION_STEP) {
      this.continueAfterMrDescription(task, "AR 描述已保存，继续创建 MR");
      return;
    }
    if (waiting.step === HOST_PUSH_CONFIRM_STEP) {
      this.finishHostPushDecision(task, waiting);
      return;
    }
    this.markResolvedDecisionAnnotations(task, waiting);
    if (this.isRequirementAnalysis(task) && [...Object.values(waiting.answers ?? {}), waiting.decision]
        .some(answer => confirmsRequirementGraph(answer ?? ""))) {
      this.createRepositoryDeliveries(task);
      if (task.driver) this.bypass(task, "分析确认恢复", task.driver.resumeWithDecision(waiting).then(() => undefined));
      await this.finishRequirementAnalysis(task);
      return;
    }
    if (waiting.step === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP) {
      this.finishRequirementAnalysisEntryDecision(task, waiting);
      return;
    }
    if (waiting.step === CLOUD_SPLIT_PROPOSAL_STEP) {
      await this.applySplitProposalDecision(task, waiting);
      return;
    }
    if (waiting.step === CLOUD_PUSH_CONFIRM_STEP) {
      try {
        this.finishResolvedPushConfirmation(task, waiting);
      } catch (error) {
        task.summary.waiting = undefined;
        task.summary.status = "failed";
        task.summary.detail = error instanceof Error ? error.message : String(error);
        this.persist(task);
      }
      return;
    }
    task.summary.waiting = undefined;
    if (task.driver) {
      task.summary.status = "running";
      task.summary.detail = "决定已收到，Agent 正在继续处理";
      this.persist(task);
      this.bypass(task, "已决待办自愈续跑",
        this.settle(task, task.driver.resumeWithDecision(waiting)));
      return;
    }
    task.pendingResume = waiting;
    task.resume = true;
    task.summary.status = "queued";
    task.summary.detail = "检测到已完成的决定，等待重建会话续跑";
    this.persist(task);
    if (!this.queue.includes(task.summary.id)) this.queue.push(task.summary.id);
    this.bypass(undefined, "任务泵", this.pump());
  }

  private resolvedRequestMatches(
    waiting: WaitingRecord,
    input: DecisionSubmission,
    digest: string,
  ): boolean {
    if (waiting.request_digest) return waiting.request_digest === digest;
    // 兼容这次修复前已经落袋的决定：旧记录没有请求指纹，只能用结构
    // 化答案 + 补充说明对拍。不能仅看 state_version（每张卡都从 1
    // 开始），也不能把不同的后到决定误当重试吞掉。
    try {
      const normalized = this.normalizeDecisionSubmission(waiting, input);
      const answers = orderedRecord(normalized.answers) ?? {};
      const recorded = orderedRecord(waiting.answers) ?? {};
      if (normalized.decision !== waiting.decision
          || JSON.stringify(answers) !== JSON.stringify(recorded)) {
        return false;
      }
      return !normalized.notes || waiting.notes.includes(normalized.notes);
    } catch {
      return false;
    }
  }

  /** 所有入口的决定都在这里收口。异步读取 diff 发生在 HumanGate 落锁
   * 之前，所以需要一把逐任务锁；否则一次双击会启动两条相同请求，
   * 后一条只看到“先到决定完成”，把已经成功伪装成失败。 */
  async decide(
    id: string,
    input: DecisionSubmission,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const waitingId = input.waiting_id
      ?? task.summary.waiting?.waiting_id;
    if (!waitingId) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    const digest = decisionRequestDigest(waitingId, input);
    const active = this.activeDecisions.get(id);
    if (active) {
      if (active.waitingId === waitingId && active.digest === digest) {
        return active.promise;
      }
      throw new StateConflictError(
        `任务状态已变化:待办 ${waitingId} 已有另一份决定正在提交`);
    }
    // resolved 分叉自愈也必须进入同一把锁：若两个网络重试同时命中
    // waiting.json 已决、task.json 未推进的窗口，仍只能恢复一次。
    const promise = this.decideUnderLock(
      id, input, waitingId, digest);
    this.activeDecisions.set(id, { waitingId, digest, promise });
    try {
      return await promise;
    } finally {
      const latest = this.activeDecisions.get(id);
      if (latest?.promise === promise) this.activeDecisions.delete(id);
    }
  }

  private async decideUnderLock(
    id: string,
    input: DecisionSubmission,
    waitingId: string,
    digest: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id)!;
    const authoritative = task.humanGate.get(waitingId);
    if (authoritative?.status === "resolved") {
      if (!this.resolvedRequestMatches(authoritative, input, digest)) {
        throw new StateConflictError(
          `任务状态已变化:待办 ${waitingId} 已由先到决定完成`);
      }
      if (task.summary.waiting?.waiting_id === waitingId) {
        await this.resumeResolvedDecision(task, authoritative);
      }
      return { ...task.summary };
    }
    if (authoritative?.status === "superseded") {
      throw new StateConflictError(`任务状态已变化:待办 ${waitingId} 已失效`);
    }
    const current = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !current) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    if (current.waiting_id !== waitingId) {
      throw new StateConflictError(
        `任务状态已变化:当前待办是 ${current.waiting_id},不是 ${waitingId}`);
    }
    return this.decideOnce(id, input, waitingId, digest);
  }

  private async decideOnce(
    id: string,
    input: DecisionSubmission,
    waitingId: string,
    requestDigest: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id)!;
    let waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    if (waiting.waiting_id !== waitingId) {
      throw new StateConflictError(
        `任务状态已变化:当前待办是 ${waiting.waiting_id},不是 ${waitingId}`);
    }
    const reviewContract = reviewDecisionContract(requirementDecisionContract(waiting.question, this.isRequirementAnalysis(task)),
      waiting.step.startsWith("cloud_") || waiting.step === HOST_PUSH_CONFIRM_STEP ? []
        : stepChoiceEffects(this.options.host?.kernelRoot, this.reviewContractStep(task, waiting)));
    waiting = { ...waiting, question: reviewContract.question };
    const normalized = this.normalizeDecisionSubmission(waiting, input);
    const { answers, decision } = normalized;
    if (waiting.step === MR_DESCRIPTION_STEP) {
      this.assertOwnerDecides(task, input.actor, "填写 AR 描述");
      const description = String(Object.values(answers)[0] ?? decision).trim();
      if (!description || /[\r\n]/.test(description)) {
        throw new TaskControlError("请填写 AR 单上的准确描述，使用一行文字作为 MR 标题");
      }
      const resolved = task.humanGate.resolve(waiting.waiting_id, {
        stateVersion: input.state_version, decision: description,
        answers: Object.keys(answers).length ? answers : undefined,
        notes: normalized.notes, requestDigest, decidedBy: input.actor,
      });
      await this.resumeResolvedDecision(task, resolved);
      return { ...task.summary };
    }
    if (waiting.step === CLOUD_SPLIT_PROPOSAL_STEP) {
      this.assertOwnerDecides(task, input.actor, "决定拆不拆");
      const submitted = [...Object.values(answers), decision];
      if (!submitted.includes(SPLIT_PROPOSAL_ACCEPT)
          && !submitted.includes(SPLIT_PROPOSAL_DECLINE)) {
        throw new TaskControlError(
          `请选择「${SPLIT_PROPOSAL_ACCEPT}」或「${SPLIT_PROPOSAL_DECLINE}」`);
      }
      const resolved = task.humanGate.resolve(waiting.waiting_id, {
        stateVersion: input.state_version,
        decision,
        answers: Object.keys(answers).length ? answers : undefined,
        notes: normalized.notes,
        requestDigest,
        decidedBy: input.actor,
      });
      await this.applySplitProposalDecision(task, resolved);
      return { ...task.summary };
    }
    if (waiting.step === HOST_PUSH_CONFIRM_STEP) {
      this.assertOwnerDecides(task, input.actor, "确认本次推送");
      const resolved = task.humanGate.resolve(waiting.waiting_id, {
        stateVersion: input.state_version, decision,
        answers: Object.keys(answers).length ? answers : undefined,
        notes: normalized.notes, requestDigest, decidedBy: input.actor,
      });
      this.finishHostPushDecision(task, resolved);
      return { ...task.summary };
    }
    if (waiting.step === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP) {
      this.assertOwnerDecides(task, input.actor, "确认进入需求分析");
      if (task.summary.requirement_revision?.state === "running") {
        throw new TaskControlError("Agent 正在修改需求文档，请完成后再确认");
      }
      // 普通交付不让路人草稿暗中锁单；需求确认则是已建立的多人共同
      // 检视现场，任何可见草稿或已提交意见都不能被责任人越过。
      const unresolved = this.annotations(task).visible().filter((item) =>
        item.status === "draft" || item.status === "sent");
      if (unresolved.length) {
        const drafts = unresolved.filter((item) => item.status === "draft").length;
        const submitted = unresolved.length - drafts;
        throw new TaskControlError([
          drafts ? `${drafts} 条意见尚未提交给 Agent` : "",
          submitted ? `${submitted} 条意见仍待责任人逐条处置` : "",
          "请先完成检视闭环，再进入需求分析",
        ].filter(Boolean).join("；"));
      }
      const submitted = [...Object.values(answers), decision];
      if (!submitted.includes(REQUIREMENT_ANALYSIS_ACCEPT)) {
        throw new TaskControlError("请使用“需求已确认，进入需求分析”按钮确认");
      }
      const resolved = task.humanGate.resolve(waiting.waiting_id, {
        stateVersion: input.state_version,
        decision,
        answers: Object.keys(answers).length ? answers : undefined,
        notes: normalized.notes,
        requestDigest,
        decidedBy: input.actor,
      });
      this.finishRequirementAnalysisEntryDecision(task, resolved);
      return { ...task.summary };
    }
    // 多仓确认的顺序纪律:图的体检放在决定落袋**之前**(图不完整就报
    // 错,决定不消费,agent 继续等,用户看得到原因);建任务放在落袋
    // **之后**(乐观锁 409 时不许先把子任务生出来)。举卡、展示与提交
    // 共用平台确认选项；不把备注或自由答复中提及确认当作授权。
    const confirmingGraph = this.isRequirementAnalysis(task)
      && Object.values(answers).concat(decision).some((answer) =>
        confirmsRequirementGraph(answer));
    if ((input.repository_assignees || input.repository_tickets) && !confirmingGraph) {
      throw new NotFoundError("模块责任人与 AR 单号只能随拆分方案确认提交");
    }
    if (confirmingGraph) {
      // 受邀参与人能答澄清题、能选"需要修改",但拆单这一下改的是任务的
      // 形状,谁下的单谁拍板。HTTP 层只挡到"是否参与讨论",这里是硬闸。
      this.assertOwnerDecides(task, input.actor, "确认拆分方案");
      this.sealRequirementGraphReview(task, waiting);
      this.requirementGraphPlan(task, input.repository_assignees,
        input.repository_tickets);
      if (input.repository_assignees) {
        if (waiting.state_version !== input.state_version
            || waiting.status !== "waiting") {
          throw new StateConflictError(
            `任务状态已变化:待办 ${waiting.waiting_id} 版本不匹配`);
        }
        this.assignRequirementRepositories(id, input.repository_assignees,
          input.repository_tickets);
      }
    }
    const updatesRepositorySkills =
      input.repository_skill_catalog_token !== undefined
      || input.selected_repository_skill_ids !== undefined;
    if (updatesRepositorySkills) {
      if (!this.isRequirementAnalysis(task)) {
        throw new NotFoundError("只有跨仓方案检视可以在决定时调整仓内 Skill");
      }
      // 只允许在图已经可供检视、且 HumanGate 仍是当前版本时换选择。
      // 先验版本检查避免陈旧页面消费 catalog token、覆盖较新的选择；
      // 本方法到 humanGate.resolve 之间没有 await，单进程内不会被另一
      // 个决定插入。
      if (waiting.state_version !== input.state_version
          || waiting.status !== "waiting") {
        throw new StateConflictError(`任务状态已变化:待办 ${waiting.waiting_id} 版本不匹配`);
      }
      this.requirementGraphPlan(task);
      const resources = this.selectedResourcesFromCatalog({
        catalogToken: input.repository_skill_catalog_token,
        selectedSkillIds: input.selected_repository_skill_ids,
        repositories: task.summary.repositories ?? [],
        baseline: task.summary.baseline,
        account: task.summary.luban_account,
        preserveSkillsForErroredRepositories:
          task.summary.repository_skills ?? [],
      });
      task.summary.repository_skills = resources.skills;
      // 必须先于 humanGate.resolve/createRepositoryDeliveries 落盘：确认
      // 后父会话会立刻收口，重启也只能从 task.json 恢复这份选择。
      this.persist(task);
    }
    // 待修改批注与“确认关闭检视”是矛盾事实。结构化返工从内核
    // next → clear_hint/allow_source_edit 推导；Spec/Story 等原步修改则
    // 以 confirmation_answers 识别关闭答案。Cloud 不认识任何步骤名。
    const effects = reviewContract.effects;
    const closingEffects = effects.filter((effect) => effect.closesFeedback);
    const submitted = Object.keys(answers).length
      ? Object.values(answers) : [decision];
    const closesFeedback = closingEffects.length > 0
      && submitted.some((answer) => closingEffects.some((effect) =>
        matchesStepChoice(effect, answer)));
    // push 前确认卡是云端原生步骤(不在内核流程里,effects 为空),
    // 关闭语义由选项原文判定;确认视同关闭检视——未闭环批注同样拦。
    const pushConfirmCard = waiting.step === CLOUD_PUSH_CONFIRM_STEP;
    const confirmingPush = pushConfirmCard
      && this.pushConfirmationAccepted({ ...waiting, answers, decision });
    if (pushConfirmCard || closesFeedback) this.assertOwnerDecides(task, input.actor, "决定最终提交或检视通过");
    const handlesFeedback = effects.some((effect) => effect.handlesFeedback
      && submitted.some((answer) => matchesStepChoice(effect, answer)))
      // 云端 push 卡不在内核 effect 契约里；除明确确认外都意味着进入
      // 新修复会话。这里必须由服务端认定为“处理意见”，不能依赖网页
      // 携带 annotation_ids——小鲁班回复只有选项和说明。
      || (pushConfirmCard && !confirmingPush)
      || submitted.some(explicitlyRequestsReviewFeedback);
    if (handlesFeedback) this.assertOwnerDecides(task, input.actor, "随决定送出检视意见");
    // MR 修复轮(review_repair)的意见只能在最终推送确认卡上闭环:逐条回执
    // 要等会话本轮结束才登记,作者中途点不了通过。内核中途的确认卡若也拿
    // 它们拦"关闭",责任人确认不了、作者闭不了环,只剩"需要调整"能点
    // (内网实锤 2026-09-04:9 条意见、Agent 说全闭环、卡上过不去)。所以
    // 拦截只放在人能闭环的地方——push 确认卡仍是硬闸,中途卡不计它们。
    const responsibilityDrafts = (input.actor ?? task.summary.luban_account)
        === (task.summary.luban_account ?? "本地用户")
      ? this.annotations(task).pendingReview().filter(item => pendingReviewAnnotation(item)
        && !(this.hasPublishedOverallStory(task)
          && item.artifact === OVERALL_STORY_ARTIFACT)) : [];
    const unresolved = [...new Map([
      ...this.unresolvedAnnotations(task).filter((item) =>
        pushConfirmCard || item.sent_via !== "review_repair"),
      ...responsibilityDrafts,
    ].map(item => [item.id, item])).values()];
    if (unresolved.length && (closesFeedback || confirmingPush)) {
      const menuQuestions = Array.isArray(waiting.question?.questions)
        ? waiting.question.questions as Array<{ options?: string[] }> : [];
      const menuOptions = menuQuestions
        .flatMap((question) => question.options ?? []);
      const handled = effects.filter((effect) => effect.handlesFeedback)
        .flatMap((effect) => effect.answers)
        .find((answer) => menuOptions.includes(answer));
      const nonClosing = menuOptions.filter((option) =>
        !closingEffects.some((effect) => matchesStepChoice(effect, option)));
      const recommended = handled
        ?? nonClosing.find(isReviewAdjustmentAnswer)
        ?? nonClosing[0]
        ?? "需要调整";
      // 必须在整理提交、消费待办之前拒绝。旧顺序先机械改 commit 再报
      // “意见未闭环”，责任人一次误点就会让现场变化、卡片变旧，形成
      // 明明后来全点通过却仍提交不了的假死。
      throw new TaskControlError(
        `当前仍有 ${unresolved.length} 条检视意见未闭环，不能继续放行。`
        + `责任人的“继续提交”不能代替逐条处置。建议选择“${recommended}”`
        + "继续处理；若已经修好，请由当前任务责任人逐条处置。",
      );
    }
    // 责任人明确选择按检视意见修复时，可统一转交待处理草稿。
    // 其他答复仍只携带自己的草稿与已由责任人排队的意见。
    // 无 actor 的旧回调按任务责任人收口；旧单也没有责任人时才保留
    // 原单用户兼容语义。
    const draftAuthor = input.actor ?? task.summary.luban_account;
    const allDrafts = this.annotations(task).pendingReview();
    const reviewDrafts = handlesFeedback && draftAuthor === (task.summary.luban_account ?? "本地用户")
      ? allDrafts.filter(item => pendingReviewAnnotation(item)
        && !(this.hasPublishedOverallStory(task) && item.artifact === OVERALL_STORY_ARTIFACT)) : [];
    const ownDrafts = draftAuthor
      ? allDrafts.filter((item) => item.author === draftAuthor) : allDrafts;
    const drafts = ownDrafts.filter(pendingReviewAnnotation);
    const deliverableUnresolved = unresolved.filter((item) =>
      !item.owner_reply && !item.resolution
      && (item.status !== "draft" || !draftAuthor || item.author === draftAuthor));
    // 等待期间经 queued_decision 提交的意见:状态是 sent,但正文还没
    // 送到过任何 Agent——随这次决定一并送达,送完转正常 decision 账。
    const queued = this.annotations(task).list().filter((item) =>
      item.status === "sent" && item.sent_via === "queued_decision"
      && item.response?.revision !== (item.rework ?? 0));
    const localReviewRound = task.summary.delivery?.loop?.kind === "review"
      && task.summary.delivery.loop.review_source === "workspace"
      && task.summary.delivery.loop.state === "repairing";
    const picked = handlesFeedback
      // 普通检视仍回到同一会话，sent 已经在上下文里，不重复送；push
      // 返工会开一只全新会话，必须把 draft + sent 的全部未闭环意见
      // 都带过去，否则“提前主动送达”的意见会断在上一只 Agent 里。
      ? [...new Map([...(pushConfirmCard ? deliverableUnresolved : [...queued, ...drafts]), ...reviewDrafts].map(item => [item.id, item])).values()]
        // 批量提交明确带了 ID 时，只发送这批新意见。此前已提交的意见仍
        // 随会话继续，不能把另一份材料尚未提交的草稿也悄悄送出。
        .filter(item => !input.annotation_ids?.length || input.annotation_ids.includes(item.id)
          || (item.status === "sent" && item.sent_via !== "owner_pending"))
      // 本地 review 轮里若 Agent 因真实歧义举卡，用户在等待期间新圈的
      // 批注随这张卡一并回注；不能让人答完歧义后还要再点一次提交。
      : localReviewRound ? [...queued, ...drafts]
      : input.annotation_ids?.length
        ? this.pickDecisionDrafts(task, input.annotation_ids, draftAuthor)
        : queued;
    // 批注与自由说明都进 notes，不污染内核用于 choice receipt 的选项。
    const notes = [
      normalized.notes,
      crossRepositoryUpdateContext(task),
      picked.length ? renderAnnotations(picked, this.ticketOf(task)) : undefined,
      picked.length ? "以上是责任人随本次决定送出的待处理意见，请逐条处理并答复；此前联合检视的 CLEAR 不代表这些意见已解决。" : undefined,
      picked.length
        ? requirementAnnotationInstructions(picked, `.mae-flow-work/${task.summary.ticket ?? task.summary.id}/story.md`, this.isRequirementAnalysis(task)) : undefined,
      // push 返工的使命里已经带了同一份回执契约,不重复。
      picked.length && !pushConfirmCard
        ? this.reviewReceiptInstructionsFor(task, picked) : undefined,
      // 等待期间 @ 引用的知识随本次决定送达(版本在引用时已固定)。
      ...(task.pendingDecisionKnowledge ?? []),
    ].filter(Boolean).join("\n\n") || undefined;
    const resolved = task.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      question: waiting.question,
      decision,
      answers: Object.keys(answers).length ? answers : undefined,
      notes,
      requestDigest,
      decidedBy: input.actor,
      continuation: {
        ...(picked.length
          ? { annotation_ids: picked.map((item) => item.id),
              annotation_versions: picked.map((item) => ({
                id: item.id, revision: item.rework ?? 0, note: item.note,
              })) } : {}),
      },
    });
    // 引用已随本次决定送达;不清会在下一张决定卡重复注入同一份正文。
    task.pendingDecisionKnowledge = undefined;
    // 决定已经落袋(waiting.json 写完),批注才算送出去。
    this.markResolvedDecisionAnnotations(task, resolved);
    if (picked.length) this.ensureReviewsDir(task);
    // 澄清卡的答复落到被追问的意见上:回执清空,Agent 按答复继续处理。
    this.recordClarificationAnswers(task, waiting, resolved, input.actor);
    this.refreshOwnerInputs(task);
    // 等待期入队的意见随这次决定完成送达:账目从 queued_decision 转
    // "decision",下一张卡不再重复携带同一份正文。
    const queuedDelivered = picked
      .filter((item) => item.sent_via === "queued_decision")
      .map((item) => item.id);
    if (queuedDelivered.length) {
      this.annotations(task).markSent(queuedDelivered, "decision");
    }
    // 决定生效之后才生子任务(体检在落袋前做过,这里不会因图不齐半途
    // 而废)。建任务失败不回滚决定——决定是用户的事实;失败原因写进
    // detail,面板确认按钮随时可重试(可重入)。
    if (confirmingGraph) {
      try {
        this.createRepositoryDeliveries(task);
        // 拆单成功=父分析会话使命结束:确认即硬收口，不等模型自觉
        // 写完——省下并发槽给子任务，也彻底关掉
        // "确认后又举卡让人检视子任务"的窗口(预答兜底退居末防线)。
        // 会话直接终止；主任务转为 coordinating 汇总子任务，不在这里
        // 冒充整个跨仓需求已经完成。
        if (!isMainTaskDelivery(task.summary)) task.summary.waiting = undefined;
        // 决定必须先回注再掐会话:会话此刻停在 AskUserQuestion 工具里
        // 等这份决定,不解开它 abort 会一直等回合收束(实测挂死——
        // 等待必须带出路,不许无限等的红线在自己身上也成立)。回注是
        // 同步解扣,后续回合不等,收口里的 abort 负责掐断。
        if (task.driver) {
          this.bypass(task, "分析收口回注",
            task.driver.resumeWithDecision(resolved).then(() => undefined));
        }
        await this.finishRequirementAnalysis(task);
        return { ...task.summary };
      } catch (cause) {
        task.summary.detail =
          `确认已收到，但后续交付未能启动：${String(cause)}。`
          + "可在需求图面板重试确认";
        this.options.log?.(`任务 ${id} 生成模块交付失败: ${String(cause)}`);
        if (isMainTaskDelivery(task.summary)) {
          task.summary.status = "failed";
          this.persist(task);
          return { ...task.summary };
        }
      }
    }
    // push 前确认卡:没有会话停在 AskUserQuestion 里等这份决定(卡由
    // 宿主在 push 路径上自己挂的),所以不回注会话、更不重建会话——
    // 确认就接着推,返工就将意见交回 Agent。
    if (pushConfirmCard) {
      this.finishResolvedPushConfirmation(
        task, resolved);
      return { ...task.summary };
    }
    task.summary.waiting = undefined;
    if (task.driver) {
      task.summary.status = "running";
      task.summary.detail = "决定已收到，Agent 正在继续处理";
      this.persist(task);
      // 决定之后的这一轮是即发即忘:settle 自己会把异常收成"任务
      // failed",这里再兜一层——连收口都失败时,宁可只丢一条日志,
      // 也不许一个没人接的 rejection 掀掉整台服务(内网实测的死法)。
      this.bypass(task, "决定后续跑",
        this.settle(task, task.driver.resumeWithDecision(resolved)));
    } else {
      // 恢复场景:旧会话死于服务重启,决定先落袋(waiting.json 已
      // resolved),任务入队走重建会话——launch 会补登记这份决定。
      task.summary.status = "queued";
      task.summary.detail = "决定已收到,等待重建会话续跑";
      task.pendingResume = resolved;
      task.resume = true;
      this.persist(task);
      this.queue.push(task.summary.id);
      this.bypass(undefined, "任务泵", this.pump());
    }
    return { ...task.summary };
  }

  /** 跑动中插话:发送即打断。模型把手头这一轮的工具调用做完就收到,
   * 不会在半截处被掐断。
   *
   * 两条边界:
   * - 等人决定时不许走这条路——那时该说的话就是决定本身,从决定卡走,
   *   否则同一件事有两个入口,内核台账上却只认一个。
   * - 正好撞在回合间隙的插话 pi 收下却永远不送(它的队列没人取),
   *   由 settle 在回合收口时取回来补发。人说过的话被系统吞掉,比慢
   *   一拍严重得多。
   */
  /** @ 引用单次注入预算:引用是"把正文塞进对话",不是挂载;超了要
   * 人拆小资产或减少项数,静默截断等于让人以为 Agent 读了全文。 */
  private static readonly STEER_KNOWLEDGE_BUDGET = 48_000;

  /** 只补充当前货架中新出现的技能名，已有任务版本不被热替换。 */
  async syncTaskSkills(id: string, actor: string): Promise<{ added: string[]; warnings: string[]; receipt: string }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (actor !== (task.summary.luban_account ?? "本地用户")) throw new AnnotationPermissionError("只有当前任务责任人可以补充技能");
    if (["completed", "canceled"].includes(task.summary.status)) throw new TaskControlError("任务已结束，不能补充执行技能");
    const root = join(task.summary.workspace, "host-skill-snapshot");
    const existing = listHostSkillShelfRoot(root).skills;
    const names = new Set(existing.map((skill) => skill.name));
    const shelf = listHostSkillShelf(this.options.dataDir);
    const snapshot = materializeHostSkills({ moduleDataDir: this.options.dataDir,
      sourceRoot: join(this.options.dataDir, "skills"), workspaceRoot: task.summary.workspace,
      snapshotRoot: root, selectedSourcePaths: shelf.skills.filter((skill) => !names.has(skill.name)).map((skill) => skill.path),
      context: { repositories: task.summary.repositories ?? [],
        technologies: [...new Set((task.summary.repository_profiles ?? []).flatMap((profile) => profile.technologies))],
        businessModuleIds: (task.summary.business_modules ?? []).map((module) => module.id) },
    });
    task.summary.host_skills_pinned = true;
    task.summary.team_skills = listHostSkillShelfRoot(root).skills;
    const warnings = [...shelf.warnings, ...snapshot.warnings];
    const pendingFile = join(task.summary.workspace, "pending-skill-sync.json");
    let pending: string[] = [];
    if (existsSync(pendingFile)) {
      try {
        pending = JSON.parse(readFileSync(pendingFile, "utf-8"));
      } catch (error) {
        // 崩溃断写隔离(票 #162 同族):坏文件不炸接口也不再永 500——
        // 隔离改名保留现场供排查,本次按空清单继续(文件随后重写自愈)。
        const quarantined = `${pendingFile}.corrupt`;
        try {
          renameSync(pendingFile, quarantined);
        } catch { /* 隔离失败就原地忽略,别让旁路挡主链路 */ }
        this.options.log?.(`pending-skill-sync.json 损坏,已按空清单继续`
          + `(现场保留于 ${quarantined}): `
          + `${error instanceof Error ? error.message : error}`);
      }
    }
    const added = [...new Set([...pending, ...snapshot.names])];
    if (added.length) {
      writeFileSync(pendingFile, JSON.stringify(added));
      this.persist(task);
      const cwd = task.cwd ?? task.summary.workspace;
      const runtime = materializeHostSkills({ moduleDataDir: this.options.dataDir, sourceRoot: root, workspaceRoot: cwd,
        snapshotRoot: join(cwd, ".mae-flow-work", "host-skills") });
      warnings.push(...runtime.warnings);
      const entries = runtime.paths.map((path, index) => ({ path, name: runtime.names[index] })).filter((entry) => added.includes(entry.name));
      if (entries.length !== added.length) throw new TaskControlError(`技能已加入任务快照，但运行目录装载失败，可重试：${runtime.warnings.join("；") || "有技能未成功装载"}`);
      const message = "[补充团队技能] 责任人新增了以下可用技能。请按当前工作需要读取 SKILL.md 并使用，同目录中的脚本和资料也已就绪：\n"
        + entries.map(({ path, name }) => `- ${name}: ${relative(cwd, path).split(sep).join("/")}`).join("\n");
      if (task.summary.status === "waiting_for_human") {
        task.pendingDecisionKnowledge = [...(task.pendingDecisionKnowledge ?? []), message];
      } else task.pendingMainSteers = [...(task.pendingMainSteers ?? []), message];
      try {
        const trace = this.knowledgeTrace(task, cwd);
        for (const { path, name } of entries) trace.record("available", "host-skill-sync", {
          id: `host-skill-sync:${path}`, kind: "skill", name,
          path, scope: "team", description: "责任人中途补充的团队技能（尚未确认读取）",
        });
      } catch (error) { this.options.log?.(`补充技能足迹暂未记录: ${String(error)}`); }
      this.recordDeferredInterrupt(task, message, task.summary.status === "waiting_for_human" ? "decision" : "mission",
        { display: `补充团队技能：${added.join("、")}`, references: added });
      this.persist(task);
      rmSync(pendingFile, { force: true });
    }
    this.persist(task);
    // 先持久化再送入会话，发送失败时保留补充内容，重试或重建会话可继续。
    let delivered = false;
    if (task.summary.status === "running" && task.driver) {
      for (const message of (task.pendingMainSteers ?? []).filter((text) => text.startsWith("[补充团队技能]"))) {
        await task.driver.steer(message);
        task.pendingMainSteers = task.pendingMainSteers?.filter((text) => text !== message);
        this.persist(task);
        delivered = true;
      }
    }
    return { added, warnings,
      receipt: delivered ? "新技能已补充，Agent 将在当前工具执行结束后收到。"
        : added.length ? "新技能已加入任务，继续执行时会交给 Agent。" : "没有新的匹配技能；原有技能版本保持不变。" };
  }

  /** 解析 @ 引用并在发送时固定版本，失败当场报错，不静默丢项。 */
  private resolveSteerKnowledge(
    references: SteerKnowledgeReference[],
  ): { text: string; footprints: KnowledgeResourceRef[]; labels: string[] } {
    if (references.length > 4) {
      throw new TaskControlError("一次插话最多引用 4 项知识,请分批");
    }
    const dataDir = this.options.dataDir;
    const sections: string[] = [];
    const footprints: KnowledgeResourceRef[] = [];
    const labels: string[] = [];
    for (const reference of references) {
      if (reference.kind === "skill") {
        const doc = readHostSkillDocument(
          dataDir, String(reference.directory ?? ""));
        const version = doc.digest.slice(0, 8);
        labels.push(`${doc.directory}@${version}`);
        sections.push(`【团队 Skill · ${doc.directory}@${version}】\n`
          + doc.content.trim());
        footprints.push({
          id: `steer:skill:${doc.directory}@${version}`,
          kind: "skill",
          name: doc.directory,
          path: doc.path,
          digest: doc.digest,
          scope: "team",
          description: "插话 @ 引用注入(中途指定)",
        });
      } else if (reference.kind === "business") {
        const doc = readBusinessKnowledgeAsset(dataDir,
          String(reference.module_id ?? ""), String(reference.asset_id ?? ""));
        const label = `${doc.asset.title}@v${doc.asset.version}`;
        labels.push(label);
        sections.push(`【业务知识 · ${doc.module_name} / ${label}】\n`
          + doc.content.trim());
        footprints.push({
          id: `steer:module:${doc.module_id}:${doc.asset.id}`
            + `:v${doc.asset.version}`,
          kind: doc.asset.form === "skill" ? "skill" : "document",
          name: doc.asset.title,
          path: `business-modules/${doc.module_id}/${doc.asset.id}`,
          digest: doc.asset.digest,
          scope: "module",
          module_id: doc.module_id,
          module_name: doc.module_name,
          asset_version: doc.asset.version,
          description: "插话 @ 引用注入(中途指定)",
        });
      } else {
        throw new TaskControlError("未知的知识引用类型");
      }
    }
    const text = sections.join("\n\n");
    if (text.length > TaskService.STEER_KNOWLEDGE_BUDGET) {
      throw new TaskControlError(`引用的知识合计 ${text.length} 字,超出单次`
        + `注入预算 ${TaskService.STEER_KNOWLEDGE_BUDGET} 字;`
        + "请减少引用项或把大资产拆小");
    }
    return { text, footprints, labels };
  }

  /** 中途引用进足迹:观测旁路,失败只记日志绝不拦插话。 */
  private recordSteerKnowledge(
    task: TaskState,
    footprints: KnowledgeResourceRef[],
  ): void {
    try {
      const trace = this.knowledgeTrace(
        task, task.cwd ?? task.summary.workspace);
      for (const resource of footprints) {
        trace.record("loaded", "steer-reference", resource);
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 中途引用足迹写入失败(不拦插话): ${
          String(error)}`);
    }
  }

  async interrupt(
    id: string,
    text: string,
    actor?: string,
    references?: SteerKnowledgeReference[],
    source: "user" | "review_batch" = "user",
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    const message = text.trim();
    if (!message && !references?.length) {
      throw new NotFoundError("插话内容不能为空");
    }
    // @ 引用在发送时解析并固定版本;解析不动当场报错,别让人以为送到了。
    const resolved = references?.length
      ? this.resolveSteerKnowledge(references) : undefined;
    const knowledgeBlock = resolved
      ? `[中途引用知识] 以下 ${resolved.labels.length} 项由人在插话中显式`
        + "指定(版本已在发送时固定),请阅读并应用到当前工作:\n\n"
        + resolved.text
      : undefined;
    const combined = [message, knowledgeBlock].filter(Boolean).join("\n\n");
    // 先核对入口是否接受；被拒绝的插话不能在恢复时冒充已送出的新决定。
    const ownerMayResume = (actor ?? "本地用户") === (task.summary.luban_account ?? "本地用户")
      && (task.prepushActive || ["verifying", "await_merge", "failed"].includes(task.summary.status));
    if (task.summary.status === "waiting_for_human") {
      if (!resolved) throw new TaskControlError("这一单正等你的决定,请在决定卡里回答");
    } else if (!(task.summary.status === "queued" && resolved)) {
      if (ownerMayResume) {
        if (((task.driver || task.container) && !task.prepushActive) || task.assistantActive) {
          throw new TaskControlError("原执行者尚未释放现场，请先完成暂停或交回");
        }
      } else if (!["running", "queued"].includes(task.summary.status)
          || (!task.driver && !task.retainedSession)) {
        throw new TaskControlError(`任务 ${id} 当前是 ${task.summary.status},没有在跑的会话可插话`);
      }
    }
    // 前缀只标"谁在说话",不标"什么场景":这里是普通插话通道,单仓
    // 任务也走它。曾经无条件写"[跨仓协作 · x]",单仓插话被模型当成
    // 跨仓消息记进了交付件(spec 里出现"用户跨仓消息补充",MFC-021)。
    // 真正的跨仓同步走 /cross-repository-update,自带跨仓抬头。
    // 批注批次含平台生成的回执指令；其用户原文已在 annotations 账中，不能再冒充插话。
    const requestId = source === "user" ? recordTaskHostInstruction(task.summary, combined, actor) : undefined;
    this.refreshOwnerInputs(task);
    const instructionRef = requestId ? `[责任人指令编号 ${requestId}]\n` : "";
    const delivered = (actor
      ? (actor === task.summary.luban_account
          ? `${instructionRef}[责任人 ${actor} 插话] ${combined}`
          : `[协作者 ${actor} 插话] ${combined}`)
      : `${instructionRef}${combined}`) + (combined.includes("[处理新交办与当前工作]")
        ? "" : `\n\n${concurrentWorkPrompt()}`);
    // 「捎过去的话」只摆附言和引用名:送达用的正文里整份知识都注进去了,
    // 原样列出来是几万字的墙(用户 2026-09-02 拍板"只显示引用名")。
    const receipt = {
      display: message || "（只引用了知识，没有附言）",
      ...(resolved ? { references: resolved.labels } : {}),
    };
    if (task.retainedSession && ["running", "queued"].includes(task.summary.status)) {
      task.pendingMainSteers = [...(task.pendingMainSteers ?? []), delivered];
      this.recordDeferredInterrupt(task, delivered, "mission", receipt);
      if (resolved) this.recordSteerKnowledge(task, resolved.footprints);
      this.persist(task);
      return this.project(task);
    }
    if (task.summary.status === "waiting_for_human") {
      // 决定窗口不开插话通道(同一件事不能有两个入口),但引用的知识
      // 版本已固定,压进决定的 continuation,决定提交时一并送达。
      task.pendingDecisionKnowledge = [
        ...(task.pendingDecisionKnowledge ?? []), delivered];
      this.recordSteerKnowledge(task, resolved!.footprints);
      this.persist(task);
      this.recordDeferredInterrupt(task, delivered, "decision", receipt);
      this.options.log?.(`任务 ${id} 引用了 ${resolved!.labels.join("、")}`
        + ",将随下一次决定送达");
      return { ...task.summary };
    }
    if (task.summary.status === "queued" && resolved) {
      // 还没拿到并发槽:有专项使命(修复环)就并进同一份使命;普通新单
      // 没有使命,压进 pendingMainSteers 由 launch 随首条 prompt 送达。
      // 原来只认有使命的排队单,普通排队单的引用被"没有在跑的会话可插话"
      // 拒掉——README 写的"queued 并入使命"在最常见的新单上根本不成立
      // (2026-09-02 写排队用例时实锤)。两条路都不多起会话。
      if (task.mission) {
        task.mission += `\n\n${delivered}`;
      } else {
        task.pendingMainSteers = [...new Set([
          ...(task.pendingMainSteers ?? []), delivered,
        ])];
      }
      this.recordSteerKnowledge(task, resolved.footprints);
      this.persist(task);
      this.recordDeferredInterrupt(task, delivered, "mission", receipt);
      return { ...task.summary };
    }
    if (ownerMayResume) {
      // 人的新要求要有接收者。先撤回旧执行权，停净验证，再恢复主会话；
      // 仅收到插话不取消反馈，具体目标由 Agent 读取原话后登记。
      task.controlEpoch += 1;
      const steerEpoch = task.controlEpoch;
      task.pendingMainSteers = [...(task.pendingMainSteers ?? []), delivered];
      this.recordDeferredInterrupt(task, delivered, "mission", receipt);
      this.persist(task);
      try {
        if (task.prepushActive) await this.stopPrePush(id, actor, false);
        if (!this.current(task, steerEpoch)) return this.project(task);
        if (task.container || task.driver || task.assistantActive) throw new Error("旧执行者尚未确认释放，请诊断后重试");
      } catch (error) {
        if (this.current(task, steerEpoch)) this.taskHostRuntime(task, steerEpoch).fail?.(String(error));
        return this.project(task);
      }
      this.enqueueRepair(task, task.mission ?? "", "已收到责任人的新要求，继续当前任务");
      return this.project(task);
    }
    await task.driver!.steer(delivered, receipt);
    if (resolved) this.recordSteerKnowledge(task, resolved.footprints);
    this.options.log?.(`任务 ${id} 已插话(本轮工具调用结束后送达)`);
    return { ...task.summary };
  }

  /** 延后送达的插话也要立刻落一条账。等人决定/排队时的 @ 引用不经
   * steer 队列,而「捎过去的话」只重放事件账里的 via=interrupt——不落账,
   * 页面就永远停在"已捎过去,待读取状态会在下方更新"(用户 2026-09-02
   * 实测)。等人决定时主会话通常还活着(卡在人工闸里),必须借它的
   * emit 记账共用编号;没有会话(排队)才另开实例。记账是旁路,
   * 失败只记日志,不能挡住引用本身的送达。 */
  private recordDeferredInterrupt(
    task: TaskState,
    text: string,
    deferred: "decision" | "mission",
    receipt: { display: string; references?: string[] },
  ): void {
    try {
      const driver = task.driver ?? task.retainedSession?.driver;
      if (driver) {
        driver.noteUserMessage(text, { deferred, ...receipt });
        return;
      }
      const log = new EventLog(
        join(task.summary.workspace, "events.jsonl"),
        (event) => this.bypass(
          task, "投影事件", this.options.projection?.appendEvent(event)));
      log.append({
        eventId: log.lastEventId() + 1,
        taskId: task.summary.id,
        sessionId: "host",
        ts: new Date().toISOString(),
        kind: "user_message",
        payload: { text, via: "interrupt", deferred, ...receipt },
      });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 延后插话记账失败: ${String(error)}`);
    }
  }

  /** 旁路开发助手的读侧：回复来自助手快照，命令/文件工具结果来自
   * 任务 SSE 正本。服务重启后没有活会话却仍写 running 时如实改中断。 */
  developerAssistant(id: string, preparedEvents?: SemanticEvent[]): DeveloperAssistantView {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    let snapshot = readDeveloperAssistant(task.summary.workspace);
    if (["working", "running"].includes(snapshot.state)
        && !task.assistantActive) {
      snapshot = interruptDeveloperAssistant(task.summary.workspace);
    }
    const events = preparedEvents ?? readActivityEvents(this.eventLogPath(id)) as SemanticEvent[];
    return {
      ...snapshot,
      messages: developerAssistantConversation(snapshot, events),
      tools: developerAssistantTools(events),
      availability: this.developerAssistantAvailability(task),
    };
  }

  private developerAssistantAvailability(
    task: TaskState,
  ): DeveloperAssistantAvailability {
    if (task.summary.delivery?.final_mr) {
      return { available: false, code: "not_editable", mode: "unavailable", reason: FINAL_MR_ASSISTANT_READ_ONLY };
    }
    if (!this.options.isolation) {
      return {
        available: false,
        code: "core_unavailable",
        mode: "unavailable",
        reason: "当前部署未启用任务隔离容器，开发接管不可用",
      };
    }
    if (this.isRequirementAnalysis(task)) {
      return {
        available: false,
        code: "not_editable",
        mode: "unavailable",
        reason: "需求理解阶段请继续使用检视与批注；开发接管只处理具体代码仓任务",
      };
    }
    if (!task.cwd || task.summary.workspace_reclaimed_at) {
      return {
        available: false,
        code: "core_unavailable",
        mode: "unavailable",
        reason: "代码现场尚未就绪或已回收，暂不能接管",
      };
    }
    if (["completed", "await_merge", "canceled", "failed"]
        .includes(task.summary.status)) {
      return {
        available: false,
        code: "not_editable",
        mode: "unavailable",
        reason: `任务当前是 ${task.summary.status}，没有可接管的活动代码现场`,
      };
    }
    return inspectDeveloperAssistantAvailability(
      task.cwd,
      this.options.host?.kernelRoot,
    );
  }

  /**
   * 用户发给开发接管会话的每条消息都先持久化。首次消息由服务端负责
   * 安全暂停主任务，后续消息复用同一 Pi 会话；working 期间的新消息走
   * steer，和本地 CLI 一样在当前工具结束后送达。
   */
  startDeveloperAssistant(
    id: string,
    text: string,
    actor: string,
  ): DeveloperAssistantView {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const message = text.trim();
    if (!message) throw new TaskControlError("请告诉开发助手要检查或处理什么");
    if (message.length > 12_000) {
      throw new TaskControlError("开发助手单条要求不能超过 12000 字");
    }
    const availability = this.developerAssistantAvailability(task);
    if (!availability.available) {
      throw new TaskControlError(availability.reason);
    }
    const workspace = task.summary.workspace;
    let previous = readDeveloperAssistant(workspace);
    if (["working", "running"].includes(previous.state)
        && !task.assistantActive) {
      previous = interruptDeveloperAssistant(
        workspace, "上一轮开发会话已不在运行，本条指令将重建会话");
    }
    if (previous.state === "returning") {
      throw new TaskControlError("开发现场正在交还主任务，请等待交还完成");
    }

    if (["working", "running"].includes(previous.state)) {
      appendDeveloperAssistantMessage(workspace, "user", message, "working");
      recordTaskHostInstruction(task.summary, message, actor);
      this.refreshOwnerInputs(task);
      // 首轮容器/会话还在启动时先落盘；mission 会在会话
      // 真正就绪后读到它。会话已就绪则直接 steer。
      if (task.assistantActive && !task.driver) {
        return this.developerAssistant(id);
      }
      if (!task.driver || !task.assistantActive) {
        throw new TaskControlError("开发会话正在恢复，请稍后重试本条指令");
      }
      const epoch = task.assistantEpoch;
      void task.driver.steer(message).catch((error) => {
        if (task.assistantEpoch !== epoch || task.summary.delivery?.final_mr) return;
        const current = readDeveloperAssistant(workspace);
        const state = task.assistantActive
          && ["working", "running"].includes(current.state)
          ? "working" : current.state;
        appendDeveloperAssistantMessage(
          workspace, "assistant", `追加指令未能送达：${String(error)}`,
          state, String(error));
      });
      return this.developerAssistant(id);
    }

    if (previous.state === "acquiring") {
      appendDeveloperAssistantMessage(workspace, "user", message, "acquiring");
      recordTaskHostInstruction(task.summary, message, actor);
      this.refreshOwnerInputs(task);
      return this.developerAssistant(id);
    }

    // 首次接管时，running / waiting_for_human 本来就可能占有主
    // 会话和容器。它们由 pause 立即中止并释放，
    // 不能当成开发助手残留而拒绝。
    if (task.summary.status !== "paused") {
      appendDeveloperAssistantMessage(workspace, "user", message, "acquiring");
      recordTaskHostInstruction(task.summary, message, actor);
      this.refreshOwnerInputs(task);
      this.options.log?.(`任务 ${id} 开发现场由 ${actor} 请求接管`);
      const epoch = task.assistantEpoch;
      void this.pause(id, actor).then(() => {
        this.activatePendingDeveloperAssistant(task);
      }).catch((error) => {
        if (task.assistantEpoch !== epoch || task.summary.delivery?.final_mr) return;
        appendDeveloperAssistantMessage(
          workspace, "assistant", `未能接管主现场：${String(error)}`,
          "failed", String(error));
      });
      return this.developerAssistant(id);
    }

    if (task.driver && task.container) {
      appendDeveloperAssistantMessage(workspace, "user", message, "working");
      recordTaskHostInstruction(task.summary, message, actor);
      this.refreshOwnerInputs(task);
      this.launchDeveloperAssistantTurn(task, message, true);
      return this.developerAssistant(id);
    }

    if (task.driver || task.container) {
      throw new TaskControlError("主任务的会话或容器尚未释放，请稍后重试");
    }

    appendDeveloperAssistantMessage(workspace, "user", message, "acquiring");
    recordTaskHostInstruction(task.summary, message, actor);
    this.refreshOwnerInputs(task);
    this.options.log?.(`任务 ${id} 开发现场由 ${actor} 请求接管`);
    this.activatePendingDeveloperAssistant(task);
    return this.developerAssistant(id);
  }

  private activatePendingDeveloperAssistant(task: TaskState): void {
    const workspace = task.summary.workspace;
    const previous = readDeveloperAssistant(workspace);
    if (task.summary.status !== "paused" || previous.state !== "acquiring"
        || task.assistantActive || task.driver || task.container) return;
    const availability = this.developerAssistantAvailability(task);
    if (!availability.available || !task.cwd) {
      appendDeveloperAssistantMessage(
        workspace, "assistant", availability.reason, "failed",
        availability.reason);
      return;
    }
    let handoff: DeveloperAssistantHandoff | undefined;
    if (this.options.host && task.cwd) {
      let initial;
      try {
        initial = captureDeveloperAssistantWorktree(task.cwd);
      } catch (error) {
        // 现场摘要只用于帮助主 Agent 少做一次扫描，不是运行门禁。
        // Git/哈希读取偶发失败时仍允许助手工作，恢复后由主 Agent
        // 重新读取 current 与工作区，避免把任务永久留在暂停态。
        this.options.log?.(
          `任务 ${task.summary.id} 开发助手起点摘要不可用，将在交还时刷新: ${String(error)}`,
        );
        initial = {
          sha: "unavailable",
          fingerprint: "unavailable",
          paths: [],
          path_fingerprints: {},
        };
      }
      handoff = beginDeveloperAssistantHandoff(
        previous.handoff,
        availability,
        initial,
      );
    }
    writeDeveloperAssistant(workspace, {
      ...previous,
      state: "working",
      ...(handoff ? { handoff } : {}),
    });
    const latest = [...previous.messages].reverse()
      .find((item) => item.role === "user")?.text ?? "继续检查当前现场";
    this.launchDeveloperAssistantTurn(task, latest, false);
  }

  private launchDeveloperAssistantTurn(
    task: TaskState,
    message: string,
    continued: boolean,
  ): void {
    if (task.assistantActive) {
      throw new TaskControlError("开发助手仍在处理上一轮输入");
    }
    const epoch = (task.assistantEpoch ?? 0) + 1;
    task.assistantEpoch = epoch;
    const work = this.runDeveloperAssistant(task, epoch, message, continued);
    task.assistantActive = work;
    void work.catch((error) => {
      this.options.log?.(
        `任务 ${task.summary.id} 开发助手异常: ${String(error)}`);
    }).finally(() => {
      if (task.assistantActive === work) task.assistantActive = undefined;
    });
  }

  private async runDeveloperAssistant(
    task: TaskState,
    epoch: number,
    message: string,
    continued: boolean,
  ): Promise<void> {
    const workspace = task.summary.workspace;
    let driver: CloudSession | undefined;
    let container: TaskCommandContainer | undefined;
    let keepSession = false;
    let businessModuleKnowledge: MaterializedBusinessModuleKnowledge = {
      entries: [], skill_paths: [], warnings: [],
    };
    try {
      if (!task.cwd) throw new Error("开发助手缺少代码工作区");
      if (continued) {
        if (!task.driver || !task.container) {
          throw new Error("开发会话资源已经释放，将在下一条指令时重建");
        }
        driver = task.driver;
        container = task.container;
        const outcome = await driver.continueWith(message);
        await this.settleDeveloperAssistantTurn(task, epoch, driver, outcome);
        keepSession = true;
        return;
      }
      // 必须在容器 start 之前物化：root 宿主会在 start 前把整棵 bind
      // 工作区交给非 root 容器用户。若反过来，0440 的模块正文会在容器
      // 启动后由 root 新建，Agent 的 Read/Grep 反而读不到。
      businessModuleKnowledge = materializeBusinessModuleKnowledge({
        selected: task.summary.business_modules,
        taskWorkspace: workspace,
        runtimeWorkspace: task.cwd,
      });
      for (const warning of businessModuleKnowledge.warnings) {
        this.options.log?.(
          `[developer-assistant-business-module] 任务 ${task.summary.id}: ${warning}`);
      }
      task.containerWorkspace = task.cwd;
      container = await this.startCodingContainer(task, {
        gitReadOnly: true,
        // 开发助手只处理代码现场，不参与流水线修复；任务级 pipeline
        // 材料不应因它复用 Coding 容器实现而越过角色边界。
        pipelineArtifacts: false,
        reviewMaterials: false,
      });
      if (!this.developerAssistantCurrent(task, epoch)) {
        throw new Error("开发助手启动期间任务状态已变化");
      }
      task.container = container;

      const agentDir = join(workspace, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      this.hardenAgentGitBoundary(agentDir, task.cwd);
      const modelBundle = this.sessionModels(task);
      writeFileSync(join(agentDir, "models.json"),
        JSON.stringify(modelBundle.json), {
          mode: 0o600,
        });

      let repositorySkillPaths: string[] = [];
      let repositorySkillResources: Array<KnowledgeResourceRef & {
        actual_path: string;
      }> = [];
      const repository = task.summary.repo_url ?? this.effectiveDefaultRepo();
      if (repository) {
        const materialized = materializeRepositorySkills({
          selected: task.summary.repository_skills,
          bindings: [{ repository, workspace: task.cwd }],
          snapshotRoot: join(task.cwd, ".mae-flow-work", "repository-skills"),
          reservedNames: hostSkillNames(this.options.dataDir),
          blockedPaths: readResourceBlocks(this.options.dataDir),
        });
        this.freezeRepositoryNativeSkills(task, materialized);
        repositorySkillPaths = materialized.paths;
        repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
          id: skill.id,
          kind: "skill" as const,
          name: skill.name,
          path: skill.relative_path,
          repository: skill.repository,
          description: skill.description,
          digest: skill.digest,
          selected: true,
          actual_path: path,
        }));
        for (const warning of materialized.warnings) {
          this.options.log?.(
            `[developer-assistant-skill] 任务 ${task.summary.id}: ${warning}`);
        }
      }
      const eventLog = new EventLog(
        join(workspace, "events.jsonl"),
        (event) => this.bypass(
          task, "投影开发助手事件", this.options.projection?.appendEvent(event)),
      );
      const transcriptRoot = join(workspace, "developer-assistant");
      mkdirSync(transcriptRoot, { recursive: true });
      driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: task.cwd,
        agentDir,
        repositoryResourceBlocks: () =>
          readResourceBlocks(this.options.dataDir),
        humanFacing: true,
        // 开发助手也能查记忆(§8:所有会话同有);不挂首改目录提醒——
        // 人在接管,提醒是给自动跑的主 Agent 的。
        extraTools: this.memoryTools(task),
        componentKnowledge: this.componentKnowledge(task),
        componentAnalysisContext: () => this.componentAnalysisContext(task),
        memoryContext: () => this.taskMemoryContext(task),
        hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
        knowledgeModuleDataDir: this.options.dataDir,
        knowledgeContext: task.summary.host_skills_pinned ? undefined : {
          repositories: task.summary.repositories ?? [],
          technologies: [...new Set((task.summary.repository_profiles ?? [])
            .flatMap((profile) => profile.technologies))],
          businessModuleIds: (task.summary.business_modules ?? [])
            .map((module) => module.id),
        },
        repositorySkillPaths,
        repositorySkillResources,
        businessModuleKnowledge,
        knowledgeTrace: this.knowledgeTrace(task, task.cwd),
        provider: modelBundle.choice?.provider ?? this.options.provider,
        model: modelBundle.choice?.model ?? this.options.model,
        eventLog,
        transcript: new TranscriptStore(
          join(transcriptRoot, "transcript.jsonl"),
          DEVELOPER_ASSISTANT_SESSION,
        ),
        gate: new GateService({
          contract: developerAssistantGateContract(this.options.contract),
          // 文件工具只够得着代码仓；任务台账、流水线材料和助手快照
          // 位于仓外，旁路会话没有读取或改写它们的理由。
          workspace: task.cwd,
          cwd: task.cwd,
          log: this.options.log,
          failClosed: true,
        }),
        humanGate: task.humanGate,
        allowHumanQuestions: false,
        allowSubagents: false,
        sessionId: DEVELOPER_ASSISTANT_SESSION,
        currentStep: () => this.currentStepLabel(task),
        compactAnchor: () => `开发助手只处理当前代码现场：${requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        )}`,
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        vision: this.taskVision(task),
        bashOperations: {
          exec: (command, dir, execOptions) =>
            container!.exec(command, dir, execOptions),
        },
        afterFileMutation: this.options.isolation
          ? (path) => {
            repairContainerMutationOwnership({
              workspace: task.cwd!,
              path,
              user: this.options.isolation?.user,
            });
          }
          : undefined,
        log: this.options.log,
      });
      if (!this.developerAssistantCurrent(task, epoch)) {
        throw new Error("开发助手会话就绪前任务状态已变化");
      }
      task.driver = driver;
      const snapshot = readDeveloperAssistant(workspace);
      const outcome = await driver.start(developerAssistantMission(
        requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        ),
        snapshot.messages,
        this.developerAssistantAvailability(task),
      ));
      await this.settleDeveloperAssistantTurn(task, epoch, driver, outcome);
      keepSession = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (this.developerAssistantCurrent(task, epoch)) {
        appendDeveloperAssistantMessage(
          workspace,
          "assistant",
          `本轮未能完成：${detail}`,
          "failed",
          detail,
        );
      }
    } finally {
      if (keepSession) return;
      if (driver && task.driver === driver) task.driver = undefined;
      driver?.dispose();
      if (container && task.container === container) task.container = undefined;
      if (container) {
        try {
          await container.stop();
        } catch (error) {
          const detail = `开发助手容器未能确认释放：${String(error)}`;
          if (!this.developerAssistantCurrent(task, epoch)) {
            this.options.log?.(detail);
            return;
          }
          appendDeveloperAssistantMessage(
            workspace, "assistant", detail, "failed", detail);
        }
      }
    }
  }

  private developerAssistantCurrent(task: TaskState, epoch: number): boolean {
    return this.tasks.get(task.summary.id) === task
      && task.assistantEpoch === epoch
      && task.summary.status === "paused";
  }

  private async settleDeveloperAssistantTurn(
    task: TaskState,
    epoch: number,
    driver: CloudSession,
    first: Awaited<ReturnType<CloudSession["continueWith"]>>,
  ): Promise<void> {
    let outcome = first;
    while (true) {
      if (!this.developerAssistantCurrent(task, epoch)) return;
      if (outcome.status !== "turn_finished") {
        throw new Error(outcome.detail ?? outcome.reason
          ?? "开发助手会话异常结束");
      }
      const late = driver.takeUndeliveredSteers();
      if (late.length) {
        outcome = await driver.continueWith(late.join("\n\n"));
        continue;
      }
      const reply = driver.finalReply().trim();
      if (!reply) throw new Error("开发助手没有返回可展示的处理结果");
      appendDeveloperAssistantMessage(
        task.summary.workspace, "assistant", reply, "ready");
      return;
    }
  }

  private assertDeveloperAssistantControl(task: TaskState, epoch = task.assistantEpoch ?? 0): void {
    if (task.summary.delivery?.final_mr) throw new TaskControlError(FINAL_MR_ASSISTANT_READ_ONLY);
    if ((task.assistantEpoch ?? 0) !== epoch || this.tasks.get(task.summary.id) !== task)
      throw new TaskControlError("开发助手状态已变化，请刷新任务详情");
  }

  /** 停止当前开发动作但不交还主现场。下一条消息会在同一接管上下文里
   * 懒重建会话，避免 Pi abort 后复用一个不确定的 session。 */
  async stopDeveloperAssistant(
    id: string,
    actor: string,
  ): Promise<DeveloperAssistantView> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.assertDeveloperAssistantControl(task);
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    if (snapshot.state === "acquiring") {
      appendDeveloperAssistantMessage(
        task.summary.workspace, "assistant",
        `已由 ${actor} 停止本次接管启动；主任务保持暂停，可以继续输入或交还。`,
        "ready");
      return this.developerAssistant(id);
    }
    if (!["working", "running"].includes(snapshot.state)) {
      return this.developerAssistant(id);
    }
    const epoch = (task.assistantEpoch ?? 0) + 1;
    task.assistantEpoch = epoch;
    const driver = task.driver;
    const container = task.container;
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    this.assertDeveloperAssistantControl(task, epoch);
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      const detail = `停止当前开发动作时资源未能确认释放：${failures.join("；")}`;
      appendDeveloperAssistantMessage(
        task.summary.workspace, "assistant", detail, "failed", detail);
      throw new TaskControlError(detail);
    }
    appendDeveloperAssistantMessage(
      task.summary.workspace, "assistant",
      `当前动作已由 ${actor} 停止。代码现场仍由你接管，可以继续输入下一条指令。`,
      "ready");
    return this.developerAssistant(id);
  }

  /** 显式退出 vibe-coding 接管：先停净旁路会话/容器，再冻结一次工作区
   * 差异并走既有内核 reconcile，最后才允许主任务重建。 */
  async returnDeveloperAssistant(
    id: string,
    actor: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.assertDeveloperAssistantControl(task);
    if (task.summary.status !== "paused") {
      throw new TaskControlError("只有已接管并暂停的主现场可以交还");
    }
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    if (["acquiring", "working", "running"].includes(snapshot.state)) {
      throw new TaskControlError("开发助手仍在工作；请先停止当前动作再交还");
    }
    if (task.assistantActive) {
      const previous = task.assistantEpoch ?? 0;
      await task.assistantActive;
      this.assertDeveloperAssistantControl(task, previous);
    }
    writeDeveloperAssistant(task.summary.workspace, {
      ...readDeveloperAssistant(task.summary.workspace),
      state: "returning",
    });
    const epoch = (task.assistantEpoch ?? 0) + 1;
    task.assistantEpoch = epoch;
    const driver = task.driver;
    const container = task.container;
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    this.assertDeveloperAssistantControl(task, epoch);
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      const detail = `交还前资源未能确认释放：${failures.join("；")}`;
      writeDeveloperAssistant(task.summary.workspace, {
        ...readDeveloperAssistant(task.summary.workspace),
        state: "failed",
        error: detail,
      });
      throw new TaskControlError(detail);
    }
    this.finishDeveloperAssistantHandoff(task);
    writeDeveloperAssistant(task.summary.workspace, {
      ...readDeveloperAssistant(task.summary.workspace),
      state: "ready",
    });
    const resumed = this.resume(id, actor);
    writeDeveloperAssistant(task.summary.workspace, {
      ...readDeveloperAssistant(task.summary.workspace),
      state: "idle",
    });
    return resumed;
  }

  private finishDeveloperAssistantHandoff(task: TaskState): void {
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    if (!snapshot.handoff || !task.cwd
        || snapshot.handoff.state === "returned") return;
    try {
      const handoff = finishDeveloperAssistantHandoff(
        snapshot.handoff,
        captureDeveloperAssistantWorktree(task.cwd),
      );
      writeDeveloperAssistant(task.summary.workspace, { ...snapshot, handoff });
    } catch (error) {
      const detail = `现场摘要暂时不可读，主任务恢复后会自行重新扫描：${String(error)}`;
      writeDeveloperAssistant(task.summary.workspace, {
        ...snapshot,
        handoff: {
          ...snapshot.handoff,
          state: "changed",
          finished_at: new Date().toISOString(),
          paths_truncated: true,
          derived_only: false,
          message: detail,
        },
      });
    }
  }

  private async finishHostAction(task: TaskState, epoch = task.controlEpoch): Promise<boolean> {
    if (task.hostActionActive) return task.hostActionActive;
    const work = finishTaskHostOperation(this.taskHostRuntime(task, epoch));
    task.hostActionActive = work;
    try { return await work; }
    finally {
      if (task.hostActionActive === work) task.hostActionActive = undefined;
      // 长时间等待流水线或异常退出不常驻会话；短操作及人工推送决定复用。
      if (!["queued", "running", "waiting_for_human"].includes(task.summary.status)) discardRetainedSession(task);
      setImmediate(() => this.bypass(undefined, "宿主操作后续跑", this.pump()));
    }
  }

  private async createDeliveryMr(task: TaskState, input: Parameters<typeof createMergeRequest>[0]): ReturnType<typeof createMergeRequest> {
    const previous = task.summary.delivery;
    const work = createMergeRequest({ ...input,
      participants: this.taskMrParticipants(task, input.repo) });
    task.mrCreateActive = work;
    try {
      const result = await work;
      if (previous?.mr_participants && previous.mr_url === result.url) result.participants = previous.mr_participants;
      return result;
    }
    finally { if (task.mrCreateActive === work) task.mrCreateActive = undefined; }
  }

  private taskMrParticipants(task: TaskState, repository = task.summary.repo_url) {
    const module = task.summary.business_module
      ?? this.tasks.get(task.summary.parent_task_id ?? "")?.summary.business_module;
    return resolveModuleMrParticipants(this.options.dataDir, module?.id, repository);
  }

  /** 用户主动纠正 AR：一次程序化迁移，不调用模型、不追加检视或验证。 */
  correctTicket(id: string, input: { ticket: string; title: string }, actor: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    const ticket = input.ticket.trim(), title = input.title.trim();
    validateCorrectionTicket(ticket, title);
    if (task.summary.ticket_correction?.state === "running" && this.ticketCorrections.has(id)) return { ...task.summary };
    const retry = task.summary.ticket_correction?.state !== "completed" ? task.summary.ticket_correction : undefined;
    if (retry && (retry.ticket !== ticket || retry.title !== title)) throw new TaskControlError("请先重试完成当前单号纠正");
    if (!retry && ["completed", "canceled", "coordinating"].includes(task.summary.status)) throw new TaskControlError("请在尚未合入的具体交付任务中纠正单号");
    if (!retry && task.summary.ticket?.toLowerCase() === ticket.toLowerCase()) throw new TaskControlError("新单号与当前单号相同");
    if (task.assistantActive || task.mergeSettlement) throw new TaskControlError("当前正在接管或收口，请完成后再纠正单号");
    const correction: TicketCorrection = retry ?? { id: randomUUID(), old_ticket: task.summary.ticket ?? task.summary.id,
      ticket, title, actor, state: "running", can_cancel: true, message: "正在停止当前写入并保留现场", at: new Date().toISOString() };
    const path = correctionJournal(task.summary.workspace, correction.id);
    if (!existsSync(path)) writeCorrectionJson(path, { before: structuredClone(task.summary) });
    correction.state = "running";
    task.summary.ticket_correction = correction;
    if (!correction.cleanup_only) {
      task.controlEpoch += 1;
      this.removeFromQueue(id);
      task.summary.status = "paused";
      task.summary.detail = "正在纠正 AR 单号";
    }
    this.persist(task);
    const work = this.performTicketCorrection(task, path).catch(error => {
      correction.state = "failed";
      correction.message = String(error instanceof Error ? error.message : error);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.projected) {
        const resume = !correction.cleanup_only;
        correction.cleanup_only = true;
        correction.message = `新交付已生效，旧交付清理待重试：${correction.message}`;
        this.persist(task);
        if (resume) this.resumeAfterTicketCorrection(task, saved.before);
      } else {
        task.summary.status = "paused";
        task.summary.detail = `单号纠正未完成：${correction.message}；在任务详情中重试`;
        this.persist(task);
      }
    }).finally(() => this.ticketCorrections.delete(id));
    this.ticketCorrections.set(id, work);
    return { ...task.summary };
  }

  cancelTicketCorrection(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const correction = task.summary.ticket_correction;
    if (!correction || correction.state !== "failed" || !correction.can_cancel || this.ticketCorrections.has(id)) {
      throw new TaskControlError("纠正已开始修改交付，请继续重试完成，不能撤回一半的交付");
    }
    const path = correctionJournal(task.summary.workspace, correction.id);
    const journal = JSON.parse(readFileSync(path, "utf8"));
    if (journal.local || journal.pushed || journal.projected) throw new TaskControlError("已有交付变化，请继续完成纠正");
    journal.canceled_at = new Date().toISOString(); writeCorrectionJson(path, journal);
    task.summary.ticket_correction = undefined;
    task.summary.control = { last_action: "pause", actor: correction.actor, at: new Date().toISOString(), paused_from: journal.before.status };
    task.summary.detail = "已撤销尚未执行的单号纠正，原交付未变；可继续原任务";
    this.persist(task);
    return { ...task.summary };
  }

  private ticketCorrections = new Map<string, Promise<void>>();

  private async performTicketCorrection(task: TaskState, path: string): Promise<void> {
    const correction = task.summary.ticket_correction!;
    const journal = JSON.parse(readFileSync(path, "utf8")) as {
      before: TaskSummary; plan?: TicketRewrite; local?: boolean; remote_checked?: boolean; old_remote?: string;
      pushed?: TaskSummary["delivery"]; mr?: { url: string; id?: string | number; participants?: MrParticipantsResult }; projected?: boolean;
      closed?: boolean; deleted?: boolean;
    };
    const save = (message: string) => { correction.message = message; writeCorrectionJson(path, journal); this.persist(task); };
    if (!correction.cleanup_only) {
      await this.finishPause(task, journal.before.status);
      if (task.summary.status !== "paused") throw new Error("当前写入尚未安全结束，未修改单号");
      await task.prepushActive;
      await Promise.allSettled([task.transportActive, task.hostActionActive, task.mrCreateActive]);
      await task.reviewOutboxFlush;
      // 已发送的远端请求不能撤回；收尾后的实际收据优先于点击瞬间的快照。
      if (!journal.plan && !journal.projected) {
        journal.before.delivery = structuredClone(task.summary.delivery);
        save("正在核对已完成的远端操作");
      }
    }
    const cwd = task.cwd;
    const repo = task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "";
    const platformUrl = this.effectivePlatformUrl();
    const credential = this.options.gitCredential?.(task.summary.luban_account);
    let oldDelivery = journal.before.delivery;
    let oldMr = oldDelivery?.mr_id ?? oldDelivery?.mr_url?.match(/(?:merge_requests|merge-requests)\/(\d+)/)?.[1];
    let configuredBranch = "";
    if (cwd && existsSync(join(cwd, ".mae-flow.json"))) configuredBranch = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8")).config?.["分支名"] ?? "";
    if (cwd && existsSync(join(cwd, ".git")) && configuredBranch && !journal.plan) {
      const baseline = await frozenTaskBaseline(cwd)
        ?? (await deliveryChangeSnapshot(cwd))?.baseline;
      if (!baseline) throw new Error("未找到任务代码基线，未改写提交");
      const currentBranch = await runSafeWorktreeGitAsync(cwd, ["symbolic-ref", "--short", "HEAD"]);
      if (currentBranch.stdout.trim() !== configuredBranch) throw new Error("当前分支与任务分支不一致，未修改交付");
      journal.plan = await prepareTicketRewrite(cwd, correction.old_ticket, correction.ticket, baseline);
      save("已生成单号与提交映射，正在核对远端");
    }
    const plan = journal.plan;
    if (plan && !journal.remote_checked) {
      const shared = [...this.tasks.values()].find(other => other !== task && other.summary.repo_url === repo
        && !["completed", "canceled"].includes(other.summary.status)
        && (other.summary.delivery?.source_branch === plan.old_branch
          || (oldMr !== undefined && other.summary.delivery?.mr_id === oldMr)));
      if (shared) throw new Error(`旧分支仍被 ${shared.summary.id} 使用，不能删除其他任务的交付；请先解除共用分支`);
      const observed = await this.remoteDeliveryHost(task, task.controlEpoch).observe(plan.old_branch);
      journal.old_remote = observed.sha;
      if (observed.sha) {
        const includes = await runSafeWorktreeGitAsync(cwd!, ["merge-base", "--is-ancestor", observed.sha, plan.old_head]);
        if (includes.status !== 0) throw new Error("旧远端分支有本地尚未包含的提交，请先同步分支后再纠正，避免遗漏他人的代码");
      }
      if (journal.old_remote && oldMr === undefined && !oldDelivery?.mr_url && platformUrl) {
        const query = new URLSearchParams({ repo, source_branch: plan.old_branch, target_branch: oldDelivery?.target_branch ?? journal.before.baseline ?? "master" });
        const response = await fetch(`${platformUrl.replace(/\/+$/, "")}/mr/discover?${query}`, { headers: this.platformIdentity(task), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`无法核对旧分支是否已有 MR（HTTP ${response.status}），未改动远端`);
        const body = await response.json() as { mrs?: Array<{ id: string | number; url: string; source_branch: string; target_branch: string }> };
        if (!Array.isArray(body.mrs)) throw new Error("MR 查找结果不完整，未改动远端");
        const opened: NonNullable<typeof body.mrs> = [];
        for (const mr of body.mrs.filter(mr => mr.source_branch === plan.old_branch && mr.target_branch === query.get("target_branch"))) {
          const view = await this.remoteDeliveryHost(task, task.controlEpoch).gates(mr);
          if (view?.mrState === "opened") opened.push(mr);
        }
        if (opened.length > 1) throw new Error("旧分支关联多个开放 MR，请先确认对应交付");
        if (opened[0]) {
          oldMr = opened[0].id;
          oldDelivery = journal.before.delivery = { ...oldDelivery, mr_id: oldMr, mr_url: opened[0].url };
          save("已找回旧分支的 MR");
        }
      }
      if (oldMr !== undefined || oldDelivery?.mr_url) {
        const view = await fetchMrGates({ platformUrl, delivery: oldDelivery, repo, headers: this.platformIdentity(task), requireExisting: true });
        if (!view) throw new Error("暂时无法确认旧 MR 状态，未修改远端");
        if (view.mrState === "merged") throw new Error("旧 MR 已合入，不能按未合入任务更换单号");
        if (oldMr === undefined) throw new Error("旧 MR 缺少可操作的标识，未修改远端");
      }
      journal.remote_checked = true;
      save("远端已核对，正在切换本地单号与分支");
    }
    if (cwd && plan && !journal.local) {
      correction.can_cancel = false;
      save("正在切换本地分支");
      await applyTicketRewrite(cwd, plan, this.options.log);
      journal.local = true;
      save("本地分支已切换，代码和未提交内容保持不变");
    }
    // 远端先完成新的交付，再切换平台投影和清理旧资源。
    if (plan && journal.old_remote && !journal.pushed) {
      const publicationSha = plan.sha_map[journal.old_remote] ?? journal.old_remote;
      const observed = await this.remoteDeliveryHost(task, task.controlEpoch).observe(plan.branch);
      if (observed.sha && observed.sha !== publicationSha) throw new Error("新单号分支已被其他提交占用，未覆盖远端");
      const receipt = observed.sha === publicationSha
        ? { sha: publicationSha, ref: `refs/heads/${plan.branch}`, remote: "origin", url: repo }
        : await this.pushFromHostTransport(task, plan.branch, undefined, publicationSha);
      journal.pushed = { git_push: receipt };
      save("新分支已推送");
    }
    if (oldMr !== undefined && !journal.mr) {
      if (!platformUrl || !plan || !journal.pushed) throw new Error("缺少创建新 MR 的平台配置或推送记录");
      journal.mr = await createMergeRequest({ platformUrl, repo, sourceBranch: plan.branch,
        targetBranch: oldDelivery?.target_branch ?? journal.before.baseline ?? "master", title: correction.title,
        dtsNo: correction.ticket, credential, participants: this.taskMrParticipants(task, repo) });
      save("新 MR 已创建，正在同步任务与内核引用");
    }
    if (!journal.projected) {
      correction.can_cancel = false;
      save("正在同步任务记录");
      if (cwd) {
        if (existsSync(join(cwd, ".mae-flow.json"))) {
          if (!this.options.host) throw new Error("内核不可用，无法同步单号");
          correctKernelTicket({ host: this.options.host, cwd, workspace: task.summary.workspace, taskId: task.summary.id,
            correction: { ...correction, ...plan, old_mr_id: oldMr, old_mr_url: oldDelivery?.mr_url,
              mr_id: journal.mr?.id, mr_url: journal.mr?.url } });
        }
        const orderPath = join(cwd, ".mae-flow-order.json");
        if (existsSync(orderPath)) {
          const order = JSON.parse(readFileSync(orderPath, "utf8"));
          order["单号"] = correction.ticket;
          if (plan) order["分支名"] = plan.branch;
          writeCorrectionJson(orderPath, order);
        }
        migrateTicketArtifacts(cwd, correction.old_ticket, correction.ticket);
        this.annotations(task).relocateTicketArtifacts(correction.old_ticket, correction.ticket, correction.actor);
      }
      const replacements = { ...plan?.sha_map, ...(plan ? { [plan.old_branch]: plan.branch,
        [`refs/heads/${plan.old_branch}`]: `refs/heads/${plan.branch}` } : {}) };
      task.summary.ticket = correction.ticket;
      task.summary.delivery = mapCorrectionReferences(journal.before.delivery, replacements);
      if (plan) task.summary.delivery = { ...task.summary.delivery, source_branch: plan.branch };
      if (journal.pushed?.git_push) task.summary.delivery = { ...task.summary.delivery,
        git_push: journal.pushed.git_push, sha: journal.pushed.git_push.sha };
      if (journal.mr) task.summary.delivery = { ...task.summary.delivery, mr_url: journal.mr.url,
        mr_id: journal.mr.id, mr_participants: journal.mr.participants, mr_state: "opened", merged_sha: undefined };
      const oldPrepush = journal.before.delivery?.prepush;
      if (oldPrepush?.sha && plan?.sha_map[oldPrepush.sha]) {
        const previous = { sha: oldPrepush.sha, workspace_fingerprint: oldPrepush.workspace_fingerprint };
        const sha = plan.sha_map[oldPrepush.sha];
        const next = { sha, workspace_fingerprint: createHash("sha256").update(sha).digest("hex") };
        if (oldPrepush.state === "user_skipped" || getReusablePushReceipt(oldPrepush, previous)) {
          task.summary.delivery!.prepush = rebindEquivalentPrePushRevision(oldPrepush, previous, next, new Date().toISOString());
        }
      }
      task.summary.delivery_selection = mapCorrectionReferences(journal.before.delivery_selection, replacements);
      // 状态投影换 SHA，原始流水线日志和旧收据留在原处供追溯。
      const ledger = new TaskHostLedger(task.summary), data = ledger.read();
      for (const op of data.operations) if (["queued", "running"].includes(op.state)) {
        Object.assign(op, mapCorrectionReferences(op, replacements));
        if (journal.mr && op.mr_receipt && op.mr_receipt.url === oldDelivery?.mr_url) op.mr_receipt = journal.mr;
      }
      ledger.write(data);
      const priorDescription = journal.before.waiting;
      if (priorDescription?.step === MR_DESCRIPTION_STEP) {
        const prior = task.humanGate.all().find(row => row.waiting_id === priorDescription.waiting_id);
        if (prior?.status === "waiting") task.humanGate.supersede(prior.waiting_id, {
          stateVersion: prior.state_version, notes: "AR 单号已纠正，准确描述由本次纠正提供" });
        task.summary.waiting = undefined;
        if (task.pendingResume?.waiting_id === priorDescription.waiting_id) task.pendingResume = undefined;
      }
      const description = askMrDescription(task.humanGate, task.summary.id, correction.ticket);
      if (description.status === "waiting") task.humanGate.resolve(description.waiting_id, {
        stateVersion: description.state_version, decision: correction.title, decidedBy: correction.actor });
      const parent = task.summary.parent_task_id ? this.tasks.get(task.summary.parent_task_id) : undefined;
      if (parent?.summary.requirement_graph) {
        for (const unit of parent.summary.requirement_graph.repositories) {
          if (unit.task_id === task.summary.id) unit.ticket = correction.ticket;
        }
        this.persist(parent);
      }
      const instruction = `责任人已纠正 AR：${correction.old_ticket} → ${correction.ticket}。当前分支 ${plan?.branch ?? "按新单号生成"}；准确描述：${correction.title}。后续提交与交付使用新单号。代码未变，沿用已完成的编译、UT、检视和授权，不要重做。`;
      recordTaskHostInstruction(task.summary, instruction, task.summary.luban_account);
      task.pendingAssistantHandoff = [task.pendingAssistantHandoff, instruction].filter(Boolean).join("\n");
      this.persist(task);
      journal.projected = true;
      save("单号及验证引用已同步，正在清理旧交付");
    }
    if (oldMr !== undefined && journal.mr && !journal.closed) {
      await closeMergeRequest({ platformUrl: platformUrl!, repo, mr: oldMr, credential });
      journal.closed = true;
      save("旧 MR 已关闭");
    }
    if (plan && journal.old_remote && !journal.deleted) {
      const sandbox = this.prepareHostGitSandbox(credential);
      try {
        const remoteUrl = /^(https?|file):\/\//i.test(repo) ? repo : resolve(repo);
        const ref = `refs/heads/${plan.old_branch}`;
        const staging = join(sandbox.dir, "delete.git");
        const initialized = await runGitProcess([...sandbox.args, "init", "--bare", staging], { env: sandbox.env, timeoutMs: 30_000 });
        if (initialized.status !== 0) throw new Error("无法准备旧分支清理");
        const result = await runGitProcess([...sandbox.args, `--git-dir=${staging}`, "push", "--no-verify",
          `--force-with-lease=${ref}:${journal.old_remote}`, remoteUrl, `:${ref}`], { env: sandbox.env, cwd: sandbox.dir, timeoutMs: GIT_TRANSFER_TIMEOUT_MS });
        if (result.status !== 0) {
          const observed = await this.remoteDeliveryHost(task, task.controlEpoch).observe(plan.old_branch);
          if (observed.sha) throw new Error("新交付已保留，但旧分支清理失败（可能有其他人追加推送），请核对后重试");
        }
      } finally { this.cleanupHostGitCredential(sandbox); }
      journal.deleted = true;
      save("旧远端分支已清理");
    }
    correction.state = "completed";
    correction.message = "AR 单号已纠正，已有验证与检视结论保留";
    this.persist(task);
    if (!correction.cleanup_only) this.resumeAfterTicketCorrection(task, journal.before);
  }

  private resumeAfterTicketCorrection(task: TaskState, before: TaskSummary): void {
    task.summary.status = before.status;
    task.summary.detail = before.detail;
    task.summary.control = before.control;
    this.persist(task);
    this.ensureMergeWatch(task);
    if (before.status === "waiting_for_human" && before.waiting?.step === MR_DESCRIPTION_STEP) {
      this.continueAfterMrDescription(task, "AR 单号与描述已纠正，继续交付");
      return;
    }
    if (before.status === "verifying") this.bypass(task, "纠正后恢复监听", this.pollPipeline(task, task.controlEpoch));
    else if (["running", "queued", "pausing"].includes(before.status)) {
      task.summary.status = "queued"; task.resume = true;
      this.persist(task); this.queue.push(task.summary.id); this.bypass(undefined, "任务泵", this.pump());
    }
  }

  /** 暂停立即撤销当前会话的执行权并中止会话、释放容器；
   * 正在执行的任务先返回 pausing，后台确认资源释放后进入 paused。 */
  async pause(id: string, actor: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    const status = task.summary.status;
    if (status === "coordinating") {
      throw new TaskControlError(
        `任务 ${id} 正在汇总子任务，主任务本身没有可暂停的执行会话`,
      );
    }
    if (status === "paused" || status === "pausing") {
      return { ...task.summary };
    }
    if (["completed", "await_merge", "failed", "canceled"].includes(status)) {
      throw new TaskControlError(`任务 ${id} 当前是 ${status}，不能暂停`);
    }
    task.summary.control = {
      last_action: "pause",
      actor,
      at: new Date().toISOString(),
      paused_from: status,
    };
    if (status === "running") {
      task.controlEpoch += 1;
      this.removePrePushBuildWaiter(task);
      this.removeFromQueue(id);
      task.summary.status = "pausing";
      const prepushRunning = Boolean(
        task.summary.delivery?.prepush?.active_attempt,
      );
      task.summary.detail = prepushRunning
        ? "正在终止 Build-Fix 容器，随后可从本轮验证恢复"
        : "正在停止当前会话，随后暂停";
      this.persist(task);
      // 会话可能长时间不结束，清理也可能等待 Docker 超时；先确认
      // 控制请求，再由后台中止会话和容器，页面轮询最终状态。
      void this.finishPause(task, "running").catch((error) => {
        this.options.log?.(
          `任务 ${task.summary.id} 后台暂停清理异常: ${String(error)}`);
        // cancel/其他控制动作已经换走状态时，旧暂停没有最终解释权。
        if (task.summary.status !== "pausing") return;
        task.summary.status = "failed";
        task.summary.detail = `暂停失败，后台清理未能完成：${String(error)}`;
        this.persist(task);
        this.notifyOutcome(task);
      });
      return { ...task.summary };
    }
    task.controlEpoch += 1;
    this.removeFromQueue(id);
    await this.finishPause(task, status);
    return { ...task.summary };
  }

  /** 只允许 paused 恢复。等待人工回到决定卡，验证中回到流水线轮询，
   * 其余状态重建会话并从已有工作区/内核 current 续跑。 */
  resume(id: string, actor: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.delivery?.final_mr) throw new TaskControlError("已关联最终 MR，云端只跟踪合入结果");
    if (task.summary.status !== "paused") {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只有已暂停任务可以恢复`);
    }
    const assistantSnapshot = readDeveloperAssistant(task.summary.workspace);
    if (task.assistantActive || task.driver || task.container
        || ["acquiring", "working", "returning", "running"]
          .includes(assistantSnapshot.state)
        || assistantSnapshot.handoff?.state === "running") {
      throw new TaskControlError(
        "开发接管会话仍占有主现场，请在右栏输入框的「我来接手」档点“交回给 Agent”");
    }
    const beforeSummary = JSON.parse(JSON.stringify(task.summary)) as TaskSummary;
    const beforeHandoffPrompt = task.pendingAssistantHandoff;
    const beforePersistedStatus = task.lastPersistedStatus;
    const beforeAppliedIntervention = task.appliedDeveloperInterventionId;
    const beforeObsoleteWaiting = task.obsoleteDeveloperWaiting;
    let intervention: UserInterventionReconciliation | undefined;
    try {
      intervention = this.prepareDeveloperAssistantReturn(task, actor);
    } catch (error) {
      task.summary = beforeSummary;
      task.pendingAssistantHandoff = beforeHandoffPrompt;
      task.lastPersistedStatus = beforePersistedStatus;
      task.appliedDeveloperInterventionId = beforeAppliedIntervention;
      task.obsoleteDeveloperWaiting = beforeObsoleteWaiting;
      throw error;
    }
    const persistReturn = (): void => {
      try {
        this.persist(task, Boolean(intervention));
      } catch (error) {
        task.summary = beforeSummary;
        task.pendingAssistantHandoff = beforeHandoffPrompt;
        task.lastPersistedStatus = beforePersistedStatus;
        task.appliedDeveloperInterventionId = beforeAppliedIntervention;
        task.obsoleteDeveloperWaiting = beforeObsoleteWaiting;
        throw error;
      }
    };
    const markReturned = (): void =>
      this.markPreparedDeveloperAssistantReturned(task);
    const from = task.summary.control?.paused_from ?? "running";
    task.controlEpoch += 1;
    task.summary.control = {
      last_action: "resume",
      actor,
      at: new Date().toISOString(),
      paused_from: from,
    };
    const queuedNotes = this.annotations(task).list().filter(item => item.status === "sent"
      && item.sent_via === "queued_decision" && !item.response);
    if (resumeQueuedAnnotationSubmission({ task, notes: queuedNotes, from, changed: !!intervention?.changed,
      persist: persistReturn, markReturned, run: work => this.bypass(task, "恢复修改意见", work),
      submitDecision: () => this.submitAnnotationReviewDecision(task, queuedNotes, actor),
      deliver: () => this.deliverAgentAnnotations(task, queuedNotes, undefined, false, actor),
      enqueue: async () => { if (!this.queue.includes(id)) { this.queue.push(id); await this.pump(); } },
    })) return { ...task.summary };
    if (from === "waiting_for_human" && task.summary.waiting) {
      if (intervention?.changed) {
        const obsoleteWaiting = { ...task.summary.waiting };
        task.summary.waiting = undefined;
        task.obsoleteDeveloperWaiting = {
          waitingId: obsoleteWaiting.waiting_id,
          stateVersion: obsoleteWaiting.state_version,
        };
        task.summary.status = "queued";
        task.summary.detail = "用户介入已接纳，等待主任务承接当前代码现场";
        task.resume = true;
        task.pendingResume = undefined;
        persistReturn();
        this.supersedeWaitingForUserIntervention(task, obsoleteWaiting);
        markReturned();
        this.queue.push(id);
        this.bypass(undefined, "任务泵", this.pump());
        return { ...task.summary };
      }
      task.summary.status = "waiting_for_human";
      task.summary.detail = "已恢复，等待你的决定";
      persistReturn();
      markReturned();
      return { ...task.summary };
    }
    if (from === "verifying" && task.summary.delivery?.sha
        && !intervention?.changed) {
      task.summary.status = "verifying";
      task.summary.detail = "已恢复流水线状态跟踪";
      persistReturn();
      markReturned();
      this.bypass(task, "流水线轮询",
        this.pollPipeline(task, task.controlEpoch));
      return { ...task.summary };
    }
    if (task.summary.delivery?.prepush?.active_attempt && task.cwd) {
      // 暂停杀掉的是一次可重建的构建 attempt，不是编码上下文。恢复时
      // 直接回交付入口，restorePrePushVerification 会清理旧 attempt
      // 并对同一 SHA 重跑；绝不再起一轮普通编码 Agent。
      task.summary.status = "verifying";
      task.summary.detail = "已恢复，等待重新执行 Build-Fix";
      this.markBuildFixResuming(task);
      persistReturn();
      markReturned();
      this.bypass(task, "Build-Fix 恢复",
        this.resumePrePushVerification(task, task.controlEpoch));
      return { ...task.summary };
    }
    task.summary.status = "queued";
    task.summary.detail = intervention?.changed
      ? `用户介入已接纳，内核将从「${intervention.target}」重新读取现场`
      : "已恢复，等待续跑";
    task.resume = from !== "queued";
    persistReturn();
    markReturned();
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  private prepareDeveloperAssistantReturn(
    task: TaskState,
    actor: string,
  ): UserInterventionReconciliation | undefined {
    this.finishDeveloperAssistantHandoff(task);
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    const handoff = snapshot.handoff;
    if (!handoff) return undefined;
    if (handoff.state === "returned") return undefined;
    if (handoff.state === "running") {
      throw new TaskControlError("开发助手现场仍在收口，请稍后再交还主任务");
    }
    // revision / HEAD / 摘要哈希只帮助诊断，绝不作为恢复门禁。
    // 恢复后的主 Agent 会重新执行 mae-flow current 并扫描工作区，以
    // 内核和 Git 的最新事实继续；旧助手结论不会被当成批准或证据。
    let reconciled = handoff.state === "blocked"
      ? {
          ...handoff,
          state: "changed" as const,
          message: "旧版现场核对曾失败；已改为交由主任务重新读取，不再阻塞恢复",
        }
      : handoff;
    const pathSummary = summarizeDeveloperAssistantChangedPaths(
      reconciled.changed_paths ?? [],
    );
    if (reconciled.state === "changed"
        && (reconciled.derived_only || pathSummary.derivedOnly)) {
      reconciled = {
        ...reconciled,
        state: "unchanged" as const,
        message: "本轮只产生了可识别的构建/依赖产物，没有业务代码变化",
      };
    }
    const events = new EventLog(
      join(task.summary.workspace, "events.jsonl"),
    ).replay();
    const tools = developerAssistantTools(events);
    const changed = reconciled.state === "changed";
    let coreReconciliation: UserInterventionReconciliation | undefined;
    if (changed && task.cwd && this.options.host) {
      coreReconciliation = this.reconcileDeveloperAssistantWithCore(
        task,
        actor,
        { ...snapshot, handoff: reconciled },
        tools,
      );
      task.appliedDeveloperInterventionId = coreReconciliation.id;
      if (coreReconciliation.changed) {
        this.invalidateDeliveryAfterUserIntervention(task);
      }
    }
    const prompt = developerAssistantHandoffPrompt(
      { ...snapshot, handoff: reconciled }, tools,
    );
    if (prompt) {
      task.pendingAssistantHandoff = [task.pendingAssistantHandoff, prompt]
        .filter(Boolean).join("\n\n---\n\n");
    }
    const id = reconciled.id ?? reconciled.started_at;
    return coreReconciliation ?? {
      id,
      changed,
      from: reconciled.core?.step ?? "",
      target: reconciled.core?.step ?? "",
    };
  }

  private supersedeWaitingForUserIntervention(
    task: TaskState,
    waiting: Pick<WaitingRecord, "waiting_id" | "state_version">,
  ): void {
    try {
      task.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version,
        notes: "用户主动接管代码现场，旧问题绑定的内容已经失效。",
      });
    } catch (error) {
      // task.json 已先原子落成 queued 且不再引用这张卡；这里失败最多
      // 留下一条不可见审计孤儿，不能让主任务重新卡回旧 waiting。
      this.options.log?.(
        `任务 ${task.summary.id} 关闭旧开发助手待办失败(不阻塞恢复): ${String(error)}`,
      );
    }
  }

  private markPreparedDeveloperAssistantReturned(task: TaskState): void {
    try {
      const snapshot = readDeveloperAssistant(task.summary.workspace);
      if (!snapshot.handoff || snapshot.handoff.state === "running"
          || snapshot.handoff.state === "returned") return;
      writeDeveloperAssistant(task.summary.workspace, {
        ...snapshot,
        handoff: markDeveloperAssistantReturned(snapshot.handoff),
      });
    } catch (error) {
      // task.json 与内核已经安全落盘。标记仅用于展示，恢复时会补做。
      this.options.log?.(
        `任务 ${task.summary.id} 开发助手交还标记待恢复补写: ${String(error)}`,
      );
    }
  }

  /** 把用户要求、助手结论、真实工具结果和变更文件交给内核的正式入口。
   * 内核只允许保持/回退步骤并作废旧证据，不会把这些内容判成 PASS。 */
  private reconcileDeveloperAssistantWithCore(
    task: TaskState,
    actor: string,
    snapshot: ReturnType<typeof readDeveloperAssistant>,
    tools: ReturnType<typeof developerAssistantTools>,
  ): UserInterventionReconciliation {
    if (!task.cwd || !this.options.host) {
      throw new TaskControlError("用户介入现场缺少内核工作区，暂不能交还");
    }
    const user = [...snapshot.messages].reverse()
      .find((message) => message.role === "user")?.text ?? "";
    const assistant = [...snapshot.messages].reverse()
      .find((message) => message.role === "assistant")?.text ?? "";
    const changedPaths = summarizeDeveloperAssistantChangedPaths(
      snapshot.handoff?.changed_paths ?? [],
    );
    const interventionId = snapshot.handoff?.id
      ?? snapshot.handoff?.started_at ?? randomUUID();
    const factsPath = join(task.summary.workspace, "user-intervention.json");
    const facts = {
      schema: "mae-flow-user-intervention/1",
      intervention_id: interventionId,
      actor: actor.slice(0, 100),
      request: user.slice(0, 2_000),
      assistant_summary: assistant.slice(0, 4_000),
      changed: true,
      changed_paths: changedPaths.paths,
      changed_paths_total: changedPaths.total,
      paths_truncated: Boolean(
        snapshot.handoff?.paths_truncated || changedPaths.truncated),
      derived_only: Boolean(
        snapshot.handoff?.derived_only || changedPaths.derivedOnly),
      executions: tools.filter((tool) => tool.state !== "running")
        .slice(-8).map((tool) => ({
          name: tool.name.slice(0, 80),
          state: tool.state.slice(0, 24),
          result: (tool.result ?? "").slice(0, 800),
        })),
    };
    writeFileSync(factsPath, JSON.stringify(facts, null, 2), { mode: 0o600 });
    chmodSync(factsPath, 0o600);
    const proof = this.continuousReviewTask(task)
      ? createKernelHostProof({
          cwd: task.cwd,
          workspace: task.summary.workspace,
          taskId: task.summary.id,
          action: "intervention-reconcile",
          payload: facts,
        })
      : undefined;
    const gitView = createSafeGitView(task.cwd);
    try {
      const result = spawnSync(
        this.options.host.python ?? "python3",
        [join(this.options.host.kernelRoot, "scripts", "mae-flow.py"),
         "intervention", "reconcile", "--file", factsPath,
         ...(proof ? ["--host-proof", proof.path] : [])],
        {
          cwd: task.cwd,
          encoding: "utf-8",
          env: gitView.environment(),
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const line = String(result.stdout ?? "").trim().split("\n").at(-1) ?? "";
      let record: Partial<UserInterventionReconciliation> = {};
      try { record = JSON.parse(line); } catch { /* 下面统一报人话 */ }
      if (result.status !== 0 || typeof record.target !== "string"
          || typeof record.from !== "string") {
        throw new Error(
          String(result.stderr ?? result.stdout ?? "内核没有返回接管位置").trim(),
        );
      }
      return {
        id: interventionId,
        changed: record.changed === true,
        from: record.from,
        target: record.target,
      };
    } catch (error) {
      throw new TaskControlError(
        `内核暂未接纳用户介入现场，可直接重试“交还主任务”：${String(error)}`,
      );
    } finally {
      gitView.cleanup();
      proof?.cleanup();
    }
  }

  private invalidateDeliveryAfterUserIntervention(task: TaskState): void {
    const delivery = task.summary.delivery;
    if (!delivery) return;
    task.summary.delivery = {
      mr_url: delivery.mr_url,
      mr_id: delivery.mr_id,
      mr_participants: delivery.mr_participants,
      source_branch: delivery.source_branch,
      target_branch: delivery.target_branch,
      mr_state: delivery.mr_state,
    };
  }

  /** 取消是不可恢复终态。先换代并落盘，再中止会话/容器；因此即使
   * 清理期间旧请求返回，读侧也会立即看到 canceled，旧回调也无权改写。 */
  async cancel(id: string, actor: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    let status = task.summary.status;
    if (status === "coordinating") {
      throw new TaskControlError(
        `任务 ${id} 的子任务仍在推进，请先分别处理未完成的子任务`,
      );
    }
    if (status === "canceled" && !task.driver && !task.container && !hasAuxiliarySessions(task) && !this.deliveryImprovements.isRunning(id)) {
      return { ...task.summary };
    }
    if (status === "completed") {
      throw new TaskControlError(`任务 ${id} 已经结束，不能再停止`);
    }
    // 人点停止与平台刚合入可能竞态。能查到已合入就先按平台事实收口，
    // 不能把一单已经合入的交付反写成“用户取消”。查询不可得时仍允许
    // 用户停止，符合明确控制指令。
    if (task.summary.delivery?.final_mr) {
      const final = task.summary.delivery.final_mr;
      try { await this.refreshFinalMr(task, final); } catch { /* 平台不可用时仍可取消。 */ }
      if (task.summary.delivery.final_mr?.state === "merged") throw new TaskControlError("最终 MR 已合入，不能取消");
      status = task.summary.status;
    } else if (task.summary.delivery?.mr_url
        && ["await_merge", "verifying"].includes(status)) {
      const view = await this.fetchGates(task);
      if (view?.mrState === "merged") {
        await this.settleMergeState(task, "merged", view.sourceSha);
        throw new TaskControlError(`任务 ${id} 的 MR 已合入，任务已经结束`);
      }
      status = task.summary.status;
    }
    task.controlEpoch += 1;
    this.removeFromQueue(id);
    this.removePrePushBuildWaiter(task);
    task.summary.status = "canceled";
    task.summary.detail = `已由 ${actor} 取消`;
    task.summary.control = {
      last_action: "cancel",
      actor,
      at: new Date().toISOString(),
      paused_from: status === "paused"
        ? task.summary.control?.paused_from : status,
    };
    task.summary.waiting = undefined;
    task.mission = undefined;
    task.pendingAssistantHandoff = undefined;
    task.pendingMainSteers = undefined;
    interruptDeveloperAssistant(
      task.summary.workspace,
      `任务已由 ${actor} 取消，开发助手同时终止`,
    );
    interruptWarmupReceipt(task.summary.baseline_build);
    interruptRequirementReviews(task, this.annotations(task));
    this.persist(task);
    const driver = task.driver;
    const container = task.container;
    const prepushAbort = task.prepushAbort;
    prepushAbort?.abort();
    const cleanup = await Promise.allSettled([
      Promise.all([driver?.abort(), abortAuxiliarySessions(task), this.deliveryImprovements.stopTask(id)]),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled") {
      if (task.driver === driver) {
        task.driver = undefined;
        driver?.dispose();
      }
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    if (task.prepushAbort === prepushAbort) task.prepushAbort = undefined;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      task.summary.detail = `已由 ${actor} 取消，但执行资源未能确认释放：`
        + failures.join("；")
        + "。同任务禁止重跑；服务重启会按 ownership 再清扫";
      this.persist(task);
      this.options.log?.(`任务 ${id} 取消清理不完整: ${failures.join(" | ")}`);
    }
    // 等它的任务不许无限等(取消是终态):立刻跑一遍泵,把 blocked_by
    // 指向本单的排队任务如实清账,而不是等下一次碰巧有人触发泵。
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  private removeFromQueue(id: string): void {
    this.queue = this.queue.filter((queued) => queued !== id);
  }

  private resumePrePushVerification(task: TaskState, epoch: number): Promise<void> {
    return resumePrePushVerification({
      interrupted: task.prepushActive, cwd: task.cwd,
      current: () => this.current(task, epoch) && !["paused", "pausing"].includes(task.summary.status),
      fail: reason => this.failPendingPrePush(task, reason),
      prepare: (branch, baseline) => this.preparePush(task, branch, baseline, epoch),
      deliver: () => this.tryDeliver(task, epoch),
    });
  }

  private current(task: TaskState, epoch: number): boolean {
    return !this.shuttingDown
      && this.tasks.get(task.summary.id) === task
      && !continuationPending(task.summary)
      && !task.summary.delivery?.final_mr
      && task.controlEpoch === epoch
      && !ticketCorrectionBlocks(task.summary.ticket_correction)
      && task.summary.status !== "canceled";
  }

  private repairBudget(task: TaskState): number {
    return task.summary.repair_rounds
      ?? this.options.settings?.runtime().repair_rounds
      ?? this.options.delivery?.repairRounds
      ?? DEFAULT_REPAIR_ROUNDS;
  }

  /**
   * completed/await_merge/blocked_by 共用的内核终态证明。
   *
   * 多仓分析单是 Cloud 自己的前置会话，本来就没有 mae-flow 状态；纯
   * 会话演练同理。除此之外一律不能拿 task.json.status 自证完成。
   */
  /** 这一单是不是在"外部验证契约"存在之前就已经收口的。
   *
   * 踩过的坑(读代码逮住,第一次重启就会发生):恢复时对每个落盘为
   * completed/await_merge 的任务重做终态对账,而老单的现场里根本没有
   * execution_contract——判据于是按"云端默认三项交流水线"取,老单永远
   * 拿不出流水线逐项 PASS,被一律判成伪终态:状态翻回验证中,接着
   * tryDeliver 真的执行 git push。已合入、远端分支早删掉的老单会被
   * **重新推回去**,任务列表里一堆历史单变"验证中"。
   *
   * 老单是按当时的规矩收的口,不该用后来的尺子重新量。判据取两条
   * 机械事实:现场没有 execution_contract(新单必然有,内核从下单事实
   * 写入),且从来没有过外部验证记录;或者交付账本已经记了合入。 */
  private settledBeforeContract(task: TaskState): boolean {
    const delivery = task.summary.delivery;
    if (delivery?.mr_state === "已合入") return true;
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) return false;
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      return !state?.execution_contract
        && !state?.quality?.external_verification;
    } catch {
      // 读不出来就不敢断言"老单",走原有对账(宁可多查一次)。
      return false;
    }
  }

  private continuousReviewTask(task: TaskState): boolean {
    if (!task.cwd) return false;
    // 只认 Agent 工作区外的宿主 capability。状态文件里的开关可被 Agent
    // 写坏，只能用于展示，绝不能把一张受保护任务降级回旧终态语义。
    return kernelHostCapabilityPresent({
      workspace: task.summary.workspace,
      taskId: task.summary.id,
      cwd: task.cwd,
    });
  }

  private activeKernelFeedback(task: TaskState): {
    batchId: string;
    current: string;
    items: Array<{ id: string; summary?: string; source?: string; source_id?: string }>;
  } | undefined {
    if (!task.cwd) return undefined;
    try {
      const state = JSON.parse(readFileSync(
        join(task.cwd, ".mae-flow.json"), "utf-8"));
      const batchId = String(state?.delivery_loop?.active_batch_id ?? "");
      const batch = (state?.delivery_loop?.batches ?? []).find(
        (item: any) => String(item?.batch_id ?? "") === batchId);
      if (!batchId || !batch || !Array.isArray(batch.items)) return undefined;
      if (!this.options.host || !trustedKernelHostFeedback({
        host: this.options.host,
        cwd: task.cwd,
        state,
      })) return undefined;
      return {
        batchId,
        current: String(state?.current ?? ""),
        items: batch.items.filter((item: any) => !state.delivery_loop?.deferred_feedback?.[item.id]).map((item: any) => ({
          id: String(item?.id ?? ""),
          source_id: String(item?.source_id ?? ""),
          ...(item?.summary ? { summary: String(item.summary) } : {}),
          ...(item?.source ? { source: String(item.source) } : {}),
        })).filter((item: { id: string }) => item.id),
      };
    } catch {
      return undefined;
    }
  }

  /** verifiedState 仅复用同一同步调用内已核验反馈事实的快照，不接受仅活动批次的核验代替。 */
  private syncFeedbackStoreFromKernel(task: TaskState, projectionOnly = false, verifiedState?: Record<string, any>): void {
    // Legacy/local-plugin tasks never opted into the Cloud delivery-loop
    // contract.  They have no host receipts or FeedbackStore to rebuild; the
    // shared pipeline path must preserve their original terminal semantics.
    if (!task.cwd || !this.options.host || !this.continuousReviewTask(task)) return;
    if (projectionOnly && (task.summary.status === "canceled"
      || !existsSync(join(task.cwd, ".mae-flow.json")))) return;
    try {
      const state = verifiedState ?? JSON.parse(readFileSync(
        join(task.cwd, ".mae-flow.json"), "utf-8"));
      const batches = Array.isArray(state?.delivery_loop?.batches)
        ? state.delivery_loop.batches : [];
      if (projectionOnly && !batches.length) return;
      // 历史手动完成但内核仍在反馈阶段的任务不启动收据核验，避免重启
      // 为无效终态反复等待 Python。真正已有 close 事件的任务仍须核验
      // 反馈事实后补齐索引；不能把合入时遗漏的“处理中”永久封存。
      if (projectionOnly && task.summary.status === "completed"
          && (state.current !== "end" || !state.delivery_loop?.close_events?.length)) return;
      if (!verifiedState && !trustedKernelHostFeedback({
        host: this.options.host,
        cwd: task.cwd,
        state,
      })) {
        throw new Error("内核反馈事实缺少 Cloud 宿主权威收据");
      }
      const indexPath = join(
        task.summary.workspace, "feedback", "index.jsonl");
      let store = new FeedbackStore(indexPath);
      let existing: FeedbackRecord[];
      try {
        existing = store.list();
      } catch (error) {
        if (!(error instanceof FeedbackStoreCorruptionError)) throw error;
        const quarantined = `${indexPath}.corrupt-${Date.now()}-${randomUUID()}`;
        renameSync(indexPath, quarantined);
        this.options.log?.(
          `任务 ${task.summary.id} 已隔离损坏反馈索引 ${basename(quarantined)}，`
          + "从内核权威批次重建");
        store = new FeedbackStore(indexPath);
        existing = [];
      }
      projectKernelFeedback(state, store, existing);
      this.reconcileWorkspaceFeedbackAuthority(task, store);
      if (projectionOnly) return;
      const stalled = task.summary.delivery?.stalled;
      if (stalled?.startsWith("持续检视索引损坏或不可写")) {
        delete task.summary.delivery!.stalled;
        delete task.summary.delivery!.stall_class;
        if (task.summary.delivery?.waiting_on === stalled) {
          task.summary.delivery.waiting_on = undefined;
        }
        task.summary.detail = task.summary.status === "await_merge"
          ? "持续检视索引已从内核恢复，继续等待检视与合入"
          : "持续检视索引已从内核恢复，继续自动闭环";
        this.persist(task);
      }
    } catch (error) {
      // 发布、合入、恢复只补展示索引，失败不能倒退已经成立的交付事实。
      if (projectionOnly) { this.options.log?.(`任务 ${task.summary.id} 反馈状态同步未完成：${String(error)}`); return; }
      // 内核根本没答(起不来且重试用尽)不是索引损坏:交给调用方按
      // 基础设施故障挂起重试。原来这里一把抓,一次抖动就被判成"索引
      // 损坏"停摆叫人,而且下面 pipelineVerdict 的对账兜底永远跑不到。
      if (error instanceof KernelUnavailableError) throw error;
      const detail = `持续检视索引损坏或不可写，已停止自动闭环，不能静默隐藏反馈：${
        String(error).slice(0, 800)}`;
      this.options.log?.(`任务 ${task.summary.id} ${detail}`);
      this.markVerificationStalled(task, detail, "infrastructure");
    }
  }

  /** Cloud 只在来源方的权威事件发生时关闭人工反馈。append-only 索引
   * 已关闭后永不降级；重复回调只读不写，因此网络重放也是幂等的。 */
  private resolveFeedbackRecords(
    task: TaskState,
    matches: (record: FeedbackRecord) => boolean,
    status: FeedbackRecord["status"],
    resolution: string | ((record: FeedbackRecord) => string),
  ): void {
    const store = new FeedbackStore(
      join(task.summary.workspace, "feedback", "index.jsonl"));
    for (const record of store.list()) {
      if (record.status !== "closed" && matches(record)) {
        store.resolve(record.id, status,
          typeof resolution === "function" ? resolution(record) : resolution);
      }
    }
  }

  /** 工作台批注账对 FeedbackStore 的单向权威校正。内核只能证明 Agent
   * 是否处理过，不能代替任务责任人逐条处置；所以 fixed/not_fixed 只到
   * awaiting_verification，只有批注的 verified/dropped 能最终 closed。
   * 这也修复“重启后从内核重建索引，又把已撤回意见复活”的窗口。 */
  private reconcileWorkspaceFeedbackAuthority(
    task: TaskState,
    existingStore?: FeedbackStore,
  ): void {
    const annotations = new Map(this.annotations(task).list()
      .map((item) => [item.id, item]));
    if (!annotations.size) return;
    const store = existingStore ?? new FeedbackStore(
      join(task.summary.workspace, "feedback", "index.jsonl"));
    for (const record of store.list()) {
      if (record.source !== "workspace" || record.status === "closed") continue;
      const annotation = annotations.get(record.source_id);
      if (!annotation) continue; // 找不到权威原件时 fail-closed，不猜已处理。
      const revision = annotation.rework ?? 0;
      if (annotation.status === "verified" || annotation.status === "dropped"
          || revision > record.source_revision
          || (annotation.status === "draft"
            && revision === record.source_revision)) {
        const reason = annotation.status === "verified"
          ? annotation.resolution ? `责任人逐条处置：${annotation.resolution.outcome}；${annotation.resolution.reason}` : "历史批注作者已确认通过"
          : annotation.status === "dropped"
            ? "批注作者已撤回"
            : annotation.status === "draft"
              ? "批注已修改，等待重新提交"
              : "批注已进入新一轮返工";
        store.resolve(record.id, "closed", reason);
        continue;
      }
      if (record.status === "deferred" || revision !== record.source_revision
          || annotation.status !== "sent"
          || annotation.response?.revision !== revision) continue;
      const status = annotation.response.outcome === "needs_clarification"
        ? "needs_human" as const : "awaiting_verification" as const;
      if (record.status !== status) {
        store.resolve(record.id, status,
          annotation.response.outcome === "needs_clarification"
            ? `Agent 需要提出人补充说明：${annotation.response.summary}`
            : "Agent 已处理，等待任务责任人逐条处置");
      }
    }
  }

  /** 权威 PASS 可能在关闭上一批时原子提升了排队反馈。Cloud 必须马上
   * 把同一个 writer 接到新批次；否则内核已在 feedback_triage，而
   * Cloud 只会继续轮询同一张绿灯，形成没有 owner 的活锁。 */
  private dispatchPromotedFeedback(task: TaskState): boolean {
    const active = this.activeKernelFeedback(task);
    if (!active || active.current !== "feedback_triage"
        || task.mission?.includes(active.batchId)) return false;
    const items = active.items.filter(item => !historicalPipelineFeedback(task.summary, item));
    if (!items.length) return false;
    const store = new FeedbackStore(
      join(task.summary.workspace, "feedback", "index.jsonl"));
    const records = new Map(store.list().map((item) => [item.id, item]));
    for (const item of items) {
      if (records.get(item.id)?.status === "open") {
        store.resolve(item.id, "repairing", "前一批已核验，开始处理本批");
      }
    }
    const summaries = items.slice(0, 8)
      .map((item) => `- ${item.summary || item.id}`);
    this.enqueueRepair(task, [
      `持续检视还有 ${items.length} 条已登记反馈需要接续处理。`,
      ...summaries,
      "沿用当前现场，先执行 current，并按内核当前反馈步骤逐条处理。",
      "每条都要给出处理结果；确实存在多种理解时明确停下说明歧义。",
    ].join("\n"), `上一批已核验，继续处理 ${items.length} 条反馈`);
    return true;
  }

  private deliveryReadyAttestation(
    task: TaskState,
  ): KernelCompletionAttestation | undefined {
    if (!this.options.host || this.isRequirementAnalysis(task)) return undefined;
    return this.continuousReviewTask(task)
      ? inspectKernelDeliveryReady(
          task.cwd, this.options.host.kernelRoot, true,
          { workspace: task.summary.workspace, taskId: task.summary.id,
          python: this.options.host.python })
      : inspectKernelTaskCompletion(
          task.cwd, this.options.host.kernelRoot, true);
  }

  private latestKernelCloseEvent(task: TaskState): Record<string, any> | undefined {
    if (!task.cwd) return undefined;
    try {
      const state = JSON.parse(readFileSync(
        join(task.cwd, ".mae-flow.json"), "utf-8"));
      const events = state?.delivery_loop?.close_events;
      return Array.isArray(events) && events.length
        ? events[events.length - 1] as Record<string, any> : undefined;
    } catch { return undefined; }
  }

  private taskCompletionAttestation(
    task: TaskState,
  ): KernelCompletionAttestation | undefined {
    if (!this.options.host || this.isRequirementAnalysis(task)) return undefined;
    if (task.summary.delivery?.final_mr?.state === "merged" && !this.continuousReviewTask(task)) return undefined;
    return inspectKernelTaskCompletion(
      task.cwd,
      this.options.host.kernelRoot,
      true,
      this.continuousReviewTask(task)
        ? { workspace: task.summary.workspace, taskId: task.summary.id,
          python: this.options.host.python }
        : undefined,
    );
  }

  private dependencyCompleted(task: TaskState | undefined): boolean {
    if (!task || task.summary.status !== "completed") return false;
    return this.taskCompletionAttestation(task)?.complete ?? true;
  }

  /** 终止/失败分支也必须串行确认容器删除。失败时保留 task.container，
   * retry 会据此拒绝覆盖句柄，cancel/shutdown 仍可重试回收。 */
  private async stopTaskContainer(
    task: TaskState,
    context: string,
  ): Promise<string | undefined> {
    const container = task.container;
    if (!container) return undefined;
    try {
      await container.stop();
      if (task.container === container) task.container = undefined;
      return undefined;
    } catch (error) {
      const detail = `${context}容器未能确认释放: ${String(error)}`;
      this.options.log?.(`任务 ${task.summary.id} ${detail}`);
      return detail;
    }
  }

  private async finishPause(
    task: TaskState,
    from: TaskStatus,
  ): Promise<void> {
    const epoch = task.controlEpoch;
    const driver = task.driver;
    const container = task.container;
    const prepushAbort = task.prepushAbort;
    const undelivered = (driver as CloudSession | undefined)
      ?.takeUndeliveredSteers?.() ?? [];
    if (undelivered.length) {
      task.pendingMainSteers = [...new Set([
        ...(task.pendingMainSteers ?? []), ...undelivered,
      ])];
      this.options.log?.(
        `任务 ${task.summary.id} 暂停前保全 ${undelivered.length} 条未送达补充`);
    }
    prepushAbort?.abort();
    const cleanup = await Promise.allSettled([
      Promise.all([driver?.abort(), abortAuxiliarySessions(task)]),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled") {
      if (task.driver === driver) {
        task.driver = undefined;
        driver?.dispose();
      }
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    if (task.prepushAbort === prepushAbort) task.prepushAbort = undefined;
    // pause 等待资源清理期间可能又收到 cancel。后者换了 epoch 并拥有
    // 最终状态解释权；旧 pause 绝不能把 canceled 覆盖回 paused。
    if (task.controlEpoch !== epoch || task.summary.status === "canceled") return;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      task.summary.status = "failed";
      task.summary.detail = "暂停失败，执行资源未能确认释放："
        + failures.join("；")
        + "。同任务禁止重跑；可取消后重试清理或重启服务";
      this.persist(task);
      this.notifyOutcome(task);
      this.options.log?.(`任务 ${task.summary.id} 暂停清理失败: `
        + failures.join(" | "));
      return;
    }
    task.summary.status = "paused";
    interruptWarmupReceipt(task.summary.baseline_build);
    interruptRequirementReviews(task, this.annotations(task));
    task.summary.detail = from === "waiting_for_human"
      ? "已暂停，恢复后继续等待决定"
      : from === "verifying"
        ? "已暂停状态跟踪，外部流水线不会被中止"
        : "已安全暂停，可从当前进度恢复";
    task.summary.control = {
      ...(task.summary.control ?? {
        last_action: "pause",
        actor: "系统",
        at: new Date().toISOString(),
      }),
      last_action: "pause",
      paused_from: from,
    };
    this.persist(task);
    this.activatePendingDeveloperAssistant(task);
  }

  private dependencyHost(projectionOnly = false) {
    // 列表/排队展示不能启动 Python 收据核验；真正出队继续走原有权威裁决。
    const checked = new Map<TaskState, boolean>();
    return { tasks: this.tasks,
      completed: (task: TaskState | undefined) => {
        if (!task || task.summary.status !== "completed") return false;
        if (projectionOnly) return true;
        if (!checked.has(task)) checked.set(task, this.dependencyCompleted(task));
        return checked.get(task)!;
      },
      persist: (task: TaskState, strict = true) => this.persist(task, strict, false),
      wake: (task: TaskState) => {
        if (task.summary.status === "queued" && !this.queue.includes(task.summary.id)) this.queue.push(task.summary.id);
        this.bypass(undefined, "提前开始任务", this.pump());
      },
    };
  }

  previewEarlyStart(id: string, actor: string, input: EarlyStartInput = {}) {
    // 预览会被任务列表批量请求，只读取已持久化的完成投影；不能为每个
    // 祖先任务同步启动 Python 内核验签。用户真正确认时 startTaskEarly
    // 仍使用权威 dependencyHost() 重新核验，投影过期也会由 revision 拒绝。
    return previewEarlyStart(this.dependencyHost(true), id, actor, input);
  }

  startTaskEarly(id: string, actor: string, input: EarlyStartInput): TaskSummary {
    applyEarlyStart(this.dependencyHost(), id, actor, input);
    return this.get(id)!;
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    // 问题流专用部署:需求任务一律不拉起。恢复的单子留在队列里
    // (状态如实显示排队中),用完整部署重启同一数据目录即自动续跑。
    if (this.options.requirementDisabled) return;
    const max = this.options.settings?.runtime().max_concurrent
      ?? this.options.maxConcurrent ?? 2;
    refreshDependencyQueue(this.dependencyHost(), this.queue);
    while (this.runningCount < max && this.queue.length) {
      const scheduling = this.dependencyHost(); // 不跨 await 沿用上一轮收据裁决。
      const readyIndex = this.queue.findIndex((queued) => {
        const candidate = this.tasks.get(queued);
        if (!candidate) return true;
        if (candidate.hostActionActive) return false;
        return !concurrentTicketConflict(scheduling, candidate, this.queue)
          && (candidate.summary.blocked_by ?? []).every((dependency) =>
            scheduling.completed(this.tasks.get(dependency)));
      });
      if (readyIndex < 0) {
        break;
      }
      const [id] = this.queue.splice(readyIndex, 1);
      const task = this.tasks.get(id);
      // 控制动作可能已经把重复/陈旧队列项暂停或取消。
      if (!task || task.summary.status !== "queued" || task.summary.delivery?.final_mr) continue;
      this.runningCount += 1;
      const wasManualRetry = task.summary.detail?.includes("人工重跑") === true;
      task.summary.status = "running";
      task.summary.detail = wasManualRetry
        ? "人工重跑已开始，Agent 正在继续处理"
        : task.resume
          ? "Agent 已恢复并继续处理"
          : "Agent 正在处理";
      this.persist(task);
      const epoch = task.controlEpoch;
      this.bypass(task, "任务启动", continueRetainedSession(task, epoch, {
        launch: () => this.launch(task, epoch), persist: () => this.persist(task),
        settle: turn => this.settle(task, turn, epoch),
      }).finally(() => {
        this.runningCount -= 1;
        this.bypass(undefined, "任务泵", this.pump());
      }));
    }
  }

  private finishHostPushDecision(task: TaskState, waiting: WaitingRecord): void {
    const ledger = new TaskHostLedger(task.summary);
    const operation = ledger.read().operations.find(item => item.id === waiting.call_id || item.push_waiting_id === waiting.waiting_id);
    if (!operation || operation.input.action !== "push") throw new TaskControlError("未找到待确认的推送");
    if (operation.state === "succeeded" || operation.state === "failed") return;
    // 按明确选项裁决；备注可能是审批渠道信息，不能将其当作“先调整”。
    const selections = [...Object.values(waiting.answers ?? {}), waiting.decision];
    const accepted = selections.includes("确认推送") && !selections.includes("先调整");
    task.summary.waiting = undefined;
    if (accepted) {
      operation.push_confirmed = true;
      ledger.update(operation);
      task.summary.status = "running";
      task.summary.detail = "已确认，正在推送";
      this.persist(task);
      this.bypass(task, "确认后推送", this.finishHostAction(task));
    } else {
      operation.state = "failed";
      operation.result = "用户要求调整本次推送";
      ledger.update(operation);
      this.enqueueRepair(task, `用户要求调整推送，请整理后重新发起：\n${Object.values(waiting.answers ?? {}).join("\n")}\n${waiting.decision}\n${waiting.notes ?? ""}`, "按用户要求调整推送");
    }
  }

  private taskHostRuntime(task: TaskState, epoch = task.controlEpoch): TaskHostRuntime {
    let actionEpoch = epoch;
    const assertActive = () => {
      if (["paused", "pausing"].includes(task.summary.status)) {
        throw new TaskControlError(task.summary.status === "pausing"
          ? "任务正在暂停，当前会话已停止执行宿主操作"
          : "任务已暂停，请恢复任务后继续执行宿主操作");
      }
      if (!this.current(task, actionEpoch) || task.summary.status === "completed") {
        throw new TaskControlError("任务执行权已变化或任务已结束；旧会话不能继续执行宿主操作");
      }
    };
    return {
      summary: task.summary, cwd: task.cwd, dataDir: this.options.dataDir,
      kernel: this.options.host, platformUrl: this.effectivePlatformUrl(),
      credential: this.options.gitCredential?.(task.summary.luban_account),
      mrParticipants: () => this.taskMrParticipants(task),
      assertActive,
      annotations: () => this.annotations(task).list(),
      decisions: () => task.humanGate.all(),
      related: () => this.list().filter(item => relatedHostTask(task.summary, item))
        .map(item => ({ id: item.id, title: item.title, status: item.status, detail: item.detail })),
      gates: () => this.fetchGates(task),
      reviews: () => this.fetchDiscussions(task),
      activeFeedback: () => this.activeFeedbackResult(task),
      diagnostics: () => collectAgentDiagnostics({ workspace: task.summary.workspace, cwd: task.cwd,
        task: { id: task.summary.id, status: task.summary.status, detail: task.summary.detail },
        execution: { verification: Boolean(task.prepushActive), assistant: Boolean(task.assistantActive), prepush: task.summary.delivery?.prepush },
        container: task.container?.metadata }),
      document: async (id, artifact) => {
        const related = this.tasks.get(id);
        if (!related || !relatedHostTask(task.summary, related.summary)) throw new TaskControlError("只能读取当前任务及关联模块的设计材料");
        return readTaskHostDocument({ workspace: related.summary.workspace, root: this.artifactRoot(id), name: artifact,
          read: name => this.annotationArtifactContentAsync(related, name) });
      },
      reply: (id, revision, outcome, summary, evidence) => {
        const item = this.annotations(task).list().find(row => row.id === id);
        if (!item) throw new TaskControlError("未找到指定意见");
        const parsed = parseWorkspaceReviewReceipts([{ annotation_id: id, revision, outcome, summary, evidence }], [item]);
        if (parsed.errors.length) throw new TaskControlError(parsed.errors.join("；"));
        this.annotations(task).respond(id, { revision, outcome, summary, evidence });
        this.reconcileWorkspaceFeedbackAuthority(task);
      },
      release: async (action) => {
        // 普通操作沿用当前执行代次；暂停、取消、明确重启才撤销会话执行权。
        if (!this.current(task, actionEpoch)) throw new TaskControlError("执行权已交接");
        if (task.prepushActive || task.assistantActive) throw new TaskControlError("验证或接手会话仍占用现场，暂不能执行宿主操作");
        const replaceSession = action === "restart_session" || actionEpoch !== epoch;
        handoffSession(task, replaceSession);
        actionEpoch = task.controlEpoch;
        if (hostActionStopsContainer(action, replaceSession)) {
          const failure = await this.stopTaskContainer(task, "宿主操作交接");
          if (failure) throw new TaskControlError(failure);
        }
      },
      persist: () => this.persist(task, true),
      mrTitle: (operation) => {
        const state = JSON.parse(readFileSync(join(task.cwd!, ".mae-flow.json"), "utf8"));
        const ticket = String(task.summary.ticket ?? state.config?.["单号"] ?? operation.branch).trim();
        const title = savedMrDescription(task.humanGate, task.summary.id, ticket);
        if (title) return title;
        task.summary.waiting = askMrDescription(task.humanGate, task.summary.id, ticket);
        task.summary.status = "waiting_for_human";
        task.summary.detail = "创建 MR 前，请填写 AR 单对应的准确描述";
        this.persist(task); this.notifyWaiting(task);
        return undefined;
      },
      fail: message => { task.controlEpoch += 1; actionEpoch = task.controlEpoch; task.summary.status = "failed"; task.summary.detail = message; this.persist(task); this.notifyOutcome(task); },
      stopVerification: async () => {
        if (task.prepushActive) { task.controlEpoch += 1; actionEpoch = task.controlEpoch; await this.stopPrePush(task.summary.id, task.summary.luban_account, false); }
      },
      recordPublishedPush: receipt => this.recordPublishedPush(task, receipt),
      resumePipelineAfterPush: () => this.hasDeliveryMr(task) && !task.pendingMainSteers?.length && shouldVerifyCiPush(task.mission, task.summary),
      resume: (message, target, operation) => this.enqueueRepair(task,
        hostResumeMission(task.mission, message, target, operation, task.summary), "宿主操作已返回，继续当前目标",
        [target ? `责任人调整后的目标：${target}。不再执行已暂缓事项。` : "",
          message, "沿用已有上下文，只核对本次操作影响的文件或状态；不要重新阅读整个任务、重复探索或重做已完成工作。"].filter(Boolean).join("\n\n")),
      allowPush: () => this.existingMergeRequestAllowsDelivery(task, actionEpoch),
      preparePush: operation => prepareHostPush({ cwd: task.cwd, summary: task.summary,
        assertActive },
        operation, branch => this.absorbForeignRemoteCommits(task, branch, false), async () => {
          await this.syncTargetBeforePush(task, operation.target_branch!, actionEpoch);
          await this.checkCodecheckBeforePush(task, actionEpoch, operation.target_branch);
          assertActive();
          if (await this.reconcileDeliveryPlatformBoundary(task) === "blocked") {
            throw new TaskControlError(task.summary.detail ?? "无法清理平台本地目录");
          }
        }),
      finishReviewAfterPush: operation => handoffReview({
        eligible: () => canHandoffReview(task.mission, task.summary, operation.review_handoff)
          && !task.pendingMainSteers?.length && !!this.effectivePlatformUrl(),
        // 本地未提交文件不会随 push 传输，不要求为了交接清空工作区。
        ready: async () => (await this.prePushRevision(task)).sha === operation.push_receipt?.sha,
        stage: () => this.stageReviewReplies(task), record: () => this.recordActiveFeedbackResult(task),
        canVerify: () => this.atHostDeliveryWait(task),
        assertActive,
        flush: () => this.flushReviewReplyOutbox(task),
        complete: () => { operation.review_handoff = true; new TaskHostLedger(task.summary).update(operation); },
        wait: healthy => {
          task.mission = undefined;
          task.summary.status = "verifying";
          if (healthy) task.summary.detail = "检视修改已推送，宿主继续发送回复并验证本次提交";
          task.summary.delivery!.loop!.state = "verifying";
          this.persist(task); this.ensureMergeWatch(task);
        },
      }),
      confirmPush: operation => confirmHostPush({
        summary: task.summary, cwd: task.cwd, humanGate: task.humanGate,
        accountDefault: () => this.options.pushConfirmation?.(task.summary.luban_account),
        contribution: snapshot => this.deliveryContribution(task, snapshot),
        pushFiles: (branch, head) => this.readPushFileList(task, branch, head),
        persist: () => this.persist(task), notifyWaiting: () => this.notifyWaiting(task),
      }, operation, assertActive),
      push: async (branch, sha) => {
        await assertNoCodecheckCommits(task.cwd!, await frozenTaskBaseline(task.cwd!));
        return this.pushFromHost(task, branch, sha);
      },
      verify: async () => {
        if (!this.options.prepush?.enabled) throw new TaskControlError("未配置宿主验证；可在任务容器内直接运行编译和 UT");
        const state = JSON.parse(readFileSync(join(task.cwd!, ".mae-flow.json"), "utf8"));
        return { ready: await this.preparePush(task, state.config?.["分支名"], state.config?.["基线分支"], actionEpoch, false), prepush: task.summary.delivery?.prepush };
      },
      watch: createdMr => this.ensureMergeWatch(task, createdMr),
      watchPush: () => {
        if (!this.effectivePlatformUrl()) return;
        if (this.needsDeliveryBeforePipeline(task)) {
          task.summary.status = "verifying";
          task.summary.detail = "代码已推送，正在接续创建 MR";
          this.persist(task);
          setImmediate(() => this.bypass(task, "推送后创建 MR",
            this.tryDeliver(task, actionEpoch)));
          return true;
        }
        task.summary.delivery = { ...task.summary.delivery, pipeline: task.summary.delivery?.pipeline ?? "待查询", pipeline_background: true };
        this.persist(task); this.ensureMergeWatch(task);
        this.bypass(task, "提前推送验证监听", this.pollPipeline(task, actionEpoch, true));
      },
      acceptPipeline: (sha, run) => this.acceptPipelineRun(task, sha, run, actionEpoch, !this.pipelineCanTakeOver(task)),
      syncFeedback: () => this.syncFeedbackStoreFromKernel(task),
      deferAnnotation: (id, revision, actor, reason) => { this.verifyAnnotation(task.summary.id, id, actor, false, { revision, outcome: "deferred", reason }); },
      syncBranch: async (branch, target) => {
        assertActive();
        const cwd = task.cwd!;
        const currentBranch = String(runSafeWorktreeGit(cwd, ["branch", "--show-current"]).stdout).trim();
        if (currentBranch !== branch || branch === target) throw new TaskControlError("当前分支与任务绑定不符");
        const unresolved = String(runSafeWorktreeGit(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout).trim();
        if (unresolved) return `当前已有冲突，请先解决并 git add、git commit，再调用 sync_branch：\n${unresolved}\n保留双方必要改动，不确定业务取舍时询问责任人，不要直接选一边。`;
        const dirty = String(runSafeWorktreeGit(cwd, ["status", "--porcelain", "--untracked-files=no"]).stdout).trim();
        if (dirty) throw new TaskControlError("请先提交当前修改再同步；宿主不会重置或暂存覆盖你的工作");
        let result = "";
        for (const ref of [branch, target]) {
          let prepared = false;
          const sha = String(runSafeWorktreeGit(cwd, ["rev-parse", "HEAD"]).stdout).trim();
          await this.dispatchConflictRepair(task, sha, undefined, actionEpoch, {
            target: ref, allowMissing: ref === branch,
            ready: (message) => { prepared = true; result = message; },
          });
          if (!prepared) throw new TaskControlError(task.summary.detail || "分支同步未完成");
          if (String(runSafeWorktreeGit(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout).trim()) return result;
        }
        return `${result}\n已同步远端任务分支与目标分支。继续原目标；执行受影响的编译与 UT（C++ 按项目约定执行 UT 编译），确认双方行为后再请求 push，更新原 MR。不要把旧 SHA 的验证结果当成本次验证。`;
      },
      cloneReference: async url => {
        const sandbox = this.prepareHostGitSandbox(this.options.gitCredential?.(task.summary.luban_account));
        try { return await this.cloneRepo(join(task.cwd!, ".mae-flow-work", "reference-repos"), sandbox,
          undefined, url, undefined, createHash("sha256").update(url).digest("hex").slice(0, 16), true); }
        finally { this.cleanupHostGitCredential(sandbox); }
      },
      collaborate: text => this.publishCrossRepositoryUpdate(task.summary.id, task.summary.luban_account ?? "本地用户", text),
    };
  }

  private async launch(task: TaskState, epoch: number): Promise<void> {
    const { workspace } = task.summary;
    try {
      const agentDir = join(workspace, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      // 兼容旧版本现场：明文凭据/helper 曾落在 agentDir。任何模型文件
      // 与 CloudSession 创建之前先机械清掉，避免恢复任务把旧秘密重新
      // 暴露给 Agent。
      this.hardenAgentGitBoundary(agentDir);
      // 模型网关热改边界:在这里生效——每个新会话起时现读设置,
      // 在跑的会话不换血(管理页如实写明了这一条)。
      const modelBundle = this.sessionModels(task);
      if (task.summary.model_lane !== modelBundle.lane) {
        // 网关标记记主会话的解析结果(ADR-0039/0068);下次 persist 随
        // task.json 落盘,排障与网关侧账目对拍的依据。
        task.summary.model_lane = modelBundle.lane;
      }
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(modelBundle.json));
      // 个人 Git 身份每次启动现读。用户名/邮箱只用于 commit 署名；
      // token 仅在宿主 clone/push 的同步窗口进入 0700 临时目录，绝不
      // 进入 agentDir、仓库配置或 Agent 会话。
      const gitIdentity =
        this.options.gitCredential?.(task.summary.luban_account);
      const transcriptPath = join(workspace, "transcript.jsonl");
      // 恢复=工作区(仓库克隆)还在;克隆丢了就只能从头来。
      // savedCwd 必须先恢复；后续准备失败也要保留仓库路径，
      // 不能把重建会话跑进任务根目录(实测:内核找不到
      // 状态文件,messages 报"未初始化")。
      const savedCwd = this.options.host ? recoverTaskCwd(task.summary, workspace, task.cwd) : task.cwd;
      const requirementAnalysis = this.isRequirementAnalysis(task);
      const analysisOnly = requirementAnalysis;
      // 仓库复用取决于实际现场，queued 恢复的会话标志不能触发重复 clone。
      const resuming = !!savedCwd && savedCwd !== workspace && existsSync(savedCwd);
      let cwd = workspace;
      let requirementPath = task.summary.requirement_document?.context_mode === "file"
        ? STORED_REQUIREMENT_DOCUMENT : undefined;
      let prompt = requirementContext(
        task.summary.requirement,
        task.summary.requirement_document,
        requirementPath,
      );
      let hostHooks;
      let repositorySkillPaths: string[] = [];
      let loadedRepositorySkillNames: string[] = [];
      let repositorySkillResources: Array<KnowledgeResourceRef & {
        actual_path: string;
      }> = [];
      let businessModuleKnowledge: MaterializedBusinessModuleKnowledge = {
        entries: [], skill_paths: [], warnings: [],
      };
      let hasDependencyHandoff = false;
      let knowledgeMaterialized = false;
      let activeWorkflowProfile = task.summary.workflow_profile;
      let workflowProfileMaterialized = !activeWorkflowProfile;
      let promptSteerCount = 0;
      task.cwd = savedCwd ?? cwd;
      if (this.options.host && analysisOnly) {
        const analysisRoot = resuming ? savedCwd! : join(workspace, "repositories");
        if (!resuming) {
          mkdirSync(analysisRoot, { recursive: true });
          const prepared = gitIdentity
            ? this.prepareHostGitSandbox(gitIdentity) : undefined;
          try {
            // for...of 而不是 forEach:cloneRepo 已异步,forEach 不等
            // async 回调,凭据会在克隆进行中被 finally 清掉。
            const repositories = task.summary.repositories ?? [];
            for (const [index, repository] of repositories.entries()) {
              // readonly:分析现场推送硬禁用(没有内核门禁兜底,禁令
              // 不能只写在 prompt 里)。
              await this.cloneRepo(analysisRoot, prepared, gitIdentity,
                repository, task.summary.baseline,
                `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`,
                true);
            }
          } finally {
            this.cleanupHostGitCredential(prepared);
          }
          const ticket = task.summary.ticket ?? task.summary.id;
          const artifactDir = join(analysisRoot, ".mae-flow-work", ticket);
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(join(artifactDir, ".ticket-id"), `${ticket}\n`);
        }
        cwd = analysisRoot;
        task.cwd = cwd;
        materializeRequirementAssets(
          workspace, cwd, task.summary.requirement_document);
        materializeRequirementSources(
          workspace, cwd, task.summary.requirement_document);
        // 批注附图与需求图片同命:现场重建后 Agent 工作区里得有(旁路)。
        materializeTaskAttachments(workspace, cwd);
        try { materializeReviewAssets(workspace, cwd); } catch { /* 图缺了页面仍能提示 */ }
        requirementPath = materializeRequirementDocument(
          cwd, task.summary.requirement, task.summary.requirement_document);
        // 恢复旧分析现场时也清除曾经持久化的 helper；每个仓仍可正常
        // fetch/read，但 pushurl 固定为不可写地址。
        (task.summary.repositories ?? []).forEach((repository, index) => {
          const repoDir = join(analysisRoot,
            `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`);
          this.hardenAgentGitBoundary(agentDir, repoDir);
        });
        const bindings = (task.summary.repositories ?? []).map(
          (repository, index) => ({
            repository,
            workspace: join(analysisRoot,
              `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`),
          }));
        const materialized = materializeRepositorySkills({
          selected: task.summary.repository_skills,
          bindings,
          snapshotRoot: join(analysisRoot, ".mae-flow-work", "repository-skills"),
          reservedNames: hostSkillNames(this.options.dataDir),
          blockedPaths: readResourceBlocks(this.options.dataDir),
        });
        this.freezeRepositoryNativeSkills(task, materialized);
        repositorySkillPaths = materialized.paths;
        loadedRepositorySkillNames = materialized.names;
        repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
          id: skill.id,
          kind: "skill" as const,
          name: skill.name,
          path: skill.relative_path,
          repository: skill.repository,
          description: skill.description,
          digest: skill.digest,
          selected: true,
          actual_path: path,
        }));
        for (const warning of materialized.warnings) {
          this.options.log?.(
            `[repository-resource] 任务 ${task.summary.id}: ${warning}`);
        }
        prompt = this.requirementAnalysisPrompt(task, cwd, requirementPath);
        if (resuming) {
          prompt = [
            prompt,
            "服务重启后继续需求理解；已有分析产物和代码现场都在，"
              + "不要从头推翻，先读取现有 Chain 文档并继续。",
            task.pendingResume
              ? "用户对上一个检视问题的答复如下，连同批注一起处理：\n\n"
                + renderDecision(task.pendingResume)
              : "",
            undeliveredInterrupts(workspace).length
              ? "重启前用户还补充了：\n\n"
                + undeliveredInterrupts(workspace).join("\n\n")
              : "",
          ].filter(Boolean).join("\n\n");
        }
      } else if (this.options.host) {
        if (resuming) {
          cwd = savedCwd!;
          await applyGitCommitIdentity(cwd, gitIdentity);
        } else {
          const prepared = gitIdentity
            ? this.prepareHostGitSandbox(gitIdentity) : undefined;
          try {
            cwd = await this.cloneRepo(workspace, prepared, gitIdentity,
              task.summary.repo_url, task.summary.baseline);
          } finally {
            this.cleanupHostGitCredential(prepared);
          }
        }
        if (!this.current(task, epoch)) return;
        task.cwd = cwd;
        materializeRequirementAssets(
          workspace, cwd, task.summary.requirement_document);
        materializeRequirementSources(
          workspace, cwd, task.summary.requirement_document);
        // 批注附图与需求图片同命:现场重建后 Agent 工作区里得有(旁路)。
        materializeTaskAttachments(workspace, cwd);
        try { materializeReviewAssets(workspace, cwd); } catch { /* 图缺了页面仍能提示 */ }
        requirementPath = materializeRequirementDocument(
          cwd, task.summary.requirement, task.summary.requirement_document,
          Boolean(task.summary.parent_task_id) || isMainTaskDelivery(task.summary));
        this.hardenAgentGitBoundary(agentDir, cwd);
        let deliveryUnitReady = false;
        try {
          hasDependencyHandoff = await this.materializeDependencyHandoff(task, cwd);
        } catch (cause) {
          this.options.log?.(
            `[cross-repo-handoff] 任务 ${task.summary.id} 交接生成失败(fail-open): ${cause}`);
        }
        if (!this.current(task, epoch)) return;
        const activeRepository = task.summary.repo_url
          ?? this.effectiveDefaultRepo();
        if (activeRepository) {
          const materialized = materializeRepositorySkills({
            selected: task.summary.repository_skills,
            bindings: [{ repository: activeRepository, workspace: cwd }],
            snapshotRoot: join(cwd, ".mae-flow-work", "repository-skills"),
            reservedNames: hostSkillNames(this.options.dataDir),
            blockedPaths: readResourceBlocks(this.options.dataDir),
          });
          this.freezeRepositoryNativeSkills(task, materialized);
          repositorySkillPaths = materialized.paths;
          loadedRepositorySkillNames = materialized.names;
          repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
            id: skill.id,
            kind: "skill" as const,
            name: skill.name,
            path: skill.relative_path,
            repository: skill.repository,
            description: skill.description,
            digest: skill.digest,
            selected: true,
            actual_path: path,
          }));
          for (const warning of materialized.warnings) {
            this.options.log?.(`[repository-skill] 任务 ${task.summary.id}: ${warning}`);
          }
        }
        // 先把任务固定知识投影到代码现场，再让内核 current 展示最终
        // 方案。否则 current 会点名一个尚不存在、甚至已损坏的路径。
        businessModuleKnowledge = materializeBusinessModuleKnowledge({
          selected: task.summary.business_modules,
          taskWorkspace: workspace,
          runtimeWorkspace: cwd,
        });
        for (const warning of businessModuleKnowledge.warnings) {
          this.options.log?.(
            `[business-module-knowledge] 任务 ${task.summary.id}: ${warning}`);
        }
        knowledgeMaterialized = true;
        // 仓库可在受版本控制的 .mae-flow-defaults.json 里声明一条
        // 「执行补充」。只在首次 clone 后读取一次,作为 repository 层
        // supplement 固定进 workflow_profile 并回写 task.json;之后
        // 恢复/重跑都沿用快照,不随仓库或管理设置漂移。坏配置只明确
        // 降级,不阻塞任务。必须先于 reconcile:两者都改 profile,
        // 后写会覆盖前写。(v1 独立文件通道已退役。)
        if (!task.summary.repository_supplement_resolved) {
          const resolved = resolveRepositorySupplement({
            workspace: cwd,
            repositoryId: activeRepository ?? task.summary.id,
          });
          if (resolved.supplement) {
            const others = (task.summary.workflow_profile?.supplements ?? [])
              .filter((item) => item.scope !== "repository");
            task.summary.workflow_profile = withWorkflowSupplements(
              task.summary.workflow_profile,
              [...others, resolved.supplement]);
          }
          task.summary.repository_supplement_resolved = true;
          if (resolved.warning) {
            task.summary.workflow_profile_warning = [
              task.summary.workflow_profile_warning, resolved.warning,
            ].filter(Boolean).join("；");
            this.options.log?.(
              `[workflow-profile] 任务 ${task.summary.id}: `
              + resolved.warning);
          }
          this.persist(task);
        }
        activeWorkflowProfile = reconcileWorkflowProfileAssets(
          task.summary.workflow_profile,
          businessModuleKnowledge.entries.map((item) => item.relative_path),
        );
        // 定格方案必须先于 bootstrapManaged 落地：bootstrap 会机械执行
        // init/current，内核要在第一条阶段指令里就读到它。文件是下单时
        // 固定的快照，不依赖 Cloud DB；失败不假装生效，后面会把同一份
        // 内容作为显式 prompt 兜底并留下日志。
        try {
          materializeWorkflowProfile(cwd, activeWorkflowProfile);
          workflowProfileMaterialized = true;
        } catch (cause) {
          this.options.log?.(
            `[workflow-profile] 任务 ${task.summary.id} 最终方案投影失败，`
            + `已退回显式 prompt（不影响开工）：${cause}`);
        }
        // 下单事实(.mae-flow-order.json,内核契约):表单收齐的单号/
        // 基线分支/工号/交付方式机械交给内核——config-review 拿它补
        // 缺省、确认卡不再问交付方式、workflow_select 免卡直接 done。
        // 光写进 prompt 靠模型转述不够:弱模型会漏、会把交付方式折成
        // 是/否卡再问一遍(车道实战教训)。交付方式写选项原文(label),
        // 内核认代号或原文全等。每次启动都重写(含重建会话):值来自
        // summary,幂等;fail-open——写不进去只记日志,流程退回转述
        // 老路,绝不拦启动。
        try {
          const loadedSkillNames = [
            ...(task.summary.team_skills ?? []).map((skill) => skill.name),
            ...loadedRepositorySkillNames,
          ];
          const utGenerationMethod = availableUtGenerationMethod(loadedSkillNames);
          // 镜像到任务台账:让"UT skill 有没有被指向"在界面可查,
          // 不用翻工作区内核文件。回退仓内写法且货架非空时点名说破
          // ——skill 上架了但命名没命中 UT 模式,是最隐蔽的一种失配。
          task.summary.ut_generation_method = utGenerationMethod;
          if (utGenerationMethod === "仓内既有写法") {
            if (loadedSkillNames.length) {
              this.options.log?.(
                `[ut-skill] 任务 ${task.summary.id}:本任务已装载 Skill`
                + `(${loadedSkillNames.join("、")})但没有命中 UT 命名模式,`
                + "「UT生成方式」回退为仓内既有写法;若这里面有 UT skill,"
                + "请改名为形如 java-autout/autout/xx-ut 的名字再上架");
            }
          }
          const order: Record<string, unknown> = {
            execution_contract: {
              ...CLOUD_EXECUTION_CONTRACT,
              continuous_review:
                this.options.host?.continuousReview === true,
              ...(this.options.host?.continuousReview === true ? {
                host_authority: ensureKernelHostCapability({
                  workspace,
                  taskId: task.summary.id,
                  cwd,
                }),
              } : {}),
            },
            "UT生成方式": utGenerationMethod,
          };
          if (requirementPath) order["需求文档"] = requirementPath;
          if (task.summary.ticket) order["单号"] = task.summary.ticket;
          if (task.summary.baseline) {
            order["基线分支"] = task.summary.baseline;
          }
          const badge = gitIdentity?.username ?? task.summary.luban_account;
          if (badge) order["工号"] = badge;
          // 下单事实只写首次配置。持续检视轮由 feedback-open 接续当前
          // 状态，不改交付方式、不生成第二张单。
          const lane = task.summary.lane;
          if (lane) order["交付方式"] = lane;
          // 子任务的任务书是执行入口；整体方案负责依赖上下文，原始需求
          // 只负责按需补充业务背景与验收语义。
          // 三份文件都在 Agent 看见代码前由宿主定格，不能再把任务书
          // 拼到几十万字原文末尾碰运气。旧子任务若只有 Chain，仍保留
          // 原有入口，重启迁移会尽力补齐任务书。
          const planSource = join(workspace, DELIVERY_CHAIN_SOURCE);
          const unitSource = join(workspace, DELIVERY_UNIT_SOURCE);
          if (existsSync(planSource)) {
            materializeDeliveryDocument(cwd, AGENT_DELIVERY_CHAIN,
              readFileSync(planSource, "utf-8"));
            order["需求文档"] = AGENT_DELIVERY_CHAIN;
          }
          if (existsSync(unitSource)) {
            materializeDeliveryDocument(cwd, AGENT_DELIVERY_UNIT,
              [dependencyScheduleContext(task.summary), readFileSync(unitSource, "utf-8")].filter(Boolean).join("\n\n"));
            order["需求文档"] = AGENT_DELIVERY_UNIT;
            deliveryUnitReady = existsSync(planSource)
              && Boolean(requirementPath);
          }
          writeFileSync(join(cwd, ".mae-flow-order.json"),
            JSON.stringify(order, null, 2) + "\n");
          // 平台的现场文件不该混进交付提交:登记进 .git/info/exclude
          // (不动仓里的 .gitignore——那是用户的文件)。
          const infoDir = join(cwd, ".git", "info");
          if (existsSync(infoDir)) {
            const excludePath = join(infoDir, "exclude");
            const current = existsSync(excludePath)
              ? readFileSync(excludePath, "utf-8") : "";
            // 内核会话产物也在此登记——不能指望业务仓的 .gitignore 认识
            // mae-flow(run9 实测:openspec/config.yaml 不在忽略里,prepush
            // 修复 Agent 为了收干净工作区,把它提交进了**用户的 .gitignore**
            // 并随 MR 推走,平台关切污染了用户仓)。
            const missing = [
              ".mae-flow-order.json", AGENT_DELIVERY_CHAIN,
              AGENT_DELIVERY_UNIT,
              ".mae-flow-dependencies.md", ".mae-flow-issue.md",
              AGENT_REQUIREMENT_DOCUMENT,
              ...FLOW_RUNTIME_LOCAL_EXCLUDES,
              "openspec/config.yaml",
            ]
              .filter((entry) => !current.includes(entry));
            if (missing.length) {
              writeFileSync(excludePath,
                `${current}${current && !current.endsWith("\n") ? "\n" : ""}`
                + missing.join("\n") + "\n");
            }
          }
        } catch (cause) {
          this.options.log?.(
            `[order] 下单事实写入失败(fail-open,退回 prompt 转述): ${cause}`);
        }
        const kernel = new KernelHost({
          kernelRoot: this.options.host.kernelRoot,
          workspace: cwd,
          fileAccessRoot: workspace,
          transcriptPath,
          taskId: task.summary.id,
          python: this.options.host.python,
          log: this.options.log,
        });
        // 首条 prompt = 需求 + 内核自己的开工引导(转发壳/init 指引),
        // 不由云端复述内核该说的话。重启后的 sessionstart 对内核是
        // 常态(老宿主重启会话同款),ACTIVE 状态下引导即当前步指引。
        const originalRequirementContext = requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          requirementPath,
        );
        const inheritedRequirement = deliveryUnitReady ? [
          mainTaskDeliveryContext(task.summary, cwd),
          "【当前交付单元 · 必读顺序】先完整读取 .mae-flow-unit.md。"
            + "它是当前任务的任务书和范围边界；然后读取"
            + " .mae-flow-chain.md 理解上下游，最后按需查阅"
            + " .mae-flow-requirement.md 核对用户原始需求。"
            + "后两份是背景与约束参考，不得据此擅自扩大当前单元范围。"
            + "三者冲突或任务书不足以落地时，明确指出冲突并停下来询问，"
            + "不要猜。",
          originalRequirementContext,
        ].join("\n\n") : originalRequirementContext;
        const requirementForAgent = continuationInstructions(task.summary)
          ? `${continuationInstructions(task.summary)}\n\n以下是历史背景材料：\n${inheritedRequirement}`
          : inheritedRequirement;
        const repairKernelOwnership = () => {
          if (!this.options.isolation) return;
          repairContainerKernelOwnership({
            workspace: cwd,
            user: this.options.isolation.user,
          });
        };
        // Cloud 已经明确创建了交付任务：宿主先机械 init/current，再让
        // 模型入场。检视/流水线/冲突返工必须在此之前由可信宿主执行
        // feedback-open；bootstrap 永远不从 terminal 重开配置单。
        const bootstrap = kernel.bootstrapManaged(requirementForAgent);
        task.kernelBootstrap = bootstrap;
        let guidance: string;
        try { guidance = await bootstrap; }
        finally { if (task.kernelBootstrap === bootstrap) task.kernelBootstrap = undefined; }
        repairKernelOwnership();
        if (!this.current(task, epoch)) return;
        prompt = guidance
          ? `${requirementForAgent}\n\n${guidance}`
          : requirementForAgent;
        if (resuming) {
          // 重启期间收到的决定,正文必须随重建会话一起给模型。
          //
          // 踩过的坑(用户实测):批注随决定提交后,模型回来说"你上次点了
          // 需要调整代码,但具体意见没有落盘"。查下来是真的:injectDecision
          // 只把答复写进事件日志/transcript(我们的账)并经 posttooluse 交给
          // 内核,而内核那条通道只认结构化选项;`messages` 看的是
          // UserPromptSubmit 捕获的普通用户消息,工具答复的正文不在里面。
          // 重建会话又没有挂起的工具调用可 resolve——于是选项到了、理由丢了,
          // 模型只能空手回来再问一遍。用户的话必须由我们自己送到。
          const answered = task.pendingResume
            ? renderDecision(task.pendingResume) : "";
          const unsaid = undeliveredInterrupts(workspace);
          const continuingFeedback = Boolean(
            task.mission && task.summary.delivery?.mr_url);
          prompt = [
            requirementForAgent,
            guidance,
            "执行会话继续，原上下文是否恢复以宿主的会话恢复说明为准。" +
            "流程真相以内核状态为准。执行 current 核对当前步骤，不重做已经完成的工作;" +
            "已登记的用户答复直接沿用(执行 messages 查看)，仍待答复的问题保留;" +
            (continuingFeedback
              ? "不要重复提问;沿用现有现场完成本轮反馈并交还宿主验证。"
              : "不要重复提问;继续推进首次交付流程。"),
            answered
              ? "用户对上一个问题的答复原文如下,按它继续,不要再问一遍:\n\n"
                + answered
              : "",
            unsaid.length
              ? "重启前用户还插话说了下面这些,一并按它办:\n\n"
                + unsaid.join("\n\n")
              : "",
          ].filter(Boolean).join("\n\n");
        }
        hostHooks = {
          preTool: async (event) => {
            const result = await kernel.preTool(event);
            repairKernelOwnership();
            return result;
          },
          postTool: async (event) => {
            const result = await kernel.postTool(event);
            repairKernelOwnership();
            return result;
          },
          flush: kernel.flush.bind(kernel),
        };
      } else if (resuming || task.resume) {
        // 非内核模式(演练/测试)同样不许丢话:重建会话没有挂起的工具
        // 调用可 resolve,决定正文只能由这条 prompt 送到模型眼前。
        prompt = [
          `服务重启,继续任务:${requirementContext(
            task.summary.requirement,
            task.summary.requirement_document,
            requirementPath,
          )}`,
          task.pendingResume
            ? "用户对上一个问题的答复原文如下,按它继续,不要再问一遍:\n\n"
              + renderDecision(task.pendingResume)
            : "",
          ...(undeliveredInterrupts(workspace).length
            ? ["重启前用户还插话说了下面这些,一并按它办:\n\n"
               + undeliveredInterrupts(workspace).join("\n\n")]
            : []),
        ].filter(Boolean).join("\n\n");
      }
      if (!knowledgeMaterialized) {
        businessModuleKnowledge = materializeBusinessModuleKnowledge({
          selected: task.summary.business_modules,
          taskWorkspace: workspace,
          runtimeWorkspace: cwd,
        });
        for (const warning of businessModuleKnowledge.warnings) {
          this.options.log?.(
            `[business-module-knowledge] 任务 ${task.summary.id}: ${warning}`);
        }
        activeWorkflowProfile = reconcileWorkflowProfileAssets(
          task.summary.workflow_profile,
          businessModuleKnowledge.entries.map((item) => item.relative_path),
        );
      }
      const workflowSupplement = workflowProfilePrompt(
        activeWorkflowProfile);
      if (workflowSupplement
          && (analysisOnly || !this.options.host
              || !workflowProfileMaterialized)) {
        prompt = `${prompt}\n\n${workflowSupplement}`;
      }
      if (task.summary.workflow_profile_warning) {
        prompt = `${prompt}\n\n⚠ ${task.summary.workflow_profile_warning}`;
      }
      // 本地 UT、宿主验证和流水线各自记事实。阶段性发布可以独立发起，
      // 不把正常交付流程的验证顺序误写成所有宿主工具的使用前提。
      if (this.options.host && !analysisOnly) {
        const utGenerationMethod = availableUtGenerationMethod([
          ...(task.summary.team_skills ?? []).map((skill) => skill.name),
          ...loadedRepositorySkillNames,
        ]);
        task.summary.ut_generation_method = utGenerationMethod;
        prompt = `${prompt}\n\nCloud 执行契约(宿主事实):你的 Bash 在隔离容器中执行,`
          + `容器里可以自由编译、运行单测来验证自己的改动——有构建链就`
          + `尽管用,没有就如实说明留给流水线,不要为编译环境卡住。`
          + `你可以自主编译和运行 UT，无需等待审批；编译和 UT 应在编码过程中按改动影响及时执行，复用仍有效的验证，`
          + `不要等最终交付。平台保留基线预热，但交付前不会自动补跑 Build-Fix；`
          + `需要独立验证时才主动调用 retry_verification。记录命令、范围、版本和结果，`
          + `改动影响已有结论时补验；未执行、失败或环境缺失如实说明。`
          + `基线预热、本次改动的 UT、按需 Build-Fix 和绑定 SHA 的权威流水线结果分别如实记录,`
          + `不能互相冒充;反馈最终处置由责任人决定。可用的 UT 编写方式是「${utGenerationMethod}」,`
          + `写测试前先按它读取对应 skill 或仓内写法。不要编造命令、结果、`
          + `数量或绿灯。代码提交用任务容器的 Git;已有任务授权内可随时用`
          + `task_control push/create_mr 阶段性发布,无需先修完所有旧问题。`
          + `验证可用 retry_verification,流水线用 task_pipeline;缺少能力如实说明。`
          + `宿主工具 queued 后结束本轮,由 Cloud 执行并把真实结果带回原会话；不需要重新开工或全量检查现场。`
          + `不要读取或索要 Git 令牌。较新的责任人要求优先,明确不再处理的`
          + `反馈逐条 defer_feedback;保留失败事实,不把暂缓或推送当成验证通过。`;
      }
      if (hasDependencyHandoff) {
        prompt = `${prompt}\n\n本任务有跨仓前置交付。开始设计、改接口或实现前，`
          + `必须先读取 .mae-flow-dependencies.md，并用它核对最初 Chain 契约。`
          + `发现上游实际交付、当前实现或契约互相冲突时，停止猜测并举卡，`
          + `明确写出受影响的仓库、接口与需要谁确认；不要自行发明兼容方案。`;
      }
      this.syncCrossRepositoryUpdates(task);
      const collaboration = crossRepositoryUpdateContext(task);
      if (collaboration) prompt += `\n\n${collaboration}`;
      if (!analysisOnly && loadedRepositorySkillNames.length) {
        prompt = `${prompt}\n\n本单已启用仓库自带 Skill：`
          + `${loadedRepositorySkillNames.join("、")}。它们是可选工作指南，`
          + `请根据系统能力目录中的 description 自行判断何时读取；不要求`
          + `逐个使用，也不得用 Skill 改写 Mae-Flow 当前步骤、文件边界、`
          + `Git 权限、Cloud 执行契约或任何验证/交付证据。`;
      }
      if (!analysisOnly) {
        prompt = `${prompt}\n\n仓库根目录下的 Agent 平台目录（`
          + `${describeAgentPlatformRoots()}）可能由中心能力服务在 clone 后`
          + `临时注入，只供本工作区运行。可以读取系统明确装载的 Skill，`
          + `但不要修改、删除、强制 git add 或提交这些目录，也不要为了`
          + `隐藏它们修改业务仓 .gitignore；Cloud 已登记本地忽略并会在`
          + `push 前复核整个提交历史。`;
      }
      // 提交信息规范(部署级):平台的 pre-receive 钩子会按正则拒收不
      // 合规的提交信息——内网实测被拒过一次("does not match the
      // regular-expression"),而那时代码早已写完,重来一遍是纯浪费。
      // 规矩必须开场就给,每个会话都带:修复会话同样要提交。
      const convention = this.effectiveCommitConvention();
      if (!analysisOnly && convention) {
        prompt = `${prompt}\n\n提交信息规范(平台钩子会按它校验,不合规`
          + `直接拒收 push,请第一次就写对):${convention}`;
      }
      // 交付方式的预答契约要**开场就告诉模型**:预答机制只认"标准卡"
      // (选项原文里含有用户选的那一项)。不说这句,模型有它自己的好心
      // ——从需求原文猜到用户想局部修改,就自造一张"是否选择局部修改?"
      // 的是/否卡(内网实测),而是/否里没有选项原文,预答对不上号,
      // 卡真去等人:用户明明下单时答过,中途又被问一遍。宿主不替内核
      // 判卡(是/否算不算数是内核的事),但可以不让模型把卡出歪。
      // 配置事实(用户下单时已给):单号/基线分支/工号不再让模型开口
      // 问——配置确认"一次问一项事实"的前提是事实缺席,这些没缺。取值
      // 口径仍归内核(REQ→feat/DTS→fix 的推导、分支名派生都是它的判定,
      // 宿主只递事实);确认卡照出,用户最终把关的那一道不省。
      const continuingFeedback = Boolean(
        task.mission && task.summary.delivery?.mr_url);
      const facts: string[] = [];
      if (task.summary.ticket) facts.push(`单号:${task.summary.ticket}`);
      if (task.summary.baseline) {
        facts.push(`基线分支:${task.summary.baseline}`);
      }
      if (gitIdentity) {
        facts.push(`工号(git 用户名,已写进仓库配置):${gitIdentity.username}`);
      }
      if (!continuingFeedback && !analysisOnly && this.options.host && facts.length) {
        prompt = `${prompt}\n\n配置事实(用户下单时已提供,配置确认直接`
          + `采用,不要再逐项询问):${facts.join(";")}。其余配置项照`
          + `内核口径取值或询问。`;
      }
      // 交付方式已由下单事实文件交给内核:内核 current 会自己下指令
      // (已选定则"直接 done --choice 不出卡";旧快照没这契约则照旧
      // 举卡)。prompt 只补一句立场,具体怎么走听内核的——两种内核
      // 版本都不矛盾。唯一要钉死的是不许自造"是/否"卡:选项原文对
      // 不上号,预答接不住,只能真去等人(内网实测)。
      const activeLane = task.summary.lane;
      if (!continuingFeedback && !analysisOnly && this.options.host && activeLane) {
        prompt = `${prompt}\n\n交付方式用户已在下单时选定:`
          + `${activeLane}(已写入工作区下单事实,内核能读到)。`
          + `流程走到交付方式选择时**严格照内核指令执行**:内核说直接`
          + ` done --choice 就直接执行,内核要求出卡就**原样列出标准`
          + `选项**(系统会替用户选中含「${activeLane}」的那一`
          + `项)。禁止自造"是/否"确认卡,禁止替用户改选。`;
      }
      if (task.pendingAssistantHandoff) {
        prompt = `${prompt}\n\n${task.pendingAssistantHandoff}`;
      }
      if (task.pendingMainSteers?.length) {
        promptSteerCount = task.pendingMainSteers.length;
        prompt = `${prompt}\n\n主任务启动前或暂停前尚未读取的用户补充（按原始顺序优先处理）：\n`
          + task.pendingMainSteers.map((text) => `- ${text}`).join("\n");
      }
      // 专项使命(修复环)压轴:模型最后读到的最要紧。这里只用不清——
      // 修复会话跑一半被重启,使命要跟着 task.json 回来再喂一遍;
      // 清账在 settle 收口处,会话真做完了才算消费掉。
      if (task.mission) prompt = `${prompt}\n\n${task.mission}`;
      prompt = [prompt, dependencyScheduleContext(task.summary)].filter(Boolean).join("\n\n");
      prompt += `\n\n${taskHostGoal(this.taskHostRuntime(task, epoch))}`;
      // 容器隔离:bash 进任务专属容器(工作区同路径挂载),
      // 起不来直接抛=任务 failed——静默降级回宿主是假隔离。
      if (this.options.isolation) {
        // 工作区记在任务上:防御性重建必须挂回同一个目录，需求理解单
        // 的 cwd 是 repositories/，普通任务则是仓库根。
        task.containerWorkspace = cwd;
        task.container = await this.startCodingContainer(task);
        if (!this.current(task, epoch)) {
          await task.container.stop().catch(() => undefined);
          task.container = undefined;
          return;
        }
      }
      if (await this.finishHostAction(task, epoch) || !this.current(task, epoch)) return;
      if (task.summary.parent_task_id) this.startBaselineWarmup(task, epoch);
      task.driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: cwd,
        agentDir,
        additionalSystemInstructions: [COMMIT_CONTENT_GUIDANCE],
        repositoryResourceBlocks: () =>
          readResourceBlocks(this.options.dataDir),
        // 任务记忆：检索工具与每轮临时上下文，故障不阻塞模型。
        // 拆分提议:只给单仓直接开发的主任务。
        extraTools: [...(this.memoryTools(task) ?? []), ...this.splitTools(task), ...createTaskHostTools(this.taskHostRuntime(task, epoch))],
        componentKnowledge: this.componentKnowledge(task),
        memoryContext: () => this.taskMemoryContext(task),
        componentAnalysisContext: () => this.componentAnalysisContext(task),
        // 分析卡上残留的 repo-N 序号机械换成仓库名(prompt 已按名称呼,
        // 这是第二道)。编码会话没有序号清单,不挂。
        humanizeQuestionText: analysisOnly
          ? (text) => humanizeRepositoryIds(text, this.analysisRepositoryNames(task))
          : undefined,
        // 举卡前核对(2026-09-05):检视意见没处理完不许举确认卡,只放行
        // 合规的澄清卡;拦下的话作为工具错误回给模型,原会话继续。
        prepareHumanQuestion: (input) => reviewDecisionContract(requirementDecisionContract(input, this.isRequirementAnalysis(task)), stepChoiceEffects(this.options.host?.kernelRoot, this.reviewContractStep(task, undefined))).question,
        beforeHumanQuestion: (input) => this.beforeReviewQuestion(task, input),
        humanFacing: true,
        // 宿主级 skill:<数据目录>/skills 放一次,每个任务都带
        // (团队的 UT 写法指南在内网,老宿主靠手动集成进子 agent)。
        hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
        knowledgeModuleDataDir: this.options.dataDir,
        knowledgeContext: task.summary.host_skills_pinned ? undefined : {
          repositories: task.summary.repositories ?? [],
          technologies: [...new Set((task.summary.repository_profiles ?? [])
            .flatMap((profile) => profile.technologies))],
          businessModuleIds: (task.summary.business_modules ?? [])
            .map((module) => module.id),
        },
        repositorySkillPaths,
        repositorySkillResources,
        businessModuleKnowledge,
        knowledgeTrace: this.knowledgeTrace(task, cwd),
        currentStep: () => this.currentStepLabel(task),
        // 上下文撑爆时自愈压缩用的锚:与主动压缩同一个内核现场,
        // 摘要围绕"当前步骤+已确认配置"组织,不由云端编造。
        compactAnchor: () => this.kernelAnchor(task),
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        vision: this.taskVision(task),
        // 任务级选择 > 解析咽喉(设置层默认 > 部署默认);任务级的记在
        // summary 上,重启续跑/会话重建都不漂移(设置层后来改了也不影响
        // 本单);个人网关命中时模型以个人网关为准,model_choice 让位
        // (ADR-0068,承 Beta 旧例)。
        provider: modelBundle.choice?.provider ?? this.options.provider,
        model: modelBundle.choice?.model ?? this.options.model,
        eventLog: new EventLog(
          join(workspace, "events.jsonl"),
          (event) => this.bypass(
            task, "投影事件", this.options.projection?.appendEvent(event))),
        transcript: new TranscriptStore(transcriptPath, "main"),
        resumeSession: task.resume === true && (resuming || !this.options.host),
        gate: new GateService({
          contract: analysisOnly
            ? createRequirementAnalysisGateContract(
                cwd,
                join(cwd, ".mae-flow-work", task.summary.ticket
                  ?? task.summary.id),
                this.options.contract, this.reviewReceiptsPath(task),
              )
            : this.options.contract,
          // 边界=整个任务工作区(修复材料在仓外的 ../pipeline、../reviews);
          // 相对路径仍按会话 cwd(代码仓)解析。
          workspace,
          cwd,
          log: this.options.log,
          failClosed: Boolean(this.options.host),
        }),
        humanGate: task.humanGate,
        hostHooks: withLiveReviewReceipts(hostHooks, {
          current: () => this.current(task, epoch),
          list: () => this.annotations(task).list(),
          consume: () => this.consumeReviewProcessingReceipts(task),
          log: (message) => this.options.log?.(`任务 ${task.summary.id} 运行中回执：${message}`),
        }),
        bashOperations: task.container
          ? {
              // 不锁死开场那个容器实例:等人期间它会被释放,这里必须
              // 每次现取,取不到就现开(开不起来照样抛,不回宿主)。
              exec: async (command, dir, execOptions) =>
                (await this.activeTaskContainer(task))
                  .exec(command, dir, execOptions),
            }
          : undefined,
        afterFileMutation: this.options.isolation
          ? (path) => {
            repairTaskAgentFileOwnership({
              workspace, cwd, path,
              feedbackResult: this.activeFeedbackResult(task)?.path,
              user: this.options.isolation?.user,
            });
          }
          : undefined,
        log: this.options.log,
      });
      if (!this.current(task, epoch)) {
        task.driver.dispose();
        task.driver = undefined;
        await (task.container?.stop() ?? Promise.resolve())
          .catch(() => undefined);
        task.container = undefined;
        return;
      }
      if (task.summary.status === "pausing") {
        await this.finishPause(task, "running");
        return;
      }
      if (!task.summary.parent_task_id) this.startBaselineWarmup(task, epoch);
      // 重建会话:恢复期收到的决定先补登记(tool_result 与崩溃前的
      // tool_use 行 join,答案进内核台账),再从内核 current 续跑。
      // 内核模式下克隆丢失=现场没了,决定无处可注,只能从头来。
      const rebuild = task.resume === true
        && (resuming || !this.options.host);
      const pending = task.pendingResume;
      task.resume = false;
      task.pendingResume = undefined;
      if (rebuild && pending) {
        task.driver.injectDecision(pending);
      } else if (pending) {
        this.options.log?.(
          `任务 ${task.summary.id} 工作区丢失,决定无法回注,从头执行`);
      }
      if (pending) this.persist(task);
      // 持久化使命可能来自旧版本；开场再次下发当前唯一回执地址。
      const pendingReviews = pendingReviewProcessing(this.annotations(task).list());
      if (pendingReviews.length) prompt += `\n\n${this.reviewReceiptInstructionsFor(task, pendingReviews)}`;
      if (task.summary.delivery?.git_push?.sha) scopePipelineArtifacts(join(workspace, "pipeline"), task.summary.delivery.git_push.sha);
      prompt += `\n\n${taskAgentMaterialInstructions(workspace)}`;
      prompt += `\n\n${this.activeFeedbackReceiptInstructions(task)}`;
      const turn = rebuild
        ? task.driver.startResume(prompt)
        : task.driver.start(prompt);
      // prompt 构造之后、driver 就绪之前仍可能收到人工检视。构造前已有
      // 的内容已经随 prompt 送达；窗口内新到的内容在同一只 Agent 上
      // steer，不能因为启动竞态再开第二只会话抢工作区。
      const lateSteers = (task.pendingMainSteers ?? []).slice(promptSteerCount);
      // start/startResume 已同步把 prompt 交给会话；到这里才消费一次性
      // 交还摘要。若此前进程退出，task.json 仍保留它，下次不会丢。
      if (task.pendingAssistantHandoff || task.pendingMainSteers?.length) {
        task.pendingAssistantHandoff = undefined;
        task.pendingMainSteers = undefined;
        this.writeTaskState(task);
      }
      for (const message of lateSteers) {
        await task.driver.steer(message);
      }
      await this.settle(task, turn, epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      const driver = task.driver;
      if (task.driver === driver) task.driver = undefined;
      driver?.dispose();
      const cleanupFailure = await this.stopTaskContainer(task, "启动失败后");
      if (!this.current(task, epoch)) return;
      task.summary.status = "failed";
      task.summary.detail = [String(error), cleanupFailure]
        .filter(Boolean).join("；");
      this.persist(task);
      this.options.log?.(`任务 ${task.summary.id} 启动失败: ${String(error)}`);
    }
  }

  /** 平台请求的个人身份头:适配层拿它调 CLI,MR 发起人=任务归属人;
   * 没配令牌的回落适配层的服务账号。percent 编码防非 ASCII 撞 HTTP
   * 头限制;**令牌只进请求头,绝不进请求体**——体会被外部动作台账
   * 原样记进投影,头不会。 */
  private platformIdentity(task: TaskState): Record<string, string> {
    const credential =
      this.options.gitCredential?.(task.summary.luban_account);
    if (!credential) return {};
    return {
      "x-mfc-git-user": encodeURIComponent(credential.username),
      "x-mfc-git-token": encodeURIComponent(credential.password),
    };
  }

  /** external_verify 之后的异常不是“交付旁路失败也算完成”。内核正在
   * 明确等待宿主核销三项质量义务，任何缺口都只能留在 verifying。 */
  private holdExternalVerification(task: TaskState, reason: string): void {
    // 已停摆：保留“需要你介入”的原因给人看。迟到的交付尝试或流水线
    // 观察不能把它盖成一次普通失败，否则页面看不出自愈预算已耗尽。
    if (task.summary.delivery?.stalled) return;
    task.summary.status = "verifying";
    task.summary.detail = reason;
    task.summary.delivery = {
      ...task.summary.delivery,
      mr_state: task.summary.delivery?.mr_state ?? "验证中",
      waiting_on: reason,
    };
    this.persist(task);
  }

  /** 外部验证的自愈预算:第一次挂起时开表,之后每次续命都对表。
   *
   * 为什么要有:等待点上的每一次挂起都可能是暂时的(内网 push 504、
   * MR 网关抖、内核登记撞上并发),值得自己再试;但"再试"没有尽头就
   * 是死等——本仓的红线写死了凡等待必须带预算。预算沿用轮询那一档
   * (默认 30 分钟),不另立旋钮。 */
  private verificationDeadline(task: TaskState): number {
    const delivery = task.summary.delivery;
    const { deadline, opened } = resolveVerifyDeadline(
      delivery?.verify_deadline, Date.now(),
      verificationBudgetMs(this.options.settings?.runtime() ?? {},
        this.options.delivery));
    if (opened) {
      task.summary.delivery = {
        ...delivery,
        verify_deadline: new Date(deadline).toISOString(),
      };
    }
    return deadline;
  }

  /** 自愈到头了:如实停下、写清原因、喊人。任务留在 verifying(代码
   * 确实已提交,不能假装 failed 也不能假装完成),但从此 retry 放行、
   * 页面亮牌子——人办完外部的事点「重跑续推」,机器接着干。 */
  private markVerificationStalled(
    task: TaskState,
    reason: string,
    cls: StallClass,
  ): void {
    clearTimeout(task.deliveryRecoveryDeadlineTimer);
    task.deliveryRecoveryDeadlineTimer = undefined;
    reason = reason.replace(/[；;]\s*系统正在自动重试.*$/, "");
    const delivery = task.summary.delivery;
    if (delivery?.stalled === reason && delivery.stall_class === cls) {
      if (delivery.skipped) {
        delete delivery.skipped;
        this.persist(task);
      }
      return; // 同原因不重复通知，但新原因必须能覆盖旧诊断。
    }
    task.summary.status = "verifying";
    task.summary.detail = stallDetail(reason);
    task.summary.delivery = {
      ...delivery,
      ...stallWrite(delivery?.mr_state, reason, cls),
      skipped: undefined,
    };
    this.persist(task);
    this.notifyVerificationStalled(task, reason, cls);
  }

  /** 每一次停摆都得有人知道。原来只调 notifyRepairStopped,而它在没有修复
   * 环时直接返回——24 处停摆里多数没有修复环,于是页面亮牌子、手机没动静
   * (2026-09-06 盘账)。修复环的停摆仍走原措辞;其余按类别说清该干什么。
   * 幂等键带原因摘要:人重试后同类别换了原因再停,要再喊一次。 */
  private notifyVerificationStalled(
    task: TaskState,
    reason: string,
    cls: StallClass,
  ): void {
    if (task.summary.delivery?.loop) {
      this.notifyRepairStopped(task);
      return;
    }
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    if (!notifier || !account) return;
    const notice = stallNotice(reason, cls);
    this.bypass(task, "停摆通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: notice.status,
      summary: notice.summary,
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  /** 挂起=先自愈再说:排一次带预算的重试;预算到了就停下喊人。
   * 停摆之后不再自动重排——人点了「重跑续推」才重新开表。 */
  private holdWithRecovery(
    task: TaskState,
    reason: string,
    epoch: number,
  ): void {
    if (task.summary.delivery?.stalled) {
      // 停摆后不再改动用户可见原因：迟到的在途尝试不能把“需要你介入”
      // 盖成一次普通失败，等人点「重跑续推」再重新开表。
      return;
    }
    const deadline = this.verificationDeadline(task);
    this.holdExternalVerification(task, reason);
    if (Date.now() >= deadline) {
      this.markVerificationStalled(task, reason, "infrastructure");
      return;
    }
    this.scheduleDeliveryRecovery(task, epoch);
  }

  /** 交付侧的带预算重试(推送/MR/流水线触发失败走这条)。
   *
   * 对表由这条循环自己拿着,不能指望 tryDeliver:内核停在 end 时它
   * 的 catch 根本不挂起(那是 external_verify 才走的分支),于是只会
   * 试一次就散——测试逮住过。 */
  private scheduleDeliveryRecovery(task: TaskState, epoch: number): void {
    // 到期检查独立于请求返回；发件箱损坏仍沿用原来的持续探测策略。
    if (!this.reviewReplyOutboxStalled(task)) {
      const deadline = this.verificationDeadline(task);
      const expected = task.summary.delivery?.verify_deadline;
      clearTimeout(task.deliveryRecoveryDeadlineTimer);
      task.deliveryRecoveryDeadlineTimer = setTimeout(() => {
        task.deliveryRecoveryDeadlineTimer = undefined;
        if (this.current(task, epoch) && task.summary.status === "verifying"
            && task.summary.delivery?.verify_deadline === expected
            && !task.summary.delivery?.stalled && !this.reviewReplyOutboxStalled(task)
            && task.summary.delivery?.pipeline !== "running") {
          this.markVerificationStalled(task, this.stallReason(task), "infrastructure");
        }
      }, Math.max(0, deadline - Date.now()));
      task.deliveryRecoveryDeadlineTimer.unref();
    }
    if (task.deliveryRecoveryActive) return;
    task.deliveryRecoveryActive = true;
    const delay = recoveryDelayMs(
      this.options.settings?.runtime() ?? {}, this.options.delivery);
    const timer = setTimeout(() => {
      task.deliveryRecoveryActive = false;
      this.bypass(task, "交付自愈重试", this.runDeliveryRecovery(task, epoch));
    }, delay);
    timer.unref();
  }

  private async runDeliveryRecovery(
    task: TaskState,
    epoch: number,
  ): Promise<void> {
    if (!this.recoveryStillNeeded(task, epoch)) return;
    if (this.reviewReplyOutboxStalled(task)) {
      const readable = await this.flushReviewReplyOutbox(task);
      if (!readable || this.reviewReplyOutboxStalled(task)) {
        // 账本损坏不是一次性网络抖动，也不受普通验证超时预算限制；
        // 管理员可原地修复，服务在同一进程持续探测并自动续接。
        this.scheduleDeliveryRecovery(task, epoch);
        return;
      }
      if (this.current(task, epoch)
          && task.summary.status === "verifying") {
        await this.tryDeliver(task, epoch);
      }
      return;
    }
    // 因"内核暂时不可用"挂起的,先把没登记成的逐条回执补上再交付:回执
    // 材料在工作区文件里,登记按结果摘要幂等,不需要再叫 Agent。仍不可用
    // 就在预算内续等;换成别的原因(回执本身不合格)才如实停下叫人。
    if (heldForKernelUnavailable(task.summary.delivery?.waiting_on)) {
      const failure = this.recordActiveFeedbackResult(task);
      if (failure) {
        // 分类只有一处(deliveryFailure),出路只有一张表(deliveryRecovery),
        // 这里只负责执行。截止惰性取:只有"重放有意义"才该开表,派单/停摆
        // 的路上开了表会留到下一轮验证里白吃预算。
        const route = routeReceiptFailure(failure, Date.now(),
          () => this.verificationDeadline(task));
        if (route.kind === "hold") {
          this.holdExternalVerification(task, failure);
          this.scheduleDeliveryRecovery(task, epoch);
        } else if (route.kind === "dispatch") {
          // 这批还没人处理过(派单和重启撞上了),不是回执不合格:重新派给
          // 修复会话,不能拿"Agent 没有留下回执"把任务停在这儿等人。派单后
          // 状态转 queued,recoveryStillNeeded 不再成立,不会自旋。
          this.enqueueRepair(task,
            "本批持续检视反馈还没有被处理过：上一次派单被中断，现场已恢复。"
            + "请按下面的反馈清单逐条处理，并写出机器可核对的逐条回执。",
            "反馈批次尚未处理，已重新派给修复会话");
        } else {
          this.markVerificationStalled(task, failure, route.stall_class);
        }
        return;
      }
    }
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task), "infrastructure");
      return;
    }
    await this.tryDeliver(task, epoch);
    if (!this.recoveryStillNeeded(task, epoch)) return;
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task), "infrastructure");
      return;
    }
    this.scheduleDeliveryRecovery(task, epoch);
  }

  /** 停摆要说当前病因；成功接续与明确的新停摆会清除旧 skipped。 */
  private stallReason(task: TaskState): string {
    return stallReasonOf(task.summary.delivery, task.summary.detail);
  }

  /** 还该不该我管:别人在盯的(流水线轮询、证据核销重试)让它盯,
   * 已经走出验证中或已如实停摆的收手——两条自愈链不许互相踩。 */
  private recoveryStillNeeded(task: TaskState, epoch: number): boolean {
    const current = this.current(task, epoch);
    const stalled = Boolean(task.summary.delivery?.stalled);
    return stillNeedsRecovery({
      current,
      status: task.summary.status,
      stalled,
      outboxStalled: current && task.summary.status === "verifying"
        && stalled && this.reviewReplyOutboxStalled(task),
      pipeline: task.summary.delivery?.pipeline,
      evidenceRetryActive: Boolean(task.evidenceRetryActive),
      repairEvidenceRetryActive: Boolean(task.repairEvidenceRetryActive),
    });
  }

  /** INCOMPLETE / STALE / 登记抖动都是宿主等待，不得把 Agent 催回来
   * “补证据”。同 SHA 只刷新平台事实并重做内核 record；仅 STALE（本地
   * HEAD 已变化）回 tryDeliver，让宿主推新 HEAD 并启动对应的新流水线。
   * timer unref，不吊住进程；重启由 recover 的 verifying+success 分支
   * 重新挂起。 */
  private schedulePipelineEvidenceRetry(
    task: TaskState,
    sha: string,
    epoch: number,
    stale: boolean,
  ): void {
    if (task.evidenceRetryActive) return;
    if (task.summary.delivery?.stalled) return;
    // 核销重试也吃同一份预算:平台把某个 job 报成 skipped/manual 时
    // 它永远不会变绿,原来会每 10 秒拉一个内核子进程一直转到天荒地老。
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task), "evidence_missing");
      return;
    }
    task.evidenceRetryActive = true;
    const delay = recoveryDelayMs(
      this.options.settings?.runtime() ?? {}, this.options.delivery);
    const timer = setTimeout(() => {
      task.evidenceRetryActive = false;
      if (!evidenceRetryStillValid({
        current: this.current(task, epoch),
        status: task.summary.status,
        sha: task.summary.delivery?.sha,
        expectedSha: sha,
        pipeline: task.summary.delivery?.pipeline,
        stale,
      })) return;
      this.bypass(task, "流水线证据自动重试", stale
        ? this.tryDeliver(task, epoch)
        : this.retryPipelineEvidence(task, sha, epoch));
    }, delay);
    timer.unref();
  }

  /** 同 SHA 只查已有 run 并重做 record，绝不 POST trigger。查询短暂失败
   * 时仍可用上次已落袋的整体状态重试登记。 */
  private async retryPipelineEvidence(
    task: TaskState,
    sha: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)
        || task.summary.status !== "verifying"
        || task.summary.delivery?.sha !== sha) return;
    let status: "success" | "failed" = "success";
    let checks = task.summary.delivery.checks;
    let log = "";
    try {
      const repo = encodeURIComponent(
        task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
      const mrId = task.summary.delivery?.mr_id;
      const result = await fetch(
        `${this.effectivePlatformUrl()}/pipeline/status`
        + `?sha=${sha}&repo=${repo}`
        + (mrId !== undefined
          ? `&mr=${encodeURIComponent(String(mrId))}` : ""),
        { headers: this.platformIdentity(task) }).then((r) => readJson(r));
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying") return;
      // 与主轮询同一道防过期结果核验:重试登记也不许拿别的提交的灯凑数。
      const allRuns = Array.isArray(result.runs) ? result.runs : [];
      const latestRuns = allRuns.length ? [allRuns.at(-1)!] : [];
      const terminal = selectTerminalRun<Record<string, unknown> & {
        status?: string; sha?: string; is_valid?: boolean;
      }>(latestRuns, sha).run;
      if (allRuns.length && !terminal) {
        // 查询成功且最新 run 明确尚未形成可接收终态时，不能回退复用
        // 上一次 success；把任务重新交给常规轮询，等这次最新 run。
        task.summary.delivery = {
          ...task.summary.delivery,
          pipeline: "running",
          skipped: undefined,
        };
        this.persist(task);
        this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
        return;
      }
      if (terminal) {
        status = terminal.status === "failed" ? "failed" : "success";
        checks = parsePipelineChecks(terminal.checks);
        log = String(terminal.log ?? "");
        task.summary.delivery = {
          ...task.summary.delivery,
          pipeline: status,
          skipped: undefined,
          ...(checks !== undefined ? { checks } : {}),
        };
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 流水线证据刷新失败(仍重试登记): ${String(error)}`);
    }
    await this.pipelineVerdict(task, sha, status, log, checks, epoch);
  }

  /** 读取真正准备传输的 Git 提交。git push 只传 HEAD 可达对象，工作区
   * 的未提交/未跟踪文件不会进入远端；PASS 因此只绑定 SHA，不再用
   * `git status` 把编译产物误当成 push 阻断条件。 */
  private async prePushRevision(task: TaskState): Promise<PrePushRevision> {
    if (!task.cwd) throw new Error("任务没有代码工作区，不能执行 Build-Fix");
    const head = await runSafeWorktreeGitAsync(
      task.cwd, ["rev-parse", "--verify", "HEAD"], { timeoutMs: 30_000 });
    const sha = String(head.stdout ?? "").trim();
    if (head.status !== 0 || !sha) {
      throw new Error(`Build-Fix 读取 HEAD 失败: ${String(head.stderr ?? "")}`);
    }
    return {
      sha,
      workspace_fingerprint: createHash("sha256")
        .update(sha).digest("hex"),
    };
  }

  /** 只审计本任务相对定格基线、且远端尚不存在的提交。冲突修复会把
   * origin/目标分支合进 HEAD；这些二亲历史已经在远端，不是本任务新
   * 推送的对象，不能因为它们沿用旧标题规范就误拦当前交付。 */
  private async taskCommitSubjects(
    task: TaskState,
    head: string,
  ): Promise<CommitSubjectRecord[]> {
    if (!task.cwd) throw new CommitMessagePolicyError("任务代码现场不可用，无法检查提交说明");
    const range = await this.taskUnpushedRevisionArgs(task, head);
    const result = await runSafeWorktreeGitAsync(task.cwd, [
      "log", "--format=%H%x09%s", ...range,
    ], { timeoutMs: 30_000 });
    if (result.status !== 0) {
      throw new CommitMessagePolicyError(
        `读取待推送提交说明失败：${String(
          result.stderr || result.error || "未知 Git 错误").trim().slice(0, 240)}`,
      );
    }
    return String(result.stdout ?? "").split("\n").flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator <= 0) return [];
      const sha = line.slice(0, separator).trim();
      const subject = line.slice(separator + 1).trim();
      return sha && subject ? [{ sha, subject }] : [];
    });
  }

  private async taskUnpushedRevisionArgs(
    task: TaskState,
    head: string,
  ): Promise<string[]> {
    if (!task.cwd) throw new CommitMessagePolicyError("任务代码现场不可用，无法检查提交说明");
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    const baseline = await frozenTaskBaseline(task.cwd) ?? snapshot?.baseline;
    const range = baseline ? [`${baseline}..${head}`, "--not", "--remotes"] : [head, "--not", "--remotes"];
    // 宿主从临时传输仓推送，不会刷新本工作区 refs/remotes；已发布祖先
    // 以核验过的收据排除。仍保留 --remotes，避免改写合并进来的远端历史。
    const published = task.summary.delivery?.git_push?.sha;
    if (published && /^[0-9a-f]{40,64}$/i.test(published)) {
      const object = await runSafeWorktreeGitAsync(task.cwd,
        ["cat-file", "-e", `${published}^{commit}`], { timeoutMs: 30_000 });
      if (object.status === 0) range.push(published);
    }
    return range;
  }

  private async invalidTaskCommitSubjects(
    task: TaskState,
    head: string,
  ): Promise<CommitSubjectRecord[]> {
    return (await this.taskCommitSubjects(task, head))
      .filter((commit) => !validTaskCommitSubject(commit.subject));
  }

  private commitPolicyFailure(
    task: TaskState,
    detail: string,
  ): "blocked" {
    task.summary.delivery = { ...task.summary.delivery, skipped: detail };
    // 工作区缺失、提交策略不合:都是配置/契约问题,重试结果不变。
    this.markVerificationStalled(task, detail, "contract");
    this.options.log?.(`任务 ${task.summary.id} ${detail}`);
    return "blocked";
  }

  /**
   * 不用 rebase/cherry-pick 重放补丁，而是按原 commit 的 tree、父关系、
   * 作者和时间直接重建尚未推送的对象。这样中间提交改标题时，后续提交
   * 只因父 SHA 变化而重建，代码内容不会再经历一次可能冲突的 patch apply。
   * 最终 ref 只在全部对象生成、标题复核和 HEAD tree 对拍成功后原子移动。
   */
  private async rewriteUnpushedCommitMessages(
    task: TaskState,
    before: PrePushRevision,
    invalid: CommitSubjectRecord[],
  ): Promise<{ after: PrePushRevision; repaired: string[]; tree: string }> {
    if (!task.cwd) throw new CommitMessagePolicyError("任务代码现场不可用，无法修正提交说明");
    const git = (
      args: string[],
      commitIdentity?: SafeGitCommitIdentity,
    ) => runSafeWorktreeGitAsync(task.cwd!, args, {
      timeoutMs: 60_000,
      ...(commitIdentity ? { commitIdentity } : {}),
    });
    const branch = await git(["symbolic-ref", "-q", "HEAD"]);
    const branchRef = String(branch.stdout ?? "").trim();
    if (branch.status !== 0 || !branchRef.startsWith("refs/heads/")) {
      throw new CommitMessagePolicyError(
        "当前代码现场不在任务分支上，系统不会自动改写 detached HEAD");
    }
    const range = await this.taskUnpushedRevisionArgs(task, before.sha);
    const revisions = await git(["rev-list", "--reverse", "--topo-order", ...range]);
    const commits = String(revisions.stdout ?? "").trim().split(/\s+/).filter(Boolean);
    if (revisions.status !== 0 || !commits.length) {
      throw new CommitMessagePolicyError(
        `读取待修正提交历史失败：${String(
          revisions.stderr || revisions.error || "没有找到未推送提交").trim().slice(0, 240)}`);
    }
    const pending = new Set(commits);
    if (invalid.some((item) => !pending.has(item.sha))) {
      throw new CommitMessagePolicyError(
        "待修正提交已不属于当前未推送历史，现场可能刚发生变化，请重新尝试");
    }
    const oldTreeResult = await git(["rev-parse", `${before.sha}^{tree}`]);
    const oldTree = String(oldTreeResult.stdout ?? "").trim();
    if (oldTreeResult.status !== 0 || !oldTree) {
      throw new CommitMessagePolicyError("读取提交内容指纹失败，未自动修正提交说明");
    }

    const invalidBySha = new Map(invalid.map((item) => [item.sha, item]));
    const rewritten = new Map<string, string>();
    const repaired: string[] = [];
    for (const sha of commits) {
      const metadata = await git(["show", "-s",
        "--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B",
        sha]);
      if (metadata.status !== 0) {
        throw new CommitMessagePolicyError(
          `读取提交 ${sha.slice(0, 12)} 元数据失败：${String(
            metadata.stderr || metadata.error || "未知 Git 错误").trim().slice(0, 200)}`);
      }
      const fields = String(metadata.stdout ?? "").split("\0");
      if (fields.length < 9) {
        throw new CommitMessagePolicyError(
          `提交 ${sha.slice(0, 12)} 的元数据不完整，未改写历史`);
      }
      const [tree, parentsText, authorName, authorEmail, authorDate,
        committerName, committerEmail, committerDate] = fields;
      const parents = parentsText.trim().split(/\s+/).filter(Boolean);
      const mappedParents = parents.map((parent) => rewritten.get(parent) ?? parent);
      const bad = invalidBySha.get(sha);
      const parentChanged = mappedParents.some((parent, index) => parent !== parents[index]);
      if (!bad && !parentChanged) {
        rewritten.set(sha, sha);
        continue;
      }
      const originalMessage = fields.slice(8).join("\0").replace(/\n+$/, "");
      let message = originalMessage;
      if (bad) {
        const subject = repairedPlatformCommitSubject(
          task.summary.ticket ?? task.summary.id, bad.subject);
        const lineBreak = originalMessage.indexOf("\n");
        const body = lineBreak >= 0 ? originalMessage.slice(lineBreak + 1) : "";
        message = `${subject}${body ? `\n${body}` : ""}`;
        repaired.push(`${sha.slice(0, 12)}「${bad.subject}」→「${subject}」`);
      }
      const created = await git([
        "commit-tree", tree,
        ...mappedParents.flatMap((parent) => ["-p", parent]),
        "-m", message,
      ], {
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
      });
      const nextSha = String(created.stdout ?? "").trim();
      if (created.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(nextSha)) {
        throw new CommitMessagePolicyError(
          `重建提交 ${sha.slice(0, 12)} 失败：${String(
            created.stderr || created.error || "Git 未返回新提交").trim().slice(0, 200)}`);
      }
      rewritten.set(sha, nextSha);
    }

    const nextHead = rewritten.get(before.sha);
    if (!nextHead || nextHead === before.sha || repaired.length !== invalid.length) {
      throw new CommitMessagePolicyError("提交说明修正结果不完整，原分支未发生变化");
    }
    const nextTreeResult = await git(["rev-parse", `${nextHead}^{tree}`]);
    const nextTree = String(nextTreeResult.stdout ?? "").trim();
    if (nextTreeResult.status !== 0 || nextTree !== oldTree) {
      throw new CommitMessagePolicyError(
        "修正提交说明后的代码内容指纹发生变化，原分支未发生变化");
    }
    const invalidAfter = await this.invalidTaskCommitSubjects(task, nextHead);
    if (invalidAfter.length) {
      throw new CommitMessagePolicyError(
        `修正后仍有 ${invalidAfter.length} 条提交说明不合规，原分支未发生变化`,
        invalidAfter);
    }
    const updated = await git(["update-ref", branchRef, nextHead, before.sha]);
    if (updated.status !== 0) {
      throw new CommitMessagePolicyError(
        `任务分支在修正期间发生变化，未覆盖新现场：${String(
          updated.stderr || updated.error || "Git 拒绝原子更新").trim().slice(0, 200)}`);
    }
    const after = await this.prePushRevision(task);
    if (after.sha !== nextHead) {
      throw new CommitMessagePolicyError("提交说明已重建但任务分支未指向新提交，请人工检查现场");
    }
    await preserveGitAiNotes(task.cwd!, rewritten, this.options.log);
    return { after, repaired, tree: oldTree };
  }

  /**
   * Build-Fix/旧版本 Cloud 若把任意尚未推送提交写成 `fix: ...`，宿主
   * 机械重建未推送 commit 图；不重放代码补丁，最终 tree 必须完全一致。
   * 真正 push 前仍会再次审计，远端已存在的历史永远不改写。
   */
  private async ensureCommitMessagePolicy(
    task: TaskState,
  ): Promise<"ok" | "repaired" | "blocked"> {
    if (!task.cwd) return this.commitPolicyFailure(
      task, "提交说明检查失败：任务代码现场不可用");
    const before = await this.prePushRevision(task);
    // 该版本已由宿主核验推送，不再因历史标题阻断 MR/流水线结果收口。
    if (task.summary.delivery?.git_push?.sha === before.sha) return "ok";
    let invalid: CommitSubjectRecord[];
    try {
      invalid = await this.invalidTaskCommitSubjects(task, before.sha);
    } catch (error) {
      return this.commitPolicyFailure(task,
        error instanceof Error ? error.message : String(error));
    }
    if (!invalid.length) return "ok";
    // 只用旧 commit 的 tree 重建对象并 update-ref；不读索引来生成提交。
    // 暂存内容原样保留，不应因无关本地改动阻断提交说明的机械修正。
    let rewrite: { after: PrePushRevision; repaired: string[]; tree: string };
    try {
      rewrite = await this.rewriteUnpushedCommitMessages(task, before, invalid);
    } catch (error) {
      return this.commitPolicyFailure(task,
        error instanceof Error ? error.message : String(error));
    }
    const { after, repaired, tree } = rewrite;

    const now = new Date().toISOString();
    const prepush = task.summary.delivery?.prepush;
    if (prepush && ["passed", "user_skipped"].includes(prepush.state)
        && sameRevision(prepush, before)) {
      this.setPrePushState(task,
        rebindEquivalentPrePushRevision(prepush, before, after, now));
    }
    if (task.summary.delivery?.last_reviewed_head === before.sha) {
      task.summary.delivery.last_reviewed_head = after.sha;
    }
    if (task.summary.delivery) {
      task.summary.delivery.stalled = undefined;
      task.summary.delivery.stall_class = undefined;
      task.summary.delivery.waiting_on = undefined;
      task.summary.delivery.skipped = undefined;
    }
    task.summary.detail = `已自动修正 ${repaired.length} 条尚未推送的提交说明；`
      + "代码内容未变，继续交付";
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id} 提交说明已机械修正：${repaired.join("；")}；`
      + `HEAD ${before.sha.slice(0, 12)} → ${after.sha.slice(0, 12)}；tree=${tree}`);
    return "repaired";
  }

  /** 脏路径清单(空数组=clean)。为什么要路径不只要布尔(2026-08-25
   * 内网事故复盘):构建在同挂载工作区里落产物时,"工作区仍有未提交
   * 业务改动"这句既没告诉模型该核对什么,也没告诉人有哪些本地现场,
   * 每一轮验证都在同一处失败还说不出原因。git 读不到时返回哨兵行——
   * 判 dirty 并把原因说出来,不许把"读不到"伪装成"干净"。 */
  private async prePushDirtyPaths(task: TaskState): Promise<string[]> {
    if (!task.cwd) return ["(任务没有代码工作区)"];
    const status = await runSafeWorktreeGitAsync(
      task.cwd, [
        "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ".",
        ":(exclude).mae-flow.json", ":(exclude).mae-flow-*",
        ":(exclude).mae-flow-work/**", ":(exclude).codecheckcli/**",
        ...AGENT_PLATFORM_PATHSPECS,
      ], { timeoutMs: 30_000 });
    if (status.status !== 0) {
      return [`(git status 读取失败: ${
        String(status.stderr ?? status.error ?? "").trim().slice(0, 200)})`];
    }
    return String(status.stdout ?? "").split("\0")
      .filter(Boolean).map((line) => line.slice(3));
  }

  private setPrePushState(
    task: TaskState,
    state: PrePushVerificationState,
  ): void {
    task.summary.delivery = { ...task.summary.delivery, prepush: state };
  }

  /** 领域状态说“准备中”不等于进程还活着。页面和投影只通过这里读取
   * 当前 serve 的真实所有权，绝不再拿持久化阶段猜 runner/容器活性。 */
  private prePushRuntime(task: TaskState): {
    state: PrePushRuntimeState;
    message: string;
  } {
    const prepush = task.summary.delivery?.prepush;
    if (!prepush) return { state: "idle", message: "尚未开始 Build-Fix" };
    if (task.prepushActive) {
      return { state: "running", message: "当前服务正在执行这轮 Build-Fix" };
    }
    if (task.prepushRecoveryActive) {
      return { state: "recovering", message: "服务正在恢复上次中断的 Build-Fix" };
    }
    if (["passed", "user_skipped"].includes(prepush.state)) {
      return { state: "idle", message: "Build-Fix 已经收口" };
    }
    if (["blocked", "environment_error"].includes(prepush.state)
        || prepush.state === "repairing"
        || ["paused", "pausing", "canceled"].includes(task.summary.status)
        || Boolean(task.summary.delivery?.stalled)) {
      return { state: "stopped", message: "当前服务没有运行这轮 Build-Fix" };
    }
    return {
      state: "interrupted",
      message: "上次 Build-Fix 已经中断，当前服务没有对应的执行会话",
    };
  }

  /** Build-Fix 已被当前进程接回时，旧 loop.halted/exhausted 就不再是
   * 当前事实。只恢复机器状态并清掉旧诊断；人工复检标记与批注 ID 原样
   * 保留，后续仍须意见作者逐条确认。 */
  private markBuildFixResuming(task: TaskState): boolean {
    const delivery = task.summary.delivery;
    if (!delivery) return false;
    let changed = false;
    const staleKeys = [
      "stalled", "stall_class", "waiting_on", "skipped", "verify_deadline",
    ] as const;
    for (const key of staleKeys) {
      if (delivery[key] !== undefined) {
        delete delivery[key];
        changed = true;
      }
    }
    const loop = delivery.loop;
    if (loop && ["halted", "exhausted"].includes(loop.state)) {
      loop.state = "verifying";
      loop.diagnosis = undefined;
      changed = true;
    }
    return changed;
  }

  /** 恢复前置条件坏了必须把 preparing 收成明确环境异常。继续保留一个
   * 没有 owner 的“准备中”，页面和运维都会被同一份假活性误导。 */
  private failPendingPrePush(task: TaskState, reason: string): void {
    const prepush = task.summary.delivery?.prepush;
    if (!prepush || ["passed", "user_skipped", "blocked", "environment_error"]
      .includes(prepush.state)) return;
    const message = `Build-Fix 无法恢复：${reason}`;
    this.setPrePushState(task, failPrePushEnvironment(
      prepush, new Date().toISOString(), message));
    task.summary.status = "failed";
    task.summary.detail = message;
    delete task.summary.completed_at;
    this.persist(task);
  }

  /** 启动期对账独立 prepush。旧容器已经由 serve 的 ownership 清扫收口，
   * 这里只重建业务 attempt；绝不尝试把新进程接到旧 driver/container。 */
  private reconcileInterruptedPrePush(
    task: TaskState,
  ): "none" | "scheduled" | "blocked" {
    const delivery = task.summary.delivery;
    const prepush = delivery?.prepush;
    if (!prepush || ["passed", "user_skipped", "blocked", "environment_error"]
      .includes(prepush.state)) return "none";
    // 宿主操作可能已经把这一 SHA 真实推到远端。此时本地 Build-Fix
    // 已失去“push 前验证”的时序意义，恢复应接着核对权威流水线，不能
    // 因旧 preparing 快照再次启动验证。远端收据只豁免同一个 SHA。
    // 已推送版本由常规交付核对 HEAD；新提交也不会自动补跑 Build-Fix。
    if (delivery?.git_push?.sha) return "none";
    if (delivery?.pipeline === "running"
        || (delivery?.pipeline === "success" && delivery.sha)
        || delivery?.evidence_gap) return "none";
    if (["paused", "pausing", "waiting_for_human", "canceled", "await_merge"]
      .includes(task.summary.status) || delivery?.stalled) return "none";

    // active_attempt 是上一进程留下的确凿中断证据；没有 attempt 的
    // preparing 也可能是进程死在恢复过渡窗口，活动交付态同样要接回。
    const canRestartUnownedStage = Boolean(this.options.prepush?.enabled && task.cwd);
    const interrupted = Boolean(prepush.active_attempt)
      || (canRestartUnownedStage && prepush.state === "preparing"
        && ["running", "queued", "verifying", "completed", "failed"]
          .includes(task.summary.status))
      || (canRestartUnownedStage && prepush.state === "repairing"
        && ["running", "queued", "verifying", "completed"]
          .includes(task.summary.status));
    if (!interrupted) return "none";
    if (!this.options.prepush?.enabled) {
      this.failPendingPrePush(task, "当前部署未启用 Build-Fix 能力");
      return "blocked";
    }
    if (!task.cwd || !existsSync(task.cwd)) {
      this.failPendingPrePush(task, "代码现场不存在或尚未挂载");
      return "blocked";
    }
    if (task.prepushRecoveryActive || task.prepushActive) return "scheduled";

    task.prepushRecoveryActive = true;
    task.summary.status = "verifying";
    task.summary.detail = "服务重启，正在恢复未完成的 Build-Fix";
    this.markBuildFixResuming(task);
    delete task.summary.completed_at;
    this.persist(task);
    const epoch = task.controlEpoch;
    const work = this.resumePrePushVerification(task, epoch).finally(() => {
      task.prepushRecoveryActive = false;
      this.bypass(task, "Build-Fix 活性投影",
        this.options.projection?.upsertTask(this.project(task)));
    });
    this.bypass(task, "Build-Fix 恢复", work);
    return "scheduled";
  }

  private prePushDomainReport(result: PrePushRunResult): PrePushReport {
    const failed = result.status === "infrastructure_failure"
      ? "infrastructure_failure" as const : "code_failure" as const;
    const map = (check: PrePushAgentReport["compile"]) => ({
      outcome: check.status === "passed"
        ? "passed" as const
        : check.status === "failed"
          ? failed
          : result.status === "infrastructure_failure"
            ? "infrastructure_failure" as const
            : "not_run" as const,
      ...(check.summary ? { message: check.summary } : {}),
    });
    if (result.report) {
      return {
        compile: map(result.report.compile),
        unit_test: map(result.report.unit_test),
      };
    }
    if (result.status === "passed") {
      return {
        compile: { outcome: "passed", message: result.message },
        unit_test: { outcome: "passed", message: result.message },
      };
    }
    return {
      compile: { outcome: failed, message: result.message },
      unit_test: { outcome: "not_run", message: result.message },
    };
  }

  /** 默认执行器：与普通编码会话使用同一模型、工作区和显式 Skill，
   * 但不创建 KernelHost、不挂 hostHooks，也不提供人工问答工具。 */
  private async runCloudPrePushAgent(
    task: TaskState,
    request: PrePushRunRequest,
    epoch: number,
    attemptId: string,
  ): Promise<PrePushRunResult> {
    if (!task.cwd) throw new Error("Build-Fix 缺少代码工作区");
    if (task.driver) throw new Error("已有 Agent 会话在运行，不能启动 Build-Fix");
    // 平台目录继续本地忽略；同时清理旧版本按文件勾选写入的永久 ignore。
    this.registerAgentPlatformLocalExcludes(task.cwd);
    this.refreshOwnerInputs(task);
    const isolation = this.options.isolation;
    if (!isolation) {
      throw new Error(
        "Build-Fix 必须在任务容器中执行；当前未配置隔离镜像，"
        + "已拒绝回退宿主机",
      );
    }
    const profile = detectPrePushBuildProfile(task.cwd);
    const executionBudget = resolvePrePushExecutionBudget(profile, {
      attemptTimeoutMs: this.options.prepush?.attemptTimeoutMs,
      buildCommandTimeoutMs: this.options.prepush?.buildCommandTimeoutMs,
    });

    // 换 Build-Fix 容器前停净预热，等待已发起的容器重建落定。
    await abortAuxiliarySessions(task);
    await task.containerReopen?.catch(() => undefined);
    if (interruptWarmupReceipt(task.summary.baseline_build)) this.persist(task);
    const previousContainer = task.container;
    if (previousContainer) {
      await previousContainer.stop();
      if (task.container === previousContainer) task.container = undefined;
    }
    if (!this.current(task, epoch)) {
      throw new Error("任务已停止，拒绝启动 Build-Fix 容器");
    }

    const agentDir = join(task.summary.workspace, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    this.hardenAgentGitBoundary(agentDir, task.cwd);
    // build-notes 的目录由宿主预建:安全层只放行那一个文件,mkdir
    // .mae-flow-work 本身会被拦——使命让写、闸不让建目录,Agent 没出路。
    mkdirSync(join(task.cwd, ".mae-flow-work"), { recursive: true });
    const modelBundle = this.sessionModels(task);
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(modelBundle.json));

    let repositorySkillPaths: string[] = [];
    let repositorySkillResources: Array<KnowledgeResourceRef & {
      actual_path: string;
    }> = [];
    const activeRepository = task.summary.repo_url ?? this.effectiveDefaultRepo();
    if (activeRepository) {
      const materialized = materializeRepositorySkills({
        selected: task.summary.repository_skills,
        bindings: [{ repository: activeRepository, workspace: task.cwd }],
        snapshotRoot: join(task.cwd, ".mae-flow-work", "repository-skills"),
        reservedNames: hostSkillNames(this.options.dataDir),
        blockedPaths: readResourceBlocks(this.options.dataDir),
      });
      this.freezeRepositoryNativeSkills(task, materialized);
      repositorySkillPaths = materialized.paths;
      repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
        id: skill.id,
        kind: "skill" as const,
        name: skill.name,
        path: skill.relative_path,
        repository: skill.repository,
        description: skill.description,
        digest: skill.digest,
        selected: true,
        actual_path: path,
      }));
      for (const warning of materialized.warnings) {
        this.options.log?.(
          `[prepush-skill] 任务 ${task.summary.id}: ${warning}`);
      }
    }

    const runRoot = join(
      task.summary.workspace, "prepush",
      `round-${request.round}-${request.sha.slice(0, 12)}`);
    mkdirSync(runRoot, { recursive: true });
    const eventLog = new EventLog(join(runRoot, "events.jsonl"));
    const transcript = new TranscriptStore(
      join(runRoot, "transcript.jsonl"), "main");
    const instance = taskContainerInstance(this.options.dataDir).namePrefix;
    const attempt = `r${request.round}-${request.sha.slice(0, 12)}`
      .replace(/[^a-zA-Z0-9_.-]/g, "-");
    const mounts = await this.taskContainerMounts(task, isolation.volumes ?? []);
    const container = this.createTaskContainer({
      image: isolation.image,
      workspace: task.cwd,
      // 名字按任务稳定：进程死在 attempt 中间，下一次启动/恢复会先
      // ownership 复验并清掉同名残留；round/SHA 只进 label 与收据。
      name: `mfc-${instance}-${task.summary.id}-prepush`,
      log: this.options.log,
      volumes: mounts.volumes,
      limits: {
        memory: isolation.memory,
        cpus: isolation.cpus,
        user: isolation.user,
        pidsLimit: isolation.pidsLimit,
      },
      options: {
        labels: {
          ...(isolation.labels ?? {}),
          "com.mae-flow-cloud.task": task.summary.id,
          "com.mae-flow-cloud.role": "prepush",
          "com.mae-flow-cloud.prepush-round": String(request.round),
          "com.mae-flow-cloud.sha": request.sha,
        },
        readOnlyRoot: isolation.readOnlyRoot,
        tmpfsHome: isolation.tmpfsHome,
        tmpfsTmp: isolation.tmpfsTmp,
        network: isolation.network,
        environment: mounts.environment,
        forwardEnvironment: isolation.forwardEnvironment,
        stopGraceSeconds: isolation.stopGraceSeconds,
        managementTimeoutMs: isolation.managementTimeoutMs,
      },
    });
    task.container = container;
    const abortController = new AbortController();
    task.prepushAbort = abortController;
    let infrastructureFailure = "";
    let resolveInfrastructure!: () => void;
    const infrastructureFailed = new Promise<void>((resolveFailure) => {
      resolveInfrastructure = resolveFailure;
    });
    const failInfrastructure = (detail: string) => {
      if (infrastructureFailure) return;
      infrastructureFailure = detail;
      resolveInfrastructure();
      // 先发布结构化失败再中止容器；waitForTurn 即使同时收到 interrupted，
      // 也会以下面的 infrastructureFailure 事实为准。
      abortController.abort();
    };
    const interrupted = new Promise<Outcome>((resolve) => {
      const finish = () => resolve({
        status: "session_ended",
        reason: "prepush_interrupted",
        detail: "Build-Fix 已由任务控制操作终止",
      });
      if (abortController.signal.aborted) finish();
      else abortController.signal.addEventListener("abort", finish, { once: true });
    });
    const commands = new PrePushCommands();
    const waitForTurn = (turn: Promise<Outcome>) =>
      Promise.race([
        turn.then(async (outcome) => {
          await commands.drain();
          return outcome;
        }),
        interrupted,
        infrastructureFailed.then((): Outcome => ({
          status: "session_ended",
          reason: "prepush_infrastructure_failure",
          detail: infrastructureFailure,
        })),
      ]);
    let driver: CloudSession | undefined;
    const attemptTimeoutMs = executionBudget.attemptTimeoutMs;
    const attemptTimer = setTimeout(() => failInfrastructure(
      `Build-Fix 超过 ${Math.ceil(attemptTimeoutMs / 60_000)} 分钟，已终止本轮`,
    ), attemptTimeoutMs);
    attemptTimer.unref?.();
    const repeatGuard = new PrePushCommandRepeatGuard();
    // Edit/Write 会改变尚未 commit 的源码，HEAD tree 暂时看不出来；用本轮
    // mutationGeneration 补上。使命已经禁止用 shell 文本替换伪装修改，
    // Bash 修改最终 commit 后 tree 也会自然变化。
    let mutationGeneration = 0;
    const codeContentIdentity = async (): Promise<string> => {
      // 护栏自己的版本探针不能占用容器执行通道：容器故障/超时应该精确
      // 归到用户真正发出的构建命令，而不是先打中一条额外的内部命令。
      const read = await runSafeWorktreeGitAsync(task.cwd!, [
        "rev-parse", "--verify", "HEAD^{tree}",
      ], { timeoutMs: 15_000 });
      const tree = read.status === 0 ? String(read.stdout ?? "").trim() : "";
      return `${tree || "tree-unavailable"}:${mutationGeneration}`;
    };
    const withExecution = (result: PrePushRunResult): PrePushRunResult => {
      const metadata = container.metadata;
      if (!metadata) return result;
      const execution: PrePushExecutionAttestation = {
        schema: PRE_PUSH_EXECUTION_SCHEMA,
        attempt_id: attemptId,
        sha: result.sha,
        container_id: metadata.containerId,
        image_reference: metadata.imageReference,
        image_id: metadata.imageId,
        image_digest: metadata.imageDigest,
        network: metadata.network,
        read_only_root: metadata.readOnlyRoot,
        pids_limit: metadata.pidsLimit,
        ...(metadata.memoryBytes !== undefined
          ? { memory_bytes: metadata.memoryBytes } : {}),
        ...(metadata.nanoCpus !== undefined
          ? { nano_cpus: metadata.nanoCpus } : {}),
        ...(metadata.user ? { user: metadata.user } : {}),
        ...(metadata.startedAt ? { started_at: metadata.startedAt } : {}),
        mount_destinations: metadata.mounts.map((mount) => mount.destination),
      };
      return { ...result, execution };
    };
    try {
      await container.start();
      if (!this.current(task, epoch)) {
        throw new Error("任务已停止，Build-Fix 容器不再执行命令");
      }
      // 先验证确定性的本地环境事实，再花模型额度。settings、Maven 实际
      // JDK、JVM cacerts、缓存或 C++ 拓扑不对时直接给出基础设施结论，
      // 不让 Agent curl 盲探几分钟后才猜到部署缺项。
      const preflightCommand = prePushEnvironmentCommand({
        profile,
        requireMavenSettings: hasContainerVolumeDestination(
          mounts.volumes,
          "/etc/mae-flow/maven/settings.xml",
        ),
      });
      let preflightOutput = "";
      const preflightRun = await container.exec(preflightCommand, task.cwd, {
        timeout: 45,
        signal: abortController.signal,
        onData: (chunk) => {
          preflightOutput = `${preflightOutput}${chunk.toString()}`.slice(-64 * 1024);
        },
      });
      const preflight = inspectPrePushEnvironment(
        preflightRun.exitCode,
        preflightOutput,
      );
      if (!preflight.ready) {
        this.options.log?.(
          `[prepush-environment] 任务 ${task.summary.id}: ${preflight.detail}`,
        );
        return withExecution({
          status: "infrastructure_failure",
          sha: (await this.prePushRevision(task)).sha,
          message: preflight.detail,
        });
      }
      await applyGitCommitIdentity(task.cwd, this.options.gitCredential?.(task.summary.luban_account));
      driver = await CloudSession.create({
        taskId: `${task.summary.id}:prepush:${request.round}`,
        componentKnowledge: this.componentKnowledge(task),
        componentAnalysisContext: () => this.componentAnalysisContext(task),
        extraTools: this.memoryTools(task)?.filter((tool: any) => tool.name === "knowledge"),
        workspace: task.cwd,
        agentDir,
        additionalSystemInstructions: [COMMIT_CONTENT_GUIDANCE],
        repositoryResourceBlocks: () =>
          readResourceBlocks(this.options.dataDir),
        hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
        knowledgeModuleDataDir: this.options.dataDir,
        knowledgeContext: task.summary.host_skills_pinned ? undefined : {
          repositories: task.summary.repositories ?? [],
          technologies: [...new Set((task.summary.repository_profiles ?? [])
            .flatMap((profile) => profile.technologies))],
          businessModuleIds: (task.summary.business_modules ?? [])
            .map((module) => module.id),
        },
        repositorySkillPaths,
        repositorySkillResources,
        knowledgeTrace: this.knowledgeTrace(task, task.cwd),
        provider: modelBundle.choice?.provider ?? this.options.provider,
        model: modelBundle.choice?.model ?? this.options.model,
        eventLog,
        transcript,
        gate: new GateService({
          contract: createPrePushGateContract(this.options.contract),
          workspace: task.cwd,
          cwd: task.cwd,
          log: this.options.log,
          failClosed: Boolean(this.options.host),
        }),
        humanGate: task.humanGate,
        allowHumanQuestions: false,
        streamBashOutput: true,
        sessionId: `prepush-${request.round}`,
        currentStep: () => this.currentStepLabel(task),
        compactAnchor: () => `Build-Fix 任务: ${requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        )}`,
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        bashOperations: {
          exec: async (command, dir, execOptions) => {
            try {
              const fullSuite = fullSuiteCommandVerdict(command);
              if (fullSuite === "blocked") {
                execOptions.onData(Buffer.from(
                  "[Cloud] 已阻止全仓 UT：Build-Fix 只运行本次改动/失败直接影响的模块和用例。请改用 -pl/-Dtest、DT include、ctest -R 或对应测试框架的显式选择器；全量回归由远端流水线负责。\n",
                ));
                this.options.log?.(
                  `[prepush-targeted-ut] 任务 ${task.summary.id} 阻止全仓 UT: ${
                    prePushCommandIdentity(command).slice(0, 180)}`,
                );
                return { exitCode: 64 };
              }
              // C++/native:只提示不拦。定向能力因仓而异,平台没在真仓上
              // 验证过 DT include,硬拒会让整个仓跑不了 UT(代价不对等)。
              if (fullSuite === "advised") {
                execOptions.onData(Buffer.from(
                  "[Cloud] 提示：这条像是全仓 UT。C++/native 缩小范围首选进受影响子模块的目录再构建/跑 UT（mcde 的 mae-remote-build 就是这么做的）；已经在子目录里跑就忽略本提示。`-DDT_COV_INCLUDES` 未必存在，先在本仓核实再用，还可以用 `ctest -R` 或 runner 的 suite/case 过滤。确实没有可用的定向入口就照常执行，并在 summary 里写清为什么没能定向。\n",
                ));
                this.options.log?.(
                  `[prepush-targeted-ut] 任务 ${task.summary.id} 提示全仓 UT(放行): ${
                    prePushCommandIdentity(command).slice(0, 180)}`,
                );
              }
              const heavy = isPrePushBuildCommand(command);
              const contentIdentity = heavy
                ? await codeContentIdentity() : undefined;
              if (contentIdentity) {
                const decision = repeatGuard.decide(contentIdentity, command);
                if (decision === "reuse_success") {
                  execOptions.onData(Buffer.from(
                    "[Cloud] 当前代码内容上相同的重型命令已经成功，复用本轮真实结果，不再重复执行。\n",
                  ));
                  this.options.log?.(`[prepush-repeat] 任务 ${task.summary.id} 复用成功命令: ${
                    prePushCommandIdentity(command).slice(0, 180)}`);
                  return { exitCode: 0 };
                }
                if (decision === "block_repeat") {
                  execOptions.onData(Buffer.from(
                    "[Cloud] 已阻止第三次原样执行：当前代码内容未变化，且这条重型命令已经连续失败两次。请先阅读已有日志、修改代码或运行更小范围的定向检查；不要换空白或包装方式绕过。\n",
                  ));
                  this.options.log?.(`[prepush-repeat] 任务 ${task.summary.id} 阻止无进展命令: ${
                    prePushCommandIdentity(command).slice(0, 180)}`);
                  return { exitCode: 75 };
                }
              }
              const timeout = prePushCommandTimeoutSeconds(
                command,
                execOptions.timeout,
                executionBudget,
              );
              const result = await commands.run(() => container.exec(command, dir, {
                ...execOptions,
                timeout,
              }));
              if (contentIdentity) {
                repeatGuard.record(contentIdentity, command, result.exitCode);
              }
              return result;
            } catch (error) {
              if (error instanceof TaskContainerExecTimeoutError) {
                failInfrastructure(
                  `Build-Fix 命令运行 ${Math.ceil(error.timeoutSeconds / 60)} 分钟`
                    + "仍未完成，已安全停止本轮；这是验证预算耗尽，不代表代码编译失败",
                );
              } else if (error instanceof TaskContainerUnavailableError) {
                failInfrastructure(
                  `Build-Fix 容器不可用（${error.kind}）：${error.message}`,
                );
              }
              throw error;
            }
          },
        },
        afterFileMutation: (path) => {
          if (!/(?:^|[\\/])\.mae-flow-work(?:[\\/]|$)/.test(path)) {
            mutationGeneration += 1;
          }
          repairContainerMutationOwnership({
            workspace: task.cwd!,
            path,
            user: isolation.user,
          });
        },
        log: this.options.log,
      });
      if (!this.current(task, epoch) || abortController.signal.aborted) {
        driver.dispose();
        throw new Error("任务已停止，Build-Fix Agent 不再启动");
      }
      task.driver = driver;
      let outcome = await waitForTurn(driver.start(prePushMission(
        request,
        executionBudget,
      )));
      for (let correction = 0; correction < 3; correction += 1) {
        if (infrastructureFailure) {
          await driver.abort().catch((error) => this.options.log?.(
            `任务 ${task.summary.id} prepush 基础设施熔断后会话中止失败: ${String(error)}`,
          ));
          return withExecution({
            status: "infrastructure_failure",
            sha: (await this.prePushRevision(task)).sha,
            message: infrastructureFailure,
          });
        }
        if (outcome.status === "session_ended") {
          return withExecution({
            status: "infrastructure_failure",
            sha: (await this.prePushRevision(task)).sha,
            message: outcome.detail ?? outcome.reason ?? "Build-Fix 会话异常结束",
          });
        }
        if (unfinishedPrePushTools(eventLog.replay()).length) {
          return withExecution({
            status: "infrastructure_failure",
            sha: request.sha,
            message: "Build-Fix 会话已结束，但工具没有可靠完成记录；已停止本轮，请重试继续验证，不能视为 UT 通过",
          });
        }
        const report = parsePrePushAgentReport(driver.finalReply());
        if (report && report.status !== "passed") {
          return withExecution({
            status: report.status,
            sha: (await this.prePushRevision(task)).sha,
            message: report.summary,
            report,
          });
        }
        const replayed = eventLog.replay();
        const evidence = report
          ? verifyPrePushEvidence(replayed, report)
          : "收口缺少合法的 <prepush-result> 结构";
        const finalSha = (await this.prePushRevision(task)).sha;
        if (report && !evidence) {
          // 顺序事实只展示不裁决(用户 2026-09-03 拍板:旧绿灯漏过去由绑
          // SHA 的流水线兜底,误判的代价比它大):最后一次成功之后还改过
          // 哪些会进交付的文件,写进收据,推送确认时人自己看。
          const facts = prePushEvidenceFacts(replayed, report);
          const staleNote = facts.changed_after_run.length
            ? `。注意:最后一次成功编译/UT 之后还改过 ${describeDirtyPaths(
              facts.changed_after_run)},没有重跑;推送前请自行判断是否需要打回重跑。`
            : "";
          // 上报命令与实跑对不上时不再判死(用户 2026-09-04 拍板"能松点
          // 就松点,让用户决策"):本会话确实跑成功过重型构建命令,把不一致
          // 如实写进收据,推送确认时人自己看要不要打回。
          const mismatchNote = facts.command_mismatch.length
            ? `。注意:Agent 上报的命令(${facts.command_mismatch
              .map((command) => command.slice(0, 120)).join("；")})`
              + "与本会话实际执行记录对不上;本会话确实成功跑过重型构建命令,"
              + "但无法逐条核对上报的就是它们。推送前请自行判断。"
            : "";
          // 未提交文件只提示不拦截(用户拍板"不能卡死"):push 只传
          // HEAD,它们进不了交付;把清单如实写进收据,让人看见万一
          // 混在其中的漏提交业务改动。构建现场保留即可,不能再为了
          // 当前一次编译诱导 Agent 修改业务仓 .gitignore。
          const leftover = await this.prePushDirtyPaths(task);
          const leftoverNote = leftover.length
            ? `。工作区尚有未提交/未跟踪文件(${describeDirtyPaths(leftover)}`
              + ")——push 只传 HEAD,它们不进交付,也不影响通过。构建产物"
              + "请保留勿删,无需为本轮编译修改业务仓 .gitignore。"
              + "若其中有本单业务改动，Agent 应核对是否尚未提交。"
            : "";
          return withExecution({
            status: "passed",
            sha: finalSha,
            message: report.summary + staleNote + mismatchNote + leftoverNote,
            report,
          });
        }
        if (correction === 2) {
          return withExecution({
            status: "code_failure",
            sha: (await this.prePushRevision(task)).sha,
            message: evidence,
          });
        }
        outcome = await waitForTurn(driver.continueWith([
          "Build-Fix 尚不能签发 PASS，请在当前专项会话继续处理。",
          evidence,
          "不要只重写结论；两项命令必须在本会话真实成功执行。",
        ].filter(Boolean).join("\n")));
      }
      throw new Error("Build-Fix 会话超过收口预算");
    } finally {
      clearTimeout(attemptTimer);
      if (driver && task.driver === driver) task.driver = undefined;
      if (task.prepushAbort === abortController) task.prepushAbort = undefined;
      try {
        driver?.dispose();
      } finally {
        // 即使会话清理失败，也必须等待容器停止，避免下一轮并发写工作区。
        await container.stop();
        if (task.container === container) task.container = undefined;
      }
      recordInterruptedPrePushTools(eventLog);
    }
  }

  private async performPrePush(
    task: TaskState,
    branch: string,
    baseline: string,
    epoch: number,
    dispatchRepair = true,
  ): Promise<boolean> {
    const at = new Date().toISOString();
    const initialRevision = await this.prePushRevision(task);
    let state = restorePrePushVerification(
      task.summary.delivery?.prepush, initialRevision, at);
    this.setPrePushState(task, state);
    if (getReusablePushReceipt(state, initialRevision)) {
      this.persist(task);
      return true;
    }
    if (["blocked", "environment_error"].includes(state.state)) {
      state = retryPrePushVerification(
        state, at, "重新执行 Build-Fix");
    }
    state = beginPrePushAttempt(state, at);
    const attemptId = state.active_attempt?.id;
    if (!attemptId) {
      throw new Error(`Build-Fix 无法启动，当前状态: ${state.state}`);
    }
    this.setPrePushState(task, state);
    const previousStatus = task.summary.status;
    task.summary.status = "running";
    task.summary.detail = state.message;
    this.persist(task);

    let interruption = "Build-Fix 本轮已中断，请重试继续验证";
    try {
      const deliverySnapshot = await deliveryChangeSnapshot(task.cwd!);
      const changeScope = buildFixScopeReview(
        deliverySnapshot?.committed_paths ?? []);
      const request: PrePushRunRequest = {
        taskId: task.summary.id,
        workspace: task.cwd!,
        sha: initialRevision.sha,
        round: state.round,
        requirement: requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        ),
        branch,
        baseline,
        commitConvention: this.effectiveCommitConvention(),
        ...(changeScope ? { changeScope } : {}),
        ...(task.summary.delivery?.foreign_commits?.count ? {
          foreignCommits: {
            count: task.summary.delivery.foreign_commits.count,
            subjects: [...task.summary.delivery.foreign_commits.subjects],
          },
        } : {}),
      };
      let result: PrePushRunResult;
      const releaseBuildSlot = await this.acquirePrePushBuildSlot(task, epoch);
      if (!releaseBuildSlot || !this.current(task, epoch)) {
        releaseBuildSlot?.();
        return false;
      }
      try {
        result = await (this.options.prepush?.runner
          ?? ((input) => this.runCloudPrePushAgent(
            task, input, epoch, attemptId)))(request);
      } catch (error) {
        result = {
          status: "infrastructure_failure",
          sha: (await this.prePushRevision(task)).sha,
          message: `Build-Fix 执行失败: ${String(error)}`,
        };
      } finally {
        releaseBuildSlot();
      }
      if (!this.current(task, epoch)) return false;

      const finalRevision = await this.prePushRevision(task);
      if (state.sha !== finalRevision.sha
          || state.workspace_fingerprint !== finalRevision.workspace_fingerprint) {
        state = observePrePushRevision(
          state, finalRevision, new Date().toISOString());
        state = beginPrePushAttempt(
          state, new Date().toISOString(), attemptId);
      }
      if (result.sha !== finalRevision.sha) {
        result = {
          status: "infrastructure_failure",
          sha: finalRevision.sha,
          message: `验证结果绑定 ${result.sha.slice(0, 12)}，但当前 HEAD 是 `
            + `${finalRevision.sha.slice(0, 12)}，拒绝复用陈旧结论`,
        };
      }
      state = recordPrePushReport(
        state, attemptId, this.prePushDomainReport(result),
        new Date().toISOString());
      if (state.state === "passed" && result.execution) {
        state = attestPrePushExecution(state, result.execution);
      }
      this.setPrePushState(task, state);
      const passed = Boolean(getReusablePushReceipt(state, finalRevision));
      if (passed) {
        task.summary.status = previousStatus;
        task.summary.detail = "Build-Fix 已通过，等待最终人工检视";
        if (task.summary.delivery) delete task.summary.delivery.skipped;
      } else if (result.status === "code_failure"
          && this.options.host?.continuousReview) {
        try {
          this.openFeedbackBatch(task, "build_fix", [{
            id: `build-fix:${finalRevision.sha}:${state.round}`,
            source: "build_fix",
            source_id: `${finalRevision.sha}:${state.round}`,
            source_revision: state.round,
            kind: "quality_failure",
            summary: state.message.slice(0, 1000),
            material: resolve(task.summary.workspace, "prepush",
              `round-${state.round}-${finalRevision.sha.slice(0, 12)}`),
            verification: "build_fix",
          }]);
          if (!dispatchRepair) { task.summary.status = previousStatus; this.persist(task); return false; }
          this.enqueueRepair(task, [
            "Build-Fix 已完成有限自修，但仍有可定位的代码问题。",
            state.message,
            "该问题已作为当前任务的反馈批次登记。先执行 current，依据本轮",
            "Build-Fix 事件与收据继续修复；始终沿用当前代码现场和交付对象。",
          ].join("\n"), "Build-Fix 反馈已进入持续检视，正在继续修复");
          return false;
        } catch (error) {
          task.summary.status = "failed";
          task.summary.detail = `Build-Fix 未通过，且反馈批次登记失败：${String(error)}`;
          task.summary.delivery = {
            ...task.summary.delivery,
            skipped: task.summary.detail,
          };
        }
      } else {
        task.summary.status = "failed";
        task.summary.detail = `Build-Fix 未通过：${state.message}`;
        task.summary.delivery = {
          ...task.summary.delivery,
          skipped: task.summary.detail,
        };
      }
      this.persist(task);
      return passed;
    } catch (error) {
      interruption = `Build-Fix 执行中断：${String(error)}`;
      if (this.current(task, epoch)) {
        task.summary.status = "failed";
        task.summary.detail = interruption;
      }
      return false;
    } finally {
      // 所有准备、执行、取结果及取消出口共用收口；不覆盖用户决定或新一轮。
      const live = task.summary.delivery?.prepush;
      if (live?.active_attempt?.id === attemptId) {
        this.setPrePushState(task, recordPrePushReport(live, attemptId, {
          compile: { outcome: "infrastructure_failure", message: interruption },
          unit_test: { outcome: "not_run", message: interruption },
        }, new Date().toISOString()));
        this.persist(task);
      }
    }
  }

  private async preparePush(
    task: TaskState,
    branch: string,
    baseline: string,
    epoch: number,
    dispatchRepair = true,
  ): Promise<boolean> {
    if (!this.options.prepush?.enabled) return true;
    if (task.prepushActive) return task.prepushActive;
    const revision = await this.prePushRevision(task);
    // 已通过或用户显式跳过都绑定 SHA + 工作区指纹复用。此前这里只认
    // user_skipped，重启会把真实 PASS 当成没跑过再起一轮 Build-Fix。
    const completed = task.summary.delivery?.prepush;
    if (completed && ["passed", "user_skipped"].includes(completed.state)
        && sameRevision(completed, revision)) {
      if (completed.state === "user_skipped") {
        this.options.log?.(
          `任务 ${task.summary.id} 按用户决定跳过 Build-Fix`
          + `(HEAD ${revision.sha.slice(0, 12)}),交由流水线裁决`);
      }
      return true;
    }
    // Agent 通过宿主能力提前完成了同一 SHA 的远端推送时，不伪造
    // Build-Fix PASS；直接让既有流水线事实接管验证。新 SHA 仍重验。
    if (task.summary.delivery?.git_push?.sha === revision.sha) {
      this.options.log?.(`任务 ${task.summary.id} 的 HEAD ${revision.sha.slice(0, 12)}`
        + " 已有宿主推送收据，跳过补跑 Build-Fix并继续核对流水线");
      return true;
    }
    const running = this.performPrePush(task, branch, baseline, epoch, dispatchRepair);
    task.prepushActive = running;
    try {
      return await running;
    } finally {
      if (task.prepushActive === running) task.prepushActive = undefined;
    }
  }

  /** 推送检视中的 Agent 说明，保留可读段落并限制长度。 */
  private concisePushReviewNote(task: TaskState): string | undefined {
    const text = String(task.lastReply ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/^```[a-z0-9_-]*\s*$/gim, "")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return undefined;
    // 默认态已经折成一行；展开后保留 Agent 原本的段落/清单结构，
    // 不能再把整段 Markdown 压成一条 360 字的“电报”。
    return text.length > 720 ? `${text.slice(0, 717).trimEnd()}…` : text;
  }

  /** 当前 MR 真正新增的文件面。任务定格基线仍用于历史完整性与“从任务
   * 起点”复盘；但目标分支在开发期间前进、随后被合入 HEAD 时，目标
   * 分支已有文件不属于本任务的 MR 贡献，不能混进最终交付清单。
   * 以目标分支与 HEAD 的共同祖先计算 MR 差异；目标继续前进也不会
   * 退回任务起点，把已合入的上游修改重新算进任务贡献。 */
  private async deliveryContribution(
    task: TaskState,
    snapshot: NonNullable<Awaited<ReturnType<typeof deliveryChangeSnapshot>>>,
  ): Promise<{ paths: string[]; base_sha: string }> {
    // 只修正有当前 Git 事实佐证的旧展示路径，不改状态、授权范围或 SHA。
    const result = (paths: string[], base_sha: string) => {
      const known = [...snapshot.workspace_paths, ...paths];
      let changed = false;
      const selection = task.summary.delivery_selection;
      const lists = selection ? [selection.paths, selection.excluded_paths, selection.observed_paths] : [];
      const review = task.summary.delivery?.push_review?.committed_paths;
      if (review) lists.push(review);
      for (const list of lists) {
        if (!list) continue;
        const restored = recoverQuotedGitPaths(list, known);
        if (restored.some((path, i) => path !== list[i])) {
          list.splice(0, list.length, ...restored); changed = true;
        }
      }
      if (changed) this.persist(task);
      return { paths, base_sha };
    };
    if (!task.cwd) {
      return result(normalizedDeliveryPaths(snapshot.committed_paths), snapshot.baseline!);
    }
    try {
      const state = JSON.parse(readFileSync(
        join(task.cwd, ".mae-flow.json"), "utf-8"));
      const target = String(task.summary.delivery?.target_branch
        ?? task.summary.baseline ?? state?.config?.["基线分支"] ?? "").trim();
      if (!target) throw new Error("目标分支缺失");
      const valid = await runSafeWorktreeGitAsync(
        task.cwd, ["check-ref-format", "--branch", target],
        { timeoutMs: 30_000 });
      if (valid.status !== 0) throw new Error("目标分支名无效");
      const targetRef = `refs/remotes/origin/${target}`;
      const resolved = await runSafeWorktreeGitAsync(
        task.cwd, ["rev-parse", "--verify", `${targetRef}^{commit}`],
        { timeoutMs: 30_000 });
      const baseSha = String(resolved.stdout ?? "").trim();
      if (resolved.status !== 0 || !baseSha) throw new Error("目标 ref 不存在");
      const common = await runSafeWorktreeGitAsync(
        task.cwd, ["merge-base", "--all", baseSha, snapshot.head],
        { timeoutMs: 30_000 });
      const bases = String(common.stdout ?? "").trim().split(/\s+/).filter(Boolean);
      if (common.status !== 0 || bases.length !== 1) throw new Error("无法确定唯一的 MR 比较起点");
      const comparisonBase = bases[0]!;
      const contribution = await runSafeWorktreeGitAsync(
        task.cwd, ["diff", "--name-only", "-z", comparisonBase, snapshot.head, "--"],
        { timeoutMs: 30_000 });
      if (contribution.status !== 0) throw new Error("贡献差异读取失败");
      return result(normalizedDeliveryPaths(
        gitNullPaths(String(contribution.stdout ?? ""))), comparisonBase);
    } catch (error) {
      // 老任务/本地仓没有目标分支配置或远端目标引用时，仅在线性历史中
      // 沿用任务起点；两种缺失对“无基点可比”是同一回事。历史里已有
      // 合并提交（已合入其他分支）却无法确定 MR 基点时，不能把全量历史
      // 误判为违规，也不许静默回退，fail-closed 交人核对。
      const merges = await runSafeWorktreeGitAsync(task.cwd,
        ["rev-list", "--merges", `${snapshot.baseline}..${snapshot.head}`],
        { timeoutMs: 30_000 });
      if (merges.status !== 0 || String(merges.stdout ?? "").trim()
          || !(error instanceof Error)
          || !["目标分支缺失", "目标 ref 不存在"].includes(error.message)) {
        throw new TaskControlError(`无法确定交付差异范围：${String(error)}。请核对目标分支引用；未修改交付授权或代码。`);
      }
      return result(normalizedDeliveryPaths(snapshot.committed_paths), snapshot.baseline!);
    }
  }

  private async buildPushReviewPresentation(
    task: TaskState,
    snapshot: NonNullable<Awaited<ReturnType<typeof deliveryChangeSnapshot>>>,
    recheckRequired: boolean,
  ): Promise<PushReviewPresentation> {
    const delivery = task.summary.delivery;
    const contribution = await this.deliveryContribution(task, snapshot);
    const hasPriorReview = Boolean(delivery?.last_reviewed_head
      && delivery.last_reviewed_head !== snapshot.head);
    const kind: PushReviewPresentation["kind"] = recheckRequired
      ? "feedback"
      : delivery?.loop?.kind === "ci" ? "pipeline"
      : delivery?.loop?.kind === "conflict" ? "conflict"
      : hasPriorReview ? "rework"
      : "delivery";
    const copy = {
      delivery: {
        title: "完整交付内容",
        description: "这是当前待推送的全部代码，确认后会直接推送并创建或更新 MR。",
      },
      feedback: {
        title: "按检视意见修改",
        description: "Agent 已处理这批检视意见，建议先核对这次处理，再决定是否通过。",
      },
      pipeline: {
        title: "流水线修复内容",
        description: "流水线修复产生了新提交，建议先核对这次修复，再决定是否通过。",
      },
      conflict: {
        title: "冲突处理内容",
        description: "Agent 已处理分支冲突，建议先核对冲突处理结果，再决定是否通过。",
      },
      rework: {
        title: "按上次检视调整",
        description: "Agent 已按你上次的检视意见调整，建议先核对调整结果。",
      },
    } satisfies Record<PushReviewPresentation["kind"], {
      title: string; description: string;
    }>;

    // 浏览按推送轮次取范围，不能把审批时的旧 HEAD 当作每轮起点。
    // 历史任务从已有宿主推送记录恢复；记录缺失时不冒充“最新增量”。
    const pushed = delivery?.git_push;
    let historicalPushes: string[] = [];
    try {
      historicalPushes = new TaskHostLedger(task.summary).read().operations
        .slice().reverse().flatMap(op => op.push_receipt ? [op.push_receipt.sha] : []);
    } catch { /* 浏览不因历史台账不可读而阻塞，全量仍可用。 */ }
    const latestPush = pushed?.sha ?? historicalPushes[0];
    const preferred = latestPush
      ? latestPush !== snapshot.head ? [latestPush]
        : [delivery?.last_push_base_sha,
          historicalPushes.find(sha => sha !== latestPush)]
      : [delivery?.last_reviewed_head];
    let focused: DeliveryRevisionComparison | undefined;
    for (const base of [...new Set(preferred)]) {
      if (!base || base === snapshot.head) continue;
      // 上轮推送尚未包含这次合入的目标分支时，直接两点比较会混入上游
      // 改动。此时展示 MR 净贡献，不把 master 更新标成“本轮修复”。
      if ((await runSafeWorktreeGitAsync(task.cwd!, ["merge-base", "--is-ancestor",
        contribution.base_sha, base], { timeoutMs: 30_000 })).status !== 0) continue;
      focused = await compareDeliveryRevisions(task.cwd!, base, snapshot.head, { compact: true });
      if (focused) break;
    }
    // 目标分支推进只影响全量 MR 净贡献，不能覆盖已确定的本轮范围。
    const comparison = focused ?? await compareDeliveryRevisions(
      task.cwd!, contribution.base_sha, snapshot.head, { compact: true });
    const base = focused?.from ?? contribution.base_sha;
    const prepush = delivery?.prepush;
    const verification = prepush?.sha !== snapshot.head ? undefined : prepush?.state === "passed"
      ? "Build-Fix 已通过"
      : prepush?.state === "user_skipped"
        ? "本轮已按决定跳过 Build-Fix"
        : undefined;
    const agentNote = this.concisePushReviewNote(task);
    return {
      kind,
      ...copy[kind],
      description: `${copy[kind].description} 未跟踪的 node_modules、.venv、`
        + "__pycache__、.pytest_cache 目录不纳入清单；确需交付的文件请先暂存。",
      base_sha: base,
      baseline_sha: snapshot.baseline!,
      head_sha: snapshot.head,
      has_focused_changes: Boolean(focused) && base !== snapshot.baseline,
      file_count: comparison?.paths.length ?? contribution.paths.length,
      additions: comparison?.additions ?? 0,
      deletions: comparison?.deletions ?? 0,
      // 连基线比较都不可得(祖先关系断/提交不可见)时不许装作 +0/−0:
      // MFC-036 门禁通常会在这之前拦下,这里是最后的诚实兜底。
      ...(comparison ? {} : { stats_unavailable_reason:
        "提交历史与任务基线不再连续,无法计算逐行统计;"
        + "请先处理基线偏离,再核对完整交付视图" }),
      commits: comparison?.commits ?? [],
      all_paths: normalizedDeliveryPaths(snapshot.workspace_paths),
      committed_paths: contribution.paths,
      ...(agentNote ? { agent_note: agentNote } : {}),
      ...(verification ? { verification } : {}),
    };
  }

  /** 最终过目与人工意见复检遵守任务设置；历史文件清单不另设推送限制。 */
  private pushReviewPolicy(task: TaskState): PushReviewPolicy {
    const loop = task.summary.delivery?.loop;
    return pushReviewPolicyFor({
      reviewSource: loop?.review_source,
      workspaceRecheckRequired: loop?.workspace_review_recheck_required,
      unresolvedAnnotations: this.unresolvedAnnotations(task).length,
      taskSetting: task.summary.push_confirmation,
      accountDefault: () =>
        this.options.pushConfirmation?.(task.summary.luban_account),
    });
  }

  private async pushConfirmationSatisfied(
    task: TaskState,
    branch: string,
    force = false,
  ): Promise<boolean> {
    const loop = task.summary.delivery?.loop;
    const policy = this.pushReviewPolicy(task);
    const { recheckRequired } = policy;
    // 人工意见仍按原有复检处理，普通最终过目服从个人设置。
    const required = force || policy.required;
    if (!task.cwd) return true;
    if (!await this.existingMergeRequestAllowsDelivery(task, task.controlEpoch)) return false;
    if (!required) return true;
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot?.baseline) {
      this.markVerificationStalled(task,
        "开启了 push 前人工确认，但任务基线不可读，无法展示待推送的改动", "contract");
      return false;
    }
    // 已推送的 SHA 直接核对 MR/流水线；未推送版本沿用既有人工决定。
    if (task.summary.delivery?.git_push?.sha === snapshot.head) return true;
    // 最终卡出现之前,所有已提交意见必须处理完成(2026-09-05):还没处理完
    // 就先不举卡,让 Agent 接着处理;派过一轮仍未完成才按现状举卡。
    const reviewGap = await this.reviewProcessingGap(task);
    if (reviewGap.pending.length
        && this.dispatchReviewProcessing(task, reviewGap.pending) !== "exhausted") {
      return false;
    }
    const contribution = await this.deliveryContribution(task, snapshot);
    const committed = contribution.paths;
    const selection = task.summary.delivery_selection;
    const decisions = task.humanGate.resolved();
    if (!recheckRequired && hasPushApproval(selection, decisions)) return true;
    const cycleToken = recheckRequired ? loop?.review_ids : latestPushDecision(decisions)?.waiting_id;
    const callId = pushReviewCallId({
      head: snapshot.head,
      paths: committed,
    }, cycleToken);
    const waiting = task.summary.waiting;
    if (waiting?.step === CLOUD_PUSH_CONFIRM_STEP) {
      if (waiting.call_id === callId || samePaths(
        normalizedDeliveryPaths(task.summary.delivery?.push_review?.committed_paths ?? []), committed)) return false; // 同范围旧版本卡也继续等原回答
      task.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version,
        notes: "待确认的改动已更新，展示当前提交内容",
      });
    }
    const extras = snapshot.workspace_paths
      .filter((path) => !committed.includes(path));
    // HEAD 和文件集合用于展示；文件增减不会作废已有推送决定。
    const reviewAnnotationIds = new Set(
      loop?.workspace_review_annotation_ids ?? []);
    const reviewItems = recheckRequired
      ? this.annotations(task).list().filter((item) =>
          reviewAnnotationIds.has(item.id))
      : [];
    const pendingReviewItems = reviewItems.filter((item) =>
      item.status === "draft" || item.status === "sent");
    const pushReview = await this.buildPushReviewPresentation(
      task, snapshot, recheckRequired);
    task.summary.delivery = {
      ...task.summary.delivery,
      push_review: pushReview,
    };
    const manifest = await this.readPushFileList(task, branch, snapshot.head);
    const files = manifest.files;
    const reviewContext = recheckRequired ? [
      "**这是人工意见修改后的复检，不是按 push 次数重复询问。**",
      reviewItems.length
        ? `本轮关联 ${reviewItems.length} 条检视意见，目前还有 ${pendingReviewItems.length} 条待责任人逐条处置。`
        : "本轮是整体检视意见返工，请在最终代码上确认修改结果。",
      ...(pendingReviewItems.length ? [
        "任务责任人请核对回执及最新材料，逐条确认处置结果；任务责任人的“确认推送”不能代替逐条处置。",
      ] : ["逐条意见已经闭环，任务责任人可确认本次最终代码并推送。"]),
    ] : [];
    const context = [
      "**请检视当前已提交的改动。确认后将推送并创建或更新 MR。**",
      ...(task.summary.delivery?.codecheck ? [`CodeCheck 自查：${task.summary.delivery.codecheck.summary}`] : []),
      `**${pushReview.title}：${pushReview.file_count} 个文件，+${pushReview.additions} / -${pushReview.deletions}。**`,
      ...reviewContext,
      // 名字必须与界面一字不差:页签叫「交付材料」、按钮叫「工作区
      // 变更」。此前写「检视材料 → 本任务变更」,界面上根本没有这两个
      // 词,新人在唯一的人审闸口满屏找不到入口(2026-08-30 审计)。
      "完整代码变化在「交付材料 → 工作区变更」逐文件查看;发现问题可在"
      + "代码行上留批注,选「需要调整代码」让 Agent 修改。",
      "推送当前已提交的改动；发现问题可提出检视意见。" + PUSH_SCOPE_GUIDANCE,
      "",
      `提交分支：${branch} → ${task.summary.delivery?.target_branch ?? task.summary.baseline ?? "目标分支"}`,
      files ? deliveryFileList(files) : manifest.unavailable_reason ?? "本次推送清单暂不可读",
      ...(extras.length ? [
        `另有 ${extras.length} 个工作区文件不在本次提交中(未跟踪/未暂存),`
        + "不会被推送。"] : []),
    ].join("\n");
    task.summary.waiting = task.humanGate.createWaiting({
      taskId: task.summary.id,
      step: CLOUD_PUSH_CONFIRM_STEP,
      callId,
      questionInput: { questions: [{
        question: `请检视本次待推送代码(${files ? `${files.length} 个文件 → ` : ""}${branch})，是否推送？`,
        options: [PUSH_CONFIRM_ACCEPT, PUSH_CONFIRM_REWORK],
      }], push_file_list: manifest, ...(files ? { delivery_files: files } : {}) },
      context,
    });
    task.summary.status = "waiting_for_human";
    task.summary.detail = pushWaitingDetail(
      recheckRequired, pendingReviewItems.length);
    this.persist(task);
    if (recheckRequired) {
      this.notifyWorkspaceReviewReady(task, snapshot.head);
    } else {
      this.notifyWaiting(task);
    }
    this.options.log?.(
      `任务 ${task.summary.id} push 前确认卡已生成(HEAD ${snapshot.head.slice(0, 12)})`);
    return false;
  }

  /** MFC-036:交付历史必须生长在任务定格基线之上。Agent 整理清单时
   * reset/rebase 到基线父提交后,最终树可以看似正确,但祖先关系已断,
   * MR 永远无法快进合入,下游"这次修改"diff/统计也全部失真。这里在
   * Build-Fix 之前机械把净改动重放回定格基线(commit-tree 以旧 HEAD 的
   * 树为内容、定格基线为父,重放前后树逐字节一致),而不是等远端 409。
   * repair=false 用于推送前的最终复核:那时再脱离只如实停下,不改写。 */
  private async reconcileFrozenBaselineAncestry(
    task: TaskState,
    repair: boolean,
  ): Promise<"ok" | "repaired" | "blocked"> {
    if (!task.cwd) return "ok";
    const cwd = task.cwd;
    const frozen = await frozenTaskBaseline(cwd);
    // 旧现场没记录定格基线时无法裁决;不猜、不拿自愈回退假装校验过。
    if (!frozen) return "ok";
    // 定格基线的祖先关系对不上是完整性问题:先人工核实,不自动重试。
    const stall = (detail: string): "blocked" => {
      this.markVerificationStalled(task, detail, "safety");
      return "blocked";
    };
    const git = (args: string[]) => runSafeWorktreeGitAsync(cwd, args, {
      timeoutMs: 60_000,
      configs: [
        ["user.name", "mae-flow-cloud"],
        ["user.email", "cloud@mae-flow.local"],
        ...gitCommitIdentityConfigs(this.options.gitCredential?.(task.summary.luban_account)),
      ],
    });
    const exists = await git(["cat-file", "-e", `${frozen}^{commit}`]);
    if (exists.status !== 0) {
      return stall(`任务定格基线 ${frozen.slice(0, 7)} 在当前仓库已不可见,`
        + "无法核对交付历史是否仍生长在基线之上;请人工确认现场。");
    }
    const headResult = await git(["rev-parse", "--verify", "HEAD"]);
    const head = String(headResult.stdout ?? "").trim();
    if (headResult.status !== 0 || !head) {
      return stall("读取当前 HEAD 失败,无法核对定格基线祖先关系。");
    }
    const ancestor = await git(["merge-base", "--is-ancestor", frozen, head]);
    if (ancestor.status === 0) return "ok";
    if (!repair) {
      return stall(`推送前复核发现提交历史脱离任务定格基线 ${
        frozen.slice(0, 7)}(疑似验证期间又被改写);已停止推送,请人工确认。`);
    }
    // 重放仅改变提交父节点：commit-tree 读取旧 HEAD 的 tree，reset
    // --soft 保留索引与工作区。未提交内容不会被消费或夹带，不必拦它。
    // 分支上有外来提交时绝不重放:下面的 commit-tree 会把所有历史压成
    // 一条"净改动",人直接推上去的提交就此从历史里消失。平台可以整理
    // 自己的提交,不能替人处置别人的。
    const foreignBase = String(
      task.summary.delivery?.foreign_commits?.base_sha ?? "").trim();
    if (foreignBase && (await git(
      ["merge-base", "--is-ancestor", foreignBase, head])).status === 0) {
      return stall(`提交历史已脱离任务定格基线 ${frozen.slice(0, 7)},而分支上`
        + "还有别人直接推的提交;平台不改写别人的历史,请人工确认现场。");
    }
    const replay = await git(["commit-tree", `${head}^{tree}`, "-p", frozen,
      "-m", cloudCommitSubject(task.summary.ticket ?? task.summary.id, "fix",
        "按任务定格基线重放净改动——历史重排已被平台整理")]);
    const replayed = String(replay.stdout ?? "").trim();
    if (replay.status !== 0 || !replayed) {
      return stall(`按定格基线重放净改动失败:${String(
        replay.stderr || replay.error || "").trim().slice(0, 200)}`);
    }
    const moved = await git(["reset", "--soft", replayed]);
    if (moved.status !== 0) {
      return stall(`按定格基线重放后切换 HEAD 失败:${String(
        moved.stderr || moved.error || "").trim().slice(0, 200)}`);
    }
    // 重放合同:树逐字节一致 + 基线恢复为祖先。任一不成立都回到原 HEAD
    // 如实停下,绝不带着可疑历史继续交付。
    const sameTree = await git(["diff", "--quiet", head, "HEAD"]);
    const nowAncestor = await git(["merge-base", "--is-ancestor",
      frozen, "HEAD"]);
    if (sameTree.status !== 0 || nowAncestor.status !== 0) {
      await git(["reset", "--soft", head]);
      return stall("按定格基线重放后复核未通过(树不一致或祖先关系仍断);"
        + "已回到原 HEAD 停下,请人工确认。");
    }
    await preserveGitAiNotes(task.cwd!, new Map([[head, replayed]]), this.options.log);
    this.options.log?.(`任务 ${task.summary.id} 提交历史曾脱离定格基线 ${
      frozen.slice(0, 7)},已机械重放净改动(${head.slice(0, 7)} → ${
      replayed.slice(0, 7)}),树内容未变。`);
    return "repaired";
  }

  /** 兼容旧调用点：目录提示不再作为推送门禁。 */
  private async deliveryScopeAllowsPush(task: TaskState): Promise<boolean> {
    // 旧现场可能还留有越界卡。清除过时投影，正常推送检查继续，不伪造用户放行。
    if (task.summary.delivery?.scope_violation) {
      delete task.summary.delivery.scope_violation;
      this.persist(task);
    }
    return true;
  }

  /** 旧客户端的裁决入口保留明确错误，不能再派发按目录撤出代码的使命。 */
  decideScopeViolation(id: string, _decision: "allow" | "revert", _actor: string): TaskSummary {
    if (!this.tasks.has(id)) throw new NotFoundError(`任务 ${id} 不存在`);
    throw new TaskControlError("模块目录限制已取消，请刷新任务，通过现有检视提出具体意见");
  }

  /** 只清理 Agent 平台注入目录，不按历史文件选择撤销本轮业务修复。 */
  private async reconcileDeliveryPlatformBoundary(
    task: TaskState,
  ): Promise<"unchanged" | "changed" | "blocked"> {
    if (!task.cwd) return "unchanged";
    const cwd = task.cwd;
    this.registerAgentPlatformLocalExcludes(cwd);
    const snapshot = await deliveryChangeSnapshot(cwd);
    if (!snapshot?.baseline) return "unchanged";
    let contribution: { paths: string[]; base_sha: string };
    try { contribution = await this.deliveryContribution(task, snapshot); }
    catch (error) {
      task.summary.status = "failed";
      task.summary.detail = String(error);
      this.persist(task);
      return "blocked";
    }
    const current = contribution.paths;
    const platformHistory = normalizedDeliveryPaths(snapshot.added_agent_platform_paths ?? []);
    const platformPaths = current.filter(isAgentPlatformPath);
    if (!platformHistory.length && !platformPaths.length) return "unchanged";
    const targetPaths = current.filter(path => !isAgentPlatformPath(path));

    const run = async (args: string[], action: string) => {
      const result = await runSafeWorktreeGitAsync(cwd, args, {
        timeoutMs: 60_000,
        configs: [
          ["user.name", "mae-flow-cloud"],
          ["user.email", "cloud@mae-flow.local"],
          ...gitCommitIdentityConfigs(this.options.gitCredential?.(task.summary.luban_account)),
        ],
      });
      if (result.status !== 0) {
        throw new Error(`${action}失败：${String(
          result.stderr || result.error || "").trim().slice(0, 300)}`);
      }
      return String(result.stdout ?? "").trim();
    };
    const head = await run(["rev-parse", "--verify", "HEAD"], "读取当前 HEAD");
    const isAncestorSha = async (older: string, newer: string) =>
      (await runSafeWorktreeGitAsync(cwd,
        ["merge-base", "--is-ancestor", older, newer],
        { timeoutMs: 30_000 })).status === 0;
    // 已经在远端的提交是重组的**最老锚**。锚比它老,这次 reset 就会把
    // 推上去的提交一起卷进重写——别人直接推的外来提交会因此从历史里
    // 凭空消失。git_push 与外来提交基座都在远端,取其中更新的那个。
    const pushedSha = String(task.summary.delivery?.git_push?.sha ?? "").trim();
    const foreignBase = String(
      task.summary.delivery?.foreign_commits?.base_sha ?? "").trim();
    const remoteFloor = foreignBase
        && (!pushedSha || await isAncestorSha(pushedSha, foreignBase))
      ? foreignBase : pushedSha;
    const candidates = remoteFloor ? [remoteFloor] : [
      contribution.base_sha,
      // 首次推送只能以 MR 基点或任务基线重组。曾被检视的本地提交
      // 仍可能包含排除文件或平台目录，不能把 selection.head 当作干净父提交。
      await frozenTaskBaseline(cwd),
    ].map((value) => String(value ?? "").trim()).filter(Boolean);
    let anchor = "";
    for (const candidate of candidates) {
      const ancestor = await runSafeWorktreeGitAsync(cwd,
        ["merge-base", "--is-ancestor", candidate, head], { timeoutMs: 30_000 });
      if (ancestor.status === 0 && candidate !== head) {
        anchor = candidate;
        break;
      }
    }
    if (!anchor) {
      const detail = "提交历史包含平台本地目录，但找不到可靠的整理起点。"
        + "未改写已推送历史，请在代码检视中确认处理。";
      task.summary.status = "failed";
      task.summary.detail = detail;
      task.summary.delivery = { ...task.summary.delivery, skipped: detail };
      this.persist(task);
      return "blocked";
    }

    // 只重建已提交的树，未提交/未跟踪文件不参与整理，不猜它们是否为
    // 编译产物。保留目标分支父节点，不能把合入的上游代码算成本单新增。
    const preserveTarget = !await isAncestorSha(contribution.base_sha, anchor);
    const restorePaths = (await run(["diff", "--name-only", "--no-renames", "-z",
      contribution.base_sha, head, "--"], "读取排除路径差异")).split("\0")
      .filter(path => path && isAgentPlatformPath(path));
    try {
      const commit = await deliveryCommitTree({ cwd, head, baseline: contribution.base_sha,
        parents: [anchor, ...(preserveTarget ? [contribution.base_sha] : [])], restorePaths,
        configs: [["user.name", "mae-flow-cloud"], ["user.email", "cloud@mae-flow.local"],
          ...gitCommitIdentityConfigs(this.options.gitCredential?.(task.summary.luban_account))],
        message: cloudCommitSubject(task.summary.ticket ?? task.summary.id, "fix", "清理提交中的平台本地目录"),
      });
      const afterPaths = normalizedDeliveryPaths((await run(["diff", "--name-only", "-z",
        contribution.base_sha, commit, "--"], "复核整理后的范围")).split("\0"));
      const remainingPlatform = (await run(["log", "--format=", "--name-only", "-z", "--diff-filter=A",
        `${contribution.base_sha}..${commit}`, "--", ...AGENT_PLATFORM_ROOTS], "复核平台目录历史"))
        .split("\0").map(path => path.trim()).filter(isAgentPlatformPath);
      if (remainingPlatform.length || !samePaths(afterPaths, targetPaths)) {
        throw new Error(`整理后的范围复核未通过：${describeDirtyPaths(remainingPlatform.length
          ? remainingPlatform : [...afterPaths.filter(path => !targetPaths.includes(path)),
            ...targetPaths.filter(path => !afterPaths.includes(path))])}；原提交、索引与工作区均未修改`);
      }
      await run(["update-ref", "HEAD", commit, head], "接续整理后的提交");
      await preserveGitAiNotes(cwd, new Map([[head, commit]]), this.options.log);
      // 仅撤出已明确排除的暂存项；其他文件的 staged/unstaged 状态保持原样。
      if (restorePaths.length) await run(["restore", "--source", commit, "--staged", "--",
        ...restorePaths.map(path => `:(literal)${path}`)], "更新排除项索引");
    } catch (error) {
      const detail = `平台本地目录清理失败：${String(error)}。工作区内容保留，可查看代码并补充处理要求。`;
      task.summary.status = "failed";
      task.summary.detail = detail;
      task.summary.delivery = { ...task.summary.delivery, skipped: detail };
      this.persist(task);
      return "blocked";
    }

    this.registerAgentPlatformLocalExcludes(cwd);
    this.options.log?.(
      `任务 ${task.summary.id} 已移除提交历史中的平台本地目录：${
        describeDirtyPaths([...new Set([...platformPaths, ...platformHistory])])}`);
    return "changed";
  }

  /** 中心能力注入目录绝不能靠 Agent 自觉。info/exclude 防普通 add，
   * 这里复核从任务基线到 HEAD 的整个提交历史，连“先提交、后删除”也
   * 拦住——删除后的 blob 仍会随分支传到远端，最终树干净不代表安全。 */
  private async agentPlatformChangesAllowPush(task: TaskState): Promise<boolean> {
    if (!task.cwd) return false;
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    const paths = snapshot?.added_agent_platform_paths ?? [];
    if (!paths.length) return true;
    const detail = "已阻止 push：本任务提交历史包含 Agent 平台本地目录 "
      + `${describeDirtyPaths(paths)}。这些目录可能由中心服务注入，只供当前`
      + "工作区使用，不能进入业务仓；请从本任务提交历史中移除这些路径后"
      + "重新提交（不要修改业务仓 .gitignore）。";
    task.summary.status = "failed";
    task.summary.detail = detail;
    task.summary.delivery = { ...task.summary.delivery, skipped: detail };
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id} ${detail}`);
    return false;
  }

  private async checkCodecheckBeforePush(task: TaskState, epoch: number, target?: string): Promise<void> {
    if (!task.cwd || !this.current(task, epoch)) return;
    const head = (await this.prePushRevision(task)).sha;
    if (task.summary.delivery?.git_push?.sha === head) return;
    const result = await runCodecheckPrepush({
      repo: task.cwd, workspace: task.cwd,
      recordRoot: join(task.summary.workspace, "codecheck"),
      sourceRoot: taskHostSkillsDir(this.options.dataDir, task.summary),
      moduleDataDir: this.options.dataDir,
      context: task.summary.host_skills_pinned ? undefined : {
        repositories: task.summary.repositories ?? [],
        technologies: [...new Set((task.summary.repository_profiles ?? []).flatMap(p => p.technologies))],
        businessModuleIds: (task.summary.business_modules ?? []).map(module => module.id),
      },
      base: await frozenTaskBaseline(task.cwd),
      target: task.summary.delivery?.target_branch ?? target,
      ticket: task.summary.ticket,
      commitConvention: this.effectiveCommitConvention(),
      log: this.options.log,
      run: this.options.codecheck?.runner ?? (async request => {
        if (!this.options.isolation) throw new Error("CodeCheck 需要任务执行容器，未回退到宿主运行");
        if (!this.current(task, epoch)) throw new TaskControlError("任务已停止");
        await abortAuxiliarySessions(task);
        if (!this.current(task, epoch)) throw new TaskControlError("任务已停止");
        if (interruptWarmupReceipt(task.summary.baseline_build)) this.persist(task);
        const agentDir = join(task.summary.workspace, "pi-agent");
        mkdirSync(agentDir, { recursive: true });
        const models = this.sessionModels(task);
        writeFileSync(join(agentDir, "models.json"), JSON.stringify(models.json));
        repairContainerMutationOwnership({ workspace: task.cwd!, path: join(request.repo, ".codecheckcli"), user: this.options.isolation?.user, recursive: true });
        task.summary.detail = "正在执行上传的 CodeCheck Skill，完成后继续推送";
        this.persist(task);
        return runCodecheckSkillSession(task, request, {
          taskId: `${task.summary.id}:codecheck`, workspace: task.cwd!, agentDir,
          provider: models.choice?.provider ?? this.options.provider,
          model: models.choice?.model ?? this.options.model,
          eventLog: new EventLog(join(task.summary.workspace, "codecheck", "events.jsonl")),
          transcript: new TranscriptStore(join(task.summary.workspace, "codecheck", "transcript.jsonl"), "codecheck"),
          humanGate: task.humanGate, streamBashOutput: true,
          onTokenUsage: sample => this.recordTaskTokenUsage(task, sample),
          bashOperations: { exec: async (command, dir, options) => {
            if (!this.current(task, epoch)) throw new TaskControlError("任务已停止");
            const container = await this.activeTaskContainer(task);
            if (!this.current(task, epoch)) throw new TaskControlError("任务已停止");
            return createContainerBashOperations(() => container).exec(command, dir, options);
          } },
          afterFileMutation: path => { repairContainerMutationOwnership({ workspace: task.cwd!, path,
            user: this.options.isolation?.user }); },
          log: this.options.log,
        });
      }),
    });
    if (!this.current(task, epoch)) return;
    task.summary.delivery = { ...task.summary.delivery, codecheck: result };
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id}：${result.summary}`);
  }

  /** Git 交付(§10):任务收轮并释放 Agent 后,由宿主推送并反查远端
   * SHA，再建 MR——不信任务自己的说法，也不让 Agent 接触 token。
   * MR 成功≠完成:流水线过了才"等待合入",否则停在"验证中"。
   * 交付失败不吞:原因写进 summary.delivery,任务保持 completed。 */
  private recordPublishedPush(task: TaskState, receipt: NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>): void {
    recordDeliveryPublication(task.summary, task.cwd, receipt.sha);
    if (this.options.host && task.cwd && this.continuousReviewTask(task)) recordKernelPublishedPush({
      host: this.options.host, cwd: task.cwd, workspace: task.summary.workspace, taskId: task.summary.id, receipt });
    this.syncFeedbackStoreFromKernel(task, true);
  }

  private async tryDeliver(
    task: TaskState,
    epoch: number,
  ): Promise<"review_reply_blocked" | undefined> {
    if (task.deliveryActive) return;
    task.deliveryActive = true;
    try { return await this.performDelivery(task, epoch); }
    finally { task.deliveryActive = false; }
  }

  private async performDelivery(
    task: TaskState,
    epoch: number,
  ): Promise<"review_reply_blocked" | undefined> {
    // 多仓父任务只负责需求理解和人工检视，不产生分支/MR。
    if (this.isRequirementAnalysis(task)) return;
    if (task.prepushActive && !await task.prepushActive) return;
    if (!this.current(task, epoch)) return;
    if (this.current(task, epoch) && !task.driver && this.atExternalVerificationWait(task)
        && ["running", "queued"].includes(task.summary.status)) {
      task.summary.status = "verifying"; task.summary.detail = "宿主正在接续交付与流水线验证"; this.persist(task);
    }
    // task-40：已知 MR 可能已被人在远端合入，本地却仍是“验证中”。
    // 这类必须先查同一个 MR，不能先 rebase/push。首次交付尚无 MR 时
    // 则在真正推送前做同样的远端发现与核验。按需编译通过独立入口执行。
    const knownMr = Boolean(task.summary.delivery?.mr_url?.trim()
      || String(task.summary.delivery?.mr_id ?? "").trim());
    if (knownMr
        && !await this.existingMergeRequestAllowsDelivery(task, epoch)) return;
    // settle 在调用交付前已经释放修复会话并清空 mission。此刻开始处理
    // 的是修复结果验证，不再是“Agent 正在修复”；远端访问可能耗时很长，
    // 这条转换必须在任何外部 I/O 之前持久化，重启和页面才能同一口径。
    if (enterRepairVerification(task)) this.persist(task);
    // 按需验证由独立入口恢复；常规交付等待外部平台就绪。
    const platformUrl = this.effectivePlatformUrl();
    if (!platformUrl || !this.options.host) {
      if (this.atExternalVerificationWait(task)) {
        this.holdWithRecovery(
          task, "等待权威流水线：MR / 流水线服务未就绪", epoch);
      }
      return;
    }
    if (!task.cwd) {
      // active_attempt 是死进程留下的确证；启用 prepush 的当前部署也有
      // 责任说清环境缺口。两者都没有时可能只是旧版只读台账，保持兼容。
      if (task.summary.delivery?.prepush?.active_attempt
          || this.options.prepush?.enabled) {
        this.failPendingPrePush(task, "代码现场路径缺失");
      }
      return;
    }
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) {
        const reason = "流程未初始化,无可交付";
        task.summary.delivery = { ...task.summary.delivery, skipped: reason };
        if (task.summary.delivery.prepush
            && !["passed", "user_skipped", "blocked", "environment_error"]
              .includes(task.summary.delivery.prepush.state)) {
          this.failPendingPrePush(task, reason);
        } else {
          this.persist(task);
        }
        return;
      }
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const branch = String(state?.config?.["分支名"] ?? "");
      const baseline = String(state?.config?.["基线分支"] ?? "");
      if (!branch || !baseline) {
        const reason = "配置未确认,无分支可交付";
        task.summary.delivery = { ...task.summary.delivery, skipped: reason };
        if (state.current === "external_verify") {
          // 这一条重试没有意义:配置不会自己长出来。直接如实停下喊人,
          // 别用预算空转半小时再说同一句话。
          this.markVerificationStalled(task, reason, "contract");
        } else if (task.summary.delivery.prepush
            && !["passed", "user_skipped", "blocked", "environment_error"]
              .includes(task.summary.delivery.prepush.state)) {
          this.failPendingPrePush(task, reason);
        } else {
          this.persist(task);
        }
        return;
      }
      // 远端分支被人推过就先把自己的提交接到它后面。这必须走在最前:
      // 后面的范围整理、推送确认全都绑 HEAD,接续换了 HEAD
      // 就得整条链重来一遍(task-40 实锤:不接续只会拿同一个 SHA 撞
      // non-fast-forward 一百多次)。
      if (await this.absorbForeignRemoteCommits(task, branch) === "blocked") {
        return;
      }
      if (!this.current(task, epoch)) return;
      try {
        await this.syncTargetBeforePush(task, task.summary.delivery?.target_branch ?? baseline, epoch);
      } catch (error) {
        if (!this.current(task, epoch)) return;
        const conflicts = runSafeWorktreeGit(task.cwd, ["diff", "--name-only", "--diff-filter=U"]);
        // 网络或凭据故障沿用交付恢复；只有真实代码冲突才唤醒 Agent。
        if (conflicts.status !== 0 || !String(conflicts.stdout ?? "").trim()) throw error;
        this.enqueueRepair(task, [task.mission, String(error)].filter(Boolean).join("\n\n"),
          "推送前分支同步未完成，继续处理后再推送");
        return;
      }
      // 定格基线祖先门禁必须走在一切交付动作(范围整理/推送)
      // 之前:历史脱离基线时后面每一步都在错的合同上白烧。
      const baselineGate =
        await this.reconcileFrozenBaselineAncestry(task, true);
      if (baselineGate === "blocked") return;
      // 清理历史目录限制卡，继续现有验证和交付确认。
      if (!await this.deliveryScopeAllowsPush(task)) return;
      await this.checkCodecheckBeforePush(task, epoch, baseline);
      if (!this.current(task, epoch)) return;
      // 平台注入目录不能发布；业务文件按本轮需求修复，不受旧勾选限制。
      if (await this.reconcileDeliveryPlatformBoundary(task) === "blocked") return;
      if (!await this.agentPlatformChangesAllowPush(task)) return;
      if (await this.ensureCommitMessagePolicy(task) === "blocked") return;
      // 独立 Build-Fix 仅由显式验证请求启动。交付不再补跑编译或 UT，
      // 已有按需验证的结果保留供人判断，不能当成推送授权的前提。
      // 首次交付仍须在人工确认和 push 前核对远端 MR/分支事实。
      if (!knownMr
          && !await this.existingMergeRequestAllowsDelivery(task, epoch)) return;
      if (task.summary.delivery?.loop?.workspace_review_pending) {
        task.summary.delivery.loop.workspace_review_pending = false;
        this.persist(task);
      }
      if (!this.current(task, epoch)) return;
      // 平台检视回复必须在已有按需验证以及交付范围机械整理全部收敛后
      // 才绑定最终 HEAD 入 outbox。此前在普通 Agent 收口时就入队，
      // prepush 若继续修码产生新提交，回复会错误地借后一个 SHA 发送。
      if (task.summary.delivery?.loop?.kind === "review"
          && task.summary.delivery.loop.review_source === "platform") {
        const staged = await this.stageReviewReplies(task);
        if (!staged.ok) {
          const loop = task.summary.delivery.loop;
          loop.state = "halted";
          loop.diagnosis = staged.detail;
          task.summary.status = "verifying";
          task.summary.detail = staged.detail ?? "MR 逐条回复不完整";
          task.summary.delivery.stalled = task.summary.detail;
          task.summary.delivery.stall_class = "evidence_invalid";
          this.persist(task);
          this.notifyRepairStopped(task);
          return "review_reply_blocked";
        }
        if (!this.current(task, epoch)) return;
      }
      // 从这里开始才需要外部交付平台。prepush 已经有明确收口，不会因
      // 平台配置在部署窗口暂缺而留下“准备中但没有 owner”的僵尸状态。
      if (!platformUrl || !this.options.host) {
        const reason = "等待权威流水线：MR / 流水线服务未就绪";
        if (this.atExternalVerificationWait(task)) {
          this.holdWithRecovery(task, reason, epoch);
        } else {
          task.summary.delivery = {
            ...task.summary.delivery,
            skipped: reason,
          };
          this.persist(task);
        }
        return;
      }
      // 传输绑定当前 HEAD，避免推送期间并发改写造成发布事实记错；
      // 这个 SHA 检查不用于作废已有推送确认。
      const observedRevision = await this.prePushRevision(task);
      let expectedPushSha = observedRevision.sha;
      if (!await this.pushConfirmationSatisfied(task, branch)) return;
      const existingPushReceipt = task.summary.delivery?.git_push?.sha
        === expectedPushSha ? task.summary.delivery.git_push : undefined;
      const arTicket = String(task.summary.ticket ?? state?.config?.["单号"] ?? branch).trim();
      const mrDescription = savedMrDescription(task.humanGate, task.summary.id, arTicket);
      if (!mrDescription && !task.summary.delivery?.mr_url
          && task.summary.delivery?.mr_id === undefined) {
        task.summary.waiting = askMrDescription(task.humanGate, task.summary.id, arTicket);
        task.summary.status = "waiting_for_human";
        task.summary.detail = "创建 MR 前，请填写 AR 单对应的准确描述";
        this.persist(task);
        this.notifyWaiting(task);
        return;
      }
      // 推送前最后一道基线复核:Build-Fix/确认期间若历史又被改写,
      // 只如实停下(fail-closed),不在这个时点做任何机械改写。
      if (!existingPushReceipt
          && await this.reconcileFrozenBaselineAncestry(task, false)
          === "blocked") return;
      const previous = task.summary.delivery;
      // 自动恢复时，同 SHA 必须复用既有流水线，避免无故烧钱；但任务已
      // 因外部配置/权限问题停机、责任人明确点“重跑续推”时，旧红灯正是
      // 人要重新验证的对象。此时不能先查询到旧 failed 又原样停机，应该
      // 触发一条新的同 SHA 流水线。retry() 写入的标记只活到本次交付。
      const manualPipelineRetry = previous?.pipeline
        === "人工重跑,待重新验证";
      const pushReceipt = existingPushReceipt ?? await pushWithFreshBranch(async () => {
        if (!await this.existingMergeRequestAllowsDelivery(task, epoch)) return undefined;
        await assertNoCodecheckCommits(task.cwd!, await frozenTaskBaseline(task.cwd!));
        return this.pushFromHost(task, branch, expectedPushSha);
      }, async () => {
        if (!await this.existingMergeRequestAllowsDelivery(task, epoch)) return false;
        if (await this.absorbForeignRemoteCommits(task, branch) === "blocked") return false;
        await this.syncTargetBeforePush(task, task.summary.delivery?.target_branch ?? baseline, epoch);
        await this.checkCodecheckBeforePush(task, epoch, baseline);
        if (!this.current(task, epoch) || await this.reconcileDeliveryPlatformBoundary(task) === "blocked") return false;
        if (await this.reconcileFrozenBaselineAncestry(task, false) === "blocked") return false;
        if (task.summary.delivery?.loop?.kind === "review" && task.summary.delivery.loop.review_source === "platform") {
          const staged = await this.stageReviewReplies(task);
          if (!staged.ok) { this.markVerificationStalled(task, staged.detail ?? "检视回复尚未准备好", "evidence_invalid"); return false; }
        }
        expectedPushSha = (await this.prePushRevision(task)).sha;
        return this.current(task, epoch);
      });
      if (!pushReceipt) return;
      const sha = pushReceipt.sha;
      projectPushReceipt(task.summary, pushReceipt);
      // push 已经发生就先落账；即使随后 MR/流水线接口抖动，恢复时也能
      // 复核同一 SHA，不会把传输事实误当成 Agent 自述。
      this.persist(task);
      scopePipelineArtifacts(join(task.summary.workspace, "pipeline"), pushReceipt.sha);
      this.recordPublishedPush(task, pushReceipt);
      if (!this.current(task, epoch)) return;
      // 检视回复只能在对应代码可从远端看见后发送。部分失败保留在
      // outbox，后续监控/重启继续；不重派 Agent、不删除失败项。
      if (!await this.flushReviewReplyOutbox(task)) {
        this.scheduleDeliveryRecovery(task, epoch);
        return "review_reply_blocked";
      }
      if (!this.current(task, epoch)) return;
      // 修复回程的岔路:SHA 没变说明本轮没有新代码(检视修复只回复
      // 不改码、或修复会话判断无需改动)。这时**绝不再触发流水线**
      // ——远端每跑一条流水线都是钱,同 SHA 重跑还是同一个结果。
      // 上一轮绿 → 直接回门禁监控;上一轮红 → 重新分类裁决
      // (检视清了之后可能轮到 CI 修,brake 按类各管各的)。
      if (previous?.sha === sha && previous.pipeline && previous.mr_url) {
        if (previous.pipeline === "success") {
          // 同 SHA 的总体绿灯只复用事实，不复用结论。进程可能上次死在
          // 内核登记前也可能进程退出；重新核销但绝不重跑同 SHA 流水线。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "success", "",
            previous.checks, epoch);
          return;
        }
        if (previous.pipeline.startsWith("failed")) {
          // 老路径里状态由触发块扳到 verifying,这条岔路必须自己扳——
          // 不扳的话 settle 会把还红着的任务误收成 completed(实测)。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "failed",
            previous.loop?.failure ?? "", previous.checks, epoch);
          return;
        }
        if (previous.pipeline.startsWith("running") || previous.pipeline === "not_found"
            || previous.pipeline === "查询失败，正在重试") {
          // 同 SHA 上次还挂着"运行中"(含预算耗尽/拒过期结果注记):流水线
          // 大概率仍在远端跑或早已出结果只是没人盯。跌进下面的触发块
          // 就是重建 MR + 同 SHA 重触发——远端每条流水线都是钱。
          // 唯一正确动作:带新预算续轮,已终态的第一轮查询就能收口。
          task.summary.status = "verifying";
          this.persist(task);
          this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
          return;
        }
      }
      // 外部动作台账(§11):请求先落一行(带幂等键),结果回来再补
      // 结果侧——恢复时"先查远端真实状态"就有底账可对。纯旁路。
      const ledger = (action: Omit<ExternalAction, "taskId">) =>
        this.bypass(task, "投影动作", this.options.projection?.recordAction(
          { taskId: task.summary.id, ...action }));
      const mrRequest = {
        // 任务级仓进了场,适配层必须知道这单落在哪个仓——
        // repo 字段随 MR/流水线请求走,假件(单仓)忽略它无害。
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo(),
        source_branch: branch,
        target_branch: baseline,
        // AR 描述是合入标题契约，不能再拼单号或编译状态后缀。
        // 已有 MR 只复用，不要求补填或改写其远端标题。
        title: mrDescription ?? task.summary.title ?? taskTitle(task.summary.requirement),
        // E2E 单号关联(内网诉求 2026-08-19):单号只拼进 title 平台看
        // 不见,要走 codehub-cli 的 --e2e-issues 才可追踪。取值优先
        // **用户下单填的需求号**(用户拍板"直接关联开始填入的那个"),
        // 回落内核配置确认的定稿(老单/无表单形态);REQ/DTS 都走这个
        // 参数,平台不区分类型(toolkit 源码里两类混传)。字段名跟
        // 内网 adapter.json 已定的 {dts_no} 占位符,不折腾他们返工。
        dts_no: task.summary.ticket
          ?? String(state?.config?.["单号"] ?? ""),
      };
      const mrKey = `mr:${branch}->${baseline}`;
      const mrStarted = new Date().toISOString();
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted });
      // MR 创建走公共客户端(与问题流共用同一格式):适配层负责
      // codehub CLI、单号关联与输出抽取,这里只递身份与事实。
      const mr = await this.createDeliveryMr(task, {
        platformUrl,
        repo: mrRequest.repo ?? pushReceipt.url ?? undefined,
        sourceBranch: branch,
        targetBranch: baseline,
        title: mrRequest.title,
        ...(mrRequest.dts_no ? { dtsNo: mrRequest.dts_no } : {}),
        credential: this.options.gitCredential?.(task.summary.luban_account),
      });
      if (!this.current(task, epoch)) return;
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted,
               // 入账用平台的原始响应,不是抽剩的 url/id:台账是恢复时
               // "先查远端真实状态"的底账,裁字段等于自断证据。
               result: mr.raw,
               finishedAt: new Date().toISOString() });
      // MR 一创建就落盘并监听，不能等流水线请求成功，更不能等到绿灯。
      const initial = captureOriginalMr(task.summary, mr.url, sha);
      task.summary.delivery = { ...task.summary.delivery, initial_mr: initial,
        mr_url: mr.url, mr_id: mr.id, mr_participants: mr.participants, source_branch: branch,
        target_branch: baseline, git_push: pushReceipt };
      this.persist(task);
      this.ensureMergeWatch(task, !previous?.mr_url);
      this.deliveryExperiences.capture(task);
      const runKey = `pipeline:${sha}`;
      if (existingPushReceipt && !manualPipelineRetry) {
        const observed = await getPipelineStatus({ platformUrl, sha, repo: mrRequest.repo,
          mr: mr.id === undefined ? undefined : String(mr.id), credential: this.options.gitCredential?.(task.summary.luban_account) });
        if (!this.current(task, epoch)) return;
        const known = observedPipelineRun(sha, observed);
        if (known || new TaskHostLedger(task.summary).read().operations.some(op => op.sha === sha && op.trigger_started)) {
          await this.acceptPipelineRun(task, sha, known, epoch); return;
        }
      }
      const runStarted = new Date().toISOString();
      const runRequest = { sha, repo: mrRequest.repo };
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted });
      const run = await triggerPipeline({ platformUrl, sha, repo: mrRequest.repo,
        mr: mr.id === undefined ? undefined : String(mr.id), credential: this.options.gitCredential?.(task.summary.luban_account) });
      if (!this.current(task, epoch)) return;
      const acceptedRun = observedPipelineRun(sha, run);
      const checks = acceptedRun?.checks;
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted, result: { ...run },
               finishedAt: new Date().toISOString() });
      task.summary.delivery = {
        ...(task.summary.delivery?.loop
          ? { loop: task.summary.delivery.loop } : {}),
        ...(task.summary.delivery?.prepush
          ? { prepush: task.summary.delivery.prepush } : {}),
        ...(task.summary.delivery?.codecheck
          ? { codecheck: task.summary.delivery.codecheck } : {}),
        // 外来提交是**分支**的既成事实,不是这一轮的过程状态:这份台账
        // 一丢,下一轮的重组锚就会退回更老的 SHA,把人推的提交抹掉。
        ...(task.summary.delivery?.foreign_commits
          ? { foreign_commits: task.summary.delivery.foreign_commits } : {}),
        last_push_base_sha: task.summary.delivery?.last_push_base_sha,
        git_push: pushReceipt,
        initial_mr: task.summary.delivery?.initial_mr,
        mr_url: mr.url,
        mr_participants: mr.participants,
        // 平台给了 MR 标识就记下:门禁/讨论查询要带回去(假件给 id,
        // codehubcli 给 iid;没有也不碍事,适配层还能按分支对查)。
        ...(mr.id !== undefined ? { mr_id: mr.id } : {}),
        source_branch: branch,
        target_branch: baseline,
        mr_state: "验证中",
        pipeline: run.status,
        ...(checks !== undefined ? { checks } : {}),
        sha,
      };
      await this.acceptPipelineRun(task, sha, acceptedRun, epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      // 嵌套的 "Error: Error: …" 前缀对人是噪声,剥掉再进卡片/日志。
      if (error instanceof CodecheckArtifactCommitError) {
        this.markVerificationStalled(task, error.message, "contract"); return;
      }
      if (error instanceof RemoteBranchBusyError) {
        this.markVerificationStalled(task, error.message, "safety"); return;
      }
      const rawCause = String(error).replace(/^(Error:\s*)+/, "");
      const cause = userFacingDeliveryFailure(error);
      if (cause !== rawCause) {
        this.options.log?.(`任务 ${task.summary.id} 交付原始异常:${rawCause}`);
      }
      const reason = `交付动作失败: ${cause}`;
      task.summary.delivery = { ...task.summary.delivery, skipped: reason };
      const prepush = task.summary.delivery.prepush;
      if (prepush
          && !["passed", "user_skipped", "blocked", "environment_error"]
            .includes(prepush.state)) {
        this.failPendingPrePush(task, cause);
        this.options.log?.(`任务 ${task.summary.id} ${reason}`);
        return;
      }
      if (this.atExternalVerificationWait(task)) {
        // 该重试还是该停下喊人,只由 deliveryFailure 判一次:
        // push 504 / MR 网关 500 这类多半是一阵子的事,自己再试几轮;
        // 确定性 4xx 和契约损坏例外——同一请求再发一百次还是那个结果,
        // 不烧重试预算(MFC-020 实测同文 MR-400 刷了 86 条日志两轮预算)。
        const verdict = classifyDeliveryFailure(cause);
        const message = deliveryFailureMessage(cause, reason);
        if (verdict.disposition === "stall") {
          this.markVerificationStalled(task, message, verdict.stall_class);
        } else {
          this.holdWithRecovery(task, message, epoch);
        }
        this.options.log?.(`任务 ${task.summary.id} 交付失败判为 `
          + `${verdict.disposition}:${verdict.why}`);
      }
      this.logDeliveryFailure(task, reason);
    }
  }

  /** 同因交付失败按指纹聚合:首次全文,其后每 10 次记一条计数——
   * 排障要的是"发生了什么、重复了多少次",不是 86 条同文刷屏。 */
  private logDeliveryFailure(task: TaskState, reason: string): void {
    const fingerprint = reason.slice(0, 200);
    const last = task.deliveryFailureLog;
    if (last?.fingerprint === fingerprint) {
      last.count += 1;
      if (last.count % 10 === 0) {
        this.options.log?.(`任务 ${task.summary.id} 交付失败已重复 `
          + `${last.count} 次(同一原因,已聚合): ${fingerprint.slice(0, 80)}…`);
      }
      return;
    }
    task.deliveryFailureLog = { fingerprint, count: 1 };
    this.options.log?.(`任务 ${task.summary.id} ${reason}`);
  }

  /** 提前发布不是交付收口。只有内核交接或纯 CI 修复完成，且没有新插话时才接管。 */
  private pipelineCanTakeOver(task: TaskState): boolean {
    return this.hasDeliveryMr(task)
      && !task.pendingMainSteers?.length && !task.driver
      && (shouldVerifyCiPush(task.mission, task.summary)
        || (!task.mission && this.atHostDeliveryWait(task)));
  }

  private hasDeliveryMr(task: TaskState): boolean {
    return !!task.summary.delivery?.mr_url?.trim()
      || task.summary.delivery?.mr_id !== undefined;
  }

  /** 未建 MR 时交付入口负责推送/建 MR；编码中的提前验证仍归原会话。 */
  private needsDeliveryBeforePipeline(task: TaskState): boolean {
    return !this.hasDeliveryMr(task)
      && !task.driver && !task.mission && !task.pendingMainSteers?.length
      && this.atHostDeliveryWait(task);
  }

  /** 同一份远端事实有两种用途：编码期间供参考，交付期间驱动裁决。 */
  private async acceptPipelineRun(task: TaskState, sha: string, response: PipelineRun | undefined,
    epoch: number, background = false): Promise<boolean> {
    if (!this.current(task, epoch)) return true;
    const run = projectPipelineRun(task, sha, response, background);
    this.persist(task);
    this.ensureMergeWatch(task);
    if (background || !run || run.status === "running") this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch, background));
    else await this.pipelineVerdict(task, sha, run.status, run.log ?? "", run.checks, epoch);
    return !background;
  }

  private async pollPipeline(task: TaskState, epoch: number, background = false): Promise<void> {
    if (this.needsDeliveryBeforePipeline(task)) {
      if (!background && task.summary.status === "verifying") await this.tryDeliver(task, epoch);
      return;
    }
    // 裸分支的查询只能是编码期间的旁路观察，不能接管正式交付。
    if (!background && !this.hasDeliveryMr(task)) return;
    const sha = task.summary.delivery?.sha, platformUrl = this.effectivePlatformUrl();
    if (!platformUrl || !sha) return;
    // 提前验证按任务/SHA 存活；正式验证仍服从会话代际，二者共用单一监听槽。
    const owner = background ? -1 : epoch;
    if (task.pipelinePollSha === sha && task.pipelinePollEpoch === owner) return;
    task.pipelinePollSha = sha; task.pipelinePollEpoch = owner;
    const current = () => !this.shuttingDown && this.tasks.get(task.summary.id) === task
      && !["completed", "canceled"].includes(task.summary.status)
      && task.summary.delivery?.sha === sha && task.pipelinePollSha === sha && task.pipelinePollEpoch === owner
      && !this.needsDeliveryBeforePipeline(task)
      && (background || this.hasDeliveryMr(task))
      && (background || (this.current(task, epoch) && task.summary.status === "verifying"
        && !task.summary.delivery?.stalled));
    const waitingForRun = (reason: string): boolean => {
      if (background || !current()) return false;
      const before = task.summary.delivery?.verify_deadline;
      const deadline = this.verificationDeadline(task);
      if (task.summary.delivery?.verify_deadline !== before) this.persist(task);
      if (Date.now() < deadline) return false;
      this.markVerificationStalled(task, reason, "infrastructure");
      return true;
    };
    try {
      await watchTaskPipeline({
        call: () => ({ platformUrl, sha, repo: task.summary.repo_url ?? this.effectiveDefaultRepo(),
          mr: task.summary.delivery?.mr_id === undefined ? undefined : String(task.summary.delivery.mr_id),
          credential: this.options.gitCredential?.(task.summary.luban_account) }),
        interval: (this.options.settings?.runtime().poll_interval_s ?? ((this.options.delivery?.pollIntervalMs ?? 30_000) / 1000)) * 1000,
        current,
        observed: async run => {
          // 旁路永不抢交付：正式入口核对 HEAD、范围和 MR 后会接管监听槽。
          const canSettle = !background && task.summary.status === "verifying";
          task.summary.delivery = { ...task.summary.delivery, pipeline: run?.status ?? "not_found", checks: run?.checks,
            ...(!background && run ? { skipped: undefined } : {}) };
          if (!background && run) task.summary.delivery.verify_deadline = undefined;
          this.persist(task);
          if (!run && waitingForRun(
            `已创建 MR，但在等待期限内仍未找到提交 ${sha.slice(0, 8)} 的有效流水线；请检查平台触发与查询配置`)) return true;
          if (run && run.status !== "running" && canSettle) {
            await this.pipelineVerdict(task, sha, run.status, run.log ?? "", run.checks, task.controlEpoch);
            return true;
          }
          return false;
        },
        unavailable: error => {
          task.summary.delivery = { ...task.summary.delivery, pipeline: "查询失败，正在重试" };
          this.persist(task);
          this.options.log?.(`任务 ${task.summary.id} 流水线查询失败(继续轮): ${String(error)}`);
          return waitingForRun(
            `提交 ${sha.slice(0, 8)} 的流水线持续查询失败：${String(error).slice(0, 180)}`);
        },
      });
    } finally {
      if (task.pipelinePollSha === sha && task.pipelinePollEpoch === owner) {
        task.pipelinePollSha = undefined; task.pipelinePollEpoch = undefined;
      }
    }
  }

  /** #461 的旧提前结束文案限定升级恢复；新版本再次失败不会重复自动重跑。 */
  private recoverFailedEarlyPipeline(task: TaskState): boolean {
    const { summary } = task, delivery = summary.delivery;
    if (summary.status !== "failed"
        || summary.detail !== "Agent 提前结束，内核当前步骤是 build，尚未到 delivery_watch"
        || !task.cwd || summary.workspace_reclaimed_at || this.isRequirementAnalysis(task)
        || !validPushReceipt(delivery?.git_push) || delivery.sha !== delivery.git_push.sha
        || this.hasDeliveryMr(task) || delivery.stalled
        || ["pause", "cancel"].includes(summary.control?.last_action ?? "")
        || task.humanGate.all().some(record => record.status === "waiting")
        || new TaskHostLedger(summary).pending()) return false;
    try {
      if (JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8")).current !== "build") return false;
    } catch { return false; }
    const assistant = readDeveloperAssistant(summary.workspace);
    if (["acquiring", "working", "ready", "returning", "running"].includes(assistant.state)
        || (assistant.handoff && assistant.handoff.state !== "returned")) return false;
    task.mission = [task.mission,
      "服务升级已修正提前推送后的等待指引。保留已有代码、提交、推送收据和用户决定，从 current 继续当前任务。"
      + "核对实现、自检与提交完成后执行 done，按后续归档和交付指引继续；流水线尚无运行或查询失败不阻止 build done。"
      + "到 current 明确的宿主等待点再结束回合等待。已推送不代表验证通过，实际失败和未验证项如实报告。",
    ].filter(Boolean).join("\n\n");
    summary.status = "queued";
    summary.detail = "服务升级已恢复提前推送后误等流水线的任务，将从原 build 步骤继续";
    task.resume = true;
    this.persist(task, true);
    if (!this.queue.includes(summary.id)) this.queue.push(summary.id);
    return true;
  }

  /** 修复旧版“build + verifying、Agent 已退出”的现场；真实推送收据始终保留。 */
  private recoverEarlyPipeline(task: TaskState): boolean {
    if (["completed", "canceled"].includes(task.summary.status) || !task.cwd
        || !existsSync(join(task.cwd, ".mae-flow.json")) || !task.summary.delivery?.git_push
        || !task.summary.delivery.pipeline || this.pipelineCanTakeOver(task)) return false;
    try { if (!JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8")).current) return false; } catch { return false; }
    if (task.summary.delivery.pipeline_background === false && !task.mission && !task.pendingMainSteers?.length) return false;
    this.bypass(task, "提前验证监听恢复", this.pollPipeline(task, task.controlEpoch, true));
    if (task.summary.status !== "verifying" || task.summary.waiting?.status === "waiting"
        || task.summary.delivery.stalled) return false;
    task.summary.delivery.pipeline_background = true;
    this.enqueueRepair(task, task.mission || "从当前内核步骤继续，优先读取责任人最新决定并同步文档、实现和 UT；提前推送不表示当前工作已完成。",
      "已恢复当前工作；已推送提交的流水线继续监听");
    return true;
  }

  /**
   * 流水线终态裁决点(小状态机)——"流水线直至全绿是最终目标"(用户拍板)。
   *
   * 两个入口(触发即终态 / 轮询收敛到终态)都汇到这里,转移规则:
   *   绿 → 内核按 execution_contract 核销 COMPILE/UT/CODECHECK，只有
   *       PASS 才 loop.state=green + await_merge；typed checks 是可选的
   *       诊断增强，明确 pending/failed/过期仍 verifying/RED;
   *   红 → 同一 SHA 修过一轮又红 = 修复会话没产生新提交 → halted,
   *       会话的收口发言当诊断带给人(它判了"改代码解决不了");
   *       修复轮预算(可配手刹,默认 20)耗尽 → exhausted 请人工;
   *       否则派专职修复会话:使命=分诊后按类修绿(可派专职子 agent),
   *       任务重入队,修完 settle→tryDeliver 自然触发新 SHA 的新流水线
   *       ——环由现有机械闭合,这里只记账和扳道岔。
   * 常规收口通知仍归两个调用方;halted/exhausted 例外,在这儿主动
   * 喊人(带独立幂等键)——轮询路径收敛到停机时没有别的收口点。
   */
  private async pipelineVerdict(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    log: string,
    checks: PipelineCheck[] | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    if (delivery.sha !== sha || (delivery.git_push && delivery.git_push.sha !== sha)) return;
    // 红绿结果都先核对版本，过期红灯也只能重验，不能派发修复旧代码。
    const attestation = await this.recordPipelineEvidence(task, sha, status, checks);
    if (!this.current(task, epoch) || task.summary.delivery?.sha !== sha
        || (task.summary.delivery.git_push && task.summary.delivery.git_push.sha !== sha)) return;
    if (status === "success" || attestation?.verdict === "STALE") {
      // 平台总体 success 绑定精确 SHA，且 execution_contract 已声明该
      // 权威流水线覆盖三项时可以聚合核销。typed checks 若存在则提供更
      // 精确裁决；登记失败、pending、STALE 仍一律不放行。
      // 只有登记成功才有新收据可对账。持续检视里每一轮改码修复都以
      // Agent 停在 external_verify、生命周期暂无收据背书结尾——正是这条
      // pipeline record 重新封印。它若失败一次(30 秒预算、内核拒收),
      // 无条件 sync 必然找不到匹配收据,被它自己的 catch 误诊成"持续检视
      // 索引损坏或不可写"直接 stalled 找人;而 schedulePipelineEvidenceRetry
      // 看到 stalled 就退出——一次抖动等于停摆,重试预算形同虚设,原来
      // "如实标 verifying + 带预算重试"那条诚实分支永远跑不到(main 上
      // 实测)。登记失败走诚实分支;登记成功但对账仍失败,也只准如实
      // 挂起并带预算重试。
      if (attestation) {
        try {
          this.syncFeedbackStoreFromKernel(task);
        } catch (error) {
          this.holdExternalVerification(
            task, `反馈索引与内核收据对账失败：${String(error)}`);
          this.schedulePipelineEvidenceRetry(task, sha, epoch, false);
          return;
        }
      }
      if (attestation?.verdict === "RED") {
        // overall 与逐项结果矛盾时，裁决权仍在内核。typed RED 进入与
        // 常规红灯完全相同的轻量修复环，不挂一张人工 Diff 卡。
        delivery.pipeline = "failed(逐项质量结果未通过)";
        await this.handlePipelineRed(
          task, sha, attestation.reason ?? log, epoch);
        return;
      }
      if (attestation?.verdict !== "PASS") {
        const verdict = attestation?.verdict;
        const reason = attestation?.reason
          ?? (checks === undefined
            ? "内核未完成整体流水线核销；逐项 Job 未配置，仅影响诊断"
            : "内核未能登记流水线逐项结果");
        const waiting = verdict
          ? `等待流水线证据核销：${verdict} · ${reason}`
          : `等待流水线证据核销：${reason}`;
        task.summary.status = "verifying";
        delivery.mr_state = "验证中";
        delivery.waiting_on = waiting;
        task.summary.detail = waiting;
        this.persist(task);
        this.schedulePipelineEvidenceRetry(
          task, sha, epoch, verdict === "STALE");
        return;
      }
      const ready = this.deliveryReadyAttestation(task);
      if (ready && !ready.complete) {
        if (ready.current === "feedback_triage"
            && this.dispatchPromotedFeedback(task)) {
          return;
        }
        // `pipeline record` 的返回值不能单独成为 Cloud 终态。必须重新读
        // 内核落盘现场，确认 command 已把 external_verify 推到
        // delivery_watch，且 PASS 仍绑定当前 HEAD；这样 hook/保存/推进任一
        // 处失败都不会从返回字符串的空窗里漏进 await_merge。
        this.holdExternalVerification(
          task, `等待内核交付就绪对账：${ready.reason}`);
        this.schedulePipelineEvidenceRetry(task, sha, epoch, false);
        return;
      }
      if (delivery.loop) delivery.loop.state = "green";
      delivery.skipped = undefined;
      delivery.mr_state = "等待合入";
      delivery.waiting_on = undefined;
      task.summary.status = "await_merge";
      task.summary.detail = "编译、UT 运行与 CodeCheck 均已由权威流水线核销";
      this.persist(task);
      this.ensureMergeWatch(task);
      return;
    }
    await this.handlePipelineRed(task, sha, log, epoch);
  }

  /** 内核裁成 RED 后的唯一处理器。来源可以是总体 failed，也可以是
   * “总体 success、某个 typed check failed”的矛盾平台响应；两者都只
   * 派轻量修复会话，不回人工 Diff、不重放内核完整质量链。 */
  private async handlePipelineRed(
    task: TaskState,
    sha: string,
    log: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    task.summary.status = "verifying";
    delivery.mr_state = "验证中";
    delivery.waiting_on = undefined;
    // 三层覆盖:任务 > 设置 > 部署；全部缺席用平台兜底 20，0 = 关。
    // CI 按配置预算收敛；未推送不代表会话已完成或放弃。
    const max = this.repairBudget(task);
    // repairRounds=0 = 关掉修复环:保持旧语义(红灯留痕请人工),不记环账。
    if (max === 0 && !delivery.loop) {
      this.persist(task);
      return;
    }
    // 失败先分类再派单(检视>冲突>CI,同时多项只修最高优先级那一路)。
    // 门禁不可得(平台不支持/查询失败)时按 CI 处理——正是旧语义。
    const view = await this.fetchGates(task);
    if (!this.current(task, epoch)) return;
    if (view?.mrState === "merged" || view?.mrState === "closed") {
      await this.settleMergeState(task, view.mrState, view.sourceSha);
      return;
    }
    const sorted = view
      ? classifyGates(view.gates) : { repairs: [], waiting: [] };
    // 按优先级顺序找第一条派得出去的路。检视"已回复等检视人确认"
    // 不占路(报告 D3:平台不代人 resolve,红着只是没人点)——落到
    // 下一优先级继续,别让等人把 CI 修复堵死。
    for (const candidate of sorted.repairs) {
      if (candidate.kind === "conflict") {
        if (await this.dispatchConflictRepair(task, sha, max, epoch)) return;
        continue;
      }
      await this.dispatchCiRepair(task, sha,
        log || (candidate.gate.detail ?? ""), max, epoch);
      return;
    }
    // 没有可派的修复路(门禁不可得,或可修门禁都在等人):按旧语义
    // 走 CI 修复——流水线红是事实，继续修复仍受配置预算约束。
    await this.dispatchCiRepair(task, sha, log, max, epoch);
  }

  private pipelineArtifactTexts(
    task: TaskState,
    names: string[],
  ): PipelineArtifactText[] {
    const dir = join(task.summary.workspace, "pipeline");
    return names.flatMap((raw): PipelineArtifactText[] => {
      const name = basename(raw);
      if (!name || name !== raw) return [];
      try {
        return [{ name, text: readFileSync(join(dir, name), "utf-8") }];
      } catch {
        return [];
      }
    });
  }

  private repairEvidenceBudgetMs(): number {
    const knobs = this.options.settings?.runtime() ?? {};
    return (knobs.poll_timeout_s !== undefined
      ? knobs.poll_timeout_s * 1000 : undefined)
      ?? this.options.delivery?.pollTimeoutMs ?? 30 * 60_000;
  }

  private repairEvidenceDelayMs(waitingHuman: boolean): number {
    void waitingHuman;
    // 重采 artifacts 比查状态重得多，且 token 可能由外部 5
    // 分钟刷新脚本维护。单次调用立即刷新/重试一次；仍不可用
    // 则退出当前请求，由这个定时器每 3 分钟发起新一轮。
    return Math.max(50,
      this.options.delivery?.evidenceRetryMs ?? 3 * 60_000);
  }

  private scheduleRepairEvidenceRetry(
    task: TaskState,
    sha: string,
    log: string,
    max: number | undefined,
    epoch: number,
    waitingHuman: boolean,
  ): void {
    if (task.repairEvidenceRetryActive) return;
    task.repairEvidenceRetryActive = true;
    const timer = setTimeout(() => {
      task.repairEvidenceRetryActive = false;
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying"
          || task.summary.delivery?.sha !== sha
          || !task.summary.delivery?.pipeline?.startsWith("failed")
          || task.summary.delivery?.loop?.state === "repairing") return;
      this.bypass(task, "流水线失败证据重试",
        this.dispatchCiRepair(task, sha, log, max, epoch));
    }, this.repairEvidenceDelayMs(waitingHuman));
    timer.unref();
  }

  private evidenceGapReasons(
    assessment: PipelineEvidenceAssessment,
  ): string[] {
    return assessment.missingDimensions.flatMap((dimension) => {
      const reasons = assessment.reasons[dimension] ?? [];
      return reasons.length
        ? reasons.map((reason) =>
            `${PIPELINE_DIMENSION_TEXT[dimension]}：${reason}`)
        : [`${PIPELINE_DIMENSION_TEXT[dimension]}：未拿到具体报错`];
    });
  }

  private writePipelineEvidenceGapMaterial(
    task: TaskState,
    assessment: PipelineEvidenceAssessment,
  ): void {
    const dir = join(task.summary.workspace, "pipeline");
    mkdirSync(dir, { recursive: true });
    const dimensions = assessment.missingDimensions
      .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
    const content = [
      "# 流水线证据缺口",
      "",
      `提交版本：${task.summary.delivery?.sha ?? "未知"}`,
      `缺少具体报错的维度：${dimensions}`,
      "",
      "系统已经确认这些维度红灯，但降级取证链没有返回可定位的报错原文：",
      ...this.evidenceGapReasons(assessment).map((reason) => `- ${reason}`),
      "",
      "请在平台打开对应失败项，复制包含文件、行号、错误信息或堆栈的原文，",
      "然后在本材料上添加批注并点击“贴回报错”。Agent 只会据此处理，",
      "不会把本说明本身当成流水线错误证据。",
      "",
    ].join("\n");
    try {
      writeFileSync(join(dir, PIPELINE_EVIDENCE_GAP_FILE), content,
        { mode: 0o444 });
    } catch (error) {
      // 这份材料是人工入口的可用性增强；落不下不能反过来改写交付
      // 判定，小鲁班与任务 waiting_on 仍是完整的降级入口。
      this.options.log?.(
        `任务 ${task.summary.id} 证据缺口材料写入失败: ${String(error)}`);
    }
  }

  private notifyPipelineEvidenceGap(
    task: TaskState,
    assessment: PipelineEvidenceAssessment,
    partial: boolean,
  ): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    const delivery = task.summary.delivery;
    if (!notifier || !account || !delivery?.sha
        || !assessment.missingDimensions.length) return;
    const dimensions = assessment.missingDimensions
      .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
    const reasons = this.evidenceGapReasons(assessment).join("；").slice(0, 900);
    const action = "请打开任务工作台，在《流水线证据缺口》材料上添加批注，"
      + "把平台页面的具体报错原文粘贴进去并提交；系统会自动回灌给 Agent。";
    this.bypass(task, "流水线证据缺口通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `pipeline_evidence_${delivery.sha.slice(0, 12)}_`
        + assessment.missingDimensions.join("_").toLowerCase(),
      summary: partial
        ? `流水线 ${dimensions} 红灯但具体报错缺失；Agent 会先修已有证据的部分。`
          + `${reasons}。${action}`
        : `流水线 ${dimensions} 红灯，但取证重试后仍没有具体报错，`
          + `为避免猜改已暂停自动修复。${reasons}。${action}`,
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  /** CI 修复派单:保留轮数预算，不从交付 SHA 推断修复是否完成、
   * 分诊+定位使命。唯一会累加 round 的一路——检视/冲突是流程性
   * 问题,不许耗掉代码修复的额度。 */
  private async dispatchCiRepair(
    task: TaskState,
    sha: string,
    log: string,
    max: number | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery!;
    if (delivery.sha !== sha || (delivery.git_push && delivery.git_push.sha !== sha)) return;
    if (deferredPipeline(this.taskHostRuntime(task), sha)) {
      delivery.waiting_on = "责任人已暂缓这批流水线反馈的自动修复，失败事实保留";
      this.persist(task);
      return;
    }
    // 不可修工具前置分诊(toolkit UNFIXABLE_TOOLS 对齐):红灯全部来自
    // SuperChecker 类工具时,修复会话改代码解决不了——不派单不烧轮,
    // 如实挂"等人",人处理/豁免后重跑流水线即可回本环。
    if (onlyUnfixableToolFailures(
        delivery.checks, this.options.delivery?.unfixableTools)) {
      delivery.pipeline = "failed(仅剩不可自动修复工具的告警,等人处理)";
      delivery.waiting_on =
        "CODECHECK 红灯全部来自不可自动修复的工具(部署配置的"
        + " unfixable_tools 名单)。请在平台上处理或豁免这些告警后"
        + "重跑流水线;修复 Agent 改代码解决不了这类问题,不派单。";
      task.summary.detail = delivery.waiting_on;
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    const continuingSameDelivery = delivery.loop?.kind === "ci" && delivery.loop.last_sha === sha;
    const priorLoop = delivery.loop;
    if (priorLoop && priorLoop.max !== undefined && priorLoop.round >= priorLoop.max) {
      const loop = priorLoop;
      loop.state = "exhausted";
      if (task.lastReply?.trim()) loop.diagnosis = task.lastReply.trim().slice(0, 2000);
      delivery.pipeline = `failed(${loop.max} 轮修复预算用完,请人工)`;
      task.summary.detail =
        `${loop.max} 轮修复预算用完,流水线仍红,请人工` + (loop.diagnosis ? `；最近会话记录：${loop.diagnosis.slice(0, 600)}` : "");
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    // 先采证再创建/累加 loop：若红灯的具体报错全缺，根本没有派 Agent，
    // 这一轮不能凭空扣掉修复预算。
    const artifacts = await this.mirrorPipelineArtifacts(task);
    if (!this.current(task, epoch) || task.summary.delivery !== delivery || delivery.sha !== sha
        || (delivery.git_push && delivery.git_push.sha !== sha)) return;
    const previousGap = delivery.evidence_gap?.sha === sha
      ? delivery.evidence_gap : undefined;
    const humanEvidence = previousGap?.human_evidence?.trim()
      ? {
          dimensions: previousGap.human_dimensions
            ?? previousGap.missing_dimensions,
          text: previousGap.human_evidence,
        }
      : undefined;
    const assessment = assessPipelineRepairEvidence({
      checks: delivery.checks,
      artifacts: this.pipelineArtifactTexts(task, artifacts),
      failureSummary: log,
      humanEvidence,
    });
    const hasDimensionFacts = assessment.failedDimensions.length > 0;
    if (hasDimensionFacts && assessment.missingDimensions.length) {
      this.writePipelineEvidenceGapMaterial(task, assessment);
      const allMissing = assessment.availableDimensions.length === 0;
      const reasons = this.evidenceGapReasons(assessment);
      const now = Date.now();
      const priorDeadline = previousGap?.retry_deadline
        ? Date.parse(previousGap.retry_deadline) : NaN;
      const deadline = Number.isFinite(priorDeadline)
        ? priorDeadline : now + this.repairEvidenceBudgetMs();
      const attempts = (previousGap?.attempts ?? 0) + 1;
      if (allMissing) {
        const waitingHuman = now >= deadline;
        delivery.evidence_gap = {
          sha,
          state: waitingHuman ? "waiting_human" : "retrying",
          missing_dimensions: assessment.missingDimensions,
          available_dimensions: [],
          reasons,
          attempts,
          failure_log: log.slice(0, 2000),
          retry_deadline: new Date(deadline).toISOString(),
          ...(previousGap?.notified_at
            ? { notified_at: previousGap.notified_at } : {}),
          ...(previousGap?.human_evidence
            ? { human_evidence: previousGap.human_evidence } : {}),
          ...(previousGap?.human_dimensions
            ? { human_dimensions: previousGap.human_dimensions } : {}),
        };
        const dimensions = assessment.missingDimensions
          .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
        delivery.pipeline = waitingHuman
          ? `failed(${dimensions} 具体报错缺失,等人工回灌)`
          : `failed(${dimensions} 具体报错缺失,第 ${attempts} 次取证重试)`;
        delivery.waiting_on = waitingHuman
          ? `${dimensions} 红灯，但取证降级链均未给出可定位的具体报错。`
            + "请在工作台对应材料上添加批注，粘贴平台报错原文并提交；"
            + "平台证据若恢复，系统也会自动继续。"
          : `${dimensions} 红灯但具体报错暂缺，系统正在有限重试取证，`
            + "尚未派 Agent、未消耗修复轮次。";
        task.summary.detail = delivery.waiting_on;
        if (waitingHuman && !delivery.evidence_gap.notified_at) {
          delivery.evidence_gap.notified_at = new Date().toISOString();
          this.notifyPipelineEvidenceGap(task, assessment, false);
        }
        this.persist(task);
        this.scheduleRepairEvidenceRetry(
          task, sha, log, max, epoch, waitingHuman);
        return;
      }
      // 部分维度有证据：能修的马上修，缺的同时求人，不互相等待。
      delivery.evidence_gap = {
        sha,
        state: "partial",
        missing_dimensions: assessment.missingDimensions,
        available_dimensions: assessment.availableDimensions,
        reasons,
        attempts,
        failure_log: log.slice(0, 2000),
        notified_at: previousGap?.notified_at ?? new Date().toISOString(),
        ...(previousGap?.human_evidence
          ? { human_evidence: previousGap.human_evidence } : {}),
        ...(previousGap?.human_dimensions
          ? { human_dimensions: previousGap.human_dimensions } : {}),
      };
      if (!previousGap?.notified_at) {
        this.notifyPipelineEvidenceGap(task, assessment, true);
      }
      delivery.waiting_on = undefined;
    } else if (hasDimensionFacts) {
      delivery.evidence_gap = undefined;
      delivery.waiting_on = undefined;
    }

    try {
      const dimensionKey = assessment.failedDimensions.length
        ? assessment.failedDimensions.slice().sort().join("+") : "pipeline";
      this.openFeedbackBatch(task, "pipeline", [{
        id: `pipeline:${sha}:${dimensionKey}`,
        source: "pipeline",
        source_id: `${sha}:${dimensionKey}`,
        source_revision: 0,
        kind: "quality_failure",
        summary: log.slice(0, 1000) || `流水线 ${dimensionKey} 未通过`,
        material: resolve(task.summary.workspace, "pipeline"),
        verification: "pipeline",
      }]);
    } catch (error) {
      this.markVerificationStalled(task,
        `流水线失败已保留，但内核未能打开统一反馈批次：${String(error)}`,
        stallClassForError(error, "contract"));
      return;
    }

    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    loop.round += 1;
    loop.last_sha = sha;
    loop.kind = "ci";
    loop.state = "repairing";
    loop.failure = log.slice(0, 2000) || "(平台未提供失败详情)";
    // 批2 双通道:摘要进使命(下面),完整日志已在逐维度判定前落盘到
    // 工作区外 pipeline/，让修复会话自读。
    // 输入可信度:log 是纯链接或干脆缺席、又没有镜像材料时,修复会话
    // 手里没有任何失败证据。内网实锤:适配层把 log 填成流水线页面链接
    // (会话没有登录态,打不开),使命却把它包装成"失败详情(平台原文)"
    // ——会话以为自己有输入,硬着头皮定位→修改→提交,看着专业实为
    // 猜改,烧流水线还烧不出结论。证据缺席必须明说,行为才会从"猜改
    // 凑提交"变成"能自证的修、不能自证的走诊断出口停下喊人"。
    // 判据不能只认裸链接:内网真实形态是"标签 + 链接"
    // (`FAILED stage=CodeCheck2.0 job=CodeCheck2.0  detail: https://…`),
    // 只认裸链接的第一版正好漏掉了它要防的那个场景(2026-08-21 读进场
    // 报告逮住)。改判"把链接抠掉之后还剩多少诊断内容":剩下的只有
    // stage/job 标签 = 链接在替内容站岗。没有链接则不论长短都是平台
    // 给的真内容(如 "BUILD FAILURE: 模块 x 编译失败"),不算无证据。
    // 判据本体收口在公共 pipelineMirror.isBlindPipelineInput(问题流
    // 也能复用同一杆秤),语义逐字保持:占位符算盲;抠链接后变短且
    // 剩余 <120 字算盲;有镜像产物不算盲。
    const blindInput = isBlindPipelineInput(
      loop.failure, artifacts.length > 0);
    const roundText = loop.max !== undefined
      ? `第 ${loop.round}/${loop.max} 轮` : `第 ${loop.round} 轮`;
    delivery.pipeline = `failed(${roundText}修复中)`;
    // 逐项事实单独进使命(2026-08-21 内网数据逼出来的):平台的 log 详细
    // 程度按维度不均——CODECHECK 给到了文件行号规则,COMPILE 只有一句
    // "构建失败=1"。只喂 log,模型会照着详细那一维修完就交,另一维照旧
    // 红,又是白烧一轮。checks 是结构化的平台事实,把失败维度点名列出,
    // 模型才知道本轮的完整战场;某一维没有细节就明说去要,别默默漏掉。
    const failedDimensions = (delivery.checks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.dimension + (check.job ? `(${check.job})` : ""));
    // stage/job/工具/缺陷定位的结构化明细(适配层给到多细这里就有多细,
    // toolkit 对齐):有它,定位从"对着日志猜"变成"照单点名"。
    const structuredFailures = summarizeFailedChecks(delivery.checks);
    const unfixableSet = new Set(
      (this.options.delivery?.unfixableTools ?? [])
        .map((tool) => tool.trim().toLowerCase()).filter(Boolean));
    const unfixableHit = (delivery.checks ?? []).some((check) =>
      check.status === "failed" && [
        ...(check.tool ? [check.tool] : []),
        ...(check.details ?? []).map((defect) => defect.tool ?? ""),
      ].some((tool) => unfixableSet.has(tool.toLowerCase())));
    task.mission = [
      `当前目标是处理本轮流水线失败(${roundText}修复)；较新的责任人要求可调整目标或逐条暂缓:`,
      ...(continuingSameDelivery ? [
        "- 上轮会话已结束，但交付版本尚未更新；这仍是原版本的失败记录，不是对未提交修改的新验证。先检查 git status、git diff 和未推送提交，接着完成已有修改、必要验证、commit 和 task_control push，不要重做已完成工作或覆盖现场。没有工作区改动也可能还在定位，继续依据已有证据处理。",
      ] : loop.round > 1 ? [
        `- 上一轮修复后流水线仍红，这是新一轮权威结果；`
          + `先对比本轮证据与上轮改动，判断是原因未解决、新回归还是证据变化，`
          + `不要无分析地重复上一轮做法。`,
      ] : []),
      ...(failedDimensions.length ? [
        `- 本轮失败的维度(平台逐项事实,权威):`
        + `${failedDimensions.join("、")}。尚未暂缓的每一维都要有明确处理结果,`
        + `不要只修下面日志里讲得细的那一维就交差——日志的详细程度`
        + `按维度不均,讲得少不等于没红。某一维在日志和 ${resolve(task.summary.workspace, "pipeline")} 里`
        + `都找不到细节时,不许猜改,把"缺哪一维的失败原文"写进收口发言。`,
      ] : []),
      ...(structuredFailures.length ? [
        `- 结构化失败明细(哪个 stage 的哪个 job 的哪个工具,含缺陷定位):`,
        ...structuredFailures.map((line) => `  ${line}`),
      ] : []),
      ...(assessment.missingDimensions.length ? [
        `- 证据缺口(系统已并行求助人工):${assessment.missingDimensions
          .map((dimension) => PIPELINE_DIMENSION_TEXT[dimension]).join("、")}`
          + " 红灯，但平台取证没有给出可定位原文。只修已有证据的维度，"
          + "缺口维度不许猜改；人工补充会通过工作台批注送达。",
        ...this.evidenceGapReasons(assessment)
          .map((reason) => `  - ${reason}`),
      ] : []),
      ...(assessment.fallbackSources.length ? [
        `- 维度归类错配的兜底采信(平台把失败归到别的维度名下,下面日志`
        + `的**内容**才是权威,按内容定位,别被维度标签带偏):`,
        ...assessment.fallbackSources.map((item) => `  - ${item}`),
      ] : []),
      ...(humanEvidence?.text ? [
        "- 人工从工作台贴回的流水线报错原文（按人的原话定位，不扩大解释）：",
        humanEvidence.text.slice(0, 12_000),
      ] : []),
      ...(unfixableHit ? [
        `- 其中不可自动修复工具(部署 unfixable_tools 名单)产生的告警`
        + `**不要硬修**——那要人工在平台处理/豁免;修好其余问题后,`
        + `在收口发言里把这类告警单独点名留给人工。`,
      ] : []),
      ...(blindInput ? [
        `- 分支上提交 ${sha} 的权威流水线结果是 failed,**但平台没有给出`
        + `失败日志原文**(只给了: ${loop.failure})。你手里没有可信的`
        + `失败证据,本轮第一要务是取证,不是动手改。`,
        `- 证据纪律:只修你能在工作区自证的问题(通读代码找得到、`
        + `lightcheck 报得出的,并写明依据);自证不了的不许猜改碰运气`
        + `——把"平台未提供失败日志,适配层需补 log 原文与`
        + ` pipeline_artifacts 端点"写成诊断，通过 AskUserQuestion 举卡请求补充证据，不做猜测性提交。`,
      ] : [
        `- 分支上提交 ${sha} 的权威流水线结果是 failed。失败详情(平台原文):`,
        loop.failure,
      ]),
      ...(artifacts.length ? [
        `- 完整失败材料已镜像到 ${resolve(task.summary.workspace, "pipeline")}(仓库外,不会进提交),`
        + `分诊与定位先读它们,别只凭上面的摘要猜:`,
        ...artifacts.map((name) => `  ${resolve(task.summary.workspace, "pipeline", name)}`),
      ] : []),
      `- 先分诊再动手:通读日志,列出本轮暴露的全部问题类别`
      + `(编译报错/编译告警/UT 失败/UT 覆盖率不够/CodeCheck/其他),`
      + `在本轮当前目标范围内充分修复；责任人明确暂缓的事项保留记录。`,
      "- 结果表述：报告生成成功、测试执行通过、覆盖率达标是三件事，不能相互推导。"
      + "例如 Review Tips 的 CPP_UT=success 且只有 ut_json 链接，只能说明报告生成成功；"
      + "没有实际测试结果，不说 UT 通过；没有覆盖率指标及对应阈值，不说覆盖率达标。"
      + "逐项说明所有超限指标（包括 DT），未知含义保留原名与数值，不猜测试类型、失败用例数或独立根因。"
      + "编译失败也不能直接推断并行 UT 未执行；执行情况以同次流水线的实际测试报告、job 或日志为准。",
      // 定位先于修改(Agentless 的固定管线在修 bug 上打赢自由 agent
      // 循环):逼一句"依据"出来,是为了让定位错当场暴露——说不出
      // 依据的定位多半是猜的,猜着改就是拿流水线当调试器。
      `- 定位先于修改:每一类问题先落到具体文件与函数/测试用例,`
      + `并写明定位依据(日志里的哪一行、堆栈的哪一帧、覆盖率报告的`
      + `哪个类)。依据说不出来就说明还没定位到,继续查,不许凭猜改;`
      + `日志指向的位置与真正的病根不一致时,以病根为准并说明推断链。`,
      // 2026-08-25 编排瘦身后,内核在交付主流程里不再签发
      // COMPILE/UT/CODECHECK 质量任务卡(卡只留给 standalone 工具单)。
      // 历史教训仍然成立:原文让它"派专职子 agent",模型照做就撞死路
      // (拿不到卡 → agent-task 被打回 → 来回空转)。修复轮里改代码
      // 这件事由本会话自己做。
      `- 按类分头修:编译类、UT/覆盖率类、检视类各修各的,互不搅和。`
      + `**本轮不要找内核要 COMPILE/UT/CODECHECK 任务卡或派专职质量子`
      + ` agent**——交付流程里没有那些卡,要了也拿不到,白烧回合。`
      + `补测试、改代码都由你自己动手(UT 的写法照常按已装载的`
      + ` UT skill 走);确需并行时只派不带任务卡的通用子 agent,`
      + `并把定位到的文件与依据一并交给它,别让它从头再查。`,
      `- 修复纪律:补覆盖率要写真测试,不许凑数骗指标;CodeCheck 修问题`
      + `本身,不许加抑制注释糊弄;编译告警要消除,不是关闭告警。`,
      `- 按当前目标提交成果，需要发布时调用 task_control push；不要求合并所有旧修复为一次提交。`
      + `不要读取个人令牌或从容器直接 push；宿主负责传输并核验远端 SHA。`
      + `别的都不要动,顺手的重构、无关的优化一律不做。`,
      `- 诊断出口:凡不是本仓代码能修的(外部平台的配置、权限、环境、`
      + `流水线自身的问题),那一类不要硬改碰运气;若所有问题都不可修,`
      + `不要为了产生新 SHA 凑提交；通过 AskUserQuestion 明确举卡，说明缺什么、要去哪配、配好之后如何重跑。不要仅结束会话或不提交来表达需要人工处理。`,
      // 插话纪律(内网实锤):一轮修复被"补文档章节"的插话整轮占满,
      // 没碰流水线也没提交,刹车把它的文档汇报当成了诊断——人看着
      // "自动修复已停"配一段章节标题,完全接不上。插话照办是对的
      // (人的话优先),但收口不回到使命就是把本轮白丢。
      `- 插话纪律:会话中途收到的插话(人的补充要求、[mae-flow] 的`
      + `纠偏提示)照办；责任人改变目标时用 task_control 登记，不回到已暂缓的旧使命。收口如实说明流水线`
      + `失败的定位结论收尾——本轮确实没碰流水线,就明说"本轮未处理`
      + `流水线"及原因,不许拿无关的汇报顶替诊断。`,
      CI_MISSION_END,
    ].join("\n");
    task.summary.status = "queued";
    task.summary.detail = assessment.missingDimensions.length
      ? `流水线红,${roundText}修复排队中；${assessment.missingDimensions
          .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、")}`
        + " 的具体报错缺失，已并行求助人工"
      : `流水线红,${roundText}修复排队中`;
    task.resume = true;
    this.persist(task);
    this.queue.push(task.summary.id);
    // 不能当场 pump:这里可能正处在 settle→tryDeliver 的调用链里,而
    // pump 会同步把状态置成 running,settle 随后那句"running→completed"
    // 就把修复轮当场盖掉(读代码逮住的竞态)。setImmediate 排到微任务链
    // 之后,settle 收完自己的账、原会话的 finally 归还并发额度,再派单。
    setImmediate(() => this.bypass(undefined, "任务泵", this.pump()));
  }

  private existingMergeRequestAllowsDelivery(task: TaskState, epoch: number): Promise<boolean> {
    return remoteDeliveryAllowsProceed(this.remoteDeliveryHost(task, epoch), {
      retry: message => this.holdWithRecovery(task, message, epoch),
      stall: (message, kind) => this.markVerificationStalled(task, message, kind),
    });
  }

  private remoteDeliveryHost(task: TaskState, epoch: number): RemoteReconcileHost {
    const stalledAtStart = task.summary.delivery?.stalled;
    const remaining = Date.parse(task.summary.delivery?.verify_deadline ?? "") - Date.now();
    return { summary: task.summary, cwd: task.cwd, repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "", platformUrl: this.effectivePlatformUrl(), headers: this.platformIdentity(task),
      readTimeoutMs: remaining > 0 ? Math.min(10_000, remaining) : 10_000,
      current: () => this.current(task, epoch) && task.summary.delivery?.stalled === stalledAtStart, persist: () => this.persist(task),
      gates: async (mr, signal) => { let reason = "MR 状态查询失败";
        const view = mr ? await fetchMrGates({ platformUrl: this.effectivePlatformUrl(),
          repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "", headers: this.platformIdentity(task),
          delivery: { mr_id: mr.id, mr_url: mr.url, source_branch: mr.source_branch, target_branch: mr.target_branch },
          requireExisting: true, signal, onFailure: error => { reason = error; } })
          : await this.fetchGates(task, true, error => { reason = error; }, signal);
        if (!view) throw new Error(reason); return view;
      }, published: receipt => this.recordPublishedPush(task, receipt),
      settle: (state, sha) => this.settleMergeState(task, state, sha), watch: () => this.ensureMergeWatch(task),
      retirePushQuestion: merged => {
        const waiting = task.summary.waiting;
        if (!waiting || !(waiting.step === CLOUD_PUSH_CONFIRM_STEP || (merged && waiting.step === HOST_PUSH_CONFIRM_STEP))) return;
        task.humanGate.supersede(waiting.waiting_id, { stateVersion: waiting.state_version, notes: "远端事实已核验，旧推送确认已无须执行" });
        task.summary.waiting = undefined;
        if (task.summary.status === "waiting_for_human") task.summary.status = "verifying";
        this.persist(task);
      },
      observe: async branch => {
        const sandbox = this.prepareHostGitSandbox(this.options.gitCredential?.(task.summary.luban_account));
        try { return await observePublishedBranch({ cwd: task.cwd!, repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "", branch, sandbox, run: runGitProcess }); }
        finally { this.cleanupHostGitCredential(sandbox); }
      },
    };
  }

  async linkFinalMr(id: string, rawUrl: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const release = this.beginHistoryMutation(id);
    try {
      const d = task.summary.delivery;
      const url = normalizeRepairMrUrl(rawUrl);
      if (task.summary.status === "completed" && d?.final_mr?.url === url) return this.project(task);
      if (task.summary.origin === "issue" || this.isRequirementAnalysis(task)
          || ["completed", "canceled", "coordinating"].includes(task.summary.status) || continuationPending(task.summary))
        throw new TaskControlError("请在尚未结束的需求交付任务中关联最终 MR；拆分的需求请打开对应交付任务");
      const previous = d?.final_mr;
      if (previous?.state === "merged") {
        if (previous.url !== url) throw new TaskControlError("最终 MR 已合入，不能再更换链接");
        await this.refreshFinalMr(task, previous);
        this.ensureMergeWatch(task);
        return this.project(task);
      }
      const epoch = task.controlEpoch;
      const mr = await this.readFinalMr(task, url);
      if (d?.final_mr?.state === "merged") {
        if (d.final_mr.url !== url) throw new TaskControlError("最终 MR 已合入，不能再更换链接");
        return this.project(task);
      }
      if (this.shuttingDown || this.tasks.get(id) !== task || task.controlEpoch !== epoch
          || task.summary.delivery !== d || ["completed", "canceled"].includes(task.summary.status))
        throw new TaskControlError("任务状态已变化，请刷新后重试");
      if (ticketCorrectionBlocks(task.summary.ticket_correction) || task.mergeSettlement || task.transportActive
          || task.hostActionActive || task.mrCreateActive || task.reviewOutboxFlush)
        throw new TaskControlError("当前 MR 操作仍在结束，请稍后关联最终 MR");
      const final = applyFinalMrLink(task, mr);
      this.persist(task, true);
      if (final.state === "merged") {
        await this.settleMergeState(task, "merged", final.head ?? final.merge_commit_sha, final);
      } else {
        const work = this.stopMrExecution(task).then(failures => {
          if (failures.length && this.tasks.get(id) === task && task.summary.delivery?.final_mr === final
              && !["completed", "canceled"].includes(task.summary.status)) {
            this.markVerificationStalled(task, "无法确认原任务已停止：" + failures.join("；"), "infrastructure");
          }
        });
        task.mergeSettlement = work;
        try { await work; } finally { if (task.mergeSettlement === work) task.mergeSettlement = undefined; }
      }
      this.ensureMergeWatch(task);
      return this.project(task);
    } finally { release(); }
  }

  private async readFinalMr(task: TaskState, url: string) {
    const platformUrl = this.effectivePlatformUrl();
    if (!platformUrl) throw new TaskControlError("当前部署未配置 MR 平台");
    const repositoryList = task.summary.repositories;
    const repo = task.summary.repo_url ?? (repositoryList?.length === 1 ? repositoryList[0] : this.effectiveDefaultRepo());
    if (!repo) throw new TaskControlError("任务未指定代码仓，无法核对最终 MR 的归属");
    const mr = await readFinalDeliveryMr({ platformUrl, url, credential: this.options.gitCredential?.(task.summary.luban_account) });
    if (repositoryIdentity(repo) !== repositoryIdentity(mr.repo))
      throw new TaskControlError("最终 MR 必须属于本任务的代码仓");
    return mr;
  }

  private refreshFinalMr(task: TaskState, linked: FinalDeliveryMr): Promise<void> {
    return refreshLinkedFinalMr(task, linked, {
      read: url => this.readFinalMr(task, url),
      current: () => !this.shuttingDown && this.tasks.get(task.summary.id) === task,
      stop: () => this.stopMrExecution(task),
      settle: final => this.settleMergeState(task, "merged", final.head ?? final.merge_commit_sha, final),
      persist: () => this.persist(task),
      log: this.options.log,
    });
  }

  async refreshRemoteDelivery(id: string, actor?: string, selected?: string,
    access?: { administrator?: boolean }) {
    const task = this.tasks.get(id); if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const owner = task.summary.luban_account ?? "本地用户";
    if (owner !== (actor ?? "本地用户") && access?.administrator !== true) {
      throw new AnnotationPermissionError(`只有任务责任人 ${owner} 或管理员可以刷新 MR 状态`);
    }
    const final = task.summary.delivery?.final_mr;
    if (final) {
      await this.refreshFinalMr(task, final);
      this.ensureMergeWatch(task);
      return { message: task.summary.detail ?? "已刷新最终 MR", proceed: false };
    }
    const epoch = task.controlEpoch;
    const result = await reconcileRemoteDelivery(this.remoteDeliveryHost(task, epoch), selected);
    if (this.current(task, epoch) && result.proceed && !task.driver && task.summary.status === "verifying")
      this.bypass(task, "远端核验后接续交付", this.tryDeliver(task, epoch));
    return result;
  }

  private fetchGates(task: TaskState, requireExisting = false,
    onFailure?: (reason: string) => void, signal?: AbortSignal): Promise<GateView | undefined> {
    return fetchMrGates({ platformUrl: this.effectivePlatformUrl(), onFailure, signal,
      delivery: task.summary.delivery, requireExisting,
      repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
      headers: this.platformIdentity(task),
      log: (error) => this.options.log?.(`任务 ${task.summary.id} 门禁查询失败: ${error}`),
    });
  }

  /** 平台人工合入是可信终态，优先停止旧 writer 并交给内核登记。
   * 旧 SHA 的验证结果保留原样；完成依据是平台合入，不冒充流水线 PASS。 */
  private async settleMergeState(
    task: TaskState,
    state: "merged" | "closed",
    observedSourceSha?: string,
    final?: FinalDeliveryMr,
  ): Promise<void> {
    while (task.mergeSettlement) await task.mergeSettlement;
    if (this.shuttingDown || this.tasks.get(task.summary.id) !== task
        || ["completed", "canceled"].includes(task.summary.status)) return;
    if (task.summary.delivery?.final_mr !== final) return;
    const settlement = this.applyMergeState(task, state, observedSourceSha);
    task.mergeSettlement = settlement;
    try { await settlement; }
    finally { if (task.mergeSettlement === settlement) task.mergeSettlement = undefined; }
  }

  private async stopMrExecution(task: TaskState): Promise<string[]> {
    task.controlEpoch += 1;
    this.removeFromQueue(task.summary.id); this.removePrePushBuildWaiter(task);
    discardRetainedSession(task);
    const driver = task.driver, container = task.container;
    const activePrepush = task.prepushActive, abort = task.prepushAbort;
    task.pendingMainSteers = [...(task.pendingMainSteers ?? []), ...(driver?.takeUndeliveredSteers?.() ?? [])];
    abort?.abort();
    const cleanup = await Promise.allSettled([
      activePrepush?.then(() => undefined) ?? Promise.resolve(),
      task.summary.delivery?.final_mr
        ? Promise.all([driver?.abort(), abortAuxiliarySessions(task), task.assistantActive, task.kernelBootstrap?.catch(() => {})])
        : driver?.abort() ?? Promise.resolve(), container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[1].status === "fulfilled" && task.driver === driver) { task.driver = undefined; driver?.dispose(); }
    if (cleanup[2].status === "fulfilled" && task.container === container) task.container = undefined;
    if (task.prepushActive === activePrepush) task.prepushActive = undefined;
    if (task.prepushAbort === abort) task.prepushAbort = undefined;
    return stopFailures(cleanup);
  }

  private async applyMergeState(
    task: TaskState,
    state: "merged" | "closed",
    observedSourceSha?: string,
  ): Promise<void> {
    const delivery = task.summary.delivery!;
    if (state === "merged") {
      const observed = observedSourceSha?.trim();
      delivery.mr_state = "已合入（内核终态待对账）";
      delivery.merged_sha = observed;
      delivery.stalled = undefined;
      delivery.stall_class = undefined;
      task.summary.status = "verifying";
      task.summary.detail = "MR 已合入，正在停止本地修复并登记完成";
      this.persist(task);
      // 合入是最终抢占事件：先让任何在途 writer 失去写状态权并停止，
      // 再核对本地提交是否已包含于合入版本，避免把未交付代码标成完成。
      const failures = await this.stopMrExecution(task);
      if (this.shuttingDown || ["canceled"].includes(task.summary.status)) return;
      if (failures.length) {
        this.markVerificationStalled(task,
          `MR 已合入，但在途执行者未能确认停止：${failures.join("；")}`, "infrastructure");
        return;
      }
      // writer 已停止，再检查最终 HEAD；检查期间只取对象，不改工作树或分支。
      if (task.cwd && !delivery.final_mr) {
        const sandbox = this.prepareHostGitSandbox(this.options.gitCredential?.(task.summary.luban_account));
        let included = false;
        try {
          included = await mergedIncludesLocalHead({ cwd: task.cwd,
            repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
            sha: observed, sandbox, run: runGitProcess });
        } catch (error) {
          this.options.log?.(`任务 ${task.summary.id} 合入版本核对失败: ${String(error)}`);
        } finally { this.cleanupHostGitCredential(sandbox); }
        if (this.shuttingDown || ["canceled"].includes(task.summary.status)) return;
        if (!included) {
          this.markVerificationStalled(task,
            "平台报告的合入版本未确认包含当前本地提交，保留工作区与待推送代码，不登记任务完成；请核对 MR 归属及未交付改动", "evidence_missing");
          return;
        }
      }
      if (this.continuousReviewTask(task)) {
        if (!observed) {
          this.markVerificationStalled(task,
            delivery.final_mr ? "最终 MR 已合入，代码平台尚未返回源版本或合入提交；将继续查询，取得版本后登记完成"
              : "平台已报告 MR 合入，但没有返回实际源提交 SHA；无法登记合入版本",
            "evidence_missing");
          return;
        }
        try {
          closeKernelDelivery({
            host: this.options.host!,
            cwd: task.cwd!,
            workspace: task.summary.workspace,
            taskId: task.summary.id,
            sha: observed,
            eventId: `mr-merged:${task.summary.id}:${observed}`,
          });
        } catch (error) {
          this.markVerificationStalled(task,
            `MR 已合入，但内核未能登记可信 close：${String(error)}`,
            stallClassForError(error, "contract"));
          return;
        }
      }
      const attestation = this.taskCompletionAttestation(task);
      if (attestation && !attestation.complete) {
        // 等待可信 close 落盘，避免投影先完成而重启后内核仍在修复。
        const pending = mergedPendingAttestationWrite(attestation.reason);
        delivery.mr_state = pending.mr_state;
        delivery.waiting_on = pending.waiting_on;
        task.summary.status = "verifying";
        task.summary.detail = pending.detail;
        this.persist(task);
        return;
      }
      if (delivery.loop) delivery.loop.state = "merged";
      this.syncFeedbackStoreFromKernel(task, true);
      delivery.mr_state = "已合入";
      delivery.waiting_on = undefined;
      delivery.stalled = undefined;
      delivery.stall_class = undefined;
      delivery.skipped = undefined;
      delivery.verify_deadline = undefined;
      task.summary.status = "completed";
      const closeEvent = this.continuousReviewTask(task)
        ? this.latestKernelCloseEvent(task) : undefined;
      const unpushedCommits = Array.isArray(closeEvent?.unpushed_local_commits)
        ? closeEvent.unpushed_local_commits.length : 0;
      const unpushedPaths = Array.isArray(closeEvent?.unpushed_local_paths)
        ? closeEvent.unpushed_local_paths.length : 0;
      task.summary.detail = delivery.final_mr ? "最终 MR 已合入，需求已交付" : mergedCompletionDetail(unpushedCommits, unpushedPaths);
      if (delivery.final_mr?.merged_at) task.summary.completed_at = delivery.final_mr.merged_at;
      if (delivery.final_mr) this.finalMrSamples.schedule(task);
      this.persist(task);
      this.bypass(undefined, "依赖任务解锁", this.pump());
      const account = task.summary.luban_account;
      if (this.options.notifier && account) {
        this.bypass(task, "收口通知", this.options.notifier.notifyOutcome({
          taskId: task.summary.id,
          account,
          status: "merged",
          summary: `MR 已合入`
            + (delivery.final_mr?.url || delivery.mr_url ? `:${delivery.final_mr?.url ?? delivery.mr_url}` : ""),
          link: personalTaskLink(
            this.notificationLinkBase(), account, task.summary.id),
        }));
      }
      return;
    }
    const changed = delivery.mr_state !== CLOSED_MR_WRITE.mr_state
      || delivery.waiting_on !== CLOSED_MR_WRITE.waiting_on;
    const interrupted = ["running", "queued", "verifying"].includes(task.summary.status)
      || [CLOUD_PUSH_CONFIRM_STEP, HOST_PUSH_CONFIRM_STEP].includes(task.summary.waiting?.step ?? "");
    delivery.mr_state = CLOSED_MR_WRITE.mr_state;
    delivery.waiting_on = CLOSED_MR_WRITE.waiting_on;
    task.summary.detail = CLOSED_MR_WRITE.detail;
    if (interrupted) {
      task.summary.status = "await_merge";
      delivery.loop = { ...delivery.loop, round: delivery.loop?.round ?? 0, state: "halted", diagnosis: CLOSED_MR_WRITE.waiting_on };
      const waiting = task.summary.waiting;
      if (waiting && [CLOUD_PUSH_CONFIRM_STEP, HOST_PUSH_CONFIRM_STEP].includes(waiting.step)) {
        task.humanGate.supersede(waiting.waiting_id, { stateVersion: waiting.state_version, notes: CLOSED_MR_WRITE.waiting_on });
        task.summary.waiting = undefined;
      }
      this.persist(task);
      const failures = await this.stopMrExecution(task);
      if (this.shuttingDown || this.tasks.get(task.summary.id) !== task || task.summary.status !== "await_merge") return;
      if (failures.length) {
        delivery.loop.diagnosis = `MR 已关闭，但停止执行失败：${failures.join("；")}`;
        delivery.waiting_on = delivery.loop.diagnosis;
        task.summary.status = "failed"; task.summary.detail = delivery.loop.diagnosis;
      }
    }
    if (changed || interrupted) this.persist(task);
  }

  private ensureMergeWatch(task: TaskState, createdMr = false): void {
    if (this.shuttingDown || !this.effectivePlatformUrl()
        || (process.env.MAE_FLOW_UI_FIXTURE_MODE === "1" && task.summary.ui_fixture === true)
        || ["completed", "canceled"].includes(task.summary.status)
        || (!task.summary.delivery?.final_mr && !task.summary.delivery?.mr_url && task.summary.delivery?.mr_id === undefined)) return;
    this.finalMrSamples.captureInitialBase(task, createdMr);
    this.bypass(task, "合入监控", this.watchMerge(task, task.controlEpoch, true));
  }

  /** MR 生命周期监听：冲突不依赖流水线结果，修复中也持续观察合入事实。 */
  private async watchMerge(task: TaskState, _epoch: number, deferFirst = false): Promise<void> {
    if (task.mergeWatchActive) return; // 防重入:一任务一环
    task.mergeWatchActive = true;
    try {
      const knobs = this.options.settings?.runtime() ?? {};
      const interval = (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
        ?? this.options.delivery?.pollIntervalMs ?? 30_000;
      // 交付入口已经查过一次；后台下一拍接棒，避免立即重复请求。
      if (deferFirst) await new Promise((tick) => setTimeout(tick, interval).unref());
      watch: while (true) {
        try {
        // 合入监听属于任务生命周期，不属于某一轮 writer 的 controlEpoch。
        // 人工反馈抢占 Build-Fix 会换 epoch，但 MR 仍可能在这段时间被合入；
        // 监听若随旧 epoch 退出，就再也没人停止在途 Agent 或执行 close。
        if (this.shuttingDown
            || ticketCorrectionBlocks(task.summary.ticket_correction)
            || this.tasks.get(task.summary.id) !== task
            || ["completed", "canceled"].includes(task.summary.status)
            || (!task.summary.delivery?.final_mr && !task.summary.delivery?.mr_url && task.summary.delivery?.mr_id === undefined)) return;
        const final = task.summary.delivery.final_mr;
        if (final) {
          if (final.state === "closed" && !task.summary.delivery.stalled) return;
          await this.refreshFinalMr(task, final);
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        const mrKey = JSON.stringify([task.summary.delivery.mr_url, task.summary.delivery.mr_id]);
        const view = await this.fetchGates(task, true);
        if (this.shuttingDown
            || ticketCorrectionBlocks(task.summary.ticket_correction)
            || this.tasks.get(task.summary.id) !== task
            || ["completed", "canceled"].includes(task.summary.status)) return;
        if (task.summary.delivery?.final_mr || mrKey !== JSON.stringify([task.summary.delivery?.mr_url, task.summary.delivery?.mr_id])) continue;
        if (!view) {
          // 平台暂不可得也不能永久丢掉监听；等待下一拍。timer unref，
          // 服务退出时不会被后台监控吊住，重启恢复会重新挂环。
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        // 合入事实优先；运行中的冲突补充给当前会话，其他门禁在等待合入时处理。
        let step = nextWatchStep({
          view, status: task.summary.status,
          verifiedSha: task.summary.delivery?.sha,
        });
        if (step.kind === "settle_merged") {
          await this.settleMergeState(task, "merged", step.sourceSha);
          return;
        }
        if (step.kind === "settle_closed") {
          await this.settleMergeState(task, "closed");
          await new Promise((tick) => setTimeout(tick, interval).unref()); continue;
        }
        if (task.summary.delivery?.mr_state === CLOSED_MR_WRITE.mr_state) {
          const delivery = task.summary.delivery;
          const resume = task.summary.status === "await_merge" && delivery.loop?.state === "halted"
            && delivery.loop.diagnosis === CLOSED_MR_WRITE.waiting_on;
          delivery.mr_state = REOPENED_MR_WRITE.mr_state; delivery.waiting_on = undefined;
          task.summary.detail = REOPENED_MR_WRITE.detail; this.persist(task);
          if (resume) {
            delivery.loop!.diagnosis = undefined;
            this.enqueueRepair(task, task.mission ?? "MR 已重新打开，沿用原会话继续未完成的开发与交付，保留本地修改。", REOPENED_MR_WRITE.detail);
            continue;
          }
        }
        if (!view.gates.some(gate => gate.name === "conflict_passed" && !gate.passed)) {
          task.conflictNotice = undefined;
        }
        if (step.kind === "repair_conflict") {
          await this.observeActiveConflict(task, view);
        }
        const discussions = view.mrState === "opened"
          ? await this.fetchDiscussions(task) : undefined;
        if (this.shuttingDown || this.tasks.get(task.summary.id) !== task
            || ticketCorrectionBlocks(task.summary.ticket_correction)
            || ["completed", "canceled"].includes(task.summary.status)) return;
        if (task.summary.delivery?.final_mr || mrKey !== JSON.stringify([task.summary.delivery?.mr_url, task.summary.delivery?.mr_id])) continue;
        if (discussions?.kind === "available") {
          observeMrDiscussions(task.summary.workspace, view.sourceSha ?? task.summary.delivery?.sha, discussions.items);
          importExternalReviews(this.annotations(task), { scope: task.summary.delivery?.mr_url ?? mrKey, mrUrl: task.summary.delivery?.mr_url, owner: task.summary.luban_account ?? "本地用户", items: discussions.items });
          this.bypass(task, "MR 新意见通知", notifyExternalReviews({ store: this.annotations(task), workspace: task.summary.workspace,
            scope: task.summary.delivery?.mr_url ?? mrKey, owner: task.summary.luban_account ?? "", taskId: task.summary.id,
            link: personalTaskLink(this.notificationLinkBase(), task.summary.luban_account ?? "", task.summary.id), notifier: this.options.notifier }));
          this.refreshOwnerInputs(task);
        }
        // 回复走已有单飞发送，平台慢响应不能拖住下一拍合入观察。
        this.bypass(task, "检视回复发送", this.flushReviewReplyOutbox(task));
        if (this.reviewReplyOutboxStalled(task)) {
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        if (this.shuttingDown
            || ["completed", "canceled"].includes(task.summary.status)) return;
        // 查询期间用户可能接管/取消，不能沿用 await 前的派单许可。
        step = nextWatchStep({ view, status: task.summary.status, verifiedSha: task.summary.delivery?.sha });
        if (step.kind === "wait" || step.kind === "repair_conflict") {
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        if (step.kind === "stall_drift") {
          this.markVerificationStalled(task, step.reason, "safety");
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        // 门禁按平台事实分类；原始意见只同步批注，不合成自动修复门禁。
        const gates = view.gates;
        const sorted = classifyGates(gates);
        if (discussions?.kind === "unavailable") sorted.waiting.push(`MR 检视意见查询失败，正在重试：${discussions.reason}`);
        if (discussions?.kind === "available" && !discussions.items.length && gates.some((gate) =>
          gate.name === "resolve_discussion_passed" && gate.passed)) {
          // 关闭时别把 Agent 的逐条回复冲掉:批注与检视里的 CodeHub 意见
          // 列表要一直能看到"回了什么",平台确认只是状态变了。
          this.resolveFeedbackRecords(task,
            (record) => record.source === "mr_discussion",
            "closed", (record) => record.resolution
              || "MR 检视门禁已由平台确认通过");
        }
        if (sorted.repairs.length) {
          // 绿灯后门禁又亮红:检视/冲突照常派;CI 红说明平台侧又跑了
          // 一条流水线(目标分支动了之类),失败详情用门禁给的话。
          // 检视"已回复等检视人确认"不派单也不停环——归入等待名单,
          // 继续盯下一优先级和 MR 状态(报告 D3 的语义)。
          const max = this.repairBudget(task);
          if (max === 0) {
            // 关闭的是“自动修”，不是“持续观察”。旧实现直接 return，
            // 任务从此再也不知道门禁恢复、MR 被关/重开或最终合入。
            // 留在同一个监控环，只把当前红项如实交给人。
            sorted.waiting.push(autoRepairDisabledText(sorted.repairs));
          } else {
            const sha = task.summary.delivery?.sha ?? "";
            for (const candidate of sorted.repairs) {
              if (candidate.kind === "conflict") {
                if (await this.dispatchConflictRepair(
                  task, sha, max, task.controlEpoch)) {
                  await new Promise((tick) => setTimeout(tick, interval).unref());
                  continue watch;
                }
                continue;
              }
              await this.dispatchCiRepair(task, sha,
                candidate.gate.detail ?? "门禁 ci_state_passed 未通过",
                max, task.controlEpoch);
              await new Promise((tick) => setTimeout(tick, interval).unref());
              continue watch;
            }
          }
        }
        const write = waitingWrite(sorted.waiting, task.summary.delivery?.mr_url);
        if ((write.waiting_on ?? "") !== (task.summary.delivery?.waiting_on ?? "")) {
          task.summary.delivery!.waiting_on = write.waiting_on;
          task.summary.detail = write.detail;
          this.persist(task);
          // 等人的事要告诉人(幂等键=门禁集合,同一批等待只提醒一次;
          // 换了一批等待项才再响)。
          const account = task.summary.luban_account;
          if (write.notice && this.options.notifier && account
              && sorted.waiting.some(item => item !== "等责任人处理 MR 检视意见")) {
            this.bypass(task, "等待通知",
              this.options.notifier.notifyOutcome({
              taskId: task.summary.id,
              account,
              status: write.notice.status,
              summary: write.notice.summary,
              link: personalTaskLink(
                this.notificationLinkBase(), account, task.summary.id),
            }));
          }
        }
        await new Promise((tick) => setTimeout(tick, interval).unref());
        } catch (error) {
          // 单拍故障不能销毁生命周期监听；下一拍仍先核对真实合入状态。
          this.options.log?.(`任务 ${task.summary.id} MR 监听本轮失败，将重试：${String(error)}`);
          await new Promise((tick) => setTimeout(tick, interval).unref());
        }
      }
    } finally {
      task.mergeWatchActive = false;
    }
  }

  /** 当前反馈批次绑定的代码事实。内核会再次校验，Cloud 侧读取失败时
   * 直接停在派单前，不能拿 delivery.sha 或空串猜一个版本。 */
  private feedbackBaseSha(task: TaskState): string {
    if (!task.cwd) throw new TaskControlError("任务没有代码工作区，不能打开反馈批次");
    const result = runSafeWorktreeGit(task.cwd, ["rev-parse", "HEAD"]);
    const sha = result.status === 0 ? String(result.stdout ?? "").trim() : "";
    if (!sha) {
      throw new TaskControlError(
        `无法读取当前 HEAD，反馈尚未派给 Agent：${String(result.stderr ?? "").trim()}`,
      );
    }
    return sha;
  }

  /** 批 3 的最小正式接线：先让内核接纳这批反馈，再改变 Cloud 派单状态。
   * batch_id 只由来源版本和 HEAD 决定，服务重启/轮询重放天然幂等。 */
  private openFeedbackBatch(
    task: TaskState,
    source: FeedbackSource,
    items: Array<KernelFeedbackBatch["items"][number] & { author?: string }>,
  ): KernelFeedbackBatch {
    if (!this.options.host || !task.cwd) {
      throw new TaskControlError("当前部署没有持续检视内核，反馈未派单");
    }
    const baseSha = this.feedbackBaseSha(task);
    // 生产身份固定为来源+来源对象+来源版本+观察 HEAD。调用方传入的
    // 可读 id 只用于构造 source_id；不能再让 MR 编辑或跨 HEAD 复用时
    // 覆盖旧反馈、也不能让相同 batch_id 吞掉变化后的正文。
    // author 只留在 Cloud 索引给人看(批注与检视里的 CodeHub 意见列表),
    // 不进内核批次:内核契约不认这个字段,批次摘要也不该因排版事实变化。
    const authors = new Map<string, string>();
    const normalizedItems = items.map(({ author, ...item }) => {
      const id = feedbackIdentity({
        source,
        source_id: item.source_id,
        source_revision: item.source_revision,
        observed_sha: baseSha,
      });
      if (author) authors.set(id, author);
      return { ...item, id };
    });
    const batch: KernelFeedbackBatch = {
      schema: "mae-flow-feedback-batch/1",
      batch_id: feedbackBatchId(task.summary.id, baseSha, normalizedItems),
      task_id: task.summary.id,
      base_sha: baseSha,
      opened_at: new Date().toISOString(),
      items: normalizedItems,
    };
    // 仅供旧测试/嵌入式调用保持原契约；正式 serve 启动已经在批 2
    // fail-closed 探测并显式写入 continuousReview=true，不会走这里。
    if (this.options.host.continuousReview !== true) return batch;
    const store = new FeedbackStore(
      join(task.summary.workspace, "feedback", "index.jsonl"));
    const knownBatch = store.list().some((record) =>
      record.batch_id === batch.batch_id);
    const opened = openKernelFeedback({
      host: this.options.host,
      cwd: task.cwd,
      workspace: task.summary.workspace,
      batch,
    });
    const now = new Date().toISOString();
    store.upsert(normalizedItems.map((item) => ({
        id: item.id,
        batch_id: batch.batch_id,
        source,
        source_id: item.source_id,
        source_revision: item.source_revision,
        observed_sha: baseSha,
        summary: item.summary,
        ...(item.material ? { material: item.material } : {}),
        ...(item.file ? { file: item.file } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
        ...(authors.has(item.id) ? { author: authors.get(item.id)! } : {}),
        verification: item.verification,
        status: opened.status === "queued" ? "open" : "repairing",
        updated_at: now,
      })));
    const account = task.summary.luban_account;
    if (!knownBatch && this.options.notifier && account) {
      const labels: Record<FeedbackSource, string> = {
        workspace: "工作台批注",
        build_fix: "Build-Fix",
        pipeline: "流水线",
        mr_discussion: "MR 检视",
        conflict: "合并冲突",
        scope: "负责范围裁决",
        push_confirmation: "推送前复检",
      };
      const verification = source === "workspace" ? "批注作者"
        : source === "mr_discussion" ? "MR 检视人"
        : source === "push_confirmation" ? "任务责任人"
        : "对应机器门禁";
      const next = opened.status === "queued"
        ? "已排入当前任务，前一批处理完后自动接续"
        : "已交给当前任务的唯一修复会话处理";
      this.bypass(task, "持续检视反馈通知",
        this.options.notifier.notifyOutcome({
          taskId: task.summary.id,
          account,
          status: `feedback:${batch.batch_id}`,
          summary: `收到 ${labels[source]} ${normalizedItems.length} 条；${next}。`
            + `处理后由${verification}核验，不会另开任务。`,
          link: personalTaskLink(
            this.notificationLinkBase(), account, task.summary.id),
        }));
    }
    return batch;
  }

  /** 把当前唯一反馈批次的逐条处理结果交给内核。总体回复只用于人话
   * 摘要，条目集合始终来自内核已接纳的 batch，不能少报或夹带。 */
  private feedbackResultPath(task: TaskState, batchId: string): string {
    const digest = createHash("sha256").update(batchId).digest("hex").slice(0, 24);
    return resolve(task.summary.workspace, "feedback", `result-${digest}.json`);
  }

  private activeFeedbackResult(task: TaskState): {
    batchId: string;
    items: any[];
    path: string;
  } | undefined {
    if (!task.cwd) return undefined;
    let state: any;
    try {
      state = JSON.parse(readFileSync(
        join(task.cwd, ".mae-flow.json"), "utf-8"));
    } catch { return undefined; }
    const batchId = String(state?.delivery_loop?.active_batch_id ?? "");
    const batch = Array.isArray(state?.delivery_loop?.batches)
      ? state.delivery_loop.batches.find((item: any) => item?.batch_id === batchId)
      : undefined;
    const deferred = taskDeferredFeedback(this.taskHostRuntime(task));
    const items = (Array.isArray(batch?.items) ? batch.items : []).filter((item: any) => !deferred[item.id]
      && !historicalPipelineFeedback(task.summary, item));
    if (!batchId || batch?.result_digest || !items.length
        || items.every((item: any) => ["workspace", "mr_discussion"]
          .includes(String(item?.source ?? "")))) return undefined;
    return { batchId, items, path: this.feedbackResultPath(task, batchId) };
  }

  private prepareFeedbackResultFile(
    task: TaskState,
    path: string,
  ): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new TaskControlError("反馈回执目录不是宿主可信的真实目录，拒绝派单");
    }
    // 旧现场可能直接把任务根作为主 workspace 挂进容器。目录只开放
    // traverse，不开放 read/write；Agent 能按平台给定文件名抵达单文件
    // bind，却不能列目录、创建文件或删除 root:0600 的 index.jsonl。
    chmodSync(directory, 0o711);
    if (!existsSync(path)) {
      writeFileSync(path, "", { encoding: "utf-8", mode: 0o600, flag: "wx" });
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TaskControlError("反馈回执目标不是宿主预创建的普通文件，拒绝派单");
    }
    chmodSync(path, 0o600);
    if (this.options.isolation) {
      prepareContainerWritableFile({
        workspace: task.summary.workspace,
        path,
        user: this.options.isolation.user,
      });
    }
  }

  private activeFeedbackReceiptInstructions(task: TaskState): string {
    const active = this.activeFeedbackResult(task);
    if (!active) {
      const batch = this.activeKernelFeedback(task);
      if (!batch?.items.length || !batch.items.every((item) => item.source === "mr_discussion")) return "";
      return [
        `把本批 MR 逐条回复写入 ${JSON.stringify(resolve(task.summary.workspace, "review_replies.md"))}。`,
        "使用每条的 source_id（讨论 ID），不要使用反馈批次 ID。每个方括号标题单独一行，下面填写该条回复，不得追加摘要到 ID。",
        ...batch.items.map((item) => `[${item.source_id}]\n<填写这条的回复：改了什么或为什么不改>`),
        "重复 ID 或缺失正文不能登记；只补回复，不要重复修改或提交代码。",
      ].join("\n\n");
    }
    this.prepareFeedbackResultFile(task, active.path);
    return feedbackReceiptInstructions(active);
  }

  private recordActiveFeedbackResult(task: TaskState): string | undefined {
    if (!this.options.host?.continuousReview || !task.cwd) return undefined;
    let state: any;
    try {
      state = JSON.parse(readFileSync(
        join(task.cwd, ".mae-flow.json"), "utf-8"));
    } catch {
      return "内核状态不可读，无法登记逐条反馈回执";
    }
    const loop = state?.delivery_loop;
    const batchId = String(loop?.active_batch_id ?? "");
    const batch = Array.isArray(loop?.batches)
      ? loop.batches.find((item: any) => item?.batch_id === batchId) : undefined;
    if (!batchId || !batch) return undefined;
    // 新 SHA 已交给流水线，旧批次可保留未填回执的历史事实；不能在
    // 人的新插话/会话恢复收口时，再把旧批次派成一次补交或修复任务。
    if (batch.items?.length && batch.items.every((item: any) =>
      historicalPipelineFeedback(task.summary, item))) return undefined;
    const host = this.options.host;
    // 内核暂时不可用 ≠ 收据缺失:前者返回以 KERNEL_UNAVAILABLE 开头的
    // 原因,调用方据此挂起自愈、不叫 Agent 补回执也不停摆。
    try {
      if (!trustedKernelHostFeedback({
        host, cwd: task.cwd, state,
      })) {
        return `反馈批次 ${batchId} 缺少 Cloud 宿主权威收据，已拒绝使用可篡改状态`;
      }
      if (batch.result_digest) {
        // 上面已核验同一快照的全部反馈事实（含历史结果和调度决定）。
        // 正常重放复用快照；旧任务交还步骤后重新读盘核验，再补齐索引。
        const resumed = resumeRecordedFeedback({ host, cwd: task.cwd, workspace: task.summary.workspace,
          taskId: task.summary.id, state, batch });
        this.syncFeedbackStoreFromKernel(task, false, resumed ? undefined : state);
        return batch.status === "needs_human" ? humanFeedbackReason(batch.items, batch.results) : undefined;
      }
    } catch (error) {
      if (error instanceof KernelUnavailableError) {
        return `${error.message}；反馈批次 ${batchId} 的回执登记尚未确认，将自动重试`;
      }
      throw error;
    }
    const head = this.feedbackBaseSha(task);
    const changed = head !== String(batch.base_sha ?? "");
    const annotations = new Map(this.annotations(task).list()
      .map((item) => [item.id, item]));
    const deferred = taskDeferredFeedback(this.taskHostRuntime(task));
    const batchItems = (Array.isArray(batch.items) ? batch.items : []).filter((item: any) => !deferred[item.id]);
    let results: Array<{
      id: string;
      status: "fixed" | "explained" | "needs_human" | "not_applicable";
      summary: string;
      evidence?: string;
    }>;
    if (batchItems.every((item: any) => item?.source === "workspace")) {
      results = [];
      for (const item of batchItems) {
        const annotation = annotations.get(String(item.source_id ?? ""));
        const resolved = resolvedWorkspaceFeedback(item, annotation);
        if (resolved) { results.push(resolved); continue; }
        const response = annotation?.response;
        if (!response || response.revision !== Number(item.source_revision ?? 0)) {
          return `工作台反馈 ${String(item.id)} 缺少当前版本的逐条回执`;
        }
        results.push({
          id: String(item.id),
          status: response.outcome === "fixed" ? "fixed"
            : response.outcome === "needs_clarification" ? "needs_human"
            : "explained",
          summary: response.summary,
          evidence: response.evidence?.join("；") || undefined,
        });
      }
    } else if (batchItems.every((item: any) => item?.source === "mr_discussion")) {
      const path = resolve(task.summary.workspace, "review_replies.md");
      let parsed: ReturnType<typeof parseReviewReplies>;
      try {
        parsed = parseReviewReplies(readFileSync(path, "utf-8"),
          batchItems.map((item: any) => String(item.source_id ?? "")));
      } catch (error) {
        return `Agent 没有留下 MR 逐条回复：${String(error)}`;
      }
      if (parsed.duplicate_ids.length) {
        return `MR 逐条回复的讨论 ID 重复：${parsed.duplicate_ids.join("、")}；请为每条保留一份明确回复`;
      }
      if (parsed.missing_ids.length) {
        return `MR 逐条回复缺少：${parsed.missing_ids.join("、")}`;
      }
      const byId = new Map(parsed.replies.map((item) => [item.id, item.body]));
      results = batchItems.map((item: any) => ({
        id: String(item.id),
        status: "explained" as const,
        summary: byId.get(String(item.source_id ?? ""))!.slice(0, 4000),
        evidence: resolve(task.summary.workspace, "review_replies.md"),
      }));
    } else {
      const path = this.feedbackResultPath(task, batchId);
      let raw: any;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error("回执不是普通文件");
        }
        if (stat.size > 512 * 1024) throw new Error("回执超过 512 KiB 上限");
        raw = JSON.parse(readFileSync(path, "utf-8"));
      } catch (error) {
        // 文件压根不存在 = 这批还没人处理;存在但读不动/不是 JSON = 回执
        // 确实不合格。两者的出路不同,措辞也不能一样。
        return (error as NodeJS.ErrnoException)?.code === "ENOENT"
          ? `${FEEDBACK_RESULT_MISSING}（${basename(path)}）：`
            + "本批反馈尚未被修复会话处理过"
          : `Agent 留下的本批逐条反馈回执无法读取（${basename(path)}）：`
            + String(error);
      }
      if (raw?.schema !== "mae-flow-feedback-results/1"
          || raw?.batch_id !== batchId || !Array.isArray(raw?.results)) {
        return "逐条反馈回执的 schema、batch_id 或 results 不正确";
      }
      const allowed = new Set(["fixed", "explained", "needs_human", "not_applicable"]);
      const expected = new Set<string>(
        batchItems.map((item: any) => String(item.id)));
      const seen = new Set<string>();
      results = [];
      for (const item of raw.results) {
        const id = String(item?.id ?? "");
        const status = String(item?.status ?? "");
        const summary = String(item?.summary ?? "").trim();
        if (!id || seen.has(id) || !expected.has(id) || !allowed.has(status)
            || !summary) {
          return `逐条反馈回执含重复、夹带或字段不完整的条目：${id || "(空 id)"}`;
        }
        seen.add(id);
        results.push({
          id,
          status: status as typeof results[number]["status"],
          summary: summary.slice(0, 4000),
          evidence: String(item?.evidence ?? "").trim().slice(0, 4000) || undefined,
        });
      }
      const missing = [...expected].filter((id) => !seen.has(id));
      if (missing.length) return `逐条反馈回执缺少：${missing.join("、")}`;
      if (!changed && results.some((item) => item.status === "fixed")) {
        return "逐条回执声称已修复，但当前 HEAD 没有变化；请改为 explained/needs_human 或提交真实修改";
      }
    }
    try {
      const record = recordKernelFeedbackResult({
        host: this.options.host,
        cwd: task.cwd,
        workspace: task.summary.workspace,
        taskId: task.summary.id,
        batchId,
        changed,
        results,
      });
      const store = new FeedbackStore(
        join(task.summary.workspace, "feedback", "index.jsonl"));
      for (const result of results) {
        store.resolve(result.id,
          result.status === "needs_human" ? "needs_human"
            : record.status === "awaiting_verification" || record.status === "needs_human"
              ? "awaiting_verification" : "closed",
          result.summary);
      }
      this.syncFeedbackStoreFromKernel(task);
      return humanFeedbackReason(batchItems, results);
    } catch (error) {
      if (error instanceof KernelUnavailableError) {
        return `${error.message}；反馈批次 ${batchId} 的回执登记尚未确认，将自动重试`;
      }
      return `内核拒绝逐条反馈回执：${String(error)}`;
    }
  }

  /** §10.3 事故迁移：旧 Cloud 已经把原始意见落盘，只需把同一批事实
   * 补登给刚恢复的内核。材料缺失时拒绝启动，不拿 mission 文本猜条目。 */
  private openPersistedReviewFeedback(task: TaskState): void {
    const source = task.summary.delivery?.loop?.review_source;
    const reviewsDir = join(task.summary.workspace, "reviews");
    if (source === "workspace") {
      const value = JSON.parse(readFileSync(
        join(reviewsDir, "local-annotations.json"), "utf-8"));
      const annotations = Array.isArray(value?.annotations)
        ? value.annotations as Annotation[] : [];
      if (!annotations.length) {
        throw new ContinuousReviewMigrationError(
          "工作台检视事故现场缺少 local-annotations.json 条目",
        );
      }
      this.openFeedbackBatch(task, "workspace", annotations.map((item) => ({
        id: `workspace:${item.id}:r${item.rework ?? 0}`,
        source: "workspace",
        source_id: item.id,
        source_revision: item.rework ?? 0,
        kind: "code_review",
        summary: String(item.note ?? "工作台检视意见").slice(0, 1000),
        material: resolve(task.summary.workspace, "reviews", "local-annotations.json"),
        verification: item.author || "author",
        ...(item.file ? { file: item.file } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
      })));
      return;
    }
    const discussions = JSON.parse(readFileSync(
      join(reviewsDir, "discussions.json"), "utf-8"));
    if (!Array.isArray(discussions) || !discussions.length) {
      throw new ContinuousReviewMigrationError(
        "MR 检视事故现场缺少 discussions.json 条目",
      );
    }
    this.openFeedbackBatch(task, "mr_discussion",
      (discussions as DiscussionItem[]).map((item) => ({
        id: `mr:${item.id}`,
        source: "mr_discussion",
        source_id: item.id,
        source_revision: discussionRevision(item),
        kind: "code_review",
        summary: String(item.body ?? "MR 检视意见").slice(0, 1000),
        material: resolve(task.summary.workspace, "reviews", "discussions.json"),
        verification: "reviewer",
        ...(item.file ? { file: item.file } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
        ...(item.author ? { author: String(item.author).slice(0, 120) } : {}),
      })));
  }

  /** 工作台本地检视修复：用户点“提交并继续修改”本身就是逐条修复授权，
   * 与“MR 上别人留了一条意见、需要责任人先裁决”不是同一种输入。
   * 仍走内核 review 正路，但不让 Agent 再问一遍“这些意见接不接纳”。 */
  private dispatchWorkspaceReviewRepair(
    task: TaskState,
    annotations: Annotation[],
    rendered: string,
  ): void {
    const delivery = task.summary.delivery!;
    const max = this.repairBudget(task);
    const previousFailure = delivery.loop?.failure;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    loop.kind = "review";
    loop.review_source = "workspace";
    loop.workspace_review_pending = true;
    loop.workspace_review_recheck_required = true;
    loop.workspace_review_annotation_ids = [...new Set([
      ...(loop.workspace_review_annotation_ids ?? []),
      ...annotations.map((item) => item.id),
    ])];
    loop.round = 0;
    loop.max = max;
    loop.review_ids = `workspace:${annotations.map((item) =>
      `${item.id}:r${item.rework ?? 0}`).sort().join(",")}:${Date.now()}`;
    loop.replied_ids = undefined;
    loop.state = "repairing";
    loop.diagnosis = undefined;

    // 旧 SHA 的取证/停机状态不能卡住人的新修改。旧失败摘要留在使命里，
    // 让这一轮能顺手一起处理；最终结论只认新提交重新跑出的流水线。
    delivery.waiting_on = undefined;
    delivery.stalled = undefined;
    delivery.stall_class = undefined;
    delivery.verify_deadline = undefined;
    delivery.evidence_gap = undefined;

    const reviewsDir = join(task.summary.workspace, "reviews");
    try {
      mkdirSync(reviewsDir, { recursive: true });
      writeFileSync(join(reviewsDir, "local-annotations.json"), JSON.stringify({
        task_id: task.summary.id,
        mr_url: delivery.mr_url,
        submitted_at: new Date().toISOString(),
        annotations,
      }, null, 2));
      // 本地检视没有 MR discussion 回复；残留的旧回复绝不能在本轮结束
      // 时被误发到平台。
      if (existsSync(resolve(task.summary.workspace, "review_replies.md")))
        writeFileSync(resolve(task.summary.workspace, "review_replies.md"), "");
      rmSync(this.reviewReceiptsPath(task), { force: true });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 本地检视材料落盘失败(使命正文仍可用): ${String(error)}`);
    }
    try {
      this.openFeedbackBatch(task, "workspace", annotations.map((item) => ({
        id: `workspace:${item.id}:r${item.rework ?? 0}`,
        source: "workspace",
        source_id: item.id,
        source_revision: item.rework ?? 0,
        kind: "code_review",
        summary: String(item.note ?? "工作台检视意见").slice(0, 1000),
        material: resolve(task.summary.workspace, "reviews", "local-annotations.json"),
        verification: item.author || "author",
        ...(item.file ? { file: item.file } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
      })));
    } catch (error) {
      this.markVerificationStalled(task,
        `工作台批注已保留，但内核未能打开持续检视批次，尚未启动 Agent：${String(error)}`,
        stallClassForError(error, "contract"));
      return;
    }
    const priorPipeline = previousFailure
      ? [
          "- 当前 MR 同时还有上一轮流水线失败。人的检视优先，但不要丢掉已知 CI 问题；两类修改合进同一次提交：",
          previousFailure,
          `  完整流水线材料若存在，仍在 ${resolve(task.summary.workspace, "pipeline")}；新提交会重新跑权威流水线。`,
        ]
      : [];
    this.enqueueRepair(task, [
      `任务责任人在工作台明确提交了 ${annotations.length} 条当前 MR 检视意见。`
        + "按当前责任人要求逐条落实并更新原 MR；较新的要求可调整目标或逐条暂缓：",
      rendered,
      concurrentWorkPrompt(),
      "- Cloud 宿主已把本批意见登记到当前任务的持续检视流程。不要 init，"
        + "不要 exit/goto/skip；先执行 current，按当前反馈步骤继续。",
      "- 这些不是待你猜测是否接纳的外部建议：用户点击“提交并继续修改”已经明确授权"
        + "逐条修复。先查代码事实，要求明确就直接在 review.md 记为“修复(已确认)”并处理，"
        + "不要再举卡重复问‘是否修复’。",
      "- 若内核只因本轮没有重复 AskUserQuestion 而缺 ASKUSER 证据，按 current 给出的"
        + "受控出口执行一次 accept-risk askuser，并把理由写成“用户已在工作台逐条提交修改要求”；"
        + "这只豁免重复询问，不豁免 review.md、查证、实现、检视、提交或流水线。",
      "- 只有意见本身确实模糊、不同理解会造成不同代码结果时才 AskUserQuestion；"
        + "问题里必须点明歧义和不同结果，不能用泛泛的‘请确认’把工作退回用户。",
      ...priorPipeline,
      this.reviewReceiptInstructionsFor(task, annotations),
      "- 本批修改、必要验证与逐条答复完成后，先按新交办工作指引核对原有结果、未决问题和已宣布未完成动作，再结束本轮；宿主会登记结果并继续交付。不要为了推进 feedback_triage 重复处理已闭环意见或重复编译；仍有实际失败或新意见则继续处理。",
      "- 在当前 MR 分支修改必要的源码和测试，遵守仓库的 commit 指引。"
        + "不要读取或索要个人 Git 令牌；可用 task_control push 阶段性推送到原分支、"
        + "更新原 MR；Build-Fix 与权威流水线分别记录新 SHA 的真实结果。",
    ].join("\n"), `收到 ${annotations.length} 条本地检视意见，正在修改当前 MR`);
  }

  /** 分支上的外来提交对 Agent 的披露。它们是人直接推上来的,默认可信;
   * 但任何一轮修复会话若不知情,很容易把别人的改动当成脏东西"整理"掉
   * (reset/revert/squash 都够呛),所以派单时必须点名。 */
  private foreignCommitNotice(task: TaskState): string {
    const foreign = task.summary.delivery?.foreign_commits;
    if (!foreign?.count) return "";
    return [
      `注意:本任务分支上有 ${foreign.count} 条不是本任务产生的提交`
        + "(有人直接往分支推了代码),它们已经在你的历史里:",
      ...foreign.subjects.slice(0, 8).map((line) => `- ${line}`),
      "它们默认可信:不要回滚、改写、squash 或\"整理\"掉。"
        + "你的修改接在它们之后即可;确有冲突就如实说明,不要自己替人决定。",
    ].join("\n");
  }

  private branchSync(task: TaskState, epoch = task.controlEpoch): TaskBranchSync {
    return new TaskBranchSync({
      summary: task.summary, cwd: task.cwd, enabled: !!this.options.host,
      defaultRepository: () => this.effectiveDefaultRepo(), validateRepository: validateRepositoryAddress,
      credential: () => this.options.gitCredential?.(task.summary.luban_account),
      prepareGit: credential => this.prepareHostGitSandbox(credential),
      cleanupGit: sandbox => this.cleanupHostGitCredential(sandbox),
      current: () => this.current(task, epoch), persist: () => this.persist(task),
      lastReply: () => task.lastReply, feedbackBaseSha: () => this.feedbackBaseSha(task),
      enqueueRepair: (message, detail) => this.enqueueRepair(task, message, detail),
      stall: (message, kind) => this.markVerificationStalled(task, message, kind),
      openFeedback: items => { this.openFeedbackBatch(task, "conflict", items); },
      notifyStopped: () => this.notifyRepairStopped(task),
      deliver: () => this.tryDeliver(task, epoch), log: this.options.log,
    });
  }

  private absorbForeignRemoteCommits(task: TaskState, branch: string, dispatchRepair = true) {
    return this.branchSync(task).absorb(branch, dispatchRepair);
  }

  private async observeActiveConflict(task: TaskState, view: GateView): Promise<void> {
    if (this.repairBudget(task) === 0 || ["paused", "pausing"].includes(task.summary.status) || task.assistantActive
        || task.prepushActive || task.deliveryActive || task.transportActive
        || new TaskHostLedger(task.summary).pending()) return;
    const notice = `${view.sourceSha ?? task.summary.delivery?.sha ?? ""}:${task.summary.delivery?.target_branch ?? task.summary.baseline ?? ""}`;
    if (task.conflictNotice === notice) return;
    const message = "MR 已报告与目标分支存在代码冲突，平台可能因此不创建流水线。继续完成当前检视或开发目标，并在下一次 push 前调用 task_control(action=\"sync_branch\") 拉取远端任务分支与最新目标分支；按返回的真实冲突读取双方上下文、解决并提交，执行受影响的验证后更新原 MR。不要等待流水线红灯，也不要丢失当前检视意见及逐条回复。";
    if (task.driver) {
      await task.driver.steer(message);
    } else if (task.summary.status === "queued" || task.summary.status === "running") {
      task.pendingMainSteers = [...(task.pendingMainSteers ?? []), message];
    } else if (task.summary.status === "verifying") {
      // 使旧流水线回调失效，再复用当前任务的修复入口。
      task.controlEpoch += 1;
      this.enqueueRepair(task, [task.mission, message].filter(Boolean).join("\n\n"),
        "MR 存在冲突，正在同步分支并自动修复");
    } else return;
    task.conflictNotice = notice;
    this.persist(task);
  }

  private syncTargetBeforePush(task: TaskState, target: string, epoch: number) {
    return this.branchSync(task, epoch).syncBeforePush(target);
  }

  private dispatchConflictRepair(task: TaskState, sha: string, max: number | undefined,
    epoch: number, sync?: BranchSyncRequest) {
    return this.branchSync(task, epoch).repair(sha, max, sync);
  }

  private deliveryOutbox(task: TaskState): DeliveryOutbox {
    return new DeliveryOutbox(
      join(task.summary.workspace, "delivery-outbox.jsonl"));
  }

  /** Build-Fix 收敛后把逐条回复按最终 SHA 可靠入队，不做网络动作。
   * 代码尚未 push，此时先去 MR 上说“已修复”会让检视人看到旧代码；
   * 更不能部分成功后删除草稿。缺任何一条就明确停下，不能拿总体发言
   * 冒充逐条答复。 */
  private async stageReviewReplies(task: TaskState): Promise<{
    ok: boolean;
    detail?: string;
  }> {
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source === "workspace" || loop?.kind !== "review") {
      return { ok: true };
    }
    const repliesPath = resolve(task.summary.workspace, "review_replies.md");
    const alreadyReplied = new Set(
      loop.replied_ids?.split(",").filter(Boolean) ?? []);
    let known = (loop.review_ids?.split(",").filter(Boolean) ?? [])
      .map((key) => ({
        key,
        id: discussionIdFromKey(key),
        revision: discussionRevisionFromKey(key),
      }));
    try {
      const rows = JSON.parse(readFileSync(
        join(task.summary.workspace, "reviews", "discussions.json"), "utf-8"));
      if (Array.isArray(rows)) {
        const identities = rows.filter((item) =>
          String((item as { id?: unknown })?.id ?? ""))
          .map((item) => {
            const discussion = item as DiscussionItem;
            return {
              key: discussionKey(discussion), id: discussion.id,
              revision: discussionRevision(discussion),
            };
          });
        if (identities.length) known = identities;
      }
    } catch { /* review_ids 是持久化兜底 */ }
    const expected = [...new Map(known.map((item) => [item.key, item])).values()]
      .filter((item) => !alreadyReplied.has(item.key));
    let sourceSha: string;
    try {
      if (!task.cwd) throw new Error("代码现场不可用");
      sourceSha = (await this.prePushRevision(task)).sha;
    } catch (error) {
      return {
        ok: false,
        detail: `MR 回复无法绑定最终提交：${String(error)}`,
      };
    }
    const outbox = this.deliveryOutbox(task);
    const staged = new Set(outbox.list()
      .filter((item) => item.kind === "review_reply"
        && item.payload.expected_sha === sourceSha)
      .map((item) => discussionKeyFromParts(
        item.payload.discussion_id, item.payload.source_revision)));
    const uncovered = expected.filter((item) => !staged.has(item.key));
    if (!uncovered.length) return { ok: true };
    if (!existsSync(repliesPath)) {
      return {
        ok: false,
        detail: `Agent 没有留下 MR 逐条回复（缺 ${
          uncovered.map((item) => item.id).join("、")}）。`
          + "已保留代码现场，补齐答复前不会 push。",
      };
    }
    let text: string;
    try {
      text = readFileSync(repliesPath, "utf-8");
    } catch (error) {
      return { ok: false, detail: `读取 MR 逐条回复失败：${String(error)}` };
    }
    const parsed = parseReviewReplies(text, uncovered.map((item) => item.id), known.map((item) => item.id));
    if (parsed.duplicate_ids.length) {
      return { ok: false, detail: `MR 逐条回复的讨论 ID 重复：${parsed.duplicate_ids.join("、")}；请保留一份明确回复` };
    }
    if (parsed.missing_ids.length) {
      return {
        ok: false,
        detail: `MR 逐条回复不完整，缺 ${parsed.missing_ids.join("、")}。`
          + "已保留代码现场，不能用总体回复糊弄过去。",
      };
    }
    const repo = task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "";
    const resolveDiscussions = this.options.delivery?.resolveDiscussions ?? false;
    const revisionById = new Map(uncovered.map((item) =>
      [item.id, item.revision] as const));
    try {
      for (const reply of parsed.replies) {
        outbox.enqueueReviewReply({
          discussion_id: reply.id,
          source_revision: revisionById.get(reply.id) ?? 0,
          body: reply.body,
          repo,
          mr: task.summary.delivery?.mr_id,
          resolve: resolveDiscussions,
          expected_sha: sourceSha,
        });
      }
    } catch (error) {
      return {
        ok: false,
        detail: `MR 回复进入可靠发送账失败：${String(error)}。`
          + "草稿仍保留，未继续 push。",
      };
    }
    try { writeFileSync(repliesPath, ""); } catch {
      // outbox 已是权威事实；残留草稿下次会幂等入同一动作，不会重复。
    }
    return { ok: true };
  }

  /** 只在宿主已经拿到 push 收据后发送。单条失败只留它自己 pending；
   * 后续监控/重启继续，不重派 Agent，也不把整批误记成已回复。 */
  private reviewReplyOutboxStalled(task: TaskState): boolean {
    const stalled = task.summary.delivery?.stalled;
    // 跨版本兼容:停摆判据匹配的是持久化文本,旧版盘面写的是「投递账
    // 不可读」(全仓用语清扫前),升级后旧现场也要能命中自愈。
    return stalled?.startsWith("检视回复发送账不可读") === true
      || stalled?.startsWith("检视回复投递账不可读") === true;
  }

  private markReviewReplyOutboxUnreadable(
    task: TaskState,
    error: unknown,
  ): false {
    if (task.mergeSettlement || ["completed", "canceled"].includes(task.summary.status)) return false;
    const detail = "检视回复发送账不可读，已停止自动回复；"
      + "请管理员修复任务现场中的 delivery-outbox.jsonl 后重试。"
      + `原因：${String(error).slice(0, 500)}`;
    task.summary.detail = detail;
    task.summary.delivery = {
      ...task.summary.delivery,
      stalled: detail,
      stall_class: "infrastructure",
      waiting_on: detail,
    };
    if (!["await_merge", "waiting_for_human", "paused", "canceled"]
      .includes(task.summary.status)) {
      task.summary.status = "verifying";
    }
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id} ${detail}`);
    return false;
  }

  private async flushReviewReplyOutbox(task: TaskState): Promise<boolean> {
    if (task.reviewOutboxFlush) return task.reviewOutboxFlush;
    const running = this.flushReviewReplyOutboxOnce(task);
    task.reviewOutboxFlush = running;
    try {
      return await running;
    } finally {
      if (task.reviewOutboxFlush === running) {
        task.reviewOutboxFlush = undefined;
      }
    }
  }

  private async flushReviewReplyOutboxOnce(task: TaskState): Promise<boolean> {
    const platformUrl = this.effectivePlatformUrl();
    const pushedSha = task.summary.delivery?.git_push?.sha;
    if (!platformUrl || !pushedSha) return true;
    const outbox = this.deliveryOutbox(task);
    let pending: DeliveryOutboxItem[];
    try {
      // 沿用持久化尝试次数轮转，慢回复不能每轮耗尽预算、饿死后续回复。
      pending = outbox.pendingReviewReplies().sort((a, b) => a.attempts - b.attempts);
    } catch (error) {
      return this.markReviewReplyOutboxUnreadable(task, error);
    }
    const budget = AbortSignal.timeout(10_000);
    for (const item of pending) {
      if (budget.aborted || this.shuttingDown || task.mergeSettlement
          || ["completed", "canceled"].includes(task.summary.status)
          || task.summary.delivery?.git_push?.sha !== pushedSha) break;
      if (item.payload.expected_sha !== pushedSha) {
        const reason = `拒绝发送：回复绑定 ${item.payload.expected_sha.slice(0, 12)}`
          + `，当前远端推送收据是 ${pushedSha.slice(0, 12)}`;
        try {
          if (item.last_error !== reason) {
            // 保持 pending 等对应 push 收据，不能借另一版代码发“已修”。
            outbox.markFailed(item.id, reason);
          }
        } catch (error) {
          return this.markReviewReplyOutboxUnreadable(task, error);
        }
        this.options.log?.(
          `任务 ${task.summary.id} 检视回复 SHA 不匹配，${reason}`);
        continue;
      }
      try {
        outbox.markAttempt(item.id);
        await postMrDiscussionReply({
          platformUrl,
          discussionId: item.payload.discussion_id,
          repo: item.payload.repo,
          body: item.payload.body,
          resolve: item.payload.resolve,
          idempotencyKey: item.id,
          mr: item.payload.mr ?? task.summary.delivery?.mr_id,
          headers: this.platformIdentity(task),
          signal: budget,
        });
        outbox.markDelivered(item.id);
        this.bypass(task, "投影动作", this.options.projection?.recordAction({
          taskId: task.summary.id,
          idemKey: item.id,
          kind: "review_reply",
          request: {
            id: item.payload.discussion_id,
            body: item.payload.body.slice(0, 500),
          },
          startedAt: item.created_at,
          finishedAt: new Date().toISOString(),
        }));
      } catch (error) {
        try { outbox.markFailed(item.id, String(error)); } catch (ledgerError) {
          // 其他恢复链可能已发送成功；先读账区分落账冲突与真正损坏。
          try {
            const current = outbox.list().find((one) => one.id === item.id);
            if (current?.state === "delivered") continue;
          } catch (readError) {
            return this.markReviewReplyOutboxUnreadable(task, readError);
          }
          return this.markReviewReplyOutboxUnreadable(task, ledgerError);
        }
        this.options.log?.(
          `任务 ${task.summary.id} 检视回复待重试(讨论 ${
            item.payload.discussion_id}): ${String(error)}`);
      }
    }
    // 迟到响应仍如实记入发送账，但不能覆盖合入/取消终态。
    if (task.mergeSettlement || ["completed", "canceled"].includes(task.summary.status)) return true;
    let delivered: string[];
    try {
      delivered = outbox.list().filter((item) =>
        item.kind === "review_reply" && item.state === "delivered")
        .map((item) => discussionKeyFromParts(
          item.payload.discussion_id, item.payload.source_revision));
    } catch (error) {
      return this.markReviewReplyOutboxUnreadable(task, error);
    }
    const loop = task.summary.delivery?.loop;
    if (loop?.kind === "review" && delivered.length) {
      // 只投影当前讨论的已发送事实，保留历史账但不复活已离场讨论。
      const current = new Set(loop.review_ids?.split(",").filter(Boolean) ?? []);
      const existing = (loop.replied_ids?.split(",").filter(Boolean) ?? [])
        .filter((id) => current.has(id));
      const next = [...new Set([...existing,
        ...delivered.filter((id) => current.has(id))])]
        .sort().join(",");
      const normalizedNext = next || undefined;
      if (normalizedNext !== loop.replied_ids) {
        loop.replied_ids = normalizedNext;
        this.persist(task);
      }
    }
    const stalled = task.summary.delivery?.stalled;
    if (stalled?.startsWith("检视回复发送账不可读")
      || stalled?.startsWith("检视回复投递账不可读")) {
      delete task.summary.delivery!.stalled;
      delete task.summary.delivery!.stall_class;
      if (task.summary.delivery?.waiting_on === stalled) {
        task.summary.delivery.waiting_on = undefined;
      }
      if (task.summary.detail === stalled) {
        task.summary.detail = task.summary.status === "await_merge"
          ? "检视回复发送账已恢复，继续等待 MR 检视与合入"
          : "检视回复发送账已恢复，继续交付验证";
      }
      this.persist(task);
    }
    return true;
  }

  /** 流水线证据口:终态时把平台事实(sha/status/可选 checks/来源)写成文件喂给
   * 内核仓的 `pipeline record`,内核绑工作区当前 HEAD 裁决并把结论写
   * 进 .mae-flow.json 的 quality.external_verification——判定一行不在
   * 本仓(红线:内核唯一权威;宿主只递事实)。delivery.attested 是那份
   * 现场记录的镜像戳。30s 预算；登记失败返回 undefined，总体绿灯
   * 必须 fail-closed 留在 verifying，红灯仍可进入轻量修复环。 */
  private async recordPipelineEvidence(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    checks: PipelineCheck[] | undefined,
  ): Promise<PipelineAttestation | undefined> {
    const kernelRoot = this.options.host?.kernelRoot;
    const delivery = task.summary.delivery;
    if (!kernelRoot || !task.cwd || !delivery) return undefined;
    const factsPath = join(task.summary.workspace, "pipeline-facts.json");
    try {
      const facts = {
        sha,
        status,
        ...(checks !== undefined ? { checks } : {}),
        ...(delivery.git_push ? { git_push: delivery.git_push } : {}),
        source: this.effectivePlatformUrl() ?? "",
        url: delivery.mr_url ?? "",
      };
      writeFileSync(factsPath, JSON.stringify(facts, null, 2));
      const proof = this.continuousReviewTask(task)
        ? createKernelHostProof({
            cwd: task.cwd,
            workspace: task.summary.workspace,
            taskId: task.summary.id,
            action: "pipeline-record",
            payload: facts,
          })
        : undefined;
      const gitView = createSafeGitView(task.cwd);
      const result = await new Promise<
        { code: number | null; out: string; err: string }>(
        (resolve) => {
          const child = spawn(this.options.host!.python ?? "python3",
            [join(kernelRoot, "scripts", "mae-flow.py"),
             "pipeline", "record", "--file", factsPath,
             ...(proof ? ["--host-proof", proof.path] : [])],
            {
              cwd: task.cwd!,
              stdio: ["ignore", "pipe", "pipe"],
              env: gitView.environment(),
            });
          let out = "";
          let err = "";
          child.stdout.setEncoding("utf-8");
          child.stderr.setEncoding("utf-8");
          child.stdout.on("data", (chunk: string) => (out += chunk));
          child.stderr.on("data", (chunk: string) => (err += chunk));
          const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
          timer.unref();
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
          });
          child.on("error", () => {
            clearTimeout(timer);
            resolve({ code: null, out, err });
          });
        }).finally(() => {
          gitView.cleanup();
          proof?.cleanup();
        });
      // 内核约定:末行是机器可读的裁决 JSON(quality.pipeline 原文)。
      const lastLine = result.out.trim().split("\n").at(-1) ?? "";
      let record: Record<string, unknown> | undefined;
      try {
        record = JSON.parse(lastLine);
      } catch {
        record = undefined;
      }
      if (result.code === 0 && typeof record?.verdict === "string") {
        delivery.attested =
          `${record.verdict}@${String(record.sha ?? sha).slice(0, 12)}`;
        return {
          verdict: record.verdict,
          sha: typeof record.sha === "string" ? record.sha : sha,
          reason: typeof record.reason === "string" ? record.reason : undefined,
          checks: record.checks && typeof record.checks === "object"
            ? record.checks as Record<string, unknown> : undefined,
        };
      } else {
        delivery.attested = "未裁决(内核登记失败,详见服务日志)";
        this.options.log?.(
          `任务 ${task.summary.id} 流水线证据登记失败(code `
          + `${result.code ?? "spawn-error"}): ${result.out.slice(0, 2_000)} `
          + result.err.slice(0, 4_000));
      }
    } catch (error) {
      delivery.attested = "未裁决(登记异常,详见服务日志)";
      this.options.log?.(
        `任务 ${task.summary.id} 流水线证据登记异常: ${String(error)}`);
    }
    return undefined;
  }

  /** 批2 落盘通道:拉平台的失败材料镜像到工作区外 pipeline/。
   * 每轮先清空内容再重下(给 agent 的必须是最新一轮),但绝不删除
   * pipeline 根目录——它是运行中 Coding 容器的只读 bind 源；替换根
   * 目录会让容器继续看到旧 inode。平台不支持(404)或失败回空数组,
   * 修复照走摘要通道。实现收口在公共 pipelineMirror(与问题流同一
   * 份),这里只补需求侧的取参、身份头与失败日志。 */
  private async mirrorPipelineArtifacts(task: TaskState): Promise<string[]> {
    const platformUrl = this.effectivePlatformUrl();
    const sha = task.summary.delivery?.sha;
    if (!platformUrl || !sha) return [];
    try {
      return await mirrorPipelineArtifactsShared({
        platformUrl,
        sha,
        current: () => task.summary.delivery?.sha === sha && !this.shuttingDown,
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
        // artifacts 编排器是 MR-first，第四参契约是完整 MR URL（SSE 的
        // query_mr_info 直接消费它），不是 status 主路使用的 MR iid。
        mrUrl: task.summary.delivery?.mr_url,
        dir: join(task.summary.workspace, "pipeline"),
        headers: this.platformIdentity(task),
        log: (message) =>
          this.options.log?.(`[pipeline-mirror] 任务 ${task.summary.id}: ${message}`),
      });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 流水线材料镜像失败(走摘要通道): `
        + String(error));
      return [];
    }
  }

  private fetchDiscussions(task: TaskState): Promise<DiscussionFetch> {
    return fetchMrDiscussions({ platformUrl: this.effectivePlatformUrl(),
      repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
      delivery: task.summary.delivery, headers: this.platformIdentity(task) });
  }

  /** 修复派单的共同尾巴:使命上膛、任务重排队,setImmediate 避开
   * settle 链上的状态竞态(同 dispatchCiRepair 里那条注释)。 */
  private enqueueRepair(
    task: TaskState,
    mission: string,
    detail: string,
    continuationMessage = mission,
  ): void {
    if (task.summary.delivery?.final_mr) return;
    const receipt = this.activeFeedbackReceiptInstructions(task);
    task.mission = [mission, this.foreignCommitNotice(task), receipt]
      .filter(Boolean).join("\n\n");
    task.summary.status = "queued";
    task.summary.detail = detail;
    task.resume = true;
    if (task.retainedSession) task.retainedSession.message = [continuationMessage, this.foreignCommitNotice(task), receipt]
      .filter(Boolean).join("\n\n");
    this.persist(task);
    this.queue.push(task.summary.id);
    setImmediate(() => this.bypass(undefined, "任务泵", this.pump()));
  }

  private moonlightEnabledFor(task: TaskState, force = false): boolean {
    if (task.summary.approval_mode === "manual") return false;
    if (task.summary.approval_mode === "moonlight") return true;
    if (force) return true;
    return this.options.moonlight?.(task.summary.luban_account) ?? false;
  }

  /** 人工节点的"现成答案":有则自动交卷,没有才真等人。两个来源:
   * - **下单预选(交付方式)**:内核仍举卡(流程规则归内核,宿主不删
   *   它的问题),但答案用户下单时已给——卡上出现了用户选定的那个
   *   **内核选项**就把它交上去。这是送达用户早给的答案,不是宿主代做
   *   判断;对不上就退回真等人,fail-open 到人工;
   * - **月光模式**:用户显式开启免审批,其余问题一律代答"预授权放行,
   *   按最稳妥判断继续,理由写明供复盘"。
   * 混合卡(既有交付方式又有别的问题)只在月光开着时整卡交,否则等人。 */
  /** 工作台修复轮中途举卡(内核 hf_open/delivery_review 这类确认节点,或模型
   * 自造的"检视结果确认"):这是修复流程的内部节点,不是人的验收——人的验收
   * 只在最终推送卡上逐条点通过。原来逐条回执只在会话结束时读,卡开着时
   * 平台什么都不知道,只能让人点;人点"确认"又被"未闭环"拦下,只剩"需要
   * 调整"能点,Agent 白跑一轮(内网实锤 2026-09-04:9 条意见、Agent 说全
   * 闭环、面板却是锚点推断的字样;隔壁 Agent 的状态机分析)。现在:回执
   * 此刻已在盘上,先读先记;认得出"继续/确认"类选项就由平台自动交卷,
   * 回执缺口写进交卷说明,会话结束时那道补交仍然生效。认不出选项(真
   * 歧义题)、或还有别的未闭环意见(责任人草稿等)照旧留给人。 */
  private async workspaceReviewNodeAnswer(task: TaskState): Promise<{
    why: string;
    answers: Record<string, string>;
    notes: string;
  } | undefined> {
    const waiting = task.summary.waiting;
    const loop = task.summary.delivery?.loop;
    if (!waiting || loop?.kind !== "review" || loop.review_source !== "workspace"
        || !loop.workspace_review_recheck_required || loop.state !== "repairing") {
      return undefined;
    }
    if ([HOST_PUSH_CONFIRM_STEP, CLOUD_PUSH_CONFIRM_STEP, CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP,
      CLOUD_SPLIT_PROPOSAL_STEP].includes(waiting.step)) {
      return undefined;
    }
    // 澄清卡是 Agent 缺信息在问人,不是流程节点,平台不代答。
    if ((waiting.question as Record<string, unknown>)?.purpose === "clarification") {
      return undefined;
    }
    const questions = ((waiting.question as any)?.questions ?? []) as Array<{
      question?: string;
      options?: string[];
    }>;
    if (!questions.length) return undefined;
    if (this.unresolvedAnnotations(task)
        .some((item) => item.sent_via !== "review_repair")) {
      return undefined;
    }
    const closing = stepChoiceEffects(
      this.options.host?.kernelRoot,
      this.reviewContractStep(task, waiting),
    ).filter((effect) => effect.closesFeedback);
    const answers: Record<string, string> = {};
    for (const item of questions) {
      const options = item.options ?? [];
      // 先认内核契约里的关闭选项;模型自造的卡按措辞认"确认/继续"类,
      // 反向词一票否决。两者都认不出=真歧义题,整卡留给人。
      const chosen = options.find((option) => closing.some((effect) =>
        matchesStepChoice(effect, option)))
        ?? options.find((option) =>
          /通过|确认|同意|接受|继续|无需|无须|闭环/.test(option)
          && !/不通过|打回|退回|拒绝|修改|调整|返工|补充|歧义/.test(option));
      if (!chosen) return undefined;
      answers[String(item.question ?? "")] = chosen;
    }
    let receiptNote: string;
    try {
      const receipts = await this.consumeWorkspaceReviewReceipts(task);
      receiptNote = receipts.ok
        ? receipts.clarifications?.length
          ? `逐条回执已登记,${receipts.clarifications.length} 条需意见作者补充说明(已通知作者)`
          : "逐条回执已登记齐全"
        : `逐条回执尚未齐全(${receipts.detail ?? "缺回执"}),会话结束前必须补齐`;
    } catch (error) {
      receiptNote = `读取逐条回执失败:${String(error)}`;
    }
    this.persist(task);
    return {
      why: `工作台修复轮内部确认节点,${receiptNote}`,
      answers,
      notes: `系统自动交卷(工作台修复轮的内部确认节点;${receiptNote})。`
        + "这是 Agent 的执行回执：每条意见仍需任务责任人逐条处置，"
        + "全部闭环后责任人才能推送。",
    };
  }

  private autoAnswerFor(task: TaskState, forceMoonlight = false): {
    why: string;
    answers: Record<string, string>;
    notes: string;
  } | undefined {
    const waiting = task.summary.waiting;
    const questions = ((waiting?.question as any)?.questions ?? []) as Array<{
      question?: string;
      options?: string[];
    }>;
    if (!waiting || questions.length === 0) return undefined;
    // push 前确认卡是用户**显式开启**的"我要亲自看一眼",月光免审批
    // 不得代答它——两者都是用户意志,更具体的那个赢。
    // 拆分提议同理:拆不拆是责任人的一票,月光不代答。
    if (waiting.step === HOST_PUSH_CONFIRM_STEP
        || waiting.step === CLOUD_PUSH_CONFIRM_STEP
        || waiting.step === CLOUD_REQUIREMENT_ANALYSIS_CONFIRM_STEP
        || waiting.step === CLOUD_SPLIT_PROPOSAL_STEP) {
      return undefined;
    }
    // 分析单已确认拆单完毕,父会话再举的任何卡都不该到人(内网实锤:
    // task-5 确认后模型"好心"又举卡让人检视 task-6 的事——子任务有
    // 自己的检视闸,父单的活到确认就结束了)。整卡代答,催它收尾。
    const graph = task.summary.requirement_graph;
    if (this.isRequirementAnalysis(task) && graph?.stage === "confirmed"
        && graph.repositories.every((repository) => repository.task_id)) {
      const answers: Record<string, string> = {};
      for (const item of questions) {
        answers[String(item.question ?? "")] = item.options?.[0]
          ?? "拆分方案已确认，模块任务已生成（或已确认无需改动）；分析会话请收尾结束。";
      }
      return {
        why: "分析单已确认拆单,父会话不再举卡",
        answers,
        notes: "系统自动交卷(分析已确认,子任务各有检视闸),非人工答复",
      };
    }
    // 最终方案卡同时决定拆不拆分；月光模式不能替责任人同意 Agent 的建议。
    if (this.isRequirementGraphReviewWaiting(task, waiting)) return undefined;
    // 澄清卡(Agent 处理检视意见时缺信息,单独问人)只能由人答:月光免审批、
    // 下单预选都不代答——代答等于机器替人编造缺失的信息。
    if ((waiting.question as Record<string, unknown>)?.purpose === "clarification") {
      return undefined;
    }
    const moonlight = this.moonlightEnabledFor(task, forceMoonlight);
    const hasUnresolvedAnnotations = this.unresolvedAnnotations(task).length > 0;
    const contractStep = this.reviewContractStep(task, waiting);
    const effects = stepChoiceEffects(
      this.options.host?.kernelRoot,
      contractStep,
    );
    // 持续检视不会产生第二张配置单，因此这里只认首次下单的交付方式。
    // 返工若再次出现 workflow/config 卡，说明生命周期接线失效，应由
    // bootstrap fail-closed 暴露，而不是宿主偷偷代答掩盖。
    const lane = task.summary.lane;
    const localReviewConfig = contractStep === "config_confirm"
      && task.summary.delivery?.loop?.kind === "review"
      && task.summary.delivery.loop.review_source === "workspace"
      && task.summary.delivery.loop.state === "repairing";
    const reasons = new Set<string>();
    const answers: Record<string, string> = {};
    for (const item of questions) {
      const text = String(item.question ?? "");
      // 认卡不靠问题措辞,靠**选项**:内核举的卡里出现了用户下单时选
      // 的那一项,就是这张卡在问交付方式。此前按"车道"二字匹配,而内核
      // 的问题里根本没有这两个字(它问"交付方式?"),于是预选形同虚设
      // ——措辞是内核的自由,选项才是双方共用的语言。
      const preselected = lane
        ? (item.options ?? []).find((option) => option === lane
            || option.includes(lane))
        : undefined;
      if (preselected) {
        answers[text] = preselected;
        reasons.add(`下单预选交付方式:${lane}`);
      } else if (localReviewConfig) {
        // 工作台提交已经授权“继续修改当前 MR”，新 review 轮又完整沿用
        // 原单号/分支/需求事实，因此配置卡只是在重复确认同一份事实。
        // 只命中明确的肯定选项；形状漂移就退回人，不猜。
        const confirmed = (item.options ?? []).find((option) =>
          /确认.*(?:配置|以上)|配置.*(?:正确|无误)|全部.*(?:正确|无误)/
            .test(option)
          && !/修改|调整|错误|不正确|有误/.test(option));
        if (!confirmed) {
          this.options.log?.(
            `任务 ${task.summary.id} 本地检视轮配置卡缺少明确确认选项，退回人工`);
          return undefined;
        }
        answers[text] = confirmed;
        reasons.add("本地检视沿用原单已确认配置");
      } else if (moonlight) {
        // 有检视意见时绝不自动放行；开放题也必须由人明确填写。月光只
        // 能提交真实选项，不能再拿一段自由文本冒充内核分支值。
        if (hasUnresolvedAnnotations || !(item.options?.length)) {
          return undefined;
        }
        const closing = effects.filter((effect) => effect.closesFeedback);
        const chosen = item.options.find((option) => closing.some((effect) =>
          matchesStepChoice(effect, option)))
          ?? item.options.find((option) =>
            /通过|确认|同意|接受|批准|继续|无需|无须/.test(option)
            && !/不通过|打回|退回|拒绝|修改|调整|返工/.test(option));
        if (!chosen) {
          // 兜底选第一项曾在这里:选项顺序一变就可能替人选中"打回"
          // 之类的反向分支(2026-08-30 审计)。月光只代答认得出的
          // "通过"类选项;认不出=形状漂移,整卡退回人,不猜。
          this.options.log?.(
            `任务 ${task.summary.id} 月光模式认不出明确的通过类选项`
            + `(${(item.options ?? []).join("/")}),整卡退回等人`);
          return undefined;
        }
        answers[text] = chosen;
        reasons.add(`月光模式选择:${chosen}`);
      } else {
        // 答不上,整卡留给人。但有一种"答不上"必须留明账:问题**正文**
        // 里带着用户选的交付方式,选项里却没有——十有八九是模型自造了
        // "是否选择局部修改?"式的是/否卡(内网实测)。宿主不替内核判
        // 是/否算不算数,但要把"预答为什么没接住"写清楚,不然现场只看到
        // "又在等人",查不到为什么。
        if (lane && text.includes(lane)) {
          this.options.log?.(
            `任务 ${task.summary.id} 交付方式卡不是标准形状:问题提到`
            + `「${lane}」但选项(${(item.options ?? []).join("/")})里没有`
            + `它,预答无法命中,退回等人——多半是模型自造了是/否确认卡`);
        }
        return undefined; // 有答不上的问题,整卡留给人
      }
    }
    return {
      why: [...reasons].join(" + "),
      answers,
      notes: `系统自动交卷(${[...reasons].join(";")}),非人工现场答复；`
        + "已提交结构化选项，供事后人工复盘",
    };
  }

  /** 自动交卷:走人工决定同一条通路(decide),内核台账、事件、
   * 竞态语义一字不差;人若抢先答了(409/状态翻篇)就当没发生。 */
  private async autoDecide(
    task: TaskState,
    auto: { answers: Record<string, string>; notes: string },
  ): Promise<void> {
    const waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) return;
    try {
      const questions = (((waiting.question as any)?.questions ?? []) as Array<{
        question?: string;
        options?: string[];
      }>);
      const selectedOptions: Record<string, string> = {};
      const freeResponses: Record<string, string> = {};
      for (const question of questions) {
        const key = String(question.question ?? "");
        const answer = auto.answers[key];
        if (!answer) continue;
        if (question.options?.includes(answer)) selectedOptions[key] = answer;
        else freeResponses[key] = answer;
      }
      await this.decide(task.summary.id, {
        state_version: waiting.state_version,
        selected_options: selectedOptions,
        free_responses: freeResponses,
        comment: auto.notes,
      });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 自动交卷未生效(可能人已答): ${String(error)}`);
    }
  }

  previewMoonlight(account: string): {
    waiting: number;
    eligible: number;
    blocked_annotations: number;
    blocked_other: number;
  } {
    let waiting = 0;
    let eligible = 0;
    let blockedAnnotations = 0;
    for (const task of this.tasks.values()) {
      if (task.summary.status !== "waiting_for_human"
          || task.summary.luban_account !== account) continue;
      waiting += 1;
      if (this.unresolvedAnnotations(task).length) {
        blockedAnnotations += 1;
        continue;
      }
      if (this.autoAnswerFor(task, true)) eligible += 1;
    }
    return {
      waiting,
      eligible,
      blocked_annotations: blockedAnnotations,
      blocked_other: waiting - eligible - blockedAnnotations,
    };
  }

  /** push 前人工确认开关。普通确认可关闭；人工意见触发的复检属于
   * 意见闭环，不是偏好开关，不能靠关开关绕过。 */
  setPushConfirmation(id: string, on: boolean): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const status = task.summary.status;
    if (on && ["await_merge", "completed", "failed", "canceled"]
      .includes(status)) {
      throw new TaskControlError(
        `任务已${status === "await_merge" ? "推送" : "收口"},push 前确认点已经过去`);
    }
    const loop = task.summary.delivery?.loop;
    if (!on && loop?.review_source === "workspace"
        && loop.workspace_review_recheck_required) {
      throw new TaskControlError(
        "本轮修改来自人工检视意见，必须完成复检后才能推送；不能关闭确认绕过。",
      );
    }
    task.summary.push_confirmation = on || undefined;
    const waiting = task.summary.waiting;
    if (!on && waiting?.step === CLOUD_PUSH_CONFIRM_STEP) {
      task.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version,
        notes: "用户关闭 push 前确认,卡作废,继续推送",
      });
      task.summary.waiting = undefined;
      if (task.summary.delivery) delete task.summary.delivery.push_review;
      task.summary.status = "verifying";
      task.summary.detail = "已关闭 push 前确认,继续推送";
      this.bypass(task, "关闭确认续推",
        this.tryDeliver(task, task.controlEpoch));
    }
    this.persist(task);
    return { ...task.summary };
  }

  setTaskApprovalMode(
    id: string,
    mode: "inherit" | "manual" | "moonlight",
    includeCurrent = false,
  ): { task: TaskSummary; swept: number; blocked_annotations: number } {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    task.summary.approval_mode = mode === "inherit" ? undefined : mode;
    this.persist(task);
    const blockedAnnotations = this.unresolvedAnnotations(task).length;
    let swept = 0;
    if (mode === "moonlight" && includeCurrent
        && task.summary.status === "waiting_for_human"
        && !blockedAnnotations) {
      const auto = this.autoAnswerFor(task);
      if (auto) {
        swept = 1;
        void this.autoDecide(task, auto);
      }
    }
    return {
      task: { ...task.summary },
      swept,
      blocked_annotations: blockedAnnotations,
    };
  }

  /** 仅在调用方明确选择“同时处理当前待办”后清场。默认启用月光模式
   * 不会调用这里，因此只影响后续节点。 */
  sweepMoonlight(account: string): number {
    let swept = 0;
    for (const task of this.tasks.values()) {
      if (task.summary.status !== "waiting_for_human") continue;
      if (task.summary.luban_account !== account) continue;
      const auto = this.autoAnswerFor(task);
      if (auto) {
        swept += 1;
        void this.autoDecide(task, auto);
      }
    }
    return swept;
  }

  /** 待办 → 小鲁班。发送失败不改流程状态;结果回填 summary.notify
   * 供页面标红。未配置通知器或未填账号时静默跳过(演示模式)。 */
  private notifyWaiting(task: TaskState): void {
    const { notifier } = this.options;
    const waiting = task.summary.waiting;
    const account = task.summary.luban_account;
    if (!notifier || !waiting || !account) return;
    const questions = (((waiting.question as any)?.questions ?? []) as Array<{
      question?: string;
      options?: string[];
    }>).map((item): NotifyQuestion => ({
      question: String(item.question ?? ""),
      options: Array.isArray(item.options) ? item.options.map(String) : [],
    }));
    const subject = task.summary.title ?? task.summary.requirement;
    const clarifying = (waiting.question as Record<string, unknown>)?.purpose
      === "clarification";
    const deliver = (
      recipient: string, waitingId: string, stateVersion?: number,
    ) => notifier.notifyWaiting({
      waitingId,
      stateVersion,
      taskId: task.summary.id,
      subject,
      account: recipient,
      step: waiting.step,
      context: waiting.context,
      questions,
      summary: clarifying ? "Agent 处理检视意见时缺少信息,需要你补充" : "需要你确认",
      link: personalTaskLink(
        this.notificationLinkBase(),
        recipient,
        task.summary.id,
      ),
    });
    this.bypass(task, "待办通知",
      deliver(account, waiting.waiting_id, waiting.state_version)
        .then((record) => {
          task.notifyRecord = record;
          // 发送结果(尤其"没送到")要活过重启:不落盘的话,重启后页面
          // 红旗消失,"通知失败"从可见事实变成不可见事实(2026-08-29
          // 部署审计实锤)。写盘失败由 writeTaskState 自己记日志,纯旁路。
          this.writeTaskState(task);
        }));
    // 受邀参与讨论的人能回答分析期的问题卡,不通知等于邀请了不喊人。
    // 拍板类卡只认责任人,不扰。键按人分开:通知器按 waiting_id 幂等,
    // 复用同一个键第二个人永远收不到;不带 state_version——手机短码
    // 审批只给责任人,参与人在页面上答。页面上的通知红旗只跟责任人
    // 那条走,参与人的发送结果不覆盖它。
    if (this.ownerOnlyWaiting(waiting)) return;
    for (const participant of this.discussionParticipants(task)) {
      this.bypass(task, "讨论邀请通知",
        deliver(participant, `${waiting.waiting_id}#${participant}`));
    }
    // 澄清卡问的是意见作者:被追问的人不是责任人时也要喊到(他能在页面
    // 上答这张卡;答复权限见 server 的 canAnswerClarification)。
    if (clarifying) {
      for (const author of this.clarificationRespondents(task, waiting)) {
        if (author === account) continue;
        this.bypass(task, "追问作者通知",
          deliver(author, `${waiting.waiting_id}#${author}`));
      }
    }
  }

  /** 澄清卡追问的那些意见的作者——除责任人外,他们也能答这张卡。 */
  clarificationRespondents(task: TaskState, waiting: WaitingRecord): string[] {
    const question = (waiting.question ?? {}) as Record<string, unknown>;
    if (question.purpose !== "clarification") return [];
    const ids = new Set(Array.isArray(question.annotation_ids)
      ? question.annotation_ids.map(String) : []);
    if (!ids.size) return [];
    return [...new Set(this.annotations(task).list()
      .filter((item) => ids.has(item.id)).map((item) => item.author))];
  }

  /** HTTP 层问:这个人能不能答当前这张澄清卡(意见作者 ≠ 责任人的情形)。 */
  canAnswerClarification(id: string, username: string | undefined): boolean {
    const task = this.tasks.get(id);
    const waiting = task?.summary.waiting;
    if (!task || !waiting || !username) return false;
    return this.clarificationRespondents(task, waiting).includes(username);
  }

  private prepareHostGitSandbox(credential: { username: string; password: string } | undefined) {
    return new HostGitSandbox(this.options.dataDir, this.options.log).prepare(credential);
  }

  private cleanupHostGitCredential(prepared: { dir: string } | undefined): void {
    new HostGitSandbox(this.options.dataDir, this.options.log).cleanup(prepared);
  }

  /** 把 Coding Agent / 中心能力服务注入目录登记为当前 clone 的本地
   * 运行资产。只写 .git/info/exclude，不改业务仓 .gitignore；仓库原本
   * 已跟踪的 Skill 不受 exclude 影响，仍可按目录发现与读取。 */
  private registerAgentPlatformLocalExcludes(
    cwd: string,
    deliveryExcludedPaths: string[] = [],
  ): void {
    try {
      const view = createSafeGitView(cwd);
      const gitDir = view.repositoryGitDir;
      view.cleanup();
      const infoDir = join(gitDir, "info");
      if (!existsSync(infoDir)) mkdirSync(infoDir, { mode: 0o700 });
      const info = lstatSync(infoDir);
      if (!info.isDirectory() || info.isSymbolicLink()
          || realpathSync(infoDir) !== infoDir) {
        throw new Error("Git info 目录不是任务仓内的真实目录");
      }
      const excludePath = join(infoDir, "exclude");
      if (existsSync(excludePath)) {
        const exclude = lstatSync(excludePath);
        if (!exclude.isFile() || exclude.isSymbolicLink()
            || realpathSync(excludePath) !== excludePath) {
          throw new Error("Git 本地排除文件不是普通文件");
        }
      }
      const original = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
      const selection = [...this.tasks.values()].find(task => task.cwd === cwd)?.summary.delivery_selection;
      const current = removeLegacyDeliveryExcludes(original, normalizedDeliveryPaths([
        ...deliveryExcludedPaths, ...(selection?.paths ?? []), ...(selection?.excluded_paths ?? []),
      ]));
      const lines = new Set(current.split("\n").map((line) => line.trim()));
      const missing = [
        ...AGENT_PLATFORM_LOCAL_EXCLUDES,
        ...FLOW_RUNTIME_LOCAL_EXCLUDES,
        "docs/req/",
      ]
        .filter((entry) => !lines.has(entry));
      if (!missing.length && current === original) return;
      writeFileSync(excludePath,
        `${current}${current && !current.endsWith("\n") ? "\n" : ""}`
        + (missing.length ? "# mae-flow: local runtime assets\n" + missing.join("\n") + "\n" : ""));
    } catch (error) {
      // 本地 ignore 是第一道减噪，不是唯一安全边界；push 前提交历史
      // 仍会硬校验。这里说清楚但不阻塞任务启动。
      this.options.log?.(
        `[git-exclude] Agent 平台目录登记失败(推送硬闸仍生效): ${String(error)}`);
    }
  }

  /** 新任务和旧任务恢复都执行：清掉历史版本留在 agentDir / repo config
   * 的 helper，并把 origin pushurl 改成必失败地址。Agent 可以读写/提交，
   * 但拿不到凭据也无法传输；宿主 push 使用显式干净 URL，不走 pushurl。 */
  private hardenAgentGitBoundary(agentDir: string, cwd?: string): void {
    for (const name of ["git-credential", "git-credential.sh"]) {
      rmSync(join(agentDir, name), { force: true });
    }
    if (!cwd || !existsSync(join(cwd, ".git"))) return;
    const view = createSafeGitView(cwd);
    const configPath = join(view.repositoryGitDir, "config");
    view.cleanup();
    const configInfo = lstatSync(configPath);
    if (!configInfo.isFile() || configInfo.isSymbolicLink()
        || realpathSync(configPath) !== configPath) {
      throw new Error("Git config 不是任务仓内的普通文件，拒绝宿主改写");
    }
    // `git config --file` 不做仓库发现，也不读取 include；相比 --local /
    // `git remote`，不会触发 Agent 写入的 fsmonitor/filter/url.* 配置。
    const config = (...args: string[]) => spawnSync(
      "git", ["config", "--file", configPath, ...args], {
        encoding: "utf-8",
        env: safeGitEnvironment(),
      });
    config("--unset-all", "credential.helper");
    // clone 会照录带 userinfo 的 URL；即便部署误把 token 写进 repo_url，
    // 也必须在 Agent 进入前从 repo config 擦掉。
    const origin = config("--get", "remote.origin.url");
    const rawOrigin = String(origin.stdout ?? "").trim();
    if (origin.status === 0 && rawOrigin) {
      const cleanOrigin = this.cleanRemoteUrl(rawOrigin);
      if (cleanOrigin !== rawOrigin) {
        config("--replace-all", "remote.origin.url", cleanOrigin);
      }
    }
    const existingPush = config("--get-all", "remote.origin.pushurl");
    // 跨仓分析克隆已有更强的只读标记；不能用“宿主可推”的普通执行
    // 标记覆盖它。两者都指向 /dev/null，但语义必须保留下来供恢复和
    // 部署自检区分。
    if (!String(existingPush.stdout ?? "").includes("mae-flow-readonly")) {
      config("--replace-all", "remote.origin.pushurl",
        "/dev/null/mae-flow-host-owned");
    }
    this.registerAgentPlatformLocalExcludes(cwd);
  }

  private cleanRemoteUrl(raw: string): string {
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return raw;
    }
  }

  /** Agent 会话已释放后由宿主完成唯一一次传输，并立刻从远端反查 SHA。
   * 返回值既是 TaskSummary 现场，也是 `pipeline record` 的内核收据。 */
  private async readPushFileList(task: TaskState, branch: string, head: string): Promise<PushFileList> {
    const unavailable = (reason: string): PushFileList => ({ branch, head_sha: head, unavailable_reason: reason });
    if (!task.cwd) return unavailable("工作区不可读，暂时不能计算本次推送清单");
    let sandbox: ReturnType<TaskService["prepareHostGitSandbox"]> | undefined;
    try {
      const configured = task.summary.repo_url ?? this.effectiveDefaultRepo();
      if (!configured) return unavailable("未配置权威代码仓，暂时不能计算本次推送清单");
      validateRepositoryAddress(configured);
      if (!/^[a-z]:[\\/]/i.test(configured) && /^[a-z][a-z\d+.-]*:/i.test(configured)
          && !/^(?:https?|file):\/\//i.test(configured)) return unavailable("代码仓传输协议不受支持");
      const remote = /^(?:https?|file):\/\//i.test(configured) ? configured : resolve(configured);
      let target = task.summary.delivery?.target_branch ?? task.summary.baseline;
      try {
        const state = JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8"));
        target = task.summary.delivery?.target_branch ?? state.config?.["基线分支"] ?? target;
      } catch { /* 旧现场仍可使用任务保存的目标分支。 */ }
      sandbox = this.prepareHostGitSandbox(this.options.gitCredential?.(task.summary.luban_account));
      const sourceRef = `refs/heads/${branch}`, targetRef = target ? `refs/heads/${target}` : undefined;
      const observed = await runGitProcess([...sandbox.args, "ls-remote", "--heads", remote,
        sourceRef, ...(targetRef ? [targetRef] : [])], { timeoutMs: 30_000, env: sandbox.env });
      if (observed.status !== 0) return unavailable("远端分支查询失败，未把全量 MR 文件冒充本次增量");
      const refs = new Map(observed.stdout.trim().split(/\r?\n/).map(line => {
        const [sha, ref] = line.split(/\s+/); return [ref, sha];
      }));
      return await pendingPushFiles(task.cwd, branch, head, refs.get(sourceRef) ?? null, targetRef ? refs.get(targetRef) : undefined);
    } catch {
      return unavailable("本次推送差异读取失败，请查看代码改动；没有生成文件过滤或新的审批");
    } finally {
      if (sandbox) this.cleanupHostGitCredential(sandbox);
    }
  }

  private presentPushFileList(task: TaskState, manifest: PushFileList): void {
    // 只记展示事实；历史清单不成为下一次推送的授权或比较起点。
    const payload = { ...manifest };
    const driver = task.driver ?? task.retainedSession?.driver;
    if (driver) { driver.notePushFileList(payload); return; }
    const log = new EventLog(this.eventLogPath(task.summary.id), event => this.bypass(
      task, "记录推送清单", this.options.projection?.appendEvent(event)));
    log.append({ eventId: log.lastEventId() + 1, taskId: task.summary.id, sessionId: "main",
      ts: new Date().toISOString(), kind: "push_file_list", payload });
  }

  private async pushFromHost(task: TaskState, branch: string, expectedSha?: string): Promise<GitPushReceipt> {
    if (task.transportActive) throw new TaskControlError("已有宿主传输正在执行");
    const work = this.pushFromHostTransport(task, branch, expectedSha);
    task.transportActive = work;
    try { return await work; } finally { if (task.transportActive === work) task.transportActive = undefined; }
  }

  private async pushFromHostTransport(
    task: TaskState,
    branch: string,
    expectedSha?: string,
    metadataOnlySha?: string,
  ): Promise<GitPushReceipt> {
    if (task.driver) {
      throw new Error("安全拒绝：Agent 会话仍在，不能执行宿主 Git 推送");
    }
    if (!task.cwd) throw new Error("任务没有代码工作区，不能推送");
    const epoch = task.controlEpoch;
    const deliverySnapshot = await deliveryChangeSnapshot(task.cwd);
    if (!metadataOnlySha && deliverySnapshot?.added_agent_platform_paths.length) {
      throw new Error(
        "安全拒绝：待推送提交历史包含 Agent 平台本地目录 "
        + describeDirtyPaths(deliverySnapshot.added_agent_platform_paths));
    }
    // 交付目标是下单/部署事实，不是 Agent 可改的 remote.origin.url。
    // 无 scheme 的本地演示仓按服务进程 cwd 解析，避免切到临时 bare 仓
    // 后相对路径含义漂移。
    const configuredRemote = task.summary.repo_url
      ?? this.effectiveDefaultRepo();
    if (!configuredRemote) throw new Error("任务没有权威代码仓地址，拒绝推送");
    validateRepositoryAddress(configuredRemote);
    // Windows 盘符路径(C:\…)长得像 "scheme:" 会撞上下面的协议白名单
    // 正则——先按本地路径放行(2026-08-25 开发者模式通了 symlink 后,
    // 本机 Windows 首次真跑宿主推送时在这里被误杀)。
    const windowsDrive = /^[a-z]:[\\/]/i.test(configuredRemote);
    if (!windowsDrive
        && /^[a-z][a-z\d+.-]*:/i.test(configuredRemote)
        && !/^(?:https?|file):\/\//i.test(configuredRemote)) {
      throw new Error("代码仓传输协议不受支持，宿主只允许 HTTPS 或本地仓");
    }
    const remoteUrl = /^(?:https?|file):\/\//i.test(configuredRemote)
      ? configuredRemote : resolve(configuredRemote);
    const credential = this.options.gitCredential?.(
      task.summary.luban_account);
    const sandbox = this.prepareHostGitSandbox(credential);
    let gitView: ReturnType<typeof createSafeGitView> | undefined;
    const ref = `refs/heads/${branch}`;
    try {
      gitView = createSafeGitView(task.cwd);
      const transportGit = (
        args: string[], extraEnv?: NodeJS.ProcessEnv,
      ) => runGitProcess([...sandbox.args, ...args], {
          timeoutMs: 30_000,
          env: { ...sandbox.env, ...extraEnv },
        });
      const worktreeGit = (args: string[]) => runGitProcess(
        [...sandbox.args, ...args], {
          cwd: task.cwd,
          timeoutMs: 30_000,
          env: gitView!.environment(sandbox.env),
        });
      const checked = await transportGit(["check-ref-format", "--branch", branch]);
      if (checked.status !== 0) {
        throw new Error(`分支名不合法，拒绝推送: ${branch}`);
      }
      // 只从工作区读取要交付的对象/HEAD；传输在新建 bare 仓中进行，
      // 因而工作区 hooks、origin、url.*、protocol.*、helper 全部不生效。
      const head = await worktreeGit(["rev-parse", "--verify", "HEAD"]);
      const sha = metadataOnlySha ?? String(head.stdout ?? "").trim();
      if (head.status !== 0 || !sha) {
        throw new Error(`读取待推送 HEAD 失败: ${String(head.stderr ?? "")}`);
      }
      if (expectedSha && sha !== expectedSha) {
        throw new Error(
          `传输准备后 HEAD 从 ${expectedSha.slice(0, 12)} 变为 ${sha.slice(0, 12)}，`
          + "本次未发送；请刷新待推送提交后继续，已有文件范围确认保留");
      }
      // 提交说明属于编码指导，传输层只核对授权目标与真实 SHA。
      // 平台远端自身拒绝时仍如实回报，不在这里另设格式否决权。
      // 组件知识检查只观察不裁决(mode=observe)：它自身的任何故障都不能
      // 变成推送失败——旁路一律 fail-open,原因进日志。
      if (!metadataOnlySha) {
        try { await this.componentKnowledge(task)?.check({ target: sha, trigger: "mr" }); }
        catch (error) {
          this.options.log?.(`任务 ${task.summary.id} 组件知识检查未完成（不影响推送）：${String(error)}`);
        }
      }
      const objects = gitView.objectDirectory;
      const staging = join(sandbox.dir, "transport.git");
      const initialized = await transportGit(["init", "--quiet", "--bare", staging]);
      if (initialized.status !== 0) {
        throw new Error(`创建宿主传输仓失败: ${String(initialized.stderr ?? "")}`);
      }
      const objectEnv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
      const objectCheck = await transportGit([
        `--git-dir=${staging}`, "cat-file", "-e", `${sha}^{commit}`,
      ], objectEnv);
      if (objectCheck.status !== 0) {
        throw new Error("待推送 HEAD 不是可读取的提交对象");
      }
      const manifest = await this.readPushFileList(task, branch, sha);
      try { this.presentPushFileList(task, manifest); }
      catch (error) { this.options.log?.(`任务 ${task.summary.id} 推送清单记录失败：${String(error)}`); }
      if (this.shuttingDown || task.controlEpoch !== epoch || task.summary.status === "canceled"
          || (!metadataOnlySha && ticketCorrectionBlocks(task.summary.ticket_correction))) {
        throw new TaskControlError(task.summary.delivery?.waiting_on ?? "任务执行权已变化，未推送");
      }
      const pushed = await runGitProcess([
        ...sandbox.args, `--git-dir=${staging}`, "push", "--no-verify",
        ...(metadataOnlySha ? [`--force-with-lease=${ref}:`] : []),
        "--porcelain", remoteUrl, `${sha}:${ref}`,
      ], {
        timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
        env: { ...sandbox.env, ...objectEnv },
      });
      if (pushed.status !== 0) {
        if (!metadataOnlySha && rejectedByBranchAdvance(String(pushed.stdout ?? ""))) {
          throw new RemoteBranchAdvancedError("远端任务分支在同步后又有新提交，当前提交尚未推送；需要重新同步后再试");
        }
        const stderrText = pushed.timedOut
          ? `超过 ${GIT_TRANSFER_TIMEOUT_MS / 60_000} 分钟传输预算，已终止 git/ssh 进程组`
          : String(pushed.stderr || pushed.stdout || pushed.error);
        throw new Error(`宿主推送失败: ${stderrText}`);
      }
      const verified = await runGitProcess([
        ...sandbox.args, `--git-dir=${staging}`,
        "ls-remote", "--heads", remoteUrl, ref,
      ], {
        timeoutMs: 60_000,
        env: sandbox.env,
      });
      const remoteSha = String(verified.stdout ?? "").trim().split(/\s+/)[0];
      let included = verified.status === 0 && remoteSha === sha;
      if (!included && verified.status === 0 && /^[a-f0-9]{40,64}$/i.test(remoteSha)) {
        // 推送成功后别人又追加了提交，不应把真实成功误报为失败并重复推送。
        const fetched = await transportGit([`--git-dir=${staging}`, "fetch", "--no-tags", "--no-recurse-submodules",
          remoteUrl, `+${ref}:refs/heads/observed`], objectEnv);
        included = fetched.status === 0 && (await transportGit([`--git-dir=${staging}`,
          "merge-base", "--is-ancestor", sha, "refs/heads/observed"], objectEnv)).status === 0;
      }
      if (!included) {
        throw new Error(
          `远端 SHA 复核失败: 本地 ${sha.slice(0, 12)}，远端 `
          + `${remoteSha ? remoteSha.slice(0, 12) : "缺失"}`);
      }
      await publishGitAiNotes({ cwd: task.cwd, sha, remote: remoteUrl, staging,
        args: sandbox.args, env: { ...sandbox.env, ...objectEnv }, log: this.options.log });
      return { sha, ref, remote: "origin", url: this.cleanRemoteUrl(remoteUrl) };
    } finally {
      gitView?.cleanup();
      this.cleanupHostGitCredential(sandbox);
    }
  }

  private requirementStoryTemplate(): string {
    const relative = "skills/mae-flow/assets/STORY-TEMPLATE.md";
    for (const root of [this.options.host?.kernelRoot, discoverKernelRoot(resolve(process.cwd()))]) {
      if (root && existsSync(join(root, relative))) return readFileSync(join(root, relative), "utf-8");
    }
    throw new TaskControlError("未找到原 Story 模板，请检查内核安装路径");
  }

  private requirementAnalysisPrompt(
    task: TaskState,
    cwd: string,
    requirementPath?: string,
  ): string {
    const ticket = task.summary.ticket ?? task.summary.id;
    // 第一列是仓库名不是序号:模型会照抄第一列去提问、写方案,序号落到
    // 卡上人看不出是哪个仓(内网实锤 2026-09-04)。机读图按 url 照录,
    // 序号在这里没有任何用处,不再出现。
    const repositories = this.analysisRepositoryNames(task).map(({ name }, index) => {
      const url = task.summary.repositories![index];
      const path = join(cwd,
        `${index + 1}-${basename(url).replace(/\.git$/, "") || "repo"}`);
      return `- ${name} | ${url} | ${path}`;
    }).join("\n");
    const artifactDir = join(cwd, ".mae-flow-work", ticket);
    return [
      `需求原文:\n${requirementContext(
        task.summary.requirement,
        task.summary.requirement_document,
        requirementPath,
      )}`,
      // 措辞纠偏:这是**平台的**跨仓分析前置阶段,不是内核流程——
      // 内核的交付流程(init/配置确认/门禁/MR)在确认后的各仓子任务里
      // 才开始,别让模型以为此刻该跑 mae-flow 命令。
      `你正在执行云端平台的需求分析(交付前置阶段):把一个需求的职责`
        + `与依赖理清楚,拆成可分工的**交付单元**(一个单元=一个仓里的`
        + `一个功能模块（含自身实现与测试），或必要的公共准备单元),供人检视确认；一个单元即可完成时不拆子任务。注意:此阶段**不在`
        + ` Mae-Flow 内核流程里**,不要执行任何 mae-flow 命令;各单元的`
        + `正式交付流程由内核主导：单个单元在原任务继续，多个单元才分别建子任务。此阶段`
        + `只读分析,禁止修改业务代码、提交或启动交付;工作区已在 git`
        + ` 配置层禁用推送,push 必然失败。`,
      `仓库清单（仓库名 | 原始地址 | 本地只读分析路径）:\n${repositories}`,
      "称呼仓库一律用仓库名(清单第一列):提问、方案、图和清单里都不要写"
        + " repo-1/repo-2 这类序号——人看不懂序号指的是哪个仓;本地目录名"
        + "也只是路径,不当称呼。",
      // 从直接开发转过来的单子:上一位 Agent 读完仓的判断是起点,不是
      // 结论——澄清与划分方向卡照走,不许照单全收。
      ...(task.summary.split_escalation ? [
        `背景:这单原本是单仓直接开发任务,上一位 Agent${
          task.summary.split_escalation.phase
            ? `在「${task.summary.split_escalation.phase}」阶段` : ""
        }读完仓后结合需求和模块边界提议拆分。它的理由:${
          task.summary.split_escalation.reason}${
          task.summary.split_escalation.suggested_units?.length
            ? `\n它建议的切法:\n${task.summary.split_escalation.suggested_units
                .map((unit, index) => `${index + 1}. ${unit}`).join("\n")}`
            : ""
        }\n以此为起点，仍须核实是否需要拆分；改动面要自己`
        + `重新核实,切法可以推翻。`,
      ] : []),
      materializeAnalysisDecisions(task.summary.workspace, artifactDir),
      "第一步:澄清(你的第一责任,相当于把需求评审会开完)。"
        + "请亲自阅读各仓代码,从关键词、接口调用链、配置路由三条路径核查。"
        + "每个触点必须给出仓库、文件、符号、相关原因和置信度。"
        + "事实自己查,决定才问人:凡是读代码/查文件能确定的,不许拿去"
        + "问用户;拿不准的**决定**用 AskUserQuestion 按批次提问——把当前"
        + "已具备前提、可以立刻回答的问题凑成一批一次问完,每题给出你的"
        + "建议答案;答案会解锁新的问题,再问下一批。"
        + "逐题确认单元职责、接口形态/字段/错误语义,以及依赖方向。"
        + "对每个新增或变化的数据逐项追清生产者、转换者、消费者和责任系统;"
        + "若生产者在仓库清单之外,也必须在最终拆单前问清外部系统与回流方式。"
        + "每个字段和事件都要有明确的产生方。"
        + "澄清的收口标准:**每一条已识别的不确定事项都有结论**——用户答了,"
        + "或明确记录「按 X 假设处理,已经用户确认」。方案里每一项都必须"
        + "有定论,出现待定/TBD 即不合格。",
      "第二步:改动面盘点。澄清收口后,列出这个需求实际要动的全部位置:"
        + "存量触点(要改哪些既有文件/类,逐个列)+ 新增规划(要新建哪些"
        + "模块/目录,各自职责)+ 接缝清单(纯新增也逃不掉的既有文件触点:"
        + "路由注册、启动装配、构建文件、测试依赖、资源文件、DB migration"
        + " 等全局单点)。必须沿运行链路和构建链路各走一遍:方案职责或"
        + "验收里点名的调用点、装配点、模块 pom/build 文件和测试依赖都要"
        + "进入盘点,不能只盘新增源码目录。对下单选择的**每个候选仓**"
        + "分别写出『需要修改』或『无需修改』及代码证据；候选仓只是排查"
        + "范围，绝不能因为被选中就默认生成任务。无需修改的仓保留结论，"
        + "但不得进入交付单元。",
      "第三步:形成拆分建议。一个完整交付单元即可完成时，建议不拆分并说明理由；确需多个独立交付单元时，把改动面盘点用"
        + " AskUserQuestion 摆给用户，讨论职责边界和真实依赖，"
        + "并给出你建议的切法;用户可以给方向、指定某块归谁,也可以答"
        + "「你看着切」。这一步是讨论，不代替责任人在最终方案卡上决定拆不拆。"
        + "协作者可能在这张卡上批注插话,他们的意见随决定一起到达,必须逐条消化。",
      "第四步:生成全局 Story 并划分交付单元。整体分析、按仓组织交付，仓内根据功能边界和真实依赖决定粒度。",
      DELIVERY_SPLIT_GUIDANCE,
      `沿用原 Story 模板，保留既有章节编号、自检表和结构，不追加 CHAIN 或流程附录。模板：\n${
        this.requirementStoryTemplate()}`,
      "4+1 是主任务分析的核心：客户场景与验收贯通全需求；逻辑模型含功能模块、关键类图和仓库/组件映射；"
        + "接口与数据模型明确跨模块契约；运行视图包含关键时序、异常/并发协作及部署关系。"
        + "关键类、接口、模块职责和场景必须相互对应，足以指导公共骨架及后续实现；不要求画完所有私有细节，"
        + "沿用架构说明依据，不以图数凑完整。图使用 PlantUML。MST 就是模块 UT，不是额外测试层级。"
        + "主任务 Story 在现有测试设计表中用“用例级别”区分函数 UT 与模块 UT（MST），不新增章节；按模块列出可检视的用例编号、被测入口、条件、操作、预期，以及内部真实执行和外部替身边界；"
        + "不能只写后续由子任务补充。子任务 Spec 承接这些场景并细化函数 UT，不新增全局 Spec。尚未执行的自检项如实保留。",
      STORY_ARCHITECTURE_GUIDANCE,
      SEMANTIC_ARCHITECTURE_GUIDANCE.replace("architecture.semantic.json",
        join(artifactDir, "architecture.semantic.json")),
      `将唯一全局设计写到 ${join(artifactDir, "story.md")}；不再生成独立 CHAIN 文档。`
        + "第一行保留不可见的 <!-- mae-flow-plan-revision: r1 --> 修订标记，返工换新修订。"
        + "需求理解、已确认行为和设计结论归入模板已有章节；仓库排查证据、任务分工与启动提示写入机读投影。"
        + "Story 可随开发更新；重要职责或接口变化说明影响，由责任人判断，不把旧设计快照当作永久约束。",
      `同时将建单投影写到 ${join(artifactDir, "requirement-graph.json")}，`
        + "在 Story 最终写完后计算真实字节 SHA-256；格式："
        + `{"plan_revision":"r1","story_sha256":"64位十六进制摘要",`
        + `"repository_assessments":[${REQUIREMENT_ASSESSMENT_EXAMPLE}],`
        + `"repositories":[${REQUIREMENT_UNIT_EXAMPLE}],"dependencies":[]}。`
        + "这是字段格式示例，不是让你填写字面占位值。outcome 只能写 change_required 或 no_change，"
        + "不得自创字段名或 in_scope/out_of_scope 等枚举；有多个候选仓或交付单元时按相同结构追加。"
        + "没有硬依赖时 dependencies 写空数组；有真实依赖时每项写 dependent、prerequisite 和 reason。"
        + "responsibility 用一句通俗的话说明本模块做什么，完整职责、验收、接口和启动命令保留在 Story。"
        + "每个候选仓恰好一条排查结论；无需修改仓不建单，需要修改仓至少一个模块。"
        + "id 唯一、仓地址照录。scope.name 使用简短业务模块名称，不堆砌实现术语；依赖 reason 用一句话解释必须等什么，不复制技术契约。scope.paths 只是可选参考路径，可为空或省略，"
        + "Story 的模块职责表以交付单元 id 为第一列，每个模块独占一行，便于从分工卡定位到详细说明；详细设计仍按既有模板展开。"
        + "不是允许修改的白名单；不因计划外文件要求放行。局部兼容调整可自主完成并说明，影响验收或其他模块时优先沟通。"
        + "dependencies 只写确实必须等待前置交付的边；只有契约依赖、可以基于替身先做的关系写入 Story，"
        + "不要全部转换成合入等待。没有硬依赖写空数组，不允许执行依赖循环；同仓也只按真实依赖安排执行；先最小公共基础、再独立模块并行，不要仅因同仓添加依赖。边界不清时先解决不确定性或说明具体等待原因。"
        + "平台沿用现有版本和摘要一致性检查；送审后修改须换修订并同步两份产物，不新增 hook 或测试用例门禁。",
      "方案写完后必须调用 AskUserQuestion。问题原文要明确写出建议拆分或不拆分、理由和拟定的交付边界，"
        + "请责任人决定是否同意；不同意时可以要求改为拆分、不拆分或调整边界，按意见修订同一份方案。"
        + "确认卡只提供两个选项：「需要修改」和「确认方案」；不要同时列出其它确认措辞。"
        + "平台会按交付单元数决定是在本任务继续开发、生成模块任务还是结束分析。用户选择需要修改时，"
        + "结合随决定提交的批注"
        + "继续修订同一份方案，再次发起检视；确认前不得收尾。"
        + "用户确认后：平台会结束本次分析会话；一个单元由原任务接续开发，多个单元才生成子任务，无改动时直接结束。后续执行"
        + "**不归你跟进**"
        + "——写一段简短收尾说明后立即结束，禁止再调用 AskUserQuestion、"
        + "禁止替用户检视或跟进任何子任务。",
    ].join("\n\n");
  }

  private async cloneRepo(
    workspace: string,
    sandbox?: { helper?: string; args: string[]; env: NodeJS.ProcessEnv },
    identity?: { username: string; email?: string },
    repoUrl?: string,
    /** 下单时明确的代码基线。新克隆必须直接检出它，不能先落到远端
     * 默认分支再让后续流程纠正：仓内 Skill 会在内核 bootstrap 前
     * 物化，错一拍就会把“已选择”变成 digest 不符而静默跳过。 */
    baseline?: string,
    targetName?: string,
    /** 分析现场禁用 push，辅助仓另以只读卷挂载。 */
    readonly = false,
    shallow = false,
  ): Promise<string> {
    // 任务级仓(正式下单)> 部署 --repo(仅单仓试跑);都没有就如实失败，
    // 不猜一个仓出来。任务仓记在 summary，重启续跑仍使用同一地址。
    const source = repoUrl ?? this.effectiveDefaultRepo();
    if (!source) {
      throw new Error(
        "这单没有代码仓：请在发起任务时填写「交付代码仓」");
    }
    const checkoutBaseline = baseline?.trim() || undefined;
    if (checkoutBaseline && (checkoutBaseline.length > 255
        || checkoutBaseline.startsWith("-")
        || /[\0\r\n\s\\]/.test(checkoutBaseline))) {
      throw new Error(`基线分支格式不合法，无法克隆：${checkoutBaseline}`);
    }
    // 裸仓 origin.git → 工作区目录名去掉 .git 后缀,免得像个裸仓。
    const target = join(
      workspace, targetName ?? (basename(source).replace(/\.git$/, "") || "repo"));
    // 普通仓有 .git 子目录;裸仓自己就是 git 目录(HEAD+objects)。
    // 只认 .git 会把裸仓误判成普通目录,把仓库内脏拷贝成"工作区"(实测)。
    const isGit = existsSync(join(source, ".git"))
      || (existsSync(join(source, "HEAD"))
          && existsSync(join(source, "objects")));
    // 凭据只对 http(s) 远端有意义;本地路径克隆(演示/试跑)不掺和。
    const useCredential = !!sandbox?.helper && /^https?:\/\//i.test(source);
    if (isGit || /^(?:https?|ssh|git|file):\/\//i.test(source)) {
      // 空 helper 在前=清空继承的 helper 列表(系统钥匙串之流):
      // 个人令牌只从我们的脚本来,也不许被别的 helper 顺手存走
      // (git 会对列表里所有 helper 广播 store——实测令牌进过
      // macOS 钥匙串,测试负例因此假绿)。没有个人凭据时不动列表,
      // 部署机自己的服务账号 helper 照常工作。
      //
      // 带个人令牌时还必须走 push/ls-remote 同一套加固沙箱。理由是
      // 我们的 helper 是"问什么都答"的——它不看 git 传进来的 host。
      // 部署机 ~/.gitconfig 或 /etc/gitconfig 里一条
      // `url.<别处>.insteadOf` 就能把这次 clone 改道到另一台主机,
      // 而 helper 会照样把用户的个人 CodeHub 令牌交出去。沙箱把
      // HOME/全局/系统配置全部换成空的,改道的配置来源就不存在了;
      // 顺带关掉 ext 传输、仓库 hooks 与交互式 askpass。
      const hardened = useCredential ? sandbox! : undefined;
      // 异步 + 预算(2026-08-25 卡死事故的同病类):同步克隆内网大仓
      // 会把整个事件循环冻住几分钟——每发起一单,全站页面/SSE/审批
      // 全部无响应。runGitProcess 超时杀整个进程组,ssh/credential
      // 子进程不残留。
      const cloned = await runGitProcess(
        [
          ...(hardened
            ? [...hardened.args,
               "-c", "credential.helper=",
               "-c", `credential.helper=${hardened.helper}`]
            : []),
          // --no-local:本地路径 clone 默认 hardlink 复用 .git/objects,
          // 任务对象与源仓/兄弟任务共享 inode——任务 cwd 又整目录 RW
          // bind 进容器,任务侧 chmod/truncate 直接打在源仓对象上
          // (e2e-picky-20260830 实锤:任务对象 nlink=2452,容器内
          // mmap EACCES)。URL 仓不受此 flag 影响,统一加无副作用。
          "clone", "--quiet", "--no-local",
          ...(shallow ? ["--depth", "1"] : []),
          ...(checkoutBaseline ? ["--branch", checkoutBaseline] : []),
          "--", source, target,
        ],
        {
          timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
          // 子进程没有终端,git 想问密码只会把任务挂死——明令禁问,
          // 缺凭据就地失败,错误如实上浮(不卡死红线)。
          env: hardened
            ? { ...hardened.env, GIT_TERMINAL_PROMPT: "0" }
            : { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      if (cloned.status !== 0) {
        const detail = cloned.timedOut
          ? "克隆超过 30 分钟已终止"
          : String(cloned.stderr || cloned.error || "").trim().slice(0, 500);
        if (checkoutBaseline) {
          throw new Error(
            `仓库克隆失败：代码仓基线「${checkoutBaseline}」不存在或不可访问`
            + (detail ? `：${detail}` : ""));
        }
        throw new Error(`仓库克隆失败${detail ? `：${detail}` : ""}`);
      }
    } else {
      cpSync(source, target, {
        recursive: true,
        filter: (path) => !path.includes(".mae-flow-work")
          && !path.endsWith(".mae-flow.json"),
      });
    }
    // clone 一落地就登记，早于任何 Agent 会话和构建预热。中心服务随后
    // 往这些目录注入 Skill 时，普通 `git add .` 天然看不见它们。
    if (existsSync(join(target, ".git"))) {
      this.registerAgentPlatformLocalExcludes(target);
    }
    // 只读现场的推送硬禁用:pushurl 指向必然不存在的路径,git push
    // 走到传输层就死,与是否配了 helper 无关(本地路径克隆连凭据都
    // 不需要,所以只拦 helper 拦不住)。fetch/log/grep 一概不受影响。
    if (readonly && existsSync(join(target, ".git"))) {
      await runGitProcess(
        ["config", "remote.origin.pushurl", "/dev/null/mae-flow-readonly"],
        { cwd: target, timeoutMs: 30_000 });
    }
    // 每次克隆写入个人署名；复用旧克隆时也刷新，个人邮箱更新不必重新拉仓。
    if (existsSync(join(target, ".git"))) await applyGitCommitIdentity(target, identity);
    return target;
  }

  /** 自动修复停下(halted/exhausted)→ 小鲁班。这是修复环里唯一
   * 真正需要人的时刻,必须主动喊人,不能等人自己来看页面。
   * 幂等键带 loop 状态,与早先发过的"验证中"收口通知不同键——
   * 那条说的是"机器在干活",这条说的是"机器干不动了,该你了"。 */
  private notifyRepairStopped(task: TaskState): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    const loop = task.summary.delivery?.loop;
    if (!notifier || !account || !loop) return;
    const why = loop.state === "halted"
      ? (loop.diagnosis
          ? `修复会话判断需人工处理:${loop.diagnosis.slice(0, 200)}`
          : "修复会话未产生新提交,请人工查看流水线日志")
      : `${loop.max} 轮修复预算用完,流水线仍红` + (loop.diagnosis ? `；最近会话记录:${loop.diagnosis.slice(0, 200)}` : "");
    this.bypass(task, "修复停摆通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `repair_${loop.state}`,
      summary: `流水线自动修复已停,需要你介入——${why}`,
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  /** Agent 已按人工意见完成修改且 Build-Fix 收敛：把逐条处置待办发给
   * 当前任务责任人。通知只负责提醒，权威状态仍
   * 是批注账 + 最终确认卡；失败不会阻塞任务，恢复重放也不会重复发。 */
  private notifyWorkspaceReviewReady(task: TaskState, sha: string): void {
    const notifier = this.options.notifier;
    const owner = task.summary.luban_account;
    const loop = task.summary.delivery?.loop;
    if (!notifier || !owner || loop?.review_source !== "workspace"
        || !loop.workspace_review_recheck_required) return;
    const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
    const pending = this.annotations(task).list().filter((item) =>
      wanted.has(item.id)
      && (item.status === "draft" || item.status === "sent"));
    const recipients = new Map([[owner, pending.length]]);
    const revisionKey = createHash("sha256")
      .update(`${loop.review_ids ?? "workspace"}:${sha}`)
      .digest("hex").slice(0, 20);
    for (const [account, count] of recipients) {
      const summary = count
        ? `Agent 已处理本轮 ${count} 条检视意见，Build-Fix 已通过。请打开任务核对最新代码及回执，逐条确认处置结果；未全部闭环前不会推送。`
        : "Agent 已按本轮整体检视意见完成修改，Build-Fix 已通过。请打开任务复检最终代码；确认前不会推送。";
      this.bypass(task, `邀请 ${account} 复检`, notifier.notifyReviewReady({
        taskId: task.summary.id,
        senderAccount: owner,
        account,
        summary,
        link: personalTaskLink(
          this.notificationLinkBase(), account, task.summary.id),
        revisionKey,
      }));
    }
  }

  /** 任务收口 → 小鲁班(说人话)。语义同待办通知:失败不改流程,
   * 同任务同状态幂等。没配通知器或没填账号静默跳过。 */
  private notifyOutcome(task: TaskState): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    if (!notifier || !account) return;
    const { status, delivery, detail, id } = task.summary;
    const text: Record<string, string> = {
      await_merge: `已提合入请求,流水线通过,等待合入`
        + (delivery?.mr_url ? `:${delivery.mr_url}` : ""),
      verifying: "代码已提交,流水线验证中",
      completed: "已完成"
        + (delivery?.skipped ? `(${delivery.skipped})` : ""),
      failed: `出错了:${detail || "原因见任务页"}`,
    };
    if (!text[status]) return;
    this.bypass(task, "收口通知", notifier.notifyOutcome({
      taskId: id,
      account,
      status,
      summary: text[status],
      link: personalTaskLink(this.notificationLinkBase(), account, id),
    }));
  }

  /** 压缩锚点:内核状态文件的 current/config 原文;没有内核现场
   * 就退到需求原话——锚永远来自权威,不由云端编造。 */
  private kernelAnchor(task: TaskState): string {
    try {
      const statePath = join(task.cwd ?? "", ".mae-flow.json");
      if (task.cwd && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        return `内核当前步骤: ${state.current}\n`
          + `已确认配置: ${JSON.stringify(state.config ?? {})}\n`
          + `需求: ${requirementContext(
            task.summary.requirement,
            task.summary.requirement_document,
            AGENT_REQUIREMENT_DOCUMENT,
          )}`;
      }
    } catch {
      // 读不到就用需求兜底,不为锚编内容。
    }
    return `需求: ${requirementContext(
      task.summary.requirement,
      task.summary.requirement_document,
      AGENT_REQUIREMENT_DOCUMENT,
    )}`;
  }

  /** 内核视角的"本轮 Agent 工作还没走完":未到宿主等待态或 end；状态文件不存在=
   * 连 init 都没走(run4 实测:空转回合把未 init 的任务标成 completed),
   * 同样算卡壳。非内核模式(无 host)不判——演练剧本自己收口。 */
  private stalledStep(task: TaskState): string | undefined {
    // 需求分析是 Cloud 的前置流程，没有内核状态。把“没有
    // .mae-flow.json”解释成“尚未 init”会直接把分析单串进开发流程。
    if (!this.options.host || !task.cwd || this.isRequirementAnalysis(task)) {
      return undefined;
    }
    return stalledKernelStep(task.cwd);
  }

  /** 升级前 Cloud 自己曾把分析任务误催进 init。只修复同时满足三项的
   * 窄事故形态：分析单、候选仓出现未跟踪内核状态、当前又在问内核配置。
   * 正常的需求澄清卡和仓库自带的受控文件都不会被碰。 */
  private recoverMisroutedRequirementAnalysisWaiting(
    task: TaskState,
    waiting: WaitingRecord | undefined,
  ): boolean {
    if (!waiting || waiting.status !== "waiting"
        || task.summary.status !== "waiting_for_human"
        || !this.isRequirementAnalysis(task) || !task.cwd
        || this.isRequirementGraphReviewWaiting(task, waiting)) {
      return false;
    }
    const question = JSON.stringify(waiting.question ?? {});
    if (!/(?:配置确认|交付方式|基线分支|工号|单号)/.test(question)) {
      return false;
    }
    const polluted: string[] = [];
    for (const [index, repository] of
      (task.summary.repositories ?? []).entries()) {
      const repo = join(task.cwd,
        `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`);
      for (const name of [
        ".mae-flow.json", ".mae-flow.json.exited", ".mae-flow-history.jsonl",
      ]) {
        const path = join(repo, name);
        if (!existsSync(path)) continue;
        const tracked = spawnSync("git", ["-C", repo, "ls-files", "--error-unmatch", name],
          { stdio: "ignore" }).status === 0;
        if (!tracked) polluted.push(path);
      }
    }
    if (!polluted.length) return false;
    const superseded = task.humanGate.supersede(waiting.waiting_id, {
      stateVersion: waiting.state_version,
      notes: "平台升级自动撤销：需求分析被错误引导进入了内核配置流程",
    });
    for (const path of polluted) rmSync(path, { force: true });
    task.pendingResume = {
      ...superseded,
      status: "resolved",
      decision: "这张内核配置问题由平台误触发，现已撤销；不要回答或继续内核流程。",
      notes: "请读取现有全局 Story（旧现场可读 CHAIN）与 requirement-graph.json，从当前需求分析现场继续，"
        + "完成后发起拆分方案确认卡。",
    };
    task.summary.waiting = undefined;
    task.summary.status = "queued";
    task.summary.detail = "已撤销误触发的内核配置问题，正从现有需求分析现场继续";
    task.resume = true;
    this.persist(task);
    this.options.log?.(
      `任务 ${task.summary.id} 已自愈分析流程串线，清理 ${polluted.length} 个未跟踪内核状态文件`);
    return true;
  }

  private atExternalVerificationWait(task: TaskState): boolean {
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      return existsSync(statePath)
        && String(JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "")
          === "external_verify";
    } catch {
      return false;
    }
  }

  private atHostDeliveryWait(task: TaskState): boolean {
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) return false;
      const current = String(
        JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "");
      return current === "external_verify"
        || current === "delivery_watch"
        || current === "end";
    } catch {
      return false;
    }
  }

  /** 旁路的即发即忘统一走这里:**抛了就记账,绝不带走进程**。
   *
   * `void 某个异步旁路()` 是本仓的常用写法(通知、投影、流水线轮询、
   * 合入监控、容器清理),但 Node 从 15 起未处理的 rejection 默认终止
   * 进程——于是"PG 抖一下""docker 没了""平台 502"这类旁路故障,后果
   * 是整台服务连着所有在跑的任务一起没。红线写得很清楚:旁路一律
   * fail-open。这个壳子就是那条红线在代码里的落点,别再裸 void。 */
  private bypass(
    task: TaskState | undefined,
    what: string,
    work: Promise<unknown> | undefined,
  ): void {
    if (!work) return;
    void work.catch((error) => {
      const who = task ? `任务 ${task.summary.id} ` : "";
      this.options.log?.(
        `${who}旁路「${what}」出错(fail-open,流程照走): ${String(error)}`);
    });
  }

  /** outcome → 任务状态。等待人工不占并发额度之外的资源,会话原地挂起。
   *
   * **一整条链都在 try 里**,这不是防御性编程的洁癖:decide 那头是
   * `void this.settle(...)`——人点了"通过",模型跑一轮,这条链上任何
   * 一处抛异常都是一个没人接的 Promise,Node 默认直接杀进程。内网反复
   * 报的"serve 莫名其妙挂了、一点错误输出都没有",症状(人工审批通过、
   * 模型跑完一轮后进程退出)与它严丝合缝。
   *
   * 进程级兜底(serve 的 guardProcess)拦得住"死",拦不住"哑":异常
   * 被吞了,任务会永远停在 running,人在页面上等一个不会来的结果。所以
   * 这里如实收口——任务 failed,原因写进 detail,通知照发。 */
  private async settle(
    task: TaskState,
    turn: Promise<Outcome>,
    epoch = task.controlEpoch,
  ): Promise<void> {
    try {
      await this.settleTurn(task, turn, epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      const driver = task.driver;
      if (task.driver === driver) task.driver = undefined;
      driver?.dispose();
      const cleanupFailure = await this.stopTaskContainer(task, "收口异常后");
      if (!this.current(task, epoch)) return;
      task.summary.status = "failed";
      task.summary.detail = `本轮收口时出错: ${String(error)}`
        + (cleanupFailure ? `；${cleanupFailure}` : "");
      this.persist(task);
      this.notifyOutcome(task);
      this.options.log?.(
        `任务 ${task.summary.id} 收口时抛异常(任务如实 failed,服务继续): `
        + String(error));
    } finally {
      if (task.retainedSession && (!this.current(task, task.retainedSession.epoch)
          || !["queued", "running", "waiting_for_human"].includes(task.summary.status))) {
        discardRetainedSession(task);
      }
    }
  }

  private async settleTurn(
    task: TaskState,
    turn: Promise<Outcome>,
    epoch = task.controlEpoch,
  ): Promise<void> {
    const outcome = await turn;
    if (!this.current(task, epoch)) return;
    switch (outcome.status) {
      case "waiting_for_human": {
        task.summary.waiting = outcome.waiting;
        if (task.summary.status === "pausing") {
          await this.finishPause(task, "waiting_for_human");
          break;
        }
        task.summary.status = "waiting_for_human";
        task.summary.detail = waitingTaskDetail(outcome.waiting);
        // 文件写完并真正举出最终方案卡，才锁定这轮给人看的版本。
        // 放在 persist 前，确保服务一旦重启仍记得检视对象是哪一份。
        this.sealRequirementGraphReview(task, outcome.waiting);
        // 人工节点=流程真实活动,催办账本清零:答复之后若再停在
        // 同名步骤,那是新一次卡壳,应当再催。
        task.nudgedStep = undefined;
        this.persist(task);
        // 先看有没有现成答案(下单预选/月光模式):有就自动交卷,
        // 不通知不打扰;没有才是真·等人。setImmediate 让本轮 settle
        // 先收完账再交卷——decide 会立刻把状态翻回 running。
        // 工作台修复轮中途举的确认卡先读回执、由平台过节点(见
        // workspaceReviewNodeAnswer);其余卡走下单预选/月光。
        const reviewNode = await this.workspaceReviewNodeAnswer(task);
        if (!this.current(task, epoch)) break;
        const auto = reviewNode ?? this.autoAnswerFor(task);
        if (auto) {
          this.options.log?.(
            `任务 ${task.summary.id} 人工节点自动交卷(${auto.why})`);
          // 自动交卷=马上就要接着跑,别做"停了再开"的无用功。
          setImmediate(() => void this.autoDecide(task, auto));
        } else {
          // 真·等人时会话与容器是一个连续执行现场。8g 是上限而非预占；
          // 为省空闲资源销毁容器会丢 HOME、/tmp，并让续跑撞上重建竞态。
          this.notifyWaiting(task);
        }
        break;
      }
      case "turn_finished": {
        // 无页面读取时也校验刚写完的图，趁原会话还在，交给下方插话续跑。
        this.refreshRequirementGraph(task);
        if (await this.finishHostAction(task, epoch)) break;
        if (!this.current(task, epoch)) break;
        // 回合收口时 steer 队列还压着货 = 那条插话从没送到(撞在回合
        // 间隙,pi 收下却不会自己送)。取回来补发,而且排在催办和收工
        // 之前:人说的话优先于系统催办,更不能因为"流程刚好走完了"被吞掉。
        const late = task.driver?.takeUndeliveredSteers() ?? [];
        if (late.length && task.driver) {
          this.options.log?.(
            `任务 ${task.summary.id} 补发 ${late.length} 条未送达的插话`);
          await this.settle(
            task, task.driver.continueWith(late.join("\n\n")), epoch);
          break;
        }
        // 检视意见没处理完就收口,是"举卡太早"的另一面(用户 2026-09-05
        // 拍板:最终卡出现之前所有已提交意见必须处理完成)。趁原会话还活着
        // 让它接着处理,不另起会话;同一批意见最多催两次,催不动就按原路
        // 收口——推送卡那道兜底会再派一次,再不成就如实举卡让人返工。
        const reviewGap = await this.reviewProcessingGap(task);
        if (!this.current(task, epoch)) break;
        // MR 修复轮里"回执一条没写"另有一条更窄的路(下面的"只补回执,不要
        // 重新修改代码",自动补交一次、再失败如实停下),这里让给它;这里
        // 只管回执写了但不算完成的 not_fixed / needs_clarification,以及
        // 没有修复环的普通流程。
        const mrLoopOwesReceipts = task.summary.delivery?.loop?.review_source
          === "workspace" && reviewGap.pending.some((item) =>
          item.response?.revision !== (item.rework ?? 0));
        if (reviewGap.pending.length && task.driver && !mrLoopOwesReceipts) {
          const key = reviewProcessingKey(reviewGap.pending);
          const nudge = task.reviewProcessingNudge?.key === key
            ? task.reviewProcessingNudge : { key, count: 0 };
          if (nudge.count < 2) {
            task.reviewProcessingNudge = { key, count: nudge.count + 1 };
            task.summary.detail =
              `还有 ${reviewGap.pending.length} 条检视意见未处理完成,Agent 正在继续处理`;
            this.persist(task);
            this.options.log?.(`任务 ${task.summary.id} 回合收口时 ${
              reviewGap.pending.length} 条检视意见未处理完成,催原会话继续(第 ${
              nudge.count + 1} 次)`);
            await this.settle(task, task.driver.continueWith(
              this.reviewProcessingPrompt(task, reviewGap.pending, reviewGap.error)),
              epoch);
            break;
          }
          this.options.log?.(
            `任务 ${task.summary.id} 检视意见 ${key} 催办两次仍未处理完成,按原路收口`);
        }
        // 分析单不属于内核，绝不能落入下面的 init/current 催办，也不能
        // 因 tryDeliver 对分析单早退而被误标 completed。正常出口只有
        // AskUserQuestion 举起澄清/方案确认卡；提前收嘴就沿同一会话续跑。
        if (this.isRequirementAnalysis(task)) {
          const step = "requirement_analysis";
          if (task.nudgedStep !== step) {
            task.nudgedStep = step;
            task.nudgeCount = 0;
          }
          if (task.driver && (task.nudgeCount ?? 0) < 5) {
            task.nudgeCount = (task.nudgeCount ?? 0) + 1;
            this.options.log?.(
              `任务 ${task.summary.id} 催办继续需求分析（尚未完成方案确认）`);
            await this.settle(task, task.driver.continueWith(
              "需求分析尚未完成方案确认。先核对已有人工答复，不要重复追问已回答的问题。请继续当前分析，"
              + "不要执行任何 mae-flow/init/current/done 命令。若全局 Story（旧现场为 CHAIN）"
              + "和 requirement-graph.json 已经完整且同步，立即按开场要求举起"
              + "方案确认卡，只提供「需要修改」和「确认方案」两个选项；否则先补完分析产物再举卡。"), epoch);
            break;
          }
          task.lastReply = task.driver?.finalReply();
          const analysisDriver = task.driver;
          if (task.driver === analysisDriver) task.driver = undefined;
          analysisDriver?.dispose();
          const cleanupFailure = await this.stopTaskContainer(
            task, "需求分析提前结束后");
          task.summary.status = "failed";
          task.summary.detail = "Agent 连续结束需求分析但方案确认尚未完成，"
            + "已保留分析产物，请重跑后从现有方案继续"
            + (cleanupFailure ? `；${cleanupFailure}` : "");
          this.persist(task);
          this.notifyOutcome(task);
          break;
        }
        // 逐条回执是 Agent 本轮工作的机器收据，不是需要用户处理的业务
        // 异常。必须趁原会话和容器还活着检查：第一次漏写/写坏就原地
        // 补交一次，不重新改代码、不另起 Agent。过去在 dispose 之后才
        // 检查，平台自己的 reviews 挂载遗漏会被误报成人工停机。
        let workspaceReceiptFailure: string | undefined;
        const workspaceLoop = task.summary.delivery?.loop;
        if (workspaceLoop?.review_source === "workspace") {
          const receipts = await this.consumeWorkspaceReviewReceipts(task);
          if (!receipts.ok) {
            const retryFor = workspaceLoop.review_ids
              ?? `workspace:${(workspaceLoop.workspace_review_annotation_ids ?? [])
                .slice().sort().join(",")}`;
            if (task.driver
                && workspaceLoop.workspace_review_receipt_retry_for !== retryFor) {
              workspaceLoop.workspace_review_receipt_retry_for = retryFor;
              workspaceLoop.diagnosis = receipts.detail;
              task.summary.status = "running";
              task.summary.detail = "代码修改已完成，正在自动补齐逐条检视回执";
              this.persist(task);
              const wanted = new Set(
                workspaceLoop.workspace_review_annotation_ids ?? []);
              const pending = this.annotations(task).list().filter((item) =>
                wanted.has(item.id) && this.awaitingAgentReceipt(item));
              await this.settle(task, task.driver.continueWith([
                "代码修改已经完成，但逐条检视回执没有成功落盘。",
                receipts.detail ?? "逐条检视回执不完整。",
                "现在只补回执，不要重新修改代码、不要重新提交，也不要重复走流程。",
                "平台已准备下述回执文件的父目录；使用给出的绝对路径，不要自行换算目录。",
                this.reviewReceiptInstructionsFor(task, pending),
                "写完后立即结束本轮。",
              ].join("\n\n")), epoch);
              break;
            }
            workspaceReceiptFailure = receipts.detail
              ?? "逐条检视回执不完整";
          }
        }
        // 收口发言先落袋:修复会话"判断修不了"时这就是给人的诊断,
        // 下面 tryDeliver→pipelineVerdict 的 halted 分支要用。
        task.lastReply = task.driver?.finalReply();
        const feedbackResultFailure = this.recordActiveFeedbackResult(task);
        const activeFeedback = feedbackResultFailure && task.driver && workspaceLoop
          && workspaceLoop.review_source !== "workspace"
          && ["evidence_missing", "evidence_invalid"].includes(
            classifyDeliveryFailure(feedbackResultFailure, "receipt").stall_class)
          ? this.activeKernelFeedback(task) : undefined;
        if (feedbackResultFailure && task.driver && activeFeedback && workspaceLoop
            && workspaceLoop.feedback_receipt_retry_for !== activeFeedback.batchId) {
          workspaceLoop.feedback_receipt_retry_for = activeFeedback.batchId;
          workspaceLoop.diagnosis = feedbackResultFailure;
          task.summary.status = "running";
          task.summary.detail = "代码处理已完成，正在自动补齐逐条反馈回执";
          this.persist(task);
          await this.settle(task, task.driver.continueWith([
            "代码处理已经完成，但本批逐条反馈回执没有通过机器核对。",
            feedbackResultFailure,
            "现在只补回执，不要重新修改代码、不要重新提交、不要重复走流程。",
            this.activeFeedbackReceiptInstructions(task),
            "写完后立即结束本轮。",
          ].join("\n\n")), epoch);
          break;
        }
        // 回合结束≠流程走完:模型可能提前收嘴(run3 实测停在
        // delivery_review)。内核 current 不在终态且催办还有效时,
        // 同一会话催办续跑,而不是把半截流程标成 completed。
        const receiptFailure = workspaceReceiptFailure || feedbackResultFailure;
        const stalled = receiptFailure ? undefined : this.stalledStep(task);
        if (stalled && task.nudgedStep !== stalled) {
          // 换了步骤才重置预算；同一步第二次 end_turn 不能因为“已经催过”
          // 就越过内核直接交付。最多催五次，之后如实停机等重跑。
          task.nudgedStep = stalled;
          task.nudgeCount = 0;
        }
        if (stalled && task.driver && (task.nudgeCount ?? 0) < 5) {
          task.nudgeCount = (task.nudgeCount ?? 0) + 1;
          const confirmationAnswers = stepChoiceEffects(
            this.options.host?.kernelRoot, stalled)
            .filter(effect => effect.closesFeedback)
            .flatMap(effect => effect.answers);
          const reviewCardInstruction = confirmationAnswers.length
            ? `这是必须由责任人决定的检视步骤。材料准备好后必须调用 AskUserQuestion；确认选项原样使用“${confirmationAnswers[0]}”，另一项明确写“仍需调整（按当前检视意见修改）”。不要用普通文本代替卡片。`
            : "";
          this.options.log?.(
            `任务 ${task.summary.id} 催办续跑(流程停在 ${stalled})`);
          await this.settle(task, task.driver.continueWith(
            `本轮工作尚未走完:内核当前步骤是 ${stalled},还没到宿主等待点。` +
            `尚未 init 就按开工引导先执行 init;否则执行 current ` +
            `查看本步指引并继续,直到流程进入 external_verify 或 delivery_watch。` +
            `已答复过的确认项不要重复提问。${reviewCardInstruction}`), epoch);
          break;
        }
        const beforeDelivery = !receiptFailure && this.options.host && !this.isRequirementAnalysis(task)
          ? inspectKernelPosition(task.cwd, this.options.host.kernelRoot) : undefined;
        if (beforeDelivery
            && beforeDelivery.kind !== "terminal"
            && beforeDelivery.kind !== "delivery_watch"
            && beforeDelivery.kind !== "external_verify") {
          // 执行位置异常先停下；模型结束发言不能代替内核流程完成。
          task.lastReply = task.driver?.finalReply();
          const earlyDriver = task.driver;
          if (task.driver === earlyDriver) task.driver = undefined;
          earlyDriver?.dispose();
          const cleanupFailure = await this.stopTaskContainer(
            task, "Agent 提前结束后");
          if (!this.current(task, epoch)) break;
          task.mission = undefined;
          task.summary.status = "failed";
          task.summary.detail = `Agent 提前结束，${beforeDelivery.reason}`
            + (cleanupFailure ? `；${cleanupFailure}` : "");
          this.persist(task);
          this.notifyOutcome(task);
          break;
        }
        if (this.atExternalVerificationWait(task)) {
          task.summary.status = "verifying";
          task.summary.detail = "Agent 已结束，正在释放执行环境并交接宿主验证";
          this.persist(task);
        }
        // 先借出工作区，不销毁已结束本轮的会话。交付若马上派发继续工作，
        // 复用上下文；正式等待流水线或结束任务时由 settle finally 释放。
        if (task.driver?.isIdle) retainIdleSession(task);
        else task.driver?.dispose();
        // 工作树写操作仍必须停净容器，避免后台进程与宿主同时修改文件。
        task.driver = undefined;
        const completedContainer = task.container;
        await (completedContainer?.stop() ?? Promise.resolve());
        if (task.container === completedContainer) task.container = undefined;
        if (!this.current(task, epoch)) break;
        // 专项使命到这儿才算消费掉:会话真做完了。早清会让"修一半
        // 被重启"的重建会话拿不到使命。
        task.mission = undefined;
        // 自动补交一次仍失败才停。这里不能拿总体回复顶账，但也不能把
        // 一次可恢复的格式/落盘问题直接甩给用户。
        if (workspaceReceiptFailure) {
          const loop = task.summary.delivery!.loop!;
          loop.state = "halted";
          loop.diagnosis = workspaceReceiptFailure;
          task.summary.status = "verifying";
          task.summary.detail = `自动补交逐条检视回执后仍未完成：${
            workspaceReceiptFailure}。已保留代码现场，请人工重跑或查看明细。`;
          task.summary.delivery!.stalled = task.summary.detail;
          this.persist(task);
          this.notifyRepairStopped(task);
          break;
        }
        // 回执材料 Agent 已经留在工作区文件里,只是内核这一下没答。这不是
        // Agent 的错也不是人的事:挂起带预算自愈,runDeliveryRecovery 会先
        // 补登记回执再交付(登记按结果摘要幂等)。原来一律 halted+stalled
        // 叫人,一次内核抖动就把整轮修复成果晾在那。
        if (feedbackResultFailure
            && classifyDeliveryFailure(feedbackResultFailure, "receipt")
              .disposition === "retry") {
          this.holdWithRecovery(task, feedbackResultFailure, epoch);
          break;
        }
        if (feedbackResultFailure) {
          const loop = task.summary.delivery?.loop;
          if (loop) {
            loop.state = "halted";
            loop.diagnosis = feedbackResultFailure;
          }
          task.summary.status = "verifying";
          task.summary.detail = `${feedbackResultFailure}。代码现场已保留，等待明确处理。`;
          task.summary.delivery = {
            ...task.summary.delivery,
            stalled: task.summary.detail,
            waiting_on: feedbackResultFailure,
          };
          this.persist(task);
          this.notifyRepairStopped(task);
          break;
        }
        // 终态在交付判定之后才定:先标 completed 再改,轮询会撞见
        // 中间态(实测竞态)。交付把状态升为 verifying/await_merge,
        // 没交付动作时才落 completed。
        const deliveryResult = await this.tryDeliver(task, epoch);
        if (deliveryResult === "review_reply_blocked") break;
        if (!this.current(task, epoch)) break;
        const afterDelivery = this.deliveryReadyAttestation(task);
        if (afterDelivery && !afterDelivery.complete
            && ["running", "completed", "await_merge"].includes(
              task.summary.status)) {
          // tryDeliver 是 I/O 编排，不拥有终态解释权。无论它从哪个旁路
          // 返回，只要内核还没 delivery_watch + PASS，就只能继续验证/显式失败。
          if (afterDelivery.kind === "external_verify"
              || (afterDelivery.terminal && afterDelivery.external_required)) {
            // 这里是"交付这一轮没能把义务核销掉"的总收口——推送失败、
            // MR 建不起来、内核登记没成,最后都落到这一句。挂起必须带
            // 自愈预算:原来它只写个状态就散场,于是任务既没人再推它、
            // 重启也不管它、连重跑都被拒(实测的那潭死水)。
            this.holdWithRecovery(task, afterDelivery.reason, epoch);
          } else {
            task.summary.status = "failed";
            task.summary.detail = `不能完成任务：${afterDelivery.reason}`;
          }
        } else if (task.summary.status === "running") {
          task.summary.status = "completed";
        }
        this.persist(task);
        this.notifyOutcome(task);
        break;
      }
      case "session_ended":
        if (task.summary.status === "pausing") {
          await this.finishPause(task, "running");
          break;
        }
        const endedDriver = task.driver;
        if (task.driver === endedDriver) task.driver = undefined;
        endedDriver?.dispose();
        const cleanupFailure = await this.stopTaskContainer(task, "会话异常结束后");
        if (!this.current(task, epoch)) break;
        task.summary.status = "failed";
        task.summary.detail = (outcome.detail ?? outcome.reason)
          + (cleanupFailure ? `；${cleanupFailure}` : "");
        this.persist(task);
        this.notifyOutcome(task);
        break;
    }
  }
}

// 错误类型搬到 errors.ts(纯规则模块也要抛它们);这里原样再导出,调用方不动。
export { NotFoundError, TaskControlError } from "./errors.ts";

/** 插话里的 @ 知识引用(前端只传结构化标识,内容由服务端解析注入)。 */
export interface SteerKnowledgeReference {
  kind: "skill" | "business";
  /** kind=skill:团队 Skill 目录名。 */
  directory?: string;
  /** kind=business:业务模块与资产标识。 */
  module_id?: string;
  asset_id?: string;
}
