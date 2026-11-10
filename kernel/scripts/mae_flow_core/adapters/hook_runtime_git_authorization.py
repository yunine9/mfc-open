"""Finalize exact user-authorized Git actions from PostToolUse."""

from .hook_runtime_dependencies import *  # noqa: F401,F403


class HookGitAuthorizationMixin:
    def _git_head(self):
        """Return current HEAD, or empty when Git is unavailable."""
        try:
            result = subprocess.run(
                "git rev-parse --verify HEAD",
                shell=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=hook_budget.timeout_for(5),
            )
            return (
                result.stdout.strip()
                if result.returncode == 0 else ""
            )
        except Exception:
            return ""

    def _git_argv_result(self, arguments):
        try:
            result = subprocess.run(
                ["git", *arguments],
                shell=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=hook_budget.timeout_for(8),
            )
        except Exception:
            return "", False
        return result.stdout.strip(), result.returncode == 0

    def _git_authorization_commit_result(
            self, receipt, result_head):
        pre_head = str(
            receipt.get("pre_head", "")
            or receipt.get("head", ""))
        if (
                receipt.get("operation")
                not in ("commit", "revert")
                or not re.fullmatch(
                    r"[0-9a-f]{7,64}", pre_head, re.I)
                or not re.fullmatch(
                    r"[0-9a-f]{7,64}", result_head, re.I)):
            return ()
        count, ok = self._git_argv_result([
            "rev-list", "--count",
            pre_head + ".." + result_head,
        ])
        if not ok or count != "1":
            return ()
        _unused, ancestor = self._git_argv_result([
            "merge-base", "--is-ancestor",
            pre_head, result_head,
        ])
        if not ancestor:
            return ()
        status_text, ok = self._git_argv_result([
            "-c", "core.quotepath=false", "diff",
            "--name-status", "--no-renames",
            pre_head, result_head, "--",
        ])
        if not ok:
            return ()
        actual = {}
        for line in status_text.splitlines():
            fields = line.split("\t", 1)
            if len(fields) == 2:
                actual[
                    source_paths.normalize_path(fields[1])
                ] = fields[0][:1]
        finalized = []
        expected_objects = dict(
            receipt.get("objects", ()) or ())
        for path, wanted in receipt.get("changes", ()) or ():
            normalized = source_paths.normalize_path(path)
            if actual.get(normalized) != wanted:
                return ()
            object_id = ""
            if wanted != "D":
                object_id, exists = self._git_argv_result([
                    "rev-parse", "--verify",
                    result_head + ":" + normalized,
                ])
                if not exists or not object_id:
                    return ()
                if (
                        receipt.get("operation") == "revert"
                        and object_id != expected_objects.get(
                            normalized, "")):
                    return ()
            finalized.append({
                "path": normalized,
                "change": wanted,
                "object": object_id,
            })
        return tuple(finalized)

    def _finalize_git_authorization(self, command):
        """Bind a consumed exact permit to its resulting commit."""
        if not command or "git" not in command.lower():
            return
        if hook_budget.exhausted():
            # 落定要连发数个 git 调用。预算不够就别开工:半途被看门狗打死会留下
            # "已消费但未落定"的权证,后续流程反而卡在缺收据上。
            self.log("git authorization finalize 跳过: Hook 时间预算不足")
            return
        raw, err = safe_read_json(self.STATE)
        if err or not raw:
            return
        state = normalize_document(raw, "flow")
        pending = [
            record
            for record in (
                state.get("git_authorizations", ()) or ())
            if (
                isinstance(record, dict)
                and record.get("consumed")
                and not record.get("finalized")
                and record.get("operation")
                in ("commit", "revert")
                and record.get("id") == _permit_block_id(
                    record.get("rule", ""), command)
            )
        ]
        if not pending:
            return
        result_head = self._git_head()
        finalized = {}
        for record in pending:
            changes = self._git_authorization_commit_result(
                record, result_head)
            if changes:
                finalized[record["id"]] = changes
        if not finalized:
            self.log(
                "git authorization not finalized: resulting commit "
                "did not match exact receipt")
            return

        def bind_result(current):
            for record in (
                    current.get("git_authorizations", ()) or ()):
                changes = (
                    finalized.get(record.get("id", ""))
                    if isinstance(record, dict) else None
                )
                if (
                        not changes
                        or record.get("finalized")
                        or record.get("operation")
                        not in ("commit", "revert")):
                    continue
                record["result_head"] = result_head
                record["result_changes"] = [
                    dict(change) for change in changes
                ]
                record["finalized"] = True
                record["finalized_at"] = time.strftime(
                    "%Y-%m-%d %H:%M:%S")
            return current

        try:
            update_versioned_json(
                self.STATE, "flow", bind_result)
            self.log(
                "git authorization finalized @"
                + result_head[:9])
        except Exception as exc:
            self.log(
                "git authorization finalize EXC: " + str(exc))
