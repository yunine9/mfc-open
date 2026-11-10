import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { StoryArchitecture } from "../../web/src/StoryArchitecture";
import { storyViewCoverage } from "../../src/storyViewCoverage";

declare const ARCHIFY_HTML_ONE: string;
declare const ARCHIFY_HTML_TWO: string;
let revision = "one", mode = "ready", opened = false, requests = 0;
let updates = 0;
let generation: Record<string, unknown> = {};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
window.fetch = async (input, options) => {
  const url = String(input);
  if (url.endsWith("/overall-story/architecture") && options?.method === "POST") {
    updates++; return new Response(JSON.stringify({ job: { kind: "architecture", started_at: new Date(Date.now() - 65000).toISOString(), progress: "正在校验渲染 2/3：订单模块" } }));
  }
  if (url.endsWith("/overall-story")) return new Response(JSON.stringify(generation));
  if (url.includes("?revision=")) {
    requests++;
    if (mode === "render-error") return new Response(JSON.stringify({ error: "layout validation failed: label overlaps module" }), { status: 422 });
    const old = url.endsWith("one");
    // 故意模拟无法及时取消的旧请求；回包顺序与发起顺序相反。
    if (old) await pause(600);
    return new Response(JSON.stringify({ revision: old ? "one" : "two", html: old ? ARCHIFY_HTML_ONE : ARCHIFY_HTML_TWO }));
  }
  if (mode === "error") return new Response(JSON.stringify({ error: "Story 读取失败" }), { status: 500 });
  return new Response(JSON.stringify({ revision, renderer: "10722002", warnings: [],
    views: storyViewCoverage("| 物理视图 | 不涉及 | 沿用现有部署，本次无部署变更 |\n## 逻辑视图\n```plantuml\nclass Order\n```"),
    diagrams: mode === "empty" ? [] : [{ id: "diagram-1", title: `版本 ${revision}`, type: "architecture", view: "logical", line: 7, nodes:[{id:"sync",name:"订单模块",summary:"同步订单",responsibility:"校验并同步订单",interfaces:"读取订单，输出同步结果",relationships:[]}] }] }));
};
function Harness() { return <StoryArchitecture taskId="task" canUpdate onOpenStory={() => { opened = true; }} />; }
const root = createRoot(document.getElementById("app")!);
let mount = 0;
root.render(<Harness key={mount} />);
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 80; i++) { if (check()) return; await pause(20); }
  throw Error(label);
}
function refresh() { root.render(<Harness key={++mount} />); }
async function run() {
  await until(() => requests > 0, "首版图未请求");
  revision = "two"; refresh();
  await until(() => !!document.querySelector("iframe"), "新版图未显示");
  await pause(800);
  const frame = document.querySelector("iframe")!;
  if (!frame.srcdoc.includes("新版订单模块") || frame.srcdoc.includes("旧版订单模块")) throw Error("迟到的旧图覆盖新图");
  if (frame.getAttribute("sandbox") !== "allow-scripts allow-downloads") throw Error("iframe 隔离丢失");
  if (document.querySelector('[aria-label="设计视角"]')) throw Error("单个视角仍显示重复导航");
  window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'mfc:archify-node',id:'sync'}}));
  await pause(40);
  if(document.querySelector('aside')) throw Error('其他窗口伪造节点选择');
  const before = requests;
  window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{type:'mfc:archify-node',id:'sync'}}));
  await until(()=>!!document.querySelector('aside'), '点击节点没有职责详情');
  if(!document.querySelector('aside')!.textContent!.includes('校验并同步订单')) throw Error('职责正文丢失');
  if(document.querySelector('iframe')!==frame || requests!==before) throw Error('点节点重新加载或切换了图');
  document.querySelector<HTMLButtonElement>('[aria-label="关闭节点详情"]')!.click();
  await until(()=>!document.querySelector('aside'), '详情无法关闭');
  if (document.body.textContent!.includes("沿用现有部署")) throw Error("无图的物理覆盖说明挤进了架构页");
  mode = "render-error"; refresh();
  const failureDetails = () => [...document.querySelectorAll("details")]
    .find((d) => d.querySelector("summary")?.textContent === "查看失败详情");
  await until(() => !!failureDetails(), "渲染失败没有反馈入口");
  if (document.querySelector("iframe")) throw Error("渲染失败仍展示旧图");
  const details = failureDetails()!;
  if (details.open || !details.textContent!.includes("label overlaps module")) throw Error("失败详情未保留或默认展开挤占页面");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "打开 Story 提意见")!.click();
  if (!opened) throw Error("失败状态无法回到 Story 提意见");
  opened = false;
  mode = "error"; refresh();
  await until(() => document.body.textContent!.includes("Story 读取失败"), "读取错误未呈现");
  if (document.querySelector("iframe")) throw Error("读取失败仍展示旧图");
  mode = "empty"; revision = "three"; refresh();
  await until(() => document.body.textContent!.includes("尚无可展示"), "旧 Story 空态未呈现");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("阅读完整 Story"))!.click();
  if (!opened) throw Error("无法返回完整 Story");
  generation = { job: { kind: "architecture", progress: "Agent 正在更新架构图", started_at: new Date().toISOString() } };
  refresh();
  await until(() => !!document.querySelector('[role="status"]')?.textContent?.includes("Agent 正在更新架构图"), "自动补图进度未呈现");
  if (!document.querySelector<HTMLButtonElement>('button[aria-label="更新架构图"]')!.disabled) throw Error("自动补图期间仍允许重复提交");
  generation = { error: "自动补图的模型不可用", error_kind: "architecture" };
  refresh();
  await until(() => !![...document.querySelectorAll("summary")].find(item => item.textContent === "上次架构图生成未完成 · 查看原因"), "自动补图失败没有查看原因入口");
  if (!document.body.textContent!.includes("自动补图的模型不可用")) throw Error("自动补图失败原因丢失");
  generation = {};
  mode = "ready"; revision = "four"; refresh();
  await until(() => !!document.querySelector("iframe"), "Archify 图无法恢复");
  document.querySelector<HTMLButtonElement>('button[aria-label="更新架构图"]')!.click();
  await until(() => updates === 1, "刷新按钮没有发起架构图生成");
  await until(() => !!document.querySelector<HTMLButtonElement>('button[aria-label="更新架构图"]')!.disabled, "生成期间未禁用重复提交");
  const progress = () => document.querySelector('p[aria-live="polite"]');
  await until(() => !!progress()?.textContent?.includes("正在校验渲染 2/3：订单模块"), "真实阶段没有显示");
  if (!progress()?.textContent?.includes("已用时 1 分")) throw Error("没有展示服务端开始时间对应的耗时");
  return { onlyArchify: true, missingTabsHidden: true, raceProtected: true, staleRemoved: true, failureReadable: true, emptyReadable: true, opened };
}
run().then((result) => document.getElementById("result")!.textContent = JSON.stringify(result))
  .catch((error) => document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }));
