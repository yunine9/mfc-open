import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { Composer } from "../../web/src/Composer";
import { TaskAttachmentMessage } from "../../web/src/TaskAttachmentMessage";
const pause = () => new Promise(resolve => setTimeout(resolve, 80));
const submissions: { url: string; body: any }[] = [];
let fail = true;
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/attachments?")) {
    await pause();
    return new Response(JSON.stringify({ path: ".mae-flow-work/attachments/0123456789abcdef.zip", name: "环境验证日志.zip", bytes: 40960 }));
  }
  if (url.endsWith("/interrupt") || url.endsWith("/decision")) {
    submissions.push({ url, body: JSON.parse(String(init?.body)) });
    if (fail) { fail = false; return new Response(JSON.stringify({ error: "模拟发送失败" }), { status: 409 }); }
    return new Response("{}");
  }
  return new Response(JSON.stringify({ state: "idle", messages: [], tools: [], availability: { available: false, reason: "未接管" } }));
};
const base: any = { id: "task-attachment", title: "订单验证", requirement: "订单超时修复", status: "running", luban_account: "owner", created_at: "2026-10-23", updated_at: "2026-10-23" };
function App() {
  return <main style={{ display: "grid", gridTemplateColumns: "520px 520px", gap: 32, padding: 40, justifyContent: "center" }}>
    <section id="ordinary" className="task-workspace-v2 workspace-studio" style={{ position: "relative", inset: "auto", height: "auto", minHeight: 0, display: "block" }}><h2>普通对话 · 补充环境日志</h2><Composer task={base} isOwner dockRef={() => {}} /></section>

    <section style={{ gridColumn: "1 / -1" }}><h2>对话中的附件</h2><TaskAttachmentMessage text={'参考这个日志\n\n[用户上传的日志附件]\n\n- [环境验证日志.zip](/tasks/task-attachment/attachments?path=abc) (40960 bytes)，Agent 工作区路径：`private-path`\n\n先读取附件'} /></section>
  </main>;
}
const root = createRoot(document.getElementById("app")!);
root.render(<App />);
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
async function attach(scope: Element) {
  const input = scope.querySelector<HTMLInputElement>('input[type="file"]')!;
  const transfer = new DataTransfer(); transfer.items.add(new File(["zip"], "环境验证日志.zip"));
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  await pause(); await pause(); await pause();
  if (!scope.querySelector('[title*="环境验证日志.zip"]')) throw Error("上传附件没有显示");
}
function button(scope: Element, text: string) {
  const button = [...scope.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
  if (!button) throw Error(`找不到按钮 ${text}`); return button;
}
async function run() {
  await pause(); await pause();
  const ordinary = document.querySelector("#ordinary")!;
  await attach(ordinary);
  if (submissions.length) throw Error("上传即自动发送");
  setValue(ordinary.querySelector("textarea")!, "参考这个日志"); await pause();
  button(ordinary, "发送").click(); await pause();
  if (!ordinary.textContent?.includes("模拟发送失败") || !ordinary.querySelector('[title*="环境验证日志.zip"]')) throw Error("发送失败丢附件");
  button(ordinary, "发送").click(); await pause();
  if (submissions.length !== 2 || submissions[1].body.attachments?.length !== 1 || submissions[1].body.text !== "参考这个日志") throw Error("普通对话未发送附件引用");
  const history = [...document.querySelectorAll("section")].at(-1)!;
  if (history.textContent?.includes("private-path") || history.textContent?.includes("先读取附件")) throw Error("内部路径或提示泄露给用户");
  if (!history.querySelector("a[download]")) throw Error("历史缺少下载入口");
  await attach(ordinary);
  if (document.documentElement.scrollWidth > innerWidth) throw Error("桌面横向溢出");
  const field = ordinary.querySelector("textarea")!.getBoundingClientRect();
  const icon = ordinary.querySelector('[aria-label="日志附件"] button')!.getBoundingClientRect();
  if (icon.left < field.left || icon.right > field.right || icon.top < field.top || icon.bottom > field.bottom) throw Error(`附件图标不在输入框内 ${JSON.stringify({ field: field.toJSON(), icon: icon.toJSON() })}`);
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
