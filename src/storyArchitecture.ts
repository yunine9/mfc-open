import { architectureNodes, type ArchitectureNode } from './architectureDetails.ts';
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STORY_VIEWS, storyViewCoverage, type StoryViewCoverage, type StoryViewId } from "./storyViewCoverage.ts";

export const ARCHIFY_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type ArchifyType = typeof ARCHIFY_TYPES[number];
export const ARCHIFY_SOURCE_LIMIT = 256 * 1024;
export type StoryDiagram = { id: string; title: string; line?: number; view: StoryViewId;
  nodes?: ArchitectureNode[]; overview_id?: string; focus_node?: string;
  renderer: "archify"; type: ArchifyType; source: Record<string, unknown> };
export interface StoryArchitecture {
  revision: string; diagrams: StoryDiagram[]; warnings: string[];
  views: StoryViewCoverage[];
}
interface ArchifyArtifactDiagram { id?: unknown; view?: unknown; story_line?: unknown; source?: unknown; nodes?: unknown; overview_id?: unknown; focus_node?: unknown }

/** Story 只提供版本和 4+1 定位；架构页仅消费平台内部 Archify 产物。 */
export function storyArchitecture(story: string, archifyArtifact?: string): StoryArchitecture {
  const result: StoryArchitecture = {
    revision: createHash("sha256").update(story).update("\0").update(archifyArtifact ?? "").digest("hex"),
    diagrams: [], warnings: [], views: storyViewCoverage(story),
  };
  const lines = story.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!fence) continue;
    const start = i;
    const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
    while (++i < lines.length && !close.test(lines[i])) { /* 跳过其他代码块中的示例。 */ }
    const language = fence[2].trim().toLowerCase();
    if (language === "archify") {
      result.warnings.push(i === lines.length
        ? `Story 第 ${start + 1} 行：代码块尚未闭合`
        : `Story 第 ${start + 1} 行包含旧版 Archify 图源；请迁移到平台内部 architecture.json。`);
    }
  }
  if (archifyArtifact?.trim()) appendArchifyArtifact(result, story, archifyArtifact);
  return result;
}

function appendArchifyArtifact(result: StoryArchitecture, story: string, text: string): void {
  try {
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("平台架构产物超过 2 MB");
    const artifact = JSON.parse(text) as { schema_version?: unknown; story_sha256?: unknown; diagrams?: unknown };
    if (artifact.schema_version !== 1 || !Array.isArray(artifact.diagrams)) throw new Error("缺少 schema_version=1 或 diagrams 数组");
    const actual = createHash("sha256").update(story).digest("hex");
    if (artifact.story_sha256 !== actual) throw new Error("图源对应的 Story 版本已经变化");
    const ids = new Set<string>();
    for (const [index, raw] of artifact.diagrams.entries()) {
      if (result.diagrams.length >= 12) { result.warnings.push("最多展示 12 张图；其余内容请阅读 Story。"); break; }
      try {
        const item = raw as ArchifyArtifactDiagram;
        const id = typeof item.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(item.id)
          ? `archify-${item.id}` : `archify-${index + 1}`;
        if (ids.has(id)) throw new Error("id 重复");
        ids.add(id);
        if (!STORY_VIEWS.some((view) => view.id === item.view)) throw new Error("缺少合法 view");
        if (!item.source || Array.isArray(item.source) || typeof item.source !== "object") throw new Error("source 不是对象");
        const source = item.source as Record<string, unknown> & { diagram_type?: unknown; meta?: { title?: unknown } };
        if (!ARCHIFY_TYPES.includes(source.diagram_type as ArchifyType)) throw new Error("使用了不支持的类型");
        if (Buffer.byteLength(JSON.stringify(source)) > ARCHIFY_SOURCE_LIMIT) throw new Error("超过 256 KB");
        assertOfflineDiagram(source);
        const storyLine = Number.isInteger(item.story_line) && Number(item.story_line) > 0 ? Number(item.story_line) : undefined;
        result.diagrams.push({ id, view: item.view as StoryViewId, line: storyLine,
          title: typeof source.meta?.title === "string" ? source.meta.title : `架构图 ${index + 1}`,
          renderer: "archify", type: source.diagram_type as ArchifyType, source,
          nodes: architectureNodes(source, item.nodes),
          ...(typeof item.overview_id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(item.overview_id) && typeof item.focus_node === "string"
            ? {overview_id: `archify-${item.overview_id}`, focus_node: item.focus_node} : {}),
        });
      } catch (error) {
        result.warnings.push(`平台架构产物第 ${index + 1} 张图：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    result.warnings.push(`平台架构产物：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 发布时由宿主绑定 Story 摘要，Agent 无需自行伪造版本关系。 */
export function bindArchifyArtifact(story: string, artifact: string): string {
  const value = JSON.parse(artifact) as { schema_version?: unknown; diagrams?: unknown; story_sha256?: unknown };
  if (value.schema_version !== 1 || !Array.isArray(value.diagrams)) throw new Error("平台架构产物缺少 schema_version=1 或 diagrams 数组");
  value.story_sha256 = createHash("sha256").update(story).digest("hex");
  return JSON.stringify(value, null, 2);
}

/** 读取分析阶段独立生成的平台架构产物；缺失时不影响 Story 采用。 */
export function readAnalysisArchitecture(cwd: string | undefined, ticket: string): string | undefined {
  if (!cwd) return undefined;
  const path = join(cwd, ".mae-flow-work", ticket, "architecture.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** 此入口只读 JSON，图源不能启动远程品牌捕获、仓库取证或网络读取。 */
export function assertOfflineDiagram(source: Record<string, unknown>): void {
  const pending: unknown[] = [source];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "repository" || key === "sources" || key === "brand") {
        throw new Error("独立图展示不读取外部品牌或仓库证据，请将相关依据写入 Story 正文");
      }
      pending.push(child);
    }
  }
}

export const STORY_ARCHITECTURE_GUIDANCE = [
  "绘图是主任务分析的交付要求，不只是填写覆盖表：凡本需求涉及的视图，必须在 Story 对应章节画出能解释实际设计的图，并附必要说明；不能用一段文字、目录、状态表或空图代替设计图，也不能仅因没有画图就声称不涉及。",
  "按五个视角绘制：逻辑视图画功能结构及关键类/接口关系（类图）；开发视图画仓库、代码模块与依赖；进程视图画关键运行时序、协作及涉及的并发/异常；物理视图画部署节点、服务、存储及连接；场景视图画关键业务场景的参与者与交互，并关联对应设计和验收。只画与需求有关的关键内容，不要求穷举全部类或私有实现。",
  "4+1 是设计视角，不是五张图的数量指标。同一张图确实覆盖多个视角时可以复用，但在各视图中注明图的具体位置及其说明的设计问题；不可只拿一张模块拓扑宣称覆盖全部视图。",
  "4+1 必须逐项分析并知会用户：在 Story‘4+1 视图覆盖’表中保留逻辑视图、开发视图、进程视图、物理视图、场景视图（+1）五行，列为‘视图 | 状态 | 说明’。状态只用‘设计内容已完成 / 待补充 / 不涉及’。不涉及必须说明具体依据，不能静默删去；无法渲染不等于不涉及。",
  "沿用 Story 原章节，在对应内容前增加含视图名称的小标题，方便定位；已完成必须有实际设计支撑。逻辑视图要明确关键类图，有类图保留 PlantUML，无类图需单列‘类图 | 不涉及 | 具体原因’或‘类图 | 待补充 | 原因’，不能用模块拓扑代替。",
  "提交方案确认时，用简短提示集中知会哪些视图不涉及及原因、哪些待补充；责任人可提出异议并决定补充，不为此另建确认卡或 hook 门禁。不把已完成声明当作自动验收通过。",
  "Story 是可移植的设计正本：完整 4+1、类图和设计说明都写在既有章节，所有图只使用 PlantUML，确保上传到公司评审平台后仍能渲染。Story 正文和代码块中不得出现 Archify JSON、平台图源路径或‘Archify 投影’等平台实现说明。",
  "涉及却尚未画出设计图时标为待补充，说明缺口并在方案确认时知会用户。责任人决定后续处理，不新增 hook 门禁。",
  "上述格式约定只供生成时使用，不写入 Story 正文。图标题使用业务名称（如‘模块架构’、‘订单同步时序’），说明只解释职责、契约和交互。",
].join("\n");

export function archifyArtifactGuidance(path: string, references = "archify-reference/", hostValidation = false): string {
  return [
    `平台架构图是 Story 的内部派生产物，单独写到 ${path}；不得把 Archify JSON 写进 story.md。`,
    "先通读整个 Story，根据需求场景、模块职责、接口契约、依赖及运行部署关系组织架构图；不能只把某张 PlantUML 翻译成 Archify。已有图源只作参考，以全文设计为准。",
    `读取 ${references.replace(/\/?$/, "/")}README.md、对应 schema 和示例，为 Archify 能准确表达且确实需要展示的设计生成图；类图等不支持的内容只留在 Story 的 PlantUML 中，不冒充受支持类型。`,
    "产物格式：{\"schema_version\":1,\"story_sha256\":\"story.md 的真实 SHA-256\",\"diagrams\":[{\"id\":\"稳定短标识\",\"view\":\"logical|development|process|physical|scenarios\",\"story_line\":对应设计在 Story 中的起始行,\"source\":{Archify 原生 JSON}}]}。没有适合 Archify 的图时仍写空 diagrams 数组。",
    "architecture 图可在每个 diagrams 项中附 nodes 数组（与 source 同级）：[{id, responsibility, interfaces, acceptance, evidence}]。id 必须对应 source.components 的真实节点，说明具体职责、输入输出、验收与 Story 依据；资料节点说明用途和来源，不当作交付子任务。只依据设计填写，不补造。不要为每个节点重复生成一张图；局部图仅在确有必要时附 overview_id（总览图 id）和 focus_node（节点 id），它们是查看范围，不是子任务。",
    "source 必含 schema_version、diagram_type、meta.title；中文设置 meta.locale=zh-CN。只支持 architecture/workflow/sequence/dataflow/lifecycle，不得使用 brand、repository、sources 外部读取字段。",
    "选图按设计内容：模块依赖用 architecture，业务分支用 workflow，调用顺序用 sequence，数据转换用 dataflow，状态迁移用 lifecycle。view 表示 4+1 设计视角，不等于图类型；只选能准确表达全文设计的图。",
    hostValidation ? "平台负责实际渲染并绑定 story_sha256（可省略此字段，无需计算哈希）；写好图源后结束本轮，收到错误反馈时在原图源中修复。不要运行命令或写临时文件，不靠删除失败图规避验证。" : "每张图须与 Story 的职责、契约和交互一致。提交前使用固定离线渲染器实际试渲染并修复布局问题；无法成功渲染的图从 diagrams 中删除并如实报告，不生成空占位图。",
  ].join("\n");
}
