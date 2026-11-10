#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pure CodeCheck policy contracts."""

import os
import sys
import unittest


SCRIPTS = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..")
)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.quality.codecheck import (  # noqa: E402
    CodeCheckBatch,
    CodeCheckWarning,
    aggregate_batches,
    extract_report_warnings,
    map_warning_paths,
    parse_count,
    parse_json_result,
    split_batches,
)


class CodeCheckPolicyTests(unittest.TestCase):
    def test_count_parser_preserves_all_trusted_formats(self):
        cases = [
            ("💡 提示: 共有 2 条告警。", "", 2),
            (
                "[CodeCheck] 代码检查完成",
                "| **总计** | **3** | **0** |",
                3,
            ),
            (
                "",
                "### 1. [Minor] R.ONE\n"
                "### 2. [严重级] R.TWO\n",
                2,
            ),
            (
                "[CodeCheck] 代码检查完成! 未发现代码告警",
                "",
                0,
            ),
        ]
        for console, report, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(
                    expected,
                    parse_count(console, report),
                )

    def test_count_parser_never_guesses_zero_from_exit_text(self):
        self.assertIsNone(
            parse_count(
                "process exited successfully",
                "no recognizable CodeCheck report",
            )
        )

    def test_json_parser_deduplicates_uuid_and_reads_line_aliases(self):
        count, warnings = parse_json_result({
            "groups": [{
                "issues": [
                    {
                        "uuid": "same",
                        "ruleName": "R.ONE details",
                        "filePath": r"src\Foo.cpp",
                        "startLine": "17",
                    },
                    {
                        "uuid": "same",
                        "rule": "R.REPLACED",
                        "file": "src/Foo.cpp",
                        "line": 19,
                    },
                    {
                        "issueId": "two",
                        "ruleId": "R.TWO",
                        "path": "src/Bar.cpp",
                        "lineNumber": "not-a-number",
                    },
                ]
            }]
        })
        self.assertEqual(2, count)
        self.assertEqual(
            (
                CodeCheckWarning(
                    "R.REPLACED", "src/Foo.cpp", 19
                ),
                CodeCheckWarning("R.TWO", "src/Bar.cpp", None),
            ),
            warnings,
        )

    def test_json_parser_accepts_only_explicit_integer_total(self):
        self.assertEqual((4, ()), parse_json_result({
            "warningCount": 4
        }))
        self.assertEqual((None, ()), parse_json_result({
            "warningCount": "4"
        }))

    def test_report_warning_extraction_preserves_missing_lines(self):
        report = (
            "### 1. [Minor] first\n"
            "- **文件**: `Foo.cpp`\n"
            "- **规则**: R.ONE detail\n"
            "### 2. [Major] second\n"
            "- **文件**: `Bar.cpp`\n"
            "- **规则**: R.TWO detail\n"
        )
        self.assertEqual(
            (
                CodeCheckWarning("R.ONE", "Foo.cpp", None),
                CodeCheckWarning("R.TWO", "Bar.cpp", None),
            ),
            extract_report_warnings(report),
        )

    def test_warning_paths_restore_only_unique_batch_match(self):
        warnings = (
            CodeCheckWarning("R.ONE", "Unique.cpp", 3),
            CodeCheckWarning("R.TWO", "Foo.cpp", None),
        )
        self.assertEqual(
            (
                CodeCheckWarning(
                    "R.ONE", "src/Unique.cpp", 3),
                CodeCheckWarning("R.TWO", "Foo.cpp", None),
            ),
            map_warning_paths(
                warnings,
                (
                    "src/Unique.cpp",
                    "src/Foo.cpp",
                    "other/Foo.cpp",
                ),
            ),
        )

    def test_batch_aggregation_preserves_order_and_commands(self):
        result = aggregate_batches((
            CodeCheckBatch(
                count=1,
                warnings=(
                    CodeCheckWarning("R.ONE", "a.cpp", 1),
                ),
                command="codecheck a.cpp",
            ),
            CodeCheckBatch(
                count=2,
                warnings=(
                    CodeCheckWarning("R.TWO", "b.cpp", None),
                ),
                command="codecheck b.cpp",
            ),
        ))
        self.assertEqual(3, result.total)
        self.assertEqual(
            ("codecheck a.cpp", "codecheck b.cpp"),
            result.commands,
        )
        self.assertEqual(
            ("R.ONE", "a.cpp", 1),
            result.warnings[0].as_tuple(),
        )

    def test_batching_limits_command_length_and_separates_duplicate_names(self):
        self.assertEqual(
            (
                ("src/Foo.cpp",),
                ("other/Foo.cpp", "src/LongName.cpp"),
            ),
            split_batches(
                (
                    "src/Foo.cpp",
                    "other/Foo.cpp",
                    "src/LongName.cpp",
                ),
                maxlen=40,
            ),
        )


if __name__ == "__main__":
    unittest.main()
