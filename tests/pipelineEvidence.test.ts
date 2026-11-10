import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPipelineRepairEvidence } from "../src/pipelineEvidence.ts";
import { ISSUE28_RECORD, JEST_LOG, issue28Artifacts } from "./pipelineSamples.ts";

const checks = [
  { dimension: "COMPILE" as const, status: "failed" as const,
    tool: "build2.0" },
  { dimension: "UT" as const, status: "failed" as const,
    tool: "CPP_UT" },
  { dimension: "CODECHECK" as const, status: "failed" as const,
    tool: "CodeCheck" },
];

test("超限指标提供事实，但不冒充可定位的编译错误", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "COMPILE", status: "failed", details: [
      { message: "DT=2 [超限]", rule: "quality_metric", severity: "error" },
    ] }],
    artifacts: [],
  });
  assert.deepEqual(result.missingDimensions, ["COMPILE"]);
});

test("流水线证据逐维对齐，材料包非空不能掩盖缺失维度", () => {
  const result = assessPipelineRepairEvidence({
    checks,
    artifacts: [
      {
        name: "pipeline_info.json",
        text: JSON.stringify({ defects: [
          { toolName: "build2.0", record_ids: ["compile-rid"] },
          { toolName: "CPP_UT", record_ids: ["ut-rid"] },
        ] }),
      },
      {
        name: "build_log_compile-rid.txt",
        text: "src/main.cpp:42: error: Widget was not declared",
      },
      {
        name: "codecheck_detail.json",
        text: JSON.stringify({ defects: [{
          file: "src/main.cpp", line: 42, rule: "G.FUN.01-CPP",
          message: "function is too long",
        }] }),
      },
      {
        name: "pipeline_log_summary.json",
        text: JSON.stringify({ strategies: {
          coverage: { status: "failed", note: "jobId 不被 codecov 识别" },
        } }),
      },
    ],
  });

  assert.deepEqual(result.availableDimensions.sort(), ["CODECHECK", "COMPILE"]);
  assert.deepEqual(result.missingDimensions, ["UT"]);
  assert.match(result.reasons.UT?.join(" ") ?? "", /jobId/);
});

test("只有汇总计数或 No data 不冒充可定位证据", () => {
  const result = assessPipelineRepairEvidence({
    checks: checks.slice(1),
    artifacts: [
      { name: "codecheck_detail.json",
        text: JSON.stringify({ defectCount: 3, status: "failed" }) },
      { name: "coverage_diff_bad.json", text: "No data found" },
    ],
  });
  assert.deepEqual(result.availableDimensions, []);
  assert.deepEqual(result.missingDimensions, ["UT", "CODECHECK"]);
});

test("人工回灌只覆盖系统当时明确求助的维度", () => {
  const result = assessPipelineRepairEvidence({
    checks,
    artifacts: [],
    humanEvidence: {
      dimensions: ["CODECHECK"],
      text: "src/main.cpp:42 G.FUN.01-CPP function is too long",
    },
  });
  assert.deepEqual(result.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(result.missingDimensions, ["COMPILE", "UT"]);
});

test("终态摘要按内容归维，不以一段文字替全部红灯背书", () => {
  const result = assessPipelineRepairEvidence({
    checks,
    artifacts: [],
    failureSummary: "BUILD FAILURE: src/main.cpp:9: error: missing.hpp not found",
  });
  assert.deepEqual(result.availableDimensions, ["COMPILE"]);
  assert.deepEqual(result.missingDimensions, ["UT", "CODECHECK"]);
});

test("CodeCheck 状态明细必须带文件行号；只有页面 URL 仍算缺证据", () => {
  const located = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", job: "codecheck",
      details: [{
        file: "src/TextUtil.java", line: 22, rule: "ARCH-UTIL-02",
        message: "Unicode 空白策略应迁出工具类",
      }],
    }],
    artifacts: [],
    failureSummary: "FAILED stage=CodeCheck",
  });
  assert.deepEqual(located.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(located.missingDimensions, []);

  const urlOnly = assessPipelineRepairEvidence({
    checks: [{ dimension: "CODECHECK", status: "failed", job: "codecheck" }],
    artifacts: [],
    failureSummary: "FAILED stage=CodeCheck2.0 job=CodeCheck2.0 detail: "
      + "https://codecheck.intra.example/tasks/123",
  });
  assert.deepEqual(urlOnly.availableDimensions, []);
  assert.deepEqual(urlOnly.missingDimensions, ["CODECHECK"]);
});

test("识别内网 CodeCheck 真实 fileName/lineNum/indicatorName 字段", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "codecheck",
    }],
    artifacts: [{
      name: "codecheck_detail.json",
      text: JSON.stringify({ defects: [{
        tool: "codecheck",
        ruleId: "45deed5a4d6140c8b10884643f930bc3",
        indicatorName: "G.FUN.01-CPP 函数功能要单一",
        fileName: "service/HandleAdvice/AcceptNRAdviceMML.hpp",
        lineNum: 13,
        description: "函数行数建议不超过 50 行",
        yellowResult: false,
      }] }),
    }],
  });
  assert.deepEqual(result.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(result.missingDimensions, []);
});

test("前端 runner(Jest/Mocha/Vitest)失败特征让 UT 维度从构建日志拿到证据", () => {
  const utFailed = [{ dimension: "UT" as const, status: "failed" as const }];
  const assess = (text: string) => assessPipelineRepairEvidence({
    checks: utFailed,
    artifacts: [{ name: "build_log_ut-1.txt", text }],
  });
  for (const [feature, sample] of [
    ["FAIL 行", "FAIL  src/_tests_/KpiTaskList.test.jsx (5.426 s)"],
    ["Test Suites 汇总", "Test Suites: 1 failed, 34 passed, 35 total"],
    ["Tests 汇总", "Tests: 1 failed, 449 passed, 450 total"],
    ["Mocha failing 计数", "  2 failing\n  1) KpiTaskList detail dialog"],
    ["Vitest 汇总(无冒号)", "Test Files  1 failed (35)\n"
      + "Tests  1 failed | 448 passed (450)"],
  ] as const) {
    const result = assess(sample);
    assert.deepEqual(result.availableDimensions, ["UT"],
      `${feature} 应让 UT 维度拿到证据`);
    assert.deepEqual(result.missingDimensions, [],
      `${feature} 在场时 UT 不算缺口`);
    assert.ok(result.sources.UT?.includes("build_log_ut-1.txt"),
      `${feature} 的证据来源是构建日志本身`);
  }
  const full = assess(JEST_LOG);
  assert.deepEqual(full.availableDimensions, ["UT"]);
  assert.deepEqual(full.missingDimensions, []);
});

test("CPP_UT 汇总失败进入证据判定，gcovr 后续报错不能遮住测试失败", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed", tool: "CPP_UT" }],
    artifacts: [{ name: "build_error_excerpt_3DFH4HMK-6M4C.txt",
      text: "测试失败原文\n11460: Run: 59 Failure total: 28 Failures: 28 Errors: 0\n"
        + "15866: ERROR mssage: Test case failed. Run: 59 Failure total: 28\n"
        + "其他构建报错\ngcovr exit 22" }],
  });
  assert.deepEqual(result.availableDimensions, ["UT"]);
  assert.deepEqual(result.missingDimensions, []);
  assert.ok(result.sources.UT?.includes("build_error_excerpt_3DFH4HMK-6M4C.txt"));

  const passed = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed", tool: "CPP_UT" }],
    artifacts: [{ name: "build_error_excerpt_3DFH4HMK-6M4C.txt",
      text: "Run: 59 Failure total: 0 Failures: 0 Errors: 0\ngcovr exit 22" }],
  });
  assert.deepEqual(passed.availableDimensions, [],
    "失败数为 0 和 gcovr 错误不能冒充 UT 用例失败证据");
});

test("CPP_UT 具体失败用例名可直接作为测试失败证据", () => {
  for (const line of [
    "[  FAILED  ] ServiceSuite.Case17 (1 ms)",
    "Test case ServiceSuite.Case17 failed",
  ]) {
    const result = assessPipelineRepairEvidence({
      checks: [{ dimension: "UT", status: "failed", tool: "CPP_UT" }],
      artifacts: [{ name: "build_error_excerpt_ut.txt", text: line }],
    });
    assert.deepEqual(result.availableDimensions, ["UT"], line);
  }
});

test("常见技术栈的失败用例名能进入 UT 证据", () => {
  for (const line of [
    "[ERROR] Tests run: 3, Failures: 1, Errors: 0",
    "[ERROR] ExampleServiceTest.testInvalidInput:42 expected 200 but was 500",
    "ExampleServiceTest > rejectsInvalidInput FAILED",
    "FAIL src/service.test.js",
    "● Service > handles rejected response",
    "2 failing\n  1) Service returns error",
    "FAILED tests/test_service.py::TestService::test_reject - AssertionError",
    "--- FAIL: TestServiceReject (0.01s)",
    "test service::tests::reject ... FAILED",
    "Failed Product.ServiceTests.Reject [3 ms]",
  ]) {
    const result = assessPipelineRepairEvidence({
      checks: [{ dimension: "UT", status: "failed" }],
      artifacts: [{ name: "build_error_excerpt_job.txt", text: line }],
    });
    assert.deepEqual(result.availableDimensions, ["UT"], line);
  }
});

test("复合构建工具的 record 被归到编译维时，日志内容仍按 UT 背书", () => {
  // 真实形态:CodeCheck2.0 下 build2.0 跑 JS UT,defects[].toolName=build2.0
  // 被 record-id 归类硬映射成编译维;日志内容嗅探才是权威,映射降级为
  // 弱提示,两者并集背书。
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed", tool: "build2.0" }],
    artifacts: [
      {
        name: "pipeline_info.json",
        text: JSON.stringify({ defects: [
          { toolName: "build2.0", record_ids: ["3BW2BKXV-UT"] },
        ] }),
      },
      { name: "build_log_3BW2BKXV-UT.txt", text: JEST_LOG },
    ],
  });
  assert.deepEqual(result.availableDimensions, ["UT"]);
  assert.deepEqual(result.missingDimensions, []);
  assert.ok(result.sources.UT?.includes("build_log_3BW2BKXV-UT.txt"),
    "内容嗅探(强信号)把 UT 日志背书给 UT 维");
  assert.ok(result.sources.COMPILE?.includes("build_log_3BW2BKXV-UT.txt"),
    "record-id 归类(弱提示)的并集背书保留");
});

test("无强特征的日志不因嗅探放宽而冒充证据", () => {
  // record-id 映射在场也不行:并集的前提是内容有强特征,零特征日志
  // 连映射维度也不背书(旧基线),否则派发修复只会照着一份没有内容的日志猜改。
  const result = assessPipelineRepairEvidence({
    checks: [
      { dimension: "UT", status: "failed" },
      { dimension: "COMPILE", status: "failed", tool: "build2.0" },
    ],
    artifacts: [
      {
        name: "pipeline_info.json",
        text: JSON.stringify({ defects: [
          { toolName: "build2.0", record_ids: ["plain-rid"] },
        ] }),
      },
      {
        name: "build_log_plain-rid.txt",
        text: "build finished with warnings; quality gate not met",
      },
    ],
  });
  assert.deepEqual(result.availableDimensions, [],
    "没有失败特征/堆栈的日志什么维度都不背书,映射也不行");
  assert.deepEqual(result.missingDimensions.sort(), ["COMPILE", "UT"]);
  assert.deepEqual(result.fallbackSources, [],
    "没有可定位内容的日志也不进跨维度兜底");
});

test("堆栈行参与全量日志判定：测试文件堆栈归 UT，业务文件堆栈归编译", () => {
  const assess = (text: string, dims: Array<{
    dimension: "UT" | "COMPILE";
  }>) => assessPipelineRepairEvidence({
    checks: dims.map((dimension) => ({ ...dimension, status: "failed" as const })),
    artifacts: [{ name: "build_log_stack.txt", text }],
  });
  const utStack = assess(
    "at Object.<anonymous> (src/_tests_/KpiTaskList.spec.tsx:88:11)",
    [{ dimension: "UT" }]);
  assert.deepEqual(utStack.availableDimensions, ["UT"],
    "测试文件的 path:line 堆栈按内容归 UT");

  // 编译维与 UT 同时红:业务文件堆栈按内容背书编译维;UT 拿不到
  // (该日志未被 UT 认领,也不能拿编译堆栈替 UT 背书)。
  const compileStack = assess("at create (src/service/Order.java:88)",
    [{ dimension: "UT" }, { dimension: "COMPILE" }]);
  assert.deepEqual(compileStack.availableDimensions, ["COMPILE"],
    "业务文件的 path:line 堆栈按内容归编译维");
  assert.deepEqual(compileStack.missingDimensions, ["UT"]);
  assert.deepEqual(compileStack.fallbackSources, [],
    "日志已被失败维度(编译)认领,不再跨维度兜底给 UT");

  // 逐行归维:同一份日志两种堆栈都有时两维都背书,整份二选一会丢一维。
  const mixedStack = assess([
    "    at Object.<anonymous> (src/_tests_/KpiTaskList.spec.tsx:88:11)",
    "    at create (src/service/Order.java:88)",
  ].join("\n"), [{ dimension: "UT" }, { dimension: "COMPILE" }]);
  assert.deepEqual(mixedStack.availableDimensions.sort(), ["COMPILE", "UT"],
    "混合堆栈逐行归维,两维都拿到证据");
  assert.deepEqual(mixedStack.missingDimensions, []);
});

test("CodeCheck lineNum=0 表示整文件或 MR 级规则，不误判成无报错", () => {
  const artifact = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "codecheck",
    }],
    artifacts: [{
      name: "codecheck_detail.json",
      text: JSON.stringify({ defects: [{
        fileName: "service/Advice.cpp",
        lineNum: 0,
        indicatorName: "ARCH.MR.01 变更范围违反架构约束",
        description: "本次变更跨越了禁止依赖的模块边界",
      }] }),
    }],
  });
  assert.deepEqual(artifact.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(artifact.missingDimensions, []);

  const structured = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "codecheck",
      details: [{
        file: "service/Advice.cpp", line: 0,
        rule: "ARCH.MR.01", message: "本次变更违反架构约束",
      }],
    }],
    artifacts: [],
  });
  assert.deepEqual(structured.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(structured.missingDimensions, []);
});

/** issue-28 四件套产物来自共享样例模块(单一来源,防样例漂移)。 */
const ISSUE28_ARTIFACTS = issue28Artifacts();

test("issue-28 形态:维度错配的质量门红灯由跨维度兜底救回", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "CODECHECK", status: "failed",
      tool: "CodeCheck2.0" }],
    artifacts: ISSUE28_ARTIFACTS,
  });
  assert.deepEqual(result.availableDimensions, ["CODECHECK"],
    "CodeCheck 维零证据,由含可定位内容的构建日志兜底背书");
  assert.deepEqual(result.missingDimensions, []);
  assert.match(result.sources.CODECHECK?.join(" ") ?? "", /跨维度兜底/,
    "兜底来源必须带归类错配标注,不静默混入");
  assert.match(result.sources.UT?.join(" ") ?? "", /指标型质量门缺陷/,
    "指标型缺陷(通过率/DT)作为 UT 失败信号在场");
  assert.deepEqual(result.fallbackSources.length, 1);
  assert.match(result.fallbackSources[0], /^CodeCheck: build_log_/,
    "兜底出口带维度前缀,供执行层写进回合文案");
});

test("兜底红线:镜像日志无可定位内容时不兜底，仍按全缺处理", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "CODECHECK", status: "failed",
      tool: "CodeCheck2.0" }],
    artifacts: ISSUE28_ARTIFACTS.map((artifact) =>
      artifact.name === `build_log_${ISSUE28_RECORD}.txt`
        ? { name: artifact.name,
            text: "构建完成,质量门指标未达标,详情见平台页面" }
        : artifact),
  });
  assert.deepEqual(result.availableDimensions, [],
    "空日志借不到兜底:没有任何可定位内容就该举卡找人工");
  assert.deepEqual(result.missingDimensions, ["CODECHECK"]);
  assert.deepEqual(result.fallbackSources, []);
});

test("指标型缺陷关键词只在 CodeCheck 明细产物的 indicatorName 字段生效", () => {
  const otherProduct = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed" }],
    artifacts: [{
      name: "quality_summary.json",
      text: JSON.stringify({ indicatorName: "js pass rate(%)",
        actualValue: 99.7 }),
    }],
  });
  assert.deepEqual(otherProduct.availableDimensions, [],
    "其他产物带指标词不触发 UT 信号,防止关键词误伤");

  const otherField = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed" }],
    artifacts: [{
      name: "codecheck_detail.json",
      text: JSON.stringify({ strategy: {
        description: "统计 UT 覆盖率与通过率",
        defectCount: 2,
      } }),
    }],
  });
  assert.deepEqual(otherField.availableDimensions, [],
    "说明文/策略描述里出现同词不算指标型缺陷,只认 indicatorName 字段");
});

test("失败维度已有证据时不跨维度兜底", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "CODECHECK", status: "failed",
      tool: "CodeCheck",
      details: [{ file: "src/TextUtil.java", line: 22,
        rule: "ARCH-UTIL-02", message: "命中架构约束" }] }],
    artifacts: [
      { name: "pipeline_info.json", text: JSON.stringify({ defects: [
        { toolName: "build2.0", record_ids: ["r9"] },
      ] }) },
      { name: "build_log_r9.txt", text: JEST_LOG },
    ],
  });
  assert.deepEqual(result.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(result.missingDimensions, []);
  assert.deepEqual(result.fallbackSources, [],
    "CodeCheck 自己有 checks 明细,不需要兜底");
  assert.ok(result.sources.CODECHECK?.every((source) =>
    !source.includes("跨维度兜底")));
});
