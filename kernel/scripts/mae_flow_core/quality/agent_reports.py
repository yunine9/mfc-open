"""Pure parsing for flexible Agent final reports."""

import re


# AC_COVERAGE stays only as a legacy delimiter so an old report cannot make
# the preceding field absorb its text. No contract validates its content.
REPORT_FIELDS = (
    "TASK_CARD_SHA256", "GENERATOR_USED", "EXECUTED_UT",
    "EXECUTED_BUILD", "EXECUTED_COMMAND", "TESTS_TOTAL",
    "TESTS_PASSED", "TESTS_FAILED", "AC_COVERAGE",
    "PENDING_QUESTIONS", "KNOWN_FAILURES", "SUSPECTED_BUGS",
    "FOUND", "FIXED", "REMAINING_COUNT", "STAGE", "GAPS_FOUND",
    "MISSING_BRANCHES",
)


def report_field(report, name):
    """Read a flexible field without requiring one field per line."""
    fields = "|".join(re.escape(field) for field in REPORT_FIELDS)
    match = re.search(
        r"(?:^|(?<=[\s,;]))(?:[-*]\s*)?" + re.escape(name)
        + r"\s*:\s*(.*?)(?=(?:\s+|,\s*)(?:[-*]\s*)?(?:"
        + fields + r")\s*:|\Z)",
        report,
        re.I | re.S,
    )
    return match.group(1).strip(" \t\r\n`") if match else None


def report_number(report, name):
    value = report_field(report, name)
    match = re.match(r"(\d+)\b", value or "")
    return int(match.group(1)) if match else None


def report_section(report, name):
    match = re.search(
        r"^\s*" + re.escape(name)
        + r":\s*(.*?)(?=^\s*[A-Z][A-Z0-9_]+:\s*|\Z)",
        report,
        re.M | re.S,
    )
    return match.group(1).strip() if match else None


def empty_section(value):
    return value is not None and re.sub(
        r"[\s`*_-]+", "", value
    ).lower() in ("无", "none", "0", "暂无")
