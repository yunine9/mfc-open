import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderPlantUml } from '../../src/plantumlRender.ts';
import { scanKnowledgeCode, validateKnowledgeReferences } from '../../src/domainKnowledgeCode.ts';
import type { DomainKnowledgeJob } from '../../src/domainKnowledgeTypes.ts';
import { SMALL_DOCUMENTS, SOURCE_FILES, type SourceFixture } from './fixtures.ts';

export interface Fact { id: string; expected: string; source: string; positive: RegExp[]; forbidden: RegExp[] }
// These checks are intentionally conservative relation checks. Matching vocabulary is insufficient,
// and an unrecognised paraphrase stays unverified until a human compares it with the frozen source.
export const FACTS: Fact[] = [
  { id: 'settled-reversal', expected: '已结算必须冲正，不能直接取消', source: 'repo-1:src/service/cancellation.ts:6',
    positive: [/已结算[^。\n]{0,70}(?:必须|需要|须|转入|返回)[^。\n]{0,20}冲正/], forbidden: [/已结算[^。\n]{0,50}(?:可以直接取消|允许直接取消|应直接取消)/, /(?:所有|任何|无论[^。\n]{0,20})订单[^。\n]{0,30}(?:均|都|一律)直接取消/] },
  { id: 'shipped-return', expected: '已发货转退货流程', source: 'repo-1:src/service/cancellation.ts:5',
    positive: [/已发货[^。\n]{0,50}(?:需要|必须|须|转入|转|进入|返回)[^。\n]{0,15}退货/], forbidden: [/已发货[^。\n]{0,45}(?:可直接取消|直接退款|无需退货)/] },
  { id: 'unknown-no-retry', expected: '支付结果未知时人工核对，确认前禁止再次冲正', source: 'repo-1:src/service/cancellation.ts:418-422',
    positive: [/(?:未知|unknown|超时)[^。\n]{0,100}(?:人工|财务)[^。\n]{0,20}(?:核对|确认)/, /(?:确认|查明|核对)[^。\n]{0,20}前[^。\n]{0,20}(?:不得|禁止|不能|不可)[^。\n]{0,20}(?:重试|重复|再次)/],
    forbidden: [/(?:结果未知|unknown|渠道超时|支付超时)[^。\n]{0,50}(?:应自动重试|自动重试一次|允许直接重试|可重复提交)/, /(?:任何|所有|一切)[^。\n]{0,12}(?:异常|失败|超时)[^。\n]{0,15}(?:均|都|一律)[^。\n]{0,12}重试/] },
  { id: 'release-not-stock', expected: '释放预留减少 allocated，但 stockOnHand 不增加', source: 'repo-2:src/domain/reservations.ts:15-21',
    positive: [/(?:释放|取消)[^。\n]{0,60}(?:减少|扣减)[^。\n]{0,20}(?:allocated|预留|分配)/, /(?:stockOnHand|实物库存|现货)[^。\n]{0,20}(?:不变|不增加|保持不变)/],
    forbidden: [/(?:释放预留|未结算[^。\n]{0,15}取消)[^。\n]{0,40}(?:会增加|需要增加|将增加|加回)[^。\n]{0,15}(?:stockOnHand|实物库存|现货)/] },
  { id: 'expiry-entry', expected: '定时任务释放到期且 active 的预留', source: 'repo-2:src/jobs/housekeeping.ts:4',
    positive: [/(?:定时任务|sweepExpiredReservations)[^。\n]{0,60}(?:只|检查|筛选|扫描|遍历|选择)[^。\n]{0,65}(?:到期|过期)[^。\n]{0,50}(?:释放|release)/, /(?:active|有效)[^。\n]{0,12}(?:且|并且|&&)[^。\n]{0,50}(?:expiresAt|到期|过期)/],
    forbidden: [/(?:定时|sweepExpiredReservations)[^。\n]{0,50}(?:释放所有预留|无需检查到期|不检查状态|未到期[^。\n]{0,20}释放)/] },
  { id: 'saleable-equation', expected: 'saleable = stockOnHand - allocated - safetyBuffer', source: 'repo-2:src/domain/reservations.ts:6',
    positive: [/(?:saleable|可售库存)\s*[=＝：:]\s*(?:stockOnHand|实物库存|现货)\s*[-−－]\s*(?:allocated|已分配|已预留)\s*[-−－]\s*(?:safetyBuffer|安全保有量|安全库存)/],
    forbidden: [/(?:saleable|可售库存)\s*[=＝：:]\s*stockOnHand\s*[-−－]\s*allocated\s*[+＋]\s*safetyBuffer/] },
  { id: 'reserve-conditional-reuse', expected: 'reserve先校验余量再查已有编号；重复请求在余量不足时仍会失败，不能称为无条件幂等', source: 'repo-2:src/domain/reservations.ts:7-10',
    positive: [/(?:reserve|预留)[^。\n]{0,80}先[^。\n]{0,35}(?:校验|检查|判断)[^。\n]{0,25}(?:余量|可售|库存)[^。\n]{0,60}再[^。\n]{0,40}(?:已有|重复|编号|rows)/],
    forbidden: [/(?:重复预留|重复请求|reserve)[^。\n]{0,35}(?:无条件幂等|始终幂等|一定成功|总是成功|无需校验库存)/] },
];
export function assessFacts(markdown: string) {
  // A correct statement elsewhere never cancels a contradictory statement in the same artifact set.
  const text = markdown.replace(/[*`]/g, '');
  return FACTS.map(fact => {
    const contradictions = fact.forbidden.flatMap(pattern => text.match(pattern)?.[0] ?? []);
    const matched = fact.positive.map(pattern => text.match(pattern)?.[0] ?? null);
    return { id: fact.id, expected: fact.expected, source: fact.source, status: contradictions.length ? 'contradicted' : matched.every(Boolean) ? 'supported_pattern' : 'unverified', matched, contradictions };
  });
}
export function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(join(root, entry.name)) : entry.isFile() ? [join(root, entry.name)] : []);
}
export interface ObservedEvent { file: string; eventId: number; ts: string; kind: string; payload: any }
export function readEvents(root: string): ObservedEvent[] {
  return filesUnder(root).filter(path => path.endsWith('/events.jsonl')).flatMap(path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => ({ ...JSON.parse(line), file: relative(root, path) })));
}
export function assessReviewReads(events: ObservedEvent[], steps: any[], documents: DomainKnowledgeJob['documents']) {
  const succeeded = events.filter(e => e.kind === 'tool_finished' && e.payload.is_error === false);
  return documents.filter(d => !d.deleted).map(document => {
    const reviews = steps.filter(step => step.status === 'done' && step.result?.document_ids?.includes(document.id)
      && (step.readonly === true || step.review && step.result?.review?.pass === true));
    const lastWrite = succeeded.filter(e => e.payload.name === 'knowledge_draft' && e.payload.input?.action === 'save' && e.payload.input.document?.id === document.id).map(e => e.ts).sort().at(-1);
    const inspections = reviews.map(step => {
      const trace = succeeded.filter(e => step.review
        ? e.file.includes(`/steps/${step.id}/review-${step.review_attempts}/`)
        : e.file.includes(`/steps/${step.id}/writer/`) || e.file.includes(`/steps/${step.id}/${step.attempts}/`));
      const docRead = trace.find(e => e.payload.name === 'knowledge_draft' && e.payload.input?.action === 'read' && e.payload.input.id === document.id && (!lastWrite || e.ts >= lastWrite));
      const sourceRead = trace.some(e => e.payload.name === 'component_source' && e.payload.input?.action === 'read' && !!e.payload.result);
      const materialRead = trace.some(e => e.payload.name === 'knowledge_material' && e.payload.input?.id && !!e.payload.result);
      const noWrites = !trace.some(e => e.payload.name === 'knowledge_draft' && e.payload.input?.action !== 'read');
      return { step: step.id, latest_document_read: !!docRead, source_read: sourceRead, material_read: materialRead, readonly: noWrites,
        passed: !!docRead && sourceRead && materialRead && noWrites };
    });
    return { document_id: document.id, passed: inspections.some(r => r.passed), inspections };
  });
}
export async function assessRun(options: { job: DomainKnowledgeJob; root: string; sources: SourceFixture[]; profile: 'small'|'full'; diagrams: boolean; deadline?: number }) {
  const { job } = options;
  const documents = job.documents.filter(d => !d.deleted), markdown = documents.map(d => d.content).join('\n\n');
  const events = readEvents(options.root);
  const work = filesUnder(options.root).filter(path => path.endsWith('/work.json')).flatMap(path => [JSON.parse(readFileSync(path, 'utf8'))]);
  const steps = work.flatMap(w => w.steps ?? []);
  const reviews = assessReviewReads(events, steps, documents);
  const signal = options.deadline ? AbortSignal.timeout(Math.max(1, options.deadline - Date.now())) : new AbortController().signal;
  let references: Array<{ document_id: string; checked: string[]; errors: string[] }> = [];
  try {
    const snapshots = await Promise.all(options.sources.map(s => scanKnowledgeCode(s.repository, s, signal)));
    references = await Promise.all(documents.map(async d => ({ document_id: d.id, ...await validateKnowledgeReferences(d.content + '\n' + d.sources, snapshots, signal) })));
  } catch (error) { references = documents.map(d => ({ document_id: d.id, checked: [], errors: [signal.aborted ? '整体预算已用完，引用校验未完成' : String(error)] })); }
  const diagramSources = documents.flatMap(d => [...d.content.matchAll(/```plantuml\s*\n([\s\S]*?)```/gi)].map((match, index) => ({ document_id: d.id, index, source: match[1] })));
  const diagrams: any[] = [];
  for (const diagram of diagramSources) {
    if (!options.diagrams || signal.aborted) { diagrams.push({ ...diagram, status: 'unverified', reason: signal.aborted ? '整体预算已用完，图未验证' : '本次未启用真实渲染' }); continue; }
    const result = await renderPlantUml(diagram.source, { timeoutMs: Math.min(10_000, Math.max(1, (options.deadline ?? Date.now() + 10_000) - Date.now())) });
    diagrams.push({ ...diagram, status: result.error ? 'unverified' : result.syntax_error ? 'failed' : 'passed', error: result.error });
  }
  const facts = assessFacts(markdown);
  const reads = events.filter(e => e.kind === 'tool_finished' && e.payload.name === 'component_source' && e.payload.input?.action === 'read' && e.payload.is_error === false);
  const lateLine = SOURCE_FILES['repo-1']['src/service/cancellation.ts'].split('\n').findIndex(line => line.includes("response.status === 'unknown'")) + 1;
  const sourceCoverage = [
    { name: '读取400行后的未知支付结果分支', passed: reads.some(e => e.payload.input.component_id === 'repo-1' && e.payload.input.path === 'src/service/cancellation.ts' && new RegExp(`^${lateLine}:`, 'm').test(String(e.payload.result))) },
    { name: '读取次要定时业务入口', passed: reads.some(e => e.payload.input.component_id === 'repo-2' && e.payload.input.path === 'src/jobs/housekeeping.ts' && String(e.payload.result).includes('sweepExpiredReservations')) },
  ];
  const expected = options.profile === 'small' ? SMALL_DOCUMENTS : [];
  const checks = [
    { name: '研究明确完成', passed: job.status === 'done' },
    { name: '生成多个文档', passed: documents.length >= 3 },
    { name: '指定文档没有遗漏', passed: expected.every(want => documents.some(d => d.target_id === want.target_id && d.path === want.path)) },
    { name: '已登记步骤均已处理', passed: steps.length > 0 && steps.every(s => ['done', 'discarded'].includes(s.status)) },
    { name: '所有文档独立评审回读最新正文、源码及资料', passed: reviews.length > 0 && reviews.every(r => r.passed) },
    { name: '代码引用存在且通过固定版本校验', passed: references.length > 0 && references.every(r => r.checked.length > 0 && r.errors.length === 0) },
    { name: '存在PlantUML且真实渲染全部通过', passed: diagrams.length > 0 && diagrams.every(d => d.status === 'passed') },
    { name: '固定事实没有已知反例且各项关系已表达', passed: facts.every(f => f.status === 'supported_pattern') },
    { name: '没有把失败会话报告为全部成功', passed: !events.some(e => e.kind === 'session_ended' && e.payload.reason === 'failed') },
    ...sourceCoverage,
  ];
  return { contract_passed: checks.every(c => c.passed), quality_verified: false, semantic_review_required: true,
    scoring_note: '固定关系检查会拒绝已知倒置和无条件断言；未识别的表述需人工复核。自动通过不等于语义正确率，也不证明长时运行稳定。',
    checks, facts, reviews, references, diagrams, source_coverage: sourceCoverage, sessions: new Set(events.map(e => e.file)).size, events: events.length,
    rework: documents.filter(d => d.history.length).map(d => ({ document_id: d.id, revisions: d.history.map(h => h.revision).concat(d.revision) })),
    failed_sessions: events.filter(e => e.kind === 'session_ended' && e.payload.reason === 'failed').map(e => ({ file: e.file, payload: e.payload })),
    long_duration_stability: '未验证；一次小规模运行和受控重启不能代表48小时运行',
  };
}
