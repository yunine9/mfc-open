import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskContinueDelivery } from "../../web/src/TaskContinueDelivery";
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const requests: any[] = [];
let changes = 0;
window.fetch = async (_input, init) => {
  requests.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify(requests.length === 1 ? { error: "模拟准备失败" } : { status: "queued" }), {
    status: requests.length === 1 ? 409 : 200, headers: { "Content-Type": "application/json" },
  });
};
const task: any = { id: "task-1", status: "completed", delivery: { mr_state: "已合入" },
  delivery_history: [{ id: "initial", archive: "archive-1", completed_at: "2026-09-28", delivery: { mr_url: "https://example.test/mr/1" } }] };
const root = createRoot(document.getElementById("app")!);
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent === label)!;
async function run() {
  root.render(<TaskContinueDelivery task={task} canOperate onChanged={() => changes++} />);
  await pause();
  button("继续修改").click(); await pause();
  if (requests.length || !button("发送并开始修改").disabled) throw new Error("打开入口就启动执行或允许空要求");
  const input = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "修复空行并更新说明");
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  button("发送并开始修改").click(); await pause();
  if (!document.querySelector('[role="alert"]')?.textContent?.includes("模拟准备失败")) throw new Error("没有展示可重试错误");
  button("发送并开始修改").click(); await pause();
  if (requests.length !== 2 || requests[0].request_id !== requests[1].request_id) throw new Error("重试丢失请求身份");
  if (requests[1].text !== "修复空行并更新说明" || changes !== 2) throw new Error("没有提交要求或刷新任务");
  if (!document.querySelector('a[href="/tasks/task-1/delivery-history/archive-1"]')) throw new Error("历史材料不可下载");
  if (document.querySelector("textarea")) throw new Error("成功后输入框未收起");
  return { passed: true };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
