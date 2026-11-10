/**
 * 登记截图引用的两个世界(#184 票2):
 * - 存储/管线世界:markdown 里的 `issue-images/<hash>.<ext>` 相对引用
 *   (description 数据模型;AI 上下文、登记提交、staging 提取只认它);
 * - 编辑器/浏览器世界:`/issues/issue-image?path=…` 预览 URL(staging
 *   回显二进制,<img> 只有它才显示得出来)。
 * DescriptionEditor 的出入两侧各做一次映射,转换只收敛在这一处;
 * 正则形态与 issueImages 的 parseIssueImagePath 同款(16 位 hex + 扩展名)。
 */

/** markdown(存储世界)→ 编辑器默认值:引用换成可显示的预览 URL。 */
export function refToDisplayUrl(
  markdown: string,
  buildUrl: (ref: string) => string,
): string {
  return markdown.replace(
    /(!\[[^\]]*\]\()(issue-images\/[0-9a-f]{16}\.[a-z]+)(\))/gi,
    (_match, head: string, ref: string, tail: string) =>
      `${head}${buildUrl(ref)}${tail}`,
  );
}

/** 编辑器序列化(markdownUpdated)→ 存储:预览 URL 换回相对引用,
 * onChange 之后 description 管线看不到任何预览 URL。 */
export function displayUrlToRef(markdown: string): string {
  return markdown.replace(
    /(!\[[^\]]*\]\()\/issues\/issue-image\?path=issue-images(?:%2F|\/)([0-9a-f]{16}\.[a-z]+)(?:[^)\s]*)?(\))/gi,
    (_match, head: string, hash: string, tail: string) =>
      `${head}issue-images/${hash}${tail}`,
  );
}
