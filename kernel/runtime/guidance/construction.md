# Construction Guidance

The main Agent implements the complete approved change from local `spec.md` and `story.md` in this single step: one compile, one human review, no process batches or pre-coding plan documents. Design-bearing code is never outsourced — interfaces, the first implementation of each pattern and cross-module seams are written by the main Agent itself, because two fresh contexts invent two dialects. Subagents serve exactly two purposes: read-only scouting (digesting existing abstractions, call sites and conventions into a distilled report, allowed any time), and mechanical fan-out (replicating an exemplar the main Agent already wrote across an explicit file list, at least three files, output never exempt from the four-item self-check). The dispatch order must carry its context instead of pointing at it: the exemplar, the target list and the rule travel inside the order, and the subagent is told not to re-read spec, story or domain documents — rebuilding context each dispatch is what made the retired checkpoint mode slow. An order that cannot be made self-contained means the work is not mechanical. Subagents never touch git; dispatching changes no gate and no evidence. Within that single pass, write chunk by chunk following the task order in `implementation.md`: after each chunk, self-check the four items (neighbor-consistent naming, no duplicated helpers, error handling matching the module's convention, downstream interface signatures finalized) before the next chunk, and re-read the whole diff once at the end for cross-chunk drift. Chunks are an in-context discipline only — no compiles, no done, no user contact between them.

Before writing, read the materialized `.mae-flow-work/plugin-resources/standards/code-taste-v1.md` and `.mae-flow-work/plugin-resources/standards/comment-standard-v1.md`, and study neighboring code first: conformance to the repository's existing abstractions, naming and error-handling conventions outranks self-contained novelty. The taste baseline is a target, not a gate; the craft reviewer and the human review judge against it.

For a localized change with concise confirmed scope, proceed directly. Upgrade to full workflow when semantic risk appears: unclear behavior, cross-module impact, compatibility, security, data, public interface, shared state, or concurrency. The decision follows semantic risk, not file or line count.

During coding, preserve ownership, error, lifetime, concurrency, compatibility, and reuse boundaries. Prefer the standard library, simplest design, and no speculative abstraction. Create a deterministic test seam during coding, isolate each framework boundary where external effects require control, and apply the principles below, so formal UT can exercise real logic without reconstructing the module through mocks.

## 核心编码原则：逻辑可直接测试，mock 集中在必要边界

可测试性在编码时形成。按测试目标隔离外部依赖，保留被测逻辑的真实执行，不以 mock 数量判断质量。当前验证聚焦函数级 UT 和模块级 UT（MST）；MST 就是模块 UT：前者验证具体逻辑，后者补充内部真实协作，不能因代码主要调用接口、访问数据库就忽略函数逻辑的验证价值。单独 REST 接口调试、跨模块集成和部署后验证仅为后续预留，不自动实施或列为本轮验收要求。

- 将条件判断、数据转换、SQL 构造及参数绑定等逻辑，与数据库执行、远端调用、文件访问等副作用合理分离；尽量让逻辑通过明确输入产生可观察输出，直接运行真实函数进行测试。例如 SQL 构造可验证条件、占位符与参数顺序，但这些断言不能证明实际数据库执行及数据库约束正确，应如实说明证据边界。
- 沿用仓库已有的公共客户端、存储适配器等边界，使外部依赖可以在测试中替换。公共依赖的 mock/fake 在测试支持代码中按需集中、复用，避免每条用例重复搭建整条内部调用链；复用实现时仍为各用例隔离可变状态。生产代码不加入测试模式分支或 mock 实现。
- 模块内部尽量使用真实实现协作。不要为每个类、每个方法调用建立 mock，不要 mock 被测的核心判断，再断言预设答案。只有真实影响可重复性的时间、随机数或外部依赖，才按需要提供可控制的边界。
- 保持模块入口、状态归属和资源生命周期清楚，让测试能独立初始化、调用、观察结果并清理。检查返回值、状态变化及必要的对外行为，包括不应发生的副作用，而非只为匹配内部调用顺序写测试。
- 在函数 UT 基础上尽力开展模块级 UT：依据本模块已确认场景，从业务入口验证内部真实协作；复用已有框架、命令及必要依赖替身。编码时合理建立缺失的测试入口或装配，测试工单携带场景依据、入口和真实/mock 边界。未执行时说明原因及影响，不能把函数 UT 的结果扩大为模块通过；当前通过提示词强化，不要求先建设统一测试平台。
- 优先使用现有抽象和最小改动；不为 mock 方便给每个类添加接口、扩成全仓重构或追求零 mock。遗留耦合暂时无法合理隔离时说明具体限制、已有验证与缺口，不能靠大量内部 mock 冒充覆盖。

这些是编码和自检的核心导向，不增加 mock 数量、接口数量等机械门禁，也不新增固定人工确认步骤。

## Implementation continuation

依照注释标准中的参考模板，优先补足模块职责、公开接口的非显然语义、复杂逻辑的不变量、
错误与副作用、并发及兼容处理的原因。复杂处写清楚比追求行数更重要；明显代码无需复述。
行为修改与注释修订一起完成，收口时核对旧注释是否仍然成立。只处理本次增量与直接关联的契约。
这是高优先级编码和检视导向，不设置注释比例、模板齐全度或 hook 门禁，不额外增加审批流程。

If implementation exposes a real deviation from the confirmed Spec or Story, record the implementation deviation and compare it with the behavior baseline. Align the implementation when possible; otherwise propose an artifact update for user judgment. Never silently rewrite confirmed behavior.

Compilation is mandatory and delegated to compile-agent. Its generated task card must identify the exact project root, changed source/build files, execution roots, and configured build Skill or command. The main Agent must not replace this evidence with an ad-hoc local build.

Keep code uncommitted for the optional one-time full read-only CODE Agent precheck and the user's IDE review. Focused design-to-implementation follow-up uses `.mae-flow-work/plugin-resources/guidance/review.md` and does not restart the full CODE precheck. The main Agent edits and records the affected validation before returning results to the existing human review; an unresolved Agent finding does not create another approval or workflow gate.
