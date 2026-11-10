#!/usr/bin/env python3
"""Bounded Ponytail and CodeCheck attempt policy."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.attempts import (  # noqa: E402
    begin_attempt,
    attempt_count,
)


class QualityAttemptLimitTests(unittest.TestCase):
    def test_ponytail_accepts_one_distinct_attempt_only(self):
        state = {}
        first = begin_attempt(state, "ponytail", "entry-1", limit=1)
        repeated = begin_attempt(state, "ponytail", "entry-1", limit=1)
        blocked = begin_attempt(state, "ponytail", "entry-2", limit=1)
        self.assertTrue(first.started)
        self.assertFalse(repeated.started)
        self.assertTrue(repeated.reused)
        self.assertTrue(blocked.exhausted)
        self.assertEqual(1, attempt_count(state, "ponytail"))

    def test_codecheck_accepts_two_rounds_without_counting_same_input_twice(self):
        state = {}
        first = begin_attempt(state, "codecheck", "head-a", limit=2)
        retry = begin_attempt(state, "codecheck", "head-a", limit=2)
        second = begin_attempt(state, "codecheck", "head-b", limit=2)
        third = begin_attempt(state, "codecheck", "head-c", limit=2)
        self.assertTrue(first.started)
        self.assertTrue(retry.reused)
        self.assertTrue(second.started)
        self.assertTrue(third.exhausted)
        self.assertEqual(2, attempt_count(state, "codecheck"))


if __name__ == "__main__":
    unittest.main()
