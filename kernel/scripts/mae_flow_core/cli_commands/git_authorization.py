"""Exact user-authorized Git actions and durable delivery receipts."""

from .shared import git_intent, re, source_paths, subprocess
from .wiring import api


def _norm(path):
    return source_paths.normalize_path(path)


def _authorization_operation(action):
    return {
        "checkout": "restore",
        "rm": "delete",
    }.get(action.operation, action.operation)


def _authorization_changes(snapshot, paths):
    new_paths = {
        api._repo_path_identity(path)
        for path in snapshot.get("new_paths", ())
    }
    deleted_paths = {
        api._repo_path_identity(path)
        for path in snapshot.get("deleted_paths", ())
    }
    return tuple(
        (
            path,
            (
                "D" if api._repo_path_identity(path) in deleted_paths
                else "A" if api._repo_path_identity(path) in new_paths
                else "M"
            ),
        )
        for path in paths
    )


def _revert_mainline(arguments):
    tokens = list(arguments)
    for index, token in enumerate(tokens):
        if token in ("-m", "--mainline"):
            return (
                tokens[index + 1]
                if index + 1 < len(tokens) else "")
        if token.startswith("--mainline="):
            return token.split("=", 1)[1]
    return ""


def _git_query(arguments):
    try:
        result = subprocess.run(
            ["git", *arguments],
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
        )
    except Exception:
        return "", False
    return result.stdout.strip(), result.returncode == 0


def _revert_authorization_action(action):
    resolved, ok = _git_query([
        "rev-parse", "--verify",
        action.commit + "^{commit}",
    ])
    if (
            not ok
            or not re.fullmatch(
                r"[0-9a-f]{40,64}", resolved, re.I)):
        return action
    parent_line, ok = _git_query([
        "rev-list", "--parents", "-n", "1", resolved,
    ])
    values = parent_line.split()
    parents = values[1:] if ok and values else []
    if len(parents) == 1:
        parent = parents[0]
    else:
        mainline = _revert_mainline(action.arguments)
        try:
            parent = parents[int(mainline) - 1]
        except (ValueError, IndexError):
            return action
    status_text, ok = _git_query([
        "-c", "core.quotepath=false", "diff",
        "--name-status", "--no-renames",
        parent, resolved, "--",
    ])
    if not ok:
        return action
    changes, objects = [], []
    inverse = {"A": "D", "D": "A", "M": "M", "T": "M"}
    for line in status_text.splitlines():
        fields = line.split("\t", 1)
        if (
                len(fields) != 2
                or fields[0][:1] not in inverse):
            return action
        path = _norm(fields[1])
        change = inverse[fields[0][:1]]
        expected_object = ""
        if change != "D":
            expected_object, exists = _git_query([
                "rev-parse", "--verify",
                parent + ":" + path,
            ])
            if not exists or not expected_object:
                return action
        changes.append((path, change))
        objects.append((path, expected_object))
    if not changes:
        return action
    return git_intent.GitAction(
        actor=action.actor,
        operation="revert",
        arguments=action.arguments,
        paths=tuple(path for path, _change in changes),
        commit=action.commit,
        changes=tuple(changes),
        resolved_commit=resolved,
        objects=tuple(objects),
    )


def _git_authorization_action(command, st=None, rule=""):
    """Build one exact Agent-origin GitAction for permit and evidence."""
    actions = git_intent.git_actions(
        command, actor="agent-hook")
    commit = next(
        (
            action for action in reversed(actions)
            if action.operation == "commit"
        ),
        None,
    )
    if commit:
        snapshot = api._pending_commit_candidates(command)
        paths = tuple(snapshot.get("paths", ()))
        if rule == "bash-foreign-openspec":
            paths = tuple(api._pending_commit_files(
                command, st, snapshot)[1])
        return git_intent.GitAction(
            actor=commit.actor,
            operation="commit",
            arguments=commit.arguments,
            paths=paths,
            changes=_authorization_changes(
                snapshot, paths),
        )
    for action in reversed(actions):
        operation = _authorization_operation(action)
        if operation not in {
                "add", "restore", "delete", "revert"}:
            continue
        if operation == "revert":
            return _revert_authorization_action(action)
        paths = tuple(dict.fromkeys(
            re.sub(r"^(?:\./)+", "", _norm(path))
            for path in action.paths if path
        ))
        return git_intent.GitAction(
            actor=action.actor,
            operation=operation,
            arguments=action.arguments,
            paths=paths,
            commit=action.commit,
            changes=tuple(
                (
                    path,
                    "D" if operation == "delete" else "M",
                )
                for path in paths
            ),
        )
    return None


def _git_authorization_record(action):
    if not action:
        return {}
    return {
        "actor": action.actor,
        "operation": action.operation,
        "paths": list(action.paths),
        "commit": action.commit,
        "changes": [
            list(change) for change in action.changes
        ],
        "resolved_commit": action.resolved_commit,
        "objects": [
            list(item) for item in action.objects
        ],
    }


def _authorization_is_exact(record):
    operation = str((record or {}).get("operation", ""))
    paths = [
        re.sub(r"^(?:\./)+", "", _norm(path))
        for path in (record or {}).get("paths", ())
        if isinstance(path, str) and path
    ]
    broad = {"", ".", "..", "/", "~", "*", ":/"}
    if operation == "revert":
        return bool(
            re.fullmatch(
                r"[0-9a-f]{7,64}",
                str((record or {}).get("commit", "")),
                re.I,
            )
            and re.fullmatch(
                r"[0-9a-f]{40,64}",
                str((record or {}).get(
                    "resolved_commit", "")),
                re.I,
            )
            and paths
            and len(
                record.get("objects", ()) or ()
            ) == len(paths)
        )
    return bool(paths) and all(
        path.lower() not in broad for path in paths)


def _authorization_ack_covers(record, ack, shown=""):
    if not _authorization_is_exact(record):
        return False
    acknowledged = (str(ack or "") + "\n" + str(shown or "")).replace(
        "\\", "/")
    if record.get("operation") == "revert":
        commit = str(record.get("commit", ""))
        return commit.lower() in acknowledged.lower()
    return all(
        str(path).replace("\\", "/") in acknowledged
        for path in record.get("paths", ())
    )


def _authorization_result_valid(record, path):
    if (
            not record.get("finalized")
            or record.get("operation")
            not in ("commit", "revert")):
        return False
    head = str((record or {}).get("result_head", ""))
    if not re.fullmatch(r"[0-9a-f]{7,64}", head, re.I):
        return False
    _unused, ancestor = _git_query([
        "merge-base", "--is-ancestor", head, "HEAD",
    ])
    if not ancestor:
        return False
    identity = api._repo_path_identity(path)
    result = next((
        item
        for item in (
            record.get("result_changes", ()) or ())
        if (
            isinstance(item, dict)
            and api._repo_path_identity(
                item.get("path", "")) == identity
        )
    ), None)
    if not result:
        return False
    recorded_path = str(result.get("path", ""))
    last_touch, ok = _git_query([
        "log", "-1", "--format=%H",
        "HEAD", "--", recorded_path,
    ])
    if not ok or last_touch != head:
        return False
    if result.get("change") == "D":
        _object, exists = _git_query([
            "rev-parse", "--verify",
            "HEAD:" + recorded_path,
        ])
        return not exists
    current_object, ok = _git_query([
        "rev-parse", "--verify",
        "HEAD:" + recorded_path,
    ])
    return bool(
        ok
        and current_object
        and current_object == result.get("object")
    )


def _authorized_delivery_path(path, st=None):
    for record in (
            (st or {}).get("git_authorizations", ()) or ()):
        if (
                not isinstance(record, dict)
                or not record.get("consumed")
                or record.get("actor") != "agent-hook"
                or not _authorization_result_valid(
                    record, path)):
            continue
        return True
    return False
