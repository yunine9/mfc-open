#!/usr/bin/env python3
"""User-readable delivery confirmation and exact staging contracts."""

import os
import sys
import types
import unittest
from unittest import mock


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402
from mae_flow_core.cli_commands import delivery_manifest  # noqa: E402
from mae_flow_core.cli_commands.delivery_manifest import (  # noqa: E402
    build_delivery_manifest,
    confirm_delivery_manifest,
    select_unchanged_build_residue,
)
from mae_flow_core.cli_commands.git_ownership import (  # noqa: E402
    _build_artifact_confidence,
)


class DeliveryConfirmationTests(unittest.TestCase):
    def state(self):
        return {
            "current": "delivery_review",
            "config": {"单号": "REQ-42"},
            "initial_dirty": ["docs/user-notes.md"],
        }

    def test_parser_accepts_every_delivery_command_printed_to_agents(self):
        set_args = parse_args([
            "manifest", "set", "--file", "src/a.cpp",
            "--file", "tests/a_test.cpp", "--message", "feat: add A",
            "--target", "main", "--adopt-dirty",
            "docs/user-notes.md=用户确认该文件属于本需求",
        ])
        show_args = parse_args(["manifest", "show"])
        confirm_args = parse_args([
            "manifest", "confirm", "--message-id", "msg-1"])
        auto_args = parse_args([
            "manifest", "confirm", "--moonlight-auto"])

        self.assertEqual("set", set_args.manifest_action)
        self.assertEqual("show", show_args.manifest_action)
        self.assertEqual("confirm", confirm_args.manifest_action)
        self.assertTrue(auto_args.moonlight_auto)

    def test_parser_accepts_unchanged_delivery_without_file_or_message(self):
        try:
            args = parse_args([
                "manifest", "set", "--unchanged", "--target", "main"])
        except SystemExit as exc:
            self.fail("合法空交付命令必须可解析，实际退出 %s" % exc.code)
        self.assertTrue(args.unchanged)
        self.assertIsNone(args.file)
        self.assertIsNone(args.message)

    def test_unchanged_delivery_builds_confirmed_no_op_manifest(self):
        builder = getattr(
            delivery_manifest, "build_unchanged_delivery_manifest", None)
        self.assertIsNotNone(
            builder, "缺少空交付清单构造器，unchanged 会卡死在最终检视")
        state = self.state()
        state["domain_archive"] = {
            "status": "applied", "result": "unchanged",
            "applied_paths": [],
        }

        manifest = builder(
            state, "main", current_dirty=("docs/user-notes.md",),
            preserved_initial_dirty=("docs/user-notes.md",))

        self.assertEqual([], manifest["files"])
        self.assertEqual("main", manifest["target_branch"])
        self.assertTrue(manifest["confirmed"])
        self.assertTrue(manifest["no_changes"])
        self.assertEqual(
            {"mode": "unchanged"}, manifest["confirmation"])
        self.assertEqual(
            ["docs/user-notes.md"],
            manifest["unchanged_initial_dirty"])

    def test_unchanged_delivery_rejects_nonempty_or_dirty_final_state(self):
        builder = getattr(
            delivery_manifest, "build_unchanged_delivery_manifest", None)
        self.assertIsNotNone(builder)
        cases = (
            ({"status": "applied", "result": "unchanged",
              "applied_paths": []}, ("src/leak.cpp",), "新增未提交"),
        )
        for archive, dirty, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(
                    ValueError, message):
                state = self.state()
                state["domain_archive"] = archive
                builder(state, "main", current_dirty=dirty)

    def test_unchanged_delivery_keeps_proven_build_residue_out_of_manifest(self):
        state = self.state()
        state["domain_archive"] = {
            "status": "applied", "result": "unchanged",
            "applied_paths": [],
        }
        manifest = delivery_manifest.build_unchanged_delivery_manifest(
            state,
            "main",
            current_dirty=(
                "docs/user-notes.md", "build/main.o", "test/fars1.db"),
            preserved_initial_dirty=("docs/user-notes.md",),
            build_residue_fingerprints={
                "build/main.o": "object-fingerprint",
                "test/fars1.db": "database-fingerprint",
            },
        )

        self.assertEqual([], manifest["files"])
        self.assertEqual({
            "build/main.o": "object-fingerprint",
            "test/fars1.db": "database-fingerprint",
        }, manifest["unchanged_build_residue"])

    def test_residue_selection_uses_provenance_and_never_hides_agent_source(self):
        dirty = (
            "build/main.o",
            "test/fars1.db",
            "test/new_case.cpp",
            "imap/maybe-resource.json",
            ".gitignore",
        )
        residue = select_unchanged_build_residue(
            dirty,
            agent_written=(".gitignore",),
            compile_side_effects=(
                "test/fars1.db", "test/new_case.cpp"),
            artifact_confidence=lambda path: (
                "strong" if path.endswith(".o") else ""),
            is_source=lambda path: path.endswith(".cpp"),
            fingerprint=lambda path: "fp:" + path,
        )

        self.assertEqual({
            "build/main.o": "fp:build/main.o",
            "test/fars1.db": "fp:test/fars1.db",
        }, residue)
        self.assertNotIn("test/new_case.cpp", residue)
        self.assertNotIn("imap/maybe-resource.json", residue)
        self.assertNotIn(".gitignore", residue)

    def test_unchanged_delivery_rejects_stale_build_residue_receipt(self):
        state = self.state()
        state["domain_archive"] = {
            "status": "applied", "result": "unchanged",
            "applied_paths": [],
        }
        with self.assertRaisesRegex(ValueError, "不属于当前未提交文件"):
            delivery_manifest.build_unchanged_delivery_manifest(
                state,
                "main",
                current_dirty=("build/current.o",),
                build_residue_fingerprints={
                    "build/current.o": "current-fingerprint",
                    "build/stale.o": "stale-fingerprint",
                },
            )

    def test_compile_logs_are_recognised_as_strong_build_artifacts(self):
        self.assertEqual("strong", _build_artifact_confidence("build/compile.log"))


    def test_commit_wording_does_not_invalidate_file_selection(self):
        state = self.state()
        state["delivery_manifest"] = {
            "files": ["src/a.cpp"],
            "commit_message": "feat: A",
            "target_branch": "main",
            "adopted_dirty": {},
            "confirmed": True,
        }

        same = build_delivery_manifest(
            state, ["src/a.cpp"], "feat: A", "main", (),
            candidate_paths=("src/a.cpp",))
        changed = build_delivery_manifest(
            state, ["src/a.cpp"], "feat: A revised", "main", (),
            candidate_paths=("src/a.cpp",))

        self.assertTrue(same["confirmed"])
        self.assertTrue(changed["confirmed"])
        state["delivery_manifest"] = changed
        self.assertTrue(build_delivery_manifest(
            state, ["src/a.cpp"], "feat: A revised", "main", (),
            candidate_paths=("src/a.cpp",))["confirmed"])

    def test_confirmation_is_a_single_semantic_user_decision(self):
        state = self.state()
        state["delivery_manifest"] = build_delivery_manifest(
            state, ["src/a.cpp"], "feat: A", "main", (),
            candidate_paths=("src/a.cpp",))
        api = types.SimpleNamespace(
            _is_positive_confirmation=lambda answer: answer.startswith("确认"),
            _authorization_message=mock.Mock(return_value=(
                True, "确认按该清单提交", {"message_id": "msg-1"}, "")),
        )

        first = confirm_delivery_manifest(state, "msg-1", api)
        second = confirm_delivery_manifest(first, "msg-1", api)

        self.assertTrue(first["delivery_manifest"]["confirmed"])
        self.assertIs(first, second)
        api._authorization_message.assert_called_once()

    def test_negative_user_answer_does_not_confirm_manifest(self):
        state = self.state()
        state["delivery_manifest"] = build_delivery_manifest(
            state, ["src/a.cpp"], "feat: A", "main", (),
            candidate_paths=("src/a.cpp",))
        api = types.SimpleNamespace(
            _is_positive_confirmation=lambda _answer: False,
            _authorization_message=mock.Mock(return_value=(
                True, "不同意，这个清单还要修改",
                {"message_id": "msg-no"}, "")),
        )

        with self.assertRaisesRegex(ValueError, "没有明确批准"):
            confirm_delivery_manifest(state, "msg-no", api)
        self.assertFalse(state["delivery_manifest"]["confirmed"])

    def test_moonlight_can_confirm_without_fabricating_a_user_message(self):
        state = self.state()
        state["moonlight"] = {"enabled": True}
        state["delivery_manifest"] = build_delivery_manifest(
            state, ["src/a.cpp"], "feat: A", "main", (),
            candidate_paths=("src/a.cpp",))
        updated = confirm_delivery_manifest(
            state, "", types.SimpleNamespace(), moonlight_auto=True)
        self.assertTrue(updated["delivery_manifest"]["confirmed"])
        self.assertEqual(
            "moonlight-auto",
            updated["delivery_manifest"]["confirmation"]["mode"],
        )


if __name__ == "__main__":
    unittest.main()
