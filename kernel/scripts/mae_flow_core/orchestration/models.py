"""Immutable orchestration values for lean workflow recovery state."""

from dataclasses import dataclass, replace
from enum import Enum


class DeliveryPath(str, Enum):
    FULL = "full"
    FOCUSED = "focused"


class CommitPace(str, Enum):
    CONTINUOUS = "continuous"
    STAGED = "staged"


class Phase(str, Enum):
    STARTUP = "startup"
    SPEC = "spec"
    STORY = "story"
    CONSTRUCTION = "construction"
    QUALITY = "quality"
    DELIVERY = "delivery"


@dataclass(frozen=True)
class CapabilityAttempt:
    kind: str
    source_revision: str
    environment_revision: str
    outcome: str
    summary: str = ""


@dataclass(frozen=True)
class MoonlightAuthorization:
    """Exact user preauthorization for unattended delivery effects.

    ``business_files`` uses the same repository-relative identity rules as an
    exact delivery manifest.  The booleans are user authorization only; the
    policy can still withhold either effect when current repository facts are
    unsafe or ambiguous.
    """

    enabled: bool
    business_files: tuple
    allow_commit: bool
    allow_push: bool

    def __post_init__(self):
        if type(self.enabled) is not bool:
            raise ValueError("enabled must be a bool")
        if type(self.allow_commit) is not bool:
            raise ValueError("allow_commit must be a bool")
        if type(self.allow_push) is not bool:
            raise ValueError("allow_push must be a bool")
        if not self.enabled and (self.allow_commit or self.allow_push):
            raise ValueError(
                "disabled Moonlight cannot authorize commit or push")
        if isinstance(self.business_files, (str, bytes, set, frozenset, dict)):
            raise ValueError(
                "business_files must be an ordered collection of exact paths")
        try:
            files = tuple(self.business_files)
        except TypeError as exc:
            raise ValueError(
                "business_files must be an ordered collection of exact paths"
            ) from exc
        if any(not isinstance(path, str) for path in files):
            raise ValueError("business_files paths must be strings")
        object.__setattr__(self, "business_files", files)


@dataclass(frozen=True)
class FlowState:
    ticket: str
    path: DeliveryPath
    phase: Phase
    commit_pace: CommitPace
    status: str = "active"
    artifacts: tuple = ()
    decisions: tuple = ()
    risks: tuple = ()
    capabilities: tuple = ()
    delivery_files: tuple = ()
    initial_dirty: tuple = ()

    @classmethod
    def new(cls, ticket, path, pace):
        return cls(ticket, path, Phase.STARTUP, pace)

    def with_decision(self, key, value):
        return replace(self, decisions=self.decisions + ((key, value),))

    def to_dict(self):
        from .state_schema import encode_flow_state
        return encode_flow_state(self)

    @classmethod
    def from_dict(cls, raw):
        from .state_schema import decode_flow_state
        return decode_flow_state(raw)
