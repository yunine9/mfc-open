/**
 * 登记问题统计(ADR-0048,口径 2026-10-16 由 ADR-0064 收紧):无单
 * 会话的结论漏斗与研究质量,交付分析「登记问题」页签的读侧。人群=
 * 无单流程会话且研究结论已出——非问题/确认是问题归档;取消是退场、
 * 不算研究结论,不进本页任何数字(ADR-0064,与一次定位既有
 * 口径对齐);研究进行中一律不进(挂起已退役,ADR-0048/0057,存量
 * 读盘即按取消退场,同不入统计)。比率口径:非问题闭环率/确认是问
 * 题率/一次定位率分母均为非问题+确认是问题。
 *
 * 零新增记账:结论在 issue.json,报告版本数在分析版本账——全部纯
 * 投影,无起算日,全历史可算(口径变更历史比率自动重算)。
 */

/** 研究结论已出的无单会话;取消会话不是研究结论,不出现在本结构。 */
export interface IssueRegistrationSessionRow {
  id: string;
  title: string;
  module: string;
  reporter: string;
  account: string;
  concluded_at: string;
  conclusion: "non_issue" | "issue";
  report_version_count: number;
  /** 一次定位(报告一版过)。 */
  localization_pass: boolean;
}

export interface IssueRegistrationGroupRow {
  key: string;
  total: number;
  non_issue: number;
  issue_confirmed: number;
  localization_passed: number;
  localization_total: number;
  localization_rate: number | null;
}

export interface IssueRegistrationStats {
  /** 研究结论已出 = 非问题 + 确认是问题(本页唯一分母全集)。 */
  total: number;
  non_issue: number;
  issue_confirmed: number;
  /** 一次定位,分母同 total。 */
  localization: { passed: number; total: number; rate: number | null };
  per_session: IssueRegistrationSessionRow[];
  by_module: IssueRegistrationGroupRow[];
  by_reporter: IssueRegistrationGroupRow[];
}

const percent = (passed: number, total: number): number | null =>
  total ? Math.round((passed / total) * 1000) / 10 : null;

function groupRows(
  rows: ReadonlyArray<IssueRegistrationSessionRow>,
  keyOf: (row: IssueRegistrationSessionRow) => string,
): IssueRegistrationGroupRow[] {
  const map = new Map<string, IssueRegistrationGroupRow>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key) ?? {
      key, total: 0, non_issue: 0, issue_confirmed: 0,
      localization_passed: 0, localization_total: 0, localization_rate: null,
    };
    bucket.total += 1;
    if (row.conclusion === "non_issue") bucket.non_issue += 1;
    else bucket.issue_confirmed += 1;
    bucket.localization_total += 1;
    if (row.localization_pass) bucket.localization_passed += 1;
    map.set(key, bucket);
  }
  const list = [...map.values()];
  for (const bucket of list) {
    bucket.localization_rate =
      percent(bucket.localization_passed, bucket.localization_total);
  }
  return list.sort((a, b) =>
    b.total - a.total || a.key.localeCompare(b.key, "zh-Hans-CN"));
}

/** 纯聚合:per_session(已按结论时刻降序)聚出瓦片计数与两维分组。 */
export function aggregateRegistrationStats(
  rows: ReadonlyArray<IssueRegistrationSessionRow>,
): IssueRegistrationStats {
  const nonIssue = rows.filter((row) => row.conclusion === "non_issue").length;
  const issueConfirmed = rows.filter((row) => row.conclusion === "issue").length;
  const localizationPassed =
    rows.filter((row) => row.localization_pass).length;
  return {
    total: rows.length,
    non_issue: nonIssue,
    issue_confirmed: issueConfirmed,
    localization: {
      passed: localizationPassed,
      total: rows.length,
      rate: percent(localizationPassed, rows.length),
    },
    per_session: [...rows],
    by_module: groupRows(rows, (row) => row.module),
    by_reporter: groupRows(rows, (row) => row.reporter),
  };
}
