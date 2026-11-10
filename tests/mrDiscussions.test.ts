import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMrDiscussions, observeMrDiscussions } from '../src/mrDiscussions.ts';
import { FeedbackStore } from '../src/feedbackStore.ts';

test('讨论请求覆盖正文超时，故障后下一次仍能查询；缺字段不能当作零意见', async t => {
  let mode = 'hang';
  const server = createServer((req, res) => {
    assert.match(req.url!, /mr=3384/);
    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    res.end(JSON.stringify(mode === 'bad' ? {} : { discussions: [{ id: 1, body: '补齐实现' }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const input = { platformUrl: `http://127.0.0.1:${(server.address() as any).port}`, repo: 'repo',
    delivery: { mr_url: 'https://codehub/repo/merge_requests/3384' }, timeoutMs: 80 };
  assert.equal((await fetchMrDiscussions(input)).kind, 'unavailable');
  mode = 'bad';
  assert.equal((await fetchMrDiscussions(input)).kind, 'unavailable');
  mode = 'good';
  assert.deepEqual(await fetchMrDiscussions(input), { kind: 'available', items: [{ id: '1', body: '补齐实现' }] });
});

test('观察进入原反馈索引且幂等，不覆盖在途状态；意见编辑后产生新版本', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mfc-discussion-observe-'));
  const items = [{ id: 'd1', body: '函数未实现' }, { id: 'd2', body: '补齐接口' }];
  observeMrDiscussions(workspace, 'a'.repeat(40), items);
  const store = new FeedbackStore(join(workspace, 'feedback', 'index.jsonl'));
  assert.equal(store.list().length, 2);
  const first = store.list().find(r => r.source_id === 'd1')!;
  store.resolve(first.id, 'awaiting_verification', '已修复，等检视人确认');
  observeMrDiscussions(workspace, 'b'.repeat(40), items);
  assert.equal(store.list().length, 2);
  assert.equal(store.list().find(r => r.id === first.id)!.status, 'awaiting_verification');
  observeMrDiscussions(workspace, 'b'.repeat(40), [{ ...items[0], body: '新补充说明' }]);
  assert.equal(store.list().length, 3);
});
