"""Host runtime discovery and project preparation for bundled capabilities."""

from .capability_shared import COMET_SCRIPT_ROOT, OPENSPEC_ENTRY, PLUGIN_ROOT, os, shutil, subprocess, sys
from .capability_packs import CapabilityError

def _run(command, cwd=None, timeout=120, env=None):
    try:
        return subprocess.run(
            command, cwd=cwd, env=env, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CapabilityError("%s: %s" % (" ".join(command), exc))


def _run_host_cli(command, timeout=120, windows=None):
    """Run a host CLI, respecting Windows npm/codecheck .cmd launch rules."""
    use_windows = os.name == "nt" if windows is None else bool(windows)
    kwargs = {
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "timeout": timeout,
    }
    if (use_windows and command and str(command[0]).lower().endswith(
            (".cmd", ".bat"))):
        return subprocess.run(
            subprocess.list2cmdline(command), shell=True, **kwargs)
    return subprocess.run(command, **kwargs)


def _python():
    executable = os.path.abspath(sys.executable or "")
    if not executable or not os.path.isfile(executable):
        raise CapabilityError(
            "找不到当前 Python 解释器。请从能够正常运行 Python 3 的终端启动 CodeAgent。")
    if sys.version_info < (3, 8):
        raise CapabilityError(
            "Python 版本过低（当前 %s）；Mae-Flow 至少需要 Python 3.8。"
            % ".".join(str(item) for item in sys.version_info[:3]))
    return executable


def _git(windows=None):
    git = shutil.which("git") or shutil.which("git.exe")
    if git:
        return git
    use_windows = os.name == "nt" if windows is None else bool(windows)
    if use_windows:
        candidates = []
        for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            value = os.environ.get(variable, "")
            if not value:
                continue
            if variable == "LOCALAPPDATA":
                candidates.extend((
                    os.path.join(value, "Programs", "Git", "cmd", "git.exe"),
                    os.path.join(value, "Programs", "Git", "bin", "git.exe"),
                ))
            else:
                candidates.extend((
                    os.path.join(value, "Git", "cmd", "git.exe"),
                    os.path.join(value, "Git", "bin", "git.exe"),
                ))
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
    raise CapabilityError(
        "找不到 Git。Windows 请安装 Git for Windows，并确认 `git --version` 可执行。")


def _node(windows=None):
    node = shutil.which("node") or shutil.which("node.exe")
    if node:
        return node
    use_windows = os.name == "nt" if windows is None else bool(windows)
    if use_windows:
        candidates = []
        for variable in (
                "CODEAGENT_NODE_PATH", "NODE_EXE", "NVM_SYMLINK",
                "ProgramFiles", "LOCALAPPDATA"):
            value = os.environ.get(variable, "")
            if not value:
                continue
            if value.lower().endswith("node.exe"):
                candidates.append(value)
            elif variable == "NVM_SYMLINK":
                candidates.append(os.path.join(value, "node.exe"))
            elif variable == "ProgramFiles":
                candidates.append(os.path.join(value, "nodejs", "node.exe"))
            elif variable == "LOCALAPPDATA":
                candidates.append(os.path.join(
                    value, "Programs", "nodejs", "node.exe"))
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
    raise CapabilityError(
        "找不到 Node.js。CodeAgent 本身通常已经携带或依赖 Node；"
        "请确认启动 CodeAgent 的终端中 `node --version` 可执行。")


def _bash(windows=None):
    use_windows = os.name == "nt" if windows is None else bool(windows)
    bash = shutil.which("bash") or shutil.which("bash.exe")
    if bash and not (use_windows
                     and "system32" in os.path.abspath(bash).lower()):
        return bash
    # Windows 的 System32\bash.exe 是 WSL 桩(CI 实锤:无发行版时打
    # "wsl.exe --install" 提示并退非零)——它不是 Git Bash,PATH 命中也要跳过,
    # 继续走 Git Bash 候选链。
    if use_windows:
        candidates = []
        try:
            git = _git(windows=True)
            git_dir = os.path.dirname(os.path.abspath(git))
            candidates.extend((
                os.path.normpath(os.path.join(git_dir, "..", "bin", "bash.exe")),
                os.path.normpath(os.path.join(
                    git_dir, "..", "usr", "bin", "bash.exe")),
            ))
        except CapabilityError:
            pass
        for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            value = os.environ.get(variable, "")
            if not value:
                continue
            candidates.append(os.path.join(value, "Git", "bin", "bash.exe"))
            if variable == "LOCALAPPDATA":
                candidates.append(os.path.join(
                    value, "Programs", "Git", "bin", "bash.exe"))
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
    raise CapabilityError(
        "找不到 Git Bash。项目开发需要 Git，Windows 请确认 Git for Windows 的 bash.exe 在 PATH。")


def _version_detail(executable, arguments):
    result = _run([executable, *arguments], timeout=30)
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    first_line = output.splitlines()[0].strip() if output else "未返回版本信息"
    if result.returncode != 0:
        raise CapabilityError(
            "%s %s 执行失败（退出码 %s）: %s" % (
                executable, " ".join(arguments), result.returncode,
                first_line))
    return "%s — %s" % (first_line, os.path.abspath(executable))


def _host_runtime_checks():
    """Probe the small host runtime Mae-Flow actually depends on."""
    checks = []

    def probe(key, name, resolver, arguments=None, detail=None):
        try:
            executable = resolver()
            rendered = detail(executable) if detail else _version_detail(
                executable, arguments or [])
            checks.append({
                "key": key,
                "name": name,
                "ok": True,
                "detail": rendered,
                "path": executable,
            })
        except CapabilityError as exc:
            checks.append({
                "key": key,
                "name": name,
                "ok": False,
                "detail": str(exc),
                "path": "",
            })

    probe(
        "python", "Python", _python,
        detail=lambda executable: "Python %s — %s" % (
            ".".join(str(item) for item in sys.version_info[:3]),
            executable))
    probe("git", "Git", _git, ["--version"])
    probe("bash", "Git Bash", _bash, ["--version"])
    return checks


def _optional_runtime_checks():
    """参考件:缺失不影响任何流程能力。

    v4 起规格引擎是纯 Python,Node 只在需要与上游 CLI 做差分核对时才用到
    (开发期工具),不再是宿主前置——这是"零依赖"目标的最后一块。"""
    checks = []
    try:
        node = _node()
        result = _run([node, "--version"], timeout=20)
        detail = (result.stdout or result.stderr or "").strip().splitlines()
        checks.append({
            "key": "node", "name": "Node.js（可选，仅开发期对拍用）",
            "ok": True, "path": node,
            "detail": ((detail[0] if detail else "") + " — " + node).strip(" —"),
        })
    except CapabilityError as exc:
        checks.append({
            "key": "node", "name": "Node.js（可选，仅开发期对拍用）",
            "ok": True, "path": "",
            "detail": "未安装（不影响流程：规格引擎为纯 Python）— " + str(exc)[:120],
        })
    return checks


def _require_host_runtime():
    checks = _host_runtime_checks()
    failed = [item for item in checks if not item["ok"]]
    if failed:
        raise CapabilityError(
            "基础依赖不可用: " + "；".join(
                "%s: %s" % (item["name"], item["detail"])
                for item in failed))
    return {item["key"]: item for item in checks}


def run_openspec(arguments, cwd=None, timeout=120):
    if not os.path.isfile(OPENSPEC_ENTRY):
        raise CapabilityError("插件内嵌 OpenSpec 运行时缺失: " + OPENSPEC_ENTRY)
    env = os.environ.copy()
    env.setdefault("DO_NOT_TRACK", "1")
    env.setdefault("OPENSPEC_TELEMETRY", "0")
    return _run([_node(), OPENSPEC_ENTRY, *arguments], cwd=cwd, timeout=timeout, env=env)


def run_comet(script_name, arguments, cwd=None, timeout=180):
    names = {
        "state": "comet-state.sh",
        "guard": "comet-guard.sh",
        "handoff": "comet-handoff.sh",
        "archive": "comet-archive.sh",
        "validate": "comet-yaml-validate.sh",
    }
    filename = names.get(script_name)
    if not filename:
        raise CapabilityError("未知 Comet 内嵌脚本: " + str(script_name))
    script = os.path.join(COMET_SCRIPT_ROOT, filename)
    if not os.path.isfile(script):
        raise CapabilityError("插件内嵌脚本缺失: " + script)
    env = os.environ.copy()
    env.update({
        "COMET_BASH": _bash(),
        "COMET_STATE": os.path.join(COMET_SCRIPT_ROOT, "comet-state.sh"),
        "COMET_GUARD": os.path.join(COMET_SCRIPT_ROOT, "comet-guard.sh"),
        "COMET_HANDOFF": os.path.join(COMET_SCRIPT_ROOT, "comet-handoff.sh"),
        "COMET_ARCHIVE": os.path.join(COMET_SCRIPT_ROOT, "comet-archive.sh"),
        "COMET_OPENSPEC": os.path.join(PLUGIN_ROOT, "runtime", "bin", "openspec"),
        "MAE_FLOW_NODE": _node(),
        "DO_NOT_TRACK": "1",
        "OPENSPEC_TELEMETRY": "0",
    })
    # 维护者修复逃生口不能从调用方环境静默继承:带着它,comet-state 的
    # phase 直写保护(transition 前置校验)会被整体绕过。
    env.pop("COMET_FORCE_PHASE", None)
    return _run([env["COMET_BASH"], script, *arguments],
                cwd=cwd, timeout=timeout, env=env)


def prepare_project(project_root):
    """Prepare deterministic project metadata before flow state is activated.

    This operation deliberately creates no ``.cac``/``.claude`` content and does
    not install global packages.  Failure occurs before ``.mae-flow.json`` exists,
    so Hooks remain in their normal fail-open inactive mode.
    """
    root = os.path.abspath(project_root)
    runtime = _require_host_runtime()
    if not os.path.isdir(root):
        raise CapabilityError("项目目录不存在: " + root)
    if not os.path.exists(os.path.join(root, ".git")):
        raise CapabilityError("当前目录不是 Git 项目根（缺少 .git）: " + root)
    git_root = _run(
        [runtime["git"]["path"], "-C", root, "rev-parse", "--show-toplevel"],
        timeout=30)
    discovered_root = (git_root.stdout or "").strip().splitlines()
    if git_root.returncode != 0 or not discovered_root:
        raise CapabilityError(
            "Git 仓库检查失败: "
            + ((git_root.stdout or "") + (git_root.stderr or "")).strip()[-600:])
    actual_root = os.path.abspath(discovered_root[-1])
    if os.path.normcase(os.path.realpath(actual_root)) != os.path.normcase(
            os.path.realpath(root)):
        raise CapabilityError(
            "请在 Git 项目根目录启动 Mae-Flow。当前目录: %s；项目根: %s"
            % (root, actual_root))

    # v4:规格目录由内置引擎创建,不再调 Node CLI——Node 从此不是宿主前置。
    from . import specengine
    config = os.path.join(specengine._openspec_dir(root), "config.yaml")
    if not os.path.isfile(config):
        try:
            specengine.ensure_config(root)
        except specengine.SpecEngineError as exc:
            raise CapabilityError("无法创建项目规格目录: " + str(exc))
        if not os.path.isfile(config):
            raise CapabilityError("规格配置创建后仍不存在: " + config)

    return {
        "spec_engine": "builtin",
        "project": root,
        "python": runtime["python"]["detail"],
        "git": runtime["git"]["detail"],
        "bash": runtime["bash"]["detail"],
        "created_project_skills": False,
    }
