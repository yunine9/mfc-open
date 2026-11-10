#!/usr/bin/env python3
"""Delivery cannot reach push with an uncommitted confirmed manifest."""

import os
import sys
import types
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.delivery.evidence import DeliveryEvidenceRules  # noqa: E402


def rules(
        committed=(), dirty=(), message="[REQ-1][feat]archive domain truth",
        fingerprints=None):
    def argv(arguments):
        if arguments[:3] == ["git", "cat-file", "-t"]:
            return "commit"
        if arguments[:3] == ["git", "log", "--format=%H"]:
            return "new-head"
        if arguments[:3] == ["git", "diff", "--name-only"]:
            return "\n".join(committed)
        return ""

    return DeliveryEvidenceRules(types.SimpleNamespace(
        argv_output=argv,
        shell_output=lambda command: message if "pretty=%s" in command else "",
        dirty_paths=lambda: list(dirty),
        path_fingerprint=lambda path: (fingerprints or {}).get(path, "missing"),
    ))


class DeliveryCommitCycleTests(unittest.TestCase):
    def state(self):
        return {
            "current": "delivery_review",
            "config": {"单号": "REQ-1"},
            "step_heads": {"delivery_review": "base-head"},
            "delivery_manifest": {
                "files": ["docs/specs/radio.md"],
                "confirmed": True,
            },
        }

    def test_confirmed_manifest_must_be_committed_and_clean(self):
        missing = rules().delivery_manifest_committed({}, self.state())
        dirty = rules(
            committed=("docs/specs/radio.md",),
            dirty=("docs/specs/radio.md",),
        ).delivery_manifest_committed({}, self.state())
        clean = rules(
            committed=("docs/specs/radio.md",),
        ).delivery_manifest_committed({}, self.state())
        self.assertFalse(missing.passed)
        self.assertFalse(dirty.passed)
        self.assertTrue(clean.passed)

    def test_unconfirmed_manifest_never_authorizes_delivery_commit(self):
        state = self.state()
        state["delivery_manifest"]["confirmed"] = False
        result = rules(
            committed=("docs/specs/radio.md",),
        ).delivery_manifest_committed({}, state)
        self.assertFalse(result.passed)
        self.assertIn("未确认", result.reason)

    def test_unchanged_archive_needs_no_empty_commit(self):
        state = self.state()
        state["domain_archive"] = {
            "status": "applied", "result": "unchanged",
            "applied_paths": [],
        }
        state["delivery_manifest"] = {
            "files": [], "confirmed": True, "no_changes": True,
            "unchanged_initial_dirty": [],
        }

        clean = rules().delivery_manifest_committed({}, state)
        leaked = rules(
            dirty=("src/leak.cpp",)).delivery_manifest_committed({}, state)

        self.assertTrue(clean.passed, clean.reason)
        self.assertFalse(leaked.passed)
        self.assertIn("新增未提交", leaked.reason)

    def test_unchanged_archive_allows_only_the_fingerprinted_build_snapshot(self):
        state = self.state()
        state["domain_archive"] = {
            "status": "applied", "result": "unchanged",
            "applied_paths": [],
        }
        state["delivery_manifest"] = {
            "files": [], "confirmed": True, "no_changes": True,
            "unchanged_initial_dirty": [],
            "unchanged_build_residue": {
                "build/main.o": "object-v1",
            },
        }

        same = rules(
            dirty=("build/main.o",),
            fingerprints={"build/main.o": "object-v1"},
        ).delivery_manifest_committed({}, state)
        changed = rules(
            dirty=("build/main.o",),
            fingerprints={"build/main.o": "object-v2"},
        ).delivery_manifest_committed({}, state)
        mixed = rules(
            dirty=("build/main.o", "src/leak.cpp"),
            fingerprints={"build/main.o": "object-v1"},
        ).delivery_manifest_committed({}, state)

        self.assertTrue(same.passed, same.reason)
        self.assertFalse(changed.passed)
        self.assertIn("build/main.o", changed.reason)
        self.assertFalse(mixed.passed)
        self.assertIn("src/leak.cpp", mixed.reason)

if __name__ == "__main__":
    unittest.main()


class ManifestSeesEarlierBranchCommitsTests(unittest.TestCase):
    """更早的步骤已经提交过的清单文件,不该被判成"仍未形成提交"。

    交付清单覆盖整单产物,而质量检视后的提交、build 后的提交都早于交付检视步。
    只比对本步入口 HEAD..HEAD 时那些文件不在窗口内,清单永远核不过,
    而 Agent 拿到"仍未形成提交: X"也无从下手——X 已经在 HEAD 里了。
    """

    def rules(self, step_window=(), branch_window=()):
        def argv(arguments):
            if arguments[:3] == ["git", "cat-file", "-t"]:
                return "commit"
            if arguments[:3] == ["git", "log", "--format=%H"]:
                return "new-head"
            if arguments[:2] == ["git", "merge-base"]:
                return "branch-base"
            if arguments[:3] == ["git", "diff", "--name-only"]:
                base = arguments[3]
                return "\n".join(
                    branch_window if base == "branch-base" else step_window)
            return ""

        return DeliveryEvidenceRules(types.SimpleNamespace(
            argv_output=argv,
            shell_output=lambda command: (
                "[REQ-1][feat]x" if "pretty=%s" in command else ""),
            dirty_paths=lambda: [],
        ))

    def state(self):
        return {
            "current": "delivery_review",
            "config": {"单号": "REQ-1", "基线分支": "master"},
            "step_heads": {"delivery_review": "base-head"},
            "delivery_manifest": {
                "files": ["src/a.py", "docs/specs/radio.md"],
                "confirmed": True,
            },
        }

    def test_file_committed_before_this_step_still_counts(self):
        result = self.rules(
            step_window=("docs/specs/radio.md",),
            branch_window=("src/a.py", "docs/specs/radio.md"),
        ).delivery_manifest_committed({}, self.state())
        self.assertTrue(result.passed, result.reason)

    def test_file_committed_nowhere_still_blocks(self):
        result = self.rules(
            step_window=("docs/specs/radio.md",),
            branch_window=("docs/specs/radio.md",),
        ).delivery_manifest_committed({}, self.state())
        self.assertFalse(result.passed)
        self.assertIn("src/a.py", result.reason)

    def test_missing_baseline_config_falls_back_to_step_window(self):
        state = self.state()
        state["config"].pop("基线分支")
        result = self.rules(
            step_window=("docs/specs/radio.md",),
            branch_window=("src/a.py", "docs/specs/radio.md"),
        ).delivery_manifest_committed({}, state)
        self.assertFalse(result.passed)
