"""Stateless rendering for Mae-Flow's one-shot toolbox actions."""

from dataclasses import dataclass
import ntpath
import os
import posixpath

from mae_flow_core.foundation.source_paths import (
    normalize_path,
    repository_path_identity,
)
from mae_flow_core.quality import (
    build_codecheck_target,
    render_codecheck_request,
)

from .native_guidance import load_native_guidance


_KINDS = {"ut", "codecheck", "grill", "story", "chain"}


def _files(values):
    if isinstance(values, (str, bytes)):
        raise TypeError("files must be an iterable, not raw text")
    try:
        values = tuple(values)
    except TypeError as exc:
        raise TypeError("files must be iterable") from exc
    result = []
    identities = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("files must contain non-empty text paths")
        raw = value.strip()
        windows_path = (
            os.name == "nt"
            or "\\" in raw
            or bool(ntpath.splitdrive(normalize_path(raw))[0])
        )
        path = normalize_path(
            ntpath.normpath(raw)
            if windows_path
            else posixpath.normpath(raw)
        )
        exact = repository_path_identity(path, case_insensitive=False)
        folded = repository_path_identity(path, case_insensitive=True)
        duplicate = any(
            exact == prior_exact
            or ((windows_path or prior_windows) and folded == prior_folded)
            for prior_exact, prior_folded, prior_windows in identities
        )
        if not duplicate:
            result.append(path)
            identities.append((exact, folded, windows_path))
    return tuple(result)


@dataclass(frozen=True)
class ToolboxRequest:
    """One complete toolbox request; it is never persisted as active state."""

    kind: str
    request: str
    files: tuple

    def __post_init__(self):
        if not isinstance(self.kind, str):
            raise TypeError("toolbox kind must be text")
        kind = self.kind.strip().lower()
        if kind not in _KINDS:
            raise ValueError("unsupported toolbox kind: %s" % self.kind)
        if not isinstance(self.request, str):
            raise TypeError("toolbox request must be text")
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "request", self.request.strip())
        object.__setattr__(self, "files", _files(self.files))


@dataclass(frozen=True)
class ToolboxResult:
    """Rendered guidance plus input artifacts and advisory scope risks."""

    guidance: str
    artifacts: tuple
    risks: tuple

    @property
    def effects(self):
        """One-shot actions deliberately expose no lifecycle or Git effects."""
        return ()


def _request_section(request):
    return "User request:\n%s" % (request or "(not provided)")


def _file_section(files, label="Input files"):
    lines = tuple("- " + path for path in files)
    return "%s:\n%s" % (label, "\n".join(lines) or "- (not provided)")


def _one_shot_boundary():
    return "\n".join((
        "This is a one-shot action, not an active workflow.",
        "No state, task card, SHA receipt, fixed report schema, retry counter, "
        "commit, or push is created by Mae-Flow.",
        "Run the requested capability at most once. Do not automatically retry.",
        "The user can stop simply by abandoning the action; no cancel transition "
        "is needed.",
        "Any output files remain local and are never auto-committed or pushed.",
    ))


def _ut_guidance(request):
    return "\n\n".join((
        load_native_guidance("quality").strip(),
        "\n".join((
            "One-shot Unit Test action.",
            _request_section(request.request),
            _file_section(request.files, "Explicit UT scope"),
            "The UT Skill owns the complete action: write UT, compile UT, and "
            "run UT. Keep its return opaque; report only what was observed.",
        )),
        _one_shot_boundary(),
    ))


def _codecheck_guidance(request):
    changed_lines = {path: None for path in request.files}
    target = build_codecheck_target(changed_lines, {})
    return target, "\n\n".join((
        _request_section(request.request),
        render_codecheck_request(target),
        _one_shot_boundary(),
    ))


def _grill_guidance(request):
    return "\n\n".join((
        load_native_guidance("grill").strip(),
        "一次只问一个需要用户决定的问题；可查事实直接从材料中查证。",
        _request_section(request.request),
        _file_section(request.files, "Source documents"),
        _one_shot_boundary(),
    ))


def _story_guidance(request):
    return "\n\n".join((
        load_native_guidance("story-design").strip(),
        _request_section(request.request),
        _file_section(request.files, "Source documents"),
        _one_shot_boundary(),
    ))


def _chain_guidance(request):
    return "\n\n".join((
        "Cross-repository Chain design. Read the supplied requirement and "
        "repository facts, identify each repository's responsibility, exact "
        "interface contract, dependency order, compatibility risk, and a "
        "self-contained handoff for each repository. Do not start delivery in "
        "any repository.",
        load_native_guidance("story-design").strip(),
        _request_section(request.request),
        _file_section(request.files, "Source documents"),
        _one_shot_boundary(),
    ))


def _scope_risks(request, artifacts):
    if request.kind in {"ut", "codecheck"} and not artifacts:
        return (
            "Exact file scope is unknown; continue only as advisory work and "
            "surface the uncertainty to the user.",
        )
    if not request.request and not artifacts:
        return (
            "Request and source scope are unknown; continue only as advisory "
            "work and surface the uncertainty to the user.",
        )
    return ()


def run_toolbox_request(request):
    """Render one action without creating state, evidence or side effects."""
    if not isinstance(request, ToolboxRequest):
        raise TypeError("request must be a ToolboxRequest")

    artifacts = request.files
    if request.kind == "ut":
        guidance = _ut_guidance(request)
    elif request.kind == "codecheck":
        target, guidance = _codecheck_guidance(request)
        artifacts = target.files
    elif request.kind == "grill":
        guidance = _grill_guidance(request)
    elif request.kind == "story":
        guidance = _story_guidance(request)
    else:
        guidance = _chain_guidance(request)

    return ToolboxResult(
        guidance=guidance,
        artifacts=artifacts,
        risks=_scope_risks(request, artifacts),
    )
