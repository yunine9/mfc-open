#!/usr/bin/env python3
"""Tests for Hook Agent final-report parsing."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.agent_reports import (  # noqa: E402
    empty_section,
    report_field,
    report_number,
    report_section,
)


class AgentReportTests(unittest.TestCase):
    def test_flexible_fields_accept_bullets_and_same_line_fields(self):
        report = (
            "- GENERATOR_USED: manual, EXECUTED_UT: python -m unittest\n"
            "* TESTS_TOTAL: 12 TESTS_PASSED: 12 TESTS_FAILED: 0\n"
        )
        self.assertEqual("manual", report_field(report, "GENERATOR_USED"))
        self.assertEqual(
            "python -m unittest",
            report_field(report, "EXECUTED_UT"),
        )
        self.assertEqual(12, report_number(report, "TESTS_TOTAL"))
        self.assertEqual(0, report_number(report, "TESTS_FAILED"))

    def test_report_section_stops_at_the_next_machine_field(self):
        report = (
            "SHRINK_EXEMPT:\n"
            "- removed duplicate wrapper\n"
            "- kept behavior\n"
            "BUILD_ERRORS: 0\n"
        )
        self.assertEqual(
            "- removed duplicate wrapper\n- kept behavior",
            report_section(report, "SHRINK_EXEMPT"),
        )

    def test_empty_section_accepts_historical_empty_spellings(self):
        for value in ("无", "none", "0", "暂无", "**none**"):
            with self.subTest(value=value):
                self.assertTrue(empty_section(value))
        self.assertFalse(empty_section("one known failure"))
        self.assertFalse(empty_section(None))

if __name__ == "__main__":
    unittest.main()
