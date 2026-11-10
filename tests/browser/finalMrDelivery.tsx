import { createRoot } from "../../web/node_modules/react-dom/client";
import { DeliveryAnalytics } from "../../web/src/DeliveryAnalytics";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
import type { TaskSummary } from "../../web/src/api";
import type { DeliveryAnalysisRow, MrComparisonDetail } from "../../src/deliveryAnalyticsTypes";

const root = createRoot(document.getElementById("app")!);
const initialUrl = "https://codehub.example.test/orders/merge_requests/114";
const finalUrl = "https://codehub.example.test/orders/merge_requests/126";
const scenario = new URLSearchParams(location.search).get("scenario") ?? "task";
const when = "2026-11-04T02:36:00Z";
const sourceFile = "src/order/retry.ts";
let task: TaskSummary = { id: "task-orders", title: "订单查询超时重试", requirement: "订单查询超时后再尝试一次", status: "await_merge",
  status_label: "等待合入", ticket: "REQ-1846", luban_account: "chen", created_at: when,
  delivery: { source_branch: "feature/order-timeout", target_branch: "main", mr_url: initialUrl, mr_state: "打开", initial_mr: { url: initialUrl, head: "a".repeat(40) } } };
const row: DeliveryAnalysisRow = { id: task.id, title: task.title!, delivery_id: "r2", at: when, completed_at: when, repo: "orders",
  modules: [], merged: true, mr_url: finalUrl, initial_mr_url: initialUrl, mr_comparison: { method: "patch", initial_head: "a".repeat(40), final_head: "b".repeat(40),
    retained: 8, removed: 1, added: 4, files: [
      { path: sourceFile, retained: 7, removed: 1, added: 3, changed: true },
      { path: "tests/retry.test.ts", retained: 1, removed: 0, added: 1, changed: true },
    ] } };
const metric = (first: number, pipeline: number, review: number): NonNullable<DeliveryAnalysisRow["metric"]> => ({
  version: 1, base: "c".repeat(40), head: "a".repeat(40), first: "d".repeat(40), collected_at: when,
  excluded_files: 1, deleted: 2, retained: { first, pipeline, review, other: 0 }, rework: { first: 0, pipeline: 0, review: 0, other: 0 },
  commits: [{ sha: "a".repeat(40), at: when, subject: "补充金额精度校验", origin: "review", additions: review, deletions: 2 }],
});
const base: DeliveryAnalysisRow = { id: "task-money", title: "订单金额精度校验", at: when, completed_at: when,
  repo: "orders", languages: ["typescript"], modules: [], business_module: { id: "order", name: "订单管理" }, merged: true };
const coverageRows: DeliveryAnalysisRow[] = [
  { ...base, parent_id: "orders", parent_title: "订单结算", mr_url: initialUrl, initial_mr_url: initialUrl,
    external_collaboration: true, metric: metric(30, 3, 7), final_code_lines: 40 },
  { ...base, id: "task-export", title: "导出订单列表", parent_id: "orders", parent_title: "订单结算", metric: metric(18, 0, 2) },
  { ...base, id: "task-timeout", title: "支付超时后重试", business_module: { id: "payment", name: "支付" },
    mr_url: finalUrl, initial_mr_url: initialUrl, final_code_lines: 12 },
  { ...base, id: "task-cleanup", title: "移除过时配置", final_code_lines: 0, final_deleted_lines: 4 },
  { ...base, id: "task-invoices", title: "发票批量查询" },
];
const comparison: MrComparisonDetail = { comparison_basis: "head", truncated: false, files: [
  { path: sourceFile, change_patch: "@@ -12,3 +12,5 @@\n   if (response.timedOut) {\n-    return fail(response);\n+    const retry = await queryOrder(id);\n+    return retry.ok ? retry.order : fail(retry);\n   }",
    initial_patch: "@@ -12,0 +12,1 @@\n+    return fail(response);", final_patch: "@@ -12,0 +12,2 @@\n+    const retry = await queryOrder(id);\n+    return retry.ok ? retry.order : fail(retry);", truncated: false },
  { path: "tests/retry.test.ts", change_patch: "+expect(attempts).toBe(2);", initial_patch: "", final_patch: "+expect(attempts).toBe(2);", truncated: false },
] };
const calls: Array<{ url: string; method: string; body?: string }> = [];
let rejectLink = true;
window.fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: init?.body?.toString() });
  if (url === "/tasks/task-orders/final-mr") {
    if (rejectLink) return Response.json({ error: "最终 MR 不属于当前仓库" }, { status: 400 });
    task = { ...task, status: "await_merge", status_label: "等待合入", delivery: { ...task.delivery, final_mr: { id: 126, repo: "orders", url: finalUrl,
      source_branch: "dev/retry-order", target_branch: "main", state: "opened" } } };
    return Response.json(task);
  }
  if (scenario === "final-only-analysis") {
    if (url === "/delivery-analytics") return Response.json({ generated_at: when, rows: [{ ...row, initial_mr_url: undefined,
      final_code_lines: 1, final_deleted_lines: 1, external_collaboration: true,
      mr_comparison: { method: "final", final_head: "b".repeat(40), files: [{ path: sourceFile, changed: true, added: 1, removed: 1 }] } }] });
    if (url.endsWith("/final-mr-comparison?generation=r2")) return Response.json({ comparison_basis: "final", truncated: false,
      files: [{ path: sourceFile, change_patch: "@@ -8 +8 @@\n-return fail(response);\n+return retryOrder(id);", initial_patch: "", final_patch: "", truncated: false }] });
  }
  if (scenario === "local-snapshot") {
    if (url === "/delivery-analytics") return Response.json({ generated_at: when, rows: [{ ...row, final_code_lines: 12,
      metric: { ...metric(8, 1, 3), commits: [], initial_implementation: { basis: "content_comparison" },
        content_comparison: { reference: "local_snapshot", base: "c".repeat(40), head: "a".repeat(40), captured_at: when } },
      mr_comparison: { ...row.mr_comparison, reference: "local_snapshot" } }] });
    if (url.endsWith("/final-mr-comparison?generation=r2")) return Response.json({ ...comparison, reference: "local_snapshot" });
  }
  if (scenario === "platform-push") {
    const first = "a".repeat(40), head = "b".repeat(40);
    if (url === "/delivery-analytics") {
      const sample: DeliveryAnalysisRow = { ...row, initial_mr_url: undefined, external_collaboration: true, languages: ["typescript"],
        final_code_lines: 10, final_deleted_lines: 0,
        mr_comparison: { method: "ancestry", reference: "platform_push", initial_head: first, final_head: head, retained: 7, removed: 1, added: 3,
          files: [{ path: sourceFile, changed: true, retained: 7, removed: 1, added: 3 }] },
        metric: { ...metric(7, 1, 2), first, head, deleted: 0, excluded_files: 0, initial_implementation: { end: first, basis: "platform_push" },
          rework: { first: 0, pipeline: 1, review: 3, other: 0 }, commits: [
            { sha: first, at: when, subject: "处理订单查询超时", origin: "first", additions: 8, deletions: 0 },
            { sha: "e".repeat(40), at: when, subject: "修复流水线发现的错误处理缺失", origin: "pipeline", additions: 1, deletions: 0 },
            { sha: head, at: when, subject: "按检视意见重试超时查询", origin: "review", additions: 2, deletions: 1 },
          ] },
      };
      return Response.json({ generated_at: when, rows: [sample] });
    }
    if (url.endsWith("/final-mr-comparison?generation=r2")) {
      const before = ["export async function order(id) {", "  const response = await queryOrder(id);", "  if (response.timedOut) {",
        "    return fail(response);", "  }", "  if (!response.ok) return fail(response);", "  return response.order;", "}"];
      const retry = ["    const retry = await queryOrder(id);", "    if (!retry.ok) return fail(retry);", "    return retry.order;"];
      const after = [...before.slice(0, 3), ...retry, ...before.slice(4)];
      const additions = (lines: string[]) => lines.map(line => "+" + line).join("\n");
      return Response.json({ comparison_basis: "head", reference: "platform_push", truncated: false, files: [{ path: sourceFile, truncated: false,
        change_patch: "@@ -3,3 +3,5 @@\n " + before[2] + "\n-" + before[3] + "\n" + additions(retry) + "\n " + before[4],
        initial_patch: "@@ -0,0 +1,8 @@\n" + additions(before), final_patch: "@@ -0,0 +1,10 @@\n" + additions(after),
      }] });
    }
  }
  if (url === "/delivery-analytics") return Response.json({ generated_at: when, rows: scenario.startsWith("origin-") ? coverageRows : [row] });
  if (url === "/tasks/task-orders/final-mr-comparison?generation=r2") return Response.json(comparison);
  if (url === "/technology-stacks") return Response.json({ stacks: [] });
  if (url.endsWith("/developer-assistant")) return Response.json({ state: "idle", messages: [], tools: [],
    availability: { available: false, code: "host_wait", mode: "unavailable", reason: "请先暂停当前开发任务" } });
  if (url.includes("/annotations")) return Response.json({ items: [], checks: [], closures: [] });
  if (url.includes("/conversation")) return Response.json({ items: [], problems: [] });
  if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url === "/auth/people" || url === "/auth/committers") return Response.json([]);
  return Response.json({}, { status: 404 });
};

function assert(result: unknown, message: string): asserts result {
  if (!result) throw new Error(message);
}
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(test: () => unknown, message: string) {
  for (let index = 0; index < 70 && !test(); index++) await pause();
  assert(test(), message);
}
function button(label: string) {
  const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  assert(target, "未找到按钮 " + label);
  return target;
}
function renderWorkspace(owner = true, admin = false) {
  root.render(<TaskWorkspace task={task} viewerUsername={owner ? "chen" : admin ? "admin" : "guest"} canOverride={admin} canCollaborate={owner}
    canRequestReview={false} canOperate={owner || admin} onChanged={() => renderWorkspace(owner)} onClose={() => {}} />);
}
async function verifyCoverage() {
  root.render(<main className="tw-root p-8"><DeliveryAnalytics onOpenTask={() => {}} /></main>);
  await until(() => document.querySelector(".delivery-task-link"), "团队交付分析应加载");
  const panel = document.querySelector<HTMLElement>('[aria-label="交付代码来源"]')!;
  const taskRow = (id: string) => {
    const label = [...document.querySelectorAll(".delivery-task-link b")].find(item => item.textContent === id);
    assert(label, "应显示任务 " + id);
    return label.closest("tr")!;
  };
  const team = panel.textContent ?? "";
  assert(team.includes("交付代码行数 72 行") && team.includes("已统计行数 4/5 次交付，已追溯来源 2/5 次交付"), "分别展示包含纯行数样本的总行数和归因覆盖");
  assert(team.includes("占比按已追溯的 60 行计算") && panel.querySelector(".delivery-donut-center strong")?.textContent === "80.0%", "首次实现占比为 48/60，按可归因行数加权");
  assert(panel.querySelector(".delivery-legend")?.textContent?.includes("检视修改9 行15.0%"), "三类图例包含检视与无法确认流水线原因的后续修改");
  assert(taskRow("task-money").textContent?.includes("平台外协作"), "同一 MR 有平台外协作事实时要展示");
  for (const id of ["orders", "task-export", "task-timeout"]) {
    assert(!taskRow(id).textContent?.includes("平台外协作"), "主任务及缺少平台外协作事实的任务不能被标记 " + id);
  }
  assert(taskRow("task-timeout").cells[3].textContent === "12 行" && taskRow("task-timeout").cells[4].textContent === "—", "只有行数时不能伪造归因占比");
  assert(taskRow("task-cleanup").cells[3].textContent === "0 行" && taskRow("task-invoices").cells[3].textContent === "—", "实测零行和缺失必须区分");
  const module = [...document.querySelectorAll(".delivery-module-row")].find(item => item.textContent?.includes("支付"));
  assert(module?.textContent?.includes("16.7%") && module.textContent.includes("12 行"), "仅有最终行数的交付应进入业务模块行数和占比");
  if (scenario === "origin-team") return;

  const counted = scenario === "origin-count-only";
  await until(() => document.querySelector(".delivery-detail-body"), "详情应打开");
  const detail = document.querySelector(".delivery-detail-body")!;
  const sources = detail.querySelector('[aria-label="交付代码来源"]')!;
  const labels = [...sources.querySelectorAll(".delivery-legend > div")];
  assert(labels.length === 3, "任务详情保留三类来源");
  if (counted) {
    assert(!detail.textContent?.includes("平台外协作"), "不能用不同 MR 地址推断协作方式");
    assert(sources.textContent?.includes("交付代码行数 12 行") && sources.textContent.includes("已追溯来源 0/1"), "详情须保留已知最终行数");
    assert(labels.every(item => item.querySelector("b")?.textContent === "—" && item.querySelector("small")?.textContent === "—"), "未知的来源行数及占比不能显示成零");
  } else {
    assert(detail.textContent?.includes("平台外协作") && detail.textContent.includes("按整个最终版本统计"), "详情须解释平台外协作标识的影响");
    assert(sources.textContent?.includes("交付代码行数 40 行") && sources.textContent.includes("已追溯来源 1/1"), "归因覆盖一次完整交付");
    assert(sources.querySelector(".delivery-donut-center strong")?.textContent === "75.0%", "详情展示该交付的占比");
    assert(detail.querySelector(".delivery-timeline")?.textContent?.includes("检视修改"), "提交记录和团队沿用相同分类");
  }
}
async function run() {
  if (scenario === "local-snapshot") {
    root.render(<main className="tw-root p-8"><DeliveryAnalytics onOpenTask={() => {}} /></main>);
    await until(() => document.querySelector('pre[aria-label="从本地快照到最终版代码"]'), "应展示本地快照文件差异");
    assert(document.body.textContent?.includes("关联最终 MR 时的本地快照"), "应解释内容比较基准");
    assert(!document.querySelector(".delivery-timeline"), "内容比较不显示空时间线");
    assert(document.querySelector('[aria-label="交付代码来源"]')?.textContent?.includes("首次实现"), "应显示三类来源");
  } else if (scenario === "platform-push") {
    root.render(<main className="tw-root p-8"><DeliveryAnalytics onOpenTask={() => {}} /></main>);
    await until(() => document.querySelector('pre[aria-label="从平台已推送版本到最终版代码"]'), "应显示平台推送版本到最终 MR 的差异");
    const panel = document.querySelector('[aria-label="平台已推送版本与最终版的代码差异"]')!;
    const delta = panel.querySelector("pre");
    assert(delta?.textContent?.includes("-    return fail(response);") && delta.textContent.includes("+    const retry"),
      "差异必须包含平台已推送版本之后的实际代码改动");
    assert(panel.querySelectorAll("a").length === 1 && panel.querySelector("a")?.href === finalUrl && !panel.textContent?.includes("初版 MR"),
      "没有原 MR 时只链接最终 MR，不能把平台推送版本标为初版 MR");
    const sources = document.querySelector('.delivery-detail-body [aria-label="交付代码来源"]')!;
    const legend = [...sources.querySelectorAll(".delivery-legend > div")].map(item => item.textContent);
    assert(sources.textContent?.includes("交付代码行数 10 行") && sources.textContent.includes("已追溯来源 1/1"), "最终 MR 的 10 行均须计入来源分析");
    assert(legend.join("|") === "首次实现7 行70.0%|流水线修复1 行10.0%|检视修改2 行20.0%", "三类占比应按最终保留的 7、1、2 行计算");
    panel.scrollIntoView({ block: "start" });
  } else if (scenario === "final-only-analysis") {
    root.render(<main className="tw-root p-8"><DeliveryAnalytics onOpenTask={() => {}} /></main>);
    await until(() => document.querySelector('pre[aria-label="相对目标分支的改动代码"]'), "只有最终 MR 时应自动显示代码改动");
    const panel = document.querySelector('[aria-label="最终 MR 的代码改动"]')!;
    assert(panel.textContent?.includes("+return retryOrder(id);") && !panel.textContent.includes("初版"), "只呈现最终 MR 有证据的内容");
    assert(panel.querySelector('a')?.href === finalUrl, "应链接实际 MR");
  } else if (scenario.startsWith("origin-")) {
    await verifyCoverage();
  } else if (new URLSearchParams(location.search).has("deliveryTask")) {
    root.render(<main className="tw-root p-8"><DeliveryAnalytics onOpenTask={() => {}} /></main>);
    await until(() => document.querySelector('pre[aria-label="从初版到最终版代码"]'), "打开分析详情应自动展示首个变化文件");
    const panel = document.querySelector('[aria-label="初版与最终版的代码差异"]')!;
    assert(panel.textContent?.includes("-    return fail(response);") && panel.textContent?.includes("+    const retry"), "差异须含实际前后代码");
    assert(panel.querySelector('a')?.href === initialUrl && panel.querySelectorAll('a')[1]?.href === finalUrl, "必须链接两份真实 MR");
    assert(document.querySelector('.delivery-detail-body [aria-label="交付代码来源"] h2')?.textContent?.includes("交付代码行数 —"), "未取到交付行数时不可报零行");
    button("tests/retry.test.ts").click();
    await until(() => document.querySelector('pre[aria-label="从初版到最终版代码"]')?.textContent?.includes("toBe(2)"), "切换文件应更新代码");
    assert(calls.filter(call => call.url.includes("final-mr-comparison")).length === 1, "同一轮交付的证据按需读取一次");
    button(sourceFile).click(); await pause();
  } else if (scenario === "no-initial-link" || scenario === "no-initial-merged") {
    const original: TaskSummary = { ...task, status: "running", status_label: "开发中", baseline: "main", delivery: undefined };
    task = original;
    renderWorkspace(false);
    await until(() => [...document.querySelectorAll("button")].some(el => el.textContent?.startsWith("任务详情")), "无交付记录时也应能打开任务详情");
    button("任务详情 ↗").click();
    await until(() => document.querySelector('[data-slot="dialog-content"]'), "任务详情应打开");
    const hasLinkAction = () => [...document.querySelectorAll("button")].some(item => item.textContent === "关联最终 MR");
    assert(!hasLinkAction(), "访客不能关联最终 MR");
    const excludedCases: Partial<TaskSummary>[] = [{ origin: "issue" }, { requirement_analysis_requested: true },
      { status: "coordinating" }, { repositories: ["orders", "payment"] }, { status: "completed" }, { status: "canceled" }];
    for (const excluded of excludedCases) {
      task = { ...original, ...excluded };
      renderWorkspace(); await pause();
      assert(!hasLinkAction(), "此任务不能关联最终 MR " + JSON.stringify(excluded));
    }
    task = original;
    renderWorkspace(); await pause(); button("关联最终 MR").click(); await pause();
    const input = document.querySelector<HTMLInputElement>('input[type="url"]')!;
    assert(!document.querySelector('[data-slot="dialog-content"] a[href="' + initialUrl + '"]'), "没有初版时不能生成初版 MR 链接");
    assert(button("关联并切换为只读跟踪").disabled, "需要先提供最终 MR 链接");
    assert(!calls.some(call => call.method === "POST"), "打开表单不会停止云端工作");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, finalUrl);
    input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    if (scenario === "no-initial-merged") {
      rejectLink = false;
      button("关联并切换为只读跟踪").click();
      const dialog = document.querySelector('[data-slot="dialog-content"]')!;
      await until(() => dialog.querySelector('a[href="' + finalUrl + '"]'), "保存成功后应只显示实际最终 MR");
      assert(!dialog.textContent?.includes("初版 MR") && !dialog.textContent?.includes("尚未记录合入请求"), "已关联时不可显示虚假的初版或空态");
      button("关闭任务详情").click(); await pause();
      assert(document.querySelector('a[href="' + finalUrl + '"]')?.textContent?.includes("打开最终 MR"), "工作台无需原 MR 就能直接打开最终 MR");
      task = { ...task, status: "completed", status_label: "已完成", completed_at: when,
        delivery: { ...task.delivery, mr_state: "已合入", final_mr: { ...task.delivery!.final_mr!, state: "merged" } } };
      renderWorkspace(); await pause();
      const continuation = document.querySelector('[aria-label="继续修改与交付历史"]');
      assert(continuation && !continuation.querySelector("button") && continuation.textContent?.includes("工作分支")
        && continuation.textContent.includes("main"), "尚无云端工作分支时，应显示从目标分支新建任务");
      button("任务详情 ↗").click(); await pause();
      const analysis = document.querySelector('a[href="/?deliveryAnalysis=1&deliveryTask=task-orders"]');
      assert(analysis?.textContent?.includes("查看交付分析") && !analysis.textContent.includes("两版"), "只有最终版时应打开交付分析");
      assert(!document.querySelector('a[href="' + initialUrl + '"]') && !hasLinkAction(), "合入后不能补出初版或更换最终 MR");
    }
  } else if (scenario === "task") {
    const initialTask = task;
    renderWorkspace();
    await until(() => [...document.querySelectorAll("button")].some(el => el.textContent?.startsWith("任务详情")), "应能从工作台打开任务详情");
    button("任务详情 ↗").click(); await until(() => document.querySelector('[data-slot="dialog-content"]'), "打开详情");
    button("关联最终 MR").click(); await pause();
    const field = document.querySelector<HTMLInputElement>('input[type="url"]')!;
    const form = field.closest("form")!;
    assert(button("关联并切换为只读跟踪").disabled, "首次关联应说明会切换为只读，填入链接才可提交");
    assert(!form.querySelector("p"), "首次关联表单不应附加平台只读或下一轮分支说明");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, finalUrl);
    field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    button("关联并切换为只读跟踪").click();
    await until(() => document.body.textContent?.includes("最终 MR 不属于当前仓库"), "被拒绝时应留在表单并显示原因");
    rejectLink = false;
    button("关联并切换为只读跟踪").click();
    await until(() => document.querySelector('a[href="' + finalUrl + '"]'), "成功后出现最终 MR 链接");
    assert(document.querySelector('a[href="' + initialUrl + '"]'), "关联后原 MR 仍可打开");
    assert(calls.filter(call => call.method === "POST").every(call => call.url === "/tasks/task-orders/final-mr" && JSON.parse(call.body!).url === finalUrl), "关联只提交最终链接");
    renderWorkspace(false); await pause();
    assert(![...document.querySelectorAll("button")].some(el => el.textContent === "更换最终 MR"), "只读访客不可更换最终 MR");
    renderWorkspace(false, true); await pause();
    assert(button("更换最终 MR"), "管理员可更换尚未合入的最终 MR");
    // 截图保留用户首次关联时看到的表单。
    task = initialTask;
    renderWorkspace(); await pause(); button("关联最终 MR").click(); await pause();
  } else {
    const verifying = scenario === "verifying";
    const state = scenario === "tracking" ? "opened" : scenario === "closed" ? "closed" : "merged";
    const target = scenario === "different-target" ? "release/2.0" : scenario === "unknown-target" ? "" : "main";
    task = { ...task, status: verifying ? "verifying" : state === "merged" ? "completed" : "await_merge",
      status_label: verifying ? "正在核对" : state === "merged" ? "已完成" : "等待合入", completed_at: state === "merged" ? when : undefined,
      delivery: { ...task.delivery, stalled: verifying ? "任务完成记录暂时无法保存" : undefined, mr_state: state === "merged" ? "已合入" : state === "closed" ? "已关闭" : "等待合入",
        final_mr: { id: 126, repo: "orders", url: finalUrl, source_branch: "dev/retry-order", target_branch: target, state } } };
    renderWorkspace();
    if (verifying) {
      await until(() => document.body.textContent?.includes("任务完成记录暂时无法保存"), "显示已合入但登记失败的事实");
      assert(!document.querySelector('[aria-label="交付验证"]') && !document.body.textContent?.includes("按原流程重试"), "关联后验证异常不可恢复原自动修复流程");
      assert(document.querySelector('a[href="' + finalUrl + '"]'), "故障时可查看已合入的最终 MR");
      assert(!document.querySelector('button[title^="取消后"]'), "已合入不能再取消任务");
      button("任务详情 ↗").click(); await pause();
      assert(![...document.querySelectorAll("button")].some(el => el.textContent === "更换最终 MR"), "已合入待登记不能随意改绑");
      button("关闭任务详情").click(); await pause();
    } else if (state !== "merged") {
      await until(() => document.querySelector('a[href="' + finalUrl + '"]'), "工作台应能打开正在跟踪的最终 MR");
      const mrLink = [...document.querySelectorAll<HTMLAnchorElement>("a")].find(item => item.href === finalUrl && item.textContent?.includes("打开最终 MR"));
      const line = mrLink?.parentElement;
      assert(line?.textContent?.includes(state === "closed" ? "最终 MR 已关闭" : "等待最终 MR 合入"), "最终 MR 链接旁应显示当前状态");
      assert(!line.querySelector("p"), "正常等待或关闭时，工作台不应重复显示操作说明");
      button("任务详情 ↗").click(); await pause();
      const mrRow = document.querySelector('[data-slot="dialog-content"] a[href="' + finalUrl + '"]')?.closest("dd");
      assert(mrRow?.textContent?.includes(state === "closed" ? "已关闭" : "待合入"), "任务详情应保留最终 MR 状态与链接");
      assert(!mrRow.querySelector("small, p") && !mrRow.textContent.includes("dev/retry-order"), "合入请求行不应附加分支和下一步说明");
      if (state === "closed") {
        button("更换最终 MR").click(); await pause();
        const input = mrRow.querySelector<HTMLInputElement>('input[type="url"]');
        assert(input?.value === finalUrl && !button("保存更换").disabled, "更换表单应预填现有关联，可保存更换");
        assert(!mrRow.querySelector("form p"), "更换表单不应附加只读或下一轮说明");
      }
    } else {
      await until(() => document.querySelector('[aria-label="继续修改与交付历史"]'), "在任务完成页展示下一轮提示");
      const panel = document.querySelector('[aria-label="继续修改与交付历史"]')!;
      if (scenario === "completed") {
        assert(panel.textContent?.includes("从 main 分支的最新版本开始"), "提示下一轮实际目标分支");
        renderWorkspace(false, true); await pause();
        assert(![...panel.querySelectorAll("button")].some(item => item.textContent === "继续修改"), "管理员不能代责任人继续修改");
        renderWorkspace(); await pause();
        button("继续修改").click(); await pause();
        assert(panel.textContent?.includes("云端工作区未提交的代码修改") && panel.textContent.includes("远端仍有同名工作分支")
          && panel.textContent.includes("新建任务"), "开始下一轮前应说明云端会重建工作分支，以及远端分支保留时如何继续");
        button("取消").click(); await pause();
      } else {
        assert(!panel.querySelector("button") && !panel.querySelector("textarea"), "缺少或不同目标分支时不应显示继续修改");
        const message = panel.textContent ?? "";
        assert(message.includes("main") && message.includes(target || "未知") && message.includes("创建新任务"), "必须解释分支差异和可执行的下一步");
      }
      button("任务详情 ↗").click(); await pause();
      assert(document.querySelector('a[href="/?deliveryAnalysis=1&deliveryTask=task-orders"]'), "所有已合入最终 MR 均能查看差异");
      assert(!document.querySelector('input[type="url"]'), "已完成任务不可再次更换关联");
      button("关闭任务详情").click(); await pause();
      if (scenario === "completed") { button("继续修改").click(); await pause(); }
    }
    assert(!calls.some(call => call.method === "POST"), "浏览提示不应启动交付或修改任务");
  }
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
