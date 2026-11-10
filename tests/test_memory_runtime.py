import asyncio
import importlib.util
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "harness"))
from memory_runtime import Scheduler, Request, CURRENT, BoundedClient, local_client_options
spec = importlib.util.spec_from_file_location("sidecar", Path(__file__).parents[1] / "harness/memsearch-sidecar.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def scheduler(self, side=None, capacity=128):
        replies, logs = [], []
        side = side or SimpleNamespace()
        return Scheduler(side, replies.append, logs.append, capacity), replies, logs

    async def test_expired_request_never_runs_and_next_search_works(self):
        calls = []
        async def search(req):
            calls.append(req['id'])
            return {'ok': True, 'hits': []}
        scheduler, replies, logs = self.scheduler(SimpleNamespace(search=search))
        await scheduler.execute({'id': 1, 'op': 'search', 'deadline_ms': time.time()*1000-1})
        await scheduler.execute({'id': 2, 'op': 'search'})
        self.assertEqual(calls, [2])
        self.assertIn('TimeoutError', replies[0]['error'])
        self.assertTrue(replies[1]['ok'])
        self.assertEqual(json.loads(logs[0])['outcome'], 'TimeoutError')

    async def test_search_runs_between_index_batches_with_parent_deadline_restored(self):
        order = []
        async def search(req):
            order.append('search')
            self.assertEqual(CURRENT.get().payload['id'], 2)
            return {'hits': []}
        side = SimpleNamespace(search=search)
        scheduler, replies, logs = self.scheduler(side)
        async def ingest(req):
            order.append('index-1')
            scheduler.submit({'id': 2, 'op': 'search'})
            await side.yield_reads()
            self.assertEqual(CURRENT.get().payload['id'], 1)
            order.append('index-2')
            return {'ok': True}
        side.ingest = ingest
        await scheduler.execute({'id': 1, 'op': 'ingest'})
        self.assertEqual(order, ['index-1', 'search', 'index-2'])
        self.assertEqual([r['id'] for r in replies], [2, 1])

    async def test_queue_is_bounded_and_background_index_deduplicated(self):
        scheduler, replies, _ = self.scheduler(capacity=2)
        scheduler.schedule_index(Path('/a'))
        scheduler.schedule_index(Path('/a'))
        scheduler.submit({'id': 1, 'op': 'search'})
        scheduler.submit({'id': 2, 'op': 'search'})
        self.assertEqual(scheduler.queue.qsize(), 2)
        self.assertIn('繁忙', replies[0]['error'])
        self.assertEqual(scheduler.queue.get()[2]['id'], 1)

    async def test_search_does_not_index_or_return_edited_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            side = m.Sidecar.__new__(m.Sidecar)
            side.corpus = Path(tmp).resolve()
            side._indexed_files = {}
            queued = []
            side.schedule_index = queued.append
            side.ms = object()
            old, ready = side.corpus/'a.md', side.corpus/'b.md'
            for path in [old, ready]:
                path.write_text(f'---\nknowledge_id: {path.stem}\nasset_status: published\n---\n# 规范\n资料\n')
            stat = ready.stat()
            side._indexed_files[str(ready)] = (stat.st_mtime_ns, stat.st_size)
            seen = []
            async def retrieve(ms, query, sources, *args, **kwargs):
                seen.extend(sources)
                return []
            with patch.object(m, 'retrieve', retrieve):
                result = await side.search({'query': '规范', 'sources': [{'id': p.stem, 'path': str(p)} for p in [old, ready]]})
            self.assertEqual(seen, [str(ready)])
            self.assertEqual(queued, [old])
            self.assertEqual(result['pending_sources'], 1)
            result = await side.search({'query': '规范', 'sources': [{'id': 'a', 'path': str(old)}]})
            self.assertIn('索引正在准备', result['error'])

    async def test_rpc_uses_remaining_deadline_and_expired_call_not_sent(self):
        calls = []
        client = BoundedClient(SimpleNamespace(search=lambda **kw: calls.append(kw), create_schema=lambda: 'schema'))
        req = Request({'deadline_ms': time.time()*1000+500})
        token = CURRENT.set(req)
        try:
            client.search(collection_name='test')
            self.assertGreater(calls[0]['timeout'], 0)
            self.assertLessEqual(calls[0]['timeout'], .5)
            self.assertEqual(client.create_schema(), 'schema')
            req.deadline = time.time()-1
            with self.assertRaises(TimeoutError):
                client.search()
            self.assertEqual(len(calls), 1)
        finally:
            CURRENT.reset(token)
        self.assertIn('database_ms', req.timings)

    async def test_logs_do_not_include_query_and_eof_drains_requests(self):
        async def search(req): return {'ok': True, 'hits': []}
        scheduler, replies, logs = self.scheduler(SimpleNamespace(search=search))
        await scheduler.run(io.StringIO(json.dumps({'id': 1, 'op': 'search', 'query': 'SECRET'})+'\n'))
        self.assertEqual(len(replies), 1)
        self.assertNotIn('SECRET', logs[0])
        self.assertIn('queue_ms', json.loads(logs[0]))

    async def test_client_options_are_scoped_to_startup(self):
        seen = []
        def original(**kwargs):
            seen.append(kwargs)
            return object()
        fake = SimpleNamespace(MilvusClient=original)
        with patch.dict(sys.modules, {'pymilvus': fake}):
            with local_client_options():
                fake.MilvusClient(uri='/test.db')
            self.assertIs(fake.MilvusClient, original)
        self.assertFalse(seen[0]['grpc_options']['grpc.keepalive_permit_without_calls'])
        self.assertEqual(seen[0]['grpc_options']['grpc.keepalive_time_ms'], 300_000)
        self.assertEqual(seen[0]['timeout'], 10)

    async def test_expired_read_is_skipped_between_index_batches(self):
        calls = []
        async def search(req):
            calls.append(req['id'])
            return {'hits': []}
        scheduler, replies, _ = self.scheduler(SimpleNamespace(search=search))
        scheduler.submit({'id': 1, 'op': 'search', 'deadline_ms': time.time()*1000-1})
        scheduler.submit({'id': 2, 'op': 'search'})
        await scheduler.yield_reads()
        self.assertEqual(calls, [2])
        self.assertIn('TimeoutError', replies[0]['error'])

    async def test_health_checks_database_not_just_process(self):
        side = m.Sidecar.__new__(m.Sidecar)
        side.corpus = Path('/unused')
        def broken(_): raise RuntimeError('database unavailable')
        side.ms = SimpleNamespace(_store=SimpleNamespace(_collection='test', _client=SimpleNamespace(get_collection_stats=broken)))
        with self.assertRaisesRegex(RuntimeError, 'database unavailable'):
            await side.health({})

if __name__ == '__main__': unittest.main()
