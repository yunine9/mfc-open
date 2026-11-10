"""Pure CodeCheck parsing and aggregation policies."""

from dataclasses import dataclass
import os
import re


def _norm(path):
    return str(path).replace("\\", "/")


@dataclass(frozen=True)
class CodeCheckWarning:
    rule: str
    file: str
    line: object = None

    def as_tuple(self):
        return self.rule, self.file, self.line


@dataclass(frozen=True)
class CodeCheckBatch:
    count: int
    warnings: tuple
    command: str

    def __post_init__(self):
        object.__setattr__(
            self, "warnings", tuple(self.warnings))


@dataclass(frozen=True)
class CodeCheckScan:
    total: int
    warnings: tuple
    commands: tuple

    def __post_init__(self):
        object.__setattr__(
            self, "warnings", tuple(self.warnings))
        object.__setattr__(
            self, "commands", tuple(self.commands))


@dataclass(frozen=True)
class CodeCheckScopeReason:
    rule: str
    file: str
    line: object
    reason: str

    def as_record(self):
        return {
            "rule": self.rule,
            "file": self.file,
            "line": self.line,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class CodeCheckScope:
    total: int
    warnings: tuple
    commands: tuple
    log_path: str
    reasons: tuple
    excluded: tuple
    classified: bool

    def __post_init__(self):
        for name in (
                "warnings", "commands",
                "reasons", "excluded"):
            object.__setattr__(
                self, name, tuple(getattr(self, name)))


def parse_count(console, report):
    """Parse only CodeCheck formats that unambiguously state a count."""
    text = (console or "") + "\n" + (report or "")
    numbers = re.findall(
        r"共有\s*(\d+)\s*条告警", text)
    if numbers:
        return int(numbers[-1])
    totals = re.findall(
        r"\|\s*\*{0,2}总计\*{0,2}\s*\|"
        r"\s*\*{0,2}(\d+)\*{0,2}\s*\|",
        text,
    )
    if totals:
        return int(totals[-1])
    details = re.findall(
        r"^###\s+\d+\.\s+\[(?:Critical|Major|Minor|Suggestion|"
        r"致命级|严重级|一般级|提示级)\]",
        text,
        re.M | re.I,
    )
    if details:
        return len(details)
    zero_patterns = (
        r"未发现(?:任何)?(?:代码)?告警",
        r"没有发现(?:任何)?(?:代码)?告警",
        r"(?:告警|问题)(?:总数)?\s*[:：]?\s*0\b",
        r"0\s*条告警",
    )
    completed = (
        "代码检查完成" in text
        or "CodeCheck 检查报告" in text
        or "检查结果汇总" in text
    )
    if completed and any(
            re.search(pattern, text, re.I)
            for pattern in zero_patterns):
        return 0
    return None


def _warning_row(value):
    low = {
        str(key).lower(): item
        for key, item in value.items()
    }
    uid = (
        low.get("uuid")
        or low.get("id")
        or low.get("issueid")
    )
    rule = (
        low.get("rule")
        or low.get("rulename")
        or low.get("ruleid")
    )
    file_name = (
        low.get("file")
        or low.get("filepath")
        or low.get("path")
    )
    if not (uid and rule and file_name):
        return None
    line = None
    for key in (
            "line", "lineno", "linenumber", "startline",
            "beginline", "linenum"):
        try:
            if low.get(key) is not None:
                line = int(low[key])
                break
        except (TypeError, ValueError):
            continue
    return (
        str(uid),
        CodeCheckWarning(
            str(rule).split()[0],
            _norm(str(file_name)),
            line,
        ),
    )


def _json_rows(value, rows):
    if isinstance(value, dict):
        row = _warning_row(value)
        if row is not None:
            rows.append(row)
        for item in value.values():
            _json_rows(item, rows)
    elif isinstance(value, list):
        for item in value:
            _json_rows(item, rows)


def parse_json_result(data):
    """Parse an already-loaded CodeCheck JSON value."""
    rows = []
    _json_rows(data, rows)
    unique = {}
    for uid, warning in rows:
        unique[uid] = warning
    if unique:
        return len(unique), tuple(unique.values())
    if isinstance(data, dict):
        for key in (
                "total", "totalCount",
                "issueCount", "warningCount"):
            if isinstance(data.get(key), int):
                return data[key], ()
    return None, ()


def extract_report_warnings(report):
    """Extract ordered rule/file/line details from a Markdown report."""
    text = report or ""
    files = re.findall(
        r"- \*\*文件\*\*: `([^`]+)`", text)
    rules = re.findall(
        r"- \*\*规则\*\*: (\S+)", text)
    lines = re.findall(
        r"- \*\*(?:行号|位置|行)\*\*:\s*`?(\d+)",
        text,
    )
    if lines and len(lines) == len(rules) == len(files):
        return tuple(
            CodeCheckWarning(rule, file_name, int(line))
            for (rule, file_name), line
            in zip(zip(rules, files), lines)
        )
    return tuple(
        CodeCheckWarning(rule, file_name, None)
        for rule, file_name in zip(rules, files)
    )


def map_warning_paths(warnings, batch):
    """Restore a report path only when it maps to one batch file."""
    mapped = []
    for warning in warnings:
        matches = [
            path for path in batch
            if (
                _norm(path).lower()
                == _norm(warning.file).lower()
                or os.path.basename(path).lower()
                == os.path.basename(warning.file).lower()
            )
        ]
        mapped.append(CodeCheckWarning(
            warning.rule,
            matches[0] if len(matches) == 1
            else _norm(warning.file),
            warning.line,
        ))
    return tuple(mapped)


def aggregate_batches(batches):
    """Aggregate successful batches without changing their order."""
    total = 0
    warnings = []
    commands = []
    for batch in batches:
        total += batch.count
        warnings.extend(batch.warnings)
        commands.append(batch.command)
    return CodeCheckScan(
        total=total,
        warnings=tuple(warnings),
        commands=tuple(commands),
    )


def split_batches(files, maxlen=6000):
    """Split command input by length and ambiguous duplicate basenames."""
    batches = []
    current = []
    length = 0
    names = set()
    for path in files:
        basename = os.path.basename(path).lower()
        if current and (
            length + len(path) + 1 > maxlen
            or basename in names
        ):
            batches.append(tuple(current))
            current = []
            length = 0
            names = set()
        current.append(path)
        names.add(basename)
        length += len(path) + 1
    if current:
        batches.append(tuple(current))
    return tuple(batches)


def _warning_tuple(value):
    return CodeCheckWarning(
        value[0],
        value[1],
        value[2] if len(value) > 2 else None,
    )


def _scope_unclassified(result):
    return CodeCheckScope(
        total=result.get("total", 0),
        warnings=tuple(
            _warning_tuple(pair)
            for pair in result.get("pairs") or []
        ),
        commands=tuple(result.get("commands") or []),
        log_path=result.get("log_path", ""),
        reasons=(),
        excluded=(),
        classified=False,
    )


def _scope_details_complete(result, pairs, changed_lines):
    return bool(
        pairs
        and result.get("total") == len(pairs)
        and all(
            len(pair) >= 3 and pair[2] is not None
            for pair in pairs
        )
        and changed_lines is not None
    )


def scope_is_classifiable(result):
    """Return whether result details can be safely classified by line."""
    return _scope_details_complete(
        result,
        result.get("pairs") or [],
        {},
    )


def classify_scope(
        result, changed_lines, function_ranges, slack):
    """Classify only warnings provably related to changed lines/functions."""
    pairs = result.get("pairs") or []
    if not _scope_details_complete(
            result, pairs, changed_lines):
        return _scope_unclassified(result)
    kept = []
    excluded = []
    reasons = []
    ranges = function_ranges or {}
    for value in pairs:
        warning = _warning_tuple(value)
        normalized = _norm(warning.file)
        window = changed_lines.get(normalized)
        if window is None:
            kept.append(warning)
            reasons.append(CodeCheckScopeReason(
                warning.rule,
                warning.file,
                warning.line,
                "报告路径无法映射，保守纳入",
            ))
            continue
        if any(
                abs(warning.line - changed) <= slack
                for changed in window):
            kept.append(warning)
            reasons.append(CodeCheckScopeReason(
                warning.rule,
                warning.file,
                warning.line,
                "命中本次变更行±%d" % slack,
            ))
            continue
        target = next((
            item for item in ranges.get(normalized, [])
            if (
                item["start"]
                <= warning.line
                <= item["end"]
            )
        ), None)
        if target is None:
            excluded.append(warning)
            continue
        kept.append(warning)
        reasons.append(CodeCheckScopeReason(
            warning.rule,
            warning.file,
            warning.line,
            "位于本次变更函数 %s（行%d-%d）"
            % (
                target["context"],
                target["start"],
                target["end"],
            ),
        ))
    return CodeCheckScope(
        total=len(kept),
        warnings=tuple(kept),
        commands=tuple(result.get("commands") or []),
        log_path=result.get("log_path", ""),
        reasons=tuple(reasons),
        excluded=tuple(excluded),
        classified=True,
    )
