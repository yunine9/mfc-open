#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""授权判定的全场景矩阵——把内网撞过的、和还没撞过的,一次铺满。

判定规则只有一句话:**同意看回答,相关性看问题,用户打字最大。**

- 同意与否只看用户的回答是不是拒绝(拒绝词有限,肯定说法不设白名单);
- 这条同意"是给哪个动作的"看 Agent 问的问题(宿主记录,事后改不了):
  allow 看问题里有没有本次拦截编号,exit 看问题在不在问退出;
- 用户自己打字的纯文本,他的话就是授权本身,不要求编号、不要求格式。

本文件是矩阵:场景 × 判据。每行都对应一类真实处境,内网撞过的标了出处。
"""

import json
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.consent import (  # noqa: E402
    is_refusal, mentions_token, option_labels, question_texts,
    relates_to_action, verdict)


def asked(question, answer, header="确认"):
    """Agent 代问的结构化收据。"""
    return json.dumps({
        "questions": [{"question": question, "header": header}],
        "answers": {header: answer},
    }, ensure_ascii=False)


class RefusalMatrixTests(unittest.TestCase):
    """同意与否:只列拒绝,不白名单肯定。"""

    ACCEPT = (
        "允许创建基线提交",          # 内网 allow 那次的原话
        "确认退出流程并保留代码",      # selftest 里用户亲口退出的原话
        "配置无误，开始交付",         # 曾被措辞白名单拒掉的说法
        "没问题，继续", "都正确", "按此执行", "同意", "ok", "允许",
        "确认以上全部配置", "放行吧", "批准",
        # 用户问"说放行是不是必能放行"时当场抓出的四个误拒:
        # 过程词(考虑/核对/看看)在明确放行面前不作数,"不错"是褒义
        "不错，放行", "考虑过了，放行", "核对过了，没问题，放行",
        "看过了，放行吧", "先放行再说",
    )
    REFUSE = (
        "不允许", "不退出", "不确认", "不要提交",   # "不X"通用式
        "拒绝", "取消", "先别", "暂不处理",
        "需要修改", "需要调整", "重新来",
        "看看再说", "回头再说", "稍后处理", "我再考虑", "待定",
        "是否可以?", "为什么要这样", "什么意思",     # 反问不是同意
        "放行吗?", "能否放行",                       # 问句是在问,不是在答
        "不放行", "先别放行",
        "",                                        # 空话不是同意
    )

    def test_acceptances_pass(self):
        for said in self.ACCEPT:
            self.assertFalse(is_refusal(said), "该算同意: %r" % said)

    def test_refusals_refuse(self):
        for said in self.REFUSE:
            self.assertTrue(is_refusal(said), "该算拒绝: %r" % (said or "(空)"))


class AllowMatrixTests(unittest.TestCase):
    """allow:编号绑定问题,不绑答案;用户打字免编号。"""

    TOKEN = "ce1404d2ec"    # 内网那次的真实拦截编号

    def test_agent_asked_with_token_passes(self):
        """正路:Agent 把编号写进问题,用户点「允许」。"""
        shown = asked("是否允许把项目已有文件作为基线提交?"
                      "（放行编号 %s）" % self.TOKEN, "允许创建基线提交")
        passed, why = verdict(shown, "允许创建基线提交", self.TOKEN)
        self.assertTrue(passed, why)

    def test_agent_asked_without_token_refuses(self):
        """Agent 忘了带编号 → 拒,并教它把编号写进问题正文。"""
        shown = asked("是否允许基线提交?", "允许")
        passed, why = verdict(shown, "允许", self.TOKEN)
        self.assertFalse(passed)
        self.assertIn("原样写进问题正文", why)     # 拒绝必须给出路

    def test_token_in_answer_does_not_count(self):
        """编号出现在答案里不算——用户随口提一句不是授权。"""
        shown = asked("选择交付方式", "允许 %s" % self.TOKEN, header="交付方式")
        self.assertFalse(verdict(shown, "允许 %s" % self.TOKEN, self.TOKEN)[0])

    def test_user_typed_plain_message_needs_no_token(self):
        """用户自己打字:没人代问,他的话就是授权,要求编号是荒谬的。"""
        said = "可以，你去提交吧"
        self.assertTrue(verdict(said, said, self.TOKEN)[0])

    def test_user_typed_refusal_still_refuses(self):
        said = "不行，先别提交"
        self.assertFalse(verdict(said, said, self.TOKEN)[0])

    def test_token_survives_agent_reformatting(self):
        """Agent 转述时加空格/连字符/大小写,编号仍认得出。"""
        for shown in ("放行编号 ce1404d2ec", "编号 ce14-04d2ec",
                      "编号：CE1404D2EC", "id=ce_1404_d2ec"):
            self.assertTrue(mentions_token(shown, self.TOKEN), shown)
        self.assertFalse(mentions_token("编号 ffffffffff", self.TOKEN))


class ExitMatrixTests(unittest.TestCase):
    """exit:相关性看问题;纯文本看用户的话本身。"""

    def test_answering_another_question_cannot_exit(self):
        """内网实测:回答交付方式时写「选择 1（退出 Mae-Flow，直接开发）」,
        答案字面有"退出",可问的根本不是退出——被当成退出授权,整轮报废。"""
        rows = [{"text": asked("选择交付方式",
                               "选择 1（退出 Mae-Flow，直接开发）",
                               header="交付方式")}]
        self.assertFalse(relates_to_action(rows, ("退出", "exit")))

    def test_agent_asking_about_exit_counts(self):
        rows = [{"text": asked("是否退出 Mae-Flow 转为普通开发?", "确认退出",
                               header="退出")}]
        self.assertTrue(relates_to_action(rows, ("退出", "exit")))

    def test_user_typed_exit_counts(self):
        """selftest 场景:用户亲口打字「确认退出流程并保留代码」。"""
        rows = [{"text": "确认退出流程并保留代码"}]
        self.assertTrue(relates_to_action(rows, ("退出", "exit")))

    def test_user_typed_unrelated_does_not_count(self):
        rows = [{"text": "继续下一步吧"}]
        self.assertFalse(relates_to_action(rows, ("退出", "exit")))

    def test_mixed_rows_one_relevant_is_enough(self):
        rows = [{"text": asked("选择交付方式", "1", header="交付方式")},
                {"text": "那还是退出吧"}]
        self.assertTrue(relates_to_action(rows, ("退出", "exit")))


class ChoiceLabelMatrixTests(unittest.TestCase):
    """点选确认:标签在候选项里就是,不在就不是——不做措辞体操。"""

    def test_a_real_option_counts(self):
        shown = json.dumps({"askuser": {"questions": [{
            "options": ["确认无误，进入编码", "需要调整"]}]}}, ensure_ascii=False)
        labels = option_labels(shown)
        self.assertIn("确认无误进入编码", labels)

    def test_a_made_up_label_is_not_an_option(self):
        shown = json.dumps({"askuser": {"questions": [{
            "options": ["确认", "取消"]}]}}, ensure_ascii=False)
        self.assertNotIn("我自己编的选项", option_labels(shown))

    def test_question_texts_ignores_answers(self):
        """相关性判据的根基:问题取问题,绝不把答案混进来。"""
        text = asked("选择交付方式", "选择 1（退出 Mae-Flow，直接开发）",
                     header="交付方式")
        drawn = question_texts(text)
        self.assertIn("交付方式", drawn)
        self.assertNotIn("退出 Mae-Flow", drawn.replace("交付方式", ""))


class ConfigMatrixTests(unittest.TestCase):
    """配置确认:单项回答只在有绑定收据时才判,判据是收据结构。"""

    def test_single_item_answer_never_backs_the_whole_card(self):
        from mae_flow_core.cli_commands.ack_confirmation import (
            whole_card_values)
        reviewed = {"基线分支": "main", "单号": "REQ1"}
        mixed = json.dumps({"answers": {
            "基线分支": "确认 master",          # 单项 → 不算
            "最终确认": "确认以上全部配置",       # 独立确认题 → 算
        }}, ensure_ascii=False)
        self.assertEqual(["确认以上全部配置"],
                         whole_card_values(mixed, reviewed))

    def test_any_positive_wording_works_for_the_whole_card(self):
        """措辞不再是门槛:整份确认题下答什么肯定说法都行。"""
        from mae_flow_core.cli_commands.ack_confirmation import (
            whole_card_values)
        got = whole_card_values(json.dumps({"answers": {
            "最终确认": "配置无误，开始交付"}}, ensure_ascii=False),
            {"单号": "REQ1"})
        self.assertEqual(["配置无误，开始交付"], got)
        self.assertFalse(is_refusal("配置无误，开始交付"))


if __name__ == "__main__":
    unittest.main()
