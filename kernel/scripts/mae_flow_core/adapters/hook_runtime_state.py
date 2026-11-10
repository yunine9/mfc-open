"""Split Hook runtime adapter responsibilities."""

from .hook_runtime_dependencies import *  # noqa: F401,F403


class HookStateMixin:
    def _flow_task_for_token(self, kind):
        try:
            raw, err = safe_read_json(self.STATE)
            if err or not raw:
                return {}
            current = normalize_document(raw, "flow")
            return (current.get("agent_tasks", {}) or {}).get(kind, {})
        except Exception:
            return {}

    def _flow_token_source_snapshot(self, kind, fallback_head):
        task = self._flow_task_for_token(kind)
        if task.get("precommit_review"):
            return self._source_snapshot(task.get("head", fallback_head))
        return None

    def _validated_report_task_digest(self, report):
        match = re.search(
            r"^TASK_CARD_SHA256:\s*([0-9a-f]{64})\s*$",
            report or "",
            re.M | re.I,
        )
        return match.group(1).lower() if match else ""

    def _record_agent_token(self, kind, status="", report=""):
        """子 agent 合法收尾的硬令牌:仅由本 hook(harness 调用)写入,是模型无法伪造的证据源——
        令牌文件在 gate 黑名单中(Edit/Bash 双拦),手动调 dispatch.py 也被 gate 拦截。
        mae-flow 的 agent_ran 证据据此判定"本步期间该 agent 真实跑过"。
        令牌同时绑定签发时 HEAD(新鲜度):签发后源码再变,证据即过期(mae-flow 侧校验)。"""
        try:
            validated_task = self._validated_task_bindings.pop(
                kind, {})
            validated_digest = (
                str(validated_task.get("sha256", "") or "")
                or self._validated_report_task_digest(report)
            )
            validated_issuance = str(
                validated_task.get("issuance_id", "") or "")
            action = self._load_action() if not os.path.isfile(self.STATE) else None
            if action:
                head = self._git_head()
                work = action.get("work_dir") or os.path.dirname(os.path.abspath(self.ACTION_STATE))
                os.makedirs(work, exist_ok=True)
                report_path = os.path.join(work, "result-" + kind.lower() + ".md")
                atomic_write_text(report_path, (report or "").rstrip() + "\n")

                def update_action(current):
                    task = (current.get("agent_tasks", {}) or {}).get(kind, {})
                    current.setdefault("tokens", {})[kind] = {
                        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "head": head,
                        "status": status, "step": "standalone_" + current.get("kind", ""),
                        "task_sha256": (
                            validated_digest or task.get("sha256", "")),
                        "report_path": report_path,
                    }
                    if validated_issuance:
                        current["tokens"][kind][
                            "task_issuance_id"] = validated_issuance
                    current.setdefault("rejections", {}).pop(kind, None)
                    current["rejections"].pop("SUBAGENT", None)
                    return current

                update_versioned_json(self.ACTION_STATE, "action", update_action)
                if kind == "CODECHECK":
                    append_codecheck_event(
                        os.getcwd(), action, "agent.token_issued", {
                            "status": status, "head": head,
                            "report_path": report_path,
                            "standalone": True,
                        }, source="hook")
                self.log("standalone agent token: %s/%s @%s" % (
                    kind, status or "-", head[:9] or "no-git"))
                return
            p = ".mae-flow.json.tokens"
            head = self._git_head()
            step = ""
            task = self._flow_task_for_token(kind)
            try:
                raw, err = safe_read_json(self.STATE)
                step = normalize_document(raw, "flow").get("current", "") if not err and raw else ""
            except Exception:
                pass

            def update_tokens(tokens):
                token = {
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"), "head": head,
                    "status": status, "step": step,
                    "task_sha256": (
                        validated_digest or task.get("sha256", "")),
                }
                if validated_issuance:
                    token["task_issuance_id"] = validated_issuance
                source_snapshot = self._flow_token_source_snapshot(kind, head)
                if source_snapshot is not None:
                    token["source_snapshot"] = source_snapshot
                tokens[kind] = token
                return tokens

            update_json(p, update_tokens, default={}, recover_corrupt=True)
            if kind == "CODECHECK":
                self._codecheck_log_event("agent.token_issued", {
                    "status": status, "head": head,
                    "step": step, "standalone": False,
                })
            self._clear_rejection(kind)
            self.log("agent token: %s/%s @%s" % (kind, status or "-", head[:9] or "no-git"))
        except Exception as e:
            self.log("token EXC: %s" % e)

    def _text_of(self, v):
        """tool_response 可能是 str/dict/list,统一转文本(供 ack 验真存储)。"""
        if isinstance(v, str):
            return v
        try:
            return json.dumps(v, ensure_ascii=False) if v else ""
        except Exception:
            return ""

    def _record_agent_write(self, path):
        """Record a successful direct Agent file edit as a commit candidate.

        The ledger narrows review scope only. It never means every recorded file
        must be staged, and command-generated files intentionally receive no entry.
        """
        try:
            # macOS 的 tempfile 常给 /var/...，而 cwd 会解析成 /private/var/...；
            # realpath 后再判边界，避免同一文件因系统软链接被误当仓库外路径。
            root = os.path.realpath(os.path.abspath(os.getcwd()))
            absolute = os.path.realpath(os.path.abspath(path))
            if os.path.commonpath([root, absolute]) != root:
                return
            relative = os.path.relpath(absolute, root).replace("\\", "/")
            if relative in ("", ".") or relative.startswith("../"):
                return
            _existing, sidecar_error = safe_read_json(self.AGENT_WRITES_STATE)
            if sidecar_error:
                self.log(
                    "agent write ledger recovering unreadable sidecar: "
                    + sidecar_error)

            def update_writes(data):
                paths = data.setdefault("paths", {})
                paths[relative] = {
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "nonce": time.time_ns(),
                    "tool": "file-write",
                }
                compile_side_effects = data.get("compile_side_effects")
                if isinstance(compile_side_effects, dict):
                    identity = source_paths.repository_path_identity(relative)
                    for recorded in list(compile_side_effects):
                        if source_paths.repository_path_identity(
                                recorded) == identity:
                            compile_side_effects.pop(recorded, None)
                # A flow should rarely touch this many files. Bound stale/corrupt
                # growth without changing the provenance semantics.
                if len(paths) > 2000:
                    keep = sorted(
                        paths.items(),
                        key=lambda item: str((item[1] or {}).get("at", "")),
                        reverse=True)[:2000]
                    data["paths"] = dict(keep)
                return data

            update_json(
                self.AGENT_WRITES_STATE, update_writes, default={"paths": {}},
                recover_corrupt=True)
        except Exception as exc:
            self.log("agent write ledger EXC: %s" % exc)
    def _record_compile_side_effects(self, task, tool_calls):
        """Persist accepted COMPILE changes not owned by direct Agent edits."""
        try:
            direct_paths = _successful_direct_write_paths(
                self._tool_call_values(tool_calls), os.getcwd())
            baseline = task.get("worktree_snapshot")
            baseline_valid = (
                task.get("worktree_snapshot_valid") is True
                and isinstance(baseline, dict)
            )
            if baseline_valid:
                try:
                    current = self._worktree_snapshot(
                        task.get("head", ""))
                    side_effect_paths = _compile_side_effect_paths(
                        baseline, current, direct_paths)
                except Exception as exc:
                    current, side_effect_paths = {}, ()
                    self.log(
                        "COMPILE side-effect ledger EXC: %s" % exc)
            else:
                current, side_effect_paths = {}, ()
                self.log(
                    "COMPILE side-effect attribution skipped: invalid baseline")
            if not side_effect_paths and not direct_paths:
                return
            _existing, sidecar_error = safe_read_json(self.AGENT_WRITES_STATE)
            if sidecar_error:
                self.log(
                    "COMPILE side-effect ledger recovering unreadable sidecar: "
                    + sidecar_error)
            recorded_at = time.strftime("%Y-%m-%d %H:%M:%S")
            direct_identities = {
                source_paths.repository_path_identity(path)
                for path in direct_paths
            }
            effect_identities = {
                source_paths.repository_path_identity(path)
                for path in side_effect_paths
            }

            def update_side_effects(data):
                effects = data.setdefault("compile_side_effects", {})
                if not isinstance(effects, dict):
                    effects = {}
                    data["compile_side_effects"] = effects
                for path in list(effects):
                    identity = source_paths.repository_path_identity(path)
                    if (
                            identity in direct_identities
                            or identity in effect_identities):
                        effects.pop(path, None)
                for path in side_effect_paths:
                    effects[path] = {
                        "at": recorded_at,
                        "task_sha256": task.get("sha256", ""),
                        "fingerprint": current[path],
                    }
                if len(effects) > 2000:
                    data["compile_side_effects"] = dict(sorted(
                        effects.items(),
                        key=lambda item: (
                            str((item[1] or {}).get("at", "")), item[0]),
                        reverse=True,
                    )[:2000])
                return data

            update_json(
                self.AGENT_WRITES_STATE,
                update_side_effects,
                default={"paths": {}, "compile_side_effects": {}},
                recover_corrupt=True,
            )
        except Exception as exc:
            self.log("COMPILE side-effect ledger EXC: %s" % exc)

    def _capture_usermsg(self, text, askuser_input=None):
        """harness 捕获的用户真实输入(UserPromptSubmit 的 prompt / AskUserQuestion 的应答),
        供完整流程 ack 与独立任务范围确认验真。没有流程/独立任务时不落盘；
        保留最近 10 条、单条截断 2000 字，写失败留日志不阻塞。"""
        try:
            text = (text or "").strip()
            if not text:
                return
            step = ""
            action = None
            if os.path.exists(self.STATE):
                try:
                    raw, err = safe_read_json(self.STATE)
                    flow_state = normalize_document(
                        raw, "flow") if not err and raw else {}
                    step = flow_state.get("current", "")
                except Exception:
                    pass
            else:
                action = self._load_action()
                if not action:
                    return
                step = "standalone_" + action.get("kind", "")
            captured = text[:2000]
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            msg_id = hashlib.sha256(
                (stamp + "\0" + step + "\0" + captured).encode("utf-8")).hexdigest()[:12]
            row = {
                "id": msg_id,
                "at": stamp,
                "epoch": time.time(),
                "step": step,
                "text": captured,
                "sha256": hashlib.sha256(captured.encode("utf-8")).hexdigest(),
                "input_encoding": self.input_encoding or "unknown",
            }
            askuser = _askuser_receipt(askuser_input)
            if askuser:
                row["askuser"] = askuser
            if action and action.get("scope_sha256"):
                row["scope_sha256"] = str(action["scope_sha256"])

            def append_message(msgs):
                if not isinstance(msgs, list):
                    msgs = []
                msgs.append(row)
                return msgs[-10:]

            if action:
                def append_action(current):
                    current["user_messages"] = append_message(
                        current.get("user_messages", []))
                    return current
                update_versioned_json(self.ACTION_STATE, "action", append_action)
            else:
                update_json(
                    self.STATE + ".usermsg", append_message, default=[],
                    recover_corrupt=True)
        except Exception as e:
            self.log("usermsg EXC: %s" % e)

    def _explicit_exit_prompt(self, text):
        """只识别没有歧义的退出指令；询问“能不能退出”不应误触发。"""
        value = re.sub(r"\s+", " ", (text or "").strip())
        # 宿主真实插件命令是 `/插件:命令 参数`；保留短形式只为兼容旧宿主和
        # 已有测试。命名空间形式若漏掉，Hook 不会签发退出 intent，Agent 随后
        # 只能调用无凭据 CLI，最终错误地逼用户去真实终端执行 --interactive。
        if re.search(
                r"^/mae-flow(?::mae-flow)?\s+(?:exit|direct)(?:\s|$)",
                value, re.I):
            return True
        lower = value.lower()
        names_flow = "mae-flow" in lower or "mae flow" in lower or "这个工作流" in value
        explicit_verb = bool(re.search(
            r"(退出|停止使用|不想(?:再)?用|不用|关闭)\s*(?:mae[- ]?flow|这个工作流)", value, re.I))
        direct_after = any(x in value for x in (
            "直接开发", "直接改代码", "直接让", "直接写", "直接补", "补UT", "补 UT", "保留现场", "不走流程"))
        question = any(x in value for x in ("能不能", "可以吗", "会怎样", "怎么退出", "如何退出", "？", "?"))
        return names_flow and explicit_verb and direct_after and not question

    def _explicit_flow_start_prompt(self, text):
        """识别宿主真实 Slash 入口中会开启完整流程的动作。

        终态 Hook 虽然全面旁路门禁，仍需把这类用户原话交给下一轮 init；独立
        ut/codecheck/grill/story/chain/help/cancel 不属于完整流程重入。
        """
        value = re.sub(r"\s+", " ", (text or "").strip()).lower()
        command = re.match(
            r"^/mae-flow(?::mae-flow)?(?:\s+([^\s]+))?", value)
        if not command:
            return False
        action = (command.group(1) or "").strip()
        return action in ("", "review-fix", "moonlight", "月光宝盒")


    def _capture_exit_intent(self, text):
        """用户事件本身签发一次性退出凭据，避免 exit 再依赖已经故障的 ack 账本。"""
        try:
            text = (text or "").strip()
            if not text or not os.path.isfile(self.STATE) or not self._explicit_exit_prompt(text):
                return ""
            # 实测死角修复:签发与消费必须同一把尺——旧逻辑用裸 json.load,
            # JSON 可解析但 schema 非法(revision 被改坏等)时记真实步骤,而 CLI
            # load_state 严格校验判损坏,intent 对不上,主逃生口永久失效循环。
            try:
                raw, err = safe_read_json(self.STATE)
                if err or not isinstance(raw, dict):
                    step = "__corrupt_state__"
                else:
                    step = str(normalize_document(raw, "flow").get("current", ""))
            except Exception:
                step = "__corrupt_state__"
            nonce = hashlib.sha256(
                (str(time.time_ns()) + "\0" + step + "\0" + text).encode("utf-8")).hexdigest()[:24]
            rec = {
                "id": nonce,
                "epoch": time.time(),
                "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "step": step,
                "text": text[:2000],
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
            atomic_write_json(self.EXIT_INTENT, rec)
            self.log("captured explicit exit intent step=%s id=%s" % (step, nonce))
            return nonce
        except Exception as exc:
            self.log("exit intent EXC: %s" % exc)
            return ""


    def _capture_moonlight_intent(self, text):
        """全新项目尚无 self.STATE 时，暂存本轮明确的月光宝盒授权。

        启动脚本只接受十分钟内、且 --ack 能命中原文的记录，并在消费后删除。
        它只解决“先有用户指令还是先有状态文件”的鸡生蛋问题，不替代正常 ack 验真。
        """
        try:
            text = (text or "").strip()
            if not text or resolve_runtime(os.getcwd()).mode != RuntimeMode.INACTIVE:
                return
            if not re.search(r"月光宝盒|moonlight", text, re.I):
                return
            rec = {"at": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "epoch": time.time(), "text": text[:2000]}
            atomic_write_json(self.MOONLIGHT_INTENT, rec)
            self.log("captured pre-init moonlight intent")
        except Exception as e:
            self.log("moonlight intent EXC: %s" % e)


    def _capture_direct_prompt(self, text):
        """直接模式也只为“用户明确重新启用”保留最近原话；不恢复任何旧流程令牌。"""
        try:
            text = (text or "").strip()
            if not text or not os.path.isfile(self.EXIT_STATE):
                return
            captured = text[:2000]
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            row = {
                "id": hashlib.sha256(
                    (str(time.time_ns()) + "\0direct\0" + captured).encode(
                        "utf-8")).hexdigest()[:12],
                "at": stamp,
                "epoch": time.time(),
                "text": captured,
            }

            def append_direct(rec):
                msgs = rec.get("direct_messages", []) or []
                msgs.append(row)
                rec["direct_messages"] = msgs[-10:]
                return rec

            update_versioned_json(self.EXIT_STATE, "exit", append_direct)
        except Exception as e:
            self.log("direct prompt EXC: %s" % e)


    def _maybe_utrun(self, d):
        """UT 运行命令被真实调起 → UTRUN 事件令牌。当前仅观测(doctor 可见);
        升级为 UT 硬证据前,须公司机确认子 agent 的 Bash 也触发 PostToolUse。
        只在 UT 步骤检测(FIELD-TEST 0.2 待办):这是每条 Bash 都要付的 PostToolUse 开销,
        其他步骤读状态+比对纯属浪费,令牌也只会在 UT 步骤被消费。"""
        try:
            if not os.path.exists(self.STATE):
                return
            st = load_json(self.STATE)
            if st.get("current") != "standalone_ut":
                return
            cmd = re.sub(r"\s+", " ", ((d.get("tool_input") or {}).get("command", "") or ""))
            ut = re.sub(r"\s+", " ", (st.get("config", {}) or {}).get("UT运行命令", "") or "").strip()
            if ut and ut in cmd:
                self._record_agent_token("UTRUN", "EXECUTED")
        except Exception as e:
            self.log("utrun EXC: %s" % e)

    def _load_action(self):
        action, err, expired = core_load_action()
        if err:
            self.log("standalone action unreadable: " + err)
            return None
        if action and expired:
            self.log("standalone action expired: " + action.get("id", "?"))
            return None
        return action


    def _contract_state(self):
        """完整流程与独立任务共用契约器，但独立任务绝不创建主状态或启用源码 gate。"""
        try:
            if os.path.isfile(self.STATE):
                raw, err = safe_read_json(self.STATE)
                return normalize_document(raw, "flow") if not err and raw else {}
        except Exception:
            return {}
        action = self._load_action()
        if not action:
            return {}
        return {
            "current": "standalone_" + action.get("kind", ""),
            "config": action.get("config", {}) or {},
            "agent_tasks": action.get("agent_tasks", {}) or {},
            "quality": action.get("quality", {}) or {},
            "_standalone": True,
            "_action_id": action.get("id", ""),
        }


    def _codecheck_log_state(self):
        """Return the real persisted document so standalone logs use its work_dir."""
        if not os.path.isfile(self.STATE):
            action = self._load_action()
            if action:
                return action
        return self._contract_state()


    def _codecheck_log_event(self, event, details=None):
        return append_codecheck_event(
            os.getcwd(), self._codecheck_log_state(), event, details, source="hook")
