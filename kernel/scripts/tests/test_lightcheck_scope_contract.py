#!/usr/bin/env python3
"""Old automatic Lightcheck scope remains advisory and exact."""

import contextlib
import io
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402
from mae_flow_core.cli_commands.lightcheck import (  # noqa: E402
    _print_lightcheck_result,
)


class LightcheckScopeContractTests(unittest.TestCase):
    def test_cli_has_no_manual_file_scope(self):
        self.assertEqual("lightcheck", parse_args(["lightcheck", "--quiet"]).cmd)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args(["lightcheck", "--file", "src/a.cpp"])

    def test_empty_automatic_scope_is_truthful_not_auto_passed(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            _print_lightcheck_result({
                "status": "CLEAN", "findings": [], "files": [],
                "report_path": "",
            })
        text = output.getvalue()
        self.assertIn("本次没有候选源码变更", text)
        self.assertNotIn("自动放行", text)

    def test_degraded_wording_is_fail_open_without_claiming_pass(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            _print_lightcheck_result({
                "status": "TOOL_ERROR", "findings": [], "files": [],
                "skipped": ["analyzer unavailable"], "report_path": "",
            })
        text = output.getvalue()
        self.assertIn("不阻断流程", text)
        self.assertNotIn("自动放行", text)


if __name__ == "__main__":
    unittest.main()
