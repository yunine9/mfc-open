"""Pure parsing for Mae-Flow Gate requests."""

from dataclasses import dataclass
import re

from ..foundation.git_execution import actual_command_records
from ..foundation.source_paths import normalize_path


@dataclass(frozen=True)
class BranchCommand:
    name: str
    creating: bool


@dataclass(frozen=True)
class GateIntent:
    kind: str
    subject: str
    tokens: tuple
    branch: object = None
    execution_subject: str = ""


def _tokens(command):
    return tuple(
        token
        for token in re.split(
            r"""[\s;|&()<>'"]+""",
            command,
        )
        if token
    )


def _branch_command(command):
    match = re.search(
        r"git\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s+(\S+)"
        r"|git\s+(?:checkout|switch)\s+(?!-)(\S+)"
        r"|git\s+branch\s+(?:-[mM]\s+\S+\s+)?(?!-)(\S+)\s*$",
        command,
    )
    if not match:
        return None
    name = match.group(1) or match.group(2) or match.group(3)
    creating = bool(match.group(1))
    if not creating and (
        " -- " in command
        or name == "."
        or re.fullmatch(
            r"HEAD([~^]\d*)*|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|@",
            name or "",
            re.I,
        )
        or re.fullmatch(r"[0-9a-f]{7,40}", name or "", re.I)
    ):
        name = ""
    return BranchCommand(name, creating)


def parse_intent(kind, subject):
    normalized = normalize_path(subject)
    tokens = _tokens(normalized) if kind == "bash" else ()
    branch = (
        _branch_command(normalized)
        if kind == "bash"
        else None
    )
    execution_subject = subject if isinstance(subject, str) else ""
    return GateIntent(kind, normalized, tokens, branch, execution_subject)


def hits_path(intent, pattern):
    return any(
        re.search(pattern, token, re.I)
        for token in intent.tokens
    )


def _recursive_delete(record):
    executable = re.split(r"[\\/]", record.executable)[-1].casefold()
    if executable == "rm":
        return any(
                argument == "--recursive"
                or (
                    argument.startswith("-")
                    and not argument.startswith("--")
                    and argument != "--"
                    and "r" in argument.casefold()[1:]
                )
            for argument in record.arguments
        )
    if executable in {"rd", "rmdir", "rd.exe", "rmdir.exe"}:
        return any(
            argument.casefold() == "/s" for argument in record.arguments)
    return False


def _recursive_delete_arguments(record):
    executable = re.split(r"[\\/]", record.executable)[-1].casefold()
    positional = False
    for argument in record.arguments:
        if argument == "--":
            positional = True
            continue
        if executable == "rm" and not positional and argument.startswith("-"):
            continue
        if executable in {"rd", "rmdir", "rd.exe", "rmdir.exe"} and (
                argument.casefold() in {"/s", "/q"}):
            continue
        if argument:
            yield argument


def _execution_records(intent):
    records = actual_command_records(
        intent.execution_subject or intent.subject)
    if not records and intent.execution_subject != intent.subject:
        return actual_command_records(intent.subject)
    return records


def recursive_delete_targets(intent):
    """Return recursive-delete targets only from commands that execute."""
    return tuple(
        normalize_path(token)
        for record in _execution_records(intent)
        if _recursive_delete(record)
        for token in _recursive_delete_arguments(record)
    )
