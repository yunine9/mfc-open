#!/usr/bin/env python3
"""Deterministic domain archive transaction."""

import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.orchestration import domain_archive  # noqa: E402
from mae_flow_core.orchestration.behavior_baseline import (  # noqa: E402
    REQUIRED_DOMAIN_SECTIONS,
)


def document(title="无线接入", suffix="事实"):
    return "# %s\n\n%s\n" % (title, "\n\n".join(
        "## %s\n%s：这是已经验证并长期生效的领域规则。" % (heading, suffix)
        for heading in REQUIRED_DOMAIN_SECTIONS))


class DomainArchiveTests(unittest.TestCase):
    def test_candidate_initialization_preserves_existing_truth(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, "docs", "specs", "radio.md")
            os.makedirs(os.path.dirname(target))
            self._write(target, document(suffix="原有"))
            archive = os.path.join(root, ".mae-flow-work", "REQ-1", "domain-archive")
            result = domain_archive.initialize_candidate(
                root, archive, "radio", document(title="模板"))
            self.assertTrue(result.initialized)
            self.assertEqual("draft", result.action)
            self.assertEqual(document(suffix="原有"), self._read(result.candidate_path))

            self._write(result.candidate_path, document(suffix="更新"))
            prepared = domain_archive.prepare_candidate(
                root, result.candidate_path, "radio", ("SUL",))
            self.assertEqual("updated", prepared.action)

    def test_new_updated_unchanged_and_multi_domain_apply(self):
        with tempfile.TemporaryDirectory() as root:
            specs = os.path.join(root, "docs", "specs")
            os.makedirs(specs)
            self._write(os.path.join(specs, "index.md"), """
# 领域文档索引

| 领域 | 关键词 | 文档 |
| --- | --- | --- |
| radio | SUL | docs/specs/radio.md |
""")
            self._write(os.path.join(specs, "radio.md"), document(suffix="原有"))
            candidate_root = os.path.join(root, ".mae-flow-work", "REQ-1", "domain-archive")
            os.makedirs(candidate_root)
            radio = os.path.join(candidate_root, "radio.md")
            billing = os.path.join(candidate_root, "billing.md")
            self._write(radio, document(suffix="更新"))
            self._write(billing, document(title="计费", suffix="新增"))
            entries = (
                domain_archive.prepare_candidate(root, radio, "radio", ("SUL",)),
                domain_archive.prepare_candidate(root, billing, "billing", ("invoice",)),
            )
            self.assertEqual(("updated", "new"), tuple(x.action for x in entries))
            paths = domain_archive.apply_candidates(root, entries)
            self.assertEqual(
                ("docs/specs/billing.md", "docs/specs/index.md", "docs/specs/radio.md"),
                paths)
            self.assertEqual("unchanged", domain_archive.prepare_candidate(
                root, radio, "radio", ("SUL",)).action)
            self.assertIn("| billing | invoice | docs/specs/billing.md |",
                          self._read(os.path.join(specs, "index.md")))

    def test_template_is_advisory_and_unrelated_inputs_do_not_expire_archive(self):
        with tempfile.TemporaryDirectory() as root:
            candidate = os.path.join(root, "candidate.md")
            self._write(candidate, "# 空文档\n")
            prepared = domain_archive.prepare_candidate(root, candidate, "radio", ())
            self.assertEqual("new", prepared.action)
            self.assertEqual(("radio",), prepared.keywords)
            source = os.path.join(root, "story.md")
            self._write(source, "v1")
            frozen = domain_archive.input_digest(root, (source,), "diff-v1", ())
            self._write(source, "v2")
            current = domain_archive.input_digest(root, (source,), "diff-v1", ())
            self.assertEqual(frozen, current)

    def test_candidate_edit_invalidates_prepared_archive_digest(self):
        with tempfile.TemporaryDirectory() as root:
            candidate = os.path.join(root, "candidate.md")
            self._write(candidate, document(suffix="准备时"))
            entry = domain_archive.prepare_candidate(
                root, candidate, "radio", ("SUL",))
            frozen = domain_archive.input_digest(
                root, (), "diff-v1", (entry,))

            self._write(candidate, document(suffix="确认前又修改"))
            current = domain_archive.input_digest(
                root, (), "diff-v1", (entry,))

            with self.assertRaisesRegex(ValueError, "候选已过期"):
                domain_archive.require_fresh(frozen, current)

    def test_apply_rolls_back_when_one_replace_fails(self):
        with tempfile.TemporaryDirectory() as root:
            specs = os.path.join(root, "docs", "specs")
            candidates = os.path.join(root, "candidates")
            os.makedirs(specs)
            os.makedirs(candidates)
            self._write(os.path.join(specs, "radio.md"), document(suffix="原有"))
            candidate = os.path.join(candidates, "radio.md")
            self._write(candidate, document(suffix="更新"))
            entry = domain_archive.prepare_candidate(
                root, candidate, "radio", ("SUL",))
            calls = []

            def fail_second(source, target):
                calls.append(target)
                if len(calls) == 2:
                    raise OSError("simulated")
                os.replace(source, target)

            with self.assertRaisesRegex(OSError, "simulated"):
                domain_archive.apply_candidates(root, (entry,), replacer=fail_second)
            self.assertEqual(document(suffix="原有"), self._read(
                os.path.join(specs, "radio.md")))

    @staticmethod
    def _write(path, content):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(content)

    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8") as stream:
            return stream.read()


if __name__ == "__main__":
    unittest.main()
