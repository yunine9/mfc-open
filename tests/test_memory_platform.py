"""Exercise the actual sidecar merge/filter path without loading an embedding model."""
import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("sidecar", Path(__file__).parents[1] / "harness/memsearch-sidecar.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlatformMemoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_platform_and_repo_share_one_eligible_candidate_set(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            records = []
            for folder, ident, repo, scope in [
                ("a", "c-a-111", "a", "general"),
                ("ab", "c-b-222", "ab", "general"),
                ("_platform", "c-c-333", "origin", "platform"),
            ]:
                path = root / folder / (ident + ".md")
                path.parent.mkdir(exist_ok=True)
                path.write_text(f'---\nrepo: {repo}\nscope: {scope}\nreview_status: accepted\npaths: ["src/x"]\n---\nFact')
                records.append({"source": str(path), "score": 1, "content": ident})
            calls = []

            async def index_document(index, path, checkpoint=None):
                return 1

            async def retrieve(index, query, sources, limit, **kwargs):
                calls.append(set(sources))
                return [{**row, "semantic_score": .8} for row in records if row["source"] in sources]

            class Index:
                pass

            sidecar = module.Sidecar.__new__(module.Sidecar)
            sidecar.corpus = root
            sidecar.ms = Index()
            sidecar.schedule_index = None
            sidecar.yield_reads = None
            with patch.object(module, "retrieve", retrieve), patch.object(module, "index_document", index_document):
                await sidecar.reindex({})
                result = await sidecar.search({"query": "current evidence", "repo": "a"})
                self.assertEqual({hit["id"] for hit in result["hits"]}, {"c-a-111", "c-c-333"})
                self.assertEqual(calls, [{records[0]["source"], records[2]["source"]}])
                result = await sidecar.search({"query": "current evidence", "repo": "a", "path_prefix": "different"})
                self.assertEqual([hit["id"] for hit in result["hits"]], ["c-c-333"])

    async def test_unaccepted_legacy_and_revoked_hits_do_not_escape_or_get_reindexed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            records = []
            for suffix, status in [("111", "pending"), ("222", "accepted"), ("333", "rejected"), ("444", "")]:
                path = root / f"c-a-{suffix}.md"
                path.write_text(f"---\nrepo: a\nreview_status: {status}\n---\nAdvice")
                records.append({"source": str(path), "score": 1, "content": "stale"})
            indexed = []

            class Index:
                async def index_file(self, path):
                    indexed.append(path.name)
                    return 1

            sidecar = module.Sidecar.__new__(module.Sidecar)
            sidecar.corpus = root
            sidecar.ms = Index()
            sidecar.schedule_index = None
            sidecar.yield_reads = None
            async def retrieve(index, query, sources, limit, **kwargs):
                return [{**row, "semantic_score": .8} for row in records if row["source"] in sources]
            async def index_document(index, path, checkpoint=None):
                return await index.index_file(path)
            with patch.object(module, "retrieve", retrieve), patch.object(module, "index_document", index_document):
                await sidecar.reindex({})
                self.assertEqual([h["id"] for h in (await sidecar.search({"query": "retry"}))["hits"]], ["c-a-222"])
                self.assertEqual((await sidecar.reindex({}))["chunks"], 0)
            self.assertEqual(indexed, ["c-a-222.md"])
            self.assertEqual((await sidecar.ingest({"path": str(root / "c-a-111.md")}))["chunks"], 0)
            with self.assertRaises(ValueError):
                await sidecar.expand({"memory_id": "c-a-333"})


if __name__ == "__main__":
    unittest.main()
