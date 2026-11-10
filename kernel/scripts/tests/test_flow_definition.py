#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""流程图自身的不变量。"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

class BranchFallbackTests(unittest.TestCase):
    """按配置项分岔的步骤,必须有一条明写的默认分支。

    实测:月光宝盒跑到 build,`code_reviewer` 从未被写进配置,于是
    "步骤 build 缺少可解析的下一步"——done 拒绝推进,current 又不给
    恢复办法,模型在那儿活锁了 38 轮,最后自己编了个"CHANGE_NAME 缺失"
    的诊断。步骤文档明写着"缺少该字段时按 enabled 兼容",可解析代码里
    没有这个兜底:文档许的诺,代码没兑现。
    """

    def _flow(self):
        import json as _json
        import io as _io
        with _io.open(os.path.join(ROOT, "flow", "flow.json"),
                      encoding="utf-8") as stream:
            return _json.load(stream)

    def test_every_next_by_step_declares_a_default(self):
        naked = [sid for sid, step in self._flow()["steps"].items()
                 if step.get("next_by") and not step.get("next_default")]
        self.assertEqual(
            [], naked,
            "这些步骤按配置项分岔却没有默认分支,配置项一缺就活锁: %s" % naked)

    def test_missing_choice_falls_back_instead_of_dead_ending(self):
        from mae_flow_core.workflow.transitions import next_step
        flow = self._flow()
        for sid, step in flow["steps"].items():
            if not step.get("next_by"):
                continue
            landing = next_step(step, {"choices": {}})
            self.assertIn(
                landing, flow["steps"],
                "%s 在选择项缺失时落到了无效去向: %r" % (sid, landing))

    def test_default_branch_keeps_full_flow_and_build_advances_to_archive(self):
        flow = self._flow()
        self.assertEqual("full", flow["steps"]["branch_create"]["next_default"])
        self.assertEqual("domain_archive", flow["steps"]["build"]["next"])


class ReviewChoiceContractTests(unittest.TestCase):
    """人工检视的按钮必须说清楚：继续会提交，修改会进入可写步骤。"""

    def _flow(self):
        import json as _json
        import io as _io
        with _io.open(os.path.join(ROOT, "flow", "flow.json"),
                      encoding="utf-8") as stream:
            return _json.load(stream)

    def test_continuous_feedback_returns_to_existing_build_step(self):
        flow = self._flow()
        target = flow["steps"]["feedback_triage"]["next"]
        self.assertEqual("build", target)
        self.assertIn(target, flow["steps"])

    def test_final_review_keeps_explicit_confirmation_contract(self):
        step = self._flow()["steps"]["delivery_review"]
        self.assertTrue(step["confirmation_answers"])
        self.assertEqual("worktree", step["approval_subject"]["kind"])
        self.assertEqual("push", step["next"])

    def test_all_artifact_and_worktree_approvals_name_the_close_effect(self):
        """端到端检视都要让宿主识别“这句话会关闭本轮意见”。"""
        flow = self._flow()
        reviewed = [step for step in flow["steps"].values()
                    if step.get("approval_subject")]
        self.assertTrue(reviewed)
        for step in reviewed:
            if step.get("confirmation_answers"):
                self.assertIn("无需", step["confirmation_answers"][0])
            else:
                closing = step["choice_answers"]["continue"][0]
                self.assertTrue("无需" in closing or "无需调整" in closing)
