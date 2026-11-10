#!/usr/bin/env python3
"""Tests for the pure UT Agent contract."""

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
from mae_flow_core.quality.tool_transcript import ToolCall  # noqa: E402
from mae_flow_core.quality.unit_test_contract import (  # noqa: E402
    evaluate_unit_test_contract,
)
from mae_flow_core.adapters.hook_runtime_contracts import (  # noqa: E402
    HookContractsMixin,
)
from mae_flow_core.adapters.hook_active_events import (  # noqa: E402
    ActiveHookEventAdapter,
)


def tool(name, value, result="", error=False, seen=True):
    return ToolCall(
        call_id=name + str(len(result)),
        name=name,
        input=value,
        result_seen=seen,
        is_error=error,
        result=result,
    )


class UnitTestContractTests(unittest.TestCase):
    def test_active_runtime_requires_configured_generator_skill_and_test_command(self):
        bash = tool(
            "Bash", {"command": "python -m unittest"}, "7 passed")
        skill = tool("Skill", {"skill": "AutoUT"}, "generated")
        config = {
            "UT生成方式": "AutoUT",
            "UT运行命令": "python -m unittest",
        }
        self.assertIsNone(ActiveHookEventAdapter._quality_call(
            "UT", (bash,), config))
        self.assertIsNotNone(ActiveHookEventAdapter._quality_call(
            "UT", (skill, bash), config))
        descriptive = dict(config, **{
            "UT生成方式": "Mae-Flow 自带 AutoUT / java-autout"})
        java_skill = tool(
            "Skill", {"skill": "java-autout"}, "generated")
        self.assertIsNotNone(ActiveHookEventAdapter._quality_call(
            "UT", (java_skill, bash), descriptive))
        self.assertIsNone(ActiveHookEventAdapter._quality_call(
            "UT", (skill, bash), descriptive))
        failed_skill = tool(
            "Skill", {"skill": "AutoUT"}, "failed", error=True)
        self.assertIsNone(ActiveHookEventAdapter._quality_call(
            "UT", (failed_skill, bash), config))
        self.assertIsNotNone(ActiveHookEventAdapter._quality_call(
            "UT", (bash,), config, {"ut_phase": "final"}))

    def context(
            self, report, calls=(), status="PASS", generator="manual",
            command="python -m unittest", changed=(), soft=False,
            reusable=None):
        return AgentContractContext(
            kind="UT",
            status=status,
            report=report,
            task={"step": "tw_ut", "sha256": "task", "head": "a" * 40},
            config={
                "UT生成方式": generator,
                "UT运行命令": command,
            },
            calls=tuple(calls),
            changed_paths=tuple(changed),
            reusable_receipts=reusable or {},
            facts={"soft": soft},
        )

    def report(self, total=7, passed=7, failed=0, extra=""):
        return (
            "GENERATOR_USED: manual\n"
            "EXECUTED_UT: python -m unittest\n"
            "TESTS_TOTAL: %s\n"
            "TESTS_PASSED: %s\n"
            "TESTS_FAILED: %s\n"
            "%s"
            % (total, passed, failed, extra)
        )

    def test_pass_does_not_require_ac_coverage(self):
        decision = evaluate_unit_test_contract(self.context(
            self.report(),
            [tool(
                "Bash",
                {"command": "python -m unittest"},
                "7 passed",
            )],
        ))
        self.assertTrue(decision.accepted, decision.reason)

    def test_pass_ignores_legacy_ac_coverage_content(self):
        report = self.report().replace(
            "EXECUTED_UT: python -m unittest\n",
            "EXECUTED_UT: python -m unittest\n"
            "AC_COVERAGE: 框架不支持覆盖率，存在未覆盖场景\n",
        )
        decision = evaluate_unit_test_contract(self.context(
            report,
            [tool(
                "Bash",
                {"command": "python -m unittest"},
                "7 passed",
            )],
        ))
        self.assertTrue(decision.accepted, decision.reason)

    def test_zero_tests_and_failed_counts_cannot_pass(self):
        zero = evaluate_unit_test_contract(self.context(
            self.report(total=0, passed=0, failed=0),
            [tool(
                "Bash",
                {"command": "python -m unittest"},
                "No tests were found",
            )],
        ))
        self.assertIn("TESTS_TOTAL>=1", zero.reason)

        failed = evaluate_unit_test_contract(self.context(
            self.report(total=7, passed=6, failed=1),
            [tool(
                "Bash",
                {"command": "python -m unittest"},
                "6 passed, 1 failed",
            )],
        ))
        self.assertIn("真实输出显示 1 个失败", failed.reason)

    def test_required_generator_skill_needs_success_or_bound_retry_receipt(self):
        report = self.report().replace(
            "GENERATOR_USED: manual", "GENERATOR_USED: autout")
        missing = evaluate_unit_test_contract(self.context(
            report,
            [tool(
                "Bash",
                {"command": "python -m unittest"},
                "7 passed",
            )],
            generator="autout",
        ))
        self.assertIn("transcript 中没有成功调用", missing.reason)

        accepted = evaluate_unit_test_contract(self.context(
            report,
            [
                tool("Skill", {"skill": "autout"}, "generated"),
                tool(
                    "Bash",
                    {"command": "python -m unittest"},
                    "7 passed",
                ),
            ],
            generator="autout",
        ))
        self.assertTrue(accepted.accepted)

        reused = evaluate_unit_test_contract(self.context(
            report,
            soft=True,
            generator="autout",
            reusable={
                "UT_GENERATOR": {"head": "a" * 40},
                "UT_RUN": {
                    "head": "a" * 40,
                    "reported_counts": {
                        "total": 7,
                        "passed": 7,
                        "failed": 0,
                    },
                },
            },
        ))
        self.assertTrue(reused.accepted)
        self.assertTrue(reused.details["reused_generator"])
        self.assertTrue(reused.details["reused_run"])

    def test_report_retry_cannot_change_counts_bound_to_receipt(self):
        decision = evaluate_unit_test_contract(self.context(
            self.report(),
            soft=True,
            reusable={
                "UT_RUN": {
                    "reported_counts": {
                        "total": 8,
                        "passed": 8,
                        "failed": 0,
                    },
                },
            },
        ))
        self.assertIn("与已绑定的真实执行凭证不一致", decision.reason)

    def test_swallowed_exit_and_added_filter_are_rejected(self):
        swallowed = evaluate_unit_test_contract(self.context(
            self.report(),
            [tool(
                "Bash",
                {"command": "python -m unittest || true"},
                "7 passed",
            )],
        ))
        self.assertIn("吞掉了失败退出码", swallowed.reason)

        filtered_report = self.report().replace(
            "EXECUTED_UT: python -m unittest",
            "EXECUTED_UT: python -m unittest -k feature",
        )
        filtered = evaluate_unit_test_contract(self.context(
            filtered_report,
            [tool(
                "Bash",
                {"command": "python -m unittest -k feature"},
                "7 passed",
            )],
        ))
        self.assertIn("追加了过滤/排除参数", filtered.reason)

    def test_pending_sections_cannot_pass(self):
        pending = evaluate_unit_test_contract(self.context(
            self.report(extra="KNOWN_FAILURES: flaky test\n"),
            [tool(
                "Bash",
                {"command": "python -m unittest"},
                "7 passed",
            )],
        ))
        self.assertIn("KNOWN_FAILURES 非空", pending.reason)

    def test_nonpass_statuses_are_honest_early_results(self):
        for status in ("NEEDS_INPUT", "FAIL"):
            with self.subTest(status=status):
                decision = evaluate_unit_test_contract(self.context(
                    "tool unavailable", status=status))
                self.assertTrue(decision.accepted)

        unknown = evaluate_unit_test_contract(self.context(
            "tool unavailable", status="CLEAR"))
        self.assertIn("未知结果状态 CLEAR", unknown.reason)


class UnitTestContractAdapterTests(unittest.TestCase):
    class Runtime(HookContractsMixin):
        def __init__(self):
            self.events = []

        def _contract_bail(self, _kind, message, _soft):
            self.events.append(("bail", message))

        def _task_card_contract(self, _kind, _report, _soft):
            self.events.append(("task",))
            return {"step": "tw_ut", "sha256": "task", "head": "a" * 40}

        def _enforce_agent_scope(self, _kind, _task, _bail):
            self.events.append(("scope",))
            return ["tests/test_feature.py"]

        def _record_ut_receipts(self, *_args):
            self.events.append(("receipt",))

        def _state_config(self):
            self.events.append(("config",))
            return {}

    def test_nonpass_status_does_not_persist_or_reuse_ut_receipts(self):
        for status in ("NEEDS_INPUT", "FAIL"):
            with self.subTest(status=status):
                runtime = self.Runtime()
                runtime._ut_contract(status, "tool unavailable")
                self.assertEqual(
                    [("task",), ("scope",)],
                    runtime.events,
                )

    def test_unknown_status_bails_before_touching_receipts(self):
        runtime = self.Runtime()
        runtime._ut_contract("CLEAR", "tool unavailable")
        self.assertEqual(
            [
                ("task",),
                ("scope",),
                ("bail", "未知结果状态 CLEAR"),
            ],
            runtime.events,
        )


if __name__ == "__main__":
    unittest.main()
