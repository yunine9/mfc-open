"""Pure quality-contract primitives."""

from .codecheck_advisory import (
    CodeCheckDisposition,
    CodeCheckTarget,
    build_codecheck_target,
    record_dispositions,
    render_codecheck_request,
)
from .selection import QualityRecommendation, recommend_quality

__all__ = [
    "CodeCheckDisposition",
    "CodeCheckTarget",
    "QualityRecommendation",
    "build_codecheck_target",
    "recommend_quality",
    "record_dispositions",
    "render_codecheck_request",
]
