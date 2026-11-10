#!/usr/bin/env python3
"""交付红线(2026-08-25 编排瘦身后仍必须成立的不变量)。"""

import json
import os
import sys
import unittest

TESTS = os.path.abspath(os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(TESTS, "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


def read(relative):
    with open(os.path.join(ROOT, relative), encoding="utf-8") as stream:
        return stream.read()


class QualityFlowRedlineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.flow = json.loads(read("flow/flow.json"))

    def test_delivery_cannot_bypass_exact_manifest_commit(self):
        delivery = self.flow["steps"]["delivery_review"]
        self.assertNotIn("skip_in_moonlight", delivery)
        self.assertIn("delivery_manifest_committed", {
            row["type"] for row in delivery["evidence"]})

    def test_delivery_can_include_existing_commits_without_archive_permits(self):
        guidance = read("flow/steps/delivery_review.md")
        self.assertIn("manifest set --unchanged", guidance)
        self.assertIn("已提交文件", guidance)
        self.assertIn("不创建空提交", guidance)

    def test_unlock_guidance_never_precommits(self):
        lifecycle = read(
            "scripts/mae_flow_core/cli_commands/lifecycle.py")
        self.assertNotIn("修复后按 [单号][类型] 规范 commit", lifecycle)

    def test_push_and_pipeline_evidence_stay_hard(self):
        self.assertIn("pushed", {
            row["type"] for row in self.flow["steps"]["push"]["evidence"]})
        self.assertIn("pipeline_obligations_passed", {
            row["type"]
            for row in self.flow["steps"]["external_verify"]["evidence"]})


if __name__ == "__main__":
    unittest.main()
