export type KnowledgeTaskKind = "domain" | "component" | "skill-extraction" | "skill-submission";
export type KnowledgeTaskGroup = "running" | "attention" | "completed";

export interface KnowledgeTaskRow {
  id: string;
  kind: KnowledgeTaskKind;
  task_kind?: "extraction" | "inspection";
  title: string;
  scope?: string;
  module_id?: string;
  /** 只统计实际已保存的文稿，列表不传正文或历史。 */
  document_summary?: { total: number; published: number; drafts: number; process: number };
  module_entry?: { kind: "task" | "document"; document_id?: string };
  operator?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  status: string;
  status_label: string;
  group: KnowledgeTaskGroup;
  next_action: import("./knowledgeProductionTypes").KnowledgeProductionAction;
  production?: import("./knowledgeProductionTypes").KnowledgeProductionView;
  stage?: string;
  error?: string;
  /** 仅公开的 assistant 文本摘要；工具原始输出不进入列表。 */
  latest_note?: { text: string; at?: string };
}

export interface KnowledgeTaskSummary {
  running: number;
  attention: number;
  total: number;
}

export interface KnowledgeTaskCenterData {
  tasks: KnowledgeTaskRow[];
  module_activity: Array<{ module_id: string; status_label: string; task_id: string }>;
  summary: KnowledgeTaskSummary;
  warnings: string[];
}
