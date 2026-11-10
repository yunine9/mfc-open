#!/usr/bin/env python3
"""Domain document reconciliation and CLI surface."""

import importlib
import importlib.util
import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_parser import parse_args  # noqa: E402


class DomainDocumentTests(unittest.TestCase):
    def _module(self):
        name = "mae_flow_core.orchestration.behavior_baseline"
        self.assertIsNotNone(importlib.util.find_spec(name))
        return importlib.import_module(name)

    def test_parser_accepts_context_reconcile_show_and_validate(self):
        commands = (
            ["domain-docs", "context", "--term", "SUL"],
            ["domain-docs", "reconcile", "--domain", "radio-access", "--candidate", "candidate.md"],
            ["domain-docs", "show"],
            ["domain-docs", "validate"],
        )
        for argv in commands:
            with self.subTest(argv=argv):
                try:
                    args = parse_args(argv)
                except SystemExit:
                    self.fail("domain-docs command is missing")
                self.assertEqual("domain-docs", args.cmd)

    def test_reconciliation_distinguishes_new_updated_and_unchanged(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as root:
            new = module.plan_domain_reconciliation(root, "radio-access", "v1\n")
            self.assertEqual("new", new.action)
            os.makedirs(os.path.dirname(new.absolute_path))
            with open(new.absolute_path, "w", encoding="utf-8") as stream:
                stream.write("v1\n")
            unchanged = module.plan_domain_reconciliation(root, "radio-access", "v1\n")
            updated = module.plan_domain_reconciliation(root, "radio-access", "v2\n")
            self.assertEqual("unchanged", unchanged.action)
            self.assertEqual("updated", updated.action)
            self.assertFalse(unchanged.manifest_eligible)
            self.assertTrue(new.manifest_eligible)
            self.assertTrue(updated.manifest_eligible)

    def test_domain_name_cannot_escape_docs_specs(self):
        module = self._module()
        for domain in ("../radio", "radio/access", "CON", "index"):
            with self.subTest(domain=domain):
                with self.assertRaises(ValueError):
                    module.plan_domain_reconciliation("root", domain, "truth")

    def test_domain_document_requires_ten_substantive_sections(self):
        module = self._module()
        valid = "# 无线接入领域\n\n" + "\n\n".join(
            "## %s\n这是经过确认且可长期维护的领域事实。" % heading
            for heading in module.REQUIRED_DOMAIN_SECTIONS)
        self.assertEqual((), module.validate_domain_document(valid))
        invalid = valid.replace(
            "这是经过确认且可长期维护的领域事实。", "待补充", 1)
        errors = module.validate_domain_document(invalid)
        self.assertTrue(errors)
        self.assertIn("领域目标与边界", errors[0])
        self.assertTrue(module.validate_domain_document(
            valid + "\n<!-- MAE-FLOW-DOMAIN-DRAFT -->\n"))

    def test_unchanged_template_guidance_is_not_durable_domain_truth(self):
        module = self._module()
        template = os.path.join(
            ROOT, "skills", "mae-flow", "assets",
            "DOMAIN-SPEC-TEMPLATE.md")
        with open(template, encoding="utf-8") as stream:
            content = stream.read()
        content = content.replace("<领域名称>", "无线接入")
        content = content.replace(
            "<!-- MAE-FLOW-DOMAIN-DRAFT：完成归档前删除本行 -->", "")

        errors = module.validate_domain_document(content)

        self.assertTrue(errors)
        self.assertTrue(any("模板说明" in error for error in errors))

    def test_requirement_process_metadata_is_rejected(self):
        module = self._module()
        base = "# 无线接入领域\n\n" + "\n\n".join(
            "## %s\n这是经过确认且可长期维护的领域事实。" % heading
            for heading in module.REQUIRED_DOMAIN_SECTIONS)
        markers = (
            "需求单号：REQ-123",
            "本规则在 CP1 完成",
            "CODE Reviewer：CLEAR",
            "评审记录：第二轮通过",
            "提交记录：abc123",
            "临时方案：先绕过校验",
        )
        for marker in markers:
            with self.subTest(marker=marker):
                errors = module.validate_domain_document(
                    base + "\n\n" + marker + "\n")
                self.assertTrue(any("过程元数据" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
