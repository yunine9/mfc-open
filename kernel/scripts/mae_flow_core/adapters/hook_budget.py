"""Process-wide time budget for one Hook invocation.

A Hook runs synchronously on every message, so the dispatcher arms a watchdog
that force-exits fail-open. The danger is not the watchdog itself but that a
single event can issue several bounded subprocess calls whose individual
timeouts sum to more than the whole budget: the watchdog then kills the process
mid-work, dropping whatever the event was supposed to record (a consumed Git
permit never gets finalized, and the flow later blocks on the missing receipt).

Every subprocess call therefore takes its timeout from the shared deadline
instead of its own constant, and callers can ask whether any budget is left
before starting new work.
"""

import time


_DEADLINE = None


def arm(seconds):
    """Start one invocation's budget; returns the absolute deadline."""
    global _DEADLINE
    _DEADLINE = time.time() + float(seconds)
    return _DEADLINE


def clear():
    global _DEADLINE
    _DEADLINE = None


def remaining():
    """Seconds left, or None when no budget is armed (CLI/test use)."""
    if _DEADLINE is None:
        return None
    return max(0.0, _DEADLINE - time.time())


def timeout_for(preferred, reserve=1.5, floor=0.5):
    """Cap one subprocess timeout so it cannot outlive the invocation.

    ``reserve`` keeps room for the caller to finish its own bookkeeping and
    logging after the subprocess returns.
    """
    left = remaining()
    if left is None:
        return float(preferred)
    return max(float(floor), min(float(preferred), left - float(reserve)))


def exhausted(reserve=1.5):
    """Whether starting further subprocess work would race the watchdog."""
    left = remaining()
    return left is not None and left <= float(reserve)
