"""Stable facade for Mae-Flow's bundled capability runtime."""

from . import capability_codecheck as _codecheck
from . import capability_runtime as _runtime
from .capability_shared import (
    CAPABILITY_PACKS,
    CODECHECK_PACKAGE,
    CODECHECK_REGISTRY,
    COMET_SCRIPT_ROOT,
    MANIFEST_PATH,
    OPENSPEC_ENTRY,
    PLUGIN_ROOT,
    VENDOR_ROOT,
    atomic_write_json,
    atomic_write_text,
    hashlib,
    json,
    os,
    re,
    shutil,
    subprocess,
    sys,
    tempfile,
    time,
)
from .capability_packs import (
    CapabilityError,
    _adapt_embedded_method,
    _extract_markdown_sections,
    _strip_frontmatter,
    render_pack,
)
from .capability_runtime import (
    _bash,
    _git,
    _host_runtime_checks,
    _node,
    _optional_runtime_checks,
    _python,
    _require_host_runtime,
    _run,
    _run_host_cli,
    _version_detail,
    run_comet,
    run_openspec,
)
from .capability_codecheck import (
    _capability_state_path,
    _probe_codecheck,
    _tree_sha256,
    diagnostics,
    locate_codecheck,
)


def prepare_project(project_root):
    """Prepare a project while retaining the historical `_git` test seam."""
    _runtime._git = _git
    return _runtime.prepare_project(project_root)


def ensure_codecheck(install=True):
    """Resolve CodeCheck while retaining historical discovery test seams."""
    _codecheck._capability_state_path = _capability_state_path
    _codecheck.locate_codecheck = locate_codecheck
    return _codecheck.ensure_codecheck(install=install)
