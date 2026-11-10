import { observedPipelineRun } from "./pipelineHandoff.ts";
import { getPipelineStatus, type PipelineCallBase, type PipelineRun } from "./pipelineClient.ts";

/** 只观察指定提交。编码会话换代不撤销旁路监听；停止条件由宿主掌握。
 * 空查询、查询失败和真实 running 分开，不重复触发、不使用旧 SHA 结果。
 * 终态如何处理由宿主决定：提前验证只更新事实，正式交付才派发修复/核销。 */
export async function watchTaskPipeline(options: {
  call(): PipelineCallBase & { sha: string };
  interval: number;
  current(): boolean;
  observed(run?: PipelineRun): Promise<boolean>;
  unavailable(error: unknown): boolean | void;
}): Promise<void> {
  while (options.current()) {
    await new Promise(resolve => setTimeout(resolve, options.interval).unref());
    if (!options.current()) return;
    let run: PipelineRun | undefined;
    try {
      const call = options.call();
      run = observedPipelineRun(call.sha, await getPipelineStatus(call));
    } catch (error) {
      if (options.current() && options.unavailable(error)) return;
      continue;
    }
    if (!options.current()) return; // 请求期间发生换提交/暂停/取消，迟到结果不接管新现场。
    if (await options.observed(run)) return;
  }
}
