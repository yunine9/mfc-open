/**
 * DTS 文本/版本/候选纯函数的契约(dtsText.ts)。
 *
 * 「DTS 列表」页签的过滤口径(版本降序、单号候选、可发起状态)原本
 * 埋在登记组件里,拆分时抽成纯函数——这里的断言就是它的契约:
 * 换掉实现(比如换正则写法),这些行为仍应全绿。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DTS_ACTIONABLE_STATUS,
  dtsNoCandidates,
  dtsVersionGroup,
  dtsVersionKey,
  isActionableDts,
  sortDtsVersionsDesc,
} from "../web/src/issues/dtsText.ts";

test("dtsVersionGroup:剥掉尾部 B 版构建号,得到版本组前缀", () => {
  assert.equal(dtsVersionGroup("MAE-Access V100R025C10SPC010B009"),
    "MAE-Access V100R025C10SPC010");
  assert.equal(dtsVersionGroup("V100R025C10B002"), "V100R025C10", "无 SP 段同样剥 B");
  assert.equal(dtsVersionGroup("V100R025C10SPC010"), "V100R025C10SPC010",
    "没有 B 段的原样返回");
  assert.equal(dtsVersionGroup("V100R025C10SPC0101"), "V100R025C10SPC0101",
    "尾部数字不属于 B 段时不剥(SPC0101 是 SP 段)");
  assert.equal(dtsVersionGroup("V100R025C10SPC010b009 "), "V100R025C10SPC010",
    "小写 b 与尾空白都容忍");
});

test("dtsVersionKey:从真实版本串里解出 (R 版, C 版)", () => {
  assert.deepEqual(dtsVersionKey("MAE-Access V100R025C10SPC210B002"), [25, 10]);
  assert.deepEqual(dtsVersionKey("V100R0C0"), [0, 0], "R0*C0* 前导零容忍");
  assert.deepEqual(dtsVersionKey("r19c5"), [19, 5], "大小写不敏感");
});

test("dtsVersionKey:解不出 R+C 的串返回 undefined(排序时垫底)", () => {
  assert.equal(dtsVersionKey("V100R025"), undefined, "只有 R 版没有 C 版");
  assert.equal(dtsVersionKey("C10"), undefined, "只有 C 版没有 R 版");
  assert.equal(dtsVersionKey("B002"), undefined, "纯构建号");
  assert.equal(dtsVersionKey(""), undefined);
});

test("sortDtsVersionsDesc:先比 R 版,R 同再比 C 版,降序", () => {
  assert.deepEqual(sortDtsVersionsDesc([
    "R19C5", "R25C10", "R25C21", "R25C2",
  ]), ["R25C21", "R25C10", "R25C2", "R19C5"]);
});

test("sortDtsVersionsDesc:解不出的按字典序垫底,不混进版本序", () => {
  const sorted = sortDtsVersionsDesc(["zz", "R25C10", "aa", "R19C1"]);
  assert.deepEqual(sorted.slice(2).sort(), ["aa", "zz"], "垫底的两个排尾部");
  assert.deepEqual(sorted.slice(0, 2), ["R25C10", "R19C1"]);
});

test("sortDtsVersionsDesc:不动入参数组(纯函数)", () => {
  const input = ["R19C5", "R25C10"];
  sortDtsVersionsDesc(input);
  assert.deepEqual(input, ["R19C5", "R25C10"]);
});

test("dtsNoCandidates:认得 DTS 单号,支持逗号/空格/顿号分隔多个", () => {
  assert.deepEqual(dtsNoCandidates("DTS2026082671269"), ["DTS2026082671269"]);
  assert.deepEqual(dtsNoCandidates("DTS123,DTS456"), ["DTS123", "DTS456"]);
  assert.deepEqual(dtsNoCandidates("DTS123 DTS456"), ["DTS123", "DTS456"]);
  assert.deepEqual(dtsNoCandidates("DTS123、DTS456"), ["DTS123", "DTS456"]);
  assert.deepEqual(dtsNoCandidates(" DTS123 ，DTS456 "), ["DTS123", "DTS456"],
    "全角逗号与首尾空白都容忍");
});

test("dtsNoCandidates:字母开头 + 含数字 + 长>=5,缺一不可", () => {
  assert.deepEqual(dtsNoCandidates("12345"), [], "纯数字不算(不是字母开头)");
  assert.deepEqual(dtsNoCandidates("ABCDE"), [], "纯字母不算(不含数字)");
  assert.deepEqual(dtsNoCandidates("AB1"), [], "太短不算");
  assert.deepEqual(dtsNoCandidates("播放器黑屏"), [], "普通搜索词不算");
});

test("可发起状态:只认「开发人员实施修改」,其他状态一律不发起", () => {
  assert.equal(DTS_ACTIONABLE_STATUS, "开发人员实施修改");
  assert.equal(isActionableDts({ status: "开发人员实施修改" }), true);
  for (const status of ["新建", "已关闭", "挂起", "", undefined]) {
    assert.equal(isActionableDts({ status }), false, `status=${status} 不可发起`);
  }
});
