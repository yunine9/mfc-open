夜间无人值守执行已经结束，分支已推送；本步骤不自动归档，也不继续修改代码。

执行 `python "{MAEFLOW_PATH}" moonlight report` 查看完成内容、自动决策和遗留问题。
报告中同时核对整体实现、强制编译、CodeCheck、UT 和可选 CODE Reviewer 记录；
“人工裁决”项必须作为遗留展示，不能写成已自动确认。

- 需要继续修复：执行 `python "{MAEFLOW_PATH}" moonlight repair`。状态机会回到本工作流的编译入口，
  先按报告修复，再重新经过编译、CodeCheck、UT、最终验证和推送。
- 结果满意、准备收尾：执行 `python "{MAEFLOW_PATH}" moonlight finalize`。
  full/hotfix/tweak 会恢复普通模式并进入规格定稿；review 直接结束。
- 暂时不处理：保持当前状态即可，代码和报告都不会丢失。

禁止直接执行 done 绕过晨间处理入口。
