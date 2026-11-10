#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fixture-level contract for the lean workflow serialized state."""

import json
import os
import sys
import tempfile
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
    decode_flow_state,
)
from mae_flow_core.state_store import (  # noqa: E402
    normalize_document,
    save_versioned_json,
    update_versioned_json,
)


FIXTURE = os.path.join(
    os.path.dirname(__file__), "fixtures", "lean_state_v3.json")
ALLOWED_TOP_LEVEL_FIELDS = {
    # Serialization metadata, not workflow evidence state.
    "engine",
    "schema_version",
    # Business and recovery state.
    "ticket",
    "path",
    "phase",
    "commit_pace",
    "status",
    "artifacts",
    "decisions",
    "risks",
    "capabilities",
    "delivery_files",
    "initial_dirty",
}


class LeanStateContractTests(unittest.TestCase):
    def test_round_trip_keeps_recovery_facts(self):
        state = FlowState.new(
            "REQ-7", DeliveryPath.FULL, CommitPace.CONTINUOUS)
        state = state.with_decision(
            "spec.approved", "用户确认可观察行为")
        self.assertEqual(state, FlowState.from_dict(state.to_dict()))

    def test_round_trip_keeps_all_recovery_value_shapes(self):
        state = FlowState(
            ticket="REQ-7",
            path=DeliveryPath.FOCUSED,
            phase=Phase.QUALITY,
            commit_pace=CommitPace.STAGED,
            status="paused",
            artifacts=(("spec", "docs/requests/REQ-7.md"),),
            decisions=(("spec.approved", "yes"),),
            risks=("database migration",),
            capabilities=(CapabilityAttempt(
                "tests", "source-1", "env-1", "passed", "focused"),),
            delivery_files=("src/feature.py",),
            initial_dirty=("notes.txt",),
        )
        self.assertEqual(state, FlowState.from_dict(state.to_dict()))

    def test_fixture_is_a_decodable_flow_state(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        self.assertEqual(raw, FlowState.from_dict(raw).to_dict())

    def test_normalize_preserves_lean_v3_without_legacy_current(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        self.assertEqual(raw, normalize_document(raw, "flow"))

    def test_normalize_rejects_non_integer_lean_schema_version(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        raw["schema_version"] = "3"
        with self.assertRaises(ValueError):
            normalize_document(raw, "flow")

    def test_decoder_rejects_non_integer_schema_versions(self):
        for invalid in (3.0, "3"):
            with self.subTest(schema_version=invalid):
                with open(FIXTURE, encoding="utf-8") as stream:
                    raw = json.load(stream)
                raw["schema_version"] = invalid
                with self.assertRaises(ValueError):
                    decode_flow_state(raw)

    def test_decoder_rejects_unknown_status(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        raw["status"] = "recovering"
        with self.assertRaisesRegex(ValueError, "status"):
            decode_flow_state(raw)

    def test_encoder_rejects_unknown_status(self):
        state = FlowState(
            ticket="REQ-7",
            path=DeliveryPath.FULL,
            phase=Phase.STARTUP,
            commit_pace=CommitPace.CONTINUOUS,
            status="recovering",
        )
        with self.assertRaisesRegex(ValueError, "status"):
            state.to_dict()

    def test_decoder_rejects_missing_or_unknown_top_level_fields(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            missing = json.load(stream)
        missing.pop("phase")
        with self.assertRaises(ValueError):
            decode_flow_state(missing)

        with open(FIXTURE, encoding="utf-8") as stream:
            unknown = json.load(stream)
        unknown["evidence"] = []
        with self.assertRaises(ValueError):
            decode_flow_state(unknown)

    def test_decoder_rejects_malformed_nested_objects(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        raw["decisions"] = [{"key": "spec.approved"}]
        with self.assertRaises(ValueError):
            decode_flow_state(raw)

    def test_encoder_rejects_untyped_enum_values(self):
        state = FlowState.new(
            "REQ-7", "full", CommitPace.CONTINUOUS)
        with self.assertRaises(ValueError):
            state.to_dict()

    def test_legacy_versioned_writer_rejects_test_only_lean_state(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, ".mae-flow.json")
            with self.assertRaises(ValueError):
                save_versioned_json(path, raw, "flow", project_root=root)

    def test_legacy_updater_rejects_mutator_returning_lean_state(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            lean = json.load(stream)
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, ".mae-flow.json")
            save_versioned_json(
                path, {"current": "build"}, "flow", project_root=root)
            with self.assertRaises(ValueError):
                update_versioned_json(
                    path, "flow", lambda unused: lean, project_root=root)

    def test_legacy_flow_normalization_remains_schema_v2(self):
        normalized = normalize_document({"current": "build"}, "flow")
        self.assertEqual(2, normalized["schema_version"])
        self.assertEqual(0, normalized["revision"])

    def test_fixture_keeps_recovery_facts_without_evidence_police_fields(self):
        with open(FIXTURE, encoding="utf-8") as stream:
            raw = json.load(stream)
        self.assertEqual("lean-v1", raw["engine"])
        self.assertEqual(3, raw["schema_version"])
        self.assertEqual("startup", raw["phase"])
        self.assertEqual("REQ-7", raw["ticket"])
        self.assertEqual(ALLOWED_TOP_LEVEL_FIELDS, set(raw))
        forbidden = {"tokens", "agent_tasks", "receipts", "evidence", "step_heads"}
        self.assertFalse(forbidden.intersection(raw))


if __name__ == "__main__":
    unittest.main()
