import { componentKnowledgeCatalog } from "./componentKnowledgeCatalog.ts";
import { componentFeedback, componentObservations, readComponentPolicies } from "./componentKnowledgePolicy.ts";

export function componentGovernance(dir: string) {
  const catalog = componentKnowledgeCatalog(dir, { repo: "", repositories: [], moduleIds: [] }, [], true);
  const observations = componentObservations(dir), feedback = componentFeedback(dir);
  const rows = [
    ...catalog.paradigms.map(p => ({ id: p.mapping_id, kind: "mapping" as const, source_digest: p.source_digest, policy: p.policy, paradigm: p })),
    ...catalog.rules.map(r => ({ id: r.id, kind: "rule" as const, source_digest: r.source_digest, policy: r.policy, paradigm: r.paradigm, original: r.original, rule: r.rule })),
  ];
  const items = rows.map(item => {
    const samples = observations.filter(o => o.rule_id === item.id && o.source_digest === item.source_digest);
    const reviews = feedback.filter(f => f.item_id === item.id && f.source_digest === item.source_digest);
    const judgments = new Map(reviews.filter(f => f.observation_id && ["useful", "false_positive"].includes(f.kind)).map(f => [f.observation_id!, f]));
    const reviewed = new Set(judgments.keys());
    const exempt = new Set([...judgments.values()].filter(f => f.kind === "false_positive").map(f => f.observation_id));
    const rate = reviewed.size ? exempt.size / reviewed.size : null;
    const needs_review = item.policy.stale || reviews.some(f => ["counterexample", "quality_error"].includes(f.kind)) || (reviewed.size >= 3 && rate! >= 0.3);
    return { ...item, samples: samples.slice(-10).reverse(), feedback: reviews.slice(-30).reverse(),
      stats: { observed: samples.length, reviewed: reviewed.size, exempt: exempt.size, exemption_rate: rate }, needs_review: !!needs_review };
  }).sort((a, b) => Number(b.needs_review) - Number(a.needs_review) || a.paradigm.component.localeCompare(b.paradigm.component) || a.id.localeCompare(b.id));
  let revision = -1;
  try { revision = readComponentPolicies(dir).revision; } catch { /* catalog 已显示损坏原因，禁止覆盖。 */ }
  return { revision, items, warnings: catalog.warnings, retention: "命中、反馈和策略历史持续保留；每项展示最近 10 条命中和 30 条反馈，统计使用当前版本的全部记录。误报率仅统计已人工判断的样本，不代表所有代码。" };
}
