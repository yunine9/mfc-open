"""Pure target, request, and disposition policy for formal CodeCheck."""

from dataclasses import dataclass
import posixpath
import re
from collections.abc import Mapping


_DISPOSITIONS = {
    "fixed",
    "false-positive",
    "existing",
    "out-of-scope",
    "unsafe-now",
}

_DEFAULT_TEST_PATTERNS = tuple(re.compile(pattern, re.I) for pattern in (
    r"(^|/)(tests?|__tests__|spec|[^/]+[_-]tests?)/",
    r"(^|/)src/test/",
    r"(^|/)test_[^/]+\.py$",
    r"(_test|\.test|\.spec)\."
    r"(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|tpp|py|go|rs|"
    r"js|jsx|cjs|mjs|ts|tsx|cts|mts)$",
))
_CAMEL_CASE_TEST_NAME = re.compile(
    r"(^|/)[^/]*Tests?\."
    r"(?i:c|cc|cpp|cxx|h|hh|hpp|hxx|java|kt|cs)$")


def _path(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("target paths must be non-empty strings")
    normalized = posixpath.normpath(value.strip().replace("\\", "/"))
    if normalized == ".":
        raise ValueError("target paths must identify a file")
    return normalized


def _not_text_iterable(value, field):
    if isinstance(value, (str, bytes)):
        raise TypeError("%s must be an iterable, not raw text" % field)
    try:
        return tuple(value)
    except TypeError as exc:
        raise TypeError("%s must be iterable" % field) from exc


def _unique(values, key=lambda item: item):
    result = []
    seen = set()
    for value in values:
        identity = key(value)
        if identity not in seen:
            seen.add(identity)
            result.append(value)
    return tuple(result)


def _target_function(value):
    row = _not_text_iterable(value, "function target")
    if len(row) != 2:
        raise ValueError("function targets must contain file and function")
    path = _path(row[0])
    function = row[1]
    if not isinstance(function, str) or not function.strip():
        raise ValueError("function target names must be non-empty strings")
    return path, function.strip()


@dataclass(frozen=True)
class CodeCheckTarget:
    """Exact changed production files and the touched functions we can name."""

    files: tuple
    functions: tuple

    def __post_init__(self):
        files = _unique(
            _path(value)
            for value in _not_text_iterable(self.files, "files")
        )
        functions = _unique(
            _target_function(value)
            for value in _not_text_iterable(self.functions, "functions")
        )
        file_set = set(files)
        if any(path not in file_set for path, _name in functions):
            raise ValueError("every function target must belong to a target file")
        object.__setattr__(self, "files", files)
        object.__setattr__(self, "functions", functions)


@dataclass(frozen=True)
class CodeCheckDisposition:
    """The Agent's explicit destination for one structured finding."""

    identity: str
    status: str
    reason: str

    def __post_init__(self):
        if not isinstance(self.identity, str) or not self.identity.strip():
            raise ValueError("disposition identity must be a non-empty string")
        if not isinstance(self.status, str) or self.status not in _DISPOSITIONS:
            raise ValueError("unsupported CodeCheck disposition status")
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("disposition reason must be a non-empty string")
        object.__setattr__(self, "identity", self.identity.strip())
        object.__setattr__(self, "reason", self.reason.strip())


def _default_test_path(path):
    return bool(
        _CAMEL_CASE_TEST_NAME.search(path)
        or any(pattern.search(path) for pattern in _DEFAULT_TEST_PATTERNS)
    )


def _is_test(path, classifier):
    if classifier is None:
        return _default_test_path(path)
    try:
        return bool(classifier(path))
    except Exception:
        return False


def _mapping_entries(mapping):
    if mapping is None:
        return ()
    entries = []
    for raw_path, value in mapping.items():
        try:
            normalized = _path(raw_path)
        except ValueError:
            continue
        entries.append((normalized, value))
    return tuple(entries)


def _normalized_mapping_value(mapping, path, changed_paths):
    entries = _mapping_entries(mapping)
    exact = [value for normalized, value in entries if normalized == path]
    if len(exact) == 1:
        return exact[0]
    if exact:
        return None
    wanted = path.casefold()
    changed_identities = {
        candidate for candidate in changed_paths
        if candidate.casefold() == wanted
    }
    matches = [
        value for normalized, value in entries
        if normalized.casefold() == wanted
    ]
    range_identities = {
        normalized for normalized, _value in entries
        if normalized.casefold() == wanted
    }
    if len(changed_identities) != 1 or len(range_identities) != 1:
        return None
    return matches[0] if len(matches) == 1 else None


def _changed_line_numbers(value):
    if value is None or isinstance(value, (str, bytes)):
        return None
    try:
        values = tuple(value)
    except TypeError:
        return None
    lines = set()
    for item in values:
        line = _line_number(item)
        if line is None or line < 1:
            return None
        lines.add(line)
    return lines


def _line_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value.strip()):
        return int(value.strip())
    return None


def _range_value(value, *names):
    for name in names:
        if isinstance(value, Mapping) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return None


def _range_name(value):
    for field in ("long_name", "name", "context"):
        candidate = _range_value(value, field)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def _range_identity(value):
    start = _line_number(_range_value(value, "start_line", "start"))
    end = _line_number(_range_value(value, "end_line", "end"))
    if start is None or end is None:
        return None
    if start < 1 or end < start:
        return None
    name = _range_name(value)
    if not name:
        return None
    return start, end, name


def _touched_functions(path, changed, ranges):
    if changed is None or ranges is None or isinstance(ranges, (str, bytes)):
        return ()
    try:
        ranges = tuple(ranges)
    except TypeError:
        return ()
    targets = []
    for value in ranges:
        identity = _range_identity(value)
        if identity is None:
            continue
        start, end, name = identity
        if any(start <= line <= end for line in changed):
            targets.append((path, name))
    return _unique(targets)


def build_codecheck_target(
        changed_lines, function_ranges, is_test_path=None):
    """Build exact scope from repository facts without reading tool output.

    ``changed_lines`` keys are the changed-file fact. Missing or uncertain
    function facts never remove such a file; they only omit its function-level
    refinement.
    """
    if not isinstance(changed_lines, Mapping):
        raise TypeError("changed_lines must be a path-to-lines mapping")
    if function_ranges is not None and not isinstance(function_ranges, Mapping):
        raise TypeError("function_ranges must be a path-to-ranges mapping")
    if is_test_path is not None and not callable(is_test_path):
        raise TypeError("is_test_path must be callable")
    changed_items = tuple(
        (_path(raw_path), raw_lines)
        for raw_path, raw_lines in changed_lines.items()
    )
    changed_paths = tuple(path for path, _lines in changed_items)
    files = []
    functions = []
    seen = set()
    for path, raw_lines in changed_items:
        if path in seen or _is_test(path, is_test_path):
            continue
        seen.add(path)
        files.append(path)
        changed = _changed_line_numbers(raw_lines)
        ranges = _normalized_mapping_value(
            function_ranges, path, changed_paths)
        functions.extend(_touched_functions(path, changed, ranges))
    return CodeCheckTarget(tuple(files), tuple(functions))


def record_dispositions(finding_identities, dispositions):
    """Validate complete destinations, or accept an explicit raw-only result."""
    rows = _not_text_iterable(dispositions, "dispositions")
    if finding_identities is None:
        if rows:
            raise ValueError("raw-output-only results cannot invent findings")
        return ()
    identities = _not_text_iterable(finding_identities, "finding identities")
    if any(
            not isinstance(identity, str) or not identity.strip()
            for identity in identities):
        raise ValueError("finding identities must be non-empty strings")
    identities = tuple(identity.strip() for identity in identities)
    if len(set(identities)) != len(identities):
        raise ValueError("structured finding identities must be unique")
    if any(not isinstance(row, CodeCheckDisposition) for row in rows):
        raise TypeError("dispositions must contain CodeCheckDisposition values")
    by_identity = {row.identity: row for row in rows}
    if len(by_identity) != len(rows):
        raise ValueError("each structured finding needs exactly one disposition")
    if set(by_identity) != set(identities):
        raise ValueError("every structured finding needs one disposition")
    return tuple(by_identity[identity] for identity in identities)


def _request_lines(values, empty):
    return ["- " + value for value in values] or ["- " + empty]


def render_codecheck_request(target, skill_identity=""):
    """Render one configured advisory Skill request without executing it."""
    if not isinstance(target, CodeCheckTarget):
        raise TypeError("target must be a CodeCheckTarget")
    if not isinstance(skill_identity, str):
        raise TypeError("skill_identity must be a string")
    skill = skill_identity.strip() or "configured CodeCheck Skill"
    lines = [
        "Invoke %s exactly once in advisory mode." % skill,
        "Use only this precise changed production scope.",
        "Files:",
    ]
    lines.extend(_request_lines(target.files, "(none)"))
    lines.append("Functions:")
    lines.extend(_request_lines(
        ("%s :: %s" % value for value in target.functions),
        "(no reliable function refinement; retain the file targets)",
    ))
    lines.extend((
        "Treat the return as opaque. A raw-output-only result is allowed; "
        "do not parse warning counts, line counts, PASS/FAIL, or private formats.",
        "Unknown or failed results fail open and must not gate delivery.",
        "For every structured finding the Agent elects to enumerate, record "
        "fixed, false-positive, existing, out-of-scope, or unsafe-now with a reason.",
        "Do not modify source code. Do not launch a fixer.",
        "Do not schedule a recheck after later source changes; summarize their "
        "impact at Delivery only.",
    ))
    return "\n".join(lines)
