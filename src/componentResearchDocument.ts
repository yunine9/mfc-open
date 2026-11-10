import { componentGuideMarkdown, componentGuideOverview, componentUsageMarkdown, compareComponentSections, validateComponentField } from "./componentKnowledgeMarkdown.ts";
import { validateComponentParadigm, componentSources, type ComponentParadigm } from "./componentParadigms.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";

/** 一项是可独立理解、使用和审查的能力，可能由多个仓共同提供。 */
export interface ResearchSection {
  paradigm?: ComponentParadigm;
  id: string;
  title: string;
  repository_ids: string[];
  selected: boolean;
  content: string;
  interfaces: string;
  integration: string;
  example: string;
  unit_tests: string;
  sources: string;
  related_ids: string[];
  revision: number;
}
export interface ResearchDocument {
  overview: string;
  sections: ResearchSection[];
}
export interface ResearchReviewTurn {
  id: string;
  /** 补充遗漏能力或整体返工不限定单项，为空串。 */
  section_id: string;
  mode: "discuss" | "rework" | "update" | "supplement";
  /** 补充轮新增的能力项编号；完成并通过独立评审后才并入文稿。 */
  added_section_ids?: string[];
  previous_revisions?: Record<string, string>;
  base_revision?: number;
  skill?: { name: string; digest: string };
  message: string;
  operator: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  proposal?: { base_revision: number; section: ResearchSection; status: "pending" | "accepted" | "discarded" };
  reply?: string;
  error?: string;
  created_at: string;
  finished_at?: string;
}
export interface ResearchDocumentEdit {
  action: "outline" | "overview" | "section";
  overview?: string;
  entries?: Array<{ id: string; title: string; repository_ids: string[] }>;
  section?: Omit<ResearchSection, "selected" | "revision">;
}
export function isWholeResearchReview(review?: Pick<ResearchReviewTurn, "mode" | "section_id">) {
  return review?.mode === "rework" && review.section_id === "";
}
export function sectionReady(section: ResearchSection): boolean {
  try { validateResearchSection(section); return true; } catch { return false; }
}
export function validateComponentOverview(overview: string) {
  componentGuideOverview(overview);
}
export function validateResearchSection(section: Omit<ResearchSection, "selected" | "revision">) {
  if (!section.paradigm) throw new Error("章节缺少结构化范式字段，请使用当前组件研究格式");
  validateComponentParadigm(section.paradigm, section.repository_ids);
  if (typeof section.unit_tests !== "string") throw new Error("请填写 unit_tests；研究章节无需单元测试时显式填写空串");
  if (section.paradigm.kind === "paradigm" && section.paradigm.status === "recommended") {
    componentUsageMarkdown(section);
    validateComponentField(section.integration, "接入配置");
  } else {
    if (typeof section.content !== "string" || !section.content.trim()) throw new Error("研究正文不能为空");
    if ([section.interfaces, section.integration, section.example].some(value => typeof value !== "string")) throw new Error("研究章节的接口、接入配置、示例须为文本；无需填写时显式留空");
  }
}
export function editResearchDocument(document: ResearchDocument, edit: ResearchDocumentEdit,
  repositoryIds: string[], review?: ResearchReviewTurn): ResearchDocument {
  if (review?.mode === "supplement") {
    // 补充只往文稿里加新项：已有能力和概述都已经过人审，改它们要走该项的返工，不能借补充之名重写。
    if (edit.action === "overview") throw new Error("补充遗漏能力只能新增能力项，不能修改概述");
    if (edit.action === "outline" && edit.entries?.some(entry => document.sections.some(section => section.id === entry.id))) {
      throw new Error("补充只能新增能力项；已有能力请在该项上返工");
    }
    if (edit.action === "section" && !review.added_section_ids?.includes(edit.section?.id ?? "")) {
      throw new Error("补充轮只能填写本轮新增的能力项，已有能力保持原样");
    }
  } else if (review && !isWholeResearchReview(review) && (review.mode === "discuss" || edit.action !== "section" || edit.section?.id !== review.section_id)) {
    throw new Error("本轮只能修改指定组件；讨论不会修改草稿，其他组件保持原样");
  }
  scanForSecrets("组件知识草稿", Buffer.from(JSON.stringify(edit)));
  const next = structuredClone(document);
  const check = (entry: { id: string; title: string; repository_ids: string[] }) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(entry.id) || !entry.title?.trim()) throw new Error("组件须有稳定编号和名称");
    if (!entry.repository_ids?.length || entry.repository_ids.some(id => !repositoryIds.includes(id))) {
      throw new Error("组件来源必须对应本次研究范围内的仓库");
    }
  };
  if (edit.action === "overview") {
    const overview = edit.overview ?? "";
    validateComponentOverview(overview);
    next.overview = overview;
  } else if (edit.action === "outline") {
    if (!edit.entries?.length) throw new Error("请提交发现的组件能力清单");
    for (const entry of edit.entries) {
      check(entry);
      const existing = next.sections.find(section => section.id === entry.id);
      if (existing) {
        if (existing.title !== entry.title || JSON.stringify(existing.repository_ids) !== JSON.stringify(entry.repository_ids)) {
          throw new Error(`编号 ${entry.id} 已有定义；保留原项，需要细分时添加新编号`);
        }
        continue;
      }
      next.sections.push({ ...entry, selected: true, content: "", interfaces: "", integration: "", example: "", unit_tests: "", sources: "", related_ids: [], revision: 0 });
    }
  } else if (edit.action === "section" && edit.section) {
    const section = edit.section;
    check(section);
    if (section.paradigm) { validateComponentParadigm(section.paradigm, repositoryIds); section.sources = componentSources(section.paradigm); }
    const index = next.sections.findIndex(item => item.id === section.id);
    if (index >= 0 && next.sections[index].paradigm && !section.paradigm) throw new Error("不能删除已有范式的结构化字段");
    if (index < 0) throw new Error("请先将组件加入能力清单，再写正文");
    validateResearchSection(section);
    if (!Array.isArray(section.related_ids) || section.related_ids.some(id => id === section.id || !next.sections.some(item => item.id === id))) {
      throw new Error("关联组件须使用清单中其他组件的编号");
    }
    next.sections[index] = { ...section, selected: next.sections[index].selected, revision: next.sections[index].revision + 1 };
  } else throw new Error("未知文档操作");
  return next;
}

export function researchDocumentMarkdown(title: string, document: ResearchDocument, selectedOnly = false, includeMetadata = true): string {
  const sections = document.sections.filter(section => !selectedOnly || section.selected).sort(compareComponentSections);
  for (const section of sections) if (section.paradigm) validateComponentParadigm(section.paradigm, section.repository_ids);
  const metadata = sections.filter(section => section.paradigm && (!selectedOnly || section.paradigm.kind === "paradigm" && section.paradigm.status === "recommended"))
    .map(section => ({ id: section.id, title: section.title, revision: section.revision, ...section.paradigm }));
  const body = componentGuideMarkdown(title, document.overview, sections, selectedOnly);
  return [includeMetadata && metadata.length ? `---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: ${JSON.stringify(metadata)}\n---` : "", body].filter(Boolean).join("\n\n");
}
