"""Distinguish archive provenance from work still needing a commit."""
import os
import subprocess


def committed_archive_receipt(archive, repository_root=None):
    """Read actual Git blobs; applying/adopting a file is not itself a delta."""
    paths = list(archive.get("applied_paths") or ())
    if not paths:
        if archive.get("result") != "unchanged":
            raise ValueError("领域归档不是 unchanged，且缺少归档文件凭证")
        return {}
    root = repository_root or os.getcwd()

    def git(*args):
        try:
            return subprocess.check_output(
                ["git", "-C", root, *args], stderr=subprocess.PIPE).decode().strip()
        except (subprocess.CalledProcessError, OSError) as exc:
            raise ValueError("无法核对领域归档文件的已提交状态") from exc

    receipt = {}
    for path in paths:
        # Includes staged and unstaged changes; unchanged worktree bytes alone
        # do not establish that the artifact has actually been committed.
        if (git("diff", "--cached", "HEAD", "--name-only", "--", path)
                or git("diff", "--name-only", "--", path)):
            raise ValueError("领域归档文件仍未提交: " + path)
        receipt[path] = git("rev-parse", "--verify", "HEAD:" + path)
    return receipt
