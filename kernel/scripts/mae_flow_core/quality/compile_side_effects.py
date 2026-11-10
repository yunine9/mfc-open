"""Pure attribution of files changed by a compile step."""

import os

from ..foundation.source_paths import repository_path_identity


_DIRECT_WRITE_TOOLS = ("Write", "Edit", "MultiEdit")


def _repository_relative_path(value, repository_root):
    if not isinstance(value, str) or not value:
        return None
    root = os.path.realpath(
        os.path.abspath(str(repository_root).replace("\\", "/")))
    path = value.replace("\\", "/")
    candidate = os.path.realpath(os.path.abspath(
        path if os.path.isabs(path) else os.path.join(root, path)))
    try:
        if os.path.commonpath((root, candidate)) != root:
            return None
    except ValueError:
        return None
    return os.path.relpath(candidate, root).replace(os.sep, "/")


def successful_direct_write_paths(calls, repository_root):
    """Return repository-relative paths from successful direct-write calls."""
    paths = set()
    for call in calls:
        if (
                call.name not in _DIRECT_WRITE_TOOLS
                or not call.result_seen
                or call.is_error
                or not isinstance(call.input, dict)):
            continue
        path = _repository_relative_path(
            call.input.get("file_path") or call.input.get("path"),
            repository_root,
        )
        if path:
            paths.add(path)
    return tuple(sorted(paths))


def compile_side_effect_paths(baseline, current, direct_paths):
    """Return changed current paths not owned by successful direct writes."""
    before = {
        repository_path_identity(path): fingerprint
        for path, fingerprint in baseline.items()
    }
    direct = {
        repository_path_identity(path)
        for path in direct_paths
    }
    return tuple(sorted(
        path for path, fingerprint in current.items()
        if (
            before.get(repository_path_identity(path)) != fingerprint
            and repository_path_identity(path) not in direct
        )
    ))
