import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MrDescriptionReplyService } from "./mrDescriptionReply.ts";
import type { TaskService } from "../../src/taskService.ts";

/** 专项验证集成用例明确要求：本轮先独立编译，再交付。
 * 仅模拟这个主动请求；生产交付不调用 preparePush。编译 runner、容器、
 * 收据、失败出口和后续推送均使用真实实现，不增加生产自动编译开关。 */
export function requestBuildFixBeforeDelivery(service: TaskService): void {
  const api = service as any;
  const deliver = api.tryDeliver.bind(service);
  api.tryDeliver = async (task: any, epoch: number) => {
    if (api.options.prepush?.enabled && task.cwd) {
      const state = JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8"));
      if (!await api.preparePush(task, state.config?.["分支名"], state.config?.["基线分支"], epoch)) return;
    }
    return deliver(task, epoch);
  };
}

export class RequestedBuildFixService extends MrDescriptionReplyService {
  constructor(options: ConstructorParameters<typeof MrDescriptionReplyService>[0]) {
    super(options);
    requestBuildFixBeforeDelivery(this);
  }
}
