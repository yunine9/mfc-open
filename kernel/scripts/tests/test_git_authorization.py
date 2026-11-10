#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Git 放行的授权契约。"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

class ConsentIsOneThingTests(unittest.TestCase):
    """授权验真只回答两件事,判据只有一处。

    实战两个 bug 都出在这里:
    - 用户点选批准基线提交,却被判"原话未覆盖本动作的全部路径"——回答是个短
      选项,装不下 12 个路径,走点选必死;Agent 转而去传 allow --paths,而这个
      参数不存在,又撞参数错误(拦了不给出路)。
    - 用户回答"交付方式"时顺口写「选择 1（退出 Mae-Flow，直接开发）」,
      被拿去当退出流程的授权。

    改法不是把七个判据合成一个,而是删到只剩两条:回答里有本次动作的随机编号
    (Agent 编不出来,只能从拦截消息里抄——抄了就说明它真把动作摆给用户看过)、
    且回答不是拒绝。字符串包含判断,不是语义判断。
    """

    def test_the_real_case_passes(self):
        from mae_flow_core.workflow.consent import verdict
        shown = ('{"questions":[{"question":"是否允许将项目已有文件作为基线'
                 '提交?（放行编号 ce1404d2ec）"}],'
                 '"answers":{"最终确认":"允许创建基线提交"}}')
        passed, why = verdict(shown, "允许创建基线提交", "ce1404d2ec")
        self.assertTrue(passed, why)

    def test_consent_given_elsewhere_cannot_be_borrowed(self):
        from mae_flow_core.workflow.consent import verdict
        shown = ('{"questions":[{"question":"选择交付方式"}],'
                 '"answers":{"交付方式":"选择 1（退出 Mae-Flow，直接开发）"}}')
        passed, why = verdict(
            shown, "选择 1（退出 Mae-Flow，直接开发）", "abc1234567")
        self.assertFalse(passed)
        self.assertIn("没有本次编号", why)
        self.assertIn("原样写进问题正文", why)   # 拒绝必须给出路

    def test_wording_never_decides(self):
        from mae_flow_core.workflow.consent import is_refusal
        for said in ("允许创建基线提交", "配置无误，开始交付", "没问题，继续",
                     "都正确", "ok", "按此执行", "同意", "允许"):
            self.assertFalse(is_refusal(said), said)
        for said in ("不允许", "拒绝", "取消", "需要修改", "看看再说",
                     "回头再说", "是否可以?", ""):
            self.assertTrue(is_refusal(said), said or "(空)")

    def test_token_survives_agent_reformatting(self):
        """Agent 转述时可能加空格或连字符,编号仍要认得出。"""
        from mae_flow_core.workflow.consent import mentions_token
        for shown in ("放行编号 ce1404d2ec", "编号 ce14-04d2ec",
                      "编号：CE1404D2EC", "id=ce_1404_d2ec"):
            self.assertTrue(mentions_token(shown, "ce1404d2ec"), shown)
        self.assertFalse(mentions_token("放行编号 ffffffffff", "ce1404d2ec"))


if __name__ == "__main__":
    unittest.main()
