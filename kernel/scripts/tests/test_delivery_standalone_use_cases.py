#!/usr/bin/env python3
"""Standalone delivery lifecycle use-case tests."""

import os
import json
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.application.delivery.standalone import (  # noqa: E402
    confirm_standalone_scope,
    finish_standalone,
    inspect_standalone,
    prepare_standalone_critic,
    start_standalone,
)
from mae_flow_core.delivery.models import thaw  # noqa: E402


class StandaloneLifecycleUseCaseTests(unittest.TestCase):
    def test_start_rejects_live_flow_and_existing_action(self):
        result = start_standalone(
            live_flow=True,
            current_action=None,
            kind="ut",
            config={},
            files=("biz.py",),
            request="",
            check_only=False,
            action_id="id",
            created_at="now",
            expires_epoch=100,
            work_dir="/tmp/work",
            base_head="head",
            sources=(),
            inferred_scope=False,
            scope_epoch=1,
        )
        self.assertEqual(2, result.exit_code)
        result = start_standalone(
            live_flow=False,
            current_action={"id": "old", "kind": "ut"},
            kind="ut",
            config={},
            files=("biz.py",),
            request="",
            check_only=False,
            action_id="id",
            created_at="now",
            expires_epoch=100,
            work_dir="/tmp/work",
            base_head="head",
            sources=(),
            inferred_scope=False,
            scope_epoch=1,
        )
        self.assertIn("old", result.stderr[0])

    def test_start_builds_scope_pending_action(self):
        result = start_standalone(
            live_flow=False,
            current_action=None,
            kind="codecheck",
            config={"编译方式": "build"},
            files=("biz.py",),
            request=" fix warnings ",
            check_only=False,
            action_id="id",
            created_at="2026-07-30 14:00:00",
            expires_epoch=100,
            work_dir="/tmp/work",
            base_head="head",
            sources=("request.md",),
            inferred_scope=True,
            scope_epoch=2,
        )
        action = thaw(result.effects[0].payload)
        self.assertEqual("awaiting_scope_confirmation", action["status"])
        self.assertEqual("dirty-worktree", action["scope_source"])
        self.assertEqual("show_scope", result.effects[1].kind)

    def test_confirm_scope_routes_kind_after_freezing_files(self):
        action = {
            "kind": "ut",
            "status": "awaiting_scope_confirmation",
            "files": ["biz.py"],
        }
        result = confirm_standalone_scope(
            action=action,
            confirmation_receipt={
                "message_id": "scope-answer",
                "scope_sha256": "scope-v1",
            },
            ack_verified=(True, ""),
            validated_files=("biz.py",),
            now="2026-07-30 14:10:00",
        )
        updated = thaw(result.effects[0].payload)
        self.assertEqual("active", updated["status"])
        self.assertEqual(
            "scope-answer",
            updated["scope_confirmation_receipt"]["message_id"],
        )
        self.assertNotIn("scope_confirmed_ack", updated)
        self.assertEqual("create_task_card", result.effects[1].kind)

    def test_finish_non_grill_requires_agent_token(self):
        result = finish_standalone(
            action={"kind": "ut", "tokens": {}, "rejections": {}},
            report_path="",
            report_exists=False,
            report_text="",
            report_error="",
        )
        self.assertEqual(2, result.exit_code)
        action = {
            "kind": "ut",
            "tokens": {
                "UT": {"status": "PASS", "report_path": "ut-report.md"},
            },
        }
        result = finish_standalone(
            action=action,
            report_path="",
            report_exists=False,
            report_text="",
            report_error="",
        )
        self.assertEqual("archive_action", result.effects[0].kind)
        self.assertIn("结果：PASS", result.stdout[0])

    def test_status_and_critic_are_pure_lifecycle_queries(self):
        result = inspect_standalone(None)
        self.assertIn("普通开发完全不受", result.stdout[0])
        action = {
            "kind": "grill",
            "sources": [],
            "grill": {},
        }
        result = prepare_standalone_critic(
            action, "/tmp/final.md", True, "final")
        updated = thaw(result.effects[0].payload)["action"]
        self.assertEqual("final", updated["grill"]["last_critic_stage"])
        self.assertIn("/tmp/final.md", updated["sources"])
        rendered = inspect_standalone(updated)
        self.assertEqual(
            updated, json.loads("\n".join(rendered.stdout)))


if __name__ == "__main__":
    unittest.main()
