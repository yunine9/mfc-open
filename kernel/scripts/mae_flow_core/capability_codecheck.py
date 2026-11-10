"""CodeCheck discovery, one-shot installation, and capability diagnostics."""

from .capability_shared import (
    CAPABILITY_PACKS, CODECHECK_PACKAGE, CODECHECK_REGISTRY, MANIFEST_PATH,
    PLUGIN_ROOT, VENDOR_ROOT, atomic_write_json, hashlib, json, os, shutil,
    subprocess, time,
)
from .capability_packs import CapabilityError, render_pack
from .capability_runtime import _host_runtime_checks, _optional_runtime_checks, _run_host_cli

def _probe_codecheck(path):
    if not path:
        return False, ""
    command = [path, "fullcheck", "--help"]
    try:
        result = _run_host_cli(command, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    output = (result.stdout or "") + (result.stderr or "")
    return "fullcheck" in output.lower(), output.strip()


def locate_codecheck():
    candidates = []
    direct = shutil.which("codecheck") or shutil.which("codecheck.cmd")
    if direct:
        candidates.append(direct)
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(os.path.join(appdata, "npm", "codecheck.cmd"))
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if npm:
        try:
            probe = _run_host_cli([npm, "prefix", "-g"], timeout=30)
            prefix = (probe.stdout or "").strip()
            if prefix:
                if os.name == "nt":
                    candidates.append(os.path.join(prefix, "codecheck.cmd"))
                else:
                    candidates.append(os.path.join(prefix, "bin", "codecheck"))
        except (OSError, subprocess.TimeoutExpired):
            pass
    seen = set()
    for candidate in candidates:
        key = os.path.normcase(os.path.abspath(candidate))
        if key in seen or not os.path.isfile(candidate):
            continue
        seen.add(key)
        ok, output = _probe_codecheck(candidate)
        if ok:
            return os.path.abspath(candidate), output
    return "", ""


def _capability_state_path():
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".mae-flow")
    return os.path.join(base, "mae-flow", "capabilities.json")


def _tree_sha256(path):
    digest = hashlib.sha256()
    files = []
    for base, directories, names in os.walk(path):
        directories[:] = sorted(
            name for name in directories if name != "__pycache__")
        files.extend(
            os.path.join(base, name)
            for name in names
            if not name.endswith((".pyc", ".pyo")))
    files.sort(key=lambda item: os.path.relpath(
        item, path).replace(os.sep, "/"))
    for filename in files:
        relative = os.path.relpath(filename, path).replace(os.sep, "/")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with open(filename, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def ensure_codecheck(install=True):
    """Locate CodeCheck and, when requested, make one best-effort install."""
    path, output = locate_codecheck()
    if path:
        return {"available": True, "path": path, "installed": False,
                "detail": output[-500:]}
    if not install:
        return {"available": False, "path": "", "installed": False,
                "detail": "未找到 codecheck/fullcheck"}

    # A failed internal-registry install can be slow. Do not repeat it at every
    # scan/done gate; a manual install is still detected by locate_codecheck
    # above. The next process may retry after the short cooling window.
    state_path = _capability_state_path()
    try:
        with open(state_path, encoding="utf-8") as stream:
            previous = json.load(stream)
        stamp = time.mktime(time.strptime(
            previous.get("attempted_at", ""), "%Y-%m-%d %H:%M:%S"))
        if not previous.get("available") and time.time() - stamp < 1800:
            previous["cooldown"] = True
            return previous
    except (OSError, ValueError, TypeError):
        pass

    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        return {"available": False, "path": "", "installed": False,
                "detail": "未找到 npm，无法自动安装公司 CodeCheck CLI"}
    command = [
        npm, "install", "-g", CODECHECK_PACKAGE,
        "--registry=" + CODECHECK_REGISTRY,
    ]
    try:
        result = _run_host_cli(command, timeout=600)
        install_output = ((result.stdout or "") + (result.stderr or "")).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        install_output = str(exc)
        result = None

    path, probe_output = locate_codecheck()
    record = {
        "available": bool(path),
        "path": path,
        "installed": bool(path),
        "attempted_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "package": CODECHECK_PACKAGE,
        "detail": (probe_output if path else install_output)[-2000:],
    }
    try:
        atomic_write_json(state_path, record)
    except OSError:
        pass
    return record


def diagnostics(project_root=None, include_codecheck=False):
    checks = []

    def add(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})

    for runtime_check in _host_runtime_checks() + _optional_runtime_checks():
        add(
            runtime_check["name"],
            runtime_check["ok"],
            runtime_check["detail"])
    from . import specengine
    try:
        # 真实加载 schema:模板/规则数据缺失或损坏必须在这里就暴露
        schema = specengine._load_schema("spec-driven")
        add("内置规格引擎", bool(schema),
            "纯 Python（无需 Node）— schema spec-driven 已加载")
    except Exception as exc:
        add("内置规格引擎", False, exc)
    for pack in sorted(CAPABILITY_PACKS):
        try:
            render_pack(pack)
            add("内嵌规则 " + pack, True, "已加载")
        except CapabilityError as exc:
            add("内嵌规则 " + pack, False, exc)
    if include_codecheck:
        codecheck = ensure_codecheck(install=False)
        add("CodeCheck", codecheck["available"], codecheck["detail"])
    if os.path.isfile(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, encoding="utf-8") as stream:
                manifest = json.load(stream)
            add("版本清单", manifest.get("schema") == 1, MANIFEST_PATH)
            for component, metadata in sorted(
                    manifest.get("components", {}).items()):
                expected = metadata.get("sha256", "")
                component_root = os.path.join(VENDOR_ROOT, component)
                actual = _tree_sha256(component_root) if os.path.isdir(
                    component_root) else ""
                add(
                    "源码完整性 " + component,
                    bool(expected) and actual == expected,
                    "sha256=" + (actual or "missing"))
        except (OSError, ValueError) as exc:
            add("版本清单", False, exc)
    else:
        add("版本清单", False, MANIFEST_PATH)
    wrapper = os.path.join(PLUGIN_ROOT, "runtime", "bin", "openspec")
    add("OpenSpec 脚本入口", os.path.isfile(wrapper) and os.access(
        wrapper, os.X_OK), wrapper)
    return checks
