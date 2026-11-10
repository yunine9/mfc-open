"""Immutable exact delivery manifests and pure authorization policy."""

from collections.abc import Mapping
from dataclasses import dataclass, replace
import ntpath
import os
import re

from ..orchestration import FlowState


_GLOB_CHARACTERS = re.compile(r"[*?\[\]]")
_ADOPTION_DECISION = "delivery.adopted_dirty"
_PROCESS_DOCUMENT_PREFIXES = (
    ".mae-flow-work/",
    "docs/clarifications-",
    "docs/review/",
    "docs/codecheck-exempt-",
    "docs/story/",
    "docs/req/",
    "docs/superpowers/",
    "docs/mae-flow/requirements/",
    "openspec/",
)
_PROCESS_DOCUMENT_FILES = frozenset({
    ".mae-flow.json",
    "docs/delivery-notes.md",
})


def _is_absolute(path):
    return path.startswith("/") or bool(re.match(r"^[A-Za-z]:/", path))


def _is_drive_relative(path):
    drive, tail = ntpath.splitdrive(path)
    unc_drive = drive.startswith(("//", "\\\\"))
    return bool(
        drive
        and not unc_drive
        and not tail.startswith(("/", "\\"))
    )


def _relative_absolute(path, repository_root):
    root = repository_root.replace("\\", "/").rstrip("/")
    windows_identity = (
        os.name == "nt"
        or bool(ntpath.splitdrive(path)[0])
        or bool(ntpath.splitdrive(root)[0])
    )
    comparable_path = path.casefold() if windows_identity else path
    comparable_root = root.casefold() if windows_identity else root
    if comparable_path == comparable_root:
        return ""
    if comparable_path.startswith(comparable_root + "/"):
        return path[len(root) + 1:]
    return None


def _parent_stays_in_repository(path, repository_root):
    """Resolve existing parents, but never dereference the final path."""
    native_path = os.path.join(
        repository_root,
        *path.split("/"),
    )
    if not (os.path.isabs(native_path) and os.path.isabs(repository_root)):
        return True
    canonical_root = os.path.realpath(repository_root).replace("\\", "/")
    canonical_parent = os.path.realpath(
        os.path.dirname(native_path)).replace("\\", "/")
    return _relative_absolute(canonical_parent, canonical_root) is not None


def _reject_git_pathspec_magic(path):
    if path.startswith(":"):
        raise ValueError("delivery paths must not use Git pathspec magic")


def _normalize_path(path, repository_root):
    if not isinstance(path, str):
        raise ValueError("delivery paths must be strings")
    if path != path.strip() or not path:
        raise ValueError("delivery paths must be non-empty exact paths")

    if _is_drive_relative(path):
        raise ValueError("Windows drive-relative delivery paths are invalid")

    normalized = path.replace("\\", "/")
    _reject_git_pathspec_magic(normalized)
    if _GLOB_CHARACTERS.search(normalized):
        raise ValueError("delivery paths must not contain globs")

    if _is_absolute(normalized):
        normalized = _relative_absolute(normalized, repository_root)
        if normalized is None:
            raise ValueError("absolute delivery path is outside repository")

    parts = normalized.split("/")
    if (
            not normalized
            or normalized in (".", "..")
            or any(part in ("", ".", "..") for part in parts)):
        raise ValueError(
            "delivery paths must be exact files without aliases or '..'")

    native = os.path.join(repository_root, *parts)
    if not _parent_stays_in_repository(normalized, repository_root):
        raise ValueError("delivery path parent resolves outside repository")
    if os.path.isdir(native) and not os.path.islink(native):
        raise ValueError("delivery path identifies a directory")
    return normalized


def _identity(path):
    """Use a portable Windows-safe repository path identity."""
    return path.replace("\\", "/").casefold()


def is_runtime_path(path):
    """Reserved platform/kernel files share one boundary across Git gates."""
    identity = _identity(path)
    return identity.startswith(".mae-flow") or identity.startswith(".codecheckcli/")


def is_process_document(path):
    identity = _identity(path)
    return (is_runtime_path(path) or identity in _PROCESS_DOCUMENT_FILES
            or any(identity.startswith(prefix)
                   for prefix in _PROCESS_DOCUMENT_PREFIXES))


def validate_delivery_document_boundary(paths, archive_paths=()):
    """Report classification concerns; file selection belongs to the reviewer."""
    allowed_domain = {_identity(path) for path in archive_paths}
    findings = []
    for path in paths:
        identity = _identity(path)
        if is_process_document(path):
            findings.append("交付清单包含过程文件，请检视是否需要: %s" % path)
        elif identity.startswith("docs/specs/") and identity not in allowed_domain:
            findings.append("领域文档未关联本轮归档凭证，保留人工选定文件: %s" % path)
    return tuple(findings)


def _normalize_paths(paths, repository_root=None):
    if isinstance(paths, str) or paths is None:
        raise ValueError("delivery paths must be a collection of exact paths")
    if isinstance(paths, (set, frozenset, Mapping)):
        raise ValueError("delivery paths must be an ordered collection")
    root = (repository_root or os.getcwd()).replace("\\", "/")
    if _is_drive_relative(root):
        raise ValueError("repository root must not be drive-relative")
    if not _is_absolute(root):
        root = os.path.abspath(root)
    normalized = []
    identities = set()
    for path in paths:
        display = _normalize_path(path, root)
        identity = _identity(display)
        if identity in identities:
            raise ValueError("duplicate delivery path alias: %s" % display)
        identities.add(identity)
        normalized.append(display)
    return tuple(normalized)


@dataclass(frozen=True, init=False)
class DeliveryManifest:
    files: tuple
    adopted_dirty: tuple = ()

    def __init__(self, files, adopted_dirty=(), repository_root=None):
        object.__setattr__(
            self,
            "files",
            _normalize_paths(files, repository_root),
        )
        object.__setattr__(
            self,
            "adopted_dirty",
            _normalize_paths(adopted_dirty, repository_root),
        )

    @classmethod
    def from_paths(cls, paths, adopted_dirty=(), repository_root=None):
        """Build a manifest from exact paths without consulting Git."""
        return cls(paths, adopted_dirty, repository_root)


@dataclass(frozen=True)
class ManifestComparison:
    matches: bool
    missing: tuple
    extra: tuple

    def __post_init__(self):
        object.__setattr__(
            self,
            "missing",
            _ordered_tuple(self.missing, "missing"),
        )
        object.__setattr__(
            self,
            "extra",
            _ordered_tuple(self.extra, "extra"),
        )


def _ordered_tuple(paths, field):
    if isinstance(paths, str) or paths is None:
        raise ValueError("%s must be a collection of paths" % field)
    if isinstance(paths, (set, frozenset, Mapping)):
        raise ValueError("%s must be an ordered collection" % field)
    values = tuple(paths)
    if any(not isinstance(path, str) for path in values):
        raise ValueError("%s paths must be strings" % field)
    return values


def _by_identity(paths):
    return {_identity(path): path for path in paths}


def compare_staged(manifest, staged):
    """Compare a manifest with staged path facts using exact set equality."""
    if not isinstance(manifest, DeliveryManifest):
        raise TypeError("manifest must be a DeliveryManifest")
    staged_paths = _normalize_paths(staged)
    expected = _by_identity(manifest.files)
    actual = _by_identity(staged_paths)
    missing = tuple(
        expected[identity] for identity in sorted(set(expected) - set(actual)))
    extra = tuple(
        actual[identity] for identity in sorted(set(actual) - set(expected)))
    return ManifestComparison(
        matches=not missing and not extra,
        missing=missing,
        extra=extra,
    )


def authorize_delivery(state, manifest):
    """Return a state authorizing exactly one explicit delivery manifest."""
    if not isinstance(state, FlowState):
        raise TypeError("state must be a FlowState")
    if not isinstance(manifest, DeliveryManifest):
        raise TypeError("manifest must be a DeliveryManifest")

    initial_dirty = _by_identity(_normalize_paths(state.initial_dirty))
    delivery = _by_identity(manifest.files)
    adopted = _by_identity(manifest.adopted_dirty)
    outside_initial = tuple(
        adopted[identity]
        for identity in sorted(set(adopted) - set(initial_dirty)))
    if outside_initial:
        raise ValueError(
            "adopted_dirty must be an exact subset of initial_dirty: %s" %
            ", ".join(outside_initial))

    outside_delivery = tuple(
        adopted[identity]
        for identity in sorted(set(adopted) - set(delivery)))
    if outside_delivery:
        raise ValueError(
            "adopted_dirty must also be authorized delivery files: %s" %
            ", ".join(outside_delivery))

    adoption_facts = tuple(
        (_ADOPTION_DECISION, path) for path in manifest.adopted_dirty)
    decisions = tuple(
        fact for fact in state.decisions
        if fact[0] != _ADOPTION_DECISION
    ) + adoption_facts
    return replace(
        state,
        delivery_files=manifest.files,
        decisions=decisions,
    )
