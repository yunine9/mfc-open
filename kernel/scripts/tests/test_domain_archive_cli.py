#!/usr/bin/env python3
"""CLI contract for the local domain archive."""

import argparse
import contextlib
import io
import os
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402
from mae_flow_core.cli_commands import domain_archive  # noqa: E402
from mae_flow_core.orchestration.behavior_baseline import (  # noqa: E402
    REQUIRED_DOMAIN_SECTIONS,
)


class DomainArchiveCliTests(unittest.TestCase):
    def setUp(self):
        # These command-format unit tests isolate Git; recovery tests use a real repository.
        patcher = mock.patch.object(domain_archive, "changed_domain_paths", return_value=[])
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _domain_document():
        return "# 无线接入\n\n" + "\n\n".join(
            "## %s\n这是已经确认并长期生效的领域事实。" % heading
            for heading in REQUIRED_DOMAIN_SECTIONS)

    def test_parser_accepts_all_copyable_archive_commands(self):
        commands = (
            ["domain-archive", "prepare", "--domain", "radio", "--keyword", "SUL"],
            ["domain-archive", "prepare", "--unchanged"],
            ["domain-archive", "show"],
            ["domain-archive", "status"],
            ["domain-archive", "apply", "--message-id", "msg-1"],
            ["domain-archive", "apply", "--moonlight-auto"],
        )
        for argv in commands:
            with self.subTest(argv=argv):
                self.assertEqual("domain-archive", parse_args(argv).cmd)

    def test_unchanged_can_be_confirmed_and_applied(self):
        state = {
            "current": "domain_archive",
            "config": {"单号": "REQ-1"},
        }
        saved = []
        fake_api = types.SimpleNamespace(
            save_state=lambda value: saved.append(value),
            sh=lambda _command: "",
            _is_positive_confirmation=lambda answer: answer.startswith("确认"),
            _authorization_message=mock.Mock(return_value=(
                True, "确认无需更新领域文档",
                {"message_id": "msg-1", "answer_sha256": "a"}, "")),
            die=lambda message, code=1: (_ for _ in ()).throw(
                RuntimeError("%s:%s" % (code, message))),
        )
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                domain_archive, "api", fake_api), mock.patch.object(
                domain_archive.os, "getcwd", return_value=root):
            prepared = domain_archive.cmd_domain_archive(
                state, argparse.Namespace(
                    domain_archive_action="prepare", unchanged=True,
                    domain=None, keyword=[]))
            applied = domain_archive.cmd_domain_archive(
                saved[-1], argparse.Namespace(
                    domain_archive_action="apply", message_id="msg-1"))
        self.assertEqual("prepared", prepared["status"])
        self.assertEqual("applied", applied["status"])
        self.assertEqual([], applied["applied_paths"])
        self.assertTrue(applied["input_sha256"])

    def test_negative_user_answer_never_applies_archive(self):
        state = {
            "current": "domain_archive",
            "config": {"单号": "REQ-1"},
        }
        saved = []
        fake_api = types.SimpleNamespace(
            save_state=lambda value: saved.append(value),
            sh=lambda _command: "",
            _is_positive_confirmation=lambda _answer: False,
            _authorization_message=mock.Mock(return_value=(
                True, "不同意，请继续修改领域文档",
                {"message_id": "msg-no", "answer_sha256": "n"}, "")),
            die=lambda message, code=1: (_ for _ in ()).throw(
                RuntimeError("%s:%s" % (code, message))),
        )
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                domain_archive, "api", fake_api), mock.patch.object(
                domain_archive.os, "getcwd", return_value=root):
            domain_archive.cmd_domain_archive(
                state, argparse.Namespace(
                    domain_archive_action="prepare", unchanged=True,
                    domain=None, keyword=[]))
            with self.assertRaisesRegex(RuntimeError, "没有明确批准"):
                domain_archive.cmd_domain_archive(
                    saved[-1], argparse.Namespace(
                        domain_archive_action="apply", message_id="msg-no"))

    def test_moonlight_applies_prepared_archive_without_user_message(self):
        state = {
            "current": "domain_archive",
            "config": {"单号": "REQ-1"},
            "moonlight": {"enabled": True},
        }
        saved = []
        fake_api = types.SimpleNamespace(
            save_state=lambda value: saved.append(value),
            sh=lambda _command: "",
            die=lambda message, code=1: (_ for _ in ()).throw(
                RuntimeError("%s:%s" % (code, message))),
        )
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                domain_archive, "api", fake_api), mock.patch.object(
                domain_archive.os, "getcwd", return_value=root):
            domain_archive.cmd_domain_archive(
                state, argparse.Namespace(
                    domain_archive_action="prepare", unchanged=True,
                    domain=None, keyword=[]))
            applied = domain_archive.cmd_domain_archive(
                saved[-1], argparse.Namespace(
                    domain_archive_action="apply", message_id=None,
                    moonlight_auto=True))
        self.assertEqual("applied", applied["status"])
        self.assertEqual(
            "moonlight-auto", applied["authorization"]["mode"])

    def test_untracked_legacy_process_file_is_moved_into_work_package(self):
        state = {"config": {"单号": "REQ-1"}}
        fake_api = types.SimpleNamespace(argv_out=lambda _args: "")
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                domain_archive, "api", fake_api):
            source = os.path.join(root, "docs", "clarifications-REQ-1.md")
            os.makedirs(os.path.dirname(source))
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("confirmed decisions")
            package = domain_archive.ensure_work_package(root, "REQ-1")
            moved = domain_archive._localize_legacy_process_files(
                root, state, package)
            self.assertEqual(1, len(moved))
            self.assertFalse(os.path.exists(source))
            self.assertTrue(os.path.isfile(package.decisions))

    def test_draft_status_preserves_one_copyable_recovery_command(self):
        state = {
            "current": "domain_archive",
            "config": {"单号": "REQ-1"},
        }
        saved = []
        fake_api = types.SimpleNamespace(
            save_state=lambda value: saved.append(value),
            sh=lambda _command: "",
            argv_out=lambda _arguments: "",
            _scope_diff=lambda _state: ("HEAD", ""),
            _dirty_paths=lambda: [],
            die=lambda message, code=1: (_ for _ in ()).throw(
                RuntimeError("%s:%s" % (code, message))),
        )
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                domain_archive, "api", fake_api), mock.patch.object(
                domain_archive.os, "getcwd", return_value=root):
            template = os.path.join(
                root, ".mae-flow-work", "plugin-resources", "assets",
                "DOMAIN-SPEC-TEMPLATE.md")
            os.makedirs(os.path.dirname(template), exist_ok=True)
            with open(template, "w", encoding="utf-8") as stream:
                stream.write("# <领域名称>\n")
            domain_archive.cmd_domain_archive(
                state, argparse.Namespace(
                    domain_archive_action="prepare", unchanged=False,
                    domain="radio", keyword=["SUL"]))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                domain_archive.cmd_domain_archive(
                    saved[-1], argparse.Namespace(
                        domain_archive_action="status"))

        self.assertEqual(
            ["SUL"], saved[-1]["domain_archive"]["domains"][0]["keywords"])
        self.assertEqual(1, output.getvalue().count("下一步:"))
        self.assertIn(
            'domain-archive prepare --domain "radio" --keyword "SUL"',
            output.getvalue(),
        )

    def test_all_prepared_candidates_unchanged_report_unchanged(self):
        state = {
            "current": "domain_archive",
            "config": {"单号": "REQ-1"},
        }
        saved = []
        fake_api = types.SimpleNamespace(
            save_state=lambda value: saved.append(value),
            sh=lambda _command: "",
            argv_out=lambda _arguments: "",
            _scope_diff=lambda _state: ("HEAD", ""),
            _dirty_paths=lambda: [],
            die=lambda message, code=1: (_ for _ in ()).throw(
                RuntimeError("%s:%s" % (code, message))),
        )
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                domain_archive, "api", fake_api), mock.patch.object(
                domain_archive.os, "getcwd", return_value=root):
            template = os.path.join(
                root, ".mae-flow-work", "plugin-resources", "assets",
                "DOMAIN-SPEC-TEMPLATE.md")
            target = os.path.join(root, "docs", "specs", "radio.md")
            os.makedirs(os.path.dirname(template), exist_ok=True)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(template, "w", encoding="utf-8") as stream:
                stream.write("# <领域名称>\n")
            with open(target, "w", encoding="utf-8") as stream:
                stream.write(self._domain_document())
            args = argparse.Namespace(
                domain_archive_action="prepare", unchanged=False,
                domain="radio", keyword=["SUL"])
            domain_archive.cmd_domain_archive(state, args)
            record = domain_archive.cmd_domain_archive(saved[-1], args)

        self.assertEqual("prepared", record["status"])
        self.assertEqual("unchanged", record["result"])


if __name__ == "__main__":
    unittest.main()
