"""Project external verification facts for snapshot and HTML consumers."""


DIMENSIONS = (
    ("COMPILE", "流水线编译"),
    ("UT", "流水线 UT"),
    ("CODECHECK", "流水线 CodeCheck"),
)


def snapshot_external(state):
    external = ((state or {}).get("quality", {}) or {}).get(
        "external_verification")
    if not isinstance(external, dict):
        return None
    return {
        "executor": external.get("executor", "pipeline"),
        "verdict": external.get("verdict", "PENDING"),
        "reason": external.get("reason", ""),
        "sha": str(external.get("sha", ""))[:12],
        "checks": {
            key: {
                "status": value.get("status", "pending"),
                "updated_at": value.get("updated_at")
                or value.get("registered_at", ""),
                "reason": value.get("reason", ""),
            }
            for key, value in (external.get("checks") or {}).items()
            if isinstance(value, dict)
        },
    }


def display_external(evidence):
    """Return passed labels and attention rows without rendering HTML."""
    checks = ((evidence or {}).get("external") or {}).get("checks") or {}
    passed, rows = [], []
    for dimension, name in DIMENSIONS:
        check = checks.get(dimension)
        if not check:
            continue
        status = check.get("status") or "pending"
        if status == "passed":
            passed.append(name)
        elif status in ("failed", "red"):
            rows.append((name, "未通过", "t-bad", check.get("reason")
                         or "修复 Agent 正在处理流水线问题"))
        elif status == "stale":
            rows.append((name, "已过期", "t-deg", "旧 SHA 结果不背书当前代码"))
        else:
            rows.append((name, "待流水线", "t-run", check.get("reason")
                         or "等待最终 SHA 的权威结果"))
    return passed, rows
