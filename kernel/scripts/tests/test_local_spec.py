#!/usr/bin/env python3
"""Local-only requirement specification behavior."""

import importlib
import importlib.util
import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402


VALID_SPEC = """# 需求规格

## 范围
支持 NRPRACH SUL 模式。

## 可观察行为
SUL + N95 映射为 TYPE_2。

## 验收条件
- 给定 SUL + N95，返回 TYPE_2。

## 不在范围
- 不扩展 isRBNumMode。

## Grill 决策
- GQ-01：N98 使用 TYPE_1。
"""


class LocalSpecTests(unittest.TestCase):
    def _module(self):
        name = "mae_flow_core.cli_commands.local_spec"
        self.assertIsNotNone(importlib.util.find_spec(name))
        return importlib.import_module(name)

    def test_parser_accepts_local_spec_actions(self):
        for action in ("init", "validate", "show"):
            with self.subTest(action=action):
                try:
                    args = parse_args(["local-spec", action])
                except SystemExit:
                    self.fail("local-spec command is missing")
                self.assertEqual("local-spec", args.cmd)
                self.assertEqual(action, args.local_spec_action)

    def test_spec_is_created_only_in_the_ticket_work_package(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as root:
            path = module.initialize_local_spec(root, "REQ-123")
            self.assertEqual(
                os.path.join(root, ".mae-flow-work", "REQ-123", "spec.md"),
                path,
            )
            self.assertTrue(os.path.isfile(path))
            self.assertFalse(os.path.exists(os.path.join(root, "docs", "specs", "requirements")))

    def test_validation_requires_scope_behavior_acceptance_exclusions_and_grill(self):
        module = self._module()
        self.assertEqual((), module.local_spec_errors(VALID_SPEC))
        for heading in (
                "## 范围", "## 可观察行为", "## 验收条件",
                "## 不在范围", "## Grill 决策"):
            with self.subTest(heading=heading):
                broken = VALID_SPEC.replace(heading, "## 已删除", 1)
                self.assertIn(heading, module.local_spec_errors(broken))


if __name__ == "__main__":
    unittest.main()
