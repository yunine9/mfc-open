"""Split Hook runtime adapter responsibilities."""

from .hook_runtime_dependencies import *  # noqa: F401,F403


class HookTraceMixin:
    def _git_trace(self, args):
        """Bounded read-only Git capture for diagnostics; never affects a gate."""
        try:
            result = subprocess.run(
                ["git", "-c", "core.quotepath=false", *args],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=2)
            return {
                "return_code": result.returncode,
                "stdout": result.stdout or "",
                "stderr": result.stderr or "",
            }
        except Exception as exc:
            return {"return_code": None, "stdout": "", "stderr": str(exc)}


    def _tool_trace_summary(self, call):
        value = call.get("input", {}) or {}
        summary = {}
        if isinstance(value, dict):
            for key in ("command", "file_path", "path", "skill", "name"):
                if value.get(key) not in (None, ""):
                    summary[key] = value.get(key)
        elif value:
            summary["input"] = str(value)[:2000]
        return summary


    def _record_codecheck_agent_trace(self,
            status, report, tool_calls, transcript_path, retry=False):
        """Persist the agent's commands, results and actual Git delta.

        This deliberately has no return-value contract: logging must never become
        a new reason to reject an otherwise valid CodeCheck run.
        """
        try:
            state = self._codecheck_log_state()
            task = (state.get("agent_tasks", {}) or {}).get("CODECHECK", {})
            head = str(task.get("head", "") or "")
            report_artifact = save_codecheck_artifact(
                os.getcwd(), state, "agent-final-report", report or "", ".md")
            changed = []
            source_changed = []
            diff_artifact = None
            name_status = {"return_code": None, "stdout": "", "stderr": ""}
            diff_stat = {"return_code": None, "stdout": "", "stderr": ""}
            worktree_status = {"return_code": None, "stdout": "", "stderr": ""}
            if re.fullmatch(r"[0-9a-fA-F]{7,64}", head):
                raw_diff = self._git_trace(["diff", "--no-ext-diff", "--binary", head, "--"])
                diff_artifact = save_codecheck_artifact(
                    os.getcwd(), state, "agent-working-tree", raw_diff["stdout"], ".diff")
                if raw_diff.get("stderr"):
                    diff_artifact["stderr"] = raw_diff["stderr"][-2000:]
                diff_artifact["return_code"] = raw_diff.get("return_code")
                name_status = self._git_trace(["diff", "--name-status", head, "--"])
                diff_stat = self._git_trace(["diff", "--stat", head, "--"])
                worktree_status = self._git_trace(["status", "--porcelain"])
                for line in name_status.get("stdout", "").splitlines():
                    fields = line.split("\t")
                    if len(fields) >= 2:
                        changed.append(fields[-1].strip().strip('"'))
                for line in worktree_status.get("stdout", "").splitlines():
                    value = line[3:] if len(line) > 3 else ""
                    if " -> " in value:
                        value = value.split(" -> ")[-1]
                    if value.strip():
                        changed.append(value.strip().strip('"'))
                changed = list(dict.fromkeys(
                    path.replace("\\", "/") for path in changed if path))
                source_changed = [path for path in changed if self._source_like(path)]

            traced_tools = {
                "bash", "write", "edit", "multiedit", "skill",
                "shell", "exec", "execcommand",
            }
            tool_rows = []
            artifact_count = 0
            for index, call in enumerate(tool_calls or [], 1):
                name = str(call.get("name", "") or "")
                normalized = re.sub(r"[^a-z]", "", name.lower())
                if normalized not in traced_tools:
                    continue
                input_text = json.dumps(
                    call.get("input", {}), ensure_ascii=False,
                    sort_keys=True, default=str)
                result_text = str(call.get("result", "") or "")
                if artifact_count < 40:
                    input_artifact = save_codecheck_artifact(
                        os.getcwd(), state, "agent-tool-%03d-input" % index,
                        input_text, ".json", max_bytes=64 * 1024)
                    result_artifact = save_codecheck_artifact(
                        os.getcwd(), state, "agent-tool-%03d-result" % index,
                        result_text, ".txt", max_bytes=64 * 1024)
                    artifact_count += 1
                else:
                    input_artifact = {
                        "omitted": "artifact-limit",
                        "bytes": len(input_text.encode("utf-8", errors="replace")),
                        "sha256": hashlib.sha256(
                            input_text.encode("utf-8", errors="replace")).hexdigest(),
                    }
                    result_artifact = {
                        "omitted": "artifact-limit",
                        "bytes": len(result_text.encode("utf-8", errors="replace")),
                        "sha256": hashlib.sha256(
                            result_text.encode("utf-8", errors="replace")).hexdigest(),
                    }
                row = {
                    "index": index, "name": name,
                    "summary": self._tool_trace_summary(call),
                    "result_seen": bool(call.get("result_seen")),
                    "is_error": bool(call.get("is_error")),
                    "input": input_artifact,
                    "result": result_artifact,
                }
                tool_rows.append(row)
                append_codecheck_event(
                    os.getcwd(), state, "agent.tool", row, source="hook")

            fixed = ""
            match = re.search(
                r"^\s*FIXED_CHANGES:\s*(.*?)(?=^\s*[A-Z][A-Z0-9_]+:\s*|\Z)",
                report or "", re.M | re.S)
            if match:
                fixed = match.group(1).strip()
            append_codecheck_event(
                os.getcwd(), state, "agent.stopped", {
                    "status": status,
                    "retry": bool(retry),
                    "task_path": task.get("path", ""),
                    "task_sha256": task.get("sha256", ""),
                    "task_head": head,
                    "transcript_path": os.path.abspath(transcript_path)
                    if transcript_path else "",
                    "report": report_artifact,
                    "fixed_changes_reported": fixed,
                    "changed_paths": changed,
                    "changed_source_paths": source_changed,
                    "name_status": name_status,
                    "diff_stat": diff_stat,
                    "worktree_status": worktree_status,
                    "diff": diff_artifact,
                    "traced_tool_count": len(tool_rows),
                    "tool_artifact_limit": 40,
                }, source="hook")
        except Exception as exc:
            self.log("codecheck trace EXC: " + str(exc))


    def _evidence_data(self):
        action = self._load_action()
        if action and not os.path.isfile(self.STATE):
            return dict(action.get("evidence", {}) or {})
        try:
            return load_json(
                self.EVIDENCE_STATE) if os.path.exists(self.EVIDENCE_STATE) else {}
        except Exception:
            return {}


    def _save_evidence(self, data):
        action = self._load_action()
        if action and not os.path.isfile(self.STATE):
            def merge_action(current):
                current.setdefault("evidence", {}).update(data)
                return current
            update_versioned_json(self.ACTION_STATE, "action", merge_action)
        else:
            def merge_evidence(current):
                current.update(data)
                return current
            update_json(
                self.EVIDENCE_STATE, merge_evidence, default={}, recover_corrupt=True)


    def _record_rejection(self, label, msg):
        """把真实拒签原因留给 done/doctor；Hook stderr 被宿主吞掉时也不能让主模型猜。"""
        try:
            action = self._load_action() if not os.path.isfile(self.STATE) else None
            st = self._contract_state()
            task = (st.get("agent_tasks", {}) or {}).get(label, {})
            rejection = {
                "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "step": st.get("current", ""),
                "head": self._git_head(),
                "task_sha256": task.get("sha256", ""),
                "reason": msg,
            }
            if action:
                def reject_action(current):
                    current.setdefault("rejections", {})[label] = rejection
                    return current
                update_versioned_json(self.ACTION_STATE, "action", reject_action)
            else:
                def reject_flow(data):
                    data[label] = rejection
                    return data
                update_json(
                    self.REJECTION_STATE, reject_flow, default={}, recover_corrupt=True)
            self.log(label + " 拒签: " + msg)
        except Exception as e:
            self.log("rejection EXC: " + str(e))


    def _clear_rejection(self, label):
        try:
            action = self._load_action() if not os.path.isfile(self.STATE) else None
            if action:
                def clear_action(current):
                    data = current.setdefault("rejections", {})
                    data.pop(label, None)
                    data.pop("SUBAGENT", None)
                    return current
                update_versioned_json(self.ACTION_STATE, "action", clear_action)
            else:
                if not os.path.exists(self.REJECTION_STATE):
                    return
                def clear_flow(data):
                    data.pop(label, None)
                    data.pop("SUBAGENT", None)
                    return data
                update_json(
                    self.REJECTION_STATE, clear_flow, default={}, recover_corrupt=True)
        except Exception as e:
            self.log("clear rejection EXC: " + str(e))


    def _contract_bail(self, label, msg, soft):
        self._record_rejection(label, msg)
        if label == "CODECHECK":
            self._codecheck_log_event("agent.contract_rejected", {
                "reason": msg, "soft_retry": bool(soft),
                "head": self._git_head(),
            })
        if soft:
            self.log(label + " 重答仍违规: " + msg)
            sys.exit(0)
        print("[mae-flow] " + label + " 契约违规:" + msg
              + " 请按 agent 定义的 Return format 重新真实收尾。", file=sys.stderr)
        sys.exit(2)
