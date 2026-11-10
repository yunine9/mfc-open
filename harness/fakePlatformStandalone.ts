/**
 * 独立假交付平台(开发测试用):给非内核模式的服务提供 POST /mr 等
 * 端点。seed 仓=本仓库,裸仓落 .tasks/origin.git(与 --fake-platform
 * 在内核模式下的布局一致)。用法:
 *   npx tsx harness/fakePlatformStandalone.ts   # 打印 baseUrl 后保活
 *   npm run serve -- --data .tasks --port 8787 --platform <baseUrl>
 */
import { FakeGitPlatform } from "../src/gitPlatform.ts";

const platform = new FakeGitPlatform();
platform.initBare(
  "/workspace/mae-flow-cloud",
  "/workspace/mae-flow-cloud/.tasks",
);
await platform.start();
console.log(`[fake-platform] 就绪: ${platform.baseUrl}`);
setInterval(() => { /* 保活:平台随本进程存活 */ }, 1 << 30);
