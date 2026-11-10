# 公司 Windows 实机测试清单(2026-07-25)

目的:插件从"macOS 沙箱实证"到"实战可信"的最后一公里。按序执行,每项记录 现象/日志/结论;
发现问题记三元组:现象 + hook 日志片段 + 所在步骤。**验收线:整单 gate 误拦次数应为个位数。**

## 阶段 0 — 开机金丝雀(约 15 分钟,全部通过才进阶段 1)

- [ ] **0.0 未启用绝不接管（发布阻断项）**：任选一个从未执行
  `python ".mae-flow-work/bin/mae-flow.py" init` 的普通仓，让 AI Edit 一行源码、
  执行 Bash、启动普通子 Agent，必须全部放行；日志应出现 `inactive: bypass`。仅安装插件就拦源码属于黑事件，
  本项失败立即停止推广。再在该仓父目录临时放一份测试用 `.mae-flow.json`，子仓仍必须按自己的最近 `.git`
  边界完整旁路，不能被父目录的旧流程误接管；测完删除测试状态。
- [ ] **0.1 hook 存活**:启动会话发一条消息,开 `%TEMP%\mae-flow-hook.log`:
  - start/end 成对、耗时几十 ms 级 → 通过;
  - 文件不存在 → harness 不支持 exec form:把 hooks.json 六个 hook 的 `"command"+"args"` 改回
    shell form(`python "${CODEAGENT3_PLUGIN_ROOT}/hooks/dispatch.py" <事件>`),重启会话再测;
  - 有 start 无 end / WATCHDOG 行 → 有挂起,收集日志全文发维护人,暂停实测。
- [ ] **0.2 PostToolUse-Bash 延迟**:让 AI 连跑几条 Bash 命令,看日志里 posttooluse 的耗时与频度
  (Windows python 冷启动 + 杀软扫描可能放大)。不可接受 → 待办:把 UTRUN 检测收窄到 verify_ut 步。
- [ ] **0.3 payload 字段三查**(决定三个机制的激活/降级状态):
  - UserPromptSubmit 有无 `prompt` 字段:开单后发条消息，运行
    `python ".mae-flow-work/bin/mae-flow.py" doctor` 看「ack 验真存储」条数(>0 = 激活);
  - AskUserQuestion 有无 `tool_response`:任一确认点弹框后,doctor 存储条数是否 +1(记录了应答);
  - **子 agent 的 Bash 是否触发 PostToolUse**:跑过 UT 后 doctor 看 UTRUN 行。**是 → 回头在
    flow.json 的 verify_ut evidence 加一行 `{"type":"agent_ran","agent":"UTRUN"}` 转硬证据**;否 → 保持观测。
- [ ] **0.4 statusline**:状态栏是否常驻"单号│步骤(中文标题)│分支";顺带看 statusline 收到的 JSON
  是否带上下文用量字段(有 → 立"水位仪表"待办)。在子仓父目录放旧退出标记，子仓不得显示“已退出”；
  同目录有效流程与旧退出标记并存时必须显示有效流程，和 doctor 的运行模式一致。
- [ ] **0.5 编码底线**:确认中文 Windows 控制台下 current/done 输出无乱码不炸(✅/emoji 显示为 ? 可接受)。
- [ ] **0.7 子 agent 尸检观测**(Skill 可用性已确认 ✓ 2026-07-20):下一次任何子 agent"奇怪退出"时,
  看 `%TEMP%\mae-flow-agent-autopsy.log` 是否留下了尸检(轮数/临终输出/报错特征),打回消息里是否附了
  「尸检线索」——把那份尸检发维护人,弱模型自行了断 vs maxTurns 硬切 vs API 中断,一看便知。
  **轮次预算校准**(2026-07-20 实锤:UT agent 25 轮烧完仍在读文件,已调 UT=200/compile=100/codecheck=100):
  观察调后 UT agent 实际用多少轮收尾(尸检/日志 query_depth),200 不够或严重富余都回报,下版校准。
- [ ] **0.8 三个独立入口**：在未 init 的普通仓分别试 `/mae-flow:mae-flow ut`、`/mae-flow:mae-flow codecheck`、
  `/mae-flow:mae-flow grill`。均不得出现 `.mae-flow.json`；UT/CodeCheck 启动后必须先展示实际文件清单并等待二次
  确认，确认前不能运行工具或派 Agent；空范围、UT 只有测试文件、CodeCheck 只有测试文件都必须拒绝。
  额外输入“我还没确认以上范围”或“确认以上范围是什么意思？”，都不得启动任务；
  用户选“需要调整范围”后应取消重开，不能由 Agent 原地扩张。确认后 UT 必须真实运行且不自动 commit，
  CodeCheck 0 告警不得派修复 Agent，Grill 完成 prep/final 两次 critic 后只留下澄清文档。
  任务进行中另让 AI 修改普通源码必须放行；
  `/mae-flow:mae-flow cancel` 后任务卡和报告保留、控制指针消失。再在有完整流程的仓调用任一入口，应提示先由用户
  `/mae-flow:mae-flow exit`，不得自行退出或叠加状态。
- [ ] **0.6 六事件实弹确认(hook 数据真到手的判定,~10 分钟)**——fail-open 设计下 payload 丢失不报错只降级,
  必须逐事件看"数据依赖行为"真实发生,日志干净不算数:
  - **PreToolUse**:先在演练仓明确 init，再在禁止改源码的步骤让 AI"在 src/ 下随便加一行"→ 必须被拦；
    另在未 init 普通仓重复一次必须放行，证明 gate 只接管已授权仓;
  - **PostToolUse·A**:让 AI 写一个只有一章的 `docs/grill-prep-TEST.md` → 必须被打回"缺少章节"(测完删文件);
  - **UserPromptSubmit**:开单后随便发条消息，运行
    `python ".mae-flow-work/bin/mae-flow.py" doctor` 看「ack 验真存储」≥1 条(=prompt 字段到手);
  - **PostToolUse·B**:任一确认点弹框选择后,让 AI 展示 `.mae-flow.json.tokens`(读不拦)→ 有 ASKUSER 条目且带 head;
  - **SubagentStop/PostToolUse**:派一次 compile-agent 或 ut-generator-agent 后,`.mae-flow.json.agent-observations`
    出现已关联的 started/returned 记录（PreToolUse `tool_use_id` 与 SubagentStop `agent_id` 本来不同）；
    质量 Agent 还应有匹配任务输入的真实 Skill/Bash 成功执行记录。
    返回文字可任意变化，不应因状态行、令牌、摘要或格式被打回；只读 Reviewer 故意改源码仍必须被真实写入边界拦截；
  - **Stop**:月光宝盒在非安全停点让主 Agent 结束回复，应被打回继续；执行 `moonlight blocked` 留痕后应允许停止，
    日志出现 stop start/end。若宿主根本不触发 Stop，月光模式降级为 Skill 软约束，必须回报维护人；
  - **SessionStart**:重启会话,开场自动出现"存在进行中的交付流程"提示。
  加分项(最强确认,防线不但活着还咬人):在 story/定稿步故意不弹框直接让 AI done → 应被 ASKUSER 证据拒绝。
- [ ] **0.9 稳定基线减法回归（发布阻断项）**：用一个包含多个修改点的完整开发需求验证：
  - 中文配置卡和旧 Grill 八维质询仍可用，prep/final Critic 各一次且至少能形成衍生问题；Grill 结果进入 Story；
  - Story 前没有独立 Test Blueprint、Roadmap 或详细 Build Plan；Story 后不再选择开发批次；
  - 主 Agent 基于 Spec/Grill/Story 一次实现，compile-agent 编译后只停一次供用户检视未提交 diff；
  - Story/Reviewer 后由主 Agent 修正文档或代码，不得因时间戳/摘要变化自动重审、重复确认或回退阶段；
  - 故意执行一次 current 输出中的命令，必须原样可解析；任务卡缺失时错误消息给出的恢复命令也必须可直接执行；
  - Lightcheck 自动获取精确变更范围，检查嵌套深度和魔鬼数字但不阻断；Compile 只有一次同步调用且无 sleep/轮询；
  - 最终提交前展示用户确认过的精确文件清单，Spec/Grill/Story 不入库，协调后的 `docs/specs/` 领域文档可入库。

## 阶段 1 — 首单实跑校准(半天,选一个小需求,建议 局部修改/已定位问题修复)

- [ ] **1.1 安装即用（发布阻断项）**:
  - 新建一个带空格和中文路径的 Git 仓，只安装插件，不运行任何 setup/reload/init；普通 Edit/Bash 必须放行；
  - 执行 `python ".mae-flow-work/bin/mae-flow.py" envcheck`，Python/Git/Git Bash 显示真实版本与路径（必需项），Node.js 在可选项
    （缺失不判失败——v4 起规格引擎纯 Python 内化），「内置规格引擎」与各阶段内嵌规则全部为 ✅，
    CodeCheck 缺失不能把插件判失败；
  - 执行 `python ".mae-flow-work/bin/mae-flow.py" init`，应自动创建 `openspec/config.yaml`（v4 后不再有 `.comet/` 目录）后直接进入配置确认，
    项目中不得出现 `.cac/.claude/.cursor/.windsurf` 等平台目录；
  - 删除流程状态后连续两次执行 `capability prepare`，两次都成功且第二次不新增杂项、不产生
    `openspec/config.yaml` 以外的配置文件；
  - 用 Git worktree 再执行一次 `python ".mae-flow-work/bin/mae-flow.py" init`，`.git` 为文件也必须正常识别；临时让 Git Bash
    不可见时，初始化应在创建 `.mae-flow.json` 前失败并列出缺失依赖（Node 不可见不得失败），
    普通开发仍不受 Hook 影响；
  - 让 AI 尝试全局 `comet init`，必须被拦并明确说明“内嵌运行时无需手动初始化”，不能再给用户迁移或
    reload 指令。
- [ ] **1.2 固定源码与 CodeCheck 首用**:
  - `capability status` 显示内置规格引擎与所有能力包为 ✅（v4 后无 OpenSpec/Comet 版本行）；机器全局安装任何版本的 openspec/comet 不得影响结果；
  - 从 open 到 archive 跑一条最小变更，创建/设计交接/状态推进/规格合并/目录移动各只执行一次，
    不能出现重复 Created 或“第一次已移动、第二次找不到目录”；
  - 已安装 CodeCheck 时应找到真实 `codecheck.cmd`，即使 `fullcheck --help` 退出码为 1 也判可用；
  - 未安装场景只在第一次真正检查时尽力安装，命令带一次性 `--registry`，npm 全局配置前后不变；
    安装失败时不得循环安装或锁死流程，普通模式能提示风险出口，月光模式能写晨间报告。
- [ ] **1.3 配置确认**:工号取"域\"后半段;需求文档三分支(给个 docx 试试"不可读格式"话术);
  口述一段中文需求后运行 messages → requirement-record，文件应为 UTF-8、正文 SHA 可复核；再造一个
  UTF-16/GBK 文本走 `--source` 规范化。故意给坏文件执行 config-review，应拒绝且正式 config 保持为空；
  完整配置生成确认单后，一个 AskUserQuestion 同时带多个回答也只能由最终“确认以上全部配置”推进；
  点选后直接 `done`，不得再次要求用户输入确认句。
  “确认 master”必须拒绝。改一项配置或改需求文档内容后旧收据立即失效；连续两次错误 ack 应明确提示
  “停止重复但流程未锁死”，用户发普通确认消息后无需退出即可恢复。确认后把恒定项写 defaults 提交。
- [ ] **1.4 开发方式选择**:四选项是否以中文(完整开发/已定位问题修复/局部修改/处理评审意见)展示,推荐+依据合理。
- [ ] **1.5 全程观感**:done 报错可读性;gate 每次拦截记下来(误拦/漏拦分类);comet-build 四选项口径与公司标准一致。
- [ ] **1.6 grill 工作表**(若走完整开发):缺章打回与「待填」残留拦截的报错观感。
- [ ] **1.7 定稿确认**:AskUserQuestion 令牌真能拿到(archive_confirm 硬校验不误拦)。
- [ ] **1.7a 确认点预算**:workflow/grill_ask/story_ask 点按钮后直接推进；grill、build、rf_fix 完成时
  只展示摘要，不弹“确认本阶段完成”，也不要求手输确认句。
- [ ] **1.8 中文路径/内容**:造一个中文名源码文件走一遍(quotepath 修复验证);中文 commit message 无乱码。
- [ ] **1.9 终态**:交付总结自动输出;`.mae-flow-history.jsonl` 追加一行;`report` 与 `report --all` 数字合理。
- [ ] **1.10 第二单开局**:直接说新需求 → 旧状态自动备份;defaults 预填生效(配置确认一次点头)。

## 阶段 2 — 专项演练(视时间,可拆到后续几天)

- [ ] **2.0 Spec2Code 编码质量 A/B**：选择一个已有真实交付，以相同需求、基线、编译和 UT 口径
  分别执行旧流程与新流程；使用
  `docs/field-tests/spec2code-quality-ab.md` 记录主 Agent 读取范围、用户修改轮次、
  Reviewer 有效/拒绝意见、最终独立盲审、蓝图映射、耗时和返工阶段。只记录证据，不计算综合质量分。
- [ ] **2.1 /clear 恢复**:编码实现中途 /clear → 说"继续" → 看它是否按恢复清单先读本地 Spec/Story/implementation/diff 再动手。
- [ ] **2.2 review-fix 全链**:对首单 MR 造 3-4 条评审意见(混入一条该反驳的、一条涉及行为变更的)→
  rf_triage 逐条"先查证再裁决"、反驳有依据、行为变更被分诊转常规轮次 → 修复 →
  rf_compile → rf_codecheck → rf_ut → commit 进原 MR。重点故意验证四个拦截:
  - CodeCheck 首检有告警时让主 agent 直接修 → 应被「首检前 HEAD/FOUND 对账」拒绝补手续;
  - 手写豁免文件但不问用户 → done 应报「没有用户审批令牌」;
  - UT 派发故意漏 AutoUT/UT命令 → 即使 Agent 正常返回，done 也应因无真实 Skill/Bash 成功执行而拒绝；
  - compile-agent 故意不传 build-fix → 无任务卡/无 build-fix Skill 调用应打回,FAIL/BLOCKED 令牌不能 done。
- [ ] **2.3 unlock 裁决通道**:人为造一个 UT 能揪出的源码 bug → agent 自查报告六要素齐全 →
  三选一裁决 → unlock(伪造 ack 应被拒)→ 修复 → done 应自动回流完整质量链（review 回 rf_compile，主流程进 verify_recompile），不得直接去 push/verify_comet，也不得重做 comet-build。
- [ ] **2.4 测试路径缺省硬边界**:临时移除「测试路径」配置，UT 步 Edit/Bash 写 `src/main.*` 仍应被拦；写 `tests/`/`src/test/` 应放行；非标准测试目录应提示补 `.mae-flow-defaults.json`。
- [ ] **2.4a 跨仓源码识别**:UT 步分别尝试 Edit/Bash 写顶层 `include/Foo.hpp`、`lib/x.cpp`、根 `CMakeLists.txt`，均应按源码拦截；私有无扩展名目录通过 defaults「源码路径」补充后也应生效。
- [ ] **2.4b 旧在途状态迁移**:备份后从状态中移除 verify_ut/rf_ut 的 `step_heads`，保留正常 history；current/doctor 应恢复进入 UT 前的 commit，并能发现之后的源码变化，禁止用当前 HEAD 洗白。
- [ ] **2.4c codecheck_clean 现场复核校准**(CLI 已确认、证据已实装,2026-07-20):
  真实单走到规范检查步,验证——done 时现场重跑的耗时(多文件时是否可接受,超时阈值 15min 够不够)、
  零告警时即使没有「共有 N 条告警」也能从报告「总计」解析、CLI 退出码 1 不误判、
  approve-exemption 审批→豁免落盘→复核放行的闭环、测试文件确实被排除。
- [ ] **2.4d compile-agent 实测**:Windows 宿主中一次 `mcde` 编译是否只显示一个同步工具动作、
  快速完成能否立即返回、5-10 分钟单模块能否在最长工具超时内返回、宿主 timeout 能否一次如实上报且
  不转后台轮询；同时记录 COMPILE 令牌+新鲜度绑定的"最后改码后必须再编译"体感、
  在源码/构建输入未变化时触发一次报告重答并确认无第二次编译动作，再修改一个任务内源码并确认
  恰好新增一次编译；
  numstat 防掏空不变量有无误拦(合理精简走 SHRINK_EXEMPT 声明)。自动化已覆盖：不透明
  build-fix 单次同步调用指令、最小报告发令牌、报告重答复用而不重编、Full 分阶段未提交快照风险放行，
  以及源码变化后两类凭证失效；本项仍须在公司 Windows + 真实 mcde 环境完成时长和宿主协议金丝雀后才能勾选。
- [ ] **2.4e UT 收尾重答**:真实 AutoUT+UT 全绿后故意把 `GENERATOR_USED` 简写、三个数字挤在一行，
  应按 transcript 真实调用签发或只要求重答，不得重复生成/重复跑长 UT；随后改一行测试，旧凭证应立即失效。
  再追加 `--gtest_filter` 或在报告写 `disabled to avoid segfault`，必须明确拒绝 PASS 并提示走问题裁决。
- [ ] **2.4f Agent 令牌风险放行**:故意让 COMPILE/UT 任一 Agent 收尾不合规，done 应同时给“重试/承担风险继续”选项；
  伪造 ack 必须失败，用户明确确认后只放行该令牌并能推进。确认后再改一行源码，放行应立即失效；CodeCheck 场景即使
  放行 CODECHECK Agent 令牌，现场仍有告警时仍必须被 `codecheck_clean` 拦住，证明没有把整步机器检查一起关掉。
- [ ] **2.5 弱模型压测**:换最弱可用模型跑一单局部修改,记录全部偏差(话术跑偏/跳步尝试/报错后的自愈质量)。
- [ ] **2.6 会话卫生**:改插件后不重启会话的行为漂移确认一次(应复现,验证文档警告属实)。
- [ ] **2.7 中途退出**:在 open/design 这类原本禁止改源码的步骤直接发送 `/mae-flow:mae-flow exit` → 不得二次确认，
  状态栏立即显示“mae-flow 已退出│普通开发”，Edit 一处源码和一处 UT 均应放行，
  `.mae-flow-work/exited/` 有完整现场，业务文件/提交没有被回滚。重启会话后仍保持普通开发；明确说“重新接回原流程”时
  init 应恢复旧断点，若期间改过源码则回退质量链，旧 COMPILE/CODECHECK/UT 令牌不得复用。再把状态 JSON 故意截断，
  `/mae-flow:mae-flow exit` 仍应成功并保留坏文件；最后临时禁用 UserPromptSubmit Hook，在真实终端执行
  `exit --interactive`，Agent 管道调用应拒绝、用户输入 EXIT 应成功。
- [ ] **2.7.1 终态入口矩阵**：准备一个 `current=end` 的已完成现场，依次验证：
  `exit` 幂等成功且保留终态；新一轮完整入口与 `review-fix` 自动归档并进入配置确认；
  即使 Agent 误用 `init --new` 也归一化成功且本条用户原文能在新轮 `messages` 中看到；
  独立 UT/CodeCheck/Grill 在自身参数校验通过后自动归档终态再启动，参数不完整时不得提前归档；
  非终态流程仍拒绝 `init --new` 和独立任务叠加。全程不得建议 goto/skip/交互式 exit。
- [ ] **2.8 月光宝盒端到端**:分别从全新项目子目录、普通在途步骤、已退出的直接开发模式说
  “开启月光宝盒”——三种入口都应一次生效且不弹 AskUserQuestion。人为制造一条 CodeCheck/UT 环境失败，
  确认先真实尝试、再留痕继续，报告含现象/尝试/风险且没有假 PASS；push 成功后停在晨间检查、不自动定稿。
  早晨执行 report → repair，应回到环境或对应编译入口并重跑后续质量链、再次 push；finalize 后才进入定稿。
  另造一次远端认证失败，必须停在 push 并记录错误，不能把本地 commit 冒充已推送。

## 结果回填

| 项 | 结论(通过/问题) | 备注/日志 |
|---|---|---|

历史卡死主因怀疑:旧版 dispatch stdin 阻塞 × command hook 默认 600s 超时——0.1 是第一优先。
全部结果发维护人或直接回填本表;确认项同步销掉记忆里的悬案清单。
