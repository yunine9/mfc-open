import { useId } from "react";
import { parseMermaidFlow, type MermaidFlowModel } from "./mermaidModel";

function visualLength(text: string): number {
  return Array.from(text).reduce((sum, character) =>
    sum + (/[^\u0000-\u00ff]/.test(character) ? 1 : .58), 0);
}

function linesOf(label: string): string[] {
  const explicit = label.split("\n").filter(Boolean);
  if (explicit.length > 1) return explicit;
  if (visualLength(label) <= 20) return [label];
  const characters = Array.from(label);
  const midpoint = Math.ceil(characters.length / 2);
  return [characters.slice(0, midpoint).join(""), characters.slice(midpoint).join("")];
}

function levelsOf(model: MermaidFlowModel): Map<string, number> {
  const incoming = new Map(model.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(model.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of model.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const level = new Map(model.nodes.map((node) => [node.id, 0]));
  const queue = model.nodes.filter((node) => !incoming.get(node.id)).map((node) => node.id);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    seen.add(id);
    for (const child of outgoing.get(id) ?? []) {
      level.set(child, Math.max(level.get(child) ?? 0, (level.get(id) ?? 0) + 1));
      incoming.set(child, (incoming.get(child) ?? 1) - 1);
      if (!incoming.get(child)) queue.push(child);
    }
  }
  // 环或残缺投影不会无限算层；剩余节点集中放到最后一列并保留边。
  const last = Math.max(0, ...level.values());
  model.nodes.filter((node) => !seen.has(node.id))
    .forEach((node) => level.set(node.id, last + 1));
  return level;
}

function Diagram({ model }: { model: MermaidFlowModel }) {
  const marker = `mermaid-arrow-${useId().replace(/:/g, "")}`;
  const horizontal = model.direction === "LR" || model.direction === "RL";
  const reverse = model.direction === "RL" || model.direction === "BT";
  const nodeWidth = 190;
  const nodeHeight = 62;
  const mainGap = 110;
  const crossGap = 28;
  const padding = 34;
  const levels = levelsOf(model);
  const maxLevel = Math.max(0, ...levels.values());
  const groups = Array.from({ length: maxLevel + 1 }, (_, value) =>
    model.nodes.filter((node) => levels.get(node.id) === value));
  const crossCount = Math.max(1, ...groups.map((group) => group.length));
  const mainSize = padding * 2 + (maxLevel + 1) * nodeWidth + maxLevel * mainGap;
  const crossSize = padding * 2 + crossCount * nodeHeight + (crossCount - 1) * crossGap;
  const width = horizontal ? mainSize : Math.max(520, crossSize);
  const height = horizontal ? Math.max(150, crossSize) : mainSize;
  const positions = new Map<string, { x: number; y: number }>();
  groups.forEach((group, rawLevel) => {
    const level = reverse ? maxLevel - rawLevel : rawLevel;
    const occupied = group.length * nodeHeight + Math.max(0, group.length - 1) * crossGap;
    group.forEach((node, index) => {
      const cross = (crossSize - occupied) / 2 + nodeHeight / 2 + index * (nodeHeight + crossGap);
      const main = padding + nodeWidth / 2 + level * (nodeWidth + mainGap);
      positions.set(node.id, horizontal ? { x: main, y: cross } : { x: cross, y: main });
    });
  });

  return <svg className="mermaid-diagram" viewBox={`0 0 ${width} ${height}`}
    role="img" aria-label="Mermaid 开发依赖流程图">
    <defs>
      <marker id={marker} markerWidth="8" markerHeight="6" refX="7.5" refY="3" orient="auto">
        <path d="M0,0 L8,3 L0,6 z" />
      </marker>
    </defs>
    {model.edges.map((edge, index) => {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      const horizontalEdge = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
      const sign = horizontalEdge ? Math.sign(to.x - from.x) : Math.sign(to.y - from.y);
      const start = horizontalEdge
        ? { x: from.x + sign * nodeWidth / 2, y: from.y }
        : { x: from.x, y: from.y + sign * nodeHeight / 2 };
      const end = horizontalEdge
        ? { x: to.x - sign * nodeWidth / 2, y: to.y }
        : { x: to.x, y: to.y - sign * nodeHeight / 2 };
      const path = horizontalEdge
        ? `M${start.x} ${start.y} C${(start.x + end.x) / 2} ${start.y},${(start.x + end.x) / 2} ${end.y},${end.x} ${end.y}`
        : `M${start.x} ${start.y} C${start.x} ${(start.y + end.y) / 2},${end.x} ${(start.y + end.y) / 2},${end.x} ${end.y}`;
      return <g key={`${edge.from}-${edge.to}-${index}`}>
        <path className={`mermaid-edge${edge.dashed ? " dashed" : ""}`}
          d={path} markerEnd={`url(#${marker})`} />
        {edge.label && <text className="mermaid-edge-label"
          x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 8}
          textAnchor="middle">{edge.label}</text>}
      </g>;
    })}
    {model.nodes.map((node) => {
      const point = positions.get(node.id)!;
      const labelLines = linesOf(node.label);
      return <g key={node.id}>
        <rect className="mermaid-node" x={point.x - nodeWidth / 2}
          y={point.y - nodeHeight / 2} width={nodeWidth} height={nodeHeight} rx="10" />
        <text className="mermaid-node-label" x={point.x}
          y={point.y - (labelLines.length - 1) * 8 + 4} textAnchor="middle">
          {labelLines.map((line, index) => <tspan key={index} x={point.x}
            dy={index ? 17 : 0}>{line}</tspan>)}
        </text>
      </g>;
    })}
  </svg>;
}

export function MermaidFlow({ source }: { source: string }) {
  const model = parseMermaidFlow(source);
  return <figure className="mermaid-figure">
    {model ? <Diagram model={model} /> : <div className="plantuml-unsupported">
      <strong>这段 Mermaid 暂时无法安全绘制</strong>
      <span>已保留源码，避免把依赖关系画错。</span>
    </div>}
    <figcaption>{model ? "开发依赖图 · 内置渲染" : "Mermaid 源码"}</figcaption>
    <details className="plantuml-source">
      <summary>查看 Mermaid 源码</summary>
      <pre><code>{source}</code></pre>
    </details>
  </figure>;
}

