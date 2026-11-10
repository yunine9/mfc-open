#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""退出授权的绑定纪律。"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

class ExitConsentBindingTests(unittest.TestCase):
    """答别的问题时顺口提到"退出",不能拿来退掉整个流程。

    实测(无人值守):流程在问交付方式(完整开发/已定位问题修复/局部修改/处理评审
    意见),用户答「选择 1（退出 Mae-Flow，直接开发）」——他要的是选项 1,括号里是
    自己的注解。可 exit 的 ack 只做精确匹配,这句话原样对得上,于是一次正常答题
    把流程退掉了,现场停在 workflow_select,后面十几轮全废。

    第一版修法看"答案里有没有提到退出"——**没修好**:那句话字面就有"退出"。
    判据必须看**问题**:宿主记录的问题问的是交付方式,不是要不要退出。
    """

    def test_consent_is_bound_to_what_was_asked_not_what_was_answered(self):
        from mae_flow_core.workflow.consent import (
            mentions_any, question_texts)
        answering_something_else = (
            '{"questions":[{"question":"选择交付方式","header":"交付方式"}],'
            '"answers":{"交付方式":"选择 1（退出 Mae-Flow，直接开发）"}}')
        self.assertFalse(
            mentions_any(question_texts(answering_something_else),
                         ("退出", "exit")),
            "问的是交付方式,答案里出现退出字样不算退出授权")
        really_asking = (
            '{"questions":[{"question":"是否退出 Mae-Flow 转为普通开发?",'
            '"header":"退出"}],"answers":{"退出":"确认退出"}}')
        self.assertTrue(
            mentions_any(question_texts(really_asking), ("退出", "exit")))

    def test_the_answer_side_alone_would_have_missed_it(self):
        """留个反例在案:第一版就是这么漏的。"""
        from mae_flow_core.workflow.consent import mentions_any
        said = "选择 1（退出 Mae-Flow，直接开发）"
        self.assertTrue(mentions_any(said, ("退出", "exit")),
                        "答案侧看不出这是在答什么——正是当初漏掉的原因")

    def test_a_refusal_never_authorizes(self):
        from mae_flow_core.workflow.consent import is_refusal
        for said in ("不退出", "先别退", "取消", ""):
            self.assertTrue(is_refusal(said), said or "(空)")


if __name__ == "__main__":
    unittest.main()
