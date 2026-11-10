"""Immutable values shared by Hook application use cases."""

from dataclasses import dataclass, field
from typing import Mapping, Tuple


@dataclass(frozen=True)
class HookResponse:
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class ContractDecision:
    accepted: bool
    reason: str = ""
    task: Mapping = field(default_factory=dict)
    changed_paths: Tuple[str, ...] = ()


def accepted(task=None, changed_paths=()):
    return ContractDecision(
        accepted=True,
        task=task or {},
        changed_paths=tuple(changed_paths),
    )


def rejected(reason, task=None, changed_paths=()):
    return ContractDecision(
        accepted=False,
        reason=reason,
        task=task or {},
        changed_paths=tuple(changed_paths),
    )
