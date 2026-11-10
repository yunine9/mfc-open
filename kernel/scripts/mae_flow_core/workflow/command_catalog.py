"""Parser-first builders for commands printed by production workflow code."""

import shlex

from mae_flow_core.cli_parser import parse_args


def _required(context, key):
    value = str((context or {}).get(key, "") or "").strip()
    if not value:
        raise ValueError("command context missing %s" % key)
    return value


def render_command(command_id, context=None):
    """Return argv; display text must always be derived from this value."""
    context = context or {}
    builders = {
        "current": lambda: ["current"],
        "messages": lambda: ["messages"],
        "local_spec_init": lambda: ["local-spec", "init"],
        "local_spec_validate": lambda: ["local-spec", "validate"],
        "manifest_set": lambda: [
            "manifest", "set", "--file", _required(context, "file"),
            "--message", _required(context, "message"),
            "--target", _required(context, "target"),
        ],
        "manifest_confirm": lambda: [
            "manifest", "confirm", "--message-id",
            _required(context, "message_id"),
        ],
        "migrate_confirm": lambda: [
            "migrate-flow", "--confirm", "--message-id",
            _required(context, "message_id"),
        ],
    }
    try:
        argv = builders[command_id]()
    except KeyError as exc:
        raise ValueError("unknown production command: %s" % command_id) from exc
    parse_args(argv)
    return argv


def render_display(command_id, context=None, executable="mae-flow"):
    argv = render_command(command_id, context)
    return " ".join(shlex.quote(value) for value in [executable, *argv])


def catalog_ids():
    return (
        "current", "messages", "local_spec_init", "local_spec_validate",
        "manifest_set", "manifest_confirm",
        "migrate_confirm",
    )
