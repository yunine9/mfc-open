"""Shared execution-aware command facts for stateful and stateless safety."""

from ..foundation import git_intent
from .bash import BashGateContext, decide_post_commit
from .intent import parse_intent, recursive_delete_targets


_DESTRUCTIVE_BASH_RULES = {
    "bash-force-push",
    "bash-git-clean-ignored",
    "bash-wipe-worktree",
}


def recursive_delete_facts(command):
    return recursive_delete_targets(parse_intent("bash", command))


def _bash_gate_context(command, delete_targets):
    return BashGateContext(
        command=command,
        has_internal_state_path=False,
        branch_name="",
        branch_creating=False,
        step="",
        wanted_branch="",
        base_branch="",
        ticket="",
        commit_message_present=False,
        commit_message="",
        current_branch="",
        add_paths=(),
        recursive_delete_targets=tuple(delete_targets),
        state_active=True,
    )


def dangerous_bash_result(command, delete_targets=()):
    """Return the lean rule/message for confirmed destructive execution."""
    gate = decide_post_commit(_bash_gate_context(command, delete_targets))
    if gate.rule == "bash-recursive-delete":
        return "filesystem", gate.message
    if gate.rule in _DESTRUCTIVE_BASH_RULES:
        return "git_destructive", gate.message
    return "", ""


def stateless_command_relevant(command):
    """Whether corrupt-state routing must retain a bounded safety decision."""
    rule, _message = dangerous_bash_result(
        command, recursive_delete_facts(command))
    if rule:
        return True
    return any(
        intent.operation in ("commit", "push")
        for intent in git_intent.git_delivery_intents(command)
    )
