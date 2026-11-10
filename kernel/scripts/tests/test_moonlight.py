#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""月光宝盒的阻塞登记纪律。"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


class RepeatedBlockerTests(unittest.TestCase):
    """同一步、同一原因反复登记 = 原地空转,必须当场点破。

    实测:月光在 branch_create 上一字不差地登记了 7 次。每次都把上一条
    标成 superseded,于是从记录上谁也看不出在重复;模型收不到"别再试了"
    的信号,就一直重试,把一步走成了八步。
    """

    def _blocked(self, state, reason):
        from mae_flow_core.application.delivery.moonlight import record_blocker
        return record_blocker(
            state, can_block=True, reason=reason, dirty_paths=(),
            head="abc1234", now="2026-08-10 01:00:00")

    def _state(self):
        return {"current": "branch_create",
                "moonlight": {"enabled": True, "issues": []}}

    def test_second_identical_blocker_is_called_out(self):
        state = self._state()
        reason = ("当前非基线分支已含工作,启动请求未要求沿用,"
                  "上一轮状态不能证明同单号同分支,月光模式拒绝猜测代码归属;"
                  "已尝试读取状态与提交前缀确认,仍无法继续。")
        first = self._blocked(state, reason)
        self.assertNotIn("同一原因已登记", "".join(first.stdout))
        # 直接把第一条摆进状态,不绕 effect 的搬运——这里要验的是重复识别
        state["moonlight"]["issues"] = [{
            "id": "ML-001", "step": "branch_create", "kind": "blocker",
            "reason": reason}]
        second = self._blocked(state, reason)
        told = "".join(second.stdout)
        self.assertIn("同一原因已登记 2 次", told)
        self.assertIn("停止重试本步", told)

    def test_a_different_reason_is_not_treated_as_repetition(self):
        state = self._state()
        long_a = ("缺少 A 条件,已尝试从状态与提交记录确认归属,"
                  "仍无法继续,需人工补齐后重试。")
        long_b = ("缺少 B 条件,已尝试重新解析基线与分支关系,"
                  "仍无法继续,需人工介入。")
        state["moonlight"]["issues"] = [{
            "id": "ML-001", "step": "branch_create", "kind": "blocker",
            "reason": long_a}]
        second = self._blocked(state, long_b)
        self.assertNotIn("同一原因已登记", "".join(second.stdout))


class SameStepChurnTests(unittest.TestCase):
    """同一步连登多条、每条措辞还不同——多半是自己在改动之后又改动。

    实测:模型在 quality_commit 上连登 5 条阻塞,口口声声"系统清单与实际
    状态不同步"。而 git 记录显示 notify_service.py 被提交了 4 次,每次
    提交完它又改了一遍——"文件未提交"每次都属实,是它自己在制造脏改动。
    """

    def test_third_blocker_at_one_step_points_the_finger_back(self):
        from mae_flow_core.delivery.moonlight import block_notice
        self.assertNotIn("别把自己的改动", block_notice(1, at_step=2))
        told = block_notice(1, at_step=3)
        self.assertIn("本步已登记 3 条阻塞", told)
        self.assertIn("先跑 status 看清现场", told)

    def test_identical_reason_still_takes_priority(self):
        from mae_flow_core.delivery.moonlight import block_notice
        told = block_notice(2, at_step=5)
        self.assertIn("同一原因已登记 2 次", told)
