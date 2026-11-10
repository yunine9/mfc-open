/**
 * tailwind.css 结构完整性棘轮(2026-09-13 视觉修复事故后立):
 * #233 归并时丢过一个收括号,@media (prefers-reduced-motion) 把
 * 3,270 行存量皮(task-workspace-v2/conversation/task-overview 等)
 * 吞进「仅在减弱动效时生效」的分支——构建零报错、普通用户整站裸奔,
 * 靠真机截图审计才炸出来。本测试钉两条不变量:
 * 1. 全文件花括号配平,且扫描深度永不为负;
 * 2. 一组「已知活」选择器必须至少出现一次在**非 @media 作用域**——
 *    @layer legacy 包裹是合法的(utilities 恒压 legacy 是分层本意),
 *    被 @media 独占才是事故形态。选择器随重构演进同票维护(锚点纪律)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "web", "src", "tailwind.css");
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const SMOKE_SELECTORS = [
  ".ws-head", // 工作台头部布局(SessionView/工作台在用)
  ".ws-progress", // 相位轨
  ".task-overview", // 团队任务队列行
  ".module-location-retry", // 架构图引用卡重试钮(#233 事故点位)
  ".md-architecture-reference", // Markdown 架构引用卡
];

/** shadcn 变量桥冒烟:@theme 的 --color-* 映射指向这些 :root 定义,
 * 丢一个对应一组工具类整体失效(#233 第二处事故:全站主按钮透明裸字)。 */
const SMOKE_VARIABLES = [
  "--primary:", "--primary-foreground:", "--background:", "--foreground:",
  "--card:", "--popover:", "--secondary:", "--destructive:",
  "--input:", "--ring:",
];

type BlockKind = "media" | "layer" | "other-at" | "plain";

/** 扫描全文件:每个字符下标 → 是否处于任一 @media 块内 + 括号深度。 */
function scan(): { inMedia: boolean[]; depths: number[] } {
  const inMedia: boolean[] = new Array(css.length).fill(false);
  const depths: number[] = new Array(css.length).fill(0);
  const stack: BlockKind[] = [];
  let prelude = ""; // 自上一个 { 或 } 以来的文本,{ 前按它分块
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      const trimmed = prelude.trim();
      const kind: BlockKind = trimmed.startsWith("@media") ? "media"
        : trimmed.startsWith("@layer") ? "layer"
        : trimmed.startsWith("@") ? "other-at"
        : "plain";
      stack.push(kind);
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else {
      prelude += ch;
    }
    inMedia[i] = stack.includes("media");
    depths[i] = stack.length;
  }
  return { inMedia, depths };
}

test("tailwind.css:花括号全文件配平且深度不为负", () => {
  let depth = 0;
  let line = 1;
  for (const ch of css) {
    if (ch === "\n") line += 1;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      assert.ok(depth >= 0,
        `tailwind.css:${line} 出现多余的 }\n(历史事故:#233 归并丢括号,3,270 行皮肤被吞进媒体查询)`);
    }
  }
  assert.equal(depth, 0, `tailwind.css 花括号不配平,缺 ${depth} 个 }(扫到文件尾)`);
});

test("tailwind.css:已知活选择器必须至少一次活在非 @media 作用域", () => {
  const { inMedia } = scan();
  for (const selector of SMOKE_SELECTORS) {
    const positions: number[] = [];
    let from = 0;
    for (;;) {
      const index = css.indexOf(selector, from);
      if (index < 0) break;
      positions.push(index);
      from = index + 1;
    }
    assert.ok(positions.length > 0,
      `活选择器 ${selector} 不在 tailwind.css 里了——若为有意删除,同票更新本测试的 SMOKE_SELECTORS`);
    assert.ok(
      positions.some((index) => !inMedia[index]),
      `${selector} 只出现在 @media 作用域里(基础皮被媒体查询吞掉?)——历史事故形态,见本文件头注释`,
    );
  }
});

test("tailwind.css:shadcn 变量桥冒烟——@theme 依赖的 :root 定义一个不能少", () => {
  for (const variable of SMOKE_VARIABLES) {
    assert.ok(css.includes(variable),
      `变量桥缺 ${variable}——@theme 的 --color-* 映射会悬空,对应工具类整组失效\n(历史事故:#233 归并丢 15 个 :root 定义,全站主按钮透明裸字)`);
  }
});

/** #257 收口终态锚(各实现票划转清单):
 *  - RETIRED:六票期间确认退役的孤儿皮/死规则,再引入即红;
 *  - BASE:preflight 配套基座——#233 归并时规则体被整块吞掉只剩注释,
 *    #257 按 c72ee7e(base)/74e352a(fixes)原文成对恢复,再丢即红。 */
const RETIRED_FRAGMENTS = [
  "issue-rail-primary", // #256 转正确认钮收编 ui/Button 后的孤儿皮
  "annot-route-picker", // 批注去向选择器,markup 已死(#251 P2)
  "knowledge-spin", // 孤儿 @keyframes,无消费者(#251 P2)
  "workspaceReveal", // 孤儿 @keyframes,无消费者(#251 P2)
  "--help-ink", // 变量定义已失,消费行是死规则(#251 P2)
];

const BASE_LAYER_ANCHORS = [
  "display: inline-block", // svg/img 行内补丁(preflight 拍块会折行行内图标)
  "list-style: disc", // 无类/渲染器列表标记(.md-list 裸奔即红)
  "list-style: decimal", // 有序列表序号
  ".sidebar-reset", // 侧栏 scoped 归一(fixes 层;与 ul disc 成对在位)
];

test("tailwind.css:#257 终态——退役孤儿绝迹,preflight 基座在位", () => {
  for (const fragment of RETIRED_FRAGMENTS) {
    assert.ok(!css.includes(fragment),
      `退役孤儿 ${fragment} 又出现在 tailwind.css 里——若是误回归请删除;若确要复用,先开票撤销 #257 的退役裁决再动本锚`);
  }
  for (const anchor of BASE_LAYER_ANCHORS) {
    assert.ok(css.includes(anchor),
      `preflight 基座锚 ${anchor} 不在 tailwind.css 里了——base/fixes 规则体是 #233 归并事故的丢失物、#257 成对恢复,再丢即同形态回归`);
  }
});

/** 终态行数棘轮:#257 收口后的真实行数钉死为天花板,后续只许更少。
 *  >2,500 的目标经证据化 recalibration 判定不可达(余量属于 Out-of-scope
 *  的生成 DOM 皮肤与领域件皮,逐段普查见 #257 收口账),本棘轮防回涨。
 *  7615 → 7843:5625cc98 新增 .help-tip 组件类(帮助图标即时悬停提示)
 *  的正当余量,按本棘轮留痕条款上调。
 *  7843 → 8422:9 月底知识工作室皮(3db3fe9b、ad232cd5 并入共享样式)提交时
 *  已到 8197 行却没同步上调;2026-10 知识库新前台的五个独立样式文件按
 *  "只留 tailwind.css"约定并回(+225 行)。两笔都是知识库页面的正当余量。 */
const TAILWIND_FINAL_LINES = 8422;
const cssRaw = readFileSync(cssPath, "utf8");

test("tailwind.css:终态行数棘轮——只许更少不许回涨", () => {
  const lines = cssRaw.split("\n").length;
  assert.ok(lines <= TAILWIND_FINAL_LINES,
    `tailwind.css ${lines} 行,超过 #257 终态天花板 ${TAILWIND_FINAL_LINES} 行——新增皮肤请优先收编进 shadcn/工具类;确需余量请同票上调本锚并留痕`);
});
