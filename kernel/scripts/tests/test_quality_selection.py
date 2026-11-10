#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Semantic quality-work recommendation contracts."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.orchestration import DeliveryPath  # noqa: E402
from mae_flow_core.quality import recommend_quality  # noqa: E402


class QualitySelectionTests(unittest.TestCase):
    def assertCapabilities(self, recommendation, expected):
        self.assertEqual(
            expected,
            (
                recommendation.build,
                recommendation.unit_test,
                recommendation.codecheck,
                recommendation.code_review,
            ),
        )

    def test_full_defaults_to_one_complete_expensive_quality_chain(self):
        recommendation = recommend_quality(DeliveryPath.FULL)

        self.assertCapabilities(recommendation, (True, True, True, False))
        explanation = " ".join(recommendation.reasons).lower()
        self.assertIn("full", explanation)
        self.assertIn("one", explanation)
        self.assertIn("startup", explanation)
        self.assertIn("adjust", explanation)

    def test_focused_behavior_change_selects_build_and_unit_test_by_impact(self):
        recommendation = recommend_quality(
            "focused",
            behavior_change=True,
        )

        self.assertCapabilities(recommendation, (True, True, False, False))
        self.assertIn(
            "behavior",
            " ".join(recommendation.reasons).lower(),
        )

    def test_focused_test_only_change_runs_unit_test_without_build(self):
        recommendation = recommend_quality("focused", test_only=True)

        self.assertCapabilities(recommendation, (False, True, False, False))
        self.assertIn("test-only", " ".join(recommendation.reasons).lower())

    def test_focused_docs_only_change_has_no_expensive_recommendation(self):
        recommendation = recommend_quality("focused", docs_only=True)

        self.assertCapabilities(recommendation, (False, False, False, False))
        self.assertIn("documentation", " ".join(recommendation.reasons).lower())

    def test_focused_build_configuration_change_selects_build_only(self):
        recommendation = recommend_quality(
            "focused",
            build_configuration=True,
        )

        self.assertCapabilities(recommendation, (True, False, False, False))
        self.assertIn(
            "build configuration",
            " ".join(recommendation.reasons).lower(),
        )

    def test_public_interface_change_adds_formal_check_and_review(self):
        recommendation = recommend_quality(
            "focused",
            public_interface=True,
        )

        self.assertCapabilities(recommendation, (True, True, True, True))
        self.assertIn(
            "public interface",
            " ".join(recommendation.reasons).lower(),
        )

    def test_shared_state_change_adds_formal_check_and_review(self):
        recommendation = recommend_quality(
            "focused",
            shared_state=True,
        )

        self.assertCapabilities(recommendation, (True, True, True, True))
        self.assertIn("shared state", " ".join(recommendation.reasons).lower())

    def test_review_fix_label_selects_review_but_not_unproven_work(self):
        recommendation = recommend_quality("focused", review_fix=True)

        self.assertCapabilities(recommendation, (False, False, False, True))
        explanation = " ".join(recommendation.reasons).lower()
        self.assertIn("review-fix", explanation)
        self.assertIn("actual impact", explanation)

    def test_weak_legacy_cpp_boundary_tests_extracted_logic_not_framework(self):
        recommendation = recommend_quality(
            "focused",
            weak_legacy_cpp_boundary=True,
        )

        self.assertCapabilities(recommendation, (True, True, False, False))
        explanation = " ".join(recommendation.reasons).lower()
        self.assertIn("during construction", explanation)
        self.assertIn("extract deterministic", explanation)
        self.assertIn("create test seams", explanation)
        self.assertIn("final ut consumes", explanation)
        self.assertIn("not mock the stable framework", explanation)

    def test_user_adjustment_changes_the_recommendation_not_an_execution_state(self):
        original = recommend_quality("focused", behavior_change=True)
        adjusted = original.adjusted(
            build=False,
            codecheck=True,
            reason="User accepted UT and requested CodeCheck instead.",
        )

        self.assertCapabilities(original, (True, True, False, False))
        self.assertCapabilities(adjusted, (False, True, True, False))
        self.assertIn("User accepted", adjusted.reasons[-1])
        self.assertFalse(hasattr(adjusted, "execute"))
        self.assertFalse(hasattr(adjusted, "allowed"))

    def test_combined_facts_use_semantic_union_not_a_scale_threshold(self):
        recommendation = recommend_quality(
            "focused",
            docs_only=True,
            behavior_change=True,
            public_interface=True,
        )

        self.assertCapabilities(recommendation, (True, True, True, True))


if __name__ == "__main__":
    unittest.main()
