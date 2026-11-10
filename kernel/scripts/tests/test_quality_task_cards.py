#!/usr/bin/env python3
"""Tests for pure quality task-card contracts."""

import hashlib
import os
import sys
import unittest
from types import SimpleNamespace


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.task_cards import (  # noqa: E402
    TaskCardDocument,
    task_allowed,
    task_record,
)


class QualityTaskCardTests(unittest.TestCase):
    def test_allowed_steps_are_case_insensitive_by_kind(self):
        # 2026-08-25 编排瘦身:任务卡仅存于 standalone 独立任务。
        self.assertTrue(task_allowed("ut", "standalone_ut"))
        self.assertTrue(task_allowed("CODECHECK", "standalone_codecheck"))
        self.assertFalse(task_allowed("COMPILE", "build"))
        self.assertFalse(task_allowed("UT", "build"))

    def test_document_preserves_lines_without_a_return_receipt(self):
        document = TaskCardDocument(["# card", "line"])
        document.extend(["tail"])
        body = "# card\nline\ntail\n"
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        self.assertEqual(body, document.body())
        self.assertEqual(digest, document.digest())
        self.assertEqual(body, document.sealed_body())

    def test_task_record_detaches_mutable_inputs(self):
        files = ["src/main.cpp"]
        roots = ["src"]
        worktree_snapshot = {"generated/build.properties": "before"}
        record = task_record(
            step="build",
            path="/tmp/card.md",
            head="deadbeef",
            scope="core",
            precommit_review=True,
            initial_compile_net=2,
            source_snapshot={"src/main.cpp": "hash"},
            worktree_snapshot=worktree_snapshot,
            worktree_snapshot_valid=True,
            allowed_files=files,
            task_files=files,
            execution_roots=roots,
            lightcheck={"status": "CLEAN"},
            ut_targets={},
            unchanged_initial_dirty=["src/old.cpp"],
            at="2026-07-29 10:00:00",
        )
        files.append("src/later.cpp")
        roots.append(".")
        worktree_snapshot["generated/build.properties"] = "after"
        self.assertEqual(["src/main.cpp"], record["task_files"])
        self.assertEqual(["src"], record["execution_roots"])
        self.assertEqual(
            {"generated/build.properties": "before"},
            record["worktree_snapshot"],
        )
        self.assertTrue(record["worktree_snapshot_valid"])
        # 任务卡刻意不带版本指纹:收据新鲜度由真实源码变化裁决。工厂连形参都不再
        # 接收,避免下游比较看起来在做"绑定"其实恒为空值。
        self.assertNotIn("sha256", record)
        self.assertNotIn("issuance_id", record)
        for retired in ("digest", "issuance_id"):
            with self.subTest(parameter=retired):
                self.assertNotIn(
                    retired,
                    task_record.__kwdefaults__ or {},
                )
                self.assertNotIn(
                    retired,
                    task_record.__code__.co_varnames[
                        :task_record.__code__.co_kwonlyargcount + 1],
                )



class ProductionReceiptBindingTests(unittest.TestCase):
    """生产形态任务卡必须能认回自己签发的收据。

    历史缺陷:收据写入 ``task_sha256=""``(卡里没有该键的默认值),复用侧却拿
    ``task.get("sha256")`` 得到 ``None`` 去比,于是刚签发的收据也被判成"属于
    另一张卡"——编译/CodeCheck/UT 的收据复用整条失效,Agent 每次重答都要真跑一遍。
    """

    def _production_card(self):
        return task_record(
            step="build",
            path="/tmp/card.md",
            head="deadbeef",
            scope="",
            precommit_review=False,
            initial_compile_net=0,
            source_snapshot={},
            worktree_snapshot={},
            worktree_snapshot_valid=False,
            allowed_files=[],
            task_files=["src/a.cpp"],
            execution_roots=["src"],
            lightcheck={},
            ut_targets={},
            unchanged_initial_dirty=[],
            at="2026-08-07 10:00:00",
        )

    def test_compile_receipt_is_reusable_while_source_is_unchanged(self):
        from mae_flow_core.application.hooks import receipts

        task = self._production_card()
        context = SimpleNamespace(
            at="2026-08-07 10:00:00", head="deadbeef", source_snapshot=None)
        receipt = receipts.plan_compile_run_receipt(
            task, context, "make all", "OK", "output")

        self.assertIsNotNone(receipts.reusable_compile_run_receipt(
            receipt, task, "make all", "OK", changed_paths=()))
        self.assertIsNone(receipts.reusable_compile_run_receipt(
            receipt, task, "make all", "OK",
            changed_paths=("src/a.cpp",)))

    def test_ut_receipt_is_reusable_while_source_is_unchanged(self):
        from mae_flow_core.application.hooks import receipts

        task = self._production_card()
        context = SimpleNamespace(
            at="2026-08-07 10:00:00", head="deadbeef", source_snapshot=None)
        receipt = receipts.plan_ut_run_receipt(
            task, context, "ctest", {"passed": 3}, "3 passed")

        self.assertIsNotNone(receipts.reusable_ut_receipt(
            receipt, task, changed_paths=()))
        self.assertIsNone(receipts.reusable_ut_receipt(
            receipt, task, changed_paths=("src/a.cpp",)))

    def test_compile_contract_matches_its_own_receipt(self):
        from mae_flow_core.quality.compile_contract import _matching_receipt

        task = self._production_card()
        receipt = {
            "step": "build", "task_sha256": "", "task_issuance_id": "",
            "status": "OK", "build": "make all",
        }
        context = SimpleNamespace(
            reusable_receipts={"COMPILE_RUN": receipt},
            task=task, status="OK")

        self.assertIs(receipt, _matching_receipt(context, "make all"))

if __name__ == "__main__":
    unittest.main()
