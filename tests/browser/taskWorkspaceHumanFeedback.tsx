import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
import type { Annotation, ConversationItem, FeedbackRecord, TaskSummary } from "../../web/src/api";

const scenario = new URL(location.href).searchParams.get("scenario") ?? "pipeline";
const source = scenario === "build_fix" ? "build_fix" : "pipeline";
const owner = scenario !== "readonly";
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const errors: string[] = [];
const mutations: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

const summary = "DT 覆盖率 0%，流水线验证未通过";
const rootCause = "DT增量覆盖率0.00%，UT未部署到流水线采集位置且需核对产品链接库。";
const plan = "方案A：调整UT部署位置及CMakeLists链接库配置，推送后使用绑定SHA的流水线验证。";
const evidence = "容器缺少DEVELOPENV_ROOT，无法本地编译，需要责任人确认该处理方案。";
const followUp = "核对过程：流水线报告显示用例收集数量为零，覆盖率阶段仍生成了一个空报告。构建配置中的源文件目录与当前仓库实际目录不一致，测试命令使用的工作目录也没有对应的 DT 用例，因此这次结果无法说明产品代码是否被测试。需要把报告中的源码路径、构建阶段工作目录、用例入口和产物上传目录一起核对，不能只调整报告展示方式。\n\n"
  + "具体处理：责任人提供可运行的 DT 用例入口及其依赖环境，确认本次需求涉及哪些产品模块，再明确这些模块在覆盖率工具中的统计范围。Agent 根据这些信息修改构建配置，检查编译产物是否开启插桩，运行用例后保留用例数量、执行结果、覆盖率原始文件和最终报告。若环境缺少数据或依赖，先说明缺少的内容，由责任人决定如何补齐，再恢复验证；当前任务的代码和已有 MR 均继续保留。\n\n"
  + "复核方式：重新运行后对比报告中的源码文件列表与本次修改范围，确认有效用例确实执行并产生覆盖率数据。对于没有被执行的分支，需要补充对应的输入和预期结果，不能使用修改阈值或排除产品目录来消除红灯。流水线仍使用原有验收门槛，CodeHub 中的检视意见由检视人另行确认。两种反馈应各自保留处理记录，处理了流水线问题不等于完成代码检视，代码检视回复也不能代替覆盖率验证。";
const endMarker = "恢复后验收：覆盖率报告包含本次产品代码与有效 DT 用例，流水线按原阈值重新核验。";
const resolution = [rootCause, plan, evidence, followUp, endMarker].join("\n\n");
const machineItem: FeedbackRecord = {
  id: "pipeline-dt-coverage", batch_id: "batch-dt", source,
  source_id: "pipeline-464", source_revision: 1, observed_sha: "1234567890abcdef",
  summary, resolution, verification: "pipeline", status: "needs_human",
  updated_at: "2026-10-10T10:00:00Z",
};
const mrItem: FeedbackRecord = {
  id: "mr-discussion-one", batch_id: "batch-mr", source: "mr_discussion",
  source_id: "discussion-1", source_revision: 1, observed_sha: "1234567890abcdef",
  summary: "CodeHub 检视：请补充失败重试的边界说明", verification: "mr_discussion",
  status: "open", author: "reviewer", file: "src/retry.ts", line: 32,
  updated_at: "2026-10-10T09:58:00Z",
};
const importedMr: Annotation = {
  id: "imported-mr-discussion", author: "reviewer", created_at: mrItem.updated_at,
  artifact: "__workspace_diff__", file: mrItem.file!, line: mrItem.line!, anchor: "retry", kind: "code",
  note: mrItem.summary, status: "sent", sent_via: "review_repair",
  external_review: { scope: "mr-464", discussion_id: mrItem.source_id,
    content_key: "review-one", mr_url: "https://codehub.example.test/merge_requests/464" },
};
const externalEvent: ConversationItem = {
  kind: "external", id: "pipeline-feedback-receipt", ts: machineItem.updated_at, source,
  items: [{ id: machineItem.id, summary, status: "needs_human", resolution }],
};
const task: TaskSummary = {
  id: "task-464", title: "DT 覆盖率验证", ticket: "REQ464",
  requirement: "修正覆盖率统计并保证流水线通过", status: "verifying",
  status_label: "交付验证中", luban_account: "owner", repair_stopped: true,
  created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T10:00:00Z",
  focus: { kind: "human_action", headline: "流水线需要人工处理",
    next_action: "补充 DT 用例目录和统计范围", owner: "responsible",
    needs_attention: true, priority: 1 },
  progress: { phases: [], current_index: -1, current_phase: "交付验证",
    step: "等待流水线验证结果" },
  feedback: [machineItem, mrItem],
  delivery: { mr_url: "https://codehub.example.test/merge_requests/464", mr_state: "打开",
    pipeline: "失败", waiting_on: "反馈中仍有需要人工判断的条目", stalled: "反馈中仍有需要人工判断的条目",
    loop: { round: 1, state: "halted", kind: "ci",
      failure: "DT coverage 0% is below the required threshold" } },
};

window.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method && !["GET", "HEAD"].includes(init.method)) mutations.push(path);
  let value: unknown;
  if (/\/artifacts(?:\?|$)/.test(path)) value = [];
  else if (path.endsWith("/conversation")) value = { items: [externalEvent], problems: [], events_seen: 1 };
  else if (path.endsWith("/annotations")) value = {
    items: scenario === "imported" ? [importedMr] : [], checks: [],
    closures: scenario === "imported" ? [{ id: importedMr.id, tone: "waiting", text: "处理中",
      bucket: "agent", delivery_text: "", verdict_ready: false, actionable: false,
      can_verify: false, can_override_verify: false, can_override_drop: false, can_route: false,
      needs_clarification: false, receipt_missing: false }] : [],
  };
  else if (path.endsWith("/reviews") || path === "/auth/committers") value = [];
  else if (path === "/auth/people") value = [
    { username: "owner", display_name: "任务责任人" },
    { username: "observer", display_name: "只读同事" },
    { username: "reviewer", display_name: "CodeHub 检视人" },
  ];
  else if (path.endsWith("/developer-assistant")) value = {
    state: "idle", messages: [], tools: [],
    availability: { available: false, code: "core_unavailable", mode: "unavailable",
      reason: "当前使用补充处理要求恢复主任务" },
  };
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
};

const root = createRoot(document.getElementById("app")!);
const visible = (element: Element) => Boolean(element.getClientRects().length);
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => visible(element) && element.textContent?.trim() === label);
async function until(test: () => unknown, message: string) {
  for (let i = 0; i < 70 && !test(); i++) await pause();
  check(test(), message);
}
async function click(label: string, within: ParentNode = document) {
  const target = button(label, within);
  check(target && !target.disabled, `missing enabled ${label}`);
  target!.click(); await pause();
}

async function run() {
  root.render(<TaskWorkspace task={task} viewerUsername={owner ? "owner" : "observer"}
    canOperate={owner} canOverride={false} canCollaborate={owner}
    canRequestReview={false} onChanged={() => {}} onClose={() => {}} />);
  await until(() => document.querySelector('[aria-label="交付验证"]'), "validation card did not render");
  const card = document.querySelector<HTMLElement>('[aria-label="交付验证"]')!;
  const human = card.querySelector<HTMLElement>('[aria-label="流水线人工处理"]');
  check(human, "human pipeline feedback missing from the main validation card");
  const body = human!.textContent ?? "";
  check(resolution.length > 500, "fixture must exercise a long Agent resolution");
  for (const text of [summary, rootCause, plan, evidence, endMarker]) {
    check(body.includes(text), `main card truncated or omitted feedback: ${text}`);
  }
  const response = [...human!.querySelectorAll<HTMLParagraphElement>("p")]
    .find(element => element.textContent?.includes(endMarker));
  check(response && visible(response) && !response.closest("details:not([open])"),
    "long resolution tail is hidden or collapsed by default");
  check(!body.includes(mrItem.summary), "CodeHub discussion was treated as pipeline human feedback");
  const cardText = card.textContent ?? "";
  await until(() => card.textContent?.includes("代码检视 1 条"),
    "MR open count was not labeled as code review or imported twice");
  check(cardText.includes("流水线与交付反馈 1 条"), "pipeline count was mixed with CodeHub review count");
  check(!cardText.includes("需要人时会在这里出卡"), "active human feedback still uses the generic waiting copy");

  await until(() => document.querySelector('[aria-label="流水线人工处理回执"]'),
    "conversation did not render the external pipeline human receipt");
  const receipt = document.querySelector<HTMLElement>('[aria-label="流水线人工处理回执"]')!;
  check(receipt.textContent?.includes(`${source === "build_fix" ? "Build-Fix" : "流水线"}有 1 项需要人工判断`),
    "conversation classified the pipeline receipt as code review");
  for (const text of [summary, rootCause, plan, evidence, endMarker]) {
    check(receipt.textContent?.includes(text), `conversation truncated or omitted receipt: ${text}`);
  }
  const receiptTail = [...receipt.querySelectorAll<HTMLParagraphElement>("p")]
    .find(element => element.textContent?.includes(endMarker));
  check(receiptTail && visible(receiptTail) && !receiptTail.closest("details:not([open])"),
    "conversation hides the full Agent response by default");

  if (owner) {
    await until(() => document.querySelector(".ws-composer textarea:not([disabled])"),
      "owner Composer did not become available");
    // 等初次挂载的自动聚焦完成，再模拟用户点击恢复入口。
    await pause(100);
    await click("我来接手");
    await until(() => document.querySelector('.ws-composer [role="tab"][aria-selected="true"]')?.textContent?.trim() === "我来接手",
      "fixture did not switch Composer away from the main Agent");
    await click("补充处理要求", card);
    await until(() => document.querySelector('.ws-composer [role="tab"][aria-selected="true"]')?.textContent?.trim() === "说给 Agent"
      && document.querySelector(".ws-composer textarea:not([disabled])"),
    "supplement action did not return to the existing editable Composer");
    check(!mutations.length, "opening the supplement action automatically submitted an instruction");
  } else {
    check(!button("补充处理要求", card), "observer can resume the task");
    check(!document.querySelector(".ws-composer textarea"), "observer can write to the task Composer");
    check(card.textContent?.includes("联系任务责任人"), "observer is instructed to use unavailable task actions");
  }
  await click("查看流水线反馈", card);
  await until(() => document.querySelector("#ws-review-canvas")?.textContent?.includes(summary),
    "pipeline feedback action did not open the existing review pane");
  const review = document.querySelector<HTMLElement>("#ws-review-canvas")!;
  check(review.textContent?.includes(rootCause) && review.textContent?.includes(plan),
    "review pane did not retain the complete Agent response");
  check(!review.textContent?.includes(mrItem.summary), "pipeline feedback pane included CodeHub discussion");
  check(document.querySelector<HTMLButtonElement>('button[aria-label="检视意见"]')?.getAttribute("aria-expanded") === "true",
    "pipeline feedback action did not expand the review pane");
  check(!mutations.length, "read-only feedback actions mutated the task");
  check(document.documentElement.scrollWidth <= window.innerWidth, "workspace overflows the desktop viewport");
  check(!errors.length, errors.join("; "));
  root.unmount();
  return { passed: true, scenario, width: innerWidth, owner, classified: true, completeSummary: true,
    conversationReceipt: true, importedMrDeduplicated: scenario === "imported" };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { root.unmount(); document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
