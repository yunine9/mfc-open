/**
 * 批注落点规则(前端纯逻辑,用假 DOM 裁)。
 *
 * 用户实测:"批注功能点不了"。查下来不是权限也不是接口,是三处**一声
 * 不吭的 return**:点在容器上(Markdown 的 `<ul>` 包着带行号的 `<li>`,
 * 点缩进区就落空)、空行的原文快照为空、以及"页面上任何地方有选区就
 * 整块禁用"。三条都不报错、不提示,于是功能看起来就是坏的。
 *
 * 这里钉住修好后的口径:够得着就落到最近一行,够不着由调用方说人话;
 * 划词只认这块材料里的划词。DOM 用假的——规则是纯的,不值得为它拉一个
 * 浏览器进来(真手感由内网实走回报)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationLocationRow, graphAnnotationLocationKey, anchorOf, annotationsAtRow, pickRow, pickRowFromStack, quoteOfSelection, resolvedAnnotationRange,
  QUOTE_MAX, type RowNode,
} from "../web/src/annotateTargets.ts";

test("批注跳转与标记只用可靠的当前位置，起止行一起平移", () => {
  const note = { line: 3, line_end: 7 };
  assert.deepEqual(resolvedAnnotationRange(note, { state: "moved", line: 13 }),
    { line: 13, lineEnd: 17 });
  assert.deepEqual(resolvedAnnotationRange(note, { state: "moved", line: 13, line_end: 19 }),
    { line: 13, lineEnd: 19 }, "服务端按完整选区定位的末行优先于旧范围长度");
  assert.deepEqual(resolvedAnnotationRange(note, { state: "hit", line: 3 }),
    { line: 3, lineEnd: 7 });
  for (const check of [undefined, { state: "gone" }, { state: "ambiguous", line: 20 },
    { state: "moved", line: 0 }, { state: "hit" }]) {
    assert.equal(resolvedAnnotationRange(note, check), undefined,
      "原文不在或不唯一时不能降级到旧的第 3 行");
  }
});

/** 极简假节点:只实现规则用到的那几个 DOM 能力。 */
function node(spec: {
  tag?: string;
  cls?: string;
  line?: number;
  file?: string;
  text?: string;
  code?: string;
  children?: FakeNode[];
}): FakeNode {
  return new FakeNode(spec);
}

class FakeNode implements RowNode {
  dataset: Record<string, string | undefined> = {};
  children: FakeNode[];
  parent?: FakeNode;
  tag: string;
  cls: string;
  private text: string;
  private code?: string;

  constructor(spec: {
    tag?: string; cls?: string; line?: number; file?: string;
    text?: string; code?: string; children?: FakeNode[];
  }) {
    this.tag = spec.tag ?? "div";
    this.cls = spec.cls ?? "";
    this.text = spec.text ?? "";
    this.code = spec.code;
    if (spec.line !== undefined) this.dataset.l = String(spec.line);
    if (spec.file !== undefined) this.dataset.file = spec.file;
    this.children = spec.children ?? [];
    for (const child of this.children) child.parent = this;
  }

  get textContent(): string {
    return this.code ?? [this.text, ...this.children.map((c) => c.textContent)]
      .join("");
  }

  private matches(selector: string): boolean {
    return selector.split(",").map((one) => one.trim()).some((one) => {
      if (one === "[data-l]") return this.dataset.l !== undefined;
      if (one === "[data-file]") return this.dataset.file !== undefined;
      if (one === "[data-code]") return this.code !== undefined;
      if (one.startsWith(".")) return this.cls === one.slice(1);
      return this.tag === one;
    });
  }

  closest(selector: string): FakeNode | null {
    let cursor: FakeNode | undefined = this;
    while (cursor) {
      if (cursor.matches(selector)) return cursor;
      cursor = cursor.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

test("点在行上/行内文字上:都落到那一行", () => {
  const span = node({ tag: "span", text: "push 已发送" });
  const row = node({ tag: "p", cls: "md-p", line: 42, children: [span] });
  const root = node({ cls: "annotatable", children: [row] });
  assert.equal(pickRow(row, root), row);
  assert.equal(pickRow(span, root), row, "点行内的文字也算点这一行");
});

test("点在容器空隙上:退一步取容器里的第一行,不再什么都不发生", () => {
  // Markdown 的列表:行号在 li 上,ul 只是壳。点缩进区/项与项之间的
  // 空隙落到的就是 ul——这正是"点了没反应"的日常来源。
  const first = node({ tag: "li", line: 7, text: "第一条" });
  const list = node({
    tag: "ul", cls: "md-list",
    children: [first, node({ tag: "li", line: 8, text: "第二条" })],
  });
  const root = node({ cls: "annotatable", children: [list] });
  assert.equal(pickRow(list, root), first);
});

test("点在按钮/链接上不抢:那儿有它自己的活", () => {
  const button = node({ tag: "button", text: "展开 12 行未改动内容" });
  const row = node({ tag: "div", line: 3, children: [button] });
  const root = node({ cls: "annotatable", children: [row] });
  assert.equal(pickRow(button, root), undefined);
});

test("够不着任何一行时如实返回 undefined(由 UI 说人话,不是装作没点)", () => {
  const bare = node({ tag: "div", cls: "utility-note", text: "读取中" });
  const root = node({ cls: "annotatable", children: [bare] });
  assert.equal(pickRow(bare, root), undefined);
});

test("锚点:diff 行只取内容,空行退回「第 N 行」而不是放弃", () => {
  const dirty = node({
    tag: "div", line: 28,
    children: [
      node({ tag: "span", text: "28+" }),                 // 行号与 +/− 标记
      node({ tag: "span", code: '  say("push 已发送")' }), // data-code=内容
    ],
  });
  assert.equal(anchorOf(dirty, 28), 'say("push 已发送")',
    "脏原文进模型是噪声,回头重锚定还会整片误报");
  const blank = node({ tag: "p", line: 9, text: "   " });
  assert.equal(anchorOf(blank, 9), "第 9 行", "空行也得能圈,人指的是位置");
  const long = node({ tag: "p", line: 1, text: "长".repeat(200) });
  assert.equal(anchorOf(long, 1).length, 90);
});

test("材料行找批注同时核对产物、文件和当前行，删除项不再留假标记", () => {
  const items = [
    { id: "a", artifact: "diff", file: "src/a.ts", line: 12, status: "sent" },
    { id: "b", artifact: "diff", file: "src/b.ts", line: 12, status: "sent" },
    { id: "c", artifact: "other", file: "src/a.ts", line: 12, status: "sent" },
    { id: "d", artifact: "diff", file: "src/a.ts", line: 12, status: "dropped" },
  ];
  assert.deepEqual(annotationsAtRow(items, {
    artifact: "diff", file: "src/a.ts", line: 12,
  }).map((item) => item.id), ["a"]);
});

test("需求原文是虚拟材料，旧批注文件名不同也能按同一行定位", () => {
  const items = [
    { id: "old", artifact: "__task_requirement__",
      file: "__task_requirement__", line: 3, status: "verified" },
  ];
  assert.deepEqual(annotationsAtRow(items, {
    artifact: "__task_requirement__", file: "需求原文", line: 3,
  }).map((item) => item.id), ["old"]);
});

test("划选一块:两端都落在这块材料的行里才算,行号取两端、原文逐行收拾", () => {
  const first = node({ tag: "p", line: 3, text: "背景:先看渠道开关" });
  const last = node({ tag: "li", line: 5, text: "  不改 registry.xml  " });
  const outside = node({ tag: "p", text: "决策卡里的字" });
  const rowOf = (target: unknown) =>
    target === first || target === last ? target as RowNode : null;
  const picked = quoteOfSelection({
    isCollapsed: false, anchorNode: last, focusNode: first,
    toString: () => "  不改 registry.xml  \n\n背景:先看  渠道开关",
  }, rowOf);
  assert.ok(picked);
  assert.equal(picked.line, 3);
  assert.equal(picked.lineEnd, 5);
  assert.equal(picked.startRow, first, "反向拖选也以靠前的行为锚");
  assert.equal(picked.quote, "不改 registry.xml\n背景:先看 渠道开关",
    "逐行去首尾空白、空行剔掉、行内空白收成一个");
  assert.equal(quoteOfSelection({
    isCollapsed: false, anchorNode: outside, focusNode: first, toString: () => "x",
  }, rowOf), undefined, "一端在别处(决策卡/侧栏/上次搜索)的选区不算");
  assert.equal(quoteOfSelection({
    isCollapsed: true, anchorNode: first, focusNode: first, toString: () => "",
  }, rowOf), undefined, "点一下的折叠光标不算");
  const long = quoteOfSelection({
    isCollapsed: false, anchorNode: first, focusNode: last,
    toString: () => "长".repeat(2000),
  }, rowOf);
  assert.equal(long?.quote.length, QUOTE_MAX + 1, "超长截断带省略号");
});

// MFC-034 案发现场:专注审阅的分栏把手(全高、left:50%、z-index:4)恰好
// 压在每一行的几何中心。自动化点击打元素中心 → event.target 永远是把手,
// 行明明在 DOM 里却"这一处没有行号可锚定"。兜底口径:拿该坐标下的整叠
// 元素(elementsFromPoint 序:上层在前)穿透找第一个能落到行的。
test("落点被覆盖层挡住:沿坐标下的整叠元素穿透找到底下那一行", () => {
  const cell = node({ tag: "div", cls: "diff-cell", text: "return value;" });
  const row = node({ tag: "div", cls: "diff-review-row", line: 28,
    children: [cell] });
  const body = node({ cls: "diff-review-body", children: [row] });
  const resizer = node({ cls: "diff-column-resizer" });
  const canvas = node({ cls: "diff-review-canvas",
    children: [body, resizer] });
  const root = node({ cls: "annotatable", children: [canvas] });
  const inRoot = (candidate: RowNode) => {
    let cursor: RowNode | null = candidate;
    while (cursor) {
      if (cursor === (root as unknown as RowNode)) return true;
      cursor = (cursor as { parent?: RowNode }).parent ?? null;
    }
    return false;
  };
  // 直接命中把手:pickRow 找不到行(这正是线上症状)。
  assert.equal(pickRow(resizer, root), undefined);
  // 穿透:叠层顺序 把手 → 行内格 → 行 → 画布,兜底落到 28 行。
  assert.equal(
    pickRowFromStack([resizer, cell, row, canvas], root, inRoot), row);
  // 整叠都够不着行(点在头部/空隙):仍如实 undefined,由 UI 说人话。
  const head = node({ cls: "diff-review-head" });
  assert.equal(pickRowFromStack([resizer, head, canvas], root, inRoot),
    undefined);
  // root 之外的同类节点不认:别把别的材料区的行错圈进来。
  const foreignRow = node({ tag: "div", line: 5 });
  node({ cls: "other", children: [foreignRow] });
  assert.equal(pickRowFromStack([foreignRow], root, inRoot), undefined);
});


test("文件定位选最小的真实渲染范围，不把缺失行猜成邻近行", () => {
  const table = node({ line: 4, file: "a" }); table.dataset.lineEnd = "8";
  const row = node({ line: 6, file: "a" });
  const code = node({ line: 20, file: "a" }); code.dataset.lineEnd = "28";
  const other = node({ line: 24, file: "b" });
  assert.equal(annotationLocationRow([table, row], 6), row);
  assert.equal(annotationLocationRow([code, other], 24, "a"), code);
  assert.equal(annotationLocationRow([code], 29), undefined);
  assert.equal(annotationLocationRow([code], 24, "missing"), undefined);
  assert.equal(resolvedAnnotationRange({ line: 3 },
    { state: "hit", line: 3, location_verified: false }), undefined);
});

test("模块改名后仍用模块 ID 找节点，依赖用两端 ID", () => {
  assert.equal(graphAnnotationLocationKey("模块 repo-1：旧名字"), "module:repo-1");
  assert.equal(graphAnnotationLocationKey("模块 repo-1：新名字"), "module:repo-1");
  assert.equal(graphAnnotationLocationKey("依赖 a -> b"), "依赖 a -> b");
});

test("双栏代码差异的锚点取新代码，不误取左侧被替换的旧代码", () => {
  const row = node({ line: 10, text: "old new" });
  row.querySelector = (selector: string) => node({ text:
    selector === '[data-code-side="new"]' ? "new();" : "old();" });
  assert.equal(anchorOf(row, 10), "new();");
});

test("批注上下文只采集同一文件相邻内容，不带 diff 标记", async () => {
  const { contextOfRow } = await import("../web/src/annotateTargets.ts");
  const before = node({ line: 1, code: "if (a > b) {" });
  const current = node({ line: 2, children: [node({ code: "  return  a;" })] });
  const after = node({ line: 3, code: "}" });
  const one = node({ file: "one.ts", children: [before, current, after] });
  const other = node({ file: "other.ts", children: [node({ line: 1, code: "foreign" })] });
  const root = node({ children: [one, other] });
  const context = contextOfRow(root, current);
  assert.equal(context.context_before, "if (a > b) {");
  assert.equal(context.context_after, "}");
  assert.equal(anchorOf(current, 2), "return  a;");
});
