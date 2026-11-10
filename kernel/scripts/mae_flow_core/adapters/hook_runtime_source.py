"""Split Hook runtime adapter responsibilities."""

from .hook_runtime_dependencies import *  # noqa: F401,F403


class HookSourceMixin:
    def _source_changed_since_receipt(self, head, st):
        """dispatch 侧的轻量源码新鲜度检查，语义与 mae-flow 令牌检查一致。"""
        current = self._git_head()
        if not current:
            return [], "当前 HEAD 不可读"
        if self._git_out(f"git cat-file -t {head}").strip() != "commit":
            return [], "编译凭证 HEAD 不可解析"
        paths = [] if current == head else [p for p in self._git_out(
            f"git -c core.quotepath=false diff --name-only {head} {current}").splitlines() if p.strip()]
        paths += [p for p in self._changed_paths_since(current)
                  if p and not self._unchanged_initial_dirty(p, st)]
        return [p for p in dict.fromkeys(paths) if self._source_like(p)], ""


    def _call_failed(self, call):
        if not call:
            return False
        if not call.get("result_seen"):
            # 没有 tool_result 就没有成功事实。standalone 没有 done 现场复核，兼容放行
            # 会直接把半截 transcript 当成功；旧宿主应走现有 accept-risk 显式裁决。
            return True
        if call.get("is_error"):
            return True
        # Skill 的 tool_result 是插件自定义协议：不同语言/不同版本可能返回
        # 自然语言、JSON 或摘要，其中出现 failed/error 并不等于宿主调用失败。
        # 这里只对 Bash 的进程语义做兜底识别；Skill 是否完成业务目标由
        # Agent 的统一结构化 Return format 判断。
        if str(call.get("name", "")).lower() != "bash":
            return False
        text = call.get("result", "") or ""
        return bool(re.search(
            r"(?:^|\n)\s*(?:(?:process|command)\s+)?exited?\s+with\s+(?:exit\s+)?code"
            r"\s*[:= ]\s*[1-9]\d*|"
            r"(?:^|\n)\s*(?:exit[_ ]code|return[_ ]?code|errorlevel)"
            r"\s*[:= ]\s*[1-9]\d*|"
            r"(?:^|\n)\s*(?:process|command)\s+failed\s+with\s+(?:exit\s+)?code"
            r"\s*[:= ]\s*[1-9]\d*|"
            r"returned\s+non-zero\s+exit\s+status\s+[1-9]\d*|"
            r"(?:exit(?:ed)?\s*(?:code|status)?|return\s*code)\s*[:= ]\s*[1-9]\d*",
            text, re.I))


    def _skill_call(self, tool_calls, wanted):
        if not wanted:
            return None
        # 编译/生成 Skill 允许多轮修复；最终证据必须看最后一次匹配调用，
        # 与 Bash 证据一致。取首轮会把“先失败后成功”误拒，也可能忽略最终失败。
        for x in reversed(tool_calls or []):
            if str(x.get("name", "")).lower() != "skill":
                continue
            try:
                raw = json.dumps(x.get("input", {}), ensure_ascii=False).lower()
            except Exception:
                raw = str(x.get("input", "")).lower()
            if wanted in raw:
                return x
        return None


    def _skill_called(self, tool_calls, wanted):
        return bool(self._skill_call(tool_calls, wanted)) if wanted else True


    def _bash_call(self, tool_calls, expected):
        def n(s):
            return re.sub(r"\s+", " ", (s or "")).strip().lower()
        want = n(expected)
        if not want:
            return None
        for x in reversed(tool_calls or []):
            if str(x.get("name", "")).lower() != "bash":
                continue
            inp = x.get("input", {}) or {}
            cmd = inp.get("command", "") if isinstance(inp, dict) else str(inp)
            # 只接受某个真实命令段以目标命令开头；echo/printf "目标命令" 不算执行。
            segs = re.split(r"&&|\|\||[;\n]", n(cmd))
            if any(seg.strip().startswith(want) for seg in segs):
                return x
        return None


    def _bash_calls(self, tool_calls, expected):
        """按时间顺序返回命中目标命令的 Bash 调用及每次调用中的执行段数。"""
        want = re.sub(r"\s+", " ", (expected or "")).strip().lower()
        found = []
        if not want:
            return found
        for call in tool_calls or []:
            if str(call.get("name", "")).lower() != "bash":
                continue
            inp = call.get("input", {}) or {}
            command = inp.get("command", "") if isinstance(inp, dict) else str(inp)
            segments = re.split(r"&&|\|\||[;\n]", re.sub(r"\s+", " ", command).lower())
            count = sum(1 for seg in segments if seg.strip().startswith(want))
            if count:
                found.append((call, count))
        return found


    def _bash_called(self, tool_calls, expected):
        return bool(self._bash_call(tool_calls, expected))


    def _require_bash_success(self, tool_calls, expected, bail, label):
        call = self._bash_call(tool_calls, expected)
        if not call:
            bail(f"transcript 中没有真实执行配置的{label}命令；echo/文字提及不算执行。")
        if not call.get("result_seen"):
            bail(f"最后一次{label}命令缺少 tool_result，无法证明执行完成；"
                 "请恢复完整 transcript，旧宿主无法提供时由用户走 accept-risk 裁决。")
        if self._call_failed(call):
            bail(f"最后一次{label}命令的工具结果明确失败，不能报告成功。")
        return call


    def _section(self, report, name):
        return _core_report_section(report, name)


    def _empty_section(self, value):
        return _core_empty_section(value)


    def _changed_paths_since(self, head):
        out = self._git_out(
            f"git -c core.quotepath=false diff --name-only --no-renames {head}..HEAD")
        paths = [x.strip() for x in out.splitlines() if x.strip()]
        paths.extend(
            x.strip() for x in self._git_out(
                "git -c core.quotepath=false diff --name-only --no-renames HEAD"
            ).splitlines() if x.strip())
        for line in self._git_out(
                "git -c core.quotepath=false status --porcelain --untracked-files=all").splitlines():
            p = line.split(None, 1)
            if len(p) == 2:
                paths.append(p[1].split(" -> ")[-1].strip().strip('"'))
        return list(dict.fromkeys(x.replace("\\", "/") for x in paths))


    def _path_fingerprint(self, path):
        return _shared_path_fingerprint(path)


    def _review_path_fingerprint(self, path):
        return _shared_review_path_fingerprint(path)


    def _unchanged_initial_dirty(self, path, st):
        rel = str(path or "").replace("\\", "/").strip().strip('"')
        initial = set((st or {}).get("initial_dirty", []) or [])
        fingerprints = (st or {}).get("initial_dirty_fingerprints", {}) or {}
        return bool(rel in initial and fingerprints.get(rel) == self._path_fingerprint(rel))


    def _source_snapshot(self, head):
        return {
            p: self._review_path_fingerprint(p)
            for p in self._changed_paths_since(head)
            if self._source_like(p)
        }


    def _worktree_snapshot(self, head):
        """Fingerprint every Git-visible change for COMPILE provenance."""
        return {
            path: self._review_path_fingerprint(path)
            for path in self._provenance_changed_paths(head)
            if (
                os.path.lexists(path)
                and not source_paths.is_flow_control_path(path)
            )
        }

    def _provenance_git_out(self, arguments):
        """Run one required provenance Git read without empty-output collapse."""
        try:
            result = subprocess.run(
                ["git", "-c", "core.quotepath=false", *arguments],
                shell=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
            )
        except Exception as exc:
            raise RuntimeError(
                "COMPILE provenance Git command failed: %s" % exc
            ) from exc
        if result.returncode != 0:
            detail = (result.stderr or "").strip()
            raise RuntimeError(
                "COMPILE provenance Git command exited %s%s"
                % (
                    result.returncode,
                    (": " + detail) if detail else "",
                )
            )
        return result.stdout or ""

    def _provenance_changed_paths(self, head):
        if not head:
            raise RuntimeError("COMPILE provenance task HEAD is missing")
        if self._provenance_git_out(
                ["cat-file", "-t", head]).strip() != "commit":
            raise RuntimeError(
                "COMPILE provenance task HEAD is not a commit")
        paths = self._provenance_git_out([
            "diff", "--name-only", "--no-renames", head, "HEAD",
        ]).splitlines()
        paths.extend(self._provenance_git_out([
            "diff", "--name-only", "--no-renames", "HEAD",
        ]).splitlines())
        for line in self._provenance_git_out([
                "status", "--porcelain", "--untracked-files=all",
        ]).splitlines():
            fields = line.split(None, 1)
            if len(fields) == 2:
                paths.append(
                    fields[1].split(" -> ")[-1].strip().strip('"'))
        return list(dict.fromkeys(
            path.replace("\\", "/") for path in paths if path))


    _TEST_PAT = re.compile(
        r"(^|/)(tests?|__tests__|spec|[^/]+[_-]tests?)/|"
        r"(^|/)src/test/|(^|/)test_[^/]+\.py$|"
        r"(_test|\.test|\.spec)\."
        r"(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|tpp|py|go|rs|"
        r"js|jsx|cjs|mjs|ts|tsx|cts|mts)$|"
                           r"Tests?\.(c|cc|cpp|cxx|h|hh|hpp|hxx|java|kt|cs)$", re.I)
    _COMMON_SOURCE_PATTERN = (
        r"(^|/)(service|src|include|lib|app|modules?)/")


    def _source_like(self, path):
        """dispatch 侧源码判定，顺序与主状态机一致：文件名/扩展名 > 文档排除 > 目录/私有规则。"""
        normalized = str(path or "")
        known = source_paths.known_source_classification(normalized)
        if known is not None:
            return known
        if source_paths.is_source_path(
                normalized, [self._COMMON_SOURCE_PATTERN]):
            return True
        patterns = []
        value = self._state_config().get("源码路径", [])
        patterns += ([x.strip() for x in value.split(",") if x.strip()]
                     if isinstance(value, str) else list(value or []))
        try:
            value = load_json(
                ".mae-flow-defaults.json",
                encoding="utf-8-sig",
            ).get("源码路径", [])
            patterns += ([x.strip() for x in value.split(",") if x.strip()]
                         if isinstance(value, str) else list(value or []))
        except FileNotFoundError:
            pass
        except Exception as exc:
            self.log("defaults 源码路径解析失败(已忽略,请修复该 JSON): %s" % exc)
        return source_paths.is_source_path(
            normalized, [str(pattern) for pattern in patterns])


    def _test_like(self, path):
        if self._TEST_PAT.search(path):
            return True
        pats = []
        v = self._state_config().get("测试路径", [])
        pats += [x.strip() for x in v.split(",") if x.strip()] if isinstance(v, str) else list(v or [])
        try:
            # utf-8-sig:团队手写 defaults 常带 BOM;strict 失败必须留痕,
            # 否则「测试路径」静默失效会让 gate 口径变宽而无人知晓。
            v = load_json(
                ".mae-flow-defaults.json",
                encoding="utf-8-sig",
            ).get("测试路径", [])
            pats += [x.strip() for x in v.split(",") if x.strip()] if isinstance(v, str) else list(v or [])
        except FileNotFoundError:
            pass
        except Exception as e:
            self.log("defaults 测试路径 解析失败(已忽略,请修复该 JSON): %s" % e)
        for pat in pats:
            try:
                if re.search(pat, path, re.I):
                    return True
            except re.error:
                continue
        return False


    def _enforce_agent_scope(
            self, kind, task, bail, direct_write_paths=()):
        decision = _verify_agent_scope(
            kind,
            task,
            self._contract_state(),
            self.task_card_ports_factory(),
            direct_write_paths=direct_write_paths,
        )
        if not decision.accepted:
            bail(decision.reason)
        return list(decision.changed_paths)


HookSourceMixin._path_fingerprint.__wrapped__ = _shared_path_fingerprint
HookSourceMixin._review_path_fingerprint.__wrapped__ = (
    _shared_review_path_fingerprint)
