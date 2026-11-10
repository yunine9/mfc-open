"""Immutable values shared by Delivery application use cases."""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType


def freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({
            key: freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(freeze(item) for item in value)
    return value


def thaw(value):
    """Return an independent mutable copy of an effect payload."""
    if isinstance(value, Mapping):
        return {
            key: thaw(item) for key, item in value.items()
        }
    if isinstance(value, tuple):
        return [thaw(item) for item in value]
    if isinstance(value, frozenset):
        return {thaw(item) for item in value}
    return value


@dataclass(frozen=True)
class DeliveryEffect:
    kind: str
    payload: object

    def __post_init__(self):
        if not isinstance(self.kind, str) or not self.kind:
            raise TypeError("kind must be non-empty str")
        object.__setattr__(self, "payload", freeze(self.payload))


@dataclass(frozen=True)
class DeliveryResult:
    effects: tuple
    stdout: tuple
    stderr: tuple
    exit_code: int

    def __post_init__(self):
        if not isinstance(self.effects, tuple):
            raise TypeError("effects must be tuple")
        if not all(
                isinstance(effect, DeliveryEffect)
                for effect in self.effects):
            raise TypeError("effects must contain DeliveryEffect")
        if not isinstance(self.stdout, tuple):
            raise TypeError("stdout must be tuple")
        if not isinstance(self.stderr, tuple):
            raise TypeError("stderr must be tuple")
        if not all(isinstance(line, str) for line in self.stdout):
            raise TypeError("stdout must contain str")
        if not all(isinstance(line, str) for line in self.stderr):
            raise TypeError("stderr must contain str")
        if type(self.exit_code) is not int:
            raise TypeError("exit_code must be int")
