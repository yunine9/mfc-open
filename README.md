# mae-flow-cloud

Mae-Flow 的云端宿主与多人协作工作台。

单机 Coding Agent 只能处理终端里的交互式改码，解决不了多人协作、跨仓拆单、权限隔离与交付验收。mae-flow-cloud 将 pi-mono 进程内嵌入服务层，配合流程内核与受限容器，解决 Agent 进入团队研发后的状态恢复、安全执行、人机交接与结果核验问题。

本仓是脱敏后的代码快照，不含内部部署文档、内部配置与运维工具。`kernel/` 是 Mae-Flow 内核快照，来源与版本见 `kernel/VENDORED`。

## 核心设计

### 内核管事实，人与流水线管质量
内核只负责状态恢复、权限边界和真实执行事实，不用文档模板或提交格式卡开发进度。Agent 的自述不构成完成证据；交付只认绑定当前 SHA 的远端流水线结果、经提出人确认的检视回执，以及 MR 的真实合入状态。

### 控制面与执行面分离
Pi SDK 同进程运行在 Node 服务内：工具拦截是同步钩子，人工审批是未决 Promise，子 Agent 是同进程新会话，不走跨进程 RPC 桥接。Git 凭据、MR 操作与状态账本留在宿主；Agent 的所有命令执行一律进降权、只读根的任务容器，等待人工审批期间自动释放容器资源。

### 按问题范式分流
不拿同一套状态机套所有工作。需求交付走“全局设计 → 跨仓/模块拆单 → 持续检视”的收敛流，直至 MR 合入；现网排障（issueFlow）走无固定流向的动态研究，与需求内核解耦，可独立起服；知识问答限定在已发布文档的行级原文引用，日常评审与构建修复则沉淀为按需推送的经验线索，不冒充硬规则。

### 单一真相源
同一业务规则只留一处实现（正从 Python/TS 双仓向 Cloud 单一运行时收敛）。跨语言边界以 transcript JSONL 为唯一证据契约；前端不做任何状态推断，状态文案与操作权限全部由服务端计算下发。

### 脱离外部服务可自证
模型网关、Git 平台、CI 流水线与 IM 通知均内置同契约本地假件。不连外部服务即可在单机跑通跨仓拆单、红灯修复、进程强杀恢复等完整回归。

## 目录结构

```
src/
  serve.ts / server.ts    服务入口与 HTTP/SSE 接口
  taskService.ts          需求编排、并发调度、持续检视与合入监控
  sessionDriver.ts        Pi 进程内会话驱动（拦截、挂起、子会话、上下文恢复）
  kernelHost.ts           内核宿主适配与安全门禁（gateService / humanGate）
  containerRuntime.ts     任务容器隔离、生命周期与进程组超时控制
  issueFlow/              独立问题排查引擎
  memorySidecar.ts        任务记忆与文档检索旁路
web/                      工作台前端
kernel/                   Mae-Flow 内核快照
harness/                  证据链裁判（verify_transcript.py）与演练脚本
tests/                    不变式单测、决策表与端到端回归
```

## 运行与验证

日常开发与全链路测试不依赖真实模型或外部环境：

```bash
npm install
npm test            # 快层测试：核心不变式 + API 端到端
npm run test:full   # 全量门禁测试
npm run probe       # 整链演练：进程内 Pi + 剧本假模型 + 内核证据验收
npm run serve       # 本地演示服务 (http://127.0.0.1:8787, admin / mae-flow-demo)
npm run ui:preview  # 前端标准场景预览 (http://127.0.0.1:8838)
```

生产环境首次启动需注入管理员初始密码，并开启内核模式与隔离镜像：

```bash
MAE_FLOW_ADMIN_USER=admin \
MAE_FLOW_ADMIN_PASSWORD='your-initial-password' \
npm run serve -- \
  --kernel-mode \
  --isolate-image mae-flow-task-builder:latest \
  --models /etc/mae-flow-cloud/models.json
```
