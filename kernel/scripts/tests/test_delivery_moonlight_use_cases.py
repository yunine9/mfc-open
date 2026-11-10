#!/usr/bin/env python3
"""Moonlight delivery application use-case tests."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.application.delivery.moonlight import (  # noqa: E402
    activate_moonlight,
    disable_moonlight,
    finalize_moonlight,
    record_blocker,
    record_deferred_quality,
    record_push_failure,
    repair_moonlight,
)
from mae_flow_core.application.delivery.moonlight_branch import (  # noqa: E402
    MoonlightBranchFacts,
    resolve_moonlight_branch,
)
from mae_flow_core.application.delivery.moonlight_defer import (  # noqa: E402
    MoonlightDeferPorts,
    defer_moonlight_quality,
)
from mae_flow_core.delivery.models import thaw  # noqa: E402


class MoonlightUseCaseTests(unittest.TestCase):
    def state(self, current="verify_ut"):
        return {
            "current": current,
            "choices": {"workflow": "tweak"},
            "config": {"CHANGE_NAME": "change"},
            "moonlight": {
                "enabled": True,
                "cycle": 1,
                "issues": [],
            },
            "history": [],
        }

    def updated(self, result):
        return thaw(result.effects[0].payload)

    def branch_state(self):
        state = self.state("branch_create")
        state["config"].update({
            "单号": "REQ-7",
            "基线分支": "main",
            "分支名": "main_u1_REQ-7",
        })
        state["moonlight"]["request"] = "开启月光宝盒，继续当前分支"
        return state

    def branch_facts(self, **overrides):
        values = {
            "current_branch": "feature/existing",
            "head": "b" * 40,
            "base_branch": "main",
            "base_head": "a" * 40,
            "base_is_ancestor": True,
            "explicit_continue": True,
            "request_sha256": "request-sha",
            "last_state_sha256": "",
            "previous_ticket": "",
            "previous_branch": "",
            "previous_head": "",
            "previous_head_is_ancestor": False,
        }
        values.update(overrides)
        return MoonlightBranchFacts(**values)

    def test_branch_resolution_adopts_explicit_current_branch(self):
        result = resolve_moonlight_branch(
            self.branch_state(), self.branch_facts(), "now")

        updated = self.updated(result)
        receipt = updated["branch_resolution"]
        self.assertEqual("feature/existing", updated["config"]["分支名"])
        self.assertEqual("moonlight-request", receipt["source"])
        self.assertEqual("request-sha", receipt["request_sha256"])
        self.assertNotIn("hard_blocked", updated["moonlight"])

    def test_branch_resolution_adopts_only_strict_same_delivery_continuation(self):
        state = self.branch_state()
        state["moonlight"]["request"] = "开启月光宝盒处理这个需求"
        facts = self.branch_facts(
            explicit_continue=False,
            last_state_sha256="last-state-sha",
            previous_ticket="REQ-7",
            previous_branch="feature/existing",
            previous_head="9" * 40,
            previous_head_is_ancestor=True,
        )

        result = resolve_moonlight_branch(state, facts, "now")

        receipt = self.updated(result)["branch_resolution"]
        self.assertEqual("moonlight-continuation", receipt["source"])
        self.assertEqual("last-state-sha", receipt["last_state_sha256"])
        self.assertEqual("9" * 40, receipt["previous_head"])

    def test_branch_resolution_blocks_ambiguous_or_divergent_existing_work(self):
        state = self.branch_state()
        state["moonlight"]["request"] = "开启月光宝盒处理这个需求"
        ambiguous = self.branch_facts(explicit_continue=False)

        result = resolve_moonlight_branch(state, ambiguous, "now")

        updated = self.updated(result)
        self.assertEqual(
            "branch_create", updated["moonlight"]["hard_blocked"]["step"])
        self.assertNotIn("branch_resolution", updated)

        ticket_name_only = self.branch_facts(
            explicit_continue=False,
            last_state_sha256="last-state-sha",
            previous_ticket="REQ-7",
            previous_branch="feature/REQ-7-but-not-current",
            previous_head="9" * 40,
            previous_head_is_ancestor=True,
        )
        result = resolve_moonlight_branch(
            state, ticket_name_only, "still-now")
        self.assertIn(
            "拒绝猜测代码归属",
            self.updated(result)["moonlight"]["hard_blocked"]["reason"])

        divergent = self.branch_facts(base_is_ancestor=False)
        result = resolve_moonlight_branch(state, divergent, "later")
        self.assertIn(
            "不包含当前基线",
            self.updated(result)["moonlight"]["hard_blocked"]["reason"])

    def test_branch_resolution_leaves_fresh_and_non_moonlight_paths_unchanged(self):
        state = self.branch_state()
        fresh = self.branch_facts(
            current_branch="main", head="a" * 40,
            explicit_continue=False)
        self.assertEqual(
            (), resolve_moonlight_branch(state, fresh, "now").effects)

        state["moonlight"]["enabled"] = False
        self.assertEqual(
            (), resolve_moonlight_branch(
                state, self.branch_facts(), "now").effects)

    def test_blocker_and_push_failure_create_durable_issue(self):
        state = self.state("build")
        result = record_blocker(
            state, can_block=True,
            reason="external service credentials are unavailable",
            head="head", dirty_paths=("src/main.py",), now="now")
        updated = self.updated(result)
        self.assertEqual("ML-001", updated["moonlight"]["hard_blocked"]["issue"])
        self.assertEqual("write_report", result.effects[1].kind)

        state = self.state("push")
        result = record_push_failure(
            state,
            reason="authentication failed after two retries",
            head="head",
            now="now",
        )
        updated = self.updated(result)
        self.assertEqual("push", updated["moonlight"]["issues"][0]["kind"])
        self.assertEqual("push", updated["current"])

    def test_defer_supersedes_same_kind_and_requests_advance(self):
        state = self.state("verify_ut")
        state["moonlight"]["issues"] = [{
            "id": "ML-001",
            "kind": "ut",
            "reason": "old failure",
        }]
        result = record_deferred_quality(
            state,
            kind="ut",
            reason="two tests still fail after scoped repair",
            rejection="agent diagnostic",
            head="head",
            now="now",
        )
        updated = self.updated(result)
        self.assertEqual(
            "superseded",
            updated["moonlight"]["issues"][0]["resolved_as"])
        self.assertEqual("advance_deferred", result.effects[-1].kind)

    def test_defer_routes_changed_source_back_through_quality_chain(self):
        state = self.state("verify_ut")
        state["unlock"] = {
            "scope": "source",
            "step": "verify_ut",
        }
        state["agent_tasks"] = {
            "COMPILE": {"stale": True},
            "CODECHECK": {"stale": True},
            "UT": {"stale": True},
        }
        state["quality"] = {
            "codecheck_scan": {"stale": True},
            "codecheck_verify": {"stale": True},
        }
        persisted = []
        calls = []
        result = defer_moonlight_quality(
            state,
            kind="ut",
            reason="source repair still leaves one unstable test",
            rejection="agent diagnostic",
            recheck="verify_recompile",
            ports=MoonlightDeferPorts(
                build_boundary=lambda: (
                    calls.append("build") or (True, "")),
                dirty_paths=lambda: (
                    calls.append("dirty") or ()),
                head=lambda: "head",
                now=lambda: "now",
                persist_issue=lambda updated: (
                    calls.append("persist"),
                    persisted.append(updated),
                ),
                ensure_step_entry=lambda: (
                    calls.append("ensure") or ""),
                source_changes=lambda: (
                    calls.append("changes")
                    or (("src/main.py",), "")),
            ),
        )
        updated = self.updated(result)
        self.assertEqual("verify_recompile", updated["current"])
        self.assertNotIn("unlock", updated)
        self.assertEqual({}, updated["agent_tasks"])
        self.assertEqual({}, updated["quality"])
        self.assertEqual("print_current", result.effects[-1].kind)
        self.assertNotIn(
            "advance_deferred",
            [effect.kind for effect in result.effects],
        )
        self.assertEqual(
            ["dirty", "persist", "ensure", "changes"], calls)
        self.assertEqual(1, len(persisted))

    def test_defer_rejects_incomplete_build_and_dirty_source(self):
        state = self.state("build")
        result = defer_moonlight_quality(
            state,
            kind="compile",
            reason="compiler service is unavailable after retries",
            rejection="agent diagnostic",
            recheck="",
            ports=MoonlightDeferPorts(
                build_boundary=lambda: (
                    False, "tasks not complete"),
                dirty_paths=lambda: (),
                head=lambda: "head",
                now=lambda: "now",
                persist_issue=lambda _updated: None,
                ensure_step_entry=lambda: "",
                source_changes=lambda: ((), ""),
            ),
        )
        self.assertEqual(2, result.exit_code)
        self.assertIn("不能 defer", result.stderr[0])

        result = defer_moonlight_quality(
            state,
            kind="compile",
            reason="compiler service is unavailable after retries",
            rejection="agent diagnostic",
            recheck="",
            ports=MoonlightDeferPorts(
                build_boundary=lambda: (True, ""),
                dirty_paths=lambda: ("src/main.py",),
                head=lambda: "head",
                now=lambda: "now",
                persist_issue=lambda _updated: None,
                ensure_step_entry=lambda: "",
                source_changes=lambda: ((), ""),
            ),
        )
        self.assertEqual(2, result.exit_code)
        self.assertIn("push 会漏文件", result.stderr[0])

    def test_defer_persists_issue_before_source_check_failure(self):
        state = self.state("verify_ut")
        calls = []
        result = defer_moonlight_quality(
            state,
            kind="ut",
            reason="source verification cannot read repository history",
            rejection="agent diagnostic",
            recheck="verify_recompile",
            ports=MoonlightDeferPorts(
                build_boundary=lambda: (True, ""),
                dirty_paths=lambda: (),
                head=lambda: "head",
                now=lambda: "now",
                persist_issue=lambda _updated: calls.append(
                    "persist"),
                ensure_step_entry=lambda: (
                    calls.append("ensure") or ""),
                source_changes=lambda: (
                    calls.append("changes")
                    or ((), "git history unavailable")),
            ),
        )
        self.assertEqual(2, result.exit_code)
        self.assertEqual(
            ["persist", "ensure", "changes"], calls)

    def test_repair_blocker_preserves_current_step(self):
        state = self.state()
        state["moonlight"]["hard_blocked"] = {
            "issue": "ML-001",
        }
        state["moonlight"]["issues"] = [{
            "id": "ML-001",
            "kind": "blocker",
        }]
        result = repair_moonlight(
            state, repair_target="build", head="head", now="later")
        updated = self.updated(result)
        self.assertEqual(state["current"], updated["current"])
        self.assertEqual(2, updated["moonlight"]["cycle"])

    def test_finalize_disables_moonlight_and_targets_archive(self):
        state = self.state("moonlight_review")
        result = finalize_moonlight(
            state,
            ack="",
            ack_verified=(True, ""),
            head="head",
            now="now",
        )
        updated = self.updated(result)
        self.assertFalse(updated["moonlight"]["enabled"])
        self.assertEqual("domain_archive", updated["current"])
        self.assertEqual("print_current", result.effects[-1].kind)

    def test_activation_defers_archive_and_off_requires_authorization(self):
        state = self.state("archive_confirm")
        state["moonlight"]["enabled"] = False
        state["config_review"] = {"stale": True}
        result = activate_moonlight(
            state,
            ack="please run overnight",
            request="please run overnight",
            activated_at="now",
            history_at="later",
            head="head",
            active_change_exists=False,
        )
        updated = self.updated(result)
        self.assertTrue(updated["moonlight"]["enabled"])
        self.assertEqual("push", updated["current"])
        self.assertNotIn("config_review", updated)

        result = disable_moonlight(
            updated, ack="", ack_verified=(False, ""), now="off")
        self.assertEqual(2, result.exit_code)
        result = disable_moonlight(
            updated,
            ack="关闭月光宝盒",
            ack_verified=(True, ""),
            now="off",
        )
        self.assertFalse(self.updated(result)["moonlight"]["enabled"])


if __name__ == "__main__":
    unittest.main()
