"""Loading and static validation for Mae-Flow workflow definitions."""

import json
import os

from .transitions import transition_targets


def load_definition(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def _target_errors(step_id, step, steps):
    nxt = step.get("next")
    if nxt is not None and not isinstance(nxt, (str, dict)):
        return [
            "step %s has unsupported next type: %s"
            % (step_id, type(nxt).__name__)
        ]

    errors = []
    for target in transition_targets(step):
        if not isinstance(target, str) or not target:
            errors.append(
                "step %s has invalid next target: %r"
                % (step_id, target)
            )
        elif target not in steps:
            errors.append(
                "step %s references unknown step: %s"
                % (step_id, target)
            )
    return errors


def _step_errors(step_id, step, steps, steps_dir):
    if not isinstance(step_id, str) or not step_id:
        return ["step id must be a non-empty string: %r" % step_id]
    if not isinstance(step, dict):
        return ["step %s must be an object" % step_id]

    errors = _target_errors(step_id, step, steps)
    document = os.path.join(steps_dir or "", step_id + ".md")
    if (
        steps_dir is not None
        and not step.get("terminal")
        and not os.path.isfile(document)
    ):
        errors.append(
            "step %s is missing document: %s.md"
            % (step_id, step_id)
        )
    return errors


def definition_errors(definition, steps_dir=None):
    if not isinstance(definition, dict):
        return ["flow root must be an object"]
    steps = definition.get("steps")
    if not isinstance(steps, dict):
        return ["steps must be an object"]

    errors = []
    start = definition.get("start")
    if start not in steps:
        errors.append(
            "start references unknown step: %s" % (start or "(empty)")
        )

    for step_id in sorted(steps, key=str):
        step = steps[step_id]
        errors.extend(
            _step_errors(step_id, step, steps, steps_dir)
        )

    return sorted(errors)


def _graph_entries(definition, steps):
    errors = []
    entries = []
    start = definition.get("start")
    if start in steps:
        entries.append(start)
    else:
        errors.append(
            "start references unknown step: %s" % (start or "(empty)")
        )

    compatibility = definition.get("compatibility_entries", [])
    if not isinstance(compatibility, list):
        errors.append("compatibility_entries must be a list")
        compatibility = []
    for entry in compatibility:
        if not isinstance(entry, str) or not entry:
            errors.append("invalid compatibility entry: %r" % entry)
        elif entry not in steps:
            errors.append(
                "compatibility entry references unknown step: %s" % entry
            )
        elif entry not in entries:
            entries.append(entry)
    return entries, errors


def _graph_target_errors(steps):
    errors = []
    for step_id, step in steps.items():
        if isinstance(step, dict):
            errors.extend(_target_errors(step_id, step, steps))
    return errors


def _reachable_steps(steps, entries):
    reachable = set()
    pending = list(entries)
    while pending:
        step_id = pending.pop(0)
        if step_id in reachable:
            continue
        reachable.add(step_id)
        step = steps.get(step_id)
        if not isinstance(step, dict):
            continue
        pending.extend(
            target
            for target in transition_targets(step)
            if target in steps and target not in reachable
        )
    return reachable


def workflow_graph_errors(definition):
    if not isinstance(definition, dict):
        return ["flow root must be an object"]
    steps = definition.get("steps")
    if not isinstance(steps, dict):
        return ["steps must be an object"]

    entries, errors = _graph_entries(definition, steps)
    errors.extend(_graph_target_errors(steps))
    reachable = _reachable_steps(steps, entries)
    errors.extend(
        "unreachable step: %s" % step_id
        for step_id in steps
        if step_id not in reachable
    )
    return sorted(errors)
