#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规格条目得能溯源到需求——弱模型最擅长的是"顺着想象把活干得很漂亮"。

无人值守实战:一次"新增短信渠道与失败重试"的交付,最终交了 25 个文件 +2076 行,
里面有 alert_service.py、metrics.py、feature_flag.py、validate-config.sh。
追下去,"告警"在需求原文出现 0 次,在 grill 出现 10 次、decisions 11 次、
spec 10 次、story 13 次——范围是在需求澄清那一步凭空长出来的,之后每一层都
忠实地把它带下去,连测试和领域归档都补齐了。

流程一直在检查"验收项都实现了吗",从没检查反方向:**这条验收项是从哪来的**。
"""

import io
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


class ScopeDriftTests(unittest.TestCase):
    def test_catches_a_subsystem_invented_out_of_thin_air(self):
        from mae_flow_core.workflow.scope_drift import invented_topics
        requirement = (
            "# REQ 通知服务新增短信渠道与失败重试\n"
            "通知服务目前支持 email/push/webhook。新增短信渠道,"
            "并对发送失败做重试。按租户控制短信是否开通。\n")
        spec = (
            "1. 新增短信渠道,复用既有四段结构\n"
            "2. 失败重试:最多 3 次\n"
            "3. 监控与告警:失败率告警(>5% 触发告警,邮件+钉钉)\n"
            "4. 灰度发布:灰度开关控制,支持灰度回滚\n"
            "5. 回滚策略:一键回滚到上一版本,回滚后告警\n")
        found = dict(invented_topics(requirement, spec, floor=2))
        self.assertIn("告警", found, "凭空发明的告警子系统必须被报出来")
        self.assertIn("灰度", found)
        self.assertIn("回滚", found)
        # 需求里说过的不报
        for said in ("短信", "重试", "租户"):
            self.assertNotIn(said, found, "需求里说过的不该报: %s" % said)

    def test_longest_run_does_not_swallow_the_real_term(self):
        """"失败率告警"取最长会把"告警"吞掉——实战里差点因此漏报。"""
        from mae_flow_core.workflow.scope_drift import invented_topics
        found = dict(invented_topics(
            "新增短信渠道", "失败率告警\n失败率告警\n监控与告警\n", floor=3))
        self.assertIn("告警", found)

    def test_stays_quiet_when_spec_tracks_the_requirement(self):
        from mae_flow_core.workflow.scope_drift import (
            drift_notice, invented_topics)
        requirement = "新增短信渠道,失败重试三次,按租户开通。\n"
        spec = ("1. 新增短信渠道\n2. 失败重试三次\n3. 按租户开通短信\n") * 3
        self.assertEqual([], invented_topics(requirement, spec))
        self.assertEqual("", drift_notice([]))

    def test_words_the_user_actually_said_are_not_drift(self):
        """用户在澄清阶段亲口说的词是合法新增(他拍板加的),不能报成漂移。

        不这么过滤,每轮都会报出一串行文词,报多了就没人看——今晚修的一堆
        "每单必现的提示"正是这个毛病。真实宿主的 usermsg 台账里有用户原话;
        无人值守宿主拿不到,那时就只比需求原文。
        """
        from mae_flow_core.workflow.scope_drift import invented_topics
        requirement = "新增短信渠道,失败重试。\n"
        # 主题词要跨两种说法出现才算主题(子串判据),所以两种写法各来几遍
        spec = (("网关失败才重试\n" * 3) + ("网关抖动要重试\n" * 3)
                + ("告警通知\n" * 3) + ("失败率告警\n" * 3))
        # 只比需求:两个都报
        bare = [word for word, _ in invented_topics(requirement, spec)]
        self.assertIn("网关", bare)
        self.assertIn("告警", bare)
        # 用户说过"只对网关失败重试" → 网关不再算漂移,告警照报
        filtered = [word for word, _ in invented_topics(
            requirement, spec, approved="这个重试只对网关失败生效")]
        self.assertNotIn("网关", filtered)
        self.assertIn("告警", filtered)

    def test_fires_when_the_spec_lands_not_when_the_step_opens(self):
        """进 open 那会儿 spec.md 还不存在,读不到只能静默——实测就是这么
        没打出来的。改挂在写盘那一刻,记成非阻断提示。"""
        import json as _json
        import shutil as _shutil
        import tempfile
        from mae_flow_core.panel.sync import note_scope_drift
        room = tempfile.mkdtemp(prefix="drift-")
        self.addCleanup(_shutil.rmtree, room, True)
        want = os.path.join(room, "req.md")
        spec = os.path.join(room, "spec.md")
        state = os.path.join(room, ".mae-flow.json")
        with io.open(want, "w", encoding="utf-8") as stream:
            stream.write("新增短信渠道,失败重试三次。\n")
        with io.open(spec, "w", encoding="utf-8") as stream:
            stream.write("监控与告警\n失败率告警\n告警通知\n告警阈值\n"
                         "灰度发布\n灰度开关\n灰度回滚\n灰度比例\n灰度名单\n")
        with io.open(state, "w", encoding="utf-8") as stream:
            _json.dump({"current": "open",
                        "config": {"需求文档": want, "单号": "REQ-1"}}, stream)
        self.assertTrue(note_scope_drift(state, spec), "有漂移就该记一条")
        # 写的不是规格就不出声
        other = os.path.join(room, "story.md")
        with io.open(other, "w", encoding="utf-8") as stream:
            stream.write("告警告警告警灰度灰度灰度\n")
        self.assertFalse(note_scope_drift(state, other))


if __name__ == "__main__":
    unittest.main()
