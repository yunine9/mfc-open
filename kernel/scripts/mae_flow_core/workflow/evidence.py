"""Evidence registration and ordered step evaluation."""

from collections.abc import Mapping
from types import MappingProxyType

from ..foundation.models import EvidenceResult


def legacy_result(value):
    """Normalize one historical ``(bool, str)`` evaluator result."""
    if isinstance(value, EvidenceResult):
        return value
    if not isinstance(value, tuple) or len(value) != 2:
        raise TypeError("evidence evaluator must return EvidenceResult or pair")
    return EvidenceResult(value[0], value[1])


class EvidenceRegistry(Mapping):
    """An immutable snapshot of Evidence names and evaluators."""

    def __init__(self, evaluators):
        self._evaluators = MappingProxyType(dict(evaluators))
        self._names = tuple(self._evaluators)

    @property
    def names(self):
        return self._names

    def __iter__(self):
        return iter(self._names)

    def __len__(self):
        return len(self._names)

    def __contains__(self, name):
        return name in self._evaluators

    def __getitem__(self, name):
        return self._evaluators[name]

    def evaluate(self, name, spec, state):
        evaluator = self._evaluators[name]
        return legacy_result(evaluator(spec, state))


def build_evidence_registry(*, workflow, agent, delivery, quality):
    """Compose the one authoritative legacy Evidence name registry."""
    return EvidenceRegistry((
        ("glob", workflow.glob),
        ("branch_ok", workflow.branch_ok),
        ("tasks_checked", workflow.tasks_checked),
        ("commit_tagged", delivery.commit_tagged),
        ("commit_tagged_after_entry", delivery.commit_tagged_after_entry),
        ("delivery_manifest_committed", delivery.delivery_manifest_committed),
        ("spec_field", workflow.spec_field),
        ("yaml_field", workflow.spec_field),
        ("spec_validate", workflow.spec_validate),
        ("tier_scope", workflow.tier_scope),
        ("pushed", delivery.pushed),
        ("agent_ran", agent.agent_ran),
        ("content_free", workflow.content_free),
        ("clean_paths", workflow.clean_paths),
        ("archive_paths_clean", delivery.archive_paths_clean),
        ("glob_absent", workflow.glob_absent),
        ("pipeline_obligations_passed", quality.pipeline_obligations_passed),
        ("domain_archive_complete", workflow.domain_archive_complete),
        ("local_spec_valid", workflow.local_spec_valid),
        ("verification_passed", workflow.verification_passed),
    ))


def evaluate_step_evidence(step, state, registry):
    """Evaluate declared Evidence in order and return failure reasons."""
    failures = []
    for spec in step.get("evidence", []):
        result = registry.evaluate(spec["type"], spec, state)
        if not result.passed:
            failures.append(result.reason)
    return failures
