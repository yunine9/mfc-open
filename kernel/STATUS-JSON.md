# 交付快照出口契约（草案 · 2026-08-08 · 未实现）

**这是什么**：给"展示层"用的唯一结构化出口。任何面板（我们自己的单文件 HTML、
公司的可视化壳、同事的脚本）都从这一个口读交付现场，禁止去爬中文文本输出。

**状态**：纯契约草案，**零代码改动**。实现前需拍板。落地后本文并入
MAINTAINERS §3，本文即可删除。

**为什么是 `status --json` 而不是 `current --json`**：`current` 打的是给模型执行的
步骤指令（提示词），不是数据；它在模型热路径上，动它有真实风险。`status` 本来就是
"看现场"的命令，加一个 `--json` 是零语义变化的旁路。

---

## 一、两条不能破的铁律（实现时用测试钉死）

1. **只读**。出口不写任何状态。测试断言：调用前后 `.mae-flow.json` 的 `revision`
   与 mtime 完全不变。阶段真相只在 `.mae-flow.json`，写入只走 `done`。
2. **可缺席**。没有面板时流程一模一样能跑完。任何"只有面板上才能确认"的环节都是
   设计错误——面板是增强，不是依赖。

附带三条工程铁律：

3. **软失败**。出口自身出错绝不变成新卡点：不抛栈、不返回非零，把问题写进
   `warnings[]`，其余字段照给（同 symbol-refs 的"工具失败不能变成新卡点"）。
4. **不触发任何重活**。只读文件 + `git`（带 timeout）。禁止调 CodeCheck/npm/编译，
   禁止安装任何东西。看现场不能改变现场。
5. **不内联文件内容**。只给**绝对路径 + 统计**。面板在本地自己读文件——这样 JSON
   恒小，也避免出口变成源码外泄通道（内网仓库必须守）。

---

## 二、版面优先级（这是契约的一部分，不是建议）

面板渲染顺序必须是：

1. **`pending`（待你裁决）—— 最显眼**
2. `artifacts`（文档/代码/日志，带完整路径）
3. `evidence`（哪项红了、为什么红、是否降级）
4. `advisories`（本轮建议）
5. **`progress`（阶段进度）—— 最不显眼。它是导航，不是成绩。**

理由：一排绿灯看久了，"绿了"会自动等于"我看过了"，驳回权就被显示悄悄拿走了。
这跟"为什么不用机器硬拦"是同一条原则的另一面。

**禁止项**：面板不得提供任何"点一下推进到下一步"的按钮。那是绕过证据的官方通道，
比模型偷懒危险得多，因为它看起来完全合法。`command_hint` 只供人复制到终端，
是给人看的口令，不是 API。

---

## 三、载荷

```jsonc
{
  "schema": "mae-flow-status/1",
  "generated_at": "2026-08-08 17:02:11",
  "state_revision": 27,                    // 面板据此判断是否需要重绘

  "repo": {
    "root": "/abs/path/to/repo",
    "branch": "master_dev_REQ2026080901",
    "baseline": "master",
    "head": "76565f1...",
    "dirty_files": 0
  },

  "delivery": {                            // 来自 state.config,原样透出中文键的英文映射
    "ticket": "REQ2026080901",
    "ticket_type": "需求",
    "workflow": "full",                    // full|hotfix|tweak|review
    "requirement_doc": "/abs/.../需求文档.md",
    "owner": "工号",
    "started_at": "2026-08-08 13:41:02",
    "moonlight": false
  },

  // ── 1) 待你裁决:面板的主体 ────────────────────────────────
  "pending": [
    {
      "kind": "config_review",             // config_review|doc_review|diff_review
                                           // |choice|risk|exemption
      "title": "确认本单配置",
      "step": "config_confirm",
      "needs": "user_ack",                 // user_ack|choice|message_id
      "items": [                           // 配置卡原文——治"问我确认却不给信息"
        {"label": "分支名", "value": "master_dev_REQ2026080901"},
        {"label": "编译方式", "value": "python-compile"}
      ],
      "paths": ["/abs/.mae-flow-work/REQ2026080901/story.md"],
      "command_hint": "python .mae-flow-work/bin/mae-flow.py done --ack ..."
    }
  ],

  // ── 2) 关键产物:一律绝对路径 ──────────────────────────────
  "artifacts": {
    "documents": [                         // 磁盘真实布局 .mae-flow-work/<单号>/
      {"kind": "survey",   "path": "/abs/.../survey.md",   "exists": true,
       "bytes": 3412, "updated_at": "2026-08-08 13:58:20", "reviewed": true},
      {"kind": "grill",    "path": "/abs/.../grill.md",    "exists": true, "...": "..."},
      {"kind": "spec",     "path": "/abs/.../spec.md",     "exists": true, "...": "..."},
      {"kind": "story",    "path": "/abs/.../story.md",    "exists": true, "...": "..."},
      {"kind": "decisions","path": "/abs/.../decisions.md","exists": true, "...": "..."},
      {"kind": "implementation", "path": "/abs/.../implementation.md", "...": "..."}
    ],
    "spec": {
      "workspace": "/abs/.mae-flow-work/spec",   // 双根:openspec/ 存在则以它为准
      "engine": "builtin",                       // builtin|codespec
      "phase": "design",                         // open|design|verified|archived|null
      "change_dir": "/abs/...",
      "entries": ["/abs/.../specs/notify/spec.md"]
    },
    "code": {
      "commits": [                               // 本单范围内,上限 50 条
        {"sha": "f63972b", "subject": "[REQ2026080901][feat]短信渠道新增…",
         "at": "2026-08-08 16:40:11", "files": 3}
      ],
      "uncommitted": {"files": 0, "paths": []},  // 待检视增量
      "scope_diff": {"base": "76fb632", "files": 3,
                     "insertions": 214, "deletions": 18}
    },
    "logs": {                                    // 目录或文件,面板自己读
      "lightcheck": "/abs/.mae-flow-work/lightcheck/latest.md",
      "codecheck":  "/abs/.mae-flow-work/codecheck-logs",
      "agent_tasks": "/abs/.mae-flow-work/agent-tasks",
      "role_tasks":  "/abs/.mae-flow-work/role-tasks"
    },
    "report": {
      "ledger": "/abs/~/.mae-flow-history.jsonl", // 历史交付账本(report all 的源)
      "this_delivery_available": true
    }
  },

  // ── 3) 证据:状态词沿用现有词表,不新造 ────────────────────
  "evidence": {
    "compile":   {"status": "PASS", "at": "…", "head": "f63972b",
                  "net_findings": 130, "task": "/abs/.../build-compile.md"},
    "ut":        {"status": "RUNNING", "batches": 3, "completed": 0},
    "codecheck": {"status": "TOOL_ERROR", "count": null, "degraded": true,
                  "reason": "CodeCheck CLI 当前不可用(已尽力自动安装,未成功)",
                  "files": ["service/src/demo_service/sms_handler.py"]},
    "reviews":   [{"role": "story-review", "at": "2026-08-08 14:10:31",
                   "path": "/abs/.../story-story-review.md"}]
  },
  // ⚠ 面板必须把 degraded=true 渲染成**区别于通过**的第三种颜色。
  //   "工具没跑起来" 和 "跑了且干净" 混成一个绿灯,是这套系统最不能容忍的谎。

  // ── 4) 本轮建议(非阻断) ──────────────────────────────────
  "advisories": [
    {"step": "build_commit", "kind": "lightcheck",
     "message": "MF-FUNC-50 …", "at": "…"}
  ],

  // ── 5) 进度:排最后,且允许"不知道" ────────────────────────
  "progress": {
    "phase": "quality",                    // startup|spec|story|construction|quality|delivery
    "step": "verify_ut",
    "step_title": "UT 验证",
    "steps_done": ["config_confirm", "workflow_select", "…"],
    "steps_total_estimate": 18,            // 沿 flow.json 的 next/next_by 推导
    "percent": null,                       // 分支未定/有回退时**必须 null**
    "elapsed_seconds": 11400,
    "revisits": {"goto": 0, "rejections": 2}
  },

  "warnings": []                           // 出口自身的降级说明,如 "git 超时,提交列表缺失"
}
```

### `percent` 为什么允许 null

flow 有分支（`next_by: workflow`）和用户批准的回退（`goto`）。在这种图上算百分比
必然是编的，而**假进度比没进度更坏**——它是最容易让人停止读 diff 的那个像素。
不确定就给 null，面板显示"第 13 步 / 约 18 步"。

---

## 四、版本兼容

- **加字段不算破坏**，面板必须容忍未知字段；
- **改语义或删字段要升 `schema`**（`mae-flow-status/2`）；
- 面板永远先读 `schema`，不认识就退化成纯文本提示，不猜。

大小上限约 64KB：`commits` ≤ 50、`timeline`（如后续加）≤ 100、
`advisories` 本来已经封顶 40。

---

## 五、实现草图（拍板后再动）

| 落点 | 内容 |
| --- | --- |
| `scripts/mae_flow_core/cli_commands/status_json.py` | 只读组装。state 走 `safe_read_json`，git 走既有 helper 带 timeout，全程 try/except → `warnings[]` |
| `status` 命令加 `--json` | 无 `--json` 时行为字节不变 |
| `scripts/tests/test_status_json.py` | ① 只读断言（前后 `revision`/mtime 不变）② 非 git 目录软失败 ③ schema 必备键 ④ `degraded` 与 `PASS` 不同值 ⑤ 无 `.mae-flow.json` 时给出可用空快照 |

**第二步（可选，另行拍板）**：`status --html` 写一个自包含单文件到
`.mae-flow-work/status.html`，内网零依赖、零服务，浏览器打开即看。它只是本 JSON
的一个消费者——**不是**新的真相源。

**第三步（第二步之后）**：SKILL.md 里的"转述义务"退役。有了面板它就是冗余，
提示词可以再减一条。
