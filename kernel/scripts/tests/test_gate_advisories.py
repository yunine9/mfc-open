#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""非阻断提示必须走到 Agent 真的会读的通道。

宿主在 Hook 退 0 时只把输出给人看，不进模型上下文。提交前 lightcheck findings
和编译副作用归属提示以前都写在那条 stderr 上，等于从未送达。
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


TESTS = os.path.abspath(os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(TESTS, "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
MAE = os.path.join(SCRIPTS, "mae-flow.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.advisories import (  # noqa: E402
    advisory_path,
    pending_advisories,
    record_advisory,
    render_advisories,
)


class AdvisoryChannelTests(unittest.TestCase):
    def test_advisories_are_scoped_to_the_current_round(self):
        with tempfile.TemporaryDirectory() as root:
            state = os.path.join(root, ".mae-flow.json")
            record_advisory(
                state, "build", "lightcheck", "旧轮提示",
                "2026-08-07 09:00:00")
            record_advisory(
                state, "build", "lightcheck", "本轮提示",
                "2026-08-07 10:00:00")
            record_advisory(
                state, "verify_ut", "lightcheck", "别的步骤",
                "2026-08-07 10:00:00")

            current = pending_advisories(
                state, "build", "2026-08-07 09:30:00")

            self.assertEqual(
                ["本轮提示"], [item["message"] for item in current])

    def test_repeated_identical_advisories_are_not_stacked(self):
        with tempfile.TemporaryDirectory() as root:
            state = os.path.join(root, ".mae-flow.json")
            for _ in range(4):
                record_advisory(
                    state, "build", "lightcheck", "同一条",
                    "2026-08-07 10:00:00")
            with open(advisory_path(state), encoding="utf-8") as stream:
                stored = json.load(stream)["advisories"]
            self.assertEqual(1, len(stored))

    def test_recovery_does_not_replay_retired_form_notices_or_delete_quality_findings(self):
        with tempfile.TemporaryDirectory() as root:
            state = os.path.join(root, ".mae-flow.json")
            kinds = ["template", "quality:glob", "quality:content_free",
                     "quality:local_spec_valid", "lightcheck", "quality:verification_passed",
                     "quality:agent_ran", "quality:domain_archive_complete"]
            for kind in kinds:
                record_advisory(state, "story", kind, kind, "2026-09-13 09:00:00")
            before = Path(advisory_path(state)).read_bytes()
            current = pending_advisories(state, "story")
            self.assertEqual(kinds[4:], [item["kind"] for item in current])
            self.assertEqual(before, Path(advisory_path(state)).read_bytes(),
                             "读取提示不改写旧任务数据")

    def test_render_is_empty_without_notices(self):
        self.assertEqual("", render_advisories(()))
        self.assertIn(
            "非阻断提示",
            render_advisories(({"message": "x", "kind": "k"},)))

    def test_commit_advisory_reaches_the_agent_through_current(self):
        """门禁放行的提交提示必须出现在 current 输出里。"""
        with tempfile.TemporaryDirectory() as repo:
            def git(*args):
                subprocess.run(
                    ["git", *args], cwd=repo, check=True,
                    capture_output=True)

            git("init", "-q")
            git("config", "user.email", "advisory@test.invalid")
            git("config", "user.name", "Advisory Test")
            with open(os.path.join(repo, "README.md"), "w",
                      encoding="utf-8") as stream:
                stream.write("base\n")
            git("add", "README.md")
            git("commit", "-qm", "base")
            git("branch", "-M", "main")
            git("checkout", "-qb", "feature")
            # 未经 Write/Edit 台账的改动 → 归属不明，产生非阻断提示。
            with open(os.path.join(repo, "m.c"), "w",
                      encoding="utf-8") as stream:
                stream.write("int main(void) { return 0; }\n")
            with open(os.path.join(repo, ".mae-flow.json"), "w",
                      encoding="utf-8") as stream:
                json.dump({
                    "current": "build",
                    "config": {
                        "单号": "REQ123", "单号类型": "fix",
                        "基线分支": "main", "分支名": "feature",
                    },
                    "choices": {"workflow": "full"},
                    "history": [],
                    "started": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "initial_dirty": [], "initial_dirty_fingerprints": {},
                }, stream, ensure_ascii=False)

            gate = subprocess.run(
                [sys.executable, MAE, "gate", "bash",
                 'git add -- m.c && git commit -m "impl"'],
                cwd=repo, text=True, capture_output=True, timeout=120)
            self.assertEqual(
                0, gate.returncode, gate.stdout + gate.stderr)

            current = subprocess.run(
                [sys.executable, MAE, "current"],
                cwd=repo, text=True, capture_output=True, timeout=120)

        self.assertIn("非阻断提示", current.stdout, current.stderr)
        self.assertIn("commit message", current.stdout)


if __name__ == "__main__":
    unittest.main()
