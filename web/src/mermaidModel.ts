export interface MermaidNode {
  id: string;
  label: string;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
}

export interface MermaidFlowModel {
  direction: "LR" | "RL" | "TB" | "BT";
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

function cleanLabel(value: string): string {
  return value.trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/<br\s*\/?\s*>/gi, "\n");
}

function nodeSpec(value: string): MermaidNode | undefined {
  const match = value.trim().match(/^([\w.-]+)\s*(.*)$/);
  if (!match) return undefined;
  const id = match[1];
  let label = match[2].trim();
  if (!label) return { id, label: id };
  // Mermaid 常见节点外壳统一剥掉；形状在审阅场景不是事实，文字才是。
  label = label
    .replace(/^\(\((.*)\)\)$/s, "$1")
    .replace(/^\[(.*)\]$/s, "$1")
    .replace(/^\((.*)\)$/s, "$1")
    .replace(/^\{(.*)\}$/s, "$1");
  return { id, label: cleanLabel(label) || id };
}

/** 只认 flowchart/graph 的节点和有向边；不支持的 Mermaid 留源码，
 * 宁可不画也不把开发依赖画错。 */
export function parseMermaidFlow(source: string): MermaidFlowModel | undefined {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const head = lines.find((line) => line.trim() && !line.trim().startsWith("%%"))
    ?.trim().match(/^(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)\s*$/i);
  if (!head) return undefined;
  const direction = (head[1].toUpperCase() === "TD" ? "TB"
    : head[1].toUpperCase()) as MermaidFlowModel["direction"];
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const remember = (node: MermaidNode | undefined) => {
    if (!node) return;
    const known = nodes.get(node.id);
    nodes.set(node.id, known && known.label !== known.id ? known : node);
  };

  for (const raw of lines.slice(1)) {
    const line = raw.replace(/%%.*$/, "").trim();
    if (!line || /^(?:subgraph|end|style|classDef|class|linkStyle|click)\b/i.test(line)) continue;
    const edge = line.match(/^(.+?)\s*(-->|---|==>|-\.->)\s*(?:\|([^|]*)\|\s*)?(.+?)\s*;?$/);
    if (edge) {
      const from = nodeSpec(edge[1]);
      const to = nodeSpec(edge[4]);
      if (!from || !to) continue;
      remember(from); remember(to);
      edges.push({
        from: from.id,
        to: to.id,
        label: edge[3]?.trim() || undefined,
        dashed: edge[2] === "-.->",
      });
      continue;
    }
    remember(nodeSpec(line.replace(/;$/, "")));
  }
  if (!nodes.size || !edges.length) return undefined;
  return { direction, nodes: [...nodes.values()], edges };
}

