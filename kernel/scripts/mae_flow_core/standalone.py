"""Standalone-task lifecycle shared by the CLI and Hook adapter.

The control pointer is deliberately tiny and local.  Archiving removes only
that pointer; source code and generated reports are never deleted here.
"""

import copy
import os
import shutil
import time

from .runtime import ACTION_FILE
from .state_store import (
    ProjectStateLock,
    StateConflictError,
    atomic_write_json,
    normalize_document,
    remove_with_retry,
    safe_read_json,
    save_versioned_json,
    update_versioned_json,
)


def action_path(root=None):
    return os.path.join(os.path.abspath(root or os.getcwd()), ACTION_FILE)


def action_work_dir(action, root=None):
    project = os.path.abspath(root or os.getcwd())
    configured = (action or {}).get("work_dir")
    if configured:
        return os.path.abspath(os.path.join(project, configured))
    return os.path.join(
        project, ".mae-flow-work", "standalone",
        (action or {}).get("id", "unknown"))


def load_action(root=None, now=None):
    """Return ``(action, error, expired)`` without mutating the filesystem."""
    raw, err = safe_read_json(action_path(root))
    if err:
        return None, err, False
    if raw is None:
        return None, None, False
    try:
        action = normalize_document(raw, "action")
    except Exception as exc:
        return None, str(exc), False
    expired = float(action.get("expires_epoch", 0) or 0) < (
        time.time() if now is None else now)
    return action, None, expired


def save_action(action, root=None):
    return save_versioned_json(
        action_path(root), action, "action", project_root=root or os.getcwd())


def update_action(mutator, root=None):
    return update_versioned_json(
        action_path(root), "action", mutator, project_root=root or os.getcwd())


def archive_action(action, outcome, note="", root=None):
    """Atomically retire the current action pointer and preserve its final record."""
    project = os.path.abspath(root or os.getcwd())
    pointer = action_path(project)
    expected = int((action or {}).get("revision", 0) or 0)
    with ProjectStateLock(project):
        current, err = safe_read_json(pointer)
        if err:
            raise ValueError("独立任务状态不可读：%s" % err)
        if current is None:
            # Idempotent completion: the caller may have observed a Hook that
            # already retired the task.
            return action_work_dir(action, project)
        current = normalize_document(current, "action")
        revision = int(current.get("revision", 0) or 0)
        if expected and revision != expected:
            raise StateConflictError(
                "action revision 已从 %s 变为 %s，拒绝归档旧快照" %
                (expected, revision))

        final = copy.deepcopy(action or current)
        final["schema_version"] = current["schema_version"]
        final["revision"] = revision + 1
        final["status"] = outcome
        final["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        final["updated_at"] = final["finished_at"]
        if note:
            final["note"] = note
        work = action_work_dir(final, project)
        os.makedirs(work, exist_ok=True)
        atomic_write_json(os.path.join(work, "action.json"), final)
        remove_with_retry(pointer)
        if isinstance(action, dict):
            action.clear()
            action.update(copy.deepcopy(final))
        return work


def archive_corrupt_action(root=None):
    """Last-resort escape hatch for an unreadable action pointer."""
    project = os.path.abspath(root or os.getcwd())
    pointer = action_path(project)
    with ProjectStateLock(project):
        if not os.path.isfile(pointer):
            return None
        stamp = time.strftime("%Y%m%d-%H%M%S")
        work = os.path.join(
            project, ".mae-flow-work", "standalone", stamp + "-corrupt")
        suffix = 2
        candidate = work
        while os.path.exists(candidate):
            candidate = work + "-" + str(suffix)
            suffix += 1
        work = candidate
        os.makedirs(work, exist_ok=False)
        shutil.copy2(pointer, os.path.join(work, "standalone-action.json.bad"))
        remove_with_retry(pointer)
        return work
