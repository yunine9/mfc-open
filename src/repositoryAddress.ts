/** Git 输入不能使用已知的 CodeHub 网页/API 入口。
 * 不自动替换域名或补 .git：克隆端点应由用户从仓库页面复制，真实可达性
 * 仍由下单时使用个人凭据的 ls-remote 检查。此规则不用于 MR/API URL。 */
export function assertRepositoryCloneAddress(repository: string): void {
  if (!/^https?:\/\//i.test(repository)) return;
  const url = new URL(repository);
  if (url.hostname.toLowerCase().replace(/\.$/, "") === "codehub-y.example.com") {
    throw new Error("填写的是 CodeHub 网页/API 地址，不能作为 Git 克隆地址。"
      + "请打开该仓库的“克隆/下载 → HTTPS”，复制完整克隆地址后重试"
      + "（内部 Git 域名通常为 codehub.example.com）。"
      + "不要只删除末尾 / 或补 .git，仍需使用正确的克隆域名。");
  }
}
