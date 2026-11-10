#!/usr/bin/env python3
"""UT audit/reuse artifact receipts remain distinct from test execution."""

import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.tool_transcript import ToolCall  # noqa: E402
from mae_flow_core.quality.ut_artifacts import (  # noqa: E402
    build_receipt,
    merge_receipts,
    receipt_has_artifact,
    successful_direct_paths,
    task_contract,
)
from mae_flow_core.workflow.quality_executions import (  # noqa: E402
    record_quality_execution,
    ut_artifact_receipts,
)


def call(name, path):
    return ToolCall(
        call_id=name + path, name=name, input={"path": path},
        result_seen=True, is_error=False, result="ok")


class UtArtifactTests(unittest.TestCase):
    def test_task_freezes_active_coverage_targets(self):
        contract = task_contract(
            {"src/a.py": [{"start": 1, "end": 2, "context": "send"}]},
            (("src/a.py:1-2 | send",),))
        self.assertEqual(
            ["src/a.py:1-2 | send"], contract["coverage_targets"])
        for field in (
                "inspected_existing", "added_test_paths",
                "modified_test_paths", "test_digest"):
            self.assertIn(field, contract)

    def test_pi_path_and_legacy_file_path_are_both_observable(self):
        with tempfile.TemporaryDirectory() as root:
            reads, writes = successful_direct_paths((
                call("Read", os.path.join(root, "tests/a_test.py")),
                ToolCall(
                    call_id="edit", name="Edit",
                    input={"file_path": "tests/b_test.py"},
                    result_seen=True, is_error=False, result="ok"),
            ), root)
        self.assertEqual(("tests/a_test.py",), reads)
        self.assertEqual(("tests/b_test.py",), writes)

    def test_existing_tests_can_be_reused_without_manufacturing_diff(self):
        task = {
            "step": "verify_ut", "head": "a" * 40, "path": "card.md",
            "ut_artifact_contract": task_contract({}, (("send",),)),
        }
        receipt = build_receipt(
            task, inspected_paths=("tests/a_test.py",),
            changed_test_paths=(),
            existed_at_head=lambda path: path == "tests/a_test.py",
            fingerprint=lambda path: "blob:" + path,
            invocation_id="ut-1", at="2026-08-20 10:00:00")
        self.assertTrue(receipt_has_artifact(receipt))
        self.assertEqual(["tests/a_test.py"], receipt["inspected_existing"])
        self.assertEqual([], receipt["added_test_paths"])
        self.assertEqual([], receipt["modified_test_paths"])
        self.assertEqual(["send"], receipt["coverage_targets"])

    def test_receipts_classify_changes_and_merge_batches(self):
        task = {
            "step": "verify_ut", "head": "a", "path": "card.md",
            "ut_artifact_contract": task_contract({}, (("send",),)),
        }
        receipt = build_receipt(
            task, inspected_paths=(),
            changed_test_paths=("tests/old_test.py", "tests/new_test.py"),
            existed_at_head=lambda path: path.endswith("old_test.py"),
            fingerprint=lambda path: "blob:" + path,
            invocation_id="ut-1", at="now")
        self.assertEqual(["tests/new_test.py"], receipt["added_test_paths"])
        self.assertEqual(["tests/old_test.py"], receipt["modified_test_paths"])
        merged = merge_receipts((receipt,))
        self.assertTrue(receipt_has_artifact(merged))
        self.assertEqual(["send"], merged["coverage_targets"])

    def test_quality_ledger_persists_artifact_separately_from_run_success(self):
        with tempfile.TemporaryDirectory() as root:
            state_path = os.path.join(root, ".mae-flow.json")
            receipt = {
                "schema": "mae-flow-ut-artifact/1",
                "inspected_existing": ["tests/a_test.py"],
                "added_test_paths": [], "modified_test_paths": [],
                "test_digest": "d" * 64, "coverage_targets": ["send"],
            }
            record_quality_execution(
                state_path, "UT", "verify_ut", "ut-1", "", False,
                {"kind": "UT"}, "now", details={"ut_artifact": receipt})
            self.assertEqual(
                (receipt,),
                ut_artifact_receipts(state_path, "verify_ut"))


if __name__ == "__main__":
    unittest.main()
