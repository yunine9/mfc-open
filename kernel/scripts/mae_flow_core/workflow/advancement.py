"""Pure advancement policy for Mae-Flow workflow transitions."""

from dataclasses import dataclass

from .transitions import next_step


@dataclass(frozen=True)
class TransitionEvent:
    kind: str
    step: object
    result: str = ""
    note: str = ""


class TransitionResolutionError(Exception):
    def __init__(self, step_id):
        super().__init__(step_id)
        self.step_id = step_id


def _moonlight_enabled(state):
    return bool(((state or {}).get("moonlight") or {}).get("enabled"))


def _audit(step, result, note):
    return TransitionEvent("audit", step, result, note)


def _moonlight_review_events(flow, state, target):
    seen = set()
    while (
        _moonlight_enabled(state)
        and target
        and target not in seen
        and flow.get("steps", {}).get(target, {}).get(
            "skip_in_moonlight"
        )
    ):
        seen.add(target)
        bypass = flow["steps"][target]
        moonlight_choice = bypass.get("moonlight_choice", "")
        resolved = next_step(
            bypass,
            state,
            moonlight_choice,
        )
        if not resolved:
            raise TransitionResolutionError(target)
        yield _audit(
            target,
            "moonlight:skipped-human-review",
            "无人值守模式不进入编译后用户检视",
        )
        target = resolved
    return target


def _moonlight_archive_events(state, step_id, target):
    if _moonlight_enabled(state) and target == "archive_confirm":
        yield _audit(
            step_id,
            "moonlight:archive-deferred",
            "夜间先推送，规格定稿留到晨间 finalize",
        )
        target = "push"
    return target


def transition_events(flow, state, step_id, step):
    """Yield audit events followed by the final visible transition target."""
    target = next_step(step, state)
    target = yield from _moonlight_review_events(
        flow, state, target)
    target = yield from _moonlight_archive_events(
        state, step_id, target)

    if _moonlight_enabled(state) and step_id == "push":
        target = "moonlight_review"

    yield TransitionEvent("target", target)
