"""Non-blocking Gate signals routed to a channel the Agent actually reads.

A Hook that allows the action exits 0, and on exit 0 the host shows the Hook's
stdout/stderr to the human in transcript mode only — it never reaches the
model. Every "suggestion, not a block" the Gate printed that way was therefore
invisible to the Agent it was written for: pre-commit lightcheck findings and
compile side-effect attribution both silently went nowhere.

Advisories are recorded here instead, and ``current``/``done`` render the ones
belonging to the current round. Staleness needs no cleanup pass: an advisory is
addressed to one round of one step, so filtering by that step's entry time is
enough.
"""

from mae_flow_core.state_store import safe_read_json, update_json
from .authority import PROMPT_ONLY_EVIDENCE


_RETIRED_FORM_NOTICES = {"template"} | {
    "quality:" + kind for kind in PROMPT_ONLY_EVIDENCE
}


_LIMIT = 40


def advisory_path(state_path):
    return str(state_path) + ".advisories"


def record_advisory(state_path, step, kind, message, at):
    """Record one non-blocking signal for the current step."""
    entry = {
        "step": str(step or ""),
        "kind": str(kind or ""),
        "message": str(message or "").strip(),
        "at": str(at or ""),
    }
    if not entry["message"]:
        return None

    def mutate(data):
        notices = data.setdefault("advisories", [])
        if not isinstance(notices, list):
            notices = []
            data["advisories"] = notices
        duplicate = any(
            isinstance(item, dict)
            and item.get("step") == entry["step"]
            and item.get("kind") == entry["kind"]
            and item.get("message") == entry["message"]
            for item in notices
        )
        if not duplicate:
            notices.append(entry)
            if len(notices) > _LIMIT:
                del notices[:-_LIMIT]
        return data

    update_json(
        advisory_path(state_path), mutate,
        default={"advisories": []}, recover_corrupt=True)
    return entry


def pending_advisories(state_path, step, since=""):
    """Advisories raised for this step during the current round."""
    data, error = safe_read_json(advisory_path(state_path))
    if error or not isinstance(data, dict):
        return ()
    notices = data.get("advisories", [])
    if not isinstance(notices, list):
        return ()
    return tuple(
        dict(item) for item in notices
        if isinstance(item, dict)
        and str(item.get("kind", "")) not in _RETIRED_FORM_NOTICES
        and item.get("step") == str(step or "")
        and str(item.get("at", "")) >= str(since or "")
    )


def lightcheck_advisory(result):
    """Summarize lightcheck findings for this channel; empty when clean."""
    findings = result.get("findings") or []
    if not findings:
        return ""
    lines = [
        "提交前轻量编码预检发现 %d 个本轮新触发问题(建议修复，不阻断):"
        % len(findings)
    ]
    for item in findings[:12]:
        function = (" " + item["function"]) if item.get("function") else ""
        lines.append("%s %s:%s%s — %s (%s > %s)" % (
            item["rule"], item["file"], item["line"], function,
            item["message"], item["actual"], item["limit"]))
    if len(findings) > 12:
        lines.append("…其余 %d 项见报告" % (len(findings) - 12))
    if result.get("report_path"):
        lines.append("人类可读报告: " + str(result["report_path"]))
    lines.append(
        "只修高置信且属于本次范围的项，最多两轮；仍不确定的留给正式 CodeCheck。")
    return "\n".join(lines)


def render_advisories(notices):
    """One compact block; empty when there is nothing to say."""
    if not notices:
        return ""
    lines = [
        "[mae-flow] ⚠ 本步待确认的非阻断提示(%d 条,门禁已放行,由你判断是否处理):"
        % len(notices)
    ]
    for item in notices:
        for index, line in enumerate(item["message"].splitlines()):
            if line.strip():
                lines.append(("  - " if index == 0 else "    ") + line.strip())
    return "\n".join(lines) + "\n"
