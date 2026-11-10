"""Legacy quality evaluators kept for offline compatibility tests.

The active SubagentStop path deliberately does not call this mixin.  Agent
return text is opaque lifecycle detail; real compile/test execution is handled
by explicit quality workflow actions rather than prose contracts.
"""

from .hook_runtime_dependencies import *  # noqa: F401,F403


class HookContractsMixin:
    def _codecheck_contract(self, status, report, tool_calls=None, soft=False):
        """Validate CodeCheck through the pure contract and persist its effects."""
        def bail(msg):
            self._contract_bail("CODECHECK", msg, soft)

        task = self._task_card_contract("CODECHECK", report, soft)
        changed = self._enforce_agent_scope("CODECHECK", task, bail)
        self._record_codecheck_build_receipt(task, tool_calls)

        state = self._contract_state()
        scan = (state.get("quality", {}) or {}).get(
            "codecheck_scan", {})
        command_count = (
            len(scan.get("commands") or [])
            if scan.get("step") == state.get("current") else 1
        )
        command_count = max(1, command_count)
        reusable = {}
        fullcheck_calls = self._bash_calls(
            tool_calls, "codecheck fullcheck")
        if soft and not fullcheck_calls:
            receipt = self._reusable_codecheck_fullcheck_receipt(
                task, command_count, scan)
            if receipt:
                reusable["CODECHECK_FULLCHECK"] = receipt
        build_cfg = self._state_config().get("编译方式", "")
        current_build = self._codecheck_build_call(tool_calls, build_cfg)
        if soft and not current_build:
            receipt = self._reusable_codecheck_build_receipt(task)
            if receipt:
                reusable["CODECHECK_BUILD"] = receipt

        decision = _evaluate_codecheck_contract(self._contract_context(
            "CODECHECK",
            status,
            report,
            task,
            tool_calls,
            changed,
            reusable_receipts=reusable,
            facts={
                "current": state.get("current", ""),
                "scan": scan,
                "soft": bool(soft),
            },
        ))
        details = dict(decision.details)
        receipt = details.get("fullcheck_receipt")
        if receipt:
            self._record_codecheck_fullcheck_receipt(
                task,
                receipt["command_count"],
                receipt["raw_counts"],
                receipt["scan"],
                receipt.get("expected_raw"),
                result_hashes=receipt.get("result_hashes"),
            )
        if details.get("reused_fullcheck"):
            reused = reusable.get("CODECHECK_FULLCHECK", {})
            self.log("CODECHECK 重答复用完整 fullcheck 凭证 @"
                 + reused.get("head", "")[:9])
        if details.get("reused_build"):
            reused = reusable.get("CODECHECK_BUILD", {})
            self.log("CODECHECK 重答复用编译凭证 @"
                 + reused.get("head", "")[:9])
        if details.get("build_summary_inaccurate"):
            self.log("CODECHECK EXECUTED_BUILD 摘要不准确,"
                 "以 transcript 的真实编译调用为准")
        if not decision.accepted:
            bail(decision.reason)

        if details.get("result") == "accepted-honest-failure":
            self._codecheck_log_event("agent.contract_validated", {
                "status": status,
                "task_sha256": task.get("sha256", ""),
                "task_head": task.get("head", ""),
                "changed_source_paths": changed,
                "result": "accepted-honest-failure",
            })
            return
        self._codecheck_log_event("agent.contract_validated", {
            "status": status,
            "task_sha256": task.get("sha256", ""),
            "task_head": task.get("head", ""),
            "changed_source_paths": changed,
            "found": details["found"],
            "fixed": details["fixed"],
            "remaining": details["remaining"],
            "fullcheck_raw_counts": details["fullcheck_raw_counts"],
            "fullcheck_expected_raw": details["fullcheck_expected_raw"],
            "fullcheck_command_count": details["command_count"],
            "result": "accepted",
        })

    def _ut_contract(self, status, report, tool_calls=None, soft=False):
        def bail(msg):
            self._contract_bail("UT", msg, soft)

        task = self._task_card_contract("UT", report, soft)
        direct_paths = (
            _successful_direct_write_paths(
                self._tool_call_values(tool_calls), os.getcwd())
            if tool_calls else ()
        )
        changed = (
            self._enforce_agent_scope(
                "UT", task, bail, direct_write_paths=direct_paths)
            if direct_paths
            else self._enforce_agent_scope("UT", task, bail)
        )
        if status not in ("PASS", "NEEDS_INPUT", "FAIL"):
            bail("未知结果状态 " + status)
            return
        if status != "PASS":
            return
        require_baseline = bool(changed)
        self._record_ut_receipts(
            task, report, tool_calls, require_baseline)

        config = self._state_config()
        reusable = {}
        need = self._required_skill(config.get("UT生成方式", ""))
        calls = self._tool_call_values(tool_calls)
        generator = _core_skill_call(calls, need) if need else None
        if soft and need and not generator:
            receipt = self._reusable_ut_receipt(
                "UT_GENERATOR", task, config.get("UT生成方式", ""))
            if receipt:
                reusable["UT_GENERATOR"] = receipt
        executed = self._flex_field(report, "EXECUTED_UT") or ""
        run = _core_reported_bash_call(calls, executed)
        if soft and not run:
            receipt = self._reusable_ut_receipt("UT_RUN", task)
            if receipt:
                reusable["UT_RUN"] = receipt

        decision = _evaluate_unit_test_contract(self._contract_context(
            "UT",
            status,
            report,
            task,
            tool_calls,
            changed,
            reusable_receipts=reusable,
            facts={"soft": bool(soft)},
        ))
        if decision.details.get("generator_summary_inaccurate"):
            self.log("UT GENERATOR_USED 摘要不准确,"
                 "以 transcript 的真实 Skill 调用为准")
        if not decision.accepted:
            bail(decision.reason)

    def _grill_contract(self, status, report, tool_calls=None, soft=False):
        """Grill critic 只做遗漏审查；GAPS 是有效产出，不因发现问题被当成执行失败。"""
        def bail(msg):
            self._contract_bail("GRILL", msg, soft)

        task = self._task_card_contract("GRILL", report, soft)
        changed = self._enforce_agent_scope("GRILL", task, bail)
        decision = _evaluate_grill_contract(self._contract_context(
            "GRILL", status, report, task, tool_calls, changed))
        if not decision.accepted:
            bail(decision.reason)


    def _git_out(self, cmd):
        """dispatch 内轻量 git 调用(编码/超时按军规)。失败返回空串,调用方按'不可算'处理。"""
        try:
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=8)
            if r.returncode == 0:
                return r.stdout
            self.log("git output unavailable (exit %s): %s" % (
                r.returncode, cmd))
        except Exception as exc:
            self.log("git output EXC: %s (%s)" % (exc, cmd))
            return ""
        return ""


    def _compile_net_lines(self, head):
        """编译修复的净行数,git 亲算(agent 报数不作数):
        未提交改动 + 自 HEAD 回溯的连续「修复编译」commit,只统计代码文件。
        这是防掏空的机器不变量:删代码换编译通过,在这里得不了分。"""
        def net_of(out):
            n = 0
            for line in out.splitlines():
                p = line.split("\t")
                if len(p) == 3 and p[0].isdigit() and p[1].isdigit() and self._source_like(p[2]):
                    n += int(p[0]) - int(p[1])
            return n

        untracked = 0
        for path in self._git_out(
                "git ls-files --others --exclude-standard").splitlines():
            if not self._source_like(path):
                continue
            try:
                with open(path, "rb") as stream:
                    untracked += sum(1 for _line in stream)
            except OSError:
                pass
        return (
            net_of(self._git_out(
                f"git -c core.quotepath=false diff --numstat {head}..HEAD"))
            + net_of(self._git_out(
                "git -c core.quotepath=false diff --numstat HEAD"))
            + untracked)


    def _compile_agent_net(self, task):
        """Only attribute source growth/shrinkage after the compile task was issued."""
        net = self._compile_net_lines(task.get("head", ""))
        if task.get("precommit_review"):
            net -= int(task.get("initial_compile_net", 0) or 0)
        return net


    def _compile_contract(self, status, report, tool_calls=None, soft=False):
        """编译 agent 收尾硬校验:格式对账(OK⇔零error)+ 净产出不变量(numstat 亲算防掏空)。
        优雅三件套之硬层:作弊(删代码换通过)从'被禁止'变'得不了分'。"""
        def bail(msg):
            self._contract_bail("COMPILE", msg, soft)

        task = self._task_card_contract("COMPILE", report, soft)
        changed = self._enforce_agent_scope("COMPILE", task, bail)
        current_build = self._build_call(
            tool_calls, self._state_config().get("编译方式", ""))
        self._record_compile_run_receipt(
            task, status, tool_calls)
        reusable = {}
        if not current_build:
            receipt = self._reusable_compile_run_receipt(task, status)
            if receipt:
                reusable["COMPILE_RUN"] = receipt
        decision = _evaluate_compile_contract(self._contract_context(
            "COMPILE",
            status,
            report,
            task,
            tool_calls,
            changed,
            compile_net=self._compile_agent_net(task),
            reusable_receipts=reusable,
        ))
        if decision.details.get("reused_execution"):
            receipt = reusable.get("COMPILE_RUN", {})
            self.log("COMPILE 重答复用编译凭证 @"
                 + receipt.get("head", "")[:9])
        if decision.details.get("build_summary_inaccurate"):
            self.log("COMPILE EXECUTED_BUILD 摘要不准确,"
                 "以真实调用或绑定凭证为准")
        if decision.details.get("reported_error_conflict"):
            self.log("COMPILE BUILD_ERRORS 与最终状态冲突,"
                 "按 build-fix/编译命令的真实完成状态处理")
        if not decision.accepted:
            bail(decision.reason)
        self._record_compile_side_effects(task, tool_calls)
