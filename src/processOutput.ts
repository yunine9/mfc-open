/** 输出管道断开不应终止执行；入口和执行器都在第一条日志之前安装。 */
const guarded = new WeakSet<NodeJS.WriteStream>();
export function muzzleBrokenPipes(): void {
  for (const stream of [process.stdout, process.stderr]) {
    // Other listeners (including console's temporary listener) do not replace
    // our permanent handler. Repeated installation must remain idempotent.
    if (!guarded.has(stream)) {
      guarded.add(stream);
      stream.on("error", () => { /* 日志是旁路。 */ });
    }
  }
}
