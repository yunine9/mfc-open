import type { CodecheckResult } from "./codecheckPrepush.ts";
import type { ComponentKnowledgeCheckReport } from "./componentKnowledgeCheck.ts";
import type { MrParticipantsResult } from "./mrParticipants.ts";
import type { PipelineCheck, PipelineDimension } from "./pipelineContract.ts";
import type { PrePushVerificationState } from "./prePushVerification.ts";
import type { StallClass } from "./stallPolicy.ts";
import type { FinalDeliveryMr, InitialDeliveryMr } from "./taskFinalMr.ts";
import type { PrePushRuntimeState, PushReviewPresentation } from "./taskService.ts";

export type TaskDeliverySummary = {
  component_knowledge?: ComponentKnowledgeCheckReport;
  initial_mr?: InitialDeliveryMr;
  final_mr?: FinalDeliveryMr;
  mr_url?: string;
  /** MR 标识(平台返回的 id/iid):门禁与讨论查询要带回去。 */
  mr_id?: number | string;
  mr_participants?: MrParticipantsResult;
  /** 交付分支对(门禁查询与冲突修复都要用,重启后不靠重读状态文件)。 */
  source_branch?: string;
  target_branch?: string;
  mr_state?: string;
  /** 平台合入事实；独立于 sha/git_push，不能覆盖旧验证和推送记录。 */
  merged_sha?: string;
  pipeline?: string;
  /** 当前 SHA 的验证是否只是编码期间的旁路观察，重启时据此续接。 */
  pipeline_background?: boolean;
  /** 平台按质量维度返回的 Job 结果（可选诊断增强）。契约已声明三项
   * 均由该权威流水线覆盖时，总体 success 可聚合核销；若逐项明确
   * failed / pending，内核仍以更精确事实裁决 RED / INCOMPLETE。 */
  checks?: PipelineCheck[];
  /** 最近一次推送的起点，仅用于代码增量展示，不参与审批或收据核验。 */
  last_push_base_sha?: string;
  /** Cloud 在 Agent 会话释放后完成的推送收据；内核要求它与流水线
   * SHA、工作区 HEAD 三者一致，避免模型接触个人 Token。 */
  git_push?: {
    sha: string;
    ref: string;
    remote: string;
    url?: string;
  };
  /** 分支上的外来提交(本任务没推过、却已在远端的提交)。它只可能是
   * 人为介入,默认可信:宿主把自己的提交接到它后面,不举卡也不拦。
   * 记账是为了两件不能忘的事——机械重组的锚不许比 base_sha 更老
   * (否则一次 reset 就把人推上去的东西抹了),派给 Agent 的每一轮
   * 都要点名"这些不是你写的,别回滚"。 */
  foreign_commits?: {
    /** 吸收时的远端分支头:此后一切机械重组的最老锚。 */
    base_sha: string;
    absorbed_at: string;
    count: number;
    /** `<短 SHA> <标题>`,只用于对人/对 Agent 披露。 */
    subjects: string[];
  };
  /** Cloud 按需运行的独立编译/UT 会话，不是必经步骤或审批门禁。
   * 真实结果按 SHA + 工作区指纹记录，不由推送成功推断编译通过。 */
  prepush?: PrePushVerificationState;
  /** 推送前上传 Skill 的实际结果，不参与任务阶段转换。 */
  codecheck?: CodecheckResult;
  /** 读侧活性事实，不落盘。prepush.state=preparing 只表示领域阶段，
   * 不能再被页面误当成当前进程确实持有 runner/容器。 */
  prepush_runtime?: {
    state: PrePushRuntimeState;
    message: string;
  };
  /** 当前 push 检视卡的只读说明与比较锚。卡片销毁即清除。 */
  push_review?: PushReviewPresentation;
  /** 历史目录限制卡，仅为兼容读取；恢复或继续验证时清理。 */
  scope_violation?: { paths: string[]; noted_at: string };
  /** 最近一次人真正看过的 HEAD：推送确认卡通过或返工时记录，
   * 复检的“这次修改”以此为比较起点，不控制推送许可。 */
  last_reviewed_head?: string;
  sha?: string;
  skipped?: string;
  /** 内核对流水线证据的裁决戳(如 "PASS@abc123456789"):终态时宿主
   * 把平台事实喂给内核 `pipeline record`,内核绑工作区 HEAD 裁决并
   * 写进 .mae-flow.json 的 quality.pipeline——这里只是那份现场记录
   * 的镜像。"未裁决(...)"= 登记失败留痕，并阻止进入 await_merge。 */
  attested?: string;
  /** 挂起等待的人话(等审批/等投票……):MR 闭环里"没人动它"和
   * "出了问题"必须让人一眼分得开。 */
  waiting_on?: string;
  /** 外部验证自愈预算的到期时刻(ISO)。重启后照旧对表,不重新开表
   * ——否则每重启一次就白送半小时。 */
  verify_deadline?: string;
  /** 自愈已停,等人工介入的原因。设了它:retry 放行、页面亮牌子、
   * 通知发出。这是"验证中"这潭水里唯一诚实的出口——没有它的时候
   * 任务会既不完成也不失败也不重试,人连重跑都点不动(实测)。 */
  stalled?: string;
  /** 停摆类别(stallPolicy.ts):人接手要做的是等恢复、补材料、让 Agent
   * 重做、修配置,还是先核实完整性。与 stalled 同生同灭。 */
  stall_class?: StallClass;
  /** 红灯维度缺少具体报错时的宿主级取证状态。它不属于内核流程，
   * 不消耗修复 round；平台证据恢复或人工批注回灌后自动清除。 */
  evidence_gap?: {
    sha: string;
    state: "retrying" | "waiting_human" | "partial";
    missing_dimensions: PipelineDimension[];
    available_dimensions: PipelineDimension[];
    reasons: string[];
    attempts: number;
    failure_log?: string;
    retry_deadline?: string;
    notified_at?: string;
    human_evidence?: string;
    human_dimensions?: PipelineDimension[];
  };
  /** 修复环账本(小状态机):MR 合入是最终目标。失败先分类再派单
   * (检视>冲突>CI,同时多项只修最高优先级那一路——冲突不解 CI
   * 白跑);round 只数 CI 修复(检视/冲突触发时清零,流程性问题
   * 不许耗掉代码修复的额度);max 默认 20,数字=可配手刹。
   * CI 按已配置轮数预算收敛，不用交付 SHA 推断 Agent 已放弃；冲突保留独立恢复规则，
   * 检视=同一批讨论 id 修过一轮仍未解决即停;加上提示词里的
   * "原地打转必须换思路或出诊断"。
   * diagnosis=修复会话停下时留给人的话(缺什么、去哪配)。 */
  loop?: {
    round: number;
    max?: number;
    /** repairing 只表示修复 Agent 本身正在运行；会话收口后进入
     * verifying，覆盖新 SHA 的 prepush、push 与权威流水线验证。 */
    state: "repairing" | "verifying" | "green" | "merged" | "exhausted" | "halted";
    /** 最近一次派的修复类型:回程(settle 后)按它走收尾动作。 */
    kind?: "ci" | "review" | "conflict";
    /** review 的来源决定是否还需要人裁决：MR 讨论只是别人提的意见，
     * workspace 则是任务责任人已经在工作台明确提交的修改要求。 */
    review_source?: "platform" | "workspace";
    /** 本地检视可能并入正在运行的 CI/冲突会话；独立标记让 push 边界
     * 知道这一轮新增业务文件也已由用户的修改要求授权。 */
    workspace_review_pending?: boolean;
    /** 人工意见引发的修改必须回到人手里复检；纯流水线修复不设置。 */
    workspace_review_recheck_required?: boolean;
    /** 本轮需要逐条闭环的批注。空数组表示只有整体补充说明，仍需总检。 */
    workspace_review_annotation_ids?: string[];
    failure?: string;
    last_sha?: string;
    /** 检视修复的刹车锚:上一轮讨论 id+revision 集(排序拼接)。 */
    review_ids?: string;
    /** 已把回复发布到平台的讨论 id+revision 集。与 review_ids 相等 = 这批
     * 意见都答复过了,门禁还红只是检视人没点"已解决"——那是等人,
     * 不是修不动(报告 D3:既有框架刻意不代检视人 resolve)。 */
    replied_ids?: string;
    /** 同一批本地检视缺回执时，原会话已经自动补交过一次。值绑定
     * review_ids，防止模型继续漏写时无限催办；换一批意见自然重置。 */
    workspace_review_receipt_retry_for?: string;
    /** 任意非工作台反馈缺结构化逐条回执时原会话只补交一次。 */
    feedback_receipt_retry_for?: string;
    diagnosis?: string;
  };
  /** 推送卡前发现检视意见没处理完时,已为哪一批(id:版本 指纹)重新派过
   * Agent。同一批只派一次:派过仍没完成就如实举卡让人返工,不空转。 */
  review_processing_dispatched_for?: string;
};
