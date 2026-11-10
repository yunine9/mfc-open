"""Split Hook runtime adapter responsibilities."""

from .hook_runtime_dependencies import *  # noqa: F401,F403


class HookContractSupportMixin:
    def _tool_call_values(self, tool_calls):
        return tuple(_ToolCall(
            call_id=call.get("id", ""),
            name=call.get("name", ""),
            input=call.get("input", {}),
            result_seen=bool(call.get("result_seen")),
            is_error=bool(call.get("is_error")),
            result=str(call.get("result", "") or ""),
        ) for call in (tool_calls or []))


    def _contract_context(
            self, kind, status, report, task, tool_calls, changed=(),
            compile_net=0, reusable_receipts=None, facts=None):
        return _AgentContractContext(
            kind=kind,
            status=status,
            report=report,
            task=task,
            config=self._state_config(),
            calls=self._tool_call_values(tool_calls),
            changed_paths=tuple(changed),
            compile_net=compile_net,
            reusable_receipts=reusable_receipts or {},
            facts=facts or {},
        )


    def _task_card_contract(self, kind, report, soft=False):
        """报告必须回传 harness 任务卡指纹；缺配置时不再允许子 agent 边猜边做。"""
        st = self._contract_state()
        decision = _verify_completion_task(
            kind, report, st, self.task_card_ports_factory())
        if not decision.accepted:
            self._contract_bail(kind, decision.reason, soft)
        self._validated_task_bindings[kind] = dict(
            decision.task or {})
        return decision.task


    def _state_config(self):
        return (self._contract_state().get("config", {}) or {})


    def _field(self, report, name):
        m = re.search(r"^\s*" + re.escape(name) + r":\s*(.+?)\s*$", report, re.M)
        return m.group(1).strip() if m else ""


    def _flex_field(self, report, name):
        """弱模型常把机器字段挤在一行或加 Markdown bullet；按下一个已知字段切开而非卡排版。"""
        return _core_report_field(report, name)


    def _number_field(self, report, name):
        return _core_report_number(report, name)


    def _same_config(self, actual, expected):
        def n(s):
            return re.sub(r"\s+", "", (s or "")).lower()
        return bool(n(actual)) and bool(n(expected)) and n(expected) in n(actual)


    def _required_skill(self, config_value):
        v = (config_value or "").lower()
        if "java-autout" in v:
            return "java-autout"
        if "autout" in v:
            return "autout"
        if "build-fix" in v:
            return "build-fix"
        return ""


    def _embedded_build_command(self, build_cfg):
        return "mcde build -i" if "build-fix" in (build_cfg or "").lower() else ""


    def _build_call(self, tool_calls, build_cfg):
        """Find the real compilation call selected by the confirmed build route."""
        need = self._required_skill(build_cfg)
        if need:
            return self._skill_call(tool_calls, need)
        embedded = self._embedded_build_command(build_cfg)
        return self._bash_call(tool_calls, embedded or build_cfg)


    def _build_summary_matches(self, summary, build_cfg):
        if self._same_config(summary, build_cfg):
            return True
        embedded = self._embedded_build_command(build_cfg)
        return bool(embedded and (
            "build-fix" in (summary or "").lower()
            or self._same_config(summary, embedded)))


    def _codecheck_build_call(self, tool_calls, build_cfg):
        """返回当前 transcript 中与配置一致且未明确失败的编译调用。"""
        call = self._build_call(tool_calls, build_cfg)
        return call if call and not self._call_failed(call) else None


    def _receipt_context(self, task, bind_precommit=False):
        snapshot = (
            self._source_snapshot(task.get("head", ""))
            if (
                task.get("standalone")
                or (bind_precommit and task.get("precommit_review"))
            )
            else None
        )
        return _ReceiptContext(
            at=time.strftime("%Y-%m-%d %H:%M:%S"),
            head=self._git_head(),
            source_snapshot=snapshot,
        )


    def _record_compile_run_receipt(self, task, status, tool_calls):
        """Persist only a digest of a completed opaque compile invocation."""
        if status not in ("OK", "BLOCKED"):
            return None
        build_cfg = self._state_config().get("编译方式", "")
        call = self._build_call(tool_calls, build_cfg)
        if (
                not build_cfg
                or not call
                or not call.get("result_seen")
                or (status == "OK" and self._call_failed(call))):
            return None
        try:
            rec = _plan_compile_run_receipt(
                task,
                self._receipt_context(task, bind_precommit=True),
                build_cfg,
                status,
                call.get("result", ""),
            )
            data = self._evidence_data()
            data["COMPILE_RUN"] = rec
            self._save_evidence(data)
            self.log("COMPILE 编译凭证: %s @%s" % (
                status, rec.get("head", "")[:9] or "no-git"))
            return rec
        except Exception as exc:
            self.log("compile receipt EXC: " + str(exc))
            return None


    def _record_codecheck_build_receipt(self, task, tool_calls):
        """报告格式即使被打回，也保留已经真实发生的编译证据，供同一 HEAD 的重答复用。"""
        build_cfg = self._state_config().get("编译方式", "")
        if not build_cfg or not self._codecheck_build_call(tool_calls, build_cfg):
            return None
        rec = _plan_codecheck_build_receipt(
            task, self._receipt_context(task), build_cfg)
        try:
            data = self._evidence_data()
            data["CODECHECK_BUILD"] = rec
            self._save_evidence(data)
            self.log("CODECHECK 编译凭证: @%s" % (rec["head"][:9] or "no-git"))
        except Exception as e:
            self.log("codecheck receipt EXC: " + str(e))
        return rec


    def _record_codecheck_fullcheck_receipt(self,
            task, command_count, raw_counts, scan, expected_raw=None,
            result_hashes=None):
        """保存最终分批的执行事实，供“只修报告”跨 agent 复用。

        精确计数可解析时同时保存机器对账；未知成功输出只保存执行凭证，并把
        CodeCheck 结论视为建议项。源码、任务卡或首检口径任一变化都会让凭证失效。
        """
        rec = _plan_codecheck_fullcheck_receipt(
            task,
            self._receipt_context(task),
            command_count,
            raw_counts,
            scan,
            expected_raw=expected_raw,
            result_hashes=result_hashes,
        )
        counts_complete = rec["machine_counts_complete"]
        try:
            data = self._evidence_data()
            data["CODECHECK_FULLCHECK"] = rec
            self._save_evidence(data)
            self.log("CODECHECK fullcheck 凭证: %s 批/%s @%s"
                 % (command_count,
                    (str(rec["raw_total"]) + " 条" if counts_complete else "计数格式未知"),
                    rec["head"][:9]))
        except Exception as exc:
            self.log("codecheck fullcheck receipt EXC: " + str(exc))
            return None
        return rec


    def _record_ut_receipts(self, task, report, tool_calls, require_baseline=False):
        """保存真实 AutoUT 与 UT 执行事实；后续仅修报告且代码未变时无需重做重活。"""
        cfg = self._state_config()
        need = self._required_skill(cfg.get("UT生成方式", ""))
        calls = self._tool_call_values(tool_calls)
        generator = _core_skill_call(calls, need) if need else None
        executed = self._flex_field(report, "EXECUTED_UT") or ""
        run = _core_reported_bash_call(calls, executed)
        records = {}
        context = self._receipt_context(task)
        if generator and not _core_call_failed(generator):
            records["UT_GENERATOR"] = _plan_ut_generator_receipt(
                task, context, cfg.get("UT生成方式", ""))
        reported_counts = _core_ut_report_counts(report)
        counts_complete = all(v is not None for v in reported_counts.values())
        if run and counts_complete and not _core_call_failed(
                run) and not _core_ut_execution_risk(
                    report,
                    run,
                    cfg.get("UT运行命令", ""),
                    calls,
                    require_baseline):
            actual = _core_reported_bash_segment(run, executed) or executed
            records["UT_RUN"] = _plan_ut_run_receipt(
                task,
                context,
                actual,
                reported_counts,
                run.result,
            )
        if not records:
            return
        try:
            data = self._evidence_data()
            data.update(records)
            self._save_evidence(data)
            self.log("UT 执行凭证: " + "/".join(sorted(records))
                 + " @" + context.head[:9])
        except Exception as e:
            self.log("ut receipt EXC: " + str(e))


    def _reuse_source_facts(
            self, receipt, task, bind_precommit=False):
        if (
                task.get("standalone")
                or (bind_precommit and task.get("precommit_review"))):
            return self._source_snapshot(task.get("head", "")), (), ""
        changed, err = self._source_changed_since_receipt(
            receipt.get("head", ""), self._contract_state())
        return None, tuple(changed), err


    def _reusable_ut_receipt(self, key, task, expected=None):
        rec = self._evidence_data().get(key, {})
        if not rec:
            return None
        snapshot, changed, err = self._reuse_source_facts(rec, task)
        return _core_reusable_ut_receipt(
            rec,
            task,
            expected=expected,
            standalone_snapshot=snapshot,
            changed_paths=changed,
            source_error=err,
        )


    def _reusable_compile_run_receipt(self, task, status):
        rec = self._evidence_data().get("COMPILE_RUN", {})
        if not rec:
            return None
        snapshot, changed, err = self._reuse_source_facts(
            rec, task, bind_precommit=True)
        return _core_reusable_compile_run(
            rec,
            task,
            self._state_config().get("编译方式", ""),
            status,
            source_snapshot=snapshot,
            changed_paths=changed,
            source_error=err,
        )

    def _reusable_codecheck_build_receipt(self, task):
        """仅同任务卡、同步骤且源码未变化时复用；代码一变就必须重新编译。"""
        rec = self._evidence_data().get("CODECHECK_BUILD", {})
        if not rec:
            return None
        snapshot, changed, err = self._reuse_source_facts(rec, task)
        return _core_reusable_codecheck_build(
            rec,
            task,
            self._state_config().get("编译方式", ""),
            standalone_snapshot=snapshot,
            changed_paths=changed,
            source_error=err,
        )


    def _reusable_codecheck_fullcheck_receipt(self, task, command_count, scan):
        rec = self._evidence_data().get("CODECHECK_FULLCHECK", {})
        if not rec:
            return None
        snapshot, changed, err = self._reuse_source_facts(rec, task)
        return _core_reusable_codecheck_fullcheck(
            rec,
            task,
            command_count,
            scan,
            standalone_snapshot=snapshot,
            changed_paths=changed,
            source_error=err,
        )
