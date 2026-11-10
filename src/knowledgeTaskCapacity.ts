/** 各类知识任务共用执行名额；任务和运行状态仍由原服务保存。 */
export class KnowledgeTaskCapacity {
  private clients: Array<{ running: () => number; pump: () => void }> = [];
  constructor(readonly limit = 50) {}

  register(running: () => number, pump: () => void) {
    this.clients.push({ running, pump });
  }

  canStart(): boolean {
    return this.clients.reduce((total, client) => total + client.running(), 0) < this.limit;
  }

  wake() {
    for (const client of this.clients) client.pump();
  }
}
