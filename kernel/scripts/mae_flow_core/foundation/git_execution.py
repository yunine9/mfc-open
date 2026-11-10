"""Project actual command positions through bounded command launchers."""

from dataclasses import dataclass
import re
import shlex

from .git_shell import (
    _global_option_width,
    _is_git_executable,
)
from .shell_execution import (
    posix_execution_groups,
    windows_command_groups,
)


_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
_DELIVERY_OPERATIONS = {"commit", "push"}
_MAX_EXECUTION_DEPTH = 6

_SH_ZERO_SHORT_FLAGS = set("abefhiklmptuvxCrs")
_SH_VALUE_FLAGS = {"-o", "+o"}
_SH_ZERO_LONG_FLAGS = {"--login", "--posix", "--restricted", "--verbose"}

_BASH_ZERO_SHORT_FLAGS = set("abefhiklmptuvxBCHPirs")
_BASH_VALUE_FLAGS = {
    "-o", "+o", "-O", "+O", "--init-file", "--rcfile",
}
_BASH_ZERO_LONG_FLAGS = {
    "--debug", "--debugger", "--login", "--noediting", "--noprofile",
    "--norc", "--posix", "--protected", "--restricted", "--verbose",
    "--wordexp",
}

_ZSH_ZERO_SHORT_FLAGS = set("abefhiklmptuvxBCirs")
_ZSH_VALUE_FLAGS = {"-o", "+o"}
_ZSH_ATTACHED_VALUE_FLAGS = {"-o", "+o"}
_ZSH_ZERO_LONG_FLAGS = {
    "--globalrcs", "--interactive", "--login", "--no-globalrcs",
    "--no-rcs", "--rcs", "--verbose",
}

_TRADITIONAL_SHELL_GRAMMARS = {
    "sh": (
        _SH_ZERO_SHORT_FLAGS,
        _SH_VALUE_FLAGS,
        _SH_ZERO_LONG_FLAGS,
        set(),
    ),
    "bash": (
        _BASH_ZERO_SHORT_FLAGS,
        _BASH_VALUE_FLAGS,
        _BASH_ZERO_LONG_FLAGS,
        set(),
    ),
    "zsh": (
        _ZSH_ZERO_SHORT_FLAGS,
        _ZSH_VALUE_FLAGS,
        _ZSH_ZERO_LONG_FLAGS,
        _ZSH_ATTACHED_VALUE_FLAGS,
    ),
}
_FISH_NAMES = {"fish", "fish.exe"}
_SHELLS = (
    set(_TRADITIONAL_SHELL_GRAMMARS)
    | {name + ".exe" for name in _TRADITIONAL_SHELL_GRAMMARS}
    | _FISH_NAMES
)
_SHELL_TERMINAL_LONG_FLAGS = {
    "--dump-po-strings", "--dump-strings", "--help", "--version",
}

_FISH_ZERO_FLAGS = {
    "-i", "--interactive", "-l", "--login", "-N", "--no-config",
    "-P", "--private",
}
_FISH_VALUE_FLAGS = {
    "-d", "--debug", "-o", "--debug-output", "-p", "--profile",
}
_FISH_INIT_FLAGS = {"-C", "--init-command"}
_FISH_COMMAND_FLAGS = {"-c", "--command"}
_FISH_TERMINAL_FLAGS = {
    "-h", "--help", "-n", "--no-execute", "-v", "--version",
}

_POWERSHELLS = {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}
_POWERSHELL_FLAGS = {
    "-login", "-mta", "-nologo", "-noexit", "-noninteractive",
    "-noprofile", "-noprofileloadtime", "-sta", "-usemta",
}
_POWERSHELL_VALUE_FLAGS = {
    "-configurationname", "-custompipename", "-executionpolicy", "-file",
    "-inputformat", "-outputformat", "-settingsfile", "-version",
    "-windowstyle", "-workingdirectory",
}
_CMD_FLAGS = {
    "/a", "/d", "/q", "/s", "/u",
    "/e:on", "/e:off", "/f:on", "/f:off", "/v:on", "/v:off",
}

_SUDO_RUN_ZERO_SHORT_FLAGS = set("ABbEHiknPSs")
_SUDO_RUN_ZERO_LONG_FLAGS = {
    "--askpass", "--background", "--bell", "--login",
    "--non-interactive", "--preserve-env", "--preserve-groups",
    "--reset-timestamp", "--set-home", "--shell", "--stdin",
}
_SUDO_VALUE_FLAGS = {
    "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-u",
    "--chdir", "--chroot", "--close-from", "--command-timeout", "--group",
    "--host", "--prompt", "--role", "--type", "--user",
}
_SUDO_TERMINAL_FLAGS = {
    "-e", "--edit", "-K", "--remove-timestamp", "-l", "--list",
    "-V", "--version", "-v", "--validate", "--help",
}
_SUDO_TERMINAL_SHORT_FLAGS = set("eKlVv")


@dataclass(frozen=True)
class ActualCommand:
    executable: str
    arguments: tuple = ()

    @property
    def tokens(self):
        return (self.executable,) + self.arguments


def _executable_name(token):
    return re.split(r"[\\/]", str(token or ""))[-1].lower()


def _skip_assignments(tokens, index=0):
    while index < len(tokens) and _ASSIGNMENT.fullmatch(tokens[index]):
        index += 1
    return index


def git_invocation(record):
    tokens = record.tokens
    if not tokens or not _is_git_executable(tokens[0]):
        return None
    index = 1
    while index < len(tokens):
        width = _global_option_width(tokens, index)
        if not width or index + width > len(tokens):
            break
        index += width
    if index >= len(tokens) or tokens[index].startswith("-"):
        return None
    return tokens[index].lower(), tuple(tokens[index + 1:])


def _prefixed_command(tokens, index, kind):
    if kind == "command":
        inspection = False
        while index < len(tokens) and tokens[index].startswith("-"):
            option = tokens[index]
            if option == "--":
                index += 1
                break
            if not re.fullmatch(r"-[pVv]+", option):
                return ()
            inspection = inspection or "v" in option.lower()
            index += 1
        return () if inspection else tokens[index:]

    if kind == "exec":
        while index < len(tokens) and tokens[index].startswith("-"):
            option = tokens[index]
            if option == "--":
                index += 1
                break
            if option == "-a":
                index += 2
            elif re.fullmatch(r"-[cl]+", option):
                index += 1
            else:
                return ()
            if index > len(tokens):
                return ()
        return tokens[index:]

    return ()


def _option_operand(tokens, index, separator, value):
    if separator:
        return (value, index + 1) if value else ("", -1)
    if index + 1 < len(tokens):
        return tokens[index + 1], index + 2
    return "", -1


def _sudo_command(tokens, index):
    while index < len(tokens) and tokens[index].startswith("-"):
        option = tokens[index]
        if option == "--":
            return tokens[index + 1:]
        if option in _SUDO_TERMINAL_FLAGS:
            return ()
        if option.startswith("--"):
            base, separator, value = option.partition("=")
            if base in _SUDO_VALUE_FLAGS:
                _value, index = _option_operand(
                    tokens, index, separator, value)
                if index < 0:
                    return ()
            elif base in _SUDO_RUN_ZERO_LONG_FLAGS:
                if separator and (base != "--preserve-env" or not value):
                    return ()
                index += 1
            else:
                return ()
        else:
            flags = option[1:]
            flag_index = 0
            consumed_value = False
            while flag_index < len(flags):
                flag = flags[flag_index]
                if flag in _SUDO_TERMINAL_SHORT_FLAGS:
                    return ()
                if flag in _SUDO_RUN_ZERO_SHORT_FLAGS:
                    flag_index += 1
                    continue
                value_flag = "-" + flag
                if value_flag not in _SUDO_VALUE_FLAGS:
                    return ()
                if flag_index + 1 < len(flags):
                    index += 1
                else:
                    index += 2
                consumed_value = True
                break
            if not consumed_value:
                index += 1
        if index > len(tokens):
            return ()
    return tokens[index:]


def _env_command(tokens, index, depth):
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            break
        if _ASSIGNMENT.fullmatch(token):
            index += 1
            continue
        base = token.split("=", 1)[0]
        if base in ("-u", "--unset", "-C", "--chdir"):
            index += 1 if "=" in token else 2
        elif base in ("-S", "--split-string"):
            if "=" in token:
                split_value = token.split("=", 1)[1]
                remainder = tokens[index + 1:]
            elif index + 1 < len(tokens):
                split_value = tokens[index + 1]
                remainder = tokens[index + 2:]
            else:
                return ()
            try:
                split_tokens = tuple(shlex.split(split_value, posix=True))
            except ValueError:
                return ()
            return _actual_command_records_tokens(
                split_tokens + remainder, depth + 1)
        elif token in ("-i", "--ignore-environment", "-0", "--null"):
            index += 1
        elif token.startswith("-"):
            return ()
        else:
            break
        if index > len(tokens):
            return ()
    return _actual_command_records_tokens(tokens[index:], depth + 1)


def _is_noexec_value(value):
    return str(value).replace("_", "").lower() == "noexec"


def _traditional_shell_command(
        tokens, index, depth, zero_short_flags, value_flags,
        zero_long_flags, attached_value_flags):
    noexec = False
    while index < len(tokens):
        option = tokens[index]
        if option == "--":
            return ()
        if option in _SHELL_TERMINAL_LONG_FLAGS:
            return ()
        if option == "-c":
            if noexec:
                return ()
            return (
                _actual_command_records_text(tokens[index + 1], depth + 1)
                if index + 1 < len(tokens) else ())
        if option in value_flags:
            if index + 1 >= len(tokens):
                return ()
            if (
                    option in ("-o", "+o")
                    and _is_noexec_value(tokens[index + 1])):
                noexec = option == "-o"
            index += 2
            continue
        attached_flag = next((
            flag for flag in attached_value_flags
            if option.startswith(flag) and option != flag
        ), "")
        if attached_flag:
            if _is_noexec_value(option[len(attached_flag):]):
                noexec = attached_flag == "-o"
            index += 1
            continue
        if option.startswith("+"):
            flags = option[1:]
            if (
                    not flags
                    or "c" in flags
                    or not set(flags) <= (zero_short_flags | {"n"})):
                return ()
            if "n" in flags:
                noexec = False
            index += 1
            continue
        if option.startswith("-") and not option.startswith("--"):
            flags = option[1:]
            if not flags or not set(flags) <= (
                    zero_short_flags | {"c", "n"}):
                return ()
            if "n" in flags:
                noexec = True
            if "c" in flags:
                if noexec:
                    return ()
                return (
                    _actual_command_records_text(tokens[index + 1], depth + 1)
                    if index + 1 < len(tokens) else ())
            index += 1
        elif option in zero_long_flags:
            index += 1
        else:
            return ()
        if index > len(tokens):
            return ()
    return ()


def _fish_command(tokens, index, depth):
    commands = []
    while index < len(tokens):
        option = tokens[index]
        base, separator, value = option.partition("=")
        if option == "--":
            break
        if base in _FISH_TERMINAL_FLAGS:
            return ()
        if base in (
                _FISH_COMMAND_FLAGS | _FISH_INIT_FLAGS | _FISH_VALUE_FLAGS):
            value, index = _option_operand(tokens, index, separator, value)
            if index < 0:
                return ()
            if base in _FISH_INIT_FLAGS:
                commands.append(value)
            elif base in _FISH_COMMAND_FLAGS:
                commands.append(value)
                break
        elif option in _FISH_ZERO_FLAGS:
            index += 1
        elif not option.startswith("-"):
            break
        else:
            return ()
        if index > len(tokens):
            return ()
    records = []
    for command in commands:
        records.extend(_actual_command_records_text(command, depth + 1))
    return tuple(records)


def _shell_command(tokens, index, depth, executable):
    if executable in _FISH_NAMES:
        return _fish_command(tokens, index, depth)
    grammar = _TRADITIONAL_SHELL_GRAMMARS[executable.split(".", 1)[0]]
    return _traditional_shell_command(tokens, index, depth, *grammar)


def _powershell_command(tokens, index, depth):
    while index < len(tokens):
        option = tokens[index].lower()
        if option in ("-command", "-c"):
            payload = tokens[index + 1:]
            if len(payload) == 1:
                return _actual_command_records_text(payload[0], depth + 1)
            return _actual_command_records_tokens(payload, depth + 1)
        if option in _POWERSHELL_FLAGS:
            index += 1
        elif option.split("=", 1)[0] in _POWERSHELL_VALUE_FLAGS:
            index += 1 if "=" in option else 2
        else:
            return ()
        if index > len(tokens):
            return ()
    return ()


def _cmd_command(tokens, index, depth):
    while index < len(tokens):
        option = tokens[index].lower()
        if option in ("/c", "/k"):
            payload = tokens[index + 1:]
            if len(payload) == 1:
                return tuple(
                    record
                    for group in windows_command_groups(payload[0])
                    for record in _actual_command_records_tokens(
                        group, depth + 1)
                )
            return _actual_command_records_tokens(payload, depth + 1)
        if option not in _CMD_FLAGS:
            return ()
        index += 1
    return ()


def _actual_command_records_tokens(tokens, depth):
    if depth > _MAX_EXECUTION_DEPTH:
        return ()
    index = _skip_assignments(tokens)
    if index >= len(tokens):
        return ()
    tokens = tuple(tokens[index:])
    executable = _executable_name(tokens[0])
    if executable in ("command", "command.exe", "exec", "exec.exe"):
        kind = executable.split(".", 1)[0]
        return _actual_command_records_tokens(
            _prefixed_command(tokens, 1, kind), depth + 1)
    if executable in ("sudo", "sudo.exe"):
        return _actual_command_records_tokens(
            _sudo_command(tokens, 1), depth + 1)
    if executable in ("env", "env.exe"):
        return _env_command(tokens, 1, depth)
    if executable in _SHELLS:
        return _shell_command(tokens, 1, depth, executable)
    if executable in _POWERSHELLS:
        return _powershell_command(tokens, 1, depth)
    if executable in ("cmd", "cmd.exe"):
        return _cmd_command(tokens, 1, depth)
    return (ActualCommand(tokens[0], tuple(tokens[1:])),)


def _actual_command_records_text(command, depth):
    if depth > _MAX_EXECUTION_DEPTH or not isinstance(command, str):
        return ()
    records = []
    for substitutions, tokens in posix_execution_groups(command):
        for payload in substitutions:
            records.extend(_actual_command_records_text(payload, depth + 1))
        records.extend(_actual_command_records_tokens(tokens, depth))
    return tuple(records)


def actual_command_records(command):
    """Return leaf commands reached through the supported launcher grammar."""
    if not isinstance(command, str):
        return ()
    spelling = command
    if re.search(
            r"(?i)[A-Za-z]:\\(?:[^\\\s\"']+\\)*git\.exe\b",
            command):
        spelling = command.replace("\\", "/")
    return _actual_command_records_text(spelling, 0)


def executed_git_invocations(command):
    """Return actual Git subcommands and arguments in shell source order."""
    return tuple(
        invocation
        for record in actual_command_records(command)
        for invocation in [git_invocation(record)]
        if invocation is not None
    )


def executed_git_delivery_operations(command):
    """Return commit/push operations actually executed at command positions."""
    return tuple(dict.fromkeys(
        operation
        for operation, unused_arguments in executed_git_invocations(command)
        if operation in _DELIVERY_OPERATIONS
    ))
