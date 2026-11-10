"""Semantic, user-adjustable quality-work recommendations."""

from dataclasses import dataclass


_FOCUSED_FACTS = (
    (
        "behavior_change",
        ("build", "unit_test"),
        "A behavior change needs a Build and UT against observable behavior.",
    ),
    (
        "test_only",
        ("unit_test",),
        "A test-only change needs UT, but does not by itself invalidate Build.",
    ),
    (
        "docs_only",
        (),
        "A documentation-only change does not by itself need an expensive capability.",
    ),
    (
        "build_configuration",
        ("build",),
        "A build configuration change needs Build against the changed environment.",
    ),
    (
        "public_interface",
        ("build", "unit_test", "codecheck", "code_review"),
        "A public interface change needs compatibility coverage and independent review.",
    ),
    (
        "shared_state",
        ("build", "unit_test", "codecheck", "code_review"),
        "A shared state change needs integration coverage and independent review.",
    ),
    (
        "review_fix",
        ("code_review",),
        "A review-fix input merits review; other capabilities follow its actual impact.",
    ),
    (
        "weak_legacy_cpp_boundary",
        ("build", "unit_test"),
        "A weak legacy C++ boundary needs Build and UT. During Construction, "
        "extract deterministic business logic and create test seams. Final UT "
        "consumes them and must not mock the stable framework.",
    ),
)

_STARTUP_REASON = (
    "Show this recommendation at Startup; the user may adjust every choice. "
    "It does not execute or gate a capability."
)


def _boolean(value, field):
    if type(value) is not bool:
        raise ValueError("%s must be a bool" % field)
    return value


def _reasons(value):
    if isinstance(value, (str, bytes)):
        raise TypeError("reasons must be an iterable of natural-language text")
    result = tuple(value)
    if any(not isinstance(item, str) or not item.strip() for item in result):
        raise ValueError("reasons must contain non-empty strings")
    return tuple(item.strip() for item in result)


@dataclass(frozen=True)
class QualityRecommendation:
    """Suggested quality work, never capability authorization or a gate."""

    build: bool
    unit_test: bool
    codecheck: bool
    code_review: bool
    reasons: tuple

    def __post_init__(self):
        for field in ("build", "unit_test", "codecheck", "code_review"):
            _boolean(getattr(self, field), field)
        object.__setattr__(self, "reasons", _reasons(self.reasons))

    def adjusted(
            self, build=None, unit_test=None, codecheck=None,
            code_review=None, reason="User adjusted the Startup recommendation."):
        """Return the user's revised recommendation without performing work."""
        choices = {
            "build": self.build if build is None else _boolean(build, "build"),
            "unit_test": (
                self.unit_test
                if unit_test is None else _boolean(unit_test, "unit_test")
            ),
            "codecheck": (
                self.codecheck
                if codecheck is None else _boolean(codecheck, "codecheck")
            ),
            "code_review": (
                self.code_review
                if code_review is None else _boolean(code_review, "code_review")
            ),
        }
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("adjustment reason must be natural-language text")
        return QualityRecommendation(
            reasons=self.reasons + (reason.strip(),),
            **choices
        )


def _path_name(path):
    value = getattr(path, "value", path)
    if not isinstance(value, str):
        raise ValueError("delivery path must be full or focused")
    normalized = value.strip().lower()
    if normalized not in ("full", "focused"):
        raise ValueError("delivery path must be full or focused")
    return normalized


def _semantic_facts(values):
    facts = {}
    for name, value in values.items():
        facts[name] = _boolean(value, name)
    return facts


def recommend_quality(
        path, behavior_change=False, test_only=False, docs_only=False,
        build_configuration=False, public_interface=False,
        shared_state=False, review_fix=False,
        weak_legacy_cpp_boundary=False):
    """Recommend work from semantic facts, never diff size or file counts."""
    path_name = _path_name(path)
    facts = _semantic_facts({
        "behavior_change": behavior_change,
        "test_only": test_only,
        "docs_only": docs_only,
        "build_configuration": build_configuration,
        "public_interface": public_interface,
        "shared_state": shared_state,
        "review_fix": review_fix,
        "weak_legacy_cpp_boundary": weak_legacy_cpp_boundary,
    })
    capabilities = set()
    reasons = []
    for name, selected, reason in _FOCUSED_FACTS:
        if facts[name]:
            capabilities.update(selected)
            reasons.append(reason)
    if path_name == "full":
        capabilities.update(("build", "unit_test", "codecheck"))
        reasons.insert(
            0,
            "Full defaults to one formal CodeCheck, one Build, and one UT.",
        )
    elif not reasons:
        reasons.append(
            "No semantic impact facts selected an expensive capability."
        )
    reasons.append(_STARTUP_REASON)
    return QualityRecommendation(
        build="build" in capabilities,
        unit_test="unit_test" in capabilities,
        codecheck="codecheck" in capabilities,
        code_review="code_review" in capabilities,
        reasons=tuple(reasons),
    )
