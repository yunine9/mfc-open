/**
 * 4+1 视图中的组件、部署、用例与状态拓扑解析器。
 *
 * 与活动图一样，这里采用完整理解才绘制的策略：未知语句返回准确行号，
 * 不允许“漏几个节点/关系但仍显示成功”。
 */

export type TopologyNodeKind =
  | "component" | "package" | "node" | "database" | "cloud"
  | "artifact" | "folder" | "rectangle" | "queue" | "storage"
  | "actor" | "usecase" | "state" | "interface" | "entity"
  | "generic" | "start" | "end";

export interface TopologyNode {
  id: string;
  label: string;
  kind: TopologyNodeKind;
  group: string;
  notes: string[];
}

export interface TopologyEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  directed: boolean;
}

export type TopologyView = "component" | "deployment" | "usecase" | "state";

export interface TopologyModel {
  title: string;
  direction: "LR" | "RL" | "TB" | "BT";
  view: TopologyView;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface TopologyParseIssue {
  line: number;
  message: string;
}

export interface TopologyParseResult {
  model?: TopologyModel;
  issue?: TopologyParseIssue;
}

class TopologyParseFailure extends Error {
  constructor(readonly line: number, message: string) { super(message); }
}

const DECLARATION = /^(component|package|node|database|cloud|artifact|folder|rectangle|queue|storage|actor|usecase|state|interface|entity)\s+(?:"([^"]+)"|([\w.$/-]+))(?:\s+as\s+([\w.$/-]+))?(?:\s+<<[^>]+>>)?\s*(\{)?\s*$/i;
const COMPONENT_SHORTHAND = /^(?:component\s+)?\[([^\]]+)\](?:\s+as\s+([\w.$/-]+))?(?:\s+<<[^>]+>>)?\s*(\{)?\s*$/i;
const USECASE_SHORTHAND = /^(?:usecase\s+)?\(([^)]+)\)(?:\s+as\s+([\w.$/-]+))?\s*(\{)?\s*$/i;
const EDGE = /^(.+?)\s+([<|>*o+.-]+(?:left|right|up|down)?[<|>*o+.-]*)\s+(.+?)(?:\s*:\s*(.*))?$/i;
const STRONG_TOPOLOGY = /^\s*(?:component|package|node|cloud|artifact|folder|rectangle|queue|storage|usecase|state)\s+/im;

function clean(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\\n/g, " ");
}

function implicitId(label: string): string {
  const stable = label.replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^_+|_+$/g, "");
  return stable || "node";
}

function kindOf(value: string): TopologyNodeKind {
  return value.toLowerCase() as TopologyNodeKind;
}

function viewOf(nodes: TopologyNode[]): TopologyView {
  const kinds = new Set(nodes.map((node) => node.kind));
  if (kinds.has("usecase") || kinds.has("actor")) return "usecase";
  if (["node", "cloud", "artifact"]
    .some((kind) => kinds.has(kind as TopologyNodeKind))) return "deployment";
  const onlyInfrastructure = ["database", "storage", "queue"]
    .some((kind) => kinds.has(kind as TopologyNodeKind))
    && !["component", "package", "interface", "entity"]
      .some((kind) => kinds.has(kind as TopologyNodeKind));
  if (onlyInfrastructure) return "deployment";
  if (kinds.has("state") || kinds.has("start") || kinds.has("end")) return "state";
  return "component";
}

export function looksLikeTopology(source: string): boolean {
  if (STRONG_TOPOLOGY.test(source)) return true;
  return source.replace(/\r\n?/g, "\n").split("\n").some((raw) => {
    const line = raw.trim();
    return /^\[\*\]\s+[-.<]/.test(line)
      || /[-.>]\s+\[\*\]$/.test(line)
      || /^\[[^\]]+\](?:\s+as\s+\S+)?\s*(?:[-.>]|$)/.test(line)
      || /^\([^()]+\)(?:\s+as\s+\S+)?\s*(?:[-.>]|$)/.test(line);
  });
}

export function inspectTopology(source: string): TopologyParseResult {
  let title = "";
  let direction: TopologyModel["direction"] = "TB";
  const nodes = new Map<string, TopologyNode>();
  const aliases = new Map<string, string>();
  const edges: TopologyEdge[] = [];
  const groups: Array<{ label: string; line: number }> = [];
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");

  const group = () => groups.map((item) => item.label).join("/");
  const remember = (
    idValue: string,
    labelValue: string,
    kind: TopologyNodeKind,
    line: number,
  ): TopologyNode => {
    const id = clean(idValue);
    const label = clean(labelValue);
    const known = nodes.get(id);
    if (known && known.kind !== "generic"
      && (known.label !== label || known.kind !== kind)) {
      throw new TopologyParseFailure(line, `节点别名 ${id} 被重复用于不同节点`);
    }
    const node = known && known.kind !== "generic" ? known : {
      id,
      label: label || id,
      kind,
      group: group(),
      notes: known?.notes ?? [],
    };
    nodes.set(id, node);
    aliases.set(id, id);
    aliases.set(label, id);
    return node;
  };

  const endpoint = (
    value: string,
    line: number,
    role: "from" | "to",
  ): string => {
    const raw = value.trim();
    if (raw === "[*]") {
      const id = role === "from" ? "__start__" : "__end__";
      remember(id, role === "from" ? "开始" : "结束",
        role === "from" ? "start" : "end", line);
      return id;
    }
    const bracket = raw.match(/^\[([^\]]+)\]$/);
    const usecase = raw.match(/^\(([^)]+)\)$/);
    const label = clean(bracket?.[1] ?? usecase?.[1] ?? raw);
    const known = aliases.get(label) ?? aliases.get(raw);
    if (known) return known;
    const id = implicitId(label);
    remember(id, label, bracket ? "component" : usecase ? "usecase" : "generic", line);
    return id;
  };

  try {
    for (let at = 0; at < rawLines.length; at += 1) {
      const lineNumber = at + 1;
      const text = rawLines[at].trim();
      if (!text || text.startsWith("'") || /^@(?:start|end)uml(?:\s+\S+)?$/i.test(text)) {
        continue;
      }
      const named = text.match(/^title\s+(.+)$/i);
      if (named) { title = named[1].trim(); continue; }
      if (/^left\s+to\s+right\s+direction$/i.test(text)) { direction = "LR"; continue; }
      if (/^right\s+to\s+left\s+direction$/i.test(text)) { direction = "RL"; continue; }
      if (/^top\s+to\s+bottom\s+direction$/i.test(text)) { direction = "TB"; continue; }
      if (/^bottom\s+to\s+top\s+direction$/i.test(text)) { direction = "BT"; continue; }
      if (/^(?:hide|show|scale)\b/i.test(text)
        || /^!\S*/.test(text)
        || (/^skinparam\b/i.test(text) && !/\{\s*$/.test(text))) continue;

      if (text === "}") {
        if (!groups.length) {
          throw new TopologyParseFailure(lineNumber, "出现了多余的右大括号 }");
        }
        groups.pop();
        continue;
      }

      const declaration = text.match(DECLARATION);
      const component = declaration ? undefined : text.match(COMPONENT_SHORTHAND);
      const usecase = declaration || component ? undefined : text.match(USECASE_SHORTHAND);
      if (declaration || component || usecase) {
        const kind = declaration ? kindOf(declaration[1])
          : component ? "component" : "usecase";
        const label = declaration
          ? clean(declaration[2] ?? declaration[3])
          : clean((component ?? usecase)![1]);
        const alias = declaration?.[4] ?? component?.[2] ?? usecase?.[2]
          ?? implicitId(label);
        const opens = Boolean(declaration?.[5] ?? component?.[3] ?? usecase?.[3]);
        remember(alias, label, kind, lineNumber);
        if (opens) groups.push({ label, line: lineNumber });
        continue;
      }

      const inlineNote = text.match(/^note\s+(?:left|right|top|bottom)\s+of\s+([\w.$/-]+)\s*:\s*(.*)$/i);
      const blockNote = inlineNote ? undefined
        : text.match(/^note\s+(?:left|right|top|bottom)\s+of\s+([\w.$/-]+)\s*$/i);
      if (inlineNote || blockNote) {
        const target = aliases.get((inlineNote ?? blockNote)![1]);
        if (!target || !nodes.has(target)) {
          throw new TopologyParseFailure(lineNumber,
            `note 引用了尚未声明的节点 ${(inlineNote ?? blockNote)![1]}`);
        }
        let body = inlineNote?.[2]?.trim() ?? "";
        if (blockNote) {
          const values: string[] = [];
          const opening = lineNumber;
          at += 1;
          while (at < rawLines.length && !/^end\s+note$/i.test(rawLines[at].trim())) {
            values.push(rawLines[at].trim());
            at += 1;
          }
          if (at >= rawLines.length) {
            throw new TopologyParseFailure(opening, "note 缺少 end note");
          }
          body = values.join("\\n");
        }
        nodes.get(target)!.notes.push(body);
        continue;
      }

      const relation = text.match(EDGE);
      if (relation) {
        const arrow = relation[2].toLowerCase();
        let from = endpoint(relation[1], lineNumber, "from");
        let to = endpoint(relation[3], lineNumber, "to");
        if (arrow.startsWith("<") && !arrow.endsWith(">")) [from, to] = [to, from];
        edges.push({
          from,
          to,
          label: relation[4]?.trim() || undefined,
          dashed: arrow.includes("."),
          directed: arrow.includes(">") || arrow.includes("<"),
        });
        continue;
      }

      throw new TopologyParseFailure(lineNumber,
        `暂不支持架构图语句“${text}”`);
    }

    if (groups.length) {
      const open = groups.at(-1)!;
      throw new TopologyParseFailure(open.line,
        `分组“${open.label}”缺少右大括号 }`);
    }
    if (!nodes.size) return { issue: { line: 1, message: "架构图没有可绘制节点" } };
    const model: TopologyModel = {
      title,
      direction,
      view: viewOf([...nodes.values()]),
      nodes: [...nodes.values()],
      edges,
    };
    return { model };
  } catch (error) {
    if (error instanceof TopologyParseFailure) {
      return { issue: { line: error.line, message: error.message } };
    }
    return { issue: { line: 1, message: "架构图解析失败" } };
  }
}

export function parseTopology(source: string): TopologyModel | undefined {
  return inspectTopology(source).model;
}
