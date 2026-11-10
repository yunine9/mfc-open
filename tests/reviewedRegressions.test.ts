import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from "../src/taskService.ts";
import { reconcileRemoteDelivery } from "../src/remoteDeliveryReconcile.ts";
import { AnnotationStore } from "../src/annotations.ts";
import { OVERALL_STORY_ARTIFACT } from "../src/overallStoryStore.ts";
import { annotationClosure } from "../src/feedbackPolicy.ts";

test('review: opened MR with lost receipt must still observe remote and retire stale push question', async () => {
  const sha = 'b'.repeat(40);
  const summary: any = {
    id: 'task-review', status: 'waiting_for_human', workspace: mkdtempSync(join(tmpdir(), 'mfc-review-receipt-')),
    delivery: { mr_url: 'https://example.test/mr/1', mr_id: 1, source_branch: 'task-branch', target_branch: 'main' },
    waiting: { step: 'cloud_push_confirm' },
  };
  let observed = 0;
  await reconcileRemoteDelivery({
    summary, cwd: summary.workspace, repo: 'example', headers: {}, current: () => true,
    persist() {}, watch() {}, published() {}, settle: async () => {},
    retirePushQuestion() { delete summary.waiting; },
    gates: async () => ({ mrState: 'opened', sourceSha: sha, gates: [] }),
    observe: async () => { observed++; return { head: sha, sha, url: 'https://example.test/repo' }; },
  });
  assert.equal(observed, 1);
  assert.equal(summary.delivery.git_push?.sha, sha, 'remote push receipt must be restored');
  assert.equal(summary.waiting, undefined, 'stale push confirmation must be retired');
});

test('review: omitting ids must not let reviewer forward owner_reply annotations', async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'mfc-review-permission-')),
    provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('review permission', { account: 'owner' }).id;
  const item = service.addAnnotation(id, { author: 'reviewer', artifact: 'spec.md', file: 'spec.md',
    line: 1, anchor: 'scope', note: '请责任人决定是否调整范围', kind: 'doc', route: 'owner_reply' });
  service.tasks.get(id).summary.status = 'waiting_for_human';
  await assert.rejects(() => service.sendAnnotations(id, [item.id], 'reviewer'), /责任人/);
  let failure: unknown;
  try { await service.sendAnnotations(id, undefined, 'reviewer'); } catch (error) { failure = error; }
  const current = service.listAnnotations(id).items.find((row: any) => row.id === item.id);
  assert.ok(failure, 'omitting ids must enforce the same owner-only decision');
  assert.equal(current.route, 'owner_reply');
  assert.equal(current.status, 'draft');
});

test('review: canceled task must remain read-only for annotation edits', async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'mfc-review-cancel-')),
    provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('canceled review', { account: 'owner' }).id;
  const item = service.addAnnotation(id, { author: 'owner', artifact: 'spec.md', file: 'spec.md',
    line: 1, anchor: 'scope', note: 'original', kind: 'doc', route: 'owner_reply' });
  await service.cancel(id, 'owner');
  assert.throws(() => service.editAnnotation(id, item.id, 'changed after cancel', 'owner'), /停止/);
  assert.throws(() => service.dropAnnotation(id, item.id, 'owner'), /停止/);
});

for (const action of ['edit', 'delete']) test(`review: ${action} during send must not detach the delivered text from its record`, async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'mfc-review-send-')),
    provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('concurrent review', { account: 'owner' }).id;
  const state = service.tasks.get(id);
  state.summary.status = 'running';
  const store = service.annotations(state);
  const item = store.add({ author: 'reviewer', artifact: 'spec.md', file: 'spec.md',
    line: 1, anchor: 'scope', note: 'ORIGINAL_REQUIREMENT', kind: 'doc', route: 'agent' });
  let deliveredText = '';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  service.interrupt = async (_id: string, text: string) => { deliveredText = text; await held; return service.get(id); };
  const sending = service.sendAnnotations(id, [item.id], 'owner');
  await assert.rejects(service.sendAnnotations(id, [item.id], 'owner'), /正在发送/);
  await assert.rejects(service.replyToAnnotation(id, item.id, 'owner', '抢先自行答复'), /已交给 Agent/);
  const closure = annotationClosure(store.list()[0],
    { task_status: 'running', task_owner: 'owner', owner_controlled: true,
      review_ready: false, review_annotation_ids: [], archival: false },
    { username: 'owner', can_override: false, can_route_others: true });
  assert.equal(closure.text, '正在发送给 Agent');
  assert.equal(closure.can_route, false);
  assert.equal(closure.can_resolve, false);
  assert.equal(closure.receipt_missing, false, '交接中不能误报 Agent 缺少答复');
  let mutationBlocked = false;
  try {
    if (action === 'edit') service.editAnnotation(id, item.id, 'NEW_REQUIREMENT', 'owner');
    else service.dropAnnotation(id, item.id, 'owner');
  } catch { mutationBlocked = true; }
  release();
  const result = await sending;
  const current = store.list().find((row: any) => row.id === item.id);
  assert.equal(mutationBlocked, true, 'delivered original text must remain tied to the in-flight review item');
  assert.ok(deliveredText.includes('ORIGINAL_REQUIREMENT'));
  assert.deepEqual(result.sent, [item.id]);
  assert.equal(current.note, 'ORIGINAL_REQUIREMENT');
  assert.equal(current.status, 'sent');
});

test('记下后只有责任人可处置，旧路由、需求确认和 Story 均不额外授予作者权限', async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), 'mfc-review-owner-')),
    provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const id = service.create('权限矩阵', { account: 'owner' }).id;
  const state = service.tasks.get(id);
  state.summary.status = 'waiting_for_human';
  state.summary.waiting = { step: 'cloud_requirement_analysis_confirm' };
  for (const artifact of ['spec.md', '__task_requirement__', OVERALL_STORY_ARTIFACT]) {
    for (const route of [undefined, 'agent', 'owner_reply', 'owner_decision', 'memory']) {
      const item = service.annotations(state).add({ author: 'reviewer', artifact, file: artifact,
        line: 1, anchor: 'scope', note: '请处理边界', kind: 'doc', route });
      for (const actor of ['reviewer', 'admin']) {
        for (const ids of [undefined, [], [item.id]]) await assert.rejects(
          service.sendAnnotations(id, ids, actor, true), /责任人/);
        assert.throws(() => service.editAnnotation(id, item.id, '未授权修改', actor), /责任人/);
        assert.throws(() => service.dropAnnotation(id, item.id, actor), /责任人/);
      }
      assert.deepEqual(service.annotations(state).list().find((row: any) => row.id === item.id), item);
    }
  }
});

test('发送失败释放原版交接，重读账本后仍能补充并重新发送', async t => {
  const options = { dataDir: mkdtempSync(join(tmpdir(), 'mfc-review-send-failure-')),
    provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 };
  const service: any = new TaskService(options); t.after(() => service.shutdown());
  const id = service.create('失败恢复', { account: 'owner' }).id;
  const state = service.tasks.get(id);
  state.summary.status = 'running';
  const store = service.annotations(state) as AnnotationStore;
  const item = store.add({ author: 'reviewer', artifact: 'spec.md', file: 'spec.md',
    line: 1, anchor: 'scope', note: '原意见', kind: 'doc' });
  service.interrupt = async () => { throw new Error('送达前失败'); };
  await assert.rejects(service.sendAnnotations(id, [item.id], 'owner'), /送达前失败/);
  const saved = new AnnotationStore(store.path).list()[0];
  assert.equal(saved.status, 'draft'); assert.equal(saved.agent_assigned, undefined);
  service.editAnnotation(id, item.id, '补充后再试', 'owner');
  service.interrupt = async () => service.get(id);
  await service.sendAnnotations(id, [item.id], 'owner');
  assert.equal(new AnnotationStore(store.path).list()[0].status, 'sent');
});

test('恢复时已送达保持原样，未完成交接释放后可以修改', async t => {
  const options = { dataDir: mkdtempSync(join(tmpdir(), 'mfc-review-restart-')),
    provider: 'test', model: 'test', modelsJson: {}, maxConcurrent: 0 };
  const service: any = new TaskService(options); t.after(() => service.shutdown());
  const task = service.create('中断交接', { account: 'owner' });
  const state = service.tasks.get(task.id);
  const store = service.annotations(state) as AnnotationStore;
  const add = () => store.add({ author: 'reviewer', artifact: 'spec.md', file: 'spec.md',
    line: 1, anchor: 'scope', note: '原意见', kind: 'doc' });
  const pending = add(), delivered = add();
  store.assignToAgent(pending.id, 'owner'); store.assignToAgent(delivered.id, 'owner');
  store.markSent([delivered.id], 'interrupt', 'owner');
  state.summary.status = 'paused'; service.persist(state); await service.shutdown();
  const restored: any = new TaskService(options); t.after(() => restored.shutdown()); restored.recover();
  restored.editAnnotation(task.id, pending.id, '恢复后补充', 'owner');
  assert.throws(() => restored.editAnnotation(task.id, delivered.id, '不能覆盖已送达', 'owner'), /已交给 Agent/);
});
