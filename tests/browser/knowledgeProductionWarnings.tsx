import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeTaskCenter } from "../../web/src/KnowledgeTaskCenter";
import type { KnowledgeTaskCenterData, KnowledgeTaskKind } from "../../src/knowledgeTaskCenterTypes";
import type { KnowledgeProductionAction } from "../../src/knowledgeProductionTypes";

const fixture = JSON.parse(document.getElementById("fixture")!.textContent!) as {
  populated: KnowledgeTaskCenterData; warningsOnly: KnowledgeTaskCenterData; matrix: KnowledgeTaskCenterData; badPaths: string[];
  runningId: string; completedId: string; attentionId: string;
};
const opened: Array<{ kind: KnowledgeTaskKind; id: string; action: KnowledgeProductionAction }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等待超过1秒预算：${message}`);
}
function Fixture() {
  const [scene, setScene] = useState<"populated" | "warningsOnly" | "matrix">("populated");
  return <><button id="only-warnings" onClick={() => setScene("warningsOnly")}>仅坏文件场景</button><button id="production-matrix" onClick={() => setScene("matrix")}>后端组合状态场景</button><KnowledgeTaskCenter
    data={fixture[scene]} onBack={() => {}}
    onOpen={(kind, id, action) => opened.push({ kind, id, action: structuredClone(action) })} /></>;
}
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".knowledge-task-row")];
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="按任务状态筛选"] button')].find(button => button.textContent!.startsWith(label));
async function select(label: string) {
  const button = tab(label); check(button, `缺少${label}分组`);
  button!.click();
  await until(() => button!.getAttribute("aria-pressed") === "true", `${label}分组切换`);
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索知识任务"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => input.value === value && (value ? rows().length === 0 : rows().length === 1), "搜索正常任务");
}
function assertNoWarnings() {
  const center = document.querySelector<HTMLElement>(".knowledge-task-center")!;
  check(!center.querySelector(".knowledge-task-warning"), "任务中心不展示后台 warning 黄条");
  for (const path of fixture.badPaths) check(!center.textContent!.includes(path), "后台诊断不变成提醒入口或折叠详情");
}
function assertRowLayout() {
  for (const row of rows()) {
    const status = row.querySelector<HTMLElement>(".knowledge-task-status")!, person = row.querySelector<HTMLElement>(".knowledge-task-person")!;
    const statusBox = status.getBoundingClientRect(), statusCell = status.parentElement!.getBoundingClientRect(), personBox = person.getBoundingClientRect();
    check(statusBox.right <= statusCell.right + 1 && statusBox.right < personBox.left, "长状态必须在自己的列内，不能覆盖发起人");
    const rowBox = row.getBoundingClientRect();
    for (const child of [...row.children]) {
      const box = child.getBoundingClientRect();
      check(box.left >= rowBox.left && box.right <= rowBox.right + 1, "长内容不能越出任务行");
    }
    check(person.scrollHeight <= person.clientHeight + 1, "长发起人保持一行");
  }
}
async function run() {
  const root = createRoot(document.getElementById("app")!);
  root.render(<Fixture />);
  try {
    await until(() => !!tab("当前任务"), "任务中心首次渲染");
    assertNoWarnings();
    check(tab("当前任务")!.querySelector("span")?.textContent === String(fixture.populated.tasks.filter(task => task.group !== "completed").length), "当前数量只包含真实任务");
    check(tab("待处理")!.querySelector("span")?.textContent === String(fixture.populated.tasks.filter(task => task.group === "attention").length), "后台诊断不能增加待处理数");
    await select("进行中"); assertNoWarnings();
    check(rows().length === 1 && rows()[0].textContent!.includes("正在进行的正常研究"), "进行中保留有效研究且不显示坏文件告警");
    await select("已完成"); assertNoWarnings();
    check(rows().length === 1 && rows()[0].textContent!.includes("已完成的正常领域研究"), "已完成保留历史研究且不显示坏文件告警");
    rows()[0].click();
    check(opened.at(-1)?.kind === "domain" && opened.at(-1)?.id === fixture.completedId && opened.at(-1)?.action.view === "review", "正常已完成研究仍能打开文稿");
    await select("待处理"); assertNoWarnings();
    check(rows().length === 1, "坏文件不让其他有效待处理任务消失");
    check(rows()[0].querySelector(".knowledge-task-error")?.textContent === "来源当前不可用，可重试研究", "真实任务失败仍明确显示");
    rows()[0].click();
    check(opened.at(-1)?.kind === "component" && opened.at(-1)?.id === fixture.attentionId && opened.at(-1)?.action.view === "progress", "正常失败研究仍能打开研究过程");
    await search("RECORD.JSON");
    assertNoWarnings();
    check(rows().length === 0 && !!document.querySelector(".knowledge-task-empty"), "后台诊断文件不能作为任务搜索结果");
    await search("");
    await select("当前任务"); assertNoWarnings();
    document.getElementById("only-warnings")!.click();
    await until(() => rows().length === 0 && tab("待处理")!.querySelector("span")?.textContent === String(fixture.warningsOnly.summary.attention), "只有坏文件的场景");
    assertNoWarnings();
    check(tab("待处理")!.querySelector("span")?.textContent === "0", "只有后台诊断时待处理为零");
    check(!!document.querySelector(".knowledge-task-empty"), "没有正常任务时展示空态");
    await select("待处理"); assertNoWarnings();
    check(!!document.querySelector(".knowledge-task-empty"), "后台诊断不能占据待处理列表");
    await select("进行中"); assertNoWarnings();
    await select("已完成"); assertNoWarnings();
    document.getElementById("production-matrix")!.click();
    await until(() => tab("待处理")!.querySelector("span")?.textContent === String(fixture.matrix.summary.attention), "后端组合状态场景");
    for (const [group, label] of [["attention", "待处理"], ["running", "进行中"], ["completed", "已完成"]] as const) {
    await select(label); assertNoWarnings(); assertRowLayout();
    const expectedTasks = fixture.matrix.tasks.filter(task => task.group === group);
    check(rows().length === expectedTasks.length, "领域/组件人工归档状态沿用后端指定分组");
    for (const task of expectedTasks) {
      const production = task.production!;
      check(production, `${task.title} 缺少后台详情投影`);
      const row = rows().find(row => row.querySelector(".knowledge-task-title")?.textContent === task.title)!;
      check(row, `缺少组合状态任务 ${task.title}`);
      const label = row.querySelector<HTMLElement>(".knowledge-task-status")!;
      check(label.textContent === production.status_label, `${task.title} 状态文案必须沿用详情后台投影`);
      check(label.classList.contains(`is-${production.group}`), `${task.title} 颜色分组必须沿用详情后台投影`);
      row.click();
      const selected = opened.at(-1)!;
      check(selected.kind === task.kind && selected.id === task.id, `${task.title} 点击保留对象身份`);
      check(JSON.stringify(selected.action) === JSON.stringify(production.next_action), `${task.title} 点击必须保留完整后端动作`);
    }
    }
    await select("当前任务");
    check(rows().length === fixture.matrix.tasks.filter(task => task.group !== "completed").length, "当前任务只包含后端进行中或待处理的任务");
    assertNoWarnings(); assertRowLayout();
    check(rows().some(row => row.textContent?.includes("部分 MR 已合入，剩余 MR 创建失败")), "布局覆盖真实长状态");
    const longPerson = rows().find(row => row.textContent?.includes("部分 MR 已合入，剩余 MR 创建失败"))!.querySelector<HTMLElement>(".knowledge-task-person")!;
    check(longPerson.scrollWidth > longPerson.clientWidth, "长发起人超过列宽时省略显示");
    check(longPerson.querySelector("[title]")?.getAttribute("title") === longPerson.textContent, "悬停保留完整发起人");
    check(!errors.length, errors.join("；"));
    check(document.documentElement.scrollWidth <= innerWidth, "桌面页面不横向溢出");
    return { passed: true, width: innerWidth, height: innerHeight };
  } finally { if (!new URL(location.href).searchParams.has("screenshot")) root.unmount(); }
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
