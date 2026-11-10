import { TaskService } from "../../src/taskService.ts";
import { MR_DESCRIPTION_STEP } from "../../src/mrDescription.ts";

export const TEST_AR_DESCRIPTION = "测试 AR 单的准确描述";
/** 交付链夹具模拟责任人填写新增开放题；不绕过生产决定接口。 */
export class MrDescriptionReplyService extends TaskService {
  constructor(options: ConstructorParameters<typeof TaskService>[0]) {
    super(options);
    const service = this as any;
    const notify = service.notifyWaiting.bind(this);
    service.notifyWaiting = (task: any) => {
      if (task.summary.waiting?.step !== MR_DESCRIPTION_STEP) return notify(task);
      const waiting = task.summary.waiting;
      setImmediate(() => {
        void this.decide(task.summary.id, {
          waiting_id: waiting.waiting_id, state_version: waiting.state_version,
          decision: TEST_AR_DESCRIPTION, actor: task.summary.luban_account,
        }).catch(error => { task.summary.detail = String(error); });
      });
    };
  }
}
