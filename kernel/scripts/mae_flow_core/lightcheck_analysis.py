"""Changed-file Lightcheck analysis."""

from .lightcheck_source import (
    LINE_LENGTH_LIMIT, MAX_FILES, MAX_FILE_BYTES, MAX_REPORTED_ITEMS,
    MAX_TOTAL_BYTES, SUPPORTED_EXTENSIONS, TAB_WIDTH, _code_lines,
    _generated_path, _load_lizard, _looks_generated, _normalized, os, time,
)
import subprocess
from .lightcheck_functions import (
    _FUNCTION_RULES, _baseline_matches, _empty_result, _finding,
    _function_metrics, _function_start, _mark_pre_existing,
    _valid_line_number,
)
from .lightcheck_magic import find_magic_numbers
from .lightcheck_nesting import annotate_control_nesting

def _current_head():
    """取当前 HEAD;取不到就写"未记录",绝不编。"""
    try:
        done = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"], shell=False,
            capture_output=True, text=True, timeout=10)
        return done.stdout.strip() if done.returncode == 0 else ""
    except Exception:                      # noqa: BLE001
        return ""


class _ChangedAnalyzer:
    def __init__(
            self, root, files, changed_lines, baseline_sources,
            current_sources=None, magic_changed_lines=None):
        self.root = root
        self.files = list(dict.fromkeys(files))
        self.changed_lines = changed_lines
        self.baseline_sources = baseline_sources
        self.current_sources = current_sources or {}
        self.magic_changed_lines = magic_changed_lines
        self.result = _empty_result()
        self.total_bytes = 0
        self.started = time.monotonic()
        self.lizard = None

    def _skip(self, message):
        self.result["skipped"].append(message)

    def _read_source(self, path):
        if path in self.current_sources:
            return self._read_snapshot_source(path)
        return self._read_worktree_source(path)

    def _within_budget(self, path, size, label):
        if size > MAX_FILE_BYTES:
            self._skip(path + ": " + label + "超过单文件轻量预算")
            return False
        if self.total_bytes + size > MAX_TOTAL_BYTES:
            self._skip(path + ": " + label + "超过本批轻量预算")
            return False
        self.total_bytes += size
        return True

    def _read_snapshot_source(self, path):
        source = self.current_sources[path]
        if source is None:
            self._skip(path + ": 提交快照中不存在")
            return None
        size = len(source.encode("utf-8", errors="replace"))
        return source if self._within_budget(path, size, "提交快照") else None

    def _read_worktree_source(self, path):
        absolute = os.path.join(self.root, path)
        try:
            size = os.path.getsize(absolute)
        except OSError as exc:
            self._skip(path + ": 无法安全读取(" + str(exc) + ")")
            return None
        if not self._within_budget(path, size, "工作区文件"):
            return None
        try:
            with open(absolute, encoding="utf-8", errors="replace") as stream:
                source = stream.read()
        except OSError as exc:
            self._skip(path + ": 无法安全读取(" + str(exc) + ")")
            return None
        return source

    @staticmethod
    def _lines_for(mapping, path):
        changed = set()
        for line in mapping.get(path, set()):
            try:
                changed.add(int(line))
            except (TypeError, ValueError):
                continue
        return changed

    def _changed_for(self, path):
        return self._lines_for(self.changed_lines, path)

    def _magic_changed_for(self, path, changed):
        if self.magic_changed_lines is None:
            return changed
        return self._lines_for(self.magic_changed_lines, path)

    def _parse(self, path, source):
        try:
            info = self.lizard.analyze_file.analyze_source_code(path, source)
            annotate_control_nesting(
                self.lizard, path, source, info.function_list)
            return info
        except Exception as exc:
            self._skip(path + ": 语法分析失败(" + str(exc) + ")")
            return None

    def _baseline_data(self, path):
        source = self.baseline_sources.get(path)
        if source is None:
            return None, [], None
        info = self._parse(path, source)
        if info is None:
            return source, [], None
        return source, info.function_list, _code_lines(path, source)

    @staticmethod
    def _line_finding(path, source_lines, code_lines, line_number):
        if not _valid_line_number(line_number, source_lines):
            return None
        if code_lines is None:
            return None
        if line_number not in code_lines:
            return None
        actual = len(source_lines[line_number - 1].expandtabs(TAB_WIDTH))
        if actual <= LINE_LENGTH_LIMIT:
            return None
        details = {
            "limit": LINE_LENGTH_LIMIT,
            "message": "本次修改的代码行超过 120 字符；"
                       "按项目 formatter 和附近同类代码换行",
        }
        return _finding(
            "MF-LINE-120", path, line_number, actual, details)

    def _add_line_findings(self, path, source, code_lines, changed):
        source_lines = source.splitlines()
        for line_number in sorted(changed):
            item = self._line_finding(
                path, source_lines, code_lines, line_number)
            if item is not None:
                self.result["findings"].append(item)

    def _inherited_literal(self, path, literal):
        """字面量在改动前就存在于本文件 → 只是路过，不是本轮新写。

        实测暴露的规则打架:仅仅因为在某行加了参数就被要求去改那行原有的魔鬼数字，
        而编码基准第 7 条要求"diff 里只出现需求要求的行"。触碰不等于引入。
        """
        baseline = (self.baseline_sources or {}).get(path)
        if not baseline or not literal:
            return False
        return str(literal) in baseline

    def _add_magic_findings(self, path, source, changed):
        findings = find_magic_numbers(path, source, changed)
        if findings is None:
            self._skip(path + ": 数值字面量词法分析不确定；已记录诊断，不阻断流程")
            return
        for finding in findings:
            if self._inherited_literal(path, finding.literal):
                continue
            self.result["findings"].append({
                "rule": "MF-MAGIC-NUMBER",
                "file": _normalized(path),
                "line": int(finding.line),
                "function": "",
                "literal": finding.literal,
                "reason": finding.reason,
                "message": finding.reason,
                "actual": 1,
                "limit": 0,
            })

    @staticmethod
    def _touches(function, changed):
        start = _function_start(function)
        end = max(start, int(function.end_line or start))
        return bool(changed.intersection(range(start, end + 1)))

    def _record_metric(self, path, function, metrics, old_metrics, rule_spec):
        rule, metric, limit, message = rule_spec
        actual = metrics[metric]
        if actual <= limit:
            return
        details = {
            "function": function.name,
            "limit": limit,
            "message": message,
        }
        item = _finding(
            rule, path, _function_start(function), actual, details)
        old = old_metrics.get(metric) if old_metrics else None
        if old is None:
            self.result["findings"].append(item)
            return
        item["baseline"] = int(old)
        if old > limit:
            self.result["findings"].append(
                _mark_pre_existing(item, old))
            return
        self.result["findings"].append(item)

    def _add_function(self, context, baseline_data, baseline, function):
        if not self._touches(function, context["changed"]):
            return
        metrics = _function_metrics(
            context["path"], context["source"], function,
            context["code_lines"])
        if metrics is None:
            self._skip("%s:%d %s: 有效行/参数解析不确定" % (
                context["path"], _function_start(function), function.name))
            return
        self.result["functions_checked"] += 1
        baseline_source, _baseline_functions, baseline_lines = baseline_data
        old_metrics = None
        if baseline is not None:
            old_metrics = _function_metrics(
                context["path"], baseline_source, baseline, baseline_lines)
        for rule_spec in _FUNCTION_RULES:
            self._record_metric(
                context["path"], function, metrics, old_metrics, rule_spec)

    def _analyze_source(self, path, source, changed, magic_changed):
        if _looks_generated(source):
            self._skip(path + ": 文件声明为自动生成")
            return
        current_info = self._parse(path, source)
        if current_info is None:
            return
        self.result["files"].append(path)
        code_lines = _code_lines(path, source)
        baseline_data = self._baseline_data(path)
        baseline_matches = _baseline_matches(
            current_info.function_list, baseline_data[1])
        self._add_line_findings(path, source, code_lines, changed)
        self._add_magic_findings(path, source, magic_changed)
        context = {
            "path": path, "source": source,
            "code_lines": code_lines, "changed": changed,
        }
        for function in current_info.function_list:
            self._add_function(
                context, baseline_data, baseline_matches.get(id(function)),
                function)

    def _analyze_file(self, raw_path):
        path = _normalized(raw_path)
        if _generated_path(path):
            self._skip(path + ": 生成/三方目录")
            return
        source = self._read_source(path)
        if source is None:
            return
        changed = self._changed_for(path)
        if not changed:
            return
        self._analyze_source(
            path, source, changed, self._magic_changed_for(path, changed))

    def _finish(self):
        order = lambda item: (item["file"], item["line"], item["rule"])
        self.result["findings"].sort(key=order)
        self.result["existing_debt"].sort(key=order)
        self._truncate_result("findings", "本轮建议")
        self._truncate_result("existing_debt", "基线旧债")
        if self.result["findings"]:
            self.result["status"] = "FINDINGS"
        if not self.result["files"] and self.result["skipped"]:
            self.result["status"] = "SKIPPED"
        elapsed = time.monotonic() - self.started
        self.result["duration_ms"] = int(elapsed * 1000)
        # 让报告能自证新鲜:latest.md 是覆盖写的,不带时间与版本就分不出
        # 是本轮结论还是上一轮遗留。
        self.result["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.result["head"] = _current_head()
        return self.result

    def _truncate_result(self, key, label):
        items = self.result[key]
        if len(items) <= MAX_REPORTED_ITEMS:
            return
        omitted = len(items) - MAX_REPORTED_ITEMS
        self.result[key] = items[:MAX_REPORTED_ITEMS]
        self._skip("%s超过轻量报告上限，省略 %d 项" % (label, omitted))

    def run(self):
        try:
            self.lizard = _load_lizard()
        except BaseException as exc:
            return _empty_result(
                "TOOL_ERROR", ["分析器不可用: " + str(exc)])
        for path in self.files[:MAX_FILES]:
            if path.lower().endswith(SUPPORTED_EXTENSIONS):
                self._analyze_file(path)
        if len(self.files) > MAX_FILES:
            self._skip("文件数超过 %d，仅检查前 %d 个" % (
                MAX_FILES, MAX_FILES))
        return self._finish()
