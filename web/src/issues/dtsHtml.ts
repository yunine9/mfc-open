/**
 * DTS 单据 HTML 的白名单消毒(问题 spec #2:外部内容无法注入脚本)。
 *
 * 单据 HTML 来自外部 DTS 系统,是现成 XSS 面:页面上两处
 * dangerouslySetInnerHTML(IssueBoard 的登记列表详情与会话材料页)
 * 渲染前必须过这里的 prepareDtsHtml。管线与顺序见该函数注释。
 *
 * 消毒器用 vendor 的 DOMPurify 单文件(vendor/dompurify.es.mjs,不改
 * 源码、保留许可证头;前端零外部依赖,故不进 package.json,内网可用)。
 * 本模块导出的白名单表与配置装配都是纯数据,node 测试直测;DOM 剥离
 * 行为只能在浏览器发生(node 无 DOM 时 DOMPurify 退化为原样返回)。
 */
import DOMPurify from "./vendor/dompurify.es.mjs";

/**
 * 白名单标签:文本/段落/标题/列表/链接/图片 + 常见安全排版
 * (代码块/引用/表格)。DTS 描述里表格很常见,剥掉会把内容压成
 * 一行不可读的烂泥,所以表格族放行。表外标签(如 center/font)
 * 由 KEEP_CONTENT 剥壳留文本,内容不丢。
 * script/style/iframe/svg/object/embed/form 等一律不在表内。
 */
export const DTS_ALLOWED_TAGS: readonly string[] = [
  // 段落与结构
  "p", "div", "span", "br", "hr", "blockquote", "pre",
  // 标题
  "h1", "h2", "h3", "h4", "h5", "h6",
  // 列表
  "ul", "ol", "li",
  // 链接与图片
  "a", "img",
  // 行内样式性标签(纯语义,零脚本面)
  "b", "strong", "i", "em", "u", "s", "code", "sub", "sup",
  // 表格族
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
];

/**
 * 白名单属性。注意 DOMPurify 的 ALLOWED_ATTR 是全标签一张表(不分标签
 * 约束),所以这张表只收「放在任何标签上都无害」的属性:
 * - 票面要求链接必须 rel=noopener:rel 不进表(防输入里带 rel="opener"
 *   反向钓鱼),由 enforceLinkRel 在消毒后统一注入安全值;
 * - target 不放行:外链改同页打开,不给 opener 场景;
 * - style/srcset/id 一律不放行:style 是 CSS 注入面,srcset 绕开图片
 *   代理重写,id 是 DOM clobbering 面(DOMPurify 的 SANITIZE_DOM 只兜
 *   id/name 被覆盖的情形,这里直接不收更干净)。
 */
export const DTS_ALLOWED_ATTRS: readonly string[] = [
  "class",
  // a:链接地址与悬浮提示
  "href", "title",
  // img:图片地址(重写后的代理相对 URL)与展示信息
  "src", "alt", "width", "height",
  // 表格:合并单元格
  "colspan", "rowspan",
];

/**
 * URI 放行策略:仅 http/https 绝对地址与站内相对地址(相对路径、
 * ./、../、#锚点、?查询)。形状仿 DOMPurify 默认表但砍掉
 * mailto/tel/cid 等——票面口径「链接仅 http/https」。
 *
 * 为什么是这个形状:DOMPurify 对 URI 属性先剥空白/控制字符
 * (ATTR_WHITESPACE,含 \t \n 等)再整串测试本正则;第二支 `[^a-z]`
 * 在 i 旗标下连大写字母都不匹配,第三支要求「字母串后面不能紧跟冒号」,
 * 于是 javascript:/JAVASCRIPT:/java\tscript:(剥空白后)全被拒,
 * 而 https://、/path、foo.png、#a 正常放行。
 */
export const DTS_ALLOWED_URI_REGEXP =
  /^(?:https?:|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** 与 vendor 源码逐字一致(DOMPurify 3.4.14,只读拷贝):URI 测试前的剥除表。 */
const URI_ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

/**
 * URI 属性值是否在白名单内。仅是 DTS_ALLOWED_URI_REGEXP 的直测镜像
 * (复刻 DOMPurify「先剥空白再测」的既定契约),供 node 测试不经 DOM
 * 直接审计策略;真正执行者是 DOMPurify 的 _isValidAttribute。
 */
export function isAllowedDtsUri(value: string): boolean {
  return DTS_ALLOWED_URI_REGEXP.test(value.replace(URI_ATTR_WHITESPACE, ""));
}

/** 装配给 DOMPurify 的消毒选项:表拷贝进配置,防运行期被人改表。 */
export const DTS_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [...DTS_ALLOWED_TAGS],
  ALLOWED_ATTR: [...DTS_ALLOWED_ATTRS],
  ALLOWED_URI_REGEXP: DTS_ALLOWED_URI_REGEXP,
  // 表外标签(如 <center>)剥壳留文本:DTS 描述的可读性优先,
  // 真正藏毒的内容(script/style 等)在 FORBID_CONTENTS 默认表里,
  // 其文本会被整个丢弃,不会泄漏。
  KEEP_CONTENT: true,
} as const;

/** 消毒一个 HTML 片段:表外标签/属性/危险 URL 全剥,输出仍是 HTML 字符串。 */
export function sanitizeDtsHtml(html: string): string {
  // 浏览器里 sanitize 恒在;node 无 DOM 时 DOMPurify 提前 return 连
  // sanitize 都不装配(实测),此时只能原样返回——这条路径只有 node
  // 测试会走,页面渲染永远有 DOM。守卫写明,不做静默假消毒的伪装。
  const sanitize = DOMPurify.sanitize;
  return typeof sanitize === "function"
    ? sanitize.call(DOMPurify, html, DTS_SANITIZE_CONFIG)
    : html;
}

/**
 * 给输出里每个 <a> 注入 rel="noopener noreferrer"(票面硬要求)。
 * rel 不在白名单里,消毒已剥掉输入侧的 rel,这里注入的值是唯一来源;
 * 已有 rel 的情形只在重复套用(幂等)时出现,重写为安全值。
 * 只对消毒器的序列化输出运行:其属性值里不会出现裸 > 或 <,正则才可靠。
 */
export function enforceLinkRel(html: string): string {
  const REL = /\srel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
  return html.replace(/<a\b([^>]*)>/gi, (_whole, attrs: string) =>
    `<a${REL.test(attrs) ? attrs.replace(REL, ' rel="noopener noreferrer"') : ` rel="noopener noreferrer"${attrs}`}>`,
  );
}

/** 将 DTS 描述中的 <img src="https://dts-xxx/..."> 或 <img src="/v1/nfs/...">
 *  重写为本地代理 URL /issues/dts-file?path=...,避免跨域无 cookie 问题。 */
export function resolveDtsImages(html: string | undefined): string {
  if (!html) return "";
  // path 整体 encodeURIComponent 后再进查询串:DTS 文件名里常见的
  // 空格/中文/&/+/#/% 原样拼 URL 会截断参数或让整个请求解析失败。
  // 只编码一次,服务端 searchParams.get 解回原路径再回取 DTS;
  // DTS 原文里已编码过的段(%xx)会再转义成 %25xx,解一次恰好还原,
  // 不会出现二次解码丢字。
  const toProxy = (_m: string, lead: string, path: string, tail: string) =>
    `${lead}/issues/dts-file?path=${encodeURIComponent(path)}${tail}`;
  // 匹配绝对路径: src="https://dts.example.com/v1/nfs/..."
  html = html.replace(
    /(<img\s[^>]*src=")https?:\/\/[^/"]*(\/[^"]*)(")/gi,
    toProxy,
  );
  // 兜底匹配相对路径: src="/v1/nfs/..."
  html = html.replace(
    /(<img\s[^>]*src=")(\/v1\/[^"]*)(")/gi,
    toProxy,
  );
  return html;
}

/**
 * DTS 单据 HTML 的唯一渲染入口:两处 dangerouslySetInnerHTML 都必须
 * 从这里拿 __html。顺序有讲究:
 * 1. 先图片代理重写:消毒会把属性值里的 & 序列化成 &amp;,重写若放在
 *    消毒后就得先解实体才能拿到原始 path;先重写则原始 URL 原样进
 *    encodeURIComponent,产物是纯相对代理 URL,恰好落在 URI 白名单内。
 * 2. 后消毒兜底:重写注入的文本虽是自家产物,把关仍统一交给消毒器——
 *    若重写产物不合白名单,会被剥掉而不是被信任。
 * 3. 最后补 rel:rel 不进白名单,消毒会剥掉输入侧的 rel,剥完才注入
 *    安全值,顺序反了注入的 rel 会被消毒器当未知属性剥掉。
 */
export function prepareDtsHtml(html: string | undefined): string {
  if (!html) return "";
  return enforceLinkRel(sanitizeDtsHtml(resolveDtsImages(html)));
}
