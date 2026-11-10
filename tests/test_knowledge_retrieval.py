"""Deterministic boundary tests; actual model quality is tested by the local probe."""
import importlib.util
import json
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).parents[1] / "harness"))

spec = importlib.util.spec_from_file_location("retrieval", Path(__file__).parents[1] / "harness/knowledge_retrieval.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class RetrievalTests(unittest.IsolatedAsyncioTestCase):
    async def run_search(self, query, dense, keywords, sources, model=m.BGE_MODEL, sections=False):
        calls = []
        class Client:
            def get_collection_stats(self, _): return {"row_count": 20}
            def search(self, **kwargs):
                calls.append(kwargs)
                return [dense if kwargs['anns_field'] == 'embedding' else keywords]
        async def embed(_): return [[1, 0]]
        ms = SimpleNamespace(_embedder=SimpleNamespace(model_name=model, embed=embed),
                             _store=SimpleNamespace(_client=Client(), _collection='test'))
        hits = await m.retrieve(ms, query, sources, 5, sections=sections)
        for call in calls:
            self.assertEqual(json.loads(call['filter'].removeprefix('source in ')), list(sources))
        return hits

    def hit(self, source, score, content, chunk='1'):
        return {'distance': score, 'entity': {'source': source, 'content': content,
                                               'heading': '', 'chunk_hash': source + chunk}}

    async def test_irrelevant_nearest_neighbor_is_not_an_answer(self):
        hits = await self.run_search('盆栽浇水', [self.hit('a', .38, 'C++ 回调')], [], {'a': {}})
        self.assertEqual(hits, [])

    async def test_no_cross_scope_rank_tie_and_one_asset_per_result(self):
        dense = [self.hit('global', .8, '正确结论'), self.hit('global', .79, '正确结论的例外', '2'), self.hit('repo', .51, '其他内容')]
        hits = await self.run_search('具体问题', dense, [], {'global': {}, 'repo': {}})
        self.assertEqual([h['source'] for h in hits], ['global', 'repo'])

    async def test_unified_search_keeps_distinct_sections_of_one_manual(self):
        dense = [self.hit('manual', .8, '规则', '1'), self.hit('manual', .79, '例外', '2')]
        hits = await self.run_search('规则及例外', dense, [], {'manual': {}}, sections=True)
        self.assertEqual([h['content'] for h in hits], ['规则', '例外'])

    async def test_language_name_does_not_overrule_cross_language_semantics(self):
        good = self.hit('manual', .8, 'Header dependencies', 'good')
        noise = self.hit('manual', .51, 'C++ version', 'noise')
        hits = await self.run_search('C++ 头文件依赖', [good, noise], [noise], {'manual': {}}, sections=True)
        self.assertEqual(hits[0]['content'], 'Header dependencies')

    async def test_exact_code_identifier_is_not_lost_to_semantic_floor(self):
        row = self.hit('a', .2, 'ResolveFmaFileKey 返回文件标识')
        hits = await self.run_search('ResolveFmaFileKey', [row], [row], {'a': {}})
        self.assertEqual([h['source'] for h in hits], ['a'])
        # A generic English term alone is not a reason to bypass the floor.
        self.assertEqual(await self.run_search('callback', [self.hit('a', .2, 'callback')], [], {'a': {}}), [])

    async def test_other_model_does_not_borrow_bge_threshold(self):
        hits = await self.run_search('问题', [self.hit('a', .4, '候选')], [], {'a': {}}, model='another-model')
        self.assertEqual(len(hits), 1)


class IndexReplacementTests(unittest.IsolatedAsyncioTestCase):
    async def test_interrupted_long_index_reuses_completed_chunks_and_keeps_old_until_done(self):
        import tempfile
        if importlib.util.find_spec('memsearch') is None:
            self.skipTest('requires memsearch environment')
        from memsearch.chunker import compute_chunk_id
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'guide.md'
            path.write_text('# 规则\n```cpp\n' + ''.join(f'int value_{i} = {i};\n' for i in range(300)) + '```\n尾部例外必须保留。')
            stored, calls, deleted = {'legacy'}, [], []
            interrupted = True
            async def embed(chunks):
                if interrupted and calls:
                    raise TimeoutError('本次预算用完')
                for chunk in chunks:
                    key = compute_chunk_id(chunk.source, chunk.start_line, chunk.end_line, chunk.content_hash, 'test')
                    calls.append(key)
                    stored.add(key)
                return len(chunks)
            store = SimpleNamespace(hashes_by_source=lambda _: set(stored), delete_by_hashes=lambda keys: deleted.extend(keys))
            ms = SimpleNamespace(_embedder=SimpleNamespace(model_name='test'), _store=store, _embed_and_store=embed)
            with self.assertRaises(TimeoutError):
                await m.index_document(ms, path)
            self.assertEqual(deleted, [])
            completed = calls[0]
            interrupted = False
            await m.index_document(ms, path)
            self.assertEqual(calls.count(completed), 1, '完成的片段不重复推理')
            self.assertGreater(len(calls), 1)
            self.assertEqual(deleted, ['legacy'])

    async def test_reindex_drops_stale_titles_only_after_success(self):
        import tempfile
        if importlib.util.find_spec('memsearch') is None:
            self.skipTest('requires memsearch environment')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'guide.md'
            path.write_text('# 手册\n\n## 规则\n必须关闭自有句柄。\n\n## 例外\n借用句柄不能关闭。')
            embedded=[];deleted=[]
            async def embed(chunks):
                embedded.extend(chunks)
                return len(chunks)
            store=SimpleNamespace(hashes_by_source=lambda _: {'old-title','old-body'},delete_by_hashes=lambda hashes:deleted.extend(hashes))
            ms=SimpleNamespace(_embedder=SimpleNamespace(model_name='test'),_store=store,_embed_and_store=embed)
            await m.index_document(ms,path)
            self.assertEqual(set(deleted),{'old-title','old-body'})
            self.assertEqual(len(embedded),2)
            self.assertTrue(all(c.heading.startswith('手册 > ') for c in embedded))
            self.assertEqual(embedded[0].content.split('\n',2)[2], '\n'.join(path.read_text().splitlines()[embedded[0].start_line-1:embedded[0].end_line]))
            deleted.clear()
            async def fail(_):raise RuntimeError('embedding unavailable')
            ms._embed_and_store=fail
            with self.assertRaises(RuntimeError):await m.index_document(ms,path)
            self.assertEqual(deleted,[])

if __name__ == '__main__': unittest.main()
