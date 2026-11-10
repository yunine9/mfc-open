{{#LOCAL_PUSH}}
git push -u origin HEAD。若远端领先，先 git fetch 并展示本地/远端分叉，让用户决定如何处理；
禁止自动 pull --rebase、reset 或 force-push，避免改写已经检视过的代码。认证/网络失败时有限重试，
仍失败则保留本地 commit 并展示原始报错。
展示:分支名、git log {基线分支}..HEAD --oneline 提交清单;
提示用户在代码平台用该分支创建 MR,流水线与合入由用户跟进。
done 证据校验:本地 HEAD 与远端上游一致(未推成谎报无效)。done 后流程结束。
{{/LOCAL_PUSH}}
{{#HOST_PUSH}}
不要读取、索取或使用个人 Git Token，也不要执行 git push。先确认交付候选均已提交、
工作区没有遗漏的源码/测试/构建改动，然后直接执行 done。内核会冻结当前 HEAD 并登记
“等待 Cloud 推送”；Cloud 在本会话释放后使用用户凭据完成 push/MR，再以该 SHA 触发并核销流水线。
{{/HOST_PUSH}}
