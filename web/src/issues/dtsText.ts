/**
 * DTS 单据的文本/版本/候选纯函数(不碰 React、不碰网络)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分):版本排序与单号候选
 * 是「DTS 列表」页签的过滤口径,埋在组件里没法直测——抽出来配标准
 * 测试(tests/dtsText.test.ts)。同族的单据 HTML 处理(图片代理重写/
 * 白名单消毒)在 dtsHtml.ts,这里不重复。
 */

/** 从版本串里解 (R 版, C 版),如 "MAE-Access V100R025C10SPC210B002"
 * → [25, 10]。解不出的返回 undefined(排序时垫底)。 */
export function dtsVersionKey(version: string): [number, number] | undefined {
  const match = /R0*(\d+)C0*(\d+)/i.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** B 版构建号剥掉后的版本组前缀:"MAE-Access V100R025C10SPC010B009"
 * → "MAE-Access V100R025C10SPC010";没有 B 段的原样返回。版本过滤按
 * 组勾选——B 版构建号太多,逐个勾不现实,勾一个组命中组内全部 B 版
 * 单据。尾部 B 段才算构建号(SPC0101 这种 SP 段不受影响),大小写
 * 不敏感;先去尾空白再剥,B 段锚定在串尾。 */
export function dtsVersionGroup(version: string): string {
  return version.trim().replace(/B\d+$/i, "");
}

/** 版本降序:先比 R 版,R 同再比 C 版;都解不出的按字典序垫底。 */
export function sortDtsVersionsDesc(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const ka = dtsVersionKey(a);
    const kb = dtsVersionKey(b);
    if (ka && kb) return (kb[0] - ka[0]) || (kb[1] - ka[1]);
    if (ka) return -1;
    if (kb) return 1;
    return a.localeCompare(b);
  });
}

/** 输入是否像 DTS 单号(字母开头 + 含数字,总长 >=5),支持逗号/空格
 * 分隔多个,如 "DTS2026082671269" 或 "DTS123,DTS456"。 */
export function dtsNoCandidates(query: string): string[] {
  return query.split(/[,，、\s]+/).map((token) => token.trim())
    .filter((token) => /^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(token)
      && /\d/.test(token));
}

/** 拉单只接"开发人员实施修改"状态的单:其他状态(新建/关闭/挂起等)
 * 不可发起,列表直接不展示(本地拉取与远程补查同规)。 */
export const DTS_ACTIONABLE_STATUS = "开发人员实施修改";
export const isActionableDts = (t: { status?: string }): boolean =>
  t.status === DTS_ACTIONABLE_STATUS;
