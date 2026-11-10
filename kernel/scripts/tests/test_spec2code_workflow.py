#!/usr/bin/env python3
"""Story-centered pre-code workflow regression."""

import json
import os
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class Spec2CodeWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(
                os.path.join(ROOT, "flow", "flow.json"),
                encoding="utf-8") as stream:
            cls.flow = json.load(stream)

    def test_full_chain_uses_story_as_the_only_precode_design_artifact(self):
        steps = self.flow["steps"]
        self.assertEqual("grill", steps["branch_create"]["next"]["full"])
        self.assertEqual("story", steps["open"]["next"])
        self.assertEqual("build", steps["story"]["next"])
        self.assertEqual("story", steps["design"]["next"])
        self.assertEqual("story", steps["story_ask"]["next"])

    def test_all_workflows_share_the_wide_build_step(self):
        """2026-08-25 编排瘦身:四条工作流共用宽 build 步,直通交付收口。"""
        steps = self.flow["steps"]
        self.assertEqual("build", steps["hf_open"]["next"])
        self.assertEqual("build", steps["tw_open"]["next"])
        self.assertEqual("build", steps["rf_triage"]["next"])
        self.assertEqual("domain_archive", steps["build"]["next"])
        self.assertEqual([], steps["build"]["evidence"])

    def test_story_loop_binds_local_spec_grill_and_story(self):
        steps = self.flow["steps"]
        evidence = steps["open"]["evidence"]
        self.assertIn("local_spec_valid", tuple(
            item["type"] for item in evidence))
        self.assertEqual(
            [".mae-flow-work/{单号}/grill.md"],
            next(item for item in evidence if item["type"] == "glob")["any"],
        )
        self.assertEqual(
            [".mae-flow-work/{单号}/story.md"],
            steps["story"]["evidence"][0]["any"],
        )

    def test_other_workflow_entries_remain_unchanged(self):
        steps = self.flow["steps"]
        self.assertEqual("branch_create", steps["workflow_select"]["next"])
        self.assertEqual("hf_open", steps["branch_create"]["next"]["hotfix"])
        self.assertEqual("tw_open", steps["branch_create"]["next"]["tweak"])
        self.assertEqual("rf_triage", steps["branch_create"]["next"]["review"])
        self.assertEqual("build", steps["hf_open"]["next"])
        self.assertEqual("build", steps["tw_open"]["next"])

    def test_branch_prompt_explains_moonlight_noninteractive_resolution(self):
        with open(
                os.path.join(ROOT, "flow", "steps", "branch_create.md"),
                encoding="utf-8") as stream:
            prompt = stream.read()
        self.assertIn("禁止执行 AskUserQuestion", prompt)
        self.assertIn(".mae-flow.json.last", prompt)
        self.assertIn("自动登记硬阻塞", prompt)


if __name__ == "__main__":
    unittest.main()
