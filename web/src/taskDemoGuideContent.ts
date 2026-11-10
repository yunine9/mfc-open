/** 演示讲解按阶段名称取文案；阶段顺序和任务进度仍由 task.progress.phases 提供。 */
export interface TaskDemoGuideNarration {
  agent: string;
  platform: string;
  human: string;
}

export interface TaskDemoGuideSegment extends TaskDemoGuideNarration {
  id: string;
  label: string;
}

export interface TaskDemoGuideContent extends TaskDemoGuideNarration {
  title: string;
  /** 仅供演示者选择材料时推荐文件，不用于判断文件所属阶段或执行状态。 */
  artifactPatterns: readonly RegExp[];
  caption: {
    document: string;
    message: string;
  };
  segments?: readonly TaskDemoGuideSegment[];
}

const reviewNarration: TaskDemoGuideNarration = {
  agent: "用前后对比呈现实际改动，列清测试证据和未验证项，让开发快速看懂改了什么、还缺什么。",
  platform: "按提交版本跟踪验证结果，关联团队检视意见和处理记录，让质量判断有依据、问题处理可追溯。",
  human: "开发重点检查关键逻辑和验证缺口，协调相关人员补充验证；需求 owner 把关交付结果，对质量负责。",
};

const guides: Readonly<Record<string, TaskDemoGuideContent>> = {
  需求拆分: {
    title: "需求拆分",
    agent: "先研究整体方案，再拆清任务、接口和依赖，让多个 Agent 围绕同一交付目标协作。",
    platform: "将确认后的分工转为可执行任务，按依赖自动调度、传递前置结果，减少人工催办和任务间反复交接。",
    human: "各模块开发共同检视接口和职责，需求 owner 协调分工与交付顺序，对整体集成效果负责。",
    artifactPatterns: [/(?:overall[-_]story|requirement[-_]analysis|整体拆分方案|拆分方案)[^/]*\.(?:md|html)$/i],
    caption: {
      document: "看任务分工、接口约定和前后依赖。",
      message: "对照拆分建议及确认记录，说明任务如何衔接。",
    },
  },
  启动: {
    title: "启动",
    agent: "结合领域知识和 Skill 理解任务，复用已有经验，减少重复研究和同类问题反复踩坑。",
    platform: "自动匹配知识与 Skill，按选定工作流组织执行，让超级个体的成熟实践被团队复用，提升交付下限。",
    human: "需求 owner 明确目标与范围，开发判断既有经验是否适用，为本次交付确定共同预期。",
    artifactPatterns: [/(?:^|\/)survey\.md$/i, /(?:^|\/)requirement\.md$/i],
    caption: {
      document: "看任务目标及本次准备的资料。",
      message: "选一条实际准备记录，看 Agent 获得了哪些资料和方法。",
    },
  },
  澄清需求: {
    title: "澄清需求",
    agent: "研究业务和代码，由子 Agent 专门质疑假设、查找遗漏，提前暴露需求盲区。",
    platform: "程序关联提问、原始答复和最终决定，并传给后续阶段，让需求不在多轮协作中失真。",
    human: "开发补充业务约束，需求 owner 决定范围与取舍，把关键分歧解决在编码之前，减少方向性返工。",
    artifactPatterns: [/(?:^|\/)grill\.md$/i, /(?:^|\/)decisions\.md$/i],
    caption: {
      document: "看一条问题、建议及 owner 的原始决定。",
      message: "选一条真实提问，看 Agent 提问前查到了什么。",
    },
  },
  定规格: {
    title: "写规格",
    agent: "把需求转成可验证的行为和用例，覆盖正常、边界与异常场景，让编码和测试对照同一套预期。",
    platform: "用确认结果控制阶段推进，调整意见在当前环节处理，让后续设计和实现有共同的验收依据。",
    human: "开发和需求 owner 共同检视关键场景，确认怎样才算完成，避免代码与测试一起偏离业务预期。",
    artifactPatterns: [/(?:^|\/)spec\.md$/i],
    caption: {
      document: "只看一条关键验收条件，不逐段阅读规格文档。",
      message: "选一条实际确认记录，看预期行为怎样确定。",
    },
  },
  写设计: {
    title: "写设计",
    agent: "生成方案与架构图，再由独立子 Agent 对抗检视，质疑关键假设，尽早发现设计漏洞和需求偏差。",
    platform: "用程序检查检视是否完成、意见是否处理，让质量要求落实到执行，减少对 Agent 自觉遵守的依赖。",
    human: "开发共同检视架构、兼容性和维护成本，重点把关高风险设计；需求 owner 确认业务取舍。",
    artifactPatterns: [/(?:^|\/)story\.md$/i, /(?:^|\/)implementation\.md$/i],
    caption: {
      document: "框出关键设计，可直接演示批注和修改差异。",
      message: "选一条设计检视或修改说明，对照实际方案。",
    },
  },
  写代码: {
    title: "写代码",
    agent: "按确认方案编码、测试，发现问题后修复并复验，让实现与验证形成闭环，减少人工逐轮推动。",
    platform: "程序管理执行状态与人工确认，云端保留任务现场，让自动执行可追踪、可暂停、可接续。",
    human: "开发重点检视关键逻辑、风险改动和验证缺口，对代码质量负责；需求或关键方案变化由 owner 决定。",
    artifactPatterns: [/(?:^|\/)(?:test[^/]*|implementation)\.md$/i, /未提交改动/],
    caption: {
      document: "看关键改动及对应的验证依据。",
      message: "选一条真实修复记录，展示问题、处理和复验结果。",
    },
  },
  检视与验证: {
    title: "检视与验证",
    ...reviewNarration,
    artifactPatterns: [/^task-materials\/交付报告\.md$/],
    caption: {
      document: "看关键改动、已有测试结果和仍需验证的内容。",
      message: "选一条实际检视意见或流水线反馈，说明后续处理。",
    },
    segments: [
      { id: "review", label: "检视交付", ...reviewNarration },
      {
        id: "feedback",
        label: "处理反馈",
        agent: "分析流水线失败和已采纳的检视意见，修复后重新验证，让交付反馈转成代码与测试的改进。",
        platform: "跟踪新提交的验证结果，按配置触发失败修复；人工意见经 owner 决定后执行，让反馈有人处理、有结果可查。",
        human: "开发复核修复结果，相关成员共同检视影响；需求 owner 决定意见取舍和合入时机，对最终交付负责。",
      },
    ],
  },
  已合入: {
    title: "已合入",
    agent: "从实际改动和检视反馈中提炼经验，说明适用场景，把本次解决的问题变成下次任务的参考。",
    platform: "通过交付分析定位返工环节，将人工采纳的经验用于后续任务，优化流程和知识，提升首次代码接受率。",
    human: "开发共同复盘返工原因，审查经验与改进建议，对知识质量负责，并用后续交付检验改进效果。",
    artifactPatterns: [/(?:memory|经验|知识)[^/]*\.md$/i],
    caption: {
      document: "展示一条确有来源和适用范围的经验；没有就保留空位。",
      message: "选一条实际合入或经验整理记录，说明结果从何而来。",
    },
  },
};

export function getTaskDemoGuideContent(phase: string): TaskDemoGuideContent | undefined {
  return Object.prototype.hasOwnProperty.call(guides, phase) ? guides[phase] : undefined;
}

export function taskDemoPhaseTitle(phase: string): string {
  return getTaskDemoGuideContent(phase)?.title ?? phase;
}
