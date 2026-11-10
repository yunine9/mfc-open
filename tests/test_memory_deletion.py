import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parents[1] / "harness"))
from memory_runtime import Scheduler
spec = importlib.util.spec_from_file_location("deletion_sidecar", Path(__file__).parents[1] / "harness/memsearch-sidecar.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeletionTests(unittest.IsolatedAsyncioTestCase):
    async def test_remove_deletes_exact_source_and_rechecks_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            side = module.Sidecar.__new__(module.Sidecar)
            side.corpus = Path(tmp).resolve()
            target, other = side.corpus / "_knowledge/a.md", side.corpus / "_knowledge/b.md"
            rows = {str(target): {"a1", "a2"}, str(other): {"b1"}}
            side._indexed_files = {str(target): (1, 1), str(other): (1, 1)}
            side.ms = SimpleNamespace(_store=SimpleNamespace(
                hashes_by_source=lambda p: rows.get(p, set()),
                delete_by_source=lambda p: rows.pop(p, None)))
            replies = []
            scheduler = Scheduler(side, replies.append, lambda _: None)
            await scheduler.execute({"id": 1, "op": "remove", "path": str(target)})
            self.assertEqual(replies[0], {"id": 1, "ok": True, "chunks": 2})
            self.assertEqual(rows, {str(other): {"b1"}})
            self.assertNotIn(str(target), side._indexed_files)
            self.assertTrue((await side.remove({"path": str(target)}))["ok"])
            for path in [side.corpus / "memory.md", side.corpus / "_knowledge/../../outside.md", side.corpus / "_knowledge/not-markdown.json"]:
                with self.assertRaises(ValueError):
                    await side.remove({"path": str(path)})
            target.parent.mkdir(); target.write_text("仍被使用")
            with self.assertRaises(ValueError):
                await side.remove({"path": str(target)})

    async def test_residual_rows_are_not_reported_as_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            side = module.Sidecar.__new__(module.Sidecar)
            side.corpus = Path(tmp).resolve()
            side.ms = SimpleNamespace(_store=SimpleNamespace(hashes_by_source=lambda _: {"still-present"}, delete_by_source=lambda _: None))
            with self.assertRaisesRegex(RuntimeError, "尚未删除完整"):
                await side.remove({"path": str(side.corpus / "_knowledge/a.md")})

    async def test_remove_waits_until_inflight_index_has_finished(self):
        order, replies = [], []
        side = SimpleNamespace()
        scheduler = Scheduler(side, replies.append, lambda _: None)
        async def ingest(_):
            order.append("index-start")
            scheduler.submit({"id": 2, "op": "remove"})
            await side.yield_reads()
            order.append("index-finish")
            return {"ok": True}
        async def remove(_):
            order.append("remove")
            return {"ok": True}
        side.ingest, side.remove = ingest, remove
        await scheduler.execute({"id": 1, "op": "ingest"})
        await scheduler.execute(scheduler.queue.get()[2])
        self.assertEqual(order, ["index-start", "index-finish", "remove"])


if __name__ == "__main__":
    unittest.main()
