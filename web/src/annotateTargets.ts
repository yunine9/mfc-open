/**
 * 批注的"点哪儿算哪一行":纯逻辑,不碰 React,好单测。
 *
 * 单独抽出来是因为它踩过的坑全是**静静地什么也不发生**:点了没反应、
 * 悬停不出图标——用户只会说"批注功能点不了",而代码里三处 `return` 都
 * 不吭声。列一下真实的哑火来源:
 * - 点在容器上而不是行上:Markdown 的列表是 `<ul>` 包 `<li>`,行号挂在
 *   li 上,点到 ul 的内边距/缩进区就什么也不是;段落之间的空隙同理;
 * - 空行/图块的原文快照是空的(anchorOf 返回 ""),于是拒绝开框;
 * - 页面上任意位置残留一段选区就整体禁用(判据是全文档的 selection,
 *   而不是"你刚在这块材料里划了词")。
 *
 * 这里的口径:**尽量把点击落到最近的一行上**,实在落不到就由调用方
 * 说人话(而不是装作没点)。判定与理由都可测,UI 只管照着做。
 */

/** 只依赖这几个 DOM 能力,便于测试里用假节点裁。 */
export interface RowNode {
  dataset: Record<string, string | undefined>;
  textContent: string | null;
  closest(selector: string): RowNode | null;
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): ArrayLike<RowNode>;
  getBoundingClientRect?: () => { top: number; bottom: number };
}

/** 原文快照的长度上限,和内核面板一致:够定位,又不至于把整段搬走。 */
export const ANCHOR_MAX = 90;

/** 没找到、匹配多处或尚未取得检查结果，都不能拿历史行号冒充当前位置。 */
export function resolvedAnnotationRange(
  item: { line: number; line_end?: number },
  check?: { state: string; line?: number; line_end?: number; location_verified?: boolean },
): { line: number; lineEnd: number } | undefined {
  if (!check || check.location_verified === false || !["hit", "moved"].includes(check.state)
      || !Number.isSafeInteger(check.line) || check.line! < 1) return undefined;
  const line = check.line!;
  return { line, lineEnd: check.line_end && check.line_end >= line
    ? check.line_end : line + Math.max(0, (item.line_end ?? item.line) - item.line) };
}

/** 按源文件范围找渲染块；代码/图表内部行归属于整个块。禁止猜最近一行。 */
export function annotationLocationRow<T extends Pick<RowNode, "dataset" | "closest">>(
  rows: readonly T[], line: number, file?: string,
): T | undefined {
  return rows.filter((row) => {
    const start = Number(row.dataset.l);
    const end = Number(row.dataset.lineEnd ?? row.dataset.l);
    return start <= line && line <= end
      && (file === undefined || row.closest("[data-file]")?.dataset.file === file);
  }).sort((a, b) => {
    const span = (row: T) => Number(row.dataset.lineEnd ?? row.dataset.l) - Number(row.dataset.l);
    return span(a) - span(b);
  })[0];
}

/** 模块名可改，稳定身份来自模块 ID；依赖由两端 ID 定位。 */
export function graphAnnotationLocationKey(anchor: string): string {
  return anchor.match(/^模块 (.+?)：/)?.[1]
    ? `module:${anchor.match(/^模块 (.+?)：/)![1]}` : anchor;
}

export interface MaterialAnnotation {
  id: string;
  artifact: string;
  file: string;
  line: number;
  status: string;
}

/** 当前材料行真正挂着哪些批注。不能只看行号：一个聚合 diff 里多个文件
 * 都可能有第 12 行。虚拟材料没有真实文件层级，按 artifact + line 即可。 */
export function annotationsAtRow<T extends MaterialAnnotation>(
  items: readonly T[],
  target: { artifact: string; file: string; line: number },
): T[] {
  return items.filter((item) => item.status !== "dropped"
    && item.artifact === target.artifact
    && item.line === target.line
    && (target.artifact.startsWith("__") || item.file === target.file));
}

/** 原文快照只取"内容"那一段(diff 行里夹着行号与 +/− 标记,整行抓下来
 * 是脏原文,回头重锚定一比一个不中)。空内容不再判死:空行也能圈,
 * 锚点退回"第 N 行"——人指的是位置,不一定是文字。 */
export function anchorOf(row: RowNode, line: number): string {
  const content = row.querySelector('[data-code-side="new"]') ?? row.querySelector("[data-code]") ?? row;
  const raw = content.textContent ?? "";
  const text = row.querySelector("[data-code]") ? raw.trim() : raw.replace(/\s+/g, " ").trim();
  if (!text) return `第 ${line} 行`;
  return text.length > ANCHOR_MAX ? text.slice(0, ANCHOR_MAX) : text;
}

function lineOf(row: RowNode): number {
  const line = Number(row.dataset.l);
  return Number.isFinite(line) && line > 0 ? line : 0;
}

/** 点击/悬停落点 → 该批注哪一行。
 *
 * 顺序:落点自身或祖先带行号 → 落点是容器(ul/div)时取容器里第一行
 * (点列表缩进区就算点第一条,比"什么也不发生"强)→ 都没有则 undefined。
 */
export function pickRow(
  target: RowNode | null | undefined,
  root: RowNode | null | undefined,
): RowNode | undefined {
  if (!target || !root) return undefined;
  // 交互元素(按钮/链接/输入框/编辑框自身)不抢:那儿有它自己的活。
  if (target.closest("button, a, textarea, input, .annot-editor")) {
    return undefined;
  }
  const own = target.closest("[data-l]");
  if (own && lineOf(own)) return own;
  // 落在容器上:退一步取容器内的第一行。Markdown 的 <ul>、diff 的
  // 表体都属于这种"看着是材料、其实不带行号"的壳。
  const inside = target.querySelectorAll?.("[data-l]");
  for (let index = 0; index < (inside?.length ?? 0); index += 1) {
    const candidate = inside![index];
    if (lineOf(candidate)) return candidate;
  }
  return undefined;
}

/** 落点被覆盖层挡住时,沿"该坐标下的整叠元素"往下找第一个能落到行的。
 *
 * 真实案发现场(MFC-034):专注审阅的分栏把手是一条 left:50%、全高、
 * z-index:4 的竖条,恰好压在每一行的几何中心;自动化点击默认打元素
 * 中心点,于是 event.target 永远是把手,`closest("[data-l]")` 找不到行,
 * 行明明在 DOM 里却"点不了"。人手点在分栏线附近同样哑火。
 * 调用方把 `document.elementsFromPoint(x, y)` 的结果喂进来,这里只认
 * root 之内的候选——覆盖层自己不带行号,会被自然跳过。 */
export function pickRowFromStack(
  stack: ArrayLike<RowNode | null | undefined>,
  root: RowNode | null | undefined,
  contains: (node: RowNode) => boolean,
): RowNode | undefined {
  if (!root) return undefined;
  for (let index = 0; index < stack.length; index += 1) {
    const candidate = stack[index];
    if (!candidate || !contains(candidate)) continue;
    if (candidate.closest("button, a, textarea, input, .annot-editor")) {
      continue;
    }
    // 只认"候选自身或祖先带行号"。不复用 pickRow 的容器回退——叠层里
    // 永远躺着整块画布容器,回退会把点击错落到画布第一行,比不落更糟。
    const row = candidate.closest("[data-l]");
    if (row && lineOf(row)) return row;
  }
  return undefined;
}

/** 划选的原文上限:一块材料里最多带走这么多字,够 Agent 看清语境;再长
 * 就该分几条圈。与服务端 ANNOTATION_QUOTE_MAX 同值(两边各自截,不互信)。 */
export const QUOTE_MAX = 1500;

export interface SelectionQuote {
  /** 逐行去掉首尾空白、空行剔掉之后的原文;超长截断带省略号。 */
  quote: string;
  /** 靠前的那一行:锚点与编辑框都挂它。 */
  startRow: RowNode;
  line: number;
  lineEnd: number;
}

/**
 * 划选一块原文 → 圈的是"这一块"而不是"这一行"(用户拍板:按行圈不够用,
 * 记为记忆常常要带一整段语境)。
 *
 * 口径:选区非折叠、真有字、首尾两端都落在这块材料带行号的行里才算;
 * 别处(决策卡/侧栏/上一次搜索)残留的选区一律不算——原来那条"页面上任何
 * 地方有选区就整块禁用"的坑不能再踩。行号取两端行的最小/最大;锚点仍是
 * 起始行的原文快照(重锚定靠它),整块原文另存,不参与定位。
 */
export function quoteOfSelection(
  selection: {
    isCollapsed?: boolean;
    toString(): string;
    anchorNode?: unknown;
    focusNode?: unknown;
  } | null | undefined,
  rowOf: (node: unknown) => RowNode | null | undefined,
): SelectionQuote | undefined {
  if (!selection || selection.isCollapsed) return undefined;
  const raw = selection.toString();
  if (!raw.trim()) return undefined;
  const from = rowOf(selection.anchorNode);
  const to = rowOf(selection.focusNode);
  if (!from || !to) return undefined;
  const a = lineOf(from);
  const b = lineOf(to);
  if (!a || !b) return undefined;
  let quote = raw.split("\n").map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean).join("\n");
  if (from.querySelector("[data-code]")) quote = raw.trim();
  if (quote.length > QUOTE_MAX) quote = quote.slice(0, QUOTE_MAX) + "…";
  return {
    quote,
    startRow: a <= b ? from : to,
    line: Math.min(a, b),
    lineEnd: Math.max(a, b),
  };
}


/** 只采集当前材料里同文件的邻近原文；不把行号、diff 标记或编辑框带入。 */
export function contextOfRow(root: RowNode, row: RowNode, lineEnd?: number): { context_before?: string; context_after?: string } {
  const file = row.closest("[data-file]")?.dataset.file;
  const line = Number(row.dataset.l);
  const end = lineEnd ?? Number(row.dataset.lineEnd ?? line);
  const text = (node: RowNode) => (node.querySelector('[data-code-side="new"]') ?? node.querySelector("[data-code]") ?? node).textContent?.trim() ?? "";
  const rows = Array.from(root.querySelectorAll("[data-l]")).filter(node =>
    !node.closest(".annot-editor") && !node.querySelector("[data-l]")
    && node.closest("[data-file]")?.dataset.file === file);
  const before = rows.filter(node => Number(node.dataset.lineEnd ?? node.dataset.l) < line).slice(-2).map(text).join("\n").slice(-1200);
  const after = rows.filter(node => Number(node.dataset.l) > end).slice(0, 2).map(text).join("\n").slice(0, 1200);
  return { ...(before ? { context_before: before } : {}), ...(after ? { context_after: after } : {}) };
}
