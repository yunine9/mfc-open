/**
 * 任务的扫读焦点。
 *
 * 它只把已有任务事实翻译成“现在发生什么 / 下一步是谁做”，不参与
 * 状态迁移、门禁或恢复。TaskService 在读侧现算，旧 task.json 无需迁移，
 * 前端也不再各自解释同一组 delivery/status 字段。
 */

import { STALL_POLICY, type StallClass } from "./stallPolicy.ts";

export type TaskFocusKind =
  | "human_action"
  | "blocked"
  | "machine"
  | "external"
  | "done"
  | "inactive";

export type TaskFocusOwner = "responsible" | "agent" | "platform" | "none";

export interface TaskFocus {
  kind: TaskFocusKind;
  headline: string;
  next_action: string;
  owner: TaskFocusOwner;
  needs_attention: boolean;
  /** 只用于同一列表的稳定排序；数值越大越应先看到。 */
  priority: number;
}

interface FocusTask {
  status: string;
  continuation?: { state: "preparing" | "failed" | "active"; error?: string };
  detail?: string;
  requirement_graph?: {
    repositories?: Array<{ task_status?: string }>;
  };
  /** 开发助手正占有主现场:此时"恢复"是死路,要指去交还入口。 */
  assistant_engaged?: boolean;
  /** 执行队列位次(1 起,投影字段):排队真相必须压过陈旧 detail。 */
  queue_position?: number;
  blocked_by?: string[];
  waiting?: { question?: { questions?: unknown[]; purpose?: string } };
  progress?: {
    current_phase?: string;
    step?: string;
    milestone?: { event?: string; title?: string; reason?: string };
  };
  delivery?: {
    mr_state?: string;
    pipeline?: string;
    waiting_on?: string;
    stalled?: string;
    /** 停摆类别(stallPolicy):有它才能说清"去哪、做什么"。 */
    stall_class?: StallClass;
    evidence_gap?: {
      state?: "retrying" | "waiting_human" | "partial";
      missing_dimensions?: string[];
    };
    prepush?: { state?: string; round?: number; message?: string };
    prepush_runtime?: {
      state?: "running" | "recovering" | "interrupted" | "stopped" | "idle";
      message?: string;
    };
    loop?: {
      state?: string; round?: number; max?: number; diagnosis?: string;
      /** review=本地检视返工;ci=流水线修复。播报必须分清(MFC-023)。 */
      kind?: string;
    };
  };
}

function focus(
  kind: TaskFocusKind,
  headline: string,
  nextAction: string,
  owner: TaskFocusOwner,
  priority: number,
  needsAttention = false,
): TaskFocus {
  return {
    kind,
    headline,
    next_action: nextAction,
    owner,
    needs_attention: needsAttention,
    priority,
  };
}

/** 状态短文案(列表药丸、检查器"任务状态"一行)。2026-09-06 从前端
 * api.ts 搬来:前端不推断状态,这里是唯一来源;前端只读 status_label。 */
export const TASK_STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  pausing: "正在暂停",
  paused: "已暂停",
  waiting_for_human: "等你决定",
  coordinating: "子任务进行中",
  completed: "已完成",
  failed: "出错了",
  verifying: "代码已提交,流水线验证中",
  await_merge: "已提合入请求,等待合入",
  canceled: "已取消",
};

/** 机器停了、该人上:修复环停机、外部验证自愈预算烧完如实停下、旧的
 * 轮询预算耗尽。retry 准入与页面的"需介入"都从这里读,不再各判一套。 */
export function deliveryStopped(delivery: FocusTask["delivery"]): boolean {
  return delivery?.loop?.state === "halted"
    || delivery?.loop?.state === "exhausted"
    || Boolean(delivery?.stalled)
    || (delivery?.pipeline ?? "").includes("轮询预算耗尽");
}

/** 页面的"需介入/重跑续推"闸:只有 verifying 且机器确实停了才算;Build-Fix
 * 正在 running/recovering 时旧的停机牌不算数(服务已经在自救)。 */
export function projectRepairStopped(task: FocusTask): boolean {
  if (["running", "recovering"].includes(
    task.delivery?.prepush_runtime?.state ?? "")) return false;
  return task.status === "verifying" && deliveryStopped(task.delivery);
}

/** 修复环激活时,"机器正在自救/机器停了需要人"比伞状态"验证中"更有
 * 信息量——全部来自 loop/prepush 账本。人工节点与出错永远压过修复环文案
 * (等人/坏了都比修复更紧急),所以只在 queued/running/(pausing)/verifying
 * 下改写。 */
export function projectStatusLabel(task: FocusTask): string {
  if (task.continuation?.state === "preparing") return "正在准备继续修改";
  if (task.continuation?.state === "failed") return "继续修改待重试";
  const loop = task.delivery?.loop;
  const runtime = task.delivery?.prepush_runtime;
  if (["queued", "running", "verifying"].includes(task.status)) {
    if (runtime?.state === "recovering") return "Build-Fix 恢复中";
    if (runtime?.state === "running") return "Build-Fix 进行中";
  }
  if (loop && ["queued", "running", "pausing", "verifying"]
    .includes(task.status)) {
    if (loop.state === "repairing") {
      // 人工检视刚触发返工时 round=0 表示尚未消耗任何流水线修复轮次:
      // 内部状态,不能作为"第 0 轮"暴露;此时人关心的是 Agent 正在处理
      // 检视意见。只有进入真实 CI 修复轮才说"流水线修复中"。
      if (loop.kind === "review" || (loop.round ?? 0) <= 0) {
        return "正在按检视意见修改";
      }
      return "流水线修复中";
    }
    if (loop.state === "verifying") return "修复结果验证中";
    if (loop.state === "halted") return "自动修复已停,需人工";
    if (loop.state === "exhausted") return "修复预算用完,需人工";
  }
  return TASK_STATUS_TEXT[task.status] ?? task.status;
}

/** 从服务端已有事实生成唯一的扫读口径；任何未知状态都安全降级。 */
export function projectTaskFocus(task: FocusTask): TaskFocus {
  if (task.continuation && task.continuation.state !== "active") {
    const failed = task.continuation.state === "failed";
    return focus(failed ? "human_action" : "machine",
      failed ? "继续修改准备未完成" : "正在准备继续修改",
      failed ? "打开原任务，重试继续修改" : "正在更新基准并保留原目录与缓存",
      failed ? "responsible" : "agent", failed ? 96 : 50, failed);
  }
  const delivery = task.delivery;
  const loop = delivery?.loop;
  const prepush = delivery?.prepush;

  if (task.status === "coordinating") {
    const repositories = task.requirement_graph?.repositories ?? [];
    const attention = repositories.filter((repository) => [
      "waiting_for_human", "paused", "failed",
    ].includes(repository.task_status ?? "")).length;
    return focus(
      attention ? "human_action" : "machine",
      task.detail?.trim() || "子任务正在推进",
      attention ? "打开主任务查看并处理异常子任务" : "等待各子任务完成或取消",
      attention ? "responsible" : "agent",
      attention ? 96 : 50,
      attention > 0,
    );
  }

  if (task.status === "waiting_for_human") {
    const questions = task.waiting?.question?.questions?.length ?? 0;
    // 澄清卡:Agent 处理检视意见时缺信息在问人,不是"要不要通过"。
    if (task.waiting?.question?.purpose === "clarification") {
      return focus(
        "human_action",
        "Agent 处理检视意见时缺少信息,需要你补充",
        "答复后 Agent 继续处理这条意见;这不是最终验收",
        "responsible",
        100,
        true,
      );
    }
    return focus(
      "human_action",
      questions > 0 ? `需要确认 ${questions} 个决策项` : "需要负责人确认",
      "提交决定后 Agent 自动继续",
      "responsible",
      100,
      true,
    );
  }
  if (task.status === "failed") {
    const detail = task.detail?.trim() || "任务执行失败";
    // 克隆/初始化期的失败是下单配置问题(仓库地址、基线分支、单号…),
    // "处理后重跑"重跑一百次也一样——出路是修正信息重新下单(MFC-025)。
    // 判据:任务从未产生过流程进度(progress 只有内核跑起来才有)。
    const neverStarted = !task.progress
      || (!task.progress.current_phase && !task.progress.step);
    return focus(
      "blocked",
      detail,
      neverStarted
        ? "多为下单配置问题(仓库/分支/单号):修正后重新发起任务"
        : "查看代码与未提交文件，补充处理要求；原因解除后可按原流程重试",
      "responsible",
      95,
      true,
    );
  }
  if (task.status === "paused") {
    if (task.assistant_engaged) {
      return focus(
        "blocked",
        "开发助手正在接管代码现场，主任务已安全暂停",
        "在右栏输入框切到「我来接手」完成工作并点「交回给 Agent」后自动继续",
        "responsible",
        90,
        true,
      );
    }
    return focus(
      "blocked",
      "任务已暂停，现场已经保留",
      "需要继续时从当前现场恢复",
      "responsible",
      90,
      true,
    );
  }
  if (delivery?.evidence_gap?.state === "waiting_human") {
    const dimensions = delivery.evidence_gap.missing_dimensions?.join("、");
    return focus(
      "human_action",
      dimensions
        ? `流水线 ${dimensions} 缺少具体报错`
        : "流水线缺少可修复的具体报错",
      "在工作台《流水线证据缺口》材料上批注并回灌平台原文",
      "responsible",
      98,
      true,
    );
  }
  // runtime 是当前 serve 的活性事实，优先于 task.json 里可能由部署前
  // 留下的 loop.halted。只有真正在 running/recovering 时覆盖旧停机牌；
  // interrupted/stopped 仍按下面的停机分支提醒人，不能用阶段名猜活性。
  if (["queued", "running", "verifying"].includes(task.status)
      && prepush && ["running", "recovering"]
    .includes(delivery?.prepush_runtime?.state ?? "")
      && [
        "queued", "preparing", "compiling", "testing", "unit_testing", "ut",
        "repairing",
      ].includes(prepush.state ?? "")) {
    return focus(
      "machine",
      delivery?.prepush_runtime?.state === "recovering"
        ? (delivery.prepush_runtime.message || "服务正在恢复 Build-Fix")
        : prepush.message?.trim()
          || `正在进行 Build-Fix${prepush.round ? `（第 ${prepush.round} 轮）` : ""}`,
      "定向编译与受影响 UT 通过后继续交付",
      "agent",
      58,
    );
  }
  if (delivery?.stalled || loop?.state === "halted"
      || loop?.state === "exhausted") {
    // 停摆类别决定人的下一步:等平台恢复、补材料、让 Agent 重做、修配置,
    // 还是先核实完整性再说。没有类别(修复环停摆)沿用泛化措辞。
    const policy = delivery?.stalled && delivery.stall_class
      ? STALL_POLICY[delivery.stall_class] : undefined;
    return focus(
      "blocked",
      delivery?.stalled || loop?.diagnosis || "自动验证已停止",
      policy?.next_action ?? "查看失败原因并重跑续推",
      "responsible",
      92,
      true,
    );
  }
  // 已继续交付或结束的任务保留历史失败，但历史记录不再阻塞当前状态。
  if (!["verifying", "await_merge", "completed", "canceled"].includes(task.status)
      && (prepush?.state === "environment_error" || prepush?.state === "blocked")) {
    return focus(
      "blocked",
      prepush.message?.trim() || "Build-Fix 暂时无法继续",
      prepush.state === "environment_error"
        ? "等待平台恢复编译环境"
        : "查看编译或 UT 失败现场",
      prepush.state === "environment_error" ? "platform" : "agent",
      85,
      true,
    );
  }
  if (task.status === "canceled") {
    return focus("inactive", "任务已取消", "无需继续处理", "none", 0);
  }
  if (task.status === "completed") {
    return focus("done", "交付已经完成", "可在交付历史中复盘", "none", 5);
  }
  if (task.status === "await_merge") {
    const waiting = delivery?.waiting_on?.trim();
    const closed = delivery?.mr_state === "已关闭"
      || /MR 已关闭/.test(waiting ?? "");
    return focus(
      "human_action",
      waiting || (closed ? "MR 已关闭，任务仍在等待处理"
        : delivery?.mr_state ? `合入请求：${delivery.mr_state}`
          : "验证通过，等待合入"),
      closed
        ? "重新打开 MR 继续推进，或主动停止任务"
        : "打开 MR 完成检视、审批与合入",
      "responsible",
      closed ? 94 : 82,
      true,
    );
  }
  if (task.status === "pausing") {
    return focus(
      "machine",
      "正在安全暂停当前会话",
      "保存现场后自动进入暂停状态",
      "platform",
      55,
    );
  }
  if (loop?.state === "repairing") {
    // kind=review 是本地检视返工:代码还没推,没有任何流水线在跑。
    // 曾经不看 kind,团队总览把检视返工播成"修复流水线问题"(MFC-023)。
    if (loop.kind === "review") {
      return focus(
        "machine",
        "Agent 正在按检视意见修改",
        "修改完成后重新出检视卡",
        "agent",
        60,
      );
    }
    return focus(
      "machine",
      "Agent 正在修复流水线问题",
      "产生新提交后自动重新验证",
      "agent",
      60,
    );
  }
  if (prepush && ["preparing", "compiling", "testing", "unit_testing", "ut"]
      .includes(prepush.state ?? "")
      && ["interrupted", "stopped"]
        .includes(delivery?.prepush_runtime?.state ?? "")) {
    return focus(
      "blocked",
      delivery?.prepush_runtime?.message
        || "Build-Fix 已经中断，当前没有执行会话",
      "服务会自动恢复；未恢复时可手动重跑编译",
      "platform",
      88,
      true,
    );
  }
  if (prepush && [
    "queued", "preparing", "compiling", "testing", "unit_testing", "ut",
    "repairing",
  ].includes(prepush.state ?? "")) {
    return focus(
      "machine",
      delivery?.prepush_runtime?.state === "recovering"
        ? (delivery.prepush_runtime.message || "服务正在恢复 Build-Fix")
        : prepush.message?.trim()
        || `正在进行 Build-Fix${prepush.round ? `（第 ${prepush.round} 轮）` : ""}`,
      "记录本次验证结果后继续当前工作",
      "agent",
      58,
    );
  }
  if (task.status === "verifying") {
    return focus(
      "external",
      delivery?.waiting_on?.trim() || "权威流水线正在验证当前提交",
      "验证通过后进入等待合入",
      "platform",
      45,
    );
  }
  if (task.status === "queued" && (task.blocked_by?.length ?? 0) > 0) {
    return focus(
      "external",
      `等待 ${task.blocked_by!.length} 个前置任务完成`,
      "依赖满足后自动开始",
      "platform",
      35,
    );
  }
  if (task.status === "queued") {
    return focus(
      "machine",
      // 排队真相压过 detail:重跑后 detail 是"人工重跑…",拿它当标题
      // 会让排队的单看起来像在推进(实锤:并发 2 跑 3 单,用户找不到
      // 哪单在排队)。
      task.queue_position
        ? `排队等待执行资源(第 ${task.queue_position} 位)`
        : "任务正在执行队列中等待",
      task.detail?.trim() || "获得执行资源后自动开始",
      "platform",
      30,
    );
  }
  if (task.status === "running") {
    const milestone = task.progress?.milestone;
    const label = milestone?.title || task.progress?.step
      || task.progress?.current_phase;
    if (milestone?.event === "blocked") {
      return focus(
        "machine",
        milestone.reason?.trim() || `${label ?? "当前实现任务"}遇到阻塞`,
        "Agent 正在定位并尝试解除阻塞",
        "agent",
        65,
      );
    }
    return focus(
      "machine",
      label ? `Agent 正在推进：${label}` : "Agent 正在推进任务",
      "当前工作完成后自动进入下一步",
      "agent",
      40,
    );
  }
  return focus(
    "inactive",
    task.detail?.trim() || "等待新的任务状态",
    "无需人工操作",
    "none",
    0,
  );
}
