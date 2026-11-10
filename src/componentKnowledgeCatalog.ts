import type { ComponentPolicy } from "./componentKnowledgeTypes.ts";
import { componentDigest, readComponentPolicies, effectiveComponentPolicy } from "./componentKnowledgePolicy.ts";
import { createHash } from "node:crypto";
import { collectSearchableKnowledge, type KnowledgeContext } from "./knowledgeSearch.ts";
import { componentRepositories } from "./componentRepositories.ts";
import { listKnowledgeDocuments } from "./knowledgeDocuments.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { deriveComponentParadigms } from "./componentParadigms.ts";
import { componentRuleFiles } from "./componentRuleCandidates.ts";

export { publishedComponentParadigms } from "./componentKnowledgeDocument.ts";
import { publishedComponentParadigms, type PublishedComponentParadigm } from "./componentKnowledgeDocument.ts";
export type { PublishedComponentParadigm } from "./componentKnowledgeDocument.ts";
export interface ComponentKnowledgeCatalog {
  paradigms: PublishedComponentParadigm[];
  rules: Array<{ id: string; language: string; original: string; rule: Record<string, unknown>; source_digest: string; policy: ComponentPolicy; paradigm: PublishedComponentParadigm }>;
  digest: string; warnings: string[];
}

export function componentKnowledgeCatalog(dataDir: string, context: KnowledgeContext, languages: string[] = [], all = false): ComponentKnowledgeCatalog {
  const catalog = collectSearchableKnowledge(dataDir, context, all);
  const manuals = new Map(listKnowledgeDocuments(dataDir).map(d => [d.id, d]));
  const repositories = new Map(componentRepositories(dataDir).map(r => [r.id, r.repository]));
  const paradigms: PublishedComponentParadigm[] = [], warnings: string[] = [];
  let policies: ReturnType<typeof readComponentPolicies>["items"] = {};
  try { policies = readComponentPolicies(dataDir).items; } catch (error) { warnings.push(String(error)); }
  for (const asset of catalog.assets) {
    if (!["document", "rule", "example"].includes(asset.kind)) continue;
    try {
      for (const p of publishedComponentParadigms(asset)) {
        if (p.kind !== "paradigm" || p.status !== "recommended" || (languages.length && !languages.includes("agnostic") && !languages.includes(p.language))) continue;
        const doc = manuals.get(asset.id);
        p.source_repositories = [...new Set([...p.evidence.map(e => repositories.get(e.repository_id)).filter((v): v is string => !!v),
          ...(doc?.research_source?.components?.filter(c => p.evidence.some(e => e.repository_id === c.id)).map(c => c.repository) ?? []),
          ...(!doc?.research_source?.components?.length && doc?.research_source?.repository ? [doc.research_source.repository] : [])])];
        p.mapping_id = "mapping-" + componentDigest([p.document_id, p.id]).slice(0, 24);
        // 只对当前范式正文与适用范围计算内容版本，不因同文档其他章节修订而撤回本项启用。
        const { document_revision, start_line, end_line, mapping_id, source_digest, policy, ...content } = p;
        p.source_digest = componentDigest([content, asset.content.split(/\r?\n/).slice(p.start_line - 1, p.end_line).join("\n"), asset.scope]);
        // 知识查询统一由源文档启停控制；历史映射推荐策略不再参与消费。
        p.policy = effectiveComponentPolicy(undefined, p.source_digest);
        paradigms.push(p);
      }
    } catch (error) { warnings.push(`${asset.title}：${String(error instanceof Error ? error.message : error)}`); }
  }
  paradigms.sort((a, b) => `${a.document_id}/${a.id}`.localeCompare(`${b.document_id}/${b.id}`));
  const rules: ComponentKnowledgeCatalog["rules"] = [];
  for (const p of paradigms) {
    // 组件自身实现不受其对外替代建议约束。
    if (p.source_repositories.some(r => context.repositories.some(current => repositoryIdentity(current) === repositoryIdentity(r)))) continue;
    const { id, title, revision, document_id, document_revision, start_line, end_line, product_versions, source_repositories, mapping_id, source_digest, policy, ...paradigm } = p;
    const candidates = deriveComponentParadigms([{ id, title, revision, paradigm, selected: true, repository_ids: paradigm.evidence.map(e => e.repository_id),
      content: "", interfaces: "", integration: "", example: "", unit_tests: "", sources: "", related_ids: [] }]).rules;
    for (const candidate of candidates) {
      const unique = createHash("sha256").update(`${document_id}:${candidate.id}`).digest("hex").slice(0, 24);
      const files = componentRuleFiles([{ ...candidate, id: unique }]);
      const file = files[`derived/ast-grep/rules/component-${unique}.yml`];
      if (!file) { warnings.push(`${p.title}：${candidate.language} / ${candidate.value} 尚无可靠语法规则`); continue; }
      const parsed = JSON.parse(file);
      const digest = componentDigest([p.source_digest, parsed.rule, candidate.language]);
      rules.push({ id: parsed.id, language: candidate.language, original: candidate.value, rule: parsed.rule, source_digest: digest,
        policy: effectiveComponentPolicy(policies[parsed.id], digest), paradigm: p });
    }
  }
  return { paradigms, rules, warnings, digest: createHash("sha256").update(JSON.stringify({ adapter: 1, paradigms, rules })).digest("hex") };
}
