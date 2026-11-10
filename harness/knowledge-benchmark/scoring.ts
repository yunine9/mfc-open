export interface CaseResult {
  id: string;
  kind: "retrieval" | "guard" | "agent" | "scope" | "generation";
  passed: boolean;
  elapsed_ms: number;
  error?: string;
  rank?: number;
  positive?: boolean;
  scope_leaks?: string[];
  [key: string]: unknown;
}
export function scoreRanking(expected: string[], hits: string[], forbidden: string[] = []) {
  const index = hits.slice(0, 5).findIndex(id => expected.includes(id));
  const leaks = hits.filter(id => forbidden.includes(id));
  return { passed: (expected.length ? index >= 0 : hits.length === 0) && leaks.length === 0,
    positive: expected.length > 0, rank: index < 0 ? undefined : index + 1, scope_leaks: leaks };
}
function rate(n: number, d: number) { return d ? Number((n / d).toFixed(4)) : null; }
export function summarize(cases: CaseResult[]) {
  const retrieval = cases.filter(c => c.kind === "retrieval");
  const positives = retrieval.filter(c => c.positive);
  const negatives = retrieval.filter(c => !c.positive);
  const latency = retrieval.map(c => c.elapsed_ms).sort((a, b) => a - b);
  return {
    total: cases.length, passed: cases.filter(c => c.passed).length,
    retrieval: { total: retrieval.length, positives: positives.length, negatives: negatives.length,
      hit_at_1: rate(positives.filter(c => c.rank === 1).length, positives.length),
      hit_at_5: rate(positives.filter(c => c.rank !== undefined && c.rank <= 5).length, positives.length),
      mrr_at_5: positives.length ? Number((positives.reduce((sum, c) => sum + (c.rank && c.rank <= 5 ? 1 / c.rank : 0), 0) / positives.length).toFixed(4)) : null,
      negative_rejection_rate: rate(negatives.filter(c => c.passed).length, negatives.length),
      scope_leaks: retrieval.reduce((n, c) => n + (c.scope_leaks?.length ?? 0), 0),
      p50_ms: latency.length ? latency[Math.ceil(latency.length * 0.5) - 1] : null,
      p95_ms: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null },
    evidence: { total: retrieval.filter(c => c.evidence_expected).length,
      hit_at_1: rate(retrieval.filter(c => c.evidence_expected && c.evidence_rank === 1).length, retrieval.filter(c => c.evidence_expected).length),
      hit_at_5: rate(retrieval.filter(c => c.evidence_expected && Number(c.evidence_rank) <= 5).length, retrieval.filter(c => c.evidence_expected).length) },
    guards: { total: cases.filter(c => c.kind === "guard").length, passed: cases.filter(c => c.kind === "guard" && c.passed).length },
    scope: { total: cases.filter(c => c.kind === "scope").length, passed: cases.filter(c => c.kind === "scope" && c.passed).length },
    generation: { total: cases.filter(c => c.kind === "generation").length,
      contract_passed: cases.filter(c => c.kind === "generation" && c.outcome === "contract_passed").length,
      contract_failed: cases.filter(c => c.kind === "generation" && c.outcome === "contract_failed").length,
      invalid_output: cases.filter(c => c.kind === "generation" && c.outcome === "invalid_output").length,
      execution_errors: cases.filter(c => c.kind === "generation" && c.outcome === "execution_error").length,
      semantic_accuracy: null },
    agents: ["with-knowledge", "without-knowledge", "generated-context"].map(arm => {
      const rows = cases.filter(c => c.kind === "agent" && c.arm === arm);
      return { arm, total: rows.length, passed: rows.filter(c => c.passed).length };
    }),
  };
}
export function compareReports(current: any, baseline: any) {
  if (baseline.schema_version !== current.schema_version || baseline.fixture_hash !== current.fixture_hash
      || baseline.evaluator_hash !== current.evaluator_hash || JSON.stringify(baseline.run_config) !== JSON.stringify(current.run_config)) {
    throw new Error("基线的语料、评分器或运行参数不同，不能直接比较；请使用同一套 benchmark 重新建立基线");
  }
  const before = new Map<string, CaseResult>(baseline.cases.map((c: CaseResult) => [c.id, c]));
  const regressions = current.cases.filter((c: CaseResult) => before.get(c.id)?.passed && !c.passed).map((c: CaseResult) => c.id);
  const improvements = current.cases.filter((c: CaseResult) => before.get(c.id)?.passed === false && c.passed).map((c: CaseResult) => c.id);
  return { regressions, improvements, added: current.cases.filter((c: CaseResult) => !before.has(c.id)).map((c: CaseResult) => c.id),
    removed: baseline.cases.filter((c: CaseResult) => !current.cases.some((n: CaseResult) => n.id === c.id)).map((c: CaseResult) => c.id),
    hit_at_5_delta: current.summary.retrieval.hit_at_5 === null || baseline.summary.retrieval.hit_at_5 === null ? null
      : Number((current.summary.retrieval.hit_at_5 - baseline.summary.retrieval.hit_at_5).toFixed(4)),
    p95_ms_delta: current.summary.retrieval.p95_ms === null || baseline.summary.retrieval.p95_ms === null ? null
      : current.summary.retrieval.p95_ms - baseline.summary.retrieval.p95_ms };
}
