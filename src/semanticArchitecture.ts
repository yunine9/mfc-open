import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";

const MODULE_TYPES = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"] as const;
type ModuleType = typeof MODULE_TYPES[number];

interface SemanticModule {
  id: string;
  name: string;
  type?: ModuleType;
  summary: string;
  responsibility?: string;
  interfaces?: string;
  acceptance?: string;
  evidence?: string;
}
interface SemanticRelation { from: string; to: string; label: string }
interface SemanticArchitecture {
  schema_version: 1;
  title: string;
  modules: SemanticModule[];
  relations: SemanticRelation[];
}

const legend = {
  mode: "auto",
  entries: {
    frontend: { label: "界面与交互" }, backend: { label: "处理与编排" },
    database: { label: "数据与版本存储" }, cloud: { label: "基础设施" },
    security: { label: "安全控制" }, messagebus: { label: "消息与队列" },
    external: { label: "资料与外部依赖" },
  },
};

function guidedViews(data: SemanticArchitecture) {
  const names = new Map(data.modules.map((module) => [module.id, module.name]));
  const relationViews = data.relations.slice(0, 5).map((relation, index) => ({
    id: `collaboration-${index + 1}`,
    label: `${names.get(relation.from)} → ${names.get(relation.to)}`.slice(0, 48),
    focus: relation.from === relation.to ? [relation.from] : [relation.from, relation.to],
    note: relation.label.slice(0, 140),
  }));
  if (relationViews.length) return relationViews;
  return data.modules.slice(0, 5).map((module, index) => ({
    id: `module-${index + 1}`,
    label: module.name.slice(0, 48),
    focus: [module.id],
    note: module.summary.slice(0, 140),
  }));
}

function text(value: unknown, name: string, max: number, required = true): string {
  if ((value === undefined || value === null) && !required) return "";
  if (typeof value !== "string" || (required && !value.trim())) throw new Error(`${name} 必须是非空文本`);
  return value.trim().slice(0, max);
}
function parseSemanticArchitecture(raw: string): SemanticArchitecture {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.schema_version !== 1 || !Array.isArray(value.modules) || !Array.isArray(value.relations)) {
    throw new Error("语义架构产物缺少 schema_version=1、modules 或 relations");
  }
  if (!value.modules.length || value.modules.length > 24 || value.relations.length > 60) {
    throw new Error("语义架构图只允许 1–24 个模块和最多 60 条关系");
  }
  const modules = value.modules.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 个模块不是对象`);
    const row = item as Record<string, unknown>;
    const id = text(row.id, "模块 id", 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error(`模块 id ${id} 不合法`);
    const type = MODULE_TYPES.includes(row.type as ModuleType) ? row.type as ModuleType : undefined;
    return { id, name: text(row.name, `${id}.name`, 80), type,
      summary: text(row.summary, `${id}.summary`, 80),
      responsibility: text(row.responsibility, `${id}.responsibility`, 1000, false),
      interfaces: text(row.interfaces, `${id}.interfaces`, 1000, false),
      acceptance: text(row.acceptance, `${id}.acceptance`, 1000, false),
      evidence: text(row.evidence, `${id}.evidence`, 1000, false) };
  });
  const ids = new Set(modules.map((item) => item.id));
  if (ids.size !== modules.length) throw new Error("模块 id 重复");
  const relations = value.relations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 条关系不是对象`);
    const row = item as Record<string, unknown>;
    const from = text(row.from, "关系起点", 64), to = text(row.to, "关系终点", 64);
    if (!ids.has(from) || !ids.has(to)) throw new Error(`关系 ${from} → ${to} 引用了未知模块`);
    return { from, to, label: text(row.label, "关系说明", 80) };
  });
  return { schema_version: 1, title: text(value.title, "title", 120), modules, relations };
}

/** 模型只表达职责与关系；坐标、端口、折线和标签位置全部由宿主确定。 */
export async function compileSemanticArchitecture(story: string, raw: string): Promise<string> {
  const data = parseSemanticArchitecture(raw);
  const widths = new Map(data.modules.map((module) => [module.id,
    Math.max(260, [...module.name].length * 18 + 36, [...module.summary].length * 12 + 36)]));
  const graph: any = await new ELK().layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "90", "elk.layered.spacing.nodeNodeBetweenLayers": "160",
      "elk.padding": "[top=80,left=60,bottom=80,right=60]", "elk.spacing.edgeNode": "35",
      "elk.layered.spacing.edgeNodeBetweenLayers": "35",
    },
    children: data.modules.map((module) => ({ id: module.id, width: widths.get(module.id), height: 100,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [{ id: `${module.id}-out`, x: widths.get(module.id), y: 50, width: 0, height: 0 },
        { id: `${module.id}-in`, x: 0, y: 50, width: 0, height: 0 }] })),
    edges: data.relations.map((relation, index) => ({ id: `r${index}`,
      sources: [`${relation.from}-out`], targets: [`${relation.to}-in`],
      labels: [{ text: relation.label, width: Math.max(80, [...relation.label].length * 12), height: 22 }] })),
  });
  const source = {
    schema_version: 1, diagram_type: "architecture",
    meta: { title: data.title, locale: "zh-CN", subtitle: "模块职责与协作 · 连线不代表任务串行",
      legend, views: guidedViews(data),
      viewBox: [Math.max(1000, Number(graph.width ?? 920) + 80), Math.max(540, Number(graph.height ?? 440) + 100)] },
    components: (graph.children ?? []).map((node) => {
      const module = data.modules.find((item) => item.id === node.id)!;
      return { id: module.id, type: module.type ?? "external", ...(!module.type ? { tag: "类型待明确" } : {}),
        label: module.name, sublabel: module.summary, pos: [node.x ?? 0, node.y ?? 0], size: [node.width ?? 260, node.height ?? 100] };
    }),
    connections: data.relations.map((relation, index) => {
      const edge = graph.edges?.find((item) => item.id === `r${index}`);
      const section = edge?.sections?.[0], label = edge?.labels?.[0];
      return { id: `r${index}`, from: relation.from, to: relation.to, label: relation.label,
        fromSide: "right", toSide: "left",
        via: (section?.bendPoints ?? []).map((point) => [point.x, point.y]),
        ...(label ? { labelAt: [(label.x ?? 0) + (label.width ?? 0) / 2, (label.y ?? 0) + 14] } : {}) };
    }),
  };
  return JSON.stringify({ schema_version: 1,
    story_sha256: createHash("sha256").update(story).digest("hex"),
    diagrams: [{ id: "module-collaboration", view: "development", source,
      nodes: data.modules.map((module) => ({ id: module.id,
        responsibility: module.responsibility, interfaces: module.interfaces,
        acceptance: module.acceptance, evidence: module.evidence })) }] }, null, 2);
}

export const SEMANTIC_ARCHITECTURE_GUIDANCE = [
  "架构语义是本次需求分析必须交付的产物之一。写完 Story 后必须写它；缺失时平台不会生成架构图，不要以 Story 已完成为由省略。",
  "平台架构图只需要语义，不要生成 Archify 字段、坐标、尺寸、端口或折线；宿主会程序化布局并执行真实渲染。",
  "将语义产物写入 architecture.semantic.json，JSON 格式：",
  '{"schema_version":1,"title":"标题","modules":[{"id":"英文短ID","name":"模块名","type":"frontend|backend|database|cloud|security|messagebus|external","summary":"20字内职责摘要","responsibility":"完整职责","interfaces":"提供或消费的接口/材料","acceptance":"设计要求，不声称已经验证","evidence":"Story 原文依据"}],"relations":[{"from":"模块ID","to":"模块ID","label":"12字内关系说明"}]}。',
  "覆盖主要业务模块、协作方和必要资料依赖，合并重复角色，通常不超过 12 个模块。关系表示调用或材料流转，不表示任务必须串行；按主要协作顺序排列 relations，宿主会据此生成可播放的分步讲解。",
  "类型按真实职责选择，不为配色编造数据库、队列或基础设施；不能确定类型时省略 type。只依据 Story，不补造功能。",
].join("\n");

export function readAnalysisSemanticArchitecture(cwd: string | undefined, ticket: string): string | undefined {
  if (!cwd) return undefined;
  const path = join(cwd, ".mae-flow-work", ticket, "architecture.semantic.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
