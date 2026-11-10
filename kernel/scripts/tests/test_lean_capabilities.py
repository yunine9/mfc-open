#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Opaque capability-attempt and retry-decision contracts."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.orchestration import (  # noqa: E402
    AttemptContext,
    CapabilityAttempt,
    CapabilityKind,
    automatic_attempt_allowed,
    record_attempt,
    retry_options,
)


class LeanCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.build = AttemptContext(
            "build", "production-1", "environment-1")

    def test_first_context_has_one_automatic_attempt(self):
        self.assertTrue(automatic_attempt_allowed((), self.build))
        option = retry_options((), self.build)
        self.assertTrue(option.allowed)
        self.assertFalse(option.needs_user)

    def test_every_opaque_outcome_consumes_the_automatic_attempt(self):
        for outcome in (
                "returned", "failed-to-start", "timed-out", "not-observed"):
            with self.subTest(outcome=outcome):
                attempts = record_attempt((), self.build, outcome)
                self.assertEqual(outcome, attempts[-1].outcome)
                self.assertFalse(
                    automatic_attempt_allowed(attempts, self.build))
                option = retry_options(attempts, self.build)
                self.assertFalse(option.allowed)
                self.assertTrue(option.needs_user)

    def test_returned_output_is_opaque_and_does_not_become_a_verdict(self):
        summary = "PASS CLEAN 27 tests; private tool text says FAIL"
        attempts = record_attempt(
            (), self.build, "returned", summary=summary)
        self.assertEqual("returned", attempts[-1].outcome)
        self.assertEqual(summary, attempts[-1].summary)

    def test_record_attempt_rejects_verdict_like_outcomes(self):
        for outcome in (
                "passed", "failed", "clean", "27-tests", None, ["returned"]):
            with self.subTest(outcome=outcome):
                with self.assertRaises(ValueError):
                    record_attempt((), self.build, outcome)

    def test_record_attempt_bounds_the_human_summary(self):
        attempts = record_attempt(
            (), self.build, "returned", summary="x" * 5000)
        self.assertGreater(len(attempts[-1].summary), 0)
        self.assertLess(len(attempts[-1].summary), 5000)

    def test_source_change_permits_exactly_one_new_automatic_attempt(self):
        attempts = (CapabilityAttempt(
            "build", "production-1", "environment-1", "returned"),)
        changed = AttemptContext(
            CapabilityKind.BUILD, "production-2", "environment-1")
        self.assertTrue(automatic_attempt_allowed(attempts, changed))
        attempts = record_attempt(attempts, changed, "returned")
        self.assertFalse(automatic_attempt_allowed(attempts, changed))

    def test_environment_change_permits_exactly_one_new_automatic_attempt(self):
        attempts = (CapabilityAttempt(
            "build", "production-1", "environment-1", "returned"),)
        changed = AttemptContext(
            "build", "production-1", "environment-2")
        self.assertTrue(automatic_attempt_allowed(attempts, changed))
        attempts = record_attempt(attempts, changed, "timed-out")
        self.assertFalse(automatic_attempt_allowed(attempts, changed))

    def test_user_authorization_allows_an_unchanged_retry(self):
        attempts = (CapabilityAttempt(
            "build", "production-1", "environment-1", "returned"),)
        authorized = AttemptContext(
            "build", "production-1", "environment-1",
            user_authorized=True,
        )
        self.assertTrue(automatic_attempt_allowed(attempts, authorized))
        option = retry_options(attempts, authorized)
        self.assertTrue(option.allowed)
        self.assertFalse(option.needs_user)

    def test_authorization_applies_only_to_the_current_decision(self):
        attempts = (CapabilityAttempt(
            "build", "production-1", "environment-1", "returned"),)
        authorized = AttemptContext(
            "build", "production-1", "environment-1",
            user_authorized=True,
        )
        attempts = record_attempt(attempts, authorized, "returned")
        next_decision = AttemptContext(
            "build", "production-1", "environment-1")
        self.assertFalse(automatic_attempt_allowed(attempts, next_decision))
        self.assertTrue(retry_options(attempts, next_decision).needs_user)

    def test_other_capability_does_not_consume_build_attempt(self):
        attempts = (CapabilityAttempt(
            "ut", "production-1", "environment-1", "returned"),)
        self.assertTrue(automatic_attempt_allowed(attempts, self.build))

    def test_documentation_only_change_does_not_invalidate_build(self):
        attempts = (CapabilityAttempt(
            "build", "production-1", "environment-1", "returned"),)
        after_docs_change = AttemptContext(
            "build", "production-1", "environment-1")
        self.assertFalse(
            automatic_attempt_allowed(attempts, after_docs_change))

    def test_test_only_change_does_not_invalidate_production_build(self):
        attempts = (CapabilityAttempt(
            "build", "production-1", "environment-1", "returned"),)
        after_test_change = AttemptContext(
            "build", "production-1", "environment-1")
        self.assertFalse(
            automatic_attempt_allowed(attempts, after_test_change))


if __name__ == "__main__":
    unittest.main()
