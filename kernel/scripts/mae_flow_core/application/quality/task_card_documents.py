"""Render full-flow and standalone quality task-card documents."""

from ... import host_env
from ...quality.task_cards import TaskCardDocument
from .task_cards import (
    append_execution_context,
    append_task_files,
)


def _warning_pairs(pairs):
    rendered = []
    for pair in pairs:
        rule, file_name = pair[0], pair[1]
        line = pair[2] if len(pair) > 2 else None
        fields = [rule, file_name]
        if line is not None:
            fields.append(str(line))
        rendered.append("|".join(fields))
    return "、".join(rendered)


def _append_sources(
        document, sources, kind,
        standalone=False, heading=True):
    if heading:
        document.append("需求/规格依据:")
    document.extend("- " + path for path in sources)
    if sources:
        return
    if standalone:
        document.append(
            "- 用户未提供独立文档；以任务说明和点名代码为依据，不得发明业务要求")
    elif kind == "UT":
        document.append(
            "- （未找到；UT agent 必须 FAIL，禁止对着实现猜测试）")
    else:
        document.append(
            "- （未找到；本任务不据此扩大代码范围）")


def _append_file_scope(document, groups):
    document.append(
        "任务相关文件（已排除 Markdown、规格历史、评审记录和其他过程文档）:")
    append_task_files(
        document, "被测/业务源码", groups.business)
    append_task_files(
        document, "测试文件", groups.tests)
    append_task_files(
        document, "构建/依赖文件", groups.build)


def _append_precommit(document):
    document.extend([
        "检视/提交策略: 当前是整体实现后的“先检视、后提交”流程。",
        "任务卡范围是当前未提交工作区（含 staged/unstaged/untracked）；"
        "允许为真实编译错误修复业务源码，但禁止 git commit、git push。",
        "编译成功后保留全部代码为未提交状态，由主流程冻结快照并让用户在 IDE 检视；"
        "用户确认后才会精确提交。",
    ])


def _append_lightcheck(document, result):
    if result is None:
        return
    document.extend([
        "Mae-Flow轻量编码预检: %s（%d 个本轮新触发建议；"
        "不替代正式 CodeCheck，不是编译门禁）" % (
            result.get("status", "UNKNOWN"),
            len(result.get("findings") or []),
        ),
        "轻量预检报告: "
        + (
            result.get("report_path")
            or "报告写入失败；已记录诊断，不阻断流程"
        ),
        "边界:compile-agent 不得为了轻量建议扩大职责；只处理真实编译错误。"
        "主会话在后续写码时按建议预防/修正。",
    ])


def _append_notes(document, notes):
    if not notes:
        return
    document.append(
        "本仓沉淀经验(按需参考;与本任务卡指令冲突时以任务卡为准):")
    document.extend(
        "- " + line.lstrip("- ")
        for line in notes
    )


def _scope_reason(scan, rule, file_name, line):
    return next((
        item.get("reason", "")
        for item in scan.get("scope_reasons") or []
        if (
            item.get("rule") == rule
            and item.get("file") == file_name
            and item.get("line") == line
        )
    ), "缺少可细分行号/归属信息，按 Harness 保守纳入")


def _append_full_codecheck(document, scan):
    excluded = scan.get("stock_excluded")
    document.extend([
        "Harness首检告警数: %s"
        % scan.get("count", "未执行"),
        "用户已确认不涉及本次修改的告警数: "
        + (
            str(excluded)
            if isinstance(excluded, int)
            else "无法区分（本轮按 raw 全量计入）"
        ),
        "Harness首检分批数: %d（复验保持相同文件分批，禁止漏批或只跑最后一批）"
        % max(1, len(scan.get("commands") or [])),
        "Harness首检文件（仅是 CLI 扫描输入，不代表整文件都可修）: "
        + "、".join(scan.get("files", [])),
        "Harness首检告警(规则|文件): "
        + _warning_pairs(scan.get("pairs", [])),
        "CodeCheck修复目标（硬边界，仅以下告警）:",
    ])
    for pair in scan.get("pairs", []):
        rule, file_name = pair[0], pair[1]
        line = pair[2] if len(pair) > 2 else None
        document.append("- %s | %s:%s | %s" % (
            rule,
            file_name,
            line if line is not None else "?",
            _scope_reason(
                scan, rule, file_name, line),
        ))
    document.append(
        "职责:只修上列精确告警；即使同一文件还有其他告警也不得顺手处理。"
        "主会话不得代修；修复后按任务卡编译方式验证并复验。")


def _append_full_ut(
        document, groups, targets, batches=(), phase="generate", state=None,
        artifact_contract=None):
    document.append("UT覆盖目标（硬边界，不等于整个文件）:")
    if groups.business:
        for business_file in groups.business:
            rows = targets.get(
                business_file.replace("\\", "/"), [])
            if not rows:
                document.append(
                    "- %s | 无新增行范围（删除/重命名场景）；"
                    "只验证本次移除或迁移行为，不给其他存量函数补测"
                    % business_file)
                continue
            for target in rows:
                if target.get("deletion_only"):
                    span = "删除位置"
                elif target["start"] == target["end"]:
                    span = "%d" % target["start"]
                else:
                    span = "%d-%d" % (
                        target["start"], target["end"])
                context = (
                    target.get("context")
                    or "Git 未识别函数名，按该行附近确认所属函数/行为"
                )
                suffix = (
                    "（纯删除 hunk；只验证本次移除或迁移行为）"
                    if target.get("deletion_only") else ""
                )
                document.append("- %s | 行 %s | %s%s" % (
                    business_file, span, context, suffix))
    else:
        document.append(
            "- 本轮无业务源码修改；只验证已变更测试/构建入口，"
            "禁止为任意存量业务函数新增覆盖")
    if phase == "final":
        document.append(
            "Harness 最终收口批：禁止再生成或修改测试；只运行配置的完整 UT 命令，"
            "确认全部批次累积结果一起通过。")
    elif batches:
        document.append("Harness 自适应批次（同一逻辑 UT 会话，批间禁止提交）:")
        for index, batch in enumerate(batches, 1):
            document.append("- 第%d批（%d个目标）: %s" % (
                index, len(batch), "；".join(batch)))
        document.append(
            "执行策略:小范围在当前实例一次完成；范围较大时每次只处理一个批次，"
            "上下文接近上限就自然语言收尾，由主会话为下一批启动新实例。"
            "各批共享未提交测试工作区，不 commit、不询问用户；最后必须有一个收口实例"
            "只运行配置的全量 UT 命令。")
    if not host_env.unit_tests_run_locally(state):
        # 云端形态:测试照常写——**AutoUT/java-autout 这类 skill 的价值是
        # "怎么写单测"的写法指南,云端一样照用**(宿主把仓里的 SKILL.md
        # 直接注进提示词给模型读);对不上的只是"调用 Skill 工具"这个通道
        # 和它文档里"编译通过"那类本地动作。见 host_env.unit_tests_run_locally。
        route = (
            "云端形态:**按本会话已带的 UT 写法指南(AutoUT/java-autout 等 "
            "skill,由宿主注入)写测试**——命名、分层、断言口径照旧生效,"
            "是本步的主要依据;"
            "但这台机器没有构建链,指南里「编译通过」「执行构建/运行测试」"
            "那类段落做不到,直接跳过,不要为此找工具或改写指南。"
            "审计复用或补齐后就交:运行与统计由交付后的权威流水线负责(结果绑 SHA),"
            "红灯有专职修复会话跟进。报告里如实写明本地未运行,"
            "**不要编造 TESTS_TOTAL/PASSED/FAILED 数字**——没跑就没有数字。")
    elif phase == "final":
        route = (
            "本任务是最终收口批，不再调用生成 Skill 或修改测试，只真实执行完整 UT。")
    else:
        route = (
            "必须调用任务卡指定的 Mae-Flow 自带 AutoUT/java-autout Skill"
            "（或明确配置的既有写法），并真实执行测试。写“随生成方式自带”时"
            "由对应 Skill 根据项目决定实际命令，并在 EXECUTED_UT 如实报告。")
    document.extend([
        "职责:先查找并读取任务范围内的既有测试，审计其断言是否已经覆盖下面目标；"
        "覆盖充分就原样复用，不为制造 diff 重写测试；只有真实缺口才新增或修改测试。"
        "**测试对象=本次修改的函数/行为"
        "(上面硬边界所在函数)+规格条目 EARS 条目,禁止为文件中未修改的"
        "存量函数补测**；" + route,
        "评审意见处理不修改规格，测试依据使用上面列出的既有需求/规格。",
    ])
    _append_ut_artifact_receipt(document, artifact_contract)


def _append_ut_artifact_receipt(document, artifact_contract):
    contract = artifact_contract or {}
    targets = "；".join(contract.get("coverage_targets") or ())
    document.extend([
        "UT 产物收据(由宿主依据工具与 Git 事实登记，不靠报告自述):",
        "- inspected_existing: 已实际读取并复用/审计的既有测试",
        "- added_test_paths / modified_test_paths: 本轮真实新增或修改的测试",
        "- test_digest: 上述测试内容指纹",
        "- coverage_targets: " + (targets or "本卡 UT 覆盖目标"),
        "若既有测试已完整覆盖，允许 added/modified 为空；但必须真实读取相关测试，"
        "让 inspected_existing 与 test_digest 可核对。",
    ])


def build_full_task_document(facts):
    """Build the complete full-flow task card from already-validated facts."""
    kind = facts["kind"]
    config = facts["config"]
    execution_state = (
        {"execution_contract": facts.get("execution_contract")}
        if facts.get("execution_contract") else None)
    header = [
        "# Mae-Flow %s TASK CARD" % kind,
        "本文件由 harness 生成。不得猜测、替换或省略其中配置；缺项按 agent 契约 FAIL/BLOCKED 收尾。",
        "项目根: " + facts["project_root"],
        "当前步骤: " + facts["sid"],
        "任务卡基点 HEAD: " + facts["head"],
        "单号: " + config.get("单号", ""),
        "单号类型: " + config.get("单号类型", ""),
        "需求基线分支: " + config.get("基线分支", ""),
        "本轮检查范围: " + facts["diff"],
        "本次子任务范围: "
        + (facts["scope"] or "任务卡文件清单全部"),
    ]
    if host_env.build_runs_locally(execution_state):
        header.append("编译方式: " + config.get("编译方式", ""))
    else:
        header.append("编译执行: 权威流水线（本机不运行）")
    header.append("UT 编写方式: " + config.get("UT生成方式", ""))
    if host_env.unit_tests_run_locally(execution_state):
        header.append("UT 运行命令: " + config.get("UT运行命令", ""))
    else:
        header.append("UT 运行: 权威流水线（本机只编写/审计测试）")
    header.append("需求/规格依据:")
    document = TaskCardDocument(header)
    if facts["precommit_review"]:
        _append_precommit(document)
    inherited = facts["inherited_dirty"]
    if inherited:
        document.append(
            "流程启动前已脏但指纹未变(不属于本任务,保持可见): "
            + "、".join(inherited))
    _append_sources(
        document, facts["sources"], kind,
        heading=False)
    _append_file_scope(document, facts["groups"])
    document.append(
        "未传给子 Agent 的非任务变更: %d 项"
        % max(
            0,
            facts["change_count"]
            - facts["task_file_count"],
        ))
    plan = facts["execution_plan"]
    append_execution_context(
        document, kind, plan.roots, plan.unresolved)
    if kind == "COMPILE":
        document.append(
            "提交边界:compile-agent 禁止执行 git commit、git push；"
            "直接修复必须保留为未提交工作区改动，合法收尾后由主流程提交。")
        _append_lightcheck(
            document, facts["lightcheck"])
    _append_notes(document, facts["notes"])
    if kind == "CODECHECK":
        _append_full_codecheck(
            document, facts["scan"])
    elif kind == "UT":
        _append_full_ut(
            document, facts["groups"], facts["ut_targets"],
            facts.get("ut_batches", ()), facts.get("ut_phase", "generate"),
            execution_state, facts.get("ut_artifact_contract"))
    elif not host_env.build_runs_locally(execution_state):
        # 云端形态:这台机器上没有构建链,教它去跑 mcde/mvn 只会撞墙,
        # 然后在契约上空转(见 host_env.build_runs_locally)。
        document.append(
            "职责(云端形态):本机没有构建链，不要执行任何编译命令，也不要"
            "调用 build-fix/autout 之类的构建 Skill——它们在这台机器上不存在。"
            "按任务卡把代码改对，编译是否通过由交付后的权威流水线裁决"
            "(结果绑 SHA)；红灯会有专职修复会话跟进。"
            "报告里如实写明本地未编译，不要编造 BUILD_ERRORS 数字。")
    else:
        document.append(
            "职责:严格按任务卡的编译方式执行；配置为 build-fix 时必须调用 Mae-Flow"
            " 插件自带的 build-fix Skill，禁止自己猜命令。")
    return document


def _append_standalone_ut(document, groups, targets):
    document.append("UT覆盖目标（硬边界，不等于整个文件）:")
    for business_file in groups.business:
        rows = targets.get(
            business_file.replace("\\", "/"), [])
        if not rows:
            document.append(
                "- %s | 当前工作区无可定位 diff；只覆盖任务说明点名的函数/行为，"
                "若任务说明也未点明则 NEEDS_INPUT，禁止给整个文件补存量覆盖"
                % business_file)
        for target in rows:
            span = (
                "%d" % target["start"]
                if target["start"] == target["end"]
                else "%d-%d" % (
                    target["start"], target["end"])
            )
            context = (
                target.get("context")
                or "按该行附近确认所属函数/行为"
            )
            document.append("- %s | 行 %s | %s" % (
                business_file, span, context))
    document.extend([
        "职责:仅新增/修改测试代码；按配置调用 UT 生成能力并真实运行测试；"
        "覆盖对象仅限上面的函数/行为与任务说明，禁止扩成整个文件；"
        "疑似源码问题完成自查后上报，禁止自行改被测源码。",
        "独立任务默认不 commit；PASS 不以 commit 为条件，但测试必须真实全绿。",
    ])


def build_standalone_task_document(facts):
    """Build a standalone card without weakening its no-commit boundary."""
    label = facts["label"]
    config = facts["config"]
    files = facts["files"]
    document = TaskCardDocument([
        "# Mae-Flow Standalone %s TASK CARD" % label,
        "本文件由 harness 生成。运行模式是独立任务：不启动完整交付流程，不得自行扩大范围。",
        "独立任务ID: " + facts["action_id"],
        "运行模式: standalone",
        "当前步骤: standalone_" + facts["kind"],
        "项目根: " + facts["project_root"],
        "任务卡基点 HEAD: " + facts["head"],
        "提交策略: 禁止提交（保留工作区改动给用户检查）",
        "任务说明: "
        + (
            facts["request"]
            or "按任务卡文件范围完成本项工作"
        ),
        "本次子任务范围: "
        + (
            "、".join(files)
            if files
            else facts["request"] or "用户描述范围"
        ),
        "编译方式: " + config.get("编译方式", ""),
        "UT生成方式: " + config.get("UT生成方式", ""),
        "UT运行命令: " + config.get("UT运行命令", ""),
    ])
    if facts["stage"]:
        document.append(
            "质询检查阶段: " + facts["stage"])
    _append_sources(
        document, facts["sources"], label,
        standalone=True,
    )
    document.append(
        "任务相关文件（独立任务只允许使用以下冻结范围）:")
    groups = facts["groups"]
    append_task_files(
        document, "被测/业务源码", groups.business)
    append_task_files(
        document, "测试文件", groups.tests)
    append_task_files(
        document, "构建/依赖文件", groups.build)
    if label in ("UT", "CODECHECK"):
        plan = facts["execution_plan"]
        append_execution_context(
            document, label, plan.roots, plan.unresolved)
    scan = facts["scan"]
    if label == "CODECHECK":
        document.extend([
            "Harness首检告警数: %s"
            % scan.get("count", "未执行"),
            "Harness首检文件: "
            + "、".join(scan.get("files", [])),
            "Harness首检告警(规则|文件): "
            + _warning_pairs(scan.get("pairs", [])),
            "职责:仅处理首检范围内业务代码告警；修复后按配置编译并重新 fullcheck；禁止自动豁免。",
        ])
    elif label == "UT":
        _append_standalone_ut(
            document, groups, facts["ut_targets"])
    elif label == "GRILL":
        document.append(
            "职责:只读审查需求材料、代码勘察笔记和当前澄清文档，寻找遗漏的需求决策分支；"
            "禁止替用户拍板、禁止修改任何文件。")
    return document
