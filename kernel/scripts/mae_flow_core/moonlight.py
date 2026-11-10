"""Pure policy helpers for unattended (moonlight) execution."""

import time


# 2026-08-25 编排瘦身:编码段只剩宽 build 步,编译/规范/UT/规格自查都发生
# 在其中,defer 语义按 kind 记录、按 build 一步归属。
QUALITY_STEPS = {
    "build": "compile",
}

REPAIR_ENTRY = {
    "review": "build",
    "tweak": "build",
    "full": "build",
    "hotfix": "build",
}


def enabled(state):
    return bool(((state or {}).get("moonlight") or {}).get("enabled"))


def data(state):
    return (state or {}).setdefault("moonlight", {})


def unresolved(state):
    return [row for row in (data(state).get("issues") or [])
            if not row.get("resolved_at")]


def step_kind(step_id):
    return QUALITY_STEPS.get(step_id, "")


def can_hard_block(step_id):
    return step_id == "build" or (
        step_id not in QUALITY_STEPS
        and step_id not in ("push", "moonlight_review", "end"))


def resolve_kind(state, kind, head=""):
    if not enabled(state):
        return
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    for issue in unresolved(state):
        if issue.get("kind") == kind:
            issue["resolved_at"] = now
            issue["resolved_head"] = head
