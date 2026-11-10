> 通过 step.instructions 与 knowledge_work 读取本步骤的范围、问题和已有结果；中间内容保存到 knowledge_work_result.data，最终文档通过 knowledge_draft 保存。下面的 knowledge/ 和 repos/ 是相对平台归档目标的文档组织，不是本机目录。工具参数见 [平台工具接口](platform-pipeline.md)。

# 跨模块规划：识别模块之间的链路和跨仓契约

所有模块都已完成。现在处理单看任何一个模块都看不到的东西。

## 输入

- 各模块的 `knowledge/chains/<模块>/README.md` 与 `interactions.md`。
- 盘点步骤 data.modules 中的 depends_on。
- knowledge_structure 返回的依赖候选，以及源码中确认的跨模块关系。
- 各步骤 data.questions 中涉及多个模块的问题。

## 要识别的两类对象

**跨模块链路（chains）**：一个模块的动作触发或影响另一个模块的业务流程。例如：邻区关系变化后，负载均衡和移动性优化如何感知并调整；某个优化结果如何影响另一个优化的输入。判断标准是有真实的因果或数据依赖，并且在代码中可以找到证据（调用、消息、共享数据、通知机制）。

**跨仓契约（contracts）**：跨仓的接口或消息，其**语义约束**无法从定义本身看出。例如：字段取值的业务含义、调用顺序要求、兼容性规则、失败时双方的约定。仅仅是"存在一个接口"不值得写，要有语义约束才写。

## 产出：knowledge_work_result.data

```json
{
  "chains": [
    {
      "id": "anr-to-mlb-mro",
      "title": "邻区关系变化对负载均衡与移动性优化的影响",
      "modules": ["anr", "mlb", "mro"],
      "questions": ["邻区删除后，MLB 正在进行中的负载迁移如何处理？", "……"],
      "related_code": ["backend:src/son/anr/notify/**", "backend:src/son/mlb/**"]
    }
  ],
  "contracts": [
    {
      "id": "backend-southbound-param-msg",
      "title": "后台到南向的参数下发消息",
      "repos": ["backend", "southbound"],
      "questions": ["……"],
      "related_code": ["backend:src/msg/ParamSetReq.h", "southbound:src/adapter/common/**"]
    }
  ],
  "notes": "……"
}
```

`id` 只能用小写字母、数字、连字符。步骤说明给出 max_items 时遵循该上限；未给出则按实际关系安排。按价值排序，靠前的优先。没有找到任何一类时，对应列表为空即可。
