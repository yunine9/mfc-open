# Mae-Flow 维护者手册

读者：维护、扩展、排障本插件的人。使用者请看 [README.md](README.md)。
重构后的模块边界、依赖方向和扩展步骤见
[docs/refactor-architecture.md](docs/refactor-architecture.md)。

## 2026-09-13 文档形式检查退役

文件存在、占位词和章节结构不再由 `done` 或写入 Hook 自动检查，也不作为执行方案的机器证据要求。
Agent 按现有模板核对实质内容；`local-spec validate` 等显式诊断仍可按需使用，不再要求每次推进前运行。
旧任务的同类形式提示不再重放；真实执行诊断、用户决定、工作区权限、推送和流水线核验保持原有语义。

## 2026-08-25 编排瘦身勘误（读本手册前必读）

编码段的逐步编排已整体退役：四条工作流的编码段收敛为一个宽 `build` 步（自由改源码/测试/
自行编译，零证据编排），直通 domain_archive → delivery_review → push → external_verify。
出口验收不变且从严：推送前真实编译+UT、权威流水线绑 SHA 核销、MR 人工检视。

因此本手册后文凡描述以下机器的段落均为**历史记载**，不再是生产行为：
compile-agent 与 COMPILE 任务卡、中途人工代码检视（build_review/craft-reviewer）、
质量小循环（quality_*）、四步验证（verify_ponytail/verify_codecheck/verify_ut/verify_spec/
verify_comet）、tw_/rf_ 质量链、`tests_only`/`source_change_*` 步骤属性、`unlock source`、
主流程 COMPILE/UT/CODECHECK 任务卡与 `agent-task` 命令。任务卡机制仅存于独立 UT/CodeCheck
工具单（standalone）。在途旧状态由 load_state 的退役桥映射回 build（见
`cli_commands/state_config.py` 的 `_RETIRED_CHOREOGRAPHY`）。回溯锚点:
`before-flow-slim-20260825`。当前红线以 `scripts/tests/test_flow_liveness.py` 为准。

## 2026-08-04 稳定恢复后的权威边界

当前生产实现以 `d32ccfb` 的稳定流程为底座，只接受小步减法式演进。后续文档若仍描述独立 Test Blueprint、
Roadmap、详细 Build Plan、固定 Agent 返回字段、摘要重绑或 Lean 六阶段运行时，以本节为准：这些都不是新单的
生产门禁。Story 严格保持原有业务模板；Mae-Flow 的 Grill 实现影响、关键函数详述和领域归档影响
放在本地 `implementation.md`。Grill 和本地 Spec 是两者的强制输入；Spec/Grill/Story/implementation 留在
`.mae-flow-work/<单号>/`，只有协调后的领域文档进入 `docs/specs/`。

子 Agent 返回按不透明自然语言处理。Hook 只记录生命周期、真实 Bash/Skill 执行和真实文件写入；不得重新加入
结果标记、令牌、任务卡/源码摘要或 Reviewer 文件指纹校验。这里的放松不影响 PreToolUse 路径授权、只读 Reviewer、
UT/CodeCheck/Compile 的源码所有权和 Git 精确提交边界。

编码由主 Agent 结合本地 Spec、Grill、Story 与代码现场一次完成，不再拆开发批次或增加节奏选择。
实现和 compile-agent 编译结束后，用户只检视一次未提交 diff；有意见继续修改并重编译，通过后才精确提交。
任何文件时间戳、摘要变化或 Reviewer 后的主 Agent 修正，都不得自动重派 Reviewer、重问同一确认或把流程打回。
所有步骤输出的命令必须能被生产 parser 直接解析；每个可达非终态都必须存在真实后继。这两项和 Stop Hook
三次零进展 fail-open 共同构成“禁止卡死/循环”的发布红线。

---

## 一、架构总览

四层栈，每层只管一件事，互为兜底：

```
mae-flow(本插件)   —— 管"路径":公司交付流程的状态机 + 实物证据 + 越界拦截
  ├ 内嵌 Comet 0.3.9     —— 阶段方法 + 确定性状态/守卫/归档脚本
  ├ 内嵌 OpenSpec 1.6.0  —— 提案、delta spec、真相源、归档
  ├ 内嵌 Superpowers     —— brainstorming、写计划、执行计划、验证
  └ 内嵌 Ponytail        —— 写码精简与最终复杂度审查
公司质量 agent(ut-generator/codecheck-fix/story-generator/compile)—— 管"质量动作"
```

职责分层的一句话版本：**状态机管路径、证据管推进、hook 管越界、固定源码包管方法、子 agent 管质量**。

### 版本化执行方案接缝

`flow/playbooks.json` 是阶段默认做法的版本化目录，不是第二状态机，也不是一份
直接拼接的巨型 prompt。`workflow/execution_plan.py` 把当前 flow 步骤、证据合同、
默认 Playbook 和宿主固定的执行补充编译成只读 `execution-plan --json`；Cloud 与
界面只能消费该结果，不得按步骤名另写映射。每个 flow 步骤必须且只能绑定一个
默认 Playbook，目录损坏、重复绑定或漏步骤由 selftest 直接拒绝。

执行补充的优先级固定为 team → business_module → repository → task，但当前 Cloud
只产生 team/repository/task 三层；业务模块本身的知识仍走资源索引，不要为了凑层级
把业务知识改写成工程执行指令。补充只能影响关注点、顺序和协作，内核阶段、证据、
人工决定、Git/写入/交付权限始终锁定。宿主快照文件受 gate 保护；无效快照 fail-open
到平台默认，同时必须明确告警，不允许静默假装已采用。

阶段内定制走同一份快照的 `stage_customizations`：每项绑定 Playbook ID，只能启用
目录中 `required=false` 的动作、把非必用资源标成优先，或增加本阶段低优先级补充。
多个层级只做并集和后层补充，**没有删除必做项、关闭能力或改写步骤的语法**。目录项
必须有稳定 ID；Cloud 下单/设置接口先按当前目录白名单校验，内核加载快照时再验一次。
目录升级使旧可选 ID 失效时，整份可选快照 fail-open 到平台默认并明确告警，不能卡住
基本流程。Agent 只在对应 Playbook 生效的步骤看到该阶段定制，不把其他阶段全文灌入。

Playbook 的演进单元是“有版本的默认方案”：许愿墙反馈先带方案与 revision 入账，
接纳只代表进入维护队列，不自动改变运行时；核验完成后修改目录、递增版本并运行完整
selftest，才可成为新默认。不要原地覆盖同版本语义，也不要让一条用户反馈直接绕过发布
检查。

### 分层宪法:编排者与执行者解耦(2026-08-08 确立)

流程分两层,升级模型时只换一层:

- **编排层(不变)**——流程图(flow.json)、证据链、人类决策点、递工具(symbol-refs 等)、
  "机器只拦谎言"的门禁。这层验证的是世界与授权,不是模型,与模型强弱无关;
- **执行层(可换)**——步骤文档里教模型"怎么干"的部分:分块纪律、逐条自查、
  喂到嘴边的展开。这层全部是对当前模型弱点的补偿,模型换强一档就该删薄一层。

两层的接缝已经存在,就是四样东西:**权威输入 → 产物 → 证据 → 裁决点**
(任务卡与 current 输出承载它)。维护纪律:

1. 新增内容先问"这是在替模型作证,还是在替模型思考?"前者进编排层,
   后者进执行层并放到 guidance 指针后面,不进步骤正文;
2. 执行层材料标注它在补偿什么("补偿上下文有限"长期有效;"补偿模型不自觉"
   每次换模型用 no-op 测试法重审:删掉跑一单,行为没变差就到期);
3. **换模型档位的切换机制现在不建**——当前只有一个模型,单实现是假接缝
  (IMPLEMENTATION 模板同款判据)。第二个模型真到位时,升级动作 =
   替换 guidance/方法层 + 删薄步骤正文,flow.json 与证据层零改动。

### 执行者替换手册(三种插槽,全都不碰 flow.json 与证据层)

判据:流程只认证据、不认谁干的 = 插槽;定义产物格式与真相源的 = 主板,不可插拔。

| 插槽 | 现有 adapter | 换更强 skill 的动作 |
|------|--------------|---------------------|
| 编译(config 的「编译方式」) | build-fix / mvn / 任意命令 | 改 .mae-flow-defaults.json 预设,证据仍是 successful_quality_execution |
| UT 生成(config 的「UT生成方式」) | AutoUT / java-autout / 仓内写法 | 同上;证据仍是"真实生成并运行 + PASS" |
| 方法包(ponytail 等) | pack 注入 | 换 runtime/vendor 下的 SKILL.md + capability_shared 注册表一行;verify 包的拔除即先例 |
| 蒸馏方法(guidance/standards) | 本仓自有文件 | 直接重写,test_native_guidance 语义红线守住不退化 |
| 质量 agent(reviewer/fixer/generator) | agents/*.md | 换 agent 定义;流程只认任务卡 + 生命周期观察 |

**主板(换它=改合同,不是换插件)**:流程图、证据链、spec 引擎与真相源格式、
门禁、任务卡结构。OpenSpec 已内化为主板;Superpowers 已蒸馏,可换的是蒸馏物。

### 编码执行方式插槽(L3,2026-08-09)

预设「编码执行方式」: `主会话`(默认,零行为变化)/`新上下文`。开启后 build 步按
`runtime/guidance/build-fresh-context.md` 协议:主会话拆自包含工单+验收,实现子 Agent
按文档写码——治长会话注意力稀释(主会话 token 大头是 Write 整文件内容,插件剪不动,
这是唯一真正减负的杠杆)。门禁与证据两种方式完全相同;月光宝盒是最该先启用的场景。
**2026-08-09 已接线**(用户拍板):`current` 在 build 步读预设,开启时把协议横幅顶到
指令最前(埋文末等于没说);SKILL 铁律 2 改为指向本插槽;边界测试语义随之修订——
"写码由子 Agent 做"不再等于"实现整体外包",红线重定义为**连拆单与验收也丢掉**。
默认仍是主会话,不设预设的仓库零变化。

### codespec 接入(2026-08-08 预埋未接线;codespec = openspec 同源换名)

判断:codespec 疑似 openspec 魔改(产物/流程/定位一致)。接入形态 =
**规格引擎的第二个 adapter**(格式契约是主板,引擎是插槽):

- config 增插槽「规格引擎 = builtin | codespec」;此前不建切换机制的理由
  (单 adapter 假接缝)到此失效,第二个 adapter 真实出现才建;
- "流程里真用"落在 spec new/validate/archive 三处走 codespec CLI 真实执行,
  执行记录进证据链(同 compile/UT:真跑过+退出码+产物指纹);
- **红线:单一裁决源不可谈判**。阶段真相只在 .mae-flow.json;codespec 自带的
  状态文件按 .comet.yaml 三件套处置(CLI 独写、gate 绝对拦手工编辑、我们只读)。
  双状态机的学费(phase 掉队/僵尸 change/伪造推进)不交第二次;
- 现成资产:run_openspec 适配器(有意保留的逃生口)、内置引擎 vs 外部 CLI 的
  差分对拍测试(指向 codespec 即可量出魔改幅度)、双根解析(根目录 openspec/
  布局零改动共存)。
- **当前状态:预埋未接线**(用户决定)。adapter 与契约测试在仓,生产路径零改动:
  cli_commands/codespec_engine.py + test_codespec_engine.py(桩二进制钉死 6 条,
  其中 test_capability_is_dormant_not_wired 明确锁住"spec.py 不含 codespec");
- **接线日动作**(用户拍板后执行,预计半小时):参照提交 ab0dbbf 的 diff 恢复三处——
  spec.py 的 new/validate/archive 路由、lean_migration 的迁移跳过、
  capability_runtime 的 prepare 前置检查;删掉休眠断言换成路由正向断言;
- 启用方式(接线后,团队一次性):仓库 .mae-flow-defaults.json 写
  `"规格引擎": "codespec"`(可选 `"规格引擎命令"`,支持字符串或数组),
  项目根跑一次 codespec init;未预设的仓一切照旧;
- 接线前先用真 codespec 在 fieldtest-java 跑通桩测试同款动作;
  真实 CLI 子命令与 openspec 有出入时只改 codespec_engine.py 一个文件。

### 设计原则（改任何代码前先读）

1. **不信口头汇报，只信磁盘**。推进流程的唯一凭据是文件系统与 git 的真实状态（`done` 的证据校验）。任何新功能如果依赖"模型说它做了"，就是错的。
2. **正确性放硬层，优雅性放软层**。硬层 = 工具拦截（证据、gate、hook exit 2）；软层 = 步骤指令措辞。无法硬拦的（如"必须用子 agent 修环境"），明文写进指令并接受其失效模式只是"不优雅"而非"不正确"。
3. **一切幂等、无进程记忆**。主流程断点靠 `.mae-flow.json`，子 agent 断点靠文件系统现状。任何组件挂了再拉起，只看磁盘就能接着干。
4. **fail-open 但可观测**。hook 自身故障不阻塞用户干活（exit 0 放行），但必须在日志留痕。静默失效是本体系最大的敌人（历史教训：GBK 解码炸 → gate 无声关闭）。
5. **路径自锚定，不赌 cwd**。插件文件锚定 `__file__`；项目文件靠 `find_project_root()` 向上定位后 chdir。
6. **Windows-only**。命令用 `python` 不用 `python3`；子进程 `text=True` 必须显式 `encoding="utf-8"`（中文 Windows 默认 GBK）；路径匹配一律 `re.I`（NTFS 不分大小写）；跨盘符禁用 `relpath`；hook 经 Git Bash 执行。
7. **用最弱的可用模型压测，用最强的模型生产**。强模型自觉守规则，会掩盖 harness 的洞；弱模型是 harness 的模糊测试器——每个洞都变成立刻可见可修的事故（2026-07-18 用 Haiku 一下午打出八类偏差，全部修复后才算"实战可信"）。改动 harness 后的回归验证同理：拿弱模型跑演习沙箱，别拿强模型的"一次通过"当证据。
8. **硬禁令必须配裁决出口**。gate 与契约拦的是"未经用户裁决的动作"，不是场景本身——工程现实里被禁动作往往有正当场景（UT 揭出源码真缺陷、既有用例被规格演进淘汰、实现揭出设计/spec 有误、AskUserQuestion 客观不可用）。每条禁令都要回答"该场景的正规出口是什么"：unlock source（UT 缺陷修复）、SUSPECTED_BUGS 呈报（agent 自查后升级）、goto --ack 回流（设计/spec 修订）、accept-risk（宿主/收尾异常导致单个 Agent 令牌无法签发）。禁令没有出口，弱模型只剩"卡死"或"作弊绕过"两个选项，都是事故（ImpossibleBench 实证：给正规弃权通道，作弊率 54%→9%）。新加任何禁令前先写出口，出口必须带用户裁决与留痕。
9. **安装不是授权，逃生不能复用故障链**。没有 `.mae-flow.json` 时所有工具 Hook 必须旁路；仅安装插件绝不能阻止普通改码。`/mae-flow:mae-flow exit` 由 UserPromptSubmit 用户事件直接签发短时凭据并原子退出，不再依赖 `.usermsg` ack；若整个 Hook 通道损坏，真实 TTY 的 `exit --interactive` 是独立最后出口。任何新增门禁都必须证明这两条出口仍可用。
10. **单项能力不是缩水版完整流程**。UT、CodeCheck、Grill 使用 `.mae-flow-work/standalone-action.json`
    轻量控制层，不创建 `.mae-flow.json`，也不启用阶段源码门禁。三类任务共享任务卡、生命周期观察和报告机制；
    只有匹配当前任务卡的 Agent 派发/返回会进入证据链，普通 Edit/Bash/子 Agent 继续放行。独立任务默认不 commit，
    24 小时失效，取消只移除控制指针并保留现场。UT/CodeCheck 必须先冻结并展示范围，再用提案之后捕获的
    用户事件确认；确认前不得执行工具或生成任务卡。UT 至少包含一个被测业务文件，CodeCheck 排除测试文件。
    用户调整范围一律取消重开，禁止原地静默扩张。禁止为增加第四个单项能力复制一套新状态机。
11. **运行模式只能有一个裁决源**。CLI 和 Hook 一律调用 `mae_flow_core.resolve_runtime()`，禁止再用
    `exists(.mae-flow.json)` / `exists(standalone-action.json)` 各自排列优先级。完整流程、独立任务、退出标记
    意外共存时，完整流程具有唯一控制权；冲突只告警，不得因此放开源码门禁。所有 JSON 状态写入必须经
    `StateStore` 的项目锁、schema 迁移和 revision/CAS；禁止恢复固定 `.tmp` 或手写 read-modify-write。
12. **插件安装即能力可用，项目初始化不是用户流程**。OpenSpec、Comet、Superpowers、Ponytail 的固定源码和
    可执行运行时全部位于 `runtime/vendor/`，步骤指令由 `render_pack()` 在运行时从固定上游原文选段并做宿主
    适配；不得复制到用户目录、不得依赖全局同名 Skill、不得要求 reload。build-fix、AutoUT、java-autout 是
    内网插件自身随包发布的真实 Skill，仍必须通过 Skill 工具调用。CodeCheck 是唯一允许首次使用时尽力安装的
    公司 CLI；失败可诊断并走风险出口，不能把整个插件判为不可用。

### 能力图谱（固定源码直接运行，各管一段、互不越界）

| 思想源 | 在流程中的位置 | 融入方式与红线 |
|---|---|---|
| **grill-me**（mattpocock/skills 的 grilling） | grill 步（open 之前） | 五铁律原文级还原（追问至共识/决策树逐支/每题带推荐/一次一题/事实自查决策问人），工程化增强：8 维备课（模板化工作表 grill-prep，hook 校验章节 + done 拦「待填」残留）、题目四要素、阻塞性排序、收敛条件。**高度红线：只问需求层（WHAT），技术分歧记入「留给设计阶段」清单，禁止下钻** |
| **Comet 0.3.9** | open/design/build/verify/archive 的方法来源 | 只保留被 `CAPABILITY_PACKS` 直接读取的阶段 Skill；主入口与未加载参考文档已删除。state/guard/handoff/archive 脚本仅供显式兼容命令，不参与主流程状态机 |
| **OpenSpec 1.6.0** | 规格格式与方法来源 | schema、模板和选定 Skill 是内置规格引擎的运行时输入；自包含 ESM 仅供显式兼容命令与开发期差分测试，不参与主流程 |
| **superpowers**（brainstorming/writing-plans/executing-plans 等） | design/build/verify/review | 固定 commit 的完整 skills 目录由 `render_pack()` 原文加载；brainstorming 使用本单 Grill/decisions（已拍板决策禁止重问，新需求缺口回流 Grill 产物）；评审返工按 receiving-code-review 纪律先查证再裁决 |
| **EARS**（Kiro / IBM 需求句法） | grill 答案 → delta spec Scenario → UT 蓝图 | 行为规格一律「WHEN <条件> THE SYSTEM SHALL <可观测行为>」，一句一测，贯穿"澄清→规格→用例"三级可追溯。**红线：只约束句式，不新增流程节点/确认点** |
| **Ponytail** | build 全程 + verify 4.1 | 固定 commit 的官方 Skill 原文双用：build 写码时 full 档常驻预防（the ladder）+ verify 对 diff 做 review。**两条红线：YAGNI 不得砍 delta spec 要求的行为；禁 ultra 档** |
| **领域真相归档** | 最终质量 → 最终检视 | 只把确认、实现并验证的长期知识更新到 `docs/specs/`；过程经验不得另写 delivery-notes，`unchanged` 是合法结论 |

### 质量五维（一维一主，verify 顺序即理由：删 → 改 → 测 → 验）

| 维度 | 谁管 | 何时 | 为什么在这个位置 |
|---|---|---|---|
| 复杂度 | Ponytail | build 预防 + verify 4.1 | 先删：不给将死代码修规范/补测 |
| 规范 | CodeCheck | verify 4.2 | 再改：CodeCheck 是建议型工具。每个源码版本真实首检一次；有告警时只派一轮修复 Agent，Hook 核对任务卡、真实 fullcheck、范围和三数；CLEAN/REMAINING 都如实留痕，工具 FAIL 且未留下源码变化也可继续。done 不再第三次重跑，工具不可用/输出未知保存诊断后继续；只查业务代码不查测试 |
| 编译 | compile-agent（全流程唯一编译执行者，隔离舱） | build 批次边界 + tw/rf 涉码时 | 主会话永不编译；路由=配置的编译方式（C++→build-fix skill/Java→mvn）；生命周期返回只证明 Agent 已结束，真实 transcript 中匹配任务输入的成功编译才是质量证据 |
| 回归 | AutoUT | verify 4.3 | 后测：对定稿代码补测才不会被重构作废。C++ AutoUT 每任务卡只调用一轮，正常路径只跑一次最终全量 UT；仅在要认领非零 disabled/skipped 为存量时才选做修改前基线。PASS 至少真实运行 1 条测试；任务卡绑定蓝图时逐场景报告执行结果。明确失败、吞退出码、缩窄范围、删测试或存量基线下总数下降仍阻断。未知 runner 输出由 Skill/Agent 归一，Hook 不强套其他框架文案 |
| 正确性/漏洞 | comet review（standard，full/hotfix）；tweak 有意 off，由 tw_verify 的 verify 包(requesting-code-review)承接 | verify_comet / tw_verify 单点（build 收尾无评审动作；verify_ponytail 出界的 correctness 发现须落盘实现清单备注交 verify_comet 核对） | 与规范/复杂度维度不重叠，这一维只有它管 |
| 规格符合 | comet-verify | verify 4.4 | 终验对 spec；`verify_result: pass` 是硬证据 |

### 确认点预算（人工停顿的取舍原则）

人工停顿必须有明确决策价值，不能拿来证明“某阶段已经完成”。常规流程只保留：完整配置一次确认、
工作流选择、是否质询、grill/规格中真正未决的问题、hotfix/tweak 修改范围、人工代码检视和不可逆定稿。
设计、编码、编译、CodeCheck、UT、评审修复和推送是否完成全部由文件、提交、任务卡和执行令牌判断。
REMAINING 豁免、UT 判断源码缺陷、承担风险、强制回流属于异常高影响决策，继续使用强 ACK。
普通选择点一次 AskUserQuestion 按钮即可推进，禁止再索要一条“确认××”。
消灭无价值的碎片等待：build 四项选择（固化）、executing-plans 批次检查点（简报后直行）、TDD 说教（标准回应）、comet 分支/commit 建议（拒绝话术前置）。

## 二、目录结构

```
skills/mae-flow/SKILL.md   触发条件 + 5 条铁律(工具管不住、靠模型自守的部分)
flow/flow.json              流程定义:步骤图、证据、权限、环境检查项
flow/steps/<step>.md        每步的执行指令(改流程行为优先改这里,无需动代码)
scripts/mae-flow.py         CLI 协议入口（只调用公共 cli_runtime.main）
scripts/mae_flow_core/cli_commands/  按领域拆分的命令适配器、证据装配与公共路由
scripts/mae_flow_core/      CLI/Hook 共用内核：foundation/workflow/guard/quality/delivery 纯规则、运行模式与状态存储
scripts/mae_flow_core/capabilities.py  稳定门面；实现按能力包/宿主运行时/CodeCheck 拆分
scripts/mae_flow_core/lightcheck.py    稳定门面；实现按扫描/匹配/分析/报告拆分
scripts/mae_flow_core/specengine.py    稳定门面；实现按解析/校验/生命周期/归档拆分
runtime/vendor/             流程实际读取的固定方法/schema/模板，以及仍对外承诺的兼容执行器与许可证
runtime/bin/openspec        Comet 归档脚本调用内嵌 OpenSpec 的稳定入口
scripts/comet_compat.py     只兼容旧项目残留的 Comet Hook；新项目不会创建项目级 Hook
hooks/hooks.json            6 个 hook 注册(shell form + timeout 15s)
hooks/dispatch.py           Hook 协议入口(防卡死 + 项目根定位 + application/adapters 装配)
agents/*.md                 7 个子 agent 职责契约（返回自然语言不参与验签）
commands/mae-flow.md        /mae-flow:mae-flow 的完整流程、独立任务、月光宝盒与诊断入口
skills/mae-flow/assets/     STORY / CHAIN / GRILL-PREP / REVIEW 四份模板
```

## 三、核心机制

### 3.1 状态机（flow.json + .mae-flow.json）

状态存项目根 `.mae-flow.json`（gitignored，`.mae-flow.json*` 模式）。`mae_flow_core/state_store.py`
统一负责 schema 迁移、revision/CAS、项目级跨进程锁与唯一临时文件 + `os.replace`；这既防半截 JSON，
也防 UserPromptSubmit、SubagentStop、PostToolUse 同时 read-modify-write 时互相覆盖。
旧状态首次保存会原地升级，未知字段保留；高于当前代码支持的 schema 明确报错，不能猜。
主状态或独立任务指针损坏时保留现场并 fail-open；令牌、用户消息、拒签原因等可重建 sidecar 损坏时，
首次写入会先改名为 `.corrupt.<时间>.<pid>` 再重建，不能让一个附属 JSON 把 Agent 卡进无限重跑。

**运行模式不是“哪个文件先被 if 命中”**。`mae_flow_core/runtime.py` 同时读取完整流程、独立任务和退出标记，
输出唯一模式：`inactive / flow / direct / standalone / corrupt`。安全优先级是：
有效完整流程 > 有效独立任务 > 退出标记 > 未启用；过期独立任务忽略。完整流程与其他标记共存时仍执行完整
流程门禁，并把冲突交给 doctor 展示，避免历史上“陈旧 standalone 指针让完整流程 Edit 直接放行”的事故。
损坏主状态进入 `corrupt`，Hook fail-open 保普通开发，但保留 `/mae-flow:mae-flow exit` 的独立逃生路径。
终态后 `init` 先把本单摘要（耗时/goto/摩擦统计）追加进 `.mae-flow-history.jsonl`
（gitignored + gate 防篡改；`report --all` 聚合展示，团队度量数据出口），再自动备份为 `.last` 开新档；非终态 `init` 拒绝。
Direct 模式重入使用退出记录中的真实消息 ID：`init --message-id` 恢复原断点，
`init --new --message-id` 保留旧 snapshot 后开启另一流程。AskUserQuestion 的结构化答案在 Direct
模式只进入重入授权账本，不恢复其他 Hook 门禁或旧令牌。退出 snapshot 已是终态时，普通 init 直接沿用
终态滚动语义开启下一轮，不能恢复到 `end` 后原地卡住。`.mae-flow.json.exited` 仅是控制指针，
绝不能当作 `.mae-flow.json` 主状态使用。
仓根可提交 `.mae-flow-defaults.json`（团队预设：编译方式/UT生成方式/UT运行命令等恒定项），
require_sets 步骤的 `current` 会展示预填块；它只是候选值，配置阶段统一放进完整确认单一次确认，
不再逐项要求用户签字。
**过程区 `.mae-flow-work/<单号>/`**（gitignored）：过程性产物的唯一归宿——
Spec、Grill、Story、implementation、decisions、grill-prep、survey、review、verification、UT handoff、CodeCheck 豁免和诊断。
CodeCheck 的 append-only Markdown 诊断及原始
stdout/stderr/report/Agent diff 同样放这里：主流程按单号+步骤归档，独立任务跟随 work_dir；
单个大产物保存头尾并记录完整 SHA-256。诊断全程 best-effort，任何写入异常都不得成为新门禁。
这些过程件物理上不可能被卷进提交。
**文档类提交候选只有领域真相源**：`domain-archive apply` 本次实际新增/更新的
`docs/specs/<domain>.md`，以及新领域确实需要的 `docs/specs/index.md`。`unchanged` 不产生文档提交。
OpenSpec change/archive、clarifications、REVIEW、codecheck-exempt、delivery-notes 和 STORY 一律不是交付候选。
git add 一律精确路径，gate 硬拦 `-A/--all/.` 和整目录 `openspec/`（宽 add 是 STORY 跨单误提交的凶手）。
Hook 另记本流程中 Agent 通过 Write/Edit/MultiEdit 成功改写的路径，作为“可能需要提交”的候选集，
不是“都要提交”的白名单。COMPILE 任务另以任务签发时和合法收尾后的全路径指纹差，记录“编译改变、
且 transcript 没有成功直接改写”的精确路径。提交候选命中这本精确账时，不论文件名、目录、新增或
已跟踪，一律只拦当前非法 commit 尝试；提示会区分已暂存路径与同命令将纳入的路径，前者用
`git restore --staged -- <路径>` 只移出暂存区，后者从 `git add` / `git commit -a` / commit pathspec
移除后即可重试，不删除文件、不形成持久锁。后续成功的 Write/Edit/MultiEdit 会精确解除该路径的
COMPILE 归属。精确采集失败只记 Hook 日志并 fail-open，不拒绝已经合法收尾的 COMPILE；精确账缺失时，
未命中 Agent 候选集仍只提示逐文件确认，只有新增的高置信临时编译产物作为第二层兼容兜底硬拦。
流程启动前已存在、指纹未变且本单 Agent 未改写的路径属于跨单遗留，提交前硬拦，push 证据再兜底一次。
Manifest 拒绝整个 `openspec/`、所有过程文档路径，以及任何未由本次领域归档实际应用的
`docs/specs/` 文件。历史中已经提交的旧过程件不改写；升级时仅把尚未跟踪的旧过程件迁入本单过程区。

**子 agent 任务卡**（`.mae-flow-work/agent-tasks/`）：compile/codecheck/UT 派发前必须执行
`python ".mae-flow-work/bin/mae-flow.py" agent-task <kind>`。脚本把单号、本轮 diff、编译方式、UT 生成/运行方式和规格来源一次写齐；
PreToolUse 在派发前校验任务卡属于当前步骤，返回自然语言不要求回传指纹、令牌或固定状态行。
主 Agent 不使用实现任务卡，也不拆流程批次；实现子 Agent 的边界（设计承载的代码亲写、只读侦察随时可派、
机械扇出满足三条才派）单一权威在 `flow/steps/build.md`「子 Agent 边界」节，SKILL.md 只留指针不复述。
compile 任务卡覆盖本轮完整未提交实现——派发不改变门禁与证据：编译仍一次、检视仍一次。
编译后只进入一次人工检视，检视期间保留 diff，用户通过后才提交；修改意见会回到同一实现/编译闭环，
不会重新生成 Story 或重复确认设计。
独立 Grill 的 prep/final 任务卡由 `action critic` 同样签名；PreToolUse 在 Task 派发时通过统一
`_contract_state()` 先验任务卡，缺卡当场拦，不把错误拖到整只 agent 跑完。
对配置声明为 AutoUT/java-autout/build-fix 的任务，返回事件会从子会话 transcript 验真实 Skill 工具调用；
UT/直接编译命令与 `codecheck fullcheck` 同理验真实 Bash 调用，报告里写“执行过”不算证据。

**月光宝盒**是普通状态机上的显式运行策略，不是另一套流程。UserPromptSubmit 在新项目尚无状态文件时，
把十分钟内的明确授权写入一次性 `.mae-flow.json.moonlight-intent`；脚本验真并消费后才建状态，解决首次
启动的先后顺序问题。在途流程原地切换，已退出流程先恢复现场并清空旧质量证据。运行中 PreToolUse 硬拦
AskUserQuestion；编译、CodeCheck、UT 和最终验证仍先执行，失败只能用 `moonlight defer` 记录真实问题，
不能伪造通过。push 仍以本地 HEAD == 上游为硬证据；晨间 finalize 统一进入领域归档，不再进入 OpenSpec 定稿。
报告位于 `.mae-flow-work/moonlight-report.md` 并受 gate 保护；`repair` 从对应质量链入口重跑，旧报告里的
环境类遗留映射到该工作流的编译入口，不重跑需求和设计；`finalize` 才恢复普通归档流程。Stop Hook 在安全
停点前拒绝主 Agent 自行收工；真实硬阻塞须先执行 `moonlight blocked` 留痕，递归触发时 fail-open 防死循环。
完整启动原话持久化进 moonlight 状态；build defer 只允许在完整实现已经形成且仅剩外部编译问题时使用，
确保不拿无人值守模式跳过需求实现。

flow.json 步骤字段语义：

| 字段 | 含义 |
|---|---|
| `next` | 字符串=直连；dict=按 `choice_key` 的选择分流 |
| `next_by` | 按**历史**选择分流（如 branch_create 按之前 workflow_select 的选择） |
| `choice_key` / `choices` / `choice_answers` | 本步需 `done --choice <值>`；按钮文案通过 `choice_answers` 与 choice 对账，防 Agent 把用户点的 A 提交成 B |
| `user_ack` | 本步存在真实用户决策。正常由 AskUserQuestion 按钮完成，`done` 自动读取选择；宿主不回传按钮结果时才退回一次纯文本选择。它不能用于编译完成、阶段结束等机器事实 |
| `confirmation_answers` | 无 choice 的确认步骤只接受这里列出的最终按钮文案，避免把本步骤早先一句“可以”误当成范围或定稿确认 |
| `require_sets` | done 前必须 `--set` 齐的配置键；含"基线分支"时自动派生分支名 |
| `evidence` | 证据数组，全部通过才推进（见 3.2） |
| `allow_source_edit` / `allow_specs_write` | 本步的写权限，gate 据此拦截 |
| `skippable` | 允许 `skip --reason`（留痕） |
| `clear_hint` | `current` 打印「建议 /clear」提示（重上下文步骤入口的会话卫生引导；状态在磁盘，/clear 零成本） |
| `tests_only` | 把本步源码写权限收窄到测试路径；优先用「测试路径」配置（config 逗号分隔正则 / defaults 数组），缺失时使用保守内置规则，不再 fail-open；用户裁决后 `unlock source` 临时放行 |
| `source_change_recheck` | tests_only 步骤经 unlock 改了被测源码后，done 不走原 next，自动回流到指定质量链入口（rf_ut→rf_compile，verify_ut→verify_recompile） |
| `source_change_next` | 可选精简步骤如果实际改了源码，done 自动改走专用编译节点；没有源码变化才走普通 next。源码必须先形成当前步骤的新提交，避免任务卡漏掉未提交文件 |
| `terminal` | 终态；打印同名 md 作收尾指令 |

### 3.2 证据系统（EVIDENCE 表）

| 类型 | 校验内容 |
|---|---|
| `glob` | 文件存在（`any` 数组任一命中；pattern 支持 `{配置键}` 占位） |
| `branch_ok` | 正常路径校验当前分支名与基线起点；已有工作时仅接受用户明确选择沿用、且绑定当前分支/HEAD/基线的裁决收据 |
| `env_ok` | 环境检查全绿（实测，带 24h 缓存，见 3.5） |
| `tasks_checked` | 仅供旧在途兼容节点校验历史 change 任务；当前可达编码链不使用 |
| `tier_scope` | 轻量档范围硬校验:改动业务文件数超升级阈值(tweak>5/hotfix>3,与步骤文档升级条件一致)即拒,出路=升级工作流或 accept-risk tier_scope(绑 HEAD)。此前升级条件是纯提示词零机器锚点 |
| `spec_validate` | 内置引擎 validate 通过作硬证据；`allow_empty` 允许无规格轻量单（hotfix/tweak），`placeholders` 数组配置要拦的骨架占位前缀（缺省「（待填」，design 步追加「（待设计」） |
| `commit_tagged` | 最新 commit 匹配 `[单号][feat|fix]` |
| `spec_field` | 读 `.mae-flow.json` spec 段字段（v3 起阶段/产物指针的单一真相源）：`equals` 精确匹配或非空即过；指针字段登记时校验文件真实存在 + 现场复核（`yaml_field` 保留为在途兼容别名，指向同一实现） |
| `pushed` | `git rev-parse --verify HEAD` == `@{u}`（实测已推送），并按 `.mae-flow.json.agent-writes` 与流程明确维护的交付产物核对尚未处理的候选；初始化后出现但没有 Agent 直接写入来源的 IDE/编译器目录只保留在工作区审计，不会被误判成必须提交；若绕过提交门夹带了指纹未变的初始脏文件，则在终态拒绝 |
| `agent_ran` | 本步期间存在匹配 kind/step 的 `started → returned` 生命周期。PreToolUse 的 `tool_use_id` 与 SubagentStop 的 `agent_id` 属不同命名空间，通过 Agent PostToolUse 别名和唯一未闭合调用关联；两条返回通道幂等。返回文字不解析。compile/codecheck/UT 另核对与当前任务输入匹配的真实成功执行；AskUserQuestion 仍使用 ASKUSER 交互令牌。已有 started 但返回事件缺失时禁止自动重派，先 doctor；用户可用 `accept-risk` 只替代当前步骤该生命周期证据，其他机器证据不受影响。 |
| `content_free` | 文件内容不得命中禁止正则——把"标注协议"变成机器可查终态（story 在用：设计正文零"待确认"，明确排除后续转测自检表，破解指标博弈的职责锁） |
| `domain_archive_complete` | 领域候选已经由用户确认并应用，结果为 changes/unchanged，路径只在 `docs/specs/` 且输入仍新鲜 |
| `local_spec_valid` | 本单 `.mae-flow-work/<单号>/spec.md` 通过语义章节校验；仅有空文件或标题不能推进 |
| `verification_passed` | 本单验证报告包含独立 PASS 且不含 FAIL；仅创建文件不能推进 |

**CodeCheck/UT 覆盖口径（2026-07-27 用户拍板）**：检查/测试对象=**本次修改的函数**，不是整个变更文件——一单不背存量债，且与线上流水线的增量口径对齐。实现：`_changed_lines`（git diff -U0 的 +侧行集合）是范围数据源；CodeCheck 按变更行 ±`CODECHECK_LINE_SLACK`(3) 窗口做**预分类**，窗口内直接计入，窗口外逐条编号交用户确认是否涉及本次修改，未经确认不得排除、派修复 Agent 或 done；明细缺行号时保守全算。月光模式无法询问用户，故将全部候选保守计入。UT 任务卡携带"本次修改行范围"，agent 契约禁止为未修改的存量函数补测。窗口只是近似，不是真相——函数级规则、宏展开和定位漂移正是必须保留用户裁决的原因。
| `clean_paths` | 指定路径 git 实测已提交且无未提交改动；保留给旧在途节点和非需求过程产物兼容使用 |
| `archive_paths_clean` | 旧 OpenSpec 在途归档兼容证据；当前可达流程改用 `domain_archive_complete` |
| `glob_absent` | 负向存在证据：pattern 必须一个都匹配不到；当前主链不再用它证明 OpenSpec 归档 |
| `codecheck_clean` | 保留作旧在途流程兼容，不再由 `review_codecheck` 正常路径调用。新路径以首检或 Agent 最终 fullcheck 的绑定凭证收口，避免 done 第三次长跑 |
| `agent_or_no_source` | 本轮没有源码、测试或构建文件改动时自动过；只要有改动就强制指定 agent 的成功状态。适用于主流程、小改和评审返工，不再只认 C++/Java |
| `review_codecheck` | 三条流程统一先 `codecheck-scan` 冻结首检 HEAD/告警数；首检有告警才允许派一轮 CODECHECK agent，首检 0 后源码变化会令扫描过期。CLEAN/REMAINING/无源码改动的工具 FAIL 均留痕收口，不再调用 `codecheck_clean` 重跑；输出无法解析时保存绑定 HEAD 的诊断并继续，源码变化后重新尝试 |

**新增证据类型**：纯裁决优先放进 `workflow/`、`quality/` 或 `delivery/`，平台事实由
`cli_commands/` 适配；在 `cli_commands/evidence_registry.py` 注册
`ev_xxx(spec, st) -> (bool, 失败原因)`，再由 flow.json 引用。失败原因要写
"怎么补救"，它会原样回传给模型。禁止把规则重新塞回 `scripts/mae-flow.py`。

### 3.3 gate（PreToolUse 拦截）

`gate edit <路径>` / `gate bash <命令>`，exit 2 = 拦。保护清单：

- `.comet.yaml` / `.openspec.yaml`（comet-state 专属）
- `.mae-flow.json` 及其衍生（`.tokens`/`.tmp`/`.last`）与历史账本 `.mae-flow-history.jsonl`（Edit 和 Bash 写双拦）
- `dispatch.py` 禁止手动执行（伪造 agent 令牌的通道）
- 插件目录自身（防模型改规则）
- `openspec/specs/` 真相源（仅 `allow_specs_write` 步放行，Edit/Bash 双路）
- 源码判定统一走 `_is_source_path`：常见源码扩展名和构建入口文件在任何目录都算源码，再叠加 `source_patterns` 通用目录与 defaults/config「源码路径」私有正则；Edit/Bash gate、令牌新鲜度、UT 回流共用这一口径。Bash 路按 **token** 判断，禁止退回整串 regex。
- git 约定：分支名（checkout -b/-B、switch -c/-C、branch -m）、commit 格式（含不带引号的 -m）、force push（含 +refspec）、`git worktree add`（与状态机不兼容）
- `.env` 类密钥文件禁写；危险命令 denylist（管道执行远程脚本、`git clean -x`、对 `/`~`*`.`盘根 的递归删除——普通目录的 rm -r 不拦）。注：PreToolUse 硬拦在权限跳过模式下依然生效（hook 跑在 shell 里，提示词注入绕不过）
- 全局 `comet init` 会话内全禁（含子 agent、含管道喂输入变体）：交互式 TUI 被非交互执行会把二三十个 agent 平台全部初始化污染仓库（2026-07-20 实战）。现在无需用户手动初始化，`prepare_project()` 只以 `--tools none` 创建规格配置；拦截消息直接指向内嵌能力，不再给人工安装话术。
- `git add -A / --all / .` 与整目录 `git add openspec/` 全禁（宽提交会把无关文件与不入库产物卷进交付分支——STORY 跨单误提交实战；提交必须精确到当前 change 或 archive 输出清单）
- `git commit` 前按 `.mae-flow.json.agent-writes` 缩小候选范围：未由 Agent 文件工具直接改写的路径
  默认视为命令副作用并提示。两层 COMPILE 规则按顺序裁决：①正常可读的
  `compile_side_effects` 精确账命中且未被后续 Agent 直接改写时，不论新增/已跟踪和命名都硬拦；
  ②精确 provenance 缺失时，只有“未直接改写 + 新增 + 高置信临时编译产物”作为兼容兜底硬拦，
  避免对移动、删除、生成源码和项目约定二进制误杀。精确采集异常只记日志并 fail-open，不反向拒绝
  COMPILE；正常命中只拒绝当前 commit 尝试，按提示移出暂存区或命令清单即可重试，不删除本地构建结果，
  也不产生持久锁。流程启动前已存在且指纹未变的候选属于跨单遗留，会硬拦；OpenSpec 另按当前
  change/本次 archive 精确归属硬校验。COMPILE 任务卡明确禁止子 Agent commit/push；当前步骤任务仍有
  未闭合 started 时，`bash-compile-task-pending` 只瞬时拒绝 commit，不记 strike/permit；返回事件被
  生命周期观察记录后由主流程提交。
  baseline 另带有效位，Git 采集失败不得把空字典当 clean；当前不存在的路径（含 tracked deletion）不入账。
  归因、transcript/PostToolUse 直接改写消账和 Gate 共用 slash 标准化 + Windows case-fold identity，消账与
  新增在同一次加锁原子更新中完成。sidecar 损坏诊断的预读只可能竞争日志措辞，权威更新仍加锁原子化。
  provenance 只排除精确流程态：`.mae-flow.json` 及 sidecar、`.mae-flow-history.jsonl`、
  `.mae-flow-need-reload`、`.mae-flow/`、`.mae-flow-work/`、`.codecheckcli/`；
  仓库配置 `.mae-flow-defaults.json` 不在排除项内，COMPILE 改写它仍入账并硬拦。
  候选集只表示“有可能提交”，不能替代逐文件 `git diff`。
- Agent Git 写统一先解析为顺序 `GitAction`：兼容 `git.exe`、`-C`/`-c` 等全局选项、管道、
  引号内分隔符与反斜杠续行；单条 Bash 多个 commit/revert、mutating alias、
  `--pathspec-from-file` 和高置信 Python/shell/PowerShell/cmd 换壳一律硬拦，只读 alias 不受影响。
  静态分析不承诺识别任意代码或字符串混淆，最终 HEAD/候选/推送证据仍是兜底。纯 D 不属于交付输出；
  若旧暂存 D 在同命令被重新创建并 add，则按当前 A/M 候选重新做归属。显式 force-add 的 ignored
  路径继续按高置信硬拦。
- ownership 先聚合 review 快照、COMPILE 精确账和强产物等不可放行问题，再列 inherited/foreign；
  前三类不写 strike/permit。需要用户裁决的规则第一次拦截就给 exact `allow`，不要求空转三次。
  经用户原话验真的 Agent Git permit 会记录 actor/operation/path-or-commit/step/pre-HEAD；
  commit/revert 仅在 PostToolUse 证明单一结果提交的 A/M/D、blob 和 HEAD 完全匹配后固化，
  push/done 还验 last-touch，因此同路径后续提交、额外路径或陈旧收据都不会被放大授权。
  用户在外部终端执行的合法当前 change 交付不经过 Agent Hook，也不要求伪造 Agent-write provenance。
- verify_ut/rf_ut 的测试路径收紧（`tests_only`）：仓库配置优先，缺失时放弃旧的 fail-open，改用内置保守测试路径规则；Edit/Bash 双路都拦非测试源码。**这不是死禁**——非标准目录补 `.mae-flow-defaults.json`，真源码缺陷走 unlock 裁决通道。
- UT 命令若生成非测试文件，属于命令副作用事故而非“源码缺陷裁决”：提示不得使用 `unlock source` /
  `accept-risk`，也不向用户提问；只可恢复任务基线原本 clean 的路径，或把本轮新输出可恢复地移出仓库，
  既有用户脏改必须保留。只有 Agent 有意直接改写非测试源码时，才保留既有 unlock 用户裁决出口。
- **unlock source 裁决通道**：UT 揭出疑似源码缺陷、用户判"确为代码缺陷"后，`unlock source --reason <裁决> --ack "用户原话"`（ack 走与 done 相同的三级验真）解锁当前步骤，历史留痕 `unlock:source`。done 检测到被测源码变化后不消费旧 UT 证据，而是自动回流完整质量链：review 回 rf_compile；主流程进入 verify_recompile，再走 Ponytail/CodeCheck/UT，不重做实现计划。无 unlock 却改了被测源码则判越权，不允许通过补验证洗白。

**已知局限（设计决定）**：Bash 写检测的 `WRITEISH` 正则是打地鼠，永远可绕过（如 `python -c`）——它的定位是**软提醒层**，真正的门槛在 done 的证据校验。不要试图把 bash 正则做"完备"。

### 3.4 hooks（dispatch.py）

6 个事件：SessionStart / UserPromptSubmit（状态注入 + 用户输入捕获进 ack 验真存储）、PreToolUse（gate）、
PostToolUse（模板校验 + ASKUSER/UTRUN + Agent/Task 返回兼容记录）、
SubagentStop（Agent 生命周期与真实执行/写入范围观察）、Stop（月光宝盒安全停点约束）。

**防卡死四件套**（历史上曾造成每条消息挂 10 分钟，动这里要极其小心）：
- 看门狗 12s 强制 `os._exit(0)`
- stdin 守护线程读，3s 超时按空输入（治 harness 不关 stdin）
- 调 mae-flow 的子进程 8s 超时
- 每次调用记 `%TEMP%\mae-flow-hook.log`：`start/end + rc + 耗时`；只有 start 没 end = 被看门狗击杀

Agent 返回内容是不可解释的诊断文本，可以是任意自然语言、Markdown 或空文本。PreToolUse 用
`tool_use_id` 记录 started；SubagentStop 用 `agent_id`，Agent/Task PostToolUse 同时提供 `tool_use_id`
与 `agentId`，因此观察层维护别名并幂等闭合。旧版已经写出的空 kind/step returned 只在历史上唯一
未闭合调用成立时自愈；并发歧义绝不猜测。真实编译、UT 和 CodeCheck 调用仍从 transcript 独立核对，
返回文字中的 PASS/CLEAN/数字/令牌均不能替代机器执行。
UT 已知输出解析只做额外加固：未知 C++ runner 不因文案不匹配被拒；实际命令额外追加
filter/exclude/disable、明确失败/segfault，或可机器确认的新增 disabled/skipped 时仍不得 PASS。
CodeCheck 完整成功输出会保存计数凭证；未知成功输出保存执行哈希，报告重答不重复 fullcheck。
所有 `agent_ran` 门禁都有统一人工出口 `accept-risk`，但它刻意不是“跳过步骤”：命令先确认当前步骤确实需要该 Agent，
再用 `_ack_verified(exact=True)` 核对用户当前步骤原话，拒绝脏源码，记录风险/step/task SHA/HEAD；`ev_agent_ran` 只把这一项视为通过。
CodeCheck 的现场扫描、clean_paths、提交、分支和归档等证据继续执行。新任务卡、源码变化、goto、推进和退出恢复都会废弃放行。
**非正常收尾自动尸检**（2026-07-20，治"agent 奇怪退出无人知晓死因"）：无标记收尾/重答仍失败时，把轮数、临终输出、检出的报错特征落 `%TEMP%/mae-flow-agent-autopsy.log`，并把一行「尸检线索」嵌进打回消息——主 agent 重启新实例必须转告（SKILL 铁律）；配套四个 agent 契约的"带着情报死"条款（工具连败 2 次→FAIL/BLOCKED 收尾写明详情；轮次过半未完成→提前收尾出部分成果，不许干到被硬切）。

### 3.5 内嵌运行时与 CodeCheck

`init` 在创建 `.mae-flow.json` **之前**调用 `prepare_project()`：校验 Git 项目根与宿主必需项
（Python/Git/Git Bash——v4 起 Node 可选），用内置规格引擎 `ensure_config` 创建
`openspec/config.yaml`（v4 后不再调 Node CLI、不再写 `.comet/config.yaml`）。失败时没有流程状态，
所有 Hook 仍处于 inactive 旁路，绝不能出现“初始化失败但普通开发也被锁住”。

`runtime/vendor/manifest.json` 是开源组件版本真相源；`runtime/THIRD_PARTY_NOTICES.md` 和每个组件的
LICENSE 必须随包。OpenSpec CLI 是兼容/差分测试用的自包含 ESM；打包时只能保留一个 `runCli()` 入口，重复入口会让 archive
第一次已移动目录、第二次再移动时报错。`scripts/tests/test_capabilities.py` 用中文+空格路径覆盖完整生命周期，
任何组件升级都必须让此测试先红后绿。

CodeCheck 不属于公开运行时。`ensure_codecheck()` 先解析 PATH、Windows `%APPDATA%\npm\codecheck.cmd` 和
`npm prefix -g`；探测看 `fullcheck --help` 输出是否含 `fullcheck`，**不信退出码**。缺失时只在真正使用
CodeCheck 时执行一次公司 npm 安装，registry 用命令行一次性参数，禁止永久修改 npm config。失败记录
30 分钟冷却，普通流程给 `codecheck_tool` 风险出口，月光模式记入晨间报告。Windows 执行继续使用
`shell=True` + PATHEXT，不手工拼 `cmd.exe /s /c`。
扫描器和 Agent 返回观察共享 `mae_flow_core.codecheck_log`：前者记录每批 argv/展示命令、退出码、
耗时、解析来源和原始产物；后者记录修复 Agent 的 Bash/Write/Edit/Skill 输入输出、最终报告、
任务卡基点到当前工作区的 name-status/stat/diff、生命周期和范围裁决。日志只用于诊断，
真实门禁仍由现有状态、任务卡、transcript 和 Git 证据决定，禁止反向依赖日志。

### 3.6 子 agent 契约

三条不可违背：**返回自然语言不参与验签**、**无状态幂等**（先检查后动作，禁止"我下次再"话术——没有下次，是下一个实例接手）、**不能与用户对话**（决策留给主会话呈现用户）。
**派发三原则**（2026-07-20 轮次经济学实战定型，生产模型 Glm-5.1 且 thinking 关闭，每轮只干一小步）：
①**喂到嘴边**——原料原文进任务提示（spec 条目/文件清单/告警明细），不给路径让它自己花轮次读；
②**分批小实例**——复杂工作切批逐实例（UT 每批 3-5 方法带收口批、codecheck >30 告警按文件分批、编译按模块），单实例马拉松 60-80 轮后被上下文裁剪拖垮，加轮次预算救不了；
③**单次执行**——长任务以工具/提供方的同步返回作为完成信号，一轮只发起一个可见动作；宿主超时就如实
上报，不转后台轮询，也不在输入未变化时重复执行。
maxTurns 现值：ut=200 / compile=100 / codecheck=100 / story=60（FIELD-TEST 0.7 持续校准）。
新增 agent 时：契约文件放 agents/，并在
`application/hooks/agent_completion.py` 声明纯契约、在
`adapters/hook_active_events.py` 装配平台证据与路由；`hooks/dispatch.py` 只保留协议入口，
禁止把识别正则和验签状态机加回入口。

### 3.7 面板与通知（展示层，2026-08-08 落地）

**分层定位**：展示层是编排层/执行层之外的第三层，随模型变强而**变重**——模型越强，
人越少盯过程，但裁决点仍在人手里，那几次出现的信息质量决定整套东西的价值。

`scripts/mae_flow_core/panel/`（只读，不写任何状态）：

| 模块 | 职责 |
| --- | --- |
| `snapshot.py` | **唯一结构化出口**。`panel --json` 打印它；任何展示层（含公司可视化壳）都从这个口取数，不许爬中文文本 |
| `markdown.py` | md 子集 → HTML（只覆盖我们自己模板的语法面，故不引第三方 JS） |
| `plantuml.py` / `plantuml_sequence.py` / `plantuml_flow.py` | PlantUML 子集 → 内联 SVG（时序/活动/组件类图），识别不了就交回源码 |
| `diffview.py` | 统一 diff → 左右双排对照，超 700 行**报数**截断 |
| `page.py` / `assets.py` | 自包含单文件 HTML；内网零依赖、零服务 |
| `notify.py` | 阶段推进与"需要你裁决"的主动通知 |

**四条铁律**（各有测试钉死，改前先读 `panel/__init__.py`）：

1. **只读**——`test_panel_snapshot` 断言调用前后 `.mae-flow.json` 字节与 mtime 不变；
2. **可缺席**——没有面板流程一模一样跑完，任何"只有面板上能确认"的环节都是设计错误；
3. **软失败**——取不到的东西进 `warnings`，永不抛栈、永不非零退出；
4. **不触发重活**——只读文件与 git（带 timeout），禁止调 CodeCheck/npm/编译。

**版面优先级是契约不是审美**：待你裁决 → 产物 → 变更 → 证据 → 建议 → 进度（最后，
且**不给百分比**：flow 有分支与回退，算出来必然是编的）。页面**不提供任何推进按钮**——
那是绕过证据的官方通道，比模型偷懒危险得多。`test_panel_page` 锁住这两条。

**降级第三态**：`degraded=true`（CodeCheck TOOL_ERROR 等）必须渲染成区别于通过的颜色。
"工具没跑起来"和"跑了且干净"混成一个绿灯，是这套系统最不能容忍的谎。

**通知**：`advance()` 落地后调用 `notify.announce()`，只在两种时刻响——到了需要用户
裁决的步骤、跨入新阶段；同阶段内推进保持安静（噪声化的通知等于没有通知）。
桌面弹窗默认开启；静音把 `.mae-flow-defaults.json` 的 `"桌面通知"` 写成 `false`，或设 `MAE_FLOW_NO_NOTIFY`。（原来默认关闭——而要人先建个 JSON 才生效的功能等于没有：内网反馈"通知未生效"真因就是它压根没开。）
`MAE_FLOW_NO_NOTIFY=1` 可强制关闭。阶段表在 `notify.PHASES`，是 step→阶段的唯一来源，
`test_panel_notify` 用覆盖断言拦住 flow.json 增删步骤造成的漂移。

**为什么不是 `status --json`**：`status` 已经在打印原始状态 JSON，再加 `--json` 会撞语义。
`panel` 是全新只读命令，既有路径一行没动。

## 四、comet 思想源合同（v3 后 comet 不再是运行组件，方法约定内化到这些落点）

v3 摘除第二状态机后，`.comet/config.yaml`、`.comet.yaml`、`capability comet-build-defaults`
全部不复存在；下表是仍然生效的**方法级**约定与它们的现行落点（破坏任何一条仍会出鬼故事）：

| 约定 | 原因 | 现行落点 |
|---|---|---|
| 当前需求过程件只在本地工作包 | 防止 MR 混入单号流水文档 | `.mae-flow-work/<单号>/` + Manifest 边界 |
| review_mode=standard（full/hotfix；tweak 有意 off——tw 链另有 compile/CodeCheck/UT 兜底 + tw_verify 装载 verify 包做正确性核对） | 三维分工：comet review=正确性/漏洞，CodeCheck=规范，Ponytail=复杂度，互不替代 | build.md + verify_comet.md 装载的内嵌方法原文 |
| isolation=branch、tdd=direct+direct_override、executing-plans | 不让 Agent 记五个字段 | build.md 的固定选择声明 |
| comet verify 的分支处理选"保持分支" | 推送归 push 步，MR 人工建 | verify_comet.md |
| 最终长期知识的数据源 | 用户确认后的领域归档事务 | `domain-archive prepare/show/apply/status` |
| comet 方法文本锁 **0.3.9** | 内嵌方法原文按固定源码选段，不读取全局版本 | `runtime/vendor/manifest.json` + `CAPABILITY_PACKS` |
| OpenSpec 锁 **1.6.0** | schema/templates/归档语义固定（引擎按其源码逐条移植并差分对拍） | vendored schema/templates + `specengine.py` |
| 不创建 `.cac/.claude`、不 reload | 安装插件就应可用，不污染项目或个人目录 | `prepare_project()` 回归测试 |
| 所有交付路径只走一次领域归档 | 当前真相统一、无按单号历史副本 | flow.json + domain_archive.md |
| verify 链固定顺序 Ponytail→CodeCheck→UT→Comet | 删→改→测→验：重构定稿后 UT 才覆盖得上最终形态 | flow.json + 各 verify step md |
| ponytail 红线：YAGNI 不砍 spec、禁 ultra 档 | spec 是合同；质疑需求归 grill 阶段 | build.md + verify_ponytail.md |
| grill 高度分层：WHAT 归 grill，业务设计归 Story，流程实施细节归附录 | 提问不撞车；Story 模板稳定 | grill.md + story.md + implementation.md |

**用户话术对照表**（用户界面层彻底封装：用户所见一律左列，右列只活在实现层与维护文档；--choice 代号、目录名、命令是 comet/openspec 的实物，不改）：

| 用户话术 | 上游/内部 |
|---|---|
| 完整开发 / 已定位问题修复 / 局部修改 / 处理评审意见 | full / hotfix / tweak / review（--choice 代号，与 comet workflow 对齐） |
| 需求规格 | `.mae-flow-work/<单号>/spec.md` 本地过程件 |
| 业务设计 | `.mae-flow-work/<单号>/story.md` 本地过程件 |
| 实施附录 | `.mae-flow-work/<单号>/implementation.md` 本地过程件 |
| 领域归档 | `docs/specs/<domain>.md` 当前真相源 |
| 方案讨论 | superpowers brainstorming |
| 代码精简 | ponytail review |

话术纪律定义在 SKILL.md（面向用户不出现上游术语；doctor/排障输出保留原词，那是给维护人看的）。

**团队推广的四条运营纪律**（经验层，违反不会立刻坏，但会慢性失血）：
1. **CLAUDE.md 分工**：仓库 CLAUDE.md 只放仓库事实（构建/目录/领域约定），流程规则只活在插件里——两处都写会形成双源打架，弱模型无所适从。
2. **宿主权限由团队统一维护**：插件不再修改个人/项目 settings。密钥读取 deny 和常用只读命令 allow
   应由 CodeAgent 团队基线统一下发，避免 Mae-Flow 安装时覆盖不同人的环境。
3. **会话卫生**：一单一会话为佳；改插件/agent/settings 后必须重启会话（定义在会话启动时缓存）；长会话行为漂移时 /clear（状态在磁盘，进度不丢）。重上下文步骤（build、verify 链入口）的 `current` 会主动提示 /clear 时机（`clear_hint` 标记）；重步骤 md 内置「中断恢复先读什么」清单（`current` 每次打印，恢复质量不赌模型自觉）；build 的批次 commit 后是安全 /clear 点，批次结论/调试根因假设要求写进实现清单备注行（中间推理不留在会话里）。
4. **仓库预设**：`.mae-flow-defaults.json` 提交进仓（编译方式/UT生成方式/UT运行命令等恒定项），config_confirm 时 `current` 自动展示预填，新人第二单起免逐项来回；基线分支与需求文档不预设免问。可选字符串键「执行补充」由 Cloud 在首次 clone 后固定成代码仓层执行快照（最多 2000 字），只能补充关注点/顺序/协作方式，不能覆盖阶段、证据、人工决定和权限；恢复与重跑沿用原快照，不随仓库 HEAD 漂移。另支持**机器直读键**「测试路径」（正则数组，gate 直接消费，启用 verify_ut 的测试路径收紧）——预填展示类键、执行偏好键与机器直读键的区别要在改代码时留意。

**阶段互锁哨兵（2026-07-21 立，v3 引擎内化后大部分退役）**：当年治"comet 与 mae-flow 双状态机冲突像随机 bug"的 `COMET_PHASE_EXPECT` 步骤↔phase 对账已随第二状态机一起摘除（单一真相源后无账可对）。存活至今的部分：①活跃 change >1 的僵尸诊断（`_active_change_count`，doctor 强预警不硬拒——多单并存会干扰在建区判定）②"被 GUARD 拦禁止换工具硬绕，先 doctor"的 SKILL 铁律 ③change 目录内移动用 git mv。历史机制细节看 git 历史，不要按本段旧文恢复已删代码。

**升级内嵌组件 checklist**：更新 `runtime/vendor/manifest.json` 与许可证 → 重新生成 OpenSpec 单入口 bundle →
核对 Comet state/guard 字段和事件 → 核对 `CAPABILITY_PACKS` 选中的上游标题仍存在 → 跑 capability 生命周期、
selftest 和 tweak/full 冒烟 → 确认渲染结果没有 `/comet-*`、`/opsx:*`、外部 Skill 加载或用户目录路径。
vendor 裁剪只允许删除同时满足三项的文件：不在 `CAPABILITY_PACKS`、不被规格引擎读取、也不属于公开
compatibility 子命令或旧项目退出兼容链；删除后必须重算组件树哈希并跑完整自检。

## 五、常见维护任务

- **改某步的行为** → 只改 `flow/steps/<step>.md`。指令是给模型的，写清楚"做什么、何时停、done 带什么参数"。
- **加一个步骤** → flow.json 加节点（接好上下游 next）+ 建同名 steps md + 若需新证据见 3.2。跑 `python -c "json.load(...)"` 和流程图连通性检查。
- **加内嵌能力** → 固定源码进 `runtime/vendor`，登记 manifest/NOTICE/LICENSE；在 `CAPABILITY_PACKS`
  选择需要的上游原文章节并补生命周期测试。禁止复制到用户 Skill 目录。
- **改 gate 规则** → 纯命令/路径裁决改 `mae_flow_core/guard/`，平台事实装配改
  `cli_commands/gate.py`。Edit/Bash 两路都要覆盖，路径匹配带 `re.I`，并跑 Gate
  单测、一次性 permit 入口测试和冒烟探针。
- **动 Hook 行为** → 先选 `application/hooks/` 的纯用例或 `adapters/` 的平台装配；
  只有 stdin/stdout、超时、看门狗和顶层 fail-open 才能动 `hooks/dispatch.py`。任何新增
  IO 都要问：会阻塞吗？超时了吗？失败会留日志吗？
- **发版/打包前必跑 `python scripts/selftest.py`** → 语法/JSON/流程图/证据注册/占位符/agent 同步/关键文件自检，任何 ❌ 禁止发布。

### 发版收口

1. 在 `CHANGELOG.md` 顶部按日期记录用户可感知变化，不维护 Mae-Flow 自有版本号；
2. 核对 `runtime/vendor/manifest.json`、第三方许可证和内嵌 bundle 单入口；
3. 运行状态内核、能力生命周期与 selftest，再执行 `git archive HEAD` 解包并在干净目录重跑；
4. 按 `FIELD-TEST.md` 阶段 0 在公司 Windows 实机做金丝雀；
5. 验证通过后直接推送 main；不为 Mae-Flow 自身创建版本标签。开源依赖的固定版本与状态 schema
   仍是可复现性/兼容性数据，不属于对外版本标识，禁止顺手删除。

仓库中的分享 PPT 和图片不会进入 `git archive` 生成的插件源码包；`.gitattributes` 是发布包排除清单。

## 六、Windows 军规（违反任何一条都是真实故障，不是理论）

1. 子进程 `text=True` 必须带 `encoding="utf-8", errors="replace"`（GBK 解码炸过 commit 证据和整个 gate）
2. 用户可见命令写 `python`，永远不写 `python3`（Store stub 陷阱）
3. 跨盘符场景禁 `os.path.relpath`（抛 ValueError）
4. 路径匹配一律 `re.I` / `.lower()`
5. `git rev-parse` 类命令加 `--verify`（失败时不回显参数本身）
6. 状态写盘走 tmp + `os.replace`（杀软锁文件）
7. hook 命令用 **shell form**（`python "${VAR}/dispatch.py" 事件`，Git Bash 展开变量、路径带引号）。公司 codeagent 实测**不支持 exec form 的 args 数组**——只执行 command 本体，hook payload 落进 python stdin 被当脚本解析，JSON 的 `false` 炸 NameError（2026-07-20 实战，症状：`<stdin> line 1 name 'false' is not defined`）
8. 时间戳一律显式 `%Y-%m-%d %H:%M:%S`，禁用 `%F`/`%T` 简写（依赖 UCRT 的 C99 支持，老运行时抛 ValueError；时间戳是证据比对/账本/令牌的命脉，不赌运行时）
9. 解析 git 输出中的文件路径时加 `-c core.quotepath=false`（否则非 ASCII 文件名被引号+八进制转义，pattern 匹配漏检）；且勿依赖 porcelain 输出的列偏移（`sh()` 会 strip 首行前导空格），按空白切分
10. Git 文件名、用户配置值或 ref 进入子进程时必须使用 argv + `shell=False`；禁止把它们插进
    shell 字符串。Hook 的宿主启动命令仍按军规 7 使用 shell form，两者场景不同

## 七、排障手册

### hook 日志速读（`%TEMP%\mae-flow-hook.log`）

| 现象 | 结论 |
|---|---|
| 无此文件 | hook 没执行到 Python：查 PATH 的 python、exec form 支持、变量展开 |
| start/end 成对、几十 ms | hook 层健康 |
| start 无 end / WATCHDOG 行 | 有阻塞被看门狗击杀，看前后行定位是哪个事件 |
| `stdin read timeout` | harness 没关 stdin（已兜底，仅供了解） |
| `chdir 项目根` | hook cwd 非项目根，定位机制在工作（正常） |
| `EXC ...` | dispatch 内部异常（已 fail-open），按异常名修 |

### 故障树

- **模型说"流程未初始化"但明明有单** → 运行
  `python ".mae-flow-work/bin/mae-flow.py" doctor` 看第一行项目根对不对。项目根定位以最近的
  `.git` / `openspec` 为边界，不会再被更高层目录的杂散 `.mae-flow.json` 劫持；状态应放在项目根，
  不要靠扩大向上搜索范围兼容错误位置。
- **gate 好像全失效了** → flow.json/状态文件 JSON 坏了会让 mae-flow 崩溃（exit 1 → fail-open）。手动跑
  `python ".mae-flow-work/bin/mae-flow.py" gate edit src/x` 看 traceback。
- **done 一直被拒但产物明明在** → 看报错里的 pattern 是否含未解析占位符（对应配置没 `--set`）；yaml_field 类型看 `.comet.yaml` 字段实际值。
- **证据实测行为**：所有证据都可手动复现——直接跑报错消息里提示的那条命令。

### 冒烟用例（改 gate/证据/hook 后必跑）

**常驻探针已入库**（v5 起，selftest 点名跑）：`scripts/tests/probe_gate_smoke.py`
（gate 拦/放抽样 + spec_validate/glob/glob_absent 证据全路径）、
`scripts/tests/probe_spec_semantics.py`（spec 子命令三档端到端、布局混用、阶段机、
伪造通道）。改 gate/证据后先跑这两个，再按下面的手工用例集补面。

历次会话沉淀的用例集，最少覆盖：gate 的拦/放各路（状态文件+历史账本、插件目录、源码大小写、bash token、worktree、specs 双路）、证据正反例（yaml_field、pushed、非法工号）、dispatch 的 stdin 挂起（Popen 握管道不发 EOF，应 ~3s 自行退出）、子目录 init/current（应落项目根）、终态重 init（应备份重开 + 账本追加一行）、模板结构校验三路（STORY/CHAIN/GRILL-PREP）、`current` 的占位符替换与仓库预设展示、unlock 正反例（无 ack 拒/伪造 ack 拒/验真后放行 gate/推进自动失效/未配置仓 no-op）。

## 八、已知局限（均为权衡后的设计决定，改前先想清楚当初为什么）

**全流程硬度审计结论（2026-07-18，逐步过完 18 步）**：正确性级缝隙已清零。以下软点为**有意接受**，各有兜底，不要误判为疏漏：

- **verify_ponytail 零证据**——跳过无人知；兜底：复杂度维度有 build 期 ponytail 常驻 + codecheck + comet review 三重冗余。
- **end 沉淀纪律零机器锚点**——逐条用户确认/只记仓库事实/30 条上限全是提示词约束（end 为终态步无证据）；兜底：装载侧把条目直接喂进 agent 任务提示，污染可在 report/复盘发现；机制化（拆出终态+ASKUSER 令牌+content_free 行数校验）留待实际出现污染再加。
- **CodeCheck 是建议型工具**——REMAINING/工具故障不阻断插件内交付，最终流水线可能仍有自己的独立门禁；
  本地必须保留首检、Agent 报告或工具诊断，源码变化会让它们失效。`approve-exemption` 仅保留给旧在途流程兼容。
- **ack / goto --ack / 需求文档确认等"用户原话"类**——会与当前步骤开始后的 UserPromptSubmit / AskUserQuestion 应答原文匹配，旧步骤的“可以”不能复用。Hook 从 stdin 原始字节优先按 UTF-8 strict 解 JSON，禁止控制台代码页和 `errors=replace` 污染确认账；消息带 ID/编码/SHA 供 doctor 观测。配置确认是特殊强类型通道：`config-review` 先冻结完整配置、需求文档 SHA 与一次性收据 ID，用户最终回答必须绑定该收据；多问题的局部回答不能代替整单确认。连续失败只停止同命令自动重试，不形成永久锁，也不要求 exit/init。
- **相邻选择不能复用旧回答**：每个选择只消费当前步骤实际返回的具体选项；只有 ASKUSER 令牌而没有答案正文时拒绝猜测，宿主客观缺失按钮正文才让用户补一条当前标准选项。
- **各类"展示/告知"义务**（收尾摘要、报告展示）——纯 UX，失效不腐蚀正确性。
- verify_ut 的"测试真跑过"：UTRUN 令牌已记录（PostToolUse-Bash 检出 UT运行命令被调起，doctor 可见），**尚未设为 done 硬证据**——须公司机金丝雀确认「子 agent 的 Bash 调用会触发 PostToolUse」后再加（否则 verify_ut 永远过不去）；确认后在 flow.json verify_ut 的 evidence 加 `{"type":"agent_ran","agent":"UTRUN"}` 一行即启用。原候选方案"done 现场跑 UT运行命令"作罢（真实套件耗时超 done 容忍度）。

- **verify_ut / verify_codecheck 无固定报告文件证据**——过程证据为当前任务卡、Agent 生命周期和真实工具执行；最终自然语言报告仍需展示。
- **确认按风险分层**：普通流程选择读取当前步骤 AskUserQuestion 的按钮结果，`done` 不再要求重复
  `--ack`；只有 ASKUSER 令牌而没有选项正文时，不能知道用户选择了什么，因此禁止信任 Agent 提交的 choice。
  goto / unlock / 豁免 / accept-risk 会改变流程或放宽约束，
  仍只接受当前步骤捕获到的用户原话，不能跨关复用。
- **一仓一单**——并行走 worktree；暂停/恢复仍未做。用户不再需要流程时直接 `/mae-flow:mae-flow exit`：
  用户事件授权、现场快照、项目标记和 Comet Hook 兼容一次完成，代码不回滚；Hook 故障时使用真实 TTY
  `exit --interactive`。禁止重新引入“手删状态文件”的假逃生口，也禁止让 exit 再依赖普通 ack。
- **跨仓交付走"链路分解 + 各仓平等交付"两段式（v2，废除了主从概念）**——`/mae-flow:mae-flow chain` 由主模型做链路分解（事实自查：触点/接口/语言差异；决策问人：边界/契约/顺序——grill 哲学的跨仓同构，且必须主模型做因为子 agent 不能与用户对话），产出 CHAIN 文档；此后各仓地位平等、独立跑流程，以 CHAIN 文档为需求输入。**有意不做**跨仓联合状态机——chain 是直通模式无 done 硬校验（同 story 补生成的权衡）；痛点积累后 beads（依赖拓扑工单账本）是编排层候选。
- **review 轮次不碰规格（红线）**——行为/规格类意见在 rf_triage 分诊转 hotfix/full。进入 rf_triage 前自动冻结 `review_base_head`；质量链拆为 rf_compile → rf_codecheck → rf_ut，只按本轮 diff。无业务代码机器自动跳过；有业务代码必须 COMPILE/OK 与 UT/PASS。旧流程的 rf_verify 作为一次性迁移桥；旧版已停在 verify_ut/rf_ut 且没有 `step_heads` 时，按进入步骤的 history 时间恢复之前最后一个 commit，只允许保守多验，禁止以当前 HEAD 补位。
- **Bash 写检测可绕过**——定位是软提醒层（见 3.3）。
- **返回事件丢失不自动重派**——已有 started 时由 `done/doctor` 明确展示 Hook 诊断和风险出口；禁止把宿主漏记变成 Critic/Reviewer/编译循环。
- **普通确认按钮以标准标签为源、真实收据作兼容**——`current` 必须原样展示 `confirmation_answers`；只有当前步骤 AskUserQuestion 收据中真实展示并点选、且带明确确认主题的按钮才可映射到标准确认。泛化“可以”、修改意见、普通文本和高风险授权不得借此放宽；不匹配诊断必须同时给出实际答案与标准标签，禁止让用户重复确认或让 Agent 猜 `--choice`。
