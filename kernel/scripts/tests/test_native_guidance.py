#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Semantic contracts for distilled Mae-Flow native quality guidance."""

import ast
import importlib.util
import json
import os
import re
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
GUIDANCE_ROOT = os.path.join(ROOT, "runtime", "guidance")
MATRIX_PATH = os.path.join(GUIDANCE_ROOT, "capability-preservation.json")
MANIFEST_PATH = os.path.join(ROOT, "runtime", "vendor", "manifest.json")
LOADER_PATH = os.path.join(
    SCRIPTS, "mae_flow_core", "orchestration", "native_guidance.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.capability_shared import CAPABILITY_PACKS  # noqa: E402
from mae_flow_core import capabilities  # noqa: E402
from tests.selftest_suites import REFACTOR_SAFETY_SUITES  # noqa: E402


GUIDANCE_NAMES = (
    "grill", "story-design", "construction", "review", "quality")
PRESERVATION_STATUSES = {
    "preserved", "thin-replacement", "friction-removed", "migration-only"}
REQUIRED_ROLE_CAPABILITIES = {
    ("role:grill-critic-agent", "Grill critic"),
    ("role:story-generator-agent", "Story generator"),
    ("role:story-generator-agent", "Task Analyst"),
    ("role:craft-reviewer-agent", "PLAN Reviewer"),
    ("design-provenance:lean-story-review", "Design Reviewer"),
    ("role:craft-reviewer-agent", "CODE Reviewer"),
    ("role:story-generator-agent", "test-design agent"),
    ("role:codecheck-fix-agent", "CodeCheck fixer"),
    ("role:ut-generator-agent", "UT generator"),
}
REQUIRED_FILE_CAPABILITIES = {
    ("file:flow/steps/grill.md", "Interactive Grill"),
}


def read_text(path):
    with open(path, encoding="utf-8", newline=None) as stream:
        return stream.read()


def read_json(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def native_module(testcase):
    testcase.assertTrue(os.path.isfile(LOADER_PATH), LOADER_PATH)
    spec = importlib.util.spec_from_file_location(
        "task6_native_guidance", LOADER_PATH)
    testcase.assertIsNotNone(spec)
    testcase.assertIsNotNone(spec.loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def guidance(testcase, name):
    path = os.path.join(GUIDANCE_ROOT, name + ".md")
    testcase.assertTrue(os.path.isfile(path), path)
    return read_text(path)


def test_method_exists(testcase, identifier):
    match = re.fullmatch(
        r"(scripts/tests/test_[a-z0-9_]+\.py):"
        r"([A-Za-z_][A-Za-z0-9_]*)\."
        r"(test_[A-Za-z0-9_]+)",
        identifier,
    )
    testcase.assertIsNotNone(match, identifier)
    relative, class_name, method_name = match.groups()
    path = os.path.join(ROOT, *relative.split("/"))
    testcase.assertTrue(os.path.isfile(path), path)
    tree = ast.parse(read_text(path), filename=path)
    classes = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.ClassDef)
    }
    testcase.assertIn(class_name, classes, identifier)
    methods = {
        node.name
        for node in classes[class_name].body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    testcase.assertIn(method_name, methods, identifier)


class CapabilityPreservationTests(unittest.TestCase):
    def matrix_document(self):
        self.assertTrue(os.path.isfile(MATRIX_PATH), MATRIX_PATH)
        document = read_json(MATRIX_PATH)
        self.assertEqual(1, document.get("schema"))
        return document

    def matrix_rows(self):
        document = self.matrix_document()
        rows = document.get("capabilities")
        self.assertIsInstance(rows, list)
        return rows

    def test_every_runtime_pack_and_specialized_role_is_classified(self):
        rows = self.matrix_rows()
        classified = {
            (row.get("source"), row.get("capability")) for row in rows}
        runtime_loaded = {
            (entry[1].split("/", 1)[0], entry[0])
            for entries in CAPABILITY_PACKS.values()
            for entry in entries
        }
        self.assertEqual(set(), runtime_loaded - classified)
        self.assertEqual(set(), REQUIRED_ROLE_CAPABILITIES - classified)
        self.assertEqual(set(), REQUIRED_FILE_CAPABILITIES - classified)

    def test_rows_have_one_supported_status_and_unique_identity(self):
        rows = self.matrix_rows()
        identities = []
        for row in rows:
            with self.subTest(row=row):
                self.assertTrue({
                    "source", "capability", "new_home", "semantic_tests",
                    "status",
                }.issubset(row))
                self.assertIsInstance(row["source"], str)
                self.assertTrue(row["source"].strip())
                self.assertIsInstance(row["capability"], str)
                self.assertTrue(row["capability"].strip())
                self.assertIn(row["status"], PRESERVATION_STATUSES)
                self.assertIsInstance(row["new_home"], str)
                self.assertTrue(row["new_home"].strip())
                self.assertIsInstance(row["semantic_tests"], list)
                identities.append((row["source"], row["capability"]))
        self.assertEqual(len(identities), len(set(identities)))

    def test_retained_rows_reference_real_semantic_contracts(self):
        rows = self.matrix_rows()
        for row in rows:
            with self.subTest(source=row["source"], capability=row["capability"]):
                if row["status"] in {"preserved", "thin-replacement"}:
                    self.assertTrue(row["semantic_tests"])
                for identifier in row["semantic_tests"]:
                    test_method_exists(self, identifier)

    def test_every_source_resolves_to_vendor_file_role_or_documented_design_provenance(self):
        document = self.matrix_document()
        provenance = document.get("design_provenance", {})
        vendor_sources = {
            "comet", "openspec", "superpowers", "ponytail", "lizard"}
        for row in document["capabilities"]:
            source = row["source"]
            with self.subTest(source=source, capability=row["capability"]):
                if source in vendor_sources:
                    self.assertTrue(os.path.isdir(os.path.join(
                        ROOT, "runtime", "vendor", source)))
                elif source.startswith("role:"):
                    name = source.split(":", 1)[1]
                    self.assertTrue(os.path.isfile(os.path.join(
                        ROOT, "agents", name + ".md")))
                elif source.startswith("file:"):
                    relative = source.split(":", 1)[1]
                    self.assertTrue(os.path.isfile(os.path.join(
                        ROOT, *relative.split("/"))))
                elif source.startswith("design-provenance:"):
                    name = source.split(":", 1)[1]
                    self.assertIn(name, provenance)
                    record = provenance[name]
                    self.assertTrue(record.get("description", "").strip())
                    self.assertTrue(record.get("sources"))
                    for relative in record["sources"]:
                        self.assertTrue(os.path.isfile(os.path.join(
                            ROOT, *relative.split("/"))))
                elif source == "main-agent":
                    self.assertEqual(
                        "runtime/guidance/construction.md", row["new_home"])
                else:
                    self.fail("unresolvable preservation source: " + source)

    def test_specific_distillations_point_to_their_semantic_regressions(self):
        rows = {
            (row["source"], row["capability"]): row
            for row in self.matrix_rows()
        }
        expected = {
            ("comet", "Comet 小改规则"):
                "test_focused_tweak_stays_fast_and_upgrades_by_semantic_risk",
            ("comet", "Comet 构建阶段规则"):
                "test_construction_records_and_reconciles_implementation_deviations",
            ("openspec", "OpenSpec 规格符合检查"):
                "test_review_compares_final_change_for_completeness_correctness_and_coherence",
            ("file:flow/steps/grill.md", "Interactive Grill"):
                "test_grill_separates_interactive_and_read_only_modes",
            ("role:grill-critic-agent", "Grill critic"):
                "test_grill_separates_interactive_and_read_only_modes",
        }
        for identity, method in expected.items():
            with self.subTest(identity=identity):
                self.assertIn(identity, rows)
                self.assertTrue(any(
                    identifier.endswith("." + method)
                    for identifier in rows[identity]["semantic_tests"]
                ))


class NativeGuidanceSemanticTests(unittest.TestCase):
    def test_requirement_branching_observable_what_and_internal_checklist(self):
        text = guidance(self, "grill").lower()
        for concept in (
                "requirement branch", "one question", "recommended answer",
                "observable", "precondition", "boundary", "partial failure",
                "compatibility", "concurrency", "non-goal"):
            self.assertIn(concept, text)
        self.assertIn("internal checklist", text)
        self.assertIn("not a required artifact", text)
        self.assertIn("grill owns requirement divergence", text)
        self.assertIn("does not duplicate brainstorming", text)
        self.assertNotIn("class or file design", text)

    def test_grill_separates_interactive_and_read_only_modes(self):
        text = guidance(self, "grill").lower()
        self.assertIn("choose exactly one mode", text)
        self.assertIn("interactive grill", text)
        self.assertIn("one question", text)
        self.assertIn("recommended answer", text)
        self.assertIn("read-only critic", text)
        self.assertIn("never asks the user", text)
        self.assertIn("never makes a decision", text)
        for concern in (
                "unique meaning", "answers and code facts", "untestable",
                "what/how mixing"):
            self.assertIn(concern, text)

    def test_focused_tweak_stays_fast_and_upgrades_by_semantic_risk(self):
        text = guidance(self, "construction").lower()
        self.assertIn("localized change", text)
        self.assertIn("concise confirmed scope", text)
        self.assertIn("proceed directly", text)
        self.assertIn("upgrade to full", text)
        for risk in (
                "unclear behavior", "cross-module", "compatibility",
                "security", "data", "public interface", "shared state",
                "concurrency"):
            self.assertIn(risk, text)
        self.assertIn("semantic risk", text)
        self.assertIn("not file or line count", text)

    def test_construction_records_and_reconciles_implementation_deviations(self):
        text = guidance(self, "construction").lower()
        self.assertIn("implementation deviation", text)
        self.assertIn("record", text)
        self.assertIn("confirmed spec", text)
        self.assertIn("behavior baseline", text)
        self.assertIn("align the implementation", text)
        self.assertIn("propose an artifact update", text)
        self.assertIn("never silently rewrite", text)

    def test_review_compares_final_change_for_completeness_correctness_and_coherence(self):
        text = guidance(self, "review").lower()
        for subject in (
                "final implementation", "final diff", "confirmed spec",
                "confirmed story"):
            self.assertIn(subject, text)
        self.assertIn("completeness", text)
        self.assertIn("required observable behaviors", text)
        self.assertIn("correctness", text)
        self.assertIn("accepted scenarios", text)
        self.assertIn("coherence", text)
        self.assertIn("design decisions", text)

    def test_spec_is_what_and_story_is_how(self):
        grill = guidance(self, "grill").lower()
        story = guidance(self, "story-design").lower()
        self.assertIn("what", grill)
        self.assertIn("how belongs to story", grill)
        self.assertIn("approved spec", story)
        self.assertIn("what", story)
        self.assertIn("how", story)
        self.assertIn("do not reopen", story)

    def test_story_and_construction_define_engineering_boundaries(self):
        text = "\n".join((
            guidance(self, "story-design"),
            guidance(self, "construction"),
        )).lower()
        for concept in (
                "ownership", "error", "lifetime", "concurrency",
                "compatibility", "reuse", "standard library",
                "simplest design", "speculative abstraction"):
            self.assertIn(concept, text)

    def test_testability_seams_are_created_during_coding(self):
        story = guidance(self, "story-design").lower()
        construction = guidance(self, "construction").lower()
        for text in (story, construction):
            self.assertIn("test seam", text)
            self.assertIn("during coding", text)
            self.assertIn("deterministic", text)
        self.assertIn("framework boundary", construction)
        self.assertIn("formal ut", construction)

    def test_root_cause_and_review_first_verification_survive(self):
        review = guidance(self, "review").lower()
        quality = guidance(self, "quality").lower()
        self.assertIn("verify the review claim", review)
        self.assertIn("before changing code", review)
        self.assertIn("root cause", review)
        self.assertIn("root cause", quality)
        self.assertIn("fresh evidence", quality)
        self.assertIn("before claiming", quality)

    def test_reviewer_cadence_and_conditional_integration_are_semantic(self):
        text = guidance(self, "review").lower()
        self.assertIn("design reviewer", text)
        self.assertIn("exactly once per full story", text)
        self.assertIn("code reviewer", text)
        self.assertIn("runs once before human review", text)
        self.assertIn("accepted fixes do not restart a full code review", text)
        self.assertIn("focused design-to-implementation follow-up", text)
        self.assertNotIn("accepted fixes do not schedule another reviewer pass", text)
        self.assertIn("integration review", text)
        for risk in (
                "cross-module coupling", "shared state", "interface change",
                "late design change"):
            self.assertIn(risk, text)
        self.assertIn("not file or line count", text)

    def test_quality_is_opaque_one_shot_and_behavior_driven(self):
        text = guidance(self, "quality").lower()
        self.assertLess(
            text.index("formal codecheck"),
            text.index("build"),
        )
        self.assertLess(text.index("build"), text.index("unit test"))
        self.assertIn("opaque", text)
        self.assertIn("do not parse", text)
        self.assertIn("at most once", text)
        self.assertIn("no automatic retry", text)
        self.assertIn("semantic impact", text)
        self.assertIn("observable behavior", text)
        self.assertIn("must not happen", text)
        self.assertIn("real boundary", text)

    def test_native_guidance_removes_upstream_runtime_rituals(self):
        forbidden = (
            "/comet", "/opsx", "/ponytail", "openspec ", "superpowers:",
            ".comet.yaml", "task_card_sha256",
            "exact ack", "fixed ack", "evidence token", "git sha",
            "test-driven development", "red-green", "dispatch a subagent",
            "advance the phase", "transition the workflow",
        )
        fixed_retry = re.compile(
            r"retry\s+(?:exactly\s+|up\s+to\s+)?\d+|"
            r"(?:two|three|four|five)\s+retries",
            re.IGNORECASE,
        )
        for name in GUIDANCE_NAMES:
            with self.subTest(guidance=name):
                text = guidance(self, name).lower()
                for term in forbidden:
                    self.assertNotIn(term, text)
                self.assertIsNone(fixed_retry.search(text))


class NativeGuidanceLoaderTests(unittest.TestCase):
    def test_design_review_dispatch_and_unresolved_results_add_no_gate(self):
        from mae_flow_core.application.hooks.event_policies import agent_kind
        from mae_flow_core.application.hooks.agent_completion import (
            AgentCompletionPorts, handle_agent_completion)

        text = native_module(self).load_native_guidance("review")
        prompt = text.split("### 检视子 Agent 提示\n", 1)[1].strip()
        self.assertIn("subagent_type: design-consistency-review", text)
        task = {"subagent_type": "design-consistency-review",
                "description": "设计与实现一致性检视", "prompt": prompt}
        self.assertEqual("", agent_kind(task),
                         "实际检视提示不能误触已退役角色的任务卡要求")
        for status, expected in (("returned", "returned"),
                                 ("failed", "interrupted"),
                                 ("canceled", "interrupted"),
                                 ("timeout", "timeout")):
            with self.subTest(status=status):
                recorded = []
                ports = AgentCompletionPorts(
                    state_path="/repo/.mae-flow.json",
                    latest_started=lambda **_kwargs: "design-review-1",
                    record_finished=lambda *args: recorded.append(args),
                    record_execution=lambda *_args: None,
                    scope_violation=lambda *_args: "",
                    log=lambda _message: None,
                )
                response = handle_agent_completion({
                    "invocation_id": "design-review-1",
                    "tool_input": task, "lifecycle": status,
                    "assistant_text": "D1 仍存在；真实部署证据不足。",
                }, ports)
                self.assertEqual(0, response.exit_code)
                self.assertEqual(expected, recorded[0][2])
                self.assertIn("D1 仍存在", recorded[0][3])

    def test_loader_reads_only_the_requested_named_guidance(self):
        module = native_module(self)
        with tempfile.TemporaryDirectory(prefix="mae guidance ") as root:
            expected = {}
            for name in GUIDANCE_NAMES:
                marker = "native-only:%s:行为\n" % name
                expected[name] = marker
                with open(
                        os.path.join(root, name + ".md"), "w",
                        encoding="utf-8", newline="\n") as stream:
                    stream.write(marker)
            module.GUIDANCE_ROOT = root
            for name in GUIDANCE_NAMES:
                with self.subTest(name=name):
                    self.assertEqual(expected[name], module.load_native_guidance(name))

    def test_loader_rejects_unknown_posix_and_windows_traversal_names(self):
        module = native_module(self)
        bad_names = (
            "unknown", "../quality", "review/../quality",
            r"..\quality", r"review\..\quality", r"C:\runtime\quality",
            "quality.md", "", None,
        )
        for name in bad_names:
            with self.subTest(name=name):
                with self.assertRaises((TypeError, ValueError)):
                    module.load_native_guidance(name)

    def test_loader_normalizes_windows_newlines_without_losing_utf8(self):
        module = native_module(self)
        with tempfile.TemporaryDirectory(prefix="mae 指引 ") as root:
            path = os.path.join(root, "quality.md")
            with open(path, "wb") as stream:
                stream.write("质量\r\nobservable behavior\r\n".encode("utf-8"))
            module.GUIDANCE_ROOT = root
            self.assertEqual(
                "质量\nobservable behavior\n",
                module.load_native_guidance("quality"),
            )


class NativeGuidanceManifestTests(unittest.TestCase):
    def test_manifest_keeps_vendor_sources_hashes_and_licenses_for_diagnostics(self):
        manifest = read_json(MANIFEST_PATH)
        self.assertEqual(1, manifest["schema"])
        components = manifest["components"]
        self.assertEqual(
            {"comet", "openspec", "superpowers", "ponytail", "lizard"},
            set(components),
        )
        for name, metadata in components.items():
            with self.subTest(component=name):
                self.assertTrue(metadata["source"])
                self.assertRegex(metadata["sha256"], r"^[0-9a-f]{64}$")
                self.assertIn("license", metadata)
                license_path = os.path.join(ROOT, metadata["license"])
                self.assertTrue(os.path.isfile(license_path), license_path)

        checks = capabilities.diagnostics(ROOT)
        integrity = {
            item["name"]: item for item in checks
            if item["name"].startswith("源码完整性 ")}
        self.assertEqual(
            {"源码完整性 " + name for name in components}, set(integrity))
        self.assertTrue(all(item["ok"] for item in integrity.values()), integrity)

    def test_manifest_declares_native_runtime_without_replacing_vendor_sources(self):
        manifest = read_json(MANIFEST_PATH)
        self.assertIn("runtime_guidance", manifest)
        runtime = manifest["runtime_guidance"]
        self.assertEqual("runtime/guidance", runtime["directory"])
        self.assertEqual(
            "scripts/mae_flow_core/orchestration/native_guidance.py",
            runtime["loader"],
        )
        self.assertEqual(list(GUIDANCE_NAMES), runtime["names"])
        self.assertEqual(
            "runtime/guidance/capability-preservation.json",
            runtime["preservation"],
        )
        self.assertFalse(runtime["loads_vendor_prompt_text"])

    def test_release_selftest_does_not_register_retired_guidance_suite(self):
        commands = [
            command
            for unused_label, command, unused_timeout, unused_limit
            in REFACTOR_SAFETY_SUITES
            if command and command[0] == "scripts/tests/test_native_guidance.py"
        ]
        self.assertEqual([], commands)


if __name__ == "__main__":
    unittest.main()
