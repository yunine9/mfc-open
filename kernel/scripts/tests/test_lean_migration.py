#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""One-way migration contract for schema-v2 workflow state."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.orchestration import (  # noqa: E402
    CapabilityAttempt,
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
    migrate_legacy_flow,
)


CASES = {
    "config_confirm": Phase.STARTUP,
    "grill": Phase.SPEC,
    "open": Phase.SPEC,
    "design": Phase.STORY,
    "story": Phase.STORY,
    "build": Phase.CONSTRUCTION,
    "verify_codecheck": Phase.QUALITY,
    "verify_ut": Phase.QUALITY,
    "push": Phase.DELIVERY,
    "end": Phase.DELIVERY,
}

FOCUSED_CASES = {
    "hf_open": Phase.SPEC,
    "tw_change": Phase.CONSTRUCTION,
    "tw_codecheck": Phase.QUALITY,
    "rf_triage": Phase.SPEC,
    "rf_fix": Phase.CONSTRUCTION,
    "rf_ut": Phase.QUALITY,
}


def legacy(current="build", workflow="full", **extra):
    raw = {
        "schema_version": 2,
        "current": current,
        "config": {"单号": "REQ-42"},
        "choices": {"workflow": workflow},
        "history": [],
    }
    raw.update(extra)
    return raw


class LeanMigrationTests(unittest.TestCase):
    def test_maps_each_legacy_step_family_to_lean_phase(self):
        for current, expected in CASES.items():
            with self.subTest(current=current):
                result = migrate_legacy_flow(legacy(current=current))
                self.assertEqual(expected, result.state.phase)
                self.assertTrue(result.backup_required)

    def test_maps_lightweight_workflow_families_to_focused_path(self):
        workflows = {
            "hf_open": "hotfix",
            "tw_change": "tweak",
            "tw_codecheck": "tweak",
            "rf_triage": "review",
            "rf_fix": "review",
            "rf_ut": "review",
        }
        for current, expected in FOCUSED_CASES.items():
            with self.subTest(current=current):
                result = migrate_legacy_flow(
                    legacy(current=current, workflow=workflows[current]))
                self.assertEqual(DeliveryPath.FOCUSED, result.state.path)
                self.assertEqual(expected, result.state.phase)

    def test_preserves_recovery_facts_and_omits_evidence_ledgers(self):
        raw = legacy(
            current="verify_ut",
            config={
                "单号": "REQ-42",
                "需求文档": "docs/requests/REQ-42.md",
                "CHANGE_NAME": "req-42",
                "STORY路径": "docs/story/STORY-REQ-42.md",
                "基线分支": "main",
            },
            choices={
                "workflow": "full",
                "grill": "yes",
                "STORY入库": "no",
                "delivery": {
                    "decision": "hold",
                    "receipt": "exact-ack",
                },
            },
            decisions={
                "scope": {
                    "value": "focused",
                    "tokens": {"UT": "old-token"},
                    "task_cards": {"UT": {"report_hash": "old-hash"}},
                    "nested_pairs": [
                        ["receipt", "nested-exact-ack"],
                        {"key": "tokens", "value": {"UT": "nested-token"}},
                    ],
                },
            },
            development_review={
                "mode": "staged",
                "current_index": 1,
                "checkpoints": [{"id": "CP1"}, {"id": "CP2"}],
            },
            capabilities=[{
                "kind": "tests",
                "source_revision": "source-a",
                "environment_revision": "env-a",
                "outcome": "passed",
                "summary": "unit tests passed",
            }],
            risks=["database migration"],
            delivery_files=["src/feature.py", "tests/test_feature.py"],
            initial_dirty=["notes.txt"],
            tokens={"UT": "old-token"},
            receipts={"review": "exact-ack"},
            agent_tasks={"UT": {"report_hash": "old-hash"}},
            failure_locks={"UT": True},
        )

        state = migrate_legacy_flow(raw).state

        self.assertEqual("REQ-42", state.ticket)
        self.assertEqual(CommitPace.STAGED, state.commit_pace)
        self.assertEqual(
            (
                ("request", "docs/requests/REQ-42.md"),
                ("spec", "openspec/changes/req-42/change.md"),
                ("story", "docs/story/STORY-REQ-42.md"),
            ),
            state.artifacts,
        )
        self.assertIn(("config.基线分支", "main"), state.decisions)
        self.assertIn(("grill", "yes"), state.decisions)
        self.assertIn(("STORY入库", "no"), state.decisions)
        self.assertEqual(("database migration",), state.risks)
        self.assertEqual((CapabilityAttempt(
            "tests", "source-a", "env-a", "passed",
            "unit tests passed"),), state.capabilities)
        self.assertEqual(
            ("src/feature.py", "tests/test_feature.py"),
            state.delivery_files,
        )
        self.assertEqual(("notes.txt",), state.initial_dirty)
        encoded = state.to_dict()
        encoded_text = repr(encoded)
        for forbidden in (
                "tokens", "receipts", "agent_tasks", "report_hash",
                "failure_locks", "old-token", "nested-token", "old-hash",
                "exact-ack"):
            self.assertNotIn(forbidden, encoded)
            self.assertNotIn(forbidden, encoded_text)

    def test_unknown_active_step_requires_resume_summary_without_delivery(self):
        result = migrate_legacy_flow(legacy(current="verify_new_scanner"))

        self.assertEqual(Phase.QUALITY, result.state.phase)
        self.assertNotEqual(Phase.DELIVERY, result.state.phase)
        self.assertTrue(result.warnings)
        self.assertIn("resume summary", result.warnings[0].lower())

    def test_omits_step_head_aliases_from_all_decision_encodings(self):
        result = migrate_legacy_flow(legacy(
            config={
                "单号": "REQ-42",
                "recovery": {
                    "step_heads": {"build": "head-from-dict"},
                    "meaning": "keep-config",
                },
            },
            decisions={
                "nested": [
                    ["step-head", "head-from-list"],
                    {"key": "step heads", "value": "head-from-pair"},
                    {"key": "stepHeads", "value": "head-from-camel"},
                    ["meaning", "keep-decision"],
                ],
            },
        ))

        encoded = repr(result.state.to_dict())
        for forbidden in (
                "step_heads", "step-head", "step heads", "stepHeads",
                "head-from-dict", "head-from-list", "head-from-pair",
                "head-from-camel"):
            self.assertNotIn(forbidden, encoded)
        self.assertIn("keep-config", encoded)
        self.assertIn("keep-decision", encoded)

    def test_preserves_business_fields_that_end_like_evidence_fields(self):
        result = migrate_legacy_flow(legacy(
            config={
                "单号": "REQ-42",
                "password_hash": "argon2-business-value",
                "row_lock": "pessimistic",
                "session_token": "customer-session-value",
            },
            decisions={
                "authentication": {
                    "password_hash": "nested-argon2-value",
                    "session_token": "nested-session-value",
                },
            },
        ))

        encoded = repr(result.state.to_dict())
        for preserved in (
                "password_hash", "argon2-business-value", "row_lock",
                "pessimistic", "session_token", "customer-session-value",
                "nested-argon2-value", "nested-session-value"):
            self.assertIn(preserved, encoded)

    def test_scrubs_known_legacy_evidence_aliases_by_exact_name(self):
        result = migrate_legacy_flow(legacy(
            config={
                "单号": "REQ-42",
                "user_ack": "fixed-confirmation",
                "scope_confirmation_receipt": "scope-proof",
                "business_context": "keep-config-business-context",
            },
            decisions={
                "quality": {
                    "plan_receipt": "plan-proof",
                    "result_hashes": ["quality-proof"],
                    "outcome": "keep-quality-outcome",
                },
            },
        ))

        encoded = repr(result.state.to_dict())
        for forbidden in (
                "user_ack", "fixed-confirmation",
                "scope_confirmation_receipt", "scope-proof",
                "plan_receipt", "plan-proof",
                "result_hashes", "quality-proof"):
            self.assertNotIn(forbidden, encoded)
        self.assertIn("keep-config-business-context", encoded)
        self.assertIn("keep-quality-outcome", encoded)

    def test_scrubs_structured_capability_and_risk_evidence_recursively(self):
        result = migrate_legacy_flow(legacy(
            capabilities=[{
                "kind": {
                    "name": "tests",
                    "tokens": {"UT": "kind-token"},
                    "facts": [
                        ["step_head", "kind-head"],
                        ["category", "quality"],
                    ],
                },
                "source_revision": {
                    "revision": "source-b",
                    "step_head": "source-head",
                },
                "environment_revision": "env-b",
                "outcome": {
                    "status": "blocked",
                    "receipt": "outcome-receipt",
                    "facts": [
                        {"key": "stepHeads", "value": "outcome-head"},
                        ["impact", "manual recovery"],
                    ],
                },
                "summary": {
                    "semantic": "compiler unavailable",
                    "tokens": {"COMPILE": "cap-token"},
                    "facts": [
                        ["receipt", "cap-receipt"],
                        {"key": "stepHeads", "value": "cap-head"},
                        ["impact", "build cannot run"],
                    ],
                },
            }],
            risks=[{
                "risk": "database migration",
                "receipts": {"review": "risk-receipt"},
                "facts": [
                    ["tokens", "risk-token"],
                    {"key": "step-head", "value": "risk-head"},
                    ["owner", "db-team"],
                ],
            }],
            moonlight={"issues": [{
                "summary": {
                    "risk": "environment outage",
                    "receipt": "moonlight-receipt",
                },
            }]},
        ))

        encoded = repr(result.state.to_dict())
        for preserved in (
                "tests", "quality", "source-b", "env-b", "blocked",
                "manual recovery", "compiler unavailable", "build cannot run",
                "database migration", "db-team", "environment outage"):
            self.assertIn(preserved, encoded)
        for forbidden in (
                "kind-token", "kind-head", "source-head", "outcome-receipt",
                "outcome-head", "cap-token", "cap-receipt", "cap-head",
                "risk-receipt", "risk-token", "risk-head",
                "moonlight-receipt"):
            self.assertNotIn(forbidden, encoded)

    def test_capability_identity_keeps_truthy_legacy_fallback_order(self):
        result = migrate_legacy_flow(legacy(capabilities=[
            {
                "kind": False,
                "name": "tests-from-falsy-kind",
                "outcome": 0,
                "status": "blocked-from-falsy-outcome",
            },
            {
                "kind": {"tokens": {"UT": "kind-evidence"}},
                "name": "tests-from-scrubbed-kind",
                "outcome": [["receipt", "outcome-evidence"]],
                "status": False,
                "result": "passed-from-result",
            },
        ]))

        self.assertEqual(
            (
                CapabilityAttempt(
                    "tests-from-falsy-kind", "", "",
                    "blocked-from-falsy-outcome", ""),
                CapabilityAttempt(
                    "tests-from-scrubbed-kind", "", "",
                    "passed-from-result", ""),
            ),
            result.state.capabilities,
        )
        encoded = repr(result.state.to_dict())
        self.assertNotIn("kind-evidence", encoded)
        self.assertNotIn("outcome-evidence", encoded)

    def test_capability_metadata_uses_sanitized_semantic_fallbacks(self):
        result = migrate_legacy_flow(legacy(capabilities=[{
            "kind": "tests",
            "source_revision": {"step_head": "source-evidence"},
            "source": "source-semantic",
            "environment_revision": {"tokens": {"UT": "env-evidence"}},
            "environment": "environment-semantic",
            "outcome": "passed",
            "summary": {"receipt": "summary-evidence"},
            "detail": "tests completed with the selected environment",
        }]))

        self.assertEqual((CapabilityAttempt(
            "tests",
            "source-semantic",
            "environment-semantic",
            "passed",
            "tests completed with the selected environment",
        ),), result.state.capabilities)

    def test_moonlight_summary_uses_sanitized_detail_fallback(self):
        result = migrate_legacy_flow(legacy(moonlight={"issues": [{
            "summary": {"receipt": "risk-evidence"},
            "detail": "deployment needs a manual database window",
        }]}))

        self.assertEqual(
            ("deployment needs a manual database window",),
            result.state.risks,
        )

    def test_unknown_step_uses_last_safe_history_phase(self):
        result = migrate_legacy_flow(legacy(
            current="future_unclassified_step",
            history=[{"step": "build", "result": "done"}],
        ))

        self.assertEqual(Phase.CONSTRUCTION, result.state.phase)
        self.assertTrue(result.warnings)

    def test_nullable_optional_legacy_lists_are_treated_as_empty(self):
        result = migrate_legacy_flow(legacy(
            current="future_unclassified_step",
            history=None,
            moonlight={"issues": None},
        ))

        self.assertEqual(Phase.STARTUP, result.state.phase)
        self.assertEqual((), result.state.risks)
        self.assertTrue(result.warnings)

    def test_flow_state_input_is_returned_as_one_way_migration_result(self):
        state = FlowState.new(
            "REQ-42", DeliveryPath.FULL, CommitPace.CONTINUOUS)

        result = migrate_legacy_flow(state)

        self.assertIs(state, result.state)
        self.assertEqual((), result.warnings)
        self.assertTrue(result.backup_required)


if __name__ == "__main__":
    unittest.main()
