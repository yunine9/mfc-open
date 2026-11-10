月光模式先判断当前 Git 现场，禁止执行 AskUserQuestion，也禁止伪造 ack/goto：
- 当前在基线 HEAD、尚无既有工作：按下方普通路径创建约定分支；
- 当前非基线分支已经带有提交：不要先 checkout、merge、cherry-pick 或 reset，直接执行 done。
  harness 会优先按“启动原话明确要求沿用当前分支”判定；否则只在 `.mae-flow.json.last`
  同单号、同分支且旧 HEAD 是当前 HEAD 祖先时自动沿用。满足时会写入绑定当前 HEAD/基线/来源摘要的裁决收据；
  归属不明或不包含当前基线时会自动登记硬阻塞并停在本步，留待早晨处理。

确保从基线切出:当前不在 {基线分支} 则先 git checkout {基线分支};然后 git checkout -b {分支名}。
分支已存在时可直接 checkout，但 done 会核对其 HEAD 仍等于当前基线 HEAD；若已带入其他提交，
不要 reset/cherry-pick 偷迁移，先展示当前分支、约定分支及提交差异，用 AskUserQuestion 让用户二选一：
- 迁移到约定分支：按用户决定执行安全迁移，再回本步核对；
- 在现有分支上继续：仅适用于当前是非基线分支且包含当前基线 HEAD。用户选择后执行
  先执行 `python "{MAEFLOW_PATH}" messages` 取得本步骤真实用户消息 ID，再执行
  `python "{MAEFLOW_PATH}" goto branch_create --force --message-id "<消息ID>"`。
  该同步命令会把真实选择登记为本单分支并绑定当时 HEAD，随后再执行 done；禁止继续 goto 下一关绕过分支状态。
若现有分支不包含当前基线，先同步/迁移后重新裁决，不能把无关历史直接带入本单。
正常创建路径的分支名已在配置中,禁止重复询问；只有上述“现有分支已带工作”冲突才需要一次裁决。
Comet/Superpowers 内部流程若建议其他命名(feature/日期/描述 等)一律拒绝;
发现已在错误命名分支:git branch -m <错误名> {分支名} 纠正。
