#!/usr/bin/env python3
"""Relevant-only domain documentation selection."""

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


class BehaviorBaselineTests(unittest.TestCase):
    def _module(self):
        name = "mae_flow_core.orchestration.behavior_baseline"
        self.assertIsNotNone(importlib.util.find_spec(name))
        return importlib.import_module(name)

    def test_only_relevant_indexed_domain_documents_are_loaded(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as root:
            specs = os.path.join(root, "docs", "specs")
            os.makedirs(specs)
            self._write(os.path.join(specs, "index.md"), """
| 领域 | 关键词 | 文档 |
| --- | --- | --- |
| radio-access | NRPRACH, SUL, PRACH | docs/specs/radio-access.md |
| billing | invoice, account | docs/specs/billing.md |
""")
            self._write(os.path.join(specs, "radio-access.md"), "radio truth")
            self._write(os.path.join(specs, "billing.md"), "billing truth")
            context = module.load_relevant_domain_context(
                root, ("NRPRACH支持SUL模式",))
            self.assertEqual(("docs/specs/radio-access.md",), tuple(
                document.path for document in context.documents))
            self.assertEqual("radio truth", context.documents[0].content)

    def test_index_rejects_duplicate_domain_and_keyword_ownership(self):
        module = self._module()
        cases = (
            """
| 领域 | 关键词 | 文档 |
| --- | --- | --- |
| radio | SUL | docs/specs/radio.md |
| RADIO | PRACH | docs/specs/RADIO.md |
""",
            """
| 领域 | 关键词 | 文档 |
| --- | --- | --- |
| radio | SUL | docs/specs/radio.md |
| transport | sul | docs/specs/transport.md |
""",
        )
        for content in cases:
            with self.subTest(content=content):
                with tempfile.TemporaryDirectory() as root:
                    specs = os.path.join(root, "docs", "specs")
                    os.makedirs(specs)
                    self._write(os.path.join(specs, "index.md"), content)
                    with self.assertRaisesRegex(ValueError, "领域索引"):
                        module.load_relevant_domain_context(root, ("SUL",))

    def test_index_rejects_invalid_path_and_missing_document(self):
        module = self._module()
        rows = (
            "| radio | SUL | docs/other.md |",
            "| radio | SUL | docs/specs/radio.md |",
        )
        for row in rows:
            with self.subTest(row=row):
                with tempfile.TemporaryDirectory() as root:
                    specs = os.path.join(root, "docs", "specs")
                    os.makedirs(specs)
                    self._write(os.path.join(specs, "index.md"), """
| 领域 | 关键词 | 文档 |
| --- | --- | --- |
%s
""" % row)
                    with self.assertRaisesRegex(ValueError, "领域索引"):
                        module.load_relevant_domain_context(root, ("SUL",))

    @staticmethod
    def _write(path, content):
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(content)


if __name__ == "__main__":
    unittest.main()
