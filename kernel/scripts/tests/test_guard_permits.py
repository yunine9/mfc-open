#!/usr/bin/env python3
"""Pure one-shot Gate permit state-machine tests."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.guard.permits import (  # noqa: E402
    block_id,
    check_permit,
    record_strike,
    strike_escalation,
)


class PermitPolicyTests(unittest.TestCase):
    def test_block_id_is_normalized_and_stable(self):
        self.assertEqual(
            block_id("edit-source", r"src\main.py"),
            block_id("edit-source", "src/main.py"),
        )
        self.assertEqual(10, len(block_id("edit-source", "src/main.py")))

    def test_permit_is_single_step_and_head_bound(self):
        bid = block_id("edit-source", "src/main.py")
        permits = {bid: {
            "step": "build", "head": "abc", "used": False}}
        self.assertEqual(
            "valid", check_permit(permits, bid, "build", "abc").kind)
        self.assertEqual(
            "missing", check_permit(permits, bid, "verify", "abc").kind)
        stale = check_permit(permits, bid, "build", "def")
        self.assertEqual(("stale", "abc"), (stale.kind, stale.signed_head))
        permits[bid]["used"] = True
        self.assertEqual(
            "missing", check_permit(permits, bid, "build", "abc").kind)

    def test_strikes_reset_by_step_and_keep_twenty_recent(self):
        data = {}
        for index in range(22):
            data, count = record_strike(
                data, "rule", "build", "id%02d" % index,
                "sample", "2026-07-30 00:%02d:00" % index)
        self.assertEqual(22, count)
        self.assertEqual(20, len(data["recent"]))
        data, count = record_strike(
            data, "rule", "verify", "next", "sample", "later")
        self.assertEqual(1, count)

    def test_first_block_has_user_exit_but_moonlight_does_not(self):
        first = strike_escalation(
            1, 3, False, "abc", "/tool/mae-flow.py")
        normal = strike_escalation(
            3, 3, False, "abc", "/tool/mae-flow.py")
        moonlight = strike_escalation(
            3, 3, True, "abc", "/tool/mae-flow.py")
        self.assertIn("allow abc", first)
        self.assertIn("allow abc", normal)
        self.assertIn("moonlight blocked", moonlight)
        self.assertNotIn("allow abc", moonlight)


if __name__ == "__main__":
    unittest.main()
