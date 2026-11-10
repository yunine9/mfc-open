# Mae-Flow 干净环境验证

目标：把旧组件全部卸掉，只保留当前安装的 Mae-Flow，确认它没有偷偷依赖机器上的全局组件。

## 1. 卸载旧组件

在 CodeAgent 插件管理中卸载：

- 旧 `comet-mae`；
- 独立安装的 Comet、OpenSpec、Superpowers、Ponytail；
- 旧版 Mae-Flow。

保留或重新安装：

- 当前准备验证的 Mae-Flow；
- 内网版随包提供的 build-fix、AutoUT、java-autout；
- `@example/codecheckcli`（CodeCheck，可不卸载）。

如果 OpenSpec、Comet 以前通过 npm 全局安装，再执行：

```powershell
npm uninstall -g @fission-ai/openspec @rpamis/comet
where.exe openspec
where.exe comet
```

最后两条应提示找不到。不要删除业务仓中的 `openspec/`、change 目录、`.comet.yaml` 或正在运行的
`.mae-flow.json`；干净验证请直接使用新建的临时 Git 仓库。

卸载和安装插件后，关闭旧会话，重新打开 CodeAgent。

## 2. 验证未启用时不接管

进入一个从未运行 Mae-Flow 的普通仓库，让 Agent 修改一行源码并执行一条命令，必须正常放行。

```powershell
Get-Content "$env:TEMP\mae-flow-hook.log" -Tail 50
```

日志应出现 `inactive: bypass`。仅安装插件就拦截普通开发，立即停止测试并反馈。

## 3. 验证内嵌运行时

在 CodeAgent 中发送：

```text
执行 mae-flow envcheck
```

预期：

- Python、Git、Git Bash 均为 ✅（必需项），并显示实际版本和绝对路径；Node.js 在可选项，
  缺失不判失败（v4 起规格引擎纯 Python 内化，Node 仅开发期差分对拍用）；
- 「内置规格引擎」和全部阶段能力均为 ✅（无 OpenSpec/Comet 版本行）；
- 路径位于当前 Mae-Flow 插件缓存目录的 `runtime\vendor\`；
- comet、openspec、superpowers、ponytail 四个 SHA-256 全部通过；
- 不要求 setup、reload 或 `comet init`。

临时移除任一**必需**基础命令（Python/Git/Git Bash）的 PATH 后再尝试初始化，应在 `.mae-flow.json`
创建前明确报出缺失项（移除 Node 不得失败）；恢复环境后可以直接重试，普通 Edit/Bash 在此期间仍应放行。

## 4. 做一次最小实跑

在临时 Git 仓库中发送一句小需求并启动 `/mae-flow:mae-flow`。初始化后应直接进入配置确认，只生成
`openspec/config.yaml` 和 Mae-Flow 状态（v4 后不再有 `.comet/` 目录），不得创建
`.cac/.claude/.cursor/.windsurf`。

再分别试一次：

```text
/mae-flow:mae-flow codecheck
/mae-flow:mae-flow ut
```

CodeCheck 和 UT 都必须先展示文件范围、等待二次确认；CodeCheck 只检查业务代码，UT 必须真实调用内网
AutoUT/java-autout 并运行测试。任一子 Agent 令牌异常时应提供风险出口，不能无限重跑。

最后在流程中途发送 `/mae-flow:mae-flow exit`，退出后普通源码修改必须立即放行。以上全部通过，才说明干净环境验证完成。
