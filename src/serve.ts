/** Web/API 入口。配置 runtime-url 时只转发；无该配置时保留单进程本地演练。 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionGateway } from "./executionGateway.ts";
import { muzzleBrokenPipes } from "./processOutput.ts";

muzzleBrokenPipes();

const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(`--${key}`);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`--${key} 需要参数`);
  return args[index + 1];
};
const configPath = argument("config") ?? (existsSync("/etc/mae-flow-cloud/serve.json") ? "/etc/mae-flow-cloud/serve.json" : undefined);
let config: Record<string, unknown> = {};
try {
  config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("服务配置必须是 JSON 对象");
} catch (error) {
  console.error(`[serve] 配置文件读取失败,拒绝启动: ${String(error)}`);
  process.exit(2);
}
const value = (key: string) => argument(key) ?? config[key];
const runtimeUrl = value("runtime-url");
if (!runtimeUrl) {
  console.log("[serve] 单进程模式：重启会中断执行。生产要保持会话连续，请独立启动 runtime 并配置 runtime-url。");
  await import("./executionRuntime.ts");
} else {
  const host = String(value("host") ?? "127.0.0.1");
  const port = Number(value("port") ?? 8787);
  const target = new URL(String(runtimeUrl));
  if (["127.0.0.1", "localhost", "::1", "[::1]", host].includes(target.hostname)
    && Number(target.port || (target.protocol === "https:" ? 443 : 80)) === port) {
    throw new Error("Web/API 入口和执行服务不能使用同一地址端口");
  }
  const server = createExecutionGateway({ runtimeUrl: String(runtimeUrl),
    webRoot: resolve(String(value("web-root") ?? fileURLToPath(new URL("../web/dist", import.meta.url)))),
    log: message => console.error(`[serve] ${message}`) });
  server.on("error", error => { console.error(`[serve] 监听失败: ${String(error)}`); process.exit(1); });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`[serve] Web/API 入口 http://${host}:${typeof address === "object" && address ? address.port : port} → ${target.origin}；入口重启不停止任务执行`);
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    console.log("[serve] 关闭 Web/API 连接；独立执行服务和任务继续运行");
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
