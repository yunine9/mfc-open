"""哪些 git 用法会覆盖工作区里未提交的内容。"""

from .git_intent import command_pathspecs, git_invocations
from .source_paths import normalize_path


def worktree_discard_paths(command):
    """→ 会把工作区内容覆盖掉的单文件目标(checkout/restore 丢弃式用法)。

    `git checkout -- <文件>` / `checkout HEAD -- <文件>` / `restore <文件>`
    (不带 --staged,或带 --worktree)都会把该文件未提交的改动直接抹掉。
    对 Agent 自己写的文件这是回退;对带着用户未提交改动的文件这是销毁现场。
    """
    out = []
    for operation, arguments in git_invocations(command):
        tokens = list(arguments)
        if operation == "checkout":
            if "--" not in tokens:
                continue                   # 切分支,不动文件内容
            marker = tokens.index("--")
            out += [normalize_path(item) for item in tokens[marker + 1:]]
        elif operation == "restore":
            staged = "--staged" in tokens or "-S" in tokens
            worktree = "--worktree" in tokens or "-W" in tokens
            if staged and not worktree:
                continue                   # 只动暂存区,工作区内容不丢
            out += [
                normalize_path(item)
                for item in command_pathspecs(
                    tokens, {"-s", "--source", "--pathspec-from-file"})
            ]
    return tuple(dict.fromkeys(item for item in out if item))
