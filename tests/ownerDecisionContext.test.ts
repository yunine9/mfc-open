import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanGate } from '../src/humanGate.ts';
import { AnnotationStore, type Annotation } from '../src/annotations.ts';
import { collectOwnerInstructions, submittedReviewInputs, projectOwnerInstructions, renderAgentDecision, readMrDiscussionInputs } from '../src/ownerDecisionContext.ts';
import { TaskService } from '../src/taskService.ts';
import { recordTaskHostInstruction, taskOwnerInstructions, refreshOwnerInputProjection, createTaskHostTools } from '../src/taskHostTools.ts';

test('task-21：真实决定账恢复后保留最终答复、问题语境和旧指令，原话不能被目标/回执替代', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-decision-'));
  const service = new TaskService({ dataDir: root, provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('虚拟化查询行为').id;
  const task = (service as any).tasks.get(id);
  task.summary.luban_account = 'owner'; task.cwd = join(task.summary.workspace, 'repo'); mkdirSync(task.cwd);
  const old = recordTaskHostInstruction(task.summary, '旧方案：虚拟化不执行脚本', 'owner');
  const gate = task.humanGate as HumanGate;
  const waiting = gate.createWaiting({ taskId: id, step: 'build', callId: 'D1-r2', questionInput: {
    purpose: 'clarification', questions: [{ question: '虚拟化是否执行 queryENE.sh 获取等效数？', options: ['执行', '不执行'] }] } });
  gate.resolve(waiting.waiting_id, { stateVersion: waiting.state_version, question: waiting.question,
    decision: '执行 queryENE.sh 取等效数，推翻旧简化方案', decidedBy: 'owner' });
  // 使用新 HumanGate 从盘重读，确保不是本轮会话记忆。
  task.humanGate = new HumanGate(gate.path);
  const host = (service as any).taskHostRuntime(task);
  const rows = taskOwnerInstructions(host);
  assert.ok(rows.find(row => row.id === old));
  const latest = rows.find(row => row.id === waiting.waiting_id)!;
  assert.match(latest.text, /用户答复[\s\S]*推翻旧简化方案[\s\S]*提问上下文[\s\S]*queryENE.sh/);
  refreshOwnerInputProjection(host);
  const projection = JSON.parse(readFileSync(join(task.cwd, '.mae-flow-work', 'owner-inputs.json'), 'utf8'));
  assert.deepEqual(projection.instructions, rows);
  assert.match(projection.recent_inputs, /推翻旧简化方案/);
  const tool = createTaskHostTools(host).find(tool => tool.name === 'task_context')!;
  const result = await (tool.execute as any)('lookup', { view: 'instructions', keyword: waiting.waiting_id });
  assert.match(JSON.stringify(result), /queryENE.sh/);
  assert.equal(service.list().length, 1);
  assert.equal(task.summary.status, 'queued');
  assert.equal(task.summary.delivery, undefined);
});

test('多题答复不混淆执行与保留，选择方案的原始说明可在恢复后查询', () => {
  const gate = new HumanGate(join(mkdtempSync(join(tmpdir(), 'owner-multi-')), 'waiting.json'));
  const waiting = gate.createWaiting({ taskId: 'task', step: 'build', callId: 'multi',
    preface: '方案二：虚拟化通过 queryENE.sh 获取等效数。',
    questionInput: { questions: [{ question: '采用哪个方案？', options: [{ label: '方案二', description: '执行脚本后判断' }] }, { question: '保留其他判断逻辑？', options: ['保留', '删除'] }] } });
  const resolved = gate.resolve(waiting.waiting_id, { stateVersion: waiting.state_version, decision: '',
    answers: { '采用哪个方案？': '方案二', '保留其他判断逻辑？': '保留' }, notes: '其他分支不动', decidedBy: 'owner' });
  const reply = renderAgentDecision(resolved);
  assert.match(reply, /采用哪个方案？：方案二\n保留其他判断逻辑？：保留/);
  assert.match(reply, /用户附言：其他分支不动/);
  const row = collectOwnerInstructions('owner', [], new HumanGate(gate.path).all())[0];
  assert.match(row.text, /方案二：虚拟化通过 queryENE.sh 获取等效数/);
  assert.match(row.text, /执行脚本后判断/);
  assert.ok(row.text.indexOf('用户答复') < row.text.indexOf('提问上下文'));
});

test('批注、附言、责任人答复/处置都保留来源，草稿和待送意见不自动送入 Agent', () => {
  const base = { id: 'a1', author: 'reviewer', created_at: '2026-09-12T00:00:00Z', artifact: 'spec', file: 'spec.md', line: 4,
    anchor: 'BEH-4 不执行脚本', note: '应执行脚本', kind: 'doc', status: 'draft' } as Annotation;
  assert.deepEqual(submittedReviewInputs([base]), []);
  assert.deepEqual(submittedReviewInputs([{ ...base, status: 'sent', sent_via: 'queued_decision' }]), []);
  const inputs = submittedReviewInputs([{ ...base, status: 'sent', sent_via: 'decision',
    agent_context: { text: '按 b3 最终答复补等效数', by: 'owner', at: '2026-09-12T01:00:00Z', revision: 0 },
    owner_reply: { text: '执行 queryENE.sh', author: 'owner', replied_at: '2026-09-12T02:00:00Z' },
    response: { revision: 0, outcome: 'fixed', summary: '错误机器口径：不执行', evidence: [], responded_at: '2026-09-12T03:00:00Z' } }]);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[0].actor, 'reviewer');
  assert.match(inputs[0].text, /不是最终需求裁决/);
  assert.doesNotMatch(JSON.stringify(inputs), /错误机器口径/);
  const closed = submittedReviewInputs([{ ...base, status: 'verified', resolution: {
    by: 'owner', revision: 0, outcome: 'not_adopted', reason: '这条建议不采纳', at: '2026-09-12T04:00:00Z' } }]);
  assert.match(JSON.stringify(closed), /这条建议不采纳/);
  const reopened = submittedReviewInputs([{ ...base, rework: 1, returned: 1 }]);
  assert.match(JSON.stringify(reopened), /旧闭环结论不再代表本轮通过/);
});

test('存量批注入口修改后立即刷新阅读副本，仍不改变送达状态', async t => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'owner-annotation-')), provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('测试说明').id;
  const task = (service as any).tasks.get(id); task.cwd = join(task.summary.workspace, 'repo'); mkdirSync(task.cwd);
  const store = (service as any).annotations(task) as AnnotationStore;
  const item = store.add({ author: '本地用户', file: 'spec.md', artifact: 'spec', line: 1, anchor: 'BEH-4', note: '执行脚本', kind: 'doc' });
  store.markSent([item.id], 'decision', '本地用户');
  const projected = () => JSON.parse(readFileSync(join(task.cwd, '.mae-flow-work', 'owner-inputs.json'), 'utf8')).instructions;
  assert.match(JSON.stringify(projected()), /执行脚本/);
  assert.equal(store.list()[0].status, 'sent');
  store.respond(item.id, { outcome: 'fixed', summary: '已修改', evidence: [] });
  store.reopen(item.id, '本地用户');
  const reopened = store.list()[0];
  const notice = projected().find((row: any) => row.source === 'review_reopened');
  assert.equal(notice.actor, '本地用户');
  assert.equal(notice.at, reopened.reopened?.at);
  assert.equal(reopened.status, 'draft');
});

test('长会话后可按需找回已处理意见原文及处置，不把它当新待办或永久禁令', async t => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'owner-long-history-')), provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const task = (service as any).tasks.get(service.create('实现当前需求').id);
  task.cwd = join(task.summary.workspace, 'repo'); mkdirSync(task.cwd);
  const store = (service as any).annotations(task) as AnnotationStore;
  const item = store.add({ author: '本地用户', file: 'build.log', artifact: 'code', line: 1,
    anchor: 'build output', note: '撤出这次误暂存的日志，后续不要提交构建日志', kind: 'code' });
  store.markSent([item.id], 'decision', '本地用户');
  store.respond(item.id, { outcome: 'fixed', summary: '日志已撤出暂存，保留本地文件', evidence: ['git diff --cached 不含该日志'] });
  store.verify(item.id, '本地用户');
  for (let i = 0; i < 80; i++) recordTaskHostInstruction(task.summary, `后续补充需求 ${i}`, '本地用户');
  const recovered = new AnnotationStore(store.path);
  const review = submittedReviewInputs(recovered.list()).find(row => row.id === `annotation:${item.id}:r0`)!;
  assert.match(review.text, /已处理/);
  assert.match(review.text, /后续不要提交构建日志/);
  const host = (service as any).taskHostRuntime(task);
  refreshOwnerInputProjection(host);
  const projection = JSON.parse(readFileSync(join(task.cwd, '.mae-flow-work', 'owner-inputs.json'), 'utf8'));
  assert.ok(projection.instructions.some((row: any) => row.id === review.id));
  assert.doesNotMatch(projection.recent_inputs, /撤出这次误暂存的日志/);
  const tool = createTaskHostTools(host).find(tool => tool.name === 'task_context')!;
  const result = await (tool.execute as any)('lookup-old-review', { view: 'instructions', keyword: item.id });
  assert.match(JSON.stringify(result), /已处理[\s\S]*后续不要提交构建日志/);
  assert.equal(recovered.list()[0].status, 'verified');
  assert.equal(task.summary.delivery_selection, undefined);
});

test('入口拒绝的插话不进入后续决定上下文', async t => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'owner-rejected-')), provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('保留当前行为').id;
  const task = (service as any).tasks.get(id);
  await assert.rejects(service.interrupt(id, '这个请求未被送出', '本地用户'), /没有在跑/);
  task.summary.status = 'waiting_for_human';
  await assert.rejects(service.interrupt(id, '决定卡之外未送出的改口', '本地用户'), /决定卡/);
  assert.deepEqual(taskOwnerInstructions((service as any).taskHostRuntime(task)).map(row => row.id), ['requirement']);
});

test('批注送达附带的平台回执指令不能冒充责任人插话', async t => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'owner-review-batch-')), provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  const id = service.create('虚拟化行为').id;
  const task = (service as any).tasks.get(id);
  t.after(async () => { task.driver = undefined; await service.shutdown(); });
  task.summary.status = 'running';
  let delivered = '';
  task.driver = { steer: async (text: string) => { delivered = text; } };
  const store = (service as any).annotations(task) as AnnotationStore;
  const item = store.add({ author: '本地用户', file: 'spec.md', artifact: 'spec', line: 1, anchor: 'BEH-4', note: '执行 queryENE.sh', kind: 'doc' });
  const result = await service.sendAnnotations(id, [item.id], '本地用户');
  assert.deepEqual(result.sent, [item.id]);
  assert.match(delivered, /queryENE.sh/);
  const rows = taskOwnerInstructions((service as any).taskHostRuntime(task));
  assert.equal(rows.filter(row => row.source === 'message').length, 1, '原始需求之外没有伪造的用户插话');
  assert.equal(rows.filter(row => row.source === 'review').length, 1);
});

test('协作者决定和未完成卡不取得责任人身份；阅读副本不可写也不形成门禁', () => {
  const rows = collectOwnerInstructions('owner', [], [{ status: 'resolved', decided_by: 'other', question: {}, decision: '建议修改', waiting_id: 'other-1', resolved_at: '2026-09-12T00:00:00Z' } as any, { status: 'waiting' } as any]);
  assert.equal(rows.length, 1); assert.equal(rows[0].actor, 'other'); assert.equal(rows[0].source, 'collaborator_decision');
  assert.match(projectOwnerInstructions('/dev/null', 'task', []), /副本暂不可写/);
  const missing = join(mkdtempSync(join(tmpdir(), 'owner-missing-')), 'reclaimed-repo');
  assert.match(projectOwnerInstructions(missing, 'task', []), /工作目录尚未就绪/);
  assert.equal(existsSync(missing), false);
});

test('MR 原始意见与跨仓通知可恢复读取，显示名和观察时间不冒充责任人决定', async t => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'owner-external-')), provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('模块行为').id;
  const task = (service as any).tasks.get(id); task.summary.luban_account = 'owner';
  task.summary.cross_repository_updates = [{ id: 'cross-one', author: 'owner', text: '接口改为等效数', source_task_id: 'parent', created_at: '2026-09-12T00:00:00Z' }];
  const path = join(task.summary.workspace, 'reviews', 'observed-discussions.json'); mkdirSync(join(task.summary.workspace, 'reviews'));
  writeFileSync(path, JSON.stringify([{ id: 'mr-one', author: 'owner', body: '应执行 queryENE.sh' }]));
  const host = (service as any).taskHostRuntime(task);
  const rows = taskOwnerInstructions(host);
  assert.match(rows.find(row => row.id === 'cross-one')!.text, /接口改为等效数/);
  const mr = rows.find(row => row.id === 'mr-discussion:mr-one')!;
  assert.equal(mr.actor, 'MR 显示名 owner'); assert.equal(mr.at, '');
  assert.match(mr.text, /未知，不能据此推断覆盖顺序/);
  writeFileSync(path, JSON.stringify([{ id: 'mr-one', body: '补充说明', updated_at: '2026-09-12T09:00:00+08:00' }]));
  assert.equal(readMrDiscussionInputs(task.summary.workspace)[0].at, '2026-09-12T01:00:00.000Z');
  writeFileSync(path, '[]');
  assert.deepEqual(readMrDiscussionInputs(task.summary.workspace), [], '观察快照已空时不复活旧讨论');
});
