import { KnowledgeArchiveDialog } from "./KnowledgeArchiveDialog";
import type { ComponentResearchRecord } from "./componentResearchApi";

export function ComponentKnowledgeArchive({ record, openRequest = 0, onArchiveAction }: {
  record: ComponentResearchRecord; openRequest?: number; onArchiveAction?: () => void;
}) {
  return <KnowledgeArchiveDialog endpoint={`/component-research/${encodeURIComponent(record.id)}/archive`}
    production={record.production} openRequest={openRequest} onChanged={onArchiveAction} editTargets />;
}
