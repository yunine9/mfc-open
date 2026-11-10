"""Shell tokenization and direct Git invocation discovery."""

import re
import shlex


GIT_GLOBAL_VALUE_OPTIONS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--super-prefix", "--config-env", "--exec-path",
}


def _is_git_executable(token):
    name = re.split(r"[\\/]", str(token or ""))[-1].lower()
    return name in ("git", "git.exe")


def _global_option_width(tokens, index):
    token = tokens[index]
    option = token.split("=", 1)[0]
    if option in GIT_GLOBAL_VALUE_OPTIONS:
        return 1 if "=" in token else 2
    if (
            token.startswith("-C") and token != "-C"
            or token.startswith("-c") and token != "-c"):
        return 1
    return 1 if token.startswith("-") else 0


def _fold_shell_line_continuations(command):
    """Apply shell backslash-newline removal outside single quotes."""
    result = []
    quote = ""
    index = 0
    while index < len(command):
        char = command[index]
        newline_width = (
            2 if command[index + 1:index + 3] == "\r\n"
            else 1 if command[index + 1:index + 2] == "\n"
            else 0
        )
        if char == "\\" and quote != "'" and newline_width:
            index += 1 + newline_width
            continue
        if quote == "'":
            result.append(char)
            if char == "'":
                quote = ""
            index += 1
            continue
        if char == "\\" and index + 1 < len(command):
            result.extend((char, command[index + 1]))
            index += 2
            continue
        result.append(char)
        if char in ("'", '"'):
            if not quote:
                quote = char
            elif quote == char:
                quote = ""
        index += 1
    return "".join(result)


def _shell_tokens(command):
    """Keep operators distinct from quoted/escaped words until argv is built.

    shlex with only command separators treats ``2>`` as a Git path; adding
    ``<>`` to punctuation alone would also erase quoted literal filenames.
    Tokenize raw word spans first so redirections never become pathspecs.
    """
    index = 0
    while index < len(command):
        char = command[index]
        if char in " \t\r":
            index += 1
            continue
        redirect = re.match(
            r"(?:[0-9]+)?(?:&>>|&>|<<<|<<-|<<|>>|<>|>\||>&|<&|>|<)",
            command[index:])
        if redirect:
            yield "redirect", redirect.group()
            index += len(redirect.group())
            continue
        if char in ";&|()\n":
            yield "control", char
            index += 1
            continue
        start = index
        quote = ""
        while index < len(command):
            char = command[index]
            if char == "\\" and quote != "'" and index + 1 < len(command):
                index += 2
                continue
            if char in ("'", '"'):
                if not quote:
                    quote = char
                elif quote == char:
                    quote = ""
                index += 1
                continue
            if not quote and char in " \t\r\n;&|()<>":
                break
            index += 1
        words = shlex.split(command[start:index], posix=True)
        if words:
            yield "word", words[0]


def shell_command_groups(command):
    """Return command argv, excluding shell redirection operators and targets."""
    try:
        tokens = _shell_tokens(_fold_shell_line_continuations(command))
        groups, current = [], []
        redirect_target = False
        for kind, token in tokens:
            if kind == "control":
                if current:
                    groups.append(tuple(current))
                    current = []
                redirect_target = False
            elif kind == "redirect":
                redirect_target = True
            elif redirect_target:
                redirect_target = False
            else:
                current.append(token)
        if current:
            groups.append(tuple(current))
        return tuple(groups)
    except ValueError:
        return ()


def _inline_alias_config(value):
    if not str(value).lower().startswith("alias.") or "=" not in value:
        return "", ""
    key, expansion = value.split("=", 1)
    return key[6:].lower(), expansion


def _git_invocation_records(command):
    invocations = []
    for tokens in shell_command_groups(command):
        for git_index, token in enumerate(tokens):
            if not _is_git_executable(token):
                continue
            index = git_index + 1
            aliases = {}
            while index < len(tokens):
                option = tokens[index]
                width = _global_option_width(tokens, index)
                if not width:
                    break
                config = ""
                if option == "-c" and index + 1 < len(tokens):
                    config = tokens[index + 1]
                elif option.startswith("-c") and option != "-c":
                    config = option[2:]
                name, expansion = _inline_alias_config(config)
                if name:
                    aliases[name] = expansion
                index += width
            if index < len(tokens):
                invocations.append((
                    tokens[index].lower(),
                    tuple(tokens[index + 1:]),
                    aliases,
                ))
                break
    return tuple(invocations)


def git_invocations(command):
    return tuple(
        (operation, arguments)
        for operation, arguments, _aliases
        in _git_invocation_records(command)
    )
