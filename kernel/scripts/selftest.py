#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mae-flow 插件自检 — 发版/打包前必跑(工程习惯抄自上游 comet 的 check-* 脚本)。
检查:语法、JSON、流程图连通性、证据类型注册、占位符合法性、步骤文档齐全、
agent 契约与 dispatch 识别名同步、v3/v4 换轨防回退(comet 子命令与外部 Node
规格引擎不得复活)、关键文件存在。任何 ❌ 退出码 1。"""
import ast, contextlib, glob, importlib.util, io, json, os, re, shutil, subprocess, sys, tempfile, time, types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
TESTS = os.path.join(HERE, "tests")
if TESTS not in sys.path:
    sys.path.insert(0, TESTS)

# 非 UTF-8 控制台(公司 GBK 机器典型形态)下 ✅/❌ 第一行就会编码崩——
# dispatch.py 同款 stdout 自愈,发版门必须开箱即跑。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

class _TmpDir:
    """清理容错的临时目录(CI 实锤:Windows 上子进程退出后句柄短暂占用目录,
    TemporaryDirectory.cleanup 直接崩掉整个 selftest)。小步重试,最终失败
    仅遗留 tmp 不判死——发版门的死因必须是检查失败,不能是清理失败。"""
    def __init__(self, **kw):
        self.name = tempfile.mkdtemp(**kw)
    def __enter__(self):
        return self.name
    def __exit__(self, *exc):
        for attempt in range(5):
            try:
                shutil.rmtree(self.name)
                return False
            except OSError:
                time.sleep(0.2 * (attempt + 1))
        shutil.rmtree(self.name, ignore_errors=True)
        return False


from comet_compat import BEGIN as COMET_COMPAT_BEGIN, ensure_direct_mode_compat
from mae_flow_core.quality.task_cards import (
    EXPECTED_STEPS as TASK_CARD_EXPECTED_STEPS,
)
from mae_flow_core.quality import codecheck as quality_codecheck
from mae_flow_core.workflow.definition import (
    definition_errors,
    workflow_graph_errors,
)
from mae_flow_core.workflow.execution_plan import catalog_errors
from selftest_suites import execute_refactor_safety_suites

fails = []


def check(name, ok, detail=""):
    print(("✅ " if ok else "❌ ") + name + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)


# 1. 语法
for f in ("scripts/mae-flow.py", "scripts/comet_compat.py", "hooks/dispatch.py",
          "scripts/statusline.py", "scripts/mae_flow_core/capabilities.py",
          "scripts/mae_flow_core/codecheck_log.py",
          "scripts/mae_flow_core/lightcheck.py",
          "scripts/mae_flow_core/foundation/__init__.py",
          "scripts/mae_flow_core/foundation/fingerprints.py",
          "scripts/mae_flow_core/foundation/source_paths.py",
          "scripts/mae_flow_core/foundation/git_intent.py",
          "scripts/mae_flow_core/foundation/models.py",
          "scripts/mae_flow_core/file_io.py",
          "scripts/mae_flow_core/guard/__init__.py",
          "scripts/mae_flow_core/guard/intent.py",
          "scripts/mae_flow_core/guard/gate.py",
          "scripts/mae_flow_core/guard/permits.py",
          "scripts/mae_flow_core/guard/ownership.py",
          "scripts/mae_flow_core/guard/bash.py",
          "scripts/mae_flow_core/quality/__init__.py",
          "scripts/mae_flow_core/quality/task_cards.py",
          "scripts/mae_flow_core/quality/evidence.py",
          "scripts/mae_flow_core/quality/codecheck.py",
          "scripts/mae_flow_core/application/__init__.py",
          "scripts/mae_flow_core/application/delivery/__init__.py",
          "scripts/mae_flow_core/application/delivery/standalone.py",
          "scripts/mae_flow_core/application/delivery/moonlight.py",
          "scripts/mae_flow_core/application/delivery/moonlight_defer.py",
          "scripts/mae_flow_core/application/quality/__init__.py",
          "scripts/mae_flow_core/application/quality/codecheck.py",
          "scripts/mae_flow_core/application/quality/codecheck_state.py",
          "scripts/mae_flow_core/application/quality/task_cards.py",
          "scripts/mae_flow_core/application/quality/task_card_documents.py",
          "scripts/mae_flow_core/application/hooks/__init__.py",
          "scripts/mae_flow_core/application/hooks/models.py",
          "scripts/mae_flow_core/application/hooks/events.py",
          "scripts/mae_flow_core/application/hooks/event_policies.py",
          "scripts/mae_flow_core/application/hooks/task_cards.py",
          "scripts/mae_flow_core/application/hooks/receipts.py",
          "scripts/mae_flow_core/application/hooks/agent_completion.py",
          "scripts/mae_flow_core/adapters/__init__.py",
          "scripts/mae_flow_core/adapters/hook_active_events.py",
          "scripts/mae_flow_core/adapters/hook_events.py",
          "scripts/mae_flow_core/adapters/hook_runtime.py",
          "scripts/mae_flow_core/adapters/project_launcher.py",
          "scripts/mae_flow_core/adapters/hook_runtime_state.py",
          "scripts/mae_flow_core/adapters/hook_runtime_trace.py",
          "scripts/mae_flow_core/adapters/hook_runtime_source.py",
          "scripts/mae_flow_core/adapters/hook_runtime_contract_support.py",
          "scripts/mae_flow_core/adapters/hook_runtime_contracts.py",
          "scripts/mae_flow_core/adapters/hook_runtime_dependencies.py",
          "scripts/mae_flow_core/delivery/__init__.py",
          "scripts/mae_flow_core/delivery/evidence.py",
          "scripts/mae_flow_core/delivery/models.py",
          "scripts/mae_flow_core/delivery/moonlight.py",
          "scripts/mae_flow_core/command_dispatch.py",
          "scripts/mae_flow_core/workflow/__init__.py",
          "scripts/mae_flow_core/workflow/advancement.py",
          "scripts/mae_flow_core/workflow/agent_evidence.py",
          "scripts/mae_flow_core/workflow/agent_observations.py",
          "scripts/mae_flow_core/workflow/quality_executions.py",
          "scripts/mae_flow_core/workflow/completion.py",
          "scripts/mae_flow_core/workflow/execution_plan.py",
          "scripts/mae_flow_core/workflow/definition.py",
          "scripts/mae_flow_core/workflow/evidence.py",
          "scripts/mae_flow_core/workflow/evidence_rules.py",
          "scripts/mae_flow_core/workflow/transitions.py",
          "scripts/mae_flow_core/orchestration/work_package.py",
          "scripts/mae_flow_core/orchestration/behavior_baseline.py",
          "scripts/mae_flow_core/cli_commands/local_spec.py",
          "scripts/mae_flow_core/cli_commands/domain_docs.py",
          "scripts/mae_flow_core/__init__.py",
          "scripts/mae_flow_core/cli_runtime.py",
          "scripts/mae_flow_core/cli_parser.py",
          "scripts/mae_flow_core/runtime.py",
          "scripts/mae_flow_core/state_store.py",
          "scripts/mae_flow_core/standalone.py",
          "scripts/mae_flow_core/moonlight.py",
          "scripts/mae_flow_core/specengine.py",
          "scripts/tests/test_state_core.py",
          "scripts/tests/test_capabilities.py",
          "scripts/tests/test_specengine.py",
          "scripts/tests/test_compile_wait_instructions.py",
          "scripts/tests/test_stable_recovery_contract.py",
          "scripts/tests/test_agent_observations.py",
          "scripts/tests/test_project_resources.py",
          "scripts/tests/test_local_spec.py",
          "scripts/tests/test_behavior_baseline.py",
          "scripts/tests/test_domain_docs.py",
          "scripts/tests/test_commit_ownership.py",
          "scripts/tests/test_codecheck_logging.py",
          "scripts/tests/test_lightcheck.py",
          "scripts/tests/test_lightcheck_scope_contract.py",
          "scripts/tests/test_guard_intent.py",
          "scripts/tests/test_guard_gate.py",
          "scripts/tests/test_guard_permits.py",
          "scripts/tests/test_guard_ownership.py",
          "scripts/tests/test_guard_bash.py",
          "scripts/tests/test_quality_task_cards.py",
          "scripts/tests/test_quality_codecheck.py",
          "scripts/tests/test_quality_codecheck_use_cases.py",
          "scripts/tests/test_quality_codecheck_state.py",
          "scripts/tests/test_quality_task_card_use_cases.py",
          "scripts/tests/test_delivery_models.py",
          "scripts/tests/test_delivery_standalone_use_cases.py",
          "scripts/tests/test_delivery_moonlight_use_cases.py",
          "scripts/tests/test_command_dispatch.py",
          "scripts/tests/test_cli_runtime_facade.py",
          "scripts/tests/test_workflow_definition.py",
          "scripts/tests/test_architecture.py",
          "scripts/tests/test_file_io.py",
          "scripts/tests/test_refactor_completion.py",
          "scripts/tests/test_fault_injection.py",
          "scripts/tests/test_evidence.py",
          "scripts/tests/test_agent_evidence.py",
          "scripts/tests/selftest_suites.py",
          "scripts/tests/architecture_rules.py",
          "scripts/tests/refactor_completion.py",
          "scripts/tests/fault_injection.py",
          "scripts/tests/probe_gate_smoke.py",
          "scripts/tests/probe_spec_semantics.py") + tuple(
              os.path.relpath(path, ROOT)
              for pattern in (
                  "cli_commands/*.py",
                  "capability_*.py",
                  "lightcheck_*.py",
                  "specengine_*.py",
              )
              for path in sorted(glob.glob(os.path.join(
                  ROOT, "scripts", "mae_flow_core", pattern)))):
    try:
        path = os.path.join(ROOT, f)
        with open(path, encoding="utf-8") as stream:
            compile(stream.read(), path, "exec")
        check(f"语法 {f}", True)
    except Exception as e:
        check(f"语法 {f}", False, str(e))

# 1.5 子测试由结构化清单统一注册；架构门会核对清单和真实执行循环，
# 避免只在语法列表中保留文件名却悄悄停止运行。
execute_refactor_safety_suites(
    ROOT, sys.executable, report=check)
# v5:两个黑盒探针入库常驻(历次会话临时重建的 92+17 项语义面收编版)——
# gate 拦/放与证据全路径、spec 子命令三档端到端,发版门同样点名跑。
for probe_name, probe_file in (
        ("gate 冒烟与证据全路径探针", "probe_gate_smoke.py"),
        ("spec 语义端到端探针", "probe_spec_semantics.py")):
    probe_run = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "tests", probe_file)],
        text=True, capture_output=True, timeout=300)
    check(probe_name, probe_run.returncode == 0,
          (probe_run.stdout + probe_run.stderr)[-3000:])

# 2. JSON
flow = hooks = None
playbooks = None
for f in ("flow/flow.json", "flow/playbooks.json", "hooks/hooks.json", "runtime/vendor/manifest.json"):
    try:
        d = json.load(open(os.path.join(ROOT, f), encoding="utf-8"))
        if f == "flow/flow.json":
            flow = d
        elif f == "flow/playbooks.json":
            playbooks = d
        elif f == "hooks/hooks.json":
            hooks = d
        check(f"JSON {f}", True)
    except Exception as e:
        check(f"JSON {f}", False, str(e))

if flow:
    steps = flow["steps"]
    # 3. 流程图连通 + 步骤文档
    flow_errors = (
        definition_errors(flow, os.path.join(ROOT, "flow", "steps"))
        + workflow_graph_errors(flow)
    )
    check("流程定义结构有效", not flow_errors, str(flow_errors))
    bad = []
    for sid, s in steps.items():
        nxt = s.get("next")
        targets = list(nxt.values()) if isinstance(nxt, dict) else ([nxt] if nxt else [])
        bad += [f"{sid}->{t}" for t in targets if t not in steps]
    check("流程图 next 全部有效", not bad, str(bad))
    check("start 步骤存在", flow.get("start") in steps)
    playbook_errors = catalog_errors(flow, playbooks or {})
    check("默认 Playbook 覆盖每个工作流步骤", not playbook_errors,
          str(playbook_errors))
    miss_md = [sid for sid, s in steps.items()
               if not s.get("terminal") and not os.path.exists(os.path.join(ROOT, "flow", "steps", sid + ".md"))]
    check("非终态步骤均有指令文档", not miss_md, str(miss_md))

    # 4. 证据类型已注册
    from mae_flow_core import cli_runtime as mf
    used = {e["type"] for s in steps.values() for e in s.get("evidence", [])}
    unreg = used - set(mf.EVIDENCE)
    check("证据类型全部注册", not unreg, str(unreg))

    # 4.5 编排瘦身后的流程契约(2026-08-25):编码段=宽 build 步,
    # 出口验收在 prepush+权威流水线+MR 检视;结构性红线在
    # tests/test_flow_liveness.py,此处只保留冒烟级别的锚点。
    compatibility_entries = set(flow.get("compatibility_entries", ()))
    actual_ack_steps = {
        sid for sid, step in steps.items()
        if step.get("user_ack") and sid not in compatibility_entries}
    check("人工确认只保留真实选择与不可逆决策",
          actual_ack_steps == {
              "config_confirm", "workflow_select",
              "open", "story", "hf_open", "tw_open",
          }, str(sorted(actual_ack_steps)))
    check("所有工作流直接进入宽 build 步",
          steps.get("hf_open", {}).get("next") == "build"
          and steps.get("tw_open", {}).get("next") == "build"
          and steps.get("rf_triage", {}).get("next") == "build"
          and steps.get("story", {}).get("next") == "build")
    check("宽 build 步自由且零编排",
          steps.get("build", {}).get("evidence") == []
          and steps.get("build", {}).get("next") == "domain_archive")
    check("完整开发固定执行 Grill、本地 Spec 和 Story",
          steps.get("branch_create", {}).get("next", {}).get("full") == "grill"
          and steps.get("grill", {}).get("next") == "open"
          and steps.get("open", {}).get("next") == "story"
          and steps.get("story", {}).get("next") == "build")
    step_text = lambda name: open(
        os.path.join(ROOT, "flow", "steps", name + ".md"),
        encoding="utf-8").read()
    check("关键确认与零待决分支都有明确步骤话术",
          "每卡最多 4 条" in step_text("rf_triage")
          and "local-spec validate" in step_text("open")
          and "唯一一次确认" in step_text("open")
          and "候选题为 0" in step_text("grill")
          and "domain-archive apply" in step_text("domain_archive"))
    check("build 步文档给出出门清单与真实出口",
          "出门清单" in step_text("build")
          and "推送前" in step_text("build")
          and "流水线" in step_text("build"))
    check("交付收口链完整且带证据",
          steps.get("domain_archive", {}).get("next") == "delivery_review"
          and steps.get("delivery_review", {}).get("next") == "push"
          and any(
              item.get("type") == "delivery_manifest_committed"
              for item in steps.get("delivery_review", {}).get("evidence", []))
          and any(
              item.get("type") == "pipeline_obligations_passed"
              for item in steps.get("external_verify", {}).get("evidence", [])))
    check("本地 Spec 校验与 Grill 输入链在位",
          any(e.get("type") == "local_spec_valid"
              for e in steps.get("open", {}).get("evidence", []))
          and any(
              ".mae-flow-work/{单号}/grill.md" in e.get("any", [])
              for e in steps.get("open", {}).get("evidence", []))
          and "local-spec validate" in step_text("open")
          and steps.get("open", {}).get("next") == "story")

    # CodeCheckCLI 的成功退出码/文案不稳定，至少守住三种已知输出
    parser_cases = [
        ("💡 提示: 共有 2 条告警。", "", 2),
        ("[CodeCheck] 代码检查完成", "| **总计** | **0** | **0** |", 0),
        ("[CodeCheck] 代码检查完成! 未发现代码告警", "", 0),
    ]
    check("CodeCheck 告警数多格式解析",
          all(quality_codecheck.parse_count(a, b) == n
              for a, b, n in parser_cases))
    real_run, real_ensure = mf.subprocess.run, mf.ensure_codecheck
    real_cwd = os.getcwd()
    try:
        sample = """[CodeCheck] 代码检查完成!\n### 1. [Minor] R.ONE 示例\n- **文件**: `Foo.cpp`\n- **规则**: R.ONE 示例\n💡 提示: 共有 1 条告警。"""
        mf.ensure_codecheck = lambda install=True: {
            "available": True, "path": "/fake/codecheck", "detail": ""}
        mf.subprocess.run = lambda *a, **k: types.SimpleNamespace(
            stdout=sample, stderr="", returncode=1)
        # _run_codecheck 现在会留下详细诊断；解析单测必须在临时项目中运行，
        # 不能让发版自检反过来污染被检查仓库的 .mae-flow-work。
        with _TmpDir() as codecheck_test_root:
            os.chdir(codecheck_test_root)
            result, err = mf._run_codecheck(["src/Foo.cpp"])
            check("CodeCheck 成功不依赖退出码 0",
                  not err and result["total"] == 1
                  # 覆盖口径改造后告警带行号槽位;此样例明细无行号 → None(保守全算)
                  and result["pairs"] == [("R.ONE", "src/Foo.cpp", None)])
    finally:
        os.chdir(real_cwd)
        mf.subprocess.run, mf.ensure_codecheck = real_run, real_ensure
    win_argv, win_shell, _ = mf._codecheck_launch(
        ["src/My File.cpp"], executable=r"C:\Users\dev\AppData\Roaming\npm\codecheck.cmd", windows=True)
    check("Windows CodeCheck 沿用已验证的 shell/PATHEXT 路径",
          win_shell and isinstance(win_argv, str) and "codecheck.cmd" in win_argv
          and "fullcheck" in win_argv
          and '"src/My File.cpp"' in win_argv)
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as f:
        json.dump({"issues": [{"uuid": "1", "rule": "R.ONE", "file": "a/Foo.cpp"},
                              {"uuid": "2", "rule": "R.TWO", "file": "b/Foo.cpp"}]}, f)
        codecheck_json = f.name
    try:
        with open(codecheck_json, encoding="utf-8") as stream:
            count, warnings = quality_codecheck.parse_json_result(
                json.load(stream))
        check("CodeCheck JSON 兜底解析",
              count == 2 and len(warnings) == 2)
    finally:
        os.unlink(codecheck_json)

    mf.FLOW = flow

    source_cases = {
        "include/Foo.hpp": True,
        "lib/core.cpp": True,
        "app/generated/no_extension": True,
        "CMakeLists.txt": True,
        "pom.xml": True,
        "build.sh": True,
        "tools/build.mk": True,
        "package-lock.json": True,
        "docs/readme.md": False,
    }
    check("跨仓源码识别不依赖 service/src",
          all(mf._is_source_path(p, {}, flow) == want for p, want in source_cases.items())
          and mf._is_source_path("vendor/private/schema",
                                 {"config": {"源码路径": r"(^|/)vendor/private/"}}, flow))
    check("dt_tests 与 C++ Test 文件不会进入 CodeCheck",
          mf._is_test_file("service/probe/dt_tests/Foo.cpp", {})
          and mf._is_test_file("service/probe/FooTest.cpp", {})
          and mf._is_test_file("service/probe/dt_tests/Foo.cpp",
                               {"config": {"测试路径": r"(^|/)private_ut/"}}))
    check("评审空模板不会误判为待修代码",
          not mf._review_has_confirmed_fix("合法值: 修复(已确认)\n| # | 意见 | 定性 | 裁决 |\n|---|---|---|---|")
          and mf._review_has_confirmed_fix("| 1 | 空指针 | 属实 | 修复(已确认) |"))
    check("评审裁决计数只认表格数据行",
          mf._review_status_count(
              "合法值: 转规格轮次(已确认)\n"
              "| # | 意见 | 定性 | 裁决 |\n|---|---|---|---|\n"
              "| 1 | 行为变化 | 属实 | 转规格轮次(已确认) |",
              "转规格轮次(已确认)") == 1)
    check("配置只能在声明步骤写入",
          mf._allowed_set_keys(steps["config_confirm"]) >= {"基线分支", "分支名", "编译方式"}
          and not mf._allowed_set_keys(steps["push"]))
    check("Git 分支与 change 名使用原生 ref 规则严格校验",
          not mf._validate_config_value("基线分支", "main")
          and not mf._validate_config_value("基线分支", "origin/main")
          and mf._validate_config_value("基线分支", "main..bad")
          and mf._validate_config_value("分支名", "-main")
          and mf._validate_config_value("CHANGE_NAME", ".."))
    pattern_stderr = io.StringIO()
    with contextlib.redirect_stderr(pattern_stderr):
        configured_patterns = mf._test_patterns(
            {"config": {"测试路径": [r"(^|/)qa/", "["]}})
    check("测试路径支持数组且坏正则 fail-closed 不使 Hook 崩溃",
          configured_patterns == [r"(^|/)qa/"]
          and "fail-closed" in pattern_stderr.getvalue())
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            defaults = {
                "编译方式": "build.cmd",
                "UT生成方式": "AutoUT",
                "UT运行命令": "ctest.exe --test-dir build",
                "测试路径": [r"(^|/)qa/"],
            }
            with open(mf.DEFAULTS_PATH, "wb") as f:
                f.write(b"\xef\xbb\xbf" + json.dumps(
                    defaults, ensure_ascii=False).encode("utf-8"))
            bom_config = mf._standalone_config()
            bom_patterns = mf._test_patterns({})
            check("Windows 常见 UTF-8 BOM defaults 在主流程与独立模式同样生效",
                  bom_config.get("UT运行命令") == defaults["UT运行命令"]
                  and bom_patterns == defaults["测试路径"])
        finally:
            os.chdir(old_cwd)
    good_req = "# 需求\n\n支持中文输入。\n"
    with _TmpDir() as td:
        good_path = os.path.join(td, "req.md")
        bad_path = os.path.join(td, "bad.md")
        open(good_path, "w", encoding="utf-8").write(good_req)
        open(bad_path, "wb").write("我确认需求".encode("utf-16"))
        check("需求文本严格校验可识别 UTF-8 与错误编码",
              mf._validate_requirement_document(good_path)[0]
              and not mf._validate_requirement_document(bad_path)[0])

        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            config_state = {"current": "config_confirm", "config": {}, "choices": {},
                            "history": [], "started": now}
            mf.save_state(config_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "我确认以上配置", "step": "config_confirm", "at": now}],
                          f, ensure_ascii=False)
            short_ack_ok, _ = mf._ack_verified(config_state, "确认")
            check("主流程确认不接受用户原话中的局部短词", not short_ack_ok)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": json.dumps({"answer": "我确认以上配置"},
                                               ensure_ascii=False),
                            "step": "config_confirm", "at": now}],
                          f, ensure_ascii=False)
            structured_ack_ok, _ = mf._ack_verified(config_state, "我确认以上配置")
            check("主流程确认兼容宿主结构化应答", structured_ack_ok)
            stale_state = {
                "current": "grill", "config": {}, "choices": {},
                "history": [{
                    "step": "branch_create", "result": "goto:grill",
                    "at": "2026-01-01 00:00:02",
                }],
                "started": "2026-01-01 00:00:00",
            }
            mf.save_state(stale_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "text": "在现有分支上继续 (推荐)",
                    "step": "branch_create", "at": "2026-01-01 00:00:01",
                }], f, ensure_ascii=False)
            stale_ok, stale_why = mf._ack_verified(
                stale_state, "在现有分支上继续 (推荐)")
            stale_messages = io.StringIO()
            try:
                with contextlib.redirect_stderr(stale_messages):
                    mf.cmd_messages(
                        stale_state, types.SimpleNamespace(id=None, full=False))
            except SystemExit:
                pass
            check("跨步骤旧回答会被说明为已捕获但已失效",
                  not stale_ok
                  and "Hook 已捕获用户回复" in stale_why
                  and "branch_create" in stale_why
                  and "不是" not in stale_why
                  and "当前步骤没有可复用" in stale_messages.getvalue())
            config_state.pop("revision", None)
            config_state.pop("updated_at", None)
            mf.save_state(config_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": json.dumps({
                    "options": ["我确认以上配置", "需要调整配置"],
                    "answer": "需要调整配置",
                }, ensure_ascii=False), "step": "config_confirm", "at": now}],
                          f, ensure_ascii=False)
            option_metadata_ok, _ = mf._ack_verified(config_state, "我确认以上配置")
            check("结构化应答中的候选选项不能冒充用户确认", not option_metadata_ok)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "我确认以上配置", "step": "config_confirm", "at": now}],
                          f, ensure_ascii=False)
            failed = False
            try:
                mf.cmd_config_review(flow, config_state, types.SimpleNamespace(
                    set=["工号=u1", "基线分支=main", "单号=REQ1", "单号类型=feat",
                         "需求文档=" + bad_path, "编译方式=build-fix",
                         "UT生成方式=AutoUT", "UT运行命令=mcde test --ut"]))
            except SystemExit as exc:
                failed = exc.code == 2
            check("配置失败不会把半套或乱码值写入状态",
                  failed and mf.load_state().get("config") == {}
                  and not mf.load_state().get("config_review"))
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"id": "msg001", "text": "支持中文基站名称查询",
                            "step": "config_confirm", "at": now}], f, ensure_ascii=False)
            mf.cmd_requirement_record(config_state, types.SimpleNamespace(
                ticket="REQ1", message_id="msg001", source=None, replace=False))
            recorded = os.path.join("docs", "req", "REQ-REQ1.md")
            check("需求原文由消息ID确定性写UTF-8并通过正文指纹",
                  os.path.isfile(recorded)
                  and mf._validate_requirement_document(recorded)[0]
                  and "支持中文基站名称查询" in open(recorded, encoding="utf-8").read())
            direct_req_edit_blocked = False
            direct_req_shell_blocked = False
            # docs/req 直写拦截已退役(误写可逆,requirement-record 仍是推荐做法);
            # 编码正确性由 requirement-record 的回读校验保证,不再靠门禁。
            req_edit_allowed = True
            try:
                mf.cmd_gate(flow, config_state, types.SimpleNamespace(
                    what="edit", arg="docs/req/manual.md"))
            except SystemExit as exc:
                req_edit_allowed = exc.code == 0
            check("配置阶段直写需求文档不再被门禁拦(改由证据层把关)",
                  req_edit_allowed)
            mf._ack_verified(config_state, "错误确认")
            _, second_why = mf._ack_verified(config_state, "错误确认")
            check("确认失败只停止重复尝试而不会锁死流程",
                  "停止重复执行" in second_why and "流程没有锁死" in second_why
                  and "exit/init" in second_why)

            config_sets = [
                "工号=u1", "基线分支=main", "单号=REQ1", "单号类型=feat",
                "需求文档=" + good_path, "编译方式=build-fix",
                "UT生成方式=AutoUT", "UT运行命令=mcde test --ut",
            ]
            mismatched_branch_blocked = False
            try:
                mf.cmd_config_review(
                    flow, mf.load_state(), types.SimpleNamespace(
                        set=config_sets + ["分支名=agent_guessed_branch"]))
            except SystemExit as exc:
                mismatched_branch_blocked = exc.code == 2
            check("工作分支名由脚本确定生成而不是交给 Agent 拼接",
                  mismatched_branch_blocked
                  and not mf.load_state().get("config_review"))
            mf.cmd_config_review(
                flow, mf.load_state(), types.SimpleNamespace(set=config_sets))
            reviewed = mf.load_state()
            review_sha = "legacy-digest"
            review_id = reviewed.get("config_review", {}).get("id", "")
            resumed_output = io.StringIO()
            with contextlib.redirect_stdout(resumed_output):
                mf.print_current(flow, reviewed)
            check("配置确认单可在清空会话后由 current 原样恢复",
                  review_id in resumed_output.getvalue()
                  and mf.CONFIG_CONFIRM_ACK in resumed_output.getvalue())
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "text": json.dumps({
                        "answers": {
                            "基线分支": "确认 master",
                            "单号": "沿用 REQ1",
                            "需求文档": "沿用需求文档",
                        },
                    }, ensure_ascii=False),
                    "step": "config_confirm", "at": now,
                    "config_review_sha256": review_sha,
                    "config_review_id": review_id,
                }], f, ensure_ascii=False)
            partial_ok, partial_why = mf._config_ack_verified(
                reviewed, "确认 master")
            check("配置单项回答不能替整份配置背书",
                  not partial_ok and "完整配置" in partial_why)

            original_requirement = open(good_path, encoding="utf-8").read()
            open(good_path, "a", encoding="utf-8").write("\n临时变化\n")
            changed_doc_blocked = False
            try:
                mf.cmd_done(
                    flow, reviewed,
                    types.SimpleNamespace(
                        ack=mf.CONFIG_CONFIRM_ACK, choice=None, set=None))
            except SystemExit as exc:
                changed_doc_blocked = exc.code == 2
            open(good_path, "w", encoding="utf-8").write(original_requirement)
            check("需求文档变化仍不能把单项回答当作完整确认",
                  changed_doc_blocked)

            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "text": json.dumps({
                        "questions": [{"header": "基线分支"}, {"header": "最终确认"}],
                        "answers": {
                            "基线分支": "确认 master",
                            "单号": "沿用 REQ1",
                            "最终确认": mf.CONFIG_CONFIRM_ACK,
                        },
                    }, ensure_ascii=False),
                    "step": "config_confirm", "at": now,
                    "config_review_sha256": review_sha,
                    "config_review_id": review_id,
                }], f, ensure_ascii=False)
            stale_ok, stale_why = mf._config_ack_verified(
                reviewed, mf.CONFIG_CONFIRM_ACK)
            check("完整配置确认不受遗留内容指纹影响", stale_ok)
            mf.cmd_done(
                flow, reviewed,
                types.SimpleNamespace(
                    ack=None, choice=None, set=None))
            completed_config = mf.load_state()
            check("配置按钮结果可直接推进且无需再输入 ACK",
                  completed_config.get("current") == "workflow_select"
                  and completed_config.get("config", {}).get("单号") == "REQ1"
                  and not completed_config.get("config_review"))

            decision_at = completed_config.get("history", [])[-1].get("at", now)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "text": json.dumps(
                        {"answers": {"交付方式": "完整开发"}},
                        ensure_ascii=False),
                    "step": "workflow_select", "at": decision_at,
                }], f, ensure_ascii=False)
            with open(mf.STATE_PATH + ".tokens", "w", encoding="utf-8") as f:
                json.dump({"ASKUSER": {
                    "at": decision_at, "step": "workflow_select",
                    "status": "CONFIRMED",
                }}, f, ensure_ascii=False)
            wrong_choice_blocked = False
            try:
                mf.cmd_done(
                    flow, completed_config,
                    types.SimpleNamespace(
                        ack=None, choice="hotfix", set=None))
            except SystemExit as exc:
                wrong_choice_blocked = exc.code == 2
            check("按钮选择与 Agent 提交的 choice 不一致时仍会拒绝",
                  wrong_choice_blocked
                  and mf.load_state().get("current") == "workflow_select")
            mf.cmd_done(
                flow, mf.load_state(),
                types.SimpleNamespace(
                    ack=None, choice="full", set=None))
            check("普通流程选择点一次按钮即可推进",
                  mf.load_state().get("current") == "branch_create"
                  and mf.load_state().get("choices", {}).get("workflow") == "full")

            scope_state = {
                "current": "hf_open", "config": {}, "choices": {},
                "history": [], "started": now,
            }
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "text": json.dumps(
                        {"answers": {"英文短名": "可以"}},
                        ensure_ascii=False),
                    "step": "hf_open", "at": now,
                }], f, ensure_ascii=False)
            early_ok, _ = mf._implicit_ack_verified(
                flow["steps"]["hf_open"], scope_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "text": json.dumps(
                        {"answers": {"范围确认": "确认范围并继续"}},
                        ensure_ascii=False),
                    "step": "hf_open", "at": now,
                }], f, ensure_ascii=False)
            final_ok, _ = mf._implicit_ack_verified(
                flow["steps"]["hf_open"], scope_state)
            check("范围确认只认最终固定按钮而不误用前面的“可以”",
                  not early_ok and final_ok)
        finally:
            os.chdir(old_cwd)
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            check("旧 Story 节点只作恢复别名且不再制造二次询问",
                  flow["steps"]["story_ask"].get("next") == "story"
                  and not flow["steps"]["story_ask"].get("user_ack")
                  and flow["steps"]["design"].get("next") == "story")

        finally:
            os.chdir(old_cwd)

    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            os.makedirs("src", exist_ok=True)
            open("src/preexisting.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "src/preexisting.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            subprocess.run(["git", "branch", "-M", "main"], check=True)
            head = mf.sh("git rev-parse HEAD")
            open("src/preexisting.cpp", "a", encoding="utf-8").write("int local = 2;\n")
            dirty_state = {
                "initial_dirty": ["src/preexisting.cpp"],
                "initial_dirty_fingerprints": {
                    "src/preexisting.cpp": mf._path_fingerprint("src/preexisting.cpp")},
            }
            unchanged, unchanged_err = mf._source_changed_since(head, dirty_state)
            check("流程启动前未变化的脏源码不封任务卡与令牌",
                  not unchanged_err and unchanged == []
                  and mf._blocking_dirty_source_paths(dirty_state, flow) == [])
            open("src/preexisting.cpp", "a", encoding="utf-8").write("int changed_now = 3;\n")
            changed, changed_err = mf._source_changed_since(head, dirty_state)
            check("存量脏源码在本轮再次变化仍会硬拦",
                  not changed_err and any("src/preexisting.cpp" in item for item in changed)
                  and mf._blocking_dirty_source_paths(dirty_state, flow)
                  == ["src/preexisting.cpp"])

            hostile = "src/$(touch${IFS}MAE_FLOW_FILENAME_EXEC).cpp"
            open(hostile, "w", encoding="utf-8").write("int hostile = 1;\n")
            marker = "MAE_FLOW_FILENAME_EXEC"
            changed_lines, changed_lines_err = mf._changed_lines(
                {"config": {"基线分支": "main"}}, [hostile])
            check("Git 文件名只经 argv 传递且不能触发 shell 命令替换",
                  not changed_lines_err and hostile in changed_lines
                  and not os.path.exists(marker))

            branch_state = {
                "current": "branch_create",
                "config": {
                    "基线分支": "main",
                    "分支名": "main_u1_REQ1",
                },
                "history": [], "started": "2026-01-01 00:00:00",
            }
            baseline_allowed = True
            try:
                mf.cmd_gate(flow, branch_state, types.SimpleNamespace(
                    what="bash", arg="git checkout main"))
            except SystemExit as exc:
                baseline_allowed = exc.code == 0
            # 分支命名约定拦截已退役(错了可改名);提交到错分支仍由
            # bash-commit-branch 在提交那一刻拦住。
            check("branch_create 放行基线 checkout", baseline_allowed)

            subprocess.run(["git", "checkout", "-qb", "main_u1_REQ1"], check=True)
            branch_ok, _ = mf.ev_branch_ok({}, branch_state)
            subprocess.run(["git", "add", hostile], check=True)
            subprocess.run(["git", "commit", "-qm", "wrong parent fixture"], check=True)
            wrong_parent_ok, wrong_parent_why = mf.ev_branch_ok({}, branch_state)
            check("工作分支不仅校验名称还校验从基线 HEAD 切出",
                  branch_ok and not wrong_parent_ok and "起点" in wrong_parent_why)
        finally:
            os.chdir(old_cwd)

    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            os.makedirs("src", exist_ok=True)
            open("src/base.cpp", "w", encoding="utf-8").write("int base = 1;\n")
            subprocess.run(["git", "add", "src/base.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "base"], check=True)
            subprocess.run(["git", "branch", "-M", "main"], check=True)
            subprocess.run(["git", "checkout", "-qb", "existing-work"], check=True)
            open("src/work.cpp", "w", encoding="utf-8").write("int work = 1;\n")
            subprocess.run(["git", "add", "src/work.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "existing work"], check=True)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            branch_state = {
                "current": "branch_create",
                "config": {
                    "基线分支": "main",
                    "分支名": "main_u1_REQ1",
                    "单号": "REQ1",
                    "单号类型": "feat",
                },
                "choices": {"workflow": "full"},
                "history": [], "started": now,
            }
            mf.save_state(branch_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "id": "branch-skip",
                    "text": "跳过创建分支，继续下一步",
                    "step": "branch_create", "at": now,
                }], f, ensure_ascii=False)
            branch_skip_blocked = False
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    mf.cmd_goto(flow, branch_state, types.SimpleNamespace(
                        step="grill", force=True,
                        message_id="branch-skip"))
            except SystemExit as exc:
                branch_skip_blocked = exc.code == 2
            check("goto 不能只跳过分支关而留下后续必失败状态",
                  branch_skip_blocked
                  and mf.load_state().get("current") == "branch_create")

            adoption_ack = "在现有分支上继续 (推荐)"
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "id": "branch-adopt",
                    "text": adoption_ack,
                    "step": "branch_create", "at": now,
                }], f, ensure_ascii=False)
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_goto(flow, branch_state, types.SimpleNamespace(
                    step="branch_create", force=True,
                    message_id="branch-adopt"))
            adopted = mf.load_state()
            adopted_ok, _ = mf.ev_branch_ok({}, adopted)
            stale_receipt = json.loads(json.dumps(adopted))
            stale_receipt["branch_resolution"]["head"] = "0" * 40
            stale_ok, stale_reason = mf.ev_branch_ok({}, stale_receipt)
            check("用户选择沿用现有分支会登记配置和绑定HEAD",
                  adopted_ok
                  and adopted.get("config", {}).get("分支名") == "existing-work"
                  and adopted.get("branch_resolution", {}).get("previous_branch")
                  == "main_u1_REQ1"
                  and not stale_ok and "裁决已过期" in stale_reason)
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_done(flow, adopted, types.SimpleNamespace(
                    ack=None, choice=None, set=[]))
            check("沿用分支裁决后 branch_create 可正常推进",
                  mf.load_state().get("current") == "grill")

            upgrade_state = {
                "current": "tw_open",
                "config": {
                    "基线分支": "main", "分支名": "existing-work",
                    "CHANGE_NAME": "upgrade-test",
                },
                "choices": {"workflow": "tweak"},
                "history": [], "started": now,
                "spec": {
                    "change": "upgrade-test", "phase": "open",
                    "workflow": "tweak", "initialized_at": now,
                    "verification_report": "old-report.md",
                    "verify_result": "pass",
                },
            }
            mf.save_state(upgrade_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "id": "upgrade-flow",
                    "text": "确认升级为完整开发并进入方案设计",
                    "step": "tw_open", "at": now,
                }], f, ensure_ascii=False)
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_goto(flow, upgrade_state, types.SimpleNamespace(
                    step="design", force=True,
                    message_id="upgrade-flow"))
            upgraded = mf.load_state()
            check("轻量流程 goto design 会同步 workflow 和规格阶段",
                  upgraded.get("current") == "design"
                  and upgraded.get("choices", {}).get("workflow") == "full"
                  and upgraded.get("spec", {}).get("workflow") == "full"
                  and upgraded.get("spec", {}).get("phase") == "design"
                  and "verification_report" not in upgraded.get("spec", {})
                  and "verify_result" not in upgraded.get("spec", {}))

            rewind_state = {
                "current": "verify_ponytail",
                "config": {
                    "基线分支": "main", "分支名": "existing-work",
                    "CHANGE_NAME": "rewind-test",
                },
                "choices": {"workflow": "full"},
                "history": [], "started": now,
                "spec": {
                    "change": "rewind-test", "phase": "verify",
                    "workflow": "full", "initialized_at": now,
                    "design_doc": "design.md", "plan": "plan.md",
                    "verification_report": "verify.md",
                    "verify_result": "pass", "verified_at": now,
                },
            }
            mf.save_state(rewind_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{
                    "id": "rewind-spec",
                    "text": "规格有误，回到 open 修订",
                    "step": "verify_ponytail", "at": now,
                }], f, ensure_ascii=False)
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_goto(flow, rewind_state, types.SimpleNamespace(
                    step="open", force=True,
                    message_id="rewind-spec"))
            rewound = mf.load_state()
            check("goto open 会同步回退规格阶段并作废下游证据",
                  rewound.get("current") == "open"
                  and rewound.get("spec", {}).get("phase") == "open"
                  and all(key not in rewound.get("spec", {}) for key in (
                      "design_doc", "plan", "verification_report",
                      "verify_result", "verified_at")))
            archived_ok, archived_why = mf._prepare_spec_for_goto({
                "choices": {"workflow": "full"},
                "spec": {"phase": "archived"},
            }, "open")
            check("不可逆定稿不能被 goto 假回退",
                  not archived_ok and "新的修订轮次" in archived_why)
        finally:
            os.chdir(old_cwd)

    # Plugin-owned runtime is prepared in-process: no project Skill directory,
    # global npm mutation, setup script or reload marker.
    # v4 换轨：规格目录由内置纯 Python 引擎创建（不再自检外部 openspec 版本号），
    # 交付阶段收归 .mae-flow.json，因此 .comet/config.yaml 从"必须存在"变成"必须不存在"。
    with _TmpDir() as td:
        subprocess.run(["git", "init", "-q", td], check=True)
        prepared = mf.prepare_project(td)
        check("安装后项目能力可直接准备且不生成 .cac/.claude/.comet",
              prepared.get("spec_engine") == "builtin"
              and set(prepared) == {"spec_engine", "project", "python", "git",
                                    "bash", "created_project_skills"}
              and os.path.isfile(os.path.join(
                  td, ".mae-flow-work", "spec", "config.yaml"))
              and os.path.isdir(os.path.join(
                  td, ".mae-flow-work", "spec", "changes", "archive"))
              and not os.path.exists(os.path.join(td, "openspec"))
              and not os.path.exists(os.path.join(td, ".comet"))
              and not os.path.exists(os.path.join(td, ".cac"))
              and not os.path.exists(os.path.join(td, ".claude")),
              "prepared=%s" % sorted(prepared))
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            with open(mf.STATE_PATH, "w", encoding="utf-8") as stream:
                json.dump({
                    "current": "env_setup", "config": {}, "choices": {},
                    "history": [], "started": "2026-01-01 00:00:00",
                }, stream)
            migrated = mf.load_state()
            check("旧版环境步骤断点升级后自动迁移到配置确认",
                  migrated.get("current") == "config_confirm"
                  and any(x.get("type") == "remove-project-setup"
                          for x in migrated.get("migrations", [])))
        finally:
            os.chdir(old_cwd)
    packs_ok = all(
        "当前会话已经加载" in mf.render_pack(name)
        for name in ("open", "design", "build", "review-fix", "ponytail-review", "verify"))
    check("公开工作方法固定版本并由当前步骤直接加载", packs_ok)
    check("同名文件豁免键不会碰撞",
          mf._approval_key("R", "a/Foo.cpp") != mf._approval_key("R", "b/Foo.cpp"))
    check("豁免规则与文件必须在同一条记录",
          not mf._exemption_text_has_pair("- R.ONE | a/Foo.cpp\n- R.TWO | b/Bar.cpp", "R.ONE", "b/Bar.cpp")
          and mf._exemption_text_has_pair("- R.ONE | a/Foo.cpp", "R.ONE", "a/Foo.cpp"))

    # 独立能力：不创建主流程状态、支持未提交代码、默认不提交，完成/取消都不留下源码门禁。
    # chdir 恢复必须在 with 内(cleanup 之前):Windows 下 CWD 在目录里=目录被占用,
    # rmtree 必炸 WinError 32(CI 首跑实锤;Mac/Linux 无此锁语义所以从没炸过)。
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            base_head = mf.sh("git rev-parse HEAD")
            common = dict(source=None, build="build-fix skill", check_only=False)

            empty_scope_blocked = False
            try:
                mf.cmd_action_start(flow, None, types.SimpleNamespace(
                    kind="ut", request="补充单元测试", files=[],
                    generator="AutoUT", ut_command="mcde test --ut", **common))
            except SystemExit as exc:
                empty_scope_blocked = exc.code == 2
            os.makedirs("tests", exist_ok=True)
            open("tests/BizTest.cpp", "w", encoding="utf-8").write("int test_only = 1;\n")
            test_only_blocked = False
            try:
                mf.cmd_action_start(flow, None, types.SimpleNamespace(
                    kind="ut", request="补充单元测试", files=["tests/BizTest.cpp"],
                    generator="AutoUT", ut_command="mcde test --ut", **common))
            except SystemExit as exc:
                test_only_blocked = exc.code == 2
            os.remove("tests/BizTest.cpp")
            os.rmdir("tests")
            check("独立 UT 拒绝空范围和纯测试文件范围",
                  empty_scope_blocked and test_only_blocked
                  and not os.path.exists(mf.ACTION_PATH))

            open("biz.cpp", "a", encoding="utf-8").write("int changed = 2;\n")
            mf.cmd_action_start(flow, None, types.SimpleNamespace(
                kind="ut", request="为 biz.cpp 当前改动补充边界测试", files=["biz.cpp"],
                generator="AutoUT", ut_command="mcde test --ut", **common))
            action = mf._load_action()
            check("独立 UT 启动后只冻结并展示范围，不提前派 Agent",
                  action.get("status") == "awaiting_scope_confirmation"
                  and action.get("files") == ["biz.cpp"]
                  and not action.get("agent_tasks"))
            negative_scope_messages = (
                "我还没确认以上范围",
                "确认以上范围是什么意思？",
                "请问是不是点“确认以上范围”就开始？",
            )
            check("独立任务范围确认不接受否定句和询问句",
                  all(not mf._action_scope_receipt({
                      "scope_proposed_epoch": 1,
                      "scope_sha256": "scope-negative",
                      "user_messages": [{
                          "epoch": 2,
                          "scope_sha256": "scope-negative",
                          "text": text,
                      }],
                  })[0]
                      for text in negative_scope_messages))
            forged_scope_receipt_blocked = False
            try:
                mf.cmd_action_confirm_scope(
                    flow, types.SimpleNamespace())
            except SystemExit as exc:
                forged_scope_receipt_blocked = exc.code == 2
            check("独立任务范围确认不能由 Agent 无用户收据推进",
                  forged_scope_receipt_blocked)
            scope_prompt = json.dumps(
                {"cwd": td, "prompt": "范围没问题，优先覆盖大量行缺失的文件"},
                ensure_ascii=False) + "\n"
            captured = subprocess.run(
                [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
                cwd=td, input=scope_prompt, text=True, capture_output=True, timeout=10)
            mf.cmd_action_confirm_scope(
                flow, types.SimpleNamespace())
            action = mf._load_action()
            ut_task = action.get("agent_tasks", {}).get("UT", {})
            check("用户二次确认后独立 UT 才生成任务卡",
                  captured.returncode == 0 and action.get("kind") == "ut"
                  and action.get("scope_confirmation_receipt", {}).get(
                      "scope_sha256") == action.get("scope_sha256")
                  and ut_task.get("standalone")
                  and os.path.isfile(ut_task.get("path", ""))
                  and not os.path.exists(mf.STATE_PATH)
                  and mf.sh("git rev-parse HEAD") == base_head)
            action.setdefault("tokens", {})["UT"] = {
                "status": "PASS", "report_path": os.path.join(action["work_dir"], "result-ut.md")}
            mf._save_action(action)
            mf.cmd_action_finish(types.SimpleNamespace(report=None))
            check("独立 UT 完成后自动解除控制且不自动提交",
                  not os.path.exists(mf.ACTION_PATH) and mf.sh("git rev-parse HEAD") == base_head
                  and ".mae-flow-work" not in mf.sh("git status --short")
                  and not os.path.exists(".gitignore"))

            os.makedirs("tests", exist_ok=True)
            open("tests/CodeCheckTest.cpp", "w", encoding="utf-8").write(
                "int codecheck_test_only = 1;\n")
            codecheck_test_only_blocked = False
            try:
                mf.cmd_action_start(flow, None, types.SimpleNamespace(
                    kind="codecheck", request="只传测试文件", files=["tests/CodeCheckTest.cpp"],
                    generator=None, ut_command=None, **common))
            except SystemExit as exc:
                codecheck_test_only_blocked = exc.code == 2
            os.remove("tests/CodeCheckTest.cpp")
            os.rmdir("tests")
            check("独立 CodeCheck 排除测试文件且不会把空结果扩大到全仓",
                  codecheck_test_only_blocked and not os.path.exists(mf.ACTION_PATH))

            old_run = mf._run_codecheck
            try:
                calls = []
                mf._run_codecheck = lambda files, *_args: (
                    calls.append(list(files)) or
                    {"total": 0, "pairs": [], "commands": ["codecheck fullcheck -f " + ",".join(files)]}, "")
                mf.cmd_action_start(flow, None, types.SimpleNamespace(
                    kind="codecheck", request="检查当前业务改动", files=["biz.cpp"],
                    generator=None, ut_command=None, **common))
                pending_codecheck = mf._load_action()
                check("独立 CodeCheck 范围确认前不运行扫描",
                      pending_codecheck.get("status") == "awaiting_scope_confirmation"
                      and not calls)
                scope_prompt = json.dumps(
                    {"cwd": td, "prompt": "确认以上范围"},
                    ensure_ascii=False) + "\n"
                captured_cc = subprocess.run(
                    [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
                    cwd=td, input=scope_prompt, text=True, capture_output=True, timeout=10)
                mf.cmd_action_confirm_scope(
                    flow, types.SimpleNamespace())
            finally:
                mf._run_codecheck = old_run
            check("独立 CodeCheck 经用户确认后首检为零不派 Agent",
                  captured_cc.returncode == 0 and calls == [["biz.cpp"]]
                  and not os.path.exists(mf.ACTION_PATH)
                  and not os.path.exists(mf.STATE_PATH)
                  and mf.sh("git rev-parse HEAD") == base_head)

            mf.cmd_action_start(flow, None, types.SimpleNamespace(
                kind="grill", request="支持按名称查询基站", files=[],
                generator=None, ut_command=None, **common))
            grill = mf._load_action()
            prep = grill["grill"]["prep"]
            clarification = grill["grill"]["clarifications"]
            open(prep, "w", encoding="utf-8").write("# 备课\n\n八维检查已完成。\n")
            open(clarification, "w", encoding="utf-8").write(
                "# 澄清结果\n\nWHEN 输入名称为空 THE SYSTEM SHALL 返回参数错误。\n")
            # 双查承诺:prep 与 final 各一轮;finish 现在硬校验 prep 是否执行过
            mf.cmd_action_critic(types.SimpleNamespace(
                stage="prep", document=prep))
            mf.cmd_action_critic(types.SimpleNamespace(
                stage="final", document=clarification))
            grill = mf._load_action()
            grill.setdefault("tokens", {})["GRILL"] = {
                "status": "CLEAR", "report_path": os.path.join(grill["work_dir"], "result-grill.md")}
            mf._save_action(grill)
            mf.cmd_action_finish(types.SimpleNamespace(report=clarification))
            check("独立 Grill 只产出澄清结果且不进入设计编码",
                  not os.path.exists(mf.ACTION_PATH)
                  and not os.path.exists(mf.STATE_PATH)
                  and mf.sh("git rev-parse HEAD") == base_head)
            os.makedirs(os.path.dirname(mf.ACTION_PATH), exist_ok=True)
            open(mf.ACTION_PATH, "w", encoding="utf-8").write("{broken")
            mf.cmd_action_cancel()
            check("独立任务状态损坏也能取消且不影响普通开发",
                  not os.path.exists(mf.ACTION_PATH) and not os.path.exists(mf.STATE_PATH))
            running = {"current": "config_confirm", "config": {}, "choices": {},
                       "history": [], "started": time.strftime("%Y-%m-%d %H:%M:%S")}
            mf.save_state(running)
            overlap_blocked = False
            try:
                mf.cmd_action_start(flow, running, types.SimpleNamespace(
                    kind="grill", request="测试需求", source=None, files=[],
                    build=None, generator=None, ut_command=None, check_only=False))
            except SystemExit as exc:
                overlap_blocked = exc.code == 2
            check("完整流程运行时不会叠加独立任务",
                  overlap_blocked and not os.path.exists(mf.ACTION_PATH))
            os.remove(mf.STATE_PATH)

            # 走真实 argparse/子进程入口，并模拟 Windows 中文控制台编码。
            cli_env = dict(os.environ)
            cli_env["PYTHONIOENCODING"] = "cp936"
            cli_request = "为中文类补充空名称和超长名称边界测试"
            cli = subprocess.run([
                sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
                "action", "start", "ut",
                "--request", cli_request,
                "--files", "biz.cpp",
                "--generator", "AutoUT",
                "--ut-command", "mcde test --ut",
            ], env=cli_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding="cp936", errors="replace")
            cli_action = mf._load_action()
            cli_sources = cli_action.get("sources", []) if cli_action else []
            request_text = (open(cli_sources[0], encoding="utf-8").read()
                            if cli_sources and os.path.isfile(cli_sources[0]) else "")
            check("独立任务真实 CLI 在 Windows 中文编码下保持需求原文",
                  cli.returncode == 0 and cli_request in request_text
                  and cli_action.get("status") == "awaiting_scope_confirmation"
                  and not os.path.exists(mf.STATE_PATH), cli.stdout)
            cli_prompt = json.dumps(
                {"cwd": td, "prompt": "确认以上范围"},
                ensure_ascii=False) + "\n"
            cli_capture = subprocess.run(
                [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
                cwd=td, input=cli_prompt, text=True, capture_output=True, timeout=10)
            cli_confirm = subprocess.run([
                sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
                "action", "confirm-scope",
            ], env=cli_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding="cp936", errors="replace")
            cli_confirmed_action = mf._load_action()
            check("独立任务真实 CLI 可在 Windows 中文环境完成范围确认",
                  cli_capture.returncode == 0 and cli_confirm.returncode == 0
                  and cli_confirmed_action.get("status") == "active"
                  and cli_confirmed_action.get("agent_tasks", {}).get("UT"),
                  cli_confirm.stdout)
            cancel = subprocess.run([
                sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
                "action", "cancel",
            ], env=cli_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding="cp936", errors="replace")
            check("独立任务真实 CLI 可取消并立即解除控制",
                  cancel.returncode == 0 and not os.path.exists(mf.ACTION_PATH),
                  cancel.stdout)
        finally:
            os.chdir(old_cwd)

    # 退出必须保留业务现场、归档状态并使直接模式标记立即可见。
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            open("keep.cpp", "w", encoding="utf-8").write("int keep = 1;\n")
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            subprocess.run(["git", "add", "keep.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            now = "2026-07-22 20:00:00"
            st = {"current": "config_confirm", "config": {"单号": "REQEXIT1"},
                  "choices": {}, "history": [], "started": now}
            mf.save_state(st)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                response = json.dumps({"answers": {"exit": "确认退出流程并保留代码"}}, ensure_ascii=False)
                json.dump([{"text": response, "step": "config_confirm", "at": now}],
                          f, ensure_ascii=False)
            mf.cmd_exit(flow, st, types.SimpleNamespace(ack="", reason=""))
            check("exit 只预览时不会解除门禁",
                  os.path.isfile(mf.STATE_PATH) and not os.path.exists(mf.EXIT_PATH))
            agent_interactive_blocked = False
            try:
                mf.cmd_exit(flow, st, types.SimpleNamespace(
                    ack="", reason="模拟 Agent 调用", intent=None, interactive=True))
            except SystemExit as exc:
                agent_interactive_blocked = exc.code == 2
            check("TTY 紧急出口不能由非交互 Agent 进程代答",
                  agent_interactive_blocked and os.path.isfile(mf.STATE_PATH))
            mf.cmd_exit(flow, st, types.SimpleNamespace(
                ack="确认退出流程并保留代码", reason="改为直接开发"))
            rec = json.load(open(mf.EXIT_PATH, encoding="utf-8"))
            snap = rec.get("snapshot", "")
            check("exit 保留业务文件并归档流程现场",
                  open("keep.cpp", encoding="utf-8").read() == "int keep = 1;\n"
                  and not os.path.exists(mf.STATE_PATH)
                  and os.path.isfile(os.path.join(snap, mf.STATE_PATH))
                  and os.path.isfile(os.path.join(snap, "exit-record.json")))
            check("exit 记录步骤、原因与旧证据失效边界",
                  rec.get("step") == "config_confirm" and rec.get("reason") == "改为直接开发"
                  and bool(re.fullmatch(r"[0-9a-f]{40}", rec.get("head", ""))))
            reenable_blocked = False
            try:
                mf._resume_direct_mode()
            except SystemExit as exc:
                reenable_blocked = exc.code == 2
            check("Agent 不能自行重新启用流程",
                  reenable_blocked and os.path.exists(mf.EXIT_PATH))
            rec["direct_messages"] = [{
                "id": "resume-answer-1",
                "text": json.dumps({
                    "answers": {"是否恢复": "确认重新启用mae-flow"}
                }, ensure_ascii=False),
            }]
            mf._write_json_atomic(mf.EXIT_PATH, rec)
            restored = mf._resume_direct_mode(message_id="resume-answer-1")
            check("Direct 模式按钮确认可按真实消息ID恢复原断点且清空旧令牌",
                  not os.path.exists(mf.EXIT_PATH) and restored.get("current") == "config_confirm"
                  and os.path.isfile(mf.STATE_PATH) and not os.path.exists(mf.STATE_PATH + ".tokens"))

            # 晚阶段退出后直接改过源码：恢复时不得回到原步骤继续吃旧证据。
            restored["current"] = "external_verify"
            restored["choices"] = {"workflow": "full"}
            restored["quality"] = {"codecheck_scan": {"total": 0}}
            restored["agent_tasks"] = {"UT": {"head": rec["head"]}}
            mf.save_state(restored)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "确认再次退出", "step": "external_verify", "at": now}], f,
                          ensure_ascii=False)
            mf.cmd_exit(flow, restored, types.SimpleNamespace(ack="确认再次退出", reason="临时直接修复"))
            open("keep.cpp", "a", encoding="utf-8").write("int changed = 2;\n")
            rec2 = json.load(open(mf.EXIT_PATH, encoding="utf-8"))
            rec2["direct_messages"] = [{"text": "重新接回 mae-flow"}]
            mf._write_json_atomic(mf.EXIT_PATH, rec2)
            resumed2 = mf._resume_direct_mode("重新接回 mae-flow")
            check("退出期间改过源码会回退宽 build 步并废弃旧证据",
                  resumed2.get("current") == "build"
                  and "quality" not in resumed2 and "agent_tasks" not in resumed2
                  and not os.path.exists(mf.STATE_PATH + ".tokens"))

            # 新增的最终检视节点也必须属于晚阶段回流范围；否则 Direct
            # 模式改码后会直接留在检视页，绕过重新编译和质量链。
            subprocess.run(["git", "add", "keep.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "direct change"], check=True)
            resumed2["current"] = "delivery_review"
            resumed2["choices"] = {"workflow": "full"}
            mf.save_state(resumed2)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "确认第三次退出", "step": "delivery_review",
                            "at": now}], f, ensure_ascii=False)
            mf.cmd_exit(flow, resumed2, types.SimpleNamespace(
                ack="确认第三次退出", reason="最终检视时直接修复"))
            open("keep.cpp", "a", encoding="utf-8").write("int final_changed = 3;\n")
            rec3 = json.load(open(mf.EXIT_PATH, encoding="utf-8"))
            rec3["direct_messages"] = [{"text": "重新接回 mae-flow"}]
            mf._write_json_atomic(mf.EXIT_PATH, rec3)
            resumed3 = mf._resume_direct_mode("重新接回 mae-flow")
            check("最终检视期间 Direct 改码会回退宽 build 步",
                  resumed3.get("current") == "build")
        finally:
            os.chdir(old_cwd)

    # Direct 生命周期：终态恢复应自动换单；明确 review-fix 应保留旧现场并开启新轮次。
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            head = mf.sh("git rev-parse --verify HEAD")
            snapshot = os.path.join(".mae-flow-work", "exited", "terminal")
            os.makedirs(snapshot)
            terminal_state = {
                "current": "end", "config": {"单号": "REQ-END"},
                "choices": {"workflow": "full"}, "history": [],
                "started": "2026-07-27 10:00:00",
            }
            json.dump(
                terminal_state,
                open(os.path.join(snapshot, mf.STATE_PATH), "w", encoding="utf-8"),
                ensure_ascii=False)
            mf._write_json_atomic(mf.EXIT_PATH, {
                "status": "exited", "snapshot": snapshot, "head": head,
                "direct_messages": [{
                    "id": "terminal-next",
                    "text": "重新接回 mae-flow 开启下一单",
                }],
            })
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_init(flow, types.SimpleNamespace(
                    ack=None, message_id="terminal-next", new=False))
            terminal_new = mf.load_state()
            terminal_last = json.load(open(
                mf.STATE_PATH + ".last", encoding="utf-8"))
            check("退出快照已终态时 init 自动备份上一单并开启新流程",
                  terminal_new.get("current") == flow["start"]
                  and terminal_last.get("current") == "end"
                  and not os.path.exists(mf.EXIT_PATH))

            # 不经 Direct 的普通终态换单也必须清掉上一轮辅助状态，不能把消息、
            # Agent 令牌或失败计数带进下一张单。
            terminal_new["current"] = "end"
            terminal_new["config"] = {"单号": "REQ-END-2"}
            mf.save_state(terminal_new)
            mf._write_json_atomic(mf.STATE_PATH + ".tokens", {
                "UT": {"status": "PASS", "step": "verify_ut"},
            })
            mf._write_json_atomic(mf.STATE_PATH + ".usermsg", [{
                "text": "上一单消息", "step": "config_confirm",
                "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }])
            mf._write_json_atomic(mf.FAILURE_PATH, {
                "ack:config_confirm": {"count": 3},
            })
            mf._write_json_atomic(mf.AGENT_WRITES_PATH, {
                "paths": {"old.cpp": {"tool": "file-write"}},
            })
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_init(flow, types.SimpleNamespace(
                    ack=None, message_id=None, new=False))
            fresh_round = mf.load_state()
            fresh_writes = json.load(open(
                mf.AGENT_WRITES_PATH, encoding="utf-8"))
            check("普通终态换单清空旧消息令牌和失败计数",
                  fresh_round.get("current") == flow["start"]
                  and not os.path.exists(mf.STATE_PATH + ".tokens")
                  and not os.path.exists(mf.STATE_PATH + ".usermsg")
                  and not os.path.exists(mf.FAILURE_PATH)
                  and fresh_writes == {"paths": {}})
        finally:
            os.chdir(old_cwd)

    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            stale_id_blocked = False
            stale_id_err = io.StringIO()
            try:
                with contextlib.redirect_stderr(stale_id_err):
                    mf.cmd_init(flow, types.SimpleNamespace(
                        ack=None, message_id="missing-exit-record", new=False))
            except SystemExit as exc:
                stale_id_blocked = exc.code == 2
            check("退出指针不存在时失效消息ID不会悄悄新建流程",
                  stale_id_blocked and not os.path.exists(mf.STATE_PATH)
                  and "不能悄悄改成新建流程" in stale_id_err.getvalue())
        finally:
            os.chdir(old_cwd)

    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            head = mf.sh("git rev-parse --verify HEAD")
            snapshot = os.path.join(".mae-flow-work", "exited", "paused")
            os.makedirs(snapshot)
            paused_state = {
                "current": "verify_ut", "config": {"单号": "REQ-OLD"},
                "choices": {"workflow": "full"}, "history": [],
                "started": "2026-07-27 10:00:00",
            }
            json.dump(
                paused_state,
                open(os.path.join(snapshot, mf.STATE_PATH), "w", encoding="utf-8"),
                ensure_ascii=False)
            # 真实 exit 会先写一份退出时记录；后续 Direct 消息只追加到根指针。
            # 重入前必须把最新版同步回来，不能因为旧文件已存在就丢授权审计。
            json.dump(
                {"status": "exited", "snapshot": snapshot,
                 "direct_messages": []},
                open(os.path.join(snapshot, "exit-record.json"),
                     "w", encoding="utf-8"),
                ensure_ascii=False)
            review_prompt = (
                "/mae-flow:mae-flow review-fix REQ-NEW "
                "评审方案改为通过version判断字段")
            original_branch = mf.sh("git branch --show-current")
            mf._write_json_atomic(mf.EXIT_PATH, {
                "status": "exited", "snapshot": snapshot, "head": head,
                "branch": original_branch,
                "direct_messages": [{
                    "id": "review-new", "text": review_prompt,
                }, {
                    "id": "resume-old", "text": "重新接回 mae-flow",
                }],
            })
            direct_messages_out = io.StringIO()
            with contextlib.redirect_stdout(direct_messages_out):
                mf.cmd_direct_messages(types.SimpleNamespace(
                    id=None, full=False))
            check("Direct 模式 messages 提供稳定ID和恢复/换单命令",
                  "review-new" in direct_messages_out.getvalue()
                  and "init --new --message-id" in direct_messages_out.getvalue())
            check("Direct 重入只认明确动作而不把 review-fix 咨询当授权",
                  not mf._explicit_direct_reentry("review-fix 是什么？")
                  and not mf._explicit_direct_reentry("这个项目支持 review-fix 吗？")
                  and not mf._explicit_direct_reentry("review-fix 能修复这个问题吗？")
                  and not mf._explicit_direct_reentry("怎么恢复 mae-flow？")
                  and not mf._explicit_direct_reentry("mae-flow 能恢复吗？")
                  and not mf._explicit_direct_reentry("不确认重新启用mae-flow")
                  and not mf._explicit_direct_reentry("不要恢复 mae-flow")
                  and not mf._explicit_direct_reentry(
                      "不要恢复 mae-flow，直接帮我改代码")
                  and not mf._explicit_direct_reentry(
                      "不要执行 review-fix，按普通开发处理")
                  and not mf._explicit_direct_reentry("暂时不要接回这个工作流")
                  and mf._explicit_direct_reentry(
                      "review-fix 现在方案有变动，请按 version 修复")
                  and mf._explicit_direct_reentry(
                      "review-fix 现在方案有变动，不要按长度判断，请改用version")
                  and mf._explicit_direct_reentry(
                      "/mae-flow:mae-flow review-fix 不要按字节长度判断，请改用version")
                  and mf._explicit_direct_reentry("确认重新启用"))
            check("命名空间 Slash 入口统一分流且独立任务不误启完整流程",
                  mf._moonlight_activation_decision(
                      "/mae-flow:mae-flow moonlight REQ-NEW") == "allow"
                  and mf._direct_reentry_decision(
                      "/mae-flow:mae-flow") == "allow"
                  and mf._direct_reentry_decision(
                      "/mae-flow:mae-flow review-fix 修复意见") == "allow"
                  and mf._direct_reentry_decision(
                      "/mae-flow:mae-flow ut 补测试") == "neutral")
            revoked_auth, revoked_why = mf._direct_reentry_authorization({
                "direct_messages": [{
                    "id": "older-positive", "text": "重新启用 mae-flow",
                }, {
                    "id": "newer-negative", "text": "不要恢复 mae-flow",
                }],
            }, message_id="older-positive")
            check("Direct 最新明确拒绝会撤销旧的重入消息ID",
                  not revoked_auth and "旧消息 ID 已撤销" in revoked_why)

            status_out = io.StringIO()
            with contextlib.redirect_stdout(status_out):
                mf.print_direct_mode_status()
            check("Direct 状态提示展示消息ID恢复和保留现场换单路径",
                  "init --message-id" in status_out.getvalue()
                  and "init --new --message-id" in status_out.getvalue())

            invalid_err = io.StringIO()
            invalid_blocked = False
            try:
                with contextlib.redirect_stderr(invalid_err):
                    mf.cmd_init(flow, types.SimpleNamespace(
                        ack="删掉命令前缀后的转述", message_id=None, new=True))
            except SystemExit as exc:
                invalid_blocked = exc.code == 2
            check("重入授权失败保留退出指针并明确禁止手工改名",
                  invalid_blocked and os.path.exists(mf.EXIT_PATH)
                  and "禁止手工移动" in invalid_err.getvalue())

            original_prepare = mf.prepare_project
            preflight_blocked = False
            try:
                def fail_prepare(_root):
                    raise mf.CapabilityError("预检失败夹具")

                mf.prepare_project = fail_prepare
                try:
                    mf.cmd_init(flow, types.SimpleNamespace(
                        ack=None, message_id="review-new", new=True))
                except SystemExit as exc:
                    preflight_blocked = exc.code == 2
            finally:
                mf.prepare_project = original_prepare
            check("开启另一流程预检失败时不提前消费退出指针",
                  preflight_blocked and os.path.exists(mf.EXIT_PATH)
                  and not os.path.exists(mf.STATE_PATH))

            original_save = mf.save_state
            state_write_failed = False
            try:
                def fail_save(_state):
                    raise RuntimeError("状态写盘失败夹具")

                mf.save_state = fail_save
                try:
                    mf.cmd_init(flow, types.SimpleNamespace(
                        ack=None, message_id="review-new", new=True))
                except RuntimeError:
                    state_write_failed = True
            finally:
                mf.save_state = original_save
            check("开启另一流程主状态写盘失败时退出指针仍可恢复",
                  state_write_failed and os.path.exists(mf.EXIT_PATH)
                  and not os.path.exists(mf.STATE_PATH))

            subprocess.run(
                ["git", "checkout", "-qb", "direct-other"], check=True)
            branch_err = io.StringIO()
            wrong_branch_blocked = False
            try:
                with contextlib.redirect_stderr(branch_err):
                    mf.cmd_init(flow, types.SimpleNamespace(
                        ack=None, message_id="resume-old", new=False))
            except SystemExit as exc:
                wrong_branch_blocked = exc.code == 2
            check("恢复原断点时错误分支会被挡住且退出指针仍可重试",
                  wrong_branch_blocked and os.path.exists(mf.EXIT_PATH)
                  and original_branch in branch_err.getvalue())
            subprocess.run(["git", "checkout", "-q", original_branch], check=True)

            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_init(flow, types.SimpleNamespace(
                    ack=None, message_id="review-new", new=True))
            review_new = mf.load_state()
            archived_exit = json.load(open(
                os.path.join(snapshot, "exit-record.json"),
                encoding="utf-8"))
            check("明确 review-fix 可保留未完成旧现场并开启另一流程",
                  review_new.get("current") == flow["start"]
                  and os.path.isfile(os.path.join(snapshot, mf.STATE_PATH))
                  and not os.path.exists(mf.EXIT_PATH))
            check("消费退出指针前会把最新授权消息同步回快照",
                  any(item.get("id") == "review-new"
                      for item in archived_exit.get("direct_messages", [])))
        finally:
            os.chdir(old_cwd)

    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            active = {
                "current": "config_confirm", "config": {}, "choices": {},
                "history": [], "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            mf.save_state(active)
            snapshot = os.path.join(".mae-flow-work", "exited", "stale")
            os.makedirs(snapshot)
            json.dump(
                {
                    "current": "verify_ut", "config": {"单号": "STALE"},
                    "choices": {"workflow": "full"}, "history": [],
                    "started": "2026-07-27 10:00:00",
                },
                open(os.path.join(snapshot, mf.STATE_PATH), "w", encoding="utf-8"),
                ensure_ascii=False)
            mf._write_json_atomic(mf.EXIT_PATH, {
                "status": "exited", "snapshot": snapshot,
                "head": mf.sh("git rev-parse --verify HEAD"),
                "direct_messages": [{
                    "id": "stale-resume", "text": "重新接回 mae-flow",
                }],
            })
            conflict_blocked = False
            try:
                mf.cmd_init(flow, types.SimpleNamespace(
                    ack=None, message_id="stale-resume", new=False))
            except SystemExit as exc:
                conflict_blocked = exc.code == 2
            check("主状态与退出指针冲突时 init 不用旧 snapshot 覆盖有效主状态",
                  conflict_blocked and mf.load_state().get("current") == "config_confirm")

            moon_ack = "开启月光宝盒继续当前流程"
            json.dump(
                [{"text": moon_ack, "step": "config_confirm",
                  "at": active["started"]}],
                open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8"),
                ensure_ascii=False)
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_moonlight(flow, active, types.SimpleNamespace(
                    action="on", ack="月光宝盒", reason=None))
            conflict_moon = mf.load_state()
            check("主状态与退出指针冲突时月光入口继续当前主状态",
                  conflict_moon.get("current") == "config_confirm"
                  and mf._moonlight(conflict_moon)
                  and os.path.exists(mf.EXIT_PATH))
        finally:
            os.chdir(old_cwd)

    # 用户风险放行：只替代当前步骤的 Agent 令牌，必须真实 ack，代码变化/推进后立即失效。
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            os.makedirs("src/test")
            open("src/test/FooTest.cpp", "w", encoding="utf-8").write("int test_value = 1;\n")
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            subprocess.run(["git", "add", "src/test/FooTest.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            risk_ack = "确认承担UT结果未被harness核实的风险并继续"
            risk_state = {"current": "build", "config": {}, "choices": {"workflow": "review"},
                          "history": [], "started": now}
            mf.save_state(risk_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"id": "risk-ut", "text": risk_ack,
                            "step": "build", "at": now}], f, ensure_ascii=False)
            fake_blocked = False
            try:
                mf.cmd_accept_risk(flow, risk_state, types.SimpleNamespace(
                    agent="ut", reason="UT 未核实",
                    message_id="agent-forged-id"))
            except SystemExit as exc:
                fake_blocked = exc.code == 2
            check("Agent 令牌风险放行必须匹配用户真实原话", fake_blocked)
            # 2026-08-25 编排瘦身:主流程不再索要 UT/COMPILE 令牌,
            # accept-risk 的放行/失效/过期机制由 STORY/GRILL 等仍在用的
            # agent_ran 证据共享,详细覆盖在单元测试。

        finally:
            os.chdir(old_cwd)

    # 月光宝盒在终态换单时与普通 init 使用同一套辅助状态清场。
    with _TmpDir() as td:
        old_cwd = os.getcwd()
        try:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            terminal_moon = {
                "current": "end", "config": {"单号": "REQ-MOON-END"},
                "choices": {"workflow": "full"}, "history": [], "started": now,
            }
            mf.save_state(terminal_moon)
            mf._write_json_atomic(mf.STATE_PATH + ".usermsg", [{
                "text": "开启月光宝盒继续下一单", "step": "end", "at": now,
            }])
            mf._write_json_atomic(mf.STATE_PATH + ".tokens", {
                "UT": {"status": "PASS", "step": "verify_ut"},
            })
            mf._write_json_atomic(mf.FAILURE_PATH, {"ack:config_confirm": {"count": 2}})
            mf._write_json_atomic(mf.AGENT_WRITES_PATH, {
                "paths": {"old.cpp": {"tool": "file-write"}},
            })
            with contextlib.redirect_stdout(io.StringIO()):
                mf.cmd_moonlight(flow, terminal_moon, types.SimpleNamespace(
                    action="on", ack="月光宝盒", reason=None))
            moon_new = mf.load_state()
            moon_writes = json.load(open(
                mf.AGENT_WRITES_PATH, encoding="utf-8"))
            check("月光终态换单同样清空旧辅助状态",
                  moon_new.get("current") == flow["start"]
                  and mf._moonlight(moon_new)
                  and not os.path.exists(mf.STATE_PATH + ".tokens")
                  and not os.path.exists(mf.STATE_PATH + ".usermsg")
                  and not os.path.exists(mf.FAILURE_PATH)
                  and moon_writes == {"paths": {}})
        finally:
            os.chdir(old_cwd)

    # 月光宝盒：普通门禁不变；仅显式启用后替代在线确认，质量失败留痕推进，
    # push 后停在晨间检查，并可按报告重新进入完整质量链。
    old_cwd = os.getcwd()
    try:
        # 全新项目没有 .mae-flow.json：UserPromptSubmit 先留下十分钟内的一次性授权，
        # 脚本消费后再创建状态，保证“一句话开启”不是鸡生蛋。
        with _TmpDir() as td:
            subprocess.run(["git", "init", "-q", td], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], cwd=td, check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], cwd=td, check=True)
            open(os.path.join(td, "biz.cpp"), "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], cwd=td, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=td, check=True)
            child = os.path.join(td, "service", "module")
            os.makedirs(child)
            os.chdir(td)
            rejected_preinit = []
            for text in ("月光宝盒是什么？", "不要开启月光宝盒"):
                mf._write_json_atomic(mf.MOONLIGHT_INTENT_PATH, {
                    "epoch": time.time(), "text": text,
                })
                rejected_preinit.append(
                    mf._consume_preinit_moonlight_intent("月光宝盒")[0])
            check("月光宝盒咨询和否定不能冒充预初始化授权",
                  rejected_preinit == [False, False])
            payload = json.dumps({
                "cwd": child,
                "prompt": "今晚开启月光宝盒，把这个需求尽力开发完并推送",
            }, ensure_ascii=False) + "\n"
            hook = subprocess.run(
                [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
                cwd=child, input=payload, text=True, capture_output=True, timeout=10)
            os.chdir(td)
            intent_at_root = os.path.isfile(mf.MOONLIGHT_INTENT_PATH)
            mf.cmd_moonlight(flow, None, types.SimpleNamespace(
                action="on", ack="月光宝盒", reason=None))
            fresh = mf.load_state()
            check("全新项目可从子目录一句话开启月光宝盒",
                  hook.returncode == 0 and intent_at_root and mf._moonlight(fresh)
                  and not os.path.exists(mf.MOONLIGHT_INTENT_PATH)
                  and "REQ" not in (fresh.get("moonlight") or {}).get("request", "")
                  and "这个需求" in (fresh.get("moonlight") or {}).get("request", ""))

            fresh["current"] = "config_confirm"
            mf.save_state(fresh)
            stop_payload = json.dumps({"cwd": td, "stop_hook_active": False}) + "\n"

            def _stop_once(active):
                return subprocess.run(
                    [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "stop"],
                    cwd=td, input=json.dumps({"cwd": td, "stop_hook_active": active}) + "\n",
                    text=True, capture_output=True, timeout=10)

            stopped = _stop_once(False)
            # 反收工护栏是「无进展计数」:stop_hook_active 在同一延续链恒为 true,
            # 一发放行会造成整夜静默白夜。零进展连续 3 次打回后才 fail-open;
            # 状态 revision 推进后重新计数、继续拦。
            zero_progress = [_stop_once(True).returncode for _ in range(4)]
            mf.save_state(fresh)   # revision 推进 = 有真实进展(复用同一对象,保住后续 CAS)
            progressed_stop = _stop_once(True)
            check("月光宝盒非安全停点会由Stop Hook阻止主Agent提前结束",
                  stopped.returncode == 2 and "禁止提前结束" in stopped.stderr
                  and zero_progress == [2, 2, 0, 0]
                  and progressed_stop.returncode == 2)
            mf.cmd_moonlight(flow, fresh, types.SimpleNamespace(
                action="blocked", ack=None,
                reason="缺少公司远端环境访问权限，已检查本地配置仍无法取得，夜间不能继续"))
            blocked_state = mf.load_state()
            allowed_stop = subprocess.run(
                [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "stop"],
                cwd=td, input=stop_payload, text=True, capture_output=True, timeout=10)
            check("真实硬阻塞留痕后Stop Hook允许停止且晨间可原步骤恢复",
                  allowed_stop.returncode == 0
                  and bool((blocked_state.get("moonlight") or {}).get("hard_blocked")))
            mf.cmd_moonlight(flow, blocked_state, types.SimpleNamespace(
                action="repair", ack=None, reason=None))
            check("硬阻塞修复轮保留原步骤继续",
                  mf.load_state().get("current") == "config_confirm"
                  and not (mf.load_state().get("moonlight") or {}).get("hard_blocked"))

            # 2026-08-25 编排瘦身:build 是唯一质量步且按设计允许硬阻塞
            # (需求/依赖阻塞),"质量步不能 blocked"的旧断言随编排退役。

            archive_now = time.strftime("%Y-%m-%d %H:%M:%S")
            archive_state = {
                "current": "archive",
                "config": {"单号": "REQMOONARCH", "CHANGE_NAME": "moon-archive"},
                "choices": {"workflow": "full"}, "history": [], "started": archive_now,
            }
            os.makedirs(os.path.join("openspec", "changes", "moon-archive"))
            mf.save_state(archive_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "现在切换月光宝盒", "step": "archive", "at": archive_now}], f)
            mf.cmd_moonlight(flow, archive_state, types.SimpleNamespace(
                action="on", ack="月光宝盒", reason=None))
            check("定稿尚未执行时中途切月光宝盒会先推送不自动定稿",
                  mf.load_state().get("current") == "push")

            partial_state = {
                "current": "archive",
                "config": {"单号": "REQMOONARCH2", "CHANGE_NAME": "missing-change"},
                "choices": {"workflow": "full"}, "history": [], "started": archive_now,
            }
            mf.save_state(partial_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "月光宝盒继续", "step": "archive", "at": archive_now}], f)
            mf.cmd_moonlight(flow, partial_state, types.SimpleNamespace(
                action="on", ack="月光宝盒", reason=None))
            partial = mf.load_state()
            check("定稿可能已开始时不自动回滚或补做而是记录硬阻塞",
                  partial.get("current") == "archive"
                  and bool((partial.get("moonlight") or {}).get("hard_blocked")))

        # 已明确退出的项目也可切到月光宝盒；恢复旧断点但清空旧质量凭证。
        with _TmpDir() as td:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            head = subprocess.run(["git", "rev-parse", "HEAD"], check=True,
                                  capture_output=True, text=True).stdout.strip()
            snapshot = os.path.join(".mae-flow-work", "exited", "fixture")
            os.makedirs(snapshot)
            direct_state = {
                "current": "build", "config": {"单号": "REQMOON0"},
                "choices": {"workflow": "review"}, "history": [],
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
                "agent_tasks": {"CODECHECK": {"old": True}},
            }
            with open(os.path.join(snapshot, mf.STATE_PATH), "w", encoding="utf-8") as f:
                json.dump(direct_state, f)
            with open(mf.EXIT_PATH, "w", encoding="utf-8") as f:
                json.dump({
                    "snapshot": snapshot, "head": head,
                    "direct_messages": [{"text": "切换月光宝盒继续做"}],
                }, f)
            mf.cmd_moonlight(flow, None, types.SimpleNamespace(
                action="continue", ack="月光宝盒", reason=None))
            resumed = mf.load_state()
            check("普通开发模式可由用户明确切换到月光宝盒",
                  mf._moonlight(resumed) and resumed.get("current") == "build"
                  and "切换月光宝盒继续做" in (resumed.get("moonlight") or {}).get("request", "")
                  and "agent_tasks" not in resumed and not os.path.exists(mf.EXIT_PATH))

        with _TmpDir() as td:
            os.chdir(td)
            subprocess.run(["git", "init", "-q"], check=True)
            subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
            subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
            open("biz.cpp", "w", encoding="utf-8").write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            ml_state = {
                "current": "build", "config": {"单号": "REQMOON1"},
                "choices": {"workflow": "review"}, "history": [], "started": now,
            }
            mf.save_state(ml_state)
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "不要开启月光宝盒", "step": "build",
                            "at": now}], f, ensure_ascii=False)
            negative_moonlight_blocked = False
            try:
                mf.cmd_moonlight(flow, ml_state, types.SimpleNamespace(
                    action="on", ack="月光宝盒", reason=None))
            except SystemExit as exc:
                negative_moonlight_blocked = exc.code == 2
            check("在途流程的月光宝盒否定原话不会开启无人值守",
                  negative_moonlight_blocked and not mf._moonlight(mf.load_state()))
            with open(mf.STATE_PATH + ".usermsg", "w", encoding="utf-8") as f:
                json.dump([{"text": "开启月光宝盒继续开发", "step": "build", "at": now}],
                          f, ensure_ascii=False)
            mf.cmd_moonlight(flow, ml_state, types.SimpleNamespace(
                action="on", ack="月光宝盒", reason=None))
            ml_state = mf.load_state()
            ask_ok, _ = mf.ev_agent_ran({"agent": "ASKUSER"}, ml_state)
            check("月光宝盒必须由真实用户消息开启且替代在线确认",
                  mf._moonlight(ml_state) and ask_ok)

            defer_reason = "CodeCheck仍有1条环境相关告警，已复查并尝试修复两次，继续会重复消耗"
            # build defer 的实现完成边界(实现清单全勾+改动已提交)在夹具里
            # 没有材料;边界本身由单元测试覆盖,这里只演练 defer 登记链路。
            old_boundary = mf._moonlight_build_defer_boundary
            mf._moonlight_build_defer_boundary = lambda _st: (True, "")
            try:
                mf.cmd_moonlight(flow, ml_state, types.SimpleNamespace(
                    action="defer", ack=None, reason=defer_reason))
            finally:
                mf._moonlight_build_defer_boundary = old_boundary
            deferred = mf.load_state()
            unresolved = mf._moonlight_unresolved(deferred)
            check("月光宝盒质量失败留痕后继续而不伪装通过",
                  deferred.get("current") == "domain_archive"
                  and len(unresolved) == 1
                  and unresolved[0].get("kind") == "compile"
                  and os.path.isfile(mf.MOONLIGHT_REPORT_PATH))
            archive_waiting = deferred
            mf.cmd_moonlight(flow, archive_waiting, types.SimpleNamespace(
                action="blocked", ack=None,
                reason="领域索引文件只读，无法安全写入归档结果"))
            blocked_archive = mf.load_state()
            check("月光宝盒遇领域归档外部硬阻塞可安全停机",
                  blocked_archive.get("current") == "domain_archive"
                  and (blocked_archive.get("moonlight") or {}).get("hard_blocked")
                  and os.path.isfile(mf.MOONLIGHT_REPORT_PATH))

            # 后续晨间修复策略使用一个独立的已推送兼容夹具，不把领域归档
            # 安全停止伪装成真实 push。
            morning = json.loads(json.dumps(blocked_archive))
            morning["current"] = "moonlight_review"
            morning["moonlight"].pop("hard_blocked", None)
            morning["moonlight"]["issues"] = [
                issue for issue in morning["moonlight"].get("issues", [])
                if issue.get("kind") != "blocker"
            ]
            morning["moonlight"]["pushed_head"] = mf.sh(
                "git rev-parse --verify HEAD")
            morning.pop("revision", None)
            morning.pop("updated_at", None)

            env_morning = json.loads(json.dumps(morning))
            env_morning["moonlight"]["issues"].append({
                "id": "ML-003", "kind": "environment", "step": "env_setup",
                "at": now, "head": mf.sh("git rev-parse --verify HEAD"),
                "reason": "旧版报告遗留的环境项",
            })
            mf.save_state(env_morning)
            mf.cmd_moonlight(flow, env_morning, types.SimpleNamespace(
                action="repair", ack=None, reason=None))
            env_repair = mf.load_state()
            check("旧版环境遗留不再把修复轮送回已删除的 setup",
                  env_repair.get("current") == "build"
                  and not (env_repair.get("moonlight") or {}).get("repair_after_environment"))

            # 这里是在同一个临时仓库中构造另一条晨间修复分支，不是拿生产中的
            # 旧快照覆盖新状态；去掉 CAS 字段，明确表达“测试夹具重新装载”。
            morning_fixture = json.loads(json.dumps(morning))
            morning_fixture.pop("revision", None)
            morning_fixture.pop("updated_at", None)
            mf.save_state(morning_fixture)
            mf.cmd_moonlight(flow, morning_fixture, types.SimpleNamespace(
                action="repair", ack=None, reason=None))
            repairing = mf.load_state()
            check("月光宝盒按报告从工作流编译入口开启修复轮",
                  repairing.get("current") == "build"
                  and (repairing.get("moonlight") or {}).get("cycle") == 2
                  and "agent_tasks" not in repairing and "quality" not in repairing)
            mf._moonlight_resolve_kind(repairing, "compile")
            mf._moonlight_resolve_kind(repairing, "codecheck")
            mf._moonlight_resolve_kind(repairing, "ut")
            repairing["current"] = "moonlight_review"
            mf.save_state(repairing)
            mf.cmd_moonlight(flow, repairing, types.SimpleNamespace(
                action="finalize", ack=None, reason=None))
            finalized = mf.load_state()
            check("评审意见处理晨间修复完成后进入领域归档",
                  finalized.get("current") == "domain_archive"
                  and not mf._moonlight(finalized))

            # full/tweak/hotfix 同样不能在夜间越过需要用户确认的领域归档。
            full_state = {
                "current": "build", "config": {"单号": "REQMOON2", "CHANGE_NAME": "moon"},
                "choices": {"workflow": "full"}, "history": [], "started": now,
                "moonlight": {"enabled": True, "activated_at": now, "cycle": 1, "issues": []},
            }
            mf.save_state(full_state)
            mf.advance(flow, full_state, "build", flow["steps"]["build"], "done")
            full_archive = mf.load_state()
            check("完整开发月光轮停在领域归档",
                  full_archive.get("current") == "domain_archive")
            full_morning = json.loads(json.dumps(full_archive))
            full_morning["current"] = "moonlight_review"
            full_morning["moonlight"]["pushed_head"] = mf.sh(
                "git rev-parse --verify HEAD")
            full_morning.pop("revision", None)
            full_morning.pop("updated_at", None)
            mf.save_state(full_morning)
            mf.cmd_moonlight(flow, full_morning, types.SimpleNamespace(
                action="finalize", ack=None, reason=None))
            full_finalized = mf.load_state()
            check("完整开发晨间finalize恢复领域归档",
                  full_finalized.get("current") == "domain_archive"
                  and not mf._moonlight(full_finalized))
    finally:
        os.chdir(old_cwd)

    # 5. 占位符白名单
    KNOWN = {"单号", "CHANGE_NAME", "工号", "基线分支", "分支名", "单号类型", "STORY入库", "需求文档"}
    ph = set()
    for s in steps.values():
        for e in s.get("evidence", []):
            for p in e.get("any", []) + e.get("paths", []) + ([e["file"]] if "file" in e else []):
                ph |= set(re.findall(r"\{([^}]+)\}", p))
    check("证据占位符均为已知配置键", ph <= KNOWN, str(ph - KNOWN))
    lifecycle_types = {
        "agent_ran", "agent_or_no_source", "review_agent_or_no_code"}
    lifecycle_requirements = [
        (step, "CODECHECK" if e.get("type") == "review_codecheck"
         else str(e.get("agent", "")).upper())
        for step in steps.values() for e in step.get("evidence", [])
        if e.get("type") in lifecycle_types
        or e.get("type") == "review_codecheck"
    ]
    all_lifecycle_steps_covered = all(
        kind in mf._step_agent_kinds(step) and kind in mf.RISK_AGENT_LABELS
        for step, kind in lifecycle_requirements)
    check(
        "所有流程 Agent 生命周期证据都能识别统一风险放行",
        all_lifecycle_steps_covered,
    )

# push/done 的工作区范围必须与提交前 Gate 同源：初始化后出现不等于本单产物。
with _TmpDir() as td:
    old_cwd = os.getcwd()
    try:
        repo = os.path.join(td, "repo")
        remote = os.path.join(td, "remote.git")
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
        os.chdir(repo)
        subprocess.run(["git", "init", "-q"], check=True)
        subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], check=True)
        subprocess.run(["git", "config", "user.name", "MAE Flow Test"], check=True)
        open("README.md", "w", encoding="utf-8").write("fixture\n")
        subprocess.run(["git", "add", "README.md"], check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], check=True)
        subprocess.run(["git", "branch", "-M", "main"], check=True)
        subprocess.run(["git", "remote", "add", "origin", remote], check=True)
        subprocess.run(["git", "push", "-qu", "origin", "main"], check=True)
        state = {
            "current": "push",
            "config": {"基线分支": "main", "CHANGE_NAME": "demo"},
            "choices": {},
            "initial_dirty": [], "initial_dirty_fingerprints": {},
        }
        json.dump({"paths": {}}, open(mf.AGENT_WRITES_PATH, "w", encoding="utf-8"))

        os.makedirs(".codeAgent")
        open(".codeAgent/session.json", "w", encoding="utf-8").write("{}\n")
        unowned_ok, unowned_why = mf.ev_pushed({}, state)
        check("DONE 不把流程中出现的未证明 .codeAgent 目录强制纳入提交",
              unowned_ok, unowned_why)

        os.makedirs("src")
        open("src/changed.cpp", "w", encoding="utf-8").write("int changed = 1;\n")
        json.dump(
            {"paths": {"SRC/CHANGED.CPP": {
                "at": "2026-07-27 00:00:00", "tool": "file-write"}}},
            open(mf.AGENT_WRITES_PATH, "w", encoding="utf-8"))
        original_identity = mf._repo_path_identity
        try:
            mf._repo_path_identity = lambda path, case_insensitive=None: (
                original_identity(path, case_insensitive=True))
            written_ok, written_why = mf.ev_pushed({}, state)
        finally:
            mf._repo_path_identity = original_identity
        check("DONE 不因 Agent 写入记录中的路径大小写强迫提交本地文件",
              written_ok and os.path.isfile("src/changed.cpp"), written_why)

        os.remove("src/changed.cpp")
        os.makedirs("openspec/changes/demo")
        open("openspec/changes/demo/change.md", "w", encoding="utf-8").write("# change\n")
        explicit_ok, explicit_why = mf.ev_pushed({}, state)
        check("DONE 不因本地过程文件缺少提交来源而否决真实推送事实",
              explicit_ok and os.path.isfile("openspec/changes/demo/change.md"),
              explicit_why)
    finally:
        os.chdir(old_cwd)

with _TmpDir() as td:
    old_cwd = os.getcwd()
    try:
        os.chdir(td)
        open(".gitignore", "w", encoding="utf-8").write(
            "# .mae-flow.json* 将由工具维护\n"
            "# .mae-flow-work/ 是过程目录\n")
        original_ignore = open(".gitignore", "rb").read()
        mf.sh("git init -q")
        mf._gitignore()
        ignore_rules = {
            line.strip() for line in open(
                mf.sh("git rev-parse --git-path info/exclude"), encoding="utf-8").read().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        check("注释中的状态路径不会冒充有效 Git 忽略规则",
              ".mae-flow.json*" in ignore_rules
              and ".mae-flow-work/" in ignore_rules
              # 内置规格引擎的本地脚手架不该出现在用户 git status 里
              and "openspec/config.yaml" in ignore_rules
              and open(".gitignore", "rb").read() == original_ignore
              # comet 状态机已换轨:不再往用户仓写 .gitattributes
              and not os.path.exists(".gitattributes"))
    finally:
        os.chdir(old_cwd)

# 6. Agent 契约由独立核心测试覆盖；这里只保留发布物完整性检查。
dp = open(os.path.join(ROOT, "hooks", "dispatch.py"), encoding="utf-8").read()
hook_events_adapter = open(
    os.path.join(
        ROOT, "scripts", "mae_flow_core", "adapters", "hook_events.py"),
    encoding="utf-8",
).read()
hook_active_adapter = open(
    os.path.join(
        ROOT, "scripts", "mae_flow_core", "adapters",
        "hook_active_events.py"),
    encoding="utf-8",
).read()
for f in sorted(os.listdir(os.path.join(ROOT, "agents"))):
    if f.endswith(".md"):
        name = f[:-3]
        txt = open(os.path.join(ROOT, "agents", f), encoding="utf-8").read()
        check(f"{name} 契约不要求返回令牌或指纹",
              "_RESULT:" not in txt and "TASK_CARD_SHA256" not in txt)

check("Hook 入口只装配已抽离的 Agent 契约运行时",
      "HookRuntimeAdapter" in dp and "def _codecheck_contract" not in dp)
check("dispatch 在直接模式完整停止旧流程接管",
      "direct mode: bypass" in hook_events_adapter
      and "不要运行 current/done" in hook_events_adapter)

# 插件全局安装不得接管未 init 的普通项目；Windows 控制台代码页也不得污染 Hook 的 UTF-8 JSON。
with _TmpDir() as td:
    subprocess.run(["git", "init", "-q", td], check=True)
    payload = json.dumps({
        "cwd": td,
        "tool_name": "Edit",
        "tool_input": {"file_path": os.path.join(td, "src", "普通代码.cpp")},
    }, ensure_ascii=False) + "\n"
    inactive = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "pretooluse"],
        cwd=td, input=payload, text=True, capture_output=True, timeout=10)
    check("仅安装插件、未 init 时所有工具门禁完整旁路", inactive.returncode == 0)

    with open(os.path.join(td, ".mae-flow.json.exited"), "w", encoding="utf-8") as f:
        json.dump({
            "status": "exited", "snapshot": ".mae-flow-work/exited/fixture",
            "direct_messages": [],
        }, f, ensure_ascii=False)
    direct_answer_payload = json.dumps({
        "cwd": td,
        "tool_name": "AskUserQuestion",
        "tool_response": {
            "answers": {"是否恢复": "确认重新启用mae-flow"},
        },
    }, ensure_ascii=False) + "\n"
    direct_answer = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "posttooluse"],
        cwd=td, input=direct_answer_payload.encode("utf-8"),
        capture_output=True, timeout=10)
    direct_record = json.load(open(
        os.path.join(td, ".mae-flow.json.exited"), encoding="utf-8"))
    direct_rows = direct_record.get("direct_messages", [])
    check("Direct 模式旁路门禁但仍捕获恢复按钮的真实答案",
          direct_answer.returncode == 0 and len(direct_rows) == 1
          and direct_rows[0].get("id")
          and "确认重新启用mae-flow" in direct_rows[0].get("text", ""))

    os.remove(os.path.join(td, ".mae-flow.json.exited"))
    review_sha = "a" * 64
    review_id = "review-test-001"
    state = {"current": "config_confirm", "config": {}, "choices": {},
             "history": [], "started": time.strftime("%Y-%m-%d %H:%M:%S"),
             "config_review": {
                 "step": "config_confirm", "id": review_id,
                 "sha256": review_sha,
                 "config": {"单号": "REQ1"},
             }}
    with open(os.path.join(td, ".mae-flow.json"), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    user_payload = json.dumps({
        "cwd": td, "prompt": "我确认中文需求：支持基站名称查询"
    }, ensure_ascii=False) + "\n"
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "cp936"
    captured = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
        cwd=td, input=user_payload.encode("utf-8"), capture_output=True, timeout=10, env=env)
    messages = json.load(open(os.path.join(td, ".mae-flow.json.usermsg"), encoding="utf-8"))
    check("Windows 非 UTF-8 控制台下 Hook 仍按原始 UTF-8 捕获中文",
          captured.returncode == 0
          and messages[-1]["text"] == "我确认中文需求：支持基站名称查询"
          and messages[-1].get("input_encoding") == "utf-8-sig"
          and "config_review_sha256" not in messages[-1]
          and "config_review_id" not in messages[-1])
    answer_payload = json.dumps({
        "cwd": td,
        "tool_name": "AskUserQuestion",
        "tool_response": {
            "questions": [{"header": "最终确认"}],
            "answers": {"最终确认": mf.CONFIG_CONFIRM_ACK},
        },
    }, ensure_ascii=False) + "\n"
    answer_capture = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "posttooluse"],
        cwd=td, input=answer_payload.encode("utf-8"), capture_output=True,
        timeout=10, env=env)
    messages = json.load(open(os.path.join(td, ".mae-flow.json.usermsg"), encoding="utf-8"))
    check("AskUserQuestion 保留多回答结构但不绑定配置指纹",
          answer_capture.returncode == 0
          and "config_review_sha256" not in messages[-1]
          and "config_review_id" not in messages[-1]
          and mf.CONFIG_CONFIRM_ACK in messages[-1].get("text", ""))

with _TmpDir() as td:
    subprocess.run(["git", "init", "-q", td], check=True)
    action_dir = os.path.join(td, ".mae-flow-work", "standalone", "test-action")
    os.makedirs(action_dir)
    action_path = os.path.join(td, ".mae-flow-work", "standalone-action.json")
    json.dump({"id": "test-action", "kind": "ut", "status": "active",
               "expires_epoch": time.time() + 3600, "work_dir": action_dir,
               "config": {}, "agent_tasks": {}, "tokens": {}},
              open(action_path, "w", encoding="utf-8"))
    ordinary_payload = json.dumps({
        "cwd": td, "tool_name": "Edit",
        "tool_input": {"file_path": os.path.join(td, "src", "ordinary.cpp")},
    }) + "\n"
    internal_payload = json.dumps({
        "cwd": td, "tool_name": "Edit",
        "tool_input": {"file_path": os.path.join(action_dir, "ut-task.md")},
    }) + "\n"
    ordinary = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "pretooluse"],
        cwd=td, input=ordinary_payload, text=True, capture_output=True, timeout=10)
    internal = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "pretooluse"],
        cwd=td, input=internal_payload, text=True, capture_output=True, timeout=10)
    check("独立任务只保护任务卡而不拦普通源码编辑",
          ordinary.returncode == 0 and internal.returncode == 2)
    # 完整流程退出记录会长期保留；独立任务提示必须覆盖旧的普通开发提示。
    json.dump({"snapshot": "old-flow"},
              open(os.path.join(td, ".mae-flow.json.exited"), "w", encoding="utf-8"))
    prompt_payload = json.dumps({"cwd": td, "prompt": "继续补单元测试"},
                                ensure_ascii=False) + "\n"
    injected = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
        cwd=td, input=prompt_payload, text=True, capture_output=True, timeout=10)
    check("退出完整流程后独立任务状态仍优先注入",
          injected.returncode == 0
          and "当前有独立 UT 任务 test-action" in injected.stdout
          and "不要运行 current/done" not in injected.stdout)

with _TmpDir() as td:
    # 父目录的旧状态不能越过最近 .git 边界接管一个独立子仓。
    with open(os.path.join(td, ".mae-flow.json"), "w", encoding="utf-8") as f:
        json.dump({"current": "verify_ut", "config": {}, "choices": {},
                   "history": [], "started": "2026-07-23 20:00:00"}, f)
    nested = os.path.join(td, "independent-repo")
    subprocess.run(["git", "init", "-q", nested], check=True)
    child = os.path.join(nested, "src", "module")
    os.makedirs(child)
    root, has_state = mf.find_project_root(child)
    payload = json.dumps({
        "cwd": child,
        "tool_name": "Edit",
        "tool_input": {"file_path": os.path.join(child, "ordinary.cpp")},
    }) + "\n"
    isolated = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "pretooluse"],
        cwd=child, input=payload, text=True, capture_output=True, timeout=10)
    check("父目录陈旧状态不会越过独立仓边界误接管",
          root == nested and not has_state and isolated.returncode == 0)

with _TmpDir() as td:
    subprocess.run(["git", "init", "-q", td], check=True)
    subprocess.run(["git", "config", "user.email", "mae-flow@test.invalid"], cwd=td, check=True)
    subprocess.run(["git", "config", "user.name", "MAE Flow Test"], cwd=td, check=True)
    open(os.path.join(td, "biz.cpp"), "w", encoding="utf-8").write("int value = 1;\n")
    subprocess.run(["git", "add", "biz.cpp"], cwd=td, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=td, check=True)
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(os.path.join(td, ".mae-flow.json"), "w", encoding="utf-8") as f:
        json.dump({"current": "config_confirm", "config": {}, "choices": {},
                   "history": [], "started": now}, f, ensure_ascii=False)
    exit_payload = json.dumps({"cwd": td, "prompt": "/mae-flow exit"},
                              ensure_ascii=False) + "\n"
    exited = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
        cwd=td, input=exit_payload, text=True, capture_output=True, timeout=15)
    exit_record = json.load(open(os.path.join(td, ".mae-flow.json.exited"), encoding="utf-8"))
    check("明确 /mae-flow exit 由用户事件直接退出且不依赖 ack 账本",
          exited.returncode == 0
          and not os.path.exists(os.path.join(td, ".mae-flow.json"))
          and exit_record.get("authorization") == "userprompt-hook")

with _TmpDir() as td:
    subprocess.run(["git", "init", "-q", td], check=True)
    open(os.path.join(td, ".mae-flow.json"), "w", encoding="utf-8").write('{"current":')
    exit_payload = json.dumps({"cwd": td, "prompt": "/mae-flow exit"},
                              ensure_ascii=False) + "\n"
    escaped = subprocess.run(
        [sys.executable, os.path.join(ROOT, "hooks", "dispatch.py"), "userprompt"],
        cwd=td, input=exit_payload, text=True, capture_output=True, timeout=15)
    corrupt_record = json.load(open(os.path.join(td, ".mae-flow.json.exited"), encoding="utf-8"))
    saved_bad = os.path.join(td, corrupt_record["snapshot"], ".mae-flow.json")
    check("状态 JSON 损坏时用户仍可一键逃生且坏现场被保留",
          escaped.returncode == 0
          and corrupt_record.get("authorization") == "userprompt-hook-corrupt-state"
          and os.path.isfile(saved_bad))

# 6.1 Comet 阶段门禁只增加一个幂等标记检查；从子目录调用也能找到项目根退出标记。
with _TmpDir() as td:
    guard = os.path.join(td, ".cac", "skills", "comet", "scripts", "comet-hook-guard.sh")
    os.makedirs(os.path.dirname(guard), exist_ok=True)
    # bash 脚本必须钉 LF:Windows 文本模式会把 \n 写成 \r\n,#!/bin/bash\r 直接崩
    open(guard, "w", encoding="utf-8", newline="\n").write(
        "#!/bin/bash\nset -euo pipefail\necho blocked >&2\nexit 2\n")
    found1, patched1, errors1 = ensure_direct_mode_compat(td)
    found2, patched2, errors2 = ensure_direct_mode_compat(td)
    os.makedirs(os.path.join(td, "src", "nested"))
    open(os.path.join(td, ".mae-flow.json.exited"), "w", encoding="utf-8").write("{}\n")
    # 用产品同款 Git Bash 发现(CI 实锤:裸 "bash" 在 Windows 撞 System32 的
    # WSL 桩,打 wsl --install 提示退非零,测试自身的宿主假设被戳穿)
    from mae_flow_core.capabilities import _bash as _find_bash
    try:
        bash_exe = _find_bash()
    except Exception:
        bash_exe = "bash"
    direct = subprocess.run([bash_exe, guard], cwd=os.path.join(td, "src", "nested"),
                            capture_output=True, text=True)
    os.remove(os.path.join(td, ".mae-flow.json.exited"))
    managed = subprocess.run([bash_exe, guard], cwd=td, capture_output=True, text=True)
    guard_text = open(guard, encoding="utf-8").read()
    check("Comet Hook 退出兼容幂等且可从子目录识别",
          len(found1) == 1 and len(patched1) == 1 and not errors1
          and len(found2) == 1 and not patched2 and not errors2
          and guard_text.count(COMET_COMPAT_BEGIN) == 1
          and direct.returncode == 0 and managed.returncode == 2,
          "found1=%s patched1=%s errors1=%s found2=%s patched2=%s errors2=%s "
          "begin=%d direct=%s(%r/%r) managed=%s(%r)" % (
              len(found1), len(patched1), errors1, len(found2), patched2,
              errors2, guard_text.count(COMET_COMPAT_BEGIN),
              direct.returncode, direct.stdout[-200:], direct.stderr[-200:],
              managed.returncode, managed.stderr[-200:]))

mf_src = ""
for mf_path in (
        os.path.join(ROOT, "scripts", "mae_flow_core", "cli_runtime.py"),
        *sorted(glob.glob(os.path.join(
            ROOT, "scripts", "mae_flow_core", "cli_commands", "*.py")))):
    with open(mf_path, encoding="utf-8") as stream:
        mf_src += stream.read()
quality_codecheck_src = open(
    os.path.join(
        ROOT, "scripts", "mae_flow_core", "application",
        "quality", "codecheck.py"),
    encoding="utf-8",
).read()
guard_bash_src = open(
    os.path.join(
        ROOT, "scripts", "mae_flow_core", "guard", "bash.py"),
    encoding="utf-8",
).read()
# 2026-08-25 编排瘦身:tests_only 边界、UT 源码回流、CodeCheck 步骤首检
# 均随编码段编排退役;standalone 独立任务的卡与收据由单元测试覆盖。
check("任务卡仅存于 standalone 独立任务",
      TASK_CARD_EXPECTED_STEPS.get("CODECHECK") == {"standalone_codecheck"}
      and TASK_CARD_EXPECTED_STEPS.get("UT") == {"standalone_ut"}
      and "COMPILE" not in TASK_CARD_EXPECTED_STEPS)
check("Bash 任意解释器不能直碰流程状态文件",
      "禁止经 Bash " in guard_bash_src
      and "直接访问；查看请执行" in guard_bash_src
      and "status/doctor/moonlight report 命令" in guard_bash_src)
check("带短横线的一次性退出凭据也在状态黑名单内",
      r"(?:\.[\w-]+)*" in mf_src and "EXIT_INTENT_PATH" in mf_src)
check("STORY 不入库会在推送前检查提交树",
      '"git", "ls-tree", "-r", "--name-only", "HEAD"' in mf_src)
check("STORY 不入库由 done 自动移入过程区",
      'if sid == "story"' in mf_src and 'os.path.join(".mae-flow-work", "story")' in mf_src)

# 6.45 v3/v4 换轨防回退：第二状态机(comet)与外部 Node 规格引擎不得从任何缝隙复活。
# v3 把阶段与产物指针收归 .mae-flow.json 的 spec 段(证据类型 spec_field)，
# v4 把规格引擎换成纯 Python specengine。这两条检查守的就是"不许悄悄退回去"。
flow_src = open(os.path.join(ROOT, "flow", "flow.json"), encoding="utf-8").read()
comet_command_hits = ["flow/flow.json"] if "capability comet-" in flow_src else []
for step_doc in sorted(glob.glob(os.path.join(ROOT, "flow", "steps", "*.md"))):
    with open(step_doc, encoding="utf-8") as stream:
        if "capability comet-" in stream.read():
            comet_command_hits.append(
                os.path.relpath(step_doc, ROOT).replace(os.sep, "/"))
check("流程图与步骤指令不再调用 comet 子命令", not comet_command_hits,
      str(comet_command_hits))
check("流程证据全部换轨到 spec_field(不留 yaml_field 兼容别名)",
      "yaml_field" not in flow_src)

# run_openspec/run_comet/configure_comet_build 的允许调用面：
#   - scripts/mae_flow_core/capabilities.py：外部引擎适配层本身(定义与内部转调)
#   - scripts/mae-flow.py 的 cmd_capability：`capability ...` 透传逃生口
# 其余任何位置出现即"流程又开始直接驱动外部引擎"，属于回退。
# 用 AST 找真实调用点：子串匹配会被注释、文档字符串里的字面量误报。
ENGINE_CALL_NAMES = {"run_openspec", "run_comet", "configure_comet_build"}


def _engine_call_sites(path):
    with open(path, encoding="utf-8") as stream:
        tree = ast.parse(stream.read(), filename=path)
    hits = []

    def called_name(node):
        if isinstance(node.func, ast.Name):
            return node.func.id
        if isinstance(node.func, ast.Attribute):
            return node.func.attr
        return ""

    def walk(node, enclosing):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(child, child.name)
                continue
            if isinstance(child, ast.Call) and called_name(child) in ENGINE_CALL_NAMES:
                hits.append("%s(%s)" % (child.lineno, enclosing or "<module>"))
            walk(child, enclosing)

    walk(tree, "")
    return hits


engine_hits = {}
for source in sorted(glob.glob(
        os.path.join(ROOT, "scripts", "**", "*.py"), recursive=True)):
    rel = os.path.relpath(source, ROOT).replace(os.sep, "/")
    if rel in (
            "scripts/selftest.py",
            "scripts/mae_flow_core/capabilities.py",
            "scripts/mae_flow_core/capability_runtime.py"):
        continue  # 本文件是检查逻辑自身；capability runtime 是外部引擎适配层
    found = _engine_call_sites(source)
    if found:
        engine_hits[rel] = found
flow_engine_calls = [
    "%s:%s" % (rel, hit)
    for rel, found in sorted(engine_hits.items()) for hit in found
    if not (
        rel == "scripts/mae_flow_core/cli_commands/init_capability.py"
        and hit.endswith("(cmd_capability)")
    )]
check("流程代码不再直接驱动外部规格引擎(OpenSpec/Comet)",
      not flow_engine_calls, str(flow_engine_calls))
capability_calls = engine_hits.get(
    "scripts/mae_flow_core/cli_commands/init_capability.py", [])
check("外部引擎透传只保留在 capability 子命令里且不再扩张",
      len(capability_calls) <= 3
      and all(hit.endswith("(cmd_capability)") for hit in capability_calls),
      str(capability_calls))

# 6.6 PostToolUse matcher 必须覆盖令牌/校验所需工具(漏了 = ASKUSER/UTRUN 令牌静默失效)
if hooks:
    m = ""
    for h in (hooks.get("hooks", {}).get("PostToolUse", []) or []):
        m = h.get("matcher", "") or m
    for need in ("AskUserQuestion", "Bash", "Write", "Task", "Agent"):
        check(f"PostToolUse matcher 含 {need}", need in m)
    pre = " ".join(
        h.get("matcher", "") or ""
        for h in (hooks.get("hooks", {}).get("PreToolUse", []) or []))
    check("月光宝盒可在工具层禁止 AskUserQuestion",
          "AskUserQuestion" in pre
          and "月光宝盒处于无人值守模式" in hook_active_adapter)
    stop_hooks = hooks.get("hooks", {}).get("Stop", []) or []
    check("月光宝盒注册主Agent安全停点Stop Hook",
          bool(stop_hooks)
          and "def stop" in hook_active_adapter
          and "moonlight blocked" in hook_active_adapter)

# 7. 关键文件
for f in ("skills/mae-flow/SKILL.md", "skills/mae-flow/assets/STORY-TEMPLATE.md",
          "skills/mae-flow/assets/CHAIN-TEMPLATE.md",
          "skills/mae-flow/assets/GRILL-PREP-TEMPLATE.md",
          "skills/mae-flow/assets/REVIEW-TEMPLATE.md",
          "scripts/comet_compat.py", "scripts/mae_flow_core/capabilities.py",
          "scripts/mae_flow_core/codecheck_log.py",
          "scripts/mae_flow_core/lightcheck.py",
          "scripts/mae_flow_core/specengine.py",
          "scripts/tests/test_capabilities.py",
          "scripts/tests/test_specengine.py",
          "scripts/tests/test_commit_ownership.py",
          "scripts/tests/test_codecheck_logging.py",
          "scripts/tests/test_lightcheck.py",
          "runtime/vendor/manifest.json", "runtime/vendor/openspec/LICENSE",
          "runtime/vendor/comet/LICENSE", "runtime/vendor/superpowers/LICENSE",
          "runtime/vendor/ponytail/LICENSE", "runtime/vendor/lizard/LICENSE.txt",
          "runtime/vendor/lizard/LICENSE-APACHE-2.0.txt",
          "flow/steps/moonlight_review.md", "commands/mae-flow.md", "README.md",
          "MAINTAINERS.md", "CHANGELOG.md", ".gitattributes"):
    check(f"存在 {f}", os.path.exists(os.path.join(ROOT, f)))

print(f"\n{'全部通过 ✅' if not fails else f'失败 {len(fails)} 项 ❌'}")
sys.exit(1 if fails else 0)
