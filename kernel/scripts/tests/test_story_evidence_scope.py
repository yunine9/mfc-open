"""Story future testing checklist must not invalidate an approved design."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from mae_flow_core.workflow.evidence_rules import WorkflowEvidenceRules
from mae_flow_core.workflow.markdown_scope import without_sections


class StoryScopeTests(unittest.TestCase):
    def setUp(self):
        self.step = json.loads((ROOT / "flow/flow.json").read_text())["steps"]["story"]
        self.rules = [r for r in self.step["evidence"] if r["type"] == "content_free"]

    def evaluate(self, text, name="story.md"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / name
            path.write_text(text)
            ports = SimpleNamespace(glob_paths=lambda _: [str(path)],
                                    read_text_replace=lambda f: Path(f).read_text())
            spec = next(r for r in self.rules if r["file"].endswith("/" + name))
            result = WorkflowEvidenceRules(ports).content_free(spec, {"config": {"单号": "REQ-1"}})
            self.assertEqual(text, path.read_text(), "evidence check must never rewrite approved files")
            return result.passed

    def test_future_testing_actions_pass_without_rewording(self):
        text = ("## 2 方案设计\n接口已确认\n## 5 Story转测自检表\n"
                "| ID | 自检项 | 描述 | 是否通过 |\n|--|--|--|--|\n"
                "| 1 | 串讲 | 转测时进行 | 待转测时确认 |\n"
                "| 5 | 国际化 | 翻译部复核 | 待确认 |\n"
                "| 6 | DT | 增量 UT | 待执行 |\n")
        self.assertTrue(self.evaluate(text))

    def test_real_design_pending_still_blocks_before_and_after_checklist(self):
        for text in ("## 2 方案设计\n接口待确认\n## 5 Story转测自检表\n待执行",
                     "## 5 Story转测自检表\n待执行\n## 6 补充设计\n接口待确认",
                     "## 5 Story转测自检表\n待执行\n# 新设计\n接口待确认"):
            self.assertFalse(self.evaluate(text))

    def test_implementation_and_other_sections_are_not_exempt(self):
        self.assertFalse(self.evaluate("## 5 Story转测自检表\n接口待确认", "implementation.md"))
        self.assertFalse(self.evaluate("## 3 测试设计\n接口待确认"))

    def test_fenced_heading_does_not_hide_design(self):
        for fence in ("```markdown", "~~~markdown"):
            self.assertFalse(self.evaluate(fence + "\n## 5 Story转测自检表\n"
                                          + fence[:3] + "\n接口待确认"))

    def test_section_spacing_and_nested_headings(self):
        self.assertTrue(self.evaluate("## 5 Story 转测自检表 ##\n### DT\n待确认"))
        self.assertFalse(self.evaluate("## 5 Story 转测自检表\n待执行\n## 6 新增\n待确认"))

    def test_unconfigured_rules_are_unchanged(self):
        text = "## 5 Story转测自检表\n待确认\n"
        self.assertEqual(text, without_sections(text, []))

    def test_design_review_approval_and_artifact_version_remain_required(self):
        self.assertTrue(self.step["user_ack"])
        self.assertEqual(["story", "implementation"], self.step["approval_subject"]["artifacts"])
        self.assertEqual({"STORY", "REVIEWER"}, {r["agent"] for r in self.step["evidence"] if r["type"] == "agent_ran"})
        self.assertEqual(2, sum(r["type"] == "glob" for r in self.step["evidence"]))


if __name__ == "__main__":
    unittest.main()
