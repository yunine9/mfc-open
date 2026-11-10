"""Pure policies shared by Hook event use cases."""

from dataclasses import dataclass
import os
import re


@dataclass(frozen=True)
class StopDecision:
    allow: bool
    blocks: int = 0
    revision: int = 0
    reason: str = ""


@dataclass(frozen=True)
class PretoolDecision:
    action: str
    value: str = ""


_AGENT_KINDS = (
    ("story-generator-agent", "STORY"),
    ("craft-reviewer-agent", "REVIEWER"),
    ("compile-agent", "COMPILE"),
    ("codecheck-fix-agent", "CODECHECK"),
    ("ut-generator-agent", "UT"),
)

_FILE_TOOLS = ("Read", "Edit", "Write", "MultiEdit")


def authorized_file_access_root(repository_root, payload):
    """Accept only Cloud's containing task root; other hosts stay repo-only."""
    repository = os.path.realpath(repository_root)
    raw = (payload or {}).get("workspace_root") or repository
    try:
        candidate = os.path.realpath(os.path.abspath(os.fspath(raw)))
        if candidate in (repository, os.path.dirname(repository)):
            return candidate
    except (TypeError, ValueError, OSError):
        pass
    return repository


def _tool_paths(tool_input):
    """Return real host path fields in execution-order preference.

    Pi uses ``path`` while the historical Claude Hook uses ``file_path``.
    Check every supplied field at the repository boundary, but route the Pi
    field first so the path we authorize is the path Pi will execute.
    """
    if not isinstance(tool_input, dict):
        return ()
    values = []
    for key in ("path", "file_path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value and value not in values:
            values.append(value)
    return tuple(values)


def _inside_repository(path, repository_root, access_root=None):
    """Resolve an input path against the host-provided root without escape.

    ``realpath`` also catches an in-repo symlink whose target is outside.  A
    Windows absolute/drive-relative spelling received on POSIX is never a
    legitimate local task path, so reject it instead of treating it as a
    harmless filename containing a colon or backslashes.
    """
    if not repository_root or not isinstance(path, str) or not path:
        return True
    if "\0" in path:
        return False
    normalized = path.replace("\\", os.sep)
    if re.match(r"^[A-Za-z]:[^\\/]", path):
        return False
    if os.name != "nt" and re.match(r"^(?:[A-Za-z]:|//)", normalized):
        return False
    base = os.path.realpath(repository_root)
    root = os.path.realpath(access_root or repository_root)
    target = os.path.realpath(
        normalized if os.path.isabs(normalized)
        else os.path.join(base, normalized)
    )
    try:
        return os.path.commonpath((root, target)) == root
    except (TypeError, ValueError):
        return False


def _file_path_decision(
        tool, tool_input, repository_root, access_root=None):
    if tool not in _FILE_TOOLS:
        return None
    paths = _tool_paths(tool_input)
    if paths and repository_root and any(
            not _inside_repository(
                path, repository_root, access_root or repository_root)
            for path in paths):
        return PretoolDecision("block-path", paths[0])
    return PretoolDecision("file-path", paths[0] if paths else "")


def agent_kind(tool_input):
    blob = " ".join(
        str(tool_input.get(key, "") or "")
        for key in ("subagent_type", "description", "prompt")
    )
    if "grill-critic-agent" in blob:
        if ".mae-flow-work/standalone/" in blob.replace("\\", "/"):
            return "GRILL"
        return "GRILL_PREP" if "prep" in blob.lower() else "GRILL_FINAL"
    return next(
        (kind for name, kind in _AGENT_KINDS if name in blob),
        "",
    )


def active_pretool_decision(
        tool, tool_input, moonlight, repository_root="", access_root=None):
    if tool in ("Task", "Agent"):
        return PretoolDecision("agent")
    if tool == "AskUserQuestion" and moonlight:
        return PretoolDecision("block-question")
    file_path = _file_path_decision(
        tool, tool_input, repository_root, access_root)
    if file_path is not None:
        if file_path.action == "block-path":
            return file_path
        path = file_path.value
        if tool == "Read":
            return PretoolDecision("allow")
        return PretoolDecision(
            "gate-edit" if path else "allow", path)
    if tool == "Bash":
        command = tool_input.get("command", "") or ""
        return PretoolDecision(
            "gate-bash" if command else "allow", command)
    return PretoolDecision("allow")


def _standalone_protected(value):
    path = str(value or "").replace("\\", "/").lower()
    return (
        ".mae-flow-work/standalone-action.json" in path
        or (
            ".mae-flow-work/standalone/" in path
            and bool(re.search(
                r"(?:-task\.md|/action\.json|/result-[^/\s\"']+\.md)",
                path,
            ))
        )
    )


def standalone_pretool_decision(
        tool, tool_input, repository_root="", access_root=None):
    if tool in ("Task", "Agent"):
        return PretoolDecision("agent")
    file_path = _file_path_decision(
        tool, tool_input, repository_root, access_root)
    if file_path is not None:
        if file_path.action == "block-path":
            return file_path
        path = file_path.value
        if _standalone_protected(path):
            return PretoolDecision("block-edit")
    if tool == "Bash":
        command = str(
            tool_input.get("command", "") or "").replace("\\", "/").lower()
        if _standalone_protected(command) or "dispatch.py" in command:
            return PretoolDecision("block-bash")
    return PretoolDecision("allow")


def _moonlight_safe_point(step, moonlight):
    unresolved = [
        issue for issue in (moonlight.get("issues") or [])
        if not issue.get("resolved_at")
    ]
    return (
        step in ("moonlight_review", "end")
        or bool(moonlight.get("hard_blocked"))
        or (
            step == "push"
            and any(issue.get("kind") == "push" for issue in unresolved)
        )
    )


def _stop_blocks(stop_hook_active, guard, revision):
    if not stop_hook_active:
        return 1
    if int(guard.get("revision", -1) or -1) != revision:
        return 1
    return int(guard.get("blocks", 0) or 0) + 1


def stop_decision(state, stop_hook_active, guard):
    """Decide whether Moonlight may stop without reading or writing state."""
    moonlight = state.get("moonlight") or {}
    revision = int(state.get("revision", 0) or 0)
    if not moonlight.get("enabled"):
        return StopDecision(True, revision=revision, reason="inactive")
    step = state.get("current", "")
    if _moonlight_safe_point(step, moonlight):
        return StopDecision(True, revision=revision, reason="safe-point")
    blocks = _stop_blocks(stop_hook_active, guard, revision)
    if stop_hook_active and blocks > 3:
        return StopDecision(
            True,
            blocks=blocks,
            revision=revision,
            reason="retry-limit",
        )
    return StopDecision(False, blocks=blocks, revision=revision)
