#!/usr/bin/env python3
"""Machine-checked completion criteria for the Mae-Flow refactor."""

import json
import os
import sys
import unittest


TESTS = os.path.abspath(os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(TESTS, "..", ".."))
if TESTS not in sys.path:
    sys.path.insert(0, TESTS)

from refactor_completion import load_contract, validate_contract  # noqa: E402


class RefactorCompletionContractTests(unittest.TestCase):
    def test_repository_contract_has_strict_final_targets(self):
        contract = load_contract(os.path.join(
            TESTS, "refactor_completion_contract.json"))
        self.assertEqual(1, contract["schema"])
        self.assertEqual("phase9", contract["behavior_baseline"])
        self.assertEqual(
            {
                "scripts/mae-flow.py": 1500,
                "hooks/dispatch.py": 800,
            },
            contract["final_targets"]["max_entrypoint_lines"],
        )
        self.assertEqual(
            500, contract["final_targets"]["max_business_module_lines"])
        self.assertEqual(
            15, contract["final_targets"]["max_policy_complexity"])
        self.assertEqual(
            0, contract["final_targets"]["private_monolith_test_imports"])
        self.assertEqual(
            {
                "architecture": [
                    "python scripts/tests/test_architecture.py",
                ],
                "fault_injection": [
                    "python scripts/tests/test_fault_injection.py",
                ],
                "resource_warnings": [
                    "python -W error::ResourceWarning "
                    "scripts/tests/test_state_core.py",
                    "python -W error::ResourceWarning "
                    "scripts/tests/test_quality_task_cards.py",
                ],
                "selftest": [
                    "python scripts/selftest.py",
                ],
                "unit_tests": [
                    "python -m unittest discover -s scripts/tests "
                    "-p 'test_*.py'",
                ],
            },
            contract["required_verifications"],
        )
        self.assertEqual(list(range(10)), [
            item["id"] for item in contract["stages"]])
        self.assertEqual([], validate_contract(ROOT, contract))

    def test_contract_rejects_nonpositive_entrypoint_target(self):
        with open(
                os.path.join(TESTS, "refactor_completion_contract.json"),
                encoding="utf-8") as stream:
            contract = json.load(stream)
        contract["final_targets"]["max_entrypoint_lines"][
            "scripts/mae-flow.py"] = 0
        self.assertIn(
            "scripts/mae-flow.py: final target 0 must be a positive integer",
            validate_contract(ROOT, contract),
        )

    def test_contract_rejects_relaxed_or_missing_final_targets(self):
        contract = load_contract(os.path.join(
            TESTS, "refactor_completion_contract.json"))
        contract["final_targets"]["private_monolith_test_imports"] = 1
        self.assertIn(
            "final_targets must match the approved completion thresholds",
            validate_contract(ROOT, contract),
        )
        del contract["final_targets"]["private_monolith_test_imports"]
        self.assertIn(
            "final_targets must match the approved completion thresholds",
            validate_contract(ROOT, contract),
        )

    def test_contract_rejects_relaxed_or_missing_required_verification(self):
        contract = load_contract(os.path.join(
            TESTS, "refactor_completion_contract.json"))
        contract["required_verifications"]["architecture"] = []
        self.assertIn(
            "required_verifications must match the approved release gates",
            validate_contract(ROOT, contract),
        )
        del contract["required_verifications"]["resource_warnings"]
        self.assertIn(
            "required_verifications must match the approved release gates",
            validate_contract(ROOT, contract),
        )


if __name__ == "__main__":
    unittest.main()
