#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""One-shot toolbox actions render useful work without owning lifecycle."""

import os
import sys
import tempfile
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.orchestration import (  # noqa: E402
    ToolboxRequest,
    run_toolbox_request,
)


class LeanToolboxTests(unittest.TestCase):
    def run_without_lifecycle_files(self, request):
        with tempfile.TemporaryDirectory() as root:
            before = tuple(os.listdir(root))
            previous = os.getcwd()
            try:
                os.chdir(root)
                result = run_toolbox_request(request)
            finally:
                os.chdir(previous)

            self.assertEqual(before, tuple(os.listdir(root)))
        self.assertEqual((), result.effects)
        return result

    def test_grill_is_one_interactive_question_at_a_time(self):
        result = self.run_without_lifecycle_files(
            ToolboxRequest("grill", "审查这个需求", ()))

        self.assertIn("审查这个需求", result.guidance)
        self.assertIn("一次只问一个", result.guidance)
        self.assertEqual((), result.artifacts)
        self.assertEqual((), result.risks)

    def test_ut_receives_explicit_files_without_a_task_card_or_report_contract(self):
        result = self.run_without_lifecycle_files(ToolboxRequest(
            "ut",
            "覆盖查询条件和结果映射",
            (r"src\query.cpp", r"tests\query_test.cpp"),
        ))

        self.assertEqual(
            ("src/query.cpp", "tests/query_test.cpp"),
            result.artifacts,
        )
        self.assertIn("覆盖查询条件和结果映射", result.guidance)
        self.assertIn("write UT, compile UT, and run UT", result.guidance)
        self.assertIn("No state, task card", result.guidance)
        self.assertIn("fixed report schema", result.guidance)

    def test_codecheck_uses_the_exact_advisory_file_scope_once(self):
        result = self.run_without_lifecycle_files(ToolboxRequest(
            "codecheck",
            "检查当前修改",
            (r"src\service.cpp", "src/service.cpp"),
        ))

        self.assertEqual(("src/service.cpp",), result.artifacts)
        self.assertIn("exactly once", result.guidance)
        self.assertIn("src/service.cpp", result.guidance)
        self.assertIn("opaque", result.guidance)
        self.assertIn("fail open", result.guidance)
        self.assertIn("Do not schedule a recheck", result.guidance)

    def test_windows_drive_parent_and_case_aliases_keep_one_absolute_target(self):
        result = self.run_without_lifecycle_files(ToolboxRequest(
            "codecheck",
            "检查 Windows 目标",
            (r"C:\..\Service.cpp", r"c:\SERVICE.cpp"),
        ))

        self.assertEqual(("C:/Service.cpp",), result.artifacts)
        self.assertIn("C:/Service.cpp", result.guidance)

    def test_windows_unc_parent_and_case_aliases_keep_one_share_target(self):
        result = self.run_without_lifecycle_files(ToolboxRequest(
            "ut",
            "覆盖共享目录中的实现",
            (
                r"\\Server\Share\src\..\Query.cpp",
                r"//server/share/query.cpp",
            ),
        ))

        self.assertEqual(
            ("//Server/Share/Query.cpp",),
            result.artifacts,
        )

    def test_windows_relative_backslashes_use_case_insensitive_identity(self):
        result = self.run_without_lifecycle_files(ToolboxRequest(
            "story",
            "读取设计材料",
            (r"Docs\Design.md", r"docs\design.md"),
        ))

        self.assertEqual(("Docs/Design.md",), result.artifacts)

    def test_posix_parent_resolution_keeps_case_distinct_targets(self):
        result = self.run_without_lifecycle_files(ToolboxRequest(
            "story",
            "读取 POSIX 设计材料",
            ("docs/drafts/../Design.md", "docs/design.md"),
        ))

        self.assertEqual(
            ("docs/Design.md", "docs/design.md"),
            result.artifacts,
        )

    def test_story_and_chain_accept_source_documents_without_git_effects(self):
        cases = (
            (
                "story",
                "形成实现设计",
                (r"docs\requirements\REQ-42.md",),
                "Story defines HOW",
            ),
            (
                "chain",
                "梳理跨仓依赖",
                (r"docs\requirements\REQ-42.md",),
                "Cross-repository",
            ),
        )
        for kind, request, files, expected in cases:
            with self.subTest(kind=kind):
                result = self.run_without_lifecycle_files(
                    ToolboxRequest(kind, request, files))
                self.assertEqual(
                    ("docs/requirements/REQ-42.md",), result.artifacts)
                self.assertIn(expected, result.guidance)
                self.assertIn("never auto-committed", result.guidance)
                self.assertNotIn("push command", result.guidance.lower())

    def test_unknown_scope_is_an_advisory_risk_not_a_rejection(self):
        for kind in ("ut", "codecheck", "grill", "story", "chain"):
            with self.subTest(kind=kind):
                result = self.run_without_lifecycle_files(
                    ToolboxRequest(kind, "", ()))
                self.assertTrue(result.guidance)
                self.assertEqual(1, len(result.risks))
                self.assertIn("scope", result.risks[0].lower())

    def test_stopping_needs_no_cancel_transition(self):
        result = self.run_without_lifecycle_files(
            ToolboxRequest("story", "先看看设计", ("spec.md",)))

        self.assertIn("stop", result.guidance.lower())
        self.assertIn("remain local", result.guidance.lower())
        for forbidden in (
                "state_file", "task_card", "sha", "report_schema",
                "retry_count", "commit", "push"):
            self.assertFalse(hasattr(result, forbidden), forbidden)


if __name__ == "__main__":
    unittest.main()
