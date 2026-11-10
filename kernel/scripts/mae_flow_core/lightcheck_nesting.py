"""Maximum structural control-nesting measurement for Lightcheck."""

from __future__ import annotations

import ast


_PYTHON_EXTENSIONS = (".py", ".pyi")
_HEAD_CONTROLS = {"if", "for", "foreach", "while", "switch", "catch"}
_TRY_FOLLOWERS = {"catch", "finally"}


def _function_fragment(source, function):
    lines = source.splitlines(True)
    start = max(0, int(function.start_line or 1) - 1)
    end = max(start + 1, int(function.end_line or start + 1))
    return "".join(lines[start:end])


def _meaningful_tokens(lizard, path, fragment):
    reader_type = lizard.get_reader_for(path)
    if reader_type is None:
        return []
    context = lizard.FileInfoBuilder(path)
    reader = reader_type(context)
    tokens = reader.generate_tokens(fragment)
    if hasattr(reader, "preprocess"):
        tokens = reader.preprocess(tokens)
    return [
        token for token in tokens
        if token and not token.isspace()
        and not token.startswith("//")
        and not token.startswith("/*")
    ]


class _ControlNestingParser:
    """Parse statement shape only; expressions and decision counts are ignored."""

    def __init__(self, tokens):
        self.tokens = tokens
        self.maximum = 0

    def measure(self):
        opening = self._find_function_body()
        if opening is None:
            return 0
        self._sequence(opening + 1, 0)
        return self.maximum

    def _find_function_body(self):
        parentheses = 0
        brackets = 0
        for index, token in enumerate(self.tokens):
            parentheses += (token == "(") - (token == ")")
            brackets += (token == "[") - (token == "]")
            if token == "{" and parentheses == 0 and brackets == 0:
                return index
        return None

    def _sequence(self, index, depth):
        while index < len(self.tokens) and self.tokens[index] != "}":
            if self.tokens[index] in {"case", "default"}:
                index = self._skip_label(index)
            else:
                next_index = self._statement(index, depth)
                index = next_index if next_index > index else index + 1
        return index + 1 if index < len(self.tokens) else index

    def _statement(self, index, depth):
        token = self.tokens[index]
        if token == "{":
            return self._sequence(index + 1, depth)
        if token == "if":
            return self._if_statement(index, depth)
        if token == "try":
            return self._try_statement(index, depth)
        if token == "do":
            return self._do_statement(index, depth)
        if token in _HEAD_CONTROLS:
            return self._headed_statement(index, depth)
        if token in {"else", "finally"}:
            return self._body(index + 1, depth)
        return self._plain_statement(index)

    def _enter(self, depth):
        level = depth + 1
        self.maximum = max(self.maximum, level)
        return level

    def _if_statement(self, index, depth):
        level = self._enter(depth)
        body = self._after_head(index + 1)
        index = self._body(body, level)
        if index >= len(self.tokens) or self.tokens[index] != "else":
            return index
        alternative = index + 1
        if alternative < len(self.tokens) and self.tokens[alternative] == "if":
            return self._if_statement(alternative, depth)
        return self._body(alternative, level)

    def _try_statement(self, index, depth):
        level = self._enter(depth)
        index = self._body(index + 1, level)
        while index < len(self.tokens) and self.tokens[index] in _TRY_FOLLOWERS:
            follower = self.tokens[index]
            index += 1
            if follower == "catch":
                index = self._after_head(index)
            index = self._body(index, level)
        return index

    def _do_statement(self, index, depth):
        level = self._enter(depth)
        index = self._body(index + 1, level)
        if index < len(self.tokens) and self.tokens[index] == "while":
            index = self._after_head(index + 1)
            if index < len(self.tokens) and self.tokens[index] == ";":
                index += 1
        return index

    def _headed_statement(self, index, depth):
        level = self._enter(depth)
        return self._body(self._after_head(index + 1), level)

    def _after_head(self, index):
        if index < len(self.tokens) and self.tokens[index] == "(":
            return self._after_balanced(index, "(", ")")
        return index

    def _body(self, index, depth):
        if index >= len(self.tokens):
            return index
        if self.tokens[index] == "{":
            return self._sequence(index + 1, depth)
        return self._statement(index, depth)

    def _plain_statement(self, index):
        pairs = {"(": ")", "[": "]", "{": "}"}
        stack = []
        while index < len(self.tokens):
            token = self.tokens[index]
            if token in pairs:
                stack.append(pairs[token])
            elif stack and token == stack[-1]:
                stack.pop()
            elif not stack and token in {";", "}"}:
                return index + (token == ";")
            index += 1
        return index

    def _after_balanced(self, index, opening, closing):
        depth = 0
        while index < len(self.tokens):
            token = self.tokens[index]
            depth += (token == opening) - (token == closing)
            index += 1
            if depth == 0:
                break
        return index

    def _skip_label(self, index):
        while index < len(self.tokens) and self.tokens[index] != ":":
            index += 1
        return min(index + 1, len(self.tokens))


def _python_statements(statements, depth):
    maximum = depth
    for statement in statements:
        maximum = max(maximum, _python_statement(statement, depth))
    return maximum


def _python_if(statement, depth):
    level = depth + 1
    maximum = max(level, _python_statements(statement.body, level))
    if len(statement.orelse) == 1 and isinstance(statement.orelse[0], ast.If):
        return max(maximum, _python_if(statement.orelse[0], depth))
    return max(maximum, _python_statements(statement.orelse, level))


def _python_statement(statement, depth):
    if isinstance(statement, ast.If):
        return _python_if(statement, depth)
    loops = (ast.For, ast.AsyncFor, ast.While)
    if isinstance(statement, loops):
        level = depth + 1
        return max(
            level,
            _python_statements(statement.body, level),
            _python_statements(statement.orelse, level),
        )
    with_nodes = (ast.With, ast.AsyncWith)
    if isinstance(statement, with_nodes):
        level = depth + 1
        return max(level, _python_statements(statement.body, level))
    try_nodes = tuple(
        item for item in (ast.Try, getattr(ast, "TryStar", None)) if item)
    if isinstance(statement, try_nodes):
        return _python_try(statement, depth)
    if hasattr(ast, "Match") and isinstance(statement, ast.Match):
        level = depth + 1
        bodies = [_python_statements(case.body, level)
                  for case in statement.cases]
        return max([level] + bodies)
    return depth


def _python_try(statement, depth):
    level = depth + 1
    values = [
        level,
        _python_statements(statement.body, level),
        _python_statements(statement.orelse, level),
        _python_statements(statement.finalbody, level),
    ]
    values.extend(
        _python_statements(handler.body, level)
        for handler in statement.handlers)
    return max(values)


def _python_functions(source):
    tree = ast.parse(source)
    return [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]


def _annotate_python(source, functions):
    nodes = _python_functions(source)
    by_line = {node.lineno: node for node in nodes}
    for function in functions:
        node = by_line.get(int(function.start_line or 0))
        function.max_control_nesting = (
            _python_statements(node.body, 0) if node is not None else 0)


def _annotate_braced(lizard, path, source, functions):
    for function in functions:
        fragment = _function_fragment(source, function)
        tokens = _meaningful_tokens(lizard, path, fragment)
        function.max_control_nesting = _ControlNestingParser(tokens).measure()


def annotate_control_nesting(lizard, path, source, functions):
    """Attach maximum control nesting to each parsed function."""
    if path.lower().endswith(_PYTHON_EXTENSIONS):
        _annotate_python(source, functions)
    else:
        _annotate_braced(lizard, path, source, functions)
