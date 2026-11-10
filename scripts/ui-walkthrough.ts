/**
 * 带登录态的交互走查截图:headless-shell + 裸 CDP——登录换会话
 * Cookie 注入浏览器,再按脚本点击、截图。服务静态 SSR 挂载盖不住的
 * 页面(登录墙、页签切换、展开/弹层)走这里;纯静态五档宽度比对走
 * visual-scenes。服务由调用方先起好(serve.ts + 数据目录),本模块只
 * 管浏览器与截图的生命周期,不碰服务进程。一次性走查脚本按临时工件
 * 纪律不进版本库,import 本模块写步骤,用法:
 *
 *   import { withWalkthrough } from "./ui-walkthrough.ts";
 *   await withWalkthrough({
 *     base: "http://127.0.0.1:8863", outDir: "/tmp/mfc-shots",
 *     // username/password 缺省 admin/mae-flow-demo(演示夹具惯例),
 *     // 来自数据目录 LocalAuth 的 bootstrapAdmin;也可直接给 cookie。
 *   }, async (walk) => {
 *     await walk.goto("/?deliveryAnalysis", 2500);
 *     await walk.click(`[...document.querySelectorAll("button")]` +
 *       `.find(b => b.textContent.trim() === "DTS").click();`);
 *     await walk.shot("1-dts.png");
 *   });
 *
 * 坑位备忘:Cookie 注入用 url 形式(domain 形式页面拿不到);curl
 * cookie jar 里的行以 #HttpOnly_ 开头,grep -v '^#' 会把它整行排除。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** headless-shell 查找与 visual-scenes 的 defaultBrowser 同源:环境
 *  变量优先,退回 playwright 缓存里的 Linux 无头壳(WSL 上远快于
 *  Windows 浏览器互操作,visual-scenes 头注释有实测数)。 */
function resolveHeadlessChrome(): string {
  const override = process.env.MFC_VISUAL_BROWSER;
  if (override) return override;
  const cache = `${process.env.HOME ?? ""}/.cache/ms-playwright`;
  if (cache.startsWith("/") && existsSync(cache)) {
    const versions = readdirSync(cache)
      .filter((name) => /^chromium_headless_shell-\d+$/.test(name)).sort();
    const bin = versions.length
      ? join(cache, versions[versions.length - 1]!,
        "chrome-headless-shell-linux64", "chrome-headless-shell")
      : "";
    if (bin && existsSync(bin)) return bin;
  }
  throw new Error("找不到 headless-shell:先跑一次 playwright 装缓存,或设 MFC_VISUAL_BROWSER 指到浏览器可执行文件");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 登录换会话 Cookie:与 web 登录同端点(/auth/login),取
 *  mae_flow_session 的值(只取值,注入时走 CDP 重新设)。 */
async function sessionCookie(base: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`登录失败 ${response.status}:${await response.text()}`);
  const pair = response.headers.getSetCookie()
    .map((line) => line.split(";")[0]!)
    .find((entry) => entry.startsWith("mae_flow_session="));
  if (!pair || pair === "mae_flow_session=") throw new Error("登录响应没有会话 Cookie");
  return pair.slice("mae_flow_session=".length);
}

interface CdpMessage { id?: number; error?: { message: string }; result?: unknown }

export interface Walkthrough {
  /** 导航到 base 下的路径,落定后歇 settleMs(默认 1500;首屏取数慢
   *  的页面给 2500+)。 */
  goto(path: string, settleMs?: number): Promise<void>;
  /** 执行一段页面 JS(通常以 .click() 收尾),完成后歇 settleMs
   *  (默认 700)让 React 状态与取数落定。 */
  click(expression: string, settleMs?: number): Promise<void>;
  /** 求值一段页面 JS,返回值要求可结构化克隆(returnByValue)。 */
  evalJs<T = unknown>(expression: string): Promise<T>;
  /** 截当前视口到 outDir 下的 name(PNG)。 */
  shot(name: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface WalkthroughOptions {
  /** 服务地址(调用方已起的 serve)。 */
  base: string;
  outDir: string;
  /** 登录账号;缺省 admin/mae-flow-demo(演示夹具 bootstrapAdmin 惯例)。 */
  username?: string;
  password?: string;
  /** 已有的会话 Cookie 值:给了就跳过登录。 */
  cookie?: string;
  /** 视口宽高,缺省 1920×1080(AGENTS.md 验收尺寸)。 */
  width?: number;
  height?: number;
}

/** 起一次走查会话并跑完步骤:结束(含抛错)保证杀浏览器、删临时
 *  profile。调试端口用 0 并从 DevToolsActivePort 读回,不撞固定端口。 */
export async function withWalkthrough(
  options: WalkthroughOptions, run: (walk: Walkthrough) => Promise<void>,
): Promise<void> {
  const base = options.base.replace(/\/+$/, "");
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const cookie = options.cookie
    ?? await sessionCookie(base, options.username ?? "admin", options.password ?? "mae-flow-demo");
  const chromePath = resolveHeadlessChrome();
  mkdirSync(options.outDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "mfc-ui-walk-"));
  const chrome = spawn(chromePath, [
    "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--window-size=${width},${height}`, "about:blank",
  ], { stdio: "ignore" });
  try {
    let debugPort = 0;
    for (let waited = 0; waited < 10_000 && !debugPort; waited += 200) {
      await sleep(200);
      try {
        debugPort = Number(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf-8").split("\n")[0]);
      } catch { /* 端口文件还没落盘,继续等 */ }
    }
    if (!debugPort) throw new Error("headless-shell 调试端口 10s 未就绪");
    let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
    for (let waited = 0; waited < 5_000 && !targets.length; waited += 200) {
      await sleep(200);
      targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        .then((response) => response.json() as Promise<typeof targets>).catch(() => []);
    }
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("headless-shell 没有可用的页面 target");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) reject(new Error(`CDP ${message.error.message}`));
      else resolve(message.result as never);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<never> =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Network.enable");
    const set = await send("Network.setCookie", {
      name: "mae_flow_session", value: cookie, url: `${base}/`, path: "/",
    }) as { success?: boolean };
    if (!set.success) throw new Error("会话 Cookie 注入失败");
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await send("Page.enable");
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true,
      }) as { result: { value: T } };
      return response.result.value;
    };
    await run({
      goto: async (path, settleMs = 1500) => {
        await send("Page.navigate", { url: `${base}${path}` });
        await sleep(settleMs);
      },
      click: async (expression, settleMs = 700) => {
        await send("Runtime.evaluate", {
          expression: `(async () => { ${expression} })()`, awaitPromise: true,
        });
        await sleep(settleMs);
      },
      evalJs: evaluate,
      shot: async (name) => {
        const { data } = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
        writeFileSync(join(options.outDir, name), Buffer.from(data, "base64"));
        console.log(`shot: ${name}`);
      },
      sleep,
    });
    ws.close();
  } finally {
    chrome.kill();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
