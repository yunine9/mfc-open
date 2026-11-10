import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DISPATCH = os.path.join(ROOT, "hooks", "dispatch.py")
MAE = os.path.join(ROOT, "scripts", "mae-flow.py")
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.cli_commands import ack


class ChoiceReceiptTests(unittest.TestCase):
    def test_codeagent_posttool_answer_advances_without_second_confirmation(self):
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(
                ["git", "init", "-q", project], check=True,
                capture_output=True)
            state_path = os.path.join(project, ".mae-flow.json")
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "current": "workflow_select",
                    "config": {}, "choices": {}, "history": [],
                    "started": time.strftime("%Y-%m-%d %H:%M:%S"),
                }, stream)
            payload = json.dumps({
                "cwd": project,
                "tool_name": "AskUserQuestion",
                "tool_input": {"questions": [{
                    "question": "选择开发方式？",
                    "options": [
                        {"label": "完整开发"},
                        {"label": "已定位问题修复"},
                        {"label": "局部修改"},
                        {"label": "处理评审意见"},
                    ],
                }]},
                "tool_response": {
                    "answers": {"选择开发方式？": "完整开发"},
                },
            }, ensure_ascii=False) + "\n"
            captured = subprocess.run(
                [sys.executable, DISPATCH, "posttooluse"],
                cwd=project, input=payload, text=True,
                capture_output=True, timeout=15)
            advanced = subprocess.run(
                [sys.executable, MAE, "done", "--choice", "full"],
                cwd=project, text=True, capture_output=True, timeout=30)
            with open(state_path, encoding="utf-8") as stream:
                state = json.load(stream)

        self.assertEqual(0, captured.returncode, captured.stderr)
        self.assertEqual(0, advanced.returncode, advanced.stderr)
        self.assertEqual("branch_create", state["current"])

    def test_askuser_token_without_selected_answer_cannot_authorize_choice(self):
        step = {
            "choice_answers": {
                "full": ["完整开发"],
                "hotfix": ["快速修复"],
            },
        }
        state = {"current": "workflow_select"}

        with mock.patch.object(ack, "_current_ack_messages", return_value=[]), \
                mock.patch.object(ack, "_fresh_askuser", return_value=True), \
                mock.patch.object(ack, "_out_of_scope_ack_reason", return_value=""), \
                mock.patch.object(ack, "_ack_failure", return_value=1):
            accepted, reason = ack._choice_verified(
                step, state, "full")

        self.assertFalse(accepted)
        self.assertIn("真实选项回答", reason)

    def test_structured_claude_code_answer_authorizes_matching_choice(self):
        step = {
            "choice_answers": {
                "full": ["完整开发"],
                "hotfix": ["快速修复"],
            },
        }
        state = {"current": "workflow_select"}
        rows = [{
            "text": '{"answers":{"交付方式":"完整开发"}}',
            "step": "workflow_select",
            "at": "9999-12-31 23:59:59",
        }]

        with mock.patch.object(ack, "_current_ack_messages", return_value=rows), \
                mock.patch.object(ack, "_ack_failure", return_value=0):
            accepted, reason = ack._choice_verified(
                step, state, "full")

        self.assertTrue(accepted, reason)


class ReorderedParaphrasedOptionsTests(unittest.TestCase):
    """2026-08-09 实战事故:模型把推荐项排到第一位并改写标签,
    按位置映射把「需要预检」判成 disabled,机器反过来指控模型
    "替用户改选",用户被迫回答两遍。位置从来不是证据,文字才是。
    载荷取自事故现场原文(fieldtest REQ2026080901 第二轮)。
    """

    STEP = {
        "choices": ["disabled", "enabled"],
        "choice_answers": {
            "disabled": ["不需要 Agent 预检，我直接检视"],
            "enabled": ["需要，人工检视前先由 Agent 预检"],
        },
    }
    ITEM = {
        "askuser": {"questions": [{
            "question": "人工检视前，是否需要一次只读 CODE Agent 预检？",
            # 推荐项排第一 = enabled 在前,与 flow.json 的 choices 顺序相反
            "options": ["需要，先预检 (推荐)", "不需要，我直接检视"],
        }]},
    }

    def test_paraphrased_reordered_answer_maps_to_the_right_choice(self):
        from mae_flow_core.workflow import completion
        self.assertEqual("enabled", completion.receipt_choice(
            self.STEP, self.ITEM, "需要，先预检(推荐)"))
        self.assertEqual("disabled", completion.receipt_choice(
            self.STEP, self.ITEM, "不需要，我直接检视"))

    def test_canonical_labels_keep_working_in_any_order(self):
        from mae_flow_core.workflow import completion
        item = {"askuser": {"questions": [{
            "options": ["需要，人工检视前先由 Agent 预检",
                        "不需要 Agent 预检，我直接检视"],
        }]}}
        self.assertEqual("enabled", completion.receipt_choice(
            self.STEP, item, "需要，人工检视前先由 Agent 预检"))

    def test_unmappable_labels_refuse_to_guess(self):
        """标签完全对不上时返回空——宁可打回重问,不做无声的翻转。"""
        from mae_flow_core.workflow import completion
        item = {"askuser": {"questions": [{
            "options": ["方案 A", "方案 B"],
        }]}}
        self.assertEqual("", completion.receipt_choice(
            self.STEP, item, "方案 A"))

    def test_multi_choice_with_recommendation_suffix(self):
        """四选一的 workflow 卡:标准文本+(推荐)后缀必须照常工作。"""
        from mae_flow_core.workflow import completion
        step = {
            "choices": ["full", "hotfix", "tweak", "review"],
            "choice_answers": {
                "full": ["完整开发"], "hotfix": ["已定位问题修复"],
                "tweak": ["局部修改"], "review": ["处理评审意见"],
            },
        }
        item = {"askuser": {"questions": [{
            "options": ["完整开发 (推荐)", "已定位问题修复",
                        "局部修改", "处理评审意见"],
        }]}}
        self.assertEqual("full", completion.receipt_choice(
            step, item, "完整开发 (推荐)"))


class ConfigCardPolarityTests(unittest.TestCase):
    """配置卡的整卡极性:卡上任一"需要修改"类回答=整卡打回。

    独立判每个答案会让卡上其他问题的回答(如"交付方式: 完整开发")
    替确认题背书——云端宿主实测踩中:用户答"需要修改"+"完整开发",
    done 照样推进。此处用同一条 dispatch/CLI 链钉住两个方向。
    """

    CARD = {"questions": [
        {"question": "上述完整配置是否正确?",
         "options": [{"label": "确认以上全部配置"}, {"label": "需要修改"}]},
        {"question": "交付方式?",
         "options": [{"label": "完整开发"}, {"label": "局部修改"}]},
    ]}

    def _project(self):
        project = tempfile.mkdtemp(prefix="mae-polarity-")
        subprocess.run(["git", "init", "-q", "-b", "master", project],
                       check=True, capture_output=True)
        # 证据链是真的:需求文档必须真实存在,基线分支必须可解析。
        os.makedirs(os.path.join(project, "docs", "req"), exist_ok=True)
        with open(os.path.join(project, "docs", "req", "REQ-REQ9.md"),
                  "w", encoding="utf-8") as stream:
            stream.write("# REQ9 极性演练\n")
        subprocess.run(["git", "-C", project, "add", "."], check=True,
                       capture_output=True)
        subprocess.run(
            ["git", "-C", project, "-c", "user.email=t@t",
             "-c", "user.name=t", "commit", "-q", "-m", "init"],
            check=True, capture_output=True)
        with open(os.path.join(project, ".mae-flow.json"), "w",
                  encoding="utf-8") as stream:
            json.dump({
                "current": "config_confirm",
                "config": {}, "choices": {}, "history": [],
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            }, stream)
        subprocess.run(
            [sys.executable, MAE, "config-review",
             "--set", "工号=cloudbot", "--set", "基线分支=master",
             "--set", "单号=REQ9", "--set", "单号类型=REQ",
             "--set", "需求文档=docs/req/REQ-REQ9.md",
             "--set", "编译方式=echo ok", "--set", "UT生成方式=java-autout",
             "--set", "UT运行命令=echo ok"],
            cwd=project, check=True, text=True, capture_output=True,
            timeout=30)
        return project

    def _answer(self, project, answers):
        payload = json.dumps({
            "cwd": project,
            "tool_name": "AskUserQuestion",
            "tool_input": self.CARD,
            "tool_response": {"answers": answers},
        }, ensure_ascii=False) + "\n"
        captured = subprocess.run(
            [sys.executable, DISPATCH, "posttooluse"],
            cwd=project, input=payload, text=True,
            capture_output=True, timeout=15)
        self.assertEqual(0, captured.returncode, captured.stderr)

    def _done(self, project):
        return subprocess.run(
            [sys.executable, MAE, "done"],
            cwd=project, text=True, capture_output=True, timeout=30)

    def _current(self, project):
        with open(os.path.join(project, ".mae-flow.json"),
                  encoding="utf-8") as stream:
            return json.load(stream)["current"]

    def test_needs_change_on_card_blocks_done_even_with_sibling_answer(self):
        project = self._project()
        self._answer(project, {
            "上述完整配置是否正确?": "需要修改", "交付方式?": "完整开发"})
        refused = self._done(project)
        self.assertNotEqual(0, refused.returncode,
                            refused.stdout + refused.stderr)
        self.assertIn("修改", refused.stdout + refused.stderr)
        self.assertEqual("config_confirm", self._current(project))
        # 打回后重审确认:最新的肯定卡放行。
        self._answer(project, {
            "上述完整配置是否正确?": "确认以上全部配置", "交付方式?": "完整开发"})
        advanced = self._done(project)
        self.assertEqual(0, advanced.returncode,
                         advanced.stdout + advanced.stderr)
        self.assertEqual("workflow_select", self._current(project))

    def test_newest_refusal_overrides_older_confirmation(self):
        project = self._project()
        self._answer(project, {
            "上述完整配置是否正确?": "确认以上全部配置", "交付方式?": "完整开发"})
        self._answer(project, {
            "上述完整配置是否正确?": "需要修改", "交付方式?": "完整开发"})
        refused = self._done(project)
        self.assertNotEqual(0, refused.returncode,
                            refused.stdout + refused.stderr)
        self.assertEqual("config_confirm", self._current(project))

    def test_full_confirmation_survives_regenerated_config_and_changed_requirement(self):
        project = self._project()
        self._answer(project, {
            "上述完整配置是否正确?": "确认以上全部配置", "交付方式?": "完整开发"})
        state_path = os.path.join(project, ".mae-flow.json")
        with open(state_path, encoding="utf-8") as stream:
            before = json.load(stream)
        pending = before["config_review"]["config"]
        with open(os.path.join(project, pending["需求文档"]), "a", encoding="utf-8") as stream:
            stream.write("\n补充需求说明\n")
        args = [sys.executable, MAE, "config-review"]
        for key, value in pending.items():
            args.extend(["--set", key + "=" + str(value)])
        rerender = subprocess.run(args, cwd=project, text=True, capture_output=True, timeout=30)
        self.assertEqual(0, rerender.returncode, rerender.stdout + rerender.stderr)
        with open(state_path, encoding="utf-8") as stream:
            after = json.load(stream)
        self.assertEqual(before["config_review"]["id"], after["config_review"]["id"])
        self.assertNotIn("sha256", after["config_review"])
        advanced = self._done(project)
        self.assertEqual(0, advanced.returncode, advanced.stdout + advanced.stderr)
        self.assertEqual("workflow_select", self._current(project))


if __name__ == "__main__":
    unittest.main()
