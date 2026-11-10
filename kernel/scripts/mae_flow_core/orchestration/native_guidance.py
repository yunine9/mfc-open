"""Load one concise Mae-Flow guidance document by its public name."""

import os


_PLUGIN_ROOT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", ".."))
GUIDANCE_ROOT = os.path.join(_PLUGIN_ROOT, "runtime", "guidance")
_GUIDANCE_FILES = {
    "grill": "grill.md",
    "story-design": "story-design.md",
    "construction": "construction.md",
    "review": "review.md",
    "quality": "quality.md",
}


def load_native_guidance(name):
    """Return exactly one named UTF-8 guidance file.

    Public names are an allowlist rather than path fragments, so POSIX and
    Windows traversal spellings cannot select any other runtime resource.
    """
    if not isinstance(name, str):
        raise TypeError("guidance name must be a string")
    filename = _GUIDANCE_FILES.get(name)
    if filename is None:
        raise ValueError("unknown native guidance: %s" % name)

    root = os.path.realpath(GUIDANCE_ROOT)
    path = os.path.realpath(os.path.join(root, filename))
    try:
        inside_root = os.path.commonpath((root, path))
    except ValueError:
        raise ValueError("native guidance path escapes its root")
    if os.path.normcase(inside_root) != os.path.normcase(root):
        raise ValueError("native guidance path escapes its root")

    with open(path, encoding="utf-8", newline=None) as stream:
        return stream.read()
