"""Validation helpers for the Mae-Flow refactor completion contract."""

import json
import os


APPROVED_FINAL_TARGETS = {
    "max_entrypoint_lines": {
        "scripts/mae-flow.py": 1500,
        "hooks/dispatch.py": 800,
    },
    "max_business_module_lines": 500,
    "max_policy_complexity": 15,
    "private_monolith_test_imports": 0,
}

APPROVED_REQUIRED_VERIFICATIONS = {
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
}


def load_contract(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def validate_contract(root, contract):
    errors = []
    if contract.get("schema") != 1:
        errors.append("schema must be 1")
    if contract.get("behavior_baseline") != "phase9":
        errors.append("behavior_baseline must be phase9")
    if contract.get("final_targets") != APPROVED_FINAL_TARGETS:
        errors.append(
            "final_targets must match the approved completion thresholds")
    if (contract.get("required_verifications")
            != APPROVED_REQUIRED_VERIFICATIONS):
        errors.append(
            "required_verifications must match the approved release gates")
    stages = contract.get("stages", [])
    if [item.get("id") for item in stages] != list(range(10)):
        errors.append("stages must be ordered 0 through 9")

    baseline_path = os.path.join(
        root, "scripts", "tests", "architecture_baseline.json")
    with open(baseline_path, encoding="utf-8") as stream:
        baseline = json.load(stream)
    targets = contract.get("final_targets", {}).get(
        "max_entrypoint_lines", {})
    for relative, maximum in sorted(targets.items()):
        current = baseline.get("max_lines", {}).get(relative)
        if current is None:
            errors.append(relative + ": missing current architecture baseline")
        elif not isinstance(maximum, int) or maximum <= 0:
            errors.append(
                "%s: final target %s must be a positive integer"
                % (relative, maximum))

    required_domains = {
        "runtime", "workflow", "evidence", "gate", "ownership",
        "delivery", "quality", "hook", "state", "platform",
    }
    if set(contract.get("domains", [])) != required_domains:
        errors.append("domains do not match the completion roadmap")
    if set(contract.get("observables", [])) != {
            "stdout", "stderr", "returncode", "files", "state", "git"}:
        errors.append("observable dimensions are incomplete")
    return errors
