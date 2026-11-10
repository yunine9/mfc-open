#!/usr/bin/env python3
"""Every runnable command shown to an Agent agrees with the real parser."""

import glob
import os
import re
import shlex
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402
from mae_flow_core.workflow.command_catalog import (  # noqa: E402
    catalog_ids,
    render_command,
)


CONTEXT = {
    "file": "src/a.cpp", "message": "feat: A", "target": "main",
    "message_id": "msg-1", "scope": "本次修改",
}


def resource_commands():
    patterns = [
        "flow/steps/*.md", "agents/*.md", "runtime/guidance/*.md",
        "skills/mae-flow/**/*.md",
    ]
    for pattern in patterns:
        for path in glob.glob(os.path.join(ROOT, pattern), recursive=True):
            with open(path, encoding="utf-8") as stream:
                content = stream.read()
            for command in re.findall(
                    r'`python (?:"\{MAEFLOW_PATH\}"|\{MAEFLOW_PATH\}) ([^`]+)`',
                    content):
                command = re.sub(r"\s*\[[^]]+\]", "", command)
                command = re.sub(
                    r"<[^>]+>|\{[^}]+\}|CPn|第N批", "VALUE", command)
                yield os.path.relpath(path, ROOT), command


def production_guidance_texts():
    patterns = [
        "flow/steps/*.md",
        "commands/*.md",
        "README.md",
        "FIELD-TEST.md",
        "MAINTAINERS.md",
        "skills/mae-flow/SKILL.md",
        "scripts/mae_flow_core/**/*.py",
    ]
    for pattern in patterns:
        for path in glob.glob(os.path.join(ROOT, pattern), recursive=True):
            with open(path, encoding="utf-8") as stream:
                yield os.path.relpath(path, ROOT), stream.read()


class CommandPromptAgreementTests(unittest.TestCase):
    def test_every_catalog_command_is_built_then_parsed(self):
        for command_id in catalog_ids():
            with self.subTest(command=command_id):
                argv = render_command(command_id, CONTEXT)
                self.assertEqual(argv[0], parse_args(argv).cmd)

    def test_every_runnable_operational_resource_command_parses(self):
        commands = list(resource_commands())
        # 2026-08-25 编排瘦身删掉 23 个步骤文档,可执行命令样本随之变少;
        # 门槛只防"扫描器失明",不是命令数指标。
        self.assertGreater(len(commands), 15)
        for resource, command in commands:
            with self.subTest(resource=resource, command=command):
                try:
                    parse_args(shlex.split(command))
                except SystemExit as exc:
                    self.fail("不可执行命令(%s): %s (exit %s)" % (
                        resource, command, exc.code))

    def test_retired_lean_advance_commands_are_never_emitted(self):
        for resource, command in resource_commands():
            with self.subTest(resource=resource):
                self.assertNotRegex(
                    command, r"^(?:advance|decision)\s+(?:capability\.|grill-)")

    def test_production_guidance_never_emits_path_dependent_cli_commands(self):
        forbidden = re.compile(
            r"`mae-flow\s+|`mae-flow\.py\s+|"
            r"(?:执行|运行|先用|再用|先)\s+mae-flow\s+|"
            r"(?<![/\w:-])mae-flow(?:\.py)?\s+"
            r"(?:spec|current|doctor|messages|done|agent-task|role-task|"
            r"codecheck|approve-exemption|unlock|action|gate|exit)\b"
        )
        for resource, content in production_guidance_texts():
            with self.subTest(resource=resource):
                self.assertNotRegex(content, forbidden)


if __name__ == "__main__":
    unittest.main()
