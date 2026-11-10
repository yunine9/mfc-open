import type { MrParticipantsResult } from "./mrParticipants.ts";

export interface KnowledgeRepository {
  id: string; name: string; repository: string; branch: string; path: string; docs_path: string;
}
export interface DomainWorkDocument { id: string; title: string; content: string }
export interface DomainDocumentContent {
  id: string; title: string; target_id: string; path: string; layer: "domain" | "repository"; content: string; sources: string;
}
export interface DomainArchiveTargetsPreview {
  archive_preview?: import("./knowledgeProductionTypes").KnowledgeArchivePreview;
  targets: KnowledgeRepository[];
  documents: Array<Pick<DomainDocumentContent, "id" | "title" | "target_id" | "path">>;
  archive_revision: number;
}
export interface DomainDocument extends DomainDocumentContent {
  research_turn_id?: string;
  human_edited?: boolean;
  /** 文稿删除先进入任务候选，通过 MR 删除 Git 文件，合入后同步正式库。 */
  deleted?: boolean;
  /** 用户在归档设置中指定的完整相对路径；模型输出不能设置此字段。 */
  archive_path?: string;
  revision: number; selected: boolean; base_content: string | null; base_revision: string;
  /** 改名前的 Git 基线位置；归档时只删除内容仍与已知版本一致的旧文件。 */
  base_path?: string;
  history: Array<{ revision: number; content: string; sources: string; title: string; path?: string; deleted?: boolean; operator: string; at: string }>;
  knowledge_document_id?: string;
  published_revision?: string;
  published_document_revision?: number;
  published_at?: string;
}
export interface DomainTurn {
  id: string; mode: "extract" | "discuss" | "revise" | "update"; document_ids: string[]; message: string; operator: string;
  status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled"; created_at: string; reply?: string; error?: string;
  waiting?: { id: string; summary: string; document_ids: string[]; work_document_ids: string[] };
  human_replies?: Array<{ request_id: string; message: string; operator: string; at: string }>;
  /** 本轮实际开跑与收口时间；任务中心的「开始时间 / 运行时长」取最近一轮，不含排队和审查等待。 */
  started_at?: string; finished_at?: string;
  skill?: { name: string; digest: string };
  /** 本轮提交的原检视意见编号；正文通过只读工具按需读取，避免全部注入上下文。 */
  review_note_ids?: string[];
  use_latest_skill?: boolean; previous_revisions?: Record<string, string>;
  revisions?: Record<string, string>;
  document_revisions?: Record<string, number>;
  research?: DomainResearch;
  /** 仅显式接续递增，服务重启不自动解除 Skill 请求的暂停。 */
  pipeline_continue?: number;
  proposals: Array<{ document: DomainDocumentContent; base_revision: number; status: "pending" | "accepted" | "discarded" }>;
}
export interface DomainResearch {
  capabilities: Array<{ id: string; title: string; repository_ids: string[]; state: "pending" | "researched" | "blocked";
    findings: string; checks?: Record<string, string>; evidence_ids?: string[];
    sources: Array<{ repository_id: string; path: string }>; document_ids: string[] }>;
  inventory_complete: boolean;
  phase: "research" | "review" | "complete";
  finish_requested?: boolean;
}
export interface DomainPublication {
  target_id: string; state: "pending" | "opened" | "failed";
  /** 只由远端 MR 查询写入，不用本地推送结果推测合入。 */
  mr_state?: "opened" | "closed" | "merged";
  checked_at?: string;
  branch: string; mr_attempted?: boolean; url?: string; mr_id?: string | number; error?: string; revision?: string;
  /** 人员设置独立于 MR 创建结果；失败时仍保留已创建的 MR。 */
  mr_participants?: MrParticipantsResult;
  documents: Array<{ id: string; path: string; content: string; revision: number; deleted?: boolean; base_content?: string | null; knowledge_document_id?: string; knowledge_revision?: string }>;
  attempted_documents?: DomainPublication["documents"];
  /** 平台生成的 Git 导航入口，用精确正文识别后续目录变更的旧文件。 */
  navigation_files?: Array<{ path: string; content: string }>;
  updated_at?: string;
}
export interface DomainArchiveBatch {
  id: string; created_at: string; operator: string; state: "pending" | "running" | "done" | "failed" | "superseded";
  /** 批次按创建时的目录规则重试；历史批次缺省为旧布局。 */
  knowledge_layout?: "module-v1" | "repository-v1" | "directory-v1";
  documents: DomainDocument[]; targets: KnowledgeRepository[]; issue_no?: string; issue_description?: string;
  publications: DomainPublication[]; error?: string;
  /** 新 MR 全部创建成功后撤销旧 MR；每份回执独立保存，重试不重复创建。 */
  replacements?: Array<{ batch_id?: string; target: KnowledgeRepository; publication: DomainPublication;
    state: "pending" | "closed" | "merged" | "failed"; error?: string; closed_at?: string; merged_at?: string }>;
  superseded_documents?: Array<{ document_id: string; knowledge_document_id: string; published_revision: string;
    current_revision?: string; reason: "newer_version" | "deleted" }>;
}
export interface KnowledgeCleanupPlan {
  id: string; target_id: string; paths: string[]; target_revision: string;
  entries: Array<{ path: string; mode: string; oid: string }>;
  selected_paths?: string[];
}
export interface KnowledgeCleanupPublication extends DomainPublication {
  cleanup_plan_id: string; removed_paths: string[];
}
export interface KnowledgeSourceCleanupState {
  repositories: KnowledgeRepository[]; plans: KnowledgeCleanupPlan[];
  publications: KnowledgeCleanupPublication[]; started?: boolean;
}
export interface DomainKnowledgeJob {
  /** 主文件版本用于防止旧归档进度覆盖后来保存的任务。 */
  archive_progress_revision?: string;
  task_kind?: "extraction" | "inspection";
  inspection_source?: { document_id: string; started_at: string; finished_at?: string };
  /** 与检视正文一同固定的资源引用；后续同步不会替换任务中的图片。 */
  git_resources?: import("./knowledgeRepositoryTypes").FrozenGitKnowledgeResources;
  /** 阅读响应已拆分过程记录和历史；不写入任务状态。 */
  deferred_details?: boolean;
  /** 读取时从业务模块目录解析的名称，不作为路径或归属标识持久化。 */
  module_name?: string;
  /** 重新萃取的原任务，用于重复请求时返回同一个新任务。 */
  reextract_of?: string;
  /** 创建请求的规范化键；后续归档、关联信息与资料维护不改变它。 */
  key?: string;
  /** 只在读取响应中计算，磁盘记录不保存另一份状态。 */
  production?: import("./knowledgeProductionTypes").KnowledgeProductionView;
  /** 从本轮工作记录读取全文，过程文稿不进入知识发布和 Git 归档。 */
  work_documents?: Array<DomainWorkDocument & { turn_id: string }>;
  deletion?: import("./knowledgeProductionTypes").KnowledgeDomainDeletionView;
  id: string; title: string; scope: string; issue_no?: string; issue_description?: string; module_id?: string; operator: string; created_at: string;
  /** 归档路径规则随任务及批次固定；directory-v1 将文稿集中在各目标的最终目录内。 */
  knowledge_layout?: "module-v1" | "repository-v1" | "directory-v1";
  /** 用户为本次萃取补充的范围、文件使用限制和输出要求。 */
  instructions?: string;
  component_research_id?: string; technologies?: string[];
  component_source?: { job_id: string; repository: string; branch: string; path: string; revision?: string;
    components?: Array<{ id: string; repository: string; branch: string; path: string; revision?: string }> };
  repositories: KnowledgeRepository[]; knowledge_target: KnowledgeRepository;
  source_repositories?: KnowledgeRepository[];
  source_cleanup?: KnowledgeSourceCleanupState;
  archive_configured?: boolean; archive_revision?: number;
  material_ids: string[];
  deleted_at?: string; deleted_by?: string;
  status: "idle" | "queued" | "running" | "paused" | "done" | "failed" | "cancelled"; stage: string; error?: string;
  revisions: Record<string, string>; skill?: { name: string; digest: string };
  documents: DomainDocument[]; turns: DomainTurn[]; evidence: Array<Record<string, unknown>>; publications: DomainPublication[];
  publication_history?: DomainPublication[];
  archive_batches?: DomainArchiveBatch[];
}
export interface DomainExecution {
  job: DomainKnowledgeJob; turn: DomainTurn; root: string; signal: AbortSignal;
  save: (document: DomainDocumentContent, baseline?: { content: string | null; revision: string }) => DomainDocumentContent;
  remove?: (id: string) => DomainDocument;
  read: () => DomainDocument[];
  update: (patch: { revisions?: Record<string, string>; skill?: DomainKnowledgeJob["skill"]; stage?: string; research?: DomainResearch }) => void;
  evidence: (event: Record<string, unknown>) => void;
}
