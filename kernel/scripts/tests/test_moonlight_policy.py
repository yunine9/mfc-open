#!/usr/bin/env python3
"""Contracts for unattended quality routing."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.moonlight import (  # noqa: E402
    REPAIR_ENTRY,
    can_hard_block,
    step_kind,
)


class MoonlightPolicyTests(unittest.TestCase):
    def test_wide_build_is_the_only_quality_step(self):
        self.assertEqual("compile", step_kind("build"))
        self.assertTrue(can_hard_block("build"))
        self.assertFalse(can_hard_block("push"))

    def test_all_repairs_enter_the_wide_build_step(self):
        for workflow in ("full", "hotfix", "tweak", "review"):
            self.assertEqual("build", REPAIR_ENTRY[workflow], workflow)


if __name__ == "__main__":
    unittest.main()
