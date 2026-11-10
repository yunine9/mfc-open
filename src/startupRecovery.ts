import { setImmediate } from "node:timers/promises";

/** 监听与业务就绪分开。恢复失败仍能应答诊断，但不允许用半份任务索引接单。 */
export class StartupRecovery {
  state: "recovering" | "ready" | "failed" = "recovering";
  async run(restore: () => Promise<void>, log: (message: string) => void): Promise<boolean> {
    try {
      await setImmediate(); // 让 listen 回调与首轮健康探针先得到响应。
      await restore();
      this.state = "ready";
      log("[serve] 任务恢复完成，开始接收业务请求");
      return true;
    } catch (error) {
      this.state = "failed";
      log(`[serve] 启动恢复失败，HTTP 保持监听，业务请求暂不可用：${String(error)}`);
      return false;
    }
  }
}
