export interface ImprovementPolicy {
  enabled: boolean;
  threshold_percent: number;
  enabled_after?: string;
}
export interface ImprovementView {
  status: "queued" | "running" | "completed" | "failed";
  head: string;
  started_at: string;
  finished_at?: string;
  message?: string;
  available: boolean;
  stale?: boolean;
}
export interface ImprovementReport {
  state?: ImprovementView;
  markdown?: string;
}
