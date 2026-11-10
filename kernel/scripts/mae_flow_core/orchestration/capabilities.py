"""Opaque expensive-capability facts and single-attempt decisions."""

from dataclasses import dataclass
from enum import Enum

from .models import CapabilityAttempt


SUMMARY_LIMIT = 500
_OUTCOMES = {
    "returned",
    "failed-to-start",
    "timed-out",
    "not-observed",
}


class CapabilityKind(str, Enum):
    """Expensive capabilities governed by the one-attempt policy."""

    BUILD = "build"
    UT = "ut"
    UNIT_TEST = "ut"
    CODECHECK = "codecheck"
    FORMAL_CODECHECK = "codecheck"


def _kind(value):
    try:
        return value if isinstance(value, CapabilityKind) else CapabilityKind(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("unknown capability kind") from exc


def _revision(value, field):
    if not isinstance(value, str) or not value:
        raise ValueError("%s must be a non-empty string" % field)
    return value


@dataclass(frozen=True)
class AttemptContext:
    """Capability-scoped revisions and authorization for one decision.

    ``source_revision`` identifies only source inputs relevant to the
    capability.  A documentation-only change, and a test-only change for a
    production Build, therefore retain the previous Build source revision.
    ``environment_revision`` includes relevant environment and configuration.
    """

    kind: CapabilityKind
    source_revision: str
    environment_revision: str
    user_authorized: bool = False

    def __post_init__(self):
        object.__setattr__(self, "kind", _kind(self.kind))
        _revision(self.source_revision, "source_revision")
        _revision(self.environment_revision, "environment_revision")
        if type(self.user_authorized) is not bool:
            raise ValueError("user_authorized must be a bool")


@dataclass(frozen=True)
class RetryOption:
    allowed: bool
    needs_user: bool
    reason: str


def _matching_attempt(attempts, context):
    return any(
        attempt.kind == context.kind.value
        and attempt.source_revision == context.source_revision
        and attempt.environment_revision == context.environment_revision
        for attempt in attempts
    )


def _same_capability_seen(attempts, context):
    return any(attempt.kind == context.kind.value for attempt in attempts)


def retry_options(attempts, context):
    """Return the one applicable option without interpreting tool output."""
    if not isinstance(context, AttemptContext):
        raise TypeError("context must be an AttemptContext")
    attempts = tuple(attempts)
    if _matching_attempt(attempts, context):
        if context.user_authorized:
            return RetryOption(
                True,
                False,
                "User authorized another attempt for unchanged inputs.",
            )
        return RetryOption(
            False,
            True,
            "An attempt already exists for unchanged inputs.",
        )
    if _same_capability_seen(attempts, context):
        return RetryOption(
            True,
            False,
            "Relevant source or environment changed; one attempt is available.",
        )
    return RetryOption(
        True,
        False,
        "No attempt exists for this capability and input context.",
    )


def automatic_attempt_allowed(attempts, context):
    """Whether the current automatic or explicitly authorized attempt may run."""
    return retry_options(attempts, context).allowed


def record_attempt(attempts, context, outcome, summary=""):
    """Append an opaque fact; recording never infers a quality verdict."""
    if not isinstance(context, AttemptContext):
        raise TypeError("context must be an AttemptContext")
    if not isinstance(outcome, str) or outcome not in _OUTCOMES:
        raise ValueError("unsupported opaque capability outcome")
    if not isinstance(summary, str):
        raise ValueError("summary must be a string")
    attempt = CapabilityAttempt(
        context.kind.value,
        context.source_revision,
        context.environment_revision,
        outcome,
        summary[:SUMMARY_LIMIT],
    )
    return tuple(attempts) + (attempt,)
