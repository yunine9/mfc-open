#!/usr/bin/env python3
"""Subprocess contracts for explicit Lean-v3 to stable-v2 recovery."""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ROOT = os.path.abspath(os.path.join(SCRIPTS, ".."))
CLI = os.path.join(SCRIPTS, "mae-flow.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.orchestration import (  # noqa: E402
    CommitPace, DeliveryPath, FlowState, Phase,
)


class LeanMigrationCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        self.state_path = os.path.join(self.root, ".mae-flow.json")
        self.env = dict(os.environ)
        self.env["PYTHONPYCACHEPREFIX"] = os.path.join(self.root, "pycache")

    def tearDown(self):
        self.temp.cleanup()

    def lean(self, phase=Phase.CONSTRUCTION, status="active"):
        return FlowState(
            ticket="REQ-42", path=DeliveryPath.FULL, phase=phase,
            commit_pace=CommitPace.STAGED, status=status,
            artifacts=(("request", "docs/request.md"),),
            decisions=(("config.基线分支", "main"),),
            initial_dirty=("notes.txt",),
        ).to_dict()

    def write_state(self, state):
        raw = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode()
        with open(self.state_path, "wb") as stream:
            stream.write(raw)
        return raw

    def run_cli(self, *arguments):
        return subprocess.run(
            [sys.executable, CLI, *(arguments or ("current",))],
            cwd=self.root, env=self.env, text=True, encoding="utf-8",
            errors="replace", capture_output=True, timeout=20)

    def proposal(self):
        path = os.path.join(
            self.root, ".mae-flow-work", "state-backups",
            "lean-v3-recovery.json")
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)

    def capture_confirmation(self, text="确认恢复到稳定流程"):
        with open(self.state_path + ".usermsg", "w", encoding="utf-8") as stream:
            json.dump([{"id": "msg-1", "text": text}], stream,
                      ensure_ascii=False)

    def test_current_creates_exact_backup_but_never_rewrites_lean_state(self):
        original = self.write_state(self.lean())

        result = self.run_cli("current")

        self.assertEqual(0, result.returncode, result.stderr)
        with open(self.state_path, "rb") as stream:
            self.assertEqual(original, stream.read())
        proposal = self.proposal()
        with open(os.path.join(self.root, proposal["backup_path"]), "rb") as stream:
            self.assertEqual(original, stream.read())
        self.assertIn("建议恢复到稳定流程步骤: build", result.stdout)
        self.assertIn("--confirm --message-id", result.stdout)

    def test_confirmation_writes_stable_v2_at_safe_boundary(self):
        self.write_state(self.lean(Phase.QUALITY))
        self.run_cli("migrate-flow")
        self.capture_confirmation()

        result = self.run_cli(
            "migrate-flow", "--confirm", "--message-id", "msg-1")

        self.assertEqual(0, result.returncode, result.stderr)
        with open(self.state_path, encoding="utf-8") as stream:
            stable = json.load(stream)
        self.assertEqual(2, stable["schema_version"])
        self.assertEqual("build", stable["current"])
        serialized = repr(stable).lower()
        for forbidden in ("token", "digest", "receipt", "agent_tasks"):
            self.assertNotIn(forbidden, serialized)

    def test_v2_state_is_not_automatically_replaced(self):
        stable = {
            "schema_version": 2, "revision": 0, "current": "build",
            "config": {"单号": "REQ-42"}, "choices": {"workflow": "full"},
            "history": [],
        }
        original = self.write_state(stable)

        result = self.run_cli("migrate-flow")

        self.assertEqual(0, result.returncode, result.stderr)
        with open(self.state_path, "rb") as stream:
            self.assertEqual(original, stream.read())
        self.assertIn("稳定流程状态", result.stdout)

    def test_missing_or_negative_confirmation_never_rewrites_state(self):
        original = self.write_state(self.lean())
        self.run_cli("migrate-flow")
        self.capture_confirmation("不确认恢复，请取消")

        result = self.run_cli(
            "migrate-flow", "--confirm", "--message-id", "msg-1")

        self.assertNotEqual(0, result.returncode)
        with open(self.state_path, "rb") as stream:
            self.assertEqual(original, stream.read())

    def test_terminal_state_is_archived_without_starting_a_flow(self):
        self.write_state(self.lean(status="complete"))
        self.run_cli("migrate-flow")
        self.capture_confirmation("同意归档")

        result = self.run_cli(
            "migrate-flow", "--confirm", "--message-id", "msg-1")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertFalse(os.path.exists(self.state_path))
        self.assertIn("当前没有活动流程", result.stdout)
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, self.proposal()["terminal_archive"])))

    def test_interrupted_confirm_keeps_original_and_complete_backup(self):
        from mae_flow_core.cli_commands import lean_migration  # noqa: E402

        previous = os.getcwd()
        os.chdir(self.root)
        try:
            original = self.write_state(self.lean())
            lean_migration.prepare_stable_recovery()
            self.capture_confirmation()
            with mock.patch.object(
                    lean_migration, "atomic_write_json",
                    side_effect=PermissionError("locked")):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(PermissionError):
                        lean_migration.confirm_stable_recovery(
                            ".mae-flow.json", "msg-1")
            with open(self.state_path, "rb") as stream:
                self.assertEqual(original, stream.read())
            proposal = self.proposal()
            with open(proposal["backup_path"], "rb") as stream:
                self.assertEqual(original, stream.read())
        finally:
            os.chdir(previous)

    def test_corrupt_and_unsupported_state_fail_without_rewrite(self):
        cases = (
            b'{"schema_version": 3, broken',
            json.dumps({"schema_version": 99, "engine": "future"}).encode(),
        )
        for raw in cases:
            with self.subTest(raw=raw[:20]):
                with open(self.state_path, "wb") as stream:
                    stream.write(raw)
                result = self.run_cli("migrate-flow")
                self.assertNotEqual(0, result.returncode)
                with open(self.state_path, "rb") as stream:
                    self.assertEqual(raw, stream.read())


if __name__ == "__main__":
    unittest.main()
