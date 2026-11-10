#!/usr/bin/env python3
"""CodeCheck scope and cache-state use cases."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.application.quality.codecheck_state import (  # noqa: E402
    build_completed_scan,
    build_manual_records,
    build_tool_error_scan,
    decide_scope,
    decide_scope_with_ports,
)
from mae_flow_core.quality.codecheck import (  # noqa: E402
    classify_scope,
)


class CodeCheckStateTests(unittest.TestCase):
    def test_scope_classification_is_conservative_and_explains_kept_rows(self):
        result = {
            "total": 4,
            "pairs": [
                ("R.WINDOW", "src/a.cpp", 12),
                ("R.FUNCTION", "src/a.cpp", 30),
                ("R.OUTSIDE", "src/a.cpp", 80),
                ("R.UNKNOWN", "other/a.cpp", 5),
            ],
            "commands": ["codecheck"],
            "log_path": "/logs/run.md",
        }

        scoped = classify_scope(
            result,
            changed_lines={"src/a.cpp": {10}},
            function_ranges={"src/a.cpp": [{
                "start": 20,
                "end": 40,
                "context": "void changed()",
            }]},
            slack=3,
        )

        self.assertTrue(scoped.classified)
        self.assertEqual(3, scoped.total)
        self.assertEqual(
            ("R.OUTSIDE", "src/a.cpp", 80),
            scoped.excluded[0].as_tuple(),
        )
        self.assertEqual(
            (
                "命中本次变更行±3",
                "位于本次变更函数 void changed()（行20-40）",
                "报告路径无法映射，保守纳入",
            ),
            tuple(reason.reason for reason in scoped.reasons),
        )

        unknown = classify_scope(
            {"total": 1, "pairs": [], "commands": []},
            changed_lines={},
            function_ranges={},
            slack=3,
        )
        self.assertFalse(unknown.classified)
        self.assertEqual(1, unknown.total)

    def test_moonlight_scan_conservatively_includes_all_candidates(self):
        scoped = classify_scope(
            {
                "total": 1,
                "pairs": [("R.FAR", "src/a.cpp", 90)],
                "commands": ["codecheck a"],
                "log_path": "/logs/run.md",
            },
            changed_lines={"src/a.cpp": {1}},
            function_ranges={},
            slack=3,
        )

        result = build_completed_scan(
            step="tw_codecheck",
            at="2026-07-30 02:00:00",
            head="abc123",
            files=("src/a.cpp",),
            scoped=scoped,
            moonlight=True,
            fallback_log_path="/logs/fallback.md",
        )

        record = result.as_record()
        self.assertEqual(1, result.moonlight_included)
        self.assertEqual(1, record["count"])
        self.assertEqual(
            [("R.FAR", "src/a.cpp", 90)],
            record["pairs"],
        )
        self.assertEqual([], record["scope_candidates"])
        self.assertFalse(record["scope_pending"])
        self.assertEqual(0, record["stock_excluded"])
        self.assertEqual(
            "月光模式无法人工裁决，保守纳入",
            record["scope_reasons"][0]["reason"],
        )

    def test_tool_error_scan_is_bound_to_step_head_and_files(self):
        result = build_tool_error_scan(
            step="verify_codecheck",
            at="2026-07-30 02:05:00",
            head="abc123",
            files=("src/a.cpp",),
            error="unknown format",
            log_path="/logs/run.md",
        )

        record = result.as_record()
        self.assertEqual("TOOL_ERROR", record["status"])
        self.assertEqual("abc123", record["head"])
        self.assertEqual(["src/a.cpp"], record["files"])
        self.assertEqual("unknown format", record["error"])
        self.assertEqual([], record["pairs"])

    def test_scope_decision_rejects_stale_or_unverified_choices(self):
        scan = {
            "step": "tw_codecheck",
            "head": "abc123",
            "pairs": [],
            "scope_candidates": [{
                "id": "W1",
                "rule": "R.ONE",
                "file": "src/a.cpp",
                "line": 8,
            }],
            "scope_pending": True,
        }

        stale = decide_scope(
            scan=scan,
            current_step="tw_codecheck",
            include_text="W1",
            none=False,
            ack="W1 涉及本次修改",
            ack_verified=True,
            source_changed=("src/a.cpp",),
            source_error="",
            at="now",
        )
        self.assertIn("首检后源码发生变化", stale.error)

        missing = decide_scope(
            scan=scan,
            current_step="tw_codecheck",
            include_text="W1",
            none=False,
            ack="确认",
            ack_verified=True,
            source_changed=(),
            source_error="",
            at="now",
        )
        self.assertIn("没有出现在用户确认原话", missing.error)

    def test_scope_decision_updates_a_copy_and_emits_exact_counts(self):
        scan = {
            "step": "tw_codecheck",
            "head": "abc123",
            "pairs": [("R.NEAR", "src/a.cpp", 2)],
            "scope_reasons": [],
            "scope_candidates": [{
                "id": "W1",
                "rule": "R.FAR",
                "file": "src/a.cpp",
                "line": 80,
            }, {
                "id": "W2",
                "rule": "R.OLD",
                "file": "src/b.cpp",
                "line": 9,
            }],
            "scope_pending": True,
        }

        decision = decide_scope(
            scan=scan,
            current_step="tw_codecheck",
            include_text="W1",
            none=False,
            ack="确认 W1 涉及本次修改",
            ack_verified=True,
            source_changed=(),
            source_error="",
            at="2026-07-30 02:10:00",
            authorization={
                "message_id": "scope-answer",
                "answer_sha256": "a" * 64,
            },
        )

        self.assertEqual("", decision.error)
        updated = decision.as_record()
        self.assertEqual(2, updated["count"])
        self.assertEqual(1, updated["stock_excluded"])
        self.assertEqual(["W1"], updated["scope_review"]["included"])
        self.assertEqual(
            "scope-answer",
            updated["scope_review"]["authorization"]["message_id"],
        )
        self.assertNotIn("ack", updated["scope_review"])
        self.assertFalse(updated["scope_pending"])
        self.assertEqual(
            [("R.NEAR", "src/a.cpp", 2)],
            scan["pairs"],
            "input scan must not be mutated",
        )
        self.assertEqual(("W1",), decision.included)
        self.assertEqual(("W2",), decision.excluded)

    def test_scope_ports_do_not_verify_ack_after_source_became_stale(self):
        calls = []
        scan = {
            "step": "tw_codecheck",
            "head": "abc123",
            "pairs": [],
            "scope_candidates": [{
                "id": "W1",
                "rule": "R.ONE",
                "file": "src/a.cpp",
                "line": 8,
            }],
            "scope_pending": True,
        }

        decision = decide_scope_with_ports(
            scan=scan,
            current_step="tw_codecheck",
            include_text="W1",
            none=False,
            ack="W1 涉及本次修改",
            authorization={
                "message_id": "scope-answer",
                "answer_sha256": "a" * 64,
            },
            source_changed_since=lambda head: (
                calls.append(("source", head))
                or (["src/a.cpp"], "")
            ),
            verify_ack=lambda ack: (
                calls.append(("ack", ack))
                or (True, "")
            ),
            now=lambda: "now",
        )

        self.assertIn("首检后源码发生变化", decision.error)
        self.assertEqual([("source", "abc123")], calls)

    def test_manual_records_bind_the_same_head_files_and_diagnostic(self):
        records = build_manual_records(
            step="rf_codecheck",
            head="abc123",
            files=("src/a.cpp",),
            count=2,
            diagnostic="/repo/diag.txt",
            diagnostic_sha256="def456",
            reason="format changed",
            authorization={
                "message_id": "manual-answer",
                "answer_sha256": "b" * 64,
            },
            at="2026-07-30 03:00:00",
            log_path="/logs/run.md",
        )

        self.assertEqual(2, records.manual["count"])
        self.assertEqual("def456", records.manual["diagnostic_sha256"])
        self.assertEqual(
            "manual-answer",
            records.manual["authorization"]["message_id"],
        )
        self.assertNotIn("ack", records.manual)
        self.assertTrue(records.scan["manual"])
        self.assertEqual(
            ("人工核对诊断文件:/repo/diag.txt",),
            records.scan["commands"],
        )
        self.assertEqual(records.manual["head"], records.scan["head"])


if __name__ == "__main__":
    unittest.main()
