"""Bounded shell execution structure without interpreting command output."""

import re

from .git_shell import shell_command_groups


_PLACEHOLDER = "__mae_flow_substitution__"
_SEPARATORS = set(";&|()\n")
_MAX_SUBSTITUTION_DEPTH = 8


def _executable_name(token):
    return re.split(r"[\\/]", str(token or ""))[-1].casefold()


def _backtick_close(command, start):
    index = start
    while index < len(command):
        if command[index] == "\\" and index + 1 < len(command):
            index += 2
        elif command[index] == "`":
            return index
        else:
            index += 1
    return -1


def _dollar_close(command, start, nesting=0):
    if nesting >= _MAX_SUBSTITUTION_DEPTH:
        return -1
    depth = 1
    quote = ""
    index = start
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = ""
            index += 1
            continue
        if char == "\\" and index + 1 < len(command):
            index += 2
            continue
        if char == "'" and quote != '"':
            quote = "'"
            index += 1
            continue
        if char == '"':
            quote = "" if quote == '"' else '"'
            index += 1
            continue
        if char == "`":
            closing = _backtick_close(command, index + 1)
            if closing < 0:
                return -1
            index = closing + 1
            continue
        if command[index:index + 2] == "$(":
            closing = _dollar_close(command, index + 2, nesting + 1)
            if closing < 0:
                return -1
            index = closing + 1
            continue
        if not quote:
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    return index
        index += 1
    return -1


def _raw_segments(command):
    segments = []
    text = []
    substitutions = []
    quote = ""
    index = 0

    def flush():
        value = "".join(text).strip()
        if value:
            segments.append((tuple(substitutions), value))
        text[:] = []
        substitutions[:] = []

    while index < len(command):
        char = command[index]
        if quote == "'":
            text.append(char)
            if char == "'":
                quote = ""
            index += 1
            continue
        if (
                not quote
                and command[index:index + 3] == "\\$("):
            closing = _dollar_close(command, index + 3)
            if closing < 0:
                return ()
            text.append(_PLACEHOLDER)
            index = closing + 1
            continue
        if char == "\\" and index + 1 < len(command):
            text.extend((char, command[index + 1]))
            index += 2
            continue
        if char == "'" and quote != '"':
            quote = "'"
            text.append(char)
            index += 1
            continue
        if char == '"':
            quote = "" if quote == '"' else '"'
            text.append(char)
            index += 1
            continue
        if command[index:index + 2] == "$(":
            closing = _dollar_close(command, index + 2)
            if closing < 0:
                return ()
            substitutions.append(command[index + 2:closing])
            text.append(_PLACEHOLDER)
            index = closing + 1
            continue
        if char == "`":
            closing = _backtick_close(command, index + 1)
            if closing < 0:
                return ()
            substitutions.append(command[index + 1:closing])
            text.append(_PLACEHOLDER)
            index = closing + 1
            continue
        # >& / <& / >| and Bash &> belong to the surrounding command.
        # Keep them intact for argv tokenization, while substitutions inside
        # redirection targets are still recorded above as executed commands.
        redirect_operator = (
            char in "&|" and index > 0 and command[index - 1] in "<>"
            or char == "&" and command[index + 1:index + 2] == ">")
        if not quote and char in _SEPARATORS and not redirect_operator:
            flush()
            index += 1
            continue
        text.append(char)
        index += 1
    flush()
    return tuple(segments)


def windows_command_tokens(command):
    """Tokenize the narrow cmd /c payload surface without eating paths."""
    tokens = []
    token = []
    quoted = False
    for char in command:
        if char == '"':
            quoted = not quoted
        elif char.isspace() and not quoted:
            if token:
                tokens.append("".join(token))
                token = []
        else:
            token.append(char)
    if quoted:
        return ()
    if token:
        tokens.append("".join(token))
    return tuple(tokens)


def windows_command_groups(command):
    """Split the narrow cmd payload on real command operators."""
    segments = []
    segment = []
    quoted = False
    index = 0
    while index < len(command):
        char = command[index]
        if char == "^" and index + 1 < len(command):
            segment.extend((char, command[index + 1]))
            index += 2
            continue
        if char == '"':
            quoted = not quoted
            segment.append(char)
        elif not quoted and char in "&|\n":
            value = "".join(segment).strip()
            if value:
                segments.append(windows_command_tokens(value))
            segment = []
        else:
            segment.append(char)
        index += 1
    if quoted:
        return ()
    value = "".join(segment).strip()
    if value:
        segments.append(windows_command_tokens(value))
    return tuple(group for group in segments if group)


def posix_execution_groups(command):
    """Return ``(substitutions, argv)`` groups in shell source order."""
    groups = []
    for substitutions, text in _raw_segments(command):
        token_groups = shell_command_groups(text)
        for tokens in token_groups:
            selected = tokens
            if _executable_name(tokens[0]) in ("cmd", "cmd.exe"):
                windows = windows_command_tokens(text)
                if any(
                        token.casefold() in ("/c", "/k")
                        for token in windows[1:]):
                    selected = windows
            groups.append((substitutions, selected))
    return tuple(groups)
