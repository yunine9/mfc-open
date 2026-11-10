"""Pure parsing of Git add/commit intent from shell command text."""

import ast
from dataclasses import dataclass
import re
import shlex

from .git_execution import (
    actual_command_records,
    executed_git_delivery_operations,
    git_invocation,
)
from .git_shell import (
    GIT_GLOBAL_VALUE_OPTIONS,
    _git_invocation_records,
    _is_git_executable,
    git_invocations,
    shell_command_groups,
)
from .source_paths import normalize_path
from .commit_message import message_from_tokens


COMMIT_VALUE_OPTIONS = {
    "-m", "--message", "-F", "--file", "-C", "--reuse-message",
    "-c", "--reedit-message", "--author", "--date", "--cleanup",
    "-t", "--template", "--fixup", "--squash", "--trailer",
}

GIT_MUTATION_OPERATIONS = {
    "add", "commit", "push", "restore", "checkout", "rm", "revert",
}


def executes_git_commit_or_push(command):
    """Whether shell execution reaches a Git commit or push command."""
    return bool(executed_git_delivery_operations(command))


@dataclass(frozen=True)
class GitAction:
    actor: str
    operation: str
    arguments: tuple
    paths: tuple = ()
    commit: str = ""
    changes: tuple = ()
    resolved_commit: str = ""
    objects: tuple = ()


@dataclass(frozen=True)
class GitDeliveryIntent:
    operation: str
    arguments: tuple
    pathspecs: tuple = ()
    all: bool = False
    include: bool = False
    opaque_pathspec: bool = False


def git_alias_mutation(expansion):
    value = str(expansion or "").strip()
    if not value:
        return ""
    if value.startswith("!"):
        actions = git_actions(value[1:])
        if actions:
            return next((
                action.operation for action in actions
                if action.operation in GIT_MUTATION_OPERATIONS
            ), "")
        match = re.search(
            r"(?:^|[\s;&|])(?:git(?:\.exe)?\s+)?"
            r"(add|commit|push|restore|checkout|rm|revert)\b",
            value[1:],
            re.I,
        )
        return match.group(1).lower() if match else ""
    try:
        tokens = shlex.split(value, posix=True)
    except ValueError:
        return ""
    operation = tokens[0].lower() if tokens else ""
    return (
        operation
        if operation in GIT_MUTATION_OPERATIONS else ""
    )


def inline_git_alias_mutations(command):
    return tuple(
        mutation
        for operation, _arguments, aliases
        in _git_invocation_records(command)
        for mutation in [git_alias_mutation(
            aliases.get(operation, ""))]
        if mutation
    )


def _has_opaque_pathspec(arguments):
    return any(
        token == "--pathspec-from-file"
        or token.startswith("--pathspec-from-file=")
        or token == "--pathspec-file-nul"
        for token in arguments
    )


def opaque_pathspec_mutations(command):
    return tuple(
        operation
        for operation, arguments in git_invocations(command)
        if (
            operation in GIT_MUTATION_OPERATIONS
            and _has_opaque_pathspec(arguments)
        )
    )


def git_subcommand_tokens(command, subcommand):
    return [
        list(arguments)
        for operation, arguments in git_invocations(command)
        if operation == subcommand.lower()
    ]


def has_git_subcommand(command, subcommand):
    return bool(git_subcommand_tokens(command, subcommand))


def git_commit_message(command):
    token_sets = git_subcommand_tokens(command, "commit")
    if not token_sets:
        return False, ""
    return message_from_tokens(token_sets[-1])


def _action_paths(operation, arguments):
    tokens = list(arguments)
    if operation == "add":
        return tuple(git_add_intent(tokens)["pathspecs"])
    if operation == "commit":
        return tuple(command_pathspecs(tokens, COMMIT_VALUE_OPTIONS))
    if operation == "rm":
        return tuple(command_pathspecs(
            tokens, {"--pathspec-from-file"}))
    if operation == "restore":
        return tuple(command_pathspecs(
            tokens, {"-s", "--source", "--pathspec-from-file"}))
    if operation == "checkout" and "--" in tokens:
        marker = tokens.index("--")
        return tuple(
            normalize_path(token) for token in tokens[marker + 1:])
    return ()


def _revert_commit(arguments):
    values = command_pathspecs(
        list(arguments),
        {
            "-m", "--mainline", "--strategy", "-X",
            "--strategy-option", "--cleanup",
        },
    )
    return values[0] if len(values) == 1 else ""


def git_actions(command, actor="agent-hook"):
    """Return normalized direct Git actions in shell execution order."""
    actions = []
    for operation, arguments in git_invocations(command):
        if operation not in GIT_MUTATION_OPERATIONS:
            continue
        actions.append(GitAction(
            actor=actor,
            operation=operation,
            arguments=tuple(arguments),
            paths=_action_paths(operation, arguments),
            commit=(
                _revert_commit(arguments)
                if operation == "revert" else ""),
        ))
    return tuple(actions)


def _python_script_git_mutations(script):
    mutations = []
    call_pattern = re.compile(
        r"subprocess\.(?:run|call|check_call|check_output|Popen)"
        r"\s*\(\s*\[(.*?)\]\s*[,)]",
        re.I | re.S,
    )
    for match in call_pattern.finditer(script):
        literals = re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))
        if not literals or not _is_git_executable(literals[0]):
            continue
        for token in literals[1:]:
            if token.lower() in ("add", "commit", "push"):
                mutations.append(token.lower())
                break
    for match in re.finditer(
            r"(?:os\.system|subprocess\.(?:run|call|check_call|Popen))"
            r"\s*\(\s*(['\"])(.*?)\1",
            script,
            re.I | re.S,
    ):
        inner = match.group(2)
        for action in ("add", "commit", "push"):
            if re.search(
                    r"(?:^|\s)git(?:\.exe)?(?:\s+-\S+)*\s+"
                    + action + r"\b",
                    inner,
                    re.I,
            ):
                mutations.append(action)
    # A literal-list parser cannot safely follow variables or the os.exec*
    # family.  Once an Agent-origin Python -c script visibly combines a
    # process-launch API, a literal Git executable, and a literal mutation
    # subcommand, treat it as a high-confidence wrapper even when argv is
    # assembled indirectly.  This remains intentionally narrower than a claim
    # to understand arbitrary Python code.
    if (
            re.search(
                r"\b(?:subprocess\.[A-Za-z_]\w*|"
                r"os\.(?:exec\w*|spawn\w*|system|popen))\b",
                script,
                re.I,
            )
            and re.search(r"['\"]git(?:\.exe)?['\"]", script, re.I)):
        mutations.extend(
            action for action in ("add", "commit", "push")
            if re.search(
                r"['\"]" + action + r"['\"]",
                script,
                re.I,
            )
        )
    return mutations


def _python_wrapped_git_mutations(command):
    launcher = re.search(
            r"(?:^|[\s;&|])(?:[^\s\"']*[\\/])?"
            r"python(?:\d+(?:\.\d+)*)?(?:\.exe)?\s+[^;&|]*-c\b",
            command,
            re.I)
    return (
        _python_script_git_mutations(command[launcher.end():])
        if launcher else []
    )


def _literal_python_command(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if not isinstance(node, ast.List):
        return None
    values = tuple(item.value for item in node.elts if isinstance(
        item, ast.Constant) and isinstance(item.value, str))
    if len(values) != len(node.elts):
        return None
    return " ".join(shlex.quote(value) for value in values)


def _python_leaf_script_git_mutations(script):
    try:
        tree = ast.parse(script)
    except (SyntaxError, TypeError, ValueError):
        return ()
    mutations = []
    launchers = {"os": {"system"}, "subprocess": {
        "run", "call", "check_call", "check_output", "Popen"}}
    for node in ast.walk(tree):
        function = node.func if isinstance(node, ast.Call) else None
        owner = function.value if isinstance(function, ast.Attribute) else None
        if not isinstance(owner, ast.Name) or not node.args:
            continue
        if function.attr not in launchers.get(owner.id, set()):
            continue
        command = _literal_python_command(node.args[0])
        for record in actual_command_records(command or ""):
            invocation = git_invocation(record)
            if invocation and invocation[0] in ("add", "commit", "push"):
                mutations.append(invocation[0])
    return tuple(dict.fromkeys(mutations))


def _python_leaf_git_mutations(record):
    executable = re.split(r"[\\/]", record.executable)[-1]
    if not re.fullmatch(
            r"python(?:\d+(?:\.\d+)*)?(?:\.exe)?", executable, re.I):
        return ()
    try:
        index = record.arguments.index("-c")
    except ValueError:
        return ()
    if index + 1 >= len(record.arguments):
        return ()
    return _python_leaf_script_git_mutations(record.arguments[index + 1])


def _shell_wrapped_git_mutations(command):
    """Parse shell-wrapper payloads with the same Git global-option rules."""
    payloads = []
    shells = {"sh", "sh.exe", "bash", "bash.exe", "zsh", "zsh.exe",
              "fish", "fish.exe"}
    powershells = {
        "powershell", "powershell.exe", "pwsh", "pwsh.exe",
    }
    for group in shell_command_groups(command):
        for index, token in enumerate(group):
            executable = re.split(r"[\\/]", token)[-1].lower()
            if (
                    executable in shells
                    and index + 2 < len(group)
                    and group[index + 1].lower() == "-c"):
                payloads.append(group[index + 2])
                continue
            if (
                    executable in powershells
                    and index + 2 < len(group)
                    and group[index + 1].lower()
                    in ("-command", "-c")):
                payloads.append(" ".join(group[index + 2:]))
                continue
            if (
                    executable in ("cmd", "cmd.exe")
                    and index + 2 < len(group)
                    and group[index + 1].lower() == "/c"):
                payloads.append(" ".join(group[index + 2:]))
    return [
        operation
        for payload in payloads
        for operation, _arguments in git_invocations(payload)
        if operation in ("add", "commit", "push")
    ]


def wrapped_git_mutations(command, include_shell=True):
    """Detect high-confidence Agent interpreter wrappers around Git writes."""
    mutations = _python_wrapped_git_mutations(command)
    if include_shell:
        mutations += _shell_wrapped_git_mutations(command)
    return tuple(dict.fromkeys(
        mutations
    ))


def option_consumes_following(token, value_options):
    option = token.split("=", 1)[0]
    if option in value_options:
        return "=" not in token
    return bool(re.fullmatch(r"-[A-Za-z]*[mFCctS]", token))


class PathspecCollector:
    def __init__(self, value_options):
        self.value_options = value_options
        self.paths = []

    def _consume(self, tokens, index):
        token = tokens[index]
        if not token.startswith("-"):
            self.paths.append(normalize_path(token))
            return index + 1
        return index + (
            2 if option_consumes_following(
                token, self.value_options) else 1)

    def collect(self, tokens):
        index = 0
        while index < len(tokens):
            index = self._consume(tokens, index)
        return self.paths


def command_pathspecs(tokens, value_options=None):
    value_options = value_options or set()
    if "--" in tokens:
        marker = tokens.index("--")
        before, explicit = tokens[:marker], tokens[marker + 1:]
    else:
        before, explicit = tokens, []
    paths = PathspecCollector(value_options).collect(before)
    paths.extend(normalize_path(token) for token in explicit)
    return list(dict.fromkeys(paths))


def git_add_intent(tokens):
    token_set = set(tokens)
    short_flags = short_option_flags(tokens)
    all_mode = bool(
        "A" in short_flags
        or token_set & {"--all", "--no-ignore-removal"})
    update = "u" in short_flags or "--update" in token_set
    paths = command_pathspecs(tokens)
    default_paths = ["."] if all_mode or update else []
    return {
        "pathspecs": paths or default_paths,
        "force": "f" in short_flags or "--force" in token_set,
        "tracked_only": update,
        "all": all_mode,
    }


def git_add_intents(command):
    return [
        git_add_intent(tokens)
        for tokens in git_subcommand_tokens(command, "add")
    ]


def short_option_flags(tokens):
    return "".join(
        match.group(1) for token in tokens
        for match in [re.fullmatch(r"-([A-Za-z]+)", token)]
        if match)


def _git_commit_intent(tokens):
    token_set = set(tokens)
    short_flags = short_option_flags(tokens)
    return {
        "pathspecs": command_pathspecs(tokens, COMMIT_VALUE_OPTIONS),
        "all": "a" in short_flags or "--all" in token_set,
        "include": "i" in short_flags or "--include" in token_set,
    }


def git_commit_intents(command):
    """Return every parsed commit intent in shell execution order."""
    return [
        _git_commit_intent(tokens)
        for tokens in git_subcommand_tokens(command, "commit")
    ]


def git_commit_intent(command):
    intents = git_commit_intents(command)
    return intents[-1] if intents else _git_commit_intent([])


def _delivery_intent(operation, arguments, synthetic=False):
    opaque = synthetic or _has_opaque_pathspec(arguments)
    values = {
        "operation": operation,
        "arguments": tuple(arguments),
        "opaque_pathspec": opaque,
    }
    if operation == "add":
        parsed = git_add_intent(list(arguments))
        values.update(
            pathspecs=(() if opaque else tuple(parsed["pathspecs"])),
            all=parsed["all"],
        )
    elif operation == "commit":
        parsed = _git_commit_intent(list(arguments))
        values.update(
            pathspecs=(() if opaque else tuple(parsed["pathspecs"])),
            all=parsed["all"],
            include=parsed["include"],
        )
    return GitDeliveryIntent(**values)


def _leaf_delivery_intents(record):
    invocation = git_invocation(record)
    if invocation is not None and invocation[0] in ("add", "commit", "push"):
        return (_delivery_intent(invocation[0], invocation[1]),)
    command = " ".join(shlex.quote(token) for token in record.tokens)
    operations = (
        inline_git_alias_mutations(command)
        if invocation is not None
        else _python_leaf_git_mutations(record)
    )
    return tuple(
        _delivery_intent(operation, (), synthetic=True)
        for operation in operations
        if operation in ("add", "commit", "push")
    )


def git_delivery_intents(command):
    """Return actual and high-confidence synthetic intents in source order."""
    return tuple(
        intent
        for record in actual_command_records(command)
        for intent in _leaf_delivery_intents(record)
    )
