"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    BytesIO, CODE_EXTS, DEFAULT_TEST_PATS, LIGHTCHECK_REPORT_PATH,
    analyze_changed_with_timeout, atomic_write_text, os, re, render_markdown,
    subprocess, sys,
)
from .wiring import api

def _is_test_file(path, st):
    """UT/测试文件判定:配置了「测试路径」用配置,否则用默认特征。codecheck 只查业务代码(团队约定)。"""
    # 仓库配置用于补充私有目录，不应关闭 Test.cpp、dt_tests 等通用识别。
    pats = DEFAULT_TEST_PATS + api._test_patterns(st)
    return any(re.search(p, api.norm(path), re.I) for p in pats)

def _biz_changed_files(st):
    """本单变更中的业务代码文件(排除测试),codecheck 检查范围的唯一算法——agent 与证据同源。
    基线分支必须先验证可解析:diff 命令失败若被当成'无变更'会静默放行(冒烟抓过的真缺陷)。"""
    diff, err = api._scope_diff(st)
    if err:
        return None, err
    out = api.argv_out([
        "git", "-c", "core.quotepath=false", "diff", "--name-only", diff])
    files = [f for f in out.splitlines()
             if f and f.lower().endswith(CODE_EXTS) and os.path.exists(f) and not _is_test_file(f, st)]
    return files, ""

def _diff_output(diff, files, cached=False):
    args = [
        "git", "-c", "core.quotepath=false",
        "diff", "-U0", "--no-renames",
    ]
    if cached:
        args.append("--cached")
    if diff:
        args.append(diff)
    args += ["--", *files]
    return api.argv_out(args)

def _diff_header_path(line):
    value = line[4:].strip()
    if value == "/dev/null":
        return ""
    if value.startswith("b/"):
        value = value[2:]
    return _decode_diff_path(value)

def _decode_diff_path(value):
    if not value.startswith('"') or not value.endswith('"'):
        return api.norm(value)
    try:
        return api.norm(bytes(
            value[1:-1], "utf-8").decode("unicode_escape"))
    except UnicodeError:
        return ""

def _diff_hunk_range(line, deletion_anchor=True):
    match = re.match(
        r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
    if not match:
        return set()
    start = int(match.group(1))
    count = int(
        match.group(2) if match.group(2) is not None else "1")
    if count == 0:
        return {start} if deletion_anchor else set()
    return set(range(start, start + count))

def _record_changed_hunk(result, current, line, deletion_anchor=True):
    if current not in result or not line.startswith("@@ "):
        return
    result[current].update(_diff_hunk_range(line, deletion_anchor))

def _changed_lines_for_diff(
        diff, files, cached=False, deletion_anchors=True):
    """批量解析指定 Git diff 的 + 侧变更行，删除 hunk 锚定相邻行。"""
    result = {api.norm(path): set() for path in files}
    current = ""
    for line in _diff_output(diff, files, cached).splitlines():
        if line.startswith("+++ "):
            current = _diff_header_path(line)
            continue
        _record_changed_hunk(
            result, current, line, deletion_anchors)
    return result

def _content_changed_lines_for_diff(diff, files, cached=False):
    return _changed_lines_for_diff(
        diff, files, cached=cached, deletion_anchors=False)

def _changed_lines(st, files):
    """本单每文件的变更行集合(+侧,git diff -U0 解析)——范围过滤的唯一数据源。
    返回 ({norm(file): set(行号)}, err)。"""
    diff, err = api._scope_diff(st)
    if err:
        return None, err
    return _changed_lines_for_diff(diff, files), ""

def _lightcheck_tool_error(reason):
    return {
        "status": "TOOL_ERROR", "findings": [], "existing_debt": [],
        "skipped": [reason], "files": [], "functions_checked": 0,
        "duration_ms": 0,
    }

def _diff_baseline_commit(diff):
    """Resolve the left snapshot used to decide whether a warning is new."""
    if "..." in diff:
        left, right = diff.split("...", 1)
        return api.argv_out(["git", "merge-base", left, right or "HEAD"])
    if ".." in diff:
        return diff.split("..", 1)[0]
    return diff or "HEAD"

def _diff_current_commit(diff):
    if "..." in diff:
        return diff.split("...", 1)[1] or "HEAD"
    if ".." in diff:
        return diff.split("..", 1)[1] or "HEAD"
    return ""

def _git_object_spec(commit, path):
    return (":" + api.norm(path)
            if commit == ":"
            else "%s:%s" % (commit, api.norm(path)))

def _git_source_at(commit, path):
    if not commit:
        return None
    try:
        run = subprocess.run(
            ["git", "show", _git_object_spec(commit, path)],
            shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return run.stdout if run.returncode == 0 else None

def _cat_file_blob_size(header):
    if not header:
        return None
    if header.endswith(b" missing"):
        return None
    parts = header.rsplit(b" ", 2)
    if len(parts) != 3:
        return None
    if parts[-2] != b"blob":
        return None
    return _safe_int_bytes(parts[-1])

def _safe_int_bytes(value):
    try:
        return int(value)
    except ValueError:
        return None

def _read_cat_file_blob(stream):
    size = _cat_file_blob_size(stream.readline().rstrip(b"\n"))
    if size is None:
        return None
    source = stream.read(size).decode("utf-8", errors="replace")
    stream.read(1)
    return source

def _parse_cat_file_output(raw, files):
    stream = BytesIO(raw)
    return {
        path: _read_cat_file_blob(stream)
        for path in files
    }

def _fallback_git_sources(commit, paths):
    return {
        path: _git_source_at(commit, path)
        for path in paths
    }

def _cat_file_batch(commit, paths):
    payload = "".join(
        _git_object_spec(commit, path) + "\n" for path in paths).encode()
    try:
        run = subprocess.run(
            ["git", "cat-file", "--batch"], input=payload,
            capture_output=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return run.stdout if run.returncode == 0 else None

def _unsafe_batch_paths(paths):
    return any(
        "\n" in path or "\r" in path
        for path in paths)

def _batch_or_fallback_sources(commit, paths):
    if _unsafe_batch_paths(paths):
        return _fallback_git_sources(commit, paths)
    raw = _cat_file_batch(commit, paths)
    if raw is None:
        return _fallback_git_sources(commit, paths)
    return _parse_cat_file_output(raw, paths)

def _git_sources_at(commit, files):
    paths = list(dict.fromkeys(api.norm(path) for path in files))
    if not commit:
        return {path: None for path in paths}
    if not paths:
        return {}
    return _batch_or_fallback_sources(commit, paths)

def _save_lightcheck_result(result, scope):
    try:
        atomic_write_text(
            LIGHTCHECK_REPORT_PATH, render_markdown(result, scope))
        return api.norm(os.path.abspath(LIGHTCHECK_REPORT_PATH))
    except Exception as exc:
        # 前置检查的日志失败同样不能变成另一堵门。
        result.setdefault("skipped", []).append("报告写入失败: " + str(exc))
        return ""

def _lightcheck_code_files(files, require_worktree=True):
    return [
        api.norm(path) for path in files
        if api.norm(path).lower().endswith(CODE_EXTS)
        if not require_worktree or os.path.isfile(path)
    ]

def _lightcheck_diff_sources(diff, code_files):
    current_commit = _diff_current_commit(diff)
    if not current_commit:
        return None
    return _git_sources_at(current_commit, code_files)

def _available_snapshot_files(code_files, current_sources):
    if current_sources is None:
        return code_files
    return [
        path for path in code_files
        if current_sources.get(path) is not None
    ]

def _run_lightcheck_analysis(
        code_files, changed, baseline_sources, current_sources,
        magic_changed):
    return analyze_changed_with_timeout(
        os.getcwd(), code_files, changed,
        baseline_sources=baseline_sources,
        options={
            "current_sources": current_sources,
            "magic_changed_lines": magic_changed,
        })

def _run_lightcheck_diff(diff, files, scope):
    code_files = _lightcheck_code_files(files, require_worktree=False)
    baseline = _diff_baseline_commit(diff)
    if code_files and not baseline:
        result = _lightcheck_tool_error(
            "无法解析检查基线；已记录诊断，本建议项不阻断流程")
        result["report_path"] = _save_lightcheck_result(result, scope)
        return result
    changed = _changed_lines_for_diff(diff, code_files)
    magic_changed = _content_changed_lines_for_diff(diff, code_files)
    current_sources = _lightcheck_diff_sources(diff, code_files)
    code_files = _available_snapshot_files(code_files, current_sources)
    result = _run_lightcheck_analysis(
        code_files, changed, _git_sources_at(baseline, code_files),
        current_sources, magic_changed)
    result["report_path"] = _save_lightcheck_result(result, scope)
    return result

def _working_code_files(st, candidates=None):
    # 启动前未变化的用户现场必须排除；其余当前代码差异均可只读检查，
    # 这样 Edit/Write 与 Agent 经 Bash 实际改写两条路径都不会漏。
    if candidates is None:
        dirty = api._blocking_dirty_source_paths(st, api.FLOW) if st else api._dirty_paths()
    else:
        dirty = [
            path for path in candidates
            if not api._unchanged_initial_dirty(path, st)
        ]
    return _lightcheck_code_files(dirty)

def _untracked_changed_lines(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as stream:
            count = len(stream.read().splitlines())
    except OSError:
        count = 0
    return set(range(1, count + 1))

def _working_lightcheck_inputs(files):
    tracked = set(api.argv_out([
        "git", "-c", "core.quotepath=false",
        "ls-files", "--", *files,
    ]).splitlines())
    tracked = {api.norm(path) for path in tracked}
    changed = _changed_lines_for_diff(
        "HEAD", [path for path in files if path in tracked])
    magic_changed = _content_changed_lines_for_diff(
        "HEAD", [path for path in files if path in tracked])
    sources = _git_sources_at("HEAD", tracked)
    _add_untracked_lightcheck_inputs(
        files, tracked, changed, magic_changed, sources)
    return changed, magic_changed, sources

def _add_untracked_lightcheck_inputs(
        files, tracked, changed, magic_changed, sources):
    for path in files:
        if path not in tracked:
            changed[path] = _untracked_changed_lines(path)
            magic_changed[path] = set(changed[path])
            sources[path] = None

def _working_lightcheck_scope(st, candidates=None):
    """Inspect current-flow code dirt while preserving unchanged user dirt."""
    dirty = _working_code_files(st, candidates)
    changed, magic_changed, sources = _working_lightcheck_inputs(dirty)
    result = analyze_changed_with_timeout(
        os.getcwd(), dirty, changed, baseline_sources=sources,
        options={"magic_changed_lines": magic_changed})
    scope = ("提交前：本次提交候选代码"
             if candidates is not None
             else "提交前：本轮当前代码差异（排除未变化的启动前脏文件）")
    result["report_path"] = _save_lightcheck_result(
        result, scope)
    return result

def _read_worktree_sources(files):
    result = {}
    for path in files:
        try:
            with open(path, encoding="utf-8", errors="replace") as stream:
                result[path] = stream.read()
        except OSError:
            result[path] = None
    return result

def _eligible_pending_paths(st, snapshot):
    return [
        path for path in snapshot["paths"]
        if not api._unchanged_initial_dirty(path, st)
    ]

def _partition_snapshot_files(code_files, working_paths):
    working, indexed = [], []
    for path in code_files:
        target = working if path in working_paths else indexed
        target.append(path)
    return working, indexed

def _pending_lightcheck_groups(st, snapshot):
    candidates = _eligible_pending_paths(st, snapshot)
    code_files = _lightcheck_code_files(
        candidates, require_worktree=False)
    working, indexed = _partition_snapshot_files(
        code_files, snapshot["working_paths"])
    return code_files, working, indexed

def _pending_lightcheck_inputs(working, indexed):
    changed = _changed_lines_for_diff("HEAD", working)
    changed.update(_changed_lines_for_diff(
        "HEAD", indexed, cached=True))
    magic_changed = _content_changed_lines_for_diff("HEAD", working)
    magic_changed.update(_content_changed_lines_for_diff(
        "HEAD", indexed, cached=True))
    current_sources = _git_sources_at(":", indexed)
    current_sources.update(_read_worktree_sources(working))
    return changed, magic_changed, current_sources

def _pending_lightcheck_scope(st, snapshot):
    code_files, working, indexed = _pending_lightcheck_groups(
        st, snapshot)
    changed, magic_changed, current_sources = _pending_lightcheck_inputs(
        working, indexed)
    code_files = _available_snapshot_files(
        code_files, current_sources)
    result = _run_lightcheck_analysis(
        code_files, changed, _git_sources_at("HEAD", code_files),
        current_sources, magic_changed)
    result["report_path"] = _save_lightcheck_result(
        result, "提交前：本次提交候选快照")
    return result

def _print_lightcheck_findings(findings, report):
    print("[mae-flow] ⚠ 轻量编码预检发现 %d 个本轮新触发问题（建议修复，不阻断）:"
          % len(findings), file=sys.stderr)
    for item in findings[:12]:
        function = (" " + item["function"]) if item.get("function") else ""
        print("  %s %s:%s%s — %s (%s > %s)" % (
            item["rule"], item["file"], item["line"], function,
            item["message"], item["actual"], item["limit"]),
            file=sys.stderr)
    if len(findings) > 12:
        print("  …其余 %d 项见报告" % (len(findings) - 12), file=sys.stderr)
    if report:
        print("  人类可读报告: " + report, file=sys.stderr)
    print("  请按项目 formatter/附近同类代码修正后再提交；"
          "最多修复并复查两轮，仍不确定则留给正式 CodeCheck，禁止扩大范围。",
          file=sys.stderr)

def _print_lightcheck_degraded(result, report):
    print("[mae-flow] 轻量编码预检 %s（已记录诊断，本建议项不阻断流程）"
          % result.get("status", "SKIPPED"))
    for reason in (result.get("skipped") or [])[:5]:
        print("  - " + reason)
    if report:
        print("[mae-flow] 报告: " + report)

def _print_lightcheck_empty(result, report):
    if result.get("status") != "CLEAN":
        _print_lightcheck_degraded(result, report)
        return
    if not result.get("files"):
        print("[mae-flow] 本次没有候选源码变更，无需执行轻量编码预检。")
        if report:
            print("[mae-flow] 报告: " + report)
        return
    print("[mae-flow] 轻量编码预检 CLEAN（建议项，不替代正式 CodeCheck）")
    if report:
        print("[mae-flow] 报告: " + report)

def _print_lightcheck_result(result, quiet=False):
    findings = result.get("findings", [])
    report = result.get("report_path", "")
    if findings:
        _print_lightcheck_findings(findings, report)
        return
    if not quiet:
        _print_lightcheck_empty(result, report)

def cmd_lightcheck(st, args):
    try:
        result = _working_lightcheck_scope(st or {})
    except Exception as exc:
        # 此命令的合同就是 fail-open；即使适配层自身有 bug 也只报告。
        result = _lightcheck_tool_error(
            "轻量检查异常: " + str(exc))
        result["report_path"] = _save_lightcheck_result(
            result, "提交前：异常安全降级")
    _print_lightcheck_result(result, quiet=bool(getattr(args, "quiet", False)))
    return 0
