#!/usr/bin/env python3
"""Lean v3 recovery into the stable workflow is explicit and reversible."""

import json
import os
import sys
import tempfile
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402
from mae_flow_core.cli_commands.lean_migration import (  # noqa: E402
    confirm_stable_recovery,
    prepare_stable_recovery,
)
from mae_flow_core.orchestration import (  # noqa: E402
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
    recover_lean_flow,
)


class StableStateRecoveryTests(unittest.TestCase):
    def lean(self, phase=Phase.CONSTRUCTION, status="active"):
        return FlowState(
            ticket="REQ-42", path=DeliveryPath.FULL, phase=phase,
            commit_pace=CommitPace.STAGED, status=status,
            artifacts=(("request", "docs/req.md"),
                       ("story", ".mae-flow-work/REQ-42/story.md")),
            decisions=(("config.基线分支", "main"),
                       ("workflow", "full"),
                       ("agent_token", "must-not-survive")),
            risks=("需要核对数据库兼容性",),
            initial_dirty=("notes.txt",),
        ).to_dict()

    def test_parser_requires_explicit_confirmation_shape(self):
        args = parse_args([
            "migrate-flow", "--confirm", "--message-id", "msg-1"])
        self.assertTrue(args.confirm)
        self.assertEqual("msg-1", args.message_id)

    def test_first_prepare_creates_exact_backup_without_mutating_state(self):
        with tempfile.TemporaryDirectory() as root:
            previous = os.getcwd()
            os.chdir(root)
            try:
                raw = (json.dumps(self.lean(), ensure_ascii=False, indent=1)
                       + "\n").encode("utf-8")
                with open(".mae-flow.json", "wb") as stream:
                    stream.write(raw)

                recovery, proposal, observed = prepare_stable_recovery()

                self.assertEqual(raw, observed)
                with open(".mae-flow.json", "rb") as stream:
                    self.assertEqual(raw, stream.read())
                with open(proposal["backup_path"], "rb") as stream:
                    self.assertEqual(raw, stream.read())
                self.assertEqual("build", recovery.safe_boundary)
            finally:
                os.chdir(previous)

    def test_semantic_mapping_omits_every_evidence_contract(self):
        recovered = recover_lean_flow(self.lean(Phase.QUALITY)).state
        encoded = repr(recovered)

        self.assertEqual("build", recovered["current"])
        self.assertEqual("REQ-42", recovered["config"]["单号"])
        self.assertEqual("main", recovered["config"]["基线分支"])
        self.assertEqual(["notes.txt"], recovered["initial_dirty"])
        self.assertEqual(".mae-flow-work/REQ-42/story.md",
                         recovered["config"]["STORY路径"])
        for forbidden in (
                "must-not-survive", "token", "sha256", "digest",
                "receipt", "agent_tasks"):
            self.assertNotIn(forbidden, encoded.lower())
        self.assertEqual({}, recovered["initial_dirty_fingerprints"])

    def test_confirmation_reuses_backup_and_writes_stable_v2_once(self):
        with tempfile.TemporaryDirectory() as root:
            previous = os.getcwd()
            os.chdir(root)
            try:
                raw = json.dumps(self.lean(), ensure_ascii=False).encode()
                with open(".mae-flow.json", "wb") as stream:
                    stream.write(raw)
                _recovery, first, _raw = prepare_stable_recovery()
                with open(".mae-flow.json.usermsg", "w", encoding="utf-8") as stream:
                    json.dump([{"id": "msg-1", "text": "确认恢复到稳定流程"}], stream,
                              ensure_ascii=False)

                recovery, second = confirm_stable_recovery(
                    ".mae-flow.json", "msg-1")

                self.assertEqual(first["backup_path"], second["backup_path"])
                self.assertEqual("build", recovery.safe_boundary)
                with open(".mae-flow.json", encoding="utf-8") as stream:
                    stable = json.load(stream)
                self.assertEqual(2, stable["schema_version"])
                self.assertEqual("build", stable["current"])
                with open(first["backup_path"], "rb") as stream:
                    self.assertEqual(raw, stream.read())
            finally:
                os.chdir(previous)

    def test_terminal_lean_state_only_archives_and_starts_no_flow(self):
        for status in ("complete", "exited"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                previous = os.getcwd()
                os.chdir(root)
                try:
                    with open(".mae-flow.json", "w", encoding="utf-8") as stream:
                        json.dump(self.lean(status=status), stream)
                    prepare_stable_recovery()
                    with open(".mae-flow.json.usermsg", "w", encoding="utf-8") as stream:
                        json.dump([{"id": "msg-1", "text": "同意归档恢复"}], stream,
                                  ensure_ascii=False)

                    recovery, proposal = confirm_stable_recovery(
                        ".mae-flow.json", "msg-1")

                    self.assertTrue(recovery.terminal)
                    self.assertFalse(os.path.exists(".mae-flow.json"))
                    self.assertTrue(os.path.isfile(proposal["terminal_archive"]))
                finally:
                    os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
