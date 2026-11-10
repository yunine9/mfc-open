#!/usr/bin/env python3
"""Tests for the pure GRILL Agent contract."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.agent_contracts import (  # noqa: E402
    AgentContractContext,
)
from mae_flow_core.quality.grill_contract import (  # noqa: E402
    evaluate_grill_contract,
)
from mae_flow_core.quality.tool_transcript import ToolCall  # noqa: E402


def read_call(name="Read", seen=True, error=False):
    return ToolCall(
        call_id="read",
        name=name,
        input={"file_path": "requirements.md"},
        result_seen=seen,
        is_error=error,
        result="requirements",
    )


class GrillContractTests(unittest.TestCase):
    def context(self, status, report, calls=()):
        return AgentContractContext(
            kind="GRILL",
            status=status,
            report=report,
            task={"stage": "design"},
            config={},
            calls=tuple(calls),
            changed_paths=(),
        )

    def test_clear_requires_a_successful_read_and_zero_gaps(self):
        decision = evaluate_grill_contract(self.context(
            "CLEAR",
            "STAGE: design\nGAPS_FOUND: 0",
            [read_call()],
        ))
        self.assertTrue(decision.accepted)

        unread = evaluate_grill_contract(self.context(
            "CLEAR",
            "STAGE: design\nGAPS_FOUND: 0",
        ))
        self.assertIn("transcript 无任何成功的 Read/Grep/Glob", unread.reason)

    def test_failed_or_unseen_read_does_not_prove_review(self):
        for call in (read_call(seen=False), read_call(error=True)):
            with self.subTest(call=call):
                decision = evaluate_grill_contract(self.context(
                    "CLEAR",
                    "STAGE: design\nGAPS_FOUND: 0",
                    [call],
                ))
                self.assertFalse(decision.accepted)

    def test_gaps_requires_positive_count_and_missing_branches(self):
        zero = evaluate_grill_contract(self.context(
            "GAPS",
            "STAGE: design\nGAPS_FOUND: 0\n"
            "MISSING_BRANCHES: auth fallback",
            [read_call("Grep")],
        ))
        self.assertEqual(
            "标记 GAPS 但 GAPS_FOUND=0。",
            zero.reason,
        )

        missing = evaluate_grill_contract(self.context(
            "GAPS",
            "STAGE: design\nGAPS_FOUND: 2",
            [read_call("Glob")],
        ))
        self.assertIn("MISSING_BRANCHES", missing.reason)

        accepted = evaluate_grill_contract(self.context(
            "GAPS",
            "STAGE: design\nGAPS_FOUND: 2\n"
            "MISSING_BRANCHES: auth fallback",
            [read_call("Glob")],
        ))
        self.assertTrue(accepted.accepted)

    def test_stage_and_status_must_match_the_task_contract(self):
        stage = evaluate_grill_contract(self.context(
            "CLEAR",
            "STAGE: implementation\nGAPS_FOUND: 0",
            [read_call()],
        ))
        self.assertIn("STAGE 与任务卡", stage.reason)

        status = evaluate_grill_contract(self.context(
            "PASS",
            "STAGE: design\nGAPS_FOUND: 0",
            [read_call()],
        ))
        self.assertIn("只能是 CLEAR/GAPS/FAIL", status.reason)

    def test_honest_fail_needs_no_read_or_report_fields(self):
        decision = evaluate_grill_contract(self.context(
            "FAIL", "unable to read repository"))
        self.assertTrue(decision.accepted)


if __name__ == "__main__":
    unittest.main()
