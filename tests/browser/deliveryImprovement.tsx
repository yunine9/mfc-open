import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DeliveryImprovement, ImprovementPolicyControl } from "../../web/src/DeliveryImprovement";
import { DeliveryAnalytics } from "../../web/src/DeliveryAnalytics";
import type { DeliveryAnalysisRow } from "../../src/deliveryAnalyticsTypes";

const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const calls: Array<{ url: string; method: string; body?: string }> = [];
const oldReport = "# 任务交付改进报告\n\n> 核心结论：已有配置检查在首轮未执行，后续两次提交重复修正同一问题。\n\n## 优先改进\n\n| 观察 | 预防办法 | 验证 |\n|---|---|---|\n| 三轮重复修复配置 | 首次提交前执行已有兼容性检查 | 重放本次失败配置 |\n\n## 证据与限制\n\n- 已核对意见、提交差异及最终验证记录。\n- 记录不足以判定平台未提供规则，需维护者核实。";
const fullReport = "# 任务交付改进报告\n\n> 核心结论：后续提交集中处理业务规则遗漏、接口版本不一致和检查执行过晚。优先复用已有检查，并补齐首轮实际拿到的业务依据。\n\n## 三项主要原因\n\n| 问题 | 任务证据 | 预防办法 |\n|---|---|---|\n| 业务边界遗漏 | 意见 A12 与修复 78bd120：补齐关闭订单的退款规则 | 设计时核对当时提供的退款规则；缺失则补证，不认定已知规则被忽略 |\n| 组件接口版本不一致 | 提交 83ad901 改用当前组件的取消接口 | 编码前核对项目依赖版本与对应文档 |\n| 配置检查执行过晚 | 首轮未见检查记录，流水线失败后修正配置 | 核实已有兼容性检查是否适合在首次提交前执行 |\n\n## 建议优先处理\n\n1. 使用本次失败配置验证现有检查能否提前发现问题。\n2. 核对知识检索是否向任务提供了正确版本的接口约束。\n3. 补取首轮业务规则输入，再判断是否需要补充知识。\n\n## 证据与限制\n\n已读取 12 个提交、9 条意见和 3 轮验证记录。未取得首轮完整知识正文，不据此认定 Agent 忽略业务规则；平台实现位置需维护者核实。";
const fullState = { status: "completed" as const, head: "a".repeat(40), available: true, started_at: "2026-10-26T01:00:00Z", finished_at: "2026-10-26T01:05:00Z" };
let mode: "queued" | "failed" | "completed" = "queued";
let slowResolve: ((value: Response) => void) | undefined;
window.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? "GET";
  calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
  if (url === "/technology-stacks") return Response.json({ stacks: [] });
  if (url === "/delivery-analytics") return Response.json({ generated_at: "2026-10-26T01:00:00Z", improvement_policy: { enabled: true, threshold_percent: 100, can_configure: true }, rows: [{ ...row("task-full"), improvement: fullState, completed_at: "2026-10-26T01:00:00Z", metric: { version: 1, base: "b".repeat(40), first: "c".repeat(40), head: fullState.head, retained: { first: 350, pipeline: 240, review: 410, other: 0 }, rework: { first: 0, pipeline: 240, review: 410, other: 0 }, deleted: 20, excluded_files: 3, commits: [{ sha: fullState.head, subject: "修正配置兼容性并补齐验证", at: "2026-10-26T01:00:00Z", origin: "pipeline", additions: 120, deletions: 20 }] } }] });
  if (url.includes("task-full")) return Response.json({ state: fullState, markdown: fullReport });
  if (url.includes("improvement-policy")) return Response.json(JSON.parse(String(init?.body)));
  if (url.includes("task-slow")) return new Promise<Response>(resolve => { slowResolve = resolve; });
  if (url.includes("task-old")) return Response.json({ state: { status: "failed", head: "previous", available: true, stale: true, started_at: "2026-10-26T01:00:00Z", message: "证据读取失败" }, markdown: oldReport });
  if (method === "POST") mode = "completed";
  return Response.json({ state: { status: mode, head: "current", available: mode !== "queued", started_at: "2026-10-26T01:00:00Z", message: mode === "failed" ? "模型暂不可用" : undefined }, markdown: mode === "completed" ? "# 新任务报告\n\n已核对本次交付的提交与验证记录。" : undefined });
};
const root = createRoot(document.getElementById("app")!);
const row = (id: string) => ({ id, delivery_id: "round-2", title: "配置兼容性验证", at: "2026-10-26T01:00:00Z", repo: "orders", modules: [], merged: true } as DeliveryAnalysisRow);
function render(id: string) {
  root.render(<main className="tw-root" style={{ padding: 32, maxWidth: 960, margin: "0 auto" }}>
    <h1 style={{ fontSize: 24, marginBottom: 24 }}>需求交付分析</h1>
    <section className="delivery-card"><DeliveryImprovement key={id} row={row(id)}><h2>{id} · 2026/10/26 · 提交记录</h2><a href="#work">工作台</a></DeliveryImprovement></section>
    <ImprovementPolicyControl policy={{ enabled: true, threshold_percent: 100, can_configure: true }} onSaved={() => {}} />
  </main>);
}
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 60 && !predicate(); i++) await pause(); check(predicate(), message); }
function click(label: string) { const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label); check(target, `missing ${label}`); target!.click(); }
async function run() {
  if (new URLSearchParams(location.search).has("full")) {
    root.render(<main className="tw-root" style={{ padding: 28 }}><DeliveryAnalytics onOpenTask={() => {}} /></main>);
    await until(() => document.querySelector('[aria-label="查看交付改进报告"]'), "actual detail sheet loaded");
    check(document.querySelectorAll('[aria-label="查看交付改进报告"]').length === 1, "one report icon for this delivery");
    click("查看交付改进报告"); await until(() => document.body.textContent?.includes("三项主要原因"), "full Markdown report loaded");
    const panel = document.querySelector<HTMLElement>('[aria-label="task-full 交付改进报告"]')!;
    panel.parentElement!.scrollIntoView({ block: "start", behavior: "instant" }); await pause();
    const sheet = document.querySelector<HTMLElement>(".delivery-detail-sheet")!;
    const table = panel.querySelector("table")!;
    check(sheet.getBoundingClientRect().width <= 760 && sheet.getBoundingClientRect().right <= innerWidth + 1, "sheet fits desktop viewport");
    check(table.querySelectorAll("tbody tr").length === 3, "three evidence-linked causes render");
    check(table.getBoundingClientRect().right <= sheet.getBoundingClientRect().right - 10, "report table stays inside sheet");
    check(!calls.some(call => call.method === "POST"), "viewing existing report does not rerun analysis");
    return { passed: true, width: innerWidth, fullSheet: true };
  }
  render("task-old"); await pause(); click("分析本次交付的改进机会");
  await until(() => document.querySelector("h1.md-h1") || document.body.textContent?.includes("核心结论"), "old report loads");
  check(document.body.textContent?.includes("较早的交付版本"), "stale version is visible");
  check(document.body.textContent?.includes("下方保留上一次报告"), "failed analysis retains old report");
  check(document.querySelector("table"), "Markdown table is rendered");
  render("task-new"); await pause(); check(!document.body.textContent?.includes("核心结论"), "switching task clears old report");
  click("分析本次交付的改进机会"); await until(() => document.body.textContent?.includes("已排队"), "queued status loads");
  const beforePoll = calls.filter(call => call.url.includes("task-new")).length;
  await pause(1700); check(calls.filter(call => call.url.includes("task-new")).length > beforePoll, "open queued report polls");
  click("收起报告"); await pause(); const afterClose = calls.length;
  await pause(1700); check(calls.length === afterClose, "closing stops polling");
  mode = "failed"; click("交付改进分析进行中，查看进度"); await until(() => document.body.textContent?.includes("模型暂不可用"), "failure shown after reopen");
  click("重试分析"); await until(() => document.body.textContent?.includes("新任务报告"), "retry yields new report");
  check(calls.some(call => call.method === "POST" && call.url.includes("task-new") && call.url.includes("delivery_id=round-2")), "retry binds correct delivery round");
  render("task-slow"); await pause(); click("分析本次交付的改进机会"); await until(() => slowResolve, "slow read started");
  render("task-new"); await pause(); slowResolve!(Response.json({ markdown: "不应出现的旧任务内容" })); await pause();
  check(!document.body.textContent?.includes("不应出现"), "late old request cannot appear in new task");
  const details = document.querySelector("details")!; details.open = true;
  const field = document.querySelector<HTMLInputElement>('[aria-label="自动分析阈值"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "50"); field.dispatchEvent(new Event("input", { bubbles: true })); await pause(); click("保存");
  await until(() => calls.some(call => call.url.includes("improvement-policy")), "policy saved");
  check(calls.some(call => call.body && JSON.parse(call.body).threshold_percent === 50), "policy writes threshold");
  render("task-old"); await pause(); click("分析本次交付的改进机会"); await until(() => document.body.textContent?.includes("核心结论"), "final report preview ready");
  return { passed: true, calls: calls.length, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
