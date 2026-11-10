# 文稿默认目录

directory-v1 的领域目录默认使用 `Function_Knowledge/Access Function/<模块名>`，可在模块编辑中修改仓内路径；领域知识仓及正式分支由平台统一提供。代码仓目录默认 `docs/<业务名称>`。模型使用任务返回的最终 target.docs_path，不自行拼接业务名称。下面 JSON 保留旧方法读取器所需的目录基准，只用于未绑定模块目录的旧任务，不覆盖模块保存的路径。

```json
{"domain_directory":"docs","repository_directory":"docs"}
```

路径映射、避让、平台生成的 AGENTS.md 和旧批次重试见 [规划与路径](platform-execution.md#规划与路径)。
