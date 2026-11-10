import os
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.lightcheck import (
    MAX_FILE_BYTES,
    MAX_REPORTED_ITEMS,
    analyze_changed,
    analyze_changed_with_timeout,
    render_markdown,
)
from mae_flow_core.lightcheck_nesting import annotate_control_nesting
from mae_flow_core.lightcheck_source import _load_lizard


def _write(root, path, text):
    absolute = os.path.join(root, path)
    os.makedirs(os.path.dirname(absolute) or root, exist_ok=True)
    with open(absolute, "w", encoding="utf-8") as stream:
        stream.write(text)


def _nesting_depth(path, source):
    lizard = _load_lizard()
    info = lizard.analyze_file.analyze_source_code(path, source)
    annotate_control_nesting(lizard, path, source, info.function_list)
    return info.function_list[0].max_control_nesting


def _nested_braced(
        declaration, depth=6, indent="  ", base_indent="", body_count=45,
        long_return=True):
    lines = [declaration]
    for index in range(depth):
        lines.append(
            base_indent + indent * (index + 1)
            + "if (value_%d) {" % index)
    body_indent = base_indent + indent * (depth + 1)
    lines.extend(
        body_indent + "value_%d = %d;" % (index, index)
        for index in range(body_count))
    return_value = (
        " + ".join(["value_0"] * 18)
        if long_return else "value_0")
    lines.append(body_indent + "return " + return_value + ";")
    for index in reversed(range(depth)):
        lines.append(base_indent + indent * (index + 1) + "}")
    lines.append(base_indent + "}")
    return "\n".join(lines) + "\n"


def _nested_python(depth=6, body_count=45):
    lines = ["def heavy(self, a, b, c, d, e, f):"]
    for index in range(depth):
        lines.append(
            "    " * (index + 1) + "if value_%d:" % index)
    body_indent = "    " * (depth + 1)
    lines.extend(
        body_indent + "value_%d = %d" % (index, index)
        for index in range(body_count))
    lines.append(
        body_indent + "return "
        + " + ".join(["value_0"] * 24))
    return "\n".join(lines) + "\n"


class LightCheckTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="mae-flow-lightcheck-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def analyze(self, path, source, changed=None, baseline=None):
        _write(self.root, path, source)
        lines = changed or set(range(1, len(source.splitlines()) + 1))
        baselines = {path: baseline} if baseline is not None else {}
        return analyze_changed(
            self.root, [path], {path: lines}, baseline_sources=baselines)

    def assert_all_rules(self, path, source):
        result = self.analyze(path, source)
        self.assertEqual(result["status"], "FINDINGS", result)
        rules = {item["rule"] for item in result["findings"]}
        self.assertTrue(
            {"MF-PARAM-5", "MF-FUNC-50", "MF-NEST-5", "MF-LINE-120"}
            .issubset(rules), result)

    @staticmethod
    def magic_findings(result):
        return [
            item for item in result["findings"]
            if item["rule"] == "MF-MAGIC-NUMBER"
        ]

    def test_cpp_java_javascript_python_cover_all_four_rules(self):
        cpp = _nested_braced(
            "int heavy(int a, int b, int c, int d, int e, int f) {")
        java = (
            "class Demo {\n"
            + _nested_braced(
                "  int heavy(int a, int b, int c, int d, int e, int f) {",
                base_indent="  ")
            + "}\n")
        javascript = _nested_braced(
            "function heavy(a, b, c, d, e, f) {")
        for path, source in (
                ("src/heavy.cpp", cpp),
                ("src/Demo.java", java),
                ("src/heavy.js", javascript),
                ("src/heavy.py", _nested_python())):
            with self.subTest(path=path):
                self.assert_all_rules(path, source)

    def test_python_self_and_javascript_destructuring_are_formal_parameter_safe(self):
        python = "def safe(self, a, b, c, d, e):\n    return a\n"
        javascript = "function safe({a, b}, c, d, e, f) {\n  return a;\n}\n"
        for path, source in (
                ("safe.py", python), ("safe.js", javascript)):
            result = self.analyze(path, source)
            self.assertNotIn(
                "MF-PARAM-5",
                {item["rule"] for item in result["findings"]},
                result,
            )

    def test_exact_parameter_line_and_nesting_limits_are_allowed(self):
        source = _nested_braced(
            "int boundary(int a, int b, int c, int d, int e) {",
            depth=5, body_count=43, long_return=False)
        result = self.analyze("boundary.cpp", source)
        structural_rules = {
            item["rule"] for item in result["findings"]
            if item["rule"] != "MF-MAGIC-NUMBER"
        }
        self.assertEqual(structural_rules, set(), result)

    def test_parallel_branches_and_compound_conditions_do_not_accumulate(self):
        fixtures = {
            "parallel.cpp": "\n".join([
                "int parallel() {",
                *["  if (a%d && b%d || c%d) value++;" % (
                    index, index, index) for index in range(12)],
                "  return value;",
                "}",
                "",
            ]),
            "parallel.ts": "\n".join([
                "function parallel() {",
                *["  if (a%d && b%d || c%d) value++;" % (
                    index, index, index) for index in range(12)],
                "  return value;",
                "}",
                "",
            ]),
            "parallel.py": "\n".join([
                "def parallel():",
                *["    if a%d and b%d or c%d:" % (
                    index, index, index) + "\n        value += 1"
                  for index in range(12)],
                "    return value",
                "",
            ]),
        }
        for path, source in fixtures.items():
            with self.subTest(path=path):
                self.assertEqual(_nesting_depth(path, source), 1)
                result = self.analyze(path, source)
                self.assertNotIn(
                    "MF-NEST-5",
                    {item["rule"] for item in result["findings"]},
                    result,
                )
                self.assertNotIn(
                    "MF-CC-5",
                    {item["rule"] for item in result["findings"]},
                    result,
                )

    def test_else_if_chains_stay_flat_and_braceless_nesting_increases(self):
        flat_cpp = "\n".join([
            "int flat() {",
            "  if (a) value++;",
            "  else if (b) value--;",
            "  else if (c) value = 0;",
            "  return value;",
            "}",
            "",
        ])
        flat_python = "\n".join([
            "def flat():",
            "    if a:",
            "        value += 1",
            "    elif b:",
            "        value -= 1",
            "    elif c:",
            "        value = 0",
            "    return value",
            "",
        ])
        nested = "\n".join([
            "int nested() {",
            "  if (a)",
            "    if (b)",
            "      if (c)",
            "        if (d)",
            "          if (e)",
            "            if (f)",
            "              value++;",
            "  return value;",
            "}",
            "",
        ])
        for path, source in (
                ("flat.cpp", flat_cpp), ("flat.py", flat_python)):
            with self.subTest(path=path):
                self.assertEqual(_nesting_depth(path, source), 1)
                self.assertNotIn(
                    "MF-NEST-5",
                    {item["rule"] for item in self.analyze(
                        path, source)["findings"]},
                )
        result = self.analyze("nested.cpp", nested)
        self.assertEqual(_nesting_depth("nested.cpp", nested), 6)
        nesting = [
            item for item in result["findings"]
            if item["rule"] == "MF-NEST-5"
        ]
        self.assertEqual(len(nesting), 1, result)
        self.assertEqual(nesting[0]["actual"], 6, result)

    def test_comment_blank_and_delimiter_only_lines_do_not_count(self):
        lines = ["int safe() {"]
        for index in range(49):
            lines += ["  // explanation", "", "  {", "  }", "  value%d++;" % index]
        lines += ["}"]
        source = "\n".join(lines) + "\n"
        result = self.analyze("safe.cpp", source)
        self.assertNotIn(
            "MF-FUNC-50",
            {item["rule"] for item in result["findings"]},
            result,
        )

    def test_touched_preexisting_threshold_violation_is_reported(self):
        baseline = _nested_braced(
            "int oldDebt(int a, int b, int c, int d, int e, int f) {")
        current_lines = baseline.splitlines()
        current_lines.insert(2, "  // changed explanation only")
        current = "\n".join(current_lines) + "\n"
        result = self.analyze(
            "legacy.cpp", current, changed={3}, baseline=baseline)
        self.assertEqual(
            {item["rule"] for item in result["findings"]},
            {"MF-PARAM-5", "MF-FUNC-50", "MF-NEST-5"},
            result,
        )
        self.assertEqual(result["existing_debt"], [], result)
        for finding in result["findings"]:
            self.assertGreater(finding["baseline"], finding["limit"])
            self.assertTrue(finding["pre_existing"], finding)

    def test_cross_language_changed_logic_reports_every_numeric_literal(self):
        fixtures = (
            ("logic.cpp", "int apply(int value) {\n  return value * 7;\n}\n", 2, "7"),
            ("Logic.java", (
                "class Logic {\n  int apply(int value) {\n"
                "    return value + 30;\n  }\n}\n"), 3, "30"),
            ("Logic.cs", (
                "class Logic {\n  int Apply(int value) {\n"
                "    return value - 42;\n  }\n}\n"), 3, "42"),
            ("logic.js", (
                "function apply(value) {\n  return value * 10;\n}\n"), 2, "10"),
            ("logic.ts", (
                "function apply(value: number) {\n"
                "  return value / 100;\n}\n"), 2, "100"),
            ("logic.py", (
                "def apply(value):\n    return value + 10\n"), 2, "10"),
        )
        for path, source, line, literal in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source, changed={line})
                magic = self.magic_findings(result)
                self.assertEqual(len(magic), 1, result)
                self.assertEqual(magic[0]["line"], line, result)
                self.assertEqual(magic[0]["literal"], literal, result)

    def test_unremarkable_values_zero_one_two_are_never_magic(self):
        """checkstyle 同款白名单:0/1/2 是初始化/自增/二分的通用值,报它只有噪声。

        实弹校准:五毒夹具 58 条发现 54 条魔法数字,大半是 `total = 0`、`i + 1`——
        淹没结构发现并吃光 advisory 的 12 条名额。"""
        source = (
            "def apply(value):\n"
            "    total = 0\n"
            "    total += 1\n"
            "    half = value / 2\n"
            "    return total + half + 9527\n")
        result = self.analyze("noise.py", source, changed={2, 3, 4, 5})
        magic = self.magic_findings(result)
        self.assertEqual(["9527"], [item["literal"] for item in magic], result)

    def test_underscore_prefixed_python_constants_are_exempt(self):
        """实战冤案:模型把魔法数字提成 _PATH_DEPTH_TO_REPO_ROOT = 3(模块私有
        常量的标准写法),旧正则不认前导下划线,常量定义本身继续被报——
        两次修复机会全被建议噪声烧掉,信任白白消耗。"""
        source = (
            "# service/src/demo_service/ 到仓库根的目录层数\n"
            "_PATH_DEPTH_TO_REPO_ROOT = 3\n"
            "__MAX_RETRIES = 7\n"
            "def use(p):\n"
            "    return p.parents[_PATH_DEPTH_TO_REPO_ROOT]\n")
        result = self.analyze("depth.py", source, changed={1, 2, 3, 4, 5})
        self.assertEqual([], self.magic_findings(result), result)

    def test_named_constants_are_extraction_not_magic_number_usage(self):
        fixtures = (
            ("limits.cpp", "constexpr int RETRY_LIMIT = 10;\n"),
            ("Limits.java", (
                "class Limits {\n  static final int RETRY_LIMIT = 10;\n}\n")),
            ("Limits.cs", (
                "class Limits {\n  const int RetryLimit = 10;\n}\n")),
            ("limits.js", "const RETRY_LIMIT = 10;\n"),
            ("limits.ts", "const RETRY_LIMIT: number = 10;\n"),
            ("limits.py", "RETRY_LIMIT = 10\n"),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(self.magic_findings(result), [], result)

    def test_named_constant_expressions_and_object_macros_are_extraction(self):
        fixtures = (
            ("limits.cpp", (
                "constexpr int RETRY_WINDOW = BASE_LIMIT * 100;\n"
                "#define TIMEOUT_MS (5 * 100)\n")),
            ("limits.py", "RETRY_WINDOW = BASE_LIMIT * 100\n"),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(self.magic_findings(result), [], result)

    def test_named_constant_usage_still_reports_direct_literal(self):
        source = (
            "int scale(int value) {\n"
            "  return RETRY_LIMIT * value * 100;\n"
            "}\n")
        result = self.analyze("usage.cpp", source, changed={2})
        self.assertEqual(
            [item["literal"] for item in self.magic_findings(result)],
            ["100"], result)

    def test_constant_initializer_mask_stops_at_same_line_declaration_end(self):
        source = "int f() { const int LIMIT = 5; return LIMIT * 100; }\n"
        result = self.analyze("inline.cpp", source, changed={1})
        self.assertEqual(
            [item["literal"] for item in self.magic_findings(result)],
            ["100"], result)

    def test_multiline_constant_initializer_masks_only_declaration_span(self):
        source = (
            "constexpr int LIMIT =\n"
            "    BASE_LIMIT * 5 *\n"
            "    100;\n"
            "int f() { return LIMIT * 10; }\n")
        result = self.analyze("multiline.cpp", source)
        self.assertEqual(
            [item["literal"] for item in self.magic_findings(result)],
            ["10"], result)

    def test_multiline_python_named_constant_masks_assignment_numbers(self):
        source = (
            "RETRY_WINDOW = (\n"
            "    BASE_LIMIT * 5 * 100\n"
            ")\n"
            "def retry(value):\n"
            "    return value * 10\n")
        result = self.analyze("constants.py", source)
        self.assertEqual(
            [item["literal"] for item in self.magic_findings(result)],
            ["10"], result)

    def test_multiline_python_lowercase_initializer_is_not_a_named_constant(self):
        source = (
            "retry_window = (\n"
            "    base_limit * 5 * 100\n"
            ")\n"
            "def retry(value):\n"
            "    return value * 10\n")
        result = self.analyze("variables.py", source)
        self.assertEqual(
            [item["literal"] for item in self.magic_findings(result)],
            ["5", "100", "10"], result)

    def test_python_constant_ast_byte_columns_align_with_unicode_tokens(self):
        fixtures = (
            ("unicode_assign.py", (
                "LIMIT = (\n"
                "    中文变量名称很长 * 5); x = 10\n")),
            ("unicode_annassign.py", (
                "LIMIT: Final[int] = (\n"
                "    中文变量名称很长 * 5); x = 10\n")),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(
                    [item["literal"] for item in self.magic_findings(result)],
                    ["10"], result)

    def test_enum_members_are_extraction_not_magic_number_usage(self):
        fixtures = (
            ("state.cpp", "enum class State { Ready = 1, Done = 2 };\n"),
            ("State.java", (
                "enum State {\n  Ready(1), Done(2);\n}\n")),
            ("State.cs", "enum State { Ready = 1, Done = 2 }\n"),
            ("state.ts", "enum State { Ready = 1, Done = 2 }\n"),
            ("state.py", (
                "from enum import Enum\nclass State(Enum):\n"
                "    Ready = 1\n    Done = 2\n")),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(self.magic_findings(result), [], result)

    def test_enum_methods_and_enum_typed_functions_still_scan_logic(self):
        fixtures = (
            ("State.java", (
                "enum State {\n  Ready(1);\n"
                "  int scale() { return 100; }\n"
                "  State(int code) {}\n}\n"), 3),
            ("state.cpp", (
                "enum State { Ready = 1 };\n"
                "int scale(enum State state) { return 100; }\n"), 2),
        )
        for path, source, line in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source, changed={line})
                self.assertEqual(
                    [item["literal"] for item in self.magic_findings(result)],
                    ["100"], result)

    def test_enum_return_type_function_is_not_an_enum_declaration(self):
        source = "enum Mode make() { int code = 100; return READY; }\n"
        result = self.analyze("factory.cpp", source, changed={1})
        self.assertEqual(
            [item["literal"] for item in self.magic_findings(result)],
            ["100"], result)

    def test_multiline_enum_member_values_are_masked_but_methods_are_scanned(self):
        fixtures = (
            ("Mode.java", (
                "enum Mode {\n"
                "  A(\n    1\n  );\n"
                "  int code() { return 100; }\n"
                "  Mode(int value) {}\n}\n")),
            ("mode.cpp", (
                "enum class Mode {\n"
                "  A = (\n    1\n  ),\n};\n"
                "int code() { return 100; }\n")),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(
                    [item["literal"] for item in self.magic_findings(result)],
                    ["100"], result)

    def test_same_line_explanation_accepts_magic_number(self):
        fixtures = (
            ("logic.cpp", (
                "int scale(int value) {\n"
                "  return value * 100; // convert ratio to percent\n}\n")),
            ("logic.py", (
                "def scale(value):\n"
                "    return value * 100  # convert ratio to percent\n")),
            ("logic-cn.cpp", (
                "int scale(int value) {\n"
                "  return value * 100; // 转换为百分比\n}\n")),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(self.magic_findings(result), [], result)

    def test_directives_and_pure_comment_labels_do_not_explain_numbers(self):
        comments = ("TODO", "noqa", "NOSONAR", "lint-disable magic-number",
                    "threshold")
        for index, comment in enumerate(comments):
            with self.subTest(comment=comment):
                source = (
                    "int scale_%d(int value) {\n" % index
                    + "  return value * 100; // " + comment + "\n}\n")
                result = self.analyze(
                    "comment_%d.cpp" % index, source, changed={2})
                self.assertEqual(
                    [item["literal"] for item in self.magic_findings(result)],
                    ["100"], result)

    def test_strings_comments_generated_code_and_test_data_are_not_magic(self):
        fixtures = (
            ("text.cpp", (
                "const char* text() {\n  return \"100\";\n}\n"
                "// released 2026-08-02\n")),
            ("text.py", (
                "def text():\n    return \"100\"\n"
                "# released 2026-08-02\n")),
            ("generated/model.cpp", "int value() { return 100; }\n"),
            ("tests/fixtures/data.py", "DATA = [0, 1, 2, 10, 100]\n"),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertEqual(self.magic_findings(result), [], result)

    def test_fixture_words_inside_production_basenames_are_not_test_data(self):
        fixtures = (
            ("ContestDataService.java", (
                "class ContestDataService {\n"
                "  int score() { return 100; }\n}\n")),
            ("FixtureService.cs", (
                "class FixtureService {\n"
                "  int Score() { return 100; }\n}\n")),
        )
        for path, source in fixtures:
            with self.subTest(path=path):
                result = self.analyze(path, source, changed={2})
                self.assertEqual(
                    [item["literal"] for item in self.magic_findings(result)],
                    ["100"], result)

    def test_magic_numbers_only_scan_changed_lines(self):
        source = (
            "int calculate(int value) {\n"
            "  value *= 100;\n"
            "  return value;\n"
            "}\n")
        result = self.analyze("scope.cpp", source, changed={3})
        self.assertEqual(self.magic_findings(result), [], result)

    def test_uncertain_tokenization_fails_open_for_magic_numbers(self):
        source = "int calculate() {\n  return 100; /* unterminated\n}\n"
        result = self.analyze("uncertain.cpp", source, changed={2})
        self.assertEqual(self.magic_findings(result), [], result)

    def test_new_nesting_threshold_crossing_is_reported(self):
        baseline = _nested_braced(
            "int changed(int a) {", depth=5, body_count=0,
            long_return=False)
        current = _nested_braced(
            "int changed(int a) {", depth=6, body_count=0,
            long_return=False)
        result = self.analyze(
            "changed.cpp", current, baseline=baseline)
        self.assertEqual(
            [item["rule"] for item in result["findings"]],
            ["MF-NEST-5"],
            result,
        )
        self.assertEqual(result["findings"][0]["baseline"], 5)

    def test_only_changed_long_lines_are_reported(self):
        old_long = "  int old_line = " + "1 + " * 40 + "0;"
        new_long = "  int new_line = " + "2 + " * 40 + "0;"
        source = "\n".join([
            "int lines() {", old_long, new_long, "  return 0;", "}", "",
        ])
        result = self.analyze("lines.cpp", source, changed={3})
        line_findings = [
            item for item in result["findings"]
            if item["rule"] == "MF-LINE-120"
        ]
        self.assertEqual(len(line_findings), 1, result)
        self.assertEqual(line_findings[0]["line"], 3)

    def test_untouched_bad_function_is_outside_scope(self):
        source = "\n".join([
            "int safe() {", "  return value;", "}", "",
            "int untouched(int a, int b, int c, int d, int e, int f) {",
            *["  if (v%d) v%d++;" % (index, index) for index in range(6)],
            *["  int value%d = %d;" % (index, index) for index in range(45)],
            "  return 0;", "}", "",
        ])
        result = self.analyze("scope.cpp", source, changed={2})
        self.assertEqual(result["findings"], [], result)
        self.assertEqual(result["functions_checked"], 1, result)

    def test_comment_markers_inside_strings_do_not_corrupt_line_classification(self):
        source = "\n".join([
            "const char* text() {",
            '  auto a = \"// not a comment\";',
            '  auto b = R\"tag(/* not a comment */)tag\";',
            "  return a;",
            "}",
            "",
        ])
        result = self.analyze("strings.cpp", source)
        self.assertEqual(result["status"], "CLEAN", result)
        self.assertFalse(result["skipped"], result)

    def test_python_stub_uses_python_parameter_semantics(self):
        source = (
            "class Demo:\n"
            "    def create(cls, a: int, b: int, c: int, d: int, e: int) -> None: ...\n"
        )
        result = self.analyze("demo.pyi", source)
        self.assertNotIn(
            "MF-PARAM-5",
            {item["rule"] for item in result["findings"]},
            result,
        )

    def test_multiline_literal_content_does_not_inflate_function_lines(self):
        content = "\n".join(
            "literal content %d" % index for index in range(55))
        fixtures = {
            "template.py": (
                'def render():\n    value = """\n' + content
                + '\n    """\n    return value\n'),
            "template.js": (
                "function render() {\n  const value = `\n" + content
                + "\n`;\n  return value;\n}\n"),
            "Template.java": (
                'class Template {\n String render() {\n  String value = """\n'
                + content + '\n  """;\n  return value;\n }\n}\n'),
        }
        for path, source in fixtures.items():
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertNotIn(
                    "MF-FUNC-50",
                    {item["rule"] for item in result["findings"]},
                    result,
                )

    def test_javascript_comparison_and_typescript_generics_count_parameters(self):
        comparison = (
            "function compare(a = x < y, b, c, d, e, f) {\n"
            "  return a;\n"
            "}\n")
        result = self.analyze("compare.js", comparison)
        self.assertIn(
            "MF-PARAM-5",
            {item["rule"] for item in result["findings"]},
            result,
        )
        generic = (
            "function safe(value: Map<string, number>, a, b, c, d) {\n"
            "  return value;\n"
            "}\n")
        result = self.analyze("safe.ts", generic)
        self.assertNotIn(
            "MF-PARAM-5",
            {item["rule"] for item in result["findings"]},
            result,
        )

    def test_new_overload_cannot_borrow_existing_overload_debt(self):
        baseline = (
            "int overloaded(int a, int b, int c, int d, int e, int f) {\n"
            "  return a;\n"
            "}\n")
        current = baseline + (
            "int overloaded(int a, int b, int c, int d, int e, int f, int g) {\n"
            "  return a;\n"
            "}\n")
        result = self.analyze(
            "overload.cpp", current, changed={4, 5, 6}, baseline=baseline)
        self.assertEqual(
            [item["actual"] for item in result["findings"]
             if item["rule"] == "MF-PARAM-5"],
            [7],
            result,
        )

    def test_common_module_and_cpp_template_extensions_are_checked(self):
        fixtures = {
            "module.mjs": "function bad(a, b, c, d, e, f) { return a; }\n",
            "module.cjs": "function bad(a, b, c, d, e, f) { return a; }\n",
            "module.mts": (
                "function bad(a: number, b: number, c: number, d: number, "
                "e: number, f: number) { return a; }\n"),
            "module.cts": (
                "function bad(a: number, b: number, c: number, d: number, "
                "e: number, f: number) { return a; }\n"),
            "inline.inl": "int bad(int a,int b,int c,int d,int e,int f) {}\n",
            "inline.ipp": "int bad(int a,int b,int c,int d,int e,int f) {}\n",
            "inline.tpp": "int bad(int a,int b,int c,int d,int e,int f) {}\n",
        }
        for path, source in fixtures.items():
            with self.subTest(path=path):
                result = self.analyze(path, source)
                self.assertIn(
                    "MF-PARAM-5",
                    {item["rule"] for item in result["findings"]},
                    result,
                )

    def test_large_result_returns_capped_findings_instead_of_timing_out(self):
        path = "many.js"
        source = "\n".join(
            "const value_%d = '%s';" % (index, "x" * 130)
            for index in range(500)
        ) + "\n"
        _write(self.root, path, source)
        result = analyze_changed_with_timeout(
            self.root, [path], {path: set(range(1, 501))},
            options={"timeout_seconds": 3})
        self.assertEqual(result["status"], "FINDINGS", result)
        self.assertEqual(len(result["findings"]), MAX_REPORTED_ITEMS)
        self.assertTrue(any(
            "省略 300 项" in item for item in result["skipped"]), result)

    def test_generated_and_unparseable_input_fail_open(self):
        generated = self.analyze(
            "generated/model.cpp",
            "int generated(int a, int b, int c, int d, int e, int f) {}\n")
        self.assertFalse(generated["findings"], generated)
        self.assertTrue(generated["skipped"], generated)
        malformed = self.analyze("broken.py", "def broken(\n")
        self.assertFalse(malformed["findings"], malformed)
        self.assertIn(malformed["status"], ("CLEAN", "SKIPPED"))

    def test_oversized_input_and_isolated_runner_fail_open(self):
        oversized = "// " + ("x" * (MAX_FILE_BYTES + 10))
        result = self.analyze("huge.cpp", oversized)
        self.assertFalse(result["findings"], result)
        self.assertEqual(result["status"], "SKIPPED", result)

        path = "small.py"
        source = "def small(a):\n    return a\n"
        _write(self.root, path, source)
        isolated = analyze_changed_with_timeout(
            self.root, [path], {path: {1, 2}},
            options={"timeout_seconds": 3})
        self.assertEqual(isolated["status"], "CLEAN", isolated)

    def test_report_is_human_readable_and_states_advisory_contract(self):
        result = self.analyze(
            "line.js",
            "const value = '" + ("x" * 130) + "';\n",
        )
        report = render_markdown(result, "test scope")
        self.assertIn("# Mae-Flow 轻量编码预检", report)
        self.assertIn("不替代正式 CodeCheck", report)
        self.assertIn("MF-LINE-120", report)
        self.assertNotIn('{"status"', report)

    def test_cli_reports_findings_but_returns_success(self):
        repo = os.path.join(self.root, "repo")
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "lightcheck@test.invalid"],
            cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.name", "Light Check"],
            cwd=repo, check=True)
        path = "logic.py"
        _write(repo, path, "def safe(a):\n    return a\n")
        subprocess.run(["git", "add", path], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
        _write(
            repo, path,
            "def changed(a, b, c, d, e, f):\n"
            "    return '" + ("x" * 130) + "'\n")
        environment = dict(os.environ)
        environment["PYTHONPYCACHEPREFIX"] = os.path.join(
            self.root, "pycache")
        run = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
             "lightcheck", "--quiet"],
            cwd=repo, text=True, capture_output=True, env=environment,
            timeout=20,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("建议修复，不阻断", run.stderr)
        report = os.path.join(
            repo, ".mae-flow-work", "lightcheck", "latest.md")
        self.assertTrue(os.path.isfile(report))
        with open(report, encoding="utf-8") as stream:
            self.assertIn("MF-PARAM-5", stream.read())

    def test_cli_discovers_changed_csharp_magic_number(self):
        repo = os.path.join(self.root, "csharp-repo")
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "lightcheck@test.invalid"],
            cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.name", "Light Check"],
            cwd=repo, check=True)
        path = "Logic.cs"
        _write(
            repo, path,
            "class Logic {\n  int Apply(int value) {\n"
            "    return value;\n  }\n}\n")
        subprocess.run(["git", "add", path], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
        _write(
            repo, path,
            "class Logic {\n  int Apply(int value) {\n"
            "    return value + 100;\n  }\n}\n")
        environment = dict(os.environ)
        environment["PYTHONPYCACHEPREFIX"] = os.path.join(
            self.root, "csharp-pycache")
        run = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
             "lightcheck", "--quiet"],
            cwd=repo, text=True, capture_output=True, env=environment,
            timeout=20,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("MF-MAGIC-NUMBER", run.stderr)

    def test_deletion_anchor_touches_function_without_scanning_adjacent_magic(self):
        repo = os.path.join(self.root, "deletion-repo")
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "lightcheck@test.invalid"],
            cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.name", "Light Check"],
            cwd=repo, check=True)
        path = "logic.cpp"
        _write(
            repo, path,
            "int calculate(int a, int b, int c, int d, int e, int f) {\n"
            "  return 100;\n"
            "  int removed = 1;\n"
            "}\n")
        subprocess.run(["git", "add", path], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
        _write(
            repo, path,
            "int calculate(int a, int b, int c, int d, int e, int f) {\n"
            "  return 100;\n"
            "}\n")
        environment = dict(os.environ)
        environment["PYTHONPYCACHEPREFIX"] = os.path.join(
            self.root, "deletion-pycache")
        run = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
             "lightcheck", "--quiet"],
            cwd=repo, text=True, capture_output=True, env=environment,
            timeout=20,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        report = os.path.join(
            repo, ".mae-flow-work", "lightcheck", "latest.md")
        with open(report, encoding="utf-8") as stream:
            content = stream.read()
        self.assertIn("MF-PARAM-5", content)
        self.assertNotIn("MF-MAGIC-NUMBER", content)


class InheritedMagicNumberTests(unittest.TestCase):
    """触碰 ≠ 引入:只因在某行加了参数就被要求改那行原有的魔鬼数字,
    与编码基准第 7 条"diff 里只出现需求要求的行"直接打架。实测暴露。"""

    def _findings(self, baseline, current, changed):
        from mae_flow_core.lightcheck_analysis import _ChangedAnalyzer
        path = "svc/a.py"
        analyzer = _ChangedAnalyzer(
            ".", [path], {path: set(changed)},
            {path: baseline},
            current_sources={path: current},
            magic_changed_lines={path: set(changed)},
        )
        # 直接测被改动的那个环节:魔鬼数字上报与继承判定
        analyzer._add_magic_findings(path, current, set(changed))
        return [
            item for item in analyzer.result.get("findings", ())
            if item.get("rule") == "MF-MAGIC-NUMBER"
        ]

    def test_literal_that_predates_the_change_is_not_reported(self):
        baseline = 'def f(a):\n    return {"amount": 100}\n'
        current = 'def f(a, t="d"):\n    return {"t": t, "amount": 100}\n'
        self.assertEqual([], self._findings(baseline, current, [1, 2]))

    def test_newly_introduced_literal_is_still_reported(self):
        baseline = 'def f(a):\n    return 1\n'
        current = 'def f(a):\n    return 1\n\n\ndef ttl(a):\n    return 86400\n'
        findings = self._findings(baseline, current, [5, 6])
        self.assertEqual(1, len(findings), findings)
        self.assertIn("86400", str(findings[0].get("literal")))


if __name__ == "__main__":
    unittest.main()
