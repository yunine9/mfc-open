"""Single runtime-mode resolver shared by Mae-Flow CLI and all Hooks."""

import os
import time

from .state_store import normalize_document, safe_read_json


FLOW_FILE = ".mae-flow.json"
EXIT_FILE = ".mae-flow.json.exited"
ACTION_FILE = os.path.join(".mae-flow-work", "standalone-action.json")


class RuntimeMode:
    INACTIVE = "inactive"
    FLOW = "flow"
    DIRECT = "direct"
    STANDALONE = "standalone"
    CORRUPT = "corrupt"


class RuntimeSnapshot:
    def __init__(self, root, mode, flow=None, action=None, exited=None,
                 conflicts=None, errors=None, ignored=None):
        self.root = os.path.abspath(root)
        self.mode = mode
        self.flow = flow
        self.action = action
        self.exited = exited
        self.conflicts = list(conflicts or [])
        self.errors = list(errors or [])
        self.ignored = list(ignored or [])

    @property
    def has_conflict(self):
        return bool(self.conflicts)

    @property
    def flow_terminal(self):
        """Whether the persisted full-flow state is completed, not active.

        The terminal document deliberately remains at ``.mae-flow.json`` so
        status/report and the next ``init`` can consume its audit history.
        Its presence must not make Hooks treat the completed delivery as a
        live gate.
        """
        return bool(
            self.mode == RuntimeMode.FLOW
            and self.flow
            and self.flow.get("current") == "end"
        )

    def summary(self):
        return {
            "root": self.root,
            "mode": self.mode,
            "flow_terminal": self.flow_terminal,
            "conflicts": list(self.conflicts),
            "errors": list(self.errors),
            "ignored": list(self.ignored),
        }


def find_project_root(start=None):
    """Find the nearest Mae-Flow marker or repository boundary."""
    origin = os.path.abspath(start or os.getcwd())
    probe = origin
    while True:
        markers = (
            os.path.exists(os.path.join(probe, FLOW_FILE)),
            os.path.exists(os.path.join(probe, EXIT_FILE)),
            os.path.exists(os.path.join(probe, ACTION_FILE)),
        )
        if any(markers):
            return probe
        if (os.path.exists(os.path.join(probe, ".git"))
                or os.path.isdir(os.path.join(probe, ".mae-flow-work"))
                or os.path.isdir(os.path.join(probe, "openspec"))):
            return probe
        parent = os.path.dirname(probe)
        if parent == probe:
            return origin
        probe = parent


def _load(root, relative, kind):
    path = os.path.join(root, relative)
    raw, err = safe_read_json(path)
    if err:
        return None, "%s(%s)" % (relative, err)
    if raw is None:
        return None, None
    try:
        return normalize_document(raw, kind), None
    except Exception as exc:
        return None, "%s(%s)" % (relative, exc)


def resolve_runtime(root=None, now=None):
    """Resolve all marker combinations once.

    Safety precedence:
    - a valid full flow always wins over stale standalone/exit markers;
    - standalone is valid only when no full flow exists;
    - exit is the base mode when no active flow/action exists;
    - corrupt full-flow state is explicit CORRUPT and must fail open in Hooks.
    """
    project = os.path.abspath(root or os.getcwd())
    now = time.time() if now is None else now
    flow, flow_err = _load(project, FLOW_FILE, "flow")
    action, action_err = _load(project, ACTION_FILE, "action")
    exited, exit_err = _load(project, EXIT_FILE, "exit")
    errors = [x for x in (flow_err, action_err, exit_err) if x]
    ignored = []
    conflicts = []

    flow_exists = os.path.isfile(os.path.join(project, FLOW_FILE))
    action_exists = os.path.isfile(os.path.join(project, ACTION_FILE))
    exit_exists = os.path.isfile(os.path.join(project, EXIT_FILE))

    if action and float(action.get("expires_epoch", 0) or 0) < now:
        ignored.append("expired_action")
        action = None

    if flow_exists and flow_err:
        return RuntimeSnapshot(project, RuntimeMode.CORRUPT, action=action, exited=exited,
                               errors=errors, ignored=ignored)

    if flow:
        if action_exists:
            conflicts.append("flow_and_action")
        if exit_exists:
            conflicts.append("flow_and_exit")
        # FLOW is the safe effective mode; conflicts remain visible for doctor/repair.
        return RuntimeSnapshot(project, RuntimeMode.FLOW, flow=flow, action=action,
                               exited=exited, conflicts=conflicts, errors=errors,
                               ignored=ignored)

    if action:
        if exit_exists:
            ignored.append("exit_is_standalone_base")
        return RuntimeSnapshot(project, RuntimeMode.STANDALONE, action=action,
                               exited=exited, errors=errors, ignored=ignored)

    if action_exists and action_err:
        if exited:
            return RuntimeSnapshot(project, RuntimeMode.DIRECT, exited=exited,
                                   errors=errors, ignored=["corrupt_action"])
        return RuntimeSnapshot(project, RuntimeMode.CORRUPT, errors=errors,
                               ignored=["corrupt_action"])

    if exited:
        return RuntimeSnapshot(project, RuntimeMode.DIRECT, exited=exited,
                               errors=errors, ignored=ignored)

    if exit_exists and exit_err:
        return RuntimeSnapshot(project, RuntimeMode.CORRUPT, errors=errors,
                               ignored=ignored)

    return RuntimeSnapshot(project, RuntimeMode.INACTIVE, errors=errors, ignored=ignored)
