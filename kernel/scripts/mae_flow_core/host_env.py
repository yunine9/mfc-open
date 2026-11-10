"""宿主形态:用户和内核在不在同一台机器上。

内核的提示词长期默认"用户就坐在这台机器前"——于是会让用户去 IDE 里检视
代码、把现场面板的绝对路径念给用户听、让他用浏览器打开一个本地文件。这在
终端场景下都对。

接进云端控制台以后它们全错了:用户在浏览器里看的是另一台机器,那个路径他
打不开,IDE 也不存在,材料本来就已经摆在页面上。更糟的是这些话会被模型
**原样转述**给用户(内核为此还专门加了转述义务),于是用户看到一串做不到
的指令,只会以为流程坏了。

`MAE_FLOW_HOST=cloud` 表示用户在远端界面上;其余取值(含不设置)一律按
"用户就在这台机器上"处理——本地 CLI 的行为一字不变。
"""

import os

ENV = "MAE_FLOW_HOST"
CLOUD = "cloud"


def host_kind():
    return (os.environ.get(ENV) or "").strip().lower()


def user_on_this_machine():
    """用户能不能直接摸到这台机器上的文件、IDE 和浏览器。

    只有这一个判断:能摸到就照旧给路径、让他去 IDE 看;摸不到就闭嘴——
    宁可不说,也不能给一条他做不到的指令。
    """
    return host_kind() != CLOUD


def unattended_confirm_allowed(state):
    """归档/交付清单自动确认的许可:月光宝盒或云端宿主。

    云端没有"坐在终端前的用户",中途单问确认只会把任务挂起数小时;
    真正的人工裁决在工作台批注与 MR 检视(2026-08-25 编排瘦身)。"""
    if bool(((state or {}).get("moonlight") or {}).get("enabled")):
        return True
    return host_kind() == CLOUD


def worker_agent_ledger_gates():
    """Whether real worker lifecycle facts are enforced.

    Cloud's Pi adapter now records child start/return events.  The historical
    blanket bypass also released Story, Reviewer and UT-writing work and made
    the UT Skill decorative, so it is intentionally retired for every host.
    External COMPILE/UT-run/CodeCheck are handled as typed obligations instead
    of pretending a worker returned.
    """
    return True


def _runs_locally(state, capability):
    """Resolve persisted task truth when available, legacy host truth otherwise."""
    if state is None:
        return host_kind() != CLOUD
    # Local import keeps this low-level host module usable during early CLI
    # bootstrap while making an initialized task independent of later env drift.
    from mae_flow_core.workflow.execution_contract import contract_for_state
    return contract_for_state(state, host_kind())[capability] == "local"


def execution_contract(state=None):
    """Expose the effective task contract to host-aware quality consumers."""
    from mae_flow_core.workflow.execution_contract import contract_for_state
    return contract_for_state(state, host_kind())


def build_runs_locally(state=None):
    """本地编译还做不做。

    云端宿主没有构建链(内网巨型 Java 仓的 mcde/mvn 装在流水线那边,
    宿主机上没有,也不想为此供养一套镜像)。本地编译在云端只有两个
    结局:命令根本不存在,或者装了也和流水线环境不一致——前者让
    COMPILE 契约永远等不到执行证据(agent 报什么都被打回,死循环),
    后者给出的绿灯不代表流水线会绿,是假证据。

    用户拍板:云端不做本地编译。机器把关不是取消而是换执行者——
    交付点推分支、触发权威流水线、结果绑 SHA 裁决(见 mae-flow-cloud
    红线:交付事实来自远端真实状态,旧绿灯不背书新代码);红灯由
    专职修复会话跟进直到绿。本地 CLI 一字不变。

    注意这不等于"跳过验证":跳过的是**本地这一次执行**,验证反而更
    权威了——流水线跑的是团队公认的那套构建。契约据此不再要求本地
    执行证据,但删代码换通过之类的作弊守卫(净产出、诚实报告)照旧。

    2026-08-26 勘误:上面"宿主没有构建链"的前提已随统一构建镜像失效
    ——编码会话与推送前验证共用带完整工具链和按仓持久缓存的任务容器,
    Agent 可以也应该随手增量编译自检(实测曾因 SKILL.md 旧禁令整单
    零编译)。本函数的**结论不变**:自检只是 Agent 的自我反馈,COMPILE
    证据核销仍在推送前验证与绑 SHA 流水线,不收 Agent 自述的绿灯。
    """
    return _runs_locally(state, "compile")


def unit_tests_run_locally(state=None):
    """本地跑不跑 UT。

    与 build_runs_locally 同理:UT 运行依赖同一套构建链。云端仍然
    **生成**测试(那是本地做得了、也最值钱的部分),只是不在本地跑
    ——运行与统计交给流水线。

    于是云端 UT 步的结论语义变了:不是"我跑过了,全绿",而是"测试
    已生成,运行由流水线裁决"。契约据此不要求 EXECUTED_UT 与数字
    对账——**没跑就不许报数字**,报了才是谎。
    """
    return _runs_locally(state, "ut_run")


def pipeline_adjudicates(state=None):
    """流水线是不是这台机器之外的最终裁判。

    云端把编译/UT/CodeCheck 的执行都推迟给了流水线(上面三个开关),
    这个开关是那句承诺的"兑现侧":为真时,宿主会在流水线终态把平台
    事实喂给 `pipeline record`,内核绑 HEAD 裁决并落盘 quality.pipeline
    ——推迟从一句话变成有据可查的物证。本地形态恒假:本地的裁判是
    本地执行本身,没有第二个裁判。
    """
    if state is None:
        return host_kind() == CLOUD
    from mae_flow_core.workflow.execution_contract import uses_pipeline
    return uses_pipeline(state, host_kind())


def codecheck_runs_locally(state=None):
    """CodeCheck 本地扫描还做不做。

    CodeCheck 是内网 npm 工具(fullcheck,内部源安装)。云端宿主装不上,
    每次扫描都要空撞一次"尽力安装"(附带 30 分钟冷却),再落一个
    TOOL_ERROR 引人去走恢复通道——纯噪声(2026-08-15 云端 task-1 实锤)。
    用户拍板:云端 CodeCheck 交由流水线核对,本地不扫;lightcheck
    (内核自带轻检查,不依赖外部工具)不受影响照常跑。本地 CLI 一字不变。
    """
    return _runs_locally(state, "codecheck")


def git_push_runs_locally(state=None):
    """Whether the interactive Agent may receive transport credentials.

    Cloud owns Git transport and performs it only after the Agent session has
    been disposed, so personal tokens never enter the task's tool boundary.
    Local CLI keeps its historical direct push behavior.
    """
    if state is None:
        return host_kind() != CLOUD
    return execution_contract(state).get("git_push", "local") == "local"
