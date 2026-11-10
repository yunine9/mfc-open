"""Advisory, changed-code-only quality checks used before formal CodeCheck.

This module intentionally has no gate semantics.  It reports only high
confidence findings, skips uncertain/generated input, and lets every caller
fail open. Function discovery comes from the pinned Lizard runtime; Mae-Flow
owns structural nesting, changed-scope, effective-line and reporting semantics.
"""

from __future__ import annotations

import ast
import multiprocessing
import os
import re
import sys
import time
import tokenize
from dataclasses import dataclass
from io import StringIO

from mae_flow_core.foundation import source_paths


PARAMETER_LIMIT = 5
FUNCTION_LINE_LIMIT = 50
NESTING_LIMIT = 5
LINE_LENGTH_LIMIT = 120
TAB_WIDTH = 4
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MAX_FILES = 100
MAX_REPORTED_ITEMS = 200

# 同上:口径在 foundation/source_paths,这里只转发。
SUPPORTED_EXTENSIONS = source_paths.CODE_EXTENSIONS

# 只留本模块特有的"生成代码"判据。依赖目录与产物目录那部分已经收拢到
# foundation/source_paths(见 _generated_path)——这里原本是第四份手抄清单,
# 而且抄漏了一档:没有 .venv/site-packages/__pycache__,于是 Python 虚拟环境里
# 的三方代码会被当成本单源码去报复杂度告警。
_GENERATED_PATH_PARTS = {"generated", "gen", "third-party"}
_GENERATED_MARKERS = re.compile(
    r"(?i)(?:@generated|auto[- ]generated|generated code|do not edit|"
    r"automatically generated)")
_DELIMITER_ONLY = re.compile(r"^[{}\[\]();,]+$")


@dataclass(frozen=True)
class _ClassifiedLine:
    code: str
    comment: str = ""


def _load_lizard():
    vendor = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", "runtime", "vendor", "lizard"))
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    import lizard  # pylint: disable=import-outside-toplevel
    return lizard


def _normalized(path):
    return str(path or "").replace("\\", "/").lstrip("./")


def _generated_path(path):
    """不该被当成本单源码去查复杂度的文件:三方依赖、构建产物、生成代码。

    前两类的口径来自 foundation/source_paths,与任务卡、面板、范围推导共用
    同一份——这个概念曾经在四个文件里各有一份手抄清单,补一处漏一处。
    """
    value = _normalized(path)
    parts = {part.lower() for part in value.split("/")}
    name = os.path.basename(value).lower()
    return bool(
        source_paths.is_tool_managed_path(value)
        or source_paths.is_derived_path(value)
        or parts & _GENERATED_PATH_PARTS
        or name.endswith((".min.js", ".min.css"))
        or ".generated." in name
    )


def _looks_generated(source):
    return bool(_GENERATED_MARKERS.search("\n".join(source.splitlines()[:12])))


def _python_code_lines(source):
    """Return lines containing Python code, excluding comments and docstrings."""
    code_lines = _python_token_lines(source)
    if code_lines is None:
        return None
    return code_lines - _python_doc_lines(source)


def _is_docstring_statement(node):
    value = getattr(node, "value", None)
    return isinstance(node, ast.Expr) and isinstance(
        value, ast.Constant) and isinstance(value.value, str)


def _parse_python_tree(source):
    try:
        return ast.parse(source)
    except (SyntaxError, ValueError):
        return None


def _first_docstring(body):
    if not isinstance(body, list):
        return None
    if not body:
        return None
    return body[0] if _is_docstring_statement(body[0]) else None


def _python_doc_lines(source):
    doc_lines = set()
    tree = _parse_python_tree(source)
    if tree is None:
        return set()
    for node in ast.walk(tree):
        first = _first_docstring(getattr(node, "body", None))
        if first is not None:
            doc_lines.update(range(
                first.lineno, getattr(first, "end_lineno", first.lineno) + 1))
    return doc_lines


def _python_token_lines(source):
    code_lines = set()
    ignored = {
        tokenize.ENCODING, tokenize.ENDMARKER, tokenize.INDENT,
        tokenize.DEDENT, tokenize.NEWLINE, tokenize.NL, tokenize.COMMENT,
    }
    try:
        tokens = list(tokenize.generate_tokens(StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return None
    for token in tokens:
        code_lines.update(_python_token_code_lines(token, ignored))
    return code_lines


def _python_token_code_lines(token, ignored):
    if token.type in ignored or not token.string.strip():
        return set()
    if token.type == tokenize.STRING and token.end[0] > token.start[0]:
        return {token.start[0], token.end[0]}
    return set(range(token.start[0], token.end[0] + 1))


class _CLikeScanner:
    """Small state machine for code-vs-comment line classification."""

    def __init__(self):
        self.in_block_comment = False
        self.quote = ""
        self.raw_end = ""
        self.escaped = False
        self.comment = []

    def _consume_raw(self, raw_line, index, visible):
        marker = self.raw_end
        end = raw_line.find(marker, index)
        if end < 0:
            return len(raw_line)
        visible.append("x")
        self.raw_end = ""
        return end + len(marker)

    def _consume_block_comment(self, raw_line, index):
        end = raw_line.find("*/", index)
        if end < 0:
            self.comment.append(raw_line[index:])
            return len(raw_line)
        self.comment.append(raw_line[index:end])
        self.in_block_comment = False
        return end + 2

    def _consume_quote(self, raw_line, index, visible):
        char = raw_line[index]
        if self.escaped:
            self.escaped = False
        elif char == "\\":
            self.escaped = True
        elif char == self.quote:
            self.quote = ""
            visible.append("x")
        return index + 1

    def _consume_plain(self, raw_line, index, visible):
        raw_match = re.match(
            r'(?:u8|u|U|L)?R"([^ ()\\\t]{0,16})\(', raw_line[index:])
        if raw_match:
            visible.append("x")
            self.raw_end = ")" + raw_match.group(1) + '"'
            return index + raw_match.end()
        token = raw_line[index:index + 2]
        if token == "//":
            self.comment.append(raw_line[index + 2:])
            return len(raw_line)
        if token == "/*":
            self.in_block_comment = True
            return index + 2
        char = raw_line[index]
        if char in ('"', "'", "`"):
            self.quote = char
            visible.append("x")
            return index + 1
        visible.append(char)
        return index + 1

    def classify_line(self, raw_line):
        index = 0
        visible = []
        self.comment = []
        while index < len(raw_line):
            index = self._consume_state(raw_line, index, visible)
        return _ClassifiedLine(
            "".join(visible), " ".join(self.comment).strip())

    def scan_line(self, raw_line):
        classified = self.classify_line(raw_line)
        compact = re.sub(r"\s+", "", classified.code)
        return compact if compact else ""

    def _consume_state(self, raw_line, index, visible):
        if self.raw_end:
            return self._consume_raw(raw_line, index, visible)
        if self.in_block_comment:
            return self._consume_block_comment(raw_line, index)
        if self.quote:
            return self._consume_quote(raw_line, index, visible)
        return self._consume_plain(raw_line, index, visible)

    def incomplete(self):
        return bool(self.in_block_comment or self.raw_end or self.quote)


def _effective_compact_line(compact):
    if not compact:
        return False
    return not _DELIMITER_ONLY.fullmatch(compact)


def _clike_code_lines(source):
    """Lex comments/strings conservatively and return lines with real code."""
    code_lines = set()
    scanner = _CLikeScanner()
    for number, raw_line in enumerate(source.splitlines(), 1):
        compact = scanner.scan_line(raw_line)
        if _effective_compact_line(compact):
            code_lines.add(number)
    if scanner.incomplete():
        return None
    return code_lines


def _python_classified_lines(source):
    parts = {}
    comments = {}
    ignored = {
        tokenize.ENCODING, tokenize.ENDMARKER, tokenize.INDENT,
        tokenize.DEDENT, tokenize.NEWLINE, tokenize.NL, tokenize.STRING,
    }
    try:
        tokens = list(tokenize.generate_tokens(StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return None
    for token in tokens:
        line = token.start[0]
        if token.type == tokenize.COMMENT:
            comments[line] = token.string.lstrip("#").strip()
        elif token.type not in ignored and token.string.strip():
            parts.setdefault(line, []).append(token.string)
    return {
        line: _ClassifiedLine(
            " ".join(parts.get(line, [])), comments.get(line, ""))
        for line in set(parts) | set(comments)
    }


def _clike_classified_lines(source):
    scanner = _CLikeScanner()
    result = {}
    for number, raw_line in enumerate(source.splitlines(), 1):
        result[number] = scanner.classify_line(raw_line)
    return None if scanner.incomplete() else result


def _classified_lines(path, source):
    """Return string/comment-free line facts, or None when lexing is unsure."""
    if path.lower().endswith((".py", ".pyi")):
        return _python_classified_lines(source)
    return _clike_classified_lines(source)


def _code_lines(path, source):
    if path.lower().endswith((".py", ".pyi")):
        return _python_code_lines(source)
    return _clike_code_lines(source)
