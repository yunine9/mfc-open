"""Shared interpretation of repository implementation checklist entries."""

import re


_TASK_RE = re.compile(r"^[-*]\s+\[([\sxX])\]\s*(.*?)\s*$")
_UT_ONLY_RE = re.compile(
    r"(?:"
    r"(?<![A-Za-z0-9])UT(?![A-Za-z0-9])"
    r"|单元测试|测试用例|补测"
    r"|unit[\s_-]*tests?"
    r"|test[\s_-]*cases?"
    r"|(?:^|[/\\\s])[^/\\\s]*(?:Tests?|_test|\.test|\.spec)"
    r"\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|java|kt|cs|py|go|rs|js|jsx|ts|tsx)"
    r")",
    re.I,
)


def is_deferred_ut_task(label):
    """Return whether a legacy checklist row describes verify-stage UT work."""
    return bool(_UT_ONLY_RE.search(str(label or "")))


def implementation_task_progress(text):
    """Count top-level implementation Tasks while excluding legacy UT rows."""
    total = 0
    completed = 0
    incomplete = []
    deferred_ut = []
    for line in str(text or "").replace("\r\n", "\n").replace(
            "\r", "\n").split("\n"):
        match = _TASK_RE.match(line)
        if not match:
            continue
        label = match.group(2).strip()
        if is_deferred_ut_task(label):
            deferred_ut.append(label)
            continue
        total += 1
        if match.group(1).lower() == "x":
            completed += 1
        else:
            incomplete.append(label)
    return {
        "total": total,
        "completed": completed,
        "incomplete": tuple(incomplete),
        "deferred_ut": tuple(deferred_ut),
    }
