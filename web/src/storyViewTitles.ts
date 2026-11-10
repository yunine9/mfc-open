import type { StoryViewId } from "../../src/storyViewCoverage";

/** 面向读者的入口名称；标准 4+1 名称和稳定 ID 仍用于文档契约。 */
export const storyViewTitles: Record<StoryViewId, string> = {
  logical: "功能与类设计",
  development: "代码模块与依赖",
  process: "运行流程与并发",
  physical: "部署与运行环境",
  scenarios: "业务场景与交互",
};
