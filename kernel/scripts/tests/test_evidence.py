#!/usr/bin/env python3
"""Unit tests for immutable Evidence values and registry execution."""

import os
import sys
import unittest
from dataclasses import FrozenInstanceError


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.foundation.models import EvidenceResult  # noqa: E402
from mae_flow_core.workflow.evidence import (  # noqa: E402
    EvidenceRegistry,
    build_evidence_registry,
    evaluate_step_evidence,
    legacy_result,
)


class EvidenceResultTests(unittest.TestCase):
    def test_result_is_immutable_and_keeps_tuple_unpacking(self):
        result = EvidenceResult(True, "")
        passed, reason = result
        self.assertTrue(passed)
        self.assertEqual("", reason)
        self.assertEqual(2, len(result))
        self.assertTrue(result[0])
        self.assertEqual("", result[1])
        with self.assertRaises(FrozenInstanceError):
            result.reason = "changed"

    def test_result_rejects_ambiguous_value_types(self):
        with self.assertRaisesRegex(TypeError, "passed must be bool"):
            EvidenceResult(1, "")
        with self.assertRaisesRegex(TypeError, "reason must be str"):
            EvidenceResult(False, None)

    def test_legacy_result_normalizes_only_valid_pairs(self):
        self.assertEqual(
            EvidenceResult(False, "missing"),
            legacy_result((False, "missing")),
        )
        result = EvidenceResult(True, "")
        self.assertIs(result, legacy_result(result))
        for invalid in (True, (True,), ("yes", ""), (False, None)):
            with self.subTest(invalid=invalid):
                with self.assertRaises(TypeError):
                    legacy_result(invalid)


class EvidenceRegistryTests(unittest.TestCase):
    def test_composed_registry_contains_current_evidence_names(self):
        class Rules:
            def __getattr__(self, _name):
                return lambda _spec, _state: (True, "")

        registry = build_evidence_registry(
            workflow=Rules(),
            agent=Rules(),
            delivery=Rules(),
            quality=Rules(),
        )
        self.assertEqual(
            (
                "glob", "branch_ok", "tasks_checked", "commit_tagged",
                "commit_tagged_after_entry", "delivery_manifest_committed",
                "spec_field", "yaml_field",
                "spec_validate", "tier_scope",
                "pushed", "agent_ran", "content_free", "clean_paths",
                "archive_paths_clean", "glob_absent",
                "pipeline_obligations_passed",
                "domain_archive_complete",
                "local_spec_valid", "verification_passed",
            ),
            registry.names,
        )

    def test_registry_copies_mapping_and_exposes_names(self):
        source = {"first": lambda _spec, _state: (True, "")}
        registry = EvidenceRegistry(source)
        source["second"] = lambda _spec, _state: (True, "")
        self.assertEqual(("first",), registry.names)
        self.assertIn("first", registry)
        self.assertTrue(callable(registry["first"]))
        with self.assertRaises(KeyError):
            registry.evaluate("second", {}, {})

    def test_step_evaluation_preserves_declaration_order(self):
        calls = []

        def first(spec, state):
            calls.append(("first", spec["marker"], state["value"]))
            return EvidenceResult(False, "first failure")

        def second(spec, state):
            calls.append(("second", spec["marker"], state["value"]))
            return True, ""

        def third(spec, state):
            calls.append(("third", spec["marker"], state["value"]))
            return False, "third failure"

        registry = EvidenceRegistry({
            "first": first,
            "second": second,
            "third": third,
        })
        failures = evaluate_step_evidence(
            {
                "evidence": [
                    {"type": "first", "marker": 1},
                    {"type": "second", "marker": 2},
                    {"type": "third", "marker": 3},
                ],
            },
            {"value": 7},
            registry,
        )
        self.assertEqual(
            [
                ("first", 1, 7),
                ("second", 2, 7),
                ("third", 3, 7),
            ],
            calls,
        )
        self.assertEqual(
            ["first failure", "third failure"],
            failures,
        )

    def test_unknown_name_and_evaluator_exception_are_not_hidden(self):
        registry = EvidenceRegistry({
            "explode": lambda _spec, _state: (
                1 / 0),
        })
        with self.assertRaises(KeyError):
            registry.evaluate("missing", {}, {})
        with self.assertRaises(ZeroDivisionError):
            registry.evaluate("explode", {}, {})


if __name__ == "__main__":
    unittest.main()
