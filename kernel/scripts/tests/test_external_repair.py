import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.external_repair import (  # noqa: E402
    active_repair_authorization,
    eligible_repair_paths,
    issue_repair_authorization,
)
from mae_flow_core.quality.external_verification import (  # noqa: E402
    PipelineDecision,
)


HEAD = "a" * 40


def red_state():
    return {
        "current": "external_verify",
        "initial_dirty": ["user-before.txt"],
        "quality": {"external_verification": {
            "verdict": "RED", "sha": HEAD,
        }},
    }


class ExternalRepairAuthorizationTests(unittest.TestCase):
    def test_red_issues_window_and_filters_carryover(self):
        state = red_state()
        issue_repair_authorization(
            state, PipelineDecision("RED", "UT failed", {}),
            head=HEAD, at="2026-08-20 12:00:00",
            dirty_paths=("pre-red.txt",))
        self.assertTrue(active_repair_authorization(state, HEAD)[0])
        # 2026-08-28 勘误:窗口不再绑当前 HEAD——第一笔修复提交后 HEAD
        # 前移,窗口保持打开允许补提交("一个 RED 只配一次提交"曾把漏
        # 提交文件的 Agent 摔进按旧清单判定的交付清单闸)。生命期由
        # 登记在案的 RED 判决决定,见 test_non_red_clears_window。
        self.assertTrue(active_repair_authorization(state, "b" * 40)[0])
        self.assertEqual(
            ("src/fix.py", "tests/test_fix.py", ".mae-flow.json", "docs/review/internal.md"),
            eligible_repair_paths(state, HEAD, (
                "user-before.txt", "pre-red.txt", "src/fix.py",
                "tests/test_fix.py", ".mae-flow.json",
                "docs/review/internal.md")),
        )

    def test_reregistering_same_red_keeps_original_baseline(self):
        """宿主轮询对同一 SHA 重复登记 RED 不许重取 baseline_dirty:
        Agent 改到一半的文件会被划成"登记前已有改动"永久排除,修完
        反被判"没有真实修复"(排查实锤的吞修复死角)。"""
        state = red_state()
        issue_repair_authorization(
            state, PipelineDecision("RED", "UT failed", {}),
            head=HEAD, at="12:00", dirty_paths=("pre-red.txt",))
        issue_repair_authorization(
            state, PipelineDecision("RED", "UT failed", {}),
            head=HEAD, at="12:05",
            dirty_paths=("pre-red.txt", "src/fix.py"))
        self.assertEqual(
            ["pre-red.txt"],
            state["external_repair_authorization"]["baseline_dirty"])
        self.assertIn(
            "src/fix.py",
            eligible_repair_paths(state, HEAD, (
                "pre-red.txt", "src/fix.py")))

    def test_non_red_clears_window(self):
        state = red_state()
        issue_repair_authorization(
            state, PipelineDecision("RED", "failed", {}),
            head=HEAD, at="now")
        issue_repair_authorization(
            state, PipelineDecision("INCOMPLETE", "running", {}),
            head=HEAD, at="later")
        self.assertNotIn("external_repair_authorization", state)

    def test_exact_domain_archive_output_crosses_old_baseline_dirty(self):
        """归档同名文件不是启动前脏文件；只信本轮 applied_paths 精确收据。"""
        state = red_state()
        issue_repair_authorization(
            state, PipelineDecision("RED", "failed", {}),
            head=HEAD, at="now",
            dirty_paths=("docs/specs/radio.md", "docs/specs/other.md"))
        state["domain_archive"] = {
            "status": "applied", "result": "changes",
            "applied_paths": ["docs/specs/radio.md"],
        }
        self.assertEqual(
            ("docs/specs/radio.md",),
            eligible_repair_paths(state, HEAD, (
                "docs/specs/radio.md", "docs/specs/other.md")),
        )


if __name__ == "__main__":
    unittest.main()
