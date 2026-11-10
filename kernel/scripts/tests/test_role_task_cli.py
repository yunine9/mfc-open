#!/usr/bin/env python3
"""Thin role-task surface regressions."""

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.cli_parser import parse_args  # noqa: E402
from mae_flow_core import cli_runtime as mf  # noqa: E402,F401
from mae_flow_core.cli_commands import role_task as role_task_cli  # noqa: E402
from mae_flow_core.quality.role_tasks import role_allowed  # noqa: E402


class RoleTaskCliTests(unittest.TestCase):
    def test_only_story_and_grill_roles_exist(self):
        for role in ("story-generate", "story-review"):
            self.assertEqual(role, parse_args(["role-task", role]).role)
        # code-review 角色随 build_agent_review 编排一同退役
        with self.assertRaises(SystemExit):
            parse_args(["role-task", "code-review"])
        args = parse_args([
            "role-task", "grill-critic", "--stage", "prep",
            "--document", ".mae-flow-work/REQ-1/grill.md",
        ])
        self.assertEqual("prep", args.stage)
        self.assertFalse(hasattr(args, "checkpoint"))

    def test_role_stage_matrix_has_no_implementation_or_batch_roles(self):
        self.assertFalse(role_allowed("code-review", "build_agent_review"))
        self.assertTrue(role_allowed("story-generate", "story"))
        self.assertTrue(role_allowed("story-review", "story"))
        self.assertTrue(role_allowed("grill-critic", "grill"))
        for role in ("implement", "cp-implement", "task-analysis", "craft-plan"):
            self.assertFalse(role_allowed(role, "build"))

if __name__ == "__main__":
    unittest.main()
