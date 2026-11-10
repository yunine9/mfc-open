/**
 * 红灯证据评估的共享样例(脱敏自真实环境 issue-28)。
 *
 * 纯函数层(pipelineEvidence.test.ts)与两条流的执行层
 * (issueFlowFixed / pipelineEvidenceFallback)用同一份原文回归——
 * 样例单一来源,改一处三处同步,防止"各自维护导致样例漂移"。
 */

/** 前端测试 runner(Jest)的真实输出形态:旧 UT 尺子按 C/C++/Maven
 * 写,这些特征行(FAIL 行/汇总行/断言堆栈)一个都不中。 */
export const JEST_LOG = [
  "FAIL  src/_tests_/containers/CrossRatCollection/KpiTaskList.test.jsx (5.426 s)",
  "  ● KpiTaskList › detail dialog header labels use consistent colon style",
  "    expect(received).toBeTruthy()",
  "    Received: undefined",
  "",
  "      602 |   expect(detailBtn).toBeTruthy();",
  "    at Object.<anonymous> "
    + "(src/_tests_/containers/CrossRatCollection/KpiTaskList.test.jsx:602:27)",
  "Test Suites: 1 failed, 34 passed, 35 total",
  "Tests: 1 failed, 449 passed, 450 total",
].join("\n");

export const ISSUE28_RECORD = "3BW2BKXV-0W28-J680-0000-9PJBDYEG6Dzu";

/**
 * issue-28 四件套产物:构建 record 全 SUCCESS(errorInfo 接口拒答),
 * 红的是质量门指标(js pass rate 99.78%<100、DT 缺陷 1),真正的 Jest
 * 失败原文在 build_log 里;平台把失败维度报成 CODECHECK,缺陷归属
 * 工具 build2.0 被 record-id 归类硬映射成编译维。
 * 每次调用返回新数组:调用方(执行层假件)可以放心 push/改写。
 */
export function issue28Artifacts(): Array<{ name: string; text: string }> {
  return [
    {
      name: "pipeline_info.json",
      text: JSON.stringify({ defects: [{
        toolName: "build2.0", record_ids: [ISSUE28_RECORD],
        indicatorInfos: [
          { indicatorName: "js pass rate(%)", actualValue: 99.7778,
            expectValue: 100 },
          { indicatorName: "DT", real: 1, expect: 0 },
        ],
      }] }),
    },
    {
      name: `build_errors_${ISSUE28_RECORD}.json`,
      text: JSON.stringify({ message:
        "Failed to get record error info: {'success': False, 'message': "
        + "'Illegal state, cannot get errorInfo with status: SUCCESS', "
        + "'errCode': 'CB.0001001.450'}" }),
    },
    { name: `build_log_${ISSUE28_RECORD}.txt`, text: JEST_LOG },
    {
      name: "codecheck_detail.json",
      text: JSON.stringify({ defectInfos: [
        { fileName: null, lineNum: 0, indicatorName: "js pass rate(%)",
          realValue: 99.7778, threshold: 100 },
        { fileName: null, lineNum: 0, indicatorName: "DT",
          realValue: 1, threshold: 0 },
      ] }),
    },
  ];
}
