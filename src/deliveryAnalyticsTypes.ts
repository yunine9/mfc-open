/** Read-only analytics; never used to authorize delivery. */
export type CodeOrigin = "first" | "pipeline" | "review" | "other";
export type OriginCounts = Record<CodeOrigin, number>;
export interface DeliveryCommitMetric {
  sha: string;
  subject: string;
  at: string;
  origin: CodeOrigin;
  origin_evidence?: string[];
  additions: number;
  deletions: number;
}
export interface DeliveryCodeMetric {
  version: 1;
  head: string;
  published_head?: string;
  base: string;
  first: string;
  initial_implementation?: { end?: string; basis: "content_comparison" | "repair_record" | "commit_message" | "no_repair_found" | "mr_publication" | "platform_push" };
  content_comparison?: { reference: "local_snapshot" | "platform_push" | "initial_mr"; base: string; head: string; captured_at?: string; snapshot_hash?: string };
  collected_at: string;
  retained: OriginCounts;
  rework: OriginCounts;
  deleted: number;
  excluded_files: number;
  commits: DeliveryCommitMetric[];
}
export interface MrComparison {
  reference?: "platform_push" | "local_snapshot";
  method: "ancestry" | "patch" | "final" | "unavailable";
  initial_head?: string;
  final_head?: string;
  retained?: number;
  removed?: number;
  added?: number;
  files?: Array<{ path: string; changed: boolean; retained?: number; removed: number; added: number }>;
  reason?: string;
}
export interface MrComparisonDetail {
  reference?: "platform_push" | "local_snapshot";
  comparison_basis: "head" | "patch" | "final";
  files: Array<{ path: string; change_patch: string; initial_patch: string; final_patch: string; truncated: boolean }>;
  truncated: boolean;
}
export interface DeliveryAnalysisRow {
  id: string;
  delivery_id?: string;
  started_at?: string;
  completed_at?: string;
  title: string;
  parent_id?: string;
  parent_title?: string;
  repo: string;
  /** Existing repository technology labels; no source-code inference. */
  languages?: string[];
  modules: string[];
  business_module?: { id: string; name: string };
  merged: boolean;
  at: string;
  mr_url?: string;
  initial_mr_url?: string;
  external_collaboration?: true;
  mr_comparison?: MrComparison;
  /** 最终 MR 自己的基线到源版本，仅统计交付文本。缺证据时不填。 */
  final_code_lines?: number;
  final_deleted_lines?: number;
  metric?: DeliveryCodeMetric;
  unavailable?: string;
  improvement?: import("./deliveryImprovementTypes.ts").ImprovementView;
}
export interface DeliveryTaskTokens {
  id: string; parent_id?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}
export interface DeliveryAnalysisReport {
  improvement_policy?: import("./deliveryImprovementTypes.ts").ImprovementPolicy & { can_configure?: boolean };
  task_tokens?: DeliveryTaskTokens[];
  generated_at: string;
  rows: DeliveryAnalysisRow[];
}
export const emptyOrigins = (): OriginCounts => ({ first: 0, pipeline: 0, review: 0, other: 0 });
