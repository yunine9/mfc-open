import type { ComponentPublishInput, ComponentResearch, ResearchRecord } from "../../src/componentResearch.ts";
import { readKnowledgeDocument } from "../../src/knowledgeDocuments.ts";

/** 测试中提交实际检视过的正式绑定、章节版本和最新建议。 */
export function componentPublishInput(record: ResearchRecord, metadata: Record<string, unknown> = {}): ComponentPublishInput {
  return {
    ...record.update_metadata,
    ...metadata,
    title: String(metadata.title ?? record.update_metadata?.title ?? record.topic),
    document_id: record.document_id ?? null,
    update_document_id: record.update_document_id ?? null,
    update_document_revision: record.update_document_revision,
    sections: (record.document?.sections ?? []).filter(section => section.selected).map(section => ({
      id: section.id,
      revision: section.revision,
      proposal_id: [...record.review_turns ?? []].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending")?.id ?? null,
    })),
  };
}

export function publishComponentKnowledge(research: ComponentResearch, dir: string, id: string, metadata: Record<string, unknown>, operator: string) {
  const published = research.publish(id, componentPublishInput(research.get(id), metadata), operator);
  if (!published.document_id) throw new Error("组件发布未返回正式知识 ID");
  return readKnowledgeDocument(dir, published.document_id);
}
