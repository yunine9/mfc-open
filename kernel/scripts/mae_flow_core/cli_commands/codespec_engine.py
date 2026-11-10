"""codespec 外部规格引擎 adapter(公司推行,openspec 同源换名)。

规格引擎的第二个 adapter——格式契约是主板,引擎是插槽:

- 启用方式:仓库预设 .mae-flow-defaults.json 写「规格引擎: codespec」
  (可选「规格引擎命令」自定义可执行,默认 PATH 上的 codespec;支持字符串或数组);
- "流程里真用":spec new/validate/archive 三处改走 codespec CLI 真实执行,
  每次调用的命令、退出码、时间都记进 state 的 engine_runs 与 history(可审计);
- **单一裁决源不动摇**:阶段真相仍只在 .mae-flow.json;codespec 只管产物,
  它写的 .openspec.yaml 元数据本来就被 gate 拦手工编辑;
- 工作区就是 codespec 自己的根目录 openspec/ 布局(引擎双根解析天然兼容,
  目录归一搬迁对 codespec 仓自动跳过);
- 失败语义与内置引擎一致:抛 SpecEngineError,spec 命令层统一接住并给出路,
  不引入新的拦截点。
"""

import os
import shlex
import subprocess
import time

from .shared import DEFAULTS_PATH, load_json, specengine

ENGINE_FIELD = "规格引擎"
COMMAND_FIELD = "规格引擎命令"
_RUN_CAP = 50


def _defaults():
    try:
        return load_json(DEFAULTS_PATH, encoding="utf-8-sig") or {}
    except Exception:
        return {}


def spec_engine_enabled():
    """仓库预设选择了 codespec 时为真;默认 builtin,不改变任何既有行为。"""
    value = str(_defaults().get(ENGINE_FIELD, "") or "").strip().lower()
    return value == "codespec"


def _argv_prefix():
    raw = _defaults().get(COMMAND_FIELD) or "codespec"
    if isinstance(raw, list):
        return [str(item) for item in raw]
    return shlex.split(str(raw), posix=(os.name != "nt"))


def _record_run(st, action, argv, exit_code):
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    runs = st.setdefault("spec", {}).setdefault("engine_runs", [])
    runs.append({"action": action, "argv": " ".join(argv),
                 "exit": exit_code, "at": now})
    del runs[:-_RUN_CAP]
    st.setdefault("history", []).append({
        "step": st.get("current", ""), "result": "spec:codespec:" + action,
        "note": "exit=%d" % exit_code, "at": now})


def _run(st, action, arguments, timeout=300):
    argv = _argv_prefix() + list(arguments)
    try:
        completed = subprocess.run(
            argv, shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
            cwd=os.getcwd())
    except FileNotFoundError:
        raise specengine.SpecEngineError(
            "规格引擎命令不存在: %s。检查 codespec 是否已安装,"
            "或在 .mae-flow-defaults.json 的「%s」里写明完整命令。"
            % (argv[0], COMMAND_FIELD))
    except subprocess.TimeoutExpired:
        raise specengine.SpecEngineError(
            "codespec %s 超时(%ds);工具问题先解决再重试,现场未改动。"
            % (action, timeout))
    _record_run(st, action, argv, completed.returncode)
    return completed


def _tail(completed):
    return ((completed.stderr or "") + (completed.stdout or "")).strip()[-400:]


def _ensure_workspace(st):
    config = os.path.join("openspec", "config.yaml")
    if os.path.isfile(config):
        return
    completed = _run(
        st, "init", ["init", ".", "--tools", "none", "--profile", "core"])
    if completed.returncode != 0 or not os.path.isfile(config):
        raise specengine.SpecEngineError(
            "codespec init 失败: " + (_tail(completed) or "无输出"))


def codespec_new(st, name, tier):
    specengine._validate_change_name(name)
    _ensure_workspace(st)
    completed = _run(st, "new", ["new", "change", name])
    change_dir = os.path.join("openspec", "changes", name)
    if completed.returncode != 0 or not os.path.isdir(change_dir):
        raise specengine.SpecEngineError(
            "codespec new change 失败: " + (_tail(completed) or "无输出"))
    st.setdefault("spec", {})["engine"] = "codespec"
    return {"schema": "spec-driven", "layout": "legacy", "tier": tier,
            "engine": "codespec",
            "change_dir": specengine._posix(os.path.abspath(change_dir))}


def codespec_validate(st, change):
    completed = _run(st, "validate", ["validate", change])
    messages = [
        line for line in
        ((completed.stdout or "") + "\n" + (completed.stderr or ""))
        .splitlines() if line.strip()
    ]
    return completed.returncode == 0, messages


def _spec_hashes(specs_dir):
    import hashlib
    hashes = {}
    for base, _dirs, names in os.walk(specs_dir):
        for name in names:
            if not name.endswith(".md"):
                continue
            path = os.path.join(base, name)
            try:
                with open(path, "rb") as stream:
                    digest = hashlib.sha256(stream.read()).hexdigest()
            except OSError:
                continue
            hashes[specengine._posix(os.path.relpath(path))] = digest
    return hashes


def codespec_archive(st, change):
    changes_dir = os.path.join("openspec", "changes")
    archive_dir = os.path.join(changes_dir, "archive")
    specs_dir = os.path.join("openspec", "specs")
    before_dirs = set(
        os.listdir(archive_dir)) if os.path.isdir(archive_dir) else set()
    before_specs = _spec_hashes(specs_dir)
    completed = _run(st, "archive", ["archive", change, "--yes"], timeout=600)
    if completed.returncode != 0:
        raise specengine.SpecEngineError(
            "codespec archive 失败(现场保持原样,可修正后重跑): "
            + (_tail(completed) or "无输出"))
    after_dirs = set(
        os.listdir(archive_dir)) if os.path.isdir(archive_dir) else set()
    created = sorted(after_dirs - before_dirs)
    archive_name = next(
        (name for name in created if name.endswith("-" + change)),
        created[0] if created else "")
    if not archive_name or os.path.isdir(os.path.join(changes_dir, change)):
        raise specengine.SpecEngineError(
            "codespec archive 结果异常:变更目录未移动或档案目录未生成;"
            "检查工具输出: " + (_tail(completed) or "无输出"))
    after_specs = _spec_hashes(specs_dir)
    merged = sorted(
        path for path, digest in after_specs.items()
        if before_specs.get(path) != digest)
    warnings = [
        line for line in (completed.stderr or "").splitlines() if line.strip()]
    return {"archive_name": archive_name,
            "archived_to": os.path.abspath(
                os.path.join(archive_dir, archive_name)),
            "merged": merged, "warnings": warnings, "totals": {}}
