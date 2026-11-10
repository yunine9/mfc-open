/**
 * 仓身份归一(与后端工具层门禁同一把尺):trim/去尾斜杠/去 .git/
 * 小写。模块目录里的绑定地址与会话账面里的仓地址,`.git` 尾缀与大小
 * 写写法可能有差异,原样字符串比对会误判(先例:MetaPane 同款函数,
 * 2026-10-21 特性树绑定外标记时提出共用)。
 */
export function repoIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** 仓地址的展示简写:去协议/域名/`.git`,取路径末两段——
 *  `https://git.example.com/team/alarm.git` → `team/alarm`,单段路径
 *  只取段名。域名和协议一般不是关注点,完整地址留在悬停(title)里;
 *  筛选值与绑定比对仍用全址(repoIdentity),本函数只管显示。 */
export function repoShortName(value: string): string {
  const withoutGit = value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const path = withoutGit.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^/]+/, "");
  const segments = path.split("/").filter(Boolean);
  return segments.slice(-2).join("/");
}
