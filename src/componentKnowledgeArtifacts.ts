import { componentArchiveParts } from "./componentKnowledgeArchiveFormat.ts";
import { componentKnowledgeCatalog } from "./componentKnowledgeCatalog.ts";
import { collectSearchableKnowledge } from "./knowledgeSearch.ts";
import { componentRuleFiles } from "./componentRuleCandidates.ts";
import { componentCardId, componentCardText } from "./componentKnowledgeCards.ts";

/** 按当前正式知识重建可检查的文件，不持久化第二份知识或策略。 */
export function componentKnowledgeArtifacts(dir: string, itemId: string) {
  const context = { repo: "", repositories: [], moduleIds: [] };
  const catalog = componentKnowledgeCatalog(dir, context, [], true);
  const p = catalog.paradigms.find(p => p.mapping_id === itemId) ?? catalog.rules.find(r => r.id === itemId)?.paradigm;
  if (!p) throw new Error("组件知识已停用或不存在，请刷新");
  const asset = collectSearchableKnowledge(dir, context, true).assets.find(a => a.id === p.document_id);
  if (!asset || asset.revision !== p.document_revision) throw new Error("知识版本已变化，请刷新");
  const rules = catalog.rules.filter(r => r.paradigm.mapping_id === p.mapping_id);
  const candidates = rules.map(r => ({ id: r.id.replace(/^component-/, ""), language: r.language,
    kind: p.replaces.imports.includes(r.original) ? "imports" : "identifiers", value: r.original,
    component: p.component, paradigm_id: p.id, applicability: p.applicability }));
  const files = componentRuleFiles(candidates);
  for (const rule of rules) files[`derived/ast-grep/rules/${rule.id}.yml`] = JSON.stringify({ id: rule.id,
    language: { c: "C", cpp: "Cpp", java: "Java" }[rule.language], severity: "warning", message: "核对组件适用条件", rule: rule.rule }, null, 2) + "\n";
  files["derived/rule-report.md"] = "# 代码检查产物\n\n运行状态见 rule-policy.json。语法命中只表示需要核对，不证明业务违规；当前不拦截提交。\n";
  const { policy: _policy, ...entry } = p;
  const source = componentArchiveParts(asset.content);
  files["source.md"] = source.content;
  if (source.component_metadata) files["source.metadata.json"] = source.component_metadata;
  files[`derived/cards/${componentCardId(p).replaceAll("/", "__")}.md`] = componentCardText(p, `${p.document_id}:${p.start_line}-${p.end_line}`, p.document_revision);
  files["derived/catalog.json"] = JSON.stringify({ paradigms: [entry] }, null, 2) + "\n";
  const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  files["derived/mapping-table.md"] = `| 需求 | 组件 / API | 适用条件 | 来源 |\n|---|---|---|---|\n| ${cell(p.need)} | ${cell(p.component + " / " + p.api.join("、"))} | ${cell(p.applicability)} | source.md |\n`;
  files["derived/rule-candidates.json"] = JSON.stringify({ rules: candidates }, null, 2) + "\n";
  files["rule-policy.json"] = JSON.stringify(Object.fromEntries(rules.map(r => [r.id, r.policy])), null, 2) + "\n";
  return { document_id: p.document_id, document_revision: p.document_revision, source_digest: p.source_digest, files };
}
