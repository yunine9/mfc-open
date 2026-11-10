#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dispatch.py — 跨平台 hook 分发器(Windows 优先,零 POSIX 依赖)。

用法(hooks.json 中,shell form；公司 codeagent 不支持 exec form 的 args 数组):
  python "${CODEAGENT3_PLUGIN_ROOT}/hooks/dispatch.py" <事件>
输入 stdin Hook JSON；exit 2 = 拦截/打回；Cloud 严格模式故障返回 75。

防卡死设计(hook 在每条消息上同步执行,任何阻塞都会冻住整个会话):
  - 看门狗:有界退出；Cloud 不把故障当作授权或证据成功;
  - stdin 守护线程在 STDIN_SECS 秒拿不到 EOF 时按空输入处理;
  - 调 mae-flow 的子进程带超时;
  - %TEMP%/mae-flow-hook.log 记录 start/end 与耗时供挂起定位。
"""
import hashlib, json, locale, os, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.abspath(os.path.join(HERE, "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mae_flow_core import (
    ACTION_FILE,
    EXIT_FILE,
    FLOW_FILE,
    find_project_root,
    resolve_runtime,
)
from mae_flow_core.file_io import write_text
from mae_flow_core.adapters import hook_budget
from mae_flow_core.adapters.hook_failures import hook_failure
from mae_flow_core.application.hooks.events import handle_hook_event as _handle_hook_event
from mae_flow_core.adapters.hook_active_events import ActiveHookEventAdapter
from mae_flow_core.adapters.hook_events import HookEventAdapter
from mae_flow_core.adapters.hook_diagnostics import HookBlockDiagnostics
from mae_flow_core.adapters.hook_runtime import HookRuntimeAdapter
from mae_flow_core.adapters.project_launcher import install_launcher_for_event
from mae_flow_core.application.hooks.event_policies import (
    authorized_file_access_root,
)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

MAEFLOW = os.path.join(HERE, "..", "scripts", "mae-flow.py")
STATE = FLOW_FILE
EXIT_STATE = EXIT_FILE
MOONLIGHT_INTENT = STATE + ".moonlight-intent"
EXIT_INTENT = STATE + ".exit-intent"
REJECTION_STATE = STATE + ".agent-rejections"
EVIDENCE_STATE = STATE + ".agent-evidence"
AGENT_WRITES_STATE = STATE + ".agent-writes"
ACTION_STATE = ACTION_FILE
LOG = os.path.join(tempfile.gettempdir(), "mae-flow-hook.log")
WATCHDOG_SECS = 12
STDIN_SECS = 3
SUBPROC_SECS = 8
_T0 = time.time()
_INPUT_ENCODING = ""
_STDIN_THREAD = None   # stdin 读线程句柄:超时未归还时,收尾必须绕过解释器 finalization
_DIAGNOSTICS = HookBlockDiagnostics()


def _log(msg):
    try:
        try:
            # 无上限追加会按月涨到几十 MB;超 5MB 滚动一份 .old(单份保留,足够取证)。
            if os.path.getsize(LOG) > 5 * 1024 * 1024:
                os.replace(LOG, LOG + ".old")
        except OSError:
            pass
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%s pid=%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid(), msg))
    except Exception:
        pass


def _arm_watchdog():
    def _kill():
        os._exit(hook_failure("WATCHDOG timeout(%ss)" % WATCHDOG_SECS, _log))
    t = threading.Timer(WATCHDOG_SECS, _kill)
    t.daemon = True
    t.start()
    # 同一预算交给所有子进程调用共享:单次上限 8s 但一个事件可能连发数次
    # (posttool 的 git 权证落定就会),各自计时会被看门狗在中途打死。
    hook_budget.arm(WATCHDOG_SECS)


def maeflow(*args):
    """以当前解释器调 mae-flow,stderr 透传,返回退出码。超时视为放行。

    退出码白名单:只有 0(放行)/2(门禁拦截)是 gate 协议语义。脚本缺失(升级半途/
    杀软隔离,python 打不开文件恰好也退 2)或自身崩溃(rc=1 traceback)属于插件故障,
    必须 fail-open——否则在途流程里每次 Edit/Bash 都被拦,用户连自救编辑都做不了。"""
    if not os.path.isfile(MAEFLOW):
        return hook_failure("maeflow missing at %s" % MAEFLOW, _log)
    if hook_budget.exhausted():
        return hook_failure("maeflow %s 预算耗尽" % (args[:2],), _log)
    try:
        r = subprocess.run([sys.executable, MAEFLOW, *args],
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace",
                           env=_DIAGNOSTICS.subprocess_environment(),
                           timeout=hook_budget.timeout_for(SUBPROC_SECS))
    except subprocess.TimeoutExpired:
        return hook_failure("maeflow %s TIMEOUT" % (args,), _log)
    if r.stdout:
        print(r.stdout, end="")
    stderr = _DIAGNOSTICS.sanitize_stderr(r.stderr)
    if stderr:
        print(stderr, end="", file=sys.stderr)
    if r.returncode not in (0, 2):
        return hook_failure("maeflow %s rc=%s" % (args[:2], r.returncode), _log)
    return r.returncode


def _decode_hook_json(raw):
    """Hook 协议是 JSON 字节流，不能让 Windows 控制台代码页先替我们解码。

    公司环境的 harness 正常发送 UTF-8；同时保留 GB18030/系统代码页兼容旧宿主。
    每种编码都必须 strict 解码且成功解析 JSON，绝不用 errors=replace 把乱码写进确认账本。
    """
    global _INPUT_ENCODING
    if isinstance(raw, str):
        _INPUT_ENCODING = getattr(sys.stdin, "encoding", "") or "text"
        return json.loads(raw or "{}")
    encodings = ["utf-8-sig"]
    preferred = locale.getpreferredencoding(False)
    for enc in (preferred, "gb18030"):
        if enc and enc.lower().replace("-", "") not in {
                x.lower().replace("-", "") for x in encodings}:
            encodings.append(enc)
    last = None
    for enc in encodings:
        try:
            text = raw.decode(enc, errors="strict")
            value = json.loads(text or "{}")
            _INPUT_ENCODING = enc
            if enc != "utf-8-sig":
                _log("stdin decoded with fallback encoding=" + enc)
            return value
        except (UnicodeDecodeError, LookupError, json.JSONDecodeError) as exc:
            last = exc
    raise ValueError("hook JSON 无法按 UTF-8/系统代码页解析: %s" % last)


def read_input():
    """守护线程读 stdin。payload 惯例是单行 JSON,用 readline(见换行即返回)而非 read()(等 EOF):
    公司 harness 写完 payload 后关闭管道晚/不关,read() 等 EOF 会在 3s 兜底处误判超时、把已到的数据丢掉
    (2026-07-20 实战定位:exec form 时代 python 把 stdin 当脚本能读到完整 JSON,证明数据在管道里,只是 EOF 迟)。
    readline 解析失败(罕见多行 payload)再补读到 EOF;3s 仍拿不到按空输入,只兜底不阻塞。"""
    box = {}

    def _r():
        try:
            stream = getattr(sys.stdin, "buffer", sys.stdin)
            buf = stream.readline()
            try:
                box["d"] = _decode_hook_json(buf)
                box["n"] = len(buf)
                return
            except Exception:
                pass
            buf += stream.read()
            box["d"] = _decode_hook_json(buf)
            box["n"] = len(buf)
        except Exception as exc:
            box["d"] = {}
            box["n"] = -1
            box["error"] = str(exc)

    global _STDIN_THREAD
    th = threading.Thread(target=_r, daemon=True)
    th.start()
    th.join(STDIN_SECS)
    _STDIN_THREAD = th
    if "d" not in box:
        _log("stdin read timeout(%ss) — 按空输入处理" % STDIN_SECS)
        return {}
    if not box["d"]:
        _log("stdin empty/unparsed(n=%s,error=%s) — 按空输入处理"
             % (box.get("n"), box.get("error", "-")))
    return box["d"]


def _session_notice_due(tag, d, ev):
    """DIRECT/CORRUPT 提示每会话注入一次即可:逐条消息重复注入只膨胀上下文、烧 token。
    sessionstart 恒提示并盖标记;拿不到会话标识时退回旧行为(每条提示,宁噪勿哑)。"""
    sid = str(d.get("session_id") or d.get("sessionId") or "")
    if not sid:
        return True
    digest = hashlib.sha256(sid.encode("utf-8", errors="replace")).hexdigest()[:16]
    marker = os.path.join(tempfile.gettempdir(), "mae-flow-note-%s-%s" % (tag, digest))
    if ev != "sessionstart" and os.path.exists(marker):
        return False
    try:
        write_text(marker, "")
    except OSError:
        pass
    return True


def _chdir_root(d):
    """hook 进程的 cwd 是 codeagent 启动目录,未必是项目根。
    以 hook JSON 的 cwd 为基准向上定位；最近仓库边界会阻断更高层的陈旧状态，
    避免一个父目录流程误接管从未启用 mae-flow 的独立子仓。"""
    base = d.get("cwd") or os.getcwd()
    root = find_project_root(base)
    try:
        if root != os.getcwd():
            _log("chdir 项目根: " + root)
        os.chdir(root)
    except Exception:
        pass


_HOOK_RUNTIME = None
_MOVED_RUNTIME_NAMES = frozenset(["_git_head","_flow_task_for_token","_flow_token_source_snapshot","_record_agent_token","_text_of","_record_agent_write","_capture_usermsg","_explicit_exit_prompt","_explicit_flow_start_prompt","_capture_exit_intent","_capture_moonlight_intent","_capture_direct_prompt","_maybe_utrun","_load_action","_contract_state","_codecheck_log_state","_codecheck_log_event","_git_trace","_tool_trace_summary","_record_codecheck_agent_trace","_evidence_data","_save_evidence","_record_rejection","_clear_rejection","_contract_bail","_tool_call_values","_contract_context","_task_card_contract","_state_config","_field","_flex_field","_number_field","_same_config","_required_skill","_embedded_build_command","_build_call","_build_summary_matches","_codecheck_build_call","_receipt_context","_record_codecheck_build_receipt","_record_codecheck_fullcheck_receipt","_record_ut_receipts","_reuse_source_facts","_reusable_ut_receipt","_reusable_codecheck_build_receipt","_reusable_codecheck_fullcheck_receipt","_source_changed_since_receipt","_call_failed","_skill_call","_skill_called","_bash_call","_bash_calls","_bash_called","_require_bash_success","_section","_empty_section","_changed_paths_since","_path_fingerprint","_review_path_fingerprint","_unchanged_initial_dirty","_source_snapshot","_source_like","_test_like","_enforce_agent_scope","_codecheck_contract","_ut_contract","_grill_contract","_git_out","_compile_net_lines","_compile_agent_net","_compile_contract"])


def _runtime_adapter():
    global _HOOK_RUNTIME
    if _HOOK_RUNTIME is None:
        _HOOK_RUNTIME = HookRuntimeAdapter(
            state=STATE, exit_state=EXIT_STATE, action_state=ACTION_STATE,
            rejection_state=REJECTION_STATE, evidence_state=EVIDENCE_STATE,
            agent_writes_state=AGENT_WRITES_STATE,
            moonlight_intent=MOONLIGHT_INTENT, exit_intent=EXIT_INTENT,
            maeflow=MAEFLOW, log=_log,
            task_card_ports_factory=lambda: _task_card_ports())
    _HOOK_RUNTIME.STATE = STATE
    _HOOK_RUNTIME.EXIT_STATE = EXIT_STATE
    _HOOK_RUNTIME.ACTION_STATE = ACTION_STATE
    _HOOK_RUNTIME.input_encoding = _INPUT_ENCODING
    return _HOOK_RUNTIME


def __getattr__(name):
    if name in _MOVED_RUNTIME_NAMES:
        return getattr(_runtime_adapter(), name)
    raise AttributeError(name)


def _task_card_ports():
    """Use the adapter's single authoritative production wiring."""
    return _runtime_adapter()._task_card_ports()


def _file_access_root(payload):
    return authorized_file_access_root(os.getcwd(), payload)


def _hook_event_ports(payload=None):
    active = ActiveHookEventAdapter(
        state=STATE,
        maeflow_path=MAEFLOW,
        repository_root=os.getcwd(),
        file_access_root=_file_access_root(payload),
        maeflow=maeflow,
        runtime_adapter=_runtime_adapter(),
        task_card_ports=_task_card_ports,
        log=_log,
    )
    return HookEventAdapter(
        state=STATE,
        action_state=ACTION_STATE,
        runtime_adapter=_runtime_adapter(),
        log=_log,
        session_notice_due=_session_notice_due,
        pretool=active.pretool,
        standalone_pretool=active.standalone_pretool,
        inject=active.inject,
        subagentstop=active.subagentstop,
        posttool=active.posttool,
        stop=active.stop,
    ).ports()


def main():
    ev = sys.argv[1] if len(sys.argv) > 1 else ""
    _arm_watchdog()
    _log("start " + ev)
    rc = 0
    try:
        d = read_input()
        if not d and os.environ.get("MAE_FLOW_HOOK_STRICT") == "1":
            raise ValueError("Hook 输入为空或解析失败")
        _chdir_root(d)
        install_launcher_for_event(ev)
        runtime = resolve_runtime(os.getcwd())
        response = _handle_hook_event(
            ev, d, runtime, _hook_event_ports(d))
        _DIAGNOSTICS.log_pretool_decision(ev, d, response, _log)
        if response.stdout:
            print(response.stdout, end="")
        if response.stderr:
            print(response.stderr, end="", file=sys.stderr)
        rc = response.exit_code
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else 0
    except Exception as e:
        rc = hook_failure("EXC %s: %s" % (type(e).__name__, e), _log)
    _log("end %s rc=%s %dms" % (ev, rc, int((time.time() - _T0) * 1000)))
    if _STDIN_THREAD is not None and _STDIN_THREAD.is_alive():
        # stdin 读线程仍阻塞在 BufferedReader 上并持有其锁:正常 sys.exit 的解释器
        # 收尾去 flush/close 标准流会争锁失败,触发 "Fatal Python error" 并以 134 退出
        # (逻辑 rc 被吞、stderr 喷 abort、看门狗此时已失效)。flush 后直接 os._exit,
        # 保住真实退出码——这正是"宿主不关 stdin"兜底场景自身的兜底。
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        os._exit(rc if isinstance(rc, int) else 0)
    sys.exit(rc)


if __name__ == "__main__":
    main()
