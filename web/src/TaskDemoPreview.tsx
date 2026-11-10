import phaseCatalogText from "../../kernel/flow/phases.json?raw";
import TaskDemoWorkspace from "./TaskDemoWorkspace";
import TaskDemoDeliveryPreview from "./TaskDemoDeliveryPreview";
import type { ArtifactMeta, AuthUser, ConversationItem, TaskKnowledgeResource, TaskKnowledgeUsage, TaskSummary } from "./api";
import type { TaskDemoArchitectureFixture, TaskDemoPreviewInput, TaskDemoSnapshot } from "./taskDemoTypes";

/** 仅用于 DEV 预览的示例数据；阶段顺序取自内核，生产演示使用任务快照。 */
const phaseCatalog = JSON.parse(phaseCatalogText) as {
  phases: Array<{ name: string; steps: string[] }>;
  placeholders: { analysis: string };
};
const sourceId = "demo-preview-source";
const basePath = `/tasks/${sourceId}`;
const createdAt = "2026-10-22T01:00:00.000Z";
const updatedAt = "2026-10-22T01:35:00.000Z";

const documents: ReadonlyMap<string, string> = new Map([
  ["task-materials/整体拆分方案.md", `# 示例材料 · 订单取消库存释放的任务拆分

> 以下交付单元、人员和依赖均为演示样例，没有创建真实开发任务。

## 按交付范围拆分

| 交付单元 | 负责内容 | 前置条件 |
| --- | --- | --- |
| 订单取消事件 | 取消事务保存事件，支持发送与重试 | 无，可先行 |
| 库存幂等释放 | 按预占编号释放，处理重复通知 | 无，可先行 |
| 联调验收 | 联通订单与库存，验证正常、重复和失败场景 | 前两个单元完成 |

订单取消事件与库存幂等释放可以并行开发，两边先约定事件字段和预占编号。
联调验收依赖前两个单元，不能仅凭某一边完成就启动最终验收。

## 需要开发和需求 owner 确认

- 三个交付范围是否完整，是否遗漏监控和失败处理。
- 接口约定能否支撑并行开发，人员分工是否合适。
- 联调验收的前置依赖是否合理。

## 示例决定

按这三个交付单元推进，先并行完成订单和库存，再联调验收。
此决定仅用于展示拆分、依赖与协作，不代表真实执行结果。
`],
  ["DEMO-001/grill.md", `# 示例材料 · 取消订单后释放库存

> 以下需求、代码路径和讨论均为演示样例，不代表真实任务结果。

## Agent 查到的现状

订单取消后会更新订单状态，库存预占记录目前需要定时任务释放。
现有库存接口支持按预占记录编号释放，订单侧已有事件发布能力。

## 需要需求 owner 确认

**问题：已支付订单进入退款流程时，是否也在本次范围内？**

Agent 建议：这次只处理未支付订单取消；已支付订单沿用现有退款流程。
影响：减少本次改动范围，同时避免库存先释放、退款却失败的不一致。

**示例决定：同意，只处理未支付订单；用户主动取消和超时取消都需要覆盖。**

## 后续需要保留的约束

- 重复取消只释放一次库存。
- 释放失败需要重试，不能静默丢失。
- 本次不调整已支付订单的退款行为。
`],
  ["DEMO-001/spec.md", `# 示例材料 · 取消订单库存释放规格文档

> 以下验收条件用于演示批注与确认，不是生产验收结果。

## 目标与范围

未支付订单取消后，释放对应的预占库存。
用户主动取消、系统超时取消采用同一套处理规则。
已支付订单和退款流程不在本次范围内。

## BEH-01 正常取消

未支付订单取消成功后，对应的库存预占记录被释放。
订单取消结果不等待库存服务同步返回，释放失败由后台重试。

## BEH-02 重复通知

同一订单的取消通知重复到达时，库存只释放一次。

## BEH-03 失败处理

库存服务暂时不可用时，保留失败记录并重试；超过重试预算后显示待处理原因。

## 验收场景

| 场景 | 预期结果 |
| --- | --- |
| 用户取消未支付订单 | 订单取消，库存释放一次 |
| 超时取消未支付订单 | 使用相同释放规则 |
| 重复收到取消通知 | 不重复增加可用库存 |
| 库存服务暂时失败 | 保留记录并重试 |
| 已支付订单申请退款 | 沿用原退款流程 |
`],
  ["DEMO-001/story.md", `# 示例材料 · 取消订单库存释放设计

> 本文用于演示设计检视、批注与反馈，不对应实际代码仓。

## 关键方案

订单模块在取消事务中保存待发送事件，后台发送器把事件交给库存模块。
库存模块以预占记录编号执行幂等释放，重复事件不会重复增加可用库存。

## 模块职责

- 订单模块：校验订单状态，完成取消，保存取消事件。
- 事件发送器：发送失败后重试，保留失败原因。
- 库存模块：检查预占记录，释放库存，记录处理结果。

## 需要开发检视的取舍

**采用异步释放，允许取消成功与库存可用之间存在短暂延迟。**

这样可以避免库存服务短暂不可用阻塞订单取消。
需求 owner 需要确认可接受的延迟；开发需要检视重试、监控和运维成本。

## 独立检视发现

首次方案遗漏了重复发送的处理说明，已补充预占记录编号去重。
尚需评估高峰期积压时的处理能力，不能只根据单元测试判断容量。

## 验证安排

覆盖正常取消、重复通知与库存服务异常；容量测试另行安排。
`],
  ["task-materials/交付报告.md", `# 示例材料 · 取消订单库存释放交付报告

> 下列改动、测试与流水线记录均为预览样例，没有执行真实代码或测试。

## 改动点 4+1

原来：取消订单后等待定时任务释放库存 → 现在：取消事务保存事件，库存按预占编号幂等释放。

### 逻辑视图

| 职责 | 改动前 | 改动后 |
| --- | --- | --- |
| 订单取消 | 只更新订单状态 | 同一事务保存待发送事件 |
| 库存释放 | 等待定时扫描 | 收到取消事件后按预占编号释放 |
| 重复通知 | 无消费侧去重入口 | 已释放的预占记录不再重复处理 |

### 开发视图

订单模块负责取消和事件记录；库存模块负责释放与去重。两个模块通过取消事件协作，避免订单事务直接依赖库存服务。

### 进程视图

用户取消 → 订单事务保存取消结果和事件 → 后台发送事件 → 库存按预占编号检查 → 首次释放 / 重复通知返回已有结果。

### 物理视图

样例沿用订单服务、库存服务和现有数据库；没有新增部署节点。真实部署与容量未验证。

### 场景视图（+1）

正常取消后释放；重复通知不重复释放；库存服务短暂失败后重试。对应下面的三个验收场景。

## 关键代码变化（虚构样例）

- 订单取消事务写入待发送事件。
- 库存释放按预占记录编号去重。
- 发送失败保留原因，并在配置的重试预算内重试。

## 测试报告

验证范围：正常取消、重复通知与失败重试。
示例结果：下表展示测试证据的呈现方式，没有执行真实测试。
未确认项：高峰积压下的释放延迟、真实部署和容量。

| 用例编号 / 场景 | 用例级别 | 条件、操作与预期 | 示例代码位置 | 示例结果 | 证据编号 |
| --- | --- | --- | --- | --- | --- |
| TC-01 正常取消 | 模块 UT（MST） | 取消未支付订单，保存事件并释放一次 | tests/cancelOrder.spec.ts | 示例通过 | SAMPLE-01 |
| TC-02 重复通知 | 函数 UT | 同一预占编号通知两次，不重复释放 | tests/releaseStock.spec.ts | 示例通过 | SAMPLE-01 |
| TC-03 失败重试 | 模块 UT（MST） | 模拟库存服务失败，保留事件并重试 | tests/cancelRetry.spec.ts | 示例通过 | SAMPLE-02 |
| TC-04 已支付订单 | 模块 UT（MST） | 申请退款，沿用原有退款行为 | tests/refundOrder.spec.ts | 示例通过 | SAMPLE-02 |

证据索引：SAMPLE-01 / SAMPLE-02 均为虚构记录，只展示报告结构；示例版本为 example-commit，不是有效提交证据。

## 未验证项

高峰积压下的释放延迟尚未验证，需要补充容量测试。
这份报告整理已有记录，不能替代开发检视和业务验收。

## 示例反馈处理

首次流水线提示异常场景断言缺失，Agent 补充后重新验证新提交。
检视意见建议调整重试上限，需求 owner 确认后再修改。

## 待确认的经验

重复投递可能引发重复释放。对于采用至少一次投递的业务事件，应在消费侧结合业务标识设计幂等处理。
此结论有适用前提，需经过开发审查再用于后续相关任务。
`],
]);

const exampleDiff = `diff --git a/src/orders/cancelOrder.ts b/src/orders/cancelOrder.ts
index 1111111..2222222 100644
--- a/src/orders/cancelOrder.ts
+++ b/src/orders/cancelOrder.ts
@@ -1,4 +1,5 @@
 export async function cancelOrder(orderId: string) {
   await orders.cancel(orderId);
+  await outbox.enqueue({ type: "OrderCanceled", orderId });
   return { canceled: true };
 }
`;

const architecture: TaskDemoArchitectureFixture = {
  projection: {
    renderer: "demo", warnings: ["虚构架构示例，用于演示设计图与节点职责。"],
    views: [{ id: "logical", label: "逻辑视图", status: "已完成", reason: "演示样例：订单取消、事件发送、库存释放和失败重试。" }],
    diagrams: [{ id: "demo-overview", title: "示例 · 订单取消与库存释放", type: "architecture", view: "logical", nodes: [
      { id: "order", name: "订单取消", summary: "取消结果与事件同一事务保存", responsibility: "校验未支付订单状态，更新取消结果，同时写入待发送事件。", interfaces: "输入：订单编号；输出：取消结果和取消事件。", relationships: ["订单取消 → 待发送事件：同一事务保存"], acceptance: "TC-01：取消成功后不丢失释放库存的事件。" },
      { id: "event", name: "待发送事件", summary: "异步发送，保留处理状态", responsibility: "读取未发送事件，向库存服务投递；记录成功或失败，避免取消请求等待库存服务。", interfaces: "输入：取消事件；输出：订单编号、预占编号。", relationships: ["待发送事件 → 库存释放：异步投递", "待发送事件 → 失败重试：保留失败记录"] },
      { id: "stock", name: "库存释放", summary: "按预占编号幂等处理", responsibility: "检查预占记录，首次通知执行释放；重复通知返回已有处理结果。", interfaces: "输入：预占编号；输出：释放结果。", relationships: ["待发送事件 → 库存释放：释放预占库存"], acceptance: "TC-02：相同预占编号通知两次，只释放一次。" },
      { id: "retry", name: "失败重试", summary: "异常保留原因，按预算重试", responsibility: "库存服务暂时不可用时保留事件与失败原因；按重试预算重新发送，超过预算后交给开发处理。", interfaces: "输入：失败事件与次数；输出：重发或待处理记录。", relationships: ["失败重试 → 待发送事件：重新发送"], acceptance: "TC-03：失败不能静默丢失。" },
    ] }],
  },
  diagram: { html: `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#183149;font-family:system-ui,"Microsoft YaHei",sans-serif}header{padding:22px 28px 4px;font-size:15px;color:#64748b}svg{display:block;width:100%;height:auto}text{font-family:inherit}g[role=button]{cursor:pointer;outline:none}g[role=button]:hover rect,g[role=button]:focus rect{stroke:#f97316;stroke-width:3}.label{font-size:21px;font-weight:650;fill:#163047}.detail{font-size:15px;fill:#596b7d}.edge{font-size:14px;fill:#596b7d}.arrow{fill:none;stroke:#7e90a3;stroke-width:2.5;marker-end:url(#arrow)}
</style></head><body><header>示例架构 · 点击节点查看职责</header><svg viewBox="0 0 1000 480" role="img" aria-label="订单取消保存事件，异步释放库存，失败后重试">
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#7e90a3"/></marker></defs>
<path class="arrow" d="M290 150H375"/><text class="edge" x="333" y="126" text-anchor="middle">同事务保存</text>
<path class="arrow" d="M625 150H710"/><text class="edge" x="668" y="126" text-anchor="middle">异步投递</text>
<path class="arrow" d="M540 200V315"/><text class="edge" x="553" y="265">发送失败</text>
<path class="arrow" d="M430 315V200"/><text class="edge" x="418" y="265" text-anchor="end">按预算重试</text>
<g role="button" tabindex="0" data-node-id="order"><rect x="40" y="100" width="250" height="100" rx="16" fill="#e7f1ff" stroke="#a8c7ea"/><text class="label" x="165" y="143" text-anchor="middle">订单取消</text><text class="detail" x="165" y="174" text-anchor="middle">校验状态，保存取消结果</text></g>
<g role="button" tabindex="0" data-node-id="event"><rect x="375" y="100" width="250" height="100" rx="16" fill="#e9f7f1" stroke="#acd6c4"/><text class="label" x="500" y="143" text-anchor="middle">待发送事件</text><text class="detail" x="500" y="174" text-anchor="middle">持久保存，异步发送</text></g>
<g role="button" tabindex="0" data-node-id="stock"><rect x="710" y="100" width="250" height="100" rx="16" fill="#e7f1ff" stroke="#a8c7ea"/><text class="label" x="835" y="143" text-anchor="middle">库存释放</text><text class="detail" x="835" y="174" text-anchor="middle">按预占编号去重，只释放一次</text></g>
<g role="button" tabindex="0" data-node-id="retry"><rect x="375" y="315" width="250" height="100" rx="16" fill="#fff2df" stroke="#e6c797"/><text class="label" x="500" y="358" text-anchor="middle">失败重试</text><text class="detail" x="500" y="389" text-anchor="middle">保留原因，超限后人工处理</text></g>
</svg></body></html>` },
};

/** 文案描述示例需求的各次操作，不能作为真实阶段完成或验证证据。 */
const examples: Readonly<Record<string, { message: string; question: string }>> = {
  启动: {
    message: "示例记录：已准备订单状态约定、库存预占接口说明，以及团队的测试 Skill。本次目标是未支付订单取消后释放库存，工作流和资料版本随任务保留。",
    question: "示例确认：本次只处理未支付订单取消，是否按这个范围演示？",
  },
  澄清需求: {
    message: "示例记录：现有取消逻辑只改订单状态，库存由定时任务释放。建议先覆盖用户取消和超时取消，已支付订单沿用退款流程。独立检视还提醒了重复通知和失败重试两个场景。",
    question: "示例取舍：是否保持已支付订单原有退款行为？",
  },
  定规格: {
    message: "示例记录：已把 owner 的决定整理为规格文档，补充正常取消、重复通知和库存服务失败三个验收场景。请重点核对：重复通知只能释放一次，释放失败不能静默丢失。",
    question: "示例确认：规格文档中的范围和预期结果是否符合需求？",
  },
  写设计: {
    message: "示例记录：设计采用订单事件驱动库存释放，并按预占记录编号去重。独立检视发现的重复发送遗漏已补充。关键取舍是异步释放会有短暂延迟，请开发检视重试和维护成本。",
    question: "示例取舍：是否接受取消成功后短暂延迟释放库存的方案？",
  },
  写代码: {
    message: "示例记录：编码、编译和单元测试按已确认的方案执行。示例中发现重复通知可能重复释放库存，已按预占记录编号修正，并补充复验记录；业务规则没有变化。",
    question: "示例操作：查看关键代码和验证结果后，是否继续演示交付检视？",
  },
  检视与验证: {
    message: "示例记录：交付报告对比取消订单前后的职责与调用变化，并列出每个验收场景的测试结果和未验证项。首次流水线失败后，已补充异常场景并核对新提交结果。容量测试仍未完成；重试上限的检视建议等待 owner 判断。",
    question: "示例决定：是否采纳重试上限的建议，并补充容量验证？",
  },
  已合入: {
    message: "示例记录：任务示例已合入。根据本次重复通知的修复记录，整理了一条幂等处理经验，附来源和适用范围，等待开发审查；不是自动把一次处理变成通用规则。",
    question: "示例确认：是否将这条有适用范围的经验保留为候选？",
  },
};

function at(index: number, seconds = 0): string {
  return new Date(Date.parse(createdAt) + index * 5 * 60_000 + seconds * 1000).toISOString();
}

/** 虚构消费记录只用于查看演示，不表示这些资料曾由真实 Agent 读取。 */
function exampleKnowledgeUsage(taskId: string, repository: string, child = false): TaskKnowledgeUsage {
  const definitions: Array<Pick<TaskKnowledgeResource, "id" | "kind" | "name" | "path" | "description" | "scope" | "asset_version">> = [
    { id: "example-order-state", kind: "document", name: "示例 · 订单状态约定", scope: "module", asset_version: 3,
      path: ".mae-flow-work/business-modules/demo-order/knowledge/order-state.md",
      description: "【虚构领域知识样例】未支付订单允许主动取消和超时取消，两种入口沿用相同状态校验。已支付订单进入退款流程，本次不得直接改成取消；取消成功后需要释放对应预占库存。" },
    { id: "example-stock-reservation", kind: "document", name: "示例 · 库存预占接口说明", scope: "module", asset_version: 2,
      path: ".mae-flow-work/business-modules/demo-order/knowledge/stock-reservation.md",
      description: "【虚构领域知识样例】库存预占使用预占记录编号作为释放依据。同一编号重复到达时返回已有处理结果，不能重复增加库存；接口失败应保留可重试记录。" },
    { id: "example-team-test", kind: "skill", name: "示例团队测试 Skill", scope: "team", asset_version: 1,
      path: "host-skill-snapshot/example-team-test/SKILL.md",
      description: "【虚构团队 Skill 样例】根据验收场景设计正常、重复通知和失败重试用例。被测业务逻辑使用真实实现，仅替换必要外部依赖；记录实际运行结果和未验证项，不能把未执行用例写成通过。" },
  ];
  const events: TaskKnowledgeUsage["events"] = [];
  const resources: TaskKnowledgeResource[] = definitions.map((definition, index) => {
    const readCount = definition.kind === "skill" ? child ? 1 : 0 : index === 0 ? 2 : 1;
    const resource: TaskKnowledgeResource = { ...definition, repository, selected: true,
      ...(definition.scope === "module" ? { module_id: "demo-order", module_name: "示例订单模块" } : {}),
      state: readCount ? "used" : "loaded", available_count: 1, loaded_count: 1, read_count: readCount,
      first_at: at(0, index + 1), last_at: readCount ? at(definition.kind === "skill" ? 4 : 1, 10 + index + readCount) : at(0, 10 + index),
    };
    const common = { id: resource.id, kind: resource.kind, name: resource.name, path: resource.path,
      repository, selected: true, scope: resource.scope, module_id: resource.module_id,
      module_name: resource.module_name, asset_version: resource.asset_version,
      session_id: `example-knowledge-session-${taskId}`, session_role: "main" as const };
    events.push({ ...common, ts: resource.first_at!, step: "config_confirm", action: "available" },
      { ...common, ts: at(0, 10 + index), step: "config_confirm", action: "loaded" });
    for (let count = 0; count < readCount; count++) {
      events.push({ ...common, ts: at(definition.kind === "skill" ? 4 : 1, 11 + index + count),
        step: definition.kind === "skill" ? "build" : child ? "grill" : "requirement_analysis",
        action: "read", observed_path: resource.path });
    }
    return resource;
  });
  return { summary: { resources: resources.length, loaded: resources.length, used: resources.length,
    skills_used: resources.filter(resource => resource.kind === "skill" && resource.read_count > 0).length,
    selected_unused: resources.filter(resource => resource.kind === "skill" && resource.read_count === 0).length },
    resources, events: events.sort((left, right) => right.ts.localeCompare(left.ts)) };
}

export function createTaskDemoPreviewInput(): TaskDemoPreviewInput {
  const actor: AuthUser = { username: "demo-admin", display_name: "演示管理员", role: "admin", committer: true };
  const owner: AuthUser = { username: "demo-owner", display_name: "示例需求负责人", role: "developer" };
  const reviewer: AuthUser = { username: "demo-reviewer", display_name: "示例检视人", role: "developer", committer: true };
  const phases = phaseCatalog.phases.map(item => item.name);
  const phaseSteps = Object.fromEntries(phaseCatalog.phases.map(item => [item.name, [...item.steps]]));
  phaseSteps[phaseCatalog.placeholders.analysis].push("requirement_analysis");
  const conversation: ConversationItem[] = phaseCatalog.phases.flatMap((phase, index): ConversationItem[] => {
    const example = examples[phase.name] ?? {
      message: `示例记录：${phase.name}阶段预览。`, question: "示例操作：是否继续演示？",
    };
    return [{
      kind: "turn", id: `example-turn-${index}`, ts: at(index), end_ts: at(index, 20),
      texts: [{ ts: at(index), text: example.message, truncated: false, role: "handoff" }],
      steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
      open: false,
    }, {
      kind: "card", id: `example-card-${index}`, ts: at(index, 20),
      waiting_id: `example-waiting-${index}`, step: phase.steps[0],
      purpose: "confirmation", annotation_ids: [],
      questions: [{ question: example.question, options: ["确认，继续演示", "补充意见"] }],
      status: "waiting",
    }];
  });
  const analysisIndex = phases.indexOf(phaseCatalog.placeholders.analysis);
  const decompositionAt = at(analysisIndex, 40);
  conversation.splice((analysisIndex + 1) * 2, 0, {
    kind: "turn", id: "example-turn-decomposition", ts: decompositionAt, end_ts: decompositionAt,
    texts: [{ ts: decompositionAt, text: "示例记录：建议拆成订单取消事件、库存幂等释放、联调验收三个交付单元。前两个单元约定事件字段后可以并行；联调验收依赖两边完成。请开发和需求 owner 确认拆分范围、分工及前置关系。", truncated: false, role: "handoff" }],
    steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] }, open: false,
  }, {
    kind: "card", id: "example-card-decomposition", ts: decompositionAt,
    waiting_id: "example-waiting-decomposition", step: "requirement_analysis",
    purpose: "confirmation", annotation_ids: [],
    questions: [{ question: "示例确认：是否按三个交付单元推进，订单与库存并行，之后联调验收？", options: ["确认并生成任务", "调整拆分"] }], status: "resolved",
  });
  const artifacts: ArtifactMeta[] = [...documents.entries()].map(([name, content]) => ({
    name, label: name.split("/").at(-1)!, kind: "doc",
    ...(name === "DEMO-001/story.md" ? { purpose: "overall_story" as const, story_published: true } : {}),
    bytes: new TextEncoder().encode(content).byteLength, modified_at: updatedAt,
  }));
  artifacts.push({ name: "未提交改动", label: "示例代码改动", kind: "diff", modified_at: updatedAt,
    bytes: new TextEncoder().encode(exampleDiff).byteLength, file_count: 1,
    change_files: [{ path: "src/orders/cancelOrder.ts", stage: "unstaged", additions: 1, deletions: 0 }] });
  const task: TaskSummary = {
    id: sourceId, title: "示例需求 · 订单取消后释放库存", ticket: "DEMO-001",
    requirement: "【演示样例】未支付订单取消后，释放对应的预占库存。覆盖用户主动取消和系统超时取消；重复通知不能重复释放。已支付订单保持原退款流程。本页所有任务、成员、文档和验证记录均为虚构样例。",
    status: "waiting_for_human", status_label: "示例 · 等待方案确认",
    created_at: createdAt, updated_at: updatedAt,
    luban_account: owner.username, collaborators: [reviewer.username], approval_mode: "manual",
    repo_url: "https://example.invalid/demo/order-service.git", repositories: ["https://example.invalid/demo/order-service.git", "https://example.invalid/demo/stock-service.git", "https://example.invalid/demo/acceptance.git"],
    baseline: "main", business_module: { id: "demo-order", name: "示例订单模块" },
    ut_generation_method: "示例团队测试 Skill", push_confirmation: true,
    knowledge_usage: exampleKnowledgeUsage(sourceId, "https://example.invalid/demo/order-service.git"),
    requirement_graph: {
      stage: "confirmed", projection_state: "ready", plan_revision: "example-split-1", source_document: "story.md",
      repositories: [
        { id: "example-order-event", name: "订单服务", url: "https://example.invalid/demo/order-service.git", responsibility: "取消事务保存事件，发送失败后重试", scope: { name: "订单取消事件", paths: ["src/orders", "src/outbox"] }, assignee: owner.username, ticket: "DEMO-001-A", task_id: "demo-preview-order", task_status: "waiting_for_human", current_phase: "写设计" },
        { id: "example-stock-release", name: "库存服务", url: "https://example.invalid/demo/stock-service.git", responsibility: "按预占编号释放库存，重复通知不重复增加库存", scope: { name: "库存幂等释放", paths: ["src/reservations"] }, assignee: reviewer.username, ticket: "DEMO-001-B", task_id: "demo-preview-stock", task_status: "running", current_phase: "写代码" },
        { id: "example-integration", name: "验收工程", url: "https://example.invalid/demo/acceptance.git", responsibility: "联通订单与库存，覆盖正常、重复通知和失败重试", scope: { name: "联调验收", paths: ["tests/acceptance"] }, assignee: owner.username, ticket: "DEMO-001-C", task_id: "demo-preview-integration", task_status: "queued", current_phase: phases[0] },
      ],
      dependencies: [
        { from: "example-integration", to: "example-order-event", reason: "订单侧事件与重试完成后才能联调" },
        { from: "example-integration", to: "example-stock-release", reason: "库存侧幂等释放完成后才能验收" },
      ],
    },
    progress: { phases, current_index: analysisIndex, current_phase: phaseCatalog.placeholders.analysis, step_id: "requirement_analysis", step: "示例拆分确认", revision: 1 },
    waiting: { waiting_id: "example-waiting-decomposition", state_version: 1, created_at: decompositionAt,
      step: "requirement_analysis", recommended_view: "doc",
      context: "示例记录：订单与库存并行，联调验收依赖前两项。",
      question: { purpose: "confirmation", questions: [{ question: "是否按当前分工与依赖推进？", options: ["确认并生成任务", "调整拆分"] }] } },
    delivery_report: { status: "completed", available: true, message: "示例报告：测试与流水线记录均为预览数据。", head: "example-commit" },
  };
  const snapshot: TaskDemoSnapshot = {
    schema: "mae-flow-demo-snapshot/1", captured_at: updatedAt, source_task_id: sourceId,
    task, artifacts, conversation: { items: conversation, problems: [] }, annotations: { items: [] },
    phase_steps: phaseSteps, problems: [],
  };

  const relatedDocuments = new Map<string, Map<string, string>>();
  const relatedSnapshots: TaskDemoSnapshot[] = task.requirement_graph!.repositories.map((unit, unitIndex) => {
    const childId = unit.task_id!;
    const unitName = unit.scope!.name;
    const prefix = unitIndex === 0 ? "DEMO-001" : unit.ticket!;
    const childDocuments = unitIndex === 0
      ? new Map([...documents].filter(([name]) => name !== "task-materials/整体拆分方案.md")
        .map(([name, content]) => [name, `> 当前交付单元：${unitName}。本任务负责订单取消与事件记录；库存实现由关联任务负责。以下为虚构样例。\n\n${content}`]))
      : new Map<string, string>([
        [`${prefix}/grill.md`, `# 示例澄清 · ${unitName}\n\n> 虚构样例，属于 ${childId}。\n\n${unit.responsibility}。\n\n范围由主需求确认，本任务进一步核对输入、异常情况和验收方式。`],
        [`${prefix}/spec.md`, `# 示例规格文档 · ${unitName}\n\n> 虚构样例，属于 ${childId}。\n\n## 验收范围\n\n${unit.responsibility}。\n\n${unitIndex === 1 ? "同一预占编号重复通知只释放一次；不存在的预占记录需要返回明确结果。" : "订单与库存任务完成后联调，分别覆盖正常取消、重复通知及库存失败重试。"}`],
        [`${prefix}/story.md`, `# 示例设计 · ${unitName}\n\n> 虚构样例，属于 ${childId}，不是主任务整体方案。\n\n## 模块职责\n\n${unit.responsibility}。\n\n## 关键方案\n\n${unitIndex === 1 ? "使用预占编号查询处理记录，首次通知释放库存；重复通知返回已有结果。事务内记录释放状态，避免并发重复释放。" : "测试环境联通订单和库存服务；构造取消事件、重复投递和临时失败，分别核对状态、库存与重试记录。"}\n\n## 需要检视的取舍\n\n开发确认异常处理和维护成本，需求 owner 确认验收范围。`],
        ["task-materials/交付报告.md", `# 示例交付报告 · ${unitName}\n\n> 所有结果均为虚构样例，属于 ${childId}。\n\n## 改动点 4+1\n\n| 对比 | 改动前 | 改动后 |\n| --- | --- | --- |\n| ${unitName} | 缺少本任务覆盖 | ${unit.responsibility} |\n\n## 测试报告\n\n示例展示正常与异常场景；没有执行真实测试。`],
      ]);
    relatedDocuments.set(childId, childDocuments);
    const childArtifacts: ArtifactMeta[] = [...childDocuments].map(([name, content]) => ({
      name, label: name.split("/").at(-1)!, kind: "doc", bytes: new TextEncoder().encode(content).byteLength, modified_at: updatedAt,
    }));
    childArtifacts.push(structuredClone(artifacts.find(item => item.kind === "diff")!));
    const currentIndex = unitIndex === 0 ? 3 : unitIndex === 1 ? 4 : 0;
    const childConversation: ConversationItem[] = phaseCatalog.phases.flatMap((phase, index) => {
      const message = unitIndex === 0 ? examples[phase.name].message
        : `示例记录：${unitName}的${phase.name}阶段。${unit.responsibility}。当前材料只属于这个交付单元。`;
      return [{ kind: "turn", id: `example-turn-${index}`, ts: at(index), end_ts: at(index, 20),
        texts: [{ ts: at(index), text: `当前交付单元：${unitName}。${message}`, truncated: false, role: "handoff" }],
        steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] }, open: false },
      { kind: "card", id: `example-card-${index}`, ts: at(index, 20), waiting_id: `example-waiting-${index}`,
        step: phase.steps[0], purpose: "confirmation", annotation_ids: [], status: "resolved",
        questions: [{ question: `示例确认：${unitName}，${examples[phase.name].question}`, options: ["确认，继续演示", "补充意见"] }] }];
    });
    const childTask: TaskSummary = { ...structuredClone(task), id: childId, title: `示例交付 · ${unitName}`,
      ticket: unit.ticket, requirement: `【虚构样例】${unitName}：${unit.responsibility}。本任务仅负责当前交付单元。`,
      repo_url: unit.url, repositories: [unit.url], requirement_graph: undefined,
      parent_task_id: sourceId, parent_task: { id: sourceId, title: task.title, ticket: task.ticket, status: "coordinating" },
      delivery_scope: structuredClone(unit.scope),
      knowledge_usage: exampleKnowledgeUsage(childId, unit.url, true),
      ...(unitIndex === 2 ? { blocked_by: ["demo-preview-order", "demo-preview-stock"] } : {}),
      status: unit.task_status ?? "waiting_for_human", status_label: `示例 · ${unitName}`,
      progress: { phases: [...phases], current_index: currentIndex, current_phase: phases[currentIndex],
        step_id: phaseCatalog.phases[currentIndex].steps[0], step: `示例${phases[currentIndex]}`, revision: 1 },
      waiting: undefined,
    };
    return { schema: "mae-flow-demo-snapshot/1", captured_at: updatedAt, source_task_id: childId,
      task: childTask, artifacts: childArtifacts, conversation: { items: childConversation, problems: [] },
      annotations: { items: [] }, phase_steps: Object.fromEntries(phaseCatalog.phases.map(phase => [phase.name, [...phase.steps]])), problems: [] };
  });

  const reads = new Map<string, unknown>([
    ["/auth/me", actor], ["/auth/people", [actor, owner, reviewer]],
    ["/auth/users", [actor, owner, reviewer]], ["/auth/committers", [reviewer, actor]],
    ["/auth/collaboration-assignees", [actor, owner, reviewer].map(person => ({ ...person, ready: true, missing: [] }))],
    [basePath, task], [`${basePath}/demo-snapshot`, snapshot],
    [`${basePath}/artifacts`, artifacts],
    [`${basePath}/conversation`, { items: conversation, events_seen: conversation.length, problems: [] }],
    [`${basePath}/annotations`, { items: [], checks: [], closures: [] }],
    [`${basePath}/reviews`, []], [`${basePath}/diff-review`, { review: null }],
    [`${basePath}/memories`, []], [`${basePath}/memories/usage`, []],
    [`${basePath}/architecture`, { revision: "example", renderer: "none", warnings: [], diagrams: [], views: [] }],
    [`${basePath}/overall-story`, {}],
    [`${basePath}/timeline`, phaseCatalog.phases.map((phase, index) => ({
      kind: "phase", ts: at(index), title: `示例记录 · ${phase.name}`,
      detail: examples[phase.name]?.message ?? "示例阶段记录。", tone: "info",
    }))],
    [`${basePath}/developer-assistant`, { state: "idle", messages: [], tools: [],
      availability: { available: true, code: "user_override", mode: "edit", reason: "示例开发助手，输入仅保存在演示副本。" } }],
    [`${basePath}/artifacts/file-diff`, { content: exampleDiff, branch: "example/order-cancel", truncated: false }],
    [`${basePath}/push-review-diff`, { content: exampleDiff, branch: "example/order-cancel" }],
  ]);
  for (const [name, content] of documents) reads.set(`${basePath}/artifacts/${encodeURIComponent(name)}`, { content, kind: "doc" });
  reads.set(`${basePath}/artifacts/${encodeURIComponent("未提交改动")}`, { content: exampleDiff, kind: "diff", branch: "example/order-cancel" });

  for (const child of relatedSnapshots) {
    const childPath = `/tasks/${child.source_task_id}`;
    reads.set(childPath, child.task); reads.set(`${childPath}/demo-snapshot`, child);
    reads.set(`${childPath}/artifacts`, child.artifacts);
    reads.set(`${childPath}/conversation`, { items: child.conversation.items, events_seen: child.conversation.items.length, problems: [] });
    reads.set(`${childPath}/annotations`, { items: [], checks: [], closures: [] });
    reads.set(`${childPath}/reviews`, []);
    reads.set(`${childPath}/artifacts/file-diff`, { content: exampleDiff, branch: `example/${child.source_task_id}`, truncated: false });
    reads.set(`${childPath}/artifacts/${encodeURIComponent("未提交改动")}`, { content: exampleDiff, kind: "diff", branch: `example/${child.source_task_id}` });
    for (const [name, content] of relatedDocuments.get(child.source_task_id)!) {
      reads.set(`${childPath}/artifacts/${encodeURIComponent(name)}`, { content, kind: "doc" });
    }
  }

  const fetchRead: typeof fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw new DOMException("预览读取已取消。", "AbortError");
    const url = new URL(input instanceof Request ? input.url : String(input), "https://demo.invalid");
    if (method !== "GET" && method !== "HEAD") {
      return Response.json({ error: "示例只读资料不接受修改；演示操作由隔离副本处理。" }, { status: 405 });
    }
    if (!reads.has(url.pathname)) {
      return Response.json({ error: `此预览没有提供该项示例资料：${url.pathname}` }, { status: 404 });
    }
    let value = reads.get(url.pathname);
    if (/^\/tasks\/[^/]+\/artifacts$/.test(url.pathname) && url.searchParams.has("kind") && Array.isArray(value)) {
      value = (value as ArtifactMeta[]).filter(item => item.kind === url.searchParams.get("kind"));
    }
    return method === "HEAD" ? new Response(null, { status: 200 }) : Response.json(value);
  };
  return { snapshot, actor, fetchRead, architecture, relatedSnapshots };
}

/** 引用固定，避免组件重绘时重新创建演示副本。 */
export const taskDemoPreviewInput = createTaskDemoPreviewInput();

export default function TaskDemoPreview() {
  if (new URLSearchParams(location.search).get("deliveryAnalysis") === "1") return <TaskDemoDeliveryPreview />;
  return <TaskDemoWorkspace preview={taskDemoPreviewInput} />;
}
