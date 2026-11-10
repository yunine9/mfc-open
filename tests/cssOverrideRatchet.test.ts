/**
 * CSS 叠层棘轮(纯文本扫描,不起 Vite)。
 *
 * 为什么要有:十天里 27 笔 fix 是"样式被别的文件压住了"——修法几乎都是再
 * 写一条更长的选择器或者加 !important,于是 16.8k 行 CSS 里覆盖式选择器
 * 只增不减,下一次改样式又踩到上一次的补丁。三个数钉住:只许降,不许升。
 * 要升必须来改这里的上限,并在 commit 里说清为什么这次非加不可。
 * 2026-09-06 起叠层有了正式出口(见文末用例):覆盖写进 @layer fixes,
 * 无条件赢——再往上限里加数就没有借口了。
 *
 * 数字是 2026-09-06 main@338d662 的实测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../web/src/", import.meta.url).pathname;
// #233 收官:web/src 手写样式只进 tailwind.css(19 个 legacy 文件退役)。
// 2026-10 起在册三份:知识库问答页(#476)与任务演示页(TaskDemo,
// 随演示模式落地)各有一个组件样式,均按层纪律包 legacy 后入册;
// 再新增文件先来这里登记并包层。
const files = readdirSync(dir).filter((name) => name.endsWith(".css"));
assert.deepEqual(files, ["KnowledgeAnswers.css", "TaskDemo.css", "tailwind.css"],
  "web/src 手写样式文件只限在册三份,新文件先改这里登记");
const css = Object.fromEntries(files.map((name) => [name, readFileSync(join(dir, name), "utf-8")]));

// 2026-09-06 晚拧到当前实测值(删死 CSS 后):要升必须来改这里并说清为什么。
const CEILING = {
  important: 55,
  studioOverride: 285,
  duplicateTopLevelClass: 23,
  // 组件统一化(2026-09-08)的三根新钉: primitives(ui.css + <Modal>)
  // 落地后,存量页面逐页迁移时这三个数只许降——
  // accentRecipe:css 里 --accent-fg 的引用数(主色按钮配方按容器复制
  //   的代理指标,配方归一到 shadcn Button 后应持续下降);
  // zIndexLiteral:z-index 字面量的去重个数(手搓弹层各养各的层级,
  //   新弹层一律取 tokens 的层叠阶梯,var() 引用不算字面量);
  // fixedOverlay:position: fixed 的规则数(手搓 backdrop/overlay 的
  //   代理指标,迁 <Modal> 后应减少)。
  // 数字是 2026-09-08 main@0c10f9a 工作区的实测。
  accentRecipe: 37,
  zIndexLiteral: 25,
  fixedOverlay: 18,
};

test("CSS 棘轮:!important 只许减少", () => {
  const count = Object.values(css).reduce((sum, text) => sum + (text.match(/!important/g) ?? []).length, 0);
  assert.ok(count <= CEILING.important,
    `!important 从 ${CEILING.important} 涨到 ${count};先看能不能靠调整叠层顺序解决`);
});

test("CSS 棘轮:.workspace-studio.task-workspace-v2 压制选择器只许减少", () => {
  const count = Object.values(css).reduce((sum, text) =>
    sum + (text.match(/\.workspace-studio\.task-workspace-v2/g) ?? []).length, 0);
  assert.ok(count <= CEILING.studioOverride,
    `(0,4,0) 压制选择器从 ${CEILING.studioOverride} 涨到 ${count};这是叠层顺序问题的症状,不是修法`);
});

test("CSS 棘轮:同名顶层类规则跨文件重复只许减少", () => {
  const seen = new Map<string, Set<string>>();
  for (const [name, text] of Object.entries(css)) {
    for (const match of text.matchAll(/^\.([a-zA-Z0-9_-]+)\s*\{/gm)) {
      const set = seen.get(match[1]) ?? new Set<string>();
      set.add(name);
      seen.set(match[1], set);
    }
  }
  const duplicated = [...seen.entries()].filter(([, owners]) => owners.size > 1);
  assert.ok(duplicated.length <= CEILING.duplicateTopLevelClass,
    `跨文件重复定义的顶层类从 ${CEILING.duplicateTopLevelClass} 涨到 ${duplicated.length}:`
    + duplicated.slice(0, 8).map(([cls, owners]) => `.${cls}(${[...owners].join(",")})`).join(" "));
});

test("CSS 棘轮:accent 按钮配方引用只许减少(归一到 shadcn Button)", () => {
  const count = Object.values(css).reduce((sum, text) =>
    sum + (text.match(/--accent-fg/g) ?? []).length, 0);
  assert.ok(count <= CEILING.accentRecipe,
    `--accent-fg 引用从 ${CEILING.accentRecipe} 涨到 ${count};`
    + "新按钮一律 shadcn Button(components/ui/button),别再按容器复制主色配方");
});

test("CSS 棘轮:z-index 字面量去重个数只许减少(新弹层取 tokens 层叠阶梯)", () => {
  const values = new Set<string>();
  for (const text of Object.values(css)) {
    for (const match of text.matchAll(/z-index:\s*([^;}\n]+)/g)) {
      const value = match[1].trim();
      if (!value.startsWith("var(")) values.add(value);
    }
  }
  assert.ok(values.size <= CEILING.zIndexLiteral,
    `z-index 字面量去重从 ${CEILING.zIndexLiteral} 涨到 ${values.size}:`
    + `新弹层的层级一律用 var(--z-*)(${[...values].slice(0, 8).join(",")}…)`);
});

test("CSS 棘轮:fixed 弹层规则只许减少(手搓 backdrop 迁 <Modal>)", () => {
  const count = Object.values(css).reduce((sum, text) =>
    sum + (text.match(/position: fixed/g) ?? []).length, 0);
  assert.ok(count <= CEILING.fixedOverlay,
    `position: fixed 规则从 ${CEILING.fixedOverlay} 涨到 ${count};`
    + "新的表单/面板弹层用 <Modal>,别再手搓 backdrop");
});

test("公共 Portal 根层级使用平台 tokens，不能被工作台或全屏文档遮挡", () => {
  // CSS 扫描看不到 TSX 的 Tailwind 类；只检查全局根，保留 Popup 内部的局部层级。
  for (const name of ["popover", "select", "dropdown-menu", "tooltip"]) {
    const source = readFileSync(join(dir, `components/ui/${name}.tsx`), "utf8");
    const roots = [...source.matchAll(/<\w+\.Positioner\b[\s\S]*?className="([^"]*)"/g)];
    assert.ok(roots.length, `${name} 必须检查到 Positioner`);
    for (const [, classes] of roots) assert.match(classes, /z-\(--z-topmost\)/, `${name} 必须高于模态框`);
  }
  for (const [name, token] of [["dialog", "modal"], ["sheet", "modal"], ["alert-dialog", "topmost"]]) {
    const source = readFileSync(join(dir, `components/ui/${name}.tsx`), "utf8");
    for (const part of ["Backdrop", "Popup"]) {
      const root = source.match(new RegExp(`<\\w+\\.${part}\\b[\\s\\S]*?className=\\{cn\\(\\s*"([^"]*)"`));
      assert.ok(root, `${name}.${part} 必须检查到根层级`);
      assert.ok(root[1].includes(`z-(--z-${token})`), `${name}.${part} 必须使用平台层级`);
    }
  }
});

test("CSS 叠层:固定五层顺序，存量保持 legacy，Preflight 兼容只在 base", () => {
  // 2026-09-06 决定:按文件分层被五档宽度截图裁判(scripts/visual-scenes.ts)
  // 否掉——480 张里 209 张变了,后面文件里被长选择器压住的规则一夜全赢,那是
  // 没人审过的改版。现有样式整体进 legacy 一层(与不分层逐像素一致);以后
  // 的覆盖写进 `@layer fixes { … }`,无条件赢,不用再堆长选择器或 !important。
  // 引入全局 Preflight 后，base 必须低于存量，工具类仍须高于 fixes。
  // 固定声明的位置和完整顺序，不能靠加载先后偶然注册出正确层级。
  const declarations = Object.entries(css).flatMap(([name, text]) =>
    (text.replace(/\/\*[\s\S]*?\*\//g, "").match(/^@layer [^{;]+;$/gm) ?? [])
      .map(declaration => ({ name, declaration })));
  assert.deepEqual(declarations, [{ name: "tailwind.css",
    declaration: "@layer base, legacy, fixes, theme, utilities;" }],
    "tailwind.css 必须唯一声明 base < legacy < fixes < theme < utilities");
  for (const [name, text] of Object.entries(css)) {
    const body = text.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^@layer [^{;]+;$/m, "").trim();
    // 2026-09-09 豁免(issue #148):tailwind.css 是 Tailwind v4 新世界入口,
    // 层序经 @import layer() 注记在构建期落位(legacy < fixes < theme < utilities,
    // dist 已验),结构上不属于 legacy 存量,不包 legacy 层;未登记层的禁令对它照常生效。
    const containerLayer = "legacy";
    if (name !== "tailwind.css") {
      assert.ok(body.startsWith(`@layer ${containerLayer} {`),
        `${name} 的样式必须整体包在 @layer ${containerLayer} { … } 里`);
      assert.ok(body.endsWith("}"), `${name} 的 ${containerLayer} 层没有闭合`);
    }
    const layers = [...body.matchAll(/@layer\s+([a-zA-Z-]+)\s*\{/g)].map((match) => match[1]);
    // tailwind.css 是唯一入口:base(preflight+归一)/legacy(存量皮)/fixes 都是登记层
    const allowed = name === "tailwind.css" ? ["base", "legacy", "fixes"] : ["legacy", "fixes"];
    assert.deepEqual([...new Set(layers)].filter((layer) => !allowed.includes(layer)), [],
      `${name} 用了未登记的层;要新开层先过一遍截图裁判再来改这里`);
  }
});

test("Preflight 导入 base 且兼容补丁随后加载，主题和工具类使用各自层", () => {
  const imports = [...css["tailwind.css"].matchAll(/@import\s+"tailwindcss\/([^"\n]+)"\s+layer\(([^)]+)\);/g)]
    .map(match => [match[1], match[2]]);
  assert.deepEqual(imports, [["preflight.css", "base"], ["theme.css", "theme"], ["utilities.css", "utilities"]]);
  const main = readFileSync(join(dir, "main.tsx"), "utf8");
  assert.ok(main.indexOf('import "./tailwind.css";') >= 0,
    "main.tsx 必须加载 tailwind.css(唯一样式入口)");
  assert.doesNotMatch(main, /import "\.\/(?!tailwind\.css")[a-z-]+\.css";/,
    "main.tsx 不得再加载任何 legacy CSS 文件(只剩 tailwind.css)");
});
