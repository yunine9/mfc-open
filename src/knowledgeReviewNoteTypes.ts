export type KnowledgeReviewKind = "domain" | "component" | "published" | "skill";
export interface KnowledgeReviewSubmission {
  working: boolean;
  status_label: string;
  error?: string;
  retryable?: boolean;
}
export interface KnowledgeReviewNotesResult {
  notes: KnowledgeReviewNote[];
  submissions: Record<string, KnowledgeReviewSubmission>;
  turn_id?: string;
}
export interface KnowledgeReviewNoteInput {
  inspection_id?: string;
  document_id: string;
  scope: "line" | "document" | "study";
  line?: number;
  line_end?: number;
  anchor?: string;
  quote?: string;
  context_before?: string;
  context_after?: string;
  note: string;
}
export interface KnowledgeReviewNote extends KnowledgeReviewNoteInput {
  id: string;
  retry_of?: string;
  kind: KnowledgeReviewKind;
  job_id: string;
  document_title: string;
  operator: string;
  created_at: string;
  status: "open" | "submitted" | "resolved";
  submitted_at?: string;
  submitted_by?: string;
  turn_id?: string;
  resolved_at?: string;
  resolved_by?: string;
}
