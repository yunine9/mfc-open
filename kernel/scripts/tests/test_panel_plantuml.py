#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PlantUML 子集渲染器契约。

底线是"画错的图比不画更坏":判型只用最不含糊的信号,渲染不了就交回源码,
渲染器自身异常绝不冒泡成流程卡点。
"""

import os
import re
import sys
import unittest
import xml.dom.minidom

TESTS = os.path.abspath(os.path.dirname(__file__))
SCRIPTS = os.path.abspath(os.path.join(TESTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.panel import plantuml  # noqa: E402

SEQUENCE = """@startuml
title 短信发送时序
participant "调用方" as C
participant notify_service as N
participant sms_handler as H
C -> N: send("sms", notification)
N -> H: send(notification)
alt 发送成功
  H --> N: SendResult.ok()
else 发送失败
  H --> N: SendResult.fail()
  N -> N: sleep(1)
end
N --> C: SendResult
note right of N: 重试全部失败才返回 fail
@enduml"""

ACTIVITY = """@startuml
start
:读取 channel 参数;
if (channel == "sms") then (是)
  :查询租户白名单;
else (否)
  :无权限限制;
endif
:返回结果;
stop
@enduml"""

COMPONENT = """@startuml
component notify_service
component sms_handler
component "config/sms_enabled.json" as CFG
notify_service --> sms_handler
sms_handler --> CFG
@enduml"""

CLASSES = """@startuml
class ChannelHandler
class SmsHandler
SmsHandler --|> ChannelHandler
ChannelHandler --> SendResult : 返回
@enduml"""


def extents(svg):
    """量出图元的坐标极值,用来验证内容没有溢出画布。"""
    xs, ys = [], []
    for match in re.finditer(
            r'<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" '
            r'height="([\d.-]+)"', svg):
        x, y, width, height = map(float, match.groups())
        xs += [x, x + width]
        ys += [y, y + height]
    for match in re.finditer(
            r'<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" '
            r'y2="([\d.-]+)"', svg):
        x1, y1, x2, y2 = map(float, match.groups())
        xs += [x1, x2]
        ys += [y1, y2]
    return min(xs), max(xs), min(ys), max(ys)


class PlantUmlSubsetTests(unittest.TestCase):
    def test_alt_else_end_never_decide_the_diagram_type(self):
        """三类图都有 alt/else/end;拿它们判型会把时序图误判成活动图。"""
        self.assertEqual("sequence",
                         plantuml.detect(SEQUENCE.split("\n")))
        self.assertEqual("activity", plantuml.detect(ACTIVITY.split("\n")))
        self.assertEqual("graph", plantuml.detect(COMPONENT.split("\n")))
        self.assertEqual("graph", plantuml.detect(CLASSES.split("\n")))

    def test_sequence_renders_participants_frames_and_notes(self):
        svg, kind = plantuml.render(SEQUENCE)
        self.assertEqual("sequence", kind)
        self.assertIn("notify_service", svg)
        self.assertIn(">alt<", svg)
        self.assertIn(">else<", svg)
        self.assertIn("重试全部失败才返回 fail", svg)
        # 自调用画成回环路径而不是一条零长直线
        self.assertIn("h34 v22", svg)

    def test_activity_renders_branches_and_terminals(self):
        svg, kind = plantuml.render(ACTIVITY)
        self.assertEqual("activity", kind)
        self.assertIn("查询租户白名单", svg)
        self.assertIn("无权限限制", svg)
        self.assertGreaterEqual(svg.count("<circle"), 3)   # 起点 + 终点双环

    def test_alias_declaration_does_not_create_a_second_node(self):
        """as 别名必须归一;否则同一个组件会画出两个框(实测踩过)。"""
        svg, _kind = plantuml.render(COMPONENT)
        self.assertEqual(1, svg.count("config/sms_enabled.json"))
        self.assertEqual(3, svg.count("<rect"))

    def test_inheritance_uses_the_hollow_triangle_marker(self):
        svg, _kind = plantuml.render(CLASSES)
        self.assertIn("url(#ai)", svg)      # 空心三角 = 继承
        self.assertIn("返回", svg)

    def test_every_diagram_is_well_formed_xml_within_its_canvas(self):
        for name, source in (("seq", SEQUENCE), ("act", ACTIVITY),
                             ("comp", COMPONENT), ("cls", CLASSES)):
            svg, _kind = plantuml.render(source)
            xml.dom.minidom.parseString(
                svg.replace('class="puml"', ""))          # 合法 XML
            box = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
            width, height = int(box.group(1)), int(box.group(2))
            low_x, high_x, low_y, high_y = extents(svg)
            self.assertGreaterEqual(low_x, 0, name)
            self.assertGreaterEqual(low_y, 0, name)
            self.assertLessEqual(high_x, width, "%s: 内容溢出画布右侧" % name)
            self.assertLessEqual(high_y, height, "%s: 内容溢出画布下方" % name)

    def test_unknown_diagram_kind_degrades_instead_of_guessing(self):
        svg, kind = plantuml.render("@startuml\nsalt\n{ [按钮] }\n@enduml")
        self.assertIsNone(svg)
        self.assertEqual("", kind)

    def test_painter_failure_returns_none_instead_of_raising(self):
        """渲染器出错只能退回源码——它绝不能变成新的流程卡点。"""
        from mae_flow_core.panel import plantuml_sequence
        broken = "@startuml\nparticipant A\nA -> B: x\n@enduml"
        original = plantuml_sequence.text_width

        def explode(*_args, **_kwargs):
            raise ValueError("boom")

        plantuml_sequence.text_width = explode
        try:
            svg, kind = plantuml.render(broken)
        finally:
            plantuml_sequence.text_width = original
        self.assertIsNone(svg)
        self.assertEqual("sequence", kind)

    def test_empty_source_is_not_an_error(self):
        self.assertEqual((None, ""), plantuml.render(""))


if __name__ == "__main__":
    unittest.main()
