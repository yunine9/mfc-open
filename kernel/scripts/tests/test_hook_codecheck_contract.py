#!/usr/bin/env python3
"""Tests for the pure CODECHECK Agent contract."""

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
from mae_flow_core.quality.codecheck_contract import (  # noqa: E402
    evaluate_codecheck_contract,
)
from mae_flow_core.quality.tool_transcript import ToolCall  # noqa: E402


def bash(command, result, error=False):
    return ToolCall(
        call_id=command,
        name="Bash",
        input={"command": command},
        result_seen=True,
        is_error=error,
        result=result,
    )


class CodeCheckContractTests(unittest.TestCase):
    def context(
            self, report, calls=(), status="CLEAN", scan=None,
            soft=False, reusable=None, build="python build.py"):
        scan = scan or {
            "step": "tw_codecheck",
            "count": 3,
            "commands": ["batch one"],
            "stock_excluded": 0,
        }
        return AgentContractContext(
            kind="CODECHECK",
            status=status,
            report=report,
            task={"step": "tw_codecheck", "sha256": "task", "head": "a" * 40},
            config={"编译方式": build},
            calls=tuple(calls),
            changed_paths=("src/main.py",),
            reusable_receipts=reusable or {},
            facts={
                "current": "tw_codecheck",
                "scan": scan,
                "soft": soft,
            },
        )

    def report(self, found=3, fixed=0, remaining=3, extra=""):
        return (
            "EXECUTED_COMMAND: codecheck fullcheck\n"
            "FOUND: %s\n"
            "FIXED: %s\n"
            "REMAINING_COUNT: %s\n"
            "%s"
            % (found, fixed, remaining, extra)
        )

    def test_single_fullcheck_accepts_machine_count_and_plans_receipt(self):
        decision = evaluate_codecheck_contract(self.context(
            self.report(),
            [bash("codecheck fullcheck src", "共有 3 条告警")],
            status="REMAINING",
        ))
        self.assertTrue(decision.accepted)
        receipt = decision.details["fullcheck_receipt"]
        self.assertEqual([3], receipt["raw_counts"])
        self.assertEqual(3, receipt["expected_raw"])
        self.assertEqual(1, decision.details["command_count"])

    def test_multi_batch_requires_every_invocation_and_sums_counts(self):
        scan = {
            "step": "tw_codecheck",
            "count": 3,
            "commands": ["one", "two"],
            "stock_excluded": 0,
        }
        accepted = evaluate_codecheck_contract(self.context(
            self.report(),
            [
                bash("codecheck fullcheck one", "共有 1 条告警"),
                bash("codecheck fullcheck two", "共有 2 条告警"),
            ],
            status="REMAINING",
            scan=scan,
        ))
        self.assertTrue(accepted.accepted)
        self.assertEqual(
            [1, 2],
            accepted.details["fullcheck_receipt"]["raw_counts"],
        )

        missing = evaluate_codecheck_contract(self.context(
            self.report(),
            [bash("codecheck fullcheck two", "共有 2 条告警")],
            status="REMAINING",
            scan=scan,
        ))
        self.assertIn("只找到 1/2 个 fullcheck", missing.reason)

    def test_rejects_swallowed_failure_and_unverifiable_failed_call(self):
        swallowed = evaluate_codecheck_contract(self.context(
            self.report(),
            [bash(
                "codecheck fullcheck src || true",
                "共有 3 条告警",
            )],
            status="REMAINING",
        ))
        self.assertIn("吞掉失败退出码", swallowed.reason)

        failed = evaluate_codecheck_contract(self.context(
            self.report(),
            [bash(
                "codecheck fullcheck src",
                "process exited with code 2",
            )],
            status="REMAINING",
        ))
        self.assertIn("没有可验证的告警计数", failed.reason)

    def test_rejects_scan_and_report_arithmetic_mismatches(self):
        scan_mismatch = evaluate_codecheck_contract(self.context(
            self.report(found=2, fixed=0, remaining=2),
            [bash("codecheck fullcheck src", "共有 2 条告警")],
            status="REMAINING",
        ))
        self.assertIn("与 harness 首检(3)不一致", scan_mismatch.reason)

        arithmetic = evaluate_codecheck_contract(self.context(
            self.report(found=3, fixed=1, remaining=1),
            [bash("codecheck fullcheck src", "共有 1 条告警")],
            status="REMAINING",
        ))
        self.assertIn("FOUND(3) != FIXED(1)", arithmetic.reason)

    def test_fixed_findings_require_successful_configured_build(self):
        report = self.report(
            found=3,
            fixed=2,
            remaining=1,
            extra="EXECUTED_BUILD: python build.py\n",
        )
        missing = evaluate_codecheck_contract(self.context(
            report,
            [bash("codecheck fullcheck src", "共有 1 条告警")],
            status="REMAINING",
        ))
        self.assertIn("没有成功执行配置的编译命令", missing.reason)

        accepted = evaluate_codecheck_contract(self.context(
            report,
            [
                bash("codecheck fullcheck src", "共有 1 条告警"),
                bash("python build.py", "build passed"),
            ],
            status="REMAINING",
        ))
        self.assertTrue(accepted.accepted)

    def test_soft_retry_can_reuse_bound_fullcheck_and_build_receipts(self):
        report = self.report(
            found=3,
            fixed=2,
            remaining=1,
            extra="EXECUTED_BUILD: python build.py\n",
        )
        reusable = {
            "CODECHECK_FULLCHECK": {
                "head": "a" * 40,
                "raw_counts": [1],
            },
            "CODECHECK_BUILD": {"head": "a" * 40},
        }
        decision = evaluate_codecheck_contract(self.context(
            report,
            status="REMAINING",
            soft=True,
            reusable=reusable,
        ))
        self.assertTrue(decision.accepted)
        self.assertTrue(decision.details["reused_fullcheck"])
        self.assertTrue(decision.details["reused_build"])
        self.assertNotIn("fullcheck_receipt", decision.details)

    def test_honest_fail_accepts_without_machine_fields(self):
        decision = evaluate_codecheck_contract(self.context(
            "CodeCheck CLI unavailable",
            status="FAIL",
        ))
        self.assertTrue(decision.accepted)
        self.assertEqual(
            "accepted-honest-failure",
            decision.details["result"],
        )


if __name__ == "__main__":
    unittest.main()
