#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression tests for workflow definition and pure transition policy."""

import json
import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.definition import (  # noqa: E402
    definition_errors,
    load_definition,
    workflow_graph_errors,
)
from mae_flow_core.workflow import definition as workflow_definition  # noqa: E402
from mae_flow_core.workflow import transitions as workflow_transitions  # noqa: E402
from mae_flow_core.workflow.transitions import (  # noqa: E402
    next_step,
    resolved_next,
    transition_targets,
    workflow_chain,
    workflow_cost,
)
from mae_flow_core import cli_runtime  # noqa: E402


class WorkflowTransitionTests(unittest.TestCase):
    def test_transition_targets_preserves_declared_order(self):
        self.assertEqual(
            ("build", "skip"),
            transition_targets({"next": {"yes": "build", "no": "skip"}}),
        )

    def test_transition_targets_includes_declared_dynamic_edges_once(self):
        self.assertEqual(
            ("normal", "morning"),
            transition_targets(
                {
                    "next": "normal",
                    "dynamic_next": ["morning", "normal"],
                }
            ),
        )

    def test_next_step_resolves_plain_next_and_state_choices(self):
        self.assertEqual(
            "build",
            next_step({"next": "build"}, {"choices": {}}),
        )
        self.assertEqual(
            "hotfix-open",
            next_step(
                {
                    "next_by": "workflow",
                    "next": {
                        "full": "design",
                        "hotfix": "hotfix-open",
                    },
                },
                {"choices": {"workflow": "hotfix"}},
            ),
        )
        self.assertEqual(
            "revise",
            next_step(
                {
                    "choice_key": "review",
                    "next": {
                        "continue": "verify",
                        "revise": "revise",
                    },
                },
                {"choices": {"review": "continue"}},
                "revise",
            ),
        )

    def test_next_step_returns_none_for_missing_or_malformed_choice(self):
        step = {
            "choice_key": "review",
            "next": {"continue": "verify"},
        }
        self.assertIsNone(next_step(step, {"choices": {}}))
        self.assertIsNone(next_step(step, {"choices": []}))

    def test_resolved_next_uses_empty_step_for_unknown_history_entry(self):
        self.assertIsNone(
            resolved_next(
                {"steps": {"build": {"next": "verify"}}},
                {"choices": {}},
                "missing",
            )
        )

    def test_workflow_chain_selects_workflow_and_complete_optional_branch(self):
        flow = {
            "start": "start",
            "steps": {
                "start": {
                    "next_by": "workflow",
                    "next": {
                        "full": "ask",
                        "hotfix": "fix",
                    },
                },
                "ask": {"next": {"yes": "design", "no": "fix"}},
                "design": {"next": "end"},
                "fix": {"next": "end"},
                "end": {"terminal": True},
            },
        }
        self.assertEqual(
            ["start", "ask", "design", "end"],
            workflow_chain(flow, "full"),
        )
        self.assertEqual(
            ["start", "fix", "end"],
            workflow_chain(flow, "hotfix"),
        )

    def test_workflow_chain_follows_non_workflow_branch_by_default(self):
        """按 workflow 以外的键分叉时走 next_default,链条不许在此断掉。

        真实仓的 build 是按 code_reviewer 分叉的,原来拿 workflow 去查那张
        表查不到就 None,四条道的链条全断在「编码实现」,验证与交付整段从未
        被打印过——而 `steps` 命令存在的理由正是"选档前看得见全貌"。
        """
        flow = {
            "start": "code",
            "steps": {
                "code": {
                    "next_by": "reviewer",
                    "next": {"off": "commit", "on": "agent_review"},
                    "next_default": "on",
                },
                "agent_review": {"next": "commit"},
                "commit": {"next": "done"},
                "done": {"terminal": True},
            },
        }
        self.assertEqual(
            ["code", "agent_review", "commit", "done"],
            workflow_chain(flow, "full"),
        )

    def test_real_flow_chains_reach_delivery_end(self):
        flow = load_definition(os.path.join(ROOT, "flow", "flow.json"))
        for workflow in ("full", "hotfix", "tweak", "review"):
            chain = workflow_chain(flow, workflow)
            with self.subTest(workflow=workflow):
                self.assertEqual("end", chain[-1])
                for tail in ("build", "domain_archive",
                             "delivery_review", "push"):
                    self.assertIn(tail, chain)

    def test_workflow_cost_reports_own_steps_not_a_false_skip_list(self):
        """代价按"本道特有"报,不许报成"比 full 少了什么"。

        后者会把 tweak 的「小改—规范检查/单元测试」算成"省掉了验证
        1/4~4/4",等于告诉用户选轻的免检——四条道的验证一步都不能免,
        轻的只是形态更小。这个误导比不显示还糟。
        """
        flow = load_definition(os.path.join(ROOT, "flow", "flow.json"))
        full = workflow_cost(flow, "full")
        tweak = workflow_cost(flow, "tweak")
        self.assertGreater(full["steps"], tweak["steps"])
        self.assertGreaterEqual(full["acks"], tweak["acks"])
        # 轻档自己的范围确认必须出现在"本道特有"里
        self.assertIn("局部修改", "".join(tweak["unique"]))
        # 四条道共有的步骤(编码、推送)不算任何一条道"特有"
        for workflow in ("full", "hotfix", "tweak", "review"):
            titles = "".join(workflow_cost(flow, workflow)["unique"])
            with self.subTest(workflow=workflow):
                self.assertNotIn("推送分支", titles)
                self.assertNotIn("自由实现与定稿", titles)

    def test_workflow_chain_stops_at_first_cycle(self):
        flow = {
            "start": "one",
            "steps": {
                "one": {"next": "two"},
                "two": {"next": "one"},
            },
        }
        self.assertEqual(
            ["one", "two"],
            workflow_chain(flow, "full"),
        )


class WorkflowDefinitionTests(unittest.TestCase):
    def test_repository_full_path_skips_heavy_legacy_precode_gates(self):
        definition = load_definition(
            os.path.join(ROOT, "flow", "flow.json"))
        chain = workflow_chain(definition, "full")
        for step in (
                "grill_ask", "design", "test_blueprint",
                "story_ask", "build_plan"):
            self.assertNotIn(step, chain)

    def test_load_definition_preserves_unknown_fields(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "flow.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump(
                    {
                        "start": "end",
                        "steps": {"end": {"terminal": True}},
                        "future_field": {"keep": 7},
                    },
                    stream,
                )
            self.assertEqual(
                {"keep": 7},
                load_definition(path)["future_field"],
            )

    def test_load_definition_preserves_json_decode_error(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "flow.json")
            with open(path, "w", encoding="utf-8") as stream:
                stream.write("{broken")
            with self.assertRaises(json.JSONDecodeError):
                load_definition(path)

    def test_definition_errors_reports_invalid_root_structures(self):
        self.assertEqual(
            ["flow root must be an object"],
            definition_errors([]),
        )
        self.assertEqual(
            ["steps must be an object"],
            definition_errors({"start": "begin", "steps": []}),
        )

    def test_definition_errors_reports_invalid_step_structures(self):
        cases = [
            (
                {
                    "start": "broken",
                    "steps": {"broken": []},
                },
                ["step broken must be an object"],
            ),
            (
                {
                    "start": "begin",
                    "steps": {
                        "begin": {"next": []},
                        "end": {"terminal": True},
                    },
                },
                ["step begin has unsupported next type: list"],
            ),
            (
                {
                    "start": "begin",
                    "steps": {
                        "begin": {"next": {"yes": None}},
                        "end": {"terminal": True},
                    },
                },
                ["step begin has invalid next target: None"],
            ),
            (
                {
                    "start": 7,
                    "steps": {7: {"terminal": True}},
                },
                ["step id must be a non-empty string: 7"],
            ),
        ]
        for definition, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(expected, definition_errors(definition))

    def test_definition_errors_reports_unknown_start_and_edge(self):
        self.assertEqual(
            [
                "start references unknown step: missing",
                "step begin references unknown step: gone",
            ],
            definition_errors(
                {
                    "start": "missing",
                    "steps": {
                        "begin": {"next": {"yes": "gone"}},
                        "end": {"terminal": True},
                    },
                }
            ),
        )

    def test_definition_errors_reports_missing_step_document(self):
        with tempfile.TemporaryDirectory() as steps_dir:
            self.assertEqual(
                ["step begin is missing document: begin.md"],
                definition_errors(
                    {
                        "start": "begin",
                        "steps": {
                            "begin": {"next": "end"},
                            "end": {"terminal": True},
                        },
                    },
                    steps_dir,
                ),
            )

    def test_workflow_graph_reports_unreachable_step(self):
        self.assertEqual(
            ["unreachable step: orphan"],
            workflow_graph_errors(
                {
                    "start": "begin",
                    "steps": {
                        "begin": {"next": "end"},
                        "end": {"terminal": True},
                        "orphan": {"terminal": True},
                    },
                }
            ),
        )

    def test_workflow_graph_accepts_named_compatibility_entry(self):
        self.assertEqual(
            [],
            workflow_graph_errors(
                {
                    "start": "begin",
                    "compatibility_entries": ["legacy"],
                    "steps": {
                        "begin": {"next": "end"},
                        "end": {"terminal": True},
                        "legacy": {"next": "end"},
                    },
                }
            ),
        )

    def test_workflow_graph_reports_unknown_compatibility_entry(self):
        self.assertEqual(
            ["compatibility entry references unknown step: missing"],
            workflow_graph_errors(
                {
                    "start": "end",
                    "compatibility_entries": ["missing"],
                    "steps": {"end": {"terminal": True}},
                }
            ),
        )

    def test_repository_definition_is_valid(self):
        definition = load_definition(
            os.path.join(ROOT, "flow", "flow.json")
        )
        self.assertEqual(
            [],
            definition_errors(
                definition,
                os.path.join(ROOT, "flow", "steps"),
            ),
        )
        self.assertEqual([], workflow_graph_errors(definition))


class WorkflowAdapterDelegationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mf = cli_runtime

    def test_load_flow_delegates_to_workflow_definition(self):
        sentinel = object()
        seen = []
        original = workflow_definition.load_definition
        try:
            workflow_definition.load_definition = (
                lambda path: seen.append(path) or sentinel
            )
            actual = self.mf.load_flow()
        finally:
            workflow_definition.load_definition = original
        self.assertIs(sentinel, actual)
        self.assertEqual([self.mf.FLOW_PATH], seen)

    def test_next_from_step_delegates_to_transition_policy(self):
        sentinel = object()
        seen = []
        original = workflow_transitions.next_step

        def fake(*args):
            seen.append(args)
            return sentinel

        step = {"next": "build"}
        state = {"choices": {}}
        try:
            workflow_transitions.next_step = fake
            actual = self.mf._next_from_step(step, state, "override")
        finally:
            workflow_transitions.next_step = original
        self.assertIs(sentinel, actual)
        self.assertEqual([(step, state, "override")], seen)

    def test_resolved_next_delegates_to_transition_policy(self):
        sentinel = object()
        seen = []
        original = workflow_transitions.resolved_next

        def fake(*args):
            seen.append(args)
            return sentinel

        flow = {"steps": {}}
        state = {"choices": {}}
        try:
            workflow_transitions.resolved_next = fake
            actual = self.mf._resolved_next(flow, state, "history-step")
        finally:
            workflow_transitions.resolved_next = original
        self.assertIs(sentinel, actual)
        self.assertEqual([(flow, state, "history-step")], seen)

    def test_workflow_chain_delegates_to_transition_policy(self):
        sentinel = object()
        seen = []
        original = workflow_transitions.workflow_chain

        def fake(*args):
            seen.append(args)
            return sentinel

        flow = {"start": "end", "steps": {"end": {"terminal": True}}}
        try:
            workflow_transitions.workflow_chain = fake
            actual = self.mf._workflow_chain(flow, "review")
        finally:
            workflow_transitions.workflow_chain = original
        self.assertIs(sentinel, actual)
        self.assertEqual([(flow, "review")], seen)


if __name__ == "__main__":
    unittest.main()
