"""Immutable values shared by Mae-Flow domain policies."""

from dataclasses import dataclass


@dataclass(frozen=True)
class EvidenceResult:
    """One Evidence decision with tuple-unpacking compatibility."""

    passed: bool
    reason: str

    def __post_init__(self):
        if type(self.passed) is not bool:
            raise TypeError("passed must be bool")
        if not isinstance(self.reason, str):
            raise TypeError("reason must be str")

    def __iter__(self):
        yield self.passed
        yield self.reason

    def __len__(self):
        return 2

    def __getitem__(self, index):
        return (self.passed, self.reason)[index]
