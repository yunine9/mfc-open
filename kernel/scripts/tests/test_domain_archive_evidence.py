#!/usr/bin/env python3
"""Workflow Evidence for the one durable archive boundary."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.evidence_rules import (  # noqa: E402
    WorkflowEvidenceRules,
)


class DomainArchiveEvidenceTests(unittest.TestCase):
    def test_applied_change_or_confirmed_unchanged_passes(self):
        rules = WorkflowEvidenceRules(None)
        changed = rules.domain_archive_complete({}, {
            "domain_archive": {
                "status": "applied", "result": "changes",
                "applied_paths": ["docs/specs/radio.md"],
            },
        })
        unchanged = rules.domain_archive_complete({}, {
            "domain_archive": {
                "status": "applied", "result": "unchanged",
                "applied_paths": [],
            },
        })
        self.assertTrue(changed.passed)
        self.assertTrue(unchanged.passed)

    def test_draft_and_invalid_paths_fail_with_one_recovery_command(self):
        rules = WorkflowEvidenceRules(None)
        draft = rules.domain_archive_complete({}, {
            "domain_archive": {"status": "draft"},
        })
        invalid = rules.domain_archive_complete({}, {
            "domain_archive": {
                "status": "applied", "result": "changes",
                "applied_paths": ["docs/review/REVIEW-1.md"],
            },
        })
        self.assertFalse(draft.passed)
        self.assertIn("domain-archive status", draft.reason)
        self.assertFalse(invalid.passed)


if __name__ == "__main__":
    unittest.main()


class ArchivedPathsAreOwnedTests(unittest.TestCase):
    """领域归档写的文件不是"来路不明"。

    实战:每一单收尾都要报一次「docs/specs/index.md、notify-service.md
    不在 Agent 实际改写的候选范围内,请逐个确认」——可它们正是 harness
    自己的 domain-archive 写的。狼来了喊多了就没人听了。

    认账依据不是给 docs/specs/ 开白名单(那样任何人往里塞文件都能蒙混),
    而是这一单归档时实际落盘的那份清单。
    """

    def test_only_this_delivery_archived_paths_are_trusted(self):
        from mae_flow_core.cli_commands import git_ownership
        state = {"domain_archive": {
            "result": "changes",
            "applied_paths": ["docs/specs/index.md",
                              "docs/specs/notify-service.md"]}}
        for path in state["domain_archive"]["applied_paths"]:
            self.assertTrue(
                git_ownership._trusted_harness_commit_path(path, state),
                "归档清单里的文件应当认账: %s" % path)
        for path in ("docs/specs/别人塞的.md", "service/src/x.py"):
            self.assertFalse(
                git_ownership._trusted_harness_commit_path(path, state),
                "清单外的文件不该白认: %s" % path)
        self.assertFalse(git_ownership._trusted_harness_commit_path(
            "docs/specs/index.md", {}), "没归档过就不该认账")
