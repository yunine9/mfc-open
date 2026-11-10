#!/usr/bin/env python3
"""Thin Story-centered role task card contracts."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.application.quality.role_task_documents import (  # noqa: E402
    RoleTaskContext,
    build_role_task_document,
)


def build(role, *, stage="", context=None):
    return build_role_task_document(
        role=role,
        project_root="/repo",
        ticket="REQ-1",
        stage=stage,
        context=context or RoleTaskContext(
            context_paths=(
                "/repo/.mae-flow-work/REQ-1/spec.md",
                "/repo/.mae-flow-work/REQ-1/story.md",
            ),
            diff="diff --git a/src/service.py b/src/service.py\n",
            write_output="/repo/.mae-flow-work/REQ-1/story.md",
            companion_output="/repo/.mae-flow-work/REQ-1/implementation.md",
        ),
    ).body()


class RoleTaskDocumentTests(unittest.TestCase):
    def test_only_active_roles_render(self):
        for role in (
                "code-review", "story-generate", "story-review",
                "grill-critic"):
            with self.subTest(role=role):
                stage = "standards" if role == "code-review" else "prep"
                body = build(role, stage=stage)
                self.assertIn("任意自然语言格式", body)
                self.assertNotIn("_RESULT:", body)
                self.assertNotIn("TASK_CARD_SHA256", body)
                self.assertIn("不回放聊天记录", body)
        for retired in (
                "implement", "cp-implement", "test-design",
                "task-analysis", "craft-plan"):
            with self.subTest(role=retired):
                with self.assertRaisesRegex(ValueError, "未知角色"):
                    build(retired)

    def test_code_review_needs_an_explicit_axis(self):
        """CODE 预检拆成两个互不参考的视角,卡上必须写明是哪一个。

        缺省视角的卡等于又回到"一个 Agent 同时看需求和规范"——注意力会全部
        流向业务正确性,工程问题就漏了。所以这里宁可报错也不给默认值。
        """
        with self.assertRaisesRegex(ValueError, "必须指定视角"):
            build("code-review")

    def test_both_axes_are_read_only_and_carry_the_diff(self):
        for axis in ("spec", "standards"):
            with self.subTest(axis=axis):
                body = build("code-review", stage=axis)
                self.assertIn("diff --git", body)
                self.assertIn("用户人工检视前", body)
                self.assertIn("只读", body)
                self.assertIn("最多五条", body)
                self.assertIn("CLEAR", body)
                self.assertIn("工具已经在管的不报", body)

    def test_the_two_axes_do_not_share_a_brief(self):
        spec = build("code-review", stage="spec")
        standards = build("code-review", stage="standards")
        self.assertIn("需求符合性", spec)
        self.assertIn("引用原始用户答复或有效决定", spec)
        self.assertNotIn("命名是否继承邻居", spec)
        self.assertIn("工程质量", standards)
        self.assertIn("命名是否继承邻居", standards)
        self.assertIn("code-taste-v1.md", standards)
        self.assertIn("故意不提供 Spec 与 Story", standards)
        self.assertNotIn("擅自扩大范围", standards)

    def test_story_roles_use_local_outputs_once(self):
        generated = build("story-generate")
        reviewed = build("story-review")
        self.assertIn("仅允许写入", generated)
        self.assertIn("implementation.md", generated)
        self.assertIn("不得拆开发批次", generated)
        self.assertIn("只执行一次", reviewed)
        self.assertIn("禁止修改任何文件", reviewed)

    def test_grill_critic_stage_is_explicit_and_read_only(self):
        body = build("grill-critic", stage="final")
        self.assertIn("质询检查阶段: final", body)
        self.assertIn("只读", body)
        self.assertIn("禁止修改任何文件", body)


if __name__ == "__main__":
    unittest.main()
