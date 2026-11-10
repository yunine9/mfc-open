#!/usr/bin/env python3
"""Integration tests for privacy-safe Hook block diagnostics."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DISPATCH = os.path.join(ROOT, "hooks", "dispatch.py")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from mae_flow_core.adapters.hook_diagnostics import recent_hook_anomalies


class HookBlockDiagnosticsTests(unittest.TestCase):
    def test_recent_hook_anomalies_reports_only_current_flow_failures(self):
        lines = [
            "2026-08-05 09:59:59 pid=1 old EXC(fail-open): old\n",
            "2026-08-05 10:00:01 pid=2 agent dispatch gate EXC(fail-open): broken\n",
            "2026-08-05 10:00:02 pid=2 WATCHDOG timeout(12s) — force exit 0\n",
            "2026-08-05 10:00:02 pid=2 usermsg EXC: disk busy\n",
            "2026-08-05 10:00:03 pid=2 normal end\n",
        ]

        anomalies = recent_hook_anomalies(
            lines, since="2026-08-05 10:00:00")

        self.assertEqual(3, len(anomalies))
        self.assertIn("agent dispatch gate EXC", anomalies[0])
        self.assertIn("WATCHDOG", anomalies[1])
        self.assertIn("usermsg EXC:", anomalies[2])

    def _run_pretooluse(self, project, log_dir, command):
        payload = json.dumps({
            "cwd": project,
            "tool_name": "Bash",
            "tool_input": {"command": command},
        }) + "\n"
        env = dict(os.environ)
        env["TMPDIR"] = log_dir
        env["PYTHONPYCACHEPREFIX"] = os.path.join(log_dir, "pycache")
        result = subprocess.run(
            [sys.executable, DISPATCH, "pretooluse"],
            cwd=project,
            input=payload,
            text=True,
            capture_output=True,
            env=env,
            timeout=15,
        )
        log_path = os.path.join(log_dir, "mae-flow-hook.log")
        with open(log_path, encoding="utf-8") as stream:
            return result, stream.read()

    def _init_flow(self, project):
        subprocess.run(
            ["git", "init", "-q", project],
            check=True,
            capture_output=True,
        )
        with open(
                os.path.join(project, ".mae-flow.json"),
                "w",
                encoding="utf-8") as stream:
            json.dump({
                "current": "config_confirm",
                "config": {},
                "choices": {},
                "history": [],
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            }, stream)

    def test_blocked_bash_logs_rule_and_hash_without_command(self):
        command = "git push --force origin HEAD # secret-token-123"
        with tempfile.TemporaryDirectory() as project:
            with tempfile.TemporaryDirectory() as log_dir:
                self._init_flow(project)
                result, log_text = self._run_pretooluse(
                    project, log_dir, command)

        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn(
            "decision event=pretooluse tool=Bash result=blocked "
            "source=mae-flow rule=bash-force-push "
            "command_sha256=f6489e3c3908813d0bd6665f60b97df2"
            "4dbaf3945ac7eb9ac2a4ff45ceebdcbe",
            log_text,
        )
        self.assertNotIn(command, log_text)
        self.assertNotIn("secret-token-123", log_text)
        self.assertNotIn("mae-flow-rule=", result.stderr)

    def test_allowed_bash_does_not_log_decision(self):
        with tempfile.TemporaryDirectory() as project:
            with tempfile.TemporaryDirectory() as log_dir:
                self._init_flow(project)
                result, log_text = self._run_pretooluse(
                    project, log_dir, "git status --short")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn(" decision event=pretooluse ", log_text)

    def test_rule_marker_is_stripped_even_after_earlier_stderr_output(self):
        """建议/advisory 先写过 stderr 时，标记不在缓冲区开头也必须剥离。"""
        from mae_flow_core.adapters.hook_diagnostics import (
            HookBlockDiagnostics,
        )
        diagnostics = HookBlockDiagnostics()
        diagnostics.subprocess_environment()
        stderr = (
            "[mae-flow] ⚠ 轻量编码预检发现 1 个问题\n"
            "  NESTING src/a.c:12 — 太深 (5 > 4)\n"
            "[mae-flow] [mae-flow-rule=bash-artifact]\n"
            "构建产物禁止提交。\n"
        )
        sanitized = diagnostics.sanitize_stderr(stderr)
        self.assertNotIn("mae-flow-rule=", sanitized)
        self.assertIn("轻量编码预检发现 1 个问题", sanitized)
        self.assertIn("[mae-flow] 构建产物禁止提交。", sanitized)
        self.assertEqual("bash-artifact", diagnostics.gate_rule)

    def test_direct_hook_block_uses_stable_fallback_rule(self):
        command = "python nested/dispatch.py # private-fragment"
        with tempfile.TemporaryDirectory() as project:
            with tempfile.TemporaryDirectory() as log_dir:
                subprocess.run(
                    ["git", "init", "-q", project],
                    check=True,
                    capture_output=True,
                )
                action_dir = os.path.join(
                    project, ".mae-flow-work", "standalone", "action-1")
                os.makedirs(action_dir)
                with open(
                        os.path.join(
                            project,
                            ".mae-flow-work",
                            "standalone-action.json",
                        ),
                        "w",
                        encoding="utf-8") as stream:
                    json.dump({
                        "id": "action-1",
                        "kind": "ut",
                        "status": "active",
                        "expires_epoch": time.time() + 3600,
                        "work_dir": action_dir,
                        "config": {},
                        "agent_tasks": {},
                        "tokens": {},
                    }, stream)
                result, log_text = self._run_pretooluse(
                    project, log_dir, command)

        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn(
            "decision event=pretooluse tool=Bash result=blocked "
            "source=mae-flow rule=hook-policy "
            "command_sha256=b151683355a6241f4dbd7230a8514025"
            "3f1ebf6d947ce7e276caa7789eff0b99",
            log_text,
        )
        self.assertNotIn(command, log_text)
        self.assertNotIn("private-fragment", log_text)


if __name__ == "__main__":
    unittest.main()
