export interface DependencyTaskRef { id: string; title: string; ticket: string; repository: string }
export interface DependencyAdjustment {
  revision: string; at: string; by: string;
  released: string[]; remaining: string[]; no_longer_waiting: string[];
  parallel: string[]; downstream?: string[]; previous_ticket: string; ticket: string;
}
export interface EarlyStartInput { release_ids?: string[]; ticket?: string; revision?: string }
export interface EarlyStartPreview {
  task: DependencyTaskRef; owner: string; can_operate: boolean;
  available: boolean; unavailable_reason?: string; revision: string;
  prerequisites: DependencyTaskRef[]; release_ids: string[];
  no_longer_waiting: DependencyTaskRef[]; remaining: DependencyTaskRef[];
  parallel: DependencyTaskRef[]; conflicts: DependencyTaskRef[];
  downstream: { task: DependencyTaskRef; no_longer_waiting: DependencyTaskRef[]; conflicts: DependencyTaskRef[] }[];
  ticket: string; errors: string[]; result: string;
}
