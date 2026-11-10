/**
 * DOMPurify 3.4.14 的类型垫片(自写,非官方文件)。
 *
 * 为什么不用包里自带的 purify.es.d.mts:它 import 了可选依赖
 * trusted-types 的类型,本仓前端零外部依赖、内网装不到(2026-08-28 实测)。
 * 消毒包装层(dtsHtml.ts)只用 sanitize / isSupported 这一小块面,
 * 这里按用到的最小面声明;DOMPurify 其余能力用不到也不放开。
 */

export interface DOMPurifyConfig {
  /** 白名单标签表:表外标签剥壳(KEEP_CONTENT 时留文本)或整体丢弃。 */
  ALLOWED_TAGS?: readonly string[];
  /** 白名单属性表:表外属性一律剥除(含全部 on* 事件属性)。 */
  ALLOWED_ATTR?: readonly string[];
  /** URI 属性值(href/src 等)的放行正则:先剥控制/空白字符再整串测试。 */
  ALLOWED_URI_REGEXP?: RegExp;
  /** 非白名单标签是否保留其子内容(默认 true:剥壳留文本,保住可读性)。 */
  KEEP_CONTENT?: boolean;
}

export interface DOMPurifyInstance {
  /** 无 DOM 的环境(如 node 测试)下为 false。 */
  isSupported: boolean;
  /**
   * 仅在真 DOM 环境装配:esm 版在无 window.document 时提前 return,
   * 连 sanitize 都不挂(实测 node 下 undefined)。浏览器环境恒有。
   */
  sanitize?(dirty: string | null, config?: DOMPurifyConfig): string;
}

declare const DOMPurify: DOMPurifyInstance;
export default DOMPurify;
