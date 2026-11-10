/**
 * DTS 单据 HTML 白名单消毒的契约(dtsHtml.ts)。
 *
 * 测试环境没有 DOM,而 DOMPurify 的剥离行为只在真 DOM 里发生(node 下
 * 连 sanitize 都不装配,vendor 文件提前 return)。所以这里的分工是:
 * - 策略数据(白名单标签表/属性表/URI 正则/配置装配)与字符串变换
 *   (图片代理重写、rel 注入)在 node 直测——换掉消毒器实现,这些
 *   契约仍应全绿;
 * - 真正的「剥 script/事件属性/javascript:」是 DOM 行为,只能真浏览器
 *   验证,本仓测试零外部依赖、不引 jsdom(CLAUDE.md:前端零外部依赖,
 *   内网可用),该用例显式 skip 并注明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import DOMPurify from "../web/src/issues/vendor/dompurify.es.mjs";
import {
  DTS_ALLOWED_ATTRS,
  DTS_ALLOWED_TAGS,
  DTS_SANITIZE_CONFIG,
  DTS_ALLOWED_URI_REGEXP,
  enforceLinkRel,
  isAllowedDtsUri,
  prepareDtsHtml,
  resolveDtsImages,
  sanitizeDtsHtml,
} from "../web/src/issues/dtsHtml.ts";

const HAS_DOM = typeof (globalThis as { window?: unknown }).window !== "undefined"
  && typeof DOMPurify.sanitize === "function";

test("白名单标签表:文本/段落/标题/列表/链接/图片都在,且能承载 DTS 常见的表格与代码块", () => {
  for (const tag of [
    "p", "div", "span", "br", "h1", "h3", "h6",
    "ul", "ol", "li", "a", "img",
    "strong", "em", "code", "pre", "blockquote",
    "table", "tr", "th", "td",
  ]) {
    assert.ok(DTS_ALLOWED_TAGS.includes(tag), `${tag} 应在白名单`);
  }
});

test("白名单标签表:脚本与活动内容的载体绝不在表内(表外即剥除)", () => {
  for (const tag of [
    "script", "style", "iframe", "frame", "frameset", "object", "embed",
    "applet", "svg", "math", "form", "input", "button", "textarea",
    "select", "link", "meta", "base", "template", "noscript", "audio",
    "video", "body", "head", "html",
  ]) {
    assert.ok(!DTS_ALLOWED_TAGS.includes(tag), `${tag} 不应进白名单`);
  }
});

test("白名单属性表:只收放在任何标签上都无害的展示属性", () => {
  for (const attr of ["href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "class"]) {
    assert.ok(DTS_ALLOWED_ATTRS.includes(attr), `${attr} 应在白名单`);
  }
});

test("白名单属性表:事件属性/样式/绕过代理的口子一律不收", () => {
  // 事件属性不点名单点类:on* 全族一个都不许出现。
  assert.ok(DTS_ALLOWED_ATTRS.every((attr) => !attr.toLowerCase().startsWith("on")),
    "白名单属性里不允许出现任何 on* 事件属性");
  for (const attr of [
    "style", // CSS 注入面
    "srcset", // 绕开图片代理重写的第二地址口子
    "id", "name", // DOM clobbering 面
    "target", "rel", // 由 enforceLinkRel 统一注入,不信任输入
    "formaction", "action", "background", "ping", "dynsrc", "lowsrc",
  ]) {
    assert.ok(!DTS_ALLOWED_ATTRS.includes(attr), `${attr} 不应进白名单`);
  }
});

test("URI 白名单:http/https 与站内相对地址放行——内嵌图重写后的代理 URL 必须在白名单内", () => {
  for (const uri of [
    "https://dts.example.com/v1/nfs/a.png",
    "http://a.b/c?d=1&e=2",
    "/v1/nfs/a.png",
    "/issues/dts-file?path=%2Fv1%2Fnfs%2Fa%20b.png", // 重写产物:纯相对代理 URL
    "v1/relative.png",
    "./a.png",
    "#anchor",
    "//host/path", // 协议相对,落回 http/https
  ]) {
    assert.equal(isAllowedDtsUri(uri), true, `${uri} 应放行`);
  }
});

test("URI 白名单:javascript: 全族(大小写/制表符/空字节混淆)与 data:/vbscript:/mailto: 全拒", () => {
  for (const uri of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)", // 剥空白后还原成 javascript:(DOMPurify 契约)
    "java\u0000script:alert(1)",
    " vbscript:x",
    "data:text/html;base64,PHNjcmlwdD4=",
    "mailto:a@b.c", // 票面口径:链接仅 http/https
    "tel:+861234",
  ]) {
    assert.equal(isAllowedDtsUri(uri), false, `${JSON.stringify(uri)} 应拒绝`);
  }
  // 正则本体就是装配给 DOMPurify 的那张,别出现两套口径。
  assert.equal(DTS_SANITIZE_CONFIG.ALLOWED_URI_REGEXP, DTS_ALLOWED_URI_REGEXP);
});

test("DOMPurify 配置装配:表原样进配置,没有 ADD_* 后门,KEEP_CONTENT 剥壳留文本", () => {
  assert.deepEqual(DTS_SANITIZE_CONFIG.ALLOWED_TAGS, [...DTS_ALLOWED_TAGS]);
  assert.deepEqual(DTS_SANITIZE_CONFIG.ALLOWED_ATTR, [...DTS_ALLOWED_ATTRS]);
  assert.equal(DTS_SANITIZE_CONFIG.KEEP_CONTENT, true);
  assert.ok(!("ADD_TAGS" in DTS_SANITIZE_CONFIG), "不许 ADD_TAGS 放水");
  assert.ok(!("ADD_ATTR" in DTS_SANITIZE_CONFIG), "不许 ADD_ATTR 放水");
  assert.ok(!("ALLOW_UNKNOWN_PROTOCOLS" in DTS_SANITIZE_CONFIG));
});

test("图片代理重写:DTS 绝对地址与 /v1/ 相对地址都转平台代理,路径特殊字符编码一次", () => {
  const abs = resolveDtsImages(
    '<img src="https://dts.example.com/v1/nfs/问题单/a b.png">',
  );
  assert.match(abs, /^<img src="\/issues\/dts-file\?path=/);
  // 空格/中文原样拼会截断参数,必须整体编码(先例 commit 7238a06)。
  assert.ok(abs.includes(encodeURIComponent("/v1/nfs/问题单/a b.png")));
  const rel = resolveDtsImages('<img src="/v1/nfs/x.png">');
  assert.equal(rel, '<img src="/issues/dts-file?path=%2Fv1%2Fnfs%2Fx.png">');
  // 非 DTS 的相对地址不动,别把站内图片也拐去代理。
  assert.equal(resolveDtsImages('<img src="/static/x.png">'), '<img src="/static/x.png">');
  assert.equal(resolveDtsImages(undefined), "");
});

test("图片代理重写产物必须在 URI 白名单内:重写 → 提取 src → 直测放行", () => {
  const rewritten = resolveDtsImages(
    '<img src="https://dts.example.com/v1/nfs/a b&c.png">',
  );
  const src = /src="([^"]*)"/.exec(rewritten)?.[1] ?? "";
  assert.ok(src.startsWith("/issues/dts-file?path="), "应重写为代理相对 URL");
  assert.equal(isAllowedDtsUri(src), true, "重写后的 img src 必须能过消毒白名单");
});

test("rel 注入:每个 <a> 都带上 rel=noopener noreferrer,输入侧 rel 被改写,幂等", () => {
  assert.equal(
    enforceLinkRel('<a href="https://a.b/">x</a>'),
    '<a rel="noopener noreferrer" href="https://a.b/">x</a>',
  );
  // 反向钓鱼口子:输入里的 rel="opener" 必须被换成安全值,不是保留。
  assert.equal(
    enforceLinkRel('<a href="/x" rel="opener">y</a>'),
    '<a href="/x" rel="noopener noreferrer">y</a>',
  );
  assert.equal(enforceLinkRel("<a>裸锚</a>"), '<a rel="noopener noreferrer">裸锚</a>');
  // 只动锚点:<abbr> 是别的标签,不是没写全的 <a。
  assert.equal(enforceLinkRel('<abbr title="t">N</abbr>'), '<abbr title="t">N</abbr>');
  const once = enforceLinkRel('<A HREF="https://a.b/">x</A><a href="/y">z</a>');
  assert.equal(enforceLinkRel(once), once, "重复套用结果不变(幂等)");
});

test("消毒包装接线(node 无 DOM 可观察部分):入口先重写图片、rel 最后注入,空输入出空串", () => {
  assert.equal(prepareDtsHtml(undefined), "");
  assert.equal(prepareDtsHtml(""), "");
  // node 下 DOMPurify 退化为原样返回(见下一条 skip 说明),所以这里
  // 只断言首尾两道变换都发生且顺序正确;真正的剥离在 DOM 集成用例里。
  const out = prepareDtsHtml(
    '<img src="https://dts.example.com/v1/nfs/a.png"><a href="/x">单据</a>',
  );
  assert.ok(out.includes("/issues/dts-file?path="), "图片应已重写为代理 URL");
  assert.ok(out.includes('<a rel="noopener noreferrer" href="/x">'), "rel 应最后注入");
  // 消毒层的守卫路径:node 无 sanitize,原样返回——这条只在测试环境成立。
  assert.equal(sanitizeDtsHtml("<script>x</script>"), "<script>x</script>");
});

test("DOM 集成:script/事件属性/javascript: 被剥除,白名单内容与代理图保留", {
  // 显式 skip 并明说:剥离行为发生在浏览器 DOM 里,node 环境下 DOMPurify
  // 不装配 sanitize(实测 isSupported=false 且 sanitize 为 undefined);
  // 本仓测试零外部依赖、不引 jsdom,故此用例在当前环境必 skip。
  // 策略侧的等价审计已由上面各用例直测覆盖。
  skip: !HAS_DOM && "node 无 DOM:DOMPurify 的剥离只能在真浏览器跑,本仓测试不引 jsdom(前端零外部依赖)",
}, () => {
  const out = prepareDtsHtml(
    '<p onclick="alert(1)">正常<script>alert(2)</script>文本</p>'
    + '<a href="javascript:alert(3)">坏链接</a><a href="https://a.b/">好链接</a>'
    + '<img src="https://dts.example.com/v1/nfs/a b.png" onerror="alert(4)">'
    + '<table><tr><td colspan="2">表格</td></tr></table>',
  );
  assert.equal(/<script/i.test(out), false, "script 标签必须剥除");
  assert.ok(!out.includes("alert(2)"), "script 内容不能泄漏");
  assert.ok(!out.includes("onclick") && !out.includes("onerror"), "事件属性必须剥除");
  assert.ok(!out.includes("javascript:"), "javascript: URL 必须剥除");
  assert.ok(out.includes("<p>正常文本</p>"), "白名单标签与文本保留(剥壳留文本)");
  assert.ok(out.includes('rel="noopener noreferrer"'), "链接强制 rel");
  assert.ok(out.includes("/issues/dts-file?path="), "内嵌图仍走平台代理");
  assert.ok(out.includes('colspan="2"'), "表格属性保留");
});
