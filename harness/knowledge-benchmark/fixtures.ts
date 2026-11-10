/** Synthetic, versioned benchmark data. Never imported into a production corpus. */
export const SUITE_VERSION = "3";
export const REPO = "https://example.invalid/benchmark/shared.git";
export const OTHER_REPO = "https://example.invalid/benchmark/other.git";
export interface DocumentFixture {
  key: string; title: string; content: string;
  scope?: "platform" | "module" | "repository";
  module_ids?: string[]; repositories?: string[]; product_versions?: string[];
  active?: boolean;
}
export const documents: DocumentFixture[] = [
  { key: "writer", title: "C++ 报表文件组件", content: `# C++ 报表文件组件
## 创建者与错误清理
文件输出统一使用 ReportWriter，禁止 fopen 和 std::ofstream。
创建者调用 open(path)；成功后调用 write(text)。open 和 write 均返回 bool。
open 即使返回 false 也可能分配部分资源，创建者仍必须调用 close() 一次。
成功、打开失败、写入失败都要清理；不得调用 close 两次。
先查询名称，再创建文件，查询失败不得创建或打开文件。
## 借用例外
appendReport 接收的是调用方已打开的 ReportWriter 引用。
借用者只调用 write，直接返回结果；无论写入成功或失败，都不得 open 或 close。
这些规则只适用于本 benchmark 的虚构组件。` },
  { key: "name", title: "导出网元名称查询", scope: "module", module_ids: ["export"], content: "# 导出网元名称\n使用 NeConfig::getName(int neId)，返回 std::optional<std::string>。为空时返回失败，不用空字符串冒充成功。导出内容直接使用名称，不添加换行。" },
  { key: "v26", title: "2.6B 超时配置", product_versions: ["2.6B"], content: "# 请求超时\n2.6B 使用 Config::value(\"request_timeout_ms\")，返回整数毫秒，不需要换算。timeoutMillis 返回该值。" },
  { key: "v27", title: "2.7B 超时配置", product_versions: ["2.7B"], content: "# 请求超时\n2.7B 使用 Config::value(\"request_timeout_seconds\")，返回整数秒。timeoutMillis 必须乘以 1000 转换为毫秒。禁止读取旧版本 request_timeout_ms。" },
  { key: "alarm", title: "告警重复事件", scope: "module", module_ids: ["alarm"], content: "# 告警事件去重\n告警模块对重复上报按 event_id 和 ne_id 联合去重，不使用 order_id。同一个事件在不同网元上不是同一告警。" },
  { key: "order", title: "订单重复事件", scope: "module", module_ids: ["order"], content: "# 订单事件去重\n订单模块按 order_id 和 payment_attempt 联合去重，不使用 ne_id。同一订单不同支付尝试不能合并。" },
  { key: "ut", title: "共享仓首次 C++ 构建", scope: "repository", repositories: [REPO], content: "# 首次构建 UT\n先执行 mvn generate-sources -DDT_test=UT 准备单元测试依赖，再执行 mvn compile -DDT_test=UT 编译并执行测试。" },
  { key: "other-ut", title: "其他仓首次 C++ 构建", scope: "repository", repositories: [OTHER_REPO], content: "# 首次构建 UT\n本仓用 cmake --build build 编译，再运行 ctest 执行单元测试。不使用 Maven。" },
  { key: "yaml", title: "YAML 一致性检查", content: "# YAML Consistence Check\n流水线出现 YAML content is inconsistent 时保留现场，联系责任人决定如何处理，不自行改写 YAML。此规则不适用于 JSON schema 校验。" },
  { key: "json", title: "JSON 配置校验", content: "# JSON schema\nJSON 配置字段名称必须与 schema 一致，校验失败时对照 schema 修正字段。" },
  { key: "symbol", title: "FMA 文件标识", content: "# 文件标识查询\nResolveFmaFileKey 获取 FMA 文件标识，不能拿文件显示名替代文件键。" },
  { key: "callback", title: "异步回调生命周期", content: "# 对象销毁后的回调\n异步回调可能晚于对象销毁执行。访问对象前检查弱引用是否仍有效。已有明确共享所有权保障时不要机械地改成弱引用。" },
  { key: "disabled", title: "废弃的超时配置", active: false, content: "# 请求超时\n2.7B 使用 obsolete_timeout_ticks，单位时钟周期。" },
];
export interface QueryFixture {
  id: string; query: string; expected: string[];
  module?: string; version?: string; repo?: string;
  forbidden?: string[]; evidence?: string;
}
export const queries: QueryFixture[] = [
  {id:"writer-api",query:"C++ 报表导出文件用哪个组件写入",expected:["writer"],module:"export",evidence:"文件输出统一使用 ReportWriter"},
  {id:"writer-open-failure",query:"ReportWriter open 返回 false 是否需要 close",expected:["writer"],module:"export",evidence:"仍必须调用 close"},
  {id:"writer-borrowed",query:"appendReport 借来的文件句柄写失败后谁负责关闭",expected:["writer"],evidence:"不得 open 或 close"},
  {id:"writer-paraphrase",query:"打开报表文件失败但组件可能已经分配部分资源，怎么清理",expected:["writer"]},
  {id:"name-lookup",query:"导出时如何根据网元 ID 查询名称",expected:["name"],module:"export",evidence:"NeConfig::getName"},
  {id:"name-empty",query:"NeConfig::getName 返回空能不能用空字符串继续导出",expected:["name"],module:"export"},
  {id:"timeout-v27",query:"请求超时应该读哪个配置键和单位",expected:["v27"],version:"2.7B",forbidden:["v26","disabled"],evidence:"乘以 1000"},
  {id:"timeout-v26",query:"请求超时应该读哪个配置键和单位",expected:["v26"],version:"2.6B",forbidden:["v27","disabled"],evidence:"不需要换算"},
  {id:"timeout-symbol",query:"request_timeout_seconds timeoutMillis",expected:["v27"],version:"2.7B"},
  {id:"alarm-dedup",query:"重复事件按什么字段去重",expected:["alarm"],module:"alarm",forbidden:["order","name"],evidence:"event_id 和 ne_id"},
  {id:"order-dedup",query:"重复事件按什么字段去重",expected:["order"],forbidden:["alarm","name"],module:"order",evidence:"order_id 和 payment_attempt"},
  {id:"alarm-paraphrase",query:"同一网元反复上报相同事件，应怎样识别重复",expected:["alarm"],module:"alarm"},
  {id:"order-paraphrase",query:"同一订单不同支付尝试是否合并为一个事件",expected:["order"],module:"order"},
  {id:"module-unspecified",query:"重复事件按什么字段去重",expected:[],forbidden:["alarm","order","name"]},
  {id:"repo-ut",query:"C++ 首次编译如何准备单元测试依赖",expected:["ut"],forbidden:["other-ut"],evidence:"generate-sources"},
  {id:"repo-ut-symbol",query:"-DDT_test=UT generate-sources",expected:["ut"]},
  {id:"other-repo-ut",query:"C++ 首次构建如何执行 UT",expected:["other-ut"],repo:OTHER_REPO,forbidden:["ut"],evidence:"ctest"},
  {id:"yaml-error",query:"YAML content is inconsistent",expected:["yaml"],evidence:"不自行改写"},
  {id:"yaml-paraphrase",query:"流水线提示配置内容不一致，我是否应该自己修改 YAML",expected:["yaml"]},
  {id:"json-schema",query:"JSON 配置字段名称与 schema 不一致怎么处理",expected:["json"]},
  {id:"exact-symbol",query:"ResolveFmaFileKey",expected:["symbol"]},
  {id:"symbol-paraphrase",query:"FMA 文件标识能不能用文件显示名代替",expected:["symbol"]},
  {id:"callback",query:"对象析构后异步函数还访问对象，如何避免悬空引用",expected:["callback"]},
  {id:"callback-exception",query:"回调已经持有共享所有权还需要机械改成弱引用吗",expected:["callback"]},
  {id:"missing-topic",query:"PostgreSQL WAL 归档恢复命令",expected:[]},
  {id:"unrelated",query:"办公室盆栽多久浇一次水",expected:[]},
];
