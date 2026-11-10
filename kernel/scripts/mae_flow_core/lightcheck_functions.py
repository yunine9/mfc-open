"""Function discovery, matching, and finding construction for Lightcheck."""

from .lightcheck_source import (
    FUNCTION_LINE_LIMIT, NESTING_LIMIT, PARAMETER_LIMIT, _normalized, re,
)

def _quoted_step(char, quote_state):
    quote, escaped = quote_state
    if escaped:
        return quote, False
    if char == "\\":
        return quote, True
    if char == quote:
        return "", False
    return quote, False


class _ParenthesisCollector:
    def __init__(self):
        self.depth = 0
        self.quote = ""
        self.escaped = False
        self.content = []

    def consume(self, char):
        if self.quote:
            self.content.append(char)
            state = _quoted_step(char, (self.quote, self.escaped))
            self.quote, self.escaped = state
            return False
        if char in ('"', "'", "`"):
            self.quote = char
            self.content.append(char)
            return False
        if char == "(":
            self.depth += 1
            self.content.append(char)
            return False
        if char != ")":
            self.content.append(char)
            return False
        return self._close()

    def _close(self):
        if self.depth == 0:
            return True
        self.depth -= 1
        self.content.append(")")
        return False

    def collect(self, fragment):
        for char in fragment:
            if self.consume(char):
                return "".join(self.content).strip()
        return None


def _parenthesized_content(fragment):
    opening = fragment.find("(")
    if opening < 0:
        return None
    return _ParenthesisCollector().collect(fragment[opening + 1:])


_OPEN_TO_CLOSE = {"(": ")", "{": "}", "[": "]", "<": ">"}


class _ParameterCounter:
    def __init__(self):
        self.count = 1
        self.stack = []
        self.quote = ""
        self.escaped = False

    def consume(self, char):
        if self.quote:
            state = _quoted_step(char, (self.quote, self.escaped))
            self.quote, self.escaped = state
            return
        if char in ('"', "'", "`"):
            self.quote = char
            return
        self._consume_delimiter(char)

    def _consume_delimiter(self, char):
        if char in _OPEN_TO_CLOSE:
            self.stack.append(_OPEN_TO_CLOSE[char])
            return
        if self._closes_stack(char):
            self.stack.pop()
            return
        if char != ",":
            return
        if not self.stack:
            self.count += 1

    def _closes_stack(self, char):
        return bool(self.stack) and char == self.stack[-1]


def _top_level_parameter_count(value):
    if not value:
        return 0
    counter = _ParameterCounter()
    for index, char in enumerate(value):
        if char == "<" and not _type_angle_open(value, index):
            continue
        counter.consume(char)
    return counter.count


def _type_angle_open(value, index):
    """Recognize formatter-style TypeScript generic brackets, not `x < y`."""
    if not _type_angle_prefix(value, index):
        return False
    return _has_balanced_angle(value[index + 1:])


def _type_angle_prefix(value, index):
    if index < 1:
        return False
    previous = value[index - 1]
    return not previous.isspace() and bool(re.match(r"[\w\]>.]", previous))


def _has_balanced_angle(fragment):
    depth = 1
    for char in fragment:
        if char == "<":
            depth += 1
        elif char == ">":
            depth -= 1
            if depth == 0:
                return True
    return False


def _js_parameter_count(source, function):
    """Count JS/TS formal parameters without expanding destructuring fields."""
    lines = source.splitlines(True)
    start = max(0, int(function.start_line or 1) - 1)
    fragment = "".join(lines[start:start + 30])[:12000]
    content = _parenthesized_content(fragment)
    if content is None:
        # Parenthesis-free arrow functions are represented correctly by
        # Lizard, so retaining that count is safer than guessing.
        return function.parameter_count
    return _top_level_parameter_count(content)


def _parameter_count(path, source, function):
    parameters = list(function.parameters)
    if path.lower().endswith((".py", ".pyi")):
        if parameters and parameters[0] in ("self", "cls"):
            parameters = parameters[1:]
        return len(parameters)
    if path.lower().endswith((".js", ".jsx", ".ts", ".tsx")):
        return _js_parameter_count(source, function)
    return function.parameter_count


def _function_metrics(path, source, function, code_lines):
    parameter_count = _parameter_count(path, source, function)
    if parameter_count is None:
        return None
    if code_lines is None:
        return None
    start = max(1, int(function.start_line or 1))
    end = max(start, int(function.end_line or start))
    return {
        "parameter_count": parameter_count,
        "effective_lines": len(code_lines.intersection(range(start, end + 1))),
        "control_nesting": int(function.max_control_nesting),
    }


def _function_start(function):
    value = function.start_line
    return int(value) if value else 0


def _function_signature(function):
    return re.sub(r"\s+", "", str(
        getattr(function, "long_name", "") or ""))


def _pair_by_nearest(current, baseline, matches):
    remaining = list(baseline)
    for function in sorted(current, key=_function_start):
        if not remaining:
            return
        match = min(remaining, key=lambda item: abs(
            _function_start(item) - _function_start(function)))
        matches[id(function)] = match
        remaining.remove(match)


def _take_exact_baseline(function, unused):
    exact = [
        item for item in unused
        if item.name == function.name
        and _function_signature(item) == _function_signature(function)
    ]
    if not exact:
        return None
    return min(exact, key=lambda item: abs(
        _function_start(item) - _function_start(function)))


def _match_exact_functions(current_functions, baseline_functions):
    matches = {}
    unused = list(baseline_functions)
    for function in current_functions:
        match = _take_exact_baseline(function, unused)
        if match is not None:
            matches[id(function)] = match
            unused.remove(match)
    return matches, unused


def _unmatched_named_functions(name, functions, matches):
    return [
        item for item in functions
        if item.name == name and id(item) not in matches
    ]


def _named_functions(name, functions):
    return [
        item for item in functions
        if item.name == name
    ]


def _remove_used_baselines(unused, matches):
    used = {id(item) for item in matches.values()}
    unused[:] = [
        item for item in unused
        if id(item) not in used
    ]


def _match_remaining_name(name, current_functions, unused, matches):
    current = _unmatched_named_functions(
        name, current_functions, matches)
    if not current:
        return
    baseline = _named_functions(name, unused)
    if len(current) > len(baseline):
        return
    _pair_by_nearest(current, baseline, matches)
    _remove_used_baselines(unused, matches)


def _baseline_matches(current_functions, baseline_functions):
    """Build a one-to-one map so a new overload cannot borrow old debt."""
    matches, unused = _match_exact_functions(
        current_functions, baseline_functions)
    names = {item.name for item in current_functions}
    for name in names:
        _match_remaining_name(
            name, current_functions, unused, matches)
    return matches


def _finding(rule, path, line, actual, details):
    return {
        "rule": rule,
        "file": _normalized(path),
        "line": int(line),
        "function": details.get("function", ""),
        "actual": int(actual),
        "limit": int(details["limit"]),
        "message": details["message"],
    }


def _mark_pre_existing(item, baseline):
    item["baseline"] = int(baseline)
    item["pre_existing"] = True
    item["message"] += "（基线已存在，因本次触及函数纳入处置）"
    return item


_FUNCTION_RULES = (
    ("MF-PARAM-5", "parameter_count", PARAMETER_LIMIT, "函数入参超过 5 个"),
    ("MF-FUNC-50", "effective_lines", FUNCTION_LINE_LIMIT,
     "函数有效代码行超过 50 行"),
    ("MF-NEST-5", "control_nesting", NESTING_LIMIT,
     "函数控制结构嵌套深度超过 5"),
)


def _empty_result(status="CLEAN", skipped=None, duration_ms=0):
    return {
        "status": status,
        "findings": [],
        "existing_debt": [],
        "skipped": list(skipped or []),
        "files": [],
        "functions_checked": 0,
        "duration_ms": int(duration_ms),
    }


def _valid_line_number(line_number, source_lines):
    return line_number >= 1 and line_number <= len(source_lines)
