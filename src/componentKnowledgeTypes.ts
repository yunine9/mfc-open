export interface ComponentKnowledgeFinding {
  observation_id?: string; exempt_reason?: string;
  level?: ComponentPolicyLevel; source_digest?: string; context?: string;
  path: string; line: number; end_line: number; rule_id: string;
  need: string; component: string; api: string[]; applicability: string;
  document_id: string; document_revision: string; document_line: number; paradigm_id: string;
}
export interface ComponentKnowledgeCheckReport {
  plans?: Array<{ path: string; findings: string[]; error?: string }>;
  mode: "observe"; trigger: "edit" | "manual" | "mr" | "sample";
  status: "completed" | "incomplete" | "not_applicable";
  checked_at: string; head?: string; base?: string; rules_digest: string;
  checked_files: number; rules: number; findings: ComponentKnowledgeFinding[]; warnings: string[];
}

export type ComponentPolicyLevel = "shadow" | "warning" | "off";
export interface ComponentPolicy {
  level: ComponentPolicyLevel; source_digest: string; owner: string; scope: string[]; reason: string;
  operator: string; updated_at: string; stale?: boolean;
}
export interface ComponentFeedback {
  id: string; item_id: string; source_digest: string; observation_id?: string;
  kind: "useful" | "false_positive" | "counterexample" | "quality_ok" | "quality_error";
  reason: string; operator: string; at: string;
}
export interface ComponentGovernanceItem {
  id: string; kind: "mapping" | "rule"; source_digest: string; policy: ComponentPolicy; original?: string; rule?: Record<string, unknown>;
  paradigm: { title: string; component: string; language: string; need: string; api: string[]; applicability: string;
    replaces: { identifiers: string[]; imports: string[]; patterns: string[] }; document_id: string; start_line: number; end_line?: number;
    evidence: Array<{ repository_id: string; path: string; revision: string; start: number; end: number }>; usage_evidence: string[]; test_evidence: string[] };
  samples: Array<ComponentKnowledgeFinding & { id: string; repository: string; checked_at: string; head?: string }>;
  feedback: ComponentFeedback[]; needs_review: boolean;
  stats: { observed: number; reviewed: number; exempt: number; exemption_rate: number | null };
}
export interface ComponentGovernanceSnapshot {
  revision: number; items: ComponentGovernanceItem[]; warnings: string[]; retention: string;
  challenges: Array<{ id: string; status: string; stage: string; draft?: string; error?: string; challenge: { item_id: string; source_digest: string } }>;
}
