# /mae-flow:mae-flow

你已进入 mae-flow 交付工作流。**全程使用简体中文与用户交流。不要自由发挥,严格按以下步骤执行:**

**第一个动作固定是启动流程本身,不是探索代码库。** 禁止在启动流程前派只读侦察子代理、
禁止先做架构调研、禁止先写方案或计划——需要读哪些代码、读到什么深度,由流程的
grill / open / story 步骤给出确切指令。自行开局的调研既不进任何产物,也不构成任何步骤的证据。
若宿主处于只读/计划模式(写不了文件,`init` 无法落盘),先告知用户切出该模式再开始;
不要用"先给个方案"代替流程。

所有命令统一使用 Hook 安装的稳定入口 `python ".mae-flow-work/bin/mae-flow.py" ...`；
该文件客观缺失时只使用 Hook 注入的绝对脚本路径,禁止读取空环境变量或全盘搜索插件缓存。
通读 skills/mae-flow/SKILL.md 并全程遵守其铁律。
**此后所有流程动作只来自 `current` 与各命令的输出,禁止预判、禁止跳步**——
脚本会在每一步打印确切的下一动作,与本文件冲突时以脚本输出为准。

## 按参数分流

- **无参数** — 完整交付流程。已有 `.mae-flow.json` 且 `current=end` → 直接 `init`(自动归档上一单并开新轮);
  非终态 → `current` 续跑,禁止把已完成状态当成仍在途。
  有 `.mae-flow.json.exited` → 当前是普通开发模式:仅当用户本条消息明确要求重新接回时,
  先 `messages` 取本条消息 ID,恢复原流程 `init --message-id <ID>`、另开新流程 `init --new --message-id <ID>`;
  普通改码请求不要 init。`.exited` 只是退出指针,**严禁移动/改名/复制成 `.mae-flow.json`**。
  两者都没有 → **不要接管普通开发**;仅当用户明确要求 mae-flow 交付且已给单号/需求时才 `init`。

- **moonlight / 月光宝盒** — 无人值守交付。后续参数是 `report|repair|finalize|off` → 直接执行
  `moonlight <动作>`(report/repair 不询问;finalize 有遗留才展示报告并等用户明确接受后携带原话重试)。
  其他参数视为需求描述:从用户本条消息取真实出现的 `月光宝盒` 或 `moonlight` 作为
  `moonlight on --ack "<原词>"` 的短语;本条消息中的单号/需求/文档直接作为 config_confirm 输入,不再反问。
  此后持续 current → 步骤 → done,禁止 AskUserQuestion、禁止结束回复等待。
  选择项按不扩大范围原则自动决定(评审意见→review、明确缺陷→hotfix、极小改动→tweak、其余→full;
  full 默认做需求质询,STORY 仅用户明确要求或涉及测试协同时生成)。
  质量步骤真实尝试仍失败 → 按 current 输出 `moonlight defer` 留痕继续,最终必须尝试 push
  (build 只有完整实现已形成且仅剩外部编译问题才能 defer);push 后停在晨间检查,不自动归档领域文档。
  需求材料/权限/外部依赖客观缺失且无法自行补齐 → 按 current 输出 `moonlight blocked` 保存现场后结束;
  禁止反复重试或编造输入。其他步骤提前结束会被 Stop Hook 打回。

- **exit** — 退出在途流程、保留代码、转普通开发。用户输入本命令即是明确授权,
  UserPromptSubmit Hook 会直接保存现场并退出,**禁止再追问一次确认**。
  看到"无需再次退出"= 已在终态,视为成功并停止,不得再调用 CLI 或要求终端操作。
  只有非终态且 Hook 未完成退出时,才重试一次
  `exit --reason "用户明确执行 /mae-flow:mae-flow exit" --ack "/mae-flow:mae-flow exit"`;
  仍失败就把 `python "<插件>/scripts/mae-flow.py" exit --interactive --reason "切换为普通开发"`
  原样交给用户在真实终端手动运行,禁止用 Bash 管道代答、禁止再询问。成功后不再 current/done。
  没有在途流程时只说明无需退出,不创建新流程。

- **ut / codecheck / grill** — 独立任务,**不 init 完整流程**。存在非终态 `.mae-flow.json` 时,
  说明不能叠加两套控制状态,请用户先发送 `/mae-flow:mae-flow exit`(禁止自行退出);
  `current=end` 不算在途,`action start` 会先自动归档再启动。入口:
  - ut: `action start ut --request "<用户描述>" --files "<被测业务文件>"`(--files 可重复;
    用户只说功能时先定向找到至少一个被测业务文件)。PASS 必须真实生成并运行测试;
    疑似源码缺陷先展示自查报告让用户裁决。
  - codecheck: `action start codecheck --request "<用户描述>" [--files "<路径>"]`;只看报告加 `--check-only`。
    剩余告警只报告,禁止自动豁免。
  - grill: `action start grill --request "<用户原话>"`(已有文本材料用 `--source "<路径>"`)。
    备课与两轮 critic 按输出执行;主 Agent 一次只问一题,每个答案先查模糊词/新名词/矛盾再问下一题,
    子 Agent 无权替用户回答;收尾 `action finish --report "<澄清文档>"`。
  三者的范围确认、任务卡派发与收尾命令**全部以 `action start` 及后续输出为准**(脚本会硬拦未确认的范围);
  默认不 commit、不 push。取消:`action cancel`(保留已产生的代码与报告,不回滚)。

- **story** — 仅补生成 STORY,不 init。单号:参数带了→直接用;`.mae-flow.json`(.last) 里有→向用户确认;
  都没有→问。先 `template` 拿模板绝对路径,再启动 story-generator-agent(模式=补生成,传单号、
  该单产物路径、模板路径)。输出路径必须精确为 `.mae-flow-work/story/STORY-<单号>.md`(Git 本地排除的
  过程区,永不进交付提交;写到别处视为失败先移回)。返回后按流程内 story 步同一套确认纪律:
  AskUserQuestion 裁决设计未决项并据实更新；转测自检表的后续待办如实保留，不做全文关键词清零。展示路径与概览收尾,
  不再询问是否入库;交付中唯一允许进仓库的文档是 `docs/specs/` 领域文档。

- **review-fix** — 处理评审意见(本单已交付、MR 已建)。本条命令已是明确授权,禁止再问"是否重新启用"。
  单号确定同 story。按状态唯一分流:`current=end` → **直接 `init`**(不得先 exit/goto/skip,
  不得把终态误报成死锁;误用 `init --new` 脚本会自动归一化);只有存在 `.mae-flow.json.exited` 时,
  才 `messages` 取本条 ID 后 `init --new --message-id <ID>`。config_confirm 以上轮配置预填,
  workflow_select 选 review(同单号→同分支→commit 追加进原 MR)。红线:review 轮**不碰规格**,
  涉及行为/规格变更的意见在 rf_triage 分诊转 hotfix/full。用户开场粘贴的意见清单留存,
  进 rf_triage 时原文照录进 REVIEW 文档。

- **chain** — 跨仓需求的链路分解,不 init,先于任何仓的交付。由你亲自做,禁止外包子 agent(全程要问答)。
  ① 按 config_confirm 同一套纪律确定单号与需求文档;
  ② 用户给出涉及仓清单与本地路径(建议 /add-dir 拉入各仓);
  ③ **事实自查**(读代码不问人):关键词/接口调用链/配置路由三条路各扫一遍防漏;
    每个触点=仓+文件+符号名+一句为什么相关,禁止"可能涉及"式散文;拿不准的标"低置信"列出交用户裁决,
    宁滥勿缺;现有接口盘点带定义文件出处;
  ④ **决策问人**(AskUserQuestion 逐项,每题带推荐+依据):功能边界怎么切、新增/变更接口契约
    (形态/字段/错误语义三要素齐全,错误语义禁空)、依赖方向与交付顺序;
  ⑤ **逐仓反向核查**:只看该仓职责+契约能独立开发吗?答不上回④补问。**引用自验**:所引文件/符号
    逐条实测存在。落盘 docs/chain/CHAIN-<单号>.md,结构按 `template chain` 输出的模板
    (七章,hook 硬校验)。展示时引导用户重点抽查触点清单与契约错误语义(历史错误高发区),确认后定稿;
  ⑥ 输出各仓启动卡(仓路径、启动话术「交付 <单号>,需求文档=<CHAIN 文档绝对路径>」、建议 workflow、
    并行说明)。此后各仓平等地独立跑交付(同单号,需求文档=CHAIN 文档+原需求)。

- **cancel / task cancel** — 仅取消当前独立任务:`action cancel`。
- **help** — 读插件根 README.md,输出 30 秒上手(发起交付/确认点拍板/最后建 MR)+ 常见问题标题清单 +
  README 路径;后续追问以 README 为准。不 init。
- **envcheck / doctor** — 只诊断不安装。CodeCheck 缺失只提示"首次使用时会尽力安装",
  不把插件判成不可用;禁止引导 setup/迁移/reload/全局初始化。

进入流程后的**第一条回复**末尾附一句:「新手可随时敲 /mae-flow:mae-flow help 查看使用指南」(全程仅此一次)。
