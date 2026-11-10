#!/usr/bin/env python3
"""Story keeps its legacy structure while Mae-Flow uses a local companion."""

import json
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.transitions import workflow_chain  # noqa: E402


def read(relative):
    with open(os.path.join(ROOT, relative), encoding="utf-8") as stream:
        return stream.read()


class StoryContractTests(unittest.TestCase):
    def test_full_path_uses_grill_local_spec_story_and_build_directly(self):
        flow = json.loads(read("flow/flow.json"))
        chain = workflow_chain(flow, "full")
        ordered = ["grill", "open", "story", "build"]
        self.assertEqual(ordered, [step for step in chain if step in ordered])
        for removed in (
                "grill_ask", "design", "test_blueprint",
                "story_ask", "build_plan"):
            self.assertNotIn(removed, chain)
        self.assertEqual("story", flow["steps"]["open"]["next"])
        self.assertEqual("build", flow["steps"]["story"]["next"])
        story_evidence = json.dumps(
            flow["steps"]["story"]["evidence"], ensure_ascii=False)
        self.assertIn(".mae-flow-work/{单号}/story.md", story_evidence)
        self.assertIn(".mae-flow-work/{单号}/implementation.md", story_evidence)

    def test_story_template_preserves_legacy_structure_without_process_additions(self):
        template = read("skills/mae-flow/assets/STORY-TEMPLATE.md")
        legacy_sections = (
            "## 1 概述",
            "### 1.1 客户场景（必选）",
            "### 1.2 外部依赖（可选）",
            "## 2 方案设计",
            "### 2.1 场景分析",
            "#### 2.1.1 场景设计（必选）",
            "#### 2.1.2 性能规格（必选）",
            "#### 2.1.3 验收标准（必选）",
            "### 2.2 详细设计",
            "#### 2.2.1 逻辑模型设计（按需必选）",
            "#### 2.2.2 接口设计（按需必选）",
            "#### 2.2.3 数据模型设计（按需必选）",
            "#### 2.2.4 运行视图设计（按需必选）",
            "#### 2.2.5 UI交互设计（按需必选）",
            "#### 2.2.6 模拟仿真设计（按需必选）",
            "## 3 测试设计",
            "### 3.1 UT测试设计（必选）",
            "### 3.2 接口测试设计（后续预留）",
            "## 4 安全红线自检表",
            "## 5 Story转测自检表",
        )
        positions = [template.index(section) for section in legacy_sections]
        self.assertEqual(sorted(positions), positions)
        self.assertIn("仅填写容量、时延、吞吐、并发或资源上限", template)
        self.assertIn("REST、CORBA", template)
        self.assertIn("| 1 | 串讲&反串 |", template)
        for process_addition in (
                "Grill 决策与未决项", "关键函数/方法设计",
                "CP 划分与轻量实施说明", "领域文档影响"):
            self.assertNotIn(process_addition, template)
        self.assertEqual([
            "## 1 概述", "## 2 方案设计", "## 3 测试设计",
            "## 4 安全红线自检表", "## 5 Story转测自检表",
        ], [line for line in template.splitlines() if line.startswith("## ")])

    def test_implementation_template_owns_process_additions(self):
        """附录只承载 Story 装不下的两件事;其余各归各位,但都不许流回 Story。

        2026-08-08 契约变更:原六节里有五节是 decisions.md 与 Story 的重复,
        「关键函数详述」还诱导模型把实现提前写一遍(实测 26KB 文档里 265 行是
        Python 代码,且与真代码已漂移——检视者对着副本打勾)。现在只剩
        拆分决策与接口契约,并明令不出现函数体。
        """
        template = read("skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md")
        sections = ("文件结构与任务边界", "接口契约两栏", "定稿自查")
        positions = [template.index(section) for section in sections]
        self.assertEqual(sorted(positions), positions)
        self.assertIn("docs/specs/<domain>.md", template)
        # 被移走的内容必须写明去处,不能悄悄消失
        for moved in ("Grill 决策看 `decisions.md`", "对外接口写 Story 2.2.2",
                      "风险与回滚看 `decisions.md`"):
            self.assertIn(moved, template)
        # 流程内容仍然不许流回公司 Story 模板(本测试的原始意图)
        story = read("skills/mae-flow/assets/STORY-TEMPLATE.md")
        for leaked in ("任务边界", "接口契约两栏", "删除测试"):
            self.assertNotIn(leaked, story)

    def test_implementation_template_forbids_pre_written_code(self):
        """提前写的代码是会漂移的副本,而检视者会对着副本打勾——这是真事故的成因。"""
        template = read("skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md")
        self.assertIn("全文不出现函数体", template)
        self.assertIn("代码是控制流最权威的表达", template)
        for consumer in ("agents/story-generator-agent.md",
                         "agents/craft-reviewer-agent.md"):
            text = read(consumer)
            self.assertTrue(
                "代码块" in text or "函数体" in text,
                "%s 没有承接「附录不写代码」这条约束" % consumer)

    def test_story_generator_requires_exact_local_inputs(self):
        generator = read("agents/story-generator-agent.md")
        for required in (
                "spec.md", "grill.md", "docs/specs/index.md",
                "STORY-TEMPLATE.md", "IMPLEMENTATION-TEMPLATE.md", "代码路径"):
            self.assertIn(required, generator)
        self.assertNotIn("openspec/changes", generator)
        self.assertNotIn("STORY_RESULT:", generator)
        self.assertIn(".mae-flow-work/<单号>/story.md", generator)
        self.assertIn(".mae-flow-work/<单号>/implementation.md", generator)

    def test_story_reviewer_runs_once_without_digest_reentry(self):
        flow = json.loads(read("flow/flow.json"))
        evidence = flow["steps"]["story"]["evidence"]
        self.assertIn("REVIEWER", [
            item.get("agent") for item in evidence
            if item.get("type") == "agent_ran"])
        reviewer = read("agents/craft-reviewer-agent.md")
        self.assertIn("Story 设计检视", reviewer)
        self.assertIn("只执行一次", reviewer)
        for forbidden in (
                "TASK_CARD_SHA256", "审查目标 SHA256",
                "CRAFT_REVIEW_RESULT:", "文件变化后重新检视"):
            self.assertNotIn(forbidden, reviewer)

    def test_reachable_agent_guidance_has_real_task_card_commands(self):
        grill = read("flow/steps/grill.md")
        story = read("flow/steps/story.md")
        build = read("flow/steps/build.md")
        self.assertIn("role-task grill-critic --stage prep", grill)
        self.assertIn("role-task grill-critic --stage final", grill)
        self.assertIn("role-task story-generate", story)
        self.assertIn("role-task story-review", story)
        self.assertIn("主 Agent", build)
        # 2026-08-25 编排瘦身:编译由主 Agent 自由完成,任务卡命令已退役
        self.assertNotIn("agent-task", build)
        self.assertNotIn("role-task cp-implement", build)

    def test_quality_agents_can_invoke_every_skill_required_by_their_task_card(self):
        for name in (
                "codecheck-fix-agent.md",
                "ut-generator-agent.md"):
            frontmatter = read("agents/" + name).split("---", 2)[1]
            tools = next(
                line for line in frontmatter.splitlines()
                if line.startswith("tools:"))
            self.assertIn("Skill", tools, name)

    def test_only_five_approved_agents_remain(self):
        # 2026-08-25 编排瘦身:compile-agent 退役,编译由主 Agent 自由完成。
        expected = {
            "grill-critic-agent.md",
            "story-generator-agent.md",
            "craft-reviewer-agent.md",
            "codecheck-fix-agent.md",
            "ut-generator-agent.md",
        }
        actual = {
            name for name in os.listdir(os.path.join(ROOT, "agents"))
            if name.endswith("-agent.md")
        }
        self.assertEqual(expected, actual)

    def test_main_agent_implements_once_with_free_compilation(self):
        build = read("flow/steps/build.md")
        self.assertIn("一次完成需求涉及的全部生产代码", build)
        self.assertIn("设计承载的代码不外包", build)
        self.assertIn("编译方式", build)
        self.assertNotIn("role-task task-analysis", build)
        self.assertNotIn("role-task craft-plan", build)


if __name__ == "__main__":
    unittest.main()


class StoryDiagramLanguageTests(unittest.TestCase):
    """实战发现:4+1 视图必须 PlantUML——公司评审工具只渲染它,别的等于没画。

    三处口径一致:模板(单一真相源)、生成 agent、Story 设计检视。
    """

    def test_plantuml_is_pinned_in_template_generator_and_reviewer(self):
        for path in ("skills/mae-flow/assets/STORY-TEMPLATE.md",
                     "agents/story-generator-agent.md",
                     "agents/craft-reviewer-agent.md"):
            with self.subTest(path=path):
                self.assertIn("plantuml", read(path))
        template = read("skills/mae-flow/assets/STORY-TEMPLATE.md")
        self.assertIn("```plantuml 代码块", template)
        self.assertIn("评审工具只渲染", template)
