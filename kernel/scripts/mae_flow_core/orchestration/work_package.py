"""Project-local requirement work packages with readable safe paths."""

from dataclasses import dataclass
import hashlib
import ntpath
import os
import re
import unicodedata


_INVALID_WINDOWS_CHARACTER = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_WINDOWS_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {"COM%d" % number for number in range(1, 10)}
    | {"LPT%d" % number for number in range(1, 10)}
)


@dataclass(frozen=True)
class WorkPackagePaths:
    ticket: str
    safe_ticket: str
    root: str
    ticket_marker: str
    spec: str
    grill: str
    story: str
    implementation: str
    decisions: str


def _ticket_text(ticket):
    if not isinstance(ticket, str):
        raise TypeError("ticket must be text")
    value = ticket.strip()
    if not value:
        raise ValueError("ticket must not be empty")
    return value


def _short_digest(ticket):
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()[:8]


def _portable_base(ticket):
    original = _ticket_text(ticket)
    normalized = unicodedata.normalize("NFC", original)
    safe = _INVALID_WINDOWS_CHARACTER.sub("-", normalized).rstrip(" .")
    safe = safe or "ticket"
    reserved = safe.split(".", 1)[0].upper() in _RESERVED_WINDOWS_NAMES
    if reserved:
        safe = "ticket-" + safe
    changed = safe != original or reserved
    suffix = "-" + _short_digest(original) if changed else ""
    available = 255 - len(suffix.encode("utf-16-le")) // 2
    while safe and len(safe.encode("utf-16-le")) // 2 > available:
        safe = safe[:-1]
        changed = True
        suffix = "-" + _short_digest(original)
        available = 255 - len(suffix.encode("utf-16-le")) // 2
    return (safe.rstrip(" .-") or "ticket") + suffix


def _marker_ticket(directory):
    marker = os.path.join(directory, ".ticket-id")
    try:
        with open(marker, encoding="utf-8") as stream:
            return stream.read()
    except OSError:
        return ""


def resolve_ticket_segment(project_root, ticket):
    """Resolve one readable segment without case-insensitive collisions."""
    original = _ticket_text(ticket)
    base = _portable_base(original)
    work_root = os.path.join(
        os.path.abspath(os.fspath(project_root)), ".mae-flow-work")
    try:
        names = os.listdir(work_root)
    except OSError:
        names = []
    matching = [name for name in names if name.casefold() == base.casefold()]
    if not matching:
        return base
    for name in matching:
        if _marker_ticket(os.path.join(work_root, name)) == original:
            return name
    # Upgrade a pre-marker work package in place when its spelling is exact.
    # Case-only aliases remain collisions on Windows/macOS-compatible paths.
    if base in matching and not _marker_ticket(os.path.join(work_root, base)):
        return base
    return base + "-" + _short_digest(original)


def _atomic_marker(path, ticket):
    temporary = path + ".tmp-%s" % os.getpid()
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(ticket)
        os.replace(temporary, path)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def ensure_work_package(project_root, ticket):
    """Create and return the local package for one business ticket."""
    original = _ticket_text(ticket)
    safe = resolve_ticket_segment(project_root, original)
    root = os.path.join(
        os.path.abspath(os.fspath(project_root)), ".mae-flow-work", safe)
    os.makedirs(root, exist_ok=True)
    marker = os.path.join(root, ".ticket-id")
    owner = _marker_ticket(root)
    if owner and owner != original:
        raise RuntimeError("work package collision: %s" % safe)
    if not owner:
        _atomic_marker(marker, original)
    return WorkPackagePaths(
        ticket=original,
        safe_ticket=safe,
        root=root,
        ticket_marker=marker,
        spec=os.path.join(root, "spec.md"),
        grill=os.path.join(root, "grill.md"),
        story=os.path.join(root, "story.md"),
        implementation=os.path.join(root, "implementation.md"),
        decisions=os.path.join(root, "decisions.md"),
    )
