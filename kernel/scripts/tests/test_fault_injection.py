#!/usr/bin/env python3
"""Deterministic failure-injection tests for persistence boundaries."""

import glob
import os
import sys
import tempfile
import unittest


TESTS = os.path.abspath(os.path.dirname(__file__))
SCRIPTS = os.path.abspath(os.path.join(TESTS, ".."))
if TESTS not in sys.path:
    sys.path.insert(0, TESTS)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from fault_injection import fail_on_call  # noqa: E402
from mae_flow_core import state_store  # noqa: E402


class FaultInjectionTests(unittest.TestCase):
    def test_fail_on_call_delegates_before_and_after_selected_call(self):
        class Target:
            def invoke(self, value):
                return value * 2

        target = Target()
        with fail_on_call(
                target, "invoke", 2, OSError("selected failure")):
            self.assertEqual(2, target.invoke(1))
            with self.assertRaisesRegex(OSError, "selected failure"):
                target.invoke(2)
            self.assertEqual(6, target.invoke(3))

    def test_fail_on_call_rejects_non_positive_call_number(self):
        with self.assertRaisesRegex(
                ValueError, "call_number must be at least 1"):
            with fail_on_call(
                    os.path, "exists", 0, OSError("unused")):
                pass

    def test_atomic_replace_failure_preserves_original_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "state.json")
            state_store.atomic_write_json(path, {"value": "old"})
            with fail_on_call(
                    state_store, "_replace_with_retry", 1,
                    OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    state_store.atomic_write_json(path, {"value": "new"})
            self.assertEqual({"value": "old"}, state_store.read_json(path))
            self.assertEqual([], glob.glob(path + ".tmp.*"))


if __name__ == "__main__":
    unittest.main()
