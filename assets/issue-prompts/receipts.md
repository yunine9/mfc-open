<!--
工具回执与门禁拒绝文案(ADR-0016):平台工具调用的返回人话(模型可见)。
锚点命名 <工具>.<情形>,锚点是代码协议。{{var}} 由代码注入。
数据拼装段(文件清单/失败项明细/流水线描述)由代码算好经变量传入。
-->

## gate.turn_card_pending

本回合已举起一张卡在等用户作答——这不是出错,是流程:举卡即收口,本回合不要再调任何平台工具,请立即结束本回合等待。用户作答(或补配/拒绝)后平台会开新回合继续;期间可读文件、整理结论,但不要推进流程

## gate.stage_closed

阶段门禁:{{tool}} 在当前阶段「{{stage}}」不开放。允许的阶段:{{allowed}}。固定流程按阶段出口推进,请先完成本阶段工作

## pull.guide.prep

拉仓指引——
{{stage_brief}}

## dts.briefing

单据详情已获取——通读单据后调 complete_stage 申报完成(材料到位不会自动推进)。

## env.hard_declined

用户已确认无需此操作({{scope}}),请基于现有证据继续;确有必要可在结论中说明证据局限,不要再次请求环境

## repo.not_registered

会话没有登记这个代码仓: {{wanted}}。已登记: {{registered}}

## remove.bound_module

「{{url}}」是业务模块「{{module}}」的绑定仓,模块绑定仓不可移除——如该仓确与本问题无关,请用户调整模块绑定后再试

## remove.remote_unreachable

远端状态查不到({{url}}),无法安全判定删除条件——请稍后重试;持续失败时请检查网络或 Git 令牌配置,不要跳过门禁强行移除

## remove.remote_branch_left

远端同名修复分支 {{branch}} 还在({{url}} @ {{tip}}),不可移除——请用户先在代码平台删除远端分支,再移除该仓

## push.no_ticket

单号门禁:会话尚未绑定 DTS 单号。请用户在页面「绑定单号」后重试——推送与提 MR 都必须先绑定单号

## push.branch_mismatch

分支名不符合交付规则: 应为 {{expected}},实际 {{branch}}。修复分支名由平台生成并全程固定(基线_工号_单号_时间戳),以 pull_repo 回执为准;不确定时省略 branch 参数,直接推送当前分支

## push.dirty

工作区有未提交改动,push 只推送已提交的历史——现在推只会推出旧提交(MR 将没有 diff)。先提交再重推:只 add 本次范围的文件(local-logs/ 等过程产物留在工作区),提交格式含类型槽——
  git add <本次范围的文件> && git commit -m "[{{ticket}}][fix] <改动说明>"
未提交的文件({{count}} 条):
{{files}}

## push.busy

一次只推一个仓:已有 push_branch 在途,等它返回后再推下一个仓。多仓交付是串行节奏——逐仓「推送→下一仓」,不要在同一回合并发调用多个 push_branch

## push.sync_conflict

推送前宿主把基线 {{baseline}} 的新提交合并进修复分支,撞上真实代码冲突,本次未推送。逐个处理冲突文件:读冲突双方的实现与提交历史,保留双方必要改动;普通代码冲突自行解决,不要无脑选 ours/theirs;业务意图矛盾且证据不足时,向用户说明取舍再继续。解决一个收口一个:
  git add <冲突文件> && git commit
(不带 -m,直接落宿主准备好的合并提交信息)全部解决后再调 push_branch 重推。冲突文件({{count}} 条):
{{files}}

## push.absorb_conflict

推送前宿主把修复分支远端的新提交(用户或同事手改后推回的外部提交)合并进工作区,撞上真实代码冲突,本次未推送;冲突现场已还原,工作区没有半截合并状态。外部提交是用户手改,不许回滚、不许用 ours/theirs 一选了事。请自己完成这场合并后再重推:
  git merge origin/{{branch}}
逐个处理冲突文件:读冲突双方的实现与提交历史,保留双方必要改动;普通代码冲突自行解决;业务意图矛盾且证据不足时,向用户说明取舍再继续。解决后 git add 并 commit(提交格式含类型槽):
  git add <冲突文件> && git commit -m "[{{ticket}}][fix] <合并说明>"
全部解决并提交后再调 push_branch 重推。冲突文件({{count}} 条):
{{files}}

## push.absorb_blocked

推送被拒绝:{{finding}} 远端修复分支的历史与本会话的推送账对不上,意味着有平台不知道的外部提交,用户意图只能由人判断——平台绝不自动处理、绝不强制覆盖。请停止推送操作,不要重试、不要带 force 重推;把上述情况如实转告用户,等人工核对远端分支后再决定下一步。

## push.absorb_failed

推送前外部提交检查失败,本次未推送:{{reason}}
现场已还原(无半截合并状态);检查工作区后重试推送,仍失败时向用户说明并停止

## sync.no_ticket

单号门禁:会话尚未绑定 DTS 单号,没有可同步的修复分支。请用户在页面「绑定单号」后重试

## sync.busy

一次只做一件事:已有 push_branch 或 sync_branch 在途,等它返回后再调——同步与推送都改同一个工作区,并发第二个会被打回

## sync.current

远端修复分支 {{branch}} 没有要并入的东西(远端头没动,或已被当前工作区包含),无需同步。按当前代码继续工作即可

## sync.merged

已把修复分支 {{branch}} 远端的新提交(用户或同事手改后推回的外部提交)合并进工作区:并入 {{count}} 条外部提交({{from}} → {{to}})。外部提交是用户手改,不许回滚。基于合并后的最新代码继续工作;本工具只同步不推送,要交付仍用 push_branch

## sync.conflict

同步修复分支远端的新提交(用户或同事手改后推回的外部提交)撞上真实代码冲突,本次未合并;冲突现场已还原,工作区没有半截合并状态。外部提交是用户手改,不许回滚、不许用 ours/theirs 一选了事。请自己完成这场合并:
  git merge origin/{{branch}}
逐个处理冲突文件:读冲突双方的实现与提交历史,保留双方必要改动;普通代码冲突自行解决;业务意图矛盾且证据不足时,向用户说明取舍再继续。解决后 git add 并 commit(提交格式含类型槽):
  git add <冲突文件> && git commit -m "[{{ticket}}][fix] <合并说明>"
全部解决并提交后再调 sync_branch 确认,然后照常 push_branch 推送。冲突文件({{count}} 条):
{{files}}

## sync.blocked

同步被拒绝:{{finding}} 远端修复分支的历史与本会话的推送账对不上,意味着有平台不知道的外部提交,用户意图只能由人判断——平台绝不自动处理、绝不强制覆盖。请停止同步,不要重试、不要带 force 推送;把上述情况如实转告用户,等人工核对远端分支后再决定下一步

## sync.dirty

工作区有未提交改动,机械合并会把半成品卷进合并,本次未同步。先收尾工作区再重新调 sync_branch:本次要交付的改动提交掉——
  git add <本次范围的文件> && git commit -m "[{{ticket}}][fix] <改动说明>"
不属本次范围又碍事的改动,核对后自行暂存(stash)。未提交的文件({{count}} 条):
{{files}}

## sync.unavailable

远端探针或取回失败,本次未同步:{{reason}}
稍后重试;持续失败时检查网络或 Git 令牌配置,不要在未同步的状态下猜测远端内容

## sync.failed

分支同步失败:{{reason}}
现场已还原(无半截合并状态);检查工作区后重试,仍失败时向用户说明并停止

## push.force_external

强制覆盖被拒绝:远端修复分支的当前提交 {{tip}} 不是本会话推送过的——那是有平台不知道的外部提交(用户或同事手改后推回),平台不盲盖。不要自行重试。把远端分支现状转告用户,由人工核对后二选一:
- 远端手改要保留、要在最新代码上继续修:调 sync_branch 把远端并入工作区(外部提交是用户手改,不许回滚),解决冲突提交后正常推送;
- 用户核对远端分支后确认可以覆盖(远端内容可丢弃):带 force=true 与 override_external=true 重推。

## push.force_unreachable

强制覆盖被拒绝:远端状态查不到,平台无法核对远端分支有没有外部提交,不盲盖。不要自行重试。把情况转告用户;网络恢复后可重试,仍失败时请用户人工核对远端分支,确认可以覆盖后再带 force=true 与 override_external=true 重推。

## push.sync_failed

推送前基线同步失败,本次未推送:{{reason}}
现场已还原(无半截合并状态);检查工作区后重试推送,仍失败时向用户说明并停止

## raisegate.gate_pending

已有一张平台闸在等用户作答——先等闸裁决,裁决后会开新回合;届时若仍需要用户拍板,再判断是否举卡。不要叠加举卡。

## raisegate.card_pending

已有一张问题卡在等用户作答——先等作答结果再继续,不要叠加举卡。

## raisegate.bad_kind

不支持的卡种:{{kind}}。只允许 env_verify(环境验证)/ pipeline_unfixable(红灯人工处理)/ pipeline_evidence(报错原文回灌)。

## raisegate.env_verify_premature

「提交 MR·跑绿」阶段还没收口(申报是出口的一半)——先调 complete_stage 申报 MR 清单,平台验绿收口后再举这张卡。

## raisegate.repo_required

举流水线人工卡必须带 repo(红灯所属仓,会话仓清单内的地址)。

## raisegate.no_red_fact

「{{repo}}」没有在案的红灯事实——人工卡要凭平台的失败记录举,不要凭印象。先确认该仓流水线确实红灯(平台通知,或重推后查状态),再举卡。

## mr.no_ticket

单号门禁:会话尚未绑定 DTS 单号,不能创建 MR。请用户在页面「绑定单号」后重试

## mr.no_push

仓 {{repo}} 还没有推送记录:请先对该仓调用 push_branch,再创建 MR(一仓一 MR,改过的仓各自交付)

## mr.verify_missing_push

仓 {{repo}} 的 MR 缺推送记录,无法验绿:先对该仓 push_branch,再 create_mr,然后重新申报

## mr.title_missing

拿不到问题单 {{ticket}} 的权威标题({{reason}}),MR 没有创建——CodeHub 要求 MR 标题与问题单标题精确相等,平台不用别的字符串顶替。请稍后重试;仍失败就用 AskUserQuestion 告知用户

## mr.receipt.fixed

平台已启动流水线监看:请结束本回合,等待流水线结果(红了平台会带回失败项让你修)。

## analysis.no_report

分析报告还没写:先把结论版写到工作区根目录 issue-analysis.md(章节模板见技能 issue-analysis)再提交。

## analysis.missing_sections

分析报告缺必备章节:{{missing}}。按技能 issue-analysis 的模板补齐再提交(轻量路径内容可简、要素不缺)。

## analysis.submitted.no_ticket

分析报告已提交,平台已把确认卡转给用户。请结束本回合等待作答(用户将决定挂起等提单还是闭环归档)。

## analysis.submitted.ticket

分析报告已提交,平台已把确认卡转给用户。请结束本回合,等用户确认后进入问题修复。

## review.unknown_ref

检视意见 {{reference}} 不在可引用意见里。可引用:
{{known}}
完整原文见工作区 reviews/review-notes.md;按「意见N」或台账 id 引用,不要凭空编号

## review.unknown_seq

意见{{seq}} 不在本批待分诊意见里。本批:
{{known}}
完整原文见工作区 reviews/review-notes.md;按「意见N」引用,不要凭空编号

## ut.recorded

UT 结果已记录(第 {{round}} 轮:通过)。report_ut 只记录结果、不推进阶段——自检与测试可接受就调 complete_stage 申报完成,进入「提交 MR·跑绿」。

## ut.failed

UT 未通过已记录(第 {{round}} 轮)——继续留在问题修复阶段:修复后重跑重报;测试结果可接受后调 complete_stage 申报完成。

## mrgate.mismatch

MR 清单与实际不符,不能通过:{{details}}
清单要和实际对得上:对每个改过的仓 push_branch + create_mr,然后把全部 MR(链接或仓地址)重新申报,一个都不能少、不能编。

## mrgate.empty_ok

MR 清单核验通过(没有改动、无需 MR),「提交 MR·跑绿」阶段已收口。收口不等于流程完成——还差环境验证这一步:请立即调 raise_gate 工具(kind=env_verify)把环境验证卡交给用户,然后结束本回合等待用户验证(用户可不答——MR 全部合入即视为验证通过,发现问题才需要在卡上作答),不要自行继续。

## mrgate.all_green

MR 核验通过({{repos}}):全部 MR 流水线跑绿,「提交 MR·跑绿」阶段已收口。收口不等于流程完成——还差环境验证这一步:请立即调 raise_gate 工具(kind=env_verify)把环境验证卡交给用户,然后结束本回合等待用户验证(用户可不答——MR 全部合入即视为验证通过,发现问题才需要在卡上作答),不要自行继续。

## mrgate.red

MR 核验不通过:有流水线未跑绿,还不能申报完成。
{{details}}
处置:修复后同分支 push_branch(已有 MR 自动跟新提交,平台按新提交重新监看),再调 complete_stage 重新申报。

## mrgate.awaiting

MR 清单已受理({{repos}})——流水线还在跑或暂无记录。全绿后平台自动完成收尾并通知用户,有红平台会把失败项带回;可结束本回合等结果。

## mrgate.awaiting_head_moved

MR 清单已受理({{repos}}),但{{head_repos}}分支的最新提交已变为 {{sha}}——验绿按分支最新提交来,旧提交的绿灯作不了数。平台会自动把检查目标切到新提交并等它的流水线结果,全绿后自动收口,有红会把失败项带回;若新提交不是本会话推的,先拉取分支最新代码、看清差异再决定要不要跟进。

## complete.stage_closed

阶段完成,平台推进到下一阶段——
{{stage_brief}}
