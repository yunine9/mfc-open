import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ConfigurationCenter } from "../../web/src/ConfigurationCenter";
import { KnowledgeLanguagePicker } from "../../web/src/KnowledgeLanguages";
import { ConfirmDialogHost } from "../../web/src/ConfirmDialog";

const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const rows: Array<{ id: string; name: string; enabled: boolean }> = [];
const writes: Array<{ method: string; path: string; input: Record<string, unknown> }> = [];
let browserError = "";
window.addEventListener("error", event => { browserError = event.message; });
window.fetch = async (input, options) => {
  const path = String(input), method = options?.method ?? "GET";
  let result: unknown;
  if (path === "/technology-stacks" && method === "GET") result = { stacks: rows };
  else if (path.startsWith("/technology-stacks/") && method === "DELETE") {
    writes.push({ method, path, input: {} });
    const index = rows.findIndex(row => row.id === decodeURIComponent(path.split("/").at(-1)!));
    check(index >= 0, "删除必须引用已有技术栈 ID"); rows.splice(index, 1); result = { deleted: true };
  }
  else if (path.startsWith("/technology-stacks") && ["POST", "PUT"].includes(method)) {
    const body = JSON.parse(String(options?.body));
    writes.push({ method, path, input: body });
    if (body.name === "保留未保存名称") return new Response(JSON.stringify({ error: "名称已存在，请换一个名称" }), { status: 400 });
    if (method === "POST") {
      const stack = { id: `stack-${rows.length + 1}`, name: body.name, enabled: true };
      rows.push(stack); result = { stack };
    } else {
      const stack = rows.find(row => row.id === decodeURIComponent(path.split("/").at(-1)!));
      check(stack, "更新必须引用已有技术栈 ID");
      Object.assign(stack!, body); result = { stack };
    }
  } else throw new Error(`unexpected request: ${method} ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
function OpenPicker() {
  const [selected, setSelected] = useState<string[]>([]);
  return <aside aria-label="已打开的技术栈选择器" className="rounded-xl border border-line bg-surface p-5">
    <h2 className="mb-3 font-semibold">仓库技术栈选择</h2>
    <KnowledgeLanguagePicker value={selected} includeAgnostic={false} onChange={setSelected} />
    <output aria-label="已选技术栈">{selected.join(",")}</output>
  </aside>;
}
const root = createRoot(document.getElementById("app")!);
root.render(<main className="tw-root mx-auto grid max-w-[1480px] gap-6 p-8">
  <h1 className="text-2xl font-semibold">配置中心</h1><ConfigurationCenter />
  <OpenPicker /><ConfirmDialogHost />
</main>);
async function waitUntil(predicate: () => unknown, description: string) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await pause(); }
  throw new Error(`${description}; ${browserError}; ${document.body.textContent}`);
}
const visible = (element: Element) => element.getClientRects().length > 0;
function button(label: string, within: ParentNode = document) {
  return [...within.querySelectorAll<HTMLButtonElement>("button")].find(element => visible(element)
    && (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label && !element.disabled);
}
async function click(label: string) {
  await waitUntil(() => button(label), `缺少可操作按钮：${label}`);
  button(label)!.click(); await pause();
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  check(input, `缺少输入框：${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input!.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
function selectedOption(name: string) {
  return button(name, document.querySelector('[aria-label="已打开的技术栈选择器"]')!);
}
async function run() {
  await waitUntil(() => document.body.textContent?.includes("尚未配置技术栈"), "未显示空目录");
  check(button("技术栈")?.getAttribute("aria-pressed") === "true", "技术栈必须是独立配置页签");
  check(button("基础组件仓"), "基础组件仓入口保留");
  check(!selectedOption("Java"), "空配置不能自动显示预置技术栈");
  await click("新增技术栈");
  check(!document.querySelector('input[aria-label="技术栈 ID"]'), "技术栈标识不要求用户填写");
  await fill("技术栈名称", "团队界面框架"); await click("保存");
  await waitUntil(() => selectedOption("团队界面框架"), "新增未同步到已打开的选择器");
  check(writes[0]?.method === "POST" && !writes[0].input.id, "新增不能要求用户指定标识");
  const id = rows[0].id;
  await click("编辑 团队界面框架"); await fill("技术栈名称", "团队界面框架 v2"); await click("保存");
  await waitUntil(() => selectedOption("团队界面框架 v2") && !selectedOption("团队界面框架"), "改名没有同步选择器");
  check(rows.length === 1 && rows[0].id === id && writes.at(-1)?.path.endsWith(`/${id}`), "改名改变了关联标识");
  await click("停用 团队界面框架 v2");
  await waitUntil(() => !selectedOption("团队界面框架 v2") && button("启用 团队界面框架 v2"), "停用后未保留配置或仍可新增选择");
  check(document.body.textContent?.includes("已有知识和仓库关联仍保留"), "停用说明缺少关联处理");
  await click("启用 团队界面框架 v2");
  await waitUntil(() => selectedOption("团队界面框架 v2"), "重新启用未恢复可选项");
  await click("编辑 团队界面框架 v2"); await fill("技术栈名称", "保留未保存名称"); await click("保存");
  await waitUntil(() => document.querySelector('[role="alert"]')?.textContent?.includes("名称已存在"), "保存失败没有明确错误");
  check(document.querySelector<HTMLInputElement>('input[aria-label="技术栈名称"]')?.value === "保留未保存名称", "保存失败丢失输入");
  check(rows[0].name === "团队界面框架 v2", "失败改名污染已保存配置");
  await click("取消");
  await fill("搜索技术栈", "不存在");
  await waitUntil(() => document.body.textContent?.includes("没有匹配的技术栈"), "无匹配搜索结果未说明");
  await fill("搜索技术栈", "框架 v2");
  await waitUntil(() => button("编辑 团队界面框架 v2"), "搜索匹配未恢复条目");
  await fill("搜索技术栈", "");
  await click("新增技术栈"); await fill("技术栈名称", "设备模拟平台"); await click("保存");
  await waitUntil(() => selectedOption("设备模拟平台"), "第二项技术栈未保存");
  selectedOption("团队界面框架 v2")!.click();
  await waitUntil(() => document.querySelector('[aria-label="已选技术栈"]')?.textContent === id, "删除前未选中技术栈");
  await click("删除 团队界面框架 v2");
  await waitUntil(() => document.querySelector('[role="alertdialog"]'), "未显示删除影响确认");
  check(document.querySelector('[role="alertdialog"]')?.textContent?.includes("代码、知识文稿和 Skill 内容保留"), "删除确认没有说明保留内容");
  await click("取消");
  check(!writes.some(write => write.method === "DELETE"), "取消删除仍然请求服务");
  await click("删除 团队界面框架 v2"); await click("删除技术栈");
  await waitUntil(() => !button("编辑 团队界面框架 v2") && !selectedOption("团队界面框架 v2")
    && document.querySelector('[aria-label="已选技术栈"]')?.textContent === "", "删除后仍保留失效选项或选择");
  check(rows.length === 1 && rows[0].name === "设备模拟平台" && selectedOption("设备模拟平台"), "删除影响了其他技术栈");
  check(writes.filter(write => write.method === "DELETE").length === 1, "确认删除应只请求一次");
  // 模拟另一个配置页重建同一标识，回到当前页时保留草稿并刷新清单。
  rows.push({ id, name: "跨页重新添加", enabled: true });
  window.dispatchEvent(new Event("focus"));
  await waitUntil(() => selectedOption("跨页重新添加"), "返回页面没有读取另一页新增的技术栈");
  selectedOption("跨页重新添加")!.click(); await pause();
  check(document.querySelector('[aria-label="已选技术栈"]')?.textContent === id, "重新添加的标识仍被旧删除缓存清空");
  rows.splice(rows.findIndex(row => row.id === id), 1);
  window.dispatchEvent(new Event("focus"));
  await waitUntil(() => !selectedOption("跨页重新添加") && document.querySelector('[aria-label="已选技术栈"]')?.textContent === "", "跨页删除没有同步移除旧选择");
  check(document.documentElement.scrollWidth <= innerWidth + 1, "桌面布局横向溢出");
  return { passed: true, stableId: true, liveOptions: true, saveError: true, deletion: true, width: innerWidth };
}
run().then(result => document.getElementById("result")!.textContent = JSON.stringify(result))
  .catch(error => document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }));
