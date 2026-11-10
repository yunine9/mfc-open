import type {
  WorkflowAssetCatalogItem,
  WorkflowAssetDetail,
  WorkflowAssetSummary,
  WorkflowDefinition,
  WorkflowStandardBase,
} from "../api";

const digest = "7c91a15bd3f4825a8d9ac7c747882e79037e0df9b7c71ec4821a72ec3ab40baf";

export const workflowBaseFixture: WorkflowStandardBase = {
  standard_id: "mae-flow-standard",
  standard_version: "2026.08",
  catalog_digest: digest,
  stages: [
    {
      id: "configuration", title: "配置确认", phase: "configuration",
      steps: ["配置事实齐全", "用户确认交付方式"],
      slots: [{ id: "context", cardinality: "many" }],
      items: [
        { id: "confirm-config", kind: "activity", title: "确认任务配置",
          description: "明确代码仓、基线、单号和交付方式。", locked: true,
          editable: false, source: "platform" },
      ],
    },
    {
      id: "exploration", title: "需求探索", phase: "exploration",
      steps: ["建立完整开发环境", "输出证据化方案"],
      slots: [{ id: "knowledge", cardinality: "many" },
        { id: "investigation", cardinality: "many" }],
      items: [
        { id: "repository-evidence", kind: "activity", title: "探索代码与依赖",
          description: "编译或安装依赖，避免只根据源码猜测周边行为。", locked: true,
          editable: false, source: "platform" },
        { id: "architecture-review", kind: "agent", title: "架构边界复核",
          description: "在涉及跨模块改动时复核边界。", locked: false,
          editable: true, source: "platform", use: { mode: "when_needed" } },
      ],
    },
    {
      id: "implementation", title: "开发实现", phase: "implementation",
      steps: ["实现需求", "运行受影响测试"],
      slots: [{ id: "implementation", cardinality: "many" }],
      items: [
        { id: "implement", kind: "activity", title: "实现并自测",
          description: "完成改动并保留验证证据。", locked: true,
          editable: false, source: "platform" },
      ],
    },
    {
      id: "delivery", title: "检视与交付", phase: "delivery",
      steps: ["人工检视", "流水线通过", "按授权交付"],
      slots: [{ id: "delivery", cardinality: "many" }],
      items: [
        { id: "human-review", kind: "activity", title: "人工检视",
          description: "由用户决定是否继续交付。", locked: true,
          editable: false, source: "platform" },
        { id: "prepush", kind: "tool", title: "Build-Fix",
          description: "验证当前提交并明确报告失败原因。", locked: true,
          editable: false, source: "platform" },
      ],
    },
  ],
};

export const workflowCatalogFixture: WorkflowAssetCatalogItem[] = [
  {
    ref: { registry: "business_knowledge", id: "frequency-domain-troubleshooting",
      version: "v3", digest, nature: "business", form: "skill",
      business_module_id: "radio-frequency" },
    type: "skill", title: "频点问题定位", summary: "按频点、网元和制式定位交叉冲突。",
    when_to_use: "频点导入、校验或冲突问题需要定位时",
    nature: "business", form: "skill", business_module_ids: ["radio-frequency"],
    repositories: ["ssh://git/radio/frequency-service.git"], technologies: [],
    availability: "available",
  },
  {
    ref: { registry: "team_skill", id: "pipeline-failure-triage",
      version: "v5", digest: `2${digest.slice(1)}`, form: "skill" },
    type: "skill", title: "流水线失败归因", summary: "区分代码、环境与超时问题并给出下一步。",
    when_to_use: "流水线失败或长时间无输出时", form: "skill",
    business_module_ids: [], repositories: [], technologies: [], availability: "available",
  },
  {
    ref: { registry: "repository_skill", id: "release-check",
      version: "sha-31ab", digest: `3${digest.slice(1)}`, form: "skill",
      repository: "ssh://git/radio/frequency-service.git",
      revision: "31ab", relative_path: ".agents/skills/release-check/SKILL.md" },
    type: "skill", title: "本仓发布检查", summary: "执行该仓特有的发布前验证。",
    form: "skill", business_module_ids: [],
    repositories: ["ssh://git/radio/frequency-service.git"], technologies: [],
    availability: "unavailable", warning: "当前基线没有该路径；保存时会明确提示并跳过该编辑。",
  },
  {
    ref: { registry: "platform_capability", id: "browser-evidence",
      version: "2026.08", digest: `4${digest.slice(1)}` },
    type: "tool", title: "浏览器端到端验证", summary: "启动服务并在真实页面完成关键路径验证。",
    when_to_use: "交互或排版改动需要真实页面证据时", business_module_ids: [],
    repositories: [], technologies: ["Web"], availability: "available",
  },
];

export const workflowDefinitionFixture: WorkflowDefinition = {
  schema: "mae-flow-workflow-definition/1",
  base: { standard_id: workflowBaseFixture.standard_id,
    standard_version: workflowBaseFixture.standard_version,
    catalog_digest: workflowBaseFixture.catalog_digest },
  applicability: {
    business_module_ids: ["radio-frequency"],
    repositories: ["ssh://git/radio/frequency-service.git"],
    technologies: ["Java", "C++"],
  },
  edits: [
    { edit_id: "add-frequency-triage", stage_id: "exploration", op: "add",
      item: { id: "frequency-triage", kind: "skill", title: "频点问题定位",
        description: "按频点、网元和制式定位交叉冲突。", locked: false,
        editable: true, source: "workflow", asset_ref: workflowCatalogFixture[0]!.ref,
        use: { mode: "on_stage_enter" } }, position: { after: "repository-evidence" } },
  ],
};

export const workflowAssetsFixture: WorkflowAssetSummary[] = [
  {
    id: "frequency-delivery", name: "频点需求稳健交付", description: "在探索阶段按需加载领域定位 Skill。",
    scope: "team", owner: "mae", maintainers: ["lin", "chen"], status: "published",
    latest_version: 3, draft_revision: 6, selectable_for_tasks: true,
    updated_at: "2026-08-28T10:20:00.000Z",
    permissions: { can_view: true, can_edit: true, can_submit: true,
      can_publish: false, can_archive: true },
  },
  {
    id: "frontend-e2e", name: "前端交互严格验证", description: "对交互改动增加浏览器端到端验证。",
    scope: "personal", owner: "developer", maintainers: [], status: "draft",
    latest_version: 0, draft_revision: 2, selectable_for_tasks: false,
    updated_at: "2026-08-29T02:15:00.000Z",
    permissions: { can_view: true, can_edit: true, can_submit: true,
      can_publish: true, can_archive: true },
  },
  {
    id: "legacy-release", name: "旧版发布加固", description: "已被新团队方案替代。",
    scope: "team", owner: "mae", maintainers: [], status: "archived",
    latest_version: 2, draft_revision: 4, selectable_for_tasks: false,
    updated_at: "2026-06-10T08:00:00.000Z",
    permissions: { can_view: true, can_edit: false, can_submit: false,
      can_publish: false, can_archive: false },
  },
];

export const workflowDetailFixture: WorkflowAssetDetail = {
  asset: workflowAssetsFixture[0]!,
  draft: { schema: "mae-flow-workflow-draft/1", revision: 6,
    definition: workflowDefinitionFixture, digest, updated_at: "2026-08-28T10:20:00.000Z",
    updated_by: "lin" },
  versions: [
    { version: 1, digest: `a${digest.slice(1)}`, published_at: "2026-08-18T06:00:00.000Z", published_by: "admin" },
    { version: 2, digest: `b${digest.slice(1)}`, published_at: "2026-08-24T06:00:00.000Z", published_by: "admin" },
    { version: 3, digest, published_at: "2026-08-28T10:20:00.000Z", published_by: "admin" },
  ],
};
