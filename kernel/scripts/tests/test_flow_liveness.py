#!/usr/bin/env python3
"""Redline liveness contracts for the stable subtractive workflow.

2026-08-25 编排瘦身后的核心契约:编码段只剩宽 build 步(自由实现与定稿),
出口验收在 prepush+权威流水线+MR 检视;流程图里不允许再长出任何编排残留。
"""

import json
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.transitions import (  # noqa: E402
    transition_targets,
    workflow_chain,
)


with open(os.path.join(ROOT, "flow", "flow.json"), encoding="utf-8") as stream:
    FLOW = json.load(stream)


# 已退役的编排步骤:任何一个重新出现在流程图里都是倒退。
RETIRED_CHOREOGRAPHY = (
    "code_reviewer_ask", "build_agent_review", "build_rework", "build_review",
    "build_commit", "quality_recompile", "quality_review", "quality_rework",
    "quality_commit", "verify_ponytail", "verify_post_ponytail_compile",
    "verify_recompile", "verify_codecheck", "verify_codecheck_compile",
    "verify_ut", "verify_spec", "verify_comet", "tw_codecheck", "tw_ut",
    "tw_verify", "rf_codecheck", "rf_ut", "rf_verify",
)

# 已退役的编排属性:步骤上挂任何一个都等于把质量小循环偷偷长回来。
RETIRED_STEP_KEYS = (
    "tests_only", "source_change_next", "source_change_recheck",
    "source_change_defer_review", "late_source_change_next",
    "quality_review_origin", "quality_review_resume", "quality_review_rework",
    "test_change_review_origin", "test_change_review_resume",
    "test_change_review_rework",
)


def reachable():
    seen, pending = set(), [FLOW["start"]]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        pending.extend(
            target for target in transition_targets(FLOW["steps"][current])
            if target not in seen)
    return seen


class FlowLivenessTests(unittest.TestCase):
    def test_every_reachable_nonterminal_step_has_a_real_successor(self):
        reached = reachable()
        self.assertIn("end", reached)
        for step_id in reached:
            step = FLOW["steps"][step_id]
            if not step.get("terminal"):
                self.assertTrue(
                    transition_targets(step),
                    "%s 没有下一步，会卡死" % step_id)

    def test_heavy_compatibility_steps_are_not_reachable(self):
        reached = reachable()
        for retired in FLOW.get("compatibility_entries", ()):
            self.assertNotIn(retired, reached)

    def test_retired_choreography_steps_do_not_exist(self):
        for step_id in RETIRED_CHOREOGRAPHY:
            self.assertNotIn(step_id, FLOW["steps"], step_id)

    def test_no_step_carries_retired_choreography_keys(self):
        for step_id, step in FLOW["steps"].items():
            for key in RETIRED_STEP_KEYS:
                self.assertNotIn(
                    key, step, "%s 挂了已退役编排属性 %s" % (step_id, key))

    def test_story_review_is_single_pass_and_cannot_schedule_itself(self):
        story = FLOW["steps"]["story"]
        self.assertEqual("build", story["next"])
        self.assertEqual(1, sum(
            item.get("agent") == "REVIEWER"
            for item in story.get("evidence", ())))
        for step_id in reachable():
            step = FLOW["steps"][step_id]
            if step_id != "open":
                self.assertNotIn("story", transition_targets(step))

    def test_build_is_wide_and_free(self):
        """宽 build 步:零证据编排,直通交付收口(改码自由已是全链默认,
        allow_source_edit 字段随步骤级源码闸退役)。"""
        build = FLOW["steps"]["build"]
        self.assertEqual([], list(build.get("evidence", [])))
        self.assertEqual("domain_archive", build["next"])

    def test_exit_adjudication_stays_hard(self):
        """出口验收不许软化:push 要 pushed,external_verify 要流水线核销。"""
        steps = FLOW["steps"]
        self.assertIn("pushed", {
            item["type"] for item in steps["push"]["evidence"]})
        self.assertIn("pipeline_obligations_passed", {
            item["type"] for item in steps["external_verify"]["evidence"]})
        self.assertIn("delivery_manifest_committed", {
            item["type"] for item in steps["delivery_review"]["evidence"]})
        self.assertIn("domain_archive_complete", {
            item["type"] for item in steps["domain_archive"]["evidence"]})

    def test_every_workflow_chain_passes_build_then_delivery(self):
        """四条交付方式都必须经过 build → 归档 → 清单 → push,顺序不可变。"""
        for workflow in ("full", "hotfix", "tweak", "review"):
            with self.subTest(workflow=workflow):
                chain = workflow_chain(FLOW, workflow)
                for required in ("build", "domain_archive",
                                 "delivery_review", "push"):
                    self.assertIn(required, chain, workflow)
                self.assertLess(chain.index("build"),
                                chain.index("domain_archive"))
                self.assertLess(chain.index("domain_archive"),
                                chain.index("delivery_review"))
                self.assertLess(chain.index("delivery_review"),
                                chain.index("push"))
                self.assertEqual(1, chain.count("domain_archive"))

    def test_no_step_uses_agent_return_text_as_a_transition_choice(self):
        for step_id, step in FLOW["steps"].items():
            serialized = json.dumps(step, ensure_ascii=False)
            for forbidden in (
                    "_RESULT:", "TASK_CARD_SHA256", "reviewer_digest",
                    "capability.retry"):
                self.assertNotIn(forbidden, serialized, step_id)

    def test_legacy_archive_steps_are_one_way_recovery_bridges(self):
        for step_id in ("archive_confirm", "archive"):
            self.assertNotIn(step_id, reachable())
            self.assertEqual("domain_archive", FLOW["steps"][step_id]["next"])

    def test_retired_steps_have_a_migration_exit(self):
        """在途状态停在死步骤上必须有出路:load_state 的退役桥逐一映射到活步骤。"""
        from mae_flow_core.cli_commands.state_config import (
            _RETIRED_CHOREOGRAPHY as BRIDGE,
        )
        for step_id in RETIRED_CHOREOGRAPHY:
            self.assertIn(step_id, BRIDGE, step_id)
            self.assertIn(BRIDGE[step_id], FLOW["steps"], step_id)


class FlowWiringContractTests(unittest.TestCase):
    def test_build_is_registered_for_moonlight_defer(self):
        """宽 build 步必须能被月光宝盒登记遗留,否则夜里撞上编译死结就没有出口。"""
        from mae_flow_core.moonlight import QUALITY_STEPS, REPAIR_ENTRY

        self.assertIn("build", QUALITY_STEPS)
        for workflow in ("full", "hotfix", "tweak", "review"):
            self.assertEqual("build", REPAIR_ENTRY.get(workflow), workflow)

    def test_every_step_valued_key_is_a_declared_transition(self):
        """凡是取值为真实步骤名的键，都必须被 transition_targets 看见。"""
        steps = FLOW["steps"]
        violations = []
        for step_id, step in sorted(steps.items()):
            declared = set(transition_targets(step))
            for key, value in step.items():
                if not isinstance(value, str):
                    continue
                if value in steps and value not in declared:
                    violations.append(
                        "%s.%s → %s 未登记为转移边" % (step_id, key, value))
        self.assertEqual([], violations)


if __name__ == "__main__":
    unittest.main()
