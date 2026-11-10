#!/usr/bin/env python3
"""Observational build milestones never become workflow gates."""

import os
import json
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.build_milestones import (  # noqa: E402
    append_event,
    build_event,
    implementation_tasks,
    select_task,
)
from mae_flow_core.cli_parser import build_parser  # noqa: E402


class BuildMilestoneTests(unittest.TestCase):
    def test_parses_checkbox_and_template_task_references(self):
        tasks = implementation_tasks(
            "- [ ] 1. 实现入口\n"
            "- `src/a.py` — 修改。任务 2\n"
            "- `src/b.py` — 修改。任务 2\n")
        self.assertEqual(["1", "2"], [item.task_id for item in tasks])
        self.assertEqual("实现入口", select_task(tasks, "1").title)

    def test_titled_checklist_overrides_placeholder_even_when_later(self):
        """文件行(任务 N)在前、任务清单在后是模板的真实顺序;真标题
        必须压过占位,否则云端进度只显示"任务 2"(2026-08-26 用户点名)。"""
        tasks = implementation_tasks(
            "- `src/a.py` — 修改。任务 1\n"
            "- `src/b_test.py` — 新建。任务 2\n"
            "- [ ] 1. TextUtil 新增脱敏并接入三渠道\n"
            "- [ ] 2. 脱敏行为全量用例\n")
        self.assertEqual(
            "TextUtil 新增脱敏并接入三渠道", select_task(tasks, "1").title)
        self.assertEqual("脱敏行为全量用例", select_task(tasks, "2").title)

    def test_event_binds_revision_document_and_worktree(self):
        task = implementation_tasks("- [ ] 1. 实现入口")[0]
        event = build_event(
            event="started", task=task, step="build", state_revision=17,
            step_head="a" * 40,
            implementation_path=".mae-flow-work/REQ/implementation.md",
            implementation_digest="b" * 64,
            worktree_snapshot={"src/a.py": "blob-a"},
            at="2026-08-20 10:00:00", nonce="1")
        self.assertEqual(17, event["step_revision"])
        self.assertEqual(["src/a.py"], event["changed_paths"])
        self.assertEqual(64, len(event["worktree_sha256"]))
        self.assertEqual("b" * 64, event["implementation_sha256"])

    def test_ledger_is_append_only_even_for_repeated_status(self):
        task = implementation_tasks("- [ ] 1. 实现入口")[0]
        common = dict(
            event="started", task=task, step="build", state_revision=17,
            step_head="a", implementation_path="implementation.md",
            implementation_digest="b", worktree_snapshot={},
            at="2026-08-20 10:00:00")
        first = build_event(**common, nonce="1")
        second = build_event(**common, nonce="2")
        ledger = append_event(append_event({}, first), second)
        self.assertEqual(2, len(ledger["events"]))
        self.assertNotEqual(first["id"], second["id"])

    def test_cli_surface_is_small_and_explicit(self):
        parser = build_parser()
        started = parser.parse_args([
            "milestone", "start", "--task", "2"])
        self.assertEqual(
            ("milestone", "start", "2"),
            (started.cmd, started.action, started.task))
        shown = parser.parse_args(["milestone", "show", "--json"])
        self.assertTrue(shown.json)

    def test_module_is_not_an_evidence_registry(self):
        with open(os.path.join(ROOT, "flow", "flow.json"), encoding="utf-8") as stream:
            flow = json.load(stream)
        evidence_names = {
            item.get("type")
            for step in flow.get("steps", {}).values()
            for item in step.get("evidence", [])
        }
        self.assertFalse(evidence_names & {
            "build_milestone", "milestone_started", "milestone_completed"})


if __name__ == "__main__":
    unittest.main()
