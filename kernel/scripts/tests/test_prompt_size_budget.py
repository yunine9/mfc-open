#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提示词尺寸预算红线:悄悄变胖过不了 CI。

依据是两组实测:35 个 harness 版本的纵向研究里,提示词涨 8%、轮次涨 18%、
成本翻倍而解决率没动;context rot 研究里,模型精度随输入变长非均匀衰减,
埋在中部的规则有实质概率不被执行。所以"再补一句约束"不是免费的——
每一句都在稀释已有的所有句子。

预算值 = 当前实际最大值上浮少许。要突破预算,先删再加,或说明为什么这一步
确实需要更多——把取舍摆到 diff 里,而不是在无数次"+2 行"里溜进来。
"""

import os
import re
import sys
import unittest

TESTS = os.path.abspath(os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(TESTS, "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.capability_packs import render_pack  # noqa: E402

# 单份步骤文档(注入能力包展开后)的字符预算。
# 当前最大: grill.md 6.6K;verify_ponytail 展开后 ~4.4K。
STEP_BUDGET = 7500
# 会话入口命令文件。压缩后 8.8K;曾胖到 15K。
COMMAND_BUDGET = 9500
# 单个子 Agent 定义。当前最大: craft-reviewer-agent 5.3K。
AGENT_BUDGET = 5500
# 会话开场"通读并全程遵守"的宪法。曾胖到 14.3K,三大节复读命令文件与运行时输出;
# 压缩后 ~8K。复读的危害不只是 token:两处口径必然漂移("四问卡"事故同款)。
SKILL_BUDGET = 9000


def rendered_step(path):
    with open(path, encoding="utf-8") as stream:
        text = stream.read()
    for name in re.findall(r"\{\{CAPABILITY_PACK:([a-z0-9-]+)\}\}", text):
        text = text.replace(
            "{{CAPABILITY_PACK:%s}}" % name, render_pack(name))
    return text


class PromptSizeBudgetTests(unittest.TestCase):
    def test_every_step_doc_fits_its_budget_after_pack_expansion(self):
        steps_dir = os.path.join(ROOT, "flow", "steps")
        oversized = {}
        for name in sorted(os.listdir(steps_dir)):
            if not name.endswith(".md"):
                continue
            size = len(rendered_step(os.path.join(steps_dir, name)))
            if size > STEP_BUDGET:
                oversized[name] = size
        self.assertEqual(
            {}, oversized,
            "步骤文档(含展开的能力包)超出 %d 字符预算。先删再加,"
            "或把只有部分分支需要的内容下推到 guidance 指针后面。" % STEP_BUDGET)

    def test_command_entry_fits_its_budget(self):
        with open(os.path.join(ROOT, "commands", "mae-flow.md"),
                  encoding="utf-8") as stream:
            size = len(stream.read())
        self.assertLessEqual(
            size, COMMAND_BUDGET,
            "会话入口文件超预算(%d > %d):它占据整个会话的头部,"
            "分支正文能压给 CLI 输出的就压给 CLI。" % (size, COMMAND_BUDGET))

    def test_skill_constitution_fits_its_budget(self):
        with open(os.path.join(ROOT, "skills", "mae-flow", "SKILL.md"),
                  encoding="utf-8") as stream:
            size = len(stream.read())
        self.assertLessEqual(
            size, SKILL_BUDGET,
            "SKILL.md 超预算(%d > %d):它是会话开场整篇加载的宪法,"
            "月光/退出/独立任务的细节属于命令文件与运行时输出,别在这里复读。"
            % (size, SKILL_BUDGET))

    def test_every_agent_definition_fits_its_budget(self):
        agents_dir = os.path.join(ROOT, "agents")
        oversized = {}
        for name in sorted(os.listdir(agents_dir)):
            if not name.endswith(".md"):
                continue
            with open(os.path.join(agents_dir, name),
                      encoding="utf-8") as stream:
                size = len(stream.read())
            if size > AGENT_BUDGET:
                oversized[name] = size
        self.assertEqual(
            {}, oversized,
            "子 Agent 定义超出 %d 字符预算——它随每次派发进入子上下文。"
            % AGENT_BUDGET)


if __name__ == "__main__":
    unittest.main()
