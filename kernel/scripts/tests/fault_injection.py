"""Small deterministic failure injectors shared by boundary tests."""

from contextlib import contextmanager
from unittest import mock


@contextmanager
def fail_on_call(owner, attribute, call_number, exception):
    if call_number < 1:
        raise ValueError("call_number must be at least 1")
    original = getattr(owner, attribute)
    calls = {"count": 0}

    def invoke(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] == call_number:
            raise exception
        return original(*args, **kwargs)

    with mock.patch.object(owner, attribute, side_effect=invoke) as patched:
        yield patched
