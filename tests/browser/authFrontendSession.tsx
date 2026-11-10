import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { App } from "../../web/src/App";

const mode = new URLSearchParams(location.search).get("mode") ?? "startup-503-auto";
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const user = { username: "session-user", role: "admin" };
const task = { id: "auth-task", title: "登录状态保留任务", requirement: "网络故障保留已加载工作", status: "queued", created_at: "2026-10-10T00:00:00Z", luban_account: user.username };
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
history.replaceState = () => {};
let authReads = 0;
let taskReads = 0;
let fault = false;
let abortedAuth = 0;
let pendingAuth: ((response: Response) => void) | undefined;
let pendingTasks: ((response: Response) => void) | undefined;
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
let renewalInterval = 0;
const nativeInterval = window.setInterval.bind(window);
window.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
  if (ms === 60 * 60 * 1000) renewalInterval = ms;
  return nativeInterval(callback, mode === "hourly-renewal" && ms === 60 * 60 * 1000 ? 250 : ms, ...args);
}) as typeof window.setInterval;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input, options) => {
  const path = String(input);
  if (path === "/auth/me") {
    authReads++;
    const signal = options?.signal;
    if (authReads === 1) {
      if (mode.startsWith("startup-503")) return json({ error: "服务重启中" }, 503);
      if (mode === "startup-network-auto") throw new TypeError("Failed to fetch");
      if (mode === "startup-timeout-auto") return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => { abortedAuth++; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
      if (mode === "startup-401") return json({ error: "未登录" }, 401);
      return json(user);
    }
    if (mode === "poll-503") return json({ error: "服务重启中" }, 503);
    if (mode === "poll-network") throw new TypeError("Failed to fetch");
    if (mode === "poll-401" || mode === "visible-401") return json({ error: "会话已撤销" }, 401);
    if (mode === "stale-401" || mode === "exit-aborts-check") {
      // 模拟取消来得太晚、旧服务器回包仍被交付，检查代次保护。
      signal?.addEventListener("abort", () => { abortedAuth++; }, { once: true });
      return new Promise<Response>(resolve => { pendingAuth = resolve; });
    }
    return json(user);
  }
  if (path === "/auth/logout") return json({ ok: true });
  if (path === "/auth/login" && options?.method === "POST") return json(user);
  if (path === "/tasks") {
    taskReads++;
    if (fault && mode === "stale-tasks") return new Promise<Response>(resolve => { pendingTasks = resolve; });
    return fault ? json({ error: "任务暂时不可用" }, 503) : json([task]);
  }
  if (path === "/auth/users" || path === "/auth/people" || path === "/reviews/mine") return json([]);
  if (path.startsWith("/issues")) return json({ issues: [] });
  if (path.includes("build")) return json({ build_hash: "fixture" });
  return json({});
};
const loginVisible = () => Boolean(document.querySelector("#login-title"));
const signedIn = () => Boolean(document.querySelector('[aria-label="退出登录"]'));
const connectionError = () => Boolean(document.querySelector("#session-connection-title"));
async function until(predicate: () => unknown, description: string) {
  for (let count = 0; count < 600; count++) { if (predicate()) return; await pause(); }
  throw new Error(`${description}; ${errors.join(";")}; ${document.getElementById("app")?.textContent}`);
}
function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function signOut() {
  document.querySelector<HTMLButtonElement>('[aria-label="退出登录"]')!.click();
  await until(loginVisible, "手动退出未显示登录页");
}
async function signIn() {
  fill(document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, user.username);
  fill(document.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, "fixture-password");
  await pause();
  document.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(signedIn, "新登录未进入工作台");
}
function visibleAgain() {
  visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  visibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));
}
async function run() {
  const root = createRoot(document.getElementById("app")!);
  try {
    root.render(<App />);
    if (mode === "startup-401") {
      await until(loginVisible, "明确未登录必须显示登录页");
    } else if (mode.startsWith("startup")) {
      await until(connectionError, "临时会话故障必须显示连接重试界面");
      check(!loginVisible(), "临时故障不得误判为退出登录");
      if (mode === "startup-503-manual") {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "重新连接");
        check(button && !button.disabled, "连接重试按钮不可操作"); button!.click();
      }
      await until(signedIn, "服务恢复后未自动进入工作台");
      check(authReads >= 2, "恢复必须重新查询真实会话");
      if (mode === "startup-timeout-auto") check(abortedAuth > 0, "挂起查询必须在预算内取消");
    } else {
      await until(signedIn, "未完成初始登录态加载");
      await until(() => document.getElementById("app")?.textContent?.includes(task.title), "未加载登录后的任务列表");
      check(renewalInterval === 60 * 60 * 1000, "登录态必须按小时续期，不能跟任务轮询频率查询");
      if (mode === "hourly-renewal") {
        await until(() => authReads >= 2, "未按小时检查身份续期");
      } else if (mode.startsWith("visible")) {
        visibleAgain(); await until(() => authReads >= 2, "页面重新可见未查询真实身份");
        if (mode === "visible-401") await until(loginVisible, "页面可见查验发现会话撤销后未要求登录");
      } else {
        fault = true;
        if (mode === "stale-tasks") {
          await until(() => pendingTasks, "旧任务请求尚未挂起");
          await signOut(); fault = false; await signIn();
          await until(() => document.getElementById("app")?.textContent?.includes(task.title), "重新登录未读取当前任务");
          pendingTasks!(json([{ ...task, title: "旧会话任务不应显示" }]));
          await pause(200);
          check(!document.getElementById("app")?.textContent?.includes("旧会话任务不应显示"), "旧任务回包覆盖新登录");
        } else {
          await until(() => authReads >= 2, "任务请求失败后未复查登录态");
          if (mode === "stale-401" || mode === "exit-aborts-check") {
            await until(() => pendingAuth, "旧会话确认请求尚未挂起");
            await signOut();
            check(abortedAuth > 0, "退出时必须取消旧身份请求，避免旧 Cookie 回包");
            fault = false;
            if (mode === "stale-401") await signIn();
            pendingAuth!(json(mode === "stale-401" ? { error: "旧请求未登录" } : user, mode === "stale-401" ? 401 : 200));
            await pause(200);
          } else if (mode === "poll-401") await until(loginVisible, "当前会话被撤销后未要求登录");
          else {
            await pause(200);
            check(document.getElementById("app")?.textContent?.includes(task.title), "在线故障必须保留已加载任务");
          }
        }
      }
    }
    check(errors.length === 0, errors.join(";"));
    const expectedLogin = ["startup-401", "poll-401", "visible-401", "exit-aborts-check"].includes(mode);
    check(loginVisible() === expectedLogin && signedIn() === !expectedLogin, `登录结果错误：${mode}`);
    return { mode, passed: true, authReads, taskReads, abortedAuth, loginVisible: loginVisible(), signedIn: signedIn() };
  } finally { root.unmount(); }
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
