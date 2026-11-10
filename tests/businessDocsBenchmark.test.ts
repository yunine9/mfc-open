import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createFixture, SOURCE_FILES } from '../harness/business-docs-benchmark/fixtures.ts';
import { assessFacts, assessReviewReads } from '../harness/business-docs-benchmark/scoring.ts';
import { cleanCredentials, exportData, modelSecrets, parseOptions, scrub } from '../harness/business-docs-benchmark/run.ts';

const correct = `已结算订单必须走冲正，不能直接取消。
已发货订单必须进入退货流程。
支付结果未知时必须由财务核对，确认结果前不得再次提交冲正。
取消未结算订单释放预留，减少 allocated；stockOnHand 保持不变。
定时任务检查 active 且已到期的预留，然后释放。
saleable = stockOnHand - allocated - safetyBuffer。
reserve 先检查可售库存，再查询已有编号；所以库存不足时重复请求仍会失败。`;

test('评分检查条件与结果关系；反转规则、增加无条件断言以及补充正确句子都不能掩盖错误', () => {
  assert.ok(assessFacts(correct).every(row => row.status === 'supported_pattern'));
  for (const contradiction of [
    '已结算订单可以直接取消。',
    '所有订单都直接取消。',
    '已发货订单可直接取消。',
    '支付结果未知时应自动重试一次。',
    '所有异常都必须重试。',
    '释放预留会增加实物库存。',
    '定时任务释放所有预留。',
    'saleable = stockOnHand - allocated + safetyBuffer。',
    '重复预留无条件幂等。',
  ]) assert.ok(assessFacts(correct + '\n' + contradiction).some(row => row.status === 'contradicted'), contradiction);
  const vocabulary = '已结算 未结算 已发货 冲正 退货 取消 未知 超时 人工 财务 核对 不得 再次 allocated stockOnHand active expiresAt 定时 过期 释放 saleable safetyBuffer';
  assert.ok(assessFacts(vocabulary).every(row => row.status === 'unverified'), '词汇齐全不等于关系正确');
  assert.equal(assessFacts(correct.replace('必须走冲正', '无需冲正')).find(r => r.id === 'settled-reversal')!.status, 'unverified');
});

test('独立评审必须成功回读最新文稿、源码和资料；失败读取或旧文稿不能通过', () => {
  const doc: any = { id: 'one', deleted: false };
  const step = { id: 'review', readonly: true, status: 'done', attempts: 1, result: { document_ids: ['one'] } };
  const event = (file: string, ts: string, name: string, input: unknown, error = false): any => ({ file, ts, eventId: 1, kind: 'tool_finished', payload: { name, input, is_error: error, result: 'non-empty' } });
  const events = [
    event('skill-runs/turn/coordinator/events.jsonl', '2026-10-01T00:00:01Z', 'knowledge_draft', { action: 'save', document: { id: 'one' } }),
    event('skill-runs/turn/steps/review/1/events.jsonl', '2026-10-01T00:00:02Z', 'knowledge_draft', { action: 'read', id: 'one' }),
    event('skill-runs/turn/steps/review/1/events.jsonl', '2026-10-01T00:00:03Z', 'component_source', { action: 'read', path: 'src/a.ts' }),
    event('skill-runs/turn/steps/review/1/events.jsonl', '2026-10-01T00:00:04Z', 'knowledge_material', { id: 'material' }),
  ];
  assert.equal(assessReviewReads(events, [step], [doc])[0].passed, true);
  assert.equal(assessReviewReads(events.map(e => e.payload.name === 'component_source' ? { ...e, payload: { ...e.payload, is_error: true } } : e), [step], [doc])[0].passed, false);
  assert.equal(assessReviewReads([...events, event(events[0].file, '2026-10-01T00:00:05Z', 'knowledge_draft', { action: 'save', document: { id: 'one' } })], [step], [doc])[0].passed, false);
  assert.equal(assessReviewReads(events, [{ ...step, readonly: false }], [doc])[0].passed, false);
  const automatic = { ...step, readonly: false, review: { instructions: 'check sources' }, review_attempts: 2, result: { document_ids: ['one'], review: { pass: true, feedback: 'checked' } } };
  const automaticEvents = events.map(e => ({ ...e, file: e.file.replace('/review/1/', '/review/review-2/') }));
  assert.equal(assessReviewReads(automaticEvents, [automatic], [doc])[0].passed, true);
  assert.equal(assessReviewReads(automaticEvents, [{ ...automatic, result: { ...automatic.result, review: { pass: false } } }], [doc])[0].passed, false);
});

test('固定源码是真实Git版本且可执行，400行后异常与小定时入口行为成立', async () => {
  const root = mkdtempSync(join(tmpdir(), 'business-benchmark-fixture-'));
  try {
    const fixture = createFixture(root);
    assert.equal(fixture.sources.length, 2); assert.ok(fixture.sources.every(s => /^[a-f\d]{40}$/.test(s.revision)));
    assert.ok(SOURCE_FILES['repo-1']['src/service/cancellation.ts'].split('\n').findIndex(line => line.includes('async reverseSettlement')) >= 400);
    const { ReservationService } = await import(pathToFileURL(join(root, 'repo-2/src/domain/reservations.ts')).href);
    const { sweepExpiredReservations } = await import(pathToFileURL(join(root, 'repo-2/src/jobs/housekeeping.ts')).href);
    const { CancellationService } = await import(pathToFileURL(join(root, 'repo-1/src/service/cancellation.ts')).href);
    const stock = new ReservationService(10, 3); const id = await stock.reserve('one', 2, 100);
    assert.equal(stock.saleable(), 5); await sweepExpiredReservations(stock, 99); assert.equal(stock.allocated, 2);
    await stock.reserve('two', 5, 100);
    await assert.rejects(stock.reserve('one', 2, 100), /insufficient_stock/, '余量检查发生在已有编号复用之前');
    await sweepExpiredReservations(stock, 100); assert.equal(stock.allocated, 0); assert.equal(stock.stockOnHand, 10);
    await stock.release(id, 'one'); assert.equal(stock.allocated, 0);
    let releases = 0;
    const cancellation = new CancellationService({ release: async () => { releases++; } }, { reverse: async () => ({ status: 'unknown' }) });
    assert.equal((await cancellation.cancel({ state: 'settled' })).status, 'reversal_required');
    assert.equal((await cancellation.cancel({ state: 'shipped' })).status, 'return_required');
    const order = { id: 'one', state: 'settled', amount: 10, reservationId: id };
    assert.deepEqual(await cancellation.reverseSettlement(order), { status: 'manual_check', retryAllowed: false });
    assert.equal(order.state, 'manual_check'); assert.equal(releases, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('配置凭据不进入保留产物，CLI必须指定新的输出目录和真实模型配置', () => {
  assert.throws(() => parseOptions([]), /output/);
  assert.throws(() => parseOptions(['--output', '/tmp/probe']), /models/);
  assert.equal(parseOptions(['--output', '/tmp/probe', '--prepare-only']).budgetMs, 300_000);
  assert.throws(() => parseOptions(['--output', '/tmp/probe', '--prepare-only', '--budget-ms', 'NaN']), /预算/);
  const secrets = modelSecrets({ providers: { p: { apiKey: 'fixture-secret-123', headers: { Authorization: 'Bearer fixture-auth-456' } } } });
  assert.equal(scrub('x fixture-secret-123 y Bearer fixture-auth-456', secrets), 'x [REDACTED] y [REDACTED]');
  const root = mkdtempSync(join(tmpdir(), 'business-benchmark-clean-'));
  try {
    mkdirSync(join(root, 'agent')); writeFileSync(join(root, 'agent/models.json'), 'fixture-secret-123');
    writeFileSync(join(root, 'agent/models-store.json'), 'fixture-secret-123');
    writeFileSync(join(root, 'events.jsonl'), JSON.stringify({ text: 'fixture-secret-123' }));
    exportData(root, join(root, 'export'), secrets);
    assert.equal(existsSync(join(root, 'export/agent/models.json')), false);
    assert.ok(!readFileSync(join(root, 'export/events.jsonl'), 'utf8').includes('fixture-secret-123'));
    cleanCredentials(root, secrets);
    assert.equal(existsSync(join(root, 'agent/models.json')), false); assert.equal(existsSync(join(root, 'agent/models-store.json')), false);
    assert.ok(!readFileSync(join(root, 'events.jsonl'), 'utf8').includes('fixture-secret-123'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
