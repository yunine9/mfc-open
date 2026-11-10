#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Precise, advisory-only formal CodeCheck request contracts."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality import (  # noqa: E402
    CodeCheckDisposition,
    CodeCheckTarget,
    build_codecheck_target,
    record_dispositions,
    render_codecheck_request,
)


class LizardFunction:
    def __init__(self, start_line, end_line, name, long_name=""):
        self.start_line = start_line
        self.end_line = end_line
        self.name = name
        self.long_name = long_name


class CodeCheckTargetTests(unittest.TestCase):
    def test_changed_files_and_touched_lizard_functions_are_exact(self):
        target = build_codecheck_target(
            changed_lines={
                r"src\calculator.cpp": {12, 31},
                r"tests\calculator_test.cpp": {8},
                "src/unparsed.cpp": {7},
                "src/deletion_only.py": set(),
            },
            function_ranges={
                "src/calculator.cpp": (
                    {
                        "start": 10,
                        "end": 20,
                        "context": "Calculator::apply(int value)",
                    },
                    {
                        "start": 30,
                        "end": 40,
                        "context": "Calculator::store()",
                    },
                    {
                        "start": 50,
                        "end": 60,
                        "context": "Calculator::untouched()",
                    },
                ),
                "src/unparsed.cpp": None,
            },
        )

        self.assertEqual(
            (
                "src/calculator.cpp",
                "src/unparsed.cpp",
                "src/deletion_only.py",
            ),
            target.files,
        )
        self.assertEqual(
            (
                ("src/calculator.cpp", "Calculator::apply(int value)"),
                ("src/calculator.cpp", "Calculator::store()"),
            ),
            target.functions,
        )

    def test_native_lizard_ranges_use_long_name_and_windows_matching(self):
        target = build_codecheck_target(
            changed_lines={r"SRC\Service.cs": {15}},
            function_ranges={
                "src/service.cs": (
                    LizardFunction(
                        10,
                        20,
                        "Run",
                        "Service.Run(int value)",
                    ),
                ),
            },
        )

        self.assertEqual(("SRC/Service.cs",), target.files)
        self.assertEqual(
            (("SRC/Service.cs", "Service.Run(int value)"),),
            target.functions,
        )

    def test_empty_lizard_long_name_falls_back_to_function_name(self):
        target = build_codecheck_target(
            changed_lines={"src/service.py": {4}},
            function_ranges={
                "src/service.py": (LizardFunction(1, 8, "apply"),),
            },
        )

        self.assertEqual((("src/service.py", "apply"),), target.functions)

    def test_uncertain_ranges_and_lines_preserve_file_level_targets(self):
        target = build_codecheck_target(
            changed_lines={
                "src/missing.py": None,
                "src/invalid.cpp": {9},
                "src/unnamed.cpp": {4},
            },
            function_ranges={
                "src/invalid.cpp": (
                    {"start": "unknown", "end": 12, "name": "apply"},
                ),
                "src/unnamed.cpp": (
                    {"start": 1, "end": 8, "context": ""},
                ),
            },
        )

        self.assertEqual(
            ("src/missing.py", "src/invalid.cpp", "src/unnamed.cpp"),
            target.files,
        )
        self.assertEqual((), target.functions)

    def test_fractional_line_facts_do_not_create_inexact_function_targets(self):
        target = build_codecheck_target(
            changed_lines={
                "src/fractional-change.cpp": {4.5},
                "src/fractional-range.cpp": {4},
            },
            function_ranges={
                "src/fractional-change.cpp": (
                    {"start": 1, "end": 8, "name": "changed"},
                ),
                "src/fractional-range.cpp": (
                    {"start": 1.5, "end": 8, "name": "ranged"},
                ),
            },
        )

        self.assertEqual(
            ("src/fractional-change.cpp", "src/fractional-range.cpp"),
            target.files,
        )
        self.assertEqual((), target.functions)

    def test_default_test_detection_requires_a_real_test_name_boundary(self):
        target = build_codecheck_target(
            changed_lines={
                "src/ContestDataService.java": {3},
                "src/Contest.java": {3},
                "src/Protest.cs": {3},
                "src/Latest.kt": {3},
                "src/FooTest.java": {3},
                "src/FooTests.cs": {3},
                "src/UpperTest.JAVA": {3},
                "src/UpperTests.CS": {3},
                "tests/Foo.java": {3},
                "src/test/Fixture.java": {3},
                "lib/spec/helper.ts": {3},
                "src/service.spec.ts": {3},
                "src/test_feature.py": {3},
            },
            function_ranges={},
        )

        self.assertEqual(
            (
                "src/ContestDataService.java",
                "src/Contest.java",
                "src/Protest.cs",
                "src/Latest.kt",
            ),
            target.files,
        )

    def test_custom_test_classifier_can_exclude_private_test_roots(self):
        target = build_codecheck_target(
            changed_lines={
                "product/main.cpp": {2},
                "verification/main.cpp": {2},
                "product/service.spec.ts": {2},
            },
            function_ranges={},
            is_test_path=lambda path: path.startswith("verification/"),
        )

        self.assertEqual(
            ("product/main.cpp", "product/service.spec.ts"),
            target.files,
            "a supplied is_test_path predicate is authoritative",
        )

    def test_casefold_range_fallback_requires_unique_changed_path_identity(self):
        changed = {
            "src/Foo.cpp": {4},
            "src/foo.cpp": {4},
        }
        exact = build_codecheck_target(
            changed_lines=changed,
            function_ranges={
                "src/Foo.cpp": (
                    {"start": 1, "end": 8, "name": "upper"},
                ),
            },
        )
        fallback_only = build_codecheck_target(
            changed_lines=changed,
            function_ranges={
                "SRC/FOO.CPP": (
                    {"start": 1, "end": 8, "name": "ambiguous"},
                ),
            },
        )

        self.assertEqual(
            (("src/Foo.cpp", "upper"),),
            exact.functions,
            "the missing exact lowercase range must remain file-level",
        )
        self.assertEqual((), fallback_only.functions)

    def test_target_builder_rejects_raw_tool_output_instead_of_parsing_it(self):
        with self.assertRaises(TypeError):
            build_codecheck_target(
                "CodeCheck returned PASS with 41 warnings",
                function_ranges={},
            )

    def test_target_value_normalizes_and_deduplicates_windows_paths(self):
        target = CodeCheckTarget(
            (r"src\one.cpp", "src/one.cpp"),
            (
                (r"src\one.cpp", "one()"),
                ("src/one.cpp", "one()"),
            ),
        )

        self.assertEqual(("src/one.cpp",), target.files)
        self.assertEqual((("src/one.cpp", "one()"),), target.functions)


class CodeCheckDispositionTests(unittest.TestCase):
    def test_every_enumerated_finding_gets_one_explicit_destination(self):
        findings = ("CC-1", "CC-2", "CC-3", "CC-4", "CC-5")
        dispositions = (
            CodeCheckDisposition("CC-5", "unsafe-now", "ABI risk"),
            CodeCheckDisposition("CC-3", "existing", "Predates this diff"),
            CodeCheckDisposition("CC-1", "fixed", "Named the constant"),
            CodeCheckDisposition("CC-4", "out-of-scope", "Generated source"),
            CodeCheckDisposition("CC-2", "false-positive", "Tool missed ownership"),
        )

        recorded = record_dispositions(findings, dispositions)

        self.assertEqual(findings, tuple(item.identity for item in recorded))
        self.assertEqual(
            ("fixed", "false-positive", "existing", "out-of-scope", "unsafe-now"),
            tuple(item.status for item in recorded),
        )

    def test_missing_extra_and_duplicate_destinations_are_rejected(self):
        cases = (
            (
                ("CC-1", "CC-2"),
                (CodeCheckDisposition("CC-1", "fixed", "done"),),
            ),
            (
                ("CC-1",),
                (
                    CodeCheckDisposition("CC-1", "fixed", "done"),
                    CodeCheckDisposition("CC-2", "existing", "old"),
                ),
            ),
            (
                ("CC-1",),
                (
                    CodeCheckDisposition("CC-1", "fixed", "done"),
                    CodeCheckDisposition("CC-1", "existing", "old"),
                ),
            ),
        )
        for findings, dispositions in cases:
            with self.subTest(findings=findings, dispositions=dispositions):
                with self.assertRaises(ValueError):
                    record_dispositions(findings, dispositions)

    def test_status_identity_and_reason_are_validated(self):
        cases = (
            ("", "fixed", "done"),
            ("CC-1", "ignored", "not important"),
            ("CC-1", ["fixed"], "wrong shape"),
            ("CC-1", "fixed", ""),
        )
        for identity, status, reason in cases:
            with self.subTest(identity=identity, status=status, reason=reason):
                with self.assertRaises(ValueError):
                    CodeCheckDisposition(identity, status, reason)

    def test_raw_output_only_result_needs_no_invented_findings(self):
        self.assertEqual((), record_dispositions(None, ()))
        with self.assertRaises(ValueError):
            record_dispositions(
                None,
                (CodeCheckDisposition("invented", "existing", "guessed"),),
            )

    def test_raw_text_is_not_treated_as_a_sequence_of_finding_ids(self):
        with self.assertRaises(TypeError):
            record_dispositions("CC-1: warning at line 41", ())


class CodeCheckRequestTests(unittest.TestCase):
    def test_request_is_one_advisory_configured_skill_prompt(self):
        target = CodeCheckTarget(
            ("src/service.cpp", "src/unparsed.cpp"),
            (("src/service.cpp", "Service::apply(int value)"),),
        )

        request = render_codecheck_request(target, "company-codecheck")

        self.assertIn("company-codecheck", request)
        self.assertIn("exactly once", request)
        self.assertIn("advisory", request)
        self.assertIn("src/service.cpp", request)
        self.assertIn("src/unparsed.cpp", request)
        self.assertIn("Service::apply(int value)", request)
        self.assertIn("raw-output-only", request)
        self.assertIn("fail open", request)
        self.assertIn("must not gate", request)
        self.assertIn("Do not launch a fixer", request)
        self.assertIn("Do not schedule a recheck", request)
        self.assertIn("Delivery", request)

    def test_empty_skill_identity_still_targets_configured_skill(self):
        request = render_codecheck_request(CodeCheckTarget((), ()))

        self.assertIn("configured CodeCheck Skill", request)


if __name__ == "__main__":
    unittest.main()
