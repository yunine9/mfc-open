"""Immutable values and shared helpers for pure Agent contracts."""

from dataclasses import dataclass, field
import re
from typing import Mapping, Tuple


@dataclass(frozen=True)
class ContractDecision:
    accepted: bool
    reason: str = ""
    receipt_plans: Tuple[Mapping, ...] = ()
    details: Mapping = field(default_factory=dict)


@dataclass(frozen=True)
class AgentContractContext:
    kind: str
    status: str
    report: str
    task: Mapping
    config: Mapping
    calls: Tuple = ()
    changed_paths: Tuple[str, ...] = ()
    compile_net: int = 0
    reusable_receipts: Mapping = field(default_factory=dict)
    facts: Mapping = field(default_factory=dict)


def accept(receipt_plans=(), details=None):
    return ContractDecision(
        accepted=True,
        receipt_plans=tuple(receipt_plans),
        details=details or {},
    )


def reject(reason, receipt_plans=(), details=None):
    return ContractDecision(
        accepted=False,
        reason=reason,
        receipt_plans=tuple(receipt_plans),
        details=details or {},
    )


def same_config(actual, expected):
    def normalized(value):
        return re.sub(r"\s+", "", str(value or "")).lower()

    got = normalized(actual)
    wanted = normalized(expected)
    return bool(got) and bool(wanted) and wanted in got


def required_skill(config_value):
    value = str(config_value or "").lower()
    if "java-autout" in value:
        return "java-autout"
    if "autout" in value:
        return "autout"
    if "build-fix" in value:
        return "build-fix"
    return ""


def embedded_build_command(build_config):
    return (
        "mcde build -i"
        if "build-fix" in str(build_config or "").lower()
        else ""
    )


def build_summary_matches(summary, build_config):
    if same_config(summary, build_config):
        return True
    embedded = embedded_build_command(build_config)
    return bool(embedded and (
        "build-fix" in str(summary or "").lower()
        or same_config(summary, embedded)
    ))
